import { useEffect, useState } from 'react';
import { api, applyAiEvent, getState, persistChatState, persistPlaces, projectHistory, restoreRightTab, saveLocal, setState, toast, useStore } from './store';
import { cleanDrafts, cleanImages, moveDraft, moveImages, restorePlan } from './lib/chatDrafts';
import { Welcome } from './Welcome';
import { Editor } from './Editor';
import { UnpackingModal } from './components/ProjectDialogs';
import { Toasts, openDialogs, openMenus } from './components/ui';
import { ConfirmHost } from './components/ConfirmDialog';
import { forgetComponentThumbs } from './components/ComponentThumb';
import { cancelComponentPreviews, runComponentPreviews, runInspection } from './lib/inspect';
import { restorePanelWidth, restoreViewport, restoreZoom } from './lib/layout';
import { handleShortcut } from './Editor';
import { forgetCopy } from './lib/clipboard';
import { frameTextFocus, inlineEdit, stepVisitor } from './panels/Canvas';
import { focusedSurface, forwardedKeyRuns, forwardedVisitorStep, menuHistoryOwner, type HistoryContext } from './lib/history';
import { runWriterHistory } from './lib/post-draft';
import { endEditingHold, forgetKeptDrafts, prepareToLeave, projectClosed } from './lib/leave';
import { keepViewValid } from './lib/model';
import { keepSeoSubject } from './lib/seo-view';
import { placeOn, readPlaces } from './lib/page-place';
import { startEditorFonts } from './lib/editor-fonts';
import { isAskAiKey } from './lib/ask-ai-key';
import { followLive, syncPresence } from './lib/live-host';
import { projectDisplayName, windowTitle } from '@shared/project-name';

/** What Undo and Redo, and keys forwarded from the preview frame, act on right now. */
function historyContext(): HistoryContext {
  const s = getState();
  return { editor: s.screen === 'editor', mode: s.mode, inlineEdit: inlineEdit.active, frameText: frameTextFocus.active, overlay: openDialogs.length > 0 || openMenus.count > 0, focus: focusedSurface(document.activeElement as HTMLElement | null) };
}

