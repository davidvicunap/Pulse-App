import { describe, it, expect } from 'vitest';
import { HealthAccumulator, pickSourceTotal, prettyActivity, type RawRecord } from '../src/parse/accumulator';
import { HR_HISTOGRAM_BIN, HR_HISTOGRAM_MIN } from '../src/core/types';

/** Builds a record with the exact shape Apple writes. */
function rec(over: Partial<RawRecord> & Pick<RawRecord, 'type' | 'startDate'>): RawRecord {
  return { sourceName: 'Test Watch', ...over };
}

const T = (date: string, time: string, offset = '-0800') => `${date} ${time} ${offset}`;

describe('pickSourceTotal', () => {
  it('returns the single source total when there is only one', () => {
    expect(pickSourceTotal(new Map([['Watch', 8000]]))).toBe(8000);
  });

  it('prefers the Apple Watch over other sources rather than summing', () => {
    // Summing an iPhone and a Watch roughly doubles a step count — the classic
    // Apple Health double-count.
    const bySource = new Map([
      ['David’s iPhone', 6900],
      ['David’s Apple Watch', 8000],
    ]);
    expect(pickSourceTotal(bySource)).toBe(8000);
  });

  it('takes the largest source when no Watch is present', () => {
    const bySource = new Map([
      ['iPhone', 6900],
      ['StepTracker Pro', 7400],
    ]);
    expect(pickSourceTotal(bySource)).toBe(7400);
  });

  it('is zero for no sources', () => {
    expect(pickSourceTotal(new Map())).toBe(0);
  });
});

describe('quantity records', () => {
  it('takes the median of repeated vitals rather than the last value', () => {
    const acc = new HealthAccumulator();
    for (const v of [50, 54, 200, 52]) {
      acc.addRecord(rec({
        type: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
        startDate: T('2024-03-11', '03:00:00'),
        value: String(v),
      }));
    }
    const [day] = acc.finalize();
    // The median resists the single spurious 200ms reading.
    expect(day.hrv).toBe(53);
  });

  it('does not double-count steps recorded by both a phone and a watch', () => {
    const acc = new HealthAccumulator();
    acc.addRecord(rec({ type: 'HKQuantityTypeIdentifierStepCount', startDate: T('2024-03-11', '09:00:00'), value: '5000', sourceName: 'David’s Apple Watch' }));
    acc.addRecord(rec({ type: 'HKQuantityTypeIdentifierStepCount', startDate: T('2024-03-11', '09:00:00'), value: '4300', sourceName: 'David’s iPhone' }));
    const [day] = acc.finalize();
    expect(day.steps).toBe(5000);
  });

  it('normalises units', () => {
    const acc = new HealthAccumulator();
    acc.addRecord(rec({ type: 'HKQuantityTypeIdentifierActiveEnergyBurned', startDate: T('2024-03-11', '09:00:00'), value: '418.4', unit: 'kJ' }));
    acc.addRecord(rec({ type: 'HKQuantityTypeIdentifierBodyMass', startDate: T('2024-03-11', '07:00:00'), value: '170', unit: 'lb' }));
    acc.addRecord(rec({ type: 'HKQuantityTypeIdentifierDistanceWalkingRunning', startDate: T('2024-03-11', '09:00:00'), value: '2', unit: 'mi' }));
    const [day] = acc.finalize();
    expect(day.activeEnergy).toBe(100);
    expect(day.bodyMassKg).toBeCloseTo(77.1, 1);
    expect(day.distanceKm).toBeCloseTo(3.22, 1);
  });

  it('accepts blood oxygen as either a fraction or a percentage', () => {
    const acc = new HealthAccumulator();
    acc.addRecord(rec({ type: 'HKQuantityTypeIdentifierOxygenSaturation', startDate: T('2024-03-11', '03:00:00'), value: '0.97' }));
    acc.addRecord(rec({ type: 'HKQuantityTypeIdentifierOxygenSaturation', startDate: T('2024-03-12', '03:00:00'), value: '97' }));
    const days = acc.finalize();
    expect(days[0].spo2).toBeCloseTo(97, 5);
    expect(days[1].spo2).toBeCloseTo(97, 5);
  });

  it('ignores record types it does not care about', () => {
    const acc = new HealthAccumulator();
    acc.addRecord(rec({ type: 'HKQuantityTypeIdentifierDietaryWater', startDate: T('2024-03-11', '09:00:00'), value: '500' }));
    expect(acc.finalize()).toHaveLength(0);
    expect(acc.recordsSeen).toBe(1);
    expect(acc.recordsKept).toBe(0);
  });

  it('keeps the export’s own local date rather than re-deriving it', () => {
    // A record written in Tokyo must land on the Tokyo date, whatever zone the browser
    // running Pulse happens to be in.
    const acc = new HealthAccumulator();
    acc.addRecord(rec({ type: 'HKQuantityTypeIdentifierRestingHeartRate', startDate: '2024-03-11 08:00:00 +0900', value: '55' }));
    expect(acc.finalize()[0].date).toBe('2024-03-11');
  });
});

