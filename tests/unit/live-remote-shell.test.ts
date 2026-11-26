/**
 * The remote shell end to end, below the editor (#766): a host's Controller opens a project and hosts a live session;
 * a second app's guest manager joins it from the invite link through the relay in Cloudflare's local simulator, is
 * let in as a collaborator, reads the host's project and its preview through its own loopback server, and makes
 * edits that land on the host's disk as the guest's own steps. Role changes reach it at once, and leaving, being
 * removed or the host closing the project end it cleanly.
 */
import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveJoinRequest, LiveRun, RemoteState } from '../../src/shared/api';
import type { LiveProjectSnapshot } from '../../src/shared/live/snapshot';
import { randomAddress, startRelay, wait, type Relay } from './relay-harness';

class FakeWorker extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exited = false;
  published: number[] = [];
  postMessage(m: { type: string; id?: string; revision?: number }) {
    if (m.type === 'start') queueMicrotask(() => this.emit('message', { type: 'ready', url: env.previewUrl }));
    if (m.type === 'hold') queueMicrotask(() => this.emit('message', { type: 'held', id: m.id }));
    if (m.type === 'revision')
      queueMicrotask(() => {
        this.published.push(m.revision!);
        this.emit('message', { type: 'published', revision: m.revision });
      });
    if (m.type === 'stop') this.kill();
  }
  kill() {
    if (this.exited) return true;
    this.exited = true;
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }
}

const env = vi.hoisted(() => ({ userData: '', previewUrl: '' }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  utilityProcess: { fork: () => new FakeWorker() }
}));

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { LiveGuestManager } = await import('../../src/main/live/guest');
const { createStarterState } = await import('@catalogue/starters');
const { sha } = await import('../../src/main/project/fsutil');

