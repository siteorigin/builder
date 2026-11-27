// Design capture for every dialog's blocked note: what each one says when the project is open read-only, and when the
// AI is busy, side by side for a design review. Find and replace, Paste style, AI conversations, Export, Turn into
// slot, Repeat as list, the removal review, Create component (from a node and new), a placement's Slots in the
// inspector, the page outline and History. Opt-in only, never part of `npm run test:e2e`, and it never calls a provider:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/blocked-notes.mjs
//
// Each surface is opened on a real project. Read-only and the AI at work are shown by sending the project's snapshot
// through the channel the project reports on (and, for a running request, the agent's own `ai:event` channel), so each
// surface renders exactly what it would for a project in that state; the real snapshot goes back before the next state.
// Each capture checks its note is on screen inside the surface and throws rather than write an image of anything else.
// Files are `{state}--{theme}.png`, cropped to the dialog (or panel) with a margin of the window.
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, launch, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('blocked notes capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'blocked-notes');
mkdirSync(OUT, { recursive: true });
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const READ_ONLY = { reason: 'Another SiteOrigin Builder took over this project, so it is read-only here. Close and reopen it to edit.', canUnlock: true };
const started = Date.now();

const { WORK, cleanup } = scratch('design-blocked-notes');
const { app, win, errors } = await launch(WORK);
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
await win.emulateMedia({ reducedMotion: 'reduce' });
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
const skipped = [];
const modal = win.locator('.modal').last();
const inspector = win.locator('#dock-panel-inspect');
const sidePanel = win.locator('.side-panel-view:not([hidden])');
const menu = win.getByRole('menu');

/** Capture `root` with `margin` px of the window around it, in each theme; every `checks` selector must be visible inside it. */
async function shot(state, root, checks, { themes = LIGHT, margin = 24 } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await win.mouse.move(4, 4);
    if (held) await push(held);
    await pause(300);
    if (!(await root.first().isVisible().catch(() => false))) throw new Error(`"${state}" (${theme}): the surface is not on screen; refusing to write`);
    for (const check of [].concat(checks)) {
      const target = typeof check === 'string' ? root.locator(check).first() : check.first();
      if (!(await target.isVisible().catch(() => false))) {
        // The window as it was, kept in the run's scratch folder (never the captures) for whoever fixes the harness.
        await win.screenshot({ path: join(WORK, `failed-${state}.png`) }).catch(() => undefined);
        throw new Error(`"${state}" (${theme}): ${check} is not on screen; refusing to write (window: ${join(WORK, `failed-${state}.png`)})`);
      }
    }
    const box = await root.first().boundingBox();
    const size = win.viewportSize();
    const x = Math.max(0, Math.floor(box.x - margin));
    const y = Math.max(0, Math.floor(box.y - margin));
    const clip = { x, y, width: Math.min(size.width - x, Math.ceil(box.width + 2 * margin)), height: Math.min(size.height - y, Math.ceil(box.height + 2 * margin)) };
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}
const skip = (state, why) => {
  skipped.push(state);
  console.log(`skipped ${state}: ${why}`);
};

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
/**
 * Show the project as `change` makes it, through the channel the project reports its snapshot on. The change is held
 * until the real snapshot is pushed back: a snapshot the app sends meanwhile (its preview settling, a thumbnail) would
 * otherwise replace it, so `shot` pushes it again just before each capture.
 */
let held = null;
/**
 * Send `channel` to the editor window alone, as the main process does. Insert's component thumbnails open hidden
 * windows of their own, so the first window is not always the editor.
 */
const send = (channel, payload) =>
  app.evaluate(({ BrowserWindow }, [channel, payload]) => {
    const known = globalThis[Symbol.for('siteorigin.desktopFixtures')]?.editor;
    const editor =
      (known !== null && known !== undefined ? BrowserWindow.fromId(known) : null) ??
      BrowserWindow.getAllWindows().find((w) => {
        try {
          const u = new URL(w.webContents.getURL());
          return !w.isDestroyed() && u.protocol === 'app:' && u.host === 'editor';
        } catch {
          return false;
        }
      });
    if (!editor) throw new Error('no editor window');
    editor.webContents.send(channel, payload);
  }, [channel, payload]);
async function push(change) {
  held = change;
  const s = await snapshot();
  const next = change(s);
  await send('project:changed', { seq: 0, base: null, revision: next.revision, snapshot: next });
  await pause(500);
}
const readOnly = () => push((s) => ({ ...s, readOnly: READ_ONLY }));
const aiBusy = () => push((s) => ({ ...s, aiBusy: true, aiRunId: 'r_capture' }));
const real = async () => {
  await push((s) => s);
  held = null;
};
/** Push an agent event through the main process, exactly as a real run does. */
const emit = (e) => send('ai:event', e);
const conversationId = async () => (await win.evaluate(() => window.builder.ai.conversations())).active.id;
/** Each run its own ID, as main gives it: a run that ended never runs again. */
let runs = 0;
const running = async () => emit({ runId: `r_capture_${runs}`, conversationId: await conversationId(), kind: 'status', status: 'running' });
const stopped = async () => {
  await emit({ runId: `r_capture_${runs++}`, conversationId: await conversationId(), kind: 'status', status: 'cancelled' });
  await pause(300);
};
async function apply(operations, label) {
  const r = await win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);
  if (!r?.ok) throw new Error(`${label}: ${JSON.stringify(r?.error ?? r)}`);
  return r.results;
}
/** Close every open dialog, discarding a draft when one asks. */
async function closeAll() {
  for (let i = 0; i < 4 && (await win.locator('.modal').count()); i++) {
    await win.keyboard.press('Escape');
    await pause(250);
    const discard = win.getByRole('button', { name: /^Discard/ });
    if (await discard.count()) await discard.first().click();
  }
  if (await win.locator('.modal').count()) throw new Error('a dialog did not close');
  await pause(150);
}
const openRail = async (name) => {
  const b = win.locator(`.rail [aria-label="${name}"]`);
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
  await pause(250);
};
const openInspector = async () => {
  const tab = win.locator('#dock-tab-inspect');
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await inspector.waitFor();
};
const expand = async (title) => {
  const head = inspector.locator('.section-head', { hasText: title }).first();
  await head.waitFor();
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  await pause(200);
};
const until = async (check, ms = 20000, what = 'condition') => {
  const end = Date.now() + ms;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(300);
  }
};

