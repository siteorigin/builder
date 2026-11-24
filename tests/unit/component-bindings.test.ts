/**
 * Richer component bindings (#90): compared conditions, bound tags, variants and accessible names, icons on
 * buttons, and whole cards as links. Each is checked in the generated site as visitors get it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { ComponentDefinition, GraphNode, InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { blocksSaving, validateState } from '@engine/validate';
import { generateProject } from '@generator/index';
import { usedIcons } from '@generator/runtime-files';
import { P, eq, item, ne, prop, type ComponentSpec } from '@catalogue/dsl';
import { FOUNDATION } from '@catalogue/foundation/pack';
import { nodeClass } from '@generator/index';
import { isCardLink } from '@generator/card-links';
import { validateOperation } from '@shared/ops';
import { axesOf } from '@shared/variants';

const { managed } = FOUNDATION;
const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (def: ComponentDefinition) => ({ kind: 'component' as const, id: def.id });
const errors = (s: ProjectState) => validateState(s).filter(blocksSaving);

/** A project component built with the catalogue helpers, installed into the project. */
function addDef(s: ProjectState, spec: Omit<ComponentSpec, 'category' | 'tags' | 'icon' | 'description'>): ComponentDefinition {
  const def = { ...managed({ category: 'content', tags: [], icon: 'sparkles', description: '', ...spec }), owner: 'project' as const };
  s.components[def.id] = def;
  return def;
}

/** Place a component at the end of Home. */
function place(s: ProjectState, def: ComponentDefinition, props: Record<string, unknown> = {}): InstanceNode {
  const node = makeInstance(def, props);
  home(s).nodes[node.id] = node;
  home(s).rootIds.push(node.id);
  return node;
}

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

function compileErrors(s: ProjectState): string[] {
  const out: string[] = [];
  for (const instrument of [false, true]) {
    for (const [path, source] of generateProject(s, { instrument })) {
      if (!path.endsWith('.svelte')) continue;
      for (const generate of ['server', 'client'] as const) {
        try {
          compile(source, { filename: path, generate, runes: true });
        } catch (e) {
          out.push(`${path} (${generate}${instrument ? ', editor' : ''}): ${(e as Error).message}`);
        }
      }
    }
  }
  return out;
}

