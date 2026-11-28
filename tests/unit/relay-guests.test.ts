import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIVE_CLOSE_CODES } from '../../src/shared/live/close-codes';
import { createHmac } from 'node:crypto';
import { fromBase64Url } from '../../src/shared/live/crypto';
import { PREVIEW_ADMISSION_PATH } from '../../src/shared/live/relay-url';
import { admitGuest, admittedGuest, joinGuest, openRoom, ORIGIN, previewStatus, reconnectHost, redeemTicket, SIGNING_KEY, startRelay, wait, type Relay } from './relay-harness';

/** Guests on the relay: the waiting room, admission, the preview cookie, roles, calls, and removal. */

let relay: Relay;
beforeAll(async () => {
  relay = await startRelay();
}, 60_000);
afterAll(() => relay?.dispose());

describe('the waiting room', () => {
  it('holds a new guest as pending: no calls, no presence, no preview, and nothing of the room shown', async () => {
    const room = await openRoom(relay);
    const { guest, guestId } = await joinGuest(relay, room.roomId);
    expect((await room.host.next('room:roster')).participants).toEqual([{ guestId, displayName: 'Ann', status: 'pending' }]);

    guest.send('guest-to-relay', { type: 'rpc:request', requestId: 'r1', method: 'project.snapshot', args: [] });
    const denied = await guest.next('rpc:response');
    expect(denied).toEqual({ type: 'rpc:response', requestId: 'r1', method: 'project.snapshot', ok: false, error: { code: 'PERMISSION_DENIED', message: 'The host has not let you in yet.', recoverable: true } });
    guest.send('guest-to-relay', { type: 'presence:update', presence: { pageId: null, viewportWidth: 1280, selection: null, previewPath: null } });
    expect((await guest.next('protocol:error')).code).toBe('FORBIDDEN');

    expect((await relay.fetch(`${room.previewOrigin}/`)).status).toBe(401);
    expect((await relay.fetch(`${room.previewOrigin}/about`, { headers: { cookie: 'so_preview=v1.forged.mac' } })).status).toBe(401);
    // Nothing reached the host, and the guest has been told nothing about the room.
    await wait(100);
    expect(room.host.has('rpc:request')).toBe(false);
    expect(room.host.has('presence:changed')).toBe(false);
    expect(guest.has('room:roster')).toBe(false);
    room.host.close();
  });

  it('admits a guest with a ticket the guest redeems once for a cookie on the room’s own preview origin', async () => {
    const room = await openRoom(relay, { projectName: 'Bakery' });
    const joined = await joinGuest(relay, room.roomId);
    await room.host.next('room:roster');
    const status = await admitGuest(room.host, joined, 'viewer');
    expect(status).toMatchObject({ guestId: joined.guestId, role: 'viewer', guestExpiresAt: null, sessionExpiresAt: room.ready.expiresAt, projectName: 'Bakery' });
    expect(status.previewTicket).toMatch(/^[A-Za-z0-9_-]{16,256}$/);
    expect((await joined.guest.next('room:roster')).participants).toEqual([{ guestId: joined.guestId, displayName: 'Ann', status: 'admitted', role: 'viewer', guestExpiresAt: null, colorSlot: 0, connected: true }]);

    // Two redemptions of one ticket at once: exactly one gets the cookie.
    const [first, second] = await Promise.all([redeemTicket(relay, room.roomId, status.previewTicket), redeemTicket(relay, room.roomId, status.previewTicket)]);
    expect([first.status, second.status].sort()).toEqual([204, 403]);
    const setCookie = (first.setCookie ?? second.setCookie)!;
    expect(setCookie).toMatch(/^so_preview=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; /);
    // Host-only (no Domain) on the room's preview origin, for the whole site.
    expect(setCookie).toContain('; Path=/;');
    expect(setCookie).not.toMatch(/Domain=/i);
    expect(setCookie).toContain('; HttpOnly');
    expect(setCookie).toContain('; SameSite=Lax');
    expect(setCookie).not.toContain('Secure');
    const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)![1]);
    expect(Math.abs(maxAge - (room.ready.expiresAt - Date.now()) / 1000)).toBeLessThan(5);
    // Signed with the relay's own secret, for exactly this grant.
    const [, payload, mac] = /^so_preview=(v1\.[^.]+)\.([^;]+)/.exec(setCookie)!;
    expect(createHmac('sha256', SIGNING_KEY).update(payload).digest('base64url')).toBe(mac);
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(payload.slice(3))!))).toEqual([room.roomId, joined.guestId, 'viewer', room.ready.expiresAt, 1]);
    room.host.close();
  });

  it('marks the cookie Secure when the guest reached the relay over HTTPS', async () => {
    const room = await openRoom(relay);
    const joined = await joinGuest(relay, room.roomId);
    const status = await admitGuest(room.host, joined);
    // The simulator always hands the Worker an http:// URL; Cloudflare says how the guest connected in this header.
    const redeemed = await redeemTicket(relay, room.roomId, status.previewTicket, { 'x-forwarded-proto': 'https' });
    expect(redeemed.status).toBe(204);
    // `__Host-`, so no other host under the same parent (another room's preview) can set or replace it.
    expect(redeemed.setCookie).toMatch(/^__Host-so_preview=v1\./);
    expect(redeemed.setCookie).toContain('; Path=/;');
    expect(redeemed.setCookie).toContain('; Secure');
    expect(redeemed.setCookie).not.toMatch(/Domain=/i);
    room.host.close();
  });

  it('lets only the room’s own viewer redeem its tickets from a browser', async () => {
    const room = await openRoom(relay);
    const joined = await joinGuest(relay, room.roomId);
    const status = await admitGuest(room.host, joined);
    const admission = `${room.previewOrigin}${PREVIEW_ADMISSION_PATH}`;
    const ask = (origin: string) => relay.fetch(admission, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });

    // The viewer's preflight is answered for its origin alone, with credentials; any other page's is refused.
    const preflight = await ask(ORIGIN);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST');
    // The redemption is JSON, so the browser sends the POST only if Content-Type is allowed.
    expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type');
    // A preflight for anything but POST is not one the viewer makes.
    expect((await relay.fetch(admission, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'PUT' } })).status).toBe(403);
    for (const stranger of [room.previewOrigin, 'http://evil.test', (await openRoom(relay)).previewOrigin]) {
      const refused = await ask(stranger);
      expect(refused.status, stranger).toBe(403);
      expect(refused.headers.get('access-control-allow-origin')).toBeNull();
    }

    // Another page's POST is refused without spending the ticket; the viewer's then gets the cookie, readable by it.
    expect((await redeemTicket(relay, room.roomId, status.previewTicket, { origin: room.previewOrigin })).status).toBe(403);
    const redeemed = await redeemTicket(relay, room.roomId, status.previewTicket, { origin: ORIGIN });
    expect(redeemed.status).toBe(204);
    expect(redeemed.setCookie).toMatch(/^so_preview=v1\./);
    expect(redeemed.response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(redeemed.response.headers.get('access-control-allow-credentials')).toBe('true');
    room.host.close();
  });

  it('refuses tickets that are malformed, from another room, or not sent as JSON', async () => {
    const room = await openRoom(relay);
    const other = await openRoom(relay);
    const joined = await joinGuest(relay, room.roomId);
    const status = await admitGuest(room.host, joined);
    expect((await redeemTicket(relay, other.roomId, status.previewTicket)).status).toBe(403);
    expect((await redeemTicket(relay, room.roomId, 'short')).status).toBe(400);
    expect((await relay.fetch(`${room.previewOrigin}${PREVIEW_ADMISSION_PATH}`, { method: 'POST', body: JSON.stringify({ ticket: status.previewTicket }) })).status).toBe(415);
    expect((await relay.fetch(`${room.previewOrigin}${PREVIEW_ADMISSION_PATH}`)).status).toBe(405);
    // Tickets are redeemed on the room's preview origin only: the relay's own host has no admission route.
    expect((await relay.fetch(`/s/${room.roomId}/admission`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: status.previewTicket }) })).status).toBe(404);
    expect((await redeemTicket(relay, room.roomId, status.previewTicket)).status).toBe(204);
    room.host.close();
    other.host.close();
  });

  it('turns away a declined guest and forgets its place', async () => {
    const room = await openRoom(relay);
    const { guest, guestId, resumeToken } = await joinGuest(relay, room.roomId);
    expect((await room.host.next('room:roster')).participants).toHaveLength(1);
    room.host.send('host-to-relay', { type: 'guest:decline', guestId });
    expect((await guest.next('guest:status')).status).toBe('declined');
    expect((await guest.closed()).code).toBe(LIVE_CLOSE_CODES.REMOVED);
    expect((await room.host.next('room:roster')).participants).toEqual([]);
    const back = await relay.socket(`/s/${room.roomId}/ws`);
    back.send('guest-to-relay', { type: 'guest:join', version: 2, displayName: 'Ann', resumeToken });
    expect((await back.next('protocol:error')).code).toBe('AUTH_FAILED');
    room.host.close();
  });
});

