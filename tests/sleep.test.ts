import { describe, it, expect } from 'vitest';
import {
  computeSleep,
  deriveSleepNeed,
  DEBT_WINDOW_NIGHTS,
  DEFAULT_SLEEP_NEED,
  fulfilment,
  fulfilmentScore,
  MAX_SLEEP_NEED,
  MIN_SLEEP_NEED,
  qualityScore,
  sleepDebt,
  wakeConsistency,
} from '../src/model/sleep';
import type { SleepNight } from '../src/core/types';

function night(over: Partial<SleepNight> = {}): SleepNight {
  const base = Date.UTC(2024, 2, 11, 7, 0, 0);
  return {
    asleepMin: 450,
    inBedMin: 480,
    deepMin: 80,
    remMin: 100,
    coreMin: 270,
    awakeMin: 20,
    bedStartMs: base - 8 * 3600_000,
    wakeEndMs: base,
    latencyMin: 12,
    efficiency: 450 / 480,
    interruptions: 2,
    sourceCount: 1,
    ...over,
  };
}

describe('deriveSleepNeed', () => {
  it('falls back to a sane default without enough nights', () => {
    expect(deriveSleepNeed([])).toBe(DEFAULT_SLEEP_NEED);
    expect(deriveSleepNeed([400, 420])).toBe(DEFAULT_SLEEP_NEED);
  });

  it('never assumes someone needs less than seven hours', () => {
    // A chronically short sleeper's habit must not be read as a low need.
    expect(deriveSleepNeed([300, 310, 320, 305, 315])).toBe(MIN_SLEEP_NEED);
  });

  it('caps at a plausible maximum', () => {
    expect(deriveSleepNeed([700, 720, 710, 730, 715])).toBe(MAX_SLEEP_NEED);
  });

  it('uses the upper quartile, not the median', () => {
    // Someone who usually gets 7h but reaches 8h when nothing is in the way.
    const nights = [400, 410, 420, 430, 440, 450, 460, 470, 480];
    const need = deriveSleepNeed(nights);
    expect(need).toBeGreaterThan(440);
  });

  it('ignores implausibly short records', () => {
    const need = deriveSleepNeed([20, 30, 470, 480, 490, 500]);
    expect(need).toBeGreaterThan(MIN_SLEEP_NEED);
  });
});

describe('fulfilment', () => {
  it('caps at 1 and floors at 0', () => {
    expect(fulfilment(900, 450)).toBe(1);
    expect(fulfilment(0, 450)).toBe(0);
    expect(fulfilment(450, 0)).toBe(0);
  });
});

describe('qualityScore', () => {
  it('rewards a high share of deep and REM', () => {
    const good = qualityScore(night({ deepMin: 110, remMin: 110, asleepMin: 450 }))!;
    const poor = qualityScore(night({ deepMin: 30, remMin: 40, asleepMin: 450 }))!;
    expect(good).toBeGreaterThan(poor);
  });

  it('returns null when a source provides neither stages nor efficiency', () => {
    const bare = night({ deepMin: 0, remMin: 0, coreMin: 0, efficiency: null });
    expect(qualityScore(bare)).toBeNull();
  });

  it('still scores when only efficiency is available', () => {
    const noStages = night({ deepMin: 0, remMin: 0, coreMin: 0, efficiency: 0.92 });
    expect(qualityScore(noStages)).toBeGreaterThan(0.5);
  });
});

describe('sleepDebt', () => {
  it('accumulates shortfalls', () => {
    const short = [night({ asleepMin: 360 }), night({ asleepMin: 360 })];
    expect(sleepDebt(short, 450)).toBe(180);
  });

  it('lets surpluses repay debt, but only partially', () => {
    // You cannot fully bank sleep — one long night must not erase a bad week.
    const mixed = [night({ asleepMin: 330 }), night({ asleepMin: 570 })];
    expect(sleepDebt(mixed, 450)).toBe(60); // 120 owed, 120 surplus repaying at half rate
  });

  it('never goes negative', () => {
    const surplus = [night({ asleepMin: 600 }), night({ asleepMin: 600 })];
    expect(sleepDebt(surplus, 450)).toBe(0);
  });

  it('only looks back over the debt window', () => {
    const ancient = Array(40).fill(night({ asleepMin: 300 }));
    const debt = sleepDebt(ancient, 450);
    expect(debt).toBe(DEBT_WINDOW_NIGHTS * 150);
  });

  it('skips missing nights instead of counting them as zero sleep', () => {
    // A night with no recording is unknown, not a night of no sleep.
    expect(sleepDebt([null, null, night({ asleepMin: 390 })], 450)).toBe(60);
  });
});

