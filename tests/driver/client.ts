/**
 * A Node client for one test session: starts the stdio host (host.ts) as a child process, sends requests and matches
 * each reply by id. It imports nothing of the app or of Playwright, so any Node program can drive a session.
 *
 *   const client = await connect();
 *   await client.request('session.start', { fixture: 'welcome' });
 *   await client.request('window.info');
 *   await client.request('session.close');
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from './protocol.ts';
import type { Reply, Request } from './protocol.ts';

export const HOST_PATH = fileURLToPath(new URL('./host.ts', import.meta.url));

export interface ConnectOptions {
  /** Extra variables for the host (it builds the app's environment itself, from an allowlist). */
  env?: Record<string, string>;
  /** Where the host's stderr goes: the caller's stderr, nowhere, or appended to this file. Default: inherit. */
  stderr?: 'inherit' | 'ignore' | { file: string };
  /** How long past a request's own deadline the client waits for its reply before giving up on the host. */
  graceMs?: number;
}

export interface RequestOptions {
  timeoutMs?: number;
  expectWindow?: number;
}

/** The transport failed: the host exited, or a reply did not come in time. Protocol failures are replies, not this. */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

interface Pending {
  resolve: (reply: Reply) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DriverClient {
  readonly host: ChildProcess;
  /** Settles when the host has exited. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Replies the client could not match to a request (a frame the host could not read has no id). */
  readonly unmatched: Reply[] = [];
  private pending = new Map<string, Pending>();
  private next = 0;
  private readonly graceMs: number;
  private gone: Error | null = null;

  constructor(host: ChildProcess, graceMs: number) {
    this.host = host;
    this.graceMs = graceMs;
    this.exited = new Promise((resolve) => host.once('exit', (code, signal) => resolve({ code, signal })));
    void this.exited.then(({ code, signal }) => this.fail(new TransportError(`The session host exited (code ${code}, signal ${signal}).`)));
    host.stdin!.on('error', () => undefined);
    createInterface({ input: host.stdout!, crlfDelay: Infinity }).on('line', (line) => this.receive(line));
  }

  get pid(): number {
    return this.host.pid!;
  }

  /** Send one request and wait for its reply. A failed operation resolves with `ok: false`; only the transport rejects. */
  request<T = unknown>(op: string, args?: Record<string, unknown>, opts: RequestOptions = {}): Promise<Reply<T>> {
    if (this.gone) return Promise.reject(this.gone);
    const id = `r${++this.next}`;
    const request: Request = { v: PROTOCOL_VERSION, id, op };
    if (args) request.args = args;
    if (opts.timeoutMs !== undefined) request.timeoutMs = opts.timeoutMs;
    if (opts.expectWindow !== undefined) request.expectWindow = opts.expectWindow;
    return this.send(request) as Promise<Reply<T>>;
  }

  /** Send a frame as given, valid or not (for testing the host's answers to bad input). */
  sendRaw(line: string): void {
    this.host.stdin!.write(`${line}\n`);
  }

  private send(request: Request): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      // The host's own deadline answers first; this one only catches a host that stopped answering at all.
      const wait = (request.timeoutMs ?? 180_000) + this.graceMs;
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new TransportError(`No reply to ${request.op} (${request.id}) within ${wait / 1000}s; disconnecting.`));
        void this.disconnect();
      }, wait);
      this.pending.set(request.id, { resolve, reject, timer });
      this.host.stdin!.write(`${JSON.stringify(request)}\n`);
    });
  }

  private receive(line: string) {
    let reply: Reply;
    try {
      reply = JSON.parse(line) as Reply;
    } catch {
      return;
    }
    const pending = reply.id === null ? undefined : this.pending.get(reply.id);
    if (!pending) {
      this.unmatched.push(reply);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(reply.id!);
    pending.resolve(reply);
  }

  private fail(e: Error) {
    this.gone ??= e;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
      this.pending.delete(id);
    }
  }

  /**
   * Go away without closing the session: the host notices its input end and closes the session itself. Waits up to
   * `waitMs` for the host to exit, then kills it.
   */
  async disconnect(waitMs = 90_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    this.host.stdin!.end();
    const timer = setTimeout(() => this.host.kill('SIGKILL'), waitMs);
    try {
      return await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Start a session host and connect to it. The session itself starts with `session.start`. */
export async function connect(opts: ConnectOptions = {}): Promise<DriverClient> {
  let fd: number | null = null;
  const stderr = opts.stderr === 'ignore' ? 'ignore' : typeof opts.stderr === 'object' ? (fd = openSync(opts.stderr.file, 'a')) : 'inherit';
  const host = spawn(process.execPath, ['--no-warnings', HOST_PATH], { stdio: ['pipe', 'pipe', stderr], env: { ...process.env, ...opts.env }, windowsHide: true });
  if (fd !== null) closeSync(fd);
  await new Promise<void>((resolve, reject) => {
    host.once('spawn', () => resolve());
    host.once('error', reject);
  });
  return new DriverClient(host, opts.graceMs ?? 60_000);
}