describe('admitted guests', () => {
  it('passes allowed calls to the host and the host’s answers back, and refuses what the role does not allow', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann', 'viewer');

    ann.guest.send('guest-to-relay', { type: 'rpc:request', requestId: 'snap', method: 'project.snapshot', args: [] });
    expect(await room.host.next('rpc:request')).toEqual({ type: 'rpc:request', guestId: ann.guestId, requestId: 'snap', method: 'project.snapshot', args: [] });
    room.host.send('host-to-relay', { type: 'rpc:response', guestId: ann.guestId, requestId: 'snap', method: 'project.snapshot', ok: true, result: { pages: 3 } });
    expect(await ann.guest.next('rpc:response')).toEqual({ type: 'rpc:response', requestId: 'snap', method: 'project.snapshot', ok: true, result: { pages: 3 } });

    ann.guest.send('guest-to-relay', { type: 'rpc:request', requestId: 'edit', method: 'project.apply', args: [] });
    expect(await ann.guest.next('rpc:response')).toMatchObject({ requestId: 'edit', ok: false, error: { code: 'PERMISSION_DENIED' } });
    ann.guest.send('guest-to-relay', { type: 'rpc:request', requestId: 'secret', method: 'settings.get', args: [] });
    expect(await ann.guest.next('rpc:response')).toMatchObject({ requestId: 'secret', method: 'settings.get', ok: false, error: { code: 'PERMISSION_DENIED' } });
    await wait(100);
    expect(room.host.has('rpc:request')).toBe(false);

    // Two guests may use the same request ID: each answer reaches only the guest it names.
    const bea = await admittedGuest(relay, room, 'Bea', 'viewer');
    for (const g of [ann, bea]) g.guest.send('guest-to-relay', { type: 'rpc:request', requestId: 'same', method: 'project.snapshot', args: [g.guestId] });
    const asked = [await room.host.next('rpc:request'), await room.host.next('rpc:request')];
    expect(asked.map((r) => [r.guestId, r.args[0]]).sort()).toEqual([ann.guestId, bea.guestId].sort().map((id) => [id, id]));
    room.host.send('host-to-relay', { type: 'rpc:response', guestId: bea.guestId, requestId: 'same', method: 'project.snapshot', ok: true, result: 'for bea' });
    expect(await bea.guest.next('rpc:response')).toEqual({ type: 'rpc:response', requestId: 'same', method: 'project.snapshot', ok: true, result: 'for bea' });
    await wait(100);
    expect(ann.guest.has('rpc:response')).toBe(false);
    room.host.close();
  });

  it('changes a guest’s role live: a new grant and ticket, and the old cookie stops working', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann', 'viewer');
    room.host.send('host-to-relay', { type: 'guest:set-role', guestId: ann.guestId, role: 'collaborator' });
    const promoted = await ann.guest.next('guest:status');
    expect(promoted).toMatchObject({ status: 'admitted', role: 'collaborator' });
    expect((await room.host.next('room:roster')).participants).toEqual([{ guestId: ann.guestId, displayName: 'Ann', status: 'admitted', role: 'collaborator', guestExpiresAt: null, colorSlot: 0, connected: true }]);

    ann.guest.send('guest-to-relay', { type: 'rpc:request', requestId: 'edit', method: 'project.apply', args: [{ operations: [] }] });
    expect(await room.host.next('rpc:request')).toMatchObject({ guestId: ann.guestId, method: 'project.apply' });

    // The viewer's cookie is for a grant that no longer exists; the new ticket brings a cookie for the new one.
    expect(await previewStatus(relay, room, ann.cookie)).toBe(403);
    const redeemed = await redeemTicket(relay, room.roomId, (promoted as { previewTicket?: string }).previewTicket);
    expect(redeemed.status).toBe(204);

    // Back to viewer: the collaborator cookie stops working too, though the role matches the first cookie again.
    room.host.discard('room:roster');
    room.host.send('host-to-relay', { type: 'guest:set-role', guestId: ann.guestId, role: 'viewer' });
    const demoted = await ann.guest.next('guest:status');
    expect(demoted).toMatchObject({ status: 'admitted', role: 'viewer' });
    expect((await room.host.next('room:roster')).participants).toEqual([{ guestId: ann.guestId, displayName: 'Ann', status: 'admitted', role: 'viewer', guestExpiresAt: null, colorSlot: 0, connected: true }]);
    for (const cookie of [ann.cookie, redeemed.cookie!]) expect(await previewStatus(relay, room, cookie)).toBe(403);
    ann.guest.send('guest-to-relay', { type: 'rpc:request', requestId: 'edit-again', method: 'project.apply', args: [] });
    expect(await ann.guest.next('rpc:response')).toMatchObject({ requestId: 'edit-again', ok: false, error: { code: 'PERMISSION_DENIED' } });
    ann.guest.send('guest-to-relay', { type: 'rpc:request', requestId: 'look', method: 'project.snapshot', args: [] });
    expect(await room.host.next('rpc:request')).toMatchObject({ requestId: 'look', guestId: ann.guestId });

    // Setting the role it already has changes nothing: the latest cookie keeps working.
    const current = await redeemTicket(relay, room.roomId, (demoted as { previewTicket?: string }).previewTicket);
    room.host.send('host-to-relay', { type: 'guest:set-role', guestId: ann.guestId, role: 'viewer' });
    await room.host.next('room:roster');
    expect(await previewStatus(relay, room, current.cookie!)).toBe(204);
    room.host.close();
  });

  it('passes a copy editor’s edits to the host to check, and none of its presence', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann', 'copy-editor');
    expect(ann.status).toMatchObject({ status: 'admitted', role: 'copy-editor' });
    // Its preview cookie is for its own role, and works.
    expect(await previewStatus(relay, room, ann.cookie)).toBe(204);
    // Which edits it may make is the host's to say, with the arguments and against the project.
    const batch = { operations: [{ type: 'node.setContent', owner: { kind: 'page', id: 'pg_home' }, nodeId: 'n_title', field: 'text', value: 'Hello' }] };
    ann.guest.send('guest-to-relay', { type: 'rpc:request', requestId: 'edit', method: 'project.apply', args: [batch] });
    expect(await room.host.next('rpc:request')).toEqual({ type: 'rpc:request', guestId: ann.guestId, requestId: 'edit', method: 'project.apply', args: [batch] });
    ann.guest.send('guest-to-relay', { type: 'rpc:request', requestId: 'secret', method: 'settings.get', args: [] });
    expect(await ann.guest.next('rpc:response')).toMatchObject({ requestId: 'secret', ok: false, error: { code: 'PERMISSION_DENIED' } });
    // Only a collaborator shows the others where it is.
    room.host.discard('presence:changed');
    ann.guest.send('guest-to-relay', { type: 'presence:update', presence: { pageId: 'about', viewportWidth: 390, selection: null, previewPath: null } });
    expect(await ann.guest.next('protocol:error')).toMatchObject({ code: 'FORBIDDEN' });
    await wait(100);
    expect(room.host.has('presence:changed')).toBe(false);
    expect(room.host.has('rpc:request')).toBe(false);
    room.host.close();
  });

  it('delivers the host’s events, presence and reloads to admitted guests only', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann', 'collaborator');
    const bea = await admittedGuest(relay, room, 'Bea');
    const waiting = await joinGuest(relay, room.roomId, 'Cy');

    room.host.send('host-to-relay', { type: 'rpc:event', event: 'project:changed', payload: { revision: 7 } });
    for (const g of [ann, bea]) expect(await g.guest.next('rpc:event')).toEqual({ type: 'rpc:event', event: 'project:changed', payload: { revision: 7 } });
    room.host.send('host-to-relay', { type: 'rpc:event', guestId: bea.guestId, event: 'runtime:status', payload: 'ready' });
    expect((await bea.guest.next('rpc:event')).event).toBe('runtime:status');

    const hostPresence = { pageId: 'home', viewportWidth: 1024, selection: null, previewPath: '/' };
    const annPresence = { pageId: 'about', viewportWidth: 390, selection: null, previewPath: null };
    room.host.send('host-to-relay', { type: 'presence:update', presence: hostPresence });
    expect(await ann.guest.next('presence:changed')).toEqual({ type: 'presence:changed', participant: { kind: 'host' }, presence: hostPresence });
    ann.guest.send('guest-to-relay', { type: 'presence:update', presence: annPresence });
    expect(await room.host.next('presence:changed')).toEqual({ type: 'presence:changed', participant: { kind: 'guest', guestId: ann.guestId }, presence: annPresence });
    expect(await bea.guest.next('presence:changed')).toEqual({ type: 'presence:changed', participant: { kind: 'host' }, presence: hostPresence });
    expect(await bea.guest.next('presence:changed')).toEqual({ type: 'presence:changed', participant: { kind: 'guest', guestId: ann.guestId }, presence: annPresence });

    room.host.send('host-to-relay', { type: 'preview:reload' });
    await ann.guest.next('preview:reload');
    await bea.guest.next('preview:reload');
    await wait(100);
    expect(ann.guest.has('rpc:event')).toBe(false);
    expect(ann.guest.has('presence:changed')).toBe(false);
    for (const type of ['rpc:event', 'presence:changed', 'preview:reload', 'room:roster'] as const) expect(waiting.guest.has(type)).toBe(false);
    room.host.close();
  });

  it('passes on presence from collaborators only, and no faster than a few updates a second', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann', 'collaborator');
    const bea = await admittedGuest(relay, room, 'Bea');
    room.host.discard('presence:changed');
    // A viewer follows the session; where it is stays its own.
    bea.guest.send('guest-to-relay', { type: 'presence:update', presence: { pageId: 'about', viewportWidth: 390, selection: null, previewPath: null } });
    expect(await bea.guest.next('protocol:error')).toMatchObject({ code: 'FORBIDDEN' });
    await wait(100);
    expect(room.host.has('presence:changed')).toBe(false);
    // A burst past the budget: the excess is dropped, and nothing is refused.
    for (let i = 0; i < 60; i++) ann.guest.send('guest-to-relay', { type: 'presence:update', presence: { pageId: `p${i}`, viewportWidth: 1280, selection: null, previewPath: null } });
    await wait(300);
    let passed = 0;
    while (room.host.has('presence:changed')) {
      await room.host.next('presence:changed');
      passed++;
    }
    expect(passed).toBeGreaterThanOrEqual(20);
    expect(passed).toBeLessThan(40);
    expect(ann.guest.has('protocol:error')).toBe(false);
    room.host.close();
  });

  it('kicks a guest: its socket closes at once and its cookie stops working', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann');
    const bea = await admittedGuest(relay, room, 'Bea');
    expect(await previewStatus(relay, room, ann.cookie)).toBe(204);
    bea.guest.discard('room:roster');
    room.host.send('host-to-relay', { type: 'guest:kick', guestId: ann.guestId });
    expect((await ann.guest.next('guest:status')).status).toBe('kicked');
    expect((await ann.guest.closed(1000)).code).toBe(LIVE_CLOSE_CODES.REMOVED);
    expect(await previewStatus(relay, room, ann.cookie)).toBe(403);
    expect((await bea.guest.next('room:roster')).participants.map((p) => p.guestId)).toEqual([bea.guestId]);
    expect(bea.guest.closeEvent).toBeNull();
    room.host.close();
  });

  it('locks the room: new join requests are turned away while everyone inside, waiting or admitted, stays', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann');
    const waiting = await joinGuest(relay, room.roomId, 'Bea');
    room.host.send('host-to-relay', { type: 'room:set-locked', locked: true });
    expect((await room.host.next('room:state')).locked).toBe(true);
    expect((await ann.guest.next('room:state')).locked).toBe(true);

    const late = await relay.socket(`/s/${room.roomId}/ws`);
    late.send('guest-to-relay', { type: 'guest:join', version: 2, displayName: 'Late' });
    expect((await late.next('guest:status')).status).toBe('locked');
    expect((await late.closed()).code).toBe(LIVE_CLOSE_CODES.REFUSED);

    // Inside, everything goes on: the admitted guest's calls, and the host letting in someone already waiting.
    ann.guest.send('guest-to-relay', { type: 'rpc:request', requestId: 'locked', method: 'project.snapshot', args: [] });
    expect((await room.host.next('rpc:request')).requestId).toBe('locked');
    expect((await admitGuest(room.host, waiting)).status).toBe('admitted');
    expect(ann.guest.closeEvent).toBeNull();

    room.host.send('host-to-relay', { type: 'room:set-locked', locked: false });
    expect((await room.host.next('room:state')).locked).toBe(false);
    await joinGuest(relay, room.roomId, 'Late');
    room.host.close();
  });
});

