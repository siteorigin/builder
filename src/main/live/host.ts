import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { LiveActivity, LiveCommandResult, LiveHostState, LiveJoinRequest, LivePresence, LiveRun, LiveSpotlight, LiveStartResult } from '@shared/api';
import { checkRpcRequest, type LiveEditBatch } from '@shared/live/capabilities';
import { LIVE_CLOSE_CODES } from '@shared/live/close-codes';
import { generateHostKeyPair, signHostChallenge, type HostKeyPair } from '@shared/live/crypto';
import { checkGuestExpiry, checkSessionExpiry, guestAccessEndsAt, isExpired, isSessionDuration, type SessionDuration } from '@shared/live/expiry';
import { GUEST_ID_RE, GUEST_ROLES, LIVE_PROTOCOL_VERSION, MAX_ID_LENGTH, PROJECT_NAME_MAX, type GuestRole } from '@shared/live/limits';
import { encodeFrame, normalizeDisplayName, parseFrame, type ElementTarget, type Frame, type HostToRelay, type Participant, type Presence, type RpcError } from '@shared/live/messages';
import type { LiveApplyResult, LiveProjectChanged, LiveProjectSnapshot } from '@shared/live/snapshot';
import { formatInviteLink, HOST_SOCKET_PATH, RELAY_URL_ENV, relaySocketUrl, roomSocketPath, type ResolvedRelayUrl } from '@shared/live/relay-url';
import { PreviewProxy, type LoopbackPreview } from './preview-proxy';

/**
 * The host's side of a live session, in the main process. A session belongs to one opening of one project: the host
 * opens a room on the relay over a single outbound WebSocket, with a key pair made for that session alone and held
 * only in memory, manages who is let in, and answers admitted guests' preview requests from the project's own loopback
 * preview server (preview-proxy.ts). When the connection drops it takes the room back by signing the relay's
 * challenge with that key, so guests keep their places. Closing or switching the project, or quitting, ends the
 * session for everyone. Admitted guests' editor calls (#765) are checked here against what each guest may do now, as
 * the host last decided it as well as the relay last said, and only then handed to the editor, which makes a
 * collaborator's edits through its own pipeline as the host's writer.
 */

/**
 * A guest's edit, as the editor is given it: who it is from, and a check the editor asks again as the edit's turn comes
 * and just before it is saved, null while the guest may still make it.
 */
export interface LiveGuestEdit {
  guestId: string;
  displayName: string;
  check(): RpcError | null;
}

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
  /** The latest project revision the open project's preview has published, or null before one (#766). */
  publishedRevision?(): number | null;
  /**
   * The project as guests are given it (shared/live/snapshot.ts) in the opening named, or null when that is not the
   * project open. The same object while nothing a guest sees has changed. Absent: guests' calls are unavailable.
   */
  guestSnapshot?(opening: string): LiveProjectSnapshot | null;
  /** Make a collaborator's checked edit in the opening named, through the editor's own pipeline. */
  applyGuest?(opening: string, guest: LiveGuestEdit, batch: LiveEditBatch): Promise<LiveApplyResult>;
  emit(channel: 'live:state' | 'live:request' | 'live:presence', payload: LiveHostState | LiveJoinRequest | LivePresence): void;
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
  /** Changes to the project this close together reach guests as one project:changed. */
  eventsMs: number;
  /** How long a guest's spotlight is shown in the editor (#768): its ring, or the prompt to go to the page it is on. */
  spotlightMs: number;
  /** How long a collaborator's edit shows it as editing (#768). */
  activityMs: number;
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
  expiryGraceMs: 5_000,
  eventsMs: 250,
  spotlightMs: 8_000,
  activityMs: 3_000
};

/** A guest's edits waiting their turn at once: one guest cannot fill the project's write queue. */
export const MAX_GUEST_EDITS_IN_FLIGHT = 2;
/**
 * Snapshots a guest may ask for in a burst, and how often one more is allowed after: a guest asks on joining and when
 * it has missed a change, and project:changed brings the rest. Each answer is up to a frame of the host's upload.
 */
