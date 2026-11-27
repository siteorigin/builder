// Design capture for a page's Structured data fields (components/StructuredDataFields.tsx): the page type at rest and
// chosen, each type's facts empty, filled and refused, saved values that can't be used, and the same fields in the SEO
// view's page settings. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/structured-data.mjs
//
// Drives the real (built) app with the business starter, seeds each page's structured data through the same
// project:apply channel the editor uses (and, for values only a hand edit can leave, the page's file on disk before
// the project opens again), and writes `{state}--{theme}.png` at 2x, clipped to the section. Every capture is checked
// on screen after it settles, and a state that did not render throws instead of writing a wrong image.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('Structured data capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'structured-data');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-sd-')));
const THEMES = ['light', 'dark'];
const LIGHT = ['light'];

const app = await electron.launch({
  args: ['.'],
  env: {
    ...process.env,
    SITEORIGIN_USER_DATA: join(WORK, 'userdata'),
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: ''
  }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
const cdp = await win.context().newCDPSession(win);
const size = { width: 1440, height: 1400 };
await win.setViewportSize(size);
await cdp.send('Emulation.setDeviceMetricsOverride', {
  ...size,
  deviceScaleFactor: 2,
  mobile: false
});
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

const setTheme = async (theme) => {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
};

/** Capture `state` per theme, clipped to the box of `clip` (padded a little). */
async function shot(state, check, clip, themes = THEMES) {
  for (const theme of themes) {
    await setTheme(theme);
    await win.mouse.move(2, size.height / 2);
    await pause(200);
    const visible = await win
      .locator(check)
      .first()
      .isVisible()
      .catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const b = await win.locator(clip).first().boundingBox();
    if (!b || b.height < 20) throw new Error(`state "${state}" (${theme}): "${clip}" has no box; refusing to write`);
    const pad = 8;
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: {
        x: Math.max(0, b.x - pad),
        y: Math.max(0, b.y - pad),
        width: b.width + pad * 2,
        height: Math.min(b.height + pad * 2, size.height - b.y),
        scale: 1
      }
    });
    const path = join(OUT, `${state}--${theme}.png`);
    writeFileSync(path, Buffer.from(data, 'base64'));
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

const apply = async (operations, label) => {
  const r = await win.evaluate(([ops, l]) => window.builder.project.apply({ operations: ops }, { label: l }), [operations, label]);
  if (!r?.ok) throw new Error(`could not apply "${label}": ${JSON.stringify(r?.error)}`);
  await pause(500);
};
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const pageNamed = async (title) => Object.values((await snapshot()).state.pages).find((p) => p.title === title);

// The Inspector's Structured data section, its box being the capture.
const inspSection = '.dock .section:has(#page-structured-type)';
const viewGroup = '.seo-view .seo-settings-group:has(#page-structured-type)';

/** Show a page's settings in the Inspector, Structured data opened and scrolled to the top of the panel. */
async function inspect(title) {
  const rail = win.locator('.rail [data-rail="pages"]');
  if ((await rail.getAttribute('aria-pressed')) !== 'true') await rail.click();
  await pause(300);
  await win.locator('.list-item', { hasText: title }).first().click();
  await pause(900);
  const tab = win.locator('#dock-tab-inspect');
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await win.locator('#dock-panel-inspect').waitFor();
  await win.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('inspector-open-section', {
        detail: { id: 'page-structured-data', scroll: false }
      })
    )
  );
  await pause(400);
  await win.evaluate(() => {
    const el = document.querySelector('.dock .section:has(#page-structured-type)');
    const scroller = el?.closest('.panel-body');
    if (!el || !scroller) throw new Error('no Structured data section');
    const head = scroller.querySelector('.insp-head')?.offsetHeight ?? 0;
    scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - head - 8;
  });
  await pause(400);
}

/** Type into a fact's field and leave it, as a person would. */
async function typeInto(selector, text) {
  const f = win.locator(selector).first();
  await f.click();
  await f.fill(text);
  // Enter saves; Tab would only step through a date or time field's own parts.
  await f.press('Enter');
  await f.evaluate((el) => el.blur());
  await pause(500);
}

