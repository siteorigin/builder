import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { icons, Search, Code, CornerDownRight, Check, Plus, SearchX, X, ArrowDown, Ellipsis, Pencil, Trash2, FileText, PanelTop, PanelBottom, Component } from 'lucide-react';
import type { ComponentDefinition, OwnerRef, ProjectState } from '@shared/types';
import { childLists, placementCounts, placesOf } from '@engine/tree';
import { dependentsOf } from '@engine/definitions';
import { catalogueEntries, CATEGORY_LABELS } from '@catalogue/index';
import { commitOps, getState, setState, toast, undoAction, useStore } from '../store';
import { insert, insertionPoint, selectPage, type Primitive } from '../lib/actions';
import { ownerLabel, refLabel, treeFor } from '../lib/model';
import { gridKeys, useGridTabStops, useMenu, type MenuItem } from '../components/ui';

export function LucideIcon({ name, size = 15 }: { name?: string; size?: number }) {
  const key = (name ?? 'box')
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join('') as keyof typeof icons;
  const I = icons[key] ?? icons.Box;
  return <I size={size} />;
}


/**
 * A small wireframe of a section's layout, drawn with the same bars as the New project starters, so a
 * section can be recognised before it is inserted. Unknown sections get a generic heading-and-text sketch.
 */
export function SectionSketch({ id }: { id: string }) {
  const bar = (w: string, h = 4, cls = '') => <i className={cls} style={{ width: w, height: h }} />;
  const key = id.split('.')[0];
  const lines = (n: number, widths = ['90%', '75%', '60%']) => [...Array(n)].map((_, i) => <i key={i} style={{ width: widths[i % widths.length], height: 3 }} />);
  switch (id) {
    case 'hero.centered':
      return (
        <span className="sketch center">
          {bar('30%', 3)}
          {bar('70%', 6, 'hi')}
          {bar('50%', 3)}
          {bar('22%', 6, 'cta')}
        </span>
      );
    case 'hero.split':
      return (
        <span className="sketch split">
          <span className="col-s">
            {bar('80%', 6, 'hi')}
            {lines(2)}
            {bar('35%', 5, 'cta')}
          </span>
          <i className="img" />
        </span>
      );
    case 'content.media':
      return (
        <span className="sketch split">
          <i className="img" />
          <span className="col-s">
            {bar('75%', 5, 'hi')}
            {lines(3)}
          </span>
        </span>
      );
    case 'intro.page':
      return (
        <span className="sketch">
          {bar('25%', 3)}
          {bar('60%', 7, 'hi')}
          {bar('80%', 3)}
        </span>
      );
    case 'content.text':
      return (
        <span className="sketch">
          {bar('50%', 5, 'hi')}
          {lines(4, ['95%', '90%', '92%', '60%'])}
        </span>
      );
    case 'cta.banner':
      return (
        <span className="sketch band center">
          {bar('55%', 5, 'hi')}
          {bar('24%', 6, 'cta')}
        </span>
      );
    case 'faq.list':
      return <span className="sketch">{[...Array(4)].map((_, i) => <i key={i} className="row-line" />)}</span>;
    case 'stats.row':
      return (
        <span className="sketch cols">
          {[...Array(4)].map((_, i) => (
            <span key={i} className="col-s center">
              {bar('70%', 7, 'hi')}
              {bar('60%', 3)}
            </span>
          ))}
        </span>
      );
    case 'logos.strip':
      return <span className="sketch cols mid">{[...Array(5)].map((_, i) => <i key={i} className="hi" style={{ height: 5 }} />)}</span>;
    case 'media.gallery':
      return <span className="sketch grid3">{[...Array(6)].map((_, i) => <i key={i} className="img" />)}</span>;
    case 'layout.section':
      return (
        <span className="sketch open">
          <i className="slot" />
        </span>
      );
    case 'team.grid':
      return (
        <span className="sketch cols">
          {[...Array(3)].map((_, i) => (
            <span key={i} className="col-s center">
              <i className="dot" />
              {bar('70%', 3)}
            </span>
          ))}
        </span>
      );
    default:
      break;
  }
  if (key === 'features' || key === 'testimonials' || key === 'pricing')
    return (
      <span className="sketch cols">
        {[...Array(3)].map((_, i) => (
          <span key={i} className="col-s card">
            {key === 'pricing' ? bar('50%', 6, 'hi') : key === 'testimonials' ? <i className="quote" /> : <i className="dot sm" />}
            {key === 'testimonials' && lines(2)}
            {key === 'testimonials' ? bar('40%', 3, 'hi') : lines(2)}
          </span>
        ))}
      </span>
    );
  if (key === 'contact')
    return (
      <span className="sketch split">
        <span className="col-s">
          {bar('60%', 5, 'hi')}
          {lines(3)}
        </span>
        <span className="col-s">
          <i className="field" />
          <i className="field" />
          {bar('40%', 6, 'cta')}
        </span>
      </span>
    );
  return (
    <span className="sketch">
      {bar('55%', 5, 'hi')}
      {lines(3)}
    </span>
  );
}