// ---- A real project, then conversations seeded into its chat storage before it opens again ----
await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
const projectDir = (await snapshot()).dir;
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
const now = new Date();
const at = (days, hour, minute = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, hour, minute).toISOString();
let n = 0;
function conversation(id, requests, when, extra = {}) {
  const messages = [];
  requests.forEach((text, i) => {
    const time = new Date(new Date(when).getTime() - (requests.length - 1 - i) * 6 * 60e3).toISOString();
    const runId = `r_cap${++n}`;
    messages.push({ id: `m_u${n}`, role: 'user', text, time, runId });
    messages.push({ id: `m_a${n}`, role: 'assistant', text: 'Done.', time, runId, result: { status: 'completed', summary: 'Done.', changes: [], validation: [], canUndo: false } });
  });
  return { id, title: extra.title ?? requests[0].slice(0, 60), createdAt: messages[0].time, messages, ...(extra.named ? { named: true } : {}) };
}
const SEED = [
  conversation('c_hero', ['Rewrite the home page hero to sound warmer and more confident', 'Make the button say “Book a consultation” instead'], at(0, 14, 40), { title: 'Home page hero, warmer', named: true }),
  conversation('c_faq', ['Add an FAQ section to the Services page with five questions about parking, bookings and cancellations'], at(0, 11, 5)),
  conversation('c_brand', ['Make the brand colour a deeper terracotta and check every button still reads'], at(1, 9, 12)),
  conversation('c_about', ['Write an About page for the studio: founded in 2014 by Marama Tuhoe, two architects and a joiner'], at(5, 13, 45)),
  conversation('c_alt', ['Add alt text to the gallery images'], at(12, 9, 30))
];
const chatDir = join(projectDir, '.siteorigin', 'sessions', 'chat');
mkdirSync(chatDir, { recursive: true });
for (const c of SEED) writeFileSync(join(chatDir, `${c.id}.json`), JSON.stringify(c));
await win.reload();
await win.waitForSelector('.recent-card');
await win.locator('.recent-card', { hasText: 'Harbour Lane Studio' }).click();
await win.waitForSelector('.editor');
const frame = win.frameLocator('.frame-box iframe');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
await pause(1000);

