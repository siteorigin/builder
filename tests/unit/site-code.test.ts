/**
 * The site's own code and integrations (#1485): head markup and a stylesheet the author writes in Site settings, and
 * Fathom Analytics added from its site ID. What the checks keep and refuse, what `site.update` stores, what needs
 * Developer mode, and what the website and the editor's preview are each generated with.
 */
import { describe, expect, it } from 'vitest';
import { transform } from 'lightningcss';
import { compile } from 'svelte/compiler';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { developerModeRefusal } from '@engine/developer-mode';
import { validateState } from '@engine/validate';
import { generateProject, GLOBAL_CSS_FILE, STYLES_DIR } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { globalCssProblem, headCodeProblem, HEAD_CODE_MAX, siteGlobalCss, siteHeadCode } from '@shared/site-code';
import { addedIntegrations, fathomSiteId, fathomTag } from '@shared/integrations';

const LAYOUT = 'src/routes/+layout.svelte';
const CSS_FILE = `${STYLES_DIR}/${GLOBAL_CSS_FILE}`;

const fresh = () => createStarterState('blank', 'Riverside Studio', false);
const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const refusal = (s: ProjectState, op: EditOperation) => {
  try {
    applyOperations(s, [op]);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('The operation was not refused.');
};

const GA = `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-ABC123');
</script>`;

describe('head code', () => {
  it('keeps what a <head> holds: meta, link, script and style elements, and comments', () => {
    for (const ok of [
      '',
      '<meta name="google-site-verification" content="abc123">',
      '<meta name="p:domain_verify" content=abc123 />',
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel=stylesheet href="https://fonts.googleapis.com/css2?family=Inter&display=swap">',
      GA,
      '<script type="application/ld+json">{"@context":"https://schema.org","name":"a < b"}</script>',
      '<script>const close = "<\\/script>";</script>',
      '<STYLE media="print">body { color: black }</STYLE >',
      '<link rel="preload" as="style" href="/x.css" onload="this.rel=\'stylesheet\'">',
      '<!-- a comment -->\n<!-- -->'
    ])
      expect(headCodeProblem(ok), ok).toBeNull();
  });

  it('refuses what would leave the head, break the page or end Svelte’s {@html} early, saying where', () => {
    const cases: Array<[string, RegExp]> = [
      ['<div>Hi</div>', /<div> cannot go in the head/],
      ['<title>Mine</title>', /title/],
      ['<base href="/">', /<base>/],
      ['<noscript><img src="x"></noscript>', /noscript/],
      ['<head><meta name="a" content="b"></head>', /without the <head> tag/],
      ['<script>let a = 1;', /never closed with <\/script>/],
      ['<script>document.write("</script>")</script>', /Text follows <\/script>/],
      ['<meta name="x" content="%sveltekit.body%">', /SvelteKit/],
      ['<!---->', /empty comment/],
      ['<!-->', /closes as soon as it opens/],
      ['<!-- never closed', /never closed with -->/],
      ['<script src="x.js"/>', /does not close in HTML/],
      ['<meta charset="utf-8">', /character set/],
      ['<meta name="viewport" content="width=device-width">', /viewport/],
      ['<meta http-equiv="refresh" content="0;url=/x">', /http-equiv/],
      ['<meta name=a"b content=x>', /needs quotes/],
      ['<meta name="a" name="b">', /twice/],
      ['</div>', /closes nothing/],
      ['Hello', /Text cannot go in the head/],
      ['<script>if (a <!-- b) {}</script>', /<!--/],
      ['<meta name="a" content="b"', /never closed with >/],
      ['<!doctype html>', /doctype/],
      ['<meta name="a\u0000">', /NUL/],
      ['x'.repeat(HEAD_CODE_MAX + 1), /at most/]
    ];
    for (const [code, message] of cases) expect(headCodeProblem(code)?.message, code).toMatch(message);
    expect(headCodeProblem('<meta name="a" content="b">\n\n  <span>')).toMatchObject({ line: 3, column: 3 });
  });
});

/** Stylesheets the check keeps, each one the website's build minifies without stopping. */
const GOOD_CSS = [
  '',
  'body { font-family: "Inter", sans-serif; }',
  '.so-btn:hover, .so-btn:focus-visible { border-radius: 0 !important }',
  'a { &:hover { color: red } .x & { color: blue } > b { color: green } }',
  '@media (min-width: 40rem) and (hover: hover) { .grid { display: grid; grid-template-areas: "a b" "c d"; } }',
  '@supports (display: grid) { @media screen { a { color: red } } }',
  '@layer base, theme; @layer base { h1 { margin: 0 } }',
  '@font-face { font-family: Brand; src: url(https://cdn.example.com/brand.woff2) format("woff2"); font-display: swap }',
  '@keyframes pulse { from { opacity: 0 } 50%, 75.5% { opacity: .5 } to { opacity: 1 } }',
  ':root { --brand: { a: b }; --gap: 1rem; --empty:; }',
  'figure:has(> img) { margin: 0 } :is(h1, h2):not(.plain) { letter-spacing: -0.01em }',
  'a[href^="https"], input[type=checkbox i], [data-state="open"] { outline: 1px solid }',
  '.md\\:flex { display: flex } #main, #a1 { color: red }',
  '.quote::before { content: "url(missing) } { ;" }',
  '.hero { background: url("/images/hero.jpg") center / cover, url(data:image/png;base64,iVBORw0KGgo=) }',
  'li:nth-child(2n + 1 of .item) { color: red } ::-webkit-scrollbar { width: 0 } a:hovr { color: red }',
  '/* comment */ a { color: red; ; } /* another */',
  '@page { margin: 1cm; @top-center { content: "Draft" } }',
  "@property --x { syntax: '<length>'; inherits: false; initial-value: 0px }",
  '@container card (min-width: 20rem) { .title { font-size: 2rem } }',
  'a{color:red}@media print{a{color:black}}',
  'a { color: }'
];

describe('custom CSS', () => {
  it('keeps a stylesheet of rules and at-rules, as written', () => {
    for (const css of GOOD_CSS) expect(globalCssProblem(css), css).toBeNull();
  });

  it('keeps only what the website’s build can read: everything it keeps, lightningcss minifies', () => {
    // Vite's build minifies CSS with lightningcss, and stops at anything it cannot parse.
    for (const css of GOOD_CSS) expect(() => transform({ filename: 'global.css', code: Buffer.from(css), minify: true }), css).not.toThrow();
  });

  it('refuses what would stop the build or break from other pages, saying where', () => {
    const cases: Array<[string, RegExp]> = [
      ['a { color: red } }', /closes nothing/],
      ['a { color }', /needs a colon/],
      ['a > > b { color: red }', /follows another combinator/],
      ['a { *zoom: 1 }', /not a property name/],
      ['a { color: red !importantx }', /!important/],
      ['a { color: red ! important ! }', /!important/],
      ['a, { color: red }', /empty selector/],
      ['{ color: red }', /empty selector/],
      ['a!!b { color: red }', /cannot be in a selector/],
      ['a { color: red', /never closed with \}/],
      ['@media screen { a { color: red }', /never closed with \}/],
      ['a { color: red } /* open', /never closed with \*\//],
      ['a { content: "open }', /line without its closing quote|never closed with its quote/],
      ['color: red;', /declaration with no rule/],
      ['@import url("https://fonts.googleapis.com/css2?family=Inter");', /@import/],
      ['a { background: url(images/x.png) }', /url\(images\/x.png\)/],
      ['a { background: url("http://example.com/x.png") }', /https:/],
      ['a:is() { color: red }', /needs a selector/],
      ['> a { color: red }', /cannot start with/],
      ['a > { color: red }', /cannot end with a combinator/],
      ['@keyframes k { 50 { opacity: 0 } }', /not a keyframe/],
      ['a[href=] { color: red }', /attribute selector/],
      ['a { color: red; } ; b { color: blue }', /ends nothing/],
      ['a { color: red }</style><script>alert(1)</script>', /cannot be in a selector/],
      ['@ { }', /needs a name/],
      ['a { b { c } }', /needs a colon/]
    ];
    for (const [css, message] of cases) expect(globalCssProblem(css)?.message, css).toMatch(message);
    expect(globalCssProblem('a { color: red }\n\nb {\n  color red;\n}')).toMatchObject({ line: 4, column: 3 });
  });

  it('refuses each stylesheet that stops lightningcss, the build’s minifier', () => {
    for (const css of ['a > > b{color:red}', 'a{*zoom:1}', 'a{color: red !importantx}', 'a!!b{color:red}', 'a,{color:red}', 'a{color:red;}}', 'a{color}']) {
      expect(() => transform({ filename: 'global.css', code: Buffer.from(css), minify: true }), css).toThrow();
      expect(globalCssProblem(css), css).not.toBeNull();
    }
  });
});

