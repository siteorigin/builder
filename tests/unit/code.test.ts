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
