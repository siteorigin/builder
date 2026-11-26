// Closing a project gives back what it used (#822): at Welcome the app runs the same processes as after a fresh
// launch, however often a project is opened and closed. The helpers a project keeps (the media workers, the
// thumbnails' hidden window, the preview) end with it at once, and start again when the next project needs them;
// the renderer the preview's frame ran in is ended by Chromium itself a few seconds after the frame goes.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';
import { ownedEntries, processTable } from '../driver/processes.ts';

const CYCLES = 5;
/** How long a project's own helpers may outlive its close: far less than their half-minute idle time. */
const HELPERS_MS = 3000;
/** How long the whole process set may take to be a fresh launch's again (Chromium keeps an emptied frame's renderer ~10 s). */
const SETTLED_MS = 20000;

const { WORK, cleanup } = scratch('project-footprint');
const { app, win, errors } = await launch(WORK);
const root = app.process().pid;
/** Every process seen as the app's, so one orphaned by its parent is still counted as the app's. */
const known = [];

/** The app's processes other than its main one, by identity (pid and start time). */
async function children() {
  const owned = ownedEntries(await processTable(), root, known);
  for (const e of owned) if (!known.some((k) => k.pid === e.pid && k.started === e.started)) known.push(e);
  return owned
    .filter((e) => e.pid !== root)
    .map((e) => `${e.pid}@${e.started}`)
    .sort();
}

/** What Electron says each process is, for failure messages, and the app's windows and the editor's frames. */
const described = () =>
  app.evaluate(({ app, BrowserWindow }) => ({
    processes: app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.serviceName === 'node.mojom.NodeService' ? m.name : m.serviceName ?? m.name, kb: m.memory.workingSetSize })),
    windows: BrowserWindow.getAllWindows().length,
    frames: BrowserWindow.getAllWindows().flatMap((w) => w.webContents.mainFrame.framesInSubtree.map((f) => f.url))
  }));
const helpers = (d) => d.processes.filter((p) => /^SiteOrigin /.test(p.name ?? ''));
const totalMb = (d) => Math.round(d.processes.reduce((n, p) => n + p.kb, 0) / 1024);

/** The children once two samples in a row agree. */
async function settledChildren() {
  let last = await children();
  for (;;) {
    await win.waitForTimeout(500);
    const now = await children();
    if (now.join() === last.join()) return now;
    last = now;
  }
}

async function waitForPreview() {
  const frame = win.frameLocator('.frame-box iframe');
  await frame.locator('h1').first().waitFor({ timeout: 90000 });
  await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
}

step('a fresh launch at Welcome');
await win.waitForSelector('.welcome');
const fresh = await settledChildren();
const freshAt = await described();
console.log(`fresh: ${fresh.length} children, ${totalMb(freshAt)} MB`);
assert.deepEqual(helpers(freshAt), [], 'no project helper runs at a fresh Welcome');

step('a Business site with sample pictures, which use the media workers');
await createProject(win, { name: 'Quayside Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
const dir = (await win.evaluate(() => window.builder.project.snapshot())).dir;
await children();

const totals = [];
for (let cycle = 1; cycle <= CYCLES; cycle++) {
  step(`close ${cycle} of ${CYCLES}`);
  const open = await described();
  if (cycle === 1) assert.ok(helpers(open).some((p) => p.name === 'SiteOrigin media'), `the project's pictures started a media worker (${JSON.stringify(helpers(open))})`);
  assert.ok(helpers(open).some((p) => p.name === 'SiteOrigin project runtime'), 'the preview runs while the project is open');
  await children();
  assert.ok((await win.evaluate(() => window.builder.projects.close())).ok, 'the project closes');
  await win.waitForSelector('.welcome');
  // The project's own helpers end with it, not half a minute later; nothing of it is left loaded in the editor.
  await eventually(async () => {
    const d = await described();
    assert.deepEqual(helpers(d), [], `no project helper outlives the close (${JSON.stringify(helpers(d))})`);
    assert.equal(d.windows, 1, 'only the editor window is left: the thumbnails’ window closed with the project');
    assert.deepEqual(d.frames.filter((u) => !u.startsWith('app://')), [], 'the editor shows nothing of the project');
  }, HELPERS_MS, 200);
  // And then the very processes a fresh launch has, no more: Chromium ends the preview frame's renderer itself.
  await eventually(async () => {
    const now = await children();
    assert.deepEqual(now, fresh, `the processes at Welcome are a fresh launch's (${JSON.stringify((await described()).processes)})`);
  }, SETTLED_MS, 250);
  const settled = await described();
  totals.push(totalMb(settled));
  console.log(`after close ${cycle}: ${(await children()).length} children, ${totalMb(settled)} MB`);
  if (cycle === CYCLES) break;
  assert.ok((await win.evaluate((d) => window.builder.projects.open(d), dir)).ok, 'the project reopens');
  await win.waitForSelector('.editor');
  await waitForPreview();
}

step('memory at Welcome stays near a fresh launch’s and does not grow with each close');
console.log(`memory at Welcome: fresh ${totalMb(freshAt)} MB, after each close ${totals.join(', ')} MB`);
// The editor's own renderer keeps what it loaded for the editor (its code, fonts, caches): a margin, but a fixed one.
assert.ok(totals[totals.length - 1] <= totalMb(freshAt) + 300, `memory at Welcome stays within 300 MB of a fresh launch (${totalMb(freshAt)} → ${totals.join(', ')} MB)`);
assert.ok(totals[totals.length - 1] <= totals[0] + 150, `memory at Welcome does not grow with each close (${totals.join(', ')} MB)`);

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nproject-footprint: passed');
