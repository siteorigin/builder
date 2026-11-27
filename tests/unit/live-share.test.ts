import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LiveHostState, LiveJoinRequest, LiveRun, LiveStartResult, ProjectSnapshot } from '@shared/api';
import type { Presence } from '@shared/live/messages';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { entryRoute } from '@shared/collections';

/**
 * The editor's side of hosting a live session (#764): following the main process's session for the opening it belongs
 * to, copying the invite link only for a start that is still current, telling screen readers who waits, offering the
 * waiting room's answers, and keeping guests told where the host is. The preload bridge is a stand-in the test drives.
 */

interface StoreModule {
  getState(): { live: LiveHostState; liveNotice: { id: number; text: string }; toasts: Array<{ text: string; kind: string }>; snapshot: ProjectSnapshot | null; shareOpen: boolean };
  setState(patch: Record<string, unknown>): void;
}
interface LiveHostModule {
  followLive(): Array<() => void>;
  syncPresence(): () => void;
  startLive(duration: string): Promise<boolean>;
  cancelStart(run: LiveRun): Promise<boolean>;
  applyLiveState(state: LiveHostState): void;
  PRESENCE_DELAY_MS: number;
}
interface JoinModule {
  JoinRequestList(props: { live: LiveHostState }): unknown;
}

const STORE_PATH = '../../src/renderer/src/store';
const LIVE_PATH = '../../src/renderer/src/lib/live-host';
const JOIN_PATH = '../../src/renderer/src/components/JoinRequests';

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();
const emit = (channel: string, payload: unknown) => handlers.get(channel)?.forEach((h) => h(payload));
const calls = { presence: [] as Array<{ run: LiveRun; presence: Presence }>, copied: [] as string[], started: [] as unknown[] };
let answerState: (() => Promise<LiveHostState>) | null = null;
let answerStart: (() => Promise<LiveStartResult>) | null = null;

let store: StoreModule;
let live: LiveHostModule;
let join: JoinModule;

beforeAll(async () => {
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
      live: {
        state: () => (answerState ? answerState() : Promise.resolve({ phase: 'idle', lastError: null })),
        start: (opts: unknown) => {
          calls.started.push(opts);
          return answerStart!();
        },
        stop: async () => ({ ok: true }),
        presence: async (run: LiveRun, presence: Presence) => {
          calls.presence.push({ run, presence });
          return { ok: true };
        },
        admit: async () => ({ ok: true }),
        decline: async () => ({ ok: true })
      }
    }
  };
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void calls.copied.push(text) } });
  store = (await import(/* @vite-ignore */ STORE_PATH)) as StoreModule;
  live = (await import(/* @vite-ignore */ LIVE_PATH)) as LiveHostModule;
  join = (await import(/* @vite-ignore */ JOIN_PATH)) as unknown as JoinModule;
});

const offs: Array<() => void> = [];
afterEach(() => {
  offs.splice(0).forEach((off) => off());
  vi.useRealTimers();
  handlers.clear();
  calls.presence.length = 0;
  calls.copied.length = 0;
  calls.started.length = 0;
  answerState = answerStart = null;
  store.setState({ live: { phase: 'idle', lastError: null }, liveClock: null, toasts: [], snapshot: null, shareOpen: false, pageId: null, templateMode: null, definitionMode: null, leftTab: 'pages', postView: 'write', mode: 'edit', post: null, postPreviewAt: null });
});

const state = createStarterState('business', 'Acme', false);
const homeId = state.site.homePageId;
const aboutId = state.site.pageOrder.find((id) => state.pages[id].title === 'About')!;
const snap = (workspaceKey: string) => ({ workspaceKey, state, revision: 1, conflicts: [], history: {} }) as unknown as ProjectSnapshot;

