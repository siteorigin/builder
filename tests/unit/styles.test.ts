import { describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState, ResponsiveStyles } from '@shared/types';
import { STYLE_PROPS, STYLE_PROP_MAP, parseCustomCss, styleSetFor, styleToCss, validateStyleValue } from '@shared/styles';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { installComponent, makeInstance } from '@engine/install';
import { STYLES_DIR, generateProject } from '@generator/index';

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

describe('style registry', () => {
  it('emits a declaration for every property it offers', () => {
    const sample: Record<string, unknown> = {
      layout: 'grid', columns: 2, align: 'center', justify: 'center', order: 1, wrap: true, gridTemplate: '1fr 2fr', columnSpan: 2, alignSelf: 'center',
      flexGrow: 1, flexShrink: 0, textStyle: 'text.h2', fontFamily: 'serif', fontWeight: '600', fontStyle: 'italic', textTransform: 'uppercase',
      textAlign: 'center', color: '#000', background: '#fff', shadow: '0 1px 2px #000', opacity: 0.5, marginInline: 'auto', aspectRatio: '16/9',
      objectFit: 'cover', objectPosition: 'top', overflow: 'clip', position: 'sticky', inset: '0', zIndex: 2, hidden: true, customCss: 'filter: blur(2px)',
      width: 'fill', border: '1px solid #000', borderBlockStart: '1px solid #000', borderBlockEnd: '1px solid #000', borderInlineStart: '1px solid #000', borderInlineEnd: '1px solid #000'
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
  const VARIANT = '.so-foundation-features-grid--layout-two-columns .so-foundation-features-grid__grid';

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
    for (const q of [PHONE, TABLET]) expect(ruleOf(section(out, q), '.so-foundation-features-grid--layout-two-columns .so-foundation-features-grid__heading')).toContain('display: revert');
    expect(section(out, null)).not.toMatch(/--layout-two-columns \.so-foundation-features-grid__heading \{[^}]*display/);
  });

  it('restores display only where a part is hidden, leaving other ranges their own layout', () => {
    const s = fresh();
    const def = defOf(s, 'features.grid');
    def.tree!.nodes.grid.styles = { base: { layout: 'grid' }, phone: { hidden: true }, tablet: { layout: 'stack' } };
    def.variantAxes!.layout.options['two-columns'].styles = { grid: { base: { hidden: false } } };
    const out = css(s, 'components');
    expect(ruleOf(section(out, PHONE), VARIANT)).toContain('display: grid');
    expect(section(out, TABLET)).not.toContain(VARIANT);
    expect(section(out, null)).not.toMatch(/--layout-two-columns \.so-foundation-features-grid__grid \{[^}]*display/);
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
