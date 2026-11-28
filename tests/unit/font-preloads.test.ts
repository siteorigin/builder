/**
 * Issue 1487: every page of the website asks for the theme fonts it shows first (body text, the main heading) from
 * its <head>, through SvelteKit's `preload` option in the generated server hook, rather than once the stylesheet that
 * names them has arrived.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Operation, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { getTheme } from '@catalogue/index';
import { FONTS_DIR, SERVER_HOOK_FILE, generateProject, generateServerHook, packFileCopies, preloadFontFiles } from '@generator/index';
import { NOT_FOUND_JS } from '@generator/runtime-files';
import { NOT_FOUND_ROUTE } from '@shared/not-found';

const fresh = () => createStarterState('business', 'Test Studio', false);
const run = (s: ProjectState, ...ops: Operation[]) => applyOperations(s, ops).state;
const stack = (name: string) => getTheme('foundation').fonts.find((f) => f.name === name)!.stack;
const INTER = `${FONTS_DIR}/inter-latin-wght-normal.woff2`;
const FRAUNCES = `${FONTS_DIR}/fraunces-latin-wght-normal.woff2`;

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

type Preload = (input: { type: string; path: string; filename?: string }) => boolean;
type ResolveOptions = { preload?: Preload; transformPageChunk?: (c: { html: string; done: boolean }) => string };

/** The options the generated server hook hands SvelteKit's `resolve` for a page at `routeId`, as the build runs it. */
async function resolveOptions(hookSource: string, routeId: string): Promise<ResolveOptions | undefined> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'font-preloads-'));
  roots.push(dir);
  writeFileSync(join(dir, 'env.mjs'), 'export const building = true;\n');
  writeFileSync(join(dir, 'not-found.mjs'), NOT_FOUND_JS);
  const hook = join(dir, 'hooks.server.mjs');
  writeFileSync(hook, hookSource.replace("'$app/env'", JSON.stringify(join(dir, 'env.mjs'))).replace("'./lib/siteorigin/runtime/not-found.js'", JSON.stringify(join(dir, 'not-found.mjs'))));
  const { handle } = await import(/* @vite-ignore */ hook);
  let seen: ResolveOptions | undefined;
  handle({ event: { route: { id: routeId }, url: new URL(`http://sveltekit-prerender${routeId}`) }, resolve: (_e: unknown, o?: ResolveOptions) => ((seen = o), '') });
  return seen;
}

