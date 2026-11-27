// Design capture harness for the image field card in the Inspector (ImageEditor) and the site's own pictures
// (SiteImageField: the favicon, the social sharing image and the logo in Site styles › Site details). Drives the real
// built app through the card's states and writes one PNG per state and theme, cropped to the dock around the card.
// Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/image-field.mjs
//
// The fixtures go through the app's own import seam (project.importAssets with file paths): long names and a wide
// transparent logo. A second, blank project shows the browser with no images and with only a few. Each capture is
// verified after it settles; a state that did not render throws instead of writing a plausible-looking wrong image.
// Files are named `img-{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('image field capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set to a directory outside the repo');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-imgfield-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const STARTER = resolve('resources/starter-assets');

// ---- Fixtures: distinct bytes per file (imports dedupe by hash) ----
const FIX = join(WORK, 'fixtures');
mkdirSync(FIX, { recursive: true });
const fixtures = [];
[
  ['hero', 'harbour-lane-living-room-oak-floor-afternoon-light-final-v3'],
  ['kitchen', 'kitchen-renovation-before-after-stone-benchtop'],
  ['studio', 'studio-wide'],
  ['bedroom', 'bedroom-linen'],
  ['reading', 'reading-nook']
].forEach(([p, name], i) => {
  const dest = join(FIX, `${name}.jpg`);
  execFileSync('sips', ['-Z', String(880 + i * 7), join(STARTER, `${p}.jpg`), '--out', dest], { stdio: 'ignore' });
  fixtures.push(dest);
});
const logo = join(FIX, 'harbour-lane-mark.svg');
writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><circle cx="128" cy="128" r="96" fill="#1b5e7a"/><path d="M70 150 q58 -70 116 0" stroke="#fff" stroke-width="14" fill="none"/></svg>');
fixtures.push(logo);

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

async function until(check, what, ms = 45000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(150);
  }
}
const waitThumbs = () =>
  win
    .waitForFunction(() => [...document.querySelectorAll('.dock .insp-image img')].filter((i) => i.getBoundingClientRect().height > 0).every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 20000 })
    .catch(() => {});

/** Capture the dock's width around `target` (with `pad` above and below), in the given themes; `verify` must hold. */
async function shot(state, target, verify, { themes = LIGHT, pad = 44, keep = false, whole = false } = {}) {
  if (!keep) await target.first().scrollIntoViewIfNeeded();
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(240);
    await waitThumbs();
    if (!(await verify().catch(() => false))) {
      await win.screenshot({ path: join(OUT, `debug-${state}--${theme}.png`) }).catch(() => {});
      throw new Error(`state "${state}" (${theme}) did not render; refusing to write (see debug-${state}--${theme}.png)`);
    }
    const dock = await win.locator('.dock').boundingBox();
    const box = await target.first().boundingBox();
    if (!dock || !box) throw new Error(`state "${state}" (${theme}) has no box; refusing to write`);
    const top = whole ? dock.y : Math.max(dock.y, box.y - pad);
    const bottom = whole ? dock.y + dock.height : Math.min(dock.y + dock.height, box.y + box.height + pad);
    const path = join(OUT, `img-${state}--${theme}.png`);
    await win.screenshot({ path, clip: { x: dock.x, y: top, width: dock.width, height: bottom - top } });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
  await pause(100);
}

async function setProp(componentId, prop, value) {
  await win.evaluate(
    async ({ componentId, prop, value }) => {
      const s = await window.builder.project.snapshot();
      const page = s.state.pages[s.state.site.homePageId];
      const node = Object.values(page.nodes).find((n) => n.kind === 'instance' && s.state.components[n.definitionId]?.componentId === componentId);
      if (!node) throw new Error(`no ${componentId} on the home page`);
      const r = await window.builder.project.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: page.id }, nodeId: node.id, prop, value }] }, { label: 'Seed field' });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
    },
    { componentId, prop, value }
  );
  await pause(400);
}
const siteUpdate = async (patch) => {
  await win.evaluate(async (patch) => {
    const r = await window.builder.project.apply({ operations: [{ type: 'site.update', ...patch }] }, { label: 'Seed site' });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  }, patch);
  await pause(400);
};
const openRail = async (name) => {
  const b = win.locator(`.rail [aria-label="${name}"]`);
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
  await pause(250);
};
async function select(name) {
  await openRail('Layers');
  await win.locator('.list-item', { hasText: name }).first().click();
  await insp.locator('.insp-name h3', { hasText: name }).waitFor({ timeout: 30000 });
  await pause(350);
}
async function dockWidth(key) {
  await win.getByRole('separator', { name: 'Resize right panel' }).focus();
  await win.keyboard.press(key);
  await pause(500);
  await win.evaluate(() => document.activeElement?.blur());
}
/** A file dragged over the card, as the OS sends it: a drag carrying Files. */
const dragOver = (card) =>
  card.evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'new-photo.jpg', { type: 'image/jpeg' }));
    const r = el.getBoundingClientRect();
    for (const type of ['dragenter', 'dragover']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: r.top + 20 }));
  });
