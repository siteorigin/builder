/**
 * Headless benchmark for the assistant. Each case runs the real orchestrator, session, validation and compiler
 * against a throwaway project, with any AgentModelAdapter. No Electron. The report is plain JSON with stable
 * case IDs, so runs of different models can be compared.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiEvent, ChatContext, ChatMessage } from '@shared/api';
import type { ElementRef, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { validateState } from '@engine/validate';
import { Orchestrator } from '@agent/orchestrator';
import { estimateRequestTokens, estimateTokens } from '@agent/budget';
import type { AgentModelAdapter, CanonicalItem, CanonicalModelRequest, ModelCapabilities, ModelEvent } from '@agent/types';
import { ProjectSession } from '../../src/main/project/session';
import { compileProject } from '../../src/main/compile';

/** Bump when the report or trace shape changes. */
export const REPORT_SCHEMA_VERSION = 1;

export interface Check {
  id: string;
  pass: boolean;
  detail?: string;
}

export interface GradeContext {
  before: ProjectState;
  after: ProjectState;
  status: string;
}

export type ScriptTurn = (req: CanonicalModelRequest) => ModelEvent[];

export interface EvalCase {
  /** Stable forever: reports are compared by this ID. Change `version` when the prompt or grading changes. */
  id: string;
  version: number;
  category: 'copy' | 'brand' | 'page' | 'site' | 'code' | 'style' | 'scope';
  prompt: string;
  /** Answers to questions the assistant asks, in order. After these it is told to use its judgement. */
  answers?: string[];
  setup?(state: ProjectState): void;
  selection?(state: ProjectState): { ref: ElementRef; label: string };
  grade(ctx: GradeContext): Check[];
  /** The scripted run for the free fake adapter. It proves the harness and the case, not a model. */
  script(state: () => ProjectState): ScriptTurn[];
}

export interface TraceToolCall {
  name: string;
  arguments: string;
  result?: string;
  isError?: boolean;
}

export interface CaseResult {
  id: string;
  version: number;
  category: EvalCase['category'];
  pass: boolean;
  /** Share of graded checks that passed, 0 to 1. */
  score: number;
  status: string;
  checks: Check[];
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** The provider reported no usage, so tokens are estimated from the request size. */
  tokensEstimated: boolean;
  latencyMs: number;
  invalidOps: number;
  scopeViolations: number;
  validateClean: boolean;
  compileClean: boolean;
  validationErrors: string[];
  compileErrors: string[];
}

export interface EvalReport {
  schemaVersion: number;
  generatedAt: string;
  adapter: { name: string; model: string; capabilities: ModelCapabilities };
  summary: {
    cases: number;
    passed: number;
    passRate: number;
    meanScore: number;
    turns: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    invalidOps: number;
    scopeViolations: number;
    validateClean: number;
    compileClean: number;
  };
  cases: CaseResult[];
}

export interface CaseTrace {
  schemaVersion: number;
  caseId: string;
  caseVersion: number;
  adapter: string;
  model: string;
  prompt: string;
  turns: Array<{ text: string; toolCalls: TraceToolCall[] }>;
  outcome: Pick<CaseResult, 'pass' | 'score' | 'status' | 'checks' | 'validationErrors' | 'compileErrors'>;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/** Replays a case's scripted turns. Free and deterministic, so the harness itself can be tested. */
export class ScriptedAdapter implements AgentModelAdapter {
  constructor(private turns: ScriptTurn[], private caps: Partial<ModelCapabilities> = {}) {}
  capabilities(): ModelCapabilities {
    return { toolCalling: 'native', streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 32000, maxOutputTokens: 8000, ...this.caps };
  }
  async *streamTurn(req: CanonicalModelRequest): AsyncIterable<ModelEvent> {
    const turn = this.turns.shift();
    if (!turn) {
      yield { type: 'done', stopReason: 'end', text: 'Done.', toolCalls: [] };
      return;
    }
    yield* turn(req);
  }
}

/** Wraps any adapter and records what a run did, without changing what it sends or receives. */
class RecordingAdapter implements AgentModelAdapter {
  turns = 0;
  toolCalls = 0;
  inputTokens = 0;
  outputTokens = 0;
  tokensEstimated = false;
  invalidOps = 0;
  scopeViolations = 0;
  readonly trace: Array<{ text: string; toolCalls: TraceToolCall[] }> = [];
  private seen = new Set<CanonicalItem>();
  private byCall = new Map<string, TraceToolCall>();