let relay: Relay;
let relayPort: number;
let vite: Server;
const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-remote-${name}-`)));
  dirs.push(d);
  return d;
};

beforeAll(async () => {
  vite = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>From the host’s preview</title><p>${req.url}</p>`);
  });
  await new Promise<void>((resolve) => vite.listen(0, '127.0.0.1', resolve));
  env.previewUrl = `http://127.0.0.1:${(vite.address() as AddressInfo).port}`;
  relay = await startRelay();
  relayPort = Number(new URL(await relay.origin()).port);
  process.env.SITEORIGIN_LIVE_RELAY_URL = await relay.origin();
}, 60_000);
afterAll(async () => {
  delete process.env.SITEORIGIN_LIVE_RELAY_URL;
  await relay?.dispose();
  await new Promise<void>((resolve) => vite.close(() => resolve()));
});
beforeEach(() => {
  env.userData = temp('userdata');
});
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function makeProject(name: string): Promise<string> {
  const dir = temp(name);
  const created = await ProjectSession.create(dir, createStarterState('blank', name, false));
  await created.close();
  const pkg = '{"name":"site","type":"module"}';
  writeFileSync(join(dir, 'package.json'), pkg);
  writeFileSync(join(dir, 'vite.config.js'), 'export default {};');
  mkdirSync(join(dir, 'node_modules/@sveltejs/kit'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/@sveltejs/kit/package.json'), '{"name":"@sveltejs/kit"}');
  mkdirSync(join(dir, 'node_modules/.bin'));
  symlinkSync('../@sveltejs/kit/package.json', join(dir, 'node_modules/.bin/kit'));
  writeFileSync(join(dir, '.siteorigin/cache/deps.json'), JSON.stringify({ lockHash: sha('' + pkg), preparedAt: '2026-01-01T00:00:00.000Z' }));
  return dir;
}

async function until<T>(check: () => T | undefined | null | false, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await wait(10);
  }
}

/** The host: a Controller with its project open, its preview running, and a live session started. */
async function host() {
  const c = new Controller(() => null);
  const sent: Array<[string, unknown]> = [];
  c.send = (channel: string, payload?: unknown) => void sent.push([channel, payload]);
  const address = randomAddress();
  c.live.createSocket = (url) => new WebSocket(url, { headers: { 'cf-connecting-ip': address } } as never);
  cleanups.push(() => c.close());
  const dir = await makeProject('acme');
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  await until(() => c.snapshot()?.runtime.state === 'ready', 'the preview');
  const started = await c.live.start({ opening: c.snapshot()!.workspaceKey, duration: '2h' });
  if (!started.ok || started.state.phase !== 'active') throw new Error('The live session did not start');
  const run: LiveRun = { workspaceKey: started.state.workspaceKey, runId: started.state.runId };
  // The invite on the relay's own name, as a person pastes it: each room's preview is then its own host under it.
  const invite = `http://relay.localhost:${relayPort}/s/${started.state.roomId}`;
  return { c, sent, dir, run, invite };
}

/** The guest: another app's guest manager, its socket reaching the simulator on loopback. */
function guest() {
  const states: RemoteState[] = [];
  const snapshots: LiveProjectSnapshot[] = [];
  const reloads: Array<number | null> = [];
  const address = randomAddress();
  const manager = new LiveGuestManager(
    {
      emit: (channel: string, payload: unknown) => {
        if (channel === 'remote:state') states.push(payload as RemoteState);
        if (channel === 'remote:changed') snapshots.push((payload as { snapshot: LiveProjectSnapshot }).snapshot);
        if (channel === 'remote:reload') reloads.push((payload as { revision: number | null }).revision);
      }
    },
    { createSocket: (url) => new WebSocket(url.replace('//relay.localhost:', '//127.0.0.1:'), { headers: { 'cf-connecting-ip': address } } as never) }
  );
  cleanups.push(() => manager.dispose());
  return { manager, states, snapshots, reloads, admitted: () => manager.state as Extract<RemoteState, { phase: 'admitted' }> };
}

/** A page of the host's preview, asked of the guest's loopback server as the editor's window asks it. */
function viaShell(access: { url: string; header: string; secret: string } | null, path = '/', secret = true): Promise<{ status: number; body: string }> {
  if (!access) throw new Error('No preview access');
  const u = new URL(access.url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: Number(u.port), path, headers: { host: u.host, ...(secret ? { [access.header]: access.secret } : {}) } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Join, and be let in by the host as `role`. */
async function joined(h: Awaited<ReturnType<typeof host>>, g: ReturnType<typeof guest>, role: 'viewer' | 'collaborator') {
  const asked = await g.manager.join({ inviteLink: h.invite, displayName: 'Sarah' });
  if (!asked.ok) throw new Error(asked.message);
  expect(asked.state.phase).toBe('waiting');
  const request = await until(() => h.sent.find(([ch, p]) => ch === 'live:request' && (p as LiveJoinRequest).displayName === 'Sarah')?.[1] as LiveJoinRequest | undefined, 'the join request');
  expect(h.c.live.admit(h.run, request.guestId, role)).toEqual({ ok: true });
  await until(() => g.manager.state.phase === 'admitted' && g.snapshots.length > 0, 'the host’s project');
  await until(() => g.manager.previewAccess, 'the preview');
  return request.guestId;
}

describe('the remote shell', () => {
  it('joins as a collaborator, shows the host’s project and preview, and edits it through the host', async () => {
    const h = await host();
    const g = guest();
    const guestId = await joined(h, g, 'collaborator');
    const home = h.c.session!.state.site.homePageId;
    expect(g.admitted()).toMatchObject({ role: 'collaborator', projectName: 'acme', hostConnected: true, hostRuntime: 'ready' });

    // The host's project, as guests are given it: nothing of the host's computer in it.
    const first = g.snapshots.at(-1)!;
    expect(first.revision).toBe(h.c.session!.revision);
    expect(first.state.pages[home].title).toBe(h.c.session!.state.pages[home].title);
    expect(JSON.stringify(first)).not.toContain(h.dir);
    expect(JSON.stringify(first)).not.toContain(homedir());

    // The host's preview, through the relay, from the guest's own loopback server: to the editor's window alone.
    expect(await viaShell(g.manager.previewAccess, '/about/')).toEqual({ status: 200, body: '<!doctype html><title>From the host’s preview</title><p>/about/</p>' });
    expect((await viaShell(g.manager.previewAccess, '/', false)).status).toBe(403);

    // A collaborator's edit lands on the host's disk, as the guest's step, and comes back to the guest.
    const before = h.c.session!.revision;
    const edit = await g.manager.apply(g.admitted().joinId, { operations: [{ type: 'page.update', pageId: home, title: 'Fresh bread daily' }], expectedRevision: before, label: 'Rename page' });
    expect(edit).toMatchObject({ ok: true, revision: before + 1 });
    expect(h.c.session!.state.pages[home].title).toBe('Fresh bread daily');
    expect(readFileSync(join(h.dir, `siteorigin/pages/${home}.json`), 'utf8')).toContain('Fresh bread daily');
    expect(h.c.snapshot()!.history.entries.at(-1)).toMatchObject({ label: 'Rename page (Sarah)', guestName: 'Sarah' });
    await until(() => g.snapshots.some((s) => s.revision === before + 1 && s.state.pages[home].title === 'Fresh bread daily'), 'the change back at the guest');
    // The guest is told to reload once the host's preview has it, and which revision a page loaded now shows.
    await until(() => g.reloads.some((r) => r !== null && r >= before + 1), 'the reload');

    // The host's own edit reaches the guest too.
    expect((await h.c.apply({ operations: [{ type: 'page.update', pageId: home, seoTitle: 'Bread, baked daily' }] })).ok).toBe(true);
    await until(() => g.snapshots.at(-1)?.state.pages[home].seo.title === 'Bread, baked daily', 'the host’s change');

    // Made a viewer, the guest edits nothing, at once; made a collaborator again, it edits again.
    expect(h.c.live.setRole(h.run, guestId, 'viewer')).toEqual({ ok: true });
    await until(() => g.admitted().role === 'viewer', 'the demotion');
    expect(await g.manager.apply(g.admitted().joinId, { operations: [{ type: 'page.update', pageId: home, title: 'Not allowed' }] })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(h.c.live.setRole(h.run, guestId, 'collaborator')).toEqual({ ok: true });
    await until(() => g.admitted().role === 'collaborator', 'the promotion');
    // The cookie of the new grant is in place again for the preview.
    for (let i = 0; i < 200 && (await viaShell(g.manager.previewAccess)).status !== 200; i++) await wait(20);
    expect((await viaShell(g.manager.previewAccess)).status).toBe(200);
    expect((await g.manager.apply(g.admitted().joinId, { operations: [{ type: 'page.update', pageId: home, title: 'Fresh bread' }] })).ok).toBe(true);
    expect(h.c.session!.state.pages[home].title).toBe('Fresh bread');

    // Leaving gives the place up at once: the host's roster no longer lists the guest.
    g.manager.leave();
    expect(g.manager.state).toMatchObject({ phase: 'idle', ended: { reason: 'left' } });
    await until(() => !(h.c.live.state as { participants?: Array<{ guestId: string }> }).participants?.some((p) => p.guestId === guestId), 'the guest gone from the roster', 4000);
  });

  it('ends at once when the host removes the guest, and its preview goes with it', async () => {
    const h = await host();
    const g = guest();
    const guestId = await joined(h, g, 'viewer');
    const access = g.manager.previewAccess;
    expect(h.c.live.kick(h.run, guestId)).toEqual({ ok: true });
    await until(() => g.manager.state.phase === 'idle', 'the end');
    expect(g.manager.state).toMatchObject({ ended: { reason: 'kicked', message: 'The host removed you from the live session.' } });
    expect(g.manager.previewAccess).toBeNull();
    await expect(viaShell(access)).rejects.toThrow();
  });

  it('ends when the host closes its project', async () => {
    const h = await host();
    const g = guest();
    await joined(h, g, 'collaborator');
    expect(await h.c.closeProject()).toEqual({ ok: true });
    await until(() => g.manager.state.phase === 'idle', 'the end');
    expect(g.manager.state).toMatchObject({ ended: { reason: 'ended', message: 'The host ended the live session.' } });
  });
});
