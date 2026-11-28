// A page in another language (#237): About is duplicated as "À propos", given French and linked to About as its
// translation in Page settings, and each page gets an ordinary link to the other. The preview (raw HTML from the
// development server, and client-side navigation in Preview) and the exported website (its files, and client-side
// navigation on the app's static preview) must then declare each page's own language and list both versions on both
// pages, and the source export must carry the server hook that does it. A site in one language keeps
// <html lang="en"> and no server hook, before and after.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';

const { WORK, cleanup } = scratch('page-languages');
const { app, win, errors } = await launch(WORK);
await win.evaluate(() => {
  window.__appliedRevisions = [];
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'revisionApplied' && Number.isSafeInteger(event.data.payload?.revision)) window.__appliedRevisions.push(event.data.payload.revision);
  });
});

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = async (operations, label) => {
  const r = await win.evaluate(([operations, label]) => window.builder.project.apply({ operations }, { label }), [operations, label]);
  assert.equal(r.ok, true, `${label}: ${r.error?.message}`);
  return r;
};
const htmlLang = (html) => html.match(/<html[^>]*\slang="([^"]*)"/)?.[1] ?? null;
/** The alternates in a page's HTML, each with the path its address resolves to from the page itself. */
const alternates = (html, pagePath) => [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)].map((m) => `${m[1]} ${new URL(m[2], `http://site${pagePath}`).pathname}`);
const BOTH = ['en /about/', 'fr /fr/a-propos/'];
const PUBLIC = 'https://harbour-lane.example';
/** The raw addresses of a page's alternates, as search engines read them: full ones only. */
const alternateHrefs = (html) => [...html.matchAll(/<link rel="alternate" hreflang="[^"]+" href="([^"]+)"/g)].map((m) => m[1]);
const FULL = [`${PUBLIC}/about/`, `${PUBLIC}/fr/a-propos/`];

/** Open Page settings for a page through its row in Pages, as an author does. */
async function pageSettings(title) {
  await win.locator('.side-panel .list-item', { hasText: title }).hover();
  await win.locator(`[aria-label="${title} options"]`).click();
  await win.getByRole('menuitem', { name: 'Page settings' }).click();
  // Language is closed until wanted, its heading naming the page's language; open it for the language and translations.
  const head = win.locator('#dock-panel-inspect .section-head', { hasText: 'Language' });
  await head.waitFor();
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
}

/**
 * In a page that shows About, follow its own "Français" link and then the French page's "English" link, then go
 * Back, reading <html lang>, the alternates in the head and the address after each step. `target` is a Playwright
 * page or frame. The same document must survive every step: the site's router moved between the pages.
 */
async function walk(target) {
  await target.evaluate(() => (window.__samePage = true));
  // Each step is read once the address is the page's and its language has settled.
  const read = (path, lang) =>
    eventually(async () => {
      const r = await target.evaluate(() => ({ lang: document.documentElement.lang, alternates: [...document.head.querySelectorAll('link[rel="alternate"][hreflang]')].map((l) => `${l.getAttribute('hreflang')} ${new URL(l.href).pathname}`), same: window.__samePage === true, path: location.pathname }));
      assert.equal(r.path, path);
      assert.equal(r.lang, lang);
      return r;
    }, 15000);
  // A click event on the link itself, as a visitor's click delivers it: the preview may be scaled to fit.
  const follow = (text) => target.locator('main a', { hasText: text }).first().evaluate((a) => a.click());
  const steps = [await read('/about/', 'en')];
  await follow('Français');
  steps.push(await read('/fr/a-propos/', 'fr'));
  await follow('English');
  steps.push(await read('/about/', 'en'));
  await target.evaluate(() => history.back());
  steps.push(await read('/fr/a-propos/', 'fr'));
  return steps;
}

/** Open `url` in a hidden browser window, as a visitor would, and walk it. */
async function walkIn(url) {
  const [tab] = await Promise.all([
    app.waitForEvent('window'),
    app.evaluate(({ BrowserWindow }, url) => {
      const w = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true, partition: `visitor-${Date.now()}` } });
      const origin = new URL(url).origin;
      w.webContents.on('will-navigate', (e, to) => new URL(to).origin !== origin && e.preventDefault());
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      void w.loadURL(url);
    }, url)
  ]);
  try {
    await tab.waitForLoadState('load');
    await tab.waitForLoadState('networkidle');
    // Hydrated: the site's router answers links from here on.
    await tab.waitForTimeout(1000);
    return await walk(tab);
  } finally {
    await tab.close().catch(() => undefined);
  }
}

