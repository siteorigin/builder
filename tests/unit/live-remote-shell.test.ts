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
import type { AgentModelAdapter, CanonicalModelRequest, ModelEvent } from '../../src/agent/types';
import type { LiveProjectSnapshot } from '../../src/shared/live/snapshot';
import type { LiveNotes } from '../../src/shared/live/notes';
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
const { Orchestrator } = await import('../../src/agent/orchestrator');
const { liveHostAi } = await import('../../src/main/live/host-ai');
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
  const notes: LiveNotes[] = [];
  const address = randomAddress();
  const manager = new LiveGuestManager(
    {
      emit: (channel: string, payload: unknown) => {
        if (channel === 'remote:state') states.push(payload as RemoteState);
        if (channel === 'remote:changed') snapshots.push((payload as { snapshot: LiveProjectSnapshot }).snapshot);
        if (channel === 'remote:reload') reloads.push((payload as { revision: number | null }).revision);
        if (channel === 'remote:notes') notes.push((payload as { notes: LiveNotes }).notes);
      }
    },
    { createSocket: (url) => new WebSocket(url.replace('//relay.localhost:', '//127.0.0.1:'), { headers: { 'cf-connecting-ip': address } } as never) }
  );
  cleanups.push(() => manager.dispose());
  return { manager, states, snapshots, reloads, notes, admitted: () => manager.state as Extract<RemoteState, { phase: 'admitted' }> };
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
    // Before the host has changed anything, the guest already knows the revision its preview serves: the one on disk
    // when the preview came up.
    expect(g.admitted().previewRevision).toBe(h.c.session!.revision);

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
    // And the editor knows a page it loads from now on shows that revision.
    await until(() => (g.admitted().previewRevision ?? 0) >= before + 1, 'the published revision');

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

/** A model that answers with the turns a test gives it, each when the test lets it: no provider is ever called. */
class ScriptedModel implements AgentModelAdapter {
  requests: CanonicalModelRequest[] = [];
  constructor(private turns: Array<(req: CanonicalModelRequest) => ModelEvent[] | Promise<ModelEvent[]>>) {}
  capabilities() {
    return { toolCalling: 'native' as const, streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 100000, maxOutputTokens: 32000 } as ReturnType<AgentModelAdapter['capabilities']>;
  }
  async *streamTurn(req: CanonicalModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    const turn = this.turns.shift();
    const events = turn ? await turn(req) : [{ type: 'done', stopReason: 'end', text: 'Done.', toolCalls: [] } as ModelEvent];
    for (const ev of events) {
      if (signal.aborted) return void (yield { type: 'error', code: 'cancelled', message: 'Canceled' });
      yield ev;
    }
  }
}

/** The host's assistant, wired to its Controller and live session as the main process wires it (index.ts). */
function hostAi(h: Awaited<ReturnType<typeof host>>, model: ScriptedModel) {
  const orch = new Orchestrator({
    session: () => h.c.session,
    adapter: async () => ({ adapter: model, model: 'fake', provider: 'openai' }),
    emit: (e) => {
      h.c.send('ai:event', e);
      h.c.live.aiEvent(e);
    },
    compileAll: async () => [],
    inspectLayout: async () => ({ issues: [] }),
    onBusyChange: () => undefined,
    codeEnabled: async () => true
  });
  h.c.aiBusy = () => orch.editing;
  h.c.live.ai = liveHostAi({
    state: () => h.c.session?.state ?? null,
    opening: () => h.c.openingKey,
    send: (text, context, delegation) => orch.send(text, context, undefined, undefined, delegation),
    stop: (runId) => orch.stopRun(runId),
    answer: (runId, questionId, answer) => orch.answer(runId, questionId, answer)
  });
  cleanups.push(() => orch.close(1000));
  return orch;
}

