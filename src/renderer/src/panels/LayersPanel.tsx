import { Fragment, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Box, ChevronRight, Columns3, Component, Copy, CornerDownRight, Ellipsis, Eye, EyeOff, FileText, Image, LayoutGrid, Link2, Minus, PanelBottom, PanelTop, Pencil, Plus, Repeat, Rows3, Shapes, Sparkles, Square, SquareDashed, Trash2, Type } from 'lucide-react';
import type { ElementRef, GraphNode, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import { refKey, sameRef } from '@shared/types';
import { childLists, codeTakesOverrides, displayName, findParent, subtreeIds } from '@engine/tree';
import { applyOps, markDraft, setState, useStore } from '../store';
import { rovingKeys, useMenu, useRovingTabStop } from '../components/ui';
import { isImeComposing } from '../lib/ime';
import { askAiAbout, deleteSelection, duplicateSelection, moveSelection } from '../lib/actions';

/*
 * The Layers panel: the current page's outline (shared header, page content, shared footer), or a
 * component's own tree while it is being edited everywhere. It follows the WAI-ARIA tree pattern: one tab
 * stop, arrows move (selection follows focus), Right/Left open and close, type-ahead jumps by name.
 *
 * Rows line up on one indent step (12px, 9px in a narrow sidebar; styles.css owns --layers-pad and
 * --layers-indent, so a row only carries its --depth). Each open branch draws a straight guide down its
 * children, darker on the path to the selection. A component's parts sit under a small "Parts" label, in
 * the same column as the content placed in its slot, which gets its slot's name when both are shown.
 */

/** A row's depth, for the CSS that turns it into its indent (and its guide and drop-line positions). */
const depthVar = (depth: number) => ({ '--depth': depth }) as React.CSSProperties;

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
    case 'icon':
      return <Shapes />;
    case 'divider':
      return <Minus />;
    case 'repeat':
      return <Repeat />;
    case 'slot':
      return <SquareDashed />;
    case 'element': {
      const layout = n.styles?.base?.layout;
      if (layout === 'grid') return <LayoutGrid />;
      if (layout === 'row') return <Columns3 />;
      if (layout === 'stack') return <Rows3 />;
      return <Square />;
    }
    default:
      return <Box />;
  }
}

/** The layer currently being dragged (only nodes owned directly by a page or definition tree). */
let dragging: { owner: OwnerRef; nodeId: string } | null = null;

function isHidden(n: GraphNode) {
  return !!n.styles?.base?.hidden || (n.kind === 'instance' && !!n.overrides?.root?.base?.hidden);
}

/** Whether hiding a layer can work: not a repeat or slot, and not a code component that ignores the classes it is given. */
function hideable(state: ProjectState, n: GraphNode) {
  if (n.kind === 'repeat' || n.kind === 'slot') return false;
  if (n.kind !== 'instance') return true;
  const def = state.components[n.definitionId];
  return !!def && codeTakesOverrides(def);
}

/** Hide a layer at every size, or show it again. Sizes with their own visibility keep it. */
function toggleHidden(owner: OwnerRef, n: GraphNode, name: string) {
  const hide = !isHidden(n);
  void applyOps([{ type: 'node.setStyle', owner, nodeId: n.id, ...(n.kind === 'instance' ? { partId: 'root' } : {}), scope: 'base', property: 'hidden', value: hide ? true : null }], hide ? `Hide ${name}` : `Show ${name}`);
}

