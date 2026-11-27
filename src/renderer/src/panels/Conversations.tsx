import './Conversations.css';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { CircleAlert, MessagesSquare, Pencil, Search, SearchX, Trash2 } from 'lucide-react';
import type { Conversation, ConversationSummary } from '@shared/api';
import { cleanTitle, matchConversation, TITLE_MAX, type ConversationMatch } from '@shared/conversations';
import { api, confirmDialog, errorText, getState, setState, toast, useStore } from '../store';
import { Modal, Spinner } from '../components/ui';
import { draftFor, imagesFor, withDraft, withImages } from '../lib/chatDrafts';
import { retargetDrops } from '../lib/chat-drop';
import { activityPhrase, matchExcerpt } from '../lib/conversations';
import { isImeComposing } from '../lib/ime';
import { plural } from '../lib/storage';
import { clock, dayKey, dayName, fullWhen } from '../lib/when';
import { HistoryNote } from './SavedVersions';
import { BlockedNote, BlockedStatus, aiRunning } from '../components/BlockedNote';

/** A conversation as a row shows it: the request that explains it best, and a search's match. */
interface Row {
  c: ConversationSummary;
  match: ConversationMatch | null;
}

/** A row's actions, in the order Left and Right move through them. */
type Col = 'open' | 'rename' | 'delete';

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The first request as a confirmation quotes it: enough to tell two threads with the same title apart. */
const quoted = (text: string, max = 140) => {
  const chars = Array.from(flat(text));
  return chars.length > max ? `${chars.slice(0, max).join('').trimEnd()}…` : chars.join('');
};

/** An unnamed title cut from the first request: that request, whole, says it better. */
const cutFromRequest = (c: ConversationSummary) => {
  const first = c.prompts[0];
  return !c.named && !!first && c.title.endsWith('…') && flat(first).startsWith(c.title.slice(0, -1));
};
/** The name a conversation goes by here: its whole first request when its title was cut from it. */
const shownTitle = (c: ConversationSummary) => (cutFromRequest(c) ? flat(c.prompts[0]) : c.title);
/** What Rename starts from: a cut title without its ellipsis, so text added to it reads on. */
const startName = (c: ConversationSummary) => (cutFromRequest(c) ? c.title.slice(0, -1) : c.title);

/** A saved conversation whose file has gone since the list was read: said plainly, never as a path. */
const missingFile = (message: string) => /ENOENT|no such file/i.test(message);

/**
 * Earlier conversations, managed (issue 235): find one by its name or by anything asked in it, open it, name it, or
 * delete just that one. The site and its undo history never change here, and Clear history stays in the menu.
 * `opening` is the opening of the project the list was read from: every change is made in that one or not at all.
 *
 * Newest first, under the day each was last added to, as History lists its changes. The list is one Tab stop: the
 * arrow keys move between rows (Up and Down, keeping the action) and along a row's actions (Left and Right).
 */
