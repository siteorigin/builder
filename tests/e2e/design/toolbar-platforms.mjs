// Design capture harness for the editor's top toolbar, end to end, as it is laid out on each desktop platform: macOS
// (traffic lights at the start), Windows (the menu button at the start, the caption buttons over its end) and Linux
// (the menu button at the start, under the system's own title bar), with Ctrl shortcuts off macOS. One computer draws
// all three: the app is launched once per platform with SITEORIGIN_PLATFORM (src/shared/chrome-platform.ts). A capture
// shows the window's content only, so macOS's traffic lights and Windows's caption buttons, which the system draws over
// it, are drawn in by the harness where they really are. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] [DESIGN_PLATFORMS=darwin,win32,linux] \
//     [DESIGN_FONT_DIR=/abs/fonts] node tests/e2e/design/toolbar-platforms.mjs
//
// Each system draws the editor in its own UI font, so text widths (and so where names shorten) differ. With
// DESIGN_FONT_DIR naming a folder that holds SegUIVar.ttf (Windows 11's Segoe UI Variable) and
// UbuntuSans[wdth,wght].ttf (Ubuntu's), copied from those systems, the Windows and Linux captures use them.
//
// Every capture is checked on screen after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{platform}-{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('toolbar platforms capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'toolbar-platforms');
mkdirSync(OUT, { recursive: true });
const PLATFORMS = (process.env.DESIGN_PLATFORMS ?? 'darwin,win32,linux').split(',').map((p) => p.trim()).filter(Boolean);
const SHORT = { darwin: 'mac', win32: 'win', linux: 'linux' };
const W = 1440;
const H = 900;
const written = [];
const FONTS = { win32: ['SegUIVar.ttf', 'Segoe UI Variable'], linux: ['UbuntuSans[wdth,wght].ttf', 'Ubuntu Sans'] };
/** The system UI font for a platform, as a style that makes the editor use it, or null. */
function systemFont(platform) {
  const dir = process.env.DESIGN_FONT_DIR;
  const [file, family] = FONTS[platform] ?? [];
  if (!dir || !file || !existsSync(join(dir, file))) return null;
  const data = readFileSync(join(dir, file)).toString('base64');
  return `@font-face { font-family: 'Design ${family}'; src: url(data:font/ttf;base64,${data}); font-weight: 100 900; } :root { --font: 'Design ${family}', sans-serif; }`;
}

