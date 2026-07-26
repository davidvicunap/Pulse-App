/**
 * Merging days across imports.
 *
 * Re-importing must add new days without discarding what's already stored. That sounds
 * like a simple overwrite, but it isn't: a user might import a partial export, or an
 * export taken before a device synced, and blindly overwriting would silently *delete*
 * signals they already had. So merging is field-wise and additive — for each field we
 * keep whichever side actually has data, preferring the incoming value on a genuine tie.
 *
 * Pure, so it's unit-tested directly.
 */

import type { DayRecord, SleepNight, Workout } from './types';

/** Prefers `incoming` when it carries information, otherwise falls back to `existing`. */
function preferValue<T>(existing: T | null, incoming: T | null): T | null {
  return incoming != null ? incoming : existing;
}

/** For counters, the larger value is the more complete one. */
function preferLarger(existing: number, incoming: number): number {
  return Math.max(existing || 0, incoming || 0);
}

/** Keeps the night with more recorded sleep — the more complete recording. */
export function mergeSleep(existing: SleepNight | null, incoming: SleepNight | null): SleepNight | null {
  if (!existing) return incoming;
  if (!incoming) return existing;
  return incoming.asleepMin >= existing.asleepMin ? incoming : existing;
}

/** Unions workouts, treating same-start-time entries as the same session. */
export function mergeWorkouts(existing: Workout[], incoming: Workout[]): Workout[] {
  const byStart = new Map<number, Workout>();
  for (const w of existing) byStart.set(w.startMs, w);
  for (const w of incoming) {
    const prior = byStart.get(w.startMs);
    // A later export may have filled in totals the earlier one lacked.
    if (!prior || w.durationMin >= prior.durationMin) byStart.set(w.startMs, w);
  }
  return [...byStart.values()].sort((a, b) => a.startMs - b.startMs);
}

/** Keeps the histogram with more covered minutes — the day the device recorded more. */
function mergeHistogram(
  existing: DayRecord,
  incoming: DayRecord,
): Pick<DayRecord, 'hrHistogram' | 'hrMinutesCovered' | 'maxHr'> {
  if (!existing.hrHistogram) {
    return {
      hrHistogram: incoming.hrHistogram,
      hrMinutesCovered: incoming.hrMinutesCovered,
      maxHr: incoming.maxHr,
    };
  }
  if (!incoming.hrHistogram) {
    return {
      hrHistogram: existing.hrHistogram,
      hrMinutesCovered: existing.hrMinutesCovered,
      maxHr: existing.maxHr,
    };
  }
  const useIncoming = incoming.hrMinutesCovered >= existing.hrMinutesCovered;
  const chosen = useIncoming ? incoming : existing;
  return {
    hrHistogram: chosen.hrHistogram,
    hrMinutesCovered: chosen.hrMinutesCovered,
    maxHr: Math.max(existing.maxHr ?? 0, incoming.maxHr ?? 0) || null,
  };
}

export function mergeDayRecord(existing: DayRecord, incoming: DayRecord): DayRecord {
  return {
    date: existing.date,

    rhr: preferValue(existing.rhr, incoming.rhr),
    hrv: preferValue(existing.hrv, incoming.hrv),
    respiratoryRate: preferValue(existing.respiratoryRate, incoming.respiratoryRate),
    spo2: preferValue(existing.spo2, incoming.spo2),
    vo2max: preferValue(existing.vo2max, incoming.vo2max),
    bodyMassKg: preferValue(existing.bodyMassKg, incoming.bodyMassKg),
    bodyFatPct: preferValue(existing.bodyFatPct, incoming.bodyFatPct),
    walkingHrAvg: preferValue(existing.walkingHrAvg, incoming.walkingHrAvg),

    // Totals: the higher figure reflects the more complete sync. Summing would be
    // wrong — re-importing the same export would double every day.
    activeEnergy: preferLarger(existing.activeEnergy, incoming.activeEnergy),
    exerciseMinutes: preferLarger(existing.exerciseMinutes, incoming.exerciseMinutes),
    steps: preferLarger(existing.steps, incoming.steps),
    standHours: preferLarger(existing.standHours, incoming.standHours),
    distanceKm: preferLarger(existing.distanceKm, incoming.distanceKm),
    mindfulMinutes: preferLarger(existing.mindfulMinutes, incoming.mindfulMinutes),

    ...mergeHistogram(existing, incoming),
    sleep: mergeSleep(existing.sleep, incoming.sleep),
    workouts: mergeWorkouts(existing.workouts, incoming.workouts),
  };
}

/**
 * Merges a freshly parsed set of days into what's already stored.
 * Returns the merged list plus a summary the UI can report honestly
 * ("added 12 days, updated 3").
 */
export function mergeDayRecords(
  existing: readonly DayRecord[],
  incoming: readonly DayRecord[],
): { days: DayRecord[]; added: number; updated: number } {
  const byDate = new Map<string, DayRecord>();
  for (const d of existing) byDate.set(d.date, d);

  let added = 0;
  let updated = 0;
  for (const day of incoming) {
    const prior = byDate.get(day.date);
    if (prior) {
      byDate.set(day.date, mergeDayRecord(prior, day));
      updated++;
    } else {
      byDate.set(day.date, day);
      added++;
    }
  }

  const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { days, added, updated };
}
