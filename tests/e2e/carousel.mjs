// The Carousel section (#381) against the real app and its exported website. It is inserted from Insert > Media, and a
// slide opened in the inspector is brought into view in its list on the canvas, at desktop and phone widths. The
// exported site is then used at a 1280px desktop and a 390px phone: stepped by its Previous and Next buttons and by the
// keyboard, scrolled by trackpad and swiped by touch, at once for a visitor who asks for reduced motion, printed as a
// stack and read without JavaScript, never wider than the page. The website is opened in a headless browser.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('carousel');
const { app, win, errors } = await launch(WORK);
let browser;
try {
  const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
  const snapshot = async () => (await win.evaluate(() => window.builder.project.snapshot())).state;
  const apply = async (operations, label) => {
    const r = await win.evaluate(([operations, label]) => window.builder.project.apply({ operations }, { label }), [operations, label]);
    assert.equal(r.ok, true, `${label}: ${r.error?.message}`);
    return r.results;
  };

  step('Insert > Media offers the Carousel, and it is placed on Home');
  const s0 = await snapshot();
  const home = s0.site.homePageId;
  const about = Object.values(s0.pages).find((p) => p.route === '/about/').id;
  const carouselsOn = (s) => Object.values(s.pages[home].nodes).filter((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === 'media.carousel');
  await win.getByRole('button', { name: 'Insert', exact: true }).click();
  const media = win.locator('.side-panel-view:not([hidden]) .insert-group[data-kind="section"]', { has: win.locator('.insert-head', { hasText: /^Media$/ }) });
  await media.locator('.insert-tile.section', { has: win.locator('strong', { hasText: /^Carousel$/ }) }).click();
  await eventually(async () => assert.equal(carouselsOn(await snapshot()).length, 1, 'one Carousel is on Home'));
  const placed = carouselsOn(await snapshot())[0];
  assert.deepEqual(placed.props.slides, [], 'it starts with no slides');

  const owner = { kind: 'page', id: home };
  // The starter's sample photos.
  const photos = Object.values(s0.assets.assets).filter((a) => a.kind === 'image' && /\.(jpe?g|webp|png)$/i.test(a.file));
  assert.ok(photos.length >= 5, `the starter has five photos (${photos.length})`);
  const SLIDES = photos.slice(0, 5).map((a, i) => ({
    id: `s${i + 1}`,
    image: { assetId: a.id, alt: `Photo ${i + 1}` },
    caption: `Slide ${i + 1}`,
    link: i === 1 ? { type: 'page', target: about } : { type: 'none', target: '' }
  }));
  await apply(
    [
      { type: 'instance.setProp', owner, nodeId: placed.id, prop: 'heading', value: 'Three at a time' },
      { type: 'instance.setProp', owner, nodeId: placed.id, prop: 'slides', value: SLIDES }
    ],
    'Carousel slides'
  );
  // Two more, showing two and one slide at a time on a desktop.
  for (const [layout, heading] of [
    ['two-columns', 'Two at a time'],
    ['one-column', 'One at a time']
  ]) {
    const [{ nodeId }] = await apply([{ type: 'node.insert', owner, componentId: 'media.carousel', index: 1, props: { heading, slides: SLIDES } }], heading);
    await apply([{ type: 'instance.setVariant', owner, nodeId, axis: 'layout', variant: layout }], `${heading} layout`);
  }

  // The shipped Carousel is code. The inspector's list reveal edits a managed design, so exercise that editor
  // behavior with a small scrollable list while keeping the shipped Carousel for the exported visitor checks.
  const [{ definitionId: editableDef }] = await apply([{ type: 'component.upsert', name: 'Editable carousel',
    properties: { slides: { type: 'list', label: 'Slides', itemLabel: 'Slide', fields: { caption: { type: 'string', label: 'Caption', default: '' } },
      default: SLIDES.map(({ id, caption }) => ({ id, caption })) } },
    nodes: [{ kind: 'element', id: 'root', tag: 'section', children: ['heading', 'track'] },
      { kind: 'text', id: 'heading', tag: 'h2', text: 'Editable slides' },
      { kind: 'element', id: 'track', tag: 'ul', styles: { base: { customCss: 'display:flex;overflow-x:auto;overflow-y:hidden;width:min(100%, 600px);' } }, children: ['repeat'] },
      { kind: 'repeat', id: 'repeat', list: 'slides', children: ['slide'] },
      { kind: 'element', id: 'slide', tag: 'li', styles: { base: { customCss: 'flex:0 0 240px;min-height:120px;padding:16px;' } }, children: ['caption'] },
      { kind: 'text', id: 'caption', tag: 'p', text: { $item: 'caption' } }] }], 'Make editable carousel');
  const [{ nodeId: editable }] = await apply([{ type: 'node.insert', owner, parentId: null, definitionId: editableDef }], 'Place editable carousel');

  step('opening a slide in the inspector brings it into view in its list on the canvas');
  const track = frame.locator(`[data-so-ctx="page:${home}|${editable}"][data-so-node="track"]`);
  await track.waitFor({ timeout: 30000 });
  const slideShows = (id) =>
    track.evaluate((ul, index) => {
      const li = ul.querySelectorAll('li')[index];
      const r = li.getBoundingClientRect();
      const t = ul.getBoundingClientRect();
      return { scrollLeft: ul.scrollLeft, inList: r.left >= t.left - 1 && r.right <= t.right + 1, inFrame: r.top >= 0 && r.bottom <= innerHeight };
    }, SLIDES.findIndex((slide) => slide.id === id));
  await eventually(async () => {
    const initial = await slideShows('s5');
    assert.equal(initial.scrollLeft, 0, 'the track starts at its first slide');
    assert.equal(initial.inList, false, 'the fifth slide starts out of sight');
  });
  await win.locator('.rail [aria-label="Layers"]').click();
  await win.locator(`[role="tree"] .list-item[data-node="${editable}"]`).click();
  const list = win.locator('#dock-panel-inspect [data-list="slides"]');
  await list.waitFor();
  const rows = list.locator('.list-editor-head button.title');
  await eventually(async () => assert.equal(await rows.count(), 5, 'the inspector lists the five slides'));
  await rows.nth(4).click();
  await eventually(async () => {
    const now = await slideShows('s5');
    assert.ok(now.inList && now.inFrame, `the fifth slide shows in its list and in the frame (${JSON.stringify(now)})`);
  }, 15000);
  assert.ok((await slideShows('s5')).scrollLeft > 0, 'its list scrolled sideways to it');
  // Its caption shows on the canvas as it is typed.
  const caption = list.locator('.list-editor-body:not([hidden])').getByLabel('Caption', { exact: true });
  await caption.click();
  await caption.fill('Fitting day');
  await eventually(async () => assert.equal(await track.locator('li').nth(4).locator('p').innerText(), 'Fitting day', 'the typed caption shows on the slide'));
  await caption.press('Escape');
  await eventually(async () => assert.equal(await track.locator('li').nth(4).locator('p').innerText(), 'Slide 5', 'Escape gives the slide its saved caption back'));
  await win.getByRole('radio', { name: 'Phone', exact: true }).click();
  await eventually(async () => assert.equal(await track.evaluate(() => innerWidth), 390, 'the canvas is a phone’s width'), 15000);
  await eventually(async () => assert.equal((await slideShows('s5')).inList, true, 'at phone width the fifth slide is brought back into its list'), 15000);
  await rows.nth(0).click();
  await eventually(async () => assert.equal((await slideShows('s1')).inList, true, 'opening the first slide scrolls its list back'), 15000);
  await win.getByRole('radio', { name: 'Desktop', exact: true }).click();

  step('export the source and the website');
  const exportsDir = join(WORK, 'exports');
  mkdirSync(exportsDir, { recursive: true });
  await app.evaluate(({ dialog }, parent) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] });
  }, exportsDir);
  const src = await withTimeout(win.evaluate(() => window.builder.project.exportSource()), 120000, 'Source export');
  assert.equal(src.ok, true, `source export succeeds: ${src.message}`);
  // The developer's copy carries the carousel helper and the code it imports, with nothing of the editor's.
  for (const file of ['Carousel.svelte', 'carousel.js']) {
    const code = readFileSync(join(src.path, 'src/lib/siteorigin/runtime', file), 'utf8');
    assert.ok(code.length > 0 && !/data-so-|__siteorigin/.test(code), `the source export carries a clean ${file}`);
  }
  const stat = await withTimeout(win.evaluate(() => window.builder.project.exportStatic()), 300000, 'Static export');
  assert.equal(stat.ok, true, `static export succeeds: ${stat.message} ${stat.warnings?.join(' ')}`);
  assert.ok(stat.previewUrl, 'the export starts a preview');
  const url = stat.previewUrl;

  browser = await chromium.launch({ headless: true });
  /** The carousel under this heading on the exported Home page. */
  const carouselOf = (page, heading) => page.locator('section', { has: page.getByRole('heading', { name: heading, exact: true }) }).locator('.so-carousel');
  /** Where the list is scrolled to, the slides showing whole, and whether the page is wider than the screen. */
  const where = (c) =>
    c.locator('ul').evaluate((ul) => {
      const t = ul.getBoundingClientRect();
      const slides = [...ul.children].map((li) => li.getBoundingClientRect());
      return {
        scrollLeft: ul.scrollLeft,
        showing: slides.map((r, i) => (r.left >= t.left - 1 && r.right <= t.right + 1 ? i + 1 : 0)).filter(Boolean),
        width: t.width,
        slide: slides[0].width,
        overflow: document.documentElement.scrollWidth - innerWidth
      };
    });

  for (const [label, viewport] of [
    ['desktop', { width: 1280, height: 900 }],
    ['phone', { width: 390, height: 844 }]
  ]) {
    step(`${label}: Previous, Next, the keyboard and ${label === 'phone' ? 'a swipe' : 'a trackpad'} move through the slides`);
    const context = await browser.newContext({ viewport, hasTouch: label === 'phone', isMobile: label === 'phone' });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    const c = carouselOf(page, 'Three at a time');
    await c.scrollIntoViewIfNeeded();
    const status = c.getByRole('status');
    const next = c.getByRole('button', { name: 'Next', exact: true });
    const prev = c.getByRole('button', { name: 'Previous', exact: true });
    // The buttons appear once the page's script has run.
    await next.waitFor({ timeout: 15000 });
    assert.equal(await c.locator('li').count(), 5, `${label}: five slides`);
    const perView = label === 'desktop' ? 3 : 1;
    const says = (first) => (perView === 1 ? `Slide ${first} of 5` : `Slides ${first}–${first + perView - 1} of 5`);
    await eventually(async () => assert.equal(await status.innerText(), says(1), `${label}: the count says which slides show`));
    assert.deepEqual((await where(c)).showing, [1, 2, 3].slice(0, perView), `${label}: the first slides show`);
    assert.ok((await where(c)).overflow <= 0, `${label}: the page is no wider than the screen`);
    await c.screenshot({ path: join(SHOTS, `carousel-${label}.png`) });
    assert.equal(await prev.getAttribute('aria-disabled'), 'true', `${label}: Previous does nothing at the start`);
    assert.equal(await next.getAttribute('aria-disabled'), 'false', `${label}: Next can move on`);

    // Next to the end, a slide at a time.
    const last = 5 - perView + 1;
    for (let first = 2; first <= last; first++) {
      await next.click();
      await eventually(async () => assert.equal(await status.innerText(), says(first), `${label}: Next shows slide ${first} first`));
      await eventually(async () => assert.equal((await where(c)).showing[0], first, `${label}: slide ${first} is the first showing whole`));
    }
    await eventually(async () => assert.equal(await next.getAttribute('aria-disabled'), 'true', `${label}: Next does nothing at the end`));
    assert.equal(await next.evaluate((b) => document.activeElement === b), true, `${label}: focus stays on Next at the end`);
    // Still a button that can be pressed (and keeps focus), only it goes nowhere.
    await next.click({ force: true });
    await page.waitForTimeout(300);
    assert.equal(await status.innerText(), says(last), `${label}: Next at the end leaves the slides where they are`);
    assert.ok((await where(c)).overflow <= 0, `${label}: the page is no wider than the screen after stepping`);
    await prev.click();
    await eventually(async () => assert.equal(await status.innerText(), says(last - 1), `${label}: Previous goes back a slide`));
    if (last - 1 >= 3) {
      // Two presses before the first step arrives move two slides.
      await prev.evaluate((b) => (b.click(), b.click()));
      await eventually(async () => assert.equal(await status.innerText(), says(last - 3), `${label}: two quick presses of Previous go back two slides`));
    }

    // The arrow keys, Home and End on the focused list.
    const ul = c.locator('ul');
    await ul.focus();
    await page.keyboard.press('Home');
    await eventually(async () => assert.equal(await status.innerText(), says(1), `${label}: Home goes to the first slide`));
    await page.keyboard.press('ArrowRight');
    await eventually(async () => assert.equal(await status.innerText(), says(2), `${label}: the right arrow steps forward`));
    await page.keyboard.press('End');
    await eventually(async () => assert.equal(await status.innerText(), says(last), `${label}: End goes to the end`));
    await page.keyboard.press('ArrowLeft');
    await eventually(async () => assert.equal(await status.innerText(), says(last - 1), `${label}: the left arrow steps back`));
    await page.keyboard.press('Home');
    await eventually(async () => assert.equal((await where(c)).scrollLeft, 0, `${label}: back at the start`));

    const box = await ul.boundingBox();
    if (label === 'desktop') {
      // A trackpad scrolls the list sideways, and it settles on a slide.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(450, 0);
      await eventually(async () => assert.ok((await where(c)).scrollLeft > 0, `${label}: a sideways trackpad scroll moves the list`));
      await eventually(async () => assert.match(await status.innerText(), /^Slides [2-3]–[4-5] of 5$/, `${label}: and the count follows (${await status.innerText()})`), 5000);
    } else {
      // A swipe to the left moves on a slide: a finger put down, moved, rested and lifted. Made of touch events, as
      // Chromium's synthesized touch scroll gesture never scrolls on Windows (the page gets pointer moves and no touch
      // moves). The finger rests before it lifts, as headless Chromium on Windows leaves a list a finger flicks where
      // the finger left it, never snapping it to a slide; one lifted at rest snaps on every platform.
      const cdp = await context.newCDPSession(page);
      const [x, y, dx] = [Math.round(box.x + box.width * 0.7), Math.round(box.y + box.height / 2), -Math.round(box.width * 0.6)];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 1; i <= 10; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + Math.round((dx * i) / 10), y }] });
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(200);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await eventually(async () => assert.equal(await status.innerText(), 'Slide 2 of 5', `${label}: a swipe shows the second slide`), 5000);
      await eventually(async () => assert.deepEqual((await where(c)).showing, [2], `${label}: and it settles on it`));
    }
    await ul.focus();
    await page.keyboard.press('Home');
    await eventually(async () => assert.equal((await where(c)).scrollLeft, 0, `${label}: back at the start`));

    // The widths: one slide and the edge of the next on a phone, as many as chosen on a desktop.
    for (const [heading, n] of [
      ['Three at a time', 3],
      ['Two at a time', 2],
      ['One at a time', 1]
    ]) {
      const w = await where(carouselOf(page, heading));
      const expected = label === 'phone' ? w.width * 0.85 : (w.width - (n - 1) * 24) / n;
      assert.ok(Math.abs(w.slide - expected) < 1.5, `${label}: ${heading} slides are ${expected}px wide (${w.slide})`);
    }

    // A slide with a destination is one link, which the keyboard follows.
    const link = c.locator('li').nth(1).locator('a');
    assert.match(await link.getAttribute('href'), /\/about\/$/, `${label}: the second slide links to About`);
    assert.match(await link.innerText(), /Slide 2/, `${label}: the link is named by its caption`);
    await link.focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/about\/$/);
    assert.deepEqual(pageErrors, [], `${label}: no errors on the page`);
    await context.close();
  }

  step('reduced motion: a step lands at once, asked at each step');
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    const c = carouselOf(page, 'Three at a time');
    await c.scrollIntoViewIfNeeded();
    await c.getByRole('button', { name: 'Next', exact: true }).waitFor({ timeout: 15000 });
    /** Presses Next and reads where the list is in the same moment, before any frame is drawn. */
    const stepNow = () => c.locator('ul').evaluate((ul) => {
      ul.parentElement.querySelector('.so-carousel__controls button:last-of-type').click();
      return ul.scrollLeft;
    });
    assert.equal(await stepNow(), 0, 'without the setting the step glides: nothing has moved yet');
    await eventually(async () => assert.equal(await c.getByRole('status').innerText(), 'Slides 2–4 of 5', 'and it arrives'));
    await c.locator('ul').evaluate((ul) => ul.scrollTo({ left: 0, behavior: 'instant' }));
    await eventually(async () => assert.equal(await c.getByRole('status').innerText(), 'Slides 1–3 of 5'));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const at = await stepNow();
    assert.ok(at > 0, `with reduced motion the list is already at the next slide (${at})`);
    await page.waitForTimeout(200);
    assert.equal((await where(c)).scrollLeft, at, 'and stays there');
    assert.deepEqual((await where(c)).showing, [2, 3, 4]);
    // The setting turned off again: the next step glides once more.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForTimeout(300);
    assert.equal(await stepNow(), at, 'without the setting again, the next step glides');
    await eventually(async () => assert.deepEqual((await where(c)).showing, [3, 4, 5], 'and arrives'));

    step('print: every slide, one below the other, and no buttons');
    await page.emulateMedia({ media: 'print' });
    const printed = await c.evaluate((el) => {
      const ul = el.querySelector('ul');
      const s = getComputedStyle(ul);
      const boxes = [...ul.children].map((li) => li.getBoundingClientRect());
      return {
        display: s.display,
        wrap: s.flexWrap,
        overflowX: s.overflowX,
        visible: [el, ul, ...ul.children].every((x) => getComputedStyle(x).visibility === 'visible' && x.getBoundingClientRect().height > 0),
        visibleControls: [...el.querySelectorAll('.so-carousel__controls')].filter((x) => x.getClientRects().length > 0).length,
        stacked: boxes.every((b, i) => i === 0 || (b.top >= boxes[i - 1].bottom - 1 && Math.abs(b.left - boxes[0].left) < 1)),
        full: boxes.every((b) => Math.abs(b.width - ul.getBoundingClientRect().width) < 1),
        overflow: document.documentElement.scrollWidth - innerWidth
      };
    });
    assert.deepEqual(printed, { display: 'flex', wrap: 'wrap', overflowX: 'visible', visible: true, visibleControls: 0, stacked: true, full: true, overflow: printed.overflow }, 'every slide prints, stacked, as wide as the column, without buttons');
    assert.ok(printed.overflow <= 0, 'and the printed page is no wider than the sheet');
    await context.close();
  }

  step('without JavaScript every slide is still reachable, and no buttons are offered');
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(url);
    const c = carouselOf(page, 'Three at a time');
    await c.scrollIntoViewIfNeeded();
    const ul = c.locator('ul');
    assert.equal(await c.locator('button').count(), 0, 'no buttons that could not work');
    assert.equal(await ul.getAttribute('tabindex'), '0', 'the list can be reached by keyboard');
    assert.equal(await ul.getAttribute('aria-label'), 'Three at a time', 'and is named by its heading');
    const lastShows = async () => {
      const [t, r] = await Promise.all([ul.boundingBox(), c.locator('li').last().boundingBox()]);
      return r.x >= t.x - 1 && r.x + r.width <= t.x + t.width + 1;
    };
    assert.equal(await lastShows(), false, 'the last slide starts out of sight');
    const box = await ul.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 8 && !(await lastShows()); i++) {
      await page.mouse.wheel(400, 0);
      await page.waitForTimeout(250);
    }
    assert.equal(await lastShows(), true, 'scrolling the list reaches the last slide');
    await context.close();
  }

  assert.deepEqual(errors, [], 'no uncaught errors in the editor');
  await browser.close();
  await app.close();
  cleanup();
  console.log('\ncarousel: passed');
} catch (e) {
  await browser?.close().catch(() => undefined);
  await app.close().catch(() => undefined);
  throw e;
}
