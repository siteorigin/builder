/**
 * Background images (#354): a library image behind a container's or a section part's content, with how it fills the
 * box, its focus and a scrim. It is stored as a structured style value naming the asset, checked at the edit boundary
 * and on load, counted, replaced and refused removal like any image use, and written only by the generator, from the
 * library's own record of the file, so no style text can fetch an address.
 */
import { describe, expect, it } from 'vitest';
import { compile } from 'svelte/compiler';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import type { AssetRecord, ComponentDefinition, ElementNode, ElementRef, InstanceNode, ProjectState, TextNode } from '@shared/types';
import { canonicalStyleValue, partStyleControls, styleSetFor, styleToCss, validateStyleValue } from '@shared/styles';
import { createStarterState } from '@catalogue/starters';
import { FOUNDATION } from '@catalogue/foundation/pack';
import { prop } from '@catalogue/dsl';
import { applyOperations, assetUsages } from '@engine/apply';
import { EngineError } from '@engine/tree';
import { imageUses } from '@engine/image-uses';
import { validateState } from '@engine/validate';
import { defFile, generateComponentsCss, generateProject, generateSiteCss, nodeClass, pageNodeClass, variantClass } from '@generator/index';
import { fileVar } from '@generator/background';
import { captureStyle, planStylePaste } from '../../src/renderer/src/lib/style-copy';
import { imageUseRows } from '../../src/renderer/src/lib/asset-uses';

const HERO: AssetRecord = {
  id: 'a_hero',
  name: 'Harbour at dusk',
  file: 'static/assets/harbour-1a2b3c4d.jpg',
  mime: 'image/jpeg',
  bytes: 900000,
  width: 2400,
  height: 1600,
  hash: 'h-hero',
  kind: 'image',
  variants: [
    { width: 480, file: 'static/assets/harbour-1a2b3c4d-480w.jpg' },
    { width: 960, file: 'static/assets/harbour-1a2b3c4d-960w.jpg' },
    { width: 1440, file: 'static/assets/harbour-1a2b3c4d-1440w.jpg' }
  ],
  altSuggestion: 'Boats moored in the harbour at dusk',
  createdAt: '2026-01-01T00:00:00.000Z'
};
const OTHER: AssetRecord = { ...HERO, id: 'a_other', name: 'Market', file: 'static/assets/market-5e6f7a8b.jpg', hash: 'h-other', variants: undefined, width: undefined, altSuggestion: 'The market square' };
const FONT: AssetRecord = { id: 'a_font', name: 'Display face', file: 'static/assets/display-9a8b7c6d.woff2', mime: 'font/woff2', bytes: 100, hash: 'h-font', kind: 'font', font: { family: 'Display', weight: '400', style: 'normal' }, createdAt: '2026-01-01T00:00:00.000Z' };
const DOC: AssetRecord = { id: 'a_doc', name: 'Menu', file: 'static/assets/menu-0a1b2c3d.pdf', mime: 'application/pdf', bytes: 100, hash: 'h-doc', kind: 'document', createdAt: '2026-01-01T00:00:00.000Z' };

const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });

/** Applies operations the way the session does: each parsed by its schema first, then applied as one batch. */
function apply(s: ProjectState, ops: unknown[]) {
  const parsed = ops.map((o) => {
    const v = validateOperation(o);
    if (!v.ok) throw new Error(v.message);
    return v.op;
  });
  return applyOperations(s, parsed as EditOperation[]);
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

/** A project whose home page has a hero band (`n_band`, with a heading in it) and a plain box beside it, with the library's images, a font and a document. */
function studio(): ProjectState {
  const s = createStarterState('business', 'Harbour Studio', false);
  s.assets.assets = { ...s.assets.assets, a_hero: structuredClone(HERO), a_other: structuredClone(OTHER), a_font: structuredClone(FONT), a_doc: structuredClone(DOC) };
  const page = home(s);
  page.nodes.n_title = { id: 'n_title', kind: 'text', tag: 'h2', text: 'Sail with us' } as TextNode;
  page.nodes.n_band = { id: 'n_band', kind: 'element', tag: 'section', children: ['n_title'] } as ElementNode;
  page.nodes.n_box = { id: 'n_box', kind: 'element', tag: 'div', children: [] } as ElementNode;
  page.rootIds.push('n_band', 'n_box');
  return s;
}

const setBg = (s: ProjectState, value: unknown, extra: Record<string, unknown> = {}) => apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: 'n_band', scope: 'base', property: 'backgroundImage', value, ...extra }]).state;

