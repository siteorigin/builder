import { describe, expect, it } from 'vitest';
import { checkSvelteSource, type CheckOptions } from '../../src/main/codecheck';
import { fixComponentSource } from '@agent/fixer';
import type { AgentModelAdapter, ModelEvent } from '@agent/types';

const GOOD = `<script>\n\tlet { heading = 'Hi' } = $props();\n\tlet n = $state(0);\n</script>\n\n<h2>{heading}</h2>\n<button type="button" onclick={() => n++}>{n}</button>\n`;

describe('code safety checks', () => {
  it('accepts a normal runes component', async () => {
    expect((await checkSvelteSource(GOOD)).filter((p) => p.severity === 'error')).toEqual([]);
  });
  it('rejects syntax errors, unknown packages, raw HTML and eval', async () => {
    const syntax = await checkSvelteSource('<p>{oops</p>');
    expect(syntax[0]).toMatchObject({ severity: 'error' });
    const pkg = await checkSvelteSource(`<script>import confetti from 'canvas-confetti';</script>\n<p>x</p>`);
    expect(pkg.some((p) => p.message.includes('canvas-confetti'))).toBe(true);
    const html = await checkSvelteSource(`<script>let { body = '' } = $props();</script>\n{@html body}`);
    expect(html.some((p) => p.message.includes('Raw HTML'))).toBe(true);
    expect((await checkSvelteSource(`<script>eval('1')</script><p>x</p>`)).some((p) => p.message.includes('eval'))).toBe(true);
  });
  it('warns about browser globals outside onMount', async () => {
    const r = await checkSvelteSource(`<script>const w = window.innerWidth;</script>\n<p>{w}</p>`);
    expect(r.some((p) => p.message.startsWith('Browser-only'))).toBe(true);
  });
});

class ScriptedFixer implements AgentModelAdapter {
  calls = 0;
  constructor(private replies: string[]) {}
  capabilities() {
    return { toolCalling: 'native' as const, streaming: true, strictSchemas: false, parallelToolCalls: false, contextWindowTokens: 1, maxOutputTokens: 1 };
  }
  async *streamTurn(): AsyncIterable<ModelEvent> {
    const text = this.replies[this.calls++] ?? '';
    yield { type: 'done', stopReason: 'end', text, toolCalls: [] };
  }
}

describe('code-fixing agent', () => {
  it('returns a fixed component only when it passes the checks', async () => {
    const adapter = new ScriptedFixer(['Closed the expression.\n```svelte\n' + GOOD + '```']);
    const r = await fixComponentSource(adapter, 'fake', '<p>{oops</p>', checkSvelteSource, new AbortController().signal);
    expect(r.ok).toBe(true);
    expect(r.source).toContain('$props()');
    expect(r.explanation).toBe('Closed the expression.');
  });
  it('gives up after its attempts when the fix is still broken', async () => {
    const adapter = new ScriptedFixer(['Tried.\n```svelte\n<p>{still</p>\n```', 'Again.\n```svelte\n{@html x}\n```']);
    const r = await fixComponentSource(adapter, 'fake', '<p>{oops</p>', checkSvelteSource, new AbortController().signal);
    expect(r.ok).toBe(false);
    expect(adapter.calls).toBe(2);
  });
});

describe('strict policy for AI-written code', () => {
  it('rejects network, process and dynamic loading only in strict mode', async () => {
    const src = `<script>\n\timport { onMount } from 'svelte';\n\tonMount(() => { fetch('https://example.com'); });\n</script>\n<p>x</p>\n`;
    expect((await checkSvelteSource(src)).filter((p) => p.severity === 'error')).toEqual([]);
    expect((await checkSvelteSource(src, { strict: true })).some((p) => p.message.includes('network'))).toBe(true);
    expect((await checkSvelteSource(`<script>const m = import('./x.js');</script><p>x</p>`, { strict: true })).some((p) => p.message.includes('dynamic'))).toBe(true);
    expect((await checkSvelteSource(GOOD, { strict: true })).filter((p) => p.severity === 'error')).toEqual([]);
  });
});

