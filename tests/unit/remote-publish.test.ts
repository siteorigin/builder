/**
 * Publishing a project to a host through the controller (#1157): connected to a disposable HTTPS Git host
 * (https-git-server.ts) with a token kept in the user's own credential file, the prepared publication is pushed and
 * the host's repository, cloned, holds the published site alone; nothing a draft or a deleted picture held is
 * anywhere in it. The token is never in the project, a repository's settings, the app's logs or what the editor's
 * window is sent; what is known of the host is kept as three facts apart; a lost reply is settled by the host's branch;
 * and neither a duplicate, a ZIP file nor a copy of the folder made outside the app can push with the credential.
 *
 * Skipped where stock Git or openssl is missing, except on CI, where both must be there.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetRecord, ProjectState } from '@shared/types';
import { HOST_AVAILABLE, startGitHost, stockGit, type GitHost } from './https-git-server';

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
  utilityProcess: { fork: () => undefined }
}));

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');
const { applyOperations } = await import('@engine/apply');
const { createGitClient } = await import('../../src/main/git/client');
const { createGitService } = await import('../../src/main/git/service');
const { PUBLISH_BRANCH, VERSIONS_BRANCH } = await import('../../src/main/git/protocol');
const { captureSnapshotInventory } = await import('../../src/main/project/snapshot-inventory');
const { httpsGitTransport } = await import('../../src/main/remote/transport');
const { REMOTE_STATE_FILE } = await import('../../src/main/remote/binding');
const { REMOTE_CREDENTIALS_FILE } = await import('../../src/main/remote/credentials');
const { readProjectZip, unpackProject } = await import('../../src/main/unzip');
const { isPrivateFileName } = await import('../../src/main/project/private-files');
const { snapshotPlace } = await import('../../src/main/project/snapshot-inventory');
type GitWorkerHandle = import('../../src/main/git/client').GitWorkerHandle;

const PHRASE = 'Embargoed winter launch 7Q2X';
const DRAFT_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="launch-teaser-only"/></svg>';
const PUBLIC_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="shelf"/></svg>';
const APP = { name: 'SiteOrigin Builder', email: 'versions@siteorigin.invalid', timestamp: 1_790_000_000, timezoneOffset: 0 };
const USER = 'publisher';
const TOKEN = 'tok_5c7e1a9f3b2d4e6081a7c9e2';

const dirs: string[] = [];
const controllers: Array<InstanceType<typeof Controller>> = [];
const clients: Array<ReturnType<typeof createGitClient>> = [];
const hosts: GitHost[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-remote-${name}-`)));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  env.userData = temp('userdata');
});
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  for (const g of clients.splice(0)) g.stop();
  for (const h of hosts.splice(0)) await h.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** The Git worker's service in this process behind the real client, trusting the host's certificate. */
function inProcessGit(ca: string) {
  const client = createGitClient(() => {
    const on: Record<string, Array<(x?: unknown) => void>> = {};
    const emit = (e: string, x?: unknown) => (on[e] ?? []).forEach((l) => l(x));
    const service = createGitService((reply) => setImmediate(() => emit('message', structuredClone(reply))), { remote: { ca } });
    let alive = true;
    return {
      postMessage: (m) => {
        if (!alive) throw new Error('gone');
        void service.handle(structuredClone(m));
      },
      on: (e: string, l: (x?: unknown) => void) => ((on[e] ??= []).push(l), undefined),
      kill: () => {
        if (!alive) return false;
        alive = false;
        setImmediate(() => emit('exit', 0));
        return true;
      }
    } as GitWorkerHandle;
  });
  clients.push(client);
  return client;
}

async function host() {
  const h = await startGitHost({ username: USER, password: TOKEN, ...(hosts[0] ? { certs: hosts[0].certs } : {}) });
  hosts.push(h);
  return h;
}

const image = (id: string, name: string, file: string, svg: string): AssetRecord => ({ id, name, file, mime: 'image/svg+xml', bytes: svg.length, hash: id, kind: 'image', createdAt: '2026-01-01T00:00:00.000Z' });

