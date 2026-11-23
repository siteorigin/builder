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
const section = (html: string, def: ComponentDefinition) => {
  const start = html.indexOf(`so-${def.id.replace(/[^a-zA-Z0-9]/g, '-')}`);
  return start < 0 ? '' : html.slice(html.lastIndexOf('<', start));
};

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
            b.text('team', 'span', 'For teams', { when: ne(item('seats'), 1) })
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
    expect(errors(s)).toEqual([]);
    expect(compileErrors(s)).toEqual([]);
    const html = section(await renderHome(s), def);
    const cards = html.split('<article').slice(1);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain('Basic');
    expect(cards[0]).not.toContain('Most popular');
    expect(cards[0]).toContain('Standard plan');
    expect(cards[0]).not.toContain('For teams');
    expect(cards[1]).toContain('Pro');
    expect(cards[1]).toContain('Most popular');
    expect(cards[1]).not.toContain('Standard plan');
    expect(cards[1]).toContain('For teams');
    expect(html).toContain('Plays a video');
    expect(html).not.toContain('Shows a still');
  });

  it('is validated on load: the compared value must be one the property can hold', () => {
    const s = fresh();
    const def = plansDef(s);
    const badge = def.tree!.nodes.badge;
    badge.when = { ref: { $item: 'featured' }, eq: 'true' };
    expect(errors(s).map((d) => d.code)).toEqual(['BINDING_INVALID']);
    badge.when = { ref: { $item: 'featured' }, eq: true };
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
    const set = applyOperations(s, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'video-note', field: 'when', binding: { $prop: 'media' }, eq: 'video' }]).state;
    expect(set.components[def.id].tree!.nodes['video-note'].when).toEqual({ ref: { $prop: 'media' }, eq: 'video' });
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

