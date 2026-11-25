/**
 * Replay a run from its replay record (evidence.ts) in a fresh session (issue #497): the same fixture and provider
 * scenario, the same setup, every input sent again to its target found afresh by role, name and region (refs belong to
 * the session that gave them out), and the recorded waits and checks repeated with the deadlines they had, so a replay
 * is paced by the app's own state rather than by the recording's timing. Observations that only looked are not
 * repeated.
 *
 * A replay stops at the first step it cannot repeat or that ends differently (a check that finds otherwise, a wait
 * that is met where it timed out or the other way round, an export that fails where it succeeded), and says which and
 * why, with the reply.
 */
import { CLIP, REPLAY_KIND, REPLAY_VERSION } from './evidence.ts';
import type { JournalEntry, ReplayRecord, TargetDescriptor } from './evidence.ts';
import type { Reply, StartArgs } from './protocol.ts';
import { Session } from './session.ts';
import type { SessionOptions } from './session.ts';

export interface ReplayOptions {
  session?: SessionOptions;
  /** Makes the fresh session (default: a new Session with `session`'s options). */
  make?: () => Session;
  /** Added to the recorded scenario's start (artifactsDir, keepArtifacts, headed). */
  start?: Pick<StartArgs, 'artifactsDir' | 'keepArtifacts' | 'headed'>;
  /** Replay only the steps up to this seq. */
  through?: number;
  /** How long each target may take to appear before it is looked up (default 15000). */
  findMs?: number;
}

export type StepStatus = 'replayed' | 'skipped' | 'diverged';

export interface ReplayStep {
  seq: number;
  op: string;
  status: StepStatus;
  reason?: string;
  /** The reply that diverged, or the last one of the step. */
  reply?: Reply;
  /** Set when it diverged because the record itself marks the step as one it cannot repeat (pixels, text left out). */
  unreplayable?: true;
}

export interface ReplayReport {
  ok: boolean;
  steps: ReplayStep[];
  divergence: ReplayStep | null;
  /** The fresh session, still open: the caller checks what it shows and closes it. */
  session: Session;
}

/** Observations a replay repeats: the waits that pace it, and the checks of what the run produced. */
const REPEATED = new Set(['wait.for', 'project.summary', 'exports.inspect']);

/** How often an input whose target moved as the pointer arrived is sent again, and how long it settles first. */
export const UNSTABLE_RETRIES = 3;
const UNSTABLE_SETTLE_MS = 300;
/** How long, from the first attempt, an input that keeps moving may be aimed at again. */
const UNSTABLE_BUDGET_MS = 5000;

/** Failures of an input that come before anything is sent: such a step changed nothing and is passed over. */
const REFUSED_BEFORE_INPUT = new Set(['BAD_REQUEST', 'UNKNOWN_OP', 'BUSY', 'NOT_STARTED', 'CLOSED', 'STALE_REF', 'STALE_OBSERVATION', 'AMBIGUOUS_TARGET', 'TARGET_NOT_FOUND', 'WINDOW_CLOSED', 'WINDOW_REPLACED', 'APP_EXITED']);

/**
 * A name or region cut to length before it reached the record: by the accessibility snapshot (200 characters and an
 * ellipsis) or by the record itself (CLIP.string and an ellipsis). A short name ending in an ellipsis ("Export…") is whole.
 */
export const SNAPSHOT_NAME_CHARS = 200;
function clipped(s: string | undefined): s is string {
  // Counted both ways: one cut counts UTF-16 units, the other characters.
  return typeof s === 'string' && s.endsWith('…') && Math.max(s.length, [...s].length) >= Math.min(SNAPSHOT_NAME_CHARS, CLIP.string + 1);
}

export function isReplayRecord(v: unknown): v is ReplayRecord {
  const r = v as Partial<ReplayRecord> | null;
  return !!r && r.kind === REPLAY_KIND && r.version === REPLAY_VERSION && Array.isArray(r.steps) && !!r.scenario && typeof r.scenario.fixture === 'string' && (r.scenario.provider === 'scripted' || r.scenario.provider === 'none') && typeof r.complete === 'boolean';
}

/** What a repeated check or wait answered, in the terms the record keeps (its summary). */
function factsOf(op: string, result: unknown): Record<string, unknown> {
  const r = result as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!r) return {};
  if (op === 'project.summary') return { ...(r.project ? { site: r.project.site?.name ?? null } : {}), ...(r.project?.find ? { found: r.project.find.matches.length, complete: r.project.find.complete } : {}) };
  if (op === 'exports.inspect') return { ...(typeof r.files === 'number' ? { files: r.files } : {}), ...(r.find ? { found: r.find.matches.length, complete: r.find.complete } : typeof r.complete === 'boolean' ? { complete: r.complete } : {}) };
  if (op === 'wait.for') return { ...(r.outcome ? { outcome: r.outcome } : {}), ...(typeof r.export?.kind === 'string' ? { kind: r.export.kind } : {}), ...(typeof r.count === 'number' ? { count: r.count } : {}) };
  return {};
}