describe('heart-rate histogram', () => {
  it('buckets samples by minute, taking the maximum in each minute', () => {
    const acc = new HealthAccumulator();
    // Three samples in the same minute — this must count as one minute, at 150bpm.
    for (const v of [120, 150, 130]) {
      acc.addRecord(rec({ type: 'HKQuantityTypeIdentifierHeartRate', startDate: T('2024-03-11', '10:00:30'), value: String(v) }));
    }
    const [day] = acc.finalize();
    expect(day.hrMinutesCovered).toBe(1);
    expect(day.maxHr).toBe(150);
    const bin = Math.floor((150 - HR_HISTOGRAM_MIN) / HR_HISTOGRAM_BIN);
    expect(day.hrHistogram![bin]).toBe(1);
  });

  it('dedupes overlapping samples from two devices into one minute', () => {
    const acc = new HealthAccumulator();
    acc.addRecord(rec({ type: 'HKQuantityTypeIdentifierHeartRate', startDate: T('2024-03-11', '10:00:05'), value: '140', sourceName: 'Watch' }));
    acc.addRecord(rec({ type: 'HKQuantityTypeIdentifierHeartRate', startDate: T('2024-03-11', '10:00:45'), value: '142', sourceName: 'Chest Strap' }));
    const [day] = acc.finalize();
    expect(day.hrMinutesCovered).toBe(1);
  });

  it('rejects physiologically impossible samples', () => {
    const acc = new HealthAccumulator();
    acc.addRecord(rec({ type: 'HKQuantityTypeIdentifierHeartRate', startDate: T('2024-03-11', '10:00:00'), value: '5' }));
    acc.addRecord(rec({ type: 'HKQuantityTypeIdentifierHeartRate', startDate: T('2024-03-11', '10:05:00'), value: '400' }));
    // Every sample was rejected, so the day never comes into existence at all —
    // better than a day that exists with an empty histogram.
    expect(acc.finalize()).toHaveLength(0);
  });

  it('reports no histogram for a day with no heart-rate samples', () => {
    const acc = new HealthAccumulator();
    acc.addRecord(rec({ type: 'HKQuantityTypeIdentifierStepCount', startDate: T('2024-03-11', '09:00:00'), value: '100' }));
    const [day] = acc.finalize();
    expect(day.hrHistogram).toBeNull();
    expect(day.hrMinutesCovered).toBe(0);
  });
});

