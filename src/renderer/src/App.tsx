import { useEffect } from 'react';
import { api, applyAiEvent, getState, persistChatState, setState, useStore } from './store';
import { cleanDrafts, moveDraft, restorePlan } from './lib/chatDrafts';
import { Welcome } from './Welcome';
import { Editor } from './Editor';
import { ConfirmHost, Toasts } from './components/ui';
import { runInspection } from './lib/inspect';
import { forgetCopy, handleShortcut } from './Editor';
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
      api.on('project:closed', () => {
        forgetCopy();
        opened++;
        setState({ screen: 'welcome', snapshot: null, selection: null, conversation: null, chatDrafts: {}, definitionMode: null });
      }),
      api.on('runtime:status', (runtime) => setState({ runtime })),
      api.on('ai:event', applyAiEvent),
      api.on('inspect:request', (req) => void runInspection(req)),
      api.on('menu:command', (cmd) => window.dispatchEvent(new CustomEvent('builder-command', { detail: cmd }))),
      // While the preview frame has focus, the editor's own keydown handler cannot see keys; the main
      // process forwards the real key presses instead.
      api.on('input:key', (k) => {
        if (getState().screen !== 'editor' || inlineEdit.active || document.activeElement?.tagName !== 'IFRAME') return;
        handleShortcut(k.key, k.meta || k.ctrl, k.shift);
      }),
      useStore.subscribe(persistChatState)
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
    // Drafts and the open conversation are this project's own; the conversation follows once it is loaded.
    chatDrafts: cleanDrafts(local.chatDrafts),
    conversation: null,
    selection: null,
    mode: 'edit',
    definitionMode: null
  });
  void restoreConversation(++opened, local.chatConversation);
}

/** Counts project openings and closings, so a reply that arrives after the project changed is ignored. */
let opened = 0;

/** Show the conversation that was open when the project was last used, with its unsent draft. */
async function restoreConversation(seq: number, remembered: string | undefined) {
  const current = () => seq === opened;
  try {
    const { active, list } = await api.ai.conversations();
    if (!current()) return;
    const saved = list.map((c) => c.id);
    const plan = restorePlan(remembered, active.id, saved, getState().chatDrafts);
    let conversation = active;
    if (plan.kind === 'open') conversation = await api.ai.openConversation(plan.id).catch(() => active);
    // A new conversation left with a draft was never saved: a new one takes its place, and its draft.
    else if (plan.kind === 'fresh' && active.messages.length) conversation = await api.ai.newConversation();
    if (!current()) return;
    setState({ conversation, chatDrafts: plan.kind === 'fresh' ? moveDraft(getState().chatDrafts, plan.from, conversation.id) : getState().chatDrafts });
  } catch {
    // The project closed while its conversations were loading (or they could not be read): nothing to show.
  }
}
