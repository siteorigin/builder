/**
 * This app as a guest in another computer's live session (#766): the main process's guest manager, against a socket
 * played by the test. It joins under a checked name, waits, is let in, redeems its preview ticket, follows the host's
 * project, makes a collaborator's edits only while it may, takes its place back after a drop, and ends cleanly for
 * every way a session can end, leaving nothing running.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteState } from '../../src/shared/api';
import { LIVE_CLOSE_CODES } from '../../src/shared/live/close-codes';
import type { LiveProjectSnapshot } from '../../src/shared/live/snapshot';
import { createStarterState } from '../../src/catalogue/starters';
import { LiveGuestManager, type LiveGuestTimings, type RemotePreviewAccess } from '../../src/main/live/guest';

const ROOM = 'abcdefghijkmnpqrstuvwxyz';
const INVITE = `http://relay.localhost:8787/s/${ROOM}`;

/** A WebSocket the test plays the relay's end of. */
class FakeSocket {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  closedWith: number | null = null;
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close(code = 1000) {
    if (this.readyState >= 2) return;
    this.closedWith = code;
    this.readyState = 3;
  }
  private fire(type: string, event: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  open() {
    this.readyState = 1;
    this.fire('open', {});
  }
  receive(frame: Record<string, unknown>) {
    this.fire('message', { data: JSON.stringify(frame) });
  }
  /** The relay closes the socket. */
  drop(code = 1006) {
    this.readyState = 3;
    this.fire('close', { code });
  }
  last(type: string) {
    return [...this.sent].reverse().find((f) => f.type === type);
  }
}

const state = createStarterState('business', 'Acme', false);
const snapshotAt = (revision: number, extra: Partial<LiveProjectSnapshot> = {}): LiveProjectSnapshot => ({ revision, state: state as never, readOnly: false, aiBusy: false, runtime: { state: 'ready' }, ...extra });

const managers: LiveGuestManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.dispose();
  vi.useRealTimers();
});

