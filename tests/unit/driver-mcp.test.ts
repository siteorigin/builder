// The test driver as a local MCP server (tests/driver/mcp.ts, schemas.ts, operations.ts; issue #496), without
// launching the app: tool discovery from the driver's own catalog and schemas that agree with its parsers, MCP's
// lifecycle and JSON-RPC framing, tool calls mapped onto driver replies (an evidence image as an image block), one
// session host per session started only when a call needs it, and the real subprocess transport driven both by the
// official SDK client and by raw lines. Also the two driver operations added for it: ui.waitFor's loop and
// evidence.read's file check.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAnswer } from '../../src/main/headless-desktop.ts';
import { parseAction } from '../driver/act.ts';
import { INVALID_PARAMS, INVALID_REQUEST, MCP_PATH, MCP_VERSIONS, METHOD_NOT_FOUND, McpServer, PARSE_ERROR, SERVER_NAME, codexConfig, listTools, thisNode, toolName, toolResult } from '../driver/mcp.ts';
import type { HostConnection } from '../driver/mcp.ts';
import { WAIT_LIMITS, parseSnapshotArgs, parseLocateArgs, parseWaitArgs, waitFor } from '../driver/observe.ts';
import type { Located } from '../driver/observe.ts';
import { OPERATIONS } from '../driver/operations.ts';
import { processTable } from '../driver/processes.ts';
import { DriverError } from '../driver/protocol.ts';
import type { Reply } from '../driver/protocol.ts';
import { INPUT_SCHEMAS } from '../driver/schemas.ts';
import { MAX_EVIDENCE_BYTES, parseCloseArgs, parseStartArgs, readSavedImage } from '../driver/session.ts';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'driver-mcp-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const success = (op: string, result: unknown = null): Reply => ({ v: 1, id: 'r1', op, ok: true, sessionId: 's-1', window: null, elapsedMs: 1, events: [], result });
const failed = (op: string, code: string, details?: Record<string, unknown>): Reply =>
  ({ v: 1, id: 'r1', op, ok: false, sessionId: 's-1', window: null, elapsedMs: 1, events: [], error: { code, message: `${code}!`, retryable: false, ...(details ? { details } : {}) } }) as Reply;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('tool discovery', () => {
  const tools = listTools();

  it('advertises one tool for every driver operation, and nothing else, by a name without dots', () => {
    expect(Object.keys(INPUT_SCHEMAS).sort()).toEqual(Object.keys(OPERATIONS).sort());
    expect(tools.map((t) => t.title)).toEqual(Object.keys(OPERATIONS));
    expect(tools.map((t) => t.name)).toEqual(Object.keys(OPERATIONS).map((op) => op.replace('.', '_')));
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const t of tools) expect(t.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['session_start', 'session_close', 'ui_snapshot', 'ui_click', 'ui_waitFor', 'evidence_read', 'desktop_setAnswers']));
  });

  it('says what kind each is, so a fixture is never mistaken for something a person did', () => {
    for (const t of tools) {
      const spec = OPERATIONS[t.title];
      expect(t.description.startsWith(spec.summary)).toBe(true);
      expect(t.description).toContain(`Kind: ${spec.kind}`);
      expect(t.annotations.openWorldHint).toBe(false);
    }
    expect(tools.find((t) => t.name === 'desktop_setAnswers')!.description).toContain('not something a user did');
    expect(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.title)).toEqual(['session.describe', 'window.info', 'menu.list', 'desktop.events', 'files.list', 'ui.locate', 'ui.waitFor', 'evidence.read']);
  });

  it('gives every tool an object schema with the request options, and none of the options a contained session refuses', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    for (const t of tools) {
      const s = t.inputSchema as { type: string; properties: Record<string, unknown>; additionalProperties: boolean };
      expect([t.name, s.type, s.additionalProperties]).toEqual([t.name, 'object', false]);
      expect(Object.keys(s.properties)).toContain('timeoutMs');
      expect('expectWindow' in s.properties).toBe(OPERATIONS[t.title].usesWindow);
      expect(() => ajv.compile(s), t.name).not.toThrow();
    }
    const start = tools.find((t) => t.name === 'session_start')!.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(start.properties).sort()).toEqual(['fixture', 'keepArtifacts', 'provider', 'timeoutMs']);
  });

  // Each sample is one the schema and the driver's own parser agree on: accepted by both, or refused by both. (Rules
  // between fields, such as "a ref alone", are the parsers' and are only described in the schemas.)
  const ref = { ref: 'a1b2c3:4' };
  const point = { observation: 'oa1b2c3-7', surface: 'editor', x: 10, y: 20 };
  const answers = (a: Record<string, unknown>) => {
    for (const k of Object.keys(a)) if (k !== 'answers') throw new Error(`no ${k}`);
    if (!Array.isArray(a.answers)) throw new Error('answers');
    // As resolveAnswer leaves them: "within" refused (the session sets it), and session paths made absolute.
    for (const x of a.answers as Record<string, unknown>[]) {
      if (x.within !== undefined) throw new Error('within');
      checkAnswer({ ...x, ...(Array.isArray(x.paths) ? { paths: x.paths.map((p) => `/s/${p}`) } : {}), ...(typeof x.path === 'string' ? { path: `/s/${x.path}` } : {}) });
    }
  };
  const SAMPLES: Record<string, { parse: (a: Record<string, unknown>) => unknown; good: Record<string, unknown>[]; bad: Record<string, unknown>[] }> = {
    'session.start': {
      parse: (a) => parseStartArgs(a),
      good: [{}, { fixture: 'business-v1', provider: 'none', keepArtifacts: 'never' }, { fixture: 'welcome', artifactsDir: '/tmp/x', headed: false }],
      bad: [{ fixture: 'nope' }, { provider: 'live' }, { keepArtifacts: 'sometimes' }, { headed: 'yes' }, { window: 1 }]
    },
    'session.close': { parse: (a) => parseCloseArgs(a), good: [{}, { keepArtifacts: 'always', failed: true }], bad: [{ failed: 'yes' }, { keepArtifacts: 'later' }, { force: true }] },
    'ui.snapshot': {
      parse: (a) => parseSnapshotArgs(a),
      good: [{}, { scope: 'editor', maxNodes: 5, depth: 2, screenshot: true }, { within: 'a1b2c3:9', offset: 3 }],
      bad: [{ maxNodes: 0 }, { maxNodes: 1001 }, { scope: 'page' }, { depth: -1 }, { screenshot: 'yes' }, { within: 'nope' }, { verbose: true }]
    },
    'ui.locate': {
      parse: (a) => parseLocateArgs(a),
      good: [ref, { role: 'button', name: 'New project' }, { role: 'textbox', name: 'Project name', exact: false, within: 'a1b2c3:9' }, { role: 'dialog', region: 'main', scope: 'editor' }],
      bad: [{ role: 'Button' }, { role: 'button', name: '' }, { role: 'button', exact: 'no' }, { ref: 'xyz' }, { role: 'button', text: 'x' }]
    },
    'ui.waitFor': {
      parse: (a) => parseWaitArgs(a),
      good: [{ role: 'dialog', name: 'New project' }, { role: 'dialog', state: 'absent', scope: 'editor' }, { ...ref, state: 'absent' }],
      bad: [{ role: 'dialog', state: 'gone' }, { role: 'Dialog' }, { role: 'dialog', waitMs: 100 }]
    },
    'ui.click': {
      parse: (a) => parseAction('ui.click', a),
      good: [{ target: ref }, { target: { ...ref, position: { x: 3, y: 4 } }, button: 'right' }, { target: point, count: 2, modifiers: ['Shift', 'ControlOrMeta'], waitMs: 0 }],
      bad: [{}, { target: { ref: 'x' } }, { target: ref, count: 3 }, { target: ref, button: 'middle' }, { target: ref, waitMs: 10_001 }, { target: ref, modifiers: ['Hyper'] }, { target: { ...point, surface: 'canvas' } }, { target: { ...ref, extra: 1 } }]
    },
    'ui.hover': { parse: (a) => parseAction('ui.hover', a), good: [{ target: ref }, { target: point }], bad: [{}, { target: ref, button: 'left' }] },
    'ui.fill': {
      parse: (a) => parseAction('ui.fill', a),
      good: [{ target: ref, text: '' }, { target: ref, text: 'Harbour Lane', waitMs: 500 }],
      bad: [{ target: ref }, { text: 'x' }, { target: { ...ref, position: { x: 1, y: 1 } }, text: 'x' }, { target: ref, text: 5 }]
    },
    'ui.type': { parse: (a) => parseAction('ui.type', a), good: [{ text: 'abc' }, { target: ref, text: 'a' }], bad: [{ text: '' }, {}, { text: 'x'.repeat(2001) }] },
    'ui.select': {
      parse: (a) => parseAction('ui.select', a),
      good: [{ target: ref, option: { label: 'One' } }, { target: ref, option: { value: '1' } }],
      bad: [{ target: ref, option: {} }, { target: ref, option: { label: 'a', value: 'b' } }, { target: ref, option: 'One' }, { option: { label: 'One' } }]
    },
    'ui.press': { parse: (a) => parseAction('ui.press', a), good: [{ key: 'Escape' }, { key: 'Shift+Tab', target: ref }], bad: [{}, { key: '' }, { key: 'x'.repeat(101) }] },
    'ui.scroll': { parse: (a) => parseAction('ui.scroll', a), good: [{ target: ref, deltaY: 200 }, { target: point, deltaX: -50 }], bad: [{ target: ref, deltaY: 20_000 }, { deltaY: 10 }] },
    'ui.drag': {
      parse: (a) => parseAction('ui.drag', a),
      good: [{ from: ref, to: { ref: 'a1b2c3:5' } }, { from: ref, by: { x: 10, y: 0 }, steps: 5 }],
      bad: [{ from: ref, to: { ref: 'a1b2c3:5' }, steps: 0 }, { from: ref, by: { x: 20_000, y: 0 } }, { to: ref }]
    },
    'desktop.setAnswers': {
      parse: answers,
      good: [
        { answers: [] },
        { answers: [{ dialog: 'open', selection: 'folder', title: 'Choose where to create the project', paths: ['workspace'] }] },
        { answers: [{ dialog: 'save', path: 'exports/site.zip', overwrite: 'replace' }, { dialog: 'message', button: 'OK', checkbox: true }, { dialog: 'open', cancel: true }] }
      ],
      bad: [{}, { answers: [{ dialog: 'print', cancel: true }] }, { answers: [{ dialog: 'open', cancel: false }] }, { answers: [{ dialog: 'open', cancel: true, within: ['/x'] }] }, { answers: [{ dialog: 'open', paths: [] }] }]
    }
  };

  for (const [op, { parse, good, bad }] of Object.entries(SAMPLES)) {
    it(`${op}: the schema accepts and refuses what the driver does`, () => {
      const validate = new Ajv2020({ strict: true }).compile(INPUT_SCHEMAS[op as keyof typeof INPUT_SCHEMAS]);
      for (const a of good) {
        expect(validate(a), `schema accepts ${JSON.stringify(a)}: ${JSON.stringify(validate.errors)}`).toBe(true);
        expect(() => parse(a), `parser accepts ${JSON.stringify(a)}`).not.toThrow();
      }
      for (const a of bad) {
        expect(validate(a), `schema refuses ${JSON.stringify(a)}`).toBe(false);
        expect(() => parse(a), `parser refuses ${JSON.stringify(a)}`).toThrow();
      }
    });
  }

  it('prints a Codex configuration that runs this server from this checkout with this Node', () => {
    const toml = codexConfig('/opt/node/bin/node', '/work/builder');
    expect(toml).toContain('[mcp_servers.siteorigin_builder]');
    expect(toml).toContain('command = "/opt/node/bin/node"');
    expect(toml).toContain(`args = [${JSON.stringify(MCP_PATH)}]`);
    expect(toml).toContain('cwd = "/work/builder"');
    expect(toml).toMatch(/tool_timeout_sec = (\d+)/);
    expect(toml).toContain('default_tools_approval_mode = "approve"');
    expect(Number(/tool_timeout_sec = (\d+)/.exec(toml)![1]) * 1000).toBeGreaterThan(OPERATIONS['session.start'].defaultTimeoutMs + 90_000);
  });

  it('names this Node by the link on PATH that leads to it, which outlives an upgrade, else by its own path', () => {
    const bin = join(scratch, 'bin');
    const other = join(scratch, 'other');
    mkdirSync(bin);
    mkdirSync(other);
    symlinkSync(process.execPath, join(bin, 'node'));
    writeFileSync(join(other, 'node'), '#!/bin/sh\n');
    expect(thisNode([join(scratch, 'missing'), other, bin].join(':'), process.execPath)).toBe(join(bin, 'node'));
    expect(thisNode(other, process.execPath)).toBe(process.execPath);
    expect(thisNode('', process.execPath)).toBe(process.execPath);
  });
});

