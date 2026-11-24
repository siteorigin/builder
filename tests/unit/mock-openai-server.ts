/**
 * A small in-process OpenAI-compatible server for testing the local adapter over real HTTP and SSE. Each
 * request to /v1/chat/completions plays the next scripted reply, including the ways local servers misbehave.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockReply {
  status?: number;
  /** Non-streaming response body, for error replies. */
  body?: string;
  headers?: Record<string, string>;
  /** SSE frames, written one at a time. A string is sent as raw bytes, anything else as a data frame. */
  frames?: unknown[];
  /** Stop writing after this many frames and hold the connection open. */
  stallAfter?: number;
  /** Close the connection abruptly after this many frames. */
  dropAfter?: number;
  /** Leave the stream open after the last frame, as a server that never closes it would. */
  keepOpen?: boolean;
  /** Wait this long before answering, as a model that takes a while to start would. */
  delayMs?: number;
  /** After the last frame, keep sending this frame every `everyMs` until the client goes away: a reply that never ends. */
  endless?: { frame: unknown; everyMs: number };
}

export interface MockRequest {
  url: string;
  method: string;
  headers: IncomingMessage['headers'];
  body: Record<string, any>;
}

const chunk = (delta: unknown, finish: string | null = null) => ({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
export const DONE = 'data: [DONE]\n\n';

export function pieces(text: string, size = 5): string[] {
  return text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [];
}

/** A plain streamed reply, without a usage chunk unless one is given. */
export function textReply(text: string, opts: { finish?: string; usage?: { prompt_tokens: number; completion_tokens: number }; size?: number } = {}): MockReply {
  return {
    frames: [
      chunk({ role: 'assistant' }),
      ...pieces(text, opts.size).map((content) => chunk({ content })),
      chunk({}, opts.finish ?? 'stop'),
      ...(opts.usage ? [{ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [], usage: opts.usage }] : []),
      DONE
    ]
  };
}

/** A constrained reply: the envelope streamed as ordinary content. */
export function envelopeReply(tool: string, args: unknown, status = 'Working', opts: { finish?: string } = {}): MockReply {
  return textReply(JSON.stringify({ brief_status: status, action: { tool, args } }), { size: 7, ...opts });
}

/** A native tool call with its arguments split into fragments. The server's ID repeats between turns by default. */
export function toolCallReply(name: string, args: unknown, opts: { id?: string; finish?: string; index?: number } = {}): MockReply {
  const raw = typeof args === 'string' ? args : JSON.stringify(args);
  const index = opts.index ?? 0;
  return {
    frames: [
      chunk({ role: 'assistant', content: null }),
      chunk({ tool_calls: [{ index, id: opts.id ?? 'call_0', type: 'function', function: { name, arguments: '' } }] }),
      ...pieces(raw, 4).map((part) => chunk({ tool_calls: [{ index, function: { arguments: part } }] })),
      chunk({}, opts.finish ?? 'tool_calls'),
      DONE
    ]
  };
}

export { chunk as sseChunk };

/** A reply worked out from the request it answers, for a step that needs something an earlier step returned. */
export type MockResponder = (req: MockRequest) => MockReply;

type WireMessage = { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string };

/**
 * Renders a chat request the way a strict template does (Mistral Small 3.2's rule, written out rather than run as
 * Jinja): after an optional system message, tool results and assistant messages that carry tool calls are set
 * aside, and the messages left must alternate user, assistant, user... A tool result must follow its call. Anything
 * else raises, as the template does, so a request that renders here is one the server can format.
 */
export function renderStrictTemplate(messages: WireMessage[]): string {
  const rest = messages[0]?.role === 'system' ? messages.slice(1) : messages;
  rest
    .filter((m) => m.role !== 'tool' && m.tool_calls === undefined)
    .forEach((m, i) => {
      if ((m.role === 'user') !== (i % 2 === 0)) throw new Error('After the optional system message, conversation roles must alternate user/assistant/user/assistant/...');
    });
  let open = new Set<string>();
  return rest
    .map((m) => {
      if (m.role === 'tool') {
        if (!open.delete(String(m.tool_call_id))) throw new Error(`A tool result for ${m.tool_call_id} does not follow its call.`);
        return `[TOOL_RESULTS]${String(m.content)}[/TOOL_RESULTS]`;
      }
      if (open.size) throw new Error('A tool call was left without its result.');
      if (m.role === 'user') return `[INST]${String(m.content)}[/INST]`;
      if (m.role !== 'assistant') throw new Error(`Only user, assistant and tool roles are supported, not ${m.role}.`);
      if (m.tool_calls === undefined) return `${String(m.content)}</s>`;
      const calls = m.tool_calls as Array<{ id: string }>;
      open = new Set(calls.map((c) => c.id));
      return `[TOOL_CALLS]${JSON.stringify(calls)}</s>`;
    })
    .join('');
}

export class MockOpenAIServer {
  readonly requests: MockRequest[] = [];
  /** Requests whose client went away before the reply finished. */
  disconnects = 0;
  models: unknown = { object: 'list', data: [{ id: 'test-model', object: 'model' }] };
  private replies: Array<MockReply | MockResponder> = [];
  private open = new Set<ServerResponse>();
  private server: Server;
  private port = 0;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  get baseURL() {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  script(...replies: Array<MockReply | MockResponder>) {
    this.replies.push(...replies);
    return this;
  }

  async stop() {
    for (const r of this.open) r.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const parts: Buffer[] = [];
    for await (const p of req) parts.push(p as Buffer);
    const text = Buffer.concat(parts).toString('utf8');
    const request: MockRequest = { url: req.url ?? '', method: req.method ?? '', headers: req.headers, body: text ? JSON.parse(text) : {} };
    this.requests.push(request);
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(this.models));
      return;
    }
    const next = this.replies.shift();
    const reply = typeof next === 'function' ? next(request) : next;
    if (!reply) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'No scripted reply left' } }));
      return;
    }
    if (!reply.frames) {
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
      res.end(reply.body ?? '');
      return;
    }
    this.open.add(res);
    let finished = false;
    let endless: ReturnType<typeof setInterval> | undefined;
    res.on('close', () => {
      clearInterval(endless);
      this.open.delete(res);
      if (!finished) this.disconnects++;
    });
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'text/event-stream', ...reply.headers });
    res.flushHeaders();
    for (let i = 0; i < reply.frames.length; i++) {
      if (reply.stallAfter === i) return;
      if (reply.dropAfter === i) {
        res.destroy();
        return;
      }
      const f = reply.frames[i];
      res.write(typeof f === 'string' ? f : `data: ${JSON.stringify(f)}\n\n`);
      await new Promise((r) => setImmediate(r));
      if (res.destroyed) return;
    }
    if (reply.endless) {
      const { frame, everyMs } = reply.endless;
      endless = setInterval(() => res.write(typeof frame === 'string' ? frame : `data: ${JSON.stringify(frame)}\n\n`), everyMs);
      return;
    }
    if (reply.stallAfter !== undefined || reply.keepOpen) return;
    finished = true;
    res.end();
  }
}

/** A loopback port with nothing listening on it. */
export async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}
