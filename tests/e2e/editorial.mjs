// The Editorial theme against the real app (#390): the New project dialog offers it, with the starters drawn from
// Editorial's own thumbnails; a project made with it sets its headings in the pack's display serif from the
// project's own font files; every Editorial section measures clean at phone and desktop width; and Site styles
// switches the site to Foundation and back with every section and what it says unchanged, without going online.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { answerChoosers, eventually, launch, scratch, step, withTimeout } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('editorial');
const sites = join(WORK, 'sites');
mkdirSync(sites, { recursive: true });
const { app, win, errors } = await launch(WORK);

// Anything the window or its preview asks of a host other than this computer.
const external = [];
win.on('request', (r) => {
  const u = new URL(r.url());
  if (!['file:', 'data:', 'blob:', 'devtools:', 'chrome-extension:'].includes(u.protocol) && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) external.push(r.url());
});

step('New project offers Editorial, and shows the starters in Editorial’s own thumbnails');
await win.getByRole('button', { name: /New project/ }).first().click();
const dialog = win.getByRole('dialog', { name: 'New project' });
const picker = dialog.getByLabel('Theme');
assert.deepEqual(await picker.locator('option').allTextContents(), ['Foundation', 'Editorial'], 'the shipped themes, without development fixtures');
assert.equal(await picker.inputValue(), 'foundation', 'Foundation is the default');
const art = dialog.locator('.starter-card').first().locator('.starter-art');
const firstShot = () => art.locator('img').first().getAttribute('src');
await eventually(async () => assert.ok(await firstShot(), 'the starter is drawn from thumbnails'), 15000);
const foundationShot = await firstShot();
await picker.selectOption('editorial');
await eventually(async () => {
  assert.equal(await art.getAttribute('data-theme'), 'editorial');
  const shot = await firstShot();
  assert.ok(shot && shot !== foundationShot, 'the starter is redrawn from Editorial’s thumbnails');
}, 15000);
await dialog.screenshot({ path: join(SHOTS, 'editorial-new-project.png') });
await dialog.getByLabel('Project name').fill('Index Studio');
await answerChoosers(app, [{ dialog: 'open', title: 'Choose where to create the project', paths: [sites] }]);
await dialog.getByRole('button', { name: 'Choose…' }).click();
await eventually(async () => assert.match(await dialog.locator('#new-project-path').innerText(), /index-studio/));
await eventually(async () => assert.ok(await dialog.getByRole('button', { name: 'Create project' }).isEnabled()), 30000);
await dialog.getByRole('button', { name: 'Create project' }).click();
await win.waitForSelector('.editor', { timeout: 240000 });
const frame = win.frameLocator('.frame-box iframe');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
const placements = (st) => [...Object.values(st.pages), st.site.shell.header, st.site.shell.footer].flatMap((t) => Object.values(t.nodes)).filter((n) => n.kind === 'instance');

let st = await snapshot();
assert.equal(st.site.themeId, 'editorial', 'the project records the theme chosen');
assert.deepEqual(st.themeLock.theme, { id: 'editorial', version: '0.1.0' });
for (const n of placements(st)) assert.match(n.definitionId, /^editorial\./, `${n.definitionId} is Editorial’s`);

step('the preview sets headings in Playfair Display, loaded from the project');
await eventually(
  async () => {
    const loaded = await frame.locator('h1').first().evaluate(async (h) => {
      await document.fonts.ready;
      return { family: getComputedStyle(h).fontFamily, ok: [...document.fonts].some((f) => f.family.includes('Playfair Display') && f.status === 'loaded') };
    });
    assert.match(loaded.family, /Playfair Display Variable/);
    assert.ok(loaded.ok, 'the display font has loaded');
  },
  30000,
  300
);

