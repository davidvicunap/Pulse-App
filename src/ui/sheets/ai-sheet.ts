/**
 * The optional AI narrative — the one feature that can touch the network.
 *
 * It is off by default and stays off unless the user explicitly turns it on with their
 * own API key. The design rules it follows, in order of importance:
 *
 *   1. **Raw records never leave the device.** Only a small aggregated summary is sent —
 *      weekly averages and deltas, no timestamps, no individual readings.
 *   2. **The user sees the exact payload before it is sent**, rendered verbatim, with no
 *      "roughly this" hand-waving.
 *   3. **The key is stored locally only** and can be removed in one tap.
 *   4. **The local experience never degrades.** Turning this on adds a narrative; it
 *      changes nothing else about the app.
 */

import { getState, updateSettings } from '../../core/store';
import { buildWeeklyRecap, type WeeklyRecap } from '../../insights/recap';
import { duration } from '../../core/format';
import { h, render } from '../dom';
import { openSheet } from '../sheet';
import { haptic } from '../../core/haptics';

const KEY_STORAGE = 'pulse.aiKey';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5';

/** The aggregated summary — the only thing that would ever be transmitted. */
export interface NarrativePayload {
  weekOf: string;
  daysCovered: number;
  averages: Record<string, string>;
  changesVsLastWeek: Record<string, string>;
  workouts: number;
  notes: string[];
}

/**
 * Builds the payload from a recap.
 * Deliberately lossy: averages and deltas only, so no individual night, workout or
 * reading can be reconstructed from it.
 */
export function buildPayload(recap: WeeklyRecap): NarrativePayload {
  const averages: Record<string, string> = {};
  const changes: Record<string, string> = {};
  for (const metric of recap.metrics) {
    if (metric.value == null) continue;
    averages[metric.label] = metric.format(metric.value);
    if (metric.changePct != null) {
      changes[metric.label] = `${metric.changePct > 0 ? '+' : ''}${metric.changePct.toFixed(0)}%`;
    }
  }
  return {
    weekOf: recap.startDate,
    daysCovered: recap.daysCovered,
    averages,
    changesVsLastWeek: changes,
    workouts: recap.workouts,
    notes: recap.notes,
  };
}

function getKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

function setKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Private browsing can block localStorage; the feature simply stays unavailable.
  }
}

export function openAiSheet(): void {
  openSheet({ title: 'AI weekly narrative', eyebrow: 'OPTIONAL' }, (body) => {
    render(body, renderState(body));
  });
}

function renderState(body: HTMLElement): HTMLElement {
  const { settings, model, selectedIndex } = getState();
  const key = getKey();
  const recap = model ? buildWeeklyRecap(model, selectedIndex) : null;

  const container = h('div', null);

  container.append(
    h('div', { class: 'note note-caution' },
      h('strong', null, 'This is the only feature that uses the network. '),
      'Everything else in Pulse works with no connection at all. Leave this off and your ' +
      'data never touches another machine.'),

    h('p', { class: 'sheet-note' },
      'If you turn it on, Pulse sends a short aggregated summary of your week to Anthropic ' +
      'using your own API key, and shows you the reply as a written narrative. Your raw ' +
      'records — individual nights, workouts, heart-rate readings — are never included.'),
  );

  if (!recap) {
    container.append(
      h('p', { class: 'sheet-empty' }, 'You need at least a week of data before there is anything to narrate.'),
    );
    return container;
  }

  const payload = buildPayload(recap);

  container.append(
    h('h3', { class: 'sheet-section' }, 'Exactly what would be sent'),
    h('p', { class: 'section-note' }, 'This is the verbatim payload — nothing else is transmitted.'),
    h('pre', { class: 'payload' }, JSON.stringify(payload, null, 2)),
  );

  if (!settings.aiEnabled || !key) {
    const input = h('input', {
      class: 'text-input',
      type: 'password',
      placeholder: 'sk-ant-…',
      'aria-label': 'Anthropic API key',
      autocomplete: 'off',
    }) as HTMLInputElement;

    container.append(
      h('h3', { class: 'sheet-section' }, 'Your API key'),
      h('p', { class: 'section-note' },
        'Stored in this browser only, never sent anywhere except to Anthropic on your behalf. ' +
        'You can remove it at any time, and deleting your data removes it too.'),
      input,
      h('div', { class: 'sheet-actions' },
        h('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: () => {
            const value = input.value.trim();
            if (!value) {
              input.focus();
              return;
            }
            setKey(value);
            updateSettings({ aiEnabled: true });
            haptic('success');
            render(body, renderState(body));
          },
        }, 'Enable narrative'),
      ),
    );
    return container;
  }

  const output = h('div', { class: 'narrative' });
  container.append(
    h('div', { class: 'sheet-actions' },
      h('button', {
        class: 'btn btn-primary', type: 'button',
        onclick: async (e: Event) => {
          const btn = e.currentTarget as HTMLButtonElement;
          btn.disabled = true;
          btn.textContent = 'Writing…';
          render(output, h('div', { class: 'skeleton skeleton-text' }), h('div', { class: 'skeleton skeleton-text' }));
          try {
            const text = await requestNarrative(payload, key);
            render(output, h('p', null, text));
            haptic('success');
          } catch (err) {
            render(output,
              h('div', { class: 'note note-alert' },
                err instanceof Error ? err.message : 'The request failed.'));
            haptic('warn');
          } finally {
            btn.disabled = false;
            btn.textContent = 'Write this week’s narrative';
          }
        },
      }, 'Write this week’s narrative'),
      h('button', {
        class: 'btn btn-quiet', type: 'button',
        onclick: () => {
          setKey(null);
          updateSettings({ aiEnabled: false });
          haptic('tick');
          render(body, renderState(body));
        },
      }, 'Remove key & disable'),
    ),
    output,
  );

  return container;
}

/**
 * Calls the Anthropic Messages API directly from the browser.
 *
 * `anthropic-dangerous-direct-browser-access` is required for a browser-origin call. It
 * is the correct choice here precisely *because* there's no backend: the alternative
 * would be proxying the user's health summary through a server we control, which is the
 * thing this app exists to avoid. The key is the user's own and never leaves their
 * machine except to Anthropic.
 */
async function requestNarrative(payload: NarrativePayload, key: string): Promise<string> {
  const prompt =
    `You are writing a short weekly summary for someone reading their own recovery data. ` +
    `Here is an aggregated summary of their week:\n\n${JSON.stringify(payload, null, 2)}\n\n` +
    `Write 3–4 sentences in plain, direct language. Say what changed and what it suggests ` +
    `they do next week. No greetings, no hedging, no medical claims, no bullet points.`;

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch {
    throw new Error('Could not reach the API. Check your connection — the rest of Pulse works offline.');
  }

  if (response.status === 401) throw new Error('That API key was rejected. Check it and try again.');
  if (response.status === 429) throw new Error('Rate limited by the API. Wait a moment and retry.');
  if (!response.ok) throw new Error(`The API returned ${response.status}. Nothing was stored.`);

  const data = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  if (!text) throw new Error('The API returned an empty response.');
  return text;
}

/** Used by the recap sheet to show sleep totals consistently. */
export { duration as formatDuration };
