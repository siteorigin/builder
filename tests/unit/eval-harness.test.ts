import { describe, expect, it } from 'vitest';
import type { InstanceNode } from '@shared/types';
import { LIMITS } from '@agent/orchestrator';
import type { EditOperation } from '@shared/ops';
import { applyOperations } from '@engine/apply';
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
      expect(result.toolCalling, c.id).toBe(c.scriptedProfile === 'constrained-json' ? 'constrained-json' : 'native');
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
    for (const key of ['pass', 'score', 'turns', 'toolCalls', 'inputTokens', 'outputTokens', 'latencyMs', 'invalidOps', 'scopeViolations', 'validateClean', 'compileClean', 'toolCalling', 'contextWindowTokens']) expect(parsed.cases[0]).toHaveProperty(key);
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
    expect(await failing(edited(clinic, (a) => a.sections.splice(1, 0, { componentId: 'content.text', props: { eyebrow: '', heading: '', body: a.sections[0].props.lead } })))).toEqual(['only-supplied-copy']);
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
      a.sections = [hero, { componentId: 'content.text', props: { eyebrow: '', heading: list.props.heading, body: rest.join('\n') } }];
    };
    expect(await failing(edited(clinic, poured))).toEqual(['reading-order']);
    // A faithful layout of another shape passes: each question with its answer as one point of a text section.
    const points = (a: any) => (a.sections[3] = { componentId: 'content.text', props: { eyebrow: '', heading: 'Before you visit', body: '- Can I bring a lamp? Yes. Bring the shade separately so it travels safely.\n- What does it cost? Assessment is free. We agree the price of parts with you first.' } });
    expect((await runCase(edited(clinic, points), scripted)).result.checks.filter((x) => !x.pass)).toEqual([]);
    // A question and its answer shown again as one paragraph, beside the questions section that already has them.
    const again = (a: any) => a.sections.push({ componentId: 'content.text', props: { eyebrow: '', heading: '', body: 'Can I bring a lamp? Yes. Bring the shade separately so it travels safely.' } });
    expect(await failing(edited(clinic, again))).toEqual(['only-supplied-copy']);
    // A card's link shows another of its fields as its words: a contact row whose value is the button's label.
    const row = (a: any) =>
      (a.sections[0] = { componentId: 'contact.details', props: { eyebrow: '', heading: 'Give your kettle another winter', lead: 'Bring one broken household appliance to the Saturday repair clinic and fix it with a volunteer.', items: [{ icon: 'clock', label: '', value: 'Reserve a bench', link: 'https://bench.example/book' }], actionLabel: '' } });
    expect((await runCase(edited(clinic, row), scripted)).result.checks.filter((x) => !x.pass)).toEqual([]);
    // So does the opening as a text section whose button is a link in its words, one of them in bold.
    const bench = { type: 'url', target: 'https://bench.example/book' };
    const inText = (a: any) => (a.sections[0] = { componentId: 'content.text', props: { eyebrow: '', heading: 'Give your kettle another winter', body: [
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

  describe('component authoring (#365)', () => {
    const COMPONENT_CASES = ['create-workshop-notice', 'create-repeated-workshop-cards', 'add-panel-tone-axis', 'show-booking-status-conditionally', 'style-component-with-site-tokens', 'make-panel-caption-editable', 'repair-component-on-phones', 'create-and-check-on-phones'];
    /** The case with every tool call its script makes changed by `edit` (by tool name, arguments and turn) first. */
    const editCalls = (c: EvalCase, edit: (name: string, args: any, turn: number) => void): EvalCase => ({
      ...c,
      script: (state) =>
        c.script(state).map((turn, i) => (req) =>
          turn(req).map((e) =>
            e.type !== 'done'
              ? e
              : {
                  ...e,
                  toolCalls: e.toolCalls.map((t) => {
                    const a = JSON.parse(t.arguments);
                    edit(t.name, a, i);
                    return { ...t, arguments: JSON.stringify(a) };
                  })
                }
          )
        )
    });
    const failing = async (c: EvalCase) => (await runCase(c, scripted)).result.checks.filter((x) => !x.pass).map((x) => x.id);
    /** Another way of doing it passes outright: every check, and a finished, valid, compiling project. */
    const passes = async (c: EvalCase) => {
      const { result } = await runCase(c, scripted);
      expect(result.checks.filter((x) => !x.pass)).toEqual([]);
      expect(result.pass).toBe(true);
    };

    it('adds eight component cases in a new suite, played by both a cloud and a constrained local model', () => {
      expect(SUITE_VERSION).toBe(4);
      const cases = COMPONENT_CASES.map(byId);
      expect(cases.map((c) => `${c?.id}@${c?.version}:${c?.category}`)).toEqual(COMPONENT_CASES.map((id) => `${id}@1:component`));
      expect(cases.map((c) => c.scriptedProfile)).toEqual(['cloud', 'constrained-json', 'constrained-json', 'cloud', 'constrained-json', 'constrained-json', 'cloud', 'constrained-json']);
      expect(EVAL_CASES.filter((c) => c.category === 'component').map((c) => c.id)).toEqual(COMPONENT_CASES);
    });

    it('sends each case as the editor would, so its model gets the tools that request gets', async () => {
      const seen: Record<string, { tools: string[]; result: CaseResult; allowed: string; component?: string }> = {};
      for (const id of COMPONENT_CASES) {
        const c = byId(id);
        let tools: string[] = [];
        let allowed = '';
        let component: string | undefined;
        const spied: EvalCase = {
          ...c,
          script: (state) => {
            const [first, ...rest] = c.script(state);
            return [
              (req) => {
                tools = req.tools.map((t) => t.name);
                // A constrained model is sent the context compact.
                allowed = /"allowedScope":\s*"([^"]*)"/.exec((req.items[0] as { text: string }).text)?.[1] ?? '';
                component = c.component?.(state()).id;
                return first(req);
              },
              ...rest
            ];
          }
        };
        const { result } = await runCase(spied, scripted);
        expect(result.pass, id).toBe(true);
        seen[id] = { tools, result, allowed, component };
      }
      // A design edited everywhere may change only that design; anything else the whole site.
      for (const id of ['add-panel-tone-axis', 'make-panel-caption-editable', 'repair-component-on-phones']) expect(seen[id].allowed, id).toContain(seen[id].component);
      for (const id of ['create-workshop-notice', 'create-and-check-on-phones', 'style-component-with-site-tokens']) expect(seen[id].allowed, id).not.toContain('component');
      // Create component: the whole component in one call first, with the operations and the inspector beside it.
      for (const id of ['create-workshop-notice', 'show-booking-status-conditionally', 'create-repeated-workshop-cards', 'create-and-check-on-phones']) {
        expect(seen[id].tools[0], id).toBe('upsert_managed_component');
        expect(seen[id].tools, id).toEqual(expect.arrayContaining(['apply_operations', 'inspect_component']));
        expect(seen[id].tools, id).not.toContain('upsert_page_with_sections');
      }
      expect(seen['create-workshop-notice'].result).toMatchObject({ toolCalling: 'native', contextWindowTokens: 200_000 });
      expect(seen['create-repeated-workshop-cards'].result).toMatchObject({ toolCalling: 'constrained-json', contextWindowTokens: 32_768 });
      // A design edited everywhere on a small model: its own definition tools, and no general operations.
      for (const id of ['add-panel-tone-axis', 'make-panel-caption-editable']) {
        expect(seen[id].tools, id).toEqual(expect.arrayContaining(['manage_component_prop', 'bind_definition_field', 'edit_definition_node', 'style_definition_element', 'add_definition_variant', 'read_component']));
        expect(seen[id].tools, id).not.toContain('apply_operations');
        expect(seen[id].result.toolCalling, id).toBe('constrained-json');
      }
      // A small site request that asks for a component gets the tool that builds one whole, beside the page tools.
      expect(seen['style-component-with-site-tokens'].tools).toEqual(expect.arrayContaining(['upsert_managed_component', 'upsert_page_with_sections']));
      expect(seen['style-component-with-site-tokens'].tools).not.toContain('apply_operations');
      // The same design edited everywhere on a cloud model: the general tools, which measure it too.
      expect(seen['repair-component-on-phones'].tools).toEqual(expect.arrayContaining(['inspect_component', 'apply_operations', 'read_component']));
      expect(seen['repair-component-on-phones'].tools).not.toContain('style_definition_element');
      // A design that is not in the project is not a request the harness can send.
      await expect(runCase({ ...byId('add-panel-tone-axis'), setup: undefined }, scripted)).rejects.toThrow('No component Studio panel');
    }, 120000);

    it('repairs a component from what inspect_component measured, and measures it clean after', async () => {
      const { result, trace } = await runCase(byId('repair-component-on-phones'), scripted);
      expect(result.pass).toBe(true);
      const calls = trace.turns.flatMap((t) => t.toolCalls);
      expect(calls.map((t) => t.name)).toEqual(['inspect_component', 'apply_operations', 'inspect_component']);
      const first = JSON.parse(calls[0].result!);
      expect(first.findings.map((f: { kind: string; at: { nodeId: string } }) => `${f.kind}@${f.at.nodeId}`)).toEqual(['element-overflow@panel', 'low-contrast@line']);
      expect(JSON.parse(calls[1].result!).ok).toBe(true);
      // Measured again from the project as it is now, not as it was.
      const second = JSON.parse(calls[2].result!);
      expect(second.findings).toBeUndefined();
      expect(second.summary).toContain('Counter hours');
      // Without the benchmark's measurer the tool says it cannot measure, the script fixes nothing, and the case fails.
      const blind = await runCase({ ...byId('repair-component-on-phones'), measureComponents: false }, scripted);
      expect(JSON.parse(blind.trace.turns[0].toolCalls[0].result!).error.message).toContain('not available here');
      expect(blind.result.checks.filter((x) => !x.pass).map((x) => x.id)).toEqual(['fits-on-phone', 'readable-on-phone']);
      // A constrained local model building one on Create component measures it the same way, and fixes what it found.
      const built = await runCase(byId('create-and-check-on-phones'), scripted);
      expect(built.result).toMatchObject({ pass: true, toolCalling: 'constrained-json' });
      const steps = built.trace.turns.flatMap((t) => t.toolCalls);
      expect(steps.map((t) => t.name)).toEqual(['upsert_managed_component', 'inspect_component', 'apply_operations', 'inspect_component']);
      expect(JSON.parse(steps[1].result!).findings.map((f: { kind: string; at: { nodeId: string } }) => `${f.kind}@${f.at.nodeId}`)).toEqual(['element-overflow@panel']);
      expect(JSON.parse(steps[3].result!).findings).toBeUndefined();
    }, 60000);

    it('grades what a placement shows and how it is styled, so near misses fail and other ways of doing it pass', async () => {
      const notice = byId('create-workshop-notice');
      expect(await failing(editCalls(notice, (_n, a) => delete a.placeOnPage))).toEqual(['placed-last-on-home']);
      expect(await failing(editCalls(notice, (_n, a) => (a.nodes[1].text = 'Saturday workshop')))).toEqual(['heading-editable']);
      // Other node IDs, and a name in another case, are the same component.
      await passes(editCalls(notice, (_n, a) => ((a.name = 'WORKSHOP NOTICE'), (a.nodes[0].id = 'box'), (a.nodes[0].children = ['title', 'body']))));
      // Both texts as fields of one object property, which authors edit just the same.
      const grouped = (_n: string, a: any) => {
        a.properties = [{ type: 'object', name: 'copy', label: 'Copy', fields: a.properties, default: [{ field: 'heading', value: 'Saturday workshop' }, { field: 'message', value: 'Doors open at nine.' }] }];
        a.nodes[1].text = { $prop: 'copy', field: 'heading' };
        a.nodes[2].text = { $prop: 'copy', field: 'message' };
      };
      await passes(editCalls(notice, grouped));
      // Shown in the design, but hidden by its styles.
      expect(await failing(editCalls(notice, (_n, a) => a.nodes[2].styles = [{ property: 'hidden', value: true }]))).toEqual(['message-editable', 'placed-last-on-home']);

      // A room fixed in the card is shown on every card, whatever its item says.
      const cards = byId('create-repeated-workshop-cards');
      expect(await failing(editCalls(cards, (_n, a) => (a.nodes[5].text = 'Kiln room')))).toEqual(['starts-with-two-cards', 'card-per-item', 'placed-last-on-home']);
      expect(await failing(editCalls(cards, (_n, a) => a.properties[0].default.pop()))).toEqual(['starts-with-two-cards', 'placed-last-on-home']);
      // The titles in one repeat and the rooms in another: two runs of text, not cards.
      const split = (_n: string, a: any) => {
        a.nodes[1].children = ['each', 'rooms'];
        a.nodes[3].children = ['title'];
        a.nodes.push({ kind: 'repeat', id: 'rooms', list: 'cards', children: ['roomCard'] }, { kind: 'element', id: 'roomCard', tag: 'li', children: ['room'] });
      };
      expect(await failing(editCalls(cards, split))).toEqual(['starts-with-two-cards', 'card-per-item', 'placed-last-on-home']);
      // A list an author cannot add a third card to.
      expect(await failing(editCalls(cards, (_n, a) => (a.properties[0].max = 2)))).toEqual(['card-per-item']);

      // The dark colors set for every placement, a dark background behind dark text, and a raw color.
      const tone = byId('add-panel-tone-axis');
      expect(await failing(editCalls(tone, (n, a) => n === 'style_definition_element' && delete a.variant))).toEqual(['default-unchanged']);
      expect(await failing(editCalls(tone, (n, a) => n === 'style_definition_element' && a.styles.pop()))).toEqual(['inverse-text']);
      expect(await failing(editCalls(tone, (n, a) => n === 'style_definition_element' && (a.styles[0].value = '#14211d')))).toEqual(['inverse-background']);
      // The panel hidden for every placement as well: both options look the same, which is not the look kept.
      const hidden: EvalCase = {
        ...tone,
        script: (state) => {
          const [add, style, end] = tone.script(state);
          const hide = () => [{ type: 'done' as const, stopReason: 'tool_use' as const, text: '', toolCalls: [{ id: 'h1', name: 'style_definition_element', arguments: JSON.stringify({ nodeId: 'panel', scope: 'base', styles: [{ property: 'hidden', value: true }] }) }] }];
          return [add, style, hide, end];
        }
      };
      expect(await failing(hidden)).toEqual(['default-unchanged']);
      // Dark behind the heading alone, not the panel; and an Inverse option on an axis that is not a tone.
      expect(await failing(editCalls(tone, (n, a) => n === 'style_definition_element' && (a.nodeId = 'title')))).toEqual(['inverse-background', 'inverse-text']);
      expect(await failing(editCalls(tone, (n, a) => (n === 'add_definition_variant' || n === 'style_definition_element') && (n === 'add_definition_variant' ? (a.axis = 'layout') : (a.variant.axis = 'layout'))))).toEqual(['inverse-option', 'inverse-background', 'inverse-text', 'placement-keeps-default']);

      // Both messages always shown; and the same switch written as comparisons, which passes.
      const booking = byId('show-booking-status-conditionally');
      expect(await failing(editCalls(booking, (_n, a) => (delete a.nodes[1].when, delete a.nodes[2].unless)))).toEqual(['yes-no-setting', 'starts-off', 'open-message-editable', 'closed-message-editable']);
      const compared = (_n: string, a: any) => {
        a.nodes[1].when = { ref: { $prop: 'open' }, eq: true };
        delete a.nodes[2].unless;
        a.nodes[2].when = { ref: { $prop: 'open' }, ne: true };
      };
      await passes(editCalls(booking, compared));
      // The whole component hidden by its styles, and the setting labelled as something else.
      expect(await failing(editCalls(booking, (_n, a) => (a.nodes[0].styles = [{ property: 'hidden', value: true }])))).toEqual(['yes-no-setting', 'starts-off', 'open-message-editable', 'closed-message-editable']);
      expect(await failing(editCalls(booking, (_n, a) => (a.properties[0].label = 'Archived')))).toEqual(['yes-no-setting', 'open-message-editable', 'closed-message-editable']);

      // The same colors and padding as raw values; padding above and below only; text left to the page's color passes.
      const tokens = byId('style-component-with-site-tokens');
      const raw = (_n: string, a: any) =>
        (a.nodes[0].styles = [
          { property: 'background', value: '#ffffff' },
          { property: 'color', value: '#191a18' },
          { property: 'paddingBlock', value: '24px' },
          { property: 'paddingInline', value: '24px' }
        ]);
      expect(await failing(editCalls(tokens, raw))).toEqual(['surface-background', 'text-color', 'large-padding', 'only-site-styles']);
      expect(await failing(editCalls(tokens, (_n, a) => a.nodes[0].styles.pop()))).toEqual(['large-padding']);
      // Text left to inherit, which in a dark section is not the site's text color; padding overridden by custom CSS.
      expect(await failing(editCalls(tokens, (_n, a) => a.nodes[0].styles.splice(1, 1)))).toEqual(['text-color']);
      expect(await failing(editCalls(tokens, (_n, a) => a.nodes[0].styles.push({ property: 'customCss', value: 'padding: 1px;' })))).toEqual(['only-site-styles']);
      // The text color set on the line itself, and padding as four longhands, pass.
      const longhands = (_n: string, a: any) => {
        const [bg, color] = a.nodes[0].styles;
        a.nodes[0].styles = [bg, ...['paddingBlockStart', 'paddingBlockEnd', 'paddingInlineStart', 'paddingInlineEnd'].map((property) => ({ property, value: { token: 'space.lg' } }))];
        a.nodes[1].styles = [color];
      };
      await passes(editCalls(tokens, longhands));

      // A Caption field the caption never shows.
      const caption = byId('make-panel-caption-editable');
      const unbound: EvalCase = {
        ...caption,
        script: (state) => {
          const turns = caption.script(state);
          return [turns[0], turns[2], turns[3]];
        }
      };
      expect(await failing(unbound)).toEqual(['caption-editable', 'caption-field']);
      // A cloud model makes the same change with the general operations, which grades the same.
      const general: EvalCase = {
        ...caption,
        scriptedProfile: 'cloud',
        script: (state) => {
          const def = Object.values(state().components).find((d) => d.name === 'Service panel')!;
          const owner = { kind: 'component', id: def.id };
          return [
            () => [
              {
                type: 'done',
                stopReason: 'tool_use',
                text: '',
                toolCalls: [
                  {
                    id: 'g1',
                    name: 'apply_operations',
                    arguments: JSON.stringify({
                      expectedRevision: 0,
                      operations: [
                        { type: 'component.setPropSchema', definitionId: def.id, prop: 'note', schema: { type: 'string', label: 'Caption', default: 'Ask at reception' } },
                        { type: 'node.setBinding', owner, nodeId: 'caption', field: 'text', binding: { $prop: 'note' } },
                        { type: 'component.setPart', definitionId: def.id, partId: 'note', nodeId: 'caption', label: 'Caption' }
                      ]
                    })
                  }
                ]
              }
            ],
            () => [{ type: 'done', stopReason: 'end', text: 'Done.', toolCalls: [] }]
          ];
        }
      };
      await passes(general);

      // Only the width fixed; the text hidden on phones rather than made readable; the panel made full width on desktop
      // too; and a cap on its width in place of a phone width, which passes.
      const repair = byId('repair-component-on-phones');
      const ops = (edit: (list: any[]) => void) => editCalls(repair, (n, a) => n === 'apply_operations' && edit(a.operations));
      const line = (property: string, value: unknown) => ({ ...list0(), nodeId: 'line', property, value });
      let owner: unknown;
      const list0 = () => ({ type: 'node.setStyle', owner, scope: 'phone' });
      const fixes = (edit: (list: any[]) => void) => ops((list) => ((owner = list[0].owner), edit(list)));
      expect(await failing(fixes((list) => list.pop()))).toEqual(['readable-on-phone']);
      // Readable once fixed, but then hidden, or faded out, on phones.
      expect(await failing(fixes((list) => list.push(line('hidden', true))))).toEqual(['readable-on-phone']);
      expect(await failing(fixes((list) => list.push(line('opacity', 0))))).toEqual(['readable-on-phone']);
      // Custom CSS can change anything about the line where it applies: on phones nothing about it is measured.
      expect(await failing(fixes((list) => list.push(line('customCss', 'display: none;'))))).toEqual(['fits-on-phone', 'readable-on-phone']);
      // The panel's color on the text alone, the panel itself left bare.
      const bare = (n: string, a: any) => n === 'apply_operations' && a.operations.push({ ...a.operations[0], scope: 'base', property: 'background', value: null }, { ...a.operations[0], nodeId: 'line', scope: 'base', property: 'background', value: { token: 'color.surface' } });
      expect(await failing(editCalls(repair, bare))).toEqual(['panel-background']);
      // A responsive cap worked out from calc(), and min(), keep the 720px desktop panel.
      await passes(fixes((list) => list.splice(0, 1, { ...list[0], scope: 'base', property: 'maxWidth', value: 'calc(100% - 2rem)' })));
      await passes(fixes((list) => Object.assign(list[0], { scope: 'base', value: 'min(100%, 720px)' })));
      // The hours shown twice, a paragraph on phones and a heading from tablets up, both bound to the one field: each
      // size reads its own.
      const twoWays: EvalCase = {
        ...repair,
        setup: (state) => {
          const made = applyOperations(state, [
            {
              type: 'component.upsert',
              name: 'Counter hours',
              properties: { message: { type: 'string', label: 'Message', default: 'Counter closes at four' } },
              nodes: [
                { kind: 'element', id: 'panel', tag: 'aside', children: ['line', 'big'], styles: { base: { width: 'fill', maxWidth: '720px', background: { token: 'color.surface' } } } },
                { kind: 'text', id: 'line', tag: 'p', text: { $prop: 'message' }, styles: { tablet: { hidden: true }, desktop: { hidden: true } } },
                { kind: 'text', id: 'big', tag: 'h2', text: { $prop: 'message' }, styles: { phone: { hidden: true } } }
              ]
            } as EditOperation
          ]);
          Object.assign(state, made.state);
        },
        script: () => []
      };
      await passes(twoWays);
      // Full width on desktop too; and capped narrower than the desktop panel was.
      expect(await failing(fixes((list) => (list[0].scope = 'base')))).toEqual(['desktop-kept']);
      expect(await failing(fixes((list) => Object.assign(list[0], { scope: 'base', property: 'maxWidth', value: '300px' })))).toEqual(['desktop-kept']);
      // A cap on its width in place of a phone width, and full width capped at 720px, both keep the desktop panel.
      await passes(fixes((list) => Object.assign(list[0], { scope: 'base', property: 'maxWidth', value: '100%' })));
      await passes(fixes((list) => list.splice(0, 1, { ...list[0], scope: 'base', value: 'fill' }, { ...list[0], scope: 'base', property: 'maxWidth', value: '720px' })));
    }, 180000);
  });

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