describe('a guest that leaves', () => {
  it('gives its place up at once, waiting or admitted, rather than through the reconnect grace (#766)', async () => {
    const room = await openRoom(relay);
    const cid = await admittedGuest(relay, room, 'Cid');
    const ann = await admittedGuest(relay, room, 'Ann', 'collaborator');
    const bea = await joinGuest(relay, room.roomId, 'Bea');
    expect((await room.host.next('room:roster')).participants.map((p) => p.guestId)).toEqual([cid.guestId, ann.guestId, bea.guestId]);

    bea.guest.send('guest-to-relay', { type: 'guest:leave' });
    expect((await room.host.next('room:roster')).participants.map((p) => p.guestId)).toEqual([cid.guestId, ann.guestId]);
    expect((await bea.guest.closed()).code).toBe(LIVE_CLOSE_CODES.REMOVED);

    cid.guest.discard('room:roster');
    ann.guest.send('guest-to-relay', { type: 'guest:leave' });
    expect((await room.host.next('room:roster')).participants.map((p) => p.guestId)).toEqual([cid.guestId]);
    expect((await ann.guest.closed()).code).toBe(LIVE_CLOSE_CODES.REMOVED);
    // The guests still in the room see the room as it is now too.
    expect((await cid.guest.next('room:roster')).participants.map((p) => p.guestId)).toEqual([cid.guestId]);
    // Its cookie no longer opens the preview, and its place cannot be taken back.
    expect(await previewStatus(relay, room, ann.cookie)).toBe(403);
    const back = await relay.socket(`/s/${room.roomId}/ws`);
    back.send('guest-to-relay', { type: 'guest:join', version: 2, displayName: 'Ann', resumeToken: ann.resumeToken });
    expect((await back.next('protocol:error')).code).toBe('AUTH_FAILED');
    room.host.close();
  });

  it('passes on the revision the host’s preview serves with each reload', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann', 'collaborator');
    room.host.send('host-to-relay', { type: 'preview:reload', revision: 12 });
    expect(await ann.guest.next('preview:reload')).toEqual({ type: 'preview:reload', revision: 12 });
    room.host.send('host-to-relay', { type: 'preview:reload' });
    expect(await ann.guest.next('preview:reload')).toEqual({ type: 'preview:reload' });
    room.host.close();
  });
});

