import { useCallback, useEffect, useRef } from 'react';
import { Check, Component, FileText, Images, Layers, Plus, Sparkles, SlidersHorizontal, Palette } from 'lucide-react';
import { instancesOf } from '@engine/tree';
import { openDialogs, openMenus, Tabs } from './components/ui';
import { api, applyOps, getState, setState, toast, useStore } from './store';
import { Toolbar } from './panels/Toolbar';
import { Canvas } from './panels/Canvas';
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
import { SourceModal, PageSourceModal, NewCodeComponentModal } from './panels/SourceModal';
import { CreateComponentModal, DeletePageModal, EditDefinitionModal, HistoryModal } from './panels/Dialogs';
import { deleteSelection, duplicateSelection, moveSelection, askAiAbout, openSiteStyles, insertionPoint, structuralTarget } from './lib/actions';
import { refLabel } from './lib/model';
import type { OwnerRef } from '@shared/types';
import { useTransitionAnnouncement } from './lib/announce';

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

/** What Cmd+C last copied: a section or element on a page, pasted by reference to the page it lives on. */
let copied: { owner: OwnerRef; nodeId: string; label: string; section: boolean } | null = null;

const textSelected = () => {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed;
};

/** Copy the selected section or element (the whole section when a part of one is selected). */
function copySelection(): boolean {
  const s = getState();
  const t = structuralTarget(s.selection);
  if (!t || !s.snapshot) return false;
  if (t.owner.kind !== 'page') {
    toast(t.owner.kind === 'shell' ? 'The shared header and footer are on every page already, so they aren’t copied.' : 'Copy sections from a page. Inside a component, use Duplicate.', 'error');
    return true;
  }
  const page = s.snapshot.state.pages[t.owner.id];
  const label = refLabel(s.snapshot.state, t);
  copied = { owner: t.owner, nodeId: t.nodeId, label, section: page?.rootIds.includes(t.nodeId) ?? false };
  toast(`Copied ${label}. Paste it on any page with ⌘V.`, 'info');
  return true;
}

/** Paste the copy after the selection (or at the end of the page), with new IDs, and select it. */
async function pasteCopied() {
  const s = getState();
  if (!copied || !s.snapshot) return;
  const src = s.snapshot.state.pages[copied.owner.id];
  if (!src?.nodes[copied.nodeId]) {
    toast(`${copied.label} no longer exists, so there is nothing to paste.`, 'error');
    copied = null;
    return;
  }
  const at = insertionPoint(copied.section ? 'section' : 'element');
  if (!at) return;
  const r = await applyOps([{ type: 'node.copy', owner: copied.owner, nodeId: copied.nodeId, toOwner: at.owner, parentId: at.parentId, slot: at.slot, index: at.index }], `Paste ${copied.label}`);
  const id = r?.[0]?.nodeId as string | undefined;
  if (id) setState({ selection: { owner: at.owner, instancePath: [], nodeId: id }, rightTab: 'inspect' });
}

/** Global editor shortcuts. Also called for keys forwarded from the preview frame. */
export function handleShortcut(key: string, mod: boolean, shift: boolean): boolean {
  const s = getState();
  if (mod && key.toLowerCase() === 'z') {
    void (shift ? api.project.redo() : api.project.undo()).then((r) => r && !r.ok && r.error && toast(r.error.message, 'error'));
    return true;
  }
  if (mod && key.toLowerCase() === 'y') {
    void api.project.redo();
    return true;
  }
  if (mod && key.toLowerCase() === 'k') {
    setState({ modal: s.modal?.kind === 'cmdk' ? null : { kind: 'cmdk' } });
    return true;
  }
  if (mod && key.toLowerCase() === 's') {
    // A save notice only describes the moment it was asked for: if a new edit has started by the time the
    // save finishes, say nothing (the toolbar shows "Editing…"); the notice also leaves once editing resumes.
    void api.project.flush().then(() => {
      if (!getState().drafting) toast('All changes are saved on this computer.', 'success');
    });
    return true;
  }
  if (mod && key.toLowerCase() === 'd') {
    void duplicateSelection();
    return true;
  }
  // Copy and paste sections and elements, also between pages. Selected text keeps the ordinary copy.
  // Only while editing a page, with no dialog or menu open: a key forwarded from the preview frame skips the
  // editor's own focus checks, and Preview mode keeps the site's own copy and paste.
  if (mod && !shift && (key.toLowerCase() === 'c' || key.toLowerCase() === 'v') && !textSelected() && s.mode === 'edit' && !s.definitionMode && !s.modal && !openDialogs.length && !openMenus.count) {
    if (key.toLowerCase() === 'c') return copySelection();
    if (!copied) return false;
    void pasteCopied();
    return true;
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
    void deleteSelection();
    return true;
  }
  if (!mod && key === 'Escape') {
    const dm = s.definitionMode;
    const inDef = !!dm && !!s.selection;
    if (s.modal) setState({ modal: null });
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
    void moveSelection(key === 'ArrowUp' ? -1 : 1);
    return true;
  }
  return false;
}

