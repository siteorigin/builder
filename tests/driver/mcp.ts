/**
 * The test driver as a local MCP server, for Codex and other MCP clients: `node tests/driver/mcp.ts`, launched by the
 * client, speaking MCP (2025-11-25, and the earlier revisions a client may ask for) over stdio: one JSON-RPC message
 * per line on stdin and stdout, nothing else on stdout, and lifecycle messages on stderr.
 *
 * It is a thin adapter over the same driver the Node tests use. Each tool is one driver operation (operations.ts,
 * `ui.click` as `ui_click`) with its arguments described by schemas.ts, and every call goes to a session host
 * (host.ts) through the Node client (client.ts): the host runs the very `Session.call` a Node test does, so a tool
 * answers with the driver's own reply (`structuredContent`, and the same JSON as text), and a failure is the driver's
 * own error, marked `isError`. The one change of form is `evidence.read`, whose PNG comes back as an image block.
 *
 * A host is started when the first call needs one and serves one session; after that session closes, the next call
 * starts another. Hosts run contained: the window stays hidden and the artifacts inside the session, whatever a call
 * asks. When the client goes away (its input ends, or it stops reading) or the server gets a signal, every host is
 * told its client has gone, and each closes its session and ends the app on its own, which it also does if this
 * process is killed outright.
 *
 * `node tests/driver/mcp.ts --print-config` prints a Codex configuration for this checkout instead.
 *
 * Nothing here is part of the editor: it lives in test tooling, launches only the built app, and never reaches the
 * shipped app or an exported site.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connect } from './client.ts';
import type { RequestOptions } from './client.ts';
import { OPERATIONS } from './operations.ts';
import type { OpName } from './operations.ts';
import { REFUSED_CODES } from './protocol.ts';
import type { OpKind, Reply } from './protocol.ts';
import { INPUT_SCHEMAS, REQUEST_OPTIONS } from './schemas.ts';
import type { JsonSchema } from './schemas.ts';

export const MCP_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** The MCP revisions this server speaks, newest first: a client asking for another is offered the newest. */
export const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

export const SERVER_NAME = 'siteorigin-builder-driver';

/** The largest message accepted, in characters. */
export const MAX_MESSAGE = 4 * 1024 * 1024;

/** How long replies still being worked out may hold up the end, once every host has been told to close. */
const DRAIN_MS = 5000;

// JSON-RPC error codes.
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;

const INSTRUCTIONS = [
  'Drives a disposable, headless copy of the SiteOrigin Builder desktop app, as a person would, for testing it.',
  'Start with session_start (the Welcome screen by default), look with ui_snapshot, ui_locate and ui_waitFor, act with the ui_* tools on the refs those observations give, and end with session_close.',
  'A ref goes stale when what it named changes (STALE_REF): observe again for a fresh one. Every failure is the driver\'s error { code, message, retryable, details }; details.hint often says what to do next.',
  'Kinds: observe only reads; act does what a person could, with real input; fixture prepares state no person made through the UI (choosers\' answers, sample files); session manages the run.',
  'Screenshots: ui_snapshot with screenshot: true saves them, and evidence_read returns one by its id as an image.',
  'Requests run one at a time (BUSY otherwise). Once a session has closed (CLOSED), session_close ends it for good and the next session_start starts a new one.'
].join('\n');

/** Arguments a client may not set here: the server's hosts are contained, and refuse them as well. */
const CONTAINED: Partial<Record<OpName, string[]>> = { 'session.start': ['headed', 'artifactsDir'] };

const KINDS: Record<OpKind, string> = {
  session: 'Kind: session (manages the run itself).',
  observe: 'Kind: observe (only reads: no person did anything).',
  fixture: 'Kind: fixture (prepares state no person made through the UI: not something a user did).',
  act: 'Kind: act (does what a person could, with real input).'
};

/** Observations that leave nothing behind: a snapshot can save screenshots and makes earlier screenshot points stale. */
const READ_ONLY = new Set<string>(['session.describe', 'window.info', 'menu.list', 'desktop.events', 'files.list', 'ui.locate', 'ui.waitFor', 'evidence.read', 'wait.for', 'project.summary', 'exports.inspect', 'evidence.log']);

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: { title: string; readOnlyHint: boolean; openWorldHint: false };
}

/** A tool's name for an operation: `ui.click` is `ui_click` (some clients turn tool names into function names, which take no dots). */
export const toolName = (op: string): string => op.replace(/\./g, '_');

