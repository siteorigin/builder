/**
 * Hover, focus and pressed styles (#348): rules for an interactive state stored beside each size, set and cleared by
 * the operations, checked like any style, counted with the site styles they use, kept by copies and detaches, and
 * written to the stylesheet after every resting rule.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import type { ComponentDefinition, ElementNode, ElementRef, InstanceNode, LinkNode, ListItem, ProjectState, ResponsiveStyles } from '@shared/types';
import { parseStyleScopeKey, styleScopeKey } from '@shared/types';
import { MEDIA_QUERIES, STATE_STYLE_PROPS, flattenStates } from '@shared/styles';
import { MIGRATIONS, migrateProject } from '@shared/migrations';
import { createStarterState } from '@catalogue/starters';
import { FOUNDATION } from '@catalogue/foundation/pack';
import { prop } from '@catalogue/dsl';
import { applyOperations } from '@engine/apply';
import { EngineError } from '@engine/tree';
import { tokenUsageCounts } from '@engine/tokens';
import { validateState } from '@engine/validate';
import { makeInstance } from '@engine/install';
import { defFile, generateProject, generateSiteCss, nestedStateClass, nodeClass, pageNodeClass, variantClass } from '@generator/index';
import { captureStyle, planStylePaste } from '../../src/renderer/src/lib/style-copy';

const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });
const grid = (s: ProjectState) => {
  const p = home(s);
  return p.rootIds.map((id) => p.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === 'features.grid')!;
};
const cards = (s: ProjectState) => grid(s).props.items as ListItem[];

/** Applies operations the way the session does: each one parsed by its schema first, then applied as one batch. */
function apply(s: ProjectState, ops: unknown[]): ProjectState {
  const parsed = ops.map((o) => {
    const v = validateOperation(o);
    if (!v.ok) throw new Error(v.message);
    return v.op;
  });
  return applyOperations(s, parsed as EditOperation[]).state;
}

const rejects = (fn: () => unknown, msg: RegExp) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    expect((e as Error).message).toMatch(msg);
    return;
  }
  throw new Error('expected the operation to be rejected');
};

/** Home with two plain boxes of its own, `n_box` and `n_other`, and a link `n_link`. */
function withBoxes(): ProjectState {
  const s = fresh();
  const page = home(s);
  for (const id of ['n_box', 'n_other']) {
    page.nodes[id] = { id, kind: 'element', tag: 'div', children: [] } as ElementNode;
    page.rootIds.push(id);
  }
  page.nodes.n_link = { id: 'n_link', kind: 'link', link: { type: 'url', target: 'https://example.com/' }, label: 'Talk to us', appearance: 'primary' } as LinkNode;
  page.rootIds.push('n_link');
  return s;
}
const box = (s: ProjectState, id = 'n_box') => home(s).nodes[id];
const at = (s: ProjectState, nodeId = 'n_box') => ({ owner: owner(s), nodeId });
const set = (s: ProjectState, scope: string, state: string | undefined, property: string, value: unknown, nodeId = 'n_box') =>
  apply(s, [{ type: 'node.setStyle', ...at(s, nodeId), scope, ...(state ? { state } : {}), property, value }]);

/** A box styled the way the issue's cards are: resting, hover at all sizes and on phones, focus and pressed. */
function styledBox(): ProjectState {
  let s = withBoxes();
  s = set(s, 'base', undefined, 'background', '#ffffff');
  s = set(s, 'tablet', undefined, 'background', '#dddddd');
  s = set(s, 'desktop', undefined, 'background', '#eeeeee');
  s = set(s, 'base', 'hover', 'background', '#0000ff');
  s = set(s, 'phone', 'hover', 'background', '#ff0000');
  s = set(s, 'base', 'focus', 'color', '#00ff00');
  s = set(s, 'base', 'active', 'shadow', { token: 'shadow.sm' });
  return s;
}

