// Design capture for the notices at the bottom of the window: status, success and error toasts with their action and
// Dismiss, edits held while the AI works (or changed elsewhere), and the offer to update labels after a page rename, alone
// and stacked, with a dialog open, above the Preview pill, and in the narrowest window. Opt-in only, never part of
// `npm run test:e2e`, and it needs no build:
//
//   DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/notices.mjs
//
// The notices are the real components (Toasts, HeldEditRow and RenameOffer) and the app's real stylesheet, bundled
// with Vite and rendered in Chromium. Every state goes through the real store: toasts through toast(), held edits and
// the rename offer through its state, with a project built from the business starter and renamed by the engine, so
// the offer lists exactly the labels it would in the app. The editor behind them is a stand-in (panels, the canvas
// and a website in it) so the notices are judged where they sit. Each capture checks that its state is on screen and
// throws rather than write an image of anything else. Files are `{state}--{theme}.png`.
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { build, createServer } from 'vite';
import react from '@vitejs/plugin-react';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('notices capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'notices');
mkdirSync(OUT, { recursive: true });
const BOTH = ['light', 'dark'];
const SITE = 'http://notices.test';
const src = (p) => JSON.stringify(resolve(p));

const ENTRY = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import ${src('src/renderer/src/styles/index.css')};
import ${src('src/renderer/src/panels/Canvas.css')};
import { getState, setState, toast } from ${src('src/renderer/src/store')};
import { Toasts, Modal } from ${src('src/renderer/src/components/ui')};
import { canvasFoot } from ${src('src/renderer/src/lib/canvas-foot')};

// The renderer's bridge, answered by nothing: no notice here calls the main process.
const quiet = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : quiet), apply: () => quiet });
window.builder = quiet;

const snap = (state, extra = {}) => ({ dir: '/x', state, revision: 5, history: { entries: [] }, diagnostics: [], runtime: {}, recoveryNotes: [], aiBusy: false, aiRunId: null, assetUsage: {}, missingAssets: [], conflicts: [], localState: {}, workspaceKey: 'w1', recentExports: [], ...extra });
const undoes = { entryId: 'e1', workspaceKey: 'w1', revision: 99 };
const heldBase = { key: 'k', workspace: 'w1', operations: [], base: [], seq: 1 };

const app = createRoot(document.getElementById('app'));
const notices = createRoot(document.getElementById('notices'));
// A fresh stack for every scene, so no notice the last one kept (an Undo it held back) takes a place in this one.
let scenes = 0;
window.scene = ({ toasts = [], held = [], rename = null, many = false, aiBusy = false, dialog = false, preview = false, darkSite = false }) => {
  const { s, pageId } = window.projects[many ? 'many' : 'one'];
  flushSync(() => app.render(h(Backdrop, { preview, dialog, darkSite })));
  flushSync(() => notices.render(h(Toasts, { key: ++scenes })));
  flushSync(() => {
    setState({ toasts: [], heldEdits: [], renameOffer: null, snapshot: snap(s, { aiBusy, aiRunId: aiBusy ? 'run-1' : null }) });
  });
  flushSync(() => {
    for (const t of toasts) toast(t.text, t.kind, t.undo ? { label: t.undo, run: () => {}, undoes } : undefined);
    setState({
      heldEdits: held.map((x, i) => ({ ...heldBase, id: i + 1, key: 'k' + i, ...x })),
      renameOffer: rename ? { opening: 'w1', pageId, from: 'Lookbook', to: 'Portfolio', revision: 5 } : null
    });
  });
};