describe('sleep', () => {
  const sleepRec = (value: string, start: string, end: string, source = 'Watch'): RawRecord =>
    rec({ type: 'HKCategoryTypeIdentifierSleepAnalysis', startDate: start, endDate: end, value, sourceName: source });

  it('attributes a night that spans midnight to the wake-up day', () => {
    const acc = new HealthAccumulator();
    acc.addRecord(sleepRec('HKCategoryValueSleepAnalysisAsleepCore', T('2024-03-10', '23:00:00'), T('2024-03-11', '07:00:00')));
    const days = acc.finalize();
    expect(days).toHaveLength(1);
    expect(days[0].date).toBe('2024-03-11');
    expect(days[0].sleep!.asleepMin).toBe(480);
  });

  it('keeps pre-midnight stage blocks with the night they belong to', () => {
    // Staged sleep arrives as ~20-minute blocks. The blocks between bedtime and midnight
    // end on the *previous* calendar date; keying naively on that date would report one
    // night as two short nights on consecutive days.
    const acc = new HealthAccumulator();
    acc.addRecord(sleepRec('HKCategoryValueSleepAnalysisAsleepCore', T('2024-03-10', '22:40:00'), T('2024-03-10', '23:00:00')));
    acc.addRecord(sleepRec('HKCategoryValueSleepAnalysisAsleepDeep', T('2024-03-10', '23:00:00'), T('2024-03-10', '23:40:00')));
    acc.addRecord(sleepRec('HKCategoryValueSleepAnalysisAsleepCore', T('2024-03-10', '23:40:00'), T('2024-03-11', '06:00:00')));
    const days = acc.finalize();
    expect(days).toHaveLength(1);
    expect(days[0].date).toBe('2024-03-11');
    expect(days[0].sleep!.asleepMin).toBe(440);
    expect(days[0].sleep!.deepMin).toBe(40);
  });

  it('keeps an afternoon nap on the day it happened', () => {
    const acc = new HealthAccumulator();
    acc.addRecord(sleepRec('HKCategoryValueSleepAnalysisAsleepCore', T('2024-03-11', '14:00:00'), T('2024-03-11', '14:45:00')));
    const days = acc.finalize();
    expect(days[0].date).toBe('2024-03-11');
    expect(days[0].sleep!.asleepMin).toBe(45);
  });

  it('merges the same night recorded by two sources instead of doubling it', () => {
    const acc = new HealthAccumulator();
    // The Watch records staged sleep; a third-party app records the same window as one
    // undifferentiated block. Summing would report 16 hours.
    acc.addRecord(sleepRec('HKCategoryValueSleepAnalysisAsleepCore', T('2024-03-10', '23:00:00'), T('2024-03-11', '03:00:00'), 'Watch'));
    acc.addRecord(sleepRec('HKCategoryValueSleepAnalysisAsleepREM', T('2024-03-11', '03:00:00'), T('2024-03-11', '07:00:00'), 'Watch'));
    acc.addRecord(sleepRec('HKCategoryValueSleepAnalysisAsleep', T('2024-03-10', '23:00:00'), T('2024-03-11', '07:00:00'), 'SleepScope'));
    const [day] = acc.finalize();
    expect(day.sleep!.asleepMin).toBe(480);
    expect(day.sleep!.sourceCount).toBe(2);
  });

  it('subtracts recorded wake-ups from total sleep', () => {
    const acc = new HealthAccumulator();
    acc.addRecord(sleepRec('HKCategoryValueSleepAnalysisAsleepCore', T('2024-03-10', '23:00:00'), T('2024-03-11', '07:00:00')));
    acc.addRecord(sleepRec('HKCategoryValueSleepAnalysisAwake', T('2024-03-11', '02:00:00'), T('2024-03-11', '02:30:00')));
    const [day] = acc.finalize();
    expect(day.sleep!.asleepMin).toBe(450);
    expect(day.sleep!.awakeMin).toBe(30);
    expect(day.sleep!.interruptions).toBe(1);
  });

  it('computes efficiency and latency from in-bed records', () => {
    const acc = new HealthAccumulator();
    acc.addRecord(sleepRec('HKCategoryValueSleepAnalysisInBed', T('2024-03-10', '22:30:00'), T('2024-03-11', '07:00:00')));
    acc.addRecord(sleepRec('HKCategoryValueSleepAnalysisAsleepCore', T('2024-03-10', '23:00:00'), T('2024-03-11', '07:00:00')));
    const [day] = acc.finalize();
    expect(day.sleep!.latencyMin).toBe(30);
    expect(day.sleep!.inBedMin).toBe(510);
    expect(day.sleep!.efficiency).toBeCloseTo(480 / 510, 3);
  });

  it('reports no efficiency when the source does not record time in bed', () => {
    const acc = new HealthAccumulator();
    acc.addRecord(sleepRec('HKCategoryValueSleepAnalysisAsleepCore', T('2024-03-10', '23:00:00'), T('2024-03-11', '07:00:00')));
    const [day] = acc.finalize();
    expect(day.sleep!.efficiency).toBeNull();
    expect(day.sleep!.latencyMin).toBeNull();
  });

  it('splits stage totals correctly', () => {
    const acc = new HealthAccumulator();
    acc.addRecord(sleepRec('HKCategoryValueSleepAnalysisAsleepDeep', T('2024-03-10', '23:00:00'), T('2024-03-11', '00:00:00')));
    acc.addRecord(sleepRec('HKCategoryValueSleepAnalysisAsleepREM', T('2024-03-11', '00:00:00'), T('2024-03-11', '01:30:00')));
    acc.addRecord(sleepRec('HKCategoryValueSleepAnalysisAsleepCore', T('2024-03-11', '01:30:00'), T('2024-03-11', '07:00:00')));
    const [day] = acc.finalize();
    expect(day.sleep!.deepMin).toBe(60);
    expect(day.sleep!.remMin).toBe(90);
    expect(day.sleep!.coreMin).toBe(330);
    expect(day.sleep!.asleepMin).toBe(480);
  });

  it('handles the pre-iOS16 bare "Asleep" value', () => {
    const acc = new HealthAccumulator();
    acc.addRecord(sleepRec('HKCategoryValueSleepAnalysisAsleep', T('2024-03-10', '23:00:00'), T('2024-03-11', '06:00:00')));
    const [day] = acc.finalize();
    expect(day.sleep!.asleepMin).toBe(420);
  });

  it('discards corrupt records claiming an impossible duration', () => {
    const acc = new HealthAccumulator();
    acc.addRecord(sleepRec('HKCategoryValueSleepAnalysisAsleepCore', T('2024-03-09', '23:00:00'), T('2024-03-11', '07:00:00')));
    expect(acc.finalize()).toHaveLength(0);
  });

  it('ignores inverted intervals', () => {
    const acc = new HealthAccumulator();
    acc.addRecord(sleepRec('HKCategoryValueSleepAnalysisAsleepCore', T('2024-03-11', '07:00:00'), T('2024-03-10', '23:00:00')));
    expect(acc.finalize()).toHaveLength(0);
  });
});

