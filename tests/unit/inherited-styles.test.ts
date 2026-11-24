import { describe, expect, it } from 'vitest';
import type { ComponentDefinition, InstanceNode, ProjectState, ResponsiveScope, ResponsiveStyles } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { styleToCss, VIEWPORT_PRESETS } from '@shared/styles';
import { designStyles } from '@shared/variants';
import { generateComponentsCss, generateSiteCss, nodeClass, overrideClass, variantClass } from '@generator/index';
import { readStyleNumber, refinementShown, styleReached, styleUnder } from '../../src/renderer/src/lib/style-source';
import { STYLE_PROP_MAP } from '@shared/styles';

// The Inspector's inherited style values are checked against the stylesheet the site really gets: the generated
// CSS is evaluated for one element at each preview width (selector classes, specificity, media queries and source
// order), and the value the Inspector shows for that size must be the one that wins there.

type Rule = { selector: string; media: string | null; decls: Array<[string, string]>; order: number };

function parseCss(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let order = 0;
  const close = (open: number) => {
    let depth = 0;
    for (let k = open; k < text.length; k++) {
      if (text[k] === '{') depth++;
      else if (text[k] === '}' && --depth === 0) return k;
    }
    throw new Error('Unbalanced CSS');
  };
  const parse = (from: number, to: number, media: string | null) => {
    let k = from;
    for (;;) {
      const open = text.indexOf('{', k);
      if (open === -1 || open >= to) return;
      const prelude = text.slice(k, open).trim();
      const end = close(open);
      if (prelude.startsWith('@media')) parse(open + 1, end, prelude.slice('@media'.length).trim());
      else {
        const decls = text
          .slice(open + 1, end)
          .split(';')
          .map((d) => d.trim())
          .filter(Boolean)
          .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()] as [string, string]);
        rules.push({ selector: prelude, media, decls, order: order++ });
      }
      k = end + 1;
    }
  };
  parse(0, text.length, null);
  return rules;
}

const mediaMatches = (query: string | null, width: number) =>
  !query ||
  query.split(/\s+and\s+/).every((part) => {
    const m = /\((min|max)-width:\s*([\d.]+)px\)/.exec(part);
    if (!m) throw new Error(`Unexpected media query ${query}`);
    return m[1] === 'min' ? width >= Number(m[2]) : width <= Number(m[2]);
  });

/** An element by its classes, and its ancestors' classes, nearest first. */
type El = { classes: string[]; ancestors: string[][] };
const compounds = (selector: string) => selector.split(/\s+/).map((c) => [...c.matchAll(/\.([\w-]+)/g)].map((m) => m[1]));

function matches(selector: string, el: El): boolean {
  if (/[,:>+~[]/.test(selector)) throw new Error(`Unexpected selector ${selector}`);
  const parts = compounds(selector);
  const self = parts.pop()!;
  if (!self.every((c) => el.classes.includes(c))) return false;
  let a = 0;
  for (let k = parts.length - 1; k >= 0; k--) {
    while (a < el.ancestors.length && !parts[k].every((c) => el.ancestors[a].includes(c))) a++;
    if (a++ >= el.ancestors.length) return false;
  }
  return true;
}

/** The value a CSS property ends up with on an element at a width, or undefined when no rule sets it. */
function computed(rules: Rule[], el: El, width: number, property: string): string | undefined {
  let best: { key: [number, number, number]; value: string } | undefined;
  for (const r of rules) {
    if (!mediaMatches(r.media, width) || !r.selector.includes('so-') || !matches(r.selector, el)) continue;
    const specificity = compounds(r.selector).flat().length;
    r.decls.forEach(([p, value], i) => {
      if (p !== property) return;
      const key: [number, number, number] = [specificity, r.order, i];
      if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && (key[1] > best.key[1] || (key[1] === best.key[1] && key[2] >= best.key[2])))) best = { key, value };
    });
  }
  return best?.value;
}

const SIZES = ['phone', 'tablet', 'desktop'] as const;
const WIDTH = { phone: VIEWPORT_PRESETS.phone, tablet: VIEWPORT_PRESETS.tablet, desktop: VIEWPORT_PRESETS.desktop };
const cssOf = (prop: string, value: unknown) => {
  const decl = styleToCss(prop, value as never)[0];
  return decl.slice(decl.indexOf(':') + 1).trim();
};

