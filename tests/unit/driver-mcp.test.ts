// The test driver as a local MCP server (tests/driver/mcp.ts, schemas.ts, operations.ts; issue #496), without
// launching the app: tool discovery from the driver's own catalog and schemas that agree with its parsers, MCP's
// lifecycle and JSON-RPC framing, tool calls mapped onto driver replies (an evidence image as an image block), one
// session host per session started only when a call needs it, and the real subprocess transport driven both by the
// official SDK client and by raw lines. Also the two driver operations added for it: ui.waitFor's loop and
// evidence.read's file check.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAnswer } from '../../src/main/headless-desktop.ts';
import { parseAction } from '../driver/act.ts';
import { MAX_MESSAGE, MCP_PATH, MCP_VERSIONS, McpServer, SERVER_NAME, codexConfig, listTools, readLines, thisNode, toolName, toolResult } from '../driver/mcp.ts';
import type { HostConnection } from '../driver/mcp.ts';
import { WAIT_LIMITS, parseSnapshotArgs, parseLocateArgs, parseWaitArgs, waitFor } from '../driver/observe.ts';
import type { Located } from '../driver/observe.ts';
import { OPERATIONS } from '../driver/operations.ts';
import { parseCondition, parseInspectArgs } from '../driver/outcomes.ts';
import { processTable } from '../driver/processes.ts';
import { DriverError } from '../driver/protocol.ts';
import type { Reply } from '../driver/protocol.ts';
import { INPUT_SCHEMAS } from '../driver/schemas.ts';
import { MAX_EVIDENCE_BYTES, parseCloseArgs, parseStartArgs, readSavedImage } from '../driver/session.ts';