function Backdrop({ preview, dialog, darkSite }) {
  return h('div', { className: 'stage' },
    h('div', { className: 'stage-bar' }, h('b', null, 'Harbour Lane Studio'), h('span', null, 'Home')),
    h('div', { className: 'stage-side' }, ['Home', 'About', 'Contact', 'Portfolio'].map((t) => h('div', { key: t, className: 'stage-row' }, t))),
    h('div', { className: 'stage-canvas' },
      h('div', { className: darkSite ? 'stage-site dark-site' : 'stage-site' },
        h('div', { className: 'site-nav' }, h('b', null, 'Harbour Lane'), h('span', null, 'Home  About  Contact  Lookbook')),
        h('div', { className: 'site-hero' }, h('h1', null, 'Spaces made for the way you live'), h('p', null, 'Kitchens, bathrooms and whole-home renovations across the harbour suburbs, designed and built by one team.'), h('span', { className: 'site-btn' }, 'Book a consultation')),
        h('div', { className: 'site-cards' }, [1, 2, 3].map((i) => h('div', { key: i, className: 'site-card' })))
      ),
      preview && h('div', { className: 'canvas-foot', ref: canvasFoot }, h('div', { className: 'preview-pill', role: 'group', 'aria-label': 'Preview' }, h('span', { className: 'pill-note' }, 'Previewing'), h('span', { className: 'pill-address' }, '/'), h('button', null, 'Back to editing')))
    ),
    h('div', { className: 'stage-insp' }, h('div', { className: 'stage-row' }, 'Inspector')),
    dialog && h(Modal, { title: 'Delete page', onClose: () => {}, footer: h('button', { className: 'btn btn-danger' }, 'Delete page') }, h('p', null, 'Delete “About” and its 6 sections? Links to it from the menus are removed too.'))
  );
}
`;

// The projects are built here, by the engine, as main builds them: the business starter with a page Lookbook in the
// header menu (and, for 'many', linked again and again from the footer), renamed Portfolio, which is what a rename in
// Pages leaves behind.
const alias = {
  '@shared': resolve('src/shared'),
  '@engine': resolve('src/engine'),
  '@catalogue': resolve('src/catalogue'),
  '@agent': resolve('src/agent'),
  '@runtime': resolve('src/runtime'),
  '@generator': resolve('src/generator')
};
const server = await createServer({ configFile: false, logLevel: 'silent', resolve: { alias }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { registerBuiltinPacks } = await server.ssrLoadModule(resolve('src/main/packs/build.ts'));
const { createStarterState } = await server.ssrLoadModule(resolve('src/catalogue/starters.ts'));
const { applyOperations } = await server.ssrLoadModule(resolve('src/engine/apply.ts'));
const { shellMenu } = await server.ssrLoadModule(resolve('src/engine/tree.ts'));
registerBuiltinPacks();
function renamed(many) {
  let s = createStarterState('business', 'Harbour Lane Studio', false);
  const r = applyOperations(s, [{ type: 'page.create', title: 'Lookbook', route: '/lookbook/', starter: 'intro', addToNavigation: true }]);
  s = r.state;
  const pageId = r.results[0].pageId;
  if (many) {
    const links = shellMenu(s, 'footer').node.props.links;
    for (let i = 0; i < 6; i++) links.push({ id: `extra-${i}`, label: 'Lookbook', link: { type: 'page', target: pageId } });
  }
  return { s: applyOperations(s, [{ type: 'page.update', pageId, title: 'Portfolio' }]).state, pageId };
}
const projects = { one: renamed(false), many: renamed(true) };
await server.close();

const out = await build({
  configFile: false,
  logLevel: 'silent',
  plugins: [react(), { name: 'notices', enforce: 'pre', resolveId: (id) => (id === '\0entry' ? id : null), load: (id) => (id === '\0entry' ? ENTRY : null) }],
  resolve: { alias },
  define: { 'process.env.NODE_ENV': '"development"' },
  build: { write: false, minify: false, cssCodeSplit: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
});
const outputs = (Array.isArray(out) ? out[0] : out).output;
const script = outputs.find((o) => o.type === 'chunk')?.code;
const css = outputs.filter((o) => o.type === 'asset' && o.fileName.endsWith('.css')).map((o) => String(o.source)).join('\n');
if (!script || !css) throw new Error('The notices did not bundle');

// The stand-in editor: a toolbar, the side panel, the canvas with a website in it, and the inspector, in the app's own
// tokens. Only the notices are real; this is what they sit over.
const STAGE_CSS = `
  html, body { margin: 0; height: 100%; }
  .stage { position: fixed; inset: 0; display: grid; grid-template: 48px 1fr / 280px 1fr 300px; background: var(--bg); color: var(--text); font: 13px/1.4 var(--font, system-ui); }
  .stage-bar { grid-column: 1 / -1; display: flex; gap: 16px; align-items: center; padding: 0 16px; border-bottom: 1px solid var(--border); background: var(--panel); }
  .stage-side, .stage-insp { background: var(--panel); padding: 12px; display: flex; flex-direction: column; gap: 4px; }
  .stage-side { border-right: 1px solid var(--border); } .stage-insp { border-left: 1px solid var(--border); }
  .stage-row { padding: 6px 8px; border-radius: 6px; color: var(--text-2); }
  .stage-canvas { position: relative; overflow: hidden; background: var(--canvas, var(--bg)); padding: 24px; }
  .stage-site { background: #fff; color: #1d1d1f; height: 100%; border-radius: 4px; box-shadow: 0 0 0 1px rgb(0 0 0 / .08); overflow: hidden; font-family: Georgia, serif; }
  .site-nav { display: flex; justify-content: space-between; padding: 18px 32px; font: 14px system-ui; word-spacing: 14px; }
  .site-hero { padding: 48px 32px; background: linear-gradient(135deg, #f1ebe2, #e3d6c4); }
  .site-hero h1 { margin: 0 0 12px; font-size: 40px; line-height: 1.1; max-width: 560px; }
  .site-hero p { margin: 0 0 20px; max-width: 520px; font: 16px/1.5 system-ui; color: #4a4a4a; }
  .site-btn { display: inline-block; padding: 10px 18px; background: #2f4a3a; color: #fff; border-radius: 4px; font: 600 14px system-ui; }
  .site-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; padding: 28px 32px; }
  .dark-site, .dark-site .site-hero { background: #121826; color: #f3f4f6; } .dark-site .site-hero p { color: #c9ced8; } .dark-site .site-card { background: linear-gradient(160deg, #26324a, #0d1320); }
  .site-card { height: 220px; border-radius: 6px; background: linear-gradient(160deg, #c9b79c, #8a7a66); }
`;
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style><style>${STAGE_CSS}</style></head><body><div id="app"></div><div id="notices"></div></body></html>`;

// Scrollbars are drawn, as the app draws them (headless Chromium hides them by default).
const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.route(`${SITE}/**`, (route) =>
  route.request().url().endsWith('/app.js') ? route.fulfill({ contentType: 'text/javascript', body: script }) : route.fulfill({ contentType: 'text/html', body: PAGE.replace('</body>', '<script src="/app.js"></script></body>') })
);
await page.goto(`${SITE}/`);
await page.waitForFunction(() => !!window.scene);
await page.evaluate((p) => (window.projects = p), projects);
const written = [];

/** The bottom of the window around the stack, or the whole window. */
function region(area) {
  const vp = page.viewportSize();
  if (area === 'window') return undefined;
  const w = Math.min(vp.width, 820);
  const hgt = Math.min(vp.height, 560);
  return { x: Math.round((vp.width - w) / 2), y: vp.height - hgt, width: w, height: hgt };
}

async function shot(state, check, scene, { themes = BOTH, area = 'band', size = { width: 1440, height: 900 }, count, after } = {}) {
  await page.setViewportSize(size);
  for (const theme of themes) {
    await page.evaluate((t) => (document.documentElement.dataset.appearance = t), theme);
    await page.evaluate((s) => window.scene(s), scene);
    await page.mouse.move(4, 4);
    await page.waitForTimeout(260);
    if (after) await after(), await page.waitForTimeout(300);
    const ok = await page.locator(check).first().isVisible().catch(() => false);
    if (!ok) throw new Error(`"${state}" (${theme}) did not render ${check}; refusing to write`);
    if (count !== undefined) {
      const n = await page.locator('.toasts .toast').count();
      if (n !== count) throw new Error(`"${state}" (${theme}) shows ${n} notices, expected ${count}; refusing to write`);
    }
    const path = join(OUT, `${state}--${theme}.png`);
    await page.screenshot({ path, clip: region(area) });
    written.push(path);
    console.log('wrote', path);
  }
}

const deleted = { text: 'Deleted “Services grid” from Home.', kind: 'info', undo: 'Undo' };
const saved = { text: 'Saved a version: “Before the spring refresh”.', kind: 'success' };
const failed = { text: 'Could not export the site: the folder “/Users/sam/Sites/harbour-lane” is not writable. Choose another folder, or check its permissions in Finder.', kind: 'error' };
const longError = {
  text: 'The preview stopped: vite exited with code 1. src/routes/about/+page.svelte:14:3 Unexpected token. The generated page could not be compiled, so the canvas shows the last working version. Undo the last change, or open the code view to see the line. If it keeps happening, restart the preview from the canvas menu, which rebuilds every page from the project documents and clears the cache in .siteorigin/cache/dev.',
  kind: 'error'
};
const working = { label: 'Heading', place: 'Home · Hero', text: 'Spaces made for the way you live, and the way you will', phase: 'waiting' };
const notes = { label: 'Working notes', place: 'About · Our story', text: 'Started in 2009 with one van and a borrowed table saw.\nNow a team of twelve: designers, joiners, tilers and two electricians.\nEvery job has one project lead from first visit to handover.\nWe still answer the phone ourselves.\nMost of our work comes from neighbours of past clients.', phase: 'waiting' };
const elsewhere = { label: 'Button label', place: 'Contact · Form', text: 'Send my enquiry', phase: 'changed', cause: 'elsewhere', currentText: 'Send message' };

await shot('info-undo', '.toast.info', { toasts: [deleted] }, { count: 1 });
await shot('kinds', '.toast.error', { toasts: [saved, deleted, failed] }, { count: 3 });
await shot('error-long', '.toast.error', { toasts: [longError] }, { count: 1 });
await shot('held-working', '.toast.held', { held: [working, notes], aiBusy: true }, { count: 2 });
await shot('held-elsewhere', '.toast.held', { held: [elsewhere] }, { count: 1 });
await shot('rename-offer', '.toast.rename-offer', { rename: true }, { count: 1 });
await shot('rename-offer-many', '.toast.rename-offer', { rename: true, many: true }, { count: 1, area: 'window' });
await shot('full-stack', '.toast.rename-offer', { rename: true, held: [working], aiBusy: true, toasts: [deleted, failed] }, { area: 'window', count: 4 });
await shot('dialog-open', '.modal', { rename: true, held: [working], aiBusy: true, toasts: [deleted, failed], dialog: true }, { area: 'window' });
await shot('preview-pill', '.preview-pill', { toasts: [deleted], preview: true });
// Nothing ticked: Update is unavailable. Then keyboard focus on a held row's expected answer, and a notice over a dark website.
await shot('rename-none-ticked', '.rename-offer .btn-primary:disabled', { rename: true }, { count: 1, after: async () => { for (const box of await page.locator('.rename-offer input[type=checkbox]').all()) await box.uncheck(); } });
await shot('focus-answer', '.toast.held .btn-primary:focus-visible', { held: [elsewhere], toasts: [deleted] }, { count: 2, after: async () => { await page.locator('.toast.held').focus(); await page.keyboard.press('Tab'); await page.waitForTimeout(120); } });
await shot('over-dark-site', '.toast.info', { toasts: [deleted, failed], darkSite: true }, { count: 2 });
await shot('narrow', '.toast.rename-offer', { rename: true, held: [working], aiBusy: true, toasts: [deleted, failed], preview: true }, { area: 'window', size: { width: 1100, height: 700 }, count: 4 });

// More than fits: four kept edits, the offer and two notices in the smallest window. The stack stops short of the
// toolbar and scrolls.
const more = [working, notes, elsewhere, { ...working, label: 'Button label', place: 'Home · Hero', text: 'Book a visit' }];
await shot('crowded', '.toasts[data-crowded]', { rename: true, held: more, aiBusy: true, toasts: [deleted, failed], preview: true }, { area: 'window', size: { width: 1100, height: 700 } });

// At its top the crowded stack has nothing above it: no bar, and nothing flickering in and out.
{
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.evaluate((s) => window.scene(s), { rename: true, held: more, aiBusy: true, toasts: [deleted, failed], preview: true });
  await page.waitForTimeout(300);
  const flips = await page.evaluate(async () => {
    const stack = document.querySelector('.toasts');
    stack.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 200));
    let n = 0;
    const watch = new MutationObserver((records) => (n += records.filter((r) => [...r.addedNodes, ...r.removedNodes].some((x) => x.classList?.contains('notices-above'))).length));
    watch.observe(stack, { childList: true });
    await new Promise((r) => setTimeout(r, 600));
    watch.disconnect();
    return { n, shown: !!stack.querySelector('.notices-above') };
  });
  if (flips.n || flips.shown) throw new Error(`crowded stack at its top: the "more above" bar ${flips.shown ? 'shows' : 'flickers'} (${flips.n} changes)`);
}

await browser.close();
const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
for (const p of written) if (!files.includes(basename(p))) throw new Error(`missing ${p}`);
if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
console.log(`notices capture: ${written.length} images in ${OUT}`);
