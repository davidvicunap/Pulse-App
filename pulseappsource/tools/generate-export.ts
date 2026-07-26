/**
 * Synthetic Apple Health export generator.
 *
 * There is no real `export.xml` to develop against, so this is the primary fixture for
 * both tests and manual QA. It deliberately reproduces the messy parts of real exports,
 * because those are where parsers break:
 *
 *   - the same metric written by several sources (iPhone + Apple Watch + a third-party
 *     app), which naive parsers double-count
 *   - sleep sessions that span midnight, with staged sub-intervals and wake-ups
 *   - sparse days where a signal is simply absent
 *   - entirely missing days (watch on the charger, phone off)
 *   - timestamps carrying a real UTC offset, including a mid-run timezone change
 *   - pre-iOS16 bare `HKCategoryValueSleepAnalysisAsleep` records mixed with staged ones
 *
 * Usage:
 *   npm run fixture -- --days 180 --out fixtures/export.xml
 *   npm run fixture -- --days 400 --dense --out fixtures/big-export.xml
 *   npm run fixture -- --days 120 --zip --out fixtures/export.zip
 */

import { writeFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

// ─────────────────────────── deterministic RNG ───────────────────────────
// Seeded so a failing test is reproducible and diffs between runs are meaningful.

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rand = mulberry32(20240311);

/** Box–Muller normal sample. */
function gauss(mean: number, sd: number): number {
  const u = Math.max(1e-9, rand());
  const v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)];
}

// ─────────────────────────── timestamp formatting ───────────────────────────

/**
 * Apple writes `2024-03-11 07:32:15 -0700` — local wall-clock plus the offset that was
 * in effect. We emit the same shape, including the offset changing partway through the
 * history to simulate travel.
 */