export const GUEST_SNAPSHOT_BURST = 5;
export const GUEST_SNAPSHOT_REFILL_MS = 1_000;
/** Answers wait while this much is still going out on the host's socket, rather than piling up behind it. */
const RPC_BACKLOG_BYTES = 8 * 1024 * 1024;
/**
 * How much sooner than the relay a guest's editor access ends on the host. The host reads the relay's clock from
 * frames that took a moment to arrive, so it runs a little behind: an edit is never made in the moments after the
 * relay ended the guest's access but before the host could know. The relay alone decides the rest of a guest's access
 * (the preview), so a grant shorter than this gives a guest the preview and nothing of the editor.
 */
export const GRANT_CLOCK_MARGIN_MS = 5_000;

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
/** Numbers each spotlight and edit shown, so the editor tells a new one from one it already shows. */
let markSeq = 0;

/**
 * The one element a guest's batch of edits changed, when every operation in it names the same node of a page or its
 * header or footer; null for anything else (several elements, a component everywhere, the site's settings).
 */
export function editTarget(batch: unknown): ElementTarget | null {
  const operations = (batch as { operations?: unknown } | null)?.operations;
  if (!Array.isArray(operations) || !operations.length) return null;
  let target: ElementTarget | null = null;
  for (const op of operations as Array<{ type?: unknown; owner?: { kind?: unknown; id?: unknown }; nodeId?: unknown; toOwner?: unknown }>) {
    // A copy or a duplicate names the element it was made from, which it leaves as it was.
    if (!op || typeof op !== 'object' || op.toOwner !== undefined || (typeof op.type === 'string' && /\.(copy|duplicate)$/.test(op.type))) return null;
    const kind = op?.owner?.kind;
    const id = op?.owner?.id;
    const nodeId = op?.nodeId;
    if ((kind !== 'page' && kind !== 'shell') || typeof id !== 'string' || typeof nodeId !== 'string' || !id || !nodeId || id.length > MAX_ID_LENGTH || nodeId.length > MAX_ID_LENGTH) return null;
    if (target && (target.owner.kind !== kind || target.owner.id !== id || target.nodeId !== nodeId)) return null;
    target = { owner: { kind, id }, instancePath: [], nodeId };
  }
  return target;
}
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

/**
 * The host's own decision about a guest it let in, kept as it sends each command, so the host never waits for the
 * relay to confirm a grant it has taken away. What a guest may do is the least of this and what the relay last said.
 */
