import { describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState, ResponsiveStyles } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { STYLE_PROPS, STYLE_PROP_MAP, parseCustomCss, styleFallbackCss, styleSetFor, styleToCss, validateStyleValue } from '@shared/styles';
import { createStarterState } from '@catalogue/starters';
import { FOUNDATION_BASE_CSS } from '@catalogue/foundation/base.css';
import { applyOperations } from '@engine/apply';
import { installComponent, makeInstance } from '@engine/install';
import { STYLES_DIR, generateProject, generateStandaloneComponent } from '@generator/index';

const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const defOf = (s: ProjectState, componentId: string) => Object.values(s.components).find((d) => d.componentId === componentId)!;
const instanceOf = (s: ProjectState, componentId: string) =>
  Object.values(home(s).nodes).find((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === componentId) as InstanceNode;
const css = (s: ProjectState, file: 'components' | 'site') => generateProject(s).get(`${STYLES_DIR}/${file}.css`)!;

/** Every rule inside @media blocks for this query, or, for null, every rule outside any @media block. */
function section(text: string, query: string | null): string {
  const block = /@media ([^{]+) \{\n([\s\S]*?)\n\}/g;
  if (query === null) return text.replace(block, '');
  return [...text.matchAll(block)].filter((m) => m[1] === query).map((m) => m[2]).join('\n');
}
/** The declarations of the rule with exactly this selector in a block of CSS. */
function ruleOf(text: string, selector: string): string {
  const at = text.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return text.slice(at, text.indexOf('}', at));
}
const PHONE = '(max-width: 767.98px)';
const WIDE = '(min-width: 768px)';
const TABLET = '(min-width: 768px) and (max-width: 1023.98px)';

describe('length values (#205)', () => {
  const NON_NEGATIVE = ['paddingBlock', 'paddingInline', 'paddingBlockStart', 'paddingBlockEnd', 'paddingInlineStart', 'paddingInlineEnd', 'gap', 'rowGap', 'columnGap', 'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'radius', 'fontSize', 'lineHeight'];
  const SIGNED = ['marginBlockStart', 'marginBlockEnd', 'marginInlineStart', 'marginInlineEnd', 'letterSpacing'];

  it('refuses a unitless number other than zero, which CSS drops', () => {
    for (const p of [...NON_NEGATIVE.filter((x) => x !== 'lineHeight'), ...SIGNED]) {
      expect(validateStyleValue(p, '64'), p).toMatch(/needs a unit/);
      expect(validateStyleValue(p, 64), p).toMatch(/needs a unit/);
      expect(validateStyleValue(p, '1.5'), p).toMatch(/needs a unit/);
    }
    expect(validateStyleValue('inset', '8')).toMatch(/offset/);
    expect(validateStyleValue('inset', '0 8')).toMatch(/offset/);
    expect(validateStyleValue('inset', '0 0 0 8')).toMatch(/offset/);
    expect(validateStyleValue('inset', '0 0 8')).toMatch(/offset/);
  });

  it('refuses a negative length where CSS allows none, and keeps signed ones where it does', () => {
    for (const p of NON_NEGATIVE) {
      expect(validateStyleValue(p, '-10px'), p).toMatch(/cannot be negative/);
      expect(validateStyleValue(p, '-.5rem'), p).toMatch(/cannot be negative/);
      expect(validateStyleValue(p, '-.1px'), p).toMatch(/cannot be negative/);
      expect(validateStyleValue(p, '-9px'), p).toMatch(/cannot be negative/);
    }
    expect(validateStyleValue('lineHeight', '-1.5')).toMatch(/cannot be negative/);
    for (const p of SIGNED) {
      expect(validateStyleValue(p, '-10px'), p).toBeNull();
      expect(validateStyleValue(p, '-0.02em'), p).toBeNull();
      expect(validateStyleValue(p, '-10'), p).toMatch(/needs a unit/);
    }
    expect(validateStyleValue('inset', 'auto -8px 0 5%')).toBeNull();
  });

  it('keeps zero, units, keywords and math as before', () => {
    for (const p of [...NON_NEGATIVE, ...SIGNED]) {
      for (const v of ['0', 0, '0px', '-0', '0.0', '.5rem', '24px', '50%', '1.5em', 'calc(100% - 2rem)', 'clamp(2rem, 5vw, 4rem)', 'min(2vw, 3rem)', 'max(1rem, min(2vw, 3rem))', 'calc(var(--so-space-md) - 1rem)'])
        expect(validateStyleValue(p, v), `${p}: ${v}`).toBeNull();
    }
    expect(validateStyleValue('lineHeight', '1.6')).toBeNull();
    expect(validateStyleValue('lineHeight', 1.5)).toBeNull();
    for (const v of ['fill', 'fit', 'auto']) expect(validateStyleValue('width', v), v).toBeNull();
    expect(validateStyleValue('height', 'auto')).toBeNull();
    // `auto` only where CSS works a length out: sizes, margins and offsets.
    for (const p of ['height', 'minWidth', 'minHeight', 'marginBlockStart', 'marginBlockEnd', 'marginInlineStart', 'marginInlineEnd']) expect(validateStyleValue(p, 'auto'), p).toBeNull();
    expect(validateStyleValue('inset', 'auto 0')).toBeNull();
    for (const p of ['paddingBlock', 'paddingInlineStart', 'gap', 'columnGap', 'maxWidth', 'maxHeight', 'radius', 'fontSize', 'lineHeight', 'letterSpacing']) expect(validateStyleValue(p, 'auto'), p).toMatch(/cannot be auto/);
    // A bare variable is still not a length, as before.
    expect(validateStyleValue('width', 'var(--so-width)')).not.toBeNull();
    expect(validateStyleValue('gap', '10 px')).toMatch(/not a valid length/);
  });

  it('refuses the reported values through node.setStyle', () => {
    const s = fresh();
    const hero = instanceOf(s, 'hero.split');
    const set = (property: string, value: string, scope = 'base') => applyOperations(s, [{ type: 'node.setStyle', owner: { kind: 'page', id: s.site.homePageId }, nodeId: hero.id, scope, property, value } as EditOperation]);
    expect(() => set('paddingBlock', '64')).toThrow(/needs a unit/);
    expect(() => set('gap', '-10px', 'tablet')).toThrow(/cannot be negative/);
    expect(() => set('radius', '-8px', 'phone')).toThrow(/cannot be negative/);
    expect(() => set('marginBlockStart', '-8px', 'desktop')).not.toThrow();
  });
});

describe('column sizes for all sizes (#205)', () => {
  it('keep phones to the Grid’s own columns and win over its desktop count', () => {
    let s = createStarterState('blank', 'Blank', false);
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    const host = home(s).rootIds[0];
    const r = applyOperations(s, [{ type: 'node.insert', owner, parentId: host, slot: 'content', primitive: 'grid' }]);
    const gridId = r.results[0].nodeId as string;
    s = applyOperations(r.state, [
      { type: 'node.setStyle', owner, nodeId: gridId, scope: 'tablet', property: 'columns', value: 2 },
      { type: 'node.setStyle', owner, nodeId: gridId, scope: 'base', property: 'gridTemplate', value: '1fr 2fr' }
    ]).state;
    const text = css(s, 'site');
    const sel = `.so-n-${gridId}`;
    expect(ruleOf(section(text, null), sel)).toContain('grid-template-columns: repeat(1, minmax(0, 1fr))');
    expect(ruleOf(section(text, null), sel)).not.toContain('minmax(0, 2fr)');
    expect(ruleOf(section(text, WIDE), sel)).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 2fr)');
    expect(section(text, '(min-width: 1024px)')).not.toContain(sel);
    expect(section(text, TABLET)).not.toContain(sel);
    // Without the column sizes, the desktop count is back.
    s = applyOperations(s, [{ type: 'node.setStyle', owner, nodeId: gridId, scope: 'base', property: 'gridTemplate', value: null }]).state;
    expect(ruleOf(section(css(s, 'site'), '(min-width: 1024px)'), sel)).toContain('repeat(3, minmax(0, 1fr))');
    expect(ruleOf(section(css(s, 'site'), TABLET), sel)).toContain('repeat(2, minmax(0, 1fr))');
  });
});

describe('style registry', () => {
  it('emits a declaration for every property it offers', () => {
    const sample: Record<string, unknown> = {
      layout: 'grid', columns: 2, align: 'center', justify: 'center', order: 1, wrap: true, gridTemplate: '1fr 2fr', columnSpan: 2, alignSelf: 'center',
      flexGrow: 1, flexShrink: 0, textStyle: 'text.h2', fontFamily: 'serif', fontWeight: '600', fontStyle: 'italic', textTransform: 'uppercase',
      textAlign: 'center', color: '#000', background: '#fff', shadow: '0 1px 2px #000', opacity: 0.5, marginInline: 'auto', aspectRatio: '16/9',
      objectFit: 'cover', objectPosition: 'top', overflow: 'clip', position: 'sticky', inset: '0', zIndex: 2, hidden: true, customCss: 'filter: blur(2px)',
      width: 'fill', border: '1px solid #000', borderBlockStart: '1px solid #000', borderBlockEnd: '1px solid #000', borderInlineStart: '1px solid #000', borderInlineEnd: '1px solid #000',
      translateX: '8px', translateY: '-4px', scale: 1.03, rotate: -2, transformOrigin: 'top left', transition: 'shadow', transitionDuration: 300, transitionEasing: 'ease-out'
    };
    for (const p of STYLE_PROPS) {
      const value = (sample[p.id] ?? '12px') as string;
      expect(validateStyleValue(p.id, value), p.id).toBeNull();
      expect(styleToCss(p.id, value).length, p.id).toBeGreaterThan(0);
    }
  });

  it('maps layout helpers to CSS that cannot blow out a track', () => {
    expect(styleToCss('gridTemplate', '1fr 1.5fr')).toEqual(['grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr)']);
    expect(styleToCss('gridTemplate', 'auto-fit-sm')[0]).toContain('14rem');
    expect(styleToCss('gridTemplate', 'auto-fit-md')[0]).toContain('20rem');
    // Surrounding spaces in a stored value change nothing.
    expect(styleToCss('columnSpan', ' full ')).toEqual(['grid-column: 1 / -1']);
    expect(styleToCss('gridTemplate', ' auto-fit-md ')[0]).toContain('20rem');
    expect(styleToCss('columnSpan', 3)).toEqual(['grid-column: span 3 / span 3']);
    expect(styleToCss('columnSpan', 'full')).toEqual(['grid-column: 1 / -1']);
  });

  it('refuses what a property cannot hold', () => {
    expect(validateStyleValue('gridTemplate', 'repeat(99, 1fr)')).toMatch(/must be one of/);
    expect(validateStyleValue('columnSpan', 13)).toMatch(/must be one of/);
    expect(validateStyleValue('position', 'fixed')).toMatch(/must be one of/);
    expect(validateStyleValue('zIndex', 1.5)).toMatch(/whole number/);
    expect(validateStyleValue('zIndex', 9999)).toMatch(/at most/);
    expect(validateStyleValue('inset', '1px 2px 3px 4px 5px')).toMatch(/offset/);
    expect(validateStyleValue('inset', 'calc(1px + 2px) 0')).toBeNull();
    expect(validateStyleValue('inset', 'calc(1px + max(2px, 3px)) 0')).toBeNull();
    expect(validateStyleValue('inset', '1px banana')).toMatch(/offset/);
    expect(validateStyleValue('zIndex', true as unknown as string)).toMatch(/number/);
    expect(validateStyleValue('flexGrow', '')).toMatch(/number/);
  });

  it('writes nothing for a hand-edited value that breaks a fixed grammar', () => {
    expect(styleToCss('position', 'fixed')).toEqual([]);
    expect(styleToCss('zIndex', 9999)).toEqual([]);
    expect(styleToCss('gridTemplate', 'repeat(1000, 50px)')).toEqual([]);
    expect(styleToCss('alignSelf', '[')).toEqual([]);
    expect(styleToCss('customCss', {} as never)).toEqual([]);
    expect(styleToCss('color', { token: 1 } as never)).toEqual([]);
  });

  it('refuses a value with an unclosed square bracket, which would swallow the rules after it', () => {
    expect(validateStyleValue('border', '1px solid [')).toMatch(/Invalid/);
    expect(validateStyleValue('shadow', '] 0 0 red')).toMatch(/Invalid/);
  });

  it('runs every property through the injection checks', () => {
    const attacks = ['red; } body { display: none', 'x{}', 'a/* b', '</style><script>', 'url(https://evil.test/x.png)', 'image-set("https://evil.test/x.png" 1x)', '\\75rl(x)'];
    for (const p of STYLE_PROPS) for (const attack of attacks) expect(validateStyleValue(p.id, attack), `${p.id}: ${attack}`).not.toBeNull();
  });

  it('accepts gradients in background and nowhere else', () => {
    const scrim = 'linear-gradient(180deg, rgba(0, 0, 0, 0.6), transparent 60%)';
    expect(validateStyleValue('background', scrim)).toBeNull();
    expect(validateStyleValue('background', 'radial-gradient(circle at 50% 0, var(--so-color-brand), #000)')).toBeNull();
    expect(validateStyleValue('background', 'conic-gradient(red, blue)')).toBeNull();
    expect(validateStyleValue('color', scrim)).not.toBeNull();
    expect(validateStyleValue('background', 'linear-gradient(red, url(x))')).not.toBeNull();
    expect(validateStyleValue('background', 'linear-gradient(red, attr(data-x))')).not.toBeNull();
    expect(validateStyleValue('background', 'linear-gradient(var(--evil), red)')).not.toBeNull();
    expect(validateStyleValue('background', 'linear-gradient(red, blue')).not.toBeNull();
    expect(validateStyleValue('background', 'linear-gradient()')).not.toBeNull();
    expect(validateStyleValue('background', 'linear-gradient(red, blue) fixed')).not.toBeNull();
    expect(validateStyleValue('background', 'linear-gradient(red, blue), linear-gradient(#000, #fff), #123')).toBeNull();
  });

  it('offers each kind of node only what works on it', () => {
    const image = styleSetFor({ kind: 'image' })!;
    expect(image).toContain('objectPosition');
    expect(image).not.toContain('columns');
    const text = styleSetFor({ kind: 'text' })!;
    expect(text).toEqual(expect.arrayContaining(['fontStyle', 'textTransform']));
    expect(text).not.toContain('objectFit');
    const element = styleSetFor({ kind: 'element' })!;
    expect(element).toEqual(expect.arrayContaining(['gridTemplate', 'rowGap', 'columnGap', 'overflow', 'position', 'borderBlockEnd']));
    expect(styleSetFor({ kind: 'link' })).toEqual(expect.arrayContaining(['width', 'background', 'hidden']));
    expect(styleSetFor({ kind: 'icon' })).toEqual(expect.arrayContaining(['color', 'fontSize', 'hidden']));
    for (const kind of ['text', 'image', 'link', 'icon', 'element']) for (const id of styleSetFor({ kind })!) expect(STYLE_PROP_MAP[id], `${kind}: ${id}`).toBeDefined();
  });

  it('accepts new properties through node.setStyle', () => {
    const s = fresh();
    const hero = instanceOf(s, 'hero.split');
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    const out = applyOperations(s, [{ type: 'node.setStyle', owner, nodeId: hero.id, scope: 'base', property: 'paddingBlockStart', value: { token: 'space.lg' } }]);
    expect((out.state.pages[s.site.homePageId].nodes[hero.id] as InstanceNode).overrides?.root?.base?.paddingBlockStart).toEqual({ token: 'space.lg' });
    expect(() => applyOperations(s, [{ type: 'node.setStyle', owner, nodeId: hero.id, scope: 'base', property: 'customCss', value: 'position: fixed' }])).toThrow(/cannot be set/);
  });
});

describe('scoped custom CSS', () => {
  it('keeps plain declarations', () => {
    expect(parseCustomCss('filter: blur(2px); TRANSFORM: rotate(-2deg);')).toEqual({ decls: ['filter: blur(2px)', 'transform: rotate(-2deg)'], error: null });
    expect(parseCustomCss('').decls).toEqual([]);
    expect(parseCustomCss('transform: translateX(10px)\n  rotate(2deg);\ncolor: red').decls).toEqual(['transform: translateX(10px) rotate(2deg)', 'color: red']);
    expect(parseCustomCss(`${' '.repeat(3000)}color: red`).decls).toEqual(['color: red']);
    expect(parseCustomCss('background-image: linear-gradient(var(--so-color-brand), #000)').error).toBeNull();
  });

  it.each([
    ['a selector', '.x { color: red }'],
    ['closing the rule', 'color: red } body { display: none'],
    ['an at-rule', '@import "https://evil.test/x.css"'],
    ['an at-rule after a declaration', 'color: red; @import url(x)'],
    ['url()', 'background-image: url(https://evil.test/x.png)'],
    ['upper-case URL()', 'background-image: URL(https://evil.test/x.png)'],
    ['image-set()', 'background-image: image-set("x.png" 1x)'],
    ['a CSS escape', 'background-image: \\75rl(x)'],
    ['an opening comment', 'color: red /* hi'],
    ['a closing comment', 'color: red */'],
    ['a comment hiding a url', 'background-image: u/**/rl(x)'],
    ['quotes', 'font-family: "x"'],
    ['!important', 'color: red !important'],
    ['HTML', 'color: red</style><script>alert(1)</script>'],
    ['a custom property', '--so-color-brand: red'],
    ['behavior', 'behavior: x'],
    ['-moz-binding', '-moz-binding: x'],
    ['fixed positioning', 'position: fixed'],
    ['offsets', 'top: 0'],
    ['z-index', 'z-index: 9999'],
    ['an unknown function', 'width: attr(data-x)'],
    ['a custom function ending in an allowed name', 'width: --card1blur()'],
    ['a custom function with an odd name', 'width: --card_()'],
    ['a variable as a background image', 'background-image: var(--so-card-image)'],
    ['a variable as a filter', 'filter: var(--so-filter)'],
    ['var() outside the site tokens', 'color: var(--evil)'],
    ['unbalanced brackets', 'width: calc(1px'],
    ['no value', 'color:'],
    ['no property', 'red']
  ])('refuses %s', (_name, text) => {
    expect(parseCustomCss(text).error).not.toBeNull();
    expect(validateStyleValue('customCss', text)).not.toBeNull();
    expect(styleToCss('customCss', text)).toEqual([]);
  });

  it('limits size', () => {
    expect(parseCustomCss(`color: red;`.repeat(25)).error).toMatch(/at most/);
    expect(parseCustomCss(`width: ${'1'.repeat(3000)}px`).error).toMatch(/too long/);
  });

  it('never writes a hand-edited value into the stylesheet', () => {
    const s = fresh();
    const hero = instanceOf(s, 'hero.split');
    hero.overrides = { root: { base: { customCss: 'position: fixed; color: red', opacity: 0.5 } } };
    const out = css(s, 'site');
    expect(out).toContain('opacity: 0.5');
    expect(out).not.toContain('position: fixed');
    expect(out).not.toContain('color: red');
  });

  it('is scoped to the element, after its named properties and before visibility', () => {
    const s = fresh();
    const hero = instanceOf(s, 'hero.split');
    hero.overrides = { root: { base: { customCss: 'opacity: 0.2', opacity: 0.9, hidden: true } } };
    const out = css(s, 'site');
    const cls = `so-o-${hero.id}-root`;
    const rule = ruleOf(out, `.${cls}.${cls}`);
    for (const d of ['opacity: 0.9', 'opacity: 0.2', 'display: none']) expect(rule).toContain(d);
    expect(rule.indexOf('opacity: 0.9')).toBeLessThan(rule.indexOf('opacity: 0.2'));
    expect(rule.indexOf('opacity: 0.2')).toBeLessThan(rule.indexOf('display: none'));
  });
});

describe('custom CSS in the wide range', () => {
  it('still wins over a value moved to tablet and up', () => {
    const s = fresh();
    const inst = instanceOf(s, 'features.grid');
    inst.overrides = { grid: { base: { columns: 3, customCss: 'grid-template-columns: 1fr 2fr' } } };
    const wide = ruleOf(section(css(s, 'site'), WIDE), `.so-o-${inst.id}-grid.so-o-${inst.id}-grid`);
    expect(wide.indexOf('repeat(3')).toBeGreaterThanOrEqual(0);
    expect(wide.indexOf('repeat(3')).toBeLessThan(wide.indexOf('grid-template-columns: 1fr 2fr'));
  });
});

describe('style precedence', () => {
  const grid = (s: ProjectState) => instanceOf(s, 'features.grid');
  // The option's class and the node's, on the node itself.
  const VARIANT = '.so-foundation-features-grid--layout-two-columns.so-foundation-features-grid__grid';

  it('orders definition, variant and instance rules by strength', () => {
    const s = fresh();
    const def = defOf(s, 'features.grid');
    def.variantAxes!.layout.options['two-columns'].styles = { grid: { base: { gap: '11px' } } };
    def.tree!.nodes.grid.styles = { base: { layout: 'grid', gap: '10px' } };
    const inst = grid(s);
    inst.variants = { layout: 'two-columns' };
    inst.overrides = { grid: { base: { gap: '12px' } } };
    const components = css(s, 'components');
    const definition = components.indexOf('.so-foundation-features-grid__grid {\n\tgap: 10px');
    const variant = components.indexOf(`${VARIANT} {\n\tgap: 11px`);
    expect(definition).toBeGreaterThanOrEqual(0);
    expect(variant).toBeGreaterThan(definition);
    // The override has more classes than the definition and comes later than the variant (site.css loads last).
    const cls = `so-o-${inst.id}-grid`;
    expect(css(s, 'site')).toContain(`.${cls}.${cls} {\n\tgap: 12px`);
  });

  it('puts a breakpoint after its layer base, so it wins within the same layer', () => {
    const s = fresh();
    const inst = grid(s);
    inst.overrides = { grid: { base: { gap: '12px' }, phone: { gap: '4px' } } };
    const out = css(s, 'site');
    expect(out).toContain('gap: 12px');
    expect(section(out, PHONE)).toContain('gap: 4px');
    expect(out.indexOf('gap: 12px')).toBeLessThan(out.indexOf('gap: 4px'));
  });

  it('keeps the phone layout when a variant sets columns for all sizes', () => {
    const s = fresh();
    const def = defOf(s, 'features.grid');
    def.variantAxes!.layout.options['two-columns'].styles = { grid: { base: { columns: 2 } } };
    const out = css(s, 'components');
    expect(section(out, null)).not.toContain(`${VARIANT} {\n\tgrid-template-columns`);
    expect(ruleOf(section(out, WIDE), VARIANT)).toContain('repeat(2, minmax(0, 1fr))');
  });

  it('lets a variant keep an explicit phone column count', () => {
    const s = fresh();
    const def = defOf(s, 'features.grid');
    def.variantAxes!.layout.options['two-columns'].styles = { grid: { base: { columns: 3 }, phone: { columns: 2 } } };
    const out = css(s, 'components');
    expect(ruleOf(section(out, PHONE), VARIANT)).toContain('repeat(2, minmax(0, 1fr))');
    expect(ruleOf(section(out, WIDE), VARIANT)).toContain('repeat(3, minmax(0, 1fr))');
  });

  it('applies an uneven column template from tablet up on instances', () => {
    const s = fresh();
    const inst = grid(s);
    inst.overrides = { grid: { base: { gridTemplate: '2fr 1fr' } } };
    const out = css(s, 'site');
    expect(section(out, null)).not.toContain('minmax(0, 2fr)');
    expect(section(out, WIDE)).toContain('minmax(0, 2fr) minmax(0, 1fr)');
  });

  it('does not let a column span create extra columns on a phone', () => {
    const s = fresh();
    const inst = grid(s);
    inst.overrides = { card: { base: { columnSpan: 2 } } };
    const out = css(s, 'site');
    expect(section(out, null)).not.toContain('grid-column');
    expect(section(out, WIDE)).toContain('grid-column: span 2 / span 2');
  });

  it('applies a full-width span at every size, and a phone span where it was asked for', () => {
    const s = fresh();
    const inst = grid(s);
    inst.overrides = { card: { base: { columnSpan: 'full' }, phone: { columnSpan: 2 } } };
    const out = css(s, 'site');
    expect(section(out, null)).toContain('grid-column: 1 / -1');
    expect(section(out, PHONE)).toContain('grid-column: span 2 / span 2');
    inst.overrides = { card: { base: { columnSpan: 3 }, phone: { columnSpan: 1 } } };
    const moved = css(s, 'site');
    expect(section(moved, WIDE)).toContain('grid-column: span 3 / span 3');
    expect(section(moved, PHONE)).toContain('grid-column: span 1 / span 1');
    expect(section(moved, null)).not.toContain('grid-column');
  });

  it('writes gap before the row and column gaps that refine it', () => {
    const s = fresh();
    const inst = grid(s);
    inst.overrides = { grid: { base: { columnGap: '8px', rowGap: '4px', gap: '24px' } } };
    const rule = ruleOf(css(s, 'site'), `.so-o-${inst.id}-grid.so-o-${inst.id}-grid`);
    const at = (d: string) => rule.indexOf(`\t${d};`);
    for (const d of ['gap: 24px', 'column-gap: 8px', 'row-gap: 4px']) expect(at(d), d).toBeGreaterThanOrEqual(0);
    expect(at('gap: 24px')).toBeLessThan(at('column-gap: 8px'));
    expect(at('gap: 24px')).toBeLessThan(at('row-gap: 4px'));
  });

  it('writes a side after the shorthand it refines', () => {
    const s = fresh();
    const inst = grid(s);
    const styles: ResponsiveStyles = { base: { paddingBlockStart: '1px', paddingBlock: '2px', borderBlockEnd: '1px solid #000', border: '2px solid #111' } };
    inst.overrides = { root: styles };
    const rule = ruleOf(css(s, 'site'), `.so-o-${inst.id}-root.so-o-${inst.id}-root`);
    for (const d of ['padding-block: 2px', 'padding-block-start: 1px', 'border: 2px solid #111', 'border-block-end: 1px solid #000']) expect(rule).toContain(d);
    expect(rule.indexOf('padding-block: 2px')).toBeLessThan(rule.indexOf('padding-block-start: 1px'));
    expect(rule.indexOf('border: 2px solid #111')).toBeLessThan(rule.indexOf('border-block-end: 1px solid #000'));
  });

  it('lets a variant show a part the definition hides', () => {
    const s = fresh();
    const def = defOf(s, 'features.grid');
    def.tree!.nodes.heading.styles = { ...def.tree!.nodes.heading.styles, base: { ...def.tree!.nodes.heading.styles?.base, hidden: true } };
    def.variantAxes!.layout.options['two-columns'].styles = { heading: { base: { hidden: false } } };
    const out = css(s, 'components');
    for (const q of [PHONE, TABLET]) expect(ruleOf(section(out, q), '.so-foundation-features-grid--layout-two-columns.so-foundation-features-grid__heading')).toContain('display: revert');
    expect(section(out, null)).not.toMatch(/--layout-two-columns\.so-foundation-features-grid__heading \{[^}]*display/);
  });

  it('restores display only where a part is hidden, leaving other ranges their own layout', () => {
    const s = fresh();
    const def = defOf(s, 'features.grid');
    def.tree!.nodes.grid.styles = { base: { layout: 'grid' }, phone: { hidden: true }, tablet: { layout: 'stack' } };
    def.variantAxes!.layout.options['two-columns'].styles = { grid: { base: { hidden: false } } };
    const out = css(s, 'components');
    expect(ruleOf(section(out, PHONE), VARIANT)).toContain('display: grid');
    expect(section(out, TABLET)).not.toContain(VARIANT);
    expect(section(out, null)).not.toMatch(/--layout-two-columns\.so-foundation-features-grid__grid \{[^}]*display/);
  });

  it('shows a hidden button again as a button, not as the browser default', () => {
    const s = fresh();
    const id = installComponent(s, 'cta.banner');
    const def = s.components[id];
    const linkId = Object.values(def.tree!.nodes).find((n) => n.kind === 'link')!.id;
    def.parts.action = { nodeId: linkId, label: 'Action' };
    def.tree!.nodes[linkId].styles = { ...def.tree!.nodes[linkId].styles, base: { ...def.tree!.nodes[linkId].styles?.base, hidden: true } };
    const node = makeInstance(def);
    home(s).nodes[node.id] = node;
    home(s).rootIds.push(node.id);
    node.overrides = { action: { phone: { hidden: false } } };
    const cls = `so-o-${node.id}-action`;
    expect(ruleOf(section(css(s, 'site'), PHONE), `.${cls}.${cls}`)).toContain('display: inline-flex');
  });

  it('lets a page override beat the override a definition sets on a nested instance', () => {
    const s = fresh();
    const inner = defOf(s, 'features.grid');
    const outerId = 'project.wrapper';
    const nested = makeInstance(inner);
    nested.overrides = { root: { base: { gap: '1px' } } };
    s.components[outerId] = { ...structuredClone(inner), id: outerId, componentId: 'project.wrapper', owner: 'project', properties: {}, variantAxes: undefined, parts: { root: { nodeId: nested.id, label: 'Root' } }, tree: { rootIds: [nested.id], nodes: { [nested.id]: nested } } };
    const placed = makeInstance(s.components[outerId]);
    placed.overrides = { root: { base: { gap: '2px' } } };
    home(s).nodes[placed.id] = placed;
    home(s).rootIds.push(placed.id);
    const cls = `so-o-${placed.id}-root`;
    expect(ruleOf(css(s, 'site'), `.${cls}.${cls}.${cls}.${cls}`)).toContain('gap: 2px');
  });

  it('lets an instance show a part the active variant hides', () => {
    const s = fresh();
    const def = defOf(s, 'features.grid');
    def.variantAxes!.layout.options['two-columns'].styles = { heading: { base: { hidden: true } } };
    const inst = grid(s);
    inst.variants = { layout: 'two-columns' };
    inst.overrides = { heading: { base: { hidden: false } } };
    const cls = `so-o-${inst.id}-heading`;
    const out = css(s, 'site');
    for (const q of [PHONE, TABLET]) expect(ruleOf(section(out, q), `.${cls}.${cls}`)).toContain('display: revert');
  });

  it('keeps a hover state on a button with a gradient background', () => {
    const s = fresh();
    const id = installComponent(s, 'cta.banner');
    const def = s.components[id];
    const linkId = Object.values(def.tree!.nodes).find((n) => n.kind === 'link')!.id;
    def.parts.action = { nodeId: linkId, label: 'Action' };
    const node = makeInstance(def);
    home(s).nodes[node.id] = node;
    home(s).rootIds.push(node.id);
    const gradient = 'linear-gradient(90deg, #111, #333)';
    node.overrides = { action: { base: { background: gradient }, phone: { background: '#222' } } };
    const out = css(s, 'site');
    const cls = `so-o-${node.id}-action`;
    const base = ruleOf(section(out, null), `.${cls}.${cls}`);
    expect(base).toContain(`--so-btn-bg: ${gradient}`);
    expect(base).toContain(`--so-btn-bg-hover: ${gradient}`);
    // A solid color at one size goes back to the hover state derived from it.
    const phone = ruleOf(section(out, PHONE), `.${cls}.${cls}`);
    expect(phone).toContain('--so-btn-bg: #222');
    expect(phone).toContain('--so-btn-bg-hover: initial');
  });
});

describe('transforms and transitions', () => {
  const SHIFT = 'translate: var(--_so-translate-x, 0px) var(--_so-translate-y, 0px)';
  const MOTION = ['translateX', 'translateY', 'scale', 'rotate', 'transformOrigin', 'transition', 'transitionDuration', 'transitionEasing'];

  it('offers them on every kind of element, before visibility and custom CSS', () => {
    for (const kind of ['text', 'image', 'link', 'icon', 'element']) {
      const set = styleSetFor({ kind })!;
      expect(set, kind).toEqual(expect.arrayContaining(MOTION));
      expect(set.indexOf('transitionEasing'), kind).toBeLessThan(set.indexOf('hidden'));
    }
    for (const id of MOTION) expect(STYLE_PROP_MAP[id].advanced, id).toBe(true);
    for (const kind of ['text', 'image', 'link', 'icon', 'element']) {
      const set = styleSetFor({ kind })!;
      for (const id of MOTION) expect(set.indexOf(id), `${kind}: ${id}`).toBeLessThan(Math.min(set.indexOf('hidden'), set.indexOf('customCss')));
    }
  });

  it('accepts a shift up to its limit in each unit, and nothing past it', () => {
    for (const ok of ['0', '-4px', '+4px', '0.5rem', '.5em', '500px', '-500px', '32rem', '-32em', '100%', '-100%', ' 8px '])
      for (const id of ['translateX', 'translateY']) expect(validateStyleValue(id, ok), `${id}: ${ok}`).toBeNull();
    expect(validateStyleValue('translateX', 0)).toBeNull();
    for (const bad of ['500.5px', '-501px', '33rem', '-32.1em', '101%', '4', '-4', 'auto', '10vw', '1px 2px', 'calc(1px + 2px)', 'var(--x)', '4 px', 'px', '--4px', '1e2px'])
      expect(validateStyleValue('translateY', bad), bad).toMatch(/not a valid shift/);
    for (const bad of ['500.5px', '33rem', '101%', '4']) expect(validateStyleValue('translateX', bad), bad).toMatch(/not a valid shift/);
    expect(validateStyleValue('translateX', 4)).toMatch(/not a valid shift/);
    expect(validateStyleValue('translateX', { token: 'space.lg' })).toMatch(/cannot use a token/);
  });

  it('keeps scale, rotation and duration in range', () => {
    for (const ok of [0, 1, 1.03, 3, '0.95']) expect(validateStyleValue('scale', ok), String(ok)).toBeNull();
    expect(validateStyleValue('scale', 3.01)).toMatch(/at most 3/);
    expect(validateStyleValue('scale', -0.5)).toMatch(/at least 0/);
    for (const ok of [-360, -2.5, 0, 45, 360]) expect(validateStyleValue('rotate', ok), String(ok)).toBeNull();
    expect(validateStyleValue('rotate', 361)).toMatch(/at most 360/);
    expect(validateStyleValue('rotate', -360.5)).toMatch(/at least -360/);
    for (const ok of [0, 175, 3000]) expect(validateStyleValue('transitionDuration', ok), String(ok)).toBeNull();
    expect(validateStyleValue('transitionDuration', 3001)).toMatch(/at most 3000/);
    expect(validateStyleValue('transitionDuration', 17.5)).toMatch(/whole number/);
    expect(validateStyleValue('transitionDuration', -1)).toMatch(/at least 0/);
    // A null in a hand-edited document is not 0: it would hide the element at scale 0.
    for (const id of ['scale', 'rotate', 'transitionDuration']) expect(validateStyleValue(id, null as unknown as string), id).toMatch(/must be a number/);
    // Spellings JavaScript reads as numbers but nobody types as a style.
    for (const bad of ['0x10', '1e2', '', ' ', 'Infinity', true]) expect(validateStyleValue('rotate', bad as string), String(bad)).toMatch(/must be a number/);
    // Older number properties still read what documents already hold.
    expect(validateStyleValue('zIndex', '1e1')).toBeNull();
    expect(styleToCss('zIndex', '1e1')).toEqual(['z-index: 10']);
  });

  it('takes origins, presets and easings from their lists', () => {
    for (const ok of STYLE_PROP_MAP.transformOrigin.options!.map((o) => o.value)) expect(validateStyleValue('transformOrigin', ok), ok).toBeNull();
    expect(STYLE_PROP_MAP.transformOrigin.options!.map((o) => o.value)).toEqual(['center', 'top', 'bottom', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right']);
    for (const bad of ['left top', '10% 20%', 'top  left']) expect(validateStyleValue('transformOrigin', bad), bad).toMatch(/must be one of/);
    for (const ok of ['none', 'colors', 'shadow', 'transform', 'opacity', 'common']) expect(validateStyleValue('transition', ok), ok).toBeNull();
    for (const bad of ['all', 'color 200ms', 'width']) expect(validateStyleValue('transition', bad), bad).toMatch(/must be one of/);
    for (const ok of ['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'smooth', 'overshoot']) expect(validateStyleValue('transitionEasing', ok), ok).toBeNull();
    for (const bad of ['cubic-bezier(0, 0, 1, 1)', 'steps(4)']) expect(validateStyleValue('transitionEasing', bad), bad).toMatch(/must be one of/);
  });

  it('writes each as its own CSS property, so rules for other sizes and layers refine it', () => {
    expect(styleToCss('translateX', '-4px')).toEqual(['--_so-translate-x: -4px', SHIFT]);
    expect(styleToCss('translateY', ' 10% ')).toEqual(['--_so-translate-y: 10%', SHIFT]);
    expect(styleToCss('scale', 1.03)).toEqual(['scale: 1.03']);
    expect(styleToCss('scale', '0.95')).toEqual(['scale: 0.95']);
    expect(styleToCss('rotate', -2)).toEqual(['rotate: -2deg']);
    expect(styleToCss('transformOrigin', 'top left')).toEqual(['transform-origin: top left']);
    expect(styleToCss('transition', 'none')).toEqual(['transition-property: none']);
    expect(styleToCss('transition', 'shadow')).toEqual(['transition-property: box-shadow']);
    expect(styleToCss('transition', 'transform')).toEqual(['transition-property: translate, scale, rotate, transform']);
    expect(styleToCss('transition', 'colors')).toEqual(['transition-property: color, background-color, border-color, text-decoration-color, fill, stroke']);
    expect(styleToCss('transition', 'opacity')).toEqual(['transition-property: opacity']);
    expect(styleToCss('transition', 'common')).toEqual(['transition-property: color, background-color, border-color, text-decoration-color, fill, stroke, box-shadow, opacity, translate, scale, rotate, transform']);
    expect(styleToCss('transitionDuration', 600)).toEqual(['transition-duration: 600ms']);
    expect(styleToCss('transitionEasing', 'linear')).toEqual(['transition-timing-function: linear']);
    expect(styleToCss('transitionEasing', 'smooth')).toEqual(['transition-timing-function: cubic-bezier(0.2, 0, 0, 1)']);
    expect(styleToCss('transitionEasing', 'overshoot')).toEqual(['transition-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1)']);
    expect(styleToCss('transitionEasing', 'ease-out')).toEqual(['transition-timing-function: ease-out']);
  });

  it('starts the element from zero shift and a working preset duration, beneath every rule that names it', () => {
    expect(styleFallbackCss('translateX', '8px')).toEqual(['--_so-translate-x: 0px', '--_so-translate-y: 0px']);
    expect(styleFallbackCss('translateY', '-4px')).toEqual(['--_so-translate-x: 0px', '--_so-translate-y: 0px']);
    expect(styleFallbackCss('transition', 'colors')).toEqual(['transition-duration: 200ms']);
    expect(styleFallbackCss('transition', 'none')).toEqual([]);
    expect(styleFallbackCss('transition', ' none ')).toEqual([]);
    expect(styleFallbackCss('scale', 1.1)).toEqual([]);
    // A value that writes nothing brings nothing beneath it either.
    expect(styleFallbackCss('translateX', '9999px')).toEqual([]);
    expect(styleFallbackCss('transition', 'all')).toEqual([]);
  });

  it('writes nothing for a hand-edited value outside the grammar', () => {
    for (const [id, bad] of [
      ['translateX', '9999px'], ['translateY', 'calc(100vh)'], ['scale', 99], ['scale', '0x2'], ['rotate', 'banana'], ['rotate', 720],
      ['transformOrigin', '50% 50%'], ['transition', 'all'], ['transitionDuration', -1], ['transitionDuration', 3001], ['transitionDuration', 12.5], ['transitionEasing', 'steps(2)'],
      ['scale', null], ['rotate', null], ['transitionDuration', null], ['rotate', true], ['translateX', false]
    ] as Array<[string, string | number]>)
      expect(styleToCss(id, bad), `${id}: ${bad}`).toEqual([]);
    expect(styleToCss('rotate', { token: 'space.lg' })).toEqual([]);
  });

  it('never outranks the reduced-motion rule in the theme', () => {
    // The theme turns every transition off for visitors who ask for less motion, with !important.
    // Every element, with the weight of an id none has (`:not(#so-motion)`), so a placement's important styles lose too.
    expect(FOUNDATION_BASE_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\}\s*:not\(#so-motion\), :not\(#so-motion\)::before, :not\(#so-motion\)::after \{ transition-duration: 0\.01ms !important;/);
    const s = fresh();
    const inst = instanceOf(s, 'hero.split');
    inst.overrides = { root: { base: { transition: 'common', transitionDuration: 3000, transitionEasing: 'overshoot', translateY: '-4px', scale: 1.05, rotate: 2 } } };
    const site = css(s, 'site');
    expect(site).toContain('transition-duration: 3000ms');
    expect(site.replace(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/, '')).not.toMatch(/!important/);
    expect(generateProject(s).get(`${STYLES_DIR}/theme.css`)).toContain('transition-duration: 0.01ms !important');
    // The generated CSS also turns its own transitions off, for a theme without that rule.
    const cls = `so-o-${inst.id}-root`;
    const reduced = `:where(.${cls}.${cls}) {\n\t\ttransition-duration: 0.01ms !important;\n\t\ttransition-delay: 0s !important;\n\t}`;
    expect(section(site, '(prefers-reduced-motion: reduce)')).toContain(reduced);
    // A duration alone animates every property, so it is turned off too, once however many sizes set it.
    inst.overrides = { root: { phone: { transitionDuration: 300 }, desktop: { transitionDuration: 500 } } };
    expect(section(css(s, 'site'), '(prefers-reduced-motion: reduce)')).toBe(`\t${reduced}`);
    // A preset of none animates nothing, so it needs no rule there.
    inst.overrides = { root: { base: { transition: 'none', translateY: '-4px' } } };
    expect(css(s, 'site')).not.toContain('prefers-reduced-motion');
  });

  it('sets and clears them through node.setStyle, refusing what is out of range', () => {
    const s = fresh();
    const hero = instanceOf(s, 'hero.split');
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    const set = (property: string, value: string | number | null, scope: 'base' | 'phone' = 'base') => ({ type: 'node.setStyle' as const, owner, nodeId: hero.id, scope, property, value });
    const out = applyOperations(s, [set('translateY', '-4px'), set('rotate', -2), set('transition', 'transform'), set('transitionDuration', 250)]);
    const root = () => (out.state.pages[s.site.homePageId].nodes[hero.id] as InstanceNode).overrides?.root;
    expect(root()?.base).toMatchObject({ translateY: '-4px', rotate: -2, transition: 'transform', transitionDuration: 250 });
    expect(() => applyOperations(out.state, [set('scale', 4)])).toThrow(/at most 3/);
    expect(() => applyOperations(out.state, [set('translateX', '600px')])).toThrow(/not a valid shift/);
    const cleared = applyOperations(out.state, [set('rotate', null)]);
    expect((cleared.state.pages[s.site.homePageId].nodes[hero.id] as InstanceNode).overrides?.root?.base?.rotate).toBeUndefined();
  });

  it('lets each axis come from a different size and layer, and starts each element from zero', () => {
    const s = fresh();
    const def = defOf(s, 'features.grid');
    def.tree!.nodes.grid.styles = { base: { translateX: '12px', translateY: '2px', transition: 'colors', transitionDuration: 600, transitionEasing: 'linear' } };
    const inst = instanceOf(s, 'features.grid');
    inst.overrides = { grid: { phone: { translateY: '-4px', transition: 'shadow' } } };
    const components = css(s, 'components');
    const node = '.so-foundation-features-grid__grid';
    expect(ruleOf(section(components, null), `:where(${node})`)).toBe(`:where(${node}) {\n\ttransition-duration: 200ms;\n\t--_so-translate-x: 0px;\n\t--_so-translate-y: 0px;\n`);
    // Both axes write the same translate once, and nothing else is merged.
    const own = ruleOf(section(components, null), node);
    expect(own).toContain('--_so-translate-x: 12px');
    expect(own).toContain('--_so-translate-y: 2px');
    expect(own.split(SHIFT).length - 1).toBe(1);
    expect(own).toContain('transition-duration: 600ms');
    // The placement's phone rule sets only its own axis and preset: the definition's X and timing still apply.
    const cls = `so-o-${inst.id}-grid`;
    const phone = section(css(s, 'site'), PHONE);
    const decls = (rule: string) => rule.split('\n').slice(1).map((d) => d.trim()).filter(Boolean);
    expect(decls(ruleOf(phone, `.${cls}.${cls}`))).toEqual(['transition-property: box-shadow;', '--_so-translate-y: -4px;', `${SHIFT};`]);
    expect(decls(ruleOf(phone, `:where(.${cls}.${cls})`))).toEqual(['transition-duration: 200ms;', '--_so-translate-x: 0px;', '--_so-translate-y: 0px;']);
    expect(section(css(s, 'site'), null)).not.toContain(cls);
  });

  it('keeps the starting values at zero specificity in a component converted to code', () => {
    const s = fresh();
    const def = defOf(s, 'features.grid');
    def.tree!.nodes.grid.styles = { base: { translateY: '-4px' }, phone: { transition: 'shadow' } };
    const source = generateStandaloneComponent(s, def);
    expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\n\t\t:global\(:where\(\.so-foundation-features-grid__grid\)\) \{\n\t\t\ttransition-duration: 0\.01ms !important;/);
    expect(source).toContain(':global(:where(.so-foundation-features-grid__grid)) {\n\t\t--_so-translate-x: 0px;\n\t\t--_so-translate-y: 0px;\n\t}');
    expect(source).toContain(`:global(.so-foundation-features-grid__grid) {\n\t\t--_so-translate-y: -4px;\n\t\t${SHIFT};\n\t}`);
  });

  it('leaves custom CSS as written, repeats and all', () => {
    const s = fresh();
    const inst = instanceOf(s, 'hero.split');
    inst.overrides = { root: { base: { fontSize: '24px', opacity: 0.5, customCss: 'font-size: 24px' } } };
    const cls = `so-o-${inst.id}-root`;
    expect(ruleOf(css(s, 'site'), `.${cls}.${cls}`).split('font-size: 24px').length - 1).toBe(2);
  });

  it('writes no rule for a variant entry naming a node the design does not have', () => {
    const s = fresh();
    const def = defOf(s, 'features.grid');
    def.variantAxes!.layout.options['two-columns'].styles = { 'grid,': { base: { transition: 'opacity' } } };
    const out = css(s, 'components');
    expect(out).not.toContain('__grid,');
    expect(out).not.toContain('transition');
  });
});
