/**
 * Formatting for instrument readouts.
 *
 * The rule the whole app follows: a number is never shown without knowing whether it's
 * real. `null` formats as an em dash, never as `0`, `NaN` or `--` — because in health
 * data "I didn't measure this" and "this was zero" mean opposite things.
 */

export const EMPTY = '—';

export function num(value: number | null | undefined, decimals = 0): string {
  if (value == null || !Number.isFinite(value)) return EMPTY;
  return value.toFixed(decimals);
}

/** `7h 24m`, or `24m` under an hour. */
export function duration(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return EMPTY;
  const total = Math.round(Math.abs(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  const sign = minutes < 0 ? '-' : '';
  if (h === 0) return `${sign}${m}m`;
  return `${sign}${h}h ${String(m).padStart(2, '0')}m`;
}

/** `7.4` hours — for axis labels where `7h 24m` is too wide. */
export function hours(minutes: number | null | undefined, decimals = 1): string {
  if (minutes == null || !Number.isFinite(minutes)) return EMPTY;
  return (minutes / 60).toFixed(decimals);
}

/** Thousands-separated integer. */
export function count(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return EMPTY;
  return Math.round(value).toLocaleString();
}

/** `1.4M`, `12K`, `840` — for dense readouts. */
export function compact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return EMPTY;
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${Math.round(value / 1000)}K`;
  if (abs >= 1_000) return `${(value / 1000).toFixed(1)}K`;
  return String(Math.round(value));
}

export function bytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return EMPTY;
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`;
  if (value >= 1e3) return `${Math.round(value / 1e3)} KB`;
  return `${Math.round(value)} B`;
}

/** Always carries an explicit sign — deltas are meaningless without direction. */
export function signed(value: number | null | undefined, decimals = 0, unit = ''): string {
  if (value == null || !Number.isFinite(value)) return EMPTY;
  const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
  return `${sign}${Math.abs(value).toFixed(decimals)}${unit}`;
}

export function percent(value: number | null | undefined, decimals = 0): string {
  if (value == null || !Number.isFinite(value)) return EMPTY;
  return `${value.toFixed(decimals)}%`;
}

/** `3 days ago`, `just now` — for the "data through" line. */
export function relativeDays(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

export function distance(km: number | null | undefined, units: 'metric' | 'imperial'): string {
  if (km == null || !Number.isFinite(km)) return EMPTY;
  return units === 'imperial' ? `${(km / 1.609344).toFixed(1)} mi` : `${km.toFixed(1)} km`;
}

export function mass(kg: number | null | undefined, units: 'metric' | 'imperial'): string {
  if (kg == null || !Number.isFinite(kg)) return EMPTY;
  return units === 'imperial' ? `${(kg / 0.45359237).toFixed(1)} lb` : `${kg.toFixed(1)} kg`;
}

/** Pluralises without the `(s)` that makes interfaces read like forms. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
