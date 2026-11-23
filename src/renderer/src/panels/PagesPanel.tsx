import { useState } from 'react';
import { Copy, FileText, House, MoreHorizontal, Pencil, Plus, Settings2, Trash2, ArrowUp, ArrowDown, Code } from 'lucide-react';
import { slugify } from '@shared/routes';
import { applyOps, setState, useStore } from '../store';
import { useMenu } from '../components/ui';
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
  if (!snap) return null;
  const st = snap.state;
  const order = st.site.pageOrder;

  const add = async () => {
    const t = title.trim();
    setAdding(false);
    setTitle('');
    if (!t) return;
    const r = await applyOps([{ type: 'page.create', title: t, afterPageId: pageId ?? undefined, starter: 'intro' }], `Add page ${t}`);
    const id = r?.[0]?.pageId as string | undefined;
    if (id) selectPage(id);
  };
  const reorder = async (ids: string[]) => applyOps([{ type: 'page.reorder', pageIds: ids }], 'Reorder pages');

  const pageMenu = (el: HTMLElement, id: string) => {
    const i = order.indexOf(id);
    menu.openAt(el, [
      { label: 'Page settings', icon: <Settings2 />, onSelect: () => (selectPage(id), setState({ selection: null, rightTab: 'inspect' })) },
      { label: 'Rename', icon: <Pencil />, onSelect: () => setRenaming(id) },
      { label: 'Duplicate', icon: <Copy />, onSelect: async () => {
        const r = await applyOps([{ type: 'page.duplicate', pageId: id }], 'Duplicate page');
        if (r?.[0]?.pageId) selectPage(r[0].pageId as string);
      } },
      { label: 'Make home page', icon: <House />, disabled: id === st.site.homePageId, onSelect: () => void applyOps([{ type: 'page.setHome', pageId: id }], 'Change home page') },
      ...(useStore.getState().settings?.developerMode ? [{ label: 'View generated source', icon: <Code />, onSelect: () => setState({ modal: { kind: 'page-source', pageId: id } }) }] : []),
      { separator: true },
      { label: 'Move up', icon: <ArrowUp />, disabled: i === 0, onSelect: () => { const o = [...order]; o.splice(i - 1, 0, o.splice(i, 1)[0]); void reorder(o); } },
      { label: 'Move down', icon: <ArrowDown />, disabled: i === order.length - 1, onSelect: () => { const o = [...order]; o.splice(i + 1, 0, o.splice(i, 1)[0]); void reorder(o); } },
      { separator: true },
      { label: 'Delete page…', icon: <Trash2 />, danger: true, disabled: order.length <= 1, onSelect: () => setState({ modal: { kind: 'delete-page', pageId: id } }) }
    ]);
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
        <div className="list" role="listbox" aria-label="Pages">
          {order.map((id) => {
            const p = st.pages[id];
            const selected = id === pageId;
            return (
              <div
                key={id}
                className={`list-item${selected ? ' selected' : ''}${dropAt?.id === id ? (dropAt.after ? ' drop-after' : ' drop-before') : ''}`}
                role="option"
                aria-selected={selected}
                tabIndex={0}
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
                onKeyDown={(e) => e.key === 'Enter' && selectPage(id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  pageMenu(e.currentTarget, id);
                }}
              >
                {id === st.site.homePageId ? <House /> : <FileText />}
                {renaming === id ? (
                  <input
                    className="input inline-edit grow"
                    autoFocus
                    defaultValue={p.title}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      setRenaming(null);
                      const v = e.target.value.trim();
                      if (v && v !== p.title) void applyOps([{ type: 'page.update', pageId: id, title: v }], 'Rename page');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="grow ellipsis">{p.title}</span>
                )}
                {id === st.site.homePageId ? <span className="badge">Home</span> : <span className="faint mono" style={{ fontSize: 11 }}>{p.route}</span>}
                <span className="actions">
                  <button className="icon-btn sm" aria-label={`${p.title} options`} onClick={(e) => (e.stopPropagation(), pageMenu(e.currentTarget, id))}>
                    <MoreHorizontal />
                  </button>
                </span>
              </div>
            );
          })}
          {adding && (
            <div className="list-item selected">
              <FileText />
              <input
                className="input inline-edit grow"
                autoFocus
                placeholder="Page title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => void add()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void add();
                  if (e.key === 'Escape') (setAdding(false), setTitle(''));
                }}
              />
              <span className="faint mono" style={{ fontSize: 11 }}>
                /{slugify(title) || 'page'}/
              </span>
            </div>
          )}
        </div>
        {!adding && (
          <div style={{ padding: '0 12px' }}>
            <button className="btn btn-sm btn-ghost" onClick={() => setAdding(true)}>
              <Plus /> Add page
            </button>
          </div>
        )}
      </div>
      {menu.node}
    </>
  );
}
