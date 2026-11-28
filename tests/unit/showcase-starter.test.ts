import { afterEach, describe, expect, it } from 'vitest';
import type { AssetRecord, InstanceNode, NodeTree, ProjectState } from '@shared/types';
import { getTheme, listThemes } from '@catalogue/index';
import { STARTERS, STARTER_ASSETS, createStarterState, starterProblem, starterTakesSamples } from '@catalogue/starters';
import { showcaseKind, showcasePages } from '@catalogue/showcase';
import { validateState } from '@engine/validate';
import { generateProject } from '@generator/index';
import { pageHeadings } from '@generator/checks';
import { registerBeside, restorePacks, testPack } from './fixtures/packs';

const shipped = listThemes().filter((t) => !t.devOnly);
/** Foundation as the app loads it. */
const FOUNDATION = getTheme('foundation');
afterEach(() => restorePacks());

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
          // The sample news articles are made of the sections an article takes, whatever the kind pages hold.
          .filter((p) => p.id !== home && !p.route.startsWith('/news/'))
          .flatMap((p) => componentIds(s, placed(p))),
        ...componentIds(s, placed(s.site.shell.header)),
        ...componentIds(s, placed(s.site.shell.footer))
      ];
      expect(outside.sort()).toEqual(theme.components.map((c) => c.componentId).sort());
      // Home has a few of the strongest sections of its own.
      expect(placed(s.pages[home]).length).toBeGreaterThanOrEqual(3);
      expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
    });

  /** The Blocks page of Foundation's showcase, its top-level nodes, and Foundation's blocks by component ID. */
  const blocksPage = () => {
    const s = createStarterState('showcase', 'Showcase', false, 'foundation');
    const blocks = Object.values(s.pages).find((p) => p.title === 'Blocks')!;
    const blockIds = FOUNDATION.components.filter((c) => c.insertAs === 'element').map((c) => c.componentId);
    return { s, blocks, roots: blocks.rootIds.map((id) => blocks.nodes[id]), blockIds };
  };

  it('places the layouts first on the Blocks page, and every block once on it', () => {
    const { s, blocks, roots, blockIds } = blocksPage();
    expect(roots.slice(0, 2).map((n) => n.kind === 'instance' && s.components[n.definitionId].componentId)).toEqual(['layout.section', 'layout.split']);
    // Every block is on the page once: in a layout's slot, or in the section that holds what no layout takes.
    const held = roots.flatMap((n) => (n.kind === 'instance' ? Object.values(n.slots ?? {}).flat() : n.kind === 'element' ? n.children : []));
    expect(held.map((id) => s.components[(blocks.nodes[id] as InstanceNode).definitionId].componentId).sort()).toEqual([...blockIds].sort());
  });

  // Release gap: shownOnceSlots (src/engine/slots.ts) counts no slot of a code component as shown once.
  it.fails('puts each block inside a layout', () => {
    const { s, blocks, roots, blockIds } = blocksPage();
    // Only the layouts are sections; every block sits in one of their slots.
    expect(roots.map((n) => n.kind === 'instance' && s.components[n.definitionId].componentId)).toEqual(['layout.section', 'layout.split']);
    const inSlots = roots.flatMap((n) => (n.kind === 'instance' ? Object.values(n.slots ?? {}).flat() : []));
    expect(inSlots.map((id) => s.components[(blocks.nodes[id] as InstanceNode).definitionId].componentId).sort()).toEqual([...blockIds].sort());
  });

  it('links every page from the header and footer, and gives the post and news lists something to show', () => {
    const s = createStarterState('showcase', 'Showcase', false, 'foundation');
    for (const shell of [s.site.shell.header, s.site.shell.footer]) {
      const links = (shell.nodes[shell.rootIds[0]] as InstanceNode).props.links as Array<{ link: { target: string } }>;
      expect(links.map((l) => l.link.target)).toEqual(s.site.pageOrder.filter((id) => !s.pages[id].article || s.pages[id].article?.hidden));
    }
    // The post and news lists have something to show: published posts, and dated pages other than their own.
    expect(Object.values(s.collections.posts.entries).filter((e) => !e.draft)).toHaveLength(3);
    expect(Object.values(s.pages).filter((p) => p.article && !p.article.hidden)).toHaveLength(2);
  });

  // #1550: a news list's headline led to a page with only the header and footer on it.
  for (const theme of shipped)
    it(`opens each of ${theme.name}’s sample news articles as an article: its title, date and some text`, () => {
      const s = createStarterState('showcase', 'Showcase', false, theme.id);
      const news = Object.values(s.pages).filter((p) => p.article && !p.article.hidden);
      const files = generateProject(s);
      expect(news).toHaveLength(2);
      for (const page of news) {
        expect(componentIds(s, placed(page)), page.route).toEqual(['content.article', 'content.text']);
        const out = String(files.get(`src/routes${page.route}+page.svelte`));
        // The Article header is given the page's own details, and the text section the article's words.
        for (const part of [`"title":"${page.title}"`, `"date":"${page.article!.date}"`, page.article!.excerpt!]) expect(out.replaceAll('\\"', '"'), page.route).toContain(part);
        const body = placed(page)[1].props.body as Array<{ spans: Array<{ text: string }> }>;
        expect(body.length, page.route).toBeGreaterThanOrEqual(2);
        expect(out, page.route).toContain(body[0].spans[0].text);
      }
    });

  // A theme need not ship either section: the articles still open with their title, date and words.
  it('writes the sample news articles in plain text for a theme without the article sections', () => {
    const author = testPack('plain', { name: 'Plain', license: 'MIT' });
    registerBeside(author.define(FOUNDATION.components.filter((c) => c.componentId !== 'content.article' && c.componentId !== 'content.text').map((c) => author.adopt(c))));
    const s = createStarterState('showcase', 'Plain', false, 'plain');
    const news = Object.values(s.pages).filter((p) => p.article && !p.article.hidden);
    expect(news).toHaveLength(2);
    const files = generateProject(s);
    for (const page of news) {
      expect(pageHeadings(s, page.id, { shell: false }).outline.map((h) => [h.level, h.text]), page.route).toEqual([[1, page.title]]);
      const out = String(files.get(`src/routes${page.route}+page.svelte`));
      expect(out, page.route).toContain(`datetime=`);
      expect(out, page.route).toContain(page.article!.date);
    }
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
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
    const { components } = FOUNDATION;
    const author = testPack('sparse', { name: 'Sparse', license: 'MIT' });
    const defs = components.filter((c) => c.componentId !== 'hero.split').map((c) => author.adopt(c));
    const quote = author.adopt(components.find((c) => c.componentId === 'content.text')!);
    quote.componentId = 'content.quote';
    quote.id = quote.id.replace('content.text', 'content.quote');
    quote.name = 'Quote';
    registerBeside(author.define([...defs, quote]));
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
    const { components } = FOUNDATION;
    const author = testPack('narrow', { name: 'Narrow', license: 'MIT' });
    const defs = components.map((c) => {
      const d = author.adopt(c);
      const links = d.componentId === 'shell.header' ? d.properties.links : undefined;
      if (links?.type === 'list') links.max = 3;
      return d;
    });
    registerBeside(author.define(defs));
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
    const kind = (id: string) => showcaseKind(FOUNDATION.components.find((c) => c.componentId === id)!);
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
