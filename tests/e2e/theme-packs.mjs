// Theme packs against the real app (#159): the built Foundation release loads with its thumbnails, which Insert
// shows for every section and variant; a pack the person installed in userData/packs loads beside it while a
// malformed one is refused with its reason; and switching to the installed pack copies its fonts into the
// project and serves them in the preview, without touching the project's package files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('theme-packs');
const root = process.cwd();

step('an installed pack, made from the built Foundation release, and a malformed one beside it');
const built = join(root, 'resources', 'packs', 'foundation');
assert.ok(existsSync(join(built, 'pack.json')), 'the Foundation release is built (npm run build)');
const packs = join(WORK, 'userdata', 'packs');
const atelier = join(packs, 'atelier');
cpSync(built, atelier, { recursive: true });
const m = JSON.parse(readFileSync(join(atelier, 'pack.json'), 'utf8'));
m.id = 'atelier';
m.name = 'Atelier';
m.version = '1.0.0';
m.description = 'A test pack with its own display font.';
for (const c of m.components) {
  c.id = `atelier.${c.componentId}`;
  c.provenance = { ...c.provenance, pack: 'atelier', packVersion: '1.0.0' };
}
const display = m.tokens.find((t) => t.id === 'font.display');
display.value = m.fonts.find((f) => f.name === 'Space Grotesk').stack;
// It ships two fonts: the body font and its own display font. The other files go.
m.fonts = m.fonts.filter((f) => ['Inter', 'Space Grotesk'].includes(f.name));
const kept = new Set([...m.fonts.flatMap((f) => f.faces.map((x) => x.file)), ...Object.values(m.previews).flatMap((p) => [p.default, ...Object.values(p.variants ?? {}).flatMap(Object.values)])]);
for (const f of Object.keys(m.files)) if (!kept.has(f)) {
  delete m.files[f];
  rmSync(join(atelier, f));
}
writeFileSync(join(atelier, 'pack.json'), JSON.stringify(m, null, '\t'));
const digest = createHash('sha256').update(readFileSync(join(atelier, 'pack.json'))).digest('hex');
mkdirSync(join(packs, 'broken'));
writeFileSync(join(packs, 'broken', 'pack.json'), '{ "id": "broken", ');

const { app, win, errors } = await launch(WORK);
const refusedOnWelcome = win.locator('.welcome-packs');
await refusedOnWelcome.locator('summary').click();
assert.match(await refusedOnWelcome.innerText(), /1 theme pack could not be loaded[^]*broken[^]*pack\.json is not valid JSON/, 'Welcome says which pack was refused and why');

