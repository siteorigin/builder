import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, FilePen, FileText, Globe, House, Menu, MoreHorizontal, Pencil, Plus, Settings2, Trash2, ArrowUp, ArrowDown, Code } from 'lucide-react';
import { slugify, validateRoute } from '@shared/routes';
import type { ProjectState } from '@shared/types';
import { aiActivity, applyOps, commitDraft, getState, markDraft, setState, toast, useStore } from '../store';
import { PAGE_ADD_DRAFT } from '../lib/pending';
import { openSection, rovingKeys, useMenu } from '../components/ui';
import { isImeComposing } from '../lib/ime';
import { goToShellPart, selectPage } from '../lib/actions';
import { headerMenu as findHeaderMenu } from '@engine/tree';
import { isDraftPage } from '@generator/index';

/**
 * The address a new page with this title gets: its slug (made valid when it is a reserved name), with a
 * numbered suffix when another page already has it, kept within the 60-character segment limit. The same
 * route is sent with the create request, so the preview is exactly what the page gets.
 */
function newPageRoute(st: ProjectState, title: string): { route: string; base: string; reserved?: string } {
  let slug = slugify(title) || 'page';
  const reserved = validateRoute(`/${slug}/`) ? `/${slug}/` : undefined;
  if (reserved) slug = `${slug.slice(0, 55)}-page`;
  const base = `/${slug}/`;
  // Old addresses kept working count as taken: a new page is never given one without asking.
  const kept: unknown[] = Array.isArray(st.site.redirects) ? st.site.redirects : [];
  const taken = (r: string) => [...Object.values(st.pages).map((p) => p.route), ...kept.map((x) => (x as { from?: unknown })?.from)].some((u) => typeof u === 'string' && u.toLowerCase() === r.toLowerCase());
  let route = base;
  for (let i = 2; taken(route); i++) route = `/${slug.slice(0, 60 - `-${i}`.length).replace(/-+$/, '')}-${i}/`;
  return { route, base, reserved };
}

/** An address split so a long one shortens its parent folders first: "/port…/kowhai-street-apartment/". */
function RouteText({ route }: { route: string }) {
  const cut = route.length > 1 ? route.lastIndexOf('/', route.length - 2) + 1 : 0;
  if (cut <= 1) return <span className="page-route"><span className="page-route-leaf">{route}</span></span>;
  return (
    <span className="page-route">
      <span className="page-route-dir">{route.slice(0, cut)}</span>
      <span className="page-route-leaf">{route.slice(cut)}</span>
    </span>
  );
}

/**
 * The site's pages, in navigation order. Each row is the page's title over its address; the current page
 * is filled (and ringed while the page itself is in the inspector). Row actions live in the … menu, which
 * shows on the current, hovered, focused and menu-open rows, and is reachable from any row by keyboard
 * (Shift+F10). Type a page's first letters to jump to it.
 */
