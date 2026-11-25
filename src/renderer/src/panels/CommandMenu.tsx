import './CommandMenu.css';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookmarkPlus, SquareDashed, ChevronDown, ClipboardCopy, ClipboardPaste, Code, Component, FileText, FolderOpen, History, Link2, Plus, Redo2, Replace, Search, SearchX, TextSearch, Undo2, Settings, Sparkles, Upload, X, Palette, Eye, LogOut, Monitor, NotebookPen, PanelRight, Smartphone, Stethoscope, Tablet, House, ListTree, PanelLeft } from 'lucide-react';
import { useDialogFocus, sendCommand } from '../components/ui';
import { closeProject } from '../lib/leave';
import { api, projectHistory, setState, setViewport, toast, useStore } from '../store';
import { pageShowing, partName } from '@shared/page-shell';
import { insert, pageOutOfSight, selectPage, askAiAbout, setMode, openSiteStyles, openOutline, openComponentStudio, planLayers, currentOwner } from '../lib/actions';
import { copiedHere, copySelection, pasteFromMenu } from '../lib/clipboard';
import { postWorkspace } from '../lib/posts';
import { platformKeys } from './CopyPaste';
import { pageChoices, matchesWords, commandText, exactDetailFirst } from '../lib/page-switch';
import { VIEWPORT_PRESETS } from '@shared/styles';
import { LucideIcon } from './InsertPanel';
import { openContentMatch } from './FindReplace';
import { contentFields, findContent, placedSections, sectionMatches } from '../lib/find-content';
import { insertChoices, insertLanding } from '../lib/command-inserts';
import { LEFT_TABS } from './LeftTabs';

interface Cmd {
  id: string;
  label: string;
  /** The verb the label starts with ("Go to ", "Insert "). Kept in the row's text, but not drawn: the group heading and the
   *  icon already say it, so the row leads with the words that tell it from its neighbours. */
  verb?: string;
  /** What tells entries with the same label apart, such as a page's address. Shown, spoken and searched with the label. */
  detail?: string;
  group: string;
  icon: React.ReactNode;
  /** The keyboard shortcut, shown so the menu teaches it. */
  kbd?: string;
  /** Something already on the site, listed under On the site. */
  onSite?: boolean;
  /** Where it is: the page (or header or footer), then the section and field, on a line of their own under the label. */
  place?: Trail;
  /** The place leads and the label goes under it, for links, which are told apart by where they are, not where they go. */
  placeFirst?: boolean;
  /** The page open in the editor. */
  current?: boolean;
  /** How well it answers the search, when that is worked out where the result is made (see `strength`). */
  rank?: number;
  /** What Enter does, named in the footer and given to assistive technology when the label alone does not say it. */
  action?: string;
  /** Other words it is found by, so the label can stay short. */
  keywords?: string;
  /** Runs without closing the menu. */
  stay?: boolean;
  /** Puts something on the page (or the component or template being edited), where `action` says. */
  inserts?: boolean;
  /** What it adds ("Element", "Section"), shown beside it, so a component and an element of one name are told apart. */
  kind?: string;
  /** Why it cannot be inserted where things go now, worked out with the place (see insertLanding). */
  refused?: string;
  run: () => void;
}

/** A location: the page (or header or footer) gives way first, then the start of the section and field, so the field at
 *  its end stays readable. The address that tells same-title pages apart never gives way. */
interface Trail {
  head: string;
  address?: string;
  tail: string;
}

type Section = 'best' | 'site' | 'pages' | 'insert' | 'commands';
// Pages come before what is on them when both answer a search equally well: going to a page is what the menu is used for most.
const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'best', label: 'Best match' },
  { id: 'pages', label: 'Pages' },
  { id: 'site', label: 'On the site' },
  { id: 'insert', label: 'Insert' },
  { id: 'commands', label: 'Commands' }
];
const sectionOf = (c: Cmd): Section => (c.onSite ? 'site' : c.group === 'Page' ? 'pages' : c.group === 'Insert' ? 'insert' : 'commands');
/** What Enter does on this row, named in the footer: the command's own action, or what every row of its kind does. */
const enterVerb = (c: Cmd) =>
  c.action ?? (c.id === 'find:all' ? 'Open in Find and replace' : c.stay ? 'Show more' : c.onSite ? 'Show in editor' : c.id.startsWith('page:') ? 'Go to page' : c.id.startsWith('ins:') ? 'Insert' : c.label.replace(/…$/, ''));
/** With nothing typed, the menu opens on a few of each kind, so it shows everything it can do in one view. */
const REST_PAGES = 4;
const REST_INSERTS = 2;
/** A page row whose title and address cannot share one line without cutting the title: the address moves under it. */
const LONG_ROW = 58;
/** Far more than a brochure site lists; past it the menu says so rather than ending silently. */
const MAX_ROWS = 200;
/** The height of a group's heading, which stays in view above the rows while the list scrolls. */
const HEADING_H = 30;

