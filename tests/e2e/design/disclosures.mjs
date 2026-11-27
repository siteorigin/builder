// Design capture for every fold (disclosure) in the app, closed and open, so their markers, hover, focus and type can
// be compared side by side. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/disclosures.mjs
//
// Drives the real (built) app through each surface a fold sits on, by the same routes and fixtures the surface's own
// capture harness uses, and writes `{fold}-closed--{theme}.png` and `{fold}-open--{theme}.png`, clipped to the fold
// with a margin of what it sits in; for the folds people meet most, also `{fold}-hover--light.png` (pointer over the
// toggle) and `{fold}-focus--light.png` (the toggle focused from the keyboard). The editor's "Technical details" fold
// (FailureScreen) is rendered from the real component and stylesheet in Chromium, as failure-recovery.mjs does, since
// the app only shows it when the editor itself breaks. Folds are found by their own class names, never by styling.
//
// Each capture checks its state on screen (open or closed, hovered, focus-visible) after it settles, and throws rather
// than write a wrong image. A fold whose surface can't be reached is logged as `SKIP {fold}: {reason}` and the run goes
// on; the run fails only on a harness error.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { MOD, answerChoosers, createProject, launch, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('disclosures capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT || !isAbsolute(OUT)) throw new Error('DESIGN_CAPTURE_DIR must be an absolute path outside the repository');
mkdirSync(OUT, { recursive: true });
const DEBUG = join(OUT, '_debug');
const BOTH = ['light', 'dark'];
const VIEWPORT = { width: 1440, height: 1000 };
const MARGIN = 12;
const CONTEXT = 40;
const MAX = { width: 700, height: 400 };
const started = Date.now();

const { WORK, cleanup } = scratch('design-disclosures');
// A theme pack that can't be read, installed before launch: Welcome and Site styles then say it was refused.
mkdirSync(join(WORK, 'userdata', 'packs', 'harbour-classic'), { recursive: true });
writeFileSync(join(WORK, 'userdata', 'packs', 'harbour-classic', 'pack.json'), '{ "id": "harbour-classic", ');

const written = [];
const skips = [];

// ---------------------------------------------------------------------------
// Capturing a fold
// ---------------------------------------------------------------------------

/** The fold's box with a margin around it, widened to the surface it sits in when that fits, within MAX. */
async function clipFor(page, fold, context, anchor) {
  const f = await fold.boundingBox();
  if (!f) throw new Error('the fold has no box');
  const vp = page.viewportSize();
  let x0 = f.x - MARGIN;
  let x1 = f.x + f.width + MARGIN;
  const c = context && (await context.count()) ? await context.boundingBox() : null;
  if (c) {
    const cx0 = Math.min(x0, c.x - MARGIN);
    const cx1 = Math.max(x1, c.x + c.width + MARGIN);
    if (cx1 - cx0 <= MAX.width) [x0, x1] = [cx0, cx1];
  }
  if (x1 - x0 > MAX.width) x1 = x0 + MAX.width;
  let y0 = f.y - MARGIN;
  let y1 = f.y + f.height + MARGIN;
  // A little of what sits above and below it on the same surface, so the fold is seen in place.
  if (c) {
    y0 = Math.min(y0, Math.max(c.y - MARGIN, f.y - CONTEXT));
    y1 = Math.max(y1, Math.min(c.y + c.height + MARGIN, f.y + f.height + CONTEXT));
  }
  if (y1 - y0 > MAX.height) {
    if (anchor === 'bottom') y0 = y1 - MAX.height;
    else y1 = y0 + MAX.height;
  }
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(vp.width, Math.ceil(x1));
  y1 = Math.min(vp.height, Math.ceil(y1));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Capture one fold closed and open in each theme, and (with `extra`) hovered and keyboard-focused in light.
 * `fold` is the fold's own element; `toggle` what opens it (a details' summary by default); `isOpen` reads its state
 * from the DOM (details.open by default); `content` must be visible while it is open; `context` the surface it sits
 * in, for the clip. `setTheme` and `rest` are the page's own (an app window, or the Chromium page).
 */
