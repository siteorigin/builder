// Native choosers and desktop hand-offs in automated runs (src/main/headless-desktop.ts, #494): every chooser is
// answered from the batch a test set, in order and only over the window it was set for, or closed with a recorded,
// explained outcome; links, reveals and opened paths are recorded instead of done; and nothing reaches Electron's own
// dialog or shell. A normal launch gets none of it.
import { describe, expect, it } from 'vitest';
import { DESKTOP_FIXTURES, cancelButton, checkAnswer, createDesktopFixtures, desktopForLaunch, installHeadlessDesktop, launchMode, selectionOf } from '../../src/main/headless-desktop';
import type { ChooserEvent, DesktopEvent, DialogLike, ShellLike } from '../../src/main/headless-desktop';

/** A file system of a few folders and files. */
const FILES: Record<string, 'file' | 'folder'> = {
  '/s': 'folder',
  '/s/imports': 'folder',
  '/s/imports/hero.jpg': 'file',
  '/s/imports/team.png': 'file',
  '/s/imports/notes.txt': 'file',
  '/s/exports': 'folder',
  '/s/exports/site.zip': 'file',
  '/s/workspace': 'folder',
  '/s/workspace/SiteOrigin/bakery': 'folder',
  '/s/workspace/SiteOrigin/bakery/siteorigin.project.json': 'file'
};

/** Fixtures over that file system, with editor window 7 open. Paths really lead where they are named unless `real` says otherwise. */
function setup({ limit, real }: { limit?: number; real?: (p: string) => string | null } = {}) {
  let t = 0;
  const d = createDesktopFixtures({ kind: (p) => FILES[p] ?? null, now: () => `t${++t}`, limit, real: real ?? ((p) => p) });
  const win = { id: 7 };
  d.windows.opened(7);
  const choosers = () => d.fixtures.events().entries.filter((e): e is ChooserEvent => e.type === 'chooser');
  const last = () => choosers().at(-1)!;
  const answerEvents = (change: string) => d.fixtures.events().entries.filter((e) => e.type === 'answers' && e.change === change).map((e) => (e.type === 'answers' ? e.answers : []));
  return { d, win, ...d, choosers, last, answerEvents };
}

const FOLDER = { title: 'Choose a folder', properties: ['openDirectory', 'createDirectory'] };
const IMAGES = { title: 'Import images', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['jpg', 'png'] }] };
const OPEN_PROJECT_MAC = { title: 'Open a SiteOrigin Builder project', properties: ['openDirectory', 'openFile'], filters: [{ name: 'SiteOrigin project or ZIP file', extensions: ['json', 'zip'] }] };
const SAVE_ZIP = { title: 'Export website as a ZIP file', filters: [{ name: 'ZIP archive', extensions: ['zip'] }], properties: ['showOverwriteConfirmation'] };
const CODE = { type: 'warning', buttons: ['Cancel', 'Import code'], defaultId: 0, cancelId: 0, message: '“Hero” includes code' };

/** Stand-ins for Electron's dialog and shell that count every call, so a test can prove none reached them. */
function nativeStandIns() {
  const calls: string[] = [];
  const counted = (name: string) => () => {
    calls.push(name);
    throw new Error(`a native ${name} was reached`);
  };
  const dialogNames = ['showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync', 'showMessageBox', 'showMessageBoxSync', 'showErrorBox'] as const;
  const shellNames = ['openExternal', 'showItemInFolder', 'openPath'] as const;
  const dialog = Object.fromEntries(dialogNames.map((n) => [n, counted(n)])) as unknown as DialogLike;
  const shell = Object.fromEntries(shellNames.map((n) => [n, counted(n)])) as unknown as ShellLike;
  const originals = { dialog: { ...dialog }, shell: { ...shell } };
  return { dialog, shell, calls, originals };
}

/** Run with the global fixtures slot as it was restored afterwards. */
async function keepingGlobal(fn: () => Promise<void> | void) {
  const had = DESKTOP_FIXTURES in globalThis;
  const before = (globalThis as Record<symbol, unknown>)[DESKTOP_FIXTURES];
  try {
    await fn();
  } finally {
    if (had) (globalThis as Record<symbol, unknown>)[DESKTOP_FIXTURES] = before;
    else delete (globalThis as Record<symbol, unknown>)[DESKTOP_FIXTURES];
  }
}

