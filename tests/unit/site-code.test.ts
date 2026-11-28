/**
 * The site's own code and integrations (#1485): head markup and a stylesheet the author writes in Site settings, and
 * Fathom Analytics added from its site ID. What the checks keep and refuse, what `site.update` stores, what needs
 * Developer mode, and what the website and the editor's preview are each generated with.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transform } from 'lightningcss';
import postcss from 'postcss';
import { compile } from 'svelte/compiler';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { developerModeCheck, developerModeRefusal } from '@engine/developer-mode';
import { validateOperation } from '@shared/ops';
import { projectSummary } from '../../src/agent/context';
import { executeTool, SITE_CODE_READ_MAX, type ToolHost } from '../../src/agent/tools';
import { checkHeld, readField, readFields, shownField, typedText } from '../../src/renderer/src/lib/held';
import { validateState } from '@engine/validate';
import { generateProject, GLOBAL_CSS_FILE, STYLES_DIR } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { globalCssProblem, headCodeProblem, headCodeWithoutComments, HEAD_CODE_MAX, siteGlobalCss, siteHeadCode } from '@shared/site-code';
import { addedIntegrations, fathomSiteId, quietRequest } from '@shared/integrations';

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
      '<!-- a comment -->\n<!-- -->',
      '<script type="importmap">{"imports":{"x":"https://esm.sh/x"}}</script><script type="module">import x from "x";</script>',
      '<style>/* <!-- */ body { margin: 0 }</style>'
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
      ['x'.repeat(HEAD_CODE_MAX + 1), /at most/],
      // HTML reads "meta.foo" as the tag's name, an element no head holds, which would start the page's body there.
      ['<meta.foo>', /<meta\.foo> cannot go in the head/],
      ['<template></template>', /<template> cannot go in the head/],
      ['<META NAME=" VIEWPORT " content="x">', /viewport/],
      ['<meta name="view&#112;ort" content="width=800">', /viewport/],
      ['<meta name="a" content="%SVELTEKIT.body%">', /SvelteKit/],
      ['<!--->', /closes as soon as it opens/],
      ['<!-- a --!> b -->', /ends a comment early/],
      ['<meta /x>', /“\/” in a tag/],
      ['<meta name=>', /needs a value/],
      ['<link rel="x"href="/x">', /space between them/],
      ['<meta name="a>', /never closed with its "/],
      ['<script>1</script x>', /holds nothing but its name/],
      ['<style></style>Text', /Text follows <\/style>/],
      ['<script></script><!-- note -->Text', /Text cannot go in the head/]
    ];
    for (const [code, message] of cases) expect(headCodeProblem(code)?.message, code).toMatch(message);
    expect(headCodeProblem('<meta name="a" content="b">\n\n  <span>')).toMatchObject({ line: 3, column: 3 });
    // The way round "<!--" in a script works in JSON as in JavaScript.
    expect(headCodeProblem('<script type="application/ld+json">{"text":"<!-- x"}</script>')?.message).toContain('\\u003C!--');
    expect(headCodeProblem('<!-- x -->'.padEnd(HEAD_CODE_MAX, ' '))).toBeNull();
  });

  it('is written without its comments, so none can be taken for one of Svelte’s markers', () => {
    expect(headCodeWithoutComments(GA)).toBe(GA.replace('<!-- Google tag (gtag.js) -->\n', ''));
    expect(headCodeWithoutComments('<meta name="a" content="b">\n<!--1uha8ag-->\n<meta name="c" content="d">')).toBe('<meta name="a" content="b">\n<meta name="c" content="d">');
    // A comment inside a script or style is the script's own.
    expect(headCodeWithoutComments('<style>/* <!-- x --> */</style>')).toBe('<style>/* <!-- x --> */</style>');
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
  '.icon { background-image: url( https://cdn.example.com/i.svg ); font: 12px/1.5 system-ui; transition: color .2s, background-color .2s }',
  'li:nth-child(2n + 1 of .item) { color: red } ::-webkit-scrollbar { width: 0 } a:hovr { color: red }',
  '/* comment */ a { color: red; ; } /* another */',
  '@page { margin: 1cm; @top-center { content: "Draft" } }',
  "@property --x { syntax: '<length>'; inherits: false; initial-value: 0px }",
  '@container card (min-width: 20rem) { .title { font-size: 2rem } }',
  'a{color:red}@media print{a{color:black}}',
  'a { color: }',
  '.\\31 2-col { display: grid } [xlink\\:href] { fill: red } .a\\.b { color: red }',
  'a:not(/*)*/.muted) { color: red }',
  '@font-feature-values Brand { @styleset { nice-style: 1; } }',
  '.badge { background: url(https://example.org/offer!.png) }',
  '@keyframes k { entry 0%, exit 100% { opacity: 0 } 0% /* start */, 50% { opacity: .5 } }',
  'a::after { content: "one \\\r\ntwo" }',
  'a { background: image-set("/a.png" 1x, url(https://x.example/b.png) 2x) }'
];

describe('custom CSS', () => {
  it('keeps a stylesheet of rules and at-rules, as written', () => {
    for (const css of GOOD_CSS) expect(globalCssProblem(css), css).toBeNull();
  });

  it('keeps only what the website’s tools read: PostCSS (url() and @import) and lightningcss (the build’s minifier)', () => {
    for (const css of GOOD_CSS) {
      expect(() => postcss.parse(css), css).not.toThrow();
      expect(() => transform({ filename: 'global.css', code: Buffer.from(css), minify: true }), css).not.toThrow();
    }
  });

  it('is built by a website whose minifier passes over a rule it cannot read, rather than stopping', () => {
    // lightningcss reads some at-rules more strictly than any check here: a media query with a unit it does not know.
    const unreadable = '@media (min-width: 40re) { a { color: red } } b { color: blue }';
    expect(globalCssProblem(unreadable)).toBeNull();
    expect(() => transform({ filename: 'global.css', code: Buffer.from(unreadable), minify: true })).toThrow();
    expect(transform({ filename: 'global.css', code: Buffer.from(unreadable), minify: true, errorRecovery: true }).code.toString()).toContain('b{color:#00f}');
    // Vite hands the website's css.lightningcss options to its minifier.
    const config = readFileSync(join(__dirname, '../../templates/sveltekit-brochure/files/vite.config.js'), 'utf8');
    expect(config).toContain('css: { lightningcss: { errorRecovery: true } },');
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
      ['a { color: red }</style><script>alert(1)</script>', /needs a \{ block \}/],
      ['@ { }', /needs a name/],
      ['a { b { c } }', /needs a colon/],
      ['a { color: red background: blue }', /is a “;” missing/],
      ['a { background: url(https://x/y"z.png) }', /needs quotes/],
      ['a { background: url(https://x/y.png }', /never closed/],
      // PostCSS reads a colon in a [line] name as a missing semicolon, where url() makes the build run it.
      ['a { grid-template-columns: [x:y] 1fr; filter: url(#logo) }', /is a “;” missing/],
      ['a { filter: url(#logo) } /*# sourceMappingURL=data:application/json;base64,ew== */', /source map/],
      ['@namespace xlink "http://www.w3.org/1999/xlink";', /@namespace/],
      ['@charset "UTF-8"; a { color: red }', /UTF-8 already/],
      // The build moves "@import" out of a string, wherever it is.
      [".tip::before { content: '@import \"theme.css\";' }", /@import/],
      ['@im\\70ort "missing.css";', /cannot hold an escape/],
      ['a { background: image-set("icon.png" 1x) }', /in image-set\(\)/],
      ['a { background: url(https:images/logo.svg) }', /https:\/\//],
      ['svg|circle { fill: red }', /Namespaced/],
      ['@font-face { a { color: red } }', /Only declarations/],
      ['@media screen { color: red; }', /declaration with no rule|needs a \{ block \}/],
      ['@keyframes k { @media screen { } }', /Keyframes hold only/],
      ['@supports (background: url(images/x.png)) { a { color: red } }', /url\(images/],
      ['a { content: "one\ntwo" }', /end of its line/],
      ['a/* open', /never closed with \*\//],
      ['a { color: red); }', /closes nothing/],
      ['a:is(> b) { color: red }', /cannot start with/],
      ['a[data-x]b { color: red }', /type selector comes first/],
      ['a{}<!--', /HTML comment marks/],
      ['x'.repeat(65537), /at most/]
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
    // An update that leaves them out leaves them alone.
    s = run(s, { type: 'site.update', name: 'Riverside' });
    expect([s.site.headCode, s.site.globalCss]).toEqual([GA, 'body { margin: 0 }  \n']);
    s = run(s, { type: 'site.update', headCode: '  \n', globalCss: ' \t\n' });
    expect(Object.hasOwn(s.site, 'headCode')).toBe(false);
    expect(Object.hasOwn(s.site, 'globalCss')).toBe(false);
    const padded = '\n  <meta name="a" content="b">  \n';
    expect(run(fresh(), { type: 'site.update', headCode: padded }).site.headCode).toBe(padded);
  });

  it('takes the new fields only as the operation’s schema allows', () => {
    expect(validateOperation({ type: 'site.update', headCode: GA, globalCss: 'a{}', integrations: { fathom: { siteId: 'ABCDEFGH' } } }).ok).toBe(true);
    expect(validateOperation({ type: 'site.update', integrations: { fathom: null } }).ok).toBe(true);
    for (const bad of [{ headCode: 1 }, { globalCss: ['a{}'] }, { headCode: 'x'.repeat(HEAD_CODE_MAX + 1) }, { integrations: { plausible: { domain: 'x' } } }, { integrations: { fathom: { siteId: 'ABCDEFGH', extra: 1 } } }, { integrations: { fathom: { siteId: 'A'.repeat(17) } } }])
      expect(validateOperation({ type: 'site.update', ...bad }).ok, JSON.stringify(bad).slice(0, 80)).toBe(false);
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
    s = run(s, { type: 'site.update', integrations: { fathom: { siteId: 'a1B2c3D4' } } });
    expect(fathomSiteId(s.site)).toBe('a1B2c3D4');
    s = run(s, { type: 'site.update', integrations: {} });
    expect(fathomSiteId(s.site)).toBe('a1B2c3D4');
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
    // Known without walking the batch, whatever comes before the code edit.
    expect(developerModeCheck(s, [{ type: 'page.delete', pageId: 'missing' }, { type: 'site.update', globalCss: 'a{}' }])).toBe('The site’s head code and custom CSS need Developer mode.');
    expect(developerModeCheck(s, [{ type: 'site.update', integrations: { fathom: null } }])).toBeNull();
  });

  it('holds an edit typed while the AI changes the same setting, and only that one', () => {
    const s = run(fresh(), { type: 'site.update', headCode: '<meta name="a" content="b">', globalCss: 'a{}', integrations: { fathom: { siteId: 'ABCDEFGH' } } });
    const css: EditOperation = { type: 'site.update', globalCss: 'b{}' };
    const fathom: EditOperation = { type: 'site.update', integrations: { fathom: { siteId: 'HGFEDCBA' } } };
    const base = (op: EditOperation) => readFields(s, [op])!.map((r) => (r.found ? r.value : undefined));
    expect(checkHeld(run(s, { type: 'site.update', headCode: '' }), [css], base(css)).kind).toBe('apply');
    expect(checkHeld(run(s, { type: 'site.update', globalCss: 'c{}' }), [css], base(css)).kind).toBe('changed');
    expect(checkHeld(run(s, { type: 'site.update', globalCss: 'c{}' }), [fathom], base(fathom)).kind).toBe('apply');
    expect(checkHeld(run(s, { type: 'site.update', integrations: { fathom: null } }), [fathom], base(fathom)).kind).toBe('changed');
    // The conflict says what each holds: the ID typed, and the one saved meanwhile.
    expect(typedText(fathom)).toBe('HGFEDCBA');
    const now = readField(run(s, { type: 'site.update', integrations: { fathom: { siteId: 'ZZZZZZZZ' } } }), fathom)!;
    expect(now.found && shownField(fathom, now.value)).toBe('ZZZZZZZZ');
  });
});

describe('the AI', () => {
  const host = (state: ProjectState) => ({ state: () => state, revision: () => 7 }) as unknown as ToolHost;

  it('is told how much code the site has and which integrations, and reads the code whole, alone', async () => {
    const s = run(fresh(), { type: 'site.update', headCode: GA, globalCss: 'a { color: red }', integrations: { fathom: { siteId: 'ABCDEFGH' } } });
    expect(projectSummary(s, 1).site.siteCode).toEqual({ headCode: { characters: GA.length }, globalCss: { characters: 16 }, integrations: { fathom: { siteId: 'ABCDEFGH' } } });
    expect(projectSummary(fresh(), 1).site).not.toHaveProperty('siteCode');
    const read = (await executeTool('read_project', JSON.stringify({ sections: ['siteCode'] }), host(s), 'c1')).content as Record<string, unknown>;
    expect(read).toEqual({ ok: true, revision: 7, siteCode: { headCode: GA, globalCss: 'a { color: red }' } });
  });

  it('never replaces code longer than it can read whole', async () => {
    const long = `/* ${'x'.repeat(SITE_CODE_READ_MAX)} */ a { color: red }`;
    const s = run(fresh(), { type: 'site.update', globalCss: long });
    const read = (await executeTool('read_project', JSON.stringify({ sections: ['siteCode'] }), host(s), 'c1')).content as { siteCode: { globalCss: { characters: number } } };
    expect(read.siteCode.globalCss.characters).toBe(long.length);
    const replaced = (await executeTool('apply_operations', JSON.stringify({ expectedRevision: 7, operations: [{ type: 'site.update', globalCss: 'a{}' }] }), host(s), 'c2')).content as { error?: { message: string } };
    expect(replaced.error?.message).toMatch(/^The site's custom CSS is \d+ characters, more than a run reads whole/);
  });
});

describe('Builder’s own hidden windows', () => {
  it('load no integration’s code and send no beacon, and everything else', () => {
    expect(quietRequest('https://cdn.usefathom.com/script.js', 'script')).toBe(true);
    expect(quietRequest('https://cdn.usefathom.com/?h=x', 'image')).toBe(true);
    expect(quietRequest('https://www.google-analytics.com/g/collect', 'ping')).toBe(true);
    expect(quietRequest('https://fonts.googleapis.com/css2?family=Inter', 'stylesheet')).toBe(false);
    expect(quietRequest('not a url', 'script')).toBe(false);
  });
});

describe('the website and the editor’s preview', () => {
  const coded = () => run(fresh(), { type: 'site.update', headCode: GA, globalCss: '.so-btn { border-radius: 0 }', integrations: { fathom: { siteId: 'ABCDEFGH' } } });

  it('writes the head code and integrations into the published layout alone, under SvelteKit’s production flag', () => {
    const clean = generateProject(coded()).get(LAYOUT)!;
    expect(clean).toContain(`import { dev } from '$app/env';`);
    const tags = /\{#if !dev\}\{@html ("(?:[^"\\]|\\.)*")\}\{\/if\}/.exec(clean);
    expect(tags).not.toBeNull();
    // Fathom's script, following page changes made without a reload, then the head code without its comment.
    expect(JSON.parse(tags![1])).toBe(`<script src="https://cdn.usefathom.com/script.js" data-site="ABCDEFGH" data-spa="auto" defer></script>\n${GA.replace('<!-- Google tag (gtag.js) -->\n', '')}`);
    // The tags come last in the head, after everything the website writes there itself.
    expect(clean.indexOf('{#if !dev}')).toBeGreaterThan(clean.indexOf('og:site_name'));
    expect(clean.indexOf('{#if !dev}')).toBeLessThan(clean.indexOf('</svelte:head>'));
    expect(clean).toMatch(/\{#if !dev\}\{@html [^\n]*\}\{\/if\}\n<\/svelte:head>/);
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
      const styles = [...layout.matchAll(/import '\.\.\/lib\/siteorigin\/styles\/([^']+)';/g)].map((m) => m[1]);
      expect(styles).toEqual(['tokens.css', 'theme.css', 'components.css', 'site.css', GLOBAL_CSS_FILE]);
      expect(files.get(CSS_FILE)).toMatch(/^\/\* The site's own CSS, from Site settings > Custom code[^\n]*\*\/\n\.so-btn \{ border-radius: 0 \}\n$/);
    }
    // Without any, the file is there with its first line alone, so adding some changes no import.
    expect(generateProject(fresh()).get(CSS_FILE)).toMatch(/^\/\*[^\n]*\*\/\n$/);
    expect(generateProject(fresh()).get(LAYOUT)).toContain(`import '../lib/siteorigin/styles/${GLOBAL_CSS_FILE}';`);
    // The author's CSS as typed, padding and all, with one line break at its end.
    const padded = run(fresh(), { type: 'site.update', globalCss: '\n  a { color: red }  \n' });
    expect(generateProject(padded).get(CSS_FILE)!.split('\n').slice(1).join('\n')).toBe('\n  a { color: red }  \n');
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

  it('reports each unusable shape on its own, and nothing for usable, blank or absent settings', () => {
    const codes = (edit: (s: ProjectState) => void) => {
      const s = fresh();
      edit(s);
      return validateState(s).filter((d) => d.code === 'SITE_CODE_INVALID' || d.code === 'INTEGRATION_INVALID').map((d) => `${d.code}@${d.site}`);
    };
    expect(codes((s) => (s.site.globalCss = 'a {'))).toEqual(['SITE_CODE_INVALID@globalCss']);
    expect(codes((s) => (s.site.headCode = 5 as unknown as string))).toEqual(['SITE_CODE_INVALID@headCode']);
    for (const bad of ['x', 3, null, []]) expect(codes((s) => (s.site.integrations = bad as never)), JSON.stringify(bad)).toEqual(['INTEGRATION_INVALID@integrations']);
    for (const bad of [null, 'x', {}, { siteId: 1 }, { siteId: '   ' }]) expect(codes((s) => (s.site.integrations = { fathom: bad } as never)), JSON.stringify(bad)).toEqual(['INTEGRATION_INVALID@integrations.fathom']);
    expect(codes((s) => Object.assign(s.site, { headCode: '<meta name="a" content="b">', globalCss: '  ', integrations: { fathom: { siteId: 'ABCDEFGH' } } }))).toEqual([]);
    expect(codes(() => undefined)).toEqual([]);
    // A usable field is still written beside one that is not.
    const mixed = fresh();
    Object.assign(mixed.site, { headCode: '<div>', globalCss: 'a { color: red }' });
    expect(generateProject(mixed).get(CSS_FILE)).toContain('a { color: red }');
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
