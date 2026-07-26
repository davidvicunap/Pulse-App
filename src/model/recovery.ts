/**
 * Recovery — "how ready is this body today?"
 *
 * A weighted blend of three signals compared against personal baselines, plus a
 * secondary modifier. Every component is returned with its inputs and a plain-language
 * explanation so the UI can show *why* the number is what it is; a recovery score you
 * can't interrogate is a number people stop trusting after the first surprise.
 */

import type { Baseline, RecoveryResult, ScoreComponent } from '../core/types';
import { zScore } from './baselines';
import { fulfilmentScore } from './sleep';
import { clamp, clamp01 } from './stats';

export interface RecoveryInputs {
  hrv: number | null;
  rhr: number | null;
  respiratoryRate: number | null;
  asleepMin: number | null;
  hrvBaseline: Baseline | null;
  rhrBaseline: Baseline | null;
  respiratoryBaseline: Baseline | null;
  sleepNeedMin: number;
}

/** Nominal weights. Renormalised across whichever components actually have data. */
export const RECOVERY_WEIGHTS = {
  hrv: 0.5,
  rhr: 0.25,
  sleep: 0.25,
} as const;

/**
 * How much one standard deviation moves a sub-score.
 * 0.2 means +2.5 SD saturates at 1.0 — aggressive enough that a genuinely great day
 * reads as great, conservative enough that ordinary noise doesn't swing the ring.
 */
const Z_SENSITIVITY = 0.2;

export const RECOVERY_BANDS = { high: 67, moderate: 34 } as const;

export function recoveryBand(score: number): 'low' | 'moderate' | 'high' {
  if (score >= RECOVERY_BANDS.high) return 'high';
  if (score >= RECOVERY_BANDS.moderate) return 'moderate';
  return 'low';
}

/**
 * Sleep's contribution to recovery.
 * Re-exported from the sleep module rather than reimplemented, so the sleep score and
 * the recovery ring can never disagree about what counts as enough sleep.
 */
export const sleepFulfilmentScore = fulfilmentScore;

export function computeRecovery(input: RecoveryInputs): RecoveryResult {
  const components: ScoreComponent[] = [];

  if (input.hrv != null && input.hrvBaseline) {
    const z = zScore(input.hrv, input.hrvBaseline);
    const score = clamp01(0.5 + z * Z_SENSITIVITY);
    const deltaPct = ((input.hrv - input.hrvBaseline.mean) / input.hrvBaseline.mean) * 100;
    components.push({
      key: 'hrv',
      label: 'Heart rate variability',
      value: input.hrv,
      baseline: input.hrvBaseline.mean,
      score,
      weight: RECOVERY_WEIGHTS.hrv,
      detail: describeDelta(deltaPct, z, 'above', 'below', 'your baseline'),
    });
  }

  if (input.rhr != null && input.rhrBaseline) {
    // Inverted: a *lower* resting heart rate is the good direction.
    const z = -zScore(input.rhr, input.rhrBaseline);
    const score = clamp01(0.5 + z * Z_SENSITIVITY);
    const deltaBpm = input.rhr - input.rhrBaseline.mean;
    components.push({
      key: 'rhr',
      label: 'Resting heart rate',
      value: input.rhr,
      baseline: input.rhrBaseline.mean,
      score,
      weight: RECOVERY_WEIGHTS.rhr,
      detail:
        Math.abs(deltaBpm) < 0.5
          ? 'Sitting right on your baseline.'
          : `${Math.abs(deltaBpm).toFixed(0)} bpm ${deltaBpm > 0 ? 'above' : 'below'} baseline — ` +
            `${deltaBpm > 0 ? 'a sign of load or stress' : 'a good sign'}.`,
    });
  }

  if (input.asleepMin != null && input.asleepMin > 0) {
    const score = sleepFulfilmentScore(input.asleepMin, input.sleepNeedMin);
    const deficit = input.sleepNeedMin - input.asleepMin;
    components.push({
      key: 'sleep',
      label: 'Sleep',
      value: input.asleepMin,
      baseline: input.sleepNeedMin,
      score,
      weight: RECOVERY_WEIGHTS.sleep,
      detail:
        deficit <= 0
          ? `You met your ${fmtHours(input.sleepNeedMin)} need.`
          : `${fmtHours(deficit)} short of your ${fmtHours(input.sleepNeedMin)} need.`,
    });
  }

  if (!components.length) {
    return {
      score: null,
      band: 'moderate',
      components: [],
      confidence: 0,
      modifier: 1,
      modifierReason: null,
    };
  }

  // Renormalise weights across present components so a missing signal doesn't silently
  // drag the score toward zero.
  const weightSum = components.reduce((a, c) => a + c.weight, 0);
  let acc = 0;
  for (const c of components) {
    c.weight = c.weight / weightSum;
    acc += c.score * c.weight;
  }

  const { modifier, reason } = respiratoryModifier(input);
  const raw = acc * modifier * 100;
  const score = Math.round(clamp(raw, 1, 99));

  return {
    score,
    band: recoveryBand(score),
    components,
    confidence: confidenceOf(input, components.length),
    modifier,
    modifierReason: reason,
  };
}