async function captureFold(page, name, opts) {
  const { fold, context = null, extra = false, anchor = 'top', setTheme, rest } = opts;
  const toggle = opts.toggle ?? fold.locator(':scope > summary').first();
  const isOpen = opts.isOpen ?? (() => fold.evaluate((el) => el.open === true));
  const content = opts.content ?? fold.locator(':scope > :not(summary)').first();
  const pause = (ms) => page.waitForTimeout(ms);
  const settle = async (want) => {
    for (let i = 0; i < 40 && (await isOpen()) !== want; i++) await pause(100);
    if ((await isOpen()) !== want) throw new Error(`${name} did not ${want ? 'open' : 'close'}`);
  };
  const write = async (file, check) => {
    await fold.scrollIntoViewIfNeeded();
    await pause(150);
    if (!(await fold.isVisible())) throw new Error(`${file}: the fold is not on screen; refusing to write`);
    if (!(await toggle.isVisible())) throw new Error(`${file}: its toggle is not on screen; refusing to write`);
    const why = await check();
    if (why) throw new Error(`${file}: ${why}; refusing to write`);
    const path = join(OUT, `${file}.png`);
    await page.screenshot({ path, clip: await clipFor(page, fold, context, anchor) });
    written.push(path);
    console.log('wrote', path);
  };
  const closedCheck = async () => ((await isOpen()) ? 'it is open' : null);
  const openCheck = async () => ((await isOpen()) ? ((await content.isVisible().catch(() => false)) ? null : 'its content is not visible') : 'it is closed');

  await fold.waitFor({ state: 'visible', timeout: 20000 });
  await fold.scrollIntoViewIfNeeded();
  if (await isOpen()) {
    await toggle.click();
    await settle(false);
  }
  for (const theme of BOTH) {
    await setTheme(theme);
    await rest();
    await write(`${name}-closed--${theme}`, closedCheck);
  }
  if (extra) {
    await setTheme('light');
    await rest();
    await toggle.hover();
    await pause(250);
    await write(`${name}-hover--light`, async () => (await closedCheck()) ?? ((await toggle.evaluate((el) => el.matches(':hover'))) ? null : 'the toggle is not hovered'));
    await rest();
    // A key press first, so the focus that follows is a keyboard user's and :focus-visible applies.
    await page.keyboard.press('Shift');
    await toggle.focus();
    await pause(250);
    await write(`${name}-focus--light`, async () => (await closedCheck()) ?? ((await toggle.evaluate((el) => el.matches(':focus-visible'))) ? null : 'the toggle is not focus-visible'));
  }
  await rest();
  await toggle.click();
  await settle(true);
  for (const theme of BOTH) {
    await setTheme(theme);
    await rest();
    await write(`${name}-open--${theme}`, openCheck);
  }
  await setTheme('light');
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

const { app, win, errors } = await launch(WORK, {}, { viewport: VIEWPORT });
win.setDefaultTimeout(30000);
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system', developerMode: false }));
await win.emulateMedia({ reducedMotion: 'reduce' });
const pause = (ms) => win.waitForTimeout(ms);
const setTheme = async (theme) => {
  await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await pause(250);
};
/** Pointer off to the side, nothing focused. */
const rest = async () => {
  await win.mouse.move(4, VIEWPORT.height - 4);
  await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await pause(200);
};
const fold = (name, opts) => captureFold(win, name, { setTheme, rest, ...opts });

/** Run one surface's captures; a surface that can't be reached is skipped with its reason, and the run goes on. */
async function attempt(names, fn) {
  try {
    await fn();
  } catch (e) {
    const reason = String(e?.message ?? e).split('\n')[0];
    for (const n of [].concat(names)) skips.push(`${n}: ${reason}`);
    for (const n of [].concat(names)) console.log(`SKIP ${n}: ${reason}`);
    mkdirSync(DEBUG, { recursive: true });
    await win.screenshot({ path: join(DEBUG, `${[].concat(names)[0]}.png`) }).catch(() => {});
    for (let i = 0; i < 3; i++) await win.keyboard.press('Escape').catch(() => {});
    await pause(300);
  }
}

const modal = () => win.locator('.modal').last();
const closeModal = async () => {
  await win.keyboard.press('Escape');
  await win.locator('.modal').first().waitFor({ state: 'detached', timeout: 10000 });
  await pause(200);
};
const openRail = async (name) => {
  const b = win.locator(`.rail [aria-label="${name}"]`);
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
  await pause(400);
};
const inspector = win.locator('#dock-panel-inspect');
const openInspector = async () => {
  const tab = win.locator('#dock-tab-inspect');
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await inspector.waitFor();
};
const apply = async (operations, label) => {
  const r = await win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);
  if (!r?.ok) throw new Error(`${label}: ${JSON.stringify(r?.error ?? r)}`);
  await pause(400);
  return r.results;
};
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const clearSelection = async () => {
  await win.locator('.canvas').click({ position: { x: 4, y: 4 } }).catch(() => {});
  for (let i = 0; i < 3; i++) await win.keyboard.press('Escape');
  await pause(300);
};

// ---- 13. Welcome: the refused theme pack ----
await attempt('welcome-packs', async () => {
  await win.locator('.welcome-packs').waitFor({ timeout: 20000 });
  await fold('welcome-packs', { fold: win.locator('.welcome-packs').first(), context: win.locator('.welcome-packs').first() });
});

// ---- 5. Settings → AI assistant → Local model: Advanced server options ----
await attempt('settings-advanced', async () => {
  await win.locator('.welcome button', { hasText: 'Settings' }).click();
  await modal().waitFor();
  await win.getByRole('tab', { name: 'AI assistant' }).click();
  await pause(300);
  await modal().locator('button, [role="radio"], [role="tab"]').filter({ hasText: /^\s*Local model\s*$/ }).first().click();
  await win.locator('#settings-local-url').waitFor();
  await win.locator('.settings-status:not(:has-text("Checking"))').first().waitFor({ timeout: 20000 }).catch(() => {});
  await fold('settings-advanced', { fold: win.locator('.settings-advanced').first(), context: modal().locator('.settings-panel:not([hidden])').first() });
  // Back to the hosted provider, so the editor's assistant asks nothing of a local server.
  await modal().locator('button, [role="radio"], [role="tab"]').filter({ hasText: /^\s*OpenAI\s*$/ }).first().click().catch(() => {});
  await pause(300);
  await closeModal();
});
if (await win.locator('.modal').count()) await closeModal().catch(() => {});

