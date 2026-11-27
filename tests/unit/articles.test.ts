/**
 * Dated articles (#249): a page can be an article with a publication date, byline and excerpt, and a News list
 * shows the site's articles newest first, worked out from the pages each time the site is generated. Adding,
 * backdating, renaming, hiding or deleting an article changes every News list without touching the list itself.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentDefinition, InstanceNode, ListProp, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { catalogueComponent } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import { normalizePropSchema } from '@engine/schema';
import { contractConflicts } from '@engine/theme-updates';
import { validateState } from '@engine/validate';
import { defFile, generateProject, pageFile, resolveInstanceProps } from '@generator/index';
import { P, item as dslItem, prop } from '@catalogue/dsl';
import { projectDesign } from './fixtures/packs';
import { headingOutline, renderedContent } from '@generator/checks';
import { UTIL_JS } from '@generator/runtime-files';
import { headerMenu } from '@engine/tree';
import { pageText } from '@generator/search';
import { articleRows, formatArticleDate, isArticleDate, listedArticles, todayArticleDate } from '@shared/articles';
import { compactPropsSchema, propsJsonSchema } from '@agent/propschema';
import { selectionTools } from '@agent/selection';
import { describeSelection } from '@agent/context';
import { repeatedPartList } from '@shared/item-styles';
import { isArticleHeader } from '@agent/macros';
import { describeOps, pagesTouched } from '@agent/report';
import { readField } from '../../src/renderer/src/lib/held';
import { computedAt, shownValue } from '../../src/renderer/src/lib/model';

const page = (id: string) => ({ kind: 'page' as const, id });

/** The issue's market site: the later announcement added first, then the earlier one, and a News list on Home. */
function market() {
  let s = createStarterState('business', 'Riverside Market', false);
  s.site.language = 'en-GB';
  s = applyOperations(s, [
    { type: 'page.create', pageId: 'pg_spring', title: 'Spring makers announced', starter: 'article', articleDate: '2027-03-02', byline: 'Market team', excerpt: 'Twenty new stallholders join in March.' },
    { type: 'page.create', pageId: 'pg_winter', title: 'Winter opening hours', starter: 'article', articleDate: '2026-11-14', excerpt: 'Shorter days from December.' }
  ]).state;
  const home = s.site.homePageId;
  const r = applyOperations(s, [{ type: 'node.insert', owner: page(home), componentId: 'content.news', props: { heading: 'Market news' } }]);
  return { s: r.state, home, nodeId: r.results[0].nodeId as string };
}

const instance = (s: ProjectState, pageId: string, nodeId: string) => s.pages[pageId].nodes[nodeId] as InstanceNode;
/** The News list's definition, as the project has it. */
const newsDef = (s: ProjectState) => Object.values(s.components).find((d) => d.componentId === 'content.news')!;
const defOf = (s: ProjectState, n: InstanceNode) => s.components[n.definitionId];

/** The News list's cards as the export resolves them on that page. */
function cards(s: ProjectState, pageId: string, nodeId: string) {
  const n = instance(s, pageId, nodeId);
  return resolveInstanceProps(defOf(s, n), n, { state: s, pageId }).items as Array<Record<string, unknown>>;
}

/** Each card's `<time datetime>` and title, in the order the generated Home page writes them. */
function homeSource(s: ProjectState, home: string) {
  return generateProject(s).get(pageFile(s.pages[home]))!;
}

