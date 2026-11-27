import { useEffect, useLayoutEffect, useState } from 'react';
import { api, applyAiEvent, getState, persistChatState, persistPlaces, projectHistory, restoreRightTab, saveLocal, setState, showConversation, toast, transport, useStore, whenThemesReady } from './store';
import { cleanDrafts, cleanImages, moveDraft, moveImages, restorePlan } from './lib/chatDrafts';
import { readFirstSteps } from '@shared/first-steps';
import { Welcome } from './Welcome';
import { UnpackingModal } from './components/ProjectDialogs';
import { Toasts, openDialogs, openMenus } from './components/ui';
import { ConfirmHost } from './components/ConfirmDialog';
import { FormRoutingHost } from './components/FormRoutingHost';
import { forgetComponentThumbs } from './components/ComponentThumb';
import { restorePanelWidth, restoreViewport, restoreZoom } from './lib/layout';
import { focusedSurface, forwardedKeyRuns, forwardedVisitorStep, menuHistoryOwner, type HistoryContext } from './lib/history';
import { runWriterHistory } from './lib/post-draft';
import { closeProject, endEditingHold, forgetKeptDrafts, prepareToLeave, projectClosed } from './lib/leave';
import { RenderFailure, renderFailed } from './components/RenderFailure';
import { keepViewValid } from './lib/model';
import { keepSeoSubject } from './lib/seo-view';
import { placeOn, readPlaces } from './lib/page-place';
import { startEditorFonts } from './lib/editor-fonts';
import { isAskAiKey } from './lib/ask-ai-key';
import { followLive, syncPresence } from './lib/live-host';
import { followRemote, syncRemotePresence } from './lib/remote-session';
import { followNotes } from './lib/notes-feed';
import { JoinLiveDialog } from './components/JoinLive';
import { isRemoteOpening } from './lib/remote-snapshot';
import { projectDisplayName, windowTitle } from '@shared/project-name';
import { perfMarkAtCommit, perfOn, perfWork } from './lib/perf';
import { editorModule, loadEditor } from './lib/editor-module';
import { askRecentsEarly, takeEarlyRecents } from './lib/early-recents';

/** What Undo and Redo, and keys forwarded from the preview frame, act on right now. */
function historyContext(): HistoryContext {
  const s = getState();
  // Text being edited on the canvas or in the preview: neither, before the editor's code has loaded.
  const editor = editorModule();
  return { editor: s.screen === 'editor', mode: s.mode, inlineEdit: editor?.inlineEdit.active ?? false, frameText: editor?.frameTextFocus.active ?? false, overlay: openDialogs.length > 0 || openMenus.count > 0, focus: focusedSurface(document.activeElement as HTMLElement | null) };
}

