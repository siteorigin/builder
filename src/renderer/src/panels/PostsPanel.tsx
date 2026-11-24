import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Copy, Newspaper, Plus, Search, Trash2, X } from 'lucide-react';
import { formatArticleDate } from '@shared/articles';
import { entryLinkUses } from '@engine/page-links';
import { commitOps, confirmDialog, getState, markDraft, setState, toast, undoAction, useStore } from '../store';
import { Field, Modal } from '../components/ui';
import { isImeComposing } from '../lib/ime';
import { POST_SORTS, duplicatePostOps, newPostOps, postAt, postRows, postsCollection, MAX_POST_TITLE, type PostRef, type PostSort } from '../lib/posts';
import { orderedEntries } from '@shared/collections';
import type { ProjectState } from '@shared/types';
import { flushOpenPost } from '../lib/post-draft';

/**
 * Save the post open in the writer before another takes its place. False, said in a notice, when its text could not
 * be saved: the writer keeps it, with what to do about it above the text.
 */
async function openSaved(): Promise<boolean> {
  if (await flushOpenPost()) return true;
  toast('The post you are writing has text that is not saved yet. See the note above its text.', 'error');
  return false;
}

/** How many old addresses of a post are kept working, sending visitors on to it. */
function keptAddresses(state: ProjectState, entryId: string): number {
  const kept: unknown = state.site.redirects;
  return Array.isArray(kept) ? kept.filter((r) => (r as { entryId?: unknown })?.entryId === entryId).length : 0;
}

/** Remove a post, letting go of it in the writer only once it is gone. */
async function deletePost(ref: PostRef, title: string, replacement: { replacementPageId?: string; replacementEntryId?: string }): Promise<boolean> {
  const r = await commitOps([{ type: 'entry.remove', collectionId: ref.collectionId, entryId: ref.entryId, ...replacement }], 'Delete post');
  if (!r) return false;
  const s = getState();
  if (s.post?.entryId === ref.entryId) setState({ post: null, postView: 'write' });
  toast(`Deleted “${title}”`, 'info', r.entryId ? undoAction({ entryId: r.entryId, revision: r.revision, workspaceKey: r.workspaceKey }) : undefined);
  return true;
}

/**
 * Deleting a post that other places link to: the author chooses where those links (and its old addresses kept
 * working) go instead, a page or another post, so readers of a replaced article reach its successor.
 */
