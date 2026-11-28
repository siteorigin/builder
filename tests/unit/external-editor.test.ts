/**
 * Handing a file or the project's folder to the developer's own code editor (#1483): started without a shell, the
 * failure said, and in an automated run recorded rather than started.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { checkEditorApp, editorLaunch, openInEditor, setEditorHandOff, storedEditor, type EditorHandOff } from '../../src/main/external-editor';
import { createDesktopFixtures } from '../../src/main/headless-desktop';

afterEach(() => setEditorHandOff(null));

/** A hand-off that records what it was asked, and fails when told to. */
function recorder(fail: { open?: string; launch?: boolean } = {}) {
  const calls: unknown[][] = [];
  const handOff: EditorHandOff = {
    openPath: async (p) => (calls.push(['openPath', p]), fail.open ?? ''),
    reveal: (p) => void calls.push(['reveal', p]),
    launch: async (e, t) => {
      calls.push(['launch', e.path, t]);
      if (fail.launch) throw new Error('ENOENT');
    }
  };
  return { calls, handOff };
}

describe('editorLaunch', () => {
  it('starts a macOS application with open -a, the target after --, and a program elsewhere with the target alone', () => {
    const target = '/Users/me/My Site/src/lib/$(rm -rf ~).js';
    expect(editorLaunch({ path: '/Applications/Visual Studio Code.app' }, target, 'darwin')).toEqual({ command: '/usr/bin/open', args: ['-a', '/Applications/Visual Studio Code.app', '--', target] });
    expect(editorLaunch({ path: 'C:\\Program Files\\Code\\Code.exe' }, 'C:\\site\\src\\a.js', 'win32')).toEqual({ command: 'C:\\Program Files\\Code\\Code.exe', args: ['C:\\site\\src\\a.js'] });
    expect(editorLaunch({ path: '/usr/bin/code' }, '-rf', 'linux')).toEqual({ command: '/usr/bin/code', args: ['-rf'] });
  });
});

describe('checkEditorApp', () => {
  const dir = { isDirectory: () => true, isFile: () => false, mode: 0o755 };
  const file = (mode = 0o755) => ({ isDirectory: () => false, isFile: () => true, mode });
  it('takes an application bundle on macOS, a program on Windows and an executable elsewhere', () => {
    expect(checkEditorApp('/Applications/Cursor.app', 'darwin', () => dir)).toEqual({ ok: true, editor: { kind: 'app', path: '/Applications/Cursor.app', name: 'Cursor' } });
    expect(checkEditorApp('C:\\Code\\Code.exe', 'win32', () => file())).toMatchObject({ ok: true, editor: { name: 'Code' } });
    expect(checkEditorApp('/usr/bin/zed', 'linux', () => file())).toMatchObject({ ok: true, editor: { name: 'zed' } });
  });

  it('refuses anything else, saying what to choose', () => {
    expect(checkEditorApp('/Applications/notes.txt', 'darwin', () => file())).toMatchObject({ ok: false });
    expect(checkEditorApp('C:\\Users\\me\\bin\\code.cmd', 'win32', () => file())).toMatchObject({ ok: false, message: expect.stringContaining('.exe') });
    expect(checkEditorApp('/home/me/notes.txt', 'linux', () => file(0o644))).toMatchObject({ ok: false });
    expect(checkEditorApp('relative/code', 'linux', () => file())).toMatchObject({ ok: false });
    expect(checkEditorApp('/gone/Code.app', 'darwin', () => null)).toMatchObject({ ok: false });
  });
});

