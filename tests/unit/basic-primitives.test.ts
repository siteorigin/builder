/**
 * Badges, figures and decorative divider shapes (#356): basic elements Insert, node.insert and component authoring
 * make from the existing node kinds, which undo as one change and export as clean, accessible markup. A badge is an
 * inline pill holding an optional icon and its label, a figure an image with its figcaption, and a divider can be
 * drawn as an angled or wavy band, or as hairlines around an icon: inline SVG in the divider's text color, hidden
 * from screen readers, with no file or script of its own.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DividerNode, ElementNode, IconNode, ImageNode, OwnerRef, ProjectState, TextNode } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { getTheme } from '@catalogue/index';
import { MIGRATIONS } from '@shared/migrations';
import { SCHEMA_VERSION } from '@shared/types';
import { usedIcons } from '@generator/runtime-files';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { compile } from 'svelte/compiler';
import { STYLES_DIR, generateProject, generateStandaloneComponent, pageFile } from '@generator/index';
import { ProjectSession } from '../../src/main/project/session';
import { BASICS, basicSpec, basicHay, searchItems } from '../../src/renderer/src/lib/insert-search';
import { insertOps, insertSelection, placeFor } from '../../src/renderer/src/lib/insert-at';
import { removeRendered, serverHtml } from './generated-site';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
afterAll(() => removeRendered());

const SECTION = 'n_section01';

/** A blank site whose Home holds one empty Section, ready to take basic elements in its content. */
function blank(): { s: ProjectState; owner: OwnerRef } {
  const s = createStarterState('blank', 'Test Studio', false);
  const owner: OwnerRef = { kind: 'page', id: s.site.homePageId };
  return { s: applyOperations(s, [{ type: 'node.insert', newNodeId: SECTION, owner, parentId: null, componentId: 'layout.section' }]).state, owner };
}

/** Inserts into the Section's content and gives back the state and the inserted node's ID. */
function insert(s: ProjectState, owner: OwnerRef, op: Partial<Extract<EditOperation, { type: 'node.insert' }>>) {
  const r = applyOperations(s, [{ type: 'node.insert', owner, parentId: SECTION, slot: 'content', ...op }]);
  return { s: r.state, id: r.results[0].nodeId as string };
}

const nodes = (s: ProjectState) => s.pages[s.site.homePageId].nodes;
const content = (s: ProjectState) => (s.pages[s.site.homePageId].nodes[SECTION] as { slots: Record<string, string[]> }).slots.content;
const errors = (s: ProjectState) => validateState(s).filter((d) => d.severity === 'error');
const fail = (s: ProjectState, ops: EditOperation[]) => () => applyOperations(s, ops);

