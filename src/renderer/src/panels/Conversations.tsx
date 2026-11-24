import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { MessagesSquare, Pencil, Search, Trash2 } from 'lucide-react';
import type { ConversationSummary } from '@shared/api';
import { matchConversation, TITLE_MAX, type ConversationMatch } from '@shared/conversations';
import { api, confirmDialog, errorText, getState, setState, toast, useStore } from '../store';
import { Modal, Spinner } from '../components/ui';
import { draftFor, imagesFor, withDraft, withImages } from '../lib/chatDrafts';
import { activityPhrase, matchExcerpt } from '../lib/conversations';
import { plural } from '../lib/storage';

/** A conversation as a row shows it: the request that explains it best, and a search's match. */
interface Row {
  c: ConversationSummary;
  match: ConversationMatch | null;
}

/**
 * Earlier conversations, managed (issue 235): find one by its name or by anything asked in it, open it, name it, or
 * delete just that one. The site and its undo history never change here, and Clear history stays in the menu.
 */
export function ConversationsModal({ list, opening, onOpen, onClose }: { list: ConversationSummary[]; opening: string; onOpen: (id: string) => void; onClose: () => void }) {
  const [items, setItems] = useState(list);
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openId = useStore((s) => s.conversation?.id);
  const readOnly = useStore((s) => s.snapshot?.readOnly?.reason ?? null);
  const running = useStore((s) => !!s.runStatus);
  const blocked = readOnly ?? (running ? 'Wait for the AI to finish to rename or delete a conversation.' : null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const stillOpen = () => getState().snapshot?.workspaceKey === opening;

  // Another project opened meanwhile: nothing listed here is its.
  const workspace = useStore((s) => s.snapshot?.workspaceKey);
  useEffect(() => {
    if (workspace !== opening) onClose();
  }, [workspace, opening, onClose]);

  const rows: Row[] = useMemo(() => {
    if (!query.trim()) return items.map((c) => ({ c, match: null }));
    return items.flatMap((c) => {
      const match = matchConversation(c, query);
      return match ? [{ c, match }] : [];
    });
  }, [items, query]);

  /** Focus the row at `index` after a change, or the search field when the list has none left. */
  const focusRow = (index: number) =>
    requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('.conversation-open');
      const target = buttons?.length ? buttons[Math.min(index, buttons.length - 1)] : searchRef.current;
      target?.focus();
    });

  /** Back to a row's Rename button once its name field has gone. */
  const focusRename = (id: string) => requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`[data-rename="${CSS.escape(id)}"]`)?.focus());

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    if (!renaming || busy) return;
    const { id, text } = renaming;
    const before = items.find((c) => c.id === id);
    if (!before) return setRenaming(null);
    // Unchanged: nothing to save.
    if (text.replace(/\s+/g, ' ').trim() === before.title) return (setRenaming(null), focusRename(id));
    setBusy(id);
    setError(null);
    const r = await api.ai.renameConversation(id, text, opening).then(
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
    const yes = await confirmDialog({
      title: 'Delete this conversation?',
      body: 'Only this conversation is deleted. Your other conversations stay.',
      subject: c.title,
      subjectNote: `${plural(c.prompts.length, 'request', 'requests')}, last active ${activityPhrase(c.updatedAt)}`,
      details: [
        ...(unsent ? [{ kind: 'lose' as const, text: 'The message you haven’t sent in it goes too.' }] : []),
        { kind: 'keep' as const, text: 'Changes the AI made to your site stay, and you can still undo them.' },
        { kind: 'final' as const, text: 'A deleted conversation can’t be brought back.' }
      ],
      confirmLabel: 'Delete conversation',
      tone: 'danger',
      icon: 'delete'
    });
    if (yes !== true || !stillOpen()) return focusRow(index);
    setBusy(c.id);
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
    if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    const id = renaming?.id;
    setRenaming(null);
    setError(null);
    if (id) focusRename(id);
  };

  return (
    <Modal
      title="AI conversations"
      icon={<MessagesSquare />}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted conversation-count">{query.trim() ? `${plural(rows.length, 'conversation matches', 'conversations match')}` : plural(items.length, 'conversation', 'conversations')}</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
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
            if (e.key === 'Escape' && query && !e.nativeEvent.isComposing) (e.preventDefault(), e.stopPropagation(), setQuery(''));
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
            const opening = c.prompts[0] ?? '';
            // The first request, when the title doesn't already say all of it; a search's match when it is in a request.
            const shown = match?.in === 'prompt' ? matchExcerpt(match) : null;
            const titleHit = match?.in === 'title' ? match : null;
            const showOpening = !shown && opening && opening.replace(/\s+/g, ' ').trim() !== c.title;
            return (
              <li key={c.id} aria-current={c.id === openId ? 'true' : undefined} data-conversation-id={c.id}>
                <span className="grow conversation-text">
                  {editing ? (
                    <form className="conversation-rename" onSubmit={(e) => void rename(e)}>
                      <input
                        className="input"
                        aria-label={`Name for “${c.title}”`}
                        maxLength={TITLE_MAX}
                        autoFocus
                        value={renaming.text}
                        disabled={busy === c.id}
                        onChange={(e) => setRenaming({ id: c.id, text: e.target.value })}
                        onKeyDown={editKeys}
                        onFocus={(e) => e.currentTarget.select()}
                      />
                      <button className="btn btn-sm btn-primary" type="submit" disabled={busy === c.id || !renaming.text.trim()}>
                        {busy === c.id ? <Spinner decorative /> : null} Save
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
                  {shown ? (
                    <span className="conversation-prompt" data-testid="conversation-match">
                      {shown.before}
                      <mark>{shown.hit}</mark>
                      {shown.after}
                    </span>
                  ) : showOpening ? (
                    <span className="conversation-prompt">{opening}</span>
                  ) : null}
                  <small>
                    {c.id === openId ? 'Open now · ' : ''}
                    {plural(c.prompts.length, 'request', 'requests')} · Last active {activityPhrase(c.updatedAt)}
                  </small>
                </span>
                {!editing && (
                  <>
                    <button className="btn btn-sm conversation-open" aria-label={`Open “${c.title}”`} onClick={() => onOpen(c.id)} disabled={!!busy || running}>
                      Open
                    </button>
                    <button
                      className="icon-btn"
                      data-rename={c.id}
                      aria-label={`Rename “${c.title}”`}
                      title={blocked ?? 'Rename'}
                      disabled={!!busy || !!blocked}
                      onClick={() => {
                        setError(null);
                        setRenaming({ id: c.id, text: c.title });
                      }}
                    >
                      <Pencil />
                    </button>
                    <button className="icon-btn" aria-label={`Delete “${c.title}”`} title={blocked ?? 'Delete'} disabled={!!busy || !!blocked} onClick={() => void remove(c, index)}>
                      {busy === c.id ? <Spinner decorative /> : <Trash2 />}
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
