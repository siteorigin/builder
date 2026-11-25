// Design capture for Welcome's Recent projects: one project, a few, a full list and a dense one, at the window's
// smallest size, a laptop and a wide desktop monitor, each with its site icons. Opt-in only, never part of
// `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/recent-projects.mjs
//
// Drives the real (built) app and writes `{state}--{theme}.png`. The list is answered from a fixture through the
// main process's own `projects:recents` handler, so every count and window size is drawn by the real renderer. Each
// capture checks its state on screen after it settles and throws rather than writing a wrong image.
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('recent projects capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'recent-projects');
mkdirSync(OUT, { recursive: true });
const { WORK, cleanup } = scratch('design-recent-projects');
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const DARK = ['dark'];
const LAPTOP = { width: 1440, height: 900 };
const WIDE = { width: 2560, height: 1440 };
const SMALLEST = { width: 1100, height: 700 }; // The window's minimum size.

const { app, win, errors } = await launch(WORK);
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

/** A site's home-screen icon as the project folder holds it: its monogram in the brand colour, edge to edge. */
const monogram = (letter, brand, ink = '#ffffff') =>
  'data:image/svg+xml;base64,' +
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${brand}"/><text x="32" y="43" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="34" font-weight="600" fill="${ink}">${letter}</text></svg>`).toString('base64');
/** A chosen favicon picture on the site's own background. */
const picture = (svg, bg = '#ffffff') => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${bg}"/>${svg}</svg>`).toString('base64');
const FLOWER = picture('<circle cx="32" cy="26" r="7" fill="#e85d75"/><circle cx="22" cy="30" r="7" fill="#f28ba0"/><circle cx="42" cy="30" r="7" fill="#f28ba0"/><circle cx="26" cy="40" r="7" fill="#e85d75"/><circle cx="38" cy="40" r="7" fill="#e85d75"/><circle cx="32" cy="34" r="5" fill="#ffd166"/>', '#fff7f2');
const WAVE = picture('<path d="M6 40c8-8 14-8 22 0s14 8 22 0 10-6 10-6v24H6z" fill="#1d6fa3"/><path d="M6 32c8-8 14-8 22 0s14 8 22 0" stroke="#7cc4e8" stroke-width="4" fill="none"/>', '#eaf6fb');
const TOOTH = picture('<path d="M20 14c6-3 9 2 12 2s6-5 12-2c6 4 4 14 1 20-2 5-2 16-6 16-3 0-3-10-7-10s-4 10-7 10c-4 0-4-11-6-16-3-6-5-16 1-20z" fill="#ffffff" stroke="#2a9d8f" stroke-width="3"/>', '#e7f6f4');

const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const home = '/Users/alex/Websites';
const RECENTS = [
  { name: 'Harbour Lane Studio', dir: `${home}/harbour-lane-studio`, openedAt: ago(4), icon: FLOWER, description: 'A florist in Lyttelton: bouquets, weddings and a small shop.' },
  { name: 'Kōwhai Garden Supplies & Landscaping Co-operative', dir: `${home}/clients/2026/kowhai-garden-supplies-and-landscaping-co-operative`, openedAt: ago(180), icon: monogram('K', '#2f6b3a') },
  { name: 'Tide & Timber', dir: `${home}/tide-and-timber`, openedAt: ago(60 * 26), icon: WAVE, description: 'Boat builders and joinery, Whanganui.' },
  { name: 'Marlow Dental', dir: `${home}/marlow-dental`, openedAt: ago(60 * 24 * 9), icon: TOOTH },
  { name: 'Northside Physio', dir: `${home}/clients/northside-physio`, openedAt: ago(60 * 24 * 21), icon: monogram('N', '#8a3ffc') },
  { name: 'Old brochure site', dir: '/Volumes/Archive/Old Sites/old-brochure-site', openedAt: ago(60 * 24 * 40), missing: true },
  { name: 'Ōtaki Beach Cafe', dir: `${home}/otaki-beach-cafe`, openedAt: ago(60 * 24 * 64) }
];
const BRANDS = ['#c2410c', '#0f766e', '#1d4ed8', '#9d174d', '#4d7c0f', '#7c2d12', '#334155', '#a16207'];
const DENSE = Array.from({ length: 20 }, (_, i) => {
  const base = RECENTS[i % RECENTS.length];
  const name = i < RECENTS.length ? base.name : `${base.name} ${i + 1}`;
  const icon = base.missing ? undefined : i < RECENTS.length ? base.icon : i % 5 === 0 ? undefined : monogram(name[0].toUpperCase(), BRANDS[i % BRANDS.length]);
  return { ...base, name, icon, dir: `${base.dir}-${i + 1}`, openedAt: ago(30 + i * i * 90) };
});
// Two copies of one project side by side: only their folder names tell them apart.
DENSE[18] = { ...DENSE[18], name: 'Marlow Dental', dir: `${home}/marlow-dental`, icon: TOOTH };
DENSE[19] = { ...DENSE[18], dir: `${home}/marlow-dental-copy` };
const ONE = [{ name: 'Some Random Site', dir: '/Users/alex/Documents/some-random-site', openedAt: ago(0), icon: monogram('S', '#1f5a4c') }];
const ONE_PLAIN = [{ name: 'Some Random Site', dir: '/Users/alex/Documents/some-random-site', openedAt: ago(0) }];
const FEW = RECENTS.slice(0, 3);
// Two clients kept pinned: one long-standing, one whose archive drive is not plugged in.
const PINNED = [
  ...DENSE.slice(0, 18),
  { name: 'Waikanae Vet Clinic', dir: `${home}/clients/waikanae-vet`, openedAt: ago(60 * 24 * 30), icon: monogram('W', '#b45309'), pinned: true },
  { name: 'Parish newsletter', dir: '/Volumes/Archive/parish-newsletter', openedAt: ago(60 * 24 * 90), missing: true, pinned: true }
];
// The newest project is itself pinned: it leads the list, and the Pinned group holds the rest.
const LATEST_PINNED = [{ ...RECENTS[0], pinned: true }, ...RECENTS.slice(1, 5), { ...RECENTS[5], pinned: true }];
// The newest project's folder has gone: it still leads, says so, and still says when it was last opened.
const LATEST_MISSING = [{ name: 'Old brochure site', dir: '/Volumes/Archive/Old Sites/old-brochure-site', openedAt: ago(1), missing: true }, ...RECENTS.slice(0, 4).filter((r) => !r.missing)];

// The renderer's seam: the list comes from a fixture the script controls; opening a project waits forever.
await app.evaluate(({ ipcMain }) => {
  const c = (globalThis.__capture = { recents: [], open: { ok: false } });
  const swap = (channel, fn) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, fn);
  };
  swap('projects:recents', () => c.recents);
  swap('projects:removeRecent', () => undefined);
  swap('projects:pinRecent', (_e, dir, pinned) => {
    c.recents = c.recents.map((r) => (r.dir === dir ? { ...r, pinned } : r));
    return true;
  });
  swap('projects:open', () => (c.open === 'hold' ? new Promise(() => undefined) : c.open));
});

