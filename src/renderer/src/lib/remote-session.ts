import type { BuilderApi, ProjectSnapshot, RemoteState, RunStatus } from '@shared/api';
import type { GuestRole } from '@shared/live/limits';
import type { ApplyResult, EditBatch } from '@shared/ops';
import type { Presence } from '@shared/live/messages';
import type { LiveProjectSnapshot } from '@shared/live/snapshot';
import type { LiveNoteResult, NoteDraft } from '@shared/live/notes';
import { LIVE_BATCH_LABEL_MAX } from '@shared/live/limits';
import { refKey } from '@shared/types';
import { api, confirmDialog, getState, keepUnsent, SAID_ELSEWHERE, setState, toast, transport, useStore, type State } from '../store';
import { IDLE_LIVE, sharedSelection } from './live-session';
import { presenceOf } from './live-host';
import { remoteApplyResult, remoteOpening, remoteSnapshot, type AdmittedRemote } from './remote-snapshot';
import { copyBatchProblem, copyEditing } from './copy-only';
import { endEditingHold, prepareToLeave } from './leave';
import { readUnsent, sameUnsent, typedBeingSent, type UnsentText } from './pending';
import { fieldKey } from './held';
import { keptDraftsIn } from './kept-drafts';
import type { RemoteApi } from './transport';

/**
 * The editor's side of being a guest in another computer's live session: the remote shell (#766). The main process
 * holds the connection (src/main/live/guest.ts); this follows it, shows the host's project in the editor while this
 * app is admitted, routes the editor's calls to the host through the transport (lib/transport.ts), and puts the editor
 * back on this computer's own projects, with nothing of the session left, when it ends.
 *
 * Everything is by join: a late answer or event for a join that has ended never reaches the editor.
 */

/** The join the editor shows, with what the host last sent of its project and the editor's snapshot made from it. */
interface Shown {
  joinId: string;
  remote: RemoteApi;
  live: LiveProjectSnapshot | null;
  snapshot: ProjectSnapshot | null;
  /** Edits the host has made, waiting for the editor to hold the project at their revision (remoteApi's apply). */
  waiters: Array<{ revision: number; resolve: () => void }>;
  /**
   * Typed text sent to the host, until the edit is done with (#1462): an ending before the host answers leaves it
   * uncertain; one after the host refused it (an out-of-date edit being read again) leaves it known to be unsent.
   */
  sending: Set<Sending>;
  /** Of those, the ones the ending kept to copy: their answer, when it comes, has already been said. */
  keptSending: Set<Sending>;
}

/** Typed text on its way to the host, and whether the host has refused it yet. */
type Sending = UnsentText & { refused?: boolean };
let shown: Shown | null = null;

/** Whether the editor shows another computer's project now. */
export const showsRemote = () => shown !== null;
/** The join the store's remote state names, when it is admitted. */
export const admittedRemote = (s: Pick<State, 'remote'>): AdmittedRemote | null => (s.remote.phase === 'admitted' ? s.remote : null);
/** Whether the editor shows the host's project as a guest (any phase of an admitted join). */
export const isRemoteShell = (s: Pick<State, 'remote' | 'snapshot'>) => s.remote.phase === 'admitted' && s.snapshot?.workspaceKey === remoteOpening(s.remote.joinId);

/** The sidebar views a guest has: the host's pages, their layers, and what can be inserted from the host's project. */
export const REMOTE_LEFT_TABS: ReadonlySet<string> = new Set(['pages', 'layers', 'insert']);
/** A copy editor (#1318) inserts nothing: it has the pages and their layers. */
export const COPY_EDITOR_LEFT_TABS: ReadonlySet<string> = new Set(['pages', 'layers']);
/** The sidebar views a guest holding `role` has. */
export const remoteLeftTabs = (role: GuestRole | null | undefined): ReadonlySet<string> => (role === 'copy-editor' ? COPY_EDITOR_LEFT_TABS : REMOTE_LEFT_TABS);
/** The right panel's views a guest has: the Inspector and Site styles. The project brief is the host's. */
export const REMOTE_RIGHT_TABS: ReadonlySet<string> = new Set(['inspect', 'styles']);
/**
 * A collaborator also has the AI view (#769): its own requests to the host's AI, which says when the host has not
 * allowed them. A viewer never has it.
 */
