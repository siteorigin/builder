/**
 * Pushing a publication to a host (#1157), through the real Git client and worker service (in this process) to a
 * disposable HTTPS Git host (stock Git's http-backend behind Node's HTTPS server, https-git-server.ts): the first push
 * and the next, a push the host already has, a refused credential, a redirect to another address, a host whose branch
 * went its own way, a reply lost after the host took the push, and a commit that is not the publication's.
 *
 * Skipped where stock Git or openssl is missing, except on CI, where both must be there.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitClient, type GitWorkerHandle } from '../../src/main/git/client';
import { createGitService } from '../../src/main/git/service';
import { openRepo } from '../../src/main/git/repo';
import { GitError, PUBLISH_BRANCH, VERSIONS_BRANCH, type FileInput, type Identity, type RemoteTarget } from '../../src/main/git/protocol';
import { HOST_AVAILABLE, startGitHost, type GitHost } from './https-git-server';

const APP: Identity = { name: 'SiteOrigin Builder', email: 'publish@siteorigin.invalid', timestamp: 1_790_000_000, timezoneOffset: 0 };
const USER = 'publisher';
const TOKEN = 'tok_8f2b6c1d9e7a4053b1c2';
const text = (s: string) => new TextEncoder().encode(s);

let root: string;
const hosts: GitHost[] = [];
const clients: Array<ReturnType<typeof createGitClient>> = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'so-remote-push-'));
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  for (const h of hosts.splice(0)) await h.close();
  rmSync(root, { recursive: true, force: true });
});

/** The worker's service in this process behind the real client, trusting the hosts' certificate. */
function client(ca: string) {
  const c = createGitClient(() => {
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
  clients.push(c);
  return c;
}

async function host() {
  const h = await startGitHost({ username: USER, password: TOKEN, ...(hosts[0] ? { certs: hosts[0].certs } : {}) });
  hosts.push(h);
  return h;
}

const target = (h: GitHost, auth: RemoteTarget['auth'] = { username: USER, password: TOKEN }): RemoteTarget => ({ url: h.url, ref: PUBLISH_BRANCH, auth });

/** A publication of `files` after `parent`, the branch moved to it. */
async function publish(files: Record<string, string>, parent: string | null) {
  const repo = openRepo(root);
  await repo.init();
  const tree = await repo.writeFiles(Object.entries(files).map(([path, body]): FileInput => ({ path, bytes: text(body) })));
  const commit = await repo.writeCommit({ tree, parents: parent ? [parent] : [], author: APP, committer: APP, message: 'Publish the website\n' });
  await repo.advanceRef(PUBLISH_BRANCH, commit, parent);
  return commit;
}

/** Every file of the versions repository with its bytes, to show a push wrote nothing there. */
function repoFiles() {
  const gitdir = join(root, '.siteorigin', 'versions.git');
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(gitdir, p)] = readFileSync(p).toString('base64');
    }
  };
  walk(gitdir);
  return out;
}

const pushes = (h: GitHost) => h.requests.filter((r) => r.method === 'POST');

