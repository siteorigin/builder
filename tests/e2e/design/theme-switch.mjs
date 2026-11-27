// Design capture for switching theme in Site styles: the theme card at the top of the panel, with the themes
// it can switch to, the switch itself, a site whose theme is not installed, and theme packs that were refused.
// Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/theme-switch.mjs
//
// Installs a third theme (Atelier, made from the built Foundation release) and a malformed pack in userData/packs,
// so the chooser has more than the development fixture to offer and the refusal shows. The site is then switched to
// Atelier, the app closed, Atelier removed and the app opened again: the site's theme is then not installed.
// Card captures are the top of the dock at 2x; `-context` captures are the whole window. Every capture is checked on
// screen after it settles, and a state that did not render throws instead of writing a wrong image.
import { _electron as electron } from 'playwright';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('theme switch capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'theme-switch');
mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-theme-')));
const THEMES = ['light', 'dark'];
const PANEL = '#dock-panel-styles';
const SCROLLER = `${PANEL} .panel-body`;
const written = [];

// ---- Installed packs: Atelier (a real third theme) and one that cannot be read ----
const built = join(process.cwd(), 'resources', 'packs', 'foundation');
if (!existsSync(join(built, 'pack.json'))) throw new Error('build the app first (npm run build): the Foundation release is missing');
const packs = join(WORK, 'userdata', 'packs');
const atelier = join(packs, 'atelier');
cpSync(built, atelier, { recursive: true });
const m = JSON.parse(readFileSync(join(atelier, 'pack.json'), 'utf8'));
Object.assign(m, { id: 'atelier', name: 'Atelier', version: '1.0.0', description: 'Warm paper, ink-black type and a terracotta accent, for studios and makers.' });
for (const c of m.components) {
  c.id = `atelier.${c.componentId}`;
  c.provenance = { ...c.provenance, pack: 'atelier', packVersion: '1.0.0' };
}
const tokenValues = { 'color.background': '#faf6ef', 'color.surface-alt': '#f1e9dc', 'color.brand': '#b4532a', 'color.brand-strong': '#8f3f1e', 'color.accent': '#2f5d50', 'color.inverse': '#231f1a' };
for (const t of m.tokens) if (t.id in tokenValues) t.value = tokenValues[t.id];
writeFileSync(join(atelier, 'pack.json'), JSON.stringify(m, null, '\t'));

async function launch() {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' } });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(String(e)));
  await win.setViewportSize({ width: 1440, height: 900 });
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await win.waitForSelector('.welcome');
  await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
  return { app, win, cdp, errors };
}

let { app, win, cdp, errors } = await launch();
const pause = (ms) => win.waitForTimeout(ms);
const setTheme = async (theme) => {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
};
const scrollTo = (top) => win.evaluate(([sel, t]) => document.querySelector(sel) && (document.querySelector(sel).scrollTop = t), [SCROLLER, top]);

/** Capture `state` per theme: the theme card's part of the dock, or the whole window when `whole` is set. */
async function shot(state, check, { themes = THEMES, whole = false, before } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (before) await before();
    await win.mouse.move(2, 450);
    await pause(200);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    let clip;
    if (whole) clip = { x: 0, y: 0, ...(await win.evaluate(() => ({ width: innerWidth, height: innerHeight }))) };
    else {
      const dock = await win.locator('.dock').boundingBox();
      const intro = await win.locator(`${PANEL} .ss-intro`).boundingBox();
      // From the dock's top through the end of the card's block, and a little of what follows it.
      const bottom = Math.min(dock.y + dock.height, intro.y + intro.height + 40);
      clip = { x: dock.x, y: dock.y, width: dock.width, height: Math.max(200, bottom - dock.y) };
    }
    const path = join(OUT, `${state}--${theme}.png`);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
    writeFileSync(path, Buffer.from(data, 'base64'));
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}
const apply = (operations, label) => win.evaluate(([ops, l]) => window.builder.project.apply({ operations: ops }, { label: l }), [operations, label]);
const mustApply = async (operations, label) => {
  const r = await apply(operations, label);
  if (!r?.ok) throw new Error(`could not apply "${label}": ${JSON.stringify(r?.error)}`);
  await pause(900);
};
const openStyles = async (preview = true) => {
  await win.waitForSelector('.editor', { timeout: 60000 }).catch(async (e) => {
    await win.screenshot({ path: join(OUT, '..', 'debug-open.png') });
    throw e;
  });
  // A site whose theme is not installed has no preview: the editor says so in its place.
  if (preview) await win.frameLocator('.frame-box iframe').locator('h1').first().waitFor({ timeout: 120000 });
  else await win.locator('.editor').getByText('Preview unavailable').first().waitFor({ timeout: 60000 });
  await pause(1500);
  await win.locator('.dock-tab', { hasText: 'Site styles' }).click();
  await pause(800);
  await scrollTo(0);
};

// ---- A populated business site on Foundation ----
const site = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), site);
await openStyles();

