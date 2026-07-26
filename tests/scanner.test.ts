import { describe, it, expect } from 'vitest';
import { looksLikeHealthExport, readAttr, scanChunk, type ScanHandlers } from '../src/parse/scanner';
import type { RawRecord, RawWorkout } from '../src/parse/accumulator';

function collector() {
  const records: RawRecord[] = [];
  const workouts: RawWorkout[] = [];
  const stats: Array<[string, number, string | undefined]> = [];
  const handlers: ScanHandlers = {
    onRecord: (r) => records.push(r),
    onWorkout: (w) => workouts.push(w),
    onWorkoutStatistic: (t, s, u) => stats.push([t, s, u]),
  };
  return { records, workouts, stats, handlers };
}

const REC = (type: string, extra = '') =>
  `<Record type="${type}" sourceName="Watch" startDate="2024-03-11 07:00:00 -0800" endDate="2024-03-11 07:01:00 -0800" value="55"${extra}/>`;

describe('readAttr', () => {
  it('reads a plain attribute', () => {
    expect(readAttr('type="X" value="7"', 'value')).toBe('7');
  });

  it('does not confuse a suffix match for the attribute', () => {
    // `workoutActivityType="…"` ends with `Type="` — a naive indexOf would match it
    // when asked for `type`.
    const tag = 'workoutActivityType="HKWorkoutActivityTypeRunning" type="Real"';
    expect(readAttr(tag, 'type')).toBe('Real');
  });

  it('returns undefined for a missing attribute', () => {
    expect(readAttr('type="X"', 'unit')).toBeUndefined();
  });

  it('decodes XML entities', () => {
    expect(readAttr('sourceName="David&apos;s &amp; Co &lt;3&quot;"', 'sourceName')).toBe(
      'David\'s & Co <3"',
    );
  });

  it('decodes numeric character references', () => {
    expect(readAttr('sourceName="David&#8217;s Watch"', 'sourceName')).toBe('David’s Watch');
  });

  it('handles an attribute at the very start of the tag body', () => {
    expect(readAttr('type="First" value="1"', 'type')).toBe('First');
  });

  it('survives an unterminated attribute value', () => {
    expect(readAttr('type="unterminated', 'type')).toBeUndefined();
  });
});