export function App() {
  const screen = useStore((s) => s.screen);
  // No screen is shown until the project that is open (if any) is known, so a File menu command waiting for this
  // window reaches the screen that will stay: Welcome, or the editor of a project left open with no window (macOS).
  const [booted, setBooted] = useState(false);
  // The editor shows once its code has loaded and the theme catalogue it reads has arrived. Opening a project asks for
  // both well before the project is ready (an open on Welcome loads the code; the catalogue was asked for at launch),
  // so Welcome, showing the project as opening, is what stays on screen in the meantime, never a blank window.
  const packsReady = useStore((s) => s.packs.ready);
  const [loadedEditor, setLoadedEditor] = useState(editorModule);
  const [editorFailed, setEditorFailed] = useState<Error | null>(null);
  const editor = loadedEditor ?? editorModule();
  useEffect(() => {
    // A load that failed is tried again by the next opening.
    if (screen !== 'editor') return setEditorFailed(null);
    // Already here (an open on Welcome loaded it): shown as it is, with no render more.
    if (loadedEditor || editorModule()) return;
    let live = true;
    loadEditor().then(
      (m) => live && setLoadedEditor(m),
      (e: unknown) => live && setEditorFailed(e instanceof Error ? e : new Error(String(e)))
    );
    return () => {
      live = false;
    };
  }, [screen, loadedEditor]);
  const shown = screen === 'editor' && ((editor && packsReady) || editorFailed) ? 'editor' : 'welcome';
  useLayoutEffect(() => {
    presented = shown;
    // A command held back while Welcome stood in for the editor is offered again now that the screen on show is the
    // store's: Welcome when the project closed before the editor could show (the editor asks for it itself).
    if (screen === shown && commandsHeld) {
      commandsHeld = false;
      api.menuReady();
    }
  }, [shown, screen]);

  // The window's title follows the page's (Electron carries it over), so a window opened again over an open project,
  // or a reloaded page, names it too.
  const title = useStore((s) => windowTitle(s.screen === 'editor' && s.snapshot ? projectDisplayName(s.snapshot.state) : null));
  useEffect(() => {
    document.title = title;
  }, [title]);

  // The project's imported fonts, loaded into the editor for its samples.
  useEffect(() => startEditorFonts(), []);

  useEffect(() => {
    // Both wait for the theme packs: when verifying them fails, the page shows why instead, and these go unanswered.
    void api.app.getSettings().then((settings) => setState({ settings }), () => undefined);
    void api.ai.providers().then((providers) => setState({ providers }), () => undefined);
    // A project opened or closed before the first snapshot arrives is newer than that snapshot.
    let superseded = false;
    let unmounted = false;
    const offs = [
      // Marked as received when its message arrives (lib/transport.ts), before the editor's copy is made from it.
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
        // A copy is made in the editor: none before its code has loaded.
        editorModule()?.forgetCopy();
        forgetComponentThumbs();
        opened++;
        projectClosed();
        // Held edits and the last AI outcome belong to the project that closed.
        // Notices (an error stays until dismissed) belong to the project that closed.
        setState({ toasts: [], screen: 'welcome', snapshot: null, selection: null, pagePlaces: {}, previewReturn: null, seoSubject: null, conversation: null, chatDrafts: {}, chatImages: {}, chatRequest: null, definitionMode: null, templateMode: null, heldEdits: [], aiOutcome: null, inspectorFocus: null, styleCopy: null, renameOffer: null, shareOpen: false, ...openingModalsClosed() });
      }),
      // Before the project is closed, switched or the app quits: save what is being typed, or ask the author.
      api.on('lifecycle:request', ({ requestId }) => {
        leaving.add(requestId);
        const answer = (a: 'leave' | 'stay') => leaving.delete(requestId) && api.leaveResult(requestId, a);
        void prepareToLeave(() => leaving.has(requestId) && api.leaveResult(requestId, 'asking')).then(
          (leave) => answer(leave ? 'leave' : 'stay'),
          // Something went wrong while saving: never treat that as permission to drop what was typed.
          (e: unknown) => {
            endEditingHold();
            toast(`Your changes could not be checked before leaving${e instanceof Error ? `: ${e.message}` : '.'} Try again.`, 'error');
            answer('stay');
          }
        );
      }),
      api.on('runtime:status', (runtime) => setState({ runtime })),
      // Each assistant event timed with the render it sets off, while marks are on (scripts/perf: the chat scenario).
      api.on('ai:event', perfOn ? (e) => perfWork('chat.aiEvent', () => applyAiEvent(e), { kind: e.kind }) : applyAiEvent),
      // Asked for only while a project is open, so the editor's code is loaded or on its way (in order: a cancel follows
      // the request it cancels). Answered whatever happens: an editor whose code could not be loaded says so, rather
      // than leave the assistant waiting for an answer.
      api.on('inspect:request', (req) =>
        void loadEditor().then(
          (m) => m.runInspection(req),
          () => api.inspectResult(req.requestId, { error: 'The editor could not be loaded, so the preview could not be checked.' })
        )
      ),
      api.on('component-preview:request', (req) =>
        void loadEditor().then(
          (m) => m.runComponentPreviews(req),
          () => api.componentPreviewResult(req.requestId, [])
        )
      ),
      api.on('component-preview:cancel', (req) => void loadEditor().then((m) => m.cancelComponentPreviews(req.requestId), () => undefined)),
      api.on('menu:command', ({ cmd, id }) => {
        // A screen that failed cannot act on it: it waits, unconfirmed, for the screen that comes back (RenderFailure).
        if (renderFailed()) return;
        // Nor can Welcome while it stays on screen for a project whose editor is still loading: the editor takes it up
        // when it shows (its menuReady has the main process offer it again).
        if (getState().screen !== presented) {
          commandsHeld = true;
          return;
        }
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
        // While the project is being left, the editor takes no input (see lib/leave.ts); nor before it shows.
        if (getState().leaving || getState().screen !== presented) return;
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
        // Keys come from the preview frame, which only the editor shows: its code is loaded by then.
        const editor = editorModule();
        if (dir) {
          if (!getState().leaving) editor?.stepVisitor(dir);
          return;
        }
        const askAi = isAskAiKey(k);
        if (forwardedKeyRuns(historyContext(), k.key, k.meta || k.ctrl, askAi)) editor?.handleShortcut(k.key, k.meta || k.ctrl, k.shift, askAi);
      }),
      useStore.subscribe(persistChatState),
      useStore.subscribe(persistPlaces),
      // The live session this opening hosts, and where the host is for guests following it (#764).
      ...followLive(),
      syncPresence(),
      // Another computer's live session this app is a guest in, and where it is for the others (#766).
      ...followRemote(),
      syncRemotePresence(),
      // The shown project's pinned notes (#770).
      followNotes()
    ];
    // A project already open (the editor reloaded, or a window opened again over it) shows the editor at once, once
    // its code and the catalogue are here: Welcome never shows in between. The changes that follow are made against
    // the copy this reads.
    const opening = transport.current();
    // Welcome's recent projects are asked for now, just after the open project (answered first), not once that answer
    // has come and Welcome has mounted: they do not depend on it.
    askRecentsEarly(() => api.projects.recents());
    void opening
      .then(async (snap) => {
        if (unmounted || superseded || !snap) return;
        const runtime = getState().runtime;
        // An editor whose code could not be loaded still opens the project: its screen says so, and offers to close it.
        await Promise.all([loadEditor(), whenThemesReady()]).catch(() => undefined);
        if (unmounted || superseded) return;
        // The preview's state may have moved on meanwhile: the latest word on it stays.
        const moved = getState().runtime !== runtime ? getState().runtime : null;
        openSnapshot(snap);
        if (moved) setState({ runtime: moved });
      })
      .catch(() => undefined)
      .finally(() => !unmounted && setBooted(true));
    return () => {
      unmounted = true;
      offs.forEach((o) => o());
    };
  }, []);

  return (
    <>
      {/* A screen that fails while rendering shows what happened instead of a blank window (#886). Only the screen goes:
          the listeners above stay, so the main process can still ask before leaving, and a closed project brings back
          a fresh Welcome. */}
      {booted && (
        <RenderFailure key={shown} onCloseProject={shown === 'editor' ? () => void closeProject() : undefined}>
          {shown === 'welcome' ? <Welcome /> : editor ? <editor.Editor /> : <Failed error={editorFailed!} />}
        </RenderFailure>
      )}
      {booted && <JoinLiveDialog />}
      <UnpackingModal />
      <Toasts />
      <ConfirmHost />
      {/* The app's question before an AI change to where a form sends, in its own dialog wherever the chat is (#1130). */}
      <FormRoutingHost />
      {perfOn && <PerfProbe screen={shown} />}
    </>
  );
}

