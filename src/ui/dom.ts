/**
 * A minimal hyperscript helper.
 *
 * Pulse has no UI framework. The reasoning: the app is one screen plus sheets, its
 * updates are coarse (a day changes, a range changes), and its most distinctive parts —
 * the ECG trace, the ring, the canvas charts — are imperative drawing code that a
 * virtual DOM would only get in the way of. This file is the entire abstraction, and it
 * keeps the shipped bundle at a fraction of what a framework would cost.
 */

type Child = Node | string | number | null | undefined | false | Child[];

export interface Props {
  class?: string;
  text?: string;
  html?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
  /** Event handlers, e.g. `{ onclick: fn }`. */
  [key: string]: unknown;
}

function appendChildren(el: Node, children: Child[]): void {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) appendChildren(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyProps(el, props);
  appendChildren(el, children);
  return el;
}

function applyProps(el: HTMLElement | SVGElement, props?: Props | null): void {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') {
      el.setAttribute('class', String(value));
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (key === 'html') {
      el.innerHTML = String(value);
    } else if (key === 'style') {
      if (typeof value === 'string') el.setAttribute('style', value);
      else Object.assign(el.style, value);
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value as Record<string, string>)) {
        (el as HTMLElement).dataset[k] = v;
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value as EventListener);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  props?: Record<string, string | number | null | undefined> | null,
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null) continue;
      el.setAttribute(key, String(value));
    }
  }
  appendChildren(el, children);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Replaces an element's contents in one shot. */
export function render(el: Element, ...children: Child[]): void {
  clear(el);
  appendChildren(el, children);
}

export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector);
}

/** Adds a listener and returns a disposer — makes teardown symmetric and hard to forget. */
export function on<K extends keyof HTMLElementEventMap>(
  target: EventTarget,
  type: K | string,
  handler: (e: never) => void,
  options?: AddEventListenerOptions | boolean,
): () => void {
  target.addEventListener(type, handler as EventListener, options);
  return () => target.removeEventListener(type, handler as EventListener, options);
}

/** True when the user has asked for reduced motion, at the OS or app level. */
export function prefersReducedMotion(): boolean {
  if (document.documentElement.dataset.motion === 'reduced') return true;
  if (document.documentElement.dataset.motion === 'full') return false;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** Runs `fn` on the next frame, or immediately when motion is reduced. */
export function nextFrame(fn: () => void): void {
  if (prefersReducedMotion()) {
    fn();
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/**
 * Sizes a canvas for the device pixel ratio and returns a context already scaled to
 * CSS pixels, so drawing code can work in layout units and still be crisp on retina.
 */
export function fitCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
): CanvasRenderingContext2D | null {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = Math.max(1, Math.round(cssWidth * dpr));
  const h = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  return ctx;
}

/** Reads a CSS custom property, so canvas drawing can use the same tokens as CSS. */
export function token(name: string, el: Element = document.documentElement): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}