function stamp(d: Date, offsetMinutes: number): string {
  const p = (n: number, w = 2) => String(Math.floor(Math.abs(n))).padStart(w, '0');
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const oh = p(Math.abs(offsetMinutes) / 60);
  const om = p(Math.abs(offsetMinutes) % 60);
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ` +
    `${sign}${oh}${om}`
  );
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// ─────────────────────────── sources ───────────────────────────

const WATCH = { name: 'David’s Apple Watch', version: '10.3' };
const PHONE = { name: 'David’s iPhone', version: '17.4' };
const THIRD_PARTY = { name: 'SleepScope', version: '4.2' };

interface Source {
  name: string;
  version: string;
}

// ─────────────────────────── physiological simulation ───────────────────────────

interface DayPlan {
  dayIndex: number;
  /** Midnight of this day, as a UTC-based Date carrying local wall-clock values. */
  base: Date;
  offsetMinutes: number;
  /** 0 = full rest, 1 = hardest session of the block. */
  trainingLoad: number;
  workout: { type: string; startHour: number; minutes: number; intensity: number } | null;
  hrv: number | null;
  rhr: number | null;
  respiratory: number | null;
  sleepMinutes: number | null;
  bedHour: number;
  /** Day is entirely absent from the export. */
  missing: boolean;
  /** Day has activity but no watch-derived vitals. */
  sparse: boolean;
}

const WORKOUT_TYPES = [
  'HKWorkoutActivityTypeRunning',
  'HKWorkoutActivityTypeCycling',
  'HKWorkoutActivityTypeFunctionalStrengthTraining',
  'HKWorkoutActivityTypeHighIntensityIntervalTraining',
  'HKWorkoutActivityTypeWalking',
  'HKWorkoutActivityTypeYoga',
] as const;

/**
 * Builds a plausible physiological history.
 *
 * The important property for testing insights is that the signals are *coupled*: hard
 * training days suppress next-day HRV and raise resting HR, short nights depress
 * recovery, and there's a slow fitness trend underneath. A generator producing
 * independent noise would make every correlation view come out empty.
 */
function planDays(count: number, startDate: Date): DayPlan[] {
  const plans: DayPlan[] = [];
  let fatigue = 0;
  const hrvBase = 58;
  const rhrBase = 52;

  for (let i = 0; i < count; i++) {
    const base = new Date(startDate.getTime() + i * 86_400_000);
    const dow = base.getUTCDay();
    // A slow fitness trend: HRV drifts up, resting HR drifts down over the history.
    const fitness = i / count;

    // Training pattern: harder midweek and Saturday, rest Sunday/Friday.
    const weekly = [0, 0.55, 0.8, 0.45, 0.9, 0.15, 0.95][dow];
    const trainingLoad = Math.max(0, Math.min(1, weekly * (0.7 + rand() * 0.6)));

    // Fatigue accumulates with load and decays with rest.
    fatigue = Math.max(0, fatigue * 0.78 + trainingLoad * 0.4);

    // Sleep: weekends later and longer; occasional bad nights.
    const isWeekend = dow === 0 || dow === 6;
    let sleepMinutes = gauss(isWeekend ? 470 : 425, 55);
    if (rand() < 0.08) sleepMinutes -= 90; // a genuinely bad night
    sleepMinutes = Math.max(240, Math.min(620, sleepMinutes));

    const bedHour = isWeekend ? 23.6 + rand() * 1.2 : 22.7 + rand() * 1.0;

    // HRV responds to yesterday's fatigue and last night's sleep.
    const sleepEffect = (sleepMinutes - 440) / 100;
    const hrv = gauss(hrvBase + fitness * 8 - fatigue * 11 + sleepEffect * 3.5, 4.5);
    const rhr = gauss(rhrBase - fitness * 3 + fatigue * 4.5 - sleepEffect * 0.8, 1.8);
    const respiratory = gauss(14.4 + fatigue * 0.5, 0.45);

    // Simulate a 5-day illness episode about two-thirds through.
    const illnessStart = Math.floor(count * 0.66);
    const ill = i >= illnessStart && i < illnessStart + 5;

    const missing = rand() < 0.035;
    const sparse = !missing && rand() < 0.07;

    const doWorkout = trainingLoad > 0.3 && rand() < 0.85 && !ill;
    plans.push({
      dayIndex: i,
      base,
      // Travel: shift the timezone for a two-week block partway through.
      offsetMinutes: i > count * 0.4 && i < count * 0.4 + 14 ? 60 : -480,
      trainingLoad: ill ? trainingLoad * 0.2 : trainingLoad,
      workout: doWorkout
        ? {
            type: pick(WORKOUT_TYPES),
            startHour: 6.5 + rand() * 11,
            minutes: Math.round(25 + trainingLoad * 70 + rand() * 20),
            intensity: trainingLoad,
          }
        : null,
      hrv: sparse ? null : Math.max(12, hrv - (ill ? 14 : 0)),
      rhr: sparse ? null : Math.max(38, rhr + (ill ? 7 : 0)),
      respiratory: sparse ? null : respiratory + (ill ? 1.8 : 0),
      sleepMinutes: rand() < 0.04 ? null : sleepMinutes,
      bedHour,
      missing,
      sparse,
    });
  }
  return plans;
}

// ─────────────────────────── record emission ───────────────────────────

interface Emitter {
  write(chunk: string): void;
}

function record(
  e: Emitter,
  type: string,
  source: Source,
  unit: string,
  start: Date,
  end: Date,
  value: string | number,
  offset: number,
): void {
  e.write(
    `<Record type="${type}" sourceName="${xmlEscape(source.name)}" sourceVersion="${source.version}"` +
      (unit ? ` unit="${unit}"` : '') +
      ` creationDate="${stamp(end, offset)}" startDate="${stamp(start, offset)}"` +
      ` endDate="${stamp(end, offset)}" value="${value}"/>\n`,
  );
}

function atHour(base: Date, hour: number): Date {
  return new Date(base.getTime() + Math.round(hour * 3600_000));
}

/** Heart rate at a moment, given the day's shape. */
function heartRateAt(plan: DayPlan, hour: number, restingHr: number): number {
  const w = plan.workout;
  if (w && hour >= w.startHour && hour <= w.startHour + w.minutes / 60) {
    const progress = (hour - w.startHour) / (w.minutes / 60);
    // Warm-up ramp, plateau, cool-down.
    const shape = progress < 0.15 ? progress / 0.15 : progress > 0.85 ? (1 - progress) / 0.15 : 1;
    const peak = restingHr + 55 + w.intensity * 75;
    return Math.round(gauss(restingHr + (peak - restingHr) * shape, 5));
  }
  if (hour < 7 || hour > 22.5) return Math.round(gauss(restingHr + 2, 3)); // asleep
  return Math.round(gauss(restingHr + 22, 11)); // awake, going about the day
}

interface GenerateOptions {
  days: number;
  dense: boolean;
  seed: number;
}

function generate(e: Emitter, opts: GenerateOptions): void {
  const start = new Date(Date.UTC(2024, 0, 8, 0, 0, 0));
  const plans = planDays(opts.days, start);

  e.write('<?xml version="1.0" encoding="UTF-8"?>\n');
  e.write('<!DOCTYPE HealthData [\n<!ELEMENT HealthData (ExportDate,Me,Record*,Workout*)>\n]>\n');
  e.write('<HealthData locale="en_US">\n');
  e.write(` <ExportDate value="${stamp(new Date(), -480)}"/>\n`);
  e.write(
    ' <Me HKCharacteristicTypeIdentifierDateOfBirth="1991-06-14"' +
      ' HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale"/>\n',
  );

  for (const plan of plans) {
    if (plan.missing) continue;
    const off = plan.offsetMinutes;
    const restingHr = plan.rhr ?? 54;

    // ── Sleep: starts the previous evening and crosses midnight ──
    if (plan.sleepMinutes != null) {
      emitSleep(e, plan, off);
    }

    // ── Overnight vitals, recorded by the Watch on waking ──
    if (plan.hrv != null) {
      // HRV is sampled a few times overnight, not once.
      const samples = 2 + Math.floor(rand() * 3);
      for (let s = 0; s < samples; s++) {
        const t = atHour(plan.base, 2 + s * 1.3);
        record(e, 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN', WATCH, 'ms', t, t,
          Math.max(8, gauss(plan.hrv, 5)).toFixed(3), off);
      }
    }
    if (plan.rhr != null) {
      const t = atHour(plan.base, 7.2);
      record(e, 'HKQuantityTypeIdentifierRestingHeartRate', WATCH, 'count/min', t, t,
        Math.round(plan.rhr), off);
      record(e, 'HKQuantityTypeIdentifierWalkingHeartRateAverage', WATCH, 'count/min', t, t,
        Math.round(plan.rhr + 38 + gauss(0, 4)), off);
    }
    if (plan.respiratory != null) {
      const t = atHour(plan.base, 4);
      record(e, 'HKQuantityTypeIdentifierRespiratoryRate', WATCH, 'count/min', t, t,
        plan.respiratory.toFixed(2), off);
      // Blood oxygen, as a 0–1 fraction the way Apple stores it.
      const t2 = atHour(plan.base, 3.5);
      record(e, 'HKQuantityTypeIdentifierOxygenSaturation', WATCH, '%', t2, t2,
        (gauss(0.968, 0.008)).toFixed(4), off);
    }

    // ── VO2max, roughly monthly ──
    if (plan.dayIndex % 31 === 5) {
      const t = atHour(plan.base, 18);
      record(e, 'HKQuantityTypeIdentifierVO2Max', WATCH, 'mL/min·kg', t, t,
        (46 + (plan.dayIndex / opts.days) * 4 + gauss(0, 0.8)).toFixed(2), off);
    }
    // ── Body mass, most mornings ──
    if (rand() < 0.6) {
      const t = atHour(plan.base, 7.4);
      record(e, 'HKQuantityTypeIdentifierBodyMass', THIRD_PARTY, 'kg', t, t,
        (78 - (plan.dayIndex / opts.days) * 2 + gauss(0, 0.4)).toFixed(2), off);
    }

    // ── Heart rate samples ──
    emitHeartRate(e, plan, restingHr, off, opts.dense);

    // ── Activity: written by BOTH watch and phone, so parsers must dedupe ──
    emitActivity(e, plan, off);

    // ── Workout ──
    if (plan.workout) emitWorkout(e, plan, off);

    // ── Mindfulness, occasionally ──
    if (rand() < 0.18) {
      const s = atHour(plan.base, 20 + rand());
      const en = new Date(s.getTime() + (5 + rand() * 15) * 60_000);
      e.write(
        `<Record type="HKCategoryTypeIdentifierMindfulSession" sourceName="${xmlEscape(PHONE.name)}"` +
          ` sourceVersion="${PHONE.version}" creationDate="${stamp(en, off)}"` +
          ` startDate="${stamp(s, off)}" endDate="${stamp(en, off)}" value="HKCategoryValueNotApplicable"/>\n`,
      );
    }
  }

  e.write('</HealthData>\n');
}

function emitSleep(e: Emitter, plan: DayPlan, off: number): void {
  const total = plan.sleepMinutes!;
  // Bed time is on the *previous* calendar day — the night spans midnight.
  const bedStart = new Date(plan.base.getTime() + (plan.bedHour - 24) * 3600_000);
  const latency = 6 + rand() * 22;
  const asleepStart = new Date(bedStart.getTime() + latency * 60_000);
  const wake = new Date(asleepStart.getTime() + total * 60_000);
  const inBedEnd = new Date(wake.getTime() + rand() * 12 * 60_000);

  const write = (source: Source, value: string, s: Date, en: Date) => {
    e.write(
      `<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="${xmlEscape(source.name)}"` +
        ` sourceVersion="${source.version}" creationDate="${stamp(en, off)}"` +
        ` startDate="${stamp(s, off)}" endDate="${stamp(en, off)}" value="${value}"/>\n`,
    );
  };

  write(WATCH, 'HKCategoryValueSleepAnalysisInBed', bedStart, inBedEnd);

  // Staged sleep in ~20 minute blocks, cycling through Core → Deep → Core → REM.
  const blockMin = 20;
  const blocks = Math.floor(total / blockMin);
  let cursor = asleepStart.getTime();
  const wakeUps: Array<[number, number]> = [];
  for (let i = 0; i < blocks; i++) {
    const cyclePos = (i % 12) / 12;
    let stage: string;
    if (cyclePos < 0.18) stage = 'HKCategoryValueSleepAnalysisAsleepDeep';
    else if (cyclePos > 0.72) stage = 'HKCategoryValueSleepAnalysisAsleepREM';
    else stage = 'HKCategoryValueSleepAnalysisAsleepCore';

    const s = new Date(cursor);
    const en = new Date(cursor + blockMin * 60_000);
    // A couple of brief wake-ups per night.
    if (i > 2 && i < blocks - 2 && rand() < 0.06) {
      const ws = new Date(cursor);
      const we = new Date(cursor + (3 + rand() * 9) * 60_000);
      write(WATCH, 'HKCategoryValueSleepAnalysisAwake', ws, we);
      wakeUps.push([ws.getTime(), we.getTime()]);
    }
    write(WATCH, stage, s, en);
    cursor = en.getTime();
  }

  // A third-party app records the SAME night as one undifferentiated block, using the
  // pre-iOS16 value. A parser that sums instead of merging will double this night.
  if (rand() < 0.55) {
    write(THIRD_PARTY, 'HKCategoryValueSleepAnalysisAsleep', asleepStart, wake);
  }
}

function emitHeartRate(
  e: Emitter,
  plan: DayPlan,
  restingHr: number,
  off: number,
  dense: boolean,
): void {
  if (plan.sparse) return;
  // Ambient sampling every ~5 minutes, the way a worn Watch behaves.
  const ambientStep = dense ? 1 / 60 : 5 / 60;
  for (let hour = 0; hour < 24; hour += ambientStep) {
    // The Watch doesn't sample continuously — skip a realistic share of slots.
    if (!dense && rand() < 0.25) continue;
    const t = atHour(plan.base, hour);
    const hr = heartRateAt(plan, hour, restingHr);
    record(e, 'HKQuantityTypeIdentifierHeartRate', WATCH, 'count/min', t, t, hr, off);
  }
  // During a workout the Watch samples every few seconds.
  const w = plan.workout;
  if (w) {
    const step = dense ? 5 / 3600 : 20 / 3600;
    for (let hour = w.startHour; hour < w.startHour + w.minutes / 60; hour += step) {
      const t = atHour(plan.base, hour);
      record(e, 'HKQuantityTypeIdentifierHeartRate', WATCH, 'count/min', t, t,
        heartRateAt(plan, hour, restingHr), off);
    }
  }
}

function emitActivity(e: Emitter, plan: DayPlan, off: number): void {
  const stepsTotal = Math.round(gauss(7800 + plan.trainingLoad * 4200, 2200));
  const energyTotal = Math.round(gauss(430 + plan.trainingLoad * 520, 90));
  const exerciseTotal = Math.round(plan.workout ? plan.workout.minutes * 0.9 : gauss(12, 8));

  // Emit in hourly slices, from BOTH the watch and the phone. The phone records a
  // slightly lower step count for the same walking — this is exactly the double-count
  // trap that makes naive parsers report 15,000 steps as 28,000.
  for (let hour = 6; hour < 23; hour++) {
    const share = hour >= 7 && hour <= 21 ? 1 / 15 : 0;
    if (share === 0) continue;
    const s = atHour(plan.base, hour);
    const en = atHour(plan.base, hour + 1);

    const stepsSlice = Math.round(stepsTotal * share * (0.6 + rand() * 0.8));
    if (stepsSlice > 0) {
      record(e, 'HKQuantityTypeIdentifierStepCount', WATCH, 'count', s, en, stepsSlice, off);
      record(e, 'HKQuantityTypeIdentifierStepCount', PHONE, 'count', s, en,
        Math.round(stepsSlice * 0.86), off);
      record(e, 'HKQuantityTypeIdentifierDistanceWalkingRunning', WATCH, 'km', s, en,
        (stepsSlice * 0.00075).toFixed(4), off);
    }

    const energySlice = energyTotal * share * (0.6 + rand() * 0.8);
    record(e, 'HKQuantityTypeIdentifierActiveEnergyBurned', WATCH, 'Cal', s, en,
      energySlice.toFixed(3), off);

    if (rand() < 0.75) {
      record(e, 'HKCategoryTypeIdentifierAppleStandHour', WATCH, '', s, en,
        'HKCategoryValueAppleStandHourStood', off);
    }
  }

  // Exercise minutes arrive as small chunks.
  let remaining = Math.max(0, exerciseTotal);
  const startHour = plan.workout ? plan.workout.startHour : 12;
  let h = startHour;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 5 + Math.floor(rand() * 10));
    const s = atHour(plan.base, h);
    const en = new Date(s.getTime() + chunk * 60_000);
    record(e, 'HKQuantityTypeIdentifierAppleExerciseTime', WATCH, 'min', s, en, chunk, off);
    remaining -= chunk;
    h += 0.4;
    if (h > 23) break;
  }
}

function emitWorkout(e: Emitter, plan: DayPlan, off: number): void {
  const w = plan.workout!;
  const s = atHour(plan.base, w.startHour);
  const en = new Date(s.getTime() + w.minutes * 60_000);
  const energy = Math.round(w.minutes * (6 + w.intensity * 7));
  const isDistance = /Running|Cycling|Walking/.test(w.type);
  const distanceKm = isDistance ? (w.minutes / 60) * (w.type.includes('Cycling') ? 26 : 10.5) : 0;

  // Newer exports carry `WorkoutStatistics` children as well as the legacy attributes;
  // emitting both makes sure the parser handles a multi-line element correctly.
  e.write(
    `<Workout workoutActivityType="${w.type}" duration="${w.minutes}" durationUnit="min"` +
      (isDistance ? ` totalDistance="${distanceKm.toFixed(3)}" totalDistanceUnit="km"` : '') +
      ` totalEnergyBurned="${energy}" totalEnergyBurnedUnit="Cal"` +
      ` sourceName="${xmlEscape(WATCH.name)}" sourceVersion="${WATCH.version}"` +
      ` creationDate="${stamp(en, off)}" startDate="${stamp(s, off)}" endDate="${stamp(en, off)}">\n`,
  );
  e.write(
    `  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned"` +
      ` startDate="${stamp(s, off)}" endDate="${stamp(en, off)}" sum="${energy}" unit="Cal"/>\n`,
  );
  if (isDistance) {
    e.write(
      `  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning"` +
        ` startDate="${stamp(s, off)}" endDate="${stamp(en, off)}"` +
        ` sum="${distanceKm.toFixed(3)}" unit="km"/>\n`,
    );
  }
  e.write('</Workout>\n');
}

