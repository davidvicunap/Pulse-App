/**
 * Sleep analytics.
 *
 * Sleep is the metric people most want detail on and the one most often reported
 * wrong, because Apple Health commonly holds the same night from several sources. All
 * durations here come from merged intervals (see `stats.mergeIntervals`), so a night
 * recorded by a Watch, an iPhone and a third-party app still totals one night.
 */

import type { ScoreComponent, SleepNight, SleepResult } from '../core/types';
import { circularSdMinutes, clamp, clamp01, median } from './stats';

/** Floor for personal sleep need. Below 7h we assume under-sleeping, not low need. */
export const MIN_SLEEP_NEED = 420;
export const MAX_SLEEP_NEED = 600;
export const DEFAULT_SLEEP_NEED = 465;

/** Sleep debt accumulates over this many nights; older shortfalls are considered paid. */
export const DEBT_WINDOW_NIGHTS = 14;

/** Target share of the night spent in deep + REM. Below this, quality is penalised. */
export const RESTORATIVE_TARGET = 0.4;

/**
 * Derives personal sleep need from habit.
 *
 * Uses the 75th percentile of recorded nights rather than the median: the median tells
 * you what someone *usually gets*, which on a chronically short sleeper just ratifies
 * the deficit. The upper quartile is closer to what they get when nothing is in the way.
 */
export function deriveSleepNeed(asleepMinutes: readonly number[]): number {
  const valid = asleepMinutes.filter((m) => Number.isFinite(m) && m > 180);
  if (valid.length < 3) return DEFAULT_SLEEP_NEED;
  const sorted = [...valid].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(0.75 * (sorted.length - 1)));
  const upperQuartile = sorted[idx];
  return clamp(Math.round(upperQuartile), MIN_SLEEP_NEED, MAX_SLEEP_NEED);
}

/** Raw fraction of need met, capped at 1. Used for display ("92% of your need"). */
export function fulfilment(asleepMin: number, needMin: number): number {
  if (needMin <= 0) return 0;
  return clamp01(asleepMin / needMin);
}

/**
 * The canonical duration sub-score, shared by the sleep score and by recovery's sleep
 * component so the two can never disagree about what "enough sleep" means.
 *
 * Hitting your need scores 1.0; half your need scores 0. The raw ratio would be far too
 * generous — it would rate a five-hour night against an eight-hour need at 62%, which
 * is not a passable night by any measure.
 */
export function fulfilmentScore(asleepMin: number, needMin: number): number {
  if (needMin <= 0) return 0;
  return clamp01((asleepMin / needMin - 0.5) / 0.5);
}

/**
 * Quality sub-score from stage composition and efficiency.
 * Falls back gracefully: a source with no stage data still scores on duration alone.
 */
