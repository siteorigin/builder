/**
 * The assistant's source tools (#680): a custom REST API's records read as the API sends them, before any mapping,
 * and a converter.mjs written for them, tested in the sync worker against every record and the collection before it is
 * saved in one undoable turn. An unsafe or broken converter never reaches the project folder; a source the author did
 * not approve, or one read by its own code, is never read or rewritten by the assistant; and the project holds the
 * tool to exactly the one change it tested.
 */
import { createServer, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collected } from './collect-garbage';

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  utilityProcess: { fork: () => new EventEmitter() }
}));

const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');
const { createSyncRunner } = await import('../../src/main/sources/client');
const { runSync } = await import('../../src/main/sources/run');
const { ADAPTERS } = await import('../../src/main/sources/adapters');
const { createSecretStore } = await import('../../src/main/sources/secrets');
const { createApprovalStore } = await import('../../src/main/sources/approvals');
const { syncSource } = await import('../../src/main/sources/sync');
const { createAgentSources } = await import('../../src/main/sources/agent');
const { Orchestrator } = await import('@agent/orchestrator');
const { asksForSource, toolsForRun } = await import('@agent/tools');
const { sourcesSummary } = await import('@agent/context');
const { fitSample, SAMPLE_CHARS } = await import('@agent/source-tools');
const { findForbiddenShapes, toStrictSchema } = await import('@agent/strict-schema');
const { envelopeSchema } = await import('@agent/constrained');
const { sourceConversionKey, sourceFingerprint } = await import('@shared/sources');
const { runConverter } = await import('../../src/main/sources/converter');
import type { SyncHandle } from '../../src/main/sources/client';
import type { SyncReply, SyncRequest } from '../../src/main/sources/protocol';
import type { EditOperation } from '@shared/ops';
import type { SourceSettingsDraft } from '@shared/api';
import type { AgentModelAdapter, CanonicalModelRequest, ModelEvent } from '@agent/types';

vi.setConfig({ testTimeout: 30_000 });
const SECRET = 'tok-5f4e3d2c1b0a9f8e';
const dirs: string[] = [];
const open: Array<{ close: () => Promise<unknown> }> = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const temp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), name));
  dirs.push(d);
  return d;
};

