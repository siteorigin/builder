/**
 * Page addresses in any script (#36): a page titled お問い合わせ gets /お問い合わせ/, the address can be typed in
 * the Page address field, two titles that read the same are numbered apart, and the website is generated at the
 * address as written, escaped only where it leaves as an absolute URL. ASCII addresses stay what they were.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { generateProject, pageFile, redirectFile } from '@generator/index';
import { linkFromTarget } from '@shared/richtext';
import { normalizeRichText } from '@engine/values';
import { toolDefinitions } from '@agent/tools';

const blank = () => createStarterState('blank', '灯台', false);
const byTitle = (s: ProjectState, title: string) => Object.values(s.pages).find((p) => p.title === title)!;
const errors = (s: ProjectState) => validateState(s).filter((d) => d.severity === 'error');

describe('page addresses in other scripts', () => {
  it('gives a page titled in Japanese its natural address, and lets it be typed', () => {
    let s = applyOperations(blank(), [{ type: 'page.create', pageId: 'pg_contact1', title: 'お問い合わせ', addToNavigation: true }]).state;
    expect(s.pages.pg_contact1.route).toBe('/お問い合わせ/');
    // What the Page address field commits: the address typed, or copied from a browser with its escapes.
    s = applyOperations(s, [{ type: 'page.update', pageId: 'pg_contact1', route: '/連絡先/' }]).state;
    expect(s.pages.pg_contact1.route).toBe('/連絡先/');
    s = applyOperations(s, [{ type: 'page.update', pageId: 'pg_contact1', route: encodeURI('/お問い合わせ/') }]).state;
    expect(s.pages.pg_contact1.route).toBe('/お問い合わせ/');
    // The address it left keeps leading to it.
    expect(s.site.redirects).toEqual([{ from: '/連絡先/', pageId: 'pg_contact1' }]);
    expect(errors(s)).toEqual([]);
  });

  it('numbers two titles that read the same apart, and refuses an address another page already has', () => {
    const r = applyOperations(blank(), [
      { type: 'page.create', pageId: 'pg_cafe0001', title: 'カフェ' },
      { type: 'page.create', pageId: 'pg_cafe0002', title: 'ｶﾌｪ' },
      { type: 'page.create', pageId: 'pg_cafe0003', title: 'カフェ'.normalize('NFD') }
    ]);
    expect(['pg_cafe0001', 'pg_cafe0002', 'pg_cafe0003'].map((id) => r.state.pages[id].route)).toEqual(['/カフェ/', '/カフェ-2/', '/カフェ-3/']);
    // Typed in another spelling, the address is the same one, and taken.
    expect(() => applyOperations(r.state, [{ type: 'page.create', title: 'Menu', route: '/ｶﾌｪ/' }])).toThrow('Another page already uses /カフェ/.');
    expect(() => applyOperations(r.state, [{ type: 'page.update', pageId: 'pg_cafe0002', route: '/ｶﾌｪ/' }])).toThrow('Another page already uses /カフェ/.');
    expect(errors(r.state)).toEqual([]);
  });

  it('keeps ASCII titles at the addresses they always had', () => {
    const r = applyOperations(blank(), [
      { type: 'page.create', pageId: 'pg_about001', title: 'About Us' },
      { type: 'page.create', pageId: 'pg_cafe0001', title: 'Café & Bar!' },
      { type: 'page.create', pageId: 'pg_about002', title: 'About us' }
    ]);
    expect(['pg_about001', 'pg_cafe0001', 'pg_about002'].map((id) => r.state.pages[id].route)).toEqual(['/about-us/', '/cafe-and-bar/', '/about-us-2/']);
  });

  it('refuses a stored address spelled another way', () => {
    const s = applyOperations(blank(), [{ type: 'page.create', pageId: 'pg_cafe0001', title: 'カフェ' }]).state;
    s.pages.pg_cafe0001.route = '/ｶﾌｪ/';
    expect(errors(s).map((d) => d.message).join('\n')).toMatch(/must be written "カフェ"/);
  });

  it('generates the page at its address as written, escaping it only in absolute URLs', () => {
    const made = applyOperations(blank(), [
      { type: 'page.create', pageId: 'pg_contact1', title: 'お問い合わせ', addToNavigation: true },
      { type: 'page.create', pageId: 'pg_access01', title: 'アクセス', route: '/お問い合わせ/アクセス/' }
    ]).state;
    const s = applyOperations(made, [{ type: 'page.update', pageId: 'pg_access01', route: '/会社/アクセス/' }]).state;
    s.site.baseUrl = 'https://example.com';
    const files = generateProject(s);
    expect(pageFile(s.pages.pg_contact1)).toBe('src/routes/お問い合わせ/+page.svelte');
    const page = files.get('src/routes/お問い合わせ/+page.svelte')!;
    const escaped = 'https://example.com/%E3%81%8A%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B/';
    expect(page).toContain(`<link rel="canonical" href={${JSON.stringify(escaped)}} />`);
    expect(page).toContain(`content={${JSON.stringify(escaped)}}`);
    expect(files.get('static/sitemap.xml')).toContain(`<loc>${escaped}</loc>`);
    expect(files.get('static/sitemap.xml')).not.toMatch(/[^\x00-\x7f]/);
    // The header links to it as written; browsers escape it.
    expect(files.get('src/routes/+layout.svelte')).toContain('"/お問い合わせ/"');
    // An old address in another script leads on to the new one, and names the new one as canonical, escaped.
    const redirect = files.get(redirectFile('/お問い合わせ/アクセス/'))!;
    expect(redirect).toContain('resolve("/会社/アクセス/")');
    expect(redirect).toContain(`<link rel="canonical" href={${JSON.stringify(`https://example.com${encodeURI('/会社/アクセス/')}`)}} />`);
  });

  it('finds the page for a link to its address, as written or escaped as a browser copies it', () => {
    const s = applyOperations(blank(), [{ type: 'page.create', pageId: 'pg_contact1', title: 'お問い合わせ' }]).state;
    expect(linkFromTarget('/お問い合わせ/', s.pages)).toEqual({ type: 'page', target: 'pg_contact1' });
    expect(linkFromTarget(`${encodeURI('/お問い合わせ/')}#form`, s.pages)).toEqual({ type: 'page', target: 'pg_contact1', anchor: 'form' });
    const text = normalizeRichText(`[Write to us](${encodeURI('/お問い合わせ')})`, s, 'Text');
    expect(JSON.stringify(text)).toContain('"target":"pg_contact1"');
    // Escaped once is the page; escaped twice is an address with "%" in it, which no page has.
    expect(linkFromTarget(encodeURI(encodeURI('/お問い合わせ/')), s.pages)).toBeNull();
  });
});

describe('collection entries in other scripts', () => {
  it('gives an entry titled in Japanese its natural slug, numbered apart from one that reads the same', () => {
    const r = applyOperations(blank(), [
      { type: 'collection.create', collectionId: 'posts', route: '/お知らせ/' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_sale0001', title: '春のセール' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_sale0002', title: '春のｾｰﾙ' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_hours001', title: 'Hours', slug: '営業時間' }
    ]);
    const entries = r.state.collections.posts.entries;
    expect([entries.en_sale0001.slug, entries.en_sale0002.slug, entries.en_hours001.slug]).toEqual(['春のセール', '春のセール-2', '営業時間']);
    expect(() => applyOperations(r.state, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_hours001', slug: 'Not a slug!' }])).toThrow(/is not a slug/);
    expect(errors(r.state)).toEqual([]);
    for (const e of Object.values(entries)) e.draft = false;
    r.state.site.baseUrl = 'https://example.com';
    let files = generateProject(r.state);
    expect(files.get('static/sitemap.xml')).toContain(`<loc>https://example.com${encodeURI('/お知らせ/春のセール/')}</loc>`);
    const entryPage = [...files.entries()].find(([path, src]) => path.startsWith('src/routes/') && src.includes('canonical') && src.includes(encodeURI('/お知らせ/春のセール-2/')));
    expect(entryPage, 'an entry names its escaped address as canonical').toBeTruthy();
    // A slug stored in another spelling, or holding a folder, is refused, and given no page.
    r.state.collections.posts.entries.en_sale0002.slug = '春のｾｰﾙ';
    r.state.collections.posts.entries.en_hours001.slug = '営業/時間';
    expect(errors(r.state).filter((d) => d.code === 'ROUTE_INVALID')).toHaveLength(2);
    files = generateProject(r.state);
    expect(files.get('static/sitemap.xml')).not.toContain(encodeURI('ｾｰﾙ'));
    expect(files.get('static/sitemap.xml')).not.toContain(encodeURI('営業'));
  });
});

describe('the assistant', () => {
  it('is told page addresses may be in any script', () => {
    const apply = JSON.stringify(toolDefinitions().find((t) => t.name === 'apply_operations')!.parameters);
    expect(apply).toContain('Static route such as \\"/services/\\" or \\"/お問い合わせ/\\": lowercase letters, numbers and hyphens, in any script.');
  });
});
