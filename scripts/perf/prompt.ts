/**
 * What each model turn of an AI run sends, and how much of it a provider can serve from its prompt cache
 * (scripts/perf/README.md, "Prompts"): `npm run perf:prompt -- [--fixture small,large] [--iterations 3] [--out file]
 * [--app <checkout>]`.
 *
 * Every model turn of a run sends the whole prompt again (the tools, the instructions and the conversation so far), and
 * what a provider does not have to process afresh is what it reads from its cache. That is only visible in what the
 * provider receives, which the built app sends to a provider's own address and nowhere else, so this measures the run
 * in-process instead: the orchestrator, the project session and the provider adapters (with their SDKs, serializing
 * each request exactly as they do in the app) run on the fixture's project, against scripted servers answered through
 * the adapters' `fetch`. No network, no live provider. The Messages server applies Anthropic's prompt caching rule
 * (prompt-cache.ts) to every request; the Responses server records what each request has in common with the one before
 * it, which OpenAI's automatic cache can reuse.
 *
 * The run is a site request of ten model turns, the same for both providers: read the project, read the home page,
 * change the hero's heading, read the home page again, change the brand color, add a page, build a new component (the
 * one step that changes a tool on offer: the page tool can place it from then on), read the project's components,
 * validate, and finish. Each iteration starts from a fresh copy of the fixture's project.
 *
 * Checks, every iteration: the run asked for each scripted turn and ended completed with the scripted summary, every tool
 * call it made succeeded, and the project holds each change (four revisions: the heading, the brand color, the new page
 * and the component). A case with a failed iteration has no metrics.
 *
 * `--app <checkout>` runs that checkout's copy of this script in that checkout, so its own source is measured: the way to
 * measure the branch point beside the working tree.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { AiEvent, ChatContext, ChatMessage } from '../../src/shared/api';
import type { AgentModelAdapter } from '../../src/agent/types';
import type { ProjectState } from '../../src/shared/types';
import { FIXTURES, fixtureHash, fixtureState, ROOT, type FixtureName } from './fixtures';
import { changedParts, commonPrefix, PromptCache, renderMessages, renderResponses, type RenderedRequest, type Served } from './prompt-cache';
import { loadBundledPacks } from '../../src/main/packs/installed';
import { caseTable, median, summarizeCase, type CaseResult, type Iteration, type Measured, type RunResult } from './results';

const { values } = parseArgs({
  options: {
    fixture: { type: 'string', default: 'small,large' },
    iterations: { type: 'string', default: '3' },
    out: { type: 'string' },
    app: { type: 'string' }
  }
});

const HEADING = 'Calm, practical rooms, start to finish';
const BRAND = '#1f4e79';
const SLUG = 'studio-visits';
const COMPONENT = 'Promo band';
const SUMMARY = 'Changed the hero heading and brand color, added a Studio visits page and a Promo band component.';
const MODELS = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-6.2-sol' } as const;
type Provider = keyof typeof MODELS;

/** One scripted model turn: a sentence, and the tool it calls (none on the last). */
interface ScriptTurn {
  text: string;
  tool?: { name: string; args: Record<string, unknown> };
}

/** The home page's first section with a text heading: the hero the run changes. */
function heroOf(state: ProjectState): string {
  const page = state.pages[state.site.homePageId];
  const id = page.rootIds.find((n) => typeof (page.nodes[n] as { props?: { heading?: unknown } })?.props?.heading === 'string');
  if (!id) throw new Error('The fixture has no hero with a heading on its home page.');
  return id;
}