describe('a collaborator using the host’s AI (#769)', () => {
  it('is off until the host allows it, then runs on the host, streams to the guest, and lands in the host’s History as the guest’s', async () => {
    const h = await host();
    const g = guest();
    const guestId = await joined(h, g, 'collaborator');
    const home = h.c.session!.state.site.homePageId;
    const model = new ScriptedModel([
      () => [{ type: 'done', stopReason: 'tool_use', text: '', toolCalls: [{ id: 'c1', name: 'apply_operations', arguments: JSON.stringify({ expectedRevision: h.c.session!.revision, scope: { kind: 'page', targetIds: [home] }, operations: [{ type: 'page.update', pageId: home, title: 'Baked by AI' }] }) }] }],
      () => [{ type: 'text', delta: `Renamed the page. Saved in ${h.dir}.` }, { type: 'done', stopReason: 'end', text: `Renamed the page. Saved in ${h.dir}.`, toolCalls: [] }]
    ]);
    const orch = hostAi(h, model);
    const joinId = g.admitted().joinId;
    const page = { scope: 'page', pageId: home, selection: null, viewport: 1280 };
    // Off by default: the guest has no AI, the host's assistant is never asked.
    expect(g.manager.ai(joinId)?.access).toEqual({ allowed: false, turnsLeft: null });
    expect(await g.manager.aiSend(joinId, 'Rename the page', page)).toMatchObject({ ok: false });
    expect(h.c.live.state).toMatchObject({ ai: { [guestId]: { allowed: false } } });

    expect(h.c.live.setAi(h.run, guestId, { allowed: true, turnLimit: 3 })).toEqual({ ok: true });
    await until(() => g.manager.ai(joinId)?.access.allowed, 'AI allowed at the guest');
    expect(g.manager.ai(joinId)?.access).toEqual({ allowed: true, turnsLeft: 3 });
    const sent = await g.manager.aiSend(joinId, 'Rename the page', page);
    if (!sent.ok) throw new Error(sent.message);
    const done = await until(() => g.manager.ai(joinId)?.turns.find((t) => t.runId === sent.runId && t.result), 'the request’s end at the guest');
    expect(done).toMatchObject({ request: 'Rename the page', result: { status: 'completed' } });
    expect(done.reply).toContain('Renamed the page.');
    // Nothing of the host's computer, nor its model, reaches the guest.
    const seen = JSON.stringify(g.manager.ai(joinId));
    expect(seen).not.toContain(h.dir);
    expect(seen).not.toContain('fake');
    // On the host: the change, a History step naming the guest, and the turn in its own conversation, which the
    // host's window followed as it ran.
    expect(h.c.session!.state.pages[home].title).toBe('Baked by AI');
    expect(h.c.snapshot()!.history.entries.at(-1)).toMatchObject({ source: 'ai', guestName: 'Sarah', runId: sent.runId });
    expect(orch.conversation!.messages.slice(-2).map((m) => m.guest?.name)).toEqual(['Sarah', 'Sarah']);
    expect(h.sent.some(([ch, e]) => ch === 'ai:event' && (e as { runId: string }).runId === sent.runId)).toBe(true);
    expect(g.manager.ai(joinId)?.access).toEqual({ allowed: true, turnsLeft: 2 });
    // The host takes it back from its own window.
    expect(await orch.undoTurn(sent.runId)).toEqual({ ok: true });
    expect(h.c.session!.state.pages[home].title).not.toBe('Baked by AI');
  });

  it('stops the guest’s request at once when the host turns its AI off, and refuses the next', async () => {
    const h = await host();
    const g = guest();
    const guestId = await joined(h, g, 'collaborator');
    const home = h.c.session!.state.site.homePageId;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // Its first change lands, and the host turns its AI off while it works on the next.
    const model = new ScriptedModel([
      () => [{ type: 'done', stopReason: 'tool_use', text: '', toolCalls: [{ id: 'c1', name: 'apply_operations', arguments: JSON.stringify({ expectedRevision: h.c.session!.revision, scope: { kind: 'page', targetIds: [home] }, operations: [{ type: 'page.update', pageId: home, title: 'Landed for now' }] }) }] }],
      async () => {
        await held;
        return [{ type: 'done', stopReason: 'tool_use', text: '', toolCalls: [{ id: 'c2', name: 'apply_operations', arguments: JSON.stringify({ expectedRevision: h.c.session!.revision, scope: { kind: 'page', targetIds: [home] }, operations: [{ type: 'page.update', pageId: home, title: 'Should not land' }] }) }] }];
      }
    ]);
    const orch = hostAi(h, model);
    const joinId = g.admitted().joinId;
    expect(h.c.live.setAi(h.run, guestId, { allowed: true, turnLimit: null })).toEqual({ ok: true });
    await until(() => g.manager.ai(joinId)?.access.allowed, 'AI allowed at the guest');
    const title = h.c.session!.state.pages[home].title;
    const steps = h.c.snapshot()!.history.entries.length;
    const sent = await g.manager.aiSend(joinId, 'Rename the page', { scope: 'page', pageId: home, selection: null, viewport: 1280 });
    if (!sent.ok) throw new Error(sent.message);
    await until(() => model.requests.length === 2, 'the model asked again');
    expect(h.c.session!.state.pages[home].title).toBe('Landed for now');
    expect(h.c.live.setAi(h.run, guestId, { allowed: false, turnLimit: null })).toEqual({ ok: true });
    release();
    await until(() => !orch.busy, 'the request stopped on the host');
    // What it had changed is taken back, and it leaves no step in History.
    expect(h.c.session!.state.pages[home].title).toBe(title);
    expect(h.c.snapshot()!.history.entries).toHaveLength(steps);
    await until(() => !g.manager.ai(joinId)?.access.allowed, 'AI taken away at the guest');
    expect(g.manager.ai(joinId)).toMatchObject({ activeRunId: null, turns: [{ runId: sent.runId, result: { status: 'cancelled', summary: 'The host turned off AI editing for you, so this request was stopped.' } }] });
    expect(await g.manager.aiSend(joinId, 'Again', { scope: 'page', pageId: home, selection: null, viewport: 1280 })).toMatchObject({ ok: false });
    expect(model.requests).toHaveLength(2);
  });
});

