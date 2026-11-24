import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Box, ChevronDown, ChevronRight, Columns3, Component, Copy, CornerDownRight, CornerLeftUp, Ellipsis, Eye, EyeOff, FileInput, FileText, Image, LayoutGrid, Link2, Minus, Monitor, PanelBottom, PanelTop, Pencil, Plus, Repeat, Rows3, Shapes, Smartphone, Sparkles, Split, Square, SquareDashed, Tablet, Trash2, Type, Unlink, X, LayoutTemplate } from 'lucide-react';
import type { EditOperation } from '@shared/ops';
import type { ElementRef, GraphNode, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import { refKey, sameRef, slotChildren } from '@shared/types';
import { showsPart } from '@shared/page-shell';
import { scopeForWidth } from '@shared/styles';
import { childLists, codeTakesOverrides, displayName, findParent, subtreeIds } from '@engine/tree';
import { aiActivity, api, applyOps, commitDraft, getState, markDraft, setState, showLayer, toast, useStore } from '../store';
import { rovingKeys, useMenu, useRovingTabStop } from '../components/ui';
import { isImeComposing } from '../lib/ime';
import { askAiAbout, asPlanned, deleteLayers, deleteSelection, detachable, detachPlacement, duplicateLayers, duplicateSelection, focusSelectedRow, groupCount, liveGroup, moveLayers, moveLayersInto, moveSelection, moveToPage, otherPages, planLayers, ungroupLayers, wrapLayers, WRAP_NAMES, type LayersPlan } from '../lib/actions';
import { withSeparator, wrapItems } from './WrapItems';
import { copySelection, pasteFromMenu } from '../lib/clipboard';
import { copyPasteItems, PasteHere } from './CopyPaste';
import { styleCopyItems } from './StylePaste';
import { clip, contentText, everySizeEdits, eyeAction, hiddenAncestor, hideHereEdits, layerLabel, rowVisibility, showHereEdits, sizesText, type HiddenBy, type RowVisibility, type Size, type VisibilityEdit } from '../lib/layers';
import { besideOf, cannotGroup, extendTo, inGroup, layerRef, NOT_SIBLINGS, toggle, type Group } from '../lib/layer-set';
import { createComponentTarget, resolveRef, treeFor } from '../lib/model';
import { placeWords } from '../lib/edit-label';
import { describeConditions } from '../lib/conditions';
import { OutlinePanel } from './OutlinePanel';
import { templateOwner } from '../lib/template-view';

/*
 * The Layers panel: the current page's outline (shared header, page content, shared footer), or a
 * component's own tree while it is being edited everywhere. It follows the WAI-ARIA tree pattern: one tab
 * stop, arrows move (selection follows focus), Right/Left open and close, type-ahead jumps by name.
 *
 * Several layers side by side (one list of one parent) can be selected together, to move, copy, duplicate or delete
 * them as one change (lib/layer-set): Shift-click or Shift+↑/↓ selects a range, Cmd/Ctrl-click adds or removes one,
 * and Cmd/Ctrl+↑/↓ moves focus without selecting so Space can add or remove the focused layer. Escape keeps one.
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

/** The layer being dragged (only nodes owned directly by a page or definition tree), with the layers selected
 *  together with it when it is one of them: they move as one, in their order. */
let dragging: { owner: OwnerRef; nodeId: string; ids: string[] } | null = null;

/** Where a drop puts the dragged layers: a list (a parent and slot), and the layer they go before (null: its end). */
type Place = { parentId: string | null; slot?: string; before: string | null };

/**
 * The moves that put `ids` (siblings, in their list's order) together at `to`, as one change: each one taken out
 * and put back after the one before it, the first before `to.before`. The engine takes a layer out before it puts
 * it back, so each index is counted in the list as it stands without that layer. Null when nothing would move.
 */
function placeOps(tree: NodeTree, owner: OwnerRef, ids: string[], to: Place): EditOperation[] | null {
  const from = findParent(tree, ids[0]);
  if (!from) return null;
  const target = to.parentId === null ? tree.rootIds : (() => {
    const n = tree.nodes[to.parentId!];
    return n?.kind === 'instance' ? slotChildren(n, to.slot!) : n && 'children' in n ? (n.children as string[]) : [];
  })();
  const same = from.list === target;
  const source = [...from.list];
  const list = same ? source : [...target];
  const ops: EditOperation[] = [];
  ids.forEach((id, i) => {
    source.splice(source.indexOf(id), 1);
    const at = i === 0 ? (to.before ? list.indexOf(to.before) : list.length) : list.indexOf(ids[i - 1]) + 1;
    list.splice(at, 0, id);
    ops.push({ type: 'node.move', owner, nodeId: id, parentId: to.parentId, ...(to.slot !== undefined ? { slot: to.slot } : {}), index: at });
  });
  if (same && list.join() === from.list.join()) return null;
  return ops;
}

/** A small badge under the pointer while several layers are dragged: "3 sections". */
function dragBadge(e: React.DragEvent, text: string) {
  const el = document.createElement('div');
  // Editing a component everywhere, the badge takes that mode's plum like the rest of the selection.
  el.className = `layers-drag-badge${document.querySelector('.editor.defining') ? ' definition' : ''}`;
  el.textContent = text;
  document.body.appendChild(el);
  e.dataTransfer.setDragImage(el, 14, 14);
  setTimeout(() => el.remove(), 0);
}

/** The icon for a screen size, as the toolbar's size buttons show it. */
const sizeIcon = (size: Size) => (size === 'phone' ? <Smartphone /> : size === 'tablet' ? <Tablet /> : <Monitor />);

/**
 * The sizes a layer hides itself at, as a tag: "Phone" after a closed eye, or in a narrow sidebar the sizes' own
 * icons. A tag of its own while another size is previewed; the face of the layer's pressed eye while one of its
 * sizes is.
 */
function SizesTag({ text, sizes }: { text: string; sizes: string[] }) {
  return (
    <>
      <EyeOff className="layer-sizes-eye" />
      <span className="layer-sizes-text">{text}</span>
      {sizes.length < 3 && <span className="layer-sizes-icons">{sizes.map((z) => <Fragment key={z}>{sizeIcon(z as Size)}</Fragment>)}</span>}
    </>
  );
}

/** The panel's status voice, for what rows and picks do; set while Layers is mounted. */
let say: (text: string) => void = () => {};

/** Why a pick or a key did nothing: seen in a notice, and heard. */
const refuse = (why: string) => {
  toast(why, 'info');
  say(why);
};

/** Whether hiding a layer can work: not a repeat or slot, and not a code component that ignores the classes it is given. */
function hideable(state: ProjectState, n: GraphNode) {
  if (n.kind === 'repeat' || n.kind === 'slot') return false;
  if (n.kind !== 'instance') return true;
  const def = state.components[n.definitionId];
  return !!def && codeTakesOverrides(def);
}

/** Change where a layer shows (see lib/layers: every size, or the size being previewed). */
function applyVisibility(owner: OwnerRef, nodeId: string, edits: VisibilityEdit[], label: string) {
  if (!edits.length) return;
  void applyOps(edits.map((e) => ({ type: 'node.setStyle' as const, owner, nodeId, ...(e.partId ? { partId: e.partId } : {}), scope: e.scope, property: 'hidden', value: e.value })), label);
}

/** The sizes a layer hides itself at, for its tag: "Phone", "Tablet, Desktop". */
const sizesTagText = (sizes: string[]) => sizes.map((z) => z[0].toUpperCase() + z.slice(1)).join(', ');

/** A sentence for the tooltip: "Hidden on phone because Grid is hidden on phone." */
const sentence = (text: string) => (text ? `${text[0].toUpperCase()}${text.slice(1)}.` : '');

/** Select the layer that hides another one in this preview, and move keyboard focus to its row once shown. */
function selectHider(owner: OwnerRef, by: HiddenBy) {
  setState({ selection: by.part ? { owner, instancePath: [by.id], nodeId: by.part.nodeId, partId: by.part.id } : { owner, instancePath: [], nodeId: by.id } });
  // Only while focus is still in Layers (or nowhere): a Tab away meanwhile keeps its place.
  setTimeout(() => {
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest('.layers-tree')) return;
    document.querySelector<HTMLElement>('.layers-tree [role="treeitem"][aria-selected="true"]')?.focus();
  }, 80);
}

/** The visibility a row describes in the preview being shown (a part of the placement with `partId`). */
function visibilityOf(state: ProjectState, tree: NodeTree, n: GraphNode, partId?: string): RowVisibility {
  return rowVisibility(state, tree, n, scopeForWidth(getState().viewport), partId);
}

