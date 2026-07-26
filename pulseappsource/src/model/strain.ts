/**
 * Strain — "how much cardiovascular load did this body take today?"
 *
 * The prototype approximated this with `activeEnergy + exerciseMinutes * 5`, which
 * treats a 45-minute walk and a 45-minute threshold run as similar days. This module
 * computes strain from **time spent in heart-rate zones**, which is what actually
 * distinguishes them, and keeps the energy proxy as a labelled fallback for days
 * without heart-rate samples (phone-only days, watch left on the charger).
 */

import type { ScoreComponent, StrainResult, ZoneMinutes } from '../core/types';
import { HR_HISTOGRAM_BIN, HR_HISTOGRAM_MIN } from '../core/types';
import { clamp, clamp01, percentile } from './stats';

export const MAX_STRAIN = 21;

/**
 * TRIMP-style zone weights: one minute in each zone, in "load units".
 * The curve is deliberately super-linear — physiologically, a minute at 92% of heart
 * rate reserve is far more than twice the stimulus of a minute at 55%.
 */
export const ZONE_WEIGHTS: readonly number[] = [1, 2, 3.5, 6, 9];

export const ZONE_LABELS = ['Zone 1', 'Zone 2', 'Zone 3', 'Zone 4', 'Zone 5'] as const;
export const ZONE_DESCRIPTIONS = [
  'Very light — recovery and daily movement',
  'Light — aerobic base, conversational',
  'Moderate — tempo, breathing gets deliberate',
  'Hard — threshold, sustainable only in blocks',
  'Maximum — anaerobic, minutes at a time',
] as const;

/** Lower bound of each zone as a fraction of heart-rate reserve (Karvonen). */
export const ZONE_FLOORS: readonly number[] = [0.5, 0.6, 0.7, 0.8, 0.9];

/**
 * Which zone a heart-rate sample falls in.
 * Returns `-1` for anything below Zone 1 — sitting at a desk shouldn't accrue strain.
 */
export function hrZoneOf(hr: number, restingHr: number, maxHr: number): number {
  const reserve = maxHr - restingHr;
  if (!Number.isFinite(hr) || reserve <= 0) return -1;
  const pct = (hr - restingHr) / reserve;
  for (let z = ZONE_FLOORS.length - 1; z >= 0; z--) {
    if (pct >= ZONE_FLOORS[z]) return z;
  }
  return -1;
}

/**
 * Converts a stored per-day heart-rate histogram into zone minutes.
 *
 * Each bucket is attributed using its **midpoint** heart rate. Because zone boundaries
 * depend on resting and max HR — both of which the user can correct in Settings, and
 * both of which drift as fitness changes — keeping this as a derivation rather than
 * baking zones in at parse time means changing a setting re-scores all of history
 * immediately.
 */
export function zonesFromHistogram(
  histogram: readonly number[],
  restingHr: number,
  maxHr: number,
): ZoneMinutes {
  const zones: ZoneMinutes = [0, 0, 0, 0, 0];
  for (let bin = 0; bin < histogram.length; bin++) {
    const minutes = histogram[bin];
    if (!minutes) continue;
    const midpointHr = HR_HISTOGRAM_MIN + bin * HR_HISTOGRAM_BIN + HR_HISTOGRAM_BIN / 2;
    const z = hrZoneOf(midpointHr, restingHr, maxHr);
    if (z >= 0) zones[z] += minutes;
  }
  return zones;
}

/** Weighted sum of zone minutes → raw cardiovascular load. */
export function zoneLoad(zoneMinutes: ZoneMinutes): number {
  let load = 0;
  for (let i = 0; i < zoneMinutes.length; i++) {
    load += Math.max(0, zoneMinutes[i]) * ZONE_WEIGHTS[i];
  }
  return load;
}

/** The energy-based fallback load, used only when no HR samples exist. */
export function proxyLoad(activeEnergy: number, exerciseMinutes: number): number {
  return Math.max(0, activeEnergy) + Math.max(0, exerciseMinutes) * 6;
}

/**
 * Maps raw load onto the 0–21 scale.
 *
 * Logarithmic, not linear: the first hard hour of a day changes your physiology far
 * more than the fourth. `reference` is the personal load that maps to exactly 21, so
 * the scale means the same thing for an ultrarunner and someone starting out.
 *
 * Shape check (with reference = 400):
 *   load   0 → 0.0    (nothing)
 *   load  40 → 5.9    (a walk — a real rest day)
 *   load 200 → 15.3   (solid session)
 *   load 400 → 21.0   (an all-out day)
 */
