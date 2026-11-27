// Design capture for slot authoring: the Turn into slot and Repeat as list dialogs, the review before a slot or a
// component is removed (RemovalReview.tsx), the Slots section a placed component shows in the Inspector, and the
// menu item that says why a container can't become a slot. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/slot-dialogs.mjs
//
// Each state is checked on screen after it settles and the harness throws rather than write an image of a state that
// did not render. Files are named `{state}--{theme}.png`.
import { mkdirSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createProject, eventually, launch, MOD, openInspector, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('slot dialogs capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT || !isAbsolute(OUT)) throw new Error('DESIGN_CAPTURE_DIR must be an absolute path outside the repository');
mkdirSync(OUT, { recursive: true });
// Reduced motion is not emulated: with it, leaving Component Studio crashes the renderer.
const THEMES = process.env.DESIGN_CAPTURE_THEMES ? process.env.DESIGN_CAPTURE_THEMES.split(',') : ['light', 'dark'];

const { WORK, cleanup } = scratch('design-slot-dialogs');
const { app, win, errors } = await launch(WORK, {}, { viewport: { width: 1440, height: 1000 } });
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = await createProject(win, { name: 'Harbour Bakery', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });
await openInspector(win);
const pause = (ms) => win.waitForTimeout(ms);
const modal = win.locator('.modal').last();
const inspector = win.locator('#dock-panel-inspect');
const menu = win.getByRole('menu');
const band = win.locator('.mode-band');
const written = [];

/** Capture `target` (the open dialog unless given) in each theme; every `texts` entry must be visible in it then. */
async function shot(state, texts, { target = modal, themes = THEMES, clip } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await win.mouse.move(2, 2);
    await pause(350);
    if (!(await target.isVisible())) throw new Error(`state "${state}" (${theme}): nothing to capture; refusing to write`);
    for (const text of [].concat(texts)) {
      const visible = await target.getByText(text).first().isVisible().catch(() => false);
      if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${text}"; refusing to write`);
    }
    const path = join(OUT, `${state}--${theme}.png`);
    if (clip) await win.screenshot({ path, clip: await clip() });
    else await target.screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
}

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const apply = async (operations, label) => {
  // Spaced out, as a person makes changes: a burst of them crashes the preview's renderer.
  await pause(400);
  return win.evaluate(
    async ([operations, label]) => {
      const r = await window.builder.project.apply({ operations, label });
      if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
      return r.results;
    },
    [operations, label]
  );
};
const openRail = async (name) => {
  const button = win.locator(`.rail [aria-label="${name}"]`);
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
};
const expand = async (title) => {
  const head = inspector.locator('.section-head', { hasText: title }).first();
  await head.waitFor();
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
};
async function closeModal() {
  await win.keyboard.press('Escape');
  await win.locator('.modal').first().waitFor({ state: 'detached', timeout: 10000 });
}
async function openStudio(name, defId) {
  await win.locator('.canvas').focus();
  await win.keyboard.press(`${MOD}+K`);
  await win.locator('.cmdk').waitFor();
  await win.keyboard.type(`${name} studio`);
  await win.locator('.cmdk [role="option"]', { hasText: 'in Component Studio' }).first().click();
  await band.filter({ hasText: `${name} in Component Studio` }).waitFor();
  await frame.locator(`[data-so-ctx="preview:${defId}|preview"]`).first().waitFor({ timeout: 60000 });
  await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
  await openRail('Layers');
  await pause(500);
}
async function leaveStudio() {
  await win.locator('.mode-band-done').click();
  await band.waitFor({ state: 'detached' });
  await pause(500);
}
const studioRow = (defId, nodeId) => win.locator(`[role="tree"] [data-owner="component:${defId}"][data-node="${nodeId}"]`);
async function selectInStudio(defId, nodeId) {
  await eventually(
    async () => {
      if ((await studioRow(defId, nodeId).getAttribute('aria-selected', { timeout: 500 }).catch(() => null)) !== 'true') {
        if (await studioRow(defId, nodeId).isVisible()) await studioRow(defId, nodeId).click();
        else await frame.locator(`[data-so-ctx="preview:${defId}|preview"] [data-so-node="${nodeId}"]`).first().dispatchEvent('click');
      }
      if ((await studioRow(defId, nodeId).getAttribute('aria-selected')) !== 'true') throw new Error(`${nodeId} is not selected`);
    },
    20000,
    500
  );
}
async function inspectorAction(item) {
  await inspector.getByRole('button', { name: /^More actions for / }).first().click();
  await menu.getByRole('menuitem', { name: item }).click();
  await modal.waitFor();
  await pause(400);
}

// ---- A populated bakery site ----
let st = await snapshot();
const homeId = st.site.homePageId;
const home = { kind: 'page', id: homeId };
await apply([{ type: 'page.create', title: 'Weekend markets and seasonal stalls', route: '/markets/', starter: 'empty' }], 'Add page');
await apply([{ type: 'page.create', title: 'Catering', route: '/catering/', starter: 'empty' }], 'Add page');
st = await snapshot();
const [marketsId, cateringId] = st.site.pageOrder.filter((p) => p !== homeId);
const markets = { kind: 'page', id: marketsId };
const catering = { kind: 'page', id: cateringId };

// Split: a two-column row, the side column holding the opening hours and a footnote container that holds nothing.
const [section, split, main, side, foot] = ['n_section01', 'n_split001', 'n_main0001', 'n_side0001', 'n_foot0001'];
await apply(
  [
    { type: 'node.insert', owner: home, newNodeId: section, parentId: null, componentId: 'layout.section' },
    { type: 'node.insert', owner: home, newNodeId: split, parentId: section, slot: 'content', primitive: 'row' },
    { type: 'node.insert', owner: home, newNodeId: main, parentId: split, primitive: 'stack' },
    { type: 'node.insert', owner: home, newNodeId: side, parentId: split, primitive: 'stack' },
    { type: 'node.insert', owner: home, newNodeId: foot, parentId: split, primitive: 'stack' },
    { type: 'node.rename', owner: home, nodeId: main, name: 'Main column' },
    { type: 'node.rename', owner: home, nodeId: side, name: 'Side column' },
    { type: 'node.rename', owner: home, nodeId: foot, name: 'Footnote' },
    { type: 'node.insert', owner: home, parentId: main, primitive: 'heading', text: 'Welcome to the bakery' },
    { type: 'node.insert', owner: home, parentId: main, primitive: 'paragraph', text: 'Sourdough, rye and seeded loaves, baked before dawn.' },
    { type: 'node.insert', owner: home, parentId: side, primitive: 'heading', text: 'Opening hours' },
    { type: 'node.insert', owner: home, parentId: side, primitive: 'paragraph', text: 'Mon to Fri, 7 to 6' }
  ],
  'Build the split'
);
const [{ definitionId: splitDef }] = await apply([{ type: 'component.createFromNode', owner: home, nodeId: split, name: 'Opening split' }], 'Create Split');
const splitNodes = (await snapshot()).components[splitDef].tree.nodes;
const sideId = Object.values(splitNodes).find((n) => n.name === 'Side column').id;
const footId = Object.values(splitNodes).find((n) => n.name === 'Footnote').id;
/** A Section at the end of `owner`, for a placement to go in. */
const sectionOn = async (owner) => (await apply([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }], 'Add a Section'))[0].nodeId;
const marketsSection = await sectionOn(markets);
const cateringSection = await sectionOn(catering);
await apply([{ type: 'node.insert', owner: markets, parentId: marketsSection, slot: 'content', definitionId: splitDef }], 'Place split');
await apply([{ type: 'node.insert', owner: catering, parentId: cateringSection, slot: 'content', definitionId: splitDef }], 'Place split');

// Promo panel: designed but not placed anywhere yet.
const [{ definitionId: promoDef, rootNodeId: promoRoot }] = await apply([{ type: 'component.create', name: 'Promo panel' }], 'Create Promo panel');
const promo = { kind: 'component', id: promoDef };
const promoBody = 'n_pbody001';
await apply(
  [
    { type: 'node.insert', owner: promo, newNodeId: promoBody, parentId: promoRoot, primitive: 'stack' },
    { type: 'node.rename', owner: promo, nodeId: promoBody, name: 'Offer body' },
    { type: 'node.insert', owner: promo, parentId: promoBody, primitive: 'heading', text: 'Half-price loaves after 4pm' },
    { type: 'node.insert', owner: promo, parentId: promoBody, primitive: 'paragraph', text: 'Every weekday, while they last.' }
  ],
  'Build Promo panel'
);

// Feature cards: a grid holding one static card, placed twice.
const [{ definitionId: cardsDef, rootNodeId: cardsRoot }] = await apply([{ type: 'component.create', name: 'Feature cards' }], 'Create Feature cards');
const cards = { kind: 'component', id: cardsDef };
const [grid, card] = ['n_grid0001', 'n_card0001'];
await apply(
  [
    { type: 'node.insert', owner: cards, newNodeId: grid, parentId: cardsRoot, primitive: 'grid' },
    { type: 'node.insert', owner: cards, newNodeId: card, parentId: grid, primitive: 'container' },
    { type: 'node.rename', owner: cards, nodeId: card, name: 'Card' },
    { type: 'node.insert', owner: cards, parentId: card, primitive: 'icon' },
    { type: 'node.insert', owner: cards, parentId: card, primitive: 'heading', text: 'Baked fresh' },
    { type: 'node.insert', owner: cards, parentId: card, primitive: 'paragraph', text: 'Every loaf is shaped by hand.' },
    { type: 'node.insert', owner: cards, parentId: card, primitive: 'button', text: 'Read more' },
    { type: 'node.insert', owner: home, parentId: section, slot: 'content', definitionId: cardsDef },
    { type: 'node.insert', owner: markets, parentId: marketsSection, slot: 'content', definitionId: cardsDef }
  ],
  'Build Feature cards'
);

// Offer card: a card with Media, Actions, Body and Quiet slots, placed on Home, Weekend markets and Catering.
const [{ definitionId: offerDef }] = await apply(
  [
    {
      type: 'component.upsert',
      name: 'Offer card',
      insertAs: 'element',
      properties: {},
      slots: {
        media: { label: 'Media', description: 'A photo above the words, cropped to the card.', primitives: ['image'], max: 1 },
        actions: { label: 'Actions', primitives: ['link', 'text'], max: 2 },
        body: { label: 'Body' },
        quiet: { label: 'Quiet', max: 0 }
      },
      nodes: [
        { kind: 'element', id: 'root', tag: 'article', children: ['media', 'body', 'actions', 'quiet'] },
        { kind: 'slot', id: 'media', slot: 'media' },
        { kind: 'slot', id: 'actions', slot: 'actions' },
        { kind: 'slot', id: 'body', slot: 'body' },
        { kind: 'slot', id: 'quiet', slot: 'quiet' }
      ]
    }
  ],
  'Make Offer card'
);
const [{ nodeId: offerSection }] = await apply([{ type: 'node.insert', owner: home, parentId: null, componentId: 'layout.section' }], 'Add a Section');
const [{ nodeId: offer }] = await apply([{ type: 'node.insert', owner: home, parentId: offerSection, slot: 'content', definitionId: offerDef }], 'Place Offer card');
await apply(
  [
    { type: 'node.insert', owner: home, parentId: offer, slot: 'body', primitive: 'heading', text: 'Seeded rye, sourdough and our long-proved country loaf' },
    { type: 'node.insert', owner: home, parentId: offer, slot: 'body', primitive: 'paragraph', text: 'Order by noon for next-day collection.' },
    { type: 'node.insert', owner: home, parentId: offer, slot: 'actions', primitive: 'button', text: 'Order online' },
    { type: 'node.insert', owner: home, parentId: offer, slot: 'actions', primitive: 'paragraph', text: 'Or call the shop' }
  ],
  'Fill Offer card'
);
const [{ nodeId: offerMarkets }] = await apply([{ type: 'node.insert', owner: markets, parentId: marketsSection, slot: 'content', definitionId: offerDef }], 'Place Offer card');
await apply([{ type: 'node.insert', owner: markets, parentId: offerMarkets, slot: 'actions', primitive: 'button', text: 'Find our stall' }], 'Fill Offer card');
await pause(1500);

// ---- Repeat as list ----
await openStudio('Feature cards', cardsDef);
await selectInStudio(cardsDef, card);
await inspectorAction('Repeat as list…');
await shot('repeat-rest', ['Repeat as list', 'List name']);
await closeModal();
await leaveStudio();

// ---- Turn into slot ----
await openStudio('Promo panel', promoDef);
await selectInStudio(promoDef, promoBody);
await inspectorAction('Turn into slot…');
await shot('turn-unplaced', ['Turn into slot', 'Slot name']);
await closeModal();
await leaveStudio();

await openStudio('Opening split', splitDef);
await selectInStudio(splitDef, footId);
await inspectorAction('Turn into slot…');
await shot('turn-empty', ['Turn into slot', 'Slot name']);
await closeModal();
await selectInStudio(splitDef, sideId);
await inspectorAction('Turn into slot…');
await shot('turn-move', ['Move it into each placement', 'Leave the slot empty']);
// Every placement removed while it is open: moving is no longer a way, and the dialog says why.
st = await snapshot();
const placementsOf = (pageId) => Object.values(st.pages[pageId].nodes).filter((n) => n.definitionId === splitDef).map((n) => ({ type: 'node.remove', owner: { kind: 'page', id: pageId }, nodeId: n.id }));
await apply([...placementsOf(homeId), ...placementsOf(marketsId), ...placementsOf(cateringId)], 'Remove the splits');
await shot('turn-move-off', ['isn’t placed anywhere now']);
await win.getByRole('radio', { name: 'Leave the slot empty' }).check();
await shot('turn-move-off-chosen', ['Leave the slot empty'], { themes: ['light'] });
await closeModal();
await leaveStudio();


// ---- The Slots section of a placed component ----
await openRail('Layers');
await win.locator(`[role="tree"] [data-owner="page:${homeId}"][data-node="${offerSection}"]`).click();
await inspector.locator('[data-instance-slot="content"]').getByRole('button', { name: 'Select Offer card' }).click();
await eventually(async () => {
  if ((await inspector.locator('.insp-name h3').innerText()) !== 'Offer card') throw new Error('Offer card is not selected');
});
await expand('Slots');
const slotsSection = inspector.locator('.section', { has: win.locator('[data-instance-slot]') }).first();
await slotsSection.scrollIntoViewIfNeeded();
await shot('placed-slots', ['Media', 'Order online', 'This slot takes no content.'], { target: slotsSection });
await inspector.getByRole('button', { name: 'Add to Body', exact: true }).click();
await win.getByTestId('quick-insert').waitFor();
await pause(300);
await shot('placed-slots-add-open', ['Media'], {
  target: slotsSection,
  clip: async () => {
    const a = await slotsSection.boundingBox();
    const b = await win.getByTestId('quick-insert').boundingBox();
    const x = Math.min(a.x, b.x) - 8;
    const y = Math.min(a.y, b.y) - 8;
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x + 8, height: Math.max(a.y + a.height, b.y + b.height) - y + 8 };
  }
});
await win.keyboard.press('Escape');
await win.getByTestId('quick-insert').waitFor({ state: 'detached' });

