import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type InstanceNode, type LinkNode, type ProjectState, type ResponsiveStyles } from '@shared/types';
import { validateOperation, type EditOperation } from '@shared/ops';
import { tokenUsageCounts } from '@engine/tokens';
import { validateState } from '@engine/validate';
import { MIGRATIONS } from '@shared/migrations';
import { STYLE_PROPS, STYLE_PROP_MAP, gridTemplateShares, isStateStyleProp, parseCustomCss, styleFallbackCss, styleSetFor, styleToCss, validateStyleValue, wideOnlyStyle } from '@shared/styles';
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

describe('grid tracks and row spans (#352)', () => {
  const tracks = (v: string) => styleToCss('gridTemplate', v);

  it('writes the presets exactly as before', () => {
    expect(tracks('1fr 1fr')).toEqual(['grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)']);
    expect(tracks('1fr 2fr')).toEqual(['grid-template-columns: minmax(0, 1fr) minmax(0, 2fr)']);
    expect(tracks('2fr 1fr')).toEqual(['grid-template-columns: minmax(0, 2fr) minmax(0, 1fr)']);
    expect(tracks('1fr 1.5fr')).toEqual(['grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr)']);
    expect(tracks('1.5fr 1fr')).toEqual(['grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr)']);
    expect(tracks('auto-fit-sm')).toEqual(['grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr))']);
    expect(tracks('auto-fit-md')).toEqual(['grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr))']);
    expect(STYLE_PROP_MAP.gridTemplate.options!.map((o) => o.value)).toEqual(['1fr 1fr', '1fr 2fr', '2fr 1fr', '1fr 1.5fr', '1.5fr 1fr', 'auto-fit-sm', 'auto-fit-md']);
    for (const o of STYLE_PROP_MAP.gridTemplate.options!) expect(validateStyleValue('gridTemplate', o.value), o.value).toBeNull();
  });

  it('takes a custom list of fr shares, lengths, auto, minmax() and repeat()', () => {
    expect(tracks('16rem 1fr 14rem')).toEqual(['grid-template-columns: 16rem minmax(0, 1fr) 14rem']);
    expect(tracks('2fr repeat(2, 1fr)')).toEqual(['grid-template-columns: minmax(0, 2fr) repeat(2, minmax(0, 1fr))']);
    expect(tracks('minmax(10rem, 1fr) auto max-content')).toEqual(['grid-template-columns: minmax(10rem, 1fr) auto max-content']);
    expect(tracks('minmax(0, 2fr) 25%')).toEqual(['grid-template-columns: minmax(0, 2fr) 25%']);
    // Math is floored at zero, so a minifier folding it never writes a negative size the browser would drop.
    expect(tracks('clamp(12rem, 20vw, 16rem) 1fr')).toEqual(['grid-template-columns: max(0px, clamp(12rem, 20vw, 16rem)) minmax(0, 1fr)']);
    expect(tracks('calc(1px - 2px) minmax(calc(10rem - 1px), 1fr)')).toEqual(['grid-template-columns: max(0px, calc(1px - 2px)) minmax(max(0px, calc(10rem - 1px)), 1fr)']);
    expect(tracks('min(20rem, 30%) max(8rem, 10vw)')).toEqual(['grid-template-columns: max(0px, min(20rem, 30%)) max(0px, max(8rem, 10vw))']);
    // Case and spacing as typed change nothing but the spaces between columns.
    expect(tracks('  1FR\t 16REM  AUTO ')).toEqual(['grid-template-columns: minmax(0, 1fr) 16REM auto']);
    expect(tracks('minmax( 10rem ,1fr )')).toEqual(['grid-template-columns: minmax(10rem, 1fr)']);
  });

  it('takes a minimum card width for as many columns as fit, never wider than the grid', () => {
    expect(tracks('repeat(auto-fit, minmax(18rem, 1fr))')).toEqual(['grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr))']);
    expect(tracks('repeat(auto-fill, minmax(240px, 1fr))')).toEqual(['grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr))']);
    expect(tracks('REPEAT(AUTO-FILL, 200px)')).toEqual(['grid-template-columns: repeat(auto-fill, min(100%, 200px))']);
    expect(tracks('repeat(auto-fit, minmax(16rem, auto))')).toEqual(['grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), auto))']);
    expect(tracks('repeat(auto-fill, minmax(18rem, 30rem))')).toEqual(['grid-template-columns: repeat(auto-fill, minmax(min(100%, 18rem), 30rem))']);
  });

  it('reads the fr shares image sizing needs', () => {
    expect(gridTemplateShares('2fr repeat(2, 1fr)')).toEqual([2, 1, 1]);
    expect(gridTemplateShares('minmax(0, 3fr) 1fr')).toEqual([3, 1]);
    expect(gridTemplateShares('1fr 2fr')).toEqual([1, 2]);
    // As many as fit, a fixed or content-sized column, or nothing the stylesheet writes: no known shares.
    for (const v of ['auto-fit-sm', 'repeat(auto-fill, 12rem)', 'repeat(99, 1fr)', 5, '16rem 1fr', 'minmax(10rem, 1fr) 1fr', 'auto 1fr', '25% 1fr']) expect(gridTemplateShares(v), String(v)).toBeNull();
  });

  it('counts at most 12 columns, repeats included', () => {
    expect(validateStyleValue('gridTemplate', Array(12).fill('1fr').join(' '))).toBeNull();
    expect(validateStyleValue('gridTemplate', Array(13).fill('1fr').join(' '))).toMatch(/more than 12 columns/);
    expect(validateStyleValue('gridTemplate', 'repeat(6, 1fr) repeat(3, 1fr 2fr)')).toBeNull();
    expect(validateStyleValue('gridTemplate', 'repeat(6, 1fr) repeat(3, 1fr 2fr) auto')).toMatch(/more than 12 columns/);
    expect(validateStyleValue('gridTemplate', 'repeat(7, 1fr 1fr)')).toMatch(/column sizes/);
    expect(validateStyleValue('gridTemplate', 'repeat(12, 1fr)')).toBeNull();
    expect(tracks('repeat(13, 1fr)')).toEqual([]);
    // At most 300 characters, however valid the columns.
    const long = (n: number) => Array(n).fill('minmax(1.0000000000000rem, 1fr)').join(' ');
    expect(long(9).length).toBeLessThanOrEqual(300);
    expect(validateStyleValue('gridTemplate', long(9))).toBeNull();
    expect(validateStyleValue('gridTemplate', long(12))).toMatch(/column sizes/);
  });

  it('refuses anything outside the grammar, and writes nothing for it from a hand-edited document', () => {
    const bad = [
      'minmax(10rem,, 1fr)', 'minmax(10rem, 1fr,)', 'minmax(10rem)', 'minmax(1fr, 2fr)', 'minmax(minmax(1px, 2px), 1fr)', '0fr 1fr', '-1fr', '-10px 1fr', '1fr 2',
      '1fr var(--so-space-lg)', '[side] 16rem 1fr', 'subgrid', 'none', 'masonry', 'fit-content(10rem) 1fr', '1fr,2fr', 'repeat(0, 1fr)', 'repeat(2.5, 1fr)',
      'repeat(2, repeat(2, 1fr))', 'repeat(2,)', 'repeat(auto-fit, minmax(0, 1fr))', 'repeat(auto-fit, 0px)', 'repeat(auto-fit, 1fr)', 'repeat(auto-fit, minmax(1fr, 2fr))',
      'repeat(auto-fit, minmax(18rem, 1fr)) 1fr', '1fr repeat(auto-fill, 10rem)', 'repeat(auto-fit, minmax(18rem, 1fr), 2)', 'repeat(auto-fit, minmax(-4rem, 1fr))',
      'repeat(auto-fill, calc(1px - 2px))', 'repeat(auto-fit, minmax(.0rem, 1fr))',
      'minmax(10rem, 1fr', '1fr) (2fr', 'calc(1px + var(--x)) 1fr', 'attr(data-x) 1fr', '1fr; color: red', '1fr } body { display: none', '',
      // Math nested deeper than browsers read.
      `calc(${'('.repeat(20)}1px${')'.repeat(21)} 1fr`
    ];
    for (const v of bad) {
      expect(validateStyleValue('gridTemplate', v), v).not.toBeNull();
      expect(tracks(v), v).toEqual([]);
    }
    expect(validateStyleValue('gridTemplate', 2 as never)).toMatch(/must be text/);
    expect(validateStyleValue('gridTemplate', `${'1fr '.repeat(80)}`)).toMatch(/column sizes/);
  });

  it('spans one to six rows', () => {
    for (const v of ['1', '2', '6', 3, ' 4 ']) expect(validateStyleValue('rowSpan', v as string), String(v)).toBeNull();
    for (const v of ['0', '7', 'full', 1.5, '2 / 3']) expect(validateStyleValue('rowSpan', v as string), String(v)).not.toBeNull();
    for (let n = 1; n <= 6; n++) expect(styleToCss('rowSpan', n)).toEqual([`grid-row: span ${n} / span ${n}`]);
    expect(styleToCss('rowSpan', ' 6 ')).toEqual(['grid-row: span 6 / span 6']);
    expect(styleToCss('rowSpan', 9)).toEqual([]);
    // A hand-edited object is no span: nothing written, and nothing thrown on the way.
    const odd = { toString: null } as never;
    expect(styleToCss('rowSpan', odd)).toEqual([]);
    expect(wideOnlyStyle('rowSpan', odd)).toBe(false);
    expect(wideOnlyStyle('columnSpan', odd)).toBe(false);
    expect(wideOnlyStyle('rowSpan', ' 2 ')).toBe(true);
    expect(wideOnlyStyle('rowSpan', 1)).toBe(false);
    for (const kind of ['text', 'image', 'link', 'icon', 'element']) expect(styleSetFor({ kind }), kind).toContain('rowSpan');
  });

  it('keeps custom columns and tall spans off phones unless set for phones', () => {
    let s = createStarterState('blank', 'Blank', false);
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    const host = home(s).rootIds[0];
    const r = applyOperations(s, [{ type: 'node.insert', owner, parentId: host, slot: 'content', primitive: 'grid' }]);
    const gridId = r.results[0].nodeId as string;
    const c = applyOperations(r.state, [{ type: 'node.insert', owner, parentId: gridId, primitive: 'stack' }]);
    const itemId = c.results[0].nodeId as string;
    const set = (nodeId: string, scope: 'base' | 'phone', property: string, value: string | number) => ({ type: 'node.setStyle' as const, owner, nodeId, scope, property, value });
    s = applyOperations(c.state, [set(gridId, 'base', 'gridTemplate', 'repeat(auto-fit, minmax(18rem, 1fr))'), set(itemId, 'base', 'rowSpan', '2'), set(itemId, 'base', 'columnSpan', '2')]).state;
    let text = css(s, 'site');
    const grid = `.so-n-${gridId}`;
    const item = `.so-n-${itemId}`;
    expect(ruleOf(section(text, WIDE), grid)).toContain('grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr))');
    expect(ruleOf(section(text, WIDE), item)).toContain('grid-row: span 2 / span 2');
    expect(ruleOf(section(text, WIDE), item)).toContain('grid-column: span 2 / span 2');
    expect(section(text, null)).not.toContain('18rem');
    expect(section(text, null)).not.toContain('grid-row');
    expect(section(text, null)).not.toContain('grid-column');
    expect(section(text, PHONE)).not.toContain('grid-row');
    // Set for phones, they apply there too.
    s = applyOperations(s, [set(gridId, 'phone', 'gridTemplate', '5rem 1fr'), set(itemId, 'phone', 'rowSpan', 3)]).state;
    text = css(s, 'site');
    expect(ruleOf(section(text, PHONE), grid)).toContain('grid-template-columns: 5rem minmax(0, 1fr)');
    expect(ruleOf(section(text, PHONE), item)).toContain('grid-row: span 3 / span 3');
    // A single-row span changes nothing on a phone, so it applies at every size.
    s = applyOperations(s, [set(itemId, 'base', 'rowSpan', '1')]).state;
    expect(ruleOf(section(css(s, 'site'), null), item)).toContain('grid-row: span 1 / span 1');
  });

  it('refuses a bad track list through node.setStyle and keeps the one stored', () => {
    const s = createStarterState('blank', 'Blank', false);
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    const r = applyOperations(s, [{ type: 'node.insert', owner, parentId: home(s).rootIds[0], slot: 'content', primitive: 'grid' }]);
    const gridId = r.results[0].nodeId as string;
    const ok = applyOperations(r.state, [{ type: 'node.setStyle', owner, nodeId: gridId, scope: 'base', property: 'gridTemplate', value: '16rem 1fr 14rem' }]).state;
    expect(home(ok).nodes[gridId].styles?.base?.gridTemplate).toBe('16rem 1fr 14rem');
    // Kept on one line with single spaces, as the inspector's field shows it.
    const spaced = applyOperations(ok, [{ type: 'node.setStyle', owner, nodeId: gridId, scope: 'base', property: 'gridTemplate', value: ' 16rem\n  minmax( 0 , 1fr )\t14rem ' }]).state;
    expect(home(spaced).nodes[gridId].styles?.base?.gridTemplate).toBe('16rem minmax( 0 , 1fr ) 14rem');
    expect(() => applyOperations(ok, [{ type: 'node.setStyle', owner, nodeId: gridId, scope: 'base', property: 'gridTemplate', value: '1fr url(x)' }])).toThrow(/Invalid characters/);
    expect(() => applyOperations(ok, [{ type: 'node.setStyle', owner, nodeId: gridId, scope: 'base', property: 'gridTemplate', value: 'minmax(1fr, 2fr)' }])).toThrow(/column sizes/);
    expect(() => applyOperations(ok, [{ type: 'node.setStyle', owner, nodeId: gridId, scope: 'base', property: 'rowSpan', value: 7 }])).toThrow(/must be one of/);
  });
});

