/** What the project's preview server may do. Kept apart from the worker so it can be tested. */

/**
 * Only the editor may frame the preview: app://editor in packaged builds, plus the loopback dev server the
 * editor itself is served from in development.
 */
export function frameAncestorsCsp(packaged: boolean): string {
  return packaged ? 'frame-ancestors app://editor' : 'frame-ancestors app://editor http://127.0.0.1:* http://localhost:*';
}

/**
 * What the preview server may serve from disk: the project folder only, never the editor's private data or
 * secrets. Vite's own defaults are repeated because setting `deny` replaces them.
 */
export function previewFsPolicy(dir: string) {
  return { strict: true, allow: [dir], deny: ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '**/.siteorigin/**'] };
}

/**
 * A Vite plugin that sends the frame-ancestors policy with every response, including SvelteKit's rendered pages
 * and static files (Vite's `server.headers` only covers the responses Vite itself writes).
 */
export function framePolicyPlugin(csp: string) {
  return {
    name: 'siteorigin-frame-policy',
    configureServer(server: { middlewares: { use: (fn: (req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => void) => void } }) {
      // Registered directly (not returned), so it runs before SvelteKit's own middleware.
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Content-Security-Policy', csp);
        next();
      });
    }
  };
}
