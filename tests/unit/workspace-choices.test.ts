import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApplyResult } from '@shared/ops';
import type { LocalWorkspaceState, ProjectSnapshot, RunStatus } from '@shared/api';

// The editor's viewing choices and its Save, through the editor's own store behind a stand-in for the preload
// bridge (#202): every way of choosing a width or zoom is remembered for the project, and Save only says the
// changes are saved once the project's queued writes have reached the disk.
const saved: Array<{ state: LocalWorkspaceState; key: string }> = [];
let flushes: Array<{ opening: string | undefined; resolve: (saved: boolean) => void }> = [];
let undos: Array<(r: ApplyResult) => void> = [];
let undoFails: Array<(e: Error) => void> = [];
const held = () => new Promise<ApplyResult>((resolve, reject) => (undos.push(resolve), undoFails.push(reject)));
/** Each Undo and Redo the editor sent the project, in order, and each time it asked for the whole project again. */
const sent: string[] = [];
const holdFlush = (opening: string | undefined) => new Promise<boolean>((resolve) => flushes.push({ opening, resolve }));
const bridge = {
  project: {
    saveLocalState: async (state: LocalWorkspaceState, key: string) => void saved.push({ state, key }),
    flush: holdFlush as (opening: string | undefined) => Promise<boolean>,
    undo: () => (sent.push('undo'), held()),
    redo: () => (sent.push('redo'), held()),
    undoEntry: held,
    resync: async () => {
      sent.push('resync');
      // The first ask fails (the project was busy sending): asking again is not held up by it.
      if (sent.filter((x) => x === 'resync').length === 1) throw new Error('The editor could not be sent the project.');
      return true;
    }
  },
  platform: 'darwin'
};
vi.stubGlobal('window', { builder: bridge });
vi.stubGlobal('document', { activeElement: null, getElementById: () => null });
vi.stubGlobal('HTMLElement', class {});

// The store and the save are DOM code, outside this test project's types: loaded by a path the type checker does
// not follow, with just the shapes this test uses.
interface EditorState {
  snapshot: ProjectSnapshot | null;
  viewport: number;
  zoom: number | 'fit';
  runStatus: RunStatus | null;
  runMode: 'edit' | 'ask' | null;
  leaving: boolean;
  drafting: number;
  toasts: Array<{ text: string; kind: string; action?: { run: () => void } }>;
}
const load = (path: string) => import(/* @vite-ignore */ path);
const store = (await load('../../src/renderer/src/store')) as {
  getState: () => EditorState;
  setState: (p: Partial<EditorState>) => void;
  setViewport: (w: number) => void;
  setZoom: (z: number | 'fit') => void;
  projectHistory: (action: 'undo' | 'redo') => void;
  undoAction: (r: { entryId?: string; revision: number; workspaceKey: string }) => { run: () => void } | undefined;
};
const { saveNow } = (await load('../../src/renderer/src/lib/leave')) as { saveNow: () => Promise<void> };
const pending = (await load('../../src/renderer/src/lib/pending')) as { trackApply: (p: Promise<{ ok: boolean }>) => void; isSettling: () => boolean; resetPendingForTests: () => void };

const open = (workspaceKey: string) => store.setState({ snapshot: { workspaceKey } as unknown as ProjectSnapshot, toasts: [], runStatus: null, runMode: null, leaving: false, drafting: 0 });
const tick = () => new Promise<void>((r) => setTimeout(r, 30));
const SAVED = 'All changes are saved on this computer.';
const notices = () => store.getState().toasts.map((t) => t.text);

afterEach(async () => {
  // An Undo or Redo a test left on its way, answered or not, never holds back the next test's.
  for (const settle of undos) settle({ ok: false, revision: 0, error: { code: 'INVALID_ARGUMENT', message: 'Nothing to undo.', recoverable: true } });
  store.setState({ snapshot: null });
  await tick();
  saved.length = 0;
  sent.length = 0;
  flushes = [];
  undos = [];
  undoFails = [];
  bridge.project.flush = holdFlush;
  pending.resetPendingForTests();
});

describe('viewing choices', () => {
  it('remembers a width and a zoom for the project they were chosen in', () => {
    open('opening#a');
    store.setViewport(2400);
    expect(store.getState().viewport).toBe(2400);
    store.setViewport(390);
    expect(store.getState().viewport).toBe(390);
    store.setZoom(0.75);
    expect(store.getState().zoom).toBe(0.75);
    open('opening#b');
    store.setZoom('fit');
    expect(store.getState().zoom).toBe('fit');
    expect(saved).toEqual([
      { state: { viewport: 2400 }, key: 'opening#a' },
      { state: { viewport: 390 }, key: 'opening#a' },
      { state: { zoom: 0.75 }, key: 'opening#a' },
      { state: { zoom: 'fit' }, key: 'opening#b' }
    ]);
  });
});

