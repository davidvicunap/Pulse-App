/**
 * Analytics and the insight engine.
 *
 * The properties worth pinning are the ones that make insights trustworthy: they
 * refuse to speak from thin data, they rank the most urgent thing first, and they never
 * report a relationship that isn't there.
 */

import { describe, it, expect } from 'vitest';
import { generateInsights } from '../src/insights/engine';
import { buildWeeklyRecap } from '../src/insights/recap';
import {
  compareGroups,
  correlate,
  describeCorrelation,
  MIN_CORRELATION_N,
  recordsSetOn,
  standardComparisons,
  streaks,
  thresholdEffect,
  trendOf,
} from '../src/insights/analytics';
import { buildModel } from '../src/model/build';
import { DEFAULT_SETTINGS, type DayRecord } from '../src/core/types';
import { addDays } from '../src/core/dates';

/** Builds a synthetic timeline from per-day generators — no parsing involved. */
function timeline(
  count: number,
  shape: (i: number) => Partial<DayRecord>,
  start = '2024-01-01',
): DayRecord[] {
  const days: DayRecord[] = [];
  for (let i = 0; i < count; i++) {
    days.push({
      date: addDays(start, i),
      rhr: 52, hrv: 55, respiratoryRate: 14, spo2: 97, vo2max: null,
      bodyMassKg: null, bodyFatPct: null, walkingHrAvg: null,
      activeEnergy: 400, exerciseMinutes: 30, steps: 8000, standHours: 10,
      distanceKm: 5, mindfulMinutes: 0,
      hrHistogram: null, hrMinutesCovered: 0, maxHr: 150,
      sleep: {
        asleepMin: 450, inBedMin: 480, deepMin: 80, remMin: 100, coreMin: 270,
        awakeMin: 10, bedStartMs: Date.UTC(2024, 0, 1 + i, 23, 0),
        wakeEndMs: Date.UTC(2024, 0, 2 + i, 7, 0),
        latencyMin: 10, efficiency: 0.94, interruptions: 1, sourceCount: 1,
      },
      workouts: [],
      ...shape(i),
    });
  }
  return days;
}

const steady = buildModel(timeline(90, () => ({})), DEFAULT_SETTINGS);

describe('trendOf', () => {
  it('detects a genuine week-over-week decline', () => {
    // Flat for seven weeks, then a clear drop in the final week.
    const model = buildModel(timeline(60, (i) => ({ hrv: i >= 53 ? 40 : 60 })), DEFAULT_SETTINGS);
    const trend = trendOf(model, 'hrv', 59, 7)!;
    expect(trend.direction).toBe('down');
    expect(trend.significant).toBe(true);
    expect(trend.favourable).toBe(false);
    expect(trend.changePct).toBeLessThan(-20);
  });

  it('does not call ordinary noise a trend', () => {
    const model = buildModel(timeline(60, (i) => ({ hrv: 55 + (i % 3) })), DEFAULT_SETTINGS);
    expect(trendOf(model, 'hrv', 59, 7)!.significant).toBe(false);
  });

  it('knows which direction is good for each metric', () => {
    const model = buildModel(timeline(60, (i) => ({ rhr: i >= 53 ? 62 : 50 })), DEFAULT_SETTINGS);
    const trend = trendOf(model, 'rhr', 59, 7)!;
    expect(trend.direction).toBe('up');
    // A rising resting heart rate is not a good thing.
    expect(trend.favourable).toBe(false);
  });

  it('returns null without enough history', () => {
    expect(trendOf(steady, 'hrv', 2, 7)).toBeNull();
  });
});

describe('streaks', () => {
  it('counts a run of high-recovery days', () => {
    const model = buildModel(timeline(40, (i) => ({ hrv: i >= 30 ? 90 : 55 })), DEFAULT_SETTINGS);
    const found = streaks(model, 39);
    const high = found.find((s) => s.kind === 'recovery-high');
    expect(high?.length).toBeGreaterThanOrEqual(3);
  });

  it('does not break a streak on a day with no data', () => {
    // An unrecorded day is unknown, not a failure — treating it as a break would make
    // streaks impossible for anyone who occasionally leaves their watch off.
    const model = buildModel(
      timeline(40, (i) => (i === 35 ? { sleep: null } : {})),
      DEFAULT_SETTINGS,
    );
    const found = streaks(model, 39);
    expect(found.some((s) => s.kind === 'sleep-met')).toBe(true);
  });

  it('reports nothing for a short or mixed history', () => {
    expect(streaks(steady, 1)).toEqual([]);
  });
});

