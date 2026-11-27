import type { Miniflare, WebSocket as SimulatedWebSocket } from 'miniflare';
import { unstable_startWorker } from 'wrangler';
import dns from 'node:dns';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { generateHostKeyPair, previewHostLabel, signHostChallenge, toBase64Url, type HostKeyPair } from '../../src/shared/live/crypto';
import type { SessionDuration } from '../../src/shared/live/expiry';
import { PREVIEW_CHUNK_BYTES, type GuestRole } from '../../src/shared/live/limits';
import { encodeFrame, type Direction, type Frame, type FrameOf } from '../../src/shared/live/messages';
import { PREVIEW_ADMISSION_PATH, roomPreviewOrigin } from '../../src/shared/live/relay-url';

/**
 * Runs the relay in Cloudflare's local simulator for the relay tests: wrangler reads relay/wrangler.toml, bundles the
 * Worker and starts it in workerd with its Durable Object, rate limiter and alarms, all offline and in memory. Tests
 * play the host and the guests over real WebSockets with the shared protocol's own encoders.
 */

type Lookup = typeof dns.lookup;
type PromiseLookup = typeof dns.promises.lookup;
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;
/** Where a lookup is asked: the callback form and the promise form (which Playwright uses). */
export type Resolver = { lookup: Lookup; promises: { lookup: PromiseLookup } };

/** The loopback addresses a lookup asking for `options` gets, IPv4 first. */
function loopback(options: unknown): { all: boolean; addresses: dns.LookupAddress[] } {
  const opts: dns.LookupOptions = typeof options === 'number' ? { family: options } : typeof options === 'object' && options ? (options as dns.LookupOptions) : {};
  const family = opts.family === 'IPv4' ? 4 : opts.family === 'IPv6' ? 6 : (opts.family ?? 0);
  const addresses = [
    { address: '127.0.0.1', family: 4 },
    { address: '::1', family: 6 }
  ].filter((a) => !family || family === a.family);
  return { all: !!opts.all, addresses };
}

/** A name under `localhost` (RFC 6761): `localhost` itself and every name ending in `.localhost`. */
export const isLocalhostName = (hostname: string) => /(^|\.)localhost\.?$/i.test(hostname);

let localhostNamesResolved = false;

/**
 * Give names under `localhost` the loopback addresses in this process. Host resolvers vary in whether they handle
 * nested names such as `p-<label>.relay.localhost`; Playwright's `route.fetch` uses Node's resolver on every OS.
 * Every other name is looked up as before.
 */
export function resolveLocalhostNames(_platform: NodeJS.Platform = process.platform, target: Resolver = dns): void {
  if (target === dns && localhostNamesResolved) return;
  if (target === dns) localhostNamesResolved = true;
  const original = target.lookup;
  target.lookup = ((hostname: string, options: unknown, callback?: unknown) => {
    if (!isLocalhostName(hostname)) return (original as (...args: unknown[]) => void).call(target, hostname, options, callback);
    const done = (typeof options === 'function' ? options : callback) as LookupCallback;
    const { all, addresses } = loopback(typeof options === 'function' ? undefined : options);
    process.nextTick(() => (all ? done(null, addresses) : done(null, addresses[0].address, addresses[0].family)));
  }) as Lookup;
  const originalPromise = target.promises.lookup;
  target.promises.lookup = (async (hostname: string, options?: unknown) => {
    if (!isLocalhostName(hostname)) return (originalPromise as (...args: unknown[]) => Promise<unknown>).call(target.promises, hostname, options);
    const { all, addresses } = loopback(options);
    return all ? addresses : addresses[0];
  }) as PromiseLookup;
}

export const WORKER_NAME = 'siteorigin-live-relay';
export const SIGNING_KEY = 'relay-test-signing-key-0123456789abcdefghijkl';
export const ORIGIN = 'http://relay.test';

export type RelayVars = Partial<Record<'HOST_RECONNECT_GRACE_MS' | 'GUEST_RECONNECT_GRACE_MS' | 'HANDSHAKE_TIMEOUT_MS' | 'PREVIEW_HEAD_TIMEOUT_MS' | 'PREVIEW_IDLE_TIMEOUT_MS' | 'SESSION_SIGNING_KEY' | 'RELAY_ORIGIN', string>>;

