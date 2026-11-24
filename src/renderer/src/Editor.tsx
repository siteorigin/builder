import { useEffect, useRef, useState } from 'react';
import { Check, Component, FileText, Images, Layers, Plus, Sparkles, SlidersHorizontal, Palette } from 'lucide-react';
import { instancesOf } from '@engine/tree';
import { openDialogs, openMenus, Tabs, useWindowWidth } from './components/ui';
import { api, applyOps, errorText, getState, saveLocal, setState, toast, useStore } from './store';
import { Toolbar } from './panels/Toolbar';
import { Canvas, stepVisitor } from './panels/Canvas';
import { HealthModal, StatusBar } from './panels/StatusBar';
import { PagesPanel } from './panels/PagesPanel';
import { LayersPanel } from './panels/LayersPanel';
import { InsertPanel } from './panels/InsertPanel';
import { AssetsPanel } from './panels/AssetsPanel';
import { Inspector } from './panels/Inspector';
import { SiteStyles } from './panels/SiteStyles';
import { Chat } from './panels/Chat';
import { SettingsModal } from './panels/SettingsModal';
import { ExportModal } from './panels/ExportModal';
import { CommandMenu } from './panels/CommandMenu';
import { FindReplaceModal } from './panels/FindReplace';
import { SourceModal, PageSourceModal, NewCodeComponentModal } from './panels/SourceModal';
import { CreateComponentModal, DeletePageModal, EditDefinitionModal, HistoryModal, MakeUniqueModal, RenameComponentModal, SetHomeModal } from './panels/Dialogs';
import { ImportReviewModal } from './panels/ImportReview';
import { PasteStyleModal } from './panels/StylePaste';
import { NewProjectModal, TrustProjectModal } from './components/ProjectDialogs';
import { askAiAbout, deleteLayers, duplicateLayers, moveLayers, openSiteStyles, planLayers } from './lib/actions';
import { copySelection, pasteCopy } from './lib/clipboard';
import { focusedSurface } from './lib/history';
import { visitorStepKey } from '@shared/preview-keys';
import { useTransitionAnnouncement } from './lib/announce';
import { runPhase } from './lib/savestate';
import { PANEL_LIMITS, fitPanels, panelMax, resizePanel, type PanelPrefs, type PanelSide } from './lib/layout';
import { closeProject, endEditingHold, saveNow } from './lib/leave';

const LEFT_TABS = [
  { id: 'pages', label: 'Pages', icon: <FileText /> },
  { id: 'layers', label: 'Layers', icon: <Layers /> },
  { id: 'insert', label: 'Insert', icon: <Plus /> },
  { id: 'assets', label: 'Assets', icon: <Images /> }
] as const;

/** Leave "editing everywhere" for the page it was entered from. When the focused control leaves with the
 *  band (Done editing), focus lands on the page switcher, where the page is named. */
