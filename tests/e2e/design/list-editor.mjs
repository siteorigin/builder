// Design capture harness for the Inspector's list editor (ListEditor in panels/PropEditors.tsx): the stack of rows for
// any repeating content, each a title that opens its fields, with its moves, Remove and Add. Drives the real built app
// through the lists the Business starter has (the shared header's menu with a submenu and its order, testimonials with
// an incomplete and an untitled row, the gallery's thumbnails, the footer's contact links with one that opens something
// else) plus a Page list, and writes one PNG per state and theme, cropped to the dock around the list. Opt-in only,
// never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/list-editor.mjs
//
// Every fixture goes through the app's own edit seam (project.apply). Each capture is verified after it settles; a
// state that did not render throws instead of writing a plausible-looking wrong image. Files are named
// `list-{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('list editor capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set to a directory outside the repo');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-listed-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 1000 });
await win.waitForSelector('.welcome', { timeout: 120000 });
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const insp = win.locator('#dock-panel-inspect');

async function until(check, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(150);
  }
}
const waitThumbs = () =>
  win
    .waitForFunction(() => [...document.querySelectorAll('.dock .list-editor-thumb img')].filter((i) => i.getBoundingClientRect().height > 0).every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 })
    .catch(() => {});

/** Capture the dock's width around `target` (with `pad` above and below), in the given themes; `verify` must hold. */
async function shot(state, target, verify, { themes = LIGHT, pad = 16, keep = false, mouse = true } = {}) {
  // Below whatever sticks to the top of the Inspector's scroller (its header card), so the list's own label shows.
  if (!keep)
    await target.first().evaluate((el) => {
      el.scrollIntoView({ block: 'start' });
      let box = el.parentElement;
      while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
      if (!box) return;
      const stuck = [...box.querySelectorAll('*')].filter((x) => getComputedStyle(x).position === 'sticky').reduce((m, x) => Math.max(m, x.getBoundingClientRect().bottom), box.getBoundingClientRect().top);
      const gap = stuck + 40 - el.getBoundingClientRect().top;
      if (gap > 0) box.scrollTop -= gap;
    });
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(260);
    if (mouse) await win.mouse.move(2, 990);
    await waitThumbs();
    if (!(await verify().catch(() => false))) {
      await win.screenshot({ path: join(OUT, `debug-${state}--${theme}.png`) }).catch(() => {});
      throw new Error(`state "${state}" (${theme}) did not render; refusing to write (see debug-${state}--${theme}.png)`);
    }
    const dock = await win.locator('.dock').boundingBox();
    const box = await target.first().boundingBox();
    if (!dock || !box) throw new Error(`state "${state}" (${theme}) has no box; refusing to write`);
    const top = Math.max(dock.y, box.y - pad);
    const bottom = Math.min(dock.y + dock.height, box.y + box.height + pad);
    const path = join(OUT, `list-${state}--${theme}.png`);
    await win.screenshot({ path, clip: { x: dock.x, y: top, width: dock.width, height: bottom - top } });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
  await pause(100);
}

const apply = (operations, label = 'Seed') =>
  win.evaluate(
    async ({ operations, label }) => {
      const r = await window.builder.project.apply({ operations }, { label });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r;
    },
    { operations, label }
  );