const BASICS: Array<{ id: Primitive; name: string; icon: string; tags: string }> = [
  { id: 'heading', name: 'Heading', icon: 'heading-1', tags: 'title text h1 h2' },
  { id: 'paragraph', name: 'Paragraph', icon: 'pilcrow', tags: 'text copy body' },
  { id: 'button', name: 'Button', icon: 'rectangle-horizontal', tags: 'link action cta' },
  { id: 'image', name: 'Image', icon: 'image', tags: 'photo picture' },
  { id: 'stack', name: 'Stack', icon: 'rows-3', tags: 'vertical container group' },
  { id: 'row', name: 'Row', icon: 'columns-3', tags: 'horizontal container group' },
  { id: 'grid', name: 'Grid', icon: 'layout-grid', tags: 'columns container' },
  { id: 'container', name: 'Container', icon: 'square-dashed', tags: 'box group' },
  { id: 'icon', name: 'Icon', icon: 'star', tags: 'symbol' },
  { id: 'divider', name: 'Divider', icon: 'separator-horizontal', tags: 'line rule separator' }
];

type Kind = 'section' | 'element' | 'component';
interface Item {
  key: string;
  kind: Kind;
  name: string;
  description: string;
  hay: string;
  group: string;
  spec: { componentId?: string; definitionId?: string; primitive?: Primitive };
  icon?: string;
  code?: boolean;
  /** Project components: how many times it is placed. */
  uses?: number;
}
/** Where an insert lands, in words: "after" + "Split hero". */
type Where = { lead: string; target: string } | null;

/** The node just before an insertion index, in the list that index counts in. */
function nodeBefore(st: ProjectState, owner: OwnerRef, parentId: string | null, slot: string | undefined, index: number | undefined): string | null {
  if (!index) return null;
  const tree = treeFor(st, owner);
  if (!tree) return null;
  if (!parentId) return tree.rootIds[index - 1] ?? null;
  const parent = tree.nodes[parentId];
  if (!parent) return null;
  const lists = childLists(parent);
  return ((slot ? lists.find((l) => l.slot === slot) : lists[0])?.ids ?? [])[index - 1] ?? null;
}

const nodeLabel = (st: ProjectState, owner: OwnerRef, nodeId: string) => refLabel(st, { owner, instancePath: [], nodeId });

/** Where a section or a project component goes, read from the same insertion point insert() uses. */
function sectionWhere(st: ProjectState): Where {
  const at = insertionPoint('section');
  if (!at) return null;
  const before = nodeBefore(st, at.owner, at.parentId, at.slot, at.index);
  if (before) return { lead: 'after', target: nodeLabel(st, at.owner, before) };
  if (at.parentId) return { lead: 'inside', target: nodeLabel(st, at.owner, at.parentId) };
  return { lead: at.index === 0 ? 'at the top of' : 'at the end of', target: ownerLabel(st, at.owner) };
}

/** Where a basic element goes. On a page with nowhere to put it, insert() wraps it in a new section. */
function elementWhere(st: ProjectState): Where {
  const at = insertionPoint('element');
  if (!at) return null;
  const before = nodeBefore(st, at.owner, at.parentId, at.slot, at.index);
  if (at.owner.kind === 'page' && !at.parentId)
    return before ? { lead: 'in a new section after', target: nodeLabel(st, at.owner, before) } : { lead: at.index === 0 ? 'in a new section at the top of' : 'in a new section at the end of', target: ownerLabel(st, at.owner) };
  if (before) return { lead: 'after', target: nodeLabel(st, at.owner, before) };
  if (at.parentId) return { lead: 'inside', target: nodeLabel(st, at.owner, at.parentId) };
  return { lead: 'at the end of', target: ownerLabel(st, at.owner) };
}

