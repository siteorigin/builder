/**
 * Syncing an external source into a real project (#676): the records land as entry files under stable `en_` IDs, an
 * unchanged record's file is never rewritten, a record gone is drafted, pictures come into the library once however
 * often they are synced, and the secrets the source signs in with appear nowhere in the project or its exports. A
 * sync that finds the project changed under it, or a source echoing a secret back, writes nothing.
 */
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VariantRequest } from '../../src/main/project/media-client';

const env = vi.hoisted(() => ({ userData: '' }));

/** The media worker, run in this process by the code the real worker runs. */
class InlineMediaWorker extends EventEmitter {
  postMessage(m: VariantRequest) {
    void import('../../src/main/project/image-variants').then(({ handleVariantRequest }) => handleVariantRequest(m)).then((r) => this.emit('message', r));
  }
  kill() {
    return true;
  }
}

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  utilityProcess: { fork: () => new InlineMediaWorker() }
}));

const { ProjectSession } = await import('../../src/main/project/session');
const { readState, ProjectFormatError } = await import('../../src/main/project/documents');
const { importPackageImage } = await import('../../src/main/project/assets');
const { createStarterState } = await import('@catalogue/starters');
const { createSyncRunner } = await import('../../src/main/sources/client');
const { runSync } = await import('../../src/main/sources/run');
const { createSecretStore } = await import('../../src/main/sources/secrets');
const { syncSource } = await import('../../src/main/sources/sync');
const { syncedEntryId } = await import('../../src/main/sources/reconcile');
const { copyProjectSource, exportedSourcesProblem, inProjectSource, writeExportedSources } = await import('../../src/main/export');
const { isPrivateFileName } = await import('../../src/main/project/private-files');
import type { SyncHandle, SyncResult, SyncRunner } from '../../src/main/sources/client';
import { spoolFile, type NormalizedRecord, type SyncReply, type SyncRequest } from '../../src/main/sources/protocol';
import type { EditOperation } from '@shared/ops';

const SECRET = 'tok-0a1b2c3d4e5f6a7b';
let pictures: Record<string, Buffer> = {};
// Each test makes a project and brings pictures through the real media pipeline, as photo-import.test.ts does.
vi.setConfig({ testTimeout: 30_000 });
const dirs: string[] = [];
const open: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const temp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), name));
  dirs.push(d);
  return d;
};

const png = (r: number) => sharp({ create: { width: 8, height: 8, channels: 3, background: { r, g: 40, b: 90 } } }).png().toBuffer();

/**
 * A project with a team collection and a source syncing into it, the secret it names saved for it, and a source
 * whose records are whatever `world.records` holds when it is read.
 */