function script(state: ProjectState): ScriptTurn[] {
  const home = state.site.homePageId;
  const hero = heroOf(state);
  return [
    { text: 'Reading the project.', tool: { name: 'read_project', args: {} } },
    { text: 'Reading the home page.', tool: { name: 'read_page', args: { pageId: home } } },
    { text: 'Changing the hero heading.', tool: { name: 'apply_operations', args: { expectedRevision: 0, scope: { kind: 'site', targetIds: [] }, operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: home }, nodeId: hero, prop: 'heading', value: HEADING }] } } },
    { text: 'Checking the home page.', tool: { name: 'read_page', args: { pageId: home } } },
    { text: 'Changing the brand color.', tool: { name: 'update_site_brand', args: { brandColor: BRAND } } },
    { text: 'Adding the Studio visits page.', tool: { name: 'upsert_page_with_sections', args: { slug: SLUG, title: 'Studio visits', sections: [{ componentId: 'hero.split' }, { componentId: 'features.grid' }, { componentId: 'cta.banner' }], addToHeaderNav: true } } },
    {
      text: 'Building the promo band.',
      tool: {
        name: 'upsert_managed_component',
        args: { name: COMPONENT, properties: [{ type: 'string', name: 'heading', label: 'Heading', default: 'Book a studio visit' }], nodes: [{ kind: 'element', id: 'root', tag: 'section', children: ['h'] }, { kind: 'text', id: 'h', tag: 'h2', text: { $prop: 'heading' } }] }
      }
    },
    { text: 'Reading the components.', tool: { name: 'read_project', args: { sections: ['components'] } } },
    { text: 'Validating.', tool: { name: 'validate_project', args: {} } },
    { text: SUMMARY }
  ];
}

// ---------------------------------------------------------------------------
// Scripted servers
// ---------------------------------------------------------------------------

interface Sent {
  /** performance.now() when the request reached the server. */
  at: number;
  body: Record<string, unknown>;
  rendered: RenderedRequest;
  served?: Served;
}

const sse = (events: Array<{ event?: string; data: unknown }>) =>
  new Response(events.map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

/** Tokens for a usage report, at about four bytes each: what the app records, never what is measured. */
const tokens = (bytes: number) => Math.round(bytes / 4);

async function bodyOf(input: string | URL | Request, init?: RequestInit): Promise<Record<string, unknown>> {
  const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
  return raw ? (JSON.parse(String(raw)) as Record<string, unknown>) : {};
}

function messagesServer(turns: ScriptTurn[], sent: Sent[]): typeof fetch {
  const cache = new PromptCache();
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const at = performance.now();
    const body = await bodyOf(input, init);
    const rendered = renderMessages(body);
    const served = cache.serve(rendered);
    sent.push({ at, body, rendered, served });
    const k = sent.length;
    const turn = turns[k - 1] ?? { text: 'Done.' };
    const usage = { input_tokens: tokens(served.uncached), cache_creation_input_tokens: tokens(served.write), cache_read_input_tokens: tokens(served.read), output_tokens: 1 };
    const blocks: Array<{ type: string; [k: string]: unknown }> = [{ type: 'text', text: turn.text }, ...(turn.tool ? [{ type: 'tool_use', id: `toolu_bench_${k}`, name: turn.tool.name, input: turn.tool.args }] : [])];
    const events: Array<{ event?: string; data: unknown }> = [{ event: 'message_start', data: { type: 'message_start', message: { id: `msg_bench_${k}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } } }];
    blocks.forEach((b, index) => {
      if (b.type === 'text') {
        events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
        events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } } });
      } else {
        events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } } });
        events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } } });
      }
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
    });
    events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: turn.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } } });
    events.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return sse(events);
  }) as typeof fetch;
}

function responsesServer(turns: ScriptTurn[], sent: Sent[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const at = performance.now();
    const body = await bodyOf(input, init);
    const rendered = renderResponses(body);
    const prev = sent.at(-1)?.rendered ?? null;
    sent.push({ at, body, rendered });
    const k = sent.length;
    const turn = turns[k - 1] ?? { text: 'Done.' };
    const cached = commonPrefix(prev, rendered);
    const all = rendered.bytes.reduce((n, b) => n + b, 0);
    const output = [
      { type: 'message', id: `msg_bench_${k}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: turn.text, annotations: [] }] },
      ...(turn.tool ? [{ type: 'function_call', id: `fc_bench_${k}`, call_id: `call_bench_${k}`, name: turn.tool.name, arguments: JSON.stringify(turn.tool.args), status: 'completed' }] : [])
    ];
    const usage = { input_tokens: tokens(all), input_tokens_details: { cached_tokens: tokens(cached) }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: tokens(all) + 40 };
    return sse([
      { event: 'response.created', data: { type: 'response.created', response: { id: `resp_bench_${k}`, status: 'in_progress', output: [] } } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: turn.text, item_id: `msg_bench_${k}`, output_index: 0, content_index: 0 } },
      { event: 'response.completed', data: { type: 'response.completed', response: { id: `resp_bench_${k}`, status: 'completed', output, usage } } }
    ]);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

class Failed extends Error {}
const expect = (ok: unknown, message: string): void => {
  if (!ok) throw new Failed(message);
};

/** Every tool result the last request carried, as the model reads it. */
function toolResults(provider: Provider, body: Record<string, unknown>): Array<{ ok?: unknown }> {
  const parse = (s: unknown) => {
    try {
      return JSON.parse(String(s)) as { ok?: unknown };
    } catch {
      return {};
    }
  };
  if (provider === 'anthropic')
    return ((body.messages as Array<{ content: unknown }>) ?? []).flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; content?: unknown }>).filter((b) => b.type === 'tool_result').map((b) => parse(b.content)) : []));
  return ((body.input as Array<{ type?: string; output?: unknown }>) ?? []).filter((i) => i.type === 'function_call_output').map((i) => parse(i.output));
}