// ---- A business site with sample images ----
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
await pause(1500);
await openInspector();
await win.evaluate(() => {
  for (const k of Object.keys(localStorage)) if (k.startsWith('section:')) localStorage.removeItem(k);
});

async function selectLayer(name) {
  await openRail('Layers');
  await win.locator('.list-item', { hasText: name }).first().click();
  await openInspector();
  await inspector.locator('.insp-name h3', { hasText: name }).first().waitFor({ timeout: 30000 });
  await pause(500);
}

// ---- 8. Tag field: the tags that can't go here, on a heading added from Insert ----
await attempt('tag-why', async () => {
  await clearSelection();
  await openRail('Insert');
  await win.locator('.insert-tile.basic', { hasText: 'Heading' }).first().click();
  await pause(1200);
  await openInspector();
  const why = inspector.locator('.tag-why').first();
  await fold('tag-why', { fold: why, context: why.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " section-body ")][1]') });
});

// ---- 18. A Section header in the Inspector, for reference ----
await attempt('section-head', async () => {
  await openInspector();
  const head = inspector.locator('.section-head[aria-expanded]').first();
  const section = head.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " section ")][1]');
  await fold('section-head', { fold: section, toggle: head, isOpen: async () => (await head.getAttribute('aria-expanded')) === 'true', content: section.locator('.section-body').first(), context: inspector });
});

// ---- 12. Link: the folded search engine settings, on the hero's primary button ----
await attempt('insp-link-more', async () => {
  await clearSelection();
  const s = await snapshot();
  const page = s.state.pages[s.state.site.homePageId];
  const node = Object.values(page.nodes).find((n) => n.kind === 'instance' && s.state.components[n.definitionId]?.componentId === 'hero.split');
  if (!node) throw new Error('no Split hero on the home page');
  await apply([{ type: 'instance.setProp', owner: { kind: 'page', id: page.id }, nodeId: node.id, prop: 'primaryLink', value: { type: 'url', target: 'https://www.harbourlanestudio.example/projects/renovation-guide', newTab: true, rel: ['sponsored'] } }], 'Seed link');
  await selectLayer('Split hero');
  const more = inspector.locator('.insp-link-more').first();
  await fold('insp-link-more', { fold: more, context: more.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " insp-link ")][1]') });
});

// ---- 17. A list field's row in the Inspector ----
await attempt('list-editor', async () => {
  await clearSelection();
  let found = false;
  for (const name of ['Services grid', 'Testimonials', 'Feature', 'FAQ', 'Team']) {
    const row = win.locator('.list-item', { hasText: name }).first();
    await openRail('Layers');
    if (!(await row.count())) continue;
    await row.click();
    await openInspector();
    await pause(700);
    if (await inspector.locator('.list-editor-head > button.title').count()) {
      found = true;
      break;
    }
  }
  if (!found) throw new Error('no section on the home page has a list field');
  const head = inspector.locator('.list-editor-head > button.title').first();
  const item = head.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " list-editor-item ")][1]');
  const id = (await head.getAttribute('aria-controls')) ?? '';
  await fold('list-editor', {
    fold: item,
    toggle: head,
    extra: true,
    isOpen: async () => (await head.getAttribute('aria-expanded')) === 'true',
    content: inspector.locator(`[id="${id}"]`),
    context: item.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " list-editor ")][1]')
  });
  if ((await head.getAttribute('aria-expanded')) === 'true') await head.click();
});

// ---- 15. Assets: an image used in more than four places ----
await attempt('uses-toggle', async () => {
  await clearSelection();
  let s = await snapshot();
  const homeId = s.state.site.homePageId;
  // A section with an image field, placed five more times on Home with one image: more places than the list shows.
  const imageId = Object.values(s.state.assets.assets).find((a) => a.kind === 'image')?.id;
  if (!imageId) throw new Error('the site has no images');
  let placed = null;
  for (const def of Object.values(s.state.components)) {
    const prop = Object.entries(def.properties ?? {}).find(([, p]) => p.type === 'image')?.[0];
    if (prop && def.owner === 'theme') {
      placed = { def: def.id, prop };
      break;
    }
  }
  if (!placed) throw new Error('no component has an image field');
  for (let i = 0; i < 5; i++) await apply([{ type: 'node.insert', owner: { kind: 'page', id: homeId }, parentId: null, definitionId: placed.def, props: { [placed.prop]: { assetId: imageId, alt: 'The studio' } } }], 'Place the image');
  s = await snapshot();
  const name = s.state.assets.assets[imageId].name;
  await openRail('Assets');
  await win.locator('[data-asset]').first().waitFor({ timeout: 20000 });
  await win.locator(`[data-asset="${imageId}"]`).first().click().catch(async () => win.locator('[data-asset]', { hasText: name }).first().click());
  await win.locator('.asset-detail').waitFor({ timeout: 10000 });
  await pause(600);
  // The places past the first four, under their own fold (.asset-more).
  const more = win.locator('.asset-detail .asset-more').first();
  const toggle = more.locator(':scope > summary');
  await toggle.waitFor({ timeout: 10000 });
  const uses = win.locator('.asset-detail .asset-uses').first();
  await fold('uses-toggle', {
    fold: uses,
    toggle,
    extra: true,
    anchor: 'bottom',
    isOpen: () => more.evaluate((el) => el.open === true),
    content: more.locator('li').first(),
    context: win.locator('.asset-detail').first()
  });
  await toggle.click();
  await win.locator('.asset-back').first().click();
  await pause(300);
});

