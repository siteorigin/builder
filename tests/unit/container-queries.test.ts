/**
 * Container queries (#667): style rules for the width of the nearest query container around an element
 * (`cq-narrow`, `cq-medium`, `cq-wide`) stored beside the screen sizes, set and cleared by the operations, checked
 * like any style, and written as plain `@container` rules after every screen size; `containerType` makes a box the
 * container they read. Detaching, copying, dropping and image sizes read them too.
 */
import { describe, expect, it } from 'vitest';
import { compile } from 'svelte/compiler';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import type { AssetRecord, ComponentDefinition, ElementNode, InstanceNode, ProjectState } from '@shared/types';
import { CONTAINER_SCOPES, STYLE_SCOPES, parseStyleScopeKey, styleScopeKey } from '@shared/types';
import { CONTAINER_QUERIES, MEDIA_QUERIES, containerVisibilityKept, flattenContainers, styleSetFor, styleToCss } from '@shared/styles';
import { applyOperations } from '@engine/apply';
import { EngineError } from '@engine/tree';
import { validateState } from '@engine/validate';
import { STYLES_DIR, defFile, generateProject, keepWeakerHides, nodeClass, pageNodeClass } from '@generator/index';
import { incomingOrder } from '../../src/renderer/src/lib/insert-drop';
import { SPACING_HANDLES, beaten, planHandle } from '../../src/renderer/src/lib/spacing-drag';
import { captureStyle, planStylePaste } from '../../src/renderer/src/lib/style-copy';
import { insertOps } from '../../src/renderer/src/lib/insert-at';
import { checkSvelteSource } from '../../src/main/codecheck';
import { documentMarkdown } from '@generator/llms';
import { containerSite, mediaCard } from './container-queries';

const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });

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

/** The stylesheet text the generator writes a definition's rules into: its own file in a clean export. */
function definitionCss(s: ProjectState, def: ComponentDefinition): string {
  const files = generateProject(s);
  const all = [...files.entries()].filter(([path]) => path.endsWith('.css') || path === defFile(def)).map(([, src]) => src);
  return all.join('\n');
}

/** The body of the first block `head {` in css, braces balanced. */
function blockAfter(css: string, head: string, from = 0): { body: string; at: number } | null {
  const at = css.indexOf(head, from);
  if (at < 0) return null;
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return { body: css.slice(css.indexOf('{', at) + 1, i), at };
  }
  return null;
}

