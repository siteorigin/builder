/**
 * Connecting a collection to an external source (#678), end to end in a real project: a Contentful space read by
 * field mapping and a custom REST API read by a converter.mjs are each tested (nothing written, no picture fetched),
 * saved, and synced into read-only entry files with their pictures in the library, shown on the entries' pages and in
 * the collection's archive. A converter that may not run, or records the collection cannot hold, are refused by the
 * Test with a clear reason and leave every file as it was. Detaching makes the entries local ones again.
 */
import { createServer, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const { readState } = await import('../../src/main/project/documents');
const { importPackageImage } = await import('../../src/main/project/assets');
const { createStarterState } = await import('@catalogue/starters');
const { createSyncRunner } = await import('../../src/main/sources/client');
const { runSync } = await import('../../src/main/sources/run');
const { ADAPTERS } = await import('../../src/main/sources/adapters');
const { createSecretStore } = await import('../../src/main/sources/secrets');
const { createApprovalStore } = await import('../../src/main/sources/approvals');
const { droppedLinksOf, sampleSource, syncSource } = await import('../../src/main/sources/sync');
const { applyOperations } = await import('@engine/apply');
const { generateEntry } = await import('@generator/index');
const { generateArchive } = await import('../../src/generator/archive');
const { queriedEntries } = await import('@generator/collection-query');
const { detachOps } = await import('../../src/renderer/src/lib/sources');
import type { SyncHandle } from '../../src/main/sources/client';
import type { SyncReply, SyncRequest } from '../../src/main/sources/protocol';
import type { EditOperation } from '@shared/ops';
import type { SourceSettingsDraft } from '@shared/api';
import type { ProjectState } from '@shared/types';

vi.setConfig({ testTimeout: 30_000 });
const SECRET = 'tok-9a8b7c6d5e4f3a2b';
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

/** A server on this computer answering every request with `body(url)`, counting what it was asked. */
async function server(body: (url: URL, auth: string | undefined) => { status?: number; json: unknown; headers?: Record<string, string> }) {
  const seen: string[] = [];
  const s = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seen.push(url.pathname + url.search);
    const r = body(url, req.headers.authorization);
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers });
    res.end(JSON.stringify(r.json));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${(s.address() as { port: number }).port}`, seen };
}

/** Every file of the project with when it was last written: what a Test must leave as it was. */
const fileTimes = (root: string) =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && !d.parentPath.includes('.siteorigin'))
    .map((d) => `${join(d.parentPath, d.name)}@${statSync(join(d.parentPath, d.name)).mtimeMs}`)
    .sort();

/** A project with a team collection (pages and an archive, a role field), and the sync worker run in this process. */
async function setup(endpoints: { contentful?: string } = {}) {
  const dir = temp('so-connect-');
  env.userData = temp('so-userdata-');
  const s = await ProjectSession.create(dir, createStarterState('business', 'Connect', false));
  open.push(s);
  const made = await s.apply(
    {
      operations: [
        { type: 'collection.create', collectionId: 'team', name: 'Team', kind: 'structured', pages: { detail: true, archive: true }, route: '/team/', fields: { role: { type: 'string', label: 'Role', default: '' } } }
      ] as EditOperation[]
    },
    { label: 'Add the team' }
  );
  expect(made.error?.message).toBeUndefined();
  const secrets = createSecretStore(() => join(env.userData, 'source-secrets.json'));
  await secrets.set(s.state.manifest.projectId, 'cda', SECRET);
  const picture = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 40, b: 90 } } })
    .png()
    .toBuffer();
  const fetched: string[] = [];
  const spawn = (): SyncHandle => {
    const e = new EventEmitter();
    return {
      postMessage: (m: SyncRequest) =>
        void runSync(m, { adapters: ADAPTERS, env: { endpoints }, fetchImage: async (url) => (fetched.push(url), { bytes: new Uint8Array(picture), mime: 'image/png' }) }).then((reply: SyncReply) => e.emit('message', reply)),
      on: (ev: string, l: (x: never) => void) => (e.on(ev, l as (x: unknown) => void), undefined),
      kill: () => true
    } as unknown as SyncHandle;
  };
  const approvals = createApprovalStore(() => join(env.userData, 'source-approvals.json'));
  const deps = {
    session: s,
    runner: createSyncRunner(spawn),
    secrets,
    approvals,
    current: () => true,
    spoolRoot: join(env.userData, 'source-sync'),
    importImage: async (img: { name: string; mime: string; ext: string; bytes: Uint8Array }, known: Parameters<typeof importPackageImage>[2], createdAt: string) =>
      importPackageImage(dir, { name: img.name, mime: img.mime, ext: img.ext, bytes: Buffer.from(img.bytes) }, known, undefined, createdAt)
  };
  /** Test a source's settings as the Connect dialog does: in the project with them saved, writing nothing. */
  const test = (draft: SourceSettingsDraft) => {
    const state: ProjectState = applyOperations(s.state, [{ ...draft, type: 'source.upsert' } as EditOperation]).state;
    return sampleSource(deps, state, state.sources![draft.sourceId]);
  };
  /** Save a source's settings as the Connect dialog does: tested, then approved to sign in with the user's secrets. */
  const save = async (draft: SourceSettingsDraft) => {
    const r = await s.apply({ operations: [{ ...draft, type: 'source.upsert' } as EditOperation] }, { label: 'Save the source' });
    if (r.ok) await approvals.approve(s.state.manifest.projectId, s.state.sources![draft.sourceId]);
    return r;
  };
  return { dir, s, deps, fetched, test, save };
}

/** A Contentful space's team members, with their photos included as assets. */
const cda = {
  total: 2,
  skip: 0,
  items: [
    {
      sys: { id: 'ana', createdAt: '2026-03-04T10:00:00Z' },
      fields: { title: 'Ana Ruiz', slug: 'ana-ruiz', role: 'Architect', photo: { sys: { type: 'Link', linkType: 'Asset', id: 'p1' } }, body: { nodeType: 'document', content: [{ nodeType: 'paragraph', content: [{ nodeType: 'text', value: 'Designs libraries.', marks: [] }] }] } }
    },
    { sys: { id: 'ben', createdAt: '2026-03-01T10:00:00Z' }, fields: { title: 'Ben Okafor', slug: 'ben-okafor', role: 'Engineer', photo: { sys: { type: 'Link', linkType: 'Asset', id: 'p1' } } } }
  ],
  includes: { Asset: [{ sys: { id: 'p1' }, fields: { title: 'The studio', file: { url: '//images.ctfassets.net/s/p1/team.png' } } }] }
};

const contentful = (): SourceSettingsDraft => ({
  sourceId: 'team-cms',
  name: 'Team CMS',
  adapter: 'contentful',
  collectionId: 'team',
  config: { spaceId: 'space1', contentType: 'teamMember', credentials: { token: { $secret: 'cda' } } },
  mapping: { featuredImageUrl: 'fields.photo.fields.file.url', featuredImageAlt: 'fields.photo.fields.title', values: { role: 'fields.role' } }
});

describe('connecting a collection to an external source', () => {
  it('maps a Contentful space into read-only entries with their pictures, shown on their pages and in the archive', async () => {
    const api = await server((_url, auth) => (auth === `Bearer ${SECRET}` ? { json: cda } : { status: 401, json: {} }));
    const { dir, s, deps, fetched, test, save } = await setup({ contentful: api.origin });
    const before = fileTimes(dir);
    const sample = await test(contentful());
    expect(sample).toMatchObject({ ok: true, total: 2, created: 2, updated: 0 });
    if (!sample.ok) return;
    expect(sample.raw).toHaveLength(2);
    expect(sample.records[0]).toMatchObject({ externalId: 'ana', title: 'Ana Ruiz', values: { role: 'Architect' }, featuredImage: { $image: { url: 'https://images.ctfassets.net/s/p1/team.png', alt: 'The studio' } } });
    // A Test writes nothing and fetches no picture.
    expect(fileTimes(dir)).toEqual(before);
    expect(fetched).toEqual([]);

    expect((await save(contentful())).error?.message).toBeUndefined();
    const synced = await syncSource(deps, 'team-cms');
    expect(synced).toMatchObject({ ok: true, created: 2, images: 1 });
    // The picture both show came in once, and each entry says where it came from.
    expect(fetched).toEqual(['https://images.ctfassets.net/s/p1/team.png']);
    const team = s.state.collections.team;
    expect(team.settings.sourceId).toBe('team-cms');
    const entries = Object.values(team.entries);
    const ana = entries.find((e) => e.title === 'Ana Ruiz')!;
    expect(ana).toMatchObject({ slug: 'ana-ruiz', publishedAt: '2026-03-04', values: { role: 'Architect' }, source: { sourceId: 'team-cms', externalId: 'ana' } });
    const asset = s.state.assets.assets[ana.featuredImage!];
    expect(asset).toMatchObject({ kind: 'image', mime: 'image/png' });
    expect(existsSync(join(dir, asset.file))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, `siteorigin/collections/team/entries/${ana.id}.json`), 'utf8')).source.externalId).toBe('ana');
    // Read-only here: changed in the source.
    const edit = await s.apply({ operations: [{ type: 'entry.update', collectionId: 'team', entryId: ana.id, title: 'Ana R.' }] }, { label: 'Edit' });
    expect(edit.ok).toBe(false);
    // Shown on its own page, in the collection's archive, and to any query of the collection.
    expect(generateEntry(s.state, 'team', ana.id)).toContain('Ana Ruiz');
    const archive = generateArchive(s.state, 'team', '/team/');
    expect(archive).toContain('Ana Ruiz');
    expect(archive).toContain('Ben Okafor');
    expect(queriedEntries(s.state, { collectionId: 'team' }).map((e) => e.title).sort()).toEqual(['Ana Ruiz', 'Ben Okafor']);
    // Synced again with nothing changed in the source: nothing is rewritten, and no picture fetched.
    const again = await syncSource(deps, 'team-cms');
    expect(again).toMatchObject({ ok: true, created: 0, updated: 0, unchanged: 2 });
    expect(fetched).toHaveLength(1);
  });

  it('converts a custom REST API with the project’s converter.mjs, kept beside the source’s settings', async () => {
    const people = [
      { uid: 'u1', profile: { name: 'Cara Lee', job: 'Gardener', avatar: 'https://cdn.example/cara.png' } },
      { uid: 'u2', profile: { name: 'Dev Patel', job: 'Joiner', avatar: 'https://cdn.example/dev.png' } }
    ];
    const api = await server(() => ({ json: { people } }));
    const { dir, s, deps, test, save } = await setup();
    const converter = `export function convert(items, helpers) {
  return items.map((p) => ({
    externalId: p.uid,
    title: p.profile.name,
    featuredImage: helpers.image(p.profile.avatar, { alt: p.profile.name }),
    values: { role: p.profile.job }
  }));
}
`;
    const draft: SourceSettingsDraft = { sourceId: 'crew', name: 'Crew API', adapter: 'rest', collectionId: 'team', config: { url: `${api.origin}/v1/people`, itemsPath: 'people' }, converter };
    expect(await test(draft)).toMatchObject({ ok: true, total: 2, created: 2 });
    expect((await save(draft)).error?.message).toBeUndefined();
    // The settings name the converter; its text is a file of its own, read back as it was written.
    const stored = JSON.parse(readFileSync(join(dir, 'siteorigin/sources/crew/source.json'), 'utf8'));
    expect(stored.converter).toEqual({ file: 'converter.mjs' });
    expect(readFileSync(join(dir, 'siteorigin/sources/crew/converter.mjs'), 'utf8')).toBe(converter);
    expect((await readState(dir)).sources?.crew.converter).toEqual({ file: 'converter.mjs', code: converter });
    const synced = await syncSource(deps, 'crew');
    // Both addresses serve the very same picture here, so the library keeps it once.
    expect(synced).toMatchObject({ ok: true, created: 2, images: 1 });
    expect(Object.values(s.state.collections.team.entries).map((e) => [e.title, e.values.role]).sort()).toEqual([
      ['Cara Lee', 'Gardener'],
      ['Dev Patel', 'Joiner']
    ]);
    // A copy of the project carries the converter as it is; one edited outside the app since stops it.
    const { writeExportedSources, exportedSourcesProblem } = await import('../../src/main/export');
    const copy = temp('so-connect-copy-');
    await writeExportedSources(copy, s.state, { keep: true });
    expect(readFileSync(join(copy, 'siteorigin/sources/crew/converter.mjs'), 'utf8')).toBe(converter);
    expect(JSON.parse(readFileSync(join(copy, 'siteorigin/sources/crew/source.json'), 'utf8')).converter).toEqual({ file: 'converter.mjs' });
    expect(await exportedSourcesProblem(dir, s.state, [])).toBeNull();
    writeFileSync(join(dir, 'siteorigin/sources/crew/converter.mjs'), `${converter}// edited elsewhere\n`);
    expect(await exportedSourcesProblem(dir, s.state, [])).toMatch(/converter\.mjs was changed outside/);
    writeFileSync(join(dir, 'siteorigin/sources/crew/converter.mjs'), converter);
    // Changing to a mapping takes the converter away with the settings it replaces.
    const mapped = await s.apply({ operations: [{ type: 'source.upsert', sourceId: 'crew', name: 'Crew API', adapter: 'rest', collectionId: 'team', config: draft.config, mapping: { externalId: 'uid', title: 'profile.name' } }] }, { label: 'Map' });
    expect(mapped.error?.message).toBeUndefined();
    expect(existsSync(join(dir, 'siteorigin/sources/crew/converter.mjs'))).toBe(false);
    await s.undo();
    expect(readFileSync(join(dir, 'siteorigin/sources/crew/converter.mjs'), 'utf8')).toBe(converter);
    expect(s.state.sources?.crew.converter?.code).toBe(converter);
  });

  it('never takes the user’s secret where settings changed outside the app say, until they are saved here again', async () => {
    const api = await server((_url, auth) => (auth === `Bearer ${SECRET}` ? { json: cda } : { status: 401, json: {} }));
    const elsewhere = await server(() => ({ json: { total: 0, skip: 0, items: [] } }));
    const { dir, s, deps, save } = await setup({ contentful: api.origin });
    const draft: SourceSettingsDraft = { sourceId: 'team-api', name: 'Team API', adapter: 'rest', collectionId: 'team', config: { url: `${api.origin}/team`, headers: { Authorization: 'Bearer ${secret:cda}' }, itemsPath: 'items' }, mapping: { externalId: 'sys.id', title: 'fields.title' } };
    // The REST reader reads this list of entries at its own address.
    expect((await save(draft)).error?.message).toBeUndefined();
    // A collaborator's commit points it somewhere else, keeping the secret it names.
    const file = join(dir, 'siteorigin/sources/team-api/source.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...doc, config: { ...doc.config, url: `${elsewhere.origin}/collect` } }, null, 2));
    await s.close();
    const again = await ProjectSession.open(dir, 'reopen');
    open.push(again);
    expect(again.state.sources?.['team-api'].config.url).toBe(`${elsewhere.origin}/collect`);
    expect(await syncSource({ ...deps, session: again }, 'team-api')).toMatchObject({ ok: false, code: 'unapproved' });
    expect(elsewhere.seen).toEqual([]);
    // Its name changed outside the app asks nothing again; only where and how it signs in does.
    writeFileSync(file, JSON.stringify({ ...doc, name: 'Renamed outside' }, null, 2));
    await again.close();
    const third = await ProjectSession.open(dir, 'third');
    open.push(third);
    expect(third.state.sources?.['team-api'].name).toBe('Renamed outside');
    expect(await syncSource({ ...deps, session: third }, 'team-api')).toMatchObject({ ok: true, created: 2 });
  });

  it('never syncs a source without the converter its settings name: its entries stay as they are', async () => {
    const people = [{ uid: 'u1', profile: { name: 'Cara Lee' } }];
    // Records that a reading without the converter would also take: their own id and title.
    const api = await server(() => ({ json: people.map((p) => ({ ...p, id: `other-${p.uid}`, title: 'Someone else' })) }));
    const { dir, s, deps, save } = await setup();
    const converter = 'export function convert(items) { return items.map((p) => ({ externalId: p.uid, title: p.profile.name })); }\n';
    expect((await save({ sourceId: 'crew', name: 'Crew API', adapter: 'rest', collectionId: 'team', config: { url: api.origin }, converter, removal: 'remove' })).error?.message).toBeUndefined();
    expect(await syncSource(deps, 'crew')).toMatchObject({ ok: true, created: 1 });
    const before = structuredClone(s.state.collections.team.entries);
    // The module deleted outside the app, and the project opened again.
    rmSync(join(dir, 'siteorigin/sources/crew/converter.mjs'));
    await s.close();
    const again = await ProjectSession.open(dir, 'reopen');
    open.push(again);
    expect(again.state.sources?.crew.converter).toEqual({ file: 'converter.mjs' });
    const r = await syncSource({ ...deps, session: again }, 'crew');
    expect(r).toMatchObject({ ok: false, code: 'converter', message: '“Crew API” is read by its converter.mjs, which is missing. Put it back, or choose where its details are read from instead.' });
    expect(api.seen).toHaveLength(1);
    expect(again.state.collections.team.entries).toEqual(before);
  });

  it('brings the pictures in an article’s text into the library, at their place, and never a secret put together from its parts', async () => {
    const article = {
      total: 1,
      skip: 0,
      items: [
        {
          sys: { id: 'post1', createdAt: '2026-03-04T10:00:00Z' },
          fields: {
            title: 'Opening day',
            body: {
              nodeType: 'document',
              content: [
                { nodeType: 'paragraph', content: [{ nodeType: 'text', value: 'Before.', marks: [] }] },
                { nodeType: 'embedded-asset-block', data: { target: { sys: { type: 'Link', linkType: 'Asset', id: 'pic' } } }, content: [] },
                { nodeType: 'paragraph', content: [{ nodeType: 'text', value: 'After.', marks: [] }] }
              ]
            }
          }
        }
      ],
      includes: { Asset: [{ sys: { id: 'pic' }, fields: { title: 'The ribbon', file: { url: '//images.ctfassets.net/s/pic/ribbon.png', contentType: 'image/png' } } }] }
    };
    const api = await server(() => ({ json: article }));
    const { s, deps, fetched, save } = await setup({ contentful: api.origin });
    const made = await s.apply({ operations: [{ type: 'collection.create', collectionId: 'news', name: 'News', route: '/news/' }] as EditOperation[] }, { label: 'News' });
    expect(made.error?.message).toBeUndefined();
    const draft: SourceSettingsDraft = { sourceId: 'news-cms', name: 'News CMS', adapter: 'contentful', collectionId: 'news', config: { spaceId: 'space1', contentType: 'post', credentials: { token: { $secret: 'cda' } } } };
    expect((await save(draft)).error?.message).toBeUndefined();
    expect(await syncSource(deps, 'news-cms')).toMatchObject({ ok: true, created: 1, images: 1 });
    expect(fetched).toEqual(['https://images.ctfassets.net/s/pic/ribbon.png']);
    const post = Object.values(s.state.collections.news.entries)[0];
    const [, picture] = post.body;
    expect(post.body.map((b) => b.type)).toEqual(['p', 'image', 'p']);
    expect(picture).toMatchObject({ type: 'image', alt: 'The ribbon' });
    expect(s.state.assets.assets[(picture as { assetId: string }).assetId]).toMatchObject({ kind: 'image' });

    // A converter that splits a saved secret over text runs the entry would join: refused, nothing written.
    const people = await server(() => ({ json: [{ id: 1 }] }));
    const halves = [SECRET.slice(0, 8), SECRET.slice(8)];
    const crew = await s.apply({ operations: [{ type: 'collection.create', collectionId: 'crew', name: 'Crew', route: '/crew/' }] as EditOperation[] }, { label: 'Crew' });
    expect(crew.error?.message).toBeUndefined();
    const split = { sourceId: 'crew', name: 'Crew API', adapter: 'rest', collectionId: 'crew', config: { url: people.origin }, converter: `export function convert(items) { return items.map((i) => ({ externalId: String(i.id), title: 'Hi', body: [{ type: 'p', spans: [{ text: ${JSON.stringify(halves[0])} }, { text: ${JSON.stringify(halves[1])} }] }] })); }` } as SourceSettingsDraft;
    expect((await save(split)).error?.message).toBeUndefined();
    const leaked = await syncSource(deps, 'crew');
    expect(leaked).toMatchObject({ ok: false, code: 'secret' });
    expect(s.state.collections.crew.entries).toEqual({});
  });

  it('keeps a WordPress post’s relative links going where they went, and says each sync which links kept only their words (#1426)', async () => {
    const post = (id: number, title: string, html: string) => ({ id, slug: `post-${id}`, status: 'publish', date_gmt: '2026-05-01T09:00:00', title: { rendered: title }, link: `https://old.example/news/post-${id}/`, content: { rendered: html } });
    const visiting = '<p><a href="/visit/access/?from=notice">Access</a>, <a href="../calendar/">the calendar</a>, <a href="#quiet-hours">quiet hours</a> and <a href="https://example.org/map">the map</a>.</p>';
    let broken = '<p>Book <a href="javascript:book()">here</a>.</p>';
    const api = await server(() => ({ json: [post(1, 'Visiting', visiting), post(2, 'Two', '<p>Two.</p>'), post(3, 'Three', '<p>Three.</p>'), post(4, 'Tickets', broken)], headers: { 'x-wp-totalpages': '1' } }));
    const { s, deps, test, save } = await setup();
    const made = await s.apply({ operations: [{ type: 'collection.create', collectionId: 'news', name: 'News', route: '/news/' }] as EditOperation[] }, { label: 'News' });
    expect(made.error?.message).toBeUndefined();
    const draft: SourceSettingsDraft = { sourceId: 'blog', name: 'Old blog', adapter: 'wordpress', collectionId: 'news', config: { url: api.origin } };
    // The Test names the post past the three it shows.
    const sample = await test(draft);
    expect(sample).toMatchObject({ ok: true, total: 4, created: 4, droppedLinks: { count: 1, records: 1, titles: ['Tickets'] } });
    if (!sample.ok) return;
    expect(sample.records).toHaveLength(3);

    expect((await save(draft)).error?.message).toBeUndefined();
    expect(await syncSource(deps, 'blog')).toMatchObject({ ok: true, created: 4, droppedLinks: { count: 1, records: 1, titles: ['Tickets'] } });
    const entries = Object.values(s.state.collections.news.entries);
    const linksOf = (body: unknown) =>
      (body as Array<{ spans?: Array<{ text: string; link?: { type: string; target: string } }> }>).flatMap((b) => (b.spans ?? []).map((x) => [x.text, x.link ? `${x.link.type} ${x.link.target}` : null]));
    const visited = entries.find((e) => e.title === 'Visiting')!;
    expect(linksOf(visited.body).filter(([, l]) => l)).toEqual([
      ['Access', 'url https://old.example/visit/access/?from=notice'],
      ['the calendar', 'url https://old.example/news/calendar/'],
      ['quiet hours', 'url https://old.example/news/post-1/#quiet-hours'],
      ['the map', 'url https://example.org/map']
    ]);
    const page = generateEntry(s.state, 'news', visited.id);
    for (const href of ['https://old.example/visit/access/?from=notice', 'https://old.example/news/calendar/', 'https://old.example/news/post-1/#quiet-hours', 'https://example.org/map']) expect(page).toContain(href);
    // Said again on a sync that changes nothing, until it is put right at the source.
    const revision = s.revision;
    expect(await syncSource(deps, 'blog')).toMatchObject({ ok: true, created: 0, updated: 0, unchanged: 4, droppedLinks: { count: 1, records: 1, titles: ['Tickets'] } });
    expect(s.revision).toBe(revision);
    const tickets = entries.find((e) => e.title === 'Tickets')!.id;
    expect(linksOf(s.state.collections.news.entries[tickets].body)).toEqual([['Book here.', null]]);
    broken = '<p>Book <a href="/tickets/">here</a>.</p>';
    const fixed = await syncSource(deps, 'blog');
    expect(fixed).toMatchObject({ ok: true, created: 0, updated: 1, unchanged: 3 });
    expect(fixed).not.toHaveProperty('droppedLinks');
    // The same entry, its link now kept.
    expect(Object.keys(s.state.collections.news.entries)).toHaveLength(4);
    expect(linksOf(s.state.collections.news.entries[tickets].body)).toEqual([
      ['Book ', null],
      ['here', 'url https://old.example/tickets/'],
      ['.', null]
    ]);
  });

  it('never names the records whose dropped links, put in words together, spell a secret (#1426)', () => {
    const result = { records: [{ externalId: '1', title: 'cedar-tree' }, { externalId: '2', title: 'orchid-bloom' }], droppedLinks: { count: 2, records: 2, first: [0, 1] } };
    expect(droppedLinksOf(result, [])).toEqual({ droppedLinks: { count: 2, records: 2, titles: ['cedar-tree', 'orchid-bloom'] } });
    expect(droppedLinksOf(result, ['cedar-tree” and “orchid-bloom'])).toEqual({ droppedLinks: { count: 2, records: 2, titles: [] } });
    expect(droppedLinksOf({ records: result.records }, [])).toEqual({});
  });

  it('refuses a converter that may not run, or records the collection cannot hold, at the Test, with every file left as it was', async () => {
    const api = await server(() => ({ json: [{ id: 1, name: 'Eve' }] }));
    const { dir, test } = await setup();
    const before = fileTimes(dir);
    const base: SourceSettingsDraft = { sourceId: 'crew', name: 'Crew API', adapter: 'rest', collectionId: 'team', config: { url: api.origin } };
    const unsafe = await test({ ...base, converter: 'import { readFileSync } from "node:fs";\nexport function convert(items) { return items; }' });
    expect(unsafe).toMatchObject({ ok: false, code: 'converter' });
    expect(unsafe.ok === false && unsafe.message).toMatch(/Line 1: It imports a module/);
    // Refused before the source is asked anything.
    expect(api.seen).toEqual([]);
    const wrong = await test({ ...base, converter: 'export function convert(items) { return items.map((i) => ({ externalId: String(i.id), title: i.name, values: { salary: 100 } })); }' });
    expect(wrong).toMatchObject({ ok: false, code: 'invalid' });
    expect(wrong.ok === false && wrong.message).toMatch(/“Crew API” could not be synced as it is: .*no field "salary"/);
    const untitled = await test({ ...base, mapping: { title: 'fullName' } });
    expect(untitled).toMatchObject({ ok: false, code: 'invalid' });
    expect(untitled.ok === false && untitled.message).toMatch(/record 1 has no title at fullName/);
    expect(fileTimes(dir)).toEqual(before);
  });

  it('detaches into a local collection: no source on the collection or its entries, which are edited as any other', async () => {
    const api = await server(() => ({ json: cda }));
    const { dir, s, deps, save } = await setup({ contentful: api.origin });
    expect((await save(contentful())).error?.message).toBeUndefined();
    expect(await syncSource(deps, 'team-cms')).toMatchObject({ ok: true, created: 2 });
    const ids = Object.keys(s.state.collections.team.entries);
    const detached = await s.apply({ operations: detachOps(s.state, 'team') }, { label: 'Detach' });
    expect(detached.error?.message).toBeUndefined();
    expect(s.state.collections.team.settings).not.toHaveProperty('sourceId');
    expect(s.state.sources ?? {}).not.toHaveProperty('team-cms');
    expect(existsSync(join(dir, 'siteorigin/sources/team-cms'))).toBe(false);
    for (const id of ids) {
      expect(s.state.collections.team.entries[id]).not.toHaveProperty('source');
      expect(JSON.parse(readFileSync(join(dir, `siteorigin/collections/team/entries/${id}.json`), 'utf8'))).not.toHaveProperty('source');
    }
    const edit = await s.apply({ operations: [{ type: 'entry.update', collectionId: 'team', entryId: ids[0], title: 'Edited here' }] }, { label: 'Edit' });
    expect(edit.error?.message).toBeUndefined();
    // Undone (the edit, then the detach), the collection is synced from its source again, each entry saying so.
    await s.undo();
    const back = await s.undo();
    expect(back.error?.message).toBeUndefined();
    expect(s.state.collections.team.settings.sourceId).toBe('team-cms');
    for (const id of ids) expect(s.state.collections.team.entries[id].source?.sourceId).toBe('team-cms');
  });
});