export const COLLABORATOR_RIGHT_TABS: ReadonlySet<string> = new Set(['chat', ...REMOTE_RIGHT_TABS]);
/** How this collaborator's own request to the host's AI stands, while one runs (#769); null when none does. */
export function remoteRunStatus(s: Pick<State, 'remoteAi'>): RunStatus | null {
  const ai = s.remoteAi;
  if (!ai?.activeRunId) return null;
  const turn = ai.turns.find((t) => t.runId === ai.activeRunId);
  return turn?.result ? null : (turn?.status ?? 'preparing');
}
/** A copy editor (#1318) has the Inspector alone: the site's styles are the host's to change. */
export const COPY_EDITOR_RIGHT_TABS: ReadonlySet<string> = new Set(['inspect']);
/** The right panel's views a guest holding `role` has. */
export const remoteRightTabs = (role: GuestRole | null | undefined): ReadonlySet<string> => (role === 'collaborator' ? COLLABORATOR_RIGHT_TABS : role === 'copy-editor' ? COPY_EDITOR_RIGHT_TABS : REMOTE_RIGHT_TABS);
/**
 * The dialogs a guest can open over the host's project: this computer's own Settings, and those whose edits a
 * collaborator may make. Every other dialog (export, code, history and versions, components, imports, health) is
 * the host's, and is never shown in the remote shell.
 */
export const REMOTE_MODALS: ReadonlySet<string> = new Set(['settings', 'find', 'delete-page', 'set-home', 'swap-component', 'paste-style']);
/** The File menu's commands that open or act on a project of this computer's: a guest leaves the session first. */
export const LOCAL_PROJECT_COMMANDS: ReadonlySet<string> = new Set(['new-project', 'open-project', 'open-project-folder', 'duplicate-project', 'export', 'join-live']);

/**
 * The project revision a page the canvas starts loading now will show. Locally the editor's own: its preview serves
 * the project as it is. For the host's project, the revision the host last said its preview serves (a page loaded
 * after that is at least that one), or, before it said one, the snapshot's.
 */
export function loadedRevision(s: Pick<State, 'snapshot' | 'remote'>): number {
  const revision = s.snapshot?.revision ?? 0;
  return isRemoteShell(s) && s.remote.phase === 'admitted' && s.remote.previewRevision !== null ? s.remote.previewRevision : revision;
}

/**
 * Follow this app's place in another computer's live session: its state, the host's project, reloads of its preview
 * and the others' presence. Returns the unsubscribers.
 */
export function followRemote(): Array<() => void> {
  let events = 0;
  const offs = [
    api.on('remote:state', (state) => {
      events++;
      applyRemoteState(state);
    }),
    api.on('remote:changed', ({ joinId, snapshot }) => {
      if (shown?.joinId === joinId) takeLive(shown, snapshot);
    }),
    api.on('remote:reload', ({ joinId, revision }) => {
      if (shown?.joinId !== joinId) return;
      const at = getState().remoteReload;
      setState({ remoteReload: { seq: at.seq + 1, revision: revision ?? at.revision } });
    }),
    api.on('remote:presence', (presence) => {
      const remote = getState().remote;
      if (remote.phase !== 'idle' && remote.joinId === presence.joinId) setState({ remotePresence: presence });
    }),
    api.on('remote:ai', (ai) => {
      if (shown?.joinId === ai.joinId) setState({ remoteAi: ai });
    }),
    // The host's pinned notes (#770) reach the editor as the shown project's own.
    api.on('remote:notes', ({ joinId, notes }) => {
      if (shown?.joinId === joinId) transport.emit(shown.remote, 'notes:changed', notes);
    })
  ];
  let gone = false;
  void api.remote
    .state()
    .then((state) => !gone && events === 0 && applyRemoteState(state))
    .catch(() => undefined);
  offs.push(() => {
    gone = true;
  });
  return offs;
}

