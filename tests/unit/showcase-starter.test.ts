import { afterEach, describe, expect, it } from 'vitest';
import type { AssetRecord, InstanceNode, NodeTree, ProjectState } from '@shared/types';
import { FOUNDATION_PACK } from '@catalogue/builtin';
import { createPack } from '@catalogue/dsl';
import { listThemes, registerPacks } from '@catalogue/index';
import { STARTERS, STARTER_ASSETS, createStarterState, starterProblem, starterTakesSamples } from '@catalogue/starters';
import { showcaseKind, showcasePages } from '@catalogue/showcase';
import { validateState } from '@engine/validate';
import { generateProject } from '@generator/index';
import { buildPack } from '../../src/main/packs/build';

const shipped = listThemes().filter((t) => !t.devOnly);
const builtins = [...listThemes()];
afterEach(() => registerPacks(builtins));

/** Every placement a tree shows from its roots, through elements' children and placements' slots, with repeats. */
function placed(tree: NodeTree): InstanceNode[] {
  const out: InstanceNode[] = [];
  const walk = (id: string) => {
    const n = tree.nodes[id];
    if (!n) throw new Error(`Node ${id} is not in its tree.`);
    if (n.kind === 'instance') {
      out.push(n);
      for (const ids of Object.values(n.slots ?? {})) ids.forEach(walk);
    } else if ('children' in n && Array.isArray(n.children)) n.children.forEach(walk);
  };
  tree.rootIds.forEach(walk);
  return out;
}

const componentIds = (s: ProjectState, nodes: InstanceNode[]) => nodes.map((n) => s.components[n.definitionId].componentId);

/** The sample photos as the app records them once imported, so a site with them validates as it opens. */
function withSampleRecords(s: ProjectState): ProjectState {
  for (const a of STARTER_ASSETS)
    s.assets.assets[a.id] = { id: a.id, name: a.name, kind: 'image', file: `static/assets/${a.source}`, mime: 'image/jpeg', width: 1600, height: 1067, size: 1000, alt: a.alt } as unknown as AssetRecord;
  return s;
}

