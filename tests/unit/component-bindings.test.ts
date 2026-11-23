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
import type { ComponentDefinition, InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { blocksSaving, validateState } from '@engine/validate';
import { generateProject } from '@generator/index';
import { usedIcons } from '@generator/runtime-files';
import { P, eq, item, managed, ne, prop, type ComponentSpec } from '@catalogue/dsl';
import { nodeClass } from '@generator/index';
import { axesOf } from '@shared/variants';

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
  for (const [path, source] of generateProject(s)) {
    if (!path.startsWith('src/') || !/\.(svelte|js)$/.test(path)) continue;
    const out = join(dir, path.endsWith('.svelte') ? `${path}.js` : path);
    mkdirSync(dirname(out), { recursive: true });
    const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true }).js.code : source;
    writeFileSync(out, code.replace(/(["'])([^"'\n]+?\.svelte)\1/g, '$1$2.js$1').replace(/(["'])\$app\/paths\1/g, JSON.stringify(paths)));
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
    expect(compileErrors(s)).toEqual([]);
    expect(await renderHome(s)).toMatch(/<a href="https:\/\/example\.com\/named"[^>]*>Named<\/a>/);
  });
});