// ---- 16. Assets: a document's row in the Documents list ----
await attempt('doc-toggle', async () => {
  const pdf = join(WORK, 'harbour-lane-price-list-2026.pdf');
  writeFileSync(pdf, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
  const r = await win.evaluate((p) => window.builder.project.importAssets(p), [pdf]);
  if (!r?.assetIds?.length) throw new Error(`the document did not import: ${r?.message}`);
  await openRail('Assets');
  await pause(500);
  await win.locator('aside.side-panel').getByRole('tab', { name: /^Documents/ }).click();
  const item = win.locator('.doc-item').first();
  await item.waitFor({ timeout: 20000 });
  const toggle = item.locator('.doc-toggle').first();
  await fold('doc-toggle', {
    fold: item,
    toggle,
    isOpen: async () => (await toggle.getAttribute('aria-expanded')) === 'true',
    content: item.locator(':scope > :not(.doc-toggle)').first(),
    context: win.locator('.side-panel-view:not([hidden]) .panel-body').first()
  });
  await toggle.click();
  await win.locator('aside.side-panel').getByRole('tab', { name: /^Images/ }).click().catch(() => {});
});

// ---- 20. Assets: the storage line at the foot of the panel ----
await attempt('asset-storage', async () => {
  await openRail('Assets');
  const storage = win.locator('[data-testid="asset-storage"]').first();
  await storage.waitFor({ timeout: 20000 });
  const toggle = storage.locator('.asset-storage-toggle');
  await fold('asset-storage', {
    fold: storage,
    toggle,
    isOpen: async () => (await toggle.getAttribute('aria-expanded')) === 'true',
    content: storage.locator('#asset-storage-details'),
    anchor: 'bottom',
    context: win.locator('.side-panel-view:not([hidden])').first()
  });
  await toggle.click();
});

// ---- 7. SEO: the page's exact JSON-LD ----
await attempt('seo-json', async () => {
  // Structured data names everything by the site's public address, so a page carries none until the site has one.
  await apply([{ type: 'site.update', baseUrl: 'https://harbourlane.example' }], 'A public address');
  await win.locator('.rail [data-rail="seo"]').click();
  await win.locator('.seo-view .seo-ov').waitFor();
  await win.locator('.seo-panel .seo-open', { hasText: 'About' }).first().click();
  await win.locator('.seo-view [data-seo-doc]').waitFor();
  await win.locator('.seo-view [role="tab"]', { hasText: 'Structured data' }).first().click();
  const json = win.locator('.seo-view details.seo-json').first();
  await json.waitFor({ timeout: 20000 });
  await pause(600);
  await fold('seo-json', { fold: json, context: win.locator('.seo-view .seo-doc').first() });
  await openRail('Layers');
});

// ---- 3. Project health: a theme update's "See which ones" ----
await attempt('health-details', async () => {
  const snap = await snapshot();
  snap.diagnostics = [];
  snap.conflicts = [];
  snap.themeUpdates = {
    available: [
      { id: 'foundation.hero.centered', name: 'Hero' },
      { id: 'foundation.content.text', name: 'Text' },
      { id: 'foundation.contact.form', name: 'Contact form' }
    ],
    kept: [{ id: 'foundation.data.table', name: 'Table', reason: 'Its stored definition was changed outside the theme.' }]
  };
  // Through the channel the main process announces every change on, as project-health.mjs seeds it.
  await app.evaluate(({ BrowserWindow }, s) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
    w.webContents.send('project:changed', { seq: 0, base: null, revision: s.revision, snapshot: s });
  }, snap);
  await pause(400);
  await win.locator('.status-bar button[title^="Project health:"]').click();
  await modal().waitFor();
  await pause(350);
  const d = modal().locator('.health-details').first();
  await fold('health-details', { fold: d, extra: true, context: d.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " health-row ")][1]') });
  await closeModal();
  const fresh = await snapshot();
  await app.evaluate(({ BrowserWindow }, s) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
    w.webContents.send('project:changed', { seq: 0, base: null, revision: s.revision, snapshot: s });
  }, fresh);
  await pause(400);
});

