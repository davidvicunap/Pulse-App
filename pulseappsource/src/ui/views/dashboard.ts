/**
 * The dashboard — the screen people open in the morning.
 *
 * Order is deliberate and follows the question a user is actually asking, in sequence:
 *   1. How am I today?           → the recovery ring
 *   2. What are the parts?       → the metric rail
 *   3. So what should I do?      → the insight feed
 *   4. Is this working?          → recap, trends, calendar
 *   5. What patterns am I in?    → comparisons, correlations
 *
 * Everything above the fold is answerable in about two seconds; everything below is
 * there when you want to dig.
 */

import type { DerivedDay, Model } from '../../core/types';
import { getState, selectDate, selectIndex, setRange, visibleDays, type Range } from '../../core/store';
import { count, duration, relativeDays, signed } from '../../core/format';
import { daysBetween, formatDayLabel, todayKey, weekdayShort } from '../../core/dates';
import { METRIC_META, metricValue, type MetricKey } from '../../model/build';
import { MAX_STRAIN, strainBand } from '../../model/strain';
import { generateInsights, type Insight } from '../../insights/engine';
import { buildWeeklyRecap } from '../../insights/recap';
import { h, on, render } from '../dom';
import { EcgRibbon } from '../ecg';
import { RecoveryRing } from '../ring';
import { Chart, type ChartSeries } from '../chart';
import { Heatmap } from '../heatmap';
import { ComparisonPanel, CorrelationExplorer } from '../analysis';
import { haptic } from '../../core/haptics';
import { openRecoverySheet, openSleepSheet, openStrainSheet, openVitalsSheet } from '../sheets/metric-sheets';
import { openSettingsSheet } from '../sheets/settings-sheet';
import { openRecapSheet } from '../sheets/recap-sheet';

const RANGES: Range[] = [7, 30, 90, 365];

/** Charts shown in the Trends section, with the overlay each supports. */
const TREND_CHARTS: Array<{ key: MetricKey; overlay?: MetricKey; type: 'bar' | 'line' | 'area' }> = [
  { key: 'recovery', overlay: 'asleepMin', type: 'bar' },
  { key: 'strain', overlay: 'recovery', type: 'bar' },
  { key: 'asleepMin', overlay: 'sleepScore', type: 'bar' },
  { key: 'hrv', overlay: 'rhr', type: 'area' },
  { key: 'rhr', type: 'area' },
];

export class Dashboard {
  readonly el: HTMLElement;

  private ribbon = new EcgRibbon();
  private ring = new RecoveryRing();
  private charts = new Map<string, Chart>();
  private overlayOn = new Set<string>();
  private heatmap: Heatmap | null = null;
  private comparison: ComparisonPanel | null = null;
  private correlation: CorrelationExplorer | null = null;

  private dayNav!: HTMLElement;
  private heroNote!: HTMLElement;
  private railEl!: HTMLElement;
  private insightsEl!: HTMLElement;
  private recapEl!: HTMLElement;
  private chartsEl!: HTMLElement;
  private analysisEl!: HTMLElement;
  private footEl!: HTMLElement;
  private lastRenderedDate: string | null = null;

  constructor() {
    this.el = h('div', { class: 'dash' });
    this.build();
  }