interface Grant {
  role: GuestRole;
  guestExpiresAt: number | null;
  /**
   * Role changes sent and not yet seen in a roster, oldest first. A roster in flight when one was sent still shows the
   * role before it, and the relay forwards calls in order with its rosters: until a roster shows each change, a call
   * may have been forwarded before it, so the guest holds the least role among them.
   */
  unconfirmed: GuestRole[];
  /** Bumped whenever the host takes a role away, so an edit asked for before then never lands, whatever came after. */
  generation: number;
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
  /** The latest project revision the preview was said to serve (projectChanged), sent with each reload; null before one. */
  publishedRevision: number | null;
  /** The admitted guests the host's presence was last sent with them listed, so a newcomer is sent it once. */
  presentedTo: Set<string>;
  /**
   * The latest end asked for that the relay has not confirmed yet (and when, monotonic), so a second extension is
   * never earlier than the first: the relay applies them in order.
   */
  asked: { expiresAt: number; at: number } | null;
  /** The guests already announced as waiting, so a roster resent after a reconnect announces nobody twice. */
  announced: Set<string>;
  /** Where the host is in the editor, as last told: sent once the room is held, and again on every room taken back. */
  hostPresence: Presence | null;
  /** What the host has decided about each guest it let in (Grant). */
  grants: Map<string, Grant>;
  /** Guests the host removed: nothing of theirs is answered again, whatever a roster still says. */
  kicked: Set<string>;
  /** Each guest's edits being made now (MAX_GUEST_EDITS_IN_FLIGHT). */
  edits: Map<string, number>;
  /** Each guest's snapshot budget (GUEST_SNAPSHOT_BURST), and when it was last counted (monotonic). */
  reads: Map<string, { tokens: number; at: number }>;
  /** Where each collaborator is, as each last said. */
  presence: Map<string, Presence>;
  /** Each guest's latest spotlight and each collaborator's latest edit (#768), until it is no longer shown. */
  spotlights: Map<string, LiveSpotlight & { until: number }>;
  activity: Map<string, LiveActivity & { until: number }>;
  /** Takes spotlights and edits off once their time is up: one timer, for the soonest. */
  marksTimer: ReturnType<typeof setTimeout> | null;
  /** The editor's state guests were last sent, so a change reaches them once. */
  sentSnapshot: LiveProjectSnapshot | null;
  sentRuntime: string | null;
  eventsTimer: ReturnType<typeof setTimeout> | null;
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
      publishedRevision: null,
      presentedTo: new Set(),
      asked: null,
      announced: new Set(),
      hostPresence: null,
      grants: new Map(),
      kicked: new Set(),
      edits: new Map(),
      reads: new Map(),
      presence: new Map(),
      spotlights: new Map(),
      activity: new Map(),
      marksTimer: null,
      sentSnapshot: null,
      sentRuntime: null,
      eventsTimer: null,
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
    for (const timer of [run.retryTimer, run.expiryTimer, run.reloadTimer, run.eventsTimer, run.marksTimer]) if (timer) clearTimeout(timer);
    run.retryTimer = run.expiryTimer = run.reloadTimer = run.eventsTimer = run.marksTimer = null;
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
        return this.onCall(conn, frame);
      case 'presence:changed':
        return this.onPresence(conn, frame);
      case 'spotlight:pointed':
        return this.onSpotlight(conn, frame);
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
    this.confirmGrants(run, first && conn.kind === 'reclaim' ? conn : null);
    // Ending: nobody is let in or told about any more.
    if (run.phase === 'stopping') return;
    if (!first) {
      this.publish();
      this.presentToNewcomers(run, conn);
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
    // Whatever was sent before a drop may not have arrived: guests coming back to a room taken back reload once, and
    // are sent the project as it is now.
    if (conn.kind === 'reclaim') {
      run.reloadDue = true;
      run.sentSnapshot = run.sentRuntime = null;
      this.editorChanged();
    }
    this.publish();
    this.announce(run);
    // Guests following the host see where it is now, whatever was sent before a drop.
    if (run.hostPresence) this.sendOn(conn, { type: 'presence:update', presence: run.hostPresence });
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
    return this.write(conn, text);
  }

  /** Send text already made a frame on a connection that is open. */
  private write(conn: Connection, text: string): boolean {
    if (conn.closed || conn.socket.readyState !== OPEN) return false;
    // A connection that has stopped moving is given up, and the room taken back on another.
    if (conn.socket.bufferedAmount > MAX_SOCKET_BACKLOG_BYTES) {
      this.lost(conn, null);
      return false;
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

  /**
   * A change to the project reached its preview, at `revision` when the preview said which: guests reload what they
   * show, and are told the revision a page loaded now shows.
   */
  projectChanged(revision?: number): void {
    const run = this.run;
    if (!run || run.phase === 'stopping') return;
    if (typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0) run.publishedRevision = Math.max(run.publishedRevision ?? 0, revision);
    this.scheduleReload(run);
  }

  /**
   * A guest the roster shows newly admitted hears where the host is now, selection and all: the relay keeps only the
   * host's page for latecomers (#766).
   */
  private presentToNewcomers(run: Run, conn: Connection): void {
    // A guest back from a dropped connection is a newcomer again: it heard nothing while it was away.
    const admitted = run.room!.participants.filter((p) => p.status === 'admitted' && p.connected).map((p) => p.guestId);
    const fresh = admitted.some((id) => !run.presentedTo.has(id));
    run.presentedTo = new Set(admitted);
    if (fresh && run.hostPresence?.selection) this.sendOn(conn, { type: 'presence:update', presence: run.hostPresence });
  }

  /** The latest revision the preview is known to serve: what it last published, as the editor or this session heard it. */
  private previewRevision(run: Run): number | null {
    const published = this.ctx.publishedRevision?.() ?? null;
    if (published === null) return run.publishedRevision;
    return run.publishedRevision === null ? published : Math.max(published, run.publishedRevision);
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
      const revision = this.previewRevision(run);
      if (this.sendOn(conn, { type: 'preview:reload', ...(revision !== null ? { revision } : {}) })) run.reloadDue = false;
    }, delay);
  }

