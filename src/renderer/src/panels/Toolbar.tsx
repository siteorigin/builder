import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { BookmarkPlus, Check, ChevronDown, ChevronRight, CircleAlert, Component, Copy, Ellipsis, Plus, Eye, FolderOpen, FolderSearch, History, House, LogOut, Monitor, MousePointer2, PanelLeft, PanelRight, Pencil, Redo2, Settings, Smartphone, Sparkles, Tablet, Undo2, Upload, LoaderCircle } from 'lucide-react';
import { VIEWPORT_PRESETS } from '@shared/styles';
import { api, editRunStatus, projectHistory, setState, setViewport, setZoom, toast, useStore } from '../store';
import { useMenu, sendCommand, useWindowWidth, type MenuItem } from '../components/ui';
import { AppMark } from '../components/AppMark';
import { selectPage, setMode } from '../lib/actions';
import { pageChoices } from '../lib/page-switch';
import { saveStatusAnnouncement, useTransitionAnnouncement, type SaveStatus } from '../lib/announce';
import { VIEWPORT_LIMITS, ZOOM_LEVELS, toolbarTier } from '../lib/layout';
import { closeProject } from '../lib/leave';
import { runPhase, settledState } from '../lib/savestate';

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
  // How many times Enter has been refused in a row, so the message is announced again on each try.
  const [widthError, setWidthError] = useState(0);
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
  // Only a control that still owned focus is recovered: a click or focus anywhere outside the toolbar (and its
  // menus) forgets it, so a control vanishing later never pulls focus back from the page.
  useEffect(() => {
    const away = (e: Event) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t && !header.current?.contains(t) && !t.closest('[role="menu"]')) focused.current = null;
    };
    document.addEventListener('focusin', away);
    document.addEventListener('pointerdown', away, true);
    return () => {
      document.removeEventListener('focusin', away);
      document.removeEventListener('pointerdown', away, true);
    };
  }, []);
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
  // The status is a button while it leads somewhere (the AI panel, held edits, Project health). When it settles
  // back to plain text a keyboard user on it lands on the page switcher beside it, not on the page body.
  const runNow = runPhase(runStatus);
  const statusActs = hasConflict || runNow === 'stopping' || stoppingForEdit || runNow === 'asking' || (!handoff && (!!runNow || held));
  useLayoutEffect(() => {
    const was = focused.current;
    const active = document.activeElement;
    if (was?.classList.contains('save-state') && !was.isConnected && (!active || active === document.body)) header.current?.querySelector<HTMLElement>('.project-title')?.focus();
  }, [statusActs]);
  if (!snap) return null;
  const state = snap.state;
  const page = pageId ? state.pages[pageId] : null;
  const preset = viewport === VIEWPORT_PRESETS.desktop ? 'desktop' : viewport === VIEWPORT_PRESETS.tablet ? 'tablet' : viewport === VIEWPORT_PRESETS.phone ? 'phone' : null;
  // Shortcut hints name the keys of this platform.
  const keys = (k: string) => (isMac ? k : k.replace('⇧⌘', 'Ctrl+Shift+').replace('⌘', 'Ctrl+'));
  const conflicts = snap.conflicts.length > 0;
  const phase = runPhase(runStatus);
  const spin = <LoaderCircle className="spin" />;
  // Each state names itself in words and a glyph, never by hue alone. `kind` sets its weight: quiet (saved), pending
  // (on its way), ai (the AI at work: its Sparkles in the accent, which is the AI's colour), ask (the AI is waiting
  // on the author), wait (an edit of the author's on hold) and error. Every AI state opens the AI panel, an edit on
  // hold goes to its row in the held-edits tray, and a conflict opens Project health.
  type Save = { kind: 'saved' | 'pending' | 'ai' | 'ask' | 'wait' | 'error'; icon: ReactNode; text: string; title: string };
  const ai = <Sparkles className="ai-glyph" />;
  const save: Save = conflicts
    ? { kind: 'error', icon: <CircleAlert />, text: 'File conflict', title: 'A project file was changed outside SiteOrigin Builder. Review it in Project health' }
    : phase === 'stopping' || stoppingForEdit
      ? { kind: 'ai', icon: ai, text: 'Stopping AI…', title: stoppingForEdit ? 'Your edit is applied once the AI’s changes are undone. Open the AI panel' : 'Anything the AI changed in this request is undone. Open the AI panel' }
      : phase === 'asking'
        ? { kind: 'ask', icon: ai, text: 'AI is waiting for you', title: 'The AI asked a question. Answer it in the AI panel' }
        : handoff
          ? { kind: 'pending', icon: spin, text: 'Saving…', title: 'Checking and saving your edit' }
          : phase === 'checking'
            ? { kind: 'ai', icon: ai, text: 'AI is checking', title: 'The AI’s changes are saved once they pass checks. Open the AI panel' }
            : phase
              ? { kind: 'ai', icon: ai, text: 'AI is working', title: 'The AI is editing this site, and its changes are saved once they pass checks. Open the AI panel' }
              : held
                ? { kind: 'wait', icon: <Pencil />, text: 'Edit on hold', title: 'An edit you made is waiting for you. Review it below' }
                : drafting
                  ? { kind: 'pending', icon: <Pencil />, text: 'Unsaved change', title: 'Press Enter or click away to save this change' }
                  : pending
                    ? { kind: 'pending', icon: spin, text: 'Saving…', title: 'Saving to this computer' }
                    : { kind: 'saved', icon: <Check />, text: 'Saved', title: 'All changes are saved on this computer' };
  // The AI's question goes straight to the answer field; the other AI states land on the AI panel's tab, so a click
  // shows where it went even when the panel was already open.
  const openAi = () => {
    setState({ dockOpen: true, rightTab: 'chat' });
    requestAnimationFrame(() => (save.kind === 'ask' ? document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus() : document.getElementById('dock-tab-chat')?.focus({ focusVisible: true })));
  };
  // An edit on hold: its row's first choice, with a visible ring even after a click.
  const goToHeld = () => {
    const first = document.querySelector<HTMLElement>('.toast-group[aria-label="Edits not saved yet"] button');
    first?.scrollIntoView({ block: 'nearest' });
    first?.focus({ focusVisible: true });
  };
  const act = save.kind === 'error' ? () => setState({ modal: { kind: 'health' } }) : save.kind === 'wait' ? goToHeld : openAi;
  const siteName = state.site.name;
  const defName = definitionMode ? (state.components[definitionMode.definitionId]?.name ?? 'Component') : null;
  const placeName = defName ?? page?.title ?? '';
  const isHome = !definitionMode && page?.id === state.site.homePageId;
  // The width is a whole number from 240 to 2560. Anything else is not applied: the field says why and
  // keeps focus after Enter so it can be corrected, or goes back to the current width when left.
  const validWidth = (raw: string) => {
    const v = Number(raw.trim());
    return raw.trim() !== '' && Number.isInteger(v) && v >= VIEWPORT_LIMITS.min && v <= VIEWPORT_LIMITS.max ? v : null;
  };
  const zoomItems: MenuItem[] = [
    { label: 'Fit to window', checked: zoom === 'fit', onSelect: () => setZoom('fit') },
    ...ZOOM_LEVELS.map((z) => ({ label: `${Math.round(z * 100)}%`, checked: zoom === z, onSelect: () => setZoom(z) }))
  ];
  const openSettings = () => setState({ modal: { kind: 'settings' } });
  const commitWidth = (fromEnter: boolean, el: HTMLInputElement) => {
    const v = validWidth(widthDraft);
    if (v !== null) {
      reported.current = null;
      setWidthError(0);
      setWidthDraft(String(v));
      if (v !== viewport) setViewport(v);
      if (fromEnter) el.blur();
      return;
    }
    // After Enter the field keeps focus and says why beside itself. Leaving it puts the width back, so a toast
    // says the entry was not applied.
    if (fromEnter) {
      reported.current = widthDraft;
      setWidthError((n) => n + 1);
      el.select();
    } else {
      if (reported.current !== widthDraft) toast(`Width not changed: enter a whole number from ${VIEWPORT_LIMITS.min} to ${VIEWPORT_LIMITS.max} px.`, 'error');
      reported.current = null;
      setWidthError(0);
      setWidthDraft(String(viewport));
    }
  };

  return (
    <header ref={header} className={`toolbar drag${isMac ? ' mac' : ''}`} data-tier={tier} onFocus={(e) => e.currentTarget.contains(e.target) && (focused.current = e.target)}>
      <div className="toolbar-start">
        <span className="toolbar-mark" title="SiteOrigin Builder">
          <AppMark size={22} />
        </span>
        <div className="toolbar-group">
          <button className="icon-btn" aria-pressed={!!leftTab} title={`Show or hide the sidebar (${keys('⌘\\')})`} aria-label="Sidebar" onClick={() => setState({ leftTab: leftTab ? null : 'pages' })}>
            <PanelLeft />
          </button>
          <button
            className="project-title"
            aria-haspopup="menu"
            aria-expanded={false}
            title={defName ? `Editing ${defName} everywhere, in ${siteName}: switch page, or open project options` : `${siteName} / ${placeName}: switch page, or open project options`}
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
                  { label: 'Show project folder', icon: <FolderSearch />, onSelect: () => void api.projects.reveal() },
                  { label: 'Duplicate project…', icon: <Copy />, onSelect: () => void api.projects.duplicate().then((r) => r.ok && toast(`Duplicated to ${r.dir}`)) },
                  { label: 'History…', icon: <History />, onSelect: () => setState({ modal: { kind: 'history' } }) },
                  { label: 'Save version…', icon: <BookmarkPlus />, onSelect: () => setState({ modal: { kind: 'history', tab: 'versions' } }) },
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
              {/* The house names the home page, unless the page's own name already says so. */}
              {defName ? <Component role="img" aria-label="Component" /> : isHome ? /\bhome\b/i.test(placeName) ? <House aria-hidden="true" /> : <House role="img" aria-label="Home page" /> : null}
              <span className="ellipsis">{placeName}</span>
            </span>
            <ChevronDown className="chev" aria-hidden="true" />
          </button>
          {/* The slot keeps the quiet states' width (see .save-slot); its blank end still drags the window. */}
          <span className="save-slot">
            {save.kind !== 'saved' && save.kind !== 'pending' ? (
              <button className={`save-state ${save.kind}`} title={save.title} onClick={act}>
                {save.icon}
                {save.text}
                <ChevronRight className="go" aria-hidden="true" />
              </button>
            ) : (
              <span className={`save-state ${save.kind}`} title={save.title}>
                {save.icon}
                {save.text}
              </span>
            )}
          </span>
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
          <button aria-pressed={preset === 'desktop'} title="Desktop, 1280 px" aria-label="Desktop" onClick={() => setViewport(VIEWPORT_PRESETS.desktop)}>
            <Monitor />
          </button>
          <button aria-pressed={preset === 'tablet'} title="Tablet, 834 px" aria-label="Tablet" onClick={() => setViewport(VIEWPORT_PRESETS.tablet)}>
            <Tablet />
          </button>
          <button aria-pressed={preset === 'phone'} title="Phone, 390 px" aria-label="Phone" onClick={() => setViewport(VIEWPORT_PRESETS.phone)}>
            <Smartphone />
          </button>
        </div>
        <label className="width-field" title={`Preview width, from ${VIEWPORT_LIMITS.min} to ${VIEWPORT_LIMITS.max} px`}>
          <input
            className="width-input"
            aria-label="Preview width in pixels"
            type="number"
            min={VIEWPORT_LIMITS.min}
            max={VIEWPORT_LIMITS.max}
            value={widthDraft}
            aria-invalid={widthError > 0 || undefined}
            aria-describedby={widthError > 0 ? 'width-error' : undefined}
            onChange={(e) => {
              reported.current = null;
              setWidthError(0);
              setWidthDraft(e.target.value);
            }}
            onBlur={(e) => commitWidth(false, e.currentTarget)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitWidth(true, e.currentTarget);
              if (e.key === 'Escape') {
                reported.current = null;
                setWidthError(0);
                setWidthDraft(String(viewport));
                requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
              }
            }}
          />
          <span className="unit" aria-hidden="true">
            px
          </span>
          {widthError > 0 && (
            <span key={widthError} id="width-error" className="width-error" role="alert">
              <CircleAlert aria-hidden="true" />
              Enter a whole number from {VIEWPORT_LIMITS.min} to {VIEWPORT_LIMITS.max}
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
        {tier !== 'full' && <div className="toolbar-divider" role="presentation" />}
        <button className="icon-btn" disabled={!snap.history.canUndo} title={`${snap.history.undoLabel ? `Undo ${snap.history.undoLabel}` : 'Undo'} (${keys('⌘Z')})`} aria-label={snap.history.undoLabel ? `Undo ${snap.history.undoLabel}` : 'Undo'} onClick={() => projectHistory('undo')}>
          <Undo2 />
        </button>
        <button className="icon-btn" disabled={!snap.history.canRedo} title={`${snap.history.redoLabel ? `Redo ${snap.history.redoLabel}` : 'Redo'} (${keys('⇧⌘Z')})`} aria-label={snap.history.redoLabel ? `Redo ${snap.history.redoLabel}` : 'Redo'} onClick={() => projectHistory('redo')}>
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
            title={`More: zoom (${zoom === 'fit' ? 'fit to window' : `${Math.round(zoom * 100)}%`}) and settings`}
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