/** The steps of `walk` as the languages they declared, checking every step stayed in one document. */
function assertWalk(steps, where) {
  assert.deepEqual(
    steps.map((s) => s.lang),
    ['en', 'fr', 'en', 'fr'],
    `${where}: <html lang> follows the page on every step`
  );
  assert.ok(
    steps.every((s) => s.same),
    `${where}: the links moved within one document, not by reloading it`
  );
  for (const s of steps) assert.deepEqual(s.alternates, BOTH, `${where}: ${s.path} lists both versions`);
}

try {
  await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
  const dir = join(WORK, 'sites', 'harbour-lane-studio');
  const preview = new URL(await win.locator('.frame-box iframe').getAttribute('src')).origin;
  const served = async (path) => (await fetch(new URL(path, preview), { signal: AbortSignal.timeout(30000) })).text();
  const exportsDir = join(WORK, 'exports');
  mkdirSync(exportsDir, { recursive: true });
  await app.evaluate(({ dialog }, parent) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] });
  }, exportsDir);

  step('a site in one language: English everywhere, and a server hook for the not-found page alone');
  const aboutHtml = await served('/about/');
  assert.equal(htmlLang(aboutHtml), 'en');
  assert.deepEqual(alternates(aboutHtml, '/about/'), []);
  assert.doesNotMatch(readFileSync(join(dir, 'src', 'hooks.server.js'), 'utf8'), /LANGUAGES/, 'the server hook lists no page languages');

  step('About duplicated as À propos, then given French and linked in Page settings');
  let state = (await snapshot()).state;
  const pageBy = (s, title) => Object.values(s.pages).find((p) => p.title === title);
  const about = pageBy(state, 'About').id;
  const dup = await apply([{ type: 'page.duplicate', pageId: about, title: 'À propos' }], 'Duplicate About');
  const fr = dup.results[0].pageId;
  // Without the shared header and footer: the language must follow it all the same.
  await apply([{ type: 'page.update', pageId: fr, route: '/fr/a-propos/', seoTitle: 'À propos du studio', showHeader: false, showFooter: false }], 'French address and title');
  await pageSettings('À propos');
  const language = win.getByLabel('Page language');
  assert.equal(await language.getAttribute('placeholder'), 'English', 'an empty language shows, by name, the site language it uses');
  const languageSection = win.locator('#dock-panel-inspect .section', { has: win.locator('[aria-label="Page language"]') });
  // Still in the site language like every other page, the copy has nothing to link yet, and says why in place of the button.
  assert.match(await languageSection.innerText(), /pages are in English too/, 'nothing can be linked while every page is English');
  assert.equal(await win.locator('#dock-panel-inspect [data-link-translation]').count(), 0, 'no Link button while nothing can be linked');
  // Typed by name, saved as the code.
  await language.fill('French');
  await language.press('Enter');
  await eventually(async () => assert.equal((await snapshot()).state.pages[fr].language, 'fr'));
  await win.getByRole('button', { name: 'Link a translation' }).click();
  await win.getByRole('menuitem', { name: /^About/ }).first().click();
  state = await eventually(async () => {
    const s = (await snapshot()).state;
    assert.ok(s.pages[fr].translationGroup && s.pages[fr].translationGroup === s.pages[about].translationGroup, 'the two pages are linked');
    return s;
  });
  const translations = () => win.getByRole('list', { name: 'Translations of this page' });
  assert.match((await translations().innerText()).replace(/\s+/g, ' '), /About English Unlink/, 'the French page lists About as its English version');
  await pageSettings('About');
  assert.match((await translations().innerText()).replace(/\s+/g, ' '), /À propos French Unlink/, 'About lists the French page too');

  step('each version gets an ordinary link to the other');
  await apply(
    [
      { type: 'node.insert', owner: { kind: 'page', id: about }, index: 0, componentId: 'cta.banner', props: { heading: 'Lire en français', primaryLabel: 'Français', primaryLink: { type: 'page', target: fr } } },
      { type: 'node.insert', owner: { kind: 'page', id: fr }, index: 0, componentId: 'cta.banner', props: { heading: 'Read in English', primaryLabel: 'English', primaryLink: { type: 'page', target: about } } }
    ],
    'Language links'
  );

  step('without a Public URL the versions are served in their languages but list no alternates, which need full addresses');
  await eventually(
    async () => {
      const frHtml = await served('/fr/a-propos/');
      assert.equal(htmlLang(frHtml), 'fr', 'the French page is served as French');
      assert.match(frHtml, /Lire en français|Read in English/);
      assert.deepEqual(alternates(frHtml, '/fr/a-propos/'), []);
    },
    60000,
    500
  );
  await apply([{ type: 'site.update', baseUrl: `${PUBLIC}/` }], 'Public URL');

  step('with a Public URL the preview serves each page in its own language, listing both versions at full addresses');
  await eventually(
    async () => {
      const frHtml = await served('/fr/a-propos/');
      assert.equal(htmlLang(frHtml), 'fr', 'the French page is served as French');
      assert.deepEqual(alternates(frHtml, '/fr/a-propos/'), BOTH);
      assert.deepEqual(alternateHrefs(frHtml), FULL);
      assert.match(frHtml, /<title>À propos du studio<\/title>/);
    },
    60000,
    500
  );
  await eventually(
    async () => {
      const enHtml = await served('/about/');
      assert.equal(htmlLang(enHtml), 'en', 'About stays English');
      assert.deepEqual(alternates(enHtml, '/about/'), BOTH);
    },
    60000,
    500
  );
  assert.equal(htmlLang(await served('/contact/')), 'en', 'a page without translations keeps the site language');
  // In Preview, a visitor's link clicks move through the site in the editor's own frame.
  await win.locator('.pages-list [role="option"]', { hasText: /^About/ }).click();
  await win.locator('button[title^="Preview:"]').click();
  await eventually(async () => assert.equal(await win.locator('button[title^="Preview:"]').getAttribute('aria-checked'), 'true', 'Preview is on'));
  const frame = await (await win.locator('.frame-box iframe').elementHandle()).contentFrame();
  await eventually(async () => assert.equal(await frame.evaluate(() => location.pathname), '/about/'), 30000);
  await frame.waitForLoadState('networkidle');
  await frame.locator('html[data-so-bridge="preview"]').waitFor();
  const previewSteps = await walk(frame);
  assertWalk(previewSteps, 'preview');
  await win.locator('button[title^="Edit:"]').click();

  step('the exported website declares the same, on first load and as visitors move between the versions');
  const out = await withTimeout(win.evaluate(() => window.builder.project.exportStatic()), 300000, 'Static export');
  assert.equal(out.ok, true, `the export succeeds: ${out.message} ${out.warnings?.join(' ')}`);
  assert.deepEqual(
    out.warnings.filter((w) => /was built/.test(w)),
    [],
    'every built page declares its own language'
  );
  const exported = (path) => readFileSync(join(out.path, path), 'utf8');
  assert.equal(htmlLang(exported('fr/a-propos/index.html')), 'fr');
  assert.equal(htmlLang(exported('about/index.html')), 'en');
  assert.equal(htmlLang(exported('index.html')), 'en');
  assert.deepEqual(alternateHrefs(exported('fr/a-propos/index.html')), FULL);
  assert.deepEqual(alternateHrefs(exported('about/index.html')), FULL);
  assert.deepEqual(alternates(exported('contact/index.html'), '/contact/'), []);
  assert.ok(out.previewUrl, 'the export starts a preview of itself');
  assertWalk(await walkIn(new URL('about/', out.previewUrl).href), 'export');
  // The editable source carries the hook, so building it elsewhere gives the same pages.
  const source = await withTimeout(win.evaluate(() => window.builder.project.exportSource()), 120000, 'Source export');
  assert.equal(source.ok, true, `the source export succeeds: ${source.message}`);
  assert.equal(readFileSync(join(source.path, 'src', 'hooks.server.js'), 'utf8'), readFileSync(join(dir, 'src', 'hooks.server.js'), 'utf8'), 'the source export has the server hook');
  assert.match(readFileSync(join(source.path, 'src', 'hooks.server.js'), 'utf8'), /"\/fr\/a-propos": "fr"/);

  step('unlinked and back to the site language: one language again, and the hook lists no languages');
  await pageSettings('À propos');
  await win.getByRole('button', { name: 'Unlink About' }).click();
  await eventually(async () => assert.equal((await snapshot()).state.pages[fr].translationGroup, undefined));
  await language.fill('');
  await language.press('Enter');
  await eventually(async () => assert.equal('language' in (await snapshot()).state.pages[fr], false));
  await eventually(() => assert.doesNotMatch(readFileSync(join(dir, 'src', 'hooks.server.js'), 'utf8'), /LANGUAGES/, 'the server hook no longer lists page languages'), 20000);
  assert.doesNotMatch(readFileSync(join(dir, 'src', 'routes', '+layout.svelte'), 'utf8'), /pageLanguages/, 'the layout no longer follows page languages');
  await eventually(
    async () => {
      const html = await served('/fr/a-propos/');
      assert.equal(htmlLang(html), 'en', 'the copy is served in the site language again');
      assert.deepEqual(alternates(html, '/fr/a-propos/'), []);
    },
    60000,
    500
  );

  assert.deepEqual(errors, [], 'no uncaught errors in the editor');
} finally {
  await app.close();
}

cleanup();
console.log('\npage-languages: passed');