// ---- Fixtures: a Split component placed twice, a plain group for Create component, a page with a skipped level ----
const first0 = await snapshot();
const homeId = first0.state.site.homePageId;
const home = { kind: 'page', id: homeId };
const [split, main, side, plain] = ['n_split001', 'n_main0001', 'n_side0001', 'n_plain001'];
await apply(
  [
    { type: 'node.insert', owner: home, newNodeId: split, parentId: null, primitive: 'row' },
    { type: 'node.insert', owner: home, newNodeId: main, parentId: split, primitive: 'stack' },
    { type: 'node.insert', owner: home, newNodeId: side, parentId: split, primitive: 'stack' },
    { type: 'node.rename', owner: home, nodeId: main, name: 'Main column' },
    { type: 'node.rename', owner: home, nodeId: side, name: 'Side column' },
    { type: 'node.insert', owner: home, parentId: main, primitive: 'heading', text: 'Visit the studio' },
    { type: 'node.insert', owner: home, parentId: main, primitive: 'paragraph', text: 'Drop in for a coffee and a look at the samples.' },
    { type: 'node.insert', owner: home, parentId: side, primitive: 'heading', text: 'Opening hours' },
    { type: 'node.insert', owner: home, parentId: side, primitive: 'paragraph', text: 'Mon to Fri, 8 to 6' }
  ],
  'Build the split'
);
const [{ definitionId: defId, nodeId: firstSplit }] = await apply([{ type: 'component.createFromNode', owner: home, nodeId: split, name: 'Split' }], 'Create Split');
const made = (await snapshot()).state.components[defId];
const column = Object.values(made.tree.nodes).find((x) => x.name === 'Side column').id;
const mainColumn = Object.values(made.tree.nodes).find((x) => x.name === 'Main column').id;
const designRoot = made.tree.rootIds[0];
const [hoursProp, daysProp] = made.tree.nodes[column].children.map((id) => made.tree.nodes[id].text?.$prop);
await apply([{ type: 'node.insert', owner: home, parentId: null, definitionId: defId, props: hoursProp && daysProp ? { [hoursProp]: 'Weekend hours', [daysProp]: 'Sat, 9 to 1' } : {} }], 'Place a second Split');
await apply(
  [
    { type: 'node.insert', owner: home, newNodeId: plain, parentId: null, primitive: 'stack' },
    { type: 'node.rename', owner: home, nodeId: plain, name: 'Feature highlight' },
    { type: 'node.insert', owner: home, parentId: plain, primitive: 'heading', text: 'Feature highlight' },
    { type: 'node.insert', owner: home, parentId: plain, primitive: 'paragraph', text: 'Stand 14, north hall. Open every day of the fair.' }
  ],
  'Add a plain group'
);
// Feature cards: a grid holding one static card, for Repeat as list (as tests/e2e/repeat-as-list.mjs builds it).
const [{ definitionId: cardsId, rootNodeId: cardsRoot }] = await apply([{ type: 'component.create', name: 'Feature cards' }], 'Create Feature cards');
const cards = { kind: 'component', id: cardsId };
const card = 'n_card0001';
await apply(
  [
    { type: 'node.insert', owner: cards, newNodeId: 'n_grid0001', parentId: cardsRoot, primitive: 'grid' },
    { type: 'node.insert', owner: cards, newNodeId: card, parentId: 'n_grid0001', primitive: 'container' },
    { type: 'node.rename', owner: cards, nodeId: card, name: 'Card' },
    { type: 'node.insert', owner: cards, parentId: card, primitive: 'icon' },
    { type: 'node.insert', owner: cards, parentId: card, primitive: 'heading', text: 'Fast setup' },
    { type: 'node.insert', owner: cards, parentId: card, primitive: 'paragraph', text: 'Up and running in minutes.' }
  ],
  'Build Feature cards'
);
const [{ nodeId: cardsPlacement }] = await apply([{ type: 'node.insert', owner: home, parentId: null, definitionId: cardsId }], 'Place Feature cards');
await apply([{ type: 'page.create', title: 'Opening times', route: '/opening-times/', starter: 'empty' }], 'Add a page');
{
  const guide = Object.values((await snapshot()).state.pages).find((p) => p.title === 'Opening times');
  const owner = { kind: 'page', id: guide.id };
  for (const id of [...guide.rootIds]) await apply([{ type: 'node.remove', owner, nodeId: id }], 'Clear');
  for (const [i, [level, text]] of [[1, 'Opening times'], [2, 'Weekdays'], [4, 'Public holidays']].entries()) {
    const [{ nodeId }] = await apply([{ type: 'node.insert', owner, primitive: 'heading', text, index: i }], `Heading ${level}`);
    if (level !== 2) await apply([{ type: 'node.setContent', owner, nodeId, field: 'tag', value: `h${level}` }], `Make it Heading ${level}`);
  }
}
await pause(1200);

