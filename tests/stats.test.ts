import { describe, it, expect } from 'vitest';
import {
  circularSdMinutes,
  ewma,
  linearFit,
  mean,
  median,
  mergeIntervals,
  pearson,
  percentile,
  stdDev,
  subtractIntervals,
  totalMinutes,
  type Interval,
} from '../src/model/stats';

describe('central tendency', () => {
  it('returns null rather than NaN for empty input', () => {
    expect(mean([])).toBeNull();
    expect(median([])).toBeNull();
    expect(stdDev([1])).toBeNull();
    expect(percentile([], 0.5)).toBeNull();
  });

  it('ignores nulls and non-finite values', () => {
    expect(mean([1, null, 3, NaN as unknown as number])).toBe(2);
    expect(median([5, null, 1, 3])).toBe(3);
  });

  it('averages the middle pair for even-length medians', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('percentile', () => {
  it('interpolates rather than snapping to the nearest rank', () => {
    // With 5 values, p95 sits between the 4th and 5th — a nearest-rank implementation
    // would return exactly 50, which makes small-sample strain references far too jumpy.
    expect(percentile([10, 20, 30, 40, 50], 0.95)).toBeCloseTo(48, 5);
  });

  it('handles the degenerate single-value case', () => {
    expect(percentile([42], 0.95)).toBe(42);
  });

  it('clamps out-of-range p', () => {
    expect(percentile([1, 2, 3], 5)).toBe(3);
    expect(percentile([1, 2, 3], -1)).toBe(1);
  });
});

describe('ewma', () => {
  it('weights the most recent observation highest', () => {
    const flat = mean([10, 10, 10, 40])!;
    const weighted = ewma([10, 10, 10, 40], 2)!;
    expect(weighted).toBeGreaterThan(flat);
  });

  it('equals the mean when all values are identical', () => {
    expect(ewma([7, 7, 7, 7])).toBeCloseTo(7, 10);
  });

  it('is order-sensitive — a recent drop matters more than an old one', () => {
    const recentDrop = ewma([50, 50, 50, 20], 7)!;
    const oldDrop = ewma([20, 50, 50, 50], 7)!;
    expect(recentDrop).toBeLessThan(oldDrop);
  });
});

describe('mergeIntervals', () => {
  const iv = (a: number, b: number): Interval => [a, b];

  it('merges overlapping intervals so duplicates are not double-counted', () => {
    // The exact scenario that breaks naive parsers: a Watch and a third-party app both
    // record the same night.
    const merged = mergeIntervals([iv(0, 100), iv(50, 160), iv(0, 160)]);
    expect(merged).toEqual([[0, 160]]);
    expect(totalMinutes([iv(0, 60_000), iv(0, 60_000)])).toBe(1);
  });

  it('keeps disjoint intervals separate', () => {
    expect(mergeIntervals([iv(0, 10), iv(20, 30)])).toEqual([
      [0, 10],
      [20, 30],
    ]);
  });

  it('sorts unordered input before merging', () => {
    expect(mergeIntervals([iv(20, 30), iv(0, 25)])).toEqual([[0, 30]]);
  });

  it('drops zero-length and inverted intervals', () => {
    expect(mergeIntervals([iv(10, 10), iv(30, 20)])).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [iv(0, 10), iv(5, 20)];
    mergeIntervals(input);
    expect(input).toEqual([
      [0, 10],
      [5, 20],
    ]);
  });
});

describe('subtractIntervals', () => {
  const iv = (a: number, b: number): Interval => [a, b];

  it('punches a hole in the middle', () => {
    expect(subtractIntervals([iv(0, 100)], [iv(40, 60)])).toEqual([
      [0, 40],
      [60, 100],
    ]);
  });

  it('trims from the edges', () => {
    expect(subtractIntervals([iv(0, 100)], [iv(0, 30)])).toEqual([[30, 100]]);
    expect(subtractIntervals([iv(0, 100)], [iv(80, 200)])).toEqual([[0, 80]]);
  });

  it('removes an interval entirely when fully covered', () => {
    expect(subtractIntervals([iv(10, 20)], [iv(0, 100)])).toEqual([]);
  });

  it('ignores holes that do not intersect', () => {
    expect(subtractIntervals([iv(0, 10)], [iv(50, 60)])).toEqual([[0, 10]]);
  });

  it('handles multiple holes in one interval', () => {
    expect(subtractIntervals([iv(0, 100)], [iv(10, 20), iv(40, 50)])).toEqual([
      [0, 10],
      [20, 40],
      [50, 100],
    ]);
  });
});

describe('circularSdMinutes', () => {
  it('treats times either side of midnight as close together', () => {
    // 23:50 and 00:10 are 20 minutes apart; a linear SD would report ~1000.
    const sd = circularSdMinutes([23 * 60 + 50, 10, 0, 23 * 60 + 55])!;
    expect(sd).toBeLessThan(30);
  });

  it('reports a genuinely erratic schedule as erratic', () => {
    const sd = circularSdMinutes([6 * 60, 11 * 60, 8 * 60, 14 * 60])!;
    expect(sd).toBeGreaterThan(100);
  });

  it('returns 0 for a perfectly consistent schedule', () => {
    expect(circularSdMinutes([420, 420, 420])).toBeCloseTo(0, 6);
  });
});

describe('correlation', () => {
  it('finds a perfect positive relationship', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 6);
  });

  it('finds a perfect negative relationship', () => {
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 6);
  });

  it('refuses to report a correlation from too few points', () => {
    expect(pearson([1, 2], [2, 4])).toBeNull();
  });

  it('returns null when a series has no variance', () => {
    expect(pearson([1, 1, 1, 1], [1, 2, 3, 4])).toBeNull();
  });

  it('fits a line through noisy-free points', () => {
    const fit = linearFit([0, 1, 2, 3], [1, 3, 5, 7])!;
    expect(fit.slope).toBeCloseTo(2, 6);
    expect(fit.intercept).toBeCloseTo(1, 6);
  });
});
