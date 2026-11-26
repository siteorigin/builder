import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RemoteEnding, RemoteJoinResult, RemoteParticipant, RemotePresence, RemoteState, RuntimeState } from '@shared/api';
import { LIVE_CLOSE_CODES } from '@shared/live/close-codes';
import { LIVE_PROTOCOL_VERSION, type GuestRole } from '@shared/live/limits';
import { encodeFrame, normalizeDisplayName, parseFrame, type Frame, type FrameOf, type GuestToRelay, type Presence, type RpcError } from '@shared/live/messages';
import type { LiveApplyResult, LiveProjectChanged, LiveProjectSnapshot } from '@shared/live/snapshot';
import { parseInviteLink, relaySocketUrl, roomPreviewOrigin, roomSocketPath } from '@shared/live/relay-url';
import { GuestPreviewServer, redeemPreviewTicket, REMOTE_PREVIEW_HEADER, type RedeemResult } from './guest-preview';
import type { LiveSocketFactory } from './host';

/**
 * This app as a guest in another computer's live session: the remote shell's connection (#766), in the main process.
 * One outbound WebSocket to the room's socket on the relay carries the guest's place (the waiting room, admission,
 * role changes and every ending), the host's project as it changes, the others' presence, and the guest's calls into
 * the host's editor (`project.snapshot`, and a collaborator's `project.apply`), which the host checks again before
 * anything runs (host.ts). A dropped connection takes the same place back with the relay's resume token for as long
 * as the relay keeps it.
 *
 * The host's preview is shown through this computer's own loopback server (guest-preview.ts): each preview ticket the
 * relay sends is redeemed here for the preview cookie, which never leaves the main process.
 *
 * The editor reads all of it through `remote:*` events and the `remote` API, by join: one join's state, project and
 * presence never reach the next.
 */

export type RemoteChannel = 'remote:state' | 'remote:changed' | 'remote:reload' | 'remote:presence';

export interface LiveGuestContext {
  emit(channel: 'remote:state', payload: RemoteState): void;
  emit(channel: 'remote:changed', payload: { joinId: string; snapshot: LiveProjectSnapshot }): void;
  emit(channel: 'remote:reload', payload: { joinId: string; revision: number | null }): void;
  emit(channel: 'remote:presence', payload: RemotePresence): void;
}

export interface LiveGuestTimings {
  /** How long a new connection has to be told its place before it is given up. */
  handshakeMs: number;
  /** How long a call into the host's editor may take before it is given up. */
  callMs: number;
  /** Reconnect delays: doubling from the first, up to the most, each with some jitter. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** How long the guest keeps taking its place back after the connection drops: a little past the relay's grace. */
  reconnectForMs: number;
  /** Presence updates this close together go out as one: the relay passes on only a few a second. */
  presenceMs: number;
  /** How long a snapshot the host was too busy to send waits before it is asked for again. */
  busyRetryMs: number;
}

export const LIVE_GUEST_TIMINGS: LiveGuestTimings = {
  handshakeMs: 20_000,
  callMs: 30_000,
  backoffBaseMs: 500,
  backoffMaxMs: 10_000,
  reconnectForMs: 150_000,
  presenceMs: 150,
  busyRetryMs: 1_000
};

/** What the guest manager needs that tests replace: the socket, the preview server and ticket redemption. */
export interface LiveGuestOptions {
  createSocket?: LiveSocketFactory;
  timings?: Partial<LiveGuestTimings>;
  createPreview?: () => PreviewServer;
  redeem?: (previewOrigin: string, ticket: string, signal: AbortSignal) => Promise<RedeemResult>;
}

type PreviewServer = Pick<GuestPreviewServer, 'start' | 'setTarget' | 'close' | 'url' | 'secret'>;

/**
 * How the editor's window reaches the host's preview: the loopback server's address, and the header and secret the
 * main process adds to that window's requests to it (guest-preview.ts REMOTE_PREVIEW_HEADER).
 */
export interface RemotePreviewAccess {
  url: string;
  header: string;
  secret: string;
}

const OPEN = 1;
/** How long an `ended` status waits for the close after it, which may say the host stayed away too long. */
const ENDING_CLOSE_WAIT_MS = 1_000;
/** The code the guest closes a connection it gives up on with (one of the codes a client may send). */
const ABANDONED = 4000;

/** What each ending tells the author, back on the Welcome screen. */
export const ENDING_MESSAGES: Readonly<Record<RemoteEnding, string>> = {
  left: 'You left the live session.',
  declined: 'The host declined your request to join.',
  kicked: 'The host removed you from the live session.',
  'expired-guest': 'Your access to the live session has ended.',
  'expired-session': 'The live session has reached its end.',
  ended: 'The host ended the live session.',
  'host-gone': 'The live session closed because the host did not come back in time.',
  locked: 'The host has locked this live session, so nobody new can join.',
  full: 'This live session is full.',
  replaced: 'Your place in the live session was taken up by another connection.',
  lost: 'The connection to the live session was lost, and your place in it was not kept. Join again with the invite link.',
  unavailable: 'The live session could not be reached. Check the invite link and your connection, then try again.',
  refused: 'The relay refused this connection to the live session.'
};

