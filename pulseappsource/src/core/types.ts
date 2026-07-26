/**
 * The shared data model.
 *
 * The contract that matters here: everything downstream of the parser works on
 * `DayRecord[]` — a compact, per-day summary — and never on raw Apple Health records.
 * That is what lets a 300MB export collapse into a few hundred KB in IndexedDB, and it
 * is why the metrics layer can be pure and unit-tested without any fixtures larger
 * than a handful of objects.
 */

/** `YYYY-MM-DD` in the user's local calendar, as recorded by the device. */
export type DateKey = string;

export interface SleepNight {
  /** Total asleep minutes, overlapping intervals merged (never double-counted). */
  asleepMin: number;
  /** Time in bed, if the export records `InBed` (some sources don't). */
  inBedMin: number | null;
  deepMin: number;
  remMin: number;
  coreMin: number;
  /** Awake time recorded *within* the sleep window. */
  awakeMin: number;
  /** Epoch ms of first sleep-related record for the night. */
  bedStartMs: number;
  /** Epoch ms of the final wake. */
  wakeEndMs: number;
  /** Minutes between getting into bed and falling asleep. Null without `InBed` data. */
  latencyMin: number | null;
  /** asleep / inBed, 0..1. Null without `InBed` data. */
  efficiency: number | null;
  /** Count of distinct awake blocks inside the sleep window. */
  interruptions: number;
  /** How many sources contributed — used to flag possible double counting. */
  sourceCount: number;
}

/** Minutes spent in each of the five heart-rate-reserve zones, index 0 = Zone 1. */
export type ZoneMinutes = [number, number, number, number, number];

/** Lowest heart rate the histogram tracks; anything lower lands in bin 0. */
export const HR_HISTOGRAM_MIN = 30;
/** Width of each histogram bucket, in bpm. */
export const HR_HISTOGRAM_BIN = 5;
/** Number of buckets — covers 30–219 bpm, with faster rates clamped into the last. */
export const HR_HISTOGRAM_BINS = 38;

export interface Workout {
  /** Human-readable activity, already stripped of the `HKWorkoutActivityType` prefix. */
  type: string;
  startMs: number;
  durationMin: number;
  energyKcal: number | null;
  distanceKm: number | null;
}

/**
 * One calendar day of summarised health data. Produced by the parser, stored in
 * IndexedDB, and consumed by the (pure) metrics layer.
 */
export interface DayRecord {
  date: DateKey;

  // — Vitals (daily median of all samples) —
  rhr: number | null;
  hrv: number | null;
  respiratoryRate: number | null;
  spo2: number | null;
  vo2max: number | null;
  bodyMassKg: number | null;
  bodyFatPct: number | null;
  walkingHrAvg: number | null;

  // — Activity —
  activeEnergy: number;
  exerciseMinutes: number;
  steps: number;
  standHours: number;
  distanceKm: number;
  mindfulMinutes: number;

  // — Heart rate —
  /**
   * Minutes spent at each heart rate, bucketed into 5bpm bins from 30bpm
   * (`HR_HISTOGRAM_MIN`) upward. Null when the day has no heart-rate samples.
   *
   * We store the histogram rather than pre-computed zone minutes so that zones can be
   * recomputed instantly when the user corrects their max heart rate in Settings —
   * without re-importing a 300MB file. It costs 38 numbers per day.
   */
  hrHistogram: number[] | null;
  /** How many distinct minutes had at least one HR sample. Drives confidence. */
  hrMinutesCovered: number;
  maxHr: number | null;

  sleep: SleepNight | null;
  workouts: Workout[];
}

/** Per-metric baseline with the evidence behind it, so the UI can be honest. */
export interface Baseline {
  /** Exponentially-weighted mean of recent observations. */
  mean: number;
  /** Standard deviation of the same window, floored to avoid divide-by-noise. */
  sd: number;
  /** Number of observations that fed the baseline. */
  n: number;
  /** 0..1. Below `MIN_CONFIDENCE` the UI shows a low-confidence state instead. */
  confidence: number;
}