describe('launch mode', () => {
  it('a normal launch is neither automated nor headless', () => {
    expect(launchMode({}, {})).toEqual({ automated: false, headless: false });
    expect(launchMode({ SITEORIGIN_HEADED: '1' }, {})).toEqual({ automated: false, headless: false });
    expect(launchMode({ SITEORIGIN_HEADLESS: '0' }, {})).toEqual({ automated: false, headless: false });
    expect(launchMode({ SITEORIGIN_HEADLESS: 'true' }, { __playwright_run: true })).toEqual({ automated: false, headless: false });
  });

  it('Playwright or SITEORIGIN_HEADLESS automate it, headless unless SITEORIGIN_HEADED shows the window', () => {
    const playwright = { __playwright_run: () => undefined };
    expect(launchMode({}, playwright)).toEqual({ automated: true, headless: true });
    expect(launchMode({ SITEORIGIN_HEADLESS: '1' }, {})).toEqual({ automated: true, headless: true });
    expect(launchMode({ SITEORIGIN_HEADED: '1' }, playwright)).toEqual({ automated: true, headless: false });
  });

  it('a normal launch installs nothing: Electron keeps its own dialog and shell, and there is nothing to reach', () =>
    keepingGlobal(() => {
      delete (globalThis as Record<symbol, unknown>)[DESKTOP_FIXTURES];
      const { dialog, shell, originals } = nativeStandIns();
      for (const [env, global] of [
        [{}, {}],
        [{ SITEORIGIN_HEADED: '1' }, {}],
        [{ SITEORIGIN_HEADLESS: '0' }, { __playwright_run: 'yes' }]
      ] as const) {
        expect(desktopForLaunch(env, global, { dialog, shell })).toBeNull();
        expect(dialog).toEqual(originals.dialog);
        expect(shell).toEqual(originals.shell);
        expect(DESKTOP_FIXTURES in globalThis).toBe(false);
      }
    }));

  it('an automated launch, headed for debugging too, installs them', () =>
    keepingGlobal(() => {
      const { dialog, shell, originals } = nativeStandIns();
      const d = desktopForLaunch({ SITEORIGIN_HEADED: '1' }, { __playwright_run: () => undefined }, { dialog, shell });
      expect(d).not.toBeNull();
      expect(dialog.showOpenDialog).not.toBe(originals.dialog.showOpenDialog);
      expect(shell.openExternal).not.toBe(originals.shell.openExternal);
      expect((globalThis as Record<symbol, unknown>)[DESKTOP_FIXTURES]).toBe(d!.fixtures);
    }));
});

