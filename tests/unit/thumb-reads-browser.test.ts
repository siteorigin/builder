/**
 * What a component's thumbnail can show of the site's colours (main/runtime/thumb-reads), in headless Chromium. Every
 * catalogue component of every theme pack, and project cards, are rendered as their isolated previews are (the
 * generated preview module and the files it imports, server-rendered), on a page with the site's real token, base and
 * component stylesheets. The script says which custom properties the page reads; then every colour the answer leaves
 * out is changed, in the light palette and the dark one, and nothing on the page may look any different: every
 * element's computed style, and its generated content's and marker's, stays the same. A thumbnail kept by those
 * colours is then the one a new photograph would give. Then the cases the script must not be fooled by.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { getTheme, listThemes } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import { generateComponentPreview } from '@generator/preview';
import { PREVIEW_COMPONENT_STYLES, PREVIEW_MODULE } from '@shared/component-preview';
import { parseReads, STILL_CSS, thumbReads } from '../../src/main/runtime/thumb-reads';
import { brandParts } from '../../src/main/runtime/component-thumbs';

const GEN = '\0gen:';

/** A preview as its page shows it: its markup and every stylesheet the page loads. */
interface Shown {
  name: string;
  body: string;
  tokens: string;
  css: string;
  colours: ReadonlySet<string>;
}

