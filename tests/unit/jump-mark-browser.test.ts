/**
 * Site Styles' jump links mark one section at a time (issue #1142). A click on a short section near the end (Yours)
 * left the scroll marking the section above it, while the pointer still over the clicked link gave that one the same
 * accent fill, so two links read as current.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nextMark, sectionAtLine, startMark, type JumpEvent, type JumpMark } from '../../src/renderer/src/lib/jump-mark';

const COUNT = 6;
// Six sections in a view 900 tall with its reading line at 300; Yours (4) is short and sits near the end, so no scroll
// brings it to the line: at the end of the scroll (1250) Layout owns the line and the end marks Site.
const TOPS = [0, 400, 900, 1500, 1600, 1700];
const BOTTOMS = [400, 900, 1500, 1600, 1700, 2150];
const scrollTo = (scroll: number, atEnd = false): JumpEvent => ({
  type: 'scroll',
  tops: TOPS.map((t) => t - scroll),
  bottoms: BOTTOMS.map((b) => b - scroll),
  line: 300,
  viewTop: 0,
  viewBottom: 900,
  atEnd,
  count: COUNT
});
const run = (events: JumpEvent[], from: JumpMark = startMark) => events.reduce(nextMark, from);
const tops = (scroll: number) => TOPS.map((t) => t - scroll);

describe('the jump links mark', () => {
  it('the section that owns the reading line, from the moment its top reaches it, and the last one at the end', () => {
    expect(sectionAtLine(tops(0), 300, false, COUNT)).toBe(0);
    expect(sectionAtLine(tops(100), 300, false, COUNT)).toBe(1);
    expect(sectionAtLine(tops(99), 300, false, COUNT)).toBe(0);
    expect(sectionAtLine(tops(700), 300, false, COUNT)).toBe(2);
    expect(sectionAtLine(tops(1250), 300, true, COUNT)).toBe(5);
    expect(sectionAtLine([], 300, false, 0)).toBe(0);
  });

  it('the clicked section on its way there and while it is in view, where the scroll alone would mark another', () => {
    // Yours clicked: the smooth scroll passes Colors and Text, brings Yours into view and comes to rest at the end.
    const steps = [scrollTo(300), scrollTo(800), scrollTo(1250, true)];
    let mark = run([scrollTo(0), { type: 'jump', index: 4 }]);
    expect(steps.map((e) => (mark = nextMark(mark, e)).here)).toEqual([4, 4, 4]);
  });

  it('by position again once something moves the clicked section out of view after it showed', () => {
    const landed = run([{ type: 'jump', index: 4 }, scrollTo(1250, true)]);
    expect(run([scrollTo(0)], landed)).toEqual({ here: 0, target: null, seen: false });
    // Not yet in view, it stays marked however far the scroll still has to go.
    expect(run([{ type: 'jump', index: 1 }, scrollTo(1250, true)]).here).toBe(1);
  });

  it('by position again the moment the author scrolls on their own, whichever link held the mark', () => {
    for (const index of [1, 4]) {
      for (const held of [run([{ type: 'jump', index }]), run([{ type: 'jump', index }, scrollTo(1250)])]) {
        expect(run([{ type: 'input' }, scrollTo(1240)], held).here).toBe(3);
        expect(run([{ type: 'input' }, scrollTo(0)], held).here).toBe(0);
      }
    }
  });

  it('a later click over an earlier one, held as the first was', () => {
    const mark = run([{ type: 'jump', index: 4 }, scrollTo(1250), { type: 'jump', index: 2 }, scrollTo(800), scrollTo(1250, true)]);
    expect(mark).toMatchObject({ here: 2, target: 2, seen: true });
  });

  it('every section a plain scroll passes, when no link was clicked', () => {
    let mark = startMark;
    const seen = [0, 100, 700, 1240, 700, 0].map((y) => (mark = nextMark(mark, scrollTo(y))).here);
    expect(seen).toEqual([0, 1, 2, 3, 2, 0]);
    expect(run([scrollTo(1250, true)]).here).toBe(5);
  });
});

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://jump-mark.test';
const css = [...['tokens.css', 'reset.css'].map((f) => resolve('src/renderer/src/styles', f)), resolve('src/renderer/src/panels/Inspector.css'), resolve('src/renderer/src/panels/SiteStyles.css')]
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');
const labels = ['Basics', 'Colors', 'Text', 'Layout', 'Yours', 'Site'];
const ids = ['basics', 'color', 'text', 'layout', 'custom', 'site'];
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

/** A Site Styles panel in small: the real hook and the real sections, three tall sections then three short ones. */
const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  `import { useJumpMark } from ${renderer('lib/use-jump-mark')};`,
  `import { Section, openSection } from ${renderer('components/ui')};`,
  `const JUMPS = ${JSON.stringify(labels.map((label, i) => ({ id: ids[i], label })))};`,
  'const HEIGHTS = [700, 700, 700, 60, 60, 60];',
  'const IDS = JUMPS.map((j) => j.id);',
  'function Panel() {',
  "  const { here, jump, panel } = useJumpMark(IDS, '.ss-head');",
  '  return h("div", { className: "panel-body ss", id: "box", style: { height: "400px", overflow: "auto" }, ...panel },',
  '    h("div", { className: "insp-head ss-head", style: { position: "sticky", top: 0, zIndex: 2, padding: "12px 14px", background: "white" } },',
  '      h("nav", { className: "insp-jump" }, JUMPS.map((j, i) => h("button", { key: j.id, id: "j" + i, "aria-current": here === i ? "location" : undefined, onClick: () => jump(i) }, j.label)))),',
  '    JUMPS.map((j, i) => h(Section, { key: j.id, id: j.id, title: j.label, remember: false }, h("div", { style: { height: HEIGHTS[i] + "px" } }, h("input", { id: "f" + i, "aria-label": j.label })))));',
  '}',
  "createRoot(document.getElementById('root')).render(h(Panel));",
  'window.openSection = openSection;'
].join('\n');

