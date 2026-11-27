// The Signal theme pack against the real app (#391): a Business project switches to Signal from Site styles, which
// then shows Signal's own built thumbnail, as Insert does for every section; the home page's Services grid is a bento
// in the live preview; every page passes the layout inspection the assistant runs, at phone and desktop widths, with
// nothing Foundation's own pages do not already report; and switching back leaves the pages exactly as they were.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('signal-theme');
const root = process.cwd();
const release = join(root, 'resources', 'packs', 'signal');
const manifest = JSON.parse(readFileSync(join(release, 'pack.json'), 'utf8'));
assert.ok(manifest.previews['hero.split']?.default, 'the Signal release is built with its thumbnails (npm run build)');
const shotUrl = (file) => `data:image/webp;base64,${readFileSync(join(release, file)).toString('base64')}`;

const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Northwind Field', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const panel = win.locator('.side-panel-view:not([hidden])');

/** Findings that mean a page does not pass: anything but an image still loading. */
const NOT_FINDINGS = new Set(['image-unverified']);
const WIDTHS = [390, 1280];
/** Every page measured at both widths, as inspect_layout measures it; each finding keyed by what it is and where. */
async function inspectAll(label) {
  const state = await snapshot();
  const out = new Map();
  for (const page of Object.values(state.pages))
    for (const width of WIDTHS) {
      const report = await withTimeout(win.evaluate(([id, w]) => window.builderTest.inspectLayout(id, w), [page.id, width]), 90000, `${label}: ${page.route} at ${width}px`);
      assert.ok(report && !report.error, `${label}: ${page.route} at ${width}px was inspected: ${JSON.stringify(report)}`);
      assert.equal(report.viewportWidth, width, `${label}: ${page.route} measured at ${width}px`);
      assert.ok(report.checks && report.checks.contrast.checked > 0, `${label}: ${page.route} at ${width}px ran the readability checks`);
      for (const k of ['contrast', 'overlaps', 'clippedText', ...(width < 768 ? ['tapTargets'] : [])]) assert.ok(!report.checks[k].incomplete, `${label}: ${page.route} at ${width}px measured every ${k} candidate`);
      if (width < 768) assert.ok(report.checks.tapTargets.checked > 0 && !report.checks.tapTargets.skipped, `${label}: ${page.route} at ${width}px measured its tap targets`);
      for (const f of report.issues.filter((i) => !NOT_FINDINGS.has(i.kind))) {
        const where = f.ref ? `${f.ref.owner.kind}:${f.ref.owner.id}/${f.ref.partId ?? f.ref.nodeId}` : (f.text ?? '');
        // How many elements a finding stands for counts too: a second small link under the same part is a new failure.
        const key = `${page.route} ${width}px ${f.kind} ${where}`;
        out.set(key, (out.get(key) ?? 0) + (f.count ?? 1));
      }
    }
  return out;
}
const list = (m) => [...m].map(([k, n]) => `${k} ×${n}`).join('\n') || '(none)';

/** Wait until the preview shows the theme: its display font on the page's first heading, from its own files. */
async function shows(font) {
  await eventually(
    async () => {
      const family = await frame.locator('h1').first().evaluate(async (h) => {
        await document.fonts.ready;
        return getComputedStyle(h).fontFamily;
      });
      assert.match(family, font);
    },
    30000,
    300
  );
}

step('Foundation: the stock Business project, measured as the baseline');
const before = await snapshot();
assert.equal(before.site.themeId, 'foundation');
assert.ok(Object.keys(before.pages).length >= 3, 'a multi-page project');
const baseline = await inspectAll('Foundation');
console.log(`Foundation findings:\n${list(baseline)}`);
// The stock project reports links under 44px tall at phone width (the header's and footer's, the contact methods'),
// and nothing else: no overflow, unreadable text, clipping or overlap, and no broken image or heading order.
for (const key of baseline.keys()) assert.match(key, / 390px small-tap-target /, `Foundation's stock pages report only small links at phone width:\n${list(baseline)}`);

