// A visitor's journey in Preview (#233): Home → About → Book a call, a link to /contact/#studio-hours. The Preview
// pill shows the address with its #fragment, Back and Forward step through the visits (a section jump on the same
// page included) and bring back each page where the visitor left it, a new link after Back drops Forward, and the
// browser's Back key steps once without touching the project's Undo history. The journey starts where Preview was
// entered: pages opened while editing are not part of it.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const mac = process.platform === 'darwin';
const { WORK, SHOTS, cleanup } = scratch('preview-history');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Journey Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
await win.evaluate(() => {
  window.__previewHistoryRevisions = [];
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'revisionApplied') window.__previewHistoryRevisions.push(event.data.payload?.revision);
  });
});

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = (operations, label) => win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);
const revision = async () => (await snapshot()).revision;

const pill = win.getByRole('group', { name: 'Preview', exact: true });
const back = pill.getByRole('button', { name: 'Back', exact: true });
const forward = pill.getByRole('button', { name: 'Forward', exact: true });
const address = pill.locator('output');
const pageShown = win.locator('.project-title .page');
const frameAt = () => frame.locator('html').evaluate(() => location.pathname + location.hash);
const scrollY = () => frame.locator('html').evaluate(() => Math.round(window.scrollY));
const scrollTo = (y) => frame.locator('html').evaluate((html, y) => window.scrollTo({ top: y, behavior: 'instant' }), y);
/** Where the page rests once fonts, images and the browser's scroll anchoring have settled: what the site keeps
 *  for the entry when the visitor leaves it. */
async function settledScroll() {
  return eventually(async () => {
    const a = await scrollY();
    await win.waitForTimeout(300);
    assert.equal(await scrollY(), a, 'the page has stopped moving');
    return a;
  });
}
/** Follow a link on the page as a visitor's click does, without first scrolling it into view, once the page has
 *  loaded and is in Preview (a link is picked, not followed, while editing). */
async function follow(link) {
  await eventually(async () => assert.equal(await frame.locator('html').evaluate((html) => document.readyState === 'complete' && !html.hasAttribute('data-so-editing')), true, 'the page is ready for a visitor'));
  await link.evaluate((a) => a.click());
}

/** The pill, the page in the frame and the toolbar all agree on where the visitor is. */
async function at(where, page, { canBack, canForward }) {
  await eventually(async () => {
    assert.equal(await address.innerText(), where, 'the pill shows the address, #fragment included');
    assert.equal(await frameAt(), where, 'the frame is there');
    assert.match(await pageShown.innerText(), new RegExp(page), 'the toolbar follows the page');
    assert.equal(await back.isEnabled(), canBack, `Back is ${canBack ? 'enabled' : 'disabled'} at ${where}`);
    assert.equal(await forward.isEnabled(), canForward, `Forward is ${canForward ? 'enabled' : 'disabled'} at ${where}`);
  }, 15000);
}
/** The page is back where the visitor left it, and stays there (the site restores it once the page has rendered). */
const scrolledTo = (y, where) =>
  eventually(async () => {
    for (let i = 0; i < 2; i++) {
      if (i) await win.waitForTimeout(200);
      assert.ok(Math.abs((await scrollY()) - y) <= 2, `${where} is back at ${y}px (now ${await scrollY()}px)`);
    }
  }, 10000);

/** The browser's Back or Forward key, sent as native input while the preview frame has focus. */
async function stepKey(dir) {
  await frame.locator('body').evaluate(() => window.focus());
  await eventually(async () => assert.equal(await win.evaluate(() => document.activeElement?.tagName), 'IFRAME', 'the preview frame has focus'));
  await app.evaluate(
    ({ BrowserWindow }, { dir, mac }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      const keyCode = mac ? (dir === 'back' ? '[' : ']') : dir === 'back' ? 'Left' : 'Right';
      const modifiers = [mac ? 'meta' : 'alt'];
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    },
    { dir, mac }
  );
}

