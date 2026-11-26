import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Link, List, ListOrdered, Minus, Plus } from 'lucide-react';
import type { RichListType, RichPages } from '@shared/richtext';
import type { LinkRel } from '@shared/types';
import { linkFromTarget, parseRichText, sameRichText } from '@shared/richtext';
import { addItem, linkAt, listState, moveItem, removeItem, removeLink, setLink, toggleList, typedLink, type TextAt, type TextEdit } from '../lib/richtext-commands';
import { isImeComposing } from '../lib/ime';
import { appliesLanded, isSettling, reportRefused } from '../lib/pending';
import { DraftInput, type DraftHandle } from './ui';
import { LinkRelControls } from './LinkRelControls';
import { markDraft, type PendingEdit } from '../store';
import './RichTextField.css';

type Command = 'link' | 'ul' | 'ol' | 'add' | 'remove' | 'up' | 'down';
const COMMANDS: Array<{ cmd: Command; label: string; icon: React.ReactNode; gap?: boolean }> = [
  { cmd: 'link', label: 'Link', icon: <Link /> },
  { cmd: 'ul', label: 'Bulleted list', icon: <List />, gap: true },
  { cmd: 'ol', label: 'Numbered list', icon: <ListOrdered /> },
  { cmd: 'add', label: 'Add item', icon: <Plus />, gap: true },
  { cmd: 'remove', label: 'Remove item', icon: <Minus /> },
  { cmd: 'up', label: 'Move item up', icon: <ArrowUp /> },
  { cmd: 'down', label: 'Move item down', icon: <ArrowDown /> }
];

interface LinkDraft {
  /** The field's text and selection when the link field opened: Apply works on exactly those words. */
  at: TextAt;
  existing: boolean;
  /** The destination when the field opened, and as typed since. */
  from: string;
  target: string;
  /** What the link says about a web address when the field opened, and as ticked since. */
  fromRel: LinkRel[];
  rel: LinkRel[];
  error?: string;
}

/**
 * A rich text field: its text form in a textarea, with buttons for links and lists, so neither needs typed
 * syntax. Each button is one change: one step of the field's own Undo, and one project Undo step once applied.
 */