function active(workspaceKey = '/sites/acme#1', runId = 'run-1', participants: Array<Record<string, unknown>> = []): LiveHostState {
  const now = Date.now();
  return { phase: 'active', workspaceKey, runId, roomId: 'abcdefghijkmnpqrstuvwxyz', inviteUrl: 'http://relay.localhost:8787/s/abcdefghijkmnpqrstuvwxyz', projectName: 'Acme', duration: '2h', startedAt: now, expiresAt: now + 7_200_000, relayClockOffsetMs: 0, locked: false, participants, previewReady: true, lastError: null } as LiveHostState;
}
const request = (displayName: string, guestId: string, runId = 'run-1'): LiveJoinRequest => ({ workspaceKey: '/sites/acme#1', runId, roomId: 'abcdefghijkmnpqrstuvwxyz', guestId, displayName });
const pending = (displayName: string, guestId: string) => ({ guestId, displayName, status: 'pending' });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('following the session', () => {
  it('drops an answer to “what is running” that an event has overtaken', async () => {
    let answer!: (s: LiveHostState) => void;
    answerState = () => new Promise((r) => (answer = r));
    store.setState({ snapshot: snap('/sites/acme#1') });
    offs.push(...live.followLive());
    emit('live:state', active());
    // The question was asked before the session started; its answer is older than the event.
    answer({ phase: 'idle', lastError: null });
    await flush();
    expect(store.getState().live.phase).toBe('active');
  });

  it('takes the answer when nothing has arrived since, for an editor opened while a session runs', async () => {
    answerState = async () => active();
    store.setState({ snapshot: snap('/sites/acme#1') });
    offs.push(...live.followLive());
    await flush();
    expect(store.getState().live.phase).toBe('active');
  });

  it('says once that a session ended on its own, and nothing when the host ended it', () => {
    store.setState({ snapshot: snap('/sites/acme#1') });
    live.applyLiveState(active());
    live.applyLiveState({ phase: 'idle', lastError: 'The live session reached its end.' });
    live.applyLiveState({ phase: 'idle', lastError: 'The live session reached its end.' });
    expect(store.getState().toasts.map((t) => t.text)).toEqual(['The live session reached its end.']);
    live.applyLiveState(active());
    live.applyLiveState({ phase: 'idle', lastError: null });
    expect(store.getState().toasts).toHaveLength(1);
  });

  it('leaves a start that failed to the start to say, and another project’s session ending unsaid', () => {
    store.setState({ snapshot: snap('/sites/acme#1') });
    live.applyLiveState({ phase: 'starting', workspaceKey: '/sites/acme#1', runId: 'run-1' });
    live.applyLiveState({ phase: 'idle', lastError: 'The live session relay could not be reached.' });
    expect(store.getState().toasts).toEqual([]);
    // A session that ran its course while another project took its place.
    live.applyLiveState({ ...active(), phase: 'reconnecting' } as LiveHostState);
    store.setState({ snapshot: snap('/sites/other#2') });
    live.applyLiveState({ phase: 'idle', lastError: 'The live session reached its end.' });
    expect(store.getState().toasts).toEqual([]);
    // From reconnecting, in its own opening, it is said.
    store.setState({ snapshot: snap('/sites/acme#1') });
    live.applyLiveState({ ...active(), phase: 'reconnecting' } as LiveHostState);
    live.applyLiveState({ phase: 'idle', lastError: 'The live session lost its connection to the relay and could not get it back.' });
    expect(store.getState().toasts.map((t) => t.text)).toEqual(['The live session lost its connection to the relay and could not get it back.']);
  });

  it('tells screen readers who is waiting, together when they asked at once, and only while they still wait', async () => {
    vi.useFakeTimers();
    store.setState({ snapshot: snap('/sites/acme#1') });
    offs.push(...live.followLive());
    emit('live:state', active('/sites/acme#1', 'run-1', [pending('Ann', 'g1'), pending('Bo', 'g2'), pending('Cy', 'g3')]));
    emit('live:request', request('Ann', 'g1'));
    emit('live:request', request('Bo', 'g2'));
    // Another session's request is never this one's.
    emit('live:request', request('Zed', 'g9', 'run-0'));
    await vi.advanceTimersByTimeAsync(200);
    expect(store.getState().liveNotice.text).toBe('Ann and Bo want to join the live session');
    // Cy asks, and is let in before the notice is due: nobody is told about it.
    emit('live:request', request('Cy', 'g3'));
    emit('live:state', active('/sites/acme#1', 'run-1', [pending('Ann', 'g1'), pending('Bo', 'g2')]));
    const before = store.getState().liveNotice;
    await vi.advanceTimersByTimeAsync(200);
    expect(store.getState().liveNotice).toEqual(before);
  });

  it('names each guest still waiting by who it is, not by name', async () => {
    vi.useFakeTimers();
    store.setState({ snapshot: snap('/sites/acme#1') });
    offs.push(...live.followLive());
    emit('live:state', active('/sites/acme#1', 'run-1', [pending('Sam', 'g1'), pending('Sam', 'g2')]));
    emit('live:request', request('Sam', 'g1'));
    emit('live:request', request('Sam', 'g2'));
    // A request from an earlier session, by the name of a guest waiting now, is not this one's.
    emit('live:request', { ...request('Sam', 'g1'), runId: 'run-0' });
    // One Sam leaves before the notice is due.
    emit('live:state', active('/sites/acme#1', 'run-1', [pending('Sam', 'g2')]));
    await vi.advanceTimersByTimeAsync(200);
    expect(store.getState().liveNotice.text).toBe('Sam wants to join the live session');
  });
});

