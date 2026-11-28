import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Bold, Italic, Link, List, ListOrdered, Minus, Plus, Unlink } from 'lucide-react';
import type { RichListType, RichPages } from '@shared/richtext';
import type { LinkRel } from '@shared/types';
import { linkFromTarget, parseRichText, sameRichText } from '@shared/richtext';
import { addItem, applyTextEdit, linkAt, listState, moveItem, removeItem, removeLink, setLink, toggleList, typedLink, type LinkAt, type TextAt, type TextEdit } from '../lib/richtext-commands';
import { linkTokens, type LinkToken, type RichSpan } from '@shared/richtext';
import { isImeComposing } from '../lib/ime';
import { appliesLanded, isSettling, reportRefused } from '../lib/pending';
import { DraftInput, type DraftHandle } from './ui';
import { LinkRelControls } from './LinkRelControls';
import { api, getState, markDraft, type PendingEdit } from '../store';
import { shortcutLabel } from '../lib/shortcut-keys';
import { collectionIndexRoutes } from '@shared/archives';
import './RichTextField.css';

type Command = 'bold' | 'italic' | 'link' | 'ul' | 'ol' | 'add' | 'remove' | 'up' | 'down';
interface Tool {
  cmd: Command;
  label: string;
  icon: React.ReactNode;
  keys?: string;
}
/** The toolbar's groups, in the post writer's order: marks, links, lists, then the list item commands. */
const GROUPS: Tool[][] = [
  [
    { cmd: 'bold', label: 'Bold', icon: <Bold />, keys: '⌘B' },
    { cmd: 'italic', label: 'Italic', icon: <Italic />, keys: '⌘I' }
  ],
  [{ cmd: 'link', label: 'Link', icon: <Link />, keys: '⌘K' }],
  [
    { cmd: 'ul', label: 'Bulleted list', icon: <List /> },
    { cmd: 'ol', label: 'Numbered list', icon: <ListOrdered /> }
  ],
  [
    { cmd: 'add', label: 'Add item', icon: <Plus /> },
    { cmd: 'remove', label: 'Remove item', icon: <Minus /> },
    { cmd: 'up', label: 'Move item up', icon: <ArrowUp /> },
    { cmd: 'down', label: 'Move item down', icon: <ArrowDown /> }
  ]
];
const KEYS: Partial<Record<string, Command>> = { b: 'bold', i: 'italic', k: 'link' };

type Mark = 'bold' | 'italic';
/** How many stars each mark takes: a run of three is both. */
const STARS: Record<Mark, number> = { bold: 2, italic: 1 };
const has = (run: number, mark: Mark) => (mark === 'bold' ? run >= 2 : run !== 2);
/** A marked span on a line: its run of stars at `open` and again at `close`. */
interface Span {
  open: number;
  close: number;
  run: number;
}
// A run of one to three stars, hugging its words, closed by the same run, as the parser reads *italic*, **bold** and
// ***both***.
const SPAN_RE = /(?<!\*)(\*{1,3})(?!\*)(?=\S)(.+?)(?<=\S)(?<!\*)\1(?!\*)/g;

/** The marked spans in `text` from `base` on, those inside them included (*italic* inside **bold**). */
function spans(text: string, base: number): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(SPAN_RE)) {
    const run = m[1].length;
    const open = base + m.index!;
    out.push({ open, close: open + m[0].length - run, run }, ...spans(m[2], open + run));
  }
  return out;
}

/**
 * The marked spans on the line `from`..`to`, with every link's address left out: stars in a web address are part of
 * where it goes, never a mark, however they would pair up.
 */
function lineSpans(text: string, from: number, to: number, pages: RichPages): Span[] {
  const origin = blockStart(text, from);
  const block = text.slice(origin, to);
  const tokens = linkTokens(block.replace(/\\(?=\n)/g, '\u0000'), (t, n, r) => linkFromTarget(t, pages, n, r));
  let masked = block;
  for (const t of tokens) masked = masked.slice(0, t.labelEnd) + '\u0000'.repeat(t.end - t.labelEnd) + masked.slice(t.end);
  return spans(masked.slice(from - origin), from);
}

const lineOf = (text: string, at: number) => {
  const from = text.lastIndexOf('\n', at - 1) + 1;
  const nl = text.indexOf('\n', at);
  return { from, to: nl < 0 ? text.length : nl };
};

