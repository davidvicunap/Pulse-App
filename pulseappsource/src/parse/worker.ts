/**
 * The parsing worker.
 *
 * Runs entirely off the main thread so a 300MB export never blocks a frame. The design
 * constraints that shaped it:
 *
 *  - **Bounded memory.** Bytes are pulled from the file a chunk at a time and never
 *    fully materialised — not as an ArrayBuffer, not as a string. The zip is inflated
 *    incrementally too. Peak memory is roughly (chunk + tail + accumulator), which is
 *    a few MB regardless of file size.
 *  - **Real progress.** Progress is measured in *compressed bytes consumed*, which is
 *    knowable up front (`file.size`), rather than guessed from record counts.
 *  - **Specific errors.** Every failure mode the user can actually hit gets its own
 *    message and its own code, so the UI can suggest the right fix.
 */

import { Unzip, UnzipInflate } from 'fflate';
import { HealthAccumulator } from './accumulator';
import { looksLikeHealthExport, scanChunk } from './scanner';
import type { DayRecord } from '../core/types';

export type ParseRequest = { kind: 'parse'; file: File };

export type ParseResponse =
  | { kind: 'progress'; phase: ParsePhase; percent: number; detail: string }
  | { kind: 'done'; days: DayRecord[]; stats: ParseStats }
  | { kind: 'error'; code: ParseErrorCode; message: string };

export type ParsePhase = 'reading' | 'unzipping' | 'parsing' | 'summarising';

export type ParseErrorCode =
  | 'not-a-zip'
  | 'no-export-xml'
  | 'not-health-data'
  | 'no-records'
  | 'read-failed'
  | 'unknown';

export interface ParseStats {
  recordsSeen: number;
  recordsKept: number;
  workouts: number;
  days: number;
  bytes: number;
  elapsedMs: number;
}

/** How often to report progress. Throttled so postMessage isn't the bottleneck. */
const PROGRESS_INTERVAL_MS = 90;

self.onmessage = (e: MessageEvent<ParseRequest>) => {
  if (e.data?.kind !== 'parse') return;
  run(e.data.file).catch((err) => {
    post({
      kind: 'error',
      code: 'unknown',
      message: err instanceof Error ? err.message : 'The file could not be read.',
    });
  });
};

function post(msg: ParseResponse): void {
  (self as unknown as Worker).postMessage(msg);
}

