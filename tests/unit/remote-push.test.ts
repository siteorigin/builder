/**
 * Pushing a publication to a host (#1157), through the real Git client and worker service (in this process) to a
 * disposable HTTPS Git host (stock Git's http-backend behind Node's HTTPS server, https-git-server.ts): the first push
 * and the next, a push the host already has, a refused credential, a redirect to another address, a host whose branch
 * went its own way, a reply lost after the host took the push, and a commit that is not the publication's.
 *
 * Skipped where stock Git or openssl is missing, except on CI, where both must be there.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitClient, type GitWorkerHandle } from '../../src/main/git/client';
import { createGitService } from '../../src/main/git/service';
import { openRepo } from '../../src/main/git/repo';
import { readOnly } from '../../src/main/git/remote';
import { readRemoteState, writeRemoteState } from '../../src/main/remote/binding';
import { GitError, PUBLISH_BRANCH, VERSIONS_BRANCH, type FileInput, type Identity, type RemoteTarget } from '../../src/main/git/protocol';
import { httpsGitTransport, type PushRequest, type RemoteGit } from '../../src/main/remote/transport';
import { createRemoteCredentialStore } from '../../src/main/remote/credentials';
import { HOST_AVAILABLE, startGitHost, type GitHost } from './https-git-server';

const APP: Identity = { name: 'SiteOrigin Builder', email: 'publish@siteorigin.invalid', timestamp: 1_790_000_000, timezoneOffset: 0 };
/** Who a saved version is by (versions-git.ts). */
const SAVED: Identity = { ...APP, email: 'versions@siteorigin.invalid' };
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
    // A picture that does not compress, so what each push carries shows in its size.
    const photo = randomBytes(200_000).toString('base64');
    const first = await publish({ 'README.md': '# Bookshop\n', 'static/photo.txt': photo }, null);
    const before = repoFiles();
    expect(await git.push(root, target(h), first)).toEqual({ previous: null, uploaded: true });
    expect(h.git(['rev-parse', PUBLISH_BRANCH]).trim()).toBe(first);
    // Asked first without a credential, given it once the host asks, and the push itself signed in.
    const auth = `Basic ${Buffer.from(`${USER}:${TOKEN}`).toString('base64')}`;
    expect(h.requests.map((r) => [r.method, r.path, r.authorization])).toEqual([
      ['GET', '/site.git/info/refs?service=git-receive-pack', null],
      ['GET', '/site.git/info/refs?service=git-receive-pack', auth],
      ['POST', '/site.git/git-receive-pack', auth]
    ]);
    expect(pushes(h)[0].bytes).toBeGreaterThan(200_000);
    expect(h.git(['for-each-ref', '--format=%(refname)']).trim().split('\n')).toEqual([PUBLISH_BRANCH]);
    expect(repoFiles(), 'no remote branch, config or anything else is written locally').toEqual(before);

    const second = await publish({ 'README.md': '# Bookshop\n', 'static/photo.txt': photo, 'static/b.txt': 'new page' }, first);
    expect(await git.push(root, target(h), second)).toEqual({ previous: first, uploaded: true });
    expect(h.git(['rev-parse', PUBLISH_BRANCH]).trim()).toBe(second);
    // Only the new commit, its trees and the new page: the picture the host has is not sent again.
    expect(pushes(h)[1].bytes).toBeLessThan(10_000);
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
    // To another repository on the same host: nothing is sent there either.
    const seen = h.requests.length;
    h.redirectNext = `${h.origin}/other`;
    await expect(git.push(root, target(h), commit)).rejects.toMatchObject({ code: 'redirect-refused' });
    expect(h.requests.slice(seen).map((r) => r.path)).toEqual(['/site.git/info/refs?service=git-receive-pack']);
    expect(h.requests.every((r) => r.authorization === null)).toBe(true);
    // Once signed in, a redirect is refused all the same, and nothing is pushed.
    const signed = h.requests.length;
    const realRequest = h.requests.push.bind(h.requests);
    h.requests.push = (...r) => {
      const n = realRequest(...r);
      if (r.some((x) => x.authorization !== null)) h.redirectNext = elsewhere.origin;
      return n;
    };
    await expect(git.push(root, target(h), commit)).rejects.toMatchObject({ code: 'redirect-refused' });
    h.requests.push = realRequest;
    expect(h.requests.slice(signed).map((r) => [r.method, r.authorization !== null])).toEqual([
      ['GET', false],
      ['GET', true]
    ]);
    expect(elsewhere.requests).toEqual([]);
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
    const posts = pushes(h).length;
    const err = await git.push(root, target(h), second).catch((e: unknown) => e);
    expect(pushes(h), 'nothing is sent to a host known to have gone its own way').toHaveLength(posts);
    expect(err).toBeInstanceOf(GitError);
    expect(err).toMatchObject({ code: 'diverged', actual: theirs });
    expect(h.git(['rev-parse', PUBLISH_BRANCH]).trim(), 'nothing of theirs was lost').toBe(theirs);
    expect(await openRepo(root).resolveRef(PUBLISH_BRANCH)).toBe(second);
  });

  it('tells the host’s own refusal from another push that landed between its list of branches and this push', async () => {
    const h = await host();
    const git = client(h.ca);
    const first = await publish({ 'index.html': 'one' }, null);
    await git.push(root, target(h), first);
    const second = await publish({ 'index.html': 'two' }, first);
    // A hook of the host's refuses it.
    writeFileSync(join(h.bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "protected by policy" >&2\nexit 1\n', { mode: 0o755 });
    const refused = (await git.push(root, target(h), second).catch((e: unknown) => e)) as GitError;
    expect(refused).toMatchObject({ code: 'rejected' });
    expect(refused.message, 'nothing the host said is passed on').not.toContain('policy');
    expect(h.git(['rev-parse', PUBLISH_BRANCH]).trim()).toBe(first);
    rmSync(join(h.bare, 'hooks', 'pre-receive'));
    // Someone else's push lands after the host listed its branches and before this push reaches it.
    let theirs = '';
    h.beforeNextPush = () => {
      const blob = h.git(['hash-object', '-w', '--stdin'], 'theirs').trim();
      const tree = h.git(['mktree'], `100644 blob ${blob}\tindex.html\n`).trim();
      theirs = h.git(['commit-tree', tree, '-p', first, '-m', 'Theirs']).trim();
      h.git(['update-ref', PUBLISH_BRANCH, theirs, first]);
    };
    const moved = await git.push(root, target(h), second).catch((e: unknown) => e);
    expect(moved).toMatchObject({ code: 'diverged', actual: theirs });
    expect(h.git(['rev-parse', PUBLISH_BRANCH]).trim()).toBe(theirs);
    // Deleted meanwhile instead: nothing of anyone's is lost, and pushing again makes it.
    h.git(['update-ref', PUBLISH_BRANCH, first, theirs]);
    h.beforeNextPush = () => void h.git(['update-ref', '-d', PUBLISH_BRANCH]);
    await expect(git.push(root, target(h), second)).rejects.toMatchObject({ code: 'conflict', actual: null });
    expect(await git.push(root, target(h), second)).toEqual({ previous: null, uploaded: true });
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
    const saved = await repo.writeCommit({ tree, parents: [], author: SAVED, committer: SAVED, message: 'Saved\n' });
    await repo.advanceRef(VERSIONS_BRANCH, saved, null);
    await expect(git.push(root, target(h), saved)).rejects.toMatchObject({ code: 'conflict', actual: null });
    const first = await publish({ 'index.html': 'one' }, null);
    const second = await publish({ 'index.html': 'two' }, first);
    await expect(git.push(root, target(h), first)).rejects.toMatchObject({ code: 'conflict', actual: second });
    expect(h.requests, 'refused before anything was sent').toEqual([]);
  });

  it('refuses an address that is not plain HTTPS, or carries a credential, before anything is sent', async () => {
    const h = await host();
    const git = client(h.ca);
    const commit = await publish({ 'index.html': 'hi' }, null);
    for (const url of [h.url.replace('https:', 'http:'), h.url.replace('https://', `https://${USER}:${TOKEN}@`), `${h.url}?x=1`, `${h.url}/`])
      await expect(git.push(root, { url, ref: PUBLISH_BRANCH, auth: null }, commit)).rejects.toMatchObject({ code: 'invalid' });
    await expect(git.push(root, { url: h.url, ref: VERSIONS_BRANCH as typeof PUBLISH_BRANCH, auth: null }, commit)).rejects.toMatchObject({ code: 'invalid' });
    for (const auth of [{ username: 'a:b', password: TOKEN }, { username: USER, password: '' }, { username: USER, password: `${TOKEN}\nX-Evil: 1` }])
      await expect(git.push(root, target(h, auth), commit)).rejects.toMatchObject({ code: 'invalid' });
    expect(h.requests).toEqual([]);
  });

  it('signs in for the push itself to a host that lets anyone list its branches', async () => {
    const h = await startGitHost({ username: USER, password: TOKEN, signInToPushOnly: true });
    hosts.push(h);
    const git = client(h.ca);
    const commit = await publish({ 'index.html': 'hi' }, null);
    expect(await git.push(root, target(h), commit)).toEqual({ previous: null, uploaded: true });
    expect(h.requests.map((r) => [r.method, r.authorization !== null])).toEqual([
      ['GET', false],
      ['POST', false],
      ['POST', true]
    ]);
    expect(h.git(['rev-parse', PUBLISH_BRANCH]).trim()).toBe(commit);
    // Without a credential, the push is refused and nothing lands.
    const second = await publish({ 'index.html': 'two' }, commit);
    await expect(git.push(root, target(h, null), second)).rejects.toMatchObject({ code: 'auth-rejected' });
    expect(h.git(['rev-parse', PUBLISH_BRANCH]).trim()).toBe(commit);
  });

  it('says a host that drops the connection before answering could not be reached, and moved nothing', async () => {
    const h = await host();
    const git = client(h.ca);
    const commit = await publish({ 'index.html': 'hi' }, null);
    h.resetNext = true;
    await expect(git.push(root, target(h), commit)).rejects.toMatchObject({ code: 'unreachable' });
    expect(pushes(h)).toEqual([]);
  });

  it('looks for the publication branch by its exact name, never a longer one sharing its start', async () => {
    const h = await host();
    const git = client(h.ca);
    const first = await publish({ 'index.html': 'one' }, null);
    await git.push(root, target(h), first);
    h.git(['update-ref', `${PUBLISH_BRANCH}-extra`, first]);
    h.git(['update-ref', '-d', PUBLISH_BRANCH]);
    expect(await git.remoteTip(target(h))).toBeNull();
    // Pushed again, it makes the branch itself and leaves the other as it was.
    expect(await git.push(root, target(h), first)).toEqual({ previous: null, uploaded: true });
    expect(h.git(['for-each-ref', '--format=%(refname)']).trim().split('\n').sort()).toEqual([PUBLISH_BRANCH, `${PUBLISH_BRANCH}-extra`]);
  });

  it('never sends a saved version’s history, even with the publication branch pointed at it some other way', async () => {
    const h = await host();
    const git = client(h.ca);
    const repo = openRepo(root);
    await repo.init();
    const tree = await repo.writeFiles([{ path: 'siteorigin/pages/draft.json', bytes: text('{"title":"Embargoed"}') }]);
    const saved = await repo.writeCommit({ tree, parents: [], author: SAVED, committer: SAVED, message: 'Saved\n' });
    await repo.advanceRef(PUBLISH_BRANCH, saved, null);
    await expect(git.push(root, target(h), saved)).rejects.toMatchObject({ code: 'invalid' });
    // A publication after it still holds it in its history.
    const after = await publish({ 'index.html': 'hi' }, saved);
    await expect(git.push(root, target(h), after)).rejects.toMatchObject({ code: 'invalid' });
    expect(pushes(h)).toEqual([]);
    expect(h.git(['count-objects', '-v'])).toMatch(/^count: 0$/m);
    // A commit made by a publication's author but committed as a saved version is not one either.
    const repo2 = openRepo(root);
    const mixed = await repo2.writeCommit({ tree, parents: [], author: APP, committer: SAVED, message: 'Publish the website\n' });
    await repo2.advanceRef(PUBLISH_BRANCH, mixed, after);
    await expect(git.push(root, target(h), mixed)).rejects.toMatchObject({ code: 'invalid' });
    expect(pushes(h)).toEqual([]);
  });

  it('never sends the token it signs in with, in the publication sent or anywhere in its history', async () => {
    const h = await host();
    const git = client(h.ca);
    // Prepared before the host's credential was saved, so preparing could not look for it.
    const leaky = await publish({ 'index.html': `<p>deploy key ${TOKEN}</p>`, 'static/photo.bin': '\0binary' }, null);
    await expect(git.push(root, target(h), leaky)).rejects.toMatchObject({ code: 'invalid', message: expect.not.stringContaining(TOKEN) });
    const clean = await publish({ 'index.html': '<p>hello</p>' }, leaky);
    await expect(git.push(root, target(h), clean), 'the history sent still holds it').rejects.toMatchObject({ code: 'invalid' });
    expect(pushes(h)).toEqual([]);
    // As an address escapes it, and in a file's name.
    rmSync(join(root, '.siteorigin'), { recursive: true, force: true });
    const odd = { username: USER, password: 'tok/with+plus=1234' };
    const oddHost = await startGitHost({ username: USER, password: odd.password, certs: h.certs });
    hosts.push(oddHost);
    const escaped = await publish({ 'index.html': `<a href="https://x.example/?k=${encodeURIComponent(odd.password)}">x</a>` }, null);
    await expect(git.push(root, target(oddHost, odd), escaped)).rejects.toMatchObject({ code: 'invalid' });
    expect(pushes(oddHost)).toEqual([]);
    rmSync(join(root, '.siteorigin'), { recursive: true, force: true });
    const named = await publish({ [`static/${TOKEN}.txt`]: 'x' }, null);
    await expect(git.push(root, target(h), named)).rejects.toMatchObject({ code: 'invalid' });
    expect(pushes(h)).toEqual([]);
    // A binary file is not searched (a photo's bytes can hold anything), and a clean publication goes.
    rmSync(join(root, '.siteorigin'), { recursive: true, force: true });
    const photo = await publish({ 'static/photo.bin': `\0${TOKEN}`, 'index.html': 'ok' }, null);
    expect(await git.push(root, target(h), photo)).toEqual({ previous: null, uploaded: true });
  });
});

describe('the push’s view of the versions repository (#1157)', () => {
  it('drops the one note a landed push makes, once, and refuses every other write', async () => {
    const calls: string[] = [];
    const record = (name: string) => async () => void calls.push(name);
    const files = Object.fromEntries(['readFile', 'writeFile', 'mkdir', 'rmdir', 'unlink', 'stat', 'lstat', 'readdir', 'readlink', 'symlink', 'chmod'].map((k) => [k, record(k)])) as unknown as Parameters<typeof readOnly>[1];
    const fs = readOnly(join(root, 'versions.git'), files).promises;
    const note = `${join(root, 'versions.git').replace(/\\/g, '/')}/refs/remotes/origin/siteorigin-publish`;
    await expect(fs.writeFile(note, 'x\n')).resolves.toBeUndefined();
    await expect(fs.writeFile(note, 'x\n')).rejects.toMatchObject({ code: 'EROFS' });
    await expect(fs.writeFile(join(root, 'versions.git', 'config'), '')).rejects.toMatchObject({ code: 'EROFS' });
    for (const write of ['mkdir', 'rmdir', 'unlink', 'symlink', 'chmod'] as const) await expect((fs[write] as (p: string) => Promise<void>)(join(root, 'versions.git', 'refs'))).rejects.toMatchObject({ code: 'EROFS' });
    await fs.readFile(join(root, 'versions.git', 'HEAD'));
    expect(calls).toEqual(['readFile']);
  });
});

