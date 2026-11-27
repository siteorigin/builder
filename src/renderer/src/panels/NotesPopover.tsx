import './NotesPopover.css';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { StickyNote, Trash2, X } from 'lucide-react';
import { NOTE_TEXT_MAX, normalizeNoteText, type LiveNote } from '@shared/live/notes';
import { getState, setState, useStore } from '../store';
import { openMenus } from '../components/ui';
import { shownLive } from '../lib/live-host';
import { hasRoom } from '../lib/live-session';
import { isRemoteShell } from '../lib/remote-session';
import { refLabel } from '../lib/model';
import { addNote, deleteNote, jumpToNote, noteAge, notePlaceLabel, notePlaceNow, noteRights, openNotes, resolveNote } from '../lib/notes';

/**
 * Notes in the toolbar (#770): the shown project's pinned notes as a compact checklist, with how many are open. Each
 * note goes to its page and element; the host and collaborators resolve or delete them. Shown while the project has
 * notes, while it hosts a live session, and in the remote shell.
 */
export function NotesControl({ compact }: { compact?: boolean }) {
  const notes = useStore((s) => s.notes);
  const open = useStore((s) => s.notesOpen);
  const remote = useStore(isRemoteShell);
  const hosting = useStore((s) => hasRoom(shownLive(s)));
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const count = notes ? openNotes(notes.notes).length : 0;
  if (!notes || (!remote && !hosting && notes.notes.length === 0)) return null;
  const label = count === 0 ? 'Notes: none open' : `Notes: ${count} open`;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="btn btn-sm notes-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        title={label.replace(/^Notes: /, 'Notes, ')}
        onClick={() => setState({ notesOpen: !open })}
      >
        <StickyNote aria-hidden="true" />
        {!compact && <span className="notes-text">Notes</span>}
        {count > 0 && (
          <span className="notes-badge" aria-hidden="true">
            {count}
          </span>
        )}
      </button>
      {open && <NotesPopover id={id} trigger={trigger} />}
    </>
  );
}