/** The bold or italic span the selection sits in (or is exactly), on its line, innermost first. */
function markAt({ text, start, end }: TextAt, mark: Mark, pages: RichPages): Span | null {
  const { from, to } = lineOf(text, start);
  if (end > to) return null;
  const inside = lineSpans(text, from, to, pages).filter((sp) => has(sp.run, mark) && ((start >= sp.open + sp.run && end <= sp.close) || (start === sp.open && end === sp.close + sp.run)));
  return inside.at(-1) ?? null;
}

/**
 * Where a link's tokens count from: the start of the paragraph or item the caret is in, which runs on past a line
 * that ends with a backslash (a line break inside it), as linkAt reads it.
 */
function blockStart(text: string, at: number): number {
  let from = lineOf(text, at).from;
  while (from > 1 && text[from - 2] === '\\') from = lineOf(text, from - 1).from;
  return from;
}

/** Whether the selection is in a link's address rather than its words, where a mark would change where it goes. */
function inLinkAddress(at: TextAt, pages: RichPages): boolean {
  const f = linkAt(at, pages);
  if (f?.kind !== 'link') return false;
  const origin = blockStart(at.text, at.start);
  return !f.tokens.some((t) => at.start >= origin + t.labelStart && at.end <= origin + t.labelEnd);
}

const lead = (t: string) => t.length - t.trimStart().length;
const trail = (t: string) => t.length - t.trimEnd().length;
const stars = (n: number) => '*'.repeat(n);

/**
 * A span split at the selection: the words either side keep the span's own run of stars, the selected words take
 * `midRun`, and the spaces between stay outside every run, where the parser needs them.
 */
function splitSpan(at: TextAt, sp: Span, midRun: number): TextEdit | null {
  const lo = sp.open + sp.run;
  const hi = sp.close;
  const s = at.start === at.end ? lo : Math.max(at.start, lo);
  const e = at.start === at.end ? hi : Math.min(at.end, hi);
  const left = at.text.slice(lo, s);
  const mid = at.text.slice(s, e);
  const right = at.text.slice(e, hi);
  const words = mid.trim();
  if (!words) return null;
  const all = stars(sp.run);
  const L = left.trim() ? all + left.trimEnd() + all + left.slice(left.length - trail(left)) : left;
  const M = mid.slice(0, lead(mid)) + stars(midRun) + words + stars(midRun) + mid.slice(mid.length - trail(mid));
  const R = right.trim() ? right.slice(0, lead(right)) + all + right.trimStart() + all : right;
  const start = sp.open + L.length + lead(mid) + midRun;
  return { from: sp.open, to: sp.close + sp.run, insert: L + M + R, start, end: start + words.length };
}

/**
 * Bold or italic on the selected words, or off them (the rest of a span keeps it), as one replacement, the way typing
 * would make it. Words inside the other mark's span split it, so each piece reads as one run of stars. Null where it
 * can't be done cleanly: no words, more than one line, part of a run of stars, a link's address, or any result the
 * parser would not read back as the same words with the mark toggled.
 */
function toggleMark(at: TextAt, mark: Mark, pages: RichPages): TextEdit | null {
  const n = STARS[mark];
  if (inLinkAddress(at, pages)) return null;
  const on = markAt(at, mark, pages);
  let edit: TextEdit | null;
  if (on) edit = splitSpan(at, on, on.run - n);
  else {
    const picked = at.text.slice(at.start, at.end);
    if (!picked.trim() || picked.includes('\n')) return null;
    const { from, to } = lineOf(at.text, at.start);
    // The innermost span of the other mark the words sit in: it is split around them, never nested into a run of four.
    const around = lineSpans(at.text, from, to, pages).filter((sp) => at.start >= sp.open + sp.run && at.end <= sp.close).at(-1);
    if (around && around.run + n <= 3) edit = splitSpan(at, around, around.run + n);
    else {
      // Markers go round the words, never round the spaces either side of them, or the parser would not read them.
      const start = at.start + lead(picked);
      const end = at.end - trail(picked);
      const words = at.text.slice(start, end);
      // Stars inside the words are another span's: only a whole one can be wrapped, never part of its run.
      const whole = lineSpans(at.text, from, to, pages).some((sp) => sp.open === start && sp.close + sp.run === end);
      if (words.includes('*') && !whole) return null;
      edit = { from: start, to: end, insert: stars(n) + words + stars(n), start: start + n, end: end + n };
    }
  }
  if (!edit) return null;
  // Checked as the site will read it: the same words, no stray stars, and the mark now on (or off) where they are.
  const after = applyTextEdit(at.text, edit);
  const read = (t: string) => plainWords(t, pages, at.plainAs);
  if (read(after) !== read(at.text)) return null;
  if (!!markAt({ ...at, text: after, start: edit.start, end: edit.end }, mark, pages) === !!on) return null;
  return edit;
}