describe('installing', () => {
  it('replaces every dialog and hand-off: answered or not, nothing reaches Electron’s own', () =>
    keepingGlobal(async () => {
      const { dialog, shell, calls } = nativeStandIns();
      const d = installHeadlessDesktop({ dialog, shell }, { kind: (p) => FILES[p] ?? null, real: (p) => p });
      d.windows.opened(1);
      const win = { id: 1 };
      expect(await dialog.showOpenDialog(win, FOLDER)).toEqual({ canceled: true, filePaths: [] });
      expect(dialog.showOpenDialogSync(win, FOLDER)).toBeUndefined();
      expect(await dialog.showSaveDialog(win, SAVE_ZIP)).toEqual({ canceled: true, filePath: '' });
      expect(dialog.showSaveDialogSync(win, SAVE_ZIP)).toBe('');
      expect(await dialog.showMessageBox(win, CODE)).toEqual({ response: 0, checkboxChecked: false });
      expect(dialog.showMessageBoxSync(win, { buttons: ['Keep', 'No'] })).toBe(1);
      dialog.showErrorBox('Broken', 'It broke');
      await shell.openExternal('https://siteorigin.com/');
      shell.showItemInFolder('/s/exports/site.zip');
      expect(await shell.openPath('/s/exports/site.zip')).toBe('');
      // Answered too: the answer comes from the fixtures, never from the system.
      d.fixtures.setAnswers([
        { dialog: 'open', paths: ['/s/workspace'] },
        { dialog: 'save', path: '/s/exports/new.zip' },
        { dialog: 'message', button: 'Import code' }
      ]);
      expect(await dialog.showOpenDialog(win, FOLDER)).toEqual({ canceled: false, filePaths: ['/s/workspace'] });
      expect(await dialog.showSaveDialog(win, SAVE_ZIP)).toEqual({ canceled: false, filePath: '/s/exports/new.zip' });
      expect(await dialog.showMessageBox(win, CODE)).toEqual({ response: 1, checkboxChecked: false });
      expect(calls).toEqual([]);
      const events = d.fixtures.events().entries;
      expect(events.map((e) => (e.type === 'chooser' ? `${e.dialog}${e.sync ? ' sync' : ''}: ${e.outcome}` : e.type === 'intent' ? `${e.kind} ${e.target}` : e.type))).toEqual([
        'open: unanswered',
        'open sync: unanswered',
        'save: unanswered',
        'save sync: unanswered',
        'message: unanswered',
        'message sync: unanswered',
        'error sync: closed',
        'open-external https://siteorigin.com/',
        'reveal /s/exports/site.zip',
        'open-path /s/exports/site.zip',
        'answers',
        'open: chosen',
        'save: chosen',
        'message: chosen'
      ]);
      // Methods stay writable, so a test may still stand in for one itself.
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['/x'] });
      expect(await dialog.showOpenDialog(FOLDER)).toEqual({ canceled: false, filePaths: ['/x'] });
    }));

  it('making fixtures alone touches nothing global', () => {
    const before = (globalThis as Record<symbol, unknown>)[DESKTOP_FIXTURES];
    createDesktopFixtures();
    expect((globalThis as Record<symbol, unknown>)[DESKTOP_FIXTURES]).toBe(before);
  });
});