  // -------------------------------------------------------------------------
  // What guests may do

  /** Record what a command the relay was just sent decides about a guest: it holds for the host from now. */
  private decided(run: Run, frame: HostToRelay): void {
    switch (frame.type) {
      case 'guest:admit':
        run.grants.set(frame.guestId, { role: frame.role, guestExpiresAt: frame.guestExpiresAt, unconfirmed: [], generation: 0 });
        return;
      case 'guest:set-role': {
        const grant = run.grants.get(frame.guestId);
        if (!grant) return;
        if (frame.role === 'viewer') grant.generation++;
        grant.role = frame.role;
        grant.unconfirmed.push(frame.role);
        // A viewer shows nobody where it is, but may still point.
        if (frame.role === 'viewer') this.dropPresence(run, frame.guestId, { keepSpotlight: true });
        return;
      }
      case 'guest:set-expiry': {
        const grant = run.grants.get(frame.guestId);
        if (grant) grant.guestExpiresAt = frame.guestExpiresAt;
        return;
      }
      case 'guest:kick':
        run.grants.delete(frame.guestId);
        run.kicked.add(frame.guestId);
        this.dropPresence(run, frame.guestId);
        return;
    }
  }

  /**
   * A roster arrived: the role changes it shows are confirmed, oldest first, and a guest it no longer lists has gone.
   * On a connection that has just taken the room back (`reclaimed`), commands sent on the one that dropped may never
   * have reached the relay: wherever the room differs from what the host decided, it is sent again.
   */
  private confirmGrants(run: Run, reclaimed: Connection | null): void {
    const room = run.room!;
    const listed = new Map(room.participants.map((p) => [p.guestId, p]));
    for (const [guestId, grant] of run.grants) {
      const p = listed.get(guestId);
      if (!p) {
        run.grants.delete(guestId);
        continue;
      }
      if (p.status !== 'admitted') continue;
      if (reclaimed) grant.unconfirmed = [];
      else if (grant.unconfirmed[0] === p.role) grant.unconfirmed.shift();
    }
    if (reclaimed && run.phase !== 'stopping') {
      const now = relayNow(room);
      const resend = (frame: HostToRelay) => {
        if (this.sendOn(reclaimed, frame)) this.decided(run, frame);
      };
      for (const p of room.participants) {
        // Removed, waiting or not: the relay never had it.
        if (run.kicked.has(p.guestId)) {
          resend({ type: 'guest:kick', guestId: p.guestId });
          continue;
        }
        if (p.status !== 'admitted') continue;
        const grant = run.grants.get(p.guestId);
        // In the room with nothing the host let it in with: let go.
        if (!grant) {
          resend({ type: 'guest:kick', guestId: p.guestId });
          continue;
        }
        if (grant.role !== p.role) resend({ type: 'guest:set-role', guestId: p.guestId, role: grant.role });
        if (grant.guestExpiresAt !== p.guestExpiresAt) {
          // Until the relay confirms it, the guest is held to the earlier of the two (grantOf); one already past ends it.
          const until = checkGuestExpiry(grant.guestExpiresAt, room.expiresAt, now);
          resend(until.ok ? { type: 'guest:set-expiry', guestId: p.guestId, guestExpiresAt: until.expiresAt } : { type: 'guest:kick', guestId: p.guestId });
        }
      }
    }
    for (const guestId of new Set([...run.presence.keys(), ...run.spotlights.keys(), ...run.activity.keys()])) {
      // A guest gone, or only away: nothing of it is shown until it is back and says where it is again.
      if (!this.connected(run, guestId)) this.dropPresence(run, guestId);
      else if (this.collaborator(run, guestId) === null) this.dropPresence(run, guestId, { keepSpotlight: true });
    }
  }