describe('state rules in the style map', () => {
  it('are stored beside each size under one key per size and state', () => {
    const s = styledBox();
    expect(box(s).styles).toEqual({
      base: { background: '#ffffff' },
      tablet: { background: '#dddddd' },
      desktop: { background: '#eeeeee' },
      'base:hover': { background: '#0000ff' },
      'phone:hover': { background: '#ff0000' },
      'base:focus': { color: '#00ff00' },
      'base:active': { shadow: { token: 'shadow.sm' } }
    });
    // A null value clears the state's value alone, and its key once it is empty.
    expect(set(s, 'phone', 'hover', 'background', null).pages[s.site.homePageId].nodes.n_box.styles).not.toHaveProperty('phone:hover');
    expect(set(s, 'phone', 'hover', 'background', null).pages[s.site.homePageId].nodes.n_box.styles?.['base:hover']).toEqual({ background: '#0000ff' });
  });

  it('name a size and a state, and nothing else', () => {
    expect(parseStyleScopeKey('phone:hover')).toEqual({ scope: 'phone', state: 'hover' });
    expect(parseStyleScopeKey('desktop:focus')).toEqual({ scope: 'desktop', state: 'focus' });
    expect(parseStyleScopeKey('base:active')).toEqual({ scope: 'base', state: 'active' });
    expect(parseStyleScopeKey('base')).toEqual({ scope: 'base' });
    for (const k of ['hover', 'base:visited', 'wide', 'base:hover:active', 'toString']) expect(parseStyleScopeKey(k), k).toBeNull();
    expect(styleScopeKey('tablet', 'active')).toBe('tablet:active');
  });

  it('change only how an element looks: layout, size, visibility and motion stay on the resting style', () => {
    expect(STATE_STYLE_PROPS).toEqual(['color', 'background', 'border', 'borderBlockStart', 'borderBlockEnd', 'borderInlineStart', 'borderInlineEnd', 'radius', 'shadow', 'opacity']);
    const s = withBoxes();
    for (const state of ['hover', 'focus', 'active'])
      for (const property of ['paddingBlock', 'hidden', 'layout', 'transition', 'translateY', 'customCss'])
        rejects(() => set(s, 'base', state, property, property === 'hidden' ? true : property === 'layout' ? 'row' : property === 'transition' ? 'colors' : property === 'customCss' ? 'filter: none' : '4px'), /cannot change on hover, focus or press/);
    // A hand-edited value a state cannot hold can still be cleared.
    box(s).styles = { 'base:hover': { paddingBlock: '4px', color: '#000000' } };
    expect(box(set(s, 'base', 'hover', 'paddingBlock', null)).styles).toEqual({ 'base:hover': { color: '#000000' } });
    // A state the builder does not know is refused by the operation's schema.
    expect(validateOperation({ type: 'node.setStyle', ...at(s), scope: 'base', state: 'visited', property: 'color', value: '#000000' }).ok).toBe(false);
    // A site style that does not exist is refused in a state as it is on the resting style.
    rejects(() => set(s, 'base', 'hover', 'background', { token: 'color.nope' }), /does not exist|unknown|no site style/i);
  });

  it('reset by size, by state, or both, and every rule without either', () => {
    let s = withBoxes();
    s = set(s, 'base', undefined, 'color', '#000001');
    s = set(s, 'base', 'hover', 'color', '#000002');
    s = set(s, 'phone', undefined, 'color', '#000003');
    s = set(s, 'phone', 'hover', 'color', '#000004');
    s = set(s, 'phone', 'active', 'color', '#000005');
    const reset = (filter: Record<string, string>) => Object.keys(box(apply(s, [{ type: 'node.resetStyles', ...at(s), ...filter }])).styles ?? {}).sort();
    expect(reset({ scope: 'phone' })).toEqual(['base', 'base:hover']);
    expect(reset({ state: 'hover' })).toEqual(['base', 'phone', 'phone:active']);
    expect(reset({ scope: 'phone', state: 'hover' })).toEqual(['base', 'base:hover', 'phone', 'phone:active']);
    expect(reset({})).toEqual([]);
    expect(box(apply(s, [{ type: 'node.resetStyles', ...at(s) }])).styles).toBeUndefined();
    // Resetting the last rule a state left removes the map with it.
    const one = set(withBoxes(), 'base', 'hover', 'color', '#000002');
    expect(box(apply(one, [{ type: 'node.resetStyles', ...at(one), state: 'hover' }])).styles).toBeUndefined();
  });

  it('style a part of a placement and one of its items, and reset each apart', () => {
    let s = fresh();
    const g = { owner: owner(s), nodeId: grid(s).id, partId: 'card' };
    const [first, second] = cards(s).map((c) => c.id);
    s = apply(s, [
      { type: 'node.setStyle', ...g, scope: 'base', property: 'background', value: '#ffffff' },
      { type: 'node.setStyle', ...g, scope: 'base', state: 'hover', property: 'background', value: '#eef4ff' },
      { type: 'node.setStyle', ...g, itemId: second, scope: 'base', state: 'hover', property: 'border', value: '2px solid #1f5f3a' }
    ]);
    expect(grid(s).overrides?.card).toEqual({ base: { background: '#ffffff' }, 'base:hover': { background: '#eef4ff' } });
    expect(grid(s).itemOverrides?.card.items[second]).toEqual({ 'base:hover': { border: '2px solid #1f5f3a' } });
    expect(grid(s).itemOverrides?.card.items[first]).toBeUndefined();
    // The part's hover goes; its resting style and the item's own hover stay.
    const t = apply(s, [{ type: 'node.resetStyles', ...g, state: 'hover' }]);
    expect(grid(t).overrides?.card).toEqual({ base: { background: '#ffffff' } });
    expect(grid(t).itemOverrides?.card.items[second]).toEqual({ 'base:hover': { border: '2px solid #1f5f3a' } });
    // The item's hover goes, and its empty record with it.
    const u = apply(s, [{ type: 'node.resetStyles', ...g, itemId: second, state: 'hover' }]);
    expect(grid(u).itemOverrides).toBeUndefined();
    // A size and a state reset only that one rule of the item's.
    const phoneToo = apply(s, [{ type: 'node.setStyle', ...g, itemId: second, scope: 'phone', state: 'hover', property: 'border', value: '1px solid #000000' }]);
    const w = apply(phoneToo, [{ type: 'node.resetStyles', ...g, itemId: second, scope: 'phone', state: 'hover' }]);
    expect(grid(w).itemOverrides?.card.items[second]).toEqual({ 'base:hover': { border: '2px solid #1f5f3a' } });
    // Resetting the whole placement in one state reaches its items too.
    const v = apply(s, [{ type: 'node.resetStyles', owner: owner(s), nodeId: grid(s).id, state: 'hover' }]);
    expect(grid(v).overrides).toEqual({ card: { base: { background: '#ffffff' } } });
    expect(grid(v).itemOverrides).toBeUndefined();
    // Each item's state rules get their own class, as its resting ones do.
    const css = generateSiteCss(s);
    expect(css).toMatch(/so-oi-[^{]*:where\(:hover\) \{\n\t\tborder: 2px solid #1f5f3a;/);
  });

  it('style a variant option of a design', () => {
    const s = fresh();
    const def = toned(s);
    const t = apply(s, [{ type: 'node.setStyle', owner: { kind: 'component', id: def.id }, nodeId: 'lead', variant: 'loud', axis: 'tone', scope: 'base', state: 'hover', property: 'color', value: '#aa0000' }]);
    expect(t.components[def.id].variantAxes!.tone.options.loud.styles?.lead).toEqual({ base: { color: '#ff0000' }, 'base:hover': { color: '#aa0000' } });
    const css = generateProject(t).get('src/lib/siteorigin/styles/components.css')!;
    expect(css).toContain(`.${variantClass(def, 'tone', 'loud')}.${nodeClass(def, 'lead')}:where(:hover) {\n\t\tcolor: #aa0000;`);
  });
});

describe('checking a document', () => {
  it('reports a value no state can hold, a key that names no size or state, and a site style of the wrong kind', () => {
    const s = withBoxes();
    // As a hand edit leaves it: a key the type does not allow.
    box(s).styles = { base: { color: '#000000' }, 'base:hover': { paddingBlock: '4px' }, 'base:visited': { color: '#ff0000' }, 'phone:hover': { background: { token: 'space.lg' } } } as ResponsiveStyles;
    const found = validateState(s).filter((d) => d.nodeId === 'n_box');
    expect(found.map((d) => [d.code, d.severity]).sort()).toEqual([
      ['STYLE_SCOPE_INVALID', 'error'],
      ['STYLE_STATE_PROPERTY', 'error'],
      ['TOKEN_GROUP', 'error']
    ]);
    expect(found.find((d) => d.code === 'STYLE_SCOPE_INVALID')?.message).toContain('"base:visited"');
    expect(found.find((d) => d.code === 'TOKEN_GROUP')?.site).toBe('n_box|own|phone:hover|background');
    // Neither the unknown key nor the value no state can hold reaches the stylesheet.
    const css = generateSiteCss(s);
    expect(css).not.toContain('visited');
    expect(css).not.toMatch(/:where\(:hover\) \{[^}]*padding/);
  });
});

describe('site styles used in state rules', () => {
  it('are counted, replaced, and kept as their value when the style is removed', () => {
    let s = withBoxes();
    s = apply(s, [{ type: 'token.create', group: 'color', label: 'Accent', value: '#123456' }]);
    const accent = s.tokens.custom.find((t) => t.label === 'Accent')!.id;
    s = set(s, 'phone', 'focus', 'background', { token: accent });
    s = set(s, 'base', 'hover', 'color', { token: accent }, 'n_other');
    expect(tokenUsageCounts(s)[accent]).toBe(2);
    const replaced = apply(s, [{ type: 'token.replace', tokenId: accent, withTokenId: 'color.brand' }]);
    expect(box(replaced).styles?.['phone:focus']).toEqual({ background: { token: 'color.brand' } });
    expect(tokenUsageCounts(replaced)[accent] ?? 0).toBe(0);
    const kept = apply(s, [{ type: 'token.remove', tokenId: accent, detach: true }]);
    expect(box(kept).styles?.['phone:focus']).toEqual({ background: '#123456' });
    expect(box(kept, 'n_other').styles?.['base:hover']).toEqual({ color: '#123456' });
    // A style in use only on hover still cannot be removed without saying where its uses go.
    rejects(() => apply(s, [{ type: 'token.remove', tokenId: accent }]), /used 2 times/);
  });
});

describe('the stylesheet', () => {
  it('writes every state after every resting rule: hover only where a pointer hovers, then focus, then pressed', () => {
    const css = generateSiteCss(styledBox());
    const cls = `.${pageNodeClass('n_box')}`;
    const tablet = css.indexOf(`@media ${MEDIA_QUERIES.tablet} {\n\t${cls} {`);
    const desktop = css.indexOf(`@media ${MEDIA_QUERIES.desktop} {\n\t${cls} {`);
    const hover = css.indexOf(`@media (hover: hover) {\n\t${cls}:where(:hover) {\n\t\tbackground: #0000ff;`);
    const phoneHover = css.indexOf(`@media ${MEDIA_QUERIES.phone} and (hover: hover) {\n\t${cls}:where(:hover) {\n\t\tbackground: #ff0000;`);
    const focus = css.indexOf(`\n${cls}:where(:focus-visible, .so-action:focus-visible > *) {\n\tcolor: #00ff00;`);
    const active = css.indexOf(`\n${cls}:where(:active, .so-action:active > *) {\n\tbox-shadow: var(--so-shadow-sm);`);
    expect([tablet, desktop, hover, phoneHover, focus, active].every((i) => i > 0), JSON.stringify([tablet, desktop, hover, phoneHover, focus, active])).toBe(true);
    expect(tablet).toBeLessThan(hover);
    expect(desktop).toBeLessThan(hover);
    expect(hover).toBeLessThan(phoneHover);
    expect(phoneHover).toBeLessThan(focus);
    expect(focus).toBeLessThan(active);
    // Only hover is limited to devices that hover: focus and pressed apply on touch screens too.
    expect(css.match(/\(hover: hover\)/g)).toHaveLength(2);
  });

  it('paints a link’s or button’s state background through the button’s own colours, in every state', () => {
    let s = withBoxes();
    s = set(s, 'base', 'hover', 'background', '#123456', 'n_link');
    s = set(s, 'base', 'hover', 'color', '#ffffff', 'n_link');
    s = set(s, 'base', 'focus', 'background', '#654321', 'n_link');
    const css = generateSiteCss(s);
    const ruleOf = (pseudo: string) => {
      const rule = css.slice(css.indexOf(`.${pageNodeClass('n_link')}:where(${pseudo}`));
      return rule.slice(0, rule.indexOf('}'));
    };
    // The theme's own hover for a button reads --so-btn-bg-hover; a text button paints the variable as well.
    for (const d of ['--so-btn-bg: #123456;', '--so-btn-bg-hover: #123456;', 'background: var(--so-btn-bg);', 'color: #ffffff;', '--so-btn-fg: #ffffff;']) expect(ruleOf(':hover')).toContain(d);
    for (const d of ['--so-btn-bg: #654321;', '--so-btn-bg-hover: #654321;', 'background: var(--so-btn-bg);']) expect(ruleOf(':focus-visible')).toContain(d);
    // Never the colour itself, which would beat a stronger layer's resting colour (set only through the variable).
    expect(ruleOf(':hover')).not.toContain('background: #123456');
  });
});

/** The cascade is the browser's to decide: cases that depend on it run where Playwright's Chromium is installed. */
const BROWSER = existsSync(chromium.executablePath());
let browser: Browser | undefined;
beforeAll(async () => {
  if (BROWSER) browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

describe.runIf(BROWSER)('the stylesheet in a browser', () => {
  /** A box's background at a width, resting and with the pointer over it. */
  async function backgrounds(css: string, width: number): Promise<{ resting: string; hovered: string }> {
    const tab = await browser!.newPage({ viewport: { width, height: 600 } });
    try {
      await tab.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div class="${pageNodeClass('n_box')}" style="width:200px;height:100px">Box</div></body></html>`);
      const read = `getComputedStyle(document.querySelector('.${pageNodeClass('n_box')}')).backgroundColor`;
      const resting = (await tab.evaluate(read)) as string;
      await tab.hover(`.${pageNodeClass('n_box')}`);
      const hovered = (await tab.evaluate(read)) as string;
      return { resting, hovered };
    } finally {
      await tab.close();
    }
  }

  it('shows a linked card’s focus while its link has keyboard focus', async () => {
    const css = generateSiteCss(styledBox());
    const tab = await browser!.newPage({ viewport: { width: 1200, height: 600 } });
    try {
      // The card as the runtime's link wraps it (see the Action runtime file).
      await tab.setContent(`<!doctype html><html><head><style>${css}</style></head><body><a class="so-card-link so-action" href="#x"><div class="${pageNodeClass('n_box')}">Card</div></a></body></html>`);
      const read = `getComputedStyle(document.querySelector('.${pageNodeClass('n_box')}')).color`;
      const resting = (await tab.evaluate(read)) as string;
      await tab.keyboard.press('Tab');
      expect(resting).not.toBe('rgb(0, 255, 0)');
      expect(await tab.evaluate(read)).toBe('rgb(0, 255, 0)');
    } finally {
      await tab.close();
    }
  });

  it('shows the hover over a size’s own resting value, and a size’s own hover over the one for all sizes', async () => {
    const css = generateSiteCss(styledBox());
    expect(await backgrounds(css, 1200)).toEqual({ resting: 'rgb(238, 238, 238)', hovered: 'rgb(0, 0, 255)' });
    expect(await backgrounds(css, 900)).toEqual({ resting: 'rgb(221, 221, 221)', hovered: 'rgb(0, 0, 255)' });
    expect(await backgrounds(css, 500)).toEqual({ resting: 'rgb(255, 255, 255)', hovered: 'rgb(255, 0, 0)' });
  });
});

/** A project design whose "Loud" tone colours its lead, and which takes content in a slot. */
function toned(s: ProjectState): ComponentDefinition {
  const def = {
    ...FOUNDATION.managed({
      componentId: 'project.toned',
      name: 'Toned',
      category: 'content',
      tags: [],
      icon: 'sparkles',
      description: '',
      properties: { lead: { type: 'string', label: 'Lead', default: 'Lead' } },
      parts: { root: { nodeId: 'root', label: 'Box' }, lead: { nodeId: 'lead', label: 'Lead' } },
      slots: { content: { label: 'Content' } },
      variantAxes: { tone: { label: 'Tone', default: 'plain', options: { plain: { label: 'Plain' }, loud: { label: 'Loud', styles: { lead: { base: { color: '#ff0000' } } } } } } },
      build: (b) => b.el('root', 'div', { name: 'Box' }, [b.text('lead', 'p', prop('lead'), { name: 'Lead' }), b.slot('content-slot', 'content')])
    }),
    owner: 'project' as const
  } as ComponentDefinition;
  s.components[def.id] = def;
  return def;
}

describe('a design’s state rules on a placement inside it', () => {
  /** A design holding a Toned placement whose lead it styles on hover, with another Toned placed in that one's slot. */
  function host(s: ProjectState) {
    const inner = toned(s);
    const outer = {
      ...FOUNDATION.managed({
        componentId: 'project.host',
        name: 'Host',
        category: 'content',
        tags: [],
        icon: 'sparkles',
        description: '',
        properties: {},
        parts: { root: { nodeId: 'root', label: 'Host' } },
        build: (b) => b.el('root', 'div', { name: 'Host' }, [])
      }),
      owner: 'project' as const
    } as ComponentDefinition;
    const first = makeInstance(inner, { lead: 'Outer lead' });
    const second = makeInstance(inner, { lead: 'Inner lead' });
    first.overrides = { lead: { base: { color: '#111111' }, 'base:hover': { color: '#00aa00' } } };
    first.slots = { content: [second.id] };
    outer.tree!.nodes[first.id] = first;
    outer.tree!.nodes[second.id] = second;
    (outer.tree!.nodes.root as ElementNode).children.push(first.id);
    s.components[outer.id] = outer;
    const placed = makeInstance(outer, {});
    home(s).nodes[placed.id] = placed;
    home(s).rootIds.push(placed.id);
    return { inner, outer, first, second };
  }

  it('reach only that placement’s part, through a class it is given, never the copy in its slot', () => {
    const s = fresh();
    const { inner, outer, first } = host(s);
    const files = generateProject(s);
    const css = files.get('src/lib/siteorigin/styles/components.css')!;
    const marker = nestedStateClass(outer, first.id, 'lead');
    const root = `.${nodeClass(outer, first.id)}`;
    // The resting rule is as it was; the state rule names the part's own class, as strongly.
    expect(css).toContain(`${root}${root} .${nodeClass(inner, 'lead')} {\n\tcolor: #111111;`);
    expect(css).toContain(`@media (hover: hover) {\n\t.${marker}.${marker}.${marker}:where(:hover) {\n\t\tcolor: #00aa00;`);
    expect(css).not.toMatch(/ \.so-[^{\s]*__lead:where\(:hover\)/);
    // The design hands its placement the class for that part alone.
    expect(files.get(defFile(outer))).toContain(`so_o={${JSON.stringify({ lead: marker })}}`);
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('copying and detaching', () => {
  it('pastes a copied element’s state rules, for every size or for one', () => {
    let s = styledBox();
    const from: ElementRef = { owner: owner(s), instancePath: [], nodeId: 'n_box' };
    const to: ElementRef = { owner: owner(s), instancePath: [], nodeId: 'n_other' };
    s = set(s, 'base', 'hover', 'background', '#999999', 'n_other');
    s = set(s, 'tablet', 'active', 'background', '#888888', 'n_other');
    const copy = captureStyle(s, from)!;
    const every = planStylePaste(s, copy, to, 'every');
    const pasted = applyOperations(s, every.operations).state;
    expect(box(pasted, 'n_other').styles).toEqual(box(s).styles);
    // The review names each change by its size and state.
    expect(every.rows.find((r) => r.property === 'background')?.changes.map((c) => [c.scope, c.state ?? null])).toEqual([
      ['base', null],
      ['base', 'hover'],
      ['phone', 'hover'],
      ['tablet', null],
      ['tablet', 'active'],
      ['desktop', null]
    ]);
    // One size writes the values the copy holds for it, its states included, and clears nothing it doesn't hold.
    s = set(s, 'phone', undefined, 'background', '#777777', 'n_other');
    s = set(s, 'phone', 'focus', 'background', '#666666', 'n_other');
    const phone = applyOperations(s, planStylePaste(s, copy, to, 'phone').operations).state;
    expect(box(phone, 'n_other').styles).toEqual({
      'base:hover': { background: '#999999' },
      phone: { background: '#777777' },
      'phone:hover': { background: '#ff0000' },
      'phone:focus': { background: '#666666' },
      'tablet:active': { background: '#888888' }
    });
    // A copy with state rules only is still a copy.
    const focused = set(withBoxes(), 'base', 'focus', 'color', '#00ff00');
    expect(captureStyle(focused, { owner: owner(focused), instancePath: [], nodeId: 'n_box' })?.sets).toHaveLength(1);
  });

  it('keeps the state rules a placement shows when it is detached, but not one a stronger resting value beats', () => {
    let s = fresh();
    const g = grid(s);
    const def = s.components[g.definitionId];
    const card = def.parts.card.nodeId;
    // The design's own card turns grey on hover; the placement makes every card white at rest and its border green
    // on hover, which beats the design's hover border; one item's own resting border beats the placement's hover one.
    def.tree!.nodes[card].styles = { ...(def.tree!.nodes[card].styles ?? {}), 'base:hover': { background: '#eeeeee', border: '1px solid #000000' } };
    const second = cards(s)[1].id;
    s = apply(s, [
      { type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', scope: 'base', property: 'background', value: '#ffffff' },
      { type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', scope: 'base', state: 'hover', property: 'border', value: '2px solid #00aa00' },
      { type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', itemId: second, scope: 'base', property: 'border', value: '3px solid #ff0000' }
    ]);
    const t = applyOperations(s, [{ type: 'component.detachInstance', owner: owner(s), nodeId: g.id } as EditOperation]).state;
    const detached = Object.values(home(t).nodes).filter((n) => n.detachedFrom?.node === card);
    expect(detached).toHaveLength(cards(s).length);
    const [one, two] = detached;
    // The placement's white beats the design's hover grey; its hover border beats the design's.
    expect(one.styles?.base?.background).toBe('#ffffff');
    expect(one.styles?.['base:hover']).toEqual({ border: '2px solid #00aa00' });
    // The item's resting border beats the placement's hover border, so its hover changes nothing.
    expect(two.styles?.base?.border).toBe('3px solid #ff0000');
    expect(two.styles?.['base:hover']).toBeUndefined();
  });

  it('folds each state of layers of rules on its own, a stronger resting value over a weaker state', () => {
    const layers = [
      { styles: { base: { color: '#000001' }, 'base:hover': { color: '#000002', opacity: 0.5 }, 'phone:hover': { color: '#000003' }, 'base:active': { background: '#000005' } } as ResponsiveStyles, strength: 1 },
      { styles: { base: { opacity: 1 }, 'base:focus': { radius: '4px' } } as ResponsiveStyles, strength: 2 }
    ];
    expect(flattenStates(layers)).toEqual({ 'base:hover': { color: '#000002' }, 'phone:hover': { color: '#000003' }, 'base:focus': { radius: '4px' }, 'base:active': { background: '#000005' } });
    // Layers beneath stay in force: their states are not written again.
    expect(flattenStates(layers, { beneath: 1 })).toEqual({ 'base:focus': { radius: '4px' } });
    // The same property in the same state, set by two layers: each size keeps the stronger one's.
    const sized = [{ styles: { 'base:hover': { background: '#00000a' } } as ResponsiveStyles, strength: 1 }, { styles: { 'phone:hover': { background: '#00000b' } } as ResponsiveStyles, strength: 3 }];
    expect(flattenStates(sized)).toEqual({ 'base:hover': { background: '#00000a' }, 'phone:hover': { background: '#00000b' } });
  });

  it('refuses what one element’s rules cannot show exactly', () => {
    // A beneath state (an inner design's later block) the result's resting value, now over it, would hide.
    const masked = [{ styles: { 'desktop:hover': { color: '#0000ff' } } as ResponsiveStyles, strength: 2.02 }, { styles: { base: { color: '#ff0000' } } as ResponsiveStyles, strength: 2.01 }];
    expect(flattenStates(masked, { beneath: 1 })).toBeNull();
    expect(flattenStates(masked)).toEqual({ 'desktop:hover': { color: '#0000ff' } });
    // Stronger resting custom CSS that sets what a state value does.
    const custom = [{ styles: { 'base:hover': { opacity: 0.25 } } as ResponsiveStyles, strength: 1 }, { styles: { base: { customCss: 'opacity: 1' } } as ResponsiveStyles, strength: 3 }];
    expect(flattenStates(custom)).toBeNull();
    expect(flattenStates([...custom].reverse().map((l, i) => ({ ...l, strength: i + 1 })))).toEqual({ 'base:hover': { opacity: 0.25 } });
    // A stronger resting side over a state's border.
    expect(flattenStates([{ styles: { 'base:hover': { border: '1px solid #0000ff' } } as ResponsiveStyles, strength: 1 }, { styles: { base: { borderBlockStart: '3px solid #ff0000' } } as ResponsiveStyles, strength: 3 }])).toBeNull();
    // Two layers' states on one property: which wins while both hold is the layers', not the states' order.
    expect(flattenStates([{ styles: { 'base:hover': { color: '#ff0000' } } as ResponsiveStyles, strength: 3 }, { styles: { 'base:focus': { color: '#00ff00' } } as ResponsiveStyles, strength: 1 }])).toBeNull();
    // One layer's own states and sides fold as they are: its rules keep their order.
    expect(flattenStates([{ styles: { base: { borderBlockStart: '3px solid #ff0000' }, 'base:hover': { border: '1px solid #0000ff' }, 'base:focus': { color: '#00ff00' } } as ResponsiveStyles, strength: 1 }])).toEqual({
      'base:hover': { border: '1px solid #0000ff' },
      'base:focus': { color: '#00ff00' }
    });
    // A stronger resting colour for the border reaches a weaker state's side through custom CSS.
    expect(flattenStates([{ styles: { 'base:hover': { borderBlockStart: '2px solid #0000ff' } } as ResponsiveStyles, strength: 1 }, { styles: { base: { customCss: 'border-color: red' } } as ResponsiveStyles, strength: 3 }])).toBeNull();
    // A stronger beneath side, in the same state as an own border the fold would put over it.
    expect(flattenStates([{ styles: { 'base:hover': { borderBlockStart: '2px solid #0000ff' } } as ResponsiveStyles, strength: 2 }, { styles: { 'base:hover': { border: '1px solid #000000' } } as ResponsiveStyles, strength: 1 }], { beneath: 1 })).toBeNull();
  });

  it('drops a side a later border overrides at one size, and keeps it at the others', () => {
    const one = [{ styles: { 'base:hover': { borderBlockStart: '3px solid #ff0000' }, 'phone:hover': { border: '1px solid #0000ff' } } as ResponsiveStyles, strength: 1 }];
    expect(flattenStates(one)).toEqual({ 'phone:hover': { border: '1px solid #0000ff' }, 'tablet:hover': { borderBlockStart: '3px solid #ff0000' }, 'desktop:hover': { borderBlockStart: '3px solid #ff0000' } });
  });

  it('folds states whose layers already agree with the state order, and leaves states beneath alone', () => {
    // A stronger layer's later state wins while both hold, before and after.
    const agree = [{ styles: { 'base:hover': { background: '#00000a' } } as ResponsiveStyles, strength: 1 }, { styles: { 'base:focus': { background: '#00000b' } } as ResponsiveStyles, strength: 2 }];
    expect(flattenStates(agree)).toEqual({ 'base:hover': { background: '#00000a' }, 'base:focus': { background: '#00000b' } });
    // A stronger hover that beats a weaker focus while both hold disagrees with the folded order...
    const disagree = [{ styles: { 'base:hover': { background: '#00000a' } } as ResponsiveStyles, strength: 2 }, { styles: { 'base:focus': { background: '#00000b' } } as ResponsiveStyles, strength: 1 }];
    expect(flattenStates(disagree)).toBeNull();
    // ...unless both are beneath, where both stay as they are.
    expect(flattenStates(disagree, { beneath: 2 })).toEqual({});
  });

  it('refuses a link’s state background a stronger resting one beats, which still paints it in that state', () => {
    const layers = [{ styles: { 'base:hover': { background: '#0000ff' } } as ResponsiveStyles, strength: 1 }, { styles: { base: { background: '#ff0000' } } as ResponsiveStyles, strength: 3 }];
    expect(flattenStates(layers)).toEqual({});
    expect(flattenStates(layers, { link: true })).toBeNull();
  });

  it('refuses to detach a placement whose state styles cannot be kept exactly, and changes nothing', () => {
    let s = fresh();
    const g = grid(s);
    s = apply(s, [
      { type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', scope: 'base', state: 'hover', property: 'border', value: '1px solid #0000ff' },
      { type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', itemId: cards(s)[1].id, scope: 'base', property: 'borderBlockStart', value: '3px solid #ff0000' }
    ]);
    rejects(() => applyOperations(s, [{ type: 'component.detachInstance', owner: owner(s), nodeId: g.id } as EditOperation]), /hover, focus or pressed styles/);
    expect(grid(s).id).toBe(g.id);
  });
});

describe('the document format', () => {
  it('marks state rules with a version-only step, so an older editor opens such a project read-only', () => {
    // The step upgrades format 9 to 10; the entry address step after it (10 to 11) only changes the version too.
    const from = MIGRATIONS.findIndex((m) => m.id === 'style-states') + 1;
    expect(from).toBe(9);
    const s = styledBox();
    const docs = (p: ProjectState) => [p.manifest, p.site, p.tokens, p.assets, p.themeLock, ...Object.values(p.pages), ...Object.values(p.components)];
    for (const d of docs(s)) d.schemaVersion = from;
    const before = structuredClone(s);
    const out = migrateProject(s)!;
    expect(out.applied).toEqual(['style-states', 'entry-addresses']);
    const unversioned = (p: ProjectState) => JSON.parse(JSON.stringify({ ...p, themeLock: undefined }, (k, v) => (k === 'schemaVersion' ? undefined : v)));
    expect(unversioned(out.state)).toEqual(unversioned(before));
  });
});
