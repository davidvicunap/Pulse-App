/**
 * The parsing accumulator: raw Apple Health records → `DayRecord[]`.
 *
 * Deliberately separate from the worker so it can be unit-tested by feeding records in
 * directly, with no file, no zip and no `postMessage`. The worker's only job is to turn
 * bytes into calls on this class.
 *
 * Memory shape: bounded by the number of *days*, not the number of records. A 300MB
 * export with 8 million records collapses to a few hundred day buckets as it streams.
 */

import type { DateKey, DayRecord, SleepNight, Workout } from '../core/types';
import { HR_HISTOGRAM_BIN, HR_HISTOGRAM_BINS, HR_HISTOGRAM_MIN } from '../core/types';
import { addDays, dateKeyOf, parseHealthDate } from '../core/dates';
import { median, mergeIntervals, subtractIntervals, totalMinutes, type Interval } from '../model/stats';

/** Record types we extract. Anything else is skipped without allocating. */
export const WANTED_TYPES: Record<string, string> = {
  HKQuantityTypeIdentifierRestingHeartRate: 'rhr',
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: 'hrv',
  HKQuantityTypeIdentifierHeartRate: 'hr',
  HKQuantityTypeIdentifierRespiratoryRate: 'resp',
  HKQuantityTypeIdentifierOxygenSaturation: 'spo2',
  HKQuantityTypeIdentifierVO2Max: 'vo2max',
  HKQuantityTypeIdentifierBodyMass: 'bodyMass',
  HKQuantityTypeIdentifierBodyFatPercentage: 'bodyFat',
  HKQuantityTypeIdentifierWalkingHeartRateAverage: 'walkingHr',
  HKQuantityTypeIdentifierActiveEnergyBurned: 'energy',
  HKQuantityTypeIdentifierAppleExerciseTime: 'exercise',
  HKQuantityTypeIdentifierAppleStandTime: 'standTime',
  HKQuantityTypeIdentifierStepCount: 'steps',
  HKQuantityTypeIdentifierDistanceWalkingRunning: 'distance',
  HKCategoryTypeIdentifierSleepAnalysis: 'sleep',
  HKCategoryTypeIdentifierMindfulSession: 'mindful',
  HKCategoryTypeIdentifierAppleStandHour: 'standHour',
};

/** A single parsed record, as handed over by the worker's scanner. */
export interface RawRecord {
  type: string;
  startDate: string;
  endDate?: string;
  value?: string;
  sourceName?: string;
  unit?: string;
}

export interface RawWorkout {
  activityType: string;
  startDate: string;
  endDate?: string;
  duration?: string;
  durationUnit?: string;
  totalDistance?: string;
  totalDistanceUnit?: string;
  totalEnergyBurned?: string;
  sourceName?: string;
}

/** Values summed per day are tracked per source, so we can dedupe at finalize time. */
type BySource = Map<string, number>;

interface DayBucket {
  rhr: number[];
  hrv: number[];
  resp: number[];
  spo2: number[];
  vo2max: number[];
  bodyMass: number[];
  bodyFat: number[];
  walkingHr: number[];

  energy: BySource;
  exercise: BySource;
  steps: BySource;
  distance: BySource;
  standHours: Set<number>;
  mindfulMin: number;

  /** Max HR observed in each minute of the day. Lazily allocated. */
  hrMinutes: Int16Array | null;

  asleep: Interval[];
  inBed: Interval[];
  awake: Interval[];
  deep: Interval[];
  rem: Interval[];
  core: Interval[];
  sleepSources: Set<string>;

  workouts: Workout[];
}

function emptyBucket(): DayBucket {
  return {
    rhr: [], hrv: [], resp: [], spo2: [], vo2max: [], bodyMass: [], bodyFat: [], walkingHr: [],
    energy: new Map(), exercise: new Map(), steps: new Map(), distance: new Map(),
    standHours: new Set(), mindfulMin: 0,
    hrMinutes: null,
    asleep: [], inBed: [], awake: [], deep: [], rem: [], core: [], sleepSources: new Set(),
    workouts: [],
  };
}

/**
 * Picks the true daily total from per-source subtotals.
 *
 * Apple Health commonly holds the same steps from an iPhone *and* an Apple Watch, and
 * summing them roughly doubles the count. Apple's own Health app resolves this by
 * preferring the most capable source. We do the same: prefer a Watch, otherwise take
 * the single largest source total — never the sum.
 */
export function pickSourceTotal(bySource: BySource): number {
  if (bySource.size === 0) return 0;
  if (bySource.size === 1) return [...bySource.values()][0];
  let watchTotal = 0;
  let best = 0;
  for (const [source, total] of bySource) {
    if (/watch/i.test(source)) watchTotal = Math.max(watchTotal, total);
    if (total > best) best = total;
  }
  return watchTotal > 0 ? watchTotal : best;
}

