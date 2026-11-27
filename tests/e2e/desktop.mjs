// Desktop menus, file choosers and the project lifecycle in a headless test session (#494). One session drives the
// built app through the driver's operations (menus, chooser answers, session files) and through the controls a person
// sees: it creates a project from Welcome in a folder it chooses, opens and cancels through File, imports an image,
// exports a ZIP file (declining and then accepting the system's Replace? question), opens that ZIP file, declines and
// then gives trust, closes the project and (macOS) the window, and opens the project again in a new window. Every
// chooser is answered by the session, or closed with a recorded reason when it was not; none is ever shown. Each
// outcome is checked where it lands: the files on disk, the project open, the window it is open in.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findMenuNode } from '../driver/desktop.ts';
import { Session } from '../driver/session.ts';
import { eventually, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('desktop');
const session = new Session({ parentDir: WORK });
const isMac = process.platform === 'darwin';
let passed = false;

let n = 0;
/** One request, as a client sends it over the protocol; the reply carries its id. */
async function call(op, args, extra = {}) {
  const id = `k${++n}`;
  return { id, reply: await session.call({ v: 1, id, op, ...(args ? { args } : {}), ...extra }) };
}
async function ok(op, args, extra) {
  const { id, reply } = await call(op, args, extra);
  assert.equal(reply.ok, true, `${op}: ${reply.ok ? '' : `${reply.error.code} ${reply.error.message}`}`);
  return Object.assign(reply.result, { request: reply.result?.request ?? id });
}
async function refused(op, args, extra) {
  const { reply } = await call(op, args, extra);
  assert.equal(reply.ok, false, `${op} is refused`);
  return reply.error;
}
const page = () => session.page;
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const snapshot = () => page().evaluate(() => window.builder.project.snapshot());
const openDir = async () => (await snapshot())?.dir ?? null;
/** Set the answers for the next choosers: returns their ids and the request that set them. */
const answer = async (answers) => {
  const r = await ok('desktop.setAnswers', { answers });
  return { ids: r.answers, request: r.request };
};
/** The record from a cursor on. */
const eventsAfter = async (after) => (await ok('desktop.events', { after })).entries;
const cursor = async () => (await ok('desktop.events', { after: 0, limit: 1000 })).next;
/** The next chooser recorded after `after`, once it has been shown. */
const nextChooser = (after, timeout = 30000) =>
  eventually(async () => {
    const c = (await eventsAfter(after)).find((e) => e.type === 'chooser');
    assert.ok(c, 'a chooser was shown');
    return c;
  }, timeout);
/** The window is the editor's, never shown, and still the one bound. */
async function expectHiddenWindow(generation, nativeId, what) {
  const info = await ok('window.info', undefined, { expectWindow: generation });
  assert.deepEqual([info.generation, info.nativeId, info.visible, info.focused], [generation, nativeId, false, false], `${what}: the same hidden window`);
  return info;
}

try {
  step('a session starts at Welcome, headless, with its own imports and exports folders');
  const started = await session.start({ fixture: 'welcome' });
  const { paths } = started.session;
  assert.equal(started.app.desktopFixtures, true, 'the app answers its native choosers from the session');
  for (const k of ['imports', 'exports']) assert.ok(existsSync(paths[k]) && paths[k].startsWith(paths.root), `the session has its own ${k} folder`);
  const kinds = Object.fromEntries(started.capabilities.map((c) => [c.op, c.kind]));
  assert.deepEqual(
    ['menu.list', 'menu.invoke', 'desktop.setAnswers', 'desktop.events', 'files.stageImport', 'files.list', 'window.close'].map((op) => kinds[op]),
    ['observe', 'act', 'fixture', 'observe', 'fixture', 'observe', 'act'],
    'answering a chooser prepares state; choosing a menu item or closing the window is what a person does'
  );
  const first = await ok('window.info');
  const win1 = { generation: first.generation, nativeId: first.nativeId };
  // The development build answers its test-only handlers; a packaged build has none (packaged.mjs checks that).
  assert.equal(started.app.packaged, false);
  assert.equal(typeof (await page().evaluate(() => window.builderTest.thumbCaptures())), 'number', 'a development build answers builderTest');

  step('the File menu is discovered with each item’s state, and a disabled item is not chosen');
  let menu = (await ok('menu.list')).items;
  const file = (label) => findMenuNode(menu, ['File', label]);
  assert.deepEqual(
    ['New Project…', 'Open Project…', 'Export…', 'Close Project'].map((l) => [l, file(l)?.enabled, file(l)?.invokable, file(l)?.accelerator]),
    [
      ['New Project…', true, true, 'CmdOrCtrl+Shift+N'],
      ['Open Project…', true, true, 'CmdOrCtrl+O'],
      ['Export…', false, true, 'CmdOrCtrl+E'],
      ['Close Project', false, true, 'CmdOrCtrl+Shift+W']
    ]
  );
  assert.equal(findMenuNode(menu, ['Edit', 'Cut'])?.invokable, false, 'a system role is listed, not chosen');
  const disabled = await refused('menu.invoke', { path: ['File', 'Export…'] });
  assert.deepEqual([disabled.code, disabled.details.reason], ['OP_FAILED', 'disabled']);
  assert.equal(await page().locator('.modal').count(), 0, 'nothing opened');

  step('a chooser nobody answered is closed at once, with a reason, and nothing changes');
  let mark = await cursor();
  const openUnanswered = await ok('menu.invoke', { path: ['File', 'Open Project…'] });
  assert.deepEqual([openUnanswered.window, openUnanswered.status], [win1.nativeId, 'dispatched']);
  const unanswered = await nextChooser(mark);
  assert.deepEqual([unanswered.dialog, unanswered.outcome, unanswered.answer, unanswered.window], ['open', 'unanswered', null, win1.nativeId]);
  assert.equal(unanswered.title, 'Open a SiteOrigin Builder project');
  assert.match(unanswered.reason, /No answer was set/);
  const menuEvent = (await eventsAfter(mark)).find((e) => e.type === 'menu');
  assert.deepEqual([menuEvent.path, menuEvent.request, menuEvent.seq < unanswered.seq], [['File', 'Open Project…'], openUnanswered.request, true], 'the record says which menu item came first, and who chose it');
  assert.equal(await page().locator('.welcome').count(), 1, 'Welcome is still shown');
  await expectHiddenWindow(win1.generation, win1.nativeId, 'after an unanswered chooser');

  step('cancel is an answer: Open project… on Welcome and in the File menu is closed without a choice');
  for (const [where, open] of [
    ['Welcome', () => page().locator('.welcome-action', { hasText: 'Open project…' }).click()],
    ['File', () => ok('menu.invoke', { path: ['File', 'Open Project…'] })]
  ]) {
    mark = await cursor();
    const cancel = await answer([{ dialog: 'open', cancel: true }]);
    await open();
    const cancelled = await nextChooser(mark);
    assert.deepEqual([cancelled.outcome, cancelled.answer, cancelled.request, cancelled.window], ['cancelled', cancel.ids[0], cancel.request, win1.nativeId], `${where}: the record names the answer and the request that set it`);
    // Opening ends once the chooser is closed: Welcome is back, with nothing to trust and no error.
    await eventually(async () => assert.equal(await page().locator('.welcome-action[aria-busy="true"]').count(), 0, `${where}: opening finished`));
    assert.equal(await page().locator('.welcome').count(), 1, `${where}: Welcome is still shown`);
    assert.equal(await page().getByRole('dialog').count(), 0, `${where}: nothing is offered to trust`);
    assert.equal(await page().locator('.toast.error').count(), 0, `${where}: a cancelled chooser is no error`);
    assert.deepEqual((await ok('desktop.events', { after: mark })).pending, [], `${where}: the answer was used`);
  }

  step('a project is created from Welcome in a folder chosen in the native chooser');
  mark = await cursor();
  const where = await answer([{ dialog: 'open', title: 'Choose where to create the project', selection: 'folder', paths: ['workspace'] }]);
  await page().locator('.welcome-action', { hasText: 'New project' }).click();
  const newProject = page().getByRole('dialog', { name: 'New project' });
  await newProject.waitFor();
  await newProject.getByLabel('Project name').fill('Harbour Bakery');
  await newProject.getByRole('radio', { name: 'Blank site' }).click();
  await newProject.getByRole('button', { name: 'Choose…' }).click();
  const chosenFolder = await nextChooser(mark);
  assert.deepEqual([chosenFolder.outcome, chosenFolder.answer, chosenFolder.selection, chosenFolder.result.paths], ['chosen', where.ids[0], 'folder', [paths.workspace]]);
  await eventually(async () => assert.match(await newProject.locator('#new-project-path').innerText(), /workspace[^]*harbour-bakery/, 'the form shows the chosen folder'));
  await newProject.getByRole('button', { name: 'Create project' }).click();
  await page().waitForSelector('.editor', { timeout: 180000 });
  const bakery = join(paths.workspace, 'harbour-bakery');
  assert.ok(existsSync(join(bakery, 'siteorigin.project.json')), 'the project is in the chosen folder, not the default one');
  assert.ok(!existsSync(join(paths.projects, 'harbour-bakery')), 'nothing went to the default folder');
  await eventually(async () => assert.equal(await openDir(), bakery, 'it is the project open'), 30000);
  await expectHiddenWindow(win1.generation, win1.nativeId, 'with the project open');
  menu = (await ok('menu.list')).items;
  assert.deepEqual([file('Export…').enabled, file('Close Project').enabled], [true, true], 'Export and Close Project are offered with a project open');

  step('an image staged in the session’s imports folder is added through Assets');
  const staged = await ok('files.stageImport', { name: 'harbour-front.jpg', sample: 'hero.jpg' });
  assert.equal(staged.logical, 'imports/harbour-front.jpg');
  mark = await cursor();
  const pick = await answer([{ dialog: 'open', selection: 'files', paths: [staged.logical] }]);
  const assetsTab = page().locator('.rail [aria-label="Assets"]');
  if ((await assetsTab.getAttribute('aria-pressed')) !== 'true') await assetsTab.click();
  await page().locator('.asset-add, .asset-drop').first().click();
  const imported = await nextChooser(mark);
  assert.deepEqual([imported.outcome, imported.answer, imported.selection, imported.result.paths], ['chosen', pick.ids[0], 'files', [staged.path]]);
  assert.ok(imported.filters.some((f) => f.extensions.includes('jpg')), 'the chooser offers JPEG files');
  const asset = await eventually(async () => {
    const images = Object.values((await snapshot()).state.assets.assets).filter((a) => a.kind === 'image');
    assert.equal(images.length, 1, 'one image is in the library');
    return images[0];
  }, 60000);
  assert.ok(existsSync(join(bakery, asset.file)), `the image's file is in the project (${asset.file})`);
  assert.equal(sha(join(bakery, asset.file)), staged.sha256, 'it is the file chosen, byte for byte');

  step('File > Export… exports the editable project as a ZIP file to the session’s exports folder');
  const modal = page().getByRole('dialog', { name: 'Export your website' });
  const closeExport = async () => {
    await modal.getByRole('button', { name: 'Close', exact: true }).last().click();
    await modal.waitFor({ state: 'detached' });
  };
  const exportSourceZip = async () => {
    await ok('menu.invoke', { path: ['File', 'Export…'] });
    await modal.waitFor();
    await modal.getByRole('radio', { name: 'ZIP file', exact: true }).click();
    await modal.getByRole('button', { name: /Editable project, for a developer/ }).click();
  };
  const zip = join(paths.exports, 'harbour-bakery-source.zip');
  mark = await cursor();
  const save = await answer([{ dialog: 'save', path: 'exports/harbour-bakery-source.zip' }]);
  await exportSourceZip();
  await modal.getByRole('status').filter({ hasText: 'Source project exported as a ZIP file.' }).waitFor({ timeout: 120000 });
  const saved = await nextChooser(mark);
  assert.deepEqual([saved.dialog, saved.outcome, saved.answer, saved.result.path, saved.title], ['save', 'chosen', save.ids[0], zip, 'Export source project as a ZIP file']);
  const listed = (await ok('files.list')).entries;
  assert.deepEqual(
    listed.map((e) => [e.name, e.type]),
    [['harbour-bakery-source.zip', 'file']],
    'the ZIP file is in the exports folder'
  );
  assert.ok(listed[0].bytes > 1000, 'and holds the project');
  const unzip = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
  if (unzip.status === 0) {
    const names = unzip.stdout.split('\n');
    assert.ok(names.some((f) => /(^|\/)siteorigin\.project\.json$/.test(f)), 'the ZIP file holds the project manifest');
    assert.ok(names.some((f) => f.endsWith('harbour-front.jpg') || f.includes(asset.file.split('/').pop())), 'and the imported image');
  } else console.log('(no unzip here: the ZIP file’s contents are not listed)');
  const history = modal.getByRole('region', { name: 'Recent exports' });
  assert.ok((await history.getByRole('listitem').first().innerText()).includes(zip), 'the dialog lists where it went');

  step('Show in folder is recorded as the reveal the app asked for, and Finder never opens');
  mark = await cursor();
  await history.getByRole('listitem').first().getByRole('button', { name: 'Show in folder' }).click();
  const revealed = await eventually(async () => {
    const intent = (await eventsAfter(mark)).find((e) => e.type === 'intent');
    assert.ok(intent, 'a reveal was asked for');
    return intent;
  });
  assert.deepEqual([revealed.kind, revealed.target], ['reveal', realpathSync(zip)]);
  await closeExport();

  step('exporting over the ZIP file meets the system’s Replace? question: declined, the file is kept as it was');
  const exportedHash = sha(zip);
  const exportedAt = statSync(zip).mtimeMs;
  mark = await cursor();
  const decline = await answer([{ dialog: 'save', path: 'exports/harbour-bakery-source.zip', overwrite: 'decline' }]);
  await exportSourceZip();
  const declined = await nextChooser(mark);
  assert.deepEqual([declined.outcome, declined.answer], ['cancelled', decline.ids[0]]);
  assert.match(declined.reason, /already exists, and the system's question whether to replace it was declined/);
  await eventually(async () => assert.equal(await modal.locator('.export-progress').innerText(), '', 'the export stopped'));
  assert.deepEqual([sha(zip), statSync(zip).mtimeMs], [exportedHash, exportedAt], 'the ZIP file is unchanged, and was not written again');
  assert.equal(await history.getByRole('listitem').count(), 1, 'nothing new was exported');
  await closeExport();

  step('accepted, it is replaced');
  const writtenAt = statSync(zip).mtimeMs;
  mark = await cursor();
  const replace = await answer([{ dialog: 'save', path: 'exports/harbour-bakery-source.zip', overwrite: 'replace' }]);
  await exportSourceZip();
  await modal.getByRole('status').filter({ hasText: 'Source project exported as a ZIP file.' }).waitFor({ timeout: 120000 });
  const replaced = await nextChooser(mark);
  assert.deepEqual([replaced.outcome, replaced.answer, replaced.result.path], ['chosen', replace.ids[0], zip]);
  assert.ok(statSync(zip).mtimeMs > writtenAt, 'the ZIP file was written again');
  // One row per destination: the export that replaced it takes its place.
  assert.equal(await history.getByRole('listitem').count(), 1, 'the destination is listed once');
  assert.ok((await history.getByRole('listitem').first().innerText()).includes(zip), 'for the ZIP file');
  assert.deepEqual((await ok('files.list')).entries.map((e) => e.name), ['harbour-bakery-source.zip'], 'still one ZIP file');
  await closeExport();

  step('File > Open Project… opens the ZIP file into a chosen folder; its trust is declined, and the project open stays');
  mark = await cursor();
  const zipOpen = await answer([
    { dialog: 'open', paths: ['exports/harbour-bakery-source.zip'] },
    { dialog: 'open', title: 'Choose where to save Harbour Bakery', selection: 'folder', paths: ['workspace'] }
  ]);
  await ok('menu.invoke', { path: ['File', 'Open Project…'] });
  const trust = page().getByRole('dialog', { name: 'Trust this project?' });
  await trust.waitFor({ timeout: 60000 });
  const copy = join(paths.workspace, 'harbour-bakery-2');
  assert.match(await trust.innerText(), /Harbour Bakery/, 'the prompt names the project');
  assert.ok(existsSync(join(copy, 'siteorigin.project.json')), 'the working copy is a new folder beside the original');
  const zipChoosers = (await eventsAfter(mark)).filter((e) => e.type === 'chooser');
  assert.deepEqual(
    zipChoosers.map((c) => [c.outcome, c.answer, c.title]),
    [
      ['chosen', zipOpen.ids[0], 'Open a SiteOrigin Builder project'],
      ['chosen', zipOpen.ids[1], 'Choose where to save Harbour Bakery']
    ],
    'both choosers were answered in order'
  );
  await trust.getByRole('button', { name: 'Cancel' }).click();
  await trust.waitFor({ state: 'detached' });
  assert.equal(await openDir(), bakery, 'declining leaves the project that was open');

  step('opened again from its manifest, the copy is trusted and opens');
  mark = await cursor();
  await answer([{ dialog: 'open', paths: ['workspace/harbour-bakery-2/siteorigin.project.json'] }]);
  await ok('menu.invoke', { path: ['File', 'Open Project…'] });
  await trust.waitFor({ timeout: 60000 });
  await trust.getByRole('button', { name: 'Trust and open' }).click();
  await eventually(async () => assert.equal(await openDir(), copy, 'the copy is the project open'), 60000);
  assert.equal((await nextChooser(mark)).outcome, 'chosen');
  await expectHiddenWindow(win1.generation, win1.nativeId, 'with the copy open');

  step('every chooser so far is on the record, each taken by the answer set for it');
  const record = await ok('desktop.events', { after: 0, limit: 1000 });
  assert.equal(record.dropped, 0);
  assert.deepEqual(record.pending, [], 'no answer is left waiting');
  assert.deepEqual(
    record.entries.filter((e) => e.type === 'chooser').map((c) => `${c.dialog} ${c.title}: ${c.outcome}`),
    [
      'open Open a SiteOrigin Builder project: unanswered',
      'open Open a SiteOrigin Builder project: cancelled',
      'open Open a SiteOrigin Builder project: cancelled',
      'open Choose where to create the project: chosen',
      `open ${imported.title}: chosen`,
      'save Export source project as a ZIP file: chosen',
      'save Export source project as a ZIP file: cancelled',
      'save Export source project as a ZIP file: chosen',
      'open Open a SiteOrigin Builder project: chosen',
      'open Choose where to save Harbour Bakery: chosen',
      'open Open a SiteOrigin Builder project: chosen'
    ],
    'the choosers shown, in order, and how each was answered'
  );
  assert.ok(record.entries.filter((e) => e.type === 'chooser').every((c) => c.window === win1.nativeId), 'each over the editor window');

  step('File > Close Project returns to Welcome in the same window');
  await ok('menu.invoke', { path: ['File', 'Close Project'] });
  await page().waitForSelector('.welcome', { timeout: 30000 });
  await expectHiddenWindow(win1.generation, win1.nativeId, 'after Close Project');
  menu = (await ok('menu.list')).items;
  assert.deepEqual([file('Export…').enabled, file('Close Project').enabled], [false, false], 'Export and Close Project are withdrawn again');

  if (isMac) {
    step('macOS: the window closes and the app keeps running; File > Open Project… brings a new window and opens the project in it');
    await ok('window.close');
    await eventually(async () => assert.equal((await refused('window.info')).code, 'WINDOW_CLOSED'), 30000);
    // Answers set with no window belong to the next one.
    mark = await cursor();
    const reopen = await answer([{ dialog: 'open', paths: ['workspace/harbour-bakery/siteorigin.project.json'] }]);
    const chosenWithout = await ok('menu.invoke', { path: ['File', 'Open Project…'] });
    assert.equal(chosenWithout.window, null, 'chosen with no window open');
    const notice = await eventually(async () => {
      const e = await refused('window.info');
      assert.equal(e.code, 'WINDOW_REPLACED', 'a new window replaced the old one');
      return e;
    }, 60000);
    const win2 = { generation: notice.details.to, nativeId: notice.details.nativeId };
    assert.ok(win2.generation > win1.generation && win2.nativeId !== win1.nativeId, 'it is a different native window');
    await page().waitForSelector('.editor', { timeout: 120000 });
    await eventually(async () => assert.equal(await openDir(), bakery, 'the project is open in the new window'), 60000);
    await expectHiddenWindow(win2.generation, win2.nativeId, 'the reopened window');
    const reopened = await nextChooser(mark);
    assert.deepEqual([reopened.outcome, reopened.answer, reopened.window], ['chosen', reopen.ids[0], win2.nativeId], 'its chooser was shown over the new window');
    // Closing the window takes the answers left for it.
    const leftover = await answer([{ dialog: 'open', cancel: true }]);
    await ok('window.close', undefined, { expectWindow: win2.generation });
    await eventually(async () => {
      const ev = await ok('desktop.events', { after: mark });
      assert.deepEqual(ev.pending, [], 'no answer waits for a window that went');
      assert.ok(ev.entries.some((e) => e.type === 'answers' && e.change === 'expired' && e.answers.includes(leftover.ids[0])), 'they expired with it');
    }, 30000);
  } else {
    step('the last window closing quits the app');
    await ok('window.close');
    await eventually(async () => assert.equal((await refused('window.info')).code, 'APP_EXITED'), 60000);
  }

  assert.deepEqual(session.pageErrors, [], 'no page errors');
  passed = true;
} finally {
  const closed = await session.close({ failed: !passed }).catch((e) => e);
  if (!passed) console.log(`desktop: kept ${closed?.artifacts ?? closed?.details?.root ?? '(nothing)'}`);
}
cleanup();
console.log('\ndesktop: all checks passed');
