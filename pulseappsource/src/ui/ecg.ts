/**
 * The ECG trace — Pulse's signature element.
 *
 * This is not decoration. The waveform is **synthesised from the selected day's own
 * physiology**, so the graphic at the top of the app is itself a reading:
 *
 *   - beat spacing comes from resting heart rate
 *   - the *variability* of that spacing comes from HRV — which is literally what HRV
 *     measures, so the drawing explains the metric
 *   - amplitude scales with recovery
 *   - stroke colour follows the recovery band
 *
 * The same generator backs the header trace, the import progress indicator and the
 * empty state, which is what makes the motif feel like the app's voice rather than a
 * graphic pasted on top of it.
 */

import { fitCanvas, prefersReducedMotion, token } from './dom';

export interface EcgInputs {
  /** Beats per minute — sets beat spacing. Defaults to a calm 60. */
  restingHr: number | null;
  /** SDNN in ms — sets how irregular the spacing looks. */
  hrv: number | null;
  /** 0–100 — sets amplitude. */
  recovery: number | null;
  /** CSS colour for the trace. Defaults to the phosphor accent. */
  color?: string;
}

interface Beat {
  /** Position along the trace, 0..1. */
  at: number;
  amplitude: number;
}

/**
 * Lays out beat positions for one screen-width of trace.
 *
 * Exported and pure so the relationship between HRV and visible irregularity can be
 * tested rather than eyeballed.
 */
export function planBeats(inputs: EcgInputs, secondsVisible = 6): Beat[] {
  const bpm = clampNum(inputs.restingHr ?? 60, 35, 120);
  const hrv = clampNum(inputs.hrv ?? 40, 5, 180);
  const recovery = clampNum(inputs.recovery ?? 60, 1, 100);

  const meanInterval = 60 / bpm; // seconds between beats
  // SDNN is a standard deviation in milliseconds, so it maps directly onto the jitter
  // of the interval — the drawing is the definition of the metric.
  const jitter = Math.min(meanInterval * 0.35, hrv / 1000);
  const amplitude = 0.45 + (recovery / 100) * 0.55;

  const beats: Beat[] = [];
  let t = 0;
  let i = 0;
  // A deterministic pseudo-random sequence: the same day always draws the same trace,
  // so the header doesn't reshuffle on every re-render.
  const seed = Math.round(bpm * 7 + hrv * 13 + recovery * 3);
  while (t < secondsVisible) {
    const wobble = (pseudoRandom(seed + i) - 0.5) * 2 * jitter;
    t += Math.max(0.25, meanInterval + wobble);
    if (t >= secondsVisible) break;
    beats.push({
      at: t / secondsVisible,
      amplitude: amplitude * (0.92 + pseudoRandom(seed + i + 500) * 0.16),
    });
    i++;
  }
  return beats;
}