describe('dated articles', () => {
  it('lists articles newest first, whatever order they were added in', () => {
    const { s: two, home, nodeId } = market();
    expect(cards(two, home, nodeId).map((c) => c.title)).toEqual(['Spring makers announced', 'Winter opening hours']);
    // A third, added last and first by page ID, still takes its place by date.
    const s = applyOperations(two, [{ type: 'page.create', pageId: 'pg_autumn', title: 'Autumn harvest fair', starter: 'article', articleDate: '2027-01-10' }]).state;
    expect(cards(s, home, nodeId).map((c) => c.id)).toEqual(['pg_spring', 'pg_autumn', 'pg_winter']);
    const [spring, winter] = cards(two, home, nodeId);
    expect(spring).toMatchObject({ id: 'pg_spring', date: '2027-03-02', dateLabel: '2 March 2027', byline: 'Market team', excerpt: 'Twenty new stallholders join in March.', pageLink: { href: two.pages.pg_spring.route } });
    expect(winter).toMatchObject({ id: 'pg_winter', date: '2026-11-14', dateLabel: '14 November 2026', byline: '' });
    // The list itself stores no items: it is filled where it is placed.
    expect(instance(two, home, nodeId).props).not.toHaveProperty('items');
  });

  it('reorders when an article is backdated or redated, without changing the page the list is on', () => {
    const { s, home, nodeId } = market();
    const before = structuredClone(s.pages[home]);
    const redated = applyOperations(s, [{ type: 'page.update', pageId: 'pg_winter', articleDate: '2027-04-01' }]).state;
    expect(cards(redated, home, nodeId).map((c) => [c.title, c.date])).toEqual([
      ['Winter opening hours', '2027-04-01'],
      ['Spring makers announced', '2027-03-02']
    ]);
    expect(redated.pages[home]).toEqual(before);
    // Redating changes the date alone.
    expect(redated.pages.pg_winter.article).toEqual({ date: '2027-04-01', excerpt: 'Shorter days from December.' });
    const backdated = applyOperations(redated, [{ type: 'page.update', pageId: 'pg_winter', articleDate: '2020-01-05' }]).state;
    expect(cards(backdated, home, nodeId).map((c) => c.id)).toEqual(['pg_spring', 'pg_winter']);
  });

  it('writes each date as a time element in the exported page, in date order, and follows a redating', () => {
    const { s, home } = market();
    const order = (src: string) => [...src.matchAll(/"title":"([^"]+)","date":"/g)].map((m) => m[1]);
    const src = homeSource(s, home);
    expect(order(src)).toEqual(['Spring makers announced', 'Winter opening hours']);
    expect(src).toContain('"date":"2026-11-14","dateLabel":"14 November 2026"');
    const component = generateProject(s).get(defFile(newsDef(s)))!;
    expect(component).toMatch(/<time datetime=\{item\.date\}>\{item\.dateLabel\}<\/time>/);
    const later = applyOperations(s, [{ type: 'page.update', pageId: 'pg_winter', articleDate: '2027-04-01' }]).state;
    const after = homeSource(later, home);
    expect(order(after)).toEqual(['Winter opening hours', 'Spring makers announced']);
    expect(after).toContain('"date":"2027-04-01","dateLabel":"1 April 2027"');
    expect(after).not.toContain('2026-11-14');
  });

  it('follows a rename and an address change, and leaves out an article hidden from news lists until it is shown again', () => {
    const { s, home, nodeId } = market();
    const renamed = applyOperations(s, [{ type: 'page.update', pageId: 'pg_winter', title: 'Winter hours from December', route: '/news/winter-hours/' }]).state;
    expect(cards(renamed, home, nodeId)[1]).toMatchObject({ title: 'Winter hours from December', pageLink: { href: '/news/winter-hours/' } });
    const hidden = applyOperations(renamed, [{ type: 'page.update', pageId: 'pg_spring', newsHidden: true }]).state;
    expect(cards(hidden, home, nodeId).map((c) => c.id)).toEqual(['pg_winter']);
    // The hidden article stays published, with its own header.
    expect(hidden.pages.pg_spring.draft).toBeUndefined();
    expect(hidden.pages.pg_spring.article).toMatchObject({ date: '2027-03-02', hidden: true });
    expect(articleRows(hidden, 'currentPage', 'pg_spring')).toEqual([expect.objectContaining({ title: 'Spring makers announced', date: '2027-03-02', byline: 'Market team' })]);
    const shown = applyOperations(hidden, [{ type: 'page.update', pageId: 'pg_spring', newsHidden: false }]).state;
    expect(cards(shown, home, nodeId).map((c) => c.id)).toEqual(['pg_spring', 'pg_winter']);
    expect(shown.pages.pg_spring.article).toEqual({ date: '2027-03-02', byline: 'Market team', excerpt: 'Twenty new stallholders join in March.' });
    expect(shown.pages.pg_spring.article).not.toHaveProperty('hidden');
  });

  it('includes a new article automatically, leaves out drafts and the page the list is on, and drops a deleted one', () => {
    const { s, home, nodeId } = market();
    const added = applyOperations(s, [{ type: 'page.create', pageId: 'pg_summer', title: 'Summer late openings', starter: 'article', articleDate: '2027-06-01' }]).state;
    expect(cards(added, home, nodeId).map((c) => c.id)).toEqual(['pg_summer', 'pg_spring', 'pg_winter']);
    const draft = applyOperations(added, [{ type: 'page.update', pageId: 'pg_summer', draft: true }]).state;
    expect(cards(draft, home, nodeId).map((c) => c.id)).toEqual(['pg_spring', 'pg_winter']);
    // A News list on an article never lists that article.
    const onArticle = applyOperations(added, [{ type: 'node.insert', owner: page('pg_spring'), componentId: 'content.news' }]);
    expect(cards(onArticle.state, 'pg_spring', onArticle.results[0].nodeId as string).map((c) => c.id)).toEqual(['pg_summer', 'pg_winter']);
    const removed = applyOperations(added, [{ type: 'page.remove', pageId: 'pg_spring' }]).state;
    expect(cards(removed, home, nodeId).map((c) => c.id)).toEqual(['pg_summer', 'pg_winter']);
    // The Home page is never a draft, whatever its document says: as an article it stays listed elsewhere.
    const homeArticle = applyOperations(added, [{ type: 'page.update', pageId: home, articleDate: '2027-07-01' }]);
    homeArticle.state.pages[home].draft = true;
    const placed = applyOperations(homeArticle.state, [{ type: 'node.insert', owner: page('pg_winter'), componentId: 'content.news' }]);
    expect(cards(placed.state, 'pg_winter', placed.results[0].nodeId as string).map((c) => c.id)[0]).toBe(home);
  });

  it('orders articles of the same day by page, so a rename or page reorder never swaps them', () => {
    const { s, home, nodeId } = market();
    const same = applyOperations(s, [{ type: 'page.update', pageId: 'pg_winter', articleDate: '2027-03-02' }]).state;
    const first = cards(same, home, nodeId).map((c) => c.id);
    expect(first).toEqual(['pg_spring', 'pg_winter']);
    const moved = applyOperations(same, [
      { type: 'page.update', pageId: 'pg_spring', title: 'Zebra makers' },
      { type: 'page.reorder', pageIds: [...same.site.pageOrder].reverse() }
    ]).state;
    expect(cards(moved, home, nodeId).map((c) => c.id)).toEqual(first);
    // One added later on the same day, but first by page ID, comes first: insertion order does not decide.
    const later = applyOperations(moved, [{ type: 'page.create', pageId: 'pg_aaaa', title: 'Also today', articleDate: '2027-03-02' }]).state;
    expect(cards(later, home, nodeId).map((c) => c.id)).toEqual(['pg_aaaa', 'pg_spring', 'pg_winter']);
  });

  it('creates an article with a header and an editable body, dated today unless told otherwise', () => {
    const s = applyOperations(createStarterState('business', 'Riverside Market', false), [{ type: 'page.create', pageId: 'pg_newone', title: 'Opening day', starter: 'article' }]).state;
    const p = s.pages.pg_newone;
    expect(p.article).toEqual({ date: todayArticleDate() });
    expect(p.rootIds.map((id) => s.components[(p.nodes[id] as InstanceNode).definitionId].componentId)).toEqual(['content.article', 'content.text']);
    const header = p.nodes[p.rootIds[0]] as InstanceNode;
    expect(header.props).not.toHaveProperty('article');
    const row = resolveInstanceProps(defOf(s, header), header, { state: s, pageId: 'pg_newone' }).article as Array<Record<string, unknown>>;
    // The page shows its date under its title.
    expect(pageText(s, p).split('\n').slice(0, 2)).toEqual(['Opening day', formatArticleDate(todayArticleDate(), s.site.language)]);
    expect(row).toEqual([expect.objectContaining({ id: 'pg_newone', title: 'Opening day', date: todayArticleDate() })]);
    // The body is an ordinary text section, edited like any other.
    const body = p.nodes[p.rootIds[1]] as InstanceNode;
    expect(pageText(s, p)).toContain('Write the article here.');
    expect(applyOperations(s, [{ type: 'instance.setProp', owner: page('pg_newone'), nodeId: body.id, prop: 'body', value: 'Doors open at nine.' }]).state.pages.pg_newone.nodes[body.id]).toMatchObject({ props: { body: [{ type: 'p', spans: [{ text: 'Doors open at nine.' }] }] } });
  });

  it('makes an ordinary page an article, edits its details, and turns it back', () => {
    let s = createStarterState('business', 'Riverside Market', false);
    s = applyOperations(s, [{ type: 'page.create', pageId: 'pg_oldpage', title: 'Winter opening hours', starter: 'intro' }]).state;
    expect(() => applyOperations(s, [{ type: 'page.update', pageId: 'pg_oldpage', byline: 'Ana' }])).toThrow(/not an article/);
    const authored = structuredClone(s.pages.pg_oldpage.nodes);
    const roots = [...s.pages.pg_oldpage.rootIds];
    s = applyOperations(s, [{ type: 'page.update', pageId: 'pg_oldpage', articleDate: '2026-11-14', byline: '  Ana Ruiz ', excerpt: 'Shorter days.' }]).state;
    expect(s.pages.pg_oldpage.article).toEqual({ date: '2026-11-14', byline: 'Ana Ruiz', excerpt: 'Shorter days.' });
    // Its authored introduction is left as it was.
    expect(s.pages.pg_oldpage.nodes).toEqual(authored);
    expect(s.pages.pg_oldpage.rootIds).toEqual(roots);
    s = applyOperations(s, [{ type: 'page.update', pageId: 'pg_oldpage', byline: '' }]).state;
    expect(s.pages.pg_oldpage.article).toEqual({ date: '2026-11-14', excerpt: 'Shorter days.' });
    expect(() => applyOperations(s, [{ type: 'page.update', pageId: 'pg_oldpage', article: false, excerpt: 'x' }])).toThrow(/same change/);
    expect(() => applyOperations(s, [{ type: 'page.update', pageId: 'pg_oldpage', article: false, newsHidden: true }])).toThrow(/same change/);
    s = applyOperations(s, [{ type: 'page.update', pageId: 'pg_oldpage', article: false }]).state;
    expect(s.pages.pg_oldpage).not.toHaveProperty('article');
    expect(listedArticles(s)).toEqual([]);
  });

  it('refuses a date that is not a calendar day, leaving the batch unapplied', () => {
    const { s } = market();
    for (const bad of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '0000-01-01'])
      expect(() => applyOperations(s, [{ type: 'page.update', pageId: 'pg_winter', title: 'Changed' }, { type: 'page.update', pageId: 'pg_winter', articleDate: bad }]), bad).toThrow(/not a calendar date/);
    expect(s.pages.pg_winter.title).toBe('Winter opening hours');
    expect(() => applyOperations(s, [{ type: 'page.create', title: 'Bad date', starter: 'article', articleDate: '2026-02-30' }])).toThrow(/not a calendar date/);
    expect(isArticleDate('2024-02-29')).toBe(true);
    expect(isArticleDate('2000-02-29')).toBe(true);
    expect(isArticleDate('0004-02-29')).toBe(true);
    expect(isArticleDate('0001-02-29')).toBe(false);
    expect(isArticleDate('2026-2-3')).toBe(false);
    expect(isArticleDate('')).toBe(false);
  });

  it('keeps a duplicated article an article of its own', () => {
    const { s, home, nodeId } = market();
    const r = applyOperations(s, [{ type: 'page.duplicate', pageId: 'pg_winter', title: 'Winter opening hours (Saturdays)' }]);
    const copy = r.results[0].pageId as string;
    expect(r.state.pages[copy].article).toEqual(s.pages.pg_winter.article);
    expect(cards(r.state, home, nodeId).map((c) => c.id)).toContain(copy);
    // Each keeps its own details: redating the copy leaves the original as it was.
    const redated = applyOperations(r.state, [{ type: 'page.update', pageId: copy, articleDate: '2026-12-01', byline: 'Copy desk' }]).state;
    expect(redated.pages.pg_winter.article).toEqual({ date: '2026-11-14', excerpt: 'Shorter days from December.' });
    // A copy of an article hidden from news lists stays hidden.
    const hidden = applyOperations(s, [{ type: 'page.update', pageId: 'pg_winter', newsHidden: true }, { type: 'page.duplicate', pageId: 'pg_winter' }]);
    expect(hidden.state.pages[hidden.results[1].pageId as string].article!.hidden).toBe(true);
  });

  it('refuses edits to the computed items, which come from the article pages', () => {
    const { s, home, nodeId } = market();
    const owner = page(home);
    expect(() => applyOperations(s, [{ type: 'instance.setProp', owner, nodeId, prop: 'items', value: [{ title: 'Typed' }] }])).toThrow(/fills itself/);
    expect(() => applyOperations(s, [{ type: 'instance.setProp', owner, nodeId, prop: 'items', itemId: 'pg_winter', field: 'title', value: 'Typed' }])).toThrow(/page settings/);
    expect(() => applyOperations(s, [{ type: 'instance.listInsert', owner, nodeId, prop: 'items', item: { title: 'Typed' } }])).toThrow(/page settings/);
    expect(() => applyOperations(s, [{ type: 'instance.listMove', owner, nodeId, prop: 'items', itemId: 'pg_winter', index: 0 }])).toThrow(/page settings/);
    expect(() => applyOperations(s, [{ type: 'instance.listRemove', owner, nodeId, prop: 'items', itemId: 'pg_winter' }])).toThrow(/page settings/);
    expect(() => applyOperations(s, [{ type: 'node.insert', owner, componentId: 'content.news', props: { items: [{ title: 'Typed' }] } }])).toThrow(/fills itself/);
    // An empty list is what it stores anyway.
    expect(() => applyOperations(s, [{ type: 'instance.setProp', owner, nodeId, prop: 'items', value: [] }])).not.toThrow();
  });

  it('styles a News card for every article together, never one article on its own', () => {
    const { s, home, nodeId } = market();
    const def = defOf(s, instance(s, home, nodeId));
    // Its rows are pages worked out where it is placed, so no card is offered to the editor or the AI as an item to style.
    expect(repeatedPartList(def, 'card')).toBeUndefined();
    const selected = describeSelection(s, { owner: page(home), nodeId: 'card', instancePath: [nodeId], partId: 'card', itemPath: ['pg_winter'] });
    expect(selected).not.toHaveProperty('styleReach');
    expect(String(selected?.note)).not.toMatch(/itemId to style one item/);
    expect(() => applyOperations(s, [{ type: 'node.setStyle', owner: page(home), nodeId, partId: 'card', itemId: 'pg_winter', scope: 'base', property: 'background', value: '#fff5cc' }])).toThrow(/not shown once per list item/);
    // The shared card style still applies to every article.
    const styled = applyOperations(s, [{ type: 'node.setStyle', owner: page(home), nodeId, partId: 'card', scope: 'base', property: 'background', value: '#fff5cc' }]).state;
    expect(instance(styled, home, nodeId).overrides?.card?.base?.background).toBe('#fff5cc');
    expect(homeSource(styled, home)).not.toContain('so_oi');
  });

  it('tells the checks and search what the visitor sees, without offering the computed words as fields to edit', () => {
    const { s, home } = market();
    const content = renderedContent(s, s.pages[home]).filter((c) => c.kind === 'text' && (c.value === 'Winter opening hours' || c.value === '14 November 2026'));
    expect(content).toHaveLength(2);
    for (const c of content) {
      expect(c.computed).toBe(true);
      expect(c.source).toBeUndefined();
    }
    // The section's own heading is the placement's field, not a page's.
    const heading = renderedContent(s, s.pages[home]).find((c) => c.value === 'Market news')!;
    expect(heading.computed).toBeUndefined();
    expect(heading.source).toMatchObject({ kind: 'prop', prop: 'heading' });
    expect(pageText(s, s.pages[home])).toContain('Spring makers announced');
    expect(pageText(s, s.pages[home])).toContain('Twenty new stallholders join in March.');
    // The article's own page shows its title as its one Heading 1.
    expect(headingOutline(s, 'pg_winter').filter((h) => h.level === 1).map((h) => h.text)).toEqual(['Winter opening hours']);
    expect(pageText(s, s.pages.pg_winter).split('\n').slice(0, 3)).toEqual(['Winter opening hours', '14 November 2026', 'Shorter days from December.']);
  });

  it('marks an article page as an article for sharing, with its date', () => {
    const { s } = market();
    const src = generateProject(s).get(pageFile(s.pages.pg_winter))!;
    expect(src).toContain('<meta property="og:type" content="article" />');
    expect(src).toContain('<meta property="article:published_time" content={"2026-11-14"} />');
    const home = generateProject(s).get(pageFile(s.pages[s.site.homePageId]))!;
    expect(home).toContain('<meta property="og:type" content="website" />');
    expect(home).not.toContain('article:published_time');
  });

  it('warns about an article whose stored date cannot be read, and leaves it out of news lists', () => {
    const { s, home, nodeId } = market();
    s.pages.pg_spring.article = { date: '2 March' };
    expect(validateState(s).filter((d) => d.code === 'ARTICLE_DATE_INVALID')).toEqual([expect.objectContaining({ severity: 'warning', owner: page('pg_spring') })]);
    expect(cards(s, home, nodeId).map((c) => c.id)).toEqual(['pg_winter']);
    // Details of the wrong kind are not shown, and do not stop the list being worked out.
    s.pages.pg_winter.article = { date: '2026-11-14', byline: 7, excerpt: ['x'], hidden: 'false' } as never;
    expect(cards(s, home, nodeId)).toEqual([expect.objectContaining({ id: 'pg_winter', byline: '', excerpt: '' })]);
  });
});

