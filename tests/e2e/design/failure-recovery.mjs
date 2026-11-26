// Design capture for the failure and recovery screens: the in-window "editor stopped working" screen (RenderFailure),
// the two start-up failures (StartupFailure), and the native crash and error dialogs. Opt-in only, never part of
// `npm run test:e2e`, and it needs no build:
//
//   DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/failure-recovery.mjs
//
// The in-window screens are the real components and the app's real stylesheet, bundled with Vite and rendered in
// Chromium at an editor window's size, with a real error thrown from a real screen. The native dialogs cannot be
// captured headless (an automated launch answers them without drawing them), so they are drawn here as a macOS alert
// sheet would draw them, from the app's own wording and button order (editor-recovery.ts, main-errors.ts): their
// pixels are an approximation, their words and order are not. Each capture checks that its state is on screen and
// throws rather than write an image of anything else. Files are `{state}--{theme}.png`.
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('failure and recovery capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'failure-recovery');
mkdirSync(OUT, { recursive: true });
const BOTH = ['light', 'dark'];
const SITE = 'http://failure-recovery.test';
const src = (p) => JSON.stringify(resolve(p));

const ENTRY = `
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import ${src('src/renderer/src/styles/index.css')};
import * as failure from ${src('src/renderer/src/components/RenderFailure')};
import * as startup from ${src('src/renderer/src/components/StartupFailure')};
import { AppMark } from ${src('src/renderer/src/components/AppMark')};
import * as recovery from ${src('src/main/editor-recovery')};
import * as mainErrors from ${src('src/main/main-errors')};

window.builder = { app: { openExternal: async (url) => { window.opened = url; }, buildDetails: async () => 'SiteOrigin Builder 0.1.0', showThemesFolder: async () => {}, quit: async () => {} } };
window.__mods = { failure, startup, recovery, mainErrors, AppMark };
const root = createRoot(document.getElementById('root'));
window.renderNode = (node) => flushSync(() => root.render(node));
window.h = h;
let screens = 0;
function Screen({ error }) {
  if (error) throw error;
  return h('main', { id: 'screen' }, 'editor');
}
// A fresh boundary for every capture (a new key), so no failure is carried over from the one before.
window.failScreen = (error, closable) => {
  const props = { key: ++screens, onCloseProject: closable ? () => {} : undefined, reload: () => {} };
  window.renderNode(h(failure.RenderFailure, props, h(Screen, { error: null })));
  window.renderNode(h(failure.RenderFailure, props, h(Screen, { error })));
};
`;

const out = await build({
  configFile: false,
  logLevel: 'silent',
  plugins: [react(), { name: 'failure-recovery', enforce: 'pre', resolveId: (id) => (id === '\0entry' ? id : null), load: (id) => (id === '\0entry' ? ENTRY : null) }],
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@engine': resolve('src/engine'),
      '@catalogue': resolve('src/catalogue'),
      '@agent': resolve('src/agent'),
      '@runtime': resolve('src/runtime')
    }
  },
  define: { 'process.env.NODE_ENV': '"development"' },
  build: { write: false, minify: false, cssCodeSplit: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
});
const outputs = (Array.isArray(out) ? out[0] : out).output;
const script = outputs.find((o) => o.type === 'chunk')?.code;
const css = outputs.filter((o) => o.type === 'asset' && o.fileName.endsWith('.css')).map((o) => String(o.source)).join('\n');
if (!script || !css) throw new Error('The screens did not bundle');

