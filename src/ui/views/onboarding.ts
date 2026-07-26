/**
 * First run.
 *
 * The hard part of this app isn't the dashboard — it's that a new user has to go and
 * produce a Health export before they can see anything at all. So this screen does three
 * jobs: it makes the payoff concrete before the work, it walks through the export step by
 * step, and it puts the privacy promise where the hesitation actually happens (right at
 * the drop zone), not in a footer.
 */

import { h, render } from '../dom';
import { EcgRibbon } from '../ecg';
import { haptic } from '../../core/haptics';

export interface OnboardingHandlers {
  onFile: (file: File) => void;
}

export class Onboarding {
  readonly el: HTMLElement;
  private handlers: OnboardingHandlers;
  private input: HTMLInputElement;
  private errorSlot: HTMLElement;
  private ribbon = new EcgRibbon();

  constructor(handlers: OnboardingHandlers) {
    this.handlers = handlers;
    this.errorSlot = h('div', { class: 'error-slot', role: 'alert' });

    this.input = h('input', {
      type: 'file',
      accept: '.zip,.xml,application/zip,text/xml',
      class: 'visually-hidden',
      onchange: (e: Event) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) this.handlers.onFile(file);
      },
    }) as HTMLInputElement;

    this.el = h('div', { class: 'onboarding' });
    this.build();
  }

  private build(): void {
    const drop = this.buildDropZone();

    render(
      this.el,
      this.ribbon.el,
      h('header', { class: 'topbar' },
        h('div', { class: 'brand' }, 'PULSE', h('small', null, ' · recovery')),
      ),

      h('div', { class: 'intro' },
        h('h1', null, 'Read your body like an ', h('span', { class: 'accent' }, 'instrument.')),
        h('p', null,
          'Pulse turns your Apple Health export into recovery, strain and sleep — with the ' +
          'reasoning behind every number, and insights that tell you what to actually do today.'),
      ),

      drop,
      this.input,
      this.errorSlot,

      h('section', { class: 'steps' },
        h('h2', { class: 'eyebrow' }, 'HOW TO GET YOUR EXPORT'),
        h('ol', null,
          h('li', null, 'Open the ', h('b', null, 'Health'), ' app on your iPhone and tap your ', h('b', null, 'profile photo'), ' at the top right.'),
          h('li', null, 'Scroll to the bottom and tap ', h('b', null, 'Export All Health Data'), '.'),
          h('li', null, 'Wait for it to build — a few years of data can take several minutes — then ', h('b', null, 'Save to Files'), '.'),
          h('li', null, 'Come back here and drop that ', h('b', null, 'export.zip'), ' in above. Big files are fine.'),
        ),
      ),

      h('section', { class: 'promise' },
        h('h2', { class: 'eyebrow' }, 'WHAT PULSE DOES WITH IT'),
        h('ul', { class: 'promise-list' },
          promiseItem('Reads it here, on your device', 'The file is parsed in this browser. It is never uploaded — there is no server to upload it to.'),
          promiseItem('Keeps only a daily summary', 'A few hundred kilobytes of per-day numbers are stored locally, so you never have to import twice.'),
          promiseItem('Works with no connection', 'Once loaded, Pulse runs entirely offline. Add it to your home screen and it opens like an app.'),
          promiseItem('Deletes completely when you say so', 'One control in Settings removes every stored day. Nothing survives it.'),
        ),
      ),
    );

    this.ribbon.update({ restingHr: 58, hrv: 62, recovery: 74 });
  }

  private buildDropZone(): HTMLElement {
    const zone = h('div', {
      class: 'drop',
      tabindex: '0',
      role: 'button',
      'aria-label': 'Choose your Apple Health export file',
      onclick: () => this.input.click(),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.input.click();
        }
      },
    },
      h('div', { class: 'drop-glyph' }, uploadIcon()),
      h('b', null, 'Drop export.zip or export.xml'),
      h('span', null, 'or tap to choose a file'),
      h('div', { class: 'drop-privacy' }, lockIcon(), 'Parsed on this device — nothing is uploaded'),
    );

    // Drag-and-drop, for the desktop path.
    for (const type of ['dragenter', 'dragover']) {
      zone.addEventListener(type, (e) => {
        e.preventDefault();
        zone.classList.add('is-over');
      });
    }
    for (const type of ['dragleave', 'drop']) {
      zone.addEventListener(type, (e) => {
        e.preventDefault();
        zone.classList.remove('is-over');
      });
    }
    zone.addEventListener('drop', (e) => {
      const file = (e as DragEvent).dataTransfer?.files?.[0];
      if (file) {
        haptic('open');
        this.handlers.onFile(file);
      }
    });

    return zone;
  }

  /** Shows a parse failure inline, with the specific fix for that failure. */
  showError(message: string, code?: string): void {
    render(
      this.errorSlot,
      h('div', { class: 'note note-alert' },
        h('strong', null, `${errorTitle(code)} `),
        message,
      ),
    );
    haptic('warn');
  }

  clearError(): void {
    render(this.errorSlot);
  }
}

/**
 * The bold lead for an error.
 *
 * Each title states the problem and the message that follows adds the fix — they must
 * not restate each other, or the error reads as a stutter.
 */
function errorTitle(code?: string): string {
  switch (code) {
    case 'no-export-xml': return 'There’s no export.xml in that zip.';
    case 'not-a-zip': return 'That zip wouldn’t open.';
    case 'not-health-data': return 'That isn’t a Health export.';
    case 'no-records': return 'Nothing usable in that export.';
    default: return 'The import didn’t finish.';
  }
}

function promiseItem(title: string, body: string): HTMLElement {
  return h('li', null,
    h('span', { class: 'promise-check' }, checkIcon()),
    h('div', null, h('b', null, title), h('p', null, body)),
  );
}

function icon(paths: string, stroke = 'currentColor'): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', stroke);
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths;
  return svg;
}

function uploadIcon(): SVGElement {
  return icon('<path d="M12 15V3m0 0L8 7m4-4 4 4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>', 'var(--phosphor)');
}

function lockIcon(): SVGElement {
  return icon('<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3"/>', 'var(--vital)');
}

function checkIcon(): SVGElement {
  return icon('<path d="m5 12 4.5 4.5L19 7"/>', 'var(--phosphor)');
}
