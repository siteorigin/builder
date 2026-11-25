/**
 * The real orchestrator, session and tools driven by the local adapter over HTTP. Proves the constrained-JSON
 * path gets the same scope checks, validation, rollback and undo as any other provider.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiEvent, ChatContext, ProviderId } from '@shared/api';
import type { ElementRef, InstanceNode } from '@shared/types';
import { createStarterState, type StarterId } from '@catalogue/starters';
import { LIMITS, Orchestrator } from '@agent/orchestrator';
import { LocalAdapter, openLocalAdapter, type LocalAdapterOptions, type LocalEndpoint } from '@agent/local';
import { DEFAULT_LOCAL_PROFILE, type LocalModelProfile } from '@agent/models';
import { findForbiddenShapes } from '@agent/strict-schema';
import { FOCUSED_WINDOW_TOKENS, toolsForRun } from '@agent/tools';
import { contextVerdict, estimateRequestTokens, estimateTokens } from '@agent/budget';
import { pageGlance, pageGlanceChars } from '@agent/context';
import { applyOperations } from '@engine/apply';
import { COMPONENT_BLUEPRINTS } from '@agent/examples';
import type { CanonicalItem, ToolDefinition } from '@agent/types';
import { ProjectSession } from '../../src/main/project/session';
import { closedPort, envelopeReply, MockOpenAIServer, renderStrictTemplate, sseChunk, textReply, toolCallReply } from './mock-openai-server';

let server: MockOpenAIServer;
const dirs: string[] = [];
beforeEach(async () => {
  server = await new MockOpenAIServer().start();
});
afterEach(async () => {
  await server.stop();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function setup(endpoint: Partial<LocalEndpoint> = {}, opts: LocalAdapterOptions = {}, codeEnabled = true, provider: ProviderId = 'local', starter: StarterId = 'business', discover = false) {
  const dir = mkdtempSync(join(tmpdir(), 'so-local-'));
  dirs.push(dir);
  const session = await ProjectSession.create(dir, createStarterState(starter, 'Test', false));
  const adapter = new LocalAdapter({ baseURL: server.baseURL, model: 'test-model', ...endpoint }, opts);
  const events: AiEvent[] = [];
  let busy = false;
  const orch = new Orchestrator({
    session: () => session,
    // `discover`: the app's own factory, which reads the server's model and loaded size before the run.
    adapter: async (signal) => {
      if (!discover) return { adapter, model: 'test-model', provider };
      const opened = await openLocalAdapter({ baseURL: server.baseURL, model: '', ...endpoint }, { signal });
      return 'error' in opened ? opened : { ...opened, provider: 'local' };
    },
    emit: (e) => events.push(e),
    compileAll: async () => [],
    inspectLayout: async () => ({ issues: [] }),
    onBusyChange: (b) => (busy = b),
    codeEnabled: async () => codeEnabled
  });
  const header = session.state.site.shell.header.rootIds[0];
  const run = async (text: string, selection: ElementRef | null = null, selectionLabel: string | null = null, mode?: ChatContext['mode'], component?: { id: string; name: string }, scope?: ChatContext['scope']) => {
    const ctx: ChatContext = { pageId: session.state.site.homePageId, pageTitle: 'Home', selection, selectionLabel, viewport: 1280, ...(mode ? { mode } : {}), ...(component ? { component } : {}), ...(scope ? { scope } : {}) };
    const r = await orch.send(text, ctx);
    expect(r.ok).toBe(true);
    await expect.poll(() => orch.busy || busy, { timeout: 5000, interval: 5 }).toBe(false);
    const msg = [...events].reverse().find((e) => e.kind === 'message' && e.message?.result)?.message;
    return { runId: r.runId!, result: msg?.result };
  };
  return { session, run, header, events, orch };
}

const setHeaderName = (header: string, name: string, revision = 0) => ({
  expectedRevision: revision,
  operations: [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header, prop: 'siteName', value: name }]
});
const rename = (siteName: string) => ({ siteName });
const headerName = (session: ProjectSession, header: string) => (session.state.site.shell.header.nodes[header] as { props: Record<string, unknown> }).props.siteName;
const toolResults = () => server.requests.filter((r) => r.method === 'POST').flatMap((r) => r.body.messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'user');

describe('orchestrator with constrained JSON', () => {
  it('runs read, edit and finish as one undoable step', async () => {
    const { session, run, header } = await setup();
    const before = headerName(session, header);
    server.script(envelopeReply('read_project', {}, 'Reading the project'), envelopeReply('update_site_brand', rename('Harbor Coffee'), 'Renaming the site'), envelopeReply('finish', { message: 'Renamed the site to Harbor Coffee.' }));
    const { runId, result } = await run('Rename the site to Harbor Coffee');
    expect(result).toMatchObject({ status: 'completed', summary: 'Renamed the site to Harbor Coffee.', canUndo: true });
    expect(headerName(session, header)).toBe('Harbor Coffee');
    expect((await session.undoGroup(runId)).ok).toBe(true);
    expect(headerName(session, header)).toBe(before);
  });

  it('applies a structured value sent in the encoded form', async () => {
    const { session, events, orch } = await setup();
    // A component edited everywhere gets the general edit tool on a small model once the author lets it change more.
    const home = session.state.pages[session.state.site.homePageId];
    const grid = home.rootIds.map((id) => home.nodes[id] as unknown as { id: string; definitionId: string }).find((n) => session.state.components[n.definitionId]?.componentId === 'features.grid')!;
    const made = await session.apply({ operations: [{ type: 'component.makeUnique', owner: { kind: 'page', id: home.id }, nodeId: grid.id, name: 'Studio cards' }] }, { label: 'Make unique', source: 'user' });
    expect(made.ok).toBe(true);
    const id = (made.results?.[0] as { definitionId: string }).definitionId;
    const items = [{ id: 'i_one', icon: 'leaf', title: 'Services', description: 'What we do.' }];
    const args = { expectedRevision: session.revision, operations: [{ type: 'component.setPropDefault', definitionId: id, prop: 'items', value: { $json: JSON.stringify(items) } }] };
    server.script(envelopeReply('request_clarification', { question: 'Setting the cards every placement starts with needs more. Go ahead?', widenScope: true }), envelopeReply('apply_operations', args), envelopeReply('finish', { message: 'Set the default cards.' }));
    const sent = await orch.send('Start every placement with a Services card', { pageId: home.id, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280, component: { id, name: 'Studio cards' } });
    await expect.poll(() => events.some((e) => e.message?.questions?.length), { timeout: 5000, interval: 5 }).toBe(true);
    const q = events.find((e) => e.message?.questions?.length)!.message!.questions![0];
    expect(orch.answer(sent.runId!, q.id!, q.choices![0])).toBe(true);
    await expect.poll(() => orch.busy, { timeout: 5000, interval: 5 }).toBe(false);
    const result = [...events].reverse().find((e) => e.kind === 'message' && e.message?.result)?.message?.result;
    expect(result?.status).toBe('completed');
    const def = session.state.components[id].properties.items as unknown as { default: Array<Record<string, unknown>> };
    expect(def.default).toEqual([expect.objectContaining({ icon: 'leaf', title: 'Services', description: 'What we do.' })]);
  });

  it('builds a rich component and places it in one call without Developer mode, repairs it from the path it was refused with, and undoes it in one step (#359)', async () => {
    const { session, run } = await setup({}, {}, false);
    const home = session.state.site.homePageId;
    const blueprint = COMPONENT_BLUEPRINTS.find((b) => b.id === 'card-grid')!.args;
    const title = blueprint.nodes!.findIndex((n) => n.id === 'title');
    // The first call binds each card's title to a field the list does not have.
    const nodes = blueprint.nodes!.map((n, i) => (i === title ? { ...n, text: { $item: 'heading' } } : n));
    server.script(
      envelopeReply('upsert_managed_component', { ...blueprint, name: 'Studio cards', nodes, placeOnPage: { pageId: '/', index: 0 } }, 'Building the cards'),
      envelopeReply('upsert_managed_component', { name: 'Studio cards', repair: true, nodes: [blueprint.nodes![title]] }, 'Fixing the card title'),
      envelopeReply('finish', { message: 'Made Studio cards and put it first on the home page.' })
    );
    const before = session.historyInfo().entries.length;
    const { runId, result } = await run('Create a component of service cards and put it on the home page');
    expect(result).toMatchObject({ status: 'completed', canUndo: true });
    // The grammar holds the tool, with nothing it would have to send as encoded JSON, and the request carries a worked
    // call of it to follow.
    const first = server.requests.find((r) => r.method === 'POST')!.body;
    expect(findForbiddenShapes(first.response_format.json_schema.schema)).toEqual([]);
    expect(JSON.stringify(first.response_format)).toContain('"upsert_managed_component"');
    expect(first.messages[0].content).toContain('- upsert_managed_component {');
    expect(JSON.stringify(first.messages)).toContain('componentBlueprints');
    // Refused with the path of the one bad binding, and repaired from that node alone.
    expect(toolResults().some((m) => m.content.includes(`nodes[${title}].text`) && m.content.includes('no field \\"heading\\"'))).toBe(true);
    const def = Object.values(session.state.components).find((d) => d.name === 'Studio cards')!;
    expect(def).toMatchObject({ kind: 'managed', owner: 'project' });
    expect(def.tree!.nodes.title).toMatchObject({ text: { $item: 'title' } });
    expect(Object.keys(def.properties)).toEqual(['heading', 'headingLevel', 'cards']);
    expect(Object.keys(def.parts)).toEqual(expect.arrayContaining(['root', 'card']));
    expect(Object.keys(def.variantAxes!.tone.options)).toEqual(['default', 'muted', 'inverse']);
    expect(session.state.pages[home].nodes[session.state.pages[home].rootIds[0]]).toMatchObject({ kind: 'instance', definitionId: def.id });
    expect(session.historyInfo().entries.length).toBe(before + 1);
    expect((await session.undoGroup(runId)).ok).toBe(true);
    expect(session.state.components[def.id]).toBeUndefined();
  });

  it('rebuilds a component it reads whole, without Developer mode, keeping what its placement holds (#359)', async () => {
    const { session, run } = await setup({}, {}, false);
    const home = session.state.site.homePageId;
    const blueprint = COMPONENT_BLUEPRINTS.find((b) => b.id === 'card-grid')!.args;
    server.script(envelopeReply('upsert_managed_component', { ...blueprint, name: 'Studio cards', placeOnPage: { pageId: home } }), envelopeReply('finish', { message: 'Made Studio cards.' }));
    await run('Create a component of service cards on the home page');
    const def = Object.values(session.state.components).find((d) => d.name === 'Studio cards')!;
    const placed = session.state.pages[home].rootIds.at(-1)!;
    const edit = await session.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: home }, nodeId: placed, prop: 'heading', value: 'How we help' }] }, { label: 'Edit', source: 'user' });
    expect(edit.ok).toBe(true);
    server.requests.length = 0;
    // The rebuild adds a short label under each title.
    const fields = [...(blueprint.properties![2] as { fields: unknown[] }).fields, { type: 'string', name: 'label', label: 'Label', default: '' }];
    const nodes = blueprint.nodes!.map((n) => (n.id === 'card' ? { ...n, children: ['icon', 'title', 'label', 'text'] } : n));
    nodes.push({ kind: 'text', id: 'label', tag: 'p', text: { $item: 'label' }, when: { $item: 'label' } } as never);
    const properties = blueprint.properties!.map((p) => (p.name === 'cards' ? { ...p, fields } : p));
    server.script(
      envelopeReply('read_component', { definitionId: def.id, structure: true }, 'Reading the design'),
      envelopeReply('upsert_managed_component', { ...blueprint, definitionId: def.id, name: 'Studio cards', properties, nodes }, 'Adding a label'),
      envelopeReply('finish', { message: 'Added a label to each card.' })
    );
    const { runId, result } = await run('Update the Studio cards component: add a short label under each card title');
    expect(result?.status).toBe('completed');
    // The design was read whole: its structure, with the node IDs the rebuild names again.
    const first = server.requests.find((r) => r.method === 'POST')!.body;
    expect(JSON.stringify(first.response_format)).toContain('"structure"');
    expect(toolResults().some((m) => m.content.startsWith('Result of read_component') && m.content.includes('"card"'))).toBe(true);
    const rebuilt = session.state.components[def.id];
    expect(rebuilt.tree!.nodes.label).toMatchObject({ text: { $item: 'label' } });
    expect((rebuilt.properties.cards as { fields: Record<string, unknown> }).fields).toHaveProperty('label');
    // The placement keeps its own heading through the rebuild, and one undo takes the rebuild back.
    expect((session.state.pages[home].nodes[placed] as InstanceNode).props.heading).toBe('How we help');
    expect((await session.undoGroup(runId)).ok).toBe(true);
    expect(session.state.components[def.id].tree!.nodes.label).toBeUndefined();
    expect((session.state.pages[home].nodes[placed] as InstanceNode).props.heading).toBe('How we help');
  });

  it('sends a component request to a model whose known window holds it as it is sent: tools as signatures, not schemas (#359)', async () => {
    const window = 12_288;
    const { run } = await setup({}, { context: { windowTokens: window, server: 'ollama' } }, false);
    server.script(envelopeReply('finish', { message: 'Which content should each card hold?' }));
    const { result } = await run('Create a component of service cards');
    expect(result?.status).toBe('no-changes');
    const body = server.requests.find((r) => r.method === 'POST')!.body;
    expect(JSON.stringify(body.response_format)).toContain('"upsert_managed_component"');
    // What the model reads, with its reply, fits the window; the schemas alone, counted as a native request's, would not.
    const tools = toolsForRun({ state: createStarterState('business', 'Test', false), selection: null, capabilities: { toolCalling: 'constrained-json', contextWindowTokens: window }, codeEnabled: false, definitionOps: true, componentRequest: true }).tools;
    const prompt = estimateTokens((body.messages as Array<{ content: string }>).map((m) => m.content).join(''));
    expect(prompt + body.max_tokens).toBeLessThanOrEqual(window);
    expect(estimateRequestTokens(body.messages[0].content, tools, [])).toBeGreaterThan(window - body.max_tokens);
  });

  it('still enforces the selection scope', async () => {
    const { session, run, header } = await setup();
    const before = headerName(session, header);
    const home = session.state.pages[session.state.site.homePageId];
    const section = home.rootIds[0];
    // A nested selection is the case the small tools cannot cover, so the general edit tool is offered.
    server.script(envelopeReply('apply_operations', setHeaderName(header, 'Out of scope')), envelopeReply('finish', { message: 'I could not change that.' }));
    const { result } = await run('Rename the site', { owner: { kind: 'page', id: home.id }, instancePath: [section, 'n_inner'], nodeId: 'n_inner' }, 'Hero');
    expect(result?.status).toBe('no-changes');
    expect(headerName(session, header)).toBe(before);
    expect(toolResults().some((m) => m.content.includes('Error from apply_operations') && m.content.includes('SCOPE_MISMATCH'))).toBe(true);
  });

  it('still validates values, and feeds the error back to the model', async () => {
    const { session, run, header } = await setup();
    const before = headerName(session, header);
    server.script(envelopeReply('update_site_brand', { siteName: 'Nope', headingFont: 'Comic Sans' }), envelopeReply('finish', { message: 'That font is not available.' }));
    const { result } = await run('Rename the site');
    expect(result?.status).toBe('no-changes');
    expect(headerName(session, header)).toBe(before);
    expect(toolResults().some((m) => m.content.includes('Error from update_site_brand'))).toBe(true);
  });

  it('rejects a tool the run does not offer', async () => {
    const { run } = await setup();
    server.script(envelopeReply('run_shell', { command: 'cat ~/.ssh/id_rsa' }), envelopeReply('finish', { message: 'I cannot do that.' }));
    const { result } = await run('Read my keys');
    expect(result?.status).toBe('no-changes');
    expect(toolResults().some((m) => m.content.includes('Unknown tool'))).toBe(true);
  });

  it('applies nothing from a truncated reply and asks for smaller steps', async () => {
    const { session, run, header } = await setup();
    const whole = JSON.stringify({ brief_status: 'Working', action: { tool: 'update_site_brand', args: rename('Cut off') } });
    server.script(textReply(whole.slice(0, whole.length - 20), { finish: 'length' }), envelopeReply('update_site_brand', rename('Whole')), envelopeReply('finish', { message: 'Renamed.' }));
    const { result } = await run('Rename the site');
    expect(result?.status).toBe('completed');
    expect(headerName(session, header)).toBe('Whole');
    expect(toolResults().some((m) => m.content.includes('reached the output limit'))).toBe(true);
  });

  it('validates arguments against the tool schema before anything changes', async () => {
    const { session, run } = await setup();
    server.script(envelopeReply('update_site_brand', { siteName: 5 }), envelopeReply('finish', { message: 'Could not apply that.' }));
    const { result } = await run('Rename the site');
    expect(result?.status).toBe('no-changes');
    expect(session.revision).toBe(0);
    expect(toolResults().some((m) => m.content.includes('Error from update_site_brand') && m.content.includes('siteName'))).toBe(true);
  });

  it('refuses a real tool that this run does not offer', async () => {
    const { run } = await setup({}, {}, false);
    server.script(envelopeReply('read_source', { definitionId: 'foundation.hero.split' }), envelopeReply('finish', { message: 'Not available.' }));
    await run('Show me the source');
    expect(toolResults().some((m) => m.content.includes('Error from read_source') && m.content.includes('Unknown tool'))).toBe(true);
  });

  it('applies nothing from a complete action that was still cut off', async () => {
    const { session, run, header } = await setup();
    server.script(envelopeReply('update_site_brand', rename('Cut off'), 'Working', { finish: 'length' }), envelopeReply('finish', { message: 'Stopped.' }));
    await run('Rename the site');
    expect(session.revision).toBe(0);
    expect(headerName(session, header)).not.toBe('Cut off');
  });

  it('survives arguments that are valid JSON but not an object', async () => {
    const { run } = await setup({ toolMode: 'native' });
    server.script(toolCallReply('read_page', 'null'), toolCallReply('apply_operations', '{"operations":{}}'), textReply('I could not do that.'));
    const { result } = await run('Read the page');
    expect(result?.status).toBe('no-changes');
  });

  it('rolls an edit back when the model stalls later in the run', async () => {
    const { session, run, header } = await setup({}, { firstTokenTimeoutMs: 80, idleTimeoutMs: 80 });
    const before = headerName(session, header);
    server.script(envelopeReply('update_site_brand', rename('Half done')), { frames: [sseChunk({ role: 'assistant' }), sseChunk({ content: 'x' })], stallAfter: 1 });
    const { result } = await run('Rename the site');
    expect(result?.status).toBe('failed');
    expect(result?.error).toMatch(/did not start responding/);
    expect(headerName(session, header)).toBe(before);
  });

  it('ends a reply that streams without end at the time limit, keeping the valid work so far', async () => {
    const limit = LIMITS.localActiveMs;
    LIMITS.localActiveMs = 700;
    try {
      // A silent server would trip the idle timeout long before the limit; this one keeps sending real content.
      const { session, run, header } = await setup({}, { firstTokenTimeoutMs: 300, idleTimeoutMs: 300 });
      const before = headerName(session, header);
      server.script(envelopeReply('update_site_brand', rename('Harbor Coffee'), 'Renaming the site'), { frames: [sseChunk({ role: 'assistant' })], endless: { frame: sseChunk({ content: ' and more' }), everyMs: 20 } });
      const { runId, result } = await run('Rename the site, then keep going');
      expect(result).toMatchObject({ status: 'completed', canUndo: true, incomplete: true, error: 'time limit' });
      expect(result?.summary).toMatch(/time limit/);
      expect(headerName(session, header)).toBe('Harbor Coffee');
      await expect.poll(() => server.disconnects).toBe(1);
      expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(2);
      expect((await session.undoGroup(runId)).ok).toBe(true);
      expect(headerName(session, header)).toBe(before);
    } finally {
      LIMITS.localActiveMs = limit;
    }
  });

  it('gives a local model its own, longer time limit than a cloud one', async () => {
    const cloud = LIMITS.activeMs;
    LIMITS.activeMs = 150;
    try {
      // Slower than the cloud limit allows, as a local model reading a long prompt is.
      const slow = { ...envelopeReply('finish', { message: 'Nothing to change.' }), delayMs: 400 };
      const local = await setup();
      server.script(slow);
      expect((await local.run('Hello')).result).toMatchObject({ status: 'no-changes', summary: 'Nothing to change.' });
      const asCloud = await setup({}, {}, true, 'openai');
      server.script(slow);
      expect((await asCloud.run('Hello')).result).toMatchObject({ status: 'failed', error: 'time limit' });
    } finally {
      LIMITS.activeMs = cloud;
    }
    expect(LIMITS).toMatchObject({ activeMs: 10 * 60_000, localActiveMs: 30 * 60_000 });
  });

  it('fails clearly, with nothing changed, when no server is running', async () => {
    const port = await closedPort();
    const { session, run, header } = await setup({ baseURL: `http://127.0.0.1:${port}/v1` });
    const before = headerName(session, header);
    const started = Date.now();
    const { result } = await run('Rename the site');
    expect(result?.status).toBe('failed');
    expect(result?.summary).toMatch(/Is your local server running\?/);
    // Not retried with backoff: a server that is not running will not start in the meantime.
    expect(Date.now() - started).toBeLessThan(900);
    expect(headerName(session, header)).toBe(before);
  });
});

describe('orchestrator with native tool calls', () => {
  it('applies each edit even when the server repeats its tool call ID', async () => {
    const { session, run, header } = await setup({ toolMode: 'native' });
    server.script(toolCallReply('update_site_brand', rename('First'), { id: 'call_0' }), toolCallReply('update_site_brand', rename('Second'), { id: 'call_0' }), textReply('Renamed twice.'));
    const { result } = await run('Rename the site twice');
    expect(result?.status).toBe('completed');
    expect(headerName(session, header)).toBe('Second');
    expect(session.revision).toBe(2);
  });

  it('asks a strict chat template for smaller steps after a cut-off reply that followed a tool result', async () => {
    const { session, run, header } = await setup({ toolMode: 'native' });
    server.script(toolCallReply('update_site_brand', rename('Harbor Coffee')), textReply('Now the pages', { finish: 'length' }), textReply('Renamed the site.'));
    const { result } = await run('Rename the site to Harbor Coffee');
    expect(result).toMatchObject({ status: 'completed', summary: 'Renamed the site.' });
    expect(headerName(session, header)).toBe('Harbor Coffee');
    const sent = server.requests.filter((r) => r.method === 'POST').map((r) => r.body.messages);
    expect(sent).toHaveLength(3);
    for (const messages of sent) renderStrictTemplate(messages);
    expect(sent[2].map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
    // The cut-off reply is never replayed: a short bridge stands between the result and the request for smaller steps.
    expect(sent[2][4]).toEqual({ role: 'assistant', content: 'I have read the results.' });
    expect(JSON.stringify(sent[2])).not.toContain('Now the pages');
    expect(sent[2].at(-1).content).toMatch(/^Your last response reached the output limit.*smaller steps/s);
  });

  it('recovers from malformed fragmented arguments', async () => {
    const { session, run, header } = await setup({ toolMode: 'native' });
    server.script(toolCallReply('update_site_brand', '{"siteName": "unterminated'), toolCallReply('update_site_brand', rename('Fixed')), textReply('Renamed.'));
    const { result } = await run('Rename the site');
    expect(result?.status).toBe('completed');
    expect(headerName(session, header)).toBe('Fixed');
  });
});

describe('tool selection follows the capability profile', () => {
  const sent = () => server.requests.find((r) => r.method === 'POST')!.body;
  const profile = (over: Partial<LocalModelProfile>): LocalModelProfile => ({ ...DEFAULT_LOCAL_PROFILE, ...over });
  const offered = () => (sent().tools as Array<{ function: { name: string } }>).map((t) => t.function.name);

  it('gives a default profile the small set, as a closed grammar', async () => {
    const { run } = await setup();
    server.script(envelopeReply('finish', { message: 'Nothing to do.' }));
    await run('Hello');
    const schema = sent().response_format.json_schema.schema;
    expect(findForbiddenShapes(schema)).toEqual([]);
    const names = schema.properties.action.anyOf.map((b: { properties: { tool: { enum: string[] } } }) => b.properties.tool.enum[0]);
    expect(names).toContain('upsert_page_with_sections');
    expect(names).not.toContain('apply_operations');
  });

  it('a native profile with a large window keeps the general tools', async () => {
    const { run } = await setup({}, { profile: profile({ toolCalling: 'native', contextWindow: FOCUSED_WINDOW_TOKENS }) });
    server.script(textReply('Nothing to do.'));
    await run('Hello');
    expect(offered()).toContain('apply_operations');
  });

  it('a native profile with a small window gets the small set', async () => {
    const { run } = await setup({}, { profile: profile({ toolCalling: 'native', contextWindow: FOCUSED_WINDOW_TOKENS - 1 }) });
    server.script(textReply('Nothing to do.'));
    await run('Hello');
    expect(offered()).toContain('upsert_page_with_sections');
    expect(offered()).not.toContain('apply_operations');
  });

  it('a constrained profile gets the small set whatever its window', async () => {
    const { run } = await setup({}, { profile: profile({ toolCalling: 'constrained-json', contextWindow: 500_000 }) });
    server.script(envelopeReply('finish', { message: 'Nothing to do.' }));
    await run('Hello');
    expect(JSON.stringify(sent().response_format)).not.toContain('"apply_operations"');
  });
});

describe('the loaded context window', () => {
  const llamaOverflow = (prompt: number, ctx: number) => ({
    status: 400,
    body: JSON.stringify({ error: { code: 400, message: `request (${prompt} tokens) exceeds the available context size (${ctx} tokens), try increasing it`, type: 'exceed_context_size_error', n_prompt_tokens: prompt, n_ctx: ctx } })
  });
  const chatPosts = () => server.requests.filter((r) => r.method === 'POST');
  /** The app's own estimate of a native request as it went out. */
  const estimateOf = (body: Record<string, any>) => {
    const tools: ToolDefinition[] = (body.tools ?? []).map((t: { function: ToolDefinition }) => t.function);
    const items = body.messages.slice(1).map((m: { content: string }) => ({ kind: 'user' as const, text: m.content }));
    return estimateRequestTokens(body.messages[0].content, tools, items);
  };

  it('explains a first request the server cannot hold as a setup problem, not a long conversation', async () => {
    const { session, run } = await setup();
    server.script(llamaOverflow(8200, 4096));
    const { result } = await run('Hi');
    expect(result?.status).toBe('failed');
    expect(result?.summary).not.toMatch(/start a new conversation/i);
    expect(result?.summary).toMatch(/4,096-token context/);
    // The server's own count: 8,200 tokens of prompt and a short reply, rounded up to the next 1,024.
    expect(result?.summary).toMatch(/at least 10,240 tokens(?! \(an estimate\))/);
    // The error's shape identifies llama.cpp, so the advice names its setting.
    expect(result?.summary).toMatch(/--ctx-size 32768/);
    // The fix is the server's and its size in Settings, so the card offers them (#83).
    expect(result?.repair).toBe('settings');
    expect(chatPosts()).toHaveLength(1);
    expect(session.revision).toBe(0);
  });

  it("reads the server's loaded size in the app's own factory, and refuses before sending", async () => {
    // A constrained request is counted as it is sent, its tools as signatures: a blank site's "Hi" needs about 4,096.
    server.routes['/api/ps'] = { body: { models: [{ name: 'test-model', model: 'test-model', context_length: 2048 }] } };
    const { run } = await setup({}, {}, true, 'local', 'blank', true);
    const { result } = await run('Hi');
    expect(result?.status).toBe('failed');
    expect(result?.summary).toMatch(/2,048-token context/);
    expect(result?.summary).toMatch(/OLLAMA_CONTEXT_LENGTH/);
    expect(chatPosts()).toHaveLength(0);
  });

  it('ends a run stopped while the server is asked about its model, before anything is locked or sent', async () => {
    server.routes['/api/ps'] = { body: { models: [] }, delayMs: 3000 };
    const { session, run, orch } = await setup({ model: 'test-model' }, {}, true, 'local', 'business', true);
    setTimeout(() => orch.stop(), 100);
    const started = Date.now();
    const { result } = await run('Hi');
    expect(result?.status).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(900);
    expect(chatPosts()).toHaveLength(0);
    // Nothing was locked, so the next request starts normally.
    server.routes = {};
    server.script(envelopeReply('finish', { message: 'Hello.' }));
    expect((await run('Hi')).result?.status).toBe('no-changes');
    expect(session.revision).toBe(0);
  });

  it('refuses a blank-site "Hi" before sending it when the known window cannot hold it', async () => {
    const { session, run } = await setup({}, { context: { windowTokens: 2048, server: 'ollama' } }, true, 'local', 'blank');
    const { result } = await run('Hi');
    expect(result?.status).toBe('failed');
    expect(result?.summary).toMatch(/2,048-token context/);
    const minimum = Number(/at least ([\d,]+) tokens \(an estimate\)/.exec(result?.summary ?? '')?.[1].replace(/,/g, ''));
    expect(minimum).toBeGreaterThan(2048);
    expect(minimum % 1024).toBe(0);
    expect(result?.summary).toMatch(/OLLAMA_CONTEXT_LENGTH/);
    expect(result?.summary).not.toMatch(/start a new conversation/i);
    // Ollama would have cut the prompt down without a word, so nothing is sent.
    expect(chatPosts()).toHaveLength(0);
    expect(session.revision).toBe(0);
  });

  it('fits the reply into a small configured window', async () => {
    const window = 12_288;
    const { run } = await setup({ contextWindow: window, toolMode: 'native' });
    server.script(textReply('Hello.'));
    const { result } = await run('Hi');
    expect(result?.status).toBe('no-changes');
    const body = chatPosts()[0].body;
    expect(body.max_tokens).toBeLessThan(DEFAULT_LOCAL_PROFILE.maxOutput);
    expect(body.max_tokens).toBeGreaterThanOrEqual(1024);
    expect(estimateOf(body) + body.max_tokens).toBeLessThanOrEqual(window);
  });

  it('keeps the full reply budget in a normal larger window', async () => {
    // The profile guesses less, so the full reply depends on the size set in Settings.
    const { run } = await setup({ contextWindow: 32_768, toolMode: 'native' }, { profile: { ...DEFAULT_LOCAL_PROFILE, contextWindow: 8192 } });
    server.script(textReply('Hello.'));
    await run('Hi');
    expect(chatPosts()[0].body.max_tokens).toBe(DEFAULT_LOCAL_PROFILE.maxOutput);
  });

  it('uses a larger window the server reports, capped by the size set in Settings', async () => {
    const reported = await setup({ toolMode: 'native' }, { context: { windowTokens: 65_536, server: 'lm-studio' }, profile: { ...DEFAULT_LOCAL_PROFILE, contextWindow: 8192 } });
    server.script(textReply('Hello.'));
    await reported.run('Hi');
    expect(chatPosts()[0].body.max_tokens).toBe(DEFAULT_LOCAL_PROFILE.maxOutput);
    server.requests.length = 0;
    const { run } = await setup({ contextWindow: 12_288, toolMode: 'native' }, { context: { windowTokens: 65_536, server: 'lm-studio' } });
    server.script(textReply('Hello.'));
    await run('Hi');
    expect(chatPosts()[0].body.max_tokens).toBeLessThan(DEFAULT_LOCAL_PROFILE.maxOutput);
  });

  it('advises a new conversation when the earlier messages are what no longer fit', async () => {
    const { run } = await setup({ contextWindow: 24_576, toolMode: 'native' });
    server.script(textReply('x'.repeat(80_000)));
    await run('Hi');
    const { result } = await run('Hi again');
    expect(result?.status).toBe('failed');
    expect(result?.summary).toMatch(/Start a new conversation/);
    expect(result?.summary).toMatch(/24,576-token context/);
    expect(chatPosts()).toHaveLength(1);
  });

  it('tells a long conversation from a setup problem by the server count too', async () => {
    const { run } = await setup({ toolMode: 'native' });
    server.script(textReply('x'.repeat(80_000)));
    await run('Hi');
    server.script(llamaOverflow(30_000, 16_384));
    const { result } = await run('Hi again');
    expect(result?.status).toBe('failed');
    expect(result?.summary).toMatch(/Start a new conversation/);
    expect(result?.summary).toMatch(/16,384-token context/);
  });

  it('keeps the valid work when the context fills up after a change', async () => {
    const { session, run, header } = await setup();
    server.script(envelopeReply('update_site_brand', rename('Kept')), llamaOverflow(9000, 8192));
    const { result } = await run('Rename the site');
    expect(result).toMatchObject({ status: 'completed', incomplete: true, canUndo: true });
    expect(headerName(session, header)).toBe('Kept');
  });

  it('offers only the small tools when the general ones would not fit a known window', async () => {
    // Measure both requests for this project, then replay a conversation that leaves room for one but not the other.
    const measure = async (window: number) => {
      const { run } = await setup({ contextWindow: window, toolMode: 'native' });
      server.script(textReply('ok'));
      await run('Hi');
      const body = chatPosts().at(-1)!.body;
      return { estimate: estimateOf(body), names: (body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name) };
    };
    const general = await measure(FOCUSED_WINDOW_TOKENS);
    const focused = await measure(FOCUSED_WINDOW_TOKENS - 1);
    expect(general.names).toContain('apply_operations');
    expect(focused.names).not.toContain('apply_operations');
    expect(general.estimate - focused.estimate).toBeGreaterThan(2000);
    const history = FOCUSED_WINDOW_TOKENS - 1024 - Math.round((general.estimate + focused.estimate) / 2);

    const before = chatPosts().length;
    const { run } = await setup({ contextWindow: FOCUSED_WINDOW_TOKENS, toolMode: 'native' });
    server.script(textReply('x'.repeat(history * 4)), textReply('Done.'));
    await run('Hi');
    const { result } = await run('Hi');
    expect(result?.status).toBe('no-changes');
    const sent = chatPosts().slice(before);
    expect(sent).toHaveLength(2);
    expect((sent[1].body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).not.toContain('apply_operations');
    // Three full runs and a long replayed history: slower than most under a loaded machine.
  }, 20_000);

  it('tries the small tools once when the server refuses the first request a known window was thought to hold', async () => {
    const { run } = await setup({ contextWindow: FOCUSED_WINDOW_TOKENS, toolMode: 'native' });
    server.script(llamaOverflow(FOCUSED_WINDOW_TOKENS + 500, FOCUSED_WINDOW_TOKENS), textReply('Done.'));
    const { result } = await run('Hi');
    expect(result?.status).toBe('no-changes');
    const names = (i: number) => (chatPosts()[i].body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(chatPosts()).toHaveLength(2);
    expect(names(0)).toContain('apply_operations');
    expect(names(1)).not.toContain('apply_operations');
  });

  it('never sends a question again unchanged, since it has no smaller tools', async () => {
    const { run } = await setup({ contextWindow: FOCUSED_WINDOW_TOKENS, toolMode: 'native' });
    server.script({ status: 400, body: JSON.stringify({ error: { message: 'prompt is too long' } }) });
    const { result } = await run('What is on this page?', null, null, 'ask');
    expect(result?.status).toBe('failed');
    expect(chatPosts()).toHaveLength(1);
  });

  it('keeps the tools a run started with when the server reports a smaller window part way through', async () => {
    const { run } = await setup({ toolMode: 'native' }, { context: { windowTokens: 200_000 } }, true, 'local', 'blank');
    const vllm = JSON.stringify({ code: 400, message: "This model's maximum context length is 48000 tokens. However, you requested 50192 tokens (42000 in the messages, 8192 in the completion)." });
    server.script({ frames: [`error: ${vllm}\n\n`] }, toolCallReply('read_project', {}), textReply('Done.'));
    const { result } = await run('What do I have?');
    expect(result?.status).toBe('no-changes');
    const names = (i: number) => (chatPosts()[i].body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(chatPosts().map((p) => p.body.max_tokens)).toEqual([8192, 6000, expect.any(Number)]);
    // 48,000 is below the size where the small set takes over, but the run already offered apply_operations.
    expect(names(0)).toContain('apply_operations');
    expect(names(2)).toContain('apply_operations');
  });

  it('does not ask a server again when there are no smaller tools to offer', async () => {
    const { run } = await setup({ toolMode: 'native' }, { profile: { ...DEFAULT_LOCAL_PROFILE, toolCalling: 'native', contextWindow: 4096 } });
    server.script(llamaOverflow(9000, 4096));
    const { result } = await run('Hi');
    expect(result?.status).toBe('failed');
    expect(chatPosts()).toHaveLength(1);
  });
});

describe('why a request does not fit', () => {
  const user = (chars: number): CanonicalItem => ({ kind: 'user', text: 'u'.repeat(chars) });
  const said = (chars: number): CanonicalItem => ({ kind: 'assistant', text: 'a'.repeat(chars), toolCalls: [] });
  const result = (chars: number): CanonicalItem => ({ kind: 'tool_result', callId: 'c', name: 'read_page', content: 'r'.repeat(chars) });
  const base = { system: 's'.repeat(4000), tools: [] as ToolDefinition[], maxOutputTokens: 8192 };

  it('counts text outside ASCII as a token a character, so it cannot slip past a window it overflows', () => {
    expect(estimateRequestTokens('', [], [user(4000)])).toBe(1000);
    const han: CanonicalItem = { kind: 'user', text: '漢'.repeat(4000) };
    expect(estimateRequestTokens('', [], [han])).toBe(4000);
    expect(estimateRequestTokens('', [], [{ kind: 'user', text: 'ひらがな한국어' }])).toBe(7);
    // Accented Latin, smart punctuation and emoji keep the usual rate.
    expect(estimateRequestTokens('', [], [{ kind: 'user', text: 'é—“😀'.repeat(200) }])).toBe(250);
    const v = contextVerdict({ ...base, system: '', items: [han], current: han, windowTokens: 4096, maxOutputTokens: 8192, rejected: false });
    expect(v.kind).toBe('setup');
  });

  it('takes the minimum from the server count of the prompt, not from the window it refused', () => {
    const current = user(20_000);
    // A reply that did not fit beside a 6,000-token prompt says nothing about the prompt itself.
    const v = contextVerdict({ ...base, items: [current], current, windowTokens: 8192, reported: { windowTokens: 8192, promptTokens: 7000 }, rejected: true });
    // 7,000 counted plus a 1,024-token reply, not the 6,000 the app estimates nor the window it refused.
    expect(v.minimumTokens).toBe(8192);
    expect(v.estimated).toBe(false);
  });

  it('does not tell a model it never heard about to start a new conversation', () => {
    const current = user(400);
    const v = contextVerdict({ ...base, items: [user(8), said(400), current], current, reported: {}, rejected: true });
    expect(v.kind).toBe('unclear');
    // Refused with nothing before it, the message alone is too much, whatever the size.
    expect(contextVerdict({ ...base, items: [current], current, reported: {}, rejected: true }).kind).toBe('setup');
  });

  it("blames the run's own reads, not a short history, when they are what fill the window", () => {
    const current = user(4000);
    const v = contextVerdict({ ...base, items: [user(400), said(400), current, said(40), result(24_000)], current, windowTokens: 8192, rejected: false });
    expect(v.kind).toBe('run');
    const long = contextVerdict({ ...base, items: [user(400), said(30_000), current], current, windowTokens: 8192, rejected: false });
    expect(long.kind).toBe('conversation');
  });

  it('marks a minimum projected from a count that included earlier messages as an estimate', () => {
    const current = user(16_000);
    // 1,000 + 10,000 + 4,000 estimated, as the server counted: this message alone still needs over 6,000.
    const v = contextVerdict({ ...base, items: [said(40_000), current], current, windowTokens: 4096, reported: { windowTokens: 4096, promptTokens: 30_000 }, rejected: true });
    expect(v.kind).toBe('setup');
    expect(v.estimated).toBe(true);
    // The server counted twice the estimate, so this message's 5,000 estimated tokens are taken as 10,000.
    expect(v.minimumTokens).toBe(11_264);
  });
});

describe('what a constrained local run sends first (#364)', () => {
  /**
   * UTF-8 bytes of `messages` + `response_format` in the first request, for the business starter. The baselines are
   * what develop sent before #364 (pretty-printed context, full schema, TypeScript-style signatures and every
   * tool's long description). The budgets hold today's sizes with a little room: a change that grows a prompt past
   * one should be a deliberate decision.
   *
   * The SEO audit (#593) is one: audit_seo is offered to every run that may read the whole site, and costs each its
   * `audit` bytes (its grammar branch, its signature and brief, and the search settings the project summary now says
   * the site and its pages have; a page run starts with the compact summary, which has none). Their budgets make room
   * for it, and everything else they send still has to be a quarter smaller than before #364.
   *
   * Keeping pasted copy as written (#515) is another: every edit run is told to keep the copy the user supplies, and
   * a run with the page tool reads in its brief how a pasted draft becomes the page's sections and when the sections
   * already there go. Their `copy` bytes are made room for in the same way.
   */
  /** What audit_seo adds to a run that offers it, with a little room. */
  const AUDIT_BYTES = 850;
  /**
   * See-through colors and backdrop blur (#353) are another: a run that styles its selection takes a color token's
   * strength in its grammar, and its brief says how to use it with backdrop blur, about 160 bytes. Their budgets make
   * room for it the same way.
   */
  const FROSTED_BYTES = 170;
  const PAGE_AUDIT_BYTES = 650;
  /** The supplied-copy rule every edit run is given (41 bytes), and with the page tool its brief's rules (204 more). */
  const COPY_BYTES = 50;
  const PAGE_COPY_BYTES = COPY_BYTES + 220;
  const BUDGETS = {
    // The site runs offer every catalogue section to insert, so a new section (the Carousel's ~830 bytes) grows them.
    // They also start with the open page's sections (#513): about 1 KB for the starter's eight-section home page.
    site: { code: false, baseline: 42_641, budget: 32_400 + AUDIT_BYTES + PAGE_COPY_BYTES, audit: AUDIT_BYTES, frosted: 0, copy: PAGE_COPY_BYTES },
    'site (code)': { code: true, baseline: 44_027, budget: 33_700 + AUDIT_BYTES + PAGE_COPY_BYTES, audit: AUDIT_BYTES, frosted: 0, copy: PAGE_COPY_BYTES },
    // A page run (#513) is measured against the site run it was before it had a scope of its own. It offers the page
    // tool and the few operations that remove, move or set the page's own settings, but nothing site-wide.
    page: { code: false, baseline: 42_641, budget: 31_700 + PAGE_AUDIT_BYTES + PAGE_COPY_BYTES, audit: PAGE_AUDIT_BYTES, frosted: 0, copy: PAGE_COPY_BYTES },
    section: { code: false, baseline: 12_723, budget: 9_700 + FROSTED_BYTES + COPY_BYTES, audit: 0, frosted: FROSTED_BYTES, copy: COPY_BYTES },
    part: { code: false, baseline: 10_001, budget: 7_550 + FROSTED_BYTES + COPY_BYTES, audit: 0, frosted: FROSTED_BYTES, copy: COPY_BYTES },
    ask: { code: false, baseline: 13_138, budget: 9_600 + AUDIT_BYTES, audit: AUDIT_BYTES, frosted: 0, copy: 0 },
    'ask (code)': { code: true, baseline: 13_736, budget: 10_100 + AUDIT_BYTES, audit: AUDIT_BYTES, frosted: 0, copy: 0 }
  } as const;
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

  it.each(Object.entries(BUDGETS))('keeps the %s run within its budget', async (label, { code, baseline, budget, audit, frosted, copy }) => {
    const { session, run } = await setup({ toolMode: 'constrained-json' }, {}, code);
    const home = session.state.pages[session.state.site.homePageId];
    const section = home.nodes[home.rootIds[0]] as { id: string; definitionId: string };
    const def = session.state.components[section.definitionId];
    // The two selections the editor sends: a whole section, and one part of it.
    const selection: ElementRef | null = label === 'section' ? { owner: { kind: 'page', id: home.id }, instancePath: [], nodeId: section.id } : label === 'part' ? { owner: { kind: 'page', id: home.id }, instancePath: [section.id], nodeId: def.parts.heading.nodeId, partId: 'heading' } : null;
    server.script(envelopeReply('finish', { message: 'Done.' }));
    await run('Hello', selection, selection ? 'Hero' : null, label.startsWith('ask') ? 'ask' : undefined, undefined, label === 'page' ? 'page' : undefined);
    const body = server.requests.find((r) => r.method === 'POST')!.body;
    const sent = { messages: bytes(body.messages), response_format: bytes(body.response_format) };
    const total = sent.messages + sent.response_format;
    expect(total, JSON.stringify(sent)).toBeLessThanOrEqual(budget);
    expect(1 - (total - audit - frosted - copy) / baseline, JSON.stringify(sent)).toBeGreaterThan(0.24);
    // The room is made only where the tool is offered.
    expect(JSON.stringify(body.response_format).includes('"audit_seo"'), label).toBe(audit > 0);
    // Still the strict grammar, in its compact form, and the context unindented, with all it said before.
    expect(body.response_format.type).toBe('json_schema');
    expect(JSON.stringify(body.response_format.json_schema.schema)).not.toContain('"type":"string","enum"');
    expect(findForbiddenShapes(body.response_format.json_schema.schema)).toEqual([]);
    const context = JSON.parse(/<editor_context>\n(\{.*\})\n<\/editor_context>/s.exec(body.messages.at(-1).content)![1]);
    expect(context.selection === null, label).toBe(!selection);
    if (selection) expect(context.selection.currentProps ?? context.selection.node.props).toHaveProperty('heading');
    expect(context.allowedScope, label).toMatch(label.startsWith('ask') ? /^nothing: this is a read-only question$/ : label === 'section' ? /^only Hero \(.*\) unless the user approves more via request_wider_scope$/ : label === 'part' ? /^only the selected part "heading" of Hero/ : label === 'page' ? /^only the Home page \(page pg_\w+\): its sections and its own settings/ : /^whole site$/);
    // An edit that may change the page starts with its sections; one about a selection starts from the selection.
    expect(Array.isArray(context.currentPage.sections), label).toBe(label === 'page' || label.startsWith('site'));
    if (Array.isArray(context.currentPage.sections)) expect(context.currentPage.sections.map((x: { id: string }) => x.id)).toEqual(home.rootIds);
    // A question can still be about code; an edit run without code has no code tool to explain.
    expect('customCode' in context, label).toBe(code || label.startsWith('ask'));
  });

  it('makes the same change from a constrained reply as from a native call', async () => {
    const results: unknown[] = [];
    for (const toolMode of ['constrained-json', 'native'] as const) {
      const sentBefore = server.requests.length;
      const { session, run } = await setup({ toolMode });
      const home = session.state.pages[session.state.site.homePageId];
      const ref: ElementRef = { owner: { kind: 'page', id: home.id }, instancePath: [], nodeId: home.rootIds[0] };
      const args = { props: { heading: 'Sharper', image: { assetId: null, alt: 'A calm room' } }, variants: { tone: 'muted' } };
      server.script(...(toolMode === 'native' ? [toolCallReply('update_selected_props', args), textReply('Done.')] : [envelopeReply('update_selected_props', args), envelopeReply('finish', { message: 'Done.' })]));
      const { result } = await run('Tighten this headline', ref, 'Hero');
      expect(result?.status, toolMode).toBe('completed');
      // Each in its own form: signatures in the prompt and a grammar, or native tools and the toured prompt.
      const first = server.requests.slice(sentBefore).find((r) => r.method === 'POST')!.body;
      if (toolMode === 'native') expect([first.tools?.length > 0, first.messages[0].content.includes('- update_selected_props changes its content')]).toEqual([true, true]);
      else expect([first.tools, first.response_format.type, first.messages[0].content.includes('\n- update_selected_props {props:')]).toEqual([undefined, 'json_schema', true]);
      const node = session.state.pages[home.id].nodes[home.rootIds[0]] as { props: Record<string, unknown>; variants?: Record<string, string> };
      results.push({ heading: node.props.heading, image: node.props.image, tone: node.variants?.tone });
    }
    expect(results[0]).toEqual({ heading: 'Sharper', image: { assetId: null, alt: 'A calm room' }, tone: 'muted' });
    expect(results[1]).toEqual(results[0]);
  });
});

describe("a component's design on a small model (#360)", () => {
  const posts = () => server.requests.filter((r) => r.method === 'POST').map((r) => r.body);
  const grammar = (body: Record<string, any>) => JSON.stringify(body.response_format.json_schema.schema);

  /** The Split hero copied for editing everywhere, as the editor makes one. */
  async function editEverywhere(session: ProjectSession) {
    const home = session.state.pages[session.state.site.homePageId];
    const made = await session.apply({ operations: [{ type: 'component.fork', definitionId: (home.nodes[home.rootIds[0]] as unknown as { definitionId: string }).definitionId }] }, { label: 'Edit everywhere', source: 'user' });
    const id = (made.results?.[0] as { definitionId: string }).definitionId;
    return { id, owner: { kind: 'component' as const, id } };
  }

  it('adds a property, binds a condition to it, exposes a part and styles a variant option, without apply_operations', async () => {
    const { session, run } = await setup({}, {}, false);
    const { id } = await editEverywhere(session);
    const before = structuredClone(session.state.components[id]);
    server.script(
      envelopeReply('manage_component_prop', { change: { action: 'add', prop: 'showButtons', label: 'Show buttons', type: 'boolean', default: true } }),
      envelopeReply('bind_definition_field', { nodeId: 'actions', field: 'when', binding: { $prop: 'showButtons' } }),
      envelopeReply('edit_definition_node', { nodeId: 'content', exposeAsPart: { partId: 'copy', label: 'Copy' } }),
      envelopeReply('style_definition_element', { partId: 'copy', variant: { axis: 'tone', option: 'muted' }, scope: 'phone', styles: [{ property: 'gap', value: { token: 'space.lg' } }] }),
      envelopeReply('finish', { message: 'Added a Show buttons switch, a Copy part and a muted phone gap.' })
    );
    const { runId, result } = await run('Let authors hide the buttons, and tighten the copy on muted phones', null, null, undefined, { id, name: 'Split hero' });
    expect(result?.status).toBe('completed');
    expect(toolResults().some((m) => m.content.includes('Error from'))).toBe(false);
    // Every step was held to the small, closed grammar of the design's own tools, rebuilt from the design as it changed.
    const bodies = posts();
    expect(bodies).toHaveLength(5);
    for (const b of bodies) {
      expect(findForbiddenShapes(b.response_format.json_schema.schema)).toEqual([]);
      expect(grammar(b)).not.toContain('apply_operations');
      expect(grammar(b)).toContain('style_definition_element');
    }
    expect(grammar(bodies[0])).not.toContain('"showButtons"');
    expect(grammar(bodies[1])).toContain('"showButtons"');
    expect(grammar(bodies[3])).toContain('"copy"');
    const def = session.state.components[id];
    expect(def.properties.showButtons).toMatchObject({ type: 'boolean', label: 'Show buttons', default: true });
    expect(def.tree!.nodes.actions.when).toEqual({ $prop: 'showButtons' });
    expect(def.parts.copy).toMatchObject({ nodeId: 'content', label: 'Copy' });
    expect(def.variantAxes!.tone.options.muted.styles).toMatchObject({ content: { phone: { gap: { token: 'space.lg' } } } });
    // Only the muted option's rule: the base style and the other options are as they were.
    expect(def.tree!.nodes.content.styles).toEqual(before.tree!.nodes.content.styles);
    expect(def.variantAxes!.tone.options.inverse).toEqual(before.variantAxes!.tone.options.inverse);
    // One undo takes the whole request back.
    expect((await session.undoGroup(runId)).ok).toBe(true);
    expect(session.state.components[id]).toEqual(before);
  });

  it('tells a small model to read shortened text whole before it rewrites it', async () => {
    const { session, run } = await setup({}, {}, false);
    const { id, owner } = await editEverywhere(session);
    const long = `${'Every room is made by hand from local timber and finished with natural oils. '.repeat(5)}The end.`;
    expect((await session.apply({ operations: [{ type: 'node.setBinding', owner, nodeId: 'lead', field: 'text', binding: null }, { type: 'node.setContent', owner, nodeId: 'lead', field: 'text', value: long }] }, { label: 'Long lead', source: 'user' })).ok).toBe(true);
    server.script(envelopeReply('finish', { message: 'Nothing to change.' }));
    await run('Fix the typo at the end of the intro', { owner, instancePath: [], nodeId: 'content' }, 'Content', undefined, { id, name: 'Split hero' });
    const first = posts()[0];
    expect(grammar(first)).toContain('inspect_element');
    expect(first.messages[0].content).toContain('read text shown shortened (ending in …) whole with inspect_element');
  });

  it('keeps a node selected in the design to what is inside it', async () => {
    const { session, run } = await setup({}, {}, false);
    const { id, owner } = await editEverywhere(session);
    server.script(
      envelopeReply('manage_component_prop', { change: { action: 'add', prop: 'headline', label: 'Headline', type: 'string', default: 'Made by hand' } }),
      envelopeReply('bind_definition_field', { nodeId: 'heading', field: 'text', binding: { $prop: 'headline' } }),
      // The text of a bound heading is the default every placement without its own value shows: more than the selection.
      envelopeReply('edit_definition_node', { nodeId: 'heading', content: { text: 'Hello' } }),
      envelopeReply('edit_definition_node', { nodeId: 'content', exposeAsPart: { partId: 'copy', label: 'Copy' } }),
      envelopeReply('style_definition_element', { variant: { axis: 'layout', option: 'media-start' }, scope: 'base', styles: [{ property: 'gap', value: { token: 'space.lg' } }] }),
      envelopeReply('finish', { message: 'Bound the heading to a new Headline field.' })
    );
    const { result } = await run('Give the heading its own field', { owner, instancePath: [], nodeId: 'content' }, 'Content', undefined, { id, name: 'Split hero' });
    expect(result?.status).toBe('completed');
    const first = posts()[0];
    // The node selected and what is inside it: nothing beside it is offered, and the contract only grows.
    expect(grammar(first)).not.toContain('"media"');
    // The binding is held to the grammar sent after the property was added, which offers it.
    expect(grammar(first)).not.toContain('"headline"');
    expect(grammar(posts()[1])).toContain('"headline"');
    expect(grammar(first)).not.toContain('"remove"');
    expect(grammar(first)).not.toContain('apply_operations');
    // Each later request replays the conversation, so the one refusal is counted once.
    const refused = [...new Set(toolResults().filter((m) => m.content.includes('Error from')).map((m) => m.content))];
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/edit_definition_node[\s\S]*SCOPE_MISMATCH[\s\S]*every placement of this component without its own value/);
    const def = session.state.components[id];
    expect((def.tree!.nodes.heading as { text?: unknown }).text).toEqual({ $prop: 'headline' });
    expect(def.properties.headline.default).toBe('Made by hand');
    expect(def.parts.copy.nodeId).toBe('content');
    expect(def.variantAxes!.layout.options['media-start'].styles).toMatchObject({ content: { base: { gap: { token: 'space.lg' } } } });
  });
});