// ---------------------------------------------------------------------------
// The protocol, in process
// ---------------------------------------------------------------------------

class FakeHost implements HostConnection {
  readonly calls: { op: string; args?: Record<string, unknown>; opts?: Record<string, unknown> }[] = [];
  disconnects = 0;
  private exit!: () => void;
  readonly exited = new Promise<void>((r) => (this.exit = r));
  constructor(private readonly respond: (op: string, args?: Record<string, unknown>) => Promise<Reply> | Reply = (op) => success(op)) {}
  async request(op: string, args?: Record<string, unknown>, opts?: Record<string, unknown>): Promise<Reply> {
    this.calls.push({ op, args, opts });
    return this.respond(op, args);
  }
  async disconnect() {
    this.disconnects++;
    this.exit();
    return { code: 0, signal: null };
  }
}

function harness(connect: () => Promise<HostConnection> = async () => new FakeHost()) {
  const out: Record<string, any>[] = [];
  let connects = 0;
  const server = new McpServer({
    connect: () => (connects++, connect()),
    write: async (line) => void out.push(JSON.parse(line)),
    version: '9.9.9'
  });
  const send = (msg: unknown) => server.handle(typeof msg === 'string' ? msg : JSON.stringify(msg));
  const answer = async (id: string | number) => {
    await until(() => out.some((m) => m.id === id));
    return out.find((m) => m.id === id)!;
  };
  let n = 0;
  const call = async (name: string, args?: unknown) => {
    const id = `c${++n}`;
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, ...(args === undefined ? {} : { arguments: args }) } });
    return answer(id);
  };
  const init = async () => {
    send({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    await answer('init');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  };
  return { server, out, send, answer, call, init, connects: () => connects };
}

describe('the MCP lifecycle and framing', () => {
  it('agrees a revision it speaks, and offers its newest for one it does not', async () => {
    for (const [asked, agreed] of [
      ['2025-11-25', '2025-11-25'],
      ['2025-06-18', '2025-06-18'],
      ['2024-11-05', '2024-11-05'],
      ['2099-01-01', MCP_VERSIONS[0]]
    ]) {
      const h = harness();
      h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: asked, capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
      const r = await h.answer(1);
      expect(r.result.protocolVersion).toBe(agreed);
      expect(r.result.capabilities).toEqual({ tools: { listChanged: false } });
      expect(r.result.serverInfo).toMatchObject({ name: SERVER_NAME, version: '9.9.9' });
      expect(r.result.instructions).toMatch(/session_start/);
    }
  });

  it('answers only initialize and ping before it is initialized, and initializes once', async () => {
    const h = harness();
    h.send({ jsonrpc: '2.0', id: 'p', method: 'ping' });
    h.send({ jsonrpc: '2.0', id: 'early', method: 'tools/list' });
    expect((await h.answer('p')).result).toEqual({});
    expect((await h.answer('early')).error.code).toBe(INVALID_REQUEST);
    h.send({ jsonrpc: '2.0', id: 'bad', method: 'initialize', params: { capabilities: {} } });
    expect((await h.answer('bad')).error.code).toBe(INVALID_PARAMS);
    await h.init();
    h.send({ jsonrpc: '2.0', id: 'again', method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    expect((await h.answer('again')).error.code).toBe(INVALID_REQUEST);
    expect(h.connects(), 'nothing so far needed a session host').toBe(0);
  });

  it('answers what is not a request with the JSON-RPC error for it, keeping an id it can read', async () => {
    const h = harness();
    await h.init();
    h.send('{not json');
    h.send('[{"jsonrpc":"2.0","id":7,"method":"ping"}]');
    h.send({ id: 8, method: 'ping' });
    h.send({ jsonrpc: '2.0', id: 9 });
    h.send({ jsonrpc: '2.0', id: null, method: 'ping' });
    h.send({ jsonrpc: '2.0', id: 1.5, method: 'ping' });
    h.send({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: [] });
    h.send({ jsonrpc: '2.0', id: 11, method: 'resources/list' });
    h.send({ jsonrpc: '2.0', id: 12, result: {} });
    h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } });
    h.send({ jsonrpc: '2.0', id: 0, method: 'ping' });
    h.send({ jsonrpc: '2.0', id: 'zero', method: 'ping' });
    await h.answer(0);
    await h.answer('zero');
    await until(() => h.out.length >= 11);
    await new Promise((r) => setTimeout(r, 20));
    const unread = h.out.filter((m) => !('id' in m)).map((m) => m.error.code);
    expect(unread.sort()).toEqual([INVALID_REQUEST, INVALID_REQUEST, INVALID_REQUEST, PARSE_ERROR].sort());
    expect((await h.answer(8)).error.code).toBe(INVALID_REQUEST);
    expect((await h.answer(9)).error.code).toBe(INVALID_REQUEST);
    expect((await h.answer(10)).error.code).toBe(INVALID_PARAMS);
    expect((await h.answer(11)).error.code).toBe(METHOD_NOT_FOUND);
    expect(h.out.some((m) => m.id === 12), 'an answer to nothing is not answered').toBe(false);
    expect((await h.answer(0)).result, 'an id of 0 is an id').toEqual({});
    expect(h.out, 'with the answer to initialize').toHaveLength(11);
    for (const m of h.out) expect(m.jsonrpc).toBe('2.0');
  });

  it('lists the tools', async () => {
    const h = harness();
    await h.init();
    h.send({ jsonrpc: '2.0', id: 'l', method: 'tools/list', params: {} });
    const r = await h.answer('l');
    expect(r.result.tools).toEqual(listTools());
    expect(r.result.nextCursor).toBeUndefined();
  });
});