type PendingCall = { method: string; resolve: (answer: { ok: true; result: unknown } | { ok: false; error: RpcError }) => void; timer: ReturnType<typeof setTimeout> };

interface Join {
  joinId: string;
  relayUrl: string;
  roomId: string;
  displayName: string;
  socketUrl: string;
  previewOrigin: string;
  phase: 'joining' | 'waiting' | 'admitted';
  socket: WebSocket | null;
  /** Bumped for every new socket, so what arrives on an old one is ignored. */
  socketSeq: number;
  /** The socket has been told its place since it opened (a status arrived). */
  placed: boolean;
  resumeToken: string | null;
  guestId: string | null;
  role: GuestRole;
  projectName: string;
  guestExpiresAt: number | null;
  sessionExpiresAt: number;
  /** The relay's clock as last read (`now` on a frame) and this process's monotonic clock then. */
  relayAt: number;
  monoAt: number;
  hostConnected: boolean;
  reconnecting: boolean;
  lostSince: number | null;
  retries: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  /** What the last join on the current socket ran into, for the close that follows. */
  refusal: 'resume' | 'full' | null;
  calls: Map<string, PendingCall>;
  nextCall: number;
  participants: RemoteParticipant[];
  hostPresence: Presence | null;
  guestPresence: Map<string, Presence>;
  /** Where this app is, as the editor last said: sent while a collaborator, and again on every return. */
  ownPresence: Presence | null;
  presenceSent: string | null;
  presenceTimer: ReturnType<typeof setTimeout> | null;
  /** The host's project as last received, and the snapshot being asked for. */
  latest: LiveProjectSnapshot | null;
  fetching: Promise<LiveProjectSnapshot | null> | null;
  refetch: boolean;
  busyTimer: ReturnType<typeof setTimeout> | null;
  tooLarge: boolean;
  hostRuntime: RuntimeState['state'] | null;
  /** The latest project revision the host said its preview serves (preview:reload), or null before it said one. */
  previewRevision: number | null;
  preview: {
    server: PreviewServer | null;
    /** The loopback address, once the first cookie is in place; it stays the same for the whole join. */
    url: string | null;
    problem: string | null;
    lastTicket: string | null;
    queued: string | null;
    redeeming: boolean;
    abort: AbortController | null;
    /** One automatic retry, by taking the place back for a fresh ticket, per ticket that failed. */
    retried: boolean;
  };
  /**
   * The session ended with a status (`ended`) whose close, arriving next, may say more (the host stayed away too
   * long): the ending waits a moment for it.
   */
  endingAs: RemoteEnding | null;
  endingTimer: ReturnType<typeof setTimeout> | null;
  /** Answers join(), until the relay has said where the guest stands. */
  joined: ((result: RemoteJoinResult) => void) | null;
  ended: boolean;
}

const unavailable = (message: string): RpcError => ({ code: 'UNAVAILABLE', message, recoverable: true });

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether a value is a snapshot as guests are sent them, with the documents the editor opens it by: the site and its
 * home page, the pages, components, tokens, assets and collections. Anything less is never shown.
 */
function isSnapshot(value: unknown): value is LiveProjectSnapshot {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return false;
  if (typeof value.readOnly !== 'boolean' || typeof value.aiBusy !== 'boolean' || !isRecord(value.runtime) || typeof value.runtime.state !== 'string') return false;
  const state = value.state;
  if (!isRecord(state) || !isRecord(state.site) || typeof state.site.homePageId !== 'string' || !Array.isArray(state.site.pageOrder)) return false;
  if (!isRecord(state.pages) || !isRecord(state.pages[state.site.homePageId])) return false;
  return ['components', 'tokens', 'assets', 'collections', 'manifest'].every((key) => isRecord(state[key]));
}

/** The revision a snapshot the host was asked for says its preview serves, when it says (host.ts adds it to the answer). */
const previewRevisionOf = (value: unknown): number | null => {
  const at = isRecord(value) ? value.previewRevision : undefined;
  return typeof at === 'number' && Number.isSafeInteger(at) && at >= 0 ? at : null;
};

export class LiveGuestManager {
  /** The join under way, from asking to join until it ends. */
  private current: Join | null = null;
  private lastEnded: { reason: RemoteEnding; message: string } | null = null;
  private readonly createSocket: LiveSocketFactory;
  private readonly createPreview: NonNullable<LiveGuestOptions['createPreview']>;
  private readonly redeem: NonNullable<LiveGuestOptions['redeem']>;
  private readonly timings: LiveGuestTimings;
  /** The preview's address and secret changed: the main process lets the editor's window reach it, or stops. */
  onPreviewAccess: ((access: RemotePreviewAccess | null) => void) | null = null;
  private access: RemotePreviewAccess | null = null;

