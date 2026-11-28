/**
 * Typing that runs ahead of an entry opening (#1394). From Create draft until the new entry's text has focus, the
 * writer still shows the entry open before it, which takes nothing typed then, and the form's title is read-only and
 * soon gone. Keys typed where nothing takes them (that title, the page once the form has gone, a control switched off)
 * are held in order, to be typed into the new entry's text as it opens. A control that takes keys itself (the Find box,
 * a row of the list, a button) keeps them: the author went there.
 *
 * Held is what a key types: a character (AltGr's and Option's too), Enter as a new paragraph, Backspace taking back the
 * last character held, and the words of a paste. A composition (IME) or a dead key starts nowhere in this window,
 * there being no field for it, and is left as it is.
 */

/** Typing held for an entry that is opening; `stop` lets keys go where they would and says what was held. */
export interface TypedAhead {
  readonly text: string;
  stop(): string;
}

/** Whether keys typed at `t` go somewhere: a field that can be typed in, or a control left on that acts on keys. */
function takesKeys(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement) || t === t.ownerDocument.body || t === t.ownerDocument.documentElement) return false;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return !t.readOnly && !t.disabled;
  if (t.isContentEditable) return true;
  return !t.matches(':disabled');
}

export function holdTyping(win: Window = window): TypedAhead {
  let text = '';
  let on = true;
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing || takesKeys(e.target)) return;
    // AltGr arrives as Ctrl+Alt on Windows: what it makes is a character, as Option's is on a Mac.
    if (e.metaKey || (e.ctrlKey && !e.altKey)) return;
    if (e.key === 'Enter') text += '\n';
    else if (e.key === 'Backspace') {
      if (!text) return;
      text = [...text].slice(0, -1).join('');
    } else if ([...e.key].length === 1) text += e.key;
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onPaste = (e: ClipboardEvent) => {
    if (takesKeys(e.target)) return;
    const words = e.clipboardData?.getData('text/plain');
    if (!words) return;
    e.preventDefault();
    e.stopPropagation();
    text += words.replace(/\r\n?/g, '\n');
  };
  win.addEventListener('keydown', onKey, true);
  win.addEventListener('paste', onPaste, true);
  return {
    get text() {
      return text;
    },
    stop() {
      if (on) {
        on = false;
        win.removeEventListener('keydown', onKey, true);
        win.removeEventListener('paste', onPaste, true);
      }
      return text;
    }
  };
}