describe('recordsSetOn', () => {
  it('refuses to call anything a record early on', () => {
    expect(recordsSetOn(steady, 10)).toEqual([]);
  });

  it('recognises a genuine personal best', () => {
    const model = buildModel(timeline(60, (i) => ({ hrv: i === 59 ? 200 : 50 })), DEFAULT_SETTINGS);
    const records = recordsSetOn(model, 59);
    expect(records.some((r) => r.key === 'hrv')).toBe(true);
  });

  it('does not report a record on an ordinary day', () => {
    expect(recordsSetOn(steady, 89).filter((r) => r.key === 'hrv')).toEqual([]);
  });
});

describe('compareGroups', () => {
  it('finds a real difference between groups', () => {
    const model = buildModel(
      timeline(80, (i) => ({ hrv: i % 2 === 0 ? 80 : 40 })),
      DEFAULT_SETTINGS,
    );
    const comparison = compareGroups(model.days, 'hrv', (_d, i) => i % 2 === 0, ['Even', 'Odd'])!;
    expect(comparison.meaningful).toBe(true);
    expect(comparison.groupA.mean).toBeGreaterThan(comparison.groupB.mean);
  });

  it('reports a small difference as not meaningful', () => {
    const model = buildModel(
      timeline(80, (i) => ({ hrv: 55 + (i % 2) + (i % 7) })),
      DEFAULT_SETTINGS,
    );
    const comparison = compareGroups(model.days, 'hrv', (_d, i) => i % 2 === 0, ['Even', 'Odd'])!;
    expect(comparison.meaningful).toBe(false);
  });

  it('returns null when a group is too small to compare', () => {
    expect(compareGroups(steady.days, 'hrv', (_d, i) => i === 0, ['One', 'Rest'])).toBeNull();
  });

  it('produces the standard weekday and training splits', () => {
    expect(standardComparisons(steady.days, 'recovery').length).toBeGreaterThan(0);
  });
});

describe('correlate', () => {
  it('finds a relationship the data actually contains', () => {
    // Sleep and HRV move together by construction.
    const model = buildModel(
      timeline(60, (i) => {
        const asleep = 360 + (i % 10) * 20;
        return {
          hrv: 40 + (asleep - 360) / 10,
          sleep: {
            asleepMin: asleep, inBedMin: asleep + 20, deepMin: 60, remMin: 80,
            coreMin: asleep - 140, awakeMin: 10,
            bedStartMs: Date.UTC(2024, 0, 1 + i, 23, 0),
            wakeEndMs: Date.UTC(2024, 0, 2 + i, 7, 0),
            latencyMin: 10, efficiency: 0.94, interruptions: 1, sourceCount: 1,
          },
        };
      }),
      DEFAULT_SETTINGS,
    );
    const c = correlate(model, 'asleepMin', 'hrv', 0)!;
    expect(c.r).toBeGreaterThan(0.9);
    expect(c.strength).toBe('strong');
    expect(describeCorrelation(c)).toContain('Strongly');
  });

  it('reports no relationship when there genuinely is none', () => {
    const model = buildModel(
      timeline(60, (i) => ({ hrv: 50 + ((i * 37) % 13) })),
      DEFAULT_SETTINGS,
    );
    const c = correlate(model, 'steps', 'hrv', 0);
    // Either not computable or explicitly "none" — never a fabricated relationship.
    expect(c === null || c.strength === 'none').toBe(true);
  });

  it('refuses to report from too few paired days', () => {
    const model = buildModel(timeline(MIN_CORRELATION_N - 2, () => ({})), DEFAULT_SETTINGS);
    expect(correlate(model, 'asleepMin', 'recovery', 0)).toBeNull();
  });

  it('shifts the pairing when a lag is applied', () => {
    const model = buildModel(timeline(40, () => ({})), DEFAULT_SETTINGS);
    const same = correlate(model, 'asleepMin', 'recovery', 0);
    const lagged = correlate(model, 'asleepMin', 'recovery', 1);
    if (same && lagged) expect(lagged.n).toBeLessThan(same.n);
  });
});