type Worker = Awaited<ReturnType<typeof unstable_startWorker>>;
type SimulatedResponse = Awaited<ReturnType<Worker['fetch']>>;
type Incoming = 'relay-to-host' | 'relay-to-guest';
type Outgoing = 'host-to-relay' | 'guest-to-relay';

export class Relay {
  private readonly peers = new Set<Peer<Incoming, Outgoing>>();

  constructor(private readonly worker: Worker) {}

  /** An HTTP request to the relay. `path` may be a full URL to set the scheme the Worker sees. */
  fetch(path: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}): Promise<SimulatedResponse> {
    return this.worker.fetch(path.startsWith('http') ? path : `${ORIGIN}${path}`, init);
  }

  /**
   * An HTTP request over a real local connection to the simulator, as a browser would make it. The simulator's own
   * fetch follows redirects whatever it is asked, and wrangler's dev proxy does not pass on a client going away, so
   * tests of redirects and of guests leaving midway go this way. `path` may be a full URL on a room's preview origin:
   * the connection goes to the simulator and the URL's host is sent as the Host header, as a browser resolving it
   * there would send it.
   */
  async http(path: string, init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'manual' } = {}): Promise<Response> {
    // Node's own HTTP client never follows a redirect, so `redirect: 'manual'` is how every request here behaves.
    const target = new URL(path, ORIGIN);
    const server = await this.miniflare.ready;
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: server.hostname, port: server.port, method: init.method ?? 'GET', path: `${target.pathname}${target.search}`, headers: { ...init.headers, host: target.host }, signal: init.signal },
        (res) => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, one);
          const status = res.statusCode ?? 502;
          const bodyless = status === 204 || status === 304 || (init.method ?? 'GET') === 'HEAD';
          if (bodyless) res.resume();
          resolve(new Response(bodyless ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers }));
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * The simulator's own address on this machine, `http://127.0.0.1:<port>`, for a client that connects for real, as
   * the app's live session host does. Any host serves the relay's own routes here (RELAY_ORIGIN is unset).
   */
  async origin(): Promise<string> {
    const server = await this.miniflare.ready;
    return `http://${server.hostname}:${server.port}`;
  }

  /** Open a WebSocket to the relay, collecting what arrives from the moment it is accepted. */
  async socket<In extends Incoming = 'relay-to-guest', Out extends Outgoing = 'guest-to-relay'>(path: string, headers: Record<string, string> = {}): Promise<Peer<In, Out>> {
    const response = await this.fetch(path, { headers: { upgrade: 'websocket', ...headers } });
    if (response.status !== 101 || !response.webSocket) throw new Error(`Expected a WebSocket from ${path}, got ${response.status}: ${await response.text()}`);
    const peer = new Peer<In, Out>(response.webSocket);
    this.peers.add(peer as unknown as Peer<Incoming, Outgoing>);
    return peer;
  }

  /**
   * Wait for the simulator itself. wrangler can report its worker ready a moment before its local runtime has made
   * the simulator, so whatever needs the simulator (its address, hibernation) waits for it here first.
   */
  async settled(): Promise<void> {
    const runtimes = () => (this.worker.raw as unknown as { runtimes: Array<{ mf?: Miniflare }> }).runtimes;
    for (let i = 0; i < 1000 && !runtimes().some((runtime) => runtime.mf); i++) await wait(10);
    await this.miniflare.ready;
  }

  /**
   * The relay as a real browser reaches it: the simulator's own server, under `relay.localhost` so that each room's
   * preview origin (`p-<label>.relay.localhost`) is the same site as the viewer. Chromium resolves `*.localhost` to
   * loopback itself, and the Worker finds previews by the Host header, so no DNS is involved. A request a test makes
   * from Node to one of these origins (Playwright's `route.fetch`) asks the system's resolver instead; see
   * `resolveLocalhostNames`.
   */
  async browserOrigin(): Promise<string> {
    resolveLocalhostNames();
    await this.settled();
    const server = await this.miniflare.ready;
    return `http://relay.localhost:${server.port}`;
  }

  /** The simulator itself, for what wrangler does not expose: forcing a room's object to hibernate. */
  private get miniflare(): Miniflare {
    const mf = (this.worker.raw as unknown as { runtimes: Array<{ mf?: Miniflare }> }).runtimes.find((runtime) => runtime.mf)?.mf;
    if (!mf) throw new Error('The simulator is not reachable from this wrangler version.');
    return mf;
  }

  /** Evict a room's object as Cloudflare does when it hibernates: memory goes, sockets stay connected. */
  async hibernate(roomId: string): Promise<void> {
    // Rooms' objects are named by their preview host's label (relay/src/index.ts).
    await this.miniflare.unsafeEvictDurableObject(WORKER_NAME, 'SessionRoom', { name: await previewHostLabel(roomId), webSockets: 'hibernate' });
  }

  async dispose(): Promise<void> {
    for (const peer of this.peers) peer.close();
    await this.worker.dispose();
  }
}

