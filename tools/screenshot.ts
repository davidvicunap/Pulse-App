/**
 * Drives the built app in a real browser: imports a fixture export, waits for the
 * dashboard, and captures screenshots.
 *
 * This is the QA loop for a product whose most important behaviours — a non-blocking
 * parse, a scrubable chart, a sheet that opens — cannot be verified by unit tests.
 *
 * Usage: npx tsx tools/screenshot.ts [url] [fixture]
 */

import { chromium, type Page } from 'playwright';
import { existsSync, globSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const URL_BASE = process.argv[2] ?? 'http://127.0.0.1:4174/';
const FIXTURE = resolve(process.cwd(), process.argv[3] ?? 'fixtures/export.zip');
const OUT = resolve(process.cwd(), 'screenshots');

async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage });
  console.log(`  captured ${name}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  // The pinned Playwright build may not match the preinstalled browser directory, so
  // find the real binary rather than trusting a version-stamped path.
  const candidates = [
    ...globSync('/opt/pw-browsers/chromium-*/chrome-linux/chrome'),
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ];
  const executablePath = candidates.find((p) => existsSync(p));
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const context = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();

  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  console.log(`Loading ${URL_BASE}`);
  await page.goto(URL_BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.onboarding', { timeout: 15_000 });
  await page.waitForTimeout(700);
  await shoot(page, '01-onboarding');
  await shoot(page, '01-onboarding-full', true);

  console.log(`Importing ${FIXTURE}`);
  const started = Date.now();

  // Measure main-thread responsiveness *during* the parse — the whole point of the
  // worker is that this stays smooth.
  // Passed as a source string rather than a closure: tsx compiles arrow functions with
  // a `__name` helper that doesn't exist in the page, which breaks serialised closures.
  await page.evaluate(`
    window.__frames = [];
    (function () {
      var last = performance.now();
      requestAnimationFrame(function tick() {
        var now = performance.now();
        window.__frames.push(now - last);
        last = now;
        requestAnimationFrame(tick);
      });
    })();
  `);

  await page.setInputFiles('input[type=file]', FIXTURE);
  await page.waitForSelector('.importing', { timeout: 10_000 });
  await page.waitForTimeout(450);
  await shoot(page, '02-importing');

  await page.waitForSelector('.dash', { timeout: 180_000 });
  console.log(`  parsed + rendered in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const frames = (await page.evaluate('window.__frames')) as number[];
  const during = frames.slice(2);
  const longFrames = during.filter((f) => f > 100).length;
  const worst = during.length ? Math.max(...during) : 0;
  console.log(
    `  main thread: ${during.length} frames, worst ${worst.toFixed(0)}ms, ` +
      `${longFrames} frames over 100ms`,
  );

  await page.waitForTimeout(1600);
  await shoot(page, '03-dashboard');
  await shoot(page, '04-dashboard-full', true);

  // Detail sheet
  await page.click('.hero');
  await page.waitForSelector('.sheet.is-open', { timeout: 5000 });
  await page.waitForTimeout(600);
  await shoot(page, '05-recovery-sheet');
  await page.click('.sheet-close');
  await page.waitForTimeout(400);

  // Strain sheet, with heart-rate zones
  await page.click('.card[data-tone="cardio"]');
  await page.waitForSelector('.sheet.is-open', { timeout: 5000 });
  await page.waitForTimeout(600);
  await shoot(page, '06-strain-sheet');
  const sheetBody = await page.$('.sheet-body');
  await sheetBody?.evaluate('el => el.scrollTop = 320');
  await page.waitForTimeout(300);
  await shoot(page, '07-strain-zones');
  await page.click('.sheet-close');
  await page.waitForTimeout(400);

  // Sleep sheet
  await page.click('.card[data-tone="somnus"]');
  await page.waitForSelector('.sheet.is-open', { timeout: 5000 });
  await page.waitForTimeout(600);
  await shoot(page, '08-sleep-sheet');
  await page.click('.sheet-close');
  await page.waitForTimeout(400);

  // Chart scrub
  const chart = await page.$('.chart-surface');
  if (chart) {
    const box = (await chart.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.62, box.y + box.height / 2, { steps: 12 });
    await page.waitForTimeout(350);
    await chart.scrollIntoViewIfNeeded();
    await shoot(page, '09-chart-scrub');
    await page.mouse.up();
  }

  // Heatmap + analysis modules
  const heatmap = await page.$('.heatmap');
  await heatmap?.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await shoot(page, '10-heatmap');

  const correlation = await page.$('.scatter');
  await correlation?.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await shoot(page, '11-correlation');

  // Settings
  await page.evaluate('window.scrollTo(0, 0)');
  await page.waitForTimeout(300);
  await page.click('.icon-btn');
  await page.waitForSelector('.sheet.is-open', { timeout: 5000 });
  await page.waitForTimeout(600);
  await shoot(page, '12-settings');

  // Light theme
  await page.click('.segmented-btn:has-text("Light")');
  await page.waitForTimeout(800);
  await shoot(page, '13-settings-light');
  const closeBtn = await page.$('.sheet-close');
  await closeBtn?.click();
  await page.waitForTimeout(600);
  await shoot(page, '14-dashboard-light');
  await shoot(page, '15-dashboard-light-full', true);

  // Back to dark
  await page.click('.icon-btn');
  await page.waitForTimeout(500);
  await page.click('.segmented-btn:has-text("Dark")');
  await page.waitForTimeout(500);
  const close2 = await page.$('.sheet-close');
  await close2?.click();
  await page.waitForTimeout(500);

  // ── Persistence: reload and confirm we land straight on the dashboard ──
  console.log('Reloading to test persistence…');
  const reloadStart = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.dash', { timeout: 15_000 });
  console.log(`  restored from IndexedDB in ${Date.now() - reloadStart}ms (no re-import)`);
  await page.waitForTimeout(1400);
  await shoot(page, '16-after-reload');

  // ── Desktop viewport ──
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const desktopPage = await desktop.newPage();
  await desktopPage.goto(URL_BASE, { waitUntil: 'networkidle' });
  await desktopPage.waitForSelector('.dash', { timeout: 20_000 }).catch(() => undefined);
  await desktopPage.waitForTimeout(1500);
  await desktopPage.screenshot({ path: resolve(OUT, '17-desktop.png') });
  console.log('  captured 17-desktop');

  if (errors.length) {
    console.log(`\n⚠️  ${errors.length} console error(s):`);
    for (const e of [...new Set(errors)].slice(0, 12)) console.log(`   ${e}`);
  } else {
    console.log('\n✓ No console errors');
  }

  await browser.close();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
