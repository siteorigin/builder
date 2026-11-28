// Design capture for how the Content workspace names the collection it shows: the sidebar's head (the collection
// menu or heading), the toolbar's place after the project name, and the Inspector's and AI composer's "nothing open"
// states, for a renamed blog (Journal, whose entries are essays), another collection, and a long name. Opt-in only,
// never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/content-heading.mjs
//
// Drives the real (built) app and writes `{state}--{theme}.png`, each the whole window. Every capture checks its
// state on screen after it settles and throws rather than writing a wrong image.
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, launch, openInspector, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('content heading capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'content-heading');
mkdirSync(OUT, { recursive: true });
const { WORK, cleanup } = scratch('content-heading');
const { app, win } = await launch(WORK);
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
const panel = win.locator('.posts-panel');
const LIGHT = ['light'];
const BOTH = ['light', 'dark'];

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/** Capture the whole window once `check` is visible and, when given, `expect` holds for what the head and toolbar say. */
async function shot(state, check, themes = LIGHT, { keepPointer = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (!keepPointer) await win.mouse.move(900, 880);
    await pause(200);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path });
    written.push(path);
    const head = await panel.locator('.panel-head').first().innerText().catch(() => '');
    const place = await win.locator('.project-title').innerText().catch(() => '');
    console.log('wrote', path, '| head:', JSON.stringify(head.replace(/\s+/g, ' ').trim()), '| toolbar:', JSON.stringify(place.replace(/\s+/g, ' ').trim()));
  }
  await setTheme('light');
}
const apply = async (operations, label) => {
  const r = await win.evaluate(({ operations, label }) => window.builder.project.apply({ operations }, { label }), { operations, label });
  if (!r?.ok) throw new Error(`${label}: ${JSON.stringify(r?.error)}`);
  await pause(700);
};
/** Show a collection from the head's collection menu (its trigger is the head's first button). */
async function showCollection(name) {
  await panel.locator('.posts-head-title button').first().click();
  await win.getByRole('menuitemradio', { name: new RegExp(`^${name}`) }).click();
  await pause(600);
}
const openRow = (title) => panel.locator('[data-post]', { hasText: title }).first().click({ position: { x: 48, y: 12 } });

