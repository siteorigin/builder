// A design's generated file edited outside the app (#737): Project health offers "Convert to code component" beside
// Restore on that file's row only, never on a page's. Without Developer mode the row says why it can't; with it, an
// edited file that fails the code checks is refused on its own row with nothing changed, and one that passes becomes a
// code component every placement uses: the row goes, the preview shows the edit, and the edited file is under Saved
// copies.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('convert-edited');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Convert Studio', parentDir: join(WORK, 'sites'), starter: 'business' });

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = async (operations, label) => {
  const r = await win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);
  assert.ok(r.ok, `${label}: ${JSON.stringify(r.error ?? r)}`);
};
/** Developer mode switched as the author does, in Settings, so the editor's own view of it follows. */
const setDeveloperMode = async (on) => {
  await win.locator('[aria-label="Settings"]').click();
  const devSwitch = win.getByRole('switch', { name: 'Developer mode' });
  if ((await devSwitch.getAttribute('aria-checked')) !== String(on)) await devSwitch.click();
  await eventually(async () => assert.equal(await devSwitch.getAttribute('aria-checked'), String(on)));
  await eventually(async () => assert.equal((await win.evaluate(() => window.builder.app.getSettings())).developerMode, on, 'saved'));
  await win.keyboard.press('Escape');
  await win.locator('.modal').waitFor({ state: 'detached' });
};
const modal = win.locator('.modal');
const openHealth = async () => {
  await win.getByTitle('Project health: check this project for problems').click();
  const health = win.getByRole('dialog', { name: 'Project health' });
  await health.waitFor();
  return health;
};
const closeDialog = async () => {
  await modal.getByRole('button', { name: 'Close', exact: true }).last().click();
  await modal.waitFor({ state: 'detached' });
};

const dir = (await snapshot()).dir;
const HERO = 'src/lib/siteorigin/generated/foundation-hero-split.svelte';
const ABOUT = 'src/routes/about/+page.svelte';
const generated = readFileSync(join(dir, HERO), 'utf8');
const edited = generated.replace(/(<section [^>]*>)/, '$1\n\t<p class="hand-badge">Made by hand</p>');
assert.notEqual(edited, generated, 'the hero file has a section to add to');

step('the hero design’s file and the About page’s file edited by hand, found by the next save');
await setDeveloperMode(false);
writeFileSync(join(dir, HERO), edited);
writeFileSync(join(dir, ABOUT), `${readFileSync(join(dir, ABOUT), 'utf8')}\n<!-- edited by hand -->\n`);
await apply([{ type: 'site.update', name: 'Convert Studio Ltd' }], 'Rename');
await eventually(async () => assert.deepEqual((await snapshot()).conflicts.map((c) => c.path).sort(), [HERO, ABOUT].sort()));

step('only the design file’s row offers the conversion, and without Developer mode it says why');
let health = await openHealth();
const heroRow = health.locator('.health-row.danger', { hasText: 'Split Hero component file' });
const aboutRow = health.locator('.health-row.danger', { hasText: 'About website file' });
const convert = heroRow.getByRole('button', { name: 'Convert to code component' });
await convert.waitFor();
assert.equal(await heroRow.getByRole('button', { name: 'Use SiteOrigin Builder’s version' }).count(), 1, 'Restore is still there beside it');
assert.equal(await aboutRow.getByRole('button', { name: 'Convert to code component' }).count(), 0, 'a page’s file never offers it');
assert.equal(await aboutRow.getByRole('button', { name: 'Use SiteOrigin Builder’s version' }).count(), 1);
assert.equal(await convert.getAttribute('aria-disabled'), 'true', 'held without Developer mode');
assert.match(await heroRow.innerText(), /Custom code needs Developer mode\./);
// Held, not disabled (focus stays on it): pressed anyway, it does nothing.
await convert.click({ force: true });
assert.equal((await snapshot()).conflicts.length, 2, 'pressing it without Developer mode changes nothing');
await closeDialog();

step('with Developer mode on, an edited file that fails the code checks is refused on its row, and nothing changes');
await setDeveloperMode(true);
writeFileSync(join(dir, HERO), edited.replace('<script>\n', '<script>\n\tlet broken = ;\n'));
health = await openHealth();
await eventually(async () => assert.equal(await convert.getAttribute('aria-disabled'), null, 'offered with Developer mode'));
assert.match(await heroRow.innerText(), /Makes the edited file a code component, used everywhere this component is\./);
await convert.click();
const refusal = heroRow.getByRole('alert');
await refusal.waitFor();
assert.match(await refusal.innerText(), /can’t become a code component: line \d+/);
const after = await snapshot();
assert.equal(after.conflicts.length, 2, 'the conflict stays');
assert.ok(!Object.values(after.state.components).some((d) => d.kind === 'code' && d.owner === 'project'), 'no code component was made');

step('put right, it converts: the row goes, the preview shows the edited hero, and the edited file is under Saved copies');
writeFileSync(join(dir, HERO), edited);
await convert.click();
await eventually(async () => assert.deepEqual((await snapshot()).conflicts.map((c) => c.path), [ABOUT]));
const done = await snapshot();
const code = Object.values(done.state.components).find((d) => d.kind === 'code' && d.generatedFrom === 'foundation.hero.split');
assert.ok(code, 'the code component was made from the design');
assert.equal(code.source, edited, 'its code is the edited file');
assert.equal(readFileSync(join(dir, HERO), 'utf8'), generated, 'the design’s file is SiteOrigin Builder’s again');
await eventually(async () => assert.equal(await heroRow.count(), 0, 'its conflict row is gone'));
await health.locator('.health-row', { hasText: 'The file as edited outside SiteOrigin Builder' }).filter({ hasText: 'Split Hero component file' }).waitFor();
await closeDialog();
await eventually(async () => assert.equal(await frame.locator('.hand-badge').first().innerText(), 'Made by hand'), 60000);

assert.deepEqual(errors, [], `no page errors: ${errors.join('\n')}`);
await app.close();
cleanup();
console.log('\nconvert-edited: ok');