/** One weighted input to a composite score, kept so the UI can explain the number. */
export interface ScoreComponent {
  key: string;
  label: string;
  /** The raw measured value (e.g. 48 ms). */
  value: number;
  /** What we compared it against. */
  baseline: number | null;
  /** 0..1 sub-score this component contributed. */
  score: number;
  /** Share of the final score, after renormalising for missing inputs. 0..1. */
  weight: number;
  /** Plain-language explanation of this component's effect. */
  detail: string;
}

export interface RecoveryResult {
  /** 1..99, or null when no component had data. */
  score: number | null;
  band: 'low' | 'moderate' | 'high';
  components: ScoreComponent[];
  confidence: number;
  /** Applied multiplier from secondary signals (e.g. elevated respiratory rate). */
  modifier: number;
  modifierReason: string | null;
}

export type StrainMethod = 'hr-zones' | 'energy-proxy' | 'none';

export interface StrainResult {
  /** 0..21. */
  score: number;
  method: StrainMethod;
  /** Raw cardiovascular load before curve mapping. */
  load: number;
  /** The personal reference load that maps to 21. */
  reference: number;
  zoneMinutes: ZoneMinutes | null;
  confidence: number;
  components: ScoreComponent[];
}

export interface SleepResult {
  /** 0..100 performance against personal need. */
  score: number | null;
  asleepMin: number;
  needMin: number;
  /** Positive = slept less than needed, in minutes, accumulated over 14 days. */
  debtMin: number;
  efficiency: number | null;
  latencyMin: number | null;
  /** Standard deviation of bed/wake clock times over the trailing window, minutes. */
  consistencyMin: number | null;
  components: ScoreComponent[];
}

/** A day with all derived metrics attached. This is what the UI renders. */
export interface DerivedDay {
  date: DateKey;
  raw: DayRecord;
  recovery: RecoveryResult;
  strain: StrainResult;
  sleep: SleepResult;
  baselines: {
    hrv: Baseline | null;
    rhr: Baseline | null;
    respiratoryRate: Baseline | null;
  };
}

/** Everything the app needs to render, derived once from `DayRecord[]`. */
export interface Model {
  days: DerivedDay[];
  /** Index into `days` by date for O(1) lookup. */
  byDate: Map<DateKey, DerivedDay>;
  profile: Profile;
}

/** Personal calibration derived from the whole dataset (not from a single day). */
export interface Profile {
  /** Personal sleep need in minutes. */
  sleepNeedMin: number;
  /** Estimated max heart rate used for zone boundaries. */
  maxHr: number;
  /** Resting heart rate used as the floor of heart-rate reserve. */
  restingHr: number;
  /** Load that maps to a strain of 21, for each method. */
  strainRefZones: number;
  strainRefProxy: number;
  /** True when the max HR was set by the user rather than estimated. */
  maxHrIsUserSet: boolean;
  daysWithData: number;
  firstDate: DateKey | null;
  lastDate: DateKey | null;
}

export interface UserSettings {
  /** Overrides the derived sleep need when set. */
  sleepNeedMin: number | null;
  /** Overrides the estimated max HR when set. */
  maxHr: number | null;
  birthYear: number | null;
  units: 'metric' | 'imperial';
  theme: 'dark' | 'light' | 'system';
  /** Card ids the user has hidden from the dashboard. */
  hiddenCards: string[];
  reducedMotion: boolean | null;
  haptics: boolean;
  /** Opt-in AI narrative. Off unless the user explicitly turns it on. */
  aiEnabled: boolean;
  aiApiKey: string | null;
}

export const DEFAULT_SETTINGS: UserSettings = {
  sleepNeedMin: null,
  maxHr: null,
  birthYear: null,
  units: 'metric',
  theme: 'dark',
  hiddenCards: [],
  reducedMotion: null,
  haptics: true,
  aiEnabled: false,
  aiApiKey: null,
};
