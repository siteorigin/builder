// Native choosers and desktop hand-offs in automated runs (src/main/headless-desktop.ts, #494): every chooser is
// answered from the batch a test set, in order, or closed with a recorded, explained outcome; links, reveals and opened
// paths are recorded instead of done; and nothing reaches Electron's own dialog or shell.
import { describe, expect, it } from 'vitest';
import { DESKTOP_FIXTURES, cancelButton, checkAnswer, createDesktopFixtures, installHeadlessDesktop, launchMode, selectionOf } from '../../src/main/headless-desktop';
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

function setup(limit?: number) {
  let t = 0;
  const d = createDesktopFixtures({ kind: (p) => FILES[p] ?? null, now: () => `t${++t}`, limit });
  const win = { id: 7 };
  d.windows.opened(7);
  const choosers = () => d.fixtures.events().entries.filter((e): e is ChooserEvent => e.type === 'chooser');
  const last = () => choosers().at(-1)!;
  return { d, win, ...d, choosers, last };
}

const FOLDER = { title: 'Choose a folder', properties: ['openDirectory', 'createDirectory'] };
const IMAGES = { title: 'Import images', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['jpg', 'png'] }] };
const OPEN_PROJECT_MAC = { title: 'Open a SiteOrigin Builder project', properties: ['openDirectory', 'openFile'], filters: [{ name: 'SiteOrigin project or ZIP file', extensions: ['json', 'zip'] }] };
const SAVE_ZIP = { title: 'Export website as a ZIP file', filters: [{ name: 'ZIP archive', extensions: ['zip'] }], properties: ['showOverwriteConfirmation'] };
const CODE = { type: 'warning', buttons: ['Cancel', 'Import code'], defaultId: 0, cancelId: 0, message: '“Hero” includes code' };

describe('launch mode', () => {
  it('a normal launch is neither automated nor headless', () => {
    expect(launchMode({}, {})).toEqual({ automated: false, headless: false });
    expect(launchMode({ SITEORIGIN_HEADED: '1' }, {})).toEqual({ automated: false, headless: false });
  });

  it('Playwright or SITEORIGIN_HEADLESS automate it, headless unless SITEORIGIN_HEADED shows the window', () => {
    const playwright = { __playwright_run: () => undefined };
    expect(launchMode({}, playwright)).toEqual({ automated: true, headless: true });
    expect(launchMode({ SITEORIGIN_HEADLESS: '1' }, {})).toEqual({ automated: true, headless: true });
    expect(launchMode({ SITEORIGIN_HEADED: '1' }, playwright)).toEqual({ automated: true, headless: false });
  });
});