describe('tool calls', () => {
  it('answers with the driver reply itself, as structured content and as text', async () => {
    const host = new FakeHost((op) => (op === 'ui.snapshot' ? success(op, { id: 1, context: { screen: 'welcome' } }) : failed(op, 'STALE_REF', { ref: 'a1b2c3:4', reason: 'gone', hint: 'observe again' })));
    const h = harness(async () => host);
    await h.init();
    const good = (await h.call('ui_snapshot', { scope: 'editor', timeoutMs: 5000, expectWindow: 2 })).result;
    expect(host.calls[0]).toEqual({ op: 'ui.snapshot', args: { scope: 'editor' }, opts: { timeoutMs: 5000, expectWindow: 2 } });
    expect(good.isError).toBeUndefined();
    expect(good.structuredContent).toEqual(success('ui.snapshot', { id: 1, context: { screen: 'welcome' } }));
    expect(good.content).toEqual([{ type: 'text', text: JSON.stringify(good.structuredContent) }]);
    const bad = (await h.call('ui_locate', { ref: 'a1b2c3:4' })).result;
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.error).toEqual({ code: 'STALE_REF', message: 'STALE_REF!', retryable: false, details: { ref: 'a1b2c3:4', reason: 'gone', hint: 'observe again' } });
    expect(JSON.parse(bad.content[0].text)).toEqual(bad.structuredContent);
  });

  it('hands every argument to the driver to check, so a bad one is the driver\'s own BAD_REQUEST', async () => {
    const host = new FakeHost((op, args) => (args && 'maxNodes' in args ? failed(op, 'BAD_REQUEST') : success(op)));
    const h = harness(async () => host);
    await h.init();
    const r = (await h.call('ui_snapshot', { maxNodes: 0, timeoutMs: 'soon' })).result;
    expect(host.calls[0]).toEqual({ op: 'ui.snapshot', args: { maxNodes: 0 }, opts: { timeoutMs: 'soon' } });
    expect([r.isError, r.structuredContent.error.code]).toEqual([true, 'BAD_REQUEST']);
    await h.call('session_start', { headed: true });
    expect(host.calls[1], 'the server sends it on; its contained host refuses it').toEqual({ op: 'session.start', args: { headed: true }, opts: {} });
  });

  it('refuses a tool that is not there, or arguments that are not an object, as a protocol error', async () => {
    const h = harness();
    await h.init();
    expect((await h.call('ui.click', {})).error.code).toBe(INVALID_PARAMS);
    expect((await h.call('constructor', {})).error.code).toBe(INVALID_PARAMS);
    expect((await h.call('session_describe', [])).error.code).toBe(INVALID_PARAMS);
    h.send({ jsonrpc: '2.0', id: 'noname', method: 'tools/call', params: {} });
    expect((await h.answer('noname')).error.code).toBe(INVALID_PARAMS);
    expect(h.connects()).toBe(0);
  });

  it('returns an evidence image as an image block, and leaves the base64 out of the rest', () => {
    const data = Buffer.from('png bytes').toString('base64');
    const r = toolResult(success('evidence.read', { id: '0001-editor', surface: 'editor', mimeType: 'image/png', width: 10, height: 5, bytes: 9, sha256: 'abc', data }));
    expect(r.content[0]).toEqual({ type: 'image', data, mimeType: 'image/png' });
    expect(JSON.stringify(r.structuredContent)).not.toContain(data);
    expect(r.structuredContent.result).toMatchObject({ id: '0001-editor', bytes: 9, sha256: 'abc', image: 'returned as an image block' });
    expect(JSON.parse((r.content[1] as { text: string }).text)).toEqual(r.structuredContent);
    const withheld = toolResult(success('evidence.read', { id: '0001-editor', withheld: 'A credential is known' }));
    expect(withheld.content.map((c) => c.type)).toEqual(['text']);
  });
});

