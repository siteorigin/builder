/**
 * `npm run sync` in an exported project (#680): the project's external sources synced into its entry files and
 * library images by the app's own sync, built into one script that needs only Node, signed in with secrets from the
 * environment. Every file lands or none does, a sync cut short is finished by the next, an unchanged source writes
 * nothing, and the exported project's generated pages and build settings are left as they were.
 */
import { createServer, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  utilityProcess: { fork: () => new EventEmitter() }
}));

const { ProjectSession } = await import('../../src/main/project/session');
const { readState } = await import('../../src/main/project/documents');
const { createStarterState } = await import('@catalogue/starters');
const { createSyncRunner } = await import('../../src/main/sources/client');
const { runSync } = await import('../../src/main/sources/run');
const { ADAPTERS } = await import('../../src/main/sources/adapters');
const { commitWrites, finishPending, PENDING_DIR, secretEnvName, secretsFromEnv, syncProject, SyncCliError } = await import('../../src/main/sources/standalone');
const { copyProjectSource, finishExportedSource, isGeneratedReadme, projectReadme, SYNC_COMMAND, SYNC_SCRIPT, writeExportedSources, writeSyncScript } = await import('../../src/main/export');
const { buildSyncCli, syncPacks } = await import('../../scripts/sync-cli');
const { getTheme } = await import('@catalogue/index');
import type { SyncHandle } from '../../src/main/sources/client';
import type { SyncReply, SyncRequest } from '../../src/main/sources/protocol';
import type { EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';

vi.setConfig({ testTimeout: 60_000 });
const SECRET = 'tok-0a1b2c3d4e5f6a7b';
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const temp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), name));
  dirs.push(d);
  return d;
};