try {
  // Appearance follows the system, whose scheme each capture emulates.
  await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
  // A placeholder key, never sent: the AI panel shows its composer, whose target chip names what a message is about.
  await win.evaluate(() => window.builder.ai.setKey('openai', 'sk-e2e-placeholder-never-sent'));
  await win.reload();
  await win.waitForSelector('.welcome');
  await createProject(win, { name: 'Montclair & Finch', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
  await pause(800);
  await win.locator('.rail [aria-label="Content"]').click();
  await pause(400);
  await openInspector(win);

  // The blog, renamed before its first entry: Journal, whose entries are essays. The only collection, so the head is a
  // heading rather than a menu.
  await apply([{ type: 'collection.create', collectionId: 'posts', name: 'Journal', singularName: 'Essay' }], 'Start the journal');
  await panel.locator('.posts-empty').waitFor({ timeout: 15000 });
  await shot('renamed-empty', '.posts-panel .posts-empty');
  // Its composer: with nothing to open yet, the chip points to the first essay.
  await win.locator('#dock-tab-chat').click();
  await win.locator('.composer .scope-chip').waitFor({ timeout: 10000 });
  await shot('renamed-empty-ai', '.composer .scope-chip');
  await openInspector(win);

  await apply(
    [
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_essay01', title: 'On living with fewer, better things', publishedAt: '2026-10-18', draft: false, author: 'Rosa Finch', excerpt: 'What a decade of clients taught us about keeping less.', body: ['What a decade of clients taught us about keeping less.'] },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_essay02', title: 'The case for a north-facing kitchen', publishedAt: '2026-09-02', draft: true, author: 'Theo Montclair', excerpt: 'Even light all day, and no glare at the bench.', body: ['Even light all day, and no glare at the bench.'] }
    ],
    'Write two essays'
  );
  await panel.locator('[data-post]').first().waitFor({ timeout: 15000 });
  await shot('renamed-single', '.posts-panel [data-post]');

  // Two more collections, so the head becomes the collection menu.
  await apply(
    [
      { type: 'collection.create', collectionId: 'advisors', name: 'Advisors', singularName: 'Advisor', kind: 'structured' },
      { type: 'entry.create', collectionId: 'advisors', entryId: 'en_adv01', title: 'Rosa Finch' },
      { type: 'entry.create', collectionId: 'advisors', entryId: 'en_adv02', title: 'Theo Montclair' },
      { type: 'collection.create', collectionId: 'properties', name: 'Properties', singularName: 'Property', kind: 'structured' },
      ...['14 Harbour Lane', 'The Old Mill', 'Kōwhai Terrace', 'Wharf Street loft'].map((title, i) => ({ type: 'entry.create', collectionId: 'properties', entryId: `en_prop0${i}`, title }))
    ],
    'Add Advisors and Properties'
  );
  await panel.locator('.posts-head-title button').first().waitFor({ timeout: 15000 });
  await shot('renamed-rest', '.posts-panel [data-post]', BOTH);

  // The collection menu open: the checked collection and the head should agree.
  await panel.locator('.posts-head-title button').first().click();
  await pause(300);
  await shot('renamed-switcher', '.menu [role="menuitemradio"]', LIGHT, { keepPointer: true });
  await win.keyboard.press('Escape');
  await pause(200);

  // The head's options for the renamed blog.
  await panel.locator('.posts-head-options').click();
  await pause(300);
  await shot('renamed-options', '.menu', LIGHT, { keepPointer: true });
  await win.keyboard.press('Escape');
  await pause(200);

  // Another collection shown, with nothing open: the toolbar and Inspector should name it, as the head does.
  await showCollection('Advisors');
  await panel.locator('[data-post]', { hasText: 'Theo Montclair' }).waitFor({ timeout: 10000 });
  await shot('other-shown', '.posts-panel [data-post]');

  // An essay open: the toolbar names it.
  await showCollection('Journal');
  await openRow('On living with fewer');
  await win.locator('.post-body').waitFor({ timeout: 20000 });
  await pause(800);
  await shot('renamed-open', '.posts-panel [data-post][aria-selected="true"]');

  // A long name, with nothing open (choosing another collection lets go of the open essay).
  await apply([{ type: 'collection.update', collectionId: 'posts', name: 'Field notes from the studio floor', singularName: 'Field note' }], 'Rename the journal');
  await showCollection('Advisors');
  await showCollection('Field notes');
  await shot('long-name', '.posts-panel [data-post]');
  // Its collection menu: the whole name, checked, is the keyboard's way to read a name the head cuts short.
  await panel.locator('.posts-head-title button').first().focus();
  await win.keyboard.press('Enter');
  await pause(300);
  await shot('long-name-switcher', '.menu [role="menuitemradio"][aria-checked="true"]', LIGHT, { keepPointer: true });
  await win.keyboard.press('Escape');
  await pause(200);

  // The AI composer, with nothing open: its target chip for the renamed blog, then for another collection.
  await apply([{ type: 'collection.update', collectionId: 'posts', name: 'Journal', singularName: 'Essay' }], 'Name it Journal again');
  await win.locator('#dock-tab-chat').click();
  await win.locator('.composer').waitFor({ timeout: 10000 });
  await pause(400);
  await shot('renamed-ai', '.composer .scope-chip');
  await showCollection('Advisors');
  await shot('other-ai', '.composer .scope-chip');
  await openInspector(win);
  await showCollection('Journal');

  // The default name, for comparison: nothing renamed.
  await apply([{ type: 'collection.update', collectionId: 'posts', name: 'Posts', singularName: null }], 'Back to Posts');
  await shot('default-rest', '.posts-panel [data-post]');
} finally {
  await app.close().catch(() => {});
}
// Only a run that passed lets go of its scratch folder; a failed one keeps it for inspection (harness scratch()).
cleanup();

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`content heading capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
