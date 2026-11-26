/**
 * Links to a collection's index (#870): the blog's list of posts can be a link's destination wherever a page can, by
 * its collection's ID, so a link follows the blog when it moves; and starting the blog can add a header link to it,
 * within the menu's limit, as adding a page can.
 */
import { describe, expect, it } from 'vitest';
import type { LinkValue, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { normalizeLink, normalizeRichText } from '@engine/values';
import { headerMenu } from '@engine/tree';
import { validateState } from '@engine/validate';
import { collectionLinkUses } from '@engine/page-links';
import { resolveLink } from '@generator/index';
import { collectionIndexRoutes, linkableIndexes } from '@shared/archives';
import { linkFromTarget, linkToTarget, richTextToMarkdown } from '@shared/richtext';
import { blocksFromDom } from '@shared/richtext-tree';
import { inlineLinkProblem } from '../../src/renderer/src/lib/link-problems';
import { articleLinks } from '../../src/renderer/src/lib/article-links';
import { articleProblem } from '../../src/renderer/src/lib/post-dom';
import { describeLink } from '../../src/renderer/src/lib/find-content';
import { starterCollectionOps } from '../../src/renderer/src/lib/content';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const site = () => createStarterState('business', 'Riverside Studio', false);
const blog = () => run(site(), { type: 'collection.create', collectionId: 'posts' });
const INDEX: LinkValue = { type: 'collection', target: 'posts' };
const menuId = (s: ProjectState) => headerMenu(s)!.node.id;
const menuLinks = (s: ProjectState) => (headerMenu(s)!.node.props.links ?? headerMenu(s)!.schema.default) as Array<{ label: string; link: LinkValue }>;
/** Point the header's first menu link at a destination. */
const linkFirst = (s: ProjectState, link: unknown) => {
  const first = (menuLinks(s)[0] as unknown as { id: string }).id;
  return run(s, { type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: menuId(s), prop: 'links', itemId: first, field: 'link', value: link as LinkValue });
};

describe('links to a collection index', () => {
  it('stores the collection, by its ID, from an object, a token or the index address', () => {
    const s = blog();
    expect(normalizeLink({ type: 'collection', target: 'posts', anchor: 'top', rel: ['nofollow'] }, s, 'Link')).toEqual(INDEX);
    expect(normalizeLink({ type: 'collection', target: 'posts', newTab: true }, s, 'Link')).toEqual({ ...INDEX, newTab: true });
    expect(normalizeLink('collection:posts', s, 'Link')).toEqual(INDEX);
    expect(normalizeLink('/blog/', s, 'Link')).toEqual(INDEX);
    expect(normalizeLink('/blog', s, 'Link')).toEqual(INDEX);
    expect(() => normalizeLink({ type: 'collection', target: 'events' }, s, 'Link')).toThrow(/collection "events" does not exist/);
    // A page at an address wins over nothing: before the blog exists /blog/ is no destination.
    expect(() => normalizeLink('/blog/', site(), 'Link')).toThrow(/is not a page ID/);
    expect(validateOperation({ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: 'n', prop: 'links', value: INDEX }).ok).toBe(true);
  });

  it('goes to the index at its current address, and shows its words alone without one', () => {
    let s = linkFirst(blog(), INDEX);
    expect(menuLinks(s)[0].link).toEqual(INDEX);
    expect(resolveLink(INDEX, { state: s })).toEqual({ href: '/blog/' });
    expect(resolveLink({ ...INDEX, newTab: true }, { state: s })).toEqual({ href: '/blog/', newTab: true });
    // Moved, the link follows it: the collection is the destination, not its address of the day.
    s = run(s, { type: 'collection.update', collectionId: 'posts', route: '/journal/' });
    expect(resolveLink(INDEX, { state: s })).toEqual({ href: '/journal/' });
    expect(collectionIndexRoutes(s)).toEqual({ posts: '/journal/' });
    // With its index turned off there is nowhere to go.
    const off = run(s, { type: 'collection.update', collectionId: 'posts', pages: { detail: true, archive: false } });
    expect(resolveLink(INDEX, { state: off })).toBeNull();
    expect(linkableIndexes(off)).toEqual([]);
    expect(resolveLink({ type: 'collection', target: 'events' }, { state: s })).toBeNull();
  });

  it('reads the index from rich text by its token or its address, and writes it back as the token', () => {
    const s = blog();
    const text = normalizeRichText('Read [the blog](/blog/) or [the posts](collection:posts).', s, 'Text');
    const spans = (text[0] as { spans: Array<{ link?: LinkValue }> }).spans.filter((x) => x.link);
    expect(spans.map((x) => x.link)).toEqual([INDEX, INDEX]);
    expect(richTextToMarkdown(text, s.pages)).toContain('[the blog](collection:posts)');
    expect(linkToTarget(INDEX, s.pages)).toBe('collection:posts');
    expect(() => normalizeRichText('[Events](collection:events)', s, 'Text')).toThrow(/collection "events" does not exist/);
  });

  it('keeps an index link edited on the canvas, where it shows as the address', () => {
    const s = blog();
    const indexes = collectionIndexRoutes(s);
    expect(linkFromTarget('/blog/', s.pages, false, undefined, indexes)).toEqual(INDEX);
    // A section of the index is no place to go: it has none.
    expect(linkFromTarget('/blog/#top', s.pages, false, undefined, indexes)).toBeNull();
    const dom = [{ tag: 'p', children: [{ tag: 'a', href: '/blog/', children: ['All posts'] }] }];
    const read = blocksFromDom(dom, s.pages, undefined, indexes);
    expect(read.droppedLinks).toBe(0);
    expect(read.blocks).toEqual([{ type: 'p', spans: [{ text: 'All posts', link: INDEX }] }]);
    // Without the indexes the address is no page, and the link would be dropped: the canvas passes them.
    expect(blocksFromDom(dom, s.pages).droppedLinks).toBe(1);
    expect(inlineLinkProblem('/blog/', s.pages, indexes)).toBeNull();
    expect(inlineLinkProblem('/blog/', s.pages)).toMatch(/No page or collection index has the address \/blog\//);
    expect(inlineLinkProblem('collection:events', s.pages, indexes)).toMatch(/no index on the website/);
  });

  it('keeps an index link in a post the writer reads back', () => {
    const s = run(blog(), { type: 'entry.create', collectionId: 'posts', entryId: 'en_one', title: 'One', body: ['See [all posts](collection:posts).'] });
    const body = s.collections.posts.entries.en_one.body;
    expect(articleProblem(body)).toBeNull();
    expect(articleLinks(s).link('collection:posts', false, [])).toEqual(INDEX);
    expect(articleLinks(s).link(`so-link:${JSON.stringify(INDEX)}`, true, [])).toEqual(INDEX);
    expect(articleLinks(s).link('collection:events', false, [])).toBeNull();
    expect(describeLink(s, INDEX)).toBe('Posts index (/blog/)');
  });

  it('refuses to remove a collection while a link outside it goes to its index', () => {
    const s = linkFirst(blog(), INDEX);
    expect(collectionLinkUses(s, 'posts')).toHaveLength(1);
    expect(() => applyOperations(s, [{ type: 'collection.remove', collectionId: 'posts' }])).toThrow(/1 link outside the Posts collection point to its list or its entries \(in Header\)/);
    // Its own posts' links to it go with it.
    const own = run(blog(), { type: 'entry.create', collectionId: 'posts', entryId: 'en_one', title: 'One', body: ['See [all posts](collection:posts).'] });
    expect(run(own, { type: 'collection.remove', collectionId: 'posts' }).collections).not.toHaveProperty('posts');
  });

  it('reports a link to a collection that is gone, as a hand edit leaves it', () => {
    const s = linkFirst(blog(), INDEX);
    const broken = structuredClone(s);
    delete broken.collections.posts;
    expect(validateState(s).filter((d) => d.code === 'LINK_BROKEN')).toEqual([]);
    expect(validateState(broken).filter((d) => d.code === 'LINK_BROKEN').map((d) => d.message)).toEqual([expect.stringMatching(/a collection that no longer exists/)]);
  });

  it('adds a Blog link to the header menu when the blog is started with one', () => {
    const before = menuLinks(site()).length;
    const r = applyOperations(site(), [{ type: 'collection.create', collectionId: 'posts', addToNavigation: true }]);
    expect(r.results[0]).toMatchObject({ collectionId: 'posts', addedToNavigation: true });
    const links = menuLinks(r.state);
    expect(links).toHaveLength(before + 1);
    expect(links[links.length - 1]).toMatchObject({ label: 'Blog', link: INDEX });
    expect(resolveLink(links[links.length - 1].link, { state: r.state })).toEqual({ href: '/blog/' });
    // Without the ask nothing joins the menu, and the result says nothing about it.
    const plain = applyOperations(site(), [{ type: 'collection.create', collectionId: 'posts' }]);
    expect(plain.results[0]).not.toHaveProperty('addedToNavigation');
    expect(menuLinks(plain.state)).toHaveLength(before);
  });

  it('leaves a full menu as it is, and still starts the blog', () => {
    let s = site();
    const menu = headerMenu(s)!;
    const max = menu.schema.max!;
    expect(max).toBeGreaterThan(0);
    const full = Array.from({ length: max }, (_, i) => ({ label: `Link ${i + 1}`, link: { type: 'page', target: s.site.homePageId } }));
    s = run(s, { type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: menu.node.id, prop: 'links', value: full });
    const r = applyOperations(s, [{ type: 'collection.create', collectionId: 'posts', addToNavigation: true }]);
    expect(r.results[0]).toMatchObject({ collectionId: 'posts', addedToNavigation: false });
    expect(menuLinks(r.state)).toHaveLength(max);
    expect(r.state.collections).toHaveProperty('posts');
  });

  it('lists the indexes a link can go to, and starts the blog without a menu link unless asked', () => {
    const s = blog();
    const ops = starterCollectionOps(site(), 'posts')!.ops;
    expect(ops).toEqual([{ type: 'collection.create', collectionId: 'posts' }]);
    expect(linkableIndexes(s)).toEqual([{ id: 'posts', name: 'Posts', route: '/blog/' }]);
  });
});
