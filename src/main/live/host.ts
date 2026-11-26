import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { LiveCommandResult, LiveHostState, LiveJoinRequest, LiveRun, LiveStartResult } from '@shared/api';
import { LIVE_CLOSE_CODES } from '@shared/live/close-codes';
import { generateHostKeyPair, signHostChallenge, type HostKeyPair } from '@shared/live/crypto';
import { checkGuestExpiry, checkSessionExpiry, isSessionDuration, type SessionDuration } from '@shared/live/expiry';
import { GUEST_ID_RE, GUEST_ROLES, LIVE_PROTOCOL_VERSION, PROJECT_NAME_MAX, type GuestRole } from '@shared/live/limits';
import { encodeFrame, normalizeDisplayName, parseFrame, type Frame, type HostToRelay, type Participant } from '@shared/live/messages';
import { formatInviteLink, HOST_SOCKET_PATH, RELAY_URL_ENV, relaySocketUrl, roomSocketPath, type ResolvedRelayUrl } from '@shared/live/relay-url';
import { PreviewProxy, type LoopbackPreview } from './preview-proxy';

/**
 * The host's side of a live session, in the main process. A session belongs to one opening of one project: the host
 * opens a room on the relay over a single outbound WebSocket, with a key pair made for that session alone and held
 * only in memory, manages who is let in, and answers admitted guests' preview requests from the project's own loopback
 * preview server (preview-proxy.ts). When the connection drops it takes the room back by signing the relay's
 * challenge with that key, so guests keep their places. Closing or switching the project, or quitting, ends the
 * session for everyone. Nothing here writes to the project: the host stays its only writer.
 */

/** What the manager needs of the app: the open project, its preview, the relay to use, and the editor to tell. */
export interface LiveHostContext {
  /** The project opening a session may belong to, and the name guests are shown; null while none is open. */
  opening(): { workspaceKey: string; projectName: string } | null;
  /** The open project's loopback preview server, or null while none is ready. */
  preview(): LoopbackPreview | null;
  /** The relay to use: the environment variable, the advanced setting, or the production relay. */
  relay(): Promise<ResolvedRelayUrl>;
  /** Whether a save's files are landing in the preview now: a reload then waits, so guests never load a half-landed save. */
  publishing?(): boolean;
  emit(channel: 'live:state' | 'live:request', payload: LiveHostState | LiveJoinRequest): void;
}

/** Opens a WebSocket to the relay. Tests give their own; the app uses the platform's. */
export type LiveSocketFactory = (url: string) => WebSocket;

export interface LiveHostTimings {
  /** How long a new connection has to open its room or prove itself as the room's host. */
  handshakeMs: number;
  /** How long ending a session waits for the relay to confirm it before letting go anyway. */
  stopMs: number;
  /** Reconnect delays: doubling from the first, up to the most, each with some jitter. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** How long the host keeps trying to take its room back after the connection drops. */
  outageMs: number;
  /** Changes this close together reach guests as one reload. */
  reloadMs: number;
  /** After the session's end, how long the host waits for the relay to say so before ending it itself. */
  expiryGraceMs: number;
}

export const LIVE_HOST_TIMINGS: LiveHostTimings = {
  handshakeMs: 30_000,
  stopMs: 2_000,
  backoffBaseMs: 500,
  backoffMaxMs: 10_000,
  // The relay keeps a room for its host for at most 15 minutes (relay/src/config.ts), and a failed reconnect cannot
  // tell a room that is gone from a network that is down.
  outageMs: 15 * 60_000,
  reloadMs: 250,
  expiryGraceMs: 5_000
};

/**
 * The most that may wait to go out on the host's socket. Each preview response pauses well below this
 * (preview-proxy.ts), so a backlog this deep is a connection that has stopped moving: it is given up and the room
 * taken back on a fresh one, rather than holding the host's memory.
 */
export const MAX_SOCKET_BACKLOG_BYTES = 64 * 1024 * 1024;

/**
 * How long an extension the relay has not confirmed still counts against the next one: the relay answers one it
 * accepts with room:state at once, so one unconfirmed this long was refused.
 */
const ASKED_EXPIRY_MS = 10_000;

const OPEN = 1;
/** The code the host closes a connection it gives up on with (one of the codes a client may send). */
const ABANDONED = 4000;

type Stage =
  /** The socket is connecting. */
  | 'opening'
  /** room:create sent; waiting for room:ready. */
  | 'creating'
  /** host:reconnect sent; waiting for the challenge. */
  | 'reclaiming'
  | 'signing'
  /** host:proof sent; waiting for room:ready. */
  | 'proving'
  /** room:ready received; waiting for the roster that follows it. */
  | 'roster'
  /** The room's host. */
  | 'host';