/**
 * Marks the commit that first shows each revision, screen and opening (src/shared/perf.ts), and each selection: its
 * layout effect runs in the same commit as everything else the snapshot or selection changed. Rendered only while
 * timing marks are on.
 */
function PerfProbe({ screen }: { screen: 'welcome' | 'editor' }) {
  const revision = useStore((s) => s.snapshot?.revision ?? null);
  const opening = useStore((s) => s.snapshot?.workspaceKey ?? null);
  const selection = useStore((s) => s.selection);
  useLayoutEffect(() => perfMarkAtCommit('renderer.commit', { revision, screen, opening: opening !== null }), [revision, opening, screen]);
  useLayoutEffect(() => perfMarkAtCommit('renderer.selectionCommit', { selected: selection !== null }), [selection]);
  return null;
}

/** The editor's code could not be loaded: the screen's failure, with its way back (RenderFailure). */
function Failed({ error }: { error: Error }): never {
  throw error;
}

export function openSnapshot(snap: NonNullable<ReturnType<typeof getState>['snapshot']>) {
  // Welcome shown again after this project reads its list afresh.
  takeEarlyRecents();
  const local = snap.localState ?? {};
  forgetKeptDrafts();
  const pageId = local.pageId && Object.hasOwn(snap.state.pages, local.pageId) ? local.pageId : snap.state.site.homePageId;
  // Each page's place is this opening's own; the page opens where the author left it, brought into view (see Canvas).
  const pagePlaces = readPlaces(snap.state, local.pagePlaces);
  setState({
    // A notice from the project that was open (or from the welcome screen) is not this project's.
    toasts: [],
    screen: 'editor',
    snapshot: snap,
    runtime: snap.runtime,
    pageId,
    viewport: restoreViewport(local.viewport),
    previewScheme: 'system',
    zoom: restoreZoom(local.zoom),
    leftTab: (local.leftTab as never) ?? 'pages',
    // No saved view, or one this version does not have (a newer one's, a hand-edited file), opens the AI. The host's
    // project in a live session opens on the Inspector: its AI is the host's (#766).
    rightTab: isRemoteOpening(snap.workspaceKey) ? 'inspect' : restoreRightTab(local.rightTab),
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
    firstSteps: readFirstSteps(local.firstSteps),
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
  // The host's AI conversations are its own: a guest has none to restore (#766).
  if (isRemoteOpening(snap.workspaceKey)) opened++;
  else void restoreConversation(++opened, local.chatConversation);
}

/**
 * Paste style reviews what was copied in one opening, onto it, and a removal review the placements of one opening:
 * another opening never shows either.
 */
function openingModalsClosed(): { modal?: null } {
  const kind = getState().modal?.kind;
  return kind === 'paste-style' || kind === 'removal-review' ? { modal: null } : {};
}

/** The main process's requests to leave the project that this page has not answered yet. */
const leaving = new Set<string>();

/**
 * The whole page failed while rendering (#886): its questions, and the listeners that answer the main process, are gone.
 * A leave still being decided is answered Stay, so closing the window or quitting is not left waiting on a question no
 * one can see; asked again, the main process finds no one answering and offers to leave anyway.
 */
export function abandonLeaves() {
  for (const requestId of leaving) api.leaveResult(requestId, 'stay');
  leaving.clear();
}

/** The screen on show, which follows the store's once the editor's code and the catalogue are here (App). */
let presented: 'welcome' | 'editor' = 'welcome';
/** Whether a menu command was left unconfirmed while the screen on show was not yet the store's. */
let commandsHeld = false;

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
    // A new conversation left with a draft was never saved: a new one takes its place, and its draft. While a request
    // runs in the active one (a window reloaded mid-request), none can be started: that request's thread is shown, so a
    // question it waits on is seen, and the draft stays with the unsent conversations, to be picked up later.
    else if (plan.kind === 'fresh' && active.messages.length) conversation = await api.ai.newConversation().catch(() => active);
    if (!current()) return;
    const id = conversation.id;
    const kept = plan.kind === 'fresh' && conversation === active && active.messages.length > 0;
    const moved = () => {
      const s = getState();
      return plan.kind === 'fresh' && !kept ? { chatDrafts: moveDraft(s.chatDrafts, plan.from, id), chatImages: moveImages(s.chatImages, plan.from, id) } : {};
    };
    const opening = getState().snapshot?.workspaceKey;
    // Shown as main has it by its ID, with the request running in it: a window reloaded mid-run has missed both.
    if (opening) await showConversation(conversation, opening, current, moved);
    else setState({ conversation, ...moved() });
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
