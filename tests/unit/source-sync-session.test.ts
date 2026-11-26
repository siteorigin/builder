/**
 * Syncing an external source into a real project (#676): the records land as entry files under stable `en_` IDs, an
 * unchanged record's file is never rewritten, a record gone is drafted, pictures come into the library once however
 * often they are synced, and the secrets the source signs in with appear nowhere in the project or its exports. A
 * sync that finds the project changed under it, or a source echoing a secret back, writes nothing.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
const { copyProjectSource, inProjectSource, writeExportedSources } = await import('../../src/main/export');
import type { SyncHandle } from '../../src/main/sources/client';
import type { NormalizedRecord, SyncReply, SyncRequest } from '../../src/main/sources/protocol';
import type { EditOperation } from '@shared/ops';

const SECRET = 'tok-0a1b2c3d4e5f6a7b';
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
        { type: 'source.upsert', sourceId: 'people', name: 'People API', adapter: 'fixture', collectionId: 'team', credentials: { token: { $secret: 'people-token' } } }
      ] as EditOperation[]
    },
    { label: 'Add the team source' }
  );
  expect(r.error?.message).toBeUndefined();
  const secrets = createSecretStore(() => join(env.userData, 'source-secrets.json'));
  await secrets.set(s.state.manifest.projectId, 'people-token', SECRET);
  const pictures: Record<string, Buffer> = { 'https://cdn.example/ana.png': await png(10), 'https://cdn.example/ben.png': await png(200) };
  const world = { records: [] as NormalizedRecord[], reads: 0, fetched: [] as string[], gate: null as Promise<void> | null, signedWith: [] as string[] };
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
          fetchImage: async (url) => (world.fetched.push(url), { bytes: new Uint8Array(pictures[url]), mime: 'image/png' })
        }).then((reply: SyncReply) => e.emit('message', reply)),
      on: (ev: string, l: (x: never) => void) => (e.on(ev, l as (x: unknown) => void), undefined),
      kill: () => true
    } as unknown as SyncHandle;
  };
  const deps = {
    session: s,
    runner: createSyncRunner(spawn),
    secrets,
    current: () => true,
    importImage: (img: { name: string; mime: string; ext: string; bytes: Uint8Array }, known: Parameters<typeof importPackageImage>[2], createdAt: string) =>
      importPackageImage(dir, { name: img.name, mime: img.mime, ext: img.ext, bytes: Buffer.from(img.bytes) }, known, undefined, createdAt)
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
    world.records = [person('1', 'Ana'), person('2', 'Ben'), person('3', 'Cy', { featuredImage: { $image: { url: 'https://cdn.example/ana.png', name: 'Ana again' } } })];
    const first = await syncSource(deps, 'people');
    expect(first).toMatchObject({ ok: true, created: 3, updated: 0, unchanged: 0, images: 2 });
    // The worker signed in with the secret the source names, which the project never holds.
    expect(world.signedWith).toEqual([SECRET]);
    expect(world.fetched.sort()).toEqual(['https://cdn.example/ana.png', 'https://cdn.example/ben.png']);
    const team = s.state.collections.team;
    expect(team.settings.sourceId).toBe('people');
    const ana = team.entries[syncedEntryId('people', '1', () => false)];
    expect(ana).toMatchObject({ title: 'Ana', draft: false, source: { sourceId: 'people', externalId: '1' } });
    const assets = Object.keys(s.state.assets.assets).length;
    expect(s.state.assets.assets[ana.featuredImage!]).toMatchObject({ kind: 'image', mime: 'image/png' });
    // A sync is no step of History.
    const history = s.history.entries.length;
    // The unchanged file, dated in the past, so a rewrite would show.
    const benFile = entryFile(dir, '2');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(benFile, old, old);
    const benText = readFileSync(benFile, 'utf8');
    world.fetched = [];
    world.records = [person('1', 'Ana', { title: 'Ana Ruiz', featuredImage: { $image: { url: 'https://cdn.example/ana.png', name: 'Ana' } } }), person('2', 'Ben')];
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
    expect(s.history.entries.length).toBe(history);
    // Nothing changed at the source: nothing is written, and the project's revision stays where it was.
    const revision = s.revision;
    await expect(syncSource(deps, 'people')).resolves.toMatchObject({ ok: true, unchanged: 2, revision });
    expect(s.revision).toBe(revision);
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
    world.records = [person('1', `Ana ${SECRET}`)];
    const echoed = await syncSource(deps, 'people');
    expect(echoed).toMatchObject({ ok: false, code: 'secret' });
    expect(echoed.ok === false && echoed.message).not.toContain(SECRET);
    expect(existsSync(join(dir, 'siteorigin/collections/team/entries'))).toBe(false);
    // A project closed meanwhile: nothing lands.
    world.records = [person('1', 'Ana')];
    await expect(syncSource({ ...deps, current: () => false }, 'people')).resolves.toMatchObject({ ok: false, code: 'closed' });
    expect(Object.keys(s.state.collections.team.entries)).toEqual([]);
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
    expect(undo.error?.message).toMatch(/“Ana” in the Team collection shows/);
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
    const ai = await s.apply({ operations: [{ type: 'source.remove', sourceId: 'people' }] }, { label: 'Remove', source: 'ai' });
    expect(ai.error?.code).toBe('SCOPE_MISMATCH');
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
    // A credential given as a value, under any name, is never saved.
    const leaked = await s.apply({ operations: [{ type: 'source.upsert', sourceId: 'cms', name: 'CMS', adapter: 'fixture', collectionId: 'team', credentials: { token: SECRET as never } }] }, { label: 'Add' });
    expect(leaked.ok).toBe(false);
    expect(JSON.stringify(leaked.error)).not.toContain(SECRET);
  });

  it('stop the project opening when one holds a credential, without repeating it', async () => {
    const { dir, s } = await setup();
    await s.close();
    const file = join(dir, 'siteorigin/sources/people/source.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...doc, config: { credentials: { token: SECRET } } }));
    const read = await readState(dir).catch((e: Error) => e);
    expect(read).toBeInstanceOf(ProjectFormatError);
    expect((read as Error).message).toMatch(/siteorigin\/sources\/people\/source\.json cannot be used: its credential "token" holds a value/);
    expect((read as Error).message).not.toContain(SECRET);
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
    const dest = join(temp('so-export-'), 'project');
    await copyProjectSource(dir, dest);
    await writeExportedSources(dest, s.state, { keep: true });
    for (const f of files(dest)) expect(readFileSync(f).includes(Buffer.from(SECRET)), relative(dest, f)).toBe(false);
    expect(readdirSync(join(dest, 'siteorigin/sources/people'))).toEqual(['source.json']);
    expect(JSON.parse(readFileSync(join(dest, 'siteorigin/sources/people/source.json'), 'utf8'))).toEqual(s.state.sources!.people);
    expect(inProjectSource(dir, join(dir, 'static/deep/source-secrets.json~'))).toBe(false);
    expect(inProjectSource(dir, join(dir, 'static/deep/.API-KEYS.json.swp'))).toBe(false);
    // A website build carries no source at all.
    await writeExportedSources(dest, s.state, { keep: false });
    expect(existsSync(join(dest, 'siteorigin/sources'))).toBe(false);
  });
});