// ─────────────────────────── public API (used by tests) ───────────────────────────

export function generateExportXml(days = 120, opts: { dense?: boolean; seed?: number } = {}): string {
  rand = mulberry32(opts.seed ?? 20240311);
  const parts: string[] = [];
  generate({ write: (c) => parts.push(c) }, { days, dense: opts.dense ?? false, seed: opts.seed ?? 0 });
  return parts.join('');
}

// ─────────────────────────── CLI ───────────────────────────

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const isMain = process.argv[1] && /generate-export\.ts$/.test(process.argv[1]);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const days = Number(args.days ?? 180);
  const dense = Boolean(args.dense);
  const seed = Number(args.seed ?? 20240311);
  const asZip = Boolean(args.zip);
  const out = resolve(
    process.cwd(),
    String(args.out ?? (asZip ? 'fixtures/export.zip' : 'fixtures/export.xml')),
  );
  mkdirSync(dirname(out), { recursive: true });

  rand = mulberry32(seed);

  if (asZip) {
    const parts: string[] = [];
    generate({ write: (c) => parts.push(c) }, { days, dense, seed });
    const xml = parts.join('');
    // Real exports put the XML inside an `apple_health_export/` folder, alongside a
    // large CDA file the parser must learn to ignore.
    const zipped = zipSync(
      {
        'apple_health_export/export.xml': strToU8(xml),
        'apple_health_export/export_cda.xml': strToU8('<ClinicalDocument/>'),
      },
      { level: 6 },
    );
    writeFileSync(out, zipped);
    console.log(`Wrote ${out} — ${days} days, ${(zipped.length / 1e6).toFixed(1)}MB zipped ` +
      `(${(xml.length / 1e6).toFixed(1)}MB raw)`);
  } else {
    // Stream to disk so a 400-day dense export doesn't need to fit in a string.
    const stream = createWriteStream(out);
    let bytes = 0;
    generate(
      {
        write: (c) => {
          bytes += c.length;
          stream.write(c);
        },
      },
      { days, dense, seed },
    );
    stream.end();
    stream.on('finish', () => {
      console.log(`Wrote ${out} — ${days} days, ${(bytes / 1e6).toFixed(1)}MB`);
    });
  }
}
