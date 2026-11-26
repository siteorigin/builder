import './PostsPanel.css';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Copy, FileDown, LayoutTemplate, Library, Newspaper, Plug, Plus, Search, Settings2, Tags, Trash2, X } from 'lucide-react';
import { formatArticleDate } from '@shared/articles';
import { entryLinkUses } from '@engine/page-links';
import { api, commitOps, confirmDialog, getState, markDraft, setState, toast, undoAction, useStore } from '../store';
import { headerMenu as findHeaderMenu } from '@engine/tree';
import { Field, Modal, Segmented, useMenu, type MenuItem } from '../components/ui';
import { reviewPostImport } from './PostImportReview';
import type { PostImportKind } from '@shared/api';
import { isImeComposing } from '../lib/ime';
import { POST_SORTS, POST_STATUSES, duplicatePostOps, newPostOps, postAt, postCounts, postRows, postsCollection, MAX_POST_TITLE, type PostRef, type PostSort, type PostStatus } from '../lib/posts';
import { TermsManager, postTaxonomies, termsManagerTitle, termsOf } from './PostTerms';
import { CollectionSchemaDialog } from './CollectionSchemaDialog';
import { SourceDialog } from './SourceDialog';
import { detachOps, sourceOfCollection, syncSummary } from '../lib/sources';
import { sourceFingerprint } from '@shared/sources';
import { STARTER_COLLECTIONS, contentRows, customCollectionOps, entryNoun, entryNounLower, isReadOnlyCollection, starterCollectionOps } from '../lib/content';
import { openLayout } from '../lib/actions';
import type { EditOperation } from '@shared/ops';
import { POSTS_COLLECTION_ID, collectionKind, findEntry, hasDetailPages, orderedEntries } from '@shared/collections';
import type { CollectionKind, ProjectState } from '@shared/types';
import { saveOpenPost } from '../lib/post-draft';

/**
 * Save the post open in the writer before another takes its place. False, said in a notice, when its text could not
 * be saved: the writer keeps it, with what to do about it above the text.
 */
async function openSaved(): Promise<boolean> {
  // Its fields as well as its text (#675): a record's form may hold a value that could not be saved.
  if (await saveOpenPost()) return true;
  toast('The entry you are writing has a change that is not saved yet. See the note beside it.', 'error');
  return false;
}

/** How many old addresses of a post are kept working, sending visitors on to it. */
function keptAddresses(state: ProjectState, entryId: string): number {
  const kept: unknown = state.site.redirects;
  return Array.isArray(kept) ? kept.filter((r) => (r as { entryId?: unknown })?.entryId === entryId).length : 0;
}