/** Take a state the main process sent: open the host's project once admitted, follow its changes, and end with it. */
export function applyRemoteState(next: RemoteState): void {
  const prev = getState().remote;
  setState({ remote: next, ...(next.phase === 'idle' || (prev.phase !== 'idle' && prev.joinId !== next.joinId) ? { remotePresence: null } : {}) });
  if (next.phase === 'admitted') {
    if (shown?.joinId !== next.joinId) void show(next);
    else refresh(shown);
    return;
  }
  if (shown && (next.phase === 'idle' || next.joinId !== shown.joinId)) end(next.phase === 'idle' ? next.ended : null, prev.phase === 'admitted' && prev.joinId === shown.joinId ? prev.projectName : null);
}

/** Show the host's project for an admitted join: as soon as the host's project has arrived, the editor opens it. */
async function show(admitted: AdmittedRemote): Promise<void> {
  const joinId = admitted.joinId;
  if (shown) end(null);
  const entry: Shown = { joinId, remote: remoteApi(joinId), live: null, snapshot: null, waiters: [], sending: new Set(), keptSending: new Set() };
  shown = entry;
  transport.use(entry.remote);
  // Nothing of this computer's own live session is shown over the host's project (none runs: no project is open),
  // and no dialog or mode of another opening is left open over it.
  setState({ live: IDLE_LIVE, liveClock: null, remoteReload: { seq: 0, revision: null }, remoteAi: null, modal: null, definitionMode: null, templateMode: null });
  // This join's own AI requests, as the main process holds them (an editor page loaded part way through a join).
  void api.remote
    .ai(joinId)
    .then((ai) => shown === entry && ai && setState({ remoteAi: ai }))
    .catch(() => undefined);
  const live = await api.remote.snapshot(joinId).catch(() => null);
  if (shown === entry && live) takeLive(entry, live);
}

/** The host's project as it is now, unless it is older than the one shown. */
function takeLive(entry: Shown, live: LiveProjectSnapshot): void {
  if (shown !== entry) return;
  if (entry.live && live.revision < entry.live.revision) return;
  entry.live = live;
  publish(entry, true);
  // Edits whose revision the editor now holds are done.
  const done = entry.waiters.filter((w) => w.revision <= live.revision);
  entry.waiters = entry.waiters.filter((w) => w.revision > live.revision);
  for (const w of done) w.resolve();
}

/**
 * The answer to an edit the join ended before the host answered. Typed text the ending kept to copy already says the
 * host may have it (#1462), so its answer says nothing more.
 */
function endedFirst(entry: Shown, sending: Sending | null): ApplyResult {
  const kept = !!sending && entry.keptSending.has(sending);
  return { ok: false, revision: 0, error: { code: 'CANCELLED', message: 'The live session ended before the host answered. Your change may have been made there.', recoverable: false, ...(kept ? { details: SAID_ELSEWHERE } : {}) } };
}

/** How long an edit the host made waits for its revision to reach the editor before it is answered anyway. */
export const REMOTE_EDIT_ARRIVAL_MS = 5000;

/**
 * Resolves once the editor holds the host's project at `revision` or later (true), or the join ends or a while
 * passes first (false).
 */
function arrival(entry: Shown, revision: number): Promise<boolean> {
  if (shown !== entry) return Promise.resolve(false);
  if (entry.live && entry.live.revision >= revision) return Promise.resolve(true);
  return new Promise((resolve) => {
    const waiter = { revision, resolve: () => (clearTimeout(timer), resolve(shown === entry)) };
    const timer = setTimeout(() => {
      entry.waiters = entry.waiters.filter((w) => w !== waiter);
      resolve(false);
    }, REMOTE_EDIT_ARRIVAL_MS);
    entry.waiters.push(waiter);
  });
}

