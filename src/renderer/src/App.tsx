import { useEffect } from 'react';
import { api, applyAiEvent, getState, setState, useStore } from './store';
import { Welcome } from './Welcome';
import { Editor } from './Editor';
import { ConfirmHost, Toasts } from './components/ui';
import { runInspection } from './lib/inspect';
import { handleShortcut } from './Editor';
import { inlineEdit } from './panels/Canvas';

export function App() {
  const screen = useStore((s) => s.screen);

  useEffect(() => {
    void api.app.getSettings().then((settings) => setState({ settings }));
    void api.ai.providers().then((providers) => setState({ providers }));
    void api.project.snapshot().then((snap) => snap && openSnapshot(snap));
    const offs = [
      api.on('project:changed', (snap) => {
        const s = getState();
        if (s.screen !== 'editor') openSnapshot(snap);
        else {
          // Keep the current page valid.
          const pageId = s.pageId && snap.state.pages[s.pageId] ? s.pageId : snap.state.site.homePageId;
          setState({ snapshot: snap, runtime: snap.runtime, pageId });
        }
      }),
      api.on('project:closed', () => setState({ screen: 'welcome', snapshot: null, selection: null, conversation: null, definitionMode: null })),
      api.on('runtime:status', (runtime) => setState({ runtime })),
      api.on('ai:event', applyAiEvent),
      api.on('inspect:request', (req) => void runInspection(req)),
      api.on('menu:command', (cmd) => window.dispatchEvent(new CustomEvent('builder-command', { detail: cmd }))),
      // While the preview frame has focus, the editor's own keydown handler cannot see keys; the main
      // process forwards the real key presses instead.
      api.on('input:key', (k) => {
        if (getState().screen !== 'editor' || inlineEdit.active || document.activeElement?.tagName !== 'IFRAME') return;
        handleShortcut(k.key, k.meta || k.ctrl, k.shift);
      })
    ];
    return () => offs.forEach((o) => o());
  }, []);

  return (
    <>
      {screen === 'welcome' ? <Welcome /> : <Editor />}
      <Toasts />
      <ConfirmHost />
    </>
  );
}

function openSnapshot(snap: NonNullable<ReturnType<typeof getState>['snapshot']>) {
  const local = snap.localState ?? {};
  setState({
    screen: 'editor',
    snapshot: snap,
    runtime: snap.runtime,
    pageId: local.pageId && snap.state.pages[local.pageId] ? local.pageId : snap.state.site.homePageId,
    viewport: local.viewport ?? 1280,
    zoom: local.zoom ?? 'fit',
    leftTab: (local.leftTab as never) ?? 'pages',
    rightTab: (local.rightTab as never) ?? 'inspect',
    chatDraft: local.chatDraft ?? '',
    selection: null,
    mode: 'edit',
    definitionMode: null
  });
  void api.ai.conversations().then((c) => setState({ conversation: c.active }));
}
