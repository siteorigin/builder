import { useEffect, useState } from 'react';
import { Check, ChevronDown, CircleAlert, Copy, Eye, FolderOpen, History, House, LogOut, Monitor, MousePointer2, PanelLeft, PanelRight, Pencil, Redo2, Settings, Smartphone, Tablet, Undo2, Upload, LoaderCircle } from 'lucide-react';
import { VIEWPORT_PRESETS } from '@shared/styles';
import { api, setState, toast, useStore } from '../store';
import { useMenu } from '../components/ui';
import { AppMark } from '../components/AppMark';
import { selectPage, setMode } from '../lib/actions';

const ZOOMS = [0.5, 0.75, 1, 1.25];

export function Toolbar() {
  const snap = useStore((s) => s.snapshot);
  const pageId = useStore((s) => s.pageId);
  const viewport = useStore((s) => s.viewport);
  const zoom = useStore((s) => s.zoom);
  const mode = useStore((s) => s.mode);
  const leftTab = useStore((s) => s.leftTab);
  const pending = useStore((s) => s.pendingSave);
  const drafting = useStore((s) => s.drafting > 0);
  const runStatus = useStore((s) => s.runStatus);
  const definitionMode = useStore((s) => s.definitionMode);
  const dockOpen = useStore((s) => s.dockOpen);
  const menu = useMenu();
  // The width field keeps a draft while typing, so intermediate values like "3" on the way to "390" are allowed.
  const [widthDraft, setWidthDraft] = useState(String(viewport));
  useEffect(() => setWidthDraft(String(viewport)), [viewport]);
  if (!snap) return null;
  const state = snap.state;
  const page = pageId ? state.pages[pageId] : null;
  const preset = viewport === VIEWPORT_PRESETS.desktop ? 'desktop' : viewport === VIEWPORT_PRESETS.tablet ? 'tablet' : viewport === VIEWPORT_PRESETS.phone ? 'phone' : null;
  const setViewport = (w: number) => {
    setState({ viewport: w });
    void api.project.saveLocalState({ viewport: w });
  };
  const conflicts = snap.conflicts.length > 0;
  const save = conflicts
    ? { cls: 'error', icon: <CircleAlert />, text: 'File conflict', title: 'A project file changed outside SiteOrigin Builder. Open the status bar problems to resolve it.' }
    : runStatus
      ? { cls: 'pending', icon: <LoaderCircle style={{ animation: 'spin 1s linear infinite' }} />, text: 'AI is checking its changes', title: 'The AI’s changes are saved once they pass checks.' }
      : drafting
        ? { cls: 'pending', icon: <Pencil />, text: 'Editing…', title: 'Press Enter or click away to save this change' }
        : pending
        ? { cls: 'pending', icon: <LoaderCircle style={{ animation: 'spin 1s linear infinite' }} />, text: 'Saving…', title: 'Saving to this computer' }
        : { cls: 'saved', icon: <Check />, text: 'Saved', title: 'All changes are saved on this computer' };
  const isMac = api.platform === 'darwin';

  return (
    <header className={`toolbar drag${isMac ? ' mac' : ''}`}>
      <div className="toolbar-start">
        <span className="toolbar-mark" title="SiteOrigin Builder">
          <AppMark size={26} />
        </span>
        <div className="toolbar-group no-drag">
          <button className="icon-btn" aria-pressed={!!leftTab} title="Show or hide the sidebar (⌘\)" aria-label="Sidebar" onClick={() => setState({ leftTab: leftTab ? null : 'pages' })}>
            <PanelLeft />
          </button>
          <button
            className="project-title"
            aria-haspopup="menu"
            aria-expanded={false}
            title="Pages and project options"
            onClick={(e) =>
              menu.openAt(
                e.currentTarget,
                [
                  { heading: 'Pages' },
                  ...state.site.pageOrder.map((id) => ({
                    label: state.pages[id].title,
                    checked: !definitionMode && id === pageId,
                    hint: id === state.site.homePageId ? 'Home page' : undefined,
                    onSelect: () => selectPage(id)
                  })),
                  { separator: true },
                  { label: 'Show project folder', icon: <FolderOpen />, onSelect: () => void api.projects.reveal() },
                  { label: 'Duplicate project…', icon: <Copy />, onSelect: () => void api.projects.duplicate().then((r) => r.ok && toast(`Duplicated to ${r.dir}`)) },
                  { label: 'History…', icon: <History />, onSelect: () => setState({ modal: { kind: 'history' } }) },
                  { separator: true },
                  { label: 'Close project', icon: <LogOut />, shortcut: '⇧⌘W', onSelect: () => void api.projects.close() }
                ],
                state.site.name
              )
            }
          >
            <strong className="ellipsis">{state.site.name}</strong>
            <span className="sep">/</span>
            {page?.id === state.site.homePageId && !definitionMode && <House size={13} className="faint" aria-label="Home page" />}
            <span className="page ellipsis">{definitionMode ? state.components[definitionMode.definitionId]?.name : page?.title}</span>
            <ChevronDown size={14} className="faint" />
          </button>
          <span className={`save-state ${save.cls}`} role="status" title={save.title}>
            {save.icon}
            {save.text}
          </span>
        </div>
      </div>

      <div className="toolbar-center no-drag">
        <div className="segmented" role="group" aria-label="Preview width">
          <button aria-pressed={preset === 'desktop'} title="Desktop (1280px)" aria-label="Desktop" onClick={() => setViewport(VIEWPORT_PRESETS.desktop)}>
            <Monitor />
          </button>
          <button aria-pressed={preset === 'tablet'} title="Tablet (834px)" aria-label="Tablet" onClick={() => setViewport(VIEWPORT_PRESETS.tablet)}>
            <Tablet />
          </button>
          <button aria-pressed={preset === 'phone'} title="Phone (390px)" aria-label="Phone" onClick={() => setViewport(VIEWPORT_PRESETS.phone)}>
            <Smartphone />
          </button>
        </div>
        <input
          className="input width-input"
          aria-label="Preview width in pixels"
          title="Preview width in pixels"
          type="number"
          min={240}
          max={2560}
          value={widthDraft}
          onChange={(e) => setWidthDraft(e.target.value)}
          onBlur={() => {
            const v = Math.round(Number(widthDraft));
            if (v >= 240 && v <= 2560) setViewport(v);
            else setWidthDraft(String(viewport));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') (setWidthDraft(String(viewport)), requestAnimationFrame(() => (e.target as HTMLInputElement).blur()));
          }}
        />
        <button
          className="btn btn-sm btn-ghost zoom-btn"
          aria-haspopup="menu"
          aria-expanded={false}
          title="Zoom"
          aria-label={`Zoom: ${zoom === 'fit' ? 'fit to window' : `${Math.round(zoom * 100)}%`}`}
          onClick={(e) =>
            menu.openAt(
              e.currentTarget,
              [
                { label: 'Fit to window', checked: zoom === 'fit', onSelect: () => setState({ zoom: 'fit' }) },
                ...ZOOMS.map((z) => ({ label: `${Math.round(z * 100)}%`, checked: zoom === z, onSelect: () => setState({ zoom: z }) }))
              ],
              'Zoom'
            )
          }
        >
          {zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`}
          <ChevronDown size={12} />
        </button>
        <div className="toolbar-divider" role="presentation" />
        <div className="segmented" role="group" aria-label="Mode">
          <button aria-pressed={mode === 'edit'} onClick={() => setMode('edit')} title="Edit: click things on the page to select and change them">
            <MousePointer2 /> Edit
          </button>
          <button aria-pressed={mode === 'preview'} onClick={() => setMode('preview')} title="Preview: use the site as a visitor would">
            <Eye /> Preview
          </button>
        </div>
      </div>

      <div className="toolbar-end no-drag">
        <button className="icon-btn" disabled={!snap.history.canUndo} title={snap.history.undoLabel ? `Undo ${snap.history.undoLabel} (⌘Z)` : 'Undo (⌘Z)'} aria-label={snap.history.undoLabel ? `Undo ${snap.history.undoLabel}` : 'Undo'} onClick={() => void api.project.undo().then((r) => !r.ok && r.error && toast(r.error.message, 'error'))}>
          <Undo2 />
        </button>
        <button className="icon-btn" disabled={!snap.history.canRedo} title={snap.history.redoLabel ? `Redo ${snap.history.redoLabel} (⇧⌘Z)` : 'Redo (⇧⌘Z)'} aria-label={snap.history.redoLabel ? `Redo ${snap.history.redoLabel}` : 'Redo'} onClick={() => void api.project.redo().then((r) => !r.ok && r.error && toast(r.error.message, 'error'))}>
          <Redo2 />
        </button>
        <div className="toolbar-divider" role="presentation" />
        <button className="icon-btn" aria-pressed={dockOpen} title="Show or hide the right panel (⇧⌘\)" aria-label="Right panel" onClick={() => setState({ dockOpen: !dockOpen })}>
          <PanelRight />
        </button>
        <button className="icon-btn" title="Settings" aria-label="Settings" onClick={() => setState({ modal: { kind: 'settings' } })}>
          <Settings />
        </button>
        <button className="btn btn-primary btn-sm" style={{ marginLeft: 4 }} title="Export your website (⌘E)" onClick={() => setState({ modal: { kind: 'export' } })}>
          <Upload /> Export
        </button>
      </div>
      {menu.node}
    </header>
  );
}
