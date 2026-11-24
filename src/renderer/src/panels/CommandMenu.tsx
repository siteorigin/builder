import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookmarkPlus, Component, FileText, FolderOpen, History, Link2, Plus, Redo2, Replace, Search, TextSearch, Undo2, Settings, Sparkles, Upload, Palette, Eye, LogOut, Monitor, PanelRight, Smartphone, Stethoscope, Tablet, House, ListTree } from 'lucide-react';
import { useDialogFocus, sendCommand } from '../components/ui';
import { closeProject } from '../lib/leave';
import { catalogueEntries } from '@catalogue/index';
import { api, setState, toast, useStore } from '../store';
import { pageShowing, partName } from '@shared/page-shell';
import { insert, selectPage, askAiAbout, setMode, openSiteStyles, openOutline } from '../lib/actions';
import { pageChoices, matchesWords, commandText, exactDetailFirst } from '../lib/page-switch';
import { VIEWPORT_PRESETS } from '@shared/styles';
import { LucideIcon } from './InsertPanel';
import { openContentMatch } from './FindReplace';
import { contentFields, findContent, placedSections, sectionMatches } from '../lib/find-content';

interface Cmd {
  id: string;
  label: string;
  /** What tells entries with the same label apart, such as a page's address. Shown, spoken and searched with the label. */
  detail?: string;
  group: string;
  icon: React.ReactNode;
  /** The keyboard shortcut, shown so the menu teaches it. */
  kbd?: string;
  /** Something already on the site, listed under On the site. */
  onSite?: boolean;
  /** The page, or the header or footer, a section is placed on. */
  where?: Trail;
  /** Where words or a link are: page, section and field, on a line of their own so the match keeps the row's width. */
  place?: Trail;
  /** Runs without closing the menu. */
  stay?: boolean;
  run: () => void;
}

/** A location whose start gives way first when it is too long, so the address or field at its end stays readable. */
interface Trail {
  head: string;
  tail: string;
}

type Section = 'best' | 'site' | 'pages' | 'insert' | 'commands';
const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'best', label: 'Best match' },
  { id: 'site', label: 'On the site' },
  { id: 'pages', label: 'Pages' },
  { id: 'insert', label: 'Insert' },
  { id: 'commands', label: 'Commands' }
];
const sectionOf = (c: Cmd): Section => (c.onSite ? 'site' : c.group === 'Page' ? 'pages' : c.group === 'Insert' ? 'insert' : 'commands');
/** Commands that open a panel or dialog without saying so in their label. */
const OPENS = new Set(['styles', 'outline']);
/** What Enter does on this row, named in the footer. */
const enterVerb = (c: Cmd) => (c.id === 'find:all' ? 'Search' : c.stay ? 'Show more' : c.onSite ? 'Show in editor' : c.id.startsWith('page:') ? 'Go to page' : c.id.startsWith('ins:') ? 'Insert' : c.label.endsWith('…') || OPENS.has(c.id) ? 'Open' : 'Run');
/** Far more than a brochure site lists; past it the menu says so rather than ending silently. */
const MAX_ROWS = 200;
/** The height of a group's heading, which stays in view above the rows while the list scrolls. */
const HEADING_H = 28;

/** The label with the words of the search picked out. */
function Marked({ text, query }: { text: string; query: string }) {
  const words = query.trim().split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return <>{text}</>;
  return <>{text.split(new RegExp(`(${words.join('|')})`, 'gi')).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}</>;
}

function TrailText({ trail, query, className }: { trail: Trail; query: string; className: string }) {
  return (
    <span className={className} title={`${trail.head}${trail.tail}`}>
      <span className="cmdk-trail-head"><Marked text={trail.head} query={query} /></span>
      {trail.tail && <span className="cmdk-trail-tail"><Marked text={trail.tail} query={query} /></span>}
    </span>
  );
}