step('Book a call goes to the studio hours on Contact; the FAQ has an anchor of its own');
const s0 = (await snapshot()).state;
const contact = Object.values(s0.pages).find((p) => p.title === 'Contact');
const [{ definitionId: anchorSection }] = await apply([{ type: 'component.upsert', name: 'Anchor section',
  properties: { heading: { type: 'string', label: 'Heading', default: 'Studio hours' } },
  nodes: [{ kind: 'element', id: 'root', tag: 'section', children: ['heading'] },
    { kind: 'text', id: 'heading', tag: 'h2', text: { $prop: 'heading' } }]
}], 'Make anchor section').then((r) => r.results);
const [{ nodeId: details }, { nodeId: faq }] = await apply([
  { type: 'node.insert', owner: { kind: 'page', id: contact.id }, parentId: null, definitionId: anchorSection },
  { type: 'node.insert', owner: { kind: 'page', id: contact.id }, parentId: null, definitionId: anchorSection }
], 'Place anchor sections').then((r) => r.results);
const header = s0.site.shell.header.rootIds[0];
for (const [ops, label] of [
  [[{ type: 'node.setContent', owner: { kind: 'page', id: contact.id }, nodeId: details, field: 'anchor', value: 'studio-hours' }], 'Anchor'],
  [[{ type: 'node.setContent', owner: { kind: 'page', id: contact.id }, nodeId: faq, field: 'anchor', value: 'questions' }], 'Anchor'],
  [[{ type: 'instance.setProp', owner: { kind: 'page', id: contact.id }, nodeId: faq, prop: 'heading', value: 'Questions' }], 'Question heading'],
  [[{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header, prop: 'ctaLink', value: { type: 'page', target: contact.id, anchor: 'studio-hours' } }], 'Link']
]) {
  const r = await apply(ops, label);
  assert.equal(r.ok, true, `${label}: ${r.error?.message}`);
}
const cta = frame.locator('header a.so-header__cta');
await eventually(async () => assert.equal(await cta.getAttribute('href'), '/contact/#studio-hours', 'the header button links to the studio hours'));
const menuLink = (label) => frame.locator('header nav a', { hasText: label }).first();

step('pages opened while editing are not part of the journey');
await win.locator('.side-panel .list-item', { hasText: 'Contact' }).click();
await eventually(async () => assert.equal(await frame.locator('#studio-hours').count(), 1, 'the anchored section is on Contact before the visitor follows its link'), 30000);
await win.locator('.side-panel .list-item', { hasText: 'About' }).click();
await eventually(async () => assert.equal(await frameAt(), '/about/'));
await win.locator('.side-panel .list-item', { hasText: 'Home' }).click();
await eventually(async () => assert.equal(await frameAt(), '/'));
await win.locator('button[title^="Preview:"]').click();
await at('/', 'Home', { canBack: false, canForward: false });

step('Home → About → Book a call');
await follow(menuLink('About'));
await at('/about/', 'About', { canBack: true, canForward: false });
await eventually(async () => assert.equal(await frame.getByRole('heading', { name: 'A small studio with a long view' }).count(), 1, 'About has replaced Home in the frame'), 30000);
await scrollTo(600);
const atAbout = await settledScroll();
const contactRevision = (await snapshot()).revision;
await eventually(async () => assert.equal(await win.evaluate((revision) => window.builder.project.previewRouteReady('/contact/', revision), contactRevision), true, 'the newly generated Contact route is ready for visitor navigation'), 30000);
await eventually(async () => assert.equal(await win.evaluate((revision) => window.__previewHistoryRevisions.includes(revision), contactRevision), true, 'the preview has applied the contact edit'), 30000);
const contactHtml = await frame.locator('html').evaluate(async () => (await fetch('/contact/')).text());
assert.match(contactHtml, /Studio hours/, 'the Contact route serves its new content');
assert.equal(await frameAt(), '/about/', 'About remains in the frame before the Contact link is followed');
assert.equal(await frame.getByRole('heading', { name: 'A small studio with a long view' }).count(), 1, 'About content remains before the Contact link');
await follow(cta);
await at('/contact/#studio-hours', 'Contact', { canBack: true, canForward: false });
await eventually(async () => {
  const destination = await frame.locator('html').evaluate(() => ({
    found: document.querySelectorAll('#studio-hours').length,
    top: document.getElementById('studio-hours')?.getBoundingClientRect().top ?? null,
    url: location.href,
    scrollY,
    maxScroll: document.documentElement.scrollHeight - innerHeight,
    innerHeight
  }));
  assert.equal(destination.found, 1, `Contact's destination is rendered: ${JSON.stringify(destination)}`);
  assert.equal(new URL(destination.url).pathname, '/contact/', 'the frame stays on Contact');
  const top = destination.top;
  assert.ok(top >= -2 && (top < 200 || (top < destination.innerHeight && destination.scrollY >= destination.maxScroll - 2)), `the page opened as far as possible toward the studio hours: ${JSON.stringify(destination)}`);
});
await win.screenshot({ path: join(SHOTS, 'preview-history.png') });