// ---- 4. Import review: more files than a sentence lists ----
await attempt('import-disclosure', async () => {
  const fix = join(WORK, 'fixtures');
  mkdirSync(fix, { recursive: true });
  // Plain photos, small enough to be added as they are: more of them than a sentence lists.
  const photos = ['studio', 'kitchen', 'bedroom', 'reading', 'dining', 'hero'];
  const labels = ['team-offsite-2026', 'IMG_4821', 'kitchen-renovation-before-after', 'reading-nook', 'DSC00912', 'dining-room-tall-window'];
  // One large photo first, which the review offers a copy of: a batch of only plain files is added without one.
  const large = join(fix, 'harbour-lane-living-room-oak-floor-afternoon-light.jpg');
  await sharp(resolve('resources/starter-assets', 'kitchen.jpg')).resize({ width: 4200 }).jpeg({ quality: 98 }).toFile(large);
  const paths = [large];
  for (let i = 0; i < photos.length; i++) {
    const p = join(fix, `${labels[i]}.jpg`);
    await sharp(resolve('resources/starter-assets', `${photos[i]}.jpg`)).resize({ width: 600 + i * 10 }).jpeg({ quality: 82 }).toFile(p);
    paths.push(p);
  }
  await openRail('Assets');
  await win.locator('aside.side-panel').getByRole('tab', { name: /^Images/ }).click().catch(() => {});
  await answerChoosers(app, [{ dialog: 'open', paths }]);
  await win.locator('.asset-add, .asset-drop').first().click();
  const d = modal().locator('.import-disclosure').first();
  await d.waitFor({ timeout: 60000 });
  await pause(400);
  await fold('import-disclosure', { fold: d, extra: true, context: modal().locator('.modal-body').first() });
  await closeModal();
});

// ---- 14. Site styles: the refused theme pack, with why it couldn't be loaded under a fold ----
await attempt('ss-packs-refused', async () => {
  await win.locator('.dock-tab', { hasText: 'Styles' }).click();
  const note = win.locator('#dock-panel-styles .ss-packs-refused').first();
  await note.waitFor({ timeout: 20000 });
  const whyFold = note.locator('details').first();
  const why = whyFold.locator(':scope > summary');
  await fold('ss-packs-refused', {
    fold: note,
    toggle: why,
    isOpen: () => whyFold.evaluate((el) => el.open === true),
    content: note.locator('.ss-packs-why'),
    context: win.locator('#dock-panel-styles .ss-theme').first()
  });
  await why.click();
  await openInspector();
});

// ---- 19. Site styles: whole-row folds, a colour's details and a text style ----
/** Open the Styles section whose head reads `name` when it is closed, so its rows are on screen. */
async function openStylesSection(name) {
  const head = win.locator('#dock-panel-styles .section-head', { hasText: name }).first();
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  await pause(300);
}
await attempt(['ss-color-row', 'ss-text-row'], async () => {
  await win.locator('.dock-tab', { hasText: 'Styles' }).click();
  await openStylesSection(/^Colou?rs/);
  const color = win.locator('#dock-panel-styles .ss-color[data-token-id]').filter({ has: win.locator('.ss-disclose') }).first();
  await color.waitFor({ timeout: 20000 });
  const colorToggle = color.locator('.ss-disclose');
  await fold('ss-color-row', {
    fold: color,
    toggle: colorToggle,
    isOpen: async () => (await colorToggle.getAttribute('aria-expanded')) === 'true',
    content: win.locator(`[id="${await colorToggle.getAttribute('aria-controls')}"]`),
    context: color.locator('xpath=..')
  });
  await colorToggle.click();
  await openStylesSection(/^Text/);
  const text = win.locator('#dock-panel-styles .ss-text-head').first();
  await text.waitFor({ timeout: 20000 });
  const textToggle = text.locator('.ss-text-toggle');
  await fold('ss-text-row', {
    fold: text.locator('xpath=..'),
    toggle: textToggle,
    isOpen: async () => (await textToggle.getAttribute('aria-expanded')) === 'true',
    content: win.locator(`[id="${await textToggle.getAttribute('aria-controls')}"]`),
    context: text.locator('xpath=../..')
  });
  await textToggle.click();
  await openInspector();
});