function DeletePostDialog({ target, onClose }: { target: PostRef; onClose: () => void }) {
  const snap = useStore((s) => s.snapshot);
  const uid = useId();
  const [to, setTo] = useState(() => `page:${snap?.state.site.homePageId ?? ''}`);
  const [busy, setBusy] = useState(false);
  const state = snap?.state;
  const e = state && postAt(state, target);
  if (!state || !e) return null;
  const uses = entryLinkUses(state, target.entryId);
  const kept = keptAddresses(state, target.entryId);
  const where = [...new Set(uses.map((u) => u.where))];
  // Only somewhere visitors can go: a draft is left out of the website, and so would be the links sent to it.
  const pages = state.site.pageOrder.filter((id) => Object.hasOwn(state.pages, id) && (state.pages[id].draft !== true || id === state.site.homePageId));
  const posts = Object.keys(state.collections)
    .sort()
    .flatMap((id) => orderedEntries(state.collections[id]).filter((x) => x.id !== target.entryId && x.draft === false));
  const confirm = async () => {
    const [kind, id] = [to.slice(0, to.indexOf(':')), to.slice(to.indexOf(':') + 1)];
    setBusy(true);
    const done = await deletePost(target, e.title, kind === 'entry' ? { replacementEntryId: id } : { replacementPageId: id });
    setBusy(false);
    if (done) onClose();
  };
  return (
    <Modal
      title="Delete this post?"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <span className="grow" />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-danger-fill" onClick={() => void confirm()} disabled={busy}>
            Delete post
          </button>
        </>
      }
    >
      <p>
        {uses.length ? (
          <>
            <strong>{e.title}</strong> is linked from {where.slice(0, 3).join(', ')}
            {where.length > 3 ? ' and more' : ''} ({uses.length === 1 ? 'one link' : `${uses.length} links`}).{' '}
          </>
        ) : (
          <>
            <strong>{e.title}</strong> has {kept === 1 ? 'an old address' : `${kept} old addresses`} kept working for visitors.{' '}
          </>
        )}
        {uses.length && kept ? 'Those links, and its old addresses kept working, go here instead:' : uses.length ? 'Those links go here instead:' : 'They go here instead:'}
      </p>
      <Field label="Send its links to" controlId={`${uid}-to`}>
        <select id={`${uid}-to`} className="select" value={to} onChange={(ev) => setTo(ev.target.value)}>
          <optgroup label="Pages">
            {pages.map((id) => (
                <option key={id} value={`page:${id}`}>
                  {state.pages[id].title} ({state.pages[id].route})
                </option>
              ))}
          </optgroup>
          {posts.length > 0 && (
            <optgroup label="Posts">
              {posts.map((p) => (
                <option key={p.id} value={`entry:${p.id}`}>
                  {p.title}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </Field>
      <p className="posts-note">You can undo it.</p>
    </Modal>
  );
}

/** The order the list was last shown in, for this window. */
let lastSort: PostSort = 'newest';

/**
 * The Posts panel: the blog's posts (or another collection's entries), found by their words and sorted by date or
 * title, each marked Draft or Published. Choosing one opens it in the writer beside the panel; New post asks for a
 * title and opens the new draft.
 */
export function PostsPanel() {
  const snap = useStore((s) => s.snapshot);
  const post = useStore((s) => s.post);
  const previewing = useStore((s) => s.postView === 'preview');
  const [query, setQuery] = useState('');
  const [sort, setSortState] = useState<PostSort>(lastSort);
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<PostRef | null>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const uid = useId();
  // A title typed for a new post is a change not made yet: Save and leaving the project say so.
  const newKey = `posts-new:${uid}`;
  useEffect(() => markDraft(newKey, adding && !!title.trim()), [newKey, adding, title]);
  useEffect(() => () => markDraft(newKey, false), [newKey]);
  const state = snap?.state;
  const collection = state ? postsCollection(state, collectionId ?? post?.collectionId) : undefined;
  const rows = useMemo(() => (collection ? postRows(collection, query, sort) : []), [collection, query, sort]);
  if (!snap || !state) return null;
  const all = collection ? Object.keys(collection.entries).length : 0;
  const collections = Object.values(state.collections ?? {});
  const language = state.site.language;
  const setSort = (s: PostSort) => {
    lastSort = s;
    setSortState(s);
  };

  /** Open a post, once the one being written is saved; never over text that could not be (the writer says why). */
  const open = async (entryId: string) => {
    if (!collection) return;
    if (post?.entryId === entryId && post.collectionId === collection.settings.id) return setState({ postView: 'write' });
    if (!(await openSaved())) return;
    setState({ post: { collectionId: collection.settings.id, entryId }, postView: 'write', postReveal: null });
  };

  const create = async () => {
    const t = title.trim();
    if (!t || busy) return;
    if (!(await openSaved())) return;
    const s = getState().snapshot;
    if (!s) return;
    const { ops, ref } = newPostOps(s.state, collection?.settings.id ?? null, t);
    setBusy(true);
    const r = await commitOps(ops, 'New post');
    setBusy(false);
    if (!r) return;
    setAdding(false);
    setTitle('');
    setQuery('');
    // Typed into the open post while the new one was made: saved first, or the new one waits in the list.
    if (!(await openSaved())) return;
    setState({ post: ref, postView: 'write', postReveal: null });
    // Straight into the text: the title is already written.
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.post-body')?.focus());
  };

  const duplicate = async (entryId: string) => {
    if (!collection) return;
    const ref = { collectionId: collection.settings.id, entryId };
    // The copy opens in the writer: whatever it holds is saved first (and the copy has the latest words of its own).
    if (!(await openSaved())) return;
    const s = getState().snapshot;
    const plan = s && duplicatePostOps(s.state, ref);
    if (!plan) return;
    const r = await commitOps(plan.ops, 'Duplicate post');
    if (!r || !(await openSaved())) return;
    setState({ post: plan.ref, postView: 'write', postReveal: null });
    toast(`Duplicated as a draft: “${postAt(getState().snapshot!.state, plan.ref)?.title ?? 'copy'}”`, 'info', r.entryId ? undoAction({ entryId: r.entryId, revision: r.revision, workspaceKey: r.workspaceKey }) : undefined);
  };

  /** Delete a post. One that is linked to asks where those links go instead (see DeletePostDialog). */
  const remove = async (entryId: string) => {
    if (!collection) return;
    const s = getState().snapshot;
    const e = s && postAt(s.state, { collectionId: collection.settings.id, entryId });
    if (!s || !e) return;
    // Text the open post could not save is part of it: dealt with first, so an Undo of the delete brings back all of it.
    if (post?.entryId === entryId && !(await openSaved())) return;
    if (entryLinkUses(s.state, entryId).length || keptAddresses(s.state, entryId)) return setDeleting({ collectionId: collection.settings.id, entryId });
    const ok = await confirmDialog({
      title: 'Delete this post?',
      body: 'The post and its text are removed from the project.',
      confirmLabel: 'Delete post',
      danger: true,
      icon: 'delete',
      subject: e.title,
      details: [{ kind: 'undo', text: 'You can undo it.' }]
    });
    if (ok) void deletePost({ collectionId: collection.settings.id, entryId }, e.title, {});
  };

  return (
    <div className="posts-panel">
      <div className="panel-head">
        <h3>{collection && collection.settings.id !== 'posts' ? collection.settings.name : 'Posts'}</h3>
        <button
          className="btn btn-sm btn-ghost posts-head-add"
          aria-expanded={adding}
          aria-controls={adding ? `${uid}-add` : undefined}
          onClick={() => {
            setAdding((a) => !a);
            requestAnimationFrame(() => addInput.current?.focus());
          }}
        >
          <Plus aria-hidden="true" /> New post
        </button>
      </div>
      {previewing && post && (
        <div className="posts-previewing" role="status">
          <span>Showing the post as visitors see it.</span>
          <button className="btn btn-sm btn-primary" onClick={() => setState({ postView: 'write' })}>
            <ArrowLeft aria-hidden="true" /> Back to writing
          </button>
        </div>
      )}
      {deleting && <DeletePostDialog target={deleting} onClose={() => setDeleting(null)} />}
      {collections.length > 1 && collection && (
        <div className="posts-collection">
          <select className="select sm" aria-label="Collection" value={collection.settings.id} onChange={(e) => setCollectionId(e.target.value)}>
            {collections
              .map((c) => c.settings)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </div>
      )}
      {adding && (
        <form
          id={`${uid}-add`}
          className="posts-add"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !isImeComposing(e)) {
              e.stopPropagation();
              setAdding(false);
              setTitle('');
            }
          }}
        >
          <input ref={addInput} className="input" placeholder="Post title" aria-label="New post title" maxLength={MAX_POST_TITLE} value={title} readOnly={busy} onChange={(e) => setTitle(e.target.value)} />
          <div className="posts-add-actions">
            <button type="submit" className="btn btn-sm btn-primary" disabled={!title.trim() || busy}>
              Create draft
            </button>
            <button type="button" className="btn btn-sm" onClick={() => (setAdding(false), setTitle(''))}>
              Cancel
            </button>
          </div>
          {!collection && <p className="posts-note">Posts are published under /blog/, with categories and tags ready to use.</p>}
        </form>
      )}
      {all > 0 && (
        <div className="posts-tools">
          <div className={`search posts-find${query ? ' has-query' : ''}`}>
            <Search aria-hidden="true" />
            <input
              ref={findInput}
              className="input"
              placeholder={`Find among ${all} ${all === 1 ? 'post' : 'posts'}`}
              aria-label="Find a post by title, address, author or excerpt"
              value={query}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query && !isImeComposing(e)) (e.stopPropagation(), setQuery(''));
              }}
            />
            {query && (
              <button className="icon-btn sm" aria-label="Clear find" title="Clear (Esc)" onClick={() => (setQuery(''), findInput.current?.focus())}>
                <X />
              </button>
            )}
          </div>
          <select className="select sm posts-sort" aria-label="Sort posts" value={sort} onChange={(e) => setSort(e.target.value as PostSort)}>
            {POST_SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {query.trim() ? (rows.length ? `${rows.length} of ${all} posts` : 'No post matches') : ''}
      </span>
      <div className="panel-body">
        {!all && !adding && (
          <div className="posts-empty">
            <Newspaper aria-hidden="true" />
            <p>Write articles, news and updates. Each post gets its own page on the site, in the site’s header and footer.</p>
            <button className="btn btn-sm btn-primary" onClick={() => (setAdding(true), requestAnimationFrame(() => addInput.current?.focus()))}>
              <Plus aria-hidden="true" /> Write the first post
            </button>
          </div>
        )}
        {query.trim() && !rows.length && <p className="posts-note">No post has “{query.trim()}” in its title, address, author or excerpt.</p>}
        <ul className="posts-list" aria-label="Posts">
          {rows.map((r) => {
            const current = post?.entryId === r.id;
            return (
              <li key={r.id} className={`post-row${current ? ' current' : ''}`} data-post={r.id}>
                <button className="post-open" aria-current={current || undefined} onClick={() => void open(r.id)} title={r.route}>
                  <span className="post-title ellipsis">{r.title}</span>
                  <span className="post-meta">
                    <span className={`badge ${r.draft ? 'amber' : 'green'} post-status`}>{r.draft ? 'Draft' : 'Published'}</span>
                    <time dateTime={r.date}>{formatArticleDate(r.date, language)}</time>
                  </span>
                </button>
                <span className="post-actions">
                  <button className="icon-btn sm" aria-label={`Duplicate “${r.title}”`} title="Duplicate as a new draft" onClick={() => void duplicate(r.id)}>
                    <Copy />
                  </button>
                  <button className="icon-btn sm" aria-label={`Delete “${r.title}”`} title="Delete post" onClick={() => void remove(r.id)}>
                    <Trash2 />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