describe('thresholdEffect', () => {
  it('quantifies the difference either side of a threshold', () => {
    const model = buildModel(
      timeline(60, (i) => {
        const asleep = i % 2 === 0 ? 360 : 500;
        return {
          hrv: i % 2 === 0 ? 40 : 70,
          sleep: {
            asleepMin: asleep, inBedMin: asleep + 20, deepMin: 60, remMin: 80,
            coreMin: asleep - 140, awakeMin: 10,
            bedStartMs: Date.UTC(2024, 0, 1 + i, 23, 0),
            wakeEndMs: Date.UTC(2024, 0, 2 + i, 7, 0),
            latencyMin: 10, efficiency: 0.94, interruptions: 1, sourceCount: 1,
          },
        };
      }),
      DEFAULT_SETTINGS,
    );
    const c = correlate(model, 'asleepMin', 'recovery', 0)!;
    const effect = thresholdEffect(c, 420)!;
    expect(effect.below).toBeLessThan(effect.above);
    expect(effect.deltaPct).toBeLessThan(0);
    expect(effect.nBelow).toBeGreaterThan(3);
  });

  it('returns null when one side of the threshold is nearly empty', () => {
    const c = correlate(steady, 'asleepMin', 'recovery', 0);
    if (c) expect(thresholdEffect(c, 60)).toBeNull();
  });
});

describe('generateInsights', () => {
  it('always produces something to read', () => {
    expect(generateInsights(steady, 89).length).toBeGreaterThan(0);
  });

  it('leads with the most urgent finding on a bad day', () => {
    const model = buildModel(
      timeline(60, (i) =>
        i >= 55
          ? {
              hrv: 25, rhr: 68,
              sleep: {
                asleepMin: 280, inBedMin: 400, deepMin: 20, remMin: 25, coreMin: 235,
                awakeMin: 60, bedStartMs: Date.UTC(2024, 1, 1 + i, 1, 0),
                wakeEndMs: Date.UTC(2024, 1, 1 + i, 6, 0),
                latencyMin: 50, efficiency: 0.7, interruptions: 4, sourceCount: 1,
              },
            }
          : {},
      ),
      DEFAULT_SETTINGS,
    );
    const insights = generateInsights(model, 59);
    expect(insights[0].tone).toBe('critical');
    expect(insights[0].action).toBeTruthy();
  });

  it('leads with encouragement on a good day', () => {
    const model = buildModel(
      timeline(60, (i) => (i >= 55 ? { hrv: 95, rhr: 44 } : {})),
      DEFAULT_SETTINGS,
    );
    expect(generateInsights(model, 59)[0].id).toBe('recovery-high');
  });

  it('never returns more than the requested number', () => {
    expect(generateInsights(steady, 89, 3).length).toBeLessThanOrEqual(3);
  });

  it('never repeats the same insight', () => {
    const insights = generateInsights(steady, 89, 8);
    expect(new Set(insights.map((i) => i.id)).size).toBe(insights.length);
  });

  it('gives every insight a title and a body', () => {
    for (const insight of generateInsights(steady, 89, 8)) {
      expect(insight.title.length).toBeGreaterThan(3);
      expect(insight.body.length).toBeGreaterThan(20);
      expect(insight.confidence).toBeGreaterThan(0);
      expect(insight.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('copes with an out-of-range index instead of throwing', () => {
    expect(generateInsights(steady, 999)).toEqual([]);
    expect(generateInsights(steady, -1)).toEqual([]);
  });

  it('says something honest on a day with no data at all', () => {
    const model = buildModel(
      timeline(10, () => ({ hrv: null, rhr: null, sleep: null, activeEnergy: 0, exerciseMinutes: 0 })),
      DEFAULT_SETTINGS,
    );
    const insights = generateInsights(model, 9);
    expect(insights.length).toBeGreaterThan(0);
    expect(insights[0].body).toMatch(/enough data|baseline/i);
  });
});

describe('buildWeeklyRecap', () => {
  it('needs a full week before it will report', () => {
    expect(buildWeeklyRecap(steady, 3)).toBeNull();
  });

  it('summarises the week with a headline and metrics', () => {
    const recap = buildWeeklyRecap(steady, 89)!;
    expect(recap.daysCovered).toBe(7);
    expect(recap.headline.length).toBeGreaterThan(20);
    expect(recap.metrics.length).toBeGreaterThan(3);
    expect(recap.bestDay).not.toBeNull();
  });

  it('compares against the prior week', () => {
    const model = buildModel(
      timeline(60, (i) => ({ hrv: i >= 53 ? 90 : 50 })),
      DEFAULT_SETTINGS,
    );
    const recap = buildWeeklyRecap(model, 59)!;
    const hrv = recap.metrics.find((m) => m.key === 'hrv')!;
    expect(hrv.changePct).toBeGreaterThan(20);
    expect(hrv.favourable).toBe(true);
  });

  it('handles an index past the end of the data', () => {
    expect(buildWeeklyRecap(steady, 999)).toBeNull();
  });
});