describe('inserting a badge', () => {
  it('makes an inline pill holding a leading icon and its label, in the site’s tokens', () => {
    const { s: start, owner } = blank();
    const { s, id } = insert(start, owner, { primitive: 'badge', text: 'Now booking', icon: 'calendar' });
    const badge = nodes(s)[id] as ElementNode;
    expect(badge).toMatchObject({ kind: 'element', tag: 'span', name: 'Badge' });
    expect(badge.children).toHaveLength(2);
    const [icon, label] = badge.children.map((c) => nodes(s)[c]);
    expect(icon).toMatchObject({ kind: 'icon', icon: 'calendar' });
    // Decorative beside its label: no accessible name of its own.
    expect((icon as IconNode).ariaLabel).toBeUndefined();
    expect(label).toMatchObject({ kind: 'text', tag: 'span', text: 'Now booking', name: 'Label', styles: { base: { textStyle: { token: 'text.eyebrow' } } } });
    expect((icon as IconNode).styles?.base).toEqual({ fontSize: '1em' });
    expect(badge.styles?.base).toMatchObject({
      layout: 'row',
      gap: { token: 'space.2xs' },
      paddingBlock: { token: 'space.2xs' },
      paddingInline: { token: 'space.sm' },
      customCss: 'display: inline-flex',
      width: 'fit',
      radius: { token: 'radius.pill' },
      background: { token: 'color.surface-alt' },
      color: { token: 'color.text' }
    });
    // Only the badge itself is in the section; what it holds is inside it, each with an ID of its own.
    expect(content(s)).toEqual([id]);
    expect(new Set([id, ...badge.children]).size).toBe(3);
    expect(errors(s)).toEqual([]);
  });

  it('leaves the icon out unless one is named, and refuses an icon the site does not have', () => {
    const { s: start, owner } = blank();
    const { s, id } = insert(start, owner, { primitive: 'badge' });
    const badge = nodes(s)[id] as ElementNode;
    expect(badge.children.map((c) => nodes(s)[c].kind)).toEqual(['text']);
    expect((nodes(s)[badge.children[0]] as TextNode).text).toBe('New');
    expect(fail(start, [{ type: 'node.insert', owner, parentId: SECTION, slot: 'content', primitive: 'badge', icon: 'not-an-icon' }])).toThrow(/"not-an-icon" is not an available icon/);
    const trimmed = insert(start, owner, { primitive: 'badge', icon: ' star ' });
    expect((nodes(trimmed.s)[trimmed.id] as ElementNode).children.map((c) => nodes(trimmed.s)[c])).toMatchObject([{ kind: 'icon', icon: 'star' }, { kind: 'text' }]);
    const blankIcon = insert(start, owner, { primitive: 'badge', icon: '  ' });
    expect((nodes(blankIcon.s)[blankIcon.id] as ElementNode).children).toHaveLength(1);
  });

  it('takes only the site styles the theme declares, so a theme without one still inserts it', () => {
    const { s: start, owner } = blank();
    const theme = getTheme(start.site.themeId) as { tokens: { id: string }[] };
    const all = theme.tokens;
    theme.tokens = all.filter((t) => t.id !== 'text.eyebrow' && t.id !== 'radius.pill' && t.id !== 'text.small');
    try {
      const badge = insert(start, owner, { primitive: 'badge', text: 'New' });
      const root = nodes(badge.s)[badge.id] as ElementNode;
      expect(root.styles?.base).not.toHaveProperty('radius');
      expect(root.styles?.base).toMatchObject({ background: { token: 'color.surface-alt' }, customCss: 'display: inline-flex' });
      expect(nodes(badge.s)[root.children[0]].styles?.base).toEqual({});
      const figure = insert(badge.s, owner, { primitive: 'figure' });
      const caption = nodes(figure.s)[(nodes(figure.s)[figure.id] as ElementNode).children[1]];
      expect(caption.styles?.base).toEqual({ color: { token: 'color.muted' } });
      expect(validateState(figure.s).filter((d) => d.code === 'TOKEN_MISSING')).toEqual([]);
    } finally {
      theme.tokens = all;
    }
  });

  it('sits in a line of text: allowed inside a paragraph container, where a figure is reported', () => {
    const { s: start, owner } = blank();
    let { s, id: para } = insert(start, owner, { primitive: 'stack' });
    s = applyOperations(s, [{ type: 'node.setContent', owner, nodeId: para, field: 'tag', value: 'p' }]).state;
    const inPara = (op: Partial<Extract<EditOperation, { type: 'node.insert' }>>) => applyOperations(s, [{ type: 'node.insert', owner, parentId: para, ...op }]).state;
    expect(errors(inPara({ primitive: 'badge', icon: 'star' }))).toEqual([]);
    expect(errors(inPara({ primitive: 'figure' })).map((d) => d.message).join(' ')).toMatch(/inline|paragraph/i);
  });
});