export function strainCurve(load: number, reference: number): number {
  if (!Number.isFinite(load) || load <= 0 || reference <= 0) return 0;
  const a = 9;
  const x = clamp01(load / reference);
  return clamp((MAX_STRAIN * Math.log1p(a * x)) / Math.log1p(a), 0, MAX_STRAIN);
}

/** Absolute floors so a short history can't make every day look maximal. */
export const REFERENCE_FLOORS = { zones: 260, proxy: 700 } as const;

/**
 * Derives the personal load that maps to a strain of 21, from the whole dataset.
 * The 95th percentile means roughly one day a month tops out — which is what a maximal
 * scale should feel like.
 */
export function deriveReference(loads: readonly number[], kind: 'zones' | 'proxy'): number {
  const active = loads.filter((l) => l > 0);
  const p95 = percentile(active, 0.95) ?? 0;
  return Math.max(REFERENCE_FLOORS[kind], p95);
}

export interface StrainInputs {
  zoneMinutes: ZoneMinutes | null;
  hrMinutesCovered: number;
  activeEnergy: number;
  exerciseMinutes: number;
  referenceZones: number;
  referenceProxy: number;
}

/**
 * Minimum minutes of heart-rate coverage before we trust the zone path.
 * An Apple Watch worn all day yields ~200–300 sampled minutes; 45 is enough to have
 * captured a workout, and below that we're better off with the energy proxy.
 */
export const MIN_HR_COVERAGE = 45;

export function computeStrain(input: StrainInputs): StrainResult {
  const hasZones = input.zoneMinutes != null && input.hrMinutesCovered >= MIN_HR_COVERAGE;

  if (hasZones) {
    const zones = input.zoneMinutes!;
    const load = zoneLoad(zones);
    const score = strainCurve(load, input.referenceZones);
    const components: ScoreComponent[] = [];
    for (let i = 0; i < zones.length; i++) {
      if (zones[i] <= 0) continue;
      components.push({
        key: `zone${i + 1}`,
        label: ZONE_LABELS[i],
        value: zones[i],
        baseline: null,
        score: load > 0 ? (zones[i] * ZONE_WEIGHTS[i]) / load : 0,
        weight: load > 0 ? (zones[i] * ZONE_WEIGHTS[i]) / load : 0,
        detail: `${Math.round(zones[i])} min · ${ZONE_DESCRIPTIONS[i]}`,
      });
    }
    return {
      score,
      method: 'hr-zones',
      load,
      reference: input.referenceZones,
      zoneMinutes: zones,
      confidence: clamp01(input.hrMinutesCovered / 240),
      components,
    };
  }

  const load = proxyLoad(input.activeEnergy, input.exerciseMinutes);
  if (load <= 0) {
    return {
      score: 0,
      method: 'none',
      load: 0,
      reference: input.referenceProxy,
      zoneMinutes: null,
      confidence: 0,
      components: [],
    };
  }

  const score = strainCurve(load, input.referenceProxy);
  return {
    score,
    method: 'energy-proxy',
    load,
    reference: input.referenceProxy,
    zoneMinutes: null,
    // The proxy is genuinely less trustworthy, and the number says so.
    confidence: 0.45,
    components: [
      {
        key: 'activeEnergy',
        label: 'Active energy',
        value: input.activeEnergy,
        baseline: null,
        score: load > 0 ? input.activeEnergy / load : 0,
        weight: load > 0 ? input.activeEnergy / load : 0,
        detail: `${Math.round(input.activeEnergy)} kcal burned above resting`,
      },
      {
        key: 'exercise',
        label: 'Exercise minutes',
        value: input.exerciseMinutes,
        baseline: null,
        score: load > 0 ? (input.exerciseMinutes * 6) / load : 0,
        weight: load > 0 ? (input.exerciseMinutes * 6) / load : 0,
        detail: `${Math.round(input.exerciseMinutes)} min at elevated effort`,
      },
    ],
  };
}

/** Verbal band for a strain score, used in copy. */
export function strainBand(score: number): 'minimal' | 'light' | 'moderate' | 'high' | 'all-out' {
  if (score < 5) return 'minimal';
  if (score < 10) return 'light';
  if (score < 14) return 'moderate';
  if (score < 18) return 'high';
  return 'all-out';
}

/**
 * The load a target strain would require — used to turn "you have room today" into an
 * actual recommendation the user can act on.
 */
export function loadForStrain(target: number, reference: number): number {
  const a = 9;
  const x = (Math.exp((clamp(target, 0, MAX_STRAIN) * Math.log1p(a)) / MAX_STRAIN) - 1) / a;
  return x * reference;
}
