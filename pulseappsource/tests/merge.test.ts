/**
 * Merge-on-reimport.
 *
 * The failure mode this guards against is quiet and destructive: a user imports a
 * partial or older export and silently *loses* days or signals they already had.
 */

import { describe, it, expect } from 'vitest';
import { mergeDayRecord, mergeDayRecords, mergeSleep, mergeWorkouts } from '../src/core/merge';
import type { DayRecord, SleepNight, Workout } from '../src/core/types';

function day(date: string, over: Partial<DayRecord> = {}): DayRecord {
  return {
    date,
    rhr: null, hrv: null, respiratoryRate: null, spo2: null, vo2max: null,
    bodyMassKg: null, bodyFatPct: null, walkingHrAvg: null,
    activeEnergy: 0, exerciseMinutes: 0, steps: 0, standHours: 0,
    distanceKm: 0, mindfulMinutes: 0,
    hrHistogram: null, hrMinutesCovered: 0, maxHr: null,
    sleep: null, workouts: [],
    ...over,
  };
}

function night(asleepMin: number): SleepNight {
  return {
    asleepMin, inBedMin: asleepMin + 20, deepMin: 60, remMin: 80, coreMin: asleepMin - 140,
    awakeMin: 10, bedStartMs: 1_700_000_000_000, wakeEndMs: 1_700_020_000_000,
    latencyMin: 10, efficiency: 0.94, interruptions: 1, sourceCount: 1,
  };
}

const workout = (startMs: number, durationMin: number): Workout => ({
  type: 'Running', startMs, durationMin, energyKcal: 300, distanceKm: 5,
});

describe('mergeDayRecord', () => {
  it('keeps an existing signal the incoming record lacks', () => {
    // The exact data-loss bug: a newer export missing HRV must not erase it.
    const existing = day('2024-03-11', { hrv: 55, rhr: 52 });
    const incoming = day('2024-03-11', { rhr: 50 });
    const merged = mergeDayRecord(existing, incoming);
    expect(merged.hrv).toBe(55);
    expect(merged.rhr).toBe(50);
  });

  it('prefers the incoming value when both have one', () => {
    const merged = mergeDayRecord(day('2024-03-11', { hrv: 40 }), day('2024-03-11', { hrv: 60 }));
    expect(merged.hrv).toBe(60);
  });

  it('takes the larger total rather than summing', () => {
    // Summing would double every day when the same export is imported twice.
    const merged = mergeDayRecord(
      day('2024-03-11', { steps: 9000, activeEnergy: 500 }),
      day('2024-03-11', { steps: 12000, activeEnergy: 400 }),
    );
    expect(merged.steps).toBe(12000);
    expect(merged.activeEnergy).toBe(500);
  });

  it('is idempotent — importing the same export twice changes nothing', () => {
    const original = day('2024-03-11', {
      hrv: 55, rhr: 52, steps: 9000, activeEnergy: 500,
      sleep: night(450), workouts: [workout(1000, 45)],
      hrHistogram: [1, 2, 3], hrMinutesCovered: 6, maxHr: 160,
    });
    expect(mergeDayRecord(original, structuredClone(original))).toEqual(original);
  });

  it('keeps the richer heart-rate histogram', () => {
    const merged = mergeDayRecord(
      day('2024-03-11', { hrHistogram: [10, 0, 0], hrMinutesCovered: 10, maxHr: 150 }),
      day('2024-03-11', { hrHistogram: [200, 5, 1], hrMinutesCovered: 206, maxHr: 175 }),
    );
    expect(merged.hrMinutesCovered).toBe(206);
    expect(merged.hrHistogram).toEqual([200, 5, 1]);
    expect(merged.maxHr).toBe(175);
  });

  it('keeps an existing histogram when the incoming day has none', () => {
    const merged = mergeDayRecord(
      day('2024-03-11', { hrHistogram: [10, 2], hrMinutesCovered: 12, maxHr: 150 }),
      day('2024-03-11'),
    );
    expect(merged.hrHistogram).toEqual([10, 2]);
    expect(merged.hrMinutesCovered).toBe(12);
  });
});

describe('mergeSleep', () => {
  it('keeps the more complete recording', () => {
    expect(mergeSleep(night(300), night(460))!.asleepMin).toBe(460);
    expect(mergeSleep(night(460), night(300))!.asleepMin).toBe(460);
  });

  it('fills in a night that was previously missing', () => {
    expect(mergeSleep(null, night(420))!.asleepMin).toBe(420);
    expect(mergeSleep(night(420), null)!.asleepMin).toBe(420);
    expect(mergeSleep(null, null)).toBeNull();
  });
});

describe('mergeWorkouts', () => {
  it('treats same-start-time entries as the same session', () => {
    const merged = mergeWorkouts([workout(1000, 45)], [workout(1000, 45)]);
    expect(merged).toHaveLength(1);
  });

  it('unions distinct sessions and keeps them ordered', () => {
    const merged = mergeWorkouts([workout(3000, 20)], [workout(1000, 45)]);
    expect(merged.map((w) => w.startMs)).toEqual([1000, 3000]);
  });

  it('prefers the entry with the fuller record', () => {
    const merged = mergeWorkouts([workout(1000, 20)], [workout(1000, 60)]);
    expect(merged[0].durationMin).toBe(60);
  });
});

describe('mergeDayRecords', () => {
  it('adds new days and reports what changed', () => {
    const result = mergeDayRecords(
      [day('2024-03-10'), day('2024-03-11')],
      [day('2024-03-11', { hrv: 50 }), day('2024-03-12')],
    );
    expect(result.added).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.days.map((d) => d.date)).toEqual(['2024-03-10', '2024-03-11', '2024-03-12']);
  });

  it('never drops a day that is absent from the new import', () => {
    // Importing a one-month export must not wipe out three years of history.
    const existing = ['2024-01-01', '2024-01-02', '2024-01-03'].map((d) => day(d, { hrv: 50 }));
    const result = mergeDayRecords(existing, [day('2024-06-01')]);
    expect(result.days).toHaveLength(4);
    expect(result.days.filter((d) => d.hrv === 50)).toHaveLength(3);
  });

  it('always returns days sorted oldest first', () => {
    const result = mergeDayRecords([day('2024-03-15')], [day('2024-03-01'), day('2024-03-20')]);
    expect(result.days.map((d) => d.date)).toEqual(['2024-03-01', '2024-03-15', '2024-03-20']);
  });

  it('handles an empty store', () => {
    const result = mergeDayRecords([], [day('2024-03-11')]);
    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
  });

  it('handles an import with nothing new', () => {
    const result = mergeDayRecords([day('2024-03-11')], []);
    expect(result.days).toHaveLength(1);
    expect(result.added).toBe(0);
  });

  it('does not mutate the stored records it was given', () => {
    const existing = [day('2024-03-11', { hrv: 50 })];
    const snapshot = structuredClone(existing);
    mergeDayRecords(existing, [day('2024-03-11', { hrv: 70 })]);
    expect(existing).toEqual(snapshot);
  });
});
