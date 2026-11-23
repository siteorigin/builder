import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, CircleAlert, Component, Copy, Plus, Eye, FolderOpen, History, House, LogOut, Monitor, MousePointer2, PanelLeft, PanelRight, Pencil, Redo2, Settings, Smartphone, Tablet, Undo2, Upload, LoaderCircle } from 'lucide-react';
import { VIEWPORT_PRESETS } from '@shared/styles';
import { api, setState, toast, useStore } from '../store';
import { useMenu, sendCommand } from '../components/ui';
import { AppMark } from '../components/AppMark';
import { selectPage, setMode } from '../lib/actions';
import { useTransitionAnnouncement } from '../lib/announce';

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
  const hasConflict = useStore((s) => (s.snapshot?.conflicts.length ?? 0) > 0);
  const menu = useMenu();
  // Screen readers hear settled changes only: a save completing, an AI check starting or finishing, a
  // conflict appearing or clearing. Typing and the Unsaved/Saving flicker in between stay quiet.
  const settled = hasConflict ? 'conflict' : runStatus ? 'ai' : drafting || pending ? 'busy' : 'saved';
  const announce = useTransitionAnnouncement(settled, (prev, next) =>
    next === 'conflict'
      ? 'File conflict. A project file was changed outside SiteOrigin Builder.'
      : next === 'ai'
        ? 'AI is checking its changes'
        : next === 'busy'
          ? null
          : prev === 'conflict'
            ? 'File conflict resolved. All changes saved'
            : prev === 'ai'
              ? 'AI changes saved'
              : 'All changes saved'
  );
  // The width field keeps a draft while typing, so intermediate values like "3" on the way to "390" are allowed.
  const [widthDraft, setWidthDraft] = useState(String(viewport));
  useEffect(() => setWidthDraft(String(viewport)), [viewport]);
  // An invalid entry explained after Enter is not explained again when the field is left; any edit resets it.
  const reported = useRef<string | null>(null);
  const [widthError, setWidthError] = useState(false);
  if (!snap) return null;
  const state = snap.state;
  const page = pageId ? state.pages[pageId] : null;
  const preset = viewport === VIEWPORT_PRESETS.desktop ? 'desktop' : viewport === VIEWPORT_PRESETS.tablet ? 'tablet' : viewport === VIEWPORT_PRESETS.phone ? 'phone' : null;
  const setViewport = (w: number) => {
    setState({ viewport: w });
    void api.project.saveLocalState({ viewport: w });
  };
  const isMac = api.platform === 'darwin';
  // Shortcut hints name the keys of this platform.
  const keys = (k: string) => (isMac ? k : k.replace('⇧⌘', 'Ctrl+Shift+').replace('⌘', 'Ctrl+'));
  const conflicts = snap.conflicts.length > 0;
  const spin = <LoaderCircle style={{ animation: 'spin 1s linear infinite' }} />;
  const save = conflicts
    ? { cls: 'error', icon: <CircleAlert />, text: 'File conflict', title: 'A project file was changed outside SiteOrigin Builder. Review it in Project health.' }
    : runStatus
      ? { cls: 'pending', icon: spin, text: 'AI is checking', title: 'The AI’s changes are saved once they pass checks.' }
      : drafting
        ? { cls: 'pending', icon: <Pencil />, text: 'Unsaved change', title: 'Press Enter or click away to save this change' }
        : pending
          ? { cls: 'pending', icon: spin, text: 'Saving…', title: 'Saving to this computer' }
          : { cls: 'saved', icon: <Check />, text: 'Saved', title: 'All changes are saved on this computer' };
  const siteName = state.site.name;
  const defName = definitionMode ? (state.components[definitionMode.definitionId]?.name ?? 'Component') : null;
  const placeName = defName ?? page?.title ?? '';
  const isHome = !definitionMode && page?.id === state.site.homePageId;
  // The width is a whole number from 240 to 2560. Anything else is not applied: the field says why and
  // keeps focus after Enter so it can be corrected, or goes back to the current width when left.
  const validWidth = (raw: string) => {
    const v = Number(raw.trim());
    return raw.trim() !== '' && Number.isInteger(v) && v >= 240 && v <= 2560 ? v : null;
  };
  const commitWidth = (fromEnter: boolean, el: HTMLInputElement) => {
    const v = validWidth(widthDraft);
    if (v !== null) {
      reported.current = null;
      setWidthError(false);
      setWidthDraft(String(v));
      if (v !== viewport) setViewport(v);
      if (fromEnter) el.blur();
      return;
    }
    if (reported.current !== widthDraft) {
      reported.current = widthDraft;
      toast('Enter a whole number from 240 to 2560 px.', 'error');
    }
    if (fromEnter) {
      setWidthError(true);
      el.select();
    } else {
      reported.current = null;
      setWidthError(false);
      setWidthDraft(String(viewport));
    }
  };

  return (
    <header className={`toolbar drag${isMac ? ' mac' : ''}`}>
      <div className="toolbar-start">
        <span className="toolbar-mark" title="SiteOrigin Builder">
          <AppMark size={26} />
        </span>
        <div className="toolbar-group">
          <button className="icon-btn" aria-pressed={!!leftTab} title={`Show or hide the sidebar (${keys('⌘\\')})`} aria-label="Sidebar" onClick={() => setState({ leftTab: leftTab ? null : 'pages' })}>
            <PanelLeft />
          </button>
          <button
            className="project-title"
            aria-haspopup="menu"
            aria-expanded={false}
            title={`${siteName} / ${placeName}: switch page, or open project options`}
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
                  { label: 'New project…', icon: <Plus />, onSelect: () => sendCommand('new-project') },
                  { label: 'Open project…', icon: <FolderOpen />, onSelect: () => sendCommand('open-project') },
                  { separator: true },
                  { label: 'Show project folder', icon: <FolderOpen />, onSelect: () => void api.projects.reveal() },
                  { label: 'Duplicate project…', icon: <Copy />, onSelect: () => void api.projects.duplicate().then((r) => r.ok && toast(`Duplicated to ${r.dir}`)) },
                  { label: 'History…', icon: <History />, onSelect: () => setState({ modal: { kind: 'history' } }) },
                  { separator: true },
                  { label: 'Close project', icon: <LogOut />, shortcut: keys('⇧⌘W'), onSelect: () => void api.projects.close() }
                ],
                state.site.name
              )
            }
          >
            <strong className="site ellipsis">{siteName}</strong>
            <span className="sep" aria-hidden="true">/</span>
            <span className={`page${defName ? ' def' : ''}`}>
              {defName ? <Component aria-label="Component" /> : isHome ? <House aria-label="Home page" /> : null}
              <span className="ellipsis">{placeName}</span>
            </span>
            <ChevronDown className="chev" aria-hidden="true" />
          </button>
          {conflicts ? (
            <button className="save-state error" title={save.title} onClick={() => setState({ modal: { kind: 'health' } })}>
              {save.icon}
              {save.text}
              <ChevronRight className="go" aria-hidden="true" />
            </button>
          ) : (
            <span className={`save-state ${save.cls}`} title={save.title}>
              {save.icon}
              {save.text}
            </span>
          )}
          <span className="sr-only" role="status">
            {announce}
          </span>
        </div>
      </div>

      <div className="toolbar-center">
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
        <label className="width-field" title="Preview width, from 240 to 2560 pixels">
          <input
            className="width-input"
            aria-label="Preview width in pixels"
            type="number"
            min={240}
            max={2560}
            value={widthDraft}
            aria-invalid={widthError || undefined}
            aria-describedby={widthError ? 'width-error' : undefined}
            onChange={(e) => {
              reported.current = null;
              setWidthError(false);
              setWidthDraft(e.target.value);
            }}
            onBlur={(e) => commitWidth(false, e.currentTarget)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitWidth(true, e.currentTarget);
              if (e.key === 'Escape') {
                reported.current = null;
                setWidthError(false);
                setWidthDraft(String(viewport));
                requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
              }
            }}
          />
          <span className="unit" aria-hidden="true">
            px
          </span>
          {widthError && (
            <span id="width-error" className="sr-only">
              Enter a whole number from 240 to 2560 px.
            </span>
          )}
        </label>
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
          <span>{zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`}</span>
          <ChevronDown size={12} aria-hidden="true" />
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

      <div className="toolbar-end">
        <button className="icon-btn" disabled={!snap.history.canUndo} title={`${snap.history.undoLabel ? `Undo ${snap.history.undoLabel}` : 'Undo'} (${keys('⌘Z')})`} aria-label={snap.history.undoLabel ? `Undo ${snap.history.undoLabel}` : 'Undo'} onClick={() => void api.project.undo().then((r) => !r.ok && r.error && toast(r.error.message, 'error'))}>
          <Undo2 />
        </button>
        <button className="icon-btn" disabled={!snap.history.canRedo} title={`${snap.history.redoLabel ? `Redo ${snap.history.redoLabel}` : 'Redo'} (${keys('⇧⌘Z')})`} aria-label={snap.history.redoLabel ? `Redo ${snap.history.redoLabel}` : 'Redo'} onClick={() => void api.project.redo().then((r) => !r.ok && r.error && toast(r.error.message, 'error'))}>
          <Redo2 />
        </button>
        <div className="toolbar-divider" role="presentation" />
        <button className="icon-btn" aria-pressed={dockOpen} title={`Show or hide the right panel (${keys('⇧⌘\\')})`} aria-label="Right panel" onClick={() => setState({ dockOpen: !dockOpen })}>
          <PanelRight />
        </button>
        <button className="icon-btn" title="Settings" aria-label="Settings" onClick={() => setState({ modal: { kind: 'settings' } })}>
          <Settings />
        </button>
        <button className="btn btn-primary btn-sm export-btn" title={`Export your website (${keys('⌘E')})`} onClick={() => setState({ modal: { kind: 'export' } })}>
          <Upload /> Export
        </button>
      </div>
      {menu.node}
    </header>
  );
}
