// The editor in the real (hidden) window at its supported minimum, 1100×700: the toolbar fits without
// clipping its primary actions, the canvas keeps a usable width however the splitters are moved, and a
// larger window, or the project opened again, gives the panels back the widths they were given.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS: OUT, cleanup } = scratch('layout');
// No emulated viewport: the page follows the native window, so the sizes below are the window's own.
const { app, win, errors } = await launch(WORK, {}, { viewport: null });
const name = 'Field Notes Bookshop and Neighbourhood Reading Room';
await createProject(win, { name, parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
const dir = (await win.evaluate(() => window.builder.projects.recents())).find((r) => r.name === name).dir;

/** The narrowest the panels may leave the canvas (src/renderer/src/lib/layout.ts). */
const CANVAS_MIN = 440;

const title = 'Winter stock preview and seasonal reading list for members';
await win.evaluate((t) => window.builder.project.apply({ operations: [{ type: 'page.create', title: t }] }, { label: 'Add page' }), title);
await win.locator('.pages-list [role="option"]', { hasText: title }).click();
await eventually(async () => assert.match(await win.locator('.toolbar .project-title').innerText(), /Winter stock/, 'the long page is open'));

const toolbar = win.locator('.toolbar');
const button = (n) => toolbar.getByRole('button', { name: n, exact: typeof n === 'string' });

const layout = () =>
  win.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el || !el.checkVisibility()) return null;
      const b = el.getBoundingClientRect();
      return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width) };
    };
    // Every control in the toolbar that is shown must sit fully inside the window.
    const clipped = [...document.querySelectorAll('.toolbar button, .toolbar input')]
      .filter((el) => el.checkVisibility())
      .filter((el) => {
        const b = el.getBoundingClientRect();
        return b.left < 0 || b.right > innerWidth + 0.5;
      })
      .map((el) => el.getAttribute('aria-label') || el.textContent.trim());
    return {
      inner: innerWidth,
      height: innerHeight,
      doc: document.documentElement.scrollWidth,
      tier: document.querySelector('.toolbar')?.dataset.tier,
      clipped,
      title: r('.toolbar .project-title'),
      chevron: r('.toolbar .project-title .chev'),
      save: r('.toolbar .save-state'),
      center: r('.toolbar-center'),
      exportBtn: r('.toolbar .export-btn'),
      side: r('.side-panel'),
      dock: r('.dock'),
      canvas: r('.canvas'),
      frame: r('.frame-box iframe')
    };
  });

const frames = () => win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
/** Wait until the layout has settled: the resize event arrives at the next frame, and the preview re-fits
 *  a frame after that. */
const settled = async (width) => {
  await eventually(async () => {
    const before = await layout();
    await frames();
    assert.equal(before.inner, width);
    assert.deepEqual(await layout(), before);
  });
  return layout();
};
/** Size the native window's content area (what the editor gets), as dragging the window's corner would. */
const size = async (width, height) => {
  const content = await app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const b = BrowserWindow.getAllWindows()[0];
      b.setContentSize(w, h);
      const c = b.getContentBounds();
      return { width: c.width, height: c.height };
    },
    [width, height]
  );
  assert.deepEqual(content, { width, height }, `the window's content takes ${width}×${height}`);
  return settled(width);
};
/** Zoom the interface, as View › Zoom In does: the same window then has fewer CSS pixels. */
const zoomUi = async (factor, cssWidth) => {
  await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(f), factor);
  return settled(cssWidth);
};

/** The toolbar fits: nothing past the window edge, and the identity never runs into its neighbours. */
const assertToolbarFits = (l, where) => {
  assert.ok(l.doc <= l.inner, `${where}: the editor is no wider than the window (${l.doc}px in ${l.inner}px)`);
  assert.deepEqual(l.clipped, [], `${where}: no toolbar control runs past the window edge`);
  assert.ok(l.exportBtn && l.exportBtn.right <= l.inner, `${where}: Export is fully visible`);
  assert.ok(l.chevron.right <= l.title.right, `${where}: the page switcher's chevron stays inside it`);
  assert.ok(l.title.right <= l.save.left && l.save.right <= l.center.left, `${where}: the page switcher and save state stay clear of each other and of the centre controls`);
};

