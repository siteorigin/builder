import './PagesPanel.css';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, Copy, CornerDownRight, FilePen, FilePlus, FileText, Globe, House, LayoutTemplate, Menu, MoreHorizontal, Newspaper, Pencil, Plus, Search, Settings2, Trash2, ArrowUp, ArrowDown, Code, X } from 'lucide-react';
import { suggestRoute } from '@shared/routes';
import { MAX_PAGE_SIZE, archivePageSize, collectionRoutes, hasArchivePages, hasTermArchives, hasDetailPages } from '@shared/collections';
import { defaultArchiveDescription } from '@shared/archives';
import type { ElementRef, ProjectState } from '@shared/types';
import { redirectRecords } from '@shared/redirects';
import { aiActivity, api, applyOps, commitDraft, commitOps, confirmDialog, getState, markDraft, renamePage, setState, toast, undoAction, useStore } from '../store';
import { PAGE_ADD_DRAFT } from '../lib/pending';
import { limitNote } from '../lib/kept-drafts';
import { TEXT_LIMITS } from '@shared/text-limits';
import { DraftInput, Field, SwitchRow, keepRefusedText, openSection, rovingKeys, useMenu } from '../components/ui';
import { isImeComposing } from '../lib/ime';
import { goToShellPart, openArchiveLayout, openLayout, selectPage, setMode } from '../lib/actions';
import { visitAddress } from './Canvas';
import { headerMenu as findHeaderMenu, headerMenuRoom, headerMenuSlotUnder } from '@engine/tree';
import { isDraftPage } from '@generator/index';
import { isArticleDate, pageArticle, todayArticleDate } from '@shared/articles';
import { catalogueComponent } from '@catalogue/index';
import { pageStarterComponents, type PageStarter } from '@engine/page-starters';
import { headerOrderPlan, inHeaderMenu } from '../lib/page-navigation';
import { followsPageOrder } from '@engine/header-order';
import { setHeaderMenuOrder } from '../lib/header-menu-order';
import { listPageClicks, pageClicks } from '../lib/page-clicks';
import { ListPeek, Marked, Runs, fold, found, shortDate } from '../components/ListText';
import { CollectionSchemaDialog } from './CollectionSchemaDialog';
import { saveOpenPost } from '../lib/post-draft';

/** Addresses are at most four levels deep, so a page four levels down cannot have pages inside it. */
const MAX_DEPTH = 4;
/** From this many pages the panel offers a find field; below it the whole list fits on screen. */
const FIND_FROM = 8;

/**
 * The address a new page with this title gets inside `parent` (an address such as "/services/", or "/" for the top
 * level): its slug (made valid when it is a reserved name, which only a top-level name can be), with a numbered
 * suffix when another page already has it, kept within the 60-character segment limit. The same route is sent with
 * the create request, so the preview is exactly what the page gets.
 */
function newPageRoute(st: ProjectState, title: string, parent = '/'): { route: string; base: string; reserved?: string } {
  // Old addresses kept working count as taken: a new page is never given one without asking.
  const kept: unknown[] = redirectRecords(st);
  // So do the addresses of collections and their entries, which a page can never take.
  const held = collectionRoutes(st).map((o) => o.route);
  const taken = (r: string) => [...Object.values(st.pages).map((p) => p.route), ...kept.map((x) => (x as { from?: unknown })?.from), ...held].some((u) => typeof u === 'string' && u.toLowerCase() === r.toLowerCase());
  return suggestRoute(title, taken, 'page', parent);
}

const levels = (route: string) => route.split('/').filter(Boolean).length;
/** Whether a row cuts its title or its address short. */
const rowClipped = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>('.page-title, .page-route-dir, .page-route-leaf, .page-route-text')].some((el) => el.scrollWidth > el.clientWidth + 1);

/** What Add page can start a page with, in the order it offers them. */
const PAGE_STARTERS: Array<[PageStarter, string]> = [
  ['empty', 'Blank'],
  ['intro', 'Page introduction'],
  ['services', 'Services'],
  ['about', 'About'],
  ['contact', 'Contact'],
  ['pricing', 'Pricing'],
  ['faq', 'FAQ'],
  ['article', 'Dated article']
];

/** The sections a starter places with this theme, by the names Insert shows them under. */
function starterNote(st: ProjectState, starter: PageStarter): string {
  if (starter === 'empty') return 'No sections, ready for the first one';
  const names = pageStarterComponents(st, starter).map((id) => catalogueComponent(st.site.themeId, id)?.name ?? id);
  return names.length ? names.join(', ') : 'No sections: this theme has none of them';
}
/** Is `route` inside the section whose address is `parent`? The home page ("/") is no one's section. */
const isInside = (route: string, parent: string) => parent !== '/' && route !== parent && route.startsWith(parent);

type Place = { depth: number; parent?: string };
/**
 * The outline the page order draws: a page sits one step in under the page before it whose address contains its
 * own (/about/team/ under /about/), as long as the pages between them are inside that section too. A page whose
 * section is elsewhere in the order stays at the top level, so the outline never shows an order the site lacks.
 */
function outline(st: ProjectState, order: string[]): Map<string, Place> {
  const place = new Map<string, Place>();
  const open: string[] = [];
  for (const id of order) {
    const route = st.pages[id]?.route ?? '';
    while (open.length && !isInside(route, st.pages[open[open.length - 1]].route)) open.pop();
    place.set(id, { depth: open.length, parent: open[open.length - 1] });
    if (route !== '/') open.push(id);
  }
  return place;
}

/** A page and the pages drawn under it: they move together. */
function blockOf(order: string[], place: Map<string, Place>, id: string): string[] {
  const i = order.indexOf(id);
  const d = place.get(id)?.depth ?? 0;
  let j = i + 1;
  while (j < order.length && (place.get(order[j])?.depth ?? 0) > d) j++;
  return order.slice(i, j);
}

/**
 * The order with `id` and its pages moved to before (or after) `target`, or null when that changes nothing or would
 * move any page in or out of a section: a move changes where a page is listed, never which section it is drawn in.
 * `into` is the one exception, for Move under: the page joins that section, and no other page changes.
 */
function moved(st: ProjectState, order: string[], place: Map<string, Place>, id: string, target: string, after: boolean, into?: string): string[] | null {
  const block = blockOf(order, place, id);
  if (block.includes(target)) return null;
  const rest = order.filter((x) => !block.includes(x));
  rest.splice(rest.indexOf(target) + (after ? 1 : 0), 0, ...block);
  if (rest.every((x, k) => x === order[k])) return null;
  const next = outline(st, rest);
  for (const x of order) {
    if (x !== id && block.includes(x)) continue;
    const a = x === id && into ? { depth: (place.get(into)?.depth ?? 0) + 1, parent: into } : place.get(x);
    const b = next.get(x);
    if (a?.depth !== b?.depth || a?.parent !== b?.parent) return null;
  }
  return rest;
}

/**
 * Move up or down past the next page at its level (a section with its pages), or null at the end. A place where the
 * page would join a section it is not in is passed over: it goes on to the one beyond.
 */
function stepped(st: ProjectState, order: string[], place: Map<string, Place>, id: string, by: -1 | 1): string[] | null {
  const d = place.get(id)?.depth ?? 0;
  const at = (x: string) => place.get(x)?.depth ?? 0;
  let k = order.indexOf(id);
  for (;;) {
    if (by < 0) {
      k--;
      while (k >= 0 && at(order[k]) > d) k--;
      if (k < 0 || at(order[k]) < d) return null;
      const o = moved(st, order, place, id, order[k], false);
      if (o) return o;
    } else {
      k += blockOf(order, place, order[k]).length;
      if (k >= order.length || at(order[k]) < d) return null;
      const next = blockOf(order, place, order[k]);
      const o = moved(st, order, place, id, next[next.length - 1], true);
      if (o) return o;
    }
  }
}

/** The section page an address belongs under (the page with the longest address containing it), if there is one. */
function sectionFor(st: ProjectState, order: string[], id: string): string | undefined {
  const route = st.pages[id]?.route ?? '';
  let best: string | undefined;
  for (const x of order) if (isInside(route, st.pages[x].route) && (!best || st.pages[x].route.length > st.pages[best].route.length)) best = x;
  return best;
}

/**
 * Marks the page's own segment `cut` while it is wider than its room, so it gives way from its start behind a "…" of
 * its own: the end is what tells a page from its neighbours, and the text keeps to the column (a browser's start-side
 * ellipsis drops whole glyphs and leaves the slack on the column side).
 */
function useCutStart(deps: unknown[]) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const text = el?.firstElementChild as HTMLElement | null;
    if (!el || !text) return;
    // Inline while it fits (its box is its width), clipped by itself once cut (its scroll width is its width).
    const check = () => el.classList.toggle('cut', Math.max(text.scrollWidth, text.getBoundingClientRect().width) > el.clientWidth + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, deps);
  return ref;
}

