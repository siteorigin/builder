/**
 * The app's own saves are not read back as changes made outside it (issue 963). The watch that follows the project's
 * documents names the files it saw change; when each holds exactly what the app last wrote there, the change was the
 * app's own save and nothing is read. Anything else (a file edited in another program, one the app does not keep, a
 * folder gone, a held conflict's file) still reads the whole project, as before, and becomes an undoable step.
 *
 * The controller's watches here are told what changed by the test, as the system tells them, file by file: the
 * system's own pace (a moment to many seconds on a busy Mac) is no part of what is tested.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ userData: '' }));
/** The open watches, by the folder each watches: what they are told, and the watch itself (to fail it). */
type FakeWatch = { tell: (event: string, file: string | null) => void; watch: import('node:events').EventEmitter };
const watches = vi.hoisted(() => new Map<string, FakeWatch>());
/** Folders (by the end of their path) whose watch cannot be made. */
const unwatchable = vi.hoisted(() => new Set<string>());
vi.mock('../../src/main/folder-watch', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    watchTree: (dir: string, tell: (event: string, file: string | null) => void) => {
      if ([...unwatchable].some((end) => dir.endsWith(end))) throw new Error('EMFILE: too many open files, watch');
      const watch = Object.assign(new EventEmitter(), { close: () => watches.get(dir)?.watch === watch && watches.delete(dir) });
      watches.set(dir, { tell, watch });
      return watch;
    }
  };
});
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: {},
  utilityProcess: {}
}));

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { toJson } = await import('../../src/main/project/fsutil');
const { createStarterState } = await import('@catalogue/starters');

