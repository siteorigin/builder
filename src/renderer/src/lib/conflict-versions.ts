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

/** Whether versions read again before a choice are the ones shown: every version shown, the attempted one too. */
export function sameVersions(shown: ConflictVersions, now: ConflictVersions): boolean {
  return (['builder', 'disk', 'attempted'] as const).every((k) => JSON.stringify(shown[k]) === JSON.stringify(now[k]));
}

/** What a saved copy is a copy of. */
export function savedCopyLabel(side: SavedCopy['side']): string {
  return side === 'external' ? 'The file as edited outside SiteOrigin Builder' : side === 'attempted' ? 'The AI request’s attempted version' : 'SiteOrigin Builder’s version';
}
