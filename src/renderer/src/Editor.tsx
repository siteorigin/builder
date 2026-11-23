import { useCallback, useEffect, useRef } from 'react';
import { Component, FileText, Images, Layers, Plus, Sparkles, SlidersHorizontal, Palette } from 'lucide-react';
import { api, getState, setState, toast, useStore } from './store';
import { Toolbar } from './panels/Toolbar';
import { Canvas } from './panels/Canvas';
import { StatusBar } from './panels/StatusBar';
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
    void api.project.flush().then(() => toast('All changes are saved.'));
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
    setState({ leftTab: s.leftTab ? null : 'pages' });
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
    if (s.modal) setState({ modal: null });
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
  return <div ref={ref} className="resizer" onPointerDown={onDown} role="separator" aria-orientation="vertical" aria-label={`Resize ${side} panel`} />;
}

export function Editor() {
  const leftTab = useStore((s) => s.leftTab);
  const rightTab = useStore((s) => s.rightTab);
  const leftWidth = useStore((s) => s.leftWidth);
  const rightWidth = useStore((s) => s.rightWidth);
  const modal = useStore((s) => s.modal);
  const aiBusy = useStore((s) => !!s.runStatus);
  const recovery = useStore((s) => s.snapshot?.recoveryNotes);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (isTyping(e) && !(mod && ['k', 'e', 'j'].includes(e.key.toLowerCase()))) return;
      if (handleShortcut(e.key, mod, e.shiftKey)) e.preventDefault();
    };
    const onCmd = (e: Event) => {
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

  useEffect(() => {
    const unsub = useStore.subscribe((s, prev) => {
      if (s.leftTab !== prev.leftTab || s.rightTab !== prev.rightTab) void api.project.saveLocalState({ leftTab: s.leftTab ?? undefined, rightTab: s.rightTab });
    });
    return unsub;
  }, []);

  return (
    <div className="editor">
      <Toolbar />
      <div className="workspace">
        <nav className="rail" aria-label="Sidebar">
          {LEFT_TABS.map((t) => (
            <button key={t.id} className="icon-btn" aria-pressed={leftTab === t.id} title={t.label} aria-label={t.label} onClick={() => setState({ leftTab: leftTab === t.id ? null : t.id })}>
              {t.icon}
            </button>
          ))}
          <div style={{ height: 1, width: 22, background: 'var(--border)', margin: '6px 0' }} />
          <button className="icon-btn" aria-pressed={rightTab === 'styles'} title="Site styles" aria-label="Site styles" onClick={() => setState({ rightTab: 'styles' })}>
            <Palette />
          </button>
        </nav>
        {leftTab && (
          <aside className="side-panel" style={{ width: leftWidth }}>
            {leftTab === 'pages' && <PagesPanel />}
            {leftTab === 'layers' && <LayersPanel />}
            {leftTab === 'insert' && <InsertPanel />}
            {leftTab === 'assets' && <AssetsPanel />}
            <Resizer side="left" />
          </aside>
        )}
        <Canvas />
        <aside className="dock" style={{ width: rightWidth }}>
          <Resizer side="right" />
          <div className="dock-tabs" role="tablist">
            <button className="dock-tab" role="tab" aria-selected={rightTab === 'inspect'} onClick={() => setState({ rightTab: 'inspect' })}>
              <SlidersHorizontal /> Inspector
            </button>
            <button className="dock-tab" role="tab" aria-selected={rightTab === 'chat'} onClick={() => setState({ rightTab: 'chat' })}>
              <Sparkles /> AI {aiBusy && <span className="live" aria-label="Working" />}
            </button>
            <button className="dock-tab" role="tab" aria-selected={rightTab === 'styles'} onClick={() => setState({ rightTab: 'styles' })}>
              <Palette /> Styles
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: rightTab === 'inspect' ? 'contents' : 'none' }}>{rightTab === 'inspect' && <Inspector />}</div>
            <div style={{ display: rightTab === 'chat' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
              <Chat />
            </div>
            {rightTab === 'styles' && <SiteStyles />}
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
    </div>
  );
}

void Component;