describe('open choosers', () => {
  it('a chooser with no answer is closed without a choice, and says so', async () => {
    const { dialog, win, last } = setup();
    expect(await dialog.showOpenDialog(win, FOLDER)).toEqual({ canceled: true, filePaths: [] });
    expect(last()).toMatchObject({ dialog: 'open', window: 7, title: 'Choose a folder', selection: 'folder', outcome: 'unanswered', answer: null, result: { paths: [] } });
    expect(last().reason).toMatch(/No answer was set for this open chooser/);
  });

  it('answers in order, recording which answer and request answered which chooser', async () => {
    const { dialog, fixtures, win, choosers } = setup();
    const ids = fixtures.setAnswers([{ dialog: 'open', paths: ['/s/workspace'] }, { dialog: 'open', cancel: true }], { request: 'r9' });
    expect(new Set(ids).size).toBe(2);
    expect(await dialog.showOpenDialog(win, FOLDER)).toEqual({ canceled: false, filePaths: ['/s/workspace'] });
    expect(await dialog.showOpenDialog(win, FOLDER)).toEqual({ canceled: true, filePaths: [] });
    expect(choosers().map((c) => [c.outcome, c.answer, c.request])).toEqual([
      ['chosen', ids[0], 'r9'],
      ['cancelled', ids[1], 'r9']
    ]);
    expect(fixtures.events().pending).toEqual([]);
    // A later batch's answers have ids of their own.
    expect(ids).not.toContain(fixtures.setAnswers([{ dialog: 'open', cancel: true }])[0]);
  });

  it('takes several files where it allows them, and only types its filters offer, every one of them', async () => {
    const { dialog, fixtures, win, choosers } = setup();
    fixtures.setAnswers([
      { dialog: 'open', selection: 'files', paths: ['/s/imports/hero.jpg', '/s/imports/team.png'] },
      { dialog: 'open', paths: ['/s/imports/notes.txt'] },
      { dialog: 'open', paths: ['/s/imports/hero.jpg', '/s/imports/notes.txt'] }
    ]);
    expect(await dialog.showOpenDialog(win, IMAGES)).toEqual({ canceled: false, filePaths: ['/s/imports/hero.jpg', '/s/imports/team.png'] });
    expect(await dialog.showOpenDialog(win, IMAGES)).toEqual({ canceled: true, filePaths: [] });
    expect(await dialog.showOpenDialog(win, IMAGES)).toEqual({ canceled: true, filePaths: [] });
    expect(choosers().map((c) => c.outcome)).toEqual(['chosen', 'refused', 'refused']);
    expect(choosers()[1]).toMatchObject({ filters: [{ name: 'Images', extensions: ['jpg', 'png'] }] });
    for (const c of choosers().slice(1)) expect(c.reason).toMatch(/notes\.txt is not a type its filters offer/);
  });

  it('refuses, and uses up, an answer a real chooser could not give', async () => {
    const { dialog, fixtures, win, choosers } = setup();
    fixtures.setAnswers([
      { dialog: 'open', paths: ['/s/imports/hero.jpg', '/s/imports/team.png'] },
      { dialog: 'open', paths: ['/s/imports/hero.jpg'] },
      { dialog: 'open', paths: ['/s/nowhere'] },
      { dialog: 'open', paths: ['/s/workspace'] }
    ]);
    const single = { title: 'Locate the image', properties: ['openFile'] };
    for (const opts of [single, FOLDER, FOLDER, single]) expect(await dialog.showOpenDialog(win, opts)).toEqual({ canceled: true, filePaths: [] });
    expect(choosers().map((c) => c.outcome)).toEqual(['refused', 'refused', 'refused', 'refused']);
    expect(choosers().map((c) => c.reason?.replace(/^The answer could not be chosen here: /, '').replace(/\. It was closed.*$/, ''))).toEqual([
      'it takes one file, and 2 were given',
      '/s/imports/hero.jpg is a file, and it takes folders',
      '/s/nowhere does not exist',
      '/s/workspace is a folder, and it takes files'
    ]);
    expect(fixtures.events().pending).toEqual([]);
  });

  it('macOS’s Open Project takes a folder, its manifest or a ZIP file', async () => {
    const { dialog, fixtures, win, last } = setup();
    expect(selectionOf(OPEN_PROJECT_MAC.properties)).toBe('fileOrFolder');
    expect([selectionOf(undefined), selectionOf(['openFile']), selectionOf(['openFile', 'multiSelections']), selectionOf(['openDirectory'])]).toEqual(['file', 'file', 'files', 'folder']);
    fixtures.setAnswers([
      { dialog: 'open', selection: 'fileOrFolder', paths: ['/s/workspace/SiteOrigin/bakery'] },
      { dialog: 'open', paths: ['/s/workspace/SiteOrigin/bakery/siteorigin.project.json'] },
      { dialog: 'open', paths: ['/s/exports/site.zip'] }
    ]);
    for (const p of ['/s/workspace/SiteOrigin/bakery', '/s/workspace/SiteOrigin/bakery/siteorigin.project.json', '/s/exports/site.zip']) {
      expect(await dialog.showOpenDialog(win, OPEN_PROJECT_MAC)).toEqual({ canceled: false, filePaths: [p] });
      expect(last().outcome).toBe('chosen');
    }
  });

  it('a different chooser over the window closes, and withdraws what was left for it rather than keep it for later', async () => {
    const { dialog, fixtures, win, choosers, answerEvents } = setup();
    const ids = fixtures.setAnswers([
      { dialog: 'open', title: 'Choose where to save Bakery', selection: 'folder', paths: ['/s/workspace'] },
      { dialog: 'open', paths: ['/s/workspace'] }
    ]);
    // The second answer would fit this chooser: it is never reached, because answers are only used in order.
    expect(await dialog.showOpenDialog(win, FOLDER)).toEqual({ canceled: true, filePaths: [] });
    expect(choosers()[0]).toMatchObject({ outcome: 'mismatched', answer: ids[0] });
    expect(choosers()[0].reason).toMatch(/its title is "Choose a folder".*withdrawn/);
    expect(answerEvents('withdrawn')).toEqual([ids]);
    expect(fixtures.events().pending).toEqual([]);
    // The chooser it was meant for, coming later, is not answered with it.
    expect(await dialog.showOpenDialog(win, { ...FOLDER, title: 'Choose where to save Bakery' })).toEqual({ canceled: true, filePaths: [] });
    expect(choosers()[1].outcome).toBe('unanswered');
  });

  it('names how each chooser differs from the answer it met', async () => {
    const { dialog, fixtures, win, last } = setup();
    const cases: [unknown, () => Promise<unknown>, RegExp][] = [
      [{ dialog: 'open', paths: ['/s/workspace'] }, () => dialog.showMessageBox(win, CODE), /it is a message chooser/],
      [{ dialog: 'open', selection: 'folder', paths: ['/s/workspace'] }, () => dialog.showOpenDialog(win, IMAGES), /it takes files/],
      [{ dialog: 'message', message: 'Replace it?', button: 'Import code' }, () => dialog.showMessageBox(win, CODE), /its message is "“Hero” includes code"/]
    ];
    for (const [answer, shown, why] of cases) {
      fixtures.setAnswers([answer]);
      await shown();
      expect(last().outcome).toBe('mismatched');
      expect(last().reason).toMatch(why);
    }
  });
});