/** The preload bridge: every call answers nothing. */
const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: () => any('')
  });
  window.builder = any('');
`;

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'jump-mark',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The jump links did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('the jump links in a browser', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let page: Page;
  let errors: string[];

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true, executablePath: chromium.executablePath() })]);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);
  beforeEach(async () => {
    page = await (await browser.newContext({ viewport: { width: 400, height: 600 } })).newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>${css}</style><body><div id="root"></div><script>${BRIDGE}</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
    await page.locator('#j0').waitFor();
  });
  afterEach(async () => {
    await page.context().close();
    expect(errors).toEqual([]);
  });

  const marked = () => page.locator('[aria-current="location"]').allTextContents();
  /** Wait for the panel to come to rest: its scroll position unchanged across a few frames. */
  const settled = () =>
    page.evaluate(`new Promise((done) => {
      const box = document.getElementById('box');
      let last = -1, still = 0;
      const tick = () => {
        still = box.scrollTop === last ? still + 1 : 0;
        last = box.scrollTop;
        if (still >= 10) done();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })`);
  const scrollTop = () => page.evaluate<number>(`document.getElementById('box').scrollTop`);

  it('marks only the clicked section after its jump, though the scroll cannot bring it under the header', async () => {
    await page.click('#j4');
    await settled();
    expect(await marked()).toEqual(['Yours']);
    // The scroll is at its end, where position alone marks Site.
    expect(await page.evaluate(`(() => { const b = document.getElementById('box'); return b.scrollTop + b.clientHeight >= b.scrollHeight - 2; })()`)).toBe(true);
  });

  it('keeps the clicked section through a press in the header while the jump is still scrolling', async () => {
    await page.click('#j4');
    const head = await page.locator('.ss-head').boundingBox();
    await page.mouse.click(head!.x + head!.width - 4, head!.y + head!.height - 3);
    await settled();
    expect(await marked()).toEqual(['Yours']);
  });

  it('marks by position again once the author scrolls on their own, though the section is still in view', async () => {
    await page.click('#j4');
    await settled();
    const box = await page.locator('#box').boundingBox();
    await page.mouse.move(box!.x + 100, box!.y + 200);
    await page.mouse.wheel(0, -60);
    await settled();
    const [only] = await marked();
    expect(only).not.toBe('Yours');
    expect(await marked()).toHaveLength(1);
  });

  it('marks what a reveal from elsewhere brings into view, even one that only opens and focuses a field', async () => {
    await page.click('#j0');
    await settled();
    expect(await marked()).toEqual(['Basics']);
    await page.evaluate(`openSection('site', { scroll: false }); document.getElementById('f5').focus()`);
    await settled();
    expect(await marked()).toEqual(['Site']);
  });

  it('marks what a reveal from elsewhere lands on when the panel is already where it would scroll to', async () => {
    await page.click('#j4');
    await settled();
    const before = await scrollTop();
    await page.evaluate(`openSection('site')`);
    await settled();
    expect(await scrollTop()).toBe(before);
    expect(await marked()).toEqual(['Site']);
  });

  it('marks by position again when the panel is moved some other way after the jump, away from its section', async () => {
    await page.click('#j2');
    await settled();
    expect(await marked()).toEqual(['Text']);
    await page.evaluate(`document.getElementById('box').scrollTop = 0`);
    await settled();
    expect(await marked()).toEqual(['Basics']);
    // Focus moved in from outside the panel (Shift+Tab from the status bar) scrolls it with no key event of its own.
    await page.click('#j1');
    await settled();
    await page.evaluate(`document.getElementById('f5').focus()`);
    await settled();
    expect(await marked()).toEqual(['Site']);
  });

  it('marks only the clicked section when motion is reduced and the jump lands at once', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.click('#j4');
    await settled();
    expect(await marked()).toEqual(['Yours']);
  });

  it('marks by position again when the author scrolls by key from the heading the jump focused', async () => {
    await page.click('#j4');
    await settled();
    // The jump put focus on the section's heading, a button.
    expect(await page.evaluate(`document.activeElement.className`)).toContain('section-head');
    await page.keyboard.press('ArrowUp');
    await settled();
    const [only] = await marked();
    expect(only).not.toBe('Yours');
    expect(await marked()).toHaveLength(1);
  });

  it('keeps its mark through a reveal in another tab while it is hidden, and after it shows again', async () => {
    await page.click('#j4');
    await settled();
    const frames = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))))`;
    await page.evaluate(`document.getElementById('box').style.display = 'none'; openSection('elsewhere')`);
    await page.evaluate(frames);
    await page.evaluate(`document.getElementById('box').style.display = ''`);
    await page.evaluate(frames);
    expect(await marked()).toEqual(['Yours']);
    // Shown again, a measure (a resize, a stray scroll event) still finds the jump's section held.
    await page.evaluate(`document.getElementById('box').dispatchEvent(new Event('scroll'))`);
    expect(await marked()).toEqual(['Yours']);
  });

  it('marks what a reveal of its own section brings into view, though the reveal came while it was hidden', async () => {
    await page.click('#j4');
    await settled();
    // Another tab's link opens Site details here a few frames before this panel shows again.
    const frames = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))))`;
    await page.evaluate(`document.getElementById('box').style.display = 'none'; openSection('site')`);
    await page.evaluate(frames);
    await page.evaluate(`document.getElementById('box').style.display = ''`);
    await page.evaluate(frames);
    expect(await marked()).toEqual(['Site']);
  });

  const look = (id: string) =>
    page.evaluate<{ background: string; color: string; weight: string }>(
      `(() => { const s = getComputedStyle(document.getElementById(${JSON.stringify(id)})); return { background: s.backgroundColor, color: s.color, weight: s.fontWeight }; })()`
    );

  it('gives a hovered link a look of its own, apart from the current one', async () => {
    const current = await look('j0');
    const resting = await look('j4');
    // The current link is marked by a fill, the accent and weight, apart from one at rest.
    expect(current.background).not.toBe(resting.background);
    expect(current.color).not.toBe(resting.color);
    expect(current.weight).not.toBe(resting.weight);
    await page.hover('#j4');
    const hovered = await look('j4');
    expect(hovered.background).not.toBe(current.background);
    expect(hovered.color).not.toBe(current.color);
    expect(hovered.weight).not.toBe(current.weight);
    // Hover still answers the pointer.
    expect(hovered.background).not.toBe(resting.background);
  });

  it('keeps the current link marked while the pointer is over it', async () => {
    const before = await look('j0');
    await page.hover('#j0');
    expect(await look('j0')).toEqual(before);
  });
});
