import type { VersionReview } from '@shared/api';
import { plural } from './storage';
import { dayAndTime } from './when';

/** When a version was saved, as History shows it: the day as well as the time (“Today, 2:34 PM”, “Nov 21, 10:34 AM”, the
 *  year only when it is another), since versions are kept for long. */
export function savedAt(iso: string, locale?: string, now: Date = new Date()): string {
  return dayAndTime(iso, now, locale);
}

/** At most this many page titles are named on a line; the rest are counted. */
const SHOWN = 4;

/** “Home”, “About” and 2 more. */
function titles(list: string[]): string {
  const shown = list.slice(0, SHOWN).map((t) => `“${t}”`);
  const rest = list.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0] ?? '';
}

/** What restoring a version changes in the site as it is now, one line each, pages first. */
export function describeReview(r: VersionReview): string[] {
  const lines: string[] = [];
  const { back, gone, changed } = r.pages;
  if (back.length) lines.push(`Brings back ${plural(back.length, 'page', 'pages')}: ${titles(back)}`);
  if (gone.length) lines.push(`Removes ${plural(gone.length, 'page', 'pages')} it doesn’t have: ${titles(gone)}`);
  if (changed.length) lines.push(`Changes ${plural(changed.length, 'page', 'pages')}: ${titles(changed)}`);
  const e = r.entries;
  if (e.back.length) lines.push(`Brings back ${plural(e.back.length, 'entry', 'entries')}: ${titles(e.back)}`);
  if (e.gone.length) lines.push(`Removes ${plural(e.gone.length, 'entry', 'entries')} it doesn’t have: ${titles(e.gone)}`);
  if (e.changed.length) lines.push(`Changes ${plural(e.changed.length, 'entry', 'entries')}: ${titles(e.changed)}`);
  if (r.collections.length) lines.push(`Changes the settings of ${plural(r.collections.length, 'collection', 'collections')}: ${titles(r.collections)}`);
  if (r.site) lines.push('Changes site settings: the name, header, footer or page order');
  if (r.styles) lines.push('Changes site styles: colors, fonts and spacing');
  if (r.components) lines.push(`Changes ${plural(r.components, 'component', 'components')}`);
  if (r.library) lines.push('Changes the images and fonts in the library');
  const missing = r.files.length - r.replaced.length;
  if (missing) lines.push(`Puts back ${plural(missing, 'file', 'files')} the site uses`);
  if (r.replaced.length) lines.push(`Replaces ${plural(r.replaced.length, 'file', 'files')} changed since it was saved: ${r.replaced.map(fileName).join(', ')}`);
  if (r.left.length) lines.push(leftLine(r.left));
  return lines;
}

/**
 * The notice after a restore: what came back, and that the work it replaced is kept. Undo takes back documents only,
 * so files the restore put over others are pointed to the saved work from before.
 */
export function restoredNotice(name: string, kept: boolean, replaced = 0, left: string[] = []): string {
  const parts = [`Restored “${name}”.`];
  if (kept && !replaced) parts.push('Your work from before is kept in Saved versions.');
  if (kept && replaced) parts.push(`Undo won’t bring back the ${plural(replaced, 'file', 'files')} it replaced, but your work from before, kept in Saved versions, has ${replaced === 1 ? 'it' : 'them'}.`);
  if (left.length) parts.push(`${leftLine(left)}.`);
  return parts.join(' ');
}

/** Files an earlier restore put back that restoring the work from before leaves in the project folder. */
function leftLine(left: string[]): string {
  return `${plural(left.length, 'file', 'files')} the earlier restore put back ${left.length === 1 ? 'stays' : 'stay'} in the project folder, since its Undo needs ${left.length === 1 ? 'it' : 'them'}: ${left.map(fileName).join(', ')}`;
}

/** A file named by its own name, for lists of missing files. */
export const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