// ---- 6. Connect source: the sample's folds ----
const PEOPLE = [
  { id: 101, name: 'Ana Ruiz', slug: 'ana-ruiz', role: 'Architect', office: 'London', updated: '2026-10-02T09:30:00Z', bio: 'Leads the residential studio.' },
  { id: 102, name: 'Ben Okafor', slug: 'ben-okafor', role: 'Engineer', office: 'Leeds', updated: '2026-09-18T14:05:00Z', bio: 'Structural engineer.' },
  { id: 103, name: 'Dev Patel', slug: 'dev-patel', role: 'Architect', office: '', updated: '2026-08-30T08:00:00Z', bio: '' }
];
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: { items: PEOPLE } }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const API = `http://127.0.0.1:${server.address().port}`;
await attempt('sd-fold', async () => {
  await apply(
    [
      {
        type: 'collection.create',
        collectionId: 'staff',
        name: 'Staff directory',
        kind: 'structured',
        singularName: 'Person',
        hasBody: false,
        pages: { detail: false, archive: false },
        fields: { role: { type: 'string', label: 'Role' }, office: { type: 'string', label: 'Office' } }
      }
    ],
    'Staff for the capture'
  );
  await openRail('Content');
  await win.locator('[data-testid="collection-options-staff"], .posts-switch').first().waitFor({ timeout: 15000 });
  if (!(await win.locator('[data-testid="collection-options-staff"]').count())) {
    await win.locator('.posts-switch').click();
    await win.getByRole('menuitemradio', { name: /^Staff directory/ }).or(win.getByRole('menuitem', { name: /^Staff directory/ })).first().click();
  }
  await win.locator('[data-testid="collection-options-staff"]').click();
  await win.getByRole('menuitem', { name: /Connect external source/ }).click();
  await modal().waitFor();
  await pause(300);
  await modal().getByLabel('Name', { exact: true }).fill('Team API');
  await modal().getByLabel('Address', { exact: true }).fill(`${API}/team`);
  await modal().getByLabel('Where the records are in a reply').fill('data.items');
  for (const [label, path] of [
    ['Title', 'name'],
    ['Address (slug)', 'slug'],
    ['Updated', 'updated'],
    ['Role', 'role'],
    ['Office', 'office']
  ])
    await modal().getByLabel(label, { exact: true }).first().fill(path);
  await win.locator('[data-testid="source-test"]').click();
  await modal().locator('[data-testid="source-sample"] .sd-fold').first().waitFor({ timeout: 30000 });
  await pause(500);
  // The second record: closed until opened (the first starts open).
  const folds = modal().locator('[data-testid="source-sample"] .sd-fold');
  const d = (await folds.count()) > 1 ? folds.nth(1) : folds.first();
  await fold('sd-fold', { fold: d, extra: true, context: modal().locator('[data-testid="source-sample"]').first() });
  await win.keyboard.press('Escape');
  await pause(300);
  if (await win.locator('.modal').count()) await win.locator('.modal .modal-head [aria-label="Close"]').last().click();
  await win.locator('.modal').first().waitFor({ state: 'detached', timeout: 10000 });
  await openRail('Layers');
});
server.close();

// ---- 9. Form practice in Preview: where many forms send ----
await attempt('form-practice-forms', async () => {
  await win.locator('.project-title').click();
  await win.locator('[role^="menuitem"]', { hasText: 'Contact' }).first().click();
  await pause(1500);
  // A contact form on the page, so Preview has forms to practise with (form-practice.mjs adds one the same way).
  const frameNow = win.frameLocator('.frame-box iframe');
  if ((await frameNow.locator('form').count()) === 0) {
    await win.getByRole('button', { name: 'Insert', exact: true }).click();
    await win.getByRole('button', { name: 'Contact form' }).first().click();
    await frameNow.locator('form').first().waitFor({ timeout: 30000 });
    await pause(800);
  }
  await win.locator('button[title^="Preview:"]').click();
  const panel = win.locator('.form-practice');
  await panel.waitFor({ timeout: 30000 });
  const content = await (await win.locator('.frame-box iframe').elementHandle()).contentFrame();
  await content.evaluate((forms) => {
    window.parent.postMessage({ protocolVersion: 1, sessionId: window.name, navigationId: document.documentElement.getAttribute('data-so-navigation'), revision: 0, type: 'forms', payload: { forms } }, '*');
  }, [
    { id: 'capture-a', label: 'Tell us about your kitchen or joinery project', place: 'page', service: 'endpoint', destination: 'https://forms.harbour-lane.test/f/studio-enquiries', live: true },
    { id: 'capture-b', label: 'Newsletter', place: 'footer', service: 'netlify', destination: '', live: false },
    { id: 'capture-c', label: '', place: 'header', service: 'none', destination: '', live: false }
  ]);
  const d = panel.locator('.form-practice-forms').first();
  await d.waitFor({ timeout: 10000 });
  await pause(900);
  await fold('form-practice-forms', { fold: d, extra: true, context: panel });
  if (await d.evaluate((el) => el.open)) await d.locator('summary').click();
  await win.locator('.preview-pill button', { hasText: 'Back to editing' }).click();
  await pause(800);
});