describe('workouts', () => {
  it('parses duration, distance and energy', () => {
    const acc = new HealthAccumulator();
    acc.addWorkout({
      activityType: 'HKWorkoutActivityTypeRunning',
      startDate: T('2024-03-11', '07:00:00'),
      endDate: T('2024-03-11', '08:00:00'),
      duration: '60',
      durationUnit: 'min',
      totalDistance: '10',
      totalDistanceUnit: 'km',
      totalEnergyBurned: '600',
    });
    const [day] = acc.finalize();
    expect(day.workouts).toHaveLength(1);
    expect(day.workouts[0]).toMatchObject({ type: 'Running', durationMin: 60, distanceKm: 10, energyKcal: 600 });
  });

  it('derives duration from the timestamps when the attribute is missing', () => {
    const acc = new HealthAccumulator();
    acc.addWorkout({
      activityType: 'HKWorkoutActivityTypeCycling',
      startDate: T('2024-03-11', '07:00:00'),
      endDate: T('2024-03-11', '07:45:00'),
    });
    expect(acc.finalize()[0].workouts[0].durationMin).toBe(45);
  });

  it('fills totals from WorkoutStatistics children, as iOS 16+ exports do', () => {
    const acc = new HealthAccumulator();
    acc.addWorkout({
      activityType: 'HKWorkoutActivityTypeRunning',
      startDate: T('2024-03-11', '07:00:00'),
      endDate: T('2024-03-11', '08:00:00'),
      duration: '60',
      durationUnit: 'min',
    });
    acc.applyWorkoutStatistic('HKQuantityTypeIdentifierActiveEnergyBurned', 550, 'Cal');
    acc.applyWorkoutStatistic('HKQuantityTypeIdentifierDistanceWalkingRunning', 5, 'mi');
    const [day] = acc.finalize();
    expect(day.workouts[0].energyKcal).toBe(550);
    expect(day.workouts[0].distanceKm).toBeCloseTo(8.05, 1);
  });

  it('lets an explicit attribute win over a statistics child', () => {
    const acc = new HealthAccumulator();
    acc.addWorkout({
      activityType: 'HKWorkoutActivityTypeRunning',
      startDate: T('2024-03-11', '07:00:00'),
      duration: '30',
      durationUnit: 'min',
      totalEnergyBurned: '300',
    });
    acc.applyWorkoutStatistic('HKQuantityTypeIdentifierActiveEnergyBurned', 999, 'Cal');
    expect(acc.finalize()[0].workouts[0].energyKcal).toBe(300);
  });

  it('converts a duration given in seconds', () => {
    const acc = new HealthAccumulator();
    acc.addWorkout({
      activityType: 'HKWorkoutActivityTypeYoga',
      startDate: T('2024-03-11', '07:00:00'),
      duration: '1800',
      durationUnit: 'sec',
    });
    expect(acc.finalize()[0].workouts[0].durationMin).toBe(30);
  });

  it('humanises activity type names', () => {
    expect(prettyActivity('HKWorkoutActivityTypeHighIntensityIntervalTraining')).toBe('High Intensity Interval Training');
    expect(prettyActivity('HKWorkoutActivityTypeRunning')).toBe('Running');
    expect(prettyActivity('')).toBe('Workout');
  });
});

describe('finalize', () => {
  it('returns days sorted oldest first regardless of insertion order', () => {
    const acc = new HealthAccumulator();
    for (const d of ['2024-03-13', '2024-03-11', '2024-03-12']) {
      acc.addRecord(rec({ type: 'HKQuantityTypeIdentifierRestingHeartRate', startDate: T(d, '07:00:00'), value: '55' }));
    }
    expect(acc.finalize().map((d) => d.date)).toEqual(['2024-03-11', '2024-03-12', '2024-03-13']);
  });

  it('counts stand hours as distinct hours', () => {
    const acc = new HealthAccumulator();
    for (const h of ['09', '09', '10', '11']) {
      acc.addRecord(rec({
        type: 'HKCategoryTypeIdentifierAppleStandHour',
        startDate: T('2024-03-11', `${h}:00:00`),
        value: 'HKCategoryValueAppleStandHourStood',
      }));
    }
    expect(acc.finalize()[0].standHours).toBe(3);
  });

  it('produces an empty result for an empty input', () => {
    expect(new HealthAccumulator().finalize()).toEqual([]);
  });
});