describe('installing', () => {
  it('replaces every dialog and hand-off, so nothing reaches Electron’s own, and publishes the fixtures', async () => {
    const boom = () => {
      throw new Error('a native dialog or hand-off was reached');
    };
    const dialog = { showOpenDialog: boom, showOpenDialogSync: boom, showSaveDialog: boom, showSaveDialogSync: boom, showMessageBox: boom, showMessageBoxSync: boom, showErrorBox: boom } as unknown as DialogLike;
    const shell = { openExternal: boom, showItemInFolder: boom, openPath: boom } as unknown as ShellLike;
    const before = (globalThis as Record<symbol, unknown>)[DESKTOP_FIXTURES];
    try {
      const d = installHeadlessDesktop({ dialog, shell }, { kind: () => null });
      expect((globalThis as Record<symbol, unknown>)[DESKTOP_FIXTURES]).toBe(d.fixtures);
      expect(await dialog.showOpenDialog({ id: 1 }, FOLDER)).toEqual({ canceled: true, filePaths: [] });
      expect(dialog.showOpenDialogSync(FOLDER)).toBeUndefined();
      expect(await dialog.showSaveDialog(SAVE_ZIP)).toEqual({ canceled: true, filePath: '' });
      expect(dialog.showSaveDialogSync(SAVE_ZIP)).toBe('');
      expect(await dialog.showMessageBox(CODE)).toEqual({ response: 0, checkboxChecked: false });
      expect(dialog.showMessageBoxSync({ buttons: ['Keep', 'No'] })).toBe(1);
      dialog.showErrorBox('Broken', 'It broke');
      await shell.openExternal('https://siteorigin.com/');
      shell.showItemInFolder('/s/exports/site.zip');
      expect(await shell.openPath('/s/exports/site.zip')).toBe('');
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
        'open-path /s/exports/site.zip'
      ]);
      // Methods stay writable, so a test may still stand in for one itself.
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['/x'] });
      expect(await dialog.showOpenDialog(FOLDER)).toEqual({ canceled: false, filePaths: ['/x'] });
    } finally {
      (globalThis as Record<symbol, unknown>)[DESKTOP_FIXTURES] = before;
    }
  });

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
    expect(await dialog.showOpenDialog(win, FOLDER)).toEqual({ canceled: false, filePaths: ['/s/workspace'] });
    expect(await dialog.showOpenDialog(win, FOLDER)).toEqual({ canceled: true, filePaths: [] });
    expect(choosers().map((c) => [c.outcome, c.answer, c.request])).toEqual([
      ['chosen', ids[0], 'r9'],
      ['cancelled', ids[1], 'r9']
    ]);
    expect(fixtures.events().pending).toEqual([]);
  });

  it('takes several files where it allows them, and only types its filters offer', async () => {
    const { dialog, fixtures, win, last } = setup();
    fixtures.setAnswers([
      { dialog: 'open', selection: 'files', paths: ['/s/imports/hero.jpg', '/s/imports/team.png'] },
      { dialog: 'open', paths: ['/s/imports/notes.txt'] }
    ]);
    expect(await dialog.showOpenDialog(win, IMAGES)).toEqual({ canceled: false, filePaths: ['/s/imports/hero.jpg', '/s/imports/team.png'] });
    expect(await dialog.showOpenDialog(win, IMAGES)).toEqual({ canceled: true, filePaths: [] });
    expect(last()).toMatchObject({ outcome: 'refused', filters: [{ name: 'Images', extensions: ['jpg', 'png'] }] });
    expect(last().reason).toMatch(/notes\.txt is not a type its filters offer/);
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

  it('an answer meant for another chooser is kept for it, and the chooser before it is closed', async () => {
    const { dialog, fixtures, win, choosers } = setup();
    const [id] = fixtures.setAnswers([{ dialog: 'open', title: 'Choose where to save Bakery', selection: 'folder', paths: ['/s/workspace'] }]);
    expect(await dialog.showMessageBox(win, CODE)).toEqual({ response: 0, checkboxChecked: false });
    expect(await dialog.showOpenDialog(win, IMAGES)).toEqual({ canceled: true, filePaths: [] });
    expect(await dialog.showOpenDialog(win, FOLDER)).toEqual({ canceled: true, filePaths: [] });
    expect(choosers().map((c) => [c.outcome, c.answer])).toEqual([
      ['mismatched', id],
      ['mismatched', id],
      ['mismatched', id]
    ]);
    expect(choosers()[0].reason).toMatch(/it is a message chooser/);
    expect(choosers()[1].reason).toMatch(/its title is "Import images", it takes files/);
    expect(choosers()[2].reason).toMatch(/its title is "Choose a folder"/);
    expect(fixtures.events().pending.map((a) => a.id)).toEqual([id]);
    expect(await dialog.showOpenDialog(win, { ...FOLDER, title: 'Choose where to save Bakery' })).toEqual({ canceled: false, filePaths: ['/s/workspace'] });
  });

  it('answers either of Electron’s argument forms, and a synchronous chooser', async () => {
    const { dialog, fixtures, choosers } = setup();
    fixtures.setAnswers([
      { dialog: 'open', paths: ['/s/workspace'] },
      { dialog: 'open', paths: ['/s/workspace'] }
    ]);
    expect(await dialog.showOpenDialog(FOLDER)).toEqual({ canceled: false, filePaths: ['/s/workspace'] });
    expect(dialog.showOpenDialogSync(null, FOLDER)).toEqual(['/s/workspace']);
    expect(choosers().map((c) => [c.window, c.sync])).toEqual([
      [null, false],
      [null, true]
    ]);
  });
});