describe('site.update', () => {
  it('keeps the head code and CSS exactly as typed, and space alone removes them', () => {
    let s = run(fresh(), { type: 'site.update', headCode: GA, globalCss: 'body { margin: 0 }  \n' });
    expect(s.site.headCode).toBe(GA);
    expect(s.site.globalCss).toBe('body { margin: 0 }  \n');
    s = run(s, { type: 'site.update', headCode: '  \n', globalCss: '' });
    expect(Object.hasOwn(s.site, 'headCode')).toBe(false);
    expect(Object.hasOwn(s.site, 'globalCss')).toBe(false);
  });

  it('refuses code that does not pass its check, saying where, and changes nothing in the batch', () => {
    const s = fresh();
    expect(refusal(s, { type: 'site.update', headCode: '<meta name="a" content="b">\n<div>' })).toBe('Head code, line 2, column 1: <div> cannot go in the head. Head code holds only <meta>, <link>, <script> and <style> elements, and comments.');
    expect(refusal(s, { type: 'site.update', globalCss: 'a {\n  color red;\n}' })).toMatch(/^Custom CSS, line 2, column 3: “color” needs a colon/);
    expect(() => applyOperations(s, [{ type: 'site.update', name: 'Renamed' }, { type: 'site.update', globalCss: 'a {' }])).toThrow();
    expect(s.site.name).toBe('Riverside Studio');
  });

  it('adds, changes and removes Fathom Analytics by its site ID, keeping integrations only while one is added', () => {
    let s = run(fresh(), { type: 'site.update', integrations: { fathom: { siteId: '  ABCDEFGH ' } } });
    expect(s.site.integrations).toEqual({ fathom: { siteId: 'ABCDEFGH' } });
    expect(addedIntegrations(s.site)).toEqual(['fathom']);
    // An update that leaves the integrations out leaves them alone.
    s = run(s, { type: 'site.update', name: 'Riverside' });
    expect(fathomSiteId(s.site)).toBe('ABCDEFGH');
    expect(refusal(s, { type: 'site.update', integrations: { fathom: { siteId: 'not an id!' } } })).toMatch(/^Fathom Analytics: A Fathom site ID is a short code/);
    expect(refusal(s, { type: 'site.update', integrations: { fathom: { siteId: '' } } })).toMatch(/Enter the site ID/);
    s = run(s, { type: 'site.update', integrations: { fathom: null } });
    expect(Object.hasOwn(s.site, 'integrations')).toBe(false);
    expect(addedIntegrations(s.site)).toEqual([]);
  });

  it('needs Developer mode to change the head code or CSS, and not to add an integration', () => {
    const s = fresh();
    expect(developerModeRefusal(s, [{ type: 'site.update', headCode: '<meta name="a" content="b">' }])).toMatch(/Developer mode/);
    expect(developerModeRefusal(s, [{ type: 'site.update', name: 'A' }, { type: 'site.update', globalCss: '' }])).toMatch(/Developer mode/);
    expect(developerModeRefusal(s, [{ type: 'site.update', integrations: { fathom: { siteId: 'ABCDEFGH' } } }])).toBeNull();
    expect(developerModeRefusal(s, [{ type: 'site.update', name: 'A' }])).toBeNull();
  });
});

