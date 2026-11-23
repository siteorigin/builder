/**
 * Project runtime worker (Electron utility process).
 * Runs the project's own Vite/SvelteKit toolchain: dev server for preview and production builds.
 * Its environment is constructed explicitly by the main process and never contains provider credentials.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import bridgeSource from './bridge.client.js?raw';
import { frameAncestorsCsp, framePolicyPlugin, previewFsPolicy } from './policy';
import { projectSrcPath } from './paths';

type Msg =
  | { type: 'start'; dir: string; port?: number; packaged?: boolean }
  | { type: 'revision'; revision: number }
  | { type: 'build'; dir: string }
  | { type: 'stop' };

const port = (process as unknown as { parentPort: { on: (e: string, cb: (ev: { data: Msg }) => void) => void; postMessage: (m: unknown) => void } }).parentPort;
const post = (m: unknown) => port.postMessage(m);

let server: { close: () => Promise<void>; ws: { send: (p: unknown) => void }; httpServer: unknown } | null = null;

async function loadVite(dir: string) {
  const req = createRequire(join(dir, 'package.json'));
  const entry = req.resolve('vite');
  return (await import(pathToFileURL(entry).href)) as typeof import('vite');
}

/**
 * Hashes of the project files the dev variants stand in for, written by the editor next to the variants
 * (before the project files themselves), re-read when they change.
 */
let manifest: { mtimeMs: number; files: Record<string, string> } | null = null;
function generatedHashes(dir: string): Record<string, string> {
  const file = join(dir, '.siteorigin', 'cache', 'dev', '.clean-hashes.json');
  try {
    const mtimeMs = statSync(file).mtimeMs;
    if (manifest?.mtimeMs !== mtimeMs) manifest = { mtimeMs, files: JSON.parse(readFileSync(file, 'utf8')) ?? {} };
    return manifest.files;
  } catch {
    return {};
  }
}

/** Does the project file differ from what the editor generated for it? */
function editedOutside(dir: string, rel: string): boolean {
  const expected = generatedHashes(dir)[rel];
  if (!expected) return false;
  try {
    return createHash('sha256').update(readFileSync(join(dir, ...rel.split('/')))).digest('hex') !== expected;
  } catch {
    return false;
  }
}

function devPlugin(dir: string) {
  const devRoot = join(dir, '.siteorigin', 'cache', 'dev');
  const VIRTUAL = 'virtual:siteorigin-bridge';
  // Vite names modules by real path, so a project opened through a link is matched by both names.
  const names = [dir];
  try {
    const real = realpathSync.native(dir);
    if (real !== dir) names.push(real);
  } catch {
    // The folder is checked again when Vite starts; keep the name it was opened by.
  }
  return {
    name: 'siteorigin-editor-instrumentation',
    enforce: 'pre' as const,
    resolveId(id: string) {
      if (id === VIRTUAL) return '\0' + VIRTUAL + '.js';
      return null;
    },
    load(id: string) {
      if (id === '\0' + VIRTUAL + '.js') return bridgeSource;
      const rel = projectSrcPath(names, id);
      if (!rel) return null;
      const variant = join(devRoot, ...rel.split('/'));
      if (!existsSync(variant)) return null;
      // A generated file edited outside the app is shown as edited, not as the editor's instrumented copy.
      if (editedOutside(dir, rel)) return null;
      return readFileSync(variant, 'utf8');
    }
  };
}

async function start(dir: string, wantedPort = 0, packaged = true) {
  const vite = await loadVite(dir);
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
      watch: {
        // Anchored to the project root: src/lib/siteorigin must stay watched.
        // Build configuration is not watched: a changed config must go through the editor's trust check, not an automatic restart.
        ignored: (p: string) =>
          ['.siteorigin', 'siteorigin', 'build', 'node_modules', '.svelte-kit/output'].some((d) => p === join(dir, d) || p.startsWith(join(dir, d) + sep)) ||
          ['vite.config.js', 'vite.config.ts', 'svelte.config.js', 'package.json', 'package-lock.json'].some((f) => p === join(dir, f))
      },
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
  await s.listen();
  server = s as never;
  const addr = (s.httpServer as { address(): { port: number } | string | null } | null)?.address();
  const bound = addr && typeof addr === 'object' ? addr.port : wantedPort;
  post({ type: 'ready', url: `http://127.0.0.1:${bound}` });
}

async function build(dir: string) {
  const vite = await loadVite(dir);
  const logs: string[] = [];
  try {
    // Multi-environment build, equivalent to the `vite build` command.
    const builder = await vite.createBuilder({
      root: dir,
      configFile: join(dir, 'vite.config.js'),
      logLevel: 'warn',
      clearScreen: false,
      customLogger: {
        info: () => {},
        warn: (m: string) => logs.push(m),
        warnOnce: (m: string) => logs.push(m),
        error: (m: string) => logs.push(m),
        clearScreen: () => {},
        hasErrorLogged: () => false,
        hasWarned: false
      }
    } as never);
    await builder.buildApp();
    post({ type: 'built', ok: true, logs });
  } catch (e) {
    post({ type: 'built', ok: false, error: (e as Error).message, logs });
  }
}

port.on('message', async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'start') await start(m.dir, m.port, m.packaged !== false);
    else if (m.type === 'revision') server?.ws.send({ type: 'custom', event: 'siteorigin:revision', data: { revision: m.revision } });
    else if (m.type === 'build') {
      await build(m.dir);
      process.exit(0);
    } else if (m.type === 'stop') {
      await server?.close();
      process.exit(0);
    }
  } catch (e) {
    post({ type: 'error', message: (e as Error).stack ?? String(e) });
  }
});

process.on('uncaughtException', (e) => post({ type: 'error', message: e.stack ?? String(e) }));
process.on('unhandledRejection', (e) => post({ type: 'error', message: String((e as Error)?.stack ?? e) }));
