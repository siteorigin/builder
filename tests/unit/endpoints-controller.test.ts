/**
 * The Endpoints panel through the controller (#1481): only with Developer mode on, only in the opening it was asked
 * in, writing nothing in a project open only to look at, sending test requests to the project's own preview alone,
 * and starting the preview again after its environment changes.
 */
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) },
  utilityProcess: { fork: () => new FakeWorker() }
}));

const { createStarterState } = await import('@catalogue/starters');
const { ProjectSession } = await import('../../src/main/project/session');
const { Controller } = await import('../../src/main/controller');
const { updateSettings } = await import('../../src/main/settings');

const dirs: string[] = [];
const controllers: Array<InstanceType<typeof Controller>> = [];
const servers: Server[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-endpoints-ctl-${name}-`)));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  env.userData = temp('userdata');
});
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function opened(dir?: string) {
  const at = dir ?? temp('project');
  if (!dir) await (await ProjectSession.create(at, createStarterState('business', 'Harbour Lane', false))).close();
  const c = new Controller(() => null);
  c.send = () => undefined;
  let restarts = 0;
  c.startRuntime = async () => void restarts++;
  controllers.push(c);
  expect((await c.trustAndOpen(at)).ok).toBe(true);
  await vi.waitFor(() => expect(c.snapshot()).not.toBeNull());
  return { c, dir: at, opening: c.openingKey!, restarts: () => restarts };
}

describe('the Endpoints panel', () => {
  it('needs Developer mode, and the opening it was asked in', async () => {
    const { c, opening } = await opened();
    expect(await c.listEndpoints(opening)).toEqual({ ok: false, message: 'API endpoints are custom code, which needs Developer mode. Turn it on in Settings.' });
    expect(await c.createEndpoint('/api/search', 'ts', opening)).toMatchObject({ ok: false, message: expect.stringContaining('Developer mode') });
    expect(await c.changeEndpointVariable({ name: 'KEY', declare: true }, opening)).toMatchObject({ ok: false, message: expect.stringContaining('Developer mode') });
    await updateSettings({ developerMode: true });
    expect(await c.listEndpoints(opening)).toEqual({ ok: true, endpoints: [] });
    expect(await c.listEndpoints('another opening')).toEqual({ ok: false, message: 'No project is open.' });
    expect(await c.createEndpoint('/api/search', 'ts', 'another opening')).toMatchObject({ ok: false, message: 'No project is open.' });
  });

  it('makes, reads and saves an endpoint in the project', async () => {
    await updateSettings({ developerMode: true });
    const { c, dir, opening } = await opened();
    const made = await c.createEndpoint('/api/search', 'js', opening);
    expect(made).toMatchObject({ ok: true, endpoint: { file: 'src/routes/api/search/+server.js', route: '/api/search' } });
    const read = await c.readEndpoint('src/routes/api/search/+server.js', opening);
    if (!read.ok) throw new Error(read.message);
    expect(await c.saveEndpoint('src/routes/api/search/+server.js', 'export const GET = () => new Response("hi");\n', read.hash, opening)).toMatchObject({ ok: true, endpoint: { methods: ['GET'] } });
    expect(readFileSync(join(dir, 'src/routes/api/search/+server.js'), 'utf8')).toContain('"hi"');
    expect(await c.listEndpoints(opening)).toMatchObject({ ok: true, endpoints: [{ route: '/api/search', methods: ['GET'] }] });
    expect(await c.saveEndpoint('src/routes/+page.svelte', 'x', read.hash, opening)).toMatchObject({ ok: false });
  });

  it('writes nothing in a project open only to look at, while still listing what it has', async () => {
    await updateSettings({ developerMode: true });
    const { c, dir, opening } = await opened();
    expect((await c.createEndpoint('/api/search', 'ts', opening)).ok).toBe(true);
    await c.close();
    // Another window holds the project, so this one opens it read-only.
    writeFileSync(join(dir, '.siteorigin/lock.json'), JSON.stringify({ pid: process.pid, host: hostname(), instance: 'another-window', started: new Date().toISOString() }));
    const viewer = await opened(dir);
    const before = viewer.restarts();
    expect(viewer.c.session?.readOnly).toBeTruthy();
    expect(await viewer.c.listEndpoints(viewer.opening)).toMatchObject({ ok: true, endpoints: [{ route: '/api/search' }] });
    expect(await viewer.c.createEndpoint('/api/other', 'ts', viewer.opening)).toMatchObject({ ok: false });
    expect(await viewer.c.changeEndpointVariable({ name: 'KEY', declare: true }, viewer.opening)).toMatchObject({ ok: false });
    expect(existsSync(join(dir, 'src/routes/api/other'))).toBe(false);
    expect(existsSync(join(dir, 'src/env-names.json'))).toBe(false);
    expect(viewer.restarts()).toBe(before);
  });

  it('starts the preview again after a change to the environment, and never says a value', async () => {
    await updateSettings({ developerMode: true });
    const { c, dir, opening, restarts } = await opened();
    const before = restarts();
    const r = await c.changeEndpointVariable({ name: 'SEARCH_KEY', declare: true, value: 'sk_live_123' }, opening);
    expect(r).toEqual({ ok: true, environment: { variables: [{ name: 'SEARCH_KEY', local: true, declared: true }], declarations: 'managed' } });
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('SEARCH_KEY=sk_live_123\n');
    expect(restarts()).toBe(before + 1);
    // Nothing changed, nothing to start again for.
    await c.changeEndpointVariable({ name: 'SEARCH_KEY', declare: true }, opening);
    expect(restarts()).toBe(before + 1);
    expect(JSON.stringify(await c.endpointEnvironment(opening))).not.toContain('sk_live_123');
    // .env changed in another editor: the panel starts the preview again when asked, to read it.
    await c.reloadEndpointEnvironment(opening);
    await vi.waitFor(() => expect(restarts()).toBe(before + 2));
    expect(await c.reloadEndpointEnvironment('another opening')).toEqual({ ok: false, message: 'No project is open.' });
    expect(restarts()).toBe(before + 2);
  });

  it('sends a test request to the project’s own preview once it is running, and to nothing else', async () => {
    await updateSettings({ developerMode: true });
    const { c, opening } = await opened();
    expect(await c.sendEndpointRequest({ method: 'GET', path: '/api/hello' }, opening)).toEqual({ ok: false, message: 'The preview is not running yet. Wait for it to start, then send the request again.' });
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ url: req.url, origin: req.headers.origin }));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const held = c as unknown as { dev: unknown };
    held.dev = { url, stop: async () => undefined, status: { state: 'ready', url } };
    try {
      const r = await c.sendEndpointRequest({ method: 'GET', path: '/api/hello?name=ana' }, opening);
      expect(r).toMatchObject({ ok: true, status: 200 });
      if (r.ok) expect(JSON.parse(r.body)).toEqual({ url: '/api/hello?name=ana', origin: url });
      expect(await c.sendEndpointRequest({ method: 'GET', path: '/@fs/etc/passwd' }, opening)).toMatchObject({ ok: false });
      expect(await c.sendEndpointRequest({ method: 'GET', path: '/api/hello' }, 'another opening')).toEqual({ ok: false, message: 'No project is open.' });
    } finally {
      held.dev = null;
    }
  });
});
