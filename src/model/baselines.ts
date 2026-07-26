/**
 * Adaptive personal baselines.
 *
 * The prototype used a flat 30-day trailing median. That has two problems worth fixing:
 * a value from exactly 30 days ago counts as much as yesterday's, and when you only
 * have four days of data it still produces a confident-looking number. Here baselines
 * are exponentially weighted (recent days matter more) and carry an explicit
 * confidence, so the UI can refuse to show a misleading comparison.
 */

import type { Baseline } from '../core/types';
import { ewma, stdDev, clamp01, finite } from './stats';

/** Fewer observations than this and we decline to produce a baseline at all. */
export const MIN_OBSERVATIONS = 4;
/** At or above this many observations the baseline is considered fully trustworthy. */
export const FULL_OBSERVATIONS = 21;
/** Below this confidence the UI shows a "low confidence" state instead of a delta. */
export const LOW_CONFIDENCE = 0.45;

/** How long the trailing window is, in days, before exponential weighting is applied. */
export const BASELINE_WINDOW_DAYS = 60;

export interface BaselineOptions {
  halfLifeDays?: number;
  /**
   * Minimum standard deviation, in the metric's own units. Without a floor, a person
   * with a few near-identical readings gets a near-zero SD, and then a 1ms HRV change
   * reads as a 10-sigma event.
   */
  sdFloor: number;
  /** SD is also floored at this fraction of the mean, for scale-free safety. */
  sdFloorPct?: number;
}

/**
 * Builds a baseline from trailing observations in chronological order (oldest first).
 * Callers pass only *prior* days — never the day being scored — so a day is never
 * compared against itself.
 */
export function buildBaseline(
  observations: readonly (number | null)[],
  opts: BaselineOptions,
): Baseline | null {
  const values = finite(observations);
  if (values.length < MIN_OBSERVATIONS) return null;

  const window = values.slice(-BASELINE_WINDOW_DAYS);
  const m = ewma(window, opts.halfLifeDays ?? 14);
  if (m == null) return null;

  const rawSd = stdDev(window) ?? 0;
  const pctFloor = (opts.sdFloorPct ?? 0) * Math.abs(m);
  const sd = Math.max(rawSd, opts.sdFloor, pctFloor);

  const n = window.length;
  const confidence = clamp01((n - MIN_OBSERVATIONS) / (FULL_OBSERVATIONS - MIN_OBSERVATIONS));

  return { mean: m, sd, n, confidence };
}

/** Per-metric SD floors, in each metric's native units. */
export const SD_FLOORS = {
  /** HRV is noisy day to day; 3ms is below the meaningful-change threshold. */
  hrv: { sdFloor: 3, sdFloorPct: 0.06 },
  /** Resting HR is stable; a 1.5bpm floor keeps small drifts from screaming. */
  rhr: { sdFloor: 1.5, sdFloorPct: 0.02 },
  /** Respiratory rate moves in tenths; 0.4 breaths/min is the noise floor. */
  respiratoryRate: { sdFloor: 0.4, sdFloorPct: 0.02 },
} as const satisfies Record<string, BaselineOptions>;

/**
 * Signed z-score of a value against its baseline, clamped to a sane range so a single
 * corrupt record can't produce a 40-sigma outlier that dominates every average.
 */
export function zScore(value: number, baseline: Baseline): number {
  if (!Number.isFinite(value) || baseline.sd <= 0) return 0;
  const z = (value - baseline.mean) / baseline.sd;
  return Math.max(-4, Math.min(4, z));
}

export function isConfident(baseline: Baseline | null): boolean {
  return baseline != null && baseline.confidence >= LOW_CONFIDENCE;
}
