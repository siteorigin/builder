/**
 * Text direction and what a generated site says on its own (issue #71): the way a language is written, the author's
 * choice of direction, the built-in and the author's own wording for the skip link, the menu button, landmarks and a
 * form's progress, and a site in Arabic, Hebrew and English as a visitor's browser runs it: the layout, the header
 * and the footer exactly as the export ships them, at desktop and phone widths, moving between pages in different
 * languages without a reload.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { compile, compileModule } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { installComponent, makeInstance } from '@engine/install';
import { RUNTIME_DIR, STYLES_DIR, generateProject, routeId } from '@generator/index';
import { languageDirection, pageDirection, siteDirection } from '@shared/languages';
import { VISITOR_TEXT_GROUPS, VISITOR_TEXT_KEYS, builtInVisitorText, resolveVisitorText, visitorTextFor } from '@shared/visitor-text';
import { notFoundCopy } from '@shared/not-found';

const fresh = () => createStarterState('business', 'Test Studio', false);
const apply = (s: ProjectState, ...ops: Parameters<typeof applyOperations>[1]) => applyOperations(s, ops).state;
const byTitle = (s: ProjectState, title: string) => Object.values(s.pages).find((p) => p.title === title)!;

describe('the way a language is written', () => {
  it('runs right to left for Arabic, Hebrew and their kin, and by the script a code names', () => {
    for (const code of ['ar', 'AR', 'ar-EG', 'arz', 'ary', 'ARZ-EG', 'ary-MA', 'arz-Arab', 'apc', 'acm', 'aeb', 'afb', 'ajp', 'arb', 'bgn', 'mey', 'mey-MR', 'jrb', 'he', 'iw', 'he-IL', 'fa', 'fa-IR', 'ur', 'ps', 'dv', 'yi', 'ckb', 'syr', 'az-Arab', 'ku-Arab', 'pa-Arab', 'zh-Hebr']) expect(languageDirection(code), code).toBe('rtl');
    for (const code of ['en', 'en-GB', 'fr-CA', 'de', 'zh-Hant-TW', 'ja', 'ar-Latn', 'arz-Latn', 'ary-Latn', 'acy', 'pga', 'xaa', 'mey-SN', 'az-Latn', 'az', 'ku', 'sr-Cyrl']) expect(languageDirection(code), code).toBe('ltr');
    // A language written in another script in one region goes that script's way there (Unicode's likely subtags).
    for (const code of ['pa-PK', 'az-IR', 'ku-IQ', 'ku-IR', 'uz-AF', 'tg-PK', 'kk-CN', 'ky-CN']) expect(languageDirection(code), code).toBe('rtl');
    for (const code of ['pa', 'pa-IN', 'az-AZ', 'sd-IN', 'pa-Guru-PK']) expect(languageDirection(code), code).toBe('ltr');
    expect(languageDirection('sd')).toBe('rtl');
  });

  it('follows the site’s choice on pages in its language, and each other language’s own way', () => {
    const site = { language: 'ar' };
    expect(siteDirection(site)).toBe('rtl');
    expect(siteDirection({ language: 'en', direction: 'rtl' })).toBe('rtl');
    expect(siteDirection({ language: 'ar', direction: 'ltr' })).toBe('ltr');
    // Hand-edited nonsense is no choice.
    expect(siteDirection({ language: 'ar', direction: 'sideways' as never })).toBe('rtl');
    expect(siteDirection({ language: '?' })).toBe('ltr');
    const chosen = { language: 'ar', direction: 'ltr' as const };
    expect(pageDirection(chosen, {})).toBe('ltr');
    expect(pageDirection(chosen, { language: 'AR' })).toBe('ltr');
    expect(pageDirection(chosen, { language: 'he' })).toBe('rtl');
    expect(pageDirection(chosen, { language: 'fr' })).toBe('ltr');
  });
});

describe('visitor text', () => {
  it('has every piece in every built-in language, with the same names to fill', () => {
    const fields = VISITOR_TEXT_GROUPS.flatMap((g) => g.fields);
    expect(fields.map((f) => f.key).sort()).toEqual([...VISITOR_TEXT_KEYS].sort());
    for (const code of ['en', 'ar', 'he']) {
      const text = builtInVisitorText(code);
      for (const f of fields) {
        expect(text[f.key].trim(), `${code} ${f.key}`).not.toBe('');
        expect([...text[f.key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(), `${code} ${f.key}`).toEqual([...(f.fills ?? [])].sort());
      }
    }
    expect(builtInVisitorText('ar').menu).toBe('القائمة');
    expect(builtInVisitorText('iw')).toBe(builtInVisitorText('he'));
    // A language without wording of its own reads English.
    expect(builtInVisitorText('fr-CA')).toBe(builtInVisitorText('en'));
  });

  it('takes the author’s wording for the exact language, then its primary language, then the built-in wording', () => {
    const site = { visitorText: { ar: { menu: 'اعرض القائمة', skipLink: 'إلى المحتوى' }, 'ar-eg': { skipLink: 'على طول للمحتوى' }, fr: { menu: 'Ouvrir le menu' } } };
    expect(visitorTextFor(site, 'ar')).toMatchObject({ menu: 'اعرض القائمة', skipLink: 'إلى المحتوى', mainNav: 'القائمة الرئيسية' });
    expect(visitorTextFor(site, 'ar-EG')).toMatchObject({ menu: 'اعرض القائمة', skipLink: 'على طول للمحتوى' });
    expect(visitorTextFor(site, 'fr')).toMatchObject({ menu: 'Ouvrir le menu', mainNav: 'Main' });
    // Hebrew never takes Arabic wording.
    expect(visitorTextFor(site, 'he').menu).toBe('תפריט');
    // site.json edited by hand: anything but text, or text that shows nothing, is no wording.
    for (const visitorText of [null, 'x', [], { ar: 'x' }, { ar: { menu: 7 } }, { ar: { menu: ' \u200b ' } }] as unknown[])
      expect(visitorTextFor({ visitorText } as never, 'ar').menu).toBe('القائمة');
  });

  it('names the pieces that fall back to English on a page in another language, and only those (issue #1464)', () => {
    const site = { visitorText: { ar: { menu: 'اعرض القائمة' }, fr: { menu: 'Menu', skipLink: ' \u200b ' } } };
    // French and Urdu have no built-in wording: every piece the author left is English. The author's own French
    // "Menu" is French, even though it reads the same as the English.
    const fr = resolveVisitorText(site, 'fr');
    expect(fr.english).toEqual(VISITOR_TEXT_KEYS.filter((k) => k !== 'menu'));
    expect(fr.english).toContain('skipLink');
    expect(resolveVisitorText(site, 'fr-CA').english).toEqual(fr.english);
    expect(resolveVisitorText({ visitorText: { 'fr-ca': { mainNav: 'Principal' }, ...site.visitorText } }, 'fr-CA').english).toEqual(fr.english.filter((k) => k !== 'mainNav'));
    expect(resolveVisitorText(site, 'ur').english).toEqual([...VISITOR_TEXT_KEYS]);
    expect(resolveVisitorText(site, 'fr').words).toMatchObject({ menu: 'Menu', skipLink: 'Skip to content', mainNav: 'Main' });
    // English pages, and languages with built-in wording or the author's, have nothing to mark.
    for (const code of ['en', 'en-GB', 'EN-us', 'ar', 'ar-MA', 'he', 'iw']) expect(resolveVisitorText(site, code).english, code).toEqual([]);
  });

  it('is set piece by piece through the site’s settings, and cleared back to the built-in wording', () => {
    let s = apply(fresh(), { type: 'site.update', visitorText: { language: 'AR', text: { menu: '  اعرض القائمة  ', skipLink: 'إلى المحتوى' } } });
    expect(s.site.visitorText).toEqual({ ar: { menu: 'اعرض القائمة', skipLink: 'إلى المحتوى' } });
    s = apply(s, { type: 'site.update', visitorText: { language: 'he', text: { menu: 'תפריט' } } });
    // One piece changes without touching the others.
    s = apply(s, { type: 'site.update', visitorText: { language: 'ar', text: { skipLink: '' } } });
    expect(s.site.visitorText).toEqual({ ar: { menu: 'اعرض القائمة' }, he: { menu: 'תפריט' } });
    // Wording that shows nothing clears it; a language left with none goes, and so does the map.
    s = apply(s, { type: 'site.update', visitorText: { language: 'ar', text: { menu: '\u200b' } } });
    s = apply(s, { type: 'site.update', visitorText: { language: 'he', text: { menu: ' ' } } });
    expect(s.site.visitorText).toBeUndefined();
    expect(() => apply(s, { type: 'site.update', visitorText: { language: '__proto__', text: { menu: 'x' } } })).toThrow(/Language must be a code/);
    // A piece that does not exist is turned down, naming the ones that do, even beside real ones.
    expect(() => apply(s, { type: 'site.update', visitorText: { language: 'ar', text: { nonsense: 'x' } } })).toThrow(/“nonsense” is not a piece of visitor text\. Use one of: skipLink, menu,/);
    expect(() => apply(s, { type: 'site.update', visitorText: { language: 'ar', text: { '': 'x', menu: 'y' } } })).toThrow(/“” is not a piece of visitor text/);
    // Wording kept by hand under another case is read, and folded under the lower-case code by the next edit.
    const hand = structuredClone(s);
    hand.site.visitorText = { 'Ar-Eg': { menu: 'اعرض', skipLink: '\u200b', mainNav: 7 } } as never;
    expect(visitorTextFor(hand.site, 'ar-EG')).toMatchObject({ menu: 'اعرض', skipLink: 'انتقل إلى المحتوى', mainNav: 'القائمة الرئيسية' });
    expect(apply(hand, { type: 'site.update', visitorText: { language: 'ar-EG', text: { mainNav: 'الرئيسية' } } }).site.visitorText).toEqual({ 'ar-eg': { menu: 'اعرض', mainNav: 'الرئيسية' } });
    // Kept under two spellings, each piece comes from the lower-case one first, then the others; an edit keeps them all.
    hand.site.visitorText = { 'AR-EG': { skipLink: 'تخطَّ', menu: 'قديم' }, 'ar-eg': { menu: 'اعرض' } };
    expect(visitorTextFor(hand.site, 'ar-eg')).toMatchObject({ menu: 'اعرض', skipLink: 'تخطَّ' });
    expect(apply(hand, { type: 'site.update', visitorText: { language: 'ar-eg', text: { mainNav: 'الرئيسية' } } }).site.visitorText).toEqual({ 'ar-eg': { menu: 'اعرض', skipLink: 'تخطَّ', mainNav: 'الرئيسية' } });
  });

  it('gives the not-found page its default wording in the site’s language', () => {
    expect(notFoundCopy({ language: 'ar' }).heading).toBe('الصفحة غير موجودة');
    expect(notFoundCopy({ language: 'he-IL' }).linkLabel).toBe('מעבר לדף הבית');
    expect(notFoundCopy({ language: 'ar', notFoundHeading: 'لا شيء هنا' }).heading).toBe('لا شيء هنا');
    expect(notFoundCopy({ language: 'fr' }).heading).toBe('Page not found');
  });
});

describe('the generated wording', () => {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'visitor-text-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('carries the wording of each language the site’s pages are in, and fills names in once', async () => {
    let s = apply(fresh(), { type: 'site.update', language: 'ar', visitorText: { language: 'ar', text: { menu: 'اعرض القائمة' } } });
    const about = byTitle(s, 'About').id;
    s = apply(s, { type: 'page.update', pageId: about, language: 'he' });
    const files = generateProject(s);
    const module = files.get(`${RUNTIME_DIR}/visitor-text.js`)!;
    expect(module).toContain('const SITE = "ar";');
    expect(module).toContain('"menu": "اعرض القائمة"');
    expect(module).toContain('"menu": "תפריט"');
    // Only the languages in use: no English.
    expect(module).not.toContain('"Menu"');
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    writeFileSync(join(dir, 'runtime', 'visitor-text.js'), module);
    const { fill, fillParts } = (await import(/* @vite-ignore */ pathToFileURL(join(dir, 'runtime', 'visitor-text.js')).href)) as {
      fill: (t: string, v: Record<string, unknown>) => string;
      fillParts: (t: string, v: Record<string, unknown>) => Array<{ text: string; name?: string }>;
    };
    // What goes in is never read for names: a search for "{shown}" says just that.
    expect(fill('{count} pages match “{query}”. The first {shown} are shown.', { count: 3, query: '{shown}', shown: 2 })).toBe('3 pages match “{shown}”. The first 2 are shown.');
    expect(fill('{index} of {count} {other}', { index: 1, count: 2 })).toBe('1 of 2 {other}');
    expect(fillParts('{count} pages match “{query}”, {other}', { count: 3, query: 'x' })).toEqual([{ text: '3', name: 'count' }, { text: ' pages match “' }, { text: 'x', name: 'query' }, { text: '”, {other}' }]);
    expect(fillParts('لا توجد صفحات تطابق «{query}».', { query: 'Studio 5' })).toEqual([{ text: 'لا توجد صفحات تطابق «' }, { text: 'Studio 5', name: 'query' }, { text: '».' }]);
    // A site in one language carries that language alone, and its layout names no other.
    const one = generateProject(fresh());
    expect(one.get(`${RUNTIME_DIR}/visitor-text.js`)).toContain('const SITE = "en";');
    expect(one.get('src/routes/+layout.svelte')).toContain("import { visitorText, visitorTextLang } from '../lib/siteorigin/runtime/visitor-text.js';");
    // An English site has no English to mark.
    expect(one.get(`${RUNTIME_DIR}/visitor-text.js`)).toContain('const ENGLISH = {};');
    expect(one.get('src/routes/+layout.svelte')).not.toContain('speak(');
  });

  it('lists the pieces each language says in English, and only for languages without wording of their own (issue #1464)', () => {
    const english = (s: ProjectState) => JSON.parse(/const ENGLISH = (.*);/.exec(generateProject(s).get(`${RUNTIME_DIR}/visitor-text.js`)!)![1]) as Record<string, string[]>;
    let s = apply(fresh(), { type: 'site.update', language: 'fr', visitorText: { language: 'fr', text: { menu: 'Menu' } } });
    s = apply(s, { type: 'page.update', pageId: byTitle(s, 'About').id, language: 'ur' }, { type: 'page.update', pageId: byTitle(s, 'Contact').id, language: 'en-GB' });
    const all = (drop: string[]) => VISITOR_TEXT_KEYS.filter((k) => !drop.includes(k));
    // No Light/Dark switch on this site, so its name goes nowhere, English or not.
    expect(english(s)).toEqual({ fr: all(['menu', 'themeToggle']), ur: all(['themeToggle']) });
    s = apply(s, { type: 'token.setColorScheme', mode: 'toggle' });
    expect(english(s)).toEqual({ fr: all(['menu']), ur: all([]) });
  });
});