// JSON-RPC's own codes, written out rather than taken from the server.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const CLIENT_INFO = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } };

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
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['session_start', 'session_close', 'ui_snapshot', 'ui_click', 'ui_waitFor', 'evidence_read', 'desktop_setAnswers', 'wait_for', 'project_summary', 'exports_inspect', 'evidence_log', 'evidence_save']));
  });

  it('says what kind each is, so a fixture is never mistaken for something a person did', () => {
    for (const t of tools) {
      const spec = OPERATIONS[t.title];
      expect(t.description.startsWith(spec.summary)).toBe(true);
      expect(t.description).toContain(`Kind: ${spec.kind}`);
      // Only what merely reads is closed: acting on the app can reach anything it can (Developer mode runs code).
      expect(t.annotations.openWorldHint).toBe(t.annotations.readOnlyHint ? false : undefined);
    }
    expect(tools.find((t) => t.name === 'desktop_setAnswers')!.description).toContain('not something a user did');
    expect(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.title)).toEqual(['session.describe', 'window.info', 'menu.list', 'desktop.events', 'files.list', 'ui.locate', 'ui.waitFor', 'evidence.read', 'wait.for', 'project.summary', 'exports.inspect', 'evidence.log']);
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
      good: [{}, { fixture: 'business-v1', provider: 'none', keepArtifacts: 'never' }, { fixture: 'welcome', provider: 'scripted', keepArtifacts: 'on-failure', artifactsDir: '/tmp/x', headed: false }],
      bad: [{ fixture: 'nope' }, { fixture: 'constructor' }, { provider: 'live' }, { keepArtifacts: 'sometimes' }, { headed: 'yes' }, { window: 1 }]
    },
    'session.close': { parse: (a) => parseCloseArgs(a), good: [{}, { keepArtifacts: 'always', failed: true }, { keepArtifacts: 'on-failure' }, { keepArtifacts: 'never' }], bad: [{ failed: 'yes' }, { keepArtifacts: 'later' }, { force: true }] },
    'ui.snapshot': {
      parse: (a) => parseSnapshotArgs(a),
      good: [{}, { scope: 'editor', maxNodes: 5, depth: 2, screenshot: true }, { within: 'a1b2c3:9', offset: 3 }, { scope: 'preview', after: 'a1b2c3:9', maxNodes: 1000, depth: 50 }],
      bad: [{ maxNodes: 0 }, { maxNodes: 1001 }, { scope: 'page' }, { depth: -1 }, { screenshot: 'yes' }, { within: 'nope' }, { verbose: true }]
    },
    'ui.locate': {
      parse: (a) => parseLocateArgs(a),
      good: [ref, { role: 'button', name: 'New project' }, { role: 'textbox', name: 'Project name', exact: false, within: 'a1b2c3:9' }, { role: 'dialog', region: 'main', scope: 'editor' }, { role: 'heading', scope: 'preview' }],
      bad: [{ role: 'Button' }, { role: 'button', name: '' }, { role: 'button', name: '   ' }, { role: 'button', region: ' ' }, { role: 'button', exact: 'no' }, { ref: 'xyz' }, { role: 'button', text: 'x' }]
    },
    'ui.waitFor': {
      parse: (a) => parseWaitArgs(a),
      good: [{ role: 'dialog', name: 'New project' }, { role: 'dialog', state: 'present' }, { role: 'dialog', state: 'absent', scope: 'editor' }, { ...ref, state: 'absent' }],
      bad: [{ role: 'dialog', state: 'gone' }, { role: 'Dialog' }, { role: 'dialog', waitMs: 100 }]
    },
    'ui.click': {
      parse: (a) => parseAction('ui.click', a),
      good: [{ target: ref }, { target: { ...ref, position: { x: 3, y: 4 } }, button: 'right', count: 1 }, { target: point, count: 2, modifiers: ['Shift', 'ControlOrMeta'], waitMs: 0 }, { target: ref, waitMs: 10_000 }],
      bad: [{}, { target: { ref: 'x' } }, { target: ref, count: 3 }, { target: ref, button: 'middle' }, { target: ref, waitMs: 10_001 }, { target: ref, waitMs: -1 }, { target: ref, modifiers: ['Hyper'] }, { target: { ...point, surface: 'canvas' } }, { target: { ...ref, extra: 1 } }]
    },
    'ui.hover': { parse: (a) => parseAction('ui.hover', a), good: [{ target: ref }, { target: point, waitMs: 500 }], bad: [{}, { target: ref, button: 'left' }] },
    'ui.fill': {
      parse: (a) => parseAction('ui.fill', a),
      good: [{ target: ref, text: '' }, { target: ref, text: 'Harbour Lane', waitMs: 500 }, { target: ref, text: 'x'.repeat(100_000) }],
      bad: [{ target: ref }, { text: 'x' }, { target: ref, text: 'x'.repeat(100_001) }, { target: { ...ref, position: { x: 1, y: 1 } }, text: 'x' }, { target: ref, text: 5 }]
    },
    'ui.type': { parse: (a) => parseAction('ui.type', a), good: [{ text: 'abc' }, { target: ref, text: 'a' }, { text: 'x'.repeat(2000) }], bad: [{ text: '' }, {}, { text: 'x'.repeat(2001) }] },
    'ui.select': {
      parse: (a) => parseAction('ui.select', a),
      good: [{ target: ref, option: { label: 'One' } }, { target: ref, option: { value: '1' }, waitMs: 100 }],
      bad: [{ target: ref, option: {} }, { target: ref, option: { label: 'a', value: 'b' } }, { target: ref, option: 'One' }, { option: { label: 'One' } }]
    },
    'ui.press': { parse: (a) => parseAction('ui.press', a), good: [{ key: 'Escape' }, { key: 'Shift+Tab', target: ref, waitMs: 0 }], bad: [{}, { key: '' }, { key: 'x'.repeat(101) }] },
    'ui.scroll': {
      parse: (a) => parseAction('ui.scroll', a),
      good: [{ target: ref, deltaY: 200 }, { target: point, deltaX: -50 }, { target: ref, deltaX: 10_000, deltaY: -10_000 }],
      bad: [{ target: ref, deltaY: 10_001 }, { target: ref, deltaX: -10_001 }, { deltaY: 10 }]
    },
    'ui.drag': {
      parse: (a) => parseAction('ui.drag', a),
      good: [{ from: ref, to: { ref: 'a1b2c3:5' } }, { from: ref, by: { x: 10, y: 0 }, steps: 100 }],
      bad: [{ from: ref, to: { ref: 'a1b2c3:5' }, steps: 0 }, { from: ref, to: { ref: 'a1b2c3:5' }, steps: 101 }, { from: ref, by: { x: 20_000, y: 0 } }, { to: ref }]
    },
    'wait.for': {
      parse: (a) => parseCondition(a),
      good: [
        { condition: 'ui.present', role: 'dialog', name: 'New project' },
        { condition: 'ui.absent', role: 'dialog', scope: 'editor', exact: false },
        { condition: 'ui.absent', role: 'button', name: 'Save', within: 'a1b2c3:9' },
        { condition: 'ui.context', screen: 'editor', mode: null, dialog: null },
        { condition: 'ui.context', dialog: 'New project' },
        { condition: 'preview.ready', path: '/about/' },
        { condition: 'save.settled', changed: false },
        { condition: 'project.revision', atLeast: 0 },
        { condition: 'export.finished' },
        { condition: 'outcome.terminal', since: 'start' }
      ],
      bad: [{}, { condition: 'ui.gone' }, { condition: 'ui.present', role: 'Dialog' }, { condition: 'ui.context', screen: 'home' }, { condition: 'ui.context', mode: 'code' }, { condition: 'preview.ready', path: 'about' }, { condition: 'project.revision', atLeast: -1 }, { condition: 'outcome.terminal', since: 'later' }, { condition: 'export.finished', verbose: true }]
    },
    'exports.inspect': {
      parse: (a) => parseInspectArgs(a),
      good: [{ path: 'exports/site' }, { path: 'exports/site', file: 'index.html', find: 'Harbour', read: true }],
      bad: [{}, { path: '' }, { path: 'exports/site', find: '' }, { path: 'exports/site', read: 'yes' }, { path: 'exports/site', depth: 1 }]
    },
    'desktop.setAnswers': {
      parse: answers,
      good: [
        { answers: [] },
        { answers: [{ dialog: 'open', selection: 'folder', title: 'Choose where to create the project', paths: ['workspace'] }] },
        { answers: [{ dialog: 'save', path: 'exports/site.zip', overwrite: 'replace' }, { dialog: 'message', button: 'OK', checkbox: true }, { dialog: 'open', cancel: true }] },
        { answers: [{ dialog: 'open', selection: 'fileOrFolder', paths: ['imports/a.jpg'] }, { dialog: 'save', path: 'exports/b.zip', overwrite: 'decline' }] }
      ],
      bad: [{}, { answers: [{ dialog: 'print', cancel: true }] }, { answers: [{ dialog: 'open', cancel: false }] }, { answers: [{ dialog: 'open', cancel: true, within: ['/x'] }] }, { answers: [{ dialog: 'open', paths: [] }] }]
    }
  };

  for (const [op, { parse, good, bad }] of Object.entries(SAMPLES)) {
    it(`${op}: the schema, and the tool's as advertised, accept and refuse what the driver does`, () => {
      const ajv = new Ajv2020({ strict: true });
      const validate = ajv.compile(INPUT_SCHEMAS[op as keyof typeof INPUT_SCHEMAS]);
      const advertised = ajv.compile(tools.find((t) => t.title === op)!.inputSchema);
      // What a contained session refuses, the tool does not advertise.
      const allowed = (a: Record<string, unknown>) => !(op === 'session.start' && ('headed' in a || 'artifactsDir' in a));
      for (const a of good) {
        expect(validate(a), `schema accepts ${JSON.stringify(a).slice(0, 200)}: ${JSON.stringify(validate.errors)}`).toBe(true);
        expect(advertised(a), `the tool accepts ${JSON.stringify(a).slice(0, 200)}`).toBe(allowed(a));
        expect(() => parse(a), `parser accepts ${JSON.stringify(a).slice(0, 200)}`).not.toThrow();
      }
      for (const a of bad) {
        expect(validate(a), `schema refuses ${JSON.stringify(a).slice(0, 200)}`).toBe(false);
        expect(advertised(a), `the tool refuses ${JSON.stringify(a).slice(0, 200)}`).toBe(false);
        expect(() => parse(a), `parser refuses ${JSON.stringify(a).slice(0, 200)}`).toThrow();
      }
    });
  }

  it('advertises the request options with the driver\'s own bounds', () => {
    const ajv = new Ajv2020({ strict: true });
    const describe = ajv.compile(tools.find((t) => t.name === 'session_describe')!.inputSchema);
    const snapshot = ajv.compile(tools.find((t) => t.name === 'ui_snapshot')!.inputSchema);
    expect([describe({ timeoutMs: 1 }), describe({ timeoutMs: 30 * 60 * 1000 }), describe({ timeoutMs: 0 }), describe({ timeoutMs: 30 * 60 * 1000 + 1 }), describe({ timeoutMs: 1.5 })]).toEqual([true, true, false, false, false]);
    expect([snapshot({ expectWindow: 1 }), snapshot({ expectWindow: 0 }), describe({ expectWindow: 1 })]).toEqual([true, false, false]);
  });

  it('prints a Codex configuration that runs this server from this checkout with this Node', () => {
    const toml = codexConfig('/opt/node/bin/node', '/work/builder', 'darwin');
    expect(toml).toContain('[mcp_servers.siteorigin_builder]');
    expect(toml).toContain('command = "/opt/node/bin/node"');
    expect(toml).toContain(`args = [${JSON.stringify(MCP_PATH)}]`);
    expect(toml).toContain('cwd = "/work/builder"');
    expect(toml).toMatch(/tool_timeout_sec = (\d+)/);
    // Pre-approving every tool is the person's call: it is offered, commented out, with why.
    expect(toml).toContain('# default_tools_approval_mode = "approve"');
    expect(toml).not.toMatch(/^default_tools_approval_mode/m);
    expect(toml).toContain('Developer mode');
    expect(toml).not.toContain('env_vars');
    expect(codexConfig('/n', '/r', 'linux')).toContain('env_vars = ["DISPLAY", "XAUTHORITY"]');
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
    // A relative PATH entry still gives a full path, which means the same from the checkout Codex starts it in.
    expect(thisNode(relative(process.cwd(), bin), process.execPath)).toBe(join(bin, 'node'));
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
  readonly exited = new Promise<{ code: number; signal: null }>((r) => (this.exit = () => r({ code: 1, signal: null })));
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
  /** The host process ends by itself. */
  exitNow() {
    this.exit();
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
    send({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: CLIENT_INFO });
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
      // The revision whose receivers must take batches, which this server does not.
      ['2025-03-26', '2025-11-25'],
      ['2099-01-01', '2025-11-25']
    ]) {
      const h = harness();
      h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: asked, capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
      const r = await h.answer(1);
      expect(r.result.protocolVersion).toBe(agreed);
      expect(r.result.capabilities).toEqual({ tools: { listChanged: false } });
      expect(r.result.serverInfo).toMatchObject({ name: SERVER_NAME, version: '9.9.9' });
      expect(r.result.instructions).toMatch(/session_start/);
    }
    expect(MCP_VERSIONS).toEqual(['2025-11-25', '2025-06-18', '2024-11-05']);
  });

  it('answers only initialize and ping before it is initialized, and initializes once', async () => {
    const h = harness();
    h.send({ jsonrpc: '2.0', id: 'p', method: 'ping' });
    h.send({ jsonrpc: '2.0', id: 'early', method: 'tools/list' });
    expect((await h.answer('p')).result).toEqual({});
    expect((await h.answer('early')).error.code).toBe(INVALID_REQUEST);
    h.send({ jsonrpc: '2.0', id: 'bad', method: 'initialize', params: { capabilities: {} } });
    expect((await h.answer('bad')).error.code).toBe(INVALID_PARAMS);
    // An incomplete handshake is refused without using up the connection's one initialize.
    h.send({ jsonrpc: '2.0', id: 'partial', method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    h.send({ jsonrpc: '2.0', id: 'nameless', method: 'initialize', params: { ...CLIENT_INFO, clientInfo: {} } });
    expect([(await h.answer('partial')).error.code, (await h.answer('nameless')).error.code]).toEqual([INVALID_PARAMS, INVALID_PARAMS]);
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
    // Beyond the integers JSON.parse keeps exactly, two ids could be read as one.
    h.send('{"jsonrpc":"2.0","id":9007199254740993,"method":"ping"}');
    h.send({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: [] });
    h.send({ jsonrpc: '2.0', id: 11, method: 'resources/list' });
    h.send({ jsonrpc: '2.0', id: 12, result: {} });
    h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } });
    h.send({ jsonrpc: '2.0', id: 0, method: 'ping' });
    h.send({ jsonrpc: '2.0', id: 'zero', method: 'ping' });
    await h.answer(0);
    await h.answer('zero');
    await until(() => h.out.length >= 12);
    await new Promise((r) => setTimeout(r, 20));
    const unread = h.out.filter((m) => !('id' in m)).map((m) => m.error.code);
    expect(unread.sort()).toEqual([INVALID_REQUEST, INVALID_REQUEST, INVALID_REQUEST, INVALID_REQUEST, PARSE_ERROR].sort());
    expect((await h.answer(8)).error.code).toBe(INVALID_REQUEST);
    expect((await h.answer(9)).error.code).toBe(INVALID_REQUEST);
    expect((await h.answer(10)).error.code).toBe(INVALID_PARAMS);
    expect((await h.answer(11)).error.code).toBe(METHOD_NOT_FOUND);
    expect(h.out.some((m) => m.id === 12), 'an answer to nothing is not answered').toBe(false);
    expect((await h.answer(0)).result, 'an id of 0 is an id').toEqual({});
    expect(h.out, 'with the answer to initialize').toHaveLength(12);
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

  it('lifts a window guard only for an operation that runs against the window; elsewhere the driver refuses it', async () => {
    const host = new FakeHost();
    const h = harness(async () => host);
    await h.init();
    await h.call('window_info', { expectWindow: 2 });
    await h.call('session_close', { expectWindow: 2, timeoutMs: 1000 });
    expect(host.calls).toEqual([
      { op: 'window.info', args: {}, opts: { expectWindow: 2 } },
      { op: 'session.close', args: { expectWindow: 2 }, opts: { timeoutMs: 1000 } }
    ]);
  });

  it('refuses a tool that is not there, or arguments that are not an object, as a protocol error', async () => {
    const h = harness();
    await h.init();
    expect((await h.call('ui.click', {})).error.code).toBe(INVALID_PARAMS);
    expect((await h.call('constructor', {})).error.code).toBe(INVALID_PARAMS);
    expect((await h.call('session_describe', [])).error.code).toBe(INVALID_PARAMS);
    // null is not "no arguments": a close sent with it must not close anything.
    expect((await h.call('session_close', null)).error.code).toBe(INVALID_PARAMS);
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
      const second = hosts.length === 1;
      const host = new FakeHost((op, args) => (op === 'session.close' && args?.failed === 'yes' ? failed(op, 'BAD_REQUEST') : op === 'session.close' && second ? failed(op, 'CLEANUP_FAILED') : success(op)));
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
    await h.call('session_close', {});
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

describe('session hosts, when things go wrong', () => {
  it('sends nothing for a call cancelled while its host started, and answers neither a call cancelled after it was sent', async () => {
    let release!: (h: HostConnection) => void;
    let finish!: () => void;
    const host = new FakeHost((op) => (op === 'ui.click' ? new Promise<Reply>((r) => (finish = () => r(success(op)))) : success(op)));
    const h = harness(() => new Promise((r) => (release = r)));
    await h.init();
    h.send({ jsonrpc: '2.0', id: 'start', method: 'tools/call', params: { name: 'session_start', arguments: {} } });
    h.send({ jsonrpc: '2.0', id: 'other', method: 'tools/call', params: { name: 'session_describe', arguments: {} } });
    await until(() => h.connects() === 1);
    h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'start', reason: 'changed my mind' } });
    release(host);
    await h.answer('other');
    expect(host.calls.map((c) => c.op), 'the cancelled start never reached the host').toEqual(['session.describe']);
    h.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ui_click', arguments: { target: { ref: 'a1b2c3:1' } } } });
    await until(() => host.calls.length === 2);
    h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
    finish();
    h.send({ jsonrpc: '2.0', id: 'after', method: 'ping' });
    await h.answer('after');
    await new Promise((r) => setTimeout(r, 20));
    expect(h.out.some((m) => m.id === 'start' || m.id === 7), 'a cancelled call is not answered').toBe(false);
  });

  it('a late failure from a host already retired leaves its successor in place', async () => {
    let reject!: (e: Error) => void;
    const hosts: FakeHost[] = [];
    const h = harness(async () => {
      const first = hosts.length === 0;
      const host = new FakeHost((op) => (first && op === 'ui.click' ? new Promise<Reply>((_, r) => (reject = r)) : success(op)));
      hosts.push(host);
      return host;
    });
    await h.init();
    const click = h.call('ui_click', { target: { ref: 'a1b2c3:1' } });
    await until(() => hosts[0]?.calls.length === 1);
    await h.call('session_close', {});
    await h.call('session_start', {});
    reject(new Error('The session host exited (code 1, signal null).'));
    expect((await click).result.structuredContent.error.code).toBe('HOST_LOST');
    await h.call('session_describe', {});
    expect(hosts.map((x) => x.calls.map((c) => c.op))).toEqual([['ui.click', 'session.close'], ['session.start', 'session.describe']]);
    expect(hosts[0].disconnects, 'the host that failed is told to close').toBe(1);
  });

  it('tells the next call once that a host exited by itself, sends it nowhere, and lets a start begin afresh at once', async () => {
    const hosts: FakeHost[] = [];
    const h = harness(async () => {
      const host = new FakeHost();
      hosts.push(host);
      return host;
    });
    await h.init();
    await h.call('session_start', {});
    hosts[0].exitNow();
    await new Promise((r) => setTimeout(r, 10));
    const told = (await h.call('ui_snapshot', {})).result;
    expect([told.isError, told.structuredContent.error.code, told.structuredContent.error.details.outcome]).toEqual([true, 'HOST_LOST', 'not-sent']);
    expect(told.structuredContent.error.message).toContain('exited by itself (code 1');
    expect(hosts).toHaveLength(1);
    expect((await h.call('ui_snapshot', {})).result.isError, 'told once').toBeUndefined();
    hosts[1].exitNow();
    await new Promise((r) => setTimeout(r, 10));
    expect((await h.call('session_start', {})).result.isError, 'a start is the way on, so it is not held up').toBeUndefined();
    expect(hosts.map((x) => x.calls.map((c) => c.op))).toEqual([['session.start'], ['ui.snapshot'], ['session.start']]);
  });

  it('drops a request that reuses an id still being answered, and answers the first', async () => {
    let finish!: () => void;
    const host = new FakeHost((op) => (op === 'ui.click' ? new Promise<Reply>((r) => (finish = () => r(success(op)))) : success(op)));
    const h = harness(async () => host);
    await h.init();
    h.send({ jsonrpc: '2.0', id: 'dup', method: 'tools/call', params: { name: 'ui_click', arguments: { target: { ref: 'a1b2c3:1' } } } });
    await until(() => host.calls.length === 1);
    h.send({ jsonrpc: '2.0', id: 'dup', method: 'tools/call', params: { name: 'session_close', arguments: {} } });
    h.send({ jsonrpc: '2.0', id: 'dup', method: 'ping' });
    // Not even an error about its params: that answer would carry the id too.
    h.send({ jsonrpc: '2.0', id: 'dup', method: 'tools/call', params: null });
    h.send({ id: 'dup', method: 'ping' });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.out.filter((m) => m.id === 'dup')).toEqual([]);
    finish();
    await h.answer('dup');
    await new Promise((r) => setTimeout(r, 20));
    expect(h.out.filter((m) => m.id === 'dup').map((m) => m.result.structuredContent.op)).toEqual(['ui.click']);
    expect(host.calls.map((c) => c.op), 'the reuse never reached the host').toEqual(['ui.click']);
  });

  it('holds an id until its answer is written, and a number id like a string one', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const out: Record<string, any>[] = [];
    const server = new McpServer({ connect: async () => new FakeHost(), write: async (line) => (await gate, void out.push(JSON.parse(line))) });
    server.handle(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }));
    await new Promise((r) => setTimeout(r, 10));
    server.handle(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }));
    server.handle(JSON.stringify({ jsonrpc: '2.0', id: '5', method: 'ping' }));
    open();
    await until(() => out.length >= 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(out.map((m) => m.id)).toEqual([5, '5']);
  });

  it('a call cancelled before its host died leaves the loss for the next call to report', async () => {
    let reject!: (e: Error) => void;
    const hosts: FakeHost[] = [];
    const h = harness(async () => {
      const first = hosts.length === 0;
      const host = new FakeHost((op) => (first && op === 'ui.click' ? new Promise<Reply>((_, r) => (reject = r)) : success(op)));
      hosts.push(host);
      return host;
    });
    await h.init();
    h.send({ jsonrpc: '2.0', id: 'c', method: 'tools/call', params: { name: 'ui_click', arguments: { target: { ref: 'a1b2c3:1' } } } });
    await until(() => hosts[0]?.calls.length === 1);
    h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'c' } });
    reject(new Error('The session host exited (code null, signal SIGKILL).'));
    await new Promise((r) => setTimeout(r, 10));
    const told = (await h.call('ui_snapshot', {})).result;
    expect([told.structuredContent.error?.code, told.structuredContent.error?.details.outcome]).toEqual(['HOST_LOST', 'not-sent']);
    expect(told.structuredContent.error.message).toContain('SIGKILL');
    expect(h.out.some((m) => m.id === 'c')).toBe(false);
    expect(hosts[0].disconnects).toBe(1);
  });

  it('tells the next call a host is gone even when the call it died under still got its answer', async () => {
    let finish!: () => void;
    const hosts: FakeHost[] = [];
    const h = harness(async () => {
      const host = new FakeHost((op) => (op === 'ui.click' ? new Promise<Reply>((r) => (finish = () => r(success(op)))) : success(op)));
      hosts.push(host);
      return host;
    });
    await h.init();
    const click = h.call('ui_click', { target: { ref: 'a1b2c3:1' } });
    await until(() => hosts[0]?.calls.length === 1);
    hosts[0].exitNow();
    await new Promise((r) => setTimeout(r, 10));
    finish();
    expect((await click).result.isError, 'its last answer was already written').toBeUndefined();
    const told = (await h.call('ui_snapshot', {})).result;
    expect([told.structuredContent.error?.code, told.structuredContent.error?.details.outcome]).toEqual(['HOST_LOST', 'not-sent']);
    expect(hosts).toHaveLength(1);
  });

  it('expects the end of a host whose session was closed, even when its exit is seen before the answer', async () => {
    let finish!: () => void;
    const hosts: FakeHost[] = [];
    const h = harness(async () => {
      const host = new FakeHost((op) => (op === 'session.close' ? new Promise<Reply>((r) => (finish = () => r(success(op)))) : success(op)));
      hosts.push(host);
      return host;
    });
    await h.init();
    await h.call('session_start', {});
    const close = h.call('session_close', {});
    await until(() => hosts[0].calls.length === 2);
    hosts[0].exitNow();
    await new Promise((r) => setTimeout(r, 10));
    finish();
    expect((await close).result.isError).toBeUndefined();
    expect((await h.call('session_describe', {})).result.isError, 'no loss to report').toBeUndefined();
    expect(hosts.map((x) => x.calls.map((c) => c.op))).toEqual([['session.start', 'session.close'], ['session.describe']]);
  });

  it('ends once, whoever asks, and answers nothing that arrives after', async () => {
    const host = new FakeHost();
    const h = harness(async () => host);
    await h.init();
    await h.call('session_start', {});
    const a = h.server.end('the client closed its input');
    const b = h.server.end('got SIGTERM');
    expect(a).toBe(b);
    await a;
    const before = h.out.length;
    h.send({ jsonrpc: '2.0', id: 'late', method: 'ping' });
    await new Promise((r) => setTimeout(r, 20));
    expect([host.disconnects, h.out.length]).toEqual([1, before]);
  });
});