describe('pinned notes in the remote shell (#770)', () => {
  it('pins a collaborator’s note to its selected element, shows it on the host at once, and follows the host’s changes', async () => {
    const h = await host();
    const g = guest();
    const guestId = await joined(h, g, 'collaborator');
    const joinId = g.admitted().joinId;
    const home = h.c.session!.state.site.homePageId;
    const nodeId = Object.keys(h.c.session!.state.pages[home].nodes)[0] ?? 'n_any';
    const target = { owner: { kind: 'page' as const, id: home }, instancePath: [], nodeId };
    expect(await g.manager.notes(joinId)).toEqual({ notes: [], guestNotes: true });
    const left = await g.manager.addNote(joinId, { text: 'Swap this hero photo', pageId: home, target });
    expect(left).toMatchObject({ ok: true, notes: { notes: [{ text: 'Swap this hero photo', authorName: 'Sarah', authorRole: 'collaborator', pageId: home, target }] } });
    // The host's editor has it at once, with who left it and what it is pinned to.
    const opening = h.c.snapshot()!.workspaceKey;
    expect(await h.c.listNotes(opening)).toMatchObject({ notes: [{ authorName: 'Sarah', target }] });
    expect(h.sent.some(([ch, p]) => ch === 'notes:changed' && (p as LiveNotes).notes.length === 1)).toBe(true);

    // The host's own changes reach the guest's editor.
    const id = (left as { notes: LiveNotes }).notes.notes[0].id;
    expect(await h.c.resolveNote(opening, id, true)).toMatchObject({ ok: true });
    await until(() => g.notes.at(-1)?.notes[0]?.resolved === true, 'the resolve at the guest');
    expect(h.c.live.setGuestNotes(h.run, false)).toEqual({ ok: true });
    await until(() => g.notes.at(-1)?.guestNotes === false, 'guest notes turned off at the guest');
    expect(await g.manager.addNote(joinId, { text: 'Another', pageId: home })).toMatchObject({ ok: false, message: expect.stringMatching(/turned off/) });

    // A collaborator deletes; made a viewer, it can no longer.
    expect(await g.manager.resolveNote(joinId, id, false)).toMatchObject({ ok: true });
    expect(h.c.live.setRole(h.run, guestId, 'viewer')).toEqual({ ok: true });
    await until(() => g.admitted().role === 'viewer', 'the demotion');
    expect(await g.manager.deleteNote(joinId, id)).toMatchObject({ ok: false });
    expect((await h.c.listNotes(opening))!.notes).toHaveLength(1);
  });
});
