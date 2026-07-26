/**
 * Application state.
 *
 * A single observable store rather than a framework's state management: the app has one
 * screen, and its state is small enough to hold in one object. Subscribers are called
 * with the whole state and decide for themselves what to re-render — with this few
 * consumers, fine-grained reactivity would cost more than it saves.
 */

import type { DayRecord, Model, UserSettings } from './types';
import { DEFAULT_SETTINGS } from './types';
import { buildModel, latestScoredIndex } from '../model/build';
import { setHapticsEnabled } from './haptics';

export type View = 'boot' | 'onboarding' | 'importing' | 'dashboard';
export type Range = 7 | 30 | 90 | 365;

export interface ImportProgress {
  phase: string;
  percent: number;
  detail: string;
}

export interface AppState {
  view: View;
  /** The stored per-day records — the source of truth we persist. */
  records: DayRecord[];
  /** Derived from `records` + `settings`. Rebuilt whenever either changes. */
  model: Model | null;
  settings: UserSettings;
  /** Index into `model.days` for the day being viewed. */
  selectedIndex: number;
  range: Range;
  progress: ImportProgress | null;
  error: { message: string; code?: string } | null;
  /** Set briefly after an import so the UI can confirm what happened. */
  importResult: { added: number; updated: number; total: number } | null;
}

type Listener = (state: AppState) => void;

const state: AppState = {
  view: 'boot',
  records: [],
  model: null,
  settings: { ...DEFAULT_SETTINGS },
  selectedIndex: 0,
  range: 30,
  progress: null,
  error: null,
  importResult: null,
};

const listeners = new Set<Listener>();

export function getState(): Readonly<AppState> {
  return state;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let notifyScheduled = false;

function notify(): void {
  // Coalesce bursts of updates into one render per frame — during an import, progress
  // messages arrive far faster than the screen refreshes.
  if (notifyScheduled) return;
  notifyScheduled = true;
  queueMicrotask(() => {
    notifyScheduled = false;
    for (const listener of listeners) listener(state);
  });
}

export function setState(patch: Partial<AppState>): void {
  Object.assign(state, patch);
  notify();
}

/**
 * Rebuilds the derived model from the current records and settings.
 *
 * Called on load, after an import, and after any settings change that affects the
 * metrics — the max-HR override re-scores every day's strain from stored histograms,
 * with no re-import.
 */
export function rebuildModel(options: { keepSelection?: boolean } = {}): void {
  const model = buildModel(state.records, state.settings);
  const previousDate = options.keepSelection ? state.model?.days[state.selectedIndex]?.date : null;

  let selectedIndex = latestScoredIndex(model);
  if (previousDate) {
    const found = model.days.findIndex((d) => d.date === previousDate);
    if (found >= 0) selectedIndex = found;
  }

  setState({ model, selectedIndex: Math.max(0, selectedIndex) });
}

export function selectIndex(index: number): void {
  const model = state.model;
  if (!model || !model.days.length) return;
  const clamped = Math.max(0, Math.min(model.days.length - 1, index));
  if (clamped === state.selectedIndex) return;
  setState({ selectedIndex: clamped });
}

export function selectDate(date: string): void {
  const model = state.model;
  if (!model) return;
  const index = model.days.findIndex((d) => d.date === date);
  if (index >= 0) selectIndex(index);
}

export function setRange(range: Range): void {
  if (state.range === range) return;
  setState({ range });
}

export function updateSettings(patch: Partial<UserSettings>): void {
  const settings = { ...state.settings, ...patch };
  setState({ settings });
  setHapticsEnabled(settings.haptics);
  applyTheme(settings);
  // Any of these change what the numbers *are*, so the model must be rebuilt.
  if ('sleepNeedMin' in patch || 'maxHr' in patch || 'birthYear' in patch) {
    rebuildModel({ keepSelection: true });
  }
}

/** Applies theme and motion preferences to the document root. */
export function applyTheme(settings: UserSettings): void {
  const root = document.documentElement;
  const theme =
    settings.theme === 'system'
      ? window.matchMedia?.('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : settings.theme;
  root.dataset.theme = theme;

  if (settings.reducedMotion === true) root.dataset.motion = 'reduced';
  else if (settings.reducedMotion === false) root.dataset.motion = 'full';
  else delete root.dataset.motion;

  const themeColor = theme === 'light' ? '#F4F6FB' : '#070A10';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor);
}

/** The days currently in view, honouring the selected range. */
export function visibleDays(): Model['days'] {
  const model = state.model;
  if (!model) return [];
  const end = state.selectedIndex + 1;
  const start = Math.max(0, end - state.range);
  return model.days.slice(start, end);
}

/** Index offset of the visible window, for mapping chart indices back to model days. */
export function visibleOffset(): number {
  return Math.max(0, state.selectedIndex + 1 - state.range);
}
