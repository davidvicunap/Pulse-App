/**
 * Analytics: the derived facts insights are built from.
 *
 * Kept separate from the insight engine so the *statistics* are testable independently
 * of the *copy*. Everything here is pure and returns `null` rather than guessing when
 * there isn't enough data — an insight based on four days is worse than no insight.
 */

import type { DerivedDay, Model } from '../core/types';
import { METRIC_META, metricValue, type MetricKey } from '../model/build';
import { isWeekend } from '../core/dates';
import { linearFit, mean, pearson, stdDev } from '../model/stats';

/** Minimum paired observations before we'll report a correlation. */
export const MIN_CORRELATION_N = 14;

export interface Trend {
  key: MetricKey;
  label: string;
  current: number;
  previous: number;
  changePct: number;
  direction: 'up' | 'down' | 'flat';
  /** True when the change is both large enough and in a well-populated window. */
  significant: boolean;
  /** Whether the direction is good for this metric. */
  favourable: boolean;
  windowDays: number;
}

/**
 * Compares the trailing `window` days against the `window` before that.
 * `endIndex` is inclusive, so trends are always computed as of the day being viewed
 * rather than as of the newest data.
 */
export function trendOf(
  model: Model,
  key: MetricKey,
  endIndex: number,
  window = 7,
): Trend | null {
  const current = windowMean(model, key, endIndex - window + 1, endIndex);
  const previous = windowMean(model, key, endIndex - window * 2 + 1, endIndex - window);
  if (current == null || previous == null || previous.value === 0) return null;

  const changePct = ((current.value - previous.value) / Math.abs(previous.value)) * 100;
  const meta = METRIC_META[key];
  const direction = Math.abs(changePct) < 2 ? 'flat' : changePct > 0 ? 'up' : 'down';
  const favourable = meta.higherIsBetter ? changePct > 0 : changePct < 0;

  return {
    key,
    label: meta.label,
    current: current.value,
    previous: previous.value,
    changePct,
    direction,
    // Require both a meaningful move and enough days on each side to trust it.
    significant: Math.abs(changePct) >= 5 && current.n >= window * 0.6 && previous.n >= window * 0.6,
    favourable,
    windowDays: window,
  };
}

function windowMean(
  model: Model,
  key: MetricKey,
  from: number,
  to: number,
): { value: number; n: number } | null {
  const values: number[] = [];
  for (let i = Math.max(0, from); i <= Math.min(model.days.length - 1, to); i++) {
    const v = metricValue(model.days[i], key);
    if (v != null && Number.isFinite(v)) values.push(v);
  }
  if (values.length < 2) return null;
  return { value: mean(values)!, n: values.length };
}

export interface Streak {
  kind: 'recovery-high' | 'recovery-low' | 'sleep-met' | 'workout' | 'rest';
  length: number;
  label: string;
}

/** Current run lengths ending at `endIndex`. Streaks are what make habits visible. */
export function streaks(model: Model, endIndex: number): Streak[] {
  const out: Streak[] = [];
  const days = model.days;

  const run = (test: (d: DerivedDay) => boolean | null): number => {
    let n = 0;
    for (let i = endIndex; i >= 0; i--) {
      const result = test(days[i]);
      if (result === null) continue; // unknown days don't break a streak
      if (!result) break;
      n++;
    }
    return n;
  };

  const highRecovery = run((d) => (d.recovery.score == null ? null : d.recovery.score >= 67));
  if (highRecovery >= 3) {
    out.push({ kind: 'recovery-high', length: highRecovery, label: `${highRecovery} days primed` });
  }

  const lowRecovery = run((d) => (d.recovery.score == null ? null : d.recovery.score < 34));
  if (lowRecovery >= 2) {
    out.push({ kind: 'recovery-low', length: lowRecovery, label: `${lowRecovery} days in the red` });
  }

  const sleepMet = run((d) =>
    d.raw.sleep == null ? null : d.raw.sleep.asleepMin >= d.sleep.needMin,
  );
  if (sleepMet >= 3) {
    out.push({ kind: 'sleep-met', length: sleepMet, label: `${sleepMet} nights at need` });
  }

  const training = run((d) => d.raw.workouts.length > 0 || d.strain.score >= 10);
  if (training >= 3) {
    out.push({ kind: 'workout', length: training, label: `${training} days training` });
  }

  return out;
}

