import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BuilderApi, ProjectSnapshot, RemoteState } from '@shared/api';
import type { LiveProjectSnapshot } from '@shared/live/snapshot';
import { createStarterState } from '@catalogue/starters';

/**
 * The editor as a remote shell (#766): one API whose calls reach this computer's project or, while the editor shows a
 * host's project as a guest in its live session, the host's, by the call; the host's project shown from what guests
 * are sent, read-only whenever the guest cannot edit it now; and the editor back on this computer's own, with nothing
 * of the session left, when it ends. The preload bridge is a stand-in the test drives.
 */

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();
const emit = (channel: string, payload: unknown) => handlers.get(channel)?.forEach((h) => h(payload));
const calls = { localApply: 0, remoteApply: [] as unknown[], closes: 0, joins: [] as unknown[], leaves: 0, snapshots: [] as string[], presence: [] as unknown[] };
let closeAnswer = { ok: true };
/** What the main process says the join is, when the editor asks. */
let remoteStateAnswer: RemoteState = { phase: 'idle', ended: null };
const APPLIED = { ok: true, revision: 8, results: [{ nodeId: 'n-new' }] };
/** The host's answer to the next edit. */
let remoteApplyAnswer: unknown = APPLIED;
let remoteSnapshot: LiveProjectSnapshot | null = null;

const state = createStarterState('business', 'Acme', false);
const home = state.site.homePageId;
const live = (revision: number, extra: Partial<LiveProjectSnapshot> = {}): LiveProjectSnapshot => ({ revision, state: state as never, readOnly: false, aiBusy: false, runtime: { state: 'ready' }, ...extra });
const admitted = (extra: Partial<Extract<RemoteState, { phase: 'admitted' }>> = {}): Extract<RemoteState, { phase: 'admitted' }> => ({
  phase: 'admitted',
  joinId: 'join-1',
  relayUrl: 'http://relay.localhost:8787',
  roomId: 'abcdefghijkmnpqrstuvwxyz',
  displayName: 'Sarah',
  hostConnected: true,
  reconnecting: false,
  guestId: 'g-1',
  role: 'collaborator',
  projectName: 'Acme',
  guestExpiresAt: null,
  sessionExpiresAt: Date.now() + 3_600_000,
  relayClockOffsetMs: 0,
  hostRuntime: 'ready',
  previewRevision: null,
  previewUrl: 'http://127.0.0.1:4555',
  previewProblem: null,
  tooLarge: false,
  participants: [],
  ...extra
});

/**
 * The renderer's modules, loaded by path: the Node project's type check (tsconfig.node.json) then never takes in the
 * renderer, which needs the DOM's types, as the other renderer tests do it.
 */