/** A project design with a Tone axis, whose Dark option gives its box a photograph of its own. */
function toned(s: ProjectState): ComponentDefinition {
  const def = {
    ...FOUNDATION.managed({
      componentId: 'project.banner',
      name: 'Banner',
      category: 'content',
      tags: [],
      icon: 'sparkles',
      description: '',
      properties: { lead: { type: 'string', label: 'Lead', default: 'Lead' } },
      parts: { root: { nodeId: 'root', label: 'Box', styleControls: ['paddingBlock', 'background', 'color'] }, lead: { nodeId: 'lead', label: 'Lead', styleControls: ['color', 'background'] } },
      variantAxes: { tone: { label: 'Tone', default: 'light', options: { light: { label: 'Light' }, dark: { label: 'Dark', styles: { root: { base: { backgroundImage: { assetId: 'a_hero', scrim: 'rgba(0, 0, 0, 0.6)' } } } } } } } },
      build: (b) => b.el('root', 'div', { name: 'Box' }, [b.text('lead', 'p', prop('lead'), { name: 'Lead' })])
    }),
    owner: 'project' as const
  } as ComponentDefinition;
  s.components[def.id] = def;
  return def;
}

describe('the backgroundImage value', () => {
  it('takes a library image with an optional fill, focus and scrim, and nothing else', () => {
    expect(validateStyleValue('backgroundImage', { assetId: 'a_hero' })).toBeNull();
    expect(validateStyleValue('backgroundImage', { assetId: 'a_hero', size: 'contain', position: '30% 70%', scrim: 'rgba(0, 0, 0, 0.5)' })).toBeNull();
    expect(validateStyleValue('backgroundImage', { assetId: 'a_hero', scrim: 'linear-gradient(to bottom, rgba(0, 0, 0, 0), #000000cc)' })).toBeNull();
    expect(validateStyleValue('backgroundImage', { assetId: 'a_hero', position: 'top' })).toBeNull();
    // An address, a token, an extra key or a value outside each field's grammar is refused.
    expect(validateStyleValue('backgroundImage', 'url(/assets/harbour.jpg)')).toMatch(/assetId/);
    expect(validateStyleValue('backgroundImage', { token: 'color.brand' } as never)).toMatch(/not "token"/);
    expect(validateStyleValue('backgroundImage', { assetId: 'a_hero', url: '/x.jpg' } as never)).toMatch(/not "url"/);
    expect(validateStyleValue('backgroundImage', { assetId: '' })).toMatch(/assetId/);
    expect(validateStyleValue('backgroundImage', { assetId: 'a_hero', size: 'stretch' } as never)).toMatch(/cover/);
    expect(validateStyleValue('backgroundImage', { assetId: 'a_hero', position: '120% 10%' })).toMatch(/percentages/);
    // A scrim is a colour or one gradient spelled out in full: it never fetches anything, stacks layers, names a
    // variable (one naming nothing, or the picture itself, would make the browser drop the picture) or leaves a colour
    // to be read at run time.
    for (const scrim of ['rgb(0 0 0 / 0.5)', 'hsl(210deg 40% 20%)', 'black', 'linear-gradient(180deg, #000 0%, #0000 60%)', 'radial-gradient(circle at center, #0000, #000c)'])
      expect(validateStyleValue('backgroundImage', { assetId: 'a_hero', scrim }), scrim).toBeNull();
    for (const scrim of [
      'url(/x.jpg)',
      'image-set(url(/x.jpg) 1x)',
      'linear-gradient(#000, #fff), linear-gradient(#fff, #000)',
      'linear-gradient(#000, #fff), #000',
      'var(--so-color-brand)',
      'linear-gradient(var(--so-bg-image), black)',
      'linear-gradient(var(--so-color-fade), #000)',
      'rgb(from red r g b)',
      '#00000',
      'linear-gradient(90deg in hsl longer hue, #f00, #00f)',
      'linear-gradient(#000 /* x */, #fff)',
      'linear-gradient(#000)',
      'red; color: blue'
    ])
      expect(validateStyleValue('backgroundImage', { assetId: 'a_hero', scrim }), scrim).toMatch(/scrim/);
    // No other property takes one, and url() stays out of every text value.
    expect(validateStyleValue('background', { assetId: 'a_hero' })).not.toBeNull();
    expect(validateStyleValue('background', 'url(/x.jpg)')).not.toBeNull();
    expect(validateStyleValue('customCss', 'background-image: url(/x.jpg)')).not.toBeNull();
  });

  it('is stored without what is assumed anyway, and written by no style text', () => {
    expect(canonicalStyleValue({ assetId: 'a_hero', size: 'cover', position: 'center', scrim: '  ' })).toEqual({ assetId: 'a_hero' });
    expect(canonicalStyleValue({ scrim: ' #0008 ', position: '30% 70%', size: 'contain', assetId: 'a_hero' })).toEqual({ assetId: 'a_hero', size: 'contain', position: '30% 70%', scrim: '#0008' });
    // A keyword focus is stored as the point it names.
    expect(canonicalStyleValue({ assetId: 'a_hero', position: 'top' })).toEqual({ assetId: 'a_hero', position: '50% 0%' });
    // Only the generator writes it, from the library.
    expect(styleToCss('backgroundImage', { assetId: 'a_hero' })).toEqual([]);
  });

  it('is offered on containers and on a design part that lets its background change', () => {
    expect(styleSetFor({ kind: 'element' })).toContain('backgroundImage');
    for (const kind of ['text', 'link', 'image', 'icon']) expect(styleSetFor({ kind })).not.toContain('backgroundImage');
    const s = studio();
    const def = toned(s);
    expect(partStyleControls(def, 'root')).toEqual(['paddingBlock', 'background', 'backgroundImage', 'color']);
    // A text part keeps its own list, and so does a box that does not let its background change.
    expect(partStyleControls(def, 'lead')).toEqual(['color', 'background']);
    def.parts.root.styleControls = ['paddingBlock', 'color'];
    expect(partStyleControls(def, 'root')).toEqual(['paddingBlock', 'color']);
  });
});