/** Saved components shown before "Show all", so a large library never buries the built-in catalogue. */
const MINE_SHOWN = 4;

const KIND_SUBJECT: Record<Kind, string> = { section: 'Sections go', element: 'Elements go', component: 'Components go' };

function Phrase({ kind, where }: { kind: Kind; where: Where }) {
  if (!where) return null;
  return (
    <>
      {KIND_SUBJECT[kind]} {where.lead} <b>{where.target}</b>
    </>
  );
}

function ItemIcon({ it }: { it: Item }) {
  if (it.kind === 'component') return <span className="ico">{it.code ? <Code /> : <LucideIcon name="component" />}</span>;
  return (
    <span className="ico">
      <LucideIcon name={it.icon} />
    </span>
  );
}

/** How often a component is placed, in the Inspector's words: "once", "3 times". */
const usedTimes = (n: number) => (n === 1 ? 'once' : `${n} times`);

/**
 * Tiles in a two-column APG grid: one tab stop, arrow keys between tiles, Enter or Space to add. With `aside`, each
 * tile is followed in its row by a cell of its own (the library's manage button), reached with the arrow keys.
 */
function TileGrid({ items, labelledBy, className = '', cols = 2, render, aside, extra }: { items: Item[]; labelledBy: string; className?: string; cols?: 1 | 2; render: (it: Item) => ReactNode; aside?: (it: Item) => ReactNode; extra?: ReactNode }) {
  const cell = (key: string, content: ReactNode) => (
    <div role="gridcell" className="insert-cell" key={key}>
      {content}
    </div>
  );
  const units: ReactNode[][] = items.map((it) => [cell(it.key, render(it)), ...(aside ? [cell(`${it.key}:aside`, aside(it))] : [])]);
  if (extra) units.push([cell('extra', extra)]);
  const rows: ReactNode[] = [];
  for (let i = 0; i < units.length; i += cols)
    rows.push(
      <div role="row" className="insert-row" key={i}>
        {units.slice(i, i + cols).flat()}
      </div>
    );
  return (
    <div role="grid" aria-labelledby={labelledBy} className={`insert-grid ${className}`}>
      {rows}
    </div>
  );
}

