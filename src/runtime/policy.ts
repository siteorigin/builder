/** What the project's preview server may do. Kept apart from the worker so it can be tested. */
import { realpathSync } from 'node:fs';
import { isPreviewTarget } from '@shared/live/preview';
import { sep } from 'node:path';

/** Folders of the project the dev server does not watch, and the build configuration files it does not either. */
const UNWATCHED_DIRS = ['.siteorigin', 'siteorigin', 'build', 'node_modules', '.svelte-kit/output'];
const UNWATCHED_FILES = ['vite.config.js', 'vite.config.ts', 'svelte.config.js', 'package.json', 'package-lock.json'];

/**
 * What the dev server does not watch, anchored to the project root (src/lib/siteorigin must stay watched). Build
 * configuration is not watched: a changed config must go through the editor's trust check, not an automatic restart.
 *
 * Vite's watcher asks with forward slashes on every platform (`C:/Users/…` on Windows) and the publication gate with
 * the platform's own separators, so on Windows both spellings, and any case, name the same file. Anything else would
 * leave all of these watched there: the editor's own data, the build configuration, and the folder a component
 * preview is prepared in, which a watched folder's open handle keeps from being renamed into place.
 */
export function unwatched(dir: string, platform: NodeJS.Platform = process.platform): (path: string) => boolean {
  const windows = platform === 'win32';
  const norm = (p: string) => {
    const s = (windows ? p.replace(/\\/g, '/') : p).replace(/\/+$/, '');
    return windows ? s.toLowerCase() : s;
  };
  const root = norm(dir);
  const dirs = UNWATCHED_DIRS.map((d) => norm(`${root}/${d}`));
  const files = new Set(UNWATCHED_FILES.map((f) => norm(`${root}/${f}`)));
  return (path: string) => {
    const p = norm(path);
    return files.has(p) || dirs.some((d) => p === d || p.startsWith(`${d}/`));
  };
}