// ---------------------------------------------------------------------------
// In a browser
// ---------------------------------------------------------------------------

const browserInstalled = existsSync(chromium.executablePath());
const PHONE = '+1 555 0134';
const SERVICE = 'https://forms.test/f/abc123';

/**
 * A site in Arabic with an About page in Hebrew and a Contact page in English, a contact form on its home page, a
 * Contact link in the header's About submenu and a phone link in its footer; the author has their own Arabic wording
 * for the menu button.
 */
function trilingualSite() {
  let s = fresh();
  s = apply(s, { type: 'site.update', language: 'ar', visitorText: { language: 'ar', text: { menu: 'اعرض القائمة' } } });
  s = apply(s, { type: 'page.update', pageId: byTitle(s, 'About').id, language: 'he' });
  s = apply(s, { type: 'page.update', pageId: byTitle(s, 'Contact').id, language: 'en' });
  const home = s.pages[s.site.homePageId];
  // The author cleared the button's own label: it says the visitor text's.
  const form = makeInstance(s.components[installComponent(s, 'contact.form')], { provider: 'endpoint', endpoint: SERVICE, submitLabel: '' });
  home.nodes[form.id] = form;
  home.rootIds.push(form.id);
  const header = s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;
  header.props = { ...header.props, links: (header.props.links as Array<{ label: string }>).map((l) => (l.label === 'Contact' ? { ...l, sub: true } : l)) };
  const footer = s.site.shell.footer.nodes[s.site.shell.footer.rootIds[0]] as InstanceNode;
  footer.props = { ...footer.props, contact: [{ id: 'c1', label: PHONE, link: { type: 'tel', target: '+15550134' } }] };
  const files = generateProject(s);
  const css = ['tokens', 'theme', 'components', 'site'].map((n) => files.get(`${STYLES_DIR}/${n}.css`) ?? '').join('\n');
  return { s, files, css, routes: { home: '/', he: routeId(byTitle(s, 'About').route), en: routeId(byTitle(s, 'Contact').route) } };
}