describe('Component showcase starter', () => {
  it('is offered beside the other starters and takes the sample photos', () => {
    expect(STARTERS.map((s) => s.id)).toContain('showcase');
    expect(STARTERS.find((s) => s.id === 'showcase')?.name).toBe('Component showcase');
    expect(starterTakesSamples('showcase')).toBe(true);
    expect(starterTakesSamples('blank')).toBe(false);
  });

  for (const theme of shipped)
    it(`places every component ${theme.name} ships exactly once outside Home`, () => {
      const s = createStarterState('showcase', 'Showcase', false, theme.id);
      const home = s.site.homePageId;
      const outside = [
        ...Object.values(s.pages)
          .filter((p) => p.id !== home)
          .flatMap((p) => componentIds(s, placed(p))),
        ...componentIds(s, placed(s.site.shell.header)),
        ...componentIds(s, placed(s.site.shell.footer))
      ];
      expect(outside.sort()).toEqual(theme.components.map((c) => c.componentId).sort());
      // Home has a few of the strongest sections of its own.
      expect(placed(s.pages[home]).length).toBeGreaterThanOrEqual(3);
      expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
    });

  it('puts each block inside a layout and links every page from the header and footer', () => {
    const s = createStarterState('showcase', 'Showcase', false, 'foundation');
    const blocks = Object.values(s.pages).find((p) => p.title === 'Blocks')!;
    const roots = blocks.rootIds.map((id) => blocks.nodes[id]);
    // Only the layouts are sections; every block sits in one of their slots.
    expect(roots.map((n) => n.kind === 'instance' && s.components[n.definitionId].componentId)).toEqual(['layout.section', 'layout.split']);
    const inSlots = roots.flatMap((n) => (n.kind === 'instance' ? Object.values(n.slots ?? {}).flat() : []));
    const blockIds = FOUNDATION_PACK.components.filter((c) => c.insertAs === 'element').map((c) => c.componentId);
    expect(inSlots.map((id) => s.components[(blocks.nodes[id] as InstanceNode).definitionId].componentId).sort()).toEqual([...blockIds].sort());
    for (const shell of [s.site.shell.header, s.site.shell.footer]) {
      const links = (shell.nodes[shell.rootIds[0]] as InstanceNode).props.links as Array<{ link: { target: string } }>;
      expect(links.map((l) => l.link.target)).toEqual(s.site.pageOrder.filter((id) => !s.pages[id].article || s.pages[id].article?.hidden));
    }
    // The post and news lists have something to show: published posts, and dated pages other than their own.
    expect(Object.values(s.collections.posts.entries).filter((e) => !e.draft)).toHaveLength(3);
    expect(Object.values(s.pages).filter((p) => p.article && !p.article.hidden)).toHaveLength(2);
  });

  it('fills empty images, galleries and carousels with the sample photos when asked, and generates', () => {
    const s = withSampleRecords(createStarterState('showcase', 'Showcase', true, 'foundation'));
    const all = Object.values(s.pages).flatMap((p) => placed(p));
    const of = (id: string) => all.find((n) => s.components[n.definitionId].componentId === id)!;
    const ids = new Set(STARTER_ASSETS.map((a) => a.id));
    expect(ids.has((of('hero.split').props.image as { assetId: string }).assetId)).toBe(true);
    for (const [id, list] of [
      ['media.gallery', 'images'],
      ['media.carousel', 'slides']
    ] as const) {
      const rows = of(id).props[list] as Array<{ image: { assetId: string } }>;
      expect(rows.length, id).toBe(3);
      for (const r of rows) expect(ids.has(r.image.assetId), id).toBe(true);
    }
    // Team portraits are the portrait photos.
    const people = of('team.grid').props.people as Array<{ portrait: { assetId: string } }>;
    for (const p of people) expect(p.portrait.assetId).toMatch(/^a_person/);
    // Tabs keep a picture inside each tab.
    const tabs = JSON.stringify(of('tabs.showcase').props);
    expect(tabs).toMatch(/"assetId":"a_/);
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
    expect(() => generateProject(s)).not.toThrow();
    // Without the photos nothing points at one.
    expect(JSON.stringify(createStarterState('showcase', 'Showcase', false, 'foundation').pages)).not.toMatch(/"assetId":"a_/);
  });

  it('places a component a theme adds on a page of its kind, and is made by a theme missing a section', () => {
    const { components, ...meta } = FOUNDATION_PACK;
    const author = createPack({ ...meta, id: 'sparse', name: 'Sparse', version: '1.0.0', license: 'MIT' });
    const defs = components.filter((c) => c.componentId !== 'hero.split').map((c) => author.adopt(c));
    const quote = author.adopt(components.find((c) => c.componentId === 'content.text')!);
    quote.componentId = 'content.quote';
    quote.id = quote.id.replace('content.text', 'content.quote');
    quote.name = 'Quote';
    registerPacks([...builtins, buildPack(author.define([...defs, quote])).pack]);
    expect(starterProblem('showcase', 'sparse')).toBeNull();
    // The Business starter still needs the split hero this theme lacks.
    expect(starterProblem('business', 'sparse')).not.toBeNull();
    const s = createStarterState('showcase', 'Sparse', false, 'sparse');
    const content = Object.values(s.pages).find((p) => p.title === 'Content')!;
    expect(componentIds(s, placed(content))).toContain('content.quote');
    expect(showcasePages('sparse').flatMap((p) => p.components.map((c) => c.componentId))).not.toContain('hero.split');
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('is refused by a theme whose menu cannot link every page', () => {
    const { components, ...meta } = FOUNDATION_PACK;
    const author = createPack({ ...meta, id: 'narrow', name: 'Narrow', version: '1.0.0', license: 'MIT' });
    const defs = components.map((c) => {
      const d = author.adopt(c);
      const links = d.componentId === 'shell.header' ? d.properties.links : undefined;
      if (links?.type === 'list') links.max = 3;
      return d;
    });
    registerPacks([...builtins, buildPack(author.define(defs)).pack]);
    expect(starterProblem('showcase', 'narrow')).toMatch(/^The Narrow theme cannot make the Component showcase: its Header menu holds 3 links, and the showcase has 10 pages\./);
    expect(starterProblem('blank', 'narrow')).toBeNull();
  });

  it('lists kind pages in a page list, each card taking its title from its page', () => {
    const s = createStarterState('showcase', 'Showcase', false, 'foundation');
    const list = Object.values(s.pages)
      .flatMap((p) => placed(p))
      .find((n) => s.components[n.definitionId].componentId === 'content.pages')!;
    const rows = list.props.items as Array<{ pageLink: { type: string; target: string }; title: string }>;
    expect(rows.map((r) => s.pages[r.pageLink.target]?.title)).toEqual(['Heroes', 'Features', 'Content']);
    for (const r of rows) expect(r.title).toBe('');
  });

  it('sorts components into kinds by what they are', () => {
    const kind = (id: string) => showcaseKind(FOUNDATION_PACK.components.find((c) => c.componentId === id)!);
    expect(kind('shell.header')).toBeNull();
    expect(kind('block.stat')).toBe('blocks');
    expect(kind('layout.split')).toBe('blocks');
    expect(kind('content.article')).toBe('blog');
    expect(kind('content.news')).toBe('blog');
    expect(kind('pricing.toggle')).toBe('pricing');
    expect(kind('tabs.showcase')).toBe('features');
    expect(kind('content.media')).toBe('content');
    expect(kind('intro.page')).toBe('heroes');
    expect(kind('logos.strip')).toBe('proof');
    expect(kind('contact.form')).toBe('contact');
    expect(kind('media.gallery')).toBe('media');
  });
});