/** Drag a splitter by dx pixels in ten steps, the first a fast 10% of the way (over the preview frame). */
const drag = async (sel, dx) => {
  const b = await win.locator(sel).boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await win.mouse.move(x, y);
  await win.mouse.down();
  for (let i = 1; i <= 10; i++) await win.mouse.move(x + (dx * i) / 10, y);
  await win.mouse.up();
  assert.equal(await win.locator('.resizer.dragging').count(), 0, 'the drag has ended');
};
const panels = async () => {
  const l = await layout();
  return { side: l.side.width, dock: l.dock.width };
};
const press = async (sel, key, times = 1) => {
  await win.locator(sel).focus();
  for (let i = 0; i < times; i++) await win.keyboard.press(key);
};
const LEFT = '.side-panel .resizer';
const RIGHT = '.dock .resizer';

step('the native window stops at its declared 1100×700 minimum, and the toolbar fits there');
const smallest = await app.evaluate(({ BrowserWindow }) => {
  const b = BrowserWindow.getAllWindows()[0];
  b.setSize(900, 600);
  const c = b.getContentBounds();
  return { minimum: b.getMinimumSize(), size: b.getSize(), content: { width: c.width, height: c.height } };
});
assert.deepEqual(smallest.minimum, [1100, 700]);
assert.deepEqual(smallest.size, smallest.minimum, 'the window will not go smaller than its minimum');
// On macOS the content fills the window; a title bar elsewhere takes some of it.
assertToolbarFits(await settled(smallest.content.width), `the smallest window (${smallest.content.width}px of content)`);

step('toolbar at 1100×700 with long names and both panels open');
let l = await size(1100, 700);
await win.screenshot({ path: join(OUT, 'layout-1100.png') });
console.log(JSON.stringify(l));
assert.equal(l.height, 700);
assert.ok(l.side && l.dock, 'both panels are open');
assert.equal(l.tier, 'compact');
assertToolbarFits(l, '1100px');
for (const n of ['Sidebar', /^Undo/, /^Redo/, 'Right panel', 'Edit', 'Preview', 'Desktop', 'Tablet', 'Phone', 'Settings', 'Export']) assert.ok(await button(n).isVisible(), `${n} stays in the toolbar`);
assert.ok(await toolbar.locator('.zoom-btn').isVisible(), 'Zoom stays in the toolbar');
assert.equal(await button('More').count(), 0, 'nothing needs a More menu yet');
assert.equal(await button('Edit').innerText(), '', 'Edit shows its icon only');
assert.equal(await button('Preview').innerText(), '', 'Preview shows its icon only');
await button('Preview').click();
await eventually(async () => assert.equal(await button('Preview').getAttribute('aria-pressed'), 'true', 'the icon-only Preview button works'));
await button('Edit').click();
await eventually(async () => assert.equal(await button('Edit').getAttribute('aria-pressed'), 'true', 'the icon-only Edit button works'));

step('the same with a file conflict notice, the widest save state');
const pageFile = join(dir, 'src', 'routes', '+page.svelte');
appendFileSync(pageFile, '\n<!-- edited outside the app -->\n');
await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  await window.builder.project.apply({ operations: [{ type: 'page.update', pageId: s.state.site.homePageId, description: 'Second-hand and new books, open every day.' }] }, { label: 'Describe home' });
});
await button('File conflict').waitFor({ timeout: 15000 });
l = await layout();
await win.screenshot({ path: join(OUT, 'layout-1100-conflict.png') });
console.log(JSON.stringify(l));
assertToolbarFits(l, '1100px with a conflict');
assert.ok(l.title.width >= 140, `the page switcher keeps room for the names (${l.title.width}px)`);