step('Site styles switches the project to Signal and shows its built thumbnail');
await win.locator('.dock-tab', { hasText: 'Styles' }).click();
const meta = win.locator('#dock-panel-styles .ss-theme');
await meta.waitFor();
// The chooser pictures every theme by its own thumbnail; picking Signal shows it larger before the switch.
await meta.getByRole('button', { name: 'Change theme' }).click();
const signalRow = meta.locator('[data-theme-option="signal"]');
await eventually(async () => assert.equal(await signalRow.locator('img.ss-theme-shot').getAttribute('data-theme'), 'signal', 'Signal’s row shows its own thumbnail'), 15000);
await signalRow.click();
const shot = meta.locator('.ss-theme-preview img.ss-theme-shot');
await eventually(async () => assert.equal(await shot.getAttribute('data-theme'), 'signal', 'the picked theme is pictured before the switch'), 15000);
await eventually(
  async () => {
    const img = await shot.evaluate((i) => ({ src: i.src, ok: i.complete && i.naturalWidth === 320 }));
    assert.ok(img.ok, 'the thumbnail is a decoded image');
    assert.equal(img.src, shotUrl(manifest.previews['hero.split'].default), 'it is Signal’s own split hero, as its release drew it');
  },
  15000
);
await meta.screenshot({ path: join(SHOTS, 'signal-site-styles.png') });
await meta.getByRole('button', { name: 'Use Signal' }).click();
await eventually(async () => assert.deepEqual((await snapshot()).themeLock.theme, { id: 'signal', version: '0.1.0' }, 'the site is on Signal'));
await shows(/Sora Variable/);
await eventually(async () => assert.match(await meta.locator('.ss-theme-receipt').innerText(), /Switched from Foundation/, 'the card says the switch happened, with its Undo'));

