/**
 * Saving an external source's settings through the editor (#678): only Connect external source saves them, testing
 * them first, so an ordinary edit is refused; a converter that may not run, or settings holding one of the user's
 * saved secrets, are refused before anything is asked of the source or written into the project.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** A stand-in for Electron's utility process that starts at once and exits when asked to stop. */
class FakeWorker extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exited = false;
  postMessage(m: { type: string }) {
    if (m.type === 'start') queueMicrotask(() => this.emit('message', { type: 'ready', url: 'http://127.0.0.1:1' }));
    if (m.type === 'stop') this.kill();
  }
  kill() {
    if (this.exited) return true;
    this.exited = true;
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }
}

/** A stand-in for the source sync worker: it keeps each request it is sent and answers with no records. */
class FakeSync extends EventEmitter {
  constructor(private seen: Array<{ mode: string; secrets?: Record<string, string> }>) {
    super();
  }
  postMessage(m: { id: number; mode?: string; secrets?: Record<string, string> }) {
    // A sync names no mode; a sample or an inspection does.
    this.seen.push({ mode: m.mode ?? 'sync', secrets: m.secrets });
    queueMicrotask(() => this.emit('message', { id: m.id, ok: true, records: [], images: [], ...(m.mode === 'sample' ? { raw: [] } : {}) }));
  }
  kill() {
    return true;
  }
}

const env = vi.hoisted(() => ({ userData: '', forks: 0, syncs: [] as Array<{ mode: string; secrets?: Record<string, string> }> }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) },
  utilityProcess: { fork: (path: string) => (env.forks++, path.includes('source-sync-worker') ? new FakeSync(env.syncs) : new FakeWorker()) }
}));

const { createStarterState } = await import('@catalogue/starters');
const { applyOperations } = await import('@engine/apply');
const { ProjectSession } = await import('../../src/main/project/session');
const { Controller } = await import('../../src/main/controller');
const { createSecretStore } = await import('../../src/main/sources/secrets');
const { createApprovalStore } = await import('../../src/main/sources/approvals');
import type { EditOperation } from '@shared/ops';
import type { SourceSettingsDraft } from '@shared/api';
import { sourceFingerprint } from '@shared/sources';

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
const controllers: Array<InstanceType<typeof Controller>> = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const SECRET = 'tok-11223344556677aa';

async function opened(ops: EditOperation[] = []) {
  env.userData = tmp('so-src-userdata-');
  env.syncs = [];
  const state = applyOperations(createStarterState('blank', 'Sources', false), [
    { type: 'collection.create', collectionId: 'team', name: 'Team', kind: 'structured', pages: { detail: false, archive: false } } as EditOperation,
    ...ops
  ]).state;
  const dir = tmp('so-src-project-');
  await (await ProjectSession.create(dir, state)).close();
  const c = new Controller(() => null);
  c.send = () => undefined;
  controllers.push(c);
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  await createSecretStore(() => join(env.userData, 'source-secrets.json'))
    .in(dir)
    .set(state.manifest.projectId, 'api', SECRET);
  return { c, dir, state };
}

const draft = (extra: Partial<SourceSettingsDraft> = {}): SourceSettingsDraft => ({ sourceId: 'team', name: 'Team API', adapter: 'rest', collectionId: 'team', config: { url: 'https://api.example/team' }, ...extra });

describe('saving a source’s settings in the editor', () => {
  it('is only done by Connect external source, which tests them first', async () => {
    const { c, dir } = await opened();
    const r = await c.apply({ operations: [{ ...draft(), type: 'source.upsert' } as EditOperation] });
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'A source’s settings are saved from Connect external source, which tests them first.' } });
    expect(existsSync(join(dir, 'siteorigin/sources'))).toBe(false);
  });

  it('refuses a converter that may not run, and settings holding a saved secret, before the source is asked or anything is written', async () => {
    const { c, dir } = await opened();
    const forks = env.forks;
    const unsafe = await c.saveSource(draft({ converter: 'export function convert(items) {\n  return require("child_process").execSync("id");\n}' }), c.openingKey!);
    expect(unsafe.ok).toBe(false);
    expect(!unsafe.ok && unsafe.message).toMatch(/^Its converter cannot be run:\nLine 2: It uses require/);
    const tested = await c.testSource(draft({ converter: 'import fs from "node:fs";\nexport function convert(i) { return i; }' }), c.openingKey!);
    expect(tested).toMatchObject({ ok: false, message: expect.stringContaining('Line 1: It imports a module') });
    const leaked = await c.saveSource(draft({ name: `Team ${SECRET}` }), c.openingKey!);
    expect(leaked).toMatchObject({ ok: false, message: expect.stringContaining('may not hold one of your secrets') });
    expect(JSON.stringify(leaked)).not.toContain(SECRET);
    const literal = await c.saveSource(draft({ config: { url: 'https://api.example/team', headers: { Authorization: 'Bearer abc123def456' } } }), c.openingKey!);
    expect(literal).toMatchObject({ ok: false, message: expect.stringContaining('must name a secret') });
    // From another opening of the project, nothing is tested or saved.
    expect(await c.saveSource(draft(), 'another opening')).toMatchObject({ ok: false, message: 'The project was closed before the source was saved.' });
    expect(env.forks).toBe(forks);
    expect(existsSync(join(dir, 'siteorigin/sources'))).toBe(false);
  });
});

