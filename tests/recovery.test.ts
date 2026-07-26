import { describe, it, expect } from 'vitest';
import { computeRecovery, recoveryBand, sleepFulfilmentScore } from '../src/model/recovery';
import { buildBaseline, isConfident, MIN_OBSERVATIONS, SD_FLOORS, zScore } from '../src/model/baselines';
import type { Baseline } from '../src/core/types';

const baseline = (mean: number, sd: number, n = 30): Baseline => ({
  mean,
  sd,
  n,
  confidence: 1,
});

const inputs = (over: Partial<Parameters<typeof computeRecovery>[0]> = {}) => ({
  hrv: 50,
  rhr: 52,
  respiratoryRate: null,
  asleepMin: 450,
  hrvBaseline: baseline(50, 6),
  rhrBaseline: baseline(52, 2),
  respiratoryBaseline: null,
  sleepNeedMin: 450,
  ...over,
});

describe('buildBaseline', () => {
  it('refuses to produce a baseline from too few observations', () => {
    expect(buildBaseline([50, 51, 49], SD_FLOORS.hrv)).toBeNull();
    expect(buildBaseline(Array(MIN_OBSERVATIONS).fill(50), SD_FLOORS.hrv)).not.toBeNull();
  });

  it('ignores gaps in the history', () => {
    const b = buildBaseline([50, null, 52, null, 48, 51], SD_FLOORS.hrv)!;
    expect(b.n).toBe(4);
  });

  it('floors the standard deviation so tiny variation is not treated as signal', () => {
    // Five near-identical readings would give an SD near zero, which would make a 1ms
    // change read as a many-sigma event.
    const b = buildBaseline([50, 50, 50.1, 50, 49.9], SD_FLOORS.hrv)!;
    expect(b.sd).toBeGreaterThanOrEqual(3);
  });

  it('grows confidence with the number of observations', () => {
    const few = buildBaseline(Array(6).fill(50), SD_FLOORS.hrv)!;
    const many = buildBaseline(Array(30).fill(50), SD_FLOORS.hrv)!;
    expect(many.confidence).toBeGreaterThan(few.confidence);
    expect(many.confidence).toBe(1);
    expect(isConfident(few)).toBe(false);
    expect(isConfident(many)).toBe(true);
  });

  it('tracks a drifting baseline rather than lagging on old data', () => {
    const rising = buildBaseline([40, 42, 45, 50, 55, 60, 65], SD_FLOORS.hrv)!;
    const flatMean = (40 + 42 + 45 + 50 + 55 + 60 + 65) / 7;
    expect(rising.mean).toBeGreaterThan(flatMean);
  });
});

describe('zScore', () => {
  it('clamps extreme outliers so one corrupt record cannot dominate', () => {
    expect(zScore(1000, baseline(50, 5))).toBe(4);
    expect(zScore(-1000, baseline(50, 5))).toBe(-4);
  });

  it('is zero at the baseline mean', () => {
    expect(zScore(50, baseline(50, 5))).toBe(0);
  });
});

describe('sleepFulfilmentScore', () => {
  it('scores a met need as full marks', () => {
    expect(sleepFulfilmentScore(450, 450)).toBe(1);
    expect(sleepFulfilmentScore(600, 450)).toBe(1);
  });

  it('scores half the need as zero', () => {
    expect(sleepFulfilmentScore(225, 450)).toBe(0);
  });

  it('is linear in between', () => {
    expect(sleepFulfilmentScore(337.5, 450)).toBeCloseTo(0.5, 6);
  });
});