describe('the window an answer belongs to', () => {
  it('only a chooser over that window takes it; one over another window, or none, leaves it for its own', async () => {
    const { dialog, fixtures, windows, win, choosers } = setup();
    const [id] = fixtures.setAnswers([{ dialog: 'open', paths: ['/s/workspace'] }]);
    // A chooser over no window (an operation whose window has gone), and one over another window.
    expect(await dialog.showOpenDialog(FOLDER)).toEqual({ canceled: true, filePaths: [] });
    expect(dialog.showOpenDialogSync({ id: 9 }, FOLDER)).toBeUndefined();
    // Another window closing leaves it too.
    windows.gone(9, { closed: true });
    expect(choosers().map((c) => [c.outcome, c.answer, c.window])).toEqual([
      ['mismatched', id, null],
      ['mismatched', id, 9]
    ]);
    expect(choosers()[1].reason).toMatch(/is for window 7, and this chooser was shown over window 9.*kept for its own window/);
    expect(fixtures.events().pending.map((a) => a.id)).toEqual([id]);
    expect(dialog.showOpenDialogSync(win, FOLDER)).toEqual(['/s/workspace']);
  });

  it('what is left expires with the window, its page replaced or crashed; one set with no window belongs to the next', async () => {
    const { dialog, fixtures, windows, choosers, answerEvents } = setup();
    expect(fixtures.editor).toBe(7);
    const [a] = fixtures.setAnswers([{ dialog: 'open', paths: ['/s/workspace'] }]);
    windows.gone(7, { closed: true });
    expect(fixtures.editor).toBeNull();
    expect(fixtures.events().pending).toEqual([]);
    expect(fixtures.events().entries.at(-1)).toMatchObject({ type: 'answers', change: 'expired', answers: [a], window: 7 });
    // Set while there is no window: no chooser takes it until a window claims it, and then it works there.
    const [b] = fixtures.setAnswers([{ dialog: 'open', paths: ['/s/workspace'] }]);
    expect(fixtures.events().pending[0]).toMatchObject({ id: b, window: null });
    expect(await dialog.showOpenDialog(FOLDER)).toEqual({ canceled: true, filePaths: [] });
    windows.opened(8);
    expect(fixtures.editor).toBe(8);
    expect(fixtures.events().pending[0]).toMatchObject({ id: b, window: 8 });
    expect(await dialog.showOpenDialog({ id: 8 }, FOLDER)).toEqual({ canceled: false, filePaths: ['/s/workspace'] });
    // A new page replacing the editor (or a crash) ends its batch, and the window stays the editor: a batch set after
    // it belongs to the same window and works there.
    const [c] = fixtures.setAnswers([{ dialog: 'open', paths: ['/s/workspace'] }]);
    windows.gone(8, { closed: false });
    expect(fixtures.editor).toBe(8);
    expect(await dialog.showOpenDialog({ id: 8 }, FOLDER)).toEqual({ canceled: true, filePaths: [] });
    const [d] = fixtures.setAnswers([{ dialog: 'open', paths: ['/s/workspace'] }]);
    expect(await dialog.showOpenDialog({ id: 8 }, FOLDER)).toEqual({ canceled: false, filePaths: ['/s/workspace'] });
    expect(choosers().map((e) => [e.outcome, e.answer])).toEqual([
      ['mismatched', b],
      ['chosen', b],
      ['unanswered', null],
      ['chosen', d]
    ]);
    expect(answerEvents('expired')).toEqual([[a], [c]]);
  });
});