step('the pages hold what they held, now drawn by Signal');
const onSignal = await snapshot();
assert.deepEqual(JSON.parse(JSON.stringify(onSignal.pages).replace(/"definitionId":"signal\./g, '"definitionId":"foundation.')), before.pages, 'every page, route, word and image is kept');
assert.deepEqual(onSignal.assets, before.assets, 'the library is kept');

step('Insert shows Signal’s thumbnails for its sections and variants');
await win.getByRole('button', { name: 'Insert', exact: true }).click();
const tiles = panel.locator('.insert-group[data-kind="section"] .insert-tile.section');
const split = tiles.filter({ has: win.locator('strong', { hasText: /^Split hero$/ }) }).locator('img.insert-shot');
await eventually(async () => assert.equal(await split.getAttribute('src'), shotUrl(manifest.previews['hero.split'].default), 'the Split hero tile shows Signal’s thumbnail'), 15000);
const shots = tiles.locator('img.insert-shot');
await eventually(async () => assert.ok((await shots.evaluateAll((imgs) => imgs.length >= 18 && imgs.every((i) => i.complete && i.naturalWidth === 320))), 'every section tile has a decoded thumbnail'), 15000);
const variants = panel.getByRole('button', { name: 'Variants' });
await variants.click();
const darkFeatures = panel.getByRole('button', { name: /^Services grid, Dark(?:,|$)/ }).locator('img');
await eventually(async () => assert.equal(await darkFeatures.getAttribute('src'), shotUrl(manifest.previews['features.grid'].variants.tone.inverse)), 15000);
await variants.click();
await panel.locator('.insert-group[data-kind="section"]').first().screenshot({ path: join(SHOTS, 'signal-insert.png') });

step('the home page’s Services grid is a bento: its first card takes the room of two');
const bento = await frame.locator('[class*="so-signal-features-grid__bento"]').first().evaluate((grid) => {
  const [first, second] = [...grid.children].map((c) => c.getBoundingClientRect());
  const title = grid.children[0].querySelector('h3').getBoundingClientRect();
  return { width: innerWidth, grid: grid.getBoundingClientRect().width, first: { w: first.width, h: first.height, titleAt: (title.top - first.top) / first.height }, second: { w: second.width, h: second.height }, cards: grid.children.length };
});
assert.ok(bento.cards >= 3, `the grid has three or more cards: ${JSON.stringify(bento)}`);
if (bento.width >= 1024) {
  assert.ok(bento.first.w > bento.second.w * 1.8 && bento.first.h > bento.second.h * 1.8, `two columns and two rows wide on desktop: ${JSON.stringify(bento)}`);
  assert.ok(bento.first.titleAt > 0.5, `the tall tile sets its words at its foot: ${JSON.stringify(bento)}`);
} else if (bento.width >= 768) {
  assert.ok(Math.abs(bento.first.w - bento.grid) < 1 && bento.second.w < bento.grid * 0.6, `the full row on tablet: ${JSON.stringify(bento)}`);
} else assert.ok(Math.abs(bento.first.w - bento.second.w) < 1, `one card a row on a phone: ${JSON.stringify(bento)}`);
await frame.locator('[class*="so-signal-features-grid__root"]').first().screenshot({ path: join(SHOTS, 'signal-bento.png') });

step('every Signal page passes the layout inspection at 390px and 1280px');
const signal = await inspectAll('Signal');
console.log(`Signal findings:\n${list(signal)}`);
const added = [...signal].filter(([k, n]) => n > (baseline.get(k) ?? 0)).map(([k]) => k);
assert.deepEqual(added, [], `Signal reports nothing Foundation's own pages do not:\n${list(signal)}`);

step('a dark Services grid keeps its light cards’ links in the theme’s own colours');
const home = onSignal.site.homePageId;
const features = Object.values(onSignal.pages[home].nodes).find((n) => n.kind === 'instance' && onSignal.components[n.definitionId].componentId === 'features.grid');
const firstCard = features.props.items[0].id;
const apply = (operations, label) => win.evaluate(async ([operations, label]) => (await window.builder.project.apply({ operations, label })).ok, [operations, label]);
const owner = { kind: 'page', id: home };
assert.ok(await apply([{ type: 'instance.setVariant', owner, nodeId: features.id, axis: 'tone', variant: 'inverse' }], 'Dark services'));
assert.ok(await apply([{ type: 'instance.setProp', owner, nodeId: features.id, prop: 'items', itemId: firstCard, field: 'linkLabel', value: 'See planning' }, { type: 'instance.setProp', owner, nodeId: features.id, prop: 'items', itemId: firstCard, field: 'link', value: { type: 'page', target: home } }], 'Card link'));
await eventually(
  async () => {
    const ink = await frame.locator('[class*="so-signal-features-grid__card-link"]').first().evaluate((a) => ({ color: getComputedStyle(a).color, brand: getComputedStyle(document.documentElement).getPropertyValue('--so-color-brand').trim() }));
    assert.equal(ink.color, 'rgb(67, 56, 202)', `the card's text link is in the brand colour, not the dark section's light ink: ${JSON.stringify(ink)}`);
  },
  30000,
  300
);
for (const width of WIDTHS) {
  const report = await withTimeout(win.evaluate(([id, w]) => window.builderTest.inspectLayout(id, w), [home, width]), 90000, `dark services at ${width}px`);
  const unreadable = report.issues.filter((i) => ['low-contrast', 'contrast-unverified'].includes(i.kind));
  assert.deepEqual(unreadable, [], `nothing on the dark Services grid is hard to read at ${width}px`);
}
await win.evaluate(() => window.builder.project.undo());
await win.evaluate(() => window.builder.project.undo());
await eventually(async () => assert.deepEqual((await snapshot()).pages, onSignal.pages, 'the two edits are undone'));

step('switching back to Foundation leaves the project as it was');
await win.locator('.dock-tab', { hasText: 'Styles' }).click();
await meta.getByLabel('Theme').selectOption('foundation');
await eventually(async () => assert.equal((await snapshot()).site.themeId, 'foundation'));
await shows(/Fraunces Variable/);
const foundationShot = () => {
  const dir = join(root, 'resources', 'packs', 'foundation');
  const file = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8')).previews['hero.split'].default;
  return `data:image/webp;base64,${readFileSync(join(dir, file)).toString('base64')}`;
};
await eventually(async () => {
  assert.equal(await shot.getAttribute('data-theme'), 'foundation');
  assert.equal(await shot.getAttribute('src'), foundationShot(), 'Site styles pictures Foundation again, from its own release');
}, 15000);
const after = await snapshot();
assert.deepEqual(after.pages, before.pages, 'the pages are exactly as they were');
assert.deepEqual(after.site.shell, before.site.shell, 'so are the header and footer');
assert.deepEqual(after.components, before.components, 'and the components');
const back = await inspectAll('Foundation again');
assert.deepEqual([...back].sort(), [...baseline].sort(), 'and the inspection reports what it did before');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nsignal-theme: passed');
