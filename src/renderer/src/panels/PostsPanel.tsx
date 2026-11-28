import './PostsPanel.css';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ArrowLeft, ChevronDown, Copy, FileDown, FilePen, FileText, LayoutTemplate, Library, MoreHorizontal, Newspaper, Plug, Plus, Search, Settings2, Tags, Trash2, X } from 'lucide-react';
import { entryLinkUses } from '@engine/page-links';
import { api, commitIfUnchanged, commitOps, confirmDialog, getState, markDraft, setState, shownAt, toast, undoAction, useStore } from '../store';
import { headerMenu as findHeaderMenu } from '@engine/tree';
import { Field, Modal, Segmented, Spinner, rovingKeys, useMenu, type MenuItem } from '../components/ui';
import { ListPeek, Marked, fold, found, shortDate } from '../components/ListText';
import { reviewPostImport } from './PostImportReview';
import type { PostImportKind } from '@shared/api';
import { isImeComposing } from '../lib/ime';
import { POST_SORTS, POST_STATUSES, duplicatePostOps, newPostOps, postAt, postCounts, postRows, listedCollection, MAX_POST_TITLE, type PostRef, type PostRow, type PostSort, type PostStatus } from '../lib/posts';
import { TermsManager, postTaxonomies, termsManagerTitle, termsOf } from './PostTerms';
import { CollectionSchemaDialog } from './CollectionSchemaDialog';
import { SourceDialog } from './SourceDialog';
import { detachOps, sourceOfCollection, syncSummary } from '../lib/sources';
import { sourceFingerprint } from '@shared/sources';
import { STARTER_COLLECTIONS, contentRows, customCollectionOps, entryNoun, entryNounLower, isReadOnlyCollection, starterCollectionOps, withArticle, pluralNoun, isArticleCollection } from '../lib/content';
import { openLayout } from '../lib/actions';
import type { EditOperation } from '@shared/ops';
import { POSTS_COLLECTION_ID, collectionHasBody, collectionKind, findEntry, hasDetailPages, orderedEntries } from '@shared/collections';
import type { CollectionKind, ProjectState } from '@shared/types';
import { saveOpenPost, startOpenPost } from '../lib/post-draft';
import { typedAhead, typedAheadSettled } from '../lib/typed-ahead';
import { trackApply } from '../lib/pending';

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

/**
 * Whether the status filter's row is too narrow for each count beside its label: the tray's width laid out that way
 * (each option's label, gap, count and padding, the gaps between options, the tray's padding and edge), from widths
 * that are the same in either layout, so the answer never flips back and forth.
 */
function countsNeedStacking(row: HTMLElement): boolean {
  const tray = row.querySelector<HTMLElement>('.segmented');
  if (!tray) return false;
  const px = (v: string) => parseFloat(v) || 0;
  const options = [...tray.querySelectorAll<HTMLElement>('.posts-filter-option')];
  const need = options.reduce((w, o) => {
    const button = getComputedStyle(o.parentElement!);
    const [label, count] = [...o.children] as HTMLElement[];
    return w + label.getBoundingClientRect().width + px(getComputedStyle(o).columnGap) + count.getBoundingClientRect().width + px(button.paddingLeft) + px(button.paddingRight);
  }, 0);
  const t = getComputedStyle(tray);
  const r = getComputedStyle(row);
  const width = need + px(t.columnGap) * Math.max(0, options.length - 1) + px(t.paddingLeft) + px(t.paddingRight) + px(t.borderLeftWidth) + px(t.borderRightWidth);
  return width > row.clientWidth - px(r.paddingLeft) - px(r.paddingRight) + 0.5;
}

/** Whether a row cuts its title short: past its two lines (none is cut while titles show in full or a find is on). */
const titleCut = (row: HTMLElement) => {
  const t = row.querySelector<HTMLElement>('.post-title');
  return !!t && t.scrollHeight > t.clientHeight + 1;
};