/** Remove a post, letting go of it in the writer only once it is gone. */
async function deletePost(ref: PostRef, title: string, replacement: { replacementPageId?: string; replacementEntryId?: string }, revision: number): Promise<boolean> {
  // Against the project as it was checked: a link or address added meanwhile, or a destination become a draft, means
  // looking again. The writer lets go of the post itself once it is gone, keeping anything typed meanwhile.
  const ops = [{ type: 'entry.remove' as const, collectionId: ref.collectionId, entryId: ref.entryId, ...replacement }];
  let r = await commitOps(ops, 'Delete post', undefined, revision, { replanStale: true });
  // Only moved on (a save landing): sent again if what was checked still holds — the same links and old addresses.
  if (r && !r.ok) {
    const was = getState().snapshot;
    const now = await api.project.snapshot().catch(() => null);
    const same = (s: typeof now) => (s ? `${entryLinkUses(s.state, ref.entryId).length}/${keptAddresses(s.state, ref.entryId)}` : '');
    r = now && was && same(now) === same(was) ? await commitOps(ops, 'Delete post', undefined, now.revision) : null;
    if (!r && now) toast('Something now links to this post. Delete it again to choose where those links go.', 'error');
  }
  if (!r?.ok) return false;
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
  const noun = entryNounLower(state.collections[target.collectionId]);
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
    // Checked again now: a destination that has become a draft (or gone) since it was chosen is chosen again.
    const now = getState().snapshot;
    if (!now) return;
    const live = kind === 'entry' ? findEntry(now.state, id)?.entry.draft === false : Object.hasOwn(now.state.pages, id) && (now.state.pages[id].draft !== true || id === now.state.site.homePageId);
    if (!live) return toast('That destination is no longer on the website. Choose another.', 'error');
    setBusy(true);
    const done = await deletePost(target, e.title, kind === 'entry' ? { replacementEntryId: id } : { replacementPageId: id }, now.revision);
    setBusy(false);
    if (done) onClose();
  };
  return (
    <Modal
      title={`Delete this ${noun}?`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <span className="grow" />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-danger-fill" onClick={() => void confirm()} disabled={busy}>
            Delete {noun}
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

/** Starters and a collection of the author's own, offered with no collection yet and from Add a collection. */
function AddCollection({ state, onMade, onCancel }: { state: ProjectState; onMade: (collectionId: string) => void; onCancel?: () => void }) {
  const uid = useId();
  const [custom, setCustom] = useState(false);
  const [name, setName] = useState('');
  const [singular, setSingular] = useState('');
  const [kind, setKind] = useState<CollectionKind>('structured');
  const [pages, setPages] = useState(false);
  const [busy, setBusy] = useState(false);
  // A blog is offered a link in the header menu, as a new page is: ticked, while the header has a menu to take it.
  const [toMenu, setToMenu] = useState(true);
  const make = async (plan: { ops: EditOperation[]; collectionId: string } | null, label: string) => {
    if (!plan || busy) return;
    setBusy(true);
    const r = await commitOps(plan.ops, label);
    setBusy(false);
    if (!r?.ok) return;
    const asked = plan.ops.some((o) => o.type === 'collection.create' && o.addToNavigation);
    const made = r.results?.find((x, i) => plan.ops[i]?.type === 'collection.create');
    if (asked && made?.addedToNavigation === false) toast('Added the blog. Its link could not join the header menu, which has no room for another: make room there, then link one to the Posts index.', 'info');
    onMade(plan.collectionId);
  };
  const starters = STARTER_COLLECTIONS.filter((c) => c.id !== POSTS_COLLECTION_ID || !Object.hasOwn(state.collections, POSTS_COLLECTION_ID));
  const offersBlog = starters.some((c) => c.id === POSTS_COLLECTION_ID) && !!findHeaderMenu(state);
  /** The starter's operations, the blog's with the header link when it is asked for. */
  const starterPlan = (id: string) => {
    const plan = starterCollectionOps(getState().snapshot!.state, id);
    if (!plan || id !== POSTS_COLLECTION_ID || !offersBlog || !toMenu) return plan;
    return { ...plan, ops: plan.ops.map((o) => (o.type === 'collection.create' ? { ...o, addToNavigation: true } : o)) };
  };
  if (custom)
    return (
      <form
        className="content-custom"
        aria-label="New collection"
        onSubmit={(e) => {
          e.preventDefault();
          const now = getState().snapshot?.state;
          if (now && name.trim()) void make(customCollectionOps(now, { name, singularName: singular, kind, pages }), `Add the ${name.trim()} collection`);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !isImeComposing(e)) (e.stopPropagation(), setCustom(false));
        }}
      >
        <Field label="Name" controlId={`${uid}-name`}>
          <input id={`${uid}-name`} className="input" autoFocus maxLength={80} placeholder="Events" value={name} readOnly={busy} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="One entry is called" controlId={`${uid}-one`}>
          <input id={`${uid}-one`} className="input" maxLength={80} placeholder="Event" value={singular} readOnly={busy} onChange={(e) => setSingular(e.target.value)} />
        </Field>
        <Segmented<CollectionKind>
          radio
          full
          label="Kind"
          value={kind}
          onChange={(k) => (setKind(k), k === 'editorial' && setPages(true))}
          options={[
            { value: 'structured', label: 'Records', title: 'Entries made of fields, such as people, products or events' },
            { value: 'editorial', label: 'Articles', title: 'Dated pieces written in a distraction-free editor' }
          ]}
        />
        <label className="content-check">
          <input type="checkbox" checked={pages} disabled={kind === 'editorial'} onChange={(e) => setPages(e.target.checked)} /> A page for each entry, and one listing them all
        </label>
        <div className="posts-add-actions">
          <button type="submit" className="btn btn-sm btn-primary" disabled={!name.trim() || busy}>
            Create collection
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setCustom(false)}>
            Back
          </button>
        </div>
      </form>
    );
  return (
    <div className="content-add" role="group" aria-label="Add a collection">
      <ul className="content-starters">
        {starters.map((c) => (
          <li key={c.id}>
            <button className="content-starter" disabled={busy} data-starter={c.id} onClick={() => void make(starterPlan(c.id), `Add the ${c.name} collection`)}>
              <strong>{c.label}</strong>
              <span>{c.description}</span>
            </button>
          </li>
        ))}
        <li>
          <button className="content-starter" disabled={busy} onClick={() => setCustom(true)}>
            <strong>Custom collection…</strong>
            <span>Name it, then add the fields each entry fills in.</span>
          </button>
        </li>
      </ul>
      {offersBlog && (
        <label className="content-check">
          <input type="checkbox" checked={toMenu} disabled={busy} onChange={(e) => setToMenu(e.target.checked)} /> Add a Blog link to the header menu
        </label>
      )}
      {onCancel && (
        <button className="btn btn-sm btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}

/**
 * The Content panel (#675): the project's collections (a blog, a team, projects…), each with its entries found by their
 * words and sorted by date or title, each marked Draft or Published. Choosing one opens it in the writer beside the
 * panel; New <entry> asks for a title and opens the new draft. With no collection yet, it offers ready-made ones.
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
  const [reading, setReading] = useState(false);
  const [status, setStatus] = useState<PostStatus>('all');
  const [category, setCategory] = useState('');
  const [managing, setManaging] = useState(false);
  const [schema, setSchema] = useState<string | null>(null);
  const [addingCollection, setAddingCollection] = useState(false);
  /** The collection whose external source is being connected or changed. */
  const [connecting, setConnecting] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const sourceMenu = useMenu();
  /** The collection the new-entry form was opened for: what it creates in, whatever the list shows by then. */
  const addTarget = useRef<{ collectionId: string; workspaceKey: string | undefined } | null>(null);
  /** Counts each choice of what the panel shows, so one still saving the open entry never undoes a later one. */
  const navigation = useRef(0);
  const creating = useRef(false);
  const importMenu = useMenu();
  const findInput = useRef<HTMLInputElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const uid = useId();
  // A title typed for a new post is a change not made yet: Save and leaving the project say so.
  const newKey = `posts-new:${uid}`;
  useEffect(() => markDraft(newKey, adding && !!title.trim()), [newKey, adding, title]);
  useEffect(() => () => markDraft(newKey, false), [newKey]);
  // An entry opened from elsewhere (the SEO view, Assets, an import) shows its own collection's list.
  useEffect(() => {
    if (post?.collectionId) setCollectionId(post.collectionId);
  }, [post?.collectionId]);
  const state = snap?.state;
  const collection = state ? postsCollection(state, collectionId ?? post?.collectionId) : undefined;
  const categories = termsOf(collection, 'categories');
  // A category renamed, deleted or undone away, or one of another collection, filters nothing.
  const categoryId = categories.some((c) => c.id === category) ? category : '';
  // Forgotten once gone (deleted, undone away), so a later category given the same address is never chosen on its own;
  // one renamed to is kept while the project's copy with it is on its way.
  const known = useRef<Set<string>>(new Set());
  useEffect(() => {
    const ids = new Set(categories.map((c) => c.id));
    if (category && !ids.has(category) && known.current.has(category)) setCategory('');
    known.current = ids;
  });
  const rows = useMemo(() => (collection ? postRows(collection, query, sort, { status, category: categoryId }) : []), [collection, query, sort, status, categoryId]);
  if (!snap || !state) return null;
  const all = collection ? Object.keys(collection.entries).length : 0;
  const counts = collection ? postCounts(collection) : { all: 0, published: 0, drafts: 0 };
  const filtered = !!query.trim() || status !== 'all' || !!categoryId;
  const collections = contentRows(state);
  const language = state.site.language;
  const isBlog = collection?.settings.id === POSTS_COLLECTION_ID;
  const noun = entryNounLower(collection);
  // "posts" for a blog's entries, "entries" for anything else's, where a count is said.
  const plural = (n: number) => (n === 1 ? noun : isBlog || collectionKind(collection?.settings) === 'editorial' ? `${noun}s` : 'entries');
  const readOnly = isReadOnlyCollection(collection);
  // What the new-entry form makes, named as the collection it was opened for, whichever the list shows by now.
  const formTarget = addTarget.current && Object.hasOwn(state.collections, addTarget.current.collectionId) ? state.collections[addTarget.current.collectionId] : collection;
  const dated = collectionKind(collection?.settings) === 'editorial';
  const groupings = collection ? postTaxonomies(collection) : [];
  const canImport = !collection || isBlog;
  const setSort = (s: PostSort) => {
    lastSort = s;
    setSortState(s);
  };

  /** Show another collection's entries, once the entry being written is saved; the writer lets go of it. */
  const choose = async (id: string) => {
    // Choosing the one shown is a choice too: a switch still saving the open entry gives way to it.
    const seq = ++navigation.current;
    if (id === collection?.settings.id) return;
    const workspaceKey = getState().snapshot?.workspaceKey;
    if (post && post.collectionId !== id) {
      if (!(await openSaved())) return;
      // Something else chosen meanwhile, or another project opened: that choice stands.
      if (seq !== navigation.current || getState().snapshot?.workspaceKey !== workspaceKey) return;
      setState({ post: null, postView: 'write', postReveal: null });
    }
    setCollectionId(id);
    setCategory('');
    setStatus('all');
    setQuery('');
    setAdding(false);
    setTitle('');
  };
  const made = (id: string) => {
    setAddingCollection(false);
    void choose(id);
  };

  /** Open a post, once the one being written is saved; never over text that could not be (the writer says why). */
  const open = async (entryId: string) => {
    if (!collection) return;
    const seq = ++navigation.current;
    if (post?.entryId === entryId && post.collectionId === collection.settings.id) return setState({ postView: 'write' });
    const workspaceKey = getState().snapshot?.workspaceKey;
    if (!(await openSaved())) return;
    if (seq !== navigation.current || getState().snapshot?.workspaceKey !== workspaceKey) return;
    setState({ post: { collectionId: collection.settings.id, entryId }, postView: 'write', postReveal: null });
  };

  const create = async () => {
    const t = title.trim();
    const to = addTarget.current;
    if (!t || busy || creating.current || !to) return;
    // One at a time: a second press while the open entry saves makes no second draft.
    creating.current = true;
    try {
      await createIn(to, t);
    } finally {
      creating.current = false;
    }
  };
  const createIn = async (to: { collectionId: string; workspaceKey: string | undefined }, t: string) => {
    // Creating opens the new entry: a choice made while it saves (another collection, another entry) wins over that.
    const seq = ++navigation.current;
    if (!(await openSaved())) return;
    const s = getState().snapshot;
    if (!s) return;
    const target = to.collectionId;
    // Only ever into the collection it was typed for: one gone meanwhile (an Undo), or another project, keeps the title.
    if (s.workspaceKey !== to.workspaceKey || !Object.hasOwn(s.state.collections, target)) return void toast('The collection this was typed for is no longer in the project.', 'error');
    const { ops, ref } = newPostOps(s.state, target, t);
    setBusy(true);
    const r = await commitOps(ops, `New ${noun}`);
    setBusy(false);
    if (!r) return;
    setAdding(false);
    setTitle('');
    setQuery('');
    // Typed into the open post while the new one was made: saved first, or the new one waits in the list.
    if (!(await openSaved()) || seq !== navigation.current) return;
    setState({ post: ref, postView: 'write', postReveal: null });
    // Straight into the text, or the first field of a record without any: the title is already written.
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.post-body, .entry-values input, .entry-values textarea, .entry-values select')?.focus());
  };

  const duplicate = async (entryId: string) => {
    if (!collection) return;
    const ref = { collectionId: collection.settings.id, entryId };
    // The copy opens in the writer: whatever it holds is saved first (and the copy has the latest words of its own).
    if (!(await openSaved())) return;
    const s = getState().snapshot;
    const plan = s && duplicatePostOps(s.state, ref);
    if (!plan) return;
    const r = await commitOps(plan.ops, `Duplicate ${noun}`);
    if (!r || !(await openSaved())) return;
    setState({ post: plan.ref, postView: 'write', postReveal: null });
    toast(`Duplicated as a draft: “${postAt(getState().snapshot!.state, plan.ref)?.title ?? 'copy'}”`, 'info', r.entryId ? undoAction({ entryId: r.entryId, revision: r.revision, workspaceKey: r.workspaceKey }) : undefined);
  };

  /** Read a WordPress export or a folder of Markdown posts, once the post being written is saved, and review it. */
  const importFrom = async (kind: PostImportKind) => {
    if (reading || !(await openSaved())) return;
    setReading(true);
    try {
      await reviewPostImport(kind);
    } finally {
      setReading(false);
    }
  };
  const importItems: MenuItem[] = [
    { heading: 'Import posts from' },
    { label: 'WordPress export (.xml)…', description: 'In WordPress: Tools → Export. Put the site’s uploads folder beside it for its pictures.', onSelect: () => void importFrom('wordpress') },
    { label: 'Folder of Markdown posts…', description: 'Jekyll, Hugo, Eleventy or Astro posts, with their pictures.', onSelect: () => void importFrom('markdown') }
  ];
  const openImport = (el: HTMLElement) => importMenu.openAt(el, importItems, 'Import posts');

  /** Sync a collection's source now, and say what changed. */
  const syncNow = async (sourceId: string, name: string) => {
    if (syncing) return;
    setSyncing(true);
    const r = await api.project.syncSource(sourceId, snap.workspaceKey).catch((e: Error) => ({ ok: false as const, message: e.message }));
    setSyncing(false);
    toast(r.ok ? syncSummary(name, r) : r.message, r.ok ? 'info' : 'error');
  };

  /** Detach a collection from its source: its entries become local ones, and the source's settings go. */
  const detach = async (collectionId: string) => {
    const was = getState().snapshot;
    const now = was?.state;
    const c = now && Object.hasOwn(now.collections, collectionId) ? now.collections[collectionId] : undefined;
    const source = now && sourceOfCollection(now, collectionId);
    if (!was || !now || !c || (!source && c.settings.sourceId === undefined)) return;
    const ok = await confirmDialog({
      title: 'Detach to local collection?',
      body: source
        ? `Its entries stay as they are and become ones you edit here. “${source.name}” and its settings are removed, so changes made in the source no longer reach them.`
        : 'Its entries stay as they are and become ones you edit here. The source its settings named is no longer in the project.',
      confirmLabel: 'Detach',
      tone: 'caution',
      icon: 'unlock',
      subject: c.settings.name,
      details: [{ kind: 'undo', text: 'You can undo it.' }]
    });
    if (!ok) return;
    // Only what was asked about: the same project, and the same source.
    const fresh = getState().snapshot;
    if (!fresh || fresh.workspaceKey !== was.workspaceKey) return;
    const cNow = Object.hasOwn(fresh.state.collections, collectionId) ? fresh.state.collections[collectionId] : undefined;
    if (sourceFingerprint(sourceOfCollection(fresh.state, collectionId)) !== sourceFingerprint(source) || cNow?.settings.sourceId !== c.settings.sourceId)
      return toast('The collection’s source changed meanwhile. Look at it again before detaching it.', 'error');
    const r = await commitOps(detachOps(fresh.state, collectionId), source ? `Detach ${c.settings.name} from “${source.name}”` : `Detach ${c.settings.name}`, undefined, fresh.revision);
    if (r?.ok) toast(`${c.settings.name} is a local collection now: its entries are edited here.`, 'info', r.entryId ? undoAction({ entryId: r.entryId, revision: r.revision, workspaceKey: r.workspaceKey }) : undefined);
  };

  /** What can be done with a collection's external source. */
  const openSourceMenu = (el: HTMLElement, collectionId: string) => {
    const c = state.collections[collectionId];
    const source = sourceOfCollection(state, collectionId);
    // Synced from a source the project has no settings for: it can only be detached.
    const orphan = !source && c.settings.sourceId !== undefined;
    const items: MenuItem[] = orphan
      ? [{ label: 'Detach to local collection', description: 'Its source is no longer in the project. Keep its entries here, to edit them in the app.', onSelect: () => void detach(collectionId) }]
      : source
      ? [
          { heading: source.name },
          { label: syncing ? 'Syncing…' : 'Sync now', description: 'Bring in what changed in the source.', disabled: syncing, onSelect: () => void syncNow(source.id, source.name) },
          { label: 'Source settings…', onSelect: () => setConnecting(collectionId) },
          { label: 'Detach to local collection', description: 'Keep its entries here, to edit them in the app.', onSelect: () => void detach(collectionId) }
        ]
      : [
          {
            label: 'Connect external source…',
            description: Object.keys(c.entries).length ? 'Only an empty collection can be connected: its first sync brings in every entry.' : 'Sync its entries from a CMS or an API.',
            disabled: Object.keys(c.entries).length > 0,
            onSelect: () => setConnecting(collectionId)
          }
        ];
    sourceMenu.openAt(el, items, 'External source');
  };

  /** The layout every entry's page is shown with, on the canvas, once the entry being written is saved. */
  const editLayout = async (id: string) => {
    if (!(await saveOpenPost())) return;
    openLayout(id, post?.collectionId === id ? post.entryId : undefined);
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
      title: `Delete this ${noun}?`,
      body: `The ${noun} and everything it holds are removed from the project.`,
      confirmLabel: `Delete ${noun}`,
      danger: true,
      icon: 'delete',
      subject: e.title,
      details: [{ kind: 'undo', text: 'You can undo it.' }]
    });
    if (!ok) return;
    // Linked to or given an old address while the question was open: where those go is asked first.
    const now = getState().snapshot;
    if (!now) return;
    if (entryLinkUses(now.state, entryId).length || keptAddresses(now.state, entryId)) return setDeleting({ collectionId: collection.settings.id, entryId });
    void deletePost({ collectionId: collection.settings.id, entryId }, e.title, {}, now.revision);
  };

  const importButton = canImport && (
    <button className="btn btn-sm btn-ghost" aria-haspopup="menu" aria-expanded="false" data-testid="posts-import" disabled={reading} onClick={(e) => openImport(e.currentTarget)}>
      <FileDown aria-hidden="true" /> {reading ? 'Reading…' : 'Import…'}
    </button>
  );

  // No collection yet: what the project can keep, one click each.
  if (!collection)
    return (
      <div className="posts-panel">
        <div className="panel-head">
          <h3>Content</h3>
          {importButton}
          {importMenu.node}
        </div>
        <div className="panel-body">
          <div className="posts-empty content-empty">
            <Library aria-hidden="true" />
            <p>Keep collections of things the site shows: articles, people, projects or what clients say. Each starts with the fields it needs.</p>
            <AddCollection state={state} onMade={made} />
          </div>
        </div>
      </div>
    );

  return (
    <div className="posts-panel">
      <div className="panel-head">
        <h3 className="ellipsis">{isBlog ? 'Posts' : collection.settings.name}</h3>
        {readOnly ? (
          <span className="badge" title="Its entries are synced from an external source, so they are changed there, not here.">
            Read-only
          </span>
        ) : (
          <button
            className="btn btn-sm btn-ghost posts-head-add"
            aria-expanded={adding}
            aria-controls={adding ? `${uid}-add` : undefined}
            onClick={() => {
              addTarget.current = { collectionId: collection.settings.id, workspaceKey: snap.workspaceKey };
              setAdding((a) => !a);
              requestAnimationFrame(() => addInput.current?.focus());
            }}
          >
            <Plus aria-hidden="true" /> New {noun}
          </button>
        )}
        {!readOnly && importButton}
        {importMenu.node}
      </div>
      <ul className="content-collections" aria-label="Collections">
        {collections.map((c) => {
          const current = c.id === collection.settings.id;
          return (
            <li key={c.id} className={`content-collection${current ? ' current' : ''}`}>
              <button className="content-collection-open" aria-current={current || undefined} data-collection={c.id} onClick={() => void choose(c.id)}>
                <span className="ellipsis">{c.name}</span>
                <span className="content-count" aria-label={`${c.count} ${c.count === 1 ? 'entry' : 'entries'}`}>
                  {c.count}
                </span>
              </button>
              {current && (
                <span className="content-collection-actions">
                  <button className="icon-btn sm" aria-label={`${c.name} settings`} title="Fields, groupings and pages" data-testid={`collection-settings-${c.id}`} onClick={() => void openSaved().then((ok) => ok && setSchema(c.id))}>
                    <Settings2 />
                  </button>
                  <button className="icon-btn sm" aria-label={`${c.name} external source`} aria-haspopup="menu" aria-expanded="false" title="Sync from a CMS or an API" data-testid={`collection-source-${c.id}`} onClick={(e) => openSourceMenu(e.currentTarget, c.id)}>
                    <Plug />
                  </button>
                  <button
                    className="icon-btn sm"
                    aria-label={`Edit the ${c.name} layout`}
                    title={hasDetailPages(collection.settings) ? 'The layout every entry’s page is shown with' : 'Its entries have no pages: turn them on in its settings'}
                    disabled={!hasDetailPages(collection.settings)}
                    onClick={() => void editLayout(c.id)}
                  >
                    <LayoutTemplate />
                  </button>
                </span>
              )}
            </li>
          );
        })}
        <li>
          <button className="btn btn-sm btn-ghost content-collection-add" aria-expanded={addingCollection} onClick={() => setAddingCollection((a) => !a)}>
            <Plus aria-hidden="true" /> Add a collection
          </button>
        </li>
      </ul>
      {addingCollection && <AddCollection state={state} onMade={made} onCancel={() => setAddingCollection(false)} />}
      {schema && <CollectionSchemaDialog collectionId={schema} onClose={() => setSchema(null)} />}
      {connecting && <SourceDialog collectionId={connecting} onClose={() => setConnecting(null)} />}
      {sourceMenu.node}
      {managing && <TermsManager collectionId={collection.settings.id} onClose={() => setManaging(false)} onRenamed={(tax, from, to) => tax === 'categories' && category === from && setCategory(to)} />}
      {previewing && post && (
        <div className="posts-previewing" role="status">
          <span>Showing the {entryNounLower(state.collections[post.collectionId])} as visitors see it.</span>
          <button className="btn btn-sm btn-primary" onClick={() => setState({ postView: 'write' })}>
            <ArrowLeft aria-hidden="true" /> Back to writing
          </button>
        </div>
      )}
      {deleting && <DeletePostDialog target={deleting} onClose={() => setDeleting(null)} />}
      {adding && !readOnly && (
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
          {formTarget && formTarget !== collection && <p className="posts-note">New {entryNounLower(formTarget)} in {formTarget.settings.name}</p>}
          <input ref={addInput} className="input" placeholder={collectionKind(formTarget?.settings) === 'editorial' ? `${entryNoun(formTarget)} title` : 'Name or title'} aria-label={`New ${entryNounLower(formTarget)} title`} maxLength={MAX_POST_TITLE} value={title} readOnly={busy} onChange={(e) => setTitle(e.target.value)} />
          <div className="posts-add-actions">
            <button type="submit" className="btn btn-sm btn-primary" disabled={!title.trim() || busy}>
              Create draft
            </button>
            <button type="button" className="btn btn-sm" onClick={() => (setAdding(false), setTitle(''))}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {all > 0 && (
        <div className="posts-tools">
          <div className={`search posts-find${query ? ' has-query' : ''}`}>
            <Search aria-hidden="true" />
            <input
              ref={findInput}
              className="input"
              placeholder={`Find among ${all} ${plural(all)}`}
              aria-label={`Find ${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun} by title, address, author or excerpt`}
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
          <select className="select sm posts-sort" aria-label={`Sort ${plural(2)}`} value={sort} onChange={(e) => setSort(e.target.value as PostSort)}>
            {POST_SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {all > 0 && (
        <div className="posts-filters">
          <Segmented radio label={`Show ${plural(2)}`} value={status} onChange={setStatus} options={POST_STATUSES.map((s) => ({ value: s.id, label: `${s.label} ${counts[s.id]}` }))} />
          {categories.length > 0 && (
            <select className="select sm posts-category" aria-label="Filter by category" value={categoryId} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          {groupings.length > 0 && !readOnly && (
            <button className="btn btn-sm btn-ghost posts-terms" aria-haspopup="dialog" title={`Add, rename or delete ${termsManagerTitle(collection).toLowerCase()}`} onClick={() => setManaging(true)}>
              <Tags aria-hidden="true" /> {termsManagerTitle(collection)}
            </button>
          )}
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {filtered ? (rows.length ? `${rows.length} of ${all} ${plural(all)}` : `No ${noun} matches`) : ''}
      </span>
      <div className="panel-body">
        {!all && !adding && (
          <div className="posts-empty">
            <Newspaper aria-hidden="true" />
            <p>{isBlog ? 'Write articles, news and updates. Each post gets its own page on the site, in the site’s header and footer.' : `${collection.settings.name} has no entries yet.`}</p>
            {!readOnly && (
              <button className="btn btn-sm btn-primary" onClick={() => ((addTarget.current = { collectionId: collection.settings.id, workspaceKey: snap.workspaceKey }), setAdding(true), requestAnimationFrame(() => addInput.current?.focus()))}>
                <Plus aria-hidden="true" /> {isBlog ? 'Write the first post' : `Add the first ${noun}`}
              </button>
            )}
            {canImport && !readOnly && (
              <button className="btn btn-sm" aria-haspopup="menu" aria-expanded="false" disabled={reading} onClick={(e) => openImport(e.currentTarget)}>
                <FileDown aria-hidden="true" /> Import posts…
              </button>
            )}
            {groupings.length > 0 && !readOnly && (
              <button className="btn btn-sm btn-ghost" aria-haspopup="dialog" title={`Add, rename or delete ${termsManagerTitle(collection).toLowerCase()}`} onClick={() => setManaging(true)}>
                <Tags aria-hidden="true" /> {termsManagerTitle(collection)}
              </button>
            )}
          </div>
        )}
        {all > 0 && filtered && !rows.length && (
          <p className="posts-note">
            {query.trim() && status === 'all' && !categoryId ? `No ${noun} has “${query.trim()}” in its title, address, author or excerpt.` : `No ${noun} matches these filters.`}{' '}
            {(status !== 'all' || categoryId) && (
              <button className="link-btn" onClick={() => (setStatus('all'), setCategory(''), setQuery(''))}>
                Show all {plural(2)}
              </button>
            )}
          </p>
        )}
        <ul className="posts-list" aria-label={isBlog ? 'Posts' : collection.settings.name}>
          {rows.map((r) => {
            const current = post?.entryId === r.id;
            return (
              <li key={r.id} className={`post-row${current ? ' current' : ''}`} data-post={r.id}>
                <button className="post-open" aria-current={current || undefined} onClick={() => void open(r.id)} title={r.route || r.title}>
                  <span className="post-title ellipsis">{r.title}</span>
                  <span className="post-meta">
                    <span className={`badge ${r.draft ? 'amber' : 'green'} post-status`}>{r.draft ? 'Draft' : 'Published'}</span>
                    {dated && <time dateTime={r.date}>{formatArticleDate(r.date, language)}</time>}
                  </span>
                </button>
                {!readOnly && (
                  <span className="post-actions">
                    <button className="icon-btn sm" aria-label={`Duplicate “${r.title}”`} title="Duplicate as a new draft" onClick={() => void duplicate(r.id)}>
                      <Copy />
                    </button>
                    <button className="icon-btn sm" aria-label={`Delete “${r.title}”`} title={`Delete ${noun}`} onClick={() => void remove(r.id)}>
                      <Trash2 />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