describe('save choosers', () => {
  it('saves to a new file in a folder that exists', async () => {
    const { dialog, fixtures, win, last } = setup();
    fixtures.setAnswers([{ dialog: 'save', path: '/s/exports/new.zip' }]);
    expect(await dialog.showSaveDialog(win, SAVE_ZIP)).toEqual({ canceled: false, filePath: '/s/exports/new.zip' });
    expect(last()).toMatchObject({ dialog: 'save', outcome: 'chosen', result: { path: '/s/exports/new.zip' } });
  });

  it('is cancelled when the answer says so', async () => {
    const { dialog, fixtures, win, last } = setup();
    const [id] = fixtures.setAnswers([{ dialog: 'save', cancel: true }]);
    expect(await dialog.showSaveDialog(win, SAVE_ZIP)).toEqual({ canceled: true, filePath: '' });
    expect(last()).toMatchObject({ outcome: 'cancelled', answer: id, result: { path: null } });
  });

  it('over a file that exists, the system’s Replace? question is answered as the answer says, and declined otherwise', async () => {
    const { dialog, fixtures, win, choosers } = setup();
    fixtures.setAnswers([
      { dialog: 'save', path: '/s/exports/site.zip' },
      { dialog: 'save', path: '/s/exports/site.zip', overwrite: 'decline' },
      { dialog: 'save', path: '/s/exports/site.zip', overwrite: 'replace' }
    ]);
    expect(await dialog.showSaveDialog(win, SAVE_ZIP)).toEqual({ canceled: true, filePath: '' });
    expect(await dialog.showSaveDialog(win, SAVE_ZIP)).toEqual({ canceled: true, filePath: '' });
    expect(await dialog.showSaveDialog(win, SAVE_ZIP)).toEqual({ canceled: false, filePath: '/s/exports/site.zip' });
    expect(choosers().map((c) => c.outcome)).toEqual(['cancelled', 'cancelled', 'chosen']);
    expect(choosers()[0].reason).toMatch(/already exists.*not answered, so declined/);
    expect(choosers()[1].reason).toMatch(/already exists.*was declined/);
  });

  it('refuses a folder, or a file in a folder that does not exist', async () => {
    const { dialog, fixtures, win, choosers } = setup();
    fixtures.setAnswers([
      { dialog: 'save', path: '/s/exports' },
      { dialog: 'save', path: '/s/missing/site.zip' }
    ]);
    expect(await dialog.showSaveDialog(win, SAVE_ZIP)).toEqual({ canceled: true, filePath: '' });
    expect(dialog.showSaveDialogSync(win, SAVE_ZIP)).toBe('');
    expect(choosers().map((c) => [c.outcome, c.reason?.match(/: (.*)\. It was/)?.[1]])).toEqual([
      ['refused', '/s/exports is a folder'],
      ['refused', '/s/missing is not a folder']
    ]);
  });
});

describe('the folders an answer was allowed in', () => {
  it('are checked again when the chooser shows: a path a link has since taken elsewhere is refused', async () => {
    // exports/moved now leads out of the session; exports/dangling leads nowhere.
    const real = (p: string) => (p.startsWith('/s/exports/moved') ? p.replace('/s/exports/moved', '/elsewhere') : p.startsWith('/s/exports/dangling') ? null : p);
    const { dialog, fixtures, win, choosers } = setup({ real });
    fixtures.setAnswers([
      { dialog: 'save', path: '/s/exports/moved/site.zip', within: ['/s/exports'] },
      { dialog: 'save', path: '/s/exports/dangling', within: ['/s/exports'] },
      { dialog: 'open', paths: ['/s/exports/site.zip'], within: ['/s/imports'] },
      { dialog: 'save', path: '/s/exports/new.zip', within: ['/s/exports'] }
    ]);
    expect(await dialog.showSaveDialog(win, SAVE_ZIP)).toEqual({ canceled: true, filePath: '' });
    expect(await dialog.showSaveDialog(win, SAVE_ZIP)).toEqual({ canceled: true, filePath: '' });
    expect(await dialog.showOpenDialog(win, OPEN_PROJECT_MAC)).toEqual({ canceled: true, filePaths: [] });
    expect(await dialog.showSaveDialog(win, SAVE_ZIP)).toEqual({ canceled: false, filePath: '/s/exports/new.zip' });
    expect(choosers().map((c) => [c.outcome, c.reason?.match(/here: (.*)\. It was/)?.[1] ?? null])).toEqual([
      ['refused', '/s/exports/moved/site.zip is no longer inside /s/exports'],
      ['refused', '/s/exports/dangling leads through a link to nowhere'],
      ['refused', '/s/exports/site.zip is no longer inside /s/imports'],
      ['chosen', null]
    ]);
  });
});

