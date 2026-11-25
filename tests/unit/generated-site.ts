/**
 * A generated site in a real browser, for the tests that drive one (ui-state-browser, overlay-browser): the exported
 * Home page rendered on the server as the static site ships it, and the site and the editor's variant of it bundled
 * for the browser, each mounted by `window.startSite(variant)` (and taken down by `window.stopSite()`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { build, type Rolldown } from 'vite';

const GEN = '\0gen:';
const roots: string[] = [];
/** Removes what the server renders wrote under .tmp; call it once the tests are done. */
export function removeRendered() {
  roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
}

/** The exported Home page rendered on the server, hydration markers and all, as the static site ships it. */
export async function serverHtml(files: Map<string, string>, prefix = 'generated-site-'): Promise<string> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), prefix));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";\n');
  const navigation = join(dir, 'app-navigation.js');
  writeFileSync(navigation, 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};\n');
  for (const [path, source] of files) {
    if (!path.startsWith('src/') || !/\.(svelte|js)$/.test(path)) continue;
    const out = join(dir, path.endsWith('.svelte') ? `${path}.js` : path);
    mkdirSync(dirname(out), { recursive: true });
    const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true }).js.code : source;
    writeFileSync(
      out,
      code
        .replace(/(["'])([^"'\n]+?\.svelte)\1/g, '$1$2.js$1')
        .replace(/(["'])\$app\/paths\1/g, JSON.stringify(paths))
        .replace(/(["'])\$app\/navigation\1/g, JSON.stringify(navigation))
    );
  }
  const Page = (await import(/* @vite-ignore */ join(dir, 'src/routes/+page.svelte.js'))).default as Component<Record<string, unknown>>;
  return render(Page, { props: {} }).body;
}

/** SvelteKit's navigation hooks in a page that never navigates: they are never called. */
const NO_NAVIGATION = 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};';

/**
 * The site's page and the editor's variant of it, compiled for the browser into one script. `navigation` is the
 * module standing in for `$app/navigation`.
 */
export async function bundle(clean: Map<string, string>, dev: Map<string, string>, navigation = NO_NAVIGATION): Promise<string> {
  const files = new Map<string, string>([
    ...[...clean].map(([p, src]) => [`clean/${p}`, src] as [string, string]),
    ...[...dev].map(([p, src]) => [`dev/${p}`, src] as [string, string]),
    ['app/paths.js', 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";'],
    ['app/navigation.js', navigation]
  ]);
  const entry = [
    "import { hydrate, mount, unmount } from 'svelte';",
    `import Clean from ${JSON.stringify(GEN + 'clean/src/routes/+page.svelte')};`,
    `import Dev from ${JSON.stringify(GEN + 'dev/src/routes/+page.svelte')};`,
    'let site;',
    "window.startSite = (variant) => (site = variant === 'dev' ? mount(Dev, { target: document.getElementById('app'), props: {} }) : hydrate(Clean, { target: document.getElementById('app'), props: {} }));",
    // Taken down and started again, the site renders every element afresh, as a hot update renders a changed file.
    'window.stopSite = () => unmount(site);'
  ].join('\n');
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'generated-site',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === '\0entry' || id.startsWith(GEN)) return id;
          if (id === '$app/paths' || id === '$app/navigation') return GEN + id.slice(1) + '.js';
          if (importer?.startsWith(GEN) && id.startsWith('.')) {
            const path = posix.join(posix.dirname(importer.slice(GEN.length)), id);
            if (files.has(path)) return GEN + path;
          }
          return null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (!id.startsWith(GEN)) return null;
          const path = id.slice(GEN.length);
          const source = files.get(path);
          if (source === undefined) throw new Error(`Not generated: ${path}`);
          const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'client', runes: true }).js.code : source;
          return { code, moduleType: 'js' };
        }
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'esm', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The site did not bundle');
  return chunk.code;
}
