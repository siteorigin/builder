/**
 * Headless benchmark for the assistant. Each case runs the real orchestrator, session, validation and compiler
 * against a throwaway project, with any AgentModelAdapter. No Electron. The report is plain JSON with stable
 * case IDs, so runs of different models can be compared.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiEvent, ChatContext, ChatMessage, ProviderId } from '@shared/api';
import type { ElementRef, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { validateState } from '@engine/validate';
import { LIMITS, Orchestrator } from '@agent/orchestrator';
import { estimateRequestTokens, estimateTokens } from '@agent/budget';
import type { AgentModelAdapter, CanonicalItem, CanonicalModelRequest, ModelCapabilities, ModelEvent } from '@agent/types';
import { ProjectSession } from '../../src/main/project/session';
import { compileProject } from '../../src/main/compile';
import { registerBuiltinPacks } from '../../src/main/packs/build';
import { staticInspector } from './component-diagnostics';

registerBuiltinPacks();

/** Bump when the report or trace shape changes. */
export const REPORT_SCHEMA_VERSION = 2;

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
  category: 'copy' | 'brand' | 'page' | 'site' | 'code' | 'style' | 'scope' | 'posts' | 'component';
  prompt: string;
  /** Answers to questions the assistant asks, in order. After these it is told to use its judgement. */
  answers?: string[];
  setup?(state: ProjectState): void;
  /**
   * The route of the page the request is sent from with "This page" chosen in the composer, so the run may change only
   * that page. Without it the request comes from Home, limited to its selection when the case has one.
   */
  pageScope?: string;
  /** The post the request is sent from, open in the Posts workspace, so the run may change only that post. */
  postScope?: { collectionId: string; entryId: string };
  selection?(state: ProjectState): { ref: ElementRef; label: string };
  /** The request is sent from Create component, so the run builds a new component (`ChatContext.task`). */
  task?: 'component';
  /** The component the request is sent from while its design is edited everywhere, so the run may change only that design. */
  component?(state: ProjectState): { id: string; name: string };
  /**
   * inspect_component measures from the design alone (see component-diagnostics.ts): the benchmark has no browser.
   * Without it the tool reports that measuring is not available, as before.
   */
  measureComponents?: boolean;
  /**
   * The model the scripted run plays: a cloud model with room to spare, or a grammar-constrained local one with the
   * small tool sets. A live run is always its own adapter's profile. Without it, the fake's defaults.
   */
  scriptedProfile?: ScriptedProfile;
  grade(ctx: GradeContext): Check[];
  /** The scripted run for the free fake adapter. It proves the harness and the case, not a model. */
  script(state: () => ProjectState): ScriptTurn[];
}

export type ScriptedProfile = 'cloud' | 'constrained-json';

/** The capabilities each scripted profile declares: a wide native cloud model, and the local adapter's default profile. */
export const SCRIPTED_PROFILES: Record<ScriptedProfile, Partial<ModelCapabilities>> = {
  cloud: { toolCalling: 'native', contextWindowTokens: 200_000, maxOutputTokens: 8000, parallelToolCalls: true, strictSchemas: false },
  'constrained-json': { toolCalling: 'constrained-json', contextWindowTokens: 32_768, maxOutputTokens: 8192, parallelToolCalls: false, strictSchemas: true }
};

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
  /** How the model it ran on calls tools, and its window: a scripted run plays the case's own profile. */
  toolCalling: ModelCapabilities['toolCalling'];
  contextWindowTokens: number;
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

/** The free fake for one case: its script, as the model its profile names. */
export const scriptedAdapter = (c: EvalCase, state: () => ProjectState): ScriptedAdapter => new ScriptedAdapter(c.script(state), c.scriptedProfile ? SCRIPTED_PROFILES[c.scriptedProfile] : {});

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
          // A constrained model is sent its tools as signatures (see budget.ts), and counted that way.
          this.inputTokens += estimateRequestTokens(req.system, req.tools, req.items, this.inner.capabilities().toolCalling === 'constrained-json');
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