/** The previews' modules server-rendered, each with the scoped styles of the components it renders. */
async function render(previews: Array<Map<string, string>>): Promise<Array<{ body: string; scoped: string }>> {
  const scoped = previews.map(() => [] as string[]);
  const entry = `export { render } from 'svelte/server';\n${previews.map((_, i) => `export { default as P${i} } from ${JSON.stringify(`${GEN}${i}:${PREVIEW_MODULE}`)};`).join('\n')}`;
  const at = (id: string) => {
    const m = /^\0gen:(\d+):(.*)$/.exec(id);
    return m ? { i: Number(m[1]), path: m[2] } : null;
  };
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    plugins: [
      {
        name: 'generated-previews',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === '\0entry' || id.startsWith(GEN)) return id;
          if (id === '$app/paths' || id === '$app/state' || id === '$app/navigation') return `\0${id}`;
          const from = importer ? at(importer) : null;
          if (from && id.startsWith('.')) {
            const path = posix.join(posix.dirname(from.path), id);
            if (previews[from.i].has(path)) return `${GEN}${from.i}:${path}`;
          }
          return null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (id === '\0$app/paths') return "export const resolve = (p) => p; export const asset = (p) => '/' + p; export const base = '';";
          if (id === '\0$app/state') return "export const page = { route: { id: '/' }, url: new URL('https://site.test/') };";
          if (id === '\0$app/navigation') return 'export const afterNavigate = () => {}; export const beforeNavigate = () => {}; export const snapshot = () => {};';
          const file = at(id);
          if (!file) return null;
          if (file.path.endsWith('.css')) return { code: '', moduleType: 'js' };
          const source = previews[file.i].get(file.path)!;
          if (!file.path.endsWith('.svelte')) return { code: source, moduleType: 'js' };
          const compiled = compile(source, { filename: file.path, generate: 'server', runes: true, css: 'external' });
          if (compiled.css?.code) scoped[file.i].push(compiled.css.code);
          return { code: compiled.js.code, moduleType: 'js' };
        }
      }
    ],
    build: { write: false, ssr: true, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'esm', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The previews did not bundle');
  const dir = mkdtempSync(join(tmpdir(), 'so-thumb-reads-'));
  try {
    const file = join(dir, 'previews.mjs');
    writeFileSync(file, chunk.code);
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown> & { render: (c: unknown, o: { props: Record<string, unknown> }) => { body: string } };
    return previews.map((_, i) => ({ body: mod.render(mod[`P${i}`], { props: {} }).body.replace(/<!--[\s\S]*?-->/g, ''), scoped: scoped[i].join('\n') }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every preview of `specs` on `state`, as its page would show it. */
async function shown(state: ProjectState, specs: Array<{ name: string; spec: Parameters<typeof generateComponentPreview>[1] }>): Promise<Shown[]> {
  const made = specs.flatMap(({ name, spec }) => {
    const out = generateComponentPreview(state, spec);
    return 'error' in out ? [] : [{ name, files: out.files }];
  });
  const parts = brandParts(state);
  const rendered = await render(made.map((m) => m.files));
  return made.map((m, i) => ({ name: m.name, body: rendered[i].body, tokens: parts.tokens, css: [getTheme(state.site.themeId).baseCss, m.files.get(PREVIEW_COMPONENT_STYLES) ?? '', rendered[i].scoped].join('\n'), colours: parts.colours }));
}

let browser: Browser | null = null;
let page: Page;
const engine = existsSync(chromium.executablePath());

beforeAll(async () => {
  if (!engine) return;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

async function show(s: Pick<Shown, 'body' | 'tokens' | 'css'>, scheme: 'light' | 'dark' = 'light') {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setContent(`<!doctype html><html lang="en" dir="ltr" class="so-js"><head><style id="tokens"></style><style id="rest"></style><style id="still"></style></head><body>${s.body}</body></html>`);
  await page.evaluate(([tokens, css, still]) => {
    const g = globalThis as unknown as { document: { getElementById(id: string): { textContent: string } } };
    g.document.getElementById('tokens').textContent = tokens;
    g.document.getElementById('rest').textContent = css;
    // As the hidden window shows it: every animation and transition at its end.
    g.document.getElementById('still').textContent = still;
  }, [s.tokens, s.css, STILL_CSS] as const);
  // And, as it does, once the fonts have arrived (or failed) and the page has drawn.
  await page.evaluate(`document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`);
}

const readsNow = async (phase: 'before' | 'after' = 'before') => parseReads(await page.evaluate(thumbReads(phase)));

/** Every element's computed style (custom properties aside), and its ::before's, ::after's and ::marker's. */
const LOOKS = `(() => {
  const out = [];
  for (const el of [document.documentElement, ...document.querySelectorAll('body, body *')])
    for (const pseudo of [null, '::before', '::after', '::marker']) {
      const cs = getComputedStyle(el, pseudo);
      const vals = [];
      for (let i = 0; i < cs.length; i++) if (!cs[i].startsWith('--')) vals.push(cs[i] + ':' + cs.getPropertyValue(cs[i]));
      out.push(vals.join(';'));
    }
  return out;
})()`;

/** The token stylesheet with every colour not in `reads` set to a value of its own that no other has. */
function otherColours(tokens: string, colours: ReadonlySet<string>, reads: ReadonlySet<string>): string {
  let n = 0;
  return tokens
    .split('\n')
    .map((line) => {
      const m = /^(\s*)(--[A-Za-z0-9_-]+): ([^;{}]*);$/.exec(line);
      if (!m || !colours.has(m[2]) || reads.has(m[2])) return line;
      n++;
      return `${m[1]}${m[2]}: rgb(${(n * 37) % 256} ${(n * 91 + 17) % 256} ${(n * 53 + 101) % 256});`;
    })
    .join('\n');
}

/** Shows `s`, reads it, then checks that a change of every colour it does not read changes nothing on the page. */
async function holds(s: Shown, scheme: 'light' | 'dark'): Promise<string[] | null> {
  await show(s, scheme);
  const reads = await readsNow();
  if (!reads) return null;
  const before = (await page.evaluate(LOOKS)) as string[];
  const changed = otherColours(s.tokens, s.colours, new Set(reads));
  // It reads every colour: its picture is kept by all of them, as by its version.
  if (changed === s.tokens) return reads;
  await show({ ...s, tokens: changed }, scheme);
  const after = (await page.evaluate(LOOKS)) as string[];
  expect(after.length, s.name).toBe(before.length);
  const differs = after.findIndex((v, i) => v !== before[i]);
  const what = differs < 0 ? '' : (() => {
    const was = new Map(before[differs].split(';').map((d) => [d.slice(0, d.indexOf(':')), d]));
    const now = after[differs].split(';').filter((d) => was.get(d.slice(0, d.indexOf(':'))) !== d);
    return `element ${Math.floor(differs / 4)}${['', '::before', '::after', '::marker'][differs % 4]}: ${now.slice(0, 6).map((d) => `${was.get(d.slice(0, d.indexOf(':'))) ?? '(none)'} -> ${d}`).join(' | ')}`;
  })();
  expect(differs, `${s.name} (${scheme}): changing colours it does not read (${[...s.colours].filter((c) => !reads.includes(c)).join(', ')}) changed how it looks: ${what}`).toBe(-1);
  return reads;
}

describe.skipIf(!engine)('what a thumbnail can show of the site’s colours', () => {
  it('names every colour a catalogue component’s preview can show, in every theme and both palettes', async () => {
    let checked = 0;
    let fewer = 0;
    const unknown = new Set<string>();
    for (const theme of listThemes().filter((t) => !t.devOnly)) {
      const base = createStarterState('blank', 'Thumb Studio', false, theme.id);
      // A site with a dark palette too, so its colours are each declared twice.
      const state = applyOperations(base, [{ type: 'token.setColorScheme', mode: 'system' }]).state;
      const previews = await shown(
        state,
        theme.components.map((c) => ({ name: `${theme.id}/${c.componentId}`, spec: { componentId: c.componentId } }))
      );
      // Every component of the theme is shown.
      expect(previews.map((p) => p.name).sort()).toEqual(theme.components.map((c) => `${theme.id}/${c.componentId}`).sort());
      for (const s of previews)
        for (const scheme of ['light', 'dark'] as const) {
          const reads = await holds(s, scheme);
          if (!reads) {
            unknown.add(s.name);
            continue;
          }
          checked++;
          if (reads.filter((r) => s.colours.has(r)).length < s.colours.size) fewer++;
        }
    }
    // None of them is one the script cannot read (a frame, a canvas…): each is checked, not passed over.
    expect([...unknown]).toEqual([]);
    expect(checked).toBeGreaterThan(40);
    expect(fewer).toBeGreaterThan(0);
  }, 300_000);

  /** Two cards of the project's own, one painted on the brand colour, shown as their previews are. */
  async function cards(): Promise<[Shown, Shown]> {
    const card = (name: string) => ({ type: 'component.upsert', name, properties: {}, nodes: [{ kind: 'element', id: 'root', tag: 'article', children: ['title', 'body'] }, { kind: 'text', id: 'title', tag: 'h3', text: name }, { kind: 'text', id: 'body', tag: 'p', text: 'A plain card.' }] });
    const made = applyOperations(createStarterState('business', 'Thumb Studio', false), [card('Plain card'), card('Brand card')] as never);
    const [plain, brand] = made.results.map((r) => r.definitionId as string);
    const painted = applyOperations(made.state, [{ type: 'node.setStyle', owner: { kind: 'component', id: brand }, nodeId: made.state.components[brand].tree!.rootIds[0], scope: 'base', property: 'background', value: { token: 'color.brand' } }] as never).state;
    const [p, b] = await shown(painted, [
      { name: 'plain', spec: { definitionId: plain } },
      { name: 'brand', spec: { definitionId: brand } }
    ]);
    return [p, b];
  }

  it('reads the brand colour for a card painted on it, and what it reads of a plain card keeps its picture', async () => {
    const [p, b] = await cards();
    expect(await holds(p, 'light')).not.toBeNull();
    expect(await holds(b, 'light')).toContain('--so-color-brand');
  }, 120_000);

  // Release gap: thumb-reads.ts (src/main/runtime) takes a selector holding both a quote and a pseudo-element as applying, and the release's base CSS draws a chosen tab's underline in the brand colour under one (.so-tablist > .so-plain-link[role='tab'][aria-selected='true']::after), so every preview reads the brand colour.
  it.fails('does not read the brand colour for a card that never shows it', async () => {
    const [p] = await cards();
    expect(await holds(p, 'light')).not.toContain('--so-color-brand');
  }, 120_000);
});

describe.skipIf(!engine)('what the script must not be fooled by', () => {
  const page0 = (css: string, body: string, tokens = ':root { --a: red; --b: blue; --c: green; --d: black; }') => show({ tokens, css, body });

  it('reads a property a shorthand names, alone or beside a longhand, and through another property', async () => {
    await page0('.x { background: var(--a); margin: var(--b) 0; } .y { --mine: var(--c); color: var(--mine); }', '<p class="x">x</p><p class="y">y</p>');
    expect(await readsNow()).toEqual(['--a', '--b', '--c', '--mine']);
    // Written back part by part, with no values: every name its stylesheet holds counts, as far as the rule applies.
    await page0('.x { border: 1px solid var(--b); border-top-color: red; } .other { color: var(--d); }', '<p class="x">x</p>');
    expect(await readsNow()).toEqual(['--b', '--d']);
    await page0('.none { border: 1px solid var(--b); border-top-color: red; }', '<p class="x">x</p>');
    expect(await readsNow()).toEqual([]);
    // With a custom property of its own beside it, too.
    await page0('.x { --local: 1; border: 4px solid var(--b); border-top-color: red; } .other { color: var(--d); }', '<p class="x">x</p>');
    expect(await readsNow()).toEqual(['--b', '--d', '--local']);
  });

  it('takes a selector with a pseudo-element’s name in quotes as applying', async () => {
    await page0('[aria-label="::selection"] { background: var(--a); } [title="::before"] { color: var(--b); } [title=x]::before { color: var(--c); }', '<p aria-label="::selection">p</p>');
    expect(await readsNow()).toEqual(['--a', '--b', '--c']);
  });

  it('cannot tell once the page changed between the read before a photograph and the one after', async () => {
    await page0('p { color: var(--a); }', '<p id="t">p</p>');
    expect(await readsNow('before')).toEqual(['--a']);
    expect(await readsNow('after')).toEqual(['--a']);
    expect(await readsNow('before')).toEqual(['--a']);
    await page.evaluate(`document.getElementById('t').classList.add('on')`);
    expect(await readsNow('after')).toBeNull();
    // An after with no before: nothing watched it.
    expect(await readsNow('after')).toBeNull();
  });

  it('takes from a page’s answer only names as the script reads them, sorted and each once', () => {
    expect(parseReads({ reads: ['--a', '--b'] })).toEqual(['--a', '--b']);
    for (const reads of [['--b', '--a'], ['--a', '--a'], ['--a --b'], ['-a'], ['--a\\61'], ['--'], 'x', [1]]) expect(parseReads({ reads }), JSON.stringify(reads)).toBeNull();
    expect(parseReads(null)).toBeNull();
  });

  it('leaves out what no element shows, and a colour only another unread property names', async () => {
    await page0('.nothing { color: var(--a); } :root { --unused: var(--b); } p { color: var(--c); }', '<p>p</p>');
    expect(await readsNow()).toEqual(['--c']);
  });

  it('takes every visited-link rule as applying, whatever surrounds it', async () => {
    await page0('a[href]:not(:visited) { color: var(--a); } a:visited { color: var(--b); }', '<a href="https://example.test/">link</a>');
    expect(await readsNow()).toEqual(['--a', '--b']);
  });

  it('counts the selection’s colours only while something is selected or focused', async () => {
    await page0('::selection { background: var(--a); } :focus-visible { outline-color: var(--b); }', '<p id="t">text</p><input id="i">');
    expect(await readsNow()).toEqual([]);
    await page.evaluate(`(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('t')); getSelection().addRange(r); })()`);
    expect(await readsNow()).toEqual(['--a']);
    await page.evaluate(`(() => { getSelection().removeAllRanges(); document.getElementById('i').focus(); })()`);
    expect(await readsNow()).toEqual(['--a', '--b']);
  });

  it('counts a registered highlight’s colours', async () => {
    await page0('::highlight(hit) { background: var(--a); }', '<p id="t">text</p>');
    expect(await readsNow()).toEqual([]);
    await page.evaluate(`(() => { const r = new Range(); r.selectNodeContents(document.getElementById('t')); CSS.highlights.set('hit', new Highlight(r)); })()`);
    expect(await readsNow()).toEqual(['--a']);
  });

  it('counts generated content and markers where their element is, and pseudo-elements of no element not at all', async () => {
    await page0('p::before { content: ""; background: var(--a); } li::marker { color: var(--b); } .none::after { color: var(--c); }', '<p>p</p><ul><li>i</li></ul>');
    expect(await readsNow()).toEqual(['--a', '--b']);
  });

  it('counts nested rules, style queries, animations and conditions whatever holds now', async () => {
    await page0(
      '.n { & .deep { color: var(--a); } } @container style(--b: on) { .z { color: red; } } @keyframes k { to { color: var(--c); } } @media print { p { color: var(--d); } }',
      '<div class="n"></div><p>p</p>'
    );
    expect(await readsNow()).toEqual(['--a', '--b', '--c', '--d']);
  });

  it('counts what an element’s attributes name', async () => {
    await page0('', '<p style="color: var(--a)">p</p><svg><rect fill="var(--b)" width="1" height="1"/></svg>');
    expect(await readsNow()).toEqual(['--a', '--b']);
  });

  it('cannot tell for a shadow root, a canvas, a frame, an SVG use or an escaped name', async () => {
    for (const body of ['<div id="h"></div>', '<canvas></canvas>', '<iframe></iframe>', '<svg><use href="#x"/></svg>']) {
      await page0('p { color: var(--a); }', body);
      if (body.includes('id="h"')) await page.evaluate(`document.getElementById('h').attachShadow({ mode: 'open' })`);
      expect(await readsNow(), body).toBeNull();
    }
    await page0('p { color: var(--a\\ b); }', '<p>p</p>');
    expect(await readsNow()).toBeNull();
  });
});
