import { describe, expect, it } from 'vitest';
import { EVAL_CASES, SUITE_VERSION } from '../../scripts/eval/cases';
import { estimateCostUsd, REPORT_SCHEMA_VERSION, runCase, runSuite, ScriptedAdapter, summarize, tracesToJsonl, type CaseResult, type EvalCase, type RunOptions } from '../../scripts/eval/harness';

const scripted: RunOptions = { adapterName: 'scripted-fake', model: 'scripted', adapter: (c, state) => new ScriptedAdapter(c.script(state)) };
const byId = (id: string) => EVAL_CASES.find((c) => c.id === id)!;
/** A model that answers immediately without doing anything. */
const idle: RunOptions = { adapterName: 'idle', model: 'idle', adapter: () => new ScriptedAdapter([]) };

describe('agent benchmark', () => {
  it('has around ten cases with stable, unique IDs across the promised task types', () => {
    expect(SUITE_VERSION).toBeGreaterThan(0);
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(10);
    const ids = EVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(ids).toEqual(expect.arrayContaining(['copy-edit-hero-heading', 'brand-retheme', 'add-services-page-nav', 'build-five-page-site', 'fix-broken-code-component', 'mobile-spacing-override']));
  });

  it('passes every case with its script, through the real pipeline', async () => {
    const { report } = await runSuite(EVAL_CASES, scripted, new ScriptedAdapter([]).capabilities());
    const failed = report.cases.filter((c) => !c.pass).map((c) => ({ id: c.id, status: c.status, failed: c.checks.filter((x) => !x.pass), v: c.validationErrors, c: c.compileErrors }));
    expect(failed).toEqual([]);
    expect(report.summary.passRate).toBe(1);
    expect(report.summary.scopeViolations).toBe(0);
    expect(report.summary.compileClean).toBe(EVAL_CASES.length);
    expect(report.summary.validateClean).toBe(EVAL_CASES.length);
  }, 120000);

  it('fails a model that does nothing, on every case that asks for a change', async () => {
    for (const c of EVAL_CASES) {
      const { result } = await runCase(c, idle);
      expect(result.pass, c.id).toBe(false);
      expect(result.score, c.id).toBeLessThan(1);
    }
  }, 120000);

  it('counts invalid operations and scope violations', async () => {
    const repair = await runCase(byId('faq-page-repair'), scripted);
    expect(repair.result.pass).toBe(true);
    expect(repair.result.invalidOps).toBe(1);
    // Selection-mode tools leave a model no way to reach outside; the general tools are checked by the app.
    const escaping: EvalCase = {
      ...byId('stay-in-selection'),
      script: (state) => [
        () => [{ type: 'done', stopReason: 'tool_use', text: '', toolCalls: [{ id: 'x1', name: 'apply_operations', arguments: JSON.stringify({ expectedRevision: 0, operations: [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'footer' }, nodeId: state().site.shell.footer.rootIds[0], prop: 'tagline', value: 'Quiet design' }] }) }] }],
        () => [{ type: 'done', stopReason: 'end', text: 'Could not.', toolCalls: [] }]
      ]
    };
    const wide: RunOptions = { ...scripted, adapter: (c, state) => new ScriptedAdapter(c.script(state), { contextWindowTokens: 200000 }) };
    const { result } = await runCase(escaping, wide);
    expect(result.scopeViolations).toBe(1);
    expect(result.checks.find((x) => x.id === 'footer-untouched')?.pass).toBe(true);
    expect(result.pass).toBe(false);
  }, 60000);

  it('catches a project that does not compile, whatever the checks say', async () => {
    const unfixed: EvalCase = { ...byId('fix-broken-code-component'), grade: () => [{ id: 'always', pass: true }], script: () => [] };
    const { result } = await runCase(unfixed, scripted);
    expect(result.compileClean).toBe(false);
    expect(result.compileErrors.join(' ')).toContain('Quote Card');
    expect(result.pass).toBe(false);
  }, 60000);

  it('writes a machine-readable report and one JSONL trace per case', async () => {
    const cases = [byId('copy-edit-hero-heading'), byId('brand-retheme')];
    const { report, traces } = await runSuite(cases, scripted, new ScriptedAdapter([]).capabilities());
    const parsed = JSON.parse(JSON.stringify(report));
    expect(parsed.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(parsed.adapter.name).toBe('scripted-fake');
    expect(parsed.cases.map((c: CaseResult) => `${c.id}@${c.version}`)).toEqual(['copy-edit-hero-heading@1', 'brand-retheme@1']);
    for (const key of ['pass', 'score', 'turns', 'toolCalls', 'inputTokens', 'outputTokens', 'latencyMs', 'invalidOps', 'scopeViolations', 'validateClean', 'compileClean']) expect(parsed.cases[0]).toHaveProperty(key);
    expect(parsed.cases[0].inputTokens).toBeGreaterThan(0);
    expect(parsed.cases[0].tokensEstimated).toBe(true);
    const lines = tracesToJsonl(traces).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ caseId: 'copy-edit-hero-heading', caseVersion: 1, prompt: byId('copy-edit-hero-heading').prompt, outcome: { pass: true } });
    expect(lines[0].turns[0].toolCalls[0]).toMatchObject({ name: 'update_selected_props', isError: false });
    expect(JSON.parse(lines[0].turns[0].toolCalls[0].result).ok).toBe(true);
  }, 60000);

  it('summarizes and estimates cost', () => {
    const base = { version: 1, category: 'copy', status: 'completed', checks: [], tokensEstimated: false, validationErrors: [], compileErrors: [] } as unknown as CaseResult;
    const s = summarize([
      { ...base, id: 'a', pass: true, score: 1, turns: 2, toolCalls: 1, inputTokens: 100, outputTokens: 10, latencyMs: 5, invalidOps: 0, scopeViolations: 0, validateClean: true, compileClean: true },
      { ...base, id: 'b', pass: false, score: 0.5, turns: 4, toolCalls: 3, inputTokens: 300, outputTokens: 30, latencyMs: 7, invalidOps: 2, scopeViolations: 1, validateClean: true, compileClean: false }
    ]);
    expect(s).toMatchObject({ cases: 2, passed: 1, passRate: 0.5, meanScore: 0.75, turns: 6, toolCalls: 4, inputTokens: 400, outputTokens: 40, invalidOps: 2, scopeViolations: 1, validateClean: 2, compileClean: 1 });
    expect(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, { inputPerMillion: 2, outputPerMillion: 8 }, 3)).toBe(30);
  });
});