describe('syntax-tree code checks', () => {
  const errors = async (src: string, strict = false) => (await checkSvelteSource(src, { strict })).filter((p) => p.severity === 'error');

  it('never mistakes prose for code', async () => {
    const prose = `<script>\n\tlet { heading = 'Our Process' } = $props();\n</script>\n\n<h2>{heading}</h2>\n<p>Our process is simple. We import ideas from 'everywhere' and fetch(coffee) first.</p>\n<p>window, document and require() are just words here.</p>\n`;
    expect(await errors(prose, true)).toEqual([]);
    expect((await checkSvelteSource(prose, { strict: true })).filter((p) => p.message.startsWith('Browser-only'))).toEqual([]);
  });

  it('catches imports split over several lines and re-exports', async () => {
    const multi = `<script>\n\timport {\n\t\treadFileSync\n\t} from 'node:fs';\n</script>\n<p>x</p>\n`;
    expect((await errors(multi)).some((p) => p.message.includes('"node:fs"') && p.line === 2)).toBe(true);
    const star = `<script>\n\texport * from 'node:child_process';\n</script>\n<p>x</p>\n`;
    expect((await errors(star)).some((p) => p.message.includes('node:child_process'))).toBe(true);
  });

  it('allows relative imports inside src/lib and $lib, but not traversal out of it', async () => {
    const imp = (spec: string) => `<script>\n\timport X from '${spec}';\n</script>\n<X />\n`;
    expect(await errors(imp('./Card.svelte'))).toEqual([]);
    expect(await errors(imp('../runtime/Link.svelte'))).toEqual([]);
    expect(await errors(imp('$lib/siteorigin/runtime/Image.svelte'))).toEqual([]);
    expect((await errors(imp('../../../../../../etc/passwd'))).length).toBeGreaterThan(0);
    expect((await errors(imp('../../../routes/+page.svelte'))).length).toBeGreaterThan(0);
    expect((await errors(imp('$lib/../../vite.config.js'))).length).toBeGreaterThan(0);
    expect((await errors(imp('$app/server'))).length).toBeGreaterThan(0);
    expect((await errors(imp('$env/static/private'))).length).toBeGreaterThan(0);
  });

  it('rejects Function and constructor tricks in every mode', async () => {
    expect((await errors(`<script>\n\tFunction('return 1')();\n</script>\n<p>x</p>`)).some((p) => p.message.includes('Function'))).toBe(true);
    expect((await errors(`<script>\n\t[].constructor.constructor('return 1')();\n</script>\n<p>x</p>`)).length).toBeGreaterThan(0);
    expect((await errors(`<script>\n\tsetTimeout('alert(1)', 10);\n</script>\n<p>x</p>`)).length).toBeGreaterThan(0);
  });

  it('holds the assistant to the strict policy with syntax, not words', async () => {
    const reached = async (body: string) => (await errors(`<script>\n\timport { onMount } from 'svelte';\n\tonMount(() => { ${body} });\n</script>\n<p>x</p>\n`, true)).length > 0;
    expect(await reached(`window['fe' + 'tch']('/x');`)).toBe(true);
    expect(await reached(`navigator.sendBeacon('/x', '');`)).toBe(true);
    expect(await reached(`const p = process.env;`)).toBe(true);
    expect(await reached(`const f = [].constructor;`)).toBe(true);
    expect(await reached(`const g = globalThis;`)).toBe(true);
    expect(await reached(`const u = import.meta.glob('/**');`)).toBe(true);
    expect(await reached(`const w = window.innerWidth;`)).toBe(false);
    expect(await reached(`const o = { process: 1, fetch: 2 }; o.process;`)).toBe(false);
    // A computed element tag could spell out an iframe.
    expect((await errors(`<script>\n\tlet t = 'ifr' + 'ame';\n</script>\n<svelte:element this={t} src="https://example.com" />\n`, true)).some((p) => p.message.includes('computed'))).toBe(true);
    expect(await errors(`<svelte:element this={'section'}>x</svelte:element>\n`, true)).toEqual([]);
    expect((await errors(`<svelte:element this="iframe" />\n`, true)).length).toBeGreaterThan(0);
    expect((await errors(`<iframe title="map" src="https://example.com"></iframe>\n`, true)).length).toBeGreaterThan(0);
    expect((await errors(`<a href="javascript:alert(1)">x</a>\n`, true)).length).toBeGreaterThan(0);
    // A developer may embed a video.
    expect(await errors(`<iframe title="video" src="https://example.com"></iframe>\n`)).toEqual([]);
  });

  it('only warns about browser objects touched while the page renders', async () => {
    const later = `<script>\n\timport { onMount } from 'svelte';\n\tlet w = $state(0);\n\tonMount(() => { w = window.innerWidth; });\n\tconst ok = typeof window !== 'undefined';\n</script>\n<button onclick={() => document.body.focus()}>{w}{ok}</button>\n`;
    expect((await checkSvelteSource(later)).filter((p) => p.message.startsWith('Browser-only'))).toEqual([]);
    const now = `<p>{window.innerWidth}</p>\n`;
    expect((await checkSvelteSource(now)).some((p) => p.message.startsWith('Browser-only'))).toBe(true);
  });

  it('closes aliasing, destructuring, DOM and remote-content routes in strict mode', async () => {
    const reached = async (body: string) => (await errors(`<script>\n\timport { onMount } from 'svelte';\n\tonMount(() => { ${body} });\n</script>\n<p>x</p>\n`, true)).length > 0;
    expect(await reached(`const p = global.process;`)).toBe(true);
    expect(await reached(`const { fetch: f } = window;`)).toBe(true);
    expect(await reached(`const w = window; w['fe' + 'tch']('/x');`)).toBe(true);
    expect(await reached(`const e = window.eval;`)).toBe(true);
    expect(await reached(`const { constructor: C } = [];`)).toBe(true);
    expect(await reached(`document.createElement('iframe');`)).toBe(true);
    expect(await reached(`document.body.innerHTML = '<p>x</p>';`)).toBe(true);
    expect(await reached(`new Image().src = 'https://tracker.example/p.gif';`)).toBe(true);
    expect(await reached(`const data = { fetch: 1, process: 2 }; const n = data.fetch + data.process;`)).toBe(false);
    const strictErrors = (src: string) => errors(src, true);
    expect((await strictErrors(`<img src="https://tracker.example/p.gif" alt="" />\n`)).length).toBeGreaterThan(0);
    expect((await strictErrors(`<form action="https://collect.example/"><button>Go</button></form>\n`)).length).toBeGreaterThan(0);
    expect((await strictErrors(`<svelte:head><link rel="stylesheet" href="https://cdn.example/x.css" /></svelte:head>\n`)).length).toBeGreaterThan(0);
    expect((await strictErrors(`<p>x</p>\n<style>\n\t@import url('https://cdn.example/x.css');\n</style>\n`)).length).toBeGreaterThan(0);
    expect((await strictErrors(`<p style="background: url(https://cdn.example/x.png)">x</p>\n`)).length).toBeGreaterThan(0);
    expect((await strictErrors(`<a href={'javascript:alert(1)'}>x</a>\n`)).length).toBeGreaterThan(0);
    expect((await strictErrors(`<script>\n\tlet { rest } = $props();\n</script>\n<div {...rest}>x</div>\n`)).length).toBeGreaterThan(0);
    expect((await strictErrors(`<script>\n\timport x from '../../../app.js';\n</script>\n<p>{x}</p>\n`)).length).toBeGreaterThan(0);
    // Links to other sites, the project's own images and the generated runtime are fine.
    expect(await strictErrors(`<script>\n\timport Image from '../runtime/Image.svelte';\n</script>\n<a href="https://example.com">Visit</a>\n<img src="/assets/logo.png" alt="Logo" />\n<p title="javascript: the language">x</p>\n<style>\n\tp { background: url('/assets/bg.png'); }\n</style>\n`)).toEqual([]);
  });

  it('closes renamed evaluators, srcset candidates, style directives and custom element options', async () => {
    expect((await errors(`<script>\n\timport { onMount } from 'svelte';\n\tonMount(() => window.eval('1'));\n</script>\n<p>x</p>\n`)).some((p) => p.message.includes('eval'))).toBe(true);
    const strictErrors = (src: string) => errors(src, true);
    expect((await strictErrors(`<script>\n\timport { onMount } from 'svelte';\n\tonMount(() => { const i = new window.Image(); });\n</script>\n<p>x</p>\n`)).length).toBeGreaterThan(0);
    expect((await strictErrors(`<img srcset="/assets/a.png 1x, https://tracker.example/b.png 2x" alt="" />\n`)).length).toBeGreaterThan(0);
    expect((await strictErrors(`<p style:background-image="url(https://cdn.example/x.png)">x</p>\n`)).length).toBeGreaterThan(0);
    expect((await strictErrors(`<svelte:options customElement={{ tag: 'x-card', extend: (C) => C }} />\n<p>x</p>\n`)).length).toBeGreaterThan(0);
    expect(await strictErrors(`<svelte:element this={'a'} href="https://example.com">Visit</svelte:element>\n`)).toEqual([]);
  });

  it('treats browser guards as browser-only code', async () => {
    const guarded = `<script>\n\timport { browser } from '$app/environment';\n\tconst w = browser ? window.innerWidth : 0;\n\tif (browser) document.title = 'x';\n</script>\n{#if browser}<p>{window.location.pathname}</p>{/if}\n<p>{w}</p>\n`;
    expect((await checkSvelteSource(guarded)).filter((p) => p.message.startsWith('Browser-only'))).toEqual([]);
  });

  it('rejects module scripts and dynamic import of unknown modules', async () => {
    expect((await errors(`<script module>\n\texport const x = 1;\n</script>\n<p>x</p>`)).some((p) => p.message.includes('Module scripts'))).toBe(true);
    expect((await errors(`<script>\n\tconst name = 'node:fs';\n\tconst m = import(name);\n</script>\n<p>x</p>`)).length).toBeGreaterThan(0);
    expect(await errors(`<script>\n\tconst m = import('./Card.svelte');\n</script>\n<p>x</p>`)).toEqual([]);
  });
});