async function setup() {
  const dir = temp('so-sync-');
  env.userData = temp('so-userdata-');
  const s = await ProjectSession.create(dir, createStarterState('business', 'Sync', false));
  open.push(s);
  const r = await s.apply(
    {
      operations: [
        { type: 'collection.create', collectionId: 'team', name: 'Team', kind: 'structured', pages: { detail: true, archive: false }, route: '/team/', fields: { role: { type: 'string', label: 'Role', default: '' } } },
        { type: 'source.upsert', sourceId: 'people', name: 'People API', adapter: 'fixture', collectionId: 'team', config: { credentials: { token: { $secret: 'people-token' } } } }
      ] as EditOperation[]
    },
    { label: 'Add the team source' }
  );
  expect(r.error?.message).toBeUndefined();
  const secrets = createSecretStore(() => join(env.userData, 'source-secrets.json')).in(dir);
  await secrets.set(s.state.manifest.projectId, 'people-token', SECRET);
  pictures = { 'https://cdn.example/ana.png': await png(10), 'https://cdn.example/ben.png': await png(200) };
  // Another address for Ana's very picture.
  pictures['https://cdn.example/cy.png'] = pictures['https://cdn.example/ana.png'];
  const world = { records: [] as NormalizedRecord[], reads: 0, fetched: [] as string[], broken: [] as string[], gate: null as Promise<void> | null, importGate: null as Promise<void> | null, imports: 0, signedWith: [] as string[] };
  // The sync worker, run in this process by the code the real worker runs, with a reader of fixture records.
  const spawn = (): SyncHandle => {
    const e = new EventEmitter();
    return {
      postMessage: (m: SyncRequest) =>
        void runSync(m, {
          adapters: {
            fixture: {
              read: async (_config, given) => {
                world.reads++;
                world.signedWith.push(given['people-token']);
                if (world.gate) await world.gate;
                return structuredClone(world.records);
              }
            }
          },
          fetchImage: async (url) => {
            world.fetched.push(url);
            if (world.broken.includes(url)) throw new Error('404');
            return { bytes: new Uint8Array(pictures[url]), mime: 'image/png' };
          }
        }).then((reply: SyncReply) => e.emit('message', reply)),
      on: (ev: string, l: (x: never) => void) => (e.on(ev, l as (x: unknown) => void), undefined),
      kill: () => true
    } as unknown as SyncHandle;
  };
  const deps = {
    session: s,
    runner: createSyncRunner(spawn),
    secrets,
    // Its settings saved here (see source-connect.test.ts for settings changed outside the app).
    approvals: { approved: async () => true },
    current: () => true,
    spoolRoot: join(env.userData, 'source-sync'),
    importImage: async (img: { name: string; mime: string; ext: string; bytes: Uint8Array }, known: Parameters<typeof importPackageImage>[2], createdAt: string) => {
      world.imports++;
      if (world.importGate) await world.importGate;
      return importPackageImage(dir, { name: img.name, mime: img.mime, ext: img.ext, bytes: Buffer.from(img.bytes) }, known, undefined, createdAt);
    }
  };
  return { dir, s, world, deps };
}

const person = (id: string, name: string, extra: Partial<NormalizedRecord> = {}): NormalizedRecord => ({
  externalId: id,
  title: name,
  publishedAt: '2026-02-01',
  values: { role: 'Maker' },
  featuredImage: { $image: { url: `https://cdn.example/${name.toLowerCase()}.png`, name } },
  ...extra
});
const entryFile = (dir: string, externalId: string) => join(dir, 'siteorigin/collections/team/entries', `${syncedEntryId('people', externalId, () => false)}.json`);
const files = (root: string): string[] => readdirSync(root, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name));