describe('container width scopes', () => {
  it('are keys of their own beside the screen sizes, with states, and nothing else', () => {
    expect(CONTAINER_SCOPES).toEqual(['cq-narrow', 'cq-medium', 'cq-wide']);
    expect(STYLE_SCOPES).toEqual(['base', 'phone', 'tablet', 'desktop', 'cq-narrow', 'cq-medium', 'cq-wide']);
    expect(parseStyleScopeKey('cq-narrow')).toEqual({ scope: 'cq-narrow' });
    expect(parseStyleScopeKey('cq-wide:hover')).toEqual({ scope: 'cq-wide', state: 'hover' });
    expect(parseStyleScopeKey('cq-medium:groupFocus')).toEqual({ scope: 'cq-medium', state: 'groupFocus' });
    for (const k of ['cq', 'narrow', 'cq:narrow', 'cq-small', 'cq-narrow:visited', 'cq-narrow:hover:active', 'phone:cq-narrow']) expect(parseStyleScopeKey(k), k).toBeNull();
    expect(styleScopeKey('cq-narrow', 'active')).toBe('cq-narrow:active');
  });

  it('cover every container width once, with no gap between them', () => {
    expect(CONTAINER_QUERIES).toEqual({ 'cq-narrow': '(width < 480px)', 'cq-medium': '(min-width: 480px) and (width < 720px)', 'cq-wide': '(min-width: 720px)' });
  });

  it('are set and cleared by node.setStyle, in a state too, and reset on their own', () => {
    let s = containerSite().s;
    const at = { owner: owner(s), nodeId: 'n_main' };
    s = apply(s, [
      { type: 'node.setStyle', ...at, scope: 'base', property: 'background', value: '#ffffff' },
      { type: 'node.setStyle', ...at, scope: 'cq-narrow', property: 'layout', value: 'stack' },
      { type: 'node.setStyle', ...at, scope: 'cq-narrow', state: 'hover', property: 'background', value: '#eeeeee' },
      { type: 'node.setStyle', ...at, scope: 'cq-wide', property: 'gap', value: { token: 'space.lg' } }
    ]);
    expect(home(s).nodes.n_main.styles).toEqual({
      base: { layout: 'stack', containerType: 'inline-size', background: '#ffffff' },
      'cq-narrow': { layout: 'stack' },
      'cq-narrow:hover': { background: '#eeeeee' },
      'cq-wide': { gap: { token: 'space.lg' } }
    });
    // Resetting one container width takes its states with it, and leaves every other rule.
    const reset = apply(s, [{ type: 'node.resetStyles', ...at, scope: 'cq-narrow' }]);
    expect(home(reset).nodes.n_main.styles).toEqual({ base: { layout: 'stack', containerType: 'inline-size', background: '#ffffff' }, 'cq-wide': { gap: { token: 'space.lg' } } });
    const cleared = apply(s, [{ type: 'node.setStyle', ...at, scope: 'cq-wide', property: 'gap', value: null }]);
    expect(home(cleared).nodes.n_main.styles).not.toHaveProperty('cq-wide');
  });

  it('style a placement part and a design node the same way', () => {
    const site = containerSite();
    let s = apply(site.s, [{ type: 'node.setStyle', owner: owner(site.s), nodeId: site.columns.sideCard.id, partId: 'root', scope: 'cq-medium', property: 'gap', value: '12px' }]);
    expect((home(s).nodes[site.columns.sideCard.id] as InstanceNode).overrides).toEqual({ root: { 'cq-medium': { gap: '12px' } } });
    s = apply(s, [{ type: 'node.setStyle', owner: { kind: 'component', id: site.card.id }, nodeId: 'title', scope: 'cq-narrow', property: 'textAlign', value: 'center' }]);
    expect(s.components[site.card.id].tree!.nodes.title.styles?.['cq-narrow']).toEqual({ textAlign: 'center' });
  });

  it('cannot hide or show: visibility stays with the screen sizes', () => {
    const s = containerSite().s;
    rejects(() => apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: 'n_main', scope: 'cq-narrow', property: 'hidden', value: true }]), /Hidden cannot change with the width of the container/);
    // Clearing one a hand edit left is always allowed.
    home(s).nodes.n_main.styles!['cq-narrow'] = { hidden: true };
    expect(validateState(s).some((d) => d.code === 'STYLE_CONTAINER_PROPERTY' && d.nodeId === 'n_main')).toBe(true);
    const t = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: 'n_main', scope: 'cq-narrow', property: 'hidden', value: null }]);
    expect(home(t).nodes.n_main.styles).not.toHaveProperty('cq-narrow');
  });

  it('are checked like any style: an unknown range is reported, a known one passes', () => {
    const s = containerSite().s;
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
    (home(s).nodes.n_main.styles as Record<string, unknown>)['cq-small'] = { layout: 'stack' };
    const d = validateState(s).find((x) => x.code === 'STYLE_SCOPE_INVALID' && x.nodeId === 'n_main');
    expect(d?.message).toMatch(/"cq-small", which is neither a screen size, a container width nor/);
  });

  it('are offered to the operation schema and the assistant, with what they mean', () => {
    const v = validateOperation({ type: 'node.setStyle', owner: { kind: 'page', id: 'p' }, nodeId: 'n', scope: 'cq-wide', property: 'layout', value: 'row' });
    expect(v.ok).toBe(true);
    expect(validateOperation({ type: 'node.setStyle', owner: { kind: 'page', id: 'p' }, nodeId: 'n', scope: 'cq-small', property: 'layout', value: 'row' }).ok).toBe(false);
  });
});

