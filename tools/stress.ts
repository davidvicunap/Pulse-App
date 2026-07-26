/**
 * Large-export stress test.
 *
 * Verifies the two claims that matter for a real Apple Health export — which can easily
 * exceed 300MB — and which no unit test can prove:
 *
 *   1. The main thread stays responsive throughout. We run a heartbeat on the page and
 *      measure the worst frame gap during the import.
 *   2. Memory stays bounded. We sample `performance.memory` while parsing, so a parser
 *      that quietly buffers the whole file shows up as a rising heap.
 *
 * Usage: npx tsx tools/stress.ts [url] [fixture]
 */

import { chromium } from 'playwright';
import { existsSync, globSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const URL_BASE = process.argv[2] ?? 'http://127.0.0.1:4174/';
const FIXTURE = resolve(process.cwd(), process.argv[3] ?? 'fixtures/big-export.xml');

async function main(): Promise<void> {
  const bytes = statSync(FIXTURE).size;
  console.log(`Fixture: ${FIXTURE} (${(bytes / 1e6).toFixed(1)}MB)\n`);

  const candidates = [
    ...globSync('/opt/pw-browsers/chromium-*/chrome-linux/chrome'),
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ];
  const executablePath = candidates.find((p) => existsSync(p));
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--enable-precise-memory-info'],
  });
  const page = await browser.newPage({ viewport: { width: 414, height: 896 } });

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(URL_BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.onboarding', { timeout: 20_000 });

  // Heartbeat + heap sampler, as a source string (tsx's helpers don't exist in-page).
  await page.evaluate(`
    window.__stats = { frames: [], heap: [], progress: [] };
    (function () {
      var last = performance.now();
      requestAnimationFrame(function tick() {
        var now = performance.now();
        window.__stats.frames.push(now - last);
        last = now;
        if (performance.memory) window.__stats.heap.push(performance.memory.usedJSHeapSize);
        var pct = document.querySelector('.import-percent');
        if (pct) window.__stats.progress.push(parseInt(pct.textContent, 10) || 0);
        requestAnimationFrame(tick);
      });
    })();
  `);

  console.log('Importing…');
  const started = Date.now();
  await page.setInputFiles('input[type=file]', FIXTURE);
  await page.waitForSelector('.importing', { timeout: 20_000 });
  await page.waitForSelector('.dash', { timeout: 600_000 });
  const elapsed = Date.now() - started;

  const stats = (await page.evaluate('window.__stats')) as {
    frames: number[];
    heap: number[];
    progress: number[];
  };

  const frames = stats.frames.slice(3);
  const sorted = [...frames].sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.floor(q * (sorted.length - 1))] ?? 0;
  const worst = sorted[sorted.length - 1] ?? 0;
  const janky = frames.filter((f) => f > 100).length;

  const heapMb = stats.heap.map((h) => h / 1e6);
  const peakHeap = heapMb.length ? Math.max(...heapMb) : 0;

  // Progress should climb monotonically and reach the end, not jump 0 → 100.
  const progress = stats.progress;
  const distinct = new Set(progress).size;
  const monotonic = progress.every((v, i) => i === 0 || v >= progress[i - 1]);

  console.log(`\n─── Results ───────────────────────────────────`);
  console.log(`File size          ${(bytes / 1e6).toFixed(1)} MB`);
  console.log(`Total time         ${(elapsed / 1000).toFixed(1)}s  (${(bytes / 1e6 / (elapsed / 1000)).toFixed(1)} MB/s)`);
  console.log(`Frames sampled     ${frames.length}`);
  console.log(`Frame p50 / p95    ${p(0.5).toFixed(1)}ms / ${p(0.95).toFixed(1)}ms`);
  console.log(`Worst frame        ${worst.toFixed(0)}ms`);
  console.log(`Frames over 100ms  ${janky}`);
  console.log(`Peak JS heap       ${peakHeap.toFixed(0)} MB`);
  console.log(`Progress steps     ${distinct} distinct values, monotonic: ${monotonic}`);
  console.log(`Console errors     ${errors.length}`);

  const days = await page.textContent('.foot-meta');
  console.log(`Result             ${days?.trim().split('·')[0].trim()}`);

  const verdict: string[] = [];
  if (worst > 400) verdict.push(`✗ a ${worst.toFixed(0)}ms frame is a visible freeze`);
  else verdict.push(`✓ no visible freeze (worst frame ${worst.toFixed(0)}ms)`);
  if (peakHeap > 900) verdict.push(`✗ heap peaked at ${peakHeap.toFixed(0)}MB — not bounded`);
  else if (peakHeap > 0) verdict.push(`✓ heap bounded at ${peakHeap.toFixed(0)}MB for a ${(bytes / 1e6).toFixed(0)}MB file`);
  if (distinct < 5) verdict.push(`✗ progress only showed ${distinct} values — not a real bar`);
  else verdict.push(`✓ progress advanced through ${distinct} values`);
  if (errors.length) verdict.push(`✗ ${errors.length} console error(s): ${errors[0]}`);
  else verdict.push('✓ no console errors');

  console.log(`\n${verdict.join('\n')}`);
  await browser.close();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
