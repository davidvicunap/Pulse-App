# Pulse-App
WHOOP like app but with Apple Health 
# Pulse

**A private, offline health dashboard for your Apple Health export.** Recovery, strain
and sleep — computed on your device, stored on your device, never uploaded.

Pulse reads the `export.zip` that the iPhone Health app produces and turns it into the
three numbers that actually tell you what to do today, with the reasoning behind every
one of them visible.

---

## The promise

There is no server. There is no account. There is no analytics.

Your export is parsed inside your browser by a Web Worker, reduced to a per-day summary,
and stored in IndexedDB on your device. Nothing is transmitted at any point. The app is
a static bundle — it can be served from a plain file server with no backend of any kind,
and once loaded it runs with the network switched off entirely.

The single exception is an **AI weekly narrative**, which is off by default and stays off
unless you explicitly enable it with your own Anthropic API key. Even then, only an
aggregated weekly summary is sent — never raw records — and the app shows you the exact
payload before anything leaves the device. See [Privacy](#privacy) below.

---

## What it does

**Recovery (0–100)** — how ready your body is today. A weighted blend of overnight HRV,
resting heart rate and sleep, each compared against your own adaptive baseline, with a
bounded penalty for an elevated overnight respiratory rate.

**Strain (0–21)** — how much cardiovascular load you took on, computed from **time spent
in heart-rate zones** rather than from calories. That distinction matters: an energy
proxy cannot tell a 45-minute walk from a 45-minute threshold run. When a day has too few
heart-rate samples, Pulse falls back to the energy proxy and labels it as an estimate
rather than pretending to a precision it doesn't have.

**Sleep** — duration against a personal need derived from your own habits, plus stage
composition, efficiency, latency, interruptions, 14-day debt, and how consistent your
wake time is.

Around those: a ranked insight feed, a weekly recap, a recovery heatmap calendar,
interactive trend charts, weekday/weekend and training/rest comparisons, and a
correlation explorer.

### Every number opens up

Tap any metric and a sheet shows each weighted input, the baseline it was measured
against, and the arithmetic that produced the score. A health score you can't interrogate
is one you stop trusting the first time it surprises you.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

You need an Apple Health export to see real data. To generate a realistic synthetic one:

```bash
npm run fixture -- --days 240 --zip --out fixtures/export.zip
```

Then drop that file into the app.

### Getting your real export

1. Open **Health** on your iPhone and tap your **profile photo** (top right).
2. Scroll to the bottom and tap **Export All Health Data**.
3. Wait for it to build — several years can take a few minutes — then **Save to Files**.
4. Drop the resulting `export.zip` into Pulse. Both `.zip` and raw `.xml` are accepted.

---

## Deploying

The build produces static files with no server-side anything.

```bash
npm run build        # -> dist/
```

Serve `dist/` from any static host — GitHub Pages, Netlify, S3, nginx, `python -m
http.server`. Asset URLs and the service worker's precache list are all **scope-relative**,
so it works from a domain root and from a subdirectory (a GitHub Pages project site)
without configuration.

The only requirement is HTTPS (or `localhost`), which service workers need. Without it the
app still works — it just isn't installable or offline-capable.

---

## Architecture

```
src/
  parse/       Streaming XML scanner + accumulator, run inside a Web Worker
  model/       Pure metric functions: recovery, strain, sleep, baselines, stats
  insights/    Analytics (trends, streaks, correlations) and the rule engine
  core/        Types, IndexedDB, merge, store, dates, formatting
  ui/          Views, sheets, and the canvas chart / ring / ECG components
  pwa/         Service worker
tools/         Fixture generator, icon generator, and browser QA harnesses
tests/         Vitest suites for everything under model/, parse/, insights/, core/
```

The dependency direction is strictly one way: `parse → model → insights → ui`. The model
layer is pure — no DOM, no clock, no storage — which is what lets 230 tests cover the
metrics without a single mock.

### Decisions worth knowing about

**No UI framework.** The app is one screen plus sheets, its updates are coarse, and its
most distinctive parts — the ECG trace, the ring, the charts — are imperative canvas
drawing that a virtual DOM would only get in the way of. `src/ui/dom.ts` is the entire
abstraction. The result ships in **40 KB gzipped**.

**Only one runtime dependency:** `fflate`, for streaming zip inflation inside the worker.

**Parsing is streaming, not buffering.** The file is pulled a chunk at a time and the zip
inflated incrementally; the XML is never materialised as a string. A 349MB export peaks
at **9MB of JS heap**.

**Per-day HR histograms are stored, not zone minutes.** Zones depend on your max heart
rate, which you can correct in Settings — and storing the histogram means that correction
re-scores your entire history instantly, with no re-import. It costs 38 numbers per day.

**Records are de-duplicated, not summed.** Apple Health routinely holds the same night of
sleep from a Watch, an iPhone and a third-party app. Overlapping intervals are merged and
per-source totals are resolved by preferring the Watch, so three devices recording one
night still produce one night.

**A day is only ever compared against days before it.** Baselines never look forward, so
paging back through history shows what each day actually looked like at the time.

---

## Testing

```bash
npm test             # 230 unit tests
npm run typecheck
```
