/**
 * A smoke test of a running live session relay, local or deployed: one room from start to end, over the real network,
 * with the app's own protocol encoders. It plays the host and one guest:
 *
 *   1. the host opens a room on /ws/host and gets room:ready;
 *   2. the invite page and the viewer's script load;
 *   3. the room's preview refuses a request with no cookie;
 *   4. a guest joins and waits, the host admits it as a viewer, and the guest redeems its ticket for the preview cookie;
 *   5. a preview request with the cookie is tunnelled to the host, answered, and streamed back;
 *   6. the host drops its socket and takes the room back by signing the relay's challenge, keeping its guest;
 *   7. the host ends the room, the guest is told, and the cookie stops working.
 *
 * Usage: npm run relay:smoke -- [relay URL] [--no-preview]
 *   (default http://relay.localhost:8787, the `npm run relay:dev` relay)
 *
 * A relay on workers.dev cannot serve previews: a room's preview is `p-<label>.<relay host>`, and workers.dev has no
 * names below a Worker's own. There, as with --no-preview, the steps on the preview origin are skipped and said so.
 *
 * It opens one room, which counts against the relay's per-IP room creation limit (6 a minute), and ends it before
 * exiting, also when a step fails. Exits non-zero on the first step that fails.
 */
import { generateHostKeyPair, signHostChallenge } from '../src/shared/live/crypto';
import { LIVE_CLOSE_CODES } from '../src/shared/live/close-codes';
import { encodeFrame, type Direction, type Frame, type FrameOf } from '../src/shared/live/messages';
import { checkRelayUrl, formatInviteLink, HOST_SOCKET_PATH, PREVIEW_ADMISSION_PATH, relaySocketUrl, roomPreviewOrigin, roomSocketPath } from '../src/shared/live/relay-url';

type Incoming = 'relay-to-host' | 'relay-to-guest';
type Outgoing = 'host-to-relay' | 'guest-to-relay';
type HostPeer = Peer<'relay-to-host', 'host-to-relay'>;
type GuestPeer = Peer<'relay-to-guest', 'guest-to-relay'>;

const TIMEOUT_MS = 15_000;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Every request has a deadline that covers reading its body too. */
const request = (url: string, init: RequestInit = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

/** Take a room back as its host: host:reconnect, then the relay's challenge signed with the room's key. */
async function reconnectHost(relay: string, roomId: string, privateKey: Parameters<typeof signHostChallenge>[0]): Promise<HostPeer> {
  const host = await Peer.open<'relay-to-host', 'host-to-relay'>(relaySocketUrl(relay, roomSocketPath(roomId)), 'host-to-relay');
  host.send({ type: 'host:reconnect', version: 2, roomId });
  const challenge = await host.next('host:challenge');
  host.send({ type: 'host:proof', roomId, nonce: challenge.nonce, signature: await signHostChallenge(privateKey, challenge) });
  const back = await host.next('room:ready');
  if (back.roomId !== roomId) throw new Error(`took back ${back.roomId}, not ${roomId}`);
  return host;
}

/** Every socket the run opens, so all of them are closed whatever fails. */
const opened: Array<{ close(): void }> = [];

/** One socket to the relay: received frames are queued until a step takes them. */
class Peer<In extends Incoming, Out extends Outgoing> {
  private readonly frames: Array<FrameOf<In>> = [];
  private problem: string | null = null;
  closed: { code: number; reason: string } | null = null;

  private constructor(
    private readonly ws: WebSocket,
    private readonly direction: Out
  ) {
    ws.addEventListener('message', (event) => {
      try {
        this.frames.push(JSON.parse(String(event.data)) as FrameOf<In>);
      } catch {
        this.problem = `the relay sent a frame that is not JSON: ${String(event.data).slice(0, 120)}`;
      }
    });
    ws.addEventListener('close', (event) => (this.closed = { code: event.code, reason: event.reason }));
  }

  static open<In extends Incoming, Out extends Outgoing>(url: string, direction: Out): Promise<Peer<In, Out>> {
    const ws = new WebSocket(url);
    const peer = new Peer<In, Out>(ws, direction);
    opened.push(peer);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        peer.close();
        reject(new Error(`${url} did not open within ${TIMEOUT_MS} ms`));
      }, TIMEOUT_MS);
      ws.addEventListener('open', () => (clearTimeout(timer), resolve(peer)), { once: true });
      ws.addEventListener('error', () => (clearTimeout(timer), reject(new Error(`Could not open ${url}`))), { once: true });
    });
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(frame: FrameOf<Out>): void {
    const encoded = encodeFrame(this.direction as Direction, frame as never);
    if (!encoded.ok) throw new Error(`Frame is not valid: ${encoded.error.message}`);
    this.ws.send(encoded.frame);
  }

  /** Take the first queued frame of `type` that `matches`, waiting for one to arrive. */
  async next<T extends FrameOf<In>['type']>(type: T, matches: (frame: Frame<In, T>) => boolean = () => true, timeoutMs = TIMEOUT_MS): Promise<Frame<In, T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = this.frames.findIndex((frame) => frame.type === type && matches(frame as Frame<In, T>));
      if (at >= 0) return this.frames.splice(at, 1)[0] as Frame<In, T>;
      if (this.problem) throw new Error(this.problem);
      const refused = this.frames.find((frame) => frame.type === 'protocol:error');
      if (refused) throw new Error(`the relay refused a frame: ${JSON.stringify(refused)}`);
      if (this.closed) throw new Error(`Socket closed (${this.closed.code} ${this.closed.reason}) while waiting for ${type}`);
      if (Date.now() > deadline) throw new Error(`No matching ${type} within ${timeoutMs} ms; got: ${this.frames.map((f) => f.type).join(', ') || 'nothing'}`);
      await wait(20);
    }
  }

  /** Drop every queued frame of `type`: what came before the step about to be taken. */
  discard(type: FrameOf<In>['type']): void {
    for (let at = this.frames.length - 1; at >= 0; at--) if (this.frames[at].type === type) this.frames.splice(at, 1);
  }

  async waitClosed(timeoutMs = TIMEOUT_MS): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error(`Socket still open after ${timeoutMs} ms`);
      await wait(20);
    }
    return this.closed;
  }

  close(): void {
    try {
      this.ws.close(1000);
    } catch {
      // Already closed.
    }
  }
}

