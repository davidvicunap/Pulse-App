/**
 * Settings.
 *
 * Organised by what the user controls, not by how the code is structured — calibration
 * first (the settings that change the numbers), then appearance, then the data controls.
 *
 * The privacy section is deliberately the most detailed thing in here. A promise that
 * "nothing leaves your device" is only meaningful if the user can see exactly what is
 * stored and delete all of it in one action, so both are first-class controls rather
 * than a buried link.
 */

import { getState, rebuildModel, setState, updateSettings } from '../../core/store';
import { deleteAllData, estimateUsage, getLastImport } from '../../core/db';
import { bytes as fmtBytes, count, duration } from '../../core/format';
import { formatFullDate } from '../../core/dates';
import { h, render } from '../dom';
import { openSheet, Sheet } from '../sheet';
import { haptic } from '../../core/haptics';
import { openAiSheet } from './ai-sheet';

type Section = 'all' | 'privacy';

export function openSettingsSheet(focus: Section = 'all'): void {
  openSheet({ title: 'Settings', eyebrow: 'PULSE' }, (body) => {
    render(
      body,
      calibrationSection(),
      appearanceSection(),
      privacySection(),
      aboutSection(),
    );
    if (focus === 'privacy') {
      requestAnimationFrame(() => {
        body.querySelector('[data-section="privacy"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  });
}

// ─────────────────────────── building blocks ───────────────────────────

function group(title: string, note: string | null, ...rows: (HTMLElement | null)[]): HTMLElement {
  return h('section', { class: 'settings-group' },
    h('h3', { class: 'sheet-section' }, title),
    note ? h('p', { class: 'section-note' }, note) : null,
    ...rows,
  );
}

function row(label: string, hint: string | null, control: HTMLElement): HTMLElement {
  return h('div', { class: 'settings-row' },
    h('div', { class: 'settings-label' },
      h('span', null, label),
      hint ? h('small', null, hint) : null,
    ),
    h('div', { class: 'settings-control' }, control),
  );
}

function segmented<T extends string | number>(
  options: Array<{ value: T; label: string }>,
  current: T,
  onChange: (value: T) => void,
  ariaLabel: string,
): HTMLElement {
  const el = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': ariaLabel });
  for (const option of options) {
    el.append(
      h('button', {
        class: `segmented-btn${option.value === current ? ' is-on' : ''}`,
        type: 'button',
        role: 'radio',
        'aria-checked': option.value === current ? 'true' : 'false',
        onclick: () => {
          haptic('tick');
          onChange(option.value);
        },
      }, option.label),
    );
  }
  return el;
}

function toggle(checked: boolean, onChange: (value: boolean) => void, ariaLabel: string): HTMLElement {
  const btn = h('button', {
    class: `switch${checked ? ' is-on' : ''}`,
    type: 'button',
    role: 'switch',
    'aria-checked': checked ? 'true' : 'false',
    'aria-label': ariaLabel,
    onclick: () => {
      haptic('tick');
      onChange(!checked);
    },
  }, h('i', null));
  return btn;
}

// ─────────────────────────── sections ───────────────────────────

/** The settings that change what the numbers actually are. */
function calibrationSection(): HTMLElement {
  const state = getState();
  const { settings, model } = state;
  const profile = model?.profile;

  const sleepNeed = settings.sleepNeedMin ?? profile?.sleepNeedMin ?? 465;
  const maxHr = settings.maxHr ?? profile?.maxHr ?? 185;

  const sleepValue = h('output', { class: 'range-value' }, duration(sleepNeed));
  const sleepSlider = h('input', {
    type: 'range', min: '360', max: '600', step: '15',
    value: String(sleepNeed),
    'aria-label': 'Sleep need in minutes',
    oninput: (e: Event) => {
      sleepValue.textContent = duration(Number((e.target as HTMLInputElement).value));
    },
    onchange: (e: Event) => {
      updateSettings({ sleepNeedMin: Number((e.target as HTMLInputElement).value) });
    },
  });

  const hrValue = h('output', { class: 'range-value' }, `${maxHr} bpm`);
  const hrSlider = h('input', {
    type: 'range', min: '140', max: '220', step: '1',
    value: String(maxHr),
    'aria-label': 'Maximum heart rate',
    oninput: (e: Event) => {
      hrValue.textContent = `${(e.target as HTMLInputElement).value} bpm`;
    },
    onchange: (e: Event) => {
      updateSettings({ maxHr: Number((e.target as HTMLInputElement).value) });
    },
  });

  return group(
    'Calibration',
    'These change how your scores are computed. Adjusting them re-scores your whole ' +
      'history immediately — no re-import needed.',
    row('Sleep need', settings.sleepNeedMin ? 'Set by you' : 'Derived from your habits',
      h('div', { class: 'range-wrap' }, sleepSlider, sleepValue)),
    row('Max heart rate', profile?.maxHrIsUserSet ? 'Set by you' : 'Estimated from your data',
      h('div', { class: 'range-wrap' }, hrSlider, hrValue)),
    row('Reset calibration', 'Go back to values derived from your data',
      h('button', {
        class: 'btn btn-quiet', type: 'button',
        onclick: () => {
          updateSettings({ sleepNeedMin: null, maxHr: null });
          haptic('tick');
          reopen();
        },
      }, 'Reset')),
  );
}

function appearanceSection(): HTMLElement {
  const { settings } = getState();
  return group(
    'Appearance',
    null,
    row('Theme', null, segmented(
      [
        { value: 'dark' as const, label: 'Dark' },
        { value: 'light' as const, label: 'Light' },
        { value: 'system' as const, label: 'Auto' },
      ],
      settings.theme,
      (theme) => {
        updateSettings({ theme });
        reopen();
      },
      'Theme',
    )),
    row('Units', null, segmented(
      [
        { value: 'metric' as const, label: 'Metric' },
        { value: 'imperial' as const, label: 'Imperial' },
      ],
      settings.units,
      (units) => {
        updateSettings({ units });
        reopen();
      },
      'Units',
    )),
    row('Reduce motion', 'Charts and the ring appear at their final state',
      segmented(
        [
          { value: 'auto' as const, label: 'Auto' },
          { value: 'on' as const, label: 'On' },
          { value: 'off' as const, label: 'Off' },
        ],
        settings.reducedMotion === null ? 'auto' : settings.reducedMotion ? 'on' : 'off',
        (value) => {
          updateSettings({ reducedMotion: value === 'auto' ? null : value === 'on' });
          reopen();
        },
        'Reduce motion',
      )),
    row('Haptics', 'Short vibrations on key interactions, where supported',
      toggle(settings.haptics, (haptics) => {
        updateSettings({ haptics });
        reopen();
      }, 'Haptics')),
  );
}

function privacySection(): HTMLElement {
  const { model, settings } = getState();
  const storageEl = h('span', { class: 'settings-stat' }, 'checking…');
  const lastImportEl = h('span', { class: 'settings-stat' }, '—');

  void estimateUsage().then((usage) => {
    storageEl.textContent = usage ? `${fmtBytes(usage.bytes)} used` : 'not reported by this browser';
  });
  void getLastImport().then((summary) => {
    lastImportEl.textContent = summary
      ? `${formatFullDate(new Date(summary.importedAt).toISOString().slice(0, 10))} · ${summary.fileName}`
      : 'no import recorded';
  });

  const section = h('section', { class: 'settings-group', dataset: { section: 'privacy' } },
    h('h3', { class: 'sheet-section' }, 'Your data'),
    h('div', { class: 'privacy-card' },
      h('p', null,
        h('b', null, 'Pulse has no server. '),
        'Your export is parsed in this browser, and the daily summary is stored in this ' +
        'browser\'s local database. Nothing is uploaded, there is no account, and no ' +
        'analytics of any kind are collected. Closing the tab changes nothing; deleting ' +
        'your data below removes it completely.'),
      h('ul', { class: 'privacy-facts' },
        h('li', null, h('span', null, 'Stored on this device'), h('b', null,
          model ? `${count(model.profile.daysWithData)} days` : 'nothing yet')),
        h('li', null, h('span', null, 'Storage used'), storageEl),
        h('li', null, h('span', null, 'Last import'), lastImportEl),
        h('li', null, h('span', null, 'Sent to a server'), h('b', { class: 'is-good' }, 'nothing, ever')),
      ),
    ),

    row('Export your data', 'Download everything Pulse holds, as JSON',
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: exportData }, 'Export')),

    row('Import more days', 'Merges with what you already have',
      h('button', {
        class: 'btn btn-quiet', type: 'button',
        onclick: () => document.dispatchEvent(new CustomEvent('pulse:import')),
      }, 'Import')),

    row('AI weekly narrative', settings.aiEnabled ? 'Enabled — uses your own API key' : 'Off. Everything stays local.',
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => openAiSheet() },
        settings.aiEnabled ? 'Manage' : 'Set up')),

    h('div', { class: 'danger-zone' },
      h('div', { class: 'settings-label' },
        h('span', null, 'Delete all my data'),
        h('small', null, 'Removes every stored day and setting from this browser. This cannot be undone.'),
      ),
      h('button', { class: 'btn btn-danger', type: 'button', onclick: confirmDelete }, 'Delete everything'),
    ),
  );

  return section;
}

function aboutSection(): HTMLElement {
  return group(
    'About',
    null,
    h('p', { class: 'sheet-foot' },
      'Pulse reads an Apple Health export and turns it into recovery, strain and sleep. ' +
      'It is not a medical device, and nothing here is medical advice — if a number worries ' +
      'you, talk to a clinician rather than to a dashboard.'),
    h('p', { class: 'sheet-foot' },
      'Recovery weighs HRV, resting heart rate and sleep against your own rolling baselines. ' +
      'Strain is computed from time in heart-rate zones. Sleep is scored against a personal ' +
      'need derived from your own habits. Every one of those numbers can be opened up and ' +
      'inspected from the dashboard.'),
  );
}

// ─────────────────────────── actions ───────────────────────────

/** Re-renders the sheet in place after a change that affects other controls. */
function reopen(): void {
  const scroll = document.querySelector('.sheet-body')?.scrollTop ?? 0;
  openSettingsSheet();
  requestAnimationFrame(() => {
    const body = document.querySelector('.sheet-body');
    if (body) body.scrollTop = scroll;
  });
}

function exportData(): void {
  const { records, settings } = getState();
  const payload = {
    app: 'pulse',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    days: records,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pulse-data-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  // Revoke on the next tick so the download has definitely started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  haptic('success');
}

/**
 * Deleting everything is irreversible, so it takes a deliberate second step.
 * The confirmation states exactly what will be removed rather than asking
 * "are you sure?".
 */
function confirmDelete(): void {
  const sheet = new Sheet({ title: 'Delete everything?' });
  const { model } = getState();

  render(
    sheet.body,
    h('p', { class: 'sheet-note' },
      `This removes ${model ? count(model.profile.daysWithData) : 'all'} stored days, your ` +
      `settings, and any saved API key from this browser. Your original Health export on ` +
      `your phone is untouched. There is no backup and no undo.`),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => sheet.close() }, 'Keep my data'),
      h('button', {
        class: 'btn btn-danger', type: 'button',
        onclick: async () => {
          try {
            await deleteAllData();
            haptic('success');
            setState({
              records: [],
              model: null,
              selectedIndex: 0,
              view: 'onboarding',
              importResult: null,
              error: null,
            });
            rebuildModel();
            sheet.close();
            document.querySelectorAll('.sheet').forEach((s) => s.remove());
            document.body.classList.remove('sheet-open');
            document.getElementById('app')?.removeAttribute('aria-hidden');
          } catch (err) {
            haptic('warn');
            render(sheet.body,
              h('div', { class: 'note note-alert' },
                err instanceof Error ? err.message : 'The data could not be deleted.'),
              h('div', { class: 'sheet-actions' },
                h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => sheet.close() }, 'Close')),
            );
          }
        },
      }, 'Delete everything'),
    ),
  );
  sheet.open();
}
