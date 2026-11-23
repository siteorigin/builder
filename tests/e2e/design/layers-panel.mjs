// Design capture harness for the Layers panel (left sidebar, Layers tab). Opt-in only, never part of
// `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/layers-panel.mjs
//
// It opens the business starter, then seeds the home page through the app's own edit seam
// (window.builder.project.apply) with a deeply nested section, a long layer name, a hidden layer and a
// project-made component, so every row treatment the panel has is on screen. Each state is verified
// after it settles; a state that did not render throws instead of writing a wrong image. Files are
// `{state}--{theme}.png`, clipped to the rail, the sidebar and the edge of the canvas.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('layers design capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'layers-panel');
mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-layers-')));
const THEMES = ['light', 'dark'];

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 900 });
await win.waitForSelector('.welcome');
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/**
 * Capture a state per theme. `prepare` runs after the theme is set (hover, a drag, a focus), and
 * `check` must be visible at the moment of capture. The image is clipped to the rail, the sidebar and
 * a strip of canvas, so the panel is legible and its link to the canvas selection still shows.
 */
async function shot(state, check, { themes = THEMES, prepare, canvas = 300 } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (prepare) await prepare();
    else {
      await win.mouse.move(1430, 890);
      await pause(150);
    }
    await pause(200);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const box = await win.locator('.side-panel').boundingBox();
    if (!box) throw new Error(`state "${state}": the sidebar is not on screen`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: { x: 0, y: 0, width: Math.round(box.x + box.width + canvas), height: 900 } });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

// ---- Project, seeded through the edit seam ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });

