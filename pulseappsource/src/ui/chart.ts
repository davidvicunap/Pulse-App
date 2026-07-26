/**
 * The interactive chart.
 *
 * Canvas rather than SVG: these charts carry 90+ points, support live scrubbing and
 * pinch-zoom, and are drawn several to a screen. An SVG node per point would make
 * scrubbing janky on a phone, whereas a canvas redraw is a single compositor operation.
 *
 * Interactions supported, all on the same surface:
 *   - drag to scrub, with a crosshair and a live readout
 *   - pinch (two pointers) or wheel to zoom into a range
 *   - tap to select that day
 *   - double-tap to reset the zoom
 *   - arrow keys to scrub, +/− to zoom, Enter to select
 *
 * Everything is redrawn on `requestAnimationFrame` and only when marked dirty, so a
 * scrub that fires 120 pointer events a second still costs one paint per frame.
 */

import { fitCanvas, h, on, prefersReducedMotion, token } from './dom';
import { haptic } from '../core/haptics';
import { formatDayLabel } from '../core/dates';

export interface ChartSeries {
  key: string;
  label: string;
  values: (number | null)[];
  /** A CSS custom property name (`--vital`) or a literal colour. */
  color: string;
  type: 'line' | 'bar' | 'area';
  unit: string;
  decimals: number;
  /** Fixed y-domain, for bounded metrics like recovery (0–100). */
  domain?: [number, number];
}

export interface ChartOptions {
  dates: string[];
  series: ChartSeries[];
  height?: number;
  showAverage?: boolean;
  /** Fired when the user commits to a day (tap / Enter). */
  onPick?: (index: number) => void;
  /** Fired continuously while scrubbing; `null` when the scrub ends. */
  onScrub?: (index: number | null) => void;
}

const PAD = { top: 12, right: 10, bottom: 20, left: 10 };

export class Chart {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private readout: HTMLElement;
  private options: ChartOptions;
  private width = 0;
  private height: number;

  /** Visible index window — the zoom state. */
  private viewStart = 0;
  private viewEnd = 0;
  private cursor: number | null = null;

  private dirty = true;
  private raf = 0;
  private drawProgress = 0;
  private disposers: Array<() => void> = [];
  private resizeObserver: ResizeObserver | null = null;

  constructor(options: ChartOptions) {
    this.options = options;
    this.height = options.height ?? 132;
    this.viewEnd = Math.max(0, options.dates.length - 1);

    this.canvas = h('canvas', { class: 'chart-canvas' }) as HTMLCanvasElement;
    this.readout = h('div', { class: 'chart-readout', 'aria-live': 'polite' });

    const surface = h(
      'div',
      {
        class: 'chart-surface',
        tabindex: '0',
        role: 'application',
        'aria-label': this.ariaLabel(),
      },
      this.canvas,
    );

    this.el = h('div', { class: 'chart' }, this.readout, surface);
    this.attach(surface);
  }

  private ariaLabel(): string {
    const names = this.options.series.map((s) => s.label).join(' and ');
    return `${names} chart. Use left and right arrows to read values, plus and minus to zoom, Enter to open that day.`;
  }

  /** Replaces the data, preserving the zoom when the length is unchanged. */
  setData(options: ChartOptions): void {
    const sameLength = options.dates.length === this.options.dates.length;
    this.options = options;
    if (!sameLength) {
      this.viewStart = 0;
      this.viewEnd = Math.max(0, options.dates.length - 1);
      this.cursor = null;
    }
    this.drawProgress = prefersReducedMotion() ? 1 : 0;
    this.markDirty();
  }