describe('syncing a source into a project', () => {
  it('re-syncs in place: changed records keep their IDs, unchanged files are untouched, gone records are drafted, pictures come in once', async () => {
    const { dir, s, world, deps } = await setup();
    world.records = [person('1', 'Ana'), person('2', 'Ben'), person('3', 'Cy')];
    const first = await syncSource(deps, 'people');
    expect(first).toMatchObject({ ok: true, created: 3, updated: 0, unchanged: 0, images: 2 });
    // The worker signed in with the secret the source names, which the project never holds.
    expect(world.signedWith).toEqual([SECRET]);
    expect(world.fetched.sort()).toEqual(['https://cdn.example/ana.png', 'https://cdn.example/ben.png', 'https://cdn.example/cy.png']);
    // Two addresses of one picture are one library image.
    const entries = s.state.collections.team.entries;
    expect(entries[syncedEntryId('people', '3', () => false)].featuredImage).toBe(entries[syncedEntryId('people', '1', () => false)].featuredImage);
    const team = s.state.collections.team;
    expect(team.settings.sourceId).toBe('people');
    const ana = team.entries[syncedEntryId('people', '1', () => false)];
    expect(ana).toMatchObject({ title: 'Ana', draft: false, source: { sourceId: 'people', externalId: '1' } });
    const assets = Object.keys(s.state.assets.assets).length;
    expect(s.state.assets.assets[ana.featuredImage!]).toMatchObject({ kind: 'image', mime: 'image/png' });
    // A sync is no step of History.
    const history = s.historyInfo().entries.length;
    // The unchanged file, dated in the past, so a rewrite would show.
    const benFile = entryFile(dir, '2');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(benFile, old, old);
    const benText = readFileSync(benFile, 'utf8');
    world.fetched = [];
    // Ben's record as the source lists it this time: the same, its keys in another order.
    const ben = person('2', 'Ben');
    const reordered = Object.fromEntries(Object.entries(ben).reverse()) as unknown as NormalizedRecord;
    world.records = [person('1', 'Ana', { title: 'Ana Ruiz' }), reordered];
    const second = await syncSource(deps, 'people');
    expect(second).toMatchObject({ ok: true, created: 0, updated: 1, unchanged: 1, unpublished: 1, images: 0 });
    // The changed record's picture was fetched again and found in the library already; the unchanged one's never.
    expect(world.fetched).toEqual(['https://cdn.example/ana.png']);
    expect(Object.keys(s.state.assets.assets)).toHaveLength(assets);
    expect(readdirSync(join(dir, 'static/assets')).length).toBeGreaterThan(0);
    const on = (await readState(dir)).collections.team.entries;
    expect(on[syncedEntryId('people', '1', () => false)]).toMatchObject({ title: 'Ana Ruiz', featuredImage: ana.featuredImage });
    expect(readFileSync(benFile, 'utf8')).toBe(benText);
    expect(statSync(benFile).mtime.getTime()).toBe(old.getTime());
    expect(on[syncedEntryId('people', '3', () => false)]).toMatchObject({ title: 'Cy', draft: true });
    expect(s.historyInfo().entries.length).toBe(history);
    // Nothing changed at the source: nothing is written, and the project's revision stays where it was.
    const revision = s.revision;
    await expect(syncSource(deps, 'people')).resolves.toMatchObject({ ok: true, unchanged: 2, revision });
    expect(s.revision).toBe(revision);
    expect(readFileSync(benFile, 'utf8')).toBe(benText);
    expect(statSync(benFile).mtime.getTime()).toBe(old.getTime());
    // The secret is nowhere in the project.
    for (const f of files(dir)) if (!f.endsWith('.png') && !f.endsWith('.webp') && !f.endsWith('.jpg')) expect(readFileSync(f, 'utf8')).not.toContain(SECRET);
    expect(JSON.parse(readFileSync(join(dir, 'siteorigin/sources/people/source.json'), 'utf8')).config).toEqual({ credentials: { token: { $secret: 'people-token' } } });
  });

  it('writes nothing when the project changed while the source was read, or the source sent back a secret', async () => {
    const { dir, s, world, deps } = await setup();
    world.records = [person('1', 'Ana')];
    let release!: () => void;
    world.gate = new Promise((r) => (release = r));
    const sync = syncSource(deps, 'people');
    await vi.waitFor(() => expect(world.reads).toBe(1));
    const edit = await s.apply({ operations: [{ type: 'site.update', description: 'Changed meanwhile' }] }, { label: 'Describe' });
    expect(edit.ok).toBe(true);
    release();
    await expect(sync).resolves.toMatchObject({ ok: false, code: 'stale' });
    expect(Object.keys(s.state.collections.team.entries)).toEqual([]);
    expect(s.state.collections.team.settings.sourceId).toBeUndefined();
    world.gate = null;
    world.records = [person('1', 'Ana', { excerpt: `Ana ${SECRET}` })];
    const echoed = await syncSource(deps, 'people');
    expect(echoed).toMatchObject({ ok: false, code: 'secret' });
    expect(echoed.ok === false && echoed.message).not.toContain(SECRET);
    expect(existsSync(join(dir, 'siteorigin/collections/team/entries'))).toBe(false);
    // A saved secret the source does not even name, echoed back, is refused too.
    const other = 'tok-unasked-99887766';
    await deps.secrets.set(s.state.manifest.projectId, 'unasked', other);
    world.records = [person('1', 'Ana', { excerpt: `Ana ${other}` })];
    await expect(syncSource(deps, 'people')).resolves.toMatchObject({ ok: false, code: 'secret' });
    // So is one a picture's address carries in its file name, which the library would name it by.
    world.records = [person('1', 'Ana', { featuredImage: { $image: { url: `https://cdn.example/${encodeURIComponent(other)}.png` } } })];
    pictures[`https://cdn.example/${encodeURIComponent(other)}.png`] = pictures['https://cdn.example/ana.png'];
    await expect(syncSource(deps, 'people')).resolves.toMatchObject({ ok: false, code: 'secret' });
    expect(Object.keys(s.state.assets.assets).some((id) => s.state.assets.assets[id].name.includes(other))).toBe(false);
    // Or one a title would become as an address: accents off, words hyphenated.
    await deps.secrets.set(s.state.manifest.projectId, 'slugged', 'example-token');
    world.records = [person('1', 'Ana', { title: 'Éxample Token' })];
    await expect(syncSource(deps, 'people')).resolves.toMatchObject({ ok: false, code: 'secret' });
    await deps.secrets.set(s.state.manifest.projectId, 'slugged', null);
    // Or one only a picture's bytes carry (a text chunk), which the library would keep as they are.
    pictures['https://cdn.example/inked.png'] = Buffer.concat([pictures['https://cdn.example/ana.png'], Buffer.from(SECRET)]);
    world.records = [person('1', 'Ana', { featuredImage: { $image: { url: 'https://cdn.example/inked.png' } } })];
    await expect(syncSource(deps, 'people')).resolves.toMatchObject({ ok: false, code: 'secret' });
    // A project closed meanwhile: nothing lands.
    world.records = [person('1', 'Ana')];
    await expect(syncSource({ ...deps, current: () => false }, 'people')).resolves.toMatchObject({ ok: false, code: 'closed' });
    expect(Object.keys(s.state.collections.team.entries)).toEqual([]);
    // A project changed while its pictures were being brought in: nothing lands, and the change stays.
    let let_go!: () => void;
    world.importGate = new Promise((r) => (let_go = r));
    const late = syncSource(deps, 'people');
    await vi.waitFor(() => expect(world.imports).toBeGreaterThan(0));
    await s.apply({ operations: [{ type: 'site.update', description: 'Changed again' }] }, { label: 'Describe' });
    let_go();
    world.importGate = null;
    await expect(late).resolves.toMatchObject({ ok: false, code: 'stale' });
    expect(s.state.site.description).toBe('Changed again');
    expect(Object.keys(s.state.collections.team.entries)).toEqual([]);
    expect(s.state.collections.team.settings.sourceId).toBeUndefined();
  });

  it('keeps its pictures in a spool, not its reply, reads each as it imports it, and leaves no spool behind (#1045)', async () => {
    const { s, world, deps } = await setup();
    const spools = () => (existsSync(deps.spoolRoot) ? readdirSync(deps.spoolRoot) : []);
    // A folder a sync left when the app stopped is taken away by the next one.
    mkdirSync(join(deps.spoolRoot, 'sync-left'), { recursive: true });
    writeFileSync(join(deps.spoolRoot, 'sync-left', spoolFile(0)), 'old');
    const replies: SyncResult[] = [];
    const runner: SyncRunner = { run: async (...a) => { const r = await deps.runner.run(...a); replies.push(r); return r; }, stop: () => deps.runner.stop() };
    const imported: string[] = [];
    const importImage: typeof deps.importImage = async (img, known, at) => (imported.push(img.name), deps.importImage(img, known, at));
    // Listed in another order than the one the sync imports them in (by external ID).
    world.records = [person('2', 'Ben'), person('1', 'Ana')];
    expect(await syncSource({ ...deps, runner, importImage }, 'people')).toMatchObject({ ok: true, created: 2, images: 2 });
    // The reply said each picture's size and carried none of its bytes.
    expect(replies[0].images).toEqual([
      { key: 'url:https://cdn.example/ben.png', mime: 'image/png', ext: '.png', size: pictures['https://cdn.example/ben.png'].length },
      { key: 'url:https://cdn.example/ana.png', mime: 'image/png', ext: '.png', size: pictures['https://cdn.example/ana.png'].length }
    ]);
    // Fetched in the source's order, imported in the sync's, and each entry shows its own picture.
    expect(world.fetched).toEqual(['https://cdn.example/ben.png', 'https://cdn.example/ana.png']);
    expect(imported).toEqual(['Ana', 'Ben']);
    const entries = s.state.collections.team.entries;
    for (const [id, name] of [['1', 'ana'], ['2', 'ben']])
      expect(s.state.assets.assets[entries[syncedEntryId('people', id, () => false)].featuredImage!].hash).toBe(createHash('sha256').update(pictures[`https://cdn.example/${name}.png`]).digest('hex'));
    expect(spools()).toEqual([]);
  });

  it('imports nothing when a picture will not load, however many came first, nor when its spooled file is not what was fetched (#1045)', async () => {
    const { dir, s, world, deps } = await setup();
    const spools = () => (existsSync(deps.spoolRoot) ? readdirSync(deps.spoolRoot) : []);
    const assets = () => (existsSync(join(dir, 'static/assets')) ? readdirSync(join(dir, 'static/assets')).sort() : []);
    const before = assets();
    const library = Object.keys(s.state.assets.assets).length;
    world.records = [person('1', 'Ana'), person('2', 'Ben'), person('3', 'Cy')];
    world.broken = ['https://cdn.example/cy.png'];
    expect(await syncSource(deps, 'people')).toMatchObject({ ok: false, code: 'image' });
    // Two pictures fetched and kept before the third failed: none of them reached the library or the project's folder.
    expect(world.fetched).toEqual(['https://cdn.example/ana.png', 'https://cdn.example/ben.png', 'https://cdn.example/cy.png']);
    expect([world.imports, assets(), Object.keys(s.state.assets.assets).length, Object.keys(s.state.collections.team.entries)]).toEqual([0, before, library, []]);
    expect(spools()).toEqual([]);
    world.broken = [];
    // A picture's file cut short, or put in place as a link to the very bytes, or missing, after the worker said what
    // it fetched: found before the first picture is imported, so none is.
    const outside = join(temp('so-outside-'), 'ben.png');
    writeFileSync(outside, pictures['https://cdn.example/ben.png']);
    const spoils = [(f: string) => truncateSync(f, 3), (f: string) => (rmSync(f), symlinkSync(outside, f)), (f: string) => rmSync(f)];
    for (const spoil of spoils) {
      const runner: SyncRunner = {
        run: async (name, req, opts) => {
          const r = await deps.runner.run(name, req, opts);
          spoil(join(req.spool!, spoolFile(1)));
          return r;
        },
        stop: () => deps.runner.stop()
      };
      const r = await syncSource({ ...deps, runner }, 'people');
      expect(r).toMatchObject({ ok: false });
      expect(r.ok === false && r.message).toBe('“People API” was not synced: a picture could not be fetched.');
      expect([world.imports, assets(), Object.keys(s.state.assets.assets).length, Object.keys(s.state.collections.team.entries)]).toEqual([0, before, library, []]);
      expect(spools()).toEqual([]);
    }
    // Closed, or changed under it, while its pictures were being brought in: no spool is left either.
    await expect(syncSource({ ...deps, current: () => false }, 'people')).resolves.toMatchObject({ ok: false, code: 'closed' });
    expect(spools()).toEqual([]);
    let let_go!: () => void;
    world.importGate = new Promise((r) => (let_go = r));
    const late = syncSource(deps, 'people');
    await vi.waitFor(() => expect(world.imports).toBeGreaterThan(0));
    await s.apply({ operations: [{ type: 'site.update', description: 'Changed meanwhile' }] }, { label: 'Describe' });
    let_go();
    world.importGate = null;
    await expect(late).resolves.toMatchObject({ ok: false, code: 'stale' });
    expect(spools()).toEqual([]);
  });

  it('lands nothing, no library record and no entry, when its records cannot be written', async () => {
    const { s, world, deps } = await setup();
    const assets = Object.keys(s.state.assets.assets).length;
    world.records = [person('1', 'Ana', { values: { nope: 'x' } })];
    const r = await syncSource(deps, 'people');
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.message).toMatch(/no field "nope"/);
    // Found before any picture is brought into the library (#678): its file is never written.
    expect(r).toMatchObject({ code: 'invalid' });
    expect(world.imports).toBe(0);
    expect(Object.keys(s.state.assets.assets)).toHaveLength(assets);
    expect(Object.keys(s.state.collections.team.entries)).toEqual([]);
    expect(s.state.collections.team.settings.sourceId).toBeUndefined();
  });

  it('never lets an undo take away a picture a synced entry found in the library', async () => {
    const { dir, s, world, deps } = await setup();
    // The author adds Ana's picture by hand first; the sync then finds the same bytes in the library.
    const { record } = await importPackageImage(dir, { name: 'Ana', mime: 'image/png', ext: '.png', bytes: await png(10) }, Object.values(s.state.assets.assets));
    const added = await s.apply({ operations: [{ type: 'asset.add', asset: record }] }, { label: 'Add Ana' });
    expect(added.ok).toBe(true);
    world.records = [person('1', 'Ana')];
    await expect(syncSource(deps, 'people')).resolves.toMatchObject({ ok: true, created: 1, images: 0 });
    expect(s.state.collections.team.entries[syncedEntryId('people', '1', () => false)].featuredImage).toBe(record.id);
    const undo = await s.undo();
    expect(undo.ok).toBe(false);
    expect(undo.error?.message).toMatch(/“Ana” in the Team collection uses/);
    expect(s.state.assets.assets[record.id]).toBeDefined();
  });

  it('refuses a sync whose secret is not saved, before anything is read', async () => {
    const { s, world, deps } = await setup();
    await deps.secrets.set(s.state.manifest.projectId, 'people-token', null);
    const r = await syncSource(deps, 'people');
    expect(r).toMatchObject({ ok: false, code: 'secrets' });
    expect(world.reads).toBe(0);
  });
});