describe('a request that fails on the local setup (#83)', () => {
  const rejected = (message: string) => ({ status: 400, body: JSON.stringify({ error: { message } }) });

  it('says nothing changed and points to AI settings when no server answers', async () => {
    const port = await closedPort();
    const { session, run, header } = await setup({ baseURL: `http://127.0.0.1:${port}/v1` });
    const before = headerName(session, header);
    const { result } = await run('Rename the site to Harbor Coffee');
    expect(result).toMatchObject({ status: 'failed', repair: 'settings', canUndo: false });
    expect(result?.summary).toMatch(/^The AI request failed: Could not connect to a model server at .+ Is your local server running\? Nothing in the site was changed\.$/);
    expect(headerName(session, header)).toBe(before);
  });

  it('does the same for a listed model that rejects the chat request', async () => {
    const { session, run, header } = await setup();
    const before = headerName(session, header);
    // Refused with the compact schema and again with the full one (#364).
    server.script(rejected('studio-b cannot generate chat completions'), rejected('studio-b cannot generate chat completions'));
    const { result } = await run('Rename the site to Harbor Coffee');
    expect(result).toMatchObject({ status: 'failed', repair: 'settings', summary: 'The AI request failed: studio-b cannot generate chat completions Nothing in the site was changed.' });
    expect(headerName(session, header)).toBe(before);
  });

  it("offers no setup fix for a failure that is the request's own, such as a request too large for the server", async () => {
    const { run } = await setup();
    server.script({ status: 413, body: JSON.stringify({ error: { message: 'Payload too large' } }) });
    const { result } = await run('Rename the site to Harbor Coffee');
    expect(result).toMatchObject({ status: 'failed', summary: 'The AI request failed: Payload too large' });
    expect(result?.repair).toBeUndefined();
  });

  it('says the project was restored when the model failed after changing it', async () => {
    const { session, run, header } = await setup();
    const before = headerName(session, header);
    server.script(envelopeReply('update_site_brand', rename('Harbor Coffee'), 'Renaming the site'), rejected('the model crashed'), rejected('the model crashed'));
    const { result } = await run('Rename the site to Harbor Coffee');
    expect(result).toMatchObject({ status: 'failed', repair: 'settings', summary: 'The AI request failed: the model crashed The project was restored to how it was before this request.' });
    expect(headerName(session, header)).toBe(before);
  });

  it('carries the repair of a setup error found before the request starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-local-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, createStarterState('business', 'Test', false));
    const events: AiEvent[] = [];
    const orch = new Orchestrator({
      session: () => session,
      adapter: async () => ({ error: 'Connected, but the server has no models loaded.', repair: 'settings' }),
      emit: (e) => events.push(e),
      compileAll: async () => [],
      inspectLayout: async () => ({ issues: [] }),
      onBusyChange: () => undefined,
      codeEnabled: async () => true
    });
    const ctx: ChatContext = { pageId: session.state.site.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280 };
    expect((await orch.send('Add a page', ctx)).ok).toBe(true);
    await expect.poll(() => orch.busy, { timeout: 5000, interval: 5 }).toBe(false);
    const result = [...events].reverse().find((e) => e.kind === 'message' && e.message?.result)?.message?.result;
    expect(result).toMatchObject({ status: 'failed', repair: 'settings', summary: 'Connected, but the server has no models loaded. Nothing in the site was changed.' });
    // A question could never change anything, so it does not say so.
    expect((await orch.send('Which pages are there?', { ...ctx, mode: 'ask' })).ok).toBe(true);
    await expect.poll(() => orch.busy, { timeout: 5000, interval: 5 }).toBe(false);
    const asked = [...events].reverse().find((e) => e.kind === 'message' && e.message?.result)?.message?.result;
    expect(asked).toMatchObject({ status: 'failed', repair: 'settings', summary: 'Connected, but the server has no models loaded.' });
  });
});

