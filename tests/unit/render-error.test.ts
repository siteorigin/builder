/**
 * A code component that throws while the page renders (#1526). In the editor's preview its placement shows a note in
 * its place, naming its file and the error, and every other section of the page goes on showing; the preview's error
 * hooks keep the error's own message where SvelteKit would say "Internal Error". The website has none of it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { afterAll, describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { defFile, generateProject, pageFile, SERVER_HOOK_FILE } from '@generator/index';
import { devPlugin, withRenderErrors } from '../../src/runtime/dev-plugin';
import { codeContractNames } from '../../src/main/codecheck';

const BROKEN = `<script>
\tlet { class: className = '', data = undefined } = $props();
</script>

<section class={className}><p>Value: {data.nested.value}</p></section>
`;

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The starter's home page with the issue's component placed second, between sections that render. */
async function broken() {
  let s: ProjectState = createStarterState('business', 'Render Errors', false);
  const owner = { kind: 'page' as const, id: s.site.homePageId };
  const names = (await codeContractNames(BROKEN))!;
  const made = applyOperations(s, [{ type: 'component.createCode', name: 'Nested value', source: BROKEN, properties: {} } as EditOperation], { codeNames: () => names });
  const defId = made.results[0].definitionId as string;
  s = made.state;
  const placed = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, index: 1, definitionId: defId } as EditOperation]);
  return { s: placed.state, defId, nodeId: placed.results[0].nodeId as string };
}