export function InsertPanel() {
  const snap = useStore((s) => s.snapshot);
  // Read so the destinations below follow the selection, the page and component editing.
  const selection = useStore((s) => s.selection);
  useStore((s) => s.pageId);
  useStore((s) => s.definitionMode);
  const dev = useStore((s) => !!s.settings?.developerMode);
  const open = useStore((s) => s.leftTab === 'insert');
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  // What the destination line describes: the tile under the pointer, else the one with keyboard focus, else
  // the group scrolled to the top of the list.
  // 'new' is the New code component action, which opens an editor instead of inserting anywhere.
  const [pointed, setPointed] = useState<Kind | 'new' | null>(null);
  const [focused, setFocused] = useState<Kind | 'new' | null>(null);
  const [scrolled, setScrolled] = useState<Kind | null>(null);
  const [allMine, setAllMine] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const browseTop = useRef(0);
  const [added, setAdded] = useState<{ name: string; where: Where; n: number; selection: unknown } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const menu = useMenu();
  useGridTabStops(bodyRef);
  const entries = useMemo(() => (snap ? catalogueEntries(snap.state.site.themeId) : []), [snap?.state.site.themeId]);
  const uses = useMemo(() => (snap ? placementCounts(snap.state) : {}), [snap?.state]);
  // Opening the panel puts the cursor in search, so typing a name finds it straight away.
  useEffect(() => {
    if (open) searchRef.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => setActive(0), [q]);
  // Keep the highlighted result in view, so Enter never adds something off screen.
  useEffect(() => {
    if (q.trim()) document.getElementById(`${id}-r${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, q, id]);
  // Searching keeps the place in the catalogue: leaving search returns to where browsing was.
  const searching = !!q.trim();
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (searching) body.scrollTop = 0;
    else body.scrollTop = browseTop.current;
  }, [searching]);
  // A narrow sidebar gives element tiles one column (and the grid one cell per row), so names never clip.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const ro = new ResizeObserver(() => setNarrow(body.clientWidth <= 232));
    ro.observe(body);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!added) return;
    const t = setTimeout(() => setAdded(null), 3200);
    return () => clearTimeout(t);
  }, [added]);
  // The confirmation gives way as soon as the next destination matters: another selection, another tile,
  // another result or another query.
  useEffect(() => {
    if (added && selection !== added.selection) setAdded(null);
  }, [selection, added]);
  useEffect(() => setAdded(null), [q, active]);
  if (!snap) return null;
  const st = snap.state;

  const sections: Item[] = entries.map((e) => ({
    key: `s:${e.componentId}`,
    kind: 'section',
    name: e.name,
    description: e.description,
    hay: `${e.name} ${e.description} ${e.tags.join(' ')} ${CATEGORY_LABELS[e.category] ?? e.category} section`.toLowerCase(),
    group: CATEGORY_LABELS[e.category] ?? e.category,
    spec: { componentId: e.componentId }
  }));
  const elements: Item[] = BASICS.map((b) => ({ key: `e:${b.id}`, kind: 'element', name: b.name, description: '', hay: `${b.name} ${b.tags} element`.toLowerCase(), group: 'Basic elements', spec: { primitive: b.id }, icon: b.icon }));
  // Code components show only in Developer mode, as its setting promises.
  const mine: Item[] = Object.values(st.components)
    .filter((d) => d.owner === 'project' && d.category !== 'shell' && (dev || d.kind !== 'code'))
    .map((d) => ({ key: `c:${d.id}`, kind: 'component', name: d.name, description: d.description ?? '', hay: `${d.name} ${d.description ?? ''} ${d.kind === 'code' ? 'code ' : ''}component`.toLowerCase(), group: 'Your components', spec: { definitionId: d.id }, code: d.kind === 'code', uses: uses[d.id] ?? 0 }));

  // Search: every word must match; exact names first, then names that start with the query, then names
  // that contain every word, then description and tag matches. Ties keep the panel's own order.
  const query = q.toLowerCase().trim();
  const words = query.split(/\s+/).filter(Boolean);
  const rank = (it: Item) => {
    const n = it.name.toLowerCase();
    return n === query ? 0 : n.startsWith(query) ? 1 : words.every((w) => n.includes(w)) ? 2 : 3;
  };
  const results = query
    ? [...mine, ...sections, ...elements]
        .filter((it) => words.every((w) => it.hay.includes(w)))
        .map((it, i) => ({ it, r: rank(it), i }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map((x) => x.it)
    : [];
  const current = results[Math.min(active, results.length - 1)];

  const sectionTo = sectionWhere(st);
  // Project components insert the way sections do.
  const where: Record<Kind, Where> = { section: sectionTo, element: elementWhere(st), component: sectionTo };
  const topKind: Kind = mine.length ? 'component' : 'section';
  const stripKind: Kind | 'new' = query ? (current?.kind ?? 'section') : (pointed ?? focused ?? scrolled ?? topKind);

  const add = async (it: Item) => {
    const to = where[it.kind];
    const before = getState().selection;
    await insert(it.spec, it.name);
    const after = getState().selection;
    if (after && after !== before) setAdded((a) => ({ name: it.name, where: to, n: (a?.n ?? 0) + 1, selection: after }));
  };
  const clear = () => {
    setQ('');
    searchRef.current?.focus();
  };
  // Escape anywhere in the panel clears a search first, before the editor's own Escape (deselect) runs.
  const onPanelKey = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && q && !(e.target as HTMLElement).closest('.insert-body [role="grid"]')) {
      e.preventDefault();
      e.stopPropagation();
      clear();
    }
  };
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Text editing, IME composition and modified keys stay with the field.
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key === 'Escape' && q) {
      e.preventDefault();
      setQ('');
    } else if (e.key === 'Enter' && current) {
      e.preventDefault();
      if (!e.repeat) void add(current);
    } else if (query && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(results.length - 1, a + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (!query && e.key === 'ArrowDown') {
      // Down from an empty search goes into the palette.
      e.preventDefault();
      bodyRef.current?.querySelector<HTMLElement>('[role="gridcell"] > [tabindex="0"]')?.focus();
    }
  };
  // The strip above the list follows the tile under the pointer or the keyboard, so it always says where
  // the thing you are about to add will go.
  const onBodyFocus = (e: React.FocusEvent<HTMLElement>) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[role="gridcell"] > *');
    if (!cell) return;
    for (const c of cell.closest('[role="grid"]')?.querySelectorAll<HTMLElement>('[role="gridcell"] > *') ?? []) {
      if (c === cell) c.dataset.rove = '1';
      else delete c.dataset.rove;
      c.tabIndex = c === cell ? 0 : -1;
    }
    setPointed(null);
    setAdded(null);
    setFocused((cell.dataset.kind as Kind | 'new') || null);
  };
  const onBodyBlur = (e: React.FocusEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(null);
  };
  const onBodyScroll = (e: React.UIEvent<HTMLElement>) => {
    const body = e.currentTarget;
    if (searching) return;
    browseTop.current = body.scrollTop;
    // At the very top the first group speaks; scrolled to the end, the last one does (it may never reach the top).
    let k: Kind | null = null;
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) k = (body.querySelector<HTMLElement>('.insert-group[data-kind="element"]') ? 'element' : null);
    else if (body.scrollTop > 4) {
      const top = body.getBoundingClientRect().top + 24;
      const group = [...body.querySelectorAll<HTMLElement>('.insert-group')].find((g) => g.getBoundingClientRect().bottom > top);
      k = (group?.dataset.kind as Kind) || null;
    }
    if (k !== scrolled) setScrolled(k);
  };
  const jumpToElements = () => {
    const g = bodyRef.current?.querySelector<HTMLElement>('.insert-group[data-kind="element"]');
    if (!g) return;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    g.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'instant' });
    const cell = g.querySelector<HTMLElement>('[role="gridcell"] > [tabindex="0"]');
    cell?.focus({ preventScroll: true });
    // A remembered tile further down the group must end up on screen too.
    if (cell) setTimeout(() => cell.scrollIntoView({ block: 'nearest' }), smooth ? 350 : 0);
  };
  const hover = (k: Kind | 'new') => ({
    onMouseEnter: () => {
      setPointed(k);
      setAdded(null);
    },
    onMouseLeave: () => setPointed(null)
  });
  const tileProps = (it: Item) => ({
    'data-kind': it.kind,
    'aria-describedby': `${id}-to-${it.kind}`,
    onClick: () => void add(it),
    ...hover(it.kind)
  });
  const plus = (
    <span className="insert-add" aria-hidden="true">
      <Plus />
    </span>
  );
  // The library's own menu: rename, where each copy is placed (choosing one shows it), and delete once unused.
  const manageItems = (def: ComponentDefinition): MenuItem[] => {
    const places = placesOf(st, def.id);
    const needs = dependentsOf(st, def.id);
    const count = places.reduce((n, p) => n + p.nodeIds.length, 0);
    const show = (owner: OwnerRef, nodeId: string) => () => {
      if (owner.kind === 'page') selectPage(owner.id);
      setState({ selection: { owner, instancePath: [], nodeId }, rightTab: 'inspect', dockOpen: true });
    };
    const placeItem = (p: (typeof places)[number]): MenuItem => {
      const n = p.nodeIds.length > 1 ? `${p.nodeIds.length} times` : undefined;
      if (p.owner.kind === 'page') return { label: p.label, icon: <FileText />, hint: n, onSelect: show(p.owner, p.nodeIds[0]) };
      if (p.owner.kind === 'shell') return { label: `Shared ${p.label.toLowerCase()}`, icon: p.owner.id === 'footer' ? <PanelBottom /> : <PanelTop />, hint: n, onSelect: show(p.owner, p.nodeIds[0]) };
      // Inside another component's design: it is shown wherever that component is.
      return { label: `In ${p.label}`, icon: <Component />, hint: n ?? 'Design', disabled: true };
    };
    return [
      { label: 'Rename…', icon: <Pencil />, onSelect: () => setState({ modal: { kind: 'rename-component', definitionId: def.id } }) },
      { separator: true },
      { heading: count ? `Used ${usedTimes(count)}` : 'Not used anywhere' },
      ...places.map(placeItem),
      ...needs.map((d): MenuItem => ({ label: `Needed by ${d.name}`, icon: <Code />, hint: 'Code', disabled: true })),
      { separator: true },
      { label: 'Delete component', icon: <Trash2 />, danger: true, disabled: count > 0 || needs.length > 0, hint: count || needs.length ? 'In use' : undefined, onSelect: () => void removeDefinition(def) }
    ];
  };
  const removeDefinition = async (def: ComponentDefinition) => {
    const r = await commitOps([{ type: 'component.remove', definitionId: def.id }], `Delete component ${def.name}`);
    if (!r || getState().snapshot?.workspaceKey !== r.workspaceKey) return;
    toast(`Deleted ${def.name}`, 'info', undoAction(r));
  };
  const manage = (it: Item) => {
    const def = st.components[it.spec.definitionId!];
    return def ? manageItems(def) : [];
  };

  const groups = new Map<string, Item[]>();
  for (const it of sections) groups.set(it.group, [...(groups.get(it.group) ?? []), it]);
  const found = query ? (results.length ? `${results.length} result${results.length === 1 ? '' : 's'} for ${q.trim()}` : `No matches for ${q.trim()}`) : '';
  const confirmed = added ? `Added ${added.name} ${added.where?.lead ?? ''} ${added.where?.target ?? ''}` : '';
  const stripWhere = stripKind === 'new' ? null : where[stripKind];
  const stripText = added ? confirmed : stripWhere ? `${KIND_SUBJECT[stripKind as Kind]} ${stripWhere.lead} ${stripWhere.target}` : '';
  const newCode = dev && (
    <button className="insert-tile new" data-kind="new" onClick={() => setState({ modal: { kind: 'new-code' } })} {...hover('new')}>
      <span className="ico">
        <Plus />
      </span>
      <strong>New code component</strong>
    </button>
  );
  const yours = (
    <section className="insert-group" data-kind="component" aria-labelledby={`${id}-yours`}>
      <h4 className="insert-head" id={`${id}-yours`}>
        Your components
        {mine.length > 0 && <span className="count">{mine.length}</span>}
      </h4>
      {(mine.length > 0 || dev) && (
        <TileGrid
          items={allMine ? mine : mine.slice(0, MINE_SHOWN)}
          labelledBy={`${id}-yours`}
          className="compact list managed"
          cols={1}
          extra={newCode || undefined}
          render={(it) => (
            <button
              className="insert-tile project"
              title={it.description ? `${it.name}: ${it.description}` : it.name}
              {...tileProps(it)}
              onContextMenu={(e) => {
                e.preventDefault();
                menu.open(e.clientX, e.clientY, manage(it), `Manage ${it.name}`, e.currentTarget);
              }}
            >
              <ItemIcon it={it} />
              <span className="txt">
                <strong>{it.name}</strong>
                <small>
                  {it.code ? 'Code component' : 'Component'} · {it.uses ? `Used ${usedTimes(it.uses)}` : 'Not used'}
                </small>
              </span>
            </button>
          )}
          aside={(it) => (
            <button className="icon-btn insert-manage" aria-haspopup="menu" aria-label={`Manage ${it.name}`} title="Rename, see where it is used, or delete" onClick={(e) => menu.openAt(e.currentTarget, manage(it), `Manage ${it.name}`)}>
              <Ellipsis />
            </button>
          )}
        />
      )}
      {menu.node}
      {mine.length > MINE_SHOWN && (
        <button className="btn btn-sm btn-ghost insert-more" aria-expanded={allMine} onClick={() => setAllMine(!allMine)}>
          {allMine ? 'Show fewer' : `Show all ${mine.length} components`}
        </button>
      )}
      <p className="insert-empty-note">{mine.length ? 'To make another, right-click a group of elements on the page and choose Create component.' : 'Your own components appear here. To make one, right-click a group of elements on the page and choose Create component.'}</p>
    </section>
  );

  return (
    <div className="insert-panel" onKeyDown={onPanelKey}>
      <div className="panel-head">
        <h3>Insert</h3>
        {!query && (
          <button className="btn btn-sm btn-ghost insert-jump" onClick={jumpToElements}>
            <ArrowDown aria-hidden="true" /> Elements
          </button>
        )}
      </div>
      <div className="search insert-search">
        <Search aria-hidden="true" />
        <input
          ref={searchRef}
          className="input"
          role="combobox"
          aria-expanded={!!query && results.length > 0}
          aria-controls={query && results.length ? `${id}-results` : undefined}
          aria-autocomplete="list"
          aria-activedescendant={query && current ? `${id}-r${results.indexOf(current)}` : undefined}
          placeholder="Search items to add"
          aria-label="Search items to add"
          value={q}
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onSearchKey}
        />
        {q && (
          <button
            className="icon-btn sm insert-clear"
            aria-label="Clear search"
            title="Clear search (Esc)"
            onClick={clear}
          >
            <X />
          </button>
        )}
      </div>
      {!(query && !results.length) && (
        <p className={`insert-where${added ? ' added' : ''}`} key={added?.n ?? 0} title={stripText || undefined}>
          {added ? <Check aria-hidden="true" /> : <CornerDownRight aria-hidden="true" />}
          <span>
            {added ? (
              <>
                Added <b>{added.name}</b> {added.where?.lead} <b>{added.where?.target}</b>
              </>
            ) : stripKind === 'new' ? (
              <>Opens the code editor to write a new component</>
            ) : (
              <Phrase kind={stripKind} where={where[stripKind]} />
            )}
          </span>
        </p>
      )}
      <p className="sr-only" role="status">
        {found}
      </p>
      <p className="sr-only" role="status">
        {confirmed}
      </p>
      {(['section', 'element', 'component'] as const).map((k) => (
        <span key={k} id={`${id}-to-${k}`} hidden>
          {where[k] ? `${KIND_SUBJECT[k]} ${where[k]!.lead} ${where[k]!.target}` : ''}
        </span>
      ))}
      <div className="panel-body insert-body" ref={bodyRef} onKeyDown={gridKeys} onFocus={onBodyFocus} onBlur={onBodyBlur} onScroll={onBodyScroll} onMouseLeave={() => setPointed(null)}>
        {query ? (
          results.length ? (
            <div className="insert-results" role="listbox" id={`${id}-results`} aria-label="Results">
              {results.map((it, i) => (
                <div
                  key={it.key}
                  id={`${id}-r${i}`}
                  role="option"
                  aria-selected={it === current}
                  aria-describedby={`${id}-to-${it.kind}`}
                  className={`insert-result${it === current ? ' active' : ''}`}
                  title={it.description || undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => void add(it)}
                >
                  {it.kind === 'section' ? (
                    <span className="insert-thumb" aria-hidden="true">
                      <SectionSketch id={it.spec.componentId!} />
                    </span>
                  ) : (
                    <ItemIcon it={it} />
                  )}
                  <span className="txt">
                    <strong>{it.name}</strong>
                    <small>{it.kind === 'section' ? `Section · ${it.group}` : it.kind === 'element' ? 'Basic element' : it.code ? 'Your code component' : 'Your component'}</small>
                  </span>
                  {it === current && (
                    <kbd className="kbd" aria-hidden="true">
                      ↵
                    </kbd>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="insert-none">
              <SearchX aria-hidden="true" />
              <strong>Nothing matches “{q.trim()}”</strong>
              <span>Try a shorter or more general word, like “text”, “image” or “contact”.</span>
              <button className="btn btn-sm" onClick={clear}>
                Clear search
              </button>
            </div>
          )
        ) : (
          <>
            {mine.length > 0 && yours}
            {[...groups.entries()].map(([group, list], gi) => (
              <section key={group} className="insert-group" data-kind="section" aria-labelledby={`${id}-g${gi}`}>
                <h4 className="insert-head" id={`${id}-g${gi}`}>
                  {group}
                </h4>
                <TileGrid
                  items={list}
                  labelledBy={`${id}-g${gi}`}
                  render={(it) => (
                    <button className="insert-tile section" title={it.description} {...tileProps(it)}>
                      <SectionSketch id={it.spec.componentId!} />
                      <strong>{it.name}</strong>
                      {plus}
                    </button>
                  )}
                />
              </section>
            ))}
            <section className="insert-group" data-kind="element" aria-labelledby={`${id}-basics`}>
              <h4 className="insert-head" id={`${id}-basics`}>
                Basic elements
              </h4>
              <TileGrid
                items={elements}
                labelledBy={`${id}-basics`}
                className={`compact${narrow ? ' list' : ''}`}
                cols={narrow ? 1 : 2}
                render={(it) => (
                  <button className="insert-tile basic" {...tileProps(it)}>
                    <ItemIcon it={it} />
                    <strong>{it.name}</strong>
                  </button>
                )}
              />
            </section>
            {mine.length === 0 && yours}
          </>
        )}
      </div>
    </div>
  );
}