describe('starting', () => {
  it('copies the invite link once the session has started', async () => {
    store.setState({ snapshot: snap('/sites/acme#1') });
    answerStart = async () => ({ ok: true, inviteUrl: 'http://relay.localhost:8787/s/abcdefghijkmnpqrstuvwxyz', state: active() });
    expect(await live.startLive('30m')).toBe(true);
    expect(calls.started).toEqual([{ opening: '/sites/acme#1', duration: '30m' }]);
    expect(calls.copied).toEqual(['http://relay.localhost:8787/s/abcdefghijkmnpqrstuvwxyz']);
    expect(store.getState().toasts.at(-1)).toMatchObject({ text: 'Live session started. Invite link copied.' });
  });

  it('copies nothing for a start answered after the project switched', async () => {
    store.setState({ snapshot: snap('/sites/acme#1') });
    let answer!: (r: LiveStartResult) => void;
    answerStart = () => new Promise((r) => (answer = r));
    const started = live.startLive('2h');
    store.setState({ snapshot: snap('/sites/other#2') });
    answer({ ok: true, inviteUrl: 'http://relay.localhost:8787/s/abcdefghijkmnpqrstuvwxyz', state: active() });
    expect(await started).toBe(false);
    expect(calls.copied).toEqual([]);
  });

  it('says why a start failed', async () => {
    store.setState({ snapshot: snap('/sites/acme#1') });
    answerStart = async () => ({ ok: false, message: 'The live session relay at http://x could not be reached.' });
    expect(await live.startLive('30m')).toBe(false);
    expect(store.getState().toasts.at(-1)).toMatchObject({ kind: 'error', text: 'The live session relay at http://x could not be reached.' });
    answerStart = () => Promise.reject(new Error('IPC gone'));
    expect(await live.startLive('30m')).toBe(false);
    expect(store.getState().toasts.at(-1)).toMatchObject({ kind: 'error', text: 'The live session could not start: IPC gone' });
  });

  it('says nothing of a start that failed after its project closed', async () => {
    store.setState({ snapshot: snap('/sites/acme#1') });
    let answer!: (r: LiveStartResult) => void;
    answerStart = () => new Promise((r) => (answer = r));
    const started = live.startLive('2h');
    store.setState({ snapshot: snap('/sites/other#2') });
    answer({ ok: false, message: 'The live session was stopped before it started.' });
    expect(await started).toBe(false);
    expect(store.getState().toasts).toEqual([]);
  });

  it('says nothing of a start the host called off', async () => {
    store.setState({ snapshot: snap('/sites/acme#1') });
    let answer!: (r: LiveStartResult) => void;
    answerStart = () => new Promise((r) => (answer = r));
    const started = live.startLive('2h');
    await live.cancelStart({ workspaceKey: '/sites/acme#1', runId: 'run-1' });
    answer({ ok: false, message: 'The live session was stopped before it started.' });
    expect(await started).toBe(false);
    expect(store.getState().toasts).toEqual([]);
  });
});