  private build(): void {
    // ── Header ──
    const header = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, 'PULSE', h('small', null, ' · recovery')),
      h('div', { class: 'topbar-actions' },
        h('button', {
          class: 'icon-btn', type: 'button', 'aria-label': 'Settings',
          onclick: () => openSettingsSheet(),
        }, gearIcon()),
      ),
    );

    // ── Day navigation ──
    this.dayNav = h('div', { class: 'daynav' });

    // ── Hero ──
    this.heroNote = h('p', { class: 'hero-note' });
    const hero = h(
      'button',
      {
        class: 'hero',
        type: 'button',
        'aria-label': 'Recovery detail',
        onclick: () => {
          const day = this.currentDay();
          if (day) openRecoverySheet(day);
        },
      },
      h('div', { class: 'eyebrow' }, 'RECOVERY'),
      this.ring.el,
      this.heroNote,
      h('span', { class: 'hero-hint' }, 'Tap for the full breakdown'),
    );

    this.railEl = h('div', { class: 'rail' });
    this.insightsEl = h('div', { class: 'insights' });
    this.recapEl = h('div', { class: 'recap-slot' });
    this.chartsEl = h('div', { class: 'charts' });
    this.analysisEl = h('div', { class: 'analysis' });
    this.footEl = h('footer', { class: 'foot' });

    const rangeToggle = h(
      'div',
      { class: 'toggle', role: 'tablist', 'aria-label': 'Trend range' },
      ...RANGES.map((r) =>
        h('button', {
          class: 'toggle-btn',
          type: 'button',
          role: 'tab',
          dataset: { range: String(r) },
          onclick: () => {
            setRange(r);
            haptic('tick');
          },
        }, r === 365 ? '1Y' : `${r}D`),
      ),
    );

    this.el.append(
      this.ribbon.el,
      header,
      this.dayNav,
      hero,
      this.railEl,
      sectionHead('Insights'),
      this.insightsEl,
      this.recapEl,
      sectionHead('Trends', rangeToggle),
      this.chartsEl,
      this.analysisEl,
      this.footEl,
    );

    this.enableSwipe();
  }

  // ─────────────────────────── update ───────────────────────────

  update(): void {
    const state = getState();
    const model = state.model;
    if (!model || !model.days.length) return;

    const day = model.days[state.selectedIndex];
    if (!day) return;
    const dayChanged = this.lastRenderedDate !== day.date;
    this.lastRenderedDate = day.date;

    // The ribbon is a reading, not decoration — it redraws from this day's physiology.
    this.ribbon.update(
      { restingHr: day.raw.rhr, hrv: day.raw.hrv, recovery: day.recovery.score },
      dayChanged,
    );

    this.renderDayNav(model, state.selectedIndex);
    this.renderHero(day);
    this.renderRail(day, model);
    this.renderInsights(model, state.selectedIndex);
    this.renderRecap(model, state.selectedIndex);
    this.renderRangeToggle(state.range);
    this.renderCharts();
    this.renderFoot(model);
    // The calendar, comparisons and correlation explorer are all below the fold and
    // collectively the most expensive thing on the page. Building them in the same
    // frame as the hero pushed first paint past half a second, so they're deferred to
    // idle time — the part of the screen you can actually see arrives first.
    this.scheduleAnalysis(model, state.selectedIndex);
  }

  private currentDay(): DerivedDay | null {
    const state = getState();
    return state.model?.days[state.selectedIndex] ?? null;
  }

  private renderDayNav(model: Model, index: number): void {
    const day = model.days[index];
    const isLatest = index === model.days.length - 1;
    const gap = daysBetween(day.date, todayKey());

    render(
      this.dayNav,
      h('button', {
        class: 'navbtn', type: 'button', 'aria-label': 'Previous day',
        disabled: index === 0,
        onclick: () => this.step(-1),
      }, '‹'),
      h('div', { class: 'daynav-center' },
        h('div', { class: 'daynav-weekday' }, weekdayShort(day.date)),
        h('div', { class: 'daynav-date' },
          formatDayLabel(day.date),
          isLatest
            ? h('span', { class: 'daynav-tag' }, gap <= 1 ? ' · latest' : ` · ${relativeDays(gap)}`)
            : null,
        ),
      ),
      h('button', {
        class: 'navbtn', type: 'button', 'aria-label': 'Next day',
        disabled: isLatest,
        onclick: () => this.step(1),
      }, '›'),
    );
  }

  private step(delta: number): void {
    const state = getState();
    const next = state.selectedIndex + delta;
    if (next < 0 || next >= (state.model?.days.length ?? 0)) {
      haptic('bump');
      return;
    }
    haptic('tick');
    selectIndex(next);
  }

  private renderHero(day: DerivedDay): void {
    const { recovery } = day;
    this.ring.set({
      score: recovery.score,
      band: recovery.band,
      confidence: recovery.confidence,
      label: recovery.score == null ? 'NO DATA' : recovery.band.toUpperCase(),
    });

    if (recovery.score == null) {
      this.heroNote.textContent =
        'No HRV, resting heart rate or sleep was recorded for this day, so there is nothing to score.';
      return;
    }
    const top = recovery.components
      .slice()
      .sort((a, b) => b.weight * b.score - a.weight * a.score)[0];
    this.heroNote.innerHTML =
      recovery.band === 'high'
        ? `Your system is <b>primed to perform</b>. ${top ? escapeHtml(top.detail) : ''}`
        : recovery.band === 'moderate'
          ? `You're in a <b>moderate</b> zone. ${top ? escapeHtml(top.detail) : ''}`
          : `Your body is asking for <b>recovery</b>. ${top ? escapeHtml(top.detail) : ''}`;
  }

  /** The three tappable metric cards. Every one opens its own explanation. */
  private renderRail(day: DerivedDay, model: Model): void {
    const cards: Array<{
      label: string;
      value: string;
      unit?: string;
      sub: string;
      tone: string;
      spark: MetricKey;
      onOpen: () => void;
    }> = [
      {
        label: 'Strain',
        value: day.strain.method === 'none' ? '—' : day.strain.score.toFixed(1),
        unit: `/${MAX_STRAIN}`,
        sub: day.strain.method === 'none'
          ? 'no data'
          : day.strain.method === 'energy-proxy'
            ? 'estimated'
            : strainBand(day.strain.score),
        tone: 'cardio',
        spark: 'strain',
        onOpen: () => openStrainSheet(day, model),
      },
      {
        label: 'Sleep',
        value: day.raw.sleep ? duration(day.raw.sleep.asleepMin) : '—',
        sub: day.sleep.score == null
          ? 'not recorded'
          : `${day.sleep.score}% of need`,
        tone: 'somnus',
        spark: 'asleepMin',
        onOpen: () => openSleepSheet(day, model),
      },
      {
        label: 'HRV',
        value: day.raw.hrv == null ? '—' : String(Math.round(day.raw.hrv)),
        unit: ' ms',
        sub: day.baselines.hrv && day.raw.hrv != null
          ? `${signed(day.raw.hrv - day.baselines.hrv.mean, 0)} vs base`
          : 'building baseline',
        tone: 'phosphor',
        spark: 'hrv',
        onOpen: () => openVitalsSheet(day),
      },
    ];

    render(
      this.railEl,
      ...cards.map((card) =>
        h('button', {
          class: 'card', type: 'button',
          dataset: { tone: card.tone },
          'aria-label': `${card.label}: ${card.value}${card.unit ?? ''}. ${card.sub}. Tap for detail.`,
          onclick: card.onOpen,
        },
          h('div', { class: 'card-label' }, card.label),
          h('div', { class: 'card-value' }, card.value, card.unit ? h('span', { class: 'card-unit' }, card.unit) : null),
          h('div', { class: 'card-sub' }, card.sub),
          this.sparkline(card.spark, card.tone),
        ),
      ),
    );
  }

  /** A 14-day sparkline, rendered as an inline SVG path. */
  private sparkline(key: MetricKey, tone: string): SVGElement | null {
    const state = getState();
    const model = state.model;
    if (!model) return null;
    const from = Math.max(0, state.selectedIndex - 13);
    const values: (number | null)[] = [];
    for (let i = from; i <= state.selectedIndex; i++) values.push(metricValue(model.days[i], key));

    const points = values.map((v, i) => ({ v, i })).filter((p) => p.v != null) as Array<{ v: number; i: number }>;
    if (points.length < 3) return null;

    const min = Math.min(...points.map((p) => p.v));
    const max = Math.max(...points.map((p) => p.v));
    const range = max - min || 1;
    const W = 46;
    const H = 18;
    const step = W / Math.max(1, values.length - 1);
    const d = points
      .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${(p.i * step).toFixed(1)} ${(H - ((p.v - min) / range) * H).toFixed(1)}`)
      .join(' ');

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'spark');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', `var(--${tone})`);
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  private renderInsights(model: Model, index: number): void {
    const insights = generateInsights(model, index, 5);
    render(this.insightsEl, ...insights.map((insight) => insightCard(insight)));
  }

  private renderRecap(model: Model, index: number): void {
    const recap = buildWeeklyRecap(model, index);
    if (!recap) {
      render(this.recapEl);
      return;
    }
    render(
      this.recapEl,
      h('button', {
        class: 'recap-card', type: 'button',
        onclick: () => openRecapSheet(recap),
        'aria-label': 'Open weekly recap',
      },
        h('div', { class: 'recap-head' },
          h('span', { class: 'eyebrow' }, 'WEEKLY RECAP'),
          h('span', { class: 'recap-range' }, `${formatDayLabel(recap.startDate)} – ${formatDayLabel(recap.endDate)}`),
        ),
        h('p', { class: 'recap-headline' }, recap.headline),
        h('div', { class: 'recap-metrics' },
          ...recap.metrics.slice(0, 4).map((m) =>
            h('div', { class: 'recap-metric' },
              h('div', { class: 'recap-metric-label' }, m.label),
              h('div', { class: 'recap-metric-value' }, m.value == null ? '—' : m.format(m.value)),
              m.changePct == null
                ? null
                : h('div', {
                    class: `recap-metric-delta ${m.favourable ? 'is-good' : m.favourable === false ? 'is-bad' : ''}`,
                  }, signed(m.changePct, 0, '%')),
            ),
          ),
        ),
      ),
    );
  }

  private renderRangeToggle(range: Range): void {
    for (const btn of this.el.querySelectorAll<HTMLElement>('.toggle-btn')) {
      btn.classList.toggle('is-on', btn.dataset.range === String(range));
      btn.setAttribute('aria-selected', btn.dataset.range === String(range) ? 'true' : 'false');
    }
  }

  private renderCharts(): void {
    const days = visibleDays();
    if (days.length < 2) {
      render(this.chartsEl,
        h('p', { class: 'empty-note' }, 'A couple more days of data and the trends appear here.'));
      this.charts.clear();
      return;
    }

    const dates = days.map((d) => d.date);
    const offset = getState().selectedIndex + 1 - days.length;

    // Rebuild the container only when the set of charts changes; otherwise update in
    // place so zoom state and the draw animation survive a range change.
    const needsRebuild = this.chartsEl.childElementCount !== TREND_CHARTS.length;
    if (needsRebuild) {
      render(this.chartsEl);
      this.charts.clear();
    }

    TREND_CHARTS.forEach((def, position) => {
      const meta = METRIC_META[def.key];
      const overlayActive = def.overlay != null && this.overlayOn.has(def.key);
      const series: ChartSeries[] = [seriesFor(days, def.key, def.type)];
      if (overlayActive && def.overlay) series.push(seriesFor(days, def.overlay, 'line'));

      const existing = this.charts.get(def.key);
      if (existing && !needsRebuild) {
        existing.setData({
          dates,
          series,
          onPick: (i) => selectIndex(offset + i),
        });
        const badge = this.chartsEl.querySelector(`[data-overlay-for="${def.key}"]`);
        badge?.classList.toggle('is-on', overlayActive);
        return;
      }

      const chart = new Chart({
        dates,
        series,
        onPick: (i) => selectIndex(offset + i),
      });
      this.charts.set(def.key, chart);

      const head = h('div', { class: 'chart-head' },
        h('span', { class: 'chart-name' }, meta.label),
        def.overlay
          ? h('button', {
              class: `overlay-btn${overlayActive ? ' is-on' : ''}`,
              type: 'button',
              dataset: { overlayFor: def.key },
              'aria-pressed': overlayActive ? 'true' : 'false',
              onclick: () => {
                if (this.overlayOn.has(def.key)) this.overlayOn.delete(def.key);
                else this.overlayOn.add(def.key);
                haptic('tick');
                this.renderCharts();
              },
            }, `+ ${METRIC_META[def.overlay].label}`)
          : null,
      );

      const block = h('section', { class: 'chart-block' }, head, chart.el);
      if (needsRebuild || position >= this.chartsEl.childElementCount) this.chartsEl.append(block);
    });
  }

  /**
   * Coalesces analysis rebuilds into a single idle callback.
   *
   * Paging through days fires `update()` on every tap; without this, each tap would
   * rebuild ~140 heatmap cells and re-run every correlation before the next frame.
   */
  private scheduleAnalysis(model: Model, index: number): void {
    this.pendingAnalysis = { model, index };
    if (this.analysisScheduled) return;
    this.analysisScheduled = true;

    const run = () => {
      this.analysisScheduled = false;
      const pending = this.pendingAnalysis;
      if (pending) this.renderAnalysis(pending.model, pending.index);
    };

    const idle = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    // Safari still lacks requestIdleCallback, so fall back to a macrotask — the point
    // is only to land after paint, not to be clever about scheduling.
    if (idle) idle(run, { timeout: 400 });
    else setTimeout(run, 32);
  }

  private analysisScheduled = false;
  private pendingAnalysis: { model: Model; index: number } | null = null;

  private renderAnalysis(model: Model, index: number): void {
    if (!this.heatmap) {
      this.heatmap = new Heatmap({
        model,
        onPick: (date) => {
          selectDate(date);
          this.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
      });
      this.comparison = new ComparisonPanel(model, index);
      this.correlation = new CorrelationExplorer(model);

      render(
        this.analysisEl,
        sectionHead('Calendar'),
        h('p', { class: 'section-note' }, 'Every day you have data for, coloured by recovery. Tap any square to open it.'),
        this.heatmap.el,
        sectionHead('Comparisons'),
        h('p', { class: 'section-note' }, 'How your numbers differ across the splits that usually matter.'),
        this.comparison.el,
        sectionHead('Correlations'),
        h('p', { class: 'section-note' }, 'How two of your metrics move together — with a lag, where a lag makes sense.'),
        this.correlation.el,
      );
    } else {
      this.heatmap.update({ model, endDate: model.days[index].date });
      this.comparison?.update(model, index);
      this.correlation?.update(model);
    }
  }

  private renderFoot(model: Model): void {
    const { profile } = model;
    const state = getState();
    const lastDate = profile.lastDate;
    const staleness = lastDate ? daysBetween(lastDate, todayKey()) : 0;

    render(
      this.footEl,
      staleness > 2
        ? h('div', { class: 'note' },
            `Your data ends ${formatDayLabel(lastDate!)} — ${relativeDays(staleness)}. `,
            h('button', {
              class: 'link-btn', type: 'button',
              onclick: () => document.dispatchEvent(new CustomEvent('pulse:import')),
            }, 'Import a fresh export'),
            ' to catch up.')
        : null,
      h('div', { class: 'privacy-strip' },
        shieldIcon(),
        h('p', null,
          h('b', null, 'Everything stays on this device. '),
          `${count(profile.daysWithData)} days are stored locally in your browser. No account, no server, nothing uploaded — `,
          h('button', {
            class: 'link-btn', type: 'button',
            onclick: () => openSettingsSheet('privacy'),
          }, 'manage or delete your data'),
          '.'),
      ),
      h('p', { class: 'foot-meta' },
        `${count(profile.daysWithData)} days · sleep need ${duration(profile.sleepNeedMin)} · ` +
        `max HR ${profile.maxHr}${profile.maxHrIsUserSet ? '' : ' (estimated)'} · ` +
        `resting ${profile.restingHr} bpm · range ${state.range === 365 ? '1Y' : `${state.range}D`}`),
    );
  }

  /** Swipe left/right to move between days — the gesture the day nav implies. */
  private enableSwipe(): void {
    let startX = 0;
    let startY = 0;
    let tracking = false;

    on(this.el, 'touchstart', (e: TouchEvent) => {
      // Don't hijack a swipe that starts on a chart — that's a scrub.
      if ((e.target as HTMLElement).closest('.chart-surface, .hm-scroll, .chip-row')) return;
      tracking = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });

    on(this.el, 'touchend', (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      // Require a mostly-horizontal, deliberate movement.
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
      this.step(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  destroy(): void {
    for (const chart of this.charts.values()) chart.destroy();
    this.charts.clear();
    this.ring.destroy();
  }
}

// ─────────────────────────── helpers ───────────────────────────

function seriesFor(days: readonly DerivedDay[], key: MetricKey, type: 'bar' | 'line' | 'area'): ChartSeries {
  const meta = METRIC_META[key];
  const divisor = key === 'asleepMin' ? 60 : 1;
  return {
    key,
    label: meta.label,
    color: meta.color,
    type,
    unit: key === 'asleepMin' ? 'h' : meta.unit,
    decimals: key === 'asleepMin' ? 1 : meta.decimals,
    domain: key === 'recovery' ? [0, 100] : key === 'strain' ? [0, MAX_STRAIN] : undefined,
    values: days.map((d) => {
      const v = metricValue(d, key);
      return v == null ? null : v / divisor;
    }),
  };
}

function insightCard(insight: Insight): HTMLElement {
  return h('article', { class: 'insight', dataset: { tone: insight.tone } },
    h('div', { class: 'insight-bar' }),
    h('div', { class: 'insight-body' },
      h('h3', null, insight.title),
      h('p', null, insight.body),
      insight.action ? h('p', { class: 'insight-action' }, h('b', null, 'Do this: '), insight.action) : null,
      insight.evidence?.length
        ? h('div', { class: 'insight-evidence' },
            ...insight.evidence.map((e) => h('span', { class: 'evidence-chip' }, e)))
        : null,
    ),
  );
}

function sectionHead(title: string, trailing?: HTMLElement): HTMLElement {
  return h('div', { class: 'section-head' }, h('h2', null, title), trailing ?? null);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function gearIcon(): SVGElement {
  return iconFrom(
    '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  );
}

function shieldIcon(): SVGElement {
  return iconFrom(
    '<path d="M12 2 4 5v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V5l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
    'var(--vital)',
  );
}

function iconFrom(paths: string, stroke = 'currentColor'): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', stroke);
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths;
  return svg;
}
