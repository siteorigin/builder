// The Pages panel header (#556): Pages, Edit menu and Add page fit inside it, with their right padding intact, at the
// default sidebar width and every width down to the sidebar's minimum.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('pages-header');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business' });

const head = win.locator('.side-panel-view:not([hidden]) .pages-panel .panel-head');
await head.waitFor();

step('the header fits at the default width and down to the minimum');
for (const width of [260, 270, 280, 240, 233, 220, 200]) {
  const m = await win.evaluate((w) => {
    const panel = document.querySelector('.side-panel-view:not([hidden]) .pages-panel');
    const host = panel.parentElement;
    host.style.width = `${w}px`;
    host.style.flex = 'none';
    const h = panel.querySelector('.panel-head');
    const r = h.getBoundingClientRect();
    const add = panel.querySelector('.pages-head-add').getBoundingClientRect();
    const menu = panel.querySelector('.pages-head-menu').getBoundingClientRect();
    const title = h.querySelector('h3').getBoundingClientRect();
    return { scroll: h.scrollWidth, client: h.clientWidth, addRight: add.right, headRight: r.right, menuLeft: menu.left, addLeft: add.left, menuRight: menu.right, titleRight: title.right, menuW: menu.width };
  }, width);
  assert.ok(m.scroll <= m.client, `no horizontal overflow at ${width}px: ${JSON.stringify(m)}`);
  assert.ok(m.addRight <= m.headRight - 10 + 0.5, `Add page keeps its right padding at ${width}px: ${JSON.stringify(m)}`);
  assert.ok(m.menuW > 0 && m.menuRight <= m.addLeft + 0.5, `Edit menu is visible and clear of Add page at ${width}px`);
}

assert.deepEqual(errors, [], 'no renderer errors');
await app.close();
cleanup();