/** A fresh renderer over the given list, so no state leaks from the capture before it. */
async function fresh(recents, viewport = LAPTOP, open = { ok: false }) {
  await app.evaluate((_, f) => Object.assign(globalThis.__capture, f), { recents, open });
  await win.setViewportSize(viewport);
  await win.reload();
  await win.waitForSelector('.welcome-main h2');
  await win.mouse.move(viewport.width - 4, viewport.height - 4);
  await pause(200);
}

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await pause(200);
}

/** Capture a state in each theme; `check` must be visible, and `text` in it, at the moment of capture. */
async function shot(state, check, themes = BOTH, text = null) {
  for (const theme of themes) {
    await setTheme(theme);
    await pause(150);
    const target = win.locator(check).first();
    if (!(await target.isVisible().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    if (text && !(await target.innerText()).includes(text)) throw new Error(`state "${state}" (${theme}) is missing "${text}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

const LIST = '.welcome-main';

// One project: the case most people are in for their first weeks.
await fresh(ONE, WIDE);
await shot('one-wide', LIST, BOTH, 'Some Random Site');
await fresh(ONE, LAPTOP);
await shot('one-laptop', LIST, LIGHT, 'Some Random Site');
await fresh(ONE_PLAIN, LAPTOP);
await shot('one-no-icon', LIST, DARK, 'Some Random Site');

// A few projects.
await fresh(FEW, WIDE);
await shot('few-wide', LIST, DARK, 'Tide & Timber');
await fresh(FEW, LAPTOP);
await shot('few-laptop', LIST, LIGHT, 'Tide & Timber');

// A working list: seven, one of them missing.
await fresh(RECENTS, LAPTOP);
await shot('seven-laptop', LIST, BOTH, 'Harbour Lane Studio');
await fresh(RECENTS, WIDE);
await shot('seven-wide', LIST, LIGHT, 'Harbour Lane Studio');
await fresh(RECENTS, SMALLEST);
await shot('seven-smallest', LIST, LIGHT, 'Harbour Lane Studio');

// A full list: twenty, with the filter.
await fresh(DENSE, LAPTOP);
await shot('dense-laptop', LIST, LIGHT, 'Marlow Dental');
await fresh(DENSE, WIDE);
await shot('dense-wide', LIST, DARK, 'Marlow Dental');
await fresh(DENSE, LAPTOP);
await win.locator('.recent-filter input').fill('marlow');
await pause(200);
await shot('dense-filter', LIST, LIGHT, 'marlow-dental-copy');
await win.locator('.recent-filter input').fill('bakery');
await pause(200);
await shot('filter-none', '.recent-none', LIGHT, 'Clear filter');

// Pinned above the rest.
await fresh(PINNED, LAPTOP);
await shot('pinned-laptop', LIST, BOTH, 'Pinned');

await fresh(LATEST_PINNED, LAPTOP);
await shot('latest-pinned', LIST, LIGHT, 'Pinned');
await fresh(LATEST_MISSING, LAPTOP);
await shot('latest-missing', '.recent-item.latest', LIGHT, 'Last opened');

// Keyboard: the second project's card has focus.
await fresh(RECENTS, LAPTOP);
await win.locator('.recent-card').nth(1).focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await pause(150);
await shot('focus-laptop', '.recent-card:focus-visible', LIGHT);
// Keyboard on a row's own buttons: Tab from its card reaches its Pin.
await win.keyboard.press('Tab');
await pause(150);
await shot('focus-pin', '.recent-tools .pin:focus-visible', DARK);

// Hovering a project, so its quiet actions show as they do under the pointer.
await fresh(RECENTS, LAPTOP);
await win.locator('.recent-card', { hasText: 'Tide & Timber' }).hover();
await pause(250);
await shot('hover-laptop', LIST, LIGHT, 'Tide & Timber');

// A project on its way: the card says so and everything else waits.
await fresh(RECENTS, LAPTOP, 'hold');
await win.locator('.recent-card', { hasText: 'Tide & Timber' }).click();
await pause(200);
await shot('opening-laptop', '.recent-card:has(.spinner)', LIGHT, 'Opening');

await app.close();
cleanup();

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`recent projects capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
