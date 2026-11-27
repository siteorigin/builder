import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type { ElementRef, ProjectState } from '@shared/types';
import { normalizeRoute } from '@shared/routes';
import { utf8Length } from '@shared/live/messages';
import { MAX_NOTES, MAX_NOTES_BYTES, normalizeNoteText, NOTE_TEXT_MAX, NOTE_SCHEMA, type LiveNote, type NoteAuthorRole, type NoteDraft } from '@shared/live/notes';
import { atomicWrite, toJson } from './fsutil';

/**
 * A project's pinned notes (#770), kept in its local state (`.siteorigin/notes.json`): never in the site's documents,
 * so no export or version carries them, and never anywhere but this computer. Read once, then kept; every change is
 * written whole, one at a time, and taken only once it is on disk.
 */

const FILE_SCHEMA = z.object({ notes: z.array(NOTE_SCHEMA).max(MAX_NOTES) }).strict();

/** A change to the notes, or why it was not made (shown to whoever asked). */
export type NotesChange = { ok: true; notes: readonly LiveNote[] } | { ok: false; message: string };
/**
 * Asked as a change's turn comes, and again just before it is written: null while whoever asked may still make it, or
 * why not now (their access changed while it waited).
 */
export type NotesAuthorize = () => string | null;

export class NotesStore {
  private notes: readonly LiveNote[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * `path` is the notes file; `whileOwner` runs a write only while this app still owns the project (the session's own
   * check), and says whether it ran.
   */
  constructor(
    readonly path: string,
    private readonly whileOwner: (fn: () => Promise<unknown>) => Promise<boolean>
  ) {}

  /** The notes, newest first. A file that cannot be read is set aside, so the next note starts a new list. */
  list(): Promise<readonly LiveNote[]> {
    return this.turn(() => this.load());
  }

  /** Keep a new note, first in the list; refused once the project holds MAX_NOTES, or MAX_NOTES_BYTES of them. */
  add(note: LiveNote, authorize?: NotesAuthorize): Promise<NotesChange> {
    return this.change((notes) => {
      if (notes.length >= MAX_NOTES) return FULL;
      const next = [note, ...notes];
      return utf8Length(JSON.stringify(next)) > MAX_NOTES_BYTES ? FULL : next;
    }, authorize);
  }

  resolve(id: string, resolved: boolean, authorize?: NotesAuthorize): Promise<NotesChange> {
    return this.change((notes) => (notes.some((n) => n.id === id) ? notes.map((n) => (n.id === id && n.resolved !== resolved ? { ...n, resolved } : n)) : GONE), authorize);
  }

  delete(id: string, authorize?: NotesAuthorize): Promise<NotesChange> {
    return this.change((notes) => (notes.some((n) => n.id === id) ? notes.filter((n) => n.id !== id) : GONE), authorize);
  }

  /** One change at a time, against the notes as the last one left them; nothing is kept that did not reach the disk. */
  private change(next: (notes: readonly LiveNote[]) => readonly LiveNote[] | string, authorize: NotesAuthorize = () => null): Promise<NotesChange> {
    return this.turn(async (): Promise<NotesChange> => {
      const refused = authorize();
      if (refused) return { ok: false, message: refused };
      const notes = await this.load();
      const changed = next(notes);
      if (typeof changed === 'string') return { ok: false, message: changed };
      // Nothing to write: resolving a note already resolved.
      if (changed.length === notes.length && changed.every((n, i) => n === notes[i])) return { ok: true, notes };
      let late: string | null = null;
      const wrote = await this.whileOwner(async () => {
        // Asked again with the project's lock held: access taken away while the file was read lands nothing.
        late = authorize();
        if (!late) await atomicWrite(this.path, toJson({ notes: changed }));
      });
      if (late) return { ok: false, message: late };
      if (!wrote) return { ok: false, message: 'The project’s notes can’t be saved right now.' };
      this.notes = changed;
      return { ok: true, notes: changed };
    }).catch((e: unknown) => ({ ok: false, message: `The project’s notes could not be saved: ${e instanceof Error ? e.message : String(e)}` }));
  }

  private turn<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<readonly LiveNote[]> {
    if (this.notes) return this.notes;
    let text: string | null = null;
    try {
      text = await fs.readFile(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (text === null) return (this.notes = []);
    let parsed: z.infer<typeof FILE_SCHEMA> | null = null;
    try {
      const read = FILE_SCHEMA.safeParse(JSON.parse(text));
      parsed = read.success ? read.data : null;
    } catch {
      parsed = null;
    }
    if (parsed) return (this.notes = parsed.notes);
    // Unreadable: kept beside it for whoever wants it back, never written over.
    await this.whileOwner(() => fs.rename(this.path, `${this.path.replace(/\.json$/, '')}-unreadable-${Date.now()}.json`)).catch(() => undefined);
    return (this.notes = []);
  }
}

const GONE = 'That note has already been deleted.';
const FULL = 'This project has as many notes as it can keep. Delete some before adding more.';

/**
 * The page a note is about, and the element it is pinned to: the page named, or the one whose address the preview
 * showed (its query and a trailing slash or none aside). An element is kept only on that page, or in the shared header
 * or footer it shows. Why not, when the place is none the project has.
 */
export function notePlace(state: ProjectState, draft: NoteDraft): { pageId: string; target: ElementRef | null } | string {
  const pageId = draft.pageId ?? (draft.previewPath !== undefined ? pageAtPath(state, draft.previewPath) : undefined);
  if (!pageId || !Object.hasOwn(state.pages, pageId)) return draft.pageId === undefined ? 'Notes can be left on the site’s pages, and this is not one of them.' : 'That page is no longer in the project.';
  const target = draft.target ?? null;
  if (target && !(target.owner.kind === 'page' && target.owner.id === pageId) && target.owner.kind !== 'shell') return 'A note can be pinned to something on its page, or in the header or footer.';
  return { pageId, target };
}

/** The page at an address in the preview, by its route. */
function pageAtPath(state: ProjectState, path: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(path, 'http://preview.invalid').pathname;
  } catch {
    return undefined;
  }
  const route = normalizeRoute(pathname);
  return Object.values(state.pages).find((p) => normalizeRoute(p.route) === route)?.id;
}

/** A new note from a draft whose place is checked, or why it cannot be one (its text). */
export function makeNote(draft: NoteDraft, place: { pageId: string; target: ElementRef | null }, author: { name: string; role: NoteAuthorRole }, now = Date.now()): LiveNote | string {
  const text = normalizeNoteText(draft.text);
  if (!text) return draft.text.trim() ? `A note can be at most ${NOTE_TEXT_MAX} characters, with no control characters.` : 'Write something in the note first.';
  const note: LiveNote = { id: randomUUID(), text, authorName: author.name, authorRole: author.role, createdAt: now, pageId: place.pageId, target: place.target, resolved: false };
  return NOTE_SCHEMA.safeParse(note).success ? note : 'That note cannot be kept.';
}