  /** Whether the relay lists the guest as let in and connected, and the host has not removed it. */
  private connected(run: Run, guestId: string): boolean {
    const p = run.room?.participants.find((x) => x.guestId === guestId);
    return p?.status === 'admitted' && p.connected && !('code' in this.grantOf(run, guestId));
  }

  /**
   * What a guest may do now: admitted, as the relay last said and as the host last decided, with access that has not
   * ended on the relay's clock. The least of the two in every respect; anything else is refused.
   */
  private grantOf(run: Run, guestId: string): { role: GuestRole; displayName: string; generation: number } | RpcError {
    const room = run.room;
    const p = room?.participants.find((x) => x.guestId === guestId);
    const grant = run.grants.get(guestId);
    if (!room || p?.status !== 'admitted' || !grant || run.kicked.has(guestId)) return { code: 'PERMISSION_DENIED', message: 'You are not in this live session.', recoverable: false };
    const ends = Math.min(guestAccessEndsAt(p.guestExpiresAt, room.expiresAt), guestAccessEndsAt(grant.guestExpiresAt, room.expiresAt));
    if (isExpired(ends - GRANT_CLOCK_MARGIN_MS, relayNow(room))) return { code: 'EXPIRED', message: 'Your access to this live session has ended.', recoverable: false };
    const role: GuestRole = p.role === 'viewer' || grant.role === 'viewer' || grant.unconfirmed.includes('viewer') ? 'viewer' : 'collaborator';
    return { role, displayName: p.displayName, generation: grant.generation };
  }

  /** A guest's grant when it is a collaborator now, or null. */
  private collaborator(run: Run, guestId: string): { displayName: string; generation: number } | null {
    const grant = this.grantOf(run, guestId);
    return 'code' in grant || grant.role !== 'collaborator' ? null : grant;
  }

