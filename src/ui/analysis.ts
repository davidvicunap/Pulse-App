/**
 * Analysis modules: comparisons and the correlation explorer.
 *
 * These answer the questions a daily dashboard can't — "is my training actually costing
 * me?", "does sleep really matter for me, or just in general?". Both are built to be
 * honest about weak evidence: a comparison that isn't a meaningful effect says so, and a
 * correlation below the sample threshold refuses to draw at all.
 */

import type { Model } from '../core/types';
import { h, fitCanvas, render, token } from './dom';
import { resolveColor, withAlpha } from './chart';
import { METRIC_META, type MetricKey } from '../model/build';
import { duration } from '../core/format';
import {
  correlate,
  describeCorrelation,
  standardComparisons,
  thresholdEffect,
  type Comparison,
  type Correlation,
} from '../insights/analytics';

// ─────────────────────────── comparisons ───────────────────────────

const COMPARISON_METRICS: MetricKey[] = ['recovery', 'hrv', 'asleepMin', 'rhr'];

export class ComparisonPanel {
  readonly el: HTMLElement;
  private metric: MetricKey = 'recovery';
  private model: Model;
  private endIndex: number;

  constructor(model: Model, endIndex: number) {
    this.model = model;
    this.endIndex = endIndex;
    this.el = h('div', { class: 'panel' });
    this.draw();
  }

  update(model: Model, endIndex: number): void {
    this.model = model;
    this.endIndex = endIndex;
    this.draw();
  }

  private draw(): void {
    const days = this.model.days.slice(Math.max(0, this.endIndex - 89), this.endIndex + 1);
    const comparisons = standardComparisons(days, this.metric);

    const picker = h(
      'div',
      { class: 'chip-row', role: 'tablist', 'aria-label': 'Metric to compare' },
      ...COMPARISON_METRICS.map((key) =>
        h('button', {
          class: `chip${key === this.metric ? ' is-on' : ''}`,
          type: 'button',
          role: 'tab',
          'aria-selected': key === this.metric ? 'true' : 'false',
          onclick: () => {
            this.metric = key;
            this.draw();
          },
        }, METRIC_META[key].label),
      ),
    );

    render(
      this.el,
      picker,
      comparisons.length
        ? h('div', { class: 'compare-list' }, ...comparisons.map((c) => this.row(c)))
        : h('p', { class: 'empty-note' },
            'Not enough days in each group yet to compare. This fills in after a couple of weeks.'),
    );
  }

  private row(c: Comparison): HTMLElement {
    const meta = METRIC_META[this.metric];
    const format = (v: number) => (this.metric === 'asleepMin' ? duration(v) : v.toFixed(meta.decimals) + meta.unit);
    // Only mark a side as leading when the difference is real. Highlighting a winner
    // between two identical bars reads as a rendering fault, not a finding.
    const leadA = c.meaningful && c.groupA.mean > c.groupB.mean;
    const leadB = c.meaningful && c.groupB.mean > c.groupA.mean;
    const max = Math.max(c.groupA.mean, c.groupB.mean) || 1;

    const bar = (label: string, value: number, n: number, lead: boolean) =>
      h('div', { class: `compare-side${lead ? ' is-lead' : ''}` },
        h('div', { class: 'compare-label' }, label, h('span', { class: 'compare-n' }, `${n}d`)),
        h('div', { class: 'compare-bar' },
          h('i', { style: `width:${(value / max) * 100}%;--c:${meta.color}` }),
          h('b', null, format(value)),
        ),
      );

    return h('div', { class: 'compare-row' },
      bar(c.groupA.label, c.groupA.mean, c.groupA.n, leadA),
      bar(c.groupB.label, c.groupB.mean, c.groupB.n, leadB),
      h('p', { class: 'compare-verdict' }, verdict(c)),
    );
  }
}

/**
 * The verdict sentence.
 *
 * Must never contradict the bars the user is looking at. A 12% gap described flatly as
 * "small" reads as the app arguing with its own chart — so when the averages differ but
 * the effect size doesn't clear the bar, the copy names the gap *and* explains why it
 * isn't yet a finding: the spread within each group swamps the difference between them.
 */
