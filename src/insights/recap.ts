/**
 * The weekly recap.
 *
 * A daily dashboard answers "what should I do today?". The recap answers the question
 * people actually care about over time — "is this working?" — which needs a week of
 * context and a comparison against the week before.
 */

import type { Model } from '../core/types';
import { duration, signed } from '../core/format';
import { formatDayLabel, isoWeekKey } from '../core/dates';
import { mean } from '../model/stats';
import { strainBand } from '../model/strain';
import { metricValue, type MetricKey } from '../model/build';
import { recordsSetOn, streaks } from './analytics';

export interface RecapMetric {
  key: MetricKey;
  label: string;
  value: number | null;
  previous: number | null;
  changePct: number | null;
  favourable: boolean | null;
  format: (v: number) => string;
}

export interface WeeklyRecap {
  weekKey: string;
  startDate: string;
  endDate: string;
  daysCovered: number;
  metrics: RecapMetric[];
  /** The single sentence that leads the recap. */
  headline: string;
  /** Two or three observations worth reading. */
  notes: string[];
  bestDay: { date: string; score: number } | null;
  hardestDay: { date: string; strain: number } | null;
  workouts: number;
  totalStrain: number;
}

const FORMATTERS: Partial<Record<MetricKey, (v: number) => string>> = {
  recovery: (v) => `${Math.round(v)}%`,
  strain: (v) => v.toFixed(1),
  hrv: (v) => `${Math.round(v)} ms`,
  rhr: (v) => `${Math.round(v)} bpm`,
  asleepMin: (v) => duration(v),
  sleepScore: (v) => `${Math.round(v)}%`,
};

const HIGHER_IS_BETTER: Partial<Record<MetricKey, boolean>> = {
  recovery: true,
  hrv: true,
  rhr: false,
  asleepMin: true,
  sleepScore: true,
};

/**
 * Builds a recap for the seven days ending at `endIndex`.
 * Returns null when there isn't a meaningful week to summarise.
 */
export function buildWeeklyRecap(model: Model, endIndex: number): WeeklyRecap | null {
  if (endIndex < 6 || endIndex >= model.days.length) return null;
  const days = model.days.slice(endIndex - 6, endIndex + 1);
  const priorDays = model.days.slice(Math.max(0, endIndex - 13), Math.max(0, endIndex - 6));
  if (days.length < 4) return null;

  const avg = (source: typeof days, key: MetricKey): number | null =>
    mean(source.map((d) => metricValue(d, key)));

  const metrics: RecapMetric[] = (
    ['recovery', 'strain', 'asleepMin', 'hrv', 'rhr'] as MetricKey[]
  ).map((key) => {
    const value = avg(days, key);
    const previous = priorDays.length >= 3 ? avg(priorDays, key) : null;
    const changePct =
      value != null && previous != null && previous !== 0
        ? ((value - previous) / Math.abs(previous)) * 100
        : null;
    const better = HIGHER_IS_BETTER[key];
    return {
      key,
      label: labelFor(key),
      value,
      previous,
      changePct,
      favourable: changePct == null || better == null ? null : better ? changePct > 0 : changePct < 0,
      format: FORMATTERS[key] ?? ((v: number) => v.toFixed(0)),
    };
  });

  let bestDay: WeeklyRecap['bestDay'] = null;
  let hardestDay: WeeklyRecap['hardestDay'] = null;
  let workouts = 0;
  let totalStrain = 0;

  for (const day of days) {
    const recovery = day.recovery.score;
    if (recovery != null && (!bestDay || recovery > bestDay.score)) {
      bestDay = { date: day.date, score: recovery };
    }
    if (day.strain.method !== 'none' && (!hardestDay || day.strain.score > hardestDay.strain)) {
      hardestDay = { date: day.date, strain: day.strain.score };
    }
    workouts += day.raw.workouts.length;
    totalStrain += day.strain.score;
  }

  return {
    weekKey: isoWeekKey(days[days.length - 1].date),
    startDate: days[0].date,
    endDate: days[days.length - 1].date,
    daysCovered: days.length,
    metrics,
    headline: buildHeadline(metrics, totalStrain, days.length),
    notes: buildNotes(model, endIndex, metrics, workouts, bestDay, hardestDay),
    bestDay,
    hardestDay,
    workouts,
    totalStrain,
  };
}