let step = 0;
let reported = false;
async function check<T>(label: string, run: () => Promise<T>): Promise<T> {
  step++;
  const started = Date.now();
  try {
    const result = await run();
    console.log(`  ok ${step}  ${label}  (${Date.now() - started} ms)`);
    return result;
  } catch (error) {
    console.error(`  FAIL ${step}  ${label}\n     ${error instanceof Error ? error.message : String(error)}`);
    reported = true;
    throw error;
  }
}

function expectStatus(response: Response, expected: number, what: string): void {
  if (response.status !== expected) throw new Error(`${what}: expected ${expected}, got ${response.status}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const normal = checkRelayUrl(args.find((arg) => !arg.startsWith('--')) ?? 'http://relay.localhost:8787');
  if (!normal.ok) throw new Error(normal.message);
  const relay = normal.url;
  const previews = !args.includes('--no-preview') && !new URL(relay).hostname.endsWith('.workers.dev');
  console.log(`Relay smoke test against ${relay}${previews ? '' : ' (no previews: skipping the steps on the preview origin)'}`);

  const keys = await generateHostKeyPair();
  let host: HostPeer | null = null;
  let roomId: string | null = null;
  let ended = false;
  try {
    host = await check('host opens a room', async () => {
      const peer = await Peer.open<'relay-to-host', 'host-to-relay'>(relaySocketUrl(relay, HOST_SOCKET_PATH), 'host-to-relay');
      peer.send({ type: 'room:create', version: 2, publicKey: keys.publicKey, duration: '30m', projectName: 'Relay smoke test' });
      return peer;
    });
    const room = await check('relay answers room:ready', async () => {
      const ready = await host!.next('room:ready');
      roomId = ready.roomId;
      await host!.next('room:roster', (r) => r.participants.length === 0);
      return ready.roomId;
    });
    const invite = formatInviteLink(relay, room);
    const preview = await roomPreviewOrigin(relay, room);
    console.log(`     room ${room}\n     invite ${invite}\n     preview ${preview}`);

    await check('invite page and viewer script load', async () => {
      const page = await request(invite);
      expectStatus(page, 200, 'invite page');
      const html = await page.text();
      const script = html.match(/<script[^>]*src="(\/_viewer\/[^"]+\.js)"/)?.[1];
      if (!script) throw new Error('The invite page names no viewer script.');
      const response = await request(new URL(script, relay).href);
      expectStatus(response, 200, `viewer script ${script}`);
      const type = response.headers.get('content-type') ?? '';
      const body = await response.text();
      if (!/javascript/.test(type) || !body.trim()) throw new Error(`viewer script ${script} is not JavaScript (${type}, ${body.length} bytes)`);
    });

    if (previews)
      await check('preview refuses a request with no cookie', async () => {
        const response = await request(`${preview}/`);
        await response.arrayBuffer();
        expectStatus(response, 401, 'preview without a cookie');
      });

    const guest: GuestPeer = await Peer.open<'relay-to-guest', 'guest-to-relay'>(relaySocketUrl(relay, roomSocketPath(room)), 'guest-to-relay');
    const joined = await check('guest joins and waits', async () => {
      guest.send({ type: 'guest:join', version: 2, displayName: 'Smoke test' });
      const status = await guest.next('guest:status');
      if (status.status !== 'pending') throw new Error(`expected pending, got ${status.status}`);
      await host!.next('room:roster', (r) => r.participants.some((p) => p.guestId === status.guestId && p.status === 'pending'));
      return status;
    });
    const inRoom = (r: Frame<'relay-to-host', 'room:roster'>) =>
      r.participants.some((p) => p.guestId === joined.guestId && p.status === 'admitted' && p.role === 'viewer' && p.connected);

    const ticket = await check('host admits the guest, which gets a preview ticket', async () => {
      host!.send({ type: 'guest:admit', guestId: joined.guestId, role: 'viewer', guestExpiresAt: null });
      const status = await guest.next('guest:status');
      if (status.status !== 'admitted' || !status.previewTicket) throw new Error(`expected admitted with a ticket, got ${status.status}`);
      await host!.next('room:roster', inRoom);
      return status.previewTicket;
    });

    const cookie = !previews
      ? null
      : await check('ticket redeemed on the preview origin for the preview cookie', async () => {
          const response = await request(`${preview}${PREVIEW_ADMISSION_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
          await response.arrayBuffer();
          expectStatus(response, 204, 'ticket redemption');
          const value = response.headers.get('set-cookie')?.split(';')[0];
          if (!value) throw new Error('Ticket redemption set no cookie.');
          return value;
        });

    const page = `/smoke-${crypto.randomUUID()}`;
    if (cookie)
      await check('preview request is tunnelled to the host and streamed back', async () => {
        const pending = request(`${preview}${page}`, { headers: { cookie } });
        pending.catch(() => undefined); // Awaited below; a failure before then is not an unhandled rejection.
        const asked = await host!.next('preview:request', (f) => f.target === page);
        const sent = `<!doctype html><title>smoke</title><p>${crypto.randomUUID()}</p>`;
        const body = new TextEncoder().encode(sent);
        host!.send({ type: 'preview:response-head', requestId: asked.requestId, status: 200, headers: [['content-type', 'text/plain; charset=utf-8']] });
        host!.send({ type: 'preview:response-chunk', requestId: asked.requestId, seq: 0, data: Buffer.from(body).toString('base64url') });
        host!.send({ type: 'preview:response-end', requestId: asked.requestId, totalBytes: body.length });
        const response = await pending;
        expectStatus(response, 200, 'tunnelled preview');
        const text = await response.text();
        if (text !== sent) throw new Error(`the body came back changed: ${text.slice(0, 120)}`);
      });

    await check('host drops its socket and takes the room back with a signed challenge', async () => {
      // The guest was told the host is connected when it joined: only what comes after the drop counts.
      guest.discard('host:availability');
      host!.close();
      await host!.waitClosed();
      await guest.next('host:availability', (f) => !f.connected);
      host = await reconnectHost(relay, room, keys.privateKey);
      await host.next('room:roster', inRoom);
      await guest.next('host:availability', (f) => f.connected);
      if (guest.closed) throw new Error('the guest was disconnected while the host was away');
    });

    await check(`host ends the room; the guest is told${cookie ? ' and the cookie stops working' : ''}`, async () => {
      host!.send({ type: 'room:end' });
      ended = true;
      const status = await guest.next('guest:status');
      if (status.status !== 'ended') throw new Error(`expected ended, got ${status.status}`);
      const guestClose = await guest.waitClosed();
      const hostClose = await host!.waitClosed();
      if (guestClose.code !== LIVE_CLOSE_CODES.ENDED || hostClose.code !== LIVE_CLOSE_CODES.ENDED) throw new Error(`closed with ${guestClose.code} (guest) and ${hostClose.code} (host), not ${LIVE_CLOSE_CODES.ENDED}`);
      if (!cookie) return;
      // The address that was just served, with the same cookie: the room is gone, so the relay has nothing there.
      const response = await request(`${preview}${page}`, { headers: { cookie } });
      await response.arrayBuffer();
      expectStatus(response, 404, 'preview after the room ended');
    });
    console.log(`Relay smoke test passed: ${step} steps.`);
  } finally {
    // A failed run ends its room rather than leaving it for the host's reconnect grace, taking it back first if the
    // host's socket is gone.
    if (!ended && roomId) {
      try {
        let current = host as HostPeer | null;
        if (!current?.open) current = await reconnectHost(relay, roomId, keys.privateKey);
        current.send({ type: 'room:end' });
        await current.waitClosed(5000);
      } catch {
        console.error(`     could not end room ${roomId}; it ends when the host's reconnect grace runs out`);
      }
    }
    for (const peer of opened) peer.close();
  }
}

// Exit as soon as the run is decided: a socket whose close handshake never finishes must not keep the process alive.
main().then(
  () => process.exit(0),
  (error: unknown) => {
    if (!reported) console.error(`Relay smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
);