/** `$app/state` whose page moves when the test says so, as SvelteKit's router moves it between pages. */
const STATE_STUB = `let id = $state('/');
export const page = { get route() { return { id }; }, get url() { return new URL('https://site.test' + id); } };
export function go(next) { id = next; }`;

/** The layout around the home page, compiled for the browser; `window.go(routeId)` moves to another page. */
async function bundleSite(files: Map<string, string>): Promise<string> {
  const src = new Map<string, string>();
  for (const [path, text] of files) src.set(`\0site/${path}`, text);
  src.set('\0site/Entry.svelte', `<script>import Layout from './src/routes/+layout.svelte'; import Page from './src/routes/+page.svelte';</script><Layout><Page /></Layout>`);
  const entry = `import { flushSync, mount } from 'svelte'; import { go } from '$app/state'; import Entry from '\\0site/Entry.svelte';
mount(Entry, { target: document.getElementById('app') });
flushSync();
window.go = (id) => { go(id); flushSync(); };`;
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'exported-site',
        resolveId(id, importer) {
          if (id === '\0entry') return id;
          if (id === '$app/paths' || id === '$app/state' || id === '$app/navigation') return `\0${id}`;
          if (id.startsWith('@fontsource') || id.endsWith('.css')) return '\0empty';
          if (importer?.startsWith('\0site/') && id.startsWith('.')) {
            const path = `\0${posix.join(posix.dirname(importer.slice(1)), id)}`;
            if (src.has(path)) return path;
          }
          return src.has(id) ? id : null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (id === '\0empty') return '';
          if (id === '\0$app/paths') return 'export const base = ""; export const resolve = (p) => p; export const asset = (p) => "/" + p;';
          if (id === '\0$app/state') return compileModule(STATE_STUB, { filename: 'state.svelte.js', generate: 'client' }).js.code;
          if (id === '\0$app/navigation') return 'export function afterNavigate() {} export function onNavigate() {} export function beforeNavigate() {} export function snapshot() {}';
          const text = src.get(id);
          if (text === undefined) return null;
          return id.endsWith('.svelte') ? compile(text, { filename: id.slice(1), generate: 'client', css: 'injected', runes: true }).js.code : text;
        }
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The site did not bundle');
  return chunk.code;
}