describe('font preloads', () => {
  it('preload the upright basic-Latin face of the body and heading fonts, each a file the project has', () => {
    const s = fresh();
    expect(preloadFontFiles(s)).toEqual([INTER, FRAUNCES]);
    // Each is a file the editor copies into the project, so the build has it to preload.
    const copies = packFileCopies(s).map((c) => c.path);
    for (const file of preloadFontFiles(s)) expect(copies).toContain(file);
  });

  it('are asked for by every page of the website, beside SvelteKit’s own scripts and styles', async () => {
    const s = fresh();
    const hook = generateProject(s).get(SERVER_HOOK_FILE)!;
    for (const route of ['/', '/about/', NOT_FOUND_ROUTE]) {
      const preload = (await resolveOptions(hook, route))?.preload;
      expect(preload, route).toBeTypeOf('function');
      expect(preload!({ type: 'js', path: '/_app/immutable/entry/start.js' })).toBe(true);
      expect(preload!({ type: 'css', path: '/_app/immutable/assets/0.css' })).toBe(true);
      expect(preload!({ type: 'font', path: '/_app/immutable/assets/inter-latin-wght-normal.Ab12.woff2', filename: INTER })).toBe(true);
      expect(preload!({ type: 'font', path: '/_app/immutable/assets/fraunces-latin-wght-normal.Cd34.woff2', filename: FRAUNCES })).toBe(true);
      // Other scripts and italic faces load when the page needs them, as before.
      expect(preload!({ type: 'font', path: '/_app/immutable/assets/inter-latin-ext-wght-normal.Ef56.woff2', filename: `${FONTS_DIR}/inter-latin-ext-wght-normal.woff2` })).toBe(false);
      expect(preload!({ type: 'font', path: '/_app/immutable/assets/inter-latin-wght-italic.Gh78.woff2', filename: `${FONTS_DIR}/inter-latin-wght-italic.woff2` })).toBe(false);
      expect(preload!({ type: 'asset', path: '/_app/immutable/assets/x.png' })).toBe(false);
    }
    // The not-found page keeps what makes it work at any address.
    expect((await resolveOptions(hook, NOT_FOUND_ROUTE))?.transformPageChunk).toBeTypeOf('function');
  });

  it('are asked for on pages in another language too, which keep their own <html lang>', async () => {
    const start = fresh();
    const s = run(start, { type: 'page.update', pageId: start.site.pageOrder[1], language: 'fr' } as Operation);
    const hook = generateServerHook(s);
    // The route SvelteKit gives the page in French, as the hook lists it.
    const french = Object.keys(JSON.parse(hook.match(/const LANGUAGES = (\{[^;]*\});/)![1]))[0];
    const opts = await resolveOptions(hook, french);
    expect(opts?.preload?.({ type: 'font', path: '/x.woff2', filename: INTER })).toBe(true);
    expect(opts?.transformPageChunk).toBeTypeOf('function');
    expect((await resolveOptions(hook, '/'))?.preload?.({ type: 'font', path: '/x.woff2', filename: FRAUNCES })).toBe(true);
  });

  it('are left out of the editor’s preview, which has no built files', () => {
    expect(generateProject(fresh(), { instrument: true }).get(SERVER_HOOK_FILE)).not.toContain('preload');
  });

  it('name one file when body text and headings share a family', () => {
    const s = run(fresh(), { type: 'token.set', tokenId: 'font.display', value: stack('Inter') } as Operation);
    expect(preloadFontFiles(s)).toEqual([INTER]);
  });

  it('follow the fonts the author chose', () => {
    const s = run(fresh(), { type: 'token.set', tokenId: 'font.body', value: stack('Lora') } as Operation, { type: 'token.set', tokenId: 'text.h1', value: { family: 'Playfair Display' } } as Operation);
    expect(preloadFontFiles(s)).toEqual([`${FONTS_DIR}/lora-latin-wght-normal.woff2`, `${FONTS_DIR}/playfair-display-latin-wght-normal.woff2`]);
  });

  it('skip a style that leads with a system font, even with a theme font behind it', () => {
    const s = run(fresh(), { type: 'token.set', tokenId: 'font.body', value: "system-ui, 'Inter Variable', sans-serif" } as Operation);
    expect(preloadFontFiles(s)).toEqual([FRAUNCES]);
  });

  it('skip a face that does not draw the style’s weight', () => {
    // Playfair Display's file draws 400 to 900: a lighter heading takes a face the browser makes up.
    const s = run(fresh(), { type: 'token.set', tokenId: 'text.h1', value: { family: 'Playfair Display', weight: 300 } } as Operation);
    expect(preloadFontFiles(s)).toEqual([INTER]);
  });

  it('skip a family the project’s own font files may stand in for', () => {
    const s = fresh();
    s.assets.assets['f1'] = { id: 'f1', name: 'Inter', file: 'static/assets/inter-aaaaaaaa.woff2', mime: 'font/woff2', bytes: 1, hash: 'x', kind: 'font', createdAt: '', font: { family: 'Inter Variable', weight: '400', style: 'normal' } };
    expect(preloadFontFiles(s)).toEqual([FRAUNCES]);
  });

  it('leave the server hook as it was while the site shows only system fonts', async () => {
    const s = run(fresh(), { type: 'token.set', tokenId: 'font.body', value: 'system-ui, sans-serif' } as Operation, { type: 'token.set', tokenId: 'font.display', value: 'Georgia, serif' } as Operation);
    expect(preloadFontFiles(s)).toEqual([]);
    const hook = generateServerHook(s);
    expect(hook).not.toContain('preload');
    expect(hook).toContain('return resolve(event);');
    expect(await resolveOptions(hook, '/')).toBeUndefined();
  });
});