function labelFor(key: MetricKey): string {
  switch (key) {
    case 'recovery': return 'Avg recovery';
    case 'strain': return 'Avg strain';
    case 'asleepMin': return 'Avg sleep';
    case 'hrv': return 'Avg HRV';
    case 'rhr': return 'Avg resting HR';
    default: return key;
  }
}

/**
 * The lead sentence.
 * Names what changed rather than restating the numbers — the numbers are right there
 * in the grid underneath it.
 */
function buildHeadline(metrics: RecapMetric[], totalStrain: number, days: number): string {
  const recovery = metrics.find((m) => m.key === 'recovery');
  const sleep = metrics.find((m) => m.key === 'asleepMin');
  const avgStrain = totalStrain / Math.max(1, days);
  const load = strainBand(avgStrain);

  if (recovery?.changePct != null && recovery.changePct >= 6) {
    return `A week of building back — recovery averaged ${Math.round(recovery.value!)}%, up ${recovery.changePct.toFixed(0)}% on last week, against ${load} load.`;
  }
  if (recovery?.changePct != null && recovery.changePct <= -6) {
    return `A demanding week — recovery averaged ${Math.round(recovery.value!)}%, down ${Math.abs(recovery.changePct).toFixed(0)}% on last week at ${load} load.`;
  }
  if (sleep?.value != null && sleep.value < 400) {
    return `Sleep was the limiter this week — ${duration(sleep.value)} a night on average, at ${load} load.`;
  }
  if (recovery?.value != null) {
    return `A steady week — recovery held around ${Math.round(recovery.value)}% at ${load} load.`;
  }
  return `A ${load}-load week.`;
}

function buildNotes(
  model: Model,
  endIndex: number,
  metrics: RecapMetric[],
  workouts: number,
  bestDay: WeeklyRecap['bestDay'],
  hardestDay: WeeklyRecap['hardestDay'],
): string[] {
  const notes: string[] = [];

  const sleep = metrics.find((m) => m.key === 'asleepMin');
  if (sleep?.value != null && sleep.changePct != null && Math.abs(sleep.changePct) >= 8) {
    notes.push(
      `You slept ${duration(Math.abs(sleep.value - (sleep.previous ?? sleep.value)))} ` +
        `${sleep.changePct > 0 ? 'more' : 'less'} per night than the week before.`,
    );
  }

  const hrv = metrics.find((m) => m.key === 'hrv');
  if (hrv?.changePct != null && Math.abs(hrv.changePct) >= 6) {
    notes.push(
      `HRV averaged ${Math.round(hrv.value!)} ms, ${signed(hrv.changePct, 0, '%')} on last week — ` +
        `${hrv.changePct > 0 ? 'a sign the load is landing well' : 'worth watching if it continues'}.`,
    );
  }

  if (bestDay && hardestDay) {
    notes.push(
      `Your best day was ${formatDayLabel(bestDay.date)} at ${bestDay.score}% recovery; ` +
        `your hardest was ${formatDayLabel(hardestDay.date)} at ${hardestDay.strain.toFixed(1)} strain.`,
    );
  }

  if (workouts > 0) {
    notes.push(`${workouts} logged workout${workouts === 1 ? '' : 's'} across the week.`);
  }

  const found = streaks(model, endIndex);
  for (const streak of found.slice(0, 1)) {
    notes.push(`Running streak: ${streak.label}.`);
  }

  const records = recordsSetOn(model, endIndex);
  for (const record of records.slice(0, 1)) {
    notes.push(`You set a personal best for ${record.label.toLowerCase()} this week.`);
  }

  return notes.slice(0, 4);
}