describe('save choosers', () => {
  it('saves to a new file in a folder that exists', async () => {
    const { dialog, fixtures, win, last } = setup();
    fixtures.setAnswers([{ dialog: 'save', path: '/s/exports/new.zip' }]);
    expect(await dialog.showSaveDialog(win, SAVE_ZIP)).toEqual({ canceled: false, filePath: '/s/exports/new.zip' });
    expect(last()).toMatchObject({ dialog: 'save', outcome: 'chosen', result: { path: '/s/exports/new.zip' } });
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
    expect(choosers()[1].reason).toMatch(/already exists.*declined/);
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

describe('message boxes', () => {
  it('presses the button named, and ticks its checkbox as asked', async () => {
    const { dialog, fixtures, win, last } = setup();
    fixtures.setAnswers([{ dialog: 'message', message: '“Hero” includes code', button: 'Import code', checkbox: true }]);
    expect(await dialog.showMessageBox(win, { ...CODE, checkboxLabel: 'Remember' })).toEqual({ response: 1, checkboxChecked: true });
    expect(last()).toMatchObject({ outcome: 'chosen', buttons: ['Cancel', 'Import code'], cancelId: 0, result: { button: 1, label: 'Import code', checkbox: true } });
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
    const ids = fixtures.setAnswers([{ dialog: 'open', cancel: true }]);
    expect(() => fixtures.setAnswers([{ dialog: 'open', cancel: true }, { dialog: 'open', path: '/s/x' }])).toThrow(/Answer 2: "path" answers a save chooser/);
    expect(fixtures.events().pending.map((a) => a.id)).toEqual(ids);
  });

  it('what is left expires with the window it was set for; one set with no window belongs to the next', async () => {
    const { dialog, fixtures, windows, win, choosers } = setup();
    const [a] = fixtures.setAnswers([{ dialog: 'open', paths: ['/s/workspace'] }]);
    windows.gone(7, { closed: true });
    expect(fixtures.events().pending).toEqual([]);
    expect(fixtures.events().entries.at(-1)).toMatchObject({ type: 'answers', change: 'expired', answers: [a], window: 7 });
    // Set while there is no window: it waits for the next one, and works there.
    const [b] = fixtures.setAnswers([{ dialog: 'open', paths: ['/s/workspace'] }]);
    expect(fixtures.events().pending[0]).toMatchObject({ id: b, window: null });
    windows.opened(8);
    expect(fixtures.events().pending[0]).toMatchObject({ id: b, window: 8 });
    expect(await dialog.showOpenDialog({ id: 8 }, FOLDER)).toEqual({ canceled: false, filePaths: ['/s/workspace'] });
    // A new page replacing the editor ends its batch too.
    const [c] = fixtures.setAnswers([{ dialog: 'open', paths: ['/s/workspace'] }]);
    windows.gone(8, { closed: false });
    expect(await dialog.showOpenDialog({ id: 8 }, FOLDER)).toEqual({ canceled: true, filePaths: [] });
    expect(choosers().map((e) => e.outcome)).toEqual(['chosen', 'unanswered']);
    expect(fixtures.events().entries.filter((e) => e.type === 'answers' && e.change === 'expired').map((e) => e.type === 'answers' && e.answers)).toEqual([[a], [c]]);
    void win;
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
      [{ dialog: 'save', selection: 'file', path: '/a' }, /"selection" is one of/],
      [{ dialog: 'message', button: 1 }, /label of a button/],
      [{ dialog: 'open', cancel: true, title: '' }, /"title" is the chooser's own title/],
      [{ dialog: 'open', cancel: true, when: 'later' }, /does not take "when"/]
    ];
    for (const [a, message] of bad) expect(() => checkAnswer(a)).toThrow(message);
    expect(checkAnswer({ dialog: 'save', title: 'Duplicate project', path: '/a/b', overwrite: 'replace' })).toEqual({ dialog: 'save', title: 'Duplicate project', path: '/a/b', overwrite: 'replace' });
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
    const { dialog, fixtures, win } = setup(3);
    for (let i = 0; i < 5; i++) await dialog.showOpenDialog(win, FOLDER);
    const ev = fixtures.events();
    expect(ev.entries.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(ev.dropped).toBe(2);
  });
});