describe('the open page in the first request (#513)', () => {
  it("fits a long page's sections into an eighth of the window, and lists each one it shows whole", () => {
    let state = createStarterState('business', 'Test', false);
    const home = state.site.homePageId;
    // Thirty sections, most with headings longer than a glance shows, in a script that costs about a token a character.
    const heading = '長い見出しの文章'.repeat(10);
    state = applyOperations(state, Array.from({ length: 22 }, () => ({ type: 'node.insert' as const, owner: { kind: 'page' as const, id: home }, componentId: 'intro.page', props: { heading } }))).state;
    const roots = state.pages[home].rootIds;
    expect(roots).toHaveLength(30);
    expect([pageGlanceChars(8192), pageGlanceChars(32_768), pageGlanceChars(400_000)]).toEqual([1024, 4096, 4096]);
    for (const window of [8192, 16_384, 32_768])
      for (const indent of [undefined, 1]) {
        const max = pageGlanceChars(window);
        const g = pageGlance(state, home, max, indent)!;
        const label = `${window} ${indent ?? 'compact'}`;
        expect(JSON.stringify(g, null, indent).length, label).toBeLessThanOrEqual(max);
        const shown = g.sections as Array<{ id: string; componentId: string; text?: string }>;
        // The first sections in order, each with its ID and component, and a count of the rest.
        expect(shown.map((x) => x.id), label).toEqual(roots.slice(0, shown.length));
        expect(shown.every((x) => typeof x.componentId === 'string'), label).toBe(true);
        expect(shown.length + ((g.omittedSections as number | undefined) ?? 0), label).toBe(30);
        expect(shown.length, label).toBeLessThanOrEqual(12);
        for (const x of shown) if (x.text) expect(x.text.length, label).toBeLessThanOrEqual(64);
      }
    // Texts go before sections do: the larger window lists twelve, with their words, each cut to 64 characters.
    const wide = pageGlance(state, home, pageGlanceChars(32_768))!;
    const listed = wide.sections as Array<{ text?: string; lists?: Array<{ prop: string; items: number }> }>;
    expect([listed.length, wide.omittedSections]).toEqual([12, 18]);
    expect(listed[0].text).toBe('Calm, considered spaces for everyday life');
    expect(listed[2].lists).toEqual([{ prop: 'items', items: 3 }]);
    const cut = pageGlance(applyOperations(state, [{ type: 'node.move', owner: { kind: 'page', id: home }, nodeId: roots.at(-1)!, parentId: null, index: 0 }]).state, home, 4096)!;
    expect((cut.sections as Array<{ text: string }>)[0].text).toBe(`${heading.slice(0, 63)}…`);
    // Short of room even without words: fewer sections, still in order, and the rest counted.
    const tight = pageGlance(state, home, 400)!;
    expect(JSON.stringify(tight).length).toBeLessThanOrEqual(400);
    expect((tight.sections as unknown[]).length).toBeGreaterThan(0);
    expect((tight.sections as unknown[]).length).toBeLessThan(8);
    expect((tight.sections as Array<{ id: string; text?: string }>).every((x, i) => x.id === roots[i] && x.text === undefined)).toBe(true);
    expect(tight.omittedSections).toBe(30 - (tight.sections as unknown[]).length);
    // A News list fills itself from the site's articles: what it stores counts for nothing.
    const news = applyOperations(state, [{ type: 'node.insert', owner: { kind: 'page', id: home }, index: 0, componentId: 'content.news' }]).state;
    expect((pageGlance(news, home, 4096)!.sections as Array<{ componentId: string; lists?: unknown }>)[0]).toMatchObject({ componentId: 'content.news' });
    expect((pageGlance(news, home, 4096)!.sections as Array<{ lists?: unknown }>)[0].lists).toBeUndefined();
    // An empty page says so in a few bytes, and a page that has gone gives nothing.
    const empty = applyOperations(state, [{ type: 'page.create', pageId: 'pg_empty001', title: 'Empty', route: '/empty/' }]).state;
    expect(pageGlance(empty, 'pg_empty001', 1024)).toEqual({ id: 'pg_empty001', title: 'Empty', route: '/empty/', sections: [] });
    expect(pageGlance(state, 'pg_gone', 1024)).toBeNull();
  });

  const chatPosts = () => server.requests.filter((r) => r.method === 'POST');
  /** The app's own estimate of a native request as it went out. */
  const estimateOf = (body: Record<string, any>) => {
    const tools: ToolDefinition[] = (body.tools ?? []).map((t: { function: ToolDefinition }) => t.function);
    const items = body.messages.slice(1).map((m: { content: string }) => ({ kind: 'user' as const, text: m.content }));
    return estimateRequestTokens(body.messages[0].content, tools, items);
  };

  it('sends a page run its page, with room to answer, in a 12K and a 32K window', async () => {
    for (const window of [12_288, 32_768]) {
      const before = chatPosts().length;
      const { session, run } = await setup({ contextWindow: window, toolMode: 'native' });
      server.script(textReply('It reads well.'));
      const { result } = await run('What would you change on this page?', null, null, undefined, undefined, 'page');
      expect(result?.status, String(window)).toBe('no-changes');
      const posts = chatPosts().slice(before);
      expect(posts, String(window)).toHaveLength(1);
      const body = posts[0].body;
      expect(estimateOf(body) + body.max_tokens, String(window)).toBeLessThanOrEqual(window);
      expect(body.max_tokens, String(window)).toBeGreaterThanOrEqual(1024);
      const context = JSON.parse(/<editor_context>\n([\s\S]*)\n<\/editor_context>/.exec(body.messages.at(-1).content)![1]);
      expect(context.allowedScope, String(window)).toMatch(/^only the Home page/);
      expect(context.currentPage.sections.map((x: { id: string }) => x.id), String(window)).toEqual(session.state.pages[session.state.site.homePageId].rootIds);
    }
  });
});