describe('scanChunk', () => {
  it('extracts wanted records and ignores the rest', () => {
    const { records, handlers } = collector();
    const xml =
      REC('HKQuantityTypeIdentifierRestingHeartRate') +
      REC('HKQuantityTypeIdentifierDietaryWater') +
      REC('HKQuantityTypeIdentifierHeartRateVariabilitySDNN') +
      '<';
    scanChunk(xml, handlers);
    expect(records.map((r) => r.type)).toEqual([
      'HKQuantityTypeIdentifierRestingHeartRate',
      'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
    ]);
  });

  it('reads every attribute a record carries', () => {
    const { records, handlers } = collector();
    scanChunk(REC('HKQuantityTypeIdentifierRestingHeartRate', ' unit="count/min"') + '<', handlers);
    expect(records[0]).toEqual({
      type: 'HKQuantityTypeIdentifierRestingHeartRate',
      startDate: '2024-03-11 07:00:00 -0800',
      endDate: '2024-03-11 07:01:00 -0800',
      value: '55',
      sourceName: 'Watch',
      unit: 'count/min',
    });
  });

  it('stops before an incomplete trailing tag and reports what it consumed', () => {
    const { records, handlers } = collector();
    const complete = REC('HKQuantityTypeIdentifierRestingHeartRate');
    const partial = '<Record type="HKQuantityTypeIdentifierHeartRate" startD';
    const consumed = scanChunk(complete + partial, handlers);
    expect(records).toHaveLength(1);
    expect(consumed).toBe(complete.length);
  });

  /**
   * The property that actually matters for a streaming parser: splitting the same
   * document at any byte boundary must produce identical output.
   */
  it('produces identical results however the stream is chunked', () => {
    const xml =
      '<HealthData>' +
      REC('HKQuantityTypeIdentifierRestingHeartRate') +
      REC('HKQuantityTypeIdentifierHeartRateVariabilitySDNN') +
      '<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="45" durationUnit="min" startDate="2024-03-11 07:00:00 -0800" endDate="2024-03-11 07:45:00 -0800">' +
      '<WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="400" unit="Cal"/>' +
      '</Workout>' +
      REC('HKCategoryTypeIdentifierSleepAnalysis') +
      '</HealthData>';

    const whole = collector();
    scanChunk(xml, whole.handlers, true);

    for (const size of [1, 2, 3, 7, 13, 32, 64, 127]) {
      const streamed = collector();
      let tail = '';
      for (let i = 0; i < xml.length; i += size) {
        tail += xml.slice(i, i + size);
        const consumed = scanChunk(tail, streamed.handlers);
        tail = tail.slice(consumed);
      }
      scanChunk(tail, streamed.handlers, true);

      expect(streamed.records, `chunk size ${size}`).toEqual(whole.records);
      expect(streamed.workouts, `chunk size ${size}`).toEqual(whole.workouts);
      expect(streamed.stats, `chunk size ${size}`).toEqual(whole.stats);
    }
  });

  it('never emits a record twice across chunk boundaries', () => {
    const xml = REC('HKQuantityTypeIdentifierRestingHeartRate').repeat(50);
    const { records, handlers } = collector();
    let tail = '';
    for (let i = 0; i < xml.length; i += 11) {
      tail += xml.slice(i, i + 11);
      tail = tail.slice(scanChunk(tail, handlers));
    }
    scanChunk(tail, handlers, true);
    expect(records).toHaveLength(50);
  });

  it('parses workouts and their statistics children', () => {
    const { workouts, stats, handlers } = collector();
    const xml =
      '<Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="90" durationUnit="min"' +
      ' totalDistance="42.5" totalDistanceUnit="km" sourceName="Watch"' +
      ' startDate="2024-03-11 07:00:00 -0800" endDate="2024-03-11 08:30:00 -0800">' +
      '<WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="820" unit="Cal"/>' +
      '</Workout>';
    scanChunk(xml, handlers, true);
    expect(workouts[0]).toMatchObject({
      activityType: 'HKWorkoutActivityTypeCycling',
      duration: '90',
      totalDistance: '42.5',
    });
    expect(stats[0]).toEqual(['HKQuantityTypeIdentifierActiveEnergyBurned', 820, 'Cal']);
  });

  it('skips a record with no startDate rather than emitting a broken one', () => {
    const { records, handlers } = collector();
    scanChunk('<Record type="HKQuantityTypeIdentifierRestingHeartRate" value="55"/><', handlers);
    expect(records).toHaveLength(0);
  });

  it('consumes nothing from a buffer with no complete tag', () => {
    const { handlers } = collector();
    expect(scanChunk('<Record type="HKQ', handlers)).toBe(0);
  });

  it('handles an empty buffer', () => {
    const { handlers } = collector();
    expect(scanChunk('', handlers)).toBe(0);
    expect(scanChunk('', handlers, true)).toBe(0);
  });
});

describe('looksLikeHealthExport', () => {
  it('recognises a real export header', () => {
    expect(looksLikeHealthExport('<?xml version="1.0"?><!DOCTYPE HealthData><HealthData locale="en_US">')).toBe(true);
  });

  it('recognises a headerless fragment containing records', () => {
    expect(looksLikeHealthExport(REC('HKQuantityTypeIdentifierRestingHeartRate'))).toBe(true);
  });

  it('rejects unrelated files', () => {
    expect(looksLikeHealthExport('{"some":"json"}')).toBe(false);
    expect(looksLikeHealthExport('<html><body>hello</body></html>')).toBe(false);
  });
});