// ---- 1. Find and replace, replacing, with matches and a replacement typed ----
{
  const dialog = win.getByRole('dialog', { name: 'Find and replace' });
  await win.keyboard.press('ControlOrMeta+Shift+KeyF');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Find', { exact: true }).fill('hello@example.com');
  await pause(400);
  const replaceField = dialog.getByLabel('Replace with');
  if (!(await replaceField.count())) await dialog.locator('.modal-foot .btn-primary').click();
  await replaceField.waitFor({ timeout: 3000 });
  await replaceField.fill('studio@harbourlane.example');
  await pause(500);
  await readOnly();
  await shot('find-replace-read-only', dialog, ['.find-foot-note, .blocked-note', '.find-match'], { themes: BOTH });
  await aiBusy();
  await shot('find-replace-ai-busy', dialog, ['.find-foot-note, .blocked-note', '.find-match']);
  await real();
  await closeAll();
}

// ---- 2. Paste style: the hero's style onto Content with image ----
{
  // The hero carries styles of its own, and the destination values of its own, so the review shows real befores.
  const s = await snapshot();
  const page = s.state.pages[homeId];
  const find = (cid) => page.rootIds.map((id) => page.nodes[id]).find((x) => s.state.components[x.definitionId]?.componentId === cid);
  const [hero, media] = [find('hero.split'), find('content.media')];
  const set = (nodeId, partId, scope, property, value) => ({ type: 'node.setStyle', owner: home, nodeId, partId, scope, property, value });
  for (const op of [
    set(hero.id, 'root', 'base', 'paddingBlock', '72px'),
    set(hero.id, 'root', 'phone', 'paddingBlock', '16px'),
    set(hero.id, 'root', 'base', 'background', { token: 'color.inverse' }),
    set(hero.id, 'heading', 'base', 'color', { token: 'color.brand' }),
    set(hero.id, 'heading', 'base', 'maxWidth', '18ch'),
    set(hero.id, 'media', 'base', 'radius', '16px'),
    set(media.id, 'root', 'base', 'background', { token: 'color.surface' }),
    set(media.id, 'heading', 'base', 'color', '#2b3a55'),
    set(media.id, 'media', 'base', 'radius', '4px')
  ]) {
    const r = await win.evaluate((o) => window.builder.project.apply({ operations: [o] }, { label: 'Fixture styles' }), op);
    if (!r.ok) console.log(`fixture: skipped ${op.partId}.${op.property}: ${JSON.stringify(r.error ?? r).slice(0, 160)}`);
  }
  await pause(1000);
  const dialog = win.getByRole('dialog', { name: 'Paste style' });
  await openRail('Layers');
  const row = (name) => win.locator('[role="tree"] .list-item', { hasText: name }).first();
  await row('Split hero').click();
  await pause(400);
  await row('Split hero').click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Copy style' }).click();
  await win.locator('.toast', { hasText: 'Copied the style of Split hero' }).waitFor();
  await row('Content with image').click({ button: 'right' });
  await win.getByRole('menuitem', { name: /Paste style/ }).click();
  await dialog.waitFor();
  await pause(500);
  await readOnly();
  await shot('paste-style-read-only', dialog, ['.paste-foot-note, .blocked-note'], { themes: BOTH });
  await aiBusy();
  await shot('paste-style-ai-busy', dialog, ['.paste-foot-note, .blocked-note']);
  await real();
  await closeAll();
}

// ---- 3. The AI conversations manager ----
{
  const manager = win.getByRole('dialog', { name: 'AI conversations' });
  await win.locator('.dock-tab', { hasText: 'AI' }).click();
  await pause(400);
  await win.getByRole('button', { name: 'Earlier conversations' }).click();
  await win.getByRole('menuitem', { name: 'Find, rename or delete…' }).click();
  await manager.waitFor();
  await pause(400);
  await readOnly();
  await shot('conversations-read-only', manager, ['.history-note, .blocked-note', '[data-conversation-id="c_hero"]']);
  await real();
  await running();
  await pause(300);
  await shot('conversations-ai-running', manager, ['.history-note, .blocked-note', '[data-conversation-id="c_hero"]']);
  await stopped();
  await closeAll();
}