for (const platform of PLATFORMS) {
  const tag = SHORT[platform];
  if (!tag) throw new Error(`unknown platform ${platform}`);
  const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-toolbar-')));
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, SITEORIGIN_PLATFORM: platform, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), SITEORIGIN_DOCUMENTS: join(WORK, 'documents'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
  });
  let win = await app.firstWindow();
  // Windows reports its caption buttons through the window controls overlay, which the editor measures to keep their
  // room free (lib/window-chrome.ts). Another system has no visible overlay, so one is stood in for it, as Windows
  // reports it, before the editor loads again.
  if (platform === 'win32') {
    await app.context().addInitScript(() => {
      const overlay = new EventTarget();
      Object.assign(overlay, { visible: true, getTitlebarAreaRect: () => new DOMRect(0, 0, Math.max(0, innerWidth - 138), 52) });
      Object.defineProperty(navigator, 'windowControlsOverlay', { get: () => overlay, configurable: true });
      addEventListener('resize', () => overlay.dispatchEvent(new Event('geometrychange')));
    });
    await win.reload();
  }
  const errors = [];
  win.on('pageerror', (e) => errors.push(String(e)));
  const cdp = await win.context().newCDPSession(win);
  const size = (width, height) => win.setViewportSize({ width, height });
  // In the display's own pixels (2x on a Retina display), so the mark's tile edge and the controls' 1px edges can be
  // judged as they are drawn; Playwright's screenshot scales them down to CSS pixels.
  const capture = async (path, clip) => {
    const vp = win.viewportSize();
    const c = clip ?? { x: 0, y: 0, width: vp.width, height: vp.height };
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...c, scale: 1 } });
    writeFileSync(path, Buffer.from(data, 'base64'));
  };
  await size(W, H);
  await win.waitForSelector('.welcome');
  const font = systemFont(platform);
  if (font) {
    await win.addStyleTag({ content: font });
    await win.evaluate(() => document.fonts.ready);
    console.log(`${tag}: system font loaded`);
  }
  const reported = await win.evaluate(() => window.builder.platform);
  if (reported !== platform) throw new Error(`asked for ${platform} chrome, the editor reports ${reported}`);
  await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
  const frame = win.frameLocator('.frame-box iframe');
  const pause = (ms) => win.waitForTimeout(ms);
  const escape = async (n = 1) => {
    for (let i = 0; i < n; i++) await win.keyboard.press('Escape'), await pause(150);
  };

  // macOS draws its traffic lights over the content at trafficLightPosition (16, 17): three 12px buttons, 20px apart,
  // whose centres land on the 28px controls' centre line (26px down), as a screenshot of the real window shows.
  const trafficLights = async () => {
    if (platform !== 'darwin') return;
    await win.evaluate(() => {
      if (document.getElementById('design-traffic-lights')) return;
      const box = document.createElement('div');
      box.id = 'design-traffic-lights';
      box.style.cssText = 'position:fixed;left:16px;top:20px;z-index:2147483647;display:flex;gap:8px;pointer-events:none';
      for (const [fill, edge] of [['#ff5f57', '#e0443e'], ['#febc2e', '#dea123'], ['#28c840', '#1aab29']]) {
        const dot = document.createElement('span');
        dot.style.cssText = `width:12px;height:12px;border-radius:50%;background:${fill};box-shadow:inset 0 0 0 0.5px ${edge}`;
        box.append(dot);
      }
      document.body.append(box);
    });
  };

  // Windows draws its caption buttons over the bar's right end (the window controls overlay, src/shared/window-chrome.ts):
  // three 46px buttons the bar's height, in its --panel and --text, which a capture of the page does not include either.
  const captionButtons = async (theme) => {
    if (platform !== 'win32') return;
    await win.evaluate((dark) => {
      document.getElementById('design-caption-buttons')?.remove();
      const box = document.createElement('div');
      box.id = 'design-caption-buttons';
      const ink = dark ? '#e7ecf4' : '#1c2742';
      box.style.cssText = `position:fixed;right:0;top:0;z-index:2147483647;display:flex;pointer-events:none;background:${dark ? '#171c25' : '#f4f6f9'};color:${ink}`;
      const glyphs = ['<path d="M5 10.5h10" />', '<rect x="5.5" y="5.5" width="9" height="9" rx="1" />', '<path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />'];
      for (const g of glyphs) {
        const b = document.createElement('span');
        b.style.cssText = 'width:46px;height:52px;display:grid;place-items:center';
        b.innerHTML = `<svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2">${g}</svg>`;
        box.append(b);
      }
      document.body.append(box);
    }, theme === 'dark');
  };

  async function setTheme(theme) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(250);
  }

  async function region(area) {
    const vp = win.viewportSize();
    const b = await win.locator('.toolbar').first().boundingBox();
    if (!b) throw new Error('the toolbar has no box');
    const bottom = Math.ceil(b.y + b.height + 1);
    if (area === 'toolbar') return { x: 0, y: 0, width: vp.width, height: bottom };
    // The interface zoomed in: the toolbar's CSS box, in the window's pixels.
    if (area === 'toolbar-zoomed') return { x: 0, y: 0, width: vp.width, height: Math.ceil(bottom * 1.25) };
    // The start of the bar, at a size where the mark and its neighbours can be judged.
    if (area === 'start') return { x: 0, y: 0, width: Math.min(560, vp.width), height: bottom };
    if (area === 'end') return { x: vp.width - 560, y: 0, width: 560, height: bottom };
    if (area === 'top-left') return { x: 0, y: 0, width: 560, height: 420 };
    if (area === 'window') return undefined;
    throw new Error(`unknown area ${area}`);
  }

  async function shot(state, check, { themes = ['light', 'dark'], area = 'toolbar', keepPointer = false } = {}) {
    for (const theme of themes) {
      await setTheme(theme);
      await trafficLights();
      await captionButtons(theme);
      if (!keepPointer) await win.mouse.move(24, win.viewportSize().height - 60);
      await pause(150);
      const visible = await win.locator(check).first().isVisible().catch(() => false);
      if (!visible) throw new Error(`${tag} state "${state}" (${theme}) did not render "${check}"; refusing to write`);
      const path = join(OUT, `${tag}-${state}--${theme}.png`);
      await capture(path, await region(area));
      written.push(path);
      console.log('wrote', path);
    }
    await setTheme('light');
  }

  const openRail = async (name, open = true) => {
    const b = win.locator(`.rail [aria-label="${name}"]`);
    if (((await b.getAttribute('aria-pressed')) === 'true') !== open) await b.click();
    await pause(250);
  };

  const sites = join(WORK, 'sites');
  await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
  await win.waitForSelector('.editor');
  await frame.locator('h1').first().waitFor({ timeout: 120000 });
  await pause(1500);
  await openRail('Pages');

  // At rest: Pages open, both panels showing, everything saved.
  await shot('rest', '.save-state.saved');
  await shot('rest-start', '.save-state.saved', { area: 'start' });
  await shot('rest-end', '.export-btn', { themes: ['light'], area: 'end' });

  // Zoom at its widest label.
  await win.locator('.zoom-btn').click();
  await win.getByRole('menuitemradio', { name: '125%' }).click();
  await pause(600);
  await shot('zoom-125', '.zoom-btn >> text=125%', { themes: ['light'] });
  await win.locator('.zoom-btn').click();
  await win.getByRole('menuitemradio', { name: /Fit/ }).click();
  await pause(600);

  // The home button hovered, then focused from the keyboard.
  await win.locator('.toolbar-mark').hover();
  await pause(250);
  await shot('mark-hover', '.toolbar-mark:hover', { themes: ['light', 'dark'], area: 'start', keepPointer: true });
  await win.mouse.move(24, H - 60);
  await win.locator('.toolbar [aria-label="Sidebar"]').focus();
  await win.keyboard.press('Shift+Tab');
  await pause(200);
  await shot('mark-focus', '.toolbar-mark:focus-visible', { themes: ['light'], area: 'start' });
  await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());

  // The AI waiting on the author: the loudest state the start of the bar carries.
  const run = { runId: 'r_tb', conversationId: 'c_tb', kind: 'status' };
  const emit = async (e) => {
    await app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('ai:event', ev), e);
    await pause(200);
  };
  await emit({ ...run, status: 'awaiting-input' });
  await shot('ai-asking', '.save-state.ask', { themes: ['light'] });
  await emit({ ...run, status: 'cancelled' });
  await pause(500);

  // The page switcher open.
  await win.locator('.project-title').click();
  await pause(300);
  await shot('page-menu', '.menu', { themes: ['light'], area: 'top-left' });
  await escape();

  // Both side panels hidden: every toggle at rest.
  await openRail('Pages', false);
  await win.locator('.toolbar [aria-label="Right panel"]').click();
  await pause(600);
  await shot('panels-closed', '.toolbar', { themes: ['light'] });
  await win.locator('.toolbar [aria-label="Right panel"]').click();
  await openRail('Pages');
  await pause(400);

  // Narrower windows: 1280 (compact on every platform) and the 1100px minimum.
  for (const width of [1280, 1100]) {
    await size(width, 800);
    await pause(800);
    await shot(`w${width}`, '.toolbar', { themes: width === 1280 ? ['light', 'dark'] : ['light'] });
  }
  // The smallest window with the interface zoomed in (View › Zoom In): the overflow toolbar, wrapped onto rows.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25));
  await pause(900);
  await shot('ui-zoom-1100', '.toolbar[data-tier="overflow"]', { themes: ['light'], area: 'toolbar-zoomed' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  await size(W, H);
  await pause(600);

  // A long project name in the smallest window.
  await win.evaluate(() => window.builder.projects.close());
  await win.waitForSelector('.welcome');
  await win.evaluate((dir) => window.builder.projects.create({ name: 'Kōwhai Garden Supplies & Landscaping Co-operative', parentDir: dir, starter: 'blank', sampleImages: false }), sites);
  await win.waitForSelector('.editor');
  await frame.locator('body *').first().waitFor({ timeout: 120000 });
  await size(1100, 800);
  await pause(1500);
  await shot('long-name-1100', '.project-title', { themes: ['light'] });

  await app.close();
  rmSync(WORK, { recursive: true, force: true });
  if (errors.length) console.log(`${tag} page errors:\n` + errors.join('\n'));
}

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`toolbar platforms capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
