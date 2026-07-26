/**
 * Streaming XML scanner.
 *
 * Apple Health exports are far too large to hand to `DOMParser` — a 300MB document
 * would need multiple gigabytes as a DOM. But we also don't need a real XML parser:
 * the format is a flat list of self-closing elements with quoted attributes, so a
 * targeted scanner is both correct for this input and roughly an order of magnitude
 * faster.
 *
 * The scanner is pure and chunk-boundary-aware: `scanChunk` returns how much of the
 * buffer it consumed, and the caller keeps the remainder to prepend to the next chunk.
 * That is the part most likely to break subtly, so it's tested directly.
 */

import type { RawRecord, RawWorkout } from './accumulator';
import { WANTED_TYPES } from './accumulator';

export interface ScanHandlers {
  onRecord(rec: RawRecord): void;
  onWorkout(w: RawWorkout): void;
  /** A `<WorkoutStatistics>` child — applies to the most recent workout. */
  onWorkoutStatistic(type: string, sum: number, unit: string | undefined): void;
}

/**
 * Reads an attribute out of a raw tag body.
 *
 * Hand-rolled rather than regex because this runs once per attribute per record — tens
 * of millions of times on a large export. It checks that the match is at a word
 * boundary so that looking up `type` doesn't accidentally match
 * `workoutActivityType="…"`.
 */
export function readAttr(tag: string, name: string): string | undefined {
  const needle = name + '="';
  let from = 0;
  for (;;) {
    const i = tag.indexOf(needle, from);
    if (i === -1) return undefined;
    // Must be preceded by whitespace (or be at the very start) to count as this attribute.
    const prev = i === 0 ? ' ' : tag.charCodeAt(i - 1);
    if (i === 0 || prev === 32 || prev === 9 || prev === 10 || prev === 13) {
      const start = i + needle.length;
      const end = tag.indexOf('"', start);
      if (end === -1) return undefined;
      const raw = tag.slice(start, end);
      return raw.indexOf('&') === -1 ? raw : decodeEntities(raw);
    }
    from = i + needle.length;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

const TAG_RE = /<(Record|Workout|WorkoutStatistics)\s/g;

/**
 * Scans as much of `buffer` as is safely complete, dispatching to `handlers`.
 *
 * Returns the number of characters consumed. Everything from that index onward must be
 * carried into the next chunk.
 *
 * The safety rule: a `<` always begins a tag and can never appear inside one, so
 * everything before the **last** `<` in the buffer consists only of complete tags.
 * Cutting there means we never parse a half-written record, without needing to
 * understand where any particular tag ends.
 */
export function scanChunk(buffer: string, handlers: ScanHandlers, isFinal = false): number {
  const cut = isFinal ? buffer.length : buffer.lastIndexOf('<');
  if (cut <= 0) return 0;
  const region = buffer.slice(0, cut);

  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(region)) !== null) {
    const tagEnd = region.indexOf('>', m.index);
    if (tagEnd === -1) break; // incomplete — will be retried with the next chunk
    const body = region.slice(m.index + m[0].length, tagEnd);

    switch (m[1]) {
      case 'Record': {
        // Check the type first and bail early: most records in a real export are types
        // we don't want, and skipping them before reading five more attributes is the
        // single biggest parsing speed-up available.
        const type = readAttr(body, 'type');
        if (!type || !WANTED_TYPES[type]) break;
        const startDate = readAttr(body, 'startDate');
        if (!startDate) break;
        handlers.onRecord({
          type,
          startDate,
          endDate: readAttr(body, 'endDate'),
          value: readAttr(body, 'value'),
          sourceName: readAttr(body, 'sourceName'),
          unit: readAttr(body, 'unit'),
        });
        break;
      }
      case 'Workout': {
        const activityType = readAttr(body, 'workoutActivityType') ?? 'Workout';
        const startDate = readAttr(body, 'startDate');
        if (!startDate) break;
        handlers.onWorkout({
          activityType,
          startDate,
          endDate: readAttr(body, 'endDate'),
          duration: readAttr(body, 'duration'),
          durationUnit: readAttr(body, 'durationUnit'),
          totalDistance: readAttr(body, 'totalDistance'),
          totalDistanceUnit: readAttr(body, 'totalDistanceUnit'),
          totalEnergyBurned: readAttr(body, 'totalEnergyBurned'),
          sourceName: readAttr(body, 'sourceName'),
        });
        break;
      }
      case 'WorkoutStatistics': {
        // Newer exports moved workout totals into these children, so a workout may have
        // no `totalDistance` attribute at all.
        const type = readAttr(body, 'type');
        const sum = Number(readAttr(body, 'sum'));
        if (type && Number.isFinite(sum)) {
          handlers.onWorkoutStatistic(type, sum, readAttr(body, 'unit'));
        }
        break;
      }
    }

    TAG_RE.lastIndex = tagEnd;
  }

  return cut;
}

/**
 * A quick structural check so we can fail with a specific message rather than silently
 * producing zero days.
 */
export function looksLikeHealthExport(head: string): boolean {
  return /<HealthData/i.test(head) || /<Record\s/i.test(head);
}
