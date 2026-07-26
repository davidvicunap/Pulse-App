/**
 * The recovery heatmap — a contribution-graph calendar.
 *
 * Its job is pattern recognition at a glance: streaks, the week you got ill, the month
 * your sleep fell apart. A line chart shows the same numbers but hides the *weekly*
 * structure, which is exactly where most people's patterns live (the Monday dip, the
 * weekend rebound).
 *
 * Built from DOM cells rather than canvas: each cell is a real button, so it's
 * keyboard-navigable and screen-reader-labelled for free — which a canvas heatmap
 * could only fake.
 */

import type { Model } from '../core/types';
import { h, render } from './dom';
import { addDays, dateFromKey, dateRange, formatFullDate, monthShort, weekdayOf } from '../core/dates';
import { haptic } from '../core/haptics';

export interface HeatmapOptions {
  model: Model;
  /** How many weeks to show. */
  weeks?: number;
  /** Last date in the grid. Defaults to the newest day in the model. */
  endDate?: string;
  onPick?: (date: string) => void;
}

const WEEKDAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

export class Heatmap {
  readonly el: HTMLElement;
  private options: HeatmapOptions;

  constructor(options: HeatmapOptions) {
    this.options = options;
    this.el = h('div', { class: 'heatmap' });
    this.draw();
  }

  update(options: Partial<HeatmapOptions>): void {
    this.options = { ...this.options, ...options };
    this.draw();
  }

  private draw(): void {
    const { model } = this.options;
    if (!model.days.length) {
      render(this.el, h('p', { class: 'empty-note' }, 'Import a Health export to see your calendar fill in.'));
      return;
    }

    const weeks = this.options.weeks ?? 20;
    const endDate = this.options.endDate ?? model.days[model.days.length - 1].date;

    // Extend to the end of the containing week so columns are always full.
    const endPadded = addDays(endDate, 6 - weekdayOf(endDate));
    const startDate = addDays(endPadded, -(weeks * 7 - 1));
    const all = dateRange(startDate, endPadded);

    const columns: HTMLElement[] = [];
    let current: HTMLElement[] = [];
    let lastMonth = -1;
    const monthLabels: Array<{ column: number; label: string }> = [];

    all.forEach((date, i) => {
      const day = model.byDate.get(date);
      const score = day?.recovery.score ?? null;
      const future = date > endDate;

      const cell = h('button', {
        class: `hm-cell${future ? ' is-future' : ''}`,
        type: 'button',
        // A day with no data is visually distinct from a day with a low score — this is
        // the whole reason the empty state gets its own treatment rather than a zero.
        'data-band': future ? 'future' : score == null ? 'none' : band(score),
        'aria-label': cellLabel(date, score, future),
        disabled: future || !day,
        style: score != null ? `--fill:${(0.35 + (score / 100) * 0.65).toFixed(2)}` : '',
        onclick: () => {
          if (!day) return;
          haptic('tick');
          this.options.onPick?.(date);
        },
      });
      current.push(cell);

      if (current.length === 7) {
        const columnIndex = columns.length;
        const month = dateFromKey(date).getMonth();
        // A month label needs three columns of clearance or it collides with the
        // previous one — which is how "Apr" and "May" ended up printed as "AprMay".
        const previous = monthLabels[monthLabels.length - 1];
        if (month !== lastMonth && (!previous || columnIndex - previous.column >= 3)) {
          monthLabels.push({ column: columnIndex, label: monthShort(date) });
          lastMonth = month;
        } else if (month !== lastMonth) {
          lastMonth = month;
        }
        columns.push(h('div', { class: 'hm-col' }, ...current));
        current = [];
      }
      void i;
    });
    if (current.length) columns.push(h('div', { class: 'hm-col' }, ...current));

    const labels = h('div', { class: 'hm-days', 'aria-hidden': 'true' },
      ...WEEKDAY_LABELS.map((label) => h('span', null, label)));

    const months = h('div', { class: 'hm-months', 'aria-hidden': 'true' },
      ...monthLabels.map(({ column, label }) =>
        h('span', { style: `grid-column:${column + 1}` }, label)));

    const legend = h('div', { class: 'hm-legend' },
      h('span', { class: 'hm-legend-label' }, 'Low'),
      ...(['low', 'mid', 'high'] as const).map((b) =>
        h('i', { class: 'hm-swatch', 'data-band': b, style: '--fill:0.9' })),
      h('span', { class: 'hm-legend-label' }, 'High'),
      h('span', { class: 'hm-legend-gap' }),
      h('i', { class: 'hm-swatch', 'data-band': 'none' }),
      h('span', { class: 'hm-legend-label' }, 'No data'),
    );

    render(
      this.el,
      h('div', { class: 'hm-scroll' },
        h('div', { class: 'hm-grid-wrap' },
          months,
          h('div', { class: 'hm-body' }, labels, h('div', { class: 'hm-grid', role: 'grid', 'aria-label': 'Recovery calendar' }, ...columns)),
        ),
      ),
      legend,
    );

    // Open scrolled to the most recent weeks, which is what people look at first.
    requestAnimationFrame(() => {
      const scroller = this.el.querySelector('.hm-scroll');
      if (scroller) scroller.scrollLeft = scroller.scrollWidth;
    });
  }
}

function band(score: number): 'low' | 'mid' | 'high' {
  return score >= 67 ? 'high' : score >= 34 ? 'mid' : 'low';
}

function cellLabel(date: string, score: number | null, future: boolean): string {
  if (future) return `${formatFullDate(date)}, in the future`;
  if (score == null) return `${formatFullDate(date)}, no recovery data`;
  return `${formatFullDate(date)}, recovery ${score} percent`;
}