describe('setting a background image', () => {
  it('stores the value on a container, a placement part, one item and a variant option', () => {
    let s = setBg(studio(), { assetId: 'a_hero', size: 'cover', position: '50% 30%', scrim: 'rgba(0, 0, 0, 0.55)' });
    expect(home(s).nodes.n_band.styles).toEqual({ base: { backgroundImage: { assetId: 'a_hero', position: '50% 30%', scrim: 'rgba(0, 0, 0, 0.55)' } } });
    // A section placement's part.
    const r = apply(s, [{ type: 'node.insert', owner: owner(s), parentId: null, index: 0, componentId: 'layout.section' }]);
    s = r.state;
    const sectionId = r.results[0].nodeId as string;
    s = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: sectionId, partId: 'root', scope: 'phone', property: 'backgroundImage', value: { assetId: 'a_other' } }]).state;
    expect((home(s).nodes[sectionId] as InstanceNode).overrides?.root).toEqual({ phone: { backgroundImage: { assetId: 'a_other' } } });
    // One card of a grid, leaving its siblings on the shared style.
    const g = apply(s, [{ type: 'node.insert', owner: owner(s), parentId: null, index: 0, componentId: 'features.grid' }]);
    s = g.state;
    const gridId = g.results[0].nodeId as string;
    const [first, second] = ((home(s).nodes[gridId] as InstanceNode).props.items as Array<{ id: string }>).map((i) => i.id);
    s = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: gridId, partId: 'card', itemId: second, scope: 'base', property: 'backgroundImage', value: { assetId: 'a_hero', scrim: '#0008' } }]).state;
    const items = (home(s).nodes[gridId] as InstanceNode).itemOverrides!.card.items;
    expect(items[second]).toEqual({ base: { backgroundImage: { assetId: 'a_hero', scrim: '#0008' } } });
    expect(items[first]).toBeUndefined();
    // A design's variant option.
    const def = toned(s);
    s = apply(s, [{ type: 'node.setStyle', owner: { kind: 'component', id: def.id }, nodeId: 'root', variant: 'light', axis: 'tone', scope: 'base', property: 'backgroundImage', value: { assetId: 'a_other', size: 'contain' } }]).state;
    expect(s.components[def.id].variantAxes!.tone.options.light.styles?.root).toEqual({ base: { backgroundImage: { assetId: 'a_other', size: 'contain' } } });
    // null removes it here.
    expect(home(setBg(s, null)).nodes.n_band.styles).toBeUndefined();
  });

  it('refuses a font, a document, an asset the library does not have, and a shape the schema does not take', () => {
    const s = studio();
    // An image record whose file is not a picture is no picture either.
    s.assets.assets.a_odd = { ...structuredClone(OTHER), id: 'a_odd', name: 'Odd file', mime: 'font/woff2' };
    rejects(() => setBg(s, { assetId: 'a_odd' }), /"Odd file" is not an image/);
    rejects(() => setBg(s, { assetId: 'a_font' }), /"Display face" is not an image/);
    rejects(() => setBg(s, { assetId: 'a_doc' }), /"Menu" is not an image/);
    rejects(() => setBg(s, { assetId: 'a_gone' }), /asset "a_gone" does not exist/);
    expect(validateOperation({ type: 'node.setStyle', owner: owner(s), nodeId: 'n_band', scope: 'base', property: 'backgroundImage', value: { assetId: 'a_hero', alt: 'Boats' } }).ok).toBe(false);
    rejects(() => setBg(s, { assetId: 'a_hero', scrim: 'url(/x.jpg)' }), /scrim/);
  });

  it('takes one in a component described whole, checked as node.setStyle checks it', () => {
    const s = studio();
    const upsert = (value: unknown) => apply(s, [{ type: 'component.upsert', name: 'Photo band', properties: {}, nodes: [{ kind: 'element', id: 'root', children: [], styles: { base: { backgroundImage: value } } }] }]);
    const r = upsert({ assetId: 'a_hero', scrim: '#0008' });
    const id = r.results[0].definitionId as string;
    expect(r.state.components[id].tree!.nodes.root.styles?.base?.backgroundImage).toEqual({ assetId: 'a_hero', scrim: '#0008' });
    rejects(() => upsert({ assetId: 'a_font' }), /"root": Background image: "Display face" is not an image/);
  });
});