/** The words of a text as the parser reads them, and where each link goes, with their marks left out. */
function plainWords(text: string, pages: RichPages, plainAs?: RichListType): string {
  const blocks = parseRichText(text, { markdown: true, link: (to, nt, r) => linkFromTarget(to, pages, nt, r), plainAs });
  // One link reads as one, however many marked pieces its words are in: its destination is said once, after them.
  const line = (spans: RichSpan[]) => {
    let out = '';
    let open = '';
    for (const x of spans) {
      const to = x.link ? JSON.stringify(x.link) : '';
      if (to !== open && open) out += `\u0000${open}\u0000`;
      open = to;
      out += x.text;
    }
    return open ? `${out}\u0000${open}\u0000` : out;
  };
  return blocks.map((b) => ('items' in b ? b.items.map(line).join('\n') : 'spans' in b ? line(b.spans) : '')).join('\n');
}

/** A link's words as the row names them: each of its tokens' words with the spaces between, without their marks. */
function linkWords(text: string, start: number, tokens: LinkToken[]): string {
  const line = blockStart(text, start);
  const bare = (t: string) => t.replace(/\\(.)/g, '$1').replace(/\*+/g, '');
  return tokens.map((t, i) => (i ? text.slice(line + tokens[i - 1].end, line + t.start) : '') + bare(text.slice(line + t.labelStart, line + t.labelEnd))).join('');
}

/** The selected words, as the link row names them: short enough for one line of the Inspector. */
const quoted = (t: string) => {
  const words = t.replace(/\s+/g, ' ').trim();
  return words.length > 28 ? `${words.slice(0, 27).trimEnd()}…` : words;
};

/** Which link (or which words) a link row is for: a row for the same one is reopened, never started again. */
const linkKey = (f: NonNullable<LinkAt>, at: TextAt) => (f.kind === 'link' ? `link:${blockStart(at.text, at.start) + f.tokens[0].start}` : `words:${f.from}-${f.to}`);

interface LinkDraft {
  /** The field's text and selection when the link field opened: Apply works on exactly those words. */
  at: TextAt;
  existing: boolean;
  /** Which link or words the row is for (see linkKey). */
  key: string;
  /** The words the link is on, as the row names them. */
  words: string;
  /** The destination when the field opened, and as typed since. */
  from: string;
  target: string;
  /** What the link says about a web address when the field opened, and as ticked since. */
  fromRel: LinkRel[];
  rel: LinkRel[];
  /** What is wrong with the destination: the field is marked invalid. */
  error?: string;
  /** Something to know that is not wrong with the destination (not applied yet, the words moved): said plainly. */
  notice?: string;
}

/**
 * A rich text field: its text form in a textarea, with buttons for bold, italic, links and lists, so none needs typed
 * syntax. Each button is one change: one step of the field's own Undo, and one project Undo step once applied.
 */