  /**
   * A guest's editor call, forwarded by the relay. It runs only on the connection that holds the room for the open
   * project, for a guest whose grant allows it now, with its arguments as capabilities.ts checked them; every call is
   * answered, and nothing a guest sends reaches the editor otherwise.
   */
  private onCall(conn: Connection, frame: Frame<'relay-to-host', 'rpc:request'>): void {
    const run = conn.run;
    const answer = (result: { ok: true; result: unknown } | { ok: false; error: RpcError }) => this.answer(conn, frame, result);
    const refuse = (code: RpcError['code'], message: string, recoverable: boolean) => answer({ ok: false, error: { code, message, recoverable } });
    if (conn.stage !== 'host' || run.phase !== 'active' || !this.current(run) || !this.ctx.guestSnapshot || !this.ctx.applyGuest) return refuse('UNAVAILABLE', 'The host’s project is not available right now.', true);
    const grant = this.grantOf(run, frame.guestId);
    if ('code' in grant) return answer({ ok: false, error: grant });
    const call = checkRpcRequest(grant.role, frame.method, frame.args);
    if (!call.ok) return answer(call);
    if (conn.socket.bufferedAmount > RPC_BACKLOG_BYTES) return refuse('BUSY', 'The host is busy sending. Try again shortly.', true);
    if (call.value.method === 'project.snapshot') {
      if (!this.spendRead(run, frame.guestId)) return refuse('BUSY', 'Too many requests for the project. Try again shortly.', true);
      const snapshot = this.ctx.guestSnapshot(run.workspaceKey);
      // The guest is told which revision the preview serves now, so its canvas knows what the page it loads shows (#766).
      const previewRevision = this.previewRevision(run);
      return snapshot ? answer({ ok: true, result: previewRevision === null ? snapshot : { ...snapshot, previewRevision } }) : refuse('UNAVAILABLE', 'The host’s project is not available right now.', true);
    }
    const { guestId } = frame;
    const edits = run.edits.get(guestId) ?? 0;
    if (edits >= MAX_GUEST_EDITS_IN_FLIGHT) return refuse('BUSY', 'Your earlier edits are still being made. Try again shortly.', true);
    run.edits.set(guestId, edits + 1);
    const { generation } = grant;
    // Asked again as the edit's turn comes and just before it is saved: a guest removed, made a viewer, or out of time
    // since it asked (even one given its role back since) lands nothing, and so does an edit whose connection dropped.
    const check = (): RpcError | null => {
      if (this.run !== run || run.phase !== 'active' || run.conn !== conn || conn.closed) return { code: 'UNAVAILABLE', message: 'The live session’s connection dropped before your edit was made.', recoverable: true };
      const now = this.grantOf(run, guestId);
      if ('code' in now) return now;
      if (now.role !== 'collaborator' || now.generation !== generation) return { code: 'PERMISSION_DENIED', message: 'The host changed your access before your edit was made.', recoverable: false };
      return null;
    };
    void this.ctx
      .applyGuest(run.workspaceKey, { guestId, displayName: grant.displayName, check }, call.value.args[0])
      // A failure the editor did not turn into a refusal may have come after the edit was saved: the guest is told it
      // cannot know, rather than that nothing changed, so it reads the project before trying again.
      .catch((): LiveApplyResult => ({ ok: false, error: { code: 'INTERNAL', message: 'The host could not confirm whether your edit was saved. Fetch the project before trying again.', recoverable: false } }))
      .then((result) => {
        const left = (run.edits.get(guestId) ?? 1) - 1;
        if (left > 0) run.edits.set(guestId, left);
        else run.edits.delete(guestId);
        // Shown as editing only for an edit that was made, by a guest still a collaborator on this connection.
        if (result.ok && check() === null) this.edited(run, conn, guestId, call.value.args[0]);
        answer(result.ok ? { ok: true, result: { revision: result.revision, results: result.results } } : { ok: false, error: result.error });
      });
  }

  /** Take one of a guest's snapshot budget, refilled over time; false when it has none left. */
  private spendRead(run: Run, guestId: string): boolean {
    const now = performance.now();
    const budget = run.reads.get(guestId) ?? { tokens: GUEST_SNAPSHOT_BURST, at: now };
    budget.tokens = Math.min(GUEST_SNAPSHOT_BURST, budget.tokens + (now - budget.at) / GUEST_SNAPSHOT_REFILL_MS);
    budget.at = now;
    run.reads.set(guestId, budget);
    if (budget.tokens < 1) return false;
    budget.tokens--;
    return true;
  }

  /**
   * Answer a call on the connection it came on, while that still holds the room: the relay answers nobody's calls for
   * a connection it has let go. A result too large for one frame is refused as that, so the guest is never left waiting.
   */
  private answer(conn: Connection, frame: Frame<'relay-to-host', 'rpc:request'>, result: { ok: true; result: unknown } | { ok: false; error: RpcError }): void {
    if (conn.closed || conn.run.conn !== conn) return;
    const head = { type: 'rpc:response', guestId: frame.guestId, requestId: frame.requestId, method: frame.method } as const;
    const encoded = encodeFrame('host-to-relay', result.ok ? { ...head, ok: true, result: result.result } : { ...head, ok: false, error: result.error });
    if (encoded.ok) return void this.write(conn, encoded.frame);
    // An edit that was made says so even when the IDs of everything it made are too many to send.
    const made = result.ok && frame.method === 'project.apply' ? (result.result as { revision?: unknown }).revision : undefined;
    if (typeof made === 'number' && this.sendOn(conn, { ...head, ok: true, result: { revision: made, results: [] } })) return;
    const error: RpcError =
      encoded.error.code === 'TOO_LARGE' ? { code: 'TOO_LARGE', message: 'The host’s project is too large to share in a live session.', recoverable: false } : { code: 'INTERNAL', message: 'The host could not send its answer.', recoverable: false };
    this.sendOn(conn, { ...head, ok: false, error });
  }