export interface PersonalRecord {
  key: MetricKey;
  label: string;
  value: number;
  date: string;
  /** How many days of history the record stands against. */
  outOf: number;
  kind: 'best' | 'worst';
}

/**
 * Records set *on* `endIndex`, checked against all prior history.
 * Only reported once there's a month of history — a "record" on day three is noise.
 */
export function recordsSetOn(model: Model, endIndex: number): PersonalRecord[] {
  if (endIndex < 30) return [];
  const out: PersonalRecord[] = [];
  const day = model.days[endIndex];

  const check = (key: MetricKey, kind: 'best' | 'worst') => {
    const value = metricValue(day, key);
    if (value == null) return;
    const meta = METRIC_META[key];
    const wantHigh = kind === 'best' ? meta.higherIsBetter : !meta.higherIsBetter;
    let beaten = 0;
    for (let i = 0; i < endIndex; i++) {
      const prior = metricValue(model.days[i], key);
      if (prior == null) continue;
      beaten++;
      if (wantHigh ? prior >= value : prior <= value) return; // not a record
    }
    if (beaten < 25) return;
    out.push({ key, label: meta.label, value, date: day.date, outOf: beaten, kind });
  };

  check('hrv', 'best');
  check('recovery', 'best');
  check('strain', 'best');
  check('asleepMin', 'best');
  check('rhr', 'best');
  return out;
}

export interface Comparison {
  label: string;
  groupA: { label: string; mean: number; n: number };
  groupB: { label: string; mean: number; n: number };
  deltaPct: number;
  /** A rough effect size — the difference in pooled standard deviations. */
  effectSize: number;
  meaningful: boolean;
}

/** Splits the visible days in two and compares a metric across the split. */
export function compareGroups(
  days: readonly DerivedDay[],
  key: MetricKey,
  split: (day: DerivedDay, index: number) => boolean | null,
  labels: [string, string],
): Comparison | null {
  const a: number[] = [];
  const b: number[] = [];
  days.forEach((day, i) => {
    const value = metricValue(day, key);
    if (value == null) return;
    const side = split(day, i);
    if (side === null) return;
    (side ? a : b).push(value);
  });
  if (a.length < 4 || b.length < 4) return null;

  const meanA = mean(a)!;
  const meanB = mean(b)!;
  const sdA = stdDev(a) ?? 0;
  const sdB = stdDev(b) ?? 0;
  const pooled = Math.sqrt((sdA ** 2 + sdB ** 2) / 2) || 1;
  const effectSize = Math.abs(meanA - meanB) / pooled;

  return {
    label: METRIC_META[key].label,
    groupA: { label: labels[0], mean: meanA, n: a.length },
    groupB: { label: labels[1], mean: meanB, n: b.length },
    deltaPct: meanB === 0 ? 0 : ((meanA - meanB) / Math.abs(meanB)) * 100,
    effectSize,
    // Cohen's d of 0.5 is the conventional "medium effect" line.
    meaningful: effectSize >= 0.5,
  };
}

/** Weekday vs weekend, workout days vs rest days — the two comparisons that pay off. */
export function standardComparisons(days: readonly DerivedDay[], key: MetricKey): Comparison[] {
  const out: Comparison[] = [];
  const weekday = compareGroups(days, key, (d) => !isWeekend(d.date), ['Weekdays', 'Weekends']);
  if (weekday) out.push(weekday);

  const training = compareGroups(
    days,
    key,
    (d) => (d.strain.method === 'none' ? null : d.strain.score >= 10),
    ['Training days', 'Rest days'],
  );
  if (training) out.push(training);

  return out;
}