describe('query containers', () => {
  it('are a layout style of a container, written as container-type', () => {
    expect(styleSetFor({ kind: 'element' })).toContain('containerType');
    expect(styleSetFor({ kind: 'text' })).not.toContain('containerType');
    expect(styleToCss('containerType', 'inline-size')).toEqual(['container-type: inline-size']);
    expect(styleToCss('containerType', 'normal')).toEqual(['container-type: normal']);
    // A hand-edited value outside the choices writes nothing.
    expect(styleToCss('containerType', 'size')).toEqual([]);
    const s = containerSite().s;
    rejects(() => apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: 'n_main', scope: 'base', property: 'containerType', value: 'size' }]), /Query container must be one of: inline-size, normal/);
  });

  it('are reported when their parent sizes them to their content, where they shrink to nothing', () => {
    const s = containerSite().s;
    const warned = (st: ProjectState, id: string) => validateState(st).some((d) => d.code === 'CONTAINER_COLLAPSE' && d.nodeId === id);
    expect(warned(s, 'n_main')).toBe(false);
    // In a horizontal stack with no width or grow of its own.
    home(s).nodes.n_grid.styles = { base: { layout: 'row' } };
    expect(warned(s, 'n_main')).toBe(true);
    home(s).nodes.n_main.styles!.base!.flexGrow = 1;
    expect(warned(s, 'n_main')).toBe(false);
    // A minimum width holds it open.
    delete home(s).nodes.n_main.styles!.base!.flexGrow;
    home(s).nodes.n_main.styles!.base!.minWidth = '240px';
    expect(warned(s, 'n_main')).toBe(false);
    // Fitting its own content, wherever it is.
    home(s).nodes.n_side.styles!.desktop = { width: 'fit' };
    expect(warned(s, 'n_side')).toBe(true);
    expect(validateState(s).find((d) => d.code === 'CONTAINER_COLLAPSE')?.severity).toBe('warning');
  });

  it('are reported in a stack that centres its items and in a grid with a column sized by its content', () => {
    const s = containerSite().s;
    const warned = (id: string) => validateState(s).find((d) => d.code === 'CONTAINER_COLLAPSE' && d.nodeId === id)?.message ?? null;
    home(s).nodes.n_grid.styles = { base: { layout: 'stack', align: 'center' } };
    expect(warned('n_main')).toMatch(/vertical stack that aligns its items/);
    home(s).nodes.n_grid.styles = { base: { layout: 'stack', align: 'stretch' } };
    expect(warned('n_main')).toBeNull();
    home(s).nodes.n_grid.styles = { base: { layout: 'grid' }, desktop: { gridTemplate: 'auto 1fr' } };
    expect(warned('n_main')).toMatch(/grid with a column sized by its content/);
    home(s).nodes.n_grid.styles = { base: { layout: 'grid' }, desktop: { gridTemplate: 'minmax(0, 2fr) 1fr' } };
    expect(warned('n_main')).toBeNull();
    home(s).nodes.n_grid.styles = { base: { layout: 'grid', gridTemplate: 'auto-fit-md' }, tablet: { gridTemplate: 'repeat(auto-fill, minmax(18rem, 1fr))' } };
    expect(warned('n_main')).toBeNull();
    // A repeat lays out no box: the stack around it is the parent.
    home(s).nodes.n_grid.styles = { base: { layout: 'row' } };
    home(s).nodes.n_rep = { id: 'n_rep', kind: 'repeat', list: { $prop: 'items' }, children: ['n_main'] } as never;
    (home(s).nodes.n_grid as ElementNode).children = ['n_rep', 'n_side'];
    expect(warned('n_main')).toMatch(/horizontal stack/);
  });
});

