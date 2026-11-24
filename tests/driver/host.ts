/**
 * Serve one test session over stdio: `node tests/driver/host.ts` reads one JSON request per line on stdin and writes
 * one JSON reply per line on stdout (protocol.ts), matched by id. Nothing else is written to stdout; the host's own
 * messages go to stderr and the app's output to the session's artifacts.
 *
 * Requests run one at a time (another gets BUSY), except session.close, which ends whatever is running. The session
 * ends, and the host exits, once it is closed: by session.close, by the client going away (stdin ends or the pipe
 * breaks), or by a signal. A host that must exit before closing finishes kills the app's process group and removes
 * the run root on the way out.
 */
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REFUSED_CODES } from './protocol.ts';
import type { Reply } from './protocol.ts';
import { Session } from './session.ts';

/** The part of a session the host uses. */
export interface HostedSession {
  call(frame: unknown): Promise<Reply>;
  close(args?: { failed?: boolean }): Promise<unknown>;
}

export type EndReason = 'closed' | 'disconnected' | 'signal';

export interface ServeOptions {
  session: HostedSession;
  input: NodeJS.ReadableStream;
  /** Write one reply line; `done` is called once it has been handed to the OS (or failed). */
  write: (line: string, done: () => void) => void;
  /** Called once, after the session has closed: the host exits from here. `error` is what closing threw, if anything. */
  onEnd: (reason: EndReason, error?: unknown) => void;
}

export interface Server {
  /** End the session and the server; every call gets the same promise. */
  end(reason: EndReason): Promise<void>;
}

/** How long replies still being written may hold up the end of a session. */
const DRAIN_MS = 5000;

export function serve({ session, input, write, onEnd }: ServeOptions): Server {
  let ending: Promise<void> | null = null;
  let disconnected = false;
  const inFlight = new Set<Promise<void>>();
  const send = (reply: Reply) => new Promise<void>((done) => (disconnected ? done() : write(JSON.stringify(reply), done)));
  const end = (reason: EndReason): Promise<void> => {
    if (reason === 'disconnected') disconnected = true;
    ending ??= (async () => {
      let error: unknown;
      await session.close().catch((e: unknown) => (error = e));
      // Replies to requests the close cut short still go out, unless there is no one left to read them, and a reader
      // that stopped reading cannot hold the exit up for long.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...inFlight]), new Promise((r) => (timer = setTimeout(r, DRAIN_MS)))]);
      clearTimeout(timer);
      onEnd(reason, error);
    })();
    return ending;
  };
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim() || disconnected) return;
    const handled = session.call(line).then((reply) => {
      const sent = send(reply);
      // A close that ran ends the host, however it went; one refused before it ran leaves the session as it was. The
      // end waits (bounded) for this reply to be written.
      if (reply.op === 'session.close' && (reply.ok || !REFUSED_CODES.has(reply.error.code))) void end('closed');
      return sent;
    });
    inFlight.add(handled);
    void handled.finally(() => inFlight.delete(handled));
  });
  lines.on('close', () => void end('disconnected'));
  input.on('error', () => void end('disconnected'));
  return { end };
}

function main() {
  // `--contained`: the window stays hidden and the artifacts inside the session, whatever a request asks (mcp.ts).
  const session = new Session({ contained: process.argv.slice(2).includes('--contained') });
  const stdout = process.stdout;
  // Only replies go to stdout: anything a library logs goes to stderr instead.
  console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
  const server = serve({
    session,
    input: process.stdin,
    write: (line, done) => {
      try {
        stdout.write(`${line}\n`, () => done());
      } catch {
        done();
      }
    },
    onEnd: (reason, error) => {
      if (error) console.error(`session host: closing failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = error ? 1 : 0;
      // Exit once stdout has drained (it is asynchronous on macOS pipes), and soon regardless.
      setTimeout(() => process.exit(), 2000).unref();
      stdout.write('', () => process.exit());
    }
  });
  stdout.on('error', () => void server.end('disconnected'));
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => void server.end('signal'));
  process.on('disconnect', () => void server.end('disconnected'));
  process.on('exit', () => session.disposeSync());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