/** One tool per driver operation, in the catalog's order. */
export function listTools(): McpTool[] {
  return Object.entries(OPERATIONS).map(([op, spec]) => {
    const schema = INPUT_SCHEMAS[op as OpName];
    if (!schema) throw new Error(`The operation ${op} has no input schema (schemas.ts).`);
    const left = new Set(CONTAINED[op as OpName] ?? []);
    const properties: Record<string, JsonSchema> = Object.fromEntries(Object.entries((schema.properties ?? {}) as Record<string, JsonSchema>).filter(([k]) => !left.has(k)));
    properties.timeoutMs = { ...REQUEST_OPTIONS.timeoutMs, description: `${REQUEST_OPTIONS.timeoutMs.description} Default ${spec.defaultTimeoutMs}.` };
    if (spec.usesWindow) properties.expectWindow = { ...REQUEST_OPTIONS.expectWindow };
    const required = ((schema.required ?? []) as string[]).filter((k) => !left.has(k));
    const inputSchema: JsonSchema = { ...schema, properties };
    if (required.length) inputSchema.required = required;
    else delete inputSchema.required;
    return {
      name: toolName(op),
      title: op,
      description: `${spec.summary}\n\n${KINDS[spec.kind]}${spec.needsApp ? ' Needs a started session.' : ''}`,
      inputSchema,
      annotations: { title: op, readOnlyHint: READ_ONLY.has(op), openWorldHint: false }
    };
  });
}

const TOOL_OPS = new Map(Object.keys(OPERATIONS).map((op) => [toolName(op), op]));

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  structuredContent: Record<string, unknown>;
  isError?: true;
}

/** A driver reply as a tool's result: the reply itself, with an evidence image as an image block. */
export function toolResult(reply: Reply): ToolResult {
  if (reply.ok && reply.op === 'evidence.read') {
    const { data, ...meta } = (reply.result ?? {}) as { data?: unknown; mimeType?: string };
    if (typeof data === 'string') {
      const shown = { ...reply, result: { ...meta, image: 'returned as an image block' } };
      return { content: [{ type: 'image', data, mimeType: meta.mimeType ?? 'image/png' }, { type: 'text', text: JSON.stringify(shown) }], structuredContent: shown };
    }
  }
  const structured = reply as unknown as Record<string, unknown>;
  return { content: [{ type: 'text', text: JSON.stringify(reply) }], structuredContent: structured, ...(reply.ok ? {} : { isError: true as const }) };
}

/**
 * The session host went away, or could not be reached: no driver reply exists. Whether a request that was sent took
 * effect cannot be known, so it is never sent again on its own.
 */
