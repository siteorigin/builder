// Shared setup for the end-to-end scripts: scratch folders, launching the built app, the platform
// shortcut modifier and polling assertions.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { desktopInMain, findMenuNode, invokeMenuInMain, menuTreeInMain } from '../driver/desktop.ts';
import { launchApp } from '../driver/session.ts';

/** The primary shortcut modifier: Cmd on macOS, Ctrl on Windows and Linux. */
export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * Scratch folders for one script run. WORK is a fresh folder created for this run inside $WORK (or the OS
 * temp folder), so a run never deletes anything it did not create and parallel runs never collide.
 * SHOTS defaults to a folder under the OS temp folder. Paths are resolved, because Vite fails to import
 * through a symlinked project path (the macOS temp folder is one). Call `cleanup()` once the script has
 * passed; a failed run keeps its folder for inspection, and its path is printed at the start.
 */
export function scratch(name) {
  const parent = resolve(process.env.WORK ?? realpathSync(tmpdir()));
  const shots = resolve(process.env.SHOTS ?? join(realpathSync(tmpdir()), 'so-e2e-shots'));
  mkdirSync(parent, { recursive: true });
  mkdirSync(shots, { recursive: true });
  const WORK = realpathSync(mkdtempSync(join(parent, `so-e2e-${name}-`)));
  console.log(`${name}: WORK=${WORK} SHOTS=${realpathSync(shots)}`);
  return { WORK, SHOTS: realpathSync(shots), cleanup: () => rmSync(WORK, { recursive: true, force: true }) };
}

/** Race a promise against a deadline, so a hung app call fails the script instead of stalling it. */
export function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000}s`)), ms)))]).finally(() => clearTimeout(timer));
}

/** The environment `launch` gives the app: its own settings folder and Documents folder inside the run's
 *  scratch folder (so the New project dialog's default location never reaches the developer's Documents),
 *  and no AI provider keys, unless `env` says otherwise. The Documents folder is not overridable: no script may write outside its scratch folder. */
export function launchEnv(WORK, env = {}, base = process.env) {
  return { ...base, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ...env, SITEORIGIN_DOCUMENTS: join(WORK, 'documents') };
}

/** Launch the built app (out/) with its own settings folder and Documents folder and no AI provider keys unless given. The page
 *  gets an emulated 1440×900 viewport, unless `viewport` is null: then it follows the (hidden) native window.
 *  An app that never becomes ready is killed with everything it started before the error is thrown. For a run
 *  isolated from everything of the caller's (profile, Documents, environment), use tests/driver/session.ts. */
export async function launch(WORK, env = {}, { viewport = { width: 1440, height: 900 } } = {}, launcher = launchApp) {
  const { app, win, errors } = await launcher({
    env: launchEnv(WORK, env),
    viewport: viewport ?? null,
    timeoutMs: 90000
  });
  return { app, win, errors };
}

/** Create a project through the same IPC call the New project dialog uses, and wait for its preview. */
export async function createProject(win, opts) {
  const res = await win.evaluate((o) => window.builder.projects.create(o), opts);
  if (!res.ok) throw new Error(`Project creation failed: ${res.message ?? JSON.stringify(res)}`);
  await win.waitForSelector('.editor');
  const frame = win.frameLocator('.frame-box iframe');
  try {
    await frame.locator(opts.starter === 'blank' ? 'body *' : 'h1').first().waitFor({ timeout: 90000 });
  } catch (error) {
    console.error('preview startup state', JSON.stringify({
      src: await win.locator('.frame-box iframe').getAttribute('src').catch(() => null),
      body: await frame.locator('body').innerText({ timeout: 3000 }).catch(() => null),
      status: await win.locator('.status-card').allInnerTexts().catch(() => [])
    }));
    throw error;
  }
  // The selection bridge loads after hydration; clicks before it is ready are lost.
  await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
  return frame;
}

/**
 * Retry `check` (which throws, usually through node:assert, while the condition does not hold) until it
 * passes or `timeout` ms elapse; then the last failure is thrown. Use it for anything the app writes
 * or renders asynchronously instead of a fixed sleep.
 */
/**
 * The project's snapshot once the pictures an import added (`ids`) have their copies: an import answers as soon as its
 * pictures land, and makes their copies after (#979).
 */
export async function copiesMade(win, ids, timeout = 120000) {
  return eventually(async () => {
    const snap = await win.evaluate(() => window.builder.project.snapshot());
    const waiting = ids.filter((id) => snap.state.assets.assets[id]?.copiesPending);
    assert.deepEqual(waiting, [], 'the imported pictures have their copies');
    return snap;
  }, timeout, 200);
}

export async function eventually(check, timeout = 10000, interval = 150) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      return await check();
    } catch (e) {
      if (Date.now() >= end) throw e;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}

/**
 * Every process's command line, by pid, read from the system rather than any session's bookkeeping. Windows has no
 * `ps`: there the same `pid command` lines come from the process table PowerShell reads.
 */
export function processCommands() {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }']]
      : ['ps', ['-A', '-o', 'pid=,command=']];
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (e, out) => {
      if (e) return reject(e);
      const map = new Map();
      for (const line of String(out).split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/);
        if (m) map.set(Number(m[1]), m[2]);
      }
      resolve(map);
    })
  );
}

/** Each process whose command line names `dir`, as `pid command`. */
export const processesNaming = async (dir) => [...(await processCommands())].filter(([, c]) => c.includes(dir)).map(([pid, c]) => `${pid} ${c}`);

export const step = (m) => console.log(`\n== ${m}`);

/** The right panel opens on the AI (#696): a script that works in the Inspector opens its tab first, as a person would. */
export async function openInspector(win) {
  const tab = win.locator('#dock-tab-inspect');
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await win.locator('#dock-panel-inspect').waitFor();
}

/**
 * Every tab on the page names, in aria-controls, exactly one element: its own tabpanel, labelled by it back,
 * shown only while the tab is selected. At least two tabs must be found `within` the given element.
 */
export async function assertTabsResolve(win, where, within = '.modal') {
  const problems = await win.evaluate((within) => {
    const out = [];
    if (document.querySelectorAll(`${within} [role="tab"]`).length < 2) out.push(`fewer than two tabs in ${within}`);
    for (const tab of document.querySelectorAll('[role="tab"]')) {
      const id = tab.getAttribute('aria-controls');
      const panels = id ? document.querySelectorAll(`#${CSS.escape(id)}`) : [];
      if (panels.length !== 1) {
        out.push(`${tab.id}: aria-controls "${id}" matches ${panels.length} elements`);
        continue;
      }
      const panel = panels[0];
      if (panel.getAttribute('role') !== 'tabpanel' || panel.getAttribute('aria-labelledby') !== tab.id) out.push(`${tab.id}: "${id}" is not its tabpanel`);
      const selected = tab.getAttribute('aria-selected') === 'true';
      if ((getComputedStyle(panel).display !== 'none') !== selected) out.push(`${tab.id}: its panel is ${selected ? 'hidden' : 'shown'} while the tab is ${selected ? '' : 'not '}selected`);
    }
    return out;
  }, within);
  assert.deepEqual(problems, [], `every tab controls a panel on the page (${where})`);
}