describe('style registry', () => {
  it('emits a declaration for every property it offers', () => {
    const sample: Record<string, unknown> = {
      layout: 'grid', columns: 2, align: 'center', justify: 'center', order: 1, wrap: true, gridTemplate: '1fr 2fr', columnSpan: 2, rowSpan: 2, alignSelf: 'center',
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
    expect(validateStyleValue('gridTemplate', 'repeat(99, 1fr)')).toMatch(/column sizes/);
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

describe('backdrop blur (#353)', () => {
  it('is an advanced appearance control on elements and text, which hover and focus may change', () => {
    expect(STYLE_PROP_MAP.backdropBlur).toMatchObject({ group: 'appearance', kind: 'length', advanced: true });
    for (const kind of ['element', 'text', 'link']) expect(styleSetFor({ kind }), kind).toContain('backdropBlur');
    expect(styleSetFor({ kind: 'image' })).not.toContain('backdropBlur');
    expect(isStateStyleProp('backdropBlur')).toBe(true);
  });

  it('accepts 0 or one px, rem or em length up to its limit, and nothing else', () => {
    for (const ok of ['0', '0px', '4px', '12px', '.5rem', '0.75em', '64px', '4rem', '4em', ' 12px ', 0])
      expect(validateStyleValue('backdropBlur', ok), String(ok)).toBeNull();
    for (const bad of ['64.1px', '64.5px', '4.1rem', '4.1em', '-4px', '+4px', '10%', '1vw', '4', 'auto', 'none', 'blur(4px)', '4px 4px', 'calc(4px + 1px)', 'var(--x)', '1e2px', 4])
      expect(validateStyleValue('backdropBlur', bad as string), String(bad)).toMatch(/not a valid blur/);
    expect(validateStyleValue('backdropBlur', { token: 'space.lg' })).toMatch(/cannot use a token/);
  });

  it('writes the prefixed and standard property together, and none for no blur', () => {
    expect(styleToCss('backdropBlur', '12px')).toEqual(['-webkit-backdrop-filter: blur(12px)', 'backdrop-filter: blur(12px)']);
    expect(styleToCss('backdropBlur', ' 0.5rem ')).toEqual(['-webkit-backdrop-filter: blur(0.5rem)', 'backdrop-filter: blur(0.5rem)']);
    for (const none of ['0', '0px', 0]) expect(styleToCss('backdropBlur', none), String(none)).toEqual(['-webkit-backdrop-filter: none', 'backdrop-filter: none']);
    // A hand-edited document outside the grammar writes nothing.
    for (const bad of ['999px', '10%', 'blur(4px)', '4', true, { token: 'space.lg' }]) expect(styleToCss('backdropBlur', bad as string), String(bad)).toEqual([]);
  });

  it('sets, clears and writes it for a placement, beside a hover that clears it', () => {
    const s = fresh();
    const hero = instanceOf(s, 'hero.split');
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    const set = (property: string, value: string | null, state?: 'hover') => ({ type: 'node.setStyle' as const, owner, nodeId: hero.id, scope: 'base', ...(state ? { state } : {}), property, value }) as EditOperation;
    const out = applyOperations(s, [set('backdropBlur', '12px'), set('backdropBlur', '0', 'hover')]);
    const root = () => (out.state.pages[s.site.homePageId].nodes[hero.id] as InstanceNode).overrides?.root;
    expect(root()?.base?.backdropBlur).toBe('12px');
    expect(root()?.['base:hover']).toEqual({ backdropBlur: '0' });
    expect(() => applyOperations(out.state, [set('backdropBlur', '100px')])).toThrow(/not a valid blur/);
    const cls = `so-o-${hero.id}-root`;
    const site = css(out.state, 'site');
    expect(ruleOf(site, `.${cls}.${cls}`)).toContain('-webkit-backdrop-filter: blur(12px);\n\tbackdrop-filter: blur(12px);');
    expect(site).toMatch(new RegExp(`\\.${cls}[^{}]*:hover[^{}]*\\{\\s*-webkit-backdrop-filter: none;\\s*backdrop-filter: none;`));
    const cleared = applyOperations(out.state, [set('backdropBlur', null)]);
    expect((cleared.state.pages[s.site.homePageId].nodes[hero.id] as InstanceNode).overrides?.root?.base?.backdropBlur).toBeUndefined();
  });
});

describe('see-through site colors (#353)', () => {
  const MIX = 'color-mix(in srgb, var(--so-color-surface) 70%, transparent)';

  it('lets a color or background link paint its site color at part strength, from 0 to 1', () => {
    for (const prop of ['background', 'color'])
      for (const alpha of [0, 0.05, 0.7, 1]) expect(validateStyleValue(prop, { token: 'color.surface', alpha }), `${prop} ${alpha}`).toBeNull();
    for (const prop of ['background', 'color'])
      for (const alpha of [-0.1, 1.001, 1.01, Number.NaN, Infinity, '0.7', null, true])
        expect(validateStyleValue(prop, { token: 'color.surface', alpha } as never), `${prop} ${String(alpha)}`).toMatch(/strength \("alpha"\) must be a number from 0 to 1/);
    // Only a color can be see-through, even at full strength, and a link holds nothing else.
    expect(validateStyleValue('gap', { token: 'space.lg', alpha: 0.5 })).toMatch(/full strength/);
    expect(validateStyleValue('gap', { token: 'space.lg', alpha: 1 })).toMatch(/full strength/);
    expect(validateStyleValue('shadow', { token: 'shadow.sm', alpha: 0.5 })).toMatch(/full strength/);
    expect(validateStyleValue('background', { token: 'color.surface', opacity: 0.5 } as never)).toMatch(/holds "token" and "alpha" only, not "opacity"/);
    expect(validateStyleValue('gap', { token: 'space.lg', x: 1 } as never)).toMatch(/holds "token" only, not "x"/);
    expect(validateStyleValue('background', { token: 'space.lg', alpha: 0.5 })).toMatch(/needs a color token/);
  });

  it('writes a link below full strength as its variable mixed with transparent, and a full one as the variable', () => {
    expect(styleToCss('background', { token: 'color.surface', alpha: 0.7 })).toEqual([`background: ${MIX}`]);
    expect(styleToCss('color', { token: 'color.text', alpha: 0.555 })).toEqual(['color: color-mix(in srgb, var(--so-color-text) 55.5%, transparent)']);
    expect(styleToCss('background', { token: 'color.surface', alpha: 0 })).toEqual(['background: color-mix(in srgb, var(--so-color-surface) 0%, transparent)']);
    expect(styleToCss('background', { token: 'color.surface', alpha: 1 })).toEqual(['background: var(--so-color-surface)']);
    expect(styleToCss('background', { token: 'color.surface' })).toEqual(['background: var(--so-color-surface)']);
    // A theme's token may have any ID: one replacing another at part strength still writes.
    expect(styleToCss('background', { token: 'brand', alpha: 0.5 })).toEqual(['background: color-mix(in srgb, var(--so-brand) 50%, transparent)']);
    // A hand-edited link outside the grammar writes nothing, on a color or anywhere else.
    for (const [prop, bad] of [
      ['background', { token: 'color.surface', alpha: 2 }],
      ['background', { token: 'color.surface', alpha: '0.5' }],
      ['background', { token: 'color.surface', alpha: 0.5, x: 1 }],
      ['gap', { token: 'space.lg', alpha: 0.5 }],
      ['radius', { token: 'radius.md', alpha: 0.5 }]
    ] as Array<[string, never]>)
      expect(styleToCss(prop, bad), `${prop} ${JSON.stringify(bad)}`).toEqual([]);
  });

  it('keeps the strength through the edit boundary, stored token first and dropped at full strength', () => {
    const s = fresh();
    const hero = instanceOf(s, 'hero.split');
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    const op = (value: unknown, property = 'background') => {
      const checked = validateOperation({ type: 'node.setStyle', owner, nodeId: hero.id, scope: 'base', property, value });
      if (!checked.ok) throw new Error(checked.message);
      return checked.op;
    };
    const base = (st: ProjectState) => (home(st).nodes[hero.id] as InstanceNode).overrides?.root?.base;
    let out = applyOperations(s, [op({ alpha: 0.7, token: 'color.surface' }), op('12px', 'backdropBlur')]).state;
    expect(base(out)).toEqual({ background: { token: 'color.surface', alpha: 0.7 }, backdropBlur: '12px' });
    // Stored token first whatever order it was sent in, past the schema too.
    const direct = applyOperations(s, [{ type: 'node.setStyle', owner, nodeId: hero.id, scope: 'base', property: 'background', value: { alpha: 0.7, token: 'color.surface' } as never }]).state;
    expect(Object.keys(base(direct)!.background as object)).toEqual(['token', 'alpha']);
    const cls = `so-o-${hero.id}-root`;
    const rule = ruleOf(css(out, 'site'), `.${cls}.${cls}`);
    for (const d of [`background: ${MIX};`, '-webkit-backdrop-filter: blur(12px);', 'backdrop-filter: blur(12px);']) expect(rule).toContain(d);
    expect(tokenUsageCounts(out)['color.surface']).toBe((tokenUsageCounts(s)['color.surface'] ?? 0) + 1);
    // Full strength is the plain link; a plain link sets a see-through one back to full.
    expect(base(applyOperations(out, [op({ token: 'color.surface', alpha: 1 })]).state)?.background).toEqual({ token: 'color.surface' });
    out = applyOperations(out, [op({ token: 'color.surface' })]).state;
    expect(base(out)?.background).toEqual({ token: 'color.surface' });
    // A link with a key it cannot hold is refused at the boundary rather than stripped.
    expect(validateOperation({ type: 'node.setStyle', owner, nodeId: hero.id, scope: 'base', property: 'background', value: { token: 'color.surface', opacity: 0.5 } }).ok).toBe(false);
    expect(() => applyOperations(s, [op({ token: 'space.lg', alpha: 0.5 }, 'gap')])).toThrow(/full strength/);
    expect(() => applyOperations(s, [op({ token: 'color.surface', alpha: 1.5 })])).toThrow(/from 0 to 1/);
  });

  it('keeps the strength when its site color is replaced, and when the color is kept as a value', () => {
    let s = fresh();
    const hero = instanceOf(s, 'hero.split');
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    s = applyOperations(s, [
      { type: 'token.create', group: 'color', label: 'Glass', value: 'rgb(255 255 255 / 0.5)' },
      { type: 'token.create', group: 'color', label: 'Sea', value: '#2e8b57' }
    ]).state;
    const [glass, sea] = s.tokens.custom.map((t) => t.id);
    // As a hand-edited document may hold it, with a line break after the color.
    s.tokens.custom[0].value = 'rgb(255 255 255 / 0.5)\n';
    s = applyOperations(s, [
      { type: 'node.setStyle', owner, nodeId: hero.id, scope: 'base', property: 'background', value: { token: sea, alpha: 0.4 } },
      { type: 'node.setStyle', owner, nodeId: hero.id, scope: 'phone', state: 'hover', property: 'color', value: { token: sea } }
    ]).state;
    const root = (st: ProjectState) => (home(st).nodes[hero.id] as InstanceNode).overrides?.root;
    expect(tokenUsageCounts(s)[sea]).toBe(2);
    const replaced = applyOperations(s, [{ type: 'token.replace', tokenId: sea, withTokenId: glass }]).state;
    expect(root(replaced)?.base?.background).toEqual({ token: glass, alpha: 0.4 });
    expect(root(replaced)?.['phone:hover']?.color).toEqual({ token: glass });
    // Kept as a value: the half-transparent color at 40% still paints at 20%, as the link did.
    const detached = applyOperations(replaced, [{ type: 'token.remove', tokenId: glass, detach: true }]).state;
    expect(root(detached)?.base?.background).toBe('color-mix(in srgb, rgb(255 255 255 / 0.5) 40%, transparent)');
    // At full strength the value is written as the site style held it, as before.
    expect(root(detached)?.['phone:hover']?.color).toBe('rgb(255 255 255 / 0.5)\n');
    expect(validateStyleValue('background', root(detached)!.base!.background)).toBeNull();
    // Removing it in favour of another style keeps the strength too.
    const moved = applyOperations(replaced, [{ type: 'token.remove', tokenId: glass, replacementTokenId: 'color.surface' }]).state;
    expect(root(moved)?.base?.background).toEqual({ token: 'color.surface', alpha: 0.4 });
  });

  it('paints a see-through button through its own variables, at rest and on hover', () => {
    const s = fresh();
    const page = home(s);
    page.nodes.n_link = { id: 'n_link', kind: 'link', link: { type: 'url', target: 'https://example.com/' }, label: 'Talk to us', appearance: 'primary' } as LinkNode;
    page.rootIds.push('n_link');
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    const out = applyOperations(s, [
      { type: 'node.setStyle', owner, nodeId: 'n_link', scope: 'base', property: 'background', value: { token: 'color.surface', alpha: 0.7 } },
      { type: 'node.setStyle', owner, nodeId: 'n_link', scope: 'base', state: 'hover', property: 'background', value: { token: 'color.surface', alpha: 0.9 } },
      { type: 'node.setStyle', owner, nodeId: 'n_link', scope: 'base', property: 'backdropBlur', value: '4px' }
    ]).state;
    const site = css(out, 'site');
    const rest = site.match(/([^{}\n]*n_link[^{}\n]*)\{([^}]*--so-btn-bg: color-mix[^}]*)\}/);
    expect(rest?.[1]).not.toMatch(/:hover|:focus|:active/);
    expect(rest?.[2]).toContain(`--so-btn-bg: ${MIX};`);
    expect(site).toMatch(/:hover[^{}]*\{[^}]*--so-btn-bg-hover: color-mix\(in srgb, var\(--so-color-surface\) 90%, transparent\);/);
    expect(site).toContain('backdrop-filter: blur(4px);');
    // A hand-edited strength the button cannot paint writes no hover variable on its own either.
    (home(out).nodes.n_link as LinkNode).styles = { base: { background: { token: 'color.surface', alpha: 3 } } };
    expect(css(out, 'site')).not.toContain('--so-btn-bg');
  });
});

describe('the document format for see-through colors and backdrop blur (#353)', () => {
  it('marks them with a version-only step, so an older editor opens such a project read-only', () => {
    const step = MIGRATIONS.at(-1)!;
    expect(step.id).toBe('style-strength');
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length + 1);
    const s = fresh();
    const out = structuredClone(s);
    step.migrate(out as never, () => true);
    expect(out).toEqual(s);
  });

  it('reports a strength or a blur the stylesheet would write nothing for, by the node and property', () => {
    const s = fresh();
    const hero = instanceOf(s, 'hero.split');
    hero.overrides = { root: { base: { background: { token: 'color.surface', alpha: 2 }, gap: { token: 'space.md', alpha: 0.5 }, backdropBlur: '65px', color: { token: 'color.text', alpha: 0.5 }, shadow: { token: 42 } as never } } };
    const found = validateState(s).filter((d) => d.code === 'STYLE_VALUE_INVALID');
    expect(found.map((d) => [d.severity, d.nodeId, d.site?.split('|').at(-1)])).toEqual([
      ['error', hero.id, 'background'],
      ['error', hero.id, 'gap'],
      ['error', hero.id, 'backdropBlur'],
      ['error', hero.id, 'shadow']
    ]);
    expect(found[0].message).toMatch(/from 0 to 1.*Nothing is written for it/);
  });
});
