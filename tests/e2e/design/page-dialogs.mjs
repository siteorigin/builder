// Design capture for the page lifecycle dialogs (Dialogs.tsx: DeletePageModal and SetHomeModal). Opt-in only,
// never part of `npm run test:e2e`, and it never confirms a deletion or a home page change:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/page-dialogs.mjs
//
// A Business site is grown through the real edit pipeline into one where every branch of both dialogs has
// something to show: a page nothing links to, a section page in the header menu, cards in a page list, links that
// jump to a section the replacement page lacks, and Home itself. Each dialog is opened from the page's menu in the
// Pages panel, the way a person opens it. A capture checks its dialog and the state's own marker are on screen and
// throws rather than write an image of anything else. Files are `{state}--{theme}.png`, cropped to the dialog with
// a margin of the window; `context` is the whole window.
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, launch, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('page dialogs capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'page-dialogs');
mkdirSync(OUT, { recursive: true });
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

const { WORK, cleanup } = scratch('design-page-dialogs');
const { app, win, errors } = await launch(WORK);
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
await win.emulateMedia({ reducedMotion: 'reduce' });
await app.evaluate(({ shell }) => {
  shell.openExternal = async () => undefined;
  shell.showItemInFolder = () => undefined;
});
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = async (operations, label) => {
  const r = await win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);
  if (!r?.ok) throw new Error(`${label}: ${JSON.stringify(r?.error ?? r)}`);
  return r;
};

/** The top dialog with a margin of the window around it, so its edge and shadow read. */
async function clip() {
  const box = await win.locator('.modal').last().boundingBox();
  const size = win.viewportSize();
  const x = Math.max(0, Math.floor(box.x - 24));
  const y = Math.max(0, Math.floor(box.y - 24));
  return { x, y, width: Math.min(size.width - x, Math.ceil(box.width + 48)), height: Math.min(size.height - y, Math.ceil(box.height + 48)) };
}

/**
 * Capture the open dialog in each theme. `check` must be visible inside it at the moment of capture, and the safe
 * choice (`focus`, Cancel unless named) must hold focus, unless `focus` is null because the state moved it.
 */
