import type { ElementRef, ProjectState } from '@shared/types';
import type { LiveNote, LiveNoteResult, NoteDraft } from '@shared/live/notes';
import { api, getState, setState, toast, type State } from '../store';
import { selectPage, setMode } from './actions';
import { hostPresenceOf } from './live-host';
import { admittedRemote, isRemoteShell } from './remote-session';
import { refExists, refLabel } from './model';
import { dayAndTime } from './when';

/**
 * The shown project's pinned notes (#770): short feedback a live session's participants leave on a page or one of its
 * elements, which the host keeps as a checklist. The editor reads them through the shown project's `notes` API, so in
 * the remote shell they are the host's, as far as this guest's role allows.
 */

/** What this editor may do with the notes it shows: leave one, and resolve or delete any. */
export interface NoteRights {
  add: boolean;
  manage: boolean;
}

export function noteRights(s: Pick<State, 'snapshot' | 'remote' | 'notes'>): NoteRights {
  if (!isRemoteShell(s)) return { add: true, manage: true };
  const remote = admittedRemote(s);
  if (!remote) return { add: false, manage: false };
  return { add: !!s.notes?.guestNotes, manage: remote.role === 'collaborator' };
}

/** The notes not yet resolved. */
export const openNotes = (notes: readonly LiveNote[]) => notes.filter((n) => !n.resolved);

/** Take a call's answer: the notes it left, or what went wrong, said once. False when nothing changed. */
function took(result: LiveNoteResult, opening: string): boolean {
  if (!result.ok) {
    toast(result.message, 'error');
    return false;
  }
  if (result.notes && getState().snapshot?.workspaceKey === opening) setState({ notes: { ...result.notes, opening } });
  return true;
}

const failed = (e: unknown): LiveNoteResult => ({ ok: false, message: `The notes could not be changed: ${e instanceof Error ? e.message : String(e)}` });

/** Where a note left now is pinned: the page the canvas shows and, when one is selected there, the element. Null off any page. */
export function notePlaceNow(s: Parameters<typeof hostPresenceOf>[0] = getState()): { pageId: string; target: ElementRef | null } | null {
  const at = hostPresenceOf(s);
  if (!at.pageId || !s.snapshot?.state.pages[at.pageId]) return null;
  return { pageId: at.pageId, target: at.selection };
}

/** Leave a note where the editor is now. True once it is kept. */
export async function addNote(text: string): Promise<boolean> {
  const s = getState();
  const opening = s.snapshot?.workspaceKey;
  const place = notePlaceNow(s);
  if (!opening || !place) {
    toast('Open a page to leave a note on it.', 'error');
    return false;
  }
  const draft: NoteDraft = { text, pageId: place.pageId, target: place.target };
  return took(await api.notes.add(opening, draft).catch(failed), opening);
}

export async function resolveNote(id: string, resolved: boolean): Promise<boolean> {
  const opening = getState().snapshot?.workspaceKey;
  if (!opening) return false;
  return took(await api.notes.resolve(opening, id, resolved).catch(failed), opening);
}

export async function deleteNote(id: string): Promise<boolean> {
  const opening = getState().snapshot?.workspaceKey;
  if (!opening) return false;
  return took(await api.notes.delete(opening, id).catch(failed), opening);
}

/**
 * Go to what a note is about: its page, with the element it is pinned to selected (and so outlined and scrolled to on
 * the canvas). An element no longer there opens its page, and says so; a page no longer there goes nowhere.
 */
export function jumpToNote(note: LiveNote): void {
  const st = getState().snapshot?.state;
  if (!st || !Object.hasOwn(st.pages, note.pageId)) {
    toast('That note’s page is no longer in the project.', 'info');
    return;
  }
  const target = note.target && refExists(st, note.target) ? note.target : null;
  if (target && getState().mode !== 'edit') setMode('edit');
  selectPage(note.pageId, target);
  if (note.target && !target) toast('What that note was pinned to is no longer on the page.', 'info');
}

/** Where a note is, in words: the element and its page, or the page. */
export function notePlaceLabel(state: ProjectState, note: Pick<LiveNote, 'pageId' | 'target'>): string {
  const page = Object.hasOwn(state.pages, note.pageId) ? state.pages[note.pageId].title || 'Untitled page' : 'A page since deleted';
  if (!note.target) return page;
  return refExists(state, note.target) ? `${refLabel(state, note.target)} on ${page}` : `${page} (element since removed)`;
}

/** How long ago a note was left: moments, minutes and hours, then the day and time. */
export function noteAge(createdAt: number, now = Date.now()): string {
  const mins = Math.floor(Math.max(0, now - createdAt) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)} h ago`;
  return dayAndTime(new Date(createdAt).toISOString(), new Date(now));
}