/** The error code of a failed tool result. */
function errorCode(content: string): string | null {
  try {
    const v = JSON.parse(content) as { ok?: boolean; error?: { code?: string } };
    return v.ok === false ? (v.error?.code ?? null) : null;
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
  /** The provider the orchestrator is told it runs, which sets its time limit. Scripted runs count as OpenAI. */
  provider?: ProviderId;
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
      adapter: async () => ({ adapter: recorder, model: opts.model, provider: opts.provider ?? 'openai' }),
      emit: (e: AiEvent) => {
        if (e.kind !== 'message' || !e.message) return;
        if (e.message.result) last = e.message;
        const q = e.message.questions?.at(-1);
        if (q?.id && q.answered === undefined && asked !== q.id) {
          const id = q.id;
          asked = id;
          queueMicrotask(() => {
            orch.answer(e.runId, id, answers.shift() ?? 'Use your best judgement.');
            asked = null;
          });
        }
      },
      compileAll: () => compileProject(session.state),
      // There is no browser here: an honest "could not check", never a clean report.
      inspectLayout: async () => ({ error: 'The benchmark has no live preview.' }),
      ...(c.measureComponents ? { inspectComponent: staticInspector(() => session.state) } : {}),
      onBusyChange: (b) => (busy = b),
      codeEnabled: async () => true
    });
    const picked = c.selection?.(session.state) ?? null;
    const scoped = c.pageScope === undefined ? undefined : Object.values(session.state.pages).find((p) => p.route === c.pageScope);
    if (c.pageScope !== undefined && !scoped) throw new Error(`No page at ${c.pageScope} to send the request from.`);
    const post = c.postScope ? session.state.collections[c.postScope.collectionId]?.entries[c.postScope.entryId] : undefined;
    if (c.postScope && !post) throw new Error(`No post ${c.postScope.collectionId}/${c.postScope.entryId} to send the request from.`);
    const component = c.component?.(session.state);
    if (component && !Object.hasOwn(session.state.components, component.id)) throw new Error(`No component ${component.name} (${component.id}) to send the request from.`);
    const homeAt = { pageId: session.state.site.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280 };
    const ctx: ChatContext = post
      ? { ...homeAt, post: { ...c.postScope!, title: post.title } }
      : c.task === 'component'
      ? // As Create component sends it: about the site, with no selection.
        { ...homeAt, mode: 'edit', task: 'component' }
      : component
      ? // As the editor sends a request while a design is edited everywhere: the whole design, nothing selected.
        { ...homeAt, mode: 'edit', component }
      : scoped
      ? { pageId: scoped.id, pageTitle: scoped.title, selection: null, selectionLabel: null, viewport: 1280, scope: 'page' }
      : { pageId: session.state.site.homePageId, pageTitle: 'Home', selection: picked?.ref ?? null, selectionLabel: picked?.label ?? null, viewport: 1280 };
    const started = Date.now();
    const sent = await orch.send(c.prompt, ctx);
    if (!sent.ok) throw new Error(sent.message ?? 'The run did not start.');
    // By default the run's own time limit ends it, with a minute to check and keep its work before this steps in.
    const timeout = setTimeout(() => orch.stop(), opts.timeoutMs ?? (opts.provider === 'local' ? LIMITS.localActiveMs : LIMITS.activeMs) + 60_000);
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
    // A partial run kept what it did but did not finish the request: never a pass, whatever the graders find.
    const finished = status === 'completed' || status === 'no-changes';
    const incomplete = !!last?.result?.incomplete;
    const caps = recorder.capabilities();
    const result: CaseResult = {
      id: c.id,
      version: c.version,
      category: c.category,
      toolCalling: caps.toolCalling,
      contextWindowTokens: caps.contextWindowTokens,
      pass: finished && !incomplete && passed === checks.length && validateClean && compileClean,
      score: checks.length ? passed / checks.length : 0,
      status: incomplete && status !== 'partial' ? `${status} (incomplete)` : status,
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
