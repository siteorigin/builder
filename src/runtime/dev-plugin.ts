/**
 * The preview's editor instrumentation, as a Vite plugin: serves the editor's instrumented variants from
 * .siteorigin/cache/dev in place of the project's own source files, the selection bridge as a virtual module, and
 * isolated component previews (see @shared/component-preview) from the files the editor prepared for each in the
 * same cache. Kept apart from the worker so it can be tested.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ISOLATED_DIR, PREVIEW_COMPONENT_STYLES, PREVIEW_KEY, PREVIEW_MODULE, PREVIEW_PROJECT_STYLES, previewKeyOf } from '@shared/component-preview';
import bridgeSource from './bridge.client.js?raw';
import { realFileInside } from './policy';
import { isolatedPreviewPath, plainModuleId, projectSrcPath, wholeModuleId } from './paths';

/**
 * Hashes of the project files the dev variants stand in for, written by the editor next to the variants
 * (before the project files themselves), re-read when they change.
 */
let manifest: { mtimeMs: number; files: Record<string, string> } | null = null;
function generatedHashes(dir: string): Record<string, string> {
  const file = join(dir, '.siteorigin', 'cache', 'dev', '.clean-hashes.json');
  try {
    const cache = join(dir, '.siteorigin', 'cache', 'dev');
    if (!realFileInside(cache, file) || !realFileInside(dir, file)) return {};
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

/** The virtual module that starts a component preview, followed by its key and ".js". */
const PREVIEW_ENTRY = 'virtual:siteorigin-component-preview/';

/** The language the site's pages are in, from its app.html, so a preview wraps and hyphenates text as they do. */
function siteLanguage(dir: string): string {
  try {
    const lang = /<html[^>]*\slang="([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)"/.exec(readFileSync(join(dir, 'src', 'app.html'), 'utf8'))?.[1];
    return lang ?? 'en';
  } catch {
    return 'en';
  }
}

/** The page a component preview is shown on: nothing but the module that mounts it. */
export function previewDocument(key: string, lang: string): string {
  return `<!doctype html>
<html lang="${lang}">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<meta name="robots" content="noindex" />
		<title>Component preview</title>
	</head>
	<body>
		<script type="module" src="/@id/${PREVIEW_ENTRY}${key}.js"></script>
	</body>
</html>
`;
}

/**
 * The module that starts a component preview: the site's tokens and base styles and the preview's component styles,
 * then the preview mounted on its own, then the bridge, which reports ready only once the component is on the page
 * (or failed to get there, with the reason). Form sends are held from the start, as on a page (issue #193).
 */
export function previewEntry(key: string, url: (rel: string) => string): string {
  const styles = [...PREVIEW_PROJECT_STYLES.map((rel) => `/${rel}`), url(PREVIEW_COMPONENT_STYLES)];
  return `// SiteOrigin Builder's isolated component preview. Editor-only: never part of the website.
${styles.map((s) => `import ${JSON.stringify(s)};`).join('\n')}
import { flushSync, mount } from 'svelte';

if (!window.__siteoriginBridge && !window.__siteoriginHold) {
	window.__siteoriginHold = (e) => (e.preventDefault(), e.stopImmediatePropagation());
	document.addEventListener('submit', window.__siteoriginHold, true);
}
const preview = { key: ${JSON.stringify(key)}, mounted: false };
try {
	const { default: Preview } = await import(${JSON.stringify(url(PREVIEW_MODULE))});
	mount(Preview, { target: document.body });
	flushSync();
	preview.mounted = true;
} catch (e) {
	preview.error = String((e && e.message) || e).slice(0, 2000);
}
window.__siteoriginPreview = preview;
await import('virtual:siteorigin-bridge');
`;
}

type Middleware = (req: { url?: string; method?: string }, res: { statusCode: number; setHeader(k: string, v: string): unknown; end(body?: string): unknown }, next: (e?: unknown) => void) => void;

export function devPlugin(dir: string) {
  const devRoot = join(dir, '.siteorigin', 'cache', 'dev');
  const isolatedRoot = join(devRoot, ISOLATED_DIR);
  const VIRTUAL = 'virtual:siteorigin-bridge';
  // Vite names modules by real path, so a project opened through a link is matched by both names.
  const names = [dir];
  try {
    const real = realpathSync.native(dir);
    if (real !== dir) names.push(real);
  } catch {
    // The folder is checked again when Vite starts; keep the name it was opened by.
  }
  /** A file of a prepared preview, only while it is really inside that preview's folder (no link out of it). */
  const previewFile = (key: string, rel: string): string | null => {
    const folder = join(isolatedRoot, key);
    const file = join(folder, ...rel.split('/'));
    return existsSync(file) && realFileInside(folder, file) && realFileInside(dir, file) ? file : null;
  };
  /** The address the preview server gives a file of a prepared preview: from the project root, as Vite names it. */
  const previewUrl = (key: string) => (rel: string) => '/' + relative(dir, join(isolatedRoot, key, ...rel.split('/'))).split(sep).join('/');
  return {
    name: 'siteorigin-editor-instrumentation',
    enforce: 'pre' as const,
    configureServer(server: { middlewares: { use(fn: Middleware): unknown }; transformIndexHtml(url: string, html: string): Promise<string> }) {
      // Registered ahead of Vite's own middleware and SvelteKit's pages: the address is never a page of the site.
      server.middlewares.use((req, res, next) => {
        const key = previewKeyOf(req.url);
        if (!key || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
        res.setHeader('Cache-Control', 'no-store');
        if (!previewFile(key, PREVIEW_MODULE)) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('This component preview is no longer available.');
          return;
        }
        server.transformIndexHtml(req.url!, previewDocument(key, siteLanguage(dir))).then((html) => {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(req.method === 'HEAD' ? undefined : html);
        }, next);
      });
    },
    resolveId(id: string) {
      if (id === VIRTUAL) return '\0' + VIRTUAL + '.js';
      if (id.startsWith(PREVIEW_ENTRY)) {
        const key = id.slice(PREVIEW_ENTRY.length).replace(/\.js$/, '');
        return PREVIEW_KEY.test(key) ? '\0' + PREVIEW_ENTRY + key + '.js' : null;
      }
      return null;
    },
    load(id: string) {
      if (id === '\0' + VIRTUAL + '.js') return bridgeSource;
      if (id.startsWith('\0' + PREVIEW_ENTRY)) {
        const key = id.slice(PREVIEW_ENTRY.length + 1).replace(/\.js$/, '');
        return PREVIEW_KEY.test(key) ? previewEntry(key, previewUrl(key)) : null;
      }
      // A file of a prepared preview, which the preview server would otherwise never read from the editor's cache.
      // Its files never change under the same name, so a reload stamp still names the same file; anything derived
      // from one (a component's stylesheet) goes to the plugin that serves it.
      const isolated = isolatedPreviewPath(names, id, ISOLATED_DIR, PREVIEW_KEY);
      if (isolated) {
        if (!plainModuleId(id)) return null;
        const file = previewFile(isolated.key, isolated.rel);
        if (!file) throw new Error('This component preview is no longer available.');
        return readFileSync(file, 'utf8');
      }
      // Only the module itself is replaced. A request for something derived from the file (a component's stylesheet
      // above all) goes to the plugin that serves it: handed the variant, the whole component source became the
      // stylesheet, and SvelteKit's server-rendered page parsed it as markup.
      if (!wholeModuleId(id)) return null;
      const rel = projectSrcPath(names, id);
      if (!rel) return null;
      const variant = join(devRoot, ...rel.split('/'));
      if (!existsSync(variant)) return null;
      // Only a file really inside the cache (no link out of it) is ever served in place of the project's.
      if (!realFileInside(devRoot, variant) || !realFileInside(dir, variant)) return null;
      // A generated file edited outside the app is shown as edited, not as the editor's instrumented copy.
      if (editedOutside(dir, rel)) return null;
      return readFileSync(variant, 'utf8');
    }
  };
}
