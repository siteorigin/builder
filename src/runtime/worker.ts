/**
 * Project runtime worker (Electron utility process).
 * Runs the project's own Vite/SvelteKit toolchain: dev server for preview and production builds.
 * Its environment is constructed explicitly by the main process and never contains provider credentials.
 */
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { maskSecrets, serializeBuildError } from './build-diagnostics';
import { devPlugin } from './dev-plugin';
import { canonicalDir, frameAncestorsCsp, framePolicyPlugin, previewFsPolicy } from './policy';
import { createPublicationGate, type GateServer, type PublicationGate } from './publication-gate';

type Msg =
  | { type: 'start'; dir: string; port?: number; packaged?: boolean }
  | { type: 'revision'; revision: number }
  | { type: 'hold'; id: string }
  | { type: 'release'; id: string; files: string[] }
  | { type: 'build'; dir: string }
  | { type: 'stop' };

const port = (process as unknown as { parentPort: { on: (e: string, cb: (ev: { data: Msg }) => void) => void; postMessage: (m: unknown) => void } }).parentPort;
const post = (m: unknown) => port.postMessage(m);

type Ws = { send: (p: unknown) => void; on: (event: string, fn: (data: unknown) => void) => void; clients: Set<unknown> };
let server: { close: () => Promise<void>; ws: Ws; httpServer: unknown } | null = null;
/** Holds the preview's hot updates while the editor publishes a batch of files (see publication-gate). */
let gate: PublicationGate | null = null;
/**
 * How long a new batch waits for the pages to show the one before (fetch its modules, apply them, say so), so it
 * replaces nothing they are still reading. Under the editor's own wait for the answer (HOLD_ACK_MS).
 */
const CATCH_UP_MS = 600;

async function loadVite(dir: string) {
  const req = createRequire(join(dir, 'package.json'));
  const entry = req.resolve('vite');
  return (await import(pathToFileURL(entry).href)) as typeof import('vite');
}

/**
 * Vite, SvelteKit and process.cwd() must all name the project the same way. They resolve links on their own, so a
 * project reached through one (macOS: /var is /private/var) would otherwise fail with paths that do not match.
 */
function useRealProjectDir(dir: string): string {
  const real = canonicalDir(dir);
  process.chdir(real);
  return real;
}

/**
 * What the dev server does not watch, anchored to the project root (src/lib/siteorigin must stay watched). Build
 * configuration is not watched: a changed config must go through the editor's trust check, not an automatic restart.
 */
function unwatched(dir: string) {
  return (p: string) =>
    ['.siteorigin', 'siteorigin', 'build', 'node_modules', '.svelte-kit/output'].some((d) => p === join(dir, d) || p.startsWith(join(dir, d) + sep)) ||
    ['vite.config.js', 'vite.config.ts', 'svelte.config.js', 'package.json', 'package-lock.json'].some((f) => p === join(dir, f));
}

async function start(dir: string, wantedPort = 0, packaged = true) {
  const vite = await loadVite(dir);
  const ignored = unwatched(dir);
  const held = createPublicationGate({ root: dir, ignored });
  const s = await vite.createServer({
    root: dir,
    configFile: join(dir, 'vite.config.js'),
    logLevel: 'warn',
    clearScreen: false,
    plugins: [devPlugin(dir), framePolicyPlugin(frameAncestorsCsp(packaged))],
    server: {
      host: '127.0.0.1',
      // Port 0: the operating system picks a free port when the server binds, so nothing can take it in between.
      port: wantedPort,
      strictPort: true,
      cors: false,
      open: false,
      watch: { ignored },
      // A batch of files the editor publishes reaches the page as one update.
      hotUpdateEnvironments: held.hotUpdateEnvironments,
      fs: previewFsPolicy(dir)
    },
    customLogger: {
      info: (m: string) => post({ type: 'log', level: 'info', message: m }),
      warn: (m: string) => post({ type: 'log', level: 'warn', message: m }),
      warnOnce: (m: string) => post({ type: 'log', level: 'warn', message: m }),
      error: (m: string) => post({ type: 'log', level: 'error', message: m }),
      clearScreen: () => {},
      hasErrorLogged: () => false,
      hasWarned: false
    }
  } as never);
  held.attach(s as unknown as GateServer);
  gate = held;
  const ws = (s as unknown as { ws: Ws }).ws;
  // The bridge says which batch its page shows once it has applied it.
  ws.on('siteorigin:applied', (data) => held.applied(Number((data as { batch?: unknown } | null)?.batch)));
  await s.listen();
  server = s as never;
  const addr = (s.httpServer as { address(): { port: number } | string | null } | null)?.address();
  const bound = addr && typeof addr === 'object' ? addr.port : wantedPort;
  post({ type: 'ready', url: `http://127.0.0.1:${bound}` });
}

