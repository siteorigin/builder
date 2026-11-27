/**
 * A closed project is let go of (#1039): once the controller has closed it, nothing the controller keeps reaches the
 * project's session, its documents or the copy a live session's guests were given, while the controller itself lives
 * on (the app's does, for the next project). Opening the project again shows the same history, saved versions and
 * conflicts as before it was closed.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collected } from './collect-garbage';

const env = vi.hoisted(() => ({ userData: '' }));
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
const { createStarterState } = await import('@catalogue/starters');

type Session = InstanceType<typeof ProjectSession>;
type Attaching = { attach(s: unknown, workspace: object, runtime: object): Promise<void> };

const dirs: string[] = [];
const controllers: InstanceType<typeof Controller>[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-closed-${name}-`)));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  env.userData = temp('userdata');
});
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function controller() {
  const c = new Controller(() => null);
  controllers.push(c);
  return c;
}

/** A new project's folder, made and closed again. */
async function makeProject(): Promise<string> {
  const dir = join(temp('project'), 'site');
  await (await ProjectSession.create(dir, createStarterState('business', 'Closed Site', false))).close();
  return dir;
}

/** Open `dir` in `c` for editing, with no preview. */
async function attach(c: InstanceType<typeof Controller>, dir: string): Promise<Session> {
  const session = await ProjectSession.open(dir, 'this-window');
  await (c as unknown as Attaching).attach(session, {}, { state: 'error', message: 'No preview in this test.' });
  return session;
}

/**
 * Open a project, change it, have the controller make the copy guests are given, and close it: only weak references
 * to what it was are returned, so nothing here keeps it.
 */
async function openEditAndClose(c: InstanceType<typeof Controller>) {
  const session = await attach(c, await makeProject());
  const home = session.state.site.homePageId;
  expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, seoTitle: 'Fresh bread daily' }] })).ok).toBe(true);
  const copy = c.guestSnapshot(c.snapshot()!.workspaceKey);
  expect(copy?.revision).toBe(session.revision);
  const refs = { session: new WeakRef(session), state: new WeakRef(session.state), copy: new WeakRef(copy!) };
  expect(await c.closeProject()).toEqual({ ok: true });
  expect(c.session).toBeNull();
  return refs;
}

describe('a closed project', () => {
  it('is reached by nothing the controller keeps: its session, its documents and the copy for guests all go', async () => {
    const c = controller();
    const refs = await openEditAndClose(c);
    expect(await collected(refs.session), 'the closed session is still reachable').toBe(true);
    expect(await collected(refs.state), 'the closed project’s documents are still reachable').toBe(true);
    expect(await collected(refs.copy), 'the copy made for guests is still reachable').toBe(true);
    // The controller goes on to open the next project as usual.
    const next = await attach(c, await makeProject());
    expect(c.snapshot()?.dir).toBe(next.dir);
  });

  it('shows the same history, saved versions and conflicts when it is opened again', async () => {
    const c = controller();
    const dir = await makeProject();
    const s = await attach(c, dir);
    const home = s.state.site.homePageId;
    for (const seoTitle of ['Fresh bread daily', 'Bread and cake']) expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, seoTitle }] })).ok).toBe(true);
    expect((await c.saveVersion('Before the rush', c.snapshot()!.workspaceKey)).ok).toBe(true);
    // A conflict: an AI request cancelled after the home page's file was changed outside the app meanwhile.
    expect(await s.beginRun('run_held')).toBeNull();
    expect((await s.apply({ operations: [{ type: 'page.update', pageId: home, seoTitle: 'By the AI' }] }, { label: 'AI', source: 'ai', runId: 'run_held', history: false })).ok).toBe(true);
    const file = join(dir, 'siteorigin', 'pages', `${home}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), title: 'Edited by hand' }, null, 2));
    expect((await s.abortRun()).restored).toBe(false);
    const before = c.snapshot()!;
    expect([before.history.entries.length > 1, !!before.versions?.list.some((v) => v.name === 'Before the rush'), before.conflicts.length]).toEqual([true, true, 1]);
    expect(await c.closeProject()).toEqual({ ok: true });
    await attach(c, dir);
    const after = c.snapshot()!;
    expect(after.history).toEqual(before.history);
    expect(after.versions).toEqual(before.versions);
    expect(after.conflicts).toEqual(before.conflicts);
  });
});