  constructor(private inner: AgentModelAdapter) {}

  capabilities() {
    return this.inner.capabilities();
  }

  private observe(items: CanonicalItem[]) {
    for (const it of items) {
      if (it.kind !== 'tool_result' || this.seen.has(it)) continue;
      this.seen.add(it);
      const entry = this.byCall.get(it.callId);
      if (entry) {
        entry.result = it.content;
        entry.isError = !!it.isError;
      }
      if (!it.isError) continue;
      const code = errorCode(it.content);
      if (code === 'SCOPE_MISMATCH') this.scopeViolations++;
      else if (code === 'INVALID_ARGUMENT' || code === 'VALIDATION_FAILED') this.invalidOps++;
    }
  }

  async *streamTurn(req: CanonicalModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.observe(req.items);
    this.turns++;
    for await (const ev of this.inner.streamTurn(req, signal)) {
      if (ev.type === 'done') {
        this.toolCalls += ev.toolCalls.length;
        if (ev.usage) {
          this.inputTokens += ev.usage.inputTokens;
          this.outputTokens += ev.usage.outputTokens;
        } else {
          this.tokensEstimated = true;
          this.inputTokens += estimateRequestTokens(req.system, req.tools, req.items);
          this.outputTokens += estimateTokens(ev.text) + ev.toolCalls.reduce((n, c) => n + estimateTokens(c.arguments), 0);
        }
        const calls = ev.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments }));
        ev.toolCalls.forEach((c, i) => this.byCall.set(c.id, calls[i]));
        this.trace.push({ text: ev.text, toolCalls: calls });
      }
      yield ev;
    }
  }
}

