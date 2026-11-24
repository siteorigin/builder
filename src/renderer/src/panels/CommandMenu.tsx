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
  run: () => void;
}

export function CommandMenu() {
  const snap = useStore((s) => s.snapshot);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
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
      { id: 'settings', label: 'Settings', group: 'Project', icon: <Settings />, run: () => setState({ modal: { kind: 'settings' } }) },
      { id: 'history', label: 'History…', group: 'Project', icon: <History />, run: () => setState({ modal: { kind: 'history' } }) },
      { id: 'save-version', label: 'Save a version of the site…', group: 'Project', icon: <BookmarkPlus />, run: () => setState({ modal: { kind: 'history', tab: 'versions' } }) },
      { id: 'health', label: 'Project health', group: 'Project', icon: <Stethoscope />, run: () => setState({ modal: { kind: 'health' } }) },
      { id: 'outline', label: 'Show the page’s headings outline', group: 'View', icon: <ListTree />, run: () => openOutline() },
      { id: 'dock', kbd: '⇧⌘\\', label: 'Show or hide the right panel', group: 'View', icon: <PanelRight />, run: () => setState({ dockOpen: !useStore.getState().dockOpen }) },
      { id: 'close', kbd: '⇧⌘W', label: 'Close project', group: 'Project', icon: <LogOut />, run: () => void closeProject() }
    ];
  }, [snap]);
  // What is already on the site comes before what can be added: the sections placed on each page, and a few of the
  // words and destinations the search finds (the full list is in Find and replace).
  const sections = useMemo(() => (snap ? placedSections(snap.state) : []), [snap]);
  const fields = useMemo(() => (snap ? contentFields(snap.state) : []), [snap]);
  const found = useMemo<Cmd[]>(() => {
    const t = q.trim();
    if (!snap || !t) return [];
    const placed = sections
      .filter((x) => sectionMatches(x, t))
      .slice(0, 6)
      .map((x, i) => ({
        id: `sec:${i}:${x.label}`,
        label: x.label,
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
      }));
    const words = t.length < 2 ? [] : findContent(snap.state, t, { limit: 5 }, fields).map((m) => ({
      id: `find:${m.id}`,
      label: `${m.before}${m.match}${m.after}`.slice(0, 90),
      detail: `${m.field.section} › ${m.field.label}`,
      group: m.field.where,
      icon: m.kind === 'link' ? <Link2 /> : <TextSearch />,
      run: () => openContentMatch(m.field)
    }));
    return [...placed, ...words, { id: 'find:all', label: `Find “${t}” in site content…`, group: 'Edit', icon: <Replace />, run: () => setState({ modal: { kind: 'find', query: t } }) }];
  }, [snap, q, sections, fields]);
  const matched = exactDetailFirst(cmds.filter((c) => matchesWords(q, commandText(c.label, c.detail))), q);
  // An address typed exactly finds just that page. Otherwise a command named exactly comes first, then what is
  // already on the site (and the way to search all of it), then everything else.
  const typed = q.trim().toLowerCase();
  const exactPage = matched.filter((c) => !!c.detail && c.detail.toLowerCase() === typed);
  const exactName = matched.filter((c) => !exactPage.includes(c) && c.label.toLowerCase() === typed);
  const filtered = (exactPage.length ? matched : [...exactName, ...found, ...matched.filter((c) => !exactName.includes(c))]).slice(0, 40);
  const pick = (c: Cmd | undefined) => {
    if (!c) return;
    if (useStore.getState().modal?.kind === 'cmdk') setState({ modal: null });
    c.run();
  };
  const ref = useRef<HTMLDivElement>(null);
  const listId = useId();
  const onDialogKey = useDialogFocus(ref, () => setState({ modal: null }));
  useEffect(() => {
    ref.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return createPortal(
    <div className="overlay-backdrop light" onMouseDown={(e) => e.target === e.currentTarget && setState({ modal: null })}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command menu" ref={ref} onKeyDown={onDialogKey}>
        <div className="cmdk-search">
          <Search />
          <input
            autoFocus
            role="combobox"
            aria-label="Search pages, sections and commands"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
            placeholder="Search pages, sections and commands"
            value={q}
            onChange={(e) => (setQ(e.target.value), setActive(0))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setActive(Math.min(filtered.length - 1, active + 1)));
              if (e.key === 'ArrowUp') (e.preventDefault(), setActive(Math.max(0, active - 1)));
              if (e.key === 'Home' && !q) (e.preventDefault(), setActive(0));
              if (e.key === 'End' && !q) (e.preventDefault(), setActive(filtered.length - 1));
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) pick(filtered[active]);
            }}
          />
        </div>
        <div className="cmdk-list" role="listbox" id={listId} aria-label="Commands">
          {filtered.map((c, i) => (
            <div key={c.id} id={`${listId}-${i}`} data-index={i} role="option" aria-selected={i === active} className={`menu-item${i === active ? ' focused' : ''}`} onMouseMove={() => i !== active && setActive(i)} onClick={() => pick(c)}>
              {c.icon}
              <span className="grow">{c.label}</span>
              {c.detail && <span className="hint cmdk-detail" title={c.detail}>{c.detail}</span>}
              {c.kbd && <kbd className="kbd">{c.kbd}</kbd>}
              <span className="hint">{c.group}</span>
            </div>
          ))}
          {!filtered.length && <div className="menu-label" style={{ padding: '14px 12px' }}>Nothing matches “{q.trim()}”.</div>}
        </div>
        <div className="cmdk-foot" aria-hidden="true">
          <span>↑↓ to move</span>
          <span>↵ to choose</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