/**
 * A sustained rise in overnight respiratory rate is one of the earliest signals of
 * illness or heavy alcohol load, and it isn't captured by HRV/RHR alone — so it applies
 * a bounded penalty rather than being a fourth weighted component. Bounded at 12% so it
 * can flag a problem without ever being the whole story.
 */
function respiratoryModifier(input: RecoveryInputs): { modifier: number; reason: string | null } {
  const { respiratoryRate, respiratoryBaseline } = input;
  if (respiratoryRate == null || !respiratoryBaseline) return { modifier: 1, reason: null };
  const z = zScore(respiratoryRate, respiratoryBaseline);
  if (z < 1.5) return { modifier: 1, reason: null };
  const modifier = clamp(1 - (z - 1.5) * 0.05, 0.88, 1);
  if (modifier >= 0.999) return { modifier: 1, reason: null };
  const delta = respiratoryRate - respiratoryBaseline.mean;
  return {
    modifier,
    reason:
      `Respiratory rate ran ${delta.toFixed(1)} breaths/min above baseline overnight, ` +
      `which trims recovery by ${Math.round((1 - modifier) * 100)}%.`,
  };
}

/** Confidence is limited by the weakest baseline the score actually leaned on. */
function confidenceOf(input: RecoveryInputs, componentCount: number): number {
  const confidences: number[] = [];
  if (input.hrv != null && input.hrvBaseline) confidences.push(input.hrvBaseline.confidence);
  if (input.rhr != null && input.rhrBaseline) confidences.push(input.rhrBaseline.confidence);
  // Sleep needs no baseline — it's measured against a personal need, so it's always solid.
  if (input.asleepMin != null) confidences.push(0.9);
  if (!confidences.length) return 0;
  const weakest = Math.min(...confidences);
  // Having all three signals is itself evidence; one signal alone caps confidence lower.
  const coverage = clamp01(componentCount / 3);
  return clamp01(weakest * 0.7 + coverage * 0.3);
}

function describeDelta(
  deltaPct: number,
  z: number,
  aboveWord: string,
  belowWord: string,
  ref: string,
): string {
  if (Math.abs(z) < 0.4) return `Tracking right at ${ref}.`;
  const dir = deltaPct >= 0 ? aboveWord : belowWord;
  const magnitude = Math.abs(z) >= 1.5 ? 'well ' : '';
  return `${Math.abs(deltaPct).toFixed(0)}% ${magnitude}${dir} ${ref}.`;
}

function fmtHours(minutes: number): string {
  const m = Math.abs(Math.round(minutes));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}m`;
  if (rem === 0) return `${h}h`;
  return `${h}h ${rem}m`;
}
