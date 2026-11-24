// Acting on observed targets (tests/driver, issue #493), against the built app in an isolated session. Every step a
// person takes goes through the driver's public actions (ui.click, ui.fill, ui.type, ui.press, ui.select, ui.scroll,
// ui.hover, ui.drag) on refs and screenshot points that observations gave; checks read observations, the saved
// project and the generated source, and never act. From Welcome through a dialog (and back out of one with Escape)
// to a new project; inline text edited and committed in the preview, and the Inspector showing it; a section
// reordered by the canvas grip and back in Layers; a breakpoint and the preview frame resized; Undo and Redo from the
// keyboard; another page edited and both pages' preview and history checked. A stale ref, a stale screenshot point,
// a target under a dialog or covered by the canvas's chip, and an impossible gesture each fail with a reason, and
// change nothing.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { flatten, semanticSelector } from '../driver/observe.ts';
import { Session } from '../driver/session.ts';
import { eventually, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('actions');
const session = new Session({ parentDir: WORK });
let passed = false;
let n = 0;
const call = (op, args, extra = {}) => session.call({ v: 1, id: `a${++n}`, op, ...(args ? { args } : {}), ...extra });
const describe = (reply) => (reply.ok ? '' : `${reply.error.code} ${reply.error.message} ${JSON.stringify(reply.error.details ?? {})}`);
const ok = (reply, what) => {
  assert.equal(reply.ok, true, `${what}: ${describe(reply)}`);
  return reply.result;
};
const failed = (reply, code, what) => {
  assert.equal(reply.ok, false, `${what}: expected ${code}, got a result ${JSON.stringify(reply.result ?? null)}`);
  assert.equal(reply.error.code, code, `${what}: ${describe(reply)}`);
  return reply.error;
};
const snapshot = async (args = {}) => ok(await call('ui.snapshot', args), `ui.snapshot ${JSON.stringify(args)}`);
const find = async (args) => ok(await call('ui.locate', args), `ui.locate ${JSON.stringify(args)}`).node;
const act = async (op, args) => ok(await call(op, args), `${op} ${JSON.stringify(args)}`);
/** The element a search finds, once it is the same element twice in a row (a page that has stopped updating). */
const settled = (args) =>
  eventually(async () => {
    const a = await find(args);
    await new Promise((r) => setTimeout(r, 700));
    const b = await find(args);
    assert.equal(b.ref, a.ref, 'the same element both times');
    return b;
  }, 30000);
const click = async (target, extra = {}) => act('ui.click', { target: typeof target === 'string' ? { ref: target } : target, ...extra });
const press = (key, target) => act('ui.press', { key, ...(target ? { target: { ref: target } } : {}) });

// Read-only checks: the project as the app saved it, and the source it generated.
const saved = () => session.page.evaluate(() => window.builder.project.snapshot());
const applied = async () => (await saved()).history.entries.filter((e) => e.applied).length;
const pageOrder = async (page = 'home') => {
  const s = await saved();
  const p = Object.values(s.state.pages).find((x) => (page === 'home' ? x.id === s.state.site.homePageId : x.path === page));
  return p.rootIds.map((id) => s.state.components[p.nodes[id].definitionId]?.name);
};
const PROJECT = () => join(session.paths.workspace, 'harbour-lane-studio');
const source = (rel) => readFileSync(join(PROJECT(), rel), 'utf8');

const HEADING = 'Calm, considered spaces for everyday life';
const NEW_HEADING = 'Rooms that work beautifully';

try {
  await session.start({ fixture: 'welcome' });

  step('Welcome: a dialog opens from its button, keeps the focus, and Escape closes it with nothing made');
  const welcome = await snapshot({ scope: 'editor' });
  assert.equal(welcome.context.screen, 'welcome');
  const newProject = await find({ role: 'button', name: 'New project', scope: 'editor' });
  const opened = await click(newProject.ref);
  assert.equal(opened.dispatched, 'complete');
  assert.equal(opened.target.ref, newProject.ref, 'the reply says what was clicked');
  assert.ok(opened.target.point.x > 0 && opened.target.point.y > 0, 'and where');
  const dialog = await eventually(async () => {
    const c = (await snapshot({ scope: 'editor', maxNodes: 20 })).context;
    assert.equal(c.dialog?.name, 'New project');
    assert.equal(c.focus?.name, 'Project name', 'the dialog puts the focus in its first field');
    return c.dialog;
  });
  const workspaceBefore = readdirSync(session.paths.workspace).sort();
  await press('Shift+Tab');
  const back = (await snapshot({ scope: 'editor', maxNodes: 5 })).context;
  assert.notEqual(back.focus?.name, 'Project name', 'Shift+Tab moved the focus');
  assert.equal(back.dialog?.name, 'New project', 'and it stayed in the dialog');
  await press('Tab');
  assert.equal((await snapshot({ scope: 'editor', maxNodes: 5 })).context.focus?.name, 'Project name', 'Tab brought it back to the first field');
  await press('Escape');
  await eventually(async () => {
    const c = (await snapshot({ scope: 'editor', maxNodes: 20 })).context;
    assert.equal(c.dialog, null, 'Escape closed the dialog');
    assert.equal(c.screen, 'welcome');
  });
  failed(await call('ui.locate', { ref: dialog.ref }), 'STALE_REF', 'the closed dialog');
  assert.deepEqual(readdirSync(session.paths.workspace).sort(), workspaceBefore, 'nothing was created');

  step('the dialog again: name, starter and folder chosen through its controls, and the project created');
  await click(newProject.ref);
  const form = await eventually(async () => {
    const c = (await snapshot({ scope: 'editor', maxNodes: 20 })).context;
    assert.equal(c.dialog?.name, 'New project');
    return c.dialog;
  });
  // Fill replaces what a field holds; typing into it adds at the caret.
  const nameField = await find({ role: 'textbox', name: 'Project name', within: form.ref });
  await act('ui.fill', { target: { ref: nameField.ref }, text: 'A placeholder name' });
  await act('ui.fill', { target: { ref: nameField.ref }, text: 'Harbour Lane' });
  await act('ui.type', { target: { ref: nameField.ref }, text: ' Studio' });
  assert.equal((await find({ ref: nameField.ref })).value, 'Harbour Lane Studio', 'the name was replaced, then added to');
  // The starter: Blank, then Business, each click moving the choice.
  const blank = await find({ role: 'radio', name: 'Blank', exact: false, within: form.ref });
  const business = await find({ role: 'radio', name: 'Business', exact: false, within: form.ref });
  await click(blank.ref);
  await eventually(async () => assert.deepEqual([(await find({ ref: blank.ref })).checked, (await find({ ref: business.ref })).checked ?? false], [true, false], 'Blank is chosen'));
  await click(business.ref);
  await eventually(async () => assert.deepEqual([(await find({ ref: blank.ref })).checked ?? false, (await find({ ref: business.ref })).checked], [false, true], 'Business is chosen'));
  ok(await call('desktop.setAnswers', { answers: [{ dialog: 'open', title: 'Choose where to create the project', selection: 'folder', paths: ['workspace'] }] }), 'the folder chooser’s answer');
  await click((await find({ role: 'button', name: 'Choose…', within: form.ref })).ref);
  await eventually(async () => {
    const entries = ok(await call('desktop.events', { after: 0, limit: 1000 }), 'desktop.events').entries;
    assert.ok(entries.some((e) => e.type === 'chooser' && e.outcome === 'chosen'), 'the chooser was answered');
  });
  await click((await find({ role: 'button', name: 'Create project', within: form.ref })).ref);
  await eventually(
    async () => {
      const c = (await snapshot({ maxNodes: 20 })).context;
      assert.equal(c.screen, 'editor');
      assert.equal(c.preview.state, 'ready');
    },
    180000
  );
  assert.ok(existsSync(join(PROJECT(), 'siteorigin.project.json')), 'the project is in the chosen folder');
  assert.deepEqual((await pageOrder()).slice(0, 3), ['Split hero', 'Logo strip', 'Services grid']);

  step('inline text: the heading selected in two clicks, edited after a double click, typed over and committed');
  const heading = await find({ role: 'heading', name: HEADING, scope: 'preview' });
  const firstClick = await click(heading.ref);
  assert.equal(firstClick.target.surface, 'preview');
  assert.ok(firstClick.target.at && firstClick.target.point, 'a preview hit says where it was in the page and in the window');
  await eventually(async () => assert.equal((await snapshot({ maxNodes: 20 })).context.selection?.toolbar, 'Split hero actions', 'the first click selects the section'));
  await new Promise((r) => setTimeout(r, 700)); // Clear of a double click.
  await click(heading.ref);
  await eventually(async () => assert.deepEqual((await snapshot({ maxNodes: 20 })).context.selection?.refs, [heading.ref], 'the second click selects the heading'));
  const before = await applied();
  await new Promise((r) => setTimeout(r, 700));
  await click(heading.ref, { count: 2 });
  await eventually(async () => {
    await find({ role: 'toolbar', name: 'Editing heading', scope: 'editor' });
    assert.equal((await snapshot({ maxNodes: 20 })).context.focus?.scope, 'preview', 'the page has the focus');
  });
  await press('ControlOrMeta+a');
  const typed = await act('ui.type', { text: NEW_HEADING });
  assert.equal(typed.target.surface, 'preview', 'typing went into the page');
  await press('Enter');
  await eventually(async () => assert.ok(source('src/routes/+page.svelte').includes(NEW_HEADING), 'the new heading is written to the page source'), 30000);
  // The preview updates the page after the source is written: its heading is held once it stays the same element.
  const edited = await settled({ role: 'heading', name: NEW_HEADING, scope: 'preview' });
  assert.equal(await applied(), before + 1, 'one step of history');
  assert.match((await saved()).history.undoLabel ?? '', /./, 'Undo names it');
  failed(await call('ui.click', { target: { ref: heading.ref } }), 'STALE_REF', 'the heading’s old ref (its name changed)');

  step('the Inspector shows the committed text');
  const field = await eventually(async () => {
    const f = await find({ role: 'textbox', name: 'Heading', scope: 'editor' });
    assert.equal(f.value, NEW_HEADING, 'the Inspector’s Heading field has the new text');
    return f;
  });
  assert.ok(field.ref);

  step('hover, a right click that opens a menu and Escape out of it, and the wheel over the page: none moves the project');
  const steps = await applied();
  await act('ui.hover', { target: { ref: edited.ref } });
  await click(edited.ref, { button: 'right' });
  const menu = await eventually(async () => {
    const s = await snapshot({ scope: 'editor', maxNodes: 300 });
    const m = flatten(s.editor.nodes).find((x) => x.role === 'menu');
    assert.match(m?.name ?? '', /actions$/, 'a right click opens the actions menu');
    return m;
  });
  assert.ok(menu.ref);
  await press('Escape');
  await eventually(async () => assert.ok(!flatten((await snapshot({ scope: 'editor', maxNodes: 300 })).editor.nodes).some((x) => x.role === 'menu'), 'Escape closed the menu'));
  // Fields the open menu kept from being read are not taken for credentials: their text is still reported once it
  // closed, and refs to it still hold.
  assert.equal((await find({ role: 'textbox', name: 'Heading', scope: 'editor' })).value, NEW_HEADING, 'the Inspector’s text is still reported after the menu');
  const top = (await find({ ref: edited.ref })).box.y;
  const wheel = await act('ui.scroll', { target: { ref: edited.ref }, deltaY: 400 });
  assert.equal(wheel.target.surface, 'preview');
  const scrolled = await eventually(async () => {
    const y = (await find({ role: 'heading', name: NEW_HEADING, scope: 'preview' })).box.y;
    assert.ok(y < top - 100, `the page scrolled under the wheel (${top} → ${y})`);
    return y;
  });
  assert.ok(scrolled < top);
  // The heading scrolled out of view; the wheel goes back over the page's main content, which is still in view.
  await act('ui.scroll', { target: { ref: (await find({ role: 'main', scope: 'preview' })).ref }, deltaY: -2000 });
  await eventually(async () => assert.ok((await find({ role: 'heading', name: NEW_HEADING, scope: 'preview' })).box.y >= top - 1, 'and back'));
  assert.equal(await applied(), steps, 'none of that changed the project');

  step('reorder by the canvas grip: a screenshot point on the grip, dragged to a point below the next section');
  await click((await find({ role: 'button', name: 'Desktop', scope: 'editor' })).ref);
  await click((await find({ role: 'button', name: 'Layers', region: 'Panels' })).ref);
  // The logo strip's own element ids, as the canvas reports them for a selection (to find it on the image below).
  await click((await eventually(() => find({ role: 'treeitem', name: 'Logo strip', scope: 'editor' }))).ref);
  const logo = await eventually(async () => {
    const c = (await snapshot({ maxNodes: 20 })).context.selection;
    assert.equal(c?.toolbar, 'Logo strip actions');
    return c.semantic;
  });
  const hero = await find({ role: 'treeitem', name: 'Split hero', scope: 'editor' });
  await click(hero.ref);
  await eventually(async () => assert.equal((await snapshot({ maxNodes: 20 })).context.selection?.toolbar, 'Split hero actions'));
  const reorderSteps = await applied();
  const shot = await snapshot({ maxNodes: 20, screenshot: true });
  assert.ok(shot.screenshots.observation, 'a still screenshot can be pointed at');
  const { preview: previewShot } = shot.screenshots;
  assert.ok(previewShot.origin && previewShot.scale > 0, 'the preview image says where the page is and its zoom');
  // Where the grip and the next section are on the images (read from the page, as a tester reads the pixels).
  const grip = await session.page.locator('.ov-chip [aria-label="Drag to move"]').boundingBox();
  assert.ok(grip, 'the chip shows its grip');
  const logoBox = await (await session.page.$('.frame-box iframe')).contentFrame().then((f) =>
    f.locator(semanticSelector(logo)).first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, undefined, { timeout: 5000 })
  );
  const drop = { x: previewShot.origin.x - previewShot.clip.x + (logoBox.x + logoBox.width / 2) * previewShot.scale, y: previewShot.origin.y - previewShot.clip.y + (logoBox.y + logoBox.height * 0.8) * previewShot.scale };
  const dragged = await act('ui.drag', {
    from: { observation: shot.screenshots.observation, surface: 'editor', x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 },
    to: { observation: shot.screenshots.observation, surface: 'preview', x: drop.x, y: drop.y }
  });
  assert.equal(dragged.target.surface, 'editor', 'the drag started on the editor’s grip');
  assert.equal(dragged.destination.surface, 'preview', 'and was aimed at the page');
  await eventually(async () => assert.deepEqual((await pageOrder()).slice(0, 3), ['Logo strip', 'Split hero', 'Services grid'], 'the hero moved below the logo strip'));
  assert.equal(await applied(), reorderSteps + 1, 'one step of history');
  const used = failed(await call('ui.click', { target: { observation: shot.screenshots.observation, surface: 'editor', x: grip.x + 2, y: grip.y + 2 } }), 'STALE_OBSERVATION', 'a point on a screenshot taken before the drag');
  assert.equal(used.details.reason, 'acted');

  step('reorder in Layers: the hero’s row dragged above the logo strip’s');
  const heroRow = await find({ role: 'treeitem', name: 'Split hero', scope: 'editor' });
  const logoRow = await find({ role: 'treeitem', name: 'Logo strip', scope: 'editor' });
  await act('ui.drag', { from: { ref: heroRow.ref }, to: { ref: logoRow.ref, position: { x: 40, y: 3 } } });
  await eventually(async () => assert.deepEqual((await pageOrder()).slice(0, 3), ['Split hero', 'Logo strip', 'Services grid'], 'the Layers drag moved the hero back to the top'));
  await eventually(async () => assert.equal(await applied(), reorderSteps + 2, `one more step of history: ${JSON.stringify((await saved()).history.entries.map((e) => [e.label, e.applied]))}`), 5000);

  step('keyboard Undo and Redo from a Layers row move the project one step each');
  const row = await find({ role: 'treeitem', name: 'Split hero', scope: 'editor' });
  await press('ControlOrMeta+z', row.ref);
  await eventually(async () => assert.deepEqual((await pageOrder()).slice(0, 3), ['Logo strip', 'Split hero', 'Services grid'], 'Undo took the Layers move back'));
  assert.equal(await applied(), reorderSteps + 1);
  await press(process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+z');
  await eventually(async () => assert.deepEqual((await pageOrder()).slice(0, 3), ['Split hero', 'Logo strip', 'Services grid'], 'Redo made it again'));
  assert.equal(await applied(), reorderSteps + 2);

  step('a breakpoint chosen, and the preview frame resized by dragging its edge, without touching the project');
  const sizing = await applied();
  await click((await find({ role: 'button', name: 'Tablet', scope: 'editor' })).ref);
  const width = async () => Number((await find({ role: 'spinbutton', name: 'Preview width in pixels', scope: 'editor' })).value);
  await eventually(async () => assert.equal(await width(), 834, 'Tablet sets the width'));
  assert.equal((await find({ role: 'button', name: 'Tablet', scope: 'editor' })).pressed, true);
  const edge = await find({ role: 'separator', name: 'Preview width, right edge', scope: 'editor' });
  const zoom = (await snapshot({ maxNodes: 1, screenshot: true })).screenshots.preview.scale;
  await act('ui.drag', { from: { ref: edge.ref }, by: { x: 30, y: 0 } });
  const want = Math.max(240, Math.min(2560, Math.round(834 + (30 / zoom) * 2)));
  await eventually(async () => assert.ok(Math.abs((await width()) - want) <= 2, `the frame is ${want}px after the drag (${await width()}px)`));
  assert.notEqual((await find({ role: 'button', name: 'Tablet', scope: 'editor' })).pressed, true, 'no preset fits it any more');
  assert.equal(await applied(), sizing, 'resizing the preview is not an edit');

  step('another page: chosen in Pages, its heading edited, its history and the home page’s checked');
  await click((await find({ role: 'button', name: 'Pages', region: 'Panels' })).ref);
  await click((await eventually(() => find({ role: 'option', name: 'About', scope: 'editor' }))).ref);
  await eventually(async () => {
    const c = (await snapshot({ maxNodes: 20 })).context;
    assert.equal(c.preview.state, 'ready');
    assert.equal(c.preview.path, '/about/');
  }, 60000);
  const homeHeading = failed(await call('ui.click', { target: { ref: edited.ref } }), 'STALE_REF', 'a ref from the home page, on About');
  assert.equal(homeHeading.details.reason, 'document');
  const aboutHeading = flatten((await snapshot({ scope: 'preview', maxNodes: 1000 })).preview.nodes).find((x) => x.role === 'heading' && x.level === 1);
  assert.ok(aboutHeading?.ref, 'About has a heading');
  const aboutBefore = await applied();
  await click(aboutHeading.ref);
  await new Promise((r) => setTimeout(r, 700));
  await click(aboutHeading.ref);
  await new Promise((r) => setTimeout(r, 700));
  await click(aboutHeading.ref, { count: 2 });
  await eventually(async () => assert.equal((await snapshot({ maxNodes: 20 })).context.focus?.scope, 'preview', 'the About heading is being edited'));
  await press('ControlOrMeta+a');
  await act('ui.type', { text: 'A studio by the harbour' });
  await press('Enter');
  await eventually(async () => assert.ok(source('src/routes/about/+page.svelte').includes('A studio by the harbour'), 'About’s source has its new heading'), 30000);
  await eventually(() => find({ role: 'heading', name: 'A studio by the harbour', scope: 'preview' }), 30000);
  assert.equal(await applied(), aboutBefore + 1, 'one more step of history');
  // Undo from the editor (the Pages list has the keyboard), then Redo: About's preview follows, Home is untouched.
  await click((await find({ role: 'option', name: 'About', scope: 'editor' })).ref);
  await press('ControlOrMeta+z');
  await eventually(() => find({ role: 'heading', name: aboutHeading.name, scope: 'preview' }), 30000);
  assert.equal(await applied(), aboutBefore);
  await press(process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+z');
  await eventually(() => find({ role: 'heading', name: 'A studio by the harbour', scope: 'preview' }), 30000);
  assert.equal(await applied(), aboutBefore + 1);
  assert.ok(source('src/routes/+page.svelte').includes(NEW_HEADING), 'Home keeps its heading');
  assert.deepEqual((await pageOrder()).slice(0, 3), ['Split hero', 'Logo strip', 'Services grid'], 'and its order');
  await click((await find({ role: 'option', name: 'Home, home page', scope: 'editor' })).ref);
  await eventually(async () => {
    const c = (await snapshot({ maxNodes: 20 })).context;
    assert.equal(c.preview.path, '/');
    assert.equal(c.preview.state, 'ready');
  }, 60000);
  await eventually(() => find({ role: 'heading', name: NEW_HEADING, scope: 'preview' }), 30000);

  step('what a person could not do fails with a reason, and changes nothing');
  const unchanged = await applied();
  const order = await pageOrder();
  // Covered by the canvas's chip: a section's chip drawn over the page. A point inside both one of its buttons and the
  // visible page is aimed at through the smallest element of the page there.
  await click((await find({ role: 'button', name: 'Layers', region: 'Panels' })).ref);
  let sel = null;
  let aimAt = null;
  for (const name of ['Logo strip', 'Services grid']) {
    await click((await eventually(() => find({ role: 'treeitem', name, scope: 'editor' }))).ref);
    sel = await eventually(async () => {
      const c = (await snapshot({ maxNodes: 20 })).context.selection;
      assert.equal(c?.toolbar, `${name} actions`);
      return c;
    });
    // Selecting a row scrolls its section into view: the point is worked out once the page has stopped moving.
    const pointUnder = async () => {
      // One of the chip's own buttons (the chip's frame lets the page take clicks around them).
      const bar = await find({ role: 'toolbar', name: `${name} actions`, scope: 'editor' });
      const button = flatten((await snapshot({ within: bar.ref, maxNodes: 100 })).editor.nodes).find((x) => x.role === 'button' && x.box && !x.offscreen);
      assert.ok(button, 'the chip has a button');
      const pv = (await snapshot({ maxNodes: 1, screenshot: true })).screenshots.preview;
      const b = button.box;
      const left = Math.max(b.x, pv.clip.x);
      const right = Math.min(b.x + b.width, pv.clip.x + pv.clip.width);
      const top = Math.max(b.y, pv.clip.y);
      const bottom = Math.min(b.y + b.height, pv.clip.y + pv.clip.height);
      if (right - left < 4 || bottom - top < 4) return null;
      const at = { x: ((left + right) / 2 - pv.origin.x) / pv.scale, y: ((top + bottom) / 2 - pv.origin.y) / pv.scale };
      const inside = flatten((await snapshot({ scope: 'preview', maxNodes: 1000 })).preview.nodes)
        .filter((x) => x.ref && x.box && x.box.x <= at.x && at.x < x.box.x + x.box.width && x.box.y <= at.y && at.y < x.box.y + x.box.height)
        .sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height);
      return inside.length ? { ref: inside[0].ref, position: { x: at.x - inside[0].box.x, y: at.y - inside[0].box.y } } : null;
    };
    aimAt = await eventually(async () => {
      const a = await pointUnder();
      await new Promise((r) => setTimeout(r, 500));
      const b = await pointUnder();
      assert.deepEqual(b, a, 'the page has stopped moving');
      return b;
    });
    if (aimAt) break;
  }
  assert.ok(aimAt, 'a section’s chip is drawn over the page');
  const covered = failed(await call('ui.click', { target: aimAt, waitMs: 300 }), 'NOT_ACTIONABLE', 'the page under the chip');
  assert.equal(covered.details.reason, 'obscured');
  assert.equal(covered.details.dispatched, 'none');
  assert.equal(covered.details.blocker.surface, 'editor', 'the chip, in the editor, is what covers it');
  assert.equal(covered.retryable, true);
  assert.deepEqual((await snapshot({ maxNodes: 20 })).context.selection?.semantic, sel.semantic, 'the selection is as it was');
  // Under a dialog: the page and the editor's own controls.
  const target = await find({ role: 'heading', name: NEW_HEADING, scope: 'preview' });
  await click((await find({ role: 'button', name: 'Settings', scope: 'editor' })).ref);
  const settings = await eventually(async () => {
    const d = (await snapshot({ maxNodes: 20 })).context.dialog;
    assert.equal(d?.name, 'Settings');
    return d;
  });
  const behind = failed(await call('ui.click', { target: { ref: target.ref }, waitMs: 200 }), 'NOT_ACTIONABLE', 'the page under the Settings dialog');
  assert.equal(behind.details.reason, 'inert');
  assert.equal(behind.details.dialog, 'Settings', 'the failure names the dialog in the way');
  const layersBehind = failed(await call('ui.click', { target: { ref: (await find({ role: 'button', name: 'Layers', region: 'Panels' })).ref }, waitMs: 200 }), 'NOT_ACTIONABLE', 'an editor control under the dialog');
  assert.equal(layersBehind.details.reason, 'inert');
  assert.equal((await snapshot({ maxNodes: 20 })).context.dialog?.name, 'Settings', 'the dialog is still open');
  await press('Escape');
  await eventually(async () => assert.equal((await snapshot({ maxNodes: 20 })).context.dialog, null));
  failed(await call('ui.locate', { ref: settings.ref }), 'STALE_REF', 'the closed dialog');
  // Typing with nothing that takes text focused types nothing: an "s" on the Logo strip row would select Services grid.
  await click((await find({ role: 'treeitem', name: 'Logo strip', scope: 'editor' })).ref);
  await eventually(async () => assert.equal((await snapshot({ maxNodes: 20 })).context.selection?.toolbar, 'Logo strip actions'));
  const notText = failed(await call('ui.type', { text: 's' }), 'NOT_ACTIONABLE', 'typing with a Layers row focused');
  assert.equal(notText.details.reason, 'not-editable');
  await new Promise((r) => setTimeout(r, 300));
  const after = (await snapshot({ maxNodes: 20 })).context;
  assert.equal(after.selection?.toolbar, 'Logo strip actions', 'the key never reached the row');
  assert.equal(after.focus?.name, 'Logo strip');
  // Impossible gestures, refused before anything is sent.
  const edgeNow = await find({ role: 'separator', name: 'Preview width, right edge', scope: 'editor' });
  failed(await call('ui.drag', { from: { ref: edgeNow.ref }, to: { ref: edgeNow.ref }, by: { x: 10, y: 0 } }), 'BAD_REQUEST', 'a drag to a target and by an offset');
  const far = failed(await call('ui.drag', { from: { ref: edgeNow.ref }, by: { x: 5000, y: 0 } }), 'NOT_ACTIONABLE', 'a drag out of the window');
  assert.deepEqual([far.details.reason, far.details.dispatched, far.retryable], ['outside-window', 'none', false]);
  failed(await call('ui.press', { key: 'Shift+Hyper' }), 'BAD_REQUEST', 'an unknown key');
  assert.equal(failed(await call('ui.select', { target: { ref: edgeNow.ref }, option: { label: 'x' } }), 'NOT_ACTIONABLE', 'choosing in something that is not a list').details.reason, 'not-a-select');
  assert.equal(failed(await call('ui.fill', { target: { ref: (await find({ role: 'button', name: 'Settings', scope: 'editor' })).ref }, text: 'x', waitMs: 200 }), 'NOT_ACTIONABLE', 'filling a button').details.reason, 'not-editable');
  // Screenshot points that no longer hold: replaced by a newer screenshot, and off the image.
  const older = (await snapshot({ maxNodes: 1, screenshot: true })).screenshots.observation;
  const newer = (await snapshot({ maxNodes: 1, screenshot: true })).screenshots.observation;
  assert.equal(failed(await call('ui.click', { target: { observation: older, surface: 'editor', x: 10, y: 10 } }), 'STALE_OBSERVATION', 'a point on a replaced screenshot').details.reason, 'superseded');
  failed(await call('ui.click', { target: { observation: newer, surface: 'editor', x: 99999, y: 10 } }), 'BAD_REQUEST', 'a point off the image');
  assert.equal(await applied(), unchanged, 'none of the refused actions changed the project');
  assert.deepEqual(await pageOrder(), order);

  step('a select in the Inspector, chosen by its label, moves the project one step');
  await click((await find({ role: 'treeitem', name: 'Split hero', scope: 'editor' })).ref);
  const layout = await eventually(() => find({ role: 'combobox', name: 'Layout', scope: 'editor' }));
  const was = await applied();
  const chosen = await act('ui.select', { target: { ref: layout.ref }, option: { label: 'Image first' } });
  assert.deepEqual(chosen.selected, { label: 'Image first', value: 'media-start' });
  await eventually(async () => assert.equal(await applied(), was + 1, 'one step of history'));
  assert.match((await saved()).history.undoLabel ?? '', /layout/i, 'Undo names the change');
  /** The hero's layout as the project holds it. */
  const heroLayout = async () => {
    const st = (await saved()).state;
    const p = st.pages[st.site.homePageId];
    const id = p.rootIds.find((r) => st.components[p.nodes[r].definitionId]?.name === 'Split hero');
    return p.nodes[id].variants?.layout ?? 'default';
  };
  await eventually(async () => assert.equal(await heroLayout(), 'media-start', 'the hero shows its image first'));
  // And back, by value. Choosing what is already chosen changes nothing.
  const relayout = await find({ role: 'combobox', name: 'Layout', scope: 'editor' });
  await act('ui.select', { target: { ref: relayout.ref }, option: { value: 'default' } });
  await eventually(async () => assert.equal(await heroLayout(), 'default', 'and last again'));
  await eventually(async () => assert.equal(await applied(), was + 2, 'one more step'));
  const same = await act('ui.select', { target: { ref: (await find({ role: 'combobox', name: 'Layout', scope: 'editor' })).ref }, option: { label: 'Image last' } });
  assert.equal(same.selected.value, 'default');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await applied(), was + 2, 'the option already chosen moves nothing');

  step('modifiers are held for a click and let go after it: Shift selects a range of rows, a plain click one row');
  const SECTIONS = ['Split hero', 'Logo strip', 'Services grid'];
  const rowState = async () => {
    const rows = flatten((await snapshot({ scope: 'editor', maxNodes: 1000 })).editor.nodes).filter((x) => x.role === 'treeitem' && SECTIONS.some((n) => x.name?.startsWith(n)));
    if (rows.length !== 3) console.log('rows', JSON.stringify(rows.map((x) => x.name)));
    return Object.fromEntries(SECTIONS.map((n) => [n, !!rows.find((x) => x.name.startsWith(n))?.selected]));
  };
  await click((await find({ role: 'treeitem', name: 'Split hero', scope: 'editor' })).ref);
  await click((await find({ role: 'treeitem', name: 'Services grid', scope: 'editor' })).ref, { modifiers: ['Shift'] });
  await eventually(async () => assert.deepEqual(await rowState(), { 'Split hero': true, 'Logo strip': true, 'Services grid': true }, 'Shift selected the range'));
  await click((await find({ role: 'treeitem', name: 'Logo strip', scope: 'editor' })).ref);
  await eventually(async () => assert.deepEqual(await rowState(), { 'Split hero': false, 'Logo strip': true, 'Services grid': false }, 'Shift was let go: a plain click selects one row'));

  step('a credential entered through the actions never comes back, nor does a screenshot while it is known');
  const KEY = 'sk-ACTIONS-SENTINEL-7f3a9c';
  const leaks = (reply) => ['ACTIONS-SENTINEL', '7f3a9c'].filter((f) => JSON.stringify(reply).includes(f));
  await click((await find({ role: 'button', name: 'Settings', scope: 'editor' })).ref);
  const settingsAgain = await eventually(async () => {
    const d = (await snapshot({ maxNodes: 20 })).context.dialog;
    assert.equal(d?.name, 'Settings');
    return d;
  });
  await click((await find({ role: 'tab', name: 'AI assistant', within: settingsAgain.ref })).ref);
  const keyField = await eventually(() => find({ role: 'textbox', name: 'API key (optional)', scope: 'editor' }));
  const filled = await call('ui.fill', { target: { ref: keyField.ref }, text: KEY });
  ok(filled, 'filling the key');
  const replies = [filled, await call('ui.snapshot', { scope: 'editor', maxNodes: 1000 }), await call('ui.locate', { ref: keyField.ref }), await call('ui.press', { key: 'Tab' }), await call('ui.press', { key: 'Shift+Tab' })];
  for (const r of replies) assert.deepEqual(leaks(r), [], `no piece of the key in ${r.op}`);
  assert.equal(ok(replies[2], 'the key field').node.redacted, true);
  const covered2 = ok(await call('ui.snapshot', { maxNodes: 5, screenshot: true }), 'a screenshot with a key typed');
  assert.equal(covered2.screenshots.observation, undefined, 'no point can be aimed at a screenshot that was not taken');
  assert.deepEqual([covered2.screenshots.editor, covered2.screenshots.preview], [null, null]);
  // A request quoting the key is answered without it.
  const quoted = await call('ui.press', { key: KEY });
  assert.equal(quoted.ok, false);
  assert.deepEqual(leaks(quoted), [], 'nor in a refusal that quotes it');
  await press('Escape');
  const ask = await eventually(async () => {
    const d = (await snapshot({ maxNodes: 20 })).context.dialog;
    assert.equal(d?.name, 'Save the API key you entered?');
    return d;
  });
  await click((await find({ role: 'button', name: 'Discard', within: ask.ref })).ref);
  await eventually(async () => assert.equal((await snapshot({ maxNodes: 20 })).context.dialog, null));

  assert.deepEqual(session.pageErrors, [], 'the editor raised no errors');
  passed = true;
  console.log('\nactions: all checks passed');
} finally {
  // A teardown that fails fails the run, even one whose checks passed.
  const closed = await session.close({ failed: !passed }).then(
    () => true,
    (e) => {
      console.error('close failed', e);
      return false;
    }
  );
  if (!closed) process.exitCode = 1;
  if (passed && closed) cleanup();
}