describe('the stylesheet', () => {
  it('writes container rules as @container blocks after every screen size', () => {
    const { s, card } = containerSite();
    const css = definitionCss(s, card);
    const cls = nodeClass(card, 'card');
    const own = css.indexOf(`/* Media card (${card.id}) */`);
    expect(own).toBeGreaterThanOrEqual(0);
    const desktop = blockAfter(css, `@media ${MEDIA_QUERIES.desktop}`, own)!;
    expect(desktop.body).toContain(`.${cls}`);
    const narrow = blockAfter(css, `@container ${CONTAINER_QUERIES['cq-narrow']}`, own)!;
    expect(narrow.body).toMatch(new RegExp(`\\.${cls} \\{\\s*display: flex;\\s*flex-direction: column;\\s*\\}`));
    // After the desktop rule it beats, in the same stylesheet.
    expect(narrow.at).toBeGreaterThan(desktop.at);
    // No Builder runtime and no script: plain CSS only.
    expect(css).not.toMatch(/@container[^{]*\bso-/);
  });

  it('writes the host as container-type on the column and the slot holder', () => {
    const { s, split } = containerSite();
    const files = generateProject(s);
    const site = files.get(`${STYLES_DIR}/site.css`)!;
    for (const id of ['n_main', 'n_side']) expect(site).toMatch(new RegExp(`\\.${pageNodeClass(id)} \\{[^}]*container-type: inline-size`));
    for (const id of ['main', 'side']) expect(definitionCss(s, split)).toMatch(new RegExp(`\\.${nodeClass(split, id)} \\{[^}]*container-type: inline-size`));
  });

  it('puts a container range’s state rules in its container block, inside the hover query', () => {
    let { s, card } = containerSite();
    s = apply(s, [
      { type: 'node.setStyle', owner: { kind: 'component', id: card.id }, nodeId: 'card', scope: 'cq-wide', state: 'hover', property: 'background', value: '#123456' },
      { type: 'node.setStyle', owner: { kind: 'component', id: card.id }, nodeId: 'card', scope: 'phone', state: 'hover', property: 'background', value: '#654321' }
    ]);
    const css = definitionCss(s, card);
    const hover = blockAfter(css, '@media (hover: hover) {\n\t@container')!;
    expect(hover.body).toContain(`@container ${CONTAINER_QUERIES['cq-wide']}`);
    expect(hover.body).toContain('#123456');
    // After the phone's hover rule, so a wide container's hover wins on a phone in the same layer.
    expect(css.indexOf('#654321')).toBeGreaterThan(0);
    expect(hover.at).toBeGreaterThan(css.indexOf('#654321'));
    expect(hover.body).toMatch(new RegExp(`\\.${nodeClass(card, 'card')}:where\\(:hover\\) \\{\\s*background: #123456;`));
  });

  /** Every @container block of `css` for one range, its body, in order. */
  const rangeBlocks = (css: string, scope: 'cq-narrow' | 'cq-medium' | 'cq-wide') =>
    [...css.matchAll(new RegExp(`@container ${CONTAINER_QUERIES[scope].replace(/[()]/g, '\\$&')} \\{`, 'g'))].map((m) => blockAfter(css, m[0], m.index!)!.body);
  const phoneHide = (sel: string) => new RegExp(`@media ${MEDIA_QUERIES.phone.replace(/[()]/g, '\\$&')} \\{\\s*${sel.replace(/\./g, '\\.')} \\{\\s*display: none;`);

  it('never shows what a screen size hides: a container layout is followed by the hide where it wins', () => {
    let s = containerSite().s;
    s = apply(s, [
      { type: 'node.setStyle', owner: owner(s), nodeId: 'n_side', scope: 'phone', property: 'hidden', value: true },
      { type: 'node.setStyle', owner: owner(s), nodeId: 'n_side', scope: 'cq-narrow', property: 'layout', value: 'row' }
    ]);
    const site = () => generateProject(s).get(`${STYLES_DIR}/site.css`)!;
    const sel = `.${pageNodeClass('n_side')}`;
    let narrow = rangeBlocks(site(), 'cq-narrow').find((b) => b.includes('flex-direction: row'))!;
    expect(narrow).toMatch(phoneHide(sel));
    expect(narrow).not.toContain(MEDIA_QUERIES.desktop);
    // Hidden at every size: one hide for the whole range, with no gap between the screen sizes.
    s = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: 'n_side', scope: 'base', property: 'hidden', value: true }]);
    narrow = rangeBlocks(site(), 'cq-narrow').find((b) => b.includes('flex-direction: row'))!;
    expect(narrow).toMatch(new RegExp(`\\}\\s*${sel.replace(/\./g, '\\.')} \\{\\s*display: none;\\s*\\}\\s*$`));
    expect(narrow).not.toContain('@media');
    // Where a screen size's own layout shows it, it stays shown: only phone and tablet keep the hide.
    s = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: 'n_side', scope: 'phone', property: 'hidden', value: null }, { type: 'node.setStyle', owner: owner(s), nodeId: 'n_side', scope: 'desktop', property: 'layout', value: 'grid' }]);
    narrow = rangeBlocks(site(), 'cq-narrow').find((b) => b.includes('flex-direction: row'))!;
    expect(narrow).toMatch(phoneHide(sel));
    expect(narrow).toContain(MEDIA_QUERIES.tablet);
    expect(narrow).not.toContain(MEDIA_QUERIES.desktop);
  });

  it('lets a stronger layer’s container layout show what a weaker one hides, as its screen-size layout does', () => {
    const site = containerSite();
    site.s.components[site.card.id].tree!.nodes.card.styles!.phone = { hidden: true };
    const s = apply(site.s, [
      { type: 'node.setStyle', owner: owner(site.s), nodeId: site.columns.sideCard.id, partId: 'root', scope: 'cq-medium', property: 'layout', value: 'grid' },
      { type: 'node.setStyle', owner: owner(site.s), nodeId: site.columns.sideCard.id, partId: 'root', scope: 'desktop', property: 'layout', value: 'row' }
    ]);
    const css = generateProject(s).get(`${STYLES_DIR}/site.css`)!;
    const cls = `so-o-${site.columns.sideCard.id}-root`.replace(/[^a-zA-Z0-9_-]/g, '-');
    const medium = rangeBlocks(css, 'cq-medium').find((b) => b.includes(`.${cls}.${cls}`))!;
    expect(medium).toContain('display: grid');
    expect(medium).not.toContain('display: none');
  });

  it('keeps a design’s container layout where a placement shows its part again', () => {
    const site = containerSite();
    const nodes = site.s.components[site.card.id].tree!.nodes;
    nodes.card.styles!.base = { ...nodes.card.styles!.base, hidden: true };
    const s = apply(site.s, [{ type: 'node.setStyle', owner: owner(site.s), nodeId: site.columns.sideCard.id, partId: 'root', scope: 'base', property: 'hidden', value: false }]);
    const css = generateProject(s).get(`${STYLES_DIR}/site.css`)!;
    const cls = `so-o-${site.columns.sideCard.id}-root`.replace(/[^a-zA-Z0-9_-]/g, '-');
    // The show writes the display the design's narrow stack writes, in the narrow range, over its own show.
    expect(rangeBlocks(css, 'cq-narrow').join('\n')).toMatch(new RegExp(`\\.${cls}\\.${cls} \\{\\s*display: flex;`));
    // Unless the placement sets a display of its own for that range, which keeps its place.
    const t = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: site.columns.sideCard.id, partId: 'root', scope: 'cq-narrow', property: 'customCss', value: 'display: none' }]);
    const narrow = rangeBlocks(generateProject(t).get(`${STYLES_DIR}/site.css`)!, 'cq-narrow').join('\n');
    expect(narrow).toMatch(new RegExp(`\\.${cls}\\.${cls} \\{\\s*display: none;`));
    expect(narrow).not.toMatch(new RegExp(`\\.${cls}\\.${cls} \\{\\s*display: flex;`));
  });

  it('restores no container layout for an option’s show, whose block other options share', () => {
    const site = containerSite();
    const def = site.s.components[site.card.id];
    def.tree!.nodes.card.styles = { base: { hidden: true }, 'cq-narrow': { layout: 'grid' } };
    def.variantAxes = { look: { label: 'Look', default: 'plain', options: { plain: { label: 'Plain' }, open: { label: 'Open', styles: { card: { base: { hidden: false } } } } } } };
    const css = definitionCss(site.s, def);
    const narrow = rangeBlocks(css, 'cq-narrow').join('\n');
    expect(narrow).toContain(`.${nodeClass(def, 'card')} {`);
    expect(narrow).not.toContain('--look-open');
  });

  it('keeps in the Markdown copy what a stronger container layout may show', () => {
    const site = containerSite();
    site.s.components[site.card.id].tree!.nodes.title.styles = { base: { hidden: true } };
    site.s.components[site.card.id].parts.title = { nodeId: 'title', label: 'Title', styleControls: ['layout'] };
    const markdown = (st: ProjectState) => documentMarkdown(st, { kind: 'page', pageId: st.site.homePageId }, '/');
    expect(markdown(site.s)).toContain('URL:');
    expect(markdown(site.s)).not.toContain('Sidebar column');
    const s = apply(site.s, [{ type: 'node.setStyle', owner: owner(site.s), nodeId: site.columns.sideCard.id, partId: 'title', scope: 'cq-narrow', property: 'customCss', value: 'display: block' }]);
    expect(markdown(s)).toContain('Sidebar column');
    // Where the same rules hide it at every size, the container display is followed by that hide: still left out.
    const t = apply(site.s, [
      { type: 'node.setStyle', owner: owner(site.s), nodeId: site.columns.sideCard.id, partId: 'title', scope: 'base', property: 'hidden', value: true },
      { type: 'node.setStyle', owner: owner(site.s), nodeId: site.columns.sideCard.id, partId: 'title', scope: 'cq-narrow', property: 'customCss', value: 'display: block' }
    ]);
    expect(markdown(t)).not.toContain('Sidebar column');
    // A container rule that hides is no show.
    const u = apply(site.s, [{ type: 'node.setStyle', owner: owner(site.s), nodeId: site.columns.sideCard.id, partId: 'title', scope: 'cq-narrow', property: 'customCss', value: 'display: none' }]);
    expect(markdown(u)).not.toContain('Sidebar column');
  });

  it('leaves an item that sets no display of its own to a shared container layout', () => {
    const site = containerSite();
    const def = site.s.components[site.card.id];
    def.tree!.nodes.media.styles = { base: { hidden: true } };
    def.parts.media = { nodeId: 'media', label: 'Media', styleControls: ['layout', 'background'] };
    const inst = home(site.s).nodes[site.columns.sideCard.id] as InstanceNode;
    inst.overrides = { media: { 'cq-narrow': { layout: 'grid' } } };
    expect(keepWeakerHides(def, inst, 'media', { base: { background: '#ff0000' } })).toEqual({ base: { background: '#ff0000' } });
    // One that sets a display still keeps the weaker hide at each size.
    expect(keepWeakerHides(def, inst, 'media', { base: { layout: 'row' } })).toEqual({ base: { layout: 'row' }, phone: { hidden: true }, tablet: { hidden: true }, desktop: { hidden: true } });
    // With no container layout under it, a colour alone keeps the hide too, as before.
    inst.overrides = {};
    expect(keepWeakerHides(def, inst, 'media', { base: { background: '#ff0000' } })).toEqual({ base: { background: '#ff0000' }, phone: { hidden: true }, tablet: { hidden: true }, desktop: { hidden: true } });
  });

  it('leaves image sizes to the default when a container rule changes how wide a box on the way is', () => {
    const s0 = containerSite().s;
    const owner0 = owner(s0);
    const photo: AssetRecord = { id: 'a_photo', name: 'Photo', file: 'static/assets/photo-1a2b3c4d.jpg', mime: 'image/jpeg', bytes: 10, width: 2400, height: 1600, hash: 'h', kind: 'image', createdAt: 'now', variants: [480, 960].map((w) => ({ width: w, file: `static/assets/photo-1a2b3c4d-${w}w.jpg` })) };
    let r = applyOperations(s0, [{ type: 'asset.add', asset: photo }, { type: 'node.insert', owner: owner0, parentId: null, index: 0, componentId: 'layout.section' }]);
    const section = r.results[1].nodeId as string;
    r = applyOperations(r.state, [{ type: 'node.insert', owner: owner0, parentId: section, slot: 'content', primitive: 'grid' }]);
    const grid = r.results[0].nodeId as string;
    r = applyOperations(r.state, [{ type: 'node.setStyle', owner: owner0, nodeId: grid, scope: 'desktop', property: 'columns', value: 4 }, { type: 'node.insert', owner: owner0, parentId: grid, primitive: 'image' }]);
    r = applyOperations(r.state, [{ type: 'node.setContent', owner: owner0, nodeId: r.results[1].nodeId as string, field: 'image', value: { assetId: 'a_photo', alt: 'A room' } }]);
    const sizes = (s: ProjectState) => generateProject(s).get('src/routes/+page.svelte')!.match(/<SoImage [^\n]*photo-1a2b3c4d[^\n]*/)?.[0].match(/ sizes="([^"]*)"/)?.[1] ?? null;
    // A quarter of the Section's 1200px container on desktop.
    expect(sizes(r.state)).toBe('(min-width: 1024px) 300px, (min-width: 768px) 100vw, 100vw');
    // One column in a wide container: the picture can be the whole container, which no screen size tells.
    const t = applyOperations(r.state, [{ type: 'node.setStyle', owner: owner0, nodeId: grid, scope: 'cq-wide', property: 'columns', value: 1 }]).state;
    expect(sizes(t)).toBeNull();
    // A container rule that only paints changes nothing.
    const u = applyOperations(r.state, [{ type: 'node.setStyle', owner: owner0, nodeId: grid, scope: 'cq-wide', property: 'background', value: '#eeeeee' }]).state;
    expect(sizes(u)).toBe('(min-width: 1024px) 300px, (min-width: 768px) 100vw, 100vw');
  });
});