describe('where the host is', () => {
  it('tells guests the page and width once a session starts, and once after a burst of changes', async () => {
    vi.useFakeTimers();
    store.setState({ snapshot: snap('/sites/acme#1'), pageId: homeId, viewport: 1280 });
    offs.push(live.syncPresence());
    store.setState({ live: { phase: 'starting', workspaceKey: '/sites/acme#1', runId: 'run-1' } });
    await vi.advanceTimersByTimeAsync(live.PRESENCE_DELAY_MS + 10);
    expect(calls.presence).toEqual([{ run: { workspaceKey: '/sites/acme#1', runId: 'run-1' }, presence: { pageId: homeId, viewportWidth: 1280, selection: null, previewPath: '/' } }]);
    // A width dragged over a moment, then another page: guests hear where the host ended up, once.
    for (const width of [1000, 900, 834]) {
      store.setState({ viewport: width });
      await vi.advanceTimersByTimeAsync(30);
    }
    store.setState({ pageId: aboutId });
    expect(calls.presence).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(live.PRESENCE_DELAY_MS + 10);
    expect(calls.presence.slice(1).map((c) => c.presence)).toEqual([{ pageId: aboutId, viewportWidth: 834, selection: null, previewPath: state.pages[aboutId].route }]);
    // Nothing new: nothing sent.
    store.setState({ live: active() });
    await vi.advanceTimersByTimeAsync(live.PRESENCE_DELAY_MS + 10);
    expect(calls.presence).toHaveLength(2);
  });

  it('sends nothing once the project has switched, even for a change still waiting to go out', async () => {
    vi.useFakeTimers();
    store.setState({ snapshot: snap('/sites/acme#1'), pageId: homeId, viewport: 1280, live: active() });
    offs.push(live.syncPresence());
    // A width alone is news.
    store.setState({ viewport: 834 });
    await vi.advanceTimersByTimeAsync(live.PRESENCE_DELAY_MS + 10);
    expect(calls.presence.map((c) => c.presence.viewportWidth)).toEqual([834]);
    calls.presence.length = 0;
    store.setState({ viewport: 390 });
    // The project closes before the change goes out: the session was that opening's.
    store.setState({ snapshot: snap('/sites/other#2') });
    await vi.advanceTimersByTimeAsync(live.PRESENCE_DELAY_MS + 10);
    expect(calls.presence).toEqual([]);
  });

  it('sends no page while a component is edited everywhere', async () => {
    vi.useFakeTimers();
    store.setState({ snapshot: snap('/sites/acme#1'), pageId: homeId, viewport: 1280, live: active() });
    offs.push(live.syncPresence());
    store.setState({ definitionMode: { definitionId: 'x', show: 'everywhere' }, viewport: 834 });
    await vi.advanceTimersByTimeAsync(live.PRESENCE_DELAY_MS + 10);
    expect(calls.presence.map((c) => c.presence)).toEqual([{ pageId: null, viewportWidth: 834, selection: null, previewPath: null }]);
  });

  it('follows a post previewed on the canvas, and where its visitor goes on to', async () => {
    vi.useFakeTimers();
    const posts = applyOperations(createStarterState('business', 'Acme', false), [
      { type: 'collection.create', collectionId: 'posts' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio', publishedAt: '2027-03-02', draft: false }
    ]).state;
    const c = posts.collections.posts;
    const entryId = 'en_spring';
    const about = posts.site.pageOrder.find((id) => posts.pages[id].title === 'About')!;
    const route = entryRoute(c, c.entries[entryId])!;
    expect(route).toMatch(/^\//);
    store.setState({ snapshot: { ...snap('/sites/acme#1'), state: posts }, pageId: posts.site.homePageId, viewport: 1280, live: active() });
    offs.push(live.syncPresence());
    store.setState({ leftTab: 'posts', postView: 'preview', mode: 'preview', post: { collectionId: c.settings.id, entryId } });
    await vi.advanceTimersByTimeAsync(live.PRESENCE_DELAY_MS + 10);
    expect(calls.presence.at(-1)?.presence).toEqual({ pageId: null, viewportWidth: 1280, selection: null, previewPath: route });
    // The visitor follows a link to a page of the site.
    store.setState({ postPreviewAt: posts.pages[about].route });
    await vi.advanceTimersByTimeAsync(live.PRESENCE_DELAY_MS + 10);
    expect(calls.presence.at(-1)?.presence).toMatchObject({ pageId: about, previewPath: posts.pages[about].route });
    // Under the writer the canvas shows nothing of the site.
    store.setState({ postView: 'write', mode: 'edit', postPreviewAt: null });
    await vi.advanceTimersByTimeAsync(live.PRESENCE_DELAY_MS + 10);
    expect(calls.presence.at(-1)?.presence).toEqual({ pageId: null, viewportWidth: 1280, selection: null, previewPath: null });
  });
});

describe('the waiting room', () => {
  it('offers one waiting guest Admit, as a viewer, and Decline, by name', () => {
    const html = renderToStaticMarkup(createElement(join.JoinRequestList as never, { live: active('/sites/acme#1', 'run-1', [pending('Ann', 'g1'), { guestId: 'g2', displayName: 'Quill', status: 'admitted', role: 'viewer', guestExpiresAt: null, colorSlot: 0, connected: true }]) }));
    expect(html).toContain('aria-label="Join requests"');
    expect(html).toContain('<strong>Ann</strong> wants to join');
    expect(html).not.toContain('Quill');
    expect(html).toContain('aria-label="Answer Ann"');
    for (const label of ['Admit as viewer', 'Decline']) expect(html).toContain(`>${label}</button>`);
    expect(html.match(/btn-primary/g)).toHaveLength(1);
  });

  it('gathers several waiting guests into one notice, answered in Share', () => {
    const waiting = ['Ann', 'Mo', 'Bea', 'Cy'].map((name, i) => pending(name, `g${i}`));
    const html = renderToStaticMarkup(createElement(join.JoinRequestList as never, { live: active('/sites/acme#1', 'run-1', waiting) }));
    expect(html.match(/class="toast live-request"/g)).toHaveLength(1);
    expect(html).toContain('<strong>4 people</strong> want to join');
    expect(html).toContain('Ann, Mo and 2 more');
    expect(html).toContain('>Review in Share</button>');
    expect(html).not.toContain('Admit as viewer');
  });

  it('stays hidden until someone new asks, then counts everyone still waiting', () => {
    const live = active('/sites/acme#1', 'run-1', [pending('Ann', 'g1'), pending('Mo', 'g3')]);
    // Hiding declines no one: with nobody new, there is no notice.
    expect(renderToStaticMarkup(createElement(join.JoinRequestList as never, { live, hidden: new Set(['g1', 'g3']) }))).toBe('');
    const html = renderToStaticMarkup(createElement(join.JoinRequestList as never, { live, hidden: new Set(['g1']), onHide: () => undefined }));
    expect(html).toContain('<strong>2 people</strong> want to join');
    expect(html).toContain('Ann and Mo');
    expect(html).toContain('aria-label="Hide these requests"');
  });

  it('stays while the session reconnects, saying when it can be answered instead of offering answers', () => {
    const reconnecting = { ...active('/sites/acme#1', 'run-1', [pending('Ann', 'g1')]), phase: 'reconnecting' } as LiveHostState;
    const html = renderToStaticMarkup(createElement(join.JoinRequestList as never, { live: reconnecting }));
    expect(html).toContain('<strong>Ann</strong> wants to join');
    expect(html).toContain('Answer once the session reconnects.');
    expect(html).not.toContain('Admit as viewer');
    expect(html).not.toContain('Answer once this dialog is closed.');
    // Several waiting: Review in Share still works while it reconnects, so a dialog is still what holds it back.
    const group = { ...active('/sites/acme#1', 'run-1', [pending('Ann', 'g1'), pending('Mo', 'g3')]), phase: 'reconnecting' } as LiveHostState;
    const many = renderToStaticMarkup(createElement(join.JoinRequestList as never, { live: group }));
    expect(many).toContain('Review in Share');
    expect(many).toContain('Answer once this dialog is closed.');
    expect(many).not.toContain('Answer once the session reconnects.');
  });

  it('shows nothing when nobody waits', () => {
    expect(renderToStaticMarkup(createElement(join.JoinRequestList as never, { live: active('/sites/acme#1', 'run-1', [{ guestId: 'g2', displayName: 'Quill', status: 'admitted', role: 'viewer', guestExpiresAt: null, colorSlot: 0, connected: true }]) }))).toBe('');
  });
});

describe('the others on the canvas (#768)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let marks: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let canvas: any;
  const MARKS_PATH = '../../src/renderer/src/lib/live-marks';
  const CANVAS_MARKS_PATH = '../../src/renderer/src/panels/CanvasMarks';
  beforeAll(async () => {
    marks = await import(/* @vite-ignore */ MARKS_PATH);
    canvas = await import(/* @vite-ignore */ CANVAS_MARKS_PATH);
  });
  const WS = '/sites/acme#1';
  const admittedGuest = (guestId: string, displayName: string, role: 'viewer' | 'collaborator', colorSlot: number, connected = true) => ({ guestId, displayName, status: 'admitted', role, guestExpiresAt: null, colorSlot, connected });
  const ann = admittedGuest('g1', 'Ann', 'collaborator', 0);
  const bea = admittedGuest('g2', 'Bea', 'viewer', 1);
  const cid = admittedGuest('g3', 'Cid', 'collaborator', 2, false);
  const heading = (pageId: string) => ({ owner: { kind: 'page' as const, id: pageId }, instancePath: [], nodeId: state.pages[pageId].rootIds[0] });
  const second = (pageId: string) => ({ owner: { kind: 'page' as const, id: pageId }, instancePath: [], nodeId: state.pages[pageId].rootIds[1] });
  const header = { owner: { kind: 'shell' as const, id: 'header' }, instancePath: [], nodeId: state.site.shell.header.rootIds[0] };
  const aboutPath = state.pages[aboutId].route;
  const on = (pageId: string, selection: unknown = null): Presence => ({ pageId, viewportWidth: 1280, selection: selection as Presence['selection'], previewPath: state.pages[pageId].route });
  const presence = (over: Record<string, unknown> = {}) => ({ workspaceKey: WS, runId: 'run-1', guests: {}, spotlights: {}, activity: {}, ...over });
  const pointAt = (previewPath: string, target: unknown = null, seq = 1) => ({ seq, spotlight: { previewPath, target, x: 0.5, y: 0.25 } });
  const hosting = (livePresence: unknown, participants: Array<Record<string, unknown>> = [ann, bea, cid], liveState: LiveHostState = active(WS, 'run-1', participants)) => ({ live: liveState, livePresence, snapshot: snap(WS), remote: { phase: 'idle', ended: null }, remotePresence: null });
  const here = (pageId: string) => ({ pageId, previewPath: state.pages[pageId].route });

  it('keeps where the collaborators are for the session shown, and forgets it with that session', () => {
    store.setState({ snapshot: snap(WS) });
    offs.push(...live.followLive());
    emit('live:state', active());
    emit('live:presence', presence({ guests: { g1: on(homeId) } }));
    expect((store.getState() as unknown as { livePresence: unknown }).livePresence).toEqual(presence({ guests: { g1: on(homeId) } }));
    // Another session's says nothing here.
    emit('live:presence', presence({ runId: 'run-0', guests: {} }));
    expect((store.getState() as unknown as { livePresence: { runId: string } }).livePresence.runId).toBe('run-1');
    emit('live:state', active(WS, 'run-2'));
    expect((store.getState() as unknown as { livePresence: unknown }).livePresence).toBeNull();
  });

  it('shows connected collaborators where they are, viewers only by their spotlights, and nobody while reconnecting', () => {
    const at = presence({ guests: { g1: on(homeId, heading(homeId)), g2: on(homeId), g3: on(homeId) }, spotlights: { g2: pointAt('/') }, activity: { g3: { seq: 1, target: null } } });
    expect(marks.livePeers(hosting(at)).map((p: { key: string; color: number; presence: unknown; spotlight: unknown }) => [p.key, p.color, !!p.presence, !!p.spotlight])).toEqual([
      ['g1', 0, true, false],
      ['g2', 1, false, true]
    ]);
    expect(marks.livePeers(hosting(at, [ann], { ...active(WS, 'run-1', [ann]), phase: 'reconnecting' } as LiveHostState))).toEqual([]);
    expect(marks.livePeers(hosting({ ...at, runId: 'run-0' }))).toEqual([]);
    expect(marks.livePeers({ ...hosting(at), snapshot: snap('/sites/other#1') })).toEqual([]);
  });

  it('outlines a collaborator’s selection on the page shown, or its header, and nothing gone or elsewhere', () => {
    const peers = (sel: unknown, pageId = homeId) => marks.livePeers(hosting(presence({ guests: { g1: on(pageId, sel) } })));
    const one = marks.canvasMarks(state, here(homeId), peers(heading(homeId)));
    expect(one.marks).toEqual([expect.objectContaining({ kind: 'selection', peer: 'g1', who: 'Ann', color: 0, ref: heading(homeId), editing: false })]);
    expect(one.away).toEqual([]);
    // The canvas on another page shows nothing of hers.
    expect(marks.canvasMarks(state, here(aboutId), peers(heading(homeId))).marks).toEqual([]);
    // The shared header shows while she is on the page shown, not while she is on another.
    expect(marks.canvasMarks(state, here(homeId), peers(header)).marks.map((m: { ref: unknown }) => m.ref)).toEqual([header]);
    expect(marks.canvasMarks(state, here(homeId), peers(header, aboutId)).marks).toEqual([]);
    // Something no longer in the project, or named by an inherited key, is outlined nowhere.
    expect(marks.canvasMarks(state, here(homeId), peers({ ...heading(homeId), nodeId: 'n_gone' })).marks).toEqual([]);
    expect(marks.canvasMarks(state, { pageId: 'toString', previewPath: '/' }, marks.livePeers(hosting(presence({ guests: { g1: { ...on(homeId), pageId: 'toString', selection: { owner: { kind: 'page', id: 'toString' }, instancePath: [], nodeId: 'constructor' } } } })))).marks).toEqual([]);
  });

  it('says a collaborator is editing what it selected, and outlines an edit of something else on its own', () => {
    const peersWith = (target: unknown) => marks.livePeers(hosting(presence({ guests: { g1: on(homeId, heading(homeId)) }, activity: { g1: { seq: 7, target } } })));
    expect(marks.canvasMarks(state, here(homeId), peersWith(heading(homeId))).marks).toEqual([expect.objectContaining({ kind: 'selection', editing: true })]);
    const apart = marks.canvasMarks(state, here(homeId), peersWith(second(homeId))).marks;
    expect(apart.map((m: { kind: string; editing: boolean }) => [m.kind, m.editing])).toEqual([
      ['selection', false],
      ['edit', true]
    ]);
    expect(apart[1].key).toBe('edit:g1:7');
    // An edit of several elements at once says so on the collaborator's selection; one of another page shows here on nothing.
    expect(marks.canvasMarks(state, here(homeId), peersWith(null)).marks).toEqual([expect.objectContaining({ kind: 'selection', editing: true, seq: 7 })]);
    expect(marks.canvasMarks(state, here(homeId), peersWith(heading(aboutId))).marks).toEqual([expect.objectContaining({ kind: 'selection', editing: false, seq: 0 })]);
    // An edit with no selection of theirs here still outlines what it changed.
    const editOnly = marks.livePeers(hosting(presence({ guests: { g1: on(aboutId) }, activity: { g1: { seq: 8, target: second(homeId) } } })));
    expect(marks.canvasMarks(state, here(homeId), editOnly).marks).toEqual([expect.objectContaining({ kind: 'edit', ref: second(homeId), seq: 8 })]);
  });

  it('rings a spotlight on the place shown, and offers the page of one pointed at elsewhere', () => {
    const peersWith = (spot: unknown) => marks.livePeers(hosting(presence({ spotlights: { g2: spot } })));
    const at = marks.canvasMarks(state, here(homeId), peersWith(pointAt('/', heading(homeId), 4)));
    expect(at.marks).toEqual([expect.objectContaining({ key: 'spot:g2:4', kind: 'spotlight', who: 'Bea', color: 1, ref: heading(homeId), point: { x: 0.5, y: 0.25 } })]);
    // An element the host's project does not have rings the point instead.
    expect(marks.canvasMarks(state, here(homeId), peersWith(pointAt('/', { ...heading(homeId), nodeId: 'n_gone' }))).marks[0]).toMatchObject({ ref: null, point: { x: 0.5, y: 0.25 } });
    const elsewhere = marks.canvasMarks(state, here(homeId), peersWith(pointAt(aboutPath)));
    expect(elsewhere.marks).toEqual([]);
    expect(elsewhere.away).toEqual([expect.objectContaining({ who: 'Bea', pageId: aboutId, place: 'About' })]);
    expect(marks.canvasMarks(state, here(homeId), peersWith(pointAt('/no-such-page/'))).away).toEqual([expect.objectContaining({ pageId: null, place: '/no-such-page/' })]);
    // A query (a search, a link's tracking) is the same page.
    expect(marks.canvasMarks(state, here(homeId), peersWith(pointAt('/?q=blue'))).marks).toHaveLength(1);
    expect(marks.canvasMarks(state, { pageId: homeId, previewPath: '/?utm=x' }, peersWith(pointAt('/'))).marks).toHaveLength(1);
    expect(marks.canvasMarks(state, here(homeId), peersWith(pointAt(`${aboutPath}?utm_source=invite`))).away).toEqual([expect.objectContaining({ pageId: aboutId, place: 'About' })]);
  });

  it('shows a remote shell the host and the other connected collaborators, never itself, and nobody while it reconnects', () => {
    const remote = { phase: 'admitted', joinId: 'join-1', guestId: 'g1', role: 'collaborator', hostConnected: true, reconnecting: false, participants: [ann, admittedGuest('g4', 'Dee', 'collaborator', 3), bea, cid] };
    const shell = (over: Record<string, unknown> = {}, remotePresence: unknown = { joinId: 'join-1', host: on(homeId, header), guests: { g4: on(homeId, heading(homeId)), g1: on(homeId) }, activity: { g4: { seq: 2, target: null } } }) => ({
      live: { phase: 'idle', lastError: null },
      livePresence: null,
      remote: { ...remote, ...over },
      remotePresence,
      snapshot: snap('remote:join-1')
    });
    const peers = marks.livePeers(shell());
    expect(peers.map((p: { key: string; who: string; color: unknown }) => [p.key, p.who, p.color])).toEqual([
      ['host', 'Host', 'host'],
      ['g4', 'Dee', 3]
    ]);
    expect(marks.canvasMarks(state, here(homeId), peers).marks.map((m: { peer: string; editing: boolean }) => [m.peer, m.editing])).toEqual([
      ['host', false],
      ['g4', true]
    ]);
    expect(marks.livePeers(shell({ reconnecting: true }))).toEqual([]);
    expect(marks.livePeers(shell({ hostConnected: false })).map((p: { key: string }) => p.key)).toEqual(['g4']);
    expect(marks.livePeers(shell({}, { joinId: 'join-0', host: on(homeId), guests: {}, activity: {} })).map((p: { presence: unknown }) => p.presence)).toEqual([null, null]);
  });

  it('draws each mark in its color with its name, and names a spotlight past the edge at that edge', () => {
    const peers = marks.livePeers(hosting(presence({ guests: { g1: on(homeId, heading(homeId)) }, spotlights: { g2: pointAt('/', null, 9) } })));
    const { marks: shown } = marks.canvasMarks(state, here(homeId), peers);
    const toBox = (r: { x: number; y: number; width: number; height: number }) => ({ left: r.x, top: r.y, width: r.width, height: r.height });
    const html = renderToStaticMarkup(createElement(canvas.PeerMarks, { marks: shown, boxes: { [shown[0].key]: { x: 10, y: 100, width: 200, height: 40 }, [shown[1].key]: { x: 50, y: 900, width: 0, height: 0 } }, toBox, width: 800, height: 600 }));
    expect(html).toContain('class="ov-peer selection"');
    expect(html).toContain('--peer:var(--peer-0)');
    expect(html).toContain('>Ann</span>');
    expect(html).toContain('class="ov-spot-dot"');
    expect(html).toMatch(/ov-peer-tags edge bottom[^>]*>.*↓ .*Bea/);
    // Two names past the same edge share its row, so neither hides the other.
    const two = [shown[1], { ...shown[1], key: 'spot:g3:1', peer: 'g3', who: 'Cid', color: 2 }];
    const edgeHtml = renderToStaticMarkup(createElement(canvas.PeerMarks, { marks: two, boxes: { [two[0].key]: { x: 50, y: 900, width: 0, height: 0 }, 'spot:g3:1': { x: 400, y: 2000, width: 0, height: 0 } }, toBox, width: 800, height: 600 }));
    expect(edgeHtml.match(/ov-peer-tags edge bottom/g)).toHaveLength(1);
    expect(edgeHtml).toMatch(/↓ .*Bea.*↓ .*Cid/);
    // A mark the page has not measured is not drawn.
    expect(renderToStaticMarkup(createElement(canvas.PeerMarks, { marks: shown, boxes: {}, toBox, width: 800, height: 600 }))).not.toContain('ov-peer ');
    const away = [
      { key: 'away:g2:5', peer: 'g2', who: 'Bea', color: 1, seq: 5, pageId: aboutId, place: 'About' },
      { key: 'away:g3:3', peer: 'g3', who: 'Cid', color: 2, seq: 3, pageId: null, place: '/x/' }
    ];
    const prompt = renderToStaticMarkup(createElement(canvas.SpotlightPrompts, { away }));
    expect(prompt).toContain('<strong>Bea</strong> pointed at About');
    expect(prompt.match(/Go to page/g)).toHaveLength(1);
    // A screen reader hears the newest spotlight, wherever it is.
    expect(canvas.marksAnnouncement([{ ...shown[1], seq: 4 }], away)).toBe('Bea pointed at About');
    expect(canvas.marksAnnouncement([{ ...shown[1], seq: 9 }], away)).toBe(shown[1].label);
  });

  it('tracks what the canvas shows from the editor’s own state', () => {
    store.setState({ snapshot: snap(WS), live: active(WS, 'run-1', [ann]), livePresence: presence({ guests: { g1: on(homeId, heading(homeId)) } }), pageId: homeId });
    const now = canvas.marksNow(store.getState());
    expect(now.marks.map((m: { key: string }) => m.key)).toEqual([`sel:g1:${JSON.stringify(heading(homeId))}`]);
    expect(canvas.trackedMarks(state, now.marks)).toEqual([{ key: now.marks[0].key, desc: expect.objectContaining({ ctx: expect.stringMatching(new RegExp(`^page:${homeId}(\\||$)`)) }), point: null }]);
    store.setState({ livePresence: null });
  });
});
