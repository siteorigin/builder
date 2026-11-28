/**
 * The preview's editor instrumentation, as a Vite plugin: serves the editor's instrumented variants from
 * .siteorigin/cache/dev in place of the project's own source files, the selection bridge as a virtual module, and
 * isolated component previews (see @shared/component-preview) from the files the editor prepared for each in the
 * same cache. Kept apart from the worker so it can be tested.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { languageDirection } from '@shared/languages';
import { ISOLATED_DIR, PREVIEW_COMPONENT_STYLES, PREVIEW_KEY, PREVIEW_META, PREVIEW_MODULE, PREVIEW_PROJECT_STYLES, previewKeyOf } from '@shared/component-preview';
import bridgeSource from './bridge.client.js?raw';
import { realFileInside } from './policy';
import { isolatedPreviewPath, plainModuleId, projectSrcPath, wholeModuleId } from './paths';
import { keepPageThroughAppTemplate, type TemplateServer } from './app-template';

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

/** The page a component preview is shown on: nothing but the module that mounts it. */
export function previewDocument(key: string, lang: string, dir: 'ltr' | 'rtl' = 'ltr'): string {
  // Marked as running scripts, as a page's app.html marks itself, so a state's hidden content stays hidden.
  return `<!doctype html>
<html lang="${lang}" dir="${dir}" class="so-js">
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
	// A code component that throws shows its note in its place (renderErrorBoundary), a moment after the throw: the
	// preview did not get on the page then, as when the throw reached here.
	await new Promise((resolve) => setTimeout(resolve));
	const failed = document.querySelector('[data-so-render-error]');
	if (failed) preview.error = (failed.getAttribute('data-so-render-error') || 'Something went wrong.').slice(0, 2000);
	else preview.mounted = true;
} catch (e) {
	preview.error = String((e && e.message) || e).slice(0, 2000);
}
window.__siteoriginPreview = preview;
await import('virtual:siteorigin-bridge');
`;
}

/** SvelteKit's generated client app (its hooks among the rest), from the project's folder, as Vite names it. */
const KIT_CLIENT_APP = /^\.svelte-kit\/generated\/(?:(?:dev|build)\/)?client(?:-optimized)?\/app\.js$/;

/**
 * The preview's client hook for errors, added to SvelteKit's generated client app: whatever the site's own hook
 * returns (or SvelteKit's default), an error thrown while the page rendered in the browser also keeps its own
 * message, as `soRenderError`, which SvelteKit otherwise replaces with "Internal Error" before any boundary sees it.
 * A code placement's note shows it and the bridge reports it (#1526). The server's half is the generated server
 * hook's `handleError` (see generateServerHook).
 */
export function withRenderErrors(code: string): string {
  return `${code}
// SiteOrigin Builder's preview: an error thrown while the page rendered keeps its own message for the editor to say.
{
	const own = hooks.handleError;
	const keep = (input, body) => {
		if (input.kind !== 'unknown') return body;
		const e = input.error;
		return { ...(body && typeof body === 'object' ? body : {}), soRenderError: String((e && e.message) || e).slice(0, 2000) };
	};
	hooks.handleError = (input) => {
		const body = own(input);
		return body && typeof body.then === 'function' ? body.then((b) => keep(input, b)) : keep(input, body);
	};
}
`;
}

type Middleware =(req: { url?: string; method?: string }, res: { statusCode: number; setHeader(k: string, v: string): unknown; end(body?: string): unknown }, next: (e?: unknown) => void) => void;
/** What the plugin uses of a Vite module graph: modules by ID, and dropping one's transformed code. */
type ModuleGraph = { idToModuleMap?: Map<string, object>; invalidateModule(mod: object): void };
/** Vite's own resolution, from a plugin's resolveId. */
type Resolve = (id: string, importer?: string, options?: object) => Promise<{ id: string } | null>;
type PreviewServer = {
  middlewares: { use(fn: Middleware): unknown };
  transformIndexHtml(url: string, html: string): Promise<string>;
  environments?: Record<string, { moduleGraph?: ModuleGraph } | undefined>;
  moduleGraph?: ModuleGraph;
};

/**
 * The preview a request of its page's modules belongs to (a file of its folder, or its entry), by key; else null.
 * Read as Vite reads the address (decoded, with repeated slashes and dot segments resolved), so no other spelling of
 * it gets past.
 */
