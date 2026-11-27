import type { ImportChoices, ImportReviewRow } from '@shared/api';
import { api, getState, setState, toast, useStore } from '../store';

/** What the author decided to import: every chosen file that can be added, and the choices made for them. */
export interface ReviewedImport {
  paths: string[];
  /** How many files the author chose, those the review left out included. */
  chosen: number;
  choices: ImportChoices;
  /** The author was shown the review (a photo to convert, a large photo, or one that can't be added). */
  reviewed: boolean;
}

/**
 * The review on screen: settled with the paths that become web-sized copies, or null when it was dismissed.
 * `request` is the import it belongs to: an older import's files coming back later never take its place.
 */
let pending: { id: number; request: number; resolve: (webCopies: Set<string> | null) => void } | null = null;
let nextId = 0;
let requests = 0;

/** End the review `id` (when it is the one open): confirmed with the files to copy, or dismissed with null. */
export function settleImportReview(id: number, webCopies: Set<string> | null): void {
  if (pending?.id !== id) return;
  const { resolve } = pending;
  pending = null;
  resolve(webCopies);
}

/**
 * Show the review and wait for the author. Anything that takes its place dismisses it: another dialog, the project
 * closing or opening again, or the author leaving it (the editor is then inert, so it is taken off screen too).
 */
function ask(rows: ImportReviewRow[], opening: string, request: number): Promise<Set<string> | null> {
  if (pending) settleImportReview(pending.id, null);
  const id = ++nextId;
  return new Promise((resolve) => {
    pending = { id, request, resolve };
    setState({ modal: { kind: 'import-review', id, opening, rows } });
    const mine = getState().modal;
    const stop = useStore.subscribe((s) => {
      if (s.modal === mine && s.snapshot?.workspaceKey === opening && !s.leaving) return;
      stop();
      settleImportReview(id, null);
      if (getState().modal === mine) setState({ modal: null });
    });
  });
}

/**
 * A file the author must hear about before importing: a photo converted or offered a copy, or a picture that can't
 * be added. A file that is no picture at all is only named in a review shown anyway; on its own, the import says so.
 */
const needsReview = (r: ImportReviewRow) => r.action === 'convert' || r.action === 'offer' || (r.action === 'refuse' && !!r.format);

/**
 * Choose files (the chooser, unless `paths` are given) and say what each will become. When any is a HEIC photo, a
 * large photo or a file that can't be added, the author confirms in the import review first; ordinary files go
 * straight through. Null when nothing is to be imported (the chooser or the review was closed, or the project
 * changed meanwhile). `wanted` says whether whoever asked still wants the files once they have been read: when it
 * no longer does (the author moved on), no review is shown and nothing is to be imported.
 */
export async function reviewImport(paths: string[] | undefined, only?: 'image' | 'font' | 'document', wanted?: () => boolean): Promise<ReviewedImport | null> {
  const opening = getState().snapshot?.workspaceKey;
  if (!opening || getState().leaving) return null;
  const request = ++requests;
  const review = await api.project.reviewImport(paths, only);
  const current = () => getState().snapshot?.workspaceKey === opening && !getState().leaving;
  if (!review || !current() || (wanted && !wanted())) return null;
  const rows = review.rows;
  const reviewed = rows.some(needsReview);
  // Only one review is shown at a time: one for a later import, already on screen, wins over this one.
  if (reviewed && pending && pending.request > request) return null;
  // Another dialog opened while the files were being read (Find, say) keeps what the author typed in it.
  const other = getState().modal;
  if (reviewed && other && other.kind !== 'import-review') {
    toast('The files were not added because another dialog is open. Add them again once it is closed.', 'error');
    return null;
  }
  const webCopies = reviewed ? await ask(rows, opening, request) : new Set<string>();
  if (!webCopies || !current()) return null;
  // A file the review showed can't be added is left out: the review already said why.
  const refused = new Set(reviewed ? rows.filter((r) => r.action === 'refuse').map((r) => r.path) : []);
  const files = rows.filter((r) => (r.action === 'convert' || r.action === 'offer') && r.fingerprint).map((r) => ({ path: r.path, fingerprint: r.fingerprint!, webCopy: r.action === 'convert' || !!r.copyOnly || webCopies.has(r.path) }));
  return { paths: review.paths.filter((p) => !refused.has(p)), chosen: review.paths.length, choices: { opening, files }, reviewed };
}

/** Wait (briefly) until this window's project lists `assetId`: a record added by main reaches it with the next snapshot. */
export function assetArrived(assetId: string, opening: string, timeoutMs = 2000): Promise<boolean> {
  const has = () => {
    const snap = getState().snapshot;
    return snap?.workspaceKey === opening && Object.hasOwn(snap.state.assets.assets, assetId);
  };
  if (has()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      stop();
      clearTimeout(timer);
      resolve(v);
    };
    const stop = useStore.subscribe(() => {
      if (has()) done(true);
      else if (getState().snapshot?.workspaceKey !== opening) done(false);
    });
    const timer = setTimeout(() => done(has()), timeoutMs);
  });
}