describe('session hosts', () => {
  it('starts one host for calls that arrive while it starts, and sends them on in the order they came', async () => {
    let release!: (h: HostConnection) => void;
    const host = new FakeHost();
    const h = harness(() => new Promise((r) => (release = r)));
    await h.init();
    const first = h.call('session_start', { fixture: 'welcome' });
    const second = h.call('session_describe', {});
    await until(() => h.connects() === 1);
    release(host);
    await Promise.all([first, second]);
    expect(h.connects()).toBe(1);
    expect(host.calls.map((c) => c.op)).toEqual(['session.start', 'session.describe']);
  });

  it('sends nothing on, and closes the host once it is up, when the client goes while it starts', async () => {
    let release!: (h: HostConnection) => void;
    const host = new FakeHost();
    const h = harness(() => new Promise((r) => (release = r)));
    await h.init();
    const pending = h.call('session_start', {});
    await until(() => h.connects() === 1);
    const ended = h.server.end('the client closed its input');
    release(host);
    await ended;
    const r = (await pending).result;
    expect([r.isError, r.structuredContent.error.code, r.structuredContent.error.details.outcome]).toEqual([true, 'HOST_LOST', 'not-sent']);
    expect(host.calls).toEqual([]);
    expect(host.disconnects).toBe(1);
  });

  it('gives each session its own host: a close that ran retires it, one refused keeps it', async () => {
    const hosts: FakeHost[] = [];
    const h = harness(async () => {
      const host = new FakeHost((op, args) => (op === 'session.close' && args?.failed === 'yes' ? failed(op, 'BAD_REQUEST') : op === 'session.close' && args?.cleanup ? failed(op, 'CLEANUP_FAILED') : success(op)));
      hosts.push(host);
      return host;
    });
    await h.init();
    await h.call('session_start', {});
    await h.call('session_close', { failed: 'yes' });
    await h.call('session_describe', {});
    expect(hosts.map((x) => x.calls.map((c) => c.op))).toEqual([['session.start', 'session.close', 'session.describe']]);
    await h.call('session_close', {});
    await h.call('session_start', {});
    await h.call('session_close', { cleanup: true });
    await h.call('session_describe', {});
    expect(hosts.map((x) => x.calls.map((c) => c.op))).toEqual([['session.start', 'session.close', 'session.describe', 'session.close'], ['session.start', 'session.close'], ['session.describe']]);
    await h.server.end('done');
    expect(hosts.map((x) => x.disconnects)).toEqual([1, 1, 1]);
  });

  it('reports a host that went away as HOST_LOST, never sends the call again, and starts a new host for the next', async () => {
    const hosts: FakeHost[] = [];
    const h = harness(async () => {
      const host = new FakeHost((op) => (hosts.length === 1 && op === 'ui.click' ? Promise.reject(new Error('The session host exited (code null, signal SIGKILL).')) : success(op)));
      hosts.push(host);
      return host;
    });
    await h.init();
    const lost = (await h.call('ui_click', { target: { ref: 'a1b2c3:1' } })).result;
    expect([lost.isError, lost.structuredContent.error.code, lost.structuredContent.error.details.outcome]).toEqual([true, 'HOST_LOST', 'unknown']);
    expect(lost.structuredContent.error.message).toContain('SIGKILL');
    await h.call('session_describe', {});
    expect(hosts.map((x) => x.calls.map((c) => c.op))).toEqual([['ui.click'], ['session.describe']]);
  });

  it('reports a host that could not start, and tries again on the next call', async () => {
    let tries = 0;
    const h = harness(async () => {
      if (++tries === 1) throw new Error('spawn node ENOENT');
      return new FakeHost();
    });
    await h.init();
    const r = (await h.call('session_describe', {})).result;
    expect([r.structuredContent.error.code, r.structuredContent.error.details.outcome]).toEqual(['HOST_LOST', 'not-sent']);
    expect((await h.call('session_describe', {})).result.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The real subprocess
// ---------------------------------------------------------------------------

describe('the server as a subprocess', () => {
  it('serves the official SDK client: discovery, a real session host, the driver\'s errors, and an exit once it closes', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-warnings', MCP_PATH], stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (d) => (stderr += String(d)));
    const client = new Client({ name: 'driver-mcp-test', version: '1.0.0' });
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: false });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(Object.keys(OPERATIONS).map(toolName));
    const described = await client.callTool({ name: 'session_describe', arguments: {} });
    const d = described.structuredContent as any;
    expect([described.isError ?? false, d.ok, d.result.session.state, d.result.session.pid]).toEqual([false, true, 'new', null]);
    const early = (await client.callTool({ name: 'ui_snapshot', arguments: {} })) as any;
    expect([early.isError, early.structuredContent.error.code]).toEqual([true, 'NOT_STARTED']);
    for (const args of [{ headed: true }, { artifactsDir: scratch }, { fixture: 'nope' }]) {
      const r = (await client.callTool({ name: 'session_start', arguments: args })) as any;
      expect([JSON.stringify(args), r.isError, r.structuredContent.error.code]).toEqual([JSON.stringify(args), true, 'BAD_REQUEST']);
    }
    // A deadline the driver cannot accept is refused by it, and the session goes on (the client's own watchdog took
    // such a value as a timer of a millisecond, and gave up on the host).
    for (const timeoutMs of ['soon', 1e12]) {
      const r = (await client.callTool({ name: 'session_describe', arguments: { timeoutMs } })) as any;
      expect([r.isError, r.structuredContent.error.code]).toEqual([true, 'BAD_REQUEST']);
    }
    expect(((await client.callTool({ name: 'session_describe', arguments: {} })) as any).structuredContent.sessionId, 'the same session').toBe(d.sessionId);
    await expect(client.callTool({ name: 'session.describe', arguments: {} })).rejects.toThrow(/-32602|no tool/i);
    const pid = transport.pid!;
    await client.close();
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 10_000);
    expect(stderr).toContain('siteorigin mcp: driver-mcp-test connected');
  }, 60_000);

  it('writes only JSON-RPC on stdout, one message a line, and exits 0 once its input ends, its host with it', async () => {
    const child = spawn(process.execPath, ['--no-warnings', MCP_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: string[] = [];
    createInterface({ input: child.stdout! }).on('line', (l) => lines.push(l));
    let stderr = '';
    child.stderr!.on('data', (d) => (stderr += String(d)));
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
    const send = (m: unknown) => child.stdin!.write(`${typeof m === 'string' ? m : JSON.stringify(m)}\n`);
    send('{not json');
    send({ jsonrpc: '2.0', id: 'early', method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 'p', method: 'ping' });
    send({ jsonrpc: '2.0', id: 2, method: 'prompts/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'session_describe' } });
    await until(() => lines.length >= 7, 30_000);
    const host = (await processTable()).find((e) => e.ppid === child.pid);
    expect(host, 'a session host serves the call').toBeTruthy();
    child.stdin!.end();
    expect(await exited).toEqual({ code: 0, signal: null });
    const msgs = lines.map((l) => JSON.parse(l));
    expect(msgs).toHaveLength(7);
    for (const m of msgs) expect(m.jsonrpc).toBe('2.0');
    const by = (id: unknown) => msgs.find((m) => m.id === id);
    expect(msgs.find((m) => !('id' in m)).error.code).toBe(PARSE_ERROR);
    expect(by('early').error.code).toBe(INVALID_REQUEST);
    expect(by(0).result.protocolVersion).toBe('2025-06-18');
    expect(by('p').result).toEqual({});
    expect(by(2).error.code).toBe(METHOD_NOT_FOUND);
    expect(by(3).error.code).toBe(INVALID_PARAMS);
    expect(by(4).result.structuredContent).toMatchObject({ ok: true, op: 'session.describe', result: { session: { state: 'new' } } });
    expect(() => process.kill(host!.pid, 0), 'the host is gone too').toThrow();
    expect(stderr).toContain('the client closed its input; closing 1 session host');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The driver operations added for it
// ---------------------------------------------------------------------------

describe('ui.waitFor', () => {
  const located = (name: string): Located => ({ scope: 'editor', region: ['dialog "New project"'], node: { ref: 'a1b2c3:1', role: 'dialog', name } as Located['node'] });
  const notFound = () => new DriverError('TARGET_NOT_FOUND', 'nothing');
  const run = (locate: () => Promise<Located>, args: Record<string, unknown>, ms = 2000) =>
    waitFor(locate, parseWaitArgs(args), { deadline: Date.now() + ms, signal: new AbortController().signal, intervalMs: 5 });

  it('takes a search as ui.locate does, with a state; a ref waits only for absence', () => {
    expect(parseWaitArgs({ role: 'dialog', name: 'New project' })).toEqual({ state: 'present', search: { role: 'dialog', name: 'New project', scope: 'all' } });
    expect(parseWaitArgs({ ref: 'a1b2c3:4', state: 'absent' })).toEqual({ state: 'absent', search: { ref: 'a1b2c3:4' } });
    expect(() => parseWaitArgs({ ref: 'a1b2c3:4' })).toThrow(/absent/);
    expect(() => parseWaitArgs({ role: 'dialog', state: 'visible' })).toThrow(/present/);
    expect(() => parseWaitArgs({ role: 'dialog', after: 3 })).toThrow('ui.waitFor does not take "after".');
  });

  it('looks again until the element appears, and answers it as ui.locate would', async () => {
    let n = 0;
    const r = await run(async () => (++n < 4 ? Promise.reject(notFound()) : located('New project')), { role: 'dialog' });
    expect(r).toMatchObject({ state: 'present', scope: 'editor', node: { name: 'New project' }, checks: 4 });
  });

  it('waits out a preview still loading, but answers anything else at once', async () => {
    let n = 0;
    const loading = new DriverError('STALE_REF', 'loading', { details: { reason: 'loading' } });
    expect((await run(async () => (++n < 3 ? Promise.reject(loading) : located('x')), { role: 'dialog', within: 'a1b2c3:9' })).checks).toBe(3);
    const ambiguous = new DriverError('AMBIGUOUS_TARGET', 'two', { details: { candidates: [] } });
    n = 0;
    await expect(run(async () => (n++, Promise.reject(ambiguous)), { role: 'button' })).rejects.toMatchObject({ code: 'AMBIGUOUS_TARGET' });
    expect(n).toBe(1);
    const unknown = new DriverError('STALE_REF', 'never', { details: { reason: 'unknown' } });
    await expect(run(async () => Promise.reject(unknown), { ref: 'a1b2c3:9', state: 'absent' })).rejects.toMatchObject({ code: 'STALE_REF' });
  });

  it('waits for a search to match nothing, or a ref to go, while several matches still count as there', async () => {
    let n = 0;
    const ambiguous = new DriverError('AMBIGUOUS_TARGET', 'two');
    const gone = await run(async () => (++n === 1 ? located('x') : n === 2 ? Promise.reject(ambiguous) : Promise.reject(notFound())), { role: 'dialog', state: 'absent' });
    expect(gone).toMatchObject({ state: 'absent', checks: 3 });
    n = 0;
    const stale = new DriverError('STALE_REF', 'gone', { details: { reason: 'gone' } });
    expect(await run(async () => (++n < 2 ? located('x') : Promise.reject(stale)), { ref: 'a1b2c3:9', state: 'absent' })).toMatchObject({ state: 'absent', reason: 'gone', checks: 2 });
  });

  it('ends before the request\'s deadline with TIMEOUT, saying what it last saw, and the session goes on', async () => {
    const began = Date.now();
    const e = await run(async () => Promise.reject(notFound()), { role: 'dialog', name: 'Never' }, WAIT_LIMITS.marginMs + 150).catch((x: DriverError) => x);
    expect(e).toBeInstanceOf(DriverError);
    expect((e as DriverError).code).toBe('TIMEOUT');
    expect((e as DriverError).message).toBe('No dialog "Never" appeared in time.');
    expect((e as DriverError).details).toMatchObject({ phase: 'ui.waitFor', sessionState: 'ready', state: 'present', last: { code: 'TARGET_NOT_FOUND' } });
    expect(Date.now() - began).toBeLessThan(WAIT_LIMITS.marginMs + 150);
  });

  it('stops as soon as the request is told to stop', async () => {
    const abort = new AbortController();
    const waiting = waitFor(async () => Promise.reject(notFound()), parseWaitArgs({ role: 'dialog' }), { deadline: Date.now() + 60_000, signal: abort.signal, intervalMs: 10_000 });
    await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('evidence.read\'s file check', () => {
  const artifacts = join(scratch, 'artifacts');
  mkdirSync(join(artifacts, 'snapshots'), { recursive: true });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  writeFileSync(join(artifacts, 'snapshots', '0001-editor.png'), png);

  it('returns a file the session saved, with its size and hash', async () => {
    const r = await readSavedImage(artifacts, join(artifacts, 'snapshots', '0001-editor.png'), '0001-editor');
    expect(Buffer.from(r.data, 'base64')).toEqual(png);
    expect(r.bytes).toBe(png.length);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a link put in its place, a file outside the artifacts, and one past the limit', async () => {
    const outside = join(scratch, 'secret.png');
    writeFileSync(outside, 'not yours');
    symlinkSync(outside, join(artifacts, 'snapshots', '0002-editor.png'));
    await expect(readSavedImage(artifacts, join(artifacts, 'snapshots', '0002-editor.png'), '0002-editor')).rejects.toMatchObject({ code: 'OP_FAILED', details: { reason: 'moved' } });
    await expect(readSavedImage(artifacts, outside, '0003-editor')).rejects.toMatchObject({ details: { reason: 'moved' } });
    mkdirSync(join(scratch, 'elsewhere'));
    writeFileSync(join(scratch, 'elsewhere', '0004-editor.png'), png);
    symlinkSync(join(scratch, 'elsewhere'), join(artifacts, 'linked'));
    await expect(readSavedImage(artifacts, join(artifacts, 'linked', '0004-editor.png'), '0004-editor')).rejects.toMatchObject({ details: { reason: 'moved' } });
    await expect(readSavedImage(artifacts, join(artifacts, 'snapshots', 'missing.png'), '0005-editor')).rejects.toMatchObject({ details: { reason: 'moved' } });
    await expect(readSavedImage(artifacts, join(artifacts, 'snapshots', '0001-editor.png'), '0001-editor', 4)).rejects.toMatchObject({ details: { reason: 'too-large', bytes: png.length, limit: 4 } });
    expect(MAX_EVIDENCE_BYTES).toBe(8 * 1024 * 1024);
  });
});
