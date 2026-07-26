/**
 * Small, dependency-free statistics helpers.
 *
 * Everything here is pure and total: no throwing, no NaN leaking out. Callers get
 * `null` for "not computable" so the UI can distinguish "zero" from "unknown" — a
 * distinction that matters a lot in health data, where a missing HRV reading and an
 * HRV of 0 mean very different things.
 */

/** Filters to finite numbers. Guards every other function in this file. */
export function finite(values: readonly (number | null | undefined)[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  }
  return out;
}

export function mean(values: readonly (number | null)[]): number | null {
  const v = finite(values);
  if (!v.length) return null;
  let sum = 0;
  for (const x of v) sum += x;
  return sum / v.length;
}

export function median(values: readonly (number | null)[]): number | null {
  const v = finite(values);
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  const h = v.length >> 1;
  return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
}

export function stdDev(values: readonly (number | null)[]): number | null {
  const v = finite(values);
  if (v.length < 2) return null;
  const m = mean(v)!;
  let acc = 0;
  for (const x of v) acc += (x - m) ** 2;
  // Sample standard deviation — these are samples of a person, not a population.
  return Math.sqrt(acc / (v.length - 1));
}

/**
 * Linear-interpolated percentile, `p` in 0..1.
 * Interpolating matters for small datasets: with 12 days of data, a nearest-rank p95
 * would just return the maximum, which makes the strain reference far too jumpy.
 */
export function percentile(values: readonly (number | null)[], p: number): number | null {
  const v = finite(values);
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  if (v.length === 1) return v[0];
  const idx = clamp(p, 0, 1) * (v.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return v[lo];
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

/**
 * Exponentially-weighted mean, most recent value weighted highest.
 * `values` must be in chronological order (oldest first).
 *
 * Preferred over a flat 30-day mean for baselines: a person's HRV baseline genuinely
 * drifts with fitness and season, and a flat window makes today's comparison sensitive
 * to what happened exactly 30 days ago falling out of the window.
 */
export function ewma(values: readonly number[], halfLifeDays = 14): number | null {
  if (!values.length) return null;
  const decay = Math.log(2) / halfLifeDays;
  let wSum = 0;
  let acc = 0;
  const n = values.length;
  for (let i = 0; i < n; i++) {
    // Age in positions from the newest element.
    const age = n - 1 - i;
    const w = Math.exp(-decay * age);
    acc += values[i] * w;
    wSum += w;
  }
  return wSum > 0 ? acc / wSum : null;
}

/** Pearson correlation of two equal-length paired series. Null if degenerate. */
export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return null;
  return num / Math.sqrt(dx2 * dy2);
}

/** Ordinary least-squares fit. Returns slope/intercept of `y = slope*x + intercept`. */
export function linearFit(
  xs: readonly number[],
  ys: readonly number[],
): { slope: number; intercept: number } | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    num += dx * (ys[i] - my);
    den += dx * dx;
  }
  if (den === 0) return null;
  const slope = num / den;
  return { slope, intercept: my - slope * mx };
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

/** Half-open time interval in epoch milliseconds. */
export type Interval = [start: number, end: number];

/**
 * Merges overlapping/adjacent intervals.
 *
 * This is the single most important correctness guard in the app. Apple Health exports
 * routinely contain the same night of sleep from three sources (Watch, iPhone, a
 * third-party app), and naively summing durations inflates a 7-hour night to 20 hours.
 * Merging first makes the total independent of how many devices were recording.
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const valid = intervals.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s);
  if (!valid.length) return [];
  const sorted = valid.map((i) => [i[0], i[1]] as Interval).sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = out[out.length - 1];
    if (cur[0] <= last[1]) {
      if (cur[1] > last[1]) last[1] = cur[1];
    } else {
      out.push(cur);
    }
  }
  return out;
}

/** Total duration of a set of intervals in minutes, overlaps counted once. */
export function totalMinutes(intervals: readonly Interval[]): number {
  let ms = 0;
  for (const [s, e] of mergeIntervals(intervals)) ms += e - s;
  return ms / 60_000;
}

/**
 * Subtracts `holes` from `base`, returning what remains.
 * Used to remove recorded awake blocks from a sleep window.
 */
export function subtractIntervals(
  base: readonly Interval[],
  holes: readonly Interval[],
): Interval[] {
  const merged = mergeIntervals(base);
  const cuts = mergeIntervals(holes);
  if (!cuts.length) return merged;
  const out: Interval[] = [];
  for (const [bs, be] of merged) {
    let start = bs;
    for (const [hs, he] of cuts) {
      if (he <= start || hs >= be) continue;
      if (hs > start) out.push([start, Math.min(hs, be)]);
      start = Math.max(start, he);
      if (start >= be) break;
    }
    if (start < be) out.push([start, be]);
  }
  return out.filter(([s, e]) => e > s);
}

/**
 * Circular standard deviation of clock times (minutes past midnight), in minutes.
 *
 * Plain standard deviation is wrong here: bedtimes of 23:50 and 00:10 are 20 minutes
 * apart, but numerically they're 1420 apart, which would report someone with a rock
 * solid schedule as wildly inconsistent.
 */
export function circularSdMinutes(minutesOfDay: readonly number[]): number | null {
  const v = finite(minutesOfDay);
  if (v.length < 2) return null;
  let sinSum = 0;
  let cosSum = 0;
  for (const m of v) {
    const a = (m / 1440) * Math.PI * 2;
    sinSum += Math.sin(a);
    cosSum += Math.cos(a);
  }
  const r = Math.sqrt(sinSum ** 2 + cosSum ** 2) / v.length;
  if (r >= 1) return 0;
  // Standard circular-SD formula, converted from radians back to minutes.
  const sdRad = Math.sqrt(-2 * Math.log(r));
  return (sdRad / (Math.PI * 2)) * 1440;
}
