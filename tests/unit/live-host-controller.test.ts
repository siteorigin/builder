/**
 * A live session belongs to the project opening it was started in (#762): the Controller ends it when that project is
 * closed or another is opened in its place, keeps it when a switch is called off, serves its guests the project's own
 * preview, and has them reload when a change is saved. Run against the relay in Cloudflare's local simulator.
 */
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveHostState, LiveJoinRequest, LiveRun } from '../../src/shared/api';
import type { GuestRole } from '../../src/shared/live/limits';
import type { LiveProjectChanged, LiveProjectSnapshot } from '../../src/shared/live/snapshot';
import { joinGuest, previewOrigin, randomAddress, redeemTicket, startRelay, wait, type JoinedGuest, type Relay } from './relay-harness';
import { collected } from './collect-garbage';

/**
 * A stand-in for Electron's utility process that reports the test's preview server as ready, holds a save's updates
 * when asked, says when each revision has reached Vite (as src/runtime/worker.ts does), and exits when asked to stop.
 */
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
const workers: FakeWorker[] = [];
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  utilityProcess: { fork: () => workers[workers.push(new FakeWorker()) - 1] }
}));

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');
const { sha } = await import('../../src/main/project/fsutil');
const { copyProjectSource } = await import('../../src/main/export');

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
async function hosting(c: InstanceType<typeof Controller>, sent: Array<[string, unknown]>, dir: string, role: GuestRole = 'viewer') {
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  await until(() => c.snapshot()?.runtime.state === 'ready', 'the preview');
  const opening = c.snapshot()!.workspaceKey;
  const started = await c.live.start({ opening, duration: '2h' });
  if (!started.ok) throw new Error(started.message);
  const state = started.state;
  if (state.phase !== 'active') throw new Error(`Expected an active session, got ${state.phase}`);
  const run: LiveRun = { workspaceKey: state.workspaceKey, runId: state.runId };
  expect(state.workspaceKey).toBe(opening);
  expect(started.inviteUrl).toBe(`${process.env.SITEORIGIN_LIVE_RELAY_URL}/s/${state.roomId}`);
  const guest = await joinGuest(relay, state.roomId, 'Ann');
  // The editor hears the guest ask, then lets it in.
  await until(() => sent.find(([ch, p]) => ch === 'live:request' && (p as LiveJoinRequest).guestId === guest.guestId), 'the join request');
  expect(c.live.admit(run, guest.guestId, role)).toEqual({ ok: true });
  const status = await guest.guest.next('guest:status');
  if (status.status !== 'admitted') throw new Error(`Expected to be admitted, got ${status.status}`);
  const cookie = (await redeemTicket(relay, state.roomId, status.previewTicket)).cookie!;
  // Until the host's roster shows the guest let in, the host answers none of its calls.
  await until(() => (c.live.state as { participants?: Array<{ guestId: string; status: string }> }).participants?.some((p) => p.guestId === guest.guestId && p.status === 'admitted'), 'the guest admitted');
  return { state, run, guest, cookie };
}

let calls = 0;
/** A guest's editor call over the relay, and the host's answer. */
async function rpc(guest: JoinedGuest, method: string, args: unknown[] = []) {
  const requestId = `q${++calls}`;
  guest.guest.send('guest-to-relay', { type: 'rpc:request', requestId, method, args });
  for (;;) {
    const answer = await guest.guest.next('rpc:response');
    if (answer.requestId !== requestId) continue;
    expect(answer.method).toBe(method);
    return answer;
  }
}

/** The next project:changed a guest is sent at `revision` or later. */
async function changedTo(guest: JoinedGuest, revision: number): Promise<LiveProjectChanged> {
  for (;;) {
    const event = await guest.guest.next('rpc:event');
    if (event.event !== 'project:changed') continue;
    const payload = event.payload as LiveProjectChanged;
    const at = payload.kind === 'snapshot' ? payload.snapshot.revision : payload.kind === 'too-large' ? payload.revision : -1;
    if (at >= revision) return payload;
  }
}