export interface Correlation {
  xKey: MetricKey;
  yKey: MetricKey;
  xLabel: string;
  yLabel: string;
  /** Days `y` lags `x` — 1 means "tonight's sleep vs tomorrow's recovery". */
  lag: number;
  r: number;
  n: number;
  slope: number;
  intercept: number;
  strength: 'none' | 'weak' | 'moderate' | 'strong';
  points: Array<{ x: number; y: number; date: string }>;
}

/**
 * Correlates two metrics, optionally with a lag.
 *
 * The lag is the whole point for health data: sleep doesn't correlate with the same
 * night's recovery, it correlates with the *next day's*. Comparing them same-day would
 * find nothing and wrongly suggest sleep doesn't matter.
 */
export function correlate(
  model: Model,
  xKey: MetricKey,
  yKey: MetricKey,
  lag = 0,
  fromIndex = 0,
): Correlation | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const points: Array<{ x: number; y: number; date: string }> = [];

  for (let i = Math.max(0, fromIndex); i < model.days.length - lag; i++) {
    const x = metricValue(model.days[i], xKey);
    const y = metricValue(model.days[i + lag], yKey);
    if (x == null || y == null) continue;
    xs.push(x);
    ys.push(y);
    points.push({ x, y, date: model.days[i].date });
  }

  if (xs.length < MIN_CORRELATION_N) return null;
  const r = pearson(xs, ys);
  if (r == null) return null;
  const fit = linearFit(xs, ys);
  if (!fit) return null;

  const abs = Math.abs(r);
  return {
    xKey,
    yKey,
    xLabel: METRIC_META[xKey].label,
    yLabel: METRIC_META[yKey].label,
    lag,
    r,
    n: xs.length,
    slope: fit.slope,
    intercept: fit.intercept,
    strength: abs < 0.2 ? 'none' : abs < 0.4 ? 'weak' : abs < 0.6 ? 'moderate' : 'strong',
    points,
  };
}

/**
 * Turns a correlation into a sentence a person can act on.
 *
 * Deliberately phrased as association, never causation — "nights under 7h are followed
 * by lower recovery" rather than "short sleep causes low recovery". The data supports
 * the first claim and not the second.
 */
export function describeCorrelation(c: Correlation): string {
  if (c.strength === 'none') {
    return `No clear relationship between ${c.xLabel.toLowerCase()} and ${c.yLabel.toLowerCase()} in this period.`;
  }
  const direction = c.r > 0 ? 'higher' : 'lower';
  const when = c.lag > 0 ? 'the next day' : 'the same day';
  return (
    `${c.strength === 'strong' ? 'Strongly' : c.strength === 'moderate' ? 'Consistently' : 'Loosely'} ` +
    `linked: better ${c.xLabel.toLowerCase()} goes with ${direction} ${c.yLabel.toLowerCase()} ${when} ` +
    `(r = ${c.r.toFixed(2)} across ${c.n} days).`
  );
}

/**
 * The headline finding: for a threshold on `x`, how much does `y` differ?
 * This is what turns "r = 0.42" into "nights under 7h → recovery drops 15%".
 */
export function thresholdEffect(
  c: Correlation,
  threshold: number,
): { below: number; above: number; deltaPct: number; nBelow: number; nAbove: number } | null {
  const below = c.points.filter((p) => p.x < threshold).map((p) => p.y);
  const above = c.points.filter((p) => p.x >= threshold).map((p) => p.y);
  if (below.length < 3 || above.length < 3) return null;
  const mBelow = mean(below)!;
  const mAbove = mean(above)!;
  return {
    below: mBelow,
    above: mAbove,
    deltaPct: mAbove === 0 ? 0 : ((mBelow - mAbove) / Math.abs(mAbove)) * 100,
    nBelow: below.length,
    nAbove: above.length,
  };
}