describe('strict policy follows values and imports', () => {
  const strictErrors = async (src: string, opts: CheckOptions = {}) => (await checkSvelteSource(src, { strict: true, ...opts })).filter((p) => p.severity === 'error');
  const script = (body: string, markup: string) => `<script>\n\timport { onMount } from 'svelte';\n${body}\n</script>\n${markup}\n`;

  it('refuses remote URLs held in variables, props, arrays and objects', async () => {
    const remote = async (body: string, markup: string) => (await strictErrors(script(body, markup))).some((p) => /remote/.test(p.message));
    expect(await remote(`\tconst u = 'https://cdn.example/x.png';`, `<img src={u} alt="" />`)).toBe(true);
    expect(await remote(`\tlet { image = 'https://cdn.example/a.png' } = $props();`, `<img src={image} alt="" />`)).toBe(true);
    expect(await remote(`\tconst pics = [{ src: 'https://cdn.example/a.png', alt: '' }];`, `{#each pics as p}<img src={p.src} alt={p.alt} />{/each}`)).toBe(true);
    expect(await remote(`\tconst pics = [{ src: 'https://cdn.example/a.png' }];`, `{#each pics as { src }}<img {src} alt="" />{/each}`)).toBe(true);
    expect(await remote(`\tconst host = 'https://cdn.example';`, `<img src={host + '/a.png'} alt="" /><img src={\`\${host}/b.png\`} alt="" />`)).toBe(true);
    expect(await remote(`\tlet wide = $state(false);`, `<img src={wide ? 'https://cdn.example/a.png' : '/assets/a.png'} alt="" />`)).toBe(true);
    expect(await remote(`\tconst u = $derived('https://cdn.example/x.png');`, `<video poster={u}></video>`)).toBe(true);
    expect(await remote(`\tconst pick = () => 'https://cdn.example/x.png';`, `<img src={pick()} alt="" />`)).toBe(true);
    expect(await remote(`\tconst urls = ['a.png', 'b.png'].map((f) => 'https://cdn.example/' + f);`, `{#each urls as u}<img src={u} alt="" />{/each}`)).toBe(true);
    expect(await remote(`\tconst big = 'https://cdn.example/b.png';`, `<img srcset="/assets/a.png 1x, {big} 2x" alt="" />`)).toBe(true);
  });

  it('refuses remote URLs reached through style values and elements bound in code', async () => {
    const refused = async (body: string, markup: string) => (await strictErrors(script(body, markup))).length > 0;
    expect(await refused(`\tconst bg = 'https://cdn.example/bg.png';`, `<section style="background-image: url({bg})">x</section>`)).toBe(true);
    expect(await refused(`\tconst bg = 'https://cdn.example/bg.png';`, `<section style:background-image={\`url(\${bg})\`}>x</section>`)).toBe(true);
    expect(await refused(`\tconst u = 'https://tracker.example/p.gif';\n\tlet img;\n\tonMount(() => { img.src = u; });`, `<img bind:this={img} alt="" />`)).toBe(true);
    expect(await refused(`\tconst u = 'https://tracker.example/p.gif';\n\tlet img;\n\tonMount(() => img.setAttribute('src', u));`, `<img bind:this={img} alt="" />`)).toBe(true);
    expect(await refused(`\tconst bg = 'url(https://cdn.example/bg.png)';\n\tlet el;\n\tonMount(() => { el.style.backgroundImage = bg; });`, `<div bind:this={el}>x</div>`)).toBe(true);
    // A script URL is refused wherever it comes from, links included.
    expect(await refused(`\tconst go = 'javascript:alert(1)';`, `<a href={go}>x</a>`)).toBe(true);
  });

  it('accepts prose, local assets, props it cannot see and links held in variables', async () => {
    const ok = async (body: string, markup: string) => strictErrors(script(body, markup));
    expect(await ok(`\tconst note = 'https://example.com is where we started.';`, `<p>Visit https://example.com or //cdn.example for more. {note}</p>`)).toEqual([]);
    expect(await ok(`\tconst logo = '/assets/logo.png';\n\tconst pics = [{ src: '/assets/a.png' }, { src: '/assets/b.png' }];`, `<img src={logo} alt="Logo" />{#each pics as p}<img src={p.src} alt="" />{/each}`)).toEqual([]);
    expect(await ok(`\tlet { image, background } = $props();`, `<img src={image} alt="" /><section style="background-image: url({background})">x</section>`)).toEqual([]);
    expect(
      await ok(
        `\tconst site = 'https://example.com';\n\tconst links = [{ href: 'https://social.example/me', label: 'Social', icon: '/assets/social.svg' }];`,
        `<a href={site}>Home</a>{#each links as l}<a href={l.href}><img src={l.icon} alt="" />{l.label}</a>{/each}`
      )
    ).toEqual([]);
  });

  it('follows helpers, positions, shorthand styles and the elements code holds', async () => {
    const refused = async (body: string, markup: string) => (await strictErrors(script(body, markup))).length > 0;
    // A helper given a remote URL sets it on a bound image.
    expect(await refused(`\tlet img;\n\tfunction show(url) { img.src = url; }\n\tonMount(() => show('https://cdn.example/x.png'));`, `<img bind:this={img} alt="" />`)).toBe(true);
    // A list grown through its own spread, by a helper given a remote URL; growing it with local images is fine.
    const gallery = (arg: string) => `\tlet slides = $state(['/assets/a.png']);\n\tfunction add(next) { slides = [...slides, next]; }\n\tonMount(() => add('${arg}'));`;
    expect(await refused(gallery('https://cdn.example/b.png'), `{#each slides as s}<img src={s} alt="" />{/each}`)).toBe(true);
    expect(await refused(gallery('/assets/b.png'), `{#each slides as s}<img src={s} alt="" />{/each}`)).toBe(false);
    // A written-out position is that element alone; past the cap a remote URL still counts.
    expect(await refused(`\tconst pair = ['/assets/a.png', 'https://example.com'];`, `<img src={pair[0]} alt="" /><a href={pair[1]}>Site</a>`)).toBe(false);
    const many = [...Array.from({ length: 70 }, (_, i) => `'/assets/${i}.png'`), `'https://cdn.example/last.png'`].join(', ');
    expect(await refused(`\tconst pics = [${many}];`, `{#each pics as p}<img src={p} alt="" />{/each}`)).toBe(true);
    // style:background reads the variable of that name; style.setProperty is CSS too.
    expect(await refused(`\tconst background = 'url(https://cdn.example/bg.png)';`, `<div style:background>x</div>`)).toBe(true);
    expect(await refused(`\tconst bg = 'url(https://cdn.example/bg.png)';\n\tlet el;\n\tonMount(() => el.style.setProperty('background-image', bg));`, `<div bind:this={el}>x</div>`)).toBe(true);
    // An SVG image loads its href; a bound link only opens it.
    expect(await refused(`\tconst u = 'https://cdn.example/x.png';\n\tlet pic;\n\tonMount(() => pic.setAttribute('href', u));`, `<svg><image bind:this={pic} /></svg>`)).toBe(true);
    expect(await refused(`\tconst site = 'https://example.com';\n\tlet link;\n\tonMount(() => { link.href = site; });`, `<a bind:this={link}>Site</a>`)).toBe(false);
    // An item read through map counts, as does a URL found at the end of a long chain of names.
    expect(await refused(`\tconst urls = [{ url: 'https://cdn.example/x.png' }].map((p) => p.url);`, `{#each urls as u}<img src={u} alt="" />{/each}`)).toBe(true);
    const chain = Array.from({ length: 30 }, (_, i) => `\tconst a${i + 1} = a${i};`).join('\n');
    expect(await refused(`\tconst a0 = 'https://cdn.example/hero.png';\n${chain}`, `<img src={a30} alt="" /><img src={a0} alt="" />`)).toBe(true);
    // A list reached through a long chain first is still read in full when it is read directly.
    const listChain = Array.from({ length: 22 }, (_, i) => `\tconst a${i + 1} = a${i};`).join('\n');
    expect(await refused(`\tconst a0 = [{ src: 'https://cdn.example/a.png' }];\n${listChain}`, `<img src={a22[0].src} alt="" /><img src={a0[0].src} alt="" />`)).toBe(true);
    // Array methods move positions; every object counts, however long the list.
    expect(await refused(`\tconst pics = ['/assets/a.png', 'https://cdn.example/b.png'];`, `<img src={pics.slice(1)[0]} alt="" />`)).toBe(true);
    const objects = [...Array.from({ length: 70 }, (_, i) => `{ src: '/assets/${i}.png' }`), `{ src: 'https://cdn.example/last.png' }`].join(', ');
    expect(await refused(`\tconst pics = [${objects}];`, `{#each pics as p}<img src={p.src} alt="" />{/each}`)).toBe(true);
    // An SVG image's href set through its baseVal.
    expect(await refused(`\tconst u = 'https://cdn.example/x.png';\n\tlet pic;\n\tonMount(() => { pic.href.baseVal = u; });`, `<svg><image bind:this={pic} /></svg>`)).toBe(true);
  });

  it('stays bounded on values that grow, and reads each call with its own arguments', async () => {
    const errorsOf = (body: string, markup: string) => strictErrors(script(body, markup));
    // Every level doubles the text the check could follow (unbounded, this fills a 4 GB heap); it must finish
    // quickly instead. Kept to 14 levels: Svelte's own compiler slows down the same way past about 20.
    const doubling = Array.from({ length: 14 }, (_, i) => `\tconst a${i + 1} = false ? a${i} + a${i} : 'x';`).join('\n');
    const uses = Array.from({ length: 15 }, (_, i) => `<p data-n={a${i}}>x</p>`).join('');
    const t0 = Date.now();
    expect(await errorsOf(`\tconst a0 = '${'y'.repeat(8000)}';\n${doubling}`, uses)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(10_000);
    // A chain of names that doubles the ways to reach one list, read through an object, finishes.
    const aliases = Array.from({ length: 18 }, (_, i) => `\tconst a${i + 1} = show ? a${i} : a${i};`).join('\n');
    expect(await errorsOf(`\tlet show = $state(true);\n\tconst a0 = ['/assets/logo.svg'];\n${aliases}\n\tconst box = { photos: a18 };`, `<p data-a={a8} data-b={a16}>x</p><img src={box.photos[0]} alt="" />`)).toEqual([]);
    // A helper used for a local image and for a link: the image reads only its own call.
    const identity = `\tconst site = 'https://example.com';\n\tfunction identity(x) { return x; }`;
    expect(await errorsOf(identity, `<img src={identity('/assets/logo.svg')} alt="" /><a href={identity(site)}>Site</a>`)).toEqual([]);
    expect((await errorsOf(identity, `<img src={identity(site)} alt="" />`)).length).toBe(1);
    expect(await errorsOf(`\tconst site = 'https://example.com';`, `<img src={['/assets/logo.svg', site].slice(0, 1)[0]} alt="" />`)).toEqual([]);
  }, 20_000);

  it('follows parameter defaults, functions passed by name and calls written before the function', async () => {
    const refused = async (body: string, markup: string) => (await strictErrors(script(body, markup))).length > 0;
    const bound = `<img bind:this={img} alt="" />`;
    expect(await refused(`\tconst remote = 'https://cdn.example/x.png';\n\tlet img;\n\tfunction show(url = remote) { img.src = url; }\n\tonMount(() => show());`, bound)).toBe(true);
    expect(await refused(`\tconst urls = ['https://cdn.example/x.png'];\n\tlet img;\n\tfunction show(url) { img.src = url; }\n\tonMount(() => urls.forEach(show));`, bound)).toBe(true);
    expect(await refused(`\tlet img;\n\tlet helper;\n\tfunction init() { helper('https://cdn.example/x.png'); }\n\thelper = (u) => { img.src = u; };\n\tonMount(init);`, bound)).toBe(true);
    // A remote picture at the end of a long gallery of records.
    const records = [...Array.from({ length: 320 }, (_, i) => `{ src: '/assets/${i}.png' }`), `{ src: 'https://cdn.example/last.png' }`].join(', ');
    expect(await refused(`\tconst pics = [${records}];`, `{#each pics as p}<img src={p.src} alt="" />{/each}`)).toBe(true);
  });

  it('reads a function in the scope it was written in, and keeps its parameters to itself', async () => {
    const errorsOf = (body: string, markup: string) => strictErrors(script(body, markup));
    // Two helpers with a parameter of the same name: only show() loads its argument.
    const helpers = `\tlet img;\n\tfunction show(url) { img.src = url; }\n\tfunction caption(url) { return url; }\n\tonMount(() => show('/assets/a.png'));`;
    expect(await errorsOf(helpers, `<img bind:this={img} alt="" /><p>{caption('https://example.com is where we started')}</p>`)).toEqual([]);
    // A helper written in the script returns the script's url, not the each block's.
    expect((await errorsOf(`\tconst url = 'https://cdn.example/x.png';\n\tconst pick = () => url;\n\tconst photos = ['/assets/a.png'];`, `{#each photos as url}<img src={pick()} alt={url} />{/each}`)).length).toBe(1);
  });

  it('keeps the names each block gives its items apart, and accepts image-map links', async () => {
    const ok = async (body: string, markup: string) => strictErrors(script(body, markup));
    expect(
      await ok(
        `\tconst links = ['https://social.example/me'];\n\tconst photos = ['/assets/a.png'];`,
        `{#each links as url}<a href={url}>Social</a>{/each}{#each photos as url}<img src={url} alt="" />{/each}`
      )
    ).toEqual([]);
    expect(await ok(`\tconst site = 'https://example.com';`, `<img src="/assets/map.png" alt="Map" usemap="#m" /><map name="m"><area href={site} alt="Site" coords="0,0,10,10" /></map>`)).toEqual([]);
  });

  const FETCHES = `<script>\n\timport { onMount } from 'svelte';\n\tonMount(() => { fetch('/api'); });\n</script>\n<p>map</p>\n`;
  const CLEAN = `<p>card</p>\n`;
  const DIR = 'src/lib/siteorigin/custom';
  const project = (files: Record<string, string>) => (path: string) => files[path];
  const importing = (spec: string) => `<script>\n\timport C from '${spec}';\n</script>\n<C />\n`;

  it('refuses importing a project component that breaks the policy, however far away', async () => {
    const direct = await strictErrors(importing('./Map.svelte'), { resolve: project({ [`${DIR}/Map.svelte`]: FETCHES }) });
    expect(direct.map((p) => p.message)).toEqual(['Code written by the assistant may not import "./Map.svelte", which uses network requests (line 3).']);
    // Through another component, and through $lib.
    const files = { [`${DIR}/Card.svelte`]: importing('./Map.svelte'), [`${DIR}/Map.svelte`]: FETCHES };
    expect((await strictErrors(importing('$lib/siteorigin/custom/Card.svelte'), { resolve: project(files) })).length).toBe(1);
    // A component that does not exist, or any project component when nothing can be checked.
    expect((await strictErrors(importing('./Gone.svelte'), { resolve: project({}) }))[0].message).toMatch(/not a component in this project/);
    expect((await strictErrors(importing('./Card.svelte')))[0].message).toMatch(/cannot be checked/);
    // A clean import does not hide a bad one after it.
    const both = `<script>\n\timport Card from './Card.svelte';\n\timport Map from './Map.svelte';\n</script>\n<Card /><Map />\n`;
    const two = await strictErrors(both, { resolve: project({ [`${DIR}/Card.svelte`]: CLEAN, [`${DIR}/Map.svelte`]: FETCHES }) });
    expect(two.map((p) => [p.line, p.message])).toEqual([[3, 'Code written by the assistant may not import "./Map.svelte", which uses network requests (line 3).']]);
  });

  it('judges what it passes to a project component by where that component puts it', async () => {
    const files = {
      [`${DIR}/Card.svelte`]: `<script>\n\tlet { photo, title } = $props();\n</script>\n<img src={photo} alt={title} />\n`,
      [`${DIR}/Frame.svelte`]: `<script>\n\timport Card from './Card.svelte';\n\tlet { picture } = $props();\n</script>\n<Card photo={picture} title="x" />\n`,
      [`${DIR}/Banner.svelte`]: `<script>\n\tlet props = $props();\n</script>\n<section style="background-image: url({props.bg})">x</section>\n`,
      [`${DIR}/Go.svelte`]: `<script>\n\tlet { href, label } = $props();\n</script>\n<a {href}>{label}</a>\n`,
      [`${DIR}/Pics.svelte`]: `<script>\n\tlet { images } = $props();\n</script>\n<img srcset={images} alt="" />\n`,
      [`${DIR}/Plain.svelte`]: `<p>plain</p>\n`
    };
    const use = (spec: string, name: string, attrs: string) => strictErrors(`<script>\n\timport ${name} from '${spec}';\n\tconst remote = 'https://cdn.example/x.png';\n</script>\n<${name} ${attrs} />\n`, { resolve: project(files) });
    expect((await use('./Card.svelte', 'Card', 'photo="https://cdn.example/x.png" title="x"')).length).toBe(1);
    expect((await use('./Card.svelte', 'Card', 'photo={remote} title="https://example.com is our site"')).length).toBe(1);
    expect(await use('./Card.svelte', 'Card', 'photo="/assets/x.png" title="https://example.com is our site"')).toEqual([]);
    // Through a component that passes it on, and into CSS.
    expect((await use('./Frame.svelte', 'Frame', 'picture={remote}')).length).toBe(1);
    expect((await use('./Banner.svelte', 'Banner', 'bg="https://cdn.example/bg.png"')).length).toBe(1);
    // A srcset list given to a component; a prop named like a loading attribute, whatever the component does.
    expect((await use('./Pics.svelte', 'Pics', 'images="/assets/a.png 1x, https://cdn.example/b.png 2x"')).length).toBe(1);
    expect((await use('./Plain.svelte', 'Plain', 'src="https://cdn.example/x.png"')).length).toBe(1);
    // A link component may be given any link, but not a script URL.
    expect(await use('./Go.svelte', 'Go', 'href="https://example.com" label="Site"')).toEqual([]);
    expect((await use('./Go.svelte', 'Go', 'href="javascript:alert(1)" label="x"')).length).toBe(1);
  });

  it('accepts clean project components, import cycles included, and leaves developer code alone', async () => {
    expect(await strictErrors(importing('./Card.svelte'), { resolve: project({ [`${DIR}/Card.svelte`]: CLEAN }) })).toEqual([]);
    const cycle = { [`${DIR}/A.svelte`]: importing('./B.svelte'), [`${DIR}/B.svelte`]: importing('./A.svelte') };
    expect(await strictErrors(importing('./A.svelte'), { filename: `${DIR}/Top.svelte`, resolve: project(cycle) })).toEqual([]);
    expect(await strictErrors(importing('./A.svelte'), { filename: `${DIR}/A.svelte`, resolve: project(cycle) })).toEqual([]);
    // Compiler warnings in an imported component are not problems.
    expect(await strictErrors(importing('./Pic.svelte'), { resolve: project({ [`${DIR}/Pic.svelte`]: `<img src="/assets/a.png" />\n` }) })).toEqual([]);
    expect((await checkSvelteSource(importing('./Map.svelte'))).filter((p) => p.severity === 'error')).toEqual([]);
  });
});