const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
/** The home page's placement of `componentId`, as { owner, node }. */
async function homeNode(componentId) {
  const s = await snapshot();
  const page = s.pages[s.site.homePageId];
  const node = Object.values(page.nodes).find((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === componentId);
  if (!node) throw new Error(`no ${componentId} on the home page`);
  return { owner: { kind: 'page', id: page.id }, node };
}
async function shellNode(part) {
  const s = await snapshot();
  const id = s.site.shell[part].rootIds[0];
  return { owner: { kind: 'shell', id: part }, node: s.site.shell[part].nodes[id] };
}
const setProp = async ({ owner, node }, prop, value) => {
  await apply([{ type: 'instance.setProp', owner, nodeId: node.id, prop, value }]);
  await pause(400);
};
const openRail = async (name) => {
  const b = win.locator(`.rail [aria-label="${name}"]`);
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
  await pause(250);
};
async function select(name) {
  await openRail('Layers');
  await win.locator('[role="tree"] .list-item', { hasText: name }).first().click();
  await insp.locator('.insp-name h3').first().waitFor({ timeout: 30000 });
  await pause(450);
}
async function dockWidth(key) {
  await win.getByRole('separator', { name: 'Resize right panel' }).focus();
  await win.keyboard.press(key);
  await pause(500);
  await win.evaluate(() => document.activeElement?.blur());
}
const list = (name) => insp.locator(`[data-list="${name}"]`).first();
const rows = (l) => l.locator('.list-editor-item');
const heads = (l) => l.locator('.list-editor-head button.title');

// ---- The Business starter ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
await win.waitForSelector('.editor', { timeout: 120000 });
await frame.locator('h1').first().waitFor({ timeout: 180000 });
await pause(1500);
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
await win.evaluate(() => {
  for (const k of Object.keys(localStorage)) if (k.startsWith('section:')) localStorage.removeItem(k);
  localStorage.setItem('section:content', '1');
});

// The header menu: a Services link with a submenu, one long label, and a link to another site.
const header = await shellNode('header');
const st0 = await snapshot();
const pageIds = st0.site.pageOrder;
const links = header.node.props.links ?? [];
const pageLink = (i) => ({ type: 'page', target: pageIds[i % pageIds.length] });
await setProp(header, 'links', [
  ...links.slice(0, 2),
  { label: 'Services', link: pageLink(0), sub: false },
  { label: 'Kitchens', link: { type: 'url', target: 'https://example.com/kitchens' }, sub: true },
  { label: 'Bathrooms, laundries and wet areas from start to finish', link: { type: 'url', target: 'https://example.com/bathrooms' }, sub: true },
  ...links.slice(2),
  { label: 'Shop', link: { type: 'url', target: 'https://shop.example.com' }, sub: false }
]);

// ---- 1. The header menu: its order, a submenu, a long label ----
await openRail('Layers');
const headerRow = win.locator('[role="tree"] .list-item', { hasText: /header/i }).first();
await headerRow.click();
await insp.locator('[data-list="links"]').first().waitFor({ timeout: 30000 });
await pause(500);
const menu = list('links');
await shot('menu', menu, async () => (await rows(menu).count()) >= 6 && (await menu.locator('.list-editor-item.nested').count()) === 2 && (await menu.locator('select, .header-menu-order').count()) > 0, { themes: BOTH });

// 2. A link open, with the link editor inside it.
await heads(menu).nth(2).click();
await until(async () => (await heads(menu).nth(2).getAttribute('aria-expanded')) === 'true', 'the Services link open');
await pause(500);
await shot('menu-open', menu, async () => await menu.locator('.list-editor-body:not([hidden])').first().isVisible(), { themes: BOTH });
await heads(menu).nth(2).click();
await pause(300);

// 3. Remove, pointed at.
const removeBtn = rows(menu).nth(3).getByRole('button', { name: /^Remove/ });
await removeBtn.evaluate((el) => el.scrollIntoView({ block: 'center' }));
await pause(300);
await removeBtn.hover();
await pause(300);
await shot('menu-remove-hover', rows(menu).nth(3), () => removeBtn.evaluate((el) => el.matches(':hover')), { themes: BOTH, mouse: false, keep: true, pad: 48 });
// 4. A move from the keyboard: focus stays on the button that moved it.
await win.mouse.move(2, 990);
const seeded = (await shellNode('header')).node.props.links;
await win.keyboard.press('Shift');
await rows(menu).nth(5).getByRole('button', { name: /^Move .* up/ }).focus();
await win.keyboard.press('Enter');
await pause(900);
await shot('menu-moved-keyboard', menu, () => win.evaluate(() => /^Move .* up$/.test(document.activeElement?.getAttribute('aria-label') ?? '') && document.activeElement.matches(':focus-visible')));
await win.evaluate(() => document.activeElement?.blur());
await apply([{ type: 'instance.setProp', owner: header.owner, nodeId: header.node.id, prop: 'links', value: seeded }]);
await pause(400);

// 5. Following the page order: the moves are locked, saying why.
await apply([{ type: 'site.update', headerMenuOrder: 'follow' }]);
await pause(600);
await shot('menu-locked', menu, async () => /choose Own order/.test(await menu.innerText()) && (await menu.locator('select[aria-busy], .header-menu-order').count()) > 0, { themes: BOTH });
await apply([{ type: 'site.update', headerMenuOrder: 'own' }]);
await pause(400);

// 6. The narrowest right panel.
await dockWidth('Home');
await shot('menu-narrow', menu, async () => (await rows(menu).count()) >= 6);
await win.locator('.resizer[aria-label="Resize right panel"]').dblclick().catch(() => {});
await pause(500);

// ---- 7. The footer's contact links: one that opens something other than its text is flagged ----
const footer = await shellNode('footer');
const contact = footer.node.props.contact ?? [];
await setProp(footer, 'contact', [{ ...contact[0], label: 'hello@harbourlane.studio', link: { type: 'email', target: 'studio@harbour.example' } }, ...contact.slice(1)]);
await openRail('Layers');
await win.locator('[role="tree"] .list-item', { hasText: /footer/i }).first().click();
await insp.locator('[data-list="contact"]').first().waitFor({ timeout: 30000 });
await pause(500);
const contacts = list('contact');
await shot('contact-flagged', contacts, async () => (await contacts.locator('[id^="list-flag-"]').count()) > 0, { themes: BOTH });

// ---- 8. Testimonials: an incomplete row (its quote is required) and one with nothing to name it by ----
const quotes = await homeNode('testimonials.grid');
const qs = quotes.node.props.items ?? [];
if (qs.length < 2) throw new Error('the testimonials have too few items to seed');
await setProp(quotes, 'items', [qs[0], { ...qs[1], name: '', role: '', portrait: { assetId: null, alt: '' } }, ...qs.slice(2), { quote: 'They turned a cramped 1970s kitchen into the room the whole family now lives in, and finished a week early.', name: 'Aroha Te Rangi-Whitcombe, homeowner in Devonport', role: '', portrait: { assetId: null, alt: '' } }]);
// A required field left empty is refused by an edit, so the incomplete row is one the project was saved with: the
// document is written with the first quote emptied and the project reopened, as after an import or a hand edit.
let incompleteSeeded = false;
{
  const s = await win.evaluate(() => window.builder.project.snapshot());
  const { readFileSync, writeFileSync, readdirSync: ls } = await import('node:fs');
  const docDir = join(s.dir, 'siteorigin', 'pages');
  for (const f of ls(docDir).filter((f) => f.endsWith('.json'))) {
    const path = join(docDir, f);
    const text = readFileSync(path, 'utf8');
    const quote = qs[0].quote;
    if (typeof quote === 'string' && text.includes(JSON.stringify(quote))) {
      writeFileSync(path, text.replace(JSON.stringify(quote), '""'));
      incompleteSeeded = true;
    }
  }
  if (incompleteSeeded) {
    await win.evaluate(() => window.builder.projects.close());
    await win.waitForSelector('.welcome');
    await win.evaluate((dir) => window.builder.projects.open(dir), s.dir);
    await win.waitForSelector('.editor', { timeout: 120000 });
    await frame.locator('h1').first().waitFor({ timeout: 180000 });
    await pause(1500);
    await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
  } else console.log('could not seed an incomplete row: the quote was not found in a page document');
}
await select('Testimonials');
const said = list('items');
await said.waitFor({ timeout: 20000 });
await shot('testimonials', said, async () => (!incompleteSeeded || /required/i.test(await rows(said).first().innerText())) && (await said.locator('.list-editor-name.untitled').count()) > 0, { themes: BOTH });
// The incomplete row open: its fields say what is missing.
await heads(said).nth(0).click();
await pause(500);
await shot('testimonials-open', said, async () => (await heads(said).nth(0).getAttribute('aria-expanded')) === 'true');
await heads(said).nth(0).click();
await pause(300);
// A row dragged over the first: where it will land, while it is held.
const dragged = await win.evaluate(() => {
  const list = document.querySelector('#dock-panel-inspect [data-list="items"]');
  const heads = list ? [...list.querySelectorAll('.list-editor-head')] : [];
  const from = heads.at(-1);
  const over = heads[0]?.parentElement;
  if (!from || !over || from.getAttribute('draggable') !== 'true') return false;
  const dt = new DataTransfer();
  from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  window.__listDrag = { dt, over };
  return true;
});
if (dragged) {
  await pause(150);
  await win.evaluate(() => {
    const { dt, over } = window.__listDrag;
    const r = over.getBoundingClientRect();
    over.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 40, clientY: r.top + 4 }));
  });
  await pause(250);
  await shot('testimonials-dragging', said, async () => (await said.locator('.list-editor-drop').count()) === 1 && (await said.locator('[data-dragging]').count()) === 1, { keep: true, themes: BOTH });
  await win.evaluate(() => {
    const { dt } = window.__listDrag;
    document.querySelector('#dock-panel-inspect [data-list="items"] [data-dragging] .list-editor-head')?.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  });
  await pause(300);
  // A real pointer drag, released on the centre of the line above the first row: the row lands there.
  const before = (await heads(said).allInnerTexts()).map((t) => t.trim());
  const from = await rows(said).last().locator('.list-editor-head').boundingBox();
  const to = await rows(said).first().boundingBox();
  await win.mouse.move(from.x + 60, from.y + 12);
  await win.mouse.down();
  for (let k = 1; k <= 12; k++) await win.mouse.move(from.x + 60, from.y + 12 + ((to.y - 2 - (from.y + 12)) * k) / 12);
  await pause(150);
  await win.mouse.up();
  await until(async () => (await heads(said).first().innerText()).trim() === before.at(-1), 'the dragged row to land on the line');
  await win.evaluate(() => window.builder.project.undo());
  await until(async () => (await heads(said).first().innerText()).trim() === before[0], 'the drag undone');
  await win.mouse.move(2, 990);
  await pause(300);
} else console.log('skipped testimonials-dragging: the rows do not drag');

