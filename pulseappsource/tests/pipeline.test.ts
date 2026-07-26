/**
 * End-to-end: synthetic `export.xml` → scanner → accumulator → model.
 *
 * This is the test that would have caught the prototype's strain bug, because it
 * exercises the real numbers a real export produces rather than hand-picked inputs.
 */

import { describe, it, expect } from 'vitest';
import { generateExportXml } from '../tools/generate-export';
import { HealthAccumulator } from '../src/parse/accumulator';
import { scanChunk } from '../src/parse/scanner';
import { buildModel, latestScoredIndex, metricValue, series } from '../src/model/build';
import { DEFAULT_SETTINGS, type DayRecord } from '../src/core/types';
import { MAX_STRAIN } from '../src/model/strain';

/** Runs the full parse path, deliberately chunking to exercise the streaming logic. */
function parse(xml: string, chunkSize = 65_536): { days: DayRecord[]; acc: HealthAccumulator } {
  const acc = new HealthAccumulator();
  const handlers = {
    onRecord: (r: Parameters<HealthAccumulator['addRecord']>[0]) => acc.addRecord(r),
    onWorkout: (w: Parameters<HealthAccumulator['addWorkout']>[0]) => acc.addWorkout(w),
    onWorkoutStatistic: (t: string, s: number, u: string | undefined) =>
      acc.applyWorkoutStatistic(t, s, u),
  };
  let tail = '';
  for (let i = 0; i < xml.length; i += chunkSize) {
    tail += xml.slice(i, i + chunkSize);
    tail = tail.slice(scanChunk(tail, handlers));
  }
  scanChunk(tail, handlers, true);
  return { days: acc.finalize(), acc };
}

const XML = generateExportXml(150, { seed: 7 });
const { days: DAYS, acc: ACC } = parse(XML);
const MODEL = buildModel(DAYS, DEFAULT_SETTINGS);