step('a zoomed-in interface moves Zoom and Settings into a labelled More menu');
l = await zoomUi(1.1, 1000);
await win.screenshot({ path: join(OUT, 'layout-1100-zoom110.png') });
assert.equal(l.tier, 'overflow');
assertToolbarFits(l, '1100px at 110%');
assert.equal(await toolbar.locator('.zoom-btn').count(), 0, 'Zoom has left the toolbar');
assert.equal(await button('Settings').count(), 0, 'Settings has left the toolbar');
const more = button('More');
assert.equal(await more.getAttribute('aria-haspopup'), 'menu');
await more.focus();
await win.keyboard.press('Enter');
const menu = win.getByRole('menu', { name: 'More' });
await menu.waitFor();
// The open menu is modal, so the rest of the window (More included) is hidden from assistive technology.
assert.equal(await toolbar.getByRole('button', { name: 'More', exact: true, includeHidden: true }).getAttribute('aria-expanded'), 'true', 'More says its menu is open');
assert.deepEqual(await menu.getByRole('menuitemradio').allInnerTexts(), ['Fit to window', '50%', '75%', '100%', '125%'], 'the zoom choices are all there');
assert.equal(await menu.getByRole('menuitemradio', { name: 'Fit to window' }).getAttribute('aria-checked'), 'true', 'the current zoom is checked');
assert.equal(await menu.getByRole('menuitem', { name: 'Settings…' }).count(), 1, 'Settings is there');
await menu.getByRole('menuitemradio', { name: '125%' }).click();
await eventually(async () => assert.equal((await layout()).frame.width, 1600, 'choosing 125% zooms the preview'));
await more.click();
await win.getByRole('menuitemradio', { name: 'Fit to window' }).click();
await eventually(async () => {
  const x = await layout();
  assert.equal(x.frame.width, x.canvas.width - 56, 'Fit fits the preview to the canvas again');
});
await more.click();
await win.getByRole('menuitem', { name: 'Settings…' }).click();
await win.getByRole('dialog').waitFor();
await win.keyboard.press('Escape');
await win.getByRole('dialog').waitFor({ state: 'detached' });