function guest(timings: Partial<LiveGuestTimings> = {}) {
  const sockets: FakeSocket[] = [];
  const states: RemoteState[] = [];
  const changed: Array<{ joinId: string; snapshot: LiveProjectSnapshot }> = [];
  const reloads: Array<{ joinId: string; revision: number | null }> = [];
  const presence: unknown[] = [];
  const redeemed: Array<{ origin: string; ticket: string }> = [];
  const preview = { started: 0, closed: 0, targets: [] as unknown[] };
  let redeemAnswer: (ticket: string) => Promise<{ ok: true; cookie: string } | { ok: false; message: string }> = async (ticket) => ({ ok: true, cookie: `so_preview=${ticket}` });
  const manager = new LiveGuestManager(
    {
      emit: (channel: string, payload: unknown) => {
        if (channel === 'remote:state') states.push(payload as RemoteState);
        if (channel === 'remote:changed') changed.push(payload as never);
        if (channel === 'remote:reload') reloads.push(payload as never);
        if (channel === 'remote:presence') presence.push(payload);
      }
    },
    {
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s as unknown as WebSocket;
      },
      timings: { backoffBaseMs: 10, backoffMaxMs: 20, presenceMs: 5, busyRetryMs: 10, ...timings },
      createPreview: () => ({
        url: 'http://127.0.0.1:4555',
        secret: 'local-secret',
        start: async () => {
          preview.started++;
          return 'http://127.0.0.1:4555';
        },
        setTarget: (t) => void preview.targets.push(t),
        close: async () => void preview.closed++
      }),
      redeem: (origin, ticket) => {
        redeemed.push({ origin, ticket });
        return redeemAnswer(ticket);
      }
    }
  );
  const access: Array<RemotePreviewAccess | null> = [];
  manager.onPreviewAccess = (a) => access.push(a);
  managers.push(manager);
  return {
    manager,
    sockets,
    states,
    changed,
    reloads,
    presence,
    redeemed,
    preview,
    access,
    socket: () => sockets[sockets.length - 1],
    answerRedeem(fn: typeof redeemAnswer) {
      redeemAnswer = fn;
    }
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const until = async (check: () => unknown, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const pending = { type: 'guest:status', status: 'pending', guestId: 'g-1', resumeToken: 'resume-token-0123456789abcd' };
const admitted = (extra: Record<string, unknown> = {}) => ({ type: 'guest:status', status: 'admitted', guestId: 'g-1', role: 'collaborator', guestExpiresAt: null, sessionExpiresAt: Date.now() + 3_600_000, projectName: 'Acme Bakery', now: Date.now(), ...extra });

/** Join, and be let straight in as `role`, answering the first snapshot with revision 3. */
async function inRoom(g: ReturnType<typeof guest>, role: 'viewer' | 'collaborator' = 'collaborator') {
  const joined = g.manager.join({ inviteLink: INVITE, displayName: '  Sarah   Lee ' });
  await until(() => g.sockets.length, 'the socket');
  g.socket().open();
  g.socket().receive(pending);
  expect((await joined).ok).toBe(true);
  g.socket().receive(admitted({ role, previewTicket: 'ticket-0123456789abcdef' }));
  const ask = g.socket().last('rpc:request')!;
  expect(ask).toMatchObject({ method: 'project.snapshot', args: [] });
  g.socket().receive({ type: 'rpc:response', requestId: ask.requestId, method: 'project.snapshot', ok: true, result: snapshotAt(3) });
  await flush();
  return (g.manager.state as Extract<RemoteState, { phase: 'admitted' }>).joinId;
}

describe('joining', () => {
  it('refuses a link that is not an invite and a name that shows nothing, before anything connects', async () => {
    const g = guest();
    expect(await g.manager.join({ inviteLink: 'https://example.com/whatever', displayName: 'Sarah' })).toMatchObject({ ok: false });
    expect(await g.manager.join({ inviteLink: INVITE, displayName: '   ' })).toMatchObject({ ok: false });
    expect(g.sockets).toHaveLength(0);
  });

  it('asks to join on the room’s socket under the name as it travels, and waits until the host answers', async () => {
    const g = guest();
    const joined = g.manager.join({ inviteLink: INVITE, displayName: '  Sarah   Lee ' });
    await until(() => g.sockets.length, 'the socket');
    expect(g.socket().url).toBe(`ws://relay.localhost:8787/s/${ROOM}/ws`);
    g.socket().open();
    expect(g.socket().sent[0]).toEqual({ type: 'guest:join', version: 1, displayName: 'Sarah Lee' });
    g.socket().receive(pending);
    const result = await joined;
    expect(result.ok && result.state.phase).toBe('waiting');
    // Nothing of the host's editor is asked for before the host lets the guest in.
    expect(g.socket().sent.filter((f) => f.type === 'rpc:request')).toHaveLength(0);
    expect(await g.manager.join({ inviteLink: INVITE, displayName: 'Other' })).toMatchObject({ ok: false });
  });

  it('is let in: the ticket is redeemed on the room’s preview origin, the preview is reachable, and the host’s project arrives', async () => {
    const g = guest();
    const joinId = await inRoom(g);
    expect(g.redeemed).toEqual([{ origin: expect.stringMatching(/^http:\/\/p-[a-z0-9]+\.relay\.localhost:8787$/), ticket: 'ticket-0123456789abcdef' }]);
    expect(g.preview.targets).toEqual([{ origin: g.redeemed[0].origin, cookie: 'so_preview=ticket-0123456789abcdef' }]);
    expect(g.access.at(-1)).toEqual({ url: 'http://127.0.0.1:4555', header: 'x-siteorigin-remote-preview', secret: 'local-secret' });
    expect(g.changed.map((c) => [c.joinId, c.snapshot.revision])).toEqual([[joinId, 3]]);
    expect(g.manager.state).toMatchObject({ phase: 'admitted', role: 'collaborator', projectName: 'Acme Bakery', previewUrl: 'http://127.0.0.1:4555', hostRuntime: 'ready' });
    expect(await g.manager.snapshot(joinId)).toMatchObject({ revision: 3 });
    expect(await g.manager.snapshot('another-join')).toBeNull();
  });

  it('takes a newer project from the host and never an older one that arrives after it', async () => {
    const g = guest();
    await inRoom(g);
    g.socket().receive({ type: 'rpc:event', event: 'project:changed', payload: { kind: 'snapshot', snapshot: snapshotAt(5) } });
    g.socket().receive({ type: 'rpc:event', event: 'project:changed', payload: { kind: 'snapshot', snapshot: snapshotAt(4) } });
    expect(g.changed.map((c) => c.snapshot.revision)).toEqual([3, 5]);
    // A change missed by a slow connection is asked for, once.
    g.socket().receive({ type: 'rpc:event', event: 'project:changed', payload: { kind: 'missed' } });
    const ask = g.socket().last('rpc:request')!;
    g.socket().receive({ type: 'rpc:response', requestId: ask.requestId, method: 'project.snapshot', ok: true, result: snapshotAt(6) });
    await flush();
    expect(g.changed.map((c) => c.snapshot.revision)).toEqual([3, 5, 6]);
    // One too large to send is not asked for again: the editor keeps the last one that fitted and says so.
    const asked = g.socket().sent.length;
    g.socket().receive({ type: 'rpc:event', event: 'project:changed', payload: { kind: 'too-large', revision: 7 } });
    expect(g.socket().sent).toHaveLength(asked);
    expect(g.manager.state).toMatchObject({ tooLarge: true });
  });

  it('passes on the revision the host’s preview serves with each reload', async () => {
    const g = guest();
    const joinId = await inRoom(g);
    g.socket().receive({ type: 'preview:reload', revision: 9 });
    g.socket().receive({ type: 'preview:reload' });
    expect(g.reloads).toEqual([
      { joinId, revision: 9 },
      { joinId, revision: 9 }
    ]);
  });
});

describe('editing the host’s project', () => {
  it('sends a collaborator’s edit as the host expects it and gives back what the host made', async () => {
    const g = guest();
    const joinId = await inRoom(g);
    const batch = { operations: [{ type: 'page.update', pageId: state.site.homePageId, title: 'Welcome' }], expectedRevision: 3, label: 'Rename page' };
    const result = g.manager.apply(joinId, batch);
    const ask = g.socket().last('rpc:request')!;
    expect(ask).toMatchObject({ method: 'project.apply', args: [batch] });
    g.socket().receive({ type: 'rpc:response', requestId: ask.requestId, method: 'project.apply', ok: true, result: { revision: 4, results: [{}] } });
    expect(await result).toEqual({ ok: true, revision: 4, results: [{}] });
  });

  it('refuses a viewer’s edit here, and every edit once the host makes the guest a viewer', async () => {
    const g = guest();
    const joinId = await inRoom(g, 'viewer');
    const sent = g.socket().sent.length;
    expect(await g.manager.apply(joinId, { operations: [] })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(g.socket().sent).toHaveLength(sent);
    g.socket().receive(admitted({ role: 'collaborator' }));
    expect(g.manager.state).toMatchObject({ role: 'collaborator' });
    g.socket().receive(admitted({ role: 'viewer' }));
    expect(await g.manager.apply(joinId, { operations: [] })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });

  it('says an edit on its way when the connection drops may have been made, and never sends it again', async () => {
    const g = guest();
    const joinId = await inRoom(g);
    const result = g.manager.apply(joinId, { operations: [{ type: 'page.update', pageId: state.site.homePageId, title: 'Welcome' }] });
    g.socket().drop(1006);
    const answer = await result;
    expect(answer).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    expect(!answer.ok && answer.error.message).toMatch(/may still have been made/);
    await until(() => g.sockets.length === 2, 'the reconnect');
    g.sockets[1].open();
    expect(g.sockets[1].sent.filter((f) => f.type === 'rpc:request' && f.method === 'project.apply')).toHaveLength(0);
  });
});

describe('keeping its place', () => {
  it('takes its place back with its resume token after a drop, then asks for the project and reloads the preview', async () => {
    const g = guest();
    const joinId = await inRoom(g);
    g.socket().drop(1006);
    expect(g.manager.state).toMatchObject({ phase: 'admitted', reconnecting: true });
    await until(() => g.sockets.length === 2, 'the reconnect');
    g.sockets[1].open();
    expect(g.sockets[1].sent[0]).toEqual({ type: 'guest:join', version: 1, displayName: 'Sarah Lee', resumeToken: 'resume-token-0123456789abcd' });
    g.sockets[1].receive(admitted({ previewTicket: 'ticket-after-the-drop-01' }));
    expect(g.manager.state).toMatchObject({ phase: 'admitted', reconnecting: false });
    expect(g.sockets[1].last('rpc:request')).toMatchObject({ method: 'project.snapshot' });
    await flush();
    expect(g.reloads.length).toBeGreaterThan(0);
    expect(g.reloads.every((r) => r.joinId === joinId)).toBe(true);
    // The fresh ticket is redeemed; a ticket already used is not.
    expect(g.redeemed.map((r) => r.ticket)).toEqual(['ticket-0123456789abcdef', 'ticket-after-the-drop-01']);
  });

  it('ignores what a socket it has replaced still says', async () => {
    const g = guest();
    await inRoom(g);
    const old = g.socket();
    old.drop(1006);
    await until(() => g.sockets.length === 2, 'the reconnect');
    old.receive({ type: 'guest:status', status: 'kicked' });
    expect(g.manager.state.phase).toBe('admitted');
  });

  it('gives up its place once the relay no longer holds it', async () => {
    const g = guest();
    await inRoom(g);
    g.socket().drop(1006);
    await until(() => g.sockets.length === 2, 'the reconnect');
    g.sockets[1].open();
    g.sockets[1].receive({ type: 'protocol:error', code: 'AUTH_FAILED', message: 'That place in the room is no longer held.' });
    g.sockets[1].drop(LIVE_CLOSE_CODES.POLICY);
    expect(g.manager.state).toEqual({ phase: 'idle', ended: { reason: 'lost', message: expect.stringMatching(/not kept/) } });
  });

  it('stops trying after the relay’s grace and says the place was lost', async () => {
    const g = guest({ reconnectForMs: 30 });
    await inRoom(g);
    g.socket().drop(1006);
    for (let i = 0; i < 20 && g.manager.state.phase !== 'idle'; i++) {
      await until(() => g.socket().readyState === 0, 'a retry');
      g.socket().drop(1006);
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(g.manager.state).toMatchObject({ phase: 'idle', ended: { reason: 'lost' } });
  });
});

describe('ending', () => {
  const cases: Array<[string, (s: FakeSocket) => void, string]> = [
    ['the host declines', (s) => s.receive({ type: 'guest:status', status: 'declined' }), 'declined'],
    ['the host removes the guest', (s) => s.receive({ type: 'guest:status', status: 'kicked' }), 'kicked'],
    ['the guest’s own access ends', (s) => s.receive({ type: 'guest:status', status: 'expired', scope: 'guest' }), 'expired-guest'],
    ['the session reaches its end', (s) => s.receive({ type: 'guest:status', status: 'expired', scope: 'session' }), 'expired-session'],
    [
      'the host ends the session',
      (s) => {
        s.receive({ type: 'guest:status', status: 'ended' });
        s.drop(LIVE_CLOSE_CODES.ENDED);
      },
      'ended'
    ],
    [
      'the host stays away past its grace (ended, then the close that says so)',
      (s) => {
        s.receive({ type: 'guest:status', status: 'ended' });
        s.drop(LIVE_CLOSE_CODES.HOST_GONE);
      },
      'host-gone'
    ],
    ['the relay removes the guest with no status', (s) => s.drop(LIVE_CLOSE_CODES.REMOVED), 'kicked'],
    ['the host stayed away too long', (s) => s.drop(LIVE_CLOSE_CODES.HOST_GONE), 'host-gone']
  ];
  for (const [what, act, reason] of cases) {
    it(`ends cleanly when ${what}`, async () => {
      const g = guest();
      const joinId = await inRoom(g);
      const call = g.manager.apply(joinId, { operations: [] });
      act(g.socket());
      expect(g.manager.state).toMatchObject({ phase: 'idle', ended: { reason } });
      expect(await call).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
      expect(g.preview.closed).toBe(1);
      expect(g.access.at(-1)).toBeNull();
      expect(g.manager.previewAccess).toBeNull();
      // Nothing of the join answers any more.
      expect(await g.manager.snapshot(joinId)).toBeNull();
    });
  }

  it('says a room it could not reach is unavailable, and a locked one is locked', async () => {
    const g = guest();
    const joined = g.manager.join({ inviteLink: INVITE, displayName: 'Sarah' });
    await until(() => g.sockets.length, 'the socket');
    g.socket().drop(1006);
    expect(await joined).toMatchObject({ ok: false });
    expect(g.manager.state).toMatchObject({ phase: 'idle', ended: { reason: 'unavailable' } });
    const again = g.manager.join({ inviteLink: INVITE, displayName: 'Sarah' });
    await until(() => g.sockets.length === 2, 'the socket');
    g.socket().open();
    g.socket().receive({ type: 'guest:status', status: 'locked' });
    expect(await again).toMatchObject({ ok: false });
    expect(g.manager.state).toMatchObject({ phase: 'idle', ended: { reason: 'locked' } });
  });

  it('leaves for good: the relay is told, the socket closes and the preview goes', async () => {
    const g = guest();
    await inRoom(g);
    const socket = g.socket();
    g.manager.leave();
    expect(socket.last('guest:leave')).toEqual({ type: 'guest:leave' });
    expect(socket.closedWith).toBe(1000);
    expect(g.preview.closed).toBe(1);
    expect(g.manager.state).toEqual({ phase: 'idle', ended: { reason: 'left', message: 'You left the live session.' } });
    // A late frame from the socket that was left changes nothing.
    socket.receive({ type: 'guest:status', status: 'kicked' });
    expect(g.manager.state).toMatchObject({ ended: { reason: 'left' } });
  });
});

describe('what the review found (#766)', () => {
  it('ends an `ended` status on its own when no close follows, as the host ending it', async () => {
    const g = guest();
    await inRoom(g);
    g.socket().receive({ type: 'guest:status', status: 'ended' });
    expect(g.manager.state.phase).toBe('admitted');
    await until(() => g.manager.state.phase === 'idle', 'the end');
    expect(g.manager.state).toMatchObject({ ended: { reason: 'ended' } });
  });

  it('holds the join from the first moment: leaving before it connects ends it, and nothing connects after', async () => {
    const g = guest();
    const joined = g.manager.join({ inviteLink: INVITE, displayName: 'Sarah' });
    expect(g.manager.active).toBe(true);
    g.manager.leave();
    expect(await joined).toMatchObject({ ok: false });
    await flush();
    expect(g.sockets).toHaveLength(0);
    expect(g.manager.state).toMatchObject({ phase: 'idle', ended: { reason: 'left' } });
  });

  it('answers a call at once when the host drops, rather than at its deadline', async () => {
    const g = guest();
    const joinId = await inRoom(g);
    const edit = g.manager.apply(joinId, { operations: [{ type: 'page.update', pageId: state.site.homePageId, title: 'Hi' }] });
    g.socket().receive({ type: 'host:availability', connected: false });
    const answer = await edit;
    expect(answer).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    expect(!answer.ok && answer.error.message).toMatch(/may still have been made/);
  });

  it('pauses edits while the host’s project is too large to see', async () => {
    const g = guest();
    const joinId = await inRoom(g);
    g.socket().receive({ type: 'rpc:event', event: 'project:changed', payload: { kind: 'too-large', revision: 9 } });
    const sent = g.socket().sent.length;
    expect(await g.manager.apply(joinId, { operations: [] })).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
    expect(g.socket().sent).toHaveLength(sent);
  });

  it('takes no answer for another method as the call’s, and no snapshot the editor could not open', async () => {
    const g = guest();
    const joinId = await inRoom(g);
    const edit = g.manager.apply(joinId, { operations: [{ type: 'page.update', pageId: state.site.homePageId, title: 'Hi' }] });
    const ask = g.socket().last('rpc:request')!;
    g.socket().receive({ type: 'rpc:response', requestId: ask.requestId, method: 'project.snapshot', ok: true, result: { revision: 4 } });
    expect(await edit).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    g.socket().receive({ type: 'rpc:event', event: 'project:changed', payload: { kind: 'snapshot', snapshot: { ...snapshotAt(8), state: {} } } });
    const noHome = { ...state, pages: { ...state.pages, [state.site.homePageId]: null } };
    g.socket().receive({ type: 'rpc:event', event: 'project:changed', payload: { kind: 'snapshot', snapshot: { ...snapshotAt(9), state: noHome } } });
    expect(g.changed.map((c) => c.snapshot.revision)).toEqual([3]);
  });

  it('ends a join whose access ran out while its connection was down', async () => {
    const g = guest();
    await inRoom(g);
    g.socket().receive(admitted({ guestExpiresAt: Date.now() + 20, now: Date.now() }));
    await new Promise((r) => setTimeout(r, 30));
    g.socket().drop(1006);
    await until(() => g.manager.state.phase === 'idle', 'the end');
    expect(g.manager.state).toMatchObject({ ended: { reason: 'expired-guest' } });
  });

  it('keeps the revision the host’s preview serves from the snapshot it was asked for, and asks afresh when told to', async () => {
    const g = guest();
    const joined = g.manager.join({ inviteLink: INVITE, displayName: 'Sarah' });
    await until(() => g.sockets.length, 'the socket');
    g.socket().open();
    g.socket().receive(pending);
    await joined;
    g.socket().receive(admitted({ previewTicket: 'ticket-0123456789abcdef' }));
    const ask = g.socket().last('rpc:request')!;
    g.socket().receive({ type: 'rpc:response', requestId: ask.requestId, method: 'project.snapshot', ok: true, result: { ...snapshotAt(3), previewRevision: 2 } });
    await flush();
    expect(g.manager.state).toMatchObject({ previewRevision: 2 });
    // What the editor is given is the snapshot itself.
    expect(g.changed.at(-1)!.snapshot).not.toHaveProperty('previewRevision');
    const joinId = (g.manager.state as { joinId: string }).joinId;
    const fresh = g.manager.snapshot(joinId, true);
    const again = g.socket().last('rpc:request')!;
    expect(again.requestId).not.toBe(ask.requestId);
    g.socket().receive({ type: 'rpc:response', requestId: again.requestId, method: 'project.snapshot', ok: true, result: snapshotAt(5) });
    expect(await fresh).toMatchObject({ revision: 5 });
  });

  it('asks again for the first snapshot when the host could not answer it', async () => {
    const g = guest();
    const joined = g.manager.join({ inviteLink: INVITE, displayName: 'Sarah' });
    await until(() => g.sockets.length, 'the socket');
    g.socket().open();
    g.socket().receive(pending);
    await joined;
    g.socket().receive(admitted());
    const ask = g.socket().last('rpc:request')!;
    g.socket().receive({ type: 'rpc:response', requestId: ask.requestId, method: 'project.snapshot', ok: false, error: { code: 'UNAVAILABLE', message: 'Not now', recoverable: true } });
    await until(() => g.socket().last('rpc:request')!.requestId !== ask.requestId, 'the second ask');
    const again = g.socket().last('rpc:request')!;
    g.socket().receive({ type: 'rpc:response', requestId: again.requestId, method: 'project.snapshot', ok: true, result: snapshotAt(3) });
    await until(() => g.changed.length, 'the project');
  });

  it('hands the editor the host’s project only once the host has answered for it, and reloads when the revision moves on', async () => {
    const g = guest();
    const joined = g.manager.join({ inviteLink: INVITE, displayName: 'Sarah' });
    await until(() => g.sockets.length, 'the socket');
    g.socket().open();
    g.socket().receive(pending);
    await joined;
    g.socket().receive(admitted({ previewTicket: 'ticket-0123456789abcdef' }));
    const ask = g.socket().last('rpc:request')!;
    // A change the host pushed before it answered: kept, not yet shown.
    g.socket().receive({ type: 'rpc:event', event: 'project:changed', payload: { kind: 'snapshot', snapshot: snapshotAt(5) } });
    await flush();
    expect(g.changed).toEqual([]);
    const joinId = (g.manager.state as { joinId: string }).joinId;
    const reading = g.manager.snapshot(joinId);
    g.socket().receive({ type: 'rpc:response', requestId: ask.requestId, method: 'project.snapshot', ok: true, result: { ...snapshotAt(4), previewRevision: 4 } });
    expect(await reading).toMatchObject({ revision: 5 });
    expect(g.changed.map((c) => c.snapshot.revision)).toEqual([5]);
    expect(g.manager.state).toMatchObject({ previewRevision: 4 });
    // Asked again after a drop, the host says its preview has moved on: the page shown is loaded again.
    const reloads = g.reloads.length;
    g.manager.snapshot(joinId, true);
    const again = g.socket().last('rpc:request')!;
    g.socket().receive({ type: 'rpc:response', requestId: again.requestId, method: 'project.snapshot', ok: true, result: { ...snapshotAt(6), previewRevision: 6 } });
    await until(() => g.reloads.length > reloads, 'the reload');
    expect(g.reloads.at(-1)).toEqual({ joinId, revision: 6 });
  });

  it('opens once the host’s project fits again, after a first answer that it was too large', async () => {
    const g = guest();
    const joined = g.manager.join({ inviteLink: INVITE, displayName: 'Sarah' });
    await until(() => g.sockets.length, 'the socket');
    g.socket().open();
    g.socket().receive(pending);
    await joined;
    g.socket().receive(admitted());
    const ask = g.socket().last('rpc:request')!;
    g.socket().receive({ type: 'rpc:response', requestId: ask.requestId, method: 'project.snapshot', ok: false, error: { code: 'TOO_LARGE', message: 'Too large', recoverable: false } });
    await flush();
    expect(g.manager.state).toMatchObject({ tooLarge: true });
    // The host's project shrinks: its next change is pushed, and the guest asks for it whole.
    g.socket().receive({ type: 'rpc:event', event: 'project:changed', payload: { kind: 'snapshot', snapshot: snapshotAt(7) } });
    const again = g.socket().last('rpc:request')!;
    expect(again.requestId).not.toBe(ask.requestId);
    g.socket().receive({ type: 'rpc:response', requestId: again.requestId, method: 'project.snapshot', ok: true, result: snapshotAt(7) });
    await until(() => g.changed.length, 'the project');
    expect(g.changed.map((c) => c.snapshot.revision)).toEqual([7]);
  });

  it('says a fresh read of the host’s project failed, rather than handing back the copy it had', async () => {
    const g = guest();
    const joinId = await inRoom(g);
    const fresh = g.manager.snapshot(joinId, true);
    const ask = g.socket().last('rpc:request')!;
    g.socket().receive({ type: 'rpc:response', requestId: ask.requestId, method: 'project.snapshot', ok: false, error: { code: 'TOO_LARGE', message: 'Too large', recoverable: false } });
    expect(await fresh).toBeNull();
  });

  it('gives its place up when the app quits', async () => {
    const g = guest();
    await inRoom(g);
    const socket = g.socket();
    g.manager.dispose();
    expect(socket.last('guest:leave')).toEqual({ type: 'guest:leave' });
    expect(g.preview.closed).toBe(1);
  });
});

describe('presence', () => {
  const presence = { pageId: state.site.homePageId, viewportWidth: 1280, selection: null, previewPath: '/' };

  it('tells the others where a collaborator is, once per change, and nothing of a viewer’s', async () => {
    const g = guest();
    const joinId = await inRoom(g);
    expect(g.manager.presence(joinId, presence)).toBe(true);
    expect(g.manager.presence(joinId, presence)).toBe(true);
    await until(() => g.socket().last('presence:update'), 'the presence');
    await new Promise((r) => setTimeout(r, 20));
    expect(g.socket().sent.filter((f) => f.type === 'presence:update')).toEqual([{ type: 'presence:update', presence }]);
    g.socket().receive(admitted({ role: 'viewer' }));
    const before = g.socket().sent.length;
    g.manager.presence(joinId, { ...presence, viewportWidth: 800 });
    await new Promise((r) => setTimeout(r, 20));
    expect(g.socket().sent.slice(before).filter((f) => f.type === 'presence:update')).toHaveLength(0);
    // Not a presence the relay would take: refused here.
    expect(g.manager.presence(joinId, { ...presence, viewportWidth: 5 })).toBe(false);
  });

  it('shows where the host and the other collaborators are, and forgets one who is no longer a collaborator', async () => {
    const g = guest();
    const joinId = await inRoom(g);
    g.socket().receive({ type: 'presence:changed', participant: { kind: 'host' }, presence });
    g.socket().receive({ type: 'presence:changed', participant: { kind: 'guest', guestId: 'g-2' }, presence });
    expect(g.presence.at(-1)).toEqual({ joinId, host: presence, guests: { 'g-2': presence }, activity: {} });
    g.socket().receive({ type: 'room:roster', participants: [{ guestId: 'g-2', displayName: 'Tom', status: 'admitted', role: 'viewer', guestExpiresAt: null, colorSlot: 1, connected: true }] });
    expect(g.presence.at(-1)).toEqual({ joinId, host: presence, guests: {}, activity: {} });
    expect(g.manager.state).toMatchObject({ participants: [{ guestId: 'g-2', displayName: 'Tom', role: 'viewer' }] });
  });
});

describe('who is where, in color (#768)', () => {
  const presence = { pageId: state.site.homePageId, viewportWidth: 1280, selection: null, previewPath: '/' };
  const target = { owner: { kind: 'page' as const, id: state.site.homePageId }, instancePath: [], nodeId: 'n_title' };
  const tom = (over: Record<string, unknown> = {}) => ({ guestId: 'g-2', displayName: 'Tom', status: 'admitted', role: 'collaborator', guestExpiresAt: null, colorSlot: 1, connected: true, ...over });
  const me = { guestId: 'g-1', displayName: 'Sarah Lee', status: 'admitted', role: 'collaborator', guestExpiresAt: null, colorSlot: 0, connected: true };

  it('lists each participant with its palette place and whether it is connected', async () => {
    const g = guest();
    await inRoom(g);
    g.socket().receive({ type: 'room:roster', participants: [me, tom({ connected: false })] });
    expect(g.manager.state).toMatchObject({ participants: [{ guestId: 'g-1', colorSlot: 0, connected: true }, { guestId: 'g-2', colorSlot: 1, connected: false }] });
  });

  it('stops showing a collaborator whose connection dropped', async () => {
    const g = guest();
    const joinId = await inRoom(g);
    g.socket().receive({ type: 'room:roster', participants: [me, tom()] });
    g.socket().receive({ type: 'presence:changed', participant: { kind: 'guest', guestId: 'g-2' }, presence });
    g.socket().receive({ type: 'activity:edited', guestId: 'g-2', target });
    expect(g.presence.at(-1)).toMatchObject({ joinId, guests: { 'g-2': presence }, activity: { 'g-2': { target } } });
    g.socket().receive({ type: 'room:roster', participants: [me, tom({ connected: false })] });
    expect(g.presence.at(-1)).toEqual({ joinId, host: null, guests: {}, activity: {} });
  });

  it('shows another collaborator’s edit for a while, and none of a viewer, of itself or of one not connected', async () => {
    const g = guest({ activityMs: 40 });
    const joinId = await inRoom(g);
    g.socket().receive({ type: 'room:roster', participants: [me, tom(), tom({ guestId: 'g-3', displayName: 'Ann', role: 'viewer', colorSlot: 2 }), tom({ guestId: 'g-4', displayName: 'Lee', colorSlot: 3, connected: false })] });
    const shown = g.presence.length;
    for (const guestId of ['g-1', 'g-3', 'g-4', 'g-9']) g.socket().receive({ type: 'activity:edited', guestId, target });
    expect(g.presence.length).toBe(shown);
    g.socket().receive({ type: 'activity:edited', guestId: 'g-2', target: null });
    expect(g.presence.at(-1)).toEqual({ joinId, host: null, guests: {}, activity: { 'g-2': { seq: expect.any(Number), target: null } } });
    await until(() => Object.keys(g.presence.at(-1)!.activity).length === 0 && g.presence.at(-1), 'the edit’s cue to go');
  });

  it('tells someone who arrives or comes back where this collaborator is, and the host on its return', async () => {
    const g = guest();
    const joinId = await inRoom(g);
    g.socket().receive({ type: 'room:roster', participants: [me] });
    g.manager.presence(joinId, presence);
    await until(() => g.socket().last('presence:update'), 'the presence');
    const sent = () => g.socket().sent.filter((f) => f.type === 'presence:update').length;
    const before = sent();
    // Tom arrives: told once, though nothing changed.
    g.socket().receive({ type: 'room:roster', participants: [me, tom()] });
    await until(() => sent() === before + 1, 'the presence again for Tom');
    // The same roster again tells nobody new.
    g.socket().receive({ type: 'room:roster', participants: [me, tom()] });
    await new Promise((r) => setTimeout(r, 30));
    expect(sent()).toBe(before + 1);
    // Tom drops and comes back: told again.
    g.socket().receive({ type: 'room:roster', participants: [me, tom({ connected: false })] });
    g.socket().receive({ type: 'room:roster', participants: [me, tom()] });
    await until(() => sent() === before + 2, 'the presence again for Tom back');
    // The host goes and comes back: told again.
    g.socket().receive({ type: 'host:availability', connected: false });
    g.socket().receive({ type: 'host:availability', connected: true });
    await until(() => sent() === before + 3, 'the presence again for the host');
  });
});

describe('the preview ticket', () => {
  it('takes the place back once for a fresh ticket when one could not be redeemed, then says the preview could not open', async () => {
    const g = guest();
    g.answerRedeem(async () => ({ ok: false, message: 'spent' }));
    const joined = g.manager.join({ inviteLink: INVITE, displayName: 'Sarah' });
    await until(() => g.sockets.length, 'the socket');
    g.socket().open();
    g.socket().receive(pending);
    await joined;
    g.socket().receive(admitted({ previewTicket: 'ticket-0123456789abcdef' }));
    await until(() => g.sockets.length === 2, 'the retry');
    g.sockets[1].open();
    g.sockets[1].receive(admitted({ previewTicket: 'ticket-second-0123456789' }));
    await until(() => (g.manager.state as { previewProblem?: string | null }).previewProblem, 'the problem');
    expect(g.sockets).toHaveLength(2);
    expect(g.manager.state).toMatchObject({ phase: 'admitted', previewUrl: null });
  });
});
