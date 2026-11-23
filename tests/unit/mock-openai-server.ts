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

export class MockOpenAIServer {
  readonly requests: MockRequest[] = [];
  /** Requests whose client went away before the reply finished. */
  disconnects = 0;
  models: unknown = { object: 'list', data: [{ id: 'test-model', object: 'model' }] };
  private replies: MockReply[] = [];
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

  script(...replies: MockReply[]) {
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
    this.requests.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers, body: text ? JSON.parse(text) : {} });
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(this.models));
      return;
    }
    const reply = this.replies.shift();
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
    res.on('close', () => {
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
