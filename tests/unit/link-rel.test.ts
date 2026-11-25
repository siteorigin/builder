/**
 * A link to another site can say what it is to search engines (#582): `nofollow`, `sponsored` and `ugc`, stored on a
 * web address link as `rel`, written in the text form after its destination, and rendered after the security tokens a
 * new tab adds.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstanceNode, LinkValue, ProjectState } from '@shared/types';
import { validateOperation } from '@shared/ops';
import { canonicalRels, linkRels, linkTitle, relAttribute, relsFromAttribute, withRels } from '@shared/link-rel';
import { linkFromTarget, linkTokens, parseRichText, richTextToMarkdown } from '@shared/richtext';
import { blocksFromDom } from '@shared/richtext-tree';
import { createStarterState } from '@catalogue/starters';
import { normalizeLink, normalizeRichText } from '@engine/values';
import { defFile, generateProject, resolveLink, withAuthoredRel } from '@generator/index';
import { linkAt, setLink, typedLink } from '../../src/renderer/src/lib/richtext-commands';
import { richDom } from '../../src/renderer/src/lib/richtext';
import { emptyReport, htmlToRichText } from '../../src/main/posts-import/html';
import { articleLinks } from '../../src/renderer/src/lib/article-links';
import { ProjectSession } from '../../src/main/project/session';

const fresh = () => createStarterState('business', 'Test Studio', false);
const aboutOf = (s: ProjectState) => Object.values(s.pages).find((p) => p.title === 'About')!;
const SHOP = 'https://shop.example/';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('a link’s relationships in a project', () => {
  it('are saved in its document, kept on reopen, and undone and redone like any edit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-rel-'));
    dirs.push(dir);
    const s = await ProjectSession.create(dir, createStarterState('business', 'Rel', false));
    const header = s.state.site.shell.header;
    const nodeId = header.rootIds[0];
    const cta = () => (s.state.site.shell.header.nodes[nodeId] as InstanceNode).props.ctaLink;
    const before = cta();
    const set = (value: unknown) => s.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId, prop: 'ctaLink', value }] }, { label: 'Edit link' });
    expect((await set({ type: 'url', target: SHOP, newTab: true, rel: ['sponsored'] })).ok).toBe(true);
    expect((await set({ type: 'url', target: SHOP, newTab: true, rel: ['ugc', 'sponsored'] })).ok).toBe(true);
    const stored = () => (JSON.parse(readFileSync(join(dir, 'siteorigin/site.json'), 'utf8')).shell.header.nodes[nodeId] as InstanceNode).props.ctaLink;
    expect(stored()).toEqual({ type: 'url', target: SHOP, newTab: true, rel: ['sponsored', 'ugc'] });
    await s.undo();
    expect(cta()).toEqual({ type: 'url', target: SHOP, newTab: true, rel: ['sponsored'] });
    await s.redo();
    expect(cta()).toEqual({ type: 'url', target: SHOP, newTab: true, rel: ['sponsored', 'ugc'] });
    // Tokens the site adds itself are never stored: the new tab's are added to every export anyway.
    expect((await set({ type: 'url', target: SHOP, newTab: true, rel: ['noopener', 'ugc', 'sponsored'] })).ok).toBe(true);
    expect(cta()).toEqual({ type: 'url', target: SHOP, newTab: true, rel: ['sponsored', 'ugc'] });
    await s.close();
    const again = await ProjectSession.open(dir, 'test');
    expect((again.state.site.shell.header.nodes[nodeId] as InstanceNode).props.ctaLink).toEqual({ type: 'url', target: SHOP, newTab: true, rel: ['sponsored', 'ugc'] });
    await again.undo();
    await again.undo();
    await again.undo();
    expect((again.state.site.shell.header.nodes[nodeId] as InstanceNode).props.ctaLink).toEqual(before);
    await again.close();
  });
});

describe('the stored relationships', () => {
  it('reads only the three it knows, each once, in their own order', () => {
    expect(canonicalRels(['ugc', 'nofollow', 'ugc', 'sponsored'])).toEqual(['nofollow', 'sponsored', 'ugc']);
    expect(canonicalRels(['noopener', 'external', 7, null])).toEqual([]);
    expect(canonicalRels(['UGC', 'noopener', 'sponsored'])).toEqual(['sponsored', 'ugc']);
    // Written as an attribute's words, by hand: what it meant is still read.
    expect(canonicalRels('sponsored nofollow')).toEqual(['nofollow', 'sponsored']);
    expect(canonicalRels('ugc,nofollow')).toEqual(['nofollow', 'ugc']);
    expect(canonicalRels({ nofollow: true })).toEqual([]);
    expect(canonicalRels(undefined)).toEqual([]);
    // An HTML attribute: any case, any whitespace, the security tokens left to the site.
    expect(relsFromAttribute(' UGC\tnoopener  Sponsored noreferrer\n')).toEqual(['sponsored', 'ugc']);
    expect(relsFromAttribute(null)).toEqual([]);
  });

  it('belong to a web address alone', () => {
    expect(linkRels({ type: 'url', target: SHOP, rel: ['sponsored'] })).toEqual(['sponsored']);
    expect(linkRels({ type: 'page', target: 'pg_x', rel: ['sponsored'] })).toEqual([]);
    expect(withRels({ type: 'url', target: SHOP }, ['ugc', 'nofollow'])).toEqual({ type: 'url', target: SHOP, rel: ['nofollow', 'ugc'] });
    expect(withRels({ type: 'url', target: SHOP, rel: ['ugc'] }, [])).toEqual({ type: 'url', target: SHOP });
    expect(withRels({ type: 'email', target: 'a@b.example', rel: ['ugc'] } as LinkValue, ['ugc'])).toEqual({ type: 'email', target: 'a@b.example' });
    expect(withRels({ type: 'page', target: 'pg_x', anchor: 'team' }, ['ugc'])).toEqual({ type: 'page', target: 'pg_x', anchor: 'team' });
  });

  it('render after a new tab’s security tokens, and are written after the destination in the text form', () => {
    expect(relAttribute(false, [])).toBeUndefined();
    expect(relAttribute(true, [])).toBe('noopener noreferrer');
    expect(relAttribute(false, ['nofollow', 'ugc'])).toBe('nofollow ugc');
    expect(relAttribute(true, ['sponsored'])).toBe('noopener noreferrer sponsored');
    expect(linkTitle(false, [])).toBe('');
    expect(linkTitle(true, [])).toBe(' "new tab"');
    expect(linkTitle(false, ['nofollow', 'sponsored'])).toBe(' "rel=nofollow,sponsored"');
    expect(linkTitle(true, ['ugc'])).toBe(' "new tab rel=ugc"');
    expect(linkTitle(true, ['nofollow', 'sponsored', 'ugc'])).toBe(' "new tab rel=nofollow,sponsored,ugc"');
  });
});

describe('a link’s relationships as an edit sends them', () => {
  const s = fresh();

  it('are kept on a web address, each once and in order, and left out when there are none', () => {
    expect(normalizeLink({ type: 'url', target: SHOP, rel: ['ugc', 'sponsored', 'ugc'] }, s, 'Link')).toEqual({ type: 'url', target: SHOP, rel: ['sponsored', 'ugc'] });
    expect(normalizeLink({ type: 'url', target: SHOP, newTab: true, rel: ['nofollow'] }, s, 'Link')).toEqual({ type: 'url', target: SHOP, newTab: true, rel: ['nofollow'] });
    expect(normalizeLink({ type: 'url', target: SHOP, rel: [] }, s, 'Link')).toEqual({ type: 'url', target: SHOP });
    expect(normalizeLink(`${SHOP}#deals`, s, 'Link')).toEqual({ type: 'url', target: `${SHOP}#deals` });
  });

  it('keep what they can say from anything else, and never refuse the edit over it', () => {
    // A stored link edited by hand goes back through here with every edit of what holds it, which may be about
    // something else entirely: it is read, never refused.
    const cases: Array<[unknown, string[] | undefined]> = [
      ['sponsored nofollow', ['nofollow', 'sponsored']],
      [['noopener', 'noreferrer'], undefined],
      [['Nofollow', 'bogus', 'ugc'], ['nofollow', 'ugc']],
      [[null, 7], undefined],
      [{ nofollow: true }, undefined],
      [null, undefined]
    ];
    for (const [rel, want] of cases) expect(normalizeLink({ type: 'url', target: SHOP, rel }, s, 'Link'), JSON.stringify(rel)).toEqual(want ? { type: 'url', target: SHOP, rel: want } : { type: 'url', target: SHOP });
  });

  it('go when the link no longer goes to another site', () => {
    const about = aboutOf(s);
    expect(normalizeLink({ type: 'page', target: about.id, rel: ['sponsored'] }, s, 'Link')).toEqual({ type: 'page', target: about.id });
    expect(normalizeLink({ type: 'email', target: 'hi@example.com', rel: ['ugc'] }, s, 'Link')).toEqual({ type: 'email', target: 'hi@example.com' });
    expect(normalizeLink({ type: 'none', target: '', rel: ['ugc'] }, s, 'Link')).toEqual({ type: 'none', target: '' });
    expect(normalizeLink({ type: 'tel', target: '+1 555 0100', rel: ['ugc'] }, s, 'Link')).toEqual({ type: 'tel', target: '+1 555 0100' });
    expect(normalizeLink({ type: 'page', target: about.id, anchor: 'team', newTab: true, rel: ['ugc'] }, s, 'Link')).toEqual({ type: 'page', target: about.id, anchor: 'team', newTab: true });
  });

  it('survive an operation’s own validation, which keeps only the fields it declares', () => {
    const op = {
      type: 'component.upsert',
      name: 'Affiliate button',
      description: 'One paid link.',
      category: 'conversion',
      properties: {},
      nodes: [
        { kind: 'element', id: 'root', tag: 'div', children: ['buy'] },
        { kind: 'link', id: 'buy', link: { type: 'url', target: SHOP, newTab: true, rel: ['sponsored'] }, label: 'Buy' }
      ]
    };
    const checked = validateOperation(op);
    expect(checked.ok).toBe(true);
    const nodes = (checked as { op: { nodes: Array<{ id: string; link?: unknown }> } }).op.nodes;
    expect(nodes.find((n) => n.id === 'buy')!.link).toEqual({ type: 'url', target: SHOP, newTab: true, rel: ['sponsored'] });
    expect(validateOperation({ ...op, nodes: [op.nodes[0], { ...op.nodes[1], link: { type: 'url', target: SHOP, rel: ['noopener'] } }] }).ok).toBe(false);
  });
});

describe('relationships in the text form', () => {
  const s = fresh();
  const about = aboutOf(s);
  const norm = (v: string) => normalizeRichText(v, s, 'Body');
  const p = (...spans: unknown[]) => ({ type: 'p', spans });

  it('are read after the destination, alone or after "new tab", in any order', () => {
    expect(norm(`[shop](${SHOP} "rel=sponsored,nofollow")`)).toEqual([p({ text: 'shop', link: { type: 'url', target: SHOP, rel: ['nofollow', 'sponsored'] } })]);
    expect(norm(`[shop](${SHOP} "new tab rel=ugc,ugc")`)).toEqual([p({ text: 'shop', link: { type: 'url', target: SHOP, newTab: true, rel: ['ugc'] } })]);
    expect(norm(`[shop](<${SHOP}a_(b)> "rel=nofollow")`)).toEqual([p({ text: 'shop', link: { type: 'url', target: `${SHOP}a_(b)`, rel: ['nofollow'] } })]);
    // Only a web address has any: written on a page link they say nothing.
    expect(norm(`[about](${about.route} "rel=nofollow")`)).toEqual([p({ text: 'about', link: { type: 'page', target: about.id } })]);
  });

  it('leave anything else written there as text, as before', () => {
    for (const v of [`[shop](${SHOP} "rel=noopener")`, `[shop](${SHOP} "sponsored")`, `[shop](${SHOP} "rel=")`, `[shop](${SHOP} "rel=nofollow,")`, `[shop](${SHOP} "rel=nofollow ugc")`, `[shop](${SHOP} "rel=nofollow new tab")`, `[shop](${SHOP} "")`])
      expect(norm(v), v).toEqual([p({ text: v })]);
    // All three, in any order.
    expect(norm(`[shop](${SHOP} "new tab rel=ugc,sponsored,nofollow")`)).toEqual([p({ text: 'shop', link: { type: 'url', target: SHOP, newTab: true, rel: ['nofollow', 'sponsored', 'ugc'] } })]);
    // Links without any read exactly as they always did.
    expect(norm(`[shop](${SHOP})`)).toEqual([p({ text: 'shop', link: { type: 'url', target: SHOP } })]);
    expect(norm(`[shop](${SHOP} "new tab")`)).toEqual([p({ text: 'shop', link: { type: 'url', target: SHOP, newTab: true } })]);
  });

  it('come back as they were written, in their canonical order', () => {
    const text = `[**Paid**](${SHOP} "new tab rel=sponsored")[*review*](${SHOP} "new tab rel=ugc") and [cited](https://cite.example/ "rel=nofollow") or [plain](https://plain.example/ "new tab")`;
    const blocks = norm(text);
    expect(blocks[0]).toMatchObject({ spans: [{ link: { rel: ['sponsored'] } }, { link: { rel: ['ugc'] } }, {}, { link: { rel: ['nofollow'] } }, {}, { link: { newTab: true } }] });
    expect(richTextToMarkdown(blocks, s.pages)).toBe(text);
    expect(normalizeRichText(richTextToMarkdown(blocks, s.pages), s, 'Body')).toEqual(blocks);
    // A stored value with tokens out of order, or a hand-edited string, writes only what it means.
    expect(richTextToMarkdown([p({ text: 'x', link: { type: 'url', target: SHOP, rel: ['ugc', 'nofollow', 'bogus'] } })] as never, s.pages)).toBe(`[x](${SHOP} "rel=nofollow,ugc")`);
    expect(richTextToMarkdown([p({ text: 'x', link: { type: 'url', target: SHOP, rel: 'nofollow' } })] as never, s.pages)).toBe(`[x](${SHOP} "rel=nofollow")`);
    expect(richTextToMarkdown([p({ text: 'x', link: { type: 'url', target: SHOP, rel: { nofollow: true } } })] as never, s.pages)).toBe(`[x](${SHOP})`);
  });

  it('are found in a line as the parser reads them', () => {
    const tokens = linkTokens(`a [b](${SHOP} "rel=ugc") [c](${SHOP} "rel=bad") [d](${SHOP} "new tab rel=nofollow")`, (t, n, r) => linkFromTarget(t, s.pages, n, r));
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toMatchObject({ target: SHOP, newTab: false, rel: ['ugc'] });
    expect(tokens[1]).toMatchObject({ target: SHOP, newTab: true, rel: ['nofollow'] });
    expect(parseRichText(`[b](${SHOP} "rel=ugc")`, { markdown: true })).toEqual([p({ text: `[b](${SHOP} "rel=ugc")` })]);
  });
});

describe('the rich text link field', () => {
  const s = fresh();
  const at = (marked: string) => {
    const start = marked.indexOf('|');
    const text = marked.replace('|', '');
    return { text, start, end: start };
  };
  const after = (a: { text: string }, edit: ReturnType<typeof setLink>) => {
    if (typeof edit === 'string') throw new Error(edit);
    return a.text.slice(0, edit.from) + edit.insert + a.text.slice(edit.to);
  };

  it('keeps two neighbouring links to one address that say different things apart', () => {
    const a = at(`[**Pa|id**](${SHOP} "new tab rel=sponsored")[*review*](${SHOP} "new tab rel=ugc")`);
    const found = linkAt(a, s.pages);
    expect(found).toMatchObject({ kind: 'link' });
    expect((found as { tokens: unknown[] }).tokens).toHaveLength(1);
    // Re-pointed without saying, a link keeps its own, and its new tab; its neighbour is left alone.
    expect(after(a, setLink(a, s.pages, typedLink('shop.example/b', s.pages)!))).toBe(`[**Paid**](${SHOP}b "new tab rel=sponsored")[*review*](${SHOP} "new tab rel=ugc")`);
  });

  it('writes the relationships it is given, and clears them all when given none', () => {
    const a = at(`See [th|e shop](${SHOP} "rel=sponsored") now`);
    expect(after(a, setLink(a, s.pages, typedLink(SHOP, s.pages)!, ['nofollow', 'sponsored']))).toBe(`See [the shop](${SHOP} "rel=nofollow,sponsored") now`);
    expect(after(a, setLink(a, s.pages, typedLink(SHOP, s.pages)!, []))).toBe(`See [the shop](${SHOP}) now`);
    // A page has none to keep.
    expect(after(a, setLink(a, s.pages, typedLink('/about/', s.pages)!, ['sponsored']))).toBe('See [the shop](/about/) now');
    // New words linked to a web address take them.
    const words = { text: 'See the shop now', start: 4, end: 12 };
    expect(after(words, setLink(words, s.pages, typedLink(SHOP, s.pages)!, ['ugc']))).toBe(`See [the shop](${SHOP} "rel=ugc") now`);
  });
});

describe('relationships read back from a page', () => {
  const s = fresh();

  it('come from the copy the canvas sends, which may carry them', () => {
    expect(richDom([{ tag: 'p', children: [{ tag: 'a', href: SHOP, rel: ['sponsored'], children: ['x'] }] }])).not.toBeNull();
    expect(richDom([{ tag: 'a', href: SHOP, rel: 'sponsored', children: ['x'] }])).toBeNull();
    expect(richDom([{ tag: 'a', href: SHOP, rel: ['a', 'b', 'c', 'd'], children: ['x'] }])).toBeNull();
    const { blocks } = blocksFromDom([{ tag: 'p', children: [{ tag: 'a', href: SHOP, newTab: true, rel: ['ugc', 'bogus'], children: ['x'] }, ' ', { tag: 'a', href: '/about/', rel: ['ugc'], children: ['y'] }] }], s.pages);
    expect(blocks).toEqual([{ type: 'p', spans: [{ text: 'x', link: { type: 'url', target: SHOP, newTab: true, rel: ['ugc'] } }, { text: ' ' }, { text: 'y', link: { type: 'page', target: aboutOf(s).id } }] }]);
  });

  it('come from the Posts writer’s anchor, which the link dialog changes, never from the link it kept for the anchor', () => {
    // The writer keeps each link's stored destination on its anchor (data-link) and reads it back as so-link:…, so a
    // page link survives its page's address changing. The anchor's own rel is what the author last ticked.
    const kept = (l: LinkValue) => `so-link:${JSON.stringify(l)}`;
    const links = articleLinks(s);
    expect(links.link(kept({ type: 'url', target: SHOP, rel: ['sponsored'] }), false, [])).toEqual({ type: 'url', target: SHOP });
    expect(links.link(kept({ type: 'url', target: SHOP, newTab: true }), true, ['ugc', 'nofollow'])).toEqual({ type: 'url', target: SHOP, newTab: true, rel: ['nofollow', 'ugc'] });
    expect(links.link(kept({ type: 'page', target: aboutOf(s).id }), false, ['ugc'])).toEqual({ type: 'page', target: aboutOf(s).id });
    // A link typed in the writer since: read from its address.
    expect(links.link(SHOP, false, ['sponsored'])).toEqual({ type: 'url', target: SHOP, rel: ['sponsored'] });
    // The whole text, as the writer reads its anchors.
    const { blocks } = blocksFromDom([{ tag: 'p', children: [{ tag: 'a', href: kept({ type: 'url', target: SHOP, rel: ['sponsored'] }), children: ['deal'] }] }], s.pages, links);
    expect(blocks).toEqual([{ type: 'p', spans: [{ text: 'deal', link: { type: 'url', target: SHOP } }] }]);
  });

  it('come with an imported post’s links to other sites', () => {
    const report = emptyReport();
    const read = (html: string) => htmlToRichText(html, { link: (href, newTab, rel) => linkFromTarget(href, {}, newTab, rel), image: () => null }, report);
    expect(read(`<p><a href="${SHOP}" target="_blank" rel="Sponsored noopener nofollow">deal</a> <a href="${SHOP}" rel="noopener">plain</a></p>`)).toEqual([
      { type: 'p', spans: [{ text: 'deal', link: { type: 'url', target: SHOP, newTab: true, rel: ['nofollow', 'sponsored'] } }, { text: ' ' }, { text: 'plain', link: { type: 'url', target: SHOP } }] }
    ]);
  });
});

describe('a link as the site renders it', () => {
  const s = fresh();

  it('has the whole rel attribute only when the author said something, and is the object it was otherwise', () => {
    expect(resolveLink({ type: 'url', target: SHOP }, { state: s })).toEqual({ href: SHOP });
    expect(resolveLink({ type: 'url', target: SHOP, newTab: true }, { state: s })).toEqual({ href: SHOP, newTab: true });
    expect(resolveLink({ type: 'url', target: SHOP, rel: ['ugc', 'nofollow', 'ugc'] }, { state: s })).toEqual({ href: SHOP, rel: 'nofollow ugc' });
    expect(resolveLink({ type: 'url', target: SHOP, newTab: true, rel: ['ugc', 'sponsored'] }, { state: s })).toEqual({ href: SHOP, newTab: true, rel: 'noopener noreferrer sponsored ugc' });
    // A hand edit is read for what it can say; a link to this site says nothing.
    expect(resolveLink({ type: 'url', target: SHOP, rel: 'nofollow external' } as never, { state: s })).toEqual({ href: SHOP, rel: 'nofollow' });
    expect(resolveLink({ type: 'url', target: SHOP, rel: ['noopener'] } as never, { state: s })).toEqual({ href: SHOP });
    expect(resolveLink({ type: 'page', target: aboutOf(s).id, rel: ['nofollow'] } as LinkValue, { state: s })).toEqual({ href: '/about/' });
  });
});

describe('a theme header installed before links had relationships', () => {
  const old = JSON.parse(readFileSync('tests/unit/fixtures/v1-project/siteorigin/components/foundation.shell.header/component.json', 'utf8')).source as string;

  it('renders them from the link it is given, and what it always did for a link without', () => {
    expect(old).toContain("rel={ctaLink.newTab ? 'noopener noreferrer' : undefined}");
    const now = withAuthoredRel(old);
    expect(now).toContain("rel={ctaLink.rel ?? (ctaLink.newTab ? 'noopener noreferrer' : undefined)}");
    expect(now).toContain("rel={item.link?.rel ?? (item.link?.newTab ? 'noopener noreferrer' : undefined)}");
    expect(now).not.toMatch(/rel=\{[\w$.?]+\.newTab \?/);
    // Nothing else in it changes, and the current header is left as it is.
    expect(now.replace(/[\w.?]+\.rel \?\? \(([^)]*)\)/g, '$1')).toBe(old);
    expect(withAuthoredRel(now)).toBe(now);
  });

  it('is given them when the site is generated, while a component of the author’s own is left as written', () => {
    const s = fresh();
    const header = s.components['foundation.shell.header'];
    expect(header).toMatchObject({ kind: 'code', owner: 'theme' });
    header.source = old;
    const own = { ...header, id: 'cmp_own_header', owner: 'project' as const, source: old };
    s.components[own.id] = own;
    const files = generateProject(s);
    expect(files.get(defFile(header))).toContain("rel={ctaLink.rel ?? (ctaLink.newTab ? 'noopener noreferrer' : undefined)}");
    expect(files.get(defFile(own))).toBe(old);
  });
});