/**
 * A check for a known, tracked app bug: its failure is reported but does not fail the script. When it
 * starts passing, the log says so; remove the wrapper then, so the check guards against regressions.
 */
export async function knownFailure(issue, check) {
  try {
    await check();
    console.log(`\n!! KNOWN FAILURE NOW PASSES (${issue}): remove the knownFailure() wrapper.`);
  } catch (e) {
    console.log(`\n!! KNOWN FAILURE (${issue}): ${String(e.message).split('\n')[0]}`);
  }
}

// ---------------------------------------------------------------------------
// The desktop around the editor (#494): an automated app answers every native chooser from the answers a script set
// (src/main/headless-desktop.ts) and records links, reveals and menu choices instead of acting on the desktop.
// ---------------------------------------------------------------------------

/**
 * Answer the next native choosers, in order, replacing any answers still waiting ([] clears them). Each answer is
 * { dialog: 'open' | 'save' | 'message', title?, message?, selection?, ... } with one of { cancel: true }, { paths }
 * (open), { path, overwrite? } (save) or { button } (message), paths absolute. A chooser with no answer meant for it is
 * closed without a choice and recorded. Returns the answers' ids.
 */
export async function answerChoosers(app, answers) {
  const set = await app.evaluate(desktopInMain, { op: 'setAnswers', answers, request: null });
  if (set.error) throw new Error(set.error);
  return set.ids;
}

/** What happened at the desktop after the cursor `after`: { entries, next, dropped, pending }. */
export const desktopEvents = (app, after = 0) => app.evaluate(desktopInMain, { op: 'events', after, limit: 1000 });

/** The choosers shown after the cursor `after`, oldest first. */
export const choosersShown = async (app, after = 0) => (await desktopEvents(app, after)).entries.filter((e) => e.type === 'chooser');

/** The links, reveals and opened paths the app handed to the desktop after the cursor `after`. */
export const desktopIntents = async (app, after = 0) => (await desktopEvents(app, after)).entries.filter((e) => e.type === 'intent');

/** The current end of the desktop record: a cursor to read what happens next from. */
export const desktopCursor = (app) => app.evaluate(desktopInMain, { op: 'cursor' });

/** The native application menu, as a tree of { label, path, enabled, visible, accelerator, invokable, items }. */
export const menuTree = (app) => app.evaluate(menuTreeInMain);

/** One menu item by its labels from the menu bar down, or null. */
export const menuItem = async (app, ...path) => findMenuNode(await menuTree(app), path);

/**
 * Choose application menu items through their own handlers, one after the other in the same turn of the main process,
 * for the editor window (or, with none open, for none). Each path is the item's labels from the menu bar down; a
 * missing, hidden or disabled item is refused, choosing nothing more.
 */
export async function chooseMenu(app, ...paths) {
  const window = await app.evaluate(({ BrowserWindow }) => {
    // The app knows its editor window from the moment it is made, whatever address its page has (a dev server's too).
    const known = globalThis[Symbol.for('siteorigin.desktopFixtures')]?.editor;
    if (known !== null && known !== undefined) {
      const w = BrowserWindow.fromId(known);
      return w && !w.isDestroyed() ? known : null;
    }
    const editor = BrowserWindow.getAllWindows().find((w) => {
      try {
        const u = new URL(w.webContents.getURL());
        return !w.isDestroyed() && u.protocol === 'app:' && u.host === 'editor';
      } catch {
        return false;
      }
    });
    return editor ? editor.id : null;
  });
  return app.evaluate(invokeMenuInMain, { paths, window, request: null });
}