describe('settling a push whose reply was lost (#1157)', () => {
  const PINNED = 'a'.repeat(40);
  // Sharing all but its last digit with the pinned commit, so only the whole name tells them apart.
  const OLD = `${'a'.repeat(39)}b`;
  const request = (over: Partial<PushRequest> = {}): PushRequest => ({
    endpoint: 'https://git.example/site.git',
    binding: 'rb_0123456789abcdef01234567',
    ref: PUBLISH_BRANCH,
    commit: PINNED,
    credentials: async () => ({ username: USER, token: TOKEN }),
    ...over
  });
  const lostPush = (tip: () => Promise<string | null>) => {
    const looks: unknown[] = [];
    const git: RemoteGit = {
      push: async () => Promise.reject(new GitError('outcome-unknown', 'lost')),
      remoteTip: async (target, opts) => (looks.push({ target, opts }), tip())
    };
    return { git, looks };
  };

  it('takes the push as landed only when the host’s branch is at the pinned commit', async () => {
    const landed = lostPush(async () => PINNED);
    expect(await httpsGitTransport(landed.git, { lookupMs: 50 }).push(root, request())).toEqual({ commit: PINNED, uploaded: true, reconciled: true, receipt: null });
    expect(landed.looks).toEqual([{ target: { url: 'https://git.example/site.git', ref: PUBLISH_BRANCH, auth: { username: USER, password: TOKEN } }, opts: { timeoutMs: 50 } }]);
    // Still where it was, at none, or no answer: the host may yet take it.
    for (const tip of [async () => OLD, async () => null, async () => Promise.reject(new GitError('unreachable', 'down'))])
      await expect(httpsGitTransport(lostPush(tip).git).push(root, request())).rejects.toMatchObject({ code: 'outcome-unknown' });
  });

  it('hands the caller’s signal to the push and to the look that settles it, and stays unknown when stopped while looking', async () => {
    const controller = new AbortController();
    const calls: unknown[] = [];
    const git: RemoteGit = {
      push: async (_root, _target, _commit, opts) => (calls.push(['push', opts?.signal]), Promise.reject(new GitError('outcome-unknown', 'lost'))),
      remoteTip: async (_target, opts) => {
        calls.push(['tip', opts?.signal]);
        controller.abort();
        return PINNED;
      }
    };
    await expect(httpsGitTransport(git).push(root, request({ signal: controller.signal }))).rejects.toMatchObject({ code: 'outcome-unknown' });
    expect(calls).toEqual([
      ['push', controller.signal],
      ['tip', controller.signal]
    ]);
  });

  it('does not look once the caller stopped the push, and never looks after a failure that moved nothing', async () => {
    const stopped = lostPush(async () => PINNED);
    const controller = new AbortController();
    controller.abort();
    await expect(httpsGitTransport(stopped.git).push(root, request({ signal: controller.signal }))).rejects.toMatchObject({ code: 'outcome-unknown' });
    expect(stopped.looks).toEqual([]);
    const looks: unknown[] = [];
    const refused: RemoteGit = { push: async () => Promise.reject(new GitError('auth-rejected', 'no')), remoteTip: async () => (looks.push(1), PINNED) };
    await expect(httpsGitTransport(refused).push(root, request())).rejects.toMatchObject({ code: 'auth-rejected' });
    expect(looks).toEqual([]);
  });

  it('asks for the credential only for the approved address, and refuses any other branch or address first', async () => {
    const asked: string[] = [];
    const git: RemoteGit = { push: async () => ({ previous: null, uploaded: true }), remoteTip: async () => null };
    const t = httpsGitTransport(git);
    await t.push(root, request({ credentials: async (url) => (asked.push(url), null) }));
    expect(asked).toEqual(['https://git.example/site.git']);
    await expect(t.push(root, request({ endpoint: 'https://git.example/site.git/' }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(t.push(root, request({ ref: VERSIONS_BRANCH as typeof PUBLISH_BRANCH }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(t.push(root, request({ commit: 'HEAD' }))).rejects.toMatchObject({ code: 'invalid' });
    expect(asked).toHaveLength(1);
  });
});

describe('the publishing credential store (#1157)', () => {
  const ID = 'rb_0123456789abcdef01234567';
  const owner = () => ({ projectId: 'p_abc', dir: root, url: 'https://git.example/site.git' });

  it('gives a credential out only for the binding, project, folder and address it was kept for, from a file only the user reads', async () => {
    const file = join(root, 'remote-credentials.json');
    const store = createRemoteCredentialStore(() => file);
    await store.set(ID, owner(), { username: ` ${USER} `, token: `${TOKEN}\n` });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await store.resolve(ID, owner())).toEqual({ username: USER, token: TOKEN });
    for (const other of [{ projectId: 'p_other' }, { dir: join(root, 'copy') }, { url: 'https://git.example/other.git' }]) expect(await store.resolve(ID, { ...owner(), ...other })).toBeNull();
    expect(await store.resolve('rb_ffffffffffffffffffffffff', owner())).toBeNull();
    expect(await store.values()).toEqual([TOKEN]);
    await expect(store.set(ID, owner(), { username: 'a:b', token: TOKEN })).rejects.toThrow();
    await expect(store.set(ID, { ...owner(), url: 'http://git.example/site.git' }, { username: USER, token: TOKEN })).rejects.toThrow();
    await expect(store.set('p_abc', owner(), { username: USER, token: TOKEN })).rejects.toThrow();
    await store.forget(ID, owner());
    expect(await store.resolve(ID, owner())).toBeNull();
  });

  it('keeps both of two credentials saved at once, and forgets one only for its own project and folder', async () => {
    const file = join(root, 'remote-credentials.json');
    const store = createRemoteCredentialStore(() => file);
    const other = 'rb_ffffffffffffffffffffffff';
    await Promise.all([store.set(ID, owner(), { username: USER, token: TOKEN }), store.set(other, { ...owner(), projectId: 'p_two' }, { username: USER, token: `${TOKEN}2` })]);
    expect((await store.values()).sort()).toEqual([TOKEN, `${TOKEN}2`]);
    // A copy of the folder elsewhere asks to forget the binding it carries: the original's stays.
    await store.forget(ID, { ...owner(), dir: join(root, 'copy') });
    expect(await store.resolve(ID, owner())).toEqual({ username: USER, token: TOKEN });
    await store.forget(ID, owner());
    expect(await store.resolve(ID, owner())).toBeNull();
    expect(await store.resolve(other, { ...owner(), projectId: 'p_two' })).not.toBeNull();
  });

  it('leaves a damaged file as it is rather than writing over every other credential', async () => {
    const file = join(root, 'remote-credentials.json');
    writeFileSync(file, '{"rb_0123456789abcdef01234567":{"token":1}}');
    const store = createRemoteCredentialStore(() => file);
    await expect(store.resolve(ID, owner())).rejects.toThrow(/damaged/);
    await expect(store.set(ID, owner(), { username: USER, token: TOKEN })).rejects.toThrow(/damaged/);
    await expect(store.values()).rejects.toThrow(/damaged/);
    expect(readFileSync(file, 'utf8')).toBe('{"rb_0123456789abcdef01234567":{"token":1}}');
  });

  it('takes a file with a malformed binding ID for a damaged one, and never reads a remote state through a link out of the project', async () => {
    const file = join(root, 'remote-credentials.json');
    writeFileSync(file, JSON.stringify({ not_a_binding: { ...owner(), username: USER, token: TOKEN } }));
    await expect(createRemoteCredentialStore(() => file).values()).rejects.toThrow(/damaged/);
    const project = join(root, 'project');
    const outside = join(root, 'outside');
    mkdirSync(project);
    mkdirSync(outside);
    const state = { binding: { id: ID, provider: 'https-git' as const, url: 'https://git.example/site.git', site: null }, content: null, acknowledged: null, receipt: null };
    await writeRemoteState(outside, state);
    // A junction on Windows, which needs no administrator to make.
    symlinkSync(join(outside, '.siteorigin'), join(project, '.siteorigin'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readRemoteState(project)).rejects.toThrow(/outside the project/);
    await expect(writeRemoteState(project, state)).rejects.toThrow(/outside the project/);
    await expect(writeRemoteState(project, null)).rejects.toThrow(/outside the project/);
    expect(await readRemoteState(outside)).toEqual(state);
  });
});
