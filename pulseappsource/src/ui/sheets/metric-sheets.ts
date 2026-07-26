/**
 * Metric detail sheets.
 *
 * Tapping any top-level number opens one of these. They exist for one reason: a health
 * score you can't interrogate is a number people stop trusting the first time it
 * surprises them. So each sheet shows the score, every weighted input that produced it,
 * the baseline each input was compared against, and a plain-language account of the
 * arithmetic — the same numbers the code actually used, not a re-description.
 */

import type { DerivedDay, Model, ScoreComponent } from '../../core/types';
import { duration, num, percent, signed } from '../../core/format';
import { formatClock, formatFullDate } from '../../core/dates';
import { h } from '../dom';
import { openSheet } from '../sheet';
import { bandColor } from '../ring';
import {
  MAX_STRAIN,
  ZONE_DESCRIPTIONS,
  ZONE_FLOORS,
  ZONE_LABELS,
  loadForStrain,
  strainBand,
} from '../../model/strain';
import { RECOVERY_WEIGHTS } from '../../model/recovery';
import { LOW_CONFIDENCE } from '../../model/baselines';
import { typicalTimes } from '../../model/sleep';

// ─────────────────────────── shared pieces ───────────────────────────

/** The big number at the top of every sheet. */
function readout(value: string, unit: string, color: string, caption: string): HTMLElement {
  return h(
    'div',
    { class: 'sheet-readout', style: `--accent:${color}` },
    h('div', { class: 'sheet-readout-value' }, value, h('span', { class: 'sheet-readout-unit' }, unit)),
    h('p', { class: 'sheet-readout-caption' }, caption),
  );
}

/**
 * One weighted input, drawn as a labelled bar.
 * The bar length is the sub-score and the label carries the weight, so you can see both
 * "how did this input do" and "how much did it matter" at once.
 */
function componentRow(c: ScoreComponent, color: string): HTMLElement {
  return h(
    'div',
    { class: 'component' },
    h(
      'div',
      { class: 'component-head' },
      h('span', { class: 'component-label' }, c.label),
      h('span', { class: 'component-weight' }, `${Math.round(c.weight * 100)}% of score`),
    ),
    h(
      'div',
      { class: 'component-bar', role: 'img', 'aria-label': `${c.label}: ${Math.round(c.score * 100)} out of 100` },
      h('i', { style: `width:${Math.max(2, c.score * 100)}%;--c:${color}` }),
    ),
    h('p', { class: 'component-detail' }, c.detail),
  );
}

/** The "how this was worked out" block — the transparency promise, made concrete. */
function mathBlock(lines: string[], total: string): HTMLElement {
  return h(
    'details',
    { class: 'math' },
    h('summary', null, 'How this number was worked out'),
    h('div', { class: 'math-body' },
      ...lines.map((line) => h('p', { class: 'math-line' }, line)),
      h('p', { class: 'math-total' }, total),
    ),
  );
}

function confidenceNote(confidence: number, subject: string): HTMLElement | null {
  if (confidence >= LOW_CONFIDENCE) return null;
  return h(
    'div',
    { class: 'note note-caution' },
    h('strong', null, 'Low confidence. '),
    `There isn't enough history yet for a reliable ${subject}. Pulse needs about three weeks ` +
      `of data before a baseline means much — until then, treat this as provisional.`,
  );
}

function statGrid(items: Array<[string, string]>): HTMLElement {
  return h(
    'div',
    { class: 'stat-grid' },
    ...items.map(([label, value]) =>
      h('div', { class: 'stat-cell' },
        h('div', { class: 'stat-cell-label' }, label),
        h('div', { class: 'stat-cell-value' }, value),
      ),
    ),
  );
}

// ─────────────────────────── recovery ───────────────────────────