// ---- 4. Export ----
{
  const dialog = win.getByRole('dialog', { name: 'Export your website' });
  const openExport = async () => {
    await win.locator('.export-btn').click();
    await dialog.waitFor({ timeout: 5000 });
    await pause(400);
  };
  await openExport();
  await aiBusy();
  await running();
  await pause(300);
  await shot('export-ai-busy', dialog, ['.export-blocker']);
  await stopped();
  await real();
  // Read-only: the dialog stays open on a project that turns read-only, its sample contact review unable to keep anything.
  await readOnly();
  // It has no read-only note of its own: Keep it, unavailable, is all that says so.
  if (await dialog.isVisible().catch(() => false)) await shot('export-read-only', dialog, ['.export-blocker, .export-review-keep:disabled']);
  else skip('export-read-only', 'the Export dialog closes when the project turns read-only');
  await real();
  await closeAll();
}

// ---- 5-7. Turn into slot and the removal review in the Split's design, Repeat as list in Feature cards' (Edit everywhere) ----
const tree = (owner, nodeId) => win.locator(`[role="tree"] [data-owner="${owner}"][data-node="${nodeId}"]`);
async function selectPlacement(nodeId) {
  await openRail('Layers');
  await win.locator(`.layers-tree [data-node="${nodeId}"]`).first().click();
  await until(async () => (await tree(`page:${homeId}`, nodeId).getAttribute('aria-selected')) === 'true', 15000, 'the placement to be selected');
  await openInspector();
  await pause(300);
}
async function editEverywhere(placement) {
  await selectPlacement(placement);
  const section = inspector.getByRole('button', { name: /^Component\b/ });
  await section.waitFor();
  if ((await section.getAttribute('aria-expanded')) === 'false') await section.click();
  await win.getByRole('button', { name: 'Edit everywhere…' }).click();
  await win.getByRole('dialog').getByRole('button', { name: /^Edit (everywhere|design)$/ }).click();
  await win.locator('.mode-band').waitFor();
  await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
  await openRail('Layers');
  await pause(500);
}
async function selectInDesign(nodeId, def = defId, placement = firstSplit) {
  const row = tree(`component:${def}`, nodeId);
  const onPage = frame.locator(`[data-so-ctx$="|${placement}"] [data-so-node="${nodeId}"]`).first();
  await until(async () => {
    if ((await row.getAttribute('aria-selected', { timeout: 500 }).catch(() => null)) === 'true') return true;
    if (await row.isVisible().catch(() => false)) await row.click();
    else await onPage.dispatchEvent('click');
    await pause(300);
    return (await row.getAttribute('aria-selected', { timeout: 500 }).catch(() => null)) === 'true';
  }, 20000, `${nodeId} in the design to be selected`);
  await openInspector();
  await pause(300);
}
/** Open `item` from the inspector's More actions on the selection; false if it isn't offered or is unavailable. */
async function moreAction(item) {
  await inspector.getByRole('button', { name: /^More actions for / }).first().click();
  await menu.first().waitFor();
  const entry = menu.getByRole('menuitem', { name: item });
  if (!(await entry.count()) || (await entry.first().getAttribute('aria-disabled')) === 'true') {
    await win.keyboard.press('Escape');
    await pause(200);
    return false;
  }
  await entry.first().click();
  await modal.waitFor();
  await pause(400);
  return true;
}

await editEverywhere(firstSplit);
// 5. Turn into slot
await selectInDesign(column);
if (await moreAction('Turn into slot…')) {
  const dialog = win.getByRole('dialog', { name: 'Turn into slot' });
  await dialog.waitFor();
  await readOnly();
  await shot('turn-into-slot-read-only', dialog, ['.authoring-gone, .blocked-note']);
  await real();
  await closeAll();
} else skip('turn-into-slot-read-only', 'Turn into slot… is not offered on the Side column');

// 7. The removal review: the Side column becomes a slot each placement fills, then removing that slot reviews them.
await apply([{ type: 'component.containerToSlot', definitionId: defId, nodeId: column, slot: 'sideColumn', label: 'Side column', keep: 'placements' }], 'Turn Side column into a slot');
await pause(800);
await selectInDesign(designRoot);
await expand('Slots');
{
  const remove = inspector.locator('[data-slot="sideColumn"]').getByRole('button', { name: 'Remove Side column' });
  await remove.waitFor({ timeout: 10000 });
  await remove.click();
  const review = win.locator('.modal[role="dialog"]').last();
  await review.waitFor();
  await pause(400);
  await readOnly();
  await shot('removal-review-read-only', review, ['.authoring-gone, .blocked-note'], { themes: BOTH });
  await aiBusy();
  await shot('removal-review-ai-busy', review, ['.authoring-gone, .blocked-note']);
  await real();
  await closeAll();
}
await win.locator('.mode-band-done').click();
await win.locator('.mode-band').waitFor({ state: 'detached' });
await pause(600);