interface Connection {
  run: Run;
  socket: WebSocket;
  kind: 'create' | 'reclaim';
  stage: Stage;
  /** Answers this connection's preview requests, once it is the host. */
  proxy: PreviewProxy | null;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  /** room:end has been sent on it. */
  ending: boolean;
  /** Called once when the connection ends, whichever way, with the code the relay closed it with (null for none). */
  onClosed: Array<(code: number | null) => void>;
}

interface Room {
  roomId: string;
  inviteUrl: string;
  startedAt: number;
  expiresAt: number;
  locked: boolean;
  /**
   * The relay's clock as last read (`now` on room:ready or room:state) and this process's monotonic clock when it was.
   * The relay's time now is worked out from the time elapsed since, so a change to this computer's clock moves none of
   * the session's deadlines.
   */
  relayAt: number;
  monoAt: number;
  participants: Participant[];
}

interface Run {
  runId: string;
  workspaceKey: string;
  duration: SessionDuration;
  projectName: string;
  relayUrl: string;
  keys: HostKeyPair | null;
  room: Room | null;
  phase: 'starting' | 'active' | 'reconnecting' | 'stopping';
  conn: Connection | null;
  lastError: string | null;
  /** Failed reconnects since the room was last held. */
  attempt: number;
  /** While the room is being taken back: when the host stops trying (monotonic), whichever comes first of the outage budget and the session's end. */
  giveUpAt: number | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  reloadTimer: ReturnType<typeof setTimeout> | null;
  /** A reload is owed to guests: sent once the room is held and the preview is ready. */
  reloadDue: boolean;
  /**
   * The latest end asked for that the relay has not confirmed yet (and when, monotonic), so a second extension is
   * never earlier than the first: the relay applies them in order.
   */
  asked: { expiresAt: number; at: number } | null;
  /** The guests already announced as waiting, so a roster resent after a reconnect announces nobody twice. */
  announced: Set<string>;
  /** Answers start(), until the room is open or the start has failed. */
  started: ((result: LiveStartResult) => void) | null;
  stopping: Promise<void> | null;
  ended: boolean;
}

/** Why the relay closed the host's connection, for the codes that end the session; null for one worth retrying. */
function endedBy(code: number | null): string | null {
  switch (code) {
    case LIVE_CLOSE_CODES.ENDED:
      return 'The live session has ended.';
    case LIVE_CLOSE_CODES.SESSION_EXPIRED:
      return 'The live session reached its end.';
    case LIVE_CLOSE_CODES.HOST_GONE:
      return 'The relay closed the live session because this computer was away for too long.';
    case LIVE_CLOSE_CODES.REPLACED:
      return 'Another connection took over as the live session’s host.';
    case LIVE_CLOSE_CODES.POLICY:
      return 'The relay refused this computer’s connection.';
    case LIVE_CLOSE_CODES.TOO_LARGE:
      return 'The relay refused a message that was too large.';
    default:
      return null;
  }
}

/** The project's name as guests are shown it: at most PROJECT_NAME_MAX characters, or a plain stand-in. */
export function liveProjectName(name: string): string {
  const cut = [...name.normalize('NFC').replace(/\s+/gu, ' ').trim()].slice(0, PROJECT_NAME_MAX).join('');
  return normalizeDisplayName(cut, PROJECT_NAME_MAX) ?? 'Untitled site';
}

const isRole = (role: unknown): role is GuestRole => typeof role === 'string' && (GUEST_ROLES as readonly string[]).includes(role);
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
/** The relay's time now, from its clock as last read. */
const relayNow = (room: Room) => Math.round(room.relayAt + (performance.now() - room.monoAt));

export class LiveHostManager {
  private run: Run | null = null;
  /** Why the last session ended on its own; null when the host ended it. */
  private lastEnded: string | null = null;
  /** The preview server last seen, so its requests can be let go when it stops or moves. */
  private lastPreview: number | null = null;
  createSocket: LiveSocketFactory;
  private readonly timings: LiveHostTimings;

