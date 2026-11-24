/**
 * A read-only open (spec 16.6, 18.1) leaves the project folder byte-identical through the session and chat read
 * paths. The one deliberate exception is the user's Unlock, which takes the lock and leaves read-only mode.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { SCHEMA_VERSION } from '@shared/types';
import { Orchestrator } from '@agent/orchestrator';
import { ProjectLockedError, ProjectSession } from '../../src/main/project/session';
import { newestStoredVersion, ProjectFormatError } from '../../src/main/project/documents';

type Tree = Record<string, { kind: string; size: number; mtimeMs: number; hash?: string; link?: string }>;

/** Everything in the folder: paths, kinds, sizes, modification times and content hashes. */
function snapshotTree(root: string): Tree {
  const out: Tree = { '.': { kind: 'dir', size: 0, mtimeMs: lstatSync(root).mtimeMs } };
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      const rel = relative(root, p);
      if (st.isSymbolicLink()) out[rel] = { kind: 'link', size: st.size, mtimeMs: st.mtimeMs, link: readlinkSync(p) };
      else if (st.isDirectory()) {
        out[rel] = { kind: 'dir', size: 0, mtimeMs: st.mtimeMs };
        walk(p);
      } else out[rel] = { kind: 'file', size: st.size, mtimeMs: st.mtimeMs, hash: createHash('sha256').update(readFileSync(p)).digest('hex') };
    }
  };
  walk(root);
  return out;
}

const dirs: string[] = [];
const sessions: ProjectSession[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const CHAT = '.siteorigin/sessions/chat';

async function makeProject(chat: boolean): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'so-readonly-')));
  dirs.push(dir);
  const created = await ProjectSession.create(dir, createStarterState('blank', 'Read Only Site', false));
  await created.close();
  if (chat) {
    mkdirSync(join(dir, CHAT), { recursive: true });
    writeFileSync(join(dir, CHAT, 'c_saved.json'), JSON.stringify({ id: 'c_saved', title: 'Saved', createdAt: '2026-01-01T00:00:00.000Z', messages: [{ id: 'm_1', role: 'user', text: 'Hello', time: '2026-01-01T00:00:00.000Z' }] }));
  }
  return dir;
}

function lockByAnother(dir: string) {
  writeFileSync(join(dir, '.siteorigin/lock.json'), JSON.stringify({ pid: process.pid, host: hostname(), instance: 'another-window', started: new Date().toISOString() }));
}

