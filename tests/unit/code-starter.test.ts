/**
 * The source New code component starts from (#1135), created unchanged: each placement takes its own styles on its
 * root and its heading, in the editor's preview and in the website.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { chromium } from 'playwright';
import type { ProjectState } from '@shared/types';
import { CODE_STARTER, CODE_STARTER_PROPERTIES } from '@shared/code-starter';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { codeTakesOverrides } from '@engine/tree';
import { generateProject, pageFile } from '@generator/index';
import { checkSvelteSource, codeContractNames, withoutCodeMarkers } from '../../src/main/codecheck';

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The starter created as the dialog creates it, then placed twice on the home page, as the session applies it. */
async function placedTwice() {
  let state: ProjectState = createStarterState('blank', 'Starter', false);
  const pageId = state.site.homePageId;
  const owner = { kind: 'page' as const, id: pageId };
  const names = (await codeContractNames(CODE_STARTER))!;
  const made = applyOperations(state, [{ type: 'component.createCode', name: 'Starter', source: CODE_STARTER, properties: structuredClone(CODE_STARTER_PROPERTIES) }], { codeNames: () => names });
  const definitionId = made.results[0].definitionId as string;
  state = made.state;
  const placed: string[] = [];
  for (let index = 0; index < 2; index++) {
    const r = applyOperations(state, [{ type: 'node.insert', owner, parentId: null, index, definitionId }]);
    state = r.state;
    placed.push(r.results[0].nodeId as string);
  }
  const looks = [
    { padding: '11px', color: '#aa0000' },
    { padding: '37px', color: '#0000bb' }
  ];
  state = applyOperations(
    state,
    placed.flatMap((nodeId, i) => [
      { type: 'node.setStyle' as const, owner, nodeId, partId: 'root', scope: 'base' as const, property: 'paddingBlock', value: looks[i].padding },
      { type: 'node.setStyle' as const, owner, nodeId, partId: 'heading', scope: 'base' as const, property: 'color', value: looks[i].color }
    ])
  ).state;
  return { state, pageId, definitionId };
}

/**
 * The home page server-rendered with the stylesheets it is shown with: the site's own, then each component's scoped
 * styles. The website's copy of the code has its editor markers taken out, as the export takes them.
 */
async function renderHome(state: ProjectState, instrument: boolean) {
  const files = generateProject(state, { instrument });
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'code-starter-'));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";\n');
  const navigation = join(dir, 'app-navigation.js');
  writeFileSync(navigation, 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};\n');
  const sheets: string[] = [];
  for (const [path, source] of files) {
    if (/^src\/lib\/siteorigin\/styles\/.+\.css$/.test(path)) sheets.push(source);
    if (!path.startsWith('src/') || !/\.(svelte|js)$/.test(path)) continue;
    const out = join(dir, path.endsWith('.svelte') ? `${path}.js` : path);
    mkdirSync(dirname(out), { recursive: true });
    let code = source;
    if (path.endsWith('.svelte')) {
      const result = compile(instrument ? source : await withoutCodeMarkers(source), { filename: path, generate: 'server', runes: true, css: 'external' });
      code = result.js.code;
      if (result.css?.code) sheets.push(result.css.code);
    }
    writeFileSync(
      out,
      code
        .replace(/(["'])([^"'\n]+?\.svelte)\1/g, '$1$2.js$1')
        .replace(/(["'])\$app\/paths\1/g, JSON.stringify(paths))
        .replace(/(["'])\$app\/navigation\1/g, JSON.stringify(navigation))
        .replace(/^\s*import\s+['"][^'"]+\.css['"];?\s*$/gm, '')
    );
  }
  const Page = (await import(/* @vite-ignore */ join(dir, `${pageFile(state.pages[state.site.homePageId])}.js`))).default as Component<Record<string, unknown>>;
  return { body: render(Page, { props: {} }).body, css: sheets.join('\n') };
}

describe('the New code component starter', () => {
  it('declares a heading part, takes placement styles, and passes the code check with nothing to say', async () => {
    const { state, definitionId } = await placedTwice();
    const def = state.components[definitionId];
    expect(def.parts.heading).toEqual({ nodeId: 'heading', label: 'Heading' });
    expect(codeTakesOverrides(def)).toBe(true);
    expect(await checkSvelteSource(CODE_STARTER, { contract: def })).toEqual([]);
  });

  describe.skipIf(!existsSync(chromium.executablePath()))('placed twice', () => {
    it.each([
      ['the editor’s preview', true],
      ['the website', false]
    ])('shows each placement’s own spacing and heading colour in %s', async (_, instrument) => {
      const { state } = await placedTwice();
      const page = await renderHome(state, instrument);
      const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
      try {
        const tab = await browser.newPage({ viewport: { width: 1200, height: 800 } });
        await tab.setContent(`<!doctype html><html><head><style>${page.css}</style></head><body>${page.body}</body></html>`);
        // A string, as the browser runs it: these tests compile without the DOM's types.
        const shown = await tab.evaluate(`[...document.querySelectorAll('section.custom')].map((s) => ({ top: getComputedStyle(s).paddingTop, bottom: getComputedStyle(s).paddingBottom, color: getComputedStyle(s.querySelector('h2')).color }))`);
        expect(shown).toEqual([
          { top: '11px', bottom: '11px', color: 'rgb(170, 0, 0)' },
          { top: '37px', bottom: '37px', color: 'rgb(0, 0, 187)' }
        ]);
      } finally {
        await browser.close();
      }
    }, 30_000);
  });
});