/** Said when another entry is asked to open while one is still opening (#1394). */
const OPENING_NOW = 'An entry is still opening. Try again once it has.';

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
  // Grouped by collection, each under its own name (a renamed blog is not "Posts").
  const groups = Object.keys(state.collections)
    .sort()
    .map((id) => ({ id, name: state.collections[id].settings.name, entries: orderedEntries(state.collections[id]).filter((x) => x.id !== target.entryId && x.draft === false) }))
    .filter((g) => g.entries.length > 0);
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
          {groups.map((g) => (
            <optgroup key={g.id} label={g.name}>
              {g.entries.map((p) => (
                <option key={p.id} value={`entry:${p.id}`}>
                  {p.title}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>
      <p className="posts-note">You can undo it.</p>
    </Modal>
  );
}

/** The order the list was last shown in, for this window. */
let lastSort: PostSort = 'newest';
/** Whether the list shows each title in full rather than in two lines, as chosen last (in the collection's options). */
let lastFullTitles = false;

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
    if (asked && made?.addedToNavigation === false) toast('Added the blog. Its link could not join the header menu, which is full or shows links from somewhere else: link one to the Posts index in the header’s menu.', 'info');
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
  /** The collection the list was turned to: in the store, since the toolbar, Inspector, composer and writer name it too. */
  const listed = useStore((s) => s.contentCollection);
  const [query, setQuery] = useState('');
  const [sort, setSortState] = useState<PostSort>(lastSort);
  const [fullTitles, setFullTitlesState] = useState(lastFullTitles);
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
  /** The collection whose source is syncing now, said under the head until it is done. */
  const [syncing, setSyncing] = useState<string | null>(null);
  /** The head's menus: the collection switcher and the collection's options. */
  const menu = useMenu();
  /** A post's options, from its … button, a right-click or Shift+F10; `rowMenuFor` is the post it is open for. */
  const rowMenu = useMenu();
  const [rowMenuFor, setRowMenuFor] = useState<string | null>(null);
  /** The row keyboard focus last sat on, which keeps the list's one tab stop. */
  const [focusedRow, setFocusedRow] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const collectionFormRef = useRef<HTMLDivElement>(null);
  const headOptions = useRef<HTMLButtonElement>(null);
  /**
   * The row keyboard focus is on, whose whole title and address show beside the list while it cuts them short (as in
   * Pages). Escape puts the card away until focus moves to another row.
   */
  const [peek, setPeek] = useState<{ id: string } | null>(null);
  const headAdd = useRef<HTMLButtonElement>(null);
  const typeahead = useRef({ text: '', at: 0 });
  /** The collection the new-entry form was opened for: what it creates in, whatever the list shows by then. */
  const addTarget = useRef<{ collectionId: string; workspaceKey: string | undefined } | null>(null);
  /** Counts each choice of what the panel shows, so one still saving the open entry never undoes a later one. */
  const navigation = useRef(0);
  const creating = useRef(false);
  const findInput = useRef<HTMLInputElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const uid = useId();
  // A title typed for a new post is a change not made yet: Save and leaving the project say so.
  const newKey = `posts-new:${uid}`;
  useEffect(() => markDraft(newKey, adding && !!title.trim()), [newKey, adding, title]);
  useEffect(() => () => markDraft(newKey, false), [newKey]);
  // An entry opened from elsewhere (the SEO view, Assets, an import) shows its own collection's list.
  useEffect(() => {
    if (post?.collectionId) setState({ contentCollection: post.collectionId });
  }, [post?.collectionId]);
  const state = snap?.state;
  const collection = state ? listedCollection(state, listed, post) : undefined;
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
  // When the open entry changes (from here, the SEO view, an import), its row is brought into view without taking
  // focus from the writer; scrolling the list by hand in between is left alone.
  // An entry opened while a filter hides its row lets go of just the filters that hide it, so the open entry is always
  // in the list; choosing a filter while it is open is left alone.
  const shownId = collection?.settings.id;
  const reveal = useRef<string | null>(null);
  useEffect(() => {
    if (!post?.entryId) return;
    reveal.current = post.entryId;
    if (!collection || post.collectionId !== collection.settings.id || rows.some((r) => r.id === post.entryId)) return;
    const e = Object.hasOwn(collection.entries, post.entryId) ? collection.entries[post.entryId] : undefined;
    if (!e) return;
    const draft = e.draft !== false;
    if ((status === 'published' && draft) || (status === 'drafts' && !draft)) setStatus('all');
    const filed: unknown = e.terms?.categories;
    if (categoryId && !(Array.isArray(filed) && filed.includes(categoryId))) setCategory('');
    if (query.trim() && !postRows(collection, query, sort).some((r) => r.id === post.entryId)) setQuery('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post?.entryId, shownId]);
  // Its row is then brought into view without taking focus from the writer, once it is drawn; scrolling the list by
  // hand in between is left alone.
  useEffect(() => {
    const id = reveal.current;
    const row = id && listRef.current?.offsetParent ? listRef.current.querySelector<HTMLElement>(`[data-post="${id}"]`) : null;
    if (!row) return;
    reveal.current = null;
    row.scrollIntoView({ block: 'nearest' });
  });
  // A form opened from the head or its menu comes into view at the top of the list, wherever the list was scrolled;
  // Add a collection takes focus to its first choice.
  useEffect(() => {
    if (adding) formRef.current?.scrollIntoView({ block: 'nearest' });
  }, [adding]);
  useEffect(() => {
    if (!addingCollection) return;
    collectionFormRef.current?.scrollIntoView({ block: 'nearest' });
    collectionFormRef.current?.querySelector<HTMLElement>('button:not(:disabled), input')?.focus();
  }, [addingCollection]);
  /** Said once when the last filter goes, whichever control cleared it; the polite region is otherwise quiet then. */
  const [restored, setRestored] = useState(false);
  const isFiltered = !!query.trim() || status !== 'all' || !!categoryId;
  const wasFiltered = useRef(false);
  useEffect(() => {
    setRestored(wasFiltered.current && !isFiltered);
    wasFiltered.current = isFiltered;
  }, [isFiltered, query, status, categoryId]);
  // Said for that moment only: another collection, or a post added or deleted, is not the filter coming off.
  const total = collection ? Object.keys(collection.entries).length : 0;
  const shownKey = collection?.settings.id;
  useEffect(() => setRestored(false), [shownKey, total]);
  // The status filter puts each count under its label when its row has no room for them side by side, whatever the
  // sidebar's width and however long the counts: measured when the row resizes and after every render (counts change).
  const [stackCounts, setStackCounts] = useState(false);
  const filters = useRef<HTMLDivElement | null>(null);
  const filtersSeen = useRef<ResizeObserver | null>(null);
  const fitFilters = () => filters.current && setStackCounts(countsNeedStacking(filters.current));
  const fitFiltersNow = useRef(fitFilters);
  fitFiltersNow.current = fitFilters;
  const filtersRef = useCallback((el: HTMLDivElement | null) => {
    filtersSeen.current?.disconnect();
    filters.current = el;
    filtersSeen.current = el ? new ResizeObserver(() => fitFiltersNow.current()) : null;
    if (el) filtersSeen.current!.observe(el);
  }, []);
  useLayoutEffect(() => {
    fitFiltersNow.current();
  });
  if (!snap || !state) return null;
  const all = collection ? Object.keys(collection.entries).length : 0;
  // The status filter counts what the other filters leave (the words found, the category chosen), so a pill never
  // promises more rows than choosing it shows.
  const counts = !collection
    ? { all: 0, published: 0, drafts: 0 }
    : query.trim() || categoryId
      ? (() => {
          const kept = postRows(collection, query, sort, { category: categoryId });
          const drafts = kept.filter((r) => r.draft).length;
          return { all: kept.length, published: kept.length - drafts, drafts };
        })()
      : postCounts(collection);
  const filtered = !!query.trim() || status !== 'all' || !!categoryId;
  const collections = contentRows(state);
  const language = state.site.language;
  const isBlog = collection?.settings.id === POSTS_COLLECTION_ID;
  const noun = entryNounLower(collection);
  // Where a count is said, the collection's own noun: "posts", "essays", "advisors", "properties" ("entries" with none).
  const plural = (n: number) => (n === 1 ? noun : pluralNoun(noun));
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
  const setFullTitles = (on: boolean) => {
    lastFullTitles = on;
    setFullTitlesState(on);
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
      // Let go of the entry and show the collection in one change, so nothing names the old one in between.
      setState({ post: null, postView: 'write', postReveal: null, contentCollection: id });
    } else setState({ contentCollection: id });
    setCategory('');
    setStatus('all');
    setQuery('');
    // A form with a title typed keeps it, still for the collection it was opened for (its heading says which).
    if (!title.trim()) setAdding(false);
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
    // One at a time: a second press while the open entry saves makes no second draft, nor one while a copy is made. Busy
    // from the first wait, so the title, Cancel and Escape hold still while what was typed is on its way.
    if (!t || busy || creating.current || !to) return;
    if (getState().postOpening) return void toast(OPENING_NOW, 'info');
    creating.current = true;
    setBusy(true);
    // Until the new entry opens, the writer keeps the one before it, which takes nothing typed: what is typed meanwhile
    // (straight on after Enter, or with a click on the writer) goes into a field for the new one's text (#1394).
    const opening = { label: `Opening “${t}”…`, field: `Text for “${t}”` };
    // In the writer, shown now (not the post's preview), for that field to have focus.
    setState({ postOpening: opening, postView: 'write' });
    try {
      await createIn(to, t, opening);
    } finally {
      creating.current = false;
      setBusy(false);
      if (getState().postOpening === opening) setState({ postOpening: null });
    }
  };
  const createIn = async (to: { collectionId: string; workspaceKey: string | undefined }, t: string, opening: object) => {
    // Creating opens the new entry: a choice made while it saves (another collection, another entry) wins over that.
    const seq = ++navigation.current;
    // Still the one the writer waits for, in the project it was typed in: another project opened meanwhile owns all that.
    const mine = () => getState().postOpening === opening && getState().snapshot?.workspaceKey === to.workspaceKey;
    // Nothing made: the form keeps its title, and what was typed for the entry is said to be gone, never quietly.
    const notMade = () => void (mine() && typedAhead().text.trim() && toast(`What you typed for “${t}” was not kept: it was not made.`, 'error'));
    if (!(await openSaved())) return notMade();
    const s = getState().snapshot;
    if (!s) return;
    const target = to.collectionId;
    // Only ever into the collection it was typed for: one gone meanwhile (an Undo), or another project, keeps the title.
    if (s.workspaceKey !== to.workspaceKey || !Object.hasOwn(s.state.collections, target)) return void (toast('The collection this was typed for is no longer in the project.', 'error'), notMade());
    const { ops, ref } = newPostOps(s.state, target, t);
    const r = await commitOps(ops, `New ${noun}`);
    if (!r) return notMade();
    setAdding(false);
    setTitle('');
    // In the editor's copy of the project before it opens, so its writer is there at once to take what was typed.
    const shown = await shownAt(r.revision, r.workspaceKey);
    if (!mine()) return;
    const saved = shown && (await openSaved());
    // A composition in progress where the text was typed ahead ends first, so all of it goes in, wherever it goes.
    await typedAheadSettled();
    if (!mine()) return;
    const typed = typedAhead();
    // Filters that would hide the new draft let go of it once it opens (the reveal above); a find it matches stays.
    // Something kept in the open entry, another choice made meanwhile, or typing gone on somewhere else (Find, a dialog,
    // left as they are): the new one waits in the list, with what was typed for it as its text.
    if (!saved || seq !== navigation.current || typed.elsewhere) return void keepTyped(ref, t, typed.text);
    // Opened and started on in one go: no key typed between the two goes anywhere else.
    flushSync(() => setState({ post: ref, postView: 'write', postReveal: null, postOpening: null }));
    if (!startOpenPost(ref, typed.text)) void keepTyped(ref, t, typed.text);
  };
  /**
   * What was typed for an entry made but not started on in the writer, saved as its text, so it is in the entry it was
   * typed for: only while that text is still as it was made (empty; nothing else wrote it meanwhile), and said either
   * way. Followed as a save in flight, so leaving the project waits for it.
   */
  const keepTyped = async (ref: PostRef, t: string, text: string) => {
    const body = text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => ({ type: 'p' as const, spans: [{ text: line }] }));
    if (!body.length) return;
    const s = getState().snapshot;
    const c = s && Object.hasOwn(s.state.collections, ref.collectionId) ? s.state.collections[ref.collectionId] : undefined;
    const e = s && postAt(s.state, ref);
    const outcome = s && c && e && collectionHasBody(c.settings) && !e.body?.length ? commitIfUnchanged(s, () => commitOps([{ type: 'entry.update', collectionId: ref.collectionId, entryId: ref.entryId, body }], `Edit ${noun} text`)) : null;
    if (outcome) trackApply(outcome.then((o) => (o.kind === 'applied' ? { ok: true } : { ok: false })));
    const o = await outcome;
    if (o?.kind === 'applied') toast(`What you typed is saved in “${t}”.`, 'info');
    else toast(`What you typed for “${t}” was not kept: it could not be saved there.`, 'error');
  };

  const duplicate = async (entryId: string) => {
    if (!collection) return;
    // One entry opens at a time: what is typed for a new one meanwhile is never taken from it.
    if (getState().postOpening) return void toast(OPENING_NOW, 'info');
    // Opening the copy is a choice made now: another made while it saves (an entry, a collection) wins over it.
    const seq = ++navigation.current;
    const ref = { collectionId: collection.settings.id, entryId };
    const workspaceKey = getState().snapshot?.workspaceKey;
    // Until the copy opens, the writer keeps the entry before it, which takes nothing typed (#1394).
    const opening = { label: 'Opening the copy…' };
    setState({ postOpening: opening });
    // Still the one the writer waits for, in the project it was asked for in.
    const mine = () => getState().postOpening === opening && getState().snapshot?.workspaceKey === workspaceKey;
    try {
      // The copy opens in the writer: whatever it holds is saved first (and the copy has the latest words of its own).
      if (!(await openSaved()) || !mine()) return;
      const s = getState().snapshot;
      const plan = s && duplicatePostOps(s.state, ref);
      if (!plan) return;
      const r = await commitOps(plan.ops, `Duplicate ${noun}`);
      if (!r) return;
      // Filters that would hide the copy (a draft at a new address) let go of it once it opens; a find it matches stays.
      if (!(await openSaved()) || seq !== navigation.current || !mine()) return;
      setState({ post: plan.ref, postView: 'write', postReveal: null, postOpening: null });
      toast(`Duplicated as a draft: “${postAt(getState().snapshot!.state, plan.ref)?.title ?? 'copy'}”`, 'info', r.entryId ? undoAction({ entryId: r.entryId, revision: r.revision, workspaceKey: r.workspaceKey }) : undefined);
    } finally {
      if (getState().postOpening === opening) setState({ postOpening: null });
    }
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

  /** Sync a collection's source now, and say what changed; the panel says it is syncing until it is done. */
  const syncNow = async (collectionId: string, sourceId: string, name: string) => {
    if (syncing) return;
    setSyncing(collectionId);
    const r = await api.project.syncSource(sourceId, snap.workspaceKey).catch((e: Error) => ({ ok: false as const, message: e.message }));
    setSyncing(null);
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

  /** What can be done with a collection's external source, as items of its options menu. */
  const sourceItems = (collectionId: string): MenuItem[] => {
    const c = state.collections[collectionId];
    const source = sourceOfCollection(state, collectionId);
    // Synced from a source the project has no settings for: it can only be detached.
    const orphan = !source && c.settings.sourceId !== undefined;
    if (orphan) return [{ label: 'Detach to local collection', icon: <Plug />, description: 'Its source is no longer in the project. Keep its entries here, to edit them in the app.', onSelect: () => void detach(collectionId) }];
    if (source)
      return [
        { heading: `Synced from ${source.name}` },
        { label: syncing === collectionId ? 'Syncing…' : 'Sync now', icon: <Plug />, description: syncing && syncing !== collectionId ? 'Another collection is syncing: this one can sync once it is done.' : 'Bring in what changed in the source.', disabled: !!syncing, onSelect: () => void syncNow(collectionId, source.id, source.name) },
        { label: 'Source settings…', onSelect: () => setConnecting(collectionId) },
        { label: 'Detach to local collection', description: 'Keep its entries here, to edit them in the app.', onSelect: () => void detach(collectionId) }
      ];
    return [
      {
        label: 'Connect external source…',
        icon: <Plug />,
        description: Object.keys(c.entries).length ? 'Only an empty collection can be connected: its first sync brings in every entry.' : 'Sync its entries from a CMS or an API.',
        disabled: Object.keys(c.entries).length > 0,
        onSelect: () => setConnecting(collectionId)
      }
    ];
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

  // The collection by its own name: a renamed blog is called what it was renamed to, everywhere.
  const heading = collection?.settings.name ?? 'Content';
  // Folded as the list finds; a query of accents alone folds to nothing and finds nothing to mark.
  const needle = fold(query.trim());
  const words = needle ? [needle] : [];
  const finding = words.length > 0;
  const tabStop = focusedRow && rows.some((r) => r.id === focusedRow) ? focusedRow : post && rows.some((r) => r.id === post.entryId) ? post.entryId : rows[0]?.id;
  const rowEl = (id: string) => listRef.current?.querySelector<HTMLElement>(`[data-post="${id}"]`);
  /** Keyboard focus on a row: its card beside the list shows while its title is cut short (past its two lines). */
  const showPeek = (row: HTMLElement | null) => setPeek(row?.matches(':focus-visible') ? { id: row.dataset.post! } : null);
  const syncingHere = !!collection && syncing === collection.settings.id;
  /** The head's New button resumes a titled form typed for another collection, and says so. */
  const resumes = adding && !!title.trim() && !!formTarget && formTarget !== collection;
  const source = collection ? sourceOfCollection(state, collection.settings.id) : undefined;

  /** Open the new-entry form for the collection shown, under the head that opened it. */
  const openForm = () => {
    if (!collection) return;
    // A form with a title typed is resumed as it is, for the collection it was opened for, never turned into another's.
    if (adding && title.trim()) {
      formRef.current?.scrollIntoView({ block: 'nearest' });
      return void requestAnimationFrame(() => addInput.current?.focus());
    }
    addTarget.current = { collectionId: collection.settings.id, workspaceKey: snap.workspaceKey };
    setAdding(true);
    requestAnimationFrame(() => addInput.current?.focus());
  };
  const cancelAdd = () => {
    setAdding(false);
    setTitle('');
    // To the New button, or the options button where the shown collection has none (a synced one).
    requestAnimationFrame(() => (headAdd.current ?? headOptions.current)?.focus());
  };

  const importTitle = collection ? `Import into ${collection.settings.name}` : 'Import posts from';
  const importItems: MenuItem[] = [
    { heading: importTitle },
    { label: 'WordPress export (.xml)…', icon: <FileDown />, description: 'In WordPress: Tools → Export. Put the site’s uploads folder beside it for its pictures.', onSelect: () => void importFrom('wordpress') },
    { label: 'Folder of Markdown posts…', icon: <FileDown />, description: 'Jekyll, Hugo, Eleventy or Astro posts, with their pictures.', onSelect: () => void importFrom('markdown') }
  ];
  const openImport = (el: HTMLElement) => menu.openAt(el, importItems, importTitle);

  /** Show another collection, or add one: the head's title is this menu while the project has more than one. */
  const openSwitcher = (el: HTMLElement) =>
    menu.openAt(
      el,
      [
        { heading: 'Collections' },
        ...collections.map((c) => ({ label: c.name, hint: String(c.count), ariaLabel: `${c.name}, ${c.count} ${c.count === 1 ? 'entry' : 'entries'}`, checked: c.id === collection?.settings.id, onSelect: () => void choose(c.id) })),
        { separator: true },
        { label: 'Add a collection…', icon: <Plus />, onSelect: () => setAddingCollection(true) }
      ],
      'Collections'
    );

  /** The collection's options: its order, its groupings, imports, settings, layout and source. */
  const openOptions = (el: HTMLElement) => {
    if (!collection) return;
    const id = collection.settings.id;
    const items: MenuItem[] = [
      { heading: 'Sort' },
      ...POST_SORTS.map((s) => ({ label: s.label, checked: sort === s.id, onSelect: () => setSort(s.id) })),
      { separator: true },
      { label: 'Show full titles', checked: fullTitles, toggle: true, description: 'Every title whole, rather than in two lines.', onSelect: () => setFullTitles(!fullTitles) },
      { separator: true },
      ...(groupings.length > 0 && !readOnly ? [{ label: `${termsManagerTitle(collection)}…`, icon: <Tags />, description: `Add, rename or delete ${termsManagerTitle(collection).toLowerCase()}.`, onSelect: () => setManaging(true) }] : []),
      ...(canImport && !readOnly
        ? [
            { ...importItems[1], label: 'Import a WordPress export…' },
            { ...importItems[2], label: 'Import a folder of Markdown posts…' }
          ]
        : []),
      { label: 'Collection settings…', icon: <Settings2 />, description: 'Fields, groupings and pages.', onSelect: () => void openSaved().then((ok) => ok && setSchema(id)) },
      {
        label: 'Edit layout',
        icon: <LayoutTemplate />,
        description: hasDetailPages(collection.settings) ? `The layout every ${noun}’s page is shown with.` : 'Its entries have no pages: turn them on in its settings.',
        disabled: !hasDetailPages(collection.settings),
        onSelect: () => void editLayout(id)
      },
      { separator: true },
      ...sourceItems(id),
      ...(collections.length === 1 ? [{ separator: true }, { label: 'Add a collection…', icon: <Plus />, onSelect: () => setAddingCollection(true) }] : [])
    ];
    menu.openAt(el, items, `${heading} options`);
  };

  /** A post's options, at its … button or where the pointer or keyboard asked for them. */
  const postMenu = (at: HTMLElement | { x: number; y: number; row: HTMLElement }, r: PostRow) => {
    const current = post?.entryId === r.id && post.collectionId === collection?.settings.id;
    const items: MenuItem[] = [
      { label: current ? 'Open (already open)' : `Open ${noun}`, disabled: current, onSelect: () => void open(r.id) },
      ...(readOnly
        ? []
        : [
            { label: 'Duplicate as draft', icon: <Copy />, onSelect: () => void duplicate(r.id) },
            { separator: true },
            { label: `Delete ${noun}…`, icon: <Trash2 />, danger: true, onSelect: () => void remove(r.id) }
          ])
    ];
    setRowMenuFor(r.id);
    if (at instanceof HTMLElement) rowMenu.openAt(at, items, `${r.title} options`);
    else rowMenu.open(at.x, at.y, items, `${r.title} options`, at.row);
  };

  // Type-ahead: printable keys jump to the next entry whose title starts with what was typed (as in Pages).
  const typeAhead = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey || e.key === ' ') return false;
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.isContentEditable) return false;
    const ta = typeahead.current;
    const now = Date.now();
    ta.text = now - ta.at > 700 ? e.key.toLowerCase() : ta.text + e.key.toLowerCase();
    ta.at = now;
    const els = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const cur = els.indexOf((document.activeElement as HTMLElement)?.closest('[role="option"]') as HTMLElement);
    const repeat = ta.text.length > 1 && [...ta.text].every((c) => c === ta.text[0]);
    const needle = fold(repeat ? ta.text[0] : ta.text);
    const start = needle.length > 1 ? Math.max(0, cur) : cur + 1;
    for (let k = 0; k < els.length; k++) {
      const el = els[(start + k) % els.length];
      if (fold(rows.find((r) => r.id === el.dataset.post)?.title ?? '').startsWith(needle)) {
        e.preventDefault();
        // Focus only: opening is Enter or Space, so typing never saves and swaps the post being written.
        if (el !== els[cur]) el.focus();
        return true;
      }
    }
    return true;
  };

  const onFindKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(e)) return;
    if (e.key === 'ArrowDown' && rows.length) {
      e.preventDefault();
      rowEl(finding || !tabStop ? rows[0].id : tabStop)?.focus();
    } else if (e.key === 'Enter' && finding && rows.length) {
      e.preventDefault();
      void open(rows[0].id);
    } else if (e.key === 'Escape' && query) {
      e.stopPropagation();
      setQuery('');
    }
  };

  /**
   * What matched, when it is not in the title: the byline, the address or the excerpt, from a little before the first
   * match so the words are in view on a narrow row. `text` is the same words, for the row's description.
   */
  const reason = (r: PostRow): { node: React.ReactNode; text: string } | null => {
    if (!finding || !r.matched || r.matched === 'title' || !r.matchedText) return null;
    const full = r.matchedText;
    // In characters (as found() counts them): from a word or folder boundary at most 16 before the first hit, never past
    // it, so the hit stays inside the two lines a 200px row shows.
    const chars = [...full];
    const hit = Math.max(0, found(full, words).indexOf(true));
    let from = 0;
    const LEAD = 16;
    if (hit > LEAD) {
      const stop = r.matched === 'route' ? '/' : ' ';
      const b = chars.slice(hit - LEAD, hit).indexOf(stop);
      from = b >= 0 ? hit - LEAD + b + (r.matched === 'route' ? 0 : 1) : hit - LEAD;
    }
    const shown = chars.slice(from).join('');
    const lead = r.matched === 'author' ? 'By ' : '';
    return {
      node: (
        <>
          {lead}
          {from > 0 && '…'}
          <Marked text={shown} words={words} />
        </>
      ),
      text: `${r.matched === 'author' ? 'By' : r.matched === 'route' ? 'Address' : 'Excerpt'}: ${full}`
    };
  };

  const importButton = canImport && (
    <button className="btn btn-sm btn-ghost posts-head-menu" {...menu.triggerProps('import')} data-testid="posts-import" aria-label="Import posts" title="Import posts" disabled={reading} onClick={(e) => openImport(e.currentTarget)}>
      <FileDown aria-hidden="true" /> <span className="posts-head-label">{reading ? 'Reading…' : 'Import…'}</span>
    </button>
  );

  // No collection yet: what the project can keep, one click each.
  if (!collection)
    return (
      <div className="posts-panel">
        <div className="panel-head">
          <h3>Content</h3>
          {importButton}
          {menu.node}
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

  const RowGlyph = (r: PostRow) => (r.draft ? <FilePen /> : dated ? <Newspaper /> : <FileText />);

  return (
    <div className="posts-panel">
      <div className="panel-head">
        <div className="posts-head-title">
          {collections.length > 1 ? (
            <button className="posts-switch" {...menu.triggerProps('switch')} title={`${heading}: show another collection`} onClick={(e) => openSwitcher(e.currentTarget)}>
              <span className="ellipsis">{heading}</span>
              <ChevronDown aria-hidden="true" />
            </button>
          ) : (
            <h3 className="ellipsis" title={heading}>
              {heading}
            </h3>
          )}
        </div>
        {readOnly ? (
          <span className="badge posts-readonly">Read-only</span>
        ) : (
          <button
            ref={headAdd}
            className="btn btn-sm btn-ghost posts-head-add"
            aria-expanded={adding}
            aria-controls={adding ? `${uid}-add` : undefined}
            aria-label={resumes ? `Continue draft: new ${entryNounLower(formTarget)} in ${formTarget!.settings.name}` : `New ${noun}`}
            title={resumes ? `Continue draft: new ${entryNounLower(formTarget)} in ${formTarget!.settings.name}` : `New ${noun}`}
            onClick={() => (adding && !title.trim() ? cancelAdd() : openForm())}
          >
            <Plus aria-hidden="true" /> <span className="posts-head-label">{resumes ? 'Continue draft' : `New ${noun}`}</span>
          </button>
        )}
        <button ref={headOptions} className="icon-btn sm posts-head-options" aria-label={`${heading} options`} title="Sort, import and collection settings" {...menu.triggerProps('options')} data-testid={`collection-options-${collection.settings.id}`} onClick={(e) => openOptions(e.currentTarget)}>
          <MoreHorizontal />
        </button>
        {menu.node}
      </div>
      {(readOnly || syncingHere) && (
        <div className="posts-source-note">
          {syncingHere ? <Spinner decorative /> : <Plug aria-hidden="true" />}
          <span>{syncingHere ? `Syncing from ${source?.name ?? 'its source'}…` : `Synced from ${source?.name ?? 'an external source'}: its entries are changed there.`}</span>
        </div>
      )}
      {all > 0 && (
        <div className="posts-tools">
          <div className={`search posts-find${query ? ' has-query' : ''}`}>
            <Search aria-hidden="true" />
            <input
              ref={findInput}
              className="input"
              placeholder={`Find among ${all} ${plural(all)}`}
              aria-label={`Find ${withArticle(noun)} by title, address, author or excerpt`}
              aria-controls={`${uid}-list`}
              value={query}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onFindKey}
            />
            {query && (
              <button className="icon-btn sm search-clear" aria-label="Clear find" title="Clear (Esc)" onClick={() => (setQuery(''), findInput.current?.focus())}>
                <X />
              </button>
            )}
          </div>
          <div ref={filtersRef} className={`posts-filters${stackCounts ? ' stacked' : ''}`}>
            <Segmented radio label={`Show ${plural(2)}`} value={status} onChange={setStatus} options={POST_STATUSES.map((s) => ({
                value: s.id,
                label: (
                  // Each count beside its label, or under it when the row has no room for that (countsNeedStacking); both
                  // reserve their chosen (bold) width, so choosing a filter never moves its neighbours.
                  <span className="posts-filter-option">
                    <span className="seg-label" data-label={s.label}>
                      {s.label}
                    </span>{' '}
                    <span className="seg-label posts-filter-count" data-label={String(counts[s.id])}>
                      {counts[s.id]}
                    </span>
                  </span>
                )
              }))}
            />
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
          </div>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {filtered ? (rows.length ? `${rows.length} of ${all} ${plural(all)}` : `No ${noun} matches`) : restored ? `All ${all} ${plural(all)} shown` : ''}
      </span>
      {/* Mounted before a sync starts, so its start is said; the note under the head is for the eye. */}
      <span className="sr-only" role="status">
        {syncingHere ? `Syncing ${heading} from ${source?.name ?? 'its source'}…` : ''}
      </span>
      {schema && <CollectionSchemaDialog collectionId={schema} onClose={() => setSchema(null)} />}
      {connecting && <SourceDialog collectionId={connecting} onClose={() => setConnecting(null)} />}
      {managing && <TermsManager collectionId={collection.settings.id} onClose={() => setManaging(false)} onRenamed={(tax, from, to) => tax === 'categories' && category === from && setCategory(to)} />}
      {deleting && <DeletePostDialog target={deleting} onClose={() => setDeleting(null)} />}
      <div className="panel-body">
        {adding && !isReadOnlyCollection(formTarget) && (
          <div ref={formRef}>
          <form
            id={`${uid}-add`}
            className="posts-add-form"
            aria-labelledby={`${uid}-add-heading`}
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !isImeComposing(e)) (e.stopPropagation(), !busy && cancelAdd());
            }}
          >
            <div className="posts-add-heading" id={`${uid}-add-heading`}>
              {formTarget && formTarget !== collection ? `New ${entryNounLower(formTarget)} in ${formTarget.settings.name}` : `New ${entryNounLower(formTarget)}`}
            </div>
            <input ref={addInput} className="input inline-edit" placeholder={collectionKind(formTarget?.settings) === 'editorial' ? 'Title' : 'Name or title'} aria-label={`New ${entryNounLower(formTarget)} title`} maxLength={MAX_POST_TITLE} value={title} readOnly={busy} onChange={(e) => setTitle(e.target.value)} />
            <div className="posts-add-actions">
              <button type="submit" className="btn btn-sm btn-primary" disabled={!title.trim() || busy}>
                {busy ? 'Creating draft…' : 'Create draft'}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={cancelAdd}>
                Cancel
              </button>
            </div>
          </form>
          </div>
        )}
        {addingCollection && (
          <div className="posts-add-form posts-add-collection" ref={collectionFormRef}>
            <div className="posts-add-heading">Add a collection</div>
            <AddCollection state={state} onMade={made} onCancel={() => (setAddingCollection(false), requestAnimationFrame(() => headOptions.current?.focus()))} />
          </div>
        )}
        {previewing && post && (
          <div className="posts-previewing" role="status">
            <span>Showing the {entryNounLower(state.collections[post.collectionId])} as visitors see it.</span>
            <button className="btn btn-sm btn-primary" onClick={() => setState({ postView: 'write' })}>
              <ArrowLeft aria-hidden="true" /> Back to writing
            </button>
          </div>
        )}
        {!all && !adding && (
          <div className="posts-empty">
            {isArticleCollection(collection) ? <Newspaper aria-hidden="true" /> : <FileText aria-hidden="true" />}
            <p>{isBlog ? `Write articles, news and updates. Each ${noun} gets its own page on the site, in the site’s header and footer.` : `${collection.settings.name} has no entries yet.`}</p>
            {!readOnly && (
              <button className="btn btn-sm btn-primary" onClick={openForm}>
                <Plus aria-hidden="true" /> {isBlog ? `Write the first ${noun}` : `Add the first ${noun}`}
              </button>
            )}
            {canImport && !readOnly && (
              <button className="btn btn-sm" {...menu.triggerProps('import-empty')} aria-label={`${importTitle}…`} disabled={reading} onClick={(e) => openImport(e.currentTarget)}>
                <FileDown aria-hidden="true" /> Import…
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
          <div className="posts-none">
            <p>{query.trim() && status === 'all' && !categoryId ? `No ${noun} has “${query.trim()}” in its title, address, author or excerpt.` : `No ${noun} matches these filters.`}</p>
            {(status !== 'all' || categoryId || query.trim()) && (
              <button className="btn btn-sm" onClick={() => (setStatus('all'), setCategory(''), setQuery(''), findInput.current?.focus())}>
                Show all {plural(2)}
              </button>
            )}
          </div>
        )}
        {rows.length > 0 && (finding || !!categoryId || sort !== 'newest') && (
          // What narrows or orders the list beyond what the filter row shows: the count found, and a sort other than
          // newest first (chosen in the options menu).
          <p className="posts-count" aria-hidden="true">
            {[(finding || categoryId) && `${rows.length} of ${all} ${plural(all)}`, sort !== 'newest' && `Sorted by ${POST_SORTS.find((s) => s.id === sort)!.label.toLowerCase()}`].filter(Boolean).join(' · ')}
          </p>
        )}
        <div className="posts-list-wrap">
        <div
          id={`${uid}-list`}
          className={`list posts-list${finding ? ' finding' : ''}${fullTitles ? ' full-titles' : ''}`}
          role="listbox"
          aria-label={finding ? `${heading} matching “${query.trim()}”` : heading}
          aria-description="Type a title to jump to it. Enter opens it; Shift+F10 opens its options."
          ref={listRef}
          hidden={!rows.length}
          onFocus={(e) => {
            const row = e.target.closest<HTMLElement>('[role="option"]');
            setFocusedRow(row?.dataset.post ?? null);
            showPeek(row);
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPeek(null);
          }}
          onKeyDown={(e) => {
            if (!typeAhead(e)) rovingKeys(e, 'option', { follow: false });
          }}
        >
          {rows.map((r) => {
            const current = post?.entryId === r.id && post.collectionId === collection.settings.id;
            const date = dated && r.date ? shortDate(r.date, language) : null;
            // The row's name says the date with its year, which the row itself leaves out for this year's.
            const status = [r.draft && 'draft, left out of the website', dated && r.date && shortDate(r.date, language, { withYear: true })].filter(Boolean).join(', ');
            const cls = ['list-item', 'post-row', r.draft && 'draft', current && 'selected', rowMenu.isOpen && rowMenuFor === r.id && 'menu-open'].filter(Boolean).join(' ');
            const why = reason(r);
            const meta = r.draft || !!date;
            // On a dated row the … sits at the end of the Draft and date line, so the title keeps the row's whole width;
            // a row with no such line keeps it in a slot of its own.
            const actions = (
              <span className="actions">
                <button
                  className="icon-btn sm hover-only"
                  tabIndex={-1}
                  aria-haspopup="menu"
                  aria-expanded={rowMenu.isOpen && rowMenuFor === r.id}
                  aria-label={`${r.title} options`}
                  title={`${entryNoun(collection)} options (Shift+F10)`}
                  // The button is for the pointer; anything that hands it focus (a menu or dialog closing) hands it
                  // on to the row, where the row's keys work.
                  onFocus={(e) => e.currentTarget.closest<HTMLElement>('[role="option"]')?.focus()}
                  onClick={(e) => (e.stopPropagation(), postMenu(e.currentTarget, r))}
                >
                  <MoreHorizontal />
                </button>
              </span>
            );
            return (
              <div
                key={r.id}
                className={cls}
                role="option"
                data-post={r.id}
                aria-selected={current}
                aria-label={status ? `${r.title}, ${status}` : r.title}
                aria-description={[why?.text, r.route].filter(Boolean).join('. ') || undefined}
                aria-keyshortcuts="Shift+F10"
                tabIndex={r.id === tabStop ? 0 : -1}
                title={[r.title, r.route].filter(Boolean).join('\n')}
                onClick={() => void open(r.id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), void open(r.id));
                  // Escape puts away a card that shows (the row cut short); a find's whole titles show none, so it leaves the find.
                  else if (e.key === 'Escape' && peek && titleCut(e.currentTarget)) (e.stopPropagation(), setPeek(null));
                  else if (e.key === 'Escape' && finding) {
                    // Escape leaves the find and keeps this row, now in its place in the whole list.
                    e.stopPropagation();
                    setQuery('');
                    requestAnimationFrame(() => (rowEl(r.id)?.scrollIntoView({ block: 'nearest' }), rowEl(r.id)?.focus({ preventScroll: true })));
                  } else if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
                    e.preventDefault();
                    const b = e.currentTarget.getBoundingClientRect();
                    setPeek(null);
                    postMenu({ x: b.left + 24, y: b.bottom, row: e.currentTarget }, r);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  postMenu({ x: e.clientX, y: e.clientY, row: e.currentTarget }, r);
                }}
              >
                <span className="post-glyph" aria-hidden="true">
                  {RowGlyph(r)}
                </span>
                <span className="post-text">
                  <span className="post-title">
                    <Marked text={r.title} words={words} />
                  </span>
                  {meta && (
                    <span className="post-meta">
                      {r.draft && <span className="badge amber post-status">Draft</span>}
                      {date && <time dateTime={r.date}>{date}</time>}
                      {actions}
                    </span>
                  )}
                  {why && <span className="post-found">{why.node}</span>}
                </span>
                {!meta && actions}
              </div>
            );
          })}
        </div>
        {(() => {
          const r = peek && !rowMenu.isOpen ? rows.find((x) => x.id === peek.id) : undefined;
          return r ? <ListPeek key={r.id} row={() => rowEl(r.id)} cut={titleCut} title={r.title} route={r.route} /> : null;
        })()}
        </div>
      </div>
      {rowMenu.node}
    </div>
  );
}