// ---- 10, 11. Edit everywhere: a component's contract fields, and a state used by many elements ----
await attempt(['contract-fields', 'contract-uses'], async () => {
  const none = { type: 'none', target: '' };
  const [made] = await apply(
    [
      {
        type: 'component.upsert',
        name: 'Pricing panel',
        properties: {
          heading: { type: 'string', label: 'Heading', default: 'Plans for every team' },
          features: { type: 'list', label: 'Features', itemLabel: 'Feature', fields: { title: { type: 'string', label: 'Title', default: '' }, detail: { type: 'string', label: 'Detail', default: '' } }, default: [{ title: 'Unlimited projects', detail: 'Make as many sites as you need.' }] }
        },
        nodes: [
          { kind: 'element', id: 'root', tag: 'section', children: ['heading', 'tabs', 'monthly', 'annual', 'features'] },
          { kind: 'text', id: 'heading', name: 'Heading', tag: 'h2', text: { $prop: 'heading' } },
          { kind: 'element', id: 'tabs', name: 'Tabs', children: ['monthlyTab', 'annualTab', 'nextTab'] },
          { kind: 'link', id: 'monthlyTab', name: 'Monthly button', link: none, label: 'Monthly', appearance: 'secondary', stateAction: { state: 'billing', op: 'set', value: 'monthly' } },
          { kind: 'link', id: 'annualTab', name: 'Annual button', link: none, label: 'Annual', appearance: 'secondary', stateAction: { state: 'billing', op: 'set', value: 'annual' } },
          { kind: 'link', id: 'nextTab', name: 'Next plan button', link: none, label: 'Next', appearance: 'text', stateAction: { state: 'billing', op: 'next', wrap: true } },
          { kind: 'element', id: 'monthly', name: 'Monthly panel', children: ['monthlyText'], when: { ref: { $state: 'billing' }, eq: 'monthly' } },
          { kind: 'text', id: 'monthlyText', name: 'Monthly price', text: '$12 a month' },
          { kind: 'element', id: 'annual', name: 'Annual panel', children: ['annualText'], when: { ref: { $state: 'billing' }, eq: 'annual' } },
          { kind: 'text', id: 'annualText', name: 'Annual price', text: '$120 a year' },
          { kind: 'repeat', id: 'features', name: 'Feature list', list: 'features', children: ['featureTitle'] },
          { kind: 'text', id: 'featureTitle', name: 'Feature title', text: { $item: 'title' } }
        ],
        state: { billing: { type: 'enum', label: 'Billing', options: [{ value: 'monthly', label: 'Monthly' }, { value: 'annual', label: 'Annual' }] } }
      }
    ],
    'Make Pricing panel'
  );
  const defId = made.definitionId;
  const s = await snapshot();
  await apply([{ type: 'node.insert', owner: { kind: 'page', id: s.state.site.homePageId }, parentId: null, index: 0, definitionId: defId }], 'Place it');
  // Back to Home, then into Component Studio from the command menu, as edit-everywhere-controls.mjs opens it.
  await win.locator('.project-title').click();
  await win.locator('[role^="menuitem"]', { hasText: 'Home' }).first().click();
  await pause(1200);
  await win.locator('.canvas').focus();
  await win.keyboard.press(`${MOD}+K`);
  await win.locator('.cmdk').waitFor();
  await win.keyboard.type('Pricing panel studio');
  await win.locator('.cmdk [role="option"]', { hasText: 'in Component Studio' }).first().click();
  await win.locator('.mode-band').filter({ hasText: 'Pricing panel in Component Studio' }).waitFor({ timeout: 30000 });
  await frame.locator(`[data-so-ctx="preview:${defId}|preview"] [data-so-node="root"], [data-so-ctx="preview:${defId}|preview"][data-so-node="root"]`).first().waitFor({ timeout: 60000 });
  await pause(1200);
  await openRail('Layers');
  const row = win.locator(`[role="tree"] [data-owner="component:${defId}"][data-node="root"]`).first();
  if (await row.isVisible().catch(() => false)) await row.click();
  else await frame.locator(`[data-so-ctx="preview:${defId}|preview"] [data-so-node="root"]`).first().dispatchEvent('click');
  for (let i = 0; i < 40 && (await row.getAttribute('aria-selected').catch(() => null)) !== 'true'; i++) await pause(250);
  await openInspector();
  await pause(700);
  const openSection = async (title) => {
    const head = inspector.locator('.section-head', { hasText: title }).first();
    if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
    await pause(300);
  };
  await attempt('contract-fields', async () => {
    await openSection('Properties');
    const d = inspector.locator('.contract-fields').first();
    await fold('contract-fields', { fold: d, context: d.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " section-body ")][1]') });
  });
  await attempt('contract-uses', async () => {
    await openSection('UI state');
    const d = inspector.locator('.contract-uses').first();
    await fold('contract-uses', { fold: d, context: d.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " section-body ")][1]') });
  });
  await win.getByRole('button', { name: 'Done editing' }).first().click().catch(() => {});
  await pause(800);
});

// ---- 1. The stopped preview's card: Technical details (last: the canvas stays on the card) ----
await attempt('status-card-details', async () => {
  const detail = [
    'Error: listen EADDRINUSE: address already in use 127.0.0.1:5174',
    '    at Server.setupListenHandle [as _listen2] (node:net:1908:16)',
    '    at listenInCluster (node:net:1965:12)',
    '    at doListen (node:net:2139:7)'
  ].join('\n');
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('runtime:status', s), { state: 'error', message: 'The preview server failed to start.', detail });
  const d = win.locator('.canvas-state .status-card-details').first();
  await d.waitFor({ timeout: 10000 });
  await pause(400);
  await fold('status-card-details', { fold: d, extra: true, context: win.locator('.canvas-state .status-card').first() });
});

