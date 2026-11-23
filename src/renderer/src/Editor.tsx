import { useCallback, useEffect, useRef } from 'react';
import { Component, FileText, Images, Layers, Plus, Sparkles, SlidersHorizontal, Palette } from 'lucide-react';
import { instancesOf } from '@engine/tree';
import { openDialogs, openMenus, Tabs } from './components/ui';
import { api, getState, setState, toast, useStore } from './store';
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
import { deleteSelection, duplicateSelection, moveSelection, askAiAbout } from './lib/actions';

const LEFT_TABS = [
  { id: 'pages', label: 'Pages', icon: <FileText /> },
  { id: 'layers', label: 'Layers', icon: <Layers /> },
  { id: 'insert', label: 'Insert', icon: <Plus /> },
  { id: 'assets', label: 'Assets', icon: <Images /> }
] as const;

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
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
    void api.project.flush().then(() => toast('All changes are saved on this computer.', 'success'));
    return true;
  }
  if (mod && key.toLowerCase() === 'd') {
    void duplicateSelection();
    return true;
  }
  if (mod && key.toLowerCase() === 'j') {
    askAiAbout(s.selection);
    return true;
  }
  if (mod && key === '\\') {
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
    else if (s.definitionMode) setState({ definitionMode: null, pageId: s.definitionMode.returnPageId });
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
      // Save from inside a field: commit the field first so the flush includes it.
      if (mod && e.key.toLowerCase() === 's' && isTyping(e)) (e.target as HTMLElement).blur();
      if (handleShortcut(e.key, mod, e.shiftKey)) e.preventDefault();
    };
    const onCmd = (e: Event) => {
      if (openDialogs.length || openMenus.count) return;
      const cmd = (e as CustomEvent).detail;
      if (cmd === 'export') setState({ modal: { kind: 'export' } });
      if (cmd === 'close-project') void api.projects.close();
      if (cmd === 'open-project') void api.projects.open().then((r) => r.message && toast(r.message, 'error'));
      if (cmd === 'new-project') void api.projects.close();
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
  const defName = useStore((s) => (s.definitionMode ? s.snapshot?.state.components[s.definitionMode.definitionId]?.name ?? 'component' : null));
  const defPlaces = useStore((s) => (s.definitionMode && s.snapshot ? [...new Set(instancesOf(s.snapshot.state, s.definitionMode.definitionId).map((u) => u.label))].join(', ') : ''));
  const defUses = useStore((s) => (s.definitionMode && s.snapshot ? instancesOf(s.snapshot.state, s.definitionMode.definitionId).length : 0));
  const defInfo = defName ? { name: defName, uses: defUses, places: defPlaces } : null;

  return (
    <div className={`editor${defining ? ' defining' : ''}`}>
      <Toolbar />
      {defining && defInfo && (
        <div className="mode-band" role="status">
          <Component />
          <span className="grow">
            <strong>Editing {defInfo.name} everywhere</strong> · used {defInfo.uses === 1 ? 'once' : `${defInfo.uses} times`}, on {defInfo.places || 'no pages yet'}. Placements keep their own text and any changes made to them directly.
          </span>
          <button className="btn btn-sm" onClick={() => setState({ definitionMode: null, pageId: defining.returnPageId, selection: null })}>
            Done editing
          </button>
        </div>
      )}
      <div className="workspace">
        <nav className="rail" aria-label="Sidebar">
          {LEFT_TABS.map((t) => (
            <button key={t.id} className="icon-btn" aria-pressed={leftTab === t.id} title={t.label} aria-label={t.label} onClick={() => setState({ leftTab: leftTab === t.id ? null : t.id })}>
              {t.icon}
            </button>
          ))}
          <div className="rail-sep" role="presentation" />
          <button className="icon-btn shortcut" aria-pressed={dockOpen && rightTab === 'styles'} title="Site styles" aria-label="Site styles" onClick={() => setState(dockOpen && rightTab === 'styles' ? { rightTab: 'inspect' } : { rightTab: 'styles', dockOpen: true })}>
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
            onChange={(v) => setState({ rightTab: v })}
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

