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
import { LIVE_GUEST_HEADER } from '../../src/runtime/policy';

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
  // Placed again at the end: each placement's note is a snippet of its own in the page's file.
  const end = placed.state.pages[s.site.homePageId].rootIds.length;
  const again = applyOperations(placed.state, [{ type: 'node.insert', owner, parentId: null, index: end, definitionId: defId } as EditOperation]);
  return { s: again.state, defId, nodeId: placed.results[0].nodeId as string, againId: again.results[0].nodeId as string };
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
    const { s, defId, nodeId, againId } = await broken();
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
    expect(body.match(/data-so-render-error=/g)).toHaveLength(2);
    expect(body.slice(body.indexOf(`data-so-node="${againId}"`))).toMatch(/^[^>]*>\s*(?:<!--[\s\S]*?-->\s*)*<div data-so-render-error=/);
    // Every other section of the page is there, before and after it.
    const page = s.pages[s.site.homePageId];
    const others = page.rootIds.filter((id) => id !== nodeId && id !== againId);
    expect(others.length).toBeGreaterThan(1);
    for (const id of others) expect(body, `section ${id}`).toContain(`data-so-node="${id}"`);
    expect((page.nodes[others[0]] as InstanceNode).definitionId).not.toBe(defId);
  });

  it('keeps the message the server hook gives the preview, and defers any other kind of error to SvelteKit', async () => {
    const { s } = await broken();
    const hooks = await (await serverSite(s, true)).load<{ handleError: (input: { error: unknown; kind: string; event?: object }) => object | undefined }>(SERVER_HOOK_FILE);
    const host = { request: new Request('http://127.0.0.1/') };
    expect(hooks.handleError({ error: new Error('Nope'), kind: 'unknown', event: host })).toEqual({ soRenderError: 'Nope' });
    expect(hooks.handleError({ error: 'thrown text', kind: 'unknown' })).toEqual({ soRenderError: 'thrown text' });
    expect(hooks.handleError({ error: new Error('x'.repeat(3000)), kind: 'unknown' })).toEqual({ soRenderError: 'x'.repeat(2000) });
    expect(hooks.handleError({ error: { status: 404, message: 'Not Found' }, kind: 'framework', event: host })).toBeUndefined();
    // A live session's guest is shown SvelteKit's own words, never what went wrong on the host's machine.
    const guest = { request: new Request('http://127.0.0.1/', { headers: { [LIVE_GUEST_HEADER]: '1' } }) };
    expect(hooks.handleError({ error: new Error('/Users/host/secret.svelte broke'), kind: 'unknown', event: guest })).toBeUndefined();
    const marked = { request: new Request('http://127.0.0.1/', { headers: { [LIVE_GUEST_HEADER]: '' } }) };
    expect(hooks.handleError({ error: new Error('broke'), kind: 'unknown', event: marked })).toBeUndefined();
    // A page the server fetches while rendering another goes without the guest's mark: it says nothing either.
    expect(hooks.handleError({ error: new Error('broke'), kind: 'unknown', event: { ...host, isSubRequest: true } })).toBeUndefined();
  });

  it('gives the preview’s server hook nothing else the website’s lacks', async () => {
    const { s } = await broken();
    const dev = generateProject(s, { instrument: true }).get(SERVER_HOOK_FILE)!;
    const clean = generateProject(s, { instrument: false }).get(SERVER_HOOK_FILE)!;
    const added = /\n\/\*\* The editor's preview only[^\n]*\nexport function handleError\([\s\S]*?\n\}\n/.exec(dev);
    expect(added).not.toBeNull();
    expect(dev.replace(added![0], '')).toBe(clean);
  });

  it('shows its note from a snippet of the editor’s own name, never one called `failed` among the placement’s values', async () => {
    const { s, nodeId } = await broken();
    const page = generateProject(s, { instrument: true }).get(pageFile(s.pages[s.site.homePageId]))!;
    const wrapper = page.slice(page.indexOf(`data-so-node="${nodeId}"`));
    expect(wrapper).toMatch(/^[^\n]*\n\t*\{#snippet (so_render_failed_\d+)\(so_failure, so_retry\)\}\n[^\n]*data-so-render-error[^\n]*\n\t*\{\/snippet\}\n\t*<svelte:boundary failed=\{\1\}>/);
    expect(page).not.toMatch(/\{#snippet failed\b/);
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
    expect(await hooks.handleError({ kind: 'unknown', error: 'thrown text' })).toEqual({ soRenderError: 'thrown text' });
    const mine = await load(withRenderErrors(app(`async ({ error }) => ({ message: 'Ours', code: 7 })`)));
    expect(await mine.hooks.handleError({ kind: 'unknown', error: new Error('Broken') })).toEqual({ message: 'Ours', code: 7, soRenderError: 'Broken' });
    // The site's own hook answers at once, and is handed what SvelteKit gives it.
    const sync = await load(withRenderErrors(app(`(input) => ((globalThis.__soHookInput = input), { message: 'Sync' })`)));
    const input = { kind: 'unknown', error: new Error('Now'), event: { url: 'x' } };
    expect(sync.hooks.handleError(input)).toEqual({ message: 'Sync', soRenderError: 'Now' });
    expect((globalThis as { __soHookInput?: unknown }).__soHookInput).toBe(input);
    expect(sync.hooks.handleError({ kind: 'framework', error: { status: 404 } })).toEqual({ message: 'Sync' });
  });

  it('is added only to SvelteKit’s generated client app of the project being previewed', () => {
    const dir = resolve('.tmp', 'render-error-project');
    const plugin = devPlugin(dir);
    const id = (rel: string) => join(dir, rel).split('\\').join('/');
    const code = app(null);
    expect(plugin.transform(code, id('.svelte-kit/generated/dev/client/app.js'))?.code).toBe(withRenderErrors(code));
    expect(plugin.transform(code, `${id('.svelte-kit/generated/client/app.js')}?v=1`)?.code).toBe(withRenderErrors(code));
    expect(plugin.transform(code, id('.svelte-kit/generated/client-optimized/app.js'))?.code).toBe(withRenderErrors(code));
    expect(plugin.transform(code, id('src/lib/app.js'))).toBeNull();
    // A module of the project's own that happens to have the name, and another project beside it, are left alone.
    expect(plugin.transform(code, id('src/lib/generated/client/app.js'))).toBeNull();
    expect(plugin.transform(code, `${id('')}-other/.svelte-kit/generated/dev/client/app.js`)).toBeNull();
    expect(plugin.transform(code, '/elsewhere/.svelte-kit/generated/dev/client/app.js')).toBeNull();
    expect(plugin.transform('export const nodes = [];', id('.svelte-kit/generated/dev/client/app.js'))).toBeNull();
  });
});