// A macOS alert sheet, drawn over the window it belongs to: the app icon, the message in bold, the detail, then the
// buttons with the first (the default) on the trailing edge. Only for the native dialogs; never shipped.
const ALERT_CSS = `
  .mac-window { position: fixed; inset: 0; background: var(--bg); }
  .mac-window[data-blank] { background: #fff; }
  :root[data-appearance='dark'] .mac-window[data-blank] { background: #1e1e1e; }
  .mac-sheet { position: fixed; top: 0; left: 50%; transform: translateX(-50%); width: 260px; padding: 20px 16px 16px; border-radius: 0 0 12px 12px;
    background: #ececec; color: #000; font: 13px/1.35 -apple-system, 'SF Pro Text', system-ui, sans-serif; box-shadow: 0 10px 40px rgb(0 0 0 / .35), 0 0 0 .5px rgb(0 0 0 / .25);
    display: flex; flex-direction: column; align-items: center; text-align: center; gap: 0; -webkit-font-smoothing: antialiased; }
  .mac-sheet[data-float] { top: 22vh; border-radius: 12px; }
  :root[data-appearance='dark'] .mac-sheet { background: #323232; color: #fff; box-shadow: 0 10px 40px rgb(0 0 0 / .6), 0 0 0 .5px rgb(255 255 255 / .18); }
  .mac-icon { width: 64px; height: 64px; margin-bottom: 12px; position: relative; }
  .mac-icon .badge { position: absolute; right: -4px; bottom: -4px; width: 30px; height: 30px; }
  .mac-message { font-weight: 700; margin: 0 0 6px; }
  .mac-detail { font-size: 11px; margin: 0 0 16px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .mac-buttons { display: flex; gap: 8px; width: 100%; flex-direction: row-reverse; }
  .mac-buttons button { flex: 1; font: inherit; padding: 4px 8px; border-radius: 6px; border: 0; background: #fff; color: inherit; box-shadow: 0 .5px 1px rgb(0 0 0 / .3); }
  :root[data-appearance='dark'] .mac-buttons button { background: #5b5b5b; }
  .mac-buttons button[data-default], :root[data-appearance='dark'] .mac-buttons button[data-default] { background: #0a84ff; color: #fff; }
  .mac-titlebar { position: fixed; top: 0; left: 0; right: 0; height: 28px; background: #e8e8e8; border-bottom: 1px solid #d0d0d0; }
  :root[data-appearance='dark'] .mac-titlebar { background: #2b2b2b; border-color: #111; }
  .mac-window, .mac-sheet:not([data-float]) { top: 28px; }
  .mac-label { position: fixed; left: 12px; bottom: 10px; font: 11px/1.3 system-ui, sans-serif; color: #777; }
  :root[data-appearance='dark'] .mac-label { color: #aaa; }
`;
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style><style>${ALERT_CSS}</style></head><body><div id="root"></div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => {
  if (!/Cannot read properties of undefined|nodes|A test/.test(String(e))) errors.push(String(e));
});
await page.route(`${SITE}/**`, (route) =>
  route.request().url().endsWith('/app.js') ? route.fulfill({ contentType: 'text/javascript', body: script }) : route.fulfill({ contentType: 'text/html', body: PAGE.replace('</body>', '<script src="/app.js"></script></body>') })
);
await page.goto(`${SITE}/`);
await page.waitForFunction(() => !!window.__mods);
const written = [];