describe('the library tracks background images as image uses', () => {
  /** The hero image behind the band, a section part on phones, and the Dark option of a design no page chooses. */
  function used() {
    let s = setBg(studio(), { assetId: 'a_hero', position: '50% 30%', scrim: 'rgba(0, 0, 0, 0.55)' });
    const r = apply(s, [{ type: 'node.insert', owner: owner(s), parentId: null, index: 0, componentId: 'layout.section' }]);
    s = r.state;
    const sectionId = r.results[0].nodeId as string;
    s = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: sectionId, partId: 'root', scope: 'phone', state: 'hover', property: 'backgroundImage', value: { assetId: 'a_hero', size: 'contain' } }]).state;
    const def = toned(s);
    return { s, sectionId, def };
  }

  it('counts each one, refuses removal while any is left, and lists each with its place', () => {
    const { s, def } = used();
    expect(assetUsages(s).a_hero).toBe(3);
    rejects(() => apply(s, [{ type: 'asset.remove', assetId: 'a_hero' }]), /This image is used 3 times/);
    const rows = imageUseRows(s, 'a_hero');
    // The band (a section element), the section placement's root on phones on hover, and the design's Dark option.
    expect(rows.map((r) => r.what).sort()).toEqual(['Box · Background image, Dark tone', 'Section · Background image', 'Section · Background image, phone on hover']);
    expect(rows.every((r) => r.background && r.alt === undefined)).toBe(true);
    // The variant's use is replaced only with every other one.
    const variant = imageUses(s, 'a_hero').find((u) => u.place && 'owner' in u.place && u.place.owner.kind === 'component');
    expect(variant).toMatchObject({ target: null, background: true, place: { owner: { kind: 'component', id: def.id }, nodeId: 'root' } });
  });

  it('replaces only the picture, never adding a description, everywhere or in the places chosen', () => {
    const { s, sectionId, def } = used();
    const all = apply(s, [{ type: 'asset.replace', assetId: 'a_hero', withAssetId: 'a_other' }]);
    expect(all.results[0].altReview).toEqual([]);
    expect(home(all.state).nodes.n_band.styles?.base?.backgroundImage).toEqual({ assetId: 'a_other', position: '50% 30%', scrim: 'rgba(0, 0, 0, 0.55)' });
    expect((home(all.state).nodes[sectionId] as InstanceNode).overrides?.root['phone:hover']?.backgroundImage).toEqual({ assetId: 'a_other', size: 'contain' });
    expect(all.state.components[def.id].variantAxes!.tone.options.dark.styles!.root.base!.backgroundImage).toEqual({ assetId: 'a_other', scrim: 'rgba(0, 0, 0, 0.6)' });
    expect(assetUsages(all.state).a_hero ?? 0).toBe(0);
    // In some places: the band alone, named by its style path.
    const band = imageUses(s, 'a_hero').find((u) => u.target?.kind === 'node' && u.target.nodeId === 'n_band')!.target!;
    expect(band).toEqual({ kind: 'node', owner: owner(s), nodeId: 'n_band', path: ['styles', 'base', 'backgroundImage'] });
    const some = apply(s, [{ type: 'asset.replace', assetId: 'a_hero', withAssetId: 'a_other', uses: [band] }]);
    expect(home(some.state).nodes.n_band.styles?.base?.backgroundImage).toEqual({ assetId: 'a_other', position: '50% 30%', scrim: 'rgba(0, 0, 0, 0.55)' });
    expect((home(some.state).nodes[sectionId] as InstanceNode).overrides?.root['phone:hover']?.backgroundImage).toEqual({ assetId: 'a_hero', size: 'contain' });
    expect(assetUsages(some.state).a_hero).toBe(2);
    // A part's rule in a state, named by its path, alone.
    const part = imageUses(s, 'a_hero').find((u) => u.target?.kind === 'node' && u.target.nodeId === sectionId)!.target!;
    expect(part).toEqual({ kind: 'node', owner: owner(s), nodeId: sectionId, path: ['overrides', 'root', 'phone:hover', 'backgroundImage'] });
    const onlyPart = apply(s, [{ type: 'asset.replace', assetId: 'a_hero', withAssetId: 'a_other', uses: [part] }]).state;
    expect(home(onlyPart).nodes.n_band.styles?.base?.backgroundImage).toMatchObject({ assetId: 'a_hero' });
    expect((home(onlyPart).nodes[sectionId] as InstanceNode).overrides?.root['phone:hover']?.backgroundImage).toEqual({ assetId: 'a_other', size: 'contain' });
  });

  it('replaces a detached copy of a design’s picture without changing the design', () => {
    let s = studio();
    const def = toned(s);
    const r = apply(s, [{ type: 'node.insert', owner: owner(s), parentId: null, index: 0, definitionId: def.id, variants: { tone: 'dark' } }]);
    s = apply(r.state, [{ type: 'component.detachInstance', owner: owner(r.state), nodeId: r.results[0].nodeId as string }]).state;
    const copy = imageUses(s, 'a_hero').find((u) => u.target?.kind === 'node' && u.target.owner.kind === 'page')!.target!;
    const t = apply(s, [{ type: 'asset.replace', assetId: 'a_hero', withAssetId: 'a_other', uses: [copy] }]).state;
    expect(t.components[def.id].variantAxes!.tone.options.dark.styles!.root.base!.backgroundImage).toEqual({ assetId: 'a_hero', scrim: 'rgba(0, 0, 0, 0.6)' });
    expect(imageUses(t, 'a_other').filter((u) => u.background)).toHaveLength(1);
  });

  it('never takes a component’s starting picture for a background image, whatever its property is called', () => {
    const s = studio();
    const def = toned(s);
    def.properties.styles = { type: 'object', label: 'Styles', fields: { backgroundImage: { type: 'image', label: 'Background', default: { assetId: null, alt: '' } } }, default: { backgroundImage: { assetId: 'a_hero', alt: HERO.altSuggestion! } } } as never;
    const start = imageUses(s, 'a_hero').find((u) => u.place && 'definitionId' in u.place)!;
    expect(start.place!.path).toEqual(['styles', 'default', 'backgroundImage']);
    expect(start.background).toBeUndefined();
    // So a replacement treats it as the picture it is: its suggested description follows the new picture.
    const t = apply(s, [{ type: 'asset.replace', assetId: 'a_hero', withAssetId: 'a_other' }]).state;
    expect((t.components[def.id].properties.styles as unknown as { default: { backgroundImage: unknown } }).default.backgroundImage).toEqual({ assetId: 'a_other', alt: OTHER.altSuggestion });
  });
});

