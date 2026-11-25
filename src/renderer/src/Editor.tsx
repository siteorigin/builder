import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, Component, FileText, Images, Layers, Newspaper, Plus, Sparkles, SlidersHorizontal, Palette, SquareDashed } from 'lucide-react';
import { instancesOf } from '@engine/tree';
import { openDialogs, openMenus, Tabs, useMenu, useWindowWidth, type MenuItem } from './components/ui';
import { api, applyOps, errorText, getState, projectHistory, saveLocal, setState, toast, useStore, type LeftTab, type RightTab } from './store';
import { Toolbar } from './panels/Toolbar';
import { Canvas, showEditedPage, stepVisitor, visitAddress } from './panels/Canvas';
import { entryRoute } from '@shared/collections';
import { saveOpenPost } from './lib/post-draft';
import { postWorkspace } from './lib/posts';
import { HealthModal, StatusBar } from './panels/StatusBar';
import { PagesPanel } from './panels/PagesPanel';
import { PostsPanel } from './panels/PostsPanel';
import { PostWriter } from './panels/PostWriter';
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
import { CreateComponentModal, DeletePageModal, EditDefinitionModal, HistoryModal, MakeUniqueModal, NewComponentModal, RenameComponentModal, SetHomeModal, SwapComponentModal } from './panels/Dialogs';
import { ImportReviewModal } from './panels/ImportReview';
import { PostImportReviewModal } from './panels/PostImportReview';
import { PasteStyleModal } from './panels/StylePaste';
import { DuplicateProjectModal, NewProjectModal, TrustProjectModal } from './components/ProjectDialogs';
import { askAiAbout, deleteLayers, duplicateLayers, moveLayers, openComponentStudio, openSiteStyles, planLayers, setMode, ungroupLayers, wrapLayers } from './lib/actions';
import { StudioControls } from './panels/StudioControls';
import { copySelection, pasteCopy } from './lib/clipboard';
import { clipKeyIsEditors } from './lib/clip-keys';
import { focusedSurface } from './lib/history';
import { visitorStepKey } from '@shared/preview-keys';
import { useTransitionAnnouncement } from './lib/announce';
import { runPhase } from './lib/savestate';
import { PANEL_DEFAULTS, PANEL_LIMITS, RAIL_WIDTH, fitPanels, panelMax, resizePanel, type PanelPrefs, type PanelSide } from './lib/layout';
import { closeProject, endEditingHold, saveNow } from './lib/leave';
import { shortcutLabel } from './lib/shortcut-keys';

const LEFT_TABS = [
  { id: 'pages', label: 'Pages', icon: <FileText /> },
  { id: 'posts', label: 'Posts', icon: <Newspaper /> },
  { id: 'layers', label: 'Layers', icon: <Layers /> },
  { id: 'insert', label: 'Insert', icon: <Plus /> },
  { id: 'assets', label: 'Assets', icon: <Images /> }
] as const;

/** Leave "editing everywhere" for the page it was entered from. However it is left (Done editing, Esc), focus
 *  lands on the page switcher, where the page now being edited is named. */