/** Write the generated site's modules, compiled for the server, with SvelteKit's own modules stood in for. */
async function serverSite(s: ProjectState, instrument: boolean) {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'render-error-'));
  roots.push(dir);
  const stub = (name: string, code: string) => {
    const file = join(dir, name);
    writeFileSync(file, code);
    return JSON.stringify(file);
  };
  const paths = stub('app-paths.js', 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";\n');
  const navigation = stub('app-navigation.js', 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};\n');
  const env = stub('app-env.js', 'export const building = false;\n');
  const files = generateProject(s, { instrument });
  for (const [path, source] of files) {
    if (!path.startsWith('src/') || !/\.(svelte|js)$/.test(path)) continue;
    const out = join(dir, path.endsWith('.svelte') ? `${path}.js` : path);
    mkdirSync(dirname(out), { recursive: true });
    const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true, css: 'external' }).js.code : source;
    writeFileSync(
      out,
      code
        .replace(/(\bfrom\s*|\bimport\s*\(\s*)(["'])([^"'\n]+?\.svelte)\2/g, '$1$2$3.js$2')
        .replace(/(["'])\$app\/paths\1/g, paths)
        .replace(/(["'])\$app\/navigation\1/g, navigation)
        .replace(/(["'])\$app\/env\1/g, env)
        .replace(/^\s*import\s+['"][^'"]+\.css['"];?\s*$/gm, '')
    );
  }
  const load = async <T>(path: string) => (await import(/* @vite-ignore */ join(dir, path))) as T;
  return { files, load };
}

/** SvelteKit's server render: an error is passed to the site's handleError, merged over its own "Internal Error". */
function kitTransform(hooks: { handleError?: (input: { error: unknown; kind: string }) => object | undefined }) {
  return (error: unknown) => ({ status: 500, message: 'Internal Error', ...hooks.handleError?.({ error, kind: 'unknown' }) });
}

describe('a code component that throws while the page renders', () => {
  it('shows a note in its place in the preview, naming its file and the error, and the rest of the page goes on', async () => {
    const { s, defId, nodeId } = await broken();
    const site = await serverSite(s, true);
    const hooks = await site.load<{ handleError?: (input: { error: unknown; kind: string }) => object | undefined }>(SERVER_HOOK_FILE);
    const Page = (await site.load<{ default: Component<Record<string, unknown>> }>(`${pageFile(s.pages[s.site.homePageId])}.js`)).default;
    const { body } = render(Page, { props: {}, transformError: kitTransform(hooks) });
    const note = /<div data-so-render-error="([^"]*)" data-so-error-file="([^"]*)" data-so-editor-only[^>]*>([\s\S]*?)<\/div>/.exec(body);
    expect(note, body).not.toBeNull();
    expect(note![1]).toBe("Cannot read properties of undefined (reading 'nested')");
    expect(note![2]).toBe(defFile(s.components[defId]));
    expect(note![3]).toContain('Nested value couldn’t be shown');
    // Inside the placement's own wrapper, so a pick of the note is a pick of the placement.
    expect(body.slice(0, note!.index).lastIndexOf(`data-so-node="${nodeId}"`)).toBeGreaterThan(-1);
    // Every other section of the page is there, before and after it.
    const page = s.pages[s.site.homePageId];
    const others = page.rootIds.filter((id) => id !== nodeId);
    expect(others.length).toBeGreaterThan(1);
    for (const id of others) expect(body, `section ${id}`).toContain(`data-so-node="${id}"`);
    expect((page.nodes[others[0]] as InstanceNode).definitionId).not.toBe(defId);
  });

  it('keeps the message the server hook gives the preview, and the site’s own for any other kind of error', async () => {
    const { s } = await broken();
    const hooks = await (await serverSite(s, true)).load<{ handleError: (input: { error: unknown; kind: string }) => object | undefined }>(SERVER_HOOK_FILE);
    expect(hooks.handleError({ error: new Error('Nope'), kind: 'unknown' })).toEqual({ soRenderError: 'Nope' });
    expect(hooks.handleError({ error: 'thrown text', kind: 'unknown' })).toEqual({ soRenderError: 'thrown text' });
    expect(hooks.handleError({ error: { status: 404, message: 'Not Found' }, kind: 'framework' })).toBeUndefined();
  });

  it('leaves the website as it was: no note, no boundary, no error hook', async () => {
    const { s } = await broken();
    const files = generateProject(s, { instrument: false });
    const page = files.get(pageFile(s.pages[s.site.homePageId]))!;
    expect(page).not.toContain('svelte:boundary');
    expect(page).not.toContain('data-so-render-error');
    expect(files.get(SERVER_HOOK_FILE)).not.toContain('handleError');
    for (const [path, source] of files) expect(source, path).not.toContain('soRenderError');
    // The website still fails to build on it, as it should: nothing catches the throw there.
    const site = await serverSite(s, false);
    const Page = (await site.load<{ default: Component<Record<string, unknown>> }>(`${pageFile(s.pages[s.site.homePageId])}.js`)).default;
    expect(() => render(Page, { props: {} }).body).toThrow(/nested/);
  });
});

describe('the preview’s client error hook', () => {
  /** SvelteKit's generated client app, as far as its hooks, with the site's own handleError or none. */
  const app = (own: string | null) => `export const hooks = {
	handleError: ${own ? `(${own}) || ` : ''}(({ kind, error }) => { if (kind === 'unknown') { console.debug(error); } }),
	reroute: (() => {})
};
`;
  const load = async (code: string) => (await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(code)}`)) as { hooks: { handleError: (input: object) => unknown } };

  it('keeps an error’s own message beside what the site’s hook or SvelteKit returns', async () => {
    const { hooks } = await load(withRenderErrors(app(null)));
    expect(await hooks.handleError({ kind: 'unknown', error: new TypeError('Cannot read nested') })).toEqual({ soRenderError: 'Cannot read nested' });
    expect(await hooks.handleError({ kind: 'framework', error: { status: 404, message: 'Not Found' } })).toBeUndefined();
    const mine = await load(withRenderErrors(app(`async ({ error }) => ({ message: 'Ours', code: 7 })`)));
    expect(await mine.hooks.handleError({ kind: 'unknown', error: new Error('Broken') })).toEqual({ message: 'Ours', code: 7, soRenderError: 'Broken' });
  });

  it('is added only to SvelteKit’s generated client app of the project being previewed', () => {
    const dir = resolve('.tmp', 'render-error-project');
    const plugin = devPlugin(dir);
    const id = (rel: string) => join(dir, rel).split('\\').join('/');
    const code = app(null);
    expect(plugin.transform(code, id('.svelte-kit/generated/dev/client/app.js'))?.code).toBe(withRenderErrors(code));
    expect(plugin.transform(code, `${id('.svelte-kit/generated/client/app.js')}?v=1`)?.code).toBe(withRenderErrors(code));
    expect(plugin.transform(code, id('src/lib/app.js'))).toBeNull();
    expect(plugin.transform(code, '/elsewhere/.svelte-kit/generated/dev/client/app.js')).toBeNull();
    expect(plugin.transform('export const nodes = [];', id('.svelte-kit/generated/dev/client/app.js'))).toBeNull();
  });
});
