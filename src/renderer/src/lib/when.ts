/**
 * When something happened, as History says it: a clock time under a day heading for recent changes, and a day with a
 * time for saved versions, so an entry from an earlier day never reads as this morning's.
 */

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const DAY = 86400e3;

/** Whole calendar days between `iso` and `now` (0 today, 1 yesterday). */
export function daysAgo(iso: string, now: Date = new Date()): number {
  return Math.round((startOfDay(now) - startOfDay(new Date(iso))) / DAY);
}

/** The key two times share when they fall on the same local day. */
export const dayKey = (iso: string) => String(startOfDay(new Date(iso)));

/** A day heading: Today, Yesterday, else the weekday and date (with the year when it is another year), one form for all. */
export function dayName(iso: string, now: Date = new Date(), locale?: string): string {
  const d = new Date(iso);
  const ago = daysAgo(iso, now);
  if (ago === 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  return d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'short', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}

/** The time of day, without a leading zero: 9:58 AM. */
export const clock = (iso: string, locale?: string) => new Date(iso).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });

/** A day and a time on one line: “Today, 2:34 PM”, “Nov 21, 10:34 AM”. */
export function dayAndTime(iso: string, now: Date = new Date(), locale?: string): string {
  const ago = daysAgo(iso, now);
  const day = ago === 0 || ago === 1 ? dayName(iso, now, locale) : new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', ...(new Date(iso).getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
  return `${day}, ${clock(iso, locale)}`;
}

/** “Today, 2:34 PM” inside a sentence: “saved today, 2:34 PM”. */
export const lowerDay = (when: string) => when.replace(/^(Today|Yesterday)\b/, (d) => d.toLowerCase());

/** The whole date and time, for a tooltip or a screen reader: Tuesday 24 November 2026 at 9:58 AM. */
export const fullWhen = (iso: string, locale?: string) =>
  new Date(iso).toLocaleString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });
