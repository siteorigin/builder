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
/** Each Undo and Redo the editor sent the project, in order. */
const sent: string[] = [];
const holdFlush = (opening: string | undefined) => new Promise<boolean>((resolve) => flushes.push({ opening, resolve }));
const bridge = {
  project: {
    saveLocalState: async (state: LocalWorkspaceState, key: string) => void saved.push({ state, key }),
    flush: holdFlush as (opening: string | undefined) => Promise<boolean>,
    undo: () => (sent.push('undo'), held()),
    redo: () => (sent.push('redo'), held()),
    undoEntry: held
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

afterEach(() => {
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
  const lands = async (r: ApplyResult = { ok: true, revision: 5 }) => {
    undos.at(-1)!(r);
    await tick();
  };

  it('sends one step at a time, and the presses made while it is on its way make one more step, not a backlog', async () => {
    open('opening#a');
    // A second of key repeat while each step takes longer than a press.
    for (let i = 0; i < 28; i++) store.projectHistory('undo');
    expect(sent).toEqual(['undo']);
    await lands();
    expect(sent).toEqual(['undo', 'undo']);
    await lands();
    // The key was let go: nothing more is undone.
    expect(sent).toEqual(['undo', 'undo']);
    // The next press goes at once.
    store.projectHistory('undo');
    expect(sent).toEqual(['undo', 'undo', 'undo']);
    await lands();
    expect(sent).toEqual(['undo', 'undo', 'undo']);
  });

  it('holds Redo back the same way, and an Undo and a Redo pressed while a step is on its way cancel out', async () => {
    open('opening#a');
    for (let i = 0; i < 40; i++) store.projectHistory('redo');
    expect(sent).toEqual(['redo']);
    await lands();
    expect(sent).toEqual(['redo', 'redo']);
    await lands();
    expect(sent).toEqual(['redo', 'redo']);

    // Undo, then Undo and Redo while it is on its way: one step back in all.
    store.projectHistory('undo');
    store.projectHistory('undo');
    store.projectHistory('redo');
    await lands();
    expect(sent).toEqual(['redo', 'redo', 'undo']);

    // Undo, then Redo while it is on its way: the Redo follows it.
    store.projectHistory('undo');
    store.projectHistory('redo');
    await lands();
    expect(sent).toEqual(['redo', 'redo', 'undo', 'undo', 'redo']);
    await lands();
    expect(sent).toEqual(['redo', 'redo', 'undo', 'undo', 'redo']);
  });

  it('lets the next press through after a step that was refused or could not be sent', async () => {
    open('opening#a');
    store.projectHistory('undo');
    await lands({ ok: false, revision: 5, error: { code: 'INVALID_ARGUMENT', message: 'Nothing to undo.', recoverable: true } });
    store.projectHistory('undo');
    expect(sent).toEqual(['undo', 'undo']);
    undoFails.at(-1)!(new Error("Error invoking remote method 'project:undo': Error: The project was closed."));
    await tick();
    store.projectHistory('redo');
    expect(sent).toEqual(['undo', 'undo', 'redo']);
    await lands();
  });

  it('never takes a step held back for one project in another, or once the project is being left', async () => {
    open('opening#a');
    store.projectHistory('undo');
    store.projectHistory('undo');
    open('opening#b');
    await lands();
    expect(sent).toEqual(['undo']);

    store.projectHistory('undo');
    store.projectHistory('undo');
    store.setState({ leaving: true });
    await lands();
    expect(sent).toEqual(['undo', 'undo']);
  });
});