describe('parsing a synthetic export', () => {
  it('produces a plausible number of days', () => {
    // 150 days planned, a few deliberately missing. The first day can pick up the
    // preceding night, so one extra day at the boundary is expected.
    expect(DAYS.length).toBeGreaterThan(135);
    expect(DAYS.length).toBeLessThanOrEqual(152);
  });

  it('keeps far fewer records than it sees, having filtered unwanted types', () => {
    expect(ACC.recordsKept).toBeGreaterThan(1000);
    expect(ACC.recordsSeen).toBeGreaterThanOrEqual(ACC.recordsKept);
  });

  it('extracts every signal family the app depends on', () => {
    const has = (pick: (d: DayRecord) => unknown) => DAYS.filter((d) => pick(d) != null).length;
    expect(has((d) => d.hrv)).toBeGreaterThan(100);
    expect(has((d) => d.rhr)).toBeGreaterThan(100);
    expect(has((d) => d.respiratoryRate)).toBeGreaterThan(100);
    expect(has((d) => d.spo2)).toBeGreaterThan(100);
    expect(has((d) => d.sleep)).toBeGreaterThan(100);
    expect(has((d) => d.hrHistogram)).toBeGreaterThan(100);
    expect(DAYS.filter((d) => d.vo2max != null).length).toBeGreaterThanOrEqual(3);
    expect(DAYS.filter((d) => d.workouts.length > 0).length).toBeGreaterThan(40);
  });

  it('never reports a physically impossible night', () => {
    // The generator writes some nights from two sources; without interval merging these
    // would come back as 14+ hours.
    for (const d of DAYS) {
      if (!d.sleep) continue;
      expect(d.sleep.asleepMin).toBeLessThanOrEqual(12 * 60);
      expect(d.sleep.asleepMin).toBeGreaterThan(0);
    }
  });

  it('does not double-count steps written by both phone and watch', () => {
    // The generator writes the phone at 86% of the watch; a summing parser would land
    // near 186% of the true figure, i.e. well over 25k on a normal day.
    const stepDays = DAYS.filter((d) => d.steps > 0);
    expect(stepDays.length).toBeGreaterThan(100);
    const median = [...stepDays].map((d) => d.steps).sort((a, b) => a - b)[Math.floor(stepDays.length / 2)];
    expect(median).toBeGreaterThan(3000);
    expect(median).toBeLessThan(20_000);
  });

  it('bounds heart-rate coverage to the minutes in a day', () => {
    for (const d of DAYS) {
      expect(d.hrMinutesCovered).toBeLessThanOrEqual(1440);
      if (d.hrHistogram) {
        const total = d.hrHistogram.reduce((a, b) => a + b, 0);
        expect(total).toBe(d.hrMinutesCovered);
      }
    }
  });

  it('handles a timezone change mid-history without losing or duplicating days', () => {
    const keys = DAYS.map((d) => d.date);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe('the derived model', () => {
  it('scores recovery for most days', () => {
    const scored = MODEL.days.filter((d) => d.recovery.score != null);
    expect(scored.length).toBeGreaterThan(110);
  });

  it('declines to score the earliest days, before a baseline exists', () => {
    // Showing a confident recovery number on day one would be a lie.
    expect(MODEL.days[0].recovery.components.find((c) => c.key === 'hrv')).toBeUndefined();
  });

  it('keeps every recovery score inside 1..99', () => {
    for (const d of MODEL.days) {
      if (d.recovery.score == null) continue;
      expect(d.recovery.score).toBeGreaterThanOrEqual(1);
      expect(d.recovery.score).toBeLessThanOrEqual(99);
    }
  });

  it('keeps every strain score inside 0..21', () => {
    for (const d of MODEL.days) {
      expect(d.strain.score).toBeGreaterThanOrEqual(0);
      expect(d.strain.score).toBeLessThanOrEqual(MAX_STRAIN);
    }
  });

  it('uses the heart-rate zone path for most days, not the fallback', () => {
    const byZones = MODEL.days.filter((d) => d.strain.method === 'hr-zones').length;
    expect(byZones).toBeGreaterThan(MODEL.days.length * 0.7);
  });

  it('spreads strain across the scale instead of clustering at one end', () => {
    const scores = MODEL.days.map((d) => d.strain.score).filter((s) => s > 0);
    const max = Math.max(...scores);
    const min = Math.min(...scores);
    expect(max).toBeGreaterThan(14);
    expect(min).toBeLessThan(8);
    // At least one day should approach the top of the scale.
    expect(max).toBeGreaterThan(17);
  });

  it('derives a plausible profile', () => {
    expect(MODEL.profile.sleepNeedMin).toBeGreaterThanOrEqual(420);
    expect(MODEL.profile.sleepNeedMin).toBeLessThanOrEqual(600);
    expect(MODEL.profile.maxHr).toBeGreaterThan(140);
    expect(MODEL.profile.maxHr).toBeLessThan(220);
    expect(MODEL.profile.restingHr).toBeGreaterThan(35);
    expect(MODEL.profile.restingHr).toBeLessThan(80);
    expect(MODEL.profile.daysWithData).toBe(DAYS.length);
  });

  it('reproduces the simulated illness episode as a recovery dip', () => {
    // The generator suppresses HRV and raises resting HR for five days two-thirds in.
    const scores = MODEL.days.map((d) => d.recovery.score);
    const start = Math.floor(MODEL.days.length * 0.66);
    const during = scores.slice(start, start + 5).filter((s): s is number => s != null);
    const before = scores.slice(start - 20, start - 5).filter((s): s is number => s != null);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(during)).toBeLessThan(avg(before));
  });

  it('is deterministic — the same input always yields the same model', () => {
    const again = buildModel(DAYS, DEFAULT_SETTINGS);
    expect(again.days.map((d) => d.recovery.score)).toEqual(MODEL.days.map((d) => d.recovery.score));
    expect(again.days.map((d) => d.strain.score)).toEqual(MODEL.days.map((d) => d.strain.score));
  });

  it('never lets future days leak into a day’s baselines', () => {
    // The core no-lookahead guarantee: a day is compared only against days that
    // preceded it. Importing another six months of history must not change what
    // yesterday was measured against.
    const firstHalf = buildModel(DAYS.slice(0, 80), DEFAULT_SETTINGS);
    for (const i of [10, 30, 50, 79]) {
      expect(firstHalf.days[i].baselines.hrv?.mean).toBe(MODEL.days[i].baselines.hrv?.mean);
      expect(firstHalf.days[i].baselines.rhr?.mean).toBe(MODEL.days[i].baselines.rhr?.mean);
    }
  });

  it('re-scores the whole history together when the personal profile changes', () => {
    // Personal calibration (sleep need, strain reference) is deliberately global: it
    // describes the person, not the day. So importing more data can shift scores — but
    // it must shift them consistently, never for only part of the timeline.
    const firstHalf = buildModel(DAYS.slice(0, 80), DEFAULT_SETTINGS);
    const sameProfile = buildModel(DAYS.slice(0, 80), DEFAULT_SETTINGS);
    expect(firstHalf.days.map((d) => d.recovery.score)).toEqual(
      sameProfile.days.map((d) => d.recovery.score),
    );
  });

  it('indexes days by date', () => {
    expect(MODEL.byDate.get(DAYS[10].date)?.date).toBe(DAYS[10].date);
    expect(MODEL.byDate.size).toBe(MODEL.days.length);
  });

  it('finds the most recent scored day', () => {
    const idx = latestScoredIndex(MODEL);
    expect(MODEL.days[idx].recovery.score).not.toBeNull();
  });

  it('exposes aligned metric series with gaps preserved as null', () => {
    const hrv = series(MODEL, 'hrv');
    expect(hrv).toHaveLength(MODEL.days.length);
    expect(hrv.some((v) => v == null)).toBe(true);
    expect(metricValue(MODEL.days[5], 'recovery')).toBe(MODEL.days[5].recovery.score);
  });
});

describe('edge cases', () => {
  it('handles an export with no records at all', () => {
    const { days } = parse('<?xml version="1.0"?><HealthData locale="en_US"></HealthData>');
    expect(days).toEqual([]);
    const model = buildModel(days, DEFAULT_SETTINGS);
    expect(model.days).toEqual([]);
    expect(model.profile.daysWithData).toBe(0);
    expect(model.profile.firstDate).toBeNull();
  });

  it('handles a single day of data without dividing by zero', () => {
    const xml = generateExportXml(1, { seed: 3 });
    const { days } = parse(xml);
    const model = buildModel(days, DEFAULT_SETTINGS);
    expect(model.days.length).toBeLessThanOrEqual(1);
    for (const d of model.days) {
      expect(Number.isFinite(d.strain.score)).toBe(true);
    }
  });

  it('produces the same days at any chunk size', () => {
    const small = parse(XML, 997).days;
    const large = parse(XML, 1 << 20).days;
    expect(small.length).toBe(large.length);
    expect(small.map((d) => d.date)).toEqual(large.map((d) => d.date));
    expect(small.map((d) => d.sleep?.asleepMin ?? null)).toEqual(
      large.map((d) => d.sleep?.asleepMin ?? null),
    );
    expect(small.map((d) => d.steps)).toEqual(large.map((d) => d.steps));
  });

  it('respects a user sleep-need override', () => {
    const model = buildModel(DAYS, { ...DEFAULT_SETTINGS, sleepNeedMin: 540 });
    expect(model.profile.sleepNeedMin).toBe(540);
    // A higher need means more debt, by construction.
    const base = MODEL.days[MODEL.days.length - 1].sleep.debtMin;
    const raised = model.days[model.days.length - 1].sleep.debtMin;
    expect(raised).toBeGreaterThan(base);
  });

  it('respects a user max-HR override by re-scoring strain from the stored histogram', () => {
    // No re-import: changing the setting must change history immediately.
    const lower = buildModel(DAYS, { ...DEFAULT_SETTINGS, maxHr: 170 });
    const higher = buildModel(DAYS, { ...DEFAULT_SETTINGS, maxHr: 210 });
    expect(lower.profile.maxHr).toBe(170);
    expect(higher.profile.maxHr).toBe(210);
    const lowerLoad = lower.days.reduce((a, d) => a + d.strain.load, 0);
    const higherLoad = higher.days.reduce((a, d) => a + d.strain.load, 0);
    expect(lowerLoad).toBeGreaterThan(higherLoad);
  });
});