describe('computeRecovery', () => {
  it('returns null — not zero — when there is no data at all', () => {
    const r = computeRecovery(inputs({ hrv: null, rhr: null, asleepMin: null }));
    expect(r.score).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it('scores a perfectly average day near the middle', () => {
    const r = computeRecovery(inputs());
    expect(r.score).toBeGreaterThan(55);
    expect(r.score).toBeLessThan(85);
  });

  it('scores high when HRV is up, resting HR is down and sleep is met', () => {
    const r = computeRecovery(inputs({ hrv: 70, rhr: 46, asleepMin: 480 }));
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.band).toBe('high');
  });

  it('scores low when HRV is suppressed, resting HR is elevated and sleep is short', () => {
    const r = computeRecovery(inputs({ hrv: 30, rhr: 62, asleepMin: 260 }));
    expect(r.score).toBeLessThan(30);
    expect(r.band).toBe('low');
  });

  it('stays within 1..99 even at absurd extremes', () => {
    const high = computeRecovery(inputs({ hrv: 500, rhr: 20, asleepMin: 900 }));
    const low = computeRecovery(inputs({ hrv: 1, rhr: 200, asleepMin: 1 }));
    expect(high.score).toBeLessThanOrEqual(99);
    expect(low.score).toBeGreaterThanOrEqual(1);
  });

  it('renormalises weights when a signal is missing', () => {
    // With no sleep data the remaining components must still sum to a full weight,
    // otherwise a missing signal would silently drag every score down.
    const r = computeRecovery(inputs({ asleepMin: null }));
    const sum = r.components.reduce((a, c) => a + c.weight, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(r.components.map((c) => c.key)).toEqual(['hrv', 'rhr']);
  });

  it('skips components whose baseline is not yet available', () => {
    const r = computeRecovery(inputs({ hrvBaseline: null }));
    expect(r.components.find((c) => c.key === 'hrv')).toBeUndefined();
    expect(r.score).not.toBeNull();
  });

  it('weights HRV most heavily', () => {
    const r = computeRecovery(inputs());
    const hrv = r.components.find((c) => c.key === 'hrv')!;
    const rhr = r.components.find((c) => c.key === 'rhr')!;
    expect(hrv.weight).toBeGreaterThan(rhr.weight);
  });

  it('treats a lower resting heart rate as the good direction', () => {
    const lower = computeRecovery(inputs({ rhr: 46 })).score!;
    const higher = computeRecovery(inputs({ rhr: 60 })).score!;
    expect(lower).toBeGreaterThan(higher);
  });

  it('penalises a sustained rise in respiratory rate', () => {
    const normal = computeRecovery(
      inputs({ respiratoryRate: 14, respiratoryBaseline: baseline(14, 0.5) }),
    );
    const elevated = computeRecovery(
      inputs({ respiratoryRate: 16.5, respiratoryBaseline: baseline(14, 0.5) }),
    );
    expect(elevated.score!).toBeLessThan(normal.score!);
    expect(elevated.modifier).toBeLessThan(1);
    expect(elevated.modifierReason).toBeTruthy();
  });

  it('bounds the respiratory penalty so it can never be the whole story', () => {
    const extreme = computeRecovery(
      inputs({ respiratoryRate: 40, respiratoryBaseline: baseline(14, 0.5) }),
    );
    expect(extreme.modifier).toBeGreaterThanOrEqual(0.88);
  });

  it('reports lower confidence when leaning on a thin baseline', () => {
    const thin = computeRecovery(
      inputs({ hrvBaseline: { mean: 50, sd: 6, n: 5, confidence: 0.1 } }),
    );
    const solid = computeRecovery(inputs());
    expect(thin.confidence).toBeLessThan(solid.confidence);
  });

  it('explains every component it used', () => {
    const r = computeRecovery(inputs());
    expect(r.components.length).toBe(3);
    for (const c of r.components) {
      expect(c.detail.length).toBeGreaterThan(5);
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(1);
    }
  });
});

describe('recoveryBand', () => {
  it('matches the documented thresholds', () => {
    expect(recoveryBand(67)).toBe('high');
    expect(recoveryBand(66)).toBe('moderate');
    expect(recoveryBand(34)).toBe('moderate');
    expect(recoveryBand(33)).toBe('low');
  });
});
