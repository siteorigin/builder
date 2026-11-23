import { describe, expect, it } from 'vitest';
import { sanitizeSvg } from '../../src/main/project/svg';

const svg = (s: string) => Buffer.from(s, 'utf8');

describe('SVG sanitizer', () => {
  it('keeps ordinary drawing content', () => {
    const out = sanitizeSvg(svg('<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs><path d="M0 0h10" fill="url(#g)"/></svg>'));
    expect(out).toContain('viewBox="0 0 10 10"');
    expect(out).toContain('<linearGradient id="g">');
    expect(out).toContain('fill="url(#g)"');
  });
  it('removes scripts, handlers, foreign content and external references', () => {
    const out = sanitizeSvg(
      svg('<svg onload="alert(1)"><script>alert(2)</script><foreignObject><div>x</div></foreignObject><a href="javascript:alert(3)"><rect/></a><use href="https://evil.example/x.svg#a"/><image href="x.png"/><rect style="x" fill="url(https://evil.example/a)"/></svg>')
    );
    expect(out).not.toMatch(/script|onload|foreignObject|javascript|evil|<image|style=/i);
  });
  it('rejects entities and UTF-16', () => {
    expect(() => sanitizeSvg(svg('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>'))).toThrow(/entities/);
    expect(() => sanitizeSvg(Buffer.from('﻿<svg/>', 'utf16le'))).toThrow();
  });
});