const site = join(WORK, 'sites', 'pack-studio');
const frame = await createProject(win, { name: 'Pack Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const panel = win.locator('.side-panel-view:not([hidden])');

step('Insert shows the pack thumbnails and a layout sketch for the empty Section');
await win.getByRole('button', { name: 'Insert', exact: true }).click();
const tiles = panel.locator('.insert-group[data-kind="section"] .insert-tile.section');
const shots = tiles.locator('img.insert-shot');
const sketches = tiles.filter({ has: win.locator('.sparse .sketch') });
await eventually(async () => {
  assert.ok((await tiles.count()) >= 18, 'the section catalogue is shown');
  assert.deepEqual((await sketches.locator('strong').allTextContents()).sort(), ['Section', 'Split layout'], 'the two intentionally empty layouts use sketches');
  assert.equal(await shots.count(), (await tiles.count()) - 2, 'every other section, including Featured post, has a thumbnail');
}, 15000);
await eventually(async () => assert.ok((await shots.evaluateAll((imgs) => imgs.every((i) => i.complete && i.naturalWidth === 320 && i.src.startsWith('data:image/webp')))), 'each thumbnail is a decoded WebP image'));
assert.equal(new Set(await shots.evaluateAll((imgs) => imgs.map((i) => i.src))).size, await shots.count(), 'each section has its own thumbnail');
await panel.locator('.insert-group[data-kind="section"]').first().screenshot({ path: join(SHOTS, 'theme-packs-insert.png') });

step('Variants lists each option with its own thumbnail, and inserts the option shown');
const variants = panel.getByRole('button', { name: 'Variants' });
await variants.click();
assert.equal(await variants.getAttribute('aria-pressed'), 'true');
const darkHero = panel.getByRole('button', { name: /^Split hero, Dark(?:,|$)/ });
await darkHero.waitFor();
const [plain, dark] = await Promise.all([
  panel.getByRole('button', { name: /^Split hero, Theme default(?:,|$)/ }).locator('img').getAttribute('src'),
  darkHero.locator('img').getAttribute('src')
]);
assert.ok(dark && dark !== plain, 'the variant has its own thumbnail');
const before = new Set(Object.keys((await snapshot()).pages[(await snapshot()).site.homePageId].nodes));
await darkHero.click();
await eventually(async () => {
  const st = await snapshot();
  const added = Object.values(st.pages[st.site.homePageId].nodes).filter((n) => !before.has(n.id) && n.kind === 'instance');
  assert.deepEqual(added.map((n) => [st.components[n.definitionId].componentId, n.variants]), [['hero.split', { tone: 'inverse' }]], 'the dark split hero is inserted');
});
await variants.click();

step('Site styles offers the installed pack, lists the refused one, and switching copies the new font in');
const pkgBefore = readFileSync(join(site, 'package.json'));
const lockBefore = readFileSync(join(site, 'package-lock.json'));
assert.ok(!JSON.parse(pkgBefore.toString()).devDependencies['@fontsource-variable/inter'], 'new projects install no font packages');
await win.locator('.dock-tab', { hasText: 'Styles' }).click();
const styles = win.locator('#dock-panel-styles .ss-theme-meta');
await styles.waitFor();
await styles.locator('.ss-packs-refused summary').click();
assert.match(await styles.locator('.ss-packs-refused').innerText(), /broken[^]*not valid JSON[^]*packs/, 'Site styles lists the refused pack, why, and where packs are read from');
await styles.getByLabel('Theme').selectOption('atelier');
await eventually(async () => assert.deepEqual((await snapshot()).themeLock.theme, { id: 'atelier', version: '1.0.0', digest }, 'the installed pack is pinned to its exact release'));
const fonts = join(site, 'src', 'lib', 'siteorigin', 'fonts');
await eventually(async () => {
  assert.ok(readdirSync(fonts).some((f) => f.startsWith('space-grotesk-')), 'the pack’s display font is copied into the project');
  assert.ok(!readdirSync(fonts).some((f) => f.startsWith('fraunces-')), 'Foundation’s display font is no longer shipped');
});
for (const f of readdirSync(fonts).filter((f) => f.endsWith('.woff2'))) {
  const file = `fonts/${f}`;
  assert.equal(createHash('sha256').update(readFileSync(join(fonts, f))).digest('hex'), m.files[file]?.sha256, `${f} is the pack’s own file`);
}
assert.ok(readFileSync(join(fonts, 'NOTICE.txt'), 'utf8').includes('Space Grotesk (OFL-1.1)'), 'the font licence travels with it');
assert.ok(pkgBefore.equals(readFileSync(join(site, 'package.json'))) && lockBefore.equals(readFileSync(join(site, 'package-lock.json'))), 'nothing needed installing');

step('the preview loads the new font from the project');
await eventually(
  async () => {
    const loaded = await frame.locator('h1').first().evaluate(async (h) => {
      await document.fonts.ready;
      return { family: getComputedStyle(h).fontFamily, ok: document.fonts.check(`600 32px "Space Grotesk Variable"`) && [...document.fonts].some((f) => f.family.includes('Space Grotesk') && f.status === 'loaded') };
    });
    assert.match(loaded.family, /Space Grotesk Variable/);
    assert.ok(loaded.ok, 'the heading font has loaded');
  },
  30000,
  300
);

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\ntheme-packs: passed');