describe('a copy of a project in another folder (#1543)', () => {
  const PUBLISHED = 'tok-published-audience';
  const STAGING = 'tok-staging-audience';
  const signedIn = { sourceId: 'team', name: 'Team API', adapter: 'rest', collectionId: 'team', config: { url: 'https://api.example/team', headers: { Authorization: 'Bearer ${secret:api}' } } } as const;

  it('keeps its own source secrets and approvals: a secret saved there never changes what the original syncs with', async () => {
    const { c, dir: original, state } = await opened([{ ...signedIn, type: 'source.upsert' } as EditOperation]);
    // An editable ZIP opened into another folder: the same project, its ID and source settings and all, somewhere else.
    const copy = tmp('so-src-copy-');
    await (await ProjectSession.create(copy, state)).close();
    const projectId = state.manifest.projectId;
    const approvals = createApprovalStore(() => join(env.userData, 'source-approvals.json'));
    await approvals.in(original).approve(projectId, state.sources!.team);
    expect((await c.setSourceSecret('api', PUBLISHED, c.openingKey!)).ok).toBe(true);
    expect(await c.sourceSecretNames(c.openingKey!)).toEqual(['api']);

    expect((await c.trustAndOpen(copy)).ok).toBe(true);
    // Nothing saved for the original shows as saved in the copy, and its settings were never approved there.
    expect(await c.sourceSecretNames(c.openingKey!)).toEqual([]);
    expect((await c.setSourceSecret('api', STAGING, c.openingKey!)).ok).toBe(true);
    expect((await c.setSourceSecret('copy-only', 'tok-copy-only', c.openingKey!)).ok).toBe(true);
    expect(await c.sourceSecretNames(c.openingKey!)).toEqual(['api', 'copy-only']);
    expect(await c.syncSource('team', c.openingKey!)).toMatchObject({ ok: false, code: 'unapproved' });
    expect(env.syncs).toEqual([]);
    // Saved here, the settings are approved here and nowhere else; the copy then syncs with its own secret.
    expect(await c.saveSource({ ...signedIn, config: structuredClone(signedIn.config) }, c.openingKey!, sourceFingerprint(state.sources!.team))).toMatchObject({ ok: true });
    expect(env.syncs.splice(0)).toEqual([{ mode: 'sample', secrets: { api: STAGING } }]);
    const saved = c.session!.state.sources!.team;
    expect(await approvals.in(copy).approved(projectId, saved)).toBe(true);
    expect(await c.syncSource('team', c.openingKey!)).toMatchObject({ ok: true });
    expect(env.syncs.splice(0)).toEqual([{ mode: 'sync', secrets: { api: STAGING } }]);
    expect((await c.setSourceSecret('copy-only', null, c.openingKey!)).ok).toBe(true);
    expect(await c.sourceSecretNames(c.openingKey!)).toEqual(['api']);

    // Back in the original, its next sync signs in with its own secret.
    expect((await c.trustAndOpen(original)).ok).toBe(true);
    expect(await c.sourceSecretNames(c.openingKey!)).toEqual(['api']);
    expect(await c.syncSource('team', c.openingKey!)).toMatchObject({ ok: true });
    expect(env.syncs.splice(0)).toEqual([{ mode: 'sync', secrets: { api: PUBLISHED } }]);
    const secrets = createSecretStore(() => join(env.userData, 'source-secrets.json'));
    expect(await secrets.in(original).resolve(projectId, ['api'])).toEqual({ api: PUBLISHED });
    // Settings approved only in the copy are not approved here.
    const elsewhere = { ...state.sources!.team, config: { ...state.sources!.team.config, url: 'https://staging.example/team' } };
    await approvals.in(copy).approve(projectId, elsewhere);
    expect(await approvals.in(original).approved(projectId, elsewhere)).toBe(false);
    // From an opening that has ended, nothing is listed or changed.
    expect(await c.sourceSecretNames('another opening')).toEqual([]);
    expect(await c.setSourceSecret('api', STAGING, 'another opening')).toMatchObject({ ok: false });
    expect(await secrets.in(original).resolve(projectId, ['api'])).toEqual({ api: PUBLISHED });
  });

  it('changes no secret from a project open only to look at', async () => {
    const { c, dir, state } = await opened();
    expect((await c.setSourceSecret('api', PUBLISHED, c.openingKey!)).ok).toBe(true);
    await c.close();
    // Another window holds the project, so this one opens it read-only.
    writeFileSync(join(dir, '.siteorigin/lock.json'), JSON.stringify({ pid: process.pid, host: hostname(), instance: 'another-window', started: new Date().toISOString() }));
    const viewer = new Controller(() => null);
    viewer.send = () => undefined;
    controllers.push(viewer);
    expect((await viewer.trustAndOpen(dir)).ok).toBe(true);
    expect(viewer.session?.readOnly).toBeTruthy();
    expect(await viewer.setSourceSecret('api', STAGING, viewer.openingKey!)).toMatchObject({ ok: false });
    expect(await createSecretStore(() => join(env.userData, 'source-secrets.json')).in(dir).resolve(state.manifest.projectId, ['api'])).toEqual({ api: PUBLISHED });
  });
});