  /** A participant's presence: kept, and shown in the editor, for a collaborator only. */
  private onPresence(conn: Connection, frame: Frame<'relay-to-host', 'presence:changed'>): void {
    const run = conn.run;
    if (conn.stage !== 'host' || run.phase !== 'active' || frame.participant.kind !== 'guest') return;
    const { guestId } = frame.participant;
    if (!this.collaborator(run, guestId) || !this.connected(run, guestId)) return;
    run.presence.set(guestId, frame.presence);
    this.publishPresence(run);
  }

  /**
   * A guest pointed at something on its preview (#768): shown in the editor for a while, for any guest let in, a viewer
   * too, while it is connected. Its newest spotlight replaces the one before.
   */
  private onSpotlight(conn: Connection, frame: Frame<'relay-to-host', 'spotlight:pointed'>): void {
    const run = conn.run;
    if (conn.stage !== 'host' || run.phase !== 'active' || !this.connected(run, frame.guestId)) return;
    run.spotlights.set(frame.guestId, { seq: ++markSeq, spotlight: frame.spotlight, until: performance.now() + this.timings.spotlightMs });
    this.publishPresence(run);
    this.armMarks(run);
  }

  /**
   * A collaborator's edit was just saved: shown as editing for a moment, here and to the other collaborators, on what
   * it changed when that is one element of a page or its header or footer.
   */
  private edited(run: Run, conn: Connection, guestId: string, batch: unknown): void {
    if (this.run !== run || run.phase !== 'active' || run.conn !== conn || !this.collaborator(run, guestId) || !this.connected(run, guestId)) return;
    const target = editTarget(batch);
    run.activity.set(guestId, { seq: ++markSeq, target, until: performance.now() + this.timings.activityMs });
    this.publishPresence(run);
    this.armMarks(run);
    if (conn.stage === 'host') this.sendOn(conn, { type: 'activity:edit', guestId, target });
  }

  /** Take what has had its time off, and wake again for the next. */
  private armMarks(run: Run): void {
    if (run.marksTimer) clearTimeout(run.marksTimer);
    run.marksTimer = null;
    const due = Math.min(...[...run.spotlights.values(), ...run.activity.values()].map((m) => m.until));
    if (!Number.isFinite(due)) return;
    run.marksTimer = setTimeout(() => {
      run.marksTimer = null;
      if (this.run !== run || run.ended) return;
      const now = performance.now();
      let changed = false;
      for (const marks of [run.spotlights, run.activity]) for (const [guestId, mark] of marks) if (mark.until <= now) changed = marks.delete(guestId) || changed;
      if (changed) this.publishPresence(run);
      this.armMarks(run);
    }, Math.max(0, due - performance.now()));
  }

  /** Stop showing a guest: where it is, its edits, and (unless it may still point) its spotlight. */
  private dropPresence(run: Run, guestId: string, options: { keepSpotlight?: boolean } = {}): void {
    const dropped = [run.presence.delete(guestId), run.activity.delete(guestId), !options.keepSpotlight && run.spotlights.delete(guestId)].some(Boolean);
    if (dropped) this.publishPresence(run);
  }

  private publishPresence(run: Run): void {
    const shown = <T extends { until: number }>(marks: Map<string, T>) => Object.fromEntries([...marks].map(([guestId, { until: _until, ...mark }]) => [guestId, mark]));
    this.ctx.emit('live:presence', { workspaceKey: run.workspaceKey, runId: run.runId, guests: Object.fromEntries(run.presence), spotlights: shown(run.spotlights), activity: shown(run.activity) });
  }

  /**
   * Something guests see of the project may have changed (its documents, whether it can be edited, the preview's
   * state): they are sent it shortly, once, however many changes come together.
   */
  editorChanged(): void {
    const run = this.run;
    if (!run || run.phase === 'stopping' || run.eventsTimer) return;
    run.eventsTimer = setTimeout(() => {
      run.eventsTimer = null;
      this.sendEditor(run);
    }, this.timings.eventsMs);
  }

