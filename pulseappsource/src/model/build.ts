/**
 * Model assembly: `DayRecord[]` (+ settings) → `Model`.
 *
 * This is the one place where per-day metrics get stitched into a timeline. It is pure
 * — same input, same output, no clock, no storage — which is what makes the whole
 * metrics layer testable without fixtures or mocks.
 */

import type {
  DateKey,
  DayRecord,
  DerivedDay,
  Model,
  Profile,
  SleepNight,
  UserSettings,
} from '../core/types';
import { buildBaseline, SD_FLOORS } from './baselines';
import { computeRecovery } from './recovery';
import { computeSleep, deriveSleepNeed, DEFAULT_SLEEP_NEED } from './sleep';
import {
  computeStrain,
  deriveReference,
  MIN_HR_COVERAGE,
  proxyLoad,
  zoneLoad,
  zonesFromHistogram,
} from './strain';
import { median, percentile } from './stats';

/** Nights considered when computing debt/consistency for a given day. */
const SLEEP_WINDOW = 14;

/**
 * Fallback max heart rate when we can't observe one.
 * The classic `220 − age` is used when the user has given a birth year; otherwise we
 * take the highest heart rate actually recorded, which for anyone who has ever run for
 * a bus is a better estimate than a population average.
 */
export function estimateMaxHr(
  days: readonly DayRecord[],
  settings: Pick<UserSettings, 'maxHr' | 'birthYear'>,
  currentYear: number,
): { maxHr: number; userSet: boolean } {
  if (settings.maxHr && settings.maxHr > 100) return { maxHr: settings.maxHr, userSet: true };
  if (settings.birthYear && settings.birthYear > 1900) {
    const age = currentYear - settings.birthYear;
    if (age > 5 && age < 110) return { maxHr: Math.round(220 - age), userSet: true };
  }
  const observed = days.map((d) => d.maxHr).filter((v): v is number => v != null && v > 100);
  // p99 rather than the raw maximum: a single spurious 210bpm sample from a loose strap
  // would otherwise widen every zone for the entire history.
  const p99 = percentile(observed, 0.99);
  if (p99 && p99 > 120) return { maxHr: Math.round(p99), userSet: false };
  return { maxHr: 185, userSet: false };
}

export function buildProfile(
  days: readonly DayRecord[],
  settings: UserSettings,
  currentYear = new Date().getFullYear(),
): Profile {
  const asleep = days.map((d) => d.sleep?.asleepMin ?? null).filter((v): v is number => v != null);
  const sleepNeedMin =
    settings.sleepNeedMin && settings.sleepNeedMin > 0
      ? settings.sleepNeedMin
      : asleep.length
        ? deriveSleepNeed(asleep)
        : DEFAULT_SLEEP_NEED;

  const { maxHr, userSet } = estimateMaxHr(days, settings, currentYear);
  const restingHr = median(days.map((d) => d.rhr)) ?? 60;

  // References are derived from the whole dataset so the strain scale is stable as you
  // page through history — a day shouldn't change its score because you imported more.
  const zoneLoads: number[] = [];
  const proxyLoads: number[] = [];
  for (const d of days) {
    if (d.hrHistogram && d.hrMinutesCovered >= MIN_HR_COVERAGE) {
      zoneLoads.push(zoneLoad(zonesFromHistogram(d.hrHistogram, Math.round(restingHr), maxHr)));
    }
    proxyLoads.push(proxyLoad(d.activeEnergy, d.exerciseMinutes));
  }

  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    sleepNeedMin,
    maxHr,
    restingHr: Math.round(restingHr),
    maxHrIsUserSet: userSet,
    strainRefZones: deriveReference(zoneLoads, 'zones'),
    strainRefProxy: deriveReference(proxyLoads, 'proxy'),
    daysWithData: days.length,
    firstDate: sorted.length ? sorted[0].date : null,
    lastDate: sorted.length ? sorted[sorted.length - 1].date : null,
  };
}

/**
 * Builds the full derived timeline.
 * `days` may arrive in any order; the result is always sorted oldest → newest.
 */