describe('wakeConsistency', () => {
  it('needs at least three nights before reporting', () => {
    expect(wakeConsistency([night(), night()])).toBeNull();
  });

  it('reports a steady schedule as consistent', () => {
    const wake = (h: number, m: number) => night({ wakeEndMs: new Date(2024, 2, 11, h, m).getTime() });
    const sd = wakeConsistency([wake(6, 30), wake(6, 45), wake(6, 35), wake(6, 40)])!;
    expect(sd).toBeLessThan(20);
  });

  it('reports an erratic schedule as inconsistent', () => {
    const wake = (h: number) => night({ wakeEndMs: new Date(2024, 2, 11, h, 0).getTime() });
    const sd = wakeConsistency([wake(5), wake(11), wake(7), wake(13)])!;
    expect(sd).toBeGreaterThan(90);
  });
});

describe('computeSleep', () => {
  it('returns a null score but still reports debt for a night with no recording', () => {
    const r = computeSleep({
      night: null,
      needMin: 450,
      recentNights: [night({ asleepMin: 300 }), null],
    });
    expect(r.score).toBeNull();
    expect(r.asleepMin).toBe(0);
    expect(r.debtMin).toBeGreaterThan(0);
  });

  it('scores a full, well-staged night highly', () => {
    const r = computeSleep({
      night: night({ asleepMin: 470, deepMin: 100, remMin: 110, efficiency: 0.95 }),
      needMin: 450,
      recentNights: [],
    });
    expect(r.score).toBeGreaterThan(90);
  });

  it('scores a short, fragmented night poorly', () => {
    const r = computeSleep({
      night: night({ asleepMin: 280, deepMin: 20, remMin: 30, efficiency: 0.72 }),
      needMin: 450,
      recentNights: [],
    });
    expect(r.score).toBeLessThan(40);
  });

  it('uses the same duration curve as recovery does', () => {
    // Two different curves for "did you sleep enough" would let the sleep card and the
    // recovery ring contradict each other.
    const asleepMin = 337.5; // exactly 75% of need — the midpoint of the curve
    const r = computeSleep({
      night: night({ asleepMin, deepMin: 0, remMin: 0, coreMin: 0, efficiency: null, inBedMin: null }),
      needMin: 450,
      recentNights: [],
    });
    expect(fulfilmentScore(asleepMin, 450)).toBeCloseTo(0.5, 6);
    expect(r.score).toBe(50);
  });

  it('weights duration above quality', () => {
    const r = computeSleep({ night: night(), needMin: 450, recentNights: [] });
    const duration = r.components.find((c) => c.key === 'duration')!;
    const quality = r.components.find((c) => c.key === 'quality')!;
    expect(duration.weight).toBeGreaterThan(quality.weight);
    expect(duration.weight + quality.weight).toBeCloseTo(1, 6);
  });

  it('scores on duration alone when stage data is absent', () => {
    const bare = night({ deepMin: 0, remMin: 0, coreMin: 0, efficiency: null, inBedMin: null });
    const r = computeSleep({ night: bare, needMin: 450, recentNights: [] });
    expect(r.score).not.toBeNull();
    expect(r.components).toHaveLength(1);
    expect(r.components[0].weight).toBe(1);
  });

  it('passes efficiency and latency through for the detail sheet', () => {
    const r = computeSleep({ night: night({ latencyMin: 25 }), needMin: 450, recentNights: [] });
    expect(r.latencyMin).toBe(25);
    expect(r.efficiency).toBeCloseTo(450 / 480, 4);
  });
});