async function runOnce(provider: Provider, fixture: FixtureName, base: { state: ProjectState; files: Map<string, Buffer> }): Promise<Record<string, Measured>> {
  const { ProjectSession } = await import('../../src/main/project/session');
  const { Orchestrator } = await import('../../src/agent/orchestrator');
  const dir = mkdtempSync(join(tmpdir(), `so-perf-prompt-${fixture}-`));
  try {
    for (const [path, bytes] of base.files) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), bytes);
    }
    const session = await ProjectSession.create(dir, structuredClone(base.state));
    const turns = script(session.state);
    const sent: Sent[] = [];
    let adapter: AgentModelAdapter;
    if (provider === 'anthropic') {
      const { AnthropicAdapter } = await import('../../src/agent/anthropic');
      adapter = new AnthropicAdapter('sk-ant-bench', MODELS.anthropic, { fetch: messagesServer(turns, sent) });
    } else {
      const { OpenAIAdapter } = await import('../../src/agent/openai');
      adapter = new OpenAIAdapter('sk-bench', MODELS.openai, { fetch: responsesServer(turns, sent) });
    }
    /** When each tool call finished: the run reports its step done or failed as it ends. */
    const toolEnds: number[] = [];
    const seen = new Map<string, string>();
    let result: ChatMessage['result'] | undefined;
    let busy = false;
    const orch = new Orchestrator({
      session: () => session,
      adapter: async () => ({ adapter, model: MODELS[provider], provider }),
      emit: (e: AiEvent) => {
        for (const a of e.message?.activities ?? []) {
          if (a.status !== 'running' && seen.get(a.id) === 'running') toolEnds.push(performance.now());
          seen.set(a.id, a.status);
        }
        if (e.message?.result) result = e.message.result;
      },
      compileAll: async () => [],
      inspectLayout: async () => ({ issues: [] }),
      onBusyChange: (b: boolean) => (busy = b),
      codeEnabled: async () => false
    } as ConstructorParameters<typeof Orchestrator>[0]);
    const home = session.state.site.homePageId;
    const ctx: ChatContext = { pageId: home, pageTitle: session.state.pages[home].title, selection: null, selectionLabel: null, viewport: 1280 };
    const started = await orch.send('Change the hero heading and the brand color, add a Studio visits page, and build a promo band component.', ctx);
    expect(started.ok, `the request did not start: ${JSON.stringify(started)}`);
    const deadline = Date.now() + 120_000;
    while (orch.busy || busy) {
      expect(Date.now() < deadline, 'the run did not end within two minutes');
      await new Promise((r) => setTimeout(r, 5));
    }
    // The run did its job: every scripted turn asked for, every call succeeded, every change in the project.
    expect(sent.length === turns.length, `the run asked for ${sent.length} model turns, not ${turns.length}`);
    expect(result?.status === 'completed' && result.summary.includes(SUMMARY), `the run ended ${result?.status ?? 'without a result'}: ${result?.summary ?? ''}`);
    const results = toolResults(provider, sent.at(-1)!.body);
    expect(results.length === turns.length - 1, `the last request carried ${results.length} tool results, not ${turns.length - 1}`);
    expect(
      results.every((r) => r.ok === true),
      `a tool call failed: ${JSON.stringify(results.find((r) => r.ok !== true))}`
    );
    const state = session.state;
    expect(session.revision === 4, `the run left the project at revision ${session.revision}, not 4`);
    expect((state.pages[home].nodes[heroOf(state)] as { props: { heading?: unknown } }).props.heading === HEADING, 'the hero does not hold the new heading');
    expect(JSON.stringify(state.tokens).toLowerCase().includes(BRAND), 'the project does not hold the new brand color');
    expect(Object.values(state.pages).some((p) => p.route === `/${SLUG}/`), 'the project has no Studio visits page');
    expect(Object.values(state.components).some((d) => d.owner === 'project' && d.name === COMPONENT), 'the project has no Promo band component');
    await session.close();

    const m: Record<string, Measured> = {};
    const count = (name: string, value: number) => (m[name] = { unit: 'count', value });
    const bytes = (name: string, value: number) => (m[name] = { unit: 'bytes', value });
    const ms = (name: string, value: number) => (m[name] = { unit: 'ms', value });
    const size = (r: RenderedRequest) => r.bytes.reduce((n, b) => n + b, 0);
    count('turns', sent.length);
    bytes('promptBytes', sent.reduce((n, s) => n + size(s.rendered), 0));
    bytes('firstPrompt', size(sent[0].rendered));
    bytes('lastPrompt', size(sent.at(-1)!.rendered));
    // What any prefix cache could reuse, turn on turn, and which parts of the prompt moved under it.
    bytes('reusableBytes', sent.reduce((n, s, i) => n + commonPrefix(sent[i - 1]?.rendered ?? null, s.rendered), 0));
    const changes = sent.slice(1).map((s, i) => changedParts(sent[i].rendered, s.rendered));
    count('toolsChanged', changes.filter((c) => c.tools).length);
    count('systemChanged', changes.filter((c) => c.system).length);
    count('historyRewritten', changes.filter((c) => c.history).length);
    count('markers', Math.max(...sent.map((s) => s.rendered.markers)));
    if (provider === 'anthropic') {
      const sum = (f: (s: Served) => number) => sent.reduce((n, s) => n + f(s.served!), 0);
      bytes('cacheRead', sum((s) => s.read));
      bytes('cacheWrite', sum((s) => s.write));
      bytes('uncached', sum((s) => s.uncached));
      // Processed by the provider rather than read from its cache: written to it, or not kept at all.
      bytes('freshBytes', sum((s) => s.write + s.uncached));
      sent.forEach((s, i) => {
        const k = String(i + 1).padStart(2, '0');
        bytes(`turn${k}.cacheRead`, s.served!.read);
        bytes(`turn${k}.fresh`, s.served!.write + s.served!.uncached);
      });
    }
    // What the run's record says came from the provider's cache, as the app reads the usage it was given.
    const usage = (result?.usage ?? {}) as { cachedInputTokens?: number };
    count('recordedCachedTokens', usage.cachedInputTokens ?? 0);
    // From the end of each turn's last tool call to the next request reaching the server: the run preparing it.
    const prep = sent.slice(1).map((s) => s.at - Math.max(...toolEnds.filter((t) => t <= s.at)));
    expect(prep.every((p) => Number.isFinite(p) && p >= 0), 'a request reached the server before any tool call of its turn had ended');
    ms('prepMs', median(prep));
    ms('prepMsMax', Math.max(...prep));
    ms('prepMsTotal', prep.reduce((n, p) => n + p, 0));
    return m;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function main() {
  const out = resolve(values.out ?? join(ROOT, '.tmp/perf/results', `prompt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  if (values.app && resolve(values.app) !== ROOT) {
    // That checkout's own copy of this script, so its own source is what runs.
    const app = resolve(values.app);
    const r = spawnSync('npx', ['tsx', '--tsconfig', join(app, 'tsconfig.node.json'), join(app, 'scripts/perf/prompt.ts'), '--fixture', values.fixture!, '--iterations', values.iterations!, '--out', out], { cwd: app, stdio: 'inherit' });
    process.exit(r.status ?? 2);
  }
  // The theme releases committed in resources/, as the app loads them at startup.
  await loadBundledPacks(ROOT);
  const fixtures = values.fixture!.split(',').map((f) => f.trim()) as FixtureName[];
  for (const f of fixtures) if (!FIXTURES[f]) throw new Error(`Unknown fixture ${f}.`);
  const iterations = Math.max(1, Number(values.iterations));
  const cases: CaseResult[] = [];
  for (const fixture of fixtures) {
    const base = fixtureState(FIXTURES[fixture]);
    const hash = fixtureHash(base.state, base.files);
    for (const provider of Object.keys(MODELS) as Provider[]) {
      // One untimed run first, as the app has run its code before a person's second request.
      await runOnce(provider, fixture, base).catch(() => undefined);
      const its: Iteration[] = [];
      for (let i = 1; i <= iterations; i++) {
        try {
          its.push({ index: i, ok: true, trace: '', metrics: await runOnce(provider, fixture, base) });
          console.log(`perf: prompt.${provider} ${fixture} #${i}: ok`);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          its.push({ index: i, ok: false, trace: '', error: { stage: e instanceof Failed ? 'check' : 'run', message } });
          console.log(`perf: prompt.${provider} ${fixture} #${i}: FAILED (${message})`);
        }
      }
      const metrics = summarizeCase(its);
      cases.push({ scenario: `prompt.${provider}`, fixture, fixtureHash: hash, status: metrics ? 'passed' : 'failed', iterations: its, ...(metrics ? { metrics } : {}) });
    }
  }
  const head = git(['rev-parse', 'HEAD'], ROOT);
  const dirty = git(['status', '--porcelain', '--', 'src', 'scripts/perf'], ROOT);
  const result: RunResult = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    // Run from source, not a build: the commit is the checkout's, and the fingerprint its source tree's.
    build: { commit: head ? head.slice(0, 12) : null, builtAt: null, fingerprint: createHash('sha256').update(git(['rev-parse', 'HEAD:src'], ROOT) ?? '').update(dirty ?? '').digest('hex').slice(0, 16), head, dirty: dirty === null ? null : dirty !== '', appDir: ROOT, counters: null },
    machine: { platform: platform(), arch: arch(), osRelease: release(), cpu: cpus()[0]?.model ?? null, cores: cpus().length, memoryGiB: Math.round(totalmem() / 2 ** 30), node: process.versions.node, electron: null },
    config: { iterations, scenarios: ['prompt.anthropic', 'prompt.openai'], fixtures, settleMs: 0 },
    cases
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.partial`, JSON.stringify(result, null, 2) + '\n');
  renameSync(`${out}.partial`, out);
  console.log('\n' + cases.map(caseTable).join('\n\n'));
  console.log(`\nperf: result in ${relative(ROOT, out)}`);
  process.exitCode = cases.some((c) => c.status === 'failed') ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