export function openRecoverySheet(day: DerivedDay): void {
  const { recovery } = day;
  const color = recovery.score == null ? 'var(--iron)' : bandColor(recovery.band);

  openSheet(
    { eyebrow: formatFullDate(day.date), title: 'Recovery', },
    (body) => {
      body.append(
        readout(
          recovery.score == null ? '—' : String(recovery.score),
          '%',
          color,
          recovery.score == null
            ? 'Not enough signal on this day to score recovery.'
            : bandCaption(recovery.band),
        ),
      );

      const note = confidenceNote(recovery.confidence, 'recovery score');
      if (note) body.append(note);

      if (!recovery.components.length) {
        body.append(
          h('p', { class: 'sheet-empty' },
            'Recovery needs at least one of HRV, resting heart rate or sleep for this day, ' +
            'plus a few weeks of prior data to compare against.'),
        );
        return;
      }

      body.append(
        h('h3', { class: 'sheet-section' }, 'What went into it'),
        ...recovery.components.map((c) => componentRow(c, color)),
      );

      if (recovery.modifierReason) {
        body.append(
          h('div', { class: 'note note-caution' },
            h('strong', null, 'Adjustment applied. '), recovery.modifierReason),
        );
      }

      const lines = recovery.components.map(
        (c) =>
          `${c.label}: scored ${Math.round(c.score * 100)}/100, weighted ${Math.round(c.weight * 100)}% ` +
          `→ contributes ${(c.score * c.weight * 100).toFixed(1)} points.`,
      );
      if (recovery.modifier < 1) {
        lines.push(`Then multiplied by ${recovery.modifier.toFixed(2)} for the respiratory-rate adjustment.`);
      }
      body.append(
        mathBlock(lines, `Total: ${recovery.score}%`),
        h('p', { class: 'sheet-foot' },
          `Nominal weights are HRV ${Math.round(RECOVERY_WEIGHTS.hrv * 100)}%, ` +
          `resting heart rate ${Math.round(RECOVERY_WEIGHTS.rhr * 100)}% and ` +
          `sleep ${Math.round(RECOVERY_WEIGHTS.sleep * 100)}%. When a signal is missing, ` +
          `the rest are re-weighted to fill the gap rather than scoring it as zero.`),
      );
    },
  );
}

function bandCaption(band: 'low' | 'moderate' | 'high'): string {
  if (band === 'high') return 'Your system is primed. This is the day to spend it.';
  if (band === 'moderate') return 'A normal working day. Train, but leave something in reserve.';
  return 'Your body is asking for recovery. Intensity today costs more than it returns.';
}

// ─────────────────────────── strain ───────────────────────────

export function openStrainSheet(day: DerivedDay, model: Model): void {
  const { strain } = day;

  openSheet({ eyebrow: formatFullDate(day.date), title: 'Strain' }, (body) => {
    body.append(
      readout(
        strain.method === 'none' ? '—' : strain.score.toFixed(1),
        ` / ${MAX_STRAIN}`,
        'var(--cardio)',
        strain.method === 'none'
          ? 'No heart-rate or activity data was recorded for this day.'
          : `A ${strainBand(strain.score)} day by your own standards.`,
      ),
    );

    if (strain.method === 'energy-proxy') {
      body.append(
        h('div', { class: 'note' },
          h('strong', null, 'Estimated from activity. '),
          'This day has too few heart-rate samples for zone analysis, so strain is estimated ' +
          'from active energy and exercise minutes instead. That can\'t tell a hard session from ' +
          'a long easy one — wear your watch during workouts for the accurate version.'),
      );
    }

    if (strain.method === 'none') {
      body.append(h('p', { class: 'sheet-empty' }, 'Nothing to break down for this day.'));
      return;
    }

    if (strain.zoneMinutes) {
      body.append(
        h('h3', { class: 'sheet-section' }, 'Time in heart-rate zones'),
        h('div', { class: 'zones' },
          ...strain.zoneMinutes.map((minutes, i) => {
            const lo = Math.round(model.profile.restingHr + ZONE_FLOORS[i] * (model.profile.maxHr - model.profile.restingHr));
            const hi = i < 4
              ? Math.round(model.profile.restingHr + ZONE_FLOORS[i + 1] * (model.profile.maxHr - model.profile.restingHr))
              : model.profile.maxHr;
            const share = strain.load > 0 ? (minutes * [1, 2, 3.5, 6, 9][i]) / strain.load : 0;
            return h('div', { class: `zone zone-${i + 1}${minutes > 0 ? '' : ' is-empty'}` },
              h('div', { class: 'zone-head' },
                h('span', { class: 'zone-name' }, ZONE_LABELS[i]),
                h('span', { class: 'zone-range' }, `${lo}–${hi} bpm`),
                h('span', { class: 'zone-minutes' }, minutes > 0 ? `${Math.round(minutes)}m` : '—'),
              ),
              h('div', { class: 'zone-bar' }, h('i', { style: `width:${Math.max(0, share * 100)}%` })),
              h('p', { class: 'zone-desc' }, ZONE_DESCRIPTIONS[i]),
            );
          }),
        ),
      );
    }

    const nextTargets = [10, 14, 18].filter((t) => t > strain.score);
    body.append(
      statGrid([
        ['Cardio load', num(strain.load, 0)],
        ['Your 21-point load', num(strain.reference, 0)],
        ['HR coverage', `${Math.round(day.raw.hrMinutesCovered)} min`],
        ['Active energy', `${num(day.raw.activeEnergy)} kcal`],
      ]),
      mathBlock(
        [
          `Each minute is weighted by its zone: Zone 1 counts 1×, Zone 2 counts 2×, Zone 3 counts 3.5×, Zone 4 counts 6× and Zone 5 counts 9×.`,
          `That gives a cardio load of ${strain.load.toFixed(0)} for this day.`,
          `Load is then mapped onto the 0–21 scale logarithmically, against your personal reference of ${strain.reference.toFixed(0)} — the 95th percentile of your own days, so 21 means maximal *for you*.`,
        ],
        `Total: ${strain.score.toFixed(1)} of ${MAX_STRAIN}`,
      ),
      nextTargets.length
        ? h('p', { class: 'sheet-foot' },
            `To reach a strain of ${nextTargets[0]} today you'd need roughly ` +
            `${Math.round(loadForStrain(nextTargets[0], strain.reference) - strain.load)} more load units — ` +
            `about ${Math.round((loadForStrain(nextTargets[0], strain.reference) - strain.load) / 3.5)} minutes at moderate effort.`)
        : h('p', { class: 'sheet-foot' }, 'This is at the top of your personal scale.'),
    );

    if (day.raw.workouts.length) {
      body.append(
        h('h3', { class: 'sheet-section' }, 'Workouts'),
        ...day.raw.workouts.map((w) =>
          h('div', { class: 'workout-row' },
            h('div', { class: 'workout-type' }, w.type),
            h('div', { class: 'workout-meta' },
              [
                duration(w.durationMin),
                w.distanceKm ? `${w.distanceKm.toFixed(1)} km` : null,
                w.energyKcal ? `${Math.round(w.energyKcal)} kcal` : null,
              ].filter(Boolean).join(' · '),
            ),
          ),
        ),
      );
    }
  });
}