function verdict(c: Comparison): string {
  const gap = Math.abs(c.deltaPct);
  const higher = c.deltaPct > 0 ? c.groupA.label : c.groupB.label;
  const lower = c.deltaPct > 0 ? c.groupB.label : c.groupA.label;

  if (c.meaningful) {
    return `${higher} run ${gap.toFixed(0)}% higher than ${lower.toLowerCase()} — consistently enough to be a real pattern, not noise.`;
  }
  if (gap < 3) {
    return `Essentially no difference between ${c.groupA.label.toLowerCase()} and ${c.groupB.label.toLowerCase()}.`;
  }
  return (
    `${higher} average ${gap.toFixed(0)}% higher, but day-to-day spread within each group is ` +
    `wider than the gap between them — so this isn't a pattern to act on yet.`
  );
}

// ─────────────────────────── correlation explorer ───────────────────────────

interface Pairing {
  id: string;
  x: MetricKey;
  y: MetricKey;
  lag: number;
  label: string;
  /** Threshold on x used to phrase the takeaway, in x's own units. */
  threshold?: number;
  thresholdLabel?: string;
}

/**
 * Lag needs care here, and getting it wrong silently produces "no relationship".
 *
 * A night is attributed to the **morning it ends on**, and the HRV and resting heart
 * rate that scored that morning were measured during that same night. So "last night's
 * sleep versus how I woke up" is a **lag of 0**, not 1 — using lag 1 would be asking
 * how last night's sleep affects *tomorrow* morning, a genuinely weaker relationship.
 *
 * Strain is the opposite case: it accumulates during the waking day, so its effect
 * lands on the following morning's recovery, and lag 1 is correct.
 */
const PAIRINGS: Pairing[] = [
  {
    id: 'sleep-recovery',
    x: 'asleepMin', y: 'recovery', lag: 0,
    label: 'Sleep → that morning’s recovery',
    threshold: 420, thresholdLabel: '7 hours',
  },
  {
    id: 'strain-recovery',
    x: 'strain', y: 'recovery', lag: 1,
    label: 'Strain → next-day recovery',
    threshold: 14, thresholdLabel: 'a strain of 14',
  },
  {
    id: 'sleep-hrv',
    x: 'asleepMin', y: 'hrv', lag: 0,
    label: 'Sleep → overnight HRV',
    threshold: 420, thresholdLabel: '7 hours',
  },
  {
    id: 'hrv-recovery',
    x: 'hrv', y: 'recovery', lag: 0,
    label: 'HRV → same-day recovery',
  },
  {
    id: 'efficiency-recovery',
    x: 'efficiency', y: 'recovery', lag: 0,
    label: 'Sleep efficiency → recovery',
  },
];

export class CorrelationExplorer {
  readonly el: HTMLElement;
  private pairing = PAIRINGS[0];
  private model: Model;
  private canvas: HTMLCanvasElement;
  private plot: HTMLElement;
  private body: HTMLElement;