/** The visible rows, in order (a row inside a closed branch is not rendered at all). */
const treeRows = (from: Element | null) => [...(from?.closest('[role="tree"]')?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
const rowFor = (id: string) => document.querySelector<HTMLElement>(`.layers-tree [data-node="${id}"]`);

export function LayersPanel() {
  const snap = useStore((s) => s.snapshot);
  const pageId = useStore((s) => s.pageId);
  const definitionMode = useStore((s) => s.definitionMode);
  const visible = useStore((s) => s.leftTab === 'layers');
  const menu = useMenu();
  const treeRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });
  // The panel owns the tree's single tab stop; it re-reconciles whenever the selection changes.
  const selection = useStore((s) => s.selection);
  useRovingTabStop(treeRef, 'treeitem');
  // A selection made elsewhere (the canvas, the inspector) scrolls its row into view once its branches have
  // opened, and again when the panel is shown; keyboard focus stays where it is.
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      const tree = treeRef.current;
      if (!tree || tree.contains(document.activeElement)) return;
      tree.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }, 60);
    return () => clearTimeout(t);
  }, [selection, visible]);
  // Rows mount and unmount inside branches that open on their own (revealing a canvas selection), which does
  // not re-render the panel: keep exactly one tabbable row whenever the rows change.
  useEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    const reconcile = () => {
      const rows = [...el.querySelectorAll<HTMLElement>('[role="treeitem"]')];
      if (!rows.length) return;
      const keep = rows.find((r) => r.getAttribute('aria-selected') === 'true') ?? rows.find((r) => r.contains(document.activeElement)) ?? rows[0];
      for (const r of rows) if (r.tabIndex !== (r === keep ? 0 : -1)) r.tabIndex = r === keep ? 0 : -1;
    };
    const mo = new MutationObserver(reconcile);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  if (!snap || !pageId) return null;
  const st = snap.state;
  const page = st.pages[pageId];
  const defOwner: OwnerRef | null = definitionMode ? { kind: 'component', id: definitionMode.definitionId } : null;
  const defTree = defOwner ? st.components[defOwner.id]?.tree : null;

  const openMenu = (el: HTMLElement | { x: number; y: number; returnTo?: HTMLElement }, ref: ElementRef, topLevel: boolean, onRename?: () => void) => {
    setState({ selection: ref });
    const tree = ref.owner.kind === 'shell' ? st.site.shell[ref.owner.id as 'header' | 'footer'] : ref.owner.kind === 'component' ? st.components[ref.owner.id].tree! : st.pages[ref.owner.id];
    const node = tree.nodes[ref.instancePath[0] ?? ref.nodeId];
    const partDef = ref.partId && node?.kind === 'instance' ? st.components[node.definitionId] : undefined;
    const isDefRoot = ref.owner.kind === 'component' && !ref.instancePath.length && tree.rootIds[0] === ref.nodeId;
    const name = partDef && ref.partId ? partDef.parts[ref.partId]?.label ?? ref.partId : isDefRoot ? st.components[ref.owner.id]?.name ?? 'Component' : node ? displayName(st, node) : 'Layer';
    // Shared header and footer rows are shared across pages: they are not moved, duplicated or deleted here.
    // The root of a component being edited is the component itself: it is not moved, copied or deleted here.
    const editable = topLevel && ref.owner.kind !== 'shell' && !isDefRoot;
    const here = editable && !ref.instancePath.length ? findParent(tree, ref.nodeId) : null;
    // "Move to…": the keyboard and menu equivalent of dragging a layer into another container or slot.
    const destinations = (() => {
      if (!editable || ref.instancePath.length || !node) return [];
      const inside = new Set(subtreeIds(tree, ref.nodeId));
      const out: Array<{ path: string[]; parentId: string | null; slot?: string; index: number }> = [];
      // Each destination carries its full path of names, so repeated names can be told apart by their parents.
      const pathOf = (id: string): string[] => {
        const names: string[] = [];
        let cur: string | null = id;
        while (cur) {
          const n: GraphNode | undefined = tree.nodes[cur];
          if (!n) break;
          names.unshift(displayName(st, n));
          const up = findParent(tree, cur);
          // Content placed in a component's slot is named by that slot too ("Spring 2026 … › Content › Row").
          const holder = up?.parentId ? tree.nodes[up.parentId] : undefined;
          if (up?.slot && holder?.kind === 'instance') names.unshift(st.components[holder.definitionId]?.slots?.[up.slot]?.label ?? up.slot);
          cur = up?.parentId ?? null;
        }
        return names;
      };
      if (here?.parentId !== null) out.push({ path: [ref.owner.kind === 'component' ? 'Top level of this component' : 'Top level of the page'], parentId: null, index: tree.rootIds.length });
      // Walk the tree in outline order, so numbered duplicates follow the order the user sees.
      const ordered: GraphNode[] = [];
      const walk = (id: string) => {
        const n = tree.nodes[id];
        if (!n || ordered.includes(n)) return;
        ordered.push(n);
        for (const ids of childIdsInOrder(st, n)) ids.forEach(walk);
      };
      tree.rootIds.forEach(walk);
      for (const n of ordered) {
        if (inside.has(n.id)) continue;
        if (n.kind === 'element') {
          if (here?.parentId === n.id) continue;
          out.push({ path: pathOf(n.id), parentId: n.id, index: n.children.length });
        } else if (n.kind === 'instance') {
          const slots = st.components[n.definitionId]?.slots ?? {};
          for (const [slot, info] of Object.entries(slots)) {
            if (here?.parentId === n.id && here.slot === slot) continue;
            out.push({ path: [...pathOf(n.id), info.label], parentId: n.id, slot, index: n.slots?.[slot]?.length ?? 0 });
          }
        }
      }
      // The shortest tail of each path that is unique; identical paths are numbered in page order.
      const labels = out.map((d) => {
        if (d.parentId === null) return d.path[0];
        // A slot is always named with its component ("Spring 2026 … › Content"), never on its own.
        for (let k = d.slot ? 2 : 1; k <= d.path.length; k++) {
          const tail = d.path.slice(-k).join(' › ');
          if (out.filter((o) => o.parentId !== null && o.path.slice(-k).join(' › ') === tail).length < 2) return tail;
        }
        return d.path.join(' › ');
      });
      return out.map((d, i) => {
        const same = labels.filter((l, j) => l === labels[i] && j < i).length;
        const total = labels.filter((l) => l === labels[i]).length;
        return { ...d, label: total > 1 ? `${labels[i]} (${same + 1} of ${total})` : labels[i] };
      });
    })();
    const moveTo = (anchor: { x: number; y: number }) =>
      menu.open(
        anchor.x,
        anchor.y,
        [
          { heading: `Move ${name} into…` },
          ...destinations.map((d) => ({
            label: d.label,
            // The row remounts under its new parent; keyboard focus follows it there.
            onSelect: () => void applyOps([{ type: 'node.move', owner: ref.owner, nodeId: ref.nodeId, parentId: d.parentId, slot: d.slot, index: d.index }], 'Move layer').then(() => setTimeout(() => rowFor(ref.nodeId)?.focus(), 80))
          }))
        ],
        `Move ${name}`,
        rowFor(ref.nodeId)
      );
    const anchorOf = () => (el instanceof HTMLElement ? (() => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.bottom + 4 }; })() : el);
    const items = [
      { heading: name },
      ...(onRename ? [{ label: 'Rename', icon: <Pencil />, shortcut: 'F2', onSelect: onRename }] : []),
      { label: 'Ask AI about this', icon: <Sparkles />, shortcut: '⌘J', onSelect: () => askAiAbout(ref) },
      ...(editable && here
        ? [
            { separator: true },
            { label: 'Move up', icon: <ArrowUp />, shortcut: '⇧⌘↑', disabled: here.index === 0, onSelect: () => void moveSelection(-1) },
            { label: 'Move down', icon: <ArrowDown />, shortcut: '⇧⌘↓', disabled: here.index >= here.list.length - 1, onSelect: () => void moveSelection(1) },
            ...(destinations.length ? [{ label: 'Move into…', icon: <CornerDownRight />, onSelect: () => setTimeout(() => moveTo(anchorOf()), 0) }] : [])
          ]
        : []),
      ...(editable && node && !ref.instancePath.length && hideable(st, node)
        ? [{ label: isHidden(node) ? 'Show on the page' : 'Hide on the page', icon: isHidden(node) ? <Eye /> : <EyeOff />, onSelect: () => toggleHidden(ref.owner, node, name) }]
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
    else menu.open(el.x, el.y, items, `${name} options`, el.returnTo ?? (document.activeElement as HTMLElement | null));
  };

  /** Arrow keys (shared roving), plus type-ahead: typing a name's first letters jumps to the next match. */
  const onTreeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    rovingKeys(e, 'treeitem');
    if (e.defaultPrevented || e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
    const now = Date.now();
    const key = e.key.toLowerCase();
    let buf = (now - typed.current.at > 700 ? '' : typed.current.text) + key;
    if (buf === ' ') return;
    // The same letter again ("g", "g") steps to the next name starting with it rather than looking for "gg".
    if (buf.length > 1 && [...buf].every((c) => c === key)) buf = key;
    typed.current = { text: buf, at: now };
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const at = rows.indexOf(t.closest('[role="treeitem"]') as HTMLElement);
    // A repeated single letter cycles through the matches; a longer prefix keeps the current row if it matches.
    const start = buf.length === 1 ? at + 1 : Math.max(0, at);
    const order = [...rows.slice(start), ...rows.slice(0, start)];
    const hit = order.find((r) => (r.dataset.name ?? '').toLowerCase().startsWith(buf));
    if (!hit) return;
    e.preventDefault();
    if (hit !== rows[at]) (hit.focus(), hit.click());
  };

  return (
    <>
      <div className="panel-head">
        <h3>Layers</h3>
        <span className="context ellipsis" title={defOwner ? `Layers of the ${st.components[defOwner.id]?.name} component` : `Layers on ${page.title}`}>
          {defOwner ? st.components[defOwner.id]?.name : page.title}
        </span>
      </div>
      <div className="panel-body layers-tree" role="tree" aria-label="Layers" ref={treeRef} onKeyDown={onTreeKey}>
        {defOwner && defTree ? (
          <>
            <SectionLabel id="layers-sec-component" icon={<Component />} label="Component layers" />
            <TreeList state={st} owner={defOwner} tree={defTree} ids={defTree.rootIds} depth={0} onMenu={openMenu} path={[]} labelledBy="layers-sec-component" />
          </>
        ) : (
          <>
            {page.shell !== 'none' && (
              <>
                <SectionLabel id="layers-sec-header" icon={<PanelTop />} label="Shared header" />
                <TreeList state={st} owner={{ kind: 'shell', id: 'header' }} tree={st.site.shell.header} ids={st.site.shell.header.rootIds} depth={0} onMenu={openMenu} path={['Shared header']} labelledBy="layers-sec-header" />
              </>
            )}
            <SectionLabel id="layers-sec-page" icon={<FileText />} label="Page content" />
            {page.rootIds.length > 0 ? (
              <TreeList state={st} owner={{ kind: 'page', id: pageId }} tree={page} ids={page.rootIds} depth={0} onMenu={openMenu} path={[]} labelledBy="layers-sec-page" />
            ) : (
              <div
                className="layers-empty"
                role="none"
                // Keys here are the button's, not the tree's; Undo and Redo still reach the editor, as from anywhere in Layers.
                onKeyDown={(e) => !((e.metaKey || e.ctrlKey) && ['z', 'y'].includes(e.key.toLowerCase())) && e.stopPropagation()}
              >
                <p>No page content yet</p>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setState({ leftTab: 'insert' });
                    // Hand focus to the Insert panel that replaces this one, rather than leaving it on a hidden button.
                    requestAnimationFrame(() => document.querySelector<HTMLElement>('.side-panel-view:not([hidden]) :is(input, button, [tabindex="0"])')?.focus());
                  }}
                >
                  <Plus /> Add sections
                </button>
              </div>
            )}
            {page.shell !== 'none' && (
              <>
                <SectionLabel id="layers-sec-footer" icon={<PanelBottom />} label="Shared footer" />
                <TreeList state={st} owner={{ kind: 'shell', id: 'footer' }} tree={st.site.shell.footer} ids={st.site.shell.footer.rootIds} depth={0} onMenu={openMenu} path={['Shared footer']} labelledBy="layers-sec-footer" />
              </>
            )}
          </>
        )}
      </div>
      {menu.node}
    </>
  );
}