export function qualityScore(night: SleepNight): number | null {
  const staged = night.deepMin + night.remMin + night.coreMin;
  const parts: number[] = [];

  if (staged > 0 && night.asleepMin > 0) {
    const restorative = (night.deepMin + night.remMin) / night.asleepMin;
    parts.push(clamp01(restorative / RESTORATIVE_TARGET));
  }
  if (night.efficiency != null) {
    // 85% efficiency is the clinical threshold for "good"; 95%+ is excellent.
    parts.push(clamp01((night.efficiency - 0.7) / 0.25));
  }
  if (!parts.length) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

export interface SleepScoreInputs {
  night: SleepNight | null;
  needMin: number;
  /** Trailing nights, most recent last, *including* tonight. Drives debt + consistency. */
  recentNights: readonly (SleepNight | null)[];
}

export function computeSleep(input: SleepScoreInputs): SleepResult {
  const { night, needMin } = input;
  const debtMin = sleepDebt(input.recentNights, needMin);
  const consistencyMin = wakeConsistency(input.recentNights);

  if (!night || night.asleepMin <= 0) {
    return {
      score: null,
      asleepMin: 0,
      needMin,
      debtMin,
      efficiency: null,
      latencyMin: null,
      consistencyMin,
      components: [],
    };
  }

  const dur = fulfilmentScore(night.asleepMin, needMin);
  const qual = qualityScore(night);

  const components: ScoreComponent[] = [
    {
      key: 'duration',
      label: 'Duration',
      value: night.asleepMin,
      baseline: needMin,
      score: dur,
      weight: qual == null ? 1 : 0.7,
      detail:
        night.asleepMin >= needMin
          ? `${fmtHM(night.asleepMin)} asleep — need met.`
          : `${fmtHM(night.asleepMin)} asleep, ${fmtHM(needMin - night.asleepMin)} short of need.`,
    },
  ];

  if (qual != null) {
    const restorativePct =
      night.asleepMin > 0 ? ((night.deepMin + night.remMin) / night.asleepMin) * 100 : 0;
    components.push({
      key: 'quality',
      label: 'Quality',
      value: restorativePct,
      baseline: RESTORATIVE_TARGET * 100,
      score: qual,
      weight: 0.3,
      detail:
        `${Math.round(night.deepMin)}m deep + ${Math.round(night.remMin)}m REM ` +
        `= ${restorativePct.toFixed(0)}% restorative` +
        (night.efficiency != null ? `, ${(night.efficiency * 100).toFixed(0)}% efficiency.` : '.'),
    });
  }

  const weightSum = components.reduce((a, c) => a + c.weight, 0);
  let acc = 0;
  for (const c of components) {
    c.weight = c.weight / weightSum;
    acc += c.score * c.weight;
  }

  return {
    score: Math.round(clamp(acc * 100, 0, 100)),
    asleepMin: night.asleepMin,
    needMin,
    debtMin,
    efficiency: night.efficiency,
    latencyMin: night.latencyMin,
    consistencyMin,
    components,
  };
}

/**
 * Accumulated shortfall against need over the trailing window.
 * Surpluses pay down debt but only partially — you cannot fully bank sleep, and a model
 * that let one 10-hour night erase a bad fortnight would be lying.
 */
export function sleepDebt(nights: readonly (SleepNight | null)[], needMin: number): number {
  const window = nights.slice(-DEBT_WINDOW_NIGHTS);
  let debt = 0;
  for (const n of window) {
    if (!n || n.asleepMin <= 0) continue;
    const delta = needMin - n.asleepMin;
    if (delta > 0) debt += delta;
    else debt += delta * 0.5; // surplus repays at half rate
  }
  return Math.max(0, Math.round(debt));
}

/** Circular SD of wake times — the single best predictor of how you'll feel. */
export function wakeConsistency(nights: readonly (SleepNight | null)[]): number | null {
  const wakeMinutes: number[] = [];
  for (const n of nights) {
    if (!n || !Number.isFinite(n.wakeEndMs)) continue;
    const d = new Date(n.wakeEndMs);
    wakeMinutes.push(d.getHours() * 60 + d.getMinutes());
  }
  if (wakeMinutes.length < 3) return null;
  return circularSdMinutes(wakeMinutes);
}

/** Median bed/wake clock time across nights, for the "your rhythm" readout. */
export function typicalTimes(
  nights: readonly (SleepNight | null)[],
): { bedMin: number | null; wakeMin: number | null } {
  const beds: number[] = [];
  const wakes: number[] = [];
  for (const n of nights) {
    if (!n) continue;
    if (Number.isFinite(n.bedStartMs)) {
      const d = new Date(n.bedStartMs);
      let m = d.getHours() * 60 + d.getMinutes();
      // Fold evening bedtimes onto a continuous scale around midnight so the median
      // of 23:30 and 00:30 is midnight, not noon.
      if (m < 720) m += 1440;
      beds.push(m);
    }
    if (Number.isFinite(n.wakeEndMs)) {
      const d = new Date(n.wakeEndMs);
      wakes.push(d.getHours() * 60 + d.getMinutes());
    }
  }
  const bedRaw = median(beds);
  return {
    bedMin: bedRaw == null ? null : bedRaw % 1440,
    wakeMin: median(wakes),
  };
}

function fmtHM(minutes: number): string {
  const m = Math.abs(Math.round(minutes));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}m`;
  if (rem === 0) return `${h}h`;
  return `${h}h ${rem}m`;
}