step('every Editorial section measures clean at 390px and 1280px');
const pageId = st.site.homePageId;
const owner = { kind: 'page', id: pageId };
const SECTIONS = [
  'hero.centered', 'hero.split', 'intro.page', 'content.article', 'logos.strip', 'features.grid', 'content.media', 'content.text', 'stats.row', 'testimonials.grid', 'team.grid', 'pricing.plans',
  'data.table', 'faq.list', 'content.pages', 'content.news', 'blog.featured', 'blog.grid', 'blog.list', 'media.gallery', 'media.carousel', 'media.video', 'cta.banner', 'contact.details', 'contact.form', 'site.search', 'layout.section'
];
const present = new Set(st.pages[pageId].rootIds.map((id) => st.components[st.pages[pageId].nodes[id].definitionId]?.componentId));
for (const componentId of SECTIONS.filter((c) => !present.has(c))) await apply([{ type: 'node.insert', owner, componentId }], `Insert ${componentId}`);
st = await snapshot();
const onPage = new Set(st.pages[pageId].rootIds.map((id) => st.components[st.pages[pageId].nodes[id].definitionId]?.componentId));
assert.deepEqual(SECTIONS.filter((c) => !onPage.has(c)), [], 'every section is on the page');

const READABILITY = ['low-contrast', 'overlap', 'clipped-text', 'small-tap-target', 'contrast-unverified'];
/** Readability findings, less the shared header's and footer's small links, which Foundation reports too (inspect-layout.mjs). */
const measure = async (width) => {
  let report;
  for (let i = 0; i < 8; i++) {
    report = await withTimeout(win.evaluate(([id, w]) => window.builderTest.inspectLayout(id, w), [pageId, width]), 120000, `Layout inspection at ${width}px`);
    if (report && !report.error && report.checks) break;
    await new Promise((r) => setTimeout(r, 750));
  }
  assert.ok(report && !report.error && report.checks, `the inspection ran at ${width}px: ${JSON.stringify(report)}`);
  return report.issues.filter((i) => READABILITY.includes(i.kind) && !(i.kind === 'small-tap-target' && i.ref?.owner.kind === 'shell'));
};
/** Each finding with the section it was found in, for a failure message a person can act on. */
const named = (s, findings) => findings.map((f) => ({ ...f, component: s.components[s.pages[pageId].nodes[f.ref?.nodeId]?.definitionId]?.componentId }));
for (const width of [390, 1280]) {
  const findings = named(st, await measure(width));
  assert.deepEqual(findings, [], `Editorial at ${width}px:\n${JSON.stringify(findings, null, 1)}`);
}

step('Site styles switches to Foundation and back, keeping every section and what it says');
const before = await snapshot();
const content = (s) => Object.fromEntries(Object.values(s.pages).map((p) => [p.id, { rootIds: p.rootIds, nodes: Object.fromEntries(Object.values(p.nodes).map((n) => [n.id, n.kind === 'instance' ? { ...n, definitionId: s.components[n.definitionId]?.componentId } : n])) }]));
await win.locator('.dock-tab', { hasText: 'Styles' }).click();
const theme = win.locator('#dock-panel-styles .ss-theme-meta').getByLabel('Theme');
await theme.waitFor();
await theme.selectOption('foundation');
await eventually(async () => assert.equal((await snapshot()).site.themeId, 'foundation'));
const onFoundation = await snapshot();
assert.deepEqual(content(onFoundation), content(before), 'every placement keeps its content, links, images and styles on Foundation');
for (const n of placements(onFoundation)) assert.match(n.definitionId, /^foundation\./);
await eventually(async () => assert.match(await frame.locator('h1').first().evaluate((h) => getComputedStyle(h).fontFamily), /Fraunces Variable/), 30000, 300);
await theme.selectOption('editorial');
await eventually(async () => assert.equal((await snapshot()).site.themeId, 'editorial'));
const back = await snapshot();
assert.deepEqual(back.pages, before.pages, 'back on Editorial, the pages are exactly as they were');
assert.deepEqual(back.site, before.site);
assert.deepEqual(back.tokens, before.tokens);
await eventually(async () => assert.match(await frame.locator('h1').first().evaluate((h) => getComputedStyle(h).fontFamily), /Playfair Display Variable/), 30000, 300);

assert.deepEqual(external, [], 'nothing was fetched from the network');
assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\neditorial: passed');