// ---- Delete component: still in use ----
await openRail('Insert');
const sidePanel = win.locator('.side-panel-view:not([hidden])');
await sidePanel.locator('.insert-group[data-kind="component"]').waitFor();
await sidePanel.getByRole('button', { name: 'Manage Offer card', exact: true }).click();
await win.getByRole('menuitem', { name: /^Delete component/ }).click();
await modal.waitFor();
await pause(400);
await shot('removal-component-used', ['Offer card is still in use', 'Go to placement']);
// Every placement removed while it is open: nothing is in the way any more.
st = await snapshot();
await apply(
  [
    { type: 'node.remove', owner: home, nodeId: offer },
    { type: 'node.remove', owner: markets, nodeId: offerMarkets }
  ],
  'Remove the Offer cards'
);
await shot('removal-component-unused', ['Nothing uses it now']);
await closeModal();
// One Undo puts both placements back.
await win.locator('.canvas').focus();
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => {
  const now = await snapshot();
  if (!Object.values(now.pages[homeId].nodes).some((n) => n.definitionId === offerDef)) throw new Error('the Undo has not landed');
}, 15000);

// ---- Remove a slot that placements fill ----
await openStudio('Offer card', offerDef);
await selectInStudio(offerDef, 'root');
await expand('Slots');
await inspector.locator('[data-slot="actions"]').getByRole('button', { name: 'Remove Actions' }).click();
await modal.waitFor();
await pause(400);
await shot('removal-slot-content', ['Remove the Actions slot?', 'Go to placement']);
st = await snapshot();
const heldIn = (pageId, nodeId) => st.pages[pageId].nodes[nodeId]?.slots?.actions ?? [];
const offerNow = Object.values(st.pages[homeId].nodes).find((n) => n.definitionId === offerDef).id;
const marketsNow = Object.values(st.pages[marketsId].nodes).find((n) => n.definitionId === offerDef).id;
await apply(
  [...heldIn(homeId, offerNow).map((id) => ({ type: 'node.remove', owner: home, nodeId: id })), ...heldIn(marketsId, marketsNow).map((id) => ({ type: 'node.remove', owner: markets, nodeId: id }))],
  'Clear Actions'
);
await shot('removal-slot-empty', ['No placement holds content in it now']);
await closeModal();

// ---- Turn into slot, refused in a menu ----
await studioRow(offerDef, 'root').click({ button: 'right' });
const refusedItem = menu.getByRole('menuitem', { name: 'Turn into slot…' });
await refusedItem.waitFor();
await shot('turn-menu-refused', ['Turn into slot…'], {
  target: menu,
  clip: async () => {
    const b = await menu.boundingBox();
    return { x: b.x - 12, y: b.y - 12, width: b.width + 24, height: b.height + 24 };
  }
});
await win.keyboard.press('Escape');
await menu.waitFor({ state: 'detached' });


if (errors.length) throw new Error(`uncaught errors in the editor: ${errors.join('; ')}`);
await app.close();
const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
for (const path of written) if (!files.includes(path.slice(OUT.length + 1))) throw new Error(`${path} was not written`);
console.log(`\nslot dialogs capture: ${written.length} images in ${OUT}`);
cleanup();
