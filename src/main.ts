/**
 * Entry point.
 *
 * The boot sequence is ordered around one goal: a repeat visit should reach an
 * interactive dashboard from IndexedDB without ever showing an import screen.
 */

import './styles/tokens.css';
import './styles/app.css';

import { applyTheme, getState, rebuildModel, setState } from './core/store';
import { loadDays, loadSettings, requestPersistence } from './core/db';
import { setHapticsEnabled } from './core/haptics';
import { App } from './ui/app';

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) return;

  const app = new App(root);
  // Exposed so the install prompt and any future integration can drive an import.
  (window as unknown as { pulse: App }).pulse = app;

  // Settings first — they decide the theme, so applying them before data avoids a
  // flash of the wrong palette on a light-theme user's device.
  let settings = getState().settings;
  try {
    settings = await loadSettings();
    setState({ settings });
  } catch {
    // A blocked or missing IndexedDB still leaves a perfectly usable app; it just
    // can't remember anything between sessions.
  }
  applyTheme(settings);
  setHapticsEnabled(settings.haptics);

  try {
    const records = await loadDays();
    if (records.length) {
      setState({ records });
      rebuildModel();
      setState({ view: 'dashboard' });
    } else {
      setState({ view: 'onboarding' });
    }
  } catch (err) {
    setState({ view: 'onboarding' });
    if (err instanceof Error) {
      app.showToast('Stored data could not be read, so Pulse is starting fresh.', 'error');
    }
  }

  // Ask the browser to keep our data through storage pressure. Best-effort: on iOS
  // this materially reduces the chance of eviction for an installed app.
  void requestPersistence();

  registerServiceWorker();
  watchSystemTheme();
}

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  // Vite serves modules individually in dev, which a precache-everything worker would
  // fight with — so it only runs in a real build.
  if (import.meta.env.DEV) return;
  const register = () => {
    // A plain relative path, resolved against the page — so this registers correctly
    // whether the app is served from a domain root or a subdirectory.
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
      // Offline support is an enhancement — a registration failure is not user-facing.
    });
  };

  // `boot()` awaits IndexedDB before reaching this point, by which time `load` has
  // usually already fired — so a bare `addEventListener('load', …)` would silently
  // never run, and the app would never actually go offline-capable.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

/** Keeps the 'Auto' theme setting honest when the OS switches appearance. */
function watchSystemTheme(): void {
  const media = window.matchMedia?.('(prefers-color-scheme: light)');
  media?.addEventListener?.('change', () => {
    const { settings } = getState();
    if (settings.theme === 'system') applyTheme(settings);
  });
}

void boot();