/** A group heading. Hidden from assistive tech itself; its group is labelled by it instead. */
function SectionLabel({ id, icon, label }: { id: string; icon: React.ReactNode; label: string }) {
  return (
    <div className="list-section" id={id} aria-hidden="true">
      {icon} {label}
    </div>
  );
}

type MenuFn = (el: HTMLElement | { x: number; y: number; returnTo?: HTMLElement }, ref: ElementRef, top: boolean, onRename?: () => void) => void;

/** A branch's child lists in outline order (an instance's slots in its definition's order). */
function childIdsInOrder(state: ProjectState, n: GraphNode): string[][] {
  if (n.kind !== 'instance') return childLists(n).map((l) => l.ids);
  return Object.keys(state.components[n.definitionId]?.slots ?? {}).map((slot) => n.slots?.[slot] ?? []);
}
interface ListProps {
  state: ProjectState;
  owner: OwnerRef;
  tree: NodeTree;
  depth: number;
  onMenu: MenuFn;
  /** Names of the layers above this list, for the full-path tooltip. */
  path: string[];
}

function TreeList(props: ListProps & { ids: string[]; labelledBy: string }) {
  return (
    <div className="list" role="group" aria-labelledby={props.labelledBy}>
      {props.ids.map((id) => (
        <LayerRow key={id} {...props} id={id} />
      ))}
    </div>
  );
}