/** A server on this computer answering every request with `body(url, auth)`, noting what it was asked. */
async function server(body: (url: URL, auth: string | undefined) => { status?: number; json: unknown }) {
  const seen: string[] = [];
  const s = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seen.push(url.pathname + url.search);
    const r = body(url, req.headers.authorization);
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.json));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${(s.address() as { port: number }).port}`, seen };
}

/** A custom API's team, in its own words: nothing a source reads by default (no id, no title). */
const PEOPLE = [
  { uuid: 'u-ana', headline: 'Ana Ruiz', job: 'Architect', joined: '2026-03-04T10:00:00Z', bio: '<p>Designs <b>libraries</b>.</p>' },
  { uuid: 'u-ben', headline: 'Ben Okafor', job: 'Engineer', joined: '2026-03-01T09:00:00Z', bio: '<p>Builds bridges.</p>' }
];
const GOOD = `export function convert(items, helpers) {
  return items.map((p) => ({
    externalId: p.uuid,
    title: p.headline,
    publishedAt: helpers.date(p.joined),
    values: { role: p.job },
    body: helpers.richText.fromHtml(p.bio)
  }));
}
`;

/** A project with a Team collection, its REST source saved and approved here, and the sync worker run in this process. */
async function setup(people: () => unknown = () => ({ data: PEOPLE }), draft: Partial<SourceSettingsDraft> = {}) {
  const api = await server((_url, auth) => (auth === `Bearer ${SECRET}` ? { json: people() } : { status: 401, json: {} }));
  const dir = temp('so-source-tools-');
  env.userData = temp('so-userdata-');
  const s = await ProjectSession.create(dir, createStarterState('business', 'Sources', false));
  open.push(s);
  const made = await s.apply(
    { operations: [{ type: 'collection.create', collectionId: 'team', name: 'Team', kind: 'structured', pages: { detail: true, archive: true }, route: '/team/', fields: { role: { type: 'string', label: 'Role', default: '' } } }] as EditOperation[] },
    { label: 'Add the team' }
  );
  expect(made.error?.message).toBeUndefined();
  const secrets = createSecretStore(() => join(env.userData, 'source-secrets.json'));
  await secrets.set(s.state.manifest.projectId, 'api', SECRET);
  const approvals = createApprovalStore(() => join(env.userData, 'source-approvals.json'));
  const spawn = (): SyncHandle => {
    const e = new EventEmitter();
    return {
      postMessage: (m: SyncRequest) => void runSync(m, { adapters: ADAPTERS, fetchImage: async () => ({ bytes: new Uint8Array(), mime: 'image/png' }) }).then((reply: SyncReply) => e.emit('message', reply)),
      on: (ev: string, l: (x: never) => void) => (e.on(ev, l as (x: unknown) => void), undefined),
      kill: () => true
    } as unknown as SyncHandle;
  };
  const runner = createSyncRunner(spawn);
  const source: SourceSettingsDraft = { sourceId: 'crew', name: 'Crew API', adapter: 'rest', collectionId: 'team', config: { url: `${api.origin}/v1/people`, itemsPath: 'data', headers: { Authorization: 'Bearer ${secret:api}' } }, ...draft };
  const saved = await s.apply({ operations: [{ ...source, type: 'source.upsert' } as EditOperation] }, { label: 'Save the source' });
  expect(saved.error?.message).toBeUndefined();
  await approvals.approve(s.state.manifest.projectId, s.state.sources!.crew);
  const host = createAgentSources({ project: () => s, runner, secrets, approvals })(new AbortController().signal);
  const deps = { session: s, runner, secrets, approvals, current: () => true, importImage: async () => { throw new Error('no pictures here'); }, spoolRoot: join(env.userData, 'source-sync') };
  return { api, dir, s, host, runner, secrets, approvals, deps, source };
}

class FakeAdapter implements AgentModelAdapter {
  requests: CanonicalModelRequest[] = [];
  constructor(private turns: Array<(req: CanonicalModelRequest) => ModelEvent[]>) {}
  capabilities() {
    return { toolCalling: 'native' as const, streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 100000, maxOutputTokens: 32000 } as ReturnType<AgentModelAdapter['capabilities']>;
  }
  async *streamTurn(req: CanonicalModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    const turn = this.turns.shift();
    for (const ev of turn ? turn(req) : finish('Done.')) yield ev;
  }
}
const call = (id: string, name: string, args: unknown): ModelEvent => ({ type: 'done', stopReason: 'tool_use', text: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const finish = (text: string): ModelEvent[] => [{ type: 'done', stopReason: 'end', text, toolCalls: [] }];
const lastResult = (req: CanonicalModelRequest) => JSON.parse((req.items.at(-1) as { content?: string }).content ?? '{}') as Record<string, any>;
const converterFile = (dir: string) => join(dir, 'siteorigin/sources/crew/converter.mjs');
/** The crew source's saved settings, as a run that read them names them. */
const fp = (s: { state: { sources?: Record<string, unknown> } }) => sourceFingerprint(s.state.sources!.crew as never);

describe('in an AI turn', () => {
  it('reads the API’s records, has an unsafe and a broken converter refused, and saves a verified one, undone in one step', async () => {
    const env2 = await setup();
    const { s, dir } = env2;
    const before = structuredClone(s.state.sources);
    const unsafe = `import fs from 'node:fs';\nexport function convert(items) { fs.writeFileSync('/tmp/x', 'y'); return []; }\n`;
    const broken = 'export function convert(items) {\n  return items.map((p) => ({ externalId: p.uuid, name: p.headline }));\n}\n';
    const adapter = new FakeAdapter([
      () => [call('c1', 'inspect_source_sample', { sourceId: 'crew' })],
      (req) => {
        const r = lastResult(req);
        expect(r, JSON.stringify(r).slice(0, 300)).toMatchObject({ ok: true, total: 2, source: { sourceId: 'crew', kind: 'rest', collectionId: 'team' }, collection: { id: 'team', fields: [{ name: 'role', type: 'string' }] } });
        // As the API sent them, before any mapping: the details the converter is written for.
        expect(r.untrustedRecords).toEqual(PEOPLE);
        expect(JSON.stringify(r)).not.toContain(SECRET);
        return [call('c2', 'write_source_converter', { sourceId: 'crew', converter: unsafe })];
      },
      (req) => {
        const r = lastResult(req);
        expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', recoverable: true, details: { issues: expect.arrayContaining([expect.objectContaining({ stage: 'check', line: 1 })]) } } });
        expect(r.error.message).toMatch(/imports a module/);
        expect(existsSync(converterFile(dir))).toBe(false);
        return [call('c3', 'write_source_converter', { sourceId: 'crew', converter: broken })];
      },
      (req) => {
        const r = lastResult(req);
        // Run in the worker against the records: they give no title, which an entry needs.
        expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', recoverable: true, details: { issues: [expect.objectContaining({ stage: 'records' })] } } });
        expect(r.error.message).toMatch(/no title/);
        expect(existsSync(converterFile(dir))).toBe(false);
        return [call('c4', 'write_source_converter', { sourceId: 'crew', converter: GOOD })];
      },
      (req) => {
        const r = lastResult(req);
        expect(r, JSON.stringify(r).slice(0, 300)).toMatchObject({ ok: true, saved: 'siteorigin/sources/crew/converter.mjs', tested: { records: 2, wouldCreate: 2 } });
        expect(r.entries[0]).toMatchObject({ externalId: 'u-ana', title: 'Ana Ruiz', publishedAt: '2026-03-04', values: { role: 'Architect' } });
        return finish('Wrote a converter for Crew API: two team members, each with their role.');
      }
    ]);
    const orch = new Orchestrator({
      session: () => s,
      adapter: async () => ({ adapter, model: 'fake', provider: 'openai' }),
      emit: () => undefined,
      compileAll: async () => [],
      inspectLayout: async () => ({ issues: [] }),
      onBusyChange: () => undefined,
      sources: (signal) => createAgentSources({ project: () => s, runner: env2.runner, secrets: env2.secrets, approvals: env2.approvals })(signal)
    });
    const groups = s.historyInfo().entries.length;
    const r = await orch.send('Map the Crew API into the Team collection', { pageId: s.state.site.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280, scope: 'site' });
    expect(r.message).toBeUndefined();
    while (orch.busy) await new Promise((res) => setTimeout(res, 10));
    expect(adapter.requests).toHaveLength(5);
    expect(adapter.requests[0].tools.map((t) => t.name)).toEqual(expect.arrayContaining(['inspect_source_sample', 'write_source_converter']));
    // read_project names the source, never where it is read or what it signs in with.
    expect(adapter.requests[0].system + JSON.stringify(adapter.requests[0].items)).not.toContain('/v1/people');
    // Saved as the converter, beside settings that are as the author left them.
    expect(readFileSync(converterFile(dir), 'utf8')).toBe(GOOD);
    expect(s.state.sources!.crew).toMatchObject({ adapter: 'rest', config: before!.crew.config, converter: { file: 'converter.mjs', code: GOOD } });
    expect(s.state.sources!.crew.mapping).toBeUndefined();
    // Nothing synced yet: the author syncs it, and it still signs in with their secret.
    expect(Object.keys(s.state.collections.team.entries)).toEqual([]);
    expect(await syncSource(env2.deps, 'crew')).toMatchObject({ ok: true, created: 2 });
    expect(Object.values(s.state.collections.team.entries).map((e) => [e.title, e.values.role]).sort()).toEqual([
      ['Ana Ruiz', 'Architect'],
      ['Ben Okafor', 'Engineer']
    ]);
    // The turn is one step of History, undone whole.
    const runs = s.historyInfo().entries.slice(groups).map((e) => e.runId);
    expect(runs).toEqual([r.runId]);
    expect((await s.undoGroup(r.runId!)).ok).toBe(true);
    expect(s.state.sources).toEqual(before);
    expect(existsSync(converterFile(dir))).toBe(false);
  });
});

describe('links in the records’ text that keep only their words (#1426)', () => {
  const LINKED = PEOPLE.map((p, i) => (i === 1 ? { ...p, bio: '<p>Builds <a href="/bridges/">bridges</a> and <a href="javascript:void 0">more</a>.</p>' } : p));

  it('are said by the record they are in when a mapping reads them, and counted when a converter does', async () => {
    const { host } = await setup(() => ({ data: LINKED }));
    const mapped = await host.verify('crew', { mapping: { externalId: 'uuid', title: 'headline', body: 'bio', bodyFormat: 'html' } });
    expect(mapped).toMatchObject({ ok: true, total: 2, droppedLinks: { count: 2, records: 1, titles: ['Ben Okafor'] } });
    expect(await host.verify('crew', { converter: GOOD })).toMatchObject({ ok: true, droppedLinks: { count: 2, records: 0, titles: [] } });
    const clean = await (await setup()).host.verify('crew', { converter: GOOD });
    expect(clean).toMatchObject({ ok: true });
    expect(clean).not.toHaveProperty('droppedLinks');
  });

  it('are told to the AI with what it tested', async () => {
    const env2 = await setup(() => ({ data: LINKED }));
    const { s } = env2;
    // Read here, once the run is over: what a turn throws only ends the run.
    let written: Record<string, unknown> | undefined;
    const adapter = new FakeAdapter([
      () => [call('c1', 'inspect_source_sample', { sourceId: 'crew' })],
      () => [call('c2', 'write_source_converter', { sourceId: 'crew', converter: GOOD })],
      (req) => {
        written = lastResult(req);
        return finish('Wrote a converter.');
      }
    ]);
    const orch = new Orchestrator({
      session: () => s,
      adapter: async () => ({ adapter, model: 'fake', provider: 'openai' }),
      emit: () => undefined,
      compileAll: async () => [],
      inspectLayout: async () => ({ issues: [] }),
      onBusyChange: () => undefined,
      sources: (signal) => createAgentSources({ project: () => s, runner: env2.runner, secrets: env2.secrets, approvals: env2.approvals })(signal)
    });
    const r = await orch.send('Map the Crew API into the Team collection', { pageId: s.state.site.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280, scope: 'site' });
    expect(r.message).toBeUndefined();
    while (orch.busy) await new Promise((res) => setTimeout(res, 10));
    expect(adapter.requests).toHaveLength(3);
    expect(written, JSON.stringify(written).slice(0, 300)).toMatchObject({ ok: true, tested: { records: 2, wouldCreate: 2, linksKeptAsWords: '2 links keep only their words: their addresses are not ones an entry can keep. Give them a web address at the source.' } });
  });
});

describe('the source tools’ host', () => {
  /** The session holds its project frozen: a source edited outside the app is a changed copy put in its place. */
  type Held = { state: import('@shared/types').ProjectState };
  const editSource = (session: Held, id: string, change: (doc: NonNullable<Held['state']['sources']>[string]) => void) => {
    const next = structuredClone(session.state);
    change(next.sources![id]);
    session.state = next;
  };
  it('reads records as the API sends them even when its mapping cannot read them, and tests a mapping against them', async () => {
    const { s, host, api } = await setup(undefined, { mapping: { externalId: 'id', title: 'title' } });
    const read = await host.inspect('crew', fp(s));
    expect(read).toEqual({ ok: true, raw: PEOPLE, total: 2 });
    const wrong = await host.verify('crew', { mapping: { externalId: 'uuid', title: 'name' } });
    expect(wrong).toMatchObject({ ok: false, recoverable: true, issues: [expect.objectContaining({ stage: 'records' })] });
    const right = await host.verify('crew', { mapping: { externalId: 'uuid', title: 'headline', publishedAt: 'joined', body: 'bio', bodyFormat: 'html', values: { role: 'job' } } });
    expect(right).toMatchObject({ ok: true, total: 2, created: 2, operation: { type: 'source.upsert', sourceId: 'crew', mapping: { title: 'headline' } } });
    expect(api.seen.every((p) => p === '/v1/people')).toBe(true);
  });

  it('keeps no project for a tested change that never landed, and approves nothing once its project has gone (#1039)', async () => {
    const { s, runner, secrets, approvals } = await setup();
    // The project as the tools are given it, until it closes: an object of its own, so nothing here keeps it.
    let current: { readonly state: typeof s.state } | null = { state: s.state };
    const host = createAgentSources({ project: () => current, runner, secrets, approvals })(new AbortController().signal);
    const tested = await host.verify('crew', { converter: GOOD });
    if (!tested.ok) throw new Error(tested.message);
    const project = new WeakRef(current);
    current = null;
    expect(await collected(project), 'the closed project is still reachable from a ticket').toBe(true);
    expect(await host.approve(tested.ticket)).toBe(false);
  });

  it('approves only the very change it tested, once it has landed, and runs only a converter’s exported reader', async () => {
    const { s, host, approvals } = await setup();
    const first = await host.verify('crew', { converter: GOOD });
    const second = await host.verify('crew', { converter: `${GOOD}// two\n` });
    if (!first.ok || !second.ok) throw new Error('not tested');
    // Not landed yet: nothing to approve.
    expect(await host.approve(second.ticket)).toBe(false);
    const again = await host.verify('crew', { converter: `${GOOD}// two\n` });
    if (!again.ok) throw new Error('not tested');
    expect((await s.apply({ operations: [again.operation] }, { label: 'AI', source: 'ai', sourceWrite: again.grant })).ok).toBe(true);
    // The first ticket is for another change than the one that landed.
    expect(await host.approve(first.ticket)).toBe(false);
    expect(await approvals.approved(s.state.manifest.projectId, s.state.sources!.crew)).toBe(false);
    expect(await host.approve(again.ticket)).toBe(true);
    expect(await approvals.approved(s.state.manifest.projectId, s.state.sources!.crew)).toBe(true);
    // A converter that gives no entries for the records the source has would take every entry away at its next sync.
    expect(await host.verify('crew', { converter: 'export function convert() {\n  return [];\n}\n' })).toMatchObject({ ok: false, message: expect.stringMatching(/gives no entries/) });
    // A fetchAll the module does not export is never run as its reader, nor a function it names undefined.
    const shadow = await runConverter('function undefined() { return [{ uuid: "nope" }]; }\nexport function convert(items) { return items; }\n', { richText: () => [] }, async () => [{ uuid: 'read' }]);
    expect(shadow.items).toEqual([{ uuid: 'read' }]);
    let asked = 0;
    const r = await runConverter('function fetchAll() { return [{ uuid: "nope" }]; }\nexport function convert(items) { return items; }\n', { richText: () => [] }, async () => (asked++, [{ uuid: 'read' }]));
    expect(r.items).toEqual([{ uuid: 'read' }]);
    expect(asked).toBe(1);
  });

  it('never reads or rewrites a source changed outside the app, or one read by its own fetchAll, and never shows an echoed secret', async () => {
    const { s, host, api, approvals } = await setup();
    // Settings changed since they were approved (a collaborator's commit) do not sign in.
    const elsewhere = { ...s.state.sources!.crew, config: { ...s.state.sources!.crew.config, query: { all: 'yes' } } };
    expect((await s.apply({ operations: [{ type: 'source.upsert', sourceId: 'crew', name: elsewhere.name, adapter: 'rest', collectionId: 'team', config: elsewhere.config }] as EditOperation[] }, { label: 'Elsewhere' })).ok).toBe(true);
    api.seen.length = 0;
    expect(await host.inspect('crew', fp(s))).toMatchObject({ ok: false, code: 'unapproved' });
    expect(await host.verify('crew', { converter: GOOD })).toMatchObject({ ok: false, recoverable: false });
    expect(api.seen).toEqual([]);
    // Read by the author's own fetchAll: the assistant neither reads around it nor replaces it.
    const own = 'export async function fetchAll(helpers) { return helpers.fetchJson("/v1/published"); }\nexport function convert(items) { return items.map((p) => ({ externalId: p.uuid, title: p.headline })); }\n';
    expect((await s.apply({ operations: [{ type: 'source.upsert', sourceId: 'crew', name: 'Crew API', adapter: 'rest', collectionId: 'team', config: elsewhere.config, converter: own }] as EditOperation[] }, { label: 'Own reader' })).ok).toBe(true);
    await approvals.approve(s.state.manifest.projectId, s.state.sources!.crew);
    expect(await host.inspect('crew', fp(s))).toMatchObject({ ok: false, code: 'converter', message: expect.stringMatching(/own fetchAll/) });
    expect(await host.verify('crew', { converter: GOOD })).toMatchObject({ ok: false, code: 'converter' });
    expect(api.seen).toEqual([]);
    // A converter that is missing is not read around either.
    const missing = s.state;
    editSource(s, 'crew', (doc) => {
      doc.converter = { file: 'converter.mjs' };
    });
    expect(await host.inspect('crew', fp(s))).toMatchObject({ ok: false, code: 'converter', message: expect.stringMatching(/missing/) });
    s.state = missing;
    // Nor does a converter the assistant writes read its own way.
    const back = await s.apply({ operations: [{ type: 'source.upsert', sourceId: 'crew', name: 'Crew API', adapter: 'rest', collectionId: 'team', config: elsewhere.config, mapping: { title: 'headline' } }] as EditOperation[] }, { label: 'Mapped' });
    expect(back.ok).toBe(true);
    await approvals.approve(s.state.manifest.projectId, s.state.sources!.crew);
    expect(await host.verify('crew', { converter: own.replace('export async function fetchAll', 'async function fetchAll') })).toMatchObject({ ok: false, issues: [expect.objectContaining({ stage: 'check', message: expect.stringMatching(/fetchAll/) })] });
    expect(api.seen).toEqual([]);
  });

  it('refuses records that hold one of the user’s secrets, and a source with no records to test against', async () => {
    const echoed = await setup(() => ({ data: [{ ...PEOPLE[0], note: `token ${SECRET}` }] }));
    expect(await echoed.host.inspect('crew', fp(echoed.s))).toMatchObject({ ok: false, code: 'secret' });
    // Only the third record holds it: every record shown is checked.
    const third = await setup(() => ({ data: [PEOPLE[0], PEOPLE[1], { ...PEOPLE[0], uuid: 'u-cy', bio: SECRET }] }));
    expect(await third.host.inspect('crew', fp(third.s))).toMatchObject({ ok: false, code: 'secret' });
    const empty = await setup(() => ({ data: [] }));
    expect(await empty.host.inspect('crew', fp(empty.s))).toEqual({ ok: true, raw: [], total: 0 });
    expect(await empty.host.verify('crew', { converter: GOOD })).toMatchObject({ ok: false, recoverable: false, message: expect.stringMatching(/no records/) });
    // A converter that makes up its own entry shows nothing about a source that has none.
    const invented = 'export function convert() {\n  return [{ externalId: "x", title: "Made up" }];\n}\n';
    expect(await empty.host.verify('crew', { converter: invented })).toMatchObject({ ok: false, message: expect.stringMatching(/no records/) });
    // Nor is a converter that holds one of the user's secrets ever shown, edited outside the app or not.
    const leaky = await setup();
    const saved = leaky.s.state.sources!.crew;
    expect((await leaky.s.apply({ operations: [{ type: 'source.upsert', sourceId: 'crew', name: saved.name, adapter: 'rest', collectionId: 'team', config: saved.config, converter: GOOD }] as EditOperation[] }, { label: 'Converter' })).ok).toBe(true);
    editSource(leaky.s, 'crew', (disk) => {
      disk.converter!.code = `// ${SECRET}\n${GOOD}`;
    });
    expect(await leaky.host.inspect('crew', fp(leaky.s))).toMatchObject({ ok: false, code: 'secret', message: expect.not.stringContaining(SECRET) });
    expect(await leaky.host.verify('crew', { converter: GOOD })).toMatchObject({ ok: false, code: 'secret' });
    // Its name, too, whatever else would be said of it first: changed since it was read, or read by its own fetchAll.
    editSource(leaky.s, 'crew', (disk) => {
      disk.converter!.code = GOOD;
      disk.name = `Crew ${SECRET}`;
    });
    expect(await leaky.host.inspect('crew', fp(leaky.s))).toMatchObject({ ok: false, code: 'secret', message: expect.not.stringContaining(SECRET) });
    expect(await leaky.host.inspect('crew', 'an earlier fingerprint')).toMatchObject({ ok: false, code: 'secret' });
    editSource(leaky.s, 'crew', (disk) => {
      disk.converter!.code = 'export async function fetchAll() { return []; }\nexport function convert(i) { return i; }\n';
    });
    for (const r of [await leaky.host.inspect('crew', fp(leaky.s)), await leaky.host.verify('crew', { converter: GOOD })]) {
      expect(r).toMatchObject({ ok: false, code: 'secret' });
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
    // The settings the run read, or none: settings saved since are not read in their place.
    expect(await empty.host.inspect('crew', 'an earlier fingerprint')).toMatchObject({ ok: false, code: 'stale', message: expect.stringContaining('crew') });
  });
});