  constructor(
    private readonly ctx: LiveGuestContext,
    options: LiveGuestOptions = {}
  ) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.createPreview = options.createPreview ?? (() => new GuestPreviewServer());
    this.redeem = options.redeem ?? ((origin, ticket, signal) => redeemPreviewTicket(origin, ticket, { signal }));
    this.timings = { ...LIVE_GUEST_TIMINGS, ...options.timings };
  }

  /** How the editor reaches the host's preview, once it may; null otherwise. */
  get previewAccess(): RemotePreviewAccess | null {
    return this.access;
  }

  /** Whether this app holds, or is asking for, a place in a live session. */
  get active(): boolean {
    return this.current !== null;
  }

  get state(): RemoteState {
    const join = this.current;
    if (!join) return { phase: 'idle', ended: this.lastEnded };
    const base = { joinId: join.joinId, relayUrl: join.relayUrl, roomId: join.roomId, displayName: join.displayName, hostConnected: join.hostConnected, reconnecting: join.reconnecting };
    if (join.phase !== 'admitted' || !join.guestId) return { ...base, phase: join.phase === 'joining' ? 'joining' : 'waiting' };
    return {
      ...base,
      phase: 'admitted',
      guestId: join.guestId,
      role: join.role,
      projectName: join.projectName,
      guestExpiresAt: join.guestExpiresAt,
      sessionExpiresAt: join.sessionExpiresAt,
      relayClockOffsetMs: this.relayNow(join) - Date.now(),
      hostRuntime: join.hostRuntime,
      previewRevision: join.previewRevision,
      previewUrl: join.preview.url,
      previewProblem: join.preview.problem,
      tooLarge: join.tooLarge,
      participants: join.participants.map((p) => ({ ...p }))
    };
  }

  // -------------------------------------------------------------------------
  // Joining and leaving

  /**
   * Ask for a place in the live session an invite link names, under a display name. Resolves once the relay has said
   * where the guest stands (waiting, or let straight back in), or with why it could not join.
   */
  async join(opts: unknown): Promise<RemoteJoinResult> {
    const { inviteLink, displayName: rawName } = (opts ?? {}) as { inviteLink?: unknown; displayName?: unknown };
    const invite = parseInviteLink(inviteLink);
    if (!invite) return { ok: false, message: 'Paste the whole invite link the host shared, such as https://live.siteorigin.com/s/….' };
    const displayName = normalizeDisplayName(rawName);
    if (!displayName) return { ok: false, message: 'Enter the name the host will see, up to 40 characters.' };
    if (this.current) return { ok: false, message: 'Leave the live session you are in before joining another.' };
    // Held from the first moment, before anything is awaited: a project opened here, or Leave, meanwhile ends it.
    const join: Join = {
      joinId: randomUUID(),
      relayUrl: invite.relayUrl,
      roomId: invite.roomId,
      displayName,
      socketUrl: relaySocketUrl(invite.relayUrl, roomSocketPath(invite.roomId)),
      previewOrigin: '',
      phase: 'joining',
      socket: null,
      socketSeq: 0,
      placed: false,
      resumeToken: null,
      guestId: null,
      role: 'viewer',
      projectName: '',
      guestExpiresAt: null,
      sessionExpiresAt: 0,
      relayAt: Date.now(),
      monoAt: performance.now(),
      hostConnected: true,
      reconnecting: false,
      lostSince: null,
      retries: 0,
      retryTimer: null,
      handshakeTimer: null,
      refusal: null,
      calls: new Map(),
      nextCall: 0,
      participants: [],
      hostPresence: null,
      guestPresence: new Map(),
      ownPresence: null,
      presenceSent: null,
      presenceTimer: null,
      latest: null,
      fetching: null,
      refetch: false,
      busyTimer: null,
      tooLarge: false,
      hostRuntime: null,
      previewRevision: null,
      preview: { server: null, url: null, problem: null, lastTicket: null, queued: null, redeeming: false, abort: null, retried: false },
      endingAs: null,
      endingTimer: null,
      joined: null,
      ended: false
    };
    this.current = join;
    this.lastEnded = null;
    const result = new Promise<RemoteJoinResult>((resolve) => (join.joined = resolve));
    this.publish();
    try {
      join.previewOrigin = await roomPreviewOrigin(invite.relayUrl, invite.roomId);
    } catch (error) {
      if (this.current === join) this.current = null;
      join.ended = true;
      join.joined = null;
      this.lastEnded = null;
      this.publish();
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    // Left, or ended by a project opened here, while the preview's address was worked out.
    if (join.ended) return result;
    this.connect(join);
    return result;
  }

  /** Leave the live session: the relay is told, so the host sees the place given up at once, and everything here goes. */
  leave(): void {
    const join = this.current;
    if (!join) return;
    this.sendFrame(join, { type: 'guest:leave' });
    this.end(join, 'left');
  }

  /** Let go of everything, as the app quits: the place is given up, as Leave gives it up. */
  dispose(): void {
    const join = this.current;
    if (!join) return;
    this.sendFrame(join, { type: 'guest:leave' });
    this.end(join, 'left', false);
  }

  private connect(join: Join): void {
    this.closeSocket(join);
    if (join.retryTimer) clearTimeout(join.retryTimer);
    join.retryTimer = null;
    const seq = ++join.socketSeq;
    join.refusal = null;
    join.placed = false;
    let socket: WebSocket;
    try {
      socket = this.createSocket(join.socketUrl);
    } catch {
      return this.onClose(join, null);
    }
    join.socket = socket;
    join.handshakeTimer = setTimeout(() => {
      if (join.socketSeq !== seq || join.placed) return;
      this.closeSocket(join, ABANDONED);
      this.onClose(join, null);
    }, this.timings.handshakeMs);
    socket.addEventListener('open', () => {
      if (join.socketSeq !== seq || join.ended) return;
      this.sendFrame(join, { type: 'guest:join', version: LIVE_PROTOCOL_VERSION, displayName: join.displayName, ...(join.resumeToken ? { resumeToken: join.resumeToken } : {}) });
    });
    socket.addEventListener('message', (event: MessageEvent) => {
      if (join.socketSeq !== seq || join.ended) return;
      const read = parseFrame('relay-to-guest', event.data);
      // A frame this guest cannot read is the relay's to have refused; there is nothing to answer it with.
      if (read.ok) this.onFrame(join, read.frame);
    });
    socket.addEventListener('close', (event: CloseEvent) => {
      if (join.socketSeq !== seq) return;
      join.socket = null;
      this.onClose(join, event.code);
    });
    // A socket that fails also closes; the close says what happened.
    socket.addEventListener('error', () => undefined);
  }

  /** Close the current socket, if any, without treating it as a drop. */
  private closeSocket(join: Join, code = 1000): void {
    if (join.handshakeTimer) clearTimeout(join.handshakeTimer);
    join.handshakeTimer = null;
    const socket = join.socket;
    join.socket = null;
    join.socketSeq++;
    if (socket && socket.readyState <= OPEN) {
      try {
        socket.close(code);
      } catch {
        // Already closing.
      }
    }
  }

  private sendFrame(join: Join, frame: GuestToRelay): boolean {
    const socket = join.socket;
    if (!socket || socket.readyState !== OPEN) return false;
    const encoded = encodeFrame('guest-to-relay', frame);
    if (!encoded.ok) return false;
    try {
      socket.send(encoded.frame);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // What the relay says

  private onFrame(join: Join, frame: FrameOf<'relay-to-guest'>): void {
    switch (frame.type) {
      case 'guest:status':
        return this.onStatus(join, frame);
      case 'room:state':
        join.sessionExpiresAt = frame.expiresAt;
        this.readClock(join, frame.now);
        return this.publish();
      case 'host:availability': {
        const back = !join.hostConnected && frame.connected;
        const gone = join.hostConnected && !frame.connected;
        join.hostConnected = frame.connected;
        // The host answers nothing asked of the connection it lost: what was waiting is answered now, not at its deadline.
        if (gone) this.failCalls(join, 'The host’s connection to the live session dropped.');
        // Whatever the host changed while it was away reaches the editor now.
        if (back && join.phase === 'admitted') {
          void this.fetchSnapshot(join);
          this.reload(join);
        }
        return this.publish();
      }
      case 'room:roster': {
        join.participants = frame.participants.map((p) => ({ guestId: p.guestId, displayName: p.displayName, role: p.role }));
        // Only collaborators share where they are: anyone gone, or made a viewer, is no longer shown anywhere.
        let dropped = false;
        for (const id of [...join.guestPresence.keys()]) {
          if (!join.participants.some((p) => p.guestId === id && p.role === 'collaborator')) dropped = join.guestPresence.delete(id) || dropped;
        }
        if (dropped) this.publishPresence(join);
        return this.publish();
      }
      case 'preview:reload':
        if (frame.revision !== undefined) this.notePreviewRevision(join, frame.revision);
        return this.reload(join);
      case 'rpc:response': {
        const call = join.calls.get(frame.requestId);
        if (!call) return;
        join.calls.delete(frame.requestId);
        clearTimeout(call.timer);
        // An answer for another method than was asked is no answer to this call.
        if (frame.method !== call.method) return call.resolve({ ok: false, error: { code: 'INTERNAL', message: 'The host’s answer could not be read. Check the page before trying again.', recoverable: false } });
        return call.resolve(frame.ok ? { ok: true, result: frame.result } : { ok: false, error: frame.error });
      }
      case 'rpc:event':
        return this.onEvent(join, frame);
      case 'presence:changed': {
        if (frame.participant.kind === 'host') join.hostPresence = frame.presence;
        else if (frame.participant.guestId !== join.guestId) join.guestPresence.set(frame.participant.guestId, frame.presence);
        return this.publishPresence(join);
      }
      case 'protocol:error': {
        if (frame.code === 'AUTH_FAILED' && join.resumeToken) join.refusal = 'resume';
        else if (frame.code === 'ROOM_FULL') join.refusal = 'full';
        const call = frame.requestId ? join.calls.get(frame.requestId) : undefined;
        if (call && frame.requestId) {
          join.calls.delete(frame.requestId);
          clearTimeout(call.timer);
          const code: RpcError['code'] = frame.code === 'TOO_LARGE' ? 'TOO_LARGE' : frame.code === 'RATE_LIMITED' ? 'BUSY' : frame.code === 'FORBIDDEN' ? 'PERMISSION_DENIED' : 'INTERNAL';
          call.resolve({ ok: false, error: { code, message: frame.message, recoverable: code === 'BUSY' } });
        }
        return;
      }
    }
  }

  private onStatus(join: Join, frame: Frame<'relay-to-guest', 'guest:status'>): void {
    switch (frame.status) {
      case 'pending':
        this.placed(join);
        join.guestId = frame.guestId;
        join.resumeToken = frame.resumeToken;
        join.phase = 'waiting';
        this.answerJoin(join);
        return this.publish();
      case 'admitted': {
        const back = join.reconnecting;
        this.placed(join);
        const returning = join.phase === 'admitted';
        const demoted = join.role === 'collaborator' && frame.role === 'viewer';
        join.phase = 'admitted';
        join.guestId = frame.guestId;
        join.role = frame.role;
        join.projectName = frame.projectName;
        join.guestExpiresAt = frame.guestExpiresAt;
        join.sessionExpiresAt = frame.sessionExpiresAt;
        this.readClock(join, frame.now);
        if (frame.previewTicket) this.queueTicket(join, frame.previewTicket);
        if (demoted) this.clearOwnPresence(join);
        else this.schedulePresence(join);
        // On first admission, and on taking the place back after a drop (changes may have been missed), the host's
        // project is asked for; a role or deadline changing on a live connection needs no new copy.
        if (!returning || back || !join.latest) void this.fetchSnapshot(join);
        this.answerJoin(join);
        return this.publish();
      }
      case 'declined':
        return this.end(join, 'declined');
      case 'kicked':
        return this.end(join, 'kicked');
      case 'locked':
        return this.end(join, 'locked');
      case 'ended':
        // The close that follows says whether the host ended it or stayed away too long.
        if (join.endingAs) return;
        join.endingAs = 'ended';
        join.endingTimer = setTimeout(() => this.end(join, 'ended'), ENDING_CLOSE_WAIT_MS);
        return;
      case 'expired':
        return this.end(join, frame.scope === 'guest' ? 'expired-guest' : 'expired-session');
    }
  }

  /** The socket has been told its place: any reconnecting is over, and whatever was owed while it was away goes now. */
  private placed(join: Join): void {
    join.placed = true;
    if (join.handshakeTimer) clearTimeout(join.handshakeTimer);
    join.handshakeTimer = null;
    const was = join.reconnecting;
    join.reconnecting = false;
    join.lostSince = null;
    join.retries = 0;
    join.presenceSent = null;
    if (was) this.reload(join);
  }

  private answerJoin(join: Join): void {
    const joined = join.joined;
    join.joined = null;
    joined?.({ ok: true, state: this.state });
  }

  private onEvent(join: Join, frame: Frame<'relay-to-guest', 'rpc:event'>): void {
    if (join.phase !== 'admitted') return;
    if (frame.event === 'runtime:status') {
      const state = (frame.payload as { state?: unknown } | null)?.state;
      if (typeof state === 'string') {
        join.hostRuntime = state as RuntimeState['state'];
        this.publish();
      }
      return;
    }
    const changed = frame.payload as LiveProjectChanged | null;
    if (changed?.kind === 'snapshot' && isSnapshot(changed.snapshot)) return this.accept(join, changed.snapshot);
    if (changed?.kind === 'too-large') {
      // Asking for it would fail the same way until a smaller one: the editor keeps showing the last that fitted.
      join.tooLarge = true;
      return this.publish();
    }
    if (changed?.kind === 'missed') void this.fetchSnapshot(join);
  }

  /** Take a snapshot of the host's project, unless it is older than the one already shown. */
  private accept(join: Join, snapshot: LiveProjectSnapshot): void {
    if (join.ended || this.current !== join) return;
    if (join.latest && snapshot.revision < join.latest.revision) return;
    const runtimeChanged = join.hostRuntime !== snapshot.runtime.state;
    const sizeChanged = join.tooLarge;
    join.latest = snapshot;
    join.tooLarge = false;
    join.hostRuntime = snapshot.runtime.state;
    this.ctx.emit('remote:changed', { joinId: join.joinId, snapshot });
    if (runtimeChanged || sizeChanged) this.publish();
  }

  /**
   * Ask the host for its project now: on joining, on coming back, and when a change was missed. One request at a
   * time; asked for again meanwhile, it is asked once more when the first is answered.
   */
  private fetchSnapshot(join: Join): Promise<LiveProjectSnapshot | null> {
    if (join.fetching) {
      join.refetch = true;
      return join.fetching;
    }
    const run = (async (): Promise<LiveProjectSnapshot | null> => {
      for (;;) {
        join.refetch = false;
        const answer = await this.call(join, 'project.snapshot', []);
        if (join.ended || this.current !== join) return null;
        if (answer.ok && isSnapshot(answer.result)) {
          const at = previewRevisionOf(answer.result);
          if (at !== null) this.notePreviewRevision(join, at);
          const { previewRevision: _at, ...snapshot } = answer.result as LiveProjectSnapshot & { previewRevision?: unknown };
          this.accept(join, snapshot);
        } else if (!answer.ok && answer.error.code === 'TOO_LARGE') {
          join.tooLarge = true;
          this.publish();
        } else if (!answer.ok && (answer.error.code === 'BUSY' || (!join.latest && answer.error.recoverable)) && !join.busyTimer) {
          // The host lets a guest ask only so often, and may be briefly unable to answer: asked again shortly, so a guest
          // let in never waits for a project that is not coming.
          join.busyTimer = setTimeout(() => {
            join.busyTimer = null;
            if (!join.ended) void this.fetchSnapshot(join);
          }, this.timings.busyRetryMs);
        }
        if (!join.refetch) return join.latest;
      }
    })();
    join.fetching = run;
    void run.finally(() => {
      if (join.fetching === run) join.fetching = null;
    });
    return run;
  }

  // -------------------------------------------------------------------------
  // Calls into the host's editor

  private call(join: Join, method: 'project.snapshot' | 'project.apply', args: unknown[]): Promise<{ ok: true; result: unknown } | { ok: false; error: RpcError }> {
    if (join.ended || join.phase !== 'admitted') return Promise.resolve({ ok: false, error: unavailable('You are not in the live session.') });
    const requestId = `g${++join.nextCall}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!join.calls.delete(requestId)) return;
        resolve({ ok: false, error: { code: 'UNAVAILABLE', message: method === 'project.apply' ? 'The host did not answer in time. Your edit may still be made: check the page before trying again.' : 'The host did not answer in time.', recoverable: true } });
      }, this.timings.callMs);
      join.calls.set(requestId, { method, resolve, timer });
      if (!this.sendFrame(join, { type: 'rpc:request', requestId, method, args })) {
        join.calls.delete(requestId);
        clearTimeout(timer);
        resolve({ ok: false, error: unavailable(join.reconnecting ? 'The connection to the live session dropped. Try again once it is back.' : 'The live session’s connection is down.') });
      }
    });
  }

  /** Every call still waiting is answered as unavailable: the relay answers nothing for a connection it let go. */
  private failCalls(join: Join, message: string): void {
    const calls = [...join.calls.values()];
    join.calls.clear();
    for (const call of calls) {
      clearTimeout(call.timer);
      call.resolve({
        ok: false,
        error: { code: 'UNAVAILABLE', message: call.method === 'project.apply' ? `${message} Your edit may still have been made: check the page before trying again.` : message, recoverable: true }
      });
    }
  }

  /** The host's project as guests are given it: the copy last received, else asked for now. Null when not in a session. */
  async snapshot(joinId: unknown, fresh: unknown = false): Promise<LiveProjectSnapshot | null> {
    const join = this.current;
    if (!join || join.joinId !== joinId || join.phase !== 'admitted') return null;
    // Asked fresh (an edit refused as out of date checks what the host has now), the host is asked again.
    if (fresh === true || !join.latest) await this.fetchSnapshot(join);
    return join.latest;
  }

  /** Make a collaborator's edit in the host's project. The host checks it again, and it lands through the host's own pipeline. */
  async apply(joinId: unknown, batch: unknown): Promise<LiveApplyResult> {
    const join = this.current;
    if (!join || join.joinId !== joinId || join.phase !== 'admitted') return { ok: false, error: unavailable('You are no longer in that live session.') };
    if (join.role !== 'collaborator') return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'The host has made you a viewer: you can watch, but not edit.', recoverable: false } };
    if (!join.hostConnected) return { ok: false, error: unavailable('The host is reconnecting. Try again in a moment.') };
    // An edit to a project this guest cannot see as it is now would land blind.
    if (join.tooLarge) return { ok: false, error: { code: 'TOO_LARGE', message: 'The host’s project is too large to share in a live session right now, so editing is paused.', recoverable: true } };
    const answer = await this.call(join, 'project.apply', [batch]);
    if (!answer.ok) return { ok: false, error: answer.error };
    const result = answer.result as { revision?: unknown; results?: unknown } | null;
    if (!result || !Number.isSafeInteger(result.revision)) return { ok: false, error: { code: 'INTERNAL', message: 'The host’s answer could not be read. Check the page before trying again.', recoverable: false } };
    return { ok: true, revision: result.revision as number, results: Array.isArray(result.results) ? (result.results as Array<Record<string, string | string[]>>) : [] };
  }

  // -------------------------------------------------------------------------
  // Presence

  /** Where this app is in the editor, for the others: shared while it is a collaborator. The latest is kept and resent. */
  presence(joinId: unknown, presence: unknown): boolean {
    const join = this.current;
    if (!join || join.joinId !== joinId) return false;
    // Checked as the relay will read it, so nothing is sent it would refuse.
    if (!encodeFrame('guest-to-relay', { type: 'presence:update', presence: presence as Presence }).ok) return false;
    join.ownPresence = presence as Presence;
    this.schedulePresence(join);
    return true;
  }

  private schedulePresence(join: Join): void {
    if (join.presenceTimer || !join.ownPresence) return;
    join.presenceTimer = setTimeout(() => {
      join.presenceTimer = null;
      if (join.ended || join.phase !== 'admitted' || join.role !== 'collaborator' || !join.ownPresence) return;
      const text = JSON.stringify(join.ownPresence);
      if (text === join.presenceSent) return;
      if (this.sendFrame(join, { type: 'presence:update', presence: join.ownPresence })) join.presenceSent = text;
    }, this.timings.presenceMs);
  }

  /** A viewer shares nothing: what it last said stops being sent. */
  private clearOwnPresence(join: Join): void {
    if (join.presenceTimer) clearTimeout(join.presenceTimer);
    join.presenceTimer = null;
    join.presenceSent = null;
  }

  private publishPresence(join: Join): void {
    if (this.current !== join) return;
    this.ctx.emit('remote:presence', { joinId: join.joinId, host: join.hostPresence, guests: Object.fromEntries(join.guestPresence) });
  }

  // -------------------------------------------------------------------------
  // The preview

  /** Redeem tickets one at a time, newest last, so the cookie kept is always the newest grant's. */
  private queueTicket(join: Join, ticket: string): void {
    if (ticket === join.preview.lastTicket) return;
    join.preview.lastTicket = ticket;
    join.preview.queued = ticket;
    if (!join.preview.redeeming) void this.drainTickets(join);
  }

  private async drainTickets(join: Join): Promise<void> {
    const preview = join.preview;
    preview.redeeming = true;
    try {
      if (!preview.server) preview.server = this.createPreview();
      const url = await preview.server.start();
      while (preview.queued && !join.ended) {
        const ticket = preview.queued;
        preview.queued = null;
        const abort = new AbortController();
        preview.abort = abort;
        const result = await this.redeem(join.previewOrigin, ticket, abort.signal);
        if (preview.abort === abort) preview.abort = null;
        if (join.ended || this.current !== join) return;
        // A newer grant is on its way, and this cookie is already out of date: only the newest one is used.
        if (preview.queued) continue;
        if (result.ok) {
          preview.server.setTarget({ origin: join.previewOrigin, cookie: result.cookie });
          const first = preview.url === null;
          preview.url = url;
          preview.problem = null;
          this.setAccess({ url, header: REMOTE_PREVIEW_HEADER, secret: preview.server.secret });
          preview.retried = false;
          // The canvas, if it is showing the preview, loads it again with the new grant.
          if (!first) this.reload(join);
        } else if (!preview.retried && join.socket?.readyState === OPEN) {
          // A ticket can be lost on the way (a network that blinked): taking the place back brings a fresh one.
          preview.retried = true;
          this.closeSocket(join, ABANDONED);
          this.onClose(join, null);
        } else {
          // The grant before it is revoked: nothing is served with it, and the editor says why.
          preview.server.setTarget(null);
          preview.problem = 'The host’s preview could not be opened. Leave the session and join again to try once more.';
        }
        this.publish();
      }
    } catch (error) {
      if (!join.ended) {
        preview.problem = `The host’s preview could not be shown: ${error instanceof Error ? error.message : String(error)}`;
        this.publish();
      }
    } finally {
      preview.redeeming = false;
    }
  }

  private reload(join: Join): void {
    if (join.ended || this.current !== join || join.phase !== 'admitted' || !join.preview.url) return;
    this.ctx.emit('remote:reload', { joinId: join.joinId, revision: join.previewRevision });
  }

  // -------------------------------------------------------------------------
  // Drops and endings

  /** The current socket closed (`code` from the relay), or was given up here (null). */
  private onClose(join: Join, code: number | null): void {
    if (join.ended) return;
    if (join.handshakeTimer) clearTimeout(join.handshakeTimer);
    join.handshakeTimer = null;
    if (join.endingAs) return this.end(join, code === LIVE_CLOSE_CODES.HOST_GONE ? 'host-gone' : join.endingAs);
    if (join.refusal === 'resume') return this.end(join, 'lost');
    switch (code) {
      case LIVE_CLOSE_CODES.REPLACED:
        return this.end(join, 'replaced');
      case LIVE_CLOSE_CODES.SESSION_EXPIRED:
        return this.end(join, 'expired-session');
      case LIVE_CLOSE_CODES.HOST_GONE:
        return this.end(join, 'host-gone');
      case LIVE_CLOSE_CODES.REMOVED:
        return this.end(join, 'kicked');
      case LIVE_CLOSE_CODES.REFUSED:
        return this.end(join, join.refusal === 'full' ? 'full' : 'locked');
      case LIVE_CLOSE_CODES.POLICY:
      case LIVE_CLOSE_CODES.TOO_LARGE:
        return this.end(join, 'refused');
    }
    // Never given a place: the relay could not be reached, or the room is not there.
    if (!join.resumeToken) return this.end(join, 'unavailable');
    // The relay closes with ENDED only when the room it held this place in is gone.
    if (code === LIVE_CLOSE_CODES.ENDED) return this.end(join, 'ended');
    this.scheduleReconnect(join);
  }

  private scheduleReconnect(join: Join): void {
    const now = performance.now();
    if (!join.reconnecting) {
      join.reconnecting = true;
      join.lostSince = now;
      this.failCalls(join, 'The connection to the live session dropped.');
    }
    if (now - (join.lostSince ?? now) > this.timings.reconnectForMs) return this.end(join, 'lost');
    if (this.endIfExpired(join)) return;
    const delay = Math.min(this.timings.backoffMaxMs, this.timings.backoffBaseMs * 2 ** join.retries) * (0.75 + Math.random() * 0.5);
    join.retries++;
    if (join.retryTimer) clearTimeout(join.retryTimer);
    join.retryTimer = setTimeout(() => {
      join.retryTimer = null;
      if (!join.ended && !this.endIfExpired(join)) this.connect(join);
    }, delay);
    this.publish();
  }

  /** Access that ended while the connection was down has ended here too (the relay would say so on return): true if so. */
  private endIfExpired(join: Join): boolean {
    if (join.phase !== 'admitted') return false;
    const at = this.relayNow(join);
    if (join.guestExpiresAt !== null && at >= join.guestExpiresAt) this.end(join, 'expired-guest');
    else if (join.sessionExpiresAt > 0 && at >= join.sessionExpiresAt) this.end(join, 'expired-session');
    return join.ended;
  }

  /**
   * End this join, whichever way: the socket, the preview and every timer go, every call waiting is answered, and the
   * editor is told why. Safe to call more than once.
   */
  private end(join: Join, reason: RemoteEnding, publish = true): void {
    if (join.ended) return;
    join.ended = true;
    this.closeSocket(join);
    for (const timer of [join.retryTimer, join.presenceTimer, join.busyTimer, join.endingTimer]) if (timer) clearTimeout(timer);
    join.retryTimer = join.presenceTimer = join.busyTimer = join.endingTimer = null;
    this.failCalls(join, reason === 'left' ? 'You left the live session.' : ENDING_MESSAGES[reason]);
    join.preview.abort?.abort();
    join.preview.queued = null;
    const server = join.preview.server;
    join.preview.server = null;
    void server?.close();
    if (this.current === join) this.setAccess(null);
    const joined = join.joined;
    join.joined = null;
    if (this.current === join) this.current = null;
    this.lastEnded = { reason, message: ENDING_MESSAGES[reason] };
    joined?.({ ok: false, message: ENDING_MESSAGES[reason] });
    if (publish) this.publish();
  }

  // -------------------------------------------------------------------------

  /** The host said its preview serves `revision` (a reload, or a snapshot asked for): the latest is kept and shown. */
  private notePreviewRevision(join: Join, revision: number): void {
    if (join.previewRevision !== null && revision <= join.previewRevision) return;
    join.previewRevision = revision;
    this.publish();
  }

  private readClock(join: Join, now: number): void {
    join.relayAt = now;
    join.monoAt = performance.now();
  }

  private relayNow(join: Join): number {
    return Math.round(join.relayAt + (performance.now() - join.monoAt));
  }

  private setAccess(access: RemotePreviewAccess | null): void {
    if (this.access?.url === access?.url && this.access?.secret === access?.secret) return;
    this.access = access;
    this.onPreviewAccess?.(access);
  }

  private publish(): void {
    this.ctx.emit('remote:state', this.state);
  }
}