export function RichTextField({ value, onCommit, pages, plainAs, id, describedBy, invalid, ariaLabel, placeholder, rows = 4 }: { value: string; onCommit: (v: string, edit?: PendingEdit) => unknown; pages: RichPages; plainAs?: RichListType; id?: string; describedBy?: string; invalid?: boolean; ariaLabel?: string; placeholder?: string; rows?: number }) {
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const handle = useRef<DraftHandle | null>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const uid = useId();
  const [at, setAt] = useState<TextAt>({ text: value, start: 0, end: 0, plainAs });
  const atNow = useRef(at);
  atNow.current = at;
  const [link, setLinkDraft] = useState<LinkDraft | null>(null);
  const [stop, setStop] = useState<Command>('bold');
  /** Why the last command did not run. */
  const [note, setNote] = useState('');
  const valueNow = useRef(value);
  valueNow.current = value;
  // A destination typed but not applied is an edit still to be made: Save and Close say so, rather than drop it.
  const draftKey = useId();
  const linkDirty = !!link && (link.target.trim() !== link.from || link.rel.join() !== link.fromRel.join());
  useEffect(() => void markDraft(draftKey, linkDirty), [draftKey, linkDirty]);
  useEffect(() => () => markDraft(draftKey, false), [draftKey]);

  const current = (): TextAt | null => {
    const el = field.current;
    return el ? { text: el.value, start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0, plainAs } : null;
  };
  // The buttons follow the selection in the field, which stays put while a button has focus.
  const read = () => {
    const now = current();
    if (!now) return;
    // A note stays until the text or the selection it was about changes, not on the release of a shortcut's keys.
    const was = atNow.current;
    if (now.text !== was.text || now.start !== was.start || now.end !== was.end) setNote('');
    setAt(now);
  };
  const readRef = useRef(read);
  readRef.current = read;
  // Typing is followed from the field's own change, never from its input event: the browser runs a listener there
  // before React has read the keystroke, and a state change made then draws the field again with the text from before
  // it, so the keystroke is lost (#1369).
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    const read = () => readRef.current();
    const events = ['select', 'keyup', 'mouseup', 'focus'];
    for (const t of events) el.addEventListener(t, read);
    const now = current();
    if (now) setAt(now);
    return () => events.forEach((t) => el.removeEventListener(t, read));
  }, [plainAs]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const now = current();
      if (now) setAt(now);
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);

  /** Which commands have nothing to work on where the selection is. */
  const offAt = (a: TextAt): Record<Command, boolean> => {
    const l = listState(a);
    return { bold: !toggleMark(a, 'bold', pages), italic: !toggleMark(a, 'italic', pages), link: !linkAt(a, pages) && !link, ul: false, ol: false, add: !l.item, remove: !l.item, up: !l.up, down: !l.down };
  };
  const list = listState(at);
  const found = linkAt(at, pages);
  const disabled = offAt(at);
  /** Why a command is off where the selection is: its tooltip, and what a press of it says. */
  const why = (cmd: Command, a: TextAt): string => {
    const l = listState(a);
    if ((cmd === 'bold' || cmd === 'italic') && inLinkAddress(a, pages)) return 'A link’s address can’t be formatted: select its words instead.';
    if ((cmd === 'bold' || cmd === 'italic') && markAt(a, cmd, pages)) return `${cmd === 'bold' ? 'Bold' : 'Italic'} can’t be taken off just these words. Put the caret in them to take it off the whole phrase.`;
    if (cmd === 'bold' || cmd === 'italic') return a.start === a.end ? 'Select some words first.' : 'Select words on one line, outside the stars of other formatting.';
    if (cmd === 'link') return a.text.slice(a.start, a.end).includes('\n') ? 'Select words within one paragraph or list item.' : 'Select some words, or put the caret in a link, first.';
    if (!l.item) return 'Put the caret in a list item first.';
    return cmd === 'up' ? 'This item is already first.' : 'This item is already last.';
  };
  const pressed: Partial<Record<Command, boolean>> = { bold: !!markAt(at, 'bold', pages), italic: !!markAt(at, 'italic', pages), link: found?.kind === 'link' || !!link, ul: list.kind === 'ul', ol: list.kind === 'ol' };

  /** Apply one edit as typing would (so the field's Undo takes it back), then save it as its own step. */
  const apply = (edit: TextEdit | null, focusAfter: HTMLElement | null) => {
    const el = field.current;
    if (!el || !edit) return;
    el.focus();
    el.setSelectionRange(edit.from, edit.to);
    const typed = edit.insert ? document.execCommand('insertText', false, edit.insert) : edit.from === edit.to || document.execCommand('delete');
    if (!typed) {
      el.setRangeText(edit.insert, edit.from, edit.to, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.setSelectionRange(edit.start, edit.end);
    handle.current?.commitNow(el.value);
    focusAfter?.focus();
    const now = current();
    if (now) setAt(now);
  };

  /** Whether two texts are the same rich text, however they are laid out. */
  const same = (a: string, b: string) => {
    const read = (t: string) => parseRichText(t, { markdown: true, link: (to, n, r) => linkFromTarget(to, pages, n, r), plainAs });
    return a === b || sameRichText(read(a), read(b));
  };
  /**
   * What was typed in the field first, saved as its own step, then the field as it is once that has landed: null
   * when the field still holds text the project did not take (held while the AI worked, refused, or changed
   * somewhere else meanwhile), which a command must not build on.
   */
  const settled = async (): Promise<TextAt | null> => {
    await appliesLanded();
    for (const end = Date.now() + 1500; ; ) {
      const now = current();
      if (!now) return null;
      if (same(now.text, valueNow.current)) return now;
      if (Date.now() > end) return null;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const NOT_SAVED = 'Save or undo what you typed in this field first, then try again.';

  /**
   * Run a command on the selection. `owner` is what the author ran it from: a toolbar button, or the text itself (a
   * shortcut); `back` is where focus goes after it, or null for the text.
   */
  const run = async (cmd: Command, owner: HTMLElement, back: HTMLElement | null) => {
    setNote('');
    const before = current();
    if (!before) return;
    if (cmd === 'link' && link) {
      const f = linkAt(before, pages);
      // The row is already open for this link or these words, or the caret is on nothing else to link: go back to it
      // rather than start again and lose what was typed.
      if (!f || linkKey(f, before) === link.key) return linkInput.current?.focus();
      // Another link while one is half typed: that one is finished or put away first, never dropped.
      if (linkDirty) {
        setLinkDraft({ ...link, error: undefined, notice: 'Apply or cancel this link before starting another.' });
        return linkInput.current?.focus();
      }
    } else if (offAt(before)[cmd]) return setNote(why(cmd, before));
    else if (link) {
      // A half-typed link is never left to go stale under another change to the text; an untouched one just closes.
      if (linkDirty) {
        setLinkDraft({ ...link, error: undefined, notice: 'Apply or cancel this link first.' });
        return linkInput.current?.focus();
      }
      setLinkDraft(null);
    }
    // Leaving the field saves what was typed in it, as its own Undo step, before the command makes another. The
    // button holds focus while that lands, so moving on meanwhile is seen; a shortcut saves the text where it is.
    if (owner === field.current) handle.current?.commitNow(before.text);
    else if (document.activeElement !== owner) owner.focus();
    const now = await settled();
    // The author moved on while the typing was being saved: the command is no longer what they are doing.
    if (document.activeElement !== owner) return;
    if (!now) return setNote(NOT_SAVED);
    // Put back to the saved text, or the selection moved, meanwhile: it is no longer on the words it was on.
    if (now.text !== before.text || now.start !== before.start || now.end !== before.end) return setNote('The selection changed. Select the words again.');
    if (cmd === 'link') {
      const f = linkAt(before, pages);
      if (!f) return;
      const target = f.kind === 'link' ? f.tokens[0].target : '';
      const rel = f.kind === 'link' ? f.tokens[0].rel : [];
      const said = f.kind === 'link' ? linkWords(before.text, before.start, f.tokens) : before.text.slice(f.from, f.to);
      setLinkDraft({ at: before, existing: f.kind === 'link', key: linkKey(f, before), words: quoted(said), from: target, target, fromRel: rel, rel });
      return;
    }
    const edit =
      cmd === 'bold' || cmd === 'italic' ? toggleMark(before, cmd, pages) : cmd === 'ul' || cmd === 'ol' ? toggleList(before, cmd) : cmd === 'add' ? addItem(before) : cmd === 'remove' ? removeItem(before) : moveItem(before, cmd === 'up' ? -1 : 1);
    apply(edit, back);
  };
  const press = (cmd: Command, e: React.MouseEvent<HTMLButtonElement>) => {
    setStop(cmd);
    // From the keyboard, focus stays on the button, so its Undo is the project's; a press goes back to typing.
    void run(cmd, e.currentTarget, e.detail === 0 ? e.currentTarget : null);
  };
  // The post writer's shortcuts, in the text: ⌘B and ⌘I for the marks, ⌘K for a link.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    const onKey = (ev: Event) => {
      const e = ev as globalThis.KeyboardEvent;
      if (e.isComposing || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const cmd = KEYS[e.key.toLowerCase()];
      if (!cmd) return;
      // Ours while typing here, not the command menu's or the app's.
      e.preventDefault();
      e.stopPropagation();
      void runRef.current(cmd, el, null);
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (link && !link.error) linkInput.current?.select();
  }, [link?.key]);

  const closeLink = (select: boolean) => {
    const was = link;
    setLinkDraft(null);
    const el = field.current;
    if (!el || !was) return;
    el.focus();
    if (select) el.setSelectionRange(was.at.start, was.at.end);
  };
  /** The field changed under the link field (the AI, or another window): the words it was for may have moved. */
  // The row keeps the words it opened on: the caret moving in the text since does not change which words it links.
  const stale = (l: LinkDraft) => {
    const el = field.current;
    if (el?.value === l.at.text && same(l.at.text, valueNow.current)) return false;
    setLinkDraft({ ...l, error: undefined, notice: 'The text changed. Cancel, select the words again and press Link.' });
    return true;
  };
  const unlink = () => {
    if (!link || stale(link)) return;
    const edit = removeLink(link.at, pages);
    if (!edit) return setLinkDraft({ ...link, error: undefined, notice: 'That link can’t be removed here. Edit its text instead.' });
    setLinkDraft(null);
    apply(edit, null);
  };
  const applyLink = () => {
    if (!link || stale(link)) return;
    // An emptied destination is not a way to remove a link: that is Remove link's job, so Enter never takes one off.
    if (!link.target.trim()) return setLinkDraft({ ...link, error: link.existing ? 'Type where the link goes, or press Remove link to take it off.' : 'Type where the link goes.' });
    // Or a collection's index by its address, as the project has it now: it is stored, and written, by the collection.
    const live = getState().snapshot?.state;
    const to = typedLink(link.target, pages) ?? (live ? linkFromTarget(link.target, pages, false, undefined, collectionIndexRoutes(live)) : null);
    if (!to) {
      const t = link.target.trim();
      // A page address no page has: say so, and where the pages are, rather than ask for what was just typed.
      if (t.startsWith('/')) return setLinkDraft({ ...link, notice: undefined, error: `No page has the address ${quoted(t)}.${listed ? ' Choose one from the list.' : ''}` });
      return setLinkDraft({ ...link, notice: undefined, error: 'Try /about/, a web address, an email address or a phone number.' });
    }
    const edit = setLink(link.at, pages, to, link.rel);
    // Refused for the words, not the destination (it cuts through formatting): the address stays as typed, unmarked.
    // Refused for the words chosen (a recovery from the start: Cancel, choose again, Link), or for the link itself (as said).
    if (typeof edit === 'string') return setLinkDraft({ ...link, error: undefined, notice: edit.startsWith('Select') ? 'Cancel, select words on one line that don’t cut through bold or italic, then press Link.' : edit });
    setLinkDraft(null);
    apply(edit, null);
  };

  // One Tab stop: the arrow keys, Home and End move between the buttons.
  const roam = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const from = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === 'ArrowRight' ? from + 1 : e.key === 'ArrowLeft' ? from - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : null;
    if (to === null || from < 0) return;
    e.preventDefault();
    const next = buttons[(to + buttons.length) % buttons.length];
    setStop(next.dataset.cmd as Command);
    next.focus();
  };

  const live = getState().snapshot?.state;
  const pageChoices = live ? live.site.pageOrder.filter((p) => Object.hasOwn(live.pages, p)).map((p) => live.pages[p]) : [];
  const typed = link ? typedLink(link.target, pages) : null;
  // Pages to choose from while the destination could be one.
  const listed = pageChoices.length > 0 && (!typed || typed.type === 'page');

  return (
    <div className="rich-field">
      <div className="rich-tools" role="toolbar" aria-label="Text formatting" aria-controls={id} onKeyDown={roam}>
        {GROUPS.map((g, i) => (
          <span key={i} className="rich-tools-group">
            {g.map((t) => {
              const label = t.cmd === 'link' && found?.kind === 'link' ? 'Edit link' : t.label;
              return (
                <button
                  key={t.cmd}
                  type="button"
                  className="icon-btn sm"
                  data-cmd={t.cmd}
                  title={(t.keys ? `${label} (${shortcutLabel(t.keys, api.platform)})` : label) + (disabled[t.cmd] ? ` — ${why(t.cmd, at)}` : '')}
                  aria-label={label}
                  aria-keyshortcuts={t.keys ? (api.platform === 'darwin' ? 'Meta+' : 'Control+') + t.keys.slice(-1) : undefined}
                  tabIndex={t.cmd === stop ? 0 : -1}
                  aria-disabled={disabled[t.cmd] || undefined}
                  aria-pressed={t.cmd in pressed ? !!pressed[t.cmd] : undefined}
                  aria-expanded={t.cmd === 'link' ? !!link : undefined}
                  onClick={(e) => press(t.cmd, e)}
                >
                  {t.icon}
                </button>
              );
            })}
          </span>
        ))}
      </div>
      {/* The live region stays mounted so a note is announced. A note says why a command did not run: guidance, not an error. */}
      <div className="field-hint rich-note" role="status">
        {note}
      </div>
      {link && (
        <div
          className="rich-link"
          role="group"
          aria-label={link.existing ? 'Edit link' : 'Add link'}
          onKeyDown={(e) => {
            if (isImeComposing(e)) return;
            // Enter applies from a tick as it does from the destination; Space still ticks.
            if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type === 'checkbox') {
              e.preventDefault();
              applyLink();
              return;
            }
            if (e.key !== 'Escape') return;
            // Closes this field only, from any of its controls: the Inspector's own Escape waits for the next one.
            e.preventDefault();
            e.stopPropagation();
            closeLink(true);
          }}
        >
          <label className="field-label rich-link-label" htmlFor={`${uid}-link`}>
            <span>Link destination</span>
            {link.words && <span className="rich-link-words">for “{link.words}”</span>}
          </label>
          <input
            ref={linkInput}
            id={`${uid}-link`}
            className="input sm"
            // Pages to choose from while it could be one; a web, email or phone address takes the whole width.
            list={listed ? `${uid}-pages` : undefined}
            placeholder="/about/ or https://…"
            spellCheck={false}
            autoFocus
            value={link.target}
            aria-invalid={!!link.error || undefined}
            aria-describedby={link.error ? `${uid}-link-message` : `${uid}-link-hint`}
            onChange={(e) => setLinkDraft({ ...link, target: e.target.value, error: undefined, notice: undefined })}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                applyLink();
              }
            }}
            onBlur={(e) => {
              if (!isSettling() || !linkDirty) return;
              // Saving or leaving: the link is not part of the text until it is applied, and the field says so.
              reportRefused('The link you were typing has not been applied.', draftKey, e.currentTarget);
              setLinkDraft({ ...link, error: undefined, notice: 'This link is not applied yet: press Apply to add it, or Cancel.' });
            }}
          />
          {pageChoices.length > 0 && (
            <datalist id={`${uid}-pages`}>
              {pageChoices.map((p) => (
                <option key={p.id} value={p.route}>
                  {p.title}
                </option>
              ))}
            </datalist>
          )}
          {/* One place under the destination: what is wrong with it; else what to know (announced); else what it takes. */}
          {link.error ? (
            <div className="field-error rich-link-feedback" id={`${uid}-link-message`} role="alert">
              {link.error}
            </div>
          ) : (
            <div className={`field-hint rich-link-feedback${link.notice ? ' rich-link-notice' : ''}`} id={`${uid}-link-hint`} role="status">
              {link.notice ?? (listed ? 'A page from the list, a web address, an email address or a phone number.' : 'A page address, web address, email address or phone number.')}
            </div>
          )}
          {/* Only a web address says anything about the site it goes to. */}
          {typed?.type === 'url' && <LinkRelControls value={link.rel} onChange={(rel) => setLinkDraft({ ...link, rel, error: undefined, notice: undefined })} />}
          <div className="rich-link-actions">
            {link.existing && (
              <button type="button" className="btn btn-sm btn-ghost btn-danger rich-link-remove" onClick={unlink}>
                <Unlink aria-hidden="true" />
                Remove link
              </button>
            )}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => closeLink(true)}>
              Cancel
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={applyLink}>
              Apply
            </button>
          </div>
        </div>
      )}
      <DraftInput id={id} aria-describedby={describedBy} aria-invalid={invalid} multiline rows={rows} value={value} onCommit={onCommit} onLive={read} handle={handle} inputRef={field} ariaLabel={ariaLabel} placeholder={placeholder} />
    </div>
  );
}
