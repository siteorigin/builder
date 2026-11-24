// Same-title pages (#180): two pages titled Portfolio, at /lookbook/ and /portfolio-archive/, are told apart by
// their address in the toolbar's page menu and in the command menu; the command menu finds a page by its address;
// both follow a rename; and choosing either one with the keyboard opens the page shown.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('page-switchers');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Studio Pages', parentDir: join(WORK, 'sites'), starter: 'business' });

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = (operations, label) => win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);

step('two pages with the same title');
const s0 = await snapshot();
const [, first, second] = s0.state.site.pageOrder;
assert.ok((await apply([{ type: 'page.update', pageId: first, title: 'Portfolio', route: '/lookbook/' }], 'Rename')).ok);
assert.ok((await apply([{ type: 'page.update', pageId: second, title: 'Portfolio', route: '/portfolio-archive/' }], 'Rename')).ok);
// A page nested under one of them, so an exact address has a longer one containing it.
assert.ok((await apply([{ type: 'page.create', title: 'Team', route: '/lookbook/team/', starter: 'intro' }], 'Add')).ok);

const openToolbar = async () => {
  await win.locator('.project-title').click();
  await win.locator('[role="menu"]').waitFor();
};
const menuNames = async () => (await win.locator('[role="menu"] [role^="menuitem"]').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
const openCmdk = async (q) => {
  await win.keyboard.press(`${MOD}+K`);
  await win.locator('.cmdk').waitFor();
  if (q) await win.keyboard.type(q);
};
const options = async () => (await win.locator('.cmdk [role="option"]').evaluateAll((els) => els.map((e) => ({ name: e.innerText })))).map((o) => ({ name: o.name.replace(/\s+/g, ' ').trim() }));

step('toolbar page menu shows each address');
await openToolbar();
let names = await menuNames();
assert.ok(names.some((n) => /^Portfolio\s*\/lookbook\/$/.test(n)), `lookbook is listed with its address: ${names.join(' | ')}`);
assert.ok(names.some((n) => /^Portfolio\s*\/portfolio-archive\/$/.test(n)), 'the archive is listed with its address');
await win.keyboard.press('Escape');
await win.locator('[role="menu"]').waitFor({ state: 'detached' });

step('command menu shows and searches by address');
await openCmdk('portfolio');
let opts = await options();
assert.deepEqual(opts.filter((o) => o.name.startsWith('Go to Portfolio')).map((o) => o.name).sort(), ['Go to Portfolio /lookbook/', 'Go to Portfolio /portfolio-archive/']);
assert.equal(await win.getByRole('group', { name: 'Pages' }).getByRole('option', { name: /Go to Portfolio/ }).count(), 2, 'both pages are listed under Pages');
await win.keyboard.press('Escape');
await win.locator('.cmdk').waitFor({ state: 'detached' });
await openCmdk('/lookbook/');
opts = await options();
assert.deepEqual(opts.map((o) => o.name), ['Go to Portfolio /lookbook/'], 'the address finds exactly that page, not the page nested under it');

step('keyboard choice opens the page shown');
await win.keyboard.press('Enter');
await win.locator('.cmdk').waitFor({ state: 'detached' });
await eventually(async () => assert.match(await win.locator('.project-title').innerText(), /Portfolio/));
const current = async () => {
  await openToolbar();
  const checked = await win.locator('[role="menu"] [role="menuitemradio"][aria-checked="true"]').innerText();
  await win.keyboard.press('Escape');
  await win.locator('[role="menu"]').waitFor({ state: 'detached' });
  return checked.replace(/\s+/g, ' ').trim();
};
assert.match(await current(), /\/lookbook\/$/, 'the lookbook page is open');
await openCmdk('/portfolio-archive/');
await win.keyboard.press('Enter');
await win.locator('.cmdk').waitFor({ state: 'detached' });
await eventually(async () => assert.match(await current(), /\/portfolio-archive\/$/, 'the archive page is open'));

step('keyboard choice from the toolbar menu opens the page shown');
await openToolbar();
await win.locator('[role="menu"] [role^="menuitem"]', { hasText: /\/lookbook\/$/ }).focus();
await win.keyboard.press('Enter');
await win.locator('[role="menu"]').waitFor({ state: 'detached' });
await eventually(async () => assert.match(await current(), /\/lookbook\/$/, 'the lookbook page is open'));

step('both menus follow a rename');
assert.ok((await apply([{ type: 'page.update', pageId: first, title: 'Lookbook', route: '/looks/' }], 'Rename')).ok);
await openToolbar();
names = await menuNames();
assert.ok(names.some((n) => /^Lookbook\s*\/looks\/$/.test(n)), `the toolbar shows the new title and address: ${names.join(' | ')}`);
await win.keyboard.press('Escape');
await win.locator('[role="menu"]').waitFor({ state: 'detached' });
await openCmdk('/looks/');
assert.deepEqual((await options()).map((o) => o.name), ['Go to Lookbook /looks/']);
await win.keyboard.press('Escape');
await win.locator('.cmdk').waitFor({ state: 'detached' });

step('a partial command name leads with the command, not a search of the content');
await openCmdk('proj health');
assert.match((await options())[0].name, /^Project health/, 'Enter runs the command that matched');
await win.keyboard.press('Escape');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\npage-switchers: passed');