describe('message boxes', () => {
  it('presses the button named, and ticks its checkbox as asked', async () => {
    const { dialog, fixtures, win, last } = setup();
    fixtures.setAnswers([{ dialog: 'message', message: '“Hero” includes code', button: 'Import code', checkbox: true }]);
    expect(await dialog.showMessageBox(win, { ...CODE, checkboxLabel: 'Remember' })).toEqual({ response: 1, checkboxChecked: true });
    expect(last()).toMatchObject({ outcome: 'chosen', buttons: ['Cancel', 'Import code'], cancelId: 0, result: { button: 1, label: 'Import code', checkbox: true } });
  });

  it('presses whichever button is named, and can leave a ticked checkbox clear', async () => {
    const { dialog, fixtures, win } = setup();
    fixtures.setAnswers([{ dialog: 'message', button: 'Import code', checkbox: false }]);
    expect(await dialog.showMessageBox(win, { buttons: ['Import code', 'Cancel'], cancelId: 1, checkboxChecked: true, message: 'Sure?' })).toEqual({ response: 0, checkboxChecked: false });
  });

  it('is closed with Esc’s button when the answer cancels it', async () => {
    const { dialog, fixtures, win, last } = setup();
    const [id] = fixtures.setAnswers([{ dialog: 'message', cancel: true }]);
    expect(await dialog.showMessageBox(win, { buttons: ['Import code', 'Cancel'], cancelId: 1 })).toEqual({ response: 1, checkboxChecked: false });
    expect(last()).toMatchObject({ outcome: 'cancelled', answer: id, result: { button: 1, label: 'Cancel' } });
  });

  it('a button it does not have is refused, and Esc’s button pressed', async () => {
    const { dialog, fixtures, win, last } = setup();
    fixtures.setAnswers([{ dialog: 'message', button: 'Delete' }]);
    expect(await dialog.showMessageBox(win, { buttons: ['Keep', 'Discard', 'No'] })).toEqual({ response: 2, checkboxChecked: false });
    expect(last()).toMatchObject({ outcome: 'refused', cancelId: 2 });
    expect(last().reason).toMatch(/no "Delete" button \(there are "Keep", "Discard", "No"\)/);
  });

  it('Esc presses cancelId, else the first Cancel or No, else the first button (Electron’s rule)', () => {
    expect(cancelButton(['Wait', 'Leave Anyway'], 1)).toBe(1);
    expect(cancelButton(['Save', '&Cancel'], undefined)).toBe(1);
    expect(cancelButton(['Yes', 'no'], undefined)).toBe(1);
    expect(cancelButton(['Wait', 'Leave Anyway'], undefined)).toBe(0);
  });

  it('a message the app already took back uses no answer', async () => {
    const { dialog, fixtures, win, last } = setup();
    const signal = AbortSignal.abort();
    const [id] = fixtures.setAnswers([{ dialog: 'message', button: 'Leave Anyway' }]);
    expect(await dialog.showMessageBox(win, { buttons: ['Wait', 'Leave Anyway'], cancelId: 0, signal })).toEqual({ response: 0, checkboxChecked: false });
    expect(last()).toMatchObject({ outcome: 'cancelled', answer: null });
    expect(fixtures.events().pending.map((a) => a.id)).toEqual([id]);
  });
});