// A row removed: the notice that names it, with Undo beside it. Then Undo puts it back.
await rows(said).nth(2).getByRole('button', { name: /^Remove/ }).click();
const notice = win.locator('.toast', { hasText: /^Removed / }).first();
await notice.waitFor({ timeout: 15000 });
await win.mouse.move(2, 990);
await pause(400);
{
  const box = await notice.boundingBox();
  const dock = await win.locator('.dock').boundingBox();
  if (!box || !dock) throw new Error('state "removed-notice" has no box; refusing to write');
  if (!/Undo/.test(await notice.innerText())) throw new Error('state "removed-notice" has no Undo; refusing to write');
  const x = Math.min(box.x - 24, dock.x);
  const path = join(OUT, 'list-removed-notice--light.png');
  await win.screenshot({ path, clip: { x, y: Math.min(box.y - 24, dock.y + 60), width: dock.x + dock.width - x, height: Math.max(box.y + box.height + 24, dock.y + 360) - Math.min(box.y - 24, dock.y + 60) } });
  written.push(path);
  console.log('wrote', path);
}
await notice.getByRole('button', { name: 'Undo' }).click();
await until(async () => (await rows(said).count()) === 4, 'the testimonial back');
await pause(400);

// ---- 9. The gallery: rows named by their pictures ----
await select('Gallery');
const pics = insp.locator('[data-list]').filter({ has: win.locator('.list-editor-item') }).first();
await pics.waitFor({ timeout: 20000 });
await shot('gallery', pics, async () => (await pics.locator('.list-editor-thumb img').count()) > 0, { themes: BOTH });

