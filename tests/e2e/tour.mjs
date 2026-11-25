// Visual tour: screenshots of key surfaces, mostly in dark mode. Each surface must appear before its shot.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MOD, createProject, launch, openInspector, scratch, step } from './harness.mjs';

const { WORK, SHOTS: OUT, cleanup } = scratch('tour');
const { app, win, errors } = await launch(WORK);
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'dark' }));
await win.emulateMedia({ colorScheme: 'dark' });
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
await win.waitForTimeout(1200);
const shot = (n) => win.screenshot({ path: join(OUT, n) });
await shot('30-dark-editor.png');

step('a part in a repeated item');
await win.locator('.rail [aria-label="Layers"]').click();
const gridRow = win.locator('.list-item', { hasText: 'Services grid' });
await gridRow.locator('.tree-toggle').click();
await win.locator('.list-item', { hasText: 'Card title' }).first().click();
await win.locator('[role="tree"] .list-item.selected', { hasText: 'Card title' }).waitFor();
await openInspector(win);
await shot('31-dark-part.png');

step('edit a component everywhere');
await gridRow.click();
await openInspector(win);
const compSection = win.locator('.section-head', { hasText: 'Component' });
if ((await compSection.getAttribute('aria-expanded')) === 'false') await compSection.click();
await win.getByRole('button', { name: 'Edit everywhere…' }).click();
await win.locator('.modal').waitFor();
await shot('32-edit-definition.png');
await win.getByRole('button', { name: /Make a copy and edit/ }).click();
await win.locator('.mode-band').waitFor();
await win.waitForTimeout(800);
await shot('33-definition-mode.png');
await win.locator('.mode-band-done').click();
await win.locator('.mode-band').waitFor({ state: 'detached' });

step('settings, command menu and export');
await win.locator('[aria-label="Settings"]').click();
await win.getByRole('tab', { name: 'AI assistant' }).click();
await win.locator('.modal [role="tab"][aria-selected="true"]', { hasText: 'AI assistant' }).waitFor();
await shot('34-settings.png');
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });
await win.keyboard.press(`${MOD}+K`);
await win.locator('.cmdk').waitFor();
await win.keyboard.type('fa');
await win.waitForTimeout(300);
await shot('35-cmdk.png');
await win.keyboard.press('Escape');
await win.locator('.cmdk').waitFor({ state: 'detached' });
await win.getByRole('button', { name: 'Export', exact: true }).click();
await win.locator('.modal').waitFor();
await shot('36-export.png');
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });

step('source view (Developer mode)');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'light' }));
await win.emulateMedia({ colorScheme: 'light' });
await win.locator('[aria-label="Settings"]').click();
await win.getByRole('switch', { name: 'Developer mode' }).click();
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });
await frame.locator('h1').first().click();
await win.locator('.ov-chip').waitFor();
if ((await compSection.getAttribute('aria-expanded')) === 'false') await compSection.click();
await win.getByRole('button', { name: 'View source' }).click();
await win.locator('.modal .cm-content').waitFor();
await shot('37-source.png');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\ntour: passed');