export async function startRelay(vars: RelayVars = {}): Promise<Relay> {
  const bindings: Record<string, { type: 'plain_text' | 'secret_text'; value: string }> = { SESSION_SIGNING_KEY: { type: 'secret_text', value: SIGNING_KEY } };
  for (const [name, value] of Object.entries(vars)) bindings[name] = { type: name === 'SESSION_SIGNING_KEY' ? 'secret_text' : 'plain_text', value: value! };
  const worker = await unstable_startWorker({
    config: 'relay/wrangler.toml',
    bindings,
    dev: { server: { hostname: '127.0.0.1', port: 0 }, inspector: false, watch: false, persist: false, logLevel: 'none' }
  });
  await worker.ready;
  const relay = new Relay(worker);
  await relay.settled();
  return relay;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One end of a socket to the relay: frames it receives are queued, in order, until a test takes them. */
export class Peer<In extends Incoming, Out extends Outgoing> {
  private readonly frames: Array<FrameOf<In>> = [];
  closeEvent: { code: number; reason: string } | null = null;

  constructor(private readonly ws: SimulatedWebSocket) {
    ws.addEventListener('message', (event) => {
      this.frames.push(JSON.parse(String(event.data)) as FrameOf<In>);
    });
    ws.addEventListener('close', (event) => {
      this.closeEvent = { code: event.code, reason: event.reason };
    });
    ws.accept();
  }

  /** Send a frame the protocol allows, encoded as its sender would. */
  send(direction: Out, frame: FrameOf<Out>): void {
    const encoded = encodeFrame(direction as Direction, frame as never);
    if (!encoded.ok) throw new Error(`Test frame is not valid: ${encoded.error.message}`);
    this.ws.send(encoded.frame);
  }

  /** Send raw text or bytes, as a misbehaving peer would. */
  sendRaw(data: string | Uint8Array<ArrayBuffer>): void {
    this.ws.send(data);
  }

  /** Take the first queued frame of `type`, waiting for one to arrive. */
  async next<T extends FrameOf<In>['type']>(type: T, timeoutMs = 5000): Promise<Frame<In, T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = this.frames.findIndex((frame) => frame.type === type);
      if (at >= 0) return this.frames.splice(at, 1)[0] as Frame<In, T>;
      if (Date.now() > deadline) throw new Error(`No ${type} frame within ${timeoutMs} ms; queued: ${this.frames.map((f) => f.type).join(', ') || 'nothing'}; closed: ${JSON.stringify(this.closeEvent)}`);
      await wait(10);
    }
  }

  /** Take the first queued frame of `type` that `matches`, without waiting; undefined when there is none. */
  take<T extends FrameOf<In>['type']>(type: T, matches: (frame: Frame<In, T>) => boolean): Frame<In, T> | undefined {
    const at = this.frames.findIndex((frame) => frame.type === type && matches(frame as Frame<In, T>));
    return at >= 0 ? (this.frames.splice(at, 1)[0] as Frame<In, T>) : undefined;
  }

  /** Drop every queued frame of `type`: what came before the step a test is about to take. */
  discard(type: FrameOf<In>['type']): void {
    for (let at = this.frames.length - 1; at >= 0; at--) if (this.frames[at].type === type) this.frames.splice(at, 1);
  }

  /** Whether a frame of `type` is queued, without waiting. */
  has(type: FrameOf<In>['type']): boolean {
    return this.frames.some((frame) => frame.type === type);
  }

  /** Wait for the relay to close this socket. */
  async closed(timeoutMs = 5000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closeEvent) {
      if (Date.now() > deadline) throw new Error(`Socket still open after ${timeoutMs} ms; queued: ${this.frames.map((f) => f.type).join(', ') || 'nothing'}`);
      await wait(10);
    }
    return this.closeEvent;
  }

  close(code = 1000): void {
    try {
      this.ws.close(code);
    } catch {
      // Already closed.
    }
  }
}