  constructor(model: Model) {
    this.model = model;
    this.canvas = h('canvas', { class: 'scatter-canvas' }) as HTMLCanvasElement;
    this.plot = h('div', { class: 'scatter' }, this.canvas);
    this.body = h('div', { class: 'scatter-body' });
    this.el = h('div', { class: 'panel' });
    this.draw();

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.drawScatter()).observe(this.plot);
    }
  }

  update(model: Model): void {
    this.model = model;
    this.draw();
  }

  private draw(): void {
    const picker = h(
      'div',
      { class: 'chip-row', role: 'tablist', 'aria-label': 'Relationship to explore' },
      ...PAIRINGS.map((p) =>
        h('button', {
          class: `chip${p.id === this.pairing.id ? ' is-on' : ''}`,
          type: 'button',
          role: 'tab',
          'aria-selected': p.id === this.pairing.id ? 'true' : 'false',
          onclick: () => {
            this.pairing = p;
            this.draw();
          },
        }, p.label),
      ),
    );

    render(this.el, picker, this.plot, this.body);
    this.drawScatter();
  }

  private currentCorrelation(): Correlation | null {
    return correlate(this.model, this.pairing.x, this.pairing.y, this.pairing.lag);
  }

  private drawScatter(): void {
    const c = this.currentCorrelation();
    if (!c) {
      this.plot.style.display = 'none';
      render(this.body,
        h('p', { class: 'empty-note' },
          'Needs about two weeks of days with both signals before a relationship means anything.'),
      );
      return;
    }
    this.plot.style.display = '';

    const rect = this.plot.getBoundingClientRect();
    const width = rect.width || 300;
    const height = 190;
    const ctx = fitCanvas(this.canvas, width, height);
    if (!ctx) return;

    const pad = { l: 34, r: 10, t: 12, b: 26 };
    const plotW = width - pad.l - pad.r;
    const plotH = height - pad.t - pad.b;

    const xs = c.points.map((p) => p.x);
    const ys = c.points.map((p) => p.y);
    const xLo = Math.min(...xs);
    const xHi = Math.max(...xs);
    const yLo = Math.min(...ys);
    const yHi = Math.max(...ys);
    const xRange = xHi - xLo || 1;
    const yRange = yHi - yLo || 1;

    const X = (v: number) => pad.l + ((v - xLo) / xRange) * plotW;
    const Y = (v: number) => pad.t + plotH - ((v - yLo) / yRange) * plotH;

    // Axes
    ctx.strokeStyle = withAlpha(token('--hairline') || '#1E2434', 0.9);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t);
    ctx.lineTo(pad.l, pad.t + plotH);
    ctx.lineTo(pad.l + plotW, pad.t + plotH);
    ctx.stroke();

    // The threshold that the takeaway sentence refers to, drawn so the claim is visible.
    if (this.pairing.threshold != null && this.pairing.threshold > xLo && this.pairing.threshold < xHi) {
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = withAlpha(token('--caution') || '#FBBF24', 0.6);
      ctx.beginPath();
      ctx.moveTo(X(this.pairing.threshold), pad.t);
      ctx.lineTo(X(this.pairing.threshold), pad.t + plotH);
      ctx.stroke();
      ctx.restore();
    }

    // Points
    const accent = resolveColor(METRIC_META[this.pairing.y].color);
    for (const p of c.points) {
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), 3, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(accent, 0.5);
      ctx.fill();
    }

    // Trend line, only when there's actually a relationship to draw.
    if (c.strength !== 'none') {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(X(xLo), Y(c.slope * xLo + c.intercept));
      ctx.lineTo(X(xHi), Y(c.slope * xHi + c.intercept));
      ctx.stroke();
    }

    // Axis labels
    ctx.fillStyle = token('--iron') || '#6B738C';
    ctx.font = `500 9.5px ${token('--mono') || 'monospace'}`;
    ctx.textBaseline = 'top';
    const fmtX = (v: number) => (this.pairing.x === 'asleepMin' ? (v / 60).toFixed(1) : v.toFixed(0));
    ctx.fillText(fmtX(xLo), pad.l, pad.t + plotH + 7);
    const hiLabel = fmtX(xHi);
    ctx.fillText(hiLabel, pad.l + plotW - ctx.measureText(hiLabel).width, pad.t + plotH + 7);
    ctx.textBaseline = 'middle';
    ctx.fillText(yHi.toFixed(0), 4, pad.t + 4);
    ctx.fillText(yLo.toFixed(0), 4, pad.t + plotH - 4);

    this.renderTakeaway(c);
  }

  private renderTakeaway(c: Correlation): void {
    const meta = { x: METRIC_META[this.pairing.x], y: METRIC_META[this.pairing.y] };
    const children: (HTMLElement | null)[] = [
      h('div', { class: 'scatter-axes' },
        h('span', null, `↔ ${meta.x.label}${this.pairing.x === 'asleepMin' ? ' (hours)' : ''}`),
        h('span', null, `↕ ${meta.y.label}${this.pairing.lag ? ' (next day)' : ''}`),
      ),
      h('p', { class: 'scatter-verdict' }, describeCorrelation(c)),
    ];

    if (this.pairing.threshold != null) {
      const effect = thresholdEffect(c, this.pairing.threshold);
      if (effect && Math.abs(effect.deltaPct) >= 4) {
        const worse = effect.deltaPct < 0;
        children.push(
          h('div', { class: `note ${worse ? 'note-caution' : ''}` },
            h('strong', null, 'Your takeaway. '),
            `Days below ${this.pairing.thresholdLabel} average ` +
            `${formatValue(effect.below, this.pairing.y)} ${meta.y.label.toLowerCase()}, against ` +
            `${formatValue(effect.above, this.pairing.y)} above it — a difference of ` +
            `${Math.abs(effect.deltaPct).toFixed(0)}%. Based on ${effect.nBelow} and ${effect.nAbove} days.`,
          ),
        );
      }
    }

    children.push(
      h('p', { class: 'sheet-foot' },
        'This is an association in your own data, not proof of cause. Plenty of things ' +
        'move these numbers together — but it is your data, which makes it a better guide ' +
        'than a population average.'),
    );

    render(this.body, ...children.filter(Boolean));
  }
}

function formatValue(value: number, key: MetricKey): string {
  if (key === 'asleepMin') return duration(value);
  const meta = METRIC_META[key];
  return `${value.toFixed(meta.decimals)}${meta.unit}`;
}
