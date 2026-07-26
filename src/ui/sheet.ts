/**
 * Bottom sheets — how Pulse reaches depth without ever losing the user's place.
 *
 * Every metric is tappable, and tapping opens one of these rather than navigating. That
 * choice is what makes the app feel native: you can drill into why recovery is 62%,
 * read the breakdown, and dismiss back to exactly where you were.
 *
 * Accessibility is built in rather than added: focus is trapped while open, Escape
 * closes, the trigger is refocused on dismiss, and background content is inert to
 * screen readers.
 */

import { h, on, prefersReducedMotion } from './dom';
import { haptic } from '../core/haptics';

export interface SheetOptions {
  title: string;
  /** Small uppercase label above the title. */
  eyebrow?: string;
  /** Called after the sheet has fully closed. */
  onClose?: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let activeSheet: Sheet | null = null;

export class Sheet {
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  private scrim: HTMLElement;
  private panel: HTMLElement;
  private disposers: Array<() => void> = [];
  private previouslyFocused: HTMLElement | null = null;
  private options: SheetOptions;
  private closing = false;

  constructor(options: SheetOptions) {
    this.options = options;
    this.previouslyFocused = document.activeElement as HTMLElement | null;

    this.body = h('div', { class: 'sheet-body' });

    const closeBtn = h('button', {
      class: 'sheet-close',
      type: 'button',
      'aria-label': 'Close',
      onclick: () => this.close(),
    }, '✕');

    // The grab handle is a miniature ECG trace — the signature motif reappearing at
    // the smallest scale, where a plain grey pill would have gone.
    const handle = h('div', { class: 'sheet-handle', 'aria-hidden': 'true' });

    const titleId = `sheet-title-${Math.random().toString(36).slice(2, 8)}`;
    this.panel = h(
      'div',
      { class: 'sheet-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      handle,
      h(
        'header',
        { class: 'sheet-head' },
        h(
          'div',
          null,
          options.eyebrow ? h('div', { class: 'eyebrow' }, options.eyebrow) : null,
          h('h2', { class: 'sheet-title', id: titleId }, options.title),
        ),
        closeBtn,
      ),
      this.body,
    );

    this.scrim = h('div', { class: 'sheet-scrim', onclick: () => this.close() });
    this.el = h('div', { class: 'sheet' }, this.scrim, this.panel);
  }

  open(): this {
    // Only one sheet at a time — stacking them would strand the user.
    if (activeSheet && activeSheet !== this) activeSheet.close();
    activeSheet = this;

    document.body.appendChild(this.el);
    document.body.classList.add('sheet-open');
    document.getElementById('app')?.setAttribute('aria-hidden', 'true');

    this.disposers.push(
      on(document, 'keydown', (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          this.close();
        } else if (e.key === 'Tab') {
          this.trapFocus(e);
        }
      }),
    );
    this.enableDragToDismiss();

    if (prefersReducedMotion()) {
      this.el.classList.add('is-open');
    } else {
      requestAnimationFrame(() => this.el.classList.add('is-open'));
    }

    // Focus the panel itself rather than the close button, so a screen reader announces
    // the sheet's title before its controls.
    this.panel.setAttribute('tabindex', '-1');
    requestAnimationFrame(() => this.panel.focus({ preventScroll: true }));
    haptic('open');
    return this;
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.el.classList.remove('is-open');
    for (const dispose of this.disposers) dispose();
    this.disposers = [];

    const finish = () => {
      this.el.remove();
      if (activeSheet === this) {
        activeSheet = null;
        document.body.classList.remove('sheet-open');
        document.getElementById('app')?.removeAttribute('aria-hidden');
      }
      this.previouslyFocused?.focus?.({ preventScroll: true });
      this.options.onClose?.();
    };

    if (prefersReducedMotion()) finish();
    else setTimeout(finish, 260);
  }

  private trapFocus(e: KeyboardEvent): void {
    const items = [...this.panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null,
    );
    if (!items.length) {
      e.preventDefault();
      this.panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === this.panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /** Drag the sheet down to dismiss — the gesture people expect from a native sheet. */
  private enableDragToDismiss(): void {
    let startY = 0;
    let delta = 0;
    let dragging = false;

    const start = (e: PointerEvent) => {
      // Only start a drag from the handle area, so scrolling the body still works.
      const target = e.target as HTMLElement;
      if (!target.closest('.sheet-handle, .sheet-head')) return;
      dragging = true;
      startY = e.clientY;
      delta = 0;
      this.panel.style.transition = 'none';
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      delta = Math.max(0, e.clientY - startY);
      this.panel.style.transform = `translateY(${delta}px)`;
    };
    const end = () => {
      if (!dragging) return;
      dragging = false;
      this.panel.style.transition = '';
      this.panel.style.transform = '';
      // A short flick shouldn't dismiss; a deliberate pull should.
      if (delta > 110) this.close();
    };

    this.disposers.push(
      on(this.panel, 'pointerdown', start),
      on(window, 'pointermove', move),
      on(window, 'pointerup', end),
      on(window, 'pointercancel', end),
    );
  }
}

/** Convenience: build, fill and open a sheet in one call. */
export function openSheet(options: SheetOptions, fill: (body: HTMLElement) => void): Sheet {
  const sheet = new Sheet(options);
  fill(sheet.body);
  return sheet.open();
}
