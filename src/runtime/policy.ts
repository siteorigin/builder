/** What the project's preview server may do. Kept apart from the worker so it can be tested. */
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';

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
 * secrets, nor the project's private brief (#518) and any copy of it an editor left beside it. Vite's own defaults
 * are repeated because setting `deny` replaces them.
 */
export function previewFsPolicy(dir: string) {
  return { strict: true, allow: [dir], deny: ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '**/.siteorigin/**', '**/siteorigin/*brief.json*'] };
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
