/**
 * Text refused for being longer than its field allows (issue #226), kept for the author to shorten, and text a field's
 * own check refused (a canonical URL that is no full address, #702), kept for the author to correct. It belongs to the
 * field, not to the control showing it: a field that comes back (switching to another page and back, selecting the
 * image again, the same page's settings shown in the SEO view or the Inspector) finds its text again, still marked as
 * not saved. It goes when the text is saved corrected, when the author puts the saved text back (Escape), or when the
 * project closes.
 *
 * Plain module state with no DOM or store import, so the rules are tested on their own; DraftInput wires it.
 */

export interface KeptDraft<Start = unknown> {
  /** What the author typed, whole. */
  text: string;
  /** Where typing began (the project and the saved text then), so the shortened text is checked against it. */
  start: Start;
  /** The field's name, for what is said about the text while the field is off screen. */
  name?: string;
  /** Whether what the text belongs to is still in the project: a removed page, image or list row takes it away. */
  alive?: () => boolean;
  /** The control that keeps it now; text handed over from elsewhere has none until a field takes it up. */
  owner?: object;
  /** Why it was kept: too long to save (the default), or refused by the field's own check (a canonical URL that is no
   *  full address), which a field showing it again checks afresh and explains beside itself. */
  refused?: 'check';
}

const kept = new Map<string, KeptDraft>();

/** The draft key a kept field holds open (see pending.ts), the same one whether or not the field is on screen. */
export const keptDraftKey = (field: string) => `kept:${field}`;

/** A field's place in one opening of a project: text kept for one project never comes back in another. */
export const keptField = (workspaceKey: string | undefined, home: string) => `${workspaceKey ?? ''}|${home}`;

export function keepDraft<Start>(field: string, draft: KeptDraft<Start>): void {
  kept.set(field, draft);
}

export function keptDraft<Start = unknown>(field: string): KeptDraft<Start> | undefined {
  return kept.get(field) as KeptDraft<Start> | undefined;
}

/** How a field shows text it finds kept for its place: too long to save, refused by its check, or none found. */
export function keptRefusal(draft: KeptDraft | undefined): 'long' | 'check' | null {
  return draft ? (draft.refused === 'check' ? 'check' : 'long') : null;
}

/**
 * What becomes of a field's refused text as its control goes. Text still unsaved (`open`: typed from somewhere, not put
 * back, in this opening) whose place is still there stays kept for the next control of that place: as too long when it
 * is over the limit or was refused as such, else as refused by the check. Settled text (saved, put back, its place gone)
 * is dropped. Either only by the control that keeps it (`mine`): a newer control of the same place has taken it up.
 */
export function keptOnLeave(f: { open: boolean; gone: boolean; over: boolean; tooLong: boolean; checked: boolean; mine: boolean }): 'long' | 'check' | 'drop' | null {
  if (!f.mine) return null;
  if (f.open && !f.gone && (f.over || f.tooLong)) return 'long';
  if (f.open && !f.gone && f.checked) return 'check';
  return f.tooLong || f.checked ? 'drop' : null;
}

/** Forget one field's kept text. Returns whether there was any. */
export function dropKeptDraft(field: string): boolean {
  return kept.delete(field);
}

/** Forget kept text whose page, image or row is no longer in the project. Returns what went, to close its drafts and
 *  offer the text to copy. */
export function pruneKeptDrafts(): Array<[string, KeptDraft]> {
  const gone: Array<[string, KeptDraft]> = [];
  for (const [field, draft] of kept)
    if (draft.alive && !draft.alive()) {
      kept.delete(field);
      gone.push([field, draft]);
    }
  return gone;
}

/** The text kept for fields of one opening of a project (see keptField), with each field's name. */
export function keptDraftsIn(workspaceKey: string): Array<{ field: string; name: string; text: string }> {
  return [...kept].filter(([field]) => field.startsWith(`${workspaceKey}|`)).map(([field, draft]) => ({ field, name: draft.name ?? '', text: draft.text }));
}

/** Forget every kept text (the project closed). Returns the fields that had one, so their drafts can be closed. */
export function clearKeptDrafts(): string[] {
  const fields = [...kept.keys()];
  kept.clear();
  return fields;
}

/**
 * What a field with a limit says under itself: its count against the limit, and once text over it has been
 * refused, that it was not saved and by how much to shorten it.
 */
export function limitNote(length: number, limit: number, refused: boolean): { text: string; over: boolean } {
  const over = length > limit;
  if (!over) return { text: `${length} / ${limit}`, over };
  const by = length - limit;
  const shorten = `Shorten it by ${by} ${by === 1 ? 'character' : 'characters'} to save it.`;
  return { text: refused ? `Not saved: ${length} / ${limit} characters. ${shorten}` : `${length} / ${limit}. ${shorten}`, over };
}

/** What is said about kept text that is not over the limit any more but not saved yet (shortened, still being typed). */
export function unsavedReport(name: string): string {
  return `${name ? `What you typed in ${name}` : 'Something you typed'} has not been saved.`;
}

/** What is said about kept text once what it belonged to has been removed. */
export function goneReport(name: string): string {
  return `${name ? `What you typed in ${name}` : 'Something you typed'} was not saved, and what it belonged to has been removed.`;
}

/**
 * What is said about text a live session ended before the host had it (#1462), `why` being how it ended ("The host
 * ended the live session."): "Not sent: the host ended the live session. Copy it to keep it." Text that was on its way
 * as it ended (`uncertain`) may have reached the host, and says so.
 */
export function notSentReport(why: string, uncertain = false): string {
  const reason = why.trim().replace(/^\p{Lu}/u, (c) => c.toLowerCase());
  const said = `${reason}${/[.!?]$/.test(reason) ? '' : '.'}`;
  return uncertain ? `Not confirmed: ${said} It was on its way, so the host may have it. Copy it to keep it.` : `Not sent: ${said} Copy it to keep it.`;
}

/** Why a field's text was refused, as leaving the project or saving reports it. */
export function tooLongReport(name: string, length: number, limit: number): string {
  return `${name ? `What you typed in ${name}` : 'Something you typed'} is ${length} characters, longer than the ${limit} allowed, so it has not been saved.`;
}