describe('computed lists inside a design', () => {
  it('keeps an article’s header and its News list right after they are made into a component of their own', () => {
    const { s } = market();
    const winter = s.pages.pg_winter;
    const headerId = winter.rootIds[0];
    const withNews = applyOperations(s, [{ type: 'node.insert', owner: page('pg_winter'), componentId: 'content.news', props: { heading: 'More news' } }]);
    const newsId = withNews.results[0].nodeId as string;
    // Make each a component of its own: both now sit inside a design that every page shares.
    const made = applyOperations(withNews.state, [
      { type: 'component.createFromNode', owner: page('pg_winter'), nodeId: headerId, name: 'Masthead' },
      { type: 'component.createFromNode', owner: page('pg_winter'), nodeId: newsId, name: 'More news' }
    ]);
    const st = made.state;
    // The article still shows its own title as its Heading 1, with its date, and its News list leaves it out.
    const text = pageText(st, st.pages.pg_winter);
    expect(text.split('\n')[0]).toBe('Winter opening hours');
    expect(text).toContain('14 November 2026');
    expect(text).toContain('Spring makers announced');
    expect(text.match(/Winter opening hours/g)).toHaveLength(1);
    // The generated page hands the page's rows to the shared design, which passes them on to its computed lists.
    const files = generateProject(st);
    const route = files.get(pageFile(st.pages.pg_winter))!;
    expect(route).toMatch(/so_pages=\{\{"articles":\[\{"id":"pg_spring"/);
    expect(route).toContain('"currentPage":[{"id":"pg_winter"');
    const designs = [...files.values()].filter((f) => f.includes('so_pages = undefined,'));
    expect(designs).toHaveLength(2);
    expect(designs.join('\n')).toContain('so_pages?.["currentPage"] ?? []');
    expect(designs.join('\n')).toContain('so_pages?.["articles"] ?? []).slice(0, 12)');
    // The components' own files hold no articles.
    expect(designs.join('\n')).not.toContain('Spring makers announced');
  });
});

describe('computed lists inside designs: further cases', () => {
  /** A project design whose tree places `child` (a definition ID) once, placed on `pageId`. */
  function wrap(s: ProjectState, childDef: ComponentDefinition, pageId: string, props: Record<string, unknown> = {}) {
    const wrapper: ComponentDefinition = {
      schemaVersion: 1,
      id: 'project.wrapper',
      componentId: 'project.wrapper',
      contractVersion: 1,
      kind: 'managed',
      owner: 'project',
      name: 'Wrapper',
      description: '',
      category: 'custom',
      tags: [],
      properties: {},
      parts: { root: { nodeId: 'root', label: 'Root' } },
      tree: { rootIds: ['root'], nodes: { root: { id: 'root', kind: 'element', tag: 'div', children: ['inner'] }, inner: { id: 'inner', kind: 'instance', definitionId: childDef.id, props } } }
    };
    s.components[childDef.id] = childDef;
    s.components[wrapper.id] = wrapper;
    const node: InstanceNode = { id: 'n_wrapper', kind: 'instance', definitionId: wrapper.id, props: {} };
    s.pages[pageId].nodes[node.id] = node;
    s.pages[pageId].rootIds.push(node.id);
    return generateProject(s);
  }
  const fileOf = (files: Map<string, string>, needle: string) => [...files.values()].find((f) => f.includes(needle))!;

  it('hands the rows on through a design inside a design, and to code that reads them', () => {
    const { s } = market();
    const headerId = s.pages.pg_winter.rootIds[0];
    const once = applyOperations(s, [{ type: 'component.createFromNode', owner: page('pg_winter'), nodeId: headerId, name: 'Masthead' }]);
    const twice = applyOperations(once.state, [{ type: 'component.createFromNode', owner: page('pg_winter'), nodeId: once.state.pages.pg_winter.rootIds[0], name: 'Outer masthead' }]);
    const files = generateProject(twice.state);
    expect(files.get(pageFile(twice.state.pages.pg_winter))).toContain('so_pages={{"currentPage":[{"id":"pg_winter"');
    // The outer design passes the rows on to the inner one, which reads the page's own row.
    const designs = [...files.values()].filter((f) => f.includes('so_pages = undefined,'));
    expect(designs).toHaveLength(2);
    expect(designs.filter((f) => f.includes('so_pages={so_pages}'))).toHaveLength(1);
    expect(designs.filter((f) => f.includes('so_pages?.["currentPage"] ?? []'))).toHaveLength(1);
    expect(headingOutline(twice.state, 'pg_winter').filter((h) => h.level === 1).map((h) => h.text)).toEqual(['Winter opening hours']);
    // A design that only shows its page's header is handed that page alone, not the whole archive.
    expect(files.get(pageFile(twice.state.pages.pg_winter))).not.toContain('"articles"');
    // Converted to code, the design still reads the rows its page hands it.
    const code = applyOperations(twice.state, [{ type: 'component.convertToCode', owner: page('pg_winter'), nodeId: twice.state.pages.pg_winter.rootIds[0] }]).state;
    const converted = Object.values(code.components).find((d) => d.kind === 'code' && d.owner === 'project')!;
    expect(converted.source).toContain('so_pages = undefined,');
    expect(converted.source).toContain('so_pages={so_pages}');
    const route = generateProject(code).get(pageFile(code.pages.pg_winter))!;
    expect(route).toContain('so_pages={{"articles":[');
    expect(route).toContain('"currentPage":[{"id":"pg_winter"');
  });

  it('declares the rows in a design whose only computed list belongs to a code component', () => {
    const { s } = market();
    const code: ComponentDefinition = {
      schemaVersion: 1,
      id: 'project.code-news',
      componentId: 'project.code-news',
      contractVersion: 1,
      kind: 'code',
      owner: 'project',
      name: 'Code news',
      description: '',
      category: 'custom',
      tags: [],
      properties: { items: { type: 'list', label: 'News', itemLabel: 'Article', fields: { title: { type: 'string', label: 'Title', default: '' } }, default: [], feed: 'articles', max: 2 } },
      parts: {},
      source: '<script>let { items = [] } = $props();</script>{#each items as item}<p>{item.title}</p>{/each}'
    };
    const files = wrap(s, code, s.site.homePageId);
    const wrapper = fileOf(files, 'so-project-wrapper');
    expect(wrapper).toContain('so_pages = undefined,');
    // Shaped as the list's own items: its ID and its declared fields, nothing else a row carries.
    expect(wrapper).toContain('items={(so_pages?.["articles"] ?? []).slice(0, 2).map((row) => ({ id: row.id, "title": row["title"] }))}');
    expect(files.get(pageFile(s.pages[s.site.homePageId]))).toContain('so_pages={{"articles":[{"id":"pg_spring"');
  });

  it('hands nothing to a design whose computed list shows no rows, and reads none there', () => {
    const { s } = market();
    const news = structuredClone(Object.values(s.components).find((d) => d.componentId === 'content.news')!);
    news.id = 'project.news-none';
    news.componentId = 'project.news-none';
    news.owner = 'project';
    (news.properties.items as ListProp).max = 0;
    const files = wrap(s, news, s.site.homePageId);
    const wrapper = fileOf(files, 'so-project-wrapper');
    expect(wrapper).not.toContain('so_pages');
    expect(wrapper).toContain('items={[]}');
    expect(files.get(pageFile(s.pages[s.site.homePageId]))).not.toContain('so_pages');
  });

  it('never offers a computed list handed to another component’s ordinary list as that placement’s items', () => {
    const { s } = market();
    const code: ComponentDefinition = {
      schemaVersion: 1,
      id: 'project.code-list',
      componentId: 'project.code-list',
      contractVersion: 1,
      kind: 'code',
      owner: 'project',
      name: 'Code list',
      description: '',
      category: 'custom',
      tags: [],
      properties: { items: { type: 'list', label: 'Items', itemLabel: 'Item', fields: { title: { type: 'string', label: 'Title', default: '' } }, default: [] } },
      parts: {},
      source: '<script>let { items = [] } = $props();</script>{#each items as item}<p>{item.title}</p>{/each}'
    };
    const wrapper: ComponentDefinition = {
      schemaVersion: 1,
      id: 'project.fed',
      componentId: 'project.fed',
      contractVersion: 1,
      kind: 'managed',
      owner: 'project',
      name: 'Fed',
      description: '',
      category: 'custom',
      tags: [],
      properties: { news: { type: 'list', label: 'News', itemLabel: 'Article', fields: { title: { type: 'string', label: 'Title', default: '' } }, default: [], feed: 'articles' } },
      parts: { root: { nodeId: 'root', label: 'Root' } },
      tree: { rootIds: ['root'], nodes: { root: { id: 'root', kind: 'instance', definitionId: code.id, props: { items: { $prop: 'news' } } } } }
    };
    s.components[code.id] = code;
    s.components[wrapper.id] = wrapper;
    const home = s.pages[s.site.homePageId];
    home.nodes.n_fed = { id: 'n_fed', kind: 'instance', definitionId: wrapper.id, props: {} };
    home.rootIds.push('n_fed');
    const shown = renderedContent(s, home).filter((c) => c.value === 'Winter opening hours');
    expect(shown.length).toBeGreaterThan(0);
    for (const c of shown) expect(c.source).toBeUndefined();
    // The checks see the rows as the generator writes them: the list's declared fields only.
    // A design that shows a field its computed list does not declare shows nothing for it, in the export and the checks.
    const bylines: ComponentDefinition = {
      ...structuredClone(wrapper),
      id: 'project.bylines',
      componentId: 'project.bylines',
      properties: { news: { type: 'list', label: 'News', itemLabel: 'Article', fields: { title: { type: 'string', label: 'Title', default: '' } }, default: [], feed: 'articles' } },
      tree: { rootIds: ['root'], nodes: { root: { id: 'root', kind: 'repeat', list: { $prop: 'news' }, children: ['t'] }, t: { id: 't', kind: 'text', tag: 'p', text: { $item: 'byline' } } } }
    };
    s.components[bylines.id] = bylines;
    home.nodes.n_bylines = { id: 'n_bylines', kind: 'instance', definitionId: bylines.id, props: {} };
    home.rootIds.push('n_bylines');
    expect(renderedContent(s, home).filter((c) => c.nodeId === 'n_bylines' && c.value === 'Market team')).toEqual([]);
  });

  it('counts a design’s Article header for a new article only while its condition holds for the props sent', () => {
    const { s } = market();
    const header = Object.values(s.components).find((d) => d.componentId === 'content.article')!;
    const masthead: ComponentDefinition = {
      ...structuredClone(header),
      id: 'project.masthead',
      componentId: 'project.masthead',
      owner: 'project',
      provenance: {},
      properties: { show: { type: 'boolean', label: 'Show header', default: false } },
      tree: { rootIds: ['root'], nodes: { root: { id: 'root', kind: 'element', tag: 'div', children: ['h'] }, h: { id: 'h', kind: 'instance', definitionId: header.id, props: {}, when: { $prop: 'show' } } } }
    };
    s.components[masthead.id] = masthead;
    expect(isArticleHeader(s, masthead, { show: true })).toBe(true);
    expect(isArticleHeader(s, masthead, { show: false })).toBe(false);
    expect(isArticleHeader(s, masthead, {})).toBe(false);
    expect(isArticleHeader(s, header)).toBe(true);
    expect(isArticleHeader(s, Object.values(s.components).find((d) => d.componentId === 'content.news')!)).toBe(false);
  });

  it('keeps each row’s own key when a computed list declares a field named id', () => {
    const { s } = market();
    const news = structuredClone(Object.values(s.components).find((d) => d.componentId === 'content.news')!);
    news.id = 'project.news-id';
    news.componentId = 'project.news-id';
    news.owner = 'project';
    (news.properties.items as ListProp).fields.id = { type: 'string', label: 'ID', default: 'same' };
    const wrapper = [...(wrap(s, news, s.site.homePageId) as Map<string, string>).values()].find((f) => f.includes('so-project-wrapper'))!;
    expect(wrapper).toContain('.map((row) => ({ id: row.id, "pageLink": row["pageLink"]');
    expect(wrapper).not.toContain('"id": "same"');
  });

  it('gives a code component’s computed list its rich text as paragraphs, as it gives every other property', () => {
    const { s } = market();
    const code: ComponentDefinition = {
      schemaVersion: 1,
      id: 'project.code-notes',
      componentId: 'project.code-notes',
      contractVersion: 1,
      kind: 'code',
      owner: 'project',
      name: 'Code notes',
      description: '',
      category: 'custom',
      tags: [],
      properties: { items: { type: 'list', label: 'News', itemLabel: 'Article', fields: { title: { type: 'string', label: 'Title', default: '' }, note: { type: 'richtext', label: 'Note', default: [{ type: 'p', spans: [{ text: 'Read more' }] }] } }, default: [], feed: 'articles' } },
      parts: {},
      source: '<script>let { items = [] } = $props();</script>{#each items as item}<p>{item.title} {item.note[0]}</p>{/each}'
    };
    s.components[code.id] = code;
    const node: InstanceNode = { id: 'n_notes', kind: 'instance', definitionId: code.id, props: {} };
    s.pages[s.site.homePageId].nodes[node.id] = node;
    s.pages[s.site.homePageId].rootIds.push(node.id);
    const route = generateProject(s).get(pageFile(s.pages[s.site.homePageId]))!;
    expect(route).toContain('"title":"Spring makers announced","note":["Read more"]');
  });

  it('gives a computed list’s own fields their defaults inside a design, and never writes a hand-edited limit as code', () => {
    const { s } = market();
    const news: ComponentDefinition = {
      schemaVersion: 1,
      id: 'project.news-prefix',
      componentId: 'project.news-prefix',
      contractVersion: 1,
      kind: 'managed',
      owner: 'project',
      name: 'Prefixed news',
      description: '',
      category: 'custom',
      tags: [],
      properties: {
        items: { type: 'list', label: 'News', itemLabel: 'Article', fields: { title: { type: 'string', label: 'Title', default: '' }, prefix: { type: 'string', label: 'Prefix', default: 'Published' } }, default: [], feed: 'articles', max: 'twelve' as never }
      },
      parts: { root: { nodeId: 'root', label: 'Root' } },
      tree: { rootIds: ['root'], nodes: { root: { id: 'root', kind: 'repeat', list: { $prop: 'items' }, children: ['t'] }, t: { id: 't', kind: 'text', tag: 'p', text: { $item: 'prefix' } } } }
    };
    // Even bound to a property of the design around it, a computed list is the pages' rows.
    const files = wrap(s, news, s.site.homePageId, { items: { $prop: 'nothing' } });
    const wrapper = fileOf(files, 'so-project-wrapper');
    expect(wrapper).toContain('items={(so_pages?.["articles"] ?? []).map((row) => ({ id: row.id, "title": row["title"], "prefix": "Published" }))}');
    expect(wrapper).not.toContain('twelve');
    expect(validateState(s).find((d) => d.code === 'FEED_INVALID')).toMatchObject({ owner: { kind: 'component', id: 'project.news-prefix' } });
    expect(pageText(s, s.pages[s.site.homePageId])).toContain('Published');
  });
});

describe('article dates', () => {
  it('never moves a stored day with this computer’s time zone, and dates a new article by its local day', () => {
    const tz = process.env.TZ;
    try {
      for (const zone of ['America/Los_Angeles', 'Pacific/Kiritimati']) {
        process.env.TZ = zone;
        expect(formatArticleDate('2026-11-14', 'en-GB')).toBe('14 November 2026');
        expect(todayArticleDate(new Date(2026, 10, 14, 23, 59))).toBe('2026-11-14');
        expect(todayArticleDate(new Date(2026, 10, 14, 0, 1))).toBe('2026-11-14');
        expect(todayArticleDate(zone === 'America/Los_Angeles' ? new Date(2026, 11, 31, 23, 30) : new Date(2027, 0, 1, 0, 30))).toBe(zone === 'America/Los_Angeles' ? '2026-12-31' : '2027-01-01');
      }
    } finally {
      process.env.TZ = tz;
    }
    expect(formatArticleDate('0099-03-02', 'en-GB')).toBe('2 March 99');
    expect(todayArticleDate(new Date(new Date(2026, 0, 2).setFullYear(999)))).toBe('0999-01-02');
  });

  it('writes the date as the site language does, on the calendar day stored', () => {
    expect(formatArticleDate('2026-11-14', 'en-GB')).toBe('14 November 2026');
    expect(formatArticleDate('2026-11-14', 'en')).toBe('November 14, 2026');
    expect(formatArticleDate('2026-11-14', 'de')).toBe('14. November 2026');
    // A tag that cannot be read, or one with no locale data, falls back to English rather than this computer's language.
    expect(formatArticleDate('2026-11-14', 'not a tag!')).toBe('November 14, 2026');
    expect(formatArticleDate('2026-11-14', 'zz-ZZ')).toBe('November 14, 2026');
    expect(formatArticleDate('2026-01-01', undefined)).toBe('January 1, 2026');
  });

  it('dates a new article by this computer’s calendar day', () => {
    expect(todayArticleDate(new Date(2026, 10, 14, 23, 59))).toBe('2026-11-14');
    expect(todayArticleDate(new Date(2027, 0, 2, 0, 1))).toBe('2027-01-02');
  });

  it('computes an article header row for the page it is on, and none in shared parts', () => {
    const { s } = market();
    expect(articleRows(s, 'currentPage', 'pg_winter')).toEqual([{ id: 'pg_winter', pageLink: { type: 'page', target: 'pg_winter' }, title: 'Winter opening hours', date: '2026-11-14', dateLabel: '14 November 2026', byline: '', excerpt: 'Shorter days from December.' }]);
    // An ordinary page still gives its title, with no date.
    expect(articleRows(s, 'currentPage', s.site.homePageId)[0]).toMatchObject({ title: s.pages[s.site.homePageId].title, date: '', dateLabel: '', byline: '' });
    expect(articleRows(s, 'everything' as never, s.site.homePageId)).toEqual([]);
    expect(articleRows(s, 'articles', undefined, 0)).toEqual([]);
    expect(articleRows(s, 'currentPage', undefined)).toEqual([]);
    expect(articleRows(s, 'articles', undefined, 1).map((r) => r.id)).toEqual(['pg_spring']);
  });
});

describe('computed list contracts', () => {
  const fields = { pageLink: { type: 'link', label: 'Link' }, title: { type: 'string', label: 'Title' }, date: { type: 'string', label: 'Date' } };

  it('accepts a computed list for a project component, storing no items', () => {
    const { s } = market();
    const schema = normalizePropSchema({ type: 'list', label: 'News', fields, feed: 'articles', default: [{ title: 'x' }] }, s, 'news') as ListProp;
    expect(schema).toMatchObject({ feed: 'articles', default: [] });
    expect(() => normalizePropSchema({ type: 'list', label: 'News', fields, feed: 'everything' }, s, 'news')).toThrow(/feed must be one of/);
    expect(() => normalizePropSchema({ type: 'list', label: 'News', fields: { ...fields, date: { type: 'number', label: 'Date' } }, feed: 'articles' }, s, 'news')).toThrow(/must be a string field/);
    expect(() => normalizePropSchema({ type: 'list', label: 'News', fields, feed: 'articles', min: 1 }, s, 'news')).toThrow(/minimum/);
    expect(() => normalizePropSchema({ type: 'list', label: 'News', fields: { ...fields, title: { type: 'number', label: 'Title' } }, feed: 'articles' }, s, 'news')).toThrow(/"title" of a computed list must be a string field/);
    expect(() => normalizePropSchema({ type: 'list', label: 'News', fields: { note: { type: 'string', label: 'Note' } }, feed: 'articles' }, s, 'news')).toThrow(/at least one field it fills/);
  });

  it('treats a list becoming (or ceasing to be) computed as a different contract', () => {
    const { s } = market();
    const def = Object.values(s.components).find((d) => d.componentId === 'content.news')!;
    const next = structuredClone(def);
    delete (next.properties.items as ListProp).feed;
    expect(contractConflicts(s, def, next).join(' ')).toMatch(/filled from the site's pages differently/);
    // Becoming computed, or computed from something else, is just as different.
    expect(contractConflicts(s, next, def).join(' ')).toMatch(/filled from the site's pages differently/);
    const other = structuredClone(def);
    (other.properties.items as ListProp).feed = 'currentPage';
    expect(contractConflicts(s, def, other).join(' ')).toMatch(/filled from the site's pages differently/);
    expect(contractConflicts(s, def, structuredClone(def))).toEqual([]);
  });
});

describe('articles in the editor and the AI tools', () => {
  it('is found in Insert by the words the issue searched for', () => {
    const hay = (id: string) => {
      const def = catalogueComponent('foundation', id)!;
      return `${def.name} ${def.description} ${def.tags.join(' ')}`.toLowerCase();
    };
    for (const q of ['news', 'posts', 'articles', 'announcements', 'blog', 'latest']) expect(hay('content.news'), q).toContain(q);
    for (const q of ['article', 'news', 'byline', 'announcement']) expect(hay('content.article'), q).toContain(q);
    // A name that starts with the query ranks first: "article" finds the Article header before Text section.
    expect(catalogueComponent('foundation', 'content.article')!.name.toLowerCase().startsWith('article')).toBe(true);
    expect(catalogueComponent('foundation', 'content.news')!.name.toLowerCase().startsWith('news')).toBe(true);
  });

  it('never offers the computed items as something to write', () => {
    const { s, home, nodeId } = market();
    const def = defOf(s, instance(s, home, nodeId));
    expect(Object.keys((propsJsonSchema(def) as { properties: object }).properties)).toEqual(['eyebrow', 'heading', 'headingLevel', 'lead']);
    expect(Object.keys((compactPropsSchema(def) as { properties: object }).properties)).not.toContain('items');
    const tools = selectionTools(s, { owner: page(home), nodeId })!;
    expect(tools.map((t) => t.name)).not.toContain('edit_selected_list');
    // The Article header's computed list is left out too: it has nothing to send at all.
    const header = s.pages.pg_winter.nodes[s.pages.pg_winter.rootIds[0]] as InstanceNode;
    expect(Object.keys((propsJsonSchema(defOf(s, header)) as { properties: object }).properties)).toEqual(['eyebrow']);
  });

  it('treats a computed card on the canvas as its page’s words, not a field to type over', () => {
    // Foundation's News list and Article header are code, whose markup the canvas does not read, so managed designs
    // of the project's own with the same computed lists stand in for them: a card title linked to its article, and
    // a header's title read from its page.
    const { s: market0, home } = market();
    const fields = { pageLink: P.link('Link'), title: P.str('Title', '') };
    const newsDesign = projectDesign(market0, {
      componentId: 'project.news',
      name: 'News',
      properties: { heading: P.str('Heading', 'Latest news'), items: P.list('Articles', 'Article', fields, [], { titleField: 'title', min: 0, max: 12, feed: 'articles' }) },
      parts: {},
      build: (b) => b.el('root', 'section', {}, [b.text('heading', 'h2', prop('heading')), b.repeat('cards', 'items', [b.link('card-title', dslItem('pageLink'), dslItem('title'), 'plain')])])
    });
    const headerDesign = projectDesign(market0, {
      componentId: 'project.masthead',
      name: 'Masthead',
      properties: { article: P.list('Article', 'Article', fields, [], { titleField: 'title', min: 0, max: 1, feed: 'currentPage' }) },
      parts: {},
      build: (b) => b.el('root', 'section', {}, [b.repeat('page', 'article', [b.text('heading', 'h1', dslItem('title'))])])
    });
    const placed = applyOperations(market0, [
      { type: 'node.insert', owner: page(home), definitionId: newsDesign.id },
      { type: 'node.insert', owner: page('pg_winter'), parentId: null, index: 0, definitionId: headerDesign.id }
    ]);
    const s = placed.state;
    const nodeId = placed.results[0].nodeId as string;
    const def = defOf(s, instance(s, home, nodeId));
    const title = def.tree!.nodes['card-title'] as { label: unknown };
    const ref = { owner: page(home), instancePath: [nodeId], nodeId: 'card-title', itemPath: ['pg_winter'] };
    expect(computedAt(s, ref, title.label)).toBe(true);
    expect(shownValue(s, ref, title.label)).toBe('Winter opening hours');
    // The section's own heading is still typed where it shows.
    expect(computedAt(s, { ...ref, nodeId: 'heading', itemPath: [] }, (def.tree!.nodes.heading as { text: unknown }).text)).toBe(false);
    // So is an article header's title, which is its page's.
    const headerId = placed.results[1].nodeId as string;
    const headerDef = defOf(s, instance(s, 'pg_winter', headerId));
    const titleRef = { owner: page('pg_winter'), instancePath: [headerId], nodeId: 'heading', itemPath: ['pg_winter'] };
    expect(computedAt(s, titleRef, (headerDef.tree!.nodes.heading as { text: unknown }).text)).toBe(true);
    expect(shownValue(s, titleRef, (headerDef.tree!.nodes.heading as { text: unknown }).text)).toBe('Winter opening hours');
  });

  it('reports article changes in words, and as changes to every page that can list them', () => {
    const { s, home } = market();
    const op = { type: 'page.update' as const, pageId: 'pg_winter', articleDate: '2027-04-01', newsHidden: true };
    const after = applyOperations(s, [op]).state;
    expect(describeOps([op], s, after, [{}]).map((c) => c.label)).toEqual(['Changed the publication date and news list visibility of page Winter opening hours']);
    expect(pagesTouched([op])).toBe('all');
    expect(pagesTouched([{ type: 'page.update', pageId: 'pg_winter', byline: 'Ana' }])).toBe('all');
    expect(pagesTouched([{ type: 'page.create', title: 'Opening day', starter: 'article' }])).toBe('all');
    expect(pagesTouched([{ type: 'page.create', title: 'Opening day', articleDate: '2027-01-01' }])).toBe('all');
    for (const field of ['articleDate', 'byline', 'excerpt', 'newsHidden', 'article'] as const)
      expect(pagesTouched([{ type: 'page.update', pageId: 'pg_winter', [field]: field === 'articleDate' ? '2027-01-01' : field === 'newsHidden' ? true : field === 'article' ? false : 'x' }], s), field).toBe('all');
    // Publishing, drafting or copying an article changes the News lists; doing so to an ordinary page changes that page alone.
    expect(pagesTouched([{ type: 'page.duplicate', pageId: 'pg_winter' }], s)).toBe('all');
    expect(pagesTouched([{ type: 'page.update', pageId: 'pg_winter', draft: true }], s)).toBe('all');
    const about = s.site.pageOrder.find((id) => id !== home && !s.pages[id].article)!;
    expect(pagesTouched([{ type: 'page.duplicate', pageId: about }], s)).toEqual(new Set());
    expect(pagesTouched([{ type: 'page.update', pageId: about, draft: true }], s)).toEqual(new Set([about]));
    // Without the project to tell, any of them may be an article.
    expect(pagesTouched([{ type: 'page.duplicate', pageId: about }])).toBe('all');
    // An ordinary page's settings still touch that page alone.
    expect(pagesTouched([{ type: 'page.update', pageId: home, noindex: true }], s)).toEqual(new Set([home]));
    expect(pagesTouched([{ type: 'page.update', pageId: home, noindex: true }])).toEqual(new Set([home]));
    expect(pagesTouched([{ type: 'page.update', pageId: 'pg_winter', draft: false }], s)).toBe('all');
  });

  it('reads the article field a held edit writes, so a competing change to it is noticed', () => {
    const { s } = market();
    expect(readField(s, { type: 'page.update', pageId: 'pg_spring', byline: 'Ana' })).toEqual({ found: true, value: { byline: 'Market team' } });
    expect(readField(s, { type: 'page.update', pageId: 'pg_spring', articleDate: '2027-01-01' })).toEqual({ found: true, value: { articleDate: '2027-03-02' } });
    expect(readField(s, { type: 'page.update', pageId: 'pg_spring', article: false })).toEqual({ found: true, value: { article: s.pages.pg_spring.article } });
    expect(readField(s, { type: 'page.update', pageId: 'pg_spring', excerpt: 'x', newsHidden: true })).toEqual({ found: true, value: { excerpt: 'Twenty new stallholders join in March.', newsHidden: undefined } });
    // Once the page is no longer an article, an edit to its byline has nothing left to change.
    const plain = applyOperations(s, [{ type: 'page.update', pageId: 'pg_spring', article: false }]).state;
    expect(readField(plain, { type: 'page.update', pageId: 'pg_spring', byline: 'Ana' })).toEqual({ found: false, what: 'article' });
    expect(readField(plain, { type: 'page.update', pageId: 'pg_spring', excerpt: 'x' })).toEqual({ found: false, what: 'article' });
    expect(readField(plain, { type: 'page.update', pageId: 'pg_spring', newsHidden: true })).toEqual({ found: false, what: 'article' });
    // Dating it in the same edit makes it an article again, details and all.
    expect(readField(plain, { type: 'page.update', pageId: 'pg_spring', articleDate: '2027-01-01', byline: 'Ana' })).toEqual({ found: true, value: { byline: undefined, articleDate: undefined } });
    // A date still makes a page an article.
    expect(readField(plain, { type: 'page.update', pageId: 'pg_spring', articleDate: '2027-01-01' })).toEqual({ found: true, value: { articleDate: undefined } });
  });

  it('states a date only when it is one: a bound value that is not a calendar day leaves the words plain', () => {
    const body = /export function isDate\(value\) \{([\s\S]*?)\n\}/.exec(UTIL_JS)![1];
    const isDate = new Function('value', body) as (v: unknown) => boolean;
    expect(['2026-11-14', '2024-02-29', '0004-02-29'].map(isDate)).toEqual([true, true, true]);
    expect(['2026-02-30', '1900-02-29', '2026-13-01', '14 November', '', null, '0000-01-01'].map(isDate)).toEqual([false, false, false, false, false, false, false]);
    const { s } = market();
    const component = generateProject(s).get(defFile(newsDef(s)))!;
    expect(component).toContain('{#if isDate(item.date)}<time datetime={item.date}>{item.dateLabel}</time>{:else}{item.dateLabel}{/if}');
  });

  it('keeps a bound date as the text’s own date when it is unbound, and never offers a computed list as a menu', () => {
    const { s } = market();
    const def: ComponentDefinition = {
      schemaVersion: 1,
      id: 'project.dated',
      componentId: 'project.dated',
      contractVersion: 1,
      kind: 'managed',
      owner: 'project',
      name: 'Dated note',
      description: '',
      category: 'custom',
      tags: [],
      properties: { when: { type: 'string', label: 'When', default: '2026-11-14' }, label: { type: 'string', label: 'Label', default: '14 November' } },
      parts: { root: { nodeId: 'root', label: 'Root' } },
      tree: { rootIds: ['root'], nodes: { root: { id: 'root', kind: 'text', tag: 'p', text: { $prop: 'label' }, datetime: { $prop: 'when' } } } }
    };
    s.components[def.id] = def;
    const r = applyOperations(s, [{ type: 'node.setBinding', owner: { kind: 'component', id: def.id }, nodeId: 'root', field: 'datetime', binding: null }]).state;
    expect((r.components[def.id].tree!.nodes.root as { datetime?: unknown }).datetime).toBe('2026-11-14');
    // A shared header whose links fill themselves is no menu to add a page to.
    const headerNode = Object.values(s.site.shell.header.nodes).find((n) => n.kind === 'instance') as InstanceNode;
    expect(headerMenu(s)).not.toBeNull();
    s.components[headerNode.definitionId] = structuredClone(s.components[headerNode.definitionId]);
    (s.components[headerNode.definitionId].properties.links as ListProp).feed = 'articles';
    expect(headerMenu(s)).toBeNull();
  });
});
