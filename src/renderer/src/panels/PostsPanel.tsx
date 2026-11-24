import { useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Copy, Newspaper, Plus, Search, Trash2, X } from 'lucide-react';
import { formatArticleDate } from '@shared/articles';
import { entryLinkUses } from '@engine/page-links';
import { commitOps, confirmDialog, getState, setState, toast, undoAction, useStore } from '../store';
import { isImeComposing } from '../lib/ime';
import { POST_SORTS, duplicatePostOps, newPostOps, postAt, postRows, postsCollection, MAX_POST_TITLE, type PostSort } from '../lib/posts';
import { flushOpenPost } from '../lib/post-draft';

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
  const findInput = useRef<HTMLInputElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const uid = useId();
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

  /** Open a post, once the one being written is saved (or kept, if it cannot be yet). */
  const open = async (entryId: string) => {
    if (!collection) return;
    if (post?.entryId === entryId && post.collectionId === collection.settings.id) return setState({ postView: 'write' });
    await flushOpenPost();
    setState({ post: { collectionId: collection.settings.id, entryId }, postView: 'write', postReveal: null });
  };

  const create = async () => {
    const t = title.trim();
    if (!t || busy) return;
    await flushOpenPost();
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
    setState({ post: ref, postView: 'write', postReveal: null });
    // Straight into the text: the title is already written.
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.post-body')?.focus());
  };

  const duplicate = async (entryId: string) => {
    if (!collection) return;
    const ref = { collectionId: collection.settings.id, entryId };
    if (post?.entryId === entryId) await flushOpenPost();
    const s = getState().snapshot;
    const plan = s && duplicatePostOps(s.state, ref);
    if (!plan) return;
    const r = await commitOps(plan.ops, 'Duplicate post');
    if (!r) return;
    setState({ post: plan.ref, postView: 'write', postReveal: null });
    toast(`Duplicated as a draft: “${postAt(getState().snapshot!.state, plan.ref)?.title ?? 'copy'}”`, 'info', r.entryId ? undoAction({ entryId: r.entryId, revision: r.revision, workspaceKey: r.workspaceKey }) : undefined);
  };

  const remove = async (entryId: string) => {
    if (!collection) return;
    const s = getState().snapshot;
    const e = s && postAt(s.state, { collectionId: collection.settings.id, entryId });
    if (!s || !e) return;
    const uses = entryLinkUses(s.state, entryId);
    const home = s.state.pages[s.state.site.homePageId];
    const ok = await confirmDialog({
      title: 'Delete this post?',
      body: uses.length ? `${uses.length === 1 ? 'One link on the site goes' : `${uses.length} links on the site go`} to this post. They will go to the ${home?.title ?? 'Home'} page instead.` : 'The post and its text are removed from the project.',
      confirmLabel: 'Delete post',
      danger: true,
      icon: 'delete',
      subject: e.title,
      details: [
        ...(uses.length ? [{ kind: 'risk' as const, text: `Linked from ${[...new Set(uses.map((u) => u.where))].slice(0, 3).join(', ')}${uses.length > 3 ? ' and more' : ''}.` }] : []),
        { kind: 'undo', text: 'You can undo it.' }
      ]
    });
    if (!ok) return;
    if (post?.entryId === entryId) setState({ post: null, postView: 'write' });
    const r = await commitOps([{ type: 'entry.remove', collectionId: collection.settings.id, entryId, ...(uses.length && home ? { replacementPageId: home.id } : {}) }], 'Delete post');
    if (r) toast(`Deleted “${e.title}”`, 'info', r.entryId ? undoAction({ entryId: r.entryId, revision: r.revision, workspaceKey: r.workspaceKey }) : undefined);
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