/** The Features grid of a fresh business site, with its variant styles replaced by the ones a case gives. */
function grid(setup: { node?: Record<string, ResponsiveStyles>; tone?: Record<string, ResponsiveStyles>; layout?: Record<string, ResponsiveStyles> }) {
  const state: ProjectState = createStarterState('business', 'Test Studio', false);
  const def = Object.values(state.components).find((d) => d.componentId === 'features.grid')!;
  for (const [id, styles] of Object.entries(setup.node ?? {})) def.tree!.nodes[id].styles = styles;
  def.variantAxes = {
    tone: { label: 'Tone', default: 'plain', options: { plain: { label: 'Plain', styles: setup.tone ?? {} } } },
    layout: { label: 'Layout', default: 'wide', options: { wide: { label: 'Wide', styles: setup.layout ?? {} } } }
  };
  return { state, def };
}

/**
 * A node of the design as the page renders it: the root carries the selected options' classes, and any other node
 * an axis styles carries that axis's option class too.
 */
function element(def: ComponentDefinition, nodeId: string, extra: string[] = []): El {
  const root = def.tree!.rootIds[0];
  const selected: Array<[string, string]> = [['tone', 'plain'], ['layout', 'wide']];
  const rootClasses = [nodeClass(def, root), ...selected.map(([axis, option]) => variantClass(def, axis, option))];
  const styledBy = (axis: string) => Object.values(def.variantAxes![axis].options).some((o) => !!o.styles?.[nodeId]);
  const own = selected.filter(([axis]) => styledBy(axis)).map(([axis, option]) => variantClass(def, axis, option));
  return nodeId === root ? { classes: [...rootClasses, ...extra], ancestors: [] } : { classes: [nodeClass(def, nodeId), ...own, ...extra], ancestors: [rootClasses] };
}

/** For each size: what the Inspector shows as inherited, and what the generated stylesheet renders. */
function compare(state: ProjectState, def: ComponentDefinition, nodeId: string, prop: 'columns' | 'gridTemplate' | 'columnSpan', property: string) {
  const rules = parseCss(generateComponentsCss(state));
  const inherited = designStyles(def, nodeId, undefined);
  return SIZES.map((size) => {
    const shown = inherited[size]?.[prop];
    return { size, shown: shown === undefined ? undefined : cssOf(prop, shown), rendered: computed(rules, element(def, nodeId), WIDTH[size], property) };
  });
}

function visibility(state: ProjectState, def: ComponentDefinition, nodeId: string) {
  const rules = parseCss(generateComponentsCss(state));
  const inherited = designStyles(def, nodeId, undefined);
  return SIZES.map((size) => ({ size, shownHidden: inherited[size]?.hidden === true, renderedHidden: computed(rules, element(def, nodeId), WIDTH[size], 'display') === 'none' }));
}

const agree = (rows: Array<{ shown?: string; rendered?: string }>) => rows.forEach((r) => expect(r.shown, JSON.stringify(r)).toBe(r.rendered));