export type HostPeer = Peer<'relay-to-host', 'host-to-relay'>;
export type GuestPeer = Peer<'relay-to-guest', 'guest-to-relay'>;

export interface OpenedRoom {
  host: HostPeer;
  keys: HostKeyPair;
  roomId: string;
  /** The room's preview origin as the tests' relay host gives it: `http://p-<label>.relay.test`. */
  previewOrigin: string;
  ready: Frame<'relay-to-host', 'room:ready'>;
}

/** A room's preview origin on the tests' relay host. */
export const previewOrigin = (roomId: string) => roomPreviewOrigin(ORIGIN, roomId);

/** Open a room as a host would: a fresh key pair, room:create on the host socket, room:ready back. */
export async function openRoom(relay: Relay, options: { duration?: SessionDuration; projectName?: string; ip?: string } = {}): Promise<OpenedRoom> {
  const keys = await generateHostKeyPair();
  // Each room comes from its own address unless a test says otherwise, so the creation rate limit only bites when meant to.
  const host = await relay.socket<'relay-to-host', 'host-to-relay'>('/ws/host', { 'cf-connecting-ip': options.ip ?? randomAddress() });
  host.send('host-to-relay', { type: 'room:create', version: 2, publicKey: keys.publicKey, duration: options.duration ?? '2h', projectName: options.projectName ?? 'Test site' });
  const ready = await host.next('room:ready');
  await host.next('room:roster');
  return { host, keys, roomId: ready.roomId, previewOrigin: await previewOrigin(ready.roomId), ready };
}

/** Take a room back as its host: host:reconnect, sign the challenge, room:ready back. */
export async function reconnectHost(relay: Relay, roomId: string, keys: HostKeyPair, headers: Record<string, string> = {}): Promise<{ host: HostPeer; ready: Frame<'relay-to-host', 'room:ready'> }> {
  const host = await relay.socket<'relay-to-host', 'host-to-relay'>(`/s/${roomId}/ws`, headers);
  host.send('host-to-relay', { type: 'host:reconnect', version: 2, roomId });
  const challenge = await host.next('host:challenge');
  host.send('host-to-relay', { type: 'host:proof', roomId, nonce: challenge.nonce, signature: await signHostChallenge(keys.privateKey, challenge) });
  return { host, ready: await host.next('room:ready') };
}

export interface JoinedGuest {
  guest: GuestPeer;
  guestId: string;
  resumeToken: string;
}

/** Ask to join a room as a guest; resolves once the relay says the guest is waiting. */
export async function joinGuest(relay: Relay, roomId: string, displayName = 'Ann'): Promise<JoinedGuest> {
  const guest = await relay.socket(`/s/${roomId}/ws`);
  guest.send('guest-to-relay', { type: 'guest:join', version: 2, displayName });
  const status = await guest.next('guest:status');
  if (status.status !== 'pending') throw new Error(`Expected to wait in the room, got ${status.status}`);
  return { guest, guestId: status.guestId, resumeToken: status.resumeToken };
}