/** Ask the host for its project as it is now, for the join shown; false when it could not be read. */
async function refreshFrom(entry: Shown): Promise<boolean> {
  const live = await api.remote.snapshot(entry.joinId, true).catch(() => null);
  if (live && shown === entry) takeLive(entry, live);
  return !!live && shown === entry;
}

/** Something that decides what the editor may do changed (a role, the host's connection): the snapshot says so again. */
function refresh(entry: Shown): void {
  publish(entry, false);
}

/**
 * Hand the editor the host's project as the editor's snapshot. A change to the documents always goes; anything
 * else only when it changes what the snapshot says (read-only, the preview), so a deadline moving re-renders nothing.
 */
function publish(entry: Shown, changed: boolean): void {
  const remote = admittedRemote(getState());
  if (!entry.live || !remote || remote.joinId !== entry.joinId) return;
  const snapshot = remoteSnapshot(remote, entry.live);
  const before = entry.snapshot;
  if (!changed && before && JSON.stringify(before.readOnly) === JSON.stringify(snapshot.readOnly) && JSON.stringify(before.runtime) === JSON.stringify(snapshot.runtime)) return;
  entry.snapshot = snapshot;
  transport.emit(entry.remote, 'project:changed', snapshot);
}

/**
 * What the guest typed in the host's project that the host does not have: held edits with their text, every field and
 * composer still holding typed text, and text kept for being too long or refused by a field's check. Read while the
 * project is still the editor's, and read only: nothing is committed or sent, since the session has already ended.
 */
function unsentIn(entry: Shown): UnsentText[] {
  const opening = remoteOpening(entry.joinId);
  const s = getState();
  if (s.snapshot?.workspaceKey !== opening) return [];
  const found: UnsentText[] = [
    // On its way to the host as the session ended: unanswered, it may have arrived, so it is said to be uncertain.
    ...[...entry.sending].map(({ refused, ...t }) => ({ ...t, ...(refused ? {} : { uncertain: true }) })),
    // A held edit being written is the send above while the host has not answered; once it has, the host has it.
    ...s.heldEdits.filter((h) => h.workspace === opening && h.text !== null && !(h.writing && ![...entry.sending].some((t) => t.key === h.key))).map((h) => ({ key: h.key, label: h.label, text: h.text! })),
    ...readUnsent(),
    ...keptDraftsIn(opening).map((k) => ({ key: k.field, label: k.name ? `Edit ${k.name}` : 'Something you typed', text: k.text })),
    // Text already offered to copy (its field went away): the notice goes as the project closes, so the words are kept.
    ...s.toasts.flatMap((t) => (t.action?.copies ? [t.action.copies] : []))
  ];
  // The same text read from two places (a field showing text it keeps, a held edit being written) counts once.
  return found.filter((f, i) => f.text.trim() && found.findIndex((o) => sameUnsent(o, f)) === i);
}

/**
 * The join ended: the editor closes the host's project, as it closes one of its own, and goes back to this
 * computer's. Why it ended is said once the editor has left it (closing clears the notices). Ended without the guest
 * choosing it (#1462), what they typed that the host never had is kept to copy, each with why: the host's project
 * and its access stay as the host has them, and only the guest's own words stay here.
 */
function end(ended: { reason: string; message: string } | null, projectName: string | null = null): void {
  const entry = shown;
  if (!entry) return;
  const forced = !!ended && ended.reason !== 'left';
  const unsent = forced ? unsentIn(entry) : [];
  for (const t of entry.sending) if (unsent.some((u) => sameUnsent(u, t))) entry.keptSending.add(t);
  shown = null;
  for (const w of entry.waiters.splice(0)) w.resolve();
  if (entry.snapshot) transport.emit(entry.remote, 'project:closed', undefined);
  // Never shown, so never closed as a project: nothing it held may keep the next editor from taking input.
  else endEditingHold();
  transport.use(null);
  // A dialog about the host's project (Delete page, say) never stays open for whatever opens next.
  setState({ remotePresence: null, remoteAi: null, remoteReload: { seq: 0, revision: null }, modal: null });
  if (!ended || !forced) return;
  // The text says why it was not sent, so it stands in for the notice; with nothing typed, the notice alone.
  if (unsent.length) keepUnsent(unsent, ended.message, projectName ?? entry.live?.state.site.name ?? 'the host’s project');
  else toast(ended.message, 'info');
}