function leaveDefinitionMode() {
  const d = getState().definitionMode;
  if (!d) return;
  setState({ definitionMode: null, pageId: d.returnPageId, selection: null });
  requestAnimationFrame(() => document.querySelector<HTMLElement>('.toolbar .project-title')?.focus());
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

const textSelected = () => {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed;
};

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
  // What is selected on the page under the post writer is out of sight: no key changes it, copies it or asks the AI about
  // it until that page shows again (#578).
  const writing = postWorkspace(s) === 'write';
  // Duplicate, delete and move act on every layer selected together in Layers, or on the selection alone.
  if (mod && key.toLowerCase() === 'd') {
    if (!writing) void duplicateLayers();
    return true;
  }
  // Wrap them in a Stack (Group), and Ungroup a container, the same way (#386). Only while editing: Preview selects nothing.
  if (mod && key.toLowerCase() === 'g') {
    if (!writing && s.mode === 'edit') void (shift ? ungroupLayers() : wrapLayers('stack'));
    return true;
  }
  // Copy and paste sections and elements, also between pages. Only while editing, with no dialog or menu open: a key
  // forwarded from the preview frame skips the editor's own focus checks, and Preview mode keeps the site's own copy and
  // paste. Selected text keeps the ordinary copy, and a copy is taken from a page, never from inside a component edited
  // everywhere. A paste goes where the author is editing (a page, or the component edited everywhere), whatever text
  // is selected: the editor's own fields never get here (see Editor's key handler).
  if (mod && !shift && s.mode === 'edit' && !writing && !s.modal && !openDialogs.length && !openMenus.count) {
    if (key.toLowerCase() === 'c' && !textSelected() && !s.definitionMode) return copySelection();
    if (key.toLowerCase() === 'v') return pasteCopy();
  }
  if (mod && key.toLowerCase() === 'j') {
    askAiAbout(writing ? null : s.selection);
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
  if (!mod && (key === 'Delete' || key === 'Backspace') && s.selection && !writing) {
    void deleteLayers();
    return true;
  }
  if (!mod && key === 'Escape') {
    const dm = s.definitionMode;
    const inDef = !!dm && !!s.selection;
    if (s.modal) setState({ modal: null });
    // The page's selection under the writer is kept for when the page shows again.
    else if (writing) return true;
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
    if (!writing) void moveLayers(key === 'ArrowUp' ? -1 : 1);
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

/** A shortcut as this platform writes it, as the toolbar's hints do. */
const shortcutKeys = (k: string) => shortcutLabel(k, api.platform);

/** Each splitter's name, the panel it sizes (its aria-controls), and its grip's name. */
const SPLIT = {
  left: { label: 'Resize sidebar', panel: 'editor-sidebar', hide: 'Hide sidebar', grip: 'Sidebar width' },
  right: { label: 'Resize right panel', panel: 'editor-dock', hide: 'Hide right panel', grip: 'Right panel width' }
} as const;

/**
 * A panel's seam: a splitter (WAI-ARIA APG window splitter) and its visible grip, drawn on the edge between the
 * panel and the canvas. It lives outside the panel, so it stays at the edge while the panel is hidden: Enter
 * hides the panel and Enter again brings it back, with its view and width, without focus leaving the seam.
 * Dragging (the splitter or the grip) and the arrow keys start from the width the panel is drawn at and stop where
 * the canvas would drop below its minimum (lib/layout). Home and End go to the narrowest and widest the room
 * allows, a double-click on the seam goes back to the default width, and the width menu (a click on the grip, a
 * right-click on the seam, or Shift+F10) offers the same steps without dragging. A step the limit turns into no
 * change leaves the preferred width alone, so a panel squeezed by a small window gets its room back later.
 */
function Seam({ side, width, max, at, restore }: { side: PanelSide; width: number; max: number; at: number; restore: () => void }) {
  // `drawn` is the width the drag last left the panel at: if anything else changes it mid-drag (the other
  // panel toggled, the window resized, another project opened), the drag ends rather than jump from a
  // stale starting point. `moved` is set once the pointer has travelled far enough to be a drag at all.
  const drag = useRef<{ pointer: number; x: number; from: number; drawn: number; moved: boolean; changed: boolean } | null>(null);
  // A press on the grip that became a drag must not also open the menu on its click.
  const dragged = useRef(false);
  const splitter = useRef<HTMLDivElement>(null);
  const menu = useMenu();
  // Whether the open menu came from the grip, which then reports itself expanded.
  const fromGrip = useRef(false);
  // The seam stays lit while it is being dragged or its menu is open, from the splitter or from its grip.
  const [dragging, setDragging] = useState(false);
  const collapsed = width === 0;
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
  const drawn = () => fitPanels(window.innerWidth, panelPrefs())[side];
  /** A one-off resize (a key, the menu), kept with the project when it changed anything. */
  const step = (requested: number) => {
    if (resize(requested) !== null) saveWidth(side);
  };
  /** Back to the default width: the preference itself, so a window too small to show it still gets it back later. */
  const reset = () => {
    setState(side === 'left' ? { leftWidth: PANEL_DEFAULTS.left } : { rightWidth: PANEL_DEFAULTS.right });
    saveWidth(side);
  };
  const hide = () => {
    setState(side === 'left' ? { leftTab: null } : { dockOpen: false });
    // Hidden from the grip's menu, focus would go back to a grip that has gone: the seam takes it instead.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const a = document.activeElement;
        if (!a || a === document.body || (a as HTMLElement).offsetParent === null) splitter.current?.focus();
      })
    );
  };
  const items = (): MenuItem[] => {
    const w = drawn();
    const preferred = side === 'left' ? getState().leftWidth : getState().rightWidth;
    return [
      { heading: `Width: ${w} px` },
      { label: 'Narrower', onSelect: () => step(w - 40), disabled: w <= PANEL_LIMITS[side].min },
      { label: 'Wider', onSelect: () => step(w + 40), disabled: w >= max },
      { label: 'Default width', hint: `${PANEL_DEFAULTS[side]} px`, onSelect: reset, disabled: preferred === PANEL_DEFAULTS[side] },
      { separator: true },
      { label: SPLIT[side].hide, shortcut: shortcutKeys(side === 'left' ? '⌘\\' : '⇧⌘\\'), onSelect: hide }
    ];
  };
  /** The width menu at a point: a right-click on the seam, or Shift+F10 / the context menu key. */
  const openMenu = (x: number, y: number, el: HTMLElement) => {
    fromGrip.current = false;
    menu.open(x, y, items(), SPLIT[side].label, el);
  };
  const end = (el: HTMLElement, pointer: number) => {
    const d = drag.current;
    if (d?.pointer !== pointer) return;
    drag.current = null;
    setDragging(false);
    if (el.hasPointerCapture(pointer)) el.releasePointerCapture(pointer);
    if (d.changed) saveWidth(side);
  };
  /** Dragging, shared by the splitter and its grip. A cancelled or lost press only cleans up. */
  const dragProps = {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0 || collapsed) return;
      // Captured, so the drag follows the pointer over the preview frame and always hears the release.
      e.currentTarget.setPointerCapture(e.pointerId);
      dragged.current = false;
      const from = drawn();
      drag.current = { pointer: e.pointerId, x: e.clientX, from, drawn: from, moved: false, changed: false };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (d?.pointer !== e.pointerId) return;
      if (drawn() !== d.drawn) return end(e.currentTarget, e.pointerId);
      // A few pixels of wobble is still a click.
      if (!d.moved) {
        if (Math.abs(e.clientX - d.x) < 3) return;
        d.moved = dragged.current = true;
        setDragging(true);
      }
      const w = resize(d.from + (e.clientX - d.x) * outward);
      if (w !== null) {
        d.drawn = w;
        d.changed = true;
      }
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => end(e.currentTarget, e.pointerId),
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => end(e.currentTarget, e.pointerId),
    onLostPointerCapture: (e: ReactPointerEvent<HTMLElement>) => end(e.currentTarget, e.pointerId)
  };
  const lit = dragging || menu.isOpen;
  return (
    <div className={`seam ${side}${collapsed ? ' collapsed' : ''}`} style={side === 'left' ? { left: at } : { right: at }}>
      <div
        ref={splitter}
        className={`resizer${lit ? ' dragging' : ''}`}
        tabIndex={0}
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={collapsed ? 0 : PANEL_LIMITS[side].min}
        aria-valuemax={max}
        aria-valuetext={collapsed ? 'Hidden. Press Enter to show it.' : `${width} pixels wide`}
        aria-label={SPLIT[side].label}
        aria-controls={SPLIT[side].panel}
        title={collapsed ? undefined : 'Drag to resize. Double-click for the default width, or right-click for more.'}
        {...dragProps}
        onDoubleClick={collapsed ? undefined : reset}
        onContextMenu={(e) => {
          e.preventDefault();
          if (collapsed) return;
          const r = e.currentTarget.getBoundingClientRect();
          // From the keyboard (the context menu key) the menu opens beside the seam, level with the panel heads.
          if (e.clientX || e.clientY) openMenu(e.clientX, e.clientY, e.currentTarget);
          else openMenu(r.left + r.width / 2, r.top + 48, e.currentTarget);
        }}
        onKeyDown={(e) => {
          // Enter puts the panel away and brings it back; focus stays on the seam either way.
          if (e.key === 'Enter') {
            e.preventDefault();
            return collapsed ? restore() : hide();
          }
          if (collapsed) return;
          if (e.key === 'F10' && e.shiftKey) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            return openMenu(r.left + r.width / 2, r.top + 48, e.currentTarget);
          }
          const w = drawn();
          const next = e.key === 'ArrowRight' ? w + 16 * outward : e.key === 'ArrowLeft' ? w - 16 * outward : e.key === 'Home' ? PANEL_LIMITS[side].min : e.key === 'End' ? max : null;
          if (next === null) return;
          e.preventDefault();
          step(next);
        }}
      />
      {/* The seam's visible handle, level with the panel heads, where the preview's own width grips never are:
          drag it like the splitter, or click it for the width menu (a pointer that cannot drag). The keyboard has
          the splitter, whose focus is drawn on this grip. */}
      {!collapsed && (
        <button
          type="button"
          className={`split-grip${lit ? ' active' : ''}`}
          tabIndex={-1}
          aria-label={SPLIT[side].grip}
          aria-haspopup="menu"
          aria-expanded={menu.isOpen && fromGrip.current}
          title="Drag to resize, or click for width options"
          {...dragProps}
          onClick={(e) => {
            if (dragged.current) return void (dragged.current = false);
            // Below the grip, opening over the canvas side; closing it hands focus to the splitter, the seam's
            // keyboard control (the grip is for the pointer and is not in the Tab order).
            const r = e.currentTarget.getBoundingClientRect();
            menu.open(r.left, r.bottom + 4, items(), SPLIT[side].label, splitter.current);
            fromGrip.current = true;
          }}
        />
      )}
      {menu.node}
    </div>
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
  // The Posts panel's writer takes the canvas's place, except while its post is previewed there.
  const writing = useStore((s) => s.leftTab === 'posts' && s.postView === 'write');
  const aiBusy = useStore((s) => !!s.runStatus);
  const aiPhase = useStore((s) => runPhase(s.runStatus));
  const aiReading = useStore((s) => s.runMode === 'ask');
  // What the AI tab's mark says while a run goes on: a solid pulse while it works, a ring while it waits for you.
  const aiLabel = aiPhase === 'asking' ? 'Waiting for your answer' : aiPhase === 'checking' ? 'Checking' : aiPhase === 'stopping' ? 'Stopping' : aiReading ? 'Reading the site' : 'Working';
  const leaving = useStore((s) => s.leaving);
  // New project, or a project to trust, chosen from here: asked over this project, which stays open until the new
  // one has opened (#80).
  const [switching, setSwitching] = useState<null | { kind: 'new' } | { kind: 'duplicate' } | { kind: 'trust'; dir: string; name: string }>(null);
  // A project being opened from here takes no second Open or New project until it has answered: its reply (a
  // trust prompt, the switch itself) must not land over a dialog started meanwhile.
  const openingProject = useRef(false);
  // Open a project from here (a chooser with no `dir`): cancelling, or a project that cannot be opened, leaves this
  // one as it is. Duplicate's Open copy uses it too.
  const openProject = (dir?: string, opts?: { folder?: boolean }) => {
    if (openingProject.current) return;
    openingProject.current = true;
    void api.projects
      .open(dir, opts)
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
      .finally(() => (openingProject.current = false));
  };
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
      // Wrap and Ungroup are Cmd/Ctrl+G and Shift+Cmd/Ctrl+G alone: with Alt it is another key (AltGr on some layouts).
      if (mod && e.altKey && e.key.toLowerCase() === 'g') return;
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
      // The panel shortcuts (Cmd/Ctrl+\ and Shift+Cmd/Ctrl+\) type nothing, so they work from a field too.
      if (isTyping(e) && !history && !(mod && ['k', 'e', 'j', 's', '\\', '|'].includes(e.key.toLowerCase())) && !(mod && e.shiftKey && e.key.toLowerCase() === 'f')) return;
      // Delete removes the canvas selection only when the canvas or Layers has the focus, never from a
      // button or row in another panel (an Assets tile, a page row).
      if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        const t = e.target as HTMLElement;
        if (t !== document.body && !t.closest('[role="tree"], .canvas, .ov-chip')) return;
      }
      // Copy and paste of sections and elements: Copy only from the page, Layers and the selection's own controls, Paste
      // from any control that takes no typing (lib/clip-keys).
      if (mod && ['c', 'v'].includes(e.key.toLowerCase()) && !clipKeyIsEditors(e.key.toLowerCase() === 'c' ? 'copy' : 'paste', e.target as HTMLElement, document.body)) return;
      if (handleShortcut(e.key, mod, e.shiftKey)) e.preventDefault();
    };
    const onCmd = (e: Event) => {
      if (openDialogs.length || openMenus.count || getState().leaving) return;
      const cmd = (e as CustomEvent).detail;
      if (openingProject.current && (cmd === 'open-project' || cmd === 'open-project-folder' || cmd === 'new-project' || cmd === 'duplicate-project')) return;
      if (cmd === 'export') setState({ modal: { kind: 'export' } });
      // Leaving the project saves what is being typed first (the main process asks; see lib/leave.ts).
      if (cmd === 'close-project') void closeProject();
      // Switching projects from the editor uses the same New project and Trust dialogs as Welcome, shown over
      // this project: cancelling them, or a project that cannot be made or opened, leaves it as it is.
      if (cmd === 'open-project' || cmd === 'open-project-folder') openProject(undefined, cmd === 'open-project-folder' ? { folder: true } : undefined);
      if (cmd === 'new-project') setSwitching({ kind: 'new' });
      if (cmd === 'duplicate-project') setSwitching({ kind: 'duplicate' });
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

  // A post's preview ends however it is left (Back to writing, Edit, another post opened): the canvas goes back to the
  // page the editor shows, and the writer shows again.
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        // Where the last preview's visitor went is not where the next one starts: the post is on its way again.
        if (s.postView !== prev.postView && s.postPreviewAt !== null) setState({ postPreviewAt: null });
        if (prev.postView === 'preview' && s.postView === 'write') {
          if (s.mode === 'preview') setMode('edit');
          showEditedPage();
        } else if (s.postView === 'preview' && prev.mode === 'preview' && s.mode === 'edit') setState({ postView: 'write' });
        // Preview chosen in the toolbar while writing: the post open is what is previewed, once what was typed is saved.
        else if (prev.mode === 'edit' && s.mode === 'preview' && s.leftTab === 'posts' && s.postView === 'write') {
          if (!s.post) return setState({ postView: 'preview' });
          // The writer stays until what it holds is saved: text that could not be stays in view, with its note.
          const asked = s.post;
          void saveOpenPost().then((saved) => {
            const now = getState();
            if (now.mode !== 'preview' || now.leftTab !== 'posts' || now.postView !== 'write') return;
            // Another post opened while this one saved: the preview was this one's, and the other's text may not be saved.
            if (now.post?.collectionId !== asked.collectionId || now.post?.entryId !== asked.entryId) return setMode('edit');
            if (!saved) {
              setMode('edit');
              return toast('Part of the post is not saved yet, so the preview would not show it. See the note above its text.', 'error');
            }
            setState({ postView: 'preview' });
            const c = now.post && now.snapshot?.state.collections[now.post.collectionId];
            const e = c && now.post && Object.hasOwn(c.entries, now.post.entryId) ? c.entries[now.post.entryId] : undefined;
            // Unless the preview ended meanwhile (a page chosen): the canvas stays on that page, which the editor names.
            if (c && e) requestAnimationFrame(() => getState().postView === 'preview' && getState().post?.entryId === e.id && visitAddress(entryRoute(c, e)));
          });
        }
      }),
    []
  );

  // A panel that closes around the focused control (its shortcut, its splitter's menu) hands focus to the
  // control that opens it again: the view's rail button, or the toolbar's Right panel toggle.
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        const a = document.activeElement;
        const label = LEFT_TABS.find((t) => t.id === prev.leftTab)?.label;
        if (prev.leftTab && !s.leftTab && label && a?.closest('.side-panel')) requestAnimationFrame(() => document.querySelector<HTMLElement>(`.rail [aria-label="${label}"]`)?.focus());
        if (prev.dockOpen && !s.dockOpen && a?.closest('.dock')) requestAnimationFrame(() => document.querySelector<HTMLElement>('.toolbar [aria-label="Right panel"]')?.focus());
      }),
    []
  );

  // The Site styles shortcut gives back what it borrowed, so pressing it twice leaves the shell as it was: the
  // dock it opened is put away again, or the view it covered comes back. Any other change to the dock (its
  // toggle, another tab) makes the dock the user's again.
  const stylesBorrowed = useRef<{ opened: boolean; tab: RightTab } | null>(null);
  // The sidebar view a seam brings back after Enter hid the sidebar.
  const lastLeftTab = useRef<LeftTab>(leftTab ?? 'pages');
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.dockOpen !== prev.dockOpen || (s.rightTab !== prev.rightTab && prev.rightTab === 'styles')) stylesBorrowed.current = null;
        if (s.leftTab) lastLeftTab.current = s.leftTab;
      }),
    []
  );

  // The rail is one stop in the Tab order (WAI-ARIA APG toolbar): the button last focused, else the open view.
  const [railStop, setRailStop] = useState<string | null>(null);
  const railIds = [...LEFT_TABS.map((t) => t.id as string), 'styles'];
  const railTab = railStop ?? leftTab ?? 'pages';
  const onRailKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = railIds.indexOf(railTab);
    const n = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? railIds.length - 1 : null;
    if (n === null) return;
    e.preventDefault();
    const id = railIds[(n + railIds.length) % railIds.length];
    setRailStop(id);
    e.currentTarget.querySelector<HTMLElement>(`[data-rail="${id}"]`)?.focus();
  };

  const defining = useStore((s) => s.definitionMode);
  // The page row is outlined only while the page itself is what the inspector shows, on screen.
  const pageInspected = useStore((s) => s.mode === 'edit' && !s.selection && !s.definitionMode && s.dockOpen && s.rightTab === 'inspect' && !postWorkspace(s));
  const defName = useStore((s) => (s.definitionMode ? s.snapshot?.state.components[s.definitionMode.definitionId]?.name ?? 'component' : null));
  // Where the component is used, by page name, bounded so the band stays one line: "Home and About", "4 pages".
  const defPlaces = useStore((s) => {
    if (!s.definitionMode || !s.snapshot) return '';
    const names = [...new Set(instancesOf(s.snapshot.state, s.definitionMode.definitionId).map((u) => u.label))];
    return names.length > 3 ? `${names.length} pages` : names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? '');
  });
  const defUses = useStore((s) => (s.definitionMode && s.snapshot ? instancesOf(s.snapshot.state, s.definitionMode.definitionId).length : 0));
  const defInfo = defName ? { name: defName, uses: defUses, places: defPlaces } : null;
  // Component Studio shows the component on its own (see lib/studio); a project component edited on a page can open there.
  const studio = useStore((s) => !!s.definitionMode?.studio);
  const studied = useStore((s) => (s.definitionMode && s.snapshot && Object.hasOwn(s.snapshot.state.components, s.definitionMode.definitionId) ? s.snapshot.state.components[s.definitionMode.definitionId] : undefined));
  // Entering and leaving the mode is announced from a region that is always mounted, so it is heard.
  const modeAnnouncement = useTransitionAnnouncement(defName, (prev, next) => (next ? `Editing ${next} everywhere. Layout and style changes apply wherever it is used.` : prev ? `Finished editing ${prev} everywhere` : null));

  return (
    <div className={`editor${defining ? ' defining' : ''}${pageInspected ? '' : ' page-quiet'}${leftTab ? '' : ' no-sidebar'}`} inert={leaving || undefined}>
      <Toolbar />
      {defining && defInfo && (
        <div className={`mode-band${studio ? ' studio' : ''}`} role="region" aria-label={studio ? 'Component Studio' : 'Editing a component everywhere'}>
          {studio ? <SquareDashed aria-hidden="true" /> : <Component aria-hidden="true" />}
          <p className="mode-band-text">
            <strong>{studio ? `${defInfo.name} in Component Studio` : `Editing ${defInfo.name} everywhere`}</strong>
            <span>
              {studio
                ? `${defInfo.uses === 0 ? 'Not placed anywhere yet.' : defInfo.uses === 1 ? `Used on ${defInfo.places}.` : `Used ${defInfo.uses} times, on ${defInfo.places}.`} Changes apply everywhere; the look and content shown here are only for trying it.`
                : defInfo.uses === 0
                  ? 'Layout and style changes apply wherever you add it.'
                  : defInfo.uses === 1
                    ? `Layout and style changes apply to this component on ${defInfo.places}. Its text stays the same.`
                    : `Layout and style changes apply to all ${defInfo.uses} uses, on ${defInfo.places}. Each keeps its own text.`}
            </span>
          </p>
          {studio && studied && <StudioControls def={studied} />}
          {!studio && studied?.owner === 'project' && (
            <button className="btn btn-sm mode-band-studio" title="Show the component on its own, to try its variants, long or empty content and widths" onClick={() => openComponentStudio(studied.id)}>
              <SquareDashed aria-hidden="true" />
              Open in Component Studio
            </button>
          )}
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
        <div className="rail" role="toolbar" aria-orientation="vertical" aria-label="Panels" onKeyDown={onRailKey}>
          {LEFT_TABS.map((t) => (
            <button
              key={t.id}
              data-rail={t.id}
              className="icon-btn"
              tabIndex={railTab === t.id ? 0 : -1}
              aria-pressed={leftTab === t.id}
              aria-controls={leftTab === t.id ? 'editor-sidebar' : undefined}
              title={t.label}
              aria-label={t.label}
              onFocus={() => setRailStop(t.id)}
              onClick={() => setState({ leftTab: leftTab === t.id ? null : t.id })}
            >
              {t.icon}
            </button>
          ))}
          <div className="rail-sep" role="separator" aria-orientation="horizontal" />
          <button
            data-rail="styles"
            className="icon-btn shortcut"
            tabIndex={railTab === 'styles' ? 0 : -1}
            aria-pressed={dockOpen && rightTab === 'styles'}
            aria-controls={dockOpen && rightTab === 'styles' ? 'editor-dock' : undefined}
            title="Site styles"
            aria-label="Site styles"
            onFocus={() => setRailStop('styles')}
            onClick={() => {
              const lent = stylesBorrowed.current;
              if (dockOpen && rightTab === 'styles') return setState(lent?.opened ? { dockOpen: false, rightTab: lent.tab } : { rightTab: lent?.tab ?? 'inspect' });
              const before = { opened: !dockOpen, tab: rightTab };
              openSiteStyles();
              stylesBorrowed.current = before;
            }}
          >
            <Palette />
          </button>
        </div>
        {/* Panels stay mounted while hidden, so a search, expanded layers or scroll position survive switching. */}
        <aside id="editor-sidebar" className={`side-panel${shown.left < 250 ? ' narrow' : ''}`} style={{ width: shown.left, display: leftTab ? undefined : 'none' }} aria-label="Sidebar">
          {(['pages', 'posts', 'layers', 'insert', 'assets'] as const).map((t) => (
            <div key={t} className="side-panel-view" hidden={leftTab !== t}>
              {t === 'pages' && <PagesPanel />}
              {t === 'posts' && <PostsPanel />}
              {t === 'layers' && <LayersPanel />}
              {t === 'insert' && <InsertPanel />}
              {t === 'assets' && <AssetsPanel narrow={shown.left < 240} />}
            </div>
          ))}
        </aside>
        <Seam side="left" width={shown.left} max={panelMax('left', windowWidth, prefs)} at={RAIL_WIDTH + shown.left} restore={() => setState({ leftTab: lastLeftTab.current })} />
        {/* While a post is being written, the canvas stays loaded under the writer, ready for Preview in site. */}
        <div className="canvas-holder" inert={writing || undefined}>
          <Canvas />
        </div>
        <div className="post-writer-holder" style={{ left: RAIL_WIDTH + shown.left, right: shown.right }} hidden={!writing}>
          <PostWriter hidden={!writing} />
        </div>
        <Seam side="right" width={shown.right} max={panelMax('right', windowWidth, prefs)} at={shown.right} restore={() => setState({ dockOpen: true })} />
        <aside id="editor-dock" className="dock" style={{ width: shown.right, display: dockOpen ? undefined : 'none' }} aria-label="Right panel">
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
              { value: 'chat', label: aiBusy ? <span title={`AI: ${aiLabel}`}>AI</span> : 'AI', icon: <Sparkles />, extra: aiBusy ? <span className={`live${aiPhase === 'asking' ? ' asking' : ''}`} role="img" aria-label={aiLabel} title={`AI: ${aiLabel}`} /> : undefined, panel: () => <Chat /> },
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
      {modal?.kind === 'new-component' && <NewComponentModal />}
      {modal?.kind === 'create-component' && <CreateComponentModal target={modal.ref} />}
      {modal?.kind === 'make-unique' && <MakeUniqueModal owner={modal.owner} nodeId={modal.nodeId} definitionId={modal.definitionId} />}
      {modal?.kind === 'swap-component' && <SwapComponentModal owner={modal.owner} nodeId={modal.nodeId} definitionId={modal.definitionId} />}
      {modal?.kind === 'rename-component' && <RenameComponentModal definitionId={modal.definitionId} />}
      {modal?.kind === 'delete-page' && <DeletePageModal pageId={modal.pageId} />}
      {modal?.kind === 'set-home' && <SetHomeModal pageId={modal.pageId} />}
      {modal?.kind === 'edit-definition' && <EditDefinitionModal target={modal.ref} />}
      {modal?.kind === 'history' && <HistoryModal />}
      {modal?.kind === 'health' && <HealthModal />}
      {modal?.kind === 'import-review' && <ImportReviewModal key={modal.id} id={modal.id} rows={modal.rows} />}
      {modal?.kind === 'post-import' && <PostImportReviewModal key={modal.preview.id} preview={modal.preview} opening={modal.opening} />}
      {modal?.kind === 'paste-style' && <PasteStyleModal target={modal.ref} opening={modal.opening} />}
      {switching?.kind === 'new' && <NewProjectModal onClose={() => setSwitching(null)} />}
      {switching?.kind === 'duplicate' && (
        <DuplicateProjectModal
          onClose={() => setSwitching(null)}
          onOpen={(dir) => {
            setSwitching(null);
            openProject(dir);
          }}
        />
      )}
      {switching?.kind === 'trust' && <TrustProjectModal project={switching} onClose={() => setSwitching(null)} />}
    </div>
  );
}

