/**
 * The recovery ring.
 *
 * Fills as a *sweep* rather than growing as a bar — the arc is drawn by a beam
 * travelling around the dial, matching the phosphor metaphor the rest of the app's
 * motion follows. The numeric readout counts up alongside it so the number and the arc
 * always agree mid-animation.
 */

import { prefersReducedMotion } from './dom';

const SIZE = 200;
const RADIUS = 84;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface RingState {
  score: number | null;
  band: 'low' | 'moderate' | 'high';
  /** 0..1. Below the confidence floor the ring renders a dashed, muted arc. */
  confidence: number;
  label: string;
}

export function bandColor(band: 'low' | 'moderate' | 'high'): string {
  return band === 'high' ? 'var(--vital)' : band === 'moderate' ? 'var(--caution)' : 'var(--alert)';
}

export class RecoveryRing {
  readonly el: HTMLElement;
  private arc: SVGCircleElement;
  private track: SVGCircleElement;
  private valueEl: HTMLElement;
  private unitEl: HTMLElement;
  private tagEl: HTMLElement;
  private current = 0;
  private raf = 0;

  constructor() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    svg.setAttribute('class', 'ring-svg');
    svg.setAttribute('aria-hidden', 'true');

    this.track = document.createElementNS(ns, 'circle');
    setAttrs(this.track, {
      cx: SIZE / 2, cy: SIZE / 2, r: RADIUS,
      fill: 'none', 'stroke-width': 13, class: 'ring-track',
    });

    // Tick marks every 10% — the detail that makes it read as a dial rather than a
    // progress bar.
    const ticks = document.createElementNS(ns, 'g');
    ticks.setAttribute('class', 'ring-ticks');
    for (let i = 0; i < 20; i++) {
      const angle = (i / 20) * Math.PI * 2 - Math.PI / 2;
      const major = i % 5 === 0;
      const inner = RADIUS + (major ? 11 : 13);
      const outer = RADIUS + 16;
      const line = document.createElementNS(ns, 'line');
      setAttrs(line, {
        x1: SIZE / 2 + Math.cos(angle) * inner,
        y1: SIZE / 2 + Math.sin(angle) * inner,
        x2: SIZE / 2 + Math.cos(angle) * outer,
        y2: SIZE / 2 + Math.sin(angle) * outer,
        'stroke-width': major ? 1.6 : 1,
        opacity: major ? 0.55 : 0.25,
      });
      ticks.appendChild(line);
    }

    this.arc = document.createElementNS(ns, 'circle');
    setAttrs(this.arc, {
      cx: SIZE / 2, cy: SIZE / 2, r: RADIUS,
      fill: 'none', 'stroke-width': 13, 'stroke-linecap': 'round',
      'stroke-dasharray': CIRCUMFERENCE, 'stroke-dashoffset': CIRCUMFERENCE,
      class: 'ring-arc',
    });

    svg.append(this.track, ticks, this.arc);

    this.valueEl = document.createElement('div');
    this.valueEl.className = 'ring-value';
    this.unitEl = document.createElement('div');
    this.unitEl.className = 'ring-unit';
    this.unitEl.textContent = 'percent recovered';
    this.tagEl = document.createElement('div');
    this.tagEl.className = 'ring-tag';

    const center = document.createElement('div');
    center.className = 'ring-center';
    center.append(this.valueEl, this.unitEl, this.tagEl);

    this.el = document.createElement('div');
    this.el.className = 'ring';
    this.el.append(svg, center);
  }

  set(state: RingState): void {
    const target = state.score ?? 0;
    const color = state.score == null ? 'var(--iron)' : bandColor(state.band);
    this.el.style.setProperty('--ring-color', color);
    this.tagEl.textContent = state.label;
    this.el.classList.toggle('is-empty', state.score == null);
    // A low-confidence score is drawn as a dashed arc, so a number built on four days
    // of data never looks as solid as one built on sixty.
    this.el.classList.toggle('is-uncertain', state.score != null && state.confidence < 0.45);

    if (state.score == null) {
      this.valueEl.textContent = '—';
      this.arc.style.strokeDashoffset = String(CIRCUMFERENCE);
      this.current = 0;
      return;
    }

    if (prefersReducedMotion()) {
      this.current = target;
      this.valueEl.textContent = String(Math.round(target));
      this.arc.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - target / 100));
      return;
    }
    this.animateTo(target);
  }

  private animateTo(target: number): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    const from = this.current;
    const start = performance.now();
    const duration = 900;

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // Matches the --ease token: a decay, not a bounce.
      const eased = 1 - Math.pow(1 - t, 3);
      const value = from + (target - from) * eased;
      this.current = value;
      this.valueEl.textContent = String(Math.round(value));
      this.arc.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - value / 100));
      if (t < 1) this.raf = requestAnimationFrame(step);
      else this.raf = 0;
    };
    this.raf = requestAnimationFrame(step);
  }

  destroy(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
  }
}

function setAttrs(el: Element, attrs: Record<string, string | number>): void {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
}