export function RichTextField({ value, onCommit, pages, plainAs, id, describedBy, invalid, ariaLabel, placeholder, rows = 4 }: { value: string; onCommit: (v: string, edit?: PendingEdit) => unknown; pages: RichPages; plainAs?: RichListType; id?: string; describedBy?: string; invalid?: boolean; ariaLabel?: string; placeholder?: string; rows?: number }) {
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const handle = useRef<DraftHandle | null>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const uid = useId();
  const [at, setAt] = useState<TextAt>({ text: value, start: 0, end: 0, plainAs });
  const [link, setLinkDraft] = useState<LinkDraft | null>(null);
  const [stop, setStop] = useState<Command>('link');
  /** Why the last command did not run. */
  const [note, setNote] = useState('');
  const valueNow = useRef(value);
  valueNow.current = value;
  // A destination typed but not applied is an edit still to be made: Save and Close say so, rather than drop it.
  const linkKey = useId();
  const linkDirty = !!link && (link.target.trim() !== link.from || link.rel.join() !== link.fromRel.join());
  useEffect(() => void markDraft(linkKey, linkDirty), [linkKey, linkDirty]);
  useEffect(() => () => markDraft(linkKey, false), [linkKey]);

  const current = (): TextAt | null => {
    const el = field.current;
    return el ? { text: el.value, start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0, plainAs } : null;
  };
  // The buttons follow the selection in the field, which stays put while a button has focus.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    const read = (e: Event) => {
      const now = current();
      if (now) setAt(now);
      if (e.type !== 'focus') setNote('');
    };
    const events = ['select', 'input', 'keyup', 'mouseup', 'focus'];
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

  const list = listState(at);
  const found = linkAt(at, pages);
  const disabled: Record<Command, boolean> = { link: !found, ul: false, ol: false, add: !list.item, remove: !list.item, up: !list.up, down: !list.down };

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
  const NOT_SAVED = 'Save or undo what you typed in this field first.';

  const run = async (cmd: Command, e: React.MouseEvent<HTMLButtonElement>) => {
    const button = e.currentTarget;
    setStop(cmd);
    setNote('');
    const before = current();
    if (!before || disabled[cmd]) return;
    // From the keyboard, focus stays on the button, so its Undo is the project's; a press goes back to typing.
    const back = e.detail === 0 ? button : null;
    // Leaving the field saves what was typed in it, as its own Undo step, before the command makes another. The
    // button holds focus while that lands, so moving on meanwhile is seen.
    if (document.activeElement !== button) button.focus();
    const now = await settled();
    // The author moved on while the typing was being saved: the command is no longer what they are doing.
    if (document.activeElement !== button) return;
    if (!now) return setNote(NOT_SAVED);
    // Put back to the saved text, or the selection moved, meanwhile: it is no longer on the words it was on.
    if (now.text !== before.text || now.start !== before.start || now.end !== before.end) return setNote('Select the words again.');
    if (cmd === 'link') {
      const f = linkAt(before, pages);
      if (!f) return;
      const target = f.kind === 'link' ? f.tokens[0].target : '';
      const rel = f.kind === 'link' ? f.tokens[0].rel : [];
      setLinkDraft({ at: before, existing: f.kind === 'link', from: target, target, fromRel: rel, rel });
      return;
    }
    const edit = cmd === 'ul' || cmd === 'ol' ? toggleList(before, cmd) : cmd === 'add' ? addItem(before) : cmd === 'remove' ? removeItem(before) : moveItem(before, cmd === 'up' ? -1 : 1);
    apply(edit, back);
  };

  useEffect(() => {
    if (link && !link.error) linkInput.current?.select();
  }, [!!link]);

  const closeLink = (select: boolean) => {
    const was = link;
    setLinkDraft(null);
    const el = field.current;
    if (!el || !was) return;
    el.focus();
    if (select) el.setSelectionRange(was.at.start, was.at.end);
  };
  /** The field changed under the link field (the AI, or another window): the words it was for may have moved. */
  const stale = (l: LinkDraft) => {
    const el = field.current;
    const moved = !!el && (el.selectionStart !== l.at.start || el.selectionEnd !== l.at.end);
    if (el?.value === l.at.text && same(l.at.text, valueNow.current) && !moved) return false;
    setLinkDraft({ ...l, error: moved ? 'The selection changed. Press Link again for the words now selected.' : 'The text changed. Select the words again.' });
    return true;
  };
  const unlink = () => {
    if (!link || stale(link)) return;
    const edit = removeLink(link.at, pages);
    if (!edit) return setLinkDraft({ ...link, error: 'That link can’t be removed here. Edit its text instead.' });
    setLinkDraft(null);
    apply(edit, null);
  };
  const applyLink = () => {
    if (!link || stale(link)) return;
    if (!link.target.trim()) {
      if (!link.existing) return setLinkDraft({ ...link, error: 'Type where the link goes.' });
      return unlink();
    }
    const to = typedLink(link.target, pages);
    if (!to) return setLinkDraft({ ...link, error: 'Use a page address such as /about/, a web address, an email address or a phone number.' });
    const edit = setLink(link.at, pages, to, link.rel);
    if (typeof edit === 'string') return setLinkDraft({ ...link, error: edit });
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

  return (
    <div className="rich-field">
      <DraftInput id={id} aria-describedby={describedBy} aria-invalid={invalid} multiline rows={rows} value={value} onCommit={onCommit} handle={handle} inputRef={field} ariaLabel={ariaLabel} placeholder={placeholder} />
      <div className="rich-tools" role="toolbar" aria-label="Text formatting" aria-controls={id} onKeyDown={roam}>
        {COMMANDS.map((c) => {
          const label = c.cmd === 'link' && found?.kind === 'link' ? 'Edit link' : c.label;
          return (
            <span key={c.cmd} style={{ display: 'contents' }}>
              {c.gap && <i className="rich-tools-gap" aria-hidden="true" />}
              <button
                type="button"
                className="icon-btn sm"
                data-cmd={c.cmd}
                title={label}
                aria-label={label}
                tabIndex={c.cmd === stop ? 0 : -1}
                aria-disabled={disabled[c.cmd] || undefined}
                aria-pressed={c.cmd === 'ul' || c.cmd === 'ol' ? list.kind === c.cmd : undefined}
                aria-expanded={c.cmd === 'link' ? !!link : undefined}
                onClick={(e) => run(c.cmd, e)}
              >
                {c.icon}
              </button>
            </span>
          );
        })}
      </div>
      {link && (
        <div
          className="rich-link"
          role="group"
          aria-label={link.existing ? 'Edit link' : 'Add link'}
          onKeyDown={(e) => {
            if (isImeComposing(e) || e.key !== 'Escape') return;
            // Closes this field only, from any of its controls: the Inspector's own Escape waits for the next one.
            e.preventDefault();
            e.stopPropagation();
            closeLink(true);
          }}
        >
          <input
            ref={linkInput}
            className="input sm"
            aria-label="Link destination"
            placeholder="/about/, https://…, email or phone"
            spellCheck={false}
            autoFocus
            value={link.target}
            aria-invalid={!!link.error || undefined}
            aria-describedby={link.error ? `${uid}-link-error` : undefined}
            onChange={(e) => setLinkDraft({ ...link, target: e.target.value, error: undefined })}
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
              reportRefused('The link you were typing has not been applied.', linkKey, e.currentTarget);
              setLinkDraft({ ...link, error: 'This link is not applied yet: press Apply to add it, or Cancel.' });
            }}
          />
          <button type="button" className="btn btn-sm" onClick={applyLink}>
            Apply
          </button>
          {link.existing && (
            <button type="button" className="btn btn-sm" onClick={unlink}>
              Remove
            </button>
          )}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => closeLink(true)}>
            Cancel
          </button>
          {/* Only a web address says anything about the site it goes to. */}
          {typedLink(link.target, pages)?.type === 'url' && <LinkRelControls value={link.rel} onChange={(rel) => setLinkDraft({ ...link, rel, error: undefined })} />}
          {link.error ? (
            <div className="field-error" id={`${uid}-link-error`} role="alert">
              {link.error}
            </div>
          ) : (
            linkDirty && <div className="field-hint">Not applied yet: press Apply or Enter.</div>
          )}
        </div>
      )}
      {/* The live region stays mounted so a note is announced; it only looks like an error while it has one. */}
      <div className={note ? 'field-error' : undefined} role="status">
        {note}
      </div>
    </div>
  );
}
