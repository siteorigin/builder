import { z } from 'zod';
import { DISPLAY_NAME_MAX, MAX_ID_LENGTH } from './limits';
import { normalizeDisplayName } from './names';
import { ELEMENT_REF_SCHEMA, PREVIEW_PATH_SCHEMA } from './messages';

/**
 * Pinned notes (#770): short feedback a live session's participants leave on a page or an element of it ("Swap this
 * hero photo"), kept by the host as a checklist it resolves. Deliberately not a chat: each note is one short line, with
 * no replies, reactions or typing. The host keeps them in its project's local state (never in the site's documents or
 * its export) after the session ends. Imports nothing of the app, so the relay and the guests' viewer read it as it is.
 */

/** The most a note says, in characters (code points) once normalized. */
export const NOTE_TEXT_MAX = 280;
/** The most notes a project keeps, open and resolved. */
export const MAX_NOTES = 200;
/**
 * The most the whole list may hold as JSON, in UTF-8 bytes, so a guest's `notes.list` answer always fits in one frame
 * (MAX_FRAME_BYTES), with room for the frame around it however deep each note's element is.
 */
export const MAX_NOTES_BYTES = 512 * 1024;
/** The most notes one guest may leave in a session. */
export const GUEST_NOTE_LIMIT = 20;
/** Notes a guest may leave in a burst, and how often one more is allowed after. */
export const GUEST_NOTE_BURST = 3;
export const GUEST_NOTE_REFILL_MS = 15_000;

export const NOTE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Who left a note: the host, or a guest in the role it held then. */
export const NOTE_AUTHOR_ROLES = ['host', 'viewer', 'copy-editor', 'collaborator'] as const;
export type NoteAuthorRole = (typeof NOTE_AUTHOR_ROLES)[number];

/**
 * A note's text as it is kept: in Unicode normal form C, every run of spaces or line breaks made one space, trimmed,
 * 1 to NOTE_TEXT_MAX characters, with no controls or invisible characters. Null when nothing usable is left.
 */
export function normalizeNoteText(raw: unknown): string | null {
  return normalizeDisplayName(raw, NOTE_TEXT_MAX);
}

const noteText = z.string().refine((s) => normalizeNoteText(s) === s, { message: `Must be 1 to ${NOTE_TEXT_MAX} characters, trimmed, with no control characters.` });
const authorName = z.string().refine((s) => normalizeDisplayName(s, DISPLAY_NAME_MAX) === s, { message: `Must be 1 to ${DISPLAY_NAME_MAX} characters.` });
const pageId = z.string().min(1).max(MAX_ID_LENGTH);

/** One note, as the host keeps it and every participant is shown it. */
export const NOTE_SCHEMA = z
  .object({
    id: z.string().regex(NOTE_ID_RE),
    text: noteText,
    authorName,
    authorRole: z.enum(NOTE_AUTHOR_ROLES),
    /** When it was left, in milliseconds since the epoch on the host's clock. */
    createdAt: z.number().int().nonnegative(),
    /** The page it is on. */
    pageId,
    /** The element it is pinned to, on that page or its header or footer; null for the page itself. */
    target: ELEMENT_REF_SCHEMA.nullable(),
    resolved: z.boolean()
  })
  .strict();
export type LiveNote = z.infer<typeof NOTE_SCHEMA>;

/** The project's notes, newest first, and whether the host lets guests leave notes now. */
export interface LiveNotes {
  notes: LiveNote[];
  guestNotes: boolean;
}

export const NOTES_SCHEMA = z.object({ notes: z.array(NOTE_SCHEMA).max(MAX_NOTES), guestNotes: z.boolean() }).strict();

/**
 * A note being left: its text (normalized by whoever keeps it), and where, as exactly one of a page or an address. A
 * guest in the browser knows only the address its preview shows (`previewPath`), which the host finds the page for; an
 * editor names the page and, when one is selected, the element. Who left it, and when, the keeper decides.
 */
export const NOTE_DRAFT_SCHEMA = z
  .object({
    // A little longer than a note may be, so text that normalizes down to one (spaces run together) is not refused.
    text: z.string().max(NOTE_TEXT_MAX * 4),
    pageId: pageId.optional(),
    previewPath: PREVIEW_PATH_SCHEMA.optional(),
    target: ELEMENT_REF_SCHEMA.nullable().optional()
  })
  .strict()
  .refine((d) => (d.pageId === undefined) !== (d.previewPath === undefined), { message: 'Name the page the note is on, or its address.' });
export type NoteDraft = z.infer<typeof NOTE_DRAFT_SCHEMA>;

/** What a call that changes the notes answers: the notes as they are now, or why nothing changed. */
export type LiveNoteResult = { ok: true; notes: LiveNotes } | { ok: false; message: string };

/**
 * What guests are sent as `notes:changed` when the notes or Allow guest notes change: only that they did, so each asks
 * for the list (`notes.list`) when it wants it, rather than every guest being sent all of it on every change.
 */
export const NOTES_CHANGED = { kind: 'notes' } as const;

/** Whether `value` is a project's notes as they travel. */
export function isLiveNotes(value: unknown): value is LiveNotes {
  return NOTES_SCHEMA.safeParse(value).success;
}
