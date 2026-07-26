/**
 * Date handling.
 *
 * Everything in Pulse keys off a **local calendar date string** (`YYYY-MM-DD`) taken
 * from the export's own timestamps. Apple Health writes timestamps with their original
 * UTC offset (`2024-03-11 07:32:15 -0700`), which means the date portion is already the
 * date the user experienced. Re-deriving it through `Date` in the browser's current
 * zone would silently shift days for anyone who travels — so we slice the string
 * instead, and never round-trip a day key through a Date for identity purposes.
 */

import type { DateKey } from './types';

/**
 * Parses an Apple Health timestamp to epoch ms.
 * Format: `YYYY-MM-DD HH:MM:SS ±HHMM`. Returns NaN on anything unparseable.
 */
export function parseHealthDate(s: string): number {
  if (!s) return NaN;
  // `2024-03-11 07:32:15 -0700` → `2024-03-11T07:32:15-07:00`
  const iso = s.replace(' ', 'T').replace(/\s([+-]\d{2})(\d{2})$/, '$1:$2');
  const t = Date.parse(iso);
  if (!Number.isNaN(t)) return t;
  // Some third-party writers emit a plain `Z` or no offset at all.
  return Date.parse(s);
}

/** The local calendar date the export recorded, taken verbatim from the timestamp. */
export function dateKeyOf(healthTimestamp: string): DateKey {
  return healthTimestamp.slice(0, 10);
}

/** `YYYY-MM-DD` for a JS Date, in the *browser's* local zone. For UI "today" only. */
export function dateKeyOfDate(d: Date): DateKey {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayKey(): DateKey {
  return dateKeyOfDate(new Date());
}

/**
 * A Date positioned at local noon on the given key.
 * Noon, not midnight, so that DST transitions (which move midnight) can never push the
 * date to the previous or next day.
 */
export function dateFromKey(key: DateKey): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 12, 0, 0, 0);
}

export function addDays(key: DateKey, days: number): DateKey {
  const d = dateFromKey(key);
  d.setDate(d.getDate() + days);
  return dateKeyOfDate(d);
}

/** Whole days from `a` to `b` (negative if `b` precedes `a`). */
export function daysBetween(a: DateKey, b: DateKey): number {
  const ms = dateFromKey(b).getTime() - dateFromKey(a).getTime();
  return Math.round(ms / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(key: DateKey): number {
  return dateFromKey(key).getDay();
}

export function isWeekend(key: DateKey): boolean {
  const d = weekdayOf(key);
  return d === 0 || d === 6;
}

/** Every date key from `start` to `end` inclusive. */
export function dateRange(start: DateKey, end: DateKey): DateKey[] {
  const out: DateKey[] = [];
  const total = daysBetween(start, end);
  if (total < 0) return out;
  for (let i = 0; i <= total; i++) out.push(addDays(start, i));
  return out;
}

const WEEKDAY_SHORT = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function weekdayShort(key: DateKey): string {
  return WEEKDAY_SHORT[weekdayOf(key)];
}

export function monthShort(key: DateKey): string {
  return MONTH_SHORT[dateFromKey(key).getMonth()];
}

/** `Mar 11` */
export function formatDayLabel(key: DateKey): string {
  const d = dateFromKey(key);
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
}

/** `Mar 11, 2024` */
export function formatFullDate(key: DateKey): string {
  const d = dateFromKey(key);
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** ISO week key (`2024-W11`) for weekly grouping and the weekly recap. */
export function isoWeekKey(key: DateKey): string {
  const d = dateFromKey(key);
  // Shift to Thursday of the same week — the ISO definition anchor.
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day + 3);
  const isoYear = d.getFullYear();
  const firstThursday = new Date(isoYear, 0, 4, 12, 0, 0, 0);
  const firstDay = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDay + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** Clock time (minutes past midnight) → `11:32 PM`. */
export function formatClock(minutesOfDay: number, hour12 = true): string {
  const total = ((Math.round(minutesOfDay) % 1440) + 1440) % 1440;
  const h24 = Math.floor(total / 60);
  const m = total % 60;
  if (!hour12) return `${String(h24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const suffix = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}