/** How many of Vite's own progress lines a failed build keeps, so the lines just before the failure explain it. */
const INFO_KEPT = 60;
/** What a failed build keeps of its warnings and errors: each entry's start, and the last few hundred entries. */
const LOG_ENTRY = 4000;
const LOG_KEPT = 300;
const LOG_ERRORS = 100;

function keep(list: string[], message: string, max = LOG_KEPT) {
  // Masked before it is cut, so a credential cannot be left half-hidden at the cut.
  const text = maskSecrets(message);
  list.push(text.length > LOG_ENTRY ? `${text.slice(0, LOG_ENTRY)}…` : text);
  if (list.length > max) list.shift();
}

/** Let what the build wrote to its own streams leave the process before it reports and exits. */
async function flushOutput() {
  const flush = (stream: NodeJS.WriteStream) =>
    new Promise<void>((done) => {
      try {
        stream.write('', () => done());
      } catch {
        done();
      }
    });
  await Promise.race([Promise.all([flush(process.stdout), flush(process.stderr)]), new Promise((done) => setTimeout(done, 2000))]);
}

async function build(dir: string) {
  const logs: string[] = [];
  // Errors keep their own room, so a flood of warnings cannot push one out.
  const errors: string[] = [];
  // Progress lines are only read when the build fails; a successful build reports warnings and errors alone.
  const info: string[] = [];
  try {
    // Finding the project and loading its Vite are part of the build: a failure there is a build failure.
    const real = useRealProjectDir(dir);
    const vite = await loadVite(real);
    // Multi-environment build, equivalent to the `vite build` command.
    const builder = await vite.createBuilder({
      root: real,
      configFile: join(real, 'vite.config.js'),
      logLevel: 'warn',
      clearScreen: false,
      customLogger: {
        info: (m: string) => keep(info, m, INFO_KEPT),
        warn: (m: string) => keep(logs, m),
        warnOnce: (m: string) => keep(logs, m),
        error: (m: string) => keep(errors, m, LOG_ERRORS),
        clearScreen: () => {},
        hasErrorLogged: () => false,
        hasWarned: false
      }
    } as never);
    await builder.buildApp();
    post({ type: 'built', ok: true, logs: [...logs, ...errors] });
  } catch (e) {
    const failure = serializeBuildError(e);
    await flushOutput();
    post({ type: 'built', ok: false, error: failure.message, failure, logs: [...info, ...logs, ...errors] });
  }
}

port.on('message', async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'start') await start(useRealProjectDir(m.dir), m.port, m.packaged !== false);
    // The editor waits for this, so it never runs ahead of the batch's own update.
    else if (m.type === 'revision') {
      const send = (batch = 0) => server?.ws.send({ type: 'custom', event: 'siteorigin:revision', data: { revision: m.revision, batch } });
      if (gate) gate.revision(send);
      else send();
    }
    // Answered once held, so the editor replaces no file before the watcher's events wait here; and once the pages
    // show the batch before, so it replaces nothing they are still fetching for that one.
    else if (m.type === 'hold') {
      const held = gate;
      if (held) await held.caughtUp(CATCH_UP_MS, () => server?.ws.clients.size ?? 0);
      held?.hold(m.id);
      post({ type: 'held', id: m.id });
    } else if (m.type === 'release') gate?.release(m.id, Array.isArray(m.files) ? m.files : []);
    else if (m.type === 'build') {
      await build(m.dir);
      process.exit(0);
    } else if (m.type === 'stop') {
      gate?.close();
      await server?.close();
      process.exit(0);
    }
  } catch (e) {
    post({ type: 'error', message: (e as Error).stack ?? String(e) });
  }
});

/** An error nothing caught: reported as the serializer read it, since reading it again could throw. */
function reportUncaught(e: unknown) {
  const failure = serializeBuildError(e);
  post({ type: 'error', message: failure.stack ?? failure.message, failure });
}
process.on('uncaughtException', reportUncaught);
process.on('unhandledRejection', reportUncaught);