// ---- 10. The services cards at their limit ----
const cards = await homeNode('features.grid');
const cs = cards.node.props.items ?? [];
const max = (await snapshot()).components[cards.node.definitionId]?.properties?.items?.max;
if (max && max <= 12) {
  await setProp(cards, 'items', Array.from({ length: max }, (_, i) => ({ ...cs[i % cs.length], title: `${cs[i % cs.length].title} ${i + 1}` })));
  await select('Services');
  const full = list('items');
  await shot('cards-full', full, async () => (await rows(full).count()) === max && (await full.locator('.insp-add[aria-disabled="true"]').count()) === 1);
} else console.log('skipped cards-full: the cards have no small maximum');

// ---- 11. A Page list: cards that stand for pages, added from a page picker ----
const home = await homeNode('features.grid');
await apply([{ type: 'node.insert', owner: home.owner, parentId: null, index: 1, componentId: 'content.pages' }], 'Insert page list');
await pause(800);
const s2 = await snapshot();
const others = s2.site.pageOrder.filter((p) => p !== s2.site.homePageId);
const pl = await homeNode('content.pages');
await select('Page list');
const plist = list('items');
await plist.waitFor({ timeout: 20000 });
// Empty, choosing among the pages: the chooser open.
const addPage = plist.locator('.insp-page-btn').first();
await addPage.waitFor({ timeout: 10000 });
await addPage.click();
await pause(500);
await shot('page-list-picking', plist, async () => await win.locator('.insp-page-pick').first().isVisible(), { pad: 200 });
await win.keyboard.press('Escape');
await pause(300);
// One card, and one page left to add: the button names it.
await setProp(pl, 'items', [{ pageLink: { type: 'page', target: others[0] }, title: '', description: '', image: { assetId: null, alt: '' }, group: '' }]);
await shot('page-list', plist, async () => (await rows(plist).count()) === 1 && (await plist.locator('.insp-add').count()) === 1, { themes: BOTH });
// Every page listed: nothing left to add.
await setProp(pl, 'items', others.map((p) => ({ pageLink: { type: 'page', target: p }, title: '', description: '', image: { assetId: null, alt: '' }, group: '' })));
await pause(400);
await shot('page-list-all', plist, async () => (await rows(plist).count()) === others.length && /Every other page/.test(await plist.innerText()));

await app.close();
rmSync(WORK, { recursive: true, force: true });
const pngs = readdirSync(OUT).filter((f) => f.startsWith('list-') && f.endsWith('.png')).length;
console.log(`list editor capture: ${written.length} written, ${pngs} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (pngs < written.length) throw new Error('fewer PNGs on disk than captures written');
