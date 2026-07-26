# Pulse — Design System

> A precision instrument reading a body at rest.

## The one-sentence commitment

Pulse is not a dashboard with a health theme. It is an **instrument display**: the
graphics are readings, not decoration. Every signature element in the app is bound to
real physiology.

**Sanity check — "would I produce this for any health app?"** A generic answer is
"dark background, teal accent, rounded cards, a progress ring." That describes a
hundred apps. So the identity is pushed onto three specific, non-transferable choices:

### 1. The ECG trace is data-bound

The waveform across the top of the app is **synthesized from the selected day's own
physiology**, not a looping decoration:

| Trace property     | Driven by                                                     |
| ------------------ | ------------------------------------------------------------- |
| Beat spacing       | Resting heart rate (60 bpm → one beat per second of trace)     |
| Spacing *variance* | HRV — higher HRV literally renders as more variable spacing    |
| Amplitude          | Recovery score                                                 |
| Stroke colour      | Recovery band (vital / caution / alert)                        |

This is the one graphic no other app can copy without also copying the idea: HRV is
*defined* as beat-to-beat variation, so drawing it as beat-to-beat variation makes the
signature element self-explanatory. It recurs as: the app header, the parse progress
indicator (the trace draws left-to-right at the true percentage), the bottom-sheet grab
handle, and the empty state.

### 2. Phosphor persistence

Every motion in the app follows one physical metaphor — a CRT phosphor being struck and
decaying. Values that change **burn in bright, then settle**. Charts *draw* rather than
fade. The recovery ring fills like a sweep, not a bar. There is no animation in Pulse
that isn't this metaphor, which is what keeps motion from reading as decoration.

### 3. Instrument readouts

All numerics are JetBrains Mono with `tabular-nums` so digits never shift width when
values update. Units are always smaller, dimmer, and offset — the way a real gauge
separates magnitude from scale. Labels are letter-spaced uppercase mono at 10.5px:
the typographic voice of a device, not a web app.

---

## Colour tokens

Named values, dark theme (default):

| Token           | Hex       | Role                                      |
| --------------- | --------- | ----------------------------------------- |
| `ink`           | `#070A10` | Deepest background                        |
| `graphite`      | `#0D111A` | Panel surface                             |
| `slate`         | `#141A26` | Raised surface, inputs                    |
| `hairline`      | `#1E2434` | Borders, dividers                         |
| `bone`          | `#ECEFF6` | Primary text                              |
| `ash`           | `#8B93A9` | Secondary text                            |
| `iron`          | `#575F75` | Tertiary text, axis labels                |
| `phosphor`      | `#5EEAD4` | Signature accent, ECG trace, focus ring   |
| `phosphor-wash` | `#0E3B36` | Accent background wash                    |
| `vital`         | `#34D399` | Recovery high / positive delta            |
| `caution`       | `#FBBF24` | Recovery moderate / warning               |
| `alert`         | `#F87171` | Recovery low / negative delta             |
| `cardio`        | `#60A5FA` | Strain                                    |
| `somnus`        | `#A78BFA` | Sleep                                     |
| `rose`          | `#F0A0C0` | Resting heart rate                        |

The background is deliberately darker than a typical `#111` app shell so the phosphor
accent has more range to glow against — the accent should read as *emitted light*.

**Light theme** is a genuine re-map, not an inversion. The bright phosphor fails
contrast on white, so it deepens to `#0F766E` for text/strokes while the bright value is
retained only for large fills. Surfaces: `paper #F7F8FC`, `card #FFFFFF`,
`hairline #E3E7F0`, text `#0F1420`.

## Type scale

Two families, strictly divided by role:

- **Space Grotesk** — labels, headings, prose. 400/500/600/700.
- **JetBrains Mono** — every number, eyebrow, tag, axis. 400/500/700/800.

| Step        | Size   | Use                          |
| ----------- | ------ | ---------------------------- |
| `eyebrow`   | 10.5px | Mono, `.28em` tracking, caps |
| `micro`     | 11px   | Tags, deltas                 |
| `meta`      | 12.5px | Captions, chart labels       |
| `body`      | 13.5px | Insight copy                 |
| `lead`      | 15px   | Emphasis prose               |
| `title`     | 19px   | Sheet + section titles       |
| `display`   | 30px   | Onboarding headline          |
| `readout`   | 56px   | The recovery number          |

Both families are **self-hosted** (`public/fonts/`) so the app renders correctly with
no network at all — a Google Fonts `<link>` would break the offline promise.

## Spacing, radii, elevation

4px base grid: `4 8 12 16 20 24 32 40 56`.
Radii: `sm 10 / md 14 / lg 18 / xl 24 / pill 999`.
Elevation is expressed with border + inner highlight rather than large shadows — a
device panel has edges, not drop shadows.

## Layout

Single column, `max-width: 560px`, centred, safe-area padded. Depth is reached through
**bottom sheets** rather than page navigation, so the user never loses their place —
this is what makes it feel like an app rather than a document.

Order of the stack: ECG ribbon → day navigator → recovery hero → metric rail →
insights → analysis modules (trends, heatmap, comparisons, correlations).

## States

Every module ships four states, written in the interface's own voice:

- **Loading** — skeleton blocks with a phosphor sweep, never a spinner (spinners
  communicate "unknown duration"; parsing has a known duration, so it gets a real bar).
- **Empty** — an invitation naming the exact action ("Import a Health export to see
  90 days of trend"), never "No data".
- **Low confidence** — a first-class state. When a baseline has too few observations,
  the number is replaced with a `LOW CONFIDENCE` chip rather than shown misleadingly.
- **Error** — specific and non-apologetic: "That zip has no export.xml in it" beats
  "Something went wrong."

## Motion

All durations are tokens: `snap 120ms`, `base 220ms`, `sweep 600ms`, `draw 900ms`.
Easing: `cubic-bezier(.22,.61,.36,1)` (a decay curve — phosphor, again).

`prefers-reduced-motion: reduce` is honoured **fully**: the ECG stops sweeping, charts
render at final state, the ring appears filled, sheets snap instead of slide. No
information is ever conveyed by motion alone.

## Accessibility floor

- Visible `:focus-visible` ring (2px phosphor + 2px offset) on every interactive element.
- All numbers have `aria-label`s that spell out the value and its unit.
- Sheets are focus-trapped, `Escape`-dismissable, `role="dialog"` + `aria-modal`.
- Body text meets WCAG AA on its surface; `ash` on `graphite` is 5.9:1, `iron` is
  reserved for non-essential labels that are duplicated elsewhere.
- Charts are keyboard-scrubbable with arrow keys and expose a text summary.