function heroDef(s: ProjectState) {
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
        level: P.choice('Heading level', 'h2', [['h1', 'Heading 1'], ['h2', 'Heading 2']]),
        wrapper: P.choice('Wrapper', 'section', [['section', 'Section'], ['article', 'Article']]),
        tone: P.choice('Tone', tones[0], tones.slice(0, 2).map((t) => [t, t] as [string, string])),
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
    const html = await renderHome(s);
    expect(html).toMatch(/<h1\b[^>]*>Big welcome<\/h1>/);
    expect(html).toMatch(/<h2\b[^>]*>Quiet welcome<\/h2>/);
    expect(html).toMatch(/<article\b[^>]*so-foundation-test-hero/);
    expect(html).toMatch(/<section\b[^>]*so-foundation-test-hero/);
    const gridKey = grid.id.replace(/[^a-zA-Z0-9]/g, '-');
    expect(html).toContain(`so-${gridKey}--tone-${tones[1]}`);
    expect(html).toContain(`so-${gridKey}--tone-${tones[0]}`);
  });

  it('names a navigation landmark and an icon from properties, falling back to the heading when blank', async () => {
    const s = fresh();
    const { def } = heroDef(s);
    place(s, def, { navName: 'Resources' });
    place(s, def, { navName: '', iconName: '' });
    const html = await renderHome(s);
    const navs = [...html.matchAll(/<nav\b[^>]*>/g)].map((m) => m[0]).filter((t) => t.includes('so-foundation-test-hero'));
    expect(navs).toHaveLength(2);
    expect(navs[0]).toContain('aria-label="Resources"');
    expect(navs[0]).not.toContain('aria-labelledby');
    // Cleared, the landmark keeps the name its visible heading gives it.
    expect(navs[1]).not.toContain('aria-label=');
    expect(navs[1]).toMatch(/aria-labelledby="[^"]+-nav-heading"/);
    const icons = [...html.matchAll(/<svg\b[^>]*so-foundation-test-hero__star[^>]*>|<svg\b[^>]*>/g)].map((m) => m[0]).filter((t) => t.includes('foundation-test-hero') && t.includes('star'));
    expect(icons[0]).toContain('aria-label="Highlights"');
    expect(icons[0]).toContain('role="img"');
    expect(icons[1]).toContain('aria-hidden="true"');
  });

  it('counts a property bound only as a tag, variant or accessible name as used', () => {
    const s = fresh();
    const { def } = heroDef(s);
    for (const p of ['level', 'wrapper', 'tone', 'navName', 'iconName'])
      expect(() => applyOperations(s, [{ type: 'component.removePropSchema', definitionId: def.id, prop: p }]), p).toThrow(/is still shown by/);
  });

  it('refuses choices whose options are not tags or variants the node can take', () => {
    const s = fresh();
    const { def } = heroDef(s);
    expect(() =>
      applyOperations(s, [{ type: 'component.setPropSchema', definitionId: def.id, prop: 'level', schema: { type: 'enum', label: 'Level', options: ['h1', 'video'] } }])
    ).toThrow(/"video" are not text tags/);
    expect(() =>
      applyOperations(s, [{ type: 'component.setPropSchema', definitionId: def.id, prop: 'tone', schema: { type: 'enum', label: 'Tone', options: ['plaid'] } }])
    ).toThrow(/"plaid" are not options of/);
    // Bound through node.setBinding too, and caught on load in a hand-edited document.
    expect(() => applyOperations(s, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'title', field: 'tag', binding: { $prop: 'heading' } }])).toThrow(/needs a enum property/);
    def.properties.level = P.choice('Heading level', 'h2', [['h2', 'Heading 2'], ['marquee', 'Marquee']]);
    expect(errors(s).map((d) => d.message)).toEqual([expect.stringMatching(/"marquee" are not text tags/)]);
  });

  it('unbinding a tag keeps the choice’s default, and unbinding a variant keeps its option', () => {
    const s = fresh();
    const { def, tones } = heroDef(s);
    const r = applyOperations(s, [
      { type: 'node.setBinding', owner: owner(def), nodeId: 'title', field: 'tag', binding: null },
      { type: 'node.setBinding', owner: owner(def), nodeId: 'grid', field: 'variant', axis: 'tone', binding: null }
    ]).state;
    const tree = r.components[def.id].tree!;
    expect(tree.nodes.title).toMatchObject({ tag: 'h2' });
    expect((tree.nodes.grid as InstanceNode).variants).toEqual({ tone: tones[0] });
    const back = applyOperations(r, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'grid', field: 'variant', axis: 'tone', binding: { $prop: 'tone' } }]).state;
    expect((back.components[def.id].tree!.nodes.grid as InstanceNode).variants).toEqual({ tone: { $prop: 'tone' } });
    expect(() => applyOperations(r, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'grid', field: 'variant', axis: 'size', binding: { $prop: 'tone' } }])).toThrow(/no variant axis "size"/);
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
          b.link('lead', prop('action'), 'Call us', 'primary', { icon: 'phone' }),
          b.link('trail', prop('action'), 'Read more', 'link', { icon: prop('icon'), iconPosition: 'end' }),
          b.link('chosen', prop('action'), 'Get started', 'secondary', { icon: prop('icon'), iconPosition: prop('side') })
        ])
    });
  }

  it('shows the icon on the chosen side of the label, and compiles', async () => {
    const s = fresh();
    const def = ctaDef(s);
    place(s, def);
    place(s, def, { side: 'start', icon: '' });
    expect(errors(s)).toEqual([]);
    expect(compileErrors(s)).toEqual([]);
    const html = await renderHome(s);
    const anchors = [...html.matchAll(/<a\b[^>]*so-foundation-test-cta[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
    expect(anchors).toHaveLength(6);
    const [lead, trail, chosen, , , chosenStart] = anchors;
    expect(lead).toMatch(/^<a[^>]*>\s*<svg[^>]*so-link__icon--start[^>]*aria-hidden="true"[\s\S]*<\/svg>\s*Call us\s*<\/a>$/);
    expect(trail).toMatch(/Read more\s*<svg[^>]*so-link__icon--end/);
    expect(chosen).toMatch(/Get started\s*<svg[^>]*so-link__icon--end/);
    // A bound icon left empty shows the label alone.
    expect(chosenStart).not.toContain('<svg');
    expect(usedIcons(s)).toEqual(expect.arrayContaining(['phone', 'arrow-right']));
  });

  it('counts a property bound as a link icon or its side as used', () => {
    const s = fresh();
    const def = ctaDef(s);
    for (const p of ['icon', 'side']) expect(() => applyOperations(s, [{ type: 'component.removePropSchema', definitionId: def.id, prop: p }]), p).toThrow(/is still shown by/);
    expect(() =>
      applyOperations(s, [{ type: 'component.setPropSchema', definitionId: def.id, prop: 'side', schema: { type: 'enum', label: 'Side', options: ['start', 'middle'] } }])
    ).toThrow(/"middle" are not "start", "end"/);
  });

  it('sets a literal icon, side and accessible name on a button', () => {
    const s = fresh();
    const def = ctaDef(s);
    const r = applyOperations(s, [
      { type: 'node.setContent', owner: owner(def), nodeId: 'lead', field: 'icon', value: 'mail' },
      { type: 'node.setContent', owner: owner(def), nodeId: 'lead', field: 'iconPosition', value: 'end' },
      { type: 'node.setContent', owner: owner(def), nodeId: 'lead', field: 'ariaLabel', value: 'Email the studio' }
    ]).state;
    expect(r.components[def.id].tree!.nodes.lead).toMatchObject({ icon: 'mail', iconPosition: 'end', ariaLabel: 'Email the studio' });
    expect(() => applyOperations(s, [{ type: 'node.setContent', owner: owner(def), nodeId: 'lead', field: 'iconPosition', value: 'middle' }])).toThrow(/start or end/);
    const cleared = applyOperations(r, [{ type: 'node.setContent', owner: owner(def), nodeId: 'lead', field: 'icon', value: '' }]).state;
    expect(cleared.components[def.id].tree!.nodes.lead).not.toHaveProperty('icon');
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
        ])
      },
      parts: {},
      slots: { extra: { label: 'Extra' } },
      build: (b) =>
        b.el('root', 'section', {}, [
          b.repeat('list', 'services', [
            b.el('card', 'article', { link: item('destination') }, [b.text('card-title', 'h3', item('title')), ...(inner ? [inner(b)] : [])])
          ]),
          b.el('feature', 'div', { link: { type: 'url', target: 'https://example.com/feature' } }, [b.text('feature-title', 'p', 'Featured'), b.slot('extra-slot', 'extra')])
        ])
    });
  }

  it('renders one link around each card with a destination, and the plain container without one', async () => {
    const s = fresh();
    const def = cardsDef(s);
    place(s, def);
    expect(errors(s)).toEqual([]);
    expect(compileErrors(s)).toEqual([]);
    const html = section(await renderHome(s), def);
    expect(html).toMatch(/<a href="https:\/\/example\.com\/design" class="so-card-link[^"]*so-foundation-test-cards__card[^"]*">\s*<h3[^>]*>Design<\/h3>\s*<\/a>/);
    expect(html).toMatch(/<article class="[^"]*so-foundation-test-cards__card[^"]*">\s*<h3[^>]*>Build<\/h3>\s*<\/article>/);
    expect(html).toMatch(/<a href="https:\/\/example\.com\/feature" class="so-card-link/);
  });

  it('refuses a card with a button inside it, and generates the card without its link', async () => {
    const s = fresh();
    const def = cardsDef(s, (b) => b.link('card-button', { type: 'url', target: 'https://example.com/more' }, 'More', 'primary'));
    place(s, def);
    const found = errors(s);
    expect(found.map((d) => d.code)).toEqual(['CARD_LINK_INTERACTIVE']);
    expect(found[0].message).toMatch(/Service cards: a button or link sits inside a card that links somewhere/);
    const html = section(await renderHome(s), def);
    expect(html).not.toContain('https://example.com/design');
    expect(html).toContain('https://example.com/more');
    expect(html).toMatch(/<article class="[^"]*so-foundation-test-cards__card/);
  });

  it('refuses interactive content a placement puts into a slot inside a card', async () => {
    const s = fresh();
    const def = cardsDef(s);
    const inst = place(s, def);
    const button = { id: 'n_slot_button', kind: 'link' as const, link: { type: 'url' as const, target: 'https://example.com/slot' }, label: 'Slot button', appearance: 'primary' };
    home(s).nodes[button.id] = button;
    inst.slots = { extra: [button.id] };
    const found = errors(s);
    expect(found).toEqual([expect.objectContaining({ code: 'CARD_LINK_INTERACTIVE', nodeId: inst.id, owner: { kind: 'page', id: s.site.homePageId } })]);
    const html = section(await renderHome(s), def);
    expect(html).not.toContain('https://example.com/feature');
    expect(html).toContain('https://example.com/slot');
    // Through a nested component too: a code component (a form, say) can place any control.
    const form = s.components[installComponent(s, 'contact.form')];
    const nested = makeInstance(form, {});
    home(s).nodes[nested.id] = nested;
    inst.slots = { extra: [nested.id] };
    expect(errors(s).map((d) => d.code)).toEqual(['CARD_LINK_INTERACTIVE']);
  });

  it('checks every placement of the same component inside one card, and survives a tree that contains itself', () => {
    const s = fresh();
    const box = addDef(s, {
      componentId: 'test.box',
      name: 'Box',
      properties: {},
      parts: {},
      slots: { body: { label: 'Body' } },
      build: (b) => b.el('box-root', 'div', {}, [b.slot('box-slot', 'body')])
    });
    const card = { id: 'n_card', kind: 'element' as const, tag: 'article' as const, link: { type: 'url' as const, target: 'https://example.com/card' }, children: ['n_box1', 'n_box2'] };
    const first = { ...makeInstance(box, {}), id: 'n_box1', slots: { body: ['n_text'] } };
    const second = { ...makeInstance(box, {}), id: 'n_box2', slots: { body: ['n_more'] } };
    const text = { id: 'n_text', kind: 'text' as const, tag: 'p' as const, text: 'Plain words' };
    const more = { id: 'n_more', kind: 'link' as const, link: { type: 'url' as const, target: 'https://example.com/more' }, label: 'More', appearance: 'primary' };
    for (const n of [card, first, second, text, more]) home(s).nodes[n.id] = n;
    home(s).rootIds.push(card.id);
    expect(errors(s)).toEqual([expect.objectContaining({ code: 'CARD_LINK_INTERACTIVE', nodeId: 'n_card', message: expect.stringContaining('“Box”, which holds a button or link') })]);
    // A hand-edited card listed inside itself is read once, not forever.
    card.children.push('n_card');
    expect(() => validateState(s)).not.toThrow();
  });

  it('refuses an edit that puts a link inside a card, and counts a bound destination as used', () => {
    const s = fresh();
    const def = cardsDef(s);
    const r = applyOperations(s, [{ type: 'node.insert', owner: owner(def), parentId: 'card', primitive: 'button', text: 'More' }]);
    // The session refuses a batch that introduces a blocking error.
    expect(errors(r.state).map((d) => d.code)).toEqual(['CARD_LINK_INTERACTIVE']);
    expect(() => applyOperations(s, [{ type: 'component.removePropSchema', definitionId: def.id, prop: 'services' }])).toThrow(/is still shown by/);
    const unlinked = applyOperations(s, [{ type: 'node.setContent', owner: owner(def), nodeId: 'feature', field: 'link', value: { type: 'none', target: '' } }]).state;
    expect(unlinked.components[def.id].tree!.nodes.feature).not.toHaveProperty('link');
  });
});