/** What the visitor's browser has of the document and the shell, read in the page (passed as text: no DOM types here). */
const READ = `(() => {
  const toggle = document.querySelector('.so-header__toggle');
  const t = toggle.getBoundingClientRect();
  // Where the phone number's first and last characters are drawn.
  const tel = document.querySelector('footer a[href^="tel:"]');
  const node = tel && [...tel.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim()) || tel?.querySelector('*')?.firstChild;
  const at = (i) => { const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1); return r.getBoundingClientRect().left; };
  const text = node ? node.textContent : '';
  return {
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    direction: getComputedStyle(document.body).direction,
    overflow: document.documentElement.scrollWidth - innerWidth,
    toggleSide: t.width ? (t.left + t.width / 2 < innerWidth / 2 ? 'left' : 'right') : 'hidden',
    phoneStartsLeft: node ? at(text.indexOf('+')) < at(text.lastIndexOf('4')) : null
  };
})()`;

/**
 * The menu button's name as Chromium's accessibility tree gives it to screen readers. The button is a native
 * disclosure's summary, which has no ARIA role for a role query to find.
 */
async function menuName(page: Page): Promise<string | undefined> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.so-header__toggle' });
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
    return nodes[0]?.name?.value;
  } finally {
    await cdp.detach();
  }
}

