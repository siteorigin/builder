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
import { VISITOR_TEXT_GROUPS, VISITOR_TEXT_KEYS, builtInVisitorText, visitorTextFor } from '@shared/visitor-text';
import { notFoundCopy } from '@shared/not-found';

const fresh = () => createStarterState('business', 'Test Studio', false);
const apply = (s: ProjectState, ...ops: Parameters<typeof applyOperations>[1]) => applyOperations(s, ops).state;
const byTitle = (s: ProjectState, title: string) => Object.values(s.pages).find((p) => p.title === title)!;

describe('the way a language is written', () => {
  it('runs right to left for Arabic, Hebrew and their kin, and by the script a code names', () => {
    for (const code of ['ar', 'AR', 'ar-EG', 'he', 'iw', 'he-IL', 'fa', 'fa-IR', 'ur', 'ps', 'dv', 'yi', 'ckb', 'syr', 'az-Arab', 'ku-Arab', 'pa-Arab', 'zh-Hebr']) expect(languageDirection(code), code).toBe('rtl');
    for (const code of ['en', 'en-GB', 'fr-CA', 'de', 'zh-Hant-TW', 'ja', 'ar-Latn', 'az-Latn', 'az', 'ku', 'sr-Cyrl']) expect(languageDirection(code), code).toBe('ltr');
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
    expect(builtInVisitorText('ar').menuOpen).toBe('فتح القائمة');
    expect(builtInVisitorText('iw')).toBe(builtInVisitorText('he'));
    // A language without wording of its own reads English.
    expect(builtInVisitorText('fr-CA')).toBe(builtInVisitorText('en'));
  });

  it('takes the author’s wording for the exact language, then its primary language, then the built-in wording', () => {
    const site = { visitorText: { ar: { menuOpen: 'اعرض القائمة', skipLink: 'إلى المحتوى' }, 'ar-eg': { skipLink: 'على طول للمحتوى' }, fr: { menuOpen: 'Ouvrir le menu' } } };
    expect(visitorTextFor(site, 'ar')).toMatchObject({ menuOpen: 'اعرض القائمة', skipLink: 'إلى المحتوى', menuClose: 'إغلاق القائمة' });
    expect(visitorTextFor(site, 'ar-EG')).toMatchObject({ menuOpen: 'اعرض القائمة', skipLink: 'على طول للمحتوى' });
    expect(visitorTextFor(site, 'fr')).toMatchObject({ menuOpen: 'Ouvrir le menu', menuClose: 'Close menu' });
    // Hebrew never takes Arabic wording.
    expect(visitorTextFor(site, 'he').menuOpen).toBe('פתיחת התפריט');
    // site.json edited by hand: anything but text, or text that shows nothing, is no wording.
    for (const visitorText of [null, 'x', [], { ar: 'x' }, { ar: { menuOpen: 7 } }, { ar: { menuOpen: ' \u200b ' } }] as unknown[])
      expect(visitorTextFor({ visitorText } as never, 'ar').menuOpen).toBe('فتح القائمة');
  });

  it('is set piece by piece through the site’s settings, and cleared back to the built-in wording', () => {
    let s = apply(fresh(), { type: 'site.update', visitorText: { language: 'AR', text: { menuOpen: '  اعرض القائمة  ', skipLink: 'إلى المحتوى' } } });
    expect(s.site.visitorText).toEqual({ ar: { menuOpen: 'اعرض القائمة', skipLink: 'إلى المحتوى' } });
    s = apply(s, { type: 'site.update', visitorText: { language: 'he', text: { menuOpen: 'תפריט' } } });
    // One piece changes without touching the others.
    s = apply(s, { type: 'site.update', visitorText: { language: 'ar', text: { skipLink: '' } } });
    expect(s.site.visitorText).toEqual({ ar: { menuOpen: 'اعرض القائمة' }, he: { menuOpen: 'תפריט' } });
    // Wording that shows nothing clears it; a language left with none goes, and so does the map.
    s = apply(s, { type: 'site.update', visitorText: { language: 'ar', text: { menuOpen: '\u200b' } } });
    s = apply(s, { type: 'site.update', visitorText: { language: 'he', text: { menuOpen: ' ' } } });
    expect(s.site.visitorText).toBeUndefined();
    expect(() => apply(s, { type: 'site.update', visitorText: { language: '__proto__', text: { menuOpen: 'x' } } })).toThrow(/Language must be a code/);
    // A piece that does not exist is turned down, naming the ones that do.
    expect(() => apply(s, { type: 'site.update', visitorText: { language: 'ar', text: { nonsense: 'x' } } })).toThrow(/“nonsense” is not a piece of visitor text\. Use one of: skipLink, menuOpen/);
  });

  it('gives the not-found page its default wording in the site’s language', () => {
    expect(notFoundCopy({ language: 'ar' }).heading).toBe('الصفحة غير موجودة');
    expect(notFoundCopy({ language: 'he-IL' }).linkLabel).toBe('מעבר לדף הבית');
    expect(notFoundCopy({ language: 'ar', notFoundHeading: 'لا شيء هنا' }).heading).toBe('لا شيء هنا');
    expect(notFoundCopy({ language: 'fr' }).heading).toBe('Page not found');
  });
});