describe('the batch', () => {
  it('a new batch replaces what was left of the last, and an empty one clears it', () => {
    const { fixtures } = setup();
    const first = fixtures.setAnswers([{ dialog: 'open', cancel: true }], { request: 'r1' });
    const second = fixtures.setAnswers([{ dialog: 'save', cancel: true }], { request: 'r2' });
    expect(fixtures.events().pending.map((a) => [a.id, a.request, a.window])).toEqual([[second[0], 'r2', 7]]);
    expect(fixtures.setAnswers([])).toEqual([]);
    const sets = fixtures.events().entries.filter((e) => e.type === 'answers');
    expect(sets.map((e) => e.type === 'answers' && [e.answers, e.replaced])).toEqual([
      [first, []],
      [second, first],
      [[], second]
    ]);
  });

  it('a malformed answer changes nothing and says what is wrong', () => {
    const { fixtures } = setup();
    const ids = fixtures.setAnswers([{ dialog: 'open', cancel: true }, { dialog: 'save', cancel: true }]);
    expect(() => fixtures.setAnswers([{ dialog: 'open', cancel: true }, { dialog: 'open', path: '/s/x' }])).toThrow(/Answer 2: "path" answers a save chooser/);
    expect(fixtures.events().pending.map((a) => [a.id, a.dialog])).toEqual([
      [ids[0], 'open'],
      [ids[1], 'save']
    ]);
  });

  it('checks each answer’s shape', () => {
    const bad: [unknown, RegExp][] = [
      [null, /is an object/],
      [{ dialog: 'print', cancel: true }, /"dialog" is open, save or message/],
      [{ dialog: 'open' }, /exactly one of/],
      [{ dialog: 'open', cancel: true, paths: ['/a'] }, /exactly one of/],
      [{ dialog: 'open', cancel: false }, /"cancel" is true/],
      [{ dialog: 'open', paths: ['relative.png'] }, /absolute paths/],
      [{ dialog: 'open', paths: [] }, /non-empty list/],
      [{ dialog: 'save', path: '/a', overwrite: 'yes' }, /"overwrite" is replace or decline/],
      [{ dialog: 'save', cancel: true, overwrite: 'replace' }, /"overwrite" is replace or decline, beside a save chooser's "path"/],
      [{ dialog: 'message', cancel: true, checkbox: true }, /"checkbox" is true or false, beside a message chooser's "button"/],
      [{ dialog: 'save', selection: 'file', path: '/a' }, /"selection" is one of/],
      [{ dialog: 'message', button: 1 }, /label of a button/],
      [{ dialog: 'open', cancel: true, title: '' }, /"title" is the chooser's own title/],
      [{ dialog: 'open', cancel: true, within: ['relative'] }, /"within" is a non-empty list of absolute folders/],
      [{ dialog: 'open', cancel: true, when: 'later' }, /does not take "when"/]
    ];
    for (const [a, message] of bad) expect(() => checkAnswer(a)).toThrow(message);
    expect(checkAnswer({ dialog: 'save', title: 'Duplicate project', path: '/a/b', overwrite: 'replace', within: ['/a'] })).toEqual({ dialog: 'save', title: 'Duplicate project', path: '/a/b', overwrite: 'replace', within: ['/a'] });
  });
});

describe('the record', () => {
  it('menu choices go in order with everything else, and the record reads on from a cursor', async () => {
    const { dialog, fixtures, win } = setup();
    const menu = fixtures.noteMenu(['File', 'Open Project…'], 7, 'r3');
    await dialog.showOpenDialog(win, OPEN_PROJECT_MAC);
    const first = fixtures.events(0, 1);
    expect(first.entries.map((e) => e.type)).toEqual(['menu']);
    expect(first.entries[0]).toMatchObject({ seq: menu, path: ['File', 'Open Project…'], window: 7, request: 'r3' });
    const rest = fixtures.events(first.next);
    expect(rest.entries.map((e: DesktopEvent) => e.type)).toEqual(['chooser']);
    expect(fixtures.events(rest.next)).toMatchObject({ entries: [], next: rest.next });
    // A cursor ahead of what has happened is brought back to the last event, so nothing after it is missed.
    expect(fixtures.events(rest.next + 50).next).toBe(fixtures.seq);
  });

  it('is bounded: the oldest go, and it says how many', async () => {
    const { dialog, fixtures, win } = setup({ limit: 3 });
    for (let i = 0; i < 5; i++) await dialog.showOpenDialog(win, FOLDER);
    const ev = fixtures.events();
    expect(ev.entries.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(ev.dropped).toBe(2);
  });
});
