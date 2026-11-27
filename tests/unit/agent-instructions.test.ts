/**
 * The texts the model reads say what the tools do (#815): the values, limits and tool names a prompt or a description
 * states come from the definitions they describe, so the two cannot drift apart.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatContext } from '@shared/api';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { Orchestrator } from '@agent/orchestrator';
import type { AgentModelAdapter, CanonicalModelRequest, ModelEvent } from '@agent/types';
import { executeTool, MAX_BATCH_OPERATIONS, TOOL_ARGS, toolDefinitions, toolsForRun, type ToolHost } from '@agent/tools';
import { PROJECT_SECTIONS } from '@agent/budget';
import { SELECTION_BRIEFS, SELECTION_DESCRIPTIONS } from '@agent/selection';
import { DEFINITION_DESCRIPTIONS } from '@agent/definition';
import { COMPONENT_BLUEPRINTS } from '@agent/examples';
import { UPSERT_BRIEF, UPSERT_DESCRIPTION } from '@agent/macros';
import { STATE_STYLE_PROPS, STYLE_PROP_MAP } from '@shared/styles';
import { ProjectSession } from '../../src/main/project/session';

class FakeAdapter implements AgentModelAdapter {
  requests: CanonicalModelRequest[] = [];
  constructor(private toolCalling: 'native' | 'constrained-json' = 'native') {}
  capabilities() {
    return { toolCalling: this.toolCalling, streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 100000, maxOutputTokens: 32000 } as ReturnType<AgentModelAdapter['capabilities']>;
  }
  async *streamTurn(req: CanonicalModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    yield { type: 'done', stopReason: 'end', text: 'Done.', toolCalls: [] };
  }
}

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The first request a run sends the model, for a chat context. */
async function firstRequest(text: string, extra: (state: ProjectState) => Partial<ChatContext> = () => ({}), codeEnabled = true, toolCalling?: 'constrained-json'): Promise<CanonicalModelRequest> {
  const dir = mkdtempSync(join(tmpdir(), 'so-instr-'));
  dirs.push(dir);
  const session = await ProjectSession.create(dir, createStarterState('business', 'Test', false));
  const adapter = new FakeAdapter(toolCalling);
  let busy = false;
  const orch = new Orchestrator({
    session: () => session,
    adapter: async () => ({ adapter, model: 'fake', provider: 'openai' }),
    emit: () => {},
    compileAll: async () => [],
    inspectLayout: async () => ({ issues: [] }),
    onBusyChange: (b) => (busy = b),
    codeEnabled: async () => codeEnabled
  });
  const ctx: ChatContext = { pageId: session.state.site.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280, ...extra(session.state) };
  const r = await orch.send(text, ctx);
  expect(r.ok).toBe(true);
  while (orch.busy || busy) await new Promise((res) => setTimeout(res, 10));
  return adapter.requests[0];
}

const easings = STYLE_PROP_MAP.transitionEasing.options!.map((o) => o.value);
const presets = STYLE_PROP_MAP.transition.options!.map((o) => o.value);
const stateLabels = STATE_STYLE_PROPS.map((p) => STYLE_PROP_MAP[p].label.toLowerCase());