async function run(file: File): Promise<void> {
  const started = Date.now();
  const accumulator = new HealthAccumulator();
  let lastProgress = 0;
  /**
   * The first few KB of decoded text, kept separately from `tail`.
   *
   * `tail` is consumed as it's scanned, so by the end of a small file there's nothing
   * left to inspect — which made a valid-but-empty export report as "not a Health
   * export" rather than "no usable records". Sampling the head as it streams past keeps
   * the distinction available whatever the file size.
   */
  let headSample = '';
  let tail = '';

  const decoder = new TextDecoder('utf-8');
  const handlers = {
    onRecord: (r: Parameters<HealthAccumulator['addRecord']>[0]) => accumulator.addRecord(r),
    onWorkout: (w: Parameters<HealthAccumulator['addWorkout']>[0]) => accumulator.addWorkout(w),
    onWorkoutStatistic: (t: string, sum: number, unit: string | undefined) =>
      accumulator.applyWorkoutStatistic(t, sum, unit),
  };

  /** Feeds decoded text through the scanner, carrying the incomplete tail forward. */
  const feed = (text: string, isFinal = false): void => {
    if (headSample.length < 4096) headSample += text.slice(0, 4096 - headSample.length);
    tail += text;
    const consumed = scanChunk(tail, handlers, isFinal);
    tail = consumed > 0 ? tail.slice(consumed) : tail;
    // Defensive: if a pathological file has no `<` for megabytes, don't grow forever.
    if (tail.length > 8 * 1024 * 1024) tail = tail.slice(-1024);
  };

  const reportProgress = (phase: ParsePhase, percent: number, detail: string): void => {
    const now = Date.now();
    if (now - lastProgress < PROGRESS_INTERVAL_MS && percent < 100) return;
    lastProgress = now;
    post({ kind: 'progress', phase, percent: Math.min(99.9, percent), detail });
  };

  const isZip = await sniffZip(file);
  const total = file.size || 1;
  let bytesRead = 0;

  if (isZip) {
    post({ kind: 'progress', phase: 'unzipping', percent: 0, detail: 'Opening export…' });

    let foundExportXml = false;
    let zipError: string | null = null;

    const unzip = new Unzip();
    unzip.register(UnzipInflate);
    unzip.onfile = (entry) => {
      const name = entry.name;
      // Real exports contain `apple_health_export/export.xml` plus a large
      // `export_cda.xml` clinical-records file we must not parse.
      if (!/(^|\/)export\.xml$/i.test(name) || /cda/i.test(name)) return;
      foundExportXml = true;
      entry.ondata = (err, chunk, final) => {
        if (err) {
          zipError = err.message;
          return;
        }
        if (chunk && chunk.length) feed(decoder.decode(chunk, { stream: !final }));
        if (final) feed('', true);
      };
      entry.start();
    };

    try {
      for await (const chunk of streamChunks(file)) {
        unzip.push(chunk, false);
        bytesRead += chunk.length;
        reportProgress(
          'parsing',
          (bytesRead / total) * 100,
          `${accumulator.dayCount} days · ${formatCount(accumulator.recordsKept)} records`,
        );
        if (zipError) break;
        // Yield to the worker's event loop so `postMessage` actually flushes.
        await microYield();
      }
      unzip.push(new Uint8Array(0), true);
    } catch {
      post({
        kind: 'error',
        code: 'not-a-zip',
        message: 'It may have been re-compressed or truncated. Re-export from Health and try again — Pulse needs the original file.',
      });
      return;
    }

    if (zipError) {
      post({
        kind: 'error',
        code: 'not-a-zip',
        message: 'It stopped decompressing partway through, which means the file is damaged. Re-export from Health and try again.',
      });
      return;
    }
    if (!foundExportXml) {
      post({
        kind: 'error',
        code: 'no-export-xml',
        message: 'Health exports always contain one. If you zipped a folder yourself, drop the export.xml in directly instead.',
      });
      return;
    }
  } else {
    post({ kind: 'progress', phase: 'parsing', percent: 0, detail: 'Reading records…' });
    for await (const chunk of streamChunks(file)) {
      feed(decoder.decode(chunk, { stream: true }));
      bytesRead += chunk.length;
      reportProgress(
        'parsing',
        (bytesRead / total) * 100,
        `${accumulator.dayCount} days · ${formatCount(accumulator.recordsKept)} records`,
      );
      await microYield();
    }
    feed('', true);
  }

  const sawHealthMarkup = looksLikeHealthExport(headSample);

  if (!accumulator.recordsKept && !sawHealthMarkup) {
    post({
      kind: 'error',
      code: 'not-health-data',
      message:
        'No Health records were found in it. Pulse needs the export.zip that Health’s ' +
        '“Export All Health Data” produces.',
    });
    return;
  }

  post({ kind: 'progress', phase: 'summarising', percent: 99.9, detail: 'Building your timeline…' });
  const days = accumulator.finalize();

  if (!days.length) {
    post({
      kind: 'error',
      code: 'no-records',
      message: 'It parsed cleanly, but holds no heart-rate, HRV, sleep or activity records for Pulse to work with.',
    });
    return;
  }

  post({
    kind: 'done',
    days,
    stats: {
      recordsSeen: accumulator.recordsSeen,
      recordsKept: accumulator.recordsKept,
      workouts: accumulator.workoutsKept,
      days: days.length,
      bytes: file.size,
      elapsedMs: Date.now() - started,
    },
  });
}

/** 4MB reads: large enough to amortise overhead, small enough to stay responsive. */
const CHUNK_SIZE = 4 * 1024 * 1024;

/**
 * Yields the file in chunks.
 *
 * Prefers the streaming Blob API and falls back to slicing, because Safari only gained
 * `Blob.stream()` in a fairly recent version and this app is aimed squarely at iPhone.
 */
async function* streamChunks(file: File): AsyncGenerator<Uint8Array> {
  if (typeof file.stream === 'function') {
    const reader = file.stream().getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value as Uint8Array;
      }
      return;
    } catch {
      // Fall through to slicing.
    }
  }
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
    yield new Uint8Array(await slice.arrayBuffer());
  }
}

/** Reads the first bytes to detect a zip, rather than trusting the file extension. */
async function sniffZip(file: File): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    // "PK\x03\x04" — the local file header signature.
    return head[0] === 0x50 && head[1] === 0x4b;
  } catch {
    return /\.zip$/i.test(file.name);
  }
}

function microYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return String(n);
}