describe('Save', () => {
  it('says the changes are saved only once the project’s queued writes have reached the disk', async () => {
    open('opening#a');
    const done = saveNow();
    await tick();
    expect(flushes.map((f) => f.opening)).toEqual(['opening#a']);
    expect(notices()).toEqual([]);
    // The editor shows the project again (a change landing), in the same opening.
    store.setState({ snapshot: { workspaceKey: 'opening#a' } as unknown as ProjectSnapshot });
    flushes[0].resolve(true);
    await done;
    expect(notices()).toEqual([SAVED]);
    expect(pending.isSettling()).toBe(false);
  });

  it('waits for an Undo started before it, and says nothing when the Undo failed', async () => {
    open('opening#a');
    store.projectHistory('undo');
    const done = saveNow();
    await tick();
    expect(flushes).toEqual([]);
    undos[0]({ ok: false, revision: 3, error: { code: 'CONFLICT', message: 'The disk is full.', recoverable: false } });
    await tick();
    flushes[0].resolve(true);
    await done;
    expect(notices()).toEqual(['The disk is full.']);
  });

  it('waits for a notification’s Undo, and a Redo with nothing left to redo is no failure', async () => {
    open('opening#a');
    store.undoAction({ entryId: 'h_delete', revision: 4, workspaceKey: 'opening#a' })!.run();
    store.projectHistory('redo');
    const done = saveNow();
    await tick();
    expect(flushes).toEqual([]);
    undos[0]({ ok: true, revision: 5 });
    undos[1]({ ok: false, revision: 5, error: { code: 'INVALID_ARGUMENT', message: 'Nothing to redo.', recoverable: true } });
    await tick();
    flushes[0].resolve(true);
    await done;
    expect(notices()).toEqual(['Nothing to redo.', SAVED]);
  });

  it('says an Undo that could not be sent failed, and does not confirm', async () => {
    open('opening#a');
    store.projectHistory('undo');
    const done = saveNow();
    await tick();
    undoFails[0](new Error("Error invoking remote method 'project:undo': Error: ENOSPC: no space left on device"));
    await tick();
    flushes[0]?.resolve(true);
    await done;
    expect(notices()).toEqual(['ENOSPC: no space left on device']);
  });

  it('says nothing when a change started while it waited is still on its way, or is being typed', async () => {
    open('opening#a');
    const typing = saveNow();
    await tick();
    store.setState({ drafting: 1 });
    flushes[0].resolve(true);
    await typing;
    expect(notices()).toEqual([]);
    store.setState({ drafting: 0 });

    open('opening#a');
    const done = saveNow();
    await tick();
    pending.trackApply(new Promise(() => undefined));
    flushes[1].resolve(true);
    await done;
    expect(notices()).toEqual([]);
  });

  it('says nothing about a project that was replaced while it waited', async () => {
    open('opening#a');
    const done = saveNow();
    await tick();
    open('opening#b');
    flushes[0].resolve(true);
    await done;
    expect(notices()).toEqual([]);
    // Or closed altogether.
    open('opening#a');
    const closed = saveNow();
    await tick();
    store.setState({ snapshot: null });
    flushes[1].resolve(true);
    await closed;
    expect(notices()).toEqual([]);
  });

  it('says nothing while the AI is still making changes, which Stop would take back, or the project is being left', async () => {
    for (const busy of [{ runStatus: 'awaiting-input', runMode: 'edit' }, { runStatus: 'running', runMode: 'edit' }, { leaving: true }] as const) {
      open('opening#a');
      flushes = [];
      store.setState(busy);
      const done = saveNow();
      await tick();
      flushes[0].resolve(true);
      await done;
      expect(notices()).toEqual([]);
    }
  });

  it('says nothing when the queued writes did not all reach the disk, or could not be asked about', async () => {
    open('opening#a');
    const done = saveNow();
    await tick();
    flushes[0].resolve(false);
    await done;
    expect(notices()).toEqual([]);
    expect(pending.isSettling()).toBe(false);

    bridge.project.flush = () => Promise.reject(new Error('The project was closed.'));
    await saveNow();
    expect(notices()).toEqual([]);
    expect(pending.isSettling()).toBe(false);
  });
});

// Loading the editor's actions hands the store the way to open a page, as the editor does.
await load('../../src/renderer/src/lib/actions');

