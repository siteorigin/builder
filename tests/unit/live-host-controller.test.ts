/**
 * A live session belongs to the project opening it was started in (#762): the Controller ends it when that project is
 * closed or another is opened in its place, keeps it when a switch is called off, serves its guests the project's own
 * preview, and has them reload when a change is saved. Run against the relay in Cloudflare's local simulator.
 */
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveHostState, LiveJoinRequest, LiveRun } from '../../src/shared/api';
import { joinGuest, previewOrigin, randomAddress, redeemTicket, startRelay, wait, type Relay } from './relay-harness';

/** A stand-in for Electron's utility process that reports the test's preview server as ready, and exits when asked to stop. */
class FakeWorker extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exited = false;
  postMessage(m: { type: string }) {
    if (m.type === 'start') queueMicrotask(() => this.emit('message', { type: 'ready', url: env.previewUrl }));
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
const { createStarterState } = await import('@catalogue/starters');
const { sha } = await import('../../src/main/project/fsutil');

let relay: Relay;
let vite: Server;
const dirs: string[] = [];
const controllers: InstanceType<typeof Controller>[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-live-${name}-`)));
  dirs.push(d);
  return d;
};

beforeAll(async () => {
  vite = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>From the project preview</title>');
  });
  await new Promise<void>((resolve) => vite.listen(0, '127.0.0.1', resolve));
  env.previewUrl = `http://127.0.0.1:${(vite.address() as AddressInfo).port}`;
  relay = await startRelay();
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
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** A project with its website tools in place, as the app leaves it once the preview has run. */
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

function controller() {
  const c = new Controller(() => null);
  const sent: Array<[string, unknown]> = [];
  c.send = (channel: string, payload?: unknown) => void sent.push([channel, payload]);
  // Each controller connects from its own address, so the relay's limit on new rooms per address never bites here.
  const address = randomAddress();
  c.live.createSocket = (url) => new WebSocket(url, { headers: { 'cf-connecting-ip': address } } as never);
  controllers.push(c);
  return { c, sent };
}

async function until<T>(check: () => T | undefined | null | false, what: string, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await wait(10);
  }
}

/** Open `dir` with its preview running, start a live session in it, and let one guest in with a preview cookie. */
async function hosting(c: InstanceType<typeof Controller>, sent: Array<[string, unknown]>, dir: string) {
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  await until(() => c.snapshot()?.runtime.state === 'ready', 'the preview');
  const opening = c.snapshot()!.workspaceKey;
  const started = await c.live.start({ opening, duration: '2h' });
  if (!started.ok) throw new Error(started.message);
  const state = started.state as Extract<LiveHostState, { phase: 'active' }>;
  const run: LiveRun = { workspaceKey: state.workspaceKey, runId: state.runId };
  expect(state.workspaceKey).toBe(opening);
  expect(started.inviteUrl).toBe(`${process.env.SITEORIGIN_LIVE_RELAY_URL}/s/${state.roomId}`);
  const guest = await joinGuest(relay, state.roomId, 'Ann');
  // The editor hears the guest ask, then lets it in.
  await until(() => sent.find(([ch, p]) => ch === 'live:request' && (p as LiveJoinRequest).guestId === guest.guestId), 'the join request');
  expect(c.live.admit(run, guest.guestId, 'viewer')).toEqual({ ok: true });
  const status = await guest.guest.next('guest:status');
  if (status.status !== 'admitted') throw new Error(`Expected to be admitted, got ${status.status}`);
  const cookie = (await redeemTicket(relay, state.roomId, status.previewTicket)).cookie!;
  return { state, run, guest, cookie };
}

describe('a live session hosted by the open project', () => {
  it('serves guests the project’s own preview and has them reload when a change is saved', async () => {
    const dir = await makeProject('acme');
    const { c, sent } = controller();
    const { state, guest, cookie } = await hosting(c, sent, dir);
    const page = await relay.fetch(`${await previewOrigin(state.roomId)}/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('From the project preview');
    // A save reaches the preview, and the guests reload to see it.
    const home = c.session!.state.site.homePageId;
    expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, seoTitle: 'Fresh bread daily' }] })).ok).toBe(true);
    await guest.guest.next('preview:reload');
    // The editor was told of every change to the session.
    expect(sent.some(([ch, p]) => ch === 'live:state' && (p as LiveHostState).phase === 'active')).toBe(true);
  });

  it('ends for everyone when its project is closed', async () => {
    const dir = await makeProject('acme');
    const { c, sent } = controller();
    const { state, guest } = await hosting(c, sent, dir);
    expect(await c.closeProject()).toEqual({ ok: true });
    expect(await guest.guest.next('guest:status')).toEqual({ type: 'guest:status', status: 'ended' });
    expect(c.live.state.phase).toBe('idle');
    expect((await relay.fetch(`/s/${state.roomId}/ws`, { headers: { upgrade: 'websocket' } })).status).toBe(404);
    // The editor was told before the project was gone.
    const idleAt = sent.findIndex(([ch, p]) => ch === 'live:state' && (p as LiveHostState).phase === 'idle');
    expect(idleAt).toBeGreaterThan(-1);
    expect(idleAt).toBeLessThan(sent.findIndex(([ch]) => ch === 'project:closed'));
  });

  it('ends when another project is opened in its place, which starts with none', async () => {
    const current = await makeProject('current');
    const next = await makeProject('next');
    const { c, sent } = controller();
    const { state, guest } = await hosting(c, sent, current);
    expect((await c.trustAndOpen(next)).ok).toBe(true);
    expect(c.session?.dir).toBe(next);
    expect(await guest.guest.next('guest:status')).toEqual({ type: 'guest:status', status: 'ended' });
    expect(c.live.state.phase).toBe('idle');
    expect((await relay.fetch(`/s/${state.roomId}/ws`, { headers: { upgrade: 'websocket' } })).status).toBe(404);
  });

  it('carries on when a switch to another project is called off', async () => {
    const current = await makeProject('current');
    const next = await makeProject('next');
    const { c, sent } = controller();
    const { state, run, guest } = await hosting(c, sent, current);
    // The author chooses to keep editing a change that cannot be saved.
    c.beforeLeave = async () => false;
    expect((await c.trustAndOpen(next)).ok).toBe(false);
    expect(c.session?.dir).toBe(current);
    expect(c.live.state).toMatchObject({ phase: 'active', roomId: state.roomId });
    expect(guest.guest.has('guest:status')).toBe(false);
    expect(c.live.setLocked(run, true)).toEqual({ ok: true });
    await until(() => (c.live.state as { locked?: boolean }).locked, 'the room locked');
  });
});
