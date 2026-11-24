// Theme component updates in the real app (#103): a project whose installed hero is older than the theme's opens with
// an update offered in Project health; Update replaces the definition and its lock entry with the theme's, and Undo
// puts the older ones back, leaving the page untouched both ways.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('theme-update');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Outdated Studio', parentDir: join(WORK, 'sites'), starter: 'business' });
const dir = join(WORK, 'sites', 'outdated-studio');
const HERO = 'foundation.hero.split';
const DEF = join(dir, 'siteorigin/components', HERO, 'component.json');
const LOCK = join(dir, 'siteorigin/theme-lock.json');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const homeFile = async () => {
  const s = await snapshot();
  return join(dir, 'siteorigin/pages', `${s.state.site.homePageId}.json`);
};

step('make the installed hero an older release of itself, while the project is closed');
const current = { def: json(DEF), entry: json(LOCK).components[HERO] };
assert.match(current.entry.hash, /^sha256:/, 'the hero was installed from the theme');
const older = { ...current.def, description: 'An older description of the split hero.' };
// The lock records the hash of the definition as the theme shipped it: this older one is still unmodified theme data.
const olderHash = `sha256:${createHash('sha256').update(JSON.stringify(older)).digest('hex')}`;
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
writeFileSync(DEF, JSON.stringify(older, null, '\t') + '\n');
const lock = json(LOCK);
const olderEntry = { ...current.entry, version: '0.0.1', hash: olderHash };
lock.components[HERO] = olderEntry;
writeFileSync(LOCK, JSON.stringify(lock, null, '\t') + '\n');

step('reopen: Project health offers the update');
const reopened = await win.evaluate((d) => window.builder.projects.open(d), dir);
assert.ok(reopened.ok, `the project reopens: ${JSON.stringify(reopened)}`);
await win.waitForSelector('.editor');
await eventually(async () => assert.deepEqual((await snapshot()).themeUpdates?.available.map((u) => u.id), [HERO], 'the older hero is offered an update'));
const pageFile = await homeFile();
const page = readFileSync(pageFile, 'utf8');
await win.getByTitle('Project health: check this project for problems').click();
const health = win.getByRole('dialog', { name: 'Project health' });
await health.waitFor();
await eventually(async () => assert.ok(await health.getByText('1 theme component has an update.').isVisible(), 'the update is listed'));
await win.screenshot({ path: join(SHOTS, 'theme-update-offered.png') });

step('Update replaces the definition and its lock entry with the theme’s');
await health.getByRole('button', { name: 'Update 1 component', exact: true }).click();
await eventually(() => {
  assert.deepEqual(json(DEF), current.def, 'the hero is the theme’s current version');
  assert.deepEqual(json(LOCK).components[HERO], current.entry, 'the lock records the current version and its hash');
});
await eventually(async () => assert.deepEqual((await snapshot()).themeUpdates?.available ?? [], [], 'nothing is left to update'));
await eventually(async () => assert.equal(await health.getByText('1 theme component has an update.').count(), 0, 'the offer is gone'));
assert.equal(readFileSync(pageFile, 'utf8'), page, 'the page is untouched');
await health.getByRole('button', { name: 'Close', exact: true }).last().click();
await health.waitFor({ state: 'detached' });

step('Undo puts the older definition back');
await win.getByRole('button', { name: 'Undo Update theme components' }).click();
await eventually(() => {
  assert.deepEqual(json(DEF), older, 'the older hero is back');
  assert.deepEqual(json(LOCK).components[HERO], olderEntry, 'and its lock entry');
});
await eventually(async () => assert.deepEqual((await snapshot()).themeUpdates?.available.map((u) => u.id), [HERO], 'the update is offered again'));
assert.equal(readFileSync(pageFile, 'utf8'), page, 'the page is still untouched');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\ntheme-update: passed');
