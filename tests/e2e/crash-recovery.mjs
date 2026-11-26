// A crashed editor leaves no dead window (#886): when the editor's page dies, the app asks over its window whether to
// reload it, and Reload Editor brings back the editor of the same project, still the same opening (the project was
// never closed and opened again). An error nothing in the main process caught is reported in the app's own words, and
// the editor keeps working. Needs no preview.
//
// Playwright treats a crashed page as finished even once it reloads, so after the crash the page is read through the
// main process.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { choosersShown, desktopCursor, eventually, launch, scratch, step, withTimeout } from './harness.mjs';

const { WORK, cleanup } = scratch('crash-recovery');
const { app, win, errors } = await launch(WORK);

/** The editor window, as the app knows it (the thumbnails' hidden window is another). */
const windowId = () => app.evaluate(() => globalThis[Symbol.for('siteorigin.desktopFixtures')].editor);
const inPage = (code) =>
  withTimeout(
    app.evaluate(({ BrowserWindow }, c) => BrowserWindow.fromId(globalThis[Symbol.for('siteorigin.desktopFixtures')].editor).webContents.executeJavaScript(c), code),
    5000,
    'Reading the page'
  );
/** The open project's folder and opening, as the page sees them. */
const opening = () => inPage('window.builder.project.snapshot().then((s) => s && [s.dir, s.workspaceKey])');

step('create a Business site');
const dir = join(WORK, 'sites', 'harbour-bakery');
const created = await win.evaluate((o) => window.builder.projects.create(o), { name: 'Harbour Bakery', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
assert.ok(created.ok, `project created: ${created.message ?? ''}`);
await win.locator('.toolbar .site', { hasText: 'Harbour Bakery' }).waitFor({ timeout: 60000 });
const before = await opening();
assert.equal(before?.[0], dir, 'the project is open');
assert.ok(before?.[1], 'the project has an opening');

step('a crashed editor asks to be loaded again, and Reload Editor brings back the same project');
const editor = await windowId();
const mark = await desktopCursor(app);
await inPage('window.beforeCrash = true');
// The crash's question is answered once the crash has been tidied up (which expires answers set before it): this
// listener runs after the app's own, in the same turn, before the question is due.
const reason = await app.evaluate(({ BrowserWindow }) => {
  const fixtures = globalThis[Symbol.for('siteorigin.desktopFixtures')];
  const contents = BrowserWindow.fromId(fixtures.editor).webContents;
  const gone = new Promise((resolve, reject) => {
    const late = setTimeout(() => reject(new Error('The renderer did not crash within 30s')), 30000);
    contents.once('render-process-gone', (_e, details) => {
      clearTimeout(late);
      fixtures.setAnswers([{ dialog: 'message', message: 'The editor stopped unexpectedly', button: 'Reload Editor' }]);
      resolve(details.reason);
    });
  });
  contents.forcefullyCrashRenderer();
  return gone;
});
assert.notEqual(reason, 'clean-exit', 'the editor crashed');
await eventually(
  async () => assert.equal(await inPage(`!window.beforeCrash && !!document.querySelector('.editor') && document.querySelector('.toolbar .site')?.textContent.includes('Harbour Bakery')`), true, 'the reloaded editor shows the project'),
  60000
);
assert.equal(await windowId(), editor, 'the same window came back');
assert.deepEqual(await opening(), before, 'the same opening of the project is still open');
const asked = (await choosersShown(app, mark)).filter((c) => c.dialog === 'message');
assert.deepEqual(
  asked.map((c) => [c.window, c.message, c.outcome, c.result?.label]),
  [[editor, 'The editor stopped unexpectedly', 'chosen', 'Reload Editor']],
  'one question, over the editor window, answered with Reload Editor'
);
assert.match(asked[0].detail, /return to your project/);

step('an error the main process did not catch is reported in the app’s own words, and the editor keeps working');
const errorMark = await desktopCursor(app);
await app.evaluate(() => {
  setTimeout(() => {
    throw new Error('A test error in the main process');
  }, 0);
});
await eventually(async () => {
  const shown = (await choosersShown(app, errorMark)).filter((c) => c.dialog === 'message');
  assert.deepEqual(
    shown.map((c) => [c.message, c.result?.label]),
    [['SiteOrigin Builder ran into a problem', 'Keep Working']],
    'the error was reported, and closing the report kept the app running'
  );
  assert.match(shown[0].detail, /^A test error in the main process\n\n/);
});
assert.deepEqual(await opening(), before, 'the project is still open');
assert.equal(await inPage(`!!document.querySelector('.editor')`), true, 'the editor is still there');

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\ncrash-recovery: all checks passed');