/** Where a repeat differs from the recording: the same matches found, as completely; the same site name; the same way, and kind, an export ended. */
function differs(e: JournalEntry, reply: Reply): string | null {
  if (!reply.ok) return null;
  const was = e.outcome?.summary ?? {};
  const now = factsOf(e.op, reply.result);
  for (const k of ['found', 'complete', 'outcome', 'kind', 'count', 'files', 'site'] as const) if (k in was && was[k] !== now[k]) return `its ${k} is ${String(now[k])} where the recording had ${String(was[k])}`;
  return null;
}

export async function replay(record: unknown, opts: ReplayOptions = {}): Promise<ReplayReport> {
  if (!isReplayRecord(record)) throw new Error(`Not a replay record (kind ${REPLAY_KIND}, version ${REPLAY_VERSION}).`);
  const session = opts.make ? opts.make() : new Session(opts.session);
  const steps: ReplayStep[] = [];
  let n = 0;
  const call = (op: string, args?: Record<string, unknown>, extra: { timeoutMs?: number; expectWindow?: number } = {}) => session.call({ v: 1, id: `replay-${++n}`, op, ...(args ? { args } : {}), ...extra });
  const report = (ok: boolean): ReplayReport => ({ ok, steps, divergence: steps.find((s) => s.status === 'diverged') ?? null, session });
  const diverge = (e: JournalEntry, reason: string, reply?: Reply, unreplayable = false) => {
    steps.push({ seq: e.seq, op: e.op, status: 'diverged', reason, ...(reply ? { reply } : {}), ...(unreplayable ? { unreplayable: true as const } : {}) });
    return report(false);
  };

  if (!record.complete) {
    steps.push({ seq: 0, op: 'session.start', status: 'diverged', reason: `the record lost its first ${record.dropped} steps for space; it cannot be replayed from the start` });
    return report(false);
  }
  const started = await call('session.start', { fixture: record.scenario.fixture, provider: record.scenario.provider, ...opts.start }, { timeoutMs: 240_000 });
  if (!started.ok) {
    steps.push({ seq: 0, op: 'session.start', status: 'diverged', reason: `the fresh session did not start: ${started.error.code} ${started.error.message}`, reply: started });
    return report(false);
  }
  /** The window generation the recording had moved on to: each new one is acknowledged as the recording did. */
  let window = 1;
  /** The window a step runs against: the one the recording's step did, or none for a step taken with no window. */
  const on = (e: JournalEntry) => (e.window === null ? {} : { expectWindow: window });

  /** Find a recorded target again: wait for it to be there, then look it up as the one element it must be. */
  const resolve = async (e: JournalEntry, d: TargetDescriptor): Promise<{ ref: string } | Reply> => {
    // A long name cut short on its way to the record is found by what was kept of it; a region cut short is left out,
    // and the name and scope tell the element apart.
    const query = {
      role: d.role,
      ...(d.name !== undefined ? { name: clipped(d.name) ? d.name.slice(0, -1) : d.name } : {}),
      ...(d.exact === false || clipped(d.name) ? { exact: false } : {}),
      ...(d.region && !clipped(d.region) ? { region: d.region } : {}),
      ...(d.scope ? { scope: d.scope } : {})
    };
    const there = await call('wait.for', { condition: 'ui.present', ...query }, { timeoutMs: opts.findMs ?? 15_000, ...on(e) });
    if (!there.ok) return there;
    const located = await call('ui.locate', query, on(e));
    if (!located.ok) return located;
    const node = (located.result as { node: { ref: string; name?: string } }).node;
    // Found by part of a name cut short: the one found must begin with that part, not merely hold it.
    // Both may be cut short (the name shown stops at 200 characters), so either may be the start of the other.
    const kept = clipped(d.name) ? d.name.slice(0, -1) : '';
    const shown = (node.name ?? '').replace(/…$/, '');
    if (clipped(d.name) && !(shown.startsWith(kept) || (shown.length >= SNAPSHOT_NAME_CHARS - 1 && kept.startsWith(shown)))) {
      const { v, id, op, sessionId, window: w, elapsedMs, events } = located;
      return { v, id, op, ok: false, sessionId, window: w, elapsedMs, events, error: { code: 'TARGET_NOT_FOUND', message: `The ${d.role} found does not begin with the part of its name the record kept.`, retryable: false } };
    }
    return { ref: node.ref };
  };

  for (const e of [...record.steps].sort((a, b) => a.seq - b.seq)) {
    if (opts.through !== undefined && e.seq > opts.through) break;
    const skip = (reason: string) => void steps.push({ seq: e.seq, op: e.op, status: 'skipped', reason });
    if (e.class === 'session') {
      skip('the session is managed by the replay');
      continue;
    }
    if (e.window && e.window > window) window = e.window;
    if (!e.outcome) {
      if (e.class === 'observation') skip('it never finished in the recording');
      else return diverge(e, 'the recording does not say how it ended');
      continue;
    }
    const repeated = e.class !== 'observation' || REPEATED.has(e.op);
    if (!repeated) {
      skip('an observation that only looked');
      continue;
    }
    if (!e.outcome.ok && e.class !== 'observation') {
      // An input refused before anything was sent changed nothing; one that may have sent something cannot be repeated.
      if (e.outcome.dispatched === 'none' || (e.outcome.code && REFUSED_BEFORE_INPUT.has(e.outcome.code) && e.outcome.dispatched !== 'partial')) {
        skip(`it was refused before anything was sent (${e.outcome.code})`);
        continue;
      }
      return diverge(e, `it failed in the recording (${e.outcome.code}) after it may have sent input`);
    }
    // The session marks a step whose arguments it scrubbed or hid: what it holds is not what was sent.
    if (e.unreplayable) return diverge(e, `it cannot be replayed: ${e.unreplayable}`, undefined, true);
    const args: Record<string, unknown> = { ...(e.args ?? {}) };
    if (e.class === 'input') {
      for (const d of e.targets ?? []) {
        if (!d.replayable) return diverge(e, `its ${d.at} cannot be found again: ${d.reason ?? 'no description'}`, undefined, true);
        const got = await resolve(e, d);
        if ('ok' in got) return diverge(e, `its ${d.at} (${d.role}${d.name !== undefined ? ` "${d.name}"` : ''}${d.region ? ` in "${d.region}"` : ''}) was not found as one element`, got);
        args[d.at] = { ref: got.ref, ...(d.position ? { position: d.position } : {}) };
      }
    }
    const send = (timeoutMs = e.timeoutMs) => call(e.op, Object.keys(args).length ? args : undefined, { ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...on(e) });
    const began = Date.now();
    let reply = await send();
    // A target still moving when the pointer arrived (a dialog settling) was not pressed, scrolled or dragged: at most the
    // pointer moved onto it, which can start what hovering starts. A person aims again; so does the replay, a few times
    // within one budget, once it has had a moment to settle. Every other refusal stands.
    for (
      let again = 0;
      again < UNSTABLE_RETRIES && e.class === 'input' && !reply.ok && reply.error.code === 'NOT_ACTIONABLE' && reply.error.details?.reason === 'unstable' && Date.now() - began + UNSTABLE_SETTLE_MS < UNSTABLE_BUDGET_MS;
      again++
    ) {
      await new Promise((r) => setTimeout(r, UNSTABLE_SETTLE_MS));
      // Each resend gets what is left of the budget, not the step's whole deadline again.
      reply = await send(Math.max(1000, UNSTABLE_BUDGET_MS - (Date.now() - began)));
    }
    // The recording moved to a newer window first: that one is now the window to use.
    if (!reply.ok && reply.error.code === 'WINDOW_REPLACED' && typeof reply.error.details?.to === 'number' && e.window !== null) {
      window = reply.error.details.to;
      reply = await send();
    }
    if (!e.outcome.ok) {
      // A check or wait that failed in the recording (a control that was not there) fails the same way, or the run is not the same.
      if (reply.ok) return diverge(e, `it succeeded where the recording failed with ${e.outcome.code}`, reply);
      if (reply.error.code !== e.outcome.code) return diverge(e, `it failed with ${reply.error.code} where the recording failed with ${e.outcome.code}`, reply);
      steps.push({ seq: e.seq, op: e.op, status: 'replayed', reply });
      continue;
    }
    if (!reply.ok) return diverge(e, `it failed: ${reply.error.code} ${reply.error.message}`, reply);
    // A summary read while the app is still writing what the recording had already seen (a project still opening, a
    // save still landing) is read again for a little while before it counts as different.
    for (let again = 0; e.op === 'project.summary' && differs(e, reply) && again < 10; again++) {
      await new Promise((r) => setTimeout(r, 300));
      reply = await send();
    }
    const different = differs(e, reply);
    if (different) return diverge(e, different, reply);
    // An untargeted key reaches what it reached in the recording.
    const recorded = e.outcome.summary?.target as { role?: string; name?: string } | undefined;
    const reached = (reply.result as { target?: { role?: string; name?: string } } | null)?.target;
    if (e.class === 'input' && !(e.targets ?? []).length && recorded && reached && (recorded.role !== reached.role || recorded.name !== reached.name))
      return diverge(e, `it reached ${reached.role ?? '?'} "${reached.name ?? ''}" where the recording reached ${recorded.role ?? '?'} "${recorded.name ?? ''}"`, reply);
    steps.push({ seq: e.seq, op: e.op, status: 'replayed', reply });
  }
  return report(true);
}