/** Deterministic hash-based noise in 0..1. */
function pseudoRandom(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function clampNum(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : (lo + hi) / 2;
}

/**
 * Builds the SVG path for a full trace.
 *
 * The QRS complex is drawn to the real shape — a small P wave, the sharp Q-R-S spike,
 * then the rounded T wave — because a generic zigzag reads as a "tech" graphic while
 * the actual morphology reads as an instrument.
 */
export function ecgPath(beats: Beat[], width: number, height: number): string {
  const mid = height / 2;
  const unit = height * 0.42;
  let d = `M 0 ${mid.toFixed(1)}`;
  let cursor = 0;

  for (const beat of beats) {
    const x = beat.at * width;
    const a = beat.amplitude;
    // Baseline up to the start of this complex.
    const complexWidth = Math.min(width * 0.075, 34);
    const start = x - complexWidth / 2;
    if (start > cursor) d += ` L ${start.toFixed(1)} ${mid.toFixed(1)}`;

    const u = complexWidth / 10;
    const p = mid - unit * 0.16 * a; // P wave
    const q = mid + unit * 0.18 * a; // Q dip
    const r = mid - unit * a; // R spike
    const sv = mid + unit * 0.42 * a; // S trough
    const tw = mid - unit * 0.26 * a; // T wave

    d +=
      ` Q ${(start + u * 0.8).toFixed(1)} ${p.toFixed(1)} ${(start + u * 1.8).toFixed(1)} ${mid.toFixed(1)}` +
      ` L ${(start + u * 3).toFixed(1)} ${q.toFixed(1)}` +
      ` L ${(start + u * 4).toFixed(1)} ${r.toFixed(1)}` +
      ` L ${(start + u * 5).toFixed(1)} ${sv.toFixed(1)}` +
      ` L ${(start + u * 6).toFixed(1)} ${mid.toFixed(1)}` +
      ` Q ${(start + u * 7.6).toFixed(1)} ${tw.toFixed(1)} ${(start + u * 9.2).toFixed(1)} ${mid.toFixed(1)}`;

    cursor = start + complexWidth;
  }
  if (cursor < width) d += ` L ${width} ${mid.toFixed(1)}`;
  return d;
}

/** Recovery band → trace colour, using the same tokens as the rest of the app. */
export function traceColor(recovery: number | null): string {
  if (recovery == null) return 'var(--iron)';
  if (recovery >= 67) return 'var(--vital)';
  if (recovery >= 34) return 'var(--caution)';
  return 'var(--alert)';
}

/**
 * The header ribbon: an SVG trace that sweeps once on load, then holds.
 *
 * SVG rather than canvas here because the trace is static once drawn and the
 * `stroke-dashoffset` sweep is free on the compositor.
 */
export class EcgRibbon {
  readonly el: HTMLElement;
  private svg: SVGSVGElement;
  private path: SVGPathElement;
  private glow: SVGPathElement;
  private width = 560;
  private height = 56;

  constructor() {
    const ns = 'http://www.w3.org/2000/svg';
    this.svg = document.createElementNS(ns, 'svg');
    this.svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
    this.svg.setAttribute('preserveAspectRatio', 'none');
    this.svg.setAttribute('aria-hidden', 'true');

    // Two strokes: a wide blurred one for the phosphor bloom, a crisp one on top.
    this.glow = document.createElementNS(ns, 'path');
    this.glow.setAttribute('class', 'ecg-glow');
    this.path = document.createElementNS(ns, 'path');
    this.path.setAttribute('class', 'ecg-trace');

    this.svg.append(this.glow, this.path);
    this.el = document.createElement('div');
    this.el.className = 'ecg-ribbon';
    this.el.appendChild(this.svg);
  }

  /** Redraws for a day's physiology. Sweeps only when the values actually changed. */
  update(inputs: EcgInputs, animate = true): void {
    const d = ecgPath(planBeats(inputs), this.width, this.height);
    const color = inputs.color ?? traceColor(inputs.recovery);
    const changed = this.path.getAttribute('d') !== d;

    this.path.setAttribute('d', d);
    this.glow.setAttribute('d', d);
    this.el.style.setProperty('--trace-color', color);

    if (changed && animate && !prefersReducedMotion()) {
      // Restart the sweep by forcing a reflow between class removals.
      this.el.classList.remove('is-sweeping');
      void this.el.offsetWidth;
      this.el.classList.add('is-sweeping');
    } else {
      this.el.classList.add('is-drawn');
    }
  }
}

/**
 * The import progress indicator.
 *
 * The trace draws left-to-right at the *true* completion percentage, so the same motif
 * that identifies the app also carries the most important information during the only
 * genuinely slow moment in it. A spinner would say "unknown duration" — and we know
 * the duration, so we show it.
 */
export class EcgProgress {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private percent = 0;
  private phase = 0;
  private raf = 0;
  private beats: Beat[];

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    this.el = document.createElement('div');
    this.el.className = 'ecg-progress';
    this.el.appendChild(this.canvas);
    this.beats = planBeats({ restingHr: 62, hrv: 55, recovery: 70 }, 5);
  }

  start(): void {
    if (this.raf) return;
    const loop = () => {
      this.phase += prefersReducedMotion() ? 0 : 0.012;
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  setPercent(p: number): void {
    this.percent = Math.max(0, Math.min(100, p));
  }

  private draw(): void {
    const rect = this.el.getBoundingClientRect();
    const w = rect.width || 320;
    const hgt = 64;
    const ctx = fitCanvas(this.canvas, w, hgt);
    if (!ctx) return;

    const accent = token('--phosphor') || '#5EEAD4';
    const dim = token('--hairline') || '#1E2434';
    const path = new Path2D(ecgPath(this.beats, w, hgt));

    // The untraced remainder, drawn faintly — the shape of what's still to come.
    ctx.strokeStyle = dim;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(path);

    // The completed portion, clipped to the true percentage.
    const filled = (this.percent / 100) * w;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, filled, hgt);
    ctx.clip();
    ctx.shadowColor = accent;
    ctx.shadowBlur = 10;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.stroke(path);
    ctx.restore();

    // The sweep head — a bright point riding the leading edge, like a CRT beam.
    if (this.percent > 0 && this.percent < 100) {
      const pulse = 0.6 + Math.sin(this.phase * 6) * 0.4;
      ctx.save();
      ctx.shadowColor = accent;
      ctx.shadowBlur = 16 * pulse;
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(filled, hgt / 2, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}
