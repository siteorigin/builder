import { useMemo, useState } from 'react';
import { FileText, Plus, Settings, Sparkles, Upload, Palette, Eye, Monitor, Smartphone, Tablet } from 'lucide-react';
import { catalogueEntries } from '@catalogue/index';
import { api, setState, useStore } from '../store';
import { insert, selectPage, askAiAbout } from '../lib/actions';
import { VIEWPORT_PRESETS } from '@shared/styles';
import { LucideIcon } from './InsertPanel';

interface Cmd {
  id: string;
  label: string;
  group: string;
  icon: React.ReactNode;
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
      ...st.site.pageOrder.map((id) => ({ id: `page:${id}`, label: `Go to ${st.pages[id].title}`, group: 'Pages', icon: <FileText />, run: () => selectPage(id) })),
      ...catalogueEntries(st.site.themeId).map((e) => ({ id: `ins:${e.componentId}`, label: `Insert ${e.name}`, group: 'Insert', icon: <LucideIcon name={e.icon} />, run: () => void insert({ componentId: e.componentId }, e.name) })),
      { id: 'ai', label: 'Ask AI…', group: 'Editor', icon: <Sparkles />, run: () => askAiAbout(null) },
      { id: 'styles', label: 'Open site styles', group: 'Editor', icon: <Palette />, run: () => setState({ rightTab: 'styles' }) },
      { id: 'preview', label: 'Toggle preview mode', group: 'Editor', icon: <Eye />, run: () => setState({ mode: useStore.getState().mode === 'edit' ? 'preview' : 'edit' }) },
      { id: 'desktop', label: 'Desktop width', group: 'Editor', icon: <Monitor />, run: () => setState({ viewport: VIEWPORT_PRESETS.desktop }) },
      { id: 'tablet', label: 'Tablet width', group: 'Editor', icon: <Tablet />, run: () => setState({ viewport: VIEWPORT_PRESETS.tablet }) },
      { id: 'phone', label: 'Phone width', group: 'Editor', icon: <Smartphone />, run: () => setState({ viewport: VIEWPORT_PRESETS.phone }) },
      { id: 'newpage', label: 'Add page', group: 'Editor', icon: <Plus />, run: () => setState({ leftTab: 'pages' }) },
      { id: 'export', label: 'Export…', group: 'Project', icon: <Upload />, run: () => setState({ modal: { kind: 'export' } }) },
      { id: 'settings', label: 'Settings', group: 'Project', icon: <Settings />, run: () => setState({ modal: { kind: 'settings' } }) },
      { id: 'close', label: 'Close project', group: 'Project', icon: <FileText />, run: () => void api.projects.close() }
    ];
  }, [snap]);
  const filtered = cmds.filter((c) => q.trim().toLowerCase().split(/\s+/).every((w) => c.label.toLowerCase().includes(w))).slice(0, 40);
  const pick = (c: Cmd | undefined) => {
    if (!c) return;
    if (useStore.getState().modal?.kind === 'cmdk') setState({ modal: null });
    c.run();
  };
  return (
    <div className="overlay-backdrop" style={{ background: 'rgb(10 10 15 / 0.18)' }} onMouseDown={(e) => e.target === e.currentTarget && setState({ modal: null })}>
      <div className="cmdk" role="dialog" aria-label="Command menu">
        <input
          autoFocus
          placeholder="Search pages, components and commands"
          value={q}
          onChange={(e) => (setQ(e.target.value), setActive(0))}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setActive(Math.min(filtered.length - 1, active + 1)));
            if (e.key === 'ArrowUp') (e.preventDefault(), setActive(Math.max(0, active - 1)));
            if (e.key === 'Enter') pick(filtered[active]);
            if (e.key === 'Escape') setState({ modal: null });
          }}
        />
        <div className="cmdk-list" role="listbox">
          {filtered.map((c, i) => (
            <button key={c.id} role="option" aria-selected={i === active} className={`menu-item${i === active ? ' focused' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => pick(c)}>
              {c.icon}
              <span className="grow">{c.label}</span>
              <span className="faint" style={{ fontSize: 11 }}>
                {c.group}
              </span>
            </button>
          ))}
          {!filtered.length && <div className="menu-label">No matches</div>}
        </div>
      </div>
    </div>
  );
}