describe('an Undo or Redo of a change on another page (#903)', () => {
  const CONTACT_DOC = 'siteorigin/pages/contact.json';
  const pages = (contact: string | null) => ({ home: { id: 'home', title: 'Home', rootIds: [], nodes: {} }, ...(contact ? { contact: { id: 'contact', title: contact, rootIds: [], nodes: {} } } : {}) });
  const show = (workspaceKey: string, revision: number, contact: string | null = 'Contact') =>
    store.setState({ snapshot: { workspaceKey, revision, state: { pages: pages(contact) } } as unknown as ProjectSnapshot } as Partial<EditorState>);
  const at = (place: Record<string, unknown>) => store.setState({ pageId: 'home', definitionMode: null, templateMode: null, leftTab: 'pages', postView: 'write', mode: 'edit', post: null, modal: null, ...place } as Partial<EditorState>);
  const view = () => store.getState() as unknown as { pageId: string | null; modal: { kind: string } | null; toasts: Array<{ text: string; action?: { label: string; run: () => void } }> };
  const landed = async (r: ApplyResult, next: () => void) => {
    undos.at(-1)!(r);
    await tick();
    next();
    await tick();
  };

  it('says what it undid and where while Home is shown, and Show Contact opens that page', async () => {
    open('opening#a');
    show('opening#a', 4);
    at({ modal: { kind: 'history' } });
    store.projectHistory('undo');
    await landed({ ok: true, revision: 5, changed: [CONTACT_DOC], label: 'Duplicate Split hero on Contact' }, () => show('opening#a', 5));
    // The label already says where: it is not said twice. Home stays shown until the author asks.
    expect(notices()).toEqual(['Undid “Duplicate Split hero on Contact”.']);
    expect(view().pageId).toBe('home');
    const action = view().toasts[0].action!;
    expect(action.label).toBe('Show Contact');
    action.run();
    expect(view().pageId).toBe('contact');
    // History was in front of the page, so it is put away for the page to show.
    expect(view().modal).toBeNull();
  });

  it('names the page a label does not, for a Redo too, and says nothing when the change is on the page shown', async () => {
    open('opening#a');
    show('opening#a', 4);
    at({});
    store.projectHistory('redo');
    await landed({ ok: true, revision: 5, changed: [CONTACT_DOC, 'siteorigin/site.json'], label: 'Change link to Contact' }, () => show('opening#a', 5));
    expect(notices()).toEqual(['Redid “Change link to Contact” on Contact.']);

    // A step that changed Home as well as Contact may look no different on Home: Contact is still named.
    open('opening#a');
    show('opening#a', 4);
    at({});
    store.projectHistory('undo');
    await landed({ ok: true, revision: 5, changed: ['siteorigin/pages/home.json', CONTACT_DOC], label: 'Delete page Contact' }, () => show('opening#a', 5));
    expect(notices()).toEqual(['Undid “Delete page Contact” on Contact.']);

    open('opening#a');
    show('opening#a', 5);
    at({ pageId: 'contact' });
    store.projectHistory('undo');
    await landed({ ok: true, revision: 6, changed: [CONTACT_DOC], label: 'Duplicate Split hero on Contact' }, () => show('opening#a', 6));
    expect(notices()).toEqual([]);
  });

  it('speaks up when Contact is open but a component, a layout or a post is in front of it', async () => {
    for (const place of [{ definitionMode: { definitionId: 'card' } }, { templateMode: { collectionId: 'posts' } }, { leftTab: 'posts', post: { collectionId: 'posts', entryId: 'p1' } }, { leftTab: 'seo' }]) {
      open('opening#a');
      show('opening#a', 4);
      at({ pageId: 'contact', ...place });
      store.projectHistory('undo');
      await landed({ ok: true, revision: 5, changed: [CONTACT_DOC], label: 'Duplicate Split hero on Contact' }, () => show('opening#a', 5));
      expect(notices()).toEqual(['Undid “Duplicate Split hero on Contact”.']);
    }
  });

  it('names a page the step removed without offering it, and says nothing about a step that changed no page', async () => {
    open('opening#a');
    show('opening#a', 4);
    at({});
    store.projectHistory('undo');
    await landed({ ok: true, revision: 5, changed: [CONTACT_DOC, 'siteorigin/site.json'], label: 'Add page' }, () => show('opening#a', 5, null));
    expect(notices()).toEqual(['Undid “Add page” on Contact.']);
    expect(view().toasts[0].action).toBeUndefined();

    open('opening#a');
    show('opening#a', 5);
    at({});
    store.projectHistory('undo');
    await landed({ ok: true, revision: 6, changed: ['siteorigin/site.json'], label: 'Change site name' }, () => show('opening#a', 6));
    expect(notices()).toEqual([]);
  });

  it('says where a notification’s Undo undid its change, by History’s name for it, once another page is shown', async () => {
    open('opening#a');
    store.setState({ snapshot: { workspaceKey: 'opening#a', revision: 4, state: { pages: pages('Contact') }, history: { entries: [{ id: 'h_delete', label: 'Delete Gallery on Contact' }] } } as unknown as ProjectSnapshot });
    at({});
    store.undoAction({ entryId: 'h_delete', revision: 4, workspaceKey: 'opening#a' })!.run();
    await landed({ ok: true, revision: 5, changed: [CONTACT_DOC] }, () => show('opening#a', 5));
    expect(notices()).toEqual(['Undid “Delete Gallery on Contact”.']);
  });

  it('says nothing about a step the editor has not shown in time, judged on a project that has not heard of it', async () => {
    vi.useFakeTimers();
    try {
      open('opening#a');
      show('opening#a', 4);
      at({});
      store.projectHistory('undo');
      undos.at(-1)!({ ok: true, revision: 5, changed: [CONTACT_DOC], label: 'Duplicate Split hero on Contact' });
      await vi.advanceTimersByTimeAsync(3100);
      expect(notices()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says nothing once another project is open, and withdraws Show for a page gone since', async () => {
    open('opening#a');
    show('opening#a', 4);
    at({});
    store.projectHistory('undo');
    await landed({ ok: true, revision: 5, changed: [CONTACT_DOC], label: 'Duplicate Split hero on Contact' }, () => show('opening#b', 9));
    expect(notices()).toEqual([]);

    open('opening#a');
    show('opening#a', 5);
    at({});
    store.projectHistory('undo');
    await landed({ ok: true, revision: 6, changed: [CONTACT_DOC], label: 'Duplicate Split hero on Contact' }, () => show('opening#a', 6));
    show('opening#a', 7, null);
    view().toasts[0].action!.run();
    expect(view().pageId).toBe('home');
  });
});

describe('Undo or Redo held down (#1452)', () => {
  const show = (workspaceKey: string, revision: number) => store.setState({ snapshot: { workspaceKey, revision } as unknown as ProjectSnapshot });
  /** The project at `revision`, with History's entries h0, h1, … applied or not. */
  const showHistory = (revision: number, applied: boolean[]) =>
    store.setState({ snapshot: { workspaceKey: 'opening#a', revision, history: { entries: applied.map((a, i) => ({ id: `h${i}`, applied: a })) } } as unknown as ProjectSnapshot });
  const lands = async (r: ApplyResult = { ok: true, revision: 5 }) => {
    undos.at(-1)!(r);
    await tick();
  };
  const nothingLeft = { ok: false, revision: 9, error: { code: 'INVALID_ARGUMENT', message: 'Nothing to undo.', recoverable: true } } satisfies ApplyResult;

  it.each(['undo', 'redo'] as const)('sends one %s at a time, and drops every press made while it is on its way until the editor shows it', async (action) => {
    const other = action === 'undo' ? 'redo' : 'undo';
    open('opening#a');
    show('opening#a', 4);
    // A second of key repeat while each step takes longer than a press, and the other way too.
    store.projectHistory(action);
    for (let i = 0; i < 28; i++) store.projectHistory(action);
    store.projectHistory(other);
    expect(sent).toEqual([action]);
    // Saved, but not shown yet: the editor still shows what came before it.
    await lands({ ok: true, revision: 5 });
    store.projectHistory(action);
    expect(sent).toEqual([action]);
    show('opening#a', 5);
    await tick();
    // What was pressed meanwhile was dropped, never kept for later: the key was let go, and nothing more is sent.
    expect(sent).toEqual([action]);
    store.projectHistory(action);
    expect(sent).toEqual([action, action]);
    // The project the editor shows next is already past the step.
    await lands({ ok: true, revision: 6 });
    show('opening#a', 8);
    await tick();
    store.projectHistory(other);
    expect(sent).toEqual([action, action, other]);
    await lands(nothingLeft);
  });

  it('lets the next press go once the editor shows the step, though the rest of its save has not answered yet', async () => {
    open('opening#a');
    showHistory(4, [true, true]);
    store.projectHistory('undo');
    store.projectHistory('redo');
    expect(sent).toEqual(['undo']);
    // The project announces a step as soon as its journal is on disk, before it replies: h1 is taken back.
    showHistory(5, [true, false]);
    await tick();
    store.projectHistory('redo');
    expect(sent).toEqual(['undo', 'redo']);
    // The Undo's reply, coming late, does not let a press go past the Redo still on its way, nor the project handed
    // to the editor again as it was (a resync, say).
    undos[0]({ ok: true, revision: 5 });
    showHistory(5, [true, false]);
    await tick();
    store.projectHistory('undo');
    expect(sent).toEqual(['undo', 'redo']);
    showHistory(6, [true, true]);
    await tick();
    store.projectHistory('undo');
    expect(sent).toEqual(['undo', 'redo', 'undo']);
    undos[1]({ ok: true, revision: 6 });
    await lands(nothingLeft);
  });

  it('does not take another change shown meanwhile for the step', async () => {
    open('opening#a');
    showHistory(4, [true, true]);
    store.projectHistory('undo');
    // An edit saved ahead of the Undo shows first, as a step of its own; then the Undo takes that edit back, not h1.
    showHistory(5, [true, true, true]);
    await tick();
    store.projectHistory('undo');
    showHistory(6, [true, true, false]);
    await tick();
    store.projectHistory('undo');
    expect(sent).toEqual(['undo']);
    // Its reply names the revision it was saved at, which the editor shows already.
    await lands({ ok: true, revision: 6 });
    store.projectHistory('undo');
    expect(sent).toEqual(['undo', 'undo']);
    await lands(nothingLeft);
  });

  it('lets the next press through at once after a step that was refused or could not be sent', async () => {
    open('opening#a');
    show('opening#a', 4);
    store.projectHistory('undo');
    // Refused at a revision the editor has not shown: there is nothing of it to wait for.
    await lands(nothingLeft);
    store.projectHistory('undo');
    expect(sent).toEqual(['undo', 'undo']);
    undoFails.at(-1)!(new Error("Error invoking remote method 'project:undo': Error: The project was closed."));
    await tick();
    store.projectHistory('redo');
    expect(sent).toEqual(['undo', 'undo', 'redo']);
    await lands({ ok: false, revision: 9, error: { code: 'CONFLICT', message: 'Cannot redo “Edit 2” because site.json has changed since.', recoverable: false } });
    store.projectHistory('redo');
    expect(sent).toEqual(['undo', 'undo', 'redo', 'redo']);
    await lands(nothingLeft);
  });

  it('stops holding Undo back once the project the step was for is no longer shown', async () => {
    open('opening#a');
    show('opening#a', 4);
    store.projectHistory('undo');
    await lands({ ok: true, revision: 5 });
    show('opening#b', 1);
    await tick();
    store.projectHistory('undo');
    expect(sent).toEqual(['undo', 'undo']);
    await lands({ ok: true, revision: 2 });
    // Closed altogether.
    store.setState({ snapshot: null });
    await tick();
    open('opening#b');
    store.projectHistory('undo');
    expect(sent).toEqual(['undo', 'undo', 'undo']);
    await lands(nothingLeft);
  });

  it('asks for the whole project again while the editor has not shown the step, and lets nothing go until it does', async () => {
    vi.useFakeTimers();
    try {
      open('opening#a');
      show('opening#a', 4);
      store.projectHistory('undo');
      undos.at(-1)!({ ok: true, revision: 5 });
      await vi.advanceTimersByTimeAsync(2900);
      expect(sent).toEqual(['undo']);
      // The first ask fails; the next is made all the same.
      await vi.advanceTimersByTimeAsync(200);
      expect(sent).toEqual(['undo', 'resync']);
      store.projectHistory('undo');
      await vi.advanceTimersByTimeAsync(3000);
      expect(sent).toEqual(['undo', 'resync', 'resync']);
      show('opening#a', 5);
      await vi.advanceTimersByTimeAsync(6100);
      // Shown: it asks no more, and the next press goes.
      expect(sent).toEqual(['undo', 'resync', 'resync']);
      store.projectHistory('undo');
      expect(sent).toEqual(['undo', 'resync', 'resync', 'undo']);
      undos.at(-1)!(nothingLeft);
      await vi.advanceTimersByTimeAsync(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets Save finish once the step is saved, while the next press still waits for the editor to show it', async () => {
    open('opening#a');
    show('opening#a', 4);
    store.projectHistory('undo');
    const done = saveNow();
    await tick();
    expect(flushes).toEqual([]);
    await lands({ ok: true, revision: 5 });
    expect(flushes.map((f) => f.opening)).toEqual(['opening#a']);
    flushes[0].resolve(true);
    await done;
    expect(notices()).toEqual([SAVED]);
    store.projectHistory('undo');
    expect(sent).toEqual(['undo']);
    show('opening#a', 5);
    await tick();
    store.projectHistory('undo');
    expect(sent).toEqual(['undo', 'undo']);
    await lands(nothingLeft);
  });
});