if (errors.length) console.log('page errors:\n' + errors.join('\n'));
await win.evaluate(() => window.builder.projects.close()).catch(() => {});
await app.close();

// ---------------------------------------------------------------------------
// 2. The editor's failure screen, from the real component and stylesheet (as failure-recovery.mjs renders it)
// ---------------------------------------------------------------------------
await (async () => {
  let browser;
  try {
    const { build } = await import('vite');
    const { default: react } = await import('@vitejs/plugin-react');
    const src = (p) => JSON.stringify(resolve(p));
    const ENTRY = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import ${src('src/renderer/src/styles/index.css')};
import * as failure from ${src('src/renderer/src/components/RenderFailure')};
window.builder = { app: { openExternal: async () => {}, buildDetails: async () => 'SiteOrigin Builder 0.1.0', quit: async () => {} } };
const root = createRoot(document.getElementById('root'));
function Screen({ error }) {
  if (error) throw error;
  return h('main', null, 'editor');
}
window.fail = (stack) => {
  // A real error, its stack as a failure in the editor throws it.
  const error = new TypeError(stack.split('\\n')[0].replace(/^TypeError: /, ''));
  error.stack = stack;
  const props = { key: 1, onCloseProject: () => {}, reload: () => {} };
  flushSync(() => root.render(h(failure.RenderFailure, props, h(Screen, { error: null }))));
  flushSync(() => root.render(h(failure.RenderFailure, props, h(Screen, { error }))));
};
`;
    const out = await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [react(), { name: 'disclosures', enforce: 'pre', resolveId: (id) => (id === '\0entry' ? id : null), load: (id) => (id === '\0entry' ? ENTRY : null) }],
      resolve: { alias: { '@shared': resolve('src/shared'), '@engine': resolve('src/engine'), '@catalogue': resolve('src/catalogue'), '@agent': resolve('src/agent'), '@runtime': resolve('src/runtime') } },
      define: { 'process.env.NODE_ENV': '"development"' },
      build: { write: false, minify: false, cssCodeSplit: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
    });
    const outputs = (Array.isArray(out) ? out[0] : out).output;
    const script = outputs.find((o) => o.type === 'chunk')?.code;
    const css = outputs.filter((o) => o.type === 'asset' && o.fileName.endsWith('.css')).map((o) => String(o.source)).join('\n');
    if (!script || !css) throw new Error('the failure screen did not bundle');
    const SITE = 'http://disclosures.test';
    const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await page.route(`${SITE}/**`, (route) => (route.request().url().endsWith('/app.js') ? route.fulfill({ contentType: 'text/javascript', body: script }) : route.fulfill({ contentType: 'text/html', body: PAGE })));
    await page.goto(`${SITE}/`);
    await page.waitForFunction(() => typeof window.fail === 'function');
    await page.evaluate((stack) => window.fail(stack), [
      "TypeError: Cannot read properties of undefined (reading 'nodes')",
      '    at LayersTree (layers/LayersTree.tsx:214:38)',
      '    at renderWithHooks (react-dom.development.js:15486:18)',
      '    at mountIndeterminateComponent (react-dom.development.js:20103:13)',
      '    at beginWork (react-dom.development.js:21626:16)',
      '    at performUnitOfWork (react-dom.development.js:26596:12)'
    ].join('\n'));
    const d = page.locator('.failure-details').first();
    await d.waitFor({ timeout: 10000 });
    const pageTheme = async (theme) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.evaluate((t) => (document.documentElement.dataset.appearance = t), theme);
      await page.waitForTimeout(150);
    };
    const pageRest = async () => {
      await page.mouse.move(4, VIEWPORT.height - 4);
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await page.waitForTimeout(150);
    };
    await captureFold(page, 'failure-details', { fold: d, setTheme: pageTheme, rest: pageRest, context: page.locator('.failure-text').first().locator('xpath=..') });
  } catch (e) {
    const reason = String(e?.message ?? e).split('\n')[0];
    skips.push(`failure-details: ${reason}`);
    console.log(`SKIP failure-details: ${reason}`);
  } finally {
    await browser?.close();
  }
})();

cleanup();
const pngs = readdirSync(OUT).filter((f) => f.endsWith('.png'));
const missing = written.filter((p) => !pngs.includes(p.split('/').pop()));
if (missing.length) throw new Error(`not on disk: ${missing.join(', ')}`);
if (!skips.length) rmSync(DEBUG, { recursive: true, force: true });
console.log(`\nWROTE ${written.length}`);
for (const p of written) console.log(`  ${p.split('/').pop()}`);
console.log(skips.length ? `SKIPS (${skips.length}):\n${skips.map((s) => `  SKIP ${s}`).join('\n')}` : 'SKIPS: none');
console.log(`disclosures capture: ${Math.round((Date.now() - started) / 1000)}s`);
