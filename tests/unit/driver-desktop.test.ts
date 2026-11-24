// The test driver's desktop operations (tests/driver/desktop.ts and their Session ops, #494) without launching the app:
// the application menu read and chosen through its own handlers, chooser answers resolved to the session's own files,
// sample images staged for import, and the session folders listed. The app's main process is stood in for by running
// each `*InMain` function against fake Electron modules, as Playwright's app.evaluate runs it in the real one.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDesktopFixtures, DESKTOP_FIXTURES } from '../../src/main/headless-desktop';
import { findMenuNode, invokeMenuInMain, listSessionFolder, menuTreeInMain, resolveAnswer, resolveSessionPath, stageImport } from '../driver/desktop.ts';
import type { Area } from '../driver/desktop.ts';
import type { Failure, Reply, Success } from '../driver/protocol.ts';
import { REPO_ROOT, Session } from '../driver/session.ts';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'driver-desktop-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A session's folders, with a few files, and a folder of the caller's beside them. */
function folders() {
  const root = mkdtempSync(join(scratch, 'root-'));
  const areas: Record<Area, string> = { imports: join(root, 'imports'), exports: join(root, 'exports'), workspace: join(root, 'workspace') };
  for (const d of Object.values(areas)) mkdirSync(d, { recursive: true });
  mkdirSync(join(root, 'profile'));
  writeFileSync(join(root, 'profile', 'api-keys.json'), '{}');
  writeFileSync(join(areas.exports, 'site.zip'), 'zip');
  mkdirSync(join(areas.workspace, 'SiteOrigin', 'bakery'), { recursive: true });
  const outside = mkdtempSync(join(scratch, 'callers-'));
  writeFileSync(join(outside, 'secret.txt'), 'mine');
  return { root, areas, outside };
}

/** A fake application menu: File (New, Open, Export disabled, Close role), Edit (Undo, a hidden item, Cut role). */
function fakeMenu() {
  const clicks: { label: string; args: unknown[] }[] = [];
  const item = (o: Record<string, unknown>) => {
    const it: Record<string, unknown> = { type: 'normal', enabled: true, visible: true, checked: false, label: '', role: undefined, id: '', accelerator: undefined, ...o };
    it.click = (...args: unknown[]) => clicks.push({ label: String(it.label), args });
    return it;
  };
  const sub = (items: unknown[]) => ({ items });
  const menu = {
    items: [
      item({ label: 'SiteOrigin Builder', role: 'appmenu', type: 'submenu', submenu: sub([item({ label: 'Quit', role: 'quit' })]) }),
      item({
        label: 'File',
        type: 'submenu',
        submenu: sub([
          item({ label: 'New Project…', accelerator: 'CmdOrCtrl+Shift+N' }),
          item({ label: 'Open Project…', accelerator: 'CmdOrCtrl+O' }),
          item({ type: 'separator' }),
          item({ label: 'Export…', id: 'export', enabled: false }),
          item({ label: 'Close Window', role: 'close' })
        ])
      }),
      item({
        label: 'Edit',
        type: 'submenu',
        submenu: sub([item({ label: 'Undo', id: 'edit-undo' }), item({ label: 'Secret', visible: false }), item({ label: 'Cut', role: 'cut' }), item({ label: 'Twice' }), item({ label: 'Twice' }), item({ label: 'Smart quotes', type: 'checkbox', checked: true })])
      }),
      item({ label: 'Window', type: 'submenu', enabled: false, submenu: sub([item({ label: 'Minimize' })]) })
    ]
  };
  const windows = new Map<number, { id: number; webContents: { id: number; getURL: () => string }; isDestroyed: () => boolean }>();
  const destroyed = new Set<number>();
  const addWindow = (id: number, url = 'app://editor/index.html') => windows.set(id, { id, webContents: { id: id * 10, getURL: () => url }, isDestroyed: () => destroyed.has(id) });
  const electron = {
    Menu: { getApplicationMenu: () => menu },
    BrowserWindow: { fromId: (id: number) => windows.get(id) ?? null, getAllWindows: () => [...windows.values()] }
  };
  return { electron, clicks, windows, addWindow, destroyed, menu };
}