function leaveDefinitionMode() {
  const d = getState().definitionMode;
  if (!d) return;
  const hadFocus = !!document.activeElement?.closest('.mode-band');
  setState({ definitionMode: null, pageId: d.returnPageId, selection: null });
  if (hadFocus) requestAnimationFrame(() => document.querySelector<HTMLElement>('.toolbar .project-title')?.focus());
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

const textSelected = () => {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed;
};

/** Undo or redo the project, from a shortcut or the Edit menu. */
export function projectHistory(action: 'undo' | 'redo') {
  void (action === 'redo' ? api.project.redo() : api.project.undo()).then((r) => r && !r.ok && r.error && toast(r.error.message, 'error'));
}

/** Global editor shortcuts. Also called for keys forwarded from the preview frame. */
export function handleShortcut(key: string, mod: boolean, shift: boolean): boolean {
  const s = getState();
  // While the project is being left, nothing may change it any more (the editor itself is inert then).
  if (s.leaving) return true;
  if (mod && key.toLowerCase() === 'z') {
    projectHistory(shift ? 'redo' : 'undo');
    return true;
  }
  if (mod && key.toLowerCase() === 'y') {
    projectHistory('redo');
    return true;
  }
  if (mod && key.toLowerCase() === 'k') {
    setState({ modal: s.modal?.kind === 'cmdk' ? null : { kind: 'cmdk' } });
    return true;
  }
  // Find and replace in the site's content. Never over another dialog, which could hold an unsaved draft.
  if (mod && shift && key.toLowerCase() === 'f') {
    if (!s.modal && !openDialogs.length && s.snapshot) setState({ modal: { kind: 'find' } });
    return true;
  }
  if (mod && key.toLowerCase() === 's') {
    // Commits the field being typed in (or the text being edited on the page) and waits for it to land. The
    // same settling runs before every way of leaving the project.
    void saveNow();
    return true;
  }
  // Duplicate, delete and move act on every layer selected together in Layers, or on the selection alone.
  if (mod && key.toLowerCase() === 'd') {
    void duplicateLayers();
    return true;
  }
  // Copy and paste sections and elements, also between pages. Selected text keeps the ordinary copy.
  // Only while editing a page, with no dialog or menu open: a key forwarded from the preview frame skips the
  // editor's own focus checks, and Preview mode keeps the site's own copy and paste.
  if (mod && !shift && (key.toLowerCase() === 'c' || key.toLowerCase() === 'v') && !textSelected() && s.mode === 'edit' && !s.definitionMode && !s.modal && !openDialogs.length && !openMenus.count) {
    if (key.toLowerCase() === 'c') return copySelection();
    return pasteCopy();
  }
  if (mod && key.toLowerCase() === 'j') {
    askAiAbout(s.selection);
    return true;
  }
  // With Shift held, macOS reports the backslash key as "|".
  if (mod && (key === '\\' || key === '|')) {
    if (shift) setState({ dockOpen: !s.dockOpen });
    else setState({ leftTab: s.leftTab ? null : 'pages' });
    return true;
  }
  if (mod && key.toLowerCase() === 'e') {
    setState({ modal: { kind: 'export' } });
    return true;
  }
  if (!mod && (key === 'Delete' || key === 'Backspace') && s.selection) {
    void deleteLayers();
    return true;
  }
  if (!mod && key === 'Escape') {
    const dm = s.definitionMode;
    const inDef = !!dm && !!s.selection;
    if (s.modal) setState({ modal: null });
    // Several layers selected together: the first Escape keeps only the one everything follows.
    else if (planLayers(s)?.several) setState({ layerSet: null });
    // While editing a component everywhere, Escape steps to the component overview, then leaves the mode;
    // it never drops back to the placement's page-level editor.
    else if (inDef) setState({ selection: null });
    else if (s.selection?.instancePath.length) {
      const sel = s.selection;
      setState({ selection: { owner: sel.owner, instancePath: sel.instancePath.slice(0, -1), nodeId: sel.instancePath[sel.instancePath.length - 1] } });
    } else if (s.selection) setState({ selection: null });
    else if (s.definitionMode) leaveDefinitionMode();
    return true;
  }
  if (mod && shift && (key === 'ArrowUp' || key === 'ArrowDown')) {
    void moveLayers(key === 'ArrowUp' ? -1 : 1);
    return true;
  }
  return false;
}

/** Each panel's preferred width, or null while it is closed. */
function panelPrefs(): PanelPrefs {
  const s = getState();
  return { left: s.leftTab ? s.leftWidth : null, right: s.dockOpen ? s.rightWidth : null };
}

/** Keep a panel width with the open project. The main process writes it in order, and before the project closes. */
function saveWidth(side: PanelSide) {
  const s = getState();
  saveLocal(side === 'left' ? { leftWidth: s.leftWidth } : { rightWidth: s.rightWidth });
}

/**
 * A splitter. Dragging and the arrow keys start from the width the panel is drawn at and stop where the
 * canvas would drop below its minimum (lib/layout). A step the limit turns into no change leaves the
 * preferred width alone, so a panel squeezed by a small window still gets its room back in a larger one.
 */
function Resizer({ side, width, max }: { side: PanelSide; width: number; max: number }) {
  // `drawn` is the width the drag last left the panel at: if anything else changes it mid-drag (the other
  // panel toggled, the window resized, another project opened), the drag ends rather than jump from a
  // stale starting point.
  const drag = useRef<{ pointer: number; x: number; from: number; drawn: number; changed: boolean } | null>(null);
  const outward = side === 'left' ? 1 : -1;
  /** Make `requested` the panel's preferred width, within its room. Returns the width now drawn, or null when
   *  the limit turns the request into no change. */
  const resize = (requested: number) => {
    const prefs = panelPrefs();
    const w = resizePanel(side, requested, window.innerWidth, prefs);
    if (w === fitPanels(window.innerWidth, prefs)[side]) return null;
    setState(side === 'left' ? { leftWidth: w } : { rightWidth: w });
    return w;
  };
  const end = (el: HTMLDivElement, pointer: number) => {
    const d = drag.current;
    if (d?.pointer !== pointer) return;
    drag.current = null;
    el.classList.remove('dragging');
    if (el.hasPointerCapture(pointer)) el.releasePointerCapture(pointer);
    if (d.changed) saveWidth(side);
  };
  return (
    <div
      className="resizer"
      tabIndex={0}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={PANEL_LIMITS[side].min}
      aria-valuemax={max}
      aria-label={`Resize ${side === 'left' ? 'sidebar' : 'right panel'}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // Captured, so the drag follows the pointer over the preview frame and always hears the release.
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.classList.add('dragging');
        const from = fitPanels(window.innerWidth, panelPrefs())[side];
        drag.current = { pointer: e.pointerId, x: e.clientX, from, drawn: from, changed: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d?.pointer !== e.pointerId) return;
        if (fitPanels(window.innerWidth, panelPrefs())[side] !== d.drawn) return end(e.currentTarget, e.pointerId);
        const w = resize(d.from + (e.clientX - d.x) * outward);
        if (w !== null) {
          d.drawn = w;
          d.changed = true;
        }
      }}
      onPointerUp={(e) => end(e.currentTarget, e.pointerId)}
      onPointerCancel={(e) => end(e.currentTarget, e.pointerId)}
      onLostPointerCapture={(e) => end(e.currentTarget, e.pointerId)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const from = fitPanels(window.innerWidth, panelPrefs())[side];
        if (resize(from + (e.key === 'ArrowRight' ? 16 : -16) * outward) !== null) saveWidth(side);
      }}
    />
  );
}

export function Editor() {
  const leftTab = useStore((s) => s.leftTab);
  const rightTab = useStore((s) => s.rightTab);
  const leftWidth = useStore((s) => s.leftWidth);
  const rightWidth = useStore((s) => s.rightWidth);
  const modal = useStore((s) => s.modal);
  const dockOpen = useStore((s) => s.dockOpen);
  const windowWidth = useWindowWidth();
  // The panels are drawn at their preferred widths while the canvas keeps its minimum; in a smaller window
  // they give way, and get the room back when it grows.
  const prefs: PanelPrefs = { left: leftTab ? leftWidth : null, right: dockOpen ? rightWidth : null };
  const shown = fitPanels(windowWidth, prefs);
  const aiBusy = useStore((s) => !!s.runStatus);
  const aiPhase = useStore((s) => runPhase(s.runStatus));
  const aiReading = useStore((s) => s.runMode === 'ask');
  const leaving = useStore((s) => s.leaving);
  // New project, or a project to trust, chosen from here: asked over this project, which stays open until the new
  // one has opened (#80).
  const [switching, setSwitching] = useState<null | { kind: 'new' } | { kind: 'trust'; dir: string; name: string }>(null);
  // Joined, so each new snapshot (a fresh array over IPC) does not repeat the same notes.
  const recovery = useStore((s) => s.snapshot?.recoveryNotes.join('\n') ?? '');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // An open dialog owns the keyboard; only Cmd/Ctrl+K (toggle the command menu) passes through.
      // An open dialog owns the keyboard. Cmd/Ctrl+K only toggles the command menu itself; it never
      // replaces another dialog (which could hold an unsaved draft).
      if (openMenus.count) return;
      // While a frame has focus, its keys are the page's, and editor shortcuts come from the main process's
      // forwarded copy (see App). A key that still reaches this document then (injected input, a page still
      // loading) must not run a second time, or in Preview at all.
      if (document.activeElement instanceof HTMLIFrameElement) return;
      if (openDialogs.length && !(mod && e.key.toLowerCase() === 'k' && getState().modal?.kind === 'cmdk')) return;
      // Back and Forward through the visitor's journey in Preview, as a browser's keys do, outside text fields and
      // never for a key a control already used (a panel divider takes Alt+Left and Alt+Right to resize).
      const dir = visitorStepKey({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey }, api.platform === 'darwin');
      if (dir && getState().mode === 'preview' && !isTyping(e) && !e.defaultPrevented) {
        e.preventDefault();
        if (!getState().leaving) stepVisitor(dir);
        return;
      }
      // Undo and Redo from a control without text history of its own (a select, a checkbox) undo the project.
      const history = mod && !e.altKey && ['z', 'y'].includes(e.key.toLowerCase()) && focusedSurface(e.target as HTMLElement) !== 'text';
      if (isTyping(e) && !history && !(mod && ['k', 'e', 'j', 's'].includes(e.key.toLowerCase())) && !(mod && e.shiftKey && e.key.toLowerCase() === 'f')) return;
      // Delete removes the canvas selection only when the canvas or Layers has the focus, never from a
      // button or row in another panel (an Assets tile, a page row).
      if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        const t = e.target as HTMLElement;
        if (t !== document.body && !t.closest('[role="tree"], .canvas, .ov-chip')) return;
      }
      // Copy and paste act on the canvas selection from the canvas, Layers, the Pages list (pick a page, then
      // paste) and the selection's own Inspector heading, never from an unrelated control.
      if (mod && ['c', 'v'].includes(e.key.toLowerCase())) {
        const t = e.target as HTMLElement;
        if (t !== document.body && !t.closest('[role="tree"], .canvas, .ov-chip, .pages-list, .insp-head')) return;
      }
      if (handleShortcut(e.key, mod, e.shiftKey)) e.preventDefault();
    };
    // A project being opened from here takes no second Open or New project until it has answered: its reply (a
    // trust prompt, the switch itself) must not land over a dialog started meanwhile.
    let opening = false;
    const onCmd = (e: Event) => {
      if (openDialogs.length || openMenus.count || getState().leaving) return;
      const cmd = (e as CustomEvent).detail;
      if (opening && (cmd === 'open-project' || cmd === 'open-project-folder' || cmd === 'new-project')) return;
      if (cmd === 'export') setState({ modal: { kind: 'export' } });
      // Leaving the project saves what is being typed first (the main process asks; see lib/leave.ts).
      if (cmd === 'close-project') void closeProject();
      // Switching projects from the editor uses the same New project and Trust dialogs as Welcome, shown over
      // this project: cancelling them, or a project that cannot be made or opened, leaves it as it is.
      if (cmd === 'open-project' || cmd === 'open-project-folder') {
        opening = true;
        void api.projects
          .open(undefined, cmd === 'open-project-folder' ? { folder: true } : undefined)
          .then(
          (r) => {
            if (r.needsTrust) setSwitching({ kind: 'trust', ...r.needsTrust });
            else if (!r.ok) {
              // Leaving was agreed but the switch did not happen: this project takes input again.
              endEditingHold();
              if (r.message) toast(r.message, 'error');
            }
          },
          (e: unknown) => {
            endEditingHold();
            toast(`Could not open the project: ${errorText(e)}`, 'error');
          }
          )
          .finally(() => (opening = false));
      }
      if (cmd === 'new-project') setSwitching({ kind: 'new' });
    };
    // The project behind a switch dialog has closed (the switch happened): the dialog was about it, so it goes too.
    const offClosed = api.on('project:closed', () => setSwitching(null));
    window.addEventListener('keydown', onKey);
    window.addEventListener('builder-command', onCmd);
    // A File menu command chosen while there was no window (macOS) is sent now that the editor can act on it.
    api.menuReady();
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('builder-command', onCmd);
      offClosed();
    };
  }, []);

  useEffect(() => {
    if (recovery) recovery.split('\n').forEach((n) => toast(n));
  }, [recovery]);

  // In a small window, starting an edit gives the canvas the Pages list's width (the rail stays, and an
  // explicit reopen is respected for the rest of the session).
  useEffect(() => {
    let userReopened = false;
    return useStore.subscribe((s, prev) => {
      if (s.leftTab && !prev.leftTab) userReopened = true;
      if (!userReopened && s.selection && !prev.selection && s.leftTab === 'pages' && window.innerWidth < 1360) setState({ leftTab: null });
    });
  }, []);

  useEffect(() => {
    const unsub = useStore.subscribe((s, prev) => {
      if (s.leftTab !== prev.leftTab || s.rightTab !== prev.rightTab) saveLocal({ leftTab: s.leftTab ?? undefined, rightTab: s.rightTab });
    });
    return unsub;
  }, []);

  const defining = useStore((s) => s.definitionMode);
  // The page row is outlined only while the page itself is what the inspector shows.
  const pageInspected = useStore((s) => s.mode === 'edit' && !s.selection && s.rightTab === 'inspect');
  const defName = useStore((s) => (s.definitionMode ? s.snapshot?.state.components[s.definitionMode.definitionId]?.name ?? 'component' : null));
  // Where the component is used, by page name, bounded so the band stays one line: "Home and About", "4 pages".
  const defPlaces = useStore((s) => {
    if (!s.definitionMode || !s.snapshot) return '';
    const names = [...new Set(instancesOf(s.snapshot.state, s.definitionMode.definitionId).map((u) => u.label))];
    return names.length > 3 ? `${names.length} pages` : names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? '');
  });
  const defUses = useStore((s) => (s.definitionMode && s.snapshot ? instancesOf(s.snapshot.state, s.definitionMode.definitionId).length : 0));
  const defInfo = defName ? { name: defName, uses: defUses, places: defPlaces } : null;
  // Entering and leaving the mode is announced from a region that is always mounted, so it is heard.
  const modeAnnouncement = useTransitionAnnouncement(defName, (prev, next) => (next ? `Editing ${next} everywhere. Layout and style changes apply wherever it is used.` : prev ? `Finished editing ${prev} everywhere` : null));

  return (
    <div className={`editor${defining ? ' defining' : ''}${pageInspected ? '' : ' page-quiet'}`} inert={leaving || undefined}>
      <Toolbar />
      {defining && defInfo && (
        <div className="mode-band" role="region" aria-label="Editing a component everywhere">
          <Component aria-hidden="true" />
          <p className="mode-band-text">
            <strong>Editing {defInfo.name} everywhere</strong>
            <span>
              {defInfo.uses === 0
                ? 'Layout and style changes apply wherever you add it.'
                : defInfo.uses === 1
                  ? `Layout and style changes apply to this component on ${defInfo.places}. Its text stays the same.`
                  : `Layout and style changes apply to all ${defInfo.uses} uses, on ${defInfo.places}. Each keeps its own text.`}
            </span>
          </p>
          <button className="btn btn-sm mode-band-done" title="Finish editing everywhere. Esc also finishes once nothing is selected." onClick={leaveDefinitionMode}>
            <Check aria-hidden="true" />
            Done editing
          </button>
        </div>
      )}
      <span className="sr-only" role="status">
        {modeAnnouncement}
      </span>
      <div className="workspace">
        <nav className="rail" aria-label="Sidebar">
          {LEFT_TABS.map((t) => (
            <button key={t.id} className="icon-btn" aria-pressed={leftTab === t.id} title={t.label} aria-label={t.label} onClick={() => setState({ leftTab: leftTab === t.id ? null : t.id })}>
              {t.icon}
            </button>
          ))}
          <div className="rail-sep" role="presentation" />
          <button className="icon-btn shortcut" aria-pressed={dockOpen && rightTab === 'styles'} title="Site styles" aria-label="Site styles" onClick={() => (dockOpen && rightTab === 'styles' ? setState({ rightTab: 'inspect' }) : openSiteStyles())}>
            <Palette />
          </button>
        </nav>
        {/* Panels stay mounted while hidden, so a search, expanded layers or scroll position survive switching. */}
        <aside className="side-panel" style={{ width: shown.left, display: leftTab ? undefined : 'none' }} aria-label="Sidebar panel">
          {(['pages', 'layers', 'insert', 'assets'] as const).map((t) => (
            <div key={t} className="side-panel-view" hidden={leftTab !== t}>
              {t === 'pages' && <PagesPanel />}
              {t === 'layers' && <LayersPanel />}
              {t === 'insert' && <InsertPanel />}
              {t === 'assets' && <AssetsPanel narrow={shown.left < 240} />}
            </div>
          ))}
          <Resizer side="left" width={shown.left} max={panelMax('left', windowWidth, prefs)} />
        </aside>
        <Canvas />
        <aside className="dock" style={{ width: shown.right, display: dockOpen ? undefined : 'none' }}>
          <Resizer side="right" width={shown.right} max={panelMax('right', windowWidth, prefs)} />
          {/* Every dock panel stays mounted, so the chat and inspector keep their state while hidden. */}
          <Tabs<'inspect' | 'chat' | 'styles'>
            className="dock-tabs"
            label="Right panel views"
            idBase="dock"
            value={rightTab}
            onChange={(v) => (v === 'styles' ? openSiteStyles() : setState({ rightTab: v }))}
            keepMounted
            panelClassName="dock-panel"
            panelsStyle={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
            options={[
              { value: 'inspect', label: 'Inspector', icon: <SlidersHorizontal />, panel: () => <Inspector /> },
              { value: 'chat', label: 'AI', icon: <Sparkles />, extra: aiBusy ? <span className="live" role="img" aria-label={aiPhase === 'asking' ? 'Waiting for your answer' : aiPhase === 'checking' ? 'Checking' : aiPhase === 'stopping' ? 'Stopping' : aiReading ? 'Reading the site' : 'Working'} /> : undefined, panel: () => <Chat /> },
              { value: 'styles', label: 'Site styles', icon: <Palette />, panel: () => <SiteStyles /> }
            ]}
          />
        </aside>
      </div>
      <StatusBar />
      {modal?.kind === 'settings' && <SettingsModal />}
      {modal?.kind === 'export' && <ExportModal />}
      {modal?.kind === 'cmdk' && <CommandMenu />}
      {modal?.kind === 'find' && <FindReplaceModal initial={modal.query} sample={modal.sample} />}
      {modal?.kind === 'source' && <SourceModal definitionId={modal.definitionId} />}
      {modal?.kind === 'page-source' && <PageSourceModal pageId={modal.pageId} />}
      {modal?.kind === 'new-code' && <NewCodeComponentModal />}
      {modal?.kind === 'create-component' && <CreateComponentModal target={modal.ref} />}
      {modal?.kind === 'make-unique' && <MakeUniqueModal owner={modal.owner} nodeId={modal.nodeId} definitionId={modal.definitionId} />}
      {modal?.kind === 'rename-component' && <RenameComponentModal definitionId={modal.definitionId} />}
      {modal?.kind === 'delete-page' && <DeletePageModal pageId={modal.pageId} />}
      {modal?.kind === 'set-home' && <SetHomeModal pageId={modal.pageId} />}
      {modal?.kind === 'edit-definition' && <EditDefinitionModal target={modal.ref} />}
      {modal?.kind === 'history' && <HistoryModal />}
      {modal?.kind === 'health' && <HealthModal />}
      {modal?.kind === 'import-review' && <ImportReviewModal key={modal.id} id={modal.id} rows={modal.rows} />}
      {modal?.kind === 'paste-style' && <PasteStyleModal target={modal.ref} opening={modal.opening} />}
      {switching?.kind === 'new' && <NewProjectModal onClose={() => setSwitching(null)} />}
      {switching?.kind === 'trust' && <TrustProjectModal project={switching} onClose={() => setSwitching(null)} />}
    </div>
  );
}