type Drop = { where: 'before' | 'after' | 'inside' | 'first'; depth: number; label?: string };

function LayerRow({ state, owner, tree, id, depth, onMenu, path, parentId }: ListProps & { id: string; parentId?: string }) {
  const selection = useStore((s) => s.selection);
  const definitionMode = useStore((s) => s.definitionMode);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [drop, setDrop] = useState<Drop | null>(null);
  const cancelRename = useRef(false);
  const n = tree.nodes[id];
  const ref: ElementRef = { owner, instancePath: [], nodeId: id };
  const def = n?.kind === 'instance' ? state.components[n.definitionId] : undefined;
  const parts = def ? Object.entries(def.parts).filter(([pid]) => pid !== 'root') : [];
  // Slot content, per slot in the definition's order (an element has one unnamed list).
  const slotLists: Array<{ slot?: string; label?: string; ids: string[] }> =
    n?.kind === 'instance'
      ? Object.entries(def?.slots ?? {}).map(([slot, info]) => ({ slot, label: info.label, ids: n.slots?.[slot] ?? [] })).filter((l) => l.ids.length)
      : n
        ? childLists(n)
        : [];
  const childCount = slotLists.reduce((c, l) => c + l.ids.length, 0);
  const expandable = parts.length > 0 || childCount > 0;
  const canHold = n?.kind === 'element' || (n?.kind === 'instance' && Object.keys(def?.slots ?? {}).length > 0);
  // In component editing the canvas selects the definition's root through the placement; match it here.
  const isDefRoot = owner.kind === 'component' && state.components[owner.id]?.tree?.rootIds[0] === id;
  const defRoot = isDefRoot && !!definitionMode && !!selection && selection.instancePath.length === 1 && selection.nodeId === id;
  // A node of a component being edited, picked on the canvas in one repeated item, is still this row.
  const selected = sameRef(selection, ref) || defRoot || (owner.kind === 'component' && !!selection?.itemPath?.length && sameRef({ ...selection, itemPath: undefined }, ref));
  // Holds the selection: a part of this component (at any depth), or anything nested inside this container,
  // judged by where the selection's outermost component sits in this tree.
  const anchor = selection && selection.owner.id === owner.id ? (selection.instancePath[0] ?? selection.nodeId) : null;
  const containsSel = !!n && !!anchor && (anchor === id ? !!selection!.instancePath.length : subtreeIds(tree, id).includes(anchor));
  // Opening to reveal a selected part latches, so moving the selection back to the parent keeps the branch open.
  useEffect(() => {
    if (containsSel) setOpen(true);
  }, [containsSel]);
  useEffect(() => {
    markDraft(`layer-rename:${id}`, renaming);
    return () => markDraft(`layer-rename:${id}`, false);
  }, [renaming, id]);
  if (!n) return null;
  const isOpen = open && expandable;
  const name = isDefRoot ? state.components[owner.id]?.name ?? displayName(state, n) : displayName(state, n);
  const hidden = isHidden(n);
  const custom = def?.owner === 'project';
  const groupId = `layers-group-${owner.kind}-${id}`;
  const title = [name, path.length ? `In ${path.join(' › ')}` : '', custom ? 'Made in this project' : '', hidden ? 'Hidden on the page' : ''].filter(Boolean).join('\n');
  const draggable = owner.kind !== 'shell' && !isDefRoot;
  const canToggleHidden = owner.kind !== 'shell' && !isDefRoot && hideable(state, n);
  const startRename = () => {
    cancelRename.current = false;
    setRenaming(true);
  };

  // Where a drop lands, as the move it would make; null when it would leave everything where it is.
  const dropMove = (where: Drop['where']): { parentId: string | null; slot?: string; index: number } | null => {
    if (!dragging) return null;
    const source = findParent(tree, dragging.nodeId);
    if (!source) return null;
    if (where === 'inside' || where === 'first') {
      const slot = n.kind === 'instance' ? Object.keys(def?.slots ?? {})[0] : undefined;
      const list = n.kind === 'element' ? n.children : n.kind === 'instance' ? n.slots?.[slot!] ?? [] : [];
      const index = where === 'first' ? 0 : list.length;
      const same = source.parentId === id && source.slot === slot;
      if (same && (where === 'first' ? source.index === 0 : source.index === list.length - 1)) return null;
      return { parentId: id, slot, index: same && where === 'inside' ? list.length - 1 : index };
    }
    const target = findParent(tree, id);
    if (!target) return null;
    // A repeated item's template is edited through its list, not by moving layers into or within it.
    if (target.parentId && tree.nodes[target.parentId]?.kind === 'repeat') return null;
    let index = target.index + (where === 'after' ? 1 : 0);
    const sameList = source.parentId === target.parentId && source.slot === target.slot;
    if (sameList && source.index < index) index -= 1;
    if (sameList && index === source.index) return null;
    return { parentId: target.parentId, slot: target.slot, index };
  };

  const rowClass = [
    'list-item',
    'layer-row',
    selected && 'selected',
    selected && owner.kind === 'shell' && 'shared',
    containsSel && !selected && 'contains-sel',
    hidden && 'is-hidden',
    drop?.where === 'before' && 'drop-before',
    (drop?.where === 'after' || drop?.where === 'first') && 'drop-after',
    drop?.where === 'inside' && 'drop-inside',
    custom && 'is-custom'
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <div
        className={rowClass}
        data-node={id}
        data-name={name}
        aria-label={`${name}${custom ? ', made in this project' : ''}${hidden ? ', hidden' : ''}`}
        style={{ ...depthVar(depth), '--drop-depth': drop?.depth ?? depth } as React.CSSProperties}
        draggable={draggable && !renaming}
        onDragStart={(e) => {
          dragging = { owner, nodeId: id };
          e.dataTransfer.effectAllowed = 'move';
          e.currentTarget.setAttribute('data-dragging', '');
        }}
        onDragEnd={(e) => {
          dragging = null;
          e.currentTarget.removeAttribute('data-dragging');
        }}
        onDragOver={(e) => {
          if (!dragging || dragging.owner.kind !== owner.kind || dragging.owner.id !== owner.id || dragging.nodeId === id) return;
          if (subtreeIds(tree, dragging.nodeId).includes(id)) return;
          const r = e.currentTarget.getBoundingClientRect();
          const rel = (e.clientY - r.top) / r.height;
          // An open component with parts takes its whole lower part as "into its slot": there is no clean edge there.
          const insideTo = isOpen && canHold && parts.length > 0 ? 1.01 : 0.7;
          let where: Drop['where'] = canHold && rel > 0.3 && rel < insideTo ? 'inside' : rel < 0.5 ? 'before' : 'after';
          // Below an open branch the next row is its first child, so "after" there means "first inside". When the
          // next rows are the component's parts, the slot starts further down: its own first row takes that drop.
          if (where === 'after' && isOpen) {
            if (!canHold || parts.length > 0) return setDrop(null);
            where = 'first';
          }
          if (!dropMove(where)) return setDrop(null);
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const slotLabel = n.kind === 'instance' ? Object.values(def?.slots ?? {})[0]?.label : undefined;
          const next: Drop = { where, depth: where === 'first' ? depth + 1 : depth, label: where === 'inside' ? (slotLabel ? `Into ${slotLabel}` : 'Inside') : undefined };
          if (next.where !== drop?.where || next.depth !== drop?.depth) setDrop(next);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          const d = dragging;
          const where = drop?.where;
          const move = where ? dropMove(where) : null;
          setDrop(null);
          dragging = null;
          if (!d || !move) return;
          void applyOps([{ type: 'node.move', owner, nodeId: d.nodeId, parentId: move.parentId, slot: move.slot, index: move.index }], 'Move layer');
        }}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={expandable ? isOpen : undefined}
        aria-owns={isOpen ? groupId : undefined}
        aria-level={depth + 1}
        tabIndex={-1}
        onClick={() => setState({ selection: ref })}
        onDoubleClick={startRename}
        onMouseEnter={() => setState({ hover: ref })}
        onMouseLeave={() => setState({ hover: null })}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu({ x: e.clientX, y: e.clientY, returnTo: e.currentTarget }, ref, true, startRename);
        }}
        onKeyDown={(e) => {
          // Keys reach the row from the row itself or from its chevron and options buttons (focus can land
          // there after a click or when the menu closes); the rename field keeps its own keys.
          const t = e.target as HTMLElement;
          if (t !== e.currentTarget && t.tagName !== 'BUTTON') return;
          const row = e.currentTarget;
          if (e.key === 'ArrowRight' && expandable) {
            e.preventDefault();
            if (!isOpen) (setOpen(true), row.focus());
            else {
              // Already open: move into the first child.
              const rows = treeRows(row);
              const child = rows[rows.indexOf(row) + 1];
              if (child) (child.focus(), child.click());
            }
          }
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (isOpen) {
              if (containsSel) setState({ selection: ref });
              setOpen(false);
              row.focus();
            } else if (parentId) {
              const up = rowFor(parentId);
              up?.focus();
              up?.click();
            }
          }
          if ((e.key === 'Enter' || e.key === ' ') && t === row) (e.preventDefault(), setState({ selection: ref }));
          if (e.key === 'F2') (e.preventDefault(), startRename());
          if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') (e.preventDefault(), onMenu(row, ref, true, startRename));
        }}
      >
        {expandable ? (
          <button
            className={`tree-toggle${isOpen ? ' open' : ''}`}
            tabIndex={-1}
            aria-hidden="true"
            title={isOpen ? 'Collapse' : 'Expand'}
            onDoubleClick={(e) => e.stopPropagation()}
            // Opening or closing a branch leaves focus (and so the target of ⌘D, ⌫ and the move keys) where it was.
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              // Collapsing a branch that holds the selection moves the selection, and focus if it was in the tree, to the branch.
              if (isOpen && containsSel) {
                setState({ selection: ref });
                const row = e.currentTarget.closest<HTMLElement>('[role="treeitem"]');
                if (row?.closest('[role="tree"]')?.contains(document.activeElement)) row.focus();
              }
              setOpen(!isOpen);
            }}
          >
            <ChevronRight />
          </button>
        ) : (
          <span className="tree-spacer" />
        )}
        <span className={`layer-kind${n.kind === 'instance' && owner.kind === 'shell' ? ' shell' : isDefRoot && definitionMode ? ' definition' : ''}`}>{isDefRoot ? <Component /> : kindIcon(n)}</span>
        {renaming ? (
          <input
            className="input inline-edit grow"
            autoFocus
            defaultValue={name}
            maxLength={60}
            aria-label={`Rename ${name}`}
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              setRenaming(false);
              const value = e.target.value.trim();
              // Focus goes back to the row unless it moved somewhere on purpose (Tab, or a click on a control).
              if (!e.relatedTarget) requestAnimationFrame(() => rowFor(id)?.focus());
              if (cancelRename.current || value === name) return;
              if (isDefRoot) {
                if (value) void applyOps([{ type: 'component.rename', definitionId: owner.id, name: value }], 'Rename component');
              } else if (value !== (n.name ?? '')) void applyOps([{ type: 'node.rename', owner, nodeId: id, name: value }], 'Rename layer');
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (isImeComposing(e)) return;
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                e.preventDefault();
                cancelRename.current = true;
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <span className="grow ellipsis layer-name" title={title}>
            {name}
          </span>
        )}
        {hidden && !renaming && !canToggleHidden && (
          <span className="layer-flag" title="Hidden on the page">
            <EyeOff aria-hidden="true" />
          </span>
        )}
        {/* The eye shows (and switches) visibility at every size; a hidden layer always shows it. Like the row's
            other actions it is for the pointer: the row's menu (Shift+F10) has Hide and Show for the keyboard. */}
        {canToggleHidden && !renaming && (
          <button
            className={`icon-btn sm layer-eye${hidden ? ' on' : ''}`}
            tabIndex={-1}
            aria-label={hidden ? `Show ${name}` : `Hide ${name}`}
            aria-pressed={hidden}
            title={hidden ? 'Hidden on the page. Click to show it.' : 'Hide on the page'}
            onClick={(e) => (e.stopPropagation(), toggleHidden(owner, n, name))}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {hidden ? <EyeOff /> : <Eye />}
          </button>
        )}
        {custom && !renaming && (
          <span className="badge layer-badge" title="A component made in this project">
            Custom
          </span>
        )}
        {drop?.where === 'inside' && (
          <span className="layer-drop-tag" aria-hidden="true">
            {drop.label}
          </span>
        )}
        <span className="actions" style={renaming ? { display: 'none' } : undefined}>
          <button className="icon-btn sm" tabIndex={-1} aria-haspopup="menu" aria-expanded="false" aria-label={`${name} options`} title="Layer options" onDoubleClick={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), onMenu(e.currentTarget, ref, true, startRename))}>
            <Ellipsis />
          </button>
        </span>
      </div>
      {isOpen && (
        <div id={groupId} className={`layers-children${containsSel ? ' on-path' : ''}`} role="group" aria-label={`Inside ${name}`} style={depthVar(depth)}>
          {parts.length > 0 && <SubLabel depth={depth + 1} label="Parts" />}
          {parts.map(([pid, p]) => {
            const pref: ElementRef = { owner, instancePath: [id], nodeId: p.nodeId, partId: pid };
            const psel = !!selection && refKey({ ...selection, itemPath: undefined }) === refKey(pref);
            const partNode = def?.tree?.nodes[p.nodeId];
            return (
              <div
                key={pid}
                className={`list-item layer-row layer-part${psel ? ' selected' : ''}${psel && owner.kind === 'shell' ? ' shared' : ''}`}
                data-name={p.label}
                aria-label={`${p.label}, part of ${name}`}
                style={depthVar(depth + 1)}
                role="treeitem"
                aria-selected={psel}
                aria-level={depth + 2}
                tabIndex={-1}
                onClick={() => setState({ selection: pref })}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') (e.preventDefault(), setState({ selection: ref }), rowFor(id)?.focus());
                  if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) (e.preventDefault(), setState({ selection: pref }));
                  if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') (e.preventDefault(), onMenu(e.currentTarget, pref, false));
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onMenu({ x: e.clientX, y: e.clientY, returnTo: e.currentTarget }, pref, false);
                }}
                onMouseEnter={() => setState({ hover: pref })}
                onMouseLeave={() => setState({ hover: null })}
              >
                <span className="tree-spacer" />
                <span className="layer-kind part">{partNode ? kindIcon(partNode) : <Box />}</span>
                <span className="grow ellipsis layer-name" title={`${p.label}\nPart of ${[...path, name].join(' › ')}`}>
                  {p.label}
                </span>
                <span className="actions">
                  <button className="icon-btn sm" tabIndex={-1} aria-haspopup="menu" aria-expanded="false" aria-label={`${p.label} options`} title="Part options" onDoubleClick={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), onMenu(e.currentTarget, pref, false))}>
                    <Ellipsis />
                  </button>
                </span>
              </div>
            );
          })}
          {slotLists.map((l) => (
            <Fragment key={l.slot ?? 'children'}>
              {(parts.length > 0 || slotLists.length > 1) && l.label && <SubLabel depth={depth + 1} label={l.label} />}
              {l.ids.map((cid) => (
                <LayerRow key={cid} state={state} owner={owner} tree={tree} id={cid} depth={depth + 1} onMenu={onMenu} path={[...path, name]} parentId={id} />
              ))}
            </Fragment>
          ))}
        </div>
      )}
    </>
  );
}

/** Heads a component's parts, and the content placed in its slot when a branch shows both. */
function SubLabel({ depth, label }: { depth: number; label: string }) {
  return (
    <div className="layers-sublabel" aria-hidden="true" style={depthVar(depth)}>
      {label}
    </div>
  );
}
