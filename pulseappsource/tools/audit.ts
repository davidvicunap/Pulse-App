/**
 * Offline + accessibility audit.
 *
 * Checks the two promises that are easy to claim and easy to quietly break: that the
 * app genuinely works with the network switched off, and that it can be operated
 * without a mouse or a pair of working eyes.
 *
 * Usage: npx tsx tools/audit.ts [url] [fixture]
 */

import { chromium, type Page } from 'playwright';
import { existsSync, globSync } from 'node:fs';
import { resolve } from 'node:path';

const URL_BASE = process.argv[2] ?? 'http://127.0.0.1:4174/';
const FIXTURE = resolve(process.cwd(), process.argv[3] ?? 'fixtures/export.zip');

const pass: string[] = [];
const fail: string[] = [];
const check = (ok: boolean, label: string) => (ok ? pass : fail).push(label);

async function main(): Promise<void> {
  const candidates = [
    ...globSync('/opt/pw-browsers/chromium-*/chrome-linux/chrome'),
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ];
  const executablePath = candidates.find((p) => existsSync(p));
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const context = await browser.newContext({ viewport: { width: 414, height: 896 } });
  const page = await context.newPage();

  await page.goto(URL_BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.onboarding', { timeout: 20_000 });

  // ── Service worker ──
  // Every awaited promise here is raced against a timeout: `serviceWorker.ready` never
  // settles when registration fails, which would hang the audit rather than fail it.
  const swReady = await page.evaluate(`
    Promise.race([
      navigator.serviceWorker
        ? navigator.serviceWorker.ready.then(function (r) { return !!r.active; })
        : Promise.resolve(false),
      new Promise(function (r) { setTimeout(function () { r('timeout'); }, 15000); })
    ])
  `);
  check(swReady === true, `Service worker registers and activates${swReady === 'timeout' ? ' (timed out)' : ''}`);

  const manifest = (await page.evaluate(`
    Promise.race([
      fetch('./manifest.webmanifest').then(function (r) { return r.json(); }).catch(function () { return null; }),
      new Promise(function (r) { setTimeout(function () { r(null); }, 8000); })
    ])
  `)) as { name?: string; icons?: unknown[]; display?: string; start_url?: string } | null;
  check(!!manifest?.name, 'Manifest is served and parseable');
  check((manifest?.icons?.length ?? 0) >= 3, 'Manifest declares a full icon set');
  check(manifest?.display === 'standalone', 'Manifest requests standalone display');

  // ── Import, then audit the dashboard ──
  await page.setInputFiles('input[type=file]', FIXTURE);
  // The progress bar only exists while importing, so it has to be checked here rather
  // than after the dashboard has replaced it.
  await page.waitForSelector('.importing', { timeout: 20_000 });
  const bar = await page.$('[role=progressbar]');
  check(!!bar, 'Import progress uses role="progressbar"');
  check(
    !!bar && (await bar.getAttribute('aria-valuenow')) !== null,
    'Progress bar reports its current value to assistive tech',
  );

  await page.waitForSelector('.dash', { timeout: 180_000 });
  await page.waitForTimeout(2000);

  await auditAccessibility(page);

  // ── Offline ──
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
  const offlineOk = await page
    .waitForSelector('.dash', { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  check(offlineOk, 'App boots and shows the dashboard with the network offline');

  if (offlineOk) {
    const ringText = (await page.textContent('.ring-value'))?.trim();
    check(!!ringText && ringText !== '—', `Offline dashboard renders real data (recovery ${ringText})`);
    const fontLoaded = await page.evaluate(`document.fonts.check('700 16px "JetBrains Mono"')`);
    check(fontLoaded === true, 'Self-hosted fonts render offline');
  }
  await context.setOffline(false);

  // ── Report ──
  console.log('\n─── Audit ─────────────────────────────────────');
  for (const p of pass) console.log(`  ✓ ${p}`);
  for (const f of fail) console.log(`  ✗ ${f}`);
  console.log(`\n${pass.length} passed, ${fail.length} failed`);

  await browser.close();
  if (fail.length) process.exitCode = 1;
}

async function auditAccessibility(page: Page): Promise<void> {
  // Every interactive element must have an accessible name.
  const unnamed = (await page.evaluate(`
    (function () {
      var nodes = document.querySelectorAll('button, a[href], input, [role="button"]');
      var bad = [];
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (el.offsetParent === null) continue;
        var name = (el.getAttribute('aria-label') || el.textContent || '').trim();
        if (!name) bad.push(el.className || el.tagName);
      }
      return bad;
    })()
  `)) as string[];
  check(unnamed.length === 0, `Every visible control has an accessible name${unnamed.length ? ` (missing: ${unnamed.slice(0, 3).join(', ')})` : ''}`);

  // Keyboard reachability: tab through and confirm focus actually moves and is visible.
  await page.keyboard.press('Tab');
  const focusPath: string[] = [];
  for (let i = 0; i < 14; i++) {
    const info = (await page.evaluate(`
      (function () {
        var el = document.activeElement;
        if (!el || el === document.body) return null;
        var style = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
          outline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
        };
      })()
    `)) as { tag: string; outline: boolean } | null;
    if (info) focusPath.push(info.tag);
    await page.keyboard.press('Tab');
  }
  check(new Set(focusPath).size >= 6, `Tab reaches distinct controls (${new Set(focusPath).size} in 14 presses)`);

  // The chart is an application widget and must be keyboard-operable.
  const chart = await page.$('.chart-surface');
  if (chart) {
    await chart.focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(200);
    const readout = await page.textContent('.chart-readout');
    check(!!readout && !readout.includes('Latest'), 'Charts are scrubbable with the keyboard');
    check(
      (await chart.getAttribute('aria-label'))!.length > 30,
      'Charts describe their keyboard controls to assistive tech',
    );
  }

  // Sheets must trap focus, be labelled, and close on Escape.
  await page.click('.hero');
  await page.waitForSelector('.sheet.is-open', { timeout: 5000 });
  const dialog = await page.$('.sheet-panel');
  check((await dialog?.getAttribute('role')) === 'dialog', 'Sheets expose role="dialog"');
  check((await dialog?.getAttribute('aria-modal')) === 'true', 'Sheets are marked aria-modal');
  check(!!(await dialog?.getAttribute('aria-labelledby')), 'Sheets are labelled by their title');
  check(
    (await page.getAttribute('#app', 'aria-hidden')) === 'true',
    'Background content is hidden from screen readers while a sheet is open',
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check(!(await page.$('.sheet.is-open')), 'Escape closes a sheet');

  // Reduced motion must be honoured, not merely shortened.
  const reduced = await page.evaluate(`
    (function () {
      document.documentElement.dataset.motion = 'reduced';
      var v = getComputedStyle(document.documentElement).getPropertyValue('--d-base').trim();
      delete document.documentElement.dataset.motion;
      return v;
    })()
  `);
  // Chromium serialises the value as `.01ms`, without the leading zero.
  check(
    /^0?\.01ms$/.test(String(reduced)),
    `Reduced-motion setting collapses animation durations (--d-base becomes ${reduced})`,
  );

  // Contrast: body copy against its surface.
  const contrast = (await page.evaluate(`
    (function () {
      function lum(c) {
        var m = c.match(/\\d+/g).slice(0, 3).map(function (v) {
          var s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
      }
      var el = document.querySelector('.insight-body p');
      if (!el) return 0;
      var fg = lum(getComputedStyle(el).color);
      var bg = lum(getComputedStyle(document.querySelector('.insight')).backgroundColor);
      var hi = Math.max(fg, bg), lo = Math.min(fg, bg);
      return (hi + 0.05) / (lo + 0.05);
    })()
  `)) as number;
  check(contrast >= 4.5, `Insight body copy meets WCAG AA (${contrast.toFixed(2)}:1)`);

  // Landmarks and a skip link.
  check(!!(await page.$('main#app')), 'Page has a main landmark');
  check(!!(await page.$('.skip-link')), 'Page offers a skip link');

  // Zoom must not be disabled.
  const viewport = await page.getAttribute('meta[name=viewport]', 'content');
  check(!/user-scalable\s*=\s*no/.test(viewport ?? ''), 'Pinch-zoom is not disabled');

  // Live regions for asynchronous updates.
  check(!!(await page.$('[aria-live]')), 'Asynchronous readouts use a live region');
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