  private attach(surface: HTMLElement): void {
    // ── Pointer: scrub, tap, pinch ──
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchStart: { distance: number; start: number; end: number } | null = null;
    let downAt = 0;
    let moved = false;
    let lastTap = 0;

    const indexAt = (clientX: number): number => {
      const rect = this.canvas.getBoundingClientRect();
      const plotWidth = rect.width - PAD.left - PAD.right;
      const ratio = (clientX - rect.left - PAD.left) / Math.max(1, plotWidth);
      const span = this.viewEnd - this.viewStart;
      return clamp(Math.round(this.viewStart + ratio * span), this.viewStart, this.viewEnd);
    };

    this.disposers.push(
      on(surface, 'pointerdown', (e: PointerEvent) => {
        surface.setPointerCapture?.(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        downAt = Date.now();
        moved = false;
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          pinchStart = {
            distance: Math.hypot(a.x - b.x, a.y - b.y),
            start: this.viewStart,
            end: this.viewEnd,
          };
        } else {
          this.setCursor(indexAt(e.clientX));
        }
      }),

      on(surface, 'pointermove', (e: PointerEvent) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        moved = true;

        if (pointers.size === 2 && pinchStart) {
          const [a, b] = [...pointers.values()];
          const distance = Math.hypot(a.x - b.x, a.y - b.y);
          this.applyPinch(pinchStart, distance);
          return;
        }
        // Scrubbing should own the gesture once it starts, or the page scrolls under it.
        e.preventDefault();
        this.setCursor(indexAt(e.clientX));
      }),

      on(surface, 'pointerup', (e: PointerEvent) => {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinchStart = null;

        const quick = Date.now() - downAt < 260;
        if (quick && !moved) {
          const now = Date.now();
          if (now - lastTap < 320) {
            this.resetZoom();
          } else if (this.cursor != null) {
            this.options.onPick?.(this.cursor);
            haptic('open');
          }
          lastTap = now;
        }
        if (!pointers.size) this.endScrub();
      }),

      on(surface, 'pointercancel', (e: PointerEvent) => {
        pointers.delete(e.pointerId);
        pinchStart = null;
        if (!pointers.size) this.endScrub();
      }),

      // ── Wheel: zoom around the pointer ──
      on(surface, 'wheel', (e: WheelEvent) => {
        if (this.options.dates.length < 4) return;
        e.preventDefault();
        const focus = indexAt(e.clientX);
        this.zoomBy(e.deltaY > 0 ? 1.18 : 1 / 1.18, focus);
      }, { passive: false }),

      // ── Keyboard ──
      on(surface, 'keydown', (e: KeyboardEvent) => {
        const span = this.viewEnd - this.viewStart;
        switch (e.key) {
          case 'ArrowLeft':
          case 'ArrowRight': {
            e.preventDefault();
            const step = e.key === 'ArrowLeft' ? -1 : 1;
            const next = this.cursor == null ? this.viewEnd : this.cursor + step;
            if (next < this.viewStart || next > this.viewEnd) {
              haptic('bump');
              return;
            }
            this.setCursor(next);
            break;
          }
          case 'Home':
            e.preventDefault();
            this.setCursor(this.viewStart);
            break;
          case 'End':
            e.preventDefault();
            this.setCursor(this.viewEnd);
            break;
          case '+':
          case '=':
            e.preventDefault();
            this.zoomBy(1 / 1.35, this.cursor ?? Math.round((this.viewStart + this.viewEnd) / 2));
            break;
          case '-':
          case '_':
            e.preventDefault();
            this.zoomBy(1.35, this.cursor ?? Math.round((this.viewStart + this.viewEnd) / 2));
            break;
          case '0':
            e.preventDefault();
            this.resetZoom();
            break;
          case 'Enter':
          case ' ':
            if (this.cursor != null) {
              e.preventDefault();
              this.options.onPick?.(this.cursor);
            }
            break;
          default:
            return;
        }
        void span;
      }),

      on(surface, 'blur', () => this.endScrub()),
    );

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.markDirty());
      this.resizeObserver.observe(surface);
    }
    this.startLoop();
  }

  private applyPinch(startState: { distance: number; start: number; end: number }, distance: number): void {
    const scale = startState.distance / Math.max(1, distance);
    const centre = (startState.start + startState.end) / 2;
    const span = (startState.end - startState.start) * scale;
    this.setView(centre - span / 2, centre + span / 2);
  }

  private zoomBy(factor: number, focus: number): void {
    const span = this.viewEnd - this.viewStart;
    const next = span * factor;
    // Keep the focused index under the cursor as the view scales around it.
    const ratio = span > 0 ? (focus - this.viewStart) / span : 0.5;
    this.setView(focus - next * ratio, focus + next * (1 - ratio));
  }

  private setView(start: number, end: number): void {
    const n = this.options.dates.length - 1;
    const MIN_SPAN = 2;
    let s = start;
    let e = end;
    if (e - s < MIN_SPAN) {
      const centre = (s + e) / 2;
      s = centre - MIN_SPAN / 2;
      e = centre + MIN_SPAN / 2;
    }
    if (e - s > n) {
      s = 0;
      e = n;
    }
    if (s < 0) {
      e -= s;
      s = 0;
    }
    if (e > n) {
      s -= e - n;
      e = n;
    }
    this.viewStart = Math.max(0, Math.round(s));
    this.viewEnd = Math.min(n, Math.round(e));
    if (this.cursor != null) this.cursor = clamp(this.cursor, this.viewStart, this.viewEnd);
    this.markDirty();
  }

  resetZoom(): void {
    this.viewStart = 0;
    this.viewEnd = Math.max(0, this.options.dates.length - 1);
    haptic('tick');
    this.markDirty();
  }

  private setCursor(index: number): void {
    if (this.cursor === index) return;
    this.cursor = index;
    this.options.onScrub?.(index);
    haptic('tick');
    this.updateReadout();
    this.markDirty();
  }

  private endScrub(): void {
    if (this.cursor == null) return;
    this.cursor = null;
    this.options.onScrub?.(null);
    this.updateReadout();
    this.markDirty();
  }

  private updateReadout(): void {
    const { series, dates } = this.options;
    if (this.cursor == null) {
      // With no cursor the readout shows the latest reading — the chart should always
      // be saying something, never sitting blank waiting to be touched.
      const parts = series.map((s) => {
        const last = lastDefined(s.values);
        return `<span class="chart-key" style="--k:${resolveColor(s.color)}">${s.label}</span> <b>${
          last == null ? '—' : last.toFixed(s.decimals)
        }${s.unit}</b>`;
      });
      this.readout.innerHTML = `<span class="chart-when">Latest</span> ${parts.join('<span class="chart-sep"></span>')}`;
      return;
    }
    const date = dates[this.cursor];
    const parts = series.map((s) => {
      const v = s.values[this.cursor!];
      return `<span class="chart-key" style="--k:${resolveColor(s.color)}">${s.label}</span> <b>${
        v == null ? '—' : v.toFixed(s.decimals)
      }${s.unit}</b>`;
    });
    this.readout.innerHTML = `<span class="chart-when">${
      date ? formatDayLabel(date) : ''
    }</span> ${parts.join('<span class="chart-sep"></span>')}`;
  }

  private markDirty(): void {
    this.dirty = true;
  }

  private startLoop(): void {
    const loop = () => {
      if (this.drawProgress < 1) {
        this.drawProgress = Math.min(1, this.drawProgress + 0.045);
        this.dirty = true;
      }
      if (this.dirty) {
        this.dirty = false;
        this.draw();
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private draw(): void {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    this.width = rect.width;
    if (this.width < 8) return;

    const ctx = fitCanvas(this.canvas, this.width, this.height);
    if (!ctx) return;

    const { series } = this.options;
    if (!series.length) return;

    const plot = {
      x: PAD.left,
      y: PAD.top,
      w: this.width - PAD.left - PAD.right,
      h: this.height - PAD.top - PAD.bottom,
    };

    const visible = this.viewEnd - this.viewStart;
    const xOf = (i: number) => plot.x + (visible > 0 ? ((i - this.viewStart) / visible) * plot.w : plot.w / 2);

    // Reveal animation: the chart *draws* rather than fading in, matching the ECG.
    const revealX = plot.x + plot.w * easeOut(this.drawProgress);

    this.drawGrid(ctx, plot);

    // The overlay series is drawn first and dimmer, so the primary metric reads on top.
    for (let si = series.length - 1; si >= 0; si--) {
      const s = series[si];
      const scale = this.scaleFor(s);
      const yOf = (v: number) => plot.y + plot.h - ((v - scale.lo) / (scale.hi - scale.lo)) * plot.h;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, revealX + PAD.right, this.height);
      ctx.clip();
      ctx.globalAlpha = si === 0 ? 1 : 0.55;
      if (s.type === 'bar') this.drawBars(ctx, s, plot, xOf, yOf, visible);
      else this.drawLine(ctx, s, plot, xOf, yOf);
      ctx.restore();

      if (si === 0 && this.options.showAverage !== false) {
        this.drawAverage(ctx, s, plot, yOf);
      }
    }

    this.drawAxis(ctx, plot, xOf);
    if (this.cursor != null) this.drawCursor(ctx, plot, xOf);
  }

  /** y-domain for a series, using its fixed domain when it has one. */
  private scaleFor(s: ChartSeries): { lo: number; hi: number } {
    if (s.domain) return { lo: s.domain[0], hi: s.domain[1] };
    const vals: number[] = [];
    for (let i = this.viewStart; i <= this.viewEnd; i++) {
      const v = s.values[i];
      if (v != null && Number.isFinite(v)) vals.push(v);
    }
    if (!vals.length) return { lo: 0, hi: 1 };
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    // Bars must be read against zero, or a 2% difference looks like a 10x difference.
    if (s.type === 'bar') lo = Math.min(0, lo);
    const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.1 || 1;
    return { lo: lo - (s.type === 'bar' ? 0 : pad), hi: hi + pad };
  }

  private drawGrid(ctx: CanvasRenderingContext2D, plot: Plot): void {
    ctx.strokeStyle = withAlpha(token('--hairline') || '#1E2434', 0.55);
    ctx.lineWidth = 1;
    for (let i = 0; i <= 2; i++) {
      const y = Math.round(plot.y + (plot.h / 2) * i) + 0.5;
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
      ctx.stroke();
    }
  }

  private drawBars(
    ctx: CanvasRenderingContext2D,
    s: ChartSeries,
    plot: Plot,
    xOf: (i: number) => number,
    yOf: (v: number) => number,
    visible: number,
  ): void {
    const slot = plot.w / Math.max(1, visible + 1);
    const barWidth = Math.max(1.5, Math.min(slot * 0.62, 22));
    const zeroY = yOf(0);
    const color = resolveColor(s.color);

    for (let i = this.viewStart; i <= this.viewEnd; i++) {
      const v = s.values[i];
      if (v == null || !Number.isFinite(v)) continue;
      const x = xOf(i) - barWidth / 2;
      const y = yOf(v);
      const height = Math.max(1.5, zeroY - y);
      ctx.fillStyle = this.cursor === i ? color : withAlpha(color, 0.72);
      roundRect(ctx, x, y, barWidth, height, Math.min(3, barWidth / 2));
      ctx.fill();
    }
  }

  private drawLine(
    ctx: CanvasRenderingContext2D,
    s: ChartSeries,
    plot: Plot,
    xOf: (i: number) => number,
    yOf: (v: number) => number,
  ): void {
    const color = resolveColor(s.color);
    // Gaps must stay gaps: a missing day is not a straight line between neighbours.
    const runs: Array<Array<{ x: number; y: number; i: number }>> = [];
    let run: Array<{ x: number; y: number; i: number }> = [];
    for (let i = this.viewStart; i <= this.viewEnd; i++) {
      const v = s.values[i];
      if (v == null || !Number.isFinite(v)) {
        if (run.length) runs.push(run);
        run = [];
        continue;
      }
      run.push({ x: xOf(i), y: yOf(v), i });
    }
    if (run.length) runs.push(run);

    if (s.type === 'area') {
      /**
       * The fill is a background wash, not a data claim — but drawing it per-run gave
       * every one-day gap a pair of hard vertical edges, so a normal series with a few
       * missing days read as a row of disconnected blocks.
       *
       * Runs separated by a short gap are joined for the *fill only*. The stroke below
       * still breaks at every gap, so the line — which is what carries the data — stays
       * strictly honest, while the wash reads as one continuous region.
       */
      const MAX_BRIDGED_GAP = 3;
      const filled: Array<Array<{ x: number; y: number; i: number }>> = [];
      for (const points of runs) {
        const previous = filled[filled.length - 1];
        if (previous && points[0].i - previous[previous.length - 1].i <= MAX_BRIDGED_GAP) {
          previous.push(...points);
        } else {
          filled.push([...points]);
        }
      }

      const gradient = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
      gradient.addColorStop(0, withAlpha(color, 0.22));
      gradient.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = gradient;
      for (const points of filled) {
        if (points.length < 2) continue;
        ctx.beginPath();
        traceSpline(ctx, points);
        ctx.lineTo(points[points.length - 1].x, plot.y + plot.h);
        ctx.lineTo(points[0].x, plot.y + plot.h);
        ctx.closePath();
        ctx.fill();
      }
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const points of runs) {
      ctx.beginPath();
      if (points.length === 1) {
        ctx.arc(points[0].x, points[0].y, 2, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        continue;
      }
      traceSpline(ctx, points);
      ctx.stroke();
    }
  }

  private drawAverage(
    ctx: CanvasRenderingContext2D,
    s: ChartSeries,
    plot: Plot,
    yOf: (v: number) => number,
  ): void {
    let sum = 0;
    let n = 0;
    for (let i = this.viewStart; i <= this.viewEnd; i++) {
      const v = s.values[i];
      if (v != null && Number.isFinite(v)) {
        sum += v;
        n++;
      }
    }
    if (n < 2) return;
    const y = yOf(sum / n);
    if (y < plot.y || y > plot.y + plot.h) return;
    ctx.save();
    ctx.setLineDash([2, 5]);
    ctx.strokeStyle = withAlpha(token('--iron') || '#6B738C', 0.8);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    ctx.restore();
  }

  private drawAxis(ctx: CanvasRenderingContext2D, plot: Plot, xOf: (i: number) => number): void {
    const { dates } = this.options;
    if (!dates.length) return;
    ctx.fillStyle = token('--iron') || '#6B738C';
    ctx.font = `500 9.5px ${token('--mono') || 'monospace'}`;
    ctx.textBaseline = 'top';

    const span = this.viewEnd - this.viewStart;
    const ticks = span < 10 ? 3 : span < 40 ? 4 : 5;
    for (let t = 0; t <= ticks; t++) {
      const i = Math.round(this.viewStart + (span * t) / ticks);
      const date = dates[i];
      if (!date) continue;
      const label = formatDayLabel(date);
      const x = xOf(i);
      const w = ctx.measureText(label).width;
      // Keep end labels inside the plot rather than clipped at the edges.
      const tx = clamp(x - w / 2, plot.x, plot.x + plot.w - w);
      ctx.fillText(label, tx, plot.y + plot.h + 6);
    }
  }

  private drawCursor(ctx: CanvasRenderingContext2D, plot: Plot, xOf: (i: number) => number): void {
    const x = xOf(this.cursor!);
    ctx.save();
    ctx.strokeStyle = withAlpha(token('--phosphor') || '#5EEAD4', 0.7);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, plot.y - 4);
    ctx.lineTo(x, plot.y + plot.h + 2);
    ctx.stroke();

    for (const s of this.options.series) {
      const v = s.values[this.cursor!];
      if (v == null || !Number.isFinite(v)) continue;
      const scale = this.scaleFor(s);
      const y = plot.y + plot.h - ((v - scale.lo) / (scale.hi - scale.lo)) * plot.h;
      const color = resolveColor(s.color);
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = token('--graphite') || '#0D111A';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
    ctx.restore();
  }

  destroy(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.resizeObserver?.disconnect();
  }
}

interface Plot {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A monotone-ish cubic through the points.
 * Plain bezier smoothing overshoots on health data — it can draw a recovery of 104%
 * between two 99s — so control points are clamped to the segment's own range.
 */
function traceSpline(ctx: CanvasRenderingContext2D, points: Array<{ x: number; y: number }>): void {
  ctx.moveTo(points[0].x, points[0].y);
  if (points.length === 2) {
    ctx.lineTo(points[1].x, points[1].y);
    return;
  }
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const smoothing = 0.18;
    const c1x = p1.x + (p2.x - p0.x) * smoothing;
    const c2x = p2.x - (p3.x - p1.x) * smoothing;
    const loY = Math.min(p1.y, p2.y);
    const hiY = Math.max(p1.y, p2.y);
    const c1y = clamp(p1.y + (p2.y - p0.y) * smoothing, loY, hiY);
    const c2y = clamp(p2.y - (p3.y - p1.y) * smoothing, loY, hiY);
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lastDefined(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) return v;
  }
  return null;
}

/** Resolves a `--token` reference to its literal colour, since canvas can't use var(). */
export function resolveColor(color: string): string {
  if (color.startsWith('--')) return token(color) || '#5EEAD4';
  if (color.startsWith('var(')) {
    const name = color.slice(4, -1).trim();
    return token(name) || '#5EEAD4';
  }
  return color;
}

/** Applies alpha to a hex or rgb colour. */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  if (c.startsWith('#')) {
    const hex = c.length === 4
      ? c.slice(1).split('').map((ch) => ch + ch).join('')
      : c.slice(1);
    const n = parseInt(hex, 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r},${g},${b},${alpha})`;
  }
  if (c.startsWith('rgb(')) return c.replace('rgb(', 'rgba(').replace(')', `,${alpha})`);
  if (c.startsWith('rgba(')) return c.replace(/[\d.]+\)$/, `${alpha})`);
  return c;
}
