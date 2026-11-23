import { useEffect } from 'react';
import { api, applyAiEvent, getState, persistChatState, saveLocal, setState, toast, useStore } from './store';
import { cleanDrafts, moveDraft, restorePlan } from './lib/chatDrafts';
import { Welcome } from './Welcome';
import { Editor } from './Editor';
import { ConfirmHost, Toasts, openDialogs, openMenus } from './components/ui';
import { runInspection } from './lib/inspect';
import { restorePanelWidth } from './lib/layout';
import { forgetCopy, handleShortcut, projectHistory } from './Editor';
import { frameTextFocus, inlineEdit } from './panels/Canvas';
import { focusedSurface, forwardedKeyRuns, menuHistoryOwner, type HistoryContext } from './lib/history';
import { endEditingHold, prepareToLeave, projectClosed } from './lib/leave';

/** What Undo and Redo, and keys forwarded from the preview frame, act on right now. */
function historyContext(): HistoryContext {
  const s = getState();
  return { editor: s.screen === 'editor', mode: s.mode, inlineEdit: inlineEdit.active, frameText: frameTextFocus.active, overlay: openDialogs.length > 0 || openMenus.count > 0, focus: focusedSurface(document.activeElement as HTMLElement | null) };
}

export function App() {
  const screen = useStore((s) => s.screen);

  useEffect(() => {
    void api.app.getSettings().then((settings) => setState({ settings }));
    void api.ai.providers().then((providers) => setState({ providers }));
    void api.project.snapshot().then((snap) => snap && openSnapshot(snap));
    const offs = [
      api.on('project:changed', (snap) => {
        const s = getState();
        // Another opening (of another project, or of this one again) loads its own state, drafts included. A project
        // that is closing names no opening, and is not one.
        if (s.screen !== 'editor' || (snap.workspaceKey && snap.workspaceKey !== s.snapshot?.workspaceKey)) openSnapshot(snap);
        else {
          // Keep the current page valid.
          const pageId = s.pageId && snap.state.pages[s.pageId] ? s.pageId : snap.state.site.homePageId;
          setState({ snapshot: snap, runtime: snap.runtime, pageId });
        }
      }),
      api.on('project:closed', () => {
        forgetCopy();
        opened++;
        projectClosed();
        setState({ screen: 'welcome', snapshot: null, selection: null, conversation: null, chatDrafts: {}, definitionMode: null });
      }),
      // Before the project is closed, switched or the app quits: save what is being typed, or ask the author.
      api.on('lifecycle:request', ({ requestId }) => {
        void prepareToLeave(() => api.leaveResult(requestId, 'asking')).then(
          (leave) => api.leaveResult(requestId, leave ? 'leave' : 'stay'),
          // Something went wrong while saving: never treat that as permission to drop what was typed.
          (e: unknown) => {
            endEditingHold();
            toast(`Your changes could not be checked before leaving${e instanceof Error ? `: ${e.message}` : '.'} Try again.`, 'error');
            api.leaveResult(requestId, 'stay');
          }
        );
      }),
      api.on('runtime:status', (runtime) => setState({ runtime })),
      api.on('ai:event', applyAiEvent),
      api.on('inspect:request', (req) => void runInspection(req)),
      api.on('menu:command', (cmd) => window.dispatchEvent(new CustomEvent('builder-command', { detail: cmd }))),
      // Edit → Undo and Redo, and their keys when nothing on the page took them: a text field (a dialog's too,
      // so this runs before the editor's dialog guard) keeps its own history, the editor undoes the project.
      api.on('menu:history', ({ action, fromKey }) => {
        const owner = menuHistoryOwner(historyContext(), fromKey);
        if (owner === 'text') void (action === 'redo' ? api.edit.redo() : api.edit.undo());
        else if (owner === 'project') projectHistory(action);
      }),
      // While the preview frame has focus, the editor's own keydown handler cannot see keys; the main
      // process forwards the real key presses instead. In Preview the page is the visitor's.
      api.on('input:key', (k) => {
        if (forwardedKeyRuns(historyContext(), k.key, k.meta || k.ctrl)) handleShortcut(k.key, k.meta || k.ctrl, k.shift);
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
    // Every project opens with its own panel widths (or the defaults), never the last project's.
    leftWidth: restorePanelWidth('left', local.leftWidth),
    rightWidth: restorePanelWidth('right', local.rightWidth),
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
    // The project closed while its conversations were loading: nothing to show. If they could not be read, a new
    // conversation still lets the panel work.
    if (!current()) return;
    const fresh = await api.ai.newConversation().catch(() => null);
    if (!fresh || !current()) return;
    setState({ conversation: fresh });
    // Still the one to restore next time, once the conversations can be read again.
    if (remembered) saveLocal({ chatConversation: remembered });
  }
}