/** The host admits a waiting guest; resolves with the guest's admitted status. */
export async function admitGuest(host: HostPeer, joined: JoinedGuest, role: GuestRole = 'viewer', guestExpiresAt: number | null = null) {
  host.send('host-to-relay', { type: 'guest:admit', guestId: joined.guestId, role, guestExpiresAt });
  const status = await joined.guest.next('guest:status');
  if (status.status !== 'admitted') throw new Error(`Expected to be admitted, got ${status.status}`);
  return status;
}

/** Redeem a preview ticket on the room's preview origin; resolves with the response and the cookie to send back (`so_preview=…`), if one was set. */
export async function redeemTicket(relay: Relay, roomId: string, ticket: string | undefined, headers: Record<string, string> = {}): Promise<{ status: number; setCookie: string | null; cookie: string | null; response: SimulatedResponse }> {
  const response = await relay.fetch(`${await previewOrigin(roomId)}${PREVIEW_ADMISSION_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ ticket }) });
  await response.arrayBuffer();
  const setCookie = response.headers.get('set-cookie');
  return { status: response.status, setCookie, cookie: setCookie ? setCookie.split(';')[0] : null, response };
}

/** A guest that is in the room and holds a working preview cookie. */
export async function admittedGuest(relay: Relay, room: OpenedRoom, displayName = 'Ann', role: GuestRole = 'viewer', guestExpiresAt: number | null = null) {
  const joined = await joinGuest(relay, room.roomId, displayName);
  await room.host.next('room:roster');
  const status = await admitGuest(room.host, joined, role, guestExpiresAt);
  await room.host.next('room:roster');
  const redeemed = await redeemTicket(relay, room.roomId, status.previewTicket);
  if (redeemed.status !== 204 || !redeemed.cookie) throw new Error(`Ticket redemption failed with ${redeemed.status}`);
  return { ...joined, status, cookie: redeemed.cookie };
}

/** The host answers a preview request: a head, the body in chunks of at most `chunkBytes`, and the end. */
export function answerPreview(host: HostPeer, requestId: string, response: { status?: number; headers?: Array<[string, string]>; body?: Uint8Array; chunkBytes?: number; end?: boolean }): void {
  host.send('host-to-relay', { type: 'preview:response-head', requestId, status: response.status ?? 200, headers: response.headers ?? [['content-type', 'text/html; charset=utf-8']] });
  const body = response.body ?? new Uint8Array();
  const size = response.chunkBytes ?? PREVIEW_CHUNK_BYTES;
  let seq = 0;
  for (let at = 0; at < body.length; at += size) host.send('host-to-relay', { type: 'preview:response-chunk', requestId, seq: seq++, data: toBase64Url(body.subarray(at, at + size)) });
  if (response.end !== false) host.send('host-to-relay', { type: 'preview:response-end', requestId, totalBytes: body.length });
}

/**
 * The status a preview request with this cookie gets. It asks for an address no other request uses; when the relay
 * passes it on, the host answers that request (and only that one) with 204, so it never waits for the head timeout.
 */
export async function previewStatus(relay: Relay, room: OpenedRoom, cookie: string): Promise<number> {
  const target = `/status-${randomAddress().replace(/\./g, '-')}`;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 5000);
  let settled: SimulatedResponse | null = null;
  let failed = false;
  const pending = relay.fetch(`${room.previewOrigin}${target}`, { headers: { cookie }, signal: abort.signal }).then(
    (response) => (settled = response),
    (error: unknown) => {
      failed = true;
      throw error;
    }
  );
  pending.catch(() => {});
  try {
    while (!settled && !failed && !abort.signal.aborted) {
      const request = room.host.take('preview:request', (frame) => frame.target === target);
      if (request) answerPreview(room.host, request.requestId, { status: 204, headers: [] });
      await wait(10);
    }
    const response = await pending;
    await response.arrayBuffer();
    return response.status;
  } finally {
    clearTimeout(timeout);
  }
}

/** A client address no other test uses. */
export function randomAddress(): string {
  const [a, b, c] = randomBytes(3);
  return `10.${a}.${b}.${c}`;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let at = 0; at < length; at += 65536) crypto.getRandomValues(bytes.subarray(at, Math.min(length, at + 65536)));
  return bytes;
}

export { wait };
