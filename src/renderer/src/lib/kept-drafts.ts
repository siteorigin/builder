/**
 * Text refused for being longer than its field allows (issue #226), kept for the author to shorten. It belongs
 * to the field, not to the control showing it: a field that comes back (switching to another page and back,
 * selecting the image again) finds its text again, still marked as not saved. It goes when the text is saved
 * shortened, when the author puts the saved text back (Escape), or when the project closes.
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

/** Why a field's text was refused, as leaving the project or saving reports it. */
export function tooLongReport(name: string, length: number, limit: number): string {
  return `${name ? `What you typed in ${name}` : 'Something you typed'} is ${length} characters, longer than the ${limit} allowed, so it has not been saved.`;
}