describe('inserting a figure', () => {
  it('groups an image with a caption beneath it, or with none when the caption is empty', () => {
    const { s: start, owner } = blank();
    const { s, id } = insert(start, owner, { primitive: 'figure', text: 'The workshop at dawn.' });
    const figure = nodes(s)[id] as ElementNode;
    expect(figure).toMatchObject({ kind: 'element', tag: 'figure', name: 'Figure' });
    expect(figure.children).toHaveLength(2);
    const [image, caption] = figure.children.map((c) => nodes(s)[c]);
    expect(image).toMatchObject({ kind: 'image', image: { assetId: null, alt: '' } });
    expect(caption).toMatchObject({ kind: 'text', tag: 'figcaption', name: 'Caption', text: 'The workshop at dawn.' });
    expect(content(s)).toEqual([id]);
    expect(errors(s)).toEqual([]);

    const bare = insert(start, owner, { primitive: 'figure', text: '' });
    expect((nodes(bare.s)[bare.id] as ElementNode).children.map((c) => nodes(bare.s)[c].kind)).toEqual(['image']);
  });

  it('keeps its caption with it when duplicated, under new IDs', () => {
    const { s: start, owner } = blank();
    const { s, id } = insert(start, owner, { primitive: 'figure' });
    const r = applyOperations(s, [{ type: 'node.duplicate', owner, nodeId: id }]);
    const copyId = r.results[0].nodeId as string;
    const copy = nodes(r.state)[copyId] as ElementNode;
    const original = nodes(r.state)[id] as ElementNode;
    expect(copy.tag).toBe('figure');
    const strip = (ids: string[]) => ids.map((c) => ({ ...nodes(r.state)[c], id: undefined }));
    expect(strip(copy.children)).toEqual(strip(original.children));
    expect(nodes(r.state)[copy.children[1]]).toMatchObject({ tag: 'figcaption' });
    expect(copy.children.filter((c) => original.children.includes(c))).toEqual([]);
    expect(errors(r.state)).toEqual([]);
  });

  it('takes what is inserted into it next before its caption, which stays last', () => {
    const { s: start, owner } = blank();
    const { s, id } = insert(start, owner, { primitive: 'figure' });
    const at = placeFor(s, owner, 'element', { owner, instancePath: [], nodeId: id })!;
    expect(at).toMatchObject({ parentId: id, index: 1 });
    const r = applyOperations(s, insertOps(at, { primitive: 'paragraph' }, 'element', 'n_para0001'));
    const kids = (nodes(r.state)[id] as ElementNode).children.map((c) => (nodes(r.state)[c] as { tag?: string }).tag ?? nodes(r.state)[c].kind);
    expect(kids).toEqual(['image', 'p', 'figcaption']);
    // A figure without a caption takes it at the end.
    const bare = insert(start, owner, { primitive: 'figure', text: '' });
    expect(placeFor(bare.s, owner, 'element', { owner, instancePath: [], nodeId: bare.id })).toEqual({ owner, parentId: bare.id });
  });

  it('reports a caption moved out of its figure', () => {
    const { s: start, owner } = blank();
    const { s, id } = insert(start, owner, { primitive: 'figure' });
    const caption = (nodes(s)[id] as ElementNode).children[1];
    const moved = applyOperations(s, [{ type: 'node.move', owner, nodeId: caption, parentId: SECTION, slot: 'content', index: 0 }]);
    expect(validateState(moved.state).some((d) => d.nodeId === caption && d.severity === 'error' && /goes directly inside a figure/.test(d.message))).toBe(true);
  });
});