describe('agent instructions match the tool definitions (#815)', () => {
  it('lists every easing and transition preset the style properties define', () => {
    expect(easings).toEqual(expect.arrayContaining(['ease-in', 'ease-in-out', 'overshoot']));
    const list = `${easings.slice(0, -1).join(', ')} or ${easings.at(-1)}`;
    for (const text of [SELECTION_DESCRIPTIONS.style_selected_element, SELECTION_BRIEFS.style_selected_element]) {
      expect(text).toContain(`transitionEasing ${list}`);
      expect(text).toContain(`transition a preset (${presets.join(', ')})`);
    }
  });

  it('names what a hover, focus or press may style the same way everywhere, from STATE_STYLE_PROPS', async () => {
    const words = `${stateLabels.slice(0, -1).join(', ')} and ${stateLabels.at(-1)}`;
    expect(stateLabels).toEqual(expect.arrayContaining(['background image', 'backdrop blur']));
    expect(SELECTION_DESCRIPTIONS.style_selected_element).toContain(`(${words})`);
    expect(DEFINITION_DESCRIPTIONS.style_definition_element).toContain(`(${words})`);
    const req = await firstRequest('Make the buttons darker on hover');
    expect(req.system).toContain(`to style that state only (${words})`);
  });

  it('states the batch limit apply_operations enforces', async () => {
    const op = { type: 'page.create', title: 'P' };
    const batch = (n: number) => TOOL_ARGS.apply_operations.safeParse({ expectedRevision: 0, operations: Array.from({ length: n }, () => op) });
    expect(batch(MAX_BATCH_OPERATIONS).success).toBe(true);
    expect(batch(MAX_BATCH_OPERATIONS + 1).success).toBe(false);
    const offered = toolDefinitions().find((t) => t.name === 'apply_operations')!.parameters as { properties: { operations: { maxItems: number } } };
    expect(offered.properties.operations.maxItems).toBe(MAX_BATCH_OPERATIONS);
    const req = await firstRequest('Add a team page');
    expect(req.system).toContain(`up to ${MAX_BATCH_OPERATIONS} operations`);
    expect(req.system).not.toMatch(/about 20 operations/);
    expect(req.tools.find((t) => t.name === 'apply_operations')!.description).not.toMatch(/only way/);
  });

  it('offers read_project only the sections it adds, each of which adds its own field', async () => {
    const state = createStarterState('business', 'Test', false);
    const host = { state: () => state, revision: () => 1 } as unknown as ToolHost;
    const schema = toolDefinitions().find((t) => t.name === 'read_project')!.parameters as { properties: { sections: { items: { enum: string[] } } } };
    expect(schema.properties.sections.items.enum).toEqual([...PROJECT_SECTIONS]);
    const base = (await executeTool('read_project', '{}', host, 'c0')).content as Record<string, unknown>;
    expect(base.pages).toBeDefined();
    expect(base.shell).toBeDefined();
    const field = { tokens: 'tokens', catalogue: 'catalogue', components: 'installedComponents' } as const;
    for (const s of PROJECT_SECTIONS) {
      expect(base[field[s]], s).toBeUndefined();
      const read = await executeTool('read_project', JSON.stringify({ sections: [s] }), host, `c_${s}`);
      expect((read.content as Record<string, unknown>)[field[s]], s).toBeDefined();
    }
    for (const dead of ['pages', 'shell']) expect(((await executeTool('read_project', JSON.stringify({ sections: [dead] }), host, `c_${dead}`)).content as { error?: { code: string } }).error?.code, dead).toBe('INVALID_ARGUMENT');
  });

  it('says a new page is linked in a menu only when the call asks for it', async () => {
    for (const text of [UPSERT_DESCRIPTION, UPSERT_BRIEF]) expect(text).not.toMatch(/wire navigation/);
    expect(UPSERT_DESCRIPTION).toContain('addToHeaderNav');
    const req = await firstRequest('Add a team page');
    expect(req.system).not.toMatch(/adds it to the navigation|navigation included/);
    expect(req.system).toContain('addToHeaderNav / addToFooterNav');
  });

  it('describes the Callout button by both conditions its node shows it under', () => {
    const callout = COMPONENT_BLUEPRINTS.find((b) => b.id === 'callout')!;
    const button = callout.args.nodes!.find((n) => n.id === 'button') as { when?: unknown; unless?: unknown };
    expect(button.when).toEqual({ $prop: 'buttonLink' });
    expect(button.unless).toEqual({ ref: { $prop: 'buttonLabel' }, eq: '' });
    expect(callout.description).toContain('both a label and a link');
    expect(callout.args.properties!.find((p) => p.name === 'buttonLink')!.description).toContain('both a link and a label');
  });

  it('tells a run limited to one post to use the categories its collection has, not to add one', () => {
    const state = createStarterState('business', 'Test', false);
    const { state: blog } = applyOperations(state, [{ type: 'collection.create', collectionId: 'posts' }]);
    const caps = { toolCalling: 'native' as const, contextWindowTokens: 100000 };
    const site = toolsForRun({ state: blog, selection: null, capabilities: caps, codeEnabled: false, definitionOps: false }).tools.find((t) => t.name === 'upsert_collection_entry');
    const entry = toolsForRun({ state: blog, selection: null, capabilities: caps, codeEnabled: false, definitionOps: false, entry: { collectionId: 'posts', entryId: 'en_x' } }).tools.find((t) => t.name === 'upsert_collection_entry')!;
    expect(site?.description).toMatch(/adding any the collection lacks/);
    for (const text of [entry.description, entry.brief ?? '', JSON.stringify((entry.parameters as { properties: { categories: unknown } }).properties.categories)]) {
      expect(text).not.toMatch(/adding any|lacks is added|Create a draft/);
      expect(text).toMatch(/collection (already )?has/);
    }
    expect(entry.description).toContain('categories its collection already has');
  });

  it('names upsert_managed_component and inspect_component only to a run offered them', async () => {
    const runs = await Promise.all([
      firstRequest('Add a team page'),
      firstRequest('Rewrite this page', (s) => ({ pageId: s.site.homePageId, scope: 'page' })),
      firstRequest('Make this darker', (s) => ({ selection: { owner: { kind: 'page', id: s.site.homePageId }, instancePath: [], nodeId: s.pages[s.site.homePageId].rootIds[0] }, selectionLabel: 'Hero' }))
    ]);
    const offered = runs.map((req) => req.tools.map((t) => t.name));
    // Each context reaches the run it stands for: the site run is offered both, the page run neither, a selection
    // only the check.
    expect(offered[0]).toEqual(expect.arrayContaining(['upsert_managed_component', 'inspect_component']));
    for (const name of ['upsert_managed_component', 'inspect_component']) expect(offered[1]).not.toContain(name);
    expect(offered[2]).toContain('inspect_component');
    expect(offered[2]).not.toContain('upsert_managed_component');
    runs.forEach((req, i) => {
      for (const name of ['upsert_managed_component', 'inspect_component']) expect(req.system.includes(name), `${i} ${name}`).toBe(offered[i].includes(name));
    });
    expect(runs[0].system).toContain('Making a new reusable component');
    expect(runs[2].system).toContain('Checking a component');
  });

  it('states the Svelte 5 runes contract before the first draft, to every run offered component.createCode (#1113)', async () => {
    const page = (s: ProjectState): Partial<ChatContext> => ({ pageId: s.site.homePageId, scope: 'page' });
    const selected = (s: ProjectState): Partial<ChatContext> => ({ selection: { owner: { kind: 'page', id: s.site.homePageId }, instancePath: [], nodeId: s.pages[s.site.homePageId].rootIds[0] }, selectionLabel: 'Hero' });
    const runs = await Promise.all([
      firstRequest('Write a code component that counts down to our sale'),
      firstRequest('Write a code component that counts down to our sale', () => ({ task: 'component' })),
      firstRequest('Turn this into a code component with a counter', selected),
      // A small model, which reads no schema descriptions and gets the component run's own short instructions.
      firstRequest('Write a code component that counts down to our sale', () => ({ task: 'component' }), true, 'constrained-json'),
      firstRequest('Rewrite this page', page),
      firstRequest('Write a code component that counts down to our sale', () => ({}), false),
      firstRequest('Write a code component that counts down to our sale', () => ({ task: 'component' }), false)
    ]);
    // The quoted name is the operation itself; descriptions only mention it in passing.
    const offered = runs.map((req) => JSON.stringify(req.tools).includes('"component.createCode"'));
    expect(offered).toEqual([true, true, true, true, false, false, false]);
    // The small model's run really is the short one.
    expect(runs[3].system).toContain('You make reusable components');
    runs.forEach((req, i) => {
      for (const words of ['Svelte 5 runes mode', '$props()', '$state()', '$derived()', '$effect()', 'onclick', 'export let', '$$props', '$$restProps', '$: statements are rejected']) expect(req.system.includes(words), `${i} ${words}`).toBe(offered[i]);
      expect(req.system.split('Svelte 5 runes mode').length - 1, `${i} said once`).toBe(offered[i] ? 1 : 0);
    });
  });
});

describe('a new component asked for in page scope (#1143)', () => {
  const onePage = () => ({ scope: 'page' as const });
  const ask = /make a new component[^\n]*widenScope: true/i;

  it.each([
    ['a native model', undefined],
    ['a grammar-constrained model', 'constrained-json' as const]
  ])('tells %s to ask to widen rather than refuse', async (_, toolCalling) => {
    const req = await firstRequest('Create a countdown as a custom code component', onePage, true, toolCalling);
    expect(req.tools.map((t) => t.name)).toContain('request_clarification');
    expect(req.system).toMatch(ask);
  });

  it('does not offer code with Developer mode off', async () => {
    const req = await firstRequest('Create a countdown component', onePage, false);
    expect(req.system).toMatch(ask);
    expect(req.system).not.toContain('component.createCode');
  });
});