describe('a stored background image, checked on load', () => {
  it('reports a missing or non-image asset and a broken shape once, where it is, and never asks for a description', () => {
    const s = studio();
    const band = home(s).nodes.n_band;
    band.styles = { base: { backgroundImage: { assetId: 'a_hero', scrim: 'rgba(0, 0, 0, 0.5)' } } };
    const clean = validateState(s);
    expect(clean.filter((d) => d.nodeId === 'n_band')).toEqual([]);
    s.assets.assets.a_odd = { ...structuredClone(OTHER), id: 'a_odd', name: 'Odd file', mime: 'font/woff2' };
    band.styles = { base: { backgroundImage: { assetId: 'a_gone' } }, phone: { backgroundImage: { assetId: 'a_font' } }, tablet: { backgroundImage: { assetId: 'a_hero', url: 'x' } as never }, desktop: { backgroundImage: { assetId: 'a_odd' } } };
    const found = validateState(s).filter((d) => d.nodeId === 'n_band');
    expect(found.map((d) => [d.code, d.site]).sort()).toEqual([
      ['ASSET_MISSING', 'n_band|own|base|backgroundImage'],
      ['ASSET_NOT_IMAGE', 'n_band|own|desktop|backgroundImage'],
      ['ASSET_NOT_IMAGE', 'n_band|own|phone|backgroundImage'],
      ['STYLE_VALUE_INVALID', 'n_band|own|tablet|backgroundImage']
    ]);
    expect(found.find((d) => d.code === 'ASSET_MISSING')!.message).toMatch(/background image references a missing asset/);
    expect(found.some((d) => d.code === 'ALT_MISSING')).toBe(false);
  });
});