// ─────────────────────────── sleep ───────────────────────────

export function openSleepSheet(day: DerivedDay, model: Model): void {
  const { sleep } = day;
  const night = day.raw.sleep;

  openSheet({ eyebrow: formatFullDate(day.date), title: 'Sleep' }, (body) => {
    body.append(
      readout(
        night ? duration(night.asleepMin) : '—',
        '',
        'var(--somnus)',
        night
          ? `${percent(sleep.score ?? 0)} of your ${duration(sleep.needMin)} need.`
          : 'No sleep was recorded for this night.',
      ),
    );

    if (!night) {
      body.append(
        h('p', { class: 'sheet-empty' },
          'Nothing recorded. Sleep needs a watch worn overnight, or a sleep app writing to Health.'),
      );
      return;
    }

    // Stage composition, drawn as a proportional bar — the shape of the night.
    const stages: Array<[string, number, string]> = [
      ['Deep', night.deepMin, 'var(--cardio)'],
      ['REM', night.remMin, 'var(--somnus)'],
      ['Core', night.coreMin, 'var(--phosphor)'],
      ['Awake', night.awakeMin, 'var(--hairline-strong)'],
    ];
    const staged = stages.reduce((a, [, m]) => a + m, 0);

    if (staged > 0) {
      body.append(
        h('h3', { class: 'sheet-section' }, 'How the night was spent'),
        h('div', { class: 'hypnogram' },
          ...stages.map(([, minutes, color]) =>
            minutes > 0
              ? h('i', { style: `flex:${minutes};background:${color}`, title: `${Math.round(minutes)}m` })
              : null,
          ),
        ),
        h('div', { class: 'stage-legend' },
          ...stages.filter(([, m]) => m > 0).map(([label, minutes, color]) =>
            h('div', { class: 'stage-item' },
              h('i', { style: `background:${color}` }),
              h('span', null, label),
              h('b', null, duration(minutes)),
            ),
          ),
        ),
      );
    }

    body.append(
      statGrid([
        ['Efficiency', night.efficiency == null ? '—' : percent(night.efficiency * 100)],
        ['Time to fall asleep', night.latencyMin == null ? '—' : duration(night.latencyMin)],
        ['Interruptions', String(night.interruptions)],
        ['Sleep debt (14d)', duration(sleep.debtMin)],
        ['Asleep at', formatClock(new Date(night.bedStartMs).getHours() * 60 + new Date(night.bedStartMs).getMinutes())],
        ['Woke at', formatClock(new Date(night.wakeEndMs).getHours() * 60 + new Date(night.wakeEndMs).getMinutes())],
      ]),
    );

    if (sleep.components.length) {
      body.append(
        h('h3', { class: 'sheet-section' }, 'What went into the score'),
        ...sleep.components.map((c) => componentRow(c, 'var(--somnus)')),
        mathBlock(
          sleep.components.map(
            (c) =>
              `${c.label}: scored ${Math.round(c.score * 100)}/100, weighted ${Math.round(c.weight * 100)}% ` +
              `→ contributes ${(c.score * c.weight * 100).toFixed(1)} points.`,
          ),
          `Total: ${sleep.score}%`,
        ),
      );
    }

    const window = model.days
      .slice(Math.max(0, model.days.indexOf(day) - 13), model.days.indexOf(day) + 1)
      .map((d) => d.raw.sleep);
    const times = typicalTimes(window);
    if (sleep.consistencyMin != null && times.bedMin != null && times.wakeMin != null) {
      body.append(
        h('h3', { class: 'sheet-section' }, 'Your rhythm'),
        h('p', { class: 'sheet-note' },
          `Over the last two weeks you've typically been asleep by ${formatClock(times.bedMin)} ` +
          `and awake at ${formatClock(times.wakeMin)}, with your wake time varying by about ` +
          `${Math.round(sleep.consistencyMin)} minutes. ` +
          (sleep.consistencyMin < 45
            ? 'That is a genuinely consistent schedule.'
            : 'Tightening that variation is usually the highest-return change available.')),
      );
    }

    if (night.sourceCount > 1) {
      body.append(
        h('p', { class: 'sheet-foot' },
          `${night.sourceCount} apps or devices recorded this night. Pulse merges their ` +
          `overlapping records rather than adding them up, so the total isn't inflated.`),
      );
    }
  });
}