const PATHS = {
  store: '../../src/renderer/src/store',
  session: '../../src/renderer/src/lib/remote-session',
  snapshots: '../../src/renderer/src/lib/remote-snapshot',
  view: '../../src/renderer/src/lib/remote-view',
  transports: '../../src/renderer/src/lib/transport',
  liveHost: '../../src/renderer/src/lib/live-host'
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loaded = any;
let store: Loaded;
let session: Loaded;
let snapshots: Loaded;
let view: Loaded;
let transports: Loaded;
let liveHost: Loaded;

beforeAll(async () => {
  // Leaving settles what is being typed (lib/leave.ts), which looks for the focused field.
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement ??= class {};
  (globalThis as unknown as { document: unknown }).document = { activeElement: null, body: null, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    builder: {
      platform: 'test',
      on: (channel: string, cb: Handler) => {
        const set = handlers.get(channel) ?? new Set();
        set.add(cb);
        handlers.set(channel, set);
        return () => set.delete(cb);
      },
      app: { getSettings: async () => ({}) },
      projects: {
        close: async () => {
          calls.closes++;
          return closeAnswer;
        },
        recents: async () => []
      },
      project: {
        apply: async () => {
          calls.localApply++;
          return { ok: true, revision: 1 };
        },
        snapshot: async () => null,
        saveLocalState: async () => undefined
      },
      ai: { conversations: async () => ({ active: { id: 'local', messages: [] }, list: [] }), providers: async () => [] },
      live: { state: async () => ({ phase: 'idle', lastError: null }) },
      remote: {
        join: async (opts: unknown) => {
          calls.joins.push(opts);
          return { ok: true, state: { phase: 'waiting' } };
        },
        leave: async () => void calls.leaves++,
        state: async () => remoteStateAnswer,
        snapshot: async (joinId: string) => {
          calls.snapshots.push(joinId);
          return remoteSnapshot;
        },
        apply: async (joinId: string, batch: unknown) => {
          calls.remoteApply.push({ joinId, batch });
          return remoteApplyAnswer;
        },
        presence: async (joinId: string, presence: unknown) => {
          calls.presence.push({ joinId, presence });
          return true;
        }
      }
    }
  };
  store = await import(/* @vite-ignore */ PATHS.store);
  session = await import(/* @vite-ignore */ PATHS.session);
  snapshots = await import(/* @vite-ignore */ PATHS.snapshots);
  view = await import(/* @vite-ignore */ PATHS.view);
  transports = await import(/* @vite-ignore */ PATHS.transports);
  liveHost = await import(/* @vite-ignore */ PATHS.liveHost);
});

const offs: Array<() => void> = [];
afterEach(() => {
  // Each case ends with the editor on this computer's own projects again.
  session.applyRemoteState({ phase: 'idle', ended: null });
  offs.splice(0).forEach((off) => off());
  handlers.clear();
  calls.localApply = calls.closes = calls.leaves = 0;
  calls.remoteApply.length = calls.joins.length = calls.snapshots.length = calls.presence.length = 0;
  closeAnswer = { ok: true };
  remoteSnapshot = null;
  remoteStateAnswer = { phase: 'idle', ended: null };
  remoteApplyAnswer = APPLIED;
  store.setState({ toasts: [], snapshot: null, remote: { phase: 'idle', ended: null }, remotePresence: null, selection: null, pageId: null });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

/** The editor's project events, as App listens for them. */
function listen() {
  const changed: ProjectSnapshot[] = [];
  let closed = 0;
  offs.push(store.api.on('project:changed', (s: ProjectSnapshot) => void changed.push(s)), store.api.on('project:closed', () => void closed++));
  return { changed, closed: () => closed };
}

/** Admitted to a host's session, with the host's project at revision 7 shown as the editor shows it. */
async function shown(extra: Partial<Extract<RemoteState, { phase: 'admitted' }>> = {}) {
  const events = listen();
  remoteSnapshot = live(7);
  remoteStateAnswer = admitted(extra);
  session.applyRemoteState(admitted(extra));
  await flush();
  const snap = events.changed.at(-1)!;
  // As App does with a snapshot of another opening.
  store.setState({ snapshot: snap, pageId: home });
  return events;
}

describe('the transport', () => {
  it('routes each call when it is made, so a method kept before the switch reaches the project shown now', async () => {
    let localCalls = 0;
    const local = { platform: 'test', project: { apply: async () => ++localCalls }, app: { info: async () => 'local app' }, on: () => () => undefined } as unknown as BuilderApi;
    const t = transports.createTransport(() => local);
    const kept = t.api.project;
    const { apply } = t.api.project;
    await apply({ operations: [] });
    let remoteCalls = 0;
    const remote = { project: { apply: async () => ++remoteCalls } };
    t.use(remote as never);
    await kept.apply({ operations: [] });
    await apply({ operations: [] });
    expect([localCalls, remoteCalls]).toEqual([1, 2]);
    // This computer's own app stays its own.
    expect(await t.api.app.info()).toBe('local app');
    // A project method the remote shell does not answer is refused, never passed to this computer's project.
    await expect(t.api.project.exportStatic()).rejects.toBeInstanceOf(transports.HostOnlyError);
    t.use(null);
    await kept.apply({ operations: [] });
    expect([localCalls, remoteCalls]).toEqual([2, 2]);
  });

  it('delivers the shown project’s events only, and this computer’s own events always', () => {
    const listeners = new Map<string, Set<Handler>>();
    const local = { on: (ch: string, cb: Handler) => (listeners.set(ch, new Set([...(listeners.get(ch) ?? []), cb])), () => listeners.get(ch)!.delete(cb)) } as unknown as BuilderApi;
    const fire = (ch: string, p: unknown) => listeners.get(ch)?.forEach((cb) => cb(p));
    const t = transports.createTransport(() => local);
    const got: unknown[] = [];
    const menus: unknown[] = [];
    t.api.on('project:changed', (s: unknown) => void got.push(s));
    t.api.on('menu:command', (m: unknown) => void menus.push(m));
    fire('project:changed', 'local 1');
    const remote = {};
    const other = {};
    t.use(remote as never);
    fire('project:changed', 'local while remote');
    t.emit(remote as never, 'project:changed', 'remote 1');
    t.emit(other as never, 'project:changed', 'another remote');
    fire('menu:command', 'menu while remote');
    t.use(null);
    t.emit(remote as never, 'project:changed', 'remote after it ended');
    fire('project:changed', 'local 2');
    expect(got).toEqual(['local 1', 'remote 1', 'local 2']);
    expect(menus).toEqual(['menu while remote']);
  });
});

describe('the host’s project as the editor shows it', () => {
  it('is editable by a collaborator, with nothing of the host’s own history, folder or AI', () => {
    const snap = snapshots.remoteSnapshot(admitted(), live(7));
    expect(snap).toMatchObject({ dir: '', revision: 7, readOnly: null, aiBusy: false, workspaceKey: 'remote:join-1', history: { canUndo: false, canRedo: false, entries: [] }, conflicts: [], runtime: { state: 'ready', url: 'http://127.0.0.1:4555' } });
    expect(snapshots.isRemoteOpening(snap.workspaceKey)).toBe(true);
  });

  it('is read-only, saying why, whenever the guest cannot edit it now', () => {
    const reason = (remote: Partial<Extract<RemoteState, { phase: 'admitted' }>>, l: Partial<LiveProjectSnapshot> = {}) => snapshots.remoteSnapshot(admitted(remote), live(7, l)).readOnly?.reason;
    expect(reason({ role: 'viewer' })).toMatch(/as a viewer/);
    expect(reason({ hostConnected: false })).toMatch(/host is reconnecting/);
    expect(reason({ reconnecting: true })).toMatch(/connection to the live session dropped/);
    expect(reason({ tooLarge: true })).toMatch(/too large/);
    expect(reason({}, { readOnly: true })).toMatch(/open read-only/);
    // The host's AI at work is a reason to wait, never a run this editor could stop.
    expect(reason({}, { aiBusy: true })).toMatch(/AI is making changes/);
    expect(snapshots.remoteSnapshot(admitted(), live(7, { aiBusy: true })).aiBusy).toBe(false);
    expect(snapshots.remoteSnapshot(admitted({ role: 'viewer' }), live(7)).readOnly?.canUnlock).toBe(false);
  });

  it('shows the preview only once the host’s is running and the cookie is in place', () => {
    expect(snapshots.remoteRuntime(admitted({ previewUrl: null }))).toEqual({ state: 'starting' });
    expect(snapshots.remoteRuntime(admitted({ previewUrl: null, previewProblem: 'Could not open' }))).toEqual({ state: 'error', message: 'Could not open' });
    // A grant that could not be renewed is never shown as the page of the one before it.
    expect(snapshots.remoteRuntime(admitted({ previewProblem: 'Could not open' }))).toEqual({ state: 'error', message: 'Could not open' });
    expect(snapshots.remoteRuntime(admitted({ hostRuntime: 'starting' }))).toEqual({ state: 'starting' });
    expect(snapshots.remoteRuntime(admitted({ hostRuntime: 'error' }))).toMatchObject({ state: 'error' });
    expect(snapshots.remoteRuntime(admitted({ hostRuntime: 'unavailable' }))).toMatchObject({ state: 'unavailable' });
  });

  it('reads the host’s answers as the editor reads an edit’s result', () => {
    expect(snapshots.remoteApplyResult({ ok: true, revision: 8, results: [{ pageId: 'p' }] }, 7)).toEqual({ ok: true, revision: 8, results: [{ pageId: 'p' }] });
    expect(snapshots.remoteApplyResult({ ok: false, error: { code: 'STALE_REVISION', message: 'Moved on', recoverable: true } }, 7)).toEqual({ ok: false, revision: 7, error: { code: 'STALE_REVISION', message: 'Moved on', recoverable: true } });
    // A refusal of a live session's own, or the host busy with its AI, is a change not made, in its words: never an AI
    // the guest could stop, nor a conflict that would read this computer's files again.
    for (const code of ['PERMISSION_DENIED', 'BUSY', 'EXPIRED', 'UNAVAILABLE'] as const) expect(snapshots.remoteToolError({ code, message: 'No', recoverable: true })).toEqual({ code: 'CANCELLED', message: 'No', recoverable: true });
    expect(snapshots.remoteToolError({ code: 'VALIDATION_FAILED', message: 'Bad', recoverable: false, operationIndex: 2 })).toEqual({ code: 'VALIDATION_FAILED', message: 'Bad', recoverable: false, operationIndex: 2 });
  });
});

describe('following the session', () => {
  it('opens the host’s project once admitted and sends the editor’s edits to the host, never to this computer', async () => {
    const events = await shown();
    offs.push(...session.followRemote());
    expect(calls.snapshots).toEqual(['join-1']);
    expect(events.changed.at(-1)).toMatchObject({ workspaceKey: 'remote:join-1', revision: 7 });
    expect(store.transport.remote).toBe(true);
    expect(session.isRemoteShell(store.getState())).toBe(true);
    // An edit is answered once the editor holds the project that has it, as a local one is, so what it made can be selected.
    let answered = false;
    const applying = store.api.project.apply({ operations: [{ type: 'page.update', pageId: home, title: 'Hi' }], expectedRevision: 7 }, { label: 'Rename page', opening: 'remote:join-1' }).then((r: unknown) => ((answered = true), r));
    await flush();
    expect(answered).toBe(false);
    emit('remote:changed', { joinId: 'join-1', snapshot: live(8) });
    const result = await applying;
    expect(result).toEqual({ ok: true, revision: 8, results: [{ nodeId: 'n-new' }] });
    expect(events.changed.at(-1)?.revision).toBe(8);
    expect(calls.remoteApply).toEqual([{ joinId: 'join-1', batch: { operations: [{ type: 'page.update', pageId: home, title: 'Hi' }], expectedRevision: 7, label: 'Rename page' } }]);
    expect(calls.localApply).toBe(0);
    // An edit made in another opening (this computer's project, a join that ended) is refused here.
    expect(await store.api.project.apply({ operations: [] }, { opening: '/sites/acme#1' })).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
    // What the editor asks of every project is answered with nothing to show; the host's alone is refused.
    expect(await store.api.project.flush()).toBe(true);
    await expect(store.api.project.saveLocalState({}, 'remote:join-1')).resolves.toBeUndefined();
    expect(await store.api.project.savedComponents('remote:join-1')).toEqual([]);
    expect(await store.api.live.state()).toEqual({ phase: 'idle', lastError: null });
    await expect(store.api.ai.conversations()).rejects.toBeInstanceOf(transports.HostOnlyError);
    await expect(store.api.project.exportStatic()).rejects.toBeInstanceOf(transports.HostOnlyError);
    expect(await store.api.project.undo()).toMatchObject({ ok: false, error: { message: expect.stringMatching(/the host’s/) } });
  });

  it('follows the host’s changes, never an older one or another join’s, and goes read-only at once when made a viewer', async () => {
    const events = await shown();
    offs.push(...session.followRemote());
    emit('remote:changed', { joinId: 'join-1', snapshot: live(9) });
    emit('remote:changed', { joinId: 'join-1', snapshot: live(8) });
    emit('remote:changed', { joinId: 'join-0', snapshot: live(12) });
    expect(events.changed.map((s) => s.revision)).toEqual([7, 9]);
    emit('remote:state', admitted({ role: 'viewer' }));
    expect(events.changed.at(-1)).toMatchObject({ revision: 9, readOnly: { reason: expect.stringMatching(/as a viewer/) } });
    // A deadline moving changes nothing the editor shows.
    const count = events.changed.length;
    emit('remote:state', admitted({ role: 'viewer', sessionExpiresAt: Date.now() + 7_200_000 }));
    expect(events.changed).toHaveLength(count);
    emit('remote:state', admitted({ role: 'collaborator' }));
    expect(events.changed.at(-1)?.readOnly).toBeNull();
  });

  it('asks the canvas to reload, and counts a page loaded now as the revision the host’s preview serves', async () => {
    await shown();
    offs.push(...session.followRemote());
    emit('remote:reload', { joinId: 'join-1', revision: 9 });
    expect(store.getState().remoteReload).toEqual({ seq: 1, revision: 9 });
    emit('remote:reload', { joinId: 'join-0', revision: 20 });
    expect(store.getState().remoteReload.seq).toBe(1);
    // Before the host has said, a page loaded shows the snapshot's revision; once it has, the one it said.
    expect(session.loadedRevision(store.getState())).toBe(7);
    emit('remote:state', admitted({ previewRevision: 6 }));
    expect(session.loadedRevision(store.getState())).toBe(6);
    // Locally, the editor's own revision.
    expect(session.loadedRevision({ snapshot: { revision: 4, workspaceKey: '/sites/acme#1' } as ProjectSnapshot, remote: admitted({ previewRevision: 9 }) })).toBe(4);
  });

  it('never answers an edit as made once its join has ended while it waited for the project', async () => {
    await shown();
    const applying = store.api.project.apply({ operations: [{ type: 'page.update', pageId: home, title: 'Hi' }] }, { opening: 'remote:join-1' });
    await flush();
    session.applyRemoteState({ phase: 'idle', ended: { reason: 'kicked', message: 'The host removed you from the live session.' } });
    expect(await applying).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  });

  it('reads the host’s project as it is now when an edit is refused as out of date, so the retry sees it', async () => {
    await shown();
    remoteApplyAnswer = { ok: false, error: { code: 'STALE_REVISION', message: 'Moved on', recoverable: true } };
    remoteSnapshot = live(9);
    const asked = calls.snapshots.length;
    expect(await store.api.project.apply({ operations: [] }, { opening: 'remote:join-1' })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect(calls.snapshots.length).toBe(asked + 1);
    expect((await store.api.project.snapshot())?.revision).toBe(9);
  });

  it('refuses an edit while editing is paused, whatever asked for it, without asking the host', async () => {
    await shown({ role: 'viewer' });
    const result = await store.api.project.apply({ operations: [{ type: 'page.update', pageId: home, title: 'Hi' }] }, { opening: 'remote:join-1' });
    expect(result).toMatchObject({ ok: false, error: { code: 'CANCELLED', message: expect.stringMatching(/as a viewer/) } });
    expect(calls.remoteApply).toEqual([]);
  });

  it('settles what is being typed before leaving the host’s project, and only then leaves', async () => {
    await shown();
    expect(await session.leaveLive()).toBe(true);
    expect(calls.leaves).toBe(1);
  });

  it('closes the host’s project and puts the editor back on this computer’s own when the session ends, saying why', async () => {
    const events = await shown();
    session.applyRemoteState({ phase: 'idle', ended: { reason: 'kicked', message: 'The host removed you from the live session.' } });
    expect(events.closed()).toBe(1);
    expect(store.transport.remote).toBe(false);
    expect(store.getState().toasts.map((t: { text: string }) => t.text)).toEqual(['The host removed you from the live session.']);
    expect(store.getState().remoteReload).toEqual({ seq: 0, revision: null });
    // This computer's project answers again.
    await store.api.project.apply({ operations: [] });
    expect(calls.localApply).toBe(1);
  });

  it('leaves quietly when the guest itself left', async () => {
    const events = await shown();
    session.applyRemoteState({ phase: 'idle', ended: { reason: 'left', message: 'You left the live session.' } });
    expect(events.closed()).toBe(1);
    expect(store.getState().toasts).toEqual([]);
  });

  it('closes a project of this computer’s before joining, and joins nothing when the author keeps it open', async () => {
    store.setState({ snapshot: { workspaceKey: '/sites/acme#1', state } as unknown as ProjectSnapshot });
    closeAnswer = { ok: false };
    expect(await session.joinLive('http://relay.localhost:8787/s/abcdefghijkmnpqrstuvwxyz', 'Sarah')).toMatchObject({ ok: false });
    expect(calls.joins).toEqual([]);
    closeAnswer = { ok: true };
    expect(await session.joinLive('http://relay.localhost:8787/s/abcdefghijkmnpqrstuvwxyz', 'Sarah')).toEqual({ ok: true });
    expect(calls.closes).toBe(2);
    expect(calls.joins).toEqual([{ inviteLink: 'http://relay.localhost:8787/s/abcdefghijkmnpqrstuvwxyz', displayName: 'Sarah' }]);
    // Called off while the project closed: no request reaches the host.
    expect(await session.joinLive('http://relay.localhost:8787/s/abcdefghijkmnpqrstuvwxyz', 'Sarah', () => false)).toMatchObject({ ok: false });
    expect(calls.joins).toHaveLength(1);
    // Called off while the request went out: the place is given up again.
    store.setState({ snapshot: null });
    let asks = 0;
    expect(await session.joinLive('http://relay.localhost:8787/s/abcdefghijkmnpqrstuvwxyz', 'Sarah', () => ++asks < 2)).toMatchObject({ ok: false });
    expect(calls.joins).toHaveLength(2);
    expect(calls.leaves).toBe(1);
  });

  it('lets nothing of a join that never showed the host’s project hold the next editor', async () => {
    remoteSnapshot = null;
    session.applyRemoteState(admitted());
    await flush();
    store.setState({ leaving: true });
    session.applyRemoteState({ phase: 'idle', ended: { reason: 'left', message: 'You left the live session.' } });
    expect(store.getState().leaving).toBe(false);
  });

  it('leaves no dialog of the host’s project open for whatever opens next', async () => {
    await shown();
    store.setState({ modal: { kind: 'delete-page', pageId: home } });
    session.applyRemoteState({ phase: 'idle', ended: { reason: 'ended', message: 'The host ended the live session.' } });
    expect(store.getState().modal).toBeNull();
  });
});

describe('presence', () => {
  const headline = () => {
    const id = state.pages[home].rootIds[0];
    return { owner: { kind: 'page' as const, id: home }, instancePath: [], nodeId: id };
  };

  it('tells the others where a collaborator is and what it selected, and nothing once a viewer', async () => {
    await shown();
    offs.push(session.syncRemotePresence());
    store.setState({ selection: headline(), viewport: 1024 });
    await new Promise((r) => setTimeout(r, session.REMOTE_PRESENCE_DELAY_MS + 30));
    expect(calls.presence).toEqual([{ joinId: 'join-1', presence: { pageId: home, viewportWidth: 1024, selection: headline(), previewPath: '/' } }]);
    store.setState({ remote: admitted({ role: 'viewer' }) });
    store.setState({ selection: null });
    await new Promise((r) => setTimeout(r, session.REMOTE_PRESENCE_DELAY_MS + 30));
    expect(calls.presence).toHaveLength(1);
  });

  it('shares a selection only on the page shown, or its header and footer', () => {
    const ref = headline();
    const hostAt = liveHost.hostPresenceOf({ ...store.getState(), snapshot: { state } as ProjectSnapshot, pageId: home, selection: ref, definitionMode: null, templateMode: null, leftTab: 'pages', postView: 'write', mode: 'edit', post: null, postPreviewAt: null, viewport: 1280 });
    expect(hostAt.selection).toEqual(ref);
    const elsewhere = liveHost.hostPresenceOf({ ...store.getState(), snapshot: { state } as ProjectSnapshot, pageId: home, selection: { ...ref, owner: { kind: 'page', id: 'another-page' } }, definitionMode: null, templateMode: null, leftTab: 'pages', postView: 'write', mode: 'edit', post: null, postPreviewAt: null, viewport: 1280 });
    expect(elsewhere.selection).toBeNull();
  });

  it('says who is where, the host first, never this guest or anyone no longer a collaborator', () => {
    const at = { pageId: home, viewportWidth: 1280, selection: headline(), previewPath: '/' };
    const remote = admitted({
      participants: [
        { guestId: 'g-1', displayName: 'Sarah', role: 'collaborator' },
        { guestId: 'g-2', displayName: 'Tom', role: 'collaborator' },
        { guestId: 'g-3', displayName: 'Ann', role: 'viewer' }
      ]
    });
    const lines = view.presenceLines(state, remote, { joinId: 'join-1', host: { ...at, selection: null }, guests: { 'g-1': at, 'g-2': at, 'g-3': at } });
    expect(lines.map((l: { who: string; pageId: string | null }) => [l.who, l.pageId])).toEqual([
      ['Host', home],
      ['Tom', home]
    ]);
    expect(lines[0].where).toBe(state.pages[home].title);
    expect(lines[1].where).toMatch(new RegExp(` on ${state.pages[home].title}$`));
    expect(view.presenceLines(state, remote, { joinId: 'join-0', host: at, guests: {} })).toEqual([]);
  });

  it('shows the role and the time left on the pill, and when the host or the connection is away', () => {
    const now = 1_000_000;
    const remote = admitted({ sessionExpiresAt: now + 90 * 60_000, guestExpiresAt: now + 30 * 60_000 });
    expect(view.remoteLeftMs(remote, now)).toBe(30 * 60_000);
    expect(view.remotePill(remote, now)).toMatchObject({ kind: 'live', text: 'Collaborator · 30m', label: 'Connected to Acme as Collaborator, 30 minutes left' });
    expect(view.remotePill(admitted({ role: 'viewer', sessionExpiresAt: now + 60_000 }), now).text).toBe('Viewer · 1m');
    expect(view.remotePill(admitted({ hostConnected: false }), now).kind).toBe('away');
    expect(view.remotePill(admitted({ reconnecting: true }), now).kind).toBe('reconnecting');
  });
});