describe('decorative divider shapes', () => {
  it('stores a band’s shape alone, and a plain line as it always was', () => {
    const { s: start, owner } = blank();
    const line = insert(start, owner, { primitive: 'divider' });
    expect(nodes(line.s)[line.id]).toEqual({ id: line.id, kind: 'divider' });
    const named = insert(start, owner, { primitive: 'divider', shape: 'line' });
    expect(nodes(named.s)[named.id]).toEqual({ id: named.id, kind: 'divider' });
    // Its color is the site's brand color until the author picks one (the generator's band styles).
    for (const shape of ['angle', 'wave'] as const) {
      const r = insert(start, owner, { primitive: 'divider', shape });
      expect(nodes(r.s)[r.id]).toEqual({ id: r.id, kind: 'divider', shape });
      expect(errors(r.s)).toEqual([]);
    }
    const leaf = insert(start, owner, { primitive: 'divider', shape: 'icon', icon: 'leaf' });
    expect(nodes(leaf.s)[leaf.id]).toEqual({ id: leaf.id, kind: 'divider', shape: 'icon', icon: 'leaf' });
    const star = insert(start, owner, { primitive: 'divider', shape: 'icon', icon: 'star' });
    expect(nodes(star.s)[star.id]).toMatchObject({ icon: 'star' });
    const plain = insert(start, owner, { primitive: 'divider', shape: 'icon' });
    expect('icon' in nodes(plain.s)[plain.id]).toBe(false);
  });

  it('changes shape and icon afterwards, keeping only what the shape shows', () => {
    const { s: start, owner } = blank();
    let { s, id } = insert(start, owner, { primitive: 'divider', shape: 'wave' });
    s = applyOperations(s, [{ type: 'node.setStyle', owner, nodeId: id, scope: 'base', property: 'color', value: { token: 'color.accent' } }]).state;
    const set = (field: 'shape' | 'icon', value: unknown) => (s = applyOperations(s, [{ type: 'node.setContent', owner, nodeId: id, field, value }]).state);
    set('shape', 'icon');
    expect(nodes(s)[id]).toMatchObject({ shape: 'icon' });
    expect((nodes(s)[id] as DividerNode).icon).toBeUndefined();
    set('icon', 'heart');
    expect((nodes(s)[id] as DividerNode).icon).toBe('heart');
    // An icon is a name, never bound: a binding is refused and the chosen icon kept.
    expect(fail(s, [{ type: 'node.setContent', owner, nodeId: id, field: 'icon', value: { $prop: 'mark' } }])).toThrow(/the name of an icon/);
    set('icon', null);
    expect('icon' in nodes(s)[id]).toBe(false);
    set('icon', 'heart');
    set('shape', 'line');
    expect('shape' in nodes(s)[id] || 'icon' in nodes(s)[id]).toBe(false);
    set('shape', 'icon');
    set('icon', 'heart');
    set('shape', 'angle');
    expect(nodes(s)[id]).toMatchObject({ shape: 'angle' });
    expect('icon' in nodes(s)[id]).toBe(false);
    set('shape', 'line');
    expect('shape' in nodes(s)[id]).toBe(false);
    // The color it was given stays: changing the shape is not a restyle.
    expect(nodes(s)[id].styles?.base).toEqual({ color: { token: 'color.accent' } });
  });

  it('refuses a shape or icon anywhere it means nothing', () => {
    const { s: start, owner } = blank();
    const { s, id } = insert(start, owner, { primitive: 'divider', shape: 'angle' });
    const image = insert(start, owner, { primitive: 'image' });
    const into = (op: Partial<Extract<EditOperation, { type: 'node.insert' }>>) => fail(start, [{ type: 'node.insert', owner, parentId: SECTION, slot: 'content', ...op }]);
    expect(into({ primitive: 'heading', shape: 'wave' })).toThrow(/Only a divider has a shape/);
    expect(into({ primitive: 'heading', icon: 'star' })).toThrow(/starts with an icon/);
    expect(into({ primitive: 'divider', shape: 'wave', icon: 'star' })).toThrow(/starts with an icon/);
    expect(into({ componentId: 'layout.section', shape: 'wave' })).toThrow(/Only a divider has a shape/);
    expect(into({ primitive: 'repeat', bind: 'items', icon: 'star' })).toThrow(/Only a divider has a shape/);
    expect(fail(s, [{ type: 'node.setContent', owner, nodeId: id, field: 'shape', value: 'zigzag' }])).toThrow(/shape must be line, angle, wave, icon/);
    expect(fail(s, [{ type: 'node.setContent', owner, nodeId: id, field: 'icon', value: 'star' }])).toThrow(/Only a divider of shape "icon"/);
    expect(fail(image.s, [{ type: 'node.setContent', owner, nodeId: image.id, field: 'shape', value: 'wave' }])).toThrow(/Only dividers have a shape/);
    // The schema itself takes only the shapes there are.
    expect(validateOperation({ type: 'node.insert', owner, primitive: 'divider', shape: 'zigzag' }).ok).toBe(false);
  });

  it('reports a shape or icon a hand-edited document names that cannot be drawn', () => {
    const { s: start, owner } = blank();
    const { s, id } = insert(start, owner, { primitive: 'divider', shape: 'icon' });
    const damaged = (patch: Record<string, unknown>) => {
      const next = structuredClone(s);
      Object.assign(nodes(next)[id], patch);
      return validateState(next).filter((d) => d.code === 'DIVIDER_INVALID');
    };
    expect(damaged({})).toEqual([]);
    expect(damaged({ shape: 'zigzag' })[0]).toMatchObject({ severity: 'error', nodeId: id, site: `${id}|shape` });
    expect(damaged({ shape: { $prop: 'edge' } })).toHaveLength(1);
    expect(damaged({ icon: 'not-an-icon' })[0].message).toMatch(/not available/);
    expect(damaged({ shape: 'wave', icon: 'star' })[0].message).toMatch(/only a divider of shape "icon"/);
    expect(damaged({ icon: { $prop: 'mark' } })[0].message).toMatch(/not available/);
    // A theme's own design, as the project keeps its copy, is read the same way.
    const theme = Object.values(s.components).find((d) => d.owner === 'theme' && d.tree)!;
    const themed = structuredClone(s);
    const root = themed.components[theme.id].tree!.rootIds[0];
    themed.components[theme.id].tree!.nodes.edge = { id: 'edge', kind: 'divider', shape: 'zigzag' } as never;
    (themed.components[theme.id].tree!.nodes[root] as ElementNode).children.push('edge');
    expect(validateState(themed).filter((d) => d.code === 'DIVIDER_INVALID')).toMatchObject([{ nodeId: 'edge', owner: { kind: 'component', id: theme.id } }]);
  });

  it('is built whole in a component design, and refused an icon its shape does not show', () => {
    const { s } = blank();
    const upsert = (divider: Record<string, unknown>): EditOperation =>
      ({ type: 'component.upsert', name: 'Edge', properties: {}, nodes: [{ kind: 'element', id: 'root', children: ['edge'] }, { kind: 'divider', id: 'edge', ...divider }] }) as EditOperation;
    const made = applyOperations(s, [upsert({ shape: 'icon', icon: 'leaf', styles: { color: { token: 'color.brand' } } })]);
    const def = made.state.components[made.results[0].definitionId as string];
    expect(def.tree!.nodes.edge).toMatchObject({ kind: 'divider', shape: 'icon', icon: 'leaf', styles: { base: { color: { token: 'color.brand' } } } });
    const line = applyOperations(s, [upsert({ shape: 'line' })]);
    expect('shape' in line.state.components[line.results[0].definitionId as string].tree!.nodes.edge).toBe(false);
    expect(fail(s, [upsert({ shape: 'wave', icon: 'leaf' })])).toThrow(/Only a divider of shape "icon" shows an icon/);
    expect(fail(s, [upsert({ shape: 'icon', icon: 'not-an-icon' })])).toThrow(/not an available icon/);
    expect(validateOperation(upsert({ shape: 'zigzag' })).ok).toBe(false);
  });

  it('keeps its layout when the design is converted to code, in the code’s own styles', () => {
    const { s } = blank();
    const made = applyOperations(s, [
      { type: 'component.upsert', name: 'Edge', properties: {}, nodes: [{ kind: 'element', id: 'root', children: ['edge', 'mark'] }, { kind: 'divider', id: 'edge', shape: 'wave' }, { kind: 'divider', id: 'mark', shape: 'icon' }] } as EditOperation
    ]);
    const def = made.state.components[made.results[0].definitionId as string];
    const source = generateStandaloneComponent(made.state, def);
    expect(source).toContain(':global(:where(.so-band)) { display: block; width: 100%; height: 3rem; color: var(--so-color-brand, currentColor); }');
    expect(source).toContain(':global(.so-band-icon > .so-band-icon__rule)');
    expect(source).toContain(':global(:where(.so-band-icon > .so-icon))');
    const css = compile(source, { filename: 'Edge.svelte', generate: 'server', runes: true }).css?.code ?? '';
    // Unscoped, so the icon its helper draws is reached too.
    expect(css).toContain(':where(.so-band-icon > .so-icon)');
    expect(css).not.toMatch(/\.so-band-icon\.svelte-/);
  });
});

