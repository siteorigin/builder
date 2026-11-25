import { describe, expect, it } from 'vitest';
import type { InstanceNode } from '@shared/types';
import { LIMITS } from '@agent/orchestrator';
import { EVAL_CASES, SUITE_VERSION } from '../../scripts/eval/cases';
import { estimateCostUsd, REPORT_SCHEMA_VERSION, runCase, runSuite, SCRIPTED_PROFILES, ScriptedAdapter, scriptedAdapter, summarize, tracesToJsonl, type CaseResult, type EvalCase, type RunOptions } from '../../scripts/eval/harness';

const scripted: RunOptions = { adapterName: 'scripted-fake', model: 'scripted', adapter: scriptedAdapter };
const byId = (id: string) => EVAL_CASES.find((c) => c.id === id)!;
/** A model that answers immediately without doing anything, as the model each case's script plays. */
const idle: RunOptions = { adapterName: 'idle', model: 'idle', adapter: (c) => new ScriptedAdapter([], c.scriptedProfile ? SCRIPTED_PROFILES[c.scriptedProfile] : {}) };

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

  it('runs a local model under the local time limit, as the editor does', async () => {
    const cloud = LIMITS.activeMs;
    LIMITS.activeMs = 0;
    try {
      const c = byId('copy-edit-hero-heading');
      expect((await runCase(c, scripted)).result.status).toBe('failed');
      expect((await runCase(c, { ...scripted, provider: 'local' })).result).toMatchObject({ status: 'completed', pass: true });
    } finally {
      LIMITS.activeMs = cloud;
    }
  }, 60000);

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

  it('sends a pasted page draft from that page, limited to it', async () => {
    for (const [id, route, sections] of [
      // A page just made with only its introduction, and the starter's About page with its sample sections.
      ['paste-copy-onto-intro-page', '/repair-cafe/', ['intro.page']],
      ['paste-copy-onto-starter-page', '/about/', ['intro.page', 'content.media', 'team.grid', 'cta.banner']]
    ] as const) {
      const c = byId(id);
      let allowed = '';
      let target: string | undefined;
      let found: string[] = [];
      const seen: EvalCase = {
        ...c,
        script: (state) => {
          const [first, ...rest] = c.script(state);
          return [
            (req) => {
              const p = Object.values(state().pages).find((x) => x.route === route);
              target = p?.id;
              found = (p?.rootIds ?? []).map((r) => state().components[(p!.nodes[r] as InstanceNode).definitionId]?.componentId);
              if (route === '/repair-cafe/') expect((p!.nodes[p!.rootIds[0]] as InstanceNode).props).toMatchObject({ heading: p!.title, eyebrow: '', lead: '' });
              allowed = /"allowedScope": "([^"]*)"/.exec((req.items[0] as { text: string }).text)?.[1] ?? '';
              return first(req);
            },
            ...rest
          ];
        }
      };
      const { result } = await runCase(seen, scripted);
      expect(result.pass, id).toBe(true);
      expect(target, id).toBeTruthy();
      expect(allowed, id).toContain(`(page ${target})`);
      expect(found, id).toEqual(sections);
    }
    await expect(runCase({ ...byId('paste-copy-onto-starter-page'), pageScope: '/nowhere/' }, scripted)).rejects.toThrow('No page at /nowhere/');
  }, 60000);

  it('grades a pasted draft by each block in its own section, nothing else shown and the rest of the site untouched', async () => {
    const clinic = byId('paste-copy-onto-intro-page');
    const about = byId('paste-copy-onto-starter-page');
    /** The case's scripted page, changed by `edit` before it is sent. */
    const edited = (c: EvalCase, edit: (args: any) => void): EvalCase => ({
      ...c,
      script: (state) => {
        const [first, ...rest] = c.script(state);
        const send = <T extends { arguments: string }>(t: T): T => {
          const a = JSON.parse(t.arguments);
          edit(a);
          return { ...t, arguments: JSON.stringify(a) };
        };
        return [(req) => first(req).map((e) => (e.type === 'done' ? { ...e, toolCalls: e.toolCalls.map(send) } : e)), ...rest];
      }
    });
    const failing = async (c: EvalCase) => {
      const { result } = await runCase(c, scripted);
      expect(result.pass).toBe(false);
      return result.checks.filter((x) => !x.pass).map((x) => x.id);
    };
    // The placeholders left beside the copy: the title-only introduction, and the starter's story and team.
    expect(await failing(edited(clinic, (a) => delete a.removeOtherSections))).toEqual(['placeholders-removed', 'only-supplied-copy']);
    expect(await failing(edited(about, (a) => delete a.removeOtherSections))).toEqual(['placeholders-removed', 'only-supplied-copy']);
    // A section updated in place keeps the sample text it was not sent.
    expect(await failing(edited(about, (a) => delete a.sections[3].props.lead))).toContain('only-supplied-copy');
    // A figure changed, an answer left out, a button sent elsewhere.
    expect(await failing(edited(clinic, (a) => (a.sections[2].props.items[1].value = '75%')))).toContain('figures');
    expect(await failing(edited(clinic, (a) => a.sections[3].props.items.pop()))).toContain('questions');
    expect(await failing(edited(clinic, (a) => (a.sections[0].props.primaryLink = 'https://bench.example/')))).toContain('opening');
    // What belongs together pulled apart: two answers swapped, two figures swapped.
    const swap = (items: any[], field: string) => ([items[0][field], items[1][field]] = [items[1][field], items[0][field]]);
    expect(await failing(edited(clinic, (a) => swap(a.sections[3].props.items, 'answer')))).toEqual(['questions', 'reading-order']);
    expect(await failing(edited(clinic, (a) => swap(a.sections[2].props.items, 'value')))).toEqual(['figures', 'reading-order']);
    // Words the draft does not have: part of a figure, the request around the draft, a paragraph shown twice.
    expect(await failing(edited(clinic, (a) => (a.sections[0].props.eyebrow = '46')))).toEqual(['only-supplied-copy']);
    expect(await failing(edited(clinic, (a) => (a.sections[0].props.eyebrow = 'Please lay it out.')))).toEqual(['only-supplied-copy']);
    expect(await failing(edited(clinic, (a) => a.sections.splice(1, 0, { componentId: 'content.text', props: { heading: '', body: a.sections[0].props.lead } })))).toEqual(['only-supplied-copy']);
    // The button sent elsewhere, with a decoy that goes where it should; and a link the draft never had, inside text.
    const decoy = (a: any) => Object.assign(a.sections[0].props, { primaryLink: 'https://bench.example/', secondaryLabel: '146', secondaryLink: 'https://bench.example/book' });
    expect(await failing(edited(clinic, decoy))).toEqual(['opening', 'reading-order', 'only-supplied-copy', 'only-supplied-links']);
    // A second button to the same place, and a figure shown again as an eyebrow.
    expect(await failing(edited(clinic, (a) => Object.assign(a.sections[0].props, { secondaryLabel: 'Reserve a bench', secondaryLink: 'https://bench.example/book' })))).toEqual(['only-supplied-copy', 'only-supplied-links']);
    expect(await failing(edited(clinic, (a) => (a.sections[0].props.eyebrow = '146')))).toEqual(['only-supplied-copy']);
    // A figure and its label in neighbouring cards are not shown together.
    const split = (a: any) => (a.sections[2].props.items = [{ value: '146', label: '' }, { value: 'appliances assessed', label: '73%' }, { value: 'repaired on the day', label: '' }]);
    expect(await failing(edited(clinic, split))).toEqual(['figures', 'reading-order']);
    expect(await failing(edited(clinic, (a) => (a.sections[1].props.body = '- The appliance, even if it no longer switches on.\n- [Its plug, cable and any loose screws.](https://elsewhere.example/)')))).toEqual(['only-supplied-links']);
    // The introduction emptied rather than removed still sits on the page.
    expect(await failing(edited(clinic, (a) => (delete a.removeOtherSections, a.sections.unshift({ componentId: 'intro.page', props: { eyebrow: '', heading: '', lead: '' } }))))).toEqual(['placeholders-removed']);
    // Blocks out of order, and every block after the opening poured into one text section in the right order.
    expect(await failing(edited(clinic, (a) => a.sections.reverse()))).toEqual(['reading-order']);
    const poured = (a: any) => {
      const [hero, list] = a.sections;
      const rest = ['- The appliance, even if it no longer switches on.', '- Its plug, cable and any loose screws.', '', 'Last winter at the clinic', '', '146 appliances assessed', '', '73% repaired on the day', '', 'Before you visit', '', 'Can I bring a lamp?', '', 'Yes. Bring the shade separately so it travels safely.', '', 'What does it cost?', '', 'Assessment is free. We agree the price of parts with you first.'];
      a.sections = [hero, { componentId: 'content.text', props: { heading: list.props.heading, body: rest.join('\n') } }];
    };
    expect(await failing(edited(clinic, poured))).toEqual(['reading-order']);
    // A faithful layout of another shape passes: each question with its answer as one point of a text section.
    const points = (a: any) => (a.sections[3] = { componentId: 'content.text', props: { heading: 'Before you visit', body: '- Can I bring a lamp? Yes. Bring the shade separately so it travels safely.\n- What does it cost? Assessment is free. We agree the price of parts with you first.' } });
    expect((await runCase(edited(clinic, points), scripted)).result.checks.filter((x) => !x.pass)).toEqual([]);
    // A question and its answer shown again as one paragraph, beside the questions section that already has them.
    const again = (a: any) => a.sections.push({ componentId: 'content.text', props: { heading: '', body: 'Can I bring a lamp? Yes. Bring the shade separately so it travels safely.' } });
    expect(await failing(edited(clinic, again))).toEqual(['only-supplied-copy']);
    // A card's link shows another of its fields as its words: a contact row whose value is the button's label.
    const row = (a: any) =>
      (a.sections[0] = { componentId: 'contact.details', props: { eyebrow: '', heading: 'Give your kettle another winter', lead: 'Bring one broken household appliance to the Saturday repair clinic and fix it with a volunteer.', items: [{ icon: 'clock', label: '', value: 'Reserve a bench', link: 'https://bench.example/book' }], actionLabel: '' } });
    expect((await runCase(edited(clinic, row), scripted)).result.checks.filter((x) => !x.pass)).toEqual([]);
    // So does the opening as a text section whose button is a link in its words, one of them in bold.
    const bench = { type: 'url', target: 'https://bench.example/book' };
    const inText = (a: any) => (a.sections[0] = { componentId: 'content.text', props: { heading: 'Give your kettle another winter', body: [
            { type: 'p', spans: [{ text: 'Bring one broken household appliance to the Saturday repair clinic and fix it with a volunteer.' }] },
            { type: 'p', spans: [{ text: 'Reserve a ', link: bench }, { text: 'bench', strong: true, link: bench }] }
          ] } });
    expect((await runCase(edited(clinic, inText), scripted)).result.checks.filter((x) => !x.pass)).toEqual([]);
    // Another page changed, a page added and a menu link with it, which only a request allowed the whole site could do.
    const wider: EvalCase = {
      ...clinic,
      pageScope: undefined,
      script: (state) => [
        () => [
          {
            type: 'done',
            stopReason: 'tool_use',
            text: '',
            toolCalls: [
              { id: 'w1', name: 'upsert_page_with_sections', arguments: JSON.stringify({ slug: 'about', sections: [{ componentId: 'cta.banner', props: { heading: 'Changed' } }] }) },
              { id: 'w2', name: 'upsert_page_with_sections', arguments: JSON.stringify({ slug: 'extra', title: 'Extra', addToHeaderNav: true, sections: [{ componentId: 'cta.banner', props: { heading: 'Extra' } }] }) }
            ]
          }
        ],
        ...clinic.script(state)
      ]
    };
    expect(await failing(wider)).toEqual(['same-pages', 'other-pages-untouched', 'shell-untouched']);
  }, 120000);

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