/** What a row is called, without its verb or a closing ellipsis, as the search compares it. */
const nameOf = (c: Cmd) => (c.verb ? c.label.slice(c.verb.length) : c.label).replace(/…$/, '').toLowerCase();

/** How well a name answers the search: 0 it is the name, 1 the name starts with it, 1.5 its words start each of the
 *  name's words in order ("proj health" for Project health), 2 each word starts some word of the name, 3 it is only
 *  somewhere in it. */
function strength(name: string, typed: string): number {
  if (!typed) return 3;
  if (name === typed) return 0;
  if (name.startsWith(typed)) return 1;
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const parts = typed.split(/\s+/);
  if (parts.length === words.length && parts.every((w, i) => words[i].startsWith(w))) return 1.5;
  return parts.every((w) => words.some((x) => x.startsWith(w))) ? 2 : 3;
}

/** The label with the words of the search picked out. */
function Marked({ text, query }: { text: string; query: string }) {
  // A single letter is picked out only where it starts a word, so "p" does not light up every p on the row.
  const words = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((w) => (w.length === 1 ? '(?<![\\p{L}\\p{N}])' : '') + w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
  if (!words.length) return <>{text}</>;
  return <>{text.split(new RegExp(`(${words.join('|')})`, 'giu')).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}</>;
}

/**
 * Shows or hides the sidebar, as the sidebar shortcut does. Hidden from the menu, with the menu opened from inside the sidebar, focus has
 * nowhere left to return to: it goes to the hidden view's rail button, as the shortcut leaves it (see Editor). That waits
 * until the menu has handed focus back, so a place it could return to keeps it.
 */
function toggleSidebar() {
  const was = useStore.getState().leftTab;
  setState({ leftTab: was ? null : 'pages' });
  if (!was) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (!a || a === document.body) document.querySelector<HTMLElement>(`.rail [data-rail="${was}"]`)?.focus();
    })
  );
}

function TrailText({ trail, query, className }: { trail: Trail; query: string; className: string }) {
  return (
    <span className={className} title={`${trail.head}${trail.address ? ` (${trail.address})` : ''}${trail.tail}`}>
      <span className="cmdk-trail-head"><Marked text={trail.head} query={query} /></span>
      {trail.address && (
        <span className="cmdk-trail-address" dir="rtl">
          <bdi>
            {' ('}
            <Marked text={trail.address} query={query} />)
          </bdi>
        </span>
      )}
      {/* A tail too long for the row gives up its start, so the field at its end stays readable; its separator never goes. */}
      {trail.tail && <span className="cmdk-trail-sep" aria-hidden="true">{' › '}</span>}
      {trail.tail && <span className="cmdk-trail-tail" dir="rtl"><bdi><Marked text={trail.tail.replace(/^ › /, '')} query={query} /></bdi></span>}
    </span>
  );
}