function hostLost(op: string, message: string, outcome: 'not-sent' | 'unknown', began: number): ToolResult {
  const failure = {
    ok: false,
    op,
    elapsedMs: Date.now() - began,
    error: {
      code: 'HOST_LOST',
      message,
      retryable: false,
      details: {
        outcome,
        hint: outcome === 'unknown' ? 'Whatever this call did may or may not have happened, and its session is gone: session_start starts a new one.' : 'Nothing was sent. session_start starts a new session.'
      }
    }
  };
  return { content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure, isError: true };
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/** The part of a driver client (client.ts) the server uses. */
export interface HostConnection {
  request(op: string, args?: Record<string, unknown>, opts?: RequestOptions): Promise<Reply>;
  /** Tell the host its client has gone: it closes its session and exits. */
  disconnect(): Promise<unknown>;
  /** Settles once the host has exited. */
  readonly exited?: Promise<unknown>;
}

export interface ServerOptions {
  /** Start a session host. */
  connect: () => Promise<HostConnection>;
  /** Write one message line to the client; settles once it has been handed on (or could not be). */
  write: (line: string) => Promise<void>;
  /** A lifecycle message, for stderr. */
  log?: (message: string) => void;
  version?: string;
}

type Id = string | number;
type Message = { jsonrpc: '2.0'; id?: Id; result?: unknown; error?: { code: number; message: string; data?: unknown } };

interface Link {
  ready: Promise<HostConnection>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isId = (v: unknown): v is Id => typeof v === 'string' || (typeof v === 'number' && Number.isInteger(v));
const ok = (id: Id, result: unknown): Message => ({ jsonrpc: '2.0', id, result });
/** An error answer; one to a message whose id could not be read carries none. */
const fail = (id: Id | null, code: number, message: string): Message => ({ jsonrpc: '2.0', ...(id === null ? {} : { id }), error: { code, message } });

export class McpServer {
  private readonly opts: ServerOptions;
  private readonly tools = listTools();
  /** Whether an initialize request has been answered: until then, only ping is. */
  private initialized = false;
  /** The host the next call goes to; null until one is needed, and again once its session has closed. */
  private link: Link | null = null;
  /** Every host started and not yet known to have exited, to close on the way out. */
  private readonly links = new Set<Link>();
  private readonly inFlight = new Set<Promise<void>>();
  private ending: Promise<void> | null = null;

  constructor(opts: ServerOptions) {
    this.opts = opts;
  }

  private log(message: string) {
    this.opts.log?.(`siteorigin mcp: ${message}`);
  }

  private send(message: Message): Promise<void> {
    return this.opts.write(JSON.stringify(message));
  }

  /** Take one line from the client. */
  handle(line: string): void {
    if (this.ending || !line.trim()) return;
    const work = this.receive(line).then(
      (answer) => (answer ? this.send(answer) : undefined),
      (e: unknown) => this.log(`a message could not be answered: ${e instanceof Error ? e.message : String(e)}`)
    );
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  private async receive(line: string): Promise<Message | null> {
    if (line.length > MAX_MESSAGE) return fail(null, INVALID_REQUEST, `A message may be at most ${MAX_MESSAGE} characters.`);
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return fail(null, PARSE_ERROR, 'The line is not JSON.');
    }
    if (Array.isArray(msg)) return fail(null, INVALID_REQUEST, 'Batches are not supported: send one message per line.');
    const readable = isRecord(msg) && isId(msg.id) ? msg.id : null;
    if (!isRecord(msg) || msg.jsonrpc !== '2.0') return fail(readable, INVALID_REQUEST, 'A message is a JSON-RPC 2.0 object ("jsonrpc": "2.0").');
    if (typeof msg.method !== 'string') {
      // An answer to a request: this server sends none, so there is nothing to match it to.
      if ('result' in msg || 'error' in msg) return null;
      return fail(readable, INVALID_REQUEST, 'A request or notification has a "method".');
    }
    if (!('id' in msg)) {
      this.notification(msg.method, msg.params);
      return null;
    }
    if (!isId(msg.id)) return fail(null, INVALID_REQUEST, 'A request\'s "id" is a string or an integer.');
    if (msg.params !== undefined && !isRecord(msg.params)) return fail(msg.id, INVALID_PARAMS, '"params" is an object.');
    return this.request(msg.id, msg.method, msg.params ?? {});
  }

  private notification(method: string, params: unknown) {
    if (method === 'notifications/cancelled') {
      const id = isRecord(params) ? params.requestId : undefined;
      // The driver has no way to stop a request part way: it runs on to its own deadline, and its answer is dropped.
      this.log(`request ${JSON.stringify(id)} was cancelled by the client; the driver finishes it within its own deadline`);
    }
  }

  private async request(id: Id, method: string, params: Record<string, unknown>): Promise<Message | null> {
    if (method === 'ping') return ok(id, {});
    if (method === 'initialize') return this.initialize(id, params);
    if (!this.initialized) return fail(id, INVALID_REQUEST, 'Send "initialize" first.');
    if (method === 'tools/list') return ok(id, { tools: this.tools });
    if (method === 'tools/call') return this.callTool(id, params);
    return fail(id, METHOD_NOT_FOUND, `There is no method "${method.slice(0, 100)}".`);
  }

  private initialize(id: Id, params: Record<string, unknown>): Message {
    if (this.initialized) return fail(id, INVALID_REQUEST, 'This connection is already initialized.');
    const asked = params.protocolVersion;
    if (typeof asked !== 'string' || !asked) return fail(id, INVALID_PARAMS, '"protocolVersion" is the MCP revision the client speaks, such as "2025-11-25".');
    if (params.capabilities !== undefined && !isRecord(params.capabilities)) return fail(id, INVALID_PARAMS, '"capabilities" is an object.');
    if (params.clientInfo !== undefined && !isRecord(params.clientInfo)) return fail(id, INVALID_PARAMS, '"clientInfo" is an object.');
    this.initialized = true;
    const version = (MCP_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_VERSIONS[0];
    const client = isRecord(params.clientInfo) && typeof params.clientInfo.name === 'string' ? params.clientInfo.name : 'a client';
    this.log(`${client.slice(0, 100)} connected (MCP ${version})`);
    return ok(id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, title: 'SiteOrigin Builder test driver', version: this.opts.version ?? '0.0.0' },
      instructions: INSTRUCTIONS
    });
  }

  private async callTool(id: Id, params: Record<string, unknown>): Promise<Message> {
    const name = params.name;
    if (typeof name !== 'string' || !name) return fail(id, INVALID_PARAMS, '"name" is the tool to call.');
    const op = TOOL_OPS.get(name);
    if (!op) return fail(id, INVALID_PARAMS, `There is no tool "${name.slice(0, 100)}": tools/list lists them.`);
    const args = params.arguments ?? {};
    if (!isRecord(args)) return fail(id, INVALID_PARAMS, '"arguments" is an object.');
    // The request's own options travel beside its args, as the driver's requests carry them; the host checks them.
    const { timeoutMs, expectWindow, ...rest } = args;
    const options: RequestOptions = {};
    if (timeoutMs !== undefined) options.timeoutMs = timeoutMs as number;
    if (expectWindow !== undefined) options.expectWindow = expectWindow as number;
    return ok(id, await this.forward(op, rest, options));
  }

  /** The host the next call goes to, started if there is none. */
  private acquire(): Link {
    if (!this.link) {
      const link: Link = { ready: this.opts.connect() };
      this.link = link;
      this.links.add(link);
      link.ready.then(
        (host) => void host.exited?.then(() => this.links.delete(link)),
        () => this.links.delete(link)
      );
    }
    return this.link;
  }

  /** Calls after this one start a new host. */
  private retire(link: Link) {
    if (this.link === link) this.link = null;
  }

  private async forward(op: string, args: Record<string, unknown>, options: RequestOptions): Promise<ToolResult> {
    const began = Date.now();
    const closing = 'The MCP server is shutting down.';
    if (this.ending) return hostLost(op, closing, 'not-sent', began);
    const link = this.acquire();
    let host: HostConnection;
    try {
      host = await link.ready;
    } catch (e) {
      this.retire(link);
      return hostLost(op, `The session host could not be started: ${e instanceof Error ? e.message : String(e)}`, 'not-sent', began);
    }
    // The client may have gone while the host started: then nothing reaches it, and closing it ends it.
    if (this.ending) return hostLost(op, closing, 'not-sent', began);
    let reply: Reply;
    try {
      reply = await host.request(op, args, options);
    } catch (e) {
      this.retire(link);
      return hostLost(op, e instanceof Error ? e.message : String(e), 'unknown', began);
    }
    // A close that ran ends its host (host.ts), however it went; one refused before it ran leaves the session as it was.
    if (op === 'session.close' && (reply.ok || !REFUSED_CODES.has(reply.error.code))) this.retire(link);
    return toolResult(reply);
  }

  /**
   * End: take nothing more, tell every host its client has gone (each closes its session and ends its app), and let
   * answers already being worked out go out for a moment. Every call gets the same promise.
   */
  end(reason: string): Promise<void> {
    this.ending ??= (async () => {
      this.link = null;
      const links = [...this.links];
      this.log(`${reason}; closing ${links.length} session host${links.length === 1 ? '' : 's'}`);
      const ended = await Promise.allSettled(
        links.map(async (link) => {
          const host = await link.ready;
          return host.disconnect();
        })
      );
      for (const r of ended) if (r.status === 'fulfilled' && isRecord(r.value) && r.value.timedOut) this.log('a session host was still closing when this server stopped waiting; it finishes on its own');
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...this.inFlight]), new Promise((r) => (timer = setTimeout(r, DRAIN_MS)))]);
      clearTimeout(timer);
    })();
    return this.ending;
  }
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