  /** Send guests what changed since they were last sent it: the preview's state, and the project. */
  private sendEditor(run: Run): void {
    const conn = run.conn;
    // Owed while the room is being taken back: sent once it is (onRoster).
    if (this.run !== run || run.phase !== 'active' || conn?.stage !== 'host' || !this.current(run)) return;
    // Only to guests the host still lets in. When the relay lists one the host has removed, or whose access has ended
    // on the host's reckoning (a command the relay has not had yet, or refused), each of the others is sent its own.
    const listed = run.room!.participants.filter((p) => p.status === 'admitted');
    const granted = listed.filter((p) => !('code' in this.grantOf(run, p.guestId)));
    // Nobody to tell: a guest let in later asks for the project itself.
    if (!granted.length) return;
    const snapshot = this.ctx.guestSnapshot?.(run.workspaceKey);
    if (!snapshot || snapshot === run.sentSnapshot) return;
    const to: Array<string | undefined> = granted.length === listed.length ? [undefined] : granted.map((p) => p.guestId);
    const send = (event: 'runtime:status' | 'project:changed', payload: unknown) => {
      let sent = true;
      for (const guestId of to) {
        const encoded = encodeFrame('host-to-relay', { type: 'rpc:event', event, payload, ...(guestId ? { guestId } : {}) });
        if (!encoded.ok) return encoded.error;
        sent = this.write(conn, encoded.frame) && sent;
      }
      return sent;
    };
    if (snapshot.runtime.state !== run.sentRuntime && send('runtime:status', snapshot.runtime) === true) run.sentRuntime = snapshot.runtime.state;
    let sent = send('project:changed', { kind: 'snapshot', snapshot } satisfies LiveProjectChanged);
    if (typeof sent === 'object' && sent.code === 'TOO_LARGE') sent = send('project:changed', { kind: 'too-large', revision: snapshot.revision } satisfies LiveProjectChanged);
    if (sent === true) run.sentSnapshot = snapshot;
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
    this.decided(run, frame);
    sent?.(run, frame);
    return { ok: true };
  }

  private guest(room: Room, guestId: unknown): Participant | string {
    if (typeof guestId !== 'string' || !GUEST_ID_RE.test(guestId)) return 'That guest is not in the live session.';
    return room.participants.find((p) => p.guestId === guestId) ?? 'That guest is not in the live session.';
  }

  admit(run: unknown, guestId: unknown, role: unknown, guestExpiresAt: unknown = null): LiveCommandResult {
    return this.command(run, (current, room, now) => {
      const guest = this.guest(room, guestId);
      if (typeof guest === 'string') return guest;
      if (current.kicked.has(guest.guestId)) return 'That guest has been removed from the live session.';
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

  /**
   * Where the host is in the editor: the page it shows and the preview's width, for guests following it. The latest is
   * kept for the session and sent while the room is held, and again whenever the room is taken back; one sent while
   * reconnecting goes out once it has been. Not a command: it never waits on the relay, and nothing is refused but a
   * presence the relay would not read.
   */
  setPresence(value: unknown, presence: unknown): LiveCommandResult {
    const run = this.matching(value);
    if (!run || run.phase === 'stopping') return { ok: false, message: 'That live session has ended.' };
    const encoded = encodeFrame('host-to-relay', { type: 'presence:update', presence } as HostToRelay);
    if (!encoded.ok) return { ok: false, message: 'That is not a place in the editor guests can follow.' };
    // What was checked, as it was checked: never the caller's own object.
    const next = (JSON.parse(encoded.frame) as { presence: Presence }).presence;
    // The editor says where it is whenever it starts following a session, a reloaded one too: it hears in return where
    // everyone else is, rather than only once someone next moves.
    this.publishPresence(run);
    if (run.hostPresence && encoded.frame === JSON.stringify({ type: 'presence:update', presence: run.hostPresence })) return { ok: true };
    run.hostPresence = next;
    const conn = run.conn;
    if (run.phase === 'active' && conn?.stage === 'host') this.sendOn(conn, { type: 'presence:update', presence: next });
    return { ok: true };
  }
}