// 6. Repeat as list, on the Feature cards' card
await editEverywhere(cardsPlacement);
await selectInDesign(card, cardsId, cardsPlacement);
if (await moreAction('Repeat as list…')) {
  const dialog = win.getByRole('dialog', { name: 'Repeat as list' });
  await dialog.waitFor();
  await readOnly();
  await shot('repeat-as-list-read-only', dialog, ['.authoring-gone, .blocked-note']);
  await real();
  await closeAll();
} else skip('repeat-as-list-read-only', 'Repeat as list… is not offered on the Feature cards card');
await win.locator('.mode-band-done').click();
await win.locator('.mode-band').waitFor({ state: 'detached' });
await pause(600);

// ---- 8. Create component, from a node and new ----
{
  await openRail('Layers');
  await win.locator(`.layers-tree [data-node="${plain}"]`).first().click();
  await until(async () => (await tree(`page:${homeId}`, plain).getAttribute('aria-selected')) === 'true', 15000, 'the group to be selected');
  await openInspector();
  await pause(300);
  if (await moreAction(/^Create component/)) {
    await modal.getByLabel('Component name').fill('Feature highlight');
    await readOnly();
    await shot('create-component-read-only', modal, ['.authoring-gone, .blocked-note']);
    await real();
    await closeAll();
  } else skip('create-component-read-only', 'Create component… is not offered on the group');

  const openNew = async () => {
    await openRail('Insert');
    await sidePanel.locator('.insert-tile.new[data-key="new-component"]').click();
    await modal.waitFor();
    // Opening Insert reads the project again: let that land before a pushed snapshot, or it replaces it.
    await pause(1500);
  };
  await openNew();
  await readOnly();
  await shot('new-component-read-only', modal, ['.authoring-gone, .blocked-note']);
  await real();
  await closeAll();
  await openNew();
  await modal.getByLabel('Component name').fill('Pricing card');
  await running();
  await pause(400);
  await shot('new-component-ai-running', modal, ['.modal-foot .btn:not(.btn-primary):disabled']);
  await stopped();
  await closeAll();
}

// ---- 9. A placement's Slots in the inspector ----
{
  await selectPlacement(firstSplit);
  await expand('Slots');
  const section = inspector.locator('.section-head', { hasText: 'Slots' }).first();
  await section.scrollIntoViewIfNeeded();
  await readOnly();
  await section.scrollIntoViewIfNeeded();
  await shot('slots-read-only', inspector, ['.insp-note, .blocked-note'], { margin: 0 });
  await aiBusy();
  await section.scrollIntoViewIfNeeded();
  await shot('slots-ai-busy', inspector, ['.insp-note, .blocked-note'], { margin: 0 });
  await real();
}

// ---- 10. The page outline ----
{
  await openRail('Pages');
  await sidePanel.locator('[data-page]', { hasText: 'Opening times' }).first().click();
  await pause(900);
  await win.keyboard.press('Escape');
  await openRail('Layers');
  const toggle = sidePanel.locator('button[title^="The headings this page shows"]');
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await win.locator('.outline-view').waitFor();
  await pause(300);
  await readOnly();
  await shot('outline-read-only', win.locator('.side-panel'), ['.outline-check'], { margin: 0 });
  await real();
}

// ---- 11. History, Changes ----
{
  const history = win.getByRole('dialog', { name: 'History' });
  await win.locator('.project-title').click();
  await win.locator('[role="menu"]').waitFor();
  await win.locator('[role="menu"] [role^="menuitem"]', { hasText: 'History…' }).click();
  await history.waitFor();
  await pause(400);
  await readOnly();
  await shot('history-read-only', history, ['.history-note, .blocked-note', '.history-step']);
  await aiBusy();
  await shot('history-ai-busy', history, ['.history-note, .blocked-note', '.history-step']);
  await real();
  await closeAll();
}

const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
const missing = written.filter((p) => !files.includes(p.slice(OUT.length + 1)));
if (missing.length) throw new Error(`not written: ${missing.join(', ')}`);
if (errors.length) console.log('page errors:', errors);
console.log(`blocked notes capture: ${written.length} images written${skipped.length ? `, ${skipped.length} skipped (${skipped.join(', ')})` : ''}, ${files.length} PNGs in ${OUT}, ${Math.round((Date.now() - started) / 1000)}s`);
await app.close();
cleanup();