function Resizer({ side }: { side: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null);
  const onDown = useCallback(
    (e: React.PointerEvent) => {
      const startX = e.clientX;
      const s = getState();
      const start = side === 'left' ? s.leftWidth : s.rightWidth;
      ref.current?.classList.add('dragging');
      const move = (ev: PointerEvent) => {
        const d = ev.clientX - startX;
        const w = Math.max(side === 'left' ? 200 : 300, Math.min(side === 'left' ? 420 : 560, start + (side === 'left' ? d : -d)));
        setState(side === 'left' ? { leftWidth: w } : { rightWidth: w });
      };
      const up = () => {
        ref.current?.classList.remove('dragging');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [side]
  );
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const s = getState();
    const d = (e.key === 'ArrowRight' ? 16 : -16) * (side === 'left' ? 1 : -1);
    if (side === 'left') setState({ leftWidth: Math.max(200, Math.min(420, s.leftWidth + d)) });
    else setState({ rightWidth: Math.max(300, Math.min(560, s.rightWidth + d)) });
  };
  const width = useStore((s) => (side === 'left' ? s.leftWidth : s.rightWidth));
  return <div ref={ref} className="resizer" tabIndex={0} onPointerDown={onDown} onKeyDown={onKey} role="separator" aria-orientation="vertical" aria-valuenow={width} aria-valuemin={side === 'left' ? 200 : 300} aria-valuemax={side === 'left' ? 420 : 560} aria-label={`Resize ${side === 'left' ? 'sidebar' : 'right panel'}`} />;
}

export function Editor() {
  const leftTab = useStore((s) => s.leftTab);
  const rightTab = useStore((s) => s.rightTab);
  const leftWidth = useStore((s) => s.leftWidth);
  const rightWidth = useStore((s) => s.rightWidth);
  const modal = useStore((s) => s.modal);
  const dockOpen = useStore((s) => s.dockOpen);
  const aiBusy = useStore((s) => !!s.runStatus);
  const recovery = useStore((s) => s.snapshot?.recoveryNotes);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // An open dialog owns the keyboard; only Cmd/Ctrl+K (toggle the command menu) passes through.
      // An open dialog owns the keyboard. Cmd/Ctrl+K only toggles the command menu itself; it never
      // replaces another dialog (which could hold an unsaved draft).
      if (openMenus.count) return;
      if (openDialogs.length && !(mod && e.key.toLowerCase() === 'k' && getState().modal?.kind === 'cmdk')) return;
      if (isTyping(e) && !(mod && ['k', 'e', 'j', 's'].includes(e.key.toLowerCase()))) return;
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
      // Save from inside a field: commit the field first so the flush includes it.
      if (mod && e.key.toLowerCase() === 's' && isTyping(e)) (e.target as HTMLElement).blur();
      if (handleShortcut(e.key, mod, e.shiftKey)) e.preventDefault();
    };
    const onCmd = (e: Event) => {
      if (openDialogs.length || openMenus.count) return;
      const cmd = (e as CustomEvent).detail;
      if (cmd === 'export') setState({ modal: { kind: 'export' } });
      if (cmd === 'close-project') void api.projects.close();
      // Switching projects from the editor uses the same New project and Trust dialogs as Welcome.
      if (cmd === 'open-project')
        void api.projects.open().then((r) => {
          if (r.needsTrust) {
            setState({ welcomeIntent: { kind: 'trust', ...r.needsTrust } });
            void api.projects.close();
          } else if (!r.ok && r.message) toast(r.message, 'error');
        });
      if (cmd === 'new-project') {
        setState({ welcomeIntent: { kind: 'new' } });
        void api.projects.close();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('builder-command', onCmd);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('builder-command', onCmd);
    };
  }, []);

  useEffect(() => {
    if (recovery?.length) recovery.forEach((n) => toast(n));
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
      if (s.leftTab !== prev.leftTab || s.rightTab !== prev.rightTab) void api.project.saveLocalState({ leftTab: s.leftTab ?? undefined, rightTab: s.rightTab });
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
    <div className={`editor${defining ? ' defining' : ''}${pageInspected ? '' : ' page-quiet'}`}>
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
        <aside className="side-panel" style={{ width: leftWidth, display: leftTab ? undefined : 'none' }} aria-label="Sidebar panel">
          {(['pages', 'layers', 'insert', 'assets'] as const).map((t) => (
            <div key={t} className="side-panel-view" hidden={leftTab !== t}>
              {t === 'pages' && <PagesPanel />}
              {t === 'layers' && <LayersPanel />}
              {t === 'insert' && <InsertPanel />}
              {t === 'assets' && <AssetsPanel />}
            </div>
          ))}
          <Resizer side="left" />
        </aside>
        <Canvas />
        <aside className="dock" style={{ width: rightWidth, display: dockOpen ? undefined : 'none' }}>
          <Resizer side="right" />
          <Tabs<'inspect' | 'chat' | 'styles'>
            className="dock-tabs"
            label="Right panel views"
            idBase="dock"
            value={rightTab}
            onChange={(v) => (v === 'styles' ? openSiteStyles() : setState({ rightTab: v }))}
            options={[
              { value: 'inspect', label: 'Inspector', icon: <SlidersHorizontal /> },
              { value: 'chat', label: 'AI', icon: <Sparkles />, extra: aiBusy ? <span className="live" role="img" aria-label="Working" /> : undefined },
              { value: 'styles', label: 'Site styles', icon: <Palette /> }
            ]}
          />
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div id="dock-panel-inspect" className="dock-panel" role="tabpanel" aria-labelledby="dock-tab-inspect" hidden={rightTab !== 'inspect'}>
              <Inspector />
            </div>
            <div id="dock-panel-chat" className="dock-panel" role="tabpanel" aria-labelledby="dock-tab-chat" hidden={rightTab !== 'chat'}>
              <Chat />
            </div>
            <div id="dock-panel-styles" className="dock-panel" role="tabpanel" aria-labelledby="dock-tab-styles" hidden={rightTab !== 'styles'}>
              <SiteStyles />
            </div>
          </div>
        </aside>
      </div>
      <StatusBar />
      {modal?.kind === 'settings' && <SettingsModal />}
      {modal?.kind === 'export' && <ExportModal />}
      {modal?.kind === 'cmdk' && <CommandMenu />}
      {modal?.kind === 'source' && <SourceModal definitionId={modal.definitionId} />}
      {modal?.kind === 'page-source' && <PageSourceModal pageId={modal.pageId} />}
      {modal?.kind === 'new-code' && <NewCodeComponentModal />}
      {modal?.kind === 'create-component' && <CreateComponentModal target={modal.ref} />}
      {modal?.kind === 'delete-page' && <DeletePageModal pageId={modal.pageId} />}
      {modal?.kind === 'edit-definition' && <EditDefinitionModal target={modal.ref} />}
      {modal?.kind === 'history' && <HistoryModal />}
      {modal?.kind === 'health' && <HealthModal />}
    </div>
  );
}

