import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Box, ChevronRight, Component, Copy, CornerDownRight, Ellipsis, EyeOff, FileText, Image, Link2, PanelBottom, PanelTop, Pencil, Rows3, Sparkles, Trash2, Type } from 'lucide-react';
import type { ElementRef, GraphNode, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import { refKey, sameRef } from '@shared/types';
import { displayName, findParent, subtreeIds } from '@engine/tree';
import { applyOps, markDraft, setState, useStore } from '../store';
import { rovingKeys, useMenu, useRovingTabStop } from '../components/ui';
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
      return <Rows3 />;
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
  const treeRef = useRef<HTMLDivElement>(null);
  // The panel owns the tree's single tab stop; it re-reconciles whenever the selection changes.
  useStore((s) => s.selection);
  useRovingTabStop(treeRef, 'treeitem');
  if (!snap || !pageId) return null;
  const st = snap.state;
  const page = st.pages[pageId];
  const defOwner: OwnerRef | null = definitionMode ? { kind: 'component', id: definitionMode.definitionId } : null;
  const defTree = defOwner ? st.components[defOwner.id]?.tree : null;

  const openMenu = (el: HTMLElement | { x: number; y: number }, ref: ElementRef, topLevel: boolean, onRename?: () => void) => {
    setState({ selection: ref });
    const tree = ref.owner.kind === 'shell' ? st.site.shell[ref.owner.id as 'header' | 'footer'] : ref.owner.kind === 'component' ? st.components[ref.owner.id].tree! : st.pages[ref.owner.id];
    const node = tree.nodes[ref.instancePath[0] ?? ref.nodeId];
    const partDef = ref.partId && node?.kind === 'instance' ? st.components[node.definitionId] : undefined;
    const name = partDef && ref.partId ? partDef.parts[ref.partId]?.label ?? ref.partId : node ? displayName(st, node) : 'Layer';
    const editable = topLevel && ref.owner.kind !== 'shell';
    // "Move to…": the keyboard and menu equivalent of dragging a layer into another container or slot.
    const destinations = (() => {
      if (!topLevel || ref.instancePath.length || !node) return [];
      const here = findParent(tree, ref.nodeId);
      const inside = new Set(subtreeIds(tree, ref.nodeId));
      const out: Array<{ label: string; parentId: string | null; slot?: string; index: number }> = [];
      if (here?.parentId !== null) out.push({ label: ref.owner.kind === 'component' ? 'Top of the component' : 'Top level of the page', parentId: null, index: tree.rootIds.length });
      for (const n of Object.values(tree.nodes)) {
        if (inside.has(n.id)) continue;
        if (n.kind === 'element') {
          if (here?.parentId === n.id) continue;
          out.push({ label: displayName(st, n), parentId: n.id, index: n.children.length });
        } else if (n.kind === 'instance') {
          const slots = st.components[n.definitionId]?.slots ?? {};
          for (const [slot, info] of Object.entries(slots)) {
            if (here?.parentId === n.id && here.slot === slot) continue;
            out.push({ label: `${displayName(st, n)} › ${info.label}`, parentId: n.id, slot, index: n.slots?.[slot]?.length ?? 0 });
          }
        }
      }
      // Repeated names ("Container") get their parent's name so each destination is unambiguous.
      const counts = new Map<string, number>();
      for (const d of out) counts.set(d.label, (counts.get(d.label) ?? 0) + 1);
      return out.map((d) => {
        if ((counts.get(d.label) ?? 0) < 2 || !d.parentId) return d;
        const up = findParent(tree, d.parentId);
        const parentNode = up?.parentId ? tree.nodes[up.parentId] : null;
        return { ...d, label: `${parentNode ? displayName(st, parentNode) : 'Top level'} › ${d.label}` };
      });
    })();
    const moveTo = (anchor: { x: number; y: number }) =>
      menu.open(
        anchor.x,
        anchor.y,
        [
          { heading: `Move ${name} into…` },
          ...destinations.map((d) => ({ label: d.label, onSelect: () => void applyOps([{ type: 'node.move', owner: ref.owner, nodeId: ref.nodeId, parentId: d.parentId, slot: d.slot, index: d.index }], 'Move layer') }))
        ],
        `Move ${name}`,
        document.querySelector<HTMLElement>(`[data-node="${ref.nodeId}"]`)
      );
    const anchorOf = () => (el instanceof HTMLElement ? (() => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.bottom + 4 }; })() : el);
    const items = [
      { heading: name },
      ...(onRename ? [{ label: 'Rename', icon: <Pencil />, shortcut: 'F2', onSelect: onRename }] : []),
      { label: 'Ask AI about this', icon: <Sparkles />, shortcut: '⌘J', onSelect: () => askAiAbout(ref) },
      ...(topLevel
        ? [
            { separator: true },
            { label: 'Move up', icon: <ArrowUp />, shortcut: '⇧⌘↑', onSelect: () => void moveSelection(-1) },
            { label: 'Move down', icon: <ArrowDown />, shortcut: '⇧⌘↓', onSelect: () => void moveSelection(1) },
            ...(destinations.length ? [{ label: 'Move into…', icon: <CornerDownRight />, onSelect: () => setTimeout(() => moveTo(anchorOf()), 0) }] : [])
          ]
        : []),
      ...(editable
        ? [
            { label: 'Duplicate', icon: <Copy />, shortcut: '⌘D', onSelect: () => void duplicateSelection() },
            { separator: true },
            { label: 'Delete', icon: <Trash2 />, shortcut: '⌫', danger: true, onSelect: () => void deleteSelection() }
          ]
        : [])
    ];
    // A row (treeitem) is not a menu button: open at the row and return focus to it, without marking it expanded.
    if (el instanceof HTMLElement && el.getAttribute('role') === 'treeitem') {
      const r = el.getBoundingClientRect();
      menu.open(r.left + 24, r.bottom, items, `${name} options`, el);
    } else if (el instanceof HTMLElement) menu.openAt(el, items, `${name} options`);
    else menu.open(el.x, el.y, items, `${name} options`, document.activeElement as HTMLElement | null);
  };

  return (
    <>
      <div className="panel-head">
        <h3>Layers</h3>
        <span className="context ellipsis" title={defOwner ? `Layers of the ${st.components[defOwner.id]?.name} component` : `Layers on ${page.title}`}>
          {defOwner ? st.components[defOwner.id]?.name : page.title}
        </span>
      </div>
      <div className="panel-body" role="tree" aria-label="Layers" ref={treeRef} onKeyDown={(e) => rovingKeys(e, 'treeitem')}>
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
            <div className="list-section">
              <FileText size={12} /> Page content
            </div>
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

type MenuFn = (el: HTMLElement | { x: number; y: number }, ref: ElementRef, top: boolean, onRename?: () => void) => void;

function TreeList(props: { state: ProjectState; owner: OwnerRef; tree: NodeTree; ids: string[]; depth: number; onMenu: MenuFn; parentId?: string }) {
  return (
    <div className="list" role="group" style={{ padding: props.depth ? 0 : undefined }}>
      {props.ids.map((id) => (
        <LayerRow key={id} {...props} id={id} parentId={props.parentId} />
      ))}
    </div>
  );
}

function LayerRow({ state, owner, tree, id, depth, onMenu, parentId }: { state: ProjectState; owner: OwnerRef; tree: NodeTree; id: string; depth: number; onMenu: MenuFn; parentId?: string }) {
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
  const definitionMode = useStore((s) => s.definitionMode);
  // In component editing the canvas selects the definition's root through the placement; match it here.
  const defRoot = owner.kind === 'component' && !!definitionMode && !!selection && selection.instancePath.length === 1 && selection.nodeId === id;
  const selected = sameRef(selection, ref) || defRoot;
  // Holds the selection: a part of this component, or any node nested inside this container.
  // Holds the selection: a part of this component (at any depth), or anything nested inside this container,
  // judged by where the selection's outermost component sits in this tree.
  const anchor = selection && selection.owner.id === owner.id ? (selection.instancePath[0] ?? selection.nodeId) : null;
  const containsSel = !!anchor && (anchor === id ? !!selection!.instancePath.length : subtreeIds(tree, id).includes(anchor));
  // Opening to reveal a selected part latches, so moving the selection back to the parent keeps the branch open.
  useEffect(() => {
    if (containsSel) setOpen(true);
  }, [containsSel]);
  const isOpen = open;
  useEffect(() => {
    markDraft(`layer-rename:${id}`, renaming);
    return () => markDraft(`layer-rename:${id}`, false);
  }, [renaming, id]);
  const pad = 8 + depth * 14;
  return (
    <>
      <div
        className={`list-item${selected ? ' selected' : ''}${selected && owner.kind === 'shell' ? ' shared' : ''}${containsSel && !selected ? ' contains-sel' : ''}${drop === 'before' ? ' drop-before' : drop === 'after' ? ' drop-after' : ''}`}
        data-node={id}
        aria-label={owner.kind === 'component' && state.components[owner.id]?.tree?.rootIds[0] === id ? state.components[owner.id].name : displayName(state, n)}
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
        aria-level={depth + 1}
        tabIndex={-1}
        onClick={() => setState({ selection: ref })}
        onDoubleClick={() => setRenaming(true)}
        onMouseEnter={() => setState({ hover: ref })}
        onMouseLeave={() => setState({ hover: null })}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu({ x: e.clientX, y: e.clientY }, ref, true, () => setRenaming(true));
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'ArrowRight' && expandable) {
            e.preventDefault();
            if (!isOpen) setOpen(true);
            else {
              // Already open: move into the first child.
              const rows = [...(e.currentTarget.closest('[role="tree"]')?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
              const child = rows[rows.indexOf(e.currentTarget) + 1];
              if (child) (child.focus(), child.click());
            }
          }
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (isOpen && expandable) {
              if (containsSel) setState({ selection: ref });
              setOpen(false);
            }
            else if (parentId) {
              const up = document.querySelector<HTMLElement>(`[data-node="${parentId}"]`);
              up?.focus();
              up?.click();
            }
          }
          if (e.key === 'Enter') setState({ selection: ref });
          if (e.key === 'F2') setRenaming(true);
          if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') (e.preventDefault(), onMenu(e.currentTarget, ref, true, () => setRenaming(true)));
        }}
      >
        {expandable ? (
          <button
            className={`tree-toggle${isOpen ? ' open' : ''}`}
            tabIndex={-1}
            aria-label={isOpen ? 'Collapse' : 'Expand'}
            onClick={(e) => {
              e.stopPropagation();
              // Collapsing a branch that holds the selection moves the selection (and focus) to the branch.
              if (isOpen && containsSel) {
                setState({ selection: ref });
                (e.currentTarget.closest('[role="treeitem"]') as HTMLElement | null)?.focus();
              }
              setOpen(!isOpen);
            }}
          >
            <ChevronRight />
          </button>
        ) : (
          <span className="tree-spacer" />
        )}
        <span className={`layer-kind${n.kind === 'instance' && owner.kind === 'shell' ? ' shell' : owner.kind === 'component' ? ' definition' : ''}`}>{kindIcon(n)}</span>
        {renaming ? (
          <input
            className="input inline-edit grow"
            autoFocus
            defaultValue={n.name ?? ''}
            placeholder={displayName(state, n)}
            aria-label={`Rename ${displayName(state, n)}`}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              setRenaming(false);
              requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-node="${id}"]`)?.focus());
              if (e.target.value !== (n.name ?? '')) void applyOps([{ type: 'node.rename', owner, nodeId: id, name: e.target.value }], 'Rename layer');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <span className="grow ellipsis">{owner.kind === 'component' && state.components[owner.id]?.tree?.rootIds[0] === id ? state.components[owner.id].name : displayName(state, n)}</span>
        )}
        {isHidden(n) && <EyeOff />}
        {def?.owner === 'project' && <span className="badge" title="A component made in this project">Custom</span>}
        <span className="actions">
          <button className="icon-btn sm" tabIndex={-1} aria-haspopup="menu" aria-expanded="false" aria-label={`${displayName(state, n)} options`} title="Layer options" onClick={(e) => (e.stopPropagation(), onMenu(e.currentTarget, ref, true, () => setRenaming(true)))}>
            <Ellipsis />
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
                className={`list-item${psel ? ' selected' : ''}${psel && owner.kind === 'shell' ? ' shared' : ''}`}
                aria-label={p.label}
                style={{ paddingLeft: pad + 30 }}
                role="treeitem"
                aria-selected={psel}
                aria-level={depth + 2}
                tabIndex={-1}
                onClick={() => setState({ selection: pref })}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') (e.preventDefault(), setState({ selection: ref }), document.querySelector<HTMLElement>(`[data-node="${id}"]`)?.focus());
                  if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), setState({ selection: pref }));
                  if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') (e.preventDefault(), onMenu(e.currentTarget, pref, false));
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onMenu({ x: e.clientX, y: e.clientY }, pref, false);
                }}
                onMouseEnter={() => setState({ hover: pref })}
                onMouseLeave={() => setState({ hover: null })}
              >
                <span className="layer-kind part">{def?.tree?.nodes[p.nodeId] ? kindIcon(def.tree.nodes[p.nodeId]) : <Box />}</span>
                <span className="grow ellipsis">{p.label}</span>
                <span className="actions">
                  <button className="icon-btn sm" tabIndex={-1} aria-haspopup="menu" aria-expanded="false" aria-label={`${p.label} options`} title="Part options" onClick={(e) => (e.stopPropagation(), onMenu(e.currentTarget, pref, false))}>
                    <Ellipsis />
                  </button>
                </span>
              </div>
            );
          })}
          {slotChildren.length > 0 && <TreeList state={state} owner={owner} tree={tree} ids={slotChildren} depth={depth + 1} onMenu={onMenu} parentId={id} />}
        </>
      )}
    </>
  );
}