describe('the project', () => {
  it('lets an AI run change a source only as the tool tested it', async () => {
    const { s, source } = await setup();
    const base = sourceFingerprint(s.state.sources!.crew);
    const op = (extra: Partial<SourceSettingsDraft>) => ({ ...source, ...extra, type: 'source.upsert' }) as EditOperation;
    const ai = (ops: EditOperation[], grant?: { sourceId: string; base: string; change: string }) => s.apply({ operations: ops }, { label: 'AI', source: 'ai', ...(grant ? { sourceWrite: grant } : {}) });
    const tested = (code: string) => ({ sourceId: 'crew', base, change: sourceConversionKey({ converter: code }) });
    expect((await ai([op({ converter: GOOD })])).error).toMatchObject({ code: 'SCOPE_MISMATCH', message: expect.stringMatching(/only be changed in the editor/) });
    // Anywhere else, with other secrets, named or kept otherwise: refused, whatever the grant.
    expect((await ai([op({ converter: GOOD, config: { ...source.config, url: 'https://elsewhere.example/collect' } })], tested(GOOD))).error?.message).toMatch(/settings stay as the author saved them/);
    expect((await ai([op({ converter: GOOD, name: 'Renamed' })], tested(GOOD))).error?.message).toMatch(/settings stay as the author saved them/);
    expect((await ai([op({ converter: GOOD, removal: 'remove' })], tested(GOOD))).error?.message).toMatch(/settings stay as the author saved them/);
    const reader = 'export async function fetchAll() { return []; }\nexport function convert(i) { return i; }\n';
    expect((await ai([op({ converter: reader })], tested(reader))).error?.message).toMatch(/no fetchAll/);
    expect((await ai([op({ converter: GOOD }), { type: 'source.remove', sourceId: 'crew' } as EditOperation], tested(GOOD))).error?.message).toMatch(/nothing else/);
    expect((await ai([op({ converter: GOOD })], { ...tested(GOOD), base: 'stale' })).error?.message).toMatch(/changed since/);
    // Only what was tested: another converter under the same grant is refused.
    expect((await ai([op({ converter: `${GOOD}\n// another` })], tested(GOOD))).error?.message).toMatch(/only the mapping or converter it tested/);
    expect((await ai([op({ converter: GOOD })], { ...tested(GOOD), sourceId: 'other' })).error?.message).toMatch(/only the source it tested/);
    expect(s.state.sources!.crew.converter).toBeUndefined();
    expect((await ai([op({ converter: GOOD })], tested(GOOD))).ok).toBe(true);
    expect(s.state.sources!.crew.converter?.code).toBe(GOOD);
  });
});

