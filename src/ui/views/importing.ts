/**
 * The import screen.
 *
 * This is the only genuinely slow moment in Pulse, so it gets real information rather
 * than a spinner: a true percentage (measured in bytes consumed, which we know up
 * front), a running count of what has been found, and the signature ECG trace drawing
 * itself to that percentage.
 *
 * The copy underneath is doing work too — a large export can take a minute, and telling
 * someone *why* it's slow and that it only happens once is the difference between
 * waiting and closing the tab.
 */

import { h, render } from '../dom';
import { EcgProgress } from '../ecg';
import { bytes as fmtBytes } from '../../core/format';

const REASSURANCE = [
  'Reading records straight off your device — nothing is being uploaded.',
  'Large exports hold millions of records. Pulse only keeps a daily summary.',
  'This happens once. After this, Pulse opens instantly from local storage.',
  'Merging sleep from every device that recorded it, so nights are never counted twice.',
];

export class ImportingView {
  readonly el: HTMLElement;
  private progress = new EcgProgress();
  private percentEl: HTMLElement;
  private phaseEl: HTMLElement;
  private detailEl: HTMLElement;
  private reassureEl: HTMLElement;
  private barEl: HTMLElement;
  private reassureTimer = 0;
  private reassureIndex = 0;

  constructor() {
    this.percentEl = h('div', { class: 'import-percent' }, '0', h('span', null, '%'));
    this.phaseEl = h('div', { class: 'import-phase' }, 'Starting…');
    this.detailEl = h('div', { class: 'import-detail' }, '');
    this.reassureEl = h('p', { class: 'import-reassure' }, REASSURANCE[0]);
    this.barEl = h('i', { class: 'import-bar-fill' });

    this.el = h('div', { class: 'importing' },
      h('div', { class: 'import-card' },
        h('div', { class: 'eyebrow' }, 'READING YOUR EXPORT'),
        this.progress.el,
        this.percentEl,
        h('div', {
          class: 'import-bar',
          role: 'progressbar',
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-valuenow': '0',
          'aria-label': 'Import progress',
        }, this.barEl),
        this.phaseEl,
        this.detailEl,
      ),
      this.reassureEl,
    );
  }

  start(file: File): void {
    this.progress.start();
    this.detailEl.textContent = `${file.name} · ${fmtBytes(file.size)}`;
    // Rotate the reassurance copy slowly — fast enough to show progress is being made,
    // slow enough to actually read.
    this.reassureTimer = window.setInterval(() => {
      this.reassureIndex = (this.reassureIndex + 1) % REASSURANCE.length;
      this.reassureEl.textContent = REASSURANCE[this.reassureIndex];
    }, 4200);
  }

  update(percent: number, phase: string, detail: string): void {
    this.progress.setPercent(percent);
    this.percentEl.firstChild!.textContent = String(Math.floor(percent));
    this.barEl.style.width = `${percent}%`;
    this.el.querySelector('[role="progressbar"]')?.setAttribute('aria-valuenow', String(Math.floor(percent)));
    this.phaseEl.textContent = phaseLabel(phase);
    if (detail) this.detailEl.textContent = detail;
  }

  stop(): void {
    this.progress.stop();
    if (this.reassureTimer) window.clearInterval(this.reassureTimer);
    this.reassureTimer = 0;
  }
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'reading': return 'Reading the file';
    case 'unzipping': return 'Opening the export';
    case 'parsing': return 'Extracting your records';
    case 'summarising': return 'Building your timeline';
    default: return 'Working';
  }
}

/** Skeleton placeholders for the moment between load and first paint. */
export function bootSkeleton(): HTMLElement {
  return h('div', { class: 'boot' },
    h('div', { class: 'skeleton skeleton-ribbon' }),
    h('div', { class: 'skeleton skeleton-ring' }),
    h('div', { class: 'skeleton-row' },
      h('div', { class: 'skeleton skeleton-card' }),
      h('div', { class: 'skeleton skeleton-card' }),
      h('div', { class: 'skeleton skeleton-card' }),
    ),
    h('div', { class: 'skeleton skeleton-block' }),
    h('div', { class: 'skeleton skeleton-block' }),
  );
}

export { render };