describe('the generated wording', () => {
  const dir = mkdtempSync(join(resolve('.tmp'), 'visitor-text-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('carries the wording of each language the site’s pages are in, and fills names in once', async () => {
    let s = apply(fresh(), { type: 'site.update', language: 'ar', visitorText: { language: 'ar', text: { menuOpen: 'اعرض القائمة' } } });
    const about = byTitle(s, 'About').id;
    s = apply(s, { type: 'page.update', pageId: about, language: 'he' });
    const files = generateProject(s);
    const module = files.get(`${RUNTIME_DIR}/visitor-text.js`)!;
    expect(module).toContain('const SITE = "ar";');
    expect(module).toContain('"menuOpen": "اعرض القائمة"');
    expect(module).toContain('"menuOpen": "פתיחת התפריט"');
    // Only the languages in use: no English.
    expect(module).not.toContain('"Open menu"');
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    writeFileSync(join(dir, 'runtime', 'visitor-text.js'), module);
    const { fill, fillParts } = (await import(/* @vite-ignore */ pathToFileURL(join(dir, 'runtime', 'visitor-text.js')).href)) as {
      fill: (t: string, v: Record<string, unknown>) => string;
      fillParts: (t: string, v: Record<string, unknown>) => Array<{ text: string; name?: string }>;
    };
    // What goes in is never read for names: a search for "{shown}" says just that.
    expect(fill('{count} pages match “{query}”. The first {shown} are shown.', { count: 3, query: '{shown}', shown: 2 })).toBe('3 pages match “{shown}”. The first 2 are shown.');
    expect(fill('{index} of {count} {other}', { index: 1, count: 2 })).toBe('1 of 2 {other}');
    expect(fillParts('لا توجد صفحات تطابق «{query}».', { query: 'Studio 5' })).toEqual([{ text: 'لا توجد صفحات تطابق «' }, { text: 'Studio 5', name: 'query' }, { text: '».' }]);
    // A site in one language carries that language alone, and its layout names no other.
    const one = generateProject(fresh());
    expect(one.get(`${RUNTIME_DIR}/visitor-text.js`)).toContain('const SITE = "en";');
    expect(one.get('src/routes/+layout.svelte')).toContain("import { visitorText } from '../lib/siteorigin/runtime/visitor-text.js';");
    expect(one.get('src/routes/+layout.svelte')).not.toContain('speak(');
  });
});

// ---------------------------------------------------------------------------
// In a browser
// ---------------------------------------------------------------------------

const browserInstalled = existsSync(chromium.executablePath());
const PHONE = '+1 555 0134';

/**
 * A site in Arabic with an About page in Hebrew and a Contact page in English, a contact form on its home page and
 * a phone link in its footer; the author has their own Arabic wording for the menu button.
 */
