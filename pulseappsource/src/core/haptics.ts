/**
 * Haptic-style feedback.
 *
 * `navigator.vibrate` is unavailable on iOS Safari — the platform Pulse is most aimed
 * at — so this is strictly an enhancement and every call site must work without it.
 * Patterns are deliberately short: a haptic that outlasts the interaction reads as a
 * malfunction rather than feedback.
 */

const PATTERNS = {
  /** Selecting a day, switching a range. */
  tick: 8,
  /** Committing something — opening a sheet, confirming a choice. */
  open: [10, 24, 12],
  /** Reaching the end of a scrub or a list boundary. */
  bump: 18,
  /** An import finishing. */
  success: [12, 40, 18, 40, 26],
  /** Something went wrong. */
  warn: [30, 60, 30],
} as const;

export type HapticKind = keyof typeof PATTERNS;

let enabled = true;

export function setHapticsEnabled(value: boolean): void {
  enabled = value;
}

export function haptic(kind: HapticKind): void {
  if (!enabled) return;
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(PATTERNS[kind] as number | number[]);
  } catch {
    // Some browsers throw when vibration is blocked by a permissions policy.
  }
}