const dragLeave = (card) => card.evaluate((el) => el.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, relatedTarget: document.body })));

// ---- Project A: the Business starter, plus the fixtures through the real import seam ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
await win.waitForSelector('.editor', { timeout: 120000 });
await frame.locator('h1').first().waitFor({ timeout: 180000 });
await pause(1500);
const r = await win.evaluate((paths) => window.builder.project.importAssets(paths), fixtures);
if (!r.ok && !r.assetIds.length) throw new Error(`fixture import failed: ${r.message}`);
await pause(1000);
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
await win.evaluate(() => {
  for (const k of Object.keys(localStorage)) if (k.startsWith('section:')) localStorage.removeItem(k);
  localStorage.setItem('section:content', '1');
});
// A photo with no suggested description, so choosing it keeps the previous one and flags it for checking.
const photoName = await win.evaluate(async () => {
  const r = await window.builder.project.apply({ operations: [{ type: 'asset.update', assetId: 'a_dining', altSuggestion: '' }] }, { label: 'Seed photo' });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (await window.builder.project.snapshot()).state.assets.assets.a_dining.name;
});

await select('Split hero');
const HERO = 'hero.split';
const card = insp.locator('.insp-image').first();
await card.waitFor({ timeout: 15000 });
const heroImage = await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  const page = s.state.pages[s.state.site.homePageId];
  return Object.values(page.nodes).find((n) => n.kind === 'instance' && s.state.components[n.definitionId]?.componentId === 'hero.split').props.image;
});
const name = () => card.locator('.insp-image-name').innerText();
const pop = win.locator('.insp-image-pop');
const browserOpen = () => pop.first().isVisible();
const changeBtn = card.getByRole('button', { name: /^(Change|Choose)/ }).first();