describe('Insert → Basics', () => {
  it('offers a badge, a figure and the three divider shapes, found by what they are', () => {
    const byId = Object.fromEntries(BASICS.map((b) => [b.id, b]));
    expect(basicSpec(byId.badge)).toEqual({ primitive: 'badge' });
    expect(basicSpec(byId.figure)).toEqual({ primitive: 'figure' });
    expect(basicSpec(byId['divider-angle'])).toEqual({ primitive: 'divider', shape: 'angle' });
    expect(basicSpec(byId['divider-wave'])).toEqual({ primitive: 'divider', shape: 'wave' });
    expect(basicSpec(byId['divider-icon'])).toEqual({ primitive: 'divider', shape: 'icon' });
    // The plain Divider is still a plain line.
    expect(basicSpec(byId.divider)).toEqual({ primitive: 'divider' });
    const items = BASICS.map((b) => ({ ...b, hay: basicHay(b) }));
    expect(searchItems(items, 'caption').map((b) => b.id)).toContain('figure');
    expect(searchItems(items, 'eyebrow').map((b) => b.id)).toEqual(['badge']);
    expect(searchItems(items, 'wave').map((b) => b.id)[0]).toBe('divider-wave');
    for (const b of BASICS) expect(validateOperation({ type: 'node.insert', owner: { kind: 'page', id: 'p' }, ...basicSpec(b), columns: undefined }).ok, b.id).toBe(true);
    // What each new tile inserts, through the operations Insert sends.
    const { s, owner } = blank();
    const made = (id: string) => {
      const r = applyOperations(s, insertOps({ owner, parentId: SECTION, slot: 'content' }, basicSpec(byId[id]), 'element', 'n_tile0001'));
      return nodes(r.state).n_tile0001 as unknown as Record<string, unknown>;
    };
    expect(made('divider-angle')).toMatchObject({ kind: 'divider', shape: 'angle' });
    expect(made('divider-wave')).toMatchObject({ kind: 'divider', shape: 'wave' });
    expect(made('divider-icon')).toMatchObject({ kind: 'divider', shape: 'icon' });
    expect(made('badge')).toMatchObject({ kind: 'element', tag: 'span', name: 'Badge' });
    expect(made('figure')).toMatchObject({ kind: 'element', tag: 'figure', name: 'Figure' });
  });

  it('puts a figure on a bare page as one change that one undo takes back whole', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-primitives-'));
    dirs.push(dir);
    const start = createStarterState('blank', 'Test Studio', false);
    const session = await ProjectSession.create(dir, start);
    const owner: OwnerRef = { kind: 'page', id: start.site.homePageId };
    const before = structuredClone(session.state.pages[owner.id]);
    const figure = BASICS.find((b) => b.id === 'figure')!;
    const ops = insertOps({ owner, parentId: null, index: 0 }, basicSpec(figure), 'element', 'n_figure01');
    const r = await session.apply({ operations: ops }, { label: 'Insert Figure', source: 'user' });
    expect(r.ok).toBe(true);
    // The figure is what Insert selects, not its image or caption.
    expect(insertSelection(ops, 'n_figure01')).toBe('n_figure01');
    const page = session.state.pages[owner.id];
    const placed = page.nodes.n_figure01 as ElementNode;
    expect(placed.tag).toBe('figure');
    const made = Object.keys(page.nodes).filter((k) => !Object.hasOwn(before.nodes, k));
    // A Section made for it, the figure, its image and its caption.
    expect(made).toHaveLength(4);
    const after = structuredClone(page);
    await session.undo();
    expect(session.state.pages[owner.id]).toEqual(before);
    await session.redo();
    expect(session.state.pages[owner.id]).toEqual(after);
    await session.close();
  });
});

