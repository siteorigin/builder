import { describe, expect, it } from 'vitest';
import { checkSvelteSource } from '../../src/main/codecheck';
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