describe('the Inspector’s inherited styles match the generated CSS', () => {
  it('lets a variant’s value for all sizes win over the definition’s desktop value, as the page does', () => {
    const { state, def } = grid({ node: { grid: { base: { layout: 'grid' }, desktop: { columns: 3 } } }, layout: { grid: { base: { columns: 2 } } } });
    // The reported case: the page renders 2 columns on desktop, so the Inspector must not say 3.
    expect(designStyles(def, 'grid', undefined).desktop?.columns).toBe(2);
    // Two columns are kept off phones, where the design sets none.
    expect(designStyles(def, 'grid', undefined).phone?.columns).toBeUndefined();
    const rows = compare(state, def, 'grid', 'columns', 'grid-template-columns');
    expect(rows.map((r) => r.rendered)).toEqual([undefined, cssOf('columns', 2), cssOf('columns', 2)]);
    agree(rows);
  });

  it('lets an earlier axis’s desktop value win over a later axis’s value for all sizes', () => {
    const { state, def } = grid({
      node: { grid: { base: { layout: 'grid' }, desktop: { columns: 3 } } },
      tone: { grid: { desktop: { columns: 4 } } },
      layout: { grid: { base: { columns: 2 } } }
    });
    const rows = compare(state, def, 'grid', 'columns', 'grid-template-columns');
    expect(rows.map((r) => r.rendered)).toEqual([undefined, cssOf('columns', 2), cssOf('columns', 4)]);
    agree(rows);
  });

  it('keeps the design’s phone columns under a variant’s wider grid', () => {
    const { state, def } = grid({ node: { grid: { base: { layout: 'grid', columns: 1 }, tablet: { columns: 2 }, desktop: { columns: 3 } } }, layout: { grid: { base: { columns: 4 } } } });
    const rows = compare(state, def, 'grid', 'columns', 'grid-template-columns');
    expect(rows.map((r) => r.rendered)).toEqual([cssOf('columns', 1), cssOf('columns', 4), cssOf('columns', 4)]);
    agree(rows);
  });

  it('matches the theme’s own Features grid with each layout option', () => {
    const state: ProjectState = createStarterState('business', 'Test Studio', false);
    const def = Object.values(state.components).find((d) => d.componentId === 'features.grid')!;
    const rules = parseCss(generateComponentsCss(state));
    for (const option of Object.keys(def.variantAxes!.layout.options)) {
      const variants = { layout: option };
      const inherited = designStyles(def, 'grid', variants);
      const selected = Object.entries({ tone: 'default', ...variants });
      const root = [nodeClass(def, 'root'), ...selected.map(([axis, o]) => variantClass(def, axis, o))];
      // The grid carries the option of each axis that styles it.
      const own = selected.filter(([axis]) => Object.values(def.variantAxes![axis].options).some((o) => !!o.styles?.grid)).map(([axis, o]) => variantClass(def, axis, o));
      for (const size of SIZES) {
        const shown = inherited[size]?.columns;
        expect(shown === undefined ? undefined : cssOf('columns', shown), `${option} on ${size}`).toBe(computed(rules, { classes: [nodeClass(def, 'grid'), ...own], ancestors: [root] }, WIDTH[size], 'grid-template-columns'));
      }
    }
  });

  it('keeps a variant’s grid template and a wide span off phones', () => {
    const { state, def } = grid({ node: { grid: { base: { layout: 'grid' } }, heading: { base: { columnSpan: 2 } } }, layout: { grid: { base: { gridTemplate: '2fr 1fr' } } } });
    const template = compare(state, def, 'grid', 'gridTemplate', 'grid-template-columns');
    expect(template.map((r) => r.rendered)).toEqual([undefined, cssOf('gridTemplate', '2fr 1fr'), cssOf('gridTemplate', '2fr 1fr')]);
    agree(template);
    const span = compare(state, def, 'heading', 'columnSpan', 'grid-column');
    expect(span.map((r) => r.rendered)).toEqual([undefined, cssOf('columnSpan', 2), cssOf('columnSpan', 2)]);
    agree(span);
  });

  it('keeps column sizes for all sizes off phones, and lets them override the column count from tablet up (#205)', () => {
    // The Grid element as inserted (one column, three on desktop), then given uneven column sizes for All sizes.
    const { state, def } = grid({ node: { grid: { base: { layout: 'grid', columns: 1, gridTemplate: '1fr 2fr' }, desktop: { columns: 3 } } } });
    const rows = compare(state, def, 'grid', 'gridTemplate', 'grid-template-columns');
    expect(rows.map((r) => r.rendered)).toEqual([cssOf('columns', 1), cssOf('gridTemplate', '1fr 2fr'), cssOf('gridTemplate', '1fr 2fr')]);
    const inherited = designStyles(def, 'grid', undefined);
    expect(inherited.phone).toMatchObject({ columns: 1 });
    expect(inherited.phone?.gridTemplate).toBeUndefined();
    expect(inherited.desktop?.columns).toBeUndefined();
    agree(compare(state, def, 'grid', 'columns', 'grid-template-columns').filter((r) => r.size === 'phone'));
    agree(rows.filter((r) => r.size !== 'phone'));
  });

  it('applies column sizes set for one size there only, and a phone’s own column sizes on phones (#205)', () => {
    const tabletOnly = grid({ node: { grid: { base: { layout: 'grid', columns: 1 }, tablet: { gridTemplate: '1fr 2fr' }, desktop: { columns: 3 } } } });
    const shownAt = (g: ReturnType<typeof grid>) => {
      const rules = parseCss(generateComponentsCss(g.state));
      const inherited = designStyles(g.def, 'grid', undefined);
      return SIZES.map((size) => {
        const at = inherited[size];
        const shown = at?.gridTemplate !== undefined ? cssOf('gridTemplate', at.gridTemplate) : at?.columns !== undefined ? cssOf('columns', at.columns) : undefined;
        const rendered = computed(rules, element(g.def, 'grid'), WIDTH[size], 'grid-template-columns');
        expect(shown, size).toBe(rendered);
        return rendered;
      });
    };
    expect(shownAt(tabletOnly)).toEqual([cssOf('columns', 1), cssOf('gridTemplate', '1fr 2fr'), cssOf('columns', 3)]);
    const phoneOwn = grid({ node: { grid: { base: { layout: 'grid', columns: 1, gridTemplate: '1fr 1fr' }, phone: { gridTemplate: '1fr 2fr' }, desktop: { columns: 3 } } } });
    expect(shownAt(phoneOwn)).toEqual([cssOf('gridTemplate', '1fr 2fr'), cssOf('gridTemplate', '1fr 1fr'), cssOf('gridTemplate', '1fr 1fr')]);
    // A phone's own column count stays, and so does a desktop count of one.
    const phoneCount = grid({ node: { grid: { base: { layout: 'grid', gridTemplate: '1fr 1fr' }, phone: { columns: 2 }, desktop: { columns: 1 } } } });
    expect(shownAt(phoneCount)).toEqual([cssOf('columns', 2), cssOf('gridTemplate', '1fr 1fr'), cssOf('gridTemplate', '1fr 1fr')]);
    // A variant's column sizes override that variant's own desktop count too.
    const variant = grid({ node: { grid: { base: { layout: 'grid', columns: 1 } } }, layout: { grid: { base: { gridTemplate: '2fr 1fr' }, desktop: { columns: 4 } } } });
    expect(shownAt(variant)).toEqual([cssOf('columns', 1), cssOf('gridTemplate', '2fr 1fr'), cssOf('gridTemplate', '2fr 1fr')]);
    // Column sizes the stylesheet would not write override nothing.
    const broken = grid({ node: { grid: { base: { layout: 'grid', columns: 1, gridTemplate: 'repeat(99, 1fr)' }, desktop: { columns: 3 } } } });
    const rules = parseCss(generateComponentsCss(broken.state));
    expect(SIZES.map((size) => computed(rules, element(broken.def, 'grid'), WIDTH[size], 'grid-template-columns'))).toEqual([cssOf('columns', 1), cssOf('columns', 1), cssOf('columns', 3)]);
  });

  it('reports a grid template, not a column count, where the template wins', () => {
    const { state, def } = grid({ node: { grid: { base: { layout: 'grid' }, desktop: { columns: 3 } } }, layout: { grid: { base: { gridTemplate: '2fr 1fr' } } } });
    const inherited = designStyles(def, 'grid', undefined);
    expect(inherited.desktop).toMatchObject({ gridTemplate: '2fr 1fr' });
    expect(inherited.desktop?.columns).toBeUndefined();
    const rules = parseCss(generateComponentsCss(state));
    for (const size of SIZES) {
      const at = inherited[size];
      const shown = at?.gridTemplate !== undefined ? cssOf('gridTemplate', at.gridTemplate) : at?.columns !== undefined ? cssOf('columns', at.columns) : undefined;
      expect(shown, size).toBe(computed(rules, element(def, 'grid'), WIDTH[size], 'grid-template-columns'));
    }
    // Both in one rule: the grid template is written after the column count, so it wins.
    const same = grid({ node: { grid: { base: { layout: 'grid', columns: 2, gridTemplate: '2fr 1fr' } } } });
    expect(designStyles(same.def, 'grid', undefined).desktop).toMatchObject({ gridTemplate: '2fr 1fr' });
    expect(designStyles(same.def, 'grid', undefined).desktop?.columns).toBeUndefined();
    expect(computed(parseCss(generateComponentsCss(same.state)), element(same.def, 'grid'), WIDTH.desktop, 'grid-template-columns')).toBe(cssOf('gridTemplate', '2fr 1fr'));
  });

  it('never shows the design’s All sizes column count at a size where a grid template wins', () => {
    const { def } = grid({ node: { grid: { base: { layout: 'grid', columns: 1 } } }, layout: { grid: { base: { gridTemplate: '2fr 1fr' } } } });
    const inherited = designStyles(def, 'grid', undefined);
    expect(inherited.base?.columns).toBe(1);
    expect(styleUnder({ prop: 'columns', scope: 'phone', styles: undefined, inherited })).toEqual({ value: 1, from: 'design' });
    expect(styleUnder({ prop: 'columns', scope: 'tablet', styles: undefined, inherited })).toEqual({ value: undefined, from: undefined });
    expect(styleUnder({ prop: 'gridTemplate', scope: 'tablet', styles: undefined, inherited })).toEqual({ value: '2fr 1fr', from: 'design' });
  });

  it('gives All sizes no design value that no size shows', () => {
    const { state, def } = grid({ node: { grid: { base: { layout: 'grid', columns: 3 } } }, layout: { grid: { base: { columns: 2 }, phone: { columns: 2 } } } });
    const inherited = designStyles(def, 'grid', undefined);
    expect(inherited.base?.columns).toBeUndefined();
    const rows = compare(state, def, 'grid', 'columns', 'grid-template-columns');
    expect(rows.map((r) => r.rendered)).toEqual([cssOf('columns', 2), cssOf('columns', 2), cssOf('columns', 2)]);
    agree(rows);
    // Where it does show somewhere, it stays: the Features grid's own one column on phones.
    expect(designStyles(grid({ node: { grid: { base: { layout: 'grid', columns: 1 }, desktop: { columns: 3 } } } }).def, 'grid', undefined).base?.columns).toBe(1);
  });

  it('shows a part a later axis shows again at every size, even where an earlier axis hides it at one size', () => {
    const { state, def } = grid({ node: { heading: {} }, tone: { heading: { desktop: { hidden: true } } }, layout: { heading: { base: { hidden: false } } } });
    const rows = visibility(state, def, 'heading');
    expect(rows.map((r) => r.renderedHidden)).toEqual([false, false, false]);
    rows.forEach((r) => expect(r.shownHidden, r.size).toBe(r.renderedHidden));
  });

  it('folds “hidden, but shown on phone” the way the stylesheet writes it', () => {
    const { state, def } = grid({ node: { heading: {} }, tone: { heading: { base: { hidden: false } } }, layout: { heading: { base: { hidden: true }, phone: { hidden: false } } } });
    const rows = visibility(state, def, 'heading');
    expect(rows.map((r) => r.renderedHidden)).toEqual([false, true, true]);
    rows.forEach((r) => expect(r.shownHidden, r.size).toBe(r.renderedHidden));
  });

  it('lets a variant show at every size what the definition hides on desktop', () => {
    const { state, def } = grid({ node: { heading: { desktop: { hidden: true } } }, tone: { heading: { base: { hidden: false } } } });
    const rows = visibility(state, def, 'heading');
    expect(rows.map((r) => r.renderedHidden)).toEqual([false, false, false]);
    rows.forEach((r) => expect(r.shownHidden, r.size).toBe(r.renderedHidden));
  });

  it('keeps a part hidden by a later axis, whatever an earlier axis says about showing it', () => {
    for (const shown of [{ base: { hidden: false } }, { phone: { hidden: false } }] as ResponsiveStyles[]) {
      const { state, def } = grid({ node: { heading: {} }, tone: { heading: shown }, layout: { heading: { base: { hidden: true } } } });
      const rows = visibility(state, def, 'heading');
      expect(rows.map((r) => r.renderedHidden), JSON.stringify(shown)).toEqual([true, true, true]);
      rows.forEach((r) => expect(r.shownHidden, `${JSON.stringify(shown)} on ${r.size}`).toBe(r.renderedHidden));
    }
  });

  it('shows on one size what an earlier axis hides for all sizes', () => {
    const { state, def } = grid({ node: { heading: {} }, tone: { heading: { base: { hidden: true } } }, layout: { heading: { phone: { hidden: false } } } });
    const rows = visibility(state, def, 'heading');
    expect(rows.map((r) => r.renderedHidden)).toEqual([false, true, true]);
    rows.forEach((r) => expect(r.shownHidden, r.size).toBe(r.renderedHidden));
  });

  it('shows a hidden part where a stronger rule gives it a layout, and keeps it hidden where its own rule does', () => {
    const shown = grid({ node: { heading: { base: { hidden: true } } }, layout: { heading: { phone: { layout: 'grid' } } } });
    const rows = visibility(shown.state, shown.def, 'heading');
    expect(rows.map((r) => r.renderedHidden)).toEqual([false, true, true]);
    rows.forEach((r) => expect(r.shownHidden, r.size).toBe(r.renderedHidden));
    // In one rule the hide is written after the layout, so it wins.
    const same = grid({ node: { heading: { base: { layout: 'grid', hidden: true } } } });
    const sameRows = visibility(same.state, same.def, 'heading');
    expect(sameRows.map((r) => r.renderedHidden)).toEqual([true, true, true]);
    sameRows.forEach((r) => expect(r.shownHidden, r.size).toBe(r.renderedHidden));
  });

  it('keeps a part shown at every size, All sizes included, where a stronger layout beats a hide for all sizes', () => {
    const { state, def } = grid({ node: { heading: { base: { hidden: true } } }, layout: { heading: { base: { layout: 'grid' } } } });
    const rows = visibility(state, def, 'heading');
    expect(rows.map((r) => r.renderedHidden)).toEqual([false, false, false]);
    rows.forEach((r) => expect(r.shownHidden, r.size).toBe(r.renderedHidden));
    expect(designStyles(def, 'heading', undefined).base?.hidden).toBe(false);
  });

  it('hides at the sizes the definition hides when no variant shows it', () => {
    const { state, def } = grid({ node: { heading: { base: { hidden: true }, tablet: { hidden: false } } } });
    const rows = visibility(state, def, 'heading');
    expect(rows.map((r) => r.renderedHidden)).toEqual([true, false, true]);
    rows.forEach((r) => expect(r.shownHidden, r.size).toBe(r.renderedHidden));
  });
});