describe('the exported site', () => {
  /** Home with a captioned photo, a badge, a plain line and every decorative shape. */
  function site() {
    const { s: start, owner } = blank();
    let s = start;
    s.assets.assets.as_dawn = { id: 'as_dawn', name: 'Dawn', file: 'static/media/dawn.jpg', mime: 'image/jpeg', bytes: 1, width: 800, height: 600, hash: 'd', kind: 'image', createdAt: '' } as never;
    const add = (op: Partial<Extract<EditOperation, { type: 'node.insert' }>>) => {
      const r = insert(s, owner, op);
      s = r.s;
      return r.id;
    };
    const badge = add({ primitive: 'badge', text: 'Now booking', icon: 'calendar' });
    const figure = add({ primitive: 'figure', text: 'The workshop at dawn.' });
    const image = (nodes(s)[figure] as ElementNode).children[0];
    s = applyOperations(s, [{ type: 'node.setContent', owner, nodeId: image, field: 'image', value: { assetId: 'as_dawn', alt: 'A potter’s wheel by the window' } }]).state;
    add({ primitive: 'divider' });
    const angle = add({ primitive: 'divider', shape: 'angle' });
    const wave = add({ primitive: 'divider', shape: 'wave' });
    const ornament = add({ primitive: 'divider', shape: 'icon', icon: 'leaf' });
    // The wave in the author's own color; the others in the brand color the band styles give them.
    s = applyOperations(s, [{ type: 'node.setStyle', owner, nodeId: wave, scope: 'base', property: 'color', value: { token: 'color.accent' } }]).state;
    return { s, badge, figure, angle, wave, ornament, image: nodes(s)[image] as ImageNode };
  }

  it('renders the figure, badge and bands as accessible static HTML', async () => {
    const { s } = site();
    expect(errors(s)).toEqual([]);
    const files = generateProject(s);
    const html = (await serverHtml(files, 'basic-primitives-')).replace(/<!--[\s\S]*?-->/g, '');
    // A figure: the photo with its alt text, then its caption, directly inside it.
    expect(html).toMatch(/<figure\b[^>]*>\s*<img\b[^>]*alt="A potter’s wheel by the window"[^>]*>\s*<figcaption\b[^>]*>The workshop at dawn\.<\/figcaption>\s*<\/figure>/);
    // A badge: a hidden icon, then its label, read as text.
    expect(html).toMatch(/<span\b[^>]*>\s*<svg\b[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg>\s*<span\b[^>]*>Now booking<\/span>\s*<\/span>/);
    // One real separator, and three bands hidden from screen readers.
    expect(html.match(/<hr\b/g)).toHaveLength(1);
    const bands = [...html.matchAll(/<svg class="[^"]*so-band[^"]*"[^>]*>[\s\S]*?<\/svg>/g)].map((m) => m[0]);
    expect(bands).toHaveLength(2);
    for (const band of bands) {
      expect(band).toContain('aria-hidden="true"');
      expect(band).toContain('focusable="false"');
      expect(band).toContain('viewBox="0 0 100 24" preserveAspectRatio="none"');
    }
    // Each band draws its own shape, in the order the page has them.
    expect(bands[0]).toMatch(/class="[^"]*so-band--angle[^"]*"[\s\S]*<path d="M0 24 L100 0 V24 Z" fill="currentColor"/);
    expect(bands[1]).toMatch(/class="[^"]*so-band--wave[^"]*"[\s\S]*<path d="M0 12 Q25 0 50 12 T100 12 V24 H0 Z" fill="currentColor"/);
    const ornament = html.match(/<div class="[^"]*so-band-icon[^"]*"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(ornament).toContain('aria-hidden="true"');
    expect(ornament.match(/so-band-icon__rule/g)).toHaveLength(2);
    expect(ornament).toMatch(/<svg\b[^>]*class="[^"]*so-icon/);
    // The leaf it names, not the stand-in icon.
    expect(ornament).toContain('d="M11 20a10 10 0 0010-10');
    // Nothing loads or runs: no file, link, script or handler of their own.
    for (const markup of [...bands, ornament]) expect(markup).not.toMatch(/<script|<use\b|href=|url\(|\son[a-z]+=/i);
    expect(html).not.toContain('data-so-');
  });

  it('colors the bands from the site’s tokens and lays them out only when a page uses one', () => {
    const { s, wave } = site();
    const files = generateProject(s);
    const css = files.get(`${STYLES_DIR}/components.css`)!;
    // The brand color until the design gives one, at no specificity, so a node's own color wins.
    expect(css).toContain(':where(.so-band) { display: block; width: 100%; height: 3rem; color: var(--so-color-brand, currentColor); }');
    expect(css).toContain(':where(.so-band-icon) { display: flex; align-items: center; gap: 0.75rem; width: 100%; color: var(--so-color-brand, currentColor); }');
    // The hairlines outweigh a theme's reset of plain spans.
    expect(css).toContain('.so-band-icon > .so-band-icon__rule { display: block; flex: 1 1 0; min-width: 0; height: 0; border: 0; border-top: 1px solid currentColor; opacity: 0.35; }');
    // The wave's own color is its token's custom property, on the class its svg carries.
    expect(files.get(pageFile(s.pages[s.site.homePageId]))).toContain(`<svg class={["so-n-${wave}", "so-band", "so-band--wave"]}`);
    expect(files.get(`${STYLES_DIR}/site.css`)).toContain(`.so-n-${wave} {\n\tcolor: var(--so-color-accent);`);
    // The page's source names the shapes' drawings itself; no asset file holds one.
    const page = files.get(pageFile(s.pages[s.site.homePageId]))!;
    expect(page).toContain('viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"');
    expect([...files.keys()].some((k) => /band|divider/i.test(k))).toBe(false);
    // A site with only plain lines carries none of it.
    const { s: plain, owner } = blank();
    const lined = insert(plain, owner, { primitive: 'divider' }).s;
    expect(generateProject(lined).get(`${STYLES_DIR}/components.css`)).not.toContain('so-band');
  });

  it('shows a plain line, or the default icon, for a shape or icon the generator has no drawing for', () => {
    const { s, angle, ornament } = site();
    const before = generateProject(s).get(pageFile(s.pages[s.site.homePageId]))!;
    expect(before).toContain('<SoIcon name={"leaf"} />');
    expect(before.match(/<hr\b/g)).toHaveLength(1);
    const next = structuredClone(s);
    (nodes(next)[angle] as { shape: string }).shape = 'zigzag';
    (nodes(next)[ornament] as DividerNode).icon = 'not-an-icon';
    const page = generateProject(next).get(pageFile(next.pages[next.site.homePageId]))!;
    expect(page.match(/<hr\b/g)).toHaveLength(2);
    expect(page).not.toContain('so-band--angle');
    expect(page).toContain('<SoIcon name={"sparkles"} />');
    expect(page).not.toContain('<SoIcon name={"leaf"} />');
  });

  it('bundles the icon a collection layout’s divider or badge names', () => {
    const { s } = blank();
    const next = structuredClone(s) as ProjectState & { collections: Record<string, unknown> };
    next.collections = { posts: { settings: { template: { rootIds: ['edge'], nodes: { edge: { id: 'edge', kind: 'divider', shape: 'icon', icon: 'trees' } } } } } };
    expect(usedIcons(s)).not.toContain('trees');
    expect(usedIcons(next)).toContain('trees');
  });

  it('is a format of its own: an older editor opens a project that may have bands read-only', () => {
    const step = MIGRATIONS.find((m) => m.id === 'divider-shapes')!;
    expect(MIGRATIONS.indexOf(step)).toBe(MIGRATIONS.findIndex((m) => m.id === 'project-brief') + 1);
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length + 1);
    // Nothing in the documents changes.
    const { s } = site();
    const before = structuredClone(s);
    step.migrate(s as never, () => true);
    expect(s).toEqual(before);
  });
});