describe('what a model is offered', () => {
  it('offers both tools to a site run with a source, inspection alone to a question, and closed schemas to a small model', async () => {
    const { s } = await setup();
    const caps = { toolCalling: 'native' as const, contextWindowTokens: 100000 };
    const constrained = { toolCalling: 'constrained-json' as const, contextWindowTokens: 8000 };
    const names = (r: { tools: Array<{ name: string }> }) => r.tools.map((t) => t.name);
    const site = toolsForRun({ state: s.state, selection: null, capabilities: caps, codeEnabled: false, definitionOps: true });
    expect(names(site)).toEqual(expect.arrayContaining(['inspect_source_sample', 'write_source_converter']));
    const ask = toolsForRun({ state: s.state, selection: null, capabilities: caps, codeEnabled: false, definitionOps: false, ask: true });
    expect(names(ask)).toContain('inspect_source_sample');
    expect(names(ask)).not.toContain('write_source_converter');
    const page = toolsForRun({ state: s.state, selection: null, capabilities: caps, codeEnabled: false, definitionOps: false, page: { route: '/' } });
    expect(names(page)).not.toContain('write_source_converter');
    expect(names(page)).not.toContain('inspect_source_sample');
    // A small model's question reads a source only when it asks about one.
    expect(names(toolsForRun({ state: s.state, selection: null, capabilities: constrained, codeEnabled: false, definitionOps: false, ask: true }))).not.toContain('inspect_source_sample');
    expect(names(toolsForRun({ state: s.state, selection: null, capabilities: constrained, codeEnabled: false, definitionOps: false, ask: true, sourceRequest: true }))).toContain('inspect_source_sample');
    const small = toolsForRun({ state: s.state, selection: null, capabilities: constrained, codeEnabled: false, definitionOps: false, sourceRequest: true });
    for (const t of small.tools.filter((x) => x.name.includes('source'))) {
      expect(findForbiddenShapes(toStrictSchema(t.parameters)), t.name).toEqual([]);
      expect(t.brief, t.name).toBeTruthy();
    }
    expect(names(small)).toContain('write_source_converter');
    for (const compact of [false, true]) expect(findForbiddenShapes(envelopeSchema(small.tools, { compact }))).toEqual([]);
    expect(names(toolsForRun({ state: s.state, selection: null, capabilities: constrained, codeEnabled: false, definitionOps: false }))).not.toContain('write_source_converter');
    expect(asksForSource('Map the Crew API into Team', s.state)).toBe(true);
    expect(asksForSource('Fix the converter for crew', s.state)).toBe(true);
    expect(asksForSource('Make the hero teal', s.state)).toBe(false);
    // read_project names each source by ID, never by a name settings edited outside the app could hold anything in.
    expect(sourcesSummary(s.state)).toEqual([{ sourceId: 'crew', kind: 'rest', collectionId: 'team', readsWith: 'its kind of source’s own reading' }]);
  });

  it('cuts a large sample to fit, keeping every record’s detail names', () => {
    const big = Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, title: `Record ${i}`, body: '多'.repeat(20_000), tags: Array.from({ length: 50 }, (_, j) => `tag${j}`), nested: { a: { b: { c: { d: { e: { f: { g: { h: 'deep' } } } } } } } } }));
    const fit = fitSample(big);
    expect(fit.clipped).toBe(true);
    expect(JSON.stringify(fit.records).length).toBeLessThanOrEqual(SAMPLE_CHARS);
    expect(fit.records).toHaveLength(3);
    for (const r of fit.records as Array<Record<string, unknown>>) {
      expect(Object.keys(r)).toEqual(['id', 'title', 'body', 'tags', 'nested']);
      expect(r.title).toMatch(/^Record \d$/);
      expect(JSON.stringify(r.nested)).toMatch(/"a":\{"b":/);
    }
    // A record whose very detail names are too long to show is said, never shown past the room for it.
    const named = fitSample([{ ['k'.repeat(20_000)]: 1 }]);
    expect(named.records).toEqual(['(The first record is too large to show here.)']);
    expect(fitSample([{ id: 'small' }])).toEqual({ records: [{ id: 'small' }], clipped: false });
  });
});