describe('a placement’s own grid for all sizes', () => {
  /** The Features grid on the home page with its card grid set to `columns` columns for all sizes. */
  function placed(columns: number) {
    const { state, def } = grid({ node: { grid: { base: { layout: 'grid' }, desktop: { columns: 3 } } }, layout: { grid: { base: { columns: 2 } } } });
    const owner = { kind: 'page' as const, id: state.site.homePageId };
    const page = state.pages[state.site.homePageId];
    const inst = page.rootIds.map((id) => page.nodes[id] as InstanceNode).find((n) => n.definitionId === def.id)!;
    const s = applyOperations(state, [{ type: 'node.setStyle', owner, nodeId: inst.id, partId: 'grid', scope: 'base', property: 'columns', value: columns }]).state;
    return { s, def: s.components[def.id], inst: s.pages[s.site.homePageId].nodes[inst.id] as InstanceNode };
  }

  it('says what each size really shows: the design on phones, the placement’s grid from tablet up', () => {
    const { s, def, inst } = placed(5);
    const rules = parseCss(`${generateComponentsCss(s)}\n${generateSiteCss(s)}`);
    const el = element(def, 'grid', [overrideClass(inst.id, 'grid')]);
    const inherited = designStyles(def, 'grid', inst.variants);
    for (const size of SIZES) {
      const own = inst.overrides?.grid?.[size as ResponsiveScope]?.columns;
      const under = styleUnder({ prop: 'columns', scope: size, styles: inst.overrides?.grid, inherited, wideColumns: true });
      const shown = own ?? under.value;
      expect(shown === undefined ? undefined : cssOf('columns', shown), size).toBe(computed(rules, el, WIDTH[size], 'grid-template-columns'));
    }
    // On phones the row names no source: neither the placement's grid nor the design reaches it.
    expect(styleUnder({ prop: 'columns', scope: 'phone', styles: inst.overrides?.grid, inherited, wideColumns: true })).toEqual({ value: undefined, from: undefined });
    expect(styleUnder({ prop: 'columns', scope: 'tablet', styles: inst.overrides?.grid, inherited, wideColumns: true })).toEqual({ value: 5, from: 'all-sizes' });
  });

  it('shows no design column count where the placement’s own grid template wins', () => {
    const { s, def, inst } = placed(1);
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    const t = applyOperations(s, [
      { type: 'node.setStyle', owner, nodeId: inst.id, partId: 'grid', scope: 'base', property: 'columns', value: null },
      { type: 'node.setStyle', owner, nodeId: inst.id, partId: 'grid', scope: 'base', property: 'gridTemplate', value: '2fr 1fr' }
    ]).state;
    const own = (t.pages[t.site.homePageId].nodes[inst.id] as InstanceNode).overrides?.grid;
    const inherited = designStyles(def, 'grid', inst.variants);
    const rules = parseCss(`${generateComponentsCss(t)}\n${generateSiteCss(t)}`);
    const el = element(def, 'grid', [overrideClass(inst.id, 'grid')]);
    for (const size of SIZES) {
      const columns = styleUnder({ prop: 'columns', scope: size, styles: own, inherited, wideColumns: true }).value;
      const template = own?.[size as ResponsiveScope]?.gridTemplate ?? styleUnder({ prop: 'gridTemplate', scope: size, styles: own, inherited, wideColumns: true }).value;
      const shown = template !== undefined ? cssOf('gridTemplate', template) : columns !== undefined ? cssOf('columns', columns) : undefined;
      expect(shown, size).toBe(computed(rules, el, WIDTH[size], 'grid-template-columns'));
    }
    expect(styleUnder({ prop: 'columns', scope: 'desktop', styles: own, inherited, wideColumns: true }).value).toBeUndefined();
  });

  it('weighs a placement’s own column count and grid template against each other as the stylesheet does', () => {
    const { s, def, inst } = placed(1);
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    const t = applyOperations(s, [{ type: 'node.setStyle', owner, nodeId: inst.id, partId: 'grid', scope: 'base', property: 'gridTemplate', value: '2fr 1fr' }]).state;
    const own = (t.pages[t.site.homePageId].nodes[inst.id] as InstanceNode).overrides?.grid;
    const inherited = designStyles(def, 'grid', inst.variants);
    const under = (prop: string, scope: ResponsiveScope) => styleUnder({ prop, scope, styles: own, inherited, wideColumns: true });
    // One column for all sizes reaches phones; the template, kept off phones, wins from tablet up.
    expect(under('columns', 'phone')).toEqual({ value: 1, from: 'all-sizes' });
    expect(under('gridTemplate', 'phone')).toEqual({ value: undefined, from: undefined });
    expect(under('gridTemplate', 'tablet')).toEqual({ value: '2fr 1fr', from: 'all-sizes' });
    expect(under('columns', 'tablet')).toEqual({ value: undefined, from: undefined });
    const rules = parseCss(`${generateComponentsCss(t)}\n${generateSiteCss(t)}`);
    const el = element(def, 'grid', [overrideClass(inst.id, 'grid')]);
    expect(computed(rules, el, WIDTH.phone, 'grid-template-columns')).toBe(cssOf('columns', 1));
    expect(computed(rules, el, WIDTH.tablet, 'grid-template-columns')).toBe(cssOf('gridTemplate', '2fr 1fr'));
    // Under All sizes, a template kept off phones leaves the design's own value in view.
    const onlyTemplate = { base: { gridTemplate: '2fr 1fr' } };
    expect(styleUnder({ prop: 'columns', scope: 'base', styles: onlyTemplate, inherited: { base: { columns: 1 }, phone: { columns: 1 } }, wideColumns: true })).toEqual({ value: 1, from: 'design' });
  });

  it('keeps a placement shown at every size where it is shown for all sizes and the design hides it', () => {
    const inherited = { base: { hidden: true }, phone: { hidden: true }, tablet: { hidden: true }, desktop: { hidden: true } } as ResponsiveStyles;
    const own = { base: { hidden: false }, phone: { hidden: false } } as ResponsiveStyles;
    for (const scope of ['tablet', 'desktop'] as const) expect(styleUnder({ prop: 'hidden', scope, styles: own, inherited, wideColumns: true }), scope).toEqual({ value: false, from: 'all-sizes' });
  });

  it('offers no All sizes design column count that the placement’s own template leaves showing nowhere', () => {
    const inherited = { base: { columns: 3 }, phone: { columns: 1 }, tablet: { columns: 3 }, desktop: { columns: 3 } } as ResponsiveStyles;
    expect(styleUnder({ prop: 'columns', scope: 'base', styles: { base: { gridTemplate: '2fr 1fr' } }, inherited, wideColumns: true })).toEqual({ value: undefined, from: undefined });
    expect(styleUnder({ prop: 'columns', scope: 'base', styles: undefined, inherited, wideColumns: true })).toEqual({ value: 3, from: 'design' });
  });

  it('lets a design’s All sizes column sizes override its own column counts from tablet up while editing it everywhere (#205)', () => {
    const original = { base: { layout: 'grid', columns: 1 }, tablet: { columns: 2 }, desktop: { columns: 3 } } as ResponsiveStyles;
    const changed = { base: { gridTemplate: '2fr 1fr' } } as ResponsiveStyles;
    for (const scope of ['tablet', 'desktop'] as const) {
      expect(styleUnder({ prop: 'columns', scope, styles: changed, inherited: original, designSizesWin: true }), scope).toEqual({ value: undefined, from: undefined });
      expect(styleUnder({ prop: 'gridTemplate', scope, styles: changed, inherited: original, designSizesWin: true }), scope).toEqual({ value: '2fr 1fr', from: 'all-sizes' });
    }
    // Phones keep the design's own column count, and without the column sizes each size's count shows again.
    expect(styleUnder({ prop: 'columns', scope: 'phone', styles: changed, inherited: original, designSizesWin: true })).toEqual({ value: 1, from: 'design' });
    expect(styleUnder({ prop: 'gridTemplate', scope: 'phone', styles: changed, inherited: original, designSizesWin: true })).toEqual({ value: undefined, from: undefined });
    expect(styleUnder({ prop: 'columns', scope: 'tablet', styles: {}, inherited: original, designSizesWin: true })).toEqual({ value: 2, from: 'design' });
    // Column sizes the design already had override its counts the same way.
    const withSizes = { ...original, base: { ...original.base, gridTemplate: '2fr 1fr' } } as ResponsiveStyles;
    expect(styleUnder({ prop: 'columns', scope: 'desktop', styles: {}, inherited: withSizes, designSizesWin: true })).toEqual({ value: undefined, from: undefined });
  });

  it('keeps one column for all sizes on phones too', () => {
    const { s, def, inst } = placed(1);
    const inherited = designStyles(def, 'grid', inst.variants);
    expect(styleUnder({ prop: 'columns', scope: 'phone', styles: inst.overrides?.grid, inherited, wideColumns: true })).toEqual({ value: 1, from: 'all-sizes' });
    const rules = parseCss(`${generateComponentsCss(s)}\n${generateSiteCss(s)}`);
    expect(computed(rules, element(def, 'grid', [overrideClass(inst.id, 'grid')]), WIDTH.phone, 'grid-template-columns')).toBe(cssOf('columns', 1));
  });
});