// 1. Populated, at rest.
await shot('populated', card, async () => (await name()).length > 0 && (await card.getByRole('button', { name: /Change/ }).count()) === 1, { themes: BOTH });
// 2. Remove, pointed at.
const removeBtn = card.getByRole('button', { name: /^Remove/ }).first();
await removeBtn.hover();
await pause(250);
await shot('remove-hover', card, async () => await removeBtn.isVisible(), { keep: true });
await win.mouse.move(2, 500);
// 3. The browser open, with the Inspector around it: what moves and where focus landed.
await win.keyboard.press('Shift');
await changeBtn.focus();
await win.keyboard.press('Enter');
await until(browserOpen, 'the browser');
await pause(700);
await shot('browse', card, browserOpen, { themes: BOTH, whole: true, keep: true });
await shot('browse-context', card, browserOpen, { whole: true, keep: true });
// 4. Keyboard on a tile.
const grid = win.locator('.insp-pick-grid').first();
await grid.locator('[role="option"][tabindex="0"]').focus();
await win.keyboard.press('ArrowRight');
await pause(200);
await shot('browse-focus', pop, async () => await win.locator('.insp-pick-tile:focus-visible').first().isVisible(), { keep: true });
// 5. A search that finds nothing.
const search = win.getByRole('searchbox', { name: 'Search images' }).first();
await search.fill('zebra crossing');
await pause(300);
await shot('browse-no-match', pop, async () => (await pop.innerText()).includes('match'), { keep: true, pad: 120 });
await search.fill('');
await pause(200);
// 6. Choosing a picture with no suggested description keeps the old one, flagged.
await win.locator('.insp-pick-tile', { hasText: photoName }).first().click();
await until(async () => (await name()).includes(photoName), 'the new image');
await pause(400);
await shot('carried', card, async () => await card.locator('.insp-check').isVisible(), { themes: BOTH });
// 7. Decorative.
await setProp(HERO, 'image', { ...heroImage, decorative: true });
await until(async () => (await card.getByRole('switch', { name: 'Decorative image' }).getAttribute('aria-checked')) === 'true', 'decorative');
await shot('decorative', card, async () => (await card.locator('textarea').count()) === 0);
// A chosen picture with no description yet.
await setProp(HERO, 'image', { ...heroImage, alt: '', decorative: false });
await until(async () => (await card.locator('textarea').inputValue()) === '', 'the empty description');
await shot('no-description', card, async () => /Or mark it decorative/.test(await card.innerText()));
// 8. No image.
await setProp(HERO, 'image', { assetId: null, alt: '' });
await until(async () => (await name()).includes('No image'), 'no image');
await shot('empty', card, async () => (await card.getByRole('button', { name: /Choose image/ }).count()) === 1, { themes: BOTH });
// 9. A picture the field still names that Assets no longer has.
// The field is given a picture, then the picture is removed from Assets while the field still names it.
const doomed = await win.evaluate(async () => Object.values((await window.builder.project.snapshot()).state.assets.assets).find((a) => a.kind === 'image' && /studio wide/i.test(a.name))?.id);
if (!doomed) throw new Error('no fixture to remove from Assets');
await setProp(HERO, 'image', { assetId: doomed, alt: 'The studio, from the door' });
// First its files go from the project folder (the record stays): what a person sees after a sync or a manual delete.
const snapM = await win.evaluate(() => window.builder.project.snapshot());
const doomedAsset = snapM.state.assets.assets[doomed];
for (const f of [doomedAsset.file, ...(doomedAsset.variants ?? []).map((v) => v.file)]) rmSync(join(snapM.dir, f), { force: true });
await until(() => win.evaluate(async (id) => (await window.builder.project.snapshot()).missingAssets.some((m) => m.assetId === id), doomed), 'the files to be found missing', 30000);
await pause(800);
await shot('file-missing', card, async () => await card.locator('.insp-pick-gone').isVisible(), { themes: BOTH });
// Only the smaller copies of another picture gone: it still shows, and says a copy is missing.
const thinned = await win.evaluate(async () => Object.values((await window.builder.project.snapshot()).state.assets.assets).find((a) => a.kind === 'image' && /bedroom linen/i.test(a.name) && a.variants?.length)?.id);
if (thinned) {
  const snapT = await win.evaluate(() => window.builder.project.snapshot());
  await setProp(HERO, 'image', { assetId: thinned, alt: 'Linen on an oak bed' });
  for (const f of snapT.state.assets.assets[thinned].variants.map((x) => x.file)) rmSync(join(snapT.dir, f), { force: true });
  await until(() => win.evaluate(async (id) => (await window.builder.project.snapshot()).missingAssets.some((m) => m.assetId === id && !m.original), thinned), 'the copies to be found missing', 30000);
  await pause(800);
  await shot('copy-missing', card, async () => /Copy missing/.test(await card.innerText()));
  await setProp(HERO, 'image', { assetId: doomed, alt: 'The studio, from the door' });
} else console.log('skipped copy-missing: no fixture with smaller copies');
// The same picture in the library: flagged, and only the chosen one can stay chosen.
await changeBtn.click();
await until(browserOpen, 'the browser');
await win.getByRole('searchbox', { name: 'Search images' }).first().fill('studio');
await pause(500);
await shot('browse-missing', pop, async () => await pop.locator('.insp-pick-gone').first().isVisible(), { keep: true, pad: 120 });
await win.keyboard.press('Escape');
await pause(300);
// (A field naming a picture Assets has no more is refused by the engine, so it is not reachable from here.)
// 10. A file dragged over the card, filled and empty.
await setProp(HERO, 'image', heroImage);
await until(async () => (await card.getByRole('button', { name: /Change/ }).count()) === 1, 'the hero image back');
await dragOver(card);
await pause(300);
await shot('drop-over', card, async () => (await card.getAttribute('class')).includes('drop'), { keep: true, themes: BOTH });
await dragLeave(card);
await pause(200);
// 11. The narrowest right panel, at rest and browsing.
await dockWidth('Home');
await shot('narrow', card, async () => (await name()).length > 0);
await changeBtn.click();
await until(browserOpen, 'the browser');
await pause(600);
await shot('narrow-browse', card, browserOpen, { whole: true, keep: true });
await win.keyboard.press('Escape');
await pause(300);
await win.locator('.resizer[aria-label="Resize right panel"]').dblclick().catch(() => {});
await pause(500);

