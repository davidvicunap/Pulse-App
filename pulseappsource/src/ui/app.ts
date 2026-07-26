/**
 * The application shell.
 *
 * Owns view switching, the worker lifecycle and the pull-to-refresh gesture. Views are
 * created lazily and kept alive once created, so switching back to the dashboard after
 * an import doesn't rebuild every chart.
 */

import { getState, rebuildModel, setState, subscribe } from '../core/store';
import { saveDaysMerged, setLastImport } from '../core/db';
import { clear, h, on } from './dom';
import { Dashboard } from './views/dashboard';
import { Onboarding } from './views/onboarding';
import { bootSkeleton, ImportingView } from './views/importing';
import { haptic } from '../core/haptics';
import type { ParseResponse } from '../parse/worker';

export class App {
  private root: HTMLElement;
  private dashboard: Dashboard | null = null;
  private onboarding: Onboarding | null = null;
  private importing: ImportingView | null = null;
  private worker: Worker | null = null;
  private currentView: string | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.append(bootSkeleton());

    subscribe(() => this.render());

    // Any part of the app can ask for a fresh import — the stale-data banner and the
    // settings sheet both do.
    document.addEventListener('pulse:import', () => this.promptForFile());

    this.enablePullToRefresh();
  }

  private render(): void {
    const state = getState();

    if (state.view !== this.currentView) {
      this.currentView = state.view;
      clear(this.root);
      switch (state.view) {
        case 'onboarding':
          this.root.append(this.getOnboarding().el);
          break;
        case 'importing':
          this.root.append(this.getImporting().el);
          break;
        case 'dashboard':
          this.root.append(this.getDashboard().el);
          break;
        default:
          this.root.append(bootSkeleton());
      }
      // A view change should start at the top, but a day change should not.
      window.scrollTo({ top: 0, behavior: 'auto' });
    }

    if (state.view === 'dashboard') this.getDashboard().update();
    if (state.view === 'importing' && state.progress) {
      this.getImporting().update(state.progress.percent, state.progress.phase, state.progress.detail);
    }
    if (state.view === 'onboarding' && state.error) {
      this.getOnboarding().showError(state.error.message, state.error.code);
    }
  }

  private getDashboard(): Dashboard {
    if (!this.dashboard) this.dashboard = new Dashboard();
    return this.dashboard;
  }

  private getOnboarding(): Onboarding {
    if (!this.onboarding) {
      this.onboarding = new Onboarding({ onFile: (file) => this.importFile(file) });
    }
    return this.onboarding;
  }

  private getImporting(): ImportingView {
    if (!this.importing) this.importing = new ImportingView();
    return this.importing;
  }

  /** Opens a file picker from anywhere in the app. */
  promptForFile(): void {
    const input = h('input', {
      type: 'file',
      accept: '.zip,.xml,application/zip,text/xml',
      class: 'visually-hidden',
    }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) this.importFile(file);
      input.remove();
    });
    document.body.append(input);
    input.click();
  }

  /**
   * Runs an import.
   *
   * The worker is created per-import and terminated afterwards, which guarantees the
   * accumulator's memory is released rather than lingering for the life of the tab.
   */
  importFile(file: File): void {
    this.onboarding?.clearError();
    setState({
      view: 'importing',
      error: null,
      progress: { phase: 'reading', percent: 0, detail: '' },
    });
    this.getImporting().start(file);

    this.worker?.terminate();
    this.worker = new Worker(new URL('../parse/worker.ts', import.meta.url), { type: 'module' });

    this.worker.onmessage = async (event: MessageEvent<ParseResponse>) => {
      const message = event.data;

      if (message.kind === 'progress') {
        setState({
          progress: { phase: message.phase, percent: message.percent, detail: message.detail },
        });
        return;
      }

      if (message.kind === 'error') {
        this.finishWorker();
        haptic('warn');
        setState({
          view: 'onboarding',
          progress: null,
          error: { message: message.message, code: message.code },
        });
        // If the user already had data, keep them on the dashboard instead of stranding
        // them on onboarding after a failed re-import.
        if (getState().records.length) {
          setState({ view: 'dashboard' });
          this.showToast(message.message, 'error');
        }
        return;
      }

      if (message.kind === 'done') {
        this.finishWorker();
        try {
          const merged = await saveDaysMerged(message.days);
          await setLastImport({
            importedAt: Date.now(),
            fileName: file.name,
            fileBytes: file.size,
            recordsSeen: message.stats.recordsSeen,
            daysTotal: merged.days.length,
            daysAdded: merged.added,
            daysUpdated: merged.updated,
            elapsedMs: message.stats.elapsedMs,
          });

          setState({
            records: merged.days,
            progress: null,
            error: null,
            importResult: { added: merged.added, updated: merged.updated, total: merged.days.length },
          });
          rebuildModel();
          setState({ view: 'dashboard' });
          haptic('success');
          this.showToast(
            merged.added > 0
              ? `Added ${merged.added} new day${merged.added === 1 ? '' : 's'}${
                  merged.updated ? `, updated ${merged.updated}` : ''
                }.`
              : `Up to date — ${merged.updated} day${merged.updated === 1 ? '' : 's'} refreshed.`,
            'success',
          );
        } catch (err) {
          // Parsing succeeded but storage failed — show the data anyway rather than
          // throwing away a minute of the user's time.
          setState({
            records: message.days,
            progress: null,
            error: null,
          });
          rebuildModel();
          setState({ view: 'dashboard' });
          this.showToast(
            err instanceof Error && /quota/i.test(err.message)
              ? 'Your data is shown, but this browser is out of storage so it could not be saved.'
              : 'Your data is shown, but it could not be saved for next time.',
            'error',
          );
        }
      }
    };

    this.worker.onerror = () => {
      this.finishWorker();
      setState({
        view: getState().records.length ? 'dashboard' : 'onboarding',
        progress: null,
        error: { message: 'The parser stopped unexpectedly. Try the export again.', code: 'unknown' },
      });
    };

    this.worker.postMessage({ kind: 'parse', file });
  }

  private finishWorker(): void {
    this.importing?.stop();
    this.worker?.terminate();
    this.worker = null;
  }

  /** A brief, non-blocking confirmation. Never used for anything that needs a decision. */
  showToast(message: string, tone: 'success' | 'error' = 'success'): void {
    const toast = h('div', { class: `toast toast-${tone}`, role: 'status' }, message);
    document.body.append(toast);
    requestAnimationFrame(() => toast.classList.add('is-in'));
    setTimeout(() => {
      toast.classList.remove('is-in');
      setTimeout(() => toast.remove(), 300);
    }, 4200);
  }

  /**
   * Pull down at the top of the dashboard to import a fresh export.
   *
   * There's nothing to "refresh" from a server, so the gesture is wired to the action a
   * user actually wants at that moment: pulling in newer data from a new export.
   */
  private enablePullToRefresh(): void {
    let startY = 0;
    let pulling = false;
    let distance = 0;

    const indicator = h('div', { class: 'pull-indicator' },
      h('span', { class: 'pull-label' }, 'Pull to import newer data'));
    document.body.append(indicator);

    on(document, 'touchstart', (e: TouchEvent) => {
      if (getState().view !== 'dashboard') return;
      if (window.scrollY > 4 || document.body.classList.contains('sheet-open')) return;
      startY = e.touches[0].clientY;
      pulling = true;
      distance = 0;
    }, { passive: true });

    on(document, 'touchmove', (e: TouchEvent) => {
      if (!pulling) return;
      distance = e.touches[0].clientY - startY;
      if (distance <= 0) {
        indicator.style.setProperty('--pull', '0');
        return;
      }
      // Resistance, so the gesture feels physical rather than linear.
      const eased = Math.min(90, Math.sqrt(distance) * 8);
      indicator.style.setProperty('--pull', String(eased));
      indicator.classList.toggle('is-ready', eased >= 70);
    }, { passive: true });

    on(document, 'touchend', () => {
      if (!pulling) return;
      pulling = false;
      const eased = Math.min(90, Math.sqrt(Math.max(0, distance)) * 8);
      indicator.style.setProperty('--pull', '0');
      indicator.classList.remove('is-ready');
      if (eased >= 70) {
        haptic('open');
        this.promptForFile();
      }
    }, { passive: true });
  }
}
