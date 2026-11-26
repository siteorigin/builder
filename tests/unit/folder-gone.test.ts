/**
 * An open project whose folder is removed or renamed (issue 830): no watch on it throws, and the project is reported
 * as gone rather than left to fail at the next write.
 */
import type { FSWatcher } from 'node:fs';
import { existsSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const dirs: string[] = [];
const controllers: InstanceType<typeof Controller>[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-gone-${name}-`)));
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

type Watching = { watchers: FSWatcher[]; attach(s: unknown, workspace: object, runtime: object): Promise<void> };

/** A project open for editing, its watches running. No preview is started. */
async function openProject() {
  const dir = join(temp('project'), 'site');
  await (await ProjectSession.create(dir, createStarterState('blank', 'Gone Site', false))).close();
  const session = await ProjectSession.open(dir, 'this-window');
  const c = new Controller(() => null);
  const sent: Array<[string, unknown]> = [];
  c.send = (channel: string, payload?: unknown) => void sent.push([channel, payload]);
  controllers.push(c);
  const inside = c as unknown as Watching;
  await inside.attach(session, {}, { state: 'error', message: 'No preview in this test.' });
  return { dir, c, session, sent, watchers: inside.watchers };
}

async function expectReportedGone(c: InstanceType<typeof Controller>) {
  await vi.waitFor(() => expect(c.snapshot()?.readOnly?.reason).toMatch(/project folder is gone/i), { timeout: 5000 });
  expect(c.snapshot()?.readOnly?.canUnlock).toBe(false);
  expect(c.snapshot()?.runtime).toMatchObject({ state: 'unavailable', message: expect.stringMatching(/project folder is gone/i) });
}

describe('an open project whose folder goes away', () => {
  it('survives an error from any of its watches', async () => {
    const { watchers } = await openProject();
    expect(watchers).toHaveLength(3);
    // As Windows ends a watch whose folder went: with no handler, this is thrown.
    for (const w of watchers) expect(() => w.emit('error', Object.assign(new Error('EPERM: operation not permitted, watch'), { code: 'EPERM' }))).not.toThrow();
  });

  it('is reported as gone when it is removed, and can still be closed', async () => {
    const { dir, c, sent } = await openProject();
    rmSync(dir, { recursive: true, force: true });
    await expectReportedGone(c);
    expect((await c.closeProject()).ok).toBe(true);
    expect(c.session).toBeNull();
    expect(sent.map(([channel]) => channel)).toContain('project:closed');
    // Nothing the app did afterwards made the folder again.
    expect(existsSync(dir)).toBe(false);
  });

  it('is reported as gone at the next lock check when it is renamed', async () => {
    const { dir, c, session } = await openProject();
    renameSync(dir, `${dir}-moved`);
    await expect(session.refreshLock()).resolves.toBe('unknown');
    await expectReportedGone(c);
    await expect(session.stillOwner()).resolves.toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it('can be closed when nothing noticed before the close', async () => {
    const { dir, c, watchers } = await openProject();
    for (const w of watchers) w.close();
    rmSync(dir, { recursive: true, force: true });
    expect((await c.closeProject()).ok).toBe(true);
    expect(c.session).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it('stays open and editable when only a watched folder is removed', async () => {
    const { dir, c, session, watchers } = await openProject();
    rmSync(join(dir, 'static'), { recursive: true, force: true });
    for (const w of watchers) w.emit('error', new Error('EPERM'));
    await new Promise((r) => setTimeout(r, 800));
    expect(c.snapshot()?.readOnly).toBeNull();
    await expect(session.stillOwner()).resolves.toBe(true);
  });
});
