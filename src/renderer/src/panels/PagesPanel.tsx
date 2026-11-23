import { useEffect, useRef, useState } from 'react';
import { Copy, FileText, House, MoreHorizontal, Pencil, Plus, Settings2, Trash2, ArrowUp, ArrowDown, Code } from 'lucide-react';
import { slugify } from '@shared/routes';
import { applyOps, markDraft, setState, useStore } from '../store';
import { rovingKeys, useMenu, useRovingTabStop } from '../components/ui';
import { selectPage } from '../lib/actions';

export function PagesPanel() {
  const snap = useStore((s) => s.snapshot);
  const pageId = useStore((s) => s.pageId);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  const menu = useMenu();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useRovingTabStop(listRef, 'option');
  useEffect(() => {
    markDraft('page-add', adding);
    return () => markDraft('page-add', false);
  }, [adding]);
  useEffect(() => {
    markDraft('page-rename', !!renaming);
    return () => markDraft('page-rename', false);
  }, [renaming]);
  useEffect(() => {
    const start = () => setAdding(true);
    window.addEventListener('builder-add-page', start);
    return () => window.removeEventListener('builder-add-page', start);
  }, []);
  if (!snap) return null;
  const st = snap.state;
  const order = st.site.pageOrder;

  // After an inline edit ends, keyboard focus goes back to the row it was about, unless the user has
  // already clicked somewhere else.
  const refocus = (sel: string) =>
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      listRef.current?.parentElement?.querySelector<HTMLElement>(sel)?.focus();
    });

  const cancelAdd = () => {
    setTitle('');
    setAdding(false);
    refocus('.pages-add');
  };

  const add = async () => {
    const t = title.trim();
    setAdding(false);
    setTitle('');
    if (!t) return refocus('.pages-add');
    const r = await applyOps([{ type: 'page.create', title: t, afterPageId: pageId ?? undefined, starter: 'intro' }], `Add page ${t}`);
    const id = r?.[0]?.pageId as string | undefined;
    if (id) {
      selectPage(id);
      setTimeout(() => refocus(`[data-page="${id}"]`), 50);
    }
  };
  const reorder = async (ids: string[]) => applyOps([{ type: 'page.reorder', pageIds: ids }], 'Reorder pages');

  const pageMenu = (el: HTMLElement | { x: number; y: number; row: HTMLElement }, id: string) => {
    const i = order.indexOf(id);
    const isHome = id === st.site.homePageId;
    setMenuFor(id);
    const open = (items: Parameters<typeof menu.openAt>[1], label: string) => (el instanceof HTMLElement ? menu.openAt(el, items, label) : menu.open(el.x, el.y, items, label, el.row));
    open([
      { heading: st.pages[id].title },
      { label: 'Page settings', icon: <Settings2 />, onSelect: () => (selectPage(id), setState({ selection: null, rightTab: 'inspect', dockOpen: true })) },
      { label: 'Rename', icon: <Pencil />, onSelect: () => setRenaming(id) },
      { label: 'Duplicate', icon: <Copy />, onSelect: async () => {
        const r = await applyOps([{ type: 'page.duplicate', pageId: id }], 'Duplicate page');
        if (r?.[0]?.pageId) selectPage(r[0].pageId as string);
      } },
      ...(isHome ? [] : [{ label: 'Make home page', icon: <House />, onSelect: () => void applyOps([{ type: 'page.setHome', pageId: id }], 'Change home page') }]),
      ...(useStore.getState().settings?.developerMode ? [{ label: 'View generated source', icon: <Code />, onSelect: () => setState({ modal: { kind: 'page-source', pageId: id } }) }] : []),
      { separator: true },
      { label: 'Move up', icon: <ArrowUp />, disabled: i === 0, onSelect: () => { const o = [...order]; o.splice(i - 1, 0, o.splice(i, 1)[0]); void reorder(o); } },
      { label: 'Move down', icon: <ArrowDown />, disabled: i === order.length - 1, onSelect: () => { const o = [...order]; o.splice(i + 1, 0, o.splice(i, 1)[0]); void reorder(o); } },
      { separator: true },
      { label: `Delete ${st.pages[id].title}…`, icon: <Trash2 />, danger: true, disabled: order.length <= 1, onSelect: () => setState({ modal: { kind: 'delete-page', pageId: id } }) }
    ], `${st.pages[id].title} options`);
  };

  return (
    <>
      <div className="panel-head">
        <h3>Pages</h3>
        <button className="icon-btn sm" title="Add page" aria-label="Add page" onClick={() => setAdding(true)}>
          <Plus />
        </button>
      </div>
      <div className="panel-body">
        <div className="list" role="listbox" aria-label="Pages" ref={listRef} onKeyDown={(e) => rovingKeys(e, 'option')}>
          {order.map((id) => {
            const p = st.pages[id];
            const selected = id === pageId;
            return (
              <div
                key={id}
                className={`list-item${selected ? ' selected' : ''}${menu.isOpen && menuFor === id ? ' menu-open' : ''}${dropAt?.id === id ? (dropAt.after ? ' drop-after' : ' drop-before') : ''}`}
                role="option"
                data-page={id}
                aria-selected={selected}
                aria-label={id === st.site.homePageId ? `${p.title}, home page` : p.title}
                tabIndex={-1}
                title={id === st.site.homePageId ? `${p.title} (home page)` : `${p.title} · ${p.route}`}
                draggable={!renaming}
                onDragStart={() => setDragId(id)}
                onDragOver={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setDropAt({ id, after: e.clientY > r.top + r.height / 2 });
                }}
                onDragLeave={() => setDropAt(null)}
                onDrop={() => {
                  if (dragId && dropAt && dragId !== dropAt.id) {
                    const o = order.filter((x) => x !== dragId);
                    o.splice(o.indexOf(dropAt.id) + (dropAt.after ? 1 : 0), 0, dragId);
                    void reorder(o);
                  }
                  setDragId(null);
                  setDropAt(null);
                }}
                onClick={() => selectPage(id)}
                onDoubleClick={() => setRenaming(id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter') selectPage(id);
                  if (e.key === 'F2') setRenaming(id);
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
                {id === st.site.homePageId ? <House aria-label="Home page" /> : <FileText />}
                {renaming === id ? (
                  <input
                    className="input inline-edit grow"
                    autoFocus
                    defaultValue={p.title}
                    aria-label={`Rename ${p.title}`}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      setRenaming(null);
                      refocus(`[data-page="${id}"]`);
                      const v = e.target.value.trim();
                      if (v && v !== p.title) void applyOps([{ type: 'page.update', pageId: id, title: v }], 'Rename page');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') (setRenaming(null), refocus(`[data-page="${id}"]`));
                    }}
                  />
                ) : (
                  <span className="grow ellipsis">{p.title}</span>
                )}
                {id !== st.site.homePageId && renaming !== id && (
                  <span className="faint ellipsis" style={{ fontSize: 12, maxWidth: '40%' }}>
                    {p.route}
                  </span>
                )}
                <span className="actions">
                  <button className="icon-btn sm" tabIndex={-1} aria-haspopup="menu" aria-expanded="false" aria-label={`${p.title} options`} title="Page options" onClick={(e) => (e.stopPropagation(), pageMenu(e.currentTarget, id))}>
                    <MoreHorizontal />
                  </button>
                </span>
              </div>
            );
          })}
          {adding && (
            <div className="list-item adding">
              <FileText />
              <input
                className="input inline-edit grow"
                autoFocus
                placeholder="Page title"
                aria-label="New page title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                // Leaving the field never creates a page by itself: an empty row just goes away, a titled one
                // waits for Add page or Cancel.
                onBlur={() => !title.trim() && setAdding(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) void add();
                  if (e.key === 'Escape') cancelAdd();
                }}
              />
              <span className="faint" style={{ fontSize: 12 }}>
                /{slugify(title) || 'page'}/
              </span>
            </div>
          )}
          {adding && (
            <div className="add-page-actions">
              <button className="btn btn-sm btn-primary" disabled={!title.trim()} onMouseDown={(e) => e.preventDefault()} onClick={() => void add()}>
                Add page
              </button>
              <button className="btn btn-sm btn-ghost" onMouseDown={(e) => e.preventDefault()} onClick={cancelAdd}>
                Cancel
              </button>
            </div>
          )}
        </div>
        {!adding && (
          <div style={{ padding: '0 12px' }}>
            <button className="btn btn-sm btn-ghost pages-add" onClick={() => setAdding(true)}>
              <Plus /> Add page
            </button>
          </div>
        )}
      </div>
      {menu.node}
    </>
  );
}