describe('a source’s settings in the project', () => {
  it('are changed only in the editor, kept while a collection syncs from them, and undone like any edit', async () => {
    const { dir, s, world, deps } = await setup();
    for (const op of [
      { type: 'source.remove', sourceId: 'people' },
      { type: 'source.upsert', sourceId: 'people', name: 'Renamed by the AI', adapter: 'fixture', collectionId: 'team', config: {} }
    ] as EditOperation[]) {
      const ai = await s.apply({ operations: [op] }, { label: 'Change', source: 'ai' });
      expect(ai.error?.code, op.type).toBe('SCOPE_MISMATCH');
    }
    expect(JSON.parse(readFileSync(join(dir, 'siteorigin/sources/people/source.json'), 'utf8')).name).toBe('People API');
    // Nor may an edit pass the sync's grant to write a collection, synced or not.
    const local = await s.apply({ operations: [{ type: 'collection.create', collectionId: 'news', name: 'News', route: '/news/' }, { type: 'entry.create', collectionId: 'news', entryId: 'en_news1', title: 'Hello' }] as EditOperation[] }, { label: 'News' });
    expect(local.ok).toBe(true);
    const granted = await s.apply(
      { operations: [{ type: 'entry.update', collectionId: 'news', entryId: 'en_news1', title: 'Rewritten' }] },
      { label: 'Sync', source: 'system', history: false, sourceSync: { sourceId: 'people', collectionId: 'team', provenance: {} } }
    );
    expect(granted.error?.code).toBe('SCOPE_MISMATCH');
    expect(s.state.collections.news.entries.en_news1.title).toBe('Hello');
    world.records = [person('1', 'Ana')];
    await expect(syncSource(deps, 'people')).resolves.toMatchObject({ ok: true });
    const attached = await s.apply({ operations: [{ type: 'source.remove', sourceId: 'people' }] }, { label: 'Remove' });
    expect(attached.error?.message).toMatch(/Detach it from the source first/);
    // Detached, its entries stay as local ones, and the source can go.
    const gone = await s.apply({ operations: [{ type: 'collection.update', collectionId: 'team', sourceId: null }, { type: 'source.remove', sourceId: 'people' }] }, { label: 'Detach and remove' });
    expect(gone.error?.message).toBeUndefined();
    expect(existsSync(join(dir, 'siteorigin/sources/people'))).toBe(false);
    expect(Object.keys(s.state.collections.team.entries)).toHaveLength(1);
    await s.undo();
    expect(JSON.parse(readFileSync(join(dir, 'siteorigin/sources/people/source.json'), 'utf8')).name).toBe('People API');
    // A credential given as a value, under any name, is never saved, and never repeated.
    for (const credentials of [{ token: SECRET }, { [SECRET.replace(/-/g, '_')]: { $secret: 'people-token', extra: SECRET } }]) {
      const leaked = await s.apply({ operations: [{ type: 'source.upsert', sourceId: 'people', name: 'People API', adapter: 'fixture', collectionId: 'team', config: { credentials: credentials as never } }] }, { label: 'Change' });
      expect(leaked.error?.code).toBe('INVALID_ARGUMENT');
      expect(JSON.stringify(leaked.error)).not.toContain(SECRET);
      expect(JSON.stringify(leaked.error)).not.toContain(SECRET.replace(/-/g, '_'));
    }
    expect(readFileSync(join(dir, 'siteorigin/sources/people/source.json'), 'utf8')).not.toContain(SECRET);
  });

  it('are never taken away by an undo while a collection syncs from them', async () => {
    const { s, world, deps } = await setup();
    // A second source, added on its own, synced into a collection of its own.
    const made = await s.apply({ operations: [{ type: 'collection.create', collectionId: 'crew', name: 'Crew', kind: 'structured', pages: { detail: false, archive: false } }] as EditOperation[] }, { label: 'Crew' });
    expect(made.ok).toBe(true);
    const added = await s.apply({ operations: [{ type: 'source.upsert', sourceId: 'crew-api', name: 'Crew API', adapter: 'fixture', collectionId: 'crew', config: { credentials: { token: { $secret: 'people-token' } } } }] }, { label: 'Add Crew API' });
    expect(added.ok).toBe(true);
    world.records = [person('1', 'Ana', { values: {} })];
    await expect(syncSource(deps, 'crew-api')).resolves.toMatchObject({ ok: true, created: 1 });
    const undo = await s.undo();
    expect(undo.ok).toBe(false);
    expect(undo.error?.message).toMatch(/sources inconsistent/);
    expect(s.state.sources?.['crew-api']).toBeDefined();
  });

  it('keep a sync out of the step a coalesced edit merges into', async () => {
    const { s, world, deps } = await setup();
    const rename = (name: string) => s.apply({ operations: [{ type: 'collection.update', collectionId: 'team', name }] }, { label: 'Rename', coalesceKey: 'rename-team' });
    expect((await rename('Team A')).ok).toBe(true);
    world.records = [person('1', 'Ana')];
    await expect(syncSource(deps, 'people')).resolves.toMatchObject({ ok: true });
    expect((await rename('Team B')).ok).toBe(true);
    const steps = s.historyInfo().entries.length;
    // Its own step: undoing it takes back the second rename, and leaves the sync's attachment.
    await s.undo();
    expect(s.historyInfo().entries.filter((e) => e.applied)).toHaveLength(steps - 1);
    expect(s.state.collections.team.settings).toMatchObject({ name: 'Team A', sourceId: 'people' });
  });

  it('stop the project opening when one holds a credential, without repeating it', async () => {
    const { dir, s } = await setup();
    await s.close();
    const file = join(dir, 'siteorigin/sources/people/source.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...doc, config: { credentials: { token: SECRET } } }));
    const read = await readState(dir).catch((e: Error) => e);
    expect(read).toBeInstanceOf(ProjectFormatError);
    expect((read as Error).message).toMatch(/siteorigin\/sources\/people\/source\.json cannot be used: one of its credentials holds a value/);
    // Nor is the name of the slot it was written under repeated, which may itself be the credential.
    writeFileSync(file, JSON.stringify({ ...doc, config: { credentials: { [SECRET.replace(/-/g, '_')]: SECRET } } }));
    expect(((await readState(dir).catch((e: Error) => e)) as Error).message).not.toContain(SECRET.replace(/-/g, '_'));
    expect((read as Error).message).not.toContain(SECRET);
    // A credential under a setting no source takes yet is refused too.
    writeFileSync(file, JSON.stringify({ ...doc, config: { apiKey: SECRET } }));
    const unknown = await readState(dir).catch((e: Error) => e);
    expect(unknown).toBeInstanceOf(ProjectFormatError);
    expect((unknown as Error).message).not.toContain(SECRET);
    writeFileSync(file, `{"id": "people", "token": "${SECRET}"`);
    const broken = await readState(dir).catch((e: Error) => e);
    expect((broken as Error).message).toBe('Could not read siteorigin/sources/people/source.json: it is not valid JSON.');
  });

  it('go out with an exported project as the project holds them, and no credential file goes with them', async () => {
    const { dir, s } = await setup();
    // A refused hand edit still on disk, a copy an editor left, and credential files that should never be there.
    const file = join(dir, 'siteorigin/sources/people/source.json');
    writeFileSync(file, JSON.stringify({ id: 'people', token: SECRET }));
    writeFileSync(`${file}.bak`, SECRET);
    writeFileSync(join(dir, 'source-secrets.json'), SECRET);
    mkdirSync(join(dir, 'static/deep'), { recursive: true });
    writeFileSync(join(dir, 'static/deep/source-secrets.json~'), SECRET);
    writeFileSync(join(dir, 'static/deep/api-keys.json'), SECRET);
    writeFileSync(join(dir, 'static/deep/.API-KEYS.json.swp'), SECRET);
    writeFileSync(join(dir, 'static/deep/api-keys (1).json'), SECRET);
    writeFileSync(join(dir, 'static/deep/source-secrets copy.json'), SECRET);
    // An export stops rather than carry a source's settings other than the project holds them.
    expect(await exportedSourcesProblem(dir, s.state, [SECRET])).toMatch(/source\.json was changed outside SiteOrigin Builder/);
    const dest = join(temp('so-export-'), 'project');
    await copyProjectSource(dir, dest);
    await writeExportedSources(dest, s.state, { keep: true });
    for (const f of files(dest)) expect(readFileSync(f).includes(Buffer.from(SECRET)), relative(dest, f)).toBe(false);
    expect(readdirSync(join(dest, 'siteorigin/sources/people'))).toEqual(['source.json']);
    expect(JSON.parse(readFileSync(join(dest, 'siteorigin/sources/people/source.json'), 'utf8'))).toEqual(s.state.sources!.people);
    expect(inProjectSource(dir, join(dir, 'static/deep/source-secrets.json~'))).toBe(false);
    expect(inProjectSource(dir, join(dir, 'static/deep/.API-KEYS.json.swp'))).toBe(false);
    // A library image named after them is no credential file; every copy's spelling of one is, at once whatever its name.
    writeFileSync(join(dir, 'static/deep/api-keys-guide-1a2b3c4d.png'), 'png');
    expect(inProjectSource(dir, join(dir, 'static/deep/api-keys-guide-1a2b3c4d.png'))).toBe(true);
    for (const name of ['source-secrets (copy).json', 'Copy of api-keys.json', 'api-keys copy 2.json', '#source-secrets.json#']) expect(isPrivateFileName(name), name).toBe(true);
    for (const name of ['api-keys.jsonc', 'api-keys.json-diagram.png', 'api-keys-guide.json']) expect(isPrivateFileName(name), name).toBe(false);
    const started = Date.now();
    expect(isPrivateFileName(`api-keys${'1'.repeat(20000)}.png`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
    // Put back as the project holds them, however laid out, the settings go out; holding a saved secret in their name,
    // they do not.
    writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(join(dest, 'siteorigin/sources/people/source.json'), 'utf8'))));
    expect(await exportedSourcesProblem(dir, s.state, [SECRET])).toBeNull();
    expect(await exportedSourcesProblem(dir, s.state, ['People API'])).toMatch(/hold one of your secrets/);
    // Nor does a pipe where the settings should be hold the check up.
    if (process.platform !== 'win32') {
      rmSync(file);
      execFileSync('mkfifo', [file]);
      expect(await exportedSourcesProblem(dir, s.state, [])).toMatch(/changed outside SiteOrigin Builder/);
    }
    // A website build carries no source at all.
    await writeExportedSources(dest, s.state, { keep: false });
    expect(existsSync(join(dest, 'siteorigin/sources'))).toBe(false);
  });
});
