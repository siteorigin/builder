import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LiveHostState, LiveJoinRequest, LiveRun, LiveStartResult, ProjectSnapshot } from '@shared/api';
import type { Presence } from '@shared/live/messages';
import { createStarterState } from '@catalogue/starters';

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
const calls = { presence: [] as Array<{ run: LiveRun; presence: Presence }>, copied: [] as string[] };
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
        start: () => answerStart!(),
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
  answerState = answerStart = null;
  store.setState({ live: { phase: 'idle', lastError: null }, liveClock: null, toasts: [], snapshot: null, shareOpen: false, pageId: null, templateMode: null, definitionMode: null });
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
    live.applyLiveState(active());
    live.applyLiveState({ phase: 'idle', lastError: 'The live session reached its end.' });
    live.applyLiveState({ phase: 'idle', lastError: 'The live session reached its end.' });
    expect(store.getState().toasts.map((t) => t.text)).toEqual(['The live session reached its end.']);
    live.applyLiveState(active());
    live.applyLiveState({ phase: 'idle', lastError: null });
    expect(store.getState().toasts).toHaveLength(1);
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
});

describe('starting', () => {
  it('copies the invite link once the session has started', async () => {
    store.setState({ snapshot: snap('/sites/acme#1') });
    answerStart = async () => ({ ok: true, inviteUrl: 'http://relay.localhost:8787/s/abcdefghijkmnpqrstuvwxyz', state: active() });
    expect(await live.startLive('2h')).toBe(true);
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
    for (const width of [1000, 900, 834]) store.setState({ viewport: width });
    store.setState({ pageId: aboutId });
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
    store.setState({ definitionMode: { definitionId: 'x', show: 'everywhere' } });
    await vi.advanceTimersByTimeAsync(live.PRESENCE_DELAY_MS + 10);
    expect(calls.presence.map((c) => c.presence)).toEqual([{ pageId: null, viewportWidth: 1280, selection: null, previewPath: null }]);
  });
});

describe('the waiting room', () => {
  it('offers each waiting guest the three answers, by name', () => {
    const html = renderToStaticMarkup(createElement(join.JoinRequestList as never, { live: active('/sites/acme#1', 'run-1', [pending('Ann', 'g1'), { guestId: 'g2', displayName: 'Quill', status: 'admitted', role: 'viewer', guestExpiresAt: null }]) }));
    expect(html).toContain('aria-label="Join requests"');
    expect(html).toContain('<strong>Ann</strong> wants to join');
    expect(html).not.toContain('Quill');
    expect(html).toContain('aria-label="Answer Ann"');
    for (const label of ['Admit as Viewer', 'Admit as Collaborator', 'Decline']) expect(html).toContain(`>${label}</button>`);
  });

  it('shows nothing while the session is reconnecting, or when nobody waits', () => {
    const reconnecting = { ...active('/sites/acme#1', 'run-1', [pending('Ann', 'g1')]), phase: 'reconnecting' } as LiveHostState;
    expect(renderToStaticMarkup(createElement(join.JoinRequestList as never, { live: reconnecting }))).toBe('');
    expect(renderToStaticMarkup(createElement(join.JoinRequestList as never, { live: active() }))).toBe('');
  });
});