/** Run with fixtures installed where the *InMain functions find them. */
function withFixtures<T>(fn: (d: ReturnType<typeof createDesktopFixtures>) => T): T {
  const d = createDesktopFixtures();
  (globalThis as Record<symbol, unknown>)[DESKTOP_FIXTURES] = d.fixtures;
  try {
    return fn(d);
  } finally {
    delete (globalThis as Record<symbol, unknown>)[DESKTOP_FIXTURES];
  }
}

describe('the application menu', () => {
  it('lists every item but separators, with its state, and which the driver can choose', () => {
    const { electron } = fakeMenu();
    const tree = menuTreeInMain(electron);
    expect(tree.map((n) => n.label)).toEqual(['SiteOrigin Builder', 'File', 'Edit', 'Window']);
    expect(findMenuNode(tree, ['File'])!.items!.map((n) => [n.label, n.enabled, n.invokable, n.accelerator])).toEqual([
      ['New Project…', true, true, 'CmdOrCtrl+Shift+N'],
      ['Open Project…', true, true, 'CmdOrCtrl+O'],
      ['Export…', false, true, null],
      ['Close Window', true, false, null]
    ]);
    expect(findMenuNode(tree, ['Edit', 'Undo'])).toMatchObject({ path: ['Edit', 'Undo'], id: 'edit-undo', visible: true, role: null });
    expect(findMenuNode(tree, ['Edit', 'Secret'])).toMatchObject({ visible: false });
    expect(findMenuNode(tree, ['Edit', 'Cut'])).toMatchObject({ role: 'cut', invokable: false });
    expect(findMenuNode(tree, ['Edit', 'Smart quotes'])).toMatchObject({ type: 'checkbox', checked: true, invokable: true });
    expect(findMenuNode(tree, ['Edit', 'Undo'])).toMatchObject({ checked: false });
    expect(findMenuNode(tree, ['File'])).toMatchObject({ invokable: false, type: 'submenu' });
    expect(findMenuNode(tree, ['File', 'Nothing'])).toBeNull();
  });

  it('chooses an item through its own handler, for the editor window, and records it', () => {
    const { electron, clicks, addWindow } = fakeMenu();
    addWindow(3);
    const d = createDesktopFixtures();
    (globalThis as Record<symbol, unknown>)[DESKTOP_FIXTURES] = d.fixtures;
    try {
      const done = invokeMenuInMain(electron, { paths: [['File', 'New Project…'], ['File', 'Open Project…']], window: 3, request: 'r1' });
      expect(done.map((x) => x.path.at(-1))).toEqual(['New Project…', 'Open Project…']);
      expect(clicks.map((c) => c.label)).toEqual(['New Project…', 'Open Project…']);
      // The instance's own click: (event, window, webContents), with no keys held.
      expect(clicks[0].args).toEqual([{ triggeredByAccelerator: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }, expect.objectContaining({ id: 3 }), expect.objectContaining({ id: 30 })]);
      const menus = d.fixtures.events().entries.filter((e) => e.type === 'menu');
      expect(menus.map((e) => e.type === 'menu' && [e.path.join(' > '), e.window, e.request, e.seq])).toEqual([
        ['File > New Project…', 3, 'r1', done[0].seq],
        ['File > Open Project…', 3, 'r1', done[1].seq]
      ]);
    } finally {
      delete (globalThis as Record<symbol, unknown>)[DESKTOP_FIXTURES];
    }
  });

  it('refuses, choosing nothing, what a person could not choose there', () => {
    const { electron, clicks, addWindow } = fakeMenu();
    addWindow(3);
    const refused: [string[], RegExp][] = [
      [['File', 'Export…'], /^\[disabled\] File > Export… is disabled/],
      [['Edit', 'Secret'], /^\[hidden\] Edit > Secret is hidden/],
      [['Window', 'Minimize'], /^\[disabled\] Window is disabled/],
      [['File', 'Close Window'], /^\[not-invokable\] File > Close Window is the system's close command/],
      [['File'], /^\[not-invokable\] File opens a submenu/],
      [['Edit', 'Twice'], /^\[ambiguous\]/],
      [['File', 'Print…'], /^\[not-found\] There is no menu item File > Print…/],
      [['File', 'New Project…', 'More'], /^\[not-found\] File > New Project… has no submenu/]
    ];
    withFixtures((d) => {
      for (const [path, message] of refused) expect(() => invokeMenuInMain(electron, { paths: [path], window: 3, request: null })).toThrow(message);
      // Items chosen in one turn stop at the first refused.
      expect(() => invokeMenuInMain(electron, { paths: [['File', 'Export…'], ['File', 'New Project…']], window: 3, request: null })).toThrow(/disabled/);
      expect(clicks).toEqual([]);
      expect(d.fixtures.events().entries.filter((e) => e.type === 'menu'), 'nothing refused is recorded as chosen').toEqual([]);
    });
  });

  it('each item is checked as it is chosen: one an earlier item disabled is refused', () => {
    const { electron, clicks, addWindow, menu } = fakeMenu();
    addWindow(3);
    const file = (menu.items[1] as any).submenu.items;
    const open = file.find((i: any) => i.label === 'Open Project…');
    const newProject = file.find((i: any) => i.label === 'New Project…');
    newProject.click = () => {
      clicks.push({ label: 'New Project…', args: [] });
      open.enabled = false;
    };
    expect(() => invokeMenuInMain(electron, { paths: [['File', 'New Project…'], ['File', 'Open Project…']], window: 3, request: null })).toThrow(/^\[disabled\] File > Open Project…/);
    expect(clicks.map((c) => c.label)).toEqual(['New Project…']);
  });

  it('chooses for no window only while none is open, and never for one that went', () => {
    const { electron, clicks, addWindow, windows, destroyed } = fakeMenu();
    expect(() => invokeMenuInMain(electron, { paths: [['File', 'New Project…']], window: 3, request: null })).toThrow(/^\[window-closed\] Editor window 3 is gone/);
    addWindow(3);
    destroyed.add(3);
    expect(() => invokeMenuInMain(electron, { paths: [['File', 'New Project…']], window: 3, request: null })).toThrow(/^\[window-closed\] Editor window 3 is gone/);
    windows.clear();
    invokeMenuInMain(electron, { paths: [['File', 'New Project…']], window: null, request: null });
    expect(clicks[0].args.slice(1)).toEqual([undefined, undefined]);
    // A hidden window of another page (the thumbnails') is no editor.
    addWindow(5, 'about:blank');
    invokeMenuInMain(electron, { paths: [['File', 'Open Project…']], window: null, request: null });
    addWindow(4);
    expect(() => invokeMenuInMain(electron, { paths: [['File', 'New Project…']], window: null, request: null })).toThrow(/^\[window-open\]/);
    windows.clear();
    expect(clicks.map((c) => c.label)).toEqual(['New Project…', 'Open Project…']);
  });

  it('knows the app’s editor window from the moment it is made, before its page has an address', () => {
    const { electron, clicks, addWindow } = fakeMenu();
    addWindow(6, '');
    withFixtures((d) => {
      d.windows.opened(6);
      expect(() => invokeMenuInMain(electron, { paths: [['File', 'New Project…']], window: null, request: null })).toThrow(/^\[window-open\]/);
      d.windows.gone(6, { closed: true });
      invokeMenuInMain(electron, { paths: [['File', 'New Project…']], window: null, request: null });
    });
    expect(clicks.map((c) => c.label)).toEqual(['New Project…']);
  });
});

describe('session paths', () => {
  it('names the session’s own folders, logically or absolutely, and resolves links', async () => {
    const { root, areas } = folders();
    expect(await resolveSessionPath(areas, 'exports/site.zip', ['exports'])).toBe(join(areas.exports, 'site.zip'));
    expect(await resolveSessionPath(areas, 'workspace', ['workspace'])).toBe(areas.workspace);
    expect(await resolveSessionPath(areas, 'workspace/SiteOrigin/bakery', ['exports', 'workspace'])).toBe(join(areas.workspace, 'SiteOrigin', 'bakery'));
    expect(await resolveSessionPath(areas, join(areas.exports, 'new', 'site.zip'), ['exports'])).toBe(join(areas.exports, 'new', 'site.zip'));
    symlinkSync(areas.workspace, join(areas.exports, 'to-workspace'));
    expect(await resolveSessionPath(areas, 'exports/to-workspace/x.zip', ['exports', 'workspace'])).toBe(join(areas.workspace, 'x.zip'));
    void root;
  });

  it('refuses anything outside the folders allowed: the profile, the caller’s, a way out by .. or a link', async () => {
    const { root, areas, outside } = folders();
    symlinkSync(outside, join(areas.imports, 'escape'));
    // Named outside, leading in: refused by the name, before anything is looked up.
    symlinkSync(areas.exports, join(outside, 'into-exports'));
    // A link to nowhere: a write would follow it out.
    symlinkSync(join(outside, 'not-yet'), join(areas.exports, 'dangling.zip'));
    const refused: [unknown, Area[]][] = [
      ['profile/api-keys.json', ['imports', 'exports', 'workspace']],
      [join(root, 'profile', 'api-keys.json'), ['imports', 'exports', 'workspace']],
      [join(outside, 'secret.txt'), ['imports', 'exports', 'workspace']],
      ['imports/../profile/api-keys.json', ['imports', 'exports', 'workspace']],
      ['imports/escape/secret.txt', ['imports', 'exports', 'workspace']],
      ['imports/logo.jpg', ['exports', 'workspace']],
      [join(outside, 'into-exports', 'site.zip'), ['exports']],
      ['exports/dangling.zip', ['exports']],
      ['exports/dangling.zip/inside', ['exports']],
      ['', ['exports']],
      [42, ['exports']]
    ];
    for (const [input, allowed] of refused) await expect(resolveSessionPath(areas, input, allowed), String(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('a session folder replaced by a link since the session made it leads nowhere allowed', async () => {
    const { areas, outside } = folders();
    rmSync(areas.exports, { recursive: true });
    symlinkSync(outside, areas.exports);
    for (const input of ['exports/secret.txt', 'exports', join(areas.exports, 'new.zip')]) await expect(resolveSessionPath(areas, input, ['exports']), input).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(listSessionFolder(areas, 'exports')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('resolves the paths an answer names, for what its chooser does: open reads, save writes only into exports', async () => {
    const { areas } = folders();
    const open = ['imports', 'exports', 'workspace'].map((k) => areas[k as Area]);
    expect(await resolveAnswer(areas, { dialog: 'open', paths: ['exports/site.zip', 'workspace'] })).toEqual({ dialog: 'open', paths: [join(areas.exports, 'site.zip'), areas.workspace], within: open });
    expect(await resolveAnswer(areas, { dialog: 'save', path: 'exports/out.zip', overwrite: 'replace' })).toEqual({ dialog: 'save', path: join(areas.exports, 'out.zip'), overwrite: 'replace', within: [areas.exports] });
    for (const path of ['imports/out.zip', 'workspace/SiteOrigin/bakery/siteorigin.project.json', 'workspace/copy']) await expect(resolveAnswer(areas, { dialog: 'save', path }), path).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(resolveAnswer(areas, { dialog: 'open', paths: ['imports'], within: ['/'] })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await resolveAnswer(areas, { dialog: 'message', button: 'OK' })).toEqual({ dialog: 'message', button: 'OK' });
  });
});

describe('session files', () => {
  it('stages a sample image under a new name, never over a file', async () => {
    const { areas } = folders();
    const staged = await stageImport(REPO_ROOT, areas.imports, { name: 'harbour.jpg', sample: 'hero.jpg' });
    expect(staged).toMatchObject({ path: join(areas.imports, 'harbour.jpg'), logical: 'imports/harbour.jpg', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(readFileSync(staged.path)).toEqual(readFileSync(join(REPO_ROOT, 'resources', 'starter-assets', 'hero.jpg')));
    await expect(stageImport(REPO_ROOT, areas.imports, { name: 'harbour.jpg', sample: 'studio.jpg' })).rejects.toMatchObject({ code: 'OP_FAILED', details: { reason: 'exists' } });
    expect(readFileSync(staged.path)).toEqual(readFileSync(join(REPO_ROOT, 'resources', 'starter-assets', 'hero.jpg')));
    for (const args of [{ name: '../x.jpg', sample: 'hero.jpg' }, { name: 'a\\b.jpg', sample: 'hero.jpg' }, { name: 'x.png', sample: 'hero.jpg' }, { sample: 'nope.jpg' }, { name: '.hidden.jpg', sample: 'hero.jpg' }, { sample: 'hero.jpg', from: '/etc/passwd' }])
      await expect(stageImport(REPO_ROOT, areas.imports, args), JSON.stringify(args)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(existsSync(join(areas.imports, 'x.png'))).toBe(false);
  });

  it('never stages into an imports folder something has put in place of the session’s', async () => {
    const { areas, outside } = folders();
    rmSync(areas.imports, { recursive: true });
    symlinkSync(outside, areas.imports);
    await expect(stageImport(REPO_ROOT, areas.imports, { name: 'x.jpg', sample: 'hero.jpg' })).rejects.toMatchObject({ code: 'OP_FAILED', details: { reason: 'moved' } });
    expect(existsSync(join(outside, 'x.jpg'))).toBe(false);
  });

  it('lists one level of a session folder', async () => {
    const { areas } = folders();
    mkdirSync(join(areas.exports, 'bakery-site'));
    expect(await listSessionFolder(areas, undefined)).toEqual({
      path: areas.exports,
      entries: [
        { name: 'bakery-site', path: join(areas.exports, 'bakery-site'), type: 'folder' },
        { name: 'site.zip', path: join(areas.exports, 'site.zip'), type: 'file', bytes: 3 }
      ]
    });
    await expect(listSessionFolder(areas, 'exports/site.zip')).rejects.toMatchObject({ code: 'OP_FAILED', details: { reason: 'not-a-folder' } });
    await expect(listSessionFolder(areas, 'profile')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('the session’s desktop operations', () => {
  let n = 0;
  const req = (op: string, args?: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ v: 1, id: `d${++n}`, op, ...(args ? { args } : {}), ...extra });
  const ok = <T>(r: Reply): T => {
    if (!r.ok) throw new Error(`${r.op} failed: ${r.error.code} ${r.error.message}`);
    return (r as Success<T>).result;
  };
  const err = (r: Reply) => {
    if (r.ok) throw new Error(`${r.op} succeeded`);
    return (r as Failure).error;
  };

  /** A started session whose app is stood in for: app.evaluate runs the function here against fake Electron. */
  function started() {
    const { root, areas } = folders();
    const desktop = createDesktopFixtures();
    const fake = fakeMenu();
    const s = new Session({ appRoot: REPO_ROOT });
    const any = s as any;
    any.state = 'ready';
    s.paths = { root, profile: join(root, 'profile'), workspace: areas.workspace, projects: join(areas.workspace, 'SiteOrigin'), imports: areas.imports, exports: areas.exports, home: join(root, 'home'), tmp: join(root, 'tmp'), artifacts: join(root, 'artifacts') };
    s.app = {
      evaluate: async (fn: (electron: unknown, arg: unknown) => unknown, arg: unknown) => {
        (globalThis as Record<symbol, unknown>)[DESKTOP_FIXTURES] = desktop.fixtures;
        try {
          return await fn(fake.electron, arg);
        } finally {
          delete (globalThis as Record<symbol, unknown>)[DESKTOP_FIXTURES];
        }
      }
    } as any;
    return { s, desktop, fake, areas };
  }
  beforeEach(() => void (n = 0));

  it('sets answers by session path, and refuses a malformed one or one outside the session', async () => {
    const { s, desktop, areas } = started();
    const set = ok<{ answers: string[] }>(await s.call(req('desktop.setAnswers', { answers: [{ dialog: 'open', paths: ['exports/site.zip'] }, { dialog: 'save', path: 'exports/out.zip' }] })));
    expect(set.answers).toHaveLength(2);
    expect(desktop.fixtures.events().pending.map((a) => [a.paths ?? a.path, a.request])).toEqual([
      [[join(areas.exports, 'site.zip')], 'd1'],
      [join(areas.exports, 'out.zip'), 'd1']
    ]);
    expect(err(await s.call(req('desktop.setAnswers', { answers: [{ dialog: 'open', paths: ['profile/api-keys.json'] }] })))).toMatchObject({ code: 'BAD_REQUEST' });
    expect(err(await s.call(req('desktop.setAnswers', { answers: [{ dialog: 'save', button: 'OK' }] })))).toMatchObject({ code: 'BAD_REQUEST', message: 'Answer 1: "button" is the label of a button, for a message chooser.' });
    // A malformed answer is the client's mistake, however it is worded.
    expect(err(await s.call(req('desktop.setAnswers', { answers: [{ dialog: 'open', cancel: true, '[window-closed] x': 1 }] })))).toMatchObject({ code: 'BAD_REQUEST', retryable: false });
    expect(err(await s.call(req('desktop.setAnswers', { answers: [{ dialog: 'save', path: 'workspace/copy' }] })))).toMatchObject({ code: 'BAD_REQUEST' });
    expect(err(await s.call(req('desktop.setAnswers', { answers: 'all' })))).toMatchObject({ code: 'BAD_REQUEST' });
    expect(err(await s.call(req('desktop.setAnswers', { answers: [], extra: 1 })))).toMatchObject({ code: 'BAD_REQUEST' });
    // Refusals changed nothing.
    expect(desktop.fixtures.events().pending.map((a) => a.id)).toEqual(set.answers);
    ok(await s.call(req('desktop.setAnswers', { answers: [] })));
    expect(desktop.fixtures.events().pending).toEqual([]);
  });

  it('reads the desktop record from a cursor', async () => {
    const { s, desktop } = started();
    await desktop.dialog.showOpenDialog({ id: 1 }, { title: 'Open', properties: ['openFile'] });
    const first = ok<any>(await s.call(req('desktop.events')));
    expect(first.entries.map((e: any) => [e.type, e.outcome])).toEqual([['chooser', 'unanswered']]);
    expect(ok<any>(await s.call(req('desktop.events', { after: first.next }))).entries).toEqual([]);
    await desktop.dialog.showOpenDialog({ id: 1 }, { title: 'Open again', properties: ['openFile'] });
    expect(ok<any>(await s.call(req('desktop.events', { after: first.next, limit: 1 }))).entries.map((e: any) => e.title)).toEqual(['Open again']);
    expect(ok<any>(await s.call(req('desktop.events', { limit: 1 }))).entries.map((e: any) => e.title)).toEqual(['Open']);
    expect(err(await s.call(req('desktop.events', { after: -1 })))).toMatchObject({ code: 'BAD_REQUEST' });
    expect(err(await s.call(req('desktop.events', { limit: 0 })))).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('lists and chooses menu items; with no editor window open, for none', async () => {
    const { s, fake } = started();
    const { items } = ok<any>(await s.call(req('menu.list')));
    expect(findMenuNode(items, ['File', 'Export…'])).toMatchObject({ enabled: false, invokable: true });
    const done = ok<any>(await s.call(req('menu.invoke', { path: ['File', 'New Project…'] })));
    expect(done).toMatchObject({ path: ['File', 'New Project…'], window: null, status: 'dispatched' });
    expect(fake.clicks.map((c) => c.label)).toEqual(['New Project…']);
    expect(err(await s.call(req('menu.invoke', { path: ['File', 'Export…'] })))).toMatchObject({ code: 'OP_FAILED', retryable: false, details: { reason: 'disabled' } });
    expect(err(await s.call(req('menu.invoke', { path: 'File' })))).toMatchObject({ code: 'BAD_REQUEST' });
    // A window named that is not there.
    expect(err(await s.call(req('menu.invoke', { path: ['File', 'New Project…'] }, { expectWindow: 1 })))).toMatchObject({ code: 'WINDOW_CLOSED' });
    fake.addWindow(9);
    expect(err(await s.call(req('menu.invoke', { path: ['File', 'New Project…'] })))).toMatchObject({ code: 'OP_FAILED', retryable: true, details: { reason: 'window-open' } });
    expect(fake.clicks).toHaveLength(1);
  });

  it('stages and lists the session’s files', async () => {
    const { s } = started();
    const staged = ok<any>(await s.call(req('files.stageImport', { name: 'team.jpg', sample: 'person-1.jpg' })));
    expect(staged.logical).toBe('imports/team.jpg');
    expect(readFileSync(staged.path)).toEqual(readFileSync(join(REPO_ROOT, 'resources', 'starter-assets', 'person-1.jpg')));
    expect(ok<any>(await s.call(req('files.list', { path: 'imports' }))).entries.map((e: any) => e.name)).toEqual(['team.jpg']);
    expect(err(await s.call(req('files.list', { path: 'imports', deep: true })))).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('needs a started session', async () => {
    const s = new Session({ appRoot: REPO_ROOT });
    for (const op of ['window.close', 'menu.list', 'menu.invoke', 'desktop.setAnswers', 'desktop.events', 'files.stageImport', 'files.list']) expect(err(await s.call(req(op))).code, op).toBe('NOT_STARTED');
  });
});