function trilingualSite() {
  let s = fresh();
  s = apply(s, { type: 'site.update', language: 'ar', visitorText: { language: 'ar', text: { menuOpen: 'اعرض القائمة' } } });
  s = apply(s, { type: 'page.update', pageId: byTitle(s, 'About').id, language: 'he' });
  s = apply(s, { type: 'page.update', pageId: byTitle(s, 'Contact').id, language: 'en' });
  const home = s.pages[s.site.homePageId];
  const form = makeInstance(s.components[installComponent(s, 'contact.form')], {});
  home.nodes[form.id] = form;
  home.rootIds.push(form.id);
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
          if (id === '\0$app/navigation') return 'export function afterNavigate() {} export function beforeNavigate() {} export function snapshot() {}';
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
      await page.evaluate(() => ((window as unknown as { same: boolean }).same = true));
      const steps: Array<[string, string, string, string, string, string]> = [
        // route, lang, dir, the menu button's name (the author's own in Arabic), the skip link, the navigation's name
        [site.routes.home, 'ar', 'rtl', 'اعرض القائمة', 'انتقل إلى المحتوى', 'القائمة الرئيسية'],
        [site.routes.he, 'he', 'rtl', 'פתיחת התפריט', 'דילוג לתוכן', 'תפריט ראשי'],
        [site.routes.en, 'en', 'ltr', 'Open menu', 'Skip to content', 'Main'],
        [site.routes.home, 'ar', 'rtl', 'اعرض القائمة', 'انتقل إلى المحتوى', 'القائمة الرئيسية']
      ];
      for (const [route, lang, dir, menu, skip, nav] of steps) {
        await page.evaluate((id) => (window as unknown as { go: (id: string) => void }).go(id), route);
        const read = (await page.evaluate(READ)) as { lang: string; dir: string; direction: string; overflow: number; toggleSide: string };
        expect([route, read.lang, read.dir, read.direction]).toEqual([route, lang, dir, dir]);
        // The names a screen reader hears, from the accessibility tree.
        await expect(page.getByRole('button', { name: menu, exact: true }).count()).resolves.toBe(1);
        await expect(page.getByRole('link', { name: skip, exact: true }).count()).resolves.toBe(1);
        // The menu button sits at the end of the header's row: on the left when the page runs right to left.
        expect(read.toggleSide).toBe(dir === 'rtl' ? 'left' : 'right');
        expect(read.overflow).toBeLessThanOrEqual(0);
        // Opening the menu shows the navigation, named in the page's language, and says how to close it.
        await page.getByRole('button', { name: menu, exact: true }).click();
        await expect(page.getByRole('navigation', { name: nav, exact: true }).count()).resolves.toBe(1);
        await expect(page.getByRole('button', { name: builtInVisitorText(lang).menuClose, exact: true }).count()).resolves.toBe(1);
        await page.getByRole('button', { name: builtInVisitorText(lang).menuClose, exact: true }).click();
      }
      // The same document all along: the layout and the header stayed while the page changed.
      expect(await page.evaluate(() => (window as unknown as { same?: boolean }).same)).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('keeps a phone number in its own order and the page within the window, right to left at every width', async () => {
    for (const width of [390, 1280]) {
      const page = await open(width);
      try {
        for (const route of [site.routes.home, site.routes.he]) {
          await page.evaluate((id) => (window as unknown as { go: (id: string) => void }).go(id), route);
          const read = (await page.evaluate(READ)) as { direction: string; overflow: number; phoneStartsLeft: boolean | null };
          expect(read.direction).toBe('rtl');
          // Nothing hangs off the page's start edge, where a right-to-left page would let it scroll: not the form's hidden trap.
          expect(read.overflow, `${route} at ${width}px`).toBeLessThanOrEqual(0);
          expect(read.phoneStartsLeft, `${route} at ${width}px`).toBe(true);
        }
        // The form's progress and state come in the page's language too.
        await page.evaluate((id) => (window as unknown as { go: (id: string) => void }).go(id), site.routes.home);
        await expect(page.locator('.so-form__status').first().innerText()).resolves.toBe(builtInVisitorText('ar').formNotConnected);
      } finally {
        await page.close();
      }
    }
  });
});