export function PagesPanel() {
  const snap = useStore((s) => s.snapshot);
  const pageId = useStore((s) => s.pageId);
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [addToNav, setAddToNav] = useState(true);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameBox, setRenameBox] = useState<{ top: number; left: number; width: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  const menu = useMenu();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const typeahead = useRef({ text: '', at: 0 });
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
  const openForm = () => {
    setAdding(true);
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ block: 'nearest' });
      addInput.current?.focus({ preventScroll: true });
    });
  };
  useEffect(() => {
    window.addEventListener('builder-add-page', openForm);
    return () => window.removeEventListener('builder-add-page', openForm);
  }, []);
  // The rename field sits over the row's title but outside the listbox, so it is an ordinary text field.
  useLayoutEffect(() => {
    if (!renaming) return setRenameBox(null);
    const wrap = wrapRef.current?.getBoundingClientRect();
    const row = listRef.current?.querySelector<HTMLElement>(`[data-page="${renaming}"]`);
    const t = row?.querySelector('.page-title')?.getBoundingClientRect();
    const r = row?.getBoundingClientRect();
    if (wrap && t && r) setRenameBox({ top: t.top - wrap.top - 2, left: t.left - wrap.left - 7, width: r.right - 6 - t.left + 7 });
  }, [renaming]);
  // Focus once the field is placed (a hidden field cannot take focus).
  useEffect(() => {
    if (renameBox) renameInput.current?.focus({ preventScroll: true });
  }, [renameBox]);
  // When the current page changes (from here, the toolbar, the canvas or the command menu), its row is
  // brought into view without taking focus; scrolling the list by hand in between is left alone.
  useEffect(() => {
    if (!pageId || !listRef.current?.offsetParent) return;
    listRef.current.querySelector<HTMLElement>(`[data-page="${pageId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [pageId]);
  if (!snap) return null;
  const st = snap.state;
  const order = st.site.pageOrder;
  const homeId = st.site.homePageId;
  const tabStop = focusedRow && order.includes(focusedRow) ? focusedRow : pageId && order.includes(pageId) ? pageId : order[0];

  // After an inline edit ends, keyboard focus goes back to what it was about, unless the user has
  // already clicked somewhere else.
  const refocus = (sel: string) =>
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      wrapRef.current?.closest('.side-panel-view')?.querySelector<HTMLElement>(sel)?.focus();
    });

  const closeForm = () => {
    setTitle('');
    setAdding(false);
  };
  const cancelAdd = () => {
    if (creating) return;
    closeForm();
    refocus('.pages-head-add');
  };
  const { route: newRoute, base: newBase, reserved: newReserved } = newPageRoute(st, title);
  // The shared header's menu: its instance, when it has a navigation list a page link can join.
  const menuOf = findHeaderMenu(st);
  const headerMenu = menuOf ? { id: menuOf.node.id } : null;
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
    if (!t || creating) return;
    setCreating(true);
    // New pages go where the form was: at the end of the list. The draft stays until the page exists.
    const nav = addToNav && !!headerMenu;
    // Sent against the snapshot the address was previewed on: a project that changed meanwhile previews again
    // rather than taking an address it no longer has free.
    const r = await applyOps([{ type: 'page.create', title: t, route: newRoute, starter: 'intro', addToNavigation: nav || undefined }], `Add page ${t}`, undefined, snap?.revision);
    setCreating(false);
    const id = r?.[0]?.pageId as string | undefined;
    if (!id) return addInput.current?.focus();
    if (nav && r?.[0]?.addedToNavigation === false) toast(`Added ${t}. The header menu is full, so it isn’t in the menu yet.`, 'info', { label: 'Edit menu', run: editMenu });
    closeForm();
    selectPage(id);
    setTimeout(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-page="${id}"]`)?.scrollIntoView({ block: 'nearest' });
      refocus(`[data-page="${id}"]`);
    }, 50);
  };
  const reorder = async (ids: string[]) => applyOps([{ type: 'page.reorder', pageIds: ids }], 'Reorder pages');
  const endDrag = () => (setDragId(null), setDropAt(null));
  const endRename = (id: string, value?: string) => {
    setRenaming(null);
    refocus(`[data-page="${id}"]`);
    const v = value?.trim();
    const from = renameBase.current;
    renameBase.current = null;
    if (!v || v === (from?.snap?.state.pages[id]?.title ?? st.pages[id]?.title)) return;
    const rename = () => void applyOps([{ type: 'page.update', pageId: id, title: v }], 'Rename page');
    if (from && (getState().snapshot?.aiBusy || aiActivity() !== from.ai)) commitDraft(from.snap, rename, v, { check: true });
    else commitDraft(null, rename, v);
  };

  const pageMenu = (el: HTMLElement | { x: number; y: number; row: HTMLElement }, id: string) => {
    const i = order.indexOf(id);
    const isHome = id === homeId;
    const draft = isDraftPage(st, st.pages[id]);
    setMenuFor(id);
    const open = (items: Parameters<typeof menu.openAt>[1], label: string) => (el instanceof HTMLElement ? menu.openAt(el, items, label) : menu.open(el.x, el.y, items, label, el.row));
    open([
      { heading: st.pages[id].title },
      { label: 'Page settings', icon: <Settings2 />, onSelect: () => (selectPage(id), setState({ selection: null, rightTab: 'inspect', dockOpen: true })) },
      { label: 'Rename', icon: <Pencil />, shortcut: 'F2', onSelect: () => setRenaming(id) },
      { label: 'Duplicate', icon: <Copy />, onSelect: async () => {
        const r = await applyOps([{ type: 'page.duplicate', pageId: id }], 'Duplicate page');
        if (r?.[0]?.pageId) selectPage(r[0].pageId as string);
      } },
      // The Home page is always published, so a draft is published before it can be Home.
      ...(isHome || draft ? [] : [{ label: 'Make home page…', icon: <House />, onSelect: () => setState({ modal: { kind: 'set-home', pageId: id } }) }]),
      ...(isHome
        ? []
        : [
            draft
              ? { label: 'Publish page', icon: <Globe />, onSelect: () => void applyOps([{ type: 'page.update', pageId: id, draft: false }], 'Publish page') }
              : { label: 'Keep as draft', icon: <FilePen />, onSelect: () => void applyOps([{ type: 'page.update', pageId: id, draft: true }], 'Keep page as draft') }
          ]),
      ...(useStore.getState().settings?.developerMode ? [{ label: 'View generated source…', icon: <Code />, onSelect: () => setState({ modal: { kind: 'page-source', pageId: id } }) }] : []),
      { separator: true },
      { label: 'Move up', icon: <ArrowUp />, disabled: i === 0, onSelect: () => { const o = [...order]; o.splice(i - 1, 0, o.splice(i, 1)[0]); void reorder(o); } },
      { label: 'Move down', icon: <ArrowDown />, disabled: i === order.length - 1, onSelect: () => { const o = [...order]; o.splice(i + 1, 0, o.splice(i, 1)[0]); void reorder(o); } },
      { separator: true },
      { label: 'Delete page…', icon: <Trash2 />, danger: true, disabled: order.length <= 1, onSelect: () => setState({ modal: { kind: 'delete-page', pageId: id } }) }
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
    const needle = repeat ? ta.text[0] : ta.text;
    const start = needle.length > 1 ? Math.max(0, cur) : cur + 1;
    for (let k = 0; k < rows.length; k++) {
      const r = rows[(start + k) % rows.length];
      if (st.pages[r.dataset.page!]?.title.toLowerCase().startsWith(needle)) {
        e.preventDefault();
        // Focus only: opening a page is Enter or Space, so typing never sends the preview through pages.
        if (r !== rows[cur]) r.focus();
        return true;
      }
    }
    return true;
  };

  // A drop that would leave the order unchanged shows no line.
  const dropTarget = (id: string, after: boolean) => {
    if (!dragId || id === dragId) return null;
    const i = order.indexOf(id);
    if ((after && order[i + 1] === dragId) || (!after && order[i - 1] === dragId)) return null;
    return { id, after };
  };

  return (
    <>
      <div className="panel-head">
        <h3>Pages</h3>
        {headerMenu && (
          <button className="btn btn-sm btn-ghost pages-head-menu" onClick={editMenu} title="Edit the shared header’s menu links">
            <Menu /> Edit menu
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
          <Plus /> Add page
        </button>
      </div>
      <div className="panel-body">
        <div className="pages-list-wrap" ref={wrapRef}>
          <div
            className="list pages-list"
            role="listbox"
            aria-label="Pages"
            aria-description="Type a title to jump to it. F2 renames, Shift+F10 opens page options."
            ref={listRef}
            onFocus={(e) => setFocusedRow(e.target.closest<HTMLElement>('[role="option"]')?.dataset.page ?? null)}
            onKeyDown={(e) => {
              if (!typeAhead(e)) rovingKeys(e, 'option', { follow: false });
            }}
          >
            {order.map((id) => {
              const p = st.pages[id];
              const selected = id === pageId;
              const isHome = id === homeId;
              const draft = isDraftPage(st, p);
              const cls = [
                'list-item',
                'page-row',
                draft && 'draft',
                selected && 'selected',
                menu.isOpen && menuFor === id && 'menu-open',
                dragId === id && 'dragging',
                renaming === id && 'renaming',
                dropAt?.id === id && (dropAt.after ? 'drop-after' : 'drop-before')
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <div
                  key={id}
                  className={cls}
                  role="option"
                  data-page={id}
                  aria-selected={selected}
                  aria-label={isHome ? `${p.title}, home page` : draft ? `${p.title}, draft` : p.title}
                  aria-description={p.route}
                  aria-keyshortcuts="F2 Shift+F10"
                  // The list's one tab stop is the open page (else the first); arrows move focus between rows.
                  tabIndex={id === tabStop ? 0 : -1}
                  title={`${p.title}\n${p.route}${isHome ? ' · home page' : draft ? ' · draft, left out of the website' : ''}`}
                  draggable={!renaming}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    setDragId(id);
                  }}
                  onDragEnd={endDrag}
                  onDragOver={(e) => {
                    if (!dragId) return;
                    e.preventDefault();
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const next = dropTarget(id, e.clientY > r.top + r.height / 2);
                    if (next?.id !== dropAt?.id || next?.after !== dropAt?.after) setDropAt(next);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt((d) => (d?.id === id ? null : d));
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragId && dropAt && dragId !== dropAt.id) {
                      const o = order.filter((x) => x !== dragId);
                      o.splice(o.indexOf(dropAt.id) + (dropAt.after ? 1 : 0), 0, dragId);
                      if (o.some((x, k) => x !== order[k])) void reorder(o);
                    }
                    endDrag();
                  }}
                  onClick={() => selectPage(id)}
                  onDoubleClick={() => setRenaming(id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), selectPage(id));
                    if (e.key === 'F2') (e.preventDefault(), setRenaming(id));
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
                  {isHome ? <House className="page-icon" aria-hidden /> : draft ? <FilePen className="page-icon" aria-hidden /> : <FileText className="page-icon" aria-hidden />}
                  <span className="page-text">
                    <span className="page-title-line">
                      <span className="page-title ellipsis">{p.title}</span>
                      {draft && (
                        <span className="badge amber page-draft" aria-hidden>
                          Draft
                        </span>
                      )}
                    </span>
                    <RouteText route={p.route} />
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
          {renaming && st.pages[renaming] && (
            <input
              key={renaming}
              ref={renameInput}
              className="input inline-edit pages-rename"
              style={renameBox ?? { visibility: 'hidden' }}
              defaultValue={st.pages[renaming].title}
              maxLength={80}
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
        {adding && (
          <div
            ref={formRef}
            id="pages-add-form"
            className="pages-add-form"
            role="group"
            aria-label="New page"
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !isImeComposing(e)) (e.stopPropagation(), cancelAdd());
            }}
            // Leaving the form never creates a page by itself: an empty form just goes away, a titled one
            // waits for Add page or Cancel.
            onBlur={(e) => {
              if (!title.trim() && !e.currentTarget.contains(e.relatedTarget as Node | null)) closeForm();
            }}
          >
            <input
              ref={addInput}
              className="input inline-edit"
              autoFocus
              placeholder="Page title"
              aria-label="New page title"
              aria-describedby="pages-add-route"
              value={title}
              maxLength={80}
              readOnly={creating}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isImeComposing(e)) void add();
              }}
            />
            <div className="pages-add-route" id="pages-add-route">
              <span className="label">Address</span> <span className={title.trim() ? 'value' : 'value empty'}>{newRoute}</span>
              {title.trim() && newRoute !== newBase && <span className="note"> · {newBase} is taken</span>}
              {title.trim() && newReserved && <span className="note"> · {newReserved} is reserved</span>}
            </div>
            {headerMenu && (
              <label className="pages-add-nav">
                <input type="checkbox" checked={addToNav} disabled={creating} onChange={(e) => setAddToNav(e.target.checked)} />
                Add to header menu
              </label>
            )}
            <div className="pages-add-actions">
              <button className="btn btn-sm btn-primary" disabled={!title.trim() || creating} onMouseDown={(e) => e.preventDefault()} onClick={() => void add()}>
                {creating ? 'Adding page…' : 'Add page'}
              </button>
              <button className="btn btn-sm btn-ghost" disabled={creating} onMouseDown={(e) => e.preventDefault()} onClick={cancelAdd}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      {menu.node}
    </>
  );
}