export class HealthAccumulator {
  private days = new Map<DateKey, DayBucket>();
  /** Records seen, including ones we skipped — surfaced in the import summary. */
  recordsSeen = 0;
  recordsKept = 0;
  workoutsKept = 0;

  private bucket(key: DateKey): DayBucket {
    let b = this.days.get(key);
    if (!b) {
      b = emptyBucket();
      this.days.set(key, b);
    }
    return b;
  }

  addRecord(rec: RawRecord): void {
    this.recordsSeen++;
    const kind = WANTED_TYPES[rec.type];
    if (!kind || !rec.startDate) return;

    if (kind === 'sleep') {
      this.addSleep(rec);
      return;
    }
    if (kind === 'hr') {
      this.addHeartRate(rec);
      return;
    }
    if (kind === 'standHour') {
      // Value is `HKCategoryValueAppleStandHourStood` when the hour counted.
      if (rec.value && rec.value.includes('Stood')) {
        const key = dateKeyOf(rec.startDate);
        const hour = Number(rec.startDate.slice(11, 13));
        if (Number.isFinite(hour)) this.bucket(key).standHours.add(hour);
        this.recordsKept++;
      }
      return;
    }
    if (kind === 'mindful') {
      const start = parseHealthDate(rec.startDate);
      const end = rec.endDate ? parseHealthDate(rec.endDate) : NaN;
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        this.bucket(dateKeyOf(rec.startDate)).mindfulMin += (end - start) / 60_000;
        this.recordsKept++;
      }
      return;
    }

    const num = Number(rec.value);
    if (!Number.isFinite(num)) return;
    const key = dateKeyOf(rec.startDate);
    const b = this.bucket(key);
    const source = rec.sourceName || 'unknown';
    this.recordsKept++;