describe('a guest whose socket drops', () => {
  it('takes its own place back with its resume token, even in a locked room, and gets a fresh ticket', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann', 'collaborator');
    room.host.send('host-to-relay', { type: 'room:set-locked', locked: true });
    await room.host.next('room:state');
    ann.guest.close();
    await wait(50);

    const back = await relay.socket(`/s/${room.roomId}/ws`);
    back.send('guest-to-relay', { type: 'guest:join', version: 2, displayName: 'Ann', resumeToken: ann.resumeToken });
    const status = await back.next('guest:status');
    expect(status).toMatchObject({ status: 'admitted', guestId: ann.guestId, role: 'collaborator' });
    // The new socket speaks as the same guest.
    back.send('guest-to-relay', { type: 'rpc:request', requestId: 'after-resume', method: 'project.apply', args: [] });
    expect(await room.host.next('rpc:request')).toMatchObject({ requestId: 'after-resume', guestId: ann.guestId });
    expect((await redeemTicket(relay, room.roomId, (status as { previewTicket?: string }).previewTicket)).status).toBe(204);
    // The cookie from before the drop is still for the same grant.
    expect(await previewStatus(relay, room, ann.cookie)).toBe(204);

    const impostor = await relay.socket(`/s/${room.roomId}/ws`);
    impostor.send('guest-to-relay', { type: 'guest:join', version: 2, displayName: 'Ann', resumeToken: 'x'.repeat(43) });
    expect((await impostor.next('protocol:error')).code).toBe('AUTH_FAILED');
    await impostor.closed();
    room.host.close();
  });

  it('answers a page going away with Going Away, never the code that says the session ended, and keeps its place (#1528)', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann');
    room.host.discard('room:roster');
    // A browser closes the socket of a page it is leaving or reloading with 1001. Firefox still tells the page what the
    // relay answered, so an answer of 1000 (ENDED) would read to the viewer as the host having ended the session.
    ann.guest.close(1001);
    expect((await ann.guest.closed()).code).toBe(1001);
    expect((await room.host.next('room:roster')).participants).toEqual([expect.objectContaining({ guestId: ann.guestId, status: 'admitted', connected: false })]);

    const back = await relay.socket(`/s/${room.roomId}/ws`);
    back.send('guest-to-relay', { type: 'guest:join', version: 2, displayName: 'Ann', resumeToken: ann.resumeToken });
    expect(await back.next('guest:status')).toMatchObject({ status: 'admitted', guestId: ann.guestId });
    // The same seat, back: the host is never asked to let anyone in again.
    expect((await room.host.next('room:roster')).participants).toEqual([expect.objectContaining({ guestId: ann.guestId, status: 'admitted', connected: true })]);

    // A code the relay cannot send back is answered with none, which says nothing about the session either.
    const bea = await admittedGuest(relay, room, 'Bea');
    bea.guest.close(1011);
    expect((await bea.guest.closed()).code).toBe(1005);
    room.host.close();
  });

  it('gives way to a second socket that resumes the same place', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann');
    const second = await relay.socket(`/s/${room.roomId}/ws`);
    second.send('guest-to-relay', { type: 'guest:join', version: 2, displayName: 'Ann', resumeToken: ann.resumeToken });
    expect((await second.next('guest:status')).status).toBe('admitted');
    expect((await ann.guest.closed()).code).toBe(LIVE_CLOSE_CODES.REPLACED);
    second.send('guest-to-relay', { type: 'rpc:request', requestId: 'second', method: 'project.snapshot', args: [] });
    expect(await room.host.next('rpc:request')).toMatchObject({ requestId: 'second', guestId: ann.guestId });
    room.host.close();
  });
});