export function ConversationsModal({ list, opening, onOpened, onClose }: { list: ConversationSummary[]; opening: string; onOpened: (c: Conversation) => void; onClose: () => void }) {
  const [items, setItems] = useState(list);
  const [query, setQuery] = useState('');
  // The conversation being renamed, the name typed so far, and the name it started from.
  const [renaming, setRenaming] = useState<{ id: string; text: string; from: string } | null>(null);
  // The row and action under way: the manager waits for it, and stays open until it has answered.
  const [busy, setBusy] = useState<{ id: string; what: 'open' | 'rename' | 'delete' } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The list's one Tab stop: a row and one of its actions.
  const [stop, setStop] = useState<{ id: string; col: Col } | null>(null);
  const openId = useStore((s) => s.conversation?.id);
  const readOnly = useStore((s) => s.snapshot?.readOnly?.reason ?? null);
  const runStatus = useStore((s) => s.runStatus);
  const running = !!runStatus;
  const ai = runStatus === 'awaiting-input' ? 'the AI is waiting for your answer.' : 'the AI is working.';
  // Why an action can't be taken now, each said once above the list. A request goes on in its own conversation while
  // another is opened (#1125), but for a question in a project read-only here, whose answer is never saved: switched
  // away from, it would be lost. Renaming and deleting wait for the AI (a request saves its thread when it ends) and for
  // a project that is read-only here.
  const editBlocked = readOnly ? 'this project is read-only here.' : running ? ai : null;
  const openBlocked = running && readOnly ? ai : null;
  // What the AI holds, said once: opening in a read-only project (which holds renaming and deleting itself), or else
  // renaming and deleting.
  const aiHolds = running ? (readOnly ? 'open a conversation' : 'rename or delete a conversation') : null;
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  const readOnlyNote = `${ids}-read-only`;
  const runningNote = `${ids}-running`;
  const stillOpen = () => getState().snapshot?.workspaceKey === opening;

  // Opened from a menu, the menu holds on to focus until it has gone: the search field takes it then.
  useEffect(() => {
    const t = setTimeout(() => {
      const field = searchRef.current;
      if (field && !field.closest('.modal')?.contains(document.activeElement)) field.focus();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // The open conversation is in sight from the start, however long ago it was last added to.
  useEffect(() => {
    const t = requestAnimationFrame(() => listRef.current?.querySelector('li[aria-current="true"]')?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(t);
  }, []);

  const searching = !!query.trim();
  const rows: Row[] = useMemo(() => {
    if (!query.trim()) return items.map((c) => ({ c, match: null }));
    return items.flatMap((c) => {
      const match = matchConversation(c, query);
      return match ? [{ c, match }] : [];
    });
  }, [items, query]);

  // Newest first, under the day each was last added to.
  const days = useMemo(() => {
    const out: Array<{ key: string; name: string; rows: Array<Row & { index: number }> }> = [];
    rows.forEach((row, index) => {
      const key = dayKey(row.c.updatedAt);
      const last = out.at(-1);
      if (last?.key === key) last.rows.push({ ...row, index });
      else out.push({ key, name: dayName(row.c.updatedAt), rows: [{ ...row, index }] });
    });
    return out;
  }, [rows]);

  // The Tab stop stays on a row that is listed: the one last used, else the open conversation, else the first.
  const tabStop = rows.some((r) => r.c.id === stop?.id) ? stop! : { id: rows.find((r) => r.c.id === openId)?.c.id ?? rows[0]?.c.id, col: 'open' as Col };

  // How many there are, said once typing pauses rather than on every key.
  const count = searching ? (rows.length ? `Showing ${rows.length} of ${plural(items.length, 'conversation', 'conversations')}` : '') : plural(items.length, 'conversation', 'conversations');
  const spoken = searching && !rows.length ? `No conversation has “${query.trim()}” in its name or requests.` : count;
  const [said, setSaid] = useState(spoken);
  useEffect(() => {
    const t = setTimeout(() => setSaid(spoken), 450);
    return () => clearTimeout(t);
  }, [spoken]);

  /** Focus after a row has gone: the next row's Open, else the last one's, else the search field. */
  const focusRow = (index: number) =>
    requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('.conversation-open');
      const target = buttons?.length ? buttons[Math.min(index, buttons.length - 1)] : searchRef.current;
      target?.focus();
    });
  /** Back to a row's Rename button once its name field has gone; the search field when a search no longer shows it. */
  const focusRename = (id: string) => requestAnimationFrame(() => (listRef.current?.querySelector<HTMLButtonElement>(`[data-rename="${CSS.escape(id)}"]`) ?? searchRef.current)?.focus());

  /** Back into a row's name field, after a rename that failed: the name typed is kept. */
  const focusField = (id: string) => requestAnimationFrame(() => listRef.current?.querySelector<HTMLInputElement>(`li[data-conversation-id="${CSS.escape(id)}"] .conversation-rename input`)?.focus());
  /** Back to a row's Delete button, after a delete that failed. */
  const focusDelete = (id: string) => requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`li[data-conversation-id="${CSS.escape(id)}"] .conversation-delete`)?.focus());
  /** A conversation whose file has gone can't be opened, named or deleted from here: it leaves the list, and says so. */
  const gone = (c: ConversationSummary, what: string) => {
    const index = rows.findIndex((row) => row.c.id === c.id);
    setItems((all) => all.filter((x) => x.id !== c.id));
    if (renaming?.id === c.id) setRenaming(null);
    setError(`“${shownTitle(c)}” couldn’t be ${what}: its saved file is missing, so it’s been taken off this list.`);
    focusRow(index < 0 ? rows.length : index);
  };

  const clearSearch = () => {
    setQuery('');
    searchRef.current?.focus();
  };

  const open = async (c: ConversationSummary) => {
    if (busy || openBlocked) return;
    setBusy({ id: c.id, what: 'open' });
    setError(null);
    // The manager stays until the conversation is ready, so nothing is typed into, or sent from, the one before it.
    const r = await api.ai.openConversation(c.id).then(
      (conv) => ({ ok: true as const, conv }),
      (err: unknown) => ({ ok: false as const, message: errorText(err) })
    );
    setBusy(null);
    if (!stillOpen()) return;
    if (!r.ok) {
      if (missingFile(r.message)) return gone(c, 'opened');
      const index = rows.findIndex((row) => row.c.id === c.id);
      setError(`“${shownTitle(c)}” couldn’t be opened. ${r.message || 'Try again.'}`);
      // Its Open button was disabled while loading: focus goes back to it, or to the search field.
      return focusRow(index < 0 ? rows.length : index);
    }
    onOpened(r.conv);
  };

  const cancelRename = () => {
    const id = renaming?.id;
    setRenaming(null);
    setError(null);
    if (id) focusRename(id);
  };

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    if (!renaming || busy || editBlocked) return;
    const { id, text, from } = renaming;
    const before = items.find((c) => c.id === id);
    if (!before) return setRenaming(null);
    const title = cleanTitle(text);
    if (!title) return setError(`A conversation’s name needs some text, up to ${TITLE_MAX} characters.`);
    // Unchanged, from what it was or from what the field started with: nothing to save.
    if (title === before.title || title === cleanTitle(from)) return (setRenaming(null), setError(null), focusRename(id));
    setBusy({ id, what: 'rename' });
    setError(null);
    const r = await api.ai.renameConversation(id, title, opening).then(
      (v) => ({ ok: true as const, title: v.title }),
      (err: unknown) => ({ ok: false as const, message: errorText(err) })
    );
    setBusy(null);
    if (!stillOpen()) return;
    if (!r.ok) {
      if (missingFile(r.message)) return gone(before, 'renamed');
      setError(`“${shownTitle(before)}” couldn’t be renamed. ${r.message || 'Try again.'}`);
      return focusField(id);
    }
    setItems((all) => all.map((c) => (c.id === id ? { ...c, title: r.title, named: true } : c)));
    setRenaming(null);
    // The conversation on screen shows its new name at once, with whatever messages it has now.
    const shown = getState().conversation;
    if (shown?.id === id) setState({ conversation: { ...shown, title: r.title, named: true } });
    focusRename(id);
  };

  const remove = async (c: ConversationSummary, index: number) => {
    if (busy || editBlocked) return;
    const s = getState();
    const unsent = !!draftFor(s.chatDrafts, c.id).trim() || imagesFor(s.chatImages, c.id).length > 0;
    const first = c.prompts[0];
    const yes = await confirmDialog({
      title: 'Delete this conversation?',
      body: 'Only this conversation is deleted. Your other conversations stay.',
      subject: shownTitle(c),
      subjectNote: `${plural(c.prompts.length, 'request', 'requests')}, last active ${activityPhrase(c.updatedAt)}`,
      details: [
        // Two threads can share a title: what it starts with says which one this is.
        ...(first && quoted(first) !== c.title && !cutFromRequest(c) ? [{ kind: 'note' as const, text: `It starts “${quoted(first)}”` }] : []),
        ...(unsent ? [{ kind: 'lose' as const, text: 'The message you haven’t sent in it goes too.' }] : []),
        { kind: 'keep' as const, text: 'Changes the AI made to your site stay, and you can still undo them.' },
        { kind: 'final' as const, text: 'A deleted conversation can’t be brought back.' }
      ],
      confirmLabel: 'Delete conversation',
      tone: 'danger',
      icon: 'delete'
    });
    // Cancelled: the question hands focus back to the Delete button it was asked from.
    if (yes !== true || !stillOpen()) return;
    // A hold that came while the question was open stops it here: the manager's note, back in view, says why.
    const held = getState();
    if (held.snapshot?.readOnly || held.runStatus) return;
    setBusy({ id: c.id, what: 'delete' });
    setError(null);
    const r = await api.ai.deleteConversation(c.id, opening).then(
      (active) => ({ ok: true as const, active }),
      (err: unknown) => ({ ok: false as const, message: errorText(err) })
    );
    setBusy(null);
    if (!stillOpen()) return;
    if (!r.ok) {
      if (missingFile(r.message)) return gone(c, 'deleted');
      setError(`“${shownTitle(c)}” couldn’t be deleted. ${r.message || 'Try again.'}`);
      return focusDelete(c.id);
    }
    setItems((all) => all.filter((x) => x.id !== c.id));
    if (renaming?.id === c.id) setRenaming(null);
    // Its unsent message and images go with it, images still being added included; the one on screen gives way to the
    // conversation main left open.
    retargetDrops(c.id, null);
    const now = getState();
    setState({
      chatDrafts: withDraft(now.chatDrafts, c.id, ''),
      chatImages: withImages(now.chatImages, c.id, []),
      ...(now.conversation?.id === c.id ? { conversation: r.active } : {})
    });
    toast(`Deleted “${shownTitle(c)}”.`, 'info');
    focusRow(index);
  };

  /**
   * Escape from a row being renamed (its field, Save or Cancel) cancels the rename. Anywhere else it empties a search
   * first, then closes the dialog as usual.
   */
  const bodyKeys = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || isImeComposing(e)) return;
    if (renaming && (e.target as HTMLElement).closest('li.renaming')) return (e.preventDefault(), e.stopPropagation(), cancelRename());
    if (!searching) return;
    e.preventDefault();
    e.stopPropagation();
    clearSearch();
  };

  /** The roving Tab stop: Up and Down keep the action, Left and Right move along the row, Home and End reach its ends. */
  const listKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = e.target as HTMLElement;
    // A name being typed keeps its own keys.
    if (from.tagName === 'INPUT' || e.altKey || e.metaKey || e.shiftKey) return;
    const li = from.closest<HTMLLIElement>('li[data-conversation-id]');
    if (!li || !listRef.current) return;
    // A row being renamed has no actions to land on: the keys pass over it.
    const actions = (row: HTMLLIElement) => [...row.querySelectorAll<HTMLButtonElement>('button[data-col]')];
    const rowEls = [...listRef.current.querySelectorAll<HTMLLIElement>('li[data-conversation-id]')].filter((row) => row === li || actions(row).length);
    const here = actions(li);
    const col = from.dataset.col as Col | undefined;
    const at = rowEls.indexOf(li);
    const inRow = (row: HTMLLIElement | undefined) => row && (actions(row).find((b) => b.dataset.col === col) ?? actions(row)[0]);
    let to: HTMLButtonElement | undefined;
    if (e.key === 'ArrowDown') to = inRow(rowEls[at + 1]);
    else if (e.key === 'ArrowUp') to = at === 0 ? undefined : inRow(rowEls[at - 1]);
    else if (e.key === 'ArrowRight') to = here[here.indexOf(from as HTMLButtonElement) + 1];
    else if (e.key === 'ArrowLeft') to = here[here.indexOf(from as HTMLButtonElement) - 1];
    else if (e.key === 'Home') to = e.ctrlKey ? actions(rowEls[0])[0] : here[0];
    else if (e.key === 'End') to = e.ctrlKey ? actions(rowEls.at(-1)!).at(-1) : here.at(-1);
    else return;
    e.preventDefault();
    // Up from the first row goes back to the search field.
    if (e.key === 'ArrowUp' && at === 0) return searchRef.current?.focus();
    to?.focus();
  };

  // Counted as the name is kept: composed, on one line.
  const nameLength = renaming ? Array.from(flat(renaming.text.normalize('NFC'))).length : 0;
  const tooLong = nameLength > TITLE_MAX;
  return (
    <Modal
      title="AI conversations"
      icon={<MessagesSquare />}
      onClose={onClose}
      describedBy={[readOnly && readOnlyNote, aiHolds && runningNote].filter(Boolean).join(' ') || undefined}
      busy={!!busy}
      wide
      footer={
        <span className="conversation-body" onKeyDown={bodyKeys}>
          <span className="muted conversation-count" aria-hidden="true">
            {count}
          </span>
          <span className="sr-only" role="status">
            {said}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={!!busy}>
            Close
          </button>
        </span>
      }
    >
      <div className="conversation-body" onKeyDown={bodyKeys}>
      <label className="conversation-search">
        <Search aria-hidden="true" />
        <input
          ref={searchRef}
          className="input"
          type="search"
          aria-label="Find a conversation"
          placeholder="Find by name or by anything you asked"
          data-autofocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Down goes into the list, to its Tab stop (the first row's Open when that row is being renamed).
            if (e.key === 'ArrowDown' && !isImeComposing(e) && listRef.current) {
              const target = listRef.current.querySelector<HTMLButtonElement>('button[data-col][tabindex="0"]') ?? listRef.current.querySelector<HTMLButtonElement>('button[data-col]');
              if (target) (e.preventDefault(), target.focus());
            }
          }}
        />
      </label>
      {/* Each hold is said as it comes and goes: the AI's often while the manager is open, read-only rarely. */}
      <BlockedStatus block={readOnly ? { kind: 'read-only', text: readOnly } : null} lifted="You can rename or delete a conversation now." />
      <BlockedStatus block={aiHolds ? { kind: 'ai', text: aiRunning(runStatus, aiHolds) } : null} lifted={readOnly ? 'You can open a conversation now.' : 'You can rename or delete a conversation now.'} />
      {readOnly && (
        <BlockedNote block={{ kind: 'read-only', text: readOnly }} id={readOnlyNote} live={false} />
      )}
      {aiHolds && <BlockedNote block={{ kind: 'ai', text: aiRunning(runStatus, aiHolds) }} id={runningNote} live={false} />}
      {error && (
        <HistoryNote tone="danger" icon={<CircleAlert aria-hidden="true" />}>
          {error}
        </HistoryNote>
      )}
      {rows.length === 0 ? (
        <div className="empty-insp conversation-empty">
          {items.length ? (
            <>
              <SearchX aria-hidden="true" />
              <span>No conversation has “{query.trim()}” in its name or requests.</span>
              <button type="button" className="link-btn" onClick={clearSearch}>
                Clear search
              </button>
            </>
          ) : (
            <>
              <MessagesSquare aria-hidden="true" />
              <span>No saved conversations.</span>
            </>
          )}
        </div>
      ) : (
        <div ref={listRef} className="conversation-days" role="group" aria-label="Conversations" aria-describedby={`${ids}-keys`} onKeyDown={listKeys}>
          <span id={`${ids}-keys`} className="sr-only">
            Arrow keys move between conversations, and along a conversation’s Open, Rename and Delete.
          </span>
          {days.map((day) => (
            <section key={day.key} className="history-day" aria-labelledby={`${ids}-day-${day.key}`}>
              <h3 className="history-day-head" id={`${ids}-day-${day.key}`}>
                {day.name}
              </h3>
              <ul className="history-list conversation-list">
                {day.rows.map(({ c, match, index }) => {
                  const editing = renaming?.id === c.id;
                  const current = c.id === openId;
                  const first = c.prompts[0] ?? '';
                  // A search's match when it is in a request; otherwise the first request, when the title doesn't
                  // already say all of it. A title cut from that request gives way to the request itself.
                  const shown = match?.in === 'prompt' ? matchExcerpt(match) : null;
                  const titleHit = match?.in === 'title' ? match : null;
                  const cutFrom = !shown && cutFromRequest(c);
                  const name = shownTitle(c);
                  const titleText = cutFrom && (!titleHit || flat(first).slice(titleHit.start, titleHit.end) === c.title.slice(titleHit.start, titleHit.end)) ? flat(first) : c.title;
                  // While it is renamed, the whole request stays in sight to name it by.
                  const showFirst = !shown && first && flat(first) !== c.title && (editing || titleText === c.title);
                  // The row's controls are described by what tells it apart: its request and when it was last used.
                  const about = `${ids}-${index}`;
                  const errorId = `${ids}-${index}-error`;
                  const tab = (col: Col) => (tabStop.id === c.id && tabStop.col === col ? 0 : -1);
                  const focused = (col: Col) => () => setStop({ id: c.id, col });
                  // A blocked action is described by the note that says why, as well as by its row.
                  const describedBy = (note: string | null) => (note ? `${about} ${note}` : about);
                  const editNote = readOnly ? readOnlyNote : running ? runningNote : null;
                  return (
                    <li key={c.id} aria-current={current ? 'true' : undefined} data-conversation-id={c.id} className={editing ? 'renaming' : undefined}>
                      <span className="grow conversation-text">
                        {editing ? (
                          <>
                            <form id={`${ids}-${index}-form`} className="conversation-rename" onSubmit={(e) => void rename(e)}>
                              <input
                                className="input"
                                aria-label={`Name for “${name}”`}
                                aria-invalid={tooLong || undefined}
                                aria-describedby={tooLong ? errorId : undefined}
                                autoFocus
                                value={renaming.text}
                                disabled={busy?.id === c.id}
                                onChange={(e) => setRenaming((r) => r && { ...r, text: e.target.value })}
                                onFocus={(e) => e.currentTarget.select()}
                              />
                            </form>
                            {tooLong && (
                              <small id={errorId} className="conversation-error">
                                <CircleAlert aria-hidden="true" /> Up to {TITLE_MAX} characters. This name has {nameLength}.
                              </small>
                            )}
                          </>
                        ) : (
                          // A name that matched wraps, so the match is never cut off at the row's end.
                          <span className={`conversation-title${titleHit ? '' : ' ellipsis'}`} title={titleText}>
                            {titleHit && titleText.slice(titleHit.start, titleHit.end) === c.title.slice(titleHit.start, titleHit.end) ? (
                              <>
                                {titleText.slice(0, titleHit.start)}
                                <mark>{titleText.slice(titleHit.start, titleHit.end)}</mark>
                                {titleText.slice(titleHit.end)}
                              </>
                            ) : (
                              titleText
                            )}
                          </span>
                        )}
                        <span id={about} className="conversation-about">
                          {shown ? (
                            <span className="conversation-prompt" data-testid="conversation-match">
                              {shown.before}
                              <mark>{shown.hit}</mark>
                              {shown.after}
                            </span>
                          ) : showFirst ? (
                            <span className="conversation-prompt">{first}</span>
                          ) : null}
                          <span className="conversation-meta">
                            {current && <span className="badge accent">Current</span>}
                            <span>
                              {plural(c.prompts.length, 'request', 'requests')} · Last active{' '}
                              <time dateTime={c.updatedAt} title={fullWhen(c.updatedAt)}>
                                {clock(c.updatedAt)}
                              </time>
                            </span>
                          </span>
                        </span>
                      </span>
                      <span className="conversation-actions">
                        {editing ? (
                          <>
                            <button
                              className="btn btn-sm btn-primary"
                              type="submit"
                              form={`${ids}-${index}-form`}
                              aria-disabled={!!editBlocked || undefined}
                              aria-describedby={editNote ?? undefined}
                              title={editBlocked ? `Can’t save: ${editBlocked}` : undefined}
                              disabled={!!busy || !renaming.text.trim() || tooLong}
                            >
                              {busy?.what === 'rename' && busy.id === c.id ? <Spinner decorative /> : null} Save
                            </button>
                            <button className="btn btn-sm btn-ghost" type="button" onClick={cancelRename} disabled={busy?.id === c.id}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="btn btn-sm conversation-open"
                              data-col="open"
                              tabIndex={tab('open')}
                              onFocus={focused('open')}
                              aria-label={`Open “${name}”`}
                              aria-describedby={describedBy(openBlocked ? runningNote : null)}
                              aria-disabled={!!openBlocked || undefined}
                              title={openBlocked ? `Can’t open: ${openBlocked}` : undefined}
                              onClick={() => void open(c)}
                              disabled={!!busy}
                            >
                              {busy?.what === 'open' && busy.id === c.id ? <Spinner decorative /> : null} Open
                            </button>
                            <span className="conversation-tools">
                              <button
                                className="icon-btn"
                                data-col="rename"
                                data-rename={c.id}
                                tabIndex={tab('rename')}
                                onFocus={focused('rename')}
                                aria-label={`Rename “${name}”`}
                                aria-describedby={describedBy(editNote)}
                                aria-disabled={!!editBlocked || undefined}
                                title={editBlocked ? `Can’t rename: ${editBlocked}` : 'Rename'}
                                disabled={!!busy}
                                onClick={() => {
                                  if (editBlocked) return;
                                  setError(null);
                                  setRenaming({ id: c.id, text: startName(c), from: startName(c) });
                                }}
                              >
                                <Pencil />
                              </button>
                              <button
                                className="icon-btn conversation-delete"
                                data-col="delete"
                                tabIndex={tab('delete')}
                                onFocus={focused('delete')}
                                aria-label={`Delete “${name}”`}
                                aria-describedby={describedBy(editNote)}
                                aria-disabled={!!editBlocked || undefined}
                                title={editBlocked ? `Can’t delete: ${editBlocked}` : 'Delete'}
                                disabled={!!busy}
                                onClick={() => void remove(c, index)}
                              >
                                {busy?.what === 'delete' && busy.id === c.id ? <Spinner decorative /> : <Trash2 />}
                              </button>
                            </span>
                          </>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
      </div>
    </Modal>
  );
}