/** The visible rows, in order (a row inside a closed branch is not rendered at all). */
const treeRows = (from: Element | null) => [...(from?.closest('[role="tree"]')?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
const rowFor = (id: string) => document.querySelector<HTMLElement>(`.layers-tree [data-node="${id}"]`);

/** The layers selected together, while they are: every row in it shows as selected. */
const Picked = createContext<Group | null>(null);

/** The additive pick: Cmd-click on macOS (Ctrl-click there opens the context menu), Ctrl-click elsewhere. */
const additive = (e: { metaKey: boolean; ctrlKey: boolean }) => (api.platform === 'darwin' ? e.metaKey : e.ctrlKey);

/** A row's owner, from its data-owner ("page:pg_1"). */
function ownerOfRow(row: HTMLElement): OwnerRef | null {
  const v = row.dataset.owner ?? '';
  const at = v.indexOf(':');
  const kind = v.slice(0, at);
  return kind === 'page' || kind === 'shell' || kind === 'component' || kind === 'template' ? { kind, id: v.slice(at + 1) } : null;
}

/** Shift (a range) or Cmd/Ctrl (one more, or one less) pick of a layer; a pick that can't join says why. */
function pickRow(how: 'range' | 'toggle', ref: ElementRef) {
  const s = getState();
  const tree = s.snapshot ? treeFor(s.snapshot.state, ref.owner) : undefined;
  if (!tree) return false;
  const r = (how === 'range' ? extendTo : toggle)(tree, s.selection, s.layerSet, ref);
  if ('refused' in r) {
    // "Not side by side" names the list the selection is in, so the next pick can land in it.
    // What is selected now may itself be one that is picked alone (a shared layer, a part): that is the reason.
    const selTree = s.snapshot && s.selection ? treeFor(s.snapshot.state, s.selection.owner) : undefined;
    const own = r.refused === NOT_SIBLINGS && selTree && s.selection ? cannotGroup(selTree, s.selection) : null;
    const where = !own && r.refused === NOT_SIBLINGS && s.snapshot && s.selection ? listName(s.snapshot.state, s.selection) : null;
    const why = own ?? (where ? `Only layers side by side can be selected together. Pick another layer ${where.startsWith('the top level') ? 'at' : 'in'} ${clip(where, 40)}.` : r.refused);
    refuse(why);
    return false;
  }
  setState({ selection: r.selection, layerSet: r.layerSet });
  return true;
}

/** The list a layer sits in, as a person would name it: "Project gallery wrapper", "Content of Spring 2026 …", "the page". */
function listName(st: ProjectState, ref: ElementRef): string | null {
  const tree = treeFor(st, ref.owner);
  const here = tree && !ref.instancePath.length ? findParent(tree, ref.nodeId) : null;
  if (!tree || !here) return null;
  if (ref.owner.kind === 'shell') return ref.owner.id === 'footer' ? 'the shared footer' : 'the shared header';
  if (here.parentId === null) return ref.owner.kind === 'component' ? 'the top level of this component' : ref.owner.kind === 'template' ? 'the top level of the layout' : 'the top level of the page';
  const holder = tree.nodes[here.parentId];
  if (!holder) return null;
  const name = layerLabel(st, holder).label;
  const slot = holder.kind === 'instance' && here.slot ? st.components[holder.definitionId]?.slots?.[here.slot]?.label : undefined;
  return slot ? `${slot} of ${name}` : name;
}

/** "H2" for a heading's level, shown before its words; null for anything else. */
const headingTag = (kind: string) => /^Heading (\d)$/.exec(kind)?.[1] ?? null;


/** The row to keep as the tree's one tab stop: the selection's (of several selected together), any selected, the focused one, else the first. */
const tabStop = (rows: HTMLElement[]) =>
  rows.find((r) => r.dataset.primary === 'true') ?? rows.find((r) => r.getAttribute('aria-selected') === 'true') ?? rows.find((r) => r.contains(document.activeElement)) ?? rows[0];

export function LayersPanel() {
  const snap = useStore((s) => s.snapshot);
  const pageId = useStore((s) => s.pageId);
  const definitionMode = useStore((s) => s.definitionMode);
  const templateMode = useStore((s) => s.templateMode);
  const visible = useStore((s) => s.leftTab === 'layers');
  const view = useStore((s) => s.layersView);
  const menu = useMenu();
  const treeRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });
  // Where focus goes once a delete from the selection bar lands: the row then in the first removed layer's place.
  const recoverAt = useRef<number | null>(null);
  // What the panel's own commands did, for the status region (a toast is seen, not heard).
  const [note, setNote] = useState('');
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Results have their own region, apart from the selection count, so neither talks over the other; it empties first
  // so the same result twice (two Move ups) is heard twice.
  const announce = (text: string) => {
    setNote('');
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => {
      setNote(text);
      noteTimer.current = setTimeout(() => setNote(''), 4000);
    }, 50);
  };
  useEffect(() => {
    say = announce;
  });
  useEffect(
    () => () => {
      clearTimeout(noteTimer.current);
      say = () => {};
    },
    []
  );
  /** After a change from the selection bar removes what focus was on, put focus back in the tree: on the row now at
   *  `at` (where the first removed layer was), else the tree's tab stop, else Add sections on an empty page. */
  const focusTree = (at = -1) =>
    setTimeout(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const rows = treeRows(treeRef.current?.querySelector('[role="treeitem"]') ?? null);
      (rows[Math.min(at, rows.length - 1)] ?? treeRef.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ?? treeRef.current?.querySelector<HTMLElement>('.layers-empty button'))?.focus();
    }, 120);
  /** Run a command and, once it has changed the project, say what it did. */
  const reported = (run: Promise<unknown> | void, text: string) => {
    const before = getState().snapshot?.revision;
    void Promise.resolve(run).then(() => getState().snapshot?.revision !== before && announce(text));
  };
  // The panel owns the tree's single tab stop; it re-reconciles whenever the selection changes.
  const selection = useStore((s) => s.selection);
  const layerSet = useStore((s) => s.layerSet);
  useRovingTabStop(treeRef, 'treeitem');
  // A selection made elsewhere (the canvas, the inspector) scrolls its row into view once its branches have
  // opened, and again when the panel is shown; keyboard focus stays where it is.
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      const tree = treeRef.current;
      if (!tree || tree.contains(document.activeElement)) return;
      (tree.querySelector<HTMLElement>('[role="treeitem"][data-primary="true"]') ?? tree.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]'))?.scrollIntoView({ block: 'nearest' });
    }, 60);
    return () => clearTimeout(t);
    // Returning from the headings outline shows the selected row again: it may have changed while the tree was hidden.
  }, [selection, visible, view]);
  // Rows mount and unmount inside branches that open on their own (revealing a canvas selection), which does
  // not re-render the panel: keep exactly one tabbable row whenever the rows change.
  // If a change removes the focused row, focus goes to the row now in its place.
  useEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    let last: { row: HTMLElement; index: number } | null = null;
    const onFocus = (e: FocusEvent) => {
      const target = e.target;
      const row = target instanceof HTMLElement && el.contains(target) ? target.closest<HTMLElement>('[role="treeitem"]') : null;
      last = row ? { row, index: [...el.querySelectorAll('[role="treeitem"]')].indexOf(row) } : null;
    };
    const reconcile = () => {
      const rows = [...el.querySelectorAll<HTMLElement>('[role="treeitem"]')];
      const adrift = !document.activeElement || document.activeElement === document.body;
      const lost = !!last && !last.row.isConnected && adrift;
      // A delete from the bar names its own place, ahead of wherever focus last was in the tree.
      const pending = recoverAt.current;
      if (pending !== null && rows.length && (adrift || lost)) {
        recoverAt.current = null;
        last = null;
        const to = rows[Math.min(pending, rows.length - 1)];
        for (const r of rows) r.tabIndex = r === to ? 0 : -1;
        return to.focus();
      }
      if (!rows.length) {
        // Nothing left to focus in the tree (the last layer went): the empty page's Add sections takes it.
        if (lost) (el.querySelector<HTMLElement>('.layers-empty button')?.focus(), (last = null));
        return;
      }
      const keep = lost ? rows[Math.min(last!.index, rows.length - 1)] : tabStop(rows);
      for (const r of rows) if (r.tabIndex !== (r === keep ? 0 : -1)) r.tabIndex = r === keep ? 0 : -1;
      if (lost) {
        last = null;
        keep.focus();
      }
    };
    const mo = new MutationObserver(reconcile);
    mo.observe(el, { childList: true, subtree: true });
    document.addEventListener('focusin', onFocus, true);
    return () => {
      mo.disconnect();
      document.removeEventListener('focusin', onFocus, true);
    };
  }, []);
  // Leaving several layers for one (Esc, the bar's X, a Cmd/Ctrl-click) is said, whichever way it happened.
  // Only when the project is unchanged and the one left is one of them: a delete, an undo or a pick elsewhere is not it.
  const groupNow = snap && pageId ? liveGroup({ snapshot: snap, selection, layerSet, pageId, definitionMode, templateMode }) : null;
  const hadGroup = useRef<{ rev: number; owner: string; ids: string[] } | null>(null);
  useEffect(() => {
    const was = hadGroup.current;
    if (was && !groupNow && selection && snap && snap.revision === was.rev && !selection.instancePath.length && `${selection.owner.kind}:${selection.owner.id}` === was.owner && was.ids.includes(selection.nodeId)) {
      const n = treeFor(snap.state, selection.owner)?.nodes[selection.nodeId];
      if (n) announce(`Kept only ${layerLabel(snap.state, n).label}`);
    }
    hadGroup.current = groupNow && snap ? { rev: snap.revision, owner: `${groupNow.owner.kind}:${groupNow.owner.id}`, ids: groupNow.ids } : null;
  });
  // A row keyboard focus lands on (arrows, Cmd/Ctrl+arrows, or Tab into the tree) whose name is cut short shows its
  // full name and place in an expansion label across the panel, below it, or above it in the lower part of the
  // panel so it never runs off the bottom. It follows the row as the tree scrolls; Esc, a click or focus leaving
  // takes it away.
  const [peek, setPeek] = useState<{ lines: string[]; x: number; w: number; top: number; bottom: number; above: boolean } | null>(null);
  const peekRef = useRef<HTMLDivElement>(null);
  const followRef = useRef<() => void>(() => {});
  // Measured once drawn: one that would run past the tree's edge opens on the other side of its row when it fits there.
  useLayoutEffect(() => {
    const box = treeRef.current?.getBoundingClientRect();
    const h = peekRef.current?.offsetHeight;
    if (!peek || !box || !h) return;
    if (!peek.above && peek.bottom + 2 + h > box.bottom && peek.top - 2 - h >= box.top) setPeek({ ...peek, above: true });
    else if (peek.above && peek.top - 2 - h < box.top && peek.bottom + 2 + h <= box.bottom) setPeek({ ...peek, above: false });
  }, [peek]);
  // Layout can move a focused row without focus moving (the selection bar appearing, a reorder): the label follows.
  useEffect(() => {
    const id = requestAnimationFrame(() => followRef.current());
    return () => cancelAnimationFrame(id);
  }, [groupNow?.ids.join(), snap?.revision, view]);
  useEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    const place = (row: HTMLElement | null) => {
      const label = row?.querySelector<HTMLElement>('.layer-name');
      if (!row || !label || !(el.hasAttribute('data-keys') || row.matches(':focus-visible')) || label.scrollWidth <= label.clientWidth + 1) return setPeek(null);
      const box = el.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      if (r.bottom < box.top || r.top > box.bottom) return setPeek(null);
      const above = r.bottom > box.top + box.height * 0.62;
      const lines = (label.title || label.textContent || '').split('\n').slice(0, 2);
      setPeek({ lines, x: box.left + 6, w: el.clientWidth - 12, top: r.top, bottom: r.bottom, above });
    };
    const show = (e: FocusEvent) => place((e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]'));
    const follow = () => {
      const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.layers-tree [role="treeitem"]') ?? null;
      if (row) place(row);
    };
    const hide = () => setPeek(null);
    followRef.current = follow;
    const ro = new ResizeObserver(follow);
    ro.observe(el);
    el.addEventListener('focusin', show);
    el.addEventListener('focusout', hide);
    el.addEventListener('scroll', follow);
    el.addEventListener('pointerdown', hide);
    return () => {
      el.removeEventListener('focusin', show);
      el.removeEventListener('focusout', hide);
      el.removeEventListener('scroll', follow);
      el.removeEventListener('pointerdown', hide);
      ro.disconnect();
      followRef.current = () => {};
    };
  }, []);
  if (!snap || !pageId) return null;
  const st = snap.state;
  const page = st.pages[pageId];
  const defOwner: OwnerRef | null = definitionMode ? { kind: 'component', id: definitionMode.definitionId } : null;
  const defTree = defOwner ? st.components[defOwner.id]?.tree : null;
  // A collection's layout being edited: its layers, between the shared header and footer every entry shows.
  const layout = !defOwner && templateMode && st.collections[templateMode.collectionId]?.settings.template ? { owner: templateOwner(templateMode), tree: st.collections[templateMode.collectionId].settings.template, name: `${st.collections[templateMode.collectionId].settings.name} layout` } : null;
  // The layers selected together, while the selection is one of them and they still sit side by side here.
  const picked = liveGroup({ snapshot: snap, selection, layerSet, pageId, definitionMode, templateMode });

  /** The page a section (or the sections selected together) can be moved to, at its end; the moved ones are selected there. */
  const pageMenu = (anchor: { x: number; y: number }, plan: LayersPlan | null, pages: Array<{ id: string; title: string }>, what: string, returnTo: HTMLElement | null) =>
    plan &&
    menu.open(
      anchor.x,
      anchor.y,
      [{ heading: `Move ${what} to the end of` }, ...pages.map((p) => ({ label: p.title, icon: <FileText />, onSelect: () => reported(moveToPage(p.id, plan, true), `Moved ${what} to the end of ${p.title}`) }))],
      `Move ${what} to another page`,
      returnTo
    );

  /** A Move into destination as a result names it: "the page", "the component", or its full path. */
  const landing = (d: { parentId: string | null; full: string }) => (d.parentId !== null ? d.full : defOwner ? 'the component' : layout ? 'the layout' : 'the page');
  /** Where focus goes when a follow-on menu is dismissed: back to what opened the first menu (a row, its ⋯, Actions). */
  const openerOf = (el: HTMLElement | { x: number; y: number; returnTo?: HTMLElement }, fallback: string) => (el instanceof HTMLElement ? el : (el.returnTo ?? rowFor(fallback)));
  /** A follow-on menu (Move within…, Move into…, Move to page…) opens under the row or the selection bar it came from, never over the canvas. */
  const anchorFor = (el: HTMLElement | { x: number; y: number; returnTo?: HTMLElement }) => () => {
    if (!(el instanceof HTMLElement)) return el;
    const r = (el.closest<HTMLElement>('.layer-row, .layers-picked') ?? el).getBoundingClientRect();
    return { x: r.left + 8, y: r.bottom + 4 };
  };

  /** "Move … to the end of": every container and slot it can go into, each with its kind's icon. */
  const destinationMenu = (anchor: { x: number; y: number }, tree: NodeTree, owner: OwnerRef, what: string, dests: ReturnType<typeof moveDestinations>, pick: (d: ReturnType<typeof moveDestinations>[number]) => void, returnTo: HTMLElement | null) =>
    menu.open(
      anchor.x,
      anchor.y,
      [
        { heading: `Move ${what} to the end of` },
        ...dests.map((d) => ({
          label: d.label,
          icon: d.parentId === null ? owner.kind === 'component' ? <Component /> : <FileText /> : d.slot ? <SquareDashed /> : tree.nodes[d.parentId] ? kindIcon(tree.nodes[d.parentId]) : <Box />,
          onSelect: () => pick(d)
        }))
      ],
      `Move ${what}`,
      returnTo
    );

  /** The menu for several layers selected together: each command is one change for all of them, planned now. */
  const openGroupMenu = (el: HTMLElement | { x: number; y: number; returnTo?: HTMLElement }, g: Group) => {
    const plan = planLayers();
    if (!plan?.several) return;
    const tree = treeFor(st, g.owner);
    if (!tree) return;
    const count = groupCount(g);
    const anchorOf = anchorFor(el);
    const primary = plan.selection?.nodeId ?? g.ids[0];
    const destinations = moveDestinations(st, tree, g.owner, g.ids);
    const pages = g.owner.kind === 'page' && g.parentId === null ? otherPages(st, g.owner.id) : [];
    const moveTo = (anchor: { x: number; y: number }) =>
      destinationMenu(
        anchor,
        tree,
        g.owner,
        count,
        destinations,
        (d) =>
          void moveLayersInto({ parentId: d.parentId, slot: d.slot, index: d.index }, plan).then((ok) => {
            if (!ok) return;
            focusSelectedRow();
            announce(`Moved ${count} to the end of ${landing(d)}`);
          }),
        openerOf(el, primary)
      );
    // Every place in their own list they can be put together, as a drag there would: before each other layer, or at
    // the end. The keyboard's way to gather layers picked apart (A and C before D), which Move up and down cannot.
    const places = [...g.list.filter((id) => !g.ids.includes(id)), null]
      .map((before) => ({ before, ops: placeOps(tree, g.owner, g.ids, { parentId: g.parentId, slot: g.slot, before }) }))
      .filter((p): p is { before: string | null; ops: EditOperation[] } => !!p.ops);
    const where = listName(st, layerRef(g.owner, g.ids[0])) ?? 'this list';
    // Layers with the same name are told apart by their order ("Before Image (2 of 2)").
    const fullNames = places.map((p) => (p.before && tree.nodes[p.before] ? layerLabel(st, tree.nodes[p.before]).label : ''));
    const placeNames = fullNames.map((n) => clip(n || 'layer', 32));
    const within = (anchor: { x: number; y: number }) =>
      menu.open(
        anchor.x,
        anchor.y,
        [
          { heading: `Move ${count} within ${clip(where, 32)}` },
          ...places.map((p, i) => {
            const at = p.before ? tree.nodes[p.before] : undefined;
            const total = placeNames.filter((x) => x === placeNames[i]).length;
            const nth = placeNames.slice(0, i).filter((x) => x === placeNames[i]).length + 1;
            const named = p.before ? `${placeNames[i]}${total > 1 ? ` (${nth} of ${total})` : ''}` : '';
            return {
              label: p.before ? `Before ${named}` : 'To the end',
              icon: at ? kindIcon(at) : <CornerDownRight />,
              onSelect: () =>
                void applyOps(p.ops, `Move ${count} ${placeWords(st, g.owner)}`, undefined, plan.snap.revision).then((r) => {
                  if (!r) return;
                  focusSelectedRow();
                  announce(p.before ? `Moved ${count} before ${fullNames[i]}${total > 1 ? ` (${nth} of ${total})` : ''}` : `Moved ${count} to the end of ${g.parentId === null ? (defOwner ? 'the component' : 'the page') : where}`);
                })
            };
          })
        ],
        `Move ${count} within ${where}`,
        openerOf(el, primary)
      );
    const items = [
      { heading: `${count} selected` },
      { label: 'Move up', icon: <ArrowUp />, shortcut: '⇧⌘↑', disabled: g.indexes[0] === 0, onSelect: () => reported(moveLayers(-1, plan), `Moved ${count} up`) },
      { label: 'Move down', icon: <ArrowDown />, shortcut: '⇧⌘↓', disabled: g.indexes[g.indexes.length - 1] >= g.list.length - 1, onSelect: () => reported(moveLayers(1, plan), `Moved ${count} down`) },
      ...(places.length ? [{ label: 'Move within…', icon: <ArrowUpDown />, onSelect: () => setTimeout(() => within(anchorOf()), 0) }] : []),
      ...(destinations.length ? [{ label: 'Move into…', icon: <CornerDownRight />, onSelect: () => setTimeout(() => moveTo(anchorOf()), 0) }] : []),
      ...(pages.length ? [{ label: 'Move to page…', icon: <FileInput />, onSelect: () => setTimeout(() => pageMenu(anchorOf(), plan, pages, count, openerOf(el, primary)), 0) }] : []),
      ...withSeparator(wrapItems(plan, { wrap: (k) => reported(wrapLayers(k, plan, true), `Wrapped ${count} in a ${WRAP_NAMES[k]}`), ungroup: () => reported(ungroupLayers(plan, true), `Ungrouped ${count}`) })),
      { separator: true },
      ...copyPasteItems({ copy: g.owner.kind === 'page' ? () => copySelection(plan) && announce(`Copied ${count}`) : null, paste: g.owner.kind === 'shell' ? null : asPlanned(plan, async () => pasteFromMenu(true)) }),
      { label: 'Duplicate', icon: <Copy />, shortcut: '⌘D', onSelect: () => reported(duplicateLayers(plan, true), `Duplicated ${count}`) },
      { separator: true },
      { label: 'Delete', icon: <Trash2 />, shortcut: '⌫', danger: true, onSelect: () => {
        const first = rowFor(g.ids[0]);
        const at = first ? treeRows(first).indexOf(first) : -1;
        recoverAt.current = at >= 0 ? at : null;
        reported(
          deleteLayers(plan).then(() => {
            focusTree(at);
            setTimeout(() => (recoverAt.current = null), 400);
          }),
          `Deleted ${count}`
        );
      } }
    ];
    const label = `Actions for ${count}`;
    if (el instanceof HTMLElement && el.getAttribute('role') === 'treeitem') {
      const r = el.getBoundingClientRect();
      menu.open(r.left + 24, r.bottom, items, label, el);
    } else if (el instanceof HTMLElement) menu.openAt(el, items, label);
    else menu.open(el.x, el.y, items, label, el.returnTo ?? (document.activeElement as HTMLElement | null));
  };

  const openMenu = (el: HTMLElement | { x: number; y: number; returnTo?: HTMLElement }, ref: ElementRef, topLevel: boolean, onRename?: () => void) => {
    // A menu opened on one of several layers selected together is for all of them; on any other layer, for that one.
    // Membership is the live group's (as the rows show it): a layer an Undo moved away from the others is not in it.
    if (picked && inGroup(picked, ref)) return openGroupMenu(el, picked);
    setState({ selection: ref });
    const tree = treeFor(st, ref.owner);
    if (!tree) return;
    const node = tree.nodes[ref.instancePath[0] ?? ref.nodeId];
    const partDef = ref.partId && node?.kind === 'instance' ? st.components[node.definitionId] : undefined;
    const isDefRoot = ref.owner.kind === 'component' && !ref.instancePath.length && tree.rootIds[0] === ref.nodeId;
    const ownerDef = ref.owner.kind === 'component' ? st.components[ref.owner.id] : undefined;
    const name = partDef && ref.partId ? partDef.parts[ref.partId]?.label ?? ref.partId : isDefRoot ? st.components[ref.owner.id]?.name ?? 'Component' : node ? layerLabel(st, node, ownerDef).label : 'Layer';
    // Shared header and footer rows are shared across pages: they are not moved, duplicated or deleted here.
    // The root of a component being edited is the component itself: it is not moved, copied or deleted here.
    const editable = topLevel && ref.owner.kind !== 'shell' && !isDefRoot;
    const here = editable && !ref.instancePath.length ? findParent(tree, ref.nodeId) : null;
    // "Move to…": the keyboard and menu equivalent of dragging a layer into another container or slot.
    const destinations = editable && !ref.instancePath.length && node ? moveDestinations(st, tree, ref.owner, [ref.nodeId]) : [];
    // Moving a page's section to another page: one change, at the end of that page, planned now for the layer this
    // menu names (a change landing while it is open can move the selection elsewhere).
    const pages = editable && here?.parentId === null && ref.owner.kind === 'page' && !ref.instancePath.length ? otherPages(st, ref.owner.id) : [];
    const plan = planLayers();
    const moveTo = (anchor: { x: number; y: number }) =>
      destinationMenu(anchor, tree, ref.owner, name, destinations, (d) =>
        // The row remounts under its new parent; keyboard focus follows it there.
        void applyOps([{ type: 'node.move', owner: ref.owner, nodeId: ref.nodeId, parentId: d.parentId, slot: d.slot, index: d.index }], `Move ${name} ${placeWords(st, ref.owner)}`).then((r) => {
          if (!r) return;
          setTimeout(() => rowFor(ref.nodeId)?.focus(), 80);
          announce(`Moved ${name} to the end of ${landing(d)}`);
        }), openerOf(el, ref.nodeId));
    // Where the layer shows, in the size being previewed and at every size, and the layer above that hides it. A
    // change for one size carries that size's icon; a change for every size, the eye.
    const visibilityItems = () => {
      const part = ref.partId && ref.instancePath.length === 1 ? ref.partId : undefined;
      if (!node || (ref.instancePath.length && !part)) return [];
      const size = scopeForWidth(getState().viewport);
      const vis = visibilityOf(st, tree, node, part);
      const out: Array<{ label?: string; heading?: string; icon?: React.ReactNode; onSelect?: () => void }> = [];
      if (vis.hiddenBy) {
        const by = vis.hiddenBy;
        out.push({ heading: `Hidden on ${size} by ${by.name}` }, { label: `Select ${by.target}`, icon: <CornerLeftUp />, onSelect: () => selectHider(ref.owner, by) });
      }
      if (editable && !ref.instancePath.length && hideable(st, node)) {
        const edit = (edits: VisibilityEdit[], label: string, menuLabel: string, icon: React.ReactNode) => {
          if (edits.length) out.push({ label: menuLabel, icon, onSelect: () => applyVisibility(ref.owner, node.id, edits, label) });
        };
        // History names the layer and where it is: "Hide Gallery on Home on phone".
        const who = `${name} ${placeWords(st, ref.owner)}`;
        edit(showHereEdits(st, node, size), `Show ${who} on ${size}`, `Show on ${size}`, sizeIcon(size));
        edit(everySizeEdits(st, node, false), `Show ${who}`, 'Show at every size', <Eye />);
        // Already hidden here by a layer above: these add the layer's own setting, and say so.
        const also = vis.hiddenBy ? 'Also hide' : 'Hide';
        edit(hideHereEdits(st, node, size), `Hide ${who} on ${size}`, `${also} on ${size} only`, sizeIcon(size));
        edit(everySizeEdits(st, node, true), `Hide ${who}`, `${also} at every size`, <EyeOff />);
      }
      return out;
    };
    const anchorOf = anchorFor(el);
    const visibility = visibilityItems();
    const styleItems = styleCopyItems(ref);
    // Paste goes by the selection, which opening this menu made the row it names: if something else has been selected
    // since (a Duplicate that finished, another menu), it would land beside that, so it says so instead.
    const pasteAfter = () => {
      const now = getState();
      // The row may be gone (an Undo took it away) with its reference still selected.
      if (!sameRef(now.selection, ref) || now.layerSet || !now.snapshot || !resolveRef(now.snapshot.state, ref).node) return toast('The selection changed while the menu was open. Choose Paste again.', 'error');
      pasteFromMenu(true);
    };
    // Elements and basic elements, and a section together with its content: the same as the canvas and the inspector.
    const create = createComponentTarget(getState().snapshot, ref);
    const items = [
      { heading: name },
      ...(onRename ? [{ label: 'Rename', icon: <Pencil />, shortcut: 'F2', onSelect: onRename }] : []),
      { label: 'Ask AI about this', icon: <Sparkles />, shortcut: '⌘J', onSelect: () => askAiAbout(ref) },
      ...(editable && here
        ? [
            { separator: true },
            { label: 'Move up', icon: <ArrowUp />, shortcut: '⇧⌘↑', disabled: here.index === 0, onSelect: () => void moveSelection(-1) },
            { label: 'Move down', icon: <ArrowDown />, shortcut: '⇧⌘↓', disabled: here.index >= here.list.length - 1, onSelect: () => void moveSelection(1) },
            ...(destinations.length ? [{ label: 'Move into…', icon: <CornerDownRight />, onSelect: () => setTimeout(() => moveTo(anchorOf()), 0) }] : []),
            ...(pages.length ? [{ label: 'Move to page…', icon: <FileInput />, onSelect: () => setTimeout(() => pageMenu(anchorOf(), plan, pages, name, openerOf(el, ref.nodeId)), 0) }] : []),
            ...withSeparator(wrapItems(plan, { wrap: (k) => reported(wrapLayers(k, plan, true), `Wrapped ${name} in a ${WRAP_NAMES[k]}`), ungroup: () => reported(ungroupLayers(plan, true), `Ungrouped ${name}`) }))
          ]
        : []),
      ...(visibility.length ? [{ separator: true }, ...visibility] : []),
      ...(styleItems.length ? [{ separator: true }, ...styleItems] : []),
      ...(editable
        ? [
            { separator: true },
            ...copyPasteItems({ copy: ref.owner.kind === 'page' && !definitionMode ? () => void copySelection(plan) : null, paste: pasteAfter }),
            { label: 'Duplicate', icon: <Copy />, shortcut: '⌘D', onSelect: () => void duplicateSelection() },
            ...(create ? [{ label: 'Create component…', icon: <Component />, onSelect: () => setState({ modal: { kind: 'create-component' as const, ref: create } }) }] : []),
            ...(!definitionMode && detachable(st, ref) ? [{ label: 'Detach component', icon: <Unlink />, onSelect: () => void detachPlacement(ref) }] : []),
            { separator: true },
            { label: 'Delete', icon: <Trash2 />, shortcut: '⌫', danger: true, onSelect: () => void deleteSelection() }
          ]
        : // The component being edited everywhere takes a paste inside itself, though it is not copied or removed here.
          isDefRoot
          ? [{ separator: true }, ...copyPasteItems({ copy: null, paste: pasteAfter })]
          : [])
    ];
    // A row (treeitem) is not a menu button: open at the row and return focus to it, without marking it expanded.
    if (el instanceof HTMLElement && el.getAttribute('role') === 'treeitem') {
      const r = el.getBoundingClientRect();
      menu.open(r.left + 24, r.bottom, items, `${name} options`, el);
    } else if (el instanceof HTMLElement) menu.openAt(el, items, `${name} options`);
    else menu.open(el.x, el.y, items, `${name} options`, el.returnTo ?? (document.activeElement as HTMLElement | null));
  };

  /**
   * Arrow keys (shared roving), plus type-ahead: typing a name's first letters jumps to the next match. Shift+↑/↓
   * selects the layer beside the focused one too (or lets it go, back towards where the range started); Cmd/Ctrl+↑/↓
   * moves focus alone, for Space to add or remove the focused layer.
   */
  const onTreeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Esc first closes a row's expansion label, leaving the selection as it is.
    if (e.key === 'Escape' && peek) {
      e.preventDefault();
      e.stopPropagation();
      return setPeek(null);
    }
    // Keys are driving the tree: the focused row shows its ring, even where the browser would not count a
    // modified key (Cmd/Ctrl+↓ after a click) as keyboard use. A pointer press in the tree ends it.
    e.currentTarget.setAttribute('data-keys', '');
    const row = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    const onRow = !!row && (e.target === row || (e.target as HTMLElement).tagName === 'BUTTON');
    // Shift+Home/End selects from the anchor to the first or last layer of its list; Cmd/Ctrl+A, all of that list.
    if (row && onRow && !e.altKey && ((e.shiftKey && !e.metaKey && !e.ctrlKey && (e.key === 'Home' || e.key === 'End')) || ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'a'))) {
      e.preventDefault();
      const owner = ownerOfRow(row);
      const id = row.dataset.node;
      const tree = owner ? treeFor(st, owner) : undefined;
      if (!owner || !id || !tree) return void refuse('Parts of a component are selected one at a time.');
      const list = findParent(tree, id)?.list ?? [];
      // A layer that can't be one of several says why, whichever key asked.
      const cannot = cannotGroup(tree, layerRef(owner, id));
      if (cannot) return void refuse(cannot);
      if (e.key === 'Home' || e.key === 'End') {
        const end = list[e.key === 'Home' ? 0 : list.length - 1];
        // Also when focus is already at that end: the range still runs from the anchor.
        if (end && pickRow('range', layerRef(owner, end))) rowFor(end)?.focus();
        return;
      }
      const ref = layerRef(owner, id);
      setState(list.length > 1 ? { selection: ref, layerSet: { owner, ids: [...list], anchor: list[0] } } : { selection: ref, layerSet: null });
      return;
    }
    if (row && onRow && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey) {
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      if (e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const owner = ownerOfRow(row);
        const id = row.dataset.node;
        // A part of a placed component has no layers beside it to select with it.
        if (!id) return void refuse('Parts of a component are selected one at a time.');
        const tree = owner ? treeFor(st, owner) : undefined;
        const cannot = tree && owner ? cannotGroup(tree, layerRef(owner, id)) : null;
        if (cannot) return void refuse(cannot);
        const next = tree && id ? besideOf(tree, id, dir) : null;
        // The row beside is already shown (a sibling of the focused one): focus moves to it at once.
        if (owner && next && pickRow('range', layerRef(owner, next))) rowFor(next)?.focus();
        return;
      }
      if (!e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const rows = treeRows(row);
        const to = rows[rows.indexOf(row) + dir];
        if (!to) return;
        // The tab stop goes with focus, so Tab leaves the tree from here rather than visiting the selection first.
        for (const r of rows) r.tabIndex = r === to ? 0 : -1;
        to.focus();
        return;
      }
    }
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
    // A row answers to its name, and an unnamed text to its words too ("meet" finds "Text · Meet the makers").
    const hit = order.find((r) => [r.dataset.name, r.dataset.words].some((w) => (w ?? '').toLowerCase().startsWith(buf)));
    if (!hit) return;
    e.preventDefault();
    if (hit !== rows[at]) (hit.focus(), hit.click());
  };

  // A page's headings can be shown instead of its layers; a component being edited everywhere has no page outline.
  const outline = view === 'outline' && !defOwner && !layout;
  return (
    <>
      <div className="panel-head">
        <h3>{outline ? 'Page outline' : 'Layers'}</h3>
        <span className="context ellipsis" title={defOwner ? `Layers of the ${st.components[defOwner.id]?.name} component` : layout ? `Layers of the ${layout.name}` : `${outline ? 'Headings' : 'Layers'} on ${page.title}`}>
          {defOwner ? st.components[defOwner.id]?.name : layout ? layout.name : page.title}
        </span>
      </div>
      {!defOwner && !layout && (
        <div className="layers-views">
          <div className="segmented full" role="group" aria-label="Show">
            <button aria-pressed={!outline} onClick={() => setState({ layersView: 'layers' })}>
              Layers
            </button>
            <button aria-pressed={outline} title="The headings this page shows, in the order screen readers list them" onClick={() => setState({ layersView: 'outline' })}>
              Headings
            </button>
          </div>
        </div>
      )}
      {outline && visible && <OutlinePanel pageId={pageId} />}
      {/* Layers selected together: how many, their commands (Shift+F10 on one of them has the same menu), and the
          pointer's way back to one layer (Esc from the keyboard). */}
      {picked && !outline && (
        <div className="layers-picked" role="group" aria-label="Layers selected together">
          {/* "selected" gives way first in a narrow sidebar; the count never truncates. */}
          <span className="layers-picked-count grow">
            {groupCount(picked)}
            <span className="layers-picked-word"> selected</span>
          </span>
          <button className="layers-picked-actions" aria-haspopup="menu" title={picked.owner.kind === 'page' ? 'Move, copy, duplicate or delete them together' : 'Move, duplicate or delete them together'} onClick={(e) => openGroupMenu(e.currentTarget, picked)}>
            Actions
            <ChevronDown aria-hidden="true" />
          </button>
          {(() => {
            const tree = treeFor(st, picked.owner);
            const keep = selection && tree?.nodes[selection.nodeId] ? layerLabel(st, tree.nodes[selection.nodeId]).label : 'one';
            return (
              <button
                className="icon-btn sm layers-picked-clear"
                aria-label={`Keep only ${keep}`}
                title={`Keep only ${keep} (Esc)`}
                onClick={() => {
                  setState({ layerSet: null });
                  focusSelectedRow();
                }}
              >
                <X />
              </button>
            );
          })()}
        </div>
      )}
      <span className="sr-only" role="status">
        {picked && !outline ? `${groupCount(picked)} selected` : ''}
      </span>
      <span className="sr-only" role="status">
        {note}
      </span>
      {/* The tree stays mounted while the outline shows, so its single tab stop is kept for when it returns. */}
      <Picked.Provider value={picked}>
      <div className="panel-body layers-tree" role="tree" aria-label="Layers" aria-multiselectable="true" ref={treeRef} onKeyDown={onTreeKey} onPointerDown={(e) => e.currentTarget.removeAttribute('data-keys')} hidden={outline}>
        {defOwner && defTree ? (
          <>
            <SectionLabel id="layers-sec-component" icon={<Component />} label="Component layers" />
            <TreeList state={st} owner={defOwner} tree={defTree} ids={defTree.rootIds} depth={0} onMenu={openMenu} path={[]} labelledBy="layers-sec-component" />
          </>
        ) : defOwner ? (
          // A code component (in Component Studio) has no layers of its own: its markup is its code.
          <>
            <SectionLabel id="layers-sec-component" icon={<Component />} label="Component layers" />
            <div className="layers-empty" role="none">
              <p>{st.components[defOwner.id]?.name ?? 'This component'} is a code component: its layout is in its code.</p>
            </div>
          </>
        ) : layout ? (
          <>
            <SectionLabel id="layers-sec-header" icon={<PanelTop />} label="Shared header" />
            <TreeList state={st} owner={{ kind: 'shell', id: 'header' }} tree={st.site.shell.header} ids={st.site.shell.header.rootIds} depth={0} onMenu={openMenu} path={['Shared header']} labelledBy="layers-sec-header" />
            <SectionLabel id="layers-sec-layout" icon={<LayoutTemplate />} label="Layout of every entry" />
            {layout.tree.rootIds.length > 0 ? (
              <TreeList state={st} owner={layout.owner} tree={layout.tree} ids={layout.tree.rootIds} depth={0} onMenu={openMenu} path={[]} labelledBy="layers-sec-layout" />
            ) : (
              <div className="layers-empty" role="none" onKeyDown={(e) => !((e.metaKey || e.ctrlKey) && ['z', 'y', 'v'].includes(e.key.toLowerCase())) && e.stopPropagation()}>
                <p>No layout content yet</p>
                <button className="btn btn-sm" onClick={() => setState({ leftTab: 'insert' })}>
                  <Plus /> Add sections
                </button>
              </div>
            )}
            <SectionLabel id="layers-sec-footer" icon={<PanelBottom />} label="Shared footer" />
            <TreeList state={st} owner={{ kind: 'shell', id: 'footer' }} tree={st.site.shell.footer} ids={st.site.shell.footer.rootIds} depth={0} onMenu={openMenu} path={['Shared footer']} labelledBy="layers-sec-footer" />
          </>
        ) : (
          <>
            {showsPart(page, 'header') && (
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
                // Paste (⌘V) too: the page may be waiting for its first section from a copy.
                onKeyDown={(e) => !((e.metaKey || e.ctrlKey) && ['z', 'y', 'v'].includes(e.key.toLowerCase())) && e.stopPropagation()}
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
                <PasteHere className="btn btn-sm" follow />
              </div>
            )}
            {showsPart(page, 'footer') && (
              <>
                <SectionLabel id="layers-sec-footer" icon={<PanelBottom />} label="Shared footer" />
                <TreeList state={st} owner={{ kind: 'shell', id: 'footer' }} tree={st.site.shell.footer} ids={st.site.shell.footer.rootIds} depth={0} onMenu={openMenu} path={['Shared footer']} labelledBy="layers-sec-footer" />
              </>
            )}
          </>
        )}
      </div>
      </Picked.Provider>
      {peek && !outline && (
        <div ref={peekRef} className={`layers-peek${peek.above ? ' above' : ''}`} aria-hidden="true" style={{ left: peek.x, top: peek.above ? peek.top - 2 : peek.bottom + 2, width: peek.w }}>
          {peek.lines.map((l, i) => (
            <span key={i} className={i ? 'layers-peek-path' : undefined}>
              {l}
            </span>
          ))}
        </div>
      )}
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

/**
 * Where "Move into…" can put layers (one, or several side by side): every container and slot of the tree except the
 * one they are in and anything inside them, plus the top level when they are not there already; each named by the
 * shortest tail of its path that tells it apart.
 */
function moveDestinations(st: ProjectState, tree: NodeTree, owner: OwnerRef, ids: string[]) {
  const here = ids.length ? findParent(tree, ids[0]) : null;
  if (!here) return [];
  const inside = new Set(ids.flatMap((id) => subtreeIds(tree, id)));
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
  // A component has one top-level element, the component itself: nothing moves beside it.
  if (here.parentId !== null && owner.kind !== 'component') out.push({ path: ['Top level of the page'], parentId: null, index: tree.rootIds.length });
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
      if (here.parentId === n.id) continue;
      out.push({ path: pathOf(n.id), parentId: n.id, index: n.children.length });
    } else if (n.kind === 'instance') {
      const slots = st.components[n.definitionId]?.slots ?? {};
      for (const [slot, info] of Object.entries(slots)) {
        if (here.parentId === n.id && here.slot === slot) continue;
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
  // A slot leads with its own name, so a long component name cannot push it out of sight: "Content in Spring 2026 …".
  // A path longer than the menu shows keeps its two ends ("Spring 2026 … › … › Stack"), so what tells it apart and
  // any "(2 of 3)" after it stay in view; the result names it in full.
  const slotFirst = (l: string, slot: boolean) => {
    if (!slot) return l;
    const parts = l.split(' › ');
    const name = parts.pop();
    return `${name} in ${parts.join(' › ')}`;
  };
  const named = labels.map((l, i) => {
    // Long names are cut short, so the slot, the layer and any "(2 of 3)" after them stay in view.
    const whole = l.split(' › ');
    const parts = whole.length > 1 ? whole.map((x) => clip(x, 28)) : [clip(whole[0], 46)];
    l = parts.join(' › ');
    const short = l.length > 46 && parts.length > 2 ? [parts[0], '…', ...parts.slice(out[i].slot ? -2 : -1)].join(' › ') : l;
    return slotFirst(short, !!out[i].slot);
  });
  return out.map((d, i) => {
    const same = named.filter((l, j) => l === named[i] && j < i).length;
    const total = named.filter((l) => l === named[i]).length;
    const nth = total > 1 ? ` (${same + 1} of ${total})` : '';
    return { ...d, label: `${named[i]}${nth}`, full: `${slotFirst(d.path.join(' › '), !!d.slot)}${nth}` };
  });
}

type MenuFn = (el: HTMLElement | { x: number; y: number; returnTo?: HTMLElement }, ref: ElementRef, top: boolean, onRename?: () => void) => void;

/** A branch's child lists in outline order (an instance's slots in its definition's order). */
function childIdsInOrder(state: ProjectState, n: GraphNode): string[][] {
  if (n.kind !== 'instance') return childLists(n).map((l) => l.ids);
  return Object.keys(state.components[n.definitionId]?.slots ?? {}).map((slot) => slotChildren(n, slot));
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
  const picked = useContext(Picked);
  // What the row says about visibility follows the size the preview shows (not the inspector's style scope).
  const size = useStore((s) => scopeForWidth(s.viewport));
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
      ? Object.entries(def?.slots ?? {}).map(([slot, info]) => ({ slot, label: info.label, ids: slotChildren(n, slot) })).filter((l) => l.ids.length)
      : n
        ? childLists(n)
        : [];
  const childCount = slotLists.reduce((c, l) => c + l.ids.length, 0);
  const expandable = parts.length > 0 || childCount > 0;
  const canHold = n?.kind === 'element' || (n?.kind === 'instance' && Object.keys(def?.slots ?? {}).length > 0);
  // In component editing the canvas selects the definition's root through the placement; match it here. A part
  // of a component placed in the design is never that root, whatever its node is called inside that component.
  const isDefRoot = owner.kind === 'component' && state.components[owner.id]?.tree?.rootIds[0] === id;
  const defRoot = isDefRoot && !!definitionMode && !!selection && selection.owner.kind !== 'component' && selection.instancePath.length === 1 && selection.nodeId === id;
  // A node of a component being edited, picked on the canvas in one repeated item, is still this row.
  const own = sameRef(selection, ref) || defRoot || (owner.kind === 'component' && !!selection?.itemPath?.length && sameRef({ ...selection, itemPath: undefined }, ref));
  // One of several selected together: shown as selected too, while the selection itself stays the one row marked primary.
  const member = !!picked && picked.owner.kind === owner.kind && picked.owner.id === owner.id && picked.ids.includes(id);
  const selected = own || member;
  // Holds the selection: a part of this component (at any depth), or anything nested inside this container,
  // judged by where the selection's outermost component sits in this tree.
  const anchor = selection && selection.owner.id === owner.id ? (selection.instancePath[0] ?? selection.nodeId) : null;
  const containsSel = !!n && !!anchor && (anchor === id ? !!selection!.instancePath.length : subtreeIds(tree, id).includes(anchor));
  // Opening to reveal a selected part latches, so moving the selection back to the parent keeps the branch open.
  useEffect(() => {
    if (containsSel) setOpen(true);
  }, [containsSel]);
  // The project, the name shown, and the AI's activity when renaming began: whether anything was typed is
  // judged against that name, and if the AI ran meanwhile the new name is checked against that project.
  const renameBase = useRef<{ snap: ReturnType<typeof getState>['snapshot']; shown: string; name: string; ai: number } | null>(null);
  useEffect(() => {
    markDraft(`layer-rename:${id}`, renaming);
    return () => markDraft(`layer-rename:${id}`, false);
  }, [renaming, id]);
  if (!n) return null;
  const isOpen = open && expandable;
  // An unnamed text or button is told apart by its words; the root of a component being edited is the component.
  const ownerDef = owner.kind === 'component' ? state.components[owner.id] : undefined;
  const label = isDefRoot ? { label: ownerDef?.name ?? displayName(state, n), kind: ownerDef?.name ?? displayName(state, n), full: ownerDef?.name ?? displayName(state, n) } : layerLabel(state, n, ownerDef);
  const name = label.label;
  // The words of an unnamed text or button, which the row leads with (its kind is in its glyph, tooltip and label).
  const words = !isDefRoot && !n.name && !label.empty && contentText(n) ? label.excerpt : undefined;
  const level = words ? headingTag(label.kind) : null;
  // The name a rename starts from: the layer's own name or its type, never the excerpt of its words.
  const editName = isDefRoot ? label.kind : displayName(state, n);
  const vis = rowVisibility(state, tree, n, size);
  const hidden = vis.hiddenHere;
  const custom = def?.owner === 'project';
  const groupId = `layers-group-${owner.kind}-${id}`;
  // In the design of the component being edited, a node shown or hidden by a rule says so: the rule can hide it
  // on the canvas, where only this row still finds it.
  const conditions = ownerDef && definitionMode?.definitionId === owner.id ? describeConditions(ownerDef, n) : [];
  const title = [label.full, path.length ? `In ${path.join(' › ')}` : '', custom ? 'Made in this project' : '', sentence(vis.note), ...conditions].filter(Boolean).join('\n');
  const draggable = owner.kind !== 'shell' && !isDefRoot;
  const canToggleHidden = owner.kind !== 'shell' && !isDefRoot && hideable(state, n);
  const eye = canToggleHidden ? eyeAction(state, n, size) : null;
  // Hidden here by its own setting and by a layer above as well: showing it here takes both, and the eye says so.
  const alsoBy = vis.hiddenHere ? hiddenAncestor(state, tree, id, size) : null;
  const alsoNote = alsoBy ? ` ${alsoBy.name} also hides it on ${size}.` : '';
  // The sizes it hides itself at, when that is not every size: "Phone", "Tablet, Desktop".
  const sizesTag = vis.own.hiddenAt.length && vis.own.hiddenAt.length < 3 ? sizesTagText(vis.own.hiddenAt) : '';
  // Hidden here by its own size setting: the pressed eye carries the sizes, and no separate tag repeats it.
  const eyeTag = !!eye?.pressed && !!sizesTag && !vis.hiddenBy;
  const startRename = () => {
    cancelRename.current = false;
    renameBase.current = { snap: getState().snapshot, shown: editName, name: n?.name ?? '', ai: aiActivity() };
    setRenaming(true);
  };

  // Where a drop lands, as the moves it would make (one per layer dragged); null when it would leave everything where
  // it is. The dragged layers land together, in their order, before the first layer after the drop point that is not
  // one of them.
  const dropMove = (where: Drop['where']): EditOperation[] | null => {
    if (!dragging) return null;
    const moving = dragging.ids;
    if (where === 'inside' || where === 'first') {
      const slot = n.kind === 'instance' ? Object.keys(def?.slots ?? {})[0] : undefined;
      const list = n.kind === 'element' ? n.children : n.kind === 'instance' ? slotChildren(n, slot!) : [];
      const before = where === 'first' ? (list.find((c) => !moving.includes(c)) ?? null) : null;
      return placeOps(tree, owner, moving, { parentId: id, slot, before });
    }
    const target = findParent(tree, id);
    if (!target) return null;
    // A component has one top-level element, the component itself: nothing is dropped beside it.
    if (!target.parentId && owner.kind === 'component') return null;
    // A repeated item's template is edited through its list, not by moving layers into or within it.
    if (target.parentId && tree.nodes[target.parentId]?.kind === 'repeat') return null;
    const before = target.list.slice(target.index + (where === 'after' ? 1 : 0)).find((c) => !moving.includes(c)) ?? null;
    return placeOps(tree, owner, moving, { parentId: target.parentId, slot: target.slot, before });
  };

  const rowClass = [
    'list-item',
    'layer-row',
    selected && 'selected',
    // The others selected with the one everything follows: still selected, one step quieter.
    member && !own && 'member',
    renaming && 'renaming',
    selected && owner.kind === 'shell' && 'shared',
    containsSel && !selected && 'contains-sel',
    (hidden || vis.hiddenBy) && 'is-hidden',
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
        data-owner={`${owner.kind}:${owner.id}`}
        data-primary={own || undefined}
        data-name={label.kind}
        data-words={label.empty ? undefined : label.excerpt}
        aria-label={`${label.full}${custom ? ', made in this project' : ''}${vis.note ? `, ${vis.note}` : ''}${own && picked && member ? ', shown in the inspector' : ''}`}
        aria-description={conditions.length ? `${conditions.join('. ')}.` : undefined}
        style={{ ...depthVar(depth), '--drop-depth': drop?.depth ?? depth } as React.CSSProperties}
        draggable={draggable && !renaming}
        onDragStart={(e) => {
          // Dragging one of several layers selected together moves all of them, as one change; any other row, itself.
          const ids = member && picked ? picked.ids : [id];
          dragging = { owner, nodeId: id, ids };
          e.dataTransfer.effectAllowed = 'move';
          if (ids.length > 1) {
            dragBadge(e, `Moving ${groupCount(picked!)}`);
            for (const m of ids) rowFor(m)?.setAttribute('data-dragging', '');
          } else e.currentTarget.setAttribute('data-dragging', '');
        }}
        onDragEnd={(e) => {
          dragging = null;
          for (const r of e.currentTarget.closest('[role="tree"]')?.querySelectorAll('[data-dragging]') ?? []) r.removeAttribute('data-dragging');
        }}
        onDragOver={(e) => {
          if (!dragging || dragging.owner.kind !== owner.kind || dragging.owner.id !== owner.id || dragging.ids.includes(id)) return;
          if (dragging.ids.some((m) => subtreeIds(tree, m).includes(id))) return;
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
          const ops = where ? dropMove(where) : null;
          setDrop(null);
          dragging = null;
          if (!d || !ops) return;
          const what = d.ids.length > 1 && picked ? groupCount(picked) : tree.nodes[d.nodeId] ? layerLabel(state, tree.nodes[d.nodeId]).label : 'Layer';
          const slotName = n.kind === 'instance' ? Object.values(def?.slots ?? {})[0]?.label : undefined;
          const into = slotName ? `${slotName} in ${name}` : name;
          const to = where === 'inside' ? `to the end of ${into}` : where === 'first' ? `to the top of ${into}` : `${where} ${name}`;
          void applyOps(ops, `Move ${what} ${placeWords(state, owner)}`).then((r) => r && say(`Moved ${what} ${to}`));
        }}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={expandable ? isOpen : undefined}
        aria-owns={isOpen ? groupId : undefined}
        aria-level={depth + 1}
        tabIndex={-1}
        onClick={(e) => {
          // Shift picks a range from the layer picked before; Cmd (Ctrl) adds this one, or takes it away.
          if (e.shiftKey || additive(e)) {
            if (pickRow(e.shiftKey ? 'range' : 'toggle', ref)) e.currentTarget.focus();
            return;
          }
          // Shown on the page even when already selected: the page may have scrolled it away (issue #168).
          showLayer(ref);
        }}
        onDoubleClick={(e) => !e.shiftKey && !additive(e) && startRename()}
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
          if ((e.key === 'Enter' || e.key === ' ') && t === row) {
            e.preventDefault();
            // Space adds the focused layer to the selection (focus reached it with Cmd/Ctrl+↑/↓) or takes it away, the
            // last one too (WAI-ARIA tree); Enter selects this layer alone.
            if (e.key === ' ' && !e.shiftKey) pickRow('toggle', ref);
            else showLayer(ref);
          }
          if (e.key === 'F2') (e.preventDefault(), startRename());
          // From the row's ⋯ (focus can be there after a click) the menu opens at that button and returns to it.
          if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') (e.preventDefault(), onMenu(t !== row && t.closest('.actions') ? t : row, ref, true, startRename));
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
            defaultValue={editName}
            maxLength={60}
            aria-label={`Rename ${name}`}
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            // A right-click here is for the name being typed (spelling, cut, copy, paste), not the layer's actions.
            onContextMenu={(e) => e.stopPropagation()}
            onBlur={(e) => {
              setRenaming(false);
              const value = e.target.value.trim();
              // Focus goes back to the row unless it moved somewhere on purpose (Tab, or a click on a control).
              if (!e.relatedTarget) requestAnimationFrame(() => rowFor(id)?.focus());
              const from = renameBase.current;
              renameBase.current = null;
              if (cancelRename.current || value === (from?.shown ?? editName)) return;
              // A typed name, like any typed edit: if the AI ran meanwhile, it is checked against the project as
              // it was when renaming began before it is applied (held while the AI works).
              const checked = !!from && (!!getState().snapshot?.aiBusy || aiActivity() !== from.ai);
              // Otherwise written only while the name is still the one renaming began from (see commitOps).
              const commit = (rename: () => void) => (checked ? commitDraft(from!.snap, rename, value, { check: true }) : commitDraft(from?.snap ?? null, rename, value));
              if (isDefRoot) {
                if (value) commit(() => void applyOps([{ type: 'component.rename', definitionId: owner.id, name: value }], `Rename component ${from?.shown ?? editName} to ${value}`));
              } else if (value !== (from?.name ?? n.name ?? '')) commit(() => void applyOps([{ type: 'node.rename', owner, nodeId: id, name: value }], `Rename ${from?.shown ?? editName}${value ? ` to ${value}` : ''} ${placeWords(state, owner)}`));
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
            {words ? (
              // An unnamed text or button reads as its words; a heading keeps its level ahead of them.
              <>
                {level && <span className="layer-level">H{level}</span>}
                {label.excerpt}
              </>
            ) : label.excerpt ? (
              <>
                {label.kind} <span className={`layer-words${label.empty ? ' empty' : ''}`}>{label.excerpt}</span>
              </>
            ) : (
              name
            )}
          </span>
        )}
        {/* Hidden only at some sizes: which ones, while the preview shows another size. While it shows one of them,
            the sizes are the face of the pressed eye instead, so one closed eye says it. */}
        {sizesTag && !renaming && !eyeTag && (
          <span className={`layer-sizes${hidden ? ' here' : ''}`} aria-hidden="true" title={sentence(`hidden ${sizesText(vis.own.hiddenAt)}`)}>
            <SizesTag text={sizesTag} sizes={vis.own.hiddenAt} />
          </span>
        )}
        {conditions.length > 0 && !renaming && (
          <span className="layer-flag layer-cond" title={`${conditions.join('.\n')}.`}>
            <Split aria-hidden="true" />
          </span>
        )}
        {custom && !renaming && (
          <span className="badge layer-badge" title="A component made in this project">
            Custom
          </span>
        )}
        {/* One place says whether the layer shows in this preview. A layer above hides it: a quiet button with the
            menu's "Select Grid" arrow, which selects that layer to show it again there (the row is dimmed, and its
            branch's top says why). */}
        {vis.hiddenBy && !renaming && (
          <button
            className="icon-btn sm layer-eye layer-hider"
            tabIndex={-1}
            aria-label={vis.hiddenBy.target === vis.hiddenBy.name ? `Select ${vis.hiddenBy.name}, which hides this on ${size}` : `Select ${vis.hiddenBy.target}: ${vis.hiddenBy.name} hides this on ${size}`}
            title={`${sentence(`hidden on ${size} by ${vis.hiddenBy.name}, which is hidden ${sizesText(vis.hiddenBy.sizes)}`)} Click to select ${vis.hiddenBy.target}.`}
            onClick={(e) => (e.stopPropagation(), selectHider(owner, vis.hiddenBy!))}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <CornerLeftUp />
          </button>
        )}
        {hidden && !renaming && !canToggleHidden && (
          <span className="layer-flag" title={sentence(vis.note)}>
            <EyeOff aria-hidden="true" />
          </span>
        )}
        {/* The layer's own eye: pressed (and always shown) when it hides itself in the preview being shown; otherwise
            shown on the row being pointed at, focused, or the selection. A click shows it there again (on this size
            alone when only this size hides it), or hides it at every size. Like the row's other actions it is for the
            pointer: the row's menu (Shift+F10) has each of these for the keyboard. */}
        {eye && !vis.hiddenBy && !renaming && (
          <button
            className={`icon-btn sm layer-eye${eye.pressed ? ' on' : ''}${eyeTag ? ' with-sizes' : ''}`}
            tabIndex={-1}
            aria-label={`Hide ${name}`}
            aria-pressed={eye.pressed}
            aria-description={eye.pressed ? `${sentence(vis.note)} ${eye.action}.${alsoNote}` : `${eye.action}.`}
            title={eye.pressed ? `${sentence(vis.note)} Click to ${eye.action.toLowerCase()}.${alsoNote}` : eye.action}
            onClick={(e) => (e.stopPropagation(), applyVisibility(owner, n.id, eye.edits, eye.action.replace(/^(Show|Hide)/, (verb) => `${verb} ${name} ${placeWords(state, owner)}`)))}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {eyeTag ? <SizesTag text={sizesTag} sizes={vis.own.hiddenAt} /> : eye.pressed ? <EyeOff /> : <Eye />}
          </button>
        )}
        {drop?.where === 'inside' && (
          <span className="layer-drop-tag" aria-hidden="true">
            {drop.label}
          </span>
        )}
        <span className="actions" style={renaming ? { display: 'none' } : undefined}>
          <button
            className="icon-btn sm"
            tabIndex={-1}
            aria-haspopup="menu"
            // One of several selected together: its menu is theirs.
            aria-label={member && picked ? `Actions for ${groupCount(picked)}` : `${name} options`}
            title={member && picked ? `Actions for ${groupCount(picked)}` : 'Layer options'}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => (e.stopPropagation(), onMenu(e.currentTarget, ref, true, startRename))}
          >
            <Ellipsis />
          </button>
        </span>
      </div>
      {isOpen && (
        <div id={groupId} className={`layers-children${containsSel ? ' on-path' : ''}`} role="group" aria-label={`Inside ${name}`} style={depthVar(depth)}>
          {/* Everything in this branch is hidden here because this layer is: said once, at its top. */}
          {hidden && !vis.hiddenBy && <SubLabel depth={depth + 1} label={vis.own.hiddenAt.length === 3 ? `Hidden at every size by ${name}` : `Hidden on ${size} by ${name}`} icon={<EyeOff />} />}
          {parts.length > 0 && <SubLabel depth={depth + 1} label="Parts" />}
          {parts.map(([pid, p]) => {
            const pref: ElementRef = { owner, instancePath: [id], nodeId: p.nodeId, partId: pid };
            const psel = !!selection && refKey({ ...selection, itemPath: undefined }) === refKey(pref);
            const partNode = def?.tree?.nodes[p.nodeId];
            // A part hidden in this preview by this placement's settings, or by the placement or a layer above it.
            const pvis = rowVisibility(state, tree, n, size, pid);
            const ptag = pvis.own.hiddenAt.length ? (pvis.own.hiddenAt.length < 3 ? sizesTagText(pvis.own.hiddenAt) : 'Hidden') : '';
            return (
              <div
                key={pid}
                className={`list-item layer-row layer-part${psel ? ' selected' : ''}${psel && owner.kind === 'shell' ? ' shared' : ''}${pvis.hiddenHere || pvis.hiddenBy ? ' is-hidden' : ''}`}
                data-primary={psel || undefined}
                data-name={p.label}
                aria-label={`${p.label}, part of ${name}${pvis.note ? `, ${pvis.note}` : ''}`}
                style={depthVar(depth + 1)}
                role="treeitem"
                aria-selected={psel}
                aria-level={depth + 2}
                tabIndex={-1}
                onClick={(e) => {
                  // A Shift or Cmd/Ctrl pick of a part says why it can't join layers selected, rather than replacing them.
                  if (e.shiftKey || additive(e)) return void pickRow(e.shiftKey ? 'range' : 'toggle', pref);
                  showLayer(pref);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') (e.preventDefault(), showLayer(ref), rowFor(id)?.focus());
                  if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                    e.preventDefault();
                    // Space toggles, as on any row: a selected part lets go; Enter selects it.
                    if (e.key === ' ' && !psel) pickRow('toggle', pref);
                    else if (e.key === ' ') setState({ selection: null });
                    else showLayer(pref);
                  }
                  if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') (e.preventDefault(), onMenu((e.target as HTMLElement).closest<HTMLElement>('.actions button') ?? e.currentTarget, pref, false));
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
                <span className="grow ellipsis layer-name" title={[p.label, `Part of ${[...path, name].join(' › ')}`, sentence(pvis.note)].filter(Boolean).join('\n')}>
                  {p.label}
                </span>
                {ptag && (
                  <span className={`layer-sizes${pvis.hiddenHere ? ' here' : ''}`} aria-hidden="true" title={sentence(`hidden ${sizesText(pvis.own.hiddenAt)}`)}>
                    <SizesTag text={ptag} sizes={pvis.own.hiddenAt} />
                  </span>
                )}
                <span className="actions">
                  <button className="icon-btn sm" tabIndex={-1} aria-haspopup="menu" aria-label={`${p.label} options`} title="Part options" onDoubleClick={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), onMenu(e.currentTarget, pref, false))}>
                    <Ellipsis />
                  </button>
                </span>
              </div>
            );
          })}
          {slotLists.map((l) => (
            <Fragment key={l.slot ?? 'children'}>
              {(parts.length > 0 || slotLists.length > 1) && l.label && <SubLabel depth={depth + 1} label={l.label} />}
              {(() => {
                // Slot content hidden by a part of this component (a wrapper with no row of its own here).
                const first = !hidden && l.ids[0] ? tree.nodes[l.ids[0]] : undefined;
                // Asked of the layers above it, so a first layer that also hides itself still finds the part.
                const by = first ? hiddenAncestor(state, tree, first.id, size) : undefined;
                return by?.part && by.id === id ? <SubLabel depth={depth + 1} label={`Hidden on ${size} by ${by.name}`} icon={<EyeOff />} /> : null;
              })()}
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
function SubLabel({ depth, label, icon }: { depth: number; label: string; icon?: React.ReactNode }) {
  return (
    <div className={`layers-sublabel${icon ? ' with-icon' : ''}`} aria-hidden="true" title={icon ? label : undefined} style={depthVar(depth)}>
      {icon}
      <span className="ellipsis">{label}</span>
    </div>
  );
}