step('a section jump on the same page is a step of its own');
// A link to the FAQ, added where it takes no room on the page, so the page stays where the visitor left it.
const atHours = await settledScroll();
await frame.locator('body').evaluate((body) => {
  const a = document.createElement('a');
  a.id = 'to-questions';
  a.href = '#questions';
  a.textContent = 'Questions';
  a.style.cssText = 'position:fixed;left:0;bottom:0;z-index:9999';
  // Inside the site's own markup, where its router handles a visitor's click.
  (body.querySelector('main') ?? body).append(a);
});
await follow(frame.locator('#to-questions'));
await at('/contact/#questions', 'Contact', { canBack: true, canForward: false });
await back.click();
await at('/contact/#studio-hours', 'Contact', { canBack: true, canForward: true });
await scrolledTo(atHours, 'the studio hours');

step('Back to About, where the visitor left it, and Forward again');
const revisionBefore = await revision();
await back.click();
await at('/about/', 'About', { canBack: true, canForward: true });
await scrolledTo(atAbout, 'About');
await forward.click();
await at('/contact/#studio-hours', 'Contact', { canBack: true, canForward: true });
await scrolledTo(atHours, 'Contact');
await forward.click();
await at('/contact/#questions', 'Contact', { canBack: true, canForward: false });

step('the Back and Forward keys step once each, from the page');
await stepKey('back');
await at('/contact/#studio-hours', 'Contact', { canBack: true, canForward: true });
await stepKey('back');
await at('/about/', 'About', { canBack: true, canForward: true });
await stepKey('forward');
await at('/contact/#studio-hours', 'Contact', { canBack: true, canForward: true });
await stepKey('back');
await at('/about/', 'About', { canBack: true, canForward: true });
assert.equal(await revision(), revisionBefore, 'stepping through the journey never changes the project');

step('a new link after Back drops Forward');
await follow(menuLink('Home'));
await at('/', 'Home', { canBack: true, canForward: false });
await back.click();
await at('/about/', 'About', { canBack: true, canForward: true });
await back.click();
await at('/', 'Home', { canBack: false, canForward: true });

step('a quick visit to Edit keeps the journey; opening another page there starts a new one');
await pill.getByRole('button', { name: 'Back to editing' }).click();
await win.locator('button[title^="Preview:"]').click();
await at('/', 'Home', { canBack: false, canForward: true });
await pill.getByRole('button', { name: 'Back to editing' }).click();
await win.locator('.side-panel .list-item', { hasText: 'Contact' }).click();
await eventually(async () => assert.equal(await frameAt(), '/contact/'));
await win.locator('button[title^="Preview:"]').click();
await at('/contact/', 'Contact', { canBack: false, canForward: false });

step('a page loaded in full is a visit, and Back returns across it');
await frame.locator('html').evaluate(() => location.assign('/about/'));
await at('/about/', 'About', { canBack: true, canForward: false });
await back.click();
await at('/contact/', 'Contact', { canBack: false, canForward: true });

step('another project starts with a fresh journey');
const firstProject = (await snapshot()).workspaceKey;
const created = await win.evaluate((o) => window.builder.projects.create(o), { name: 'Second Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
assert.equal(created.ok, true, `the second project opens: ${created.message}`);
await eventually(async () => assert.notEqual((await snapshot()).workspaceKey, firstProject, 'the second project is open'), 120000);
await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 120000 });
await win.locator('button[title^="Preview:"]').click();
await at('/', 'Home', { canBack: false, canForward: false });

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\npreview-history: passed');
