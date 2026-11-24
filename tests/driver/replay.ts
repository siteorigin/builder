/**
 * Replay a run from its replay record (evidence.ts) in a fresh session (issue #497): the same fixture and provider
 * scenario, the same setup, every input sent again to its target found afresh by role, name and region (refs belong to
 * the session that gave them out), and the recorded waits and checks repeated, so a replay is paced by the app's own
 * state rather than by the recording's timing. Observations that only looked are not repeated.
 *
 * A replay stops at the first step it cannot repeat or that ends differently, and says which and why, with the reply.
 */
import { REPLAY_KIND, REPLAY_VERSION } from './evidence.ts';
import type { JournalEntry, ReplayRecord, TargetDescriptor } from './evidence.ts';
import type { Reply, StartArgs } from './protocol.ts';
import { Session } from './session.ts';
import type { SessionOptions } from './session.ts';

export interface ReplayOptions {
  session?: SessionOptions;
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

export function isReplayRecord(v: unknown): v is ReplayRecord {
  const r = v as Partial<ReplayRecord> | null;
  return !!r && r.kind === REPLAY_KIND && r.version === REPLAY_VERSION && Array.isArray(r.steps) && !!r.scenario;
}

/** What a check found in the recording, to compare a repeat with. */
function found(e: JournalEntry): number | undefined {
  const s = e.outcome?.summary;
  return typeof s?.found === 'number' ? s.found : undefined;
}

export async function replay(record: unknown, opts: ReplayOptions = {}): Promise<ReplayReport> {
  if (!isReplayRecord(record)) throw new Error(`Not a replay record (kind ${REPLAY_KIND}, version ${REPLAY_VERSION}).`);
  const session = new Session(opts.session);
  const steps: ReplayStep[] = [];
  let n = 0;
  const call = (op: string, args?: Record<string, unknown>, extra: { timeoutMs?: number; expectWindow?: number } = {}) => session.call({ v: 1, id: `replay-${++n}`, op, ...(args ? { args } : {}), ...extra });
  const report = (ok: boolean): ReplayReport => ({ ok, steps, divergence: steps.find((s) => s.status === 'diverged') ?? null, session });
  const diverge = (e: JournalEntry, reason: string, reply?: Reply) => {
    steps.push({ seq: e.seq, op: e.op, status: 'diverged', reason, ...(reply ? { reply } : {}) });
    return report(false);
  };

  const started = await call('session.start', { fixture: record.scenario.fixture, provider: record.scenario.provider, ...opts.start }, { timeoutMs: 240_000 });
  if (!started.ok) {
    steps.push({ seq: 0, op: 'session.start', status: 'diverged', reason: `the fresh session did not start: ${started.error.code} ${started.error.message}`, reply: started });
    return report(false);
  }
  if (!record.complete) {
    steps.push({ seq: 0, op: 'session.start', status: 'diverged', reason: `the record lost its first ${record.dropped} steps for space; it cannot be replayed from the start` });
    return report(false);
  }
  /** The window generation the recording moved on to: each new one is acknowledged as the recording did. */
  let window = 1;

  /** Find a recorded target again: wait for it to be there, then look it up as the one element it must be. */
  const resolve = async (e: JournalEntry, d: TargetDescriptor): Promise<{ ref: string } | Reply> => {
    const query = { role: d.role, ...(d.name !== undefined ? { name: d.name } : {}), ...(d.exact === false ? { exact: false } : {}), ...(d.region ? { region: d.region } : {}), ...(d.scope ? { scope: d.scope } : {}) };
    const there = await call('wait.for', { condition: 'ui.present', ...query }, { timeoutMs: opts.findMs ?? 15_000, expectWindow: window });
    if (!there.ok) return there;
    const located = await call('ui.locate', query, { expectWindow: window });
    if (!located.ok) return located;
    return { ref: (located.result as { node: { ref: string } }).node.ref };
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
    if (!e.outcome.ok) {
      // A request that failed with nothing sent changed nothing; one that sent part of its input cannot be repeated.
      if (e.class === 'input' && e.outcome.dispatched === 'partial') return diverge(e, 'it sent part of its input before it failed in the recording');
      skip(`it failed in the recording (${e.outcome.code})`);
      continue;
    }
    if (e.class === 'observation' && !REPEATED.has(e.op)) {
      skip('an observation that only looked');
      continue;
    }
    if (e.unreplayable) return diverge(e, `it cannot be replayed: ${e.unreplayable}`);
    const args: Record<string, unknown> = { ...(e.args ?? {}) };
    if (e.class === 'input') {
      for (const d of e.targets ?? []) {
        if (!d.replayable) return diverge(e, `its ${d.at} cannot be found again: ${d.reason ?? 'no description'}`);
        const got = await resolve(e, d);
        if ('ok' in got) return diverge(e, `its ${d.at} (${d.role}${d.name !== undefined ? ` "${d.name}"` : ''}${d.region ? ` in "${d.region}"` : ''}) was not found as one element`, got);
        args[d.at] = { ref: got.ref, ...(d.position ? { position: d.position } : {}) };
      }
    }
    const reply = await call(e.op, Object.keys(args).length ? args : undefined, { expectWindow: window });
    if (!reply.ok) {
      // The recording moved to a newer window first: that one is now the window to use.
      if (reply.error.code === 'WINDOW_REPLACED' && typeof reply.error.details?.to === 'number') {
        window = reply.error.details.to;
        const again = await call(e.op, Object.keys(args).length ? args : undefined, { expectWindow: window });
        if (again.ok) {
          steps.push({ seq: e.seq, op: e.op, status: 'replayed', reply: again });
          continue;
        }
        return diverge(e, `it failed: ${again.error.code} ${again.error.message}`, again);
      }
      return diverge(e, `it failed: ${reply.error.code} ${reply.error.message}`, reply);
    }
    // A check finds what it found in the recording; an untargeted key reaches what it reached.
    const was = found(e);
    if (was !== undefined) {
      const now = found({ ...e, outcome: { ok: true, summary: checkSummary(e.op, reply.result) } });
      if ((now ?? 0) > 0 !== was > 0) return diverge(e, `it found ${now ?? 0} matches where the recording found ${was}`, reply);
    }
    const recorded = e.outcome.summary?.target as { role?: string; name?: string } | undefined;
    const reached = (reply.result as { target?: { role?: string; name?: string } } | null)?.target;
    if (e.class === 'input' && !(e.targets ?? []).length && recorded && reached && (recorded.role !== reached.role || recorded.name !== reached.name))
      return diverge(e, `it reached ${reached.role ?? '?'} "${reached.name ?? ''}" where the recording reached ${recorded.role ?? '?'} "${recorded.name ?? ''}"`, reply);
    steps.push({ seq: e.seq, op: e.op, status: 'replayed', reply });
  }
  return report(true);
}

function checkSummary(op: string, result: unknown): Record<string, unknown> {
  const r = result as { project?: { find?: { matches: unknown[] } }; find?: { matches: unknown[] } } | null;
  if (op === 'project.summary' && r?.project?.find) return { found: r.project.find.matches.length };
  if (op === 'exports.inspect' && r?.find) return { found: r.find.matches.length };
  return {};
}