  constructor(
    private readonly ctx: LiveHostContext,
    options: { createSocket?: LiveSocketFactory; timings?: Partial<LiveHostTimings> } = {}
  ) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.timings = { ...LIVE_HOST_TIMINGS, ...options.timings };
  }

  /** Whether a session is starting, running or ending. */
  get running(): boolean {
    return this.run !== null;
  }

  get state(): LiveHostState {
    const run = this.run;
    if (!run) return { phase: 'idle', lastError: this.lastEnded };
    const identity = { workspaceKey: run.workspaceKey, runId: run.runId };
    if (run.phase === 'starting' || run.phase === 'stopping' || !run.room) return { ...identity, phase: run.phase === 'stopping' ? 'stopping' : 'starting' };
    const room = run.room;
    return {
      ...identity,
      phase: run.phase,
      roomId: room.roomId,
      inviteUrl: room.inviteUrl,
      projectName: run.projectName,
      duration: run.duration,
      startedAt: room.startedAt,
      expiresAt: room.expiresAt,
      relayClockOffsetMs: relayNow(room) - Date.now(),
      locked: room.locked,
      participants: room.participants.map((p) => ({ ...p })),
      previewReady: this.servingPreview(run) !== null,
      lastError: run.lastError
    };
  }

  // -------------------------------------------------------------------------
  // Starting and ending

  /**
   * Open a room for the project opening `opening` (its snapshot's workspaceKey). Resolves once the relay has opened
   * it and sent its first roster, with the invite link guests open, or with why it could not start.
   */
  start(opts: unknown): Promise<LiveStartResult> {
    const { opening: key, duration } = (opts ?? {}) as { opening?: unknown; duration?: unknown };
    if (typeof key !== 'string' || !isSessionDuration(duration)) return Promise.resolve({ ok: false, message: 'Choose how long the live session lasts.' });
    if (this.run) return Promise.resolve({ ok: false, message: 'A live session is already running.' });
    const opening = this.ctx.opening();
    if (!opening || opening.workspaceKey !== key) return Promise.resolve({ ok: false, message: 'That project is no longer open.' });
    const run: Run = {
      runId: randomUUID(),
      workspaceKey: key,
      duration,
      projectName: liveProjectName(opening.projectName),
      relayUrl: '',
      keys: null,
      room: null,
      phase: 'starting',
      conn: null,
      lastError: null,
      attempt: 0,
      giveUpAt: null,
      retryTimer: null,
      expiryTimer: null,
      reloadTimer: null,
      reloadDue: false,
      asked: null,
      announced: new Set(),
      started: null,
      stopping: null,
      ended: false
    };
    const result = new Promise<LiveStartResult>((resolve) => (run.started = resolve));
    this.run = run;
    this.lastEnded = null;
    this.lastPreview = this.ctx.preview()?.port ?? null;
    this.publish();
    void this.begin(run);
    return result;
  }

  private async begin(run: Run): Promise<void> {
    try {
      const relay = await this.ctx.relay();
      if (!this.current(run)) return;
      if (!relay.ok) return this.finish(run, `The live session relay’s address is not usable (set in ${relay.source === 'env' ? RELAY_URL_ENV : 'Settings'}): ${relay.message}`);
      run.relayUrl = relay.url;
      run.keys = await generateHostKeyPair();
      if (!this.current(run)) return;
      this.connect(run, 'create');
    } catch (e) {
      if (this.current(run)) this.finish(run, `The live session could not start: ${(e as Error).message}`);
    }
  }

  /** End the session `run` names, for everyone. */
  async stop(run: unknown): Promise<LiveCommandResult> {
    const current = this.matching(run);
    if (!current) return { ok: false, message: 'That live session has already ended.' };
    await this.shutdown(current, null);
    return { ok: true };
  }

  /**
   * End whatever session is running, for everyone: the project it belongs to is closing. Guests lose the preview at
   * once; the relay is told, and its answer waited for a moment. Never fails.
   */
  end(lastError: string | null = null): Promise<void> {
    return this.run ? this.shutdown(this.run, lastError) : Promise.resolve();
  }

  /**
   * End a session for everyone. Guests lose the preview at once. A room known to the relay is ended there with
   * room:end, on the connection that holds it or, when that has dropped or is closing, on one that takes the room
   * back to end it; a connection that drops before the relay has confirmed is replaced again while the stop deadline
   * allows. The key is kept until then, and let go with everything else when the relay confirms or time runs out.
   */
  private shutdown(run: Run, lastError: string | null): Promise<void> {
    if (run.stopping) return run.stopping;
    run.phase = 'stopping';
    this.clearTimers(run);
    // Nothing more reaches guests from here, whatever the relay says.
    run.conn?.proxy?.dispose();
    if (run.conn) run.conn.proxy = null;
    run.started?.({ ok: false, message: 'The live session was stopped before it started.' });
    run.started = null;
    this.publish();
    run.stopping = new Promise<void>((resolve) => {
      let settled = false;
      let retry: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (retry) clearTimeout(retry);
        this.finish(run, lastError);
        resolve();
      };
      const deadline = setTimeout(done, this.timings.stopMs);
      const stopBy = performance.now() + this.timings.stopMs;
      // The next try comes after a moment, never after the time left to end the room.
      const again = () => (retry = setTimeout(attempt, Math.min(this.timings.backoffBaseMs, Math.max(0, (stopBy - performance.now()) / 2))));
      const attempt = () => {
        retry = null;
        if (settled) return;
        if (performance.now() >= stopBy) return done();
        let conn = run.conn;
        if (!conn && run.room) {
          conn = this.connect(run, 'reclaim');
          // No connection could even be opened: tried again while there is time.
          if (!conn) return void again();
        }
        // A room that was never asked for needs nothing ending.
        if (!conn || (conn.kind === 'create' && conn.stage === 'opening')) return done();
        conn.onClosed.push((code) => {
          // The relay ended the room (or will not have this connection), or there is no room to end: done. A connection
          // that dropped for any other reason is replaced while there is time.
          if (settled) return;
          if (endedBy(code) !== null || !run.room) return done();
          again();
        });
        // A connection already closing carries nothing more: how it closes says whether the room has ended.
        if (conn.socket.readyState > OPEN) return;
        // The relay reads a connection's frames in order, so room:end may follow room:create before room:ready is back.
        // A connection still proving itself sends it once it has (onReady).
        if (conn.stage === 'creating' || conn.stage === 'roster' || conn.stage === 'host') {
          this.endRoom(conn);
          if (!conn.ending) this.lost(conn, null);
        }
      };
      attempt();
    });
    return run.stopping;
  }

  /** Let a session go: its connection, timers and key, and tell the editor. */
  private finish(run: Run, lastError: string | null): void {
    if (run.ended) return;
    run.ended = true;
    this.clearTimers(run);
    const conn = run.conn;
    run.conn = null;
    if (conn) this.close(conn, 1000, null);
    run.started?.({ ok: false, message: lastError ?? 'The live session ended before it started.' });
    run.started = null;
    run.keys = null;
    if (this.run !== run) return;
    this.run = null;
    this.lastEnded = lastError;
    this.publish();
  }

  private clearTimers(run: Run): void {
    for (const timer of [run.retryTimer, run.expiryTimer, run.reloadTimer]) if (timer) clearTimeout(timer);
    run.retryTimer = run.expiryTimer = run.reloadTimer = null;
  }

  /** Whether `run` is still the session starting or running in the open project. */
  private current(run: Run): boolean {
    if (this.run !== run || run.ended || run.phase === 'stopping') return false;
    if (this.ctx.opening()?.workspaceKey === run.workspaceKey) return true;
    // The project went without saying so: the session goes with it.
    void this.shutdown(run, 'The project was closed.');
    return false;
  }

  /** The running session a command names, or null when it has ended (or is another opening's). */
  private matching(value: unknown): Run | null {
    const run = this.run;
    const named = value as Partial<LiveRun> | null | undefined;
    if (!run || !named || typeof named !== 'object' || named.workspaceKey !== run.workspaceKey || named.runId !== run.runId) return null;
    return run;
  }

  // -------------------------------------------------------------------------
  // The relay connection

  private connect(run: Run, kind: 'create' | 'reclaim'): Connection | null {
    let socket: WebSocket;
    try {
      socket = this.createSocket(relaySocketUrl(run.relayUrl, kind === 'create' ? HOST_SOCKET_PATH : roomSocketPath(run.room!.roomId)));
    } catch (e) {
      if (kind === 'create') this.finish(run, `The live session could not reach the relay: ${(e as Error).message}`);
      else if (run.phase !== 'stopping') this.reconnectLater(run);
      return null;
    }
    const conn: Connection = { run, socket, kind, stage: 'opening', proxy: null, timer: null, closed: false, ending: false, onClosed: [] };
    run.conn = conn;
    // A reconnect never runs past the time left for taking the room back.
    const left = kind === 'reclaim' && run.phase !== 'stopping' && run.giveUpAt !== null ? Math.max(0, run.giveUpAt - performance.now()) : Infinity;
    conn.timer = setTimeout(() => this.lost(conn, null), Math.min(this.timings.handshakeMs, left));
    socket.addEventListener('open', () => this.onOpen(conn));
    socket.addEventListener('message', (event) => void this.onMessage(conn, event.data));
    socket.addEventListener('close', (event) => this.lost(conn, event.code));
    // An error is always followed by a close.
    socket.addEventListener('error', () => undefined);
    return conn;
  }

  private onOpen(conn: Connection): void {
    if (conn.closed || conn.stage !== 'opening') return;
    const run = conn.run;
    if (conn.kind === 'create') {
      // Stopped while connecting: no room is asked for.
      if (run.phase === 'stopping') return this.lost(conn, null);
      conn.stage = 'creating';
      this.sendOn(conn, { type: 'room:create', version: LIVE_PROTOCOL_VERSION, publicKey: run.keys!.publicKey, duration: run.duration, projectName: run.projectName });
    } else {
      conn.stage = 'reclaiming';
      this.sendOn(conn, { type: 'host:reconnect', version: LIVE_PROTOCOL_VERSION, roomId: run.room!.roomId });
    }
  }

  private async onMessage(conn: Connection, data: unknown): Promise<void> {
    if (conn.closed || conn.run.conn !== conn) return;
    const parsed = parseFrame('relay-to-host', data);
    // The relay never sends a frame this side cannot read; one that does not parse is dropped.
    if (!parsed.ok) return;
    const frame = parsed.frame;
    const run = conn.run;
    switch (frame.type) {
      case 'host:challenge':
        return this.onChallenge(conn, frame);
      case 'room:ready':
        return this.onReady(conn, frame);
      case 'room:roster':
        return this.onRoster(conn, frame.participants);
      case 'room:state': {
        if (!run.room || (conn.stage !== 'roster' && conn.stage !== 'host')) return;
        this.roomFacts(run, frame);
        if (run.phase === 'stopping') return;
        this.armExpiry(run);
        return this.publish();
      }
      case 'preview:request':
        // A guest's request reaches the preview only while this connection holds the room for the open project.
        if (conn.stage === 'host' && conn.proxy && run.phase === 'active' && this.current(run)) return conn.proxy.handle(frame);
        this.sendOn(conn, { type: 'preview:abort', requestId: frame.requestId, code: 'UNAVAILABLE' });
        return;
      case 'preview:abort':
        conn.proxy?.abort(frame.requestId);
        return;
      case 'rpc:request':
        // Guests' editor calls arrive with the RPC bridge (#765); until then each is answered, and nothing runs.
        if (conn.stage === 'host')
          this.sendOn(conn, { type: 'rpc:response', guestId: frame.guestId, requestId: frame.requestId, method: frame.method, ok: false, error: { code: 'UNAVAILABLE', message: 'Editing from a live session is not available yet.', recoverable: false } });
        return;
      case 'presence:changed':
        return;
      case 'protocol:error':
        // Proving itself with a key the room was not made with, or for a room that has changed, never comes right.
        if (frame.code === 'AUTH_FAILED' && conn.stage !== 'host') return this.lost(conn, LIVE_CLOSE_CODES.POLICY, 'The relay did not accept this computer as the live session’s host.');
        run.lastError = frame.message;
        if (conn.stage === 'host' && run.phase !== 'stopping') this.publish();
        return;
    }
  }

  private async onChallenge(conn: Connection, frame: Frame<'relay-to-host', 'host:challenge'>): Promise<void> {
    const run = conn.run;
    if (conn.stage !== 'reclaiming' || frame.roomId !== run.room?.roomId || !run.keys) return this.lost(conn, null);
    conn.stage = 'signing';
    let signature: string;
    try {
      signature = await signHostChallenge(run.keys.privateKey, frame);
    } catch {
      return this.lost(conn, null);
    }
    if (conn.closed || run.conn !== conn || conn.stage !== 'signing') return;
    conn.stage = 'proving';
    this.sendOn(conn, { type: 'host:proof', roomId: frame.roomId, nonce: frame.nonce, signature });
  }

  /** The room as the relay says it is now. An extension it has confirmed no longer counts as asked for. */
  private roomFacts(run: Run, frame: { startedAt: number; expiresAt: number; locked: boolean; now: number }): void {
    Object.assign(run.room!, { startedAt: frame.startedAt, expiresAt: frame.expiresAt, locked: frame.locked, relayAt: frame.now, monoAt: performance.now() });
    if (run.asked && frame.expiresAt >= run.asked.expiresAt) run.asked = null;
  }

  private onReady(conn: Connection, frame: Frame<'relay-to-host', 'room:ready'>): void {
    const run = conn.run;
    const expected = conn.kind === 'create' ? 'creating' : 'proving';
    if (conn.stage !== expected || (conn.kind === 'reclaim' && frame.roomId !== run.room?.roomId)) return this.lost(conn, null);
    if (conn.kind === 'create') {
      let inviteUrl: string;
      try {
        inviteUrl = formatInviteLink(run.relayUrl, frame.roomId);
      } catch {
        return this.lost(conn, null);
      }
      run.room = { roomId: frame.roomId, inviteUrl, participants: [], startedAt: 0, expiresAt: 0, locked: false, relayAt: 0, monoAt: 0 };
    }
    this.roomFacts(run, frame);
    conn.stage = 'roster';
    if (conn.kind === 'reclaim') {
      // Proven: the room is this host's again, so only its own handshake deadline is left, not the outage's.
      run.giveUpAt = null;
      if (conn.timer) clearTimeout(conn.timer);
      conn.timer = setTimeout(() => this.lost(conn, null), this.timings.handshakeMs);
    }
    // Taken back only to be ended (shutdown): the relay closes the connection once it has.
    if (run.phase === 'stopping') {
      this.endRoom(conn);
      if (!conn.ending) this.lost(conn, null);
      return;
    }
    // The room's own times hold from here, whatever the roster does.
    this.armExpiry(run);
  }

  /** Ask the relay to end the room on this connection, once. */
  private endRoom(conn: Connection): void {
    if (conn.ending) return;
    conn.ending = this.sendOn(conn, { type: 'room:end' });
  }

  private onRoster(conn: Connection, participants: Participant[]): void {
    const run = conn.run;
    if (!run.room || (conn.stage !== 'roster' && conn.stage !== 'host')) return;
    run.room.participants = participants;
    const first = conn.stage === 'roster';
    conn.stage = 'host';
    // Ending: nobody is let in or told about any more.
    if (run.phase === 'stopping') return;
    if (!first) {
      this.publish();
      return this.announce(run);
    }
    if (conn.timer) clearTimeout(conn.timer);
    conn.timer = null;
    conn.proxy = new PreviewProxy({
      send: (frame) => this.sendOn(conn, frame),
      preview: () => this.servingPreview(run),
      buffered: () => conn.socket.bufferedAmount
    });
    run.phase = 'active';
    run.attempt = 0;
    run.giveUpAt = null;
    // Whatever was sent before a drop may not have arrived: guests coming back to a room taken back reload once.
    if (conn.kind === 'reclaim') run.reloadDue = true;
    this.publish();
    this.announce(run);
    if (run.reloadDue) this.scheduleReload(run, 0);
    const started = run.started;
    run.started = null;
    started?.({ ok: true, inviteUrl: run.room.inviteUrl, state: this.state });
  }

  /** Tell the editor about each guest that has started waiting since it was last told. */
  private announce(run: Run): void {
    const waiting = run.room!.participants.filter((p) => p.status === 'pending');
    for (const guest of waiting)
      if (!run.announced.has(guest.guestId)) this.ctx.emit('live:request', { workspaceKey: run.workspaceKey, runId: run.runId, roomId: run.room!.roomId, guestId: guest.guestId, displayName: guest.displayName });
    run.announced = new Set(waiting.map((g) => g.guestId));
  }

  /**
   * A connection ended: the relay closed it (with `code`), it failed, or the host gave up on it. The session ends when
   * the relay says it has, when there is no room to take back, or with `fatal`; otherwise the host reconnects.
   */
  private lost(conn: Connection, code: number | null, fatal?: string): void {
    if (conn.closed) return;
    this.close(conn, ABANDONED, code);
    const run = conn.run;
    if (run.conn !== conn) return;
    run.conn = null;
    if (this.run !== run || run.ended || run.phase === 'stopping') return;
    const ended = fatal ?? endedBy(code);
    if (!run.room) return this.finish(run, run.lastError ?? ended ?? `The live session relay at ${run.relayUrl} could not be reached.`);
    if (ended) return this.finish(run, ended);
    if (run.phase === 'active') {
      run.phase = 'reconnecting';
      this.publish();
    }
    this.reconnectLater(run);
  }

  /** Close a connection the host is done with, once: its previews stop, and whoever waits on it is told how it closed. */
  private close(conn: Connection, sendCode: number, receivedCode: number | null): void {
    if (conn.closed) return;
    conn.closed = true;
    if (conn.timer) clearTimeout(conn.timer);
    conn.timer = null;
    conn.proxy?.dispose();
    conn.proxy = null;
    try {
      if (conn.socket.readyState <= OPEN) conn.socket.close(sendCode);
    } catch {
      /* already closing */
    }
    for (const fn of conn.onClosed.splice(0)) fn(receivedCode);
  }

  /** Try to take the room back after a delay that doubles with each failure, until the session or the outage runs out. */
  private reconnectLater(run: Run): void {
    const now = performance.now();
    const room = run.room!;
    run.giveUpAt ??= Math.min(now + this.timings.outageMs, now + (room.expiresAt - relayNow(room)));
    if (now >= run.giveUpAt) return this.giveUp(run);
    const delay = Math.min(this.timings.backoffMaxMs, this.timings.backoffBaseMs * 2 ** Math.min(run.attempt, 16));
    run.attempt++;
    run.retryTimer = setTimeout(
      () => {
        run.retryTimer = null;
        if (run.phase !== 'reconnecting' && run.phase !== 'starting') return;
        if (run.giveUpAt !== null && performance.now() >= run.giveUpAt) return this.giveUp(run);
        if (this.current(run)) this.connect(run, 'reclaim');
      },
      Math.min(delay / 2 + (Math.random() * delay) / 2, run.giveUpAt - now)
    );
  }

  private giveUp(run: Run): void {
    const room = run.room!;
    this.finish(run, relayNow(room) >= room.expiresAt ? 'The live session reached its end.' : 'The live session lost its connection to the relay and could not get it back.');
  }

  /** The relay ends the session at its end; should it not say so, the host lets it go a little after. */
  private armExpiry(run: Run): void {
    if (run.expiryTimer) clearTimeout(run.expiryTimer);
    const room = run.room!;
    const wait = room.expiresAt - relayNow(room) + this.timings.expiryGraceMs;
    run.expiryTimer = setTimeout(() => {
      run.expiryTimer = null;
      if (this.run === run && !run.ended && run.phase !== 'stopping') this.finish(run, 'The live session reached its end.');
    }, Math.max(0, wait));
  }

  /** Send a frame on a connection that is open; false when it is not, or the frame cannot be sent. */
  private sendOn(conn: Connection, frame: HostToRelay): boolean {
    if (conn.closed || conn.socket.readyState !== OPEN) return false;
    // A connection that has stopped moving is given up, and the room taken back on another.
    if (conn.socket.bufferedAmount > MAX_SOCKET_BACKLOG_BYTES) {
      this.lost(conn, null);
      return false;
    }
    let text: string;
    if (frame.type === 'preview:response-chunk') {
      // Made here from at most a chunk of bytes, so always well formed: checking each 256 KiB chunk would only cost time.
      text = JSON.stringify(frame);
    } else {
      const encoded = encodeFrame('host-to-relay', frame);
      if (!encoded.ok) {
        // A preview answer the relay would refuse stops that request rather than leaving it waiting.
        if (frame.type.startsWith('preview:response')) this.sendOn(conn, { type: 'preview:abort', requestId: (frame as { requestId: string }).requestId, code: 'INVALID_RESPONSE' });
        return false;
      }
      text = encoded.frame;
    }
    try {
      conn.socket.send(text);
      return true;
    } catch {
      return false;
    }
  }

  private publish(): void {
    this.ctx.emit('live:state', this.state);
  }

  // -------------------------------------------------------------------------
  // The preview

  /** The preview guests are served from: the open project's, while this session belongs to it. */
  private servingPreview(run: Run): LoopbackPreview | null {
    return this.ctx.opening()?.workspaceKey === run.workspaceKey ? this.ctx.preview() : null;
  }

  /**
   * The open project's preview server started, stopped or moved. Requests to one that has gone are stopped, and the
   * relay told so, and guests reload once a new one is ready.
   */
  previewChanged(): void {
    const port = this.ctx.preview()?.port ?? null;
    const run = this.run;
    if (port !== this.lastPreview) {
      this.lastPreview = port;
      run?.conn?.proxy?.cancelAll('UNAVAILABLE');
      if (run && port !== null && run.phase !== 'stopping') this.scheduleReload(run);
    }
    if (run?.room && run.phase !== 'stopping') this.publish();
  }

  /** A change to the project reached its preview: guests reload what they show. */
  projectChanged(): void {
    if (this.run && this.run.phase !== 'stopping') this.scheduleReload(this.run);
  }

  private scheduleReload(run: Run, delay = this.timings.reloadMs): void {
    run.reloadDue = true;
    if (run.reloadTimer) return;
    run.reloadTimer = setTimeout(() => {
      run.reloadTimer = null;
      const conn = run.conn;
      // Still owed while the room is being taken back or the preview is not ready: sent once both are.
      if (this.run !== run || run.phase !== 'active' || conn?.stage !== 'host' || !this.servingPreview(run)) return;
      // A save landing now: the reload waits for it to have landed.
      if (this.ctx.publishing?.()) return this.scheduleReload(run);
      if (this.sendOn(conn, { type: 'preview:reload' })) run.reloadDue = false;
    }, delay);
  }

  // -------------------------------------------------------------------------
  // The host's commands

  /**
   * Check a command against the room as the relay last confirmed it and send it. The relay checks it again; what it
   * refuses arrives as `lastError`, and what it accepts as the next roster or room state.
   */
  private command(value: unknown, build: (run: Run, room: Room, now: number) => HostToRelay | string, sent?: (run: Run, frame: HostToRelay) => void): LiveCommandResult {
    const run = this.matching(value);
    if (!run) return { ok: false, message: 'That live session has ended.' };
    const conn = run.conn;
    if (run.phase !== 'active' || !run.room || !conn || conn.stage !== 'host') return { ok: false, message: run.phase === 'reconnecting' ? 'The live session is reconnecting to the relay. Try again in a moment.' : 'The live session is not running.' };
    const frame = build(run, run.room, relayNow(run.room));
    if (typeof frame === 'string') return { ok: false, message: frame };
    if (!this.sendOn(conn, frame)) return { ok: false, message: 'The live session’s connection to the relay is down.' };
    sent?.(run, frame);
    return { ok: true };
  }

  private guest(room: Room, guestId: unknown): Participant | string {
    if (typeof guestId !== 'string' || !GUEST_ID_RE.test(guestId)) return 'That guest is not in the live session.';
    return room.participants.find((p) => p.guestId === guestId) ?? 'That guest is not in the live session.';
  }

  admit(run: unknown, guestId: unknown, role: unknown, guestExpiresAt: unknown = null): LiveCommandResult {
    return this.command(run, (_run, room, now) => {
      const guest = this.guest(room, guestId);
      if (typeof guest === 'string') return guest;
      if (guest.status !== 'pending') return 'That guest has already been let in.';
      if (!isRole(role)) return 'Choose whether the guest views or collaborates.';
      const until = checkGuestExpiry(guestExpiresAt ?? null, room.expiresAt, now);
      if (!until.ok) return until.message;
      return { type: 'guest:admit', guestId: guest.guestId, role, guestExpiresAt: until.expiresAt };
    });
  }

  decline(run: unknown, guestId: unknown): LiveCommandResult {
    return this.command(run, (_run, room) => {
      const guest = this.guest(room, guestId);
      if (typeof guest === 'string') return guest;
      if (guest.status !== 'pending') return 'That guest has already been let in; remove them instead.';
      return { type: 'guest:decline', guestId: guest.guestId };
    });
  }

  setRole(run: unknown, guestId: unknown, role: unknown): LiveCommandResult {
    return this.command(run, (_run, room) => {
      const guest = this.guest(room, guestId);
      if (typeof guest === 'string') return guest;
      if (guest.status !== 'admitted') return 'Let that guest in first.';
      if (!isRole(role)) return 'Choose whether the guest views or collaborates.';
      return { type: 'guest:set-role', guestId: guest.guestId, role };
    });
  }

  setGuestExpiry(run: unknown, guestId: unknown, guestExpiresAt: unknown): LiveCommandResult {
    return this.command(run, (_run, room, now) => {
      const guest = this.guest(room, guestId);
      if (typeof guest === 'string') return guest;
      if (guest.status !== 'admitted') return 'Let that guest in first.';
      const until = checkGuestExpiry(guestExpiresAt, room.expiresAt, now, guest.guestExpiresAt);
      if (!until.ok) return until.message;
      return { type: 'guest:set-expiry', guestId: guest.guestId, guestExpiresAt: until.expiresAt };
    });
  }

  kick(run: unknown, guestId: unknown): LiveCommandResult {
    return this.command(run, (_run, room) => {
      const guest = this.guest(room, guestId);
      if (typeof guest === 'string') return guest;
      return { type: 'guest:kick', guestId: guest.guestId };
    });
  }

  setLocked(run: unknown, locked: unknown): LiveCommandResult {
    return this.command(run, () => (typeof locked === 'boolean' ? { type: 'room:set-locked', locked } : 'Say whether to lock the room.'));
  }

  /**
   * Move the session's end later. Checked against the latest end already asked for as well as the room's confirmed
   * one: the relay applies extensions in order, so a second one earlier than the first would shorten the session.
   */
  extend(run: unknown, expiresAt: unknown): LiveCommandResult {
    return this.command(
      run,
      (current, room, now) => {
        if (!isTime(expiresAt)) return 'The end of the session is not a time.';
        const asked = current.asked && performance.now() - current.asked.at < ASKED_EXPIRY_MS ? current.asked.expiresAt : 0;
        if (expiresAt <= Math.max(room.expiresAt, asked)) return 'Choose a later end for the live session.';
        const check = checkSessionExpiry(expiresAt, { startedAt: room.startedAt, currentExpiresAt: room.expiresAt }, now);
        if (!check.ok) return check.message;
        return { type: 'room:set-expiry', expiresAt: check.expiresAt };
      },
      (current, frame) => (current.asked = { expiresAt: (frame as { expiresAt: number }).expiresAt, at: performance.now() })
    );
  }
}