describe('reading lines', () => {
  const reader = () => {
    const input = new PassThrough();
    const lines: string[] = [];
    let oversized = 0;
    let ended: string | null = null;
    readLines(input, 10, { line: (l) => lines.push(l), oversized: () => oversized++, end: (r) => (ended = r) });
    return { input, lines, oversized: () => oversized, ended: () => ended };
  };

  it('splits on newlines across chunks, drops a carriage return, and keeps a last line with none', async () => {
    const r = reader();
    r.input.write('ab');
    r.input.write('c\r\nde\nf');
    r.input.end('g');
    await until(() => r.ended() !== null);
    expect(r.lines).toEqual(['abc', 'de', 'fg']);
    expect(r.ended()).toBe('end');
  });

  it('drops a line longer than the limit through its newline without holding it, once, and reads on', async () => {
    const r = reader();
    r.input.write('0123456789');
    r.input.write('more, never held');
    r.input.write(' still more\nok\n');
    r.input.write('x'.repeat(11) + '\nfine\n');
    await until(() => r.lines.length === 2);
    expect(r.lines).toEqual(['ok', 'fine']);
    expect(r.oversized()).toBe(2);
    expect(MAX_MESSAGE).toBe(4 * 1024 * 1024);
  });

  it('ends on an input error rather than throwing', async () => {
    const r = reader();
    r.input.destroy(new Error('EIO'));
    await until(() => r.ended() !== null);
    expect(r.ended()).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// The real subprocess
// ---------------------------------------------------------------------------

describe('the server as a subprocess', () => {
  it('runs from the configuration --print-config gives, printed and started outside the checkout', async () => {
    const printed = spawnSync(process.execPath, ['--no-warnings', MCP_PATH, '--print-config'], { cwd: scratch, encoding: 'utf8' });
    expect(printed.status).toBe(0);
    const value = (key: string) => JSON.parse(new RegExp(`^${key} = (.*)$`, 'm').exec(printed.stdout)![1]);
    const [command, args, cwd] = [value('command'), value('args'), value('cwd')];
    expect(statSync(command).isFile()).toBe(true);
    expect(args).toEqual([MCP_PATH]);
    expect(realpathSync(cwd)).toBe(realpathSync(join(MCP_PATH, '..', '..', '..')));
    const transport = new StdioClientTransport({ command, args, cwd, stderr: 'ignore' });
    const client = new Client({ name: 'printed-config', version: '1.0.0' });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('session_start');
    await client.close();
  }, 60_000);

  it('serves the official SDK client: discovery, a real session host, the driver\'s errors, and an exit once it closes', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-warnings', MCP_PATH], stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (d) => (stderr += String(d)));
    const client = new Client({ name: 'driver-mcp-test', version: '1.0.0' });
    // Anything on stdout that is not a message the SDK can read lands here.
    const errors: unknown[] = [];
    client.onerror = (e) => errors.push(e);
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
    expect(errors).toEqual([]);
  }, 60_000);

  it('goes on serving when its client stops reading its stderr', async () => {
    const child = spawn(process.execPath, ['--no-warnings', MCP_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr!.destroy();
    const lines: string[] = [];
    createInterface({ input: child.stdout! }).on('line', (l) => lines.push(l));
    const closed = new Promise<{ code: number | null; signal: string | null }>((r) => child.once('close', (code, signal) => r({ code, signal })));
    const send = (m: unknown) => child.stdin!.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: CLIENT_INFO });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_describe', arguments: {} } });
    await until(() => lines.length >= 2, 30_000);
    send({ jsonrpc: '2.0', id: 3, method: 'ping' });
    await until(() => lines.length >= 3, 10_000);
    child.stdin!.end();
    expect(await closed).toEqual({ code: 0, signal: null });
    expect(lines.map((l) => JSON.parse(l).id)).toEqual([1, 2, 3]);
  }, 60_000);

  it('writes only JSON-RPC on stdout, one message a line, and exits 0 once its input ends, its host with it', async () => {
    const child = spawn(process.execPath, ['--no-warnings', MCP_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: string[] = [];
    createInterface({ input: child.stdout! }).on('line', (l) => lines.push(l));
    let stderr = '';
    child.stderr!.on('data', (d) => (stderr += String(d)));
    // 'close' comes once stdout has been read to its end, after the exit: lines written last are counted too.
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.once('close', (code, signal) => r({ code, signal })));
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

describe('outside the shipped app', () => {
  it('nothing the editor, its preview or an exported site is built from reaches the driver or the MCP SDK', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : files(join(dir, e.name))) : /\.(ts|tsx|js|mjs|svelte)$/.test(e.name) ? [join(dir, e.name)] : []));
    const root = join(MCP_PATH, '..', '..', '..');
    const reaching = [...files(join(root, 'src')), ...files(join(root, 'templates'))].filter((f) => /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"][^'"]*(tests\/driver|@modelcontextprotocol)/m.test(readFileSync(f, 'utf8')));
    expect(reaching).toEqual([]);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies)).not.toContain('@modelcontextprotocol/sdk');
    expect(Object.keys(pkg.devDependencies)).toContain('@modelcontextprotocol/sdk');
  });
});

// ---------------------------------------------------------------------------
// The driver operations added for it
// ---------------------------------------------------------------------------

describe('ui.waitFor', () => {
  const located = (name: string): Located => ({ scope: 'editor', region: ['dialog "New project"'], node: { ref: 'a1b2c3:1', role: 'dialog', name } as Located['node'] });
  const notFound = () => new DriverError('TARGET_NOT_FOUND', 'nothing');
  const run = (locate: (search?: unknown) => Promise<Located>, args: Record<string, unknown>, ms = 2000) =>
    waitFor(locate, parseWaitArgs(args), { deadline: Date.now() + ms, signal: new AbortController().signal, intervalMs: 5 });

  it('takes a search as ui.locate does, with a state; a ref waits only for absence', () => {
    expect(parseWaitArgs({ role: 'dialog', name: 'New project' })).toEqual({ state: 'present', search: { role: 'dialog', name: 'New project', scope: 'all' } });
    expect(parseWaitArgs({ ref: 'a1b2c3:4', state: 'absent' })).toEqual({ state: 'absent', search: { ref: 'a1b2c3:4' } });
    expect(() => parseWaitArgs({ ref: 'a1b2c3:4' })).toThrow(/absent/);
    expect(() => parseWaitArgs({ role: 'dialog', state: 'visible' })).toThrow(/present/);
    expect(() => parseWaitArgs({ role: 'dialog', after: 3 })).toThrow('ui.waitFor does not take "after".');
  });

  it('looks again with the same search until the element appears, and answers it as ui.locate would', async () => {
    let n = 0;
    const searches: unknown[] = [];
    const r = await run(async (search?: unknown) => (searches.push(search), ++n < 4 ? Promise.reject(notFound()) : located('New project')), { role: 'dialog', name: 'New project', scope: 'editor' });
    expect(r).toEqual({ state: 'present', ...located('New project'), waitedMs: expect.any(Number), checks: 4 });
    expect(searches).toEqual(Array(4).fill({ role: 'dialog', name: 'New project', scope: 'editor' }));
  });

  it('uses its whole budget: a short wait still looks again at its end', async () => {
    const appears = Date.now() + 100;
    // 500 ms for the request leaves 200 ms to wait, less than one 250 ms interval.
    const r = await waitFor(async () => (Date.now() >= appears ? located('x') : Promise.reject(notFound())), parseWaitArgs({ role: 'dialog' }), { deadline: Date.now() + 500, signal: new AbortController().signal });
    expect([r.state, r.checks]).toEqual(['present', 2]);
    expect(WAIT_LIMITS).toEqual({ intervalMs: 250, marginMs: 300 });
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
    // A ref to search within that has changed never comes back.
    n = 0;
    const changed = new DriverError('STALE_REF', 'changed', { details: { reason: 'changed' } });
    await expect(run(async () => (n++, Promise.reject(changed)), { role: 'textbox', within: 'a1b2c3:9' })).rejects.toMatchObject({ code: 'STALE_REF' });
    expect(n).toBe(1);
    // Nor does a window replaced under the wait.
    const replaced = new DriverError('WINDOW_REPLACED', 'replaced', { details: { from: 1, to: 2 } });
    await expect(run(async () => Promise.reject(replaced), { role: 'dialog', state: 'absent' })).rejects.toMatchObject({ code: 'WINDOW_REPLACED' });
  });

  it('does not call something absent while a preview the search covers is still loading', async () => {
    let n = 0;
    // locate says when a preview on its way left part of the search undone (incomplete), on every "not found".
    const loadingPreview = () => new DriverError('TARGET_NOT_FOUND', 'none', { details: { preview: 'loading', incomplete: true } });
    const readyPreview = () => new DriverError('TARGET_NOT_FOUND', 'none', { details: { preview: 'ready', incomplete: false } });
    expect(await run(async () => Promise.reject(++n < 3 ? loadingPreview() : readyPreview()), { role: 'heading', name: 'Welcome', state: 'absent' })).toMatchObject({ state: 'absent', checks: 3 });
    n = 0;
    const noRegion = () => new DriverError('TARGET_NOT_FOUND', 'There is no region "x" to search.', { details: { preview: 'loading', incomplete: true } });
    expect(await run(async () => Promise.reject(++n < 2 ? noRegion() : readyPreview()), { role: 'heading', region: 'x', state: 'absent' }), 'a region the loading preview may hold is waited for').toMatchObject({ state: 'absent', checks: 2 });
    n = 0;
    const editorOnly = new DriverError('TARGET_NOT_FOUND', 'none', { details: { preview: 'loading', incomplete: false } });
    expect(await run(async () => (n++, Promise.reject(editorOnly)), { role: 'dialog', within: 'a1b2c3:9', state: 'absent' }), 'a search the preview takes no part in is settled while it loads').toMatchObject({ state: 'absent', checks: 1 });
    const absentPreview = new DriverError('TARGET_NOT_FOUND', 'none', { details: { preview: 'absent', incomplete: false } });
    expect(await run(async () => Promise.reject(absentPreview), { role: 'heading', state: 'absent' })).toMatchObject({ state: 'absent', checks: 1 });
  });

  it('ends an absence wait for a ref for every reason it no longer names its element, a preview no longer shown included', async () => {
    for (const reason of ['gone', 'changed', 'document', 'project', 'window']) {
      const e = new DriverError('STALE_REF', reason, { details: { reason } });
      expect(await run(async () => Promise.reject(e), { ref: 'a1b2c3:9', state: 'absent' }), reason).toMatchObject({ state: 'absent', reason, checks: 1 });
    }
    const unshown = new DriverError('STALE_REF', 'not shown', { details: { reason: 'loading', preview: 'absent' } });
    expect(await run(async () => Promise.reject(unshown), { ref: 'a1b2c3:9', state: 'absent' })).toMatchObject({ state: 'absent', reason: 'gone' });
    let n = 0;
    const loading = new DriverError('STALE_REF', 'loading', { details: { reason: 'loading', preview: 'loading' } });
    const gone = new DriverError('STALE_REF', 'gone', { details: { reason: 'gone' } });
    expect(await run(async () => Promise.reject(++n < 3 ? loading : gone), { ref: 'a1b2c3:9', state: 'absent' }), 'a loading preview is waited out').toMatchObject({ reason: 'gone', checks: 3 });
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
    // locate's own message quotes the search, as it may: the wait's answer passes on only its code.
    const quoting = () => new DriverError('TARGET_NOT_FOUND', 'Nothing is dialog "Never".');
    const e = await run(async () => Promise.reject(quoting()), { role: 'dialog', name: 'Never' }, WAIT_LIMITS.marginMs + 150).catch((x: DriverError) => x);
    expect(e).toBeInstanceOf(DriverError);
    expect((e as DriverError).code).toBe('TIMEOUT');
    expect((e as DriverError).message, 'never the search itself, which can hold a credential').not.toContain('Never');
    expect((e as DriverError).message).toMatch(/^Nothing fitting the search appeared in time \(\d+ looks\)\.$/);
    expect((e as DriverError).details).toMatchObject({ phase: 'ui.waitFor', sessionState: 'ready', state: 'present', last: { code: 'TARGET_NOT_FOUND' } });
    expect(JSON.stringify((e as DriverError).details)).not.toContain('Never');
    expect(Date.now() - began, 'it answers before the request\'s own deadline').toBeLessThan(WAIT_LIMITS.marginMs + 150);
    expect(Date.now() - began, 'having used what it had').toBeGreaterThanOrEqual(140);
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
  const captured = { bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') };

  it('returns a file the session saved, with its size and hash', async () => {
    const r = await readSavedImage(artifacts, join(artifacts, 'snapshots', '0001-editor.png'), '0001-editor', captured);
    expect(Buffer.from(r.data, 'base64')).toEqual(png);
    expect([r.bytes, r.sha256]).toEqual([captured.bytes, captured.sha256]);
  });

  it('refuses a link put in its place, a file outside the artifacts, and one past the limit', async () => {
    const outside = join(scratch, 'secret.png');
    writeFileSync(outside, 'not yours');
    symlinkSync(outside, join(artifacts, 'snapshots', '0002-editor.png'));
    await expect(readSavedImage(artifacts, join(artifacts, 'snapshots', '0002-editor.png'), '0002-editor', captured)).rejects.toMatchObject({ code: 'OP_FAILED', details: { reason: 'moved' } });
    await expect(readSavedImage(artifacts, outside, '0003-editor', captured)).rejects.toMatchObject({ details: { reason: 'moved' } });
    mkdirSync(join(scratch, 'elsewhere'));
    writeFileSync(join(scratch, 'elsewhere', '0004-editor.png'), png);
    symlinkSync(join(scratch, 'elsewhere'), join(artifacts, 'linked'));
    await expect(readSavedImage(artifacts, join(artifacts, 'linked', '0004-editor.png'), '0004-editor', captured)).rejects.toMatchObject({ details: { reason: 'moved' } });
    await expect(readSavedImage(artifacts, join(artifacts, 'snapshots', 'missing.png'), '0005-editor', captured)).rejects.toMatchObject({ details: { reason: 'moved' } });
    await expect(readSavedImage(artifacts, join(artifacts, 'snapshots', '0001-editor.png'), '0001-editor', captured, 4)).rejects.toMatchObject({ details: { reason: 'too-large', bytes: png.length, limit: 4 } });
    await expect(readSavedImage(artifacts, join(artifacts, 'snapshots'), '0006-editor', captured), 'a folder').rejects.toMatchObject({ details: { reason: 'moved' } });
    // Its base64 and the reply around it stay inside the official SDK's 10 MiB line.
    expect(Math.ceil(MAX_EVIDENCE_BYTES / 3) * 4).toBeLessThan(10 * 1024 * 1024 - 64 * 1024);
  });

  it.skipIf(process.platform === 'win32')('is not held up by something put in a screenshot\'s place that is not a file', async () => {
    const fifo = join(scratch, 'fifo-artifacts');
    mkdirSync(join(fifo, 'snapshots'), { recursive: true });
    expect(spawnSync('mkfifo', [join(fifo, 'snapshots', '0008-editor.png')]).status).toBe(0);
    const read = readSavedImage(fifo, join(fifo, 'snapshots', '0008-editor.png'), '0008-editor', captured);
    const timer = new Promise((_, r) => setTimeout(() => r(new Error('the read blocked')), 2000));
    await expect(Promise.race([read, timer])).rejects.toMatchObject({ details: { reason: 'moved' } });
  });

  it('returns only the bytes it captured: a file changed since, or a run folder put in its place, is refused', async () => {
    const run = join(scratch, 'run');
    mkdirSync(join(run, 'artifacts', 'snapshots'), { recursive: true });
    const file = join(run, 'artifacts', 'snapshots', '0007-editor.png');
    writeFileSync(file, png);
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]));
    await expect(readSavedImage(join(run, 'artifacts'), file, '0007-editor', captured)).rejects.toMatchObject({ code: 'OP_FAILED', details: { reason: 'changed' } });
    writeFileSync(file, png);
    expect((await readSavedImage(join(run, 'artifacts'), file, '0007-editor', captured)).bytes).toBe(png.length);
    // The whole artifacts folder swapped for a link to another with a file of the same name.
    const other = join(scratch, 'other-run');
    mkdirSync(join(other, 'snapshots'), { recursive: true });
    writeFileSync(join(other, 'snapshots', '0007-editor.png'), Buffer.from('not the screenshot'));
    renameSync(join(run, 'artifacts'), join(run, 'artifacts-moved'));
    symlinkSync(other, join(run, 'artifacts'));
    await expect(readSavedImage(join(run, 'artifacts'), file, '0007-editor', captured)).rejects.toMatchObject({ details: { reason: 'changed' } });
  });
});
