import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { MessagesSquare, Pencil, Search, Trash2 } from 'lucide-react';
import type { Conversation, ConversationSummary } from '@shared/api';
import { cleanTitle, matchConversation, TITLE_MAX, type ConversationMatch } from '@shared/conversations';
import { api, confirmDialog, errorText, getState, setState, toast, useStore } from '../store';
import { Modal, Spinner } from '../components/ui';
import { draftFor, imagesFor, withDraft, withImages } from '../lib/chatDrafts';
import { activityPhrase, matchExcerpt } from '../lib/conversations';
import { isImeComposing } from '../lib/ime';
import { plural } from '../lib/storage';

/** A conversation as a row shows it: the request that explains it best, and a search's match. */
interface Row {
  c: ConversationSummary;
  match: ConversationMatch | null;
}

/** The first request as a confirmation quotes it: enough to tell two threads with the same title apart. */
const quoted = (text: string, max = 140) => {
  const line = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, max).join('').trimEnd()}…` : line;
};

/**
 * Earlier conversations, managed (issue 235): find one by its name or by anything asked in it, open it, name it, or
 * delete just that one. The site and its undo history never change here, and Clear history stays in the menu.
 * `opening` is the opening of the project the list was read from: every change is made in that one or not at all.
 */
export function ConversationsModal({ list, opening, onOpened, onClose }: { list: ConversationSummary[]; opening: string; onOpened: (c: Conversation) => void; onClose: () => void }) {
  const [items, setItems] = useState(list);
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  // The row and action under way: the manager waits for it, and stays open until it has answered.
  const [busy, setBusy] = useState<{ id: string; what: 'open' | 'rename' | 'delete' } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openId = useStore((s) => s.conversation?.id);
  const readOnly = useStore((s) => s.snapshot?.readOnly?.reason ?? null);
  const running = useStore((s) => !!s.runStatus);
  const blocked = readOnly ?? (running ? 'Wait for the AI to finish to rename or delete a conversation.' : null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  const stillOpen = () => getState().snapshot?.workspaceKey === opening;

  // Opened from a menu, the menu holds on to focus until it has gone: the search field takes it then.
  useEffect(() => {
    const t = setTimeout(() => {
      const field = searchRef.current;
      if (field && !field.closest('.modal')?.contains(document.activeElement)) field.focus();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const rows: Row[] = useMemo(() => {
    if (!query.trim()) return items.map((c) => ({ c, match: null }));
    return items.flatMap((c) => {
      const match = matchConversation(c, query);
      return match ? [{ c, match }] : [];
    });
  }, [items, query]);

  /** Focus after a row has gone: the next row's Open, else the last one's, else the search field. */
  const focusRow = (index: number) =>
    requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('.conversation-open');
      const target = buttons?.length ? buttons[Math.min(index, buttons.length - 1)] : searchRef.current;
      target?.focus();
    });
  /** Back to a row's Rename button once its name field has gone; the search field when a search no longer shows it. */
  const focusRename = (id: string) => requestAnimationFrame(() => (listRef.current?.querySelector<HTMLButtonElement>(`[data-rename="${CSS.escape(id)}"]`) ?? searchRef.current)?.focus());

  const open = async (c: ConversationSummary) => {
    if (busy) return;
    setBusy({ id: c.id, what: 'open' });
    setError(null);
    // The manager stays until the conversation is ready, so nothing is typed into, or sent from, the one before it.
    const r = await api.ai.openConversation(c.id).then(
      (conv) => ({ ok: true as const, conv }),
      (err: unknown) => ({ ok: false as const, message: errorText(err) })
    );
    setBusy(null);
    if (!stillOpen()) return;
    if (!r.ok) return setError(r.message || 'That conversation could not be opened.');
    onOpened(r.conv);
  };

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    if (!renaming || busy || blocked) return;
    const { id, text } = renaming;
    const before = items.find((c) => c.id === id);
    if (!before) return setRenaming(null);
    const title = cleanTitle(text);
    if (!title) return setError(`A conversation’s name needs some text, up to ${TITLE_MAX} characters.`);
    // Unchanged: nothing to save.
    if (title === before.title) return (setRenaming(null), setError(null), focusRename(id));
    setBusy({ id, what: 'rename' });
    setError(null);
    const r = await api.ai.renameConversation(id, title, opening).then(
      (v) => ({ ok: true as const, title: v.title }),
      (err: unknown) => ({ ok: false as const, message: errorText(err) })
    );
    setBusy(null);
    if (!stillOpen()) return;
    if (!r.ok) return setError(r.message || 'The conversation could not be renamed.');
    setItems((all) => all.map((c) => (c.id === id ? { ...c, title: r.title, named: true } : c)));
    setRenaming(null);
    // The conversation on screen shows its new name at once, with whatever messages it has now.
    const shown = getState().conversation;
    if (shown?.id === id) setState({ conversation: { ...shown, title: r.title, named: true } });
    focusRename(id);
  };

  const remove = async (c: ConversationSummary, index: number) => {
    if (busy || blocked) return;
    const s = getState();
    const unsent = !!draftFor(s.chatDrafts, c.id).trim() || imagesFor(s.chatImages, c.id).length > 0;
    const first = c.prompts[0];
    const yes = await confirmDialog({
      title: 'Delete this conversation?',
      body: 'Only this conversation is deleted. Your other conversations stay.',
      subject: c.title,
      subjectNote: `${plural(c.prompts.length, 'request', 'requests')}, last active ${activityPhrase(c.updatedAt)}`,
      details: [
        // Two threads can share a title: what it starts with says which one this is.
        ...(first && quoted(first) !== c.title ? [{ kind: 'note' as const, text: `It starts “${quoted(first)}”` }] : []),
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
    setBusy({ id: c.id, what: 'delete' });
    setError(null);
    const r = await api.ai.deleteConversation(c.id, opening).then(
      (active) => ({ ok: true as const, active }),
      (err: unknown) => ({ ok: false as const, message: errorText(err) })
    );
    setBusy(null);
    if (!stillOpen()) return;
    if (!r.ok) return setError(r.message || 'The conversation could not be deleted.');
    setItems((all) => all.filter((x) => x.id !== c.id));
    if (renaming?.id === c.id) setRenaming(null);
    // Its unsent message and images go with it; the one on screen gives way to the conversation main left open.
    const now = getState();
    setState({
      chatDrafts: withDraft(now.chatDrafts, c.id, ''),
      chatImages: withImages(now.chatImages, c.id, []),
      ...(now.conversation?.id === c.id ? { conversation: r.active } : {})
    });
    toast(`Deleted “${c.title}”.`, 'info');
    focusRow(index);
  };

  const editKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    // Escape leaves the name as it was, and the dialog open.
    if (e.key !== 'Escape' || isImeComposing(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const id = renaming?.id;
    setRenaming(null);
    setError(null);
    if (id) focusRename(id);
  };

  // Counted as the name is kept: composed, on one line.
  const tooLong = !!renaming && Array.from(renaming.text.normalize('NFC').replace(/\s+/g, ' ').trim()).length > TITLE_MAX;
  return (
    <Modal
      title="AI conversations"
      icon={<MessagesSquare />}
      onClose={onClose}
      busy={!!busy}
      wide
      footer={
        <>
          <span className="muted conversation-count">{query.trim() ? `${plural(rows.length, 'conversation matches', 'conversations match')}` : plural(items.length, 'conversation', 'conversations')}</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={!!busy}>
            Close
          </button>
        </>
      }
    >
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
            // Escape empties a search first; with nothing to empty, it closes the dialog as usual.
            if (e.key === 'Escape' && query && !isImeComposing(e)) (e.preventDefault(), e.stopPropagation(), setQuery(''));
          }}
        />
      </label>
      {(error || blocked) && (
        <div className="scope-note danger" role="alert">
          {error ?? blocked}
        </div>
      )}
      {rows.length === 0 ? (
        <div className="empty-insp" style={{ padding: '24px 12px' }}>
          <MessagesSquare />
          <span>{items.length ? `No conversation has “${query.trim()}” in its name or requests.` : 'No saved conversations.'}</span>
        </div>
      ) : (
        <ul ref={listRef} className="history-list conversation-list" aria-label="Conversations">
          {rows.map(({ c, match }, index) => {
            const editing = renaming?.id === c.id;
            const first = c.prompts[0] ?? '';
            // The first request, when the title doesn't already say all of it; a search's match when it is in a request.
            const shown = match?.in === 'prompt' ? matchExcerpt(match) : null;
            const titleHit = match?.in === 'title' ? match : null;
            const showFirst = !shown && first && first.replace(/\s+/g, ' ').trim() !== c.title;
            // The row's controls are described by what tells it apart: its request and when it was last used.
            const about = `${ids}-${index}`;
            return (
              <li key={c.id} aria-current={c.id === openId ? 'true' : undefined} data-conversation-id={c.id}>
                <span className="grow conversation-text">
                  {editing ? (
                    <form className="conversation-rename" onSubmit={(e) => void rename(e)}>
                      <input
                        className="input"
                        aria-label={`Name for “${c.title}”`}
                        aria-invalid={tooLong || undefined}
                        autoFocus
                        value={renaming.text}
                        disabled={busy?.id === c.id}
                        onChange={(e) => setRenaming({ id: c.id, text: e.target.value })}
                        onKeyDown={editKeys}
                        onFocus={(e) => e.currentTarget.select()}
                      />
                      <button className="btn btn-sm btn-primary" type="submit" disabled={!!busy || !!blocked || !renaming.text.trim() || tooLong}>
                        {busy?.what === 'rename' && busy.id === c.id ? <Spinner decorative /> : null} Save
                      </button>
                    </form>
                  ) : (
                    <span className="conversation-title ellipsis" title={c.title}>
                      {titleHit ? (
                        <>
                          {c.title.slice(0, titleHit.start)}
                          <mark>{c.title.slice(titleHit.start, titleHit.end)}</mark>
                          {c.title.slice(titleHit.end)}
                        </>
                      ) : (
                        c.title
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
                    <small>
                      {c.id === openId ? 'Open now · ' : ''}
                      {plural(c.prompts.length, 'request', 'requests')} · Last active {activityPhrase(c.updatedAt)}
                    </small>
                  </span>
                  {editing && tooLong && <small className="conversation-error">Up to {TITLE_MAX} characters.</small>}
                </span>
                {!editing && (
                  <>
                    <button className="btn btn-sm conversation-open" aria-label={`Open “${c.title}”`} aria-describedby={about} onClick={() => void open(c)} disabled={!!busy || running}>
                      {busy?.what === 'open' && busy.id === c.id ? <Spinner decorative /> : null} Open
                    </button>
                    <button
                      className="icon-btn"
                      data-rename={c.id}
                      aria-label={`Rename “${c.title}”`}
                      aria-describedby={about}
                      title={blocked ?? 'Rename'}
                      disabled={!!busy || !!blocked}
                      onClick={() => {
                        setError(null);
                        setRenaming({ id: c.id, text: c.title });
                      }}
                    >
                      <Pencil />
                    </button>
                    <button className="icon-btn" aria-label={`Delete “${c.title}”`} aria-describedby={about} title={blocked ?? 'Delete'} disabled={!!busy || !!blocked} onClick={() => void remove(c, index)}>
                      {busy?.what === 'delete' && busy.id === c.id ? <Spinner decorative /> : <Trash2 />}
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