// ---- Rest: the card as an owner first sees it, with the other themes on offer ----
await shot('rest', `${PANEL} .ss-theme`);
await shot('rest-context', `${PANEL} .ss-theme`, { whole: true, themes: ['light'] });

// ---- The chooser, open: whatever the card offers for picking another theme ----
// Opens the chooser when it is a control of the card's own (a native select's menu cannot be captured).
const chooser = win.locator(`${PANEL} [data-theme-chooser]`);
if (await chooser.count()) {
  await chooser.first().click();
  await pause(500);
  await shot('chooser', `${PANEL} .ss-theme`);
  // A theme other than the current one, picked but not yet applied.
  const other = win.locator(`${PANEL} [data-theme-option="atelier"]`);
  if (await other.count()) {
    await other.first().click();
    await pause(500);
    await shot('picked', `${PANEL} .ss-theme`);
    await shot('picked-context', `${PANEL} .ss-theme`, { whole: true, themes: ['light'] });
  }
  await win.keyboard.press('Escape');
  await pause(300);
}

// ---- Styles changed from the theme ----
await mustApply(
  [
    { type: 'token.set', tokenId: 'color.brand', value: '#2b5d8a' },
    { type: 'token.set', tokenId: 'font.display', value: "Georgia, 'Times New Roman', serif" },
    { type: 'token.set', tokenId: 'radius.md', value: '8px' }
  ],
  'Design capture: change site styles'
);
await shot('changed', `${PANEL} .ss-changes`, { before: () => scrollTo(0) });

// ---- Switched to Atelier, through the card itself when it can do it, with the changes kept ----
const before = await win.evaluate(async () => (await window.builder.project.snapshot()).state.site.themeId);
const switchButton = win.locator(`${PANEL} [data-theme-switch-to="atelier"]`);
if (await chooser.count()) {
  await chooser.first().click();
  await pause(300);
  await win.locator(`${PANEL} [data-theme-option="atelier"]`).first().click();
  await pause(300);
  await switchButton.first().click();
} else await win.locator(`${PANEL} select.ss-theme-switch`).selectOption('atelier');
await pause(2500);
const after = await win.evaluate(async () => (await window.builder.project.snapshot()).state.site.themeId);
if (before === after || after !== 'atelier') throw new Error(`the card did not switch the theme (still ${after})`);
await shot('switched', `${PANEL} .ss-theme`, { before: () => scrollTo(0) });
await shot('switched-context', `${PANEL} .ss-theme`, { whole: true, themes: ['light'] });

// ---- The narrowest dock ----
const resizer = win.locator('.seam.right .resizer');
const box = await resizer.boundingBox();
if (box) {
  await win.mouse.move(box.x + box.width / 2, box.y + 200);
  await win.mouse.down();
  await win.mouse.move(box.x + 200, box.y + 200, { steps: 6 });
  await win.mouse.up();
  await pause(500);
}
await shot('narrow', `${PANEL} .ss-theme`, { themes: ['light'], before: () => scrollTo(0) });

// ---- The site's theme is no longer installed: Atelier removed, the app opened again on the site ----
// A pack that cannot be read is installed at the same time, so the card also says which packs were refused.
await app.close();
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
rmSync(atelier, { recursive: true, force: true });
mkdirSync(join(packs, 'harbour-classic'));
writeFileSync(join(packs, 'harbour-classic', 'pack.json'), '{ "id": "harbour-classic", ');
({ app, win, cdp, errors } = await launch());
const projectDir = join(site, readdirSync(site).find((n) => !n.startsWith('.')));
let opened = await win.evaluate((d) => window.builder.projects.open(d), projectDir);
if (opened?.needsTrust) opened = await win.evaluate((d) => window.builder.projects.trustAndOpen(d), projectDir);
if (opened && opened.ok === false) throw new Error('could not reopen the site: ' + JSON.stringify(opened));
await openStyles(false);
await shot('missing', `${PANEL} .ss-theme`);
await shot('missing-context', `${PANEL} .ss-theme`, { whole: true, themes: ['light'] });
// The refused pack's reasons, opened.
const why = win.locator(`${PANEL} .ss-packs-refused [aria-expanded]`);
if (await why.count()) {
  await why.first().click();
  await pause(300);
  await shot('missing-why', `${PANEL} .ss-packs-refused`, { themes: ['light'] });
}

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`theme switch capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
