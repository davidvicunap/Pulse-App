import { describe, it, expect } from 'vitest';
import {
  computeStrain,
  deriveReference,
  hrZoneOf,
  loadForStrain,
  MAX_STRAIN,
  MIN_HR_COVERAGE,
  proxyLoad,
  strainBand,
  strainCurve,
  zoneLoad,
  zonesFromHistogram,
  ZONE_WEIGHTS,
} from '../src/model/strain';
import { HR_HISTOGRAM_BIN, HR_HISTOGRAM_BINS, HR_HISTOGRAM_MIN, type ZoneMinutes } from '../src/core/types';

const REST = 50;
const MAX = 190;
// Heart-rate reserve of 140bpm, so zone floors land at 120/134/148/162/176.

describe('hrZoneOf', () => {
  it('assigns nothing below 50% of heart-rate reserve', () => {
    expect(hrZoneOf(60, REST, MAX)).toBe(-1);
    expect(hrZoneOf(119, REST, MAX)).toBe(-1);
  });

  it('places heart rates in the expected zones', () => {
    expect(hrZoneOf(120, REST, MAX)).toBe(0); // exactly 50%
    expect(hrZoneOf(140, REST, MAX)).toBe(1);
    expect(hrZoneOf(155, REST, MAX)).toBe(2);
    expect(hrZoneOf(170, REST, MAX)).toBe(3);
    expect(hrZoneOf(180, REST, MAX)).toBe(4);
    expect(hrZoneOf(250, REST, MAX)).toBe(4);
  });

  it('is defensive about an impossible reserve', () => {
    expect(hrZoneOf(150, 190, 190)).toBe(-1);
    expect(hrZoneOf(150, 200, 190)).toBe(-1);
    expect(hrZoneOf(NaN, REST, MAX)).toBe(-1);
  });
});

describe('zonesFromHistogram', () => {
  function histogramWith(bpm: number, minutes: number): number[] {
    const h = new Array<number>(HR_HISTOGRAM_BINS).fill(0);
    h[Math.floor((bpm - HR_HISTOGRAM_MIN) / HR_HISTOGRAM_BIN)] = minutes;
    return h;
  }

  it('routes histogram buckets into the right zone', () => {
    const zones = zonesFromHistogram(histogramWith(170, 30), REST, MAX);
    expect(zones[3]).toBe(30);
    expect(zones[0] + zones[1] + zones[2] + zones[4]).toBe(0);
  });

  it('discards time below zone 1 entirely', () => {
    // Sitting at a desk at 70bpm must not accrue strain.
    expect(zonesFromHistogram(histogramWith(70, 480), REST, MAX)).toEqual([0, 0, 0, 0, 0]);
  });

  it('re-scores the same histogram differently when max HR changes', () => {
    // This is the whole reason we store the histogram rather than fixed zone minutes:
    // correcting max HR in Settings must re-score history without a re-import.
    const hist = histogramWith(160, 20);
    const withHighMax = zonesFromHistogram(hist, REST, 200);
    const withLowMax = zonesFromHistogram(hist, REST, 170);
    expect(withLowMax[4]).toBeGreaterThan(withHighMax[4]);
  });
});

