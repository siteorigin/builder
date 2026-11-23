import { ChevronDown, Cloud, CloudAlert, Eye, Laptop, Monitor, MousePointer2, PanelLeft, Redo2, Settings, Smartphone, Tablet, Undo2, Upload, LoaderCircle, Component, X } from 'lucide-react';
import { VIEWPORT_PRESETS } from '@shared/styles';
import { api, setState, toast, useStore } from '../store';
import { useMenu } from '../components/ui';
import { AppMark } from '../components/AppMark';
import { selectPage } from '../lib/actions';

const ZOOMS = [0.5, 0.75, 1, 1.25];

export function Toolbar() {
  const snap = useStore((s) => s.snapshot);
  const pageId = useStore((s) => s.pageId);
  const viewport = useStore((s) => s.viewport);
  const zoom = useStore((s) => s.zoom);
  const mode = useStore((s) => s.mode);
  const leftTab = useStore((s) => s.leftTab);
  const pending = useStore((s) => s.pendingSave);
  const runStatus = useStore((s) => s.runStatus);
  const definitionMode = useStore((s) => s.definitionMode);
  const menu = useMenu();
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
    ? { cls: 'error', icon: <CloudAlert />, text: 'Conflict' }
    : runStatus
      ? { cls: 'pending', icon: <LoaderCircle className="spin" style={{ animation: 'spin 1s linear infinite' }} />, text: 'AI changes pending verification' }
      : pending
        ? { cls: '', icon: <LoaderCircle style={{ animation: 'spin 1s linear infinite' }} />, text: 'Saving' }
        : { cls: '', icon: <Cloud />, text: 'Saved' };
  const isMac = api.platform === 'darwin';

  return (
    <header className={`toolbar drag${isMac ? ' mac' : ''}`}>
      <span className="toolbar-mark" title="SiteOrigin Builder">
        <AppMark size={26} />
      </span>
      <div className="toolbar-group no-drag">
        <button className="icon-btn" aria-pressed={!!leftTab} title="Toggle sidebar (⌘\)" aria-label="Toggle sidebar" onClick={() => setState({ leftTab: leftTab ? null : 'pages' })}>
          <PanelLeft />
        </button>
        <button
          className="project-title"
          onClick={(e) =>
            menu.openAt(e.currentTarget, [
              { heading: state.site.name },
              ...state.site.pageOrder.map((id) => ({ label: state.pages[id].title + (id === state.site.homePageId ? '  ·  Home' : ''), onSelect: () => selectPage(id) })),
              { separator: true },
              { label: 'Show project folder', onSelect: () => void api.projects.reveal() },
              { label: 'Duplicate project…', onSelect: () => void api.projects.duplicate().then((r) => r.ok && toast(`Duplicated to ${r.dir}`)) },
              { label: 'History…', onSelect: () => setState({ modal: { kind: 'history' } }) },
              { separator: true },
              { label: 'Close project', shortcut: '⇧⌘W', onSelect: () => void api.projects.close() }
            ])
          }
        >
          <strong className="ellipsis">{state.site.name}</strong>
          <span className="faint">/</span>
          <span className="page ellipsis">{definitionMode ? state.components[definitionMode.definitionId]?.name : page?.title}</span>
          <ChevronDown size={14} className="faint" />
        </button>
        <span className={`save-state ${save.cls}`} role="status">
          {save.icon}
          {save.text}
        </span>
      </div>

      <div className="toolbar-center no-drag">
        {definitionMode ? (
          <div className="row" style={{ gap: 8 }}>
            <span className="badge violet">
              <Component /> Editing component definition
            </span>
            <button className="btn btn-sm" onClick={() => setState({ definitionMode: null, pageId: definitionMode.returnPageId, selection: null })}>
              <X /> Done
            </button>
          </div>
        ) : (
          <>
            <div className="segmented" role="group" aria-label="Viewport">
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
              aria-label="Viewport width in pixels"
              type="number"
              min={240}
              max={2560}
              value={viewport}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v >= 240 && v <= 2560) setViewport(v);
              }}
            />
            <button
              className="btn btn-sm btn-ghost zoom-btn"
              title="Zoom"
              onClick={(e) =>
                menu.openAt(e.currentTarget, [
                  { label: 'Fit to window', onSelect: () => setState({ zoom: 'fit' }) },
                  ...ZOOMS.map((z) => ({ label: `${Math.round(z * 100)}%`, onSelect: () => setState({ zoom: z }) }))
                ])
              }
            >
              {zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`}
              <ChevronDown size={12} />
            </button>
            <div className="toolbar-divider" />
            <div className="segmented" role="group" aria-label="Mode">
              <button aria-pressed={mode === 'edit'} onClick={() => setState({ mode: 'edit' })} title="Edit: click to select">
                <MousePointer2 /> Edit
              </button>
              <button aria-pressed={mode === 'preview'} onClick={() => setState({ mode: 'preview', selection: null })} title="Preview: use the site normally">
                <Eye /> Preview
              </button>
            </div>
          </>
        )}
      </div>

      <div className="spacer" />
      <div className="toolbar-group no-drag">
        <button className="icon-btn" disabled={!snap.history.canUndo} title={snap.history.undoLabel ? `Undo ${snap.history.undoLabel} (⌘Z)` : 'Undo (⌘Z)'} aria-label="Undo" onClick={() => void api.project.undo().then((r) => !r.ok && r.error && toast(r.error.message, 'error'))}>
          <Undo2 />
        </button>
        <button className="icon-btn" disabled={!snap.history.canRedo} title={snap.history.redoLabel ? `Redo ${snap.history.redoLabel} (⇧⌘Z)` : 'Redo (⇧⌘Z)'} aria-label="Redo" onClick={() => void api.project.redo().then((r) => !r.ok && r.error && toast(r.error.message, 'error'))}>
          <Redo2 />
        </button>
        <div className="toolbar-divider" />
        <button className="icon-btn" title="Settings" aria-label="Settings" onClick={() => setState({ modal: { kind: 'settings' } })}>
          <Settings />
        </button>
        <button className="btn btn-primary btn-sm" style={{ marginLeft: 4 }} onClick={() => setState({ modal: { kind: 'export' } })}>
          <Upload /> Export
        </button>
      </div>
      {menu.node}
      <span hidden>
        <Laptop />
      </span>
    </header>
  );
}