// The card low in the panel: the library opens above it, and keeps its place while a search narrows it.
await card.evaluate((el) => el.scrollIntoView({ block: 'end' }));
await pause(400);
await changeBtn.click();
await until(browserOpen, 'the browser above');
await pause(500);
const before = await win.getByRole('searchbox', { name: 'Search images' }).first().boundingBox();
await win.getByRole('searchbox', { name: 'Search images' }).first().fill('portrait');
await pause(500);
const after = await win.getByRole('searchbox', { name: 'Search images' }).first().boundingBox();
if (!before || !after || Math.abs(before.y - after.y) > 1) throw new Error(`the search box moved while searching (${before?.y} → ${after?.y})`);
await shot('browse-above', card, async () => (await pop.boundingBox()).y < (await card.boundingBox()).y + 60, { whole: true, keep: true });
await win.keyboard.press('Escape');
await pause(300);
// 12. In a list item: a team card's photo (already a framed panel).
// (Skipped when the starter has no list with images.)

// ---- Site styles › Site details: the favicon, the social sharing image and the logo ----
const markId = await win.evaluate(async () => Object.values((await window.builder.project.snapshot()).state.assets.assets).find((a) => a.kind === 'image' && /mark/i.test(a.name))?.id);
const wideId = await win.evaluate(async () => Object.values((await window.builder.project.snapshot()).state.assets.assets).find((a) => a.kind === 'image' && /living room oak/i.test(a.name))?.id);
await siteUpdate({ favicon: markId ?? null, socialImage: null });
await win.locator('.dock-tab', { hasText: 'Site styles' }).click();
await pause(600);
const details = win.locator('.dock .section-head', { hasText: /^Site details/ }).first();
if ((await details.getAttribute('aria-expanded')) !== 'true') await details.click();
await pause(500);
const fav = win.locator('#site-favicon .insp-image');
const social = win.locator('#site-social-image .insp-image');
await fav.waitFor({ timeout: 15000 });
// The favicon chosen and the sharing image not, as they sit together with their hints.
const pair = win.locator('.dock .field', { has: fav });
await fav.scrollIntoViewIfNeeded();
await shot('site-favicon-social', fav, async () => (await social.isVisible()) && (await fav.locator('img').count()) === 1, { themes: BOTH, pad: 230 });
await siteUpdate({ socialImage: wideId ?? null });
await until(async () => (await social.locator('img').count()) === 1, 'the social image');
await social.scrollIntoViewIfNeeded();
await shot('site-social', social, async () => (await social.locator('img').count()) === 1, { pad: 70 });
const logoCard = win.locator('#site-identity-logo .insp-image');
if (await logoCard.count()) {
  await logoCard.scrollIntoViewIfNeeded();
  await shot('site-logo', logoCard, async () => await logoCard.isVisible(), { pad: 60 });
}
void pair;
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');

// ---- Project B: a blank site, its library empty and then holding only a few pictures ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Kōwhai Garden', parentDir: dir, starter: 'blank', sampleImages: false }), join(WORK, 'sites'));
await win.waitForSelector('.editor', { timeout: 120000 });
await frame.locator('body *').first().waitFor({ timeout: 180000 });
await pause(1500);
await win.locator('.dock-tab', { hasText: 'Site styles' }).click();
await pause(600);
const detailsB = win.locator('.dock .section-head', { hasText: /^Site details/ }).first();
if ((await detailsB.getAttribute('aria-expanded')) !== 'true') await detailsB.click();
await pause(500);
const favB = win.locator('#site-favicon .insp-image');
await favB.waitFor({ timeout: 15000 });
await favB.getByRole('button', { name: /Choose/ }).click();
await until(() => pop.isVisible(), 'the empty browser');
await pause(400);
await shot('library-empty', favB, () => pop.isVisible(), { pad: 160, keep: true });
await win.keyboard.press('Escape');
await pause(300);
const few = await win.evaluate((paths) => window.builder.project.importAssets(paths), fixtures.slice(0, 3));
if (!few.assetIds?.length) throw new Error('the few fixtures did not import');
await pause(1200);
await win.keyboard.press('Shift');
await favB.getByRole('button', { name: /Choose/ }).focus();
await win.keyboard.press('Enter');
await until(() => pop.locator('.insp-pick-grid').isVisible(), 'the few browser');
await pause(700);
await shot('library-few', favB, () => pop.locator('.insp-pick-grid').isVisible(), { keep: true, pad: 230 });

await app.close();
rmSync(WORK, { recursive: true, force: true });
const pngs = readdirSync(OUT).filter((f) => f.startsWith('img-') && f.endsWith('.png')).length;
console.log(`image field capture: ${written.length} written, ${pngs} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (pngs < written.length) throw new Error('fewer PNGs on disk than captures written');
