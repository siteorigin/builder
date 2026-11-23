import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, CircleAlert, Component, Copy, Ellipsis, Plus, Eye, FolderOpen, History, House, LogOut, MessageCircleQuestionMark, Monitor, MousePointer2, PanelLeft, PanelRight, Pencil, Redo2, Settings, Smartphone, Tablet, Undo2, Upload, LoaderCircle } from 'lucide-react';
import { VIEWPORT_PRESETS } from '@shared/styles';
import { api, editRunStatus, saveLocal, setState, toast, useStore } from '../store';
import { useMenu, sendCommand, useWindowWidth, type MenuItem } from '../components/ui';
import { AppMark } from '../components/AppMark';
import { selectPage, setMode } from '../lib/actions';
import { pageChoices } from '../lib/page-switch';
import { saveStatusAnnouncement, useTransitionAnnouncement, type SaveStatus } from '../lib/announce';
import { toolbarTier } from '../lib/layout';
import { closeProject } from '../lib/leave';
import { runPhase, settledState } from '../lib/savestate';

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
  // The save state is about the author's work and the AI's changes; a read-only question has none.
  const runStatus = useStore(editRunStatus);
  const definitionMode = useStore((s) => s.definitionMode);
  const dockOpen = useStore((s) => s.dockOpen);
  const hasConflict = useStore((s) => (s.snapshot?.conflicts.length ?? 0) > 0);
  // An edit made while the AI worked: being applied (after stopping the AI), or waiting for the author.
  const handoff = useStore((s) => s.heldEdits.some((h) => h.phase === 'applying'));
  const stoppingForEdit = useStore((s) => s.heldEdits.some((h) => h.phase === 'applying' && !!h.stopping));
  const held = useStore((s) => s.heldEdits.some((h) => h.phase !== 'applying'));
  const menu = useMenu();
  // Screen readers hear settled changes only. When the AI finishes they hear how it really ended, and what
  // became of an edit held meanwhile.
  const settled: SaveStatus = settledState({ conflict: hasConflict, runStatus, stopping: stoppingForEdit, handoff, held, drafting, pending: pending > 0 });
  // A save in flight when the AI finishes is a step on the way, not where it came from: what settles
  // after it is announced from the state before it, so the AI's real outcome is not lost.
  const beforeBusy = useRef<SaveStatus>(settled);
  const announce = useTransitionAnnouncement(settled, (prev, next) => {
    const from = prev === 'busy' ? beforeBusy.current : prev;
    beforeBusy.current = next === 'busy' ? from : next;
    return saveStatusAnnouncement(from, next, useStore.getState().aiOutcome);
  });
  // The width field keeps a draft while typing, so intermediate values like "3" on the way to "390" are allowed.
  const [widthDraft, setWidthDraft] = useState(String(viewport));
  useEffect(() => setWidthDraft(String(viewport)), [viewport]);
  // An invalid entry explained after Enter is not explained again when the field is left; any edit resets it.
  const reported = useRef<string | null>(null);
  const [widthError, setWidthError] = useState(false);
  const isMac = api.platform === 'darwin';
  // In a narrow window the Edit and Preview labels go first, then Zoom and Settings move into a More menu,
  // so the page switcher, Undo, Redo, the panel toggles and Export always fit.
  const tier = toolbarTier(useWindowWidth(), isMac);
  // A tier change swaps Zoom and Settings for More (or back). A menu open from one of them closes, and a
  // keyboard user on the control that left (or in its menu) lands on the one that took its place: at once,
  // or as soon as that menu has closed, before the menu's own focus return looks for somewhere to go.
  const header = useRef<HTMLElement>(null);
  const focused = useRef<HTMLElement | null>(null);
  const focusAfterMenu = useRef(false);
  const closeIfTriggerGone = menu.closeIfTriggerGone;
  const replacement = () => header.current?.querySelector<HTMLElement>(tier === 'overflow' ? '.toolbar-more' : '.toolbar-settings');
  useLayoutEffect(() => {
    const was = focused.current;
    const active = document.activeElement;
    focusAfterMenu.current = false;
    if (was && !was.isConnected) {
      if (!active || active === document.body) replacement()?.focus();
      else if (active.closest('[role="menu"]')) focusAfterMenu.current = true;
    }
    closeIfTriggerGone();
  }, [tier, closeIfTriggerGone]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (menu.isOpen || !focusAfterMenu.current) return;
    focusAfterMenu.current = false;
    replacement()?.focus();
  }, [menu.isOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!snap) return null;
  const state = snap.state;
  const page = pageId ? state.pages[pageId] : null;
  const preset = viewport === VIEWPORT_PRESETS.desktop ? 'desktop' : viewport === VIEWPORT_PRESETS.tablet ? 'tablet' : viewport === VIEWPORT_PRESETS.phone ? 'phone' : null;
  const setViewport = (w: number) => {
    setState({ viewport: w });
    saveLocal({ viewport: w });
  };
  // Shortcut hints name the keys of this platform.
  const keys = (k: string) => (isMac ? k : k.replace('⇧⌘', 'Ctrl+Shift+').replace('⌘', 'Ctrl+'));
  const conflicts = snap.conflicts.length > 0;
  const phase = runPhase(runStatus);
  const spin = <LoaderCircle style={{ animation: 'spin 1s linear infinite' }} />;
  const save = conflicts
    ? { cls: 'error', icon: <CircleAlert />, text: 'File conflict', title: 'A project file was changed outside SiteOrigin Builder. Review it in Project health.' }
    : phase === 'stopping' || stoppingForEdit
      ? { cls: 'pending', icon: spin, text: 'Stopping AI…', title: stoppingForEdit ? 'Your edit is applied once the AI’s changes are undone.' : 'Anything the AI changed in this request is undone.' }
      : phase === 'asking'
        ? { cls: 'pending', icon: <MessageCircleQuestionMark />, text: 'AI is waiting for you', title: 'The AI asked a question. Answer it in the AI panel.' }
        : handoff
          ? { cls: 'pending', icon: spin, text: 'Saving…', title: 'Checking and saving your edit' }
          : phase === 'checking'
            ? { cls: 'pending', icon: spin, text: 'AI is checking', title: 'The AI’s changes are saved once they pass checks.' }
            : phase
              ? { cls: 'pending', icon: spin, text: 'AI is working', title: 'The AI is editing this site. Its changes are saved once they pass checks.' }
              : held
                ? { cls: 'pending', icon: <Pencil />, text: 'Edit not saved', title: 'An edit you made while the AI was working is waiting for you.' }
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
  const zoomItems: MenuItem[] = [
    { label: 'Fit to window', checked: zoom === 'fit', onSelect: () => setState({ zoom: 'fit' }) },
    ...ZOOMS.map((z) => ({ label: `${Math.round(z * 100)}%`, checked: zoom === z, onSelect: () => setState({ zoom: z }) }))
  ];
  const openSettings = () => setState({ modal: { kind: 'settings' } });
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
    <header ref={header} className={`toolbar drag${isMac ? ' mac' : ''}`} data-tier={tier} onFocus={(e) => e.currentTarget.contains(e.target) && (focused.current = e.target)}>
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
                  ...pageChoices(state).map((p) => ({
                    label: p.title,
                    checked: !definitionMode && p.id === pageId,
                    hint: p.home ? 'Home page · /' : p.address,
                    onSelect: () => selectPage(p.id)
                  })),
                  { separator: true },
                  { label: 'New project…', icon: <Plus />, onSelect: () => sendCommand('new-project') },
                  { label: 'Open project…', icon: <FolderOpen />, onSelect: () => sendCommand('open-project') },
                  { separator: true },
                  { label: 'Show project folder', icon: <FolderOpen />, onSelect: () => void api.projects.reveal() },
                  { label: 'Duplicate project…', icon: <Copy />, onSelect: () => void api.projects.duplicate().then((r) => r.ok && toast(`Duplicated to ${r.dir}`)) },
                  { label: 'History…', icon: <History />, onSelect: () => setState({ modal: { kind: 'history' } }) },
                  { separator: true },
                  { label: 'Close project', icon: <LogOut />, shortcut: keys('⇧⌘W'), onSelect: () => void closeProject() }
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
        {/* A click leaves focus in an inspector text field, so text being typed there stays in its field while the page
            is checked at another width. Anywhere else a click moves focus as usual; Tab still reaches the buttons. */}
        <div
          className="segmented"
          role="group"
          aria-label="Preview width"
          onMouseDown={(e) => {
            const at = document.activeElement;
            if (e.button === 0 && e.target !== e.currentTarget && (at instanceof HTMLInputElement || at instanceof HTMLTextAreaElement) && at.closest('#dock-panel-inspect')) e.preventDefault();
          }}
        >
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
        {tier !== 'overflow' && (
          <button
            className="btn btn-sm btn-ghost zoom-btn"
            aria-haspopup="menu"
            aria-expanded={false}
            title="Zoom"
            aria-label={`Zoom: ${zoom === 'fit' ? 'fit to window' : `${Math.round(zoom * 100)}%`}`}
            onClick={(e) => menu.openAt(e.currentTarget, zoomItems, 'Zoom')}
          >
            <span>{zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        )}
        <div className="toolbar-divider" role="presentation" />
        {/* Named by aria-label, so the buttons keep their names when a narrow window shows only the icons. */}
        <div className="segmented" role="group" aria-label="Mode">
          <button aria-pressed={mode === 'edit'} onClick={() => setMode('edit')} title="Edit: click things on the page to select and change them" aria-label="Edit">
            <MousePointer2 aria-hidden="true" />
            {tier === 'full' && 'Edit'}
          </button>
          <button aria-pressed={mode === 'preview'} onClick={() => setMode('preview')} title="Preview: use the site as a visitor would" aria-label="Preview">
            <Eye aria-hidden="true" />
            {tier === 'full' && 'Preview'}
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
        {tier === 'overflow' ? (
          <button
            key="more"
            className="icon-btn toolbar-more"
            aria-haspopup="menu"
            aria-expanded={false}
            title="More: zoom and settings"
            aria-label="More"
            onClick={(e) => menu.openAt(e.currentTarget, [{ heading: 'Zoom' }, ...zoomItems, { separator: true }, { label: 'Settings…', icon: <Settings />, onSelect: openSettings }], 'More')}
          >
            <Ellipsis />
          </button>
        ) : (
          <button key="settings" className="icon-btn toolbar-settings" title="Settings" aria-label="Settings" onClick={openSettings}>
            <Settings />
          </button>
        )}
        <button className="btn btn-primary btn-sm export-btn" title={`Export your website (${keys('⌘E')})`} onClick={() => setState({ modal: { kind: 'export' } })}>
          <Upload /> Export
        </button>
      </div>
      {menu.node}
    </header>
  );
}
