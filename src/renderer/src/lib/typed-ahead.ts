/**
 * Typing that runs ahead of an entry opening (#1394). From Create draft until the new entry's text has focus, the writer
 * still shows the entry open before it, which takes nothing typed then, and the form's title is read-only and soon gone.
 * Typing goes instead into a field of its own, in the writer's note of what it is waiting for (PostWriter), focused at
 * once: a composition (IME), a dead key, a correction or a paste works there as in any field. As the entry opens, the
 * field's words go into its text, once a composition in progress there has ended.
 */

let field: HTMLTextAreaElement | null = null;
let composing = false;
let waiting: Array<() => void> = [];

const settle = () => {
  const done = waiting;
  waiting = [];
  for (const go of done) go();
};

/** The field typed ahead into registers itself while it shows; returns the unregister. */
export function setTypedAheadField(el: HTMLTextAreaElement): () => void {
  field = el;
  composing = false;
  const start = () => void (composing = true);
  // A composition ends with its commit, or with the field's focus.
  const end = () => {
    composing = false;
    settle();
  };
  el.addEventListener('compositionstart', start);
  el.addEventListener('compositionend', end);
  el.addEventListener('blur', end);
  return () => {
    el.removeEventListener('compositionstart', start);
    el.removeEventListener('compositionend', end);
    el.removeEventListener('blur', end);
    if (field !== el) return;
    field = null;
    composing = false;
    settle();
  };
}

/** Resolves once no composition is in progress in the field typed ahead into: one in progress ends first. */
export function typedAheadSettled(): Promise<void> {
  return field && composing ? new Promise((go) => waiting.push(go)) : Promise.resolve();
}

/** What was typed ahead, and whether the author has since gone on to type somewhere else (Find, a dialog). */
export function typedAhead(): { text: string; elsewhere: boolean } {
  const doc = field?.ownerDocument ?? document;
  const at = doc.activeElement;
  return { text: field?.value ?? '', elsewhere: !!at && at !== field && at !== doc.body && at !== doc.documentElement };
}