describe('the stylesheet', () => {
  const band = (s: ProjectState) => `.${pageNodeClass('n_band')}`;

  it('paints the library file with its scrim, the copy each screen needs, and the focus kept in view', () => {
    const s = setBg(studio(), { assetId: 'a_hero', position: '50% 30%', scrim: 'rgba(0, 0, 0, 0.55)' });
    const css = generateSiteCss(s);
    expect(css).toContain(
      `${band(s)} {\n\t--so-bg-image: linear-gradient(rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.55)), url("/assets/harbour-1a2b3c4d.jpg");\n\t--so-bg-size: 100% 100%, cover;\n\t--so-bg-position: center, 50% 30%;\n\t--so-bg-repeat: no-repeat, no-repeat;\n\tbackground-image: var(--so-bg-image, none);`
    );
    // Phones and tablets take the smallest copy as wide as their widest screen, and the wider ones by density.
    expect(css).toMatch(/@media \(max-width: 767\.98px\) \{\n\t\.so-n-n_band \{\n\t\t--so-bg-image: linear-gradient\(rgba\(0, 0, 0, 0\.55\), rgba\(0, 0, 0, 0\.55\)\), image-set\(url\("\/assets\/harbour-1a2b3c4d-960w\.jpg"\) 1\.25x, url\("\/assets\/harbour-1a2b3c4d-1440w\.jpg"\) 1\.875x, url\("\/assets\/harbour-1a2b3c4d\.jpg"\) 3\.125x\);/);
    expect(css).toMatch(/@media \(min-width: 768px\) and \(max-width: 1023\.98px\) \{\n\t\.so-n-n_band \{\n\t\t--so-bg-image: linear-gradient\(rgba\(0, 0, 0, 0\.55\), rgba\(0, 0, 0, 0\.55\)\), image-set\(url\("\/assets\/harbour-1a2b3c4d-1440w\.jpg"\) 1\.406x, url\("\/assets\/harbour-1a2b3c4d\.jpg"\) 2\.344x\);/);
    // A box inside never takes the band's picture.
    expect(css).toContain(`:where(${band(s)}) {\n\t--so-bg-image: initial;`);
  });

  it('keeps the picture under a background colour set for one size, and leaves boxes without one as they were', () => {
    let s = setBg(studio(), { assetId: 'a_other' });
    s = apply(s, [
      { type: 'node.setStyle', owner: owner(s), nodeId: 'n_band', scope: 'phone', property: 'background', value: '#102030' },
      { type: 'node.setStyle', owner: owner(s), nodeId: 'n_box', scope: 'base', property: 'background', value: '#ffffff' }
    ]).state;
    const css = generateSiteCss(s);
    expect(css).toContain(
      `\t${band(s)} {\n\t\tbackground: #102030;\n\t\tbackground-image: var(--so-bg-image, none);\n\t\tbackground-size: var(--so-bg-size, auto);\n\t\tbackground-position: var(--so-bg-position, 0% 0%);\n\t\tbackground-repeat: var(--so-bg-repeat, repeat);\n\t}`
    );
    // No width on record: the original alone, at every size, each size saying so in its own rule.
    expect(css).toContain('--so-bg-image: url("/assets/market-5e6f7a8b.jpg");');
    expect(css).not.toContain('image-set(url("/assets/market');
    expect(css).toMatch(/@media \(max-width: 767\.98px\) \{\n\t\.so-n-n_band \{\n\t\t--so-bg-image: url\("\/assets\/market-5e6f7a8b\.jpg"\);\n\t\}/);
    expect(css).toContain(`.${pageNodeClass('n_box')} {\n\tbackground: #ffffff;\n}`);
  });

  it('falls back on what the element’s own gradient paints, without its colour, and never on text the stylesheet refuses', () => {
    let s = setBg(studio(), { assetId: 'a_other' }, { scope: 'phone' });
    s = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: 'n_band', scope: 'base', property: 'background', value: 'linear-gradient(#ff0000, #0000ff), #112233' }]).state;
    expect(generateSiteCss(s)).toContain(`${band(s)} {\n\tbackground: linear-gradient(#ff0000, #0000ff), #112233;\n\tbackground-image: var(--so-bg-image, linear-gradient(#ff0000, #0000ff));`);
    // A hand-edited gradient holding a comment writes nothing, and nothing after it.
    home(s).nodes.n_band.styles!.base = { background: 'linear-gradient(red /* x, blue)' };
    const css = generateSiteCss(s);
    expect(css).not.toContain('/* x');
    expect(css).not.toContain('linear-gradient(red');
  });

  it('keeps the picture of a component placed as a design’s box under a colour its placement sets', () => {
    const s = studio();
    const inner = toned(s);
    const outer = structuredClone(inner);
    outer.id = 'foundation.project.wrapper';
    outer.componentId = 'project.wrapper';
    outer.name = 'Wrapper';
    outer.variantAxes = undefined;
    outer.properties = {};
    outer.parts = { root: { nodeId: 'inner', label: 'Box', styleControls: ['background'] } };
    outer.tree = { rootIds: ['inner'], nodes: { inner: { id: 'inner', kind: 'instance', definitionId: inner.id, props: {}, overrides: { root: { base: { backgroundImage: { assetId: 'a_hero' } } } } } as InstanceNode } };
    s.components[outer.id] = outer;
    const r = apply(s, [{ type: 'node.insert', owner: owner(s), parentId: null, index: 0, definitionId: outer.id }]);
    const t = apply(r.state, [{ type: 'node.setStyle', owner: owner(r.state), nodeId: r.results[0].nodeId as string, partId: 'root', scope: 'phone', property: 'background', value: '#102030' }]).state;
    expect(generateSiteCss(t)).toMatch(/\{\n\t\tbackground: #102030;\n\t\tbackground-image: var\(--so-bg-image, none\);/);
  });

  it('writes nothing for a picture the library cannot show, or a file path that could escape its address', () => {
    const s = studio();
    const nodes = home(s).nodes;
    nodes.n_band.styles = { base: { backgroundImage: { assetId: 'a_font' } } };
    nodes.n_box.styles = { base: { backgroundImage: { assetId: 'a_gone' } } };
    expect(generateSiteCss(s)).not.toContain('url(');
    s.assets.assets.a_other.file = 'static/assets/x") , url("https://evil.example/y.jpg';
    nodes.n_band.styles = { base: { backgroundImage: { assetId: 'a_other' } } };
    expect(generateSiteCss(s)).not.toContain('url(');
  });

  it('writes a hover picture after the resting rules, in the hover query', () => {
    let s = setBg(studio(), { assetId: 'a_hero' });
    s = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: 'n_band', scope: 'base', state: 'hover', property: 'backgroundImage', value: { assetId: 'a_other', scrim: '#0008' } }]).state;
    const css = generateSiteCss(s);
    const hover = css.search(/@media \(hover: hover\) \{\n\t\.so-n-n_band:where\(:hover\) \{\n\t\t--so-bg-image: linear-gradient\(#0008, #0008\), url\("\/assets\/market-5e6f7a8b\.jpg"\);/);
    expect(hover).toBeGreaterThan(-1);
    // After the resting picture at every size, its phone copy included.
    expect(css.lastIndexOf('harbour-1a2b3c4d')).toBeLessThan(hover);
  });

  it('names a design’s picture in its own file, not in components.css, so a design no live page places ships none', () => {
    const s = studio();
    const def = toned(s);
    const files = generateProject(s);
    const shared = generateComponentsCss(s);
    expect(shared).not.toContain('url(');
    // Every rule stays in components.css, in its place in the cascade, naming the picture by its variable; it is reset there too.
    const v = fileVar('a_hero');
    const dark = `.${variantClass(def, 'tone', 'dark')}.${nodeClass(def, 'root')}`;
    expect(shared).toContain(`${dark} {\n\t--so-bg-image: linear-gradient(rgba(0, 0, 0, 0.6), rgba(0, 0, 0, 0.6)), var(${v});`);
    expect(shared).toMatch(new RegExp(`@media \\(max-width: 767\\.98px\\) \\{\\n\\t${dark.replace(/[.-]/g, '\\$&')} \\{\\n\\t\\t--so-bg-image: linear-gradient\\(rgba\\(0, 0, 0, 0\\.6\\), rgba\\(0, 0, 0, 0\\.6\\)\\), var\\(${fileVar('a_hero', 768)}\\);`));
    expect(shared).toContain(`:where(${dark}) {\n\t--so-bg-image: initial;`);
    // The design's own file defines each variable, for every size, on :root.
    const own = files.get(defFile(def))!;
    expect(own).toContain(`<style>\n\t:global(:root) {\n\t\t${v}: url("/assets/harbour-1a2b3c4d.jpg");`);
    expect(own).toContain(`\t\t${fileVar('a_hero', 768)}: image-set(url("/assets/harbour-1a2b3c4d-960w.jpg") 1.25x,`);
    // Svelte takes the block as it is and keeps it in the component's CSS.
    const compiled = compile(own, { filename: defFile(def), generate: 'client', runes: true, css: 'external' });
    expect(compiled.css?.code).toMatch(new RegExp(`:root \\{\\s*${v}: url\\("/assets/harbour-1a2b3c4d\\.jpg"\\);`));
    expect(compiled.warnings).toEqual([]);
    // A design with no picture keeps its file as it was.
    const plain = Object.values(s.components).find((d) => d.kind === 'managed' && d.id !== def.id)!;
    expect(files.get(defFile(plain))).not.toContain('<style>');
  });
});

describe('a design with a background image', () => {
  it('is not converted to code, which would keep its picture as an address no one tracks', () => {
    let s = studio();
    const def = toned(s);
    const r = apply(s, [{ type: 'node.insert', owner: owner(s), parentId: null, index: 0, definitionId: def.id }]);
    s = r.state;
    const nodeId = r.results[0].nodeId as string;
    rejects(() => apply(s, [{ type: 'component.convertToCode', owner: owner(s), nodeId }]), /background image from the library/);
    // A picture in the design's own rules is refused too; with none, the design converts.
    const own = structuredClone(s);
    own.components[def.id].variantAxes = undefined;
    own.components[def.id].tree!.nodes.root.styles = { base: { backgroundImage: { assetId: 'a_hero' } } };
    rejects(() => apply(own, [{ type: 'component.convertToCode', owner: owner(own), nodeId }]), /background image from the library/);
    delete own.components[def.id].tree!.nodes.root.styles;
    expect(() => apply(own, [{ type: 'component.convertToCode', owner: owner(own), nodeId }])).not.toThrow();
  });

  it('pastes its style only where the library has the picture', () => {
    const s = setBg(studio(), { assetId: 'a_hero', scrim: '#0008' });
    const from: ElementRef = { owner: owner(s), instancePath: [], nodeId: 'n_band' };
    const to: ElementRef = { owner: owner(s), instancePath: [], nodeId: 'n_box' };
    const copy = captureStyle(s, from)!;
    expect(planStylePaste(s, copy, to, 'every').operations).toEqual([{ type: 'node.setStyle', owner: owner(s), nodeId: 'n_box', scope: 'base', property: 'backgroundImage', value: { assetId: 'a_hero', scrim: '#0008' } }]);
    for (const make of [(x: ProjectState) => delete x.assets.assets.a_hero, (x: ProjectState) => (x.assets.assets.a_hero = { ...structuredClone(FONT), id: 'a_hero' }), (x: ProjectState) => (x.assets.assets.a_hero.mime = 'font/woff2')]) {
      const gone = structuredClone(s);
      make(gone);
      const plan = planStylePaste(gone, copy, to, 'every');
      expect(plan.operations).toEqual([]);
      expect(plan.rows).toEqual([expect.objectContaining({ property: 'backgroundImage', status: 'skip', reason: expect.stringMatching(/not in this project’s library/) })]);
    }
  });
});