export function CommandMenu() {
  const snap = useStore((s) => s.snapshot);
  const pageId = useStore((s) => s.pageId);
  const mode = useStore((s) => s.mode);
  const dockOpen = useStore((s) => s.dockOpen);
  const leftTab = useStore((s) => s.leftTab);
  const dev = useStore((s) => !!s.settings?.developerMode);
  // Where an insert lands follows the selection and what is being edited (see currentOwner).
  const selection = useStore((s) => s.selection);
  const definitionId = useStore((s) => s.definitionMode?.definitionId);
  const templateId = useStore((s) => s.templateMode?.collectionId);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [sectionLimit, setSectionLimit] = useState(6);
  // With nothing typed: whether the full page list and the full insert list have been opened up.
  const [allPages, setAllPages] = useState(false);
  const [allInserts, setAllInserts] = useState(false);
  const cmds = useMemo<Cmd[]>(() => {
    if (!snap) return [];
    const st = snap.state;
    const owner = currentOwner();
    return [
      ...pageChoices(st).map((p) => ({ id: `page:${p.id}`, verb: 'Go to ', label: `Go to ${p.title}`, detail: p.address, group: 'Page', icon: p.home ? <House /> : <FileText />, run: () => selectPage(p.id) })),
      // What the Insert panel offers, each saying where it would go (#174). Enter places it there again, as it is then.
      ...insertChoices(st, dev).map((e): Cmd => {
        const at = insertLanding(st, owner, selection, e.spec);
        return {
          id: e.id,
          verb: 'Insert ',
          label: `Insert ${e.name}`,
          kind: e.kind,
          keywords: e.keywords,
          group: 'Insert',
          icon: e.icon ? <LucideIcon name={e.icon} /> : e.kind === 'Code component' ? <Code /> : <Component />,
          inserts: true,
          ...('where' in at ? { action: `Insert ${at.where}` } : { refused: at.refused }),
          run: () => void insert(e.spec, e.name)
        };
      }),
      { id: 'newpage', label: 'Add page…', keywords: 'new create', action: 'Add a page', group: 'Page', icon: <Plus />, run: () => (setState({ leftTab: 'pages' }), setTimeout(() => window.dispatchEvent(new Event('builder-add-page')), 0)) },
      // Every component of the project's own, placed or not, opens in Component Studio (issue #367): its own copy of the
      // header or footer too, and code only in Developer mode, as Insert lists it.
      ...Object.values(st.components)
        .filter((d) => d.owner === 'project' && (dev || d.kind !== 'code'))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
        .map((d) => ({ id: `studio:${d.id}`, label: `Open ${d.name} in Component Studio`, keywords: 'component studio design variants edit everywhere', action: 'Open in Component Studio', group: 'Your components', icon: <SquareDashed />, run: () => void openComponentStudio(d.id) })),
      { id: 'newcomponent', label: 'Create component…', keywords: 'new component reusable design build ai', action: 'Start a new component, blank or built by AI', group: 'Insert', icon: <Component />, run: () => setState({ modal: { kind: 'new-component' } }) },
      { id: 'ai', kbd: '⌘J', label: 'Ask AI…', action: 'Open the AI chat', group: 'AI', icon: <Sparkles />, run: () => askAiAbout(null) },
      { id: 'styles', label: 'Site styles', keywords: 'colors colours fonts typography spacing theme', action: 'Open site styles', group: 'View', icon: <Palette />, run: () => openSiteStyles() },
      { id: 'brief', label: 'Project brief', keywords: 'description notes client audience goals private', action: 'Open the Project tab', group: 'Project', icon: <NotebookPen />, run: () => setState({ rightTab: 'project', dockOpen: true }) },
      { id: 'find', kbd: '⇧⌘F', label: 'Find and replace…', keywords: 'search words site content', action: 'Open Find and replace', group: 'Edit', icon: <Replace />, run: () => setState({ modal: { kind: 'find' } }) },
      { id: 'copy', kbd: platformKeys('⌘C'), label: 'Copy the selected section or element', group: 'Edit', icon: <ClipboardCopy />, run: () => void copySelection() },
      { id: 'paste', kbd: platformKeys('⌘V'), label: 'Paste the copied section or element', group: 'Edit', icon: <ClipboardPaste />, run: () => void pasteFromMenu() },
      { id: 'undo', kbd: '⌘Z', label: 'Undo', group: 'Edit', icon: <Undo2 />, run: () => projectHistory('undo') },
      { id: 'redo', kbd: '⇧⌘Z', label: 'Redo', group: 'Edit', icon: <Redo2 />, run: () => projectHistory('redo') },
      { id: 'newproject', kbd: '⇧⌘N', label: 'New project…', action: 'Start a new project', group: 'Project', icon: <Plus />, run: () => sendCommand('new-project') },
      { id: 'openproject', kbd: '⌘O', label: 'Open project…', action: 'Choose a project to open', group: 'Project', icon: <FolderOpen />, run: () => sendCommand('open-project') },
      { id: 'preview', label: mode === 'edit' ? 'Switch to preview' : 'Switch to editing', keywords: 'edit preview mode', action: undefined, group: 'View', icon: <Eye />, run: () => setMode(useStore.getState().mode === 'edit' ? 'preview' : 'edit') },
      { id: 'desktop', label: 'Preview at desktop width', group: 'View', icon: <Monitor />, run: () => setViewport(VIEWPORT_PRESETS.desktop) },
      { id: 'tablet', label: 'Preview at tablet width', group: 'View', icon: <Tablet />, run: () => setViewport(VIEWPORT_PRESETS.tablet) },
      { id: 'phone', label: 'Preview at phone width', group: 'View', icon: <Smartphone />, run: () => setViewport(VIEWPORT_PRESETS.phone) },
      { id: 'export', kbd: '⌘E', label: 'Export or publish your website…', action: 'Open Export', group: 'Project', icon: <Upload />, run: () => setState({ modal: { kind: 'export' } }) },
      { id: 'settings', label: 'Settings…', action: 'Open Settings', group: 'Project', icon: <Settings />, run: () => setState({ modal: { kind: 'settings' } }) },
      { id: 'history', label: 'History…', action: 'Open History', group: 'Project', icon: <History />, run: () => setState({ modal: { kind: 'history' } }) },
      { id: 'save-version', label: 'Save a version of the site…', action: 'Open Versions', group: 'Project', icon: <BookmarkPlus />, run: () => setState({ modal: { kind: 'history', tab: 'versions' } }) },
      { id: 'health', label: 'Project health…', action: 'Open Project health', group: 'Project', icon: <Stethoscope />, run: () => setState({ modal: { kind: 'health' } }) },
      { id: 'outline', label: 'Show the page outline', keywords: 'headings', action: 'Show the outline', group: 'View', icon: <ListTree />, run: () => openOutline() },
      // The sidebar's views, as the rail opens them.
      ...LEFT_TABS.map((t) => ({ id: `panel:${t.id}`, label: `Show the ${t.label} panel`, keywords: 'left sidebar panel view', group: 'View', icon: t.icon, run: () => setState({ leftTab: t.id }) })),
      // Found by what it will do now, so "hide the sidebar" never offers to show it.
      { id: 'sidebar', kbd: '⌘\\', label: leftTab ? 'Hide the sidebar' : 'Show the sidebar', keywords: leftTab ? 'hide close left sidebar panels' : 'show open left sidebar panels', group: 'View', icon: <PanelLeft />, run: toggleSidebar },
      { id: 'dock', kbd: '⇧⌘\\', label: dockOpen ? 'Hide the right panel' : 'Show the right panel', keywords: 'show hide right panel inspector', group: 'View', icon: <PanelRight />, run: () => setState({ dockOpen: !useStore.getState().dockOpen }) },
      { id: 'close', kbd: '⇧⌘W', label: 'Close project', group: 'Project', icon: <LogOut />, run: () => void closeProject() }
    ];
  }, [snap, mode, dockOpen, leftTab, dev, selection, pageId, definitionId, templateId]);
  // What is already on the site comes before what can be added: the sections placed on each page, and a few of the
  // words and destinations the search finds (the full list is in Find and replace).
  const sections = useMemo(() => (snap ? placedSections(snap.state) : []), [snap]);
  const fields = useMemo(() => (snap ? contentFields(snap.state) : []), [snap]);
  // Pages that share a title, by id, with the address that tells them apart.
  const clashing = useMemo(() => {
    const pages = snap ? pageChoices(snap.state) : [];
    return new Map(pages.filter((p) => pages.some((o) => o.id !== p.id && o.title === p.title)).map((p) => [p.id, p.address]));
  }, [snap]);
  const found = useMemo<Cmd[]>(() => {
    const t = q.trim();
    if (!snap || !t) return [];
    const trail = (owner: { kind: string; id: string }, where: string, rest = ''): Trail => {
      return { head: where, address: owner.kind === 'page' ? clashing.get(owner.id) : undefined, tail: rest };
    };
    const lower = t.toLowerCase();
    const whereOf = (x: (typeof sections)[number]) => (x.ref.owner.kind === 'page' ? (snap.state.pages[x.ref.owner.id]?.title ?? '') : x.ref.owner.id === 'header' ? 'Header' : 'Footer');
    // A section named for the search comes before one that only sits on a page of that name.
    const matching = sections
      .filter((x) => sectionMatches(x, t))
      .map((x) => {
        const where = whereOf(x);
        const name = x.label.slice(0, x.label.length - where.length - 3);
        return { x, where, name, rank: strength(name.toLowerCase(), lower) };
      })
      .sort((a, b) => a.rank - b.rank);
    // A fold that would hide one section shows it instead.
    const placed = matching
      .slice(0, matching.length <= sectionLimit + 1 ? matching.length : sectionLimit)
      .map(({ x, where, name, rank }, i) => {
        const owner = x.ref.owner;
        return {
          id: `sec:${i}:${x.label}`,
          label: name,
          place: trail(owner, where),
          // Sections that share a name ("Page introduction" on every page) are told apart by their page, so it leads.
          placeFirst: matching.filter((o) => o.name === name).length > 1,
          rank,
          onSite: true,
          group: 'On the site',
          icon: <Component />,
          run: () => {
            const st = useStore.getState();
            // The header or footer shows on the current page when it has it; else on the first page that does.
            const now = st.snapshot?.state ?? snap.state;
            const pageId = x.pageId ?? (x.ref.owner.kind === 'shell' ? pageShowing(now, x.ref.owner.id, st.pageId) : undefined) ?? null;
            if (!pageId) return toast(`No page shows ${partName(x.ref.owner.id)}.`, 'info');
            if (pageOutOfSight(st, pageId)) selectPage(pageId);
            setState({ mode: 'edit', selection: x.ref, rightTab: 'inspect', dockOpen: true });
          }
        };
      });
    const more = matching.length - placed.length;
    // Names what the next press reveals, not everything left (a single section left over is revealed with the rest).
    const next = more <= 25 ? more : 24;
    const showMore: Cmd[] = more > 0 ? [{ id: 'sec:more', label: `Show ${next} more ${next === 1 ? 'section' : 'sections'}`, onSite: true, stay: true, rank: 3, group: 'On the site', icon: <ChevronDown />, run: () => setSectionLimit((n) => n + 24) }] : [];
    // One preview per field: five hits in one paragraph would otherwise take every row and all open the same place.
    const seen = new Set<string>();
    const all = t.length < 2 ? [] : findContent(snap.state, t, { limit: 400 }, fields);
    const hits = all.filter((m) => (seen.has(m.field.key) ? false : (seen.add(m.field.key), true)));
    const words = hits.slice(0, 5).map((m) => {
      // Keeps the match near the start of the row, so a long run of words before it cannot push it out of view.
      const lead = m.before.length > 30 ? `…${m.before.slice(-28).replace(/^\S*\s+/, '')}` : m.before;
      const snippet = `${lead}${m.match}${m.after}`.slice(0, 90);
      const link = m.kind === 'link';
      return {
        id: `find:${m.id}`,
        label: link ? `Links to ${snippet}` : snippet,
        place: trail(m.field.owner, m.field.where, [m.field.section, m.field.label].filter((part, i, all) => part !== (i ? all[i - 1] : m.field.where)).map((part) => ` › ${part}`).join('')),
        placeFirst: link,
        rank: 3,
        onSite: true,
        group: m.field.where,
        icon: m.kind === 'link' ? <Link2 /> : <TextSearch />,
        run: () => openContentMatch(m.field)
      };
    });
    // A search that looked through the content and found nothing has nothing more to show in Find and replace. The row
    // says whether Find and replace has more than these previews, or the same matches with room to change them.
    const fewer = all.length > words.length || t.length < 2;
    const searchAll: Cmd[] = words.length || t.length < 2 ? [{ id: 'find:all', label: fewer ? `Search all site content for “${t}”` : `Open “${t}” in Find and replace`, onSite: true, rank: 4, group: 'Edit', icon: <Search />, run: () => setState({ modal: { kind: 'find', query: t } }) }] : [];
    return [...placed, ...showMore, ...words, ...searchAll];
  }, [snap, q, sections, fields, clashing, sectionLimit]);
  const typed = q.trim().toLowerCase();
  const history = snap?.history;
  // Copy and Paste act on the page being edited (Paste also inside a component edited everywhere), from what is
  // selected there and what was copied.
  const editing = useStore((s) => s.mode === 'edit');
  const copyable = useStore((s) => s.mode === 'edit' && !s.definitionMode && planLayers(s)?.group.owner.kind === 'page');
  const pasteable = useStore((s) => !!copiedHere(s));
  // The page under the post writer, or behind a post's preview, is out of sight: nothing is copied from it, pasted into
  // it or inserted on it (#578).
  const posting = useStore(postWorkspace);
  const readOnly = !!snap?.readOnly;
  const unavailable = (c: Cmd) => {
    if (c.id === 'undo') return history?.canUndo ? undefined : 'Nothing to undo';
    if (c.id === 'redo') return history?.canRedo ? undefined : 'Nothing to redo';
    if (posting && (c.id === 'copy' || c.id === 'paste' || c.inserts)) return posting === 'write' ? 'Not while writing a post' : 'Not while previewing a post';
    if (c.inserts) return readOnly ? 'Read-only' : c.refused;
    if (c.id === `panel:${leftTab}`) return 'Already open';
    if (c.id === 'copy') return !editing ? 'Edit mode only' : copyable ? undefined : 'Nothing to copy';
    if (c.id === 'paste') return !editing ? 'Edit mode only' : !pasteable ? 'Nothing copied' : readOnly ? 'Read-only' : undefined;
    return undefined;
  };
  // A page answers by its title, its whole label, or the last part of its address ("faq" is the page at /faq/). A
  // command that cannot run now never outranks one that can.
  const rankOf = (c: Cmd) => {
    if (c.rank !== undefined) return c.rank;
    if (unavailable(c)) return 4;
    const own = strength(nameOf(c), typed);
    if (!c.id.startsWith('page:')) return own;
    return Math.min(titleRank(c), lastRank(c));
  };
  const titleRank = (c: Cmd) => Math.min(strength(nameOf(c), typed), strength(c.label.toLowerCase(), typed));
  // Same-title pages tie on their title; the one whose address ends in the search goes first ("portfolio" → /portfolio/).
  const lastRank = (c: Cmd) => {
    const last = c.id.startsWith('page:') ? (c.detail ?? '').split('/').filter(Boolean).pop()?.replace(/-/g, ' ').toLowerCase() : undefined;
    return last ? strength(last, typed) : 3;
  };
  const searched = exactDetailFirst(cmds.filter((c) => matchesWords(q, `${commandText(c.label, c.detail)} ${c.keywords ?? ''}`)), q);
  // With nothing typed, a few pages (not the one already open) and a few things to insert, each with a row that opens
  // up the rest in place, so the commands are in view too. The opened rows take the "Show more" row's place, so the
  // highlight lands on the first of them.
  const restRows = (items: Cmd[], limit: number, open: boolean, more: (n: number) => Cmd): Cmd[] => (open || items.length <= limit + 1 ? items : [...items.slice(0, limit), more(items.length - limit)]);
  const matched = typed
    ? searched
    : [
        ...restRows(searched.filter((c) => c.id.startsWith('page:') && c.id !== `page:${pageId}`), REST_PAGES, allPages, (n) => ({ id: 'page:more', label: `Show ${n} more ${n === 1 ? 'page' : 'pages'}`, group: 'Page', stay: true, icon: <ChevronDown />, run: () => setAllPages(true) })),
        ...searched.filter((c) => c.group === 'Page' && !c.id.startsWith('page:')),
        ...restRows(searched.filter((c) => c.group === 'Insert'), REST_INSERTS, allInserts, (n) => ({ id: 'ins:more', label: `Show ${n} more to insert`, group: 'Insert', stay: true, icon: <ChevronDown />, run: () => setAllInserts(true) })),
        // Opening a component in Component Studio is found by its name: one row per component would bury the commands.
        ...searched.filter((c) => c.group !== 'Page' && c.group !== 'Insert' && !c.id.startsWith('studio:'))
      ];
  // An address typed exactly finds just that page. Otherwise a command named exactly, that can run now, comes first.
  // Pages never leave Pages, so "Go to Portfolio" typed in full still lists both Portfolio pages there.
  const exactPage = matched.filter((c) => !!c.detail && c.detail.toLowerCase() === typed);
  const exactName = matched.filter((c) => !exactPage.includes(c) && !c.id.startsWith('page:') && !unavailable(c) && c.label.replace(/…$/, '').toLowerCase() === typed);
  // Too short a search to look through the content: the way to search it never sits ahead of a command that matched.
  const onSite = found.filter((c) => c.id !== 'find:all' || found.length > 1 || !matched.length);
  const ranked = exactPage.length ? exactPage : [...exactName, ...onSite, ...matched.filter((c) => !exactName.includes(c))];
  // Past the row cap, the weakest answers are the ones left out, wherever they would have been listed.
  const kept = ranked.length <= MAX_ROWS ? ranked : new Set(ranked.map((c, i) => ({ c, i, r: exactName.includes(c) ? -1 : rankOf(c) })).sort((a, b) => a.r - b.r || a.i - b.i).slice(0, MAX_ROWS).map((x) => x.c));
  const shown = Array.isArray(kept) ? kept : ranked.filter((c) => kept.has(c));
  // Groups keep their order unless one answers the search more closely than those above it: "contact" leads with the
  // Contact page, "project" with the project commands, ahead of words that merely contain them. Rows within a group
  // follow the same measure, so the closest answer is the first row and Enter runs it.
  const canonical = SECTIONS.flatMap((s) => {
    const items = shown.filter((c) => (exactName.includes(c) ? 'best' : sectionOf(c)) === s.id);
    if (!items.length) return [];
    // Within Pages: a page named for the search before one whose address only ends in it, same-title pages by their
    // address, and Add page… after the pages unless the search names it.
    const sorted =
      typed && s.id !== 'site' && s.id !== 'best'
        ? items
            .map((c, i) => ({ c, i, r: rankOf(c), t: titleRank(c), a: lastRank(c), x: !c.id.startsWith('page:') && rankOf(c) > 1.5 ? 1 : 0 }))
            .sort((a, b) => (s.id === 'pages' ? a.x - b.x : 0) || a.r - b.r || a.t - b.t || a.a - b.a || a.i - b.i)
            .map((x) => x.c)
        : items;
    return [{ ...s, items: sorted, lead: s.id === 'best' ? -1 : typed ? Math.min(...items.map(rankOf)) : 0 }];
  });
  // Only the group with the closest answer moves up; the rest keep their settled order.
  const rest = canonical.filter((g) => g.id !== 'best');
  const winner = rest.reduce<(typeof rest)[number] | undefined>((w, g) => (!w || g.lead < w.lead ? g : w), undefined);
  const groups = [...canonical.filter((g) => g.id === 'best'), ...(winner ? [winner] : []), ...rest.filter((g) => g !== winner)];
  const shownCount = shown.length;
  // The keyboard walks the rows in the order they are shown, group by group.
  const filtered = groups.flatMap((g) => g.items);
  const noMatches = !!typed && filtered.every((c) => c.id === 'find:all');
  // One character is too few to look through the words on the site, which is not the same as finding nothing: the
  // menu says so whenever it skipped them.
  const short = typed.length === 1;
  const tooShort = noMatches && short;
  const note = 'Type another character to include the words on your pages.';
  const advice = /\s/.test(typed) ? 'Try fewer words or check the spelling.' : 'Check the spelling or try another word.';
  const cur = Math.min(active, filtered.length - 1);
  const pick = (c: Cmd | undefined) => {
    if (!c || unavailable(c)) return;
    if (!c.stay && useStore.getState().modal?.kind === 'cmdk') setState({ modal: null });
    // What a Show more row opens takes its place; the list follows the highlight in case the row there is taller.
    if (c.stay) follow.current = true;
    c.run();
  };
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Set when the keyboard or the search moved the highlight, the only moves that scroll the list to it.
  const follow = useRef(false);
  const listId = useId();
  // Tied to the result, so a screen reader hears the change when a different result takes a row's place.
  const optionId = (c: Cmd) => `${listId}-${c.id.replace(/[^\w-]/g, (ch) => `_${ch.charCodeAt(0).toString(16)}`)}`;
  const onDialogKey = useDialogFocus(ref, () => setState({ modal: null }));
  const search = (value: string) => {
    setQ(value);
    setSectionLimit(6);
    moveTo(0);
  };
  const moveTo = (i: number) => {
    follow.current = true;
    setActive(i);
  };
  useEffect(() => {
    if (!follow.current) return;
    follow.current = false;
    const list = listRef.current;
    if (!list) return;
    if (cur <= 0) list.scrollTop = 0;
    else list.querySelector(`[data-index="${cur}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cur, q, allPages, allInserts, sectionLimit]);
  // A list that changes height (the window resized) brings the highlighted row back into view.
  const curRef = useRef(cur);
  curRef.current = cur;
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => list.querySelector(`[data-index="${curRef.current}"]`)?.scrollIntoView({ block: 'nearest' }));
    watch.observe(list);
    return () => watch.disconnect();
  }, []);
  // Scrolled by wheel or scrollbar: the highlight stays on a row in view, so Enter never runs one the user cannot see.
  const keepActiveInView = () => {
    const list = listRef.current;
    if (!list) return;
    const box = list.getBoundingClientRect();
    // Below the heading and the fade a stuck heading draws under itself.
    const top = box.top + HEADING_H + (list.scrollTop > 0 ? 5 : 0);
    const rows = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
    const row = rows[cur]?.getBoundingClientRect();
    if (!row || (row.top >= top && row.bottom <= box.bottom + 1)) return;
    const inView = rows.flatMap((el, i) => {
      const b = el.getBoundingClientRect();
      return b.top >= top && b.bottom <= box.bottom + 1 ? [i] : [];
    });
    if (inView.length) setActive(row.top < top ? inView[0] : inView[inView.length - 1]);
  };
  // Announced once typing pauses, not on every keystroke.
  const hits = filtered.filter((c) => c.id !== 'find:all' && !c.stay).length;
  const capped = ranked.length > shownCount ? ` Showing the first ${shownCount}.` : '';
  const status = tooShort ? note : noMatches ? `No matches. ${advice}` : typed ? `${hits} ${hits === 1 ? 'result' : 'results'}.${capped}${short ? ` ${note}` : ''}` : `${hits} ${hits === 1 ? 'item' : 'items'}.`;
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setAnnounced(status), 450);
    return () => clearTimeout(t);
  }, [status, q]);
  const activeCmd = filtered[cur];
  const actionOf = enterVerb;
  let index = -1;
  return createPortal(
    <div className="overlay-backdrop light" onMouseDown={(e) => e.target === e.currentTarget && setState({ modal: null })}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command menu" ref={ref} onKeyDown={onDialogKey}>
        <div className="cmdk-search">
          <Search />
          <input
            autoFocus
            role="combobox"
            aria-label="Search pages, sections, content and commands"
            aria-expanded={filtered.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeCmd ? optionId(activeCmd) : undefined}
            placeholder="Search pages, sections, content and commands"
            value={q}
            onChange={(e) => search(e.target.value)}
            onKeyDown={(e) => {
              // Keys that belong to an input method's candidate list while it is composing.
              if (e.nativeEvent.isComposing) return;
              // Modified arrows and Home/End move the caret or select text in the field, as they do anywhere else.
              if ((e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) && e.key !== 'Enter') return;
              if (e.key === 'ArrowDown') (e.preventDefault(), moveTo(Math.min(filtered.length - 1, cur + 1)));
              if (e.key === 'ArrowUp') (e.preventDefault(), moveTo(Math.max(0, cur - 1)));
              if (e.key === 'Home' && !q) (e.preventDefault(), moveTo(0));
              if (e.key === 'End' && !q) (e.preventDefault(), moveTo(filtered.length - 1));
              if (e.key === 'Enter') pick(activeCmd);
            }}
          />
          {/* For the pointer, as in the Insert panel; the keyboard clears with ⌘A and Delete, since Esc closes the menu. */}
          {q && (
            <button className="icon-btn sm cmdk-clear" tabIndex={-1} aria-label="Clear search" title="Clear search" onMouseDown={(e) => e.preventDefault()} onClick={() => search('')}>
              <X />
            </button>
          )}
        </div>
        {tooShort ? (
          <div className="cmdk-note">{note}</div>
        ) : (
          noMatches && (
            <div className="cmdk-empty">
              <SearchX />
              <div>
                <strong>
                  No matches for “<span className="cmdk-empty-query">{q.trim()}</span>”
                </strong>
                <span>{advice}</span>
              </div>
            </div>
          )
        )}
        <div className="cmdk-list" role="listbox" id={listId} aria-label="Results" ref={listRef} onScroll={keepActiveInView}>
          {groups.map((g) => (
            <div key={g.id} role="group" aria-labelledby={`${listId}-${g.id}`}>
              <div id={`${listId}-${g.id}`} role="presentation" className={noMatches ? 'sr-only' : 'cmdk-group-label'}>
                <span>{noMatches ? 'Search' : g.label}</span>
              </div>
              {g.items.map((c) => {
                const i = ++index;
                const reason = unavailable(c);
                const current = c.id === `page:${pageId}`;
                // A long title takes the whole first line and its address goes under it, so neither is cut short twice.
                const stacked = !!c.detail && c.label.length - (c.verb?.length ?? 0) + c.detail.length > LONG_ROW;
                const address = c.detail && (
                  <span className={stacked ? 'cmdk-place cmdk-address' : 'hint cmdk-address'} dir="rtl" title={c.detail}>
                    <bdi><Marked text={c.detail} query={q} /></bdi>
                  </span>
                );
                // Rows that belong to the menu itself (Show more, the content search) have no matched words to show.
                const label = (
                  <span className="cmdk-label">
                    {c.verb && <span className="sr-only">{c.verb}</span>}
                    {c.stay ? c.label : c.id === 'find:all' ? (
                      <>
                        {c.label.slice(0, c.label.indexOf('“') + 1)}
                        <mark>{q.trim()}</mark>
                        {c.label.slice(c.label.lastIndexOf('”'))}
                      </>
                    ) : (
                      <Marked text={c.verb ? c.label.slice(c.verb.length) : c.label} query={q} />
                    )}
                  </span>
                );
                return (
                  <div
                    key={c.id}
                    id={optionId(c)}
                    data-index={i}
                    role="option"
                    aria-selected={i === cur}
                    aria-disabled={reason ? true : undefined}
                    // The footer is hidden from assistive technology, so what it says about Enter is said here when the label does not.
                    aria-description={c.id === 'find:all' ? (c.label.includes('Find and replace') ? undefined : 'Opens Find and replace') : c.onSite && !c.stay ? 'Show in editor' : current ? 'Current page' : !reason && c.action && c.action !== c.label.replace(/…$/, '') ? c.action : undefined}
                    className={`menu-item${i === cur ? ' focused' : ''}${c.place || stacked ? ' cmdk-two' : ''}${c.stay ? ' cmdk-more-row' : ''}`}
                    // Only a pointer that really moved takes the highlight, not a list scrolling under a still one. A row
                    // it lands on is brought fully into view, so Enter never runs one that is half hidden.
                    onPointerMove={(e) => {
                      if ((e.movementX || e.movementY) && i !== cur) moveTo(i);
                    }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(c)}
                  >
                    {c.icon}
                    <span className="grow">
                      {c.place && c.placeFirst ? (
                        <>
                          <TrailText trail={c.place} query={q} className="cmdk-label cmdk-trail" />
                          <span className="cmdk-place">{label}</span>
                        </>
                      ) : (
                        <>
                          {label}
                          {c.place && <TrailText trail={c.place} query={q} className="cmdk-place" />}
                          {stacked && address}
                        </>
                      )}
                    </span>
                    {!stacked && address}
                    {/* Drawn, not written: the option's text stays "Go to {title} {address}" and the description says it. */}
                    {current && <span className="hint cmdk-current" aria-hidden="true" />}
                    {reason ? <span className="hint">{reason}</span> : c.kbd ? <kbd className="kbd">{platformKeys(c.kbd)}</kbd> : c.kind && <span className="hint">{c.kind}</span>}
                  </div>
                );
              })}
            </div>
          ))}
          {ranked.length > shownCount && <div className="cmdk-more" role="presentation">Showing the first {shownCount}. Keep typing to narrow the list.</div>}

        </div>
        {/* Pinned over the footer, so it is in view however long the list is and the first row does not move while the
            search grows from one character to two. */}
        {short && !tooShort && <div className="cmdk-hint">{note}</div>}
        <div className="sr-only" role="status">{announced}</div>
        <div className="cmdk-foot" aria-hidden="true">
          {activeCmd && !unavailable(activeCmd) && (
            <span className="cmdk-foot-enter">
              <kbd className="kbd">{platformKeys('↵')}</kbd>
              {/* A long place gives way before the keys beside it; the whole of it shows on hover. */}
              <span className="cmdk-foot-action" title={actionOf(activeCmd)}>{actionOf(activeCmd)}</span>
            </span>
          )}
          <span className="cmdk-foot-keys">
            {filtered.length > 1 && (
              <span>
                <kbd className="kbd">↑</kbd>
                <kbd className="kbd">↓</kbd>
                Move
              </span>
            )}
            <span>
              <kbd className="kbd">esc</kbd>
              Close
            </span>
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}
