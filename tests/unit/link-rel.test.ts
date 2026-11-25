/**
 * A link to another site can say what it is to search engines (#582): `nofollow`, `sponsored` and `ugc`, stored on a
 * web address link as `rel`, written in the text form after its destination, and rendered after the security tokens a
 * new tab adds.
 */
import { describe, expect, it } from 'vitest';
import type { LinkValue, ProjectState } from '@shared/types';
import { validateOperation } from '@shared/ops';
import { canonicalRels, linkRels, linkTitle, relAttribute, relsFromAttribute, withRels } from '@shared/link-rel';
import { linkFromTarget, linkTokens, parseRichText, richTextToMarkdown } from '@shared/richtext';
import { blocksFromDom } from '@shared/richtext-tree';
import { createStarterState } from '@catalogue/starters';
import { normalizeLink, normalizeRichText } from '@engine/values';
import { resolveLink } from '@generator/index';
import { linkAt, setLink, typedLink } from '../../src/renderer/src/lib/richtext-commands';
import { richDom } from '../../src/renderer/src/lib/richtext';
import { emptyReport, htmlToRichText } from '../../src/main/posts-import/html';

const fresh = () => createStarterState('business', 'Test Studio', false);
const aboutOf = (s: ProjectState) => Object.values(s.pages).find((p) => p.title === 'About')!;
const SHOP = 'https://shop.example/';

describe('the stored relationships', () => {
  it('reads only the three it knows, each once, in their own order', () => {
    expect(canonicalRels(['ugc', 'nofollow', 'ugc', 'sponsored'])).toEqual(['nofollow', 'sponsored', 'ugc']);
    expect(canonicalRels(['noopener', 'NOFOLLOW', 'external', 7, null])).toEqual([]);
    expect(canonicalRels('nofollow')).toEqual([]);
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
  });
});

describe('a link’s relationships as an edit sends them', () => {
  const s = fresh();

  it('are kept on a web address, each once and in order, and left out when there are none', () => {
    expect(normalizeLink({ type: 'url', target: SHOP, rel: ['ugc', 'sponsored', 'ugc'] }, s, 'Link')).toEqual({ type: 'url', target: SHOP, rel: ['sponsored', 'ugc'] });
    expect(normalizeLink({ type: 'url', target: SHOP, newTab: true, rel: ['nofollow'] }, s, 'Link')).toEqual({ type: 'url', target: SHOP, newTab: true, rel: ['nofollow'] });
    expect(normalizeLink({ type: 'url', target: SHOP, rel: [] }, s, 'Link')).toEqual({ type: 'url', target: SHOP });
  });

  it('refuse anything but a list of the three, naming them', () => {
    for (const rel of ['nofollow', ['noopener'], ['Nofollow'], [null], { nofollow: true }, null])
      expect(() => normalizeLink({ type: 'url', target: SHOP, rel }, s, 'Button link'), JSON.stringify(rel)).toThrow(/Button link: rel is a list of "nofollow", "sponsored", "ugc"/);
  });

  it('go when the link no longer goes to another site', () => {
    const about = aboutOf(s);
    expect(normalizeLink({ type: 'page', target: about.id, rel: ['sponsored'] }, s, 'Link')).toEqual({ type: 'page', target: about.id });
    expect(normalizeLink({ type: 'email', target: 'hi@example.com', rel: ['ugc'] }, s, 'Link')).toEqual({ type: 'email', target: 'hi@example.com' });
    expect(normalizeLink({ type: 'none', target: '', rel: ['ugc'] }, s, 'Link')).toEqual({ type: 'none', target: '' });
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
    for (const v of [`[shop](${SHOP} "rel=noopener")`, `[shop](${SHOP} "sponsored")`, `[shop](${SHOP} "rel=")`, `[shop](${SHOP} "rel=nofollow new tab")`, `[shop](${SHOP} "")`]) expect(norm(v), v).toEqual([p({ text: v })]);
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
    expect(richTextToMarkdown([p({ text: 'x', link: { type: 'url', target: SHOP, rel: 'nofollow' } })] as never, s.pages)).toBe(`[x](${SHOP})`);
  });

  it('are found in a line as the parser reads them', () => {
    const tokens = linkTokens(`a [b](${SHOP} "rel=ugc") [c](${SHOP} "rel=bad")`, (t, n, r) => linkFromTarget(t, s.pages, n, r));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ target: SHOP, newTab: false, rel: ['ugc'] });
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

  it('come with an imported post’s links to other sites', () => {
    const report = emptyReport();
    const read = (html: string) => htmlToRichText(html, { link: (href, newTab, rel) => linkFromTarget(href, {}, newTab, rel) }, report);
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
    expect(resolveLink({ type: 'url', target: SHOP, newTab: true, rel: ['sponsored'] }, { state: s })).toEqual({ href: SHOP, newTab: true, rel: 'noopener noreferrer sponsored' });
    // A hand edit that holds something else, or a link to this site, says nothing.
    expect(resolveLink({ type: 'url', target: SHOP, rel: 'nofollow' } as never, { state: s })).toEqual({ href: SHOP });
    expect(resolveLink({ type: 'page', target: aboutOf(s).id, rel: ['nofollow'] } as LinkValue, { state: s })).toEqual({ href: '/about/' });
  });
});