/** Server-render the exported Home page, with the site published under /studio. */
async function renderHome(s: ProjectState): Promise<string> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'bindings-'));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => "/studio" + p; export const asset = (p) => "/studio/" + p; export const base = "/studio";\n');
  // Navigation callbacks never run while rendering on the server.
  const navigation = join(dir, 'app-navigation.js');
  writeFileSync(navigation, 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};\n');
  for (const [path, source] of generateProject(s)) {
    if (!path.startsWith('src/') || !/\.(svelte|js)$/.test(path)) continue;
    const out = join(dir, path.endsWith('.svelte') ? `${path}.js` : path);
    mkdirSync(dirname(out), { recursive: true });
    const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true }).js.code : source;
    writeFileSync(
      out,
      code
        .replace(/(["'])([^"'\n]+?\.svelte)\1/g, '$1$2.js$1')
        .replace(/(["'])\$app\/paths\1/g, JSON.stringify(paths))
        .replace(/(["'])\$app\/navigation\1/g, JSON.stringify(navigation))
    );
  }
  const Page = (await import(/* @vite-ignore */ join(dir, 'src/routes/+page.svelte.js'))).default as Component<Record<string, unknown>>;
  return render(Page, { props: {} }).body.replace(/<!--[\s\S]*?-->/g, '');
}

/** The markup of the section a component renders, by the class of its root. */

/** The markup of each placement of a component on the page, in order, from its root element to the next placement. */
function placements(html: string, def: ComponentDefinition): string[] {
  const cls = nodeClass(def, def.tree!.rootIds[0]);
  const starts: number[] = [];
  for (let i = html.indexOf(cls); i >= 0; i = html.indexOf(cls, i + cls.length)) starts.push(html.lastIndexOf('<', i));
  return starts.map((start, k) => html.slice(start, starts[k + 1] ?? html.length));
}

/** The opening tag of the element carrying `cls` in its class list. */
const openTag = (html: string, cls: string) => new RegExp(`<[a-z0-9]+\\b[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`).exec(html)?.[0] ?? '';

// ---------------------------------------------------------------------------
// Conditions that compare
// ---------------------------------------------------------------------------

function plansDef(s: ProjectState) {
  return addDef(s, {
    componentId: 'test.plans',
    name: 'Plans',
    properties: {
      media: P.choice('Media', 'image', [['image', 'Image'], ['video', 'Video']]),
      plans: P.list('Plans', 'Plan', { name: P.str('Name', 'Plan'), featured: P.bool('Featured', false), seats: P.num('Seats', 1) }, [
        { name: 'Basic', featured: false, seats: 1 },
        { name: 'Pro', featured: true, seats: 5 }
      ])
    },
    parts: {},
    build: (b) =>
      b.el('root', 'section', {}, [
        b.text('video-note', 'p', 'Plays a video', { when: eq(prop('media'), 'video') }),
        b.text('still-note', 'p', 'Shows a still', { unless: eq(prop('media'), 'video') }),
        b.repeat('cards', 'plans', [
          b.el('card', 'article', {}, [
            b.text('card-name', 'h3', item('name')),
            b.text('badge', 'span', 'Most popular', { when: eq(item('featured'), true) }),
            b.text('standard', 'span', 'Standard plan', { when: eq(item('featured'), false) }),
            b.text('team', 'span', 'For teams', { when: ne(item('seats'), 1) }),
            b.text('solo', 'span', 'Just you', { unless: ne(item('seats'), 1) })
          ])
        ])
      ])
  });
}

describe('conditions that compare a value (#90)', () => {
  it('shows a badge only on the featured item, and a part only for the chosen choice', async () => {
    const s = fresh();
    const def = plansDef(s);
    place(s, def, { media: 'video' });
    place(s, def, { media: 'image' });
    expect(errors(s)).toEqual([]);
    expect(compileErrors(s)).toEqual([]);
    const [video, image] = placements(await renderHome(s), def);
    const cards = video.split('<article').slice(1);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain('Basic');
    expect(cards[0]).not.toContain('Most popular');
    expect(cards[0]).toContain('Standard plan');
    expect(cards[0]).not.toContain('For teams');
    expect(cards[0]).toContain('Just you');
    expect(cards[1]).toContain('Pro');
    expect(cards[1]).toContain('Most popular');
    expect(cards[1]).not.toContain('Standard plan');
    expect(cards[1]).toContain('For teams');
    expect(cards[1]).not.toContain('Just you');
    expect(video).toContain('Plays a video');
    expect(video).not.toContain('Shows a still');
    expect(image).toContain('Shows a still');
    expect(image).not.toContain('Plays a video');
  });

  it('decides the editor’s checks the way the site renders: a link behind a comparison counts only when shown', () => {
    const s = fresh();
    const def = plansDef(s);
    def.tree!.nodes['video-note'] = { id: 'video-note', kind: 'link', link: { type: 'anchor', target: 'nowhere' }, label: 'Watch', appearance: 'link', when: eq(prop('media'), 'video') };
    const inst = place(s, def, { media: 'image' });
    expect(validateState(s).filter((d) => d.code === 'LINK_SECTION_MISSING')).toEqual([]);
    inst.props.media = 'video';
    expect(validateState(s).filter((d) => d.code === 'LINK_SECTION_MISSING')).toHaveLength(1);
  });

  it('is validated on load: the compared value must be one the property can hold', () => {
    const s = fresh();
    const def = plansDef(s);
    const badge = def.tree!.nodes.badge;
    badge.when = { ref: { $item: 'featured' }, eq: 'true' };
    expect(errors(s).map((d) => d.code)).toEqual(['BINDING_INVALID']);
    badge.when = { ref: { $item: 'featured' }, eq: true };
    def.tree!.nodes.team.when = { ref: { $item: 'seats' }, ne: '1' };
    expect(errors(s).map((d) => [d.code, d.nodeId])).toEqual([['BINDING_INVALID', 'team']]);
    def.tree!.nodes.team.when = { ref: { $item: 'seats' }, ne: 1 };
    def.tree!.nodes['video-note'].when = { ref: { $prop: 'media' }, eq: 'audio' };
    expect(errors(s)[0]?.message).toMatch(/"audio", which is not one of its options \("image", "video"\)/);
    // A comparison written without `ref` would otherwise read as a plain presence test.
    def.tree!.nodes['video-note'].when = { $prop: 'media', eq: 'video' } as never;
    expect(errors(s).map((d) => d.code)).toEqual(['BINDING_INVALID']);
    def.tree!.nodes['video-note'].when = { ref: { $prop: 'media' }, eq: 'video', ne: 'image' } as never;
    expect(errors(s).map((d) => d.code)).toEqual(['BINDING_INVALID']);
    def.tree!.nodes['video-note'].when = { ref: { $prop: 'plans' }, eq: 'x' };
    expect(errors(s)[0]?.message).toMatch(/a list can only be tested for being set/);
  });

  it('binds a compared condition through node.setBinding, and keeps the property it reads in use', () => {
    const s = fresh();
    const def = plansDef(s);
    delete def.tree!.nodes['video-note'].when;
    delete def.tree!.nodes.team.when;
    const set = applyOperations(s, [
      { type: 'node.setBinding', owner: owner(def), nodeId: 'video-note', field: 'when', binding: { $prop: 'media' }, eq: 'video' },
      { type: 'node.setBinding', owner: owner(def), nodeId: 'team', field: 'unless', binding: { $item: 'seats' }, ne: 1 }
    ]).state;
    expect(set.components[def.id].tree!.nodes['video-note'].when).toEqual({ ref: { $prop: 'media' }, eq: 'video' });
    expect(set.components[def.id].tree!.nodes.team.unless).toEqual({ ref: { $item: 'seats' }, ne: 1 });
    expect(() => applyOperations(s, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'video-note', field: 'when', binding: { $prop: 'media' }, eq: 'audio' }])).toThrow(/not one of its options/);
    expect(() => applyOperations(s, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'video-note', field: 'text', binding: { $prop: 'media' }, eq: 'video' }])).toThrow(/Only a "when" or "unless"/);
    // Unbinding removes the whole condition.
    const cleared = applyOperations(set, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'video-note', field: 'when', binding: null }]).state;
    expect(cleared.components[def.id].tree!.nodes['video-note'].when).toBeUndefined();
    // `still-note` reads media only through its comparison.
    delete set.components[def.id].tree!.nodes['video-note'].when;
    expect(() => applyOperations(set, [{ type: 'component.removePropSchema', definitionId: def.id, prop: 'media' }])).toThrow(/"media" is still shown by/);
    // A choice that drops the compared option is refused rather than left comparing with nothing.
    expect(() =>
      applyOperations(set, [{ type: 'component.setPropSchema', definitionId: def.id, prop: 'media', schema: { type: 'enum', label: 'Media', options: ['image', 'audio'] } }])
    ).toThrow(/not one of its options/);
  });

  it('keeps the comparison when part of a list item becomes a component of its own', () => {
    const s = fresh();
    const def = plansDef(s);
    const r = applyOperations(s, [{ type: 'component.createFromNode', owner: owner(def), nodeId: 'badge', name: 'Badge' }]);
    const badge = r.state.components[r.results[0].definitionId as string];
    const root = badge.tree!.nodes[badge.tree!.rootIds[0]];
    expect(root.when).toEqual({ ref: { $prop: 'featured' }, eq: true });
    const inst = r.state.components[def.id].tree!.nodes[r.results[0].nodeId as string] as InstanceNode;
    expect(inst.props.featured).toEqual({ $item: 'featured' });
    expect(errors(r.state)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rules made in the Inspector (#368)
// ---------------------------------------------------------------------------

/** A design whose wrapper holds two parts and a sibling after it, with no rules yet: they are added through operations. */
function wrapperDef(s: ProjectState) {
  return addDef(s, {
    componentId: 'test.wrapper',
    name: 'Wrapper',
    properties: { badge: P.str('Badge', 'New'), tone: P.choice('Tone', 'calm', [['calm', 'Calm'], ['loud', 'Loud']]), hidden: P.bool('Hidden', false), extra: P.str('Extra', '') },
    parts: {},
    build: (b) =>
      b.el('root', 'section', {}, [b.el('wrap', 'div', { name: 'Badge row' }, [b.text('badge', 'span', prop('badge')), b.text('extra', 'small', prop('extra'))]), b.text('after', 'p', 'Always here')])
  });
}

describe('rules made in the Inspector (#368)', () => {
  it('sets and clears "hide when empty" on a container of a component’s design, and nowhere else', () => {
    const s = fresh();
    const def = wrapperDef(s);
    const op = (nodeId: string, value: unknown) => ({ type: 'node.setContent' as const, owner: owner(def), nodeId, field: 'collapseEmpty' as const, value });
    expect(validateOperation(op('wrap', true)).ok).toBe(true);
    const on = applyOperations(s, [op('wrap', true)]).state;
    expect(on.components[def.id].tree!.nodes.wrap).toMatchObject({ collapseEmpty: true });
    expect(s.components[def.id].tree!.nodes.wrap).not.toHaveProperty('collapseEmpty');
    const off = applyOperations(on, [op('wrap', false)]).state;
    expect(off.components[def.id].tree!.nodes.wrap).not.toHaveProperty('collapseEmpty');
    expect(() => applyOperations(s, [op('badge', true)])).toThrow(/Only containers/);
    expect(() => applyOperations(s, [op('wrap', 'false')])).toThrow(/true or false/);
    expect(() => applyOperations(s, [op('wrap', null)])).toThrow(/true or false/);
    // A page's own container has no design to judge its items by.
    const page = home(s);
    page.nodes['plain-box'] = { id: 'plain-box', kind: 'element', tag: 'div', children: [] } as GraphNode;
    page.rootIds.push('plain-box');
    expect(() => applyOperations(s, [{ type: 'node.setContent', owner: { kind: 'page', id: page.id }, nodeId: 'plain-box', field: 'collapseEmpty', value: true }])).toThrow(/Only containers in a component/);
  });

  it('renders what the rules say as a placement’s values change, and leaves out a container only when all inside are hidden', async () => {
    const s = fresh();
    const def = wrapperDef(s);
    const set = applyOperations(s, [
      { type: 'node.setBinding', owner: owner(def), nodeId: 'badge', field: 'when', binding: { $prop: 'tone' }, eq: 'loud' },
      { type: 'node.setBinding', owner: owner(def), nodeId: 'badge', field: 'unless', binding: { $prop: 'hidden' } },
      { type: 'node.setBinding', owner: owner(def), nodeId: 'extra', field: 'when', binding: { $prop: 'extra' } },
      { type: 'node.setContent', owner: owner(def), nodeId: 'wrap', field: 'collapseEmpty', value: true }
    ]).state;
    const d = set.components[def.id];
    const inst = place(set, d, { tone: 'loud' });
    const pageOwner = { kind: 'page' as const, id: home(set).id };
    expect(errors(set)).toEqual([]);
    expect(compileErrors(set)).toEqual([]);
    const wrapCls = nodeClass(d, 'wrap');
    /** The placement's markup with these values: whether the wrapper, the badge and the extra note are there. */
    const shows = async (state: ProjectState, props: Record<string, unknown>) => {
      const next = applyOperations(state, Object.entries(props).map(([prop, value]) => ({ type: 'instance.setProp' as const, owner: pageOwner, nodeId: inst.id, prop, value }))).state;
      const html = placements(await renderHome(next), next.components[def.id])[0];
      expect(html).toContain('Always here');
      return { wrap: openTag(html, wrapCls) !== '', badge: html.includes('>New<'), extra: html.includes('>Also<') };
    };
    expect(await shows(set, {})).toEqual({ wrap: true, badge: true, extra: false });
    expect(await shows(set, { extra: 'Also' })).toEqual({ wrap: true, badge: true, extra: true });
    // Only the second part shown: the container stays for it.
    expect(await shows(set, { tone: 'calm', extra: 'Also' })).toEqual({ wrap: true, badge: false, extra: true });
    // Neither: the container goes with them.
    expect(await shows(set, { tone: 'calm' })).toEqual({ wrap: false, badge: false, extra: false });
    // Loud but hidden: the hide rule wins over the show rule, and nothing is left to show.
    expect(await shows(set, { hidden: true })).toEqual({ wrap: false, badge: false, extra: false });
    // Without "hide when empty", the emptied container stays.
    const kept = applyOperations(set, [{ type: 'node.setContent', owner: owner(def), nodeId: 'wrap', field: 'collapseEmpty', value: false }]).state;
    expect(await shows(kept, { tone: 'calm' })).toEqual({ wrap: true, badge: false, extra: false });
  });
});

// ---------------------------------------------------------------------------
// Bound tags, variants and accessible names
// ---------------------------------------------------------------------------

function heroDef(s: ProjectState, opts: { levelDefault?: string; toneDefault?: number } = {}) {
  const grid = s.components[installComponent(s, 'features.grid')];
  const toneAxis = axesOf(grid).find(([a]) => a === 'tone')![1];
  const tones = Object.keys(toneAxis.options);
  return {
    grid,
    tones,
    def: addDef(s, {
      componentId: 'test.hero',
      name: 'Hero',
      properties: {
        heading: P.str('Heading', 'Welcome'),
        level: P.choice('Heading level', opts.levelDefault ?? 'h2', [['h1', 'Heading 1'], ['h2', 'Heading 2']]),
        wrapper: P.choice('Wrapper', 'section', [['section', 'Section'], ['article', 'Article']]),
        tone: P.choice('Tone', tones[opts.toneDefault ?? 0], tones.slice(0, 2).map((t) => [t, t] as [string, string])),
        navName: P.str('Navigation name', ''),
        iconName: P.str('Icon name', 'Highlights')
      },
      parts: {},
      build: (b) => {
        const nested = makeInstance(grid, {});
        nested.id = 'grid';
        nested.variants = { tone: prop('tone') as never };
        b.nodes.grid = nested;
        return b.el('root', prop('wrapper'), {}, [
          b.text('title', prop('level'), prop('heading')),
          b.el('nav', 'nav', { ariaLabel: prop('navName') }, [b.text('nav-heading', 'h2', 'Explore'), b.text('nav-text', 'p', 'Links')]),
          b.icon('star', 'star', { ariaLabel: prop('iconName') }),
          'grid'
        ]);
      }
    })
  };
}

describe('properties that choose a tag, a variant and an accessible name (#90)', () => {
  it('switches a heading between h1 and h2, the wrapper tag and a nested tone', async () => {
    const s = fresh();
    const { def, grid, tones } = heroDef(s);
    place(s, def, { level: 'h1', wrapper: 'article', tone: tones[1], heading: 'Big welcome' });
    place(s, def, { heading: 'Quiet welcome' });
    expect(errors(s)).toEqual([]);
    expect(compileErrors(s)).toEqual([]);
    const [big, quiet] = placements(await renderHome(s), def);
    const root = nodeClass(def, 'root');
    const gridRoot = nodeClass(grid, grid.tree!.rootIds[0]);
    const toneClass = (t: string) => `so-${grid.id.replace(/[^a-zA-Z0-9]/g, '-')}--tone-${t}`;
    expect(big).toMatch(new RegExp(`^<article\\b[^>]*\\b${root}\\b`));
    expect(big).toMatch(/<h1\b[^>]*>Big welcome<\/h1>/);
    expect(openTag(big, gridRoot)).toContain(toneClass(tones[1]));
    expect(openTag(big, gridRoot)).not.toContain(toneClass(tones[0]));
    expect(quiet).toMatch(new RegExp(`^<section\\b[^>]*\\b${root}\\b`));
    expect(quiet).toMatch(/<h2\b[^>]*>Quiet welcome<\/h2>/);
    expect(openTag(quiet, gridRoot)).toContain(toneClass(tones[0]));
    expect(openTag(quiet, gridRoot)).not.toContain(toneClass(tones[1]));
  });

  it('names a navigation landmark and an icon from properties, falling back to the heading when blank', async () => {
    const s = fresh();
    const { def } = heroDef(s);
    place(s, def, { navName: 'Resources' });
    place(s, def, { navName: '   ', iconName: '   ' });
    const [named, blank] = placements(await renderHome(s), def);
    const nav = (html: string) => openTag(html, nodeClass(def, 'nav'));
    const star = (html: string) => openTag(html, nodeClass(def, 'star'));
    expect(nav(named)).toContain('aria-label="Resources"');
    expect(nav(named)).not.toContain('aria-labelledby');
    // Cleared, the landmark keeps the name its visible heading gives it.
    expect(nav(blank)).not.toContain('aria-label=');
    const by = /aria-labelledby="([^"]+)"/.exec(nav(blank))?.[1];
    expect(by).toBeTruthy();
    expect(blank).toMatch(new RegExp(`<h2\\b[^>]*id="${by}"[^>]*>Explore</h2>`));
    expect(star(named)).toContain('aria-label="Highlights"');
    expect(star(named)).toContain('role="img"');
    expect(star(named)).not.toContain('aria-hidden');
    expect(star(blank)).toContain('aria-hidden="true"');
    expect(star(blank)).not.toContain('role=');
  });

  it('keeps labelling a landmark by a heading whose level a property chooses', () => {
    const s = fresh();
    const { def } = heroDef(s);
    def.properties.navLevel = P.choice('Navigation heading', 'h2', [['h2', 'Heading 2'], ['h3', 'Heading 3']]);
    (def.tree!.nodes['nav-heading'] as { tag: unknown }).tag = prop('navLevel');
    delete (def.tree!.nodes.nav as { ariaLabel?: unknown }).ariaLabel;
    const source = generateProject(s).get(`src/lib/siteorigin/generated/${def.id.replace(/\./g, '-')}.svelte`) ?? [...generateProject(s).entries()].find(([p, src]) => p.includes('generated') && src.includes(nodeClass(def, 'nav')))![1];
    expect(source).toMatch(/<nav\b[^>]*aria-labelledby=/);
    expect(source.match(/id=\{`\$\{uid\}-nav-heading`\}/g)).toHaveLength(2);
  });

  it('counts a property bound only as a tag, variant or accessible name as used', () => {
    const s = fresh();
    const { def } = heroDef(s);
    for (const p of ['level', 'wrapper', 'tone', 'navName', 'iconName'])
      expect(() => applyOperations(s, [{ type: 'component.removePropSchema', definitionId: def.id, prop: p }]), p).toThrow(/is still shown by/);
  });

  it('refuses choices whose options are not tags or variants the node can take', () => {
    const s = fresh();
    const { def, grid, tones } = heroDef(s);
    expect(() =>
      applyOperations(s, [{ type: 'component.setPropSchema', definitionId: def.id, prop: 'level', schema: { type: 'enum', label: 'Level', options: ['h1', 'video'] } }])
    ).toThrow(/"video" are not text tags/);
    expect(() =>
      applyOperations(s, [{ type: 'component.setPropSchema', definitionId: def.id, prop: 'wrapper', schema: { type: 'enum', label: 'Wrapper', options: ['section', 'h1'] } }])
    ).toThrow(/"h1" are not element tags/);
    expect(() =>
      applyOperations(s, [{ type: 'component.setPropSchema', definitionId: def.id, prop: 'tone', schema: { type: 'enum', label: 'Tone', options: ['plaid'] } }])
    ).toThrow(/"plaid" are not options of/);
    // Bound through node.setBinding too, and caught on load in a hand-edited document.
    expect(() => applyOperations(s, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'title', field: 'tag', binding: { $prop: 'heading' } }])).toThrow(/needs a enum property/);
    // A nested option a choice still offers cannot be removed from the nested component.
    const forked = { ...structuredClone(grid), owner: 'project' as const };
    s.components[grid.id] = forked;
    expect(() => applyOperations(s, [{ type: 'component.removeVariant', definitionId: grid.id, axis: 'tone', variant: tones[1] }])).toThrow(/can choose the tone/);
    def.properties.level = P.choice('Heading level', 'h2', [['h2', 'Heading 2'], ['marquee', 'Marquee']]);
    expect(errors(s).map((d) => d.message)).toEqual([expect.stringMatching(/"marquee" are not text tags/)]);
  });

  it('unbinding a tag keeps the choice’s default, and unbinding a variant keeps its option', () => {
    const s = fresh();
    const { def, tones } = heroDef(s, { levelDefault: 'h1', toneDefault: 1 });
    const r = applyOperations(s, [
      { type: 'node.setBinding', owner: owner(def), nodeId: 'title', field: 'tag', binding: null },
      { type: 'node.setBinding', owner: owner(def), nodeId: 'grid', field: 'variant', axis: 'tone', binding: null }
    ]).state;
    const tree = r.components[def.id].tree!;
    expect(tree.nodes.title).toMatchObject({ tag: 'h1' });
    expect((tree.nodes.grid as InstanceNode).variants).toEqual({ tone: tones[1] });
    const back = applyOperations(r, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'grid', field: 'variant', axis: 'tone', binding: { $prop: 'tone' } }]).state;
    expect((back.components[def.id].tree!.nodes.grid as InstanceNode).variants).toEqual({ tone: { $prop: 'tone' } });
    expect(() => applyOperations(r, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'grid', field: 'variant', axis: 'size', binding: { $prop: 'tone' } }])).toThrow(/no variant axis "size"/);
    // A bound tag's value is the choice's default, set to any of its options.
    const level = applyOperations(s, [{ type: 'node.setContent', owner: owner(def), nodeId: 'title', field: 'tag', value: 'h2' }]).state;
    expect(level.components[def.id].properties.level.default).toBe('h2');
  });

  it('gives each bound container its own snippet, whatever its id', () => {
    const s = fresh();
    const def = addDef(s, {
      componentId: 'test.twins',
      name: 'Twins',
      properties: { wrap: P.choice('Wrap', 'div', [['div', 'Div'], ['section', 'Section']]) },
      parts: {},
      build: (b) => b.el('root', 'div', {}, [b.el('card-title', prop('wrap'), {}, [b.text('a', 'p', 'A')]), b.el('_card_title', prop('wrap'), {}, [b.text('b', 'p', 'B')])])
    });
    place(s, def, { wrap: 'section' });
    expect(compileErrors(s)).toEqual([]);
    // A hand-edited property named like a generated snippet keeps a local of its own.
    def.properties.so_children_1 = P.str('Odd', 'x');
    expect(compileErrors(s)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Icons on buttons and links
// ---------------------------------------------------------------------------

describe('icons on buttons and links (#90)', () => {
  function ctaDef(s: ProjectState) {
    return addDef(s, {
      componentId: 'test.cta',
      name: 'Call to action',
      properties: {
        action: P.link('Action', { type: 'url', target: 'https://example.com' }),
        icon: P.icon('Icon', 'arrow-right'),
        side: P.choice('Icon side', 'end', [['start', 'Before'], ['end', 'After']])
      },
      parts: {},
      build: (b) =>
        b.el('root', 'div', {}, [
          b.link('lead', prop('action'), 'Call us', 'primary', { icon: 'rocket' }),
          b.link('trail', prop('action'), 'Read more', 'link', { icon: prop('icon'), iconPosition: 'end' }),
          b.link('chosen', prop('action'), 'Get started', 'secondary', { icon: prop('icon'), iconPosition: prop('side') })
        ])
    });
  }
  const anchor = (html: string, def: ComponentDefinition, id: string) => new RegExp(`<a\\b[^>]*\\b${nodeClass(def, id)}\\b[^>]*>[\\s\\S]*?</a>`).exec(html)?.[0] ?? '';
  const ROCKET = 'M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5';

  it('shows the icon on the chosen side of the label, and compiles', async () => {
    const s = fresh();
    expect(usedIcons(s)).not.toContain('rocket');
    const def = ctaDef(s);
    place(s, def);
    place(s, def, { side: 'start' });
    place(s, def, { side: 'start', icon: '' });
    expect(errors(s)).toEqual([]);
    expect(compileErrors(s)).toEqual([]);
    const [after, before, none] = placements(await renderHome(s), def);
    expect(anchor(after, def, 'lead')).toMatch(/^<a[^>]*>\s*<svg[^>]*so-link__icon--start[^>]*aria-hidden="true"[\s\S]*<\/svg>\s*Call us\s*<\/a>$/);
    expect(anchor(after, def, 'lead')).toContain(ROCKET);
    expect(anchor(after, def, 'trail')).toMatch(/Read more\s*<svg[^>]*so-link__icon--end/);
    expect(anchor(after, def, 'chosen')).toMatch(/Get started\s*<svg[^>]*so-link__icon--end[\s\S]*<\/svg>\s*<\/a>$/);
    expect(anchor(before, def, 'chosen')).toMatch(/^<a[^>]*>\s*<svg[^>]*so-link__icon--start[\s\S]*<\/svg>\s*Get started\s*<\/a>$/);
    // A bound icon left empty shows the label alone.
    expect(anchor(none, def, 'chosen')).not.toContain('<svg');
    expect(usedIcons(s)).toEqual(expect.arrayContaining(['rocket', 'arrow-right']));
  });

  it('counts a property bound as a link icon or its side as used', () => {
    const s = fresh();
    const def = ctaDef(s);
    (def.tree!.nodes.trail as { icon?: unknown }).icon = 'mail';
    for (const p of ['icon', 'side']) expect(() => applyOperations(s, [{ type: 'component.removePropSchema', definitionId: def.id, prop: p }]), p).toThrow(/is still shown by/);
    expect(() =>
      applyOperations(s, [{ type: 'component.setPropSchema', definitionId: def.id, prop: 'side', schema: { type: 'enum', label: 'Side', options: ['start', 'middle'] } }])
    ).toThrow(/"middle" are not "start", "end"/);
  });

  it('sets a literal icon, side and accessible name on a button', async () => {
    const s = fresh();
    const def = ctaDef(s);
    const r = applyOperations(s, [
      { type: 'node.setContent', owner: owner(def), nodeId: 'lead', field: 'icon', value: 'mail' },
      { type: 'node.setContent', owner: owner(def), nodeId: 'lead', field: 'iconPosition', value: 'end' },
      { type: 'node.setContent', owner: owner(def), nodeId: 'lead', field: 'ariaLabel', value: 'Email the studio' }
    ]).state;
    expect(r.components[def.id].tree!.nodes.lead).toMatchObject({ icon: 'mail', iconPosition: 'end', ariaLabel: 'Email the studio' });
    place(r, r.components[def.id]);
    const lead = anchor((await renderHome(r)).slice(-20000), r.components[def.id], 'lead');
    expect(lead).toMatch(/^<a\b[^>]*aria-label="Email the studio"[^>]*>\s*Call us\s*<svg[^>]*so-link__icon--end/);
    expect(() => applyOperations(s, [{ type: 'node.setContent', owner: owner(def), nodeId: 'lead', field: 'iconPosition', value: 'middle' }])).toThrow(/start or end/);
    const cleared = applyOperations(r, [{ type: 'node.setContent', owner: owner(def), nodeId: 'lead', field: 'icon', value: '' }]).state;
    expect(cleared.components[def.id].tree!.nodes.lead).not.toHaveProperty('icon');
  });

  it('unbinding an icon its property left empty keeps the button without one', () => {
    const s = fresh();
    const def = ctaDef(s);
    def.properties.icon = P.str('Icon', '');
    const r = applyOperations(s, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'trail', field: 'icon', binding: null }]).state;
    expect(r.components[def.id].tree!.nodes.trail).not.toHaveProperty('icon');
  });
});

// ---------------------------------------------------------------------------
// Whole cards as links
// ---------------------------------------------------------------------------

describe('cards that link as a whole (#90)', () => {
  function cardsDef(s: ProjectState, inner?: (b: Parameters<ComponentSpec['build']>[0]) => string) {
    return addDef(s, {
      componentId: 'test.cards',
      name: 'Service cards',
      properties: {
        services: P.list('Services', 'Service', { title: P.str('Title', 'Service'), destination: P.link('Destination') }, [
          { title: 'Design', destination: { type: 'url', target: 'https://example.com/design' } },
          { title: 'Build', destination: { type: 'none', target: '' } }
        ]),
        featureLink: P.link('Feature link', { type: 'url', target: 'https://example.com/feature' })
      },
      parts: {},
      slots: { extra: { label: 'Extra' } },
      build: (b) =>
        b.el('root', 'section', {}, [
          b.repeat('list', 'services', [
            b.el('card', 'article', { link: item('destination') }, [b.text('card-title', 'h3', item('title')), ...(inner ? [inner(b)] : [])])
          ]),
          b.el('feature', 'div', { link: prop('featureLink') }, [b.text('feature-title', 'p', 'Featured'), b.slot('extra-slot', 'extra')])
        ])
    });
  }
  const count = (html: string, re: RegExp) => html.match(new RegExp(re.source, 'g'))?.length ?? 0;

  it('renders one link around each card with a destination, and the plain container without one', async () => {
    const s = fresh();
    const def = cardsDef(s);
    place(s, def);
    expect(errors(s)).toEqual([]);
    expect(compileErrors(s)).toEqual([]);
    const [html] = placements(await renderHome(s), def);
    const card = nodeClass(def, 'card');
    expect(count(html, /<a href="https:\/\/example\.com\/design"/)).toBe(1);
    expect(html).toMatch(new RegExp(`<a href="https://example\\.com/design" class="so-card-link ${card}">\\s*<h3[^>]*>Design</h3>\\s*</a>`));
    expect(count(html, new RegExp(`<article class="${card}">`))).toBe(1);
    expect(html).toMatch(new RegExp(`<article class="${card}">\\s*<h3[^>]*>Build</h3>\\s*</article>`));
    expect(html).toMatch(/<a href="https:\/\/example\.com\/feature" class="so-card-link/);
    expect(html).not.toMatch(/<a href="https:\/\/example\.com\/design"[^>]*target=/);
  });

  it('opens a card in a new tab when its destination says so', async () => {
    const s = fresh();
    const def = cardsDef(s);
    place(s, def, { featureLink: { type: 'url', target: 'https://example.com/feature', newTab: true } });
    const [html] = placements(await renderHome(s), def);
    expect(html).toMatch(/<a href="https:\/\/example\.com\/feature" class="so-card-link[^"]*" target="_blank" rel="noopener noreferrer">/);
  });

  it('refuses a card with a button inside it, and generates the card without its link', async () => {
    const s = fresh();
    const def = cardsDef(s, (b) => b.link('card-button', { type: 'url', target: 'https://example.com/more' }, 'More', 'primary'));
    place(s, def);
    const found = errors(s);
    expect(found.map((d) => d.code)).toEqual(['CARD_LINK_INTERACTIVE']);
    expect(found[0].message).toMatch(/Service cards: a button or link sits inside a card that links somewhere/);
    const [html] = placements(await renderHome(s), def);
    expect(html).not.toContain('https://example.com/design');
    expect(html).toMatch(new RegExp(`<article class="${nodeClass(def, 'card')}">\\s*<h3[^>]*>Design</h3>\\s*<a href="https://example\\.com/more"`));
    // The card that holds nothing interactive keeps its link.
    expect(html).toMatch(/<a href="https:\/\/example\.com\/feature" class="so-card-link/);
  });

  it('finds a link a repeat inside the card renders, and a disclosure a bound tag can choose', () => {
    const s = fresh();
    const def = cardsDef(s, (b) => b.el('more', 'div', {}, [b.text('more-text', 'p', 'Details')]));
    def.properties.notes = P.list('Notes', 'Note', { label: P.str('Label', 'Note') }, [{ label: 'One' }]);
    def.properties.box = P.choice('Box', 'div', [['div', 'Plain'], ['details', 'Disclosure']]);
    place(s, def);
    expect(errors(s)).toEqual([]);
    (def.tree!.nodes.more as { tag: unknown }).tag = prop('box');
    expect(errors(s).map((d) => d.message)).toEqual([expect.stringMatching(/can render as a details disclosure/)]);
    (def.tree!.nodes.more as { tag: unknown }).tag = 'div';
    def.tree!.nodes['more-notes'] = { id: 'more-notes', kind: 'repeat', list: { $prop: 'notes' }, children: ['note-link'] };
    def.tree!.nodes['note-link'] = { id: 'note-link', kind: 'link', link: { type: 'url', target: 'https://example.com/n' }, label: item('label'), appearance: 'link' };
    (def.tree!.nodes.more as { children: string[] }).children.push('more-notes');
    expect(errors(s).map((d) => d.code)).toEqual(['CARD_LINK_INTERACTIVE']);
  });

  it('refuses interactive content a placement puts into a slot inside a card, on that placement', async () => {
    const s = fresh();
    const def = cardsDef(s);
    const inst = place(s, def);
    const button = { id: 'n_slot_button', kind: 'link' as const, link: { type: 'url' as const, target: 'https://example.com/slot' }, label: 'Slot button', appearance: 'primary' };
    home(s).nodes[button.id] = button;
    inst.slots = { extra: [button.id] };
    const found = errors(s);
    expect(found).toEqual([expect.objectContaining({ code: 'CARD_LINK_INTERACTIVE', nodeId: inst.id, owner: { kind: 'page', id: s.site.homePageId } })]);
    const [html] = placements(await renderHome(s), def);
    expect(html).not.toContain('https://example.com/feature');
    expect(html).toContain('https://example.com/slot');
    expect(html).toContain('https://example.com/design');
    // Through a nested component too: a code component (a form, say) can place any control.
    const form = s.components[installComponent(s, 'contact.form')];
    const nested = makeInstance(form, {});
    home(s).nodes[nested.id] = nested;
    inst.slots = { extra: [nested.id] };
    expect(errors(s).map((d) => d.code)).toEqual(['CARD_LINK_INTERACTIVE']);
  });

  it('follows a slot another component passes into the card, and ignores one that is never shown', () => {
    const s = fresh();
    const cards = cardsDef(s);
    const outer = addDef(s, {
      componentId: 'test.outer',
      name: 'Outer',
      properties: {},
      parts: {},
      slots: { body: { label: 'Body' }, aside: { label: 'Aside' } },
      build: (b) => {
        const nested = makeInstance(cards, {});
        nested.id = 'cards';
        b.nodes.cards = nested;
        b.slot('pass-body', 'body');
        b.slot('pass-aside', 'aside');
        // `body` goes into the card's slot; Service cards has no `hidden` slot to show `aside` in.
        nested.slots = { extra: ['pass-body'], hidden: ['pass-aside'] };
        return b.el('outer-root', 'div', {}, ['cards']);
      }
    });
    const inst = place(s, outer);
    const link = (id: string) => ({ id, kind: 'link' as const, link: { type: 'url' as const, target: `https://example.com/${id}` }, label: id, appearance: 'primary' });
    home(s).nodes.n_aside = link('n_aside');
    inst.slots = { aside: ['n_aside'] };
    expect(errors(s).filter((d) => d.code === 'CARD_LINK_INTERACTIVE')).toEqual([]);
    home(s).nodes.n_body = link('n_body');
    inst.slots = { aside: ['n_aside'], body: ['n_body'] };
    expect(errors(s).filter((d) => d.code === 'CARD_LINK_INTERACTIVE')).toEqual([expect.objectContaining({ nodeId: inst.id })]);
    // A component placing such a slot inside a card cannot become code, which could not keep it checked.
    expect(() => applyOperations(s, [{ type: 'component.convertToCode', owner: { kind: 'page', id: s.site.homePageId }, nodeId: inst.id }])).toThrow(/inside a card that links somewhere/);
  });

  it('checks every placement of the same component inside one card, nested through slots, and survives a tree that contains itself', () => {
    const s = fresh();
    const box = addDef(s, {
      componentId: 'test.box',
      name: 'Box',
      properties: {},
      parts: {},
      slots: { body: { label: 'Body' } },
      build: (b) => b.el('box-root', 'div', {}, [b.slot('box-slot', 'body')])
    });
    const page = home(s);
    const card = { id: 'n_card', kind: 'element' as const, tag: 'article' as const, link: { type: 'url' as const, target: 'https://example.com/card' }, children: ['n_loop', 'n_box1'] };
    // A plain container listed inside itself comes first, and the check still reaches the boxes after it.
    const loop = { id: 'n_loop', kind: 'element' as const, tag: 'div' as const, children: ['n_loop'] };
    const first = { ...makeInstance(box, {}), id: 'n_box1', slots: { body: ['n_box2'] } };
    const second = { ...makeInstance(box, {}), id: 'n_box2', slots: { body: ['n_more'] } };
    const more = { id: 'n_more', kind: 'link' as const, link: { type: 'url' as const, target: 'https://example.com/more' }, label: 'More', appearance: 'primary' };
    for (const n of [card, loop, first, second, more]) page.nodes[n.id] = n;
    page.rootIds.push(card.id);
    expect(validateState(s).filter((d) => d.code === 'CARD_LINK_INTERACTIVE')).toEqual([expect.objectContaining({ nodeId: 'n_card', message: expect.stringContaining('a button or link sits inside') })]);
  });

  it('stays quick on a deep library of components that each place the one before twice', () => {
    const s = fresh();
    let prev = addDef(s, { componentId: 'test.leaf', name: 'Leaf', properties: {}, parts: {}, build: (b) => b.text('leaf', 'p', 'Leaf') });
    for (let i = 0; i < 25; i++) {
      const below = prev;
      prev = addDef(s, {
        componentId: `test.level${i}`,
        name: `Level ${i}`,
        properties: {},
        parts: {},
        build: (b) => {
          for (const id of ['a', 'b']) b.nodes[id] = { ...makeInstance(below, {}), id };
          return b.el('root', 'div', {}, ['a', 'b']);
        }
      });
    }
    const top = prev;
    addDef(s, { componentId: 'test.deepcard', name: 'Deep card', properties: {}, parts: {}, build: (b) => { b.nodes.top = { ...makeInstance(top, {}), id: 'top' }; return b.el('card', 'div', { link: { type: 'url', target: 'https://example.com' } }, ['top']); } });
    const started = performance.now();
    expect(validateState(s).filter((d) => d.code === 'CARD_LINK_INTERACTIVE')).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('stays quick when every level of a library passes a card slot on through two placements', () => {
    const s = fresh();
    let prev = addDef(s, {
      componentId: 'test.slotcard',
      name: 'Slot card',
      properties: {},
      parts: {},
      slots: { body: { label: 'Body' } },
      build: (b) => b.el('card', 'div', { link: { type: 'url', target: 'https://example.com' } }, [b.slot('s', 'body')])
    });
    for (let i = 0; i < 25; i++) {
      const below = prev;
      prev = addDef(s, {
        componentId: `test.pass${i}`,
        name: `Pass ${i}`,
        properties: {},
        parts: {},
        slots: { body: { label: 'Body' } },
        build: (b) => {
          b.slot('sa', 'body');
          b.slot('sb', 'body');
          for (const [id, slot] of [['a', 'sa'], ['b', 'sb']]) b.nodes[id] = { ...makeInstance(below, {}), id, slots: { body: [slot] } };
          return b.el('root', 'div', {}, ['a', 'b']);
        }
      });
    }
    const started = performance.now();
    expect(validateState(s).filter((d) => d.code === 'CARD_LINK_INTERACTIVE')).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('survives a card whose content lists itself as its own child', () => {
    const s = fresh();
    const def = cardsDef(s);
    def.properties.box = P.choice('Box', 'div', [['div', 'Plain'], ['details', 'Disclosure']]);
    // Listed before the card, so a parent search finds the loop first.
    def.tree!.nodes = { loop: { id: 'loop', kind: 'element', tag: { $item: 'tag' }, children: ['loop'] }, ...def.tree!.nodes };
    (def.tree!.nodes.feature as { children: string[] }).children.push('loop');
    expect(() => validateState(s)).not.toThrow();
  });

  it('refuses an edit that puts a link inside a card, and counts a bound destination as used', () => {
    const s = fresh();
    const def = cardsDef(s);
    const r = applyOperations(s, [{ type: 'node.insert', owner: owner(def), parentId: 'card', primitive: 'button', text: 'More' }]);
    // The session refuses a batch that introduces a blocking error.
    expect(errors(r.state).map((d) => d.code)).toEqual(['CARD_LINK_INTERACTIVE']);
    expect(() => applyOperations(s, [{ type: 'component.removePropSchema', definitionId: def.id, prop: 'featureLink' }])).toThrow(/is still shown by/);
    // A container's destination binds and unbinds like a button's.
    const unbound = applyOperations(s, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'feature', field: 'link', binding: null }]).state;
    expect(unbound.components[def.id].tree!.nodes.feature).toMatchObject({ link: { type: 'url', target: 'https://example.com/feature' } });
    const rebound = applyOperations(unbound, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'feature', field: 'link', binding: { $prop: 'featureLink' } }]).state;
    expect(rebound.components[def.id].tree!.nodes.feature).toMatchObject({ link: { $prop: 'featureLink' } });
    const unlinked = applyOperations(unbound, [{ type: 'node.setContent', owner: owner(def), nodeId: 'feature', field: 'link', value: { type: 'none', target: '' } }]).state;
    expect(unlinked.components[def.id].tree!.nodes.feature).not.toHaveProperty('link');
  });
});

// ---------------------------------------------------------------------------
// Bindings outside a component
// ---------------------------------------------------------------------------

describe('bindings outside a component (#90)', () => {
  it('render as empty on a page instead of reading an item that is not there', async () => {
    const s = fresh();
    const page = home(s);
    page.nodes.n_named = { id: 'n_named', kind: 'link', link: { type: 'url', target: 'https://example.com/named' }, label: 'Named', appearance: 'link', ariaLabel: { $item: 'name' } };
    page.rootIds.push('n_named');
    // It still renders, and opening the project says what is wrong with it (#205).
    expect(validateState(s).filter((d) => d.code === 'BINDING_SCOPE').map((d) => d.nodeId)).toEqual(['n_named']);
    expect(compileErrors(s)).toEqual([]);
    expect(await renderHome(s)).toMatch(/<a href="https:\/\/example\.com\/named"[^>]*>Named<\/a>/);
  });
});

describe('gallery items that open a full image or a link (#75)', () => {
  const aboutOf = (s: ProjectState) => Object.values(s.pages).find((p) => p.route === '/about/')!.id;
  /** A photo with smaller copies, as the media library keeps one (in the order given, when `widths` is). */
  function photo(s: ProjectState, id: string, width = 1536, widths = [480, 960, 1440]) {
    s.assets.assets[id] = {
      id,
      name: `${id}.jpg`,
      file: `static/images/${id}.jpg`,
      mime: 'image/jpeg',
      bytes: 1000,
      width,
      height: Math.round((width * 2) / 3),
      hash: id,
      kind: 'image',
      variants: widths.filter((w) => w < width).map((w) => ({ width: w, file: `static/images/${id}-${w}.jpg` })),
      createdAt: '2026-01-01T00:00:00.000Z'
    };
    return { assetId: id, alt: `The ${id} photo` };
  }
  function gallery(s: ProjectState) {
    const def = Object.values(s.components).find((d) => d.componentId === 'media.gallery')!;
    const node = Object.values(home(s).nodes).find((n) => n.kind === 'instance' && n.definitionId === def.id) as InstanceNode;
    return { def, node };
  }
  /** Each photo's markup in one gallery placement, in order. */
  const photos = (html: string) => html.split(/<li\b/).slice(1).map((li) => li.slice(0, li.indexOf('</li>')));
  const count = (html: string, re: RegExp) => html.match(new RegExp(re.source, 'g'))?.length ?? 0;
  /** A photo's markup is exactly one link (opening with `open`) around its one figure, and nothing else. */
  const wrapped = (li: string, open: RegExp, close = '</figure></a>') =>
    open.test(li) && li.trimEnd().endsWith(close) && count(li, /<a /) === 1 && count(li, /<\/a>/) === 1 && count(li, /<figure /) === 1;
  const figure = '<figure class="so-foundation-media-gallery__photo-figure">';
  /** The groups of the photos that open, by placement, as the viewer reads them. */
  const groupsOf = (html: string) => [...html.matchAll(/data-viewer-group="([^"]+)"/g)].map((m) => JSON.parse(m[1].replace(/&quot;/g, '"')) as string[]);

  it('wraps each photo, caption included, in one link to its full image or its destination', async () => {
    const s = fresh();
    const { def, node } = gallery(s);
    const about = aboutOf(s);
    node.props.images = [
      // Smaller copies stored out of order: the largest still becomes the thumbnail's own file.
      { id: 'p1', image: photo(s, 'kitchen', 1536, [960, 1440, 480]), caption: 'Kitchen, Millbrook', action: 'image' },
      { id: 'p2', image: photo(s, 'bedroom'), caption: 'Bedroom, Ashford', action: 'link', link: { type: 'page', target: about } },
      // A destination kept from before stays unused while the photo does nothing, or opens full size.
      { id: 'p3', image: photo(s, 'study'), caption: 'Study, Elm Street', action: 'none', link: { type: 'page', target: about } },
      { id: 'p4', image: { ...photo(s, 'hall'), decorative: true }, caption: 'Hall, Old Mill', action: 'image', link: { type: 'page', target: about } },
      // Nothing to open: no picture, or no destination.
      { id: 'p5', image: { assetId: null, alt: '' }, caption: 'Coming soon', action: 'image' },
      { id: 'p6', image: photo(s, 'porch'), caption: 'Porch, Harbour Lane', action: 'link' },
      // Saved before photos could open, with a destination: nothing happens.
      { id: 'p7', image: photo(s, 'attic'), caption: 'Attic, Westfield', link: { type: 'page', target: about } },
      // A small photo with no smaller copies is its own thumbnail.
      { id: 'p8', image: photo(s, 'shed', 400), caption: 'Shed', action: 'image' },
      { id: 'p9', image: photo(s, 'barn'), caption: 'Barn, Eastside', action: 'link', link: { type: 'url', target: 'https://example.com/barn', newTab: true } }
    ];
    expect(errors(s)).toEqual([]);
    expect(compileErrors(s)).toEqual([]);
    const [section] = placements(await renderHome(s), def);
    const all = photos(section.slice(0, section.indexOf('</ul>')));
    expect(all).toHaveLength(9);
    const [kitchen, bedroom, study, hall, soon, porch, attic, shed, barn] = all;
    // The whole figure, image and caption, is the one link: to the full-size file, which the thumbnail never offers.
    expect(wrapped(kitchen, new RegExp(`^[^>]*><a href="/studio/images/kitchen\\.jpg" class="so-card-link so-action so-action--image" aria-haspopup="dialog" data-viewer-group="[^"]+" data-alt="The kitchen photo"[^>]*>${figure}<img `), '</figure><span class="so-visually-hidden">View full image</span></a>')).toBe(true);
    expect(kitchen).toContain('alt="The kitchen photo"');
    expect(kitchen).toContain('<figcaption class="so-foundation-media-gallery__caption so-foundation-media-gallery--tone-default">Kitchen, Millbrook</figcaption></figure>');
    expect(kitchen).toContain('data-sveltekit-reload=""');
    expect(kitchen).toMatch(/<img src="\/studio\/images\/kitchen-1440\.jpg" srcset="\/studio\/images\/kitchen-960\.jpg 960w, \/studio\/images\/kitchen-1440\.jpg 1440w, \/studio\/images\/kitchen-480\.jpg 480w" /);
    expect(kitchen.match(/kitchen\.jpg/g)).toHaveLength(1);
    // The viewer is not part of the page until a visitor opens it.
    expect(section).not.toContain('<dialog');
    // A link goes to its page, around the whole figure, and its thumbnail is as any other.
    expect(wrapped(bedroom, new RegExp(`^[^>]*><a href="/studio/about/" class="so-card-link so-action">${figure}<img `))).toBe(true);
    expect(bedroom).toContain('/studio/images/bedroom.jpg 1536w');
    expect(wrapped(barn, new RegExp(`^[^>]*><a href="https://example\\.com/barn" class="so-card-link so-action" target="_blank" rel="noopener noreferrer">${figure}`))).toBe(true);
    for (const li of [study, soon, porch, attic]) {
      expect(count(li, /<a /)).toBe(0);
      expect(li).toMatch(new RegExp(`^[^>]*>${figure}`));
    }
    expect(soon).toContain('so-img--placeholder');
    // A decorative photo opens without words, as its thumbnail has none.
    expect(wrapped(hall, /^[^>]*><a href="\/studio\/images\/hall\.jpg" class="so-card-link so-action so-action--image" aria-haspopup="dialog" data-viewer-group="[^"]+" data-alt=""/, '</figure><span class="so-visually-hidden">View full image</span></a>')).toBe(true);
    expect(hall).not.toContain('/about/');
    expect(shed).toMatch(/<a href="\/studio\/images\/shed\.jpg"[^>]*>[^<]*<figure[^>]*><img src="\/studio\/images\/shed\.jpg" (?!srcset)/);
    expect(shed).not.toContain('srcset');
  });

  it('moves through the photos of one list in one placement, never into another list or placement', async () => {
    const s = fresh();
    const { def, node } = gallery(s);
    node.props.images = [
      { id: 'p1', image: photo(s, 'kitchen'), caption: 'Kitchen', action: 'image' },
      { id: 'p2', image: photo(s, 'bedroom'), caption: 'Bedroom', action: 'image' }
    ];
    place(s, def, { images: [{ id: 'p1', image: photo(s, 'garden'), caption: 'Garden', action: 'image' }] });
    const shot = { pic: P.image('Picture'), mode: P.choice('Mode', 'image', [['image', 'Full'], ['none', 'Nothing']]) };
    const rows = addDef(s, {
      componentId: 'test.rows',
      name: 'Two rows',
      properties: { a: P.list('Row A', 'Shot', shot, [{ pic: photo(s, 'a1') }, { pic: photo(s, 'a2') }]), b: P.list('Row B', 'Shot', shot, [{ pic: photo(s, 'b1') }]) },
      parts: {},
      build: (b) =>
        b.el('root', 'section', {}, [
          b.el('list-a', 'div', {}, [b.repeat('row-a', 'a', [b.el('fig-a', 'figure', { action: item('mode') }, [b.image('img-a', item('pic'))])])]),
          b.el('list-b', 'div', {}, [b.repeat('row-b', 'b', [b.el('fig-b', 'figure', { action: item('mode') }, [b.image('img-b', item('pic'))])])])
        ])
    });
    place(s, rows);
    expect(errors(s)).toEqual([]);
    const page = await renderHome(s);
    const galleries = placements(page, def).map((html) => groupsOf(html.slice(0, html.indexOf('</ul>'))));
    expect(galleries.map((g) => g.length)).toEqual([2, 1]);
    expect(galleries[0][0]).toEqual(galleries[0][1]);
    expect(galleries[0][0][1]).toBe('photos');
    expect(galleries[1][0][0]).not.toBe(galleries[0][0][0]);
    const [own] = placements(page, rows).map(groupsOf);
    expect(own.map((g) => g[1])).toEqual(['row-a', 'row-a', 'row-b']);
    expect(own[0]).toEqual(own[1]);
    expect(own[2][0]).toBe(own[0][0]);
  });

  it('opens the first picture that shows, with the words its thumbnail has', async () => {
    const s = fresh();
    const pick = addDef(s, {
      componentId: 'test.pick',
      name: 'Pick',
      properties: { showA: P.bool('Show A', false), hideB: P.bool('Hide B', false), a: P.image('A'), b: P.image('B'), label: P.str('Label', 'Berries on a plate') },
      parts: {},
      build: (b) =>
        b.el('root', 'section', {}, [
          b.el('shot', 'figure', { action: 'image' }, [
            b.el('wrap-a', 'div', { when: prop('showA') }, [b.image('img-a', prop('a'))]),
            // An element inside that does nothing when clicked is just a wrapper.
            b.el('inert', 'div', { action: 'none' }, [b.image('img-b', prop('b'), { unless: prop('hideB'), fallbackAlt: prop('label') })])
          ])
        ])
    });
    const placed = place(s, pick, { a: photo(s, 'apple'), b: { ...photo(s, 'berry'), alt: '' } });
    expect(errors(s)).toEqual([]);
    const html = async () => placements(await renderHome(s), pick)[0];
    const anchor = async () => /<a href="([^"]+)"[^>]*data-alt="([^"]*)"/.exec(await html())?.slice(1) ?? null;
    // The first picture's wrapper is hidden, so the photo that shows is the one that opens, named as its thumbnail is.
    expect(await anchor()).toEqual(['/studio/images/berry.jpg', 'Berries on a plate']);
    expect(await html()).toContain('alt="Berries on a plate"');
    expect(await html()).not.toContain('berry.jpg 1536w');
    placed.props.showA = true;
    expect(await anchor()).toEqual(['/studio/images/apple.jpg', 'The apple photo']);
    // Only the picture that opens leaves its full-size file to the viewer; the other keeps its own as usual.
    expect(await html()).not.toContain('apple.jpg 1536w');
    expect(await html()).toContain('berry.jpg 1536w');
    // With neither picture showing there is nothing to open.
    placed.props.showA = false;
    placed.props.hideB = true;
    expect(await anchor()).toBeNull();
    expect(await html()).not.toContain('<a ');
  });

  it('counts a photo that opens as a link: a gallery inside a card stops the card linking, but its own photos are fine', async () => {
    const el = (extra: Record<string, unknown>) => ({ id: 'x', kind: 'element', tag: 'figure', children: [], ...extra }) as unknown as GraphNode;
    const to = { type: 'url', target: 'https://example.com/x' };
    expect(isCardLink(el({ action: item('a') }))).toBe(true);
    expect(isCardLink(el({ action: 'image' }))).toBe(true);
    expect(isCardLink(el({ action: 'link', link: to }))).toBe(true);
    expect(isCardLink(el({ action: 'link' }))).toBe(false);
    expect(isCardLink(el({ action: 'none', link: to }))).toBe(false);
    // A link cannot wrap a list item or a disclosure, or a tag chosen at runtime: the action does nothing there.
    expect(isCardLink(el({ action: 'image', tag: 'li' }))).toBe(false);
    expect(isCardLink(el({ action: 'link', link: to, tag: 'details' }))).toBe(false);
    expect(isCardLink(el({ action: 'image', tag: 'summary' }))).toBe(false);
    expect(isCardLink(el({ action: 'image', tag: 'figcaption' }))).toBe(false);
    expect(isCardLink(el({ action: 'image', tag: 'div' }))).toBe(true);
    expect(isCardLink(el({ action: item('a'), tag: prop('tag') }))).toBe(false);
    expect(isCardLink(el({ link: to, tag: 'li' }))).toBe(true);

    const s = fresh();
    expect(errors(s)).toEqual([]);
    const panel = addDef(s, {
      componentId: 'test.panel',
      name: 'Linked panel',
      properties: { to: P.link('To', { type: 'url', target: 'https://example.com/panel' }) },
      parts: {},
      slots: { content: { label: 'Content' } },
      build: (b) => b.el('panel', 'div', { link: prop('to') }, [b.slot('content-slot', 'content')])
    });
    const holder = place(s, panel);
    const { node } = gallery(s);
    node.props.images = [{ id: 'p1', image: photo(s, 'kitchen'), caption: 'Kitchen', action: 'image' }];
    home(s).rootIds = home(s).rootIds.filter((id) => id !== node.id);
    holder.slots = { content: [node.id] };
    const found = errors(s);
    expect(found.map((d) => d.code)).toEqual(['CARD_LINK_INTERACTIVE']);
    expect(found[0].message).toMatch(/“Gallery”, which holds the “Figure” element/);
    expect(found[0].nodeId).toBe(holder.id);
    // The panel renders without its link; the photo inside it still opens.
    const [html] = placements(await renderHome(s), panel);
    expect(html).not.toContain('https://example.com/panel');
    expect(html).toContain('<a href="/studio/images/kitchen.jpg" class="so-card-link so-action so-action--image"');
  });

  it('takes what a click does only from a choice of nothing, the full image or the link', () => {
    const s = fresh();
    const build = (b: Parameters<ComponentSpec['build']>[0]) =>
      b.el('root', 'section', {}, [b.el('shot', 'figure', { action: prop('mode'), link: prop('to') }, [b.image('pic', prop('pic'))])]);
    const ok = addDef(s, { componentId: 'test.shot', name: 'Shot', properties: { mode: P.choice('Mode', 'image', [['image', 'Full'], ['none', 'Nothing'], ['link', 'Link']]), to: P.link('To'), pic: P.image('Picture') }, parts: {}, build });
    const zoom = addDef(s, { componentId: 'test.zoom', name: 'Zoom', properties: { mode: P.choice('Mode', 'image', [['image', 'Full'], ['zoom', 'Zoom'], ['pan', 'Pan']]), to: P.link('To'), pic: P.image('Picture') }, parts: {}, build });
    const text = addDef(s, { componentId: 'test.text-mode', name: 'Typed mode', properties: { mode: P.str('Mode', 'image'), to: P.link('To'), pic: P.image('Picture') }, parts: {}, build });
    const found = errors(s).filter((d) => d.code === 'BINDING_INVALID');
    expect(found.map((d) => d.owner?.id)).toEqual([zoom.id, text.id]);
    expect(found[0].message).toMatch(/takes what a click does from a choice whose options "zoom", "pan" are not "none", "image", "link"/);
    expect(found[1].message).toMatch(/shows a string property as its action, which needs a enum property/);
    // A property that still decides what a click does stays a choice of those.
    const retype = (schema: Record<string, unknown>) => () => applyOperations(s, [{ type: 'component.setPropSchema', definitionId: ok.id, prop: 'mode', schema }]);
    expect(retype({ type: 'string', label: 'Mode', default: 'image' })).toThrow(/needs a enum property/);
    expect(retype({ type: 'enum', label: 'Mode', default: 'image', options: [{ value: 'image', label: 'Full' }, { value: 'zoom', label: 'Zoom' }] })).toThrow(/takes what a click does from a choice whose options "zoom"/);
  });

  it('lets a component’s own design unbind, set and bind what a click does', () => {
    const base = fresh();
    const def = addDef(base, {
      componentId: 'test.shot',
      name: 'Shot',
      properties: { mode: P.choice('Mode', 'image', [['image', 'Full'], ['none', 'Nothing']]), label: P.str('Label', 'x'), pic: P.image('Picture') },
      parts: {},
      build: (b) => b.el('root', 'section', {}, [b.el('shot', 'figure', { action: prop('mode') }, [b.image('pic', prop('pic'))])])
    });
    const at = { owner: owner(def), nodeId: 'shot' };
    // Both operations take the field, as the AI and the inspector send them.
    expect(validateOperation({ type: 'node.setContent', ...at, field: 'action', value: 'image' }).ok).toBe(true);
    expect(validateOperation({ type: 'node.setBinding', ...at, field: 'action', binding: null }).ok).toBe(true);
    const shot = (s: ProjectState) => (s.components[def.id].tree!.nodes.shot as { action?: unknown }).action;
    // Unbinding keeps what the property chose by default; then a fixed value can be set, but only one of the three.
    let s = applyOperations(base, [{ type: 'node.setBinding', ...at, field: 'action', binding: null }]).state;
    expect(shot(s)).toBe('image');
    s = applyOperations(s, [{ type: 'node.setContent', ...at, field: 'action', value: 'link' }]).state;
    expect(shot(s)).toBe('link');
    expect(() => applyOperations(s, [{ type: 'node.setContent', ...at, field: 'action', value: 'zoom' }])).toThrow(/What a click does must be none, image, link/);
    expect(() => applyOperations(s, [{ type: 'node.setContent', ...at, field: 'action', value: ['image'] }])).toThrow(/What a click does must be/);
    expect(() => applyOperations(s, [{ type: 'node.setContent', owner: owner(def), nodeId: 'pic', field: 'action', value: 'image' }])).toThrow(/Only containers/);
    // The property can then be renamed away, and a choice bound again; a text property cannot.
    s = applyOperations(s, [{ type: 'component.removePropSchema', definitionId: def.id, prop: 'mode' }]).state;
    expect(() => applyOperations(s, [{ type: 'node.setBinding', ...at, field: 'action', binding: { $prop: 'label' } }])).toThrow(/needs a enum property/);
    s = applyOperations(s, [
      { type: 'component.setPropSchema', definitionId: def.id, prop: 'opens', schema: { type: 'enum', label: 'Opens', default: 'none', options: [{ value: 'none', label: 'Nothing' }, { value: 'image', label: 'Full' }] } },
      { type: 'node.setBinding', ...at, field: 'action', binding: { $prop: 'opens' } }
    ]).state;
    expect(shot(s)).toEqual({ $prop: 'opens' });
    expect(errors(s)).toEqual([]);
  });
});