describe('motion rows in the inspector (#351)', () => {
  const shown = (prop: string, styles: ResponsiveStyles | undefined, inherited: ResponsiveStyles | undefined, allowed?: string[], scope: ResponsiveScope = 'base') =>
    refinementShown(prop, (p) => styleReached({ prop: p, scope, styles, inherited }), (p) => !allowed || allowed.includes(p));

  it('shows an origin once a scale or rotation is in effect, from the design or another size', () => {
    expect(shown('transformOrigin', undefined, undefined)).toBe(false);
    expect(shown('transformOrigin', { base: { rotate: -2 } }, undefined)).toBe(true);
    expect(shown('transformOrigin', undefined, { tablet: { scale: 1.05 } }, undefined, 'tablet')).toBe(true);
    expect(shown('transformOrigin', undefined, { tablet: { scale: 1.05 } }, undefined, 'phone')).toBe(false);
    // Under All sizes a rotation set for one size counts: an origin set for all sizes applies to it there.
    expect(shown('transformOrigin', { tablet: { rotate: 4 } }, undefined)).toBe(true);
    expect(shown('transformOrigin', undefined, { base: { transformOrigin: 'top left' } })).toBe(true);
    // Offered on its own, with nothing here to scale or rotate it, it is the control.
    expect(shown('transformOrigin', undefined, undefined, ['transformOrigin'])).toBe(true);
  });

  it('shows a duration and easing once a preset other than none is in effect', () => {
    for (const prop of ['transitionDuration', 'transitionEasing']) {
      expect(shown(prop, undefined, undefined), prop).toBe(false);
      expect(shown(prop, { base: { transition: 'none' } }, undefined), prop).toBe(false);
      expect(shown(prop, { base: { transition: 'colors' } }, undefined), prop).toBe(true);
      expect(shown(prop, undefined, { base: { transition: 'shadow' } }), prop).toBe(true);
      expect(shown(prop, undefined, { base: { [prop]: prop === 'transitionDuration' ? 0 : 'linear' } }), prop).toBe(true);
      // A preset set only for phones is still refined from All sizes, but not from another size.
      expect(shown(prop, { phone: { transition: 'shadow' } }, undefined), prop).toBe(true);
      expect(shown(prop, { base: { transition: 'none' }, phone: { transition: 'shadow' } }, undefined), prop).toBe(true);
      expect(shown(prop, { phone: { transition: 'shadow' } }, undefined, undefined, 'tablet'), prop).toBe(false);
      expect(shown(prop, undefined, undefined, [prop]), prop).toBe(true);
    }
    expect(shown('scale', undefined, undefined)).toBeUndefined();
  });

  it('reads a typed number with its own unit, and a percentage only where the value runs 0 to 1', () => {
    expect(readStyleNumber(STYLE_PROP_MAP.rotate, '-2.5deg')).toBe(-2.5);
    expect(readStyleNumber(STYLE_PROP_MAP.rotate, ' 45 ')).toBe(45);
    expect(readStyleNumber(STYLE_PROP_MAP.transitionDuration, '250ms')).toBe(250);
    expect(readStyleNumber(STYLE_PROP_MAP.transitionDuration, '250 MS')).toBe(250);
    expect(readStyleNumber(STYLE_PROP_MAP.opacity, '50%')).toBe(0.5);
    // A percentage is not degrees or milliseconds, and another unit is not this one.
    expect(readStyleNumber(STYLE_PROP_MAP.rotate, '20%')).toBeNull();
    expect(readStyleNumber(STYLE_PROP_MAP.transitionDuration, '0.3s')).toBeNull();
    expect(readStyleNumber(STYLE_PROP_MAP.scale, '0x2')).toBeNull();
    expect(readStyleNumber(STYLE_PROP_MAP.scale, '1e1')).toBeNull();
    expect(readStyleNumber(STYLE_PROP_MAP.scale, '.5')).toBe(0.5);
    expect(readStyleNumber(STYLE_PROP_MAP.rotate, '1.')).toBe(1);
    expect(readStyleNumber(STYLE_PROP_MAP.rotate, '9'.repeat(400))).toBeNull();
    // Older fields read what they always read.
    expect(readStyleNumber(STYLE_PROP_MAP.opacity, '1.')).toBe(1);
    expect(readStyleNumber(STYLE_PROP_MAP.zIndex, '1e1')).toBe(10);
    expect(readStyleNumber(STYLE_PROP_MAP.zIndex, '9'.repeat(400))).toBeNull();
    expect(readStyleNumber(STYLE_PROP_MAP.zIndex, ' ')).toBeNull();
  });
});