// ─────────────────────────── HRV / vitals ───────────────────────────

export function openVitalsSheet(day: DerivedDay): void {
  openSheet({ eyebrow: formatFullDate(day.date), title: 'Vitals' }, (body) => {
    const hrv = day.raw.hrv;
    const baseline = day.baselines.hrv;

    body.append(
      readout(
        hrv == null ? '—' : String(Math.round(hrv)),
        ' ms',
        'var(--phosphor)',
        baseline && hrv != null
          ? `${signed(((hrv - baseline.mean) / baseline.mean) * 100, 0, '%')} against your ${Math.round(baseline.mean)} ms baseline.`
          : 'Heart rate variability, measured overnight.',
      ),
    );

    const note = confidenceNote(baseline?.confidence ?? 0, 'HRV baseline');
    if (note) body.append(note);

    body.append(
      statGrid([
        ['HRV (SDNN)', hrv == null ? '—' : `${Math.round(hrv)} ms`],
        ['HRV baseline', baseline ? `${Math.round(baseline.mean)} ms` : '—'],
        ['Resting HR', day.raw.rhr == null ? '—' : `${Math.round(day.raw.rhr)} bpm`],
        ['RHR baseline', day.baselines.rhr ? `${Math.round(day.baselines.rhr.mean)} bpm` : '—'],
        ['Respiratory rate', day.raw.respiratoryRate == null ? '—' : `${day.raw.respiratoryRate.toFixed(1)} br/min`],
        ['Blood oxygen', day.raw.spo2 == null ? '—' : percent(day.raw.spo2, 1)],
        ['Walking HR avg', day.raw.walkingHrAvg == null ? '—' : `${Math.round(day.raw.walkingHrAvg)} bpm`],
        ['VO₂ max', day.raw.vo2max == null ? '—' : num(day.raw.vo2max, 1)],
      ]),
      h('p', { class: 'sheet-foot' },
        'HRV here is SDNN — the standard deviation of the intervals between heartbeats, ' +
        'sampled while you sleep. Higher generally means a more recovered, less stressed ' +
        'nervous system. It is highly personal, so only the comparison against your own ' +
        'baseline is meaningful; comparing your number to someone else\'s is not.'),
    );

    if (baseline) {
      body.append(
        h('p', { class: 'sheet-foot' },
          `Your baseline is an exponentially-weighted average of the last ${baseline.n} readings, ` +
          `so recent days count for more than old ones. Its spread is ±${baseline.sd.toFixed(1)} ms, ` +
          `which is what "normal variation" means for you specifically.`),
      );
    }
  });
}