describe('who is where, in color (#768)', () => {
  const target = { owner: { kind: 'page' as const, id: 'pg_home' }, instancePath: [], nodeId: 'n_title' };
  const spotlight = { previewPath: '/about/', target, x: 0.5, y: 0.25 };

  it('gives each guest let in the lowest palette place nobody holds, kept while it holds its place', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann');
    const bea = await admittedGuest(relay, room, 'Bea', 'collaborator');
    expect((await bea.guest.next('room:roster')).participants.map((p) => [p.displayName, p.colorSlot])).toEqual([
      ['Ann', 0],
      ['Bea', 1]
    ]);
    // A role change keeps the place; a place given up is the next guest's.
    room.host.send('host-to-relay', { type: 'guest:set-role', guestId: ann.guestId, role: 'collaborator' });
    expect((await room.host.next('room:roster')).participants.map((p) => p.status === 'admitted' && p.colorSlot)).toEqual([0, 1]);
    room.host.send('host-to-relay', { type: 'guest:kick', guestId: ann.guestId });
    await room.host.next('room:roster');
    const cid = await admittedGuest(relay, room, 'Cid');
    expect((await cid.guest.next('room:roster')).participants.map((p) => [p.displayName, p.colorSlot])).toEqual([
      ['Bea', 1],
      ['Cid', 0]
    ]);
    room.host.close();
  });

  it('keeps a place in the palette for a guest whose connection dropped, so nobody let in meanwhile takes it', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann');
    ann.guest.close();
    await room.host.next('room:roster');
    const bea = await admittedGuest(relay, room, 'Bea');
    const back = await relay.socket(`/s/${room.roomId}/ws`);
    back.send('guest-to-relay', { type: 'guest:join', version: 2, displayName: 'Ann', resumeToken: ann.resumeToken });
    await back.next('guest:status');
    expect((await back.next('room:roster')).participants.map((p) => [p.displayName, p.colorSlot, p.connected])).toEqual([
      ['Ann', 0, true],
      ['Bea', 1, true]
    ]);
    void bea;
    room.host.close();
  });

  it('announces a guest that takes its place over from a connection still open as gone, then back', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann', 'collaborator');
    const bea = await admittedGuest(relay, room, 'Bea', 'collaborator');
    room.host.discard('room:roster');
    bea.guest.discard('room:roster');
    // Ann's old socket is still open as far as the relay knows.
    const second = await relay.socket(`/s/${room.roomId}/ws`);
    second.send('guest-to-relay', { type: 'guest:join', version: 2, displayName: 'Ann', resumeToken: ann.resumeToken });
    expect((await room.host.next('room:roster')).participants[0]).toMatchObject({ guestId: ann.guestId, connected: false });
    expect((await room.host.next('room:roster')).participants[0]).toMatchObject({ guestId: ann.guestId, connected: true });
    expect((await bea.guest.next('room:roster')).participants[0]).toMatchObject({ guestId: ann.guestId, connected: false });
    expect((await bea.guest.next('room:roster')).participants[0]).toMatchObject({ guestId: ann.guestId, connected: true });
    expect((await ann.guest.closed()).code).toBe(LIVE_CLOSE_CODES.REPLACED);
    room.host.close();
  });

  it('tells guests the host is here when it takes the room over from a connection still open', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann', 'collaborator');
    ann.guest.discard('host:availability');
    const { host } = await reconnectHost(relay, room.roomId, room.keys);
    expect(await ann.guest.next('host:availability')).toEqual({ type: 'host:availability', connected: true });
    host.close();
  });

  it('tells the host and the other guests at once when a guest’s connection drops, and again when it is back', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann', 'collaborator');
    const bea = await admittedGuest(relay, room, 'Bea', 'collaborator');
    room.host.discard('room:roster');
    bea.guest.discard('room:roster');
    ann.guest.close();
    const away = (await room.host.next('room:roster')).participants;
    expect(away).toEqual([expect.objectContaining({ guestId: ann.guestId, connected: false, colorSlot: 0 }), expect.objectContaining({ guestId: bea.guestId, connected: true })]);
    expect((await bea.guest.next('room:roster')).participants[0]).toMatchObject({ guestId: ann.guestId, connected: false });
    const back = await relay.socket(`/s/${room.roomId}/ws`);
    back.send('guest-to-relay', { type: 'guest:join', version: 2, displayName: 'Ann', resumeToken: ann.resumeToken });
    expect((await room.host.next('room:roster')).participants[0]).toMatchObject({ guestId: ann.guestId, connected: true, colorSlot: 0 });
    expect((await bea.guest.next('room:roster')).participants[0]).toMatchObject({ guestId: ann.guestId, connected: true });
    expect((await back.next('room:roster')).participants[0]).toMatchObject({ guestId: ann.guestId, connected: true });
    room.host.close();
  });

  it('passes a spotlight from any guest let in, a viewer too, to the host alone, naming who pointed', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann');
    const bea = await admittedGuest(relay, room, 'Bea', 'collaborator');
    const waiting = await joinGuest(relay, room.roomId, 'Cid');
    ann.guest.send('guest-to-relay', { type: 'spotlight:point', spotlight });
    expect(await room.host.next('spotlight:pointed')).toEqual({ type: 'spotlight:pointed', guestId: ann.guestId, spotlight });
    bea.guest.send('guest-to-relay', { type: 'spotlight:point', spotlight: { ...spotlight, target: null } });
    expect(await room.host.next('spotlight:pointed')).toEqual({ type: 'spotlight:pointed', guestId: bea.guestId, spotlight: { ...spotlight, target: null } });
    // Someone still waiting cannot point.
    waiting.guest.send('guest-to-relay', { type: 'spotlight:point', spotlight });
    expect(await waiting.guest.next('protocol:error')).toMatchObject({ code: 'FORBIDDEN' });
    await wait(100);
    expect(room.host.has('spotlight:pointed')).toBe(false);
    // No other guest is shown anyone's spotlight: the relay sends a guest nothing for it at all.
    const queued = (g: typeof ann.guest, type: string) => (g as unknown as { has(type: string): boolean }).has(type);
    for (const g of [ann.guest, bea.guest]) expect(queued(g, 'spotlight:pointed') || queued(g, 'spotlight:point') || queued(g, 'protocol:error')).toBe(false);
    room.host.close();
  });

  it('drops spotlights that come faster than a few a second, each guest on its own budget, refusing none', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann');
    const bea = await admittedGuest(relay, room, 'Bea');
    for (let i = 0; i < 20; i++) ann.guest.send('guest-to-relay', { type: 'spotlight:point', spotlight: { ...spotlight, x: i / 20 } });
    bea.guest.send('guest-to-relay', { type: 'spotlight:point', spotlight });
    await wait(300);
    const passed = { ann: 0, bea: 0 };
    for (let f = room.host.take('spotlight:pointed', () => true); f; f = room.host.take('spotlight:pointed', () => true)) passed[f.guestId === ann.guestId ? 'ann' : 'bea']++;
    expect(passed.ann).toBeGreaterThanOrEqual(3);
    expect(passed.ann).toBeLessThan(6);
    expect(passed.bea).toBe(1);
    expect(ann.guest.has('protocol:error')).toBe(false);
    // The budget comes back with time.
    await wait(700);
    ann.guest.send('guest-to-relay', { type: 'spotlight:point', spotlight });
    expect(await room.host.next('spotlight:pointed')).toMatchObject({ guestId: ann.guestId });
    room.host.close();
  });

  it('tells the other collaborators of a collaborator’s edit, and nobody else', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann', 'collaborator');
    const bea = await admittedGuest(relay, room, 'Bea', 'collaborator');
    const cid = await admittedGuest(relay, room, 'Cid');
    const dee = await admittedGuest(relay, room, 'Dee', 'collaborator');
    room.host.send('host-to-relay', { type: 'activity:edit', guestId: ann.guestId, target });
    expect(await bea.guest.next('activity:edited')).toEqual({ type: 'activity:edited', guestId: ann.guestId, target });
    expect(await dee.guest.next('activity:edited')).toEqual({ type: 'activity:edited', guestId: ann.guestId, target });
    // Nor for a guest the room does not hold.
    room.host.send('host-to-relay', { type: 'activity:edit', guestId: 'g_nobody', target: null });
    await wait(150);
    expect(ann.guest.has('activity:edited')).toBe(false);
    expect(cid.guest.has('activity:edited')).toBe(false);
    expect(bea.guest.has('activity:edited')).toBe(false);
    room.host.close();
  });
});