function NotesPopover({ id, trigger }: { id: string; trigger: React.RefObject<HTMLButtonElement | null> }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const notes = useStore((s) => s.notes);
  // Each read as a value of its own: a selector that made a new object every time would never settle.
  const canAdd = useStore((s) => noteRights(s).add);
  const canManage = useStore((s) => noteRights(s).manage);
  const close = (back: boolean) => {
    setState({ notesOpen: false });
    if (back) requestAnimationFrame(() => trigger.current?.focus());
  };
  // The editor's own shortcuts stay out of the way while it is open, as for a menu; focus starts in the note field.
  useEffect(() => {
    openMenus.count++;
    box.current?.querySelector<HTMLElement>('textarea, button:not(.icon-btn)')?.focus({ preventScroll: true });
    return () => {
      openMenus.count--;
    };
  }, []);
  // A press anywhere else, or focus going into the preview frame, puts it away; the Notes button toggles it itself.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target instanceof Node ? e.target : null;
      if (!t || box.current?.contains(t) || trigger.current?.contains(t)) return;
      if (t instanceof Element && t.closest('.overlay-backdrop')) return;
      setState({ notesOpen: false });
    };
    const intoFrame = () => setTimeout(() => document.activeElement instanceof HTMLIFrameElement && setState({ notesOpen: false }));
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('blur', intoFrame);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('blur', intoFrame);
    };
  }, [trigger]);
  // Below the Notes button, its right edge with the button's, kept 8px inside the window.
  useLayoutEffect(() => {
    const place = () => {
      const el = box.current;
      const a = trigger.current?.getBoundingClientRect();
      if (!el || !a) return;
      const w = el.offsetWidth;
      const left = Math.max(8, Math.min(a.right - w, window.innerWidth - w - 8));
      const top = a.bottom + 6;
      setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  });
  const list = notes?.notes ?? [];
  const open = list.filter((n) => !n.resolved);
  const done = list.filter((n) => n.resolved);
  return createPortal(
    <div
      ref={box}
      id={id}
      className="share-popover notes-popover"
      role="dialog"
      aria-labelledby={`${id}-title`}
      tabIndex={-1}
      style={pos ?? { right: 8, top: 52, opacity: 0 }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }}
    >
      <div className="share-head">
        <h2 id={`${id}-title`}>Notes</h2>
        <button type="button" className="icon-btn" aria-label="Close" title="Close" onClick={() => close(true)}>
          <X />
        </button>
      </div>
      <div className="share-body">
        {canAdd ? <NoteForm /> : <p className="share-quiet">{notes?.guestNotes === false ? 'The host has turned off notes from guests.' : 'You can read the notes, but not leave one.'}</p>}
        <div className="share-scroll notes-scroll">
          {open.length === 0 && done.length === 0 ? (
            <p className="share-quiet notes-empty">No notes yet. Pin one to what is selected, or to the page, for whoever works on it next.</p>
          ) : (
            <>
              <ul className="notes-list" aria-label="Open notes">
                {open.length === 0 ? <li className="share-quiet notes-empty">Every note is resolved.</li> : open.map((n) => <NoteRow key={n.id} note={n} manage={canManage} onJump={() => close(false)} />)}
              </ul>
              {done.length > 0 && (
                <details className="notes-done">
                  <summary>Resolved ({done.length})</summary>
                  <ul className="notes-list" aria-label="Resolved notes">
                    {done.map((n) => (
                      <NoteRow key={n.id} note={n} manage={canManage} onJump={() => close(false)} />
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

/** A note to pin to what is selected now, or to the page shown. */
function NoteForm() {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const counterId = useId();
  const where = useStore((s) => {
    const place = notePlaceNow(s);
    const st = s.snapshot?.state;
    if (!place || !st) return null;
    const page = st.pages[place.pageId]?.title || 'Untitled page';
    return place.target ? `${refLabel(st, place.target)} on ${page}` : page;
  });
  const length = [...text.normalize('NFC').replace(/\s+/gu, ' ').trim()].length;
  const usable = normalizeNoteText(text) !== null;
  const send = async () => {
    if (!usable || sending) return;
    setSending(true);
    const kept = await addNote(text);
    setSending(false);
    if (kept) setText('');
  };
  return (
    <form
      className="notes-form"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <textarea
        aria-label="New note"
        aria-describedby={counterId}
        rows={2}
        value={text}
        placeholder={where ? 'Swap this photo, check this price…' : 'Open a page to leave a note on it.'}
        disabled={!where}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter pins the note; Shift+Enter is the only line break a note keeps (as a space).
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="notes-form-foot">
        <span className="share-quiet notes-where">{where ? `On ${where}` : 'No page shown'}</span>
        <span id={counterId} className={`share-quiet notes-count${length > NOTE_TEXT_MAX ? ' over' : ''}`} aria-live="polite">
          {length}/{NOTE_TEXT_MAX}
        </span>
        <button type="submit" className="btn btn-sm btn-primary" disabled={!where || !usable || sending}>
          Pin note
        </button>
      </div>
    </form>
  );
}

function NoteRow({ note, manage, onJump }: { note: LiveNote; manage: boolean; onJump: () => void }) {
  const place = useStore((s) => (s.snapshot ? notePlaceLabel(s.snapshot.state, note) : ''));
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };
  return (
    <li className={`notes-row${note.resolved ? ' resolved' : ''}`}>
      {manage && <input type="checkbox" aria-label={note.resolved ? 'Resolved: open it again' : 'Resolve'} title={note.resolved ? 'Open again' : 'Resolve'} checked={note.resolved} disabled={busy} onChange={(e) => void run(() => resolveNote(note.id, e.target.checked))} />}
      <button
        type="button"
        className="notes-jump"
        title={`Go to ${place}`}
        onClick={() => {
          onJump();
          jumpToNote(getState().notes?.notes.find((n) => n.id === note.id) ?? note);
        }}
      >
        <span className="notes-body">{note.text}</span>
        <span className="notes-meta">
          {note.authorName} · {noteAge(note.createdAt)} · {place}
        </span>
      </button>
      {manage && (
        <button type="button" className="icon-btn notes-delete" aria-label="Delete note" title="Delete note" disabled={busy} onClick={() => void run(() => deleteNote(note.id))}>
          <Trash2 />
        </button>
      )}
    </li>
  );
}