describe('strainCurve', () => {
  it('is zero for no load', () => {
    expect(strainCurve(0, 400)).toBe(0);
    expect(strainCurve(-5, 400)).toBe(0);
  });

  it('reaches exactly the maximum at the reference load', () => {
    expect(strainCurve(400, 400)).toBeCloseTo(MAX_STRAIN, 6);
  });

  it('never exceeds the maximum, however extreme the load', () => {
    expect(strainCurve(10_000, 400)).toBeLessThanOrEqual(MAX_STRAIN);
  });

  it('is monotonically increasing', () => {
    let prev = -1;
    for (let load = 0; load <= 500; load += 10) {
      const s = strainCurve(load, 400);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it('is concave — the first hard hour counts for more than the fourth', () => {
    const first = strainCurve(100, 400) - strainCurve(0, 400);
    const fourth = strainCurve(400, 400) - strainCurve(300, 400);
    expect(first).toBeGreaterThan(fourth);
  });

  it('is safe against a zero or negative reference', () => {
    expect(strainCurve(100, 0)).toBe(0);
    expect(strainCurve(100, -10)).toBe(0);
  });
});

/**
 * Regression tests for the strain-scaling bug the prototype shipped. These pin the
 * behaviour the product promises: a rest day is visibly low, and an all-out day is
 * near the top of the scale.
 */
describe('strain scaling (regression)', () => {
  const reference = 400;

  it('scores a true rest day low', () => {
    // A gentle 40-minute walk that barely enters zone 1.
    const zones: ZoneMinutes = [40, 0, 0, 0, 0];
    const score = strainCurve(zoneLoad(zones), reference);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(8);
  });

  it('scores a completely sedentary day near zero', () => {
    const score = strainCurve(zoneLoad([2, 0, 0, 0, 0]), reference);
    expect(score).toBeLessThan(1.5);
  });

  it('scores a moderate session in the middle of the scale', () => {
    const zones: ZoneMinutes = [20, 25, 20, 5, 0];
    const score = strainCurve(zoneLoad(zones), reference);
    expect(score).toBeGreaterThan(9);
    expect(score).toBeLessThan(16);
  });

  it('scores an all-out day near 21', () => {
    // A long hard session: an hour of tempo plus real time at threshold and above.
    const zones: ZoneMinutes = [30, 40, 45, 30, 12];
    const load = zoneLoad(zones);
    expect(load).toBeGreaterThanOrEqual(reference);
    expect(strainCurve(load, reference)).toBeCloseTo(21, 5);
  });

  it('orders days correctly by intensity, not just duration', () => {
    // The prototype's energy proxy could not tell these apart. A 60-minute easy walk
    // must score below a 30-minute hard interval session.
    const easyLong = strainCurve(zoneLoad([60, 0, 0, 0, 0]), reference);
    const hardShort = strainCurve(zoneLoad([5, 5, 5, 10, 5]), reference);
    expect(hardShort).toBeGreaterThan(easyLong);
  });

  it('weights higher zones progressively harder', () => {
    for (let i = 1; i < ZONE_WEIGHTS.length; i++) {
      expect(ZONE_WEIGHTS[i]).toBeGreaterThan(ZONE_WEIGHTS[i - 1]);
    }
  });

  it('round-trips through loadForStrain', () => {
    for (const target of [3, 8, 14, 21]) {
      const load = loadForStrain(target, reference);
      expect(strainCurve(load, reference)).toBeCloseTo(target, 5);
    }
  });
});

describe('deriveReference', () => {
  it('never drops below the floor, however light the history', () => {
    expect(deriveReference([5, 10, 12], 'zones')).toBe(260);
    expect(deriveReference([], 'proxy')).toBe(700);
  });

  it('uses the personal 95th percentile once loads are meaningful', () => {
    const loads = Array.from({ length: 100 }, (_, i) => i * 20); // 0…1980
    expect(deriveReference(loads, 'zones')).toBeGreaterThan(1800);
  });

  it('ignores zero-load days when picking the percentile', () => {
    const withRest = deriveReference([0, 0, 0, 0, 1000], 'zones');
    const withoutRest = deriveReference([1000], 'zones');
    expect(withRest).toBe(withoutRest);
  });
});

describe('computeStrain', () => {
  const base = {
    activeEnergy: 0,
    exerciseMinutes: 0,
    referenceZones: 400,
    referenceProxy: 900,
  };

  it('uses the heart-rate zone path when coverage is sufficient', () => {
    const r = computeStrain({
      ...base,
      zoneMinutes: [20, 20, 10, 5, 0],
      hrMinutesCovered: 200,
    });
    expect(r.method).toBe('hr-zones');
    expect(r.score).toBeGreaterThan(0);
    expect(r.confidence).toBeGreaterThan(0.5);
    expect(r.components.length).toBe(4); // one per non-empty zone
  });

  it('falls back to the energy proxy when heart-rate coverage is too thin', () => {
    const r = computeStrain({
      ...base,
      zoneMinutes: [20, 20, 10, 5, 0],
      hrMinutesCovered: MIN_HR_COVERAGE - 1,
      activeEnergy: 500,
      exerciseMinutes: 40,
    });
    expect(r.method).toBe('energy-proxy');
    expect(r.load).toBe(proxyLoad(500, 40));
    // The fallback is genuinely less trustworthy and says so.
    expect(r.confidence).toBeLessThan(0.5);
  });

  it('reports "none" for a day with no signal at all, rather than a fake zero', () => {
    const r = computeStrain({ ...base, zoneMinutes: null, hrMinutesCovered: 0 });
    expect(r.method).toBe('none');
    expect(r.score).toBe(0);
    expect(r.confidence).toBe(0);
  });

  it('splits component weights so they sum to one', () => {
    const r = computeStrain({ ...base, zoneMinutes: [10, 10, 10, 10, 10], hrMinutesCovered: 300 });
    const sum = r.components.reduce((a, c) => a + c.weight, 0);
    expect(sum).toBeCloseTo(1, 6);
  });
});

describe('strainBand', () => {
  it('labels the ends of the scale', () => {
    expect(strainBand(1)).toBe('minimal');
    expect(strainBand(20)).toBe('all-out');
  });
});