export function buildModel(days: readonly DayRecord[], settings: UserSettings): Model {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const profile = buildProfile(sorted, settings);

  // Rolling observation buffers. Each day is scored against *prior* days only, so a
  // day is never part of the baseline it's compared to.
  const hrvHistory: (number | null)[] = [];
  const rhrHistory: (number | null)[] = [];
  const respHistory: (number | null)[] = [];
  const nightHistory: (SleepNight | null)[] = [];

  const derived: DerivedDay[] = [];

  for (const raw of sorted) {
    const hrvBaseline = buildBaseline(hrvHistory, SD_FLOORS.hrv);
    const rhrBaseline = buildBaseline(rhrHistory, SD_FLOORS.rhr);
    const respiratoryBaseline = buildBaseline(respHistory, SD_FLOORS.respiratoryRate);

    const recovery = computeRecovery({
      hrv: raw.hrv,
      rhr: raw.rhr,
      respiratoryRate: raw.respiratoryRate,
      asleepMin: raw.sleep?.asleepMin ?? null,
      hrvBaseline,
      rhrBaseline,
      respiratoryBaseline,
      sleepNeedMin: profile.sleepNeedMin,
    });

    const strain = computeStrain({
      zoneMinutes: raw.hrHistogram
        ? zonesFromHistogram(raw.hrHistogram, profile.restingHr, profile.maxHr)
        : null,
      hrMinutesCovered: raw.hrMinutesCovered,
      activeEnergy: raw.activeEnergy,
      exerciseMinutes: raw.exerciseMinutes,
      referenceZones: profile.strainRefZones,
      referenceProxy: profile.strainRefProxy,
    });

    const sleep = computeSleep({
      night: raw.sleep,
      needMin: profile.sleepNeedMin,
      recentNights: [...nightHistory.slice(-(SLEEP_WINDOW - 1)), raw.sleep],
    });

    derived.push({
      date: raw.date,
      raw,
      recovery,
      strain,
      sleep,
      baselines: { hrv: hrvBaseline, rhr: rhrBaseline, respiratoryRate: respiratoryBaseline },
    });

    hrvHistory.push(raw.hrv);
    rhrHistory.push(raw.rhr);
    respHistory.push(raw.respiratoryRate);
    nightHistory.push(raw.sleep);
  }

  const byDate = new Map<DateKey, DerivedDay>();
  for (const d of derived) byDate.set(d.date, d);

  return { days: derived, byDate, profile };
}

/** Index of the most recent day that has a recovery score; -1 when none do. */
export function latestScoredIndex(model: Model): number {
  for (let i = model.days.length - 1; i >= 0; i--) {
    if (model.days[i].recovery.score != null) return i;
  }
  return model.days.length - 1;
}

/** Convenience accessor used across the UI and insight layers. */
export type MetricKey =
  | 'recovery'
  | 'strain'
  | 'sleepScore'
  | 'asleepMin'
  | 'hrv'
  | 'rhr'
  | 'respiratoryRate'
  | 'steps'
  | 'activeEnergy'
  | 'spo2'
  | 'efficiency'
  | 'debtMin';

export function metricValue(day: DerivedDay, key: MetricKey): number | null {
  switch (key) {
    case 'recovery':
      return day.recovery.score;
    case 'strain':
      return day.strain.method === 'none' ? null : day.strain.score;
    case 'sleepScore':
      return day.sleep.score;
    case 'asleepMin':
      return day.raw.sleep?.asleepMin ?? null;
    case 'hrv':
      return day.raw.hrv;
    case 'rhr':
      return day.raw.rhr;
    case 'respiratoryRate':
      return day.raw.respiratoryRate;
    case 'steps':
      return day.raw.steps || null;
    case 'activeEnergy':
      return day.raw.activeEnergy || null;
    case 'spo2':
      return day.raw.spo2;
    case 'efficiency':
      return day.raw.sleep?.efficiency == null ? null : day.raw.sleep.efficiency * 100;
    case 'debtMin':
      return day.sleep.debtMin;
    default:
      return null;
  }
}

export interface MetricMeta {
  key: MetricKey;
  label: string;
  unit: string;
  /** Whether a higher value is the desirable direction. */
  higherIsBetter: boolean;
  decimals: number;
  color: string;
}

export const METRIC_META: Record<MetricKey, MetricMeta> = {
  recovery: { key: 'recovery', label: 'Recovery', unit: '%', higherIsBetter: true, decimals: 0, color: 'var(--vital)' },
  strain: { key: 'strain', label: 'Strain', unit: '', higherIsBetter: true, decimals: 1, color: 'var(--cardio)' },
  sleepScore: { key: 'sleepScore', label: 'Sleep score', unit: '%', higherIsBetter: true, decimals: 0, color: 'var(--somnus)' },
  asleepMin: { key: 'asleepMin', label: 'Time asleep', unit: 'h', higherIsBetter: true, decimals: 1, color: 'var(--somnus)' },
  hrv: { key: 'hrv', label: 'HRV', unit: 'ms', higherIsBetter: true, decimals: 0, color: 'var(--phosphor)' },
  rhr: { key: 'rhr', label: 'Resting HR', unit: 'bpm', higherIsBetter: false, decimals: 0, color: 'var(--rose)' },
  respiratoryRate: { key: 'respiratoryRate', label: 'Respiratory rate', unit: 'br/min', higherIsBetter: false, decimals: 1, color: 'var(--caution)' },
  steps: { key: 'steps', label: 'Steps', unit: '', higherIsBetter: true, decimals: 0, color: 'var(--cardio)' },
  activeEnergy: { key: 'activeEnergy', label: 'Active energy', unit: 'kcal', higherIsBetter: true, decimals: 0, color: 'var(--cardio)' },
  spo2: { key: 'spo2', label: 'Blood oxygen', unit: '%', higherIsBetter: true, decimals: 1, color: 'var(--phosphor)' },
  efficiency: { key: 'efficiency', label: 'Sleep efficiency', unit: '%', higherIsBetter: true, decimals: 0, color: 'var(--somnus)' },
  debtMin: { key: 'debtMin', label: 'Sleep debt', unit: 'h', higherIsBetter: false, decimals: 1, color: 'var(--alert)' },
};

/** Extracts a metric series aligned to `model.days`, with nulls preserved as gaps. */
export function series(model: Model, key: MetricKey): (number | null)[] {
  return model.days.map((d) => metricValue(d, key));
}
