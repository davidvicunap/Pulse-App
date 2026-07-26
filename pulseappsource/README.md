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

Because there is no real export to develop against, `tools/generate-export.ts` produces a
synthetic one with *coupled* physiology — hard days suppress next-day HRV, short nights
depress recovery, and there's a slow fitness trend underneath — plus the messy cases that
break parsers:

- the same metric written by several sources, which naive parsers double-count
- sleep sessions spanning midnight, with staged sub-intervals and wake-ups
- sparse days, entirely missing days, and a simulated illness episode
- a timezone change partway through the history
- both pre- and post-iOS 16 sleep record formats

It has already earned its keep: it exposed a sleep-attribution bug where keying a night on
its end timestamp's calendar date split every night in two, because the stage blocks
between going to bed and midnight end on the *previous* day.

### Browser QA

Three harnesses drive the built app in a real browser, for the things unit tests can't
reach:

```bash
npm run build && npm run preview     # then, in another shell:
npm run qa:shots                     # screenshots of every view, light and dark
npm run qa:stress                    # large-export timing, jank and heap
npm run qa:audit                     # offline + accessibility checks
```

Measured on a 349MB / 730-day synthetic export:

| | |
| --- | --- |
| Import time | **6.9s** (50 MB/s) |
| Worst main-thread frame | **65ms** — zero frames over 100ms |
| Frame p95 during import | **17.1ms** (60fps held) |
| Peak JS heap | **9MB** for a 349MB file |
| Repeat launch from IndexedDB | **148ms** |
| Bundle | **40KB** gzipped JS, 8KB CSS |

`qa:audit` checks 24 properties including offline boot, focus trapping, keyboard-operable
charts, contrast, live regions and reduced-motion handling.

---

## Privacy

- **Nothing is uploaded.** There is no endpoint to upload to.
- **Only a daily summary is stored** — a few hundred KB, not the multi-hundred-MB export.
- **Delete everything, for real.** Settings → Delete all my data drops the database, the
  stored key and the caches.
- **Export your own data** as JSON at any time.

### The optional AI narrative

Off by default. If you enable it and supply your own Anthropic API key:

- only an **aggregated** weekly summary is sent — averages, week-over-week deltas and a
  workout count, with no timestamps and no individual readings
- the **exact payload is displayed** before you send anything
- the key is stored in this browser only, and one tap removes it
- the fully-local experience remains the default and is unaffected

The request goes directly from your browser to Anthropic. That is deliberate: the
alternative would be proxying your health summary through a server, which is the thing
this app exists to avoid.

---

## Accessibility

- Visible focus ring on every interactive element; the whole app is keyboard-operable.
- Charts are keyboard-scrubbable (arrows to read, `+`/`−` to zoom, `Enter` to open a day)
  and describe their controls to assistive tech.
- Sheets trap focus, are `role="dialog"` + `aria-modal`, close on `Escape`, and hide
  background content from screen readers.
- Body copy meets WCAG AA on its surface (6.15:1 measured).
- `prefers-reduced-motion` is honoured completely — animations resolve to their final
  state rather than being shortened. No information is ever carried by motion alone.
- Pinch-zoom is not disabled.

---

## Design

See [DESIGN.md](./DESIGN.md) for the full system. The short version: Pulse is an
**instrument display**, not a dashboard with a health theme. The ECG trace across the top
is synthesised from the selected day's own physiology — beat spacing from resting heart
rate, spacing *variance* from HRV (which is literally what HRV measures), amplitude from
recovery. The same trace draws itself to the true percentage during an import and
reappears as the sheet grab handle.

---

## Limitations

- Pulse is **not a medical device** and nothing in it is medical advice.
- It reads an export, not live data — Apple provides no way for a web app to read Health
  continuously, so keeping current means re-importing (which merges, rather than starting
  over).
- Recovery needs roughly three weeks of history before baselines mean much. Until then the
  app shows an explicit low-confidence state rather than a confident-looking number.
- Sleep staging is only as good as the device that recorded it.
- On iOS, a site that hasn't been added to the home screen can have its storage evicted
  after a period of inactivity. Installing the app makes this much less likely.

## Licence

MIT
