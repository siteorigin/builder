/**
 * Headless agent benchmark.
 *
 *   npm run eval:agent                     Free: replays the scripted fake adapter.
 *   npm run eval:agent -- --list           List the case IDs.
 *   npm run eval:agent -- --cases a,b      Run some cases.
 *   npm run eval:agent -- --out r.json     Where to write the JSON report (default .tmp/eval/).
 *   npm run eval:agent -- --trace t.jsonl  Also save each run's prompt, tool calls and outcome.
 *
 * Real providers cost money and run only with --live. Without --yes that prints the estimated cost and stops:
 *   npm run eval:agent -- --live --provider openai --model gpt-6.2-sol [--yes]
 * Keys come from OPENAI_API_KEY / ANTHROPIC_API_KEY. --input-price and --output-price (USD per million tokens)
 * set the prices the estimate assumes.
 *
 * A model on this computer is free, needs no key and runs without --yes:
 *   npm run eval:agent -- --live --provider local [--base-url http://127.0.0.1:8080/v1] [--model id]
 * Without --model it uses the first model the loopback server lists. --tool-mode auto|native|constrained-json
 * overrides the model's capability profile. A server on another machine is never queried for its models:
 *   npm run eval:agent -- --live --provider local --base-url http://host:8080/v1 --model id --allow-remote --yes
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { AgentModelAdapter } from '@agent/types';
import { AnthropicAdapter } from '@agent/anthropic';
import { OpenAIAdapter } from '@agent/openai';
import { EVAL_CASES, SUITE_VERSION } from './eval/cases';
import { resolveLocalRun } from './eval/local';
import { estimateCostUsd, runSuite, ScriptedAdapter, tracesToJsonl, type EvalCase, type EvalReport, type RunOptions } from './eval/harness';

const ASSUMED_PRICES = { inputPerMillion: 5, outputPerMillion: 25 };

const scripted: RunOptions = { adapterName: 'scripted-fake', model: 'scripted', adapter: (c, state) => new ScriptedAdapter(c.script(state)) };

function liveAdapter(provider: string, model: string, baseURL?: string): () => AgentModelAdapter {
  const opts = baseURL ? { baseURL } : {};
  if (provider === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('Set OPENAI_API_KEY to run against OpenAI.');
    return () => new OpenAIAdapter(key, model, opts);
  }
  if (provider === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('Set ANTHROPIC_API_KEY to run against Anthropic.');
    return () => new AnthropicAdapter(key, model, opts);
  }
  throw new Error(`Unknown provider "${provider}". Use openai, anthropic or local.`);
}

function printSummary(report: EvalReport) {
  const s = report.summary;
  console.log(`\n${report.adapter.name} (${report.adapter.model}): ${s.passed}/${s.cases} passed (${Math.round(s.passRate * 100)}%), mean score ${s.meanScore.toFixed(2)}`);
  console.log(`turns ${s.turns} · tool calls ${s.toolCalls} · tokens ${s.inputTokens} in / ${s.outputTokens} out · ${(s.latencyMs / 1000).toFixed(1)}s`);
  console.log(`invalid ops ${s.invalidOps} · scope violations ${s.scopeViolations} · validate clean ${s.validateClean}/${s.cases} · compile clean ${s.compileClean}/${s.cases}`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      list: { type: 'boolean' },
      cases: { type: 'string' },
      out: { type: 'string' },
      trace: { type: 'string' },
      live: { type: 'boolean' },
      yes: { type: 'boolean' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
      'tool-mode': { type: 'string' },
      'allow-remote': { type: 'boolean' },
      'input-price': { type: 'string' },
      'output-price': { type: 'string' }
    }
  });
  if (values.list) {
    for (const c of EVAL_CASES) console.log(`${c.id}@${c.version}\t${c.category}\t${c.prompt}`);
    return 0;
  }
  let cases: EvalCase[] = EVAL_CASES;
  if (values.cases) {
    const wanted = values.cases.split(',').map((s) => s.trim());
    const unknown = wanted.filter((id) => !EVAL_CASES.some((c) => c.id === id));
    if (unknown.length) throw new Error(`Unknown case: ${unknown.join(', ')}. Use --list.`);
    cases = EVAL_CASES.filter((c) => wanted.includes(c.id));
  }

  let options = scripted;
  let capabilities = new ScriptedAdapter([]).capabilities();
  if (values.live) {
    if (!values.provider || (values.provider !== 'local' && !values.model)) throw new Error('--live needs --provider and --model.');
    if (values.provider !== 'local' && (values['tool-mode'] !== undefined || values['allow-remote'])) throw new Error('--tool-mode and --allow-remote apply only to --provider local.');
    const local = values.provider === 'local' ? await resolveLocalRun({ baseURL: values['base-url'], model: values.model, toolMode: values['tool-mode'], allowRemote: values['allow-remote'] }) : null;
    const model = local?.model ?? values.model!;
    const make = local?.make ?? liveAdapter(values.provider, model, values['base-url']);
    // A model on this computer costs nothing and sends nothing anywhere, so there is nothing to confirm.
    if (!local || local.remote) {
      const prices = { inputPerMillion: Number(values['input-price'] ?? ASSUMED_PRICES.inputPerMillion), outputPerMillion: Number(values['output-price'] ?? ASSUMED_PRICES.outputPerMillion) };
      if (!Number.isFinite(prices.inputPerMillion) || !Number.isFinite(prices.outputPerMillion)) throw new Error('Prices must be numbers.');
      // The free scripted run measures how large these cases are.
      const dry = await runSuite(cases, scripted, capabilities);
      const usd = estimateCostUsd(dry.report.summary, prices);
      console.warn(`\nWARNING: this calls ${values.provider} ${model} for ${cases.length} cases and ${local ? 'sends project content to another machine, which may cost money' : 'costs real money'}.`);
      console.warn(`Estimated cost: about $${usd.toFixed(2)} (at an assumed $${prices.inputPerMillion}/M input, $${prices.outputPerMillion}/M output, with a 3x margin for extra turns). Not a quote.`);
      if (!values.yes) {
        console.warn('Nothing was sent. Add --yes to run it.');
        return 2;
      }
    }
    options = { adapterName: values.provider, model, adapter: make };
    capabilities = make().capabilities();
  }

  const { report, traces } = await runSuite(
    cases,
    { ...options, onCase: (r) => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  (${r.turns} turns, ${r.toolCalls} calls, ${r.status})${r.pass ? '' : `  ${r.checks.filter((x) => !x.pass).map((x) => x.id).join(', ')}`}`) },
    capabilities
  );
  printSummary(report);

  const out = resolve(values.out ?? join('.tmp', 'eval', `agent-${report.generatedAt.replace(/[:.]/g, '-')}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ suiteVersion: SUITE_VERSION, ...report }, null, 2)}\n`);
  console.log(`Report: ${out}`);
  if (values.trace) {
    const file = resolve(values.trace);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, tracesToJsonl(traces));
    console.log(`Traces: ${file}`);
  }
  return report.summary.passed === report.summary.cases ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error((e as Error).message);
    process.exit(2);
  }
);