/** A Codex configuration (~/.codex/config.toml) that runs this server from this checkout with this Node. */
export function codexConfig(node = process.execPath, root = REPO_ROOT): string {
  const toml = (s: string) => JSON.stringify(s);
  return [
    '[mcp_servers.siteorigin_builder]',
    `command = ${toml(node)}`,
    `args = [${toml(MCP_PATH)}]`,
    `cwd = ${toml(root)}`,
    '# Starting a session can take a few minutes on a cold machine (180 s by default, plus the client\'s grace).',
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 300',
    ''
  ].join('\n');
}

function main() {
  if (process.argv.slice(2).includes('--print-config')) {
    process.stdout.write(codexConfig());
    return;
  }
  const stdout = process.stdout;
  // Only MCP messages go to stdout: anything a library logs goes to stderr instead.
  console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
  let gone = false;
  let version = '0.0.0';
  try {
    version = (JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? version;
  } catch {
    // The version is only shown to the client.
  }
  const server = new McpServer({
    connect: () => connect({ contained: true, stderr: 'inherit' }),
    write: (line) =>
      new Promise<void>((done) => {
        if (gone) return done();
        try {
          stdout.write(`${line}\n`, () => done());
        } catch {
          done();
        }
      }),
    log: (message) => process.stderr.write(`${message}\n`),
    version
  });
  const finish = (reason: string) =>
    void server.end(reason).then(() => {
      // Exit once stdout has drained (it is asynchronous on macOS pipes), and soon regardless.
      setTimeout(() => process.exit(), 2000).unref();
      if (gone) process.exit();
      else stdout.write('', () => process.exit());
    });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => server.handle(line));
  lines.on('close', () => finish('the client closed its input'));
  process.stdin.on('error', () => finish('the client\'s input failed'));
  stdout.on('error', () => {
    gone = true;
    finish('the client stopped reading');
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => finish(`got ${signal}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