function makeNewer(dir: string) {
  const path = join(dir, 'siteorigin.project.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), schemaVersion: SCHEMA_VERSION + 1 }, null, 2));
}

function orchestratorFor(session: ProjectSession) {
  return new Orchestrator({
    session: () => session,
    adapter: async () => ({ error: 'No provider in this test.' }),
    emit: () => undefined,
    compileAll: async () => [],
    inspectLayout: async () => {
      throw new Error('No preview in this test.');
    },
    onBusyChange: () => undefined,
    codeEnabled: async () => false
  } as never);
}

/** Open the way the controller does: the normal open is refused, then the project opens for inspection. */
async function openReadOnly(dir: string): Promise<ProjectSession> {
  const err = await ProjectSession.open(dir, 'me').catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  const session = await ProjectSession.openReadOnly(dir, { reason: err.message, canUnlock: err instanceof ProjectLockedError });
  sessions.push(session);
  return session;
}

async function exercise(session: ProjectSession, chat: boolean) {
  const orchestrator = orchestratorFor(session);
  const loaded = await orchestrator.loadConversations();
  expect(loaded.list.map((c) => c.id)).toEqual(chat ? ['c_saved'] : []);
  for (const c of loaded.list) await orchestrator.openConversation(c.id);
  // Naming or deleting one conversation is refused, the open one or a saved one, and writes nothing (#235).
  for (const id of [loaded.active.id, ...loaded.list.map((c) => c.id)]) {
    await expect(orchestrator.renameConversation(id, 'Renamed')).rejects.toThrow(session.readOnly!.reason);
    await expect(orchestrator.deleteConversation(id)).rejects.toThrow(session.readOnly!.reason);
  }
  await orchestrator.newConversation();
  await orchestrator.clearHistory();
  // An edit is refused outright. A question is taken only while another app holds the project (#203): it writes
  // nothing, so the project stays byte-identical either way. A newer format is not read here at all.
  expect(await orchestrator.send('Change the title', { pageId: session.state.site.pageOrder[0] } as never)).toMatchObject({ ok: false });
  const asked = await orchestrator.send('What is the title?', { pageId: session.state.site.pageOrder[0], mode: 'ask' } as never);
  expect(asked.ok).toBe(!!session.readOnly?.canUnlock);
  for (let i = 0; i < 200 && orchestrator.busy; i++) await new Promise((r) => setTimeout(r, 10));
  expect(orchestrator.busy).toBe(false);
  expect(await session.reloadFromDisk()).toEqual({ ok: true });
  expect((await session.apply({ operations: [{ type: 'site.update', name: 'Nope' }] }, { label: 'x' })).ok).toBe(false);
  expect((await session.undo()).ok).toBe(false);
  expect((await session.redo()).ok).toBe(false);
  expect(await session.beginRun('run_x')).toBeTruthy();
  await expect(session.restoreGeneratedFile('src/routes/+page.svelte')).rejects.toThrow();
  await session.close();
}

describe('read-only opens leave the project byte-identical', () => {
  for (const chat of [false, true]) {
    const label = chat ? 'with a saved chat' : 'with no chat yet';

    it(`locked by another app, ${label}`, async () => {
      const dir = await makeProject(chat);
      lockByAnother(dir);
      const before = snapshotTree(dir);
      const session = await openReadOnly(dir);
      expect(session.readOnly?.canUnlock).toBe(true);
      await exercise(session, chat);
      expect(snapshotTree(dir)).toEqual(before);
      expect(existsSync(join(dir, CHAT))).toBe(chat);
    });

    it(`newer format, ${label}`, async () => {
      const dir = await makeProject(chat);
      makeNewer(dir);
      const before = snapshotTree(dir);
      const session = await openReadOnly(dir);
      expect(session.readOnly?.canUnlock).toBe(false);
      await exercise(session, chat);
      expect(snapshotTree(dir)).toEqual(before);
      expect(existsSync(join(dir, CHAT))).toBe(chat);
    });
  }
});

describe('a newer format is found even behind a broken document', () => {
  it('refuses a normal open before writing anything, and the read-only open fails too', async () => {
    const dir = await makeProject(false);
    rmSync(join(dir, '.siteorigin'), { recursive: true, force: true });
    const pages = join(dir, 'siteorigin/pages');
    const [first] = readdirSync(pages).sort();
    const page = JSON.parse(readFileSync(join(pages, first), 'utf8'));
    writeFileSync(join(pages, first), JSON.stringify({ ...page, schemaVersion: SCHEMA_VERSION + 1 }, null, 2));
    // Read before the newer page: its parse error must not hide the newer format.
    writeFileSync(join(pages, 'aaa-broken.json'), '{ not json');
    const before = snapshotTree(dir);
    const err = await ProjectSession.open(dir, 'me').catch((e) => e);
    expect(err).toBeInstanceOf(ProjectFormatError);
    expect(err.readOnly).toBe(true);
    expect(err).not.toBeInstanceOf(ProjectLockedError);
    // The controller then opens it for inspection, which cannot read the broken page either.
    await expect(ProjectSession.openReadOnly(dir, { reason: err.message, canUnlock: false })).rejects.toThrow(/aaa-broken/);
    expect(snapshotTree(dir)).toEqual(before);
    expect(existsSync(join(dir, '.siteorigin'))).toBe(false);
  });
});

describe('a newer document anywhere is found', () => {
  it('in a component', async () => {
    const dir = await makeProject(false);
    const doc = join(dir, 'siteorigin/components/c_newer/component.json');
    mkdirSync(join(doc, '..'), { recursive: true });
    writeFileSync(doc, JSON.stringify({ id: 'c_newer', schemaVersion: SCHEMA_VERSION + 1 }));
    writeFileSync(join(dir, 'siteorigin/pages/aaa-broken.json'), '{ not json');
    expect(await newestStoredVersion(dir)).toBe(SCHEMA_VERSION + 1);
    const before = snapshotTree(dir);
    const err = await ProjectSession.open(dir, 'me').catch((e) => e);
    expect(err.readOnly).toBe(true);
    expect(snapshotTree(dir)).toEqual(before);
  });

  it('in a page whose id would hide it from the loaded project', async () => {
    const dir = await makeProject(false);
    const [first] = readdirSync(join(dir, 'siteorigin/pages')).sort();
    const page = JSON.parse(readFileSync(join(dir, 'siteorigin/pages', first), 'utf8'));
    writeFileSync(join(dir, 'siteorigin/pages/__proto__.json'), JSON.stringify({ ...page, id: '__proto__', schemaVersion: SCHEMA_VERSION + 1 }));
    const before = snapshotTree(dir);
    const err = await ProjectSession.open(dir, 'me').catch((e) => e);
    expect(err).toBeInstanceOf(ProjectFormatError);
    expect(err.readOnly).toBe(true);
    expect(snapshotTree(dir)).toEqual(before);
  });
});

describe('the deliberate exception: Unlock', () => {
  it('takes the lock and leaves read-only mode', async () => {
    const dir = await makeProject(false);
    lockByAnother(dir);
    const readOnly = await openReadOnly(dir);
    await readOnly.close();
    const unlocked = await ProjectSession.open(dir, 'me', { force: true });
    sessions.push(unlocked);
    expect(unlocked.readOnly).toBeNull();
    expect(JSON.parse(readFileSync(join(dir, '.siteorigin/lock.json'), 'utf8')).instance).toBe('me');
    expect((await unlocked.apply({ operations: [{ type: 'site.update', name: 'Unlocked' }] }, { label: 'x' })).ok).toBe(true);
  });
});