// ---- A populated business site, with a page for each type ----
const sites = join(WORK, 'sites');
await win.evaluate(
  (dir) =>
    window.builder.projects.create({
      name: 'Harbour Lane Studio',
      parentDir: dir,
      starter: 'business',
      sampleImages: false
    }),
  sites
);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1500);
const about = await pageNamed('About');
if (!about) throw new Error('the business starter has no About page');
await apply(
  [
    {
      type: 'page.create',
      pageId: 'pg_pottery',
      title: 'Pottery classes',
      starter: 'services'
    },
    {
      type: 'page.create',
      pageId: 'pg_glaze',
      title: 'Studio glaze kit',
      starter: 'pricing'
    },
    {
      type: 'page.create',
      pageId: 'pg_open',
      title: 'Spring open studio',
      starter: 'intro'
    },
    {
      type: 'page.create',
      pageId: 'pg_kiln',
      title: 'Firing a kiln at home',
      starter: 'intro'
    },
    {
      type: 'page.create',
      pageId: 'pg_wedge',
      title: 'Wedging clay',
      starter: 'intro'
    },
    {
      type: 'page.create',
      pageId: 'pg_mugs',
      title: 'Hand-thrown mugs',
      starter: 'intro'
    }
  ],
  'Add pages'
);
await apply(
  [
    {
      type: 'page.update',
      pageId: 'pg_pottery',
      structuredData: {
        type: 'Service',
        serviceType: 'Pottery classes',
        areaServed: 'Cape Town'
      }
    },
    {
      type: 'page.update',
      pageId: 'pg_glaze',
      structuredData: {
        type: 'Product',
        price: '349.00',
        currency: 'ZAR',
        availability: 'InStock',
        offerUrl: 'https://shop.harbourlane.studio/glaze-kit'
      }
    },
    {
      type: 'page.update',
      pageId: 'pg_open',
      structuredData: { type: 'Event' }
    },
    {
      type: 'page.update',
      pageId: 'pg_kiln',
      structuredData: {
        type: 'HowTo',
        steps: ['Load the shelves with the bisque-fired pieces, leaving a finger’s width between them.', 'Close the lid and set the controller to the glaze programme.', 'Let it cool for a full day before you open it.']
      }
    },
    {
      type: 'page.update',
      pageId: 'pg_wedge',
      structuredData: { type: 'HowTo' }
    }
  ],
  'Seed structured data'
);

// ---- The Inspector ----
await win.evaluate(() => {
  for (const k of Object.keys(localStorage)) if (k.startsWith('section:')) localStorage.removeItem(k);
});

// The page type at rest: a web page.
await inspect('About');
await shot('insp-webpage', '#page-structured-type', inspSection);
// The section closed, as it starts, with its summary beside the heading.
await win.evaluate(() => document.querySelector('.dock .section:has(#page-structured-type) .section-head')?.click());
await pause(300);
await shot('insp-closed', '.dock .section-head:has(.scope)', '.dock .insp', LIGHT);
await win.evaluate(() => document.querySelector('.dock .section:has(#page-structured-type) .section-head')?.click());
await pause(300);

// Each type filled in.
await inspect('Pottery classes');
await shot('insp-service', '#page-structured-serviceType', inspSection);
await inspect('Studio glaze kit');
await shot('insp-product', '#page-structured-price', inspSection);
await inspect('Firing a kiln at home');
await shot('insp-howto', '#page-structured-steps', inspSection, LIGHT);

// An event just chosen: nothing said yet, so everything it needs is missing.
await inspect('Spring open studio');
await shot('insp-event-empty', '#page-structured-startDate', inspSection);
// Filled in as a person would, one field at a time.
// A time typed first: held, with what it waits for, and saved with the date.
await typeInto('#page-structured-startDate-time', '19:30');
await inspect('Spring open studio');
await shot('insp-event-time-first', '#page-structured-startDate-time', inspSection, LIGHT);
await typeInto('#page-structured-startDate', '2027-05-14');
{
  // The time typed first is saved with the date, not dropped.
  const saved = (await pageNamed('Spring open studio')).seo?.structuredData?.startDate;
  if (saved !== '2027-05-14T19:30') throw new Error(`the start saved as ${JSON.stringify(saved)}, not with the time typed first`);
}
await typeInto('#page-structured-endDate', '2027-05-14');
await typeInto('#page-structured-endDate-time', '22:00');
await typeInto('#page-structured-venue', 'Riverside Studio');
await typeInto('#page-structured-address', '14 Harbour Lane, Woodstock, Cape Town, 7925');
await inspect('Spring open studio');
await shot('insp-event-filled', '#page-structured-venue', inspSection);
// An end before its start.
await typeInto('#page-structured-endDate', '2027-05-13');
await inspect('Spring open studio');
await shot('insp-event-ends-before', '#page-structured-endDate', inspSection, LIGHT);