/** The error code of a tool result, in any of the shapes tools report it. */
function errorCode(content: string): string | null {
  try {
    const v = JSON.parse(content) as { error?: string | { code?: string } };
    return typeof v.error === 'string' ? v.error : (v.error?.code ?? null);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface RunOptions {
  adapterName: string;
  model: string;
  /** Builds the adapter for one case. The fake adapter uses the case's script. */
  adapter(c: EvalCase, state: () => ProjectState): AgentModelAdapter;
  /** A run that takes longer than this is stopped and graded as it stands. */
  timeoutMs?: number;
  onCase?(result: CaseResult): void;
}

const errorsOf = (list: Array<{ severity: string; message: string }>) => list.filter((d) => d.severity === 'error').map((d) => d.message);

export async function runCase(c: EvalCase, opts: RunOptions): Promise<{ result: CaseResult; trace: CaseTrace }> {
  const dir = mkdtempSync(join(tmpdir(), 'so-eval-'));
  const state = createStarterState('business', 'Harbour Lane Studio', false);
  c.setup?.(state);
  const session = await ProjectSession.create(dir, state);
  try {
    const before = structuredClone(session.state);
    const baselineValidate = new Set(errorsOf(validateState(before)));
    const recorder = new RecordingAdapter(opts.adapter(c, () => session.state));
    const answers = [...(c.answers ?? [])];
    let last: ChatMessage | undefined;
    let asked: string | null = null;
    let busy = false;
    const orch: Orchestrator = new Orchestrator({
      session: () => session,
      adapter: async () => ({ adapter: recorder, model: opts.model, provider: 'openai' }),
      emit: (e: AiEvent) => {
        if (e.kind !== 'message' || !e.message) return;
        if (e.message.result) last = e.message;
        const q = e.message.question;
        if (q && q.answered === undefined && asked !== q.text) {
          asked = q.text;
          // The run registers its handler right after emitting the question.
          queueMicrotask(() => {
            orch.answer(e.runId, answers.shift() ?? 'Use your best judgement.');
            asked = null;
          });
        }
      },
      compileAll: () => compileProject(session.state),
      // There is no browser here: an honest "could not check", never a clean report.
      inspectLayout: async () => ({ error: 'The benchmark has no live preview.' }),
      onBusyChange: (b) => (busy = b),
      codeEnabled: async () => true
    });
    const picked = c.selection?.(session.state) ?? null;
    const ctx: ChatContext = { pageId: session.state.site.homePageId, pageTitle: 'Home', selection: picked?.ref ?? null, selectionLabel: picked?.label ?? null, viewport: 1280 };
    const started = Date.now();
    const sent = await orch.send(c.prompt, ctx);
    if (!sent.ok) throw new Error(sent.message ?? 'The run did not start.');
    const timeout = setTimeout(() => orch.stop(), opts.timeoutMs ?? 10 * 60_000);
    while (orch.busy || busy) await new Promise((r) => setTimeout(r, 5));
    clearTimeout(timeout);
    const latencyMs = Date.now() - started;

    const after = structuredClone(session.state);
    const validationErrors = errorsOf(validateState(after)).filter((m) => !baselineValidate.has(m));
    const compileErrors = errorsOf(await compileProject(after));
    const status = last?.result?.status ?? 'unknown';
    let checks: Check[];
    try {
      checks = c.grade({ before, after, status });
    } catch (e) {
      // A model can leave the project in a shape the grader did not expect; that is a failed check, not a crash.
      checks = [{ id: 'graded', pass: false, detail: (e as Error).message }];
    }
    const passed = checks.filter((x) => x.pass).length;
    const validateClean = validationErrors.length === 0;
    const compileClean = compileErrors.length === 0;
    const finished = status === 'completed' || status === 'no-changes';
    const incomplete = !!last?.result?.incomplete;
    const result: CaseResult = {
      id: c.id,
      version: c.version,
      category: c.category,
      pass: finished && !incomplete && passed === checks.length && validateClean && compileClean,
      score: checks.length ? passed / checks.length : 0,
      status: incomplete ? `${status} (incomplete)` : status,
      checks,
      turns: recorder.turns,
      toolCalls: recorder.toolCalls,
      inputTokens: recorder.inputTokens,
      outputTokens: recorder.outputTokens,
      tokensEstimated: recorder.tokensEstimated,
      latencyMs,
      invalidOps: recorder.invalidOps,
      scopeViolations: recorder.scopeViolations,
      validateClean,
      compileClean,
      validationErrors,
      compileErrors
    };
    const trace: CaseTrace = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      caseId: c.id,
      caseVersion: c.version,
      adapter: opts.adapterName,
      model: opts.model,
      prompt: c.prompt,
      turns: recorder.trace,
      outcome: { pass: result.pass, score: result.score, status: result.status, checks, validationErrors, compileErrors }
    };
    return { result, trace };
  } finally {
    await session.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

export function summarize(cases: CaseResult[]): EvalReport['summary'] {
  const sum = (f: (c: CaseResult) => number) => cases.reduce((n, c) => n + f(c), 0);
  const passed = cases.filter((c) => c.pass).length;
  return {
    cases: cases.length,
    passed,
    passRate: cases.length ? passed / cases.length : 0,
    meanScore: cases.length ? sum((c) => c.score) / cases.length : 0,
    turns: sum((c) => c.turns),
    toolCalls: sum((c) => c.toolCalls),
    inputTokens: sum((c) => c.inputTokens),
    outputTokens: sum((c) => c.outputTokens),
    latencyMs: sum((c) => c.latencyMs),
    invalidOps: sum((c) => c.invalidOps),
    scopeViolations: sum((c) => c.scopeViolations),
    validateClean: cases.filter((c) => c.validateClean).length,
    compileClean: cases.filter((c) => c.compileClean).length
  };
}

export async function runSuite(cases: EvalCase[], opts: RunOptions, capabilities: ModelCapabilities): Promise<{ report: EvalReport; traces: CaseTrace[] }> {
  const results: CaseResult[] = [];
  const traces: CaseTrace[] = [];
  for (const c of cases) {
    const { result, trace } = await runCase(c, opts);
    results.push(result);
    traces.push(trace);
    opts.onCase?.(result);
  }
  return {
    report: { schemaVersion: REPORT_SCHEMA_VERSION, generatedAt: new Date().toISOString(), adapter: { name: opts.adapterName, model: opts.model, capabilities }, summary: summarize(results), cases: results },
    traces
  };
}

/** One JSON object per line, for comparing or analysing runs later. */
export const tracesToJsonl = (traces: CaseTrace[]) => traces.map((t) => JSON.stringify(t)).join('\n') + (traces.length ? '\n' : '');

/**
 * A rough ceiling on what a live run costs, from the scripted run's token counts. Real models usually take more
 * turns than the script, hence the margin. The prices are the caller's assumption, not a provider quote.
 */
export function estimateCostUsd(summary: Pick<EvalReport['summary'], 'inputTokens' | 'outputTokens'>, prices: { inputPerMillion: number; outputPerMillion: number }, margin = 3): number {
  return ((summary.inputTokens * prices.inputPerMillion + summary.outputTokens * prices.outputPerMillion) / 1_000_000) * margin;
}
