/**
 * The real orchestrator, session and tools driven by the local adapter over HTTP. Proves the constrained-JSON
 * path gets the same scope checks, validation, rollback and undo as any other provider.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiEvent, ChatContext } from '@shared/api';
import type { ElementRef } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { LIMITS, Orchestrator } from '@agent/orchestrator';
import { LocalAdapter, type LocalAdapterOptions, type LocalEndpoint } from '@agent/local';
import { DEFAULT_LOCAL_PROFILE, type LocalModelProfile } from '@agent/models';
import { findForbiddenShapes } from '@agent/strict-schema';
import { FOCUSED_WINDOW_TOKENS } from '@agent/tools';
import { ProjectSession } from '../../src/main/project/session';
import { closedPort, envelopeReply, MockOpenAIServer, sseChunk, textReply, toolCallReply } from './mock-openai-server';

let server: MockOpenAIServer;
const dirs: string[] = [];
beforeEach(async () => {
  server = await new MockOpenAIServer().start();
});
afterEach(async () => {
  await server.stop();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function setup(endpoint: Partial<LocalEndpoint> = {}, opts: LocalAdapterOptions = {}, codeEnabled = true) {
  const dir = mkdtempSync(join(tmpdir(), 'so-local-'));
  dirs.push(dir);
  const session = await ProjectSession.create(dir, createStarterState('business', 'Test', false));
  const adapter = new LocalAdapter({ baseURL: server.baseURL, model: 'test-model', ...endpoint }, opts);
  const events: AiEvent[] = [];
  let busy = false;
  const orch = new Orchestrator({
    session: () => session,
    adapter: async () => ({ adapter, model: 'test-model', provider: 'local' }),
    emit: (e) => events.push(e),
    compileAll: async () => [],
    inspectLayout: async () => ({ issues: [] }),
    onBusyChange: (b) => (busy = b),
    codeEnabled: async () => codeEnabled
  });
  const header = session.state.site.shell.header.rootIds[0];
  const run = async (text: string, selection: ElementRef | null = null, selectionLabel: string | null = null) => {
    const ctx: ChatContext = { pageId: session.state.site.homePageId, pageTitle: 'Home', selection, selectionLabel, viewport: 1280 };
    const r = await orch.send(text, ctx);
    expect(r.ok).toBe(true);
    await expect.poll(() => orch.busy || busy, { timeout: 5000, interval: 5 }).toBe(false);
    const msg = [...events].reverse().find((e) => e.kind === 'message' && e.message?.result)?.message;
    return { runId: r.runId!, result: msg?.result };
  };
  return { session, run, header, events };
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
    const { session, run, header } = await setup();
    const item = { label: 'Services', link: { type: 'url', target: 'https://example.com/services' } };
    const args = { expectedRevision: 0, operations: [{ type: 'instance.listInsert', owner: { kind: 'shell', id: 'header' }, nodeId: header, prop: 'links', item: { $json: JSON.stringify(item) } }] };
    server.script(envelopeReply('apply_operations', args), envelopeReply('finish', { message: 'Added a link.' }));
    const { result } = await run('Add a Services link', { owner: { kind: 'shell', id: 'header' }, instancePath: [header, 'n_inner'], nodeId: 'n_inner' }, 'Header');
    expect(result?.status).toBe('completed');
    const links = (session.state.site.shell.header.nodes[header] as unknown as { props: { links: Array<{ label: string }> } }).props.links;
    expect(links.at(-1)?.label).toBe('Services');
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
      const { session, run, header } = await setup();
      const before = headerName(session, header);
      // Real content keeps arriving well inside the idle timeout, so only the run's own limit can end it.
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
    LIMITS.activeMs = 50;
    try {
      const { run } = await setup();
      // Slower than the cloud limit allows, as a local model reading a long prompt is.
      server.script({ ...envelopeReply('finish', { message: 'Nothing to change.' }), delayMs: 300 });
      const { result } = await run('Hello');
      expect(result).toMatchObject({ status: 'no-changes', summary: 'Nothing to change.' });
    } finally {
      LIMITS.activeMs = cloud;
    }
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