// A guide with no steps yet.
await inspect('Wedging clay');
await shot('insp-howto-empty', '#page-structured-steps', inspSection, LIGHT);

// Text the field can't take, kept unsaved beside the saved value.
await inspect('Studio glaze kit');
await typeInto('#page-structured-price', 'R 349,5');
await inspect('Studio glaze kit');
await shot('insp-product-refused', '#page-structured-price', inspSection);
await win.locator('#page-structured-price').click();
await win.keyboard.press('Escape');
await pause(300);

// Choosing another type for a page with facts: what the change costs.
await inspect('Pottery classes');
await win.locator('#page-structured-type').focus();
// Reached by the author (a key), so what choosing another type costs is said.
await win.keyboard.press('Shift');
await pause(200);
await shot('insp-service-focus-type', '#page-structured-type', inspSection, LIGHT);
// Another type chosen: the service's details go, said in a notice with Undo.
await win.locator('#page-structured-type').selectOption('Product');
await win.locator('.toast', { hasText: 'Removed' }).first().waitFor({ timeout: 5000 });
await shot('insp-type-changed', '.toast', '.toast', LIGHT);
await win.locator('.toast', { hasText: 'Removed' }).getByRole('button', { name: 'Undo' }).click();
await pause(800);

// ---- The SEO view's page settings ----
await win.locator('.rail [data-rail="seo"]').click();
await win.locator('.seo-view .seo-ov').waitFor();
await pause(600);
async function viewPage(title) {
  await win.locator('.seo-panel .seo-open', { hasText: title }).first().click();
  await win.locator('.seo-view [data-seo-doc]').waitFor();
  await pause(900);
  await win.evaluate(() => {
    const s = document.querySelector('.seo-scroll');
    const at = document.querySelector('.seo-view .seo-settings-group:has(#page-structured-type)');
    s.scrollTop = at.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - 20;
  });
  await pause(400);
}
await viewPage('Spring open studio');
await shot('view-event', '.seo-view #page-structured-venue', viewGroup);
await viewPage('Studio glaze kit');
await shot('view-product', '.seo-view #page-structured-price', viewGroup, LIGHT);
await viewPage('About');
await shot('view-webpage', '.seo-view #page-structured-type', viewGroup, LIGHT);
await win.keyboard.press('Escape');
await pause(300);

// ---- Saved values only a hand edit leaves: a type the editor doesn't know, and facts it can't use ----
const project = (await win.evaluate(() => window.builder.projects.recents())).find((r) => r.name === 'Harbour Lane Studio').dir;
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
const edit = (id, structuredData) => {
  const file = join(project, 'siteorigin', 'pages', `${id}.json`);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  doc.seo = { ...(doc.seo ?? {}), structuredData };
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
};
edit('pg_mugs', { type: 'Recipe', price: '120' });
edit('pg_pottery', {
  type: 'Service',
  serviceType: 'Pottery classes',
  areaServed: { city: 'Cape Town' }
});
edit('pg_open', {
  type: 'Event',
  startDate: '2027-10-30T19:30+02:00',
  endDate: '2027-10-31T01:00+01:00',
  venue: 'Riverside Studio'
});
edit('pg_glaze', {
  type: 'Product',
  price: '349,00',
  currency: 'Rand',
  availability: 'Sometimes',
  offerUrl: 'https://shop.harbourlane.studio/glaze-kit'
});
const reopened = await win.evaluate((d) => window.builder.projects.open(d), project);
if (!reopened?.ok) throw new Error(`the project did not open again: ${JSON.stringify(reopened)}`);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1500);
await inspect('Hand-thrown mugs');
await shot('insp-unknown-type', '#page-structured-type', inspSection, LIGHT);
await inspect('Studio glaze kit');
await shot('insp-product-unusable', '#page-structured-availability', inspSection);
// Times saved in two zones (across a change of the clocks): each keeps its own.
await inspect('Spring open studio');
await shot('insp-event-zones', '#page-structured-zone', inspSection, LIGHT);
// Included, but an optional detail saved by hand is left out.
await inspect('Pottery classes');
await shot('insp-service-partial', '#page-structured-areaServed', inspSection, LIGHT);

await app.close();
if (errors.length) console.log('page errors:', errors);
console.log(`\n${written.length} captures in ${OUT}`);