/** A business site whose Home shares a picture of a shelf, with a draft page (PHRASE) sharing a picture only it shows. */
async function project(edit: (state: ProjectState) => ProjectState = (s) => s) {
  const dir = temp('project');
  let state = createStarterState('business', 'Bookshop', false);
  state.site.baseUrl = 'https://books.example';
  state.assets.assets.shelf = image('shelf', 'Shelf', 'static/assets/shelf-11111111.svg', PUBLIC_SVG);
  state.assets.assets.launch = image('launch', 'Launch teaser', 'static/assets/launch-22222222.svg', DRAFT_SVG);
  state = applyOperations(state, [
    { type: 'page.update', pageId: state.site.homePageId, socialImage: 'shelf' },
    { type: 'page.create', pageId: 'pg_launch01', title: PHRASE, route: '/launch/' },
    { type: 'page.update', pageId: 'pg_launch01', draft: true, socialImage: 'launch' }
  ]).state;
  state = edit(state);
  cpSync(join(process.cwd(), 'templates/sveltekit-brochure/files'), dir, { recursive: true });
  await (await ProjectSession.create(dir, state)).close();
  mkdirSync(join(dir, 'static/assets'), { recursive: true });
  writeFileSync(join(dir, 'static/assets/shelf-11111111.svg'), PUBLIC_SVG);
  writeFileSync(join(dir, 'static/assets/launch-22222222.svg'), DRAFT_SVG);
  return dir;
}

async function open(dir: string, ca: string) {
  const c = new Controller(() => null);
  const sent: unknown[] = [];
  c.send = (...args: unknown[]) => void sent.push(args);
  c.startRuntime = async () => undefined;
  controllers.push(c);
  const git = inProcessGit(ca);
  c.repository = (root) => git.repository(root);
  c.remoteTransport = httpsGitTransport(git);
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  await vi.waitFor(() => expect(c.snapshot()).not.toBeNull());
  return { c, repo: git.repository(dir), sent };
}

/** Every file under `dir` (none skipped), by its path relative to it. */
function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out;
}
const holds = (dir: string, needle: string) => files(dir).filter((f) => readFileSync(join(dir, f)).includes(needle));

/** Every object in a repository, reachable or not, each with its type and its content as text. */
function allObjects(h: GitHost): Array<{ oid: string; type: string; body: string }> {
  const listed = h.git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']).trim().split('\n').filter(Boolean);
  return listed.map((line) => {
    const [oid, type] = line.split(' ');
    return { oid, type, body: type === 'blob' ? h.git(['cat-file', 'blob', oid]) : h.git(['cat-file', '-p', oid]) };
  });
}

