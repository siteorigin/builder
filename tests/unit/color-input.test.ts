// Colours as an author types them (#899): a hex without its # and CSS colour names are taken, and text that is not a
// colour is refused before it is sent, with a reason that says what to write instead.
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { isNamedColor, namedColorHex, normalizeColorText } from '@shared/color-names';
import { colorFieldProblem, parseColor, pickerHex } from '@shared/color';
import { backgroundImageLayers, isScrim, isValidGradient, validateStyleValue } from '@shared/styles';
import { paletteChanges } from '@shared/palette';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { effectiveTokens, generateProject } from '@generator/index';

const fresh = () => createStarterState('blank', 'Blank', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];

describe('colour names', () => {
  it('knows every CSS colour name, in any case, and nothing else', () => {
    expect(namedColorHex('red')).toBe('#ff0000');
    expect(namedColorHex('RebeccaPurple')).toBe('#663399');
    expect(namedColorHex(' grey ')).toBe('#808080');
    for (const v of ['reddish', 'transparent', 'currentcolor', 'toString', 'constructor', '__proto__', '']) expect(isNamedColor(v), v).toBe(false);
  });

  it('resolves a name to its colour for the picker and contrast', () => {
    expect(pickerHex('red')).toBe('#ff0000');
    expect(pickerHex('CornflowerBlue')).toBe('#6495ed');
    expect(parseColor('white')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });
});

describe('typed colour text', () => {
  it('gives a hex typed without its # one, and leaves anything else as typed', () => {
    expect(normalizeColorText('ffee00')).toBe('#ffee00');
    expect(normalizeColorText(' FFEE00 ')).toBe('#FFEE00');
    expect(normalizeColorText('abc')).toBe('#abc');
    expect(normalizeColorText('abcd')).toBe('#abcd');
    expect(normalizeColorText('11223344')).toBe('#11223344');
    for (const v of ['12345', '1234567', 'red', '#12', 'rgb(1 2 3)', 'zzz']) expect(normalizeColorText(v)).toBe(v);
  });

  it('accepts a hex without its # and colour names in a colour field', () => {
    for (const v of ['ffee00', '#ffee00', 'red', 'RebeccaPurple', 'transparent', 'rgb(1 2 3)']) {
      expect(colorFieldProblem(v), v).toBeNull();
      expect(colorFieldProblem(v, 'background'), v).toBeNull();
    }
    // Empty text is the field's own: it puts the saved colour back.
    expect(colorFieldProblem('   ')).toBeNull();
  });

  it('refuses what is not a colour, saying what to write instead', () => {
    expect(colorFieldProblem('#12')?.message).toMatch(/not a hex color\. Use 3, 4, 6 or 8 hex digits/);
    expect(colorFieldProblem('12345')?.message).toMatch(/not a hex color/);
    expect(colorFieldProblem('zzz')?.message).toBe('"zzz" is not a color. Use a hex value such as #1c2742, a color name such as red, rgb(), hsl() or oklch().');
    expect(colorFieldProblem('reddish')?.message).toMatch(/not a color/);
    expect(colorFieldProblem('url(photo.jpg)', 'background')?.message).toBe('Background takes a color or a gradient, not a picture. Add a picture with Background image instead.');
    expect(colorFieldProblem('url(photo.jpg)')?.message).toMatch(/takes a color, not a picture/);
    // Unsafe text in a colour field is still refused, as a colour rather than as "invalid characters".
    expect(colorFieldProblem('red; color: blue')?.message).toMatch(/is not a color/);
  });

  it('holds hex to the lengths CSS reads', () => {
    for (const v of ['#abc', '#abcd', '#aabbcc', '#aabbccdd']) expect(validateStyleValue('color', v), v).toBeNull();
    for (const v of ['#ab', '#abcde', '#abcdefa', '#abcdefabc']) expect(validateStyleValue('color', v), v).toMatch(/not a hex color/);
  });

  it('takes a colour name as the colour a gradient ends on', () => {
    expect(isValidGradient('linear-gradient(red, blue), white')).toBe(true);
    expect(validateStyleValue('background', 'linear-gradient(red, navy), rebeccapurple')).toBeNull();
  });
});

describe('a typed colour through the project', () => {
  it('saves a node colour typed without its #, and a colour name as written', () => {
    const blank = fresh();
    const owner = { kind: 'page' as const, id: blank.site.homePageId };
    const r = applyOperations(blank, [{ type: 'node.insert', owner, parentId: home(blank).rootIds[0], slot: 'content', primitive: 'grid' }]);
    const s = r.state;
    const nodeId = r.results[0].nodeId as string;
    let next = applyOperations(s, [{ type: 'node.setStyle', owner, nodeId, scope: 'base', property: 'background', value: 'ffee00' }]).state;
    expect(home(next).nodes[nodeId].styles?.base?.background).toBe('#ffee00');
    next = applyOperations(next, [{ type: 'node.setStyle', owner, nodeId, scope: 'base', property: 'color', value: 'Red' }]).state;
    expect(home(next).nodes[nodeId].styles?.base?.color).toBe('Red');
    const css = [...generateProject(next).values()].join('\n');
    expect(css).toContain('background: #ffee00');
    expect(css).toContain('color: Red');
    expect(() => applyOperations(next, [{ type: 'node.setStyle', owner, nodeId, scope: 'base', property: 'background', value: 'url(x.png)' }])).toThrow(/not a picture/);
    expect(() => applyOperations(next, [{ type: 'node.setStyle', owner, nodeId, scope: 'base', property: 'color', value: '#12' }])).toThrow(/not a hex color/);
  });

  it('saves a site colour, light and dark, typed without its # or by name', () => {
    let s = applyOperations(fresh(), [{ type: 'token.set', tokenId: 'color.brand', value: 'ffee00' }]).state;
    expect(s.tokens.overrides['color.brand']).toBe('#ffee00');
    s = applyOperations(s, [{ type: 'token.set', tokenId: 'color.brand', value: 'red' }]).state;
    expect(s.tokens.overrides['color.brand']).toBe('red');
    s = applyOperations(s, [{ type: 'token.setColorScheme', mode: 'system' }]).state;
    s = applyOperations(s, [{ type: 'token.set', tokenId: 'color.brand', value: '00aa11', scheme: 'dark' }]).state;
    expect(s.tokens.darkOverrides?.['color.brand']).toBe('#00aa11');
    expect(() => applyOperations(s, [{ type: 'token.set', tokenId: 'color.brand', value: 'zzz' }])).toThrow(/"zzz" is not a color/);
    expect(() => applyOperations(s, [{ type: 'token.set', tokenId: 'color.brand', value: 'zzz', scheme: 'dark' }])).toThrow(/"zzz" is not a color/);
  });

  it('creates a custom colour typed without its #', () => {
    const r = applyOperations(fresh(), [{ type: 'token.create', group: 'color', label: 'Highlight', value: 'ffee00' }]);
    const made = r.state.tokens.custom.find((t) => t.label === 'Highlight');
    expect(made?.value).toBe('#ffee00');
  });

  it('keeps a colour linked to one saved by name when the palette lands on the same colour', () => {
    let s = applyOperations(fresh(), [{ type: 'token.set', tokenId: 'color.accent', value: 'red' }]).state;
    s = applyOperations(s, [{ type: 'token.set', tokenId: 'color.brand', value: { token: 'color.accent' } }]).state;
    const changes = paletteChanges(effectiveTokens(s), { 'color.brand': '#ff0000' } as Parameters<typeof paletteChanges>[1]);
    expect(changes).toEqual([]);
  });
});

describe('review follow-ups', () => {
  it('names no colour with a lookalike letter CSS does not fold', () => {
    // U+212A KELVIN SIGN lowercases to "k" in JavaScript, but a browser reads no colour from it.
    expect(isNamedColor('blacK')).toBe(false);
    expect(parseColor('blacK')).toBeNull();
    expect(validateStyleValue('color', 'blacK')).toMatch(/not a color/);
  });

  it('takes colour names in a scrim, alone or in a gradient', () => {
    expect(isScrim('RebeccaPurple')).toBe(true);
    expect(isScrim('linear-gradient(to bottom, transparent, navy)')).toBe(true);
    expect(isScrim('reddish')).toBe(false);
  });

  it('refuses a site colour that is not text', () => {
    expect(() => applyOperations(fresh(), [{ type: 'token.set', tokenId: 'color.brand', value: ['RebeccaPurple'] as unknown as string }])).toThrow(/is not a color/);
  });

  it('strips a named colour that ends a gradient from the picture layers', () => {
    expect(backgroundImageLayers('linear-gradient(red, blue), white')).toBe('linear-gradient(red, blue)');
  });
});