    switch (kind) {
      case 'rhr': b.rhr.push(num); break;
      case 'hrv': b.hrv.push(num); break;
      case 'resp': b.resp.push(num); break;
      // Apple stores oxygen saturation as a 0–1 fraction; some third parties use 0–100.
      case 'spo2': b.spo2.push(num <= 1 ? num * 100 : num); break;
      case 'vo2max': b.vo2max.push(num); break;
      case 'bodyMass': b.bodyMass.push(normaliseMass(num, rec.unit)); break;
      case 'bodyFat': b.bodyFat.push(num <= 1 ? num * 100 : num); break;
      case 'walkingHr': b.walkingHr.push(num); break;
      case 'energy': addTo(b.energy, source, normaliseEnergy(num, rec.unit)); break;
      case 'exercise': addTo(b.exercise, source, num); break;
      case 'steps': addTo(b.steps, source, num); break;
      case 'distance': addTo(b.distance, source, normaliseDistance(num, rec.unit)); break;
      case 'standTime': break; // superseded by standHour records
      default: break;
    }
  }

  /**
   * Heart-rate samples are bucketed into minute slots holding the **maximum** rate seen
   * in that minute. This does three jobs at once: it dedupes overlapping sources, it
   * bounds memory to 1440 slots per day regardless of sample count, and taking the max
   * keeps short high-intensity intervals from being averaged away.
   */
  private addHeartRate(rec: RawRecord): void {
    const bpm = Number(rec.value);
    if (!Number.isFinite(bpm) || bpm < 25 || bpm > 240) return;
    const key = dateKeyOf(rec.startDate);
    const hh = Number(rec.startDate.slice(11, 13));
    const mm = Number(rec.startDate.slice(14, 16));
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return;
    const slot = hh * 60 + mm;
    if (slot < 0 || slot >= 1440) return;
    const b = this.bucket(key);
    if (!b.hrMinutes) b.hrMinutes = new Int16Array(1440);
    if (bpm > b.hrMinutes[slot]) b.hrMinutes[slot] = Math.round(bpm);
    this.recordsKept++;
  }

  /**
   * Sleep is attributed to the **morning it ends on**, matching how people talk about
   * it ("I slept badly last night" is this morning's number). See `sleepDayKey` for why
   * that can't just be the end timestamp's calendar date. Intervals are stored raw and
   * merged at finalize, so overlapping records from multiple sources collapse rather
   * than accumulate.
   */
  private addSleep(rec: RawRecord): void {
    if (!rec.endDate || !rec.value) return;
    const start = parseHealthDate(rec.startDate);
    const end = parseHealthDate(rec.endDate);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    // Guard against corrupt records claiming a 30-hour sleep block.
    if (end - start > 20 * 3600_000) return;

    const b = this.bucket(sleepDayKey(rec.endDate));
    const interval: Interval = [start, end];
    const v = rec.value;
    b.sleepSources.add(rec.sourceName || 'unknown');
    this.recordsKept++;

    if (v.includes('InBed')) {
      b.inBed.push(interval);
      return;
    }
    if (v.includes('Awake')) {
      b.awake.push(interval);
      return;
    }
    // Everything else is a form of asleep: AsleepCore / AsleepDeep / AsleepREM /
    // AsleepUnspecified, plus the pre-iOS16 bare `HKCategoryValueSleepAnalysisAsleep`.
    b.asleep.push(interval);
    if (v.includes('Deep')) b.deep.push(interval);
    else if (v.includes('REM')) b.rem.push(interval);
    else if (v.includes('Core')) b.core.push(interval);
  }

  addWorkout(w: RawWorkout): void {
    if (!w.startDate) return;
    const start = parseHealthDate(w.startDate);
    if (!Number.isFinite(start)) return;
    let durationMin = Number(w.duration);
    if (!Number.isFinite(durationMin) || durationMin <= 0) {
      const end = w.endDate ? parseHealthDate(w.endDate) : NaN;
      durationMin = Number.isFinite(end) ? (end - start) / 60_000 : 0;
    } else if (w.durationUnit === 'sec') {
      durationMin = durationMin / 60;
    } else if (w.durationUnit === 'hr') {
      durationMin = durationMin * 60;
    }
    if (durationMin <= 0 || durationMin > 24 * 60) return;

    const distance = Number(w.totalDistance);
    const energy = Number(w.totalEnergyBurned);
    const workout: Workout = {
      type: prettyActivity(w.activityType),
      startMs: start,
      durationMin,
      energyKcal: Number.isFinite(energy) && energy > 0 ? energy : null,
      distanceKm: Number.isFinite(distance) && distance > 0
        ? normaliseDistance(distance, w.totalDistanceUnit)
        : null,
    };
    this.bucket(dateKeyOf(w.startDate)).workouts.push(workout);
    this.lastWorkout = workout;
    this.workoutsKept++;
  }

  private lastWorkout: Workout | null = null;

  /**
   * Applies a `<WorkoutStatistics>` child to the workout that opened it.
   *
   * iOS 16+ moved workout totals out of attributes and into these children, so on a
   * modern export the `totalDistance` attribute is often absent entirely. Existing
   * attribute values win — they're the authoritative summary when both are present.
   */
  applyWorkoutStatistic(type: string, sum: number, unit: string | undefined): void {
    const w = this.lastWorkout;
    if (!w || !Number.isFinite(sum) || sum <= 0) return;
    if (type === 'HKQuantityTypeIdentifierActiveEnergyBurned' && w.energyKcal == null) {
      w.energyKcal = normaliseEnergy(sum, unit);
    } else if (/Distance/.test(type) && w.distanceKm == null) {
      w.distanceKm = normaliseDistance(sum, unit);
    }
  }

  get dayCount(): number {
    return this.days.size;
  }

  /** Collapses the accumulated buckets into the storable daily model. */
  finalize(): DayRecord[] {
    const out: DayRecord[] = [];
    for (const [date, b] of this.days) {
      out.push({
        date,
        rhr: median(b.rhr),
        hrv: median(b.hrv),
        respiratoryRate: median(b.resp),
        spo2: median(b.spo2),
        vo2max: median(b.vo2max),
        bodyMassKg: median(b.bodyMass),
        bodyFatPct: median(b.bodyFat),
        walkingHrAvg: median(b.walkingHr),

        activeEnergy: Math.round(pickSourceTotal(b.energy)),
        exerciseMinutes: Math.round(pickSourceTotal(b.exercise)),
        steps: Math.round(pickSourceTotal(b.steps)),
        distanceKm: round(pickSourceTotal(b.distance), 2),
        standHours: b.standHours.size,
        mindfulMinutes: Math.round(b.mindfulMin),

        ...summariseHeartRate(b.hrMinutes),
        sleep: summariseSleep(b),
        workouts: b.workouts.sort((x, y) => x.startMs - y.startMs),
      });
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
}

function summariseHeartRate(
  hrMinutes: Int16Array | null,
): Pick<DayRecord, 'hrHistogram' | 'hrMinutesCovered' | 'maxHr'> {
  if (!hrMinutes) return { hrHistogram: null, hrMinutesCovered: 0, maxHr: null };
  const hist = new Array<number>(HR_HISTOGRAM_BINS).fill(0);
  let covered = 0;
  let maxHr = 0;
  for (let i = 0; i < 1440; i++) {
    const bpm = hrMinutes[i];
    if (bpm <= 0) continue;
    covered++;
    if (bpm > maxHr) maxHr = bpm;
    const bin = Math.min(
      HR_HISTOGRAM_BINS - 1,
      Math.max(0, Math.floor((bpm - HR_HISTOGRAM_MIN) / HR_HISTOGRAM_BIN)),
    );
    hist[bin]++;
  }
  if (!covered) return { hrHistogram: null, hrMinutesCovered: 0, maxHr: null };
  return { hrHistogram: hist, hrMinutesCovered: covered, maxHr };
}

function summariseSleep(b: DayBucket): SleepNight | null {
  if (!b.asleep.length && !b.inBed.length) return null;

  // Awake blocks recorded inside the window are removed from asleep time — without
  // this, a night with three logged wake-ups reads as unbroken sleep.
  const asleepIntervals = subtractIntervals(b.asleep, b.awake);
  const asleepMin = totalMinutes(asleepIntervals);
  if (asleepMin <= 0 && !b.inBed.length) return null;

  const inBedMerged = mergeIntervals(b.inBed);
  const inBedMin = inBedMerged.length ? totalMinutes(inBedMerged) : null;

  const allIntervals = mergeIntervals([...b.asleep, ...b.inBed, ...b.awake]);
  const bedStartMs = allIntervals.length ? allIntervals[0][0] : 0;
  const wakeEndMs = allIntervals.length ? allIntervals[allIntervals.length - 1][1] : 0;

  const firstAsleep = mergeIntervals(asleepIntervals)[0]?.[0] ?? null;
  const latencyMin =
    inBedMerged.length && firstAsleep != null
      ? Math.max(0, (firstAsleep - inBedMerged[0][0]) / 60_000)
      : null;

  // Only count awake blocks that fall inside the sleep window as interruptions —
  // an `Awake` record from before bed isn't an interruption.
  const interruptions = mergeIntervals(b.awake).filter(
    ([s, e]) => s > bedStartMs && e < wakeEndMs,
  ).length;

  return {
    asleepMin: round(asleepMin, 1),
    inBedMin: inBedMin == null ? null : round(inBedMin, 1),
    deepMin: round(totalMinutes(subtractIntervals(b.deep, b.awake)), 1),
    remMin: round(totalMinutes(subtractIntervals(b.rem, b.awake)), 1),
    coreMin: round(totalMinutes(subtractIntervals(b.core, b.awake)), 1),
    awakeMin: round(totalMinutes(b.awake), 1),
    bedStartMs,
    wakeEndMs,
    latencyMin: latencyMin == null ? null : round(latencyMin, 1),
    efficiency: inBedMin && inBedMin > 0 ? Math.min(1, round(asleepMin / inBedMin, 3)) : null,
    interruptions,
    sourceCount: b.sleepSources.size,
  };
}

/**
 * Which night a sleep record belongs to.
 *
 * Naively keying on the end timestamp's date splits every night in two: the stage
 * blocks between going to bed and midnight end on the *previous* calendar day, so a
 * single night would be reported as two short nights on consecutive days.
 *
 * The rule: a sleep block that ends in the evening is part of the night that finishes
 * the following morning; anything else belongs to the day it ends on. `EVENING_CUTOFF`
 * also keeps afternoon naps attached to the correct day.
 */
export const EVENING_CUTOFF_HOUR = 18;

export function sleepDayKey(endTimestamp: string): DateKey {
  const key = dateKeyOf(endTimestamp);
  const hour = Number(endTimestamp.slice(11, 13));
  if (Number.isFinite(hour) && hour >= EVENING_CUTOFF_HOUR) return addDays(key, 1);
  return key;
}

function addTo(map: BySource, source: string, value: number): void {
  if (!Number.isFinite(value)) return;
  map.set(source, (map.get(source) ?? 0) + value);
}

function normaliseEnergy(value: number, unit?: string): number {
  // Apple writes kcal (`Cal`); some third parties write kilojoules.
  if (unit && /kJ/i.test(unit)) return value / 4.184;
  return value;
}

function normaliseDistance(value: number, unit?: string): number {
  if (!unit) return value;
  if (/^mi$/i.test(unit)) return value * 1.609344;
  if (/^m$/i.test(unit)) return value / 1000;
  if (/^ft$/i.test(unit)) return value * 0.0003048;
  return value; // km
}

function normaliseMass(value: number, unit?: string): number {
  if (!unit) return value;
  if (/lb/i.test(unit)) return value * 0.45359237;
  if (/^g$/i.test(unit)) return value / 1000;
  if (/st/i.test(unit)) return value * 6.35029318;
  return value; // kg
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** `HKWorkoutActivityTypeHighIntensityIntervalTraining` → `High Intensity Interval Training` */
export function prettyActivity(raw: string): string {
  if (!raw) return 'Workout';
  const stripped = raw.replace(/^HKWorkoutActivityType/, '');
  const spaced = stripped.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced || 'Workout';
}
