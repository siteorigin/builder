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
  it('keeps presentation CSS from design tools and drops anything that loads or runs', () => {
    // Illustrator: classes in a CDATA stylesheet. Figma/Inkscape: style attributes.
    const out = sanitizeSvg(
      svg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><style type="text/css"><![CDATA[@import url(https://evil.example/x.css); .cls-1{fill:#0a7;stroke:#000;stroke-width:2px;behavior:url(x.htc)} .cls-2 { fill: url(#g); } .bad{fill:url(https://evil.example/p)} a[href]{fill:red} @media print{.cls-1{fill:red}}]]></style></defs>' +
          '<path class="cls-1" d="M0 0h10"/><rect style="fill:#123456;opacity:.5;background:url(https://evil.example/b);position:fixed" width="1" height="1"/></svg>'
      )
    );
    expect(out).toContain('<style>.cls-1{fill:#0a7;stroke:#000;stroke-width:2px}.cls-2{fill:url(#g)}</style>');
    expect(out).toContain('style="fill:#123456;opacity:.5"');
    expect(out).not.toMatch(/evil|@import|@media|behavior|position|\[href\]|\.bad/);
  });

  it('matches closing tags to their elements', () => {
    // A stray </g> must not close the <svg>, and an unclosed <foreignObject> must not swallow later content.
    const out = sanitizeSvg(svg('<svg viewBox="0 0 4 4"><g></g></g><rect width="1" height="1"/><foreignObject><div><p>x</div></foreignObject><circle r="1"/></svg>'));
    expect(out).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><g></g><rect width="1" height="1" /><circle r="1" /></svg>\n');
  });

  it('blocks CSS that spells a load another way', () => {
    const out = sanitizeSvg(
      svg(
        '<svg viewBox="0 0 4 4"><rect fill="u\\72l(https://evil.example/a)" width="1"/><rect style="mask:image-set(&quot;https://evil.example/b&quot; 1x);fill:#111" width="2"/><rect fill="paint(evil)" width="3"/>' +
          '<style>.a{mask:image-set("https://evil.example/c" 1x);fill:#222}.b{fill:u\\72l(https://evil.example/d)}</style><rect transform="matrix(1 0 0 1 0 0)" fill="rgb(1,2,3)" width="4"/></svg>'
      )
    );
    expect(out).not.toMatch(/evil|image-set|paint\(|\\/);
    expect(out).toContain('style="fill:#111"');
    expect(out).toContain('<style>.a{fill:#222}</style>');
    expect(out).toContain('transform="matrix(1 0 0 1 0 0)" fill="rgb(1,2,3)"');
  });

  it('keeps styles inside one drawing', () => {
    const out = sanitizeSvg(
      svg('<style>.outside{fill:red}</style><svg viewBox="0 0 4 4"><style>body{fill:red}*{fill:red}svg{fill:red}.ok,rect.st0>.x{fill:#333}.bad,body{fill:red}<g><path d="M0 0"/></g></style></svg><svg><rect width="9"/></svg>')
    );
    expect(out).not.toMatch(/outside|body|\*\{|svg\{|\.bad|<path|width="9"/);
    expect(out).toContain('.ok,rect.st0&gt;.x{fill:#333}');
  });

  it('keeps ordinary design-tool output and checks the real URL target', () => {
    const out = sanitizeSvg(
      svg(`<svg viewBox="0 0 9 9"><title>Logo (dark)</title><defs><clipPath id="_c"><rect width="1"/></clipPath><linearGradient id="_paint0"/></defs><g clip-path="url(#_c)" transform="translate(1 2) rotate(3)"><path fill="url(#_paint0)" d="M0 0"/><text font-family="'Inter', sans-serif">a</text></g><rect fill="url(' #x')" width="7"/></svg>`)
    );
    expect(out).toContain('<title>Logo (dark)</title>');
    expect(out).toContain('clip-path="url(#_c)" transform="translate(1 2) rotate(3)"');
    expect(out).toContain('fill="url(#_paint0)"');
    expect(out).toContain(`font-family="'Inter', sans-serif"`);
    expect(out).not.toContain(' ');
  });

  it('stays linear on long values and many at-rules', () => {
    const started = Date.now();
    sanitizeSvg(svg(`<svg><rect fill="${'a'.repeat(19_000)}"/><style>${'@a{}'.repeat(60_000)}</style></svg>`));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('refuses absurd nesting and stays fast on hostile stylesheets', () => {
    expect(() => sanitizeSvg(svg(`<svg>${'<g>'.repeat(1000)}</svg>`))).toThrow(/nested/);
    const started = Date.now();
    sanitizeSvg(svg(`<svg><style>${'a '.repeat(50_000)}</style></svg>`));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('rejects entities and UTF-16', () => {
    expect(() => sanitizeSvg(svg('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>'))).toThrow(/entities/);
    expect(() => sanitizeSvg(Buffer.from('﻿<svg/>', 'utf16le'))).toThrow();
  });
});