describe.skipIf(!HOST_AVAILABLE && !process.env.CI)('publishing a project to an HTTPS Git host', { timeout: 60_000 }, () => {
  it('pushes the published site alone: a draft page and a picture saved in a version and then deleted are nowhere at the host', async () => {
    const h = await host();
    const dir = await project();
    // A saved version of the project as it is, the draft and its picture included.
    const inv = await captureSnapshotInventory(dir, { settleMs: 0 });
    const saved = await Promise.all(inv.tree.map(async (f) => ({ path: f.path, bytes: await f.read() })));
    const { c, repo } = await open(dir, h.ca);
    await repo.init();
    const version = await repo.writeCommit({ tree: await repo.writeFiles(saved), parents: [], author: APP, committer: APP, message: 'Saved\n' });
    await repo.advanceRef(VERSIONS_BRANCH, version, null);
    expect((await c.apply({ operations: [{ type: 'page.remove', pageId: 'pg_launch01' }, { type: 'asset.remove', assetId: 'launch' }] })).ok).toBe(true);

    expect(await c.bindRemote({ url: h.url, username: USER, token: TOKEN })).toMatchObject({ ok: true });
    const prepared = await c.preparePublication();
    if (!prepared.ok) throw new Error(prepared.message);
    expect(await c.pushPublication({ commit: prepared.commit })).toEqual({ ok: true, commit: prepared.commit, uploaded: true, reconciled: false });

    // The host holds the publication's branch alone, at the commit prepared.
    expect(h.git(['for-each-ref', '--format=%(refname) %(objectname)']).trim()).toBe(`${PUBLISH_BRANCH} ${prepared.commit}`);
    const objects = allObjects(h);
    expect(objects.filter((o) => o.type === 'commit')).toHaveLength(1);
    const everything = objects.map((o) => o.body).join('\n');
    expect(everything).not.toContain(PHRASE);
    expect(everything).not.toContain('launch-22222222');
    expect(everything).not.toContain('Launch teaser');
    expect(objects.map((o) => o.body)).not.toContain(DRAFT_SVG);
    expect(objects.map((o) => o.body)).toContain(PUBLIC_SVG);
    h.git(['fsck', '--strict', '--no-dangling']);

    // Cloned into an empty folder, it is the published website, as the publication's own clone is (#1154).
    const clone = join(temp('clone'), 'site');
    stockGit(['clone', '--quiet', '--no-local', '--branch', 'siteorigin-publish', h.bare, clone], { cwd: dirname(clone), home: dirname(clone) });
    expect(stockGit(['rev-parse', 'HEAD'], { cwd: clone, home: dirname(clone) }).trim()).toBe(prepared.commit);
    expect(existsSync(join(clone, 'package.json'))).toBe(true);
    expect(existsSync(join(clone, 'static/assets/shelf-11111111.svg'))).toBe(true);
    expect(existsSync(join(clone, 'static/assets/launch-22222222.svg'))).toBe(false);
    expect(holds(clone, PHRASE)).toEqual([]);
  });

  it('keeps the token out of the project, every repository’s settings, the logs and what the window is sent', async () => {
    const h = await host();
    const dir = await project();
    const { c, sent } = await open(dir, h.ca);
    const bound = await c.bindRemote({ url: h.url, username: USER, token: TOKEN });
    expect(bound.ok).toBe(true);
    const prepared = await c.preparePublication();
    expect(prepared.ok).toBe(true);
    const pushed = await c.pushPublication();
    expect(pushed.ok).toBe(true);
    const status = await c.remoteStatus();

    const file = join(env.userData, REMOTE_CREDENTIALS_FILE);
    expect(statSync(file).mode & 0o777).toBe(process.platform === 'win32' ? statSync(file).mode & 0o777 : 0o600);
    expect(readFileSync(file, 'utf8')).toContain(TOKEN);
    expect(holds(dir, TOKEN), 'project files, .siteorigin and its versions repository included').toEqual([]);
    expect(holds(h.bare, TOKEN)).toEqual([]);
    expect(holds(env.userData, TOKEN)).toEqual([REMOTE_CREDENTIALS_FILE]);
    expect(readFileSync(join(dir, '.siteorigin/versions.git/config'), 'utf8')).not.toContain('remote');
    expect(JSON.stringify([bound, prepared, pushed, status, sent, c.snapshot()])).not.toContain(TOKEN);
    // The binding the project keeps names the address alone.
    const kept = JSON.parse(readFileSync(join(dir, REMOTE_STATE_FILE), 'utf8'));
    expect(kept.binding).toEqual({ id: expect.stringMatching(/^rb_[0-9a-f]{24}$/), provider: 'https-git', url: h.url, site: null });
    // The credential file is private wherever a copy of it lands, and never part of a snapshot.
    for (const name of [REMOTE_CREDENTIALS_FILE, 'remote-credentials.json~', '.remote-credentials.json.swp', 'remote-credentials (1).json', 'Copy of remote-credentials.json', 'Remote-Credentials.JSON']) {
      expect(isPrivateFileName(name), name).toBe(true);
      expect(snapshotPlace(`static/${name}`), name).toMatchObject({ kind: 'excluded', reason: 'private' });
    }
    expect(snapshotPlace('static/remote-credentials (conflicted copy).json')).toMatchObject({ kind: 'excluded', reason: 'private' });
    // A publication that carries the token is refused.
    writeFileSync(join(dir, 'static/notes.txt'), `deploy with ${TOKEN}\n`);
    expect(await c.preparePublication()).toMatchObject({ ok: false, message: expect.stringContaining('static/notes.txt') });
  });

  it('keeps apart whether the site changed, whether the host took the push, and whether the host’s build went live', async () => {
    const h = await host();
    const dir = await project();
    const { c } = await open(dir, h.ca);
    await c.bindRemote({ url: h.url, username: USER, token: TOKEN });
    const first = await c.preparePublication();
    if (!first.ok) throw new Error(first.message);
    expect((await c.remoteStatus()) as unknown).toMatchObject({ ok: true, state: { content: { prepared: first.commit, changed: false }, acknowledged: null, receipt: null } });
    await c.pushPublication();
    expect(await c.remoteStatus()).toMatchObject({ ok: true, state: { acknowledged: { commit: first.commit }, receipt: null } });

    // The upload landed; the host's build then failed. Both stand.
    expect(await c.recordDeploymentReceipt({ commit: first.commit, status: 'failed', id: 'dep_1' })).toMatchObject({ ok: true });
    expect(await c.recordDeploymentReceipt({ commit: 'a'.repeat(40), status: 'live' })).toMatchObject({ ok: false, code: 'conflict' });
    // The site is edited: it now differs from what was prepared and uploaded, which are as they were.
    expect((await c.apply({ operations: [{ type: 'site.update', name: 'Bookshop & Café' }] })).ok).toBe(true);
    expect(await c.publicationStatus()).toMatchObject({ ok: true, changed: true });
    expect(await c.remoteStatus()).toMatchObject({
      ok: true,
      state: { content: { prepared: first.commit, changed: true }, acknowledged: { commit: first.commit }, receipt: { commit: first.commit, status: 'failed', id: 'dep_1' } }
    });

    // Pushed again unprepared: the host has it, so nothing is sent.
    const posts = h.requests.filter((r) => r.method === 'POST').length;
    expect(await c.pushPublication()).toMatchObject({ ok: true, commit: first.commit, uploaded: false });
    expect(h.requests.filter((r) => r.method === 'POST')).toHaveLength(posts);
    const second = await c.preparePublication();
    if (!second.ok) throw new Error(second.message);
    expect(await c.pushPublication({ commit: first.commit })).toMatchObject({ ok: false, code: 'conflict', actual: second.commit });
    expect(await c.pushPublication()).toMatchObject({ ok: true, commit: second.commit, uploaded: true });
    expect(await c.remoteStatus()).toMatchObject({ ok: true, state: { content: { prepared: second.commit, changed: false }, acknowledged: { commit: second.commit } } });
  });

  it('settles a push whose reply was lost by the host’s branch, and leaves a host that went its own way as it is', async () => {
    const h = await host();
    const dir = await project();
    const { c } = await open(dir, h.ca);
    await c.bindRemote({ url: h.url, username: USER, token: TOKEN });
    const first = await c.preparePublication();
    if (!first.ok) throw new Error(first.message);
    h.dropNextPushReply = true;
    expect(await c.pushPublication()).toEqual({ ok: true, commit: first.commit, uploaded: true, reconciled: true });
    expect(await c.remoteStatus()).toMatchObject({ ok: true, state: { acknowledged: { commit: first.commit } } });

    const blob = h.git(['hash-object', '-w', '--stdin'], 'theirs').trim();
    const tree = h.git(['mktree'], `100644 blob ${blob}\tindex.html\n`).trim();
    const theirs = h.git(['commit-tree', tree, '-p', first.commit, '-m', 'Theirs']).trim();
    h.git(['update-ref', PUBLISH_BRANCH, theirs, first.commit]);
    expect((await c.apply({ operations: [{ type: 'site.update', name: 'Bookshop & Café' }] })).ok).toBe(true);
    const second = await c.preparePublication();
    if (!second.ok) throw new Error(second.message);
    expect(await c.pushPublication()).toMatchObject({ ok: false, code: 'diverged', actual: theirs });
    expect(h.git(['rev-parse', PUBLISH_BRANCH]).trim()).toBe(theirs);
    expect(await c.remoteStatus()).toMatchObject({ ok: true, state: { acknowledged: { commit: first.commit } } });
  });

  it('carries neither the binding nor the credential into a duplicate, a ZIP file, or a copy of the folder', async () => {
    const h = await host();
    const dir = await project();
    const { c } = await open(dir, h.ca);
    await c.bindRemote({ url: h.url, username: USER, token: TOKEN });
    expect((await c.preparePublication()).ok).toBe(true);

    // Duplicated in the app: a new project, with no remote state of the original's.
    const parent = temp('dupes');
    const dup = await c.duplicate({ name: 'Bookshop copy', parentDir: parent, opening: c.snapshot()!.workspaceKey });
    expect(dup).toMatchObject({ ok: true });
    const dupDir = (dup as { dir: string }).dir;
    expect(existsSync(join(dupDir, REMOTE_STATE_FILE))).toBe(false);
    expect(holds(dupDir, TOKEN)).toEqual([]);

    // Its editable source as a ZIP file, opened again: neither travels.
    const zip = join(temp('zip'), 'bookshop.zip');
    expect(await c.exportSourceTo(zip, 'zip')).toMatchObject({ ok: true });
    const found = await readProjectZip(zip);
    if (found.kind !== 'project') throw new Error('not a project ZIP');
    expect(found.entries.some((e) => /remote|credential/i.test(e.path))).toBe(false);
    const unpacked = await unpackProject(zip, found, temp('unzipped'), 'bookshop');
    expect(existsSync(join(unpacked, REMOTE_STATE_FILE))).toBe(false);
    expect(holds(unpacked, TOKEN)).toEqual([]);

    // A copy of the whole folder made outside the app keeps the binding, but its folder is another: no credential.
    const copy = join(temp('finder'), 'Bookshop copy');
    cpSync(dir, copy, { recursive: true });
    rmSync(join(copy, '.siteorigin', 'lock.json'), { force: true });
    await c.close();
    const other = await open(copy, h.ca);
    expect(existsSync(join(copy, REMOTE_STATE_FILE))).toBe(true);
    const r = await other.c.pushPublication();
    expect(r).toMatchObject({ ok: false, code: 'auth-rejected', message: expect.stringContaining('No credential is saved for this project here') });
    expect(h.requests.filter((q) => q.authorization !== null)).toEqual([]);
    expect(h.git(['for-each-ref']).trim()).toBe('');
  });

  it('connects again to another address as a new binding, forgetting the old one’s credential and facts', async () => {
    const h = await host();
    const other = await host();
    const dir = await project();
    const { c } = await open(dir, h.ca);
    await c.bindRemote({ url: h.url, username: USER, token: TOKEN });
    expect((await c.preparePublication()).ok).toBe(true);
    expect((await c.pushPublication()).ok).toBe(true);
    const before = await c.remoteStatus();
    const rebound = await c.bindRemote({ url: `${other.url}/`, username: USER, token: TOKEN, site: 'site_42' });
    expect(rebound).toMatchObject({ ok: true, state: { binding: { url: other.url, site: 'site_42' }, content: null, acknowledged: null, receipt: null } });
    const ids = Object.keys(JSON.parse(readFileSync(join(env.userData, REMOTE_CREDENTIALS_FILE), 'utf8')));
    expect(ids).toEqual([(rebound as { state: { binding: { id: string } } }).state.binding.id]);
    expect(ids).not.toContain((before as { state: { binding: { id: string } } }).state.binding.id);
    expect(await c.bindRemote({ url: 'http://example.com/site.git', username: USER, token: TOKEN })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await c.bindRemote({ url: `https://${USER}:${TOKEN}@example.com/site.git`, username: USER, token: TOKEN })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await c.unbindRemote()).toEqual({ ok: true, state: null });
    expect(existsSync(join(dir, REMOTE_STATE_FILE))).toBe(false);
    expect(JSON.parse(readFileSync(join(env.userData, REMOTE_CREDENTIALS_FILE), 'utf8'))).toEqual({});
    expect(await c.pushPublication()).toMatchObject({ ok: false, code: 'not-bound' });
  });
});

function dirname(p: string) {
  return p.slice(0, p.lastIndexOf('/'));
}