step('a menu open from More closes when the toolbar widens, and focus moves to the control that took its place');
await more.focus();
await win.keyboard.press('Enter');
await menu.waitFor();
await eventually(async () => assert.ok(await win.evaluate(() => !!document.activeElement?.closest('[role="menu"]')), 'the keyboard is in the menu'));
l = await zoomUi(1, 1100);
assert.equal(l.tier, 'compact');
await eventually(async () => assert.equal(await win.getByRole('menu').count(), 0, 'the More menu closed with its button'));
await eventually(async () => assert.equal(await win.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Settings', 'focus moved from the menu to Settings'));
assert.equal(await button('Settings').getAttribute('aria-haspopup'), null, 'Settings is a plain button again');
await button('Settings').focus();
await zoomUi(1.1, 1000);
await eventually(async () => assert.equal(await win.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'More', 'focus moved from Settings to More'));
await zoomUi(1, 1100);
await eventually(async () => assert.equal(await win.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Settings', 'focus moved from More back to Settings'));

step('the page switcher stays open across a change of toolbar layout');
await toolbar.locator('.project-title').click();
const pages = win.getByRole('menu', { name });
await pages.waitFor();
l = await size(1280, 720);
assert.equal(l.tier, 'full');
assert.ok(await pages.isVisible(), 'the page switcher menu is still open');
await win.keyboard.press('Escape');
await pages.waitFor({ state: 'detached' });

step('the full toolbar comes back in a wider window');
assert.equal(l.tier, 'full');
assertToolbarFits(l, '1280px');
assert.equal(await button('Edit').innerText(), 'Edit', 'the Edit label is back');
assert.equal(await button('Preview').innerText(), 'Preview', 'the Preview label is back');
assert.ok((await toolbar.locator('.zoom-btn').isVisible()) && (await button('Settings').isVisible()), 'Zoom and Settings are back in the toolbar');
assert.equal(await button('More').count(), 0, 'More has gone');

step('splitters stop before the canvas gets too narrow');
l = await size(1100, 700);
assert.deepEqual(await panels(), { side: 260, dock: 340 }, 'the default widths fit the minimum window');
await press(LEFT, 'ArrowLeft');
assert.deepEqual(await panels(), { side: 244, dock: 340 }, 'an arrow key narrows the sidebar by 16px');
await press(LEFT, 'ArrowRight');
assert.deepEqual(await panels(), { side: 260, dock: 340 }, 'and widens it by 16px while there is room');
await drag(LEFT, 400);
assert.deepEqual(await panels(), { side: 272, dock: 340 }, 'the sidebar stops where the canvas reaches its minimum, and the dock keeps its width');
await drag(RIGHT, -400);
assert.deepEqual(await panels(), { side: 200, dock: 412 }, 'the dock may take the sidebar down to its minimum, and no further');
l = await layout();
await win.screenshot({ path: join(OUT, 'layout-1100-dragged.png') });
console.log(JSON.stringify(l));
assert.equal(l.canvas.width, CANVAS_MIN, 'the canvas keeps its minimum after both drags');
assert.equal(l.frame.width, CANVAS_MIN - 56, 'the desktop preview at Fit is 384px wide');
assert.ok(l.doc <= l.inner, 'the editor is still no wider than the window');

step('arrow keys stop at the same limits, and a step one way can be taken back');
await press(LEFT, 'ArrowRight', 5);
await press(RIGHT, 'ArrowLeft', 5);
assert.deepEqual(await panels(), { side: 200, dock: 412 }, 'neither panel grows past its limit');
for (const [sel, w] of [
  [LEFT, 200],
  [RIGHT, 412]
]) {
  assert.equal(Number(await win.locator(sel).getAttribute('aria-valuenow')), w, `${sel} reports the width it shows`);
  assert.equal(Number(await win.locator(sel).getAttribute('aria-valuemax')), w, `${sel} reports its limit`);
}
await press(RIGHT, 'ArrowRight');
assert.deepEqual(await panels(), { side: 216, dock: 396 }, 'narrowing the dock gives the sidebar its room back');
assert.equal(Number(await win.locator(RIGHT).getAttribute('aria-valuemax')), 412, 'the dock can still take the room back');
await press(RIGHT, 'ArrowLeft');
assert.deepEqual(await panels(), { side: 200, dock: 412 }, 'the step is taken back');

step('a wider window gives the panels their room back, and a narrow one takes it again');
await size(1440, 900);
assert.deepEqual(await panels(), { side: 272, dock: 412 }, 'the widths they were given');
await drag(LEFT, 400);
await drag(RIGHT, -400);
const wide = await panels();
assert.deepEqual(wide, { side: 392, dock: 560 }, 'both grow until the canvas reaches its minimum');
assert.equal((await layout()).canvas.width, CANVAS_MIN, 'the canvas keeps exactly its minimum');
l = await size(1100, 700);
console.log(JSON.stringify(l));
assert.deepEqual(await panels(), { side: 200, dock: 412 }, 'the sidebar gives way first, then the dock');
assert.equal(l.canvas.width, CANVAS_MIN, 'the canvas keeps its minimum in the narrow window');
assertToolbarFits(l, 'shrunk to 1100px');
await size(1440, 900);
assert.deepEqual(await panels(), wide, 'the panels return to the widths they were given');

step('the preview width and zoom are remembered wherever they are chosen, and the frame handles share the width field’s range');
const local = () => win.evaluate(async () => (await window.builder.project.snapshot()).localState);
const widthField = toolbar.locator('.width-input');
const rightEdge = win.getByRole('separator', { name: 'Preview width, right edge' });
const leftEdge = win.getByRole('separator', { name: 'Preview width, left edge' });
const frameWidth = async () => Number(await rightEdge.getAttribute('aria-valuenow'));
const remembered = (what, want) =>
  eventually(async () => {
    const saved = await local();
    for (const [key, value] of Object.entries(want)) assert.equal(saved[key], value, what);
  });
const setWidth = async (w) => {
  await widthField.fill(String(w));
  await widthField.press('Enter');
  await remembered(`the width field’s ${w}px is remembered`, { viewport: w });
};
/** Drag a frame handle `dx` CSS pixels sideways, as the author would. */
const dragHandle = async (handle, dx) => {
  const b = await handle.boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.move(x + dx / 2, y);
  await win.mouse.move(x + dx, y);
  await win.mouse.up();
};
assert.deepEqual([await rightEdge.getAttribute('aria-valuemin'), await rightEdge.getAttribute('aria-valuemax')], ['240', '2560'], 'the handles say the width field’s range');
/** How far the preview is scaled on screen, and the width a drag of `dx` on the right edge should give: the
 *  centered frame grows by twice the edge's movement, in the page's own pixels, within 240..2560. */
const scale = () => win.evaluate(() => document.querySelector('.frame-box').getBoundingClientRect().width / Number(document.querySelector('.width-input').value));
const expectDrag = async (from, dx) => Math.max(240, Math.min(2560, Math.round(from + (dx / (await scale())) * 2)));
const dragTo = async (from, dx, what) => {
  const want = await expectDrag(from, dx);
  await dragHandle(rightEdge, dx);
  const got = await frameWidth();
  assert.ok(Math.abs(got - want) <= 1, `${what}: ${got}px, expected ${want}px`);
  assert.equal(await win.locator('.frame-handle.dragging').count(), 0, `${what}: the drag has ended`);
  await remembered(`${what}: the width is remembered`, { viewport: got });
  return got;
};
await setWidth(2400);
let dragged = await dragTo(2400, -3, 'a short drag from 2400px narrows the frame from there, not to 1920px');
assert.ok(dragged > 1920, 'the drag kept the wide frame');
// Well past the handle (it holds the pointer) and the limit.
dragged = await dragTo(dragged, 60, 'a long drag outward stops at 2560px');
assert.equal(dragged, 2560);
await setWidth(280);
dragged = await dragTo(280, 3, 'a short drag from 280px widens the frame from there, not to 320px');
assert.ok(dragged < 320, 'the drag kept the narrow frame');
const keyStep = async (edge, key, want, what) => {
  await edge.focus();
  await win.keyboard.press(key);
  assert.equal(await frameWidth(), want, what);
  await eventually(async () => assert.equal(await widthField.inputValue(), String(want), `${what}: the width field shows it`));
  await remembered(`${what}: the width is remembered`, { viewport: want });
};
await keyStep(rightEdge, 'ArrowRight', dragged + 16, 'Right Arrow on the right edge widens the frame');
await keyStep(leftEdge, 'ArrowLeft', dragged + 32, 'Left Arrow on the left edge widens it too');
await keyStep(leftEdge, 'ArrowRight', dragged + 16, 'Right Arrow on the left edge narrows it');
await keyStep(rightEdge, 'ArrowLeft', dragged, 'Left Arrow on the right edge narrows it');
await setWidth(250);
await keyStep(leftEdge, 'ArrowRight', 240, 'the keyboard stops at the narrowest width');
await button('Phone').click();
assert.equal(await frameWidth(), 390, 'the toolbar’s Phone width');
await remembered('the toolbar’s Phone width is remembered', { viewport: 390 });
await win.keyboard.press(`${MOD}+K`);
await win.locator('.cmdk').waitFor();
await win.keyboard.type('Preview at tablet width');
await win.keyboard.press('Enter');
await win.locator('.cmdk').waitFor({ state: 'detached' });
assert.equal(await frameWidth(), 834, 'the command menu sets the tablet width');
await remembered('the command menu’s width is remembered', { viewport: 834 });
await toolbar.locator('.zoom-btn').click();
await win.getByRole('menuitemradio', { name: '75%' }).click();
await remembered('the zoom is remembered', { zoom: 0.75 });

step('the project opens again in a small window with its panels fitted, then restores them');
await press(RIGHT, 'ArrowRight');
assert.deepEqual(await panels(), { side: 408, dock: 544 }, 'a keyboard step just before closing');
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
const saved = JSON.parse(readFileSync(join(dir, '.siteorigin', 'workspace.json'), 'utf8'));
assert.deepEqual({ left: saved.leftWidth, right: saved.rightWidth }, { left: 420, right: 544 }, 'the widths were saved before the project closed');
await size(1100, 700);
const opened = await win.evaluate((d) => window.builder.projects.open(d), dir);
assert.ok(opened.ok, `the project opens again (${opened.message ?? ''})`);
await win.waitForSelector('.editor');
await win.frameLocator('.frame-box iframe').locator('body *').first().waitFor({ timeout: 90000 });
l = await settled(1100);
assert.ok(l.side && l.dock, 'both panels are open');
assert.deepEqual(await panels(), { side: 200, dock: 412 }, 'the saved widths are fitted to the small window');
assert.equal(l.canvas.width, CANVAS_MIN, 'the reopened canvas keeps its minimum');
assertToolbarFits(l, 'reopened at 1100px');
await eventually(async () => assert.equal(await widthField.inputValue(), '834', 'the reopened preview has the width it was given'));
assert.equal(await toolbar.locator('.zoom-btn').innerText(), '75%', 'and the zoom');
assert.ok(Math.abs((await win.locator('.frame-box').boundingBox()).width - 834 * 0.75) <= 1, 'the preview is drawn at 75%');
await toolbar.locator('.zoom-btn').click();
await win.getByRole('menuitemradio', { name: 'Fit to window' }).click();
await remembered('Fit is remembered', { zoom: 'fit' });

step('a drag ends when the layout changes under it, instead of jumping');
{
  // The sidebar is squeezed to 200 (it was given 420). Hiding the dock mid-drag gives it 420 back; the next
  // move must not drag it from the stale 200.
  const b = await win.locator(LEFT).boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.move(x - 5, y);
  await win.keyboard.press(`${MOD}+Shift+Backslash`);
  await eventually(async () => assert.equal((await layout()).dock, null, 'the dock is hidden'));
  await win.mouse.move(x - 4, y);
  await win.mouse.up();
  await eventually(async () => assert.equal((await layout()).side.width, 420, 'the sidebar keeps the width it was given'));
  assert.equal(await win.locator('.resizer.dragging').count(), 0, 'the drag has ended');
  await win.keyboard.press(`${MOD}+Shift+Backslash`);
  await eventually(async () => assert.deepEqual(await panels(), { side: 200, dock: 412 }, 'the dock is back'));
}
await size(1440, 900);
assert.deepEqual(await panels(), { side: 408, dock: 544 }, 'the saved widths come back in a larger window');
await win.screenshot({ path: join(OUT, 'layout-1440.png') });

step('a new project starts with the default widths, not the last project’s');
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
await createProject(win, { name: 'Second Shelf', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });
await settled(1440);
assert.deepEqual(await panels(), { side: 260, dock: 340 });
await eventually(async () => assert.equal(await widthField.inputValue(), '1280', 'the new project previews at the desktop width'));
assert.equal(await toolbar.locator('.zoom-btn').innerText(), 'Fit', 'and fits the preview to the window');

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nlayout: passed');