describe.skipIf(!HOST_AVAILABLE && !process.env.CI)('pushing a publication to an HTTPS Git host', { timeout: 30_000 }, () => {
  it('sends the first publication and then only what the next one adds, writing nothing in the versions repository', async () => {
    const h = await host();
    const git = client(h.ca);
    const first = await publish({ 'README.md': '# Bookshop\n', 'static/a.txt': 'shelf' }, null);
    const before = repoFiles();
    expect(await git.push(root, target(h), first)).toEqual({ previous: null, uploaded: true });
    expect(h.git(['rev-parse', PUBLISH_BRANCH]).trim()).toBe(first);
    expect(h.git(['for-each-ref', '--format=%(refname)']).trim().split('\n')).toEqual([PUBLISH_BRANCH]);
    expect(repoFiles(), 'no remote branch, config or anything else is written locally').toEqual(before);

    const second = await publish({ 'README.md': '# Bookshop\n', 'static/a.txt': 'shelf', 'static/b.txt': 'new page' }, first);
    const objectsBefore = new Set(h.git(['rev-list', '--objects', '--all']).trim().split('\n').map((l) => l.split(' ')[0]));
    expect(await git.push(root, target(h), second)).toEqual({ previous: first, uploaded: true });
    expect(h.git(['rev-parse', PUBLISH_BRANCH]).trim()).toBe(second);
    const added = h.git(['rev-list', '--objects', `${first}..${second}`]).trim().split('\n').map((l) => l.split(' ')[0]);
    expect(added.every((oid) => !objectsBefore.has(oid))).toBe(true);
    h.git(['fsck', '--strict', '--no-dangling']);

    // Pushed again: the host has it, so nothing is sent.
    const posts = pushes(h).length;
    expect(await git.push(root, target(h), second)).toEqual({ previous: second, uploaded: false });
    expect(pushes(h)).toHaveLength(posts);
    expect(await git.remoteTip(target(h))).toBe(second);
  });

  it('gives the credential only after the host asks for it, and stops when the host refuses it', async () => {
    const h = await host();
    const git = client(h.ca);
    const commit = await publish({ 'index.html': 'hi' }, null);
    await expect(git.push(root, target(h, { username: USER, password: 'tok_wrong_wrong_wrong' }), commit)).rejects.toMatchObject({ code: 'auth-rejected' });
    await expect(git.push(root, target(h, null), commit)).rejects.toMatchObject({ code: 'auth-rejected' });
    await expect(git.remoteTip(target(h, null))).rejects.toMatchObject({ code: 'auth-rejected' });
    expect(h.git(['for-each-ref']).trim()).toBe('');
    expect(h.requests.length).toBeGreaterThan(0);
    expect(h.requests[0].authorization, 'the first request carries no credential').toBeNull();
    expect(pushes(h)).toEqual([]);
  });

  it('never follows a redirect, to another address or its own, and sends that address nothing', async () => {
    const h = await host();
    const elsewhere = await host();
    const git = client(h.ca);
    const commit = await publish({ 'index.html': 'hi' }, null);
    h.redirectNext = elsewhere.origin;
    await expect(git.push(root, target(h), commit)).rejects.toMatchObject({ code: 'redirect-refused' });
    expect(elsewhere.requests).toEqual([]);
    h.redirectNext = h.origin;
    await expect(git.push(root, target(h), commit)).rejects.toMatchObject({ code: 'redirect-refused' });
    expect(h.requests.every((r) => r.authorization === null)).toBe(true);
    expect(h.git(['for-each-ref']).trim()).toBe('');
  });

  it('leaves a host whose branch went its own way as it is, saying where it is', async () => {
    const h = await host();
    const git = client(h.ca);
    const first = await publish({ 'index.html': 'one' }, null);
    await git.push(root, target(h), first);
    // Someone else published to the host meanwhile.
    const blob = h.git(['hash-object', '-w', '--stdin'], 'theirs').trim();
    const tree = h.git(['mktree'], `100644 blob ${blob}\tindex.html\n`).trim();
    const theirs = h.git(['commit-tree', tree, '-p', first, '-m', 'Theirs']).trim();
    h.git(['update-ref', PUBLISH_BRANCH, theirs, first]);
    const second = await publish({ 'index.html': 'two' }, first);
    const err = await git.push(root, target(h), second).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(err).toMatchObject({ code: 'diverged', actual: theirs });
    expect(h.git(['rev-parse', PUBLISH_BRANCH]).trim(), 'nothing of theirs was lost').toBe(theirs);
    expect(await openRepo(root).resolveRef(PUBLISH_BRANCH)).toBe(second);
  });

  it('says a push whose reply was lost after the host took it is unknown, which the host’s branch then settles', async () => {
    const h = await host();
    const git = client(h.ca);
    const commit = await publish({ 'index.html': 'hi' }, null);
    h.dropNextPushReply = true;
    await expect(git.push(root, target(h), commit)).rejects.toMatchObject({ code: 'outcome-unknown' });
    expect(await git.remoteTip(target(h))).toBe(commit);
  });

  it('pushes only the publication branch’s commit: never a saved version’s, nor an earlier publication', async () => {
    const h = await host();
    const git = client(h.ca);
    const repo = openRepo(root);
    await repo.init();
    const tree = await repo.writeFiles([{ path: 'siteorigin/pages/draft.json', bytes: text('{"title":"Embargoed"}') }]);
    const saved = await repo.writeCommit({ tree, parents: [], author: APP, committer: APP, message: 'Saved\n' });
    await repo.advanceRef(VERSIONS_BRANCH, saved, null);
    await expect(git.push(root, target(h), saved)).rejects.toMatchObject({ code: 'conflict', actual: null });
    const first = await publish({ 'index.html': 'one' }, null);
    await publish({ 'index.html': 'two' }, first);
    await expect(git.push(root, target(h), first)).rejects.toMatchObject({ code: 'conflict' });
    expect(h.requests, 'refused before anything was sent').toEqual([]);
  });

  it('refuses an address that is not plain HTTPS, or carries a credential, before anything is sent', async () => {
    const h = await host();
    const git = client(h.ca);
    const commit = await publish({ 'index.html': 'hi' }, null);
    for (const url of [h.url.replace('https:', 'http:'), h.url.replace('https://', `https://${USER}:${TOKEN}@`), `${h.url}?x=1`, `${h.url}/`])
      await expect(git.push(root, { url, ref: PUBLISH_BRANCH, auth: null }, commit)).rejects.toMatchObject({ code: 'invalid' });
    await expect(git.push(root, { url: h.url, ref: VERSIONS_BRANCH as typeof PUBLISH_BRANCH, auth: null }, commit)).rejects.toMatchObject({ code: 'invalid' });
    expect(h.requests).toEqual([]);
  });
});
