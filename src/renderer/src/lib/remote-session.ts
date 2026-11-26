import type { BuilderApi, ProjectSnapshot, RemoteState } from '@shared/api';
import type { ApplyResult, EditBatch } from '@shared/ops';
import type { Presence } from '@shared/live/messages';
import type { LiveProjectSnapshot } from '@shared/live/snapshot';
import { LIVE_BATCH_LABEL_MAX } from '@shared/live/capabilities';
import { refKey } from '@shared/types';
import { api, getState, setState, toast, transport, useStore, type State } from '../store';
import { IDLE_LIVE, sharedSelection } from './live-session';
import { presenceOf } from './live-host';
import { remoteApplyResult, remoteOpening, remoteSnapshot, type AdmittedRemote } from './remote-snapshot';
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
}
let shown: Shown | null = null;

/** Whether the editor shows another computer's project now. */
export const showsRemote = () => shown !== null;
/** The join the store's remote state names, when it is admitted. */
export const admittedRemote = (s: Pick<State, 'remote'>): AdmittedRemote | null => (s.remote.phase === 'admitted' ? s.remote : null);
/** Whether the editor shows the host's project as a guest (any phase of an admitted join). */
export const isRemoteShell = (s: Pick<State, 'remote' | 'snapshot'>) => s.remote.phase === 'admitted' && s.snapshot?.workspaceKey === remoteOpening(s.remote.joinId);

/** The sidebar views a guest has: the host's pages, their layers, and what can be inserted from the host's project. */
export const REMOTE_LEFT_TABS: ReadonlySet<string> = new Set(['pages', 'layers', 'insert']);
/** The right panel's views a guest has: the Inspector and Site styles. The AI and the project brief are the host's. */
export const REMOTE_RIGHT_TABS: ReadonlySet<string> = new Set(['inspect', 'styles']);
/**
 * The dialogs a guest can open over the host's project: this computer's own Settings, and those whose edits a
 * collaborator may make. Every other dialog (export, code, history and versions, components, imports, health) is
 * the host's, and is never shown in the remote shell.
 */
export const REMOTE_MODALS: ReadonlySet<string> = new Set(['settings', 'find', 'delete-page', 'set-home', 'swap-component', 'paste-style']);
/** The File menu's commands that open or act on a project of this computer's: a guest leaves the session first. */
export const LOCAL_PROJECT_COMMANDS: ReadonlySet<string> = new Set(['new-project', 'open-project', 'open-project-folder', 'duplicate-project', 'export', 'join-live']);

/** How long a page asked to load again may take to say it has before the canvas gives it a fresh frame. */
export const REMOTE_RELOAD_FALLBACK_MS = 4000;

/**
 * The project revision a page the canvas has just loaded shows. Locally the editor's own: its preview serves the
 * project as it is. For the host's project, the revision the host last said its preview serves (a page loaded after
 * that is at least that one), or, before it said one, the snapshot's.
 */
export function loadedRevision(s: Pick<State, 'snapshot' | 'remote' | 'remoteReload'>): number {
  const revision = s.snapshot?.revision ?? 0;
  return isRemoteShell(s) && s.remoteReload.revision !== null ? s.remoteReload.revision : revision;
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
  if (shown && (next.phase === 'idle' || next.joinId !== shown.joinId)) end(next.phase === 'idle' ? next.ended : null);
}

/** Show the host's project for an admitted join: as soon as the host's project has arrived, the editor opens it. */
async function show(admitted: AdmittedRemote): Promise<void> {
  const joinId = admitted.joinId;
  if (shown) end(null);
  const entry: Shown = { joinId, remote: remoteApi(joinId), live: null, snapshot: null };
  shown = entry;
  transport.use(entry.remote);
  // Nothing of this computer's own live session is shown over the host's project (none runs: no project is open).
  setState({ live: IDLE_LIVE, liveClock: null, remoteReload: { seq: 0, revision: null } });
  const live = await api.remote.snapshot(joinId).catch(() => null);
  if (shown === entry && live) takeLive(entry, live);
}

/** The host's project as it is now, unless it is older than the one shown. */
function takeLive(entry: Shown, live: LiveProjectSnapshot): void {
  if (shown !== entry) return;
  if (entry.live && live.revision < entry.live.revision) return;
  entry.live = live;
  publish(entry, true);
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
 * The join ended: the editor closes the host's project, as it closes one of its own, and goes back to this
 * computer's. Why it ended is said once the editor has left it (closing clears the notices).
 */
function end(ended: { reason: string; message: string } | null): void {
  const entry = shown;
  if (!entry) return;
  shown = null;
  if (entry.snapshot) transport.emit(entry.remote, 'project:closed', undefined);
  transport.use(null);
  setState({ remotePresence: null, remoteReload: { seq: 0, revision: null } });
  if (ended && ended.reason !== 'left') toast(ended.message, 'info');
}

// ---------------------------------------------------------------------------
// Joining and leaving

/**
 * Join the live session an invite link names. A project of this computer's that is open is closed first, through the
 * usual close (it saves what is being typed, or asks); one the author keeps open keeps the join from starting.
 */
export async function joinLive(inviteLink: string, displayName: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (getState().snapshot && !showsRemote()) {
    const closed = await api.projects.close().catch(() => ({ ok: false }));
    if (!closed.ok) return { ok: false, message: 'The open project was kept open, so the live session was not joined.' };
  }
  try {
    const result = await api.remote.join({ inviteLink, displayName });
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  } catch (e) {
    return { ok: false, message: `The live session could not be joined: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Leave the live session, or stop asking to join one. */
export async function leaveLive(): Promise<void> {
  await api.remote.leave().catch(() => undefined);
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
  const historyRefused = async (): Promise<ApplyResult> => ({
    ok: false,
    revision: revision(),
    error: { code: 'CONFLICT', message: 'Undo and Redo are the host’s in a live session: ask the host to undo a change.', recoverable: false }
  });
  return {
    project: {
      snapshot: async () => mine()?.snapshot ?? null,
      apply: async (batch: EditBatch, opts?: { label?: string; opening?: string }): Promise<ApplyResult> => {
        if (!mine() || (opts?.opening !== undefined && opts.opening !== opening)) return { ok: false, revision: revision(), error: { code: 'SCOPE_MISMATCH', message: 'That change was made in a live session that has ended.', recoverable: false } };
        const label = opts?.label?.slice(0, LIVE_BATCH_LABEL_MAX);
        const result = await api.remote.apply(joinId, { operations: batch.operations, ...(batch.expectedRevision !== undefined ? { expectedRevision: batch.expectedRevision } : {}), ...(label ? { label } : {}) });
        return remoteApplyResult(result, revision());
      },
      undo: historyRefused,
      redo: historyRefused,
      undoEntry: historyRefused,
      stepHistory: historyRefused,
      // Nothing of the host's project is saved on this computer: there is nothing to wait for.
      flush: async () => true,
      saveLocalState: async () => undefined,
      // An edit refused as out of date reads the host's project again.
      reloadFromDisk: async () => {
        const live = await api.remote.snapshot(joinId).catch(() => null);
        const entry = mine();
        if (entry && live) takeLive(entry, live);
        return live ? { ok: true } : { ok: false, message: 'The host’s project could not be read.' };
      },
      retryPreview: async () => {
        const at = getState().remoteReload;
        setState({ remoteReload: { seq: at.seq + 1, revision: at.revision } });
      },
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
      // Closing the host's project is leaving the session.
      close: async () => {
        await leaveLive();
        return { ok: true };
      },
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