export function App() {
  const screen = useStore((s) => s.screen);
  // No screen is shown until the project that is open (if any) is known, so a File menu command waiting for this
  // window reaches the screen that will stay: Welcome, or the editor of a project left open with no window (macOS).
  const [booted, setBooted] = useState(false);

  // The window's title follows the page's (Electron carries it over), so a window opened again over an open project,
  // or a reloaded page, names it too.
  const title = useStore((s) => windowTitle(s.screen === 'editor' && s.snapshot ? projectDisplayName(s.snapshot.state) : null));
  useEffect(() => {
    document.title = title;
  }, [title]);

  // The project's imported fonts, loaded into the editor for its samples.
  useEffect(() => startEditorFonts(), []);

  useEffect(() => {
    void api.app.getSettings().then((settings) => setState({ settings }));
    void api.ai.providers().then((providers) => setState({ providers }));
    // A project opened or closed before the first snapshot arrives is newer than that snapshot.
    let superseded = false;
    let unmounted = false;
    const offs = [
      api.on('project:changed', (snap) => {
        superseded = true;
        const s = getState();
        // Another opening (of another project, or of this one again) loads its own state, drafts included. A project
        // that is closing names no opening, and is not one.
        if (s.screen !== 'editor' || (snap.workspaceKey && snap.workspaceKey !== s.snapshot?.workspaceKey)) openSnapshot(snap);
        else {
          // Keep the current page, the one editing everywhere returns to, and the selection valid, in the same update
          // as the snapshot, so nothing is ever shown or sent for what has gone. A selection whose page, element, part
          // or list item went (an Undo took it away) goes with it, so a Redo that brings it back never leaves it
          // selected, and acted on, while the author has moved on; a component edited everywhere that went ends that mode.
          setState({ snapshot: snap, runtime: snap.runtime, ...keepViewValid(snap.state, s), ...keepSeoSubject(snap.state, s.seoSubject) });
        }
      }),
      api.on('project:closed', () => {
        superseded = true;
        forgetCopy();
        forgetComponentThumbs();
        opened++;
        projectClosed();
        // Held edits and the last AI outcome belong to the project that closed.
        setState({ screen: 'welcome', snapshot: null, selection: null, pagePlaces: {}, previewReturn: null, seoSubject: null, conversation: null, chatDrafts: {}, chatImages: {}, chatRequest: null, definitionMode: null, templateMode: null, heldEdits: [], aiOutcome: null, inspectorFocus: null, styleCopy: null, renameOffer: null, shareOpen: false, ...openingModalsClosed() });
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
      api.on('component-preview:request', (req) => void runComponentPreviews(req)),
      api.on('component-preview:cancel', (req) => cancelComponentPreviews(req.requestId)),
      api.on('menu:command', ({ cmd, id }) => {
        // Confirmed at once, so the main process stops offering it. It may have offered it twice (a screen said it was
        // ready again before this confirmation arrived): it is acted on once.
        api.menuReceived(id);
        if (id <= lastMenuCommand) return;
        lastMenuCommand = id;
        window.dispatchEvent(new CustomEvent('builder-command', { detail: cmd }));
      }),
      // Edit → Undo and Redo, and their keys when nothing on the page took them: a text field (a dialog's too,
      // so this runs before the editor's dialog guard) keeps its own history, the editor undoes the project.
      api.on('menu:history', ({ action, fromKey }) => {
        // While the project is being left, the editor takes no input (see lib/leave.ts).
        if (getState().leaving) return;
        const owner = menuHistoryOwner(historyContext(), fromKey);
        // The Posts writer's text is the project's: its Undo saves what was typed, then undoes the project.
        if (owner === 'text' && document.activeElement?.closest('.post-body') && runWriterHistory(action)) return;
        if (owner === 'text') void (action === 'redo' ? api.edit.redo() : api.edit.undo());
        else if (owner === 'project') projectHistory(action);
      }),
      // While the preview frame has focus, the editor's own keydown handler cannot see keys; the main
      // process forwards the real key presses instead. In Preview the page is the visitor's.
      api.on('input:key', (k) => {
        // Back and Forward step through the visitor's journey, never the project's history.
        const dir = forwardedVisitorStep(historyContext(), k, api.platform === 'darwin');
        if (dir) {
          if (!getState().leaving) stepVisitor(dir);
          return;
        }
        const askAi = isAskAiKey(k);
        if (forwardedKeyRuns(historyContext(), k.key, k.meta || k.ctrl, askAi)) handleShortcut(k.key, k.meta || k.ctrl, k.shift, askAi);
      }),
      useStore.subscribe(persistChatState),
      useStore.subscribe(persistPlaces),
      // The live session this opening hosts, and where the host is for guests following it (#764).
      ...followLive(),
      syncPresence()
    ];
    void api.project
      .snapshot()
      .then((snap) => !unmounted && !superseded && snap && openSnapshot(snap))
      .catch(() => undefined)
      .finally(() => !unmounted && setBooted(true));
    return () => {
      unmounted = true;
      offs.forEach((o) => o());
    };
  }, []);

  return (
    <>
      {booted && (screen === 'welcome' ? <Welcome /> : <Editor />)}
      <UnpackingModal />
      <Toasts />
      <ConfirmHost />
    </>
  );
}

function openSnapshot(snap: NonNullable<ReturnType<typeof getState>['snapshot']>) {
  const local = snap.localState ?? {};
  forgetKeptDrafts();
  const pageId = local.pageId && Object.hasOwn(snap.state.pages, local.pageId) ? local.pageId : snap.state.site.homePageId;
  // Each page's place is this opening's own; the page opens where the author left it, brought into view (see Canvas).
  const pagePlaces = readPlaces(snap.state, local.pagePlaces);
  setState({
    screen: 'editor',
    snapshot: snap,
    runtime: snap.runtime,
    pageId,
    viewport: restoreViewport(local.viewport),
    previewScheme: 'system',
    zoom: restoreZoom(local.zoom),
    leftTab: (local.leftTab as never) ?? 'pages',
    // No saved view, or one this version does not have (a newer one's, a hand-edited file), opens the AI.
    rightTab: restoreRightTab(local.rightTab),
    // Every project opens with its own panel widths (or the defaults), never the last project's.
    leftWidth: restorePanelWidth('left', local.leftWidth),
    rightWidth: restorePanelWidth('right', local.rightWidth),
    // Drafts and the open conversation are this project's own; the conversation follows once it is loaded.
    chatDrafts: cleanDrafts(local.chatDrafts),
    chatImages: cleanImages(local.chatImages),
    chatMode: local.chatMode === 'ask' ? 'ask' : 'edit',
    // A choice to change the whole site was made for the last project, never for this one.
    chatContextEnabled: { page: true, scope: 'selection' },
    keptSamples: Array.isArray(local.keptSamples) ? local.keptSamples.filter((v): v is string => typeof v === 'string') : [],
    conversation: null,
    pagePlaces,
    selection: placeOn(snap.state, pagePlaces, pageId),
    previewReturn: null,
    // The Share popover belongs to the opening it was opened in.
    shareOpen: false,
    mode: 'edit',
    // The Posts workspace opens on its list: a post of the last project is never this one's.
    post: null,
    postView: 'write',
    postPreviewAt: null,
    postReveal: null,
    // The SEO view opens with no document chosen: a page or post of the last opening is never this one's.
    seoSubject: null,
    definitionMode: null,
    templateMode: null,
    variantStyle: null,
    heldEdits: [],
    aiOutcome: null,
    inspectorFocus: null,
    styleCopy: null,
    renameOffer: null,
    ...openingModalsClosed()
  });
  void restoreConversation(++opened, local.chatConversation);
}

/**
 * Paste style reviews what was copied in one opening, onto it, and a removal review the placements of one opening:
 * another opening never shows either.
 */
function openingModalsClosed(): { modal?: null } {
  const kind = getState().modal?.kind;
  return kind === 'paste-style' || kind === 'removal-review' ? { modal: null } : {};
}

/** Counts project openings and closings, so a reply that arrives after the project changed is ignored. */
let opened = 0;

/** The last File menu command this page acted on: the main process numbers them in the order they were chosen. */
let lastMenuCommand = 0;

/** Show the conversation that was open when the project was last used, with its unsent draft. */
async function restoreConversation(seq: number, remembered: string | undefined) {
  const current = () => seq === opened;
  try {
    const { active, list } = await api.ai.conversations();
    if (!current()) return;
    const saved = list.map((c) => c.id);
    const plan = restorePlan(remembered, active.id, saved, getState().chatDrafts, getState().chatImages);
    let conversation = active;
    if (plan.kind === 'open') conversation = await api.ai.openConversation(plan.id).catch(() => active);
    // A new conversation left with a draft was never saved: a new one takes its place, and its draft.
    else if (plan.kind === 'fresh' && active.messages.length) conversation = await api.ai.newConversation();
    if (!current()) return;
    const s = getState();
    setState(plan.kind === 'fresh' ? { conversation, chatDrafts: moveDraft(s.chatDrafts, plan.from, conversation.id), chatImages: moveImages(s.chatImages, plan.from, conversation.id) } : { conversation });
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
