import type { FileText, SavedCopy } from '@shared/api';

/** The versions of a file in conflict, as Compare shows them. `attempted` only for a conflict an AI rollback left. */
export interface ConflictVersions {
  builder?: FileText;
  disk?: FileText;
  attempted?: FileText;
}

/** One version shown side by side with the others, and what it is called. */
export interface VersionPane {
  key: keyof ConflictVersions;
  label: string;
  version: FileText | undefined;
}

/**
 * The panes Compare shows for a conflict. A conflict an AI request's rollback left shows three: the version from before
 * the request (the one SiteOrigin Builder puts back), the file on disk now, and what the request tried to save, which
 * is there to look at only. Every other conflict shows the two it always has.
 */
export function conflictPanes(kind: 'canonical' | 'generated', v: ConflictVersions): VersionPane[] {
  if (v.attempted !== undefined)
    return [
      { key: 'builder', label: 'SiteOrigin Builder’s version, from before the AI request', version: v.builder },
      { key: 'disk', label: 'The file on disk now, edited outside SiteOrigin Builder', version: v.disk },
      { key: 'attempted', label: 'The version the AI request tried to save (shown only, not a choice)', version: v.attempted }
    ];
  return [
    { key: 'builder', label: kind === 'generated' ? 'SiteOrigin Builder’s version, made from your pages' : 'SiteOrigin Builder’s version', version: v.builder },
    { key: 'disk', label: 'The file on disk, edited outside SiteOrigin Builder', version: v.disk }
  ];
}

/** The versions a compare answer holds, with the attempted one only when the answer has it. */
export function shownVersions(r: ConflictVersions): ConflictVersions {
  return { builder: r.builder, disk: r.disk, ...(r.attempted !== undefined ? { attempted: r.attempted } : {}) };
}

/** Whether versions read again before a choice are the ones shown: every version shown, the attempted one too. */
export function sameVersions(shown: ConflictVersions, now: ConflictVersions): boolean {
  return (['builder', 'disk', 'attempted'] as const).every((k) => JSON.stringify(shown[k]) === JSON.stringify(now[k]));
}

/** What a saved copy is a copy of. */
export function savedCopyLabel(copy: Pick<SavedCopy, 'side' | 'removed'>): string {
  if (copy.side === 'attempted') return copy.removed ? 'The AI request’s attempted version, which removed the file' : 'The AI request’s attempted version';
  return copy.side === 'external' ? 'The file as edited outside SiteOrigin Builder' : 'SiteOrigin Builder’s version';
}

/** Past this many line pairs to weigh, the lines between the shared start and end are all marked as changed. */
const DIFF_LIMIT = 4_000_000;

/** How the lines of one version differ from another's. */
export interface LineDiff {
  /** Lines (by index) not in the other version. */
  changed: Set<number>;
  /** Lines (by index) just before which the other version has lines this one doesn't; the line count marks the end. */
  gaps: Set<number>;
  /** How many lines the other version has that this one doesn't. */
  missing: number;
  /** The versions were too long to match line by line: everything between their shared start and end is marked. */
  approximate: boolean;
}

/**
 * How `text` differs from `against`, line by line, so Compare can mark what differs on each side: the lines the two
 * share at the start and end are matched first, the rest by their longest common subsequence.
 */
export function lineDiff(text: string, against: string): LineDiff {
  const a = text.split('\n');
  const b = against.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const diff: LineDiff = { changed: new Set(), gaps: new Set(), missing: 0, approximate: false };
  const n = endA - start;
  const m = endB - start;
  if (!n || !m || n * m > DIFF_LIMIT) {
    for (let i = start; i < endA; i++) diff.changed.add(i);
    if (m && !n) diff.gaps.add(start);
    diff.missing = n ? 0 : m;
    diff.approximate = !!n && !!m;
    return diff;
  }
  // lcs[i][j]: the longest common subsequence of a[start + i..] and b[start + j..], in one flat array.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i * w + j] = a[start + i] === b[start + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  // Walked as hunks between matching lines: one with lines on both sides is a change (its lines here are marked);
  // one with lines only in the other version is a gap here, before the line that follows it.
  let i = 0;
  let j = 0;
  let here = 0;
  let there = 0;
  const close = () => {
    if (!here && there) {
      diff.gaps.add(start + i);
      diff.missing += there;
    }
    here = there = 0;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      close();
      i++;
      j++;
    } else if (i < n && (j >= m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
      diff.changed.add(start + i++);
      here++;
    } else {
      j++;
      there++;
    }
  }
  close();
  return diff;
}

/** What a pane's caption says of how it differs from the version it is compared with (`versus`, when named). */
export function diffCaption(d: LineDiff, versus?: string): string {
  const from = versus ? ` from ${versus}` : '';
  const lines = (n: number) => `${n} line${n === 1 ? '' : 's'}`;
  // Too long to match line by line: where it starts to differ, not a count that would overstate it.
  if (d.approximate) return `Differs${from} from line ${d.changed.values().next().value! + 1}`;
  const only = d.missing ? `${d.missing === 1 ? 'a line' : lines(d.missing)} only in ${versus ?? 'the other version'}` : '';
  if (d.changed.size) return `${lines(d.changed.size)} ${d.changed.size === 1 ? 'differs' : 'differ'}${from}${only && `, and ${only}`}`;
  if (only) return only.replace(/^a /, 'A ');
  return versus ? `Same as ${versus}` : 'Same as the other version';
}

/** Which lines of `text` (by index) are not in `against`. */
export const changedLines = (text: string, against: string): Set<number> => lineDiff(text, against).changed;

/** The day a saved copy was made, as a heading: Today, Yesterday, or its date (with the year when it isn't this one). */
export function savedCopyDay(savedAt: number, now = Date.now()): string {
  const day = (t: number) => new Date(t).toDateString();
  if (day(savedAt) === day(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day(savedAt) === day(yesterday.getTime())) return 'Yesterday';
  const sameYear = new Date(savedAt).getFullYear() === new Date(now).getFullYear();
  return new Date(savedAt).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}