type Session = InstanceType<typeof ProjectSession>;
const SITE = 'siteorigin/site.json';
const dirs: string[] = [];
const sessions: Session[] = [];
const controllers: InstanceType<typeof Controller>[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-own-saves-${name}-`)));
  dirs.push(d);
  return d;
};

beforeEach(() => {
  env.userData = temp('userdata');
});
afterEach(async () => {
  vi.restoreAllMocks();
  unwatchable.clear();
  for (const c of controllers.splice(0)) await c.close();
  for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function make() {
  const dir = join(temp('project'), 'site');
  const s = await ProjectSession.create(dir, createStarterState('business', 'Own Saves', false));
  sessions.push(s);
  return { dir, s, home: s.state.site.homePageId };
}
const read = (dir: string, rel: string) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));
/** Saved in place, as an editor saves a file. */
const write = (dir: string, rel: string, v: unknown) => writeFileSync(join(dir, rel), toJson(v));
const page = (id: string) => `siteorigin/pages/${id}.json`;
/** Each time the session reads the whole project back from disk. */
const fullReads = (s: Session) => vi.spyOn(s as unknown as { readBack(): Promise<{ ok: boolean }> }, 'readBack');

describe('a change the watch reports', () => {
  it('reads nothing back when every file it names holds what the app saved there, a removed one included', async () => {
    const { s, home } = await make();
    const about = s.state.site.pageOrder.find((id) => id !== home)!;
    expect((await s.apply({ operations: [{ type: 'page.update', pageId: home, description: 'Typed in the app' }] }, { label: 'Describe' })).ok).toBe(true);
    expect((await s.apply({ operations: [{ type: 'page.remove', pageId: about, replacementPageId: home }] }, { label: 'Remove' })).ok).toBe(true);
    const full = fullReads(s);
    const revision = s.revision;
    expect(await s.reloadChanged([page(home), page(about), SITE])).toEqual({ ok: true });
    expect(full).not.toHaveBeenCalled();
    expect(s.revision).toBe(revision);
  });

  it('reads the whole project for a file changed outside the app, and takes it as a step Undo takes back', async () => {
    const { dir, s, home } = await make();
    expect((await s.apply({ operations: [{ type: 'page.update', pageId: home, description: 'Typed in the app' }] }, { label: 'Describe' })).ok).toBe(true);
    // Saved elsewhere at the same moment as the app's own save of the home page: both are named, one is not the app's.
    const site = read(dir, SITE);
    site.description = 'Written in another editor';
    write(dir, SITE, site);
    const full = fullReads(s);
    const revision = s.revision;
    expect(await s.reloadChanged([page(home), SITE])).toEqual({ ok: true });
    expect(full).toHaveBeenCalledTimes(1);
    expect(s.revision).toBe(revision + 1);
    expect(s.state.site.description).toBe('Written in another editor');
    expect(s.state.pages[home].seo?.description).toBe('Typed in the app');
    expect(s.historyInfo().undoLabel).toBe('External change');
    // Once taken, the same file holds what the app has: telling of it again reads nothing.
    expect(await s.reloadChanged([SITE])).toEqual({ ok: true });
    expect(full).toHaveBeenCalledTimes(1);
  });

  it('reads the whole project for a file it does not keep, a folder, and a folder gone with documents in it', async () => {
    const { dir, s } = await make();
    const full = fullReads(s);
    // A page added outside the app (not a valid one: the reload refuses it, but it is looked at).
    writeFileSync(join(dir, page('pg_added')), '{}');
    await s.reloadChanged([page('pg_added')]);
    expect(full).toHaveBeenCalledTimes(1);
    rmSync(join(dir, page('pg_added')));
    // A folder, whatever happened in it.
    await s.reloadChanged(['siteorigin/pages']);
    expect(full).toHaveBeenCalledTimes(2);
    // A folder moved away with the pages in it: the folder alone may be all that is told.
    renameSync(join(dir, 'siteorigin', 'pages'), join(dir, 'pages-away'));
    await s.reloadChanged(['siteorigin/pages']);
    expect(full).toHaveBeenCalledTimes(3);
    renameSync(join(dir, 'pages-away'), join(dir, 'siteorigin', 'pages'));
    // A path that does not name a file in the project at all.
    await s.reloadChanged(['../elsewhere.json']);
    expect(full).toHaveBeenCalledTimes(4);
  });

  it('concludes nothing while an AI run holds the project, even of a file that holds what the app wrote', async () => {
    const { s, home } = await make();
    await s.beginRun('run_a');
    expect(await s.reloadChanged([page(home)])).toEqual({ ok: false, message: 'Busy' });
  });

  it('looks at the project’s manifest too, which no watch covers, as a full read would', async () => {
    const { dir, s, home } = await make();
    const manifest = read(dir, 'siteorigin.project.json');
    // The same manifest in another layout says nothing new.
    writeFileSync(join(dir, 'siteorigin.project.json'), JSON.stringify(manifest));
    const full = fullReads(s);
    expect(await s.reloadChanged([page(home)])).toEqual({ ok: true });
    expect(full).not.toHaveBeenCalled();
    manifest.name = 'Renamed in another editor';
    write(dir, 'siteorigin.project.json', manifest);
    expect(await s.reloadChanged([page(home)])).toEqual({ ok: true });
    expect(full).toHaveBeenCalledTimes(1);
    expect(s.state.manifest.name).toBe('Renamed in another editor');
  });

  it('reads the whole project for a held conflict’s file, so putting it back settles the conflict', async () => {
    const { dir, s } = await make();
    const original = readFileSync(join(dir, SITE), 'utf8');
    await s.beginRun('run_a');
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'AI name' }] }, { label: 'AI', source: 'ai', runId: 'run_a', history: false })).ok).toBe(true);
    const site = read(dir, SITE);
    site.description = 'Edited in another editor';
    write(dir, SITE, site);
    expect((await s.abortRun()).conflict).toBe(SITE);
    expect(s.conflicts.map((c) => c.path)).toEqual([SITE]);
    // While it is held, even a file that holds what the app wrote is read with everything else.
    const held = fullReads(s);
    await s.reloadChanged([page(s.state.site.homePageId)]);
    expect(held).toHaveBeenCalledTimes(1);
    held.mockRestore();
    // Put back as SiteOrigin Builder had it: the file now holds what the app has for it, and that settles the conflict.
    writeFileSync(join(dir, SITE), original);
    const full = fullReads(s);
    expect((await s.reloadChanged([SITE])).ok).toBe(true);
    expect(full).toHaveBeenCalledTimes(1);
    expect(s.conflicts).toEqual([]);
  });
});

type Attaching = { attach(s: unknown, workspace: object, runtime: object): Promise<void> };

/** A project open for editing in a controller, its watches running (no preview). */
async function openInController() {
  const dir = join(temp('project'), 'site');
  await (await ProjectSession.create(dir, createStarterState('business', 'Own Saves', false))).close();
  const session = await ProjectSession.open(dir, 'this-window');
  const c = new Controller(() => null);
  c.send = () => undefined;
  controllers.push(c);
  await (c as unknown as Attaching).attach(session, {}, { state: 'error', message: 'No preview in this test.' });
  /** The open watch of `rel` (project-relative). */
  const watchOf = (rel: string) => watches.get(join(dir, rel));
  /** The system telling the watches that each of `files` (project-relative, with /) changed, by its own name for it. */
  const tell = (...files: string[]) => {
    for (const f of files) {
      const root = [...watches.keys()].filter((w) => f.startsWith(`${relative(dir, w).split(sep).join('/')}/`)).sort((x, y) => y.length - x.length)[0];
      expect(root, `no watch covers ${f}`).toBeDefined();
      watches.get(root)!.tell('rename', relative(root, join(dir, f)));
    }
  };
  return { dir, c, session, tell, watchOf, home: session.state.site.homePageId };
}

/** What the system tells of one of the app's saves of `doc`: its temporary file, the document, the generated manifest. */
const saveOf = (doc: string) => [`${doc.slice(0, doc.lastIndexOf('/'))}/.0123456789ab.tmp`, doc, doc, 'siteorigin/.ba9876543210.tmp', 'siteorigin/generated-manifest.json'];

describe('the file watch of an open project', () => {
  it('does not read the project back after the app’s own save, and still takes a file saved outside the app', async () => {
    const { dir, c, session, tell, home } = await openInController();
    const looked = vi.spyOn(session, 'reloadChanged');
    const full = fullReads(session);
    expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, description: 'Typed in the app' }] })).ok).toBe(true);
    tell(...saveOf(page(home)));
    await vi.waitFor(() => expect(looked).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 20 });
    expect([...looked.mock.calls[0][0]]).toEqual([page(home)]);
    expect(await looked.mock.results[0].value).toEqual({ ok: true });
    expect(full).not.toHaveBeenCalled();
    const revision = session.revision;
    const site = read(dir, SITE);
    site.description = 'Written in another editor';
    write(dir, SITE, site);
    tell(SITE);
    // Taken once it is a revision of its own.
    await vi.waitFor(() => expect(session.revision).toBe(revision + 1), { timeout: 5000, interval: 20 });
    expect(session.state.site.description).toBe('Written in another editor');
    expect(full).toHaveBeenCalledTimes(1);
    expect(session.historyInfo().undoLabel).toBe('External change');
    // Undo takes back the change made outside the app, and only that.
    expect((await session.undo()).ok).toBe(true);
    expect(session.state.site.description).not.toBe('Written in another editor');
    expect(session.state.pages[home].seo?.description).toBe('Typed in the app');
  });

  it('takes a file saved outside the app as the app saves another, and one saved over the app’s own save', async () => {
    const { dir, c, session, tell, home } = await openInController();
    const site = read(dir, SITE);
    site.description = 'Written in another editor';
    const saving = c.apply({ operations: [{ type: 'page.update', pageId: home, description: 'Typed in the app' }] });
    write(dir, SITE, site);
    expect((await saving).ok).toBe(true);
    // The system tells of both in one go, the outside save first or last.
    const revision = session.revision;
    tell(SITE, ...saveOf(page(home)));
    await vi.waitFor(() => expect(session.revision).toBe(revision + 1), { timeout: 5000, interval: 20 });
    expect(session.state.site.description).toBe('Written in another editor');
    expect(session.state.pages[home].seo?.description).toBe('Typed in the app');
    // The other way round: the app's save told first, the outside save last.
    const tokens = read(dir, 'siteorigin/tokens.json');
    tokens.overrides['color.brand'] = '#123456';
    const savingAgain = c.apply({ operations: [{ type: 'page.update', pageId: home, description: 'Typed between' }] });
    write(dir, 'siteorigin/tokens.json', tokens);
    expect((await savingAgain).ok).toBe(true);
    tell(...saveOf(page(home)), 'siteorigin/tokens.json');
    await vi.waitFor(() => expect(session.revision).toBe(revision + 3), { timeout: 5000, interval: 20 });
    expect(session.state.tokens.overrides['color.brand']).toBe('#123456');
    // The page the app just saved, saved again in another editor before the system told of the app's save.
    expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, description: 'Typed again' }] })).ok).toBe(true);
    const doc = read(dir, page(home));
    doc.title = 'Retitled in another editor';
    write(dir, page(home), doc);
    tell(...saveOf(page(home)));
    await vi.waitFor(() => expect(session.revision).toBe(revision + 5), { timeout: 5000, interval: 20 });
    expect(session.state.pages[home].title).toBe('Retitled in another editor');
    expect(session.state.pages[home].seo?.description).toBe('Typed again');
    expect(session.historyInfo().undoLabel).toBe('External change');
  });

  it('reads the whole project at the next change after a look that was refused, whatever that change is', async () => {
    const { dir, c, session, tell, home } = await openInController();
    const looked = vi.spyOn(session, 'reloadChanged');
    const whole = vi.spyOn(session, 'reloadFromDisk');
    const full = fullReads(session);
    // An AI run holds the project: the look the outside change sets off is turned away.
    await session.beginRun('run_a');
    const site = read(dir, SITE);
    site.description = 'Written during the run';
    write(dir, SITE, site);
    tell(SITE);
    await vi.waitFor(() => expect(looked).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 20 });
    expect(await looked.mock.results[0].value).toEqual({ ok: false, message: 'Busy' });
    await session.abortRun();
    expect(session.state.site.description).not.toBe('Written during the run');
    // The next change is the app's own save, but the look it sets off reads everything, and finds the one missed.
    expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, description: 'Typed in the app' }] })).ok).toBe(true);
    const revision = session.revision;
    tell(...saveOf(page(home)));
    await vi.waitFor(() => expect(session.revision).toBe(revision + 1), { timeout: 5000, interval: 20 });
    expect(session.state.site.description).toBe('Written during the run');
    expect(whole).toHaveBeenCalledTimes(1);
    // Once that look has found everything, the app's own saves are its own again.
    expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, description: 'Typed again' }] })).ok).toBe(true);
    tell(...saveOf(page(home)));
    await vi.waitFor(() => expect(looked).toHaveBeenCalledTimes(2), { timeout: 5000, interval: 20 });
    expect(await looked.mock.results[1].value).toEqual({ ok: true });
    expect(whole).toHaveBeenCalledTimes(1);
    // The refused look, and the one owed after it.
    expect(full).toHaveBeenCalledTimes(2);
  });

  it('decides each look once the one before has finished, so one that fails is owed in full by the next', async () => {
    const { dir, c, session, tell, home } = await openInController();
    const whole = vi.spyOn(session, 'reloadFromDisk');
    // The first look (of a change made outside the app) is slow to be let in, and then turned away.
    let refuse!: () => void;
    const looked = vi.spyOn(session, 'reloadChanged').mockImplementationOnce(() => new Promise((resolve) => (refuse = () => resolve({ ok: false, message: 'The project lock could not be checked.' }))));
    const site = read(dir, SITE);
    site.description = 'Written in another editor';
    write(dir, SITE, site);
    tell(SITE);
    await vi.waitFor(() => expect(looked).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 20 });
    // Meanwhile the app saves a page, and the watch goes off for that too.
    expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, description: 'Typed in the app' }] })).ok).toBe(true);
    tell(...saveOf(page(home)));
    // Past its 400 ms of quiet, the second look waits for the first: nothing is decided while that is still out.
    await new Promise((r) => setTimeout(r, 1000));
    expect(looked).toHaveBeenCalledTimes(1);
    expect(whole).not.toHaveBeenCalled();
    const revision = session.revision;
    refuse();
    // The second look comes after the first was refused: it reads everything, and finds the outside change.
    await vi.waitFor(() => expect(session.revision).toBe(revision + 1), { timeout: 5000, interval: 20 });
    expect(session.state.site.description).toBe('Written in another editor');
    expect(whole).toHaveBeenCalledTimes(1);
    expect(looked).toHaveBeenCalledTimes(1);
  });

  it('owes a full look after a change told without its name, and every look once a watch has ended', async () => {
    const { dir, c, session, tell, watchOf, home } = await openInController();
    const whole = vi.spyOn(session, 'reloadFromDisk');
    const save = async (description: string) => {
      expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, description }] })).ok).toBe(true);
      tell(...saveOf(page(home)));
    };
    // Something in siteorigin/ changed, the system cannot say what.
    const site = read(dir, SITE);
    site.description = 'Written in another editor';
    write(dir, SITE, site);
    watchOf('siteorigin')!.tell('change', null);
    await vi.waitFor(() => expect(session.state.site.description).toBe('Written in another editor'), { timeout: 5000, interval: 20 });
    expect(whole).toHaveBeenCalledTimes(1);
    // Once looked at in full, the app's own saves are its own again.
    const looked = vi.spyOn(session, 'reloadChanged');
    await save('One');
    await vi.waitFor(() => expect(looked).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 20 });
    expect(await looked.mock.results[0].value).toEqual({ ok: true });
    expect(whole).toHaveBeenCalledTimes(1);
    // The watch of src/lib/siteorigin fails: what it would have told of from now on is not known. It is looked at in
    // full at once, and at every look after, whatever is named.
    watchOf('src/lib/siteorigin')!.watch.emit('error', new Error('EMFILE: too many open files'));
    await vi.waitFor(() => expect(whole).toHaveBeenCalledTimes(2), { timeout: 5000, interval: 20 });
    await save('Two');
    await vi.waitFor(() => expect(whole).toHaveBeenCalledTimes(3), { timeout: 5000, interval: 20 });
    await save('Three');
    await vi.waitFor(() => expect(whole).toHaveBeenCalledTimes(4), { timeout: 5000, interval: 20 });
    expect(looked).toHaveBeenCalledTimes(1);
  });

  it('reads the whole project at every look once a watch has told of its own folder going', async () => {
    const { c, session, tell, watchOf, home } = await openInController();
    const looked = vi.spyOn(session, 'reloadChanged');
    const whole = vi.spyOn(session, 'reloadFromDisk');
    // As Windows tells of the watched folder itself going, under an empty name, and ends the watch.
    watchOf('src/lib/siteorigin')!.tell('rename', '');
    await vi.waitFor(() => expect(whole).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 20 });
    expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, description: 'Typed in the app' }] })).ok).toBe(true);
    tell(...saveOf(page(home)));
    await vi.waitFor(() => expect(whole).toHaveBeenCalledTimes(2), { timeout: 5000, interval: 20 });
    expect(looked).not.toHaveBeenCalled();
  });

  it('reads the whole project at every look when a folder could not be watched', async () => {
    unwatchable.add(join('src', 'lib', 'siteorigin'));
    const { c, session, tell, home } = await openInController();
    const looked = vi.spyOn(session, 'reloadChanged');
    const whole = vi.spyOn(session, 'reloadFromDisk');
    expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, description: 'Typed in the app' }] })).ok).toBe(true);
    tell(...saveOf(page(home)));
    await vi.waitFor(() => expect(whole).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 20 });
    expect(looked).not.toHaveBeenCalled();
  });

  it('never runs a look that watches since replaced had queued', async () => {
    const { c, session, tell, home } = await openInController();
    const whole = vi.spyOn(session, 'reloadFromDisk');
    // The first look is slow to be let in; the next is queued behind it.
    let release!: () => void;
    const looked = vi.spyOn(session, 'reloadChanged').mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ ok: true }))));
    expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, description: 'One' }] })).ok).toBe(true);
    tell(...saveOf(page(home)));
    await vi.waitFor(() => expect(looked).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 20 });
    expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, description: 'Two' }] })).ok).toBe(true);
    tell(...saveOf(page(home)));
    await new Promise((r) => setTimeout(r, 1000));
    // A close begins and fails: the watches are made again, and what the old ones queued is theirs no more.
    c.onSessionClosing = async () => {
      throw new Error('The workspace could not be saved.');
    };
    await c.close().catch(() => undefined);
    c.onSessionClosing = null;
    release();
    await new Promise((r) => setTimeout(r, 500));
    expect(looked).toHaveBeenCalledTimes(1);
    expect(whole).not.toHaveBeenCalled();
  });

  it('owes a full look from watches put back after a close that failed', async () => {
    const { dir, c, session, tell, home } = await openInController();
    const whole = vi.spyOn(session, 'reloadFromDisk');
    // Told of a change made outside the app, then a close begins before the look, and fails.
    const site = read(dir, SITE);
    site.description = 'Written in another editor';
    write(dir, SITE, site);
    tell(SITE);
    c.onSessionClosing = async () => {
      throw new Error('The workspace could not be saved.');
    };
    await c.close().catch(() => undefined);
    c.onSessionClosing = null;
    expect(c.session).toBe(session);
    // The next change the watches are told of is the app's own save, and its look reads everything.
    expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, description: 'Typed in the app' }] })).ok).toBe(true);
    tell(...saveOf(page(home)));
    await vi.waitFor(() => expect(session.state.site.description).toBe('Written in another editor'), { timeout: 5000, interval: 20 });
    expect(whole).toHaveBeenCalledTimes(1);
  });

  it('takes an authored component’s source the app saved as its own, under the watch of src/lib/siteorigin', async () => {
    const { session, tell } = await openInController();
    const looked = vi.spyOn(session, 'reloadChanged');
    const full = fullReads(session);
    // A source the app has (as it would after saving a code component) is named by the second watch.
    const source = 'src/lib/siteorigin/custom/Owned.svelte';
    (session as unknown as { docs: Map<string, string> }).docs.set(source, '<p>Owned</p>\n');
    mkdirSync(join(session.dir, 'src/lib/siteorigin/custom'), { recursive: true });
    writeFileSync(join(session.dir, source), '<p>Owned</p>\n');
    tell(source);
    await vi.waitFor(() => expect(looked).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 20 });
    expect([...looked.mock.calls[0][0]]).toEqual([source]);
    expect(await looked.mock.results[0].value).toEqual({ ok: true });
    expect(full).not.toHaveBeenCalled();
  });
});

describe('an outside edit that breaks a code component (#1533)', () => {
  /** A project in a controller with code components named `names`, each in its own file, and what it sends the editor. */
  async function withCode(...names: string[]) {
    const open = await openInController();
    const sent: string[] = [];
    open.c.send = (channel: string) => void sent.push(channel);
    const ids: Record<string, { id: string; path: string; source: string }> = {};
    for (const name of names) {
      const source = `<p>${name}</p>\n`;
      // Made as the editor makes it in Developer mode.
      expect(await open.session.apply({ operations: [{ type: 'component.createCode', name, source }] }, { label: `Create ${name}`, codeAllowed: true })).toMatchObject({ ok: true });
      const def = Object.values(open.session.state.components).find((d) => d.name === name)!;
      ids[name] = { id: def.id, path: def.sourcePath!, source };
    }
    const refusals = () => (open.c.snapshot()?.diagnostics ?? []).filter((d) => d.code === 'EXTERNAL_SOURCE_REFUSED');
    return { ...open, sent, ids, refusals };
  }
  const broken = '<div>\n  <p>Hello</p>\n  {broken\n</div>\n';

  it('tells the editor the file was refused, with its line, and clears it once the file is put back', async () => {
    const { dir, session, tell, sent, ids, refusals } = await withCode('Greeting');
    const { id, path, source } = ids.Greeting;
    const revision = session.revision;
    const undo = session.historyInfo().undoLabel;
    sent.length = 0;
    writeFileSync(join(dir, path), broken);
    tell(path);
    await vi.waitFor(() => expect(refusals()).toHaveLength(1), { timeout: 5000, interval: 20 });
    const [refusal] = refusals();
    expect(refusal.owner).toEqual({ kind: 'component', id });
    expect(refusal.severity).toBe('error');
    expect(refusal.message).toMatch(new RegExp(`^The edited code for "Greeting" has problems, so it was not loaded \\(${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, line \\d+\\): .+`));
    // Sent to the editor at once, though the project did not change.
    expect(sent).toContain('project:changed');
    expect(session.revision).toBe(revision);
    expect(session.state.components[id].source).toBe(source);
    expect(session.historyInfo().undoLabel).toBe(undo);
    expect(readFileSync(join(dir, path), 'utf8')).toBe(broken);
    // The file put back as it was loads nothing new, and the refusal goes.
    sent.length = 0;
    writeFileSync(join(dir, path), source);
    tell(path);
    await vi.waitFor(() => expect(refusals()).toEqual([]), { timeout: 5000, interval: 20 });
    expect(sent).toContain('project:changed');
    expect(session.revision).toBe(revision);
  });

  it('names every refused component, and loads the batch once each is put right', async () => {
    const { dir, session, tell, ids, refusals, home } = await withCode('First', 'Second');
    writeFileSync(join(dir, ids.First.path), broken);
    writeFileSync(join(dir, ids.Second.path), broken);
    const doc = read(dir, page(home));
    doc.title = 'Retitled in another editor';
    write(dir, page(home), doc);
    tell(ids.First.path, ids.Second.path, page(home));
    await vi.waitFor(() => expect(refusals().map((d) => d.owner?.id).sort()).toEqual([ids.First.id, ids.Second.id].sort()), { timeout: 5000, interval: 20 });
    expect(session.state.pages[home].title).not.toBe('Retitled in another editor');
    // First is fixed: only Second is refused now, and nothing loads yet.
    writeFileSync(join(dir, ids.First.path), '<p>First, fixed</p>\n');
    tell(ids.First.path);
    await vi.waitFor(() => expect(refusals().map((d) => d.owner?.id)).toEqual([ids.Second.id]), { timeout: 5000, interval: 20 });
    expect(session.state.components[ids.First.id].source).toBe(ids.First.source);
    // Second is fixed too: the whole batch loads as one outside change, and nothing is refused.
    writeFileSync(join(dir, ids.Second.path), '<p>Second, fixed</p>\n');
    tell(ids.Second.path);
    await vi.waitFor(() => expect(session.historyInfo().undoLabel).toBe('External change'), { timeout: 5000, interval: 20 });
    expect(session.state.components[ids.Second.id].source).toBe('<p>Second, fixed</p>\n');
    expect(session.state.components[ids.First.id].source).toBe('<p>First, fixed</p>\n');
    expect(session.state.pages[home].title).toBe('Retitled in another editor');
    expect(refusals()).toEqual([]);
  });
});
