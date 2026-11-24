import type { VersionReview } from '@shared/api';
import { plural } from './storage';

/** When a version was saved, as History shows it: the date as well as the time, since versions are kept for long. */
export function savedAt(iso: string, locale?: string): string {
  return new Date(iso).toLocaleString(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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
  if (r.site) lines.push('Changes site settings: the name, header, footer or page order');
  if (r.styles) lines.push('Changes site styles: colors, fonts and spacing');
  if (r.components) lines.push(`Changes ${plural(r.components, 'component', 'components')}`);
  if (r.library) lines.push('Changes the images and fonts in the library');
  if (r.files.length) lines.push(`Puts back ${plural(r.files.length, 'file', 'files')} the site uses`);
  return lines;
}

/** The notice after a restore: what came back, and that the work it replaced is kept. */
export function restoredNotice(name: string, kept: boolean): string {
  return kept ? `Restored “${name}”. Your work from before is kept in Saved versions.` : `Restored “${name}”.`;
}

/** A file named by its own name, for lists of missing files. */
export const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
