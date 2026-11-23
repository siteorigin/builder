/**
 * Page lists (#222): a portfolio index whose cards link to the site's own pages by ID. An empty card field shows
 * the linked page's title, description and sharing image and follows that page's later edits; typed copy on a card
 * stays. Deleting a listed page takes its card out of the list.
 */
import { describe, expect, it } from 'vitest';
import type { AssetRecord, ComponentDefinition, InstanceNode, LinkValue, ListItem, ListProp, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { catalogueComponent, getTheme } from '@catalogue/index';
import { P, managed } from '@catalogue/dsl';
import { applyOperations, pageLinkReferences } from '@engine/apply';
import { pageLinkUses } from '@engine/page-links';
import { normalizePropSchema } from '@engine/schema';
import { contractConflicts } from '@engine/theme-updates';
import { validateState } from '@engine/validate';
import { generateProject, pageFile, resolveInstanceProps } from '@generator/index';
import { unlinkedButtons } from '@generator/checks';
import { effectiveItem, inheritedValue } from '@shared/page-teasers';
import { propJsonSchema } from '@agent/propschema';
import { withStoredFields } from '@agent/macros';
import { describeOps, pagesTouched } from '@agent/report';
import { readField, shownField } from '../../src/renderer/src/lib/held';
import { followsPageAt, shownValue } from '../../src/renderer/src/lib/model';
import { pagesToAdd, teaserFieldNote } from '../../src/renderer/src/lib/page-teasers';
import { planPageRemoval, reviewPageRemoval } from '../../src/renderer/src/lib/page-removal';

const KITCHEN_IMAGE: AssetRecord = { id: 'a_kitchen', name: 'kitchen.jpg', file: 'static/assets/kitchen.jpg', mime: 'image/jpeg', bytes: 1, width: 1200, height: 800, hash: 'x', kind: 'image', altSuggestion: 'An oak kitchen with a long island', createdAt: '' };

const page = (id: string) => ({ kind: 'page' as const, id });

/** The issue's setup: two project pages and a Projects index listing them, the Gardens card with its own copy. */
function portfolio() {
  let s = createStarterState('business', 'Test Studio', false);
  s.assets.assets[KITCHEN_IMAGE.id] = KITCHEN_IMAGE;
  s = applyOperations(s, [
    { type: 'page.create', pageId: 'pg_kitchens', title: 'Kitchens', route: '/projects/kitchens/' },
    { type: 'page.update', pageId: 'pg_kitchens', description: 'Three kitchens built around how families cook.', socialImage: KITCHEN_IMAGE.id },
    { type: 'page.create', pageId: 'pg_gardens', title: 'Gardens', route: '/projects/gardens/' },
    { type: 'page.update', pageId: 'pg_gardens', description: 'Planting plans for small gardens.' },
    { type: 'page.create', pageId: 'pg_projects', title: 'Projects', route: '/projects/' }
  ]).state;
  const r = applyOperations(s, [
    {
      type: 'node.insert',
      owner: page('pg_projects'),
      componentId: 'content.pages',
      props: {
        heading: 'Our projects',
        items: [{ pageLink: { type: 'page', target: 'pg_kitchens' } }, { pageLink: { type: 'page', target: 'pg_gardens' }, title: 'Garden rooms', description: 'Our own words about the gardens.' }]
      }
    }
  ]);
  const nodeId = r.results[0].nodeId as string;
  return { s: r.state, nodeId };
}

const instance = (s: ProjectState, pageId: string, nodeId: string) => s.pages[pageId].nodes[nodeId] as InstanceNode;
const defOf = (s: ProjectState, n: InstanceNode) => s.components[n.definitionId];
const listOf = (s: ProjectState, n: InstanceNode) => defOf(s, n).properties.items as ListProp;
const itemsOf = (s: ProjectState, n: InstanceNode) => n.props.items as ListItem[];
/** The cards as the generated site is given them. */
const cards = (s: ProjectState, nodeId: string) => {
  const n = instance(s, 'pg_projects', nodeId);
  return resolveInstanceProps(defOf(s, n), n, { state: s }).items as Array<{ pageLink: { href: string } | null; title: string; description: string; image: { src: string | null; alt: string } | null }>;
};

describe('page list section', () => {
  it('is found by the words authors search for, before Gallery', () => {
    const def = catalogueComponent('foundation', 'content.pages')!;
    const hay = `${def.name} ${def.description} ${def.tags.join(' ')}`.toLowerCase();
    for (const q of ['portfolio', 'page list', 'case study', 'case studies', 'directory', 'project index']) for (const w of q.split(' ')) expect(hay, q).toContain(w);
    // Equal matches keep the catalogue's order, so "portfolio" offers the page list first.
    const order = getTheme('foundation').components.map((c) => c.componentId);
    expect(order.indexOf('content.pages')).toBeGreaterThan(-1);
    expect(order.indexOf('content.pages')).toBeLessThan(order.indexOf('media.gallery'));
  });

  it('shows each card with its page’s title, description and sharing image, and the custom card with its own copy', () => {
    const { s, nodeId } = portfolio();
    const [kitchens, gardens] = cards(s, nodeId);
    expect(kitchens.pageLink).toEqual({ href: '/projects/kitchens/' });
    expect(kitchens.title).toBe('Kitchens');
    expect(kitchens.description).toBe('Three kitchens built around how families cook.');
    expect(kitchens.image).toMatchObject({ src: '/assets/kitchen.jpg', alt: 'An oak kitchen with a long island' });
    expect(gardens.pageLink).toEqual({ href: '/projects/gardens/' });
    expect(gardens.title).toBe('Garden rooms');
    expect(gardens.description).toBe('Our own words about the gardens.');
    expect(gardens.image?.src ?? null).toBeNull();
    // The stored cards keep only the link and the author's own copy.
    const stored = itemsOf(s, instance(s, 'pg_projects', nodeId));
    expect(stored[0]).toMatchObject({ title: '', description: '' });
    expect(stored[1]).toMatchObject({ title: 'Garden rooms' });
  });

  it('follows a rename and an address change, keeps custom copy, and exports cards that lead to the pages', () => {
    const { s: before, nodeId } = portfolio();
    const s = applyOperations(before, [
      { type: 'page.update', pageId: 'pg_kitchens', title: 'Kitchen renovations' },
      { type: 'page.update', pageId: 'pg_gardens', title: 'Garden design', route: '/work/gardens/' }
    ]).state;
    const [kitchens, gardens] = cards(s, nodeId);
    expect(kitchens).toMatchObject({ pageLink: { href: '/projects/kitchens/' }, title: 'Kitchen renovations' });
    expect(gardens).toMatchObject({ pageLink: { href: '/work/gardens/' }, title: 'Garden rooms', description: 'Our own words about the gardens.' });
    // The exported page carries the cards as they read now, in the author's order.
    const source = generateProject(s, { instrument: false }).get(pageFile(s.pages.pg_projects))!;
    const at = (text: string) => source.indexOf(text);
    for (const text of ['"title":"Kitchen renovations"', '"href":"/projects/kitchens/"', '"title":"Garden rooms"', '"href":"/work/gardens/"', '/assets/kitchen.jpg']) expect(at(text), text).toBeGreaterThan(-1);
    expect(at('"title":"Kitchen renovations"')).toBeLessThan(at('"title":"Garden rooms"'));
    expect(at('"href":"/projects/kitchens/"')).toBeLessThan(at('"href":"/work/gardens/"'));
    expect(source).not.toContain('"title":"Kitchens"');
    expect(source).not.toContain('Garden design');
    // The project still stores page IDs and empty inherited fields.
    expect(itemsOf(s, instance(s, 'pg_projects', nodeId)).map((i) => [(i.pageLink as LinkValue).target, i.title])).toEqual([
      ['pg_kitchens', ''],
      ['pg_gardens', 'Garden rooms']
    ]);
  });

  it('keeps an image chosen for a card over the page’s sharing image', () => {
    const { s: base, nodeId } = portfolio();
    base.assets.assets.a_own = { ...KITCHEN_IMAGE, id: 'a_own', name: 'own.jpg', file: 'static/assets/own.jpg', altSuggestion: undefined };
    const itemId = itemsOf(base, instance(base, 'pg_projects', nodeId))[0].id;
    const s = applyOperations(base, [{ type: 'instance.setProp', owner: page('pg_projects'), nodeId, prop: 'items', itemId, field: 'image', value: { assetId: 'a_own', alt: 'Our own photo' } }]).state;
    expect(cards(s, nodeId)[0].image).toMatchObject({ src: '/assets/own.jpg', alt: 'Our own photo' });
    // Removing it shows the page's image again.
    const back = applyOperations(s, [{ type: 'instance.setProp', owner: page('pg_projects'), nodeId, prop: 'items', itemId, field: 'image', value: { assetId: null, alt: '' } }]).state;
    expect(cards(back, nodeId)[0].image).toMatchObject({ src: '/assets/kitchen.jpg' });
  });

  it('leaves out a card whose page has gone, and a card with nothing to show keeps no empty heading', () => {
    const { s, nodeId } = portfolio();
    const n = instance(s, 'pg_projects', nodeId);
    const broken = structuredClone(s);
    (itemsOf(broken, instance(broken, 'pg_projects', nodeId))[0].pageLink as LinkValue).target = 'pg_gone';
    expect(cards(broken, nodeId)[0]).toMatchObject({ pageLink: null, title: '' });
    // Rendering conditions: the list item needs a link, and the card inside it a title.
    const nodes = defOf(s, n).tree!.nodes;
    expect(nodes['card-item']).toMatchObject({ when: { $item: 'pageLink' }, collapseEmpty: true });
    expect(nodes.card.when).toEqual({ $item: 'title' });
  });

  it('warns about a page image shown without a description, and not once the library gives it one', () => {
    const { s } = portfolio();
    const alt = (st: ProjectState) => validateState(st).filter((d) => d.code === 'ALT_MISSING');
    expect(alt(s)).toEqual([]);
    const bare = structuredClone(s);
    delete bare.assets.assets.a_kitchen.altSuggestion;
    expect(alt(bare).map((d) => d.message)).toEqual([expect.stringContaining('the “Kitchens” card shows its page’s sharing image')]);
    // A card's own image stored without alt text (hand-edited JSON) is the ordinary literal warning, not a crash.
    const own = structuredClone(s);
    const projects = own.pages.pg_projects;
    const n = Object.values(projects.nodes).find((x) => x.kind === 'instance' && own.components[x.definitionId]?.componentId === 'content.pages') as InstanceNode;
    (n.props.items as ListItem[])[0].image = { assetId: KITCHEN_IMAGE.id } as never;
    expect(alt(own)).toHaveLength(1);
  });
});

describe('deleting a listed page', () => {
  it('removes its card from the list instead of pointing it elsewhere, in one undoable step', () => {
    const { s, nodeId } = portfolio();
    expect(pageLinkReferences(s, 'pg_kitchens')).toBe(0);
    const review = reviewPageRemoval(s, 'pg_kitchens', undefined);
    expect(review.uses).toEqual([]);
    expect(review.cards.map((u) => [u.label, u.where])).toEqual([['Kitchens', 'Projects']]);
    const plan = planPageRemoval(s, 'pg_kitchens', undefined, new Map());
    expect(plan.operations).toEqual([{ type: 'page.remove', pageId: 'pg_kitchens' }]);
    const r = applyOperations(s, plan.operations!);
    expect(itemsOf(r.state, instance(r.state, 'pg_projects', nodeId)).map((i) => (i.pageLink as LinkValue).target)).toEqual(['pg_gardens']);
    expect(validateState(r.state).filter((d) => d.code === 'LINK_BROKEN')).toEqual([]);
    expect(itemsOf(s, instance(s, 'pg_projects', nodeId))).toHaveLength(2);
    // The report names the cards that went with it.
    expect(describeOps(plan.operations!, s, r.state, r.results).map((c) => c.label)).toEqual(['Removed page “Kitchens” and its card on “Projects”']);
  });

  it('still points ordinary links at the replacement while the card goes, the custom card included', () => {
    const { s: base, nodeId } = portfolio();
    const header = base.site.shell.header;
    const headerId = header.rootIds[0];
    const s = applyOperations(base, [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: headerId, prop: 'ctaLink', value: { type: 'page', target: 'pg_gardens' } }]).state;
    expect(pageLinkReferences(s, 'pg_gardens')).toBe(1);
    const review = reviewPageRemoval(s, 'pg_gardens', s.site.homePageId);
    expect(review.uses).toHaveLength(1);
    expect(review.cards.map((u) => u.label)).toEqual(['Garden rooms']);
    expect(() => applyOperations(s, [{ type: 'page.remove', pageId: 'pg_gardens' }])).toThrow(/1 link point/);
    const after = applyOperations(s, planPageRemoval(s, 'pg_gardens', s.site.homePageId, new Map()).operations!).state;
    expect(((after.site.shell.header.nodes[headerId] as InstanceNode).props.ctaLink as LinkValue).target).toBe(after.site.homePageId);
    expect(itemsOf(after, instance(after, 'pg_projects', nodeId)).map((i) => (i.pageLink as LinkValue).target)).toEqual(['pg_kitchens']);
  });

  it('needs no replacement for another link to the page inside a card that goes with it', () => {
    const s = createStarterState('business', 'Test Studio', false);
    const def = managed({
      componentId: 'test.cta-cards',
      name: 'CTA cards',
      description: '',
      category: 'custom',
      tags: [],
      icon: 'square',
      properties: { items: P.list('Cards', 'Card', { pageLink: P.link('Page'), title: P.str('Title', ''), cta: P.link('Button link') }, [], { titleField: 'title', pageTeaser: { link: 'pageLink', title: 'title' } }) },
      parts: { root: { nodeId: 'root', label: 'Section' } },
      build: (b) => b.el('root', 'ul', {}, [b.repeat('cards', 'items', [b.el('card', 'li', {}, [b.link('button', { $item: 'cta' }, { $item: 'title' }, 'primary')])])])
    });
    def.id = 'proj.cta-cards';
    def.owner = 'project';
    s.components[def.id] = def;
    const r = applyOperations(s, [{ type: 'page.create', pageId: 'pg_solo', title: 'Solo', route: '/solo/' }]);
    const home = r.state.pages[r.state.site.homePageId];
    home.nodes.n_cta = { id: 'n_cta', kind: 'instance', definitionId: def.id, props: { items: [{ id: 'i_1', pageLink: { type: 'page', target: 'pg_solo' }, title: '', cta: { type: 'page', target: 'pg_solo' } }] } };
    home.rootIds.push('n_cta');
    expect(pageLinkReferences(r.state, 'pg_solo')).toBe(0);
    expect(pageLinkUses(r.state, 'pg_solo').map((u) => !!u.card)).toEqual([true]);
    const after = applyOperations(r.state, [{ type: 'page.remove', pageId: 'pg_solo' }]).state;
    expect((after.pages[after.site.homePageId].nodes.n_cta as InstanceNode).props.items).toEqual([]);
  });

  it('asks where a link goes when the section it jumps to on the replacement page is shown only by the cards that go', () => {
    const s = createStarterState('business', 'Test Studio', false);
    const def = managed({
      componentId: 'test.bare-cards',
      name: 'Bare cards',
      description: '',
      category: 'custom',
      tags: [],
      icon: 'square',
      properties: { items: P.list('Cards', 'Card', { pageLink: P.link('Page'), title: P.str('Title', '') }, [], { titleField: 'title', pageTeaser: { link: 'pageLink', title: 'title' } }) },
      parts: { root: { nodeId: 'root', label: 'Section' } },
      build: (b) => b.el('root', 'ul', { collapseEmpty: true }, [b.repeat('cards', 'items', [b.el('card', 'li', { when: { $item: 'pageLink' } }, [b.link('link', { $item: 'pageLink' }, { $item: 'title' }, 'plain')])])])
    });
    def.id = 'proj.bare-cards';
    def.owner = 'project';
    s.components[def.id] = def;
    const r = applyOperations(s, [{ type: 'page.create', pageId: 'pg_a', title: 'A', route: '/a/' }]).state;
    const home = r.pages[r.site.homePageId];
    home.nodes.n_cards = { id: 'n_cards', kind: 'instance', definitionId: def.id, anchor: 'cards', props: { items: [{ id: 'i_1', pageLink: { type: 'page', target: 'pg_a' }, title: '' }] } };
    home.rootIds.push('n_cards');
    const headerId = r.site.shell.header.rootIds[0];
    const linked = applyOperations(r, [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: headerId, prop: 'ctaLink', value: { type: 'page', target: 'pg_a', anchor: 'cards' } }]).state;
    // Home shows #cards now, but only through A's own card, which leaves with A.
    expect(reviewPageRemoval(linked, 'pg_a', linked.site.homePageId).missing.map((m) => m.fragment)).toEqual(['cards']);
    expect(planPageRemoval(linked, 'pg_a', linked.site.homePageId, new Map([['cards', '#cards']])).operations).toBeNull();
    // A section with no ID yet that only A's card keeps showing is no place to send them either.
    home.nodes.n_more = { id: 'n_more', kind: 'instance', definitionId: def.id, props: { items: [{ id: 'i_2', pageLink: { type: 'page', target: 'pg_a' }, title: 'More from A' }] } };
    home.rootIds.push('n_more');
    const withMore = applyOperations(linked, []).state;
    withMore.pages[withMore.site.homePageId].nodes.n_more = structuredClone(home.nodes.n_more);
    withMore.pages[withMore.site.homePageId].rootIds.push('n_more');
    expect(planPageRemoval(withMore, 'pg_a', withMore.site.homePageId, new Map([['cards', 'node:n_more']])).operations).toBeNull();
    const ops = planPageRemoval(linked, 'pg_a', linked.site.homePageId, new Map([['cards', '']])).operations!;
    const after = applyOperations(linked, ops).state;
    expect((after.site.shell.header.nodes[headerId] as InstanceNode).props.ctaLink).toEqual({ type: 'page', target: after.site.homePageId });
  });

  it('removes a card from a component’s default list too', () => {
    const s = createStarterState('business', 'Test Studio', false);
    const about = s.site.pageOrder.find((id) => s.pages[id].route === '/about/')!;
    const def = structuredClone(catalogueComponent('foundation', 'content.pages')!) as ComponentDefinition;
    def.id = 'proj.pages';
    def.owner = 'project';
    (def.properties.items as ListProp).default = [{ id: 'i_1', pageLink: { type: 'page', target: about }, title: '', description: '', image: { assetId: null, alt: '' } }];
    s.components[def.id] = def;
    expect(pageLinkUses(s, about).filter((u) => u.card).map((u) => [u.label, u.where])).toEqual([['About', 'Page list (default)']]);
    const after = applyOperations(s, [{ type: 'page.remove', pageId: about, replacementPageId: s.site.homePageId }]).state;
    expect((after.components[def.id].properties.items as ListProp).default).toEqual([]);
  });
});