describe('openInEditor', () => {
  it('opens with the system’s default app, and says why it could not', async () => {
    const ok = recorder();
    expect(await openInEditor({ kind: 'system' }, '/site/src/a.js', ok.handOff)).toEqual({ ok: true });
    expect(ok.calls).toEqual([['openPath', '/site/src/a.js']]);
    const failed = recorder({ open: 'No application knows how to open this file' });
    expect(await openInEditor({ kind: 'system' }, '/site/src/a.js', failed.handOff)).toEqual({ ok: false, message: 'Your computer could not open a.js: No application knows how to open this file' });
  });

  it('never asks Windows to open a script, which it would run: it is shown in File Explorer instead', async () => {
    for (const file of ['C:\\site\\src\\lib\\util.js', 'C:\\site\\src\\lib\\util.CJS', 'C:\\site\\src\\lib\\util.mjs', 'C:\\site\\tools\\run.vbs']) {
      const r = recorder();
      expect(await openInEditor({ kind: 'system' }, file, r.handOff, 'win32')).toMatchObject({ ok: false, chooseAgain: true, message: expect.stringContaining('File Explorer') });
      expect(r.calls).toEqual([['reveal', file]]);
    }
    // Anything else opens, and a chosen editor opens scripts too.
    const css = recorder();
    expect(await openInEditor({ kind: 'system' }, 'C:\\site\\src\\app.css', css.handOff, 'win32')).toEqual({ ok: true });
    expect(css.calls).toEqual([['openPath', 'C:\\site\\src\\app.css']]);
    const chosen = recorder();
    expect(await openInEditor({ kind: 'app', path: 'C:\\Code\\Code.exe', name: 'Code' }, 'C:\\site\\src\\lib\\util.js', chosen.handOff, 'win32')).toEqual({ ok: true });
    expect(chosen.calls).toEqual([['launch', 'C:\\Code\\Code.exe', 'C:\\site\\src\\lib\\util.js']]);
    // Elsewhere a script opens in the app the system keeps for it.
    const mac = recorder();
    expect(await openInEditor({ kind: 'system' }, '/site/src/lib/util.js', mac.handOff, 'darwin')).toEqual({ ok: true });
  });

  it('starts the chosen application, and asks for another when it could not be started', async () => {
    const ok = recorder();
    const editor = { kind: 'app' as const, path: '/Applications/Cursor.app', name: 'Cursor' };
    expect(await openInEditor(editor, '/site', ok.handOff)).toEqual({ ok: true });
    expect(ok.calls).toEqual([['launch', '/Applications/Cursor.app', '/site']]);
    expect(await openInEditor(editor, '/site', recorder({ launch: true }).handOff)).toMatchObject({ ok: false, chooseAgain: true, message: expect.stringContaining('Cursor') });
  });

  it('records the hand-off in an automated run, and starts nothing', async () => {
    const desktop = createDesktopFixtures();
    setEditorHandOff(desktop.codeEditor);
    const real = recorder();
    expect(await openInEditor({ kind: 'app', path: '/Applications/Cursor.app', name: 'Cursor' }, '/site/src/lib/a.js', real.handOff)).toEqual({ ok: true });
    expect(await openInEditor({ kind: 'system' }, '/site', real.handOff)).toEqual({ ok: true });
    expect(real.calls).toEqual([]);
    const intents = desktop.fixtures.events().entries.filter((e) => e.type === 'intent');
    expect(intents).toMatchObject([
      { kind: 'open-editor', target: '/site/src/lib/a.js', program: '/Applications/Cursor.app' },
      { kind: 'open-path', target: '/site' }
    ]);
  });
});

describe('storedEditor', () => {
  it('reads a hand-edited setting that is no usable choice as the system’s default', () => {
    expect(storedEditor(undefined)).toEqual({ kind: 'system' });
    expect(storedEditor({ kind: 'app', path: 'code', name: 'Code' })).toEqual({ kind: 'system' });
    expect(storedEditor({ kind: 'app', path: '/usr/bin/code', name: '' })).toEqual({ kind: 'system' });
    expect(storedEditor({ kind: 'app', path: '/usr/bin/code', name: 'code', extra: 1 })).toEqual({ kind: 'app', path: '/usr/bin/code', name: 'code' });
  });
});