describe('a live session hosted by the open project', () => {
  it('serves guests the project’s own preview and has them reload when a change is saved', async () => {
    const dir = await makeProject('acme');
    const { c, sent } = controller();
    const { state, guest, cookie } = await hosting(c, sent, dir);
    const page = await relay.fetch(`${await previewOrigin(state.roomId)}/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('From the project preview');
    // A save reaches the preview, and once Vite has it the guests reload to see it.
    const home = c.session!.state.site.homePageId;
    const worker = workers.at(-1)!;
    expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, seoTitle: 'Fresh bread daily' }] })).ok).toBe(true);
    await guest.guest.next('preview:reload');
    expect(worker.published).toContain(c.session!.revision);
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

  it('lets go of the copy of the project its guests were given once it ends, with the project still open (#1039)', async () => {
    const dir = await makeProject('acme');
    const { c, sent } = controller();
    const { run, guest } = await hosting(c, sent, dir, 'collaborator');
    // A change guests are sent as it is saved, and the project a guest reads.
    const home = c.session!.state.site.homePageId;
    expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, seoTitle: 'Fresh bread daily' }] })).ok).toBe(true);
    await changedTo(guest, c.session!.revision);
    expect((await rpc(guest, 'project.snapshot')).ok).toBe(true);
    // The very copy the controller keeps for the next guest who asks, and the session as the last one it sent.
    const copy = new WeakRef(c.guestSnapshot(run.workspaceKey)!);
    expect(c.guestSnapshot(run.workspaceKey)).toBe(copy.deref());
    // The session itself still reachable after it has ended, as a closing connection's handlers can keep it.
    const ended = (c.live as unknown as { run: { sentSnapshot: unknown } | null }).run;
    expect(ended?.sentSnapshot).toBe(copy.deref());
    expect((await c.live.stop(run)).ok).toBe(true);
    await until(() => c.live.state.phase === 'idle', 'the session ended');
    expect(c.session?.dir).toBe(dir);
    expect(await collected(copy), 'the copy given to guests is still reachable').toBe(true);
    expect(ended?.sentSnapshot).toBeNull();
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

  it('lets a collaborator read the project and edit it through the host’s own pipeline, as a step of its own', async () => {
    const dir = await makeProject('acme');
    const { c, sent } = controller();
    const { state, run, guest } = await hosting(c, sent, dir, 'collaborator');
    // A second guest, a viewer, follows along.
    const bob = await joinGuest(relay, state.roomId, 'Bob');
    await until(() => sent.find(([ch, p]) => ch === 'live:request' && (p as LiveJoinRequest).guestId === bob.guestId), "Bob's join request");
    expect(c.live.admit(run, bob.guestId, 'viewer')).toEqual({ ok: true });
    await bob.guest.next('guest:status');

    // The host's own notes name its folders.
    const home = c.session!.state.site.homePageId;
    const noted = await c.apply({ operations: [{ type: 'page.update', pageId: home, description: `Kept in ${dir}` }] });
    expect(noted.ok, noted.error?.message).toBe(true);
    const read = await rpc(guest, 'project.snapshot');
    if (!read.ok) throw new Error(read.error.message);
    const shared = read.result as LiveProjectSnapshot;
    expect(shared.state.pages[home].seo.description).toBe('Kept in …');
    expect(shared).toMatchObject({ revision: c.session!.revision, readOnly: false, aiBusy: false, runtime: { state: 'ready' } });
    expect(shared.state.pages[home].title).toBe(c.session!.state.pages[home].title);
    // Nothing of the host's computer or editor goes over the relay.
    const text = JSON.stringify(shared);
    for (const leak of [dir, homedir(), 'workspaceKey', 'localState', 'recentExports', '127.0.0.1']) expect(text, leak).not.toContain(leak);

    const before = c.session!.revision;
    const worker = workers.at(-1)!;
    // Made against an older revision: refused, and nothing written.
    expect(await rpc(guest, 'project.apply', [{ operations: [{ type: 'page.update', pageId: home, title: 'Stale' }], expectedRevision: before - 1 }])).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect(c.session!.revision).toBe(before);
    const edit = await rpc(guest, 'project.apply', [{ operations: [{ type: 'page.update', pageId: home, title: 'Fresh bread daily' }], expectedRevision: before, label: 'Rename page' }]);
    expect(edit).toMatchObject({ ok: true, result: { revision: before + 1 } });
    // Saved on the host, generated for its preview, and in its History as Ann's.
    expect(c.session!.state.pages[home].title).toBe('Fresh bread daily');
    expect(readFileSync(join(dir, `siteorigin/pages/${home}.json`), 'utf8')).toContain('Fresh bread daily');
    await until(() => worker.published.includes(before + 1), 'the preview to have the change');
    const step = c.snapshot()!.history.entries.at(-1)!;
    expect(step).toMatchObject({ label: 'Rename page (Ann)', source: 'user', guestName: 'Ann', applied: true });
    // The host's editor and every guest hear of it.
    expect(sent.some(([ch, p]) => ch === 'project:changed' && (p as { revision: number }).revision === before + 1)).toBe(true);
    for (const g of [guest, bob]) expect(await changedTo(g, before + 1)).toMatchObject({ kind: 'snapshot', snapshot: { revision: before + 1 } });
    // Each edit is a step of its own, which the host can undo.
    expect((await rpc(guest, 'project.apply', [{ operations: [{ type: 'page.update', pageId: home, title: 'Fresh bread' }] }])).ok).toBe(true);
    expect(c.snapshot()!.history.entries.slice(-2).map((e) => e.label)).toEqual(['Rename page (Ann)', 'Edit (Ann)']);
    const last = c.snapshot()!.history.entries.at(-1)!;
    expect((await c.undoEntry(last.id, c.snapshot()!.workspaceKey)).ok).toBe(true);
    expect(c.session!.state.pages[home].title).toBe('Fresh bread daily');
    // What a guest is told of what it made is the IDs it can edit next, and nothing else.
    const made = await rpc(guest, 'project.apply', [{ operations: [{ type: 'page.create', title: 'Workshops' }] }]);
    if (!made.ok) throw new Error(made.error.message);
    const [created] = (made.result as { results: Array<Record<string, unknown>> }).results;
    expect(Object.keys(created).length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(created)) expect(`${key}=${typeof value}`).toMatch(/Ids?=(string|object)$/);
    expect(c.session!.state.pages[created.pageId as string].title).toBe('Workshops');
    // A viewer edits nothing.
    const viewer = await rpc(bob, 'project.apply', [{ operations: [{ type: 'page.update', pageId: home, title: 'Bob was here' }] }]);
    expect(viewer).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(c.session!.state.pages[home].title).toBe('Fresh bread daily');
  });

  it('refuses code, a viewer’s edits, and edits while the AI works, changing nothing', async () => {
    const dir = await makeProject('acme');
    const { c, sent } = controller();
    const { run, guest } = await hosting(c, sent, dir, 'collaborator');
    const home = c.session!.state.site.homePageId;
    const revision = c.session!.revision;
    const code = await rpc(guest, 'project.apply', [{ operations: [{ type: 'component.createCode', name: 'Widget', source: '<p>hi</p>' }] }]);
    expect(code).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', operationIndex: 0 } });
    // The host's AI owns the project while it runs.
    c.aiBusy = () => true;
    expect(await rpc(guest, 'project.apply', [{ operations: [{ type: 'page.update', pageId: home, title: 'Busy' }] }])).toMatchObject({ ok: false, error: { code: 'BUSY', recoverable: true } });
    c.aiBusy = () => false;
    // Made a viewer: refused at once, and nothing changed.
    expect(c.live.setRole(run, guest.guestId, 'viewer')).toEqual({ ok: true });
    expect(await rpc(guest, 'project.apply', [{ operations: [{ type: 'page.update', pageId: home, title: 'Demoted' }] }])).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(c.session!.revision).toBe(revision);
    expect(c.snapshot()!.saveFailure ?? null).toBeNull();
    // Removed: the guest is told, and nothing of it is answered again.
    expect(c.live.kick(run, guest.guestId)).toEqual({ ok: true });
    for (;;) {
      const status = await guest.guest.next('guest:status');
      if (status.status === 'kicked') break;
    }
  });

  it('lets a copy editor reword the pages over the live protocol, and refuses at commit what its grant does not reach', async () => {
    const dir = await makeProject('acme');
    const { c, sent } = controller();
    const { guest } = await hosting(c, sent, dir, 'copy-editor');
    const owner = { kind: 'page' as const, id: c.session!.state.site.homePageId };
    const host = async (operations: unknown[]) => {
      const r = await c.apply({ operations } as never);
      if (!r.ok) throw new Error(r.error?.message);
      return r.results!;
    };
    // The host's page: a split hero, whose heading and eyebrow are marked as copy, and a section of text.
    const hero = (await host([{ type: 'node.insert', owner, parentId: null, componentId: 'hero.split' }]))[0].nodeId as string;
    const section = (await host([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }]))[0].nodeId as string;
    const paragraph = (await host([{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'paragraph', text: 'Opening hours vary.' }]))[0].nodeId as string;
    const rich = (await host([{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'richtext' }]))[0].nodeId as string;
    await host([{ type: 'node.setContent', owner, nodeId: rich, field: 'text', value: 'Call us or [read the FAQ](https://example.com/faq).' }]);
    const file = join(dir, `siteorigin/pages/${owner.id}.json`);

    // Its copy lands through the host's own pipeline, as a step of its own that names it.
    const before = c.session!.revision;
    const reword = [
      { type: 'node.setContent', owner, nodeId: paragraph, field: 'text', value: 'Open every day.' },
      { type: 'instance.setProp', owner, nodeId: hero, prop: 'heading', value: 'Fresh bread daily' }
    ];
    expect(await rpc(guest, 'project.apply', [{ operations: reword, expectedRevision: before, label: 'Reword' }])).toMatchObject({ ok: true, result: { revision: before + 1 } });
    expect(readFileSync(file, 'utf8')).toContain('Open every day.');
    expect(readFileSync(file, 'utf8')).toContain('Fresh bread daily');
    expect(c.snapshot()!.history.entries.at(-1)).toMatchObject({ label: 'Reword (Ann)', guestName: 'Ann', applied: true });

    const saved = readFileSync(file, 'utf8');
    const revision = c.session!.revision;
    const steps = c.snapshot()!.history.entries.length;
    // A layout edit is refused before the editor sees it.
    expect(await rpc(guest, 'project.apply', [{ operations: [{ type: 'node.remove', owner, nodeId: section }] }])).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', operationIndex: 0 } });
    // Each of these passes every check of the operations alone, sent straight over the protocol: the project as the
    // batch would leave it refuses them as it is saved, the whole batch with them.
    const refusals: Array<{ operations: unknown[]; message: RegExp; operationIndex?: number }> = [
      {
        operations: [
          { type: 'node.setContent', owner, nodeId: paragraph, field: 'text', value: 'Open on Sundays.' },
          { type: 'instance.setProp', owner, nodeId: hero, prop: 'primaryLabel', value: 'Buy now' }
        ],
        message: /Primary button label/,
        operationIndex: 1
      },
      { operations: [{ type: 'node.setContent', owner, nodeId: rich, field: 'text', value: 'Call us or [read the FAQ](https://evil.example/faq).' }], message: /links/ },
      { operations: [{ type: 'instance.setProp', owner, nodeId: hero, prop: 'eyebrow', value: '   ' }], message: /clearing/ }
    ];
    for (const { operations, message, operationIndex } of refusals) {
      const answer = await rpc(guest, 'project.apply', [{ operations }]);
      expect(answer, message.source).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', message: expect.stringMatching(message) } });
      if (operationIndex !== undefined) expect(answer).toMatchObject({ error: { operationIndex } });
    }
    expect(c.session!.revision).toBe(revision);
    expect(readFileSync(file, 'utf8')).toBe(saved);
    expect(c.snapshot()!.history.entries.length).toBe(steps);
    expect(c.snapshot()!.saveFailure ?? null).toBeNull();
  });

  it('holds a copy editor made a collaborator to its new grant only once its edits are a collaborator’s', async () => {
    const dir = await makeProject('acme');
    const { c, sent } = controller();
    const { run, guest } = await hosting(c, sent, dir, 'copy-editor');
    const home = c.session!.state.site.homePageId;
    const rename = [{ operations: [{ type: 'page.update', pageId: home, title: 'Fresh bread daily' }] }];
    expect(await rpc(guest, 'project.apply', rename)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', operationIndex: 0 } });
    expect(c.live.setRole(run, guest.guestId, 'collaborator')).toEqual({ ok: true });
    await guest.guest.next('guest:status');
    await until(() => (c.live.state as { participants?: Array<{ guestId: string; role?: string }> }).participants?.some((p) => p.guestId === guest.guestId && p.role === 'collaborator'), 'the role confirmed');
    expect(await rpc(guest, 'project.apply', rename)).toMatchObject({ ok: true });
    expect(c.session!.state.pages[home].title).toBe('Fresh bread daily');
  });

  it('lands nothing of a guest whose access the host has changed by the time its edit would be saved', async () => {
    const dir = await makeProject('acme');
    const { c, sent } = controller();
    await hosting(c, sent, dir, 'collaborator');
    const opening = c.snapshot()!.workspaceKey;
    const owner = { kind: 'page' as const, id: c.session!.state.site.homePageId };
    const revision = c.session!.revision;
    // The live host's check, asked as the edit's turn comes and again as it is saved: still allowed at first, then not.
    let asked = 0;
    const check = () => (++asked > 1 ? { code: 'PERMISSION_DENIED' as const, message: 'The host changed your access before your edit was made.', recoverable: false } : null);
    const result = await c.applyGuest(opening, { guestId: 'g_test', displayName: 'Ann', role: 'collaborator', check }, { operations: [{ type: 'node.insert', owner, parentId: null, componentId: 'hero.split' }] as never });
    expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('changed your access') } });
    expect(asked).toBeGreaterThan(1);
    expect(c.session!.revision).toBe(revision);
  });

  it('never lets a collaborator change where a contact form sends, however a design passes it on', async () => {
    const dir = await makeProject('acme');
    const { c, sent } = controller();
    const { guest } = await hosting(c, sent, dir, 'collaborator');
    const owner = { kind: 'page' as const, id: c.session!.state.site.homePageId };
    const host = async (operations: unknown[]) => {
      const r = await c.apply({ operations } as never);
      if (!r.ok) throw new Error(r.error?.message);
      return r.results!;
    };
    // The host's own "Contact band", passing its recipient on as the form's endpoint, placed for Sales.
    const section = (await host([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }]))[0].nodeId as string;
    await host([{ type: 'node.insert', owner, parentId: section, slot: 'content', componentId: 'contact.form', props: { provider: 'endpoint', endpoint: 'https://forms.example.com/sales' } }]);
    const band = (await host([{ type: 'component.createFromNode', owner, nodeId: section, name: 'Contact band' }]))[0].definitionId as string;
    const inner = Object.values(c.session!.state.components[band].tree!.nodes).find((n) => n.kind === 'instance' && n.definitionId === 'foundation.contact.form')!.id;
    await host([
      { type: 'component.setPropSchema', definitionId: band, prop: 'recipient', schema: { type: 'string', label: 'Recipient', default: '' } },
      { type: 'node.setBinding', owner: { kind: 'component', id: band }, nodeId: inner, field: 'prop', prop: 'endpoint', binding: { $prop: 'recipient' } }
    ]);
    const sales = (await host([{ type: 'node.insert', owner, parentId: null, definitionId: band, props: { recipient: 'https://forms.example.com/sales' } }]))[0].nodeId as string;
    const revision = c.session!.revision;
    const evil = 'https://evil.example/f';
    for (const operations of [
      [{ type: 'instance.setProp', owner, nodeId: sales, prop: 'recipient', value: evil }],
      [{ type: 'node.insert', owner, parentId: null, definitionId: band, newNodeId: 'n_guest01' }, { type: 'instance.setProp', owner, nodeId: 'n_guest01', prop: 'recipient', value: evil }]
    ])
      expect(await rpc(guest, 'project.apply', [{ operations }])).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Contact band') } });
    expect(c.session!.revision).toBe(revision);
    expect(JSON.stringify(c.session!.state)).not.toContain(evil);
    expect(c.snapshot()!.saveFailure ?? null).toBeNull();
    // Its other edits are ordinary.
    expect((await rpc(guest, 'project.apply', [{ operations: [{ type: 'node.duplicate', owner, nodeId: sales }] }])).ok).toBe(true);
  });
});

/** Every file under `dir` and what it holds, by its path there. */
function filesIn(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) Object.assign(out, filesIn(p, base));
    else out[p.slice(base.length + 1)] = readFileSync(p, 'latin1');
  }
  return out;
}

describe('pinned notes (#770)', () => {
  it('keeps a viewer’s note in the project’s local state alone, shows it to the editor at once, and keeps it after the session', async () => {
    const dir = await makeProject('acme');
    const { c, sent } = controller();
    const { run, guest } = await hosting(c, sent, dir, 'viewer');
    const documents = filesIn(join(dir, 'siteorigin'));
    const revision = c.session!.revision;
    const SENTINEL = 'Swap this hero photo zq770';
    expect(await rpc(guest, 'notes.add', [{ text: `  ${SENTINEL} `, previewPath: '/' }])).toMatchObject({ ok: true, result: { kept: true } });
    // The editor is shown it, with who left it, on the page whose address the guest's preview showed.
    const [, shown] = await until(() => sent.find(([ch]) => ch === 'notes:changed'), 'the editor told');
    const note = (shown as { notes: Array<Record<string, unknown>> }).notes[0];
    expect(note).toMatchObject({ text: SENTINEL, authorName: 'Ann', authorRole: 'viewer', pageId: c.session!.state.site.homePageId, target: null, resolved: false });
    // Every guest is told the notes changed, and reads them.
    for (;;) if ((await guest.guest.next('rpc:event')).event === 'notes:changed') break;
    expect(await rpc(guest, 'notes.list')).toMatchObject({ ok: true, result: { notes: [{ text: SENTINEL, authorName: 'Ann' }], guestNotes: true } });
    // A viewer resolves and deletes nothing: the relay refuses it before the host sees it.
    expect(await rpc(guest, 'notes.delete', [note.id])).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(await rpc(guest, 'notes.add', [{ text: 'x'.repeat(281), previewPath: '/' }])).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await rpc(guest, 'notes.add', [{ text: 'On no page', previewPath: '/nowhere/' }])).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });

    // Kept in .siteorigin/notes.json, and nowhere in the site's documents, its revision or what an export copies.
    expect(readFileSync(join(dir, '.siteorigin/notes.json'), 'utf8')).toContain(SENTINEL);
    expect(filesIn(join(dir, 'siteorigin'))).toEqual(documents);
    expect(c.session!.revision).toBe(revision);
    const exported = temp('export');
    await copyProjectSource(dir, exported);
    expect(existsSync(join(exported, '.siteorigin'))).toBe(false);
    for (const [path, text] of Object.entries(filesIn(exported))) expect(text.includes(SENTINEL), path).toBe(false);

    // The host turns guest notes off: the next is refused, and what was left stays.
    expect(c.live.setGuestNotes(run, false)).toEqual({ ok: true });
    expect(await rpc(guest, 'notes.add', [{ text: 'One more', previewPath: '/' }])).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });

    // The session ends; the host still has the note, resolves it, and has it on opening the project again.
    expect(await c.live.stop(run)).toEqual({ ok: true });
    const opening = c.snapshot()!.workspaceKey;
    expect(await c.resolveNote(opening, note.id, true)).toMatchObject({ ok: true, notes: { notes: [{ id: note.id, resolved: true }] } });
    expect(await c.closeProject()).toEqual({ ok: true });
    expect((await c.trustAndOpen(dir)).ok).toBe(true);
    expect(await c.listNotes(c.snapshot()!.workspaceKey)).toMatchObject({ notes: [{ id: note.id, text: SENTINEL, resolved: true }] });
    // A note for an opening that is no longer the open one changes nothing.
    expect(await c.deleteNote(opening, note.id)).toMatchObject({ ok: false });
  });

  it('lets a collaborator resolve and delete notes, and the host’s own too', async () => {
    const dir = await makeProject('acme');
    const { c, sent } = controller();
    const { guest } = await hosting(c, sent, dir, 'collaborator');
    const opening = c.snapshot()!.workspaceKey;
    const home = c.session!.state.site.homePageId;
    const left = await c.addNote(opening, { text: 'Confirm pricing copy', pageId: home });
    if (!left.ok || !left.notes) throw new Error('The host’s note was not kept');
    const id = left.notes.notes[0].id;
    expect(left.notes.notes[0]).toMatchObject({ authorName: 'Host', authorRole: 'host' });
    expect(await rpc(guest, 'notes.resolve', [id, true])).toMatchObject({ ok: true });
    expect((await c.listNotes(opening))!.notes[0].resolved).toBe(true);
    expect(await rpc(guest, 'notes.delete', [id])).toMatchObject({ ok: true });
    expect((await c.listNotes(opening))!.notes).toEqual([]);
    expect(await rpc(guest, 'notes.delete', [id])).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  });
});
