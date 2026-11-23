import { useState } from 'react';
import { ArrowDown, ArrowUp, Box, ChevronRight, Component, Copy, EyeOff, Image, Link2, MousePointerClick, PanelBottom, PanelTop, Pencil, Sparkles, Square, Trash2, Type } from 'lucide-react';
import type { ElementRef, GraphNode, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import { refKey, sameRef } from '@shared/types';
import { displayName, findParent, subtreeIds } from '@engine/tree';
import { applyOps, setState, useStore } from '../store';
import { useMenu } from '../components/ui';
import { askAiAbout, deleteSelection, duplicateSelection, moveSelection } from '../lib/actions';

function kindIcon(n: GraphNode) {
  switch (n.kind) {
    case 'instance':
      return <Component />;
    case 'text':
      return <Type />;
    case 'image':
      return <Image />;
    case 'link':
      return <Link2 />;
    case 'element':
      return <Square />;
    default:
      return <Box />;
  }
}

/** The layer currently being dragged (only nodes owned directly by a page or definition tree). */
let dragging: { owner: OwnerRef; nodeId: string } | null = null;

function isHidden(n: GraphNode) {
  return !!n.styles?.base?.hidden || (n.kind === 'instance' && !!n.overrides?.root?.base?.hidden);
}

export function LayersPanel() {
  const snap = useStore((s) => s.snapshot);
  const pageId = useStore((s) => s.pageId);
  const definitionMode = useStore((s) => s.definitionMode);
  const menu = useMenu();
  if (!snap || !pageId) return null;
  const st = snap.state;
  const page = st.pages[pageId];
  const defOwner: OwnerRef | null = definitionMode ? { kind: 'component', id: definitionMode.definitionId } : null;
  const defTree = defOwner ? st.components[defOwner.id]?.tree : null;

  const openMenu = (el: HTMLElement | { x: number; y: number }, ref: ElementRef, topLevel: boolean) => {
    setState({ selection: ref });
    const items = [
      { label: 'Ask AI about this', icon: <Sparkles />, onSelect: () => askAiAbout(ref) },
      { separator: true },
      { label: 'Move up', icon: <ArrowUp />, disabled: !topLevel, onSelect: () => void moveSelection(-1) },
      { label: 'Move down', icon: <ArrowDown />, disabled: !topLevel, onSelect: () => void moveSelection(1) },
      { label: 'Duplicate', icon: <Copy />, disabled: !topLevel || ref.owner.kind === 'shell', onSelect: () => void duplicateSelection() },
      { separator: true },
      { label: 'Delete', icon: <Trash2 />, danger: true, disabled: !topLevel || ref.owner.kind === 'shell', onSelect: () => void deleteSelection() }
    ];
    if (el instanceof HTMLElement) menu.openAt(el, items);
    else menu.open(el.x, el.y, items);
  };

  return (
    <>
      <div className="panel-head">
        <h3>Layers</h3>
        <span className="faint" style={{ fontSize: 11.5 }}>
          {defOwner ? st.components[defOwner.id]?.name : page.title}
        </span>
      </div>
      <div className="panel-body" role="tree" aria-label="Layers">
        {defOwner && defTree ? (
          <TreeList state={st} owner={defOwner} tree={defTree} ids={defTree.rootIds} depth={0} onMenu={openMenu} />
        ) : (
          <>
            {page.shell !== 'none' && (
              <>
                <div className="list-section">
                  <PanelTop size={12} /> Shared header
                </div>
                <TreeList state={st} owner={{ kind: 'shell', id: 'header' }} tree={st.site.shell.header} ids={st.site.shell.header.rootIds} depth={0} onMenu={openMenu} />
              </>
            )}
            <div className="list-section">Page content</div>
            <TreeList state={st} owner={{ kind: 'page', id: pageId }} tree={page} ids={page.rootIds} depth={0} onMenu={openMenu} />
            {page.rootIds.length === 0 && <p className="faint" style={{ padding: '4px 16px' }}>This page is empty. Add sections from Insert.</p>}
            {page.shell !== 'none' && (
              <>
                <div className="list-section">
                  <PanelBottom size={12} /> Shared footer
                </div>
                <TreeList state={st} owner={{ kind: 'shell', id: 'footer' }} tree={st.site.shell.footer} ids={st.site.shell.footer.rootIds} depth={0} onMenu={openMenu} />
              </>
            )}
          </>
        )}
      </div>
      {menu.node}
    </>
  );
}

function TreeList(props: { state: ProjectState; owner: OwnerRef; tree: NodeTree; ids: string[]; depth: number; onMenu: (el: HTMLElement | { x: number; y: number }, ref: ElementRef, top: boolean) => void }) {
  return (
    <div className="list" style={{ padding: props.depth ? 0 : undefined }}>
      {props.ids.map((id) => (
        <LayerRow key={id} {...props} id={id} />
      ))}
    </div>
  );
}

function LayerRow({ state, owner, tree, id, depth, onMenu }: { state: ProjectState; owner: OwnerRef; tree: NodeTree; id: string; depth: number; onMenu: (el: HTMLElement | { x: number; y: number }, ref: ElementRef, top: boolean) => void }) {
  const selection = useStore((s) => s.selection);
  const [open, setOpen] = useState(depth === 0 && owner.kind === 'page' ? false : false);
  const [renaming, setRenaming] = useState(false);
  const [drop, setDrop] = useState<'before' | 'after' | 'inside' | null>(null);
  const n = tree.nodes[id];
  if (!n) return null;
  const ref: ElementRef = { owner, instancePath: [], nodeId: id };
  const def = n.kind === 'instance' ? state.components[n.definitionId] : undefined;
  const parts = def ? Object.entries(def.parts).filter(([pid]) => pid !== 'root') : [];
  const slotChildren = n.kind === 'instance' ? Object.values(n.slots ?? {}).flat() : n.kind === 'element' ? n.children : [];
  const expandable = parts.length > 0 || slotChildren.length > 0;
  const selected = sameRef(selection, ref);
  const containsSel = !!selection && selection.owner.id === owner.id && selection.instancePath[0] === id;
  const isOpen = open || containsSel;
  const pad = 8 + depth * 14;
  return (
    <>
      <div
        className={`list-item${selected ? ' selected' : ''}${drop === 'before' ? ' drop-before' : drop === 'after' ? ' drop-after' : ''}`}
        style={{ paddingLeft: pad, outline: drop === 'inside' ? '2px solid var(--accent)' : undefined, outlineOffset: -2 }}
        draggable={owner.kind !== 'shell' && !renaming}
        onDragStart={(e) => {
          dragging = { owner, nodeId: id };
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={() => (dragging = null)}
        onDragOver={(e) => {
          if (!dragging || dragging.owner.kind !== owner.kind || dragging.owner.id !== owner.id || dragging.nodeId === id) return;
          if (subtreeIds(tree, dragging.nodeId).includes(id)) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const rel = (e.clientY - r.top) / r.height;
          const canHold = n.kind === 'element' || (n.kind === 'instance' && !!state.components[n.definitionId]?.slots);
          setDrop(canHold && rel > 0.3 && rel < 0.7 ? 'inside' : rel < 0.5 ? 'before' : 'after');
        }}
        onDragLeave={() => setDrop(null)}
        onDrop={(e) => {
          e.preventDefault();
          const d = dragging;
          const where = drop;
          setDrop(null);
          dragging = null;
          if (!d || !where) return;
          if (where === 'inside') {
            const slot = n.kind === 'instance' ? Object.keys(state.components[n.definitionId]?.slots ?? {})[0] : undefined;
            const list = n.kind === 'element' ? n.children : n.kind === 'instance' ? n.slots?.[slot!] ?? [] : [];
            void applyOps([{ type: 'node.move', owner, nodeId: d.nodeId, parentId: id, slot, index: list.length }], 'Move layer');
            return;
          }
          const target = findParent(tree, id);
          const source = findParent(tree, d.nodeId);
          if (!target || !source) return;
          let index = target.index + (where === 'after' ? 1 : 0);
          if (source.parentId === target.parentId && source.slot === target.slot && source.index < index) index -= 1;
          void applyOps([{ type: 'node.move', owner, nodeId: d.nodeId, parentId: target.parentId, slot: target.slot, index }], 'Move layer');
        }}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={expandable ? isOpen : undefined}
        tabIndex={0}
        onClick={() => setState({ selection: ref })}
        onDoubleClick={() => setRenaming(true)}
        onMouseEnter={() => setState({ hover: ref })}
        onMouseLeave={() => setState({ hover: null })}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu({ x: e.clientX, y: e.clientY }, ref, true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') setOpen(true);
          if (e.key === 'ArrowLeft') setOpen(false);
        }}
      >
        {expandable ? (
          <button className={`tree-toggle${isOpen ? ' open' : ''}`} aria-label={isOpen ? 'Collapse' : 'Expand'} onClick={(e) => (e.stopPropagation(), setOpen(!isOpen))}>
            <ChevronRight />
          </button>
        ) : (
          <span style={{ width: 16 }} />
        )}
        <span className={`layer-kind${n.kind === 'instance' ? (owner.kind === 'shell' ? ' shell' : ' instance') : ''}`}>{kindIcon(n)}</span>
        {renaming ? (
          <input
            className="input inline-edit grow"
            autoFocus
            defaultValue={n.name ?? ''}
            placeholder={displayName(state, n)}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              setRenaming(false);
              if (e.target.value !== (n.name ?? '')) void applyOps([{ type: 'node.rename', owner, nodeId: id, name: e.target.value }], 'Rename layer');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <span className="grow ellipsis">{displayName(state, n)}</span>
        )}
        {isHidden(n) && <EyeOff />}
        {def?.owner === 'project' && <span className="badge violet">Project</span>}
        <span className="actions">
          <button className="icon-btn sm" aria-label="Rename layer" title="Rename" onClick={(e) => (e.stopPropagation(), setRenaming(true))}>
            <Pencil />
          </button>
        </span>
      </div>
      {isOpen && (
        <>
          {parts.map(([pid, p]) => {
            const pref: ElementRef = { owner, instancePath: [id], nodeId: p.nodeId, partId: pid };
            const psel = !!selection && refKey({ ...selection, itemPath: undefined }) === refKey(pref);
            return (
              <div
                key={pid}
                className={`list-item${psel ? ' selected' : ''}`}
                style={{ paddingLeft: pad + 30 }}
                role="treeitem"
                aria-selected={psel}
                onClick={() => setState({ selection: pref })}
                onMouseEnter={() => setState({ hover: pref })}
                onMouseLeave={() => setState({ hover: null })}
              >
                <span className="layer-kind part">
                  <MousePointerClick />
                </span>
                <span className="grow ellipsis">{p.label}</span>
              </div>
            );
          })}
          {slotChildren.length > 0 && <TreeList state={state} owner={owner} tree={tree} ids={slotChildren} depth={depth + 1} onMenu={onMenu} />}
        </>
      )}
    </>
  );
}