/**
 * A page's address. A long one shortens its parent folders from their start and keeps the page's own segment with
 * its slash ("…tfolio/kowhai-street-apartment/"). A page drawn under its section shows the address from there on
 * ("…/kowhai-street-apartment/"): the section's own row, just above, says the rest. While finding, matches are
 * worked out on the whole address, and an address matched only in its folders keeps its start in view instead.
 */
function RouteText({ route, words, within }: { route: string; words: string[]; within?: string }) {
  const shown = within && route.startsWith(within) && route !== within ? `…${route.slice(within.length - 1)}` : route;
  const chars = [...shown];
  const hit = found(shown, words);
  const cut = chars.length > 1 ? chars.lastIndexOf('/', chars.length - 2) : 0;
  const folderOnly = hit.some(Boolean) && !hit.slice(cut).some(Boolean);
  // Re-measured when the text or its split changes; the observer covers the room it is given.
  const leaf = useCutStart([shown, cut, folderOnly]);
  // A relative address ("…/team/") has no folders of its own to shorten.
  if (cut <= (shown.startsWith('…') ? 1 : 0) || folderOnly)
    return (
      <span className="page-route">
        <span className="page-route-leaf" ref={leaf}>
          <span className="page-route-text">
            <bdi dir="ltr">
              <Runs chars={chars} hit={hit} />
            </bdi>
          </span>
        </span>
      </span>
    );
  return (
    // The folders' length is on the pair, so the page's own segment leaves the same room the folders keep.
    <span className="page-route" style={{ '--dir-ch': cut } as React.CSSProperties}>
      {/* Shortened from its start, so what stays is the part next to the page's own segment. */}
      <span className="page-route-dir">
        {'\u200e'}
        <Runs chars={chars} hit={hit} to={cut} />
        {'\u200e'}
      </span>
      <span className="page-route-leaf" ref={leaf}>
        <span className="page-route-text">
          <bdi dir="ltr">
            <Runs chars={chars} hit={hit} from={cut} />
          </bdi>
        </span>
      </span>
    </span>
  );
}


/**
 * The site's pages, in page order, drawn as an outline: a page sits under the section page before it whose address
 * contains its own. Each row is the page's title over a line with its status and address; the current page carries
 * a filled glyph tile (and the ring while the page itself is in the inspector). Row actions live in the … menu, which
 * shows on the current, hovered, focused and menu-open rows, and is reachable from any row by keyboard (Shift+F10).
 * Type a page's first letters to jump to it; on a long site, the find field matches words anywhere in a title or
 * address.
 */