describe('page list schema', () => {
  const fields = { pageLink: P.link('Page'), title: P.str('Title', ''), note: P.text('Note', ''), photo: P.image('Photo') };
  const s = createStarterState('business', 'T', false);
  it('accepts a mapping of distinct fields of the right types, and refuses anything else', () => {
    const ok = normalizePropSchema({ type: 'list', label: 'Cards', fields, pageTeaser: { link: 'pageLink', title: 'title', description: 'note', image: 'photo' } }, s, 'cards') as ListProp;
    expect(ok.pageTeaser).toEqual({ link: 'pageLink', title: 'title', description: 'note', image: 'photo' });
    const bad = (pageTeaser: unknown, extra: Record<string, unknown> = {}) => () => normalizePropSchema({ type: 'list', label: 'Cards', fields, pageTeaser, ...extra }, s, 'cards');
    expect(bad({ link: 'title', title: 'title' })).toThrow(/must be a link field/);
    expect(bad({ link: 'pageLink', title: 'photo' })).toThrow(/must be a string field/);
    expect(bad({ link: 'pageLink', title: 'nope' })).toThrow(/is not one of its fields/);
    expect(bad({ link: 'pageLink', title: 'title', description: 'title' })).toThrow(/more than once/);
    expect(bad({ link: 'pageLink', title: 'title' }, { min: 1 })).toThrow(/cannot have a minimum/);
  });

  it('counts a changed mapping as a different contract when switching themes', () => {
    const def = catalogueComponent('foundation', 'content.pages')!;
    const next = structuredClone(def);
    delete (next.properties.items as ListProp).pageTeaser!.image;
    expect(contractConflicts(s, def, def)).toEqual([]);
    expect(contractConflicts(s, def, next)).toEqual(['Page list: "items" fills different fields from its pages.']);
  });

  it('tells the AI which fields to leave empty, and never matches a new card to an old one by title', () => {
    const def = catalogueComponent('foundation', 'content.pages')!;
    const schema = def.properties.items as ListProp;
    const json = propJsonSchema(schema) as { items: { properties: Record<string, { description: string }> } };
    expect(json.items.properties.title.description).toMatch(/Leave empty \(""\) to show the linked page's title/);
    expect(json.items.properties.image.description).toMatch(/Leave assetId null to show the linked page's sharing image/);
    const stored = [{ id: 'i_a', pageLink: { type: 'page', target: 'pg_a' }, title: 'Featured', description: 'Built in oak' }];
    const merged = withStoredFields(schema, [{ pageLink: { type: 'page', target: 'pg_b' }, title: 'Featured' }], stored);
    expect(merged.ids).toEqual([undefined]);
    expect(merged.items[0]).not.toHaveProperty('description');
    // Sent without its page or id, a card is the one with that title, and keeps its page.
    const kept = withStoredFields(schema, [{ title: 'Featured', description: 'Updated copy' }], stored);
    expect(kept.ids).toEqual(['i_a']);
    expect(kept.items[0]).toMatchObject({ pageLink: { type: 'page', target: 'pg_a' }, description: 'Updated copy' });
    // A card that shows its page's title is known by that title, and sending it back unchanged keeps it following the page.
    const inherited = [{ id: 'i_b', pageLink: { type: 'page', target: 'pg_b' }, title: '', description: '' }];
    const showsAbout = (it: ListItem) => ({ ...it, title: 'About' });
    const echoed = withStoredFields(schema, [{ title: 'About', description: 'Revised' }], inherited, showsAbout);
    expect(echoed.ids).toEqual(['i_b']);
    expect(echoed.items[0]).toEqual({ id: 'i_b', pageLink: { type: 'page', target: 'pg_b' }, title: '', description: 'Revised' });
    // Sent back with what the page shows, the image keeps following the page too.
    const withImage = [{ id: 'i_c', pageLink: { type: 'page', target: 'pg_c' }, title: '', image: { assetId: null, alt: '' } }];
    const showsImage = (it: ListItem) => ({ ...it, title: 'C', image: { assetId: 'a_c', alt: 'A photo' } });
    expect(withStoredFields(schema, [{ id: 'i_c', image: { assetId: 'a_c', alt: 'A photo' } }], withImage, showsImage).items[0]).toMatchObject({ image: { assetId: null } });
    // Pointed somewhere else, the card keeps the title it was sent, even one that was its old page's.
    const moved = withStoredFields(schema, [{ id: 'i_b', pageLink: { type: 'url', target: 'https://partner.example/' }, title: 'About' }], inherited, showsAbout);
    expect(moved.items[0]).toMatchObject({ pageLink: { type: 'url' }, title: 'About' });
    // A page's ID sent as it is names the same page.
    expect(withStoredFields(schema, [{ id: 'i_b', pageLink: 'pg_b', title: 'About' }], inherited, showsAbout).items[0]).toMatchObject({ title: '' });
    // A card an id moved to a page leaves that page's own card to be found by its page.
    const two = [
      { id: 'i_about', pageLink: { type: 'page', target: 'pg_about' }, title: '', description: 'Our story, told our way' },
      { id: 'i_work', pageLink: { type: 'page', target: 'pg_work' }, title: '', description: '' }
    ];
    const swapped = withStoredFields(schema, [{ id: 'i_work', pageLink: { type: 'page', target: 'pg_about' } }, { pageLink: { type: 'page', target: 'pg_about' } }], two);
    expect(swapped.ids).toEqual(['i_work', 'i_about']);
    expect(swapped.items[1]).toMatchObject({ description: 'Our story, told our way' });
    // An id names its card before anything else does.
    expect(withStoredFields(schema, [{ id: 'i_a', pageLink: { type: 'page', target: 'pg_b' } }], stored).ids).toEqual(['i_a']);
    // Sent for the same page without its id, it is that card too, whatever its title.
    const same = withStoredFields(schema, [{ pageLink: { type: 'page', target: 'pg_a' }, description: 'Again' }], stored);
    expect(same.ids).toEqual(['i_a']);
    expect(same.items[0]).toMatchObject({ title: 'Featured', description: 'Again' });
  });
});

describe('editing page list cards', () => {
  it('says where an empty field’s text comes from, and how to go back to it', () => {
    const { s, nodeId } = portfolio();
    const n = instance(s, 'pg_projects', nodeId);
    const [kitchens, gardens] = itemsOf(s, n);
    const schema = listOf(s, n);
    expect(teaserFieldNote(s, schema, kitchens, 'title')).toEqual({ placeholder: 'Kitchens', hint: 'From Kitchens, and follows it. Type to show different text on this card.' });
    expect(teaserFieldNote(s, schema, gardens, 'title')?.hint).toBe('Typed for this card. Clear it to show the page’s title, “Gardens”.');
    expect(teaserFieldNote(s, schema, kitchens, 'image')?.hint).toBe('Shows Kitchens’s sharing image (kitchen.jpg). Choose an image to show a different one on this card.');
    expect(teaserFieldNote(s, schema, gardens, 'image')?.hint).toBe('Gardens has no sharing image. Set one in its page settings, or choose an image for this card.');
    expect(teaserFieldNote(s, schema, kitchens, 'pageLink')?.hint).toMatch(/follows this page/);
    expect(teaserFieldNote(s, { ...schema, pageTeaser: undefined }, kitchens, 'title')).toBeUndefined();
    // Every page not yet listed can be added, except the page the list is on.
    expect(pagesToAdd(s, schema, itemsOf(s, n), 'pg_projects').map((id) => s.pages[id].title)).toEqual(['Home', 'About', 'Contact']);
  });

  it('compares an inline edit of a card’s title with the title it shows, so leaving it as it was writes nothing', () => {
    const { s, nodeId } = portfolio();
    const n = instance(s, 'pg_projects', nodeId);
    const [kitchens, gardens] = itemsOf(s, n);
    const title = defOf(s, n).tree!.nodes['card-title'] as { label: unknown };
    const ref = (itemId: string) => ({ owner: page('pg_projects'), instancePath: [nodeId], nodeId: 'card-title', itemPath: [itemId] });
    expect(shownValue(s, ref(kitchens.id), title.label)).toBe('Kitchens');
    expect(shownValue(s, ref(gardens.id), title.label)).toBe('Garden rooms');
    // Erasing the page's title has nothing to clear: the canvas is told to put it back.
    expect(followsPageAt(s, ref(kitchens.id), title.label)).toBe(true);
    expect(followsPageAt(s, ref(gardens.id), title.label)).toBe(false);
  });

  it('adds a card for a chosen page that shows that page straight away', () => {
    const { s, nodeId } = portfolio();
    const about = s.site.pageOrder.find((id) => s.pages[id].route === '/about/')!;
    const r = applyOperations(s, [{ type: 'instance.listInsert', owner: page('pg_projects'), nodeId, prop: 'items', item: { pageLink: { type: 'page', target: about } } }]);
    expect(cards(r.state, nodeId)[2]).toMatchObject({ title: 'About', pageLink: { href: '/about/' } });
  });

  const renamedTitle = (s: ProjectState) => applyOperations(s, [{ type: 'page.update', pageId: 'pg_kitchens', title: 'Kitchen renovations' }]).state;

  it('holds a card edit made while the AI runs against the page the card showed', () => {
    const { s, nodeId } = portfolio();
    const op = { type: 'instance.setProp' as const, owner: page('pg_projects'), nodeId, prop: 'items', itemId: itemsOf(s, instance(s, 'pg_projects', nodeId))[0].id, field: 'title', value: 'Roof gardens' };
    const was = readField(s, op);
    // The AI pointed the card at another page: the raw title is still empty, but the card read differently.
    const moved = structuredClone(s);
    moved.pages.pg_gardens.title = 'Kitchens';
    moved.pages.pg_gardens.seo.description = moved.pages.pg_kitchens.seo.description;
    (itemsOf(moved, instance(moved, 'pg_projects', nodeId))[0].pageLink as LinkValue).target = 'pg_gardens';
    expect(JSON.stringify(readField(moved, op))).not.toBe(JSON.stringify(was));
    // The conflict prompt names the title the card showed, not its empty stored field.
    expect(shownField(op, (readField(renamedTitle(s), op) as { value: unknown }).value)).toBe('Kitchen renovations');
    // A rename of the same page changes what the card showed, too.
    const renamed = renamedTitle(s);
    expect(JSON.stringify(readField(renamed, op))).not.toBe(JSON.stringify(was));
    expect(JSON.stringify(readField(structuredClone(s), op))).toBe(JSON.stringify(was));
  });

  it('marks AI inspections of every page stale when a page a list shows changes', () => {
    expect(pagesTouched([{ type: 'page.update', pageId: 'pg_a', title: 'New' }])).toBe('all');
    expect(pagesTouched([{ type: 'page.update', pageId: 'pg_a', socialImage: null }])).toBe('all');
    expect(pagesTouched([{ type: 'page.update', pageId: 'pg_a', description: 'New words' }])).toBe('all');
    expect(pagesTouched([{ type: 'page.update', pageId: 'pg_a', noindex: true }])).toEqual(new Set(['pg_a']));
  });
});

describe('checks read cards as they show', () => {
  /** A project component whose cards show a button labelled with the card's (inherited) title. */
  function buttonCards() {
    const def = managed({
      componentId: 'test.cards',
      name: 'Cards',
      description: '',
      category: 'custom',
      tags: [],
      icon: 'square',
      properties: {
        items: P.list('Cards', 'Card', { page: P.link('Page'), title: P.str('Title', ''), cta: P.link('Button link') }, [], { titleField: 'title', pageTeaser: { link: 'page', title: 'title' } })
      },
      parts: { root: { nodeId: 'root', label: 'Section' } },
      build: (b) => b.el('root', 'ul', {}, [b.repeat('cards', 'items', [b.el('card', 'li', {}, [b.link('button', { $item: 'cta' }, { $item: 'title' }, 'primary', { when: { $item: 'title' } })])])])
    });
    def.id = 'proj.cards';
    def.owner = 'project';
    const s = createStarterState('business', 'T', false);
    s.components[def.id] = def;
    const home = s.pages[s.site.homePageId];
    const about = s.site.pageOrder.find((id) => s.pages[id].route === '/about/')!;
    const node: InstanceNode = { id: 'n_cards', kind: 'instance', definitionId: def.id, props: { items: [{ id: 'i_1', page: { type: 'page', target: about }, title: '', cta: { type: 'none', target: '' } }] } };
    home.nodes[node.id] = node;
    home.rootIds.push(node.id);
    return { s, home };
  }

  it('reports a button whose label comes from the page, and offers no Hide that clearing the label cannot do', () => {
    const { s, home } = buttonCards();
    const found = unlinkedButtons(s, home).filter((b) => b.nodeId === 'n_cards');
    expect(found.map((b) => b.label)).toEqual(['About']);
    expect(found[0].hide).toBeUndefined();
    expect(found[0].link).toEqual({ prop: 'items', itemId: 'i_1', field: 'cta' });
  });

  it('reads a list forwarded from an outer design as that design gives it, not by the inner list’s own mapping', () => {
    const { s, home } = buttonCards();
    const inner = s.components['proj.cards'];
    // An outer design whose own (unmapped) list is handed to the cards: nothing in it is filled from a page.
    const outer = managed({
      componentId: 'test.outer',
      name: 'Outer',
      description: '',
      category: 'custom',
      tags: [],
      icon: 'square',
      properties: { rows: P.list('Rows', 'Row', { page: P.link('Page'), title: P.str('Title', ''), cta: P.link('Button link') }, [], { titleField: 'title' }) },
      parts: { root: { nodeId: 'root', label: 'Section' } },
      build: (b) => b.el('root', 'div', {}, [])
    });
    outer.id = 'proj.outer';
    outer.owner = 'project';
    outer.tree!.nodes.inner = { id: 'inner', kind: 'instance', definitionId: inner.id, props: { items: { $prop: 'rows' } } };
    (outer.tree!.nodes.root as { children: string[] }).children.push('inner');
    s.components[outer.id] = outer;
    const about = s.site.pageOrder.find((id) => s.pages[id].route === '/about/')!;
    home.nodes.n_outer = { id: 'n_outer', kind: 'instance', definitionId: outer.id, props: { rows: [{ id: 'i_1', page: { type: 'page', target: about }, title: '', cta: { type: 'none', target: '' } }] } };
    home.rootIds.push('n_outer');
    // The generator hands the outer rows over as they are: the title stays empty, so no button renders.
    const resolved = resolveInstanceProps(outer, home.nodes.n_outer as InstanceNode, { state: s }).rows as Array<{ title: string }>;
    expect(resolved[0].title).toBe('');
    expect(unlinkedButtons(s, home).filter((b) => b.nodeId === 'n_outer')).toEqual([]);
  });

  it('reads an item as it shows only while its link is to a page the site has', () => {
    const { s } = buttonCards();
    const schema = s.components['proj.cards'].properties.items as ListProp;
    const item = { id: 'i', page: { type: 'url', target: 'https://example.com' }, title: '' };
    expect(effectiveItem(s, schema, item)).toBe(item);
    expect(inheritedValue(s, schema, item, 'title')).toBeUndefined();
  });
});