export function previewModuleKey(url: string | undefined, dirs: string[] = []): string | null {
  let path = (url ?? '').split(/[?#]/)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // Vite cannot read it either.
  }
  path = posix.normalize(path.replace(/\\/g, '/'));
  // A file of a preview's folder however it is reached: from the root, or by its whole path wrapped as /@id/ or /@fs/.
  const inner = path.replace(/^\/@(?:id|fs)\/(?:__x00__)?/, '/').replace(/^\/([A-Za-z]:\/)/, '$1');
  const wrapped = inner !== path ? isolatedPreviewPath(dirs, inner, ISOLATED_DIR, PREVIEW_KEY) : null;
  if (wrapped) return wrapped.key;
  const m = /^\/\.siteorigin\/cache\/dev\/isolated\/([^/]+)\//i.exec(path) ?? /^\/@id\/(?:__x00__|\0)?virtual:siteorigin-component-preview\/([^/]+)\.js$/.exec(path);
  return m && PREVIEW_KEY.test(m[1]) ? m[1] : null;
}

/** The language a preview's page is in: the site's, as its editor recorded it beside the preview. */
function previewLanguage(meta: string | null): { lang: string; dir: 'ltr' | 'rtl' } {
  try {
    if (!meta || statSync(meta).size > 4096) return { lang: 'en', dir: 'ltr' };
    const { lang, dir } = JSON.parse(readFileSync(meta, 'utf8')) as { lang?: unknown; dir?: unknown };
    const code = typeof lang === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(lang) ? lang : 'en';
    // Written before previews knew the way the text runs: the language says.
    return { lang: code, dir: dir === 'ltr' || dir === 'rtl' ? dir : languageDirection(code) };
  } catch {
    return { lang: 'en', dir: 'ltr' };
  }
}

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
  /**
   * The real folder of a prepared preview, only while it and every folder between it and the project are real
   * folders: a link anywhere on the way (to elsewhere, or to the editor's other data in the project) serves nothing.
   */
  const previewFolder = (key: string): string | null => {
    if (!PREVIEW_KEY.test(key)) return null;
    try {
      const folder = join(realpathSync.native(dir), '.siteorigin', 'cache', 'dev', ISOLATED_DIR, key);
      return realpathSync.native(join(isolatedRoot, key)) === folder ? folder : null;
    } catch {
      return null;
    }
  };
  /** A file of a prepared preview, only while it is really inside that preview's folder (no link out of it). */
  const previewFile = (key: string, rel: string): string | null => {
    const folder = previewFolder(key);
    if (!folder || rel.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null;
    const file = join(folder, ...rel.split('/'));
    return existsSync(file) && realFileInside(folder, file) ? file : null;
  };
  /** The address the preview server gives a file of a prepared preview: from the project root, as Vite names it. */
  const previewUrl = (key: string) => (rel: string) => '/' + relative(dir, join(isolatedRoot, key, ...rel.split('/'))).split(sep).join('/');
  /** Vite's module IDs use forward slashes on every platform. */
  const viteId = (file: string) => file.split(sep).join('/');
  return {
    name: 'siteorigin-editor-instrumentation',
    enforce: 'pre' as const,
    configureServer(server: PreviewServer) {
      // The site's language and direction live in src/app.html, and the open page takes them in place: no reload for them.
      keepPageThroughAppTemplate(server as unknown as TemplateServer, names.map((name) => join(name, 'src', 'app.html')));
      /**
       * Drop what Vite keeps of the modules of previews that were released (their transformed code, sample values
       * and all), so showing one preview after another does not keep every earlier one in memory.
       */
      const forgetReleased = () => {
        const graphs = Object.values(server.environments ?? {}).flatMap((env) => (env?.moduleGraph ? [env.moduleGraph] : []));
        if (!graphs.length && server.moduleGraph) graphs.push(server.moduleGraph);
        const gone = new Map<string, boolean>();
        const released = (key: string) => gone.get(key) ?? (gone.set(key, !previewFolder(key)), gone.get(key)!);
        for (const graph of graphs) {
          for (const [id, mod] of graph.idToModuleMap ?? []) {
            if (forgotten.has(mod)) continue;
            const key = isolatedPreviewPath(names, id, ISOLATED_DIR, PREVIEW_KEY)?.key ?? previewModuleKey(`/@id/${id.replace(/^\0/, '')}`);
            if (key && released(key)) {
              forgotten.add(mod);
              try {
                graph.invalidateModule(mod);
              } catch {
                // Only memory is at stake.
              }
            }
          }
        }
      };
      /** Modules already dropped: a key is never used again, so they are never looked at twice. */
      const forgotten = new WeakSet<object>();
      // Registered ahead of Vite's own middleware and SvelteKit's pages: the address is never a page of the site.
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        // A module of a released preview is gone, even where Vite still holds what it made of it.
        const moduleKey = previewModuleKey(req.url, names);
        if (moduleKey) {
          if (previewFolder(moduleKey)) return next();
          res.statusCode = 404;
          res.setHeader('Cache-Control', 'no-store');
          res.end();
          return;
        }
        const key = previewKeyOf(req.url);
        if (!key) return next();
        res.setHeader('Cache-Control', 'no-store');
        if (!previewFile(key, PREVIEW_MODULE)) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('This component preview is no longer available.');
          return;
        }
        forgetReleased();
        const { lang, dir } = previewLanguage(previewFile(key, PREVIEW_META));
        server.transformIndexHtml(req.url!, previewDocument(key, lang, dir)).then((html) => {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(req.method === 'HEAD' ? undefined : html);
        }, next);
      });
    },
    async resolveId(this: unknown, id: string, importer?: string, options?: object) {
      if (id === VIRTUAL) return '\0' + VIRTUAL + '.js';
      if (id.startsWith(PREVIEW_ENTRY)) {
        const key = id.slice(PREVIEW_ENTRY.length).replace(/\.js$/, '');
        return PREVIEW_KEY.test(key) ? '\0' + PREVIEW_ENTRY + key + '.js' : null;
      }
      // An import made by a preview's own files (relative, or through $lib, which Vite has made a project path by
      // now): a file the preview has its own copy of comes from that copy, so its pieces fit each other. Anything
      // else (a helper a code component imports) is resolved by Vite as the project's own copy of the importing file
      // would import it, as on a page.
      const from = importer ? isolatedPreviewPath(names, importer, ISOLATED_DIR, PREVIEW_KEY) : null;
      if (!from) return null;
      const q = id.indexOf('?');
      const query = q < 0 ? '' : id.slice(q);
      /** The preview's own copy of a project source path, when it has one. */
      const ownCopy = (rel: string | null) => {
        const own = rel?.startsWith('src/') ? previewFile(from.key, rel) : null;
        return own && statSync(own).isFile() ? viteId(own) : null;
      };
      const path = q < 0 ? id : id.slice(0, q);
      // A file read as text, an address or a worker is checked against what the server may read before any plugin
      // serves it, which the editor's cache never is: those come from the project.
      const fromCopy = !/[?&](?:raw|url|inline|worker|sharedworker)\b/.test(query);
      const exact = fromCopy ? ownCopy(path.startsWith('./') || path.startsWith('../') ? posix.normalize(posix.join(posix.dirname(from.rel), path)) : projectSrcPath(names, path)) : null;
      if (exact) return exact + query;
      const resolve = (this as { resolve?: Resolve } | undefined)?.resolve;
      if (typeof resolve !== 'function') return null;
      // As Vite finds it from where it is imported (a path without its extension, a folder's index): kept when that
      // is a file of this preview, or of the project that the preview has its own copy of.
      const here = fromCopy ? await resolve.call(this, id, importer, { ...options, skipSelf: true }) : null;
      if (here) {
        const found = here.id.split('?')[0];
        const inside = isolatedPreviewPath(names, found, ISOLATED_DIR, PREVIEW_KEY);
        if (inside?.key === from.key) return here;
        const copy = ownCopy(projectSrcPath(names, found));
        if (copy) return copy + query;
        // A package, or anything else that is neither the preview's nor the project's source, is the same from anywhere.
        if (!inside && !projectSrcPath(names, found) && !found.includes('/.siteorigin/')) return here;
      }
      if (!from.rel.startsWith('src/')) return null;
      return resolve.call(this, id, viteId(join(dir, ...from.rel.split('/'))), { ...options, skipSelf: true });
    },
    transform(code: string, id: string) {
      const file = id.split('?')[0];
      // Only the project's own: a file of the same name anywhere else (in src/, or another folder) is left as it is.
      const own = names.some((name) => {
        const root = viteId(name).replace(/\/+$/, '') + '/';
        const inside = process.platform === 'win32' ? file.toLowerCase().startsWith(root.toLowerCase()) : file.startsWith(root);
        return inside && KIT_CLIENT_APP.test(file.slice(root.length));
      });
      if (!own || !/\bexport const hooks\b/.test(code)) return null;
      return { code: withRenderErrors(code), map: null };
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