describe('code converted from a placement', () => {
  it('keeps its container rules, in a stylesheet Svelte compiles and checks clean', async () => {
    const site = containerSite();
    const s = apply(site.s, [{ type: 'node.setStyle', owner: owner(site.s), nodeId: site.columns.sideCard.id, partId: 'root', scope: 'phone', property: 'hidden', value: true }]);
    const r = applyOperations(s, [{ type: 'component.convertToCode', owner: owner(s), nodeId: site.columns.sideCard.id }]);
    const code = r.state.components[r.results[0].definitionId as string];
    const source = code.source!;
    expect(source).toContain(`@container ${CONTAINER_QUERIES['cq-narrow']}`);
    expect(source).toMatch(/flex-direction: column/);
    expect(() => compile(source, { filename: code.sourcePath, generate: 'server', runes: true })).not.toThrow();
    expect((await checkSvelteSource(source, { filename: code.sourcePath })).filter((p) => p.severity === 'error')).toEqual([]);
  });
});

describe('detaching, copying and dropping', () => {
  const layers = (...styles: Array<[Record<string, unknown>, number]>) => styles.map(([st, strength]) => ({ styles: st as never, strength, wideColumns: strength > 1 }));

  it('keeps a design’s container rules, and a placement’s over them', () => {
    expect(flattenContainers(layers([{ base: { layout: 'row' }, 'cq-narrow': { layout: 'stack' } }, 1], [{ 'cq-narrow': { gap: '8px' } }, 3]))).toEqual({ 'cq-narrow': { layout: 'stack', gap: '8px' } });
    // A placement's own narrow layout over the design's row, as the stylesheet shows it.
    expect(flattenContainers(layers([{ base: { layout: 'row' } }, 1], [{ 'cq-narrow': { layout: 'stack' } }, 3]))).toEqual({ 'cq-narrow': { layout: 'stack' } });
    // The stronger value of one property in one range.
    expect(flattenContainers(layers([{ 'cq-wide': { gap: '8px' } }, 1], [{ 'cq-wide': { gap: '24px' } }, 3]))).toEqual({ 'cq-wide': { gap: '24px' } });
  });

  it('leaves out a container rule a stronger value for every size always beat, but not one kept off phones', () => {
    expect(flattenContainers(layers([{ 'cq-narrow': { gap: '8px' } }, 1], [{ base: { gap: '24px' } }, 3]))).toEqual({});
    // Three columns for all sizes from a placement apply from tablet up only: a phone in a narrow column keeps two.
    expect(flattenContainers(layers([{ 'cq-narrow': { columns: 2 } }, 1], [{ base: { columns: 3 } }, 3]))).toBeNull();
  });

  it('refuses what one element’s rules cannot show exactly', () => {
    // A placement's desktop value beat the design's narrow one; folded, the narrow one would win on desktop.
    expect(flattenContainers(layers([{ 'cq-narrow': { layout: 'stack' } }, 1], [{ desktop: { layout: 'row' } }, 3]))).toBeNull();
    // The longhand from the weaker layer: one rule would write it after the shorthand that beat it.
    expect(flattenContainers(layers([{ 'cq-narrow': { rowGap: '24px' } }, 2], [{ 'cq-narrow': { gap: '8px' } }, 3]))).toBeNull();
    // Custom CSS written together that would be more than one element's custom CSS can hold.
    const decls = (n: number, p: string) => Array.from({ length: n }, (_, i) => `--${p}${i}: 1`).join('; ');
    expect(flattenContainers(layers([{ 'cq-narrow': { customCss: decls(13, 'a') } }, 1], [{ 'cq-narrow': { customCss: decls(12, 'b') } }, 3]))).toBeNull();
    // A weaker state over a stronger resting value: folded, the state would win where it lost.
    expect(flattenContainers(layers([{ 'cq-narrow:hover': { color: '#ff0000' } }, 1], [{ base: { color: '#000000' } }, 3]))).toBeNull();
  });

  it('folds what one element shows the same way: equal layers by stylesheet order, states, hides and custom CSS', () => {
    // Two options of one design: a narrow rule of the earlier beats the later's value for all sizes, its block coming later.
    expect(flattenContainers(layers([{ 'cq-narrow': { gap: '8px' } }, 2], [{ base: { gap: '24px' }, desktop: { gap: '30px' } }, 2]))).toEqual({ 'cq-narrow': { gap: '8px' } });
    // A placement's narrow hover over a design's resting colour wins before and after.
    expect(flattenContainers(layers([{ base: { color: '#000000' } }, 1], [{ 'cq-narrow:hover': { color: '#ff0000' } }, 3]))).toEqual({ 'cq-narrow:hover': { color: '#ff0000' } });
    // A stronger hide over a container layout hides either way.
    expect(flattenContainers(layers([{ 'cq-narrow': { layout: 'stack' } }, 1], [{ base: { hidden: true } }, 3]))).toEqual({ 'cq-narrow': { layout: 'stack' } });
    // A weaker hide that stays beneath, under the result: the container layout shows over it before and after.
    expect(flattenContainers(layers([{ base: { hidden: true } }, 1], [{ 'cq-narrow': { layout: 'stack' } }, 3]), { beneath: 1 })).toEqual({ 'cq-narrow': { layout: 'stack' } });
    // A shorthand and its longhand in one range, the longhand from the stronger layer: one rule writes them in that order.
    expect(flattenContainers(layers([{ 'cq-narrow': { gap: '8px' } }, 2], [{ 'cq-narrow': { rowGap: '24px' } }, 3]))).toEqual({ 'cq-narrow': { gap: '8px', rowGap: '24px' } });
    // Custom CSS that sets nothing in common with a stronger one: both apply, in one range or beside a rule for all sizes.
    expect(flattenContainers(layers([{ 'cq-narrow': { customCss: 'color: red' } }, 1], [{ base: { customCss: 'opacity: 0.5' } }, 3]))).toEqual({ 'cq-narrow': { customCss: 'color: red' } });
    expect(flattenContainers(layers([{ 'cq-narrow': { customCss: 'color: red' } }, 1], [{ 'cq-narrow': { customCss: 'opacity: 0.5' } }, 3]))).toEqual({ 'cq-narrow': { customCss: 'color: red; opacity: 0.5' } });
    // Custom CSS that does: the stronger wins where it sets all the weaker one does; only part of it can't be shown.
    expect(flattenContainers(layers([{ 'cq-narrow': { customCss: 'color: red' } }, 1], [{ 'cq-narrow': { customCss: 'color: blue' } }, 3]))).toEqual({ 'cq-narrow': { customCss: 'color: blue' } });
    expect(flattenContainers(layers([{ 'cq-narrow': { customCss: 'color: red; margin: 0' } }, 1], [{ 'cq-narrow': { customCss: 'color: blue' } }, 3]))).toBeNull();
    expect(flattenContainers(layers([{ 'cq-narrow': { customCss: 'color: red; margin: 0' } }, 1], [{ base: { customCss: 'color: blue' } }, 3]))).toBeNull();
  });

  it('folds only where one element shows and hides in every container as the layers did', () => {
    // A weaker hide folded in with a container layout that showed over it: the folded layout's own hide would follow it.
    const over = layers([{ base: { hidden: true } }, 1], [{ 'cq-narrow': { layout: 'stack' } }, 3]);
    expect(containerVisibilityKept(over, { base: { hidden: true }, 'cq-narrow': { layout: 'stack' } })).toBe(false);
    const css = layers([{ base: { customCss: 'display: none' } }, 1], [{ 'cq-narrow': { layout: 'grid' } }, 3]);
    expect(containerVisibilityKept(css, { base: { customCss: 'display: none' }, 'cq-narrow': { layout: 'grid' } })).toBe(false);
    // The placement already shows it at every size: the hide is gone from the fold, and nothing changes.
    const shown = layers([{ base: { hidden: true } }, 1], [{ base: { layout: 'row' }, 'cq-narrow': { layout: 'stack' } }, 3]);
    expect(flattenContainers(shown)).toEqual({ 'cq-narrow': { layout: 'stack' } });
    expect(containerVisibilityKept(shown, { base: { layout: 'row' }, 'cq-narrow': { layout: 'stack' } })).toBe(true);
    // Two options: the first hides it and stacks it in a narrow container (where its own hide follows), the second
    // shows it as a row. Folded, the row wins outside and the stack would show inside, where it was hidden.
    const options = layers([{ base: { hidden: true }, 'cq-narrow': { layout: 'stack' } }, 2], [{ base: { layout: 'row' } }, 2]);
    expect(containerVisibilityKept(options, { base: { layout: 'row' }, 'cq-narrow': { layout: 'stack' } })).toBe(false);
    // A layer beneath keeps its hide where it is, under the result.
    expect(containerVisibilityKept(over, { 'cq-narrow': { layout: 'stack' } }, 1)).toBe(true);
    // No container display anywhere: nothing to check.
    expect(containerVisibilityKept(layers([{ base: { hidden: true } }, 1]), { base: { hidden: true } })).toBe(true);
  });

  it('carries container rules through a detach, and refuses one that cannot be shown exactly', () => {
    const site = containerSite();
    const detached = applyOperations(site.s, [{ type: 'component.detachInstance', owner: owner(site.s), nodeId: site.columns.sideCard.id } as EditOperation]).state;
    const root = Object.values(home(detached).nodes).find((n) => n.kind === 'element' && n.detachedFrom?.node === 'card') as ElementNode;
    expect(root.styles?.['cq-narrow']).toEqual({ layout: 'stack' });
    const s = apply(site.s, [{ type: 'node.setStyle', owner: owner(site.s), nodeId: site.columns.sideCard.id, partId: 'root', scope: 'desktop', property: 'layout', value: 'block' }]);
    rejects(() => applyOperations(s, [{ type: 'component.detachInstance', owner: owner(s), nodeId: site.columns.sideCard.id } as EditOperation]), /width of the container around it/);
  });

  it('copies and pastes container rules with every size', () => {
    let s = containerSite().s;
    s = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: 'n_main', scope: 'cq-narrow', property: 'gap', value: '4px' }]);
    const ref = (nodeId: string) => ({ owner: owner(s), instancePath: [], nodeId });
    const copy = captureStyle(s, ref('n_main'))!;
    expect(copy).toBeTruthy();
    const plan = planStylePaste(s, copy, ref('n_side'), 'every');
    expect(plan.operations).toContainEqual(expect.objectContaining({ nodeId: 'n_side', scope: 'cq-narrow', property: 'gap', value: '4px' }));
  });

  it('cannot tell where a component lands among ordered items when its Order follows the container', () => {
    const card = mediaCard();
    const s = containerSite().s;
    expect(incomingOrder(s, { definitionId: card.id } as never)).toBe(0);
    s.components[card.id].tree!.nodes.card.styles!['cq-narrow'] = { order: 1 };
    expect(incomingOrder(s, { definitionId: card.id } as never)).toBeNull();
  });

  it('leaves new columns as they were: a query container is the author’s choice', () => {
    const s = containerSite().s;
    const ops = insertOps({ owner: owner(s), parentId: 'n_main' }, { primitive: 'grid', columns: 3 }, 'element');
    expect(ops.filter((op) => op.type === 'node.insert' && op.primitive === 'stack')).toHaveLength(3);
    expect(ops.some((op) => op.type === 'node.setStyle' && op.property === 'containerType')).toBe(false);
  });

  it('will not drag a spacing value that a container width’s own value would beat', () => {
    const names = ['padding', 'padding-block', 'padding-block-start'];
    for (const c of CONTAINER_SCOPES) expect(beaten({ base: { paddingBlockStart: '8px' }, [c]: { paddingBlockStart: '24px' } }, 'desktop', 'desktop', 'paddingBlockStart', 'paddingBlock', 'paddingBlockStart', names), c).toBe(true);
    expect(beaten({ base: { paddingBlockStart: '8px' } }, 'desktop', 'desktop', 'paddingBlockStart', 'paddingBlock', 'paddingBlockStart', names)).toBe(false);
    // Nor on every card, where one card keeps a container width's value of its own.
    const target = { owner: { kind: 'page' as const, id: 'p' }, nodeId: 'n', partId: 'card', styles: {}, offered: ['paddingBlockStart', 'paddingBlock'], everyItem: true };
    const top = SPACING_HANDLES.find((h) => h.box === 'padding' && h.side === 'top')!;
    expect(planHandle(top, { ...target, items: { i1: { base: { color: '#000' } } } }, 'base', 'desktop', false)).not.toBeNull();
    expect(planHandle(top, { ...target, items: { i1: { 'cq-wide': { paddingBlockStart: '4px' } } } }, 'base', 'desktop', false)).toBeNull();
  });
});