describe.skipIf(!browserInstalled)('a site in Arabic, Hebrew and English in a browser', () => {
  let browser: Browser;
  let script: string;
  let site: ReturnType<typeof trilingualSite>;

  beforeAll(async () => {
    site = trilingualSite();
    const [bundled, launched] = await Promise.allSettled([bundleSite(site.files), chromium.launch({ headless: true, executablePath: chromium.executablePath() })]);
    if (launched.status === 'fulfilled') browser = launched.value;
    if (bundled.status === 'rejected') throw bundled.reason;
    if (launched.status === 'rejected') throw launched.reason;
    script = bundled.value;
  });
  afterAll(() => browser?.close());

  /** The site's home page in the site's language, as app.html starts it, at a width. */
  async function open(width: number): Promise<Page> {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.setContent(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>${site.css}</style></head><body><div id="app"></div></body></html>`);
    await page.addScriptTag({ content: script });
    return page;
  }

  it('speaks each page’s language in the header and the skip link, and turns the page around, without a reload', async () => {
    const page = await open(390);
    try {
      await page.evaluate(() => ((globalThis as unknown as { same: boolean }).same = true));
      const steps: Array<[string, string, string, string, string, string, string]> = [
        // route, lang, dir, the menu button's name (the author's own in Arabic), the skip link, the navigation's name,
        // the About submenu button's name
        [site.routes.home, 'ar', 'rtl', 'اعرض القائمة', 'انتقل إلى المحتوى', 'القائمة الرئيسية', 'قائمة About الفرعية'],
        [site.routes.he, 'he', 'rtl', 'תפריט', 'דילוג לתוכן', 'תפריט ראשי', 'תפריט המשנה של About'],
        [site.routes.en, 'en', 'ltr', 'Menu', 'Skip to content', 'Main', 'About submenu'],
        [site.routes.home, 'ar', 'rtl', 'اعرض القائمة', 'انتقل إلى المحتوى', 'القائمة الرئيسية', 'قائمة About الفرعية']
      ];
      for (const [route, lang, dir, menu, skip, nav, submenu] of steps) {
        await page.evaluate((id) => (globalThis as unknown as { go: (id: string) => void }).go(id), route);
        const read = (await page.evaluate(READ)) as { lang: string; dir: string; direction: string; overflow: number; toggleSide: string };
        expect([route, read.lang, read.dir, read.direction]).toEqual([route, lang, dir, dir]);
        // The names a screen reader hears, from the accessibility tree.
        expect(await menuName(page)).toBe(menu);
        await expect(page.getByRole('link', { name: skip, exact: true }).count()).resolves.toBe(1);
        // The menu button sits at the end of the header's row: on the left when the page runs right to left.
        expect(read.toggleSide).toBe(dir === 'rtl' ? 'left' : 'right');
        expect(read.overflow).toBeLessThanOrEqual(0);
        // Opening the menu shows the navigation, named in the page's language. The button keeps its name (the browser
        // says whether the menu is open) and closes it again.
        await page.locator('.so-header__toggle').click();
        await expect(page.getByRole('navigation', { name: nav, exact: true }).count()).resolves.toBe(1);
        await expect(page.locator('.so-header__menu[open]').count()).resolves.toBe(1);
        expect(await menuName(page)).toBe(menu);
        // The button beside About shows the links under it, indented from the start edge of the page: the right
        // when it runs right to left.
        await page.getByRole('button', { name: submenu, exact: true }).click();
        const [left, right] = await page.locator('.so-header__sub').evaluate((el) => {
          const style = (globalThis as unknown as { getComputedStyle: (e: unknown) => { paddingLeft: string; paddingRight: string } }).getComputedStyle(el);
          return [style.paddingLeft, style.paddingRight];
        });
        const [start, end] = dir === 'rtl' ? [right, left] : [left, right];
        expect([route, end]).toEqual([route, '0px']);
        expect(parseFloat(start), route).toBeGreaterThan(0);
        await page.locator('.so-header__toggle').click();
        await expect(page.locator('.so-header__menu[open]').count()).resolves.toBe(0);
      }
      // The same document all along: the layout and the header stayed while the page changed.
      expect(await page.evaluate(() => (globalThis as unknown as { same?: boolean }).same)).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('keeps a phone number in its own order and the page within the window, right to left at every width', async () => {
    for (const width of [390, 1280]) {
      const page = await open(width);
      try {
        for (const route of [site.routes.home, site.routes.he]) {
          await page.evaluate((id) => (globalThis as unknown as { go: (id: string) => void }).go(id), route);
          const read = (await page.evaluate(READ)) as { direction: string; overflow: number; phoneStartsLeft: boolean | null };
          expect(read.direction).toBe('rtl');
          // Nothing hangs off the page's start edge, where a right-to-left page would let it scroll: not the form's hidden trap.
          expect(read.overflow, `${route} at ${width}px`).toBeLessThanOrEqual(0);
          expect(read.phoneStartsLeft, `${route} at ${width}px`).toBe(true);
        }
      } finally {
        await page.close();
      }
    }
  });

  it('sends a message in the page’s language from start to end: its button, its progress and its outcome', async () => {
    const page = await open(390);
    const ar = builtInVisitorText('ar');
    let answer!: () => void;
    const answered = new Promise<void>((done) => (answer = done));
    let status = 200;
    await page.route(`${SERVICE}**`, async (route) => {
      await answered;
      await route.fulfill({ status, contentType: 'application/json', body: '{}', headers: { 'access-control-allow-origin': '*' } });
    });
    try {
      const form = page.locator('form.so-form__form');
      for (const [name, value] of [['name', 'ليلى'], ['email', 'layla@example.com'], ['message', 'مرحبا']]) await form.locator(`[name="${name}"]`).fill(value);
      // A stock form's button and messages are the site's visitor text in Arabic, never English beside it.
      await page.getByRole('button', { name: ar.formSubmit, exact: true }).click();
      await expect.poll(() => page.locator('.so-form__status').first().innerText()).toBe(ar.formSendingStatus);
      await expect(form.getByRole('button').innerText()).resolves.toBe(ar.formSending);
      answer();
      await expect.poll(() => page.locator('.so-form__status').first().innerText()).toBe(ar.formSent);
      await expect(page.getByRole('button', { name: ar.formSubmit, exact: true }).count()).resolves.toBe(1);
      // A message the service turns down says so in Arabic too.
      status = 500;
      for (const [name, value] of [['name', 'ليلى'], ['email', 'layla@example.com'], ['message', 'مرة أخرى']]) await form.locator(`[name="${name}"]`).fill(value);
      await page.getByRole('button', { name: ar.formSubmit, exact: true }).click();
      // Said as an alert, beside the (then empty) status line.
      await expect.poll(() => page.locator('.so-form__status--error[role="alert"]').innerText()).toBe(ar.formFailed);
      // An email address is typed left to right, whichever way the page runs.
      await expect(form.locator('[name="email"]').evaluate((el) => (globalThis as unknown as { getComputedStyle: (e: unknown) => { direction: string } }).getComputedStyle(el).direction)).resolves.toBe('ltr');
    } finally {
      await page.close();
    }
  });
});

/**
 * A site in French, with an About page in Urdu and a Contact page in British English, and no French or Urdu wording
 * of the site's own but the menu button's (the author's "Menu", which reads the same as the English). Contact sits
 * in the header's About submenu (issue #1464).
 */
function englishFallbackSite() {
  let s = fresh();
  s = apply(s, { type: 'site.update', language: 'fr', visitorText: { language: 'fr', text: { menu: 'Menu' } } });
  s = apply(s, { type: 'page.update', pageId: byTitle(s, 'About').id, language: 'ur' });
  s = apply(s, { type: 'page.update', pageId: byTitle(s, 'Contact').id, language: 'en-GB' });
  const header = s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;
  header.props = { ...header.props, links: (header.props.links as Array<{ label: string }>).map((l) => (l.label === 'Contact' ? { ...l, sub: true } : l)) };
  const files = generateProject(s);
  const css = ['tokens', 'theme', 'components', 'site'].map((n) => files.get(`${STYLES_DIR}/${n}.css`) ?? '').join('\n');
  return { files, css, routes: { home: '/', ur: routeId(byTitle(s, 'About').route), en: routeId(byTitle(s, 'Contact').route) } };
}

/** The language each of the header's and the skip link's own words are marked with, read in the page. */
const READ_LANGUAGES = `(() => {
  const nav = document.getElementById('so-site-nav');
  const name = document.getElementById(nav.getAttribute('aria-labelledby'));
  const sub = document.querySelector('.so-header__sub-toggle .so-visually-hidden');
  const skip = document.querySelector('.so-skip-link');
  skip.focus();
  const at = skip.getBoundingClientRect();
  return {
    html: document.documentElement.lang,
    skip: skip.getAttribute('lang'),
    skipSide: at.left + at.width / 2 < innerWidth / 2 ? 'left' : 'right',
    menu: document.querySelector('.so-header__toggle .so-visually-hidden').getAttribute('lang'),
    nav: nav.getAttribute('lang'),
    name: name.getAttribute('lang'),
    submenu: [...sub.childNodes].filter((n) => n.textContent).map((n) => [n.textContent, n.nodeType === 1 ? n.getAttribute('lang') : null]),
    // The author's words around the marked ones keep the page's language: the links, and the link's name in the button.
    link: [...new Set([...nav.querySelectorAll('a'), sub].map((el) => el.closest('[lang]').getAttribute('lang')))],
    nameHidden: name.hidden
  };
})()`;

describe.skipIf(!browserInstalled)('English wording on a page in French or Urdu, in a browser', () => {
  let browser: Browser;
  let script: string;
  let site: ReturnType<typeof englishFallbackSite>;

  beforeAll(async () => {
    site = englishFallbackSite();
    const [bundled, launched] = await Promise.allSettled([bundleSite(site.files), chromium.launch({ headless: true, executablePath: chromium.executablePath() })]);
    if (launched.status === 'fulfilled') browser = launched.value;
    if (bundled.status === 'rejected') throw bundled.reason;
    if (launched.status === 'rejected') throw launched.reason;
    script = bundled.value;
  });
  afterAll(() => browser?.close());

  it('marks the skip link, the menu, the navigation and the submenu as English where they fall back to it, without a reload', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    try {
      await page.setContent(`<!doctype html><html lang="fr" dir="ltr"><head><meta charset="utf-8"><style>${site.css}</style></head><body><div id="app"></div></body></html>`);
      await page.addScriptTag({ content: script });
      const english = (en: string | null, link: string, side: string) => ({ skip: en, skipSide: side, nav: null, name: en, submenu: [['About', null], [' submenu', en]], link: [link], nameHidden: true });
      const steps: Array<[string, string, string | null, ReturnType<typeof english>]> = [
        // route, the page's language, the menu button's mark (the author's French "Menu" is French), the rest
        [site.routes.home, 'fr', null, english('en', 'fr', 'left')],
        [site.routes.ur, 'ur', 'en', english('en', 'ur', 'right')],
        // English on an English page is the page's own language: nothing is marked.
        [site.routes.en, 'en-GB', null, english(null, 'en-GB', 'left')],
        [site.routes.home, 'fr', null, english('en', 'fr', 'left')]
      ];
      for (const [route, lang, menu, rest] of steps) {
        await page.evaluate((id) => (globalThis as unknown as { go: (id: string) => void }).go(id), route);
        expect([route, await page.evaluate(READ_LANGUAGES)]).toEqual([route, { html: lang, menu, ...rest }]);
        // What a screen reader is told stays the same words: the marks change only the language they are said in.
        expect(await menuName(page)).toBe('Menu');
        await expect(page.getByRole('link', { name: 'Skip to content', exact: true }).count()).resolves.toBe(1);
        await page.locator('.so-header__toggle').click();
        await expect(page.getByRole('navigation', { name: 'Main', exact: true }).count()).resolves.toBe(1);
        await expect(page.locator('.so-header__nav > span[hidden]').isVisible()).resolves.toBe(false);
        await expect(page.getByRole('button', { name: 'About submenu', exact: true }).count()).resolves.toBe(1);
        await page.locator('.so-header__toggle').click();
      }
    } finally {
      await page.close();
    }
  });
});

/**
 * The site's layout (with its header) as the export prerenders each page, before any of the site's script runs: a
 * page's HTML, by route ID.
 */
async function prerender(files: Map<string, string>): Promise<(route: string) => string> {
  const GEN = '\0gen:';
  const entry = `export { render } from 'svelte/server';\nexport { createRawSnippet } from 'svelte';\nexport { default as Layout } from ${JSON.stringify(GEN + 'src/routes/+layout.svelte')};`;
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    plugins: [
      {
        name: 'prerendered-layout',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === '\0entry' || id.startsWith(GEN)) return id;
          if (id === '$app/paths' || id === '$app/state' || id === '$app/navigation') return `\0${id}`;
          if (id.startsWith('@fontsource')) return '\0empty';
          if (importer?.startsWith(GEN) && id.startsWith('.')) {
            const path = posix.join(posix.dirname(importer.slice(GEN.length)), id);
            if (files.has(path)) return GEN + path;
            if (path.endsWith('.css')) return '\0empty';
          }
          return null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (id === '\0empty') return { code: '', moduleType: 'js' };
          if (id === '\0$app/paths') return "export const resolve = (p) => p; export const asset = (p) => '/' + p; export const base = '';";
          // The page being prerendered, which the test sets before each render.
          if (id === '\0$app/state') return "export const page = { get route() { return { id: globalThis.__route }; }, get url() { return new URL('https://site.test' + globalThis.__route); } };";
          if (id === '\0$app/navigation') return 'export const afterNavigate = () => {}; export const onNavigate = () => {}; export const beforeNavigate = () => {}; export const snapshot = () => {};';
          if (!id.startsWith(GEN)) return null;
          const path = id.slice(GEN.length);
          if (path.endsWith('.css')) return { code: '', moduleType: 'js' };
          const source = files.get(path)!;
          if (!path.endsWith('.svelte')) return { code: source, moduleType: 'js' };
          return { code: compile(source, { filename: path, generate: 'server', runes: true, css: 'external' }).js.code, moduleType: 'js' };
        }
      }
    ],
    build: { write: false, ssr: true, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'esm', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The layout did not bundle');
  const tmp = mkdtempSync(join(resolve('.tmp'), 'visitor-prerender-'));
  try {
    const file = join(tmp, 'layout.mjs');
    writeFileSync(file, chunk.code);
    const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as { render: (c: unknown, o: { props: Record<string, unknown> }) => { body: string }; createRawSnippet: (f: () => { render: () => string }) => unknown; Layout: unknown };
    return (route) => {
      (globalThis as unknown as { __route: string }).__route = route;
      return mod.render(mod.Layout, { props: { children: mod.createRawSnippet(() => ({ render: () => '<div></div>' })) } }).body.replace(/<!--[\s\S]*?-->/g, '');
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('English wording on a page in French or Urdu, as the export prerenders it', () => {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const tag = (html: string, pattern: RegExp) => pattern.exec(html)?.[0] ?? '';
  const read = (html: string) => {
    const nav = tag(html, /<nav\b[^>]*>/);
    const nameId = /aria-labelledby="([^"]+)"/.exec(nav)?.[1];
    return {
      skip: tag(html, /<a class="so-skip-link"[^>]*>[^<]*<\/a>/),
      menu: tag(html, /<span class="so-visually-hidden"[^>]*>Menu<\/span>/),
      nav: nav.replace(/ class="[^"]*"/, ''),
      name: nameId ? tag(html, new RegExp(`<span id="${nameId}"[^>]*>[^<]*</span>`)).replace(nameId, 'ID') : '',
      submenu: tag(html, /<span class="so-visually-hidden">About[\s\S]*?submenu(<\/span>)+/)
    };
  };

  it('marks the English pieces in the HTML each page is sent as, and none on an English page', async () => {
    const site = englishFallbackSite();
    const page = await prerender(site.files);
    const marked = {
      skip: '<a class="so-skip-link" href="#main" lang="en">Skip to content</a>',
      nav: '<nav id="so-site-nav" aria-labelledby="ID">',
      name: '<span id="ID" hidden="" lang="en">Main</span>',
      submenu: '<span class="so-visually-hidden">About<span lang="en"> submenu</span></span>'
    };
    const fr = read(page(site.routes.home));
    expect({ ...fr, nav: fr.nav.replace(/"so-nav-name:[^"]+"/, '"ID"') }).toEqual({ ...marked, menu: '<span class="so-visually-hidden">Menu</span>' });
    const ur = read(page(site.routes.ur));
    expect({ ...ur, nav: ur.nav.replace(/"so-nav-name:[^"]+"/, '"ID"') }).toEqual({ ...marked, menu: '<span class="so-visually-hidden" lang="en">Menu</span>' });
    const en = read(page(site.routes.en));
    expect({ ...en, nav: en.nav.replace(/"so-nav-name:[^"]+"/, '"ID"') }).toEqual({
      skip: '<a class="so-skip-link" href="#main">Skip to content</a>',
      menu: '<span class="so-visually-hidden">Menu</span>',
      nav: '<nav id="so-site-nav" aria-labelledby="ID">',
      name: '<span id="ID" hidden="">Main</span>',
      submenu: '<span class="so-visually-hidden">About submenu</span>'
    });
    // The navigation's name is an ID no author's anchor can take.
    expect(en.nav).toMatch(/aria-labelledby="so-nav-name:[^"]+"/);
  });

  it('marks Home as English only where it names the brand link, on a site in French alone', async () => {
    let s = fresh();
    s = apply(s, { type: 'site.update', language: 'fr' });
    const header = s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;
    const render = async (props: Record<string, unknown>) => {
      header.props = { ...header.props, ...props };
      const files = generateProject(s);
      // A site in one language never calls speak(): the wording is the site's.
      expect(files.get('src/routes/+layout.svelte')).not.toContain('speak(');
      return /<a class="so-header__brand[^"]*"[^>]*>/.exec((await prerender(files))('/'))?.[0] ?? '';
    };
    const unnamed = await render({ siteName: '', showSiteName: true, logo: null });
    expect(unnamed).toContain('aria-label="Home"');
    expect(unnamed).toContain('lang="en"');
    // The author's own name for the link is in the page's language, shown or not.
    for (const props of [{ siteName: 'Atelier Nord', showSiteName: true, logo: null }, { siteName: 'Atelier Nord', showSiteName: false, logo: null }]) expect(await render(props)).not.toContain('lang=');
    // The skip link on that page is marked too, without the layout naming a language.
    const s2 = generateProject(s);
    expect((await prerender(s2))('/')).toContain('<a class="so-skip-link" href="#main" lang="en">Skip to content</a>');
  });
});