/** A folder's real path, with every link resolved; the path as given when it does not exist yet. */
export function canonicalDir(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/**
 * Is `file` really inside `root`, after resolving links? A link planted in the editor's cache must never make
 * the preview serve a file from elsewhere on the computer.
 */
export function realFileInside(root: string, file: string): boolean {
  try {
    const r = realpathSync.native(root);
    const f = realpathSync.native(file);
    return f !== r && f.startsWith(r.endsWith(sep) ? r : r + sep);
  } catch {
    return false;
  }
}

/**
 * Only the editor may frame the preview: app://editor in packaged builds, plus the loopback dev server the
 * editor itself is served from in development.
 */
export function frameAncestorsCsp(packaged: boolean): string {
  return packaged ? 'frame-ancestors app://editor' : 'frame-ancestors app://editor http://127.0.0.1:* http://localhost:*';
}

/**
 * What the preview server may serve from disk: the project folder only, never the editor's private data or
 * secrets, nor the project's private brief (#518) and any copy of it an editor left beside it, nor its external
 * sources' settings and any copy of a credential file (#676). Vite's own defaults
 * are repeated because setting `deny` replaces them.
 */
/**
 * The header the host's live session tunnel marks every guest's preview request with (src/main/live/preview-proxy.ts).
 * A guest is shown the site and nothing more: the project's own dev-server proxy rules, which pass requests on to other
 * servers, never apply to one of its requests.
 */
export const LIVE_GUEST_HEADER = 'x-siteorigin-live-guest';

type GuestReq = { headers: Record<string, string | string[] | undefined>; url?: string };
type GuestRes = { statusCode: number; writableEnded?: boolean; setHeader(name: string, value: string): unknown; end(body?: string): unknown };
type Bypass = (this: unknown, req: GuestReq, res: GuestRes | undefined, options: unknown) => unknown;
type ProxyServer = { on(event: 'proxyReq', fn: (proxyReq: { destroy(error?: Error): void }, req: GuestReq) => void): unknown };
type ProxyRule = { bypass?: Bypass; configure?: (this: unknown, proxy: ProxyServer, options: ProxyRule) => void; [option: string]: unknown };

const isGuest = (req: GuestReq) => req.headers[LIVE_GUEST_HEADER] !== undefined;

/**
 * A Vite plugin that shows a live session guest the project's site and nothing more, wherever another plugin or the
 * project's own configuration would take its request:
 * - A guest's request whose address, as the other plugins' middleware leaves it, is no longer a place in the preview
 *   (one of the dev server's own routes, such as `__open-in-editor`, that something rewrote it to) is not found. The
 *   plugin runs last, so it sees the address as Vite's own middleware will.
 * - The project's `server.proxy` rules never send a guest's request on to another server. Each rule's `bypass` is
 *   wrapped where Vite decides to forward: a local answer the project's own bypass gives stands (one it sent itself,
 *   or a local address that is a place in the preview), and anything else is not found. A rule's own `configure` that
 *   sets another bypass has it wrapped too, and whatever the options end up saying, a guest's request about to be
 *   sent on is stopped before anything of it leaves. Vite reads the rules to install its proxy only after every
 *   plugin's configureServer has run.
 */
export function liveGuestPlugin() {
  const guarded = new WeakSet<Bypass>();
  const guard = (own: Bypass | undefined): Bypass => {
    const bypass: Bypass = async function (this: unknown, req, res, options) {
      const local = own ? await own.call(this, req, res, options) : undefined;
      if (!isGuest(req)) return local;
      // Answered by the project's own code: a local address tells Vite it has been served, so it forwards nothing.
      if (res?.writableEnded) return typeof local === 'string' ? local : (req.url ?? '/');
      if (typeof local === 'string' && isPreviewTarget(local)) return local;
      return false;
    };
    guarded.add(bypass);
    return bypass;
  };
  return {
    name: 'siteorigin-live-guest',
    enforce: 'post' as const,
    configureServer(server: { config: { server: { proxy?: Record<string, string | ProxyRule | null | undefined> } }; middlewares: { use: (fn: (req: GuestReq, res: GuestRes, next: () => void) => void) => unknown } }) {
      server.middlewares.use((req, res, next) => {
        if (!isGuest(req) || isPreviewTarget(req.url ?? '')) return next();
        res.statusCode = 404;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('Not found.');
      });
      const rules = server.config.server.proxy;
      if (!rules) return;
      for (const [context, rule] of Object.entries(rules)) {
        if (!rule) continue;
        // A rule given as a target is read by Vite as this.
        const options: ProxyRule = typeof rule === 'string' ? { target: rule, changeOrigin: true } : rule;
        const configure = options.configure;
        rules[context] = {
          ...options,
          bypass: guard(options.bypass),
          configure(this: unknown, proxy: ProxyServer, opts: ProxyRule) {
            configure?.call(this, proxy, opts);
            if (!opts.bypass || !guarded.has(opts.bypass)) opts.bypass = guard(opts.bypass);
            proxy.on('proxyReq', (proxyReq, req) => {
              if (isGuest(req)) proxyReq.destroy(new Error('A live session guest’s request is never sent on.'));
            });
          }
        };
      }
    }
  };
}

export function previewFsPolicy(dir: string) {
  return { strict: true, allow: [dir], deny: ['.env', '.env.*', '.dev.vars', '.dev.vars.*', '**/.wrangler/**', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '**/.siteorigin/**', '**/siteorigin/brief.json*', '**/siteorigin/.brief.json*', '**/siteorigin/#brief.json#', '**/siteorigin/sources/**', '**/*source-secrets.json*', '**/*api-keys.json*', '**/*remote-credentials.json*'] };
}

type HeaderValue = string | number | readonly string[];
type Res = { setHeader(k: string, v: HeaderValue): unknown; removeHeader(k: string): void };

/**
 * Give a response the frame policy, and keep it when the project sets a policy of its own: that one is sent
 * alongside, never instead, and browsers enforce every policy a response carries.
 */
export function enforceFramePolicy(res: Res, csp: string) {
  const set = res.setHeader;
  const remove = res.removeHeader;
  const isPolicy = (name: string) => String(name).toLowerCase() === 'content-security-policy';
  set.call(res, 'Content-Security-Policy', csp);
  res.setHeader = function (this: Res, name: string, value: HeaderValue) {
    if (!isPolicy(name)) return set.call(this, name, value);
    const theirs = (Array.isArray(value) ? value : [value]).map(String).filter((v) => v !== csp);
    return set.call(this, name, [csp, ...theirs]);
  };
  // Removing the project's policy leaves the frame policy in place.
  res.removeHeader = function (this: Res, name: string) {
    if (isPolicy(name)) set.call(this, 'Content-Security-Policy', csp);
    else remove.call(this, name);
  };
}

/**
 * A Vite plugin that sends the frame-ancestors policy with every response: SvelteKit's rendered pages, the
 * project's static files and Vite's own. It is set on the HTTP server itself, before any middleware runs:
 * SvelteKit serves `static/` from a middleware registered ahead of every other plugin's that never passes the
 * request on, and Vite's `server.headers` only covers the responses Vite itself writes.
 */
export function framePolicyPlugin(csp: string) {
  return {
    name: 'siteorigin-frame-policy',
    configureServer(server: {
      httpServer: { prependListener(event: 'request', fn: (req: unknown, res: Res) => void): unknown } | null;
      middlewares: { use: (fn: (req: unknown, res: Res, next: () => void) => void) => void };
    }) {
      if (server.httpServer) server.httpServer.prependListener('request', (_req, res) => enforceFramePolicy(res, csp));
      // Middleware mode has no server of its own; the earliest middleware is the closest.
      else
        server.middlewares.use((_req, res, next) => {
          enforceFramePolicy(res, csp);
          next();
        });
    }
  };
}
