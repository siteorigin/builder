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
  it('offers each waiting guest the three answers, by name', () => {
    const html = renderToStaticMarkup(createElement(join.JoinRequestList as never, { live: active('/sites/acme#1', 'run-1', [pending('Ann', 'g1'), pending('Mo', 'g3'), { guestId: 'g2', displayName: 'Quill', status: 'admitted', role: 'viewer', guestExpiresAt: null }]) }));
    expect(html).toContain('aria-label="Join requests"');
    expect(html).toContain('<strong>Ann</strong> wants to join');
    expect(html).not.toContain('Quill');
    expect(html).toContain('aria-label="Answer Ann"');
    expect(html).toContain('aria-label="Answer Mo"');
    for (const label of ['Admit as Viewer', 'Admit as Collaborator', 'Decline']) expect(html).toContain(`>${label}</button>`);
  });

  it('shows nothing while the session is reconnecting, or when nobody waits', () => {
    const reconnecting = { ...active('/sites/acme#1', 'run-1', [pending('Ann', 'g1')]), phase: 'reconnecting' } as LiveHostState;
    expect(renderToStaticMarkup(createElement(join.JoinRequestList as never, { live: reconnecting }))).toBe('');
    expect(renderToStaticMarkup(createElement(join.JoinRequestList as never, { live: active('/sites/acme#1', 'run-1', [{ guestId: 'g2', displayName: 'Quill', status: 'admitted', role: 'viewer', guestExpiresAt: null }]) }))).toBe('');
  });
});
