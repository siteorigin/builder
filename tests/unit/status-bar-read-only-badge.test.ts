import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/renderer/src/panels/StatusBar.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
const rule = (selector: string) => rules.find((r) => r.selector === selector)?.body ?? '';

describe('read-only badge in a live session (#1345)', () => {
  it('sizes the lock icon and lays the span out like the button badge', () => {
    expect(rule('.status-bar > span.read-only > svg')).toMatch(/width: 13px; height: 13px/);
    const box = rule('.status-bar > span.read-only');
    expect(box).toMatch(/display: inline-flex/);
    expect(box).toMatch(/align-items: center/);
    expect(box).toMatch(/height: 24px/);
  });

  it('takes the amber accent on the span as on the button', () => {
    const accent = rules.find((r) => r.selector.includes('span).read-only') && /var\(--amber\)/.test(r.body));
    expect(accent).toBeTruthy();
    expect(accent!.selector).toMatch(/svg:not\(\.go\)/);
  });
});