const seeded = await win.evaluate(async () => {
  const api = window.builder.project;
  const snap = await api.snapshot();
  const st = snap.state;
  const home = Object.values(st.pages).find((p) => p.route === '/') ?? Object.values(st.pages)[0];
  const owner = { kind: 'page', id: home.id };
  const apply = async (ops, label) => {
    const r = await api.apply({ operations: ops }, { label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results ?? [];
  };
  const one = async (op, label) => (await apply([{ owner, ...op }], label))[0]?.nodeId;
  // A blank section after the hero, nested six levels deep, with a long name on one container.
  const section = await one({ type: 'node.insert', componentId: 'layout.section', index: 1 }, 'Seed section');
  await one({ type: 'node.rename', nodeId: section, name: 'Spring 2026 renovation showcase for the Harbour Lane studio' }, 'Name');
  const wrap = await one({ type: 'node.insert', parentId: section, slot: 'content', primitive: 'container' }, 'Seed container');
  await one({ type: 'node.rename', nodeId: wrap, name: 'Project gallery wrapper' }, 'Name');
  await one({ type: 'node.insert', parentId: wrap, primitive: 'heading', text: 'Recent work' }, 'Seed heading');
  const row = await one({ type: 'node.insert', parentId: wrap, primitive: 'row' }, 'Seed row');
  const grid = await one({ type: 'node.insert', parentId: row, primitive: 'grid' }, 'Seed grid');
  const stack = await one({ type: 'node.insert', parentId: grid, primitive: 'stack' }, 'Seed stack');
  await one({ type: 'node.rename', nodeId: stack, name: 'Kitchen and dining room before-and-after card' }, 'Name');
  await one({ type: 'node.insert', parentId: stack, primitive: 'image' }, 'Seed image');
  const caption = await one({ type: 'node.insert', parentId: stack, primitive: 'paragraph', text: 'Timber cabinets, stone worktop.' }, 'Seed caption');
  await one({ type: 'node.insert', parentId: stack, primitive: 'button', text: 'See the project' }, 'Seed button');
  await one({ type: 'node.setStyle', nodeId: caption, scope: 'base', property: 'hidden', value: true }, 'Hide caption').catch(() => null);
  const second = await one({ type: 'node.insert', parentId: grid, primitive: 'stack' }, 'Seed stack 2');
  await one({ type: 'node.insert', parentId: second, primitive: 'image' }, 'Seed image 2');
  // A component made in this project ("Custom").
  const cta = await one({ type: 'node.insert', parentId: wrap, primitive: 'row' }, 'Seed cta');
  await one({ type: 'node.insert', parentId: cta, primitive: 'button', text: 'Book a consultation' }, 'Seed cta button');
  let custom = null;
  try {
    custom = await one({ type: 'component.createFromNode', nodeId: cta, name: 'Booking call-out' }, 'Make component');
  } catch (e) {
    custom = 'skipped: ' + String(e).slice(0, 120);
  }
  return { home: home.id, section, wrap, row, grid, stack, caption, custom };
});
console.log('seeded', JSON.stringify(seeded));
await pause(2500);

const rail = (name) => win.locator(`.rail [aria-label="${name}"]`);
const openRail = async (name) => {
  if ((await rail(name).getAttribute('aria-pressed')) !== 'true') await rail(name).click();
  // A pointer user's click leaves no focus ring; drop the rail button's focus so captures show the panel at rest.
  await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await pause(300);
};
const row = (text) => win.locator('[role="tree"] [role="treeitem"]', { hasText: text }).first();
const expand = async (text) => {
  const r = row(text);
  if ((await r.getAttribute('aria-expanded')) === 'false') await r.locator('.tree-toggle').click();
  await pause(150);
};
const clearSelection = async () => {
  await win.keyboard.press('Escape');
  await win.keyboard.press('Escape');
  await pause(300);
};

// 1. Rest: the page's outline, nothing selected, every branch closed.
await openRail('Layers');
await win.locator('[role="tree"]').waitFor();
await clearSelection();
await shot('layers-rest', '[role="tree"] [role="treeitem"]');

// 2. A section selected, another row hovered (its actions showing).
await row('Services grid').click();
await pause(500);
await shot('layers-selected-hover', '[role="tree"] [aria-selected="true"]', {
  prepare: async () => {
    await row('Logo strip').hover();
    await pause(200);
  }
});

// 3. A component instance opened, one of its parts selected.
await expand('Services grid');
await row('Card title').click();
await pause(600);
await shot('layers-part-selected', '[role="tree"] [aria-selected="true"]');
await row('Services grid').locator('.tree-toggle').click();
await pause(200);

// 4. Deep nesting: the seeded section opened to its deepest layer, which is selected; long names,
//    a hidden layer and a project component are all on screen.
await expand('Spring 2026');
await expand('Project gallery wrapper');
await expand('Row');
await expand('Grid');
await expand('Kitchen and dining');
await row('Button').click().catch(() => {});
await win.locator('[role="tree"] [role="treeitem"]', { hasText: 'See the project' }).first().click().catch(() => {});
await pause(600);
await shot('layers-deep', '[role="tree"] [aria-selected="true"]');

// 4b. The same at the narrowest sidebar (200px): the resizer dragged 60px to the left, then back.
{
  const handle = win.locator('.side-panel .resizer');
  const hb = await handle.boundingBox();
  const resize = async (dx) => {
    const b = await handle.boundingBox();
    await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await win.mouse.down();
    await win.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2, { steps: 6 });
    await win.mouse.up();
    await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await pause(300);
  };
  if (hb) {
    await resize(-60);
    await shot('layers-deep-narrow', '[role="tree"] [aria-selected="true"]', { themes: ['light'] });
    await resize(60);
  } else console.log('skipped layers-deep-narrow: no sidebar resizer');
}

// 5. Keyboard focus moved off the selection (focus ring on a different row from the selected one).
await shot('layers-keyboard-focus', '[role="tree"] [role="treeitem"]:focus-visible', {
  themes: ['light'],
  prepare: async () => {
    await win.locator('[role="tree"] [aria-selected="true"]').first().focus();
    await win.keyboard.press('ArrowUp');
    await win.keyboard.press('ArrowUp');
    await pause(200);
    await win.keyboard.press('ArrowLeft');
    await pause(200);
  }
});

// 6. The shared header selected (green, shared across pages).
await clearSelection();
await row('Header').click().catch(async () => {
  await win.locator('[role="tree"] [role="treeitem"]').first().click();
});
await pause(500);
await shot('layers-shell-selected', '[role="tree"] [aria-selected="true"]');

// 7. Row options menu, from the hover button.
await shot('layers-row-menu', '.menu', {
  themes: ['light'],
  prepare: async () => {
    const r = row('Services grid');
    await r.hover();
    await r.locator('.actions button').click();
    await pause(300);
  }
});
await win.keyboard.press('Escape');
await pause(200);

// 8. Inline rename.
await row('Logo strip').dblclick();
await pause(300);
await shot('layers-rename', '[role="tree"] input', { themes: ['light'], prepare: async () => {} });
await win.keyboard.press('Escape');
await pause(300);

// 9. Dragging: a section held over another, first between rows, then into a container.
async function dragOver(sourceText, targetText, rel) {
  const src = row(sourceText);
  const dst = row(targetText);
  const dt = await win.evaluateHandle(() => new DataTransfer());
  await src.dispatchEvent('dragstart', { dataTransfer: dt });
  const b = await dst.boundingBox();
  await dst.dispatchEvent('dragover', { dataTransfer: dt, clientX: b.x + 60, clientY: b.y + b.height * rel });
  await pause(200);
  return { src, dst, dt };
}
async function dragEnd({ src, dst, dt }) {
  await dst.dispatchEvent('dragleave', { dataTransfer: dt });
  await src.dispatchEvent('dragend', { dataTransfer: dt });
  await pause(200);
}
{
  let d;
  await shot('layers-drag-between', '[role="tree"] .drop-before, [role="tree"] .drop-after', {
    themes: ['light'],
    prepare: async () => {
      d = await dragOver('Logo strip', 'Split hero', 0.1);
    }
  });
  await dragEnd(d);
  await shot('layers-drag-into', '[role="tree"] [role="treeitem"][data-drop="inside"], [role="tree"] .drop-inside, [role="tree"] [role="treeitem"][style*="solid"]', {
    themes: ['light'],
    prepare: async () => {
      d = await dragOver('Logo strip', 'Spring 2026', 0.5);
    }
  });
  await dragEnd(d);
  await shot('layers-drag-first', '[role="tree"] .drop-after', {
    themes: ['light'],
    prepare: async () => {
      d = await dragOver('Logo strip', 'Project gallery wrapper', 0.85);
    }
  });
  await dragEnd(d);
}

// 10. Definition mode: editing a component everywhere (the panel lists the component's own layers).
await clearSelection();
await row('Services grid').click();
await pause(400);
const compSection = win.locator('.section-head', { hasText: 'Component' });
if ((await compSection.getAttribute('aria-expanded')) === 'false') await compSection.click();
await win.getByRole('button', { name: /Edit everywhere/ }).click();
await pause(300);
await win.getByRole('button', { name: /Make a copy and edit|Edit everywhere/ }).last().click();
await pause(1800);
await openRail('Layers');
{
  const first = win.locator('[role="tree"] [role="treeitem"]').first();
  if ((await first.getAttribute('aria-expanded')) === 'false') await first.locator('.tree-toggle').click();
  await pause(200);
  const rows = win.locator('[role="tree"] [role="treeitem"]');
  if ((await rows.count()) > 2) await rows.nth(2).click();
  await pause(500);
}
await shot('layers-definition', '.mode-band');
await win.locator('.mode-band-done').click();
await pause(800);

// 11. An empty page.
await openRail('Pages');
await win.locator('.side-panel .btn', { hasText: 'Add page' }).click();
await win.keyboard.type('Journal');
await win.keyboard.press('Enter');
await pause(1200);
await win.locator('.side-panel .list-item', { hasText: 'Journal' }).first().click();
await pause(1200);
const empty = await win.evaluate(async () => {
  const s = (await window.builder.project.snapshot()).state;
  const p = Object.values(s.pages).find((x) => x.title === 'Journal');
  if (!p) return null;
  for (const id of [...p.rootIds]) await window.builder.project.apply({ operations: [{ type: 'node.remove', owner: { kind: 'page', id: p.id }, nodeId: id }] }, { label: 'Empty' });
  return p.id;
});
await pause(800);
await openRail('Layers');
if (empty) await shot('layers-empty-page', '[role="tree"] .faint, [role="tree"] .layers-empty', { themes: ['light'] });
else console.log('skipped layers-empty-page: no page was created');

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`layers design capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