describe('the website and the editor’s preview', () => {
  const coded = () => run(fresh(), { type: 'site.update', headCode: GA, globalCss: '.so-btn { border-radius: 0 }', integrations: { fathom: { siteId: 'ABCDEFGH' } } });

  it('writes the head code and integrations into the published layout alone, under SvelteKit’s production flag', () => {
    const clean = generateProject(coded()).get(LAYOUT)!;
    expect(clean).toContain(`import { dev } from '$app/env';`);
    const tags = /\{#if !dev\}\{@html ("(?:[^"\\]|\\.)*")\}\{\/if\}/.exec(clean);
    expect(tags).not.toBeNull();
    expect(JSON.parse(tags![1])).toBe(`${fathomTag('ABCDEFGH')}\n${GA}`);
    // The tags come last in the head, after everything the website writes there itself.
    expect(clean.indexOf('{#if !dev}')).toBeGreaterThan(clean.indexOf('og:site_name'));
    expect(clean.indexOf('{#if !dev}')).toBeLessThan(clean.indexOf('</svelte:head>'));
    const dev = generateProject(coded(), { instrument: true }).get(LAYOUT)!;
    expect(dev).not.toContain('googletagmanager');
    expect(dev).not.toContain('usefathom');
    expect(dev).not.toContain('$app/env');
    // A site without any says nothing of it.
    expect(generateProject(fresh()).get(LAYOUT)).not.toContain('$app/env');
  });

  it('compiles, with the markup kept as data however it is written', () => {
    const s = run(fresh(), { type: 'site.update', headCode: '<script>if (a < b && c > d) { console.log(`{x}`, "</sty" + "le>") }</script>\n<style>body::after { content: "{@html}" }</style>' });
    const clean = generateProject(s).get(LAYOUT)!;
    for (const generate of ['server', 'client'] as const) expect(() => compile(clean, { generate, filename: '+layout.svelte' })).not.toThrow();
    const literal = /\{@html ("(?:[^"\\]|\\.)*")\}/.exec(clean)![1];
    expect(literal).not.toContain('<');
    expect(JSON.parse(literal)).toBe(s.site.headCode);
  });

  it('loads the custom CSS after every other stylesheet, in the website and the preview', () => {
    for (const opts of [{}, { instrument: true }]) {
      const files = generateProject(coded(), opts);
      const layout = files.get(LAYOUT)!;
      expect(layout.indexOf(`styles/${GLOBAL_CSS_FILE}'`)).toBeGreaterThan(layout.indexOf(`styles/site.css'`));
      expect(files.get(CSS_FILE)).toMatch(/^\/\* The site's own CSS, from Site settings > Custom code[^\n]*\*\/\n\.so-btn \{ border-radius: 0 \}\n$/);
    }
    // Without any, the file is there with its first line alone, so adding some changes no import.
    expect(generateProject(fresh()).get(CSS_FILE)).toMatch(/^\/\*[^\n]*\*\/\n$/);
  });

  it('leaves out, and reports, code or an integration a hand edit left unusable', () => {
    const s = fresh();
    s.site.headCode = '<div>broken</div>';
    s.site.globalCss = 42 as unknown as string;
    s.site.integrations = { fathom: { siteId: '???' } };
    expect(siteHeadCode(s.site)).toBe('');
    expect(siteGlobalCss(s.site)).toBe('');
    const files = generateProject(s);
    expect(files.get(LAYOUT)).not.toContain('{@html');
    expect(files.get(CSS_FILE)).toMatch(/^\/\*[^\n]*\*\/\n$/);
    const found = validateState(s).filter((d) => d.code === 'SITE_CODE_INVALID' || d.code === 'INTEGRATION_INVALID');
    expect(found.map((d) => [d.code, d.site, d.severity])).toEqual([
      ['SITE_CODE_INVALID', 'headCode', 'warning'],
      ['SITE_CODE_INVALID', 'globalCss', 'warning'],
      ['INTEGRATION_INVALID', 'integrations.fathom', 'warning']
    ]);
    expect(found[0].message).toMatch(/^Head code, line 1, column 1: <div> cannot go in the head/);
  });

  it('makes again only the files an edit of each reaches, with the bytes of a full run', () => {
    const cache = new GenerationCache();
    const check = (state: ProjectState) => {
      const made: Record<'clean' | 'dev', string[]> = { clean: [], dev: [] };
      for (const [mode, opts] of [['clean', {}], ['dev', { instrument: true }]] as const) {
        const incremental = generateProject(state, opts, cache);
        made[mode] = cache.made.slice();
        expect([...incremental]).toEqual([...generateProject(state, opts)]);
      }
      return made;
    };
    let s = fresh();
    check(s);
    s = run(s, { type: 'site.update', globalCss: 'a { color: red }' });
    expect(check(s)).toEqual({ clean: [GLOBAL_CSS_FILE], dev: [] });
    s = run(s, { type: 'site.update', headCode: '<meta name="a" content="b">' });
    expect(check(s)).toEqual({ clean: ['layout#clean'], dev: [] });
    s = run(s, { type: 'site.update', integrations: { fathom: { siteId: 'ABCDEFGH' } } });
    expect(check(s)).toEqual({ clean: ['layout#clean'], dev: [] });
    s = run(s, { type: 'site.update', headCode: '', globalCss: '', integrations: { fathom: null } });
    expect(check(s)).toEqual({ clean: [GLOBAL_CSS_FILE, 'layout#clean'], dev: [] });
  });
});