export function PagesPanel() {
  const snap = useStore((s) => s.snapshot);
  const pageId = useStore((s) => s.pageId);
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  // The page the new page goes inside (its section), or null for the top level.
  const [parentId, setParentId] = useState<string | null>(null);
  const [addToNav, setAddToNav] = useState(true);
  // What the new page starts with (see PAGE_STARTERS): an article is dated (news, an announcement).
  const [starter, setStarter] = useState<PageStarter>('intro');
  const asArticle = starter === 'article';
  const [articleDate, setArticleDate] = useState(todayArticleDate);
  // Whether the author chose the menu option themselves: choosing an article or a section then leaves it alone.
  const navChosen = useRef(false);
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameBox, setRenameBox] = useState<{ top: number; left: number; width: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  // The page just added, marked for a moment so the eye finds where it landed.
  const [justAdded, setJustAdded] = useState<string | null>(null);
  // What the last move did, for screen readers.
  const [announce, setAnnounce] = useState('');
  // A move is said once: finding again starts from silence, so an old move is never read out as new.
  useEffect(() => setAnnounce(''), [query]);
  // The row keyboard focus is on, whose full title and address show in a card beside the list while it clips them.
  // Escape puts the card away until focus moves to another row.
  const [peek, setPeek] = useState<{ id: string } | null>(null);
  // The page just moved here, with the pages listed under it that moved along. Pages and the header menu have orders
  // of their own, so once the project shows the move (`revision`, the project's once it was saved, and `order`, Pages
  // as it left it) the move says what it did to the menu: nothing, for pages outside it or a menu already in that
  // order, or else a note offering to bring the menu along (`shown`). The note goes once answered, once the two orders
  // agree, or once Pages moves on (an Undo, a move).
  const [lastMove, setLastMove] = useState<{ pageId: string; pages: string[]; opening: string; revision: number; order: string[]; shown?: boolean } | null>(null);
  const [matching, setMatching] = useState(false);
  const movedIn = lastMove && snap?.workspaceKey === lastMove.opening && snap.revision >= lastMove.revision ? snap : null;
  const standing = !!lastMove && !!movedIn && movedIn.state.site.pageOrder.length === lastMove.order.length && movedIn.state.site.pageOrder.every((id, i) => id === lastMove.order[i]);
  // A section moves with its pages: any of them in the menu (at the top level or in a submenu) has a place to follow.
  const inMenu = standing && lastMove!.pages.some((id) => inHeaderMenu(movedIn!.state, id));
  // A menu that follows the pages moved with them, in the same change: there is nothing to say or offer.
  const following = !!movedIn && followsPageOrder(movedIn.state);
  const orderPlan = inMenu && !following ? headerOrderPlan(movedIn!.state) : null;
  useEffect(() => {
    if (!lastMove) return;
    if (snap?.workspaceKey !== lastMove.opening) return setLastMove(null);
    // Not shown in the project yet.
    if (!movedIn) return;
    if (following) return setLastMove(null);
    if (orderPlan) {
      if (!lastMove.shown) setLastMove({ ...lastMove, shown: true });
      return;
    }
    const name = movedIn.state.pages[lastMove.pageId]?.title;
    const along = lastMove.pages.length > 1;
    if (!lastMove.shown && standing && name && findHeaderMenu(movedIn.state))
      toast(
        inMenu
          ? `Moved “${name}” in Pages. The header menu has its own order, and it already lists these pages this way.`
          : `Moved “${name}” in Pages. ${along ? 'Neither it nor the pages inside it are' : 'It isn’t'} in the header menu, so the menu is unchanged.`,
        'info'
      );
    setLastMove(null);
  }, [lastMove, snap]);
  const menu = useMenu();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const typeahead = useRef({ text: '', at: 0 });
  // The row whose menu opened Add page inside, so Cancel can go back to it.
  const addFrom = useRef<string | null>(null);
  /** The row keyboard focus was last on: it holds the list's tab stop (APG listbox), so Tab out of the list,
   *  or out of a row's menu, continues from it. Opening a page moves the stop to that page. */
  const [focusedRow, setFocusedRow] = useState<string | null>(null);
  useEffect(() => setFocusedRow(null), [pageId]);
  // A new page with a title typed is waiting for Add page; an empty form holds nothing to lose.
  const addPending = adding && !!title.trim();
  useEffect(() => {
    markDraft(PAGE_ADD_DRAFT, addPending);
    return () => markDraft(PAGE_ADD_DRAFT, false);
  }, [addPending]);
  // The project and the AI's activity when renaming began: if the AI ran meanwhile, the new title is checked
  // against that project before it is applied.
  const renameBase = useRef<{ snap: ReturnType<typeof getState>['snapshot']; ai: number } | null>(null);
  useEffect(() => {
    markDraft('page-rename', !!renaming);
    if (renaming) renameBase.current = { snap: getState().snapshot, ai: aiActivity() };
    return () => markDraft('page-rename', false);
  }, [renaming]);
  const titleOver = title.trim().length > TEXT_LIMITS.pageTitle ? title.trim().length : 0;
  /**
   * Open the Add page form, optionally inside a section and with a title already typed. An open form keeps what is
   * in it: opening it again only moves focus there, or sets the section when one was asked for.
   */
  const openForm = (inside?: string | null, typed?: string) => {
    // Opened from anywhere but a row's Add page inside, Cancel goes back to the header button.
    if (!inside) addFrom.current = null;
    if (inside !== undefined) chooseParent(inside);
    if (typed !== undefined) setTitle(typed);
    setAdding((was) => {
      // A new article is dated today, as the day is when the form opens.
      if (!was) setArticleDate(todayArticleDate());
      return true;
    });
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ block: 'nearest' });
      addInput.current?.focus({ preventScroll: true });
    });
  };
  /** A page inside a section rarely belongs in the header menu, unless the author said otherwise. */
  const chooseParent = (id: string | null) => {
    setParentId(id);
    if (!navChosen.current) setAddToNav(!id && !asArticle);
  };
  useEffect(() => {
    const open = () => openForm();
    window.addEventListener('builder-add-page', open);
    return () => window.removeEventListener('builder-add-page', open);
  }, []);
  useEffect(() => {
    if (!justAdded) return;
    const t = setTimeout(() => setJustAdded(null), 1600);
    return () => clearTimeout(t);
  }, [justAdded]);
  // The rename field sits over the row's title but outside the listbox, so it is an ordinary text field. It is placed
  // again each time the list is drawn (a page moved or added above it) and as the sidebar or the rows change size.
  // Scrolling moves it with its row, since both are in the panel's scroller.
  const placeRename = () => {
    const wrap = wrapRef.current?.getBoundingClientRect();
    const row = renaming ? listRef.current?.querySelector<HTMLElement>(`[data-page="${renaming}"]`) : null;
    const t = row?.querySelector('.page-title')?.getBoundingClientRect();
    const r = row?.getBoundingClientRect();
    if (!wrap || !t || !r) return;
    const box = { top: t.top - wrap.top - 2, left: t.left - wrap.left - 5, width: r.right - 6 - t.left + 5 };
    setRenameBox((was) => (was && was.top === box.top && was.left === box.left && was.width === box.width ? was : box));
  };
  // A page that leaves the list while it is being renamed: removed (by the AI, an Undo), the rename ends; no longer
  // matching the find, the find clears (see renameGone).
  const renameGone = useRef<(id: string) => void>(() => {});
  useLayoutEffect(() => {
    if (!renaming) return void (renameBox && setRenameBox(null));
    if (snap && !listRef.current?.querySelector(`[data-page="${renaming}"]`)) return renameGone.current(renaming);
    placeRename();
  });
  useEffect(() => {
    if (!renaming) return;
    const sized = new ResizeObserver(() => placeRename());
    for (const el of [wrapRef.current, listRef.current, listRef.current?.querySelector(`[data-page="${renaming}"]`)]) if (el) sized.observe(el);
    return () => sized.disconnect();
  }, [renaming]);
  // Focus once the field is placed (a hidden field cannot take focus), and only then: being placed again as the list
  // changes leaves the caret and the selection where the author put them.
  const placed = renameBox !== null;
  useEffect(() => {
    if (placed) renameInput.current?.focus({ preventScroll: true });
  }, [renaming, placed]);
  // A pointer click on a row opens its page once no second click follows; a double click renames the page where it is
  // (see pageClicks). Anything else done meanwhile, a key or a press anywhere but that row, shows the click was single,
  // and the page opens first, so what comes next (Layers, a shortcut) acts on it.
  const clickActions = useRef<{ open: (id: string) => void; rename: (id: string) => void }>({ open: () => {}, rename: () => {} });
  const [clicks] = useState(() => pageClicks({ open: (id) => clickActions.current.open(id), rename: (id) => clickActions.current.rename(id) }));
  const opening = snap?.workspaceKey;
  useEffect(() => {
    const press = (e: PointerEvent) => {
      const id = clicks.waiting();
      if (!id) return;
      const t = e.target instanceof Element ? e.target : null;
      // A press on that row may be the second click, or a press of its options button (which settles the click
      // itself, see pageMenu): it is held until its click, so the row stays where it is under the pointer.
      const row = t?.closest<HTMLElement>('[data-page]');
      if (e.button === 0 && row?.dataset.page === id && listRef.current?.contains(row)) return clicks.hold();
      clicks.settle();
    };
    // A held press that ends in no click on the row (released somewhere else) was not a second click. Its click, when
    // there is one, comes first and settles it (a rename, the options); a fresh click on the row is not this one.
    const release = () => {
      const id = clicks.held() ? clicks.waiting() : null;
      if (id) setTimeout(() => clicks.waiting() === id && clicks.held() && clicks.settle(), 0);
    };
    const other = () => clicks.settle();
    document.addEventListener('pointerdown', press, true);
    document.addEventListener('pointerup', release, true);
    // A press the browser takes over (a swipe that scrolls) never ends in a click.
    document.addEventListener('pointercancel', other, true);
    document.addEventListener('keydown', other, true);
    // Focus leaving the editor's window (for the preview, another app) shows the click was single; a pick in the
    // preview settles it too (see settlePageClick).
    window.addEventListener('blur', other);
    const unlist = listPageClicks(clicks);
    return () => {
      document.removeEventListener('pointerdown', press, true);
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', other, true);
      document.removeEventListener('keydown', other, true);
      window.removeEventListener('blur', other);
      unlist();
      // Another project, or no Pages list: the click waiting is for a page that is no longer here.
      clicks.drop();
    };
  }, [clicks, opening]);
  // When the current page changes (from here, the toolbar, the canvas or the command menu), its row is
  // brought into view without taking focus; scrolling the list by hand in between is left alone.
  useEffect(() => {
    if (!pageId || !listRef.current?.offsetParent) return;
    listRef.current.querySelector<HTMLElement>(`[data-page="${pageId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [pageId]);
  if (!snap) return null;
  const st = snap.state;
  // The modifier this platform's keys use, as the row's shortcuts are announced.
  const mac = api.platform === 'darwin';
  const order = st.site.pageOrder;
  const homeId = st.site.homePageId;
  const place = outline(st, order);
  const depthOf = (id: string) => place.get(id)?.depth ?? 0;
  const words = fold(query).split(/\s+/).filter(Boolean);
  const finding = words.length > 0;
  const matches = (id: string) => {
    const p = st.pages[id];
    const hay = `${fold(p.title)} ${fold(p.route)}`;
    return words.every((w) => hay.includes(w));
  };
  const shown = finding ? order.filter(matches) : order;
  const showFind = order.length >= FIND_FROM || finding;
  const tabStop = focusedRow && shown.includes(focusedRow) ? focusedRow : pageId && shown.includes(pageId) ? pageId : shown[0];

  // After an inline edit ends, keyboard focus goes back to what it was about, unless the user has
  // already clicked somewhere else.
  const refocus = (sel: string) =>
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      wrapRef.current?.closest('.side-panel-view')?.querySelector<HTMLElement>(sel)?.focus();
    });
  const rowEl = (id: string) => listRef.current?.querySelector<HTMLElement>(`[data-page="${id}"]`);
  /** Keyboard focus on a row: its card beside the list shows while its title or address is cut short. */
  const showPeek = (row: HTMLElement | null) => setPeek(row?.matches(':focus-visible') && !renaming && !dragId ? { id: row.dataset.page! } : null);

  /**
   * Open a page, at its remembered place or at `target` (null: the page itself; see selectPage). From a filtered list
   * the find is cleared, so the page shows in its place in the outline.
   */
  const open = (id: string, focus = false, target?: ElementRef | null) => {
    selectPage(id, target);
    if (!finding) return;
    setQuery('');
    requestAnimationFrame(() => {
      rowEl(id)?.scrollIntoView({ block: 'nearest' });
      if (focus) rowEl(id)?.focus({ preventScroll: true });
    });
  };
  // A page clicked a moment ago opens only while it is still in the project.
  clickActions.current = { open: (id) => Object.hasOwn(getState().snapshot?.state.pages ?? {}, id) && open(id), rename: setRenaming };
  renameGone.current = (id) => {
    // Still a page, no longer matching the find (the AI changed its address): the find clears, so its row comes back
    // under the field, brought into view, and the author goes on typing.
    if (Object.hasOwn(st.pages, id) && finding) {
      setQuery('');
      return void requestAnimationFrame(() => rowEl(id)?.scrollIntoView({ block: 'nearest' }));
    }
    // Removed: there is no page left to give the title to.
    renameBase.current = null;
    setRenaming(null);
  };

  const closeForm = () => {
    addFrom.current = null;
    setTitle('');
    setAdding(false);
    setStarter('intro');
    setParentId(null);
    // The author's own header-menu choice lasts as long as the form it was made in.
    setAddToNav(true);
    navChosen.current = false;
  };
  // A half-typed or cleared date is no date: the article waits for a whole one rather than taking another.
  const dateMissing = asArticle && !isArticleDate(articleDate);
  const cancelAdd = () => {
    if (creating) return;
    // Back where adding started: the row whose menu asked for a page inside it, or the header button.
    const from = addFrom.current;
    closeForm();
    if (from && order.includes(from)) requestAnimationFrame(() => (rowEl(from)?.scrollIntoView({ block: 'nearest' }), rowEl(from)?.focus({ preventScroll: true })));
    else refocus('.pages-head-add');
  };
  const parent = parentId && st.pages[parentId] && levels(st.pages[parentId].route) < MAX_DEPTH ? st.pages[parentId] : null;
  const { route: newRoute, base: newBase, reserved: newReserved } = newPageRoute(st, title, parent?.route ?? '/');
  /** Where a new page goes in the order: after the last page of its section, or at the end of the list. */
  const placeAfter = (() => {
    if (!parent) return undefined;
    let i = order.indexOf(parent.id);
    while (i + 1 < order.length && isInside(st.pages[order[i + 1]]?.route ?? '', parent.route)) i++;
    return order[i];
  })();
  // The sections a page can go inside: every page but Home, and not one already four levels down.
  const sections = order.filter((id) => id !== homeId && levels(st.pages[id].route) < MAX_DEPTH);
  // The shared header's menu: its instance, when it has a navigation list a page link can join.
  const menuOf = findHeaderMenu(st);
  const headerMenu = menuOf ? { id: menuOf.node.id } : null;
  // A page inside another joins the menu under that page's link, when the menu groups links and has one.
  const menuItems = (menuOf?.node.props.links ?? menuOf?.schema.default ?? []) as Array<Record<string, unknown>>;
  const slotUnder = parent && menuOf ? headerMenuSlotUnder(st, menuItems, parent.id) : null;
  const navNote = parent && slotUnder?.sub ? (slotUnder.under ? `under ${slotUnder.under}` : `in the submenu of ${parent.title}’s link`) : null;
  // A menu holding as many links as it takes has no room for the new page: shown before it is added, not after.
  const room = headerMenuRoom(st);
  const menuMax = room?.max;
  const menuFull = !!room?.full;
  /** Select the shared header and land on its navigation list, ready to edit. */
  const editMenu = () => {
    if (!headerMenu) return;
    // Its menu is edited on a page that shows the header.
    if (!goToShellPart('header')) return toast('No page shows the shared header. Turn it on in a page’s settings to edit its menu.', 'info');
    setState({ selection: { owner: { kind: 'shell', id: 'header' }, instancePath: [], nodeId: headerMenu.id }, rightTab: 'inspect', dockOpen: true, definitionMode: null });
    setTimeout(() => {
      openSection('content');
      setTimeout(() => {
        const list = document.querySelector<HTMLElement>('#dock-panel-inspect [data-list="links"]');
        list?.scrollIntoView({ block: 'nearest' });
        (list?.querySelector<HTMLElement>('.list-editor-head .title') ?? list?.querySelector<HTMLElement>('.insp-add'))?.focus();
      }, 250);
    }, 50);
  };
  const add = async () => {
    const t = title.trim();
    if (!t || creating || dateMissing || titleOver) return;
    setCreating(true);
    const nav = addToNav && !!headerMenu && !menuFull;
    // Sent against the snapshot the address was previewed on: a project that changed meanwhile previews again
    // rather than taking an address it no longer has free.
    const kind = asArticle ? { starter, articleDate } : { starter };
    const r = await applyOps(
      [{ type: 'page.create', title: t, route: newRoute, ...kind, ...(placeAfter ? { afterPageId: placeAfter } : {}), addToNavigation: nav || undefined }],
      asArticle ? `Add article ${t}` : `Add page ${t}`,
      undefined,
      snap?.revision
    );
    setCreating(false);
    const id = r?.[0]?.pageId as string | undefined;
    if (!id) return addInput.current?.focus();
    if (nav && r?.[0]?.addedToNavigation === false) toast(`Added ${t}. The header menu is full, so it isn’t in the menu yet.`, 'info', { label: 'Edit menu', run: editMenu });
    closeForm();
    setQuery('');
    selectPage(id);
    setJustAdded(id);
    setTimeout(() => {
      rowEl(id)?.scrollIntoView({ block: 'nearest' });
      refocus(`[data-page="${id}"]`);
    }, 50);
  };
  /**
   * Reorder, then bring the page that moved into view and say where it is now ("Services moved up, 2 of 7 at the
   * top level"). A move made from the keyboard or a row's menu ends with focus on that row, where its keys work. The
   * header menu keeps its own order, and the move says so (see lastMove).
   */
  const moveTo = async (id: string, o: string[] | null, how: string, focus: boolean) => {
    if (!o) return;
    const opening = snap.workspaceKey;
    // The page and the pages listed under it, which move with it.
    const pages = blockOf(order, place, id);
    const r = await commitOps([{ type: 'page.reorder', pageIds: o }], 'Reorder pages');
    if (!r) return;
    // The header menu keeps its own order: once the project shows the move, the move says what it did to the menu.
    if (r.workspaceKey === opening && getState().snapshot?.workspaceKey === opening) setLastMove({ pageId: id, pages, opening, revision: r.revision, order: o });
    const after = outline(st, o);
    const section = after.get(id)?.parent;
    const level = o.filter((x) => after.get(x)?.parent === section && (after.get(x)?.depth ?? 0) === (after.get(id)?.depth ?? 0));
    setAnnounce(`${st.pages[id].title} ${how}, ${level.indexOf(id) + 1} of ${level.length} ${section ? `in ${st.pages[section].title}` : 'at the top level'}`);
    requestAnimationFrame(() => {
      const row = rowEl(id);
      row?.scrollIntoView({ block: 'nearest' });
      if (focus) row?.focus({ preventScroll: true });
      if (row && document.activeElement === row) showPeek(row);
    });
  };
  const move = (id: string, by: -1 | 1) => void moveTo(id, stepped(st, order, place, id, by), by < 0 ? 'moved up' : 'moved down', true);
  /** Where Move under puts a page listed away from its section: at the end of that section, or null if it cannot. */
  const underOrder = (id: string, section: string) => {
    const end = blockOf(order, place, section);
    return moved(st, order, place, id, end[end.length - 1], true, section);
  };
  /** Answer the move's note: focus goes back to the page that moved, where the list's keys work. */
  const endNote = (id: string) => {
    setLastMove(null);
    refocus(`[data-page="${id}"]`);
  };
  /** Reorder the header menu's page links to follow Pages, keeping every other link where it is and each submenu whole. */
  const matchMenu = async () => {
    const now = getState().snapshot;
    const plan = now && headerOrderPlan(now.state);
    if (!now || !plan) return setLastMove(null);
    setMatching(true);
    // Against the project the plan was made from: one that has changed since is planned again.
    const r = await commitOps(plan.ops, 'Match header menu to page order', undefined, now.revision);
    setMatching(false);
    if (!r || getState().snapshot?.workspaceKey !== r.workspaceKey) return;
    if (lastMove) endNote(lastMove.pageId);
    toast('The header menu now lists its pages in the same order as Pages.', 'info', undoAction(r));
  };
  /** Make the header menu follow Pages from now on: its page links move into that order once the lists are shown. */
  const followPages = async () => {
    setMatching(true);
    const done = await setHeaderMenuOrder('follow');
    setMatching(false);
    if (done && lastMove) endNote(lastMove.pageId);
  };
  const endDrag = () => (setDragId(null), setDropAt(null));
  const endRename = (id: string, value?: string) => {
    setRenaming(null);
    refocus(`[data-page="${id}"]`);
    const v = value?.trim();
    const from = renameBase.current;
    renameBase.current = null;
    const was = from?.snap?.state.pages[id]?.title ?? st.pages[id]?.title;
    if (!v || v === was) return;
    // Too long for a title: nothing is cut off or saved. The whole text goes to the page's Title field, refused there
    // with the reason as if typed there (Escape there keeps the old title), and the page's settings open to show it.
    if (v.length > TEXT_LIMITS.pageTitle) {
      const commit = (t: string) => void renamePage(id, was ?? '', t.trim());
      keepRefusedText(`page:${id}:title`, v, { base: from?.snap ?? getState().snapshot, value: was ?? '', commit, ai: from?.ai ?? aiActivity() }, 'Title', TEXT_LIMITS.pageTitle, () => Object.hasOwn(getState().snapshot?.state.pages ?? {}, id));
      selectPage(id, null);
      setState({ rightTab: 'inspect', dockOpen: true, keptHandoff: getState().keptHandoff + 1 });
      toast(`A page title can be up to ${TEXT_LIMITS.pageTitle} characters, and this one is ${v.length}, so it was not saved. It is in the page’s settings to shorten.`, 'error');
      return;
    }
    // The labels that still say the old title are offered alongside once the rename is saved.
    const rename = () => void renamePage(id, was ?? '', v);
    if (from && (getState().snapshot?.aiBusy || aiActivity() !== from.ai)) commitDraft(from.snap, rename, v, { check: true });
    // Otherwise written only while the title is still the one renaming began from (see commitOps).
    else commitDraft(from?.snap ?? null, rename, v);
  };

  const pageMenu = (el: HTMLElement | { x: number; y: number; row: HTMLElement }, id: string) => {
    // A row clicked a moment ago opens first: the menu acts on the page as it then is.
    clicks.settle();
    const isHome = id === homeId;
    const draft = isDraftPage(st, st.pages[id]);
    const within = place.get(id)?.parent;
    const under = blockOf(order, place, id).length - 1;
    const withPages = under ? `with ${under === 1 ? 'its page' : `its ${under} pages`}` : undefined;
    const home = sectionFor(st, order, id);
    const underMove = home && home !== within ? underOrder(id, home) : null;
    setMenuFor(id);
    const duplicate = async (asDraft: boolean) => {
      const r = await applyOps([{ type: 'page.duplicate', pageId: id, ...(asDraft ? { draft: true } : {}) }], `Duplicate page ${st.pages[id].title}${asDraft ? ' as a draft' : ''}`);
      const copy = r?.[0]?.pageId as string | undefined;
      if (!copy) return;
      // The copy is the page now open, shown in its place, with focus on it so F2 renames the copy.
      setQuery('');
      selectPage(copy);
      setJustAdded(copy);
      requestAnimationFrame(() => (rowEl(copy)?.scrollIntoView({ block: 'nearest' }), rowEl(copy)?.focus({ preventScroll: true })));
    };
    const openAt = (items: Parameters<typeof menu.openAt>[1], label: string) => (el instanceof HTMLElement ? menu.openAt(el, items, label) : menu.open(el.x, el.y, items, label, el.row));
    openAt([
      { heading: st.pages[id].title },
      { label: 'Page settings', icon: <Settings2 />, onSelect: () => (open(id, false, null), setState({ rightTab: 'inspect', dockOpen: true })) },
      { label: 'Rename', icon: <Pencil />, shortcut: 'F2', onSelect: () => setRenaming(id) },
      // Home is the top level itself, and an address four levels down has no room for another.
      ...(isHome || levels(st.pages[id].route) >= MAX_DEPTH ? [] : [{ label: 'Add page inside', icon: <FilePlus />, onSelect: () => ((addFrom.current = id), setQuery(''), openForm(id)) }]),
      { label: 'Duplicate', icon: <Copy />, onSelect: () => void duplicate(false) },
      // A working copy of a published page stays out of the website until it is published.
      ...(draft ? [] : [{ label: 'Duplicate as draft', icon: <FilePen />, hint: 'Leave out of website', onSelect: () => void duplicate(true) }]),
      // The Home page is always published, so a draft is published before it can be Home.
      ...(isHome
        ? []
        : [{ label: 'Make home page…', icon: <House />, hint: draft ? 'Publish it first' : undefined, disabled: draft, onSelect: () => setState({ modal: { kind: 'set-home', pageId: id } }) }]),
      ...(isHome
        ? []
        : [
            draft
              ? { label: 'Publish page', icon: <Globe />, hint: 'Include in website', onSelect: () => void applyOps([{ type: 'page.update', pageId: id, draft: false }], `Publish page ${st.pages[id].title}`) }
              : { label: 'Make draft', icon: <FilePen />, hint: 'Leave out of website', onSelect: () => void applyOps([{ type: 'page.update', pageId: id, draft: true }], `Make page ${st.pages[id].title} a draft`) }
          ]),
      ...(useStore.getState().settings?.developerMode ? [{ label: 'View generated source…', icon: <Code />, onSelect: () => setState({ modal: { kind: 'page-source', pageId: id } }) }] : []),
      // Moves keep to the page's level: a section moves with its pages, a page stays in its section.
      { heading: within ? `Order in ${st.pages[within].title}` : 'Page order' },
      { label: 'Move up', icon: <ArrowUp />, hint: finding ? 'Clear find to reorder' : withPages, shortcut: '⇧⌘↑', disabled: finding || !stepped(st, order, place, id, -1), onSelect: () => move(id, -1) },
      { label: 'Move down', icon: <ArrowDown />, hint: finding ? 'Clear find to reorder' : withPages, shortcut: '⇧⌘↓', disabled: finding || !stepped(st, order, place, id, 1), onSelect: () => move(id, 1) },
      // A page listed away from its section (its address says where it belongs) can be put back under it.
      ...(home && home !== within
        ? [
            {
              label: `Move under ${st.pages[home].title}`,
              icon: <CornerDownRight />,
              // The same move the item makes decides whether it is offered.
              hint: finding ? 'Clear find to reorder' : underMove ? (withPages ?? 'Keeps its address') : 'Would regroup other pages',
              disabled: finding || !underMove,
              onSelect: () => void moveTo(id, underMove, `moved under ${st.pages[home].title}`, true)
            }
          ]
        : []),
      { separator: true },
      { label: 'Delete page…', icon: <Trash2 />, danger: true, disabled: order.length <= 1 && id !== st.site.homePageId, onSelect: () => setState({ modal: { kind: 'delete-page', pageId: id } }) }
    ], `${st.pages[id].title} options`);
  };

  // Type-ahead: printable keys jump to the next page whose title starts with what was typed.
  const typeAhead = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey || e.key === ' ') return false;
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.isContentEditable) return false;
    const ta = typeahead.current;
    const now = Date.now();
    ta.text = now - ta.at > 700 ? e.key.toLowerCase() : ta.text + e.key.toLowerCase();
    ta.at = now;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const cur = rows.indexOf((document.activeElement as HTMLElement)?.closest('[role="option"]') as HTMLElement);
    // A single repeated letter cycles; a longer prefix keeps the current row if it still matches.
    const repeat = ta.text.length > 1 && [...ta.text].every((c) => c === ta.text[0]);
    const needle = fold(repeat ? ta.text[0] : ta.text);
    const start = needle.length > 1 ? Math.max(0, cur) : cur + 1;
    for (let k = 0; k < rows.length; k++) {
      const r = rows[(start + k) % rows.length];
      if (fold(st.pages[r.dataset.page!]?.title ?? '').startsWith(needle)) {
        e.preventDefault();
        // Focus only: opening a page is Enter or Space, so typing never sends the preview through pages.
        if (r !== rows[cur]) r.focus();
        return true;
      }
    }
    return true;
  };

  // A drop shows its line only where it would change the order without moving any other page in or out of a
  // section; the line's dot sits at the depth the page will have there.
  const dragBlock = dragId ? blockOf(order, place, dragId) : [];
  const dropTarget = (id: string, after: boolean) => (dragId && moved(st, order, place, dragId, id, after) ? { id, after } : null);
  const dropOrder = dragId && dropAt ? moved(st, order, place, dragId, dropAt.id, dropAt.after) : null;
  const dropDepth = dragId && dropOrder ? (outline(st, dropOrder).get(dragId)?.depth ?? 0) : 0;

  const onFindKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(e)) return;
    if (e.key === 'ArrowDown' && shown.length) {
      e.preventDefault();
      rowEl(finding || !shown.includes(tabStop) ? shown[0] : tabStop)?.focus();
    } else if (e.key === 'Enter' && finding && shown.length) {
      e.preventDefault();
      open(shown[0], true);
    } else if (e.key === 'Escape' && query) {
      e.stopPropagation();
      setQuery('');
    }
  };

  const language = st.site.language;
  return (
    <div className="pages-panel">
      <div className="panel-head">
        <h3>Pages</h3>
        {headerMenu && (
          <button className="btn btn-sm btn-ghost pages-head-menu" onClick={editMenu} aria-label="Edit menu (shared header)" title="Edit the links in the shared header’s menu">
            <Menu aria-hidden="true" />
            <span className="pages-head-label">Edit menu</span>
          </button>
        )}
        <button
          className="btn btn-sm btn-ghost pages-head-add"
          aria-expanded={adding}
          // With an empty form open, this button closes it: keep the press from blurring the form first.
          onMouseDown={(e) => adding && !title.trim() && e.preventDefault()}
          aria-controls={adding ? 'pages-add-form' : undefined}
          onClick={() => (adding && !title.trim() ? cancelAdd() : openForm())}
        >
          <Plus aria-hidden="true" /> Add page
        </button>
      </div>
      {showFind && (
        <div className={`search pages-find${query ? ' has-query' : ''}`}>
          <Search aria-hidden="true" />
          <input
            ref={findInput}
            className="input"
            placeholder={`Find among ${order.length} pages`}
            aria-label="Find a page by title or address"
            aria-controls="pages-listbox"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onFindKey}
          />
          {query && (
            <button className="icon-btn sm pages-find-clear" aria-label="Clear find" title="Clear (Esc)" onClick={() => (setQuery(''), findInput.current?.focus())}>
              <X />
            </button>
          )}
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {finding ? (shown.length ? `${shown.length} of ${order.length} pages` : 'No page matches') : ''}
      </span>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
      <div className="panel-body" ref={bodyRef}>
        {adding && (
          <div
            ref={formRef}
            // A click on the form's own text or padding keeps focus where it is, so an empty form is not dismissed.
            onMouseDown={(e) => {
              if (!(e.target as HTMLElement).closest('input, select, button, label')) e.preventDefault();
            }}
            id="pages-add-form"
            className="pages-add-form"
            role="group"
            aria-labelledby="pages-add-heading"
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !isImeComposing(e)) (e.stopPropagation(), cancelAdd());
            }}
            // Leaving the form never creates a page by itself: an empty form just goes away, a titled one
            // waits for Add page or Cancel.
            onBlur={(e) => {
              if (!title.trim() && !e.currentTarget.contains(e.relatedTarget as Node | null)) closeForm();
            }}
          >
            <div className="pages-add-heading" id="pages-add-heading">
              {asArticle ? 'New article' : 'New page'}
            </div>
            <input
              ref={addInput}
              className="input inline-edit"
              autoFocus
              placeholder={asArticle ? 'Article title' : 'Page title'}
              aria-label={asArticle ? 'New article title' : 'New page title'}
              aria-describedby={titleOver ? 'pages-add-title-note pages-add-route' : 'pages-add-route'}
              aria-invalid={titleOver > 0 || undefined}
              value={title}
              readOnly={creating}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isImeComposing(e)) void add();
              }}
            />
            {titleOver > 0 && (
              <div className="field-error" id="pages-add-title-note">
                {limitNote(titleOver, TEXT_LIMITS.pageTitle, false).text}
              </div>
            )}
            <div className="pages-add-route" id="pages-add-route">
              <span className="label">Address</span> <span className={title.trim() ? 'value' : 'value empty'}>{newRoute}</span>
              {title.trim() && newRoute !== newBase && <span className="note"> · {newBase} is taken</span>}
              {title.trim() && newReserved && <span className="note"> · {newReserved} is reserved</span>}
            </div>
            {sections.length > 0 && (
              <div className="pages-add-field">
                <label className="label" htmlFor="pages-add-inside">
                  Inside
                </label>
                <select id="pages-add-inside" className="select" value={parent?.id ?? ''} disabled={creating} onChange={(e) => chooseParent(e.target.value || null)} aria-describedby="pages-add-where">
                  <option value="">Top level</option>
                  {sections.map((id) => (
                    <option key={id} value={id}>
                      {' '.repeat(depthOf(id))}
                      {st.pages[id].title}
                      {order.some((o) => o !== id && st.pages[o].title === st.pages[id].title) ? ` (${st.pages[id].route})` : ''}
                    </option>
                  ))}
                </select>
                <span className="note" id="pages-add-where">
                  {parent && placeAfter ? (placeAfter === parent.id ? `Listed right after ${parent.title}` : `Listed after ${st.pages[placeAfter].title}, last in ${parent.title}`) : 'Listed at the end'}
                </span>
              </div>
            )}
            <div className="pages-add-field">
              <label className="label" htmlFor="pages-add-starter">
                Starts with
              </label>
              <select
                id="pages-add-starter"
                className="select"
                value={starter}
                disabled={creating}
                aria-describedby="pages-add-starter-note"
                onChange={(e) => {
                  const next = e.target.value as PageStarter;
                  setStarter(next);
                  // News items rarely belong in the menu (News lists show them), unless the author said otherwise.
                  if (!navChosen.current) setAddToNav(next !== 'article' && !parent);
                }}
              >
                {PAGE_STARTERS.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
              <span className="note" id="pages-add-starter-note">
                {starterNote(st, starter)}
              </span>
            </div>
            {asArticle && (
              <div className="pages-add-field stack">
                <label className="label" htmlFor="pages-add-date">
                  Publication date
                </label>
                <input id="pages-add-date" className="input" type="date" value={articleDate} disabled={creating} onChange={(e) => setArticleDate(e.target.value)} aria-describedby="pages-add-date-note" aria-invalid={dateMissing || undefined} />
                <span className={dateMissing ? 'note error' : 'note'} id="pages-add-date-note">
                  {dateMissing ? 'Enter the whole publication date.' : 'News lists show articles newest first.'}
                </span>
              </div>
            )}
            {headerMenu && (
              <div className="pages-add-field stack">
                <label className="pages-add-check">
                  <input
                    type="checkbox"
                    checked={addToNav && !menuFull}
                    disabled={creating || menuFull}
                    aria-describedby={menuFull ? 'pages-add-menu-full' : undefined}
                    onChange={(e) => {
                      navChosen.current = true;
                      setAddToNav(e.target.checked);
                    }}
                  />
                  {navNote ? `Add to header menu, ${navNote}` : 'Add to header menu'}
                </label>
                {menuFull && (
                  <span className="note" id="pages-add-menu-full">
                    The header menu is full: it holds {menuMax} links.{' '}
                    <button type="button" className="link-btn" disabled={creating} onMouseDown={(e) => e.preventDefault()} onClick={editMenu}>
                      Edit menu
                    </button>{' '}
                    to make room.
                  </span>
                )}
              </div>
            )}
            <div className="pages-add-actions">
              <button className="btn btn-sm btn-primary" disabled={!title.trim() || creating || dateMissing || titleOver > 0} onMouseDown={(e) => e.preventDefault()} onClick={() => void add()}>
                {creating ? (asArticle ? 'Adding article…' : 'Adding page…') : asArticle ? 'Add article' : 'Add page'}
              </button>
              <button className="btn btn-sm btn-ghost" disabled={creating} onMouseDown={(e) => e.preventDefault()} onClick={cancelAdd}>
                Cancel
              </button>
            </div>
          </div>
        )}
        <div className="pages-list-wrap" ref={wrapRef}>
          <div
            id="pages-listbox"
            className={`list pages-list${finding ? ' finding' : ''}`}
            role="listbox"
            aria-label={finding ? `Pages matching “${query.trim()}”` : 'Pages'}
            aria-description={`Type a title to jump to it. F2 renames, Shift+F10 opens page options, Shift+${mac ? 'Command' : 'Control'}+Up or Down moves a page.`}
            ref={listRef}
            hidden={!shown.length}
            onFocus={(e) => {
              const row = e.target.closest<HTMLElement>('[role="option"]');
              setFocusedRow(row?.dataset.page ?? null);
              showPeek(row);
            }}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPeek(null);
            }}
            onKeyDown={(e) => {
              if (!typeAhead(e)) rovingKeys(e, 'option', { follow: false });
            }}
          >
            {shown.map((id) => {
              const p = st.pages[id];
              const selected = id === pageId;
              const isHome = id === homeId;
              const draft = isDraftPage(st, p);
              const article = pageArticle(p);
              // Always with its year: the row's date has a line to itself here (the Content list leaves this year's off).
              const date = article ? shortDate(article.date, p.language ?? language, { withYear: true }) : null;
              const d = finding ? 0 : depthOf(id);
              const cls = [
                'list-item',
                'page-row',
                draft && 'draft',
                selected && 'selected',
                menu.isOpen && menuFor === id && 'menu-open',
                dragBlock.includes(id) && 'dragging',
                renaming === id && 'renaming',
                justAdded === id && 'just-added',
                dropAt?.id === id && (dropAt.after ? 'drop-after' : 'drop-before')
              ]
                .filter(Boolean)
                .join(' ');
              const status = [isHome && 'home page', draft && 'draft, left out of the website', article && `article dated ${date}`].filter(Boolean).join(', ');
              const section = d > 0 ? place.get(id)?.parent : undefined;
              // A page listed away from the section its address belongs to says so (Move under puts it back).
              const homeSection = finding ? undefined : sectionFor(st, order, id);
              const away = homeSection && homeSection !== place.get(id)?.parent ? homeSection : undefined;
              // Each level's guide stops at the last page of its section: the levels the next row does not reach.
              const nextId = order[order.indexOf(id) + 1];
              const goesOn = Math.min(d, nextId ? depthOf(nextId) : 0);
              return (
                <div
                  key={id}
                  className={cls}
                  role="option"
                  data-page={id}
                  aria-selected={selected}
                  aria-label={status ? `${p.title}, ${status}` : p.title}
                  aria-description={section ? `${p.route}, in ${st.pages[section].title}` : p.route}
                  aria-keyshortcuts={`F2 Shift+F10 Shift+${mac ? 'Meta' : 'Control'}+ArrowUp Shift+${mac ? 'Meta' : 'Control'}+ArrowDown`}
                  style={{ '--depth': d, '--drop-depth': dropDepth } as React.CSSProperties}
                  // The list's one tab stop is the open page (else the first); arrows move focus between rows.
                  tabIndex={id === tabStop ? 0 : -1}
                  title={`${p.title}\n${p.route}${status ? ` · ${status}` : ''}`}
                  draggable={!renaming && !finding}
                  onDragStart={(e) => {
                    // Dragging shows the click before it was single: its page opens before the drag goes on.
                    clicks.settle();
                    e.dataTransfer.effectAllowed = 'move';
                    setPeek(null);
                    setDragId(id);
                  }}
                  onDragEnd={endDrag}
                  onDragOver={(e) => {
                    if (!dragId) return;
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const next = dropTarget(id, e.clientY > r.top + r.height / 2);
                    // Only a place the page can go accepts the drop, so the cursor agrees with the line.
                    if (next) (e.preventDefault(), (e.dataTransfer.dropEffect = 'move'));
                    if (next?.id !== dropAt?.id || next?.after !== dropAt?.after) setDropAt(next);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt((x) => (x?.id === id ? null : x));
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    // Worked out again from where the page was let go, by the same rule as the line.
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const o = dragId ? moved(st, order, place, dragId, id, e.clientY > r.top + r.height / 2) : null;
                    if (dragId && o) void moveTo(dragId, o, 'moved', false);
                    endDrag();
                  }}
                  // One click opens the page, once no second click follows; a double click renames it without
                  // opening it, so Edit everywhere and the page on the canvas stay as they are.
                  onClick={(e) => clicks.click(id, e.detail)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), open(id, true));
                    if (e.key === 'F2') (e.preventDefault(), setRenaming(id));
                    // Escape puts away a card that shows (the row cut short); with none showing it leaves a find.
                    if (e.key === 'Escape' && peek && rowClipped(e.currentTarget)) (e.stopPropagation(), setPeek(null));
                    else if (e.key === 'Escape' && finding) {
                      // Escape leaves the find and keeps this row, now in its place in the outline.
                      e.stopPropagation();
                      setQuery('');
                      requestAnimationFrame(() => (rowEl(id)?.scrollIntoView({ block: 'nearest' }), rowEl(id)?.focus({ preventScroll: true })));
                    }
                    // Shift+Cmd/Ctrl+Up/Down moves the page in the order, as it moves a layer in Layers.
                    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!finding) move(id, e.key === 'ArrowUp' ? -1 : 1);
                    }
                    if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
                      e.preventDefault();
                      const r = e.currentTarget.getBoundingClientRect();
                      pageMenu({ x: r.left + 24, y: r.bottom, row: e.currentTarget }, id);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    pageMenu({ x: e.clientX, y: e.clientY, row: e.currentTarget }, id);
                  }}
                >
                  {goesOn > 0 && <span className="page-guides" style={{ '--from': 0, '--to': goesOn } as React.CSSProperties} aria-hidden="true" />}
                  {d > goesOn && <span className="page-guides end" style={{ '--from': goesOn, '--to': d } as React.CSSProperties} aria-hidden="true" />}
                  <span className="page-glyph" aria-hidden="true">
                    {isHome ? <House /> : draft ? <FilePen /> : article ? <Newspaper /> : <FileText />}
                  </span>
                  <span className="page-text">
                    <span className="page-title ellipsis">
                      <Marked text={p.title} words={words} />
                    </span>
                    <span className="page-meta">
                      {draft && <span className="badge amber page-draft">Draft</span>}
                      <RouteText route={p.route} words={words} within={section ? st.pages[section].route : undefined} />
                      {isHome && <span className="page-note">Home page</span>}
                    </span>
                    {date && <span className="page-date">{date}</span>}
                    {away && <span className="page-aside">Listed apart from {st.pages[away].title}</span>}
                  </span>
                  <span className="actions">
                    <button
                      className="icon-btn sm hover-only"
                      tabIndex={-1}
                      aria-haspopup="menu"
                      aria-expanded={menu.isOpen && menuFor === id}
                      aria-label={`${p.title} options`}
                      title="Page options (Shift+F10)"
                      // The button is for the pointer; anything that hands it focus (a menu or dialog closing)
                      // hands it on to the row, where the row's keys work.
                      onFocus={(e) => e.currentTarget.closest<HTMLElement>('[role="option"]')?.focus()}
                      onClick={(e) => (e.stopPropagation(), pageMenu(e.currentTarget, id))}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      <MoreHorizontal />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
          {finding && !shown.length && (
            <div className="pages-empty">
              <p>
                No page has “{query.trim()}” in its title or address.
              </p>
              {addPending ? (
                // A page is already being added: go back to it rather than replace its title.
                <button className="btn btn-sm" onClick={() => (setQuery(''), openForm())}>
                  <span className="ellipsis">Return to new page “{title.trim()}”</span>
                </button>
              ) : (
                <button className="btn btn-sm" onClick={() => (setQuery(''), openForm(null, query.trim()))}>
                  <Plus aria-hidden="true" />
                  <span className="ellipsis">Add page “{query.trim()}”</span>
                </button>
              )}
            </div>
          )}
          {peek && st.pages[peek.id] && !menu.isOpen && !renaming && !dragId && (
            <ListPeek key={peek.id} row={() => rowEl(peek.id)} cut={rowClipped} title={st.pages[peek.id].title} route={st.pages[peek.id].route} />
          )}
          {renaming && st.pages[renaming] && (
            <input
              key={renaming}
              ref={renameInput}
              className="input inline-edit pages-rename"
              style={renameBox ?? { visibility: 'hidden' }}
              defaultValue={st.pages[renaming].title}
              aria-label={`Rename ${st.pages[renaming].title}`}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => endRename(renaming, e.target.value)}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return;
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') (e.stopPropagation(), endRename(renaming));
              }}
            />
          )}
        </div>
        <span className="sr-only" role="status">
          {orderPlan ? `Moved in Pages only. The header menu still lists ${orderPlan.before.join(', ')}.` : ''}
        </span>
        {orderPlan && (
          <div className="pages-order-note" role="group" aria-label="Header menu order">
            <p>
              <strong>Moved in Pages only.</strong> The header menu has its own order and still lists {orderPlan.before.join(' · ')}.
            </p>
            <div className="pages-order-actions">
              <button className="btn btn-sm btn-primary" disabled={matching} onClick={() => void matchMenu()} title={`The menu would list ${orderPlan.after.join(' · ')}. Other links stay where they are.`}>
                Match header menu
              </button>
              <button className="btn btn-sm btn-ghost" disabled={matching} onClick={() => void followPages()} title="The menu’s links to pages will move with Pages from now on. Other links stay where they are.">
                Always follow page order
              </button>
              <button className="btn btn-sm btn-ghost" disabled={matching} onClick={editMenu}>
                Edit menu
              </button>
              <button className="btn btn-sm btn-ghost" disabled={matching} onClick={() => lastMove && endNote(lastMove.pageId)}>
                Keep menu as is
              </button>
            </div>
          </div>
        )}
        <CollectionLayouts state={st} />
      </div>
      {menu.node}
    </div>
  );
}

/** Every page size a collection's index can have, so any of them is one choice away (typing a number jumps to it). */
const PAGE_SIZES = Array.from({ length: MAX_PAGE_SIZE }, (_, i) => i + 1);

/**
 * Which collections have their index settings open, remembered for this viewer and project (a convenience, so it may
 * be lost): collection IDs such as "posts" recur across projects, so the project's folder is part of the key.
 */
const indexOpenKey = (dir: string, collectionId: string) => `pages-collection-index:${dir}:${collectionId}`;
function readIndexOpen(dir: string, collectionId: string): boolean {
  try {
    return localStorage.getItem(indexOpenKey(dir, collectionId)) === '1';
  } catch {
    return false;
  }
}
function saveIndexOpen(dir: string, collectionId: string, open: boolean) {
  try {
    if (open) localStorage.setItem(indexOpenKey(dir, collectionId), '1');
    else localStorage.removeItem(indexOpenKey(dir, collectionId));
  } catch {
    // Not kept: the settings start closed next time.
  }
}

/**
 * How a collection's index and category archives list its published entries: whether the index shows the ready-made
 * cards or a design of its own (with a way to see it in the preview, as visitors get it, and to design it), how many
 * to a page, whether each category has an archive of its own, and what the index tells search engines and link
 * previews (`fallback` while the collection says nothing of its own). Going back to the ready-made cards asks first.
 */
function CollectionArchive(props: { id: string; collectionId: string; name: string; route: string; pageSize: number; categories: boolean; designed: boolean; description: string; fallback: string }) {
  const { id, collectionId, name, route, pageSize, categories, designed, description, fallback } = props;
  const designRef = useRef<HTMLButtonElement>(null);
  // The text the field shows, so the fallback is named as soon as the description is cleared, before it is saved.
  const [shown, setShown] = useState(description);
  useEffect(() => setShown(description), [description]);
  const update = (patch: { pageSize?: number; termArchives?: boolean; archiveTemplate?: null; description?: string }, label: string) => commitOps([{ type: 'collection.update', collectionId, ...patch }], label);
  const viewIndex = () => {
    // The index is a page of the website: a layout being edited closes first, as opening a page closes it.
    if (getState().templateMode) setState({ templateMode: null, ...(getState().selection?.owner.kind === 'template' ? { selection: null } : {}) });
    setMode('preview');
    // Once the canvas shows the preview; one still starting opens the index once it is ready.
    requestAnimationFrame(() => void (async () => {
      // Edit chosen meanwhile shows the page being edited, not the index.
      if (getState().mode !== 'preview') return;
      const ready = await api.project.previewRouteReady(route, getState().snapshot?.revision ?? 0);
      if (getState().mode !== 'preview') return;
      if (ready === false) {
        toast(`The ${name} index is still getting ready. Try View index again.`, 'info');
        return;
      }
      if (!visitAddress(route, true)) toast(`The preview is starting: the ${name} index opens in it once it is ready.`, 'info');
    })());
  };
  const backToReadyMade = async () => {
    const ok = await confirmDialog({
      title: 'Use the ready-made cards?',
      body: `The ${name} index goes back to listing its entries as the ready-made cards.`,
      confirmLabel: 'Use ready-made cards',
      cancelLabel: 'Keep design',
      tone: 'caution',
      icon: 'revert',
      subject: `${name} index`,
      details: [
        { kind: 'lose', text: 'The index’s own design is removed.' },
        { kind: 'keep', text: 'Its entries, and the layout of each entry’s page, stay as they are.' },
        { kind: 'undo', text: 'Undo brings the design back.' }
      ]
    });
    if (!ok) return;
    if (await update({ archiveTemplate: null }, `Show the ready-made cards on the ${name} index`)) requestAnimationFrame(() => designRef.current?.focus());
  };
  return (
    <div className="pages-collection-index" id={id} role="group" aria-label={`${name} index`}>
      <p className="pages-collection-look">
        {designed ? (
          <>
            Shows <strong>its own design</strong>
          </>
        ) : (
          <>
            Shows <strong>the ready-made cards</strong>. Design index starts a design of its own from them.
          </>
        )}
      </p>
      <div className="pages-collection-actions">
        <button className="btn btn-sm" onClick={viewIndex} aria-label={`View index of ${name}`} data-testid={`view-index-${collectionId}`}>
          View index
        </button>
        {/* The index's own layout, designed on the canvas, in place of the ready-made cards. */}
        <button ref={designRef} className="btn btn-sm" onClick={() => void openArchiveLayout(collectionId)} aria-label={designed ? `Edit design of ${name} index` : `Design index of ${name}`} data-testid={`design-index-${collectionId}`}>
          {designed ? 'Edit design' : 'Design index'}
        </button>
      </div>
      <div className="pages-collection-size">
        <Field label="Entries per page">
          {/* A choice made at once, so no typed value is ever held while the project changes under it. */}
          <select
            className="select sm"
            value={String(pageSize)}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n !== pageSize) void update({ pageSize: n }, `Show ${n} per page on the ${name} index`);
            }}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <SwitchRow checked={categories} label="Category and tag pages" hint="Each category and tag gets a page listing its entries." onChange={(on) => void update({ termArchives: on }, on ? 'Give categories and tags their own pages' : 'Stop giving categories and tags their own pages')} />
      <Field label="Index description" hint={shown.trim() ? 'For search results and link previews.' : <>For search results and link previews. While it is empty, this index uses: <q>{fallback}</q></>}>
        <DraftInput
          multiline
          rows={2}
          limit={TEXT_LIMITS.pageDescription}
          keep={`collection:${collectionId}:description`}
          keepWhile={() => {
            // Only while the collection has its index, so a draft hidden by turning it off is offered to copy.
            const c = getState().snapshot?.state.collections[collectionId];
            return !!c && hasArchivePages(c.settings);
          }}
          value={description}
          onDirty={(_, draft) => setShown(draft)}
          onCommit={(v) => update({ description: v }, `Change the ${name} index description`)}
        />
      </Field>
      {designed && (
        <div className="pages-collection-reset">
          <button className="btn btn-sm" onClick={() => void backToReadyMade()} aria-label={`Use ready-made cards on ${name} index`}>
            Use ready-made cards…
          </button>
        </div>
      )}
    </div>
  );
}

/** One collection: what it is and where it lives, its layout, and (behind a disclosure) the settings of its index. */
function CollectionRow({ state, id, open }: { state: ProjectState; id: string; open: 'entry' | 'index' | null }) {
  const c = state.collections[id];
  const name = c.settings.name;
  const dir = useStore((s) => s.snapshot?.dir ?? '');
  const [expanded, setExpanded] = useState(() => readIndexOpen(dir, id));
  const [settings, setSettings] = useState(false);
  const n = Object.keys(c.entries ?? {}).length;
  const paged = hasDetailPages(c.settings);
  const indexed = hasArchivePages(c.settings);
  const regionId = `pages-collection-index-${id}`;
  const openSettings = () => void saveOpenPost().then((ok) => (ok ? setSettings(true) : toast('The entry you are writing has a change that is not saved yet. See the note beside it.', 'error')));
  // Where a collection without an index, or without entry pages, turns them on.
  const settingsButton = (
    <button className="btn btn-sm btn-ghost pages-collection-settings" aria-label={`Collection settings of ${name}`} onClick={openSettings}>
      <Settings2 aria-hidden="true" />
      Collection settings…
    </button>
  );
  const toggle = () => {
    setExpanded(!expanded);
    saveIndexOpen(dir, id, !expanded);
  };
  return (
    <li className={`pages-collection${open ? ' open' : ''}`} aria-current={open ? 'true' : undefined}>
      <span className="pages-collection-glyph">
        <LayoutTemplate aria-hidden="true" />
      </span>
      <div className="pages-collection-body">
        <span className="pages-collection-name">{name}</span>
        <span className="pages-collection-meta">
          <span>
            {n} {n === 1 ? 'entry' : 'entries'}
          </span>
          {/* The address an index lives at; with no index it is only where the entries' own pages go. */}
          {paged && c.settings.route ? (
            <span className="pages-collection-route">
              {indexed ? '' : 'Entry pages under '}
              <span className="pages-collection-path">{c.settings.route}</span>
            </span>
          ) : !paged ? (
            <span className="pages-collection-route">Lists only</span>
          ) : null}
        </span>
        {open && <span className="pages-collection-open">{open === 'index' ? 'Index design open on the canvas' : 'Layout open on the canvas'}</span>}
        {paged ? (
          <div className="pages-collection-buttons">
            <button className="btn btn-sm" aria-label={`Edit layout of ${name}`} data-testid={`edit-layout-${id}`} onClick={() => openLayout(id)}>
              Edit layout
            </button>
            {indexed ? (
              <button className="btn btn-sm btn-ghost pages-collection-toggle" aria-expanded={expanded} aria-controls={regionId} aria-label={`Index settings of ${name}`} onClick={toggle}>
                <ChevronRight aria-hidden="true" />
                Index settings
              </button>
            ) : (
              settingsButton
            )}
          </div>
        ) : (
          <>
            <p className="pages-collection-note">Its entries show in lists on other pages, with no pages of their own.</p>
            <div className="pages-collection-buttons flush">{settingsButton}</div>
          </>
        )}
        {indexed && !expanded && <div id={regionId} hidden />}
        {indexed && expanded && (
          <CollectionArchive
            id={regionId}
            collectionId={id}
            name={name}
            route={c.settings.route ?? ''}
            pageSize={archivePageSize(c.settings)}
            categories={hasTermArchives(c.settings)}
            designed={!!c.settings.archiveTemplate}
            description={c.settings.description ?? ''}
            fallback={defaultArchiveDescription(state, id)}
          />
        )}
      </div>
      {settings && <CollectionSchemaDialog collectionId={id} onClose={() => setSettings(false)} />}
    </li>
  );
}

/**
 * The site's collections, by name, each with the layout its entries' pages share. Edit layout opens it on the canvas,
 * shown on the collection's first entry; a change there changes every entry's page. The one open on the canvas is
 * marked, saying whether it is the entries' layout or the index's design.
 */
function CollectionLayouts({ state }: { state: ProjectState }) {
  const template = useStore((s) => s.templateMode);
  const ids = Object.keys(state.collections ?? {}).sort((a, b) => state.collections[a].settings.name.localeCompare(state.collections[b].settings.name) || a.localeCompare(b));
  if (!ids.length) return null;
  return (
    <section className="pages-collections" aria-labelledby="pages-collections-head">
      <h4 id="pages-collections-head">Collections</h4>
      <ul>
        {ids.map((id) => (
          <CollectionRow key={id} state={state} id={id} open={template?.collectionId === id ? (template.archive ? 'index' : 'entry') : null} />
        ))}
      </ul>
    </section>
  );
}