/** A custom API on this computer: its team, behind a bearer token, as `people()` says it is now. */
async function api(people: () => unknown[]) {
  const seen: string[] = [];
  const s = createServer((req, res) => {
    seen.push(req.url ?? '');
    const ok = req.headers.authorization === `Bearer ${SECRET}`;
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { data: people() } : {}));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${(s.address() as { port: number }).port}`, seen };
}

const person = (id: string, name: string, role: string, photo?: string) => ({ id, name, role, joined: '2026-03-04', ...(photo ? { photo } : {}) });

/** A project with a Team collection synced from the API by a mapping that names its token, written and closed. */
async function project(origin: string, removal?: 'remove', mapping: Record<string, unknown> = {}): Promise<string> {
  const dir = temp('so-sync-cli-');
  const s = await ProjectSession.create(dir, createStarterState('business', 'Crew', false));
  const r = await s.apply(
    {
      operations: [
        { type: 'collection.create', collectionId: 'team', name: 'Team', kind: 'structured', pages: { detail: true, archive: true }, route: '/team/', fields: { role: { type: 'string', label: 'Role', default: '' } } },
        {
          type: 'source.upsert',
          sourceId: 'crew',
          name: 'Crew API',
          adapter: 'rest',
          collectionId: 'team',
          config: { url: `${origin}/v1/people`, itemsPath: 'data', headers: { Authorization: 'Bearer ${secret:crew-token}' } },
          mapping: { externalId: 'id', title: 'name', publishedAt: 'joined', featuredImageUrl: 'photo', values: { role: 'role' }, ...mapping },
          ...(removal ? { removal } : {})
        }
      ] as EditOperation[]
    },
    { label: 'Connect' }
  );
  expect(r.error?.message).toBeUndefined();
  await s.close();
  return dir;
}

/** The sync worker, run in this process, with every picture the same small PNG. */
async function inline() {
  const png = await sharp({ create: { width: 6, height: 4, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
  const fetched: string[] = [];
  const spawn = (): SyncHandle => {
    const e = new EventEmitter();
    return {
      postMessage: (m: SyncRequest) => void runSync(m, { adapters: ADAPTERS, fetchImage: async (url) => (fetched.push(url), { bytes: new Uint8Array(png), mime: 'image/png' }) }).then((reply: SyncReply) => e.emit('message', reply)),
      on: (ev: string, l: (x: never) => void) => (e.on(ev, l as (x: unknown) => void), undefined),
      kill: () => true
    } as unknown as SyncHandle;
  };
  return { runner: createSyncRunner(spawn), fetched };
}

/** Every file under `root` but the editor's own folder, with when it was last written. */
const fileTimes = (root: string, under = '') =>
  readdirSync(join(root, under), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && !d.parentPath.includes('.siteorigin'))
    .map((d) => `${join(d.parentPath, d.name).slice(root.length)}@${statSync(join(d.parentPath, d.name)).mtimeMs}`)
    .sort();
const env = { CREW_TOKEN: SECRET };
const now = () => new Date('2026-11-26T09:00:00Z');

describe('syncing a project without the app', () => {
  it('writes the entries, their collection and their pictures, then nothing more while the source is unchanged', async () => {
    // Two addresses, the same picture: the library takes it once.
    let people = [person('1', 'Ana Ruiz', 'Architect', 'https://images.example.test/ana.png'), person('2', 'Ben Okafor', 'Engineer', 'https://cdn.example.test/ben.png')];
    const server = await api(() => people);
    const dir = await project(server.origin);
    const generated = fileTimes(dir, 'src');
    const { runner, fetched } = await inline();
    const lines: string[] = [];
    expect(await syncProject(dir, { env, runner, now, log: (l) => lines.push(l) })).toEqual([{ sourceId: 'crew', created: 2, updated: 0, removed: 0, unpublished: 0, images: 1 }]);
    expect(lines).toEqual(['Crew API: 2 added, 0 updated, 0 made drafts, 0 removed, 0 unchanged, 1 new pictures.']);
    expect(fetched.sort()).toEqual(['https://cdn.example.test/ben.png', 'https://images.example.test/ana.png']);
    // Read back as the app reads the project: attached, each entry saying where it came from, the picture in the library.
    const state = await readState(dir);
    expect(state.collections.team.settings.sourceId).toBe('crew');
    const ana = Object.values(state.collections.team.entries).find((e) => e.title === 'Ana Ruiz')!;
    expect(ana).toMatchObject({ slug: 'ana-ruiz', publishedAt: '2026-03-04', draft: false, values: { role: 'Architect' }, source: { sourceId: 'crew', externalId: '1', syncedAt: now().toISOString() } });
    const picture = state.assets.assets[ana.featuredImage!];
    expect(picture).toMatchObject({ kind: 'image', mime: 'image/png', width: 6, height: 4 });
    expect(picture.file).toMatch(/^static\/assets\/ana-[0-9a-f]{8}\.png$/);
    expect(existsSync(join(dir, picture.file))).toBe(true);
    const ben = Object.values(state.collections.team.entries).find((e) => e.title === 'Ben Okafor')!;
    expect(ben.featuredImage).toBe(ana.featuredImage);
    expect(Object.values(state.assets.assets).filter((a) => a.mime === 'image/png' && a.hash === picture.hash)).toHaveLength(1);
    // No secret anywhere in the project, and the generated site and its build settings untouched.
    for (const f of readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile())) expect(readFileSync(join(f.parentPath, f.name)).includes(SECRET), f.name).toBe(false);
    expect(fileTimes(dir, 'src')).toEqual(generated);
    expect(existsSync(join(dir, PENDING_DIR))).toBe(false);
    // Unchanged: no file is written again.
    const synced = fileTimes(dir);
    expect(await syncProject(dir, { env, runner, now: () => new Date('2026-11-27T09:00:00Z') })).toEqual([{ sourceId: 'crew', created: 0, updated: 0, removed: 0, unpublished: 0, images: 0 }]);
    expect(fileTimes(dir)).toEqual(synced);
    // A record gone and one renamed: the gone one is made a draft (the source's removal setting), the renamed one keeps its file name and ID.
    people = [person('2', 'Ben O.', 'Engineer', 'https://cdn.example.test/ben.png')];
    expect(await syncProject(dir, { env, runner, now })).toEqual([{ sourceId: 'crew', created: 0, updated: 1, removed: 0, unpublished: 1, images: 0 }]);
    const after = await readState(dir);
    expect(Object.values(after.collections.team.entries).map((e) => [e.title, e.draft]).sort()).toEqual([
      ['Ana Ruiz', true],
      ['Ben O.', false]
    ]);
  });

  it('says which records have links that kept only their words, on every sync until the source puts them right (#1426)', async () => {
    const server = await api(() => [{ ...person('1', 'Ana Ruiz', 'Architect'), bio: '<p>See <a href="/work/">her work</a>.</p>' }, person('2', 'Ben Okafor', 'Engineer')]);
    const dir = await project(server.origin, undefined, { body: 'bio', bodyFormat: 'html' });
    const { runner } = await inline();
    const dropped = 'Crew API: A link keeps only its words: its address is not one an entry can keep (in “Ana Ruiz”). Give it a web address at the source.';
    const lines: string[] = [];
    await syncProject(dir, { env, runner, now, log: (l) => lines.push(l) });
    expect(lines).toEqual([dropped, 'Crew API: 2 added, 0 updated, 0 made drafts, 0 removed, 0 unchanged, 0 new pictures.']);
    lines.length = 0;
    await syncProject(dir, { env, runner, now, log: (l) => lines.push(l) });
    expect(lines).toEqual([dropped, 'Crew API: up to date (2 unchanged).']);
  });

  it('writes nothing when a source cannot be read, or its secret is not set', async () => {
    const server = await api(() => [person('1', 'Ana Ruiz', 'Architect')]);
    const dir = await project(server.origin);
    const { runner } = await inline();
    const before = fileTimes(dir);
    await expect(syncProject(dir, { env: {}, runner, now })).rejects.toThrow('Set CREW_TOKEN to the secret the project\'s sources sign in with, then sync again.');
    expect(server.seen).toEqual([]);
    await expect(syncProject(dir, { env: { CREW_TOKEN: 'tok-wrong-0000' }, runner, now })).rejects.toThrow(/“Crew API” was not synced: the source refused its credentials/);
    expect(fileTimes(dir)).toEqual(before);
    expect(secretEnvName('contentful-token')).toBe('CONTENTFUL_TOKEN');
    const named = (n: string) => ({ config: { headers: { Authorization: `Bearer \${secret:${n}}` } } }) as never;
    expect(() => secretsFromEnv([named('crew-token')], { CREW_TOKEN: 'ab' })).toThrow('CREW_TOKEN is shorter than any secret can be.');
    expect(() => secretsFromEnv([named('crew-token'), named('CREW_TOKEN')], { CREW_TOKEN: SECRET })).toThrow(/are both read from CREW_TOKEN/);
  });

  it('never writes a record that holds the secret it was sent', async () => {
    const server = await api(() => [person('1', `Ana ${SECRET}`, 'Architect')]);
    const dir = await project(server.origin);
    const { runner } = await inline();
    const before = fileTimes(dir);
    await expect(syncProject(dir, { env, runner, now })).rejects.toBeInstanceOf(SyncCliError);
    expect(fileTimes(dir)).toEqual(before);
  });

  it('finishes a first sync cut short before its collection was attached, then syncs on', async () => {
    const server = await api(() => [person('1', 'Ana Ruiz', 'Architect'), person('2', 'Ben Okafor', 'Engineer')]);
    const dir = await project(server.origin);
    const { runner } = await inline();
    // What the first sync writes, staged; it was cut short after the first entry was moved into place, before the
    // collection's settings (which attach it to the source) were.
    const scratch = temp('so-sync-plan-');
    cpSync(dir, scratch, { recursive: true });
    await syncProject(scratch, { env, runner, now });
    const entries = readdirSync(join(scratch, 'siteorigin/collections/team/entries')).map((f) => `siteorigin/collections/team/entries/${f}`);
    const writes = [...entries, 'siteorigin/collections/team/collection.json'].map((rel) => ({ rel, data: readFileSync(join(scratch, rel), 'utf8') }));
    const pending = join(dir, PENDING_DIR);
    mkdirSync(pending, { recursive: true });
    writes.forEach((w, i) => i > 0 && writeFileSync(join(pending, String(i)), w.data));
    writeFileSync(join(pending, 'plan.json'), JSON.stringify(writes.map((w, i) => ({ rel: w.rel, staged: String(i), sha: createHash('sha256').update(w.data).digest('hex') }))));
    mkdirSync(join(dir, 'siteorigin/collections/team/entries'), { recursive: true });
    writeFileSync(join(dir, writes[0].rel), writes[0].data);
    expect(JSON.parse(readFileSync(join(dir, 'siteorigin/collections/team/collection.json'), 'utf8')).sourceId).toBeUndefined();
    // The next sync puts the rest in place first, so the collection is the source's again and nothing is refused.
    const lines: string[] = [];
    expect(await syncProject(dir, { env, runner, now, log: (l) => lines.push(l) })).toEqual([{ sourceId: 'crew', created: 0, updated: 0, removed: 0, unpublished: 0, images: 0 }]);
    expect(lines[0]).toBe('Finished the files of a sync that was cut short.');
    expect((await readState(dir)).collections.team.settings.sourceId).toBe('crew');
    expect(await finishPending(dir)).toBe(false);
  });

  it('takes away the entry of a record the source no longer has, when its settings say so', async () => {
    let people = [person('1', 'Ana Ruiz', 'Architect'), person('2', 'Ben Okafor', 'Engineer')];
    const server = await api(() => people);
    const dir = await project(server.origin, 'remove');
    const { runner } = await inline();
    await syncProject(dir, { env, runner, now });
    const files = () => readdirSync(join(dir, 'siteorigin/collections/team/entries')).sort();
    expect(files()).toHaveLength(2);
    people = [person('2', 'Ben Okafor', 'Engineer')];
    expect(await syncProject(dir, { env, runner, now })).toEqual([{ sourceId: 'crew', created: 0, updated: 0, removed: 1, unpublished: 0, images: 0 }]);
    expect(files()).toHaveLength(1);
    expect(Object.values((await readState(dir)).collections.team.entries).map((e) => e.title)).toEqual(['Ben Okafor']);
  });

  it('brings a picture two sources show into the library once', async () => {
    const shared = 'https://images.example.test/studio.png';
    const server = await api(() => [person('1', 'Ana Ruiz', 'Architect', shared)]);
    const dir = await project(server.origin);
    // A second collection synced from a second source, showing the very same picture.
    const s = await ProjectSession.open(dir, 'second');
    const r = await s.apply(
      {
        operations: [
          { type: 'collection.create', collectionId: 'guests', name: 'Guests', kind: 'structured', pages: { detail: false, archive: false }, fields: { role: { type: 'string', label: 'Role', default: '' } } },
          { type: 'source.upsert', sourceId: 'guests', name: 'Guests API', adapter: 'rest', collectionId: 'guests', config: { url: `${server.origin}/v1/guests`, itemsPath: 'data', headers: { Authorization: 'Bearer ${secret:crew-token}' } }, mapping: { externalId: 'id', title: 'name', featuredImageUrl: 'photo', values: { role: 'role' } } }
        ] as EditOperation[]
      },
      { label: 'Guests' }
    );
    expect(r.error?.message).toBeUndefined();
    await s.close();
    const { runner } = await inline();
    expect((await syncProject(dir, { env, runner, now })).map((x) => [x.sourceId, x.created, x.images])).toEqual([
      ['crew', 1, 1],
      ['guests', 1, 0]
    ]);
    const state = await readState(dir);
    const [crew] = Object.values(state.collections.team.entries);
    const [guest] = Object.values(state.collections.guests.entries);
    expect(guest.featuredImage).toBe(crew.featuredImage);
  });

  it('never brings in a picture whose compressed text holds the secret it was sent', async () => {
    const server = await api(() => [person('1', 'Ana Ruiz', 'Architect', 'https://images.example.test/ana.png')]);
    const dir = await project(server.origin);
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    // A zTXt chunk (keyword, NUL, method 0, deflated text) just before IEND.
    const body = Buffer.concat([Buffer.from('Comment\0\0', 'latin1'), deflateSync(Buffer.from(`token=${SECRET}`))]);
    const type = Buffer.from('zTXt', 'latin1');
    const chunk = Buffer.concat([Buffer.alloc(4), type, body, Buffer.alloc(4)]);
    chunk.writeUInt32BE(body.length, 0);
    chunk.writeUInt32BE(crc32(Buffer.concat([type, body])), 8 + body.length);
    const marked = Buffer.concat([png.subarray(0, png.length - 12), chunk, png.subarray(png.length - 12)]);
    const spawn = (): SyncHandle => {
      const e = new EventEmitter();
      return {
        postMessage: (m: SyncRequest) => void runSync(m, { adapters: ADAPTERS, fetchImage: async () => ({ bytes: new Uint8Array(marked), mime: 'image/png' }) }).then((reply: SyncReply) => e.emit('message', reply)),
        on: (ev: string, l: (x: never) => void) => (e.on(ev, l as (x: unknown) => void), undefined),
        kill: () => true
      } as unknown as SyncHandle;
    };
    const before = fileTimes(dir);
    await expect(syncProject(dir, { env, runner: createSyncRunner(spawn), now })).rejects.toThrow(/holds one of your secrets/);
    expect(fileTimes(dir)).toEqual(before);
  });

  it('changes nothing when the plan of a sync cut short is damaged, or a file it names was lost', async () => {
    const dir = temp('so-sync-damaged-');
    mkdirSync(join(dir, 'siteorigin'), { recursive: true });
    writeFileSync(join(dir, 'siteorigin/site.json'), '{"keep":true}');
    const pending = join(dir, PENDING_DIR);
    mkdirSync(pending, { recursive: true });
    // A step that would take a required document away, or move a file from outside the staging folder.
    writeFileSync(join(pending, 'plan.json'), JSON.stringify([{ rel: 'siteorigin/site.json', staged: null }]));
    await expect(finishPending(dir)).rejects.toThrow(/are damaged/);
    writeFileSync(join(pending, 'plan.json'), JSON.stringify([{ rel: 'siteorigin/site.json', staged: '../../../elsewhere', sha: 'a'.repeat(64) }]));
    await expect(finishPending(dir)).rejects.toThrow(/are damaged/);
    // Neither staged nor in place: the sync is not called finished.
    writeFileSync(join(pending, 'plan.json'), JSON.stringify([{ rel: 'siteorigin/assets.json', staged: '0', sha: 'b'.repeat(64) }]));
    await expect(finishPending(dir)).rejects.toThrow(/missing/);
    // In place, but not the file the plan names: not finished either, and nothing before it moved.
    writeFileSync(join(dir, 'siteorigin/assets.json'), '{"other":true}');
    writeFileSync(join(pending, '0'), '{"staged":true}');
    writeFileSync(join(pending, 'plan.json'), JSON.stringify([
      { rel: 'siteorigin/site.json', staged: '0', sha: createHash('sha256').update('{"staged":true}').digest('hex') },
      { rel: 'siteorigin/assets.json', staged: '1', sha: 'c'.repeat(64) }
    ]));
    await expect(finishPending(dir)).rejects.toThrow(/damaged/);
    // A staged copy that is not the file the plan names, or a place that is a folder: refused before anything moves.
    writeFileSync(join(pending, '1'), '{"assets":"other"}');
    await expect(finishPending(dir)).rejects.toThrow(/damaged/);
    rmSync(join(dir, 'siteorigin/assets.json'));
    mkdirSync(join(dir, 'siteorigin/assets.json'));
    await expect(finishPending(dir)).rejects.toThrow(/is not a file/);
    expect(readFileSync(join(dir, 'siteorigin/site.json'), 'utf8')).toBe('{"keep":true}');
    expect(existsSync(join(pending, 'plan.json'))).toBe(true);
  });

  it('refuses to write outside the documents and the library', async () => {
    const dir = temp('so-sync-paths-');
    await expect(commitWrites(dir, [{ rel: 'package.json', data: '{}' }])).rejects.toThrow('A sync never writes package.json.');
    await expect(commitWrites(dir, [{ rel: 'siteorigin/collections/team/entries/../../../../x.json', data: '{}' }])).rejects.toThrow(/never writes/);
    await expect(commitWrites(dir, [{ rel: 'siteorigin/site.json', data: null }])).rejects.toThrow('A sync never takes away siteorigin/site.json.');
    // A folder on the way that is a link out of the project.
    const outside = temp('so-sync-outside-');
    mkdirSync(join(dir, 'siteorigin/collections/team'), { recursive: true });
    symlinkSync(outside, join(dir, 'siteorigin/collections/team/entries'));
    await expect(commitWrites(dir, [{ rel: 'siteorigin/collections/team/entries/en_x.json', data: '{}' }])).rejects.toThrow(/link that leads out of the project/);
    expect(readdirSync(outside)).toEqual([]);
    // Nor a file that is itself a link.
    writeFileSync(join(outside, 'site.json'), 'theirs');
    symlinkSync(join(outside, 'site.json'), join(dir, 'siteorigin/site.json'));
    await expect(commitWrites(dir, [{ rel: 'siteorigin/site.json', data: '{}' }])).rejects.toThrow(/is a link/);
    expect(readFileSync(join(outside, 'site.json'), 'utf8')).toBe('theirs');
  });
});

describe('an exported project with sources', () => {
  /** The project exported as its source, as the app writes it: its files, its sources' settings, README and sync script. */
  async function exported(dir: string, cli: string | null) {
    const dest = temp('so-sync-export-');
    await copyProjectSource(dir, dest);
    copyFileSync(join(process.cwd(), 'templates/sveltekit-brochure/files/package.json'), join(dest, 'package.json'));
    const state: ProjectState = await readState(dir);
    await writeExportedSources(dest, state, { keep: true });
    await finishExportedSource(dest, state, join(dest, 'no-notice.md'), cli);
    return { dest, state };
  }

  it('checks a sync against the shipped Foundation release, carried in the script without its files', async () => {
    const [foundation, ...others] = syncPacks();
    expect(others).toEqual([]);
    const shipped = getTheme('foundation');
    expect([foundation.id, foundation.digest, foundation.devOnly]).toEqual(['foundation', shipped.digest, undefined]);
    expect(foundation.components).toEqual(shipped.components);
    expect(foundation.tokens).toEqual(shipped.tokens);
    // Which fonts it has, and none of their files or notices.
    expect(foundation.fonts.map((f) => f.name)).toEqual(shipped.fonts.map((f) => f.name));
    expect(foundation.fonts.every((f) => f.faces.length === 0 && f.notice === '')).toBe(true);
    expect(foundation.previews).toBeUndefined();
    // The built script carries exactly that, and no preview or font file of it.
    const cli = await buildSyncCli();
    expect(cli).toContain(shipped.digest!);
    expect(cli).toContain(shipped.components[0].id);
    expect(cli).not.toMatch(/previews\/[\w.-]+\.webp/);
    expect(cli).not.toMatch(/fonts\/[\w.-]+\.woff2/);
    expect(cli).not.toContain('SIL OPEN FONT LICENSE');
  });

  it('takes the shipped releases in the app\'s order, and refuses a release folder that holds another pack', () => {
    const dir = temp('so-sync-packs-');
    cpSync(join(process.cwd(), 'resources', 'packs', 'foundation'), join(dir, 'foundation'), { recursive: true });
    expect(syncPacks(dir).map((p) => p.id)).toEqual(['foundation']);
    // Another pack whose name sorts first still follows Foundation, as the app ranks them: Foundation stays the default.
    mkdirSync(join(dir, 'aardvark'));
    writeFileSync(join(dir, 'aardvark', 'pack.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'foundation', 'pack.json'), 'utf8')), id: 'aardvark' }));
    expect(syncPacks(dir).map((p) => p.id)).toEqual(['foundation', 'aardvark']);
    rmSync(join(dir, 'aardvark'), { recursive: true });
    mkdirSync(join(dir, 'aardvark'));
    copyFileSync(join(dir, 'foundation', 'pack.json'), join(dir, 'aardvark', 'pack.json'));
    expect(() => syncPacks(dir)).toThrow(`${join(dir, 'aardvark')} holds the pack "foundation"; a release folder is named after its pack.`);
  });

  it('syncs with npm run sync, needing nothing installed, and says so in its README', async () => {
    const server = await api(() => [person('1', 'Ana Ruiz', 'Architect'), person('2', 'Ben Okafor', 'Engineer')]);
    const dir = await project(server.origin);
    const cli = await buildSyncCli();
    const { dest } = await exported(dir, cli);
    expect(readFileSync(join(dest, SYNC_SCRIPT), 'utf8')).toBe(cli);
    // With the notices of what it bundles.
    expect(cli).toMatch(/\nacorn \d+\.\d+\.\d+\n\nMIT License/);
    expect(cli).toMatch(/\nzod \d+\.\d+\.\d+\n/);
    const pkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'));
    expect(pkg.scripts).toMatchObject({ build: 'vite build', sync: SYNC_COMMAND });
    const readme = readFileSync(join(dest, 'README.md'), 'utf8');
    expect(readme).toContain('## External sources');
    expect(readme).toContain('`CONTENTFUL_TOKEN`');
    expect(isGeneratedReadme(readme)).toBe(true);
    expect(existsSync(join(dest, 'node_modules'))).toBe(false);
    const generated = fileTimes(dest, 'src');
    const run = (vars: Record<string, string>) =>
      new Promise<{ code: number; out: string }>((done) =>
        execFile(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '--silent', 'sync'], { cwd: dest, env: { ...process.env, ...vars }, shell: process.platform === 'win32' }, (e, stdout, stderr) =>
          done({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` })
        )
      );
    const missing = await run({ CREW_TOKEN: '' });
    expect(missing.code).not.toBe(0);
    expect(missing.out).toContain('Set CREW_TOKEN');
    const ok = await run({ CREW_TOKEN: SECRET });
    expect(ok, ok.out).toMatchObject({ code: 0 });
    expect(ok.out).toContain('Crew API: 2 added');
    const state = await readState(dest);
    expect(Object.values(state.collections.team.entries).map((e) => [e.title, e.values.role]).sort()).toEqual([
      ['Ana Ruiz', 'Architect'],
      ['Ben Okafor', 'Engineer']
    ]);
    // The pages a build makes are the export's own, untouched: they show the synced entries once the app writes them again.
    expect(fileTimes(dest, 'src')).toEqual(generated);
    expect(JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))).toEqual(pkg);
  });

  it('takes the script away again once the project has no sources, keeping one of the author’s own', async () => {
    const dest = temp('so-sync-own-');
    copyFileSync(join(process.cwd(), 'templates/sveltekit-brochure/files/package.json'), join(dest, 'package.json'));
    const withSources = { sources: { crew: {} } } as unknown as ProjectState;
    const none = {} as ProjectState;
    expect(await writeSyncScript(dest, withSources, '// Generated by SiteOrigin Builder. x\n')).toBe(true);
    expect(await writeSyncScript(dest, none, null)).toBe(false);
    expect(existsSync(join(dest, SYNC_SCRIPT))).toBe(false);
    expect(JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).scripts.sync).toBeUndefined();
    expect(readFileSync(join(dest, 'package.json'), 'utf8')).toBe(readFileSync(join(process.cwd(), 'templates/sveltekit-brochure/files/package.json'), 'utf8'));
    mkdirSync(join(dest, 'scripts'));
    writeFileSync(join(dest, SYNC_SCRIPT), 'console.log("mine")\n');
    expect(await writeSyncScript(dest, withSources, '// Generated by SiteOrigin Builder. x\n')).toBe(false);
    expect(await writeSyncScript(dest, none, null)).toBe(false);
    expect(readFileSync(join(dest, SYNC_SCRIPT), 'utf8')).toBe('console.log("mine")\n');
    // The author's own script, run by the same command: both stay when the sources go.
    const pkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'));
    writeFileSync(join(dest, 'package.json'), JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, sync: SYNC_COMMAND } }, null, '\t'));
    expect(await writeSyncScript(dest, none, null)).toBe(false);
    expect(JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).scripts.sync).toBe(SYNC_COMMAND);
    // A build without the script never takes away the one a copy has.
    rmSync(join(dest, SYNC_SCRIPT));
    expect(await writeSyncScript(dest, withSources, '// Generated by SiteOrigin Builder. x\n')).toBe(true);
    expect(await writeSyncScript(dest, withSources, null)).toBe(true);
    expect(readFileSync(join(dest, SYNC_SCRIPT), 'utf8')).toBe('// Generated by SiteOrigin Builder. x\n');
    expect(projectReadme('Crew', false, undefined, false, 'cloudflare', false)).not.toContain('External sources');
  });
});