async function shot(state, check, { themes = BOTH, full = false, focus = 'Cancel' } = {}) {
  const dialog = win.locator('.modal').last();
  await dialog.waitFor({ timeout: 30000 });
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await win.mouse.move(4, 4);
    await pause(280);
    if (!(await dialog.isVisible())) throw new Error(`"${state}" (${theme}): no dialog on screen; refusing to write`);
    if (!(await dialog.locator(check).first().isVisible().catch(() => false))) throw new Error(`"${state}" (${theme}): "${check}" is not in the dialog; refusing to write`);
    const focused = await win.evaluate(() => (document.activeElement === document.body ? '(page body)' : document.activeElement?.textContent?.trim().slice(0, 60)));
    if (focus !== null && focused !== focus) throw new Error(`"${state}" (${theme}): focus is on "${focused}", expected "${focus}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, ...(full ? {} : { clip: await clip() }) });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

/** Open a page's dialog from its row's menu in the Pages panel. */
async function open(pageId, item) {
  const row = win.locator(`.side-panel-view:not([hidden]) [data-page="${pageId}"]`).first();
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: 'right' });
  await pause(250);
  await win.getByRole('menuitem', { name: item }).click();
  await win.locator('.modal').last().waitFor();
  await pause(400);
}
/** Escape means keep everything as it is. */
async function dismiss() {
  await win.keyboard.press('Escape');
  await win.locator('.modal').waitFor({ state: 'detached' });
  await pause(200);
}

// ---- The site: Business starter, grown into the shapes the dialogs have to explain ----
const sites = join(WORK, 'sites');
await createProject(win, { name: 'Harbour Lane Studio', parentDir: sites, starter: 'business', sampleImages: true });
let st = (await snapshot()).state;
const byTitle = (s, title) => Object.values(s.pages).find((p) => p.title === title);
const home = st.site.homePageId;
const about = byTitle(st, 'About').id;
const contact = byTitle(st, 'Contact').id;
const header = { kind: 'shell', id: 'header' };
const footer = { kind: 'shell', id: 'footer' };
const headerNode = st.site.shell.header.rootIds[0];
const footerNode = st.site.shell.footer.rootIds[0];

await apply(
  [
    { type: 'page.create', pageId: 'pg_services', title: 'Services', route: '/services/', afterPageId: about, starter: 'intro', addToNavigation: true },
    { type: 'page.create', pageId: 'pg_garden', title: 'Garden design', route: '/services/garden-design/', afterPageId: 'pg_services', starter: 'intro' },
    { type: 'page.create', pageId: 'pg_kitchens', title: 'Kitchen and bathroom renovations for heritage villas', route: '/services/kitchen-and-bathroom-renovations/', afterPageId: 'pg_garden', starter: 'intro' },
    { type: 'page.create', pageId: 'pg_careers', title: 'Careers', route: '/careers/', afterPageId: contact, starter: 'intro' },
    { type: 'page.create', pageId: 'pg_spring', title: 'Spring open studio', route: '/spring-open-studio/', afterPageId: 'pg_careers', starter: 'intro' },
    { type: 'page.update', pageId: 'pg_spring', draft: true }
  ],
  'Add pages'
);
st = (await snapshot()).state;
const details = Object.values(st.pages[contact].nodes).find((n) => n.kind === 'instance' && st.components[n.definitionId]?.componentId === 'contact.details');
const faq = Object.values(st.pages[contact].nodes).find((n) => n.kind === 'instance' && st.components[n.definitionId]?.componentId === 'faq.list');
const footerContact = st.site.shell.footer.nodes[footerNode].props.links.find((l) => l.link.target === contact);
const cta = (pageId) => Object.values(st.pages[pageId].nodes).find((n) => n.kind === 'instance' && st.components[n.definitionId]?.componentId === 'cta.banner');

await apply(
  [
    // Contact's sections carry IDs that links jump to, and About has neither.
    { type: 'node.setContent', owner: { kind: 'page', id: contact }, nodeId: details.id, field: 'anchor', value: 'studio-hours' },
    { type: 'node.setContent', owner: { kind: 'page', id: contact }, nodeId: faq.id, field: 'anchor', value: 'questions' },
    { type: 'instance.setProp', owner: header, nodeId: headerNode, prop: 'ctaLink', value: { type: 'page', target: contact, anchor: 'studio-hours' } },
    { type: 'instance.setProp', owner: footer, nodeId: footerNode, prop: 'links', itemId: footerContact.id, field: 'link', value: { type: 'page', target: contact, anchor: 'questions' } },
    // Home lists two services as cards, and the Services page links to Garden design from its call to action.
    {
      type: 'node.insert',
      owner: { kind: 'page', id: home },
      index: 3,
      componentId: 'content.pages',
      props: {
        heading: 'What we do',
        items: [
          { id: 'i_cardgarden', pageLink: { type: 'page', target: 'pg_garden' }, title: '', description: '', image: null },
          { id: 'i_cardkitchen', pageLink: { type: 'page', target: 'pg_kitchens' }, title: '', description: '', image: null },
          { id: 'i_cardservices', pageLink: { type: 'page', target: 'pg_services' }, title: 'Everything we offer', description: '', image: null }
        ]
      }
    }
  ],
  'Link the pages together'
);
st = (await snapshot()).state;
// About's closing banner points at Services, so Services has links from a page as well as the header.
const aboutCta = cta(about);
if (aboutCta) {
  const props = st.pages[about].nodes[aboutCta.id].props;
  const linkProp = Object.keys(props).find((k) => props[k] && typeof props[k] === 'object' && props[k].type === 'page');
  if (linkProp) await apply([{ type: 'instance.setProp', owner: { kind: 'page', id: about }, nodeId: aboutCta.id, prop: linkProp, value: { type: 'page', target: 'pg_services' } }], 'Point About at Services');
}
const homeCta = cta(home);
if (homeCta) {
  const props = st.pages[home].nodes[homeCta.id].props;
  const linkProp = Object.keys(props).find((k) => props[k] && typeof props[k] === 'object' && props[k].type === 'page');
  if (linkProp) await apply([{ type: 'instance.setProp', owner: { kind: 'page', id: home }, nodeId: homeCta.id, prop: linkProp, value: { type: 'page', target: contact, anchor: 'studio-hours' } }], 'Point Home at Contact hours');
}

if ((await win.locator('.rail [aria-label="Pages"]').getAttribute('aria-pressed')) !== 'true') await win.locator('.rail [aria-label="Pages"]').click();
await pause(600);

// ---- Delete page ----
// Nothing links to Careers: the plainest question.
await open('pg_careers', /^Delete page/);
await shot('delete-unlinked', '#delete-page-desc', { themes: LIGHT });
await dismiss();

// Services is in the header menu and About's banner links to it: its links move to the page chosen.
await open('pg_services', /^Delete page/);
await shot('delete-linked', 'select', { themes: BOTH });
await shot('context', 'select', { themes: LIGHT, full: true });
await dismiss();

// Contact's links jump to sections About lacks: each needs a place on About.
await open(contact, /^Delete page/);
await win.locator('.modal select').first().selectOption(about);
await pause(400);
await shot('delete-sections', 'select >> nth=1', { themes: BOTH, focus: null });
// One section chosen, one still to choose.
await win.locator('.modal select').nth(1).selectOption({ label: 'Top of page' });
await pause(300);
await shot('delete-sections-partial', 'select >> nth=2', { themes: LIGHT, focus: null });
// The footer's action takes the author to the choice still open.
await win.locator('.modal .page-dialog-status-action').click();
await pause(200);
const unset = await win.evaluate(() => document.activeElement?.matches('.modal select[data-unset]') ?? false);
if (!unset) throw new Error('the footer action did not focus the section still to choose');
await shot('delete-sections-goto', 'select[data-unset]:focus', { themes: LIGHT, focus: null });
await dismiss();

// Garden design is a card in Home's page list: the card goes with the page.
await open('pg_garden', /^Delete page/);
await shot('delete-cards', '#delete-page-cards, [data-cards]', { themes: LIGHT });
await dismiss();

// Home itself: another page has to take its place.
await open(home, /^Delete page/);
await shot('delete-home', 'select', { themes: BOTH });
await dismiss();

// ---- Make home page ----
await open(about, 'Make home page…');
await shot('set-home', 'input[type="checkbox"]', { themes: BOTH });
await win.locator('.modal input[type="checkbox"]').uncheck();
await pause(300);
await shot('set-home-unkept', 'input[type="checkbox"]:not(:checked)', { themes: LIGHT, focus: null });
await dismiss();

// A long title deep in a section, with cards and header links that change destination.
await open('pg_kitchens', 'Make home page…');
await shot('set-home-long', 'input[type="checkbox"]', { themes: LIGHT });
await dismiss();

st = (await snapshot()).state;
if (st.site.homePageId !== home || !st.pages.pg_careers || !st.pages.pg_services || !st.pages[contact]) throw new Error('a dialog changed the project; every one must be dismissed');
if (errors.length) throw new Error(`page errors: ${errors.join('\n')}`);

await win.evaluate(() => window.builder.projects.close());
await app.close();
cleanup();

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`page dialogs capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