export function CommandMenu() {
  const snap = useStore((s) => s.snapshot);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [sectionLimit, setSectionLimit] = useState(6);
  const cmds = useMemo<Cmd[]>(() => {
    if (!snap) return [];
    const st = snap.state;
    return [
      ...pageChoices(st).map((p) => ({ id: `page:${p.id}`, label: `Go to ${p.title}`, detail: p.address, group: 'Page', icon: p.home ? <House /> : <FileText />, run: () => selectPage(p.id) })),
      ...catalogueEntries(st.site.themeId).map((e) => ({ id: `ins:${e.componentId}`, label: `Insert ${e.name}`, group: 'Insert', icon: <LucideIcon name={e.icon} />, run: () => void insert({ componentId: e.componentId }, e.name) })),
      { id: 'newpage', label: 'Add page…', group: 'Page', icon: <Plus />, run: () => (setState({ leftTab: 'pages' }), setTimeout(() => window.dispatchEvent(new Event('builder-add-page')), 0)) },
      { id: 'ai', kbd: '⌘J', label: 'Ask AI…', group: 'AI', icon: <Sparkles />, run: () => askAiAbout(null) },
      { id: 'styles', label: 'Open site styles: colors, fonts and spacing', group: 'View', icon: <Palette />, run: () => openSiteStyles() },
      { id: 'find', kbd: '⇧⌘F', label: 'Find and replace in site content…', group: 'Edit', icon: <Replace />, run: () => setState({ modal: { kind: 'find' } }) },
      { id: 'undo', kbd: '⌘Z', label: 'Undo', group: 'Edit', icon: <Undo2 />, run: () => void api.project.undo() },
      { id: 'redo', kbd: '⇧⌘Z', label: 'Redo', group: 'Edit', icon: <Redo2 />, run: () => void api.project.redo() },
      { id: 'newproject', kbd: '⇧⌘N', label: 'New project…', group: 'Project', icon: <Plus />, run: () => sendCommand('new-project') },
      { id: 'openproject', kbd: '⌘O', label: 'Open project…', group: 'Project', icon: <FolderOpen />, run: () => sendCommand('open-project') },
      { id: 'preview', label: 'Switch between edit and preview', group: 'View', icon: <Eye />, run: () => setMode(useStore.getState().mode === 'edit' ? 'preview' : 'edit') },
      { id: 'desktop', label: 'Preview at desktop width', group: 'View', icon: <Monitor />, run: () => setState({ viewport: VIEWPORT_PRESETS.desktop }) },
      { id: 'tablet', label: 'Preview at tablet width', group: 'View', icon: <Tablet />, run: () => setState({ viewport: VIEWPORT_PRESETS.tablet }) },
      { id: 'phone', label: 'Preview at phone width', group: 'View', icon: <Smartphone />, run: () => setState({ viewport: VIEWPORT_PRESETS.phone }) },
      { id: 'export', kbd: '⌘E', label: 'Export or publish your website…', group: 'Project', icon: <Upload />, run: () => setState({ modal: { kind: 'export' } }) },
      { id: 'settings', label: 'Settings…', group: 'Project', icon: <Settings />, run: () => setState({ modal: { kind: 'settings' } }) },
      { id: 'history', label: 'History…', group: 'Project', icon: <History />, run: () => setState({ modal: { kind: 'history' } }) },
      { id: 'save-version', label: 'Save a version of the site…', group: 'Project', icon: <BookmarkPlus />, run: () => setState({ modal: { kind: 'history', tab: 'versions' } }) },
      { id: 'health', label: 'Project health…', group: 'Project', icon: <Stethoscope />, run: () => setState({ modal: { kind: 'health' } }) },
      { id: 'outline', label: 'Show the page’s headings outline', group: 'View', icon: <ListTree />, run: () => openOutline() },
      { id: 'dock', kbd: '⇧⌘\\', label: 'Show or hide the right panel', group: 'View', icon: <PanelRight />, run: () => setState({ dockOpen: !useStore.getState().dockOpen }) },
      { id: 'close', kbd: '⇧⌘W', label: 'Close project', group: 'Project', icon: <LogOut />, run: () => void closeProject() }
    ];
  }, [snap]);
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
      const address = owner.kind === 'page' ? clashing.get(owner.id) : undefined;
      return { head: where, tail: `${address ? ` (${address})` : ''}${rest}` };
    };
    const matching = sections.filter((x) => sectionMatches(x, t));
    const placed = matching
      .slice(0, sectionLimit)
      .map((x, i) => {
        const owner = x.ref.owner;
        const where = owner.kind === 'page' ? (snap.state.pages[owner.id]?.title ?? '') : owner.id === 'header' ? 'Header' : 'Footer';
        return {
          id: `sec:${i}:${x.label}`,
          label: x.label.slice(0, x.label.length - where.length - 3),
          where: trail(owner, where),
          onSite: true,
          group: 'On the site',
          icon: <Component />,
          run: () => {
            const st = useStore.getState();
            // The header or footer shows on the current page when it has it; else on the first page that does.
            const now = st.snapshot?.state ?? snap.state;
            const pageId = x.pageId ?? (x.ref.owner.kind === 'shell' ? pageShowing(now, x.ref.owner.id, st.pageId) : undefined) ?? null;
            if (!pageId) return toast(`No page shows ${partName(x.ref.owner.id)}.`, 'info');
            if (pageId !== st.pageId || st.definitionMode) selectPage(pageId);
            setState({ mode: 'edit', selection: x.ref, rightTab: 'inspect', dockOpen: true });
          }
        };
      });
    const more = matching.length - placed.length;
    const showMore: Cmd[] = more > 0 ? [{ id: 'sec:more', label: `Show ${more} more ${more === 1 ? 'section' : 'sections'}`, onSite: true, stay: true, group: 'On the site', icon: <Plus />, run: () => setSectionLimit((n) => n + 24) }] : [];
    const words = t.length < 2 ? [] : findContent(snap.state, t, { limit: 5 }, fields).map((m) => {
      // Keeps the match near the start of the row, so a long run of words before it cannot push it out of view.
      const lead = m.before.length > 30 ? `…${m.before.slice(-28).replace(/^\S*\s+/, '')}` : m.before;
      return {
        id: `find:${m.id}`,
        label: `${lead}${m.match}${m.after}`.slice(0, 90),
        place: trail(m.field.owner, m.field.where, [m.field.section, m.field.label].filter((part, i, all) => part !== (i ? all[i - 1] : m.field.where)).map((part) => ` › ${part}`).join('')),
        onSite: true,
        group: m.field.where,
        icon: m.kind === 'link' ? <Link2 /> : <TextSearch />,
        run: () => openContentMatch(m.field)
      };
    });
    // A search that looked through the content and found nothing has nothing more to show in Find and replace.
    const searchAll: Cmd[] = words.length || t.length < 2 ? [{ id: 'find:all', label: 'Search all site content…', onSite: true, group: 'Edit', icon: <Replace />, run: () => setState({ modal: { kind: 'find', query: t } }) }] : [];
    return [...placed, ...showMore, ...words, ...searchAll];
  }, [snap, q, sections, fields, clashing, sectionLimit]);
  const matched = exactDetailFirst(cmds.filter((c) => matchesWords(q, commandText(c.label, c.detail))), q);
  // An address typed exactly finds just that page. Otherwise a command named exactly comes first, then what is
  // already on the site (and the way to search all of it), then everything else.
  const typed = q.trim().toLowerCase();
  const exactPage = matched.filter((c) => !!c.detail && c.detail.toLowerCase() === typed);
  const exactName = matched.filter((c) => !exactPage.includes(c) && c.label.replace(/…$/, '').toLowerCase() === typed);
  // Too short a search to look through the content: the way to search it never sits ahead of a command that matched.
  const onSite = found.filter((c) => c.id !== 'find:all' || found.length > 1 || !matched.length);
  const ranked = exactPage.length ? exactPage : [...exactName, ...onSite, ...matched.filter((c) => !exactName.includes(c))];
  const shown = ranked.slice(0, MAX_ROWS);
  const groups = SECTIONS.flatMap((s) => {
    const items = shown.filter((c) => (exactName.includes(c) ? 'best' : sectionOf(c)) === s.id);
    return items.length ? [{ ...s, items }] : [];
  });
  // The keyboard walks the rows in the order they are shown, group by group.
  const filtered = groups.flatMap((g) => g.items);
  const noMatches = !!typed && filtered.every((c) => c.id === 'find:all');
  const advice = typed.length < 2 ? 'Type at least two characters to search the words on your pages.' : /\s/.test(typed) ? 'Try fewer words or check the spelling.' : 'Check the spelling or try another word.';
  const cur = Math.min(active, filtered.length - 1);
  const history = snap?.history;
  const unavailable = (c: Cmd) => (c.id === 'undo' && !history?.canUndo ? 'Nothing to undo' : c.id === 'redo' && !history?.canRedo ? 'Nothing to redo' : undefined);
  const pick = (c: Cmd | undefined) => {
    if (!c || unavailable(c)) return;
    if (!c.stay && useStore.getState().modal?.kind === 'cmdk') setState({ modal: null });
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
  }, [cur, q]);
  // Scrolled by wheel or scrollbar: the highlight stays on a row in view, so Enter never runs one the user cannot see.
  const keepActiveInView = () => {
    const list = listRef.current;
    if (!list) return;
    const box = list.getBoundingClientRect();
    const top = box.top + HEADING_H - 1;
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
  const capped = ranked.length > shown.length ? ` Showing the first ${shown.length}.` : '';
  const status = noMatches ? `No matches. ${advice}` : typed ? `${hits} ${hits === 1 ? 'result' : 'results'}.${capped}` : '';
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setAnnounced(status), 450);
    return () => clearTimeout(t);
  }, [status, q]);
  const activeCmd = filtered[cur];
  let index = -1;
  return createPortal(
    <div className="overlay-backdrop light" onMouseDown={(e) => e.target === e.currentTarget && setState({ modal: null })}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command menu" ref={ref} onKeyDown={onDialogKey}>
        <div className="cmdk-search">
          <Search />
          <input
            autoFocus
            role="combobox"
            aria-label="Search pages, content and commands"
            aria-expanded={filtered.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeCmd ? optionId(activeCmd) : undefined}
            placeholder="Search pages, content and commands"
            value={q}
            onChange={(e) => (setQ(e.target.value), setSectionLimit(6), moveTo(0))}
            onKeyDown={(e) => {
              // Keys that belong to an input method's candidate list while it is composing.
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'ArrowDown') (e.preventDefault(), moveTo(Math.min(filtered.length - 1, cur + 1)));
              if (e.key === 'ArrowUp') (e.preventDefault(), moveTo(Math.max(0, cur - 1)));
              if (e.key === 'Home' && !q) (e.preventDefault(), moveTo(0));
              if (e.key === 'End' && !q) (e.preventDefault(), moveTo(filtered.length - 1));
              if (e.key === 'Enter') pick(activeCmd);
            }}
          />
        </div>
        {noMatches && (
          <div className="cmdk-empty">
            <strong>No matches</strong>
            <span>{advice}</span>
          </div>
        )}
        <div className="cmdk-list" role="listbox" id={listId} aria-label="Results" ref={listRef} onScroll={keepActiveInView}>
          {groups.map((g) => (
            <div key={g.id} role="group" aria-labelledby={`${listId}-${g.id}`}>
              <div id={`${listId}-${g.id}`} role="presentation" className={noMatches ? 'sr-only' : 'cmdk-group-label'}>{noMatches ? 'Search' : g.label}</div>
              {g.items.map((c) => {
                const i = ++index;
                const reason = unavailable(c);
                return (
                  <div
                    key={c.id}
                    id={optionId(c)}
                    data-index={i}
                    role="option"
                    aria-selected={i === cur}
                    aria-disabled={reason ? true : undefined}
                    aria-description={c.onSite && !c.stay && c.id !== 'find:all' ? 'Show in editor' : undefined}
                    className={`menu-item${i === cur ? ' focused' : ''}${c.place ? ' cmdk-two' : ''}`}
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
                      <span className="cmdk-label"><Marked text={c.label} query={q} /></span>
                      {c.place && <TrailText trail={c.place} query={q} className="cmdk-place" />}
                    </span>
                    {c.detail && <span className="hint cmdk-address" dir="rtl" title={c.detail}><bdi><Marked text={c.detail} query={q} /></bdi></span>}
                    {c.where && <TrailText trail={c.where} query={q} className="hint cmdk-where" />}
                    {reason ? <span className="hint">{reason}</span> : c.kbd && <kbd className="kbd">{c.kbd}</kbd>}
                  </div>
                );
              })}
            </div>
          ))}
          {ranked.length > shown.length && <div className="cmdk-more">Showing the first {shown.length}. Keep typing to narrow the list.</div>}
        </div>
        <div className="sr-only" role="status">{announced}</div>
        <div className="cmdk-foot" aria-hidden="true">
          {filtered.length > 1 && <span><kbd>↑↓</kbd>Move</span>}
          {activeCmd && !unavailable(activeCmd) && <span><kbd>↵</kbd>{enterVerb(activeCmd)}</span>}
          <span><kbd>Esc</kbd>Close</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