// ---------------------------------------------------------------------------
// Joining and leaving

/**
 * Join the live session an invite link names. A project of this computer's that is open is closed first, through the
 * usual close (it saves what is being typed, or asks); one the author keeps open keeps the join from starting, and so
 * does the author calling the join off meanwhile (`wanted` false once it is).
 */
export async function joinLive(inviteLink: string, displayName: string, wanted: () => boolean = () => true): Promise<{ ok: true } | { ok: false; message: string }> {
  if (getState().snapshot && !showsRemote()) {
    const closed = await api.projects.close().catch(() => ({ ok: false }));
    if (!closed.ok) return { ok: false, message: 'The open project was kept open, so the live session was not joined.' };
  }
  if (!wanted()) return { ok: false, message: 'Joining was called off.' };
  try {
    const result = await api.remote.join({ inviteLink, displayName });
    // Called off while the request went out: the place is given up again rather than kept for a dialog now gone.
    if (result.ok && !wanted()) {
      await api.remote.leave().catch(() => undefined);
      return { ok: false, message: 'Joining was called off.' };
    }
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  } catch (e) {
    return { ok: false, message: `The live session could not be joined: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Leave the live session, or stop asking to join one. Leaving the host's project settles what is being typed first,
 * as closing a project does: it is sent to the host, or the author is asked; Keep editing stays in the session.
 */
export async function leaveLive(): Promise<boolean> {
  // Only an editor showing the host's project has typing to settle; one still opening it has none.
  if (isRemoteShell(getState()) && !(await prepareToLeave(() => undefined).catch(() => false))) return false;
  await api.remote.leave().catch(() => undefined);
  return true;
}

/**
 * Leave the live session the editor shows, once the guest says so. Every way out of the remote shell asks first (the
 * Leave session button, the session menu, the toolbar's mark, the project menu and Close Project), as the host's End
 * session does: a place the host let this guest into is only had back by asking the host again.
 */
export async function confirmLeaveLive(): Promise<boolean> {
  const remote = admittedRemote(getState());
  if (remote) {
    const ok = await confirmDialog({
      title: 'Leave the live session?',
      body: `You stop seeing ${remote.projectName}. To come back, you ask the host to let you in again.`,
      details: [{ kind: 'keep', text: remote.role !== 'viewer' ? 'Changes already sent to the host’s project stay there.' : 'Nothing in the host’s project changes.' }],
      confirmLabel: 'Leave session',
      cancelLabel: 'Stay in session',
      tone: 'caution',
      icon: 'leave'
    });
    if (!ok) return false;
  }
  return leaveLive();
}

// ---------------------------------------------------------------------------
// What the editor may ask of the host's project

/**
 * The remote shell's answers to the editor, for one join. Edits go to the host, which makes them through its own
 * pipeline; what the editor asks of a project as a matter of course (its saved state, the library, thumbnails, fonts)
 * is answered with nothing to show; everything else the host alone does is refused (lib/transport.ts), and the
 * editor never offers it while a remote project is shown.
 */
export function remoteApi(joinId: string): RemoteApi {
  const opening = remoteOpening(joinId);
  const mine = () => (shown?.joinId === joinId ? shown : null);
  const revision = () => mine()?.snapshot?.revision ?? 0;
  const local = () => window.builder;
  const ended = async (): Promise<LiveNoteResult> => ({ ok: false, message: 'That live session has ended.' });
  const historyRefused = async (): Promise<ApplyResult> => ({
    ok: false,
    revision: revision(),
    error: { code: 'CONFLICT', message: 'Undo and Redo are the host’s in a live session: ask the host to undo a change.', recoverable: false }
  });
  return {
    project: {
      snapshot: async () => mine()?.snapshot ?? null,
      apply: async (batch: EditBatch, opts?: { label?: string; opening?: string }): Promise<ApplyResult> => {
        const entry = mine();
        if (!entry || (opts?.opening !== undefined && opts.opening !== opening)) return { ok: false, revision: revision(), error: { code: 'SCOPE_MISMATCH', message: 'That change was made in a live session that has ended.', recoverable: false } };
        // Whatever reaches here (a shortcut, a drag) is held to what the editor shows: no edit while editing is paused,
        // and a copy editor's only to the words and pictures its editor offers (#1318), which the host checks again.
        // Nothing goes before the host's project has arrived: what may be changed is not known yet.
        if (!entry.snapshot) return { ok: false, revision: revision(), error: { code: 'CANCELLED', message: 'The host’s project is still on its way. Try again in a moment.', recoverable: true } };
        const readOnly = entry.snapshot.readOnly;
        const grant = copyEditing(entry.snapshot);
        const refused = grant ? copyBatchProblem(entry.snapshot.state, grant, batch.operations) : null;
        if (readOnly && (!grant || refused)) return { ok: false, revision: revision(), error: { code: 'CANCELLED', message: refused?.message ?? readOnly.reason, recoverable: false, ...(refused && batch.operations.length > 1 ? { details: { operationIndex: refused.operationIndex } } : {}) } };
        const label = opts?.label?.slice(0, LIVE_BATCH_LABEL_MAX);
        // Typed text on its way: kept until the edit is done with, so an ending meanwhile keeps it to copy. Unanswered,
        // it may have been made there; refused (and the project being read again), it was not.
        const typed = typedBeingSent();
        const sending: Sending | null = typed?.trim() ? { key: fieldKey(batch.operations), label: opts?.label ?? 'Something you typed', text: typed } : null;
        if (sending) entry.sending.add(sending);
        try {
          const result = await api.remote.apply(joinId, { operations: batch.operations, ...(batch.expectedRevision !== undefined ? { expectedRevision: batch.expectedRevision } : {}), ...(label ? { label } : {}) });
          // An answer for a join that has ended meanwhile is never acted on as this computer's project's.
          if (mine() !== entry) return endedFirst(entry, sending);
          // The host has it: nothing is left to keep.
          if (sending && result.ok) entry.sending.delete(sending);
          else if (sending) sending.refused = true;
          // As a local edit's answer comes with the project that has it, so the caller can select what it made. A
          // project that does not come in time, or an edit refused as out of date, is read from the host as it is now.
          // Tried a few times over: a change event lost and a read that failed should not leave the caller without it.
          if (result.ok) for (let tries = 0; tries < 3 && mine() === entry && !(await arrival(entry, result.revision)); tries++) if (await refreshFrom(entry)) break;
          if (!result.ok && result.error.code === 'STALE_REVISION') await refreshFrom(entry);
          if (mine() !== entry) return endedFirst(entry, sending);
          return remoteApplyResult(result, revision());
        } finally {
          if (sending) entry.sending.delete(sending);
        }
      },
      undo: historyRefused,
      redo: historyRefused,
      undoEntry: historyRefused,
      stepHistory: historyRefused,
      // Nothing of the host's project is saved on this computer: there is nothing to wait for.
      flush: async () => true,
      saveLocalState: async () => undefined,
      // An edit refused as out of date reads the host's project again, as the host has it now.
      reloadFromDisk: async () => {
        const entry = mine();
        return entry && (await refreshFrom(entry)) ? { ok: true } : { ok: false, message: 'The host’s project could not be read.' };
      },
      retryPreview: async () => {
        const at = getState().remoteReload;
        setState({ remoteReload: { seq: at.seq + 1, revision: at.revision } });
      },
      // The host's preview is the host's: this computer has none to check a page on before the canvas opens it (#1529),
      // so the page is opened unchecked, and one the host's preview did not have yet is loaded again on its next reload.
      previewRouteReady: async () => null,
      savedComponents: async () => [],
      componentThumb: async () => ({ state: 'unavailable' as const }),
      prepareComponentPreview: async () => ({ ok: false as const, message: 'Component previews are the host’s in a live session.' }),
      releaseComponentPreview: async () => undefined,
      storage: async () => null,
      fontFile: async () => null,
      photoMetadata: async () => null,
      webCopyPlan: async () => null,
      sourceSecretNames: async () => []
    },
    projects: {
      // Closing the host's project is leaving the session; Keep editing stays in it.
      close: async () => ({ ok: await leaveLive() }),
      recents: () => local().projects.recents()
    },
    ai: {
      // This computer's own AI settings and keys stay its own; conversations and runs are the host's.
      providers: () => local().ai.providers(),
      setKey: (...args: Parameters<BuilderApi['ai']['setKey']>) => local().ai.setKey(...args),
      testProvider: (...args: Parameters<BuilderApi['ai']['testProvider']>) => local().ai.testProvider(...args),
      localModels: () => local().ai.localModels(),
      localContext: (model: string) => local().ai.localContext(model)
    },
    live: {
      state: async () => IDLE_LIVE,
      presence: async () => ({ ok: true as const })
    },
    // The host's pinned notes (#770), as far as this guest's role allows; the host checks every call again.
    notes: {
      list: async (key: string) => (key === opening ? api.remote.notes(joinId) : null),
      add: (key: string, draft: NoteDraft) => (key === opening ? api.remote.addNote(joinId, draft) : ended()),
      resolve: (key: string, id: string, resolved: boolean) => (key === opening ? api.remote.resolveNote(joinId, id, resolved) : ended()),
      delete: (key: string, id: string) => (key === opening ? api.remote.deleteNote(joinId, id) : ended())
    }
  } as unknown as RemoteApi;
}

// ---------------------------------------------------------------------------
// Where this guest is, for the others

/** How long a burst of moves waits before the others are told where this guest ended up. */
export const REMOTE_PRESENCE_DELAY_MS = 150;

/** Where this guest is: what the canvas shows, at its width, and what is selected there. */
export function remotePresenceOf(s: Parameters<typeof presenceOf>[0] & Pick<State, 'selection'>): Presence {
  const at = presenceOf(s);
  return { ...at, selection: sharedSelection(s.selection, at.pageId) };
}

/**
 * Tell the others where this guest is while it is a collaborator in the session shown: once on joining, and after
 * every change of page, width or selection, a moment after the changes stop. Returns the unsubscriber.
 */
export function syncRemotePresence(): () => void {
  let sent: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const s = getState();
    const remote = admittedRemote(s);
    if (!remote || remote.role !== 'collaborator' || !isRemoteShell(s)) return;
    const presence = remotePresenceOf(s);
    const key = `${remote.joinId}|${JSON.stringify(presence)}`;
    if (key === sent) return;
    sent = key;
    void api.remote.presence(remote.joinId, presence).catch(() => undefined);
  };
  const off = useStore.subscribe((s, prev) => {
    const remote = admittedRemote(s);
    if (!remote || remote.role !== 'collaborator') {
      sent = null;
      return;
    }
    const changed =
      admittedRemote(prev)?.role !== 'collaborator' ||
      s.snapshot?.workspaceKey !== prev.snapshot?.workspaceKey ||
      s.pageId !== prev.pageId ||
      s.templateMode !== prev.templateMode ||
      s.viewport !== prev.viewport ||
      (s.selection ? refKey(s.selection) : '') !== (prev.selection ? refKey(prev.selection) : '');
    if (!changed || timer) return;
    timer = setTimeout(flush, REMOTE_PRESENCE_DELAY_MS);
  });
  return () => {
    off();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