async function shot(state, check, themes, setup) {
  for (const theme of themes) {
    await page.evaluate((t) => {
      document.documentElement.dataset.appearance = t;
    }, theme);
    await page.evaluate(setup.fn, setup.arg);
    await page.waitForTimeout(120);
    const ok = await page.locator(check).first().isVisible().catch(() => false);
    if (!ok) throw new Error(`"${state}" (${theme}) did not render ${check}; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await page.screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
}

const TYPICAL = "Cannot read properties of undefined (reading 'nodes')";
const LONG = [
  "TypeError: Cannot read properties of undefined (reading 'nodes')",
  '    at LayersTree (layers/LayersTree.tsx:214:38)',
  '    at renderWithHooks (react-dom.development.js:15486:18)',
  '    at mountIndeterminateComponent (react-dom.development.js:20103:13)',
  '    at beginWork (react-dom.development.js:21626:16)',
  '    at HTMLUnknownElement.callCallback (react-dom.development.js:4164:14)',
  '    at Object.invokeGuardedCallbackDev (react-dom.development.js:4213:16)',
  '    at invokeGuardedCallback (react-dom.development.js:4277:31)',
  '    at beginWork$1 (react-dom.development.js:27490:7)',
  '    at performUnitOfWork (react-dom.development.js:26596:12)',
  '    at workLoopSync (react-dom.development.js:26505:5)',
  '    at renderRootSync (react-dom.development.js:26473:7)',
  '    at recoverFromConcurrentError (react-dom.development.js:25889:20)',
  '    at performSyncWorkOnRoot (react-dom.development.js:26135:20)',
  '    at flushSyncCallbacks (react-dom.development.js:12042:22)'
].join('\n');
const USER_DIR = '/Users/marama/Library/Application Support/SiteOrigin Builder/packs';
const REFUSED = [
  { dir: '/Applications/SiteOrigin Builder.app/Contents/Resources/resources/packs', reason: 'Missing from this installation of SiteOrigin Builder.' },
  { dir: '/Users/marama/Library/Application Support/SiteOrigin Builder/packs/harbour-editorial', packId: 'harbour-editorial', reason: 'pack.json is not valid JSON: Unexpected token } in JSON at position 412.' },
  { dir: '/Users/marama/Library/Application Support/SiteOrigin Builder/packs/kowhai-studio-landscaping-co-operative-2024', packId: 'kowhai-studio', reason: 'It needs SiteOrigin Builder 0.3 or later; this is 0.1.0.' }
];

const failScreen = { fn: ([m, c]) => window.failScreen(new Error(m), c) };
await shot('editor-failed', '.failure h1', BOTH, { ...failScreen, arg: [TYPICAL, true] });
await shot('editor-failed-no-project', '.failure h1', ['light'], { ...failScreen, arg: [TYPICAL, false] });
await shot('editor-failed-long-error', '.failure-detail >> text=flushSyncCallbacks', ['light', 'dark'], {
  // A real error, its stack its own (the first line is its message), as a failure in the editor throws it.
  fn: ([m]) => {
    const e = new TypeError(m.split('\n')[0].replace(/^TypeError: /, ''));
    e.stack = m;
    window.failScreen(e, true);
    document.querySelector('.failure-details')?.setAttribute('open', '');
  },
  arg: [LONG]
});
await shot('startup-no-themes', '.failure-themes', BOTH, { fn: ([r, u]) => window.renderNode(window.h(window.__mods.startup.NoThemes, { refused: r, userDir: u })), arg: [REFUSED, USER_DIR] });
// Only the built-in theme missing (no theme of the person's own): Quit is the one way on, so it is the filled button.
await shot('startup-no-themes-builtin-only', '.failure-themes', ['light'], { fn: ([r, u]) => window.renderNode(window.h(window.__mods.startup.NoThemes, { refused: r, userDir: u })), arg: [REFUSED.slice(0, 1), USER_DIR] });
// The tallest screen in a short window: it scrolls inside the window, and the way back stays reachable.
await page.setViewportSize({ width: 1024, height: 600 });
await shot('startup-no-themes-short-window', '.failure-themes', ['light'], { fn: ([r, u]) => window.renderNode(window.h(window.__mods.startup.NoThemes, { refused: r, userDir: u })), arg: [REFUSED, USER_DIR] });
await page.setViewportSize({ width: 1280, height: 800 });
await shot('startup-catalogue-failed', '.failure h1', BOTH, {
  fn: (m) => window.renderNode(window.h(window.__mods.startup.CatalogueFailed, { message: m })),
  arg: "Error invoking remote method 'app:catalogue': Error: No handler registered for 'app:catalogue'"
});

// The native dialogs, from the app's own wording.
const alertSetup = (kind) => ({
  fn: (k) => {
    const { recovery, mainErrors } = window.__mods;
    const h = window.h;
    let spec;
    let blank = true;
    let float = false;
    if (k === 'crash-project') spec = recovery.crashQuestion(true);
    else if (k === 'crash-welcome') spec = recovery.crashQuestion(false);
    else if (k === 'main-error') {
      // As Node reports a full disk: the message, and its code.
      const full = Object.assign(new Error("ENOSPC: no space left on device, write '/Users/marama/Sites/harbour-bakery/siteorigin/pages/home.json'"), { code: 'ENOSPC' });
      spec = mainErrors.mainErrorReport(full);
      blank = false;
    } else {
      const box = mainErrors.startupErrorReport(new Error("Cannot find module '@engine/validate'"));
      spec = { message: box.title, detail: box.content, buttons: ['OK'], defaultId: 0 };
      float = true;
    }
    const icon = h(window.__mods.AppMark, { size: 64, className: 'mac-icon' });
    window.renderNode(
      h('div', null,
        float ? null : h('div', { className: 'mac-titlebar' }),
        float ? null : h('div', { className: 'mac-window', 'data-blank': blank ? '' : undefined }, blank ? null : h('div', { style: { padding: 24, color: 'var(--text-2)' } }, '(the editor, still running underneath)')),
        h('div', { className: 'mac-sheet', role: 'alertdialog', 'data-float': float ? '' : undefined },
          icon,
          h('p', { className: 'mac-message' }, spec.message),
          spec.detail ? h('p', { className: 'mac-detail' }, spec.detail) : null,
          h('div', { className: 'mac-buttons' }, spec.buttons.map((b, i) => h('button', { key: b, 'data-default': i === spec.defaultId ? '' : undefined }, b)))
        ),
        h('div', { className: 'mac-label' }, 'Native dialog, drawn as a macOS alert from the app’s own wording and button order (approximate pixels).')
      )
    );
  },
  arg: kind
});
await shot('native-crash-project', '.mac-sheet', BOTH, alertSetup('crash-project'));
await shot('native-crash-welcome', '.mac-sheet', ['light'], alertSetup('crash-welcome'));
await shot('native-main-error', '.mac-sheet', BOTH, alertSetup('main-error'));
await shot('native-startup-error', '.mac-sheet', ['light'], alertSetup('startup-error'));

await browser.close();
if (errors.length) throw new Error(`The page reported errors:\n${errors.join('\n')}`);
const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
const missing = written.filter((p) => !files.includes(p.split('/').pop()));
if (missing.length) throw new Error(`Not written: ${missing.join(', ')}`);
console.log(`failure and recovery capture: ${written.length} images in ${OUT}`);
