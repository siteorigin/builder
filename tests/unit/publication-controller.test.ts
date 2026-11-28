/**
 * Preparing a publication through the controller (#1154): the published website alone, committed onto a history of
 * its own in the project's versions repository, through the real Git client and worker service (in this process).
 * Nothing a saved version or the project holds back (a draft page, a picture only it showed, the brief) is reachable
 * from it; the repository is made when there is none; whether the website changed is told by its files; and a secret,
 * a credential in an address or a missing picture stops it with the branch where it was.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetRecord, ProjectState } from '@shared/types';

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
  utilityProcess: { fork: () => undefined }
}));

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');
const { applyOperations } = await import('@engine/apply');
const { createGitClient } = await import('../../src/main/git/client');
const { createGitService } = await import('../../src/main/git/service');
const { VERSIONS_BRANCH } = await import('../../src/main/git/protocol');
const { PUBLISH_BRANCH } = await import('../../src/main/publication');
const { captureSnapshotInventory } = await import('../../src/main/project/snapshot-inventory');
const { setKey } = await import('../../src/main/settings');
const { readProject } = await import('../../src/main/project/documents');
const { editedGeneratedFile } = await import('../../src/main/export');
const { validateState } = await import('@engine/validate');
type GitRepository = import('../../src/main/git/protocol').GitRepository;
type GitWorkerHandle = import('../../src/main/git/client').GitWorkerHandle;

/** A phrase only the draft page has. */
const PHRASE = 'Embargoed winter launch 7Q2X';
const DRAFT_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="launch-teaser-only"/></svg>';
const PUBLIC_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="shelf"/></svg>';
const APP = { name: 'SiteOrigin Builder', email: 'versions@siteorigin.invalid', timestamp: 1_790_000_000, timezoneOffset: 0 };

const dirs: string[] = [];
const controllers: Array<InstanceType<typeof Controller>> = [];
const clients: Array<ReturnType<typeof createGitClient>> = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-publish-${name}-`)));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  env.userData = temp('userdata');
});
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  for (const g of clients.splice(0)) g.stop();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** The Git worker's service in this process, behind the real client: requests and replies are copied as a worker's are. */
function inProcessGit() {
  const client = createGitClient(() => {
    const on: Record<string, Array<(x?: unknown) => void>> = {};
    const emit = (e: string, x?: unknown) => (on[e] ?? []).forEach((l) => l(x));
    const service = createGitService((reply) => setImmediate(() => emit('message', structuredClone(reply))));
    let alive = true;
    return {
      postMessage: (m) => {
        if (!alive) throw new Error('gone');
        void service.handle(structuredClone(m));
      },
      on: (e: string, l: (x?: unknown) => void) => ((on[e] ??= []).push(l), undefined),
      kill: () => {
        if (!alive) return false;
        alive = false;
        setImmediate(() => emit('exit', 0));
        return true;
      }
    } as GitWorkerHandle;
  });
  clients.push(client);
  return client;
}

const image = (id: string, name: string, file: string, svg: string): AssetRecord => ({ id, name, file, mime: 'image/svg+xml', bytes: svg.length, hash: id, kind: 'image', createdAt: '2026-01-01T00:00:00.000Z' });

/**
 * A business site whose Home shares a picture of a shelf, with a draft page whose title is PHRASE sharing a picture
 * only it shows, and a brief that mentions the phrase too.
 */
async function project(edit: (state: ProjectState) => ProjectState = (s) => s, files: (dir: string) => void = () => undefined) {
  const dir = temp('project');
  let state = createStarterState('business', 'Bookshop', false);
  // A page shares its picture once the site has an address.
  state.site.baseUrl = 'https://books.example';
  state.assets.assets.shelf = image('shelf', 'Shelf', 'static/assets/shelf-11111111.svg', PUBLIC_SVG);
  state.assets.assets.launch = image('launch', 'Launch teaser', 'static/assets/launch-22222222.svg', DRAFT_SVG);
  state = applyOperations(state, [
    { type: 'page.update', pageId: state.site.homePageId, socialImage: 'shelf' },
    { type: 'page.create', pageId: 'pg_launch01', title: PHRASE, route: '/launch/' },
    { type: 'page.update', pageId: 'pg_launch01', draft: true, socialImage: 'launch' },
    { type: 'brief.update', description: `Keep ${PHRASE} quiet until spring.` }
  ]).state;
  state = edit(state);
  // The starter's own files, which a new project is made with: its tools' settings and lockfile.
  cpSync(join(process.cwd(), 'templates/sveltekit-brochure/files'), dir, { recursive: true });
  await (await ProjectSession.create(dir, state)).close();
  mkdirSync(join(dir, 'static/assets'), { recursive: true });
  writeFileSync(join(dir, 'static/assets/shelf-11111111.svg'), PUBLIC_SVG);
  writeFileSync(join(dir, 'static/assets/launch-22222222.svg'), DRAFT_SVG);
  files(dir);
  return dir;
}

async function open(dir: string) {
  const c = new Controller(() => null);
  c.send = () => undefined;
  c.startRuntime = async () => undefined;
  controllers.push(c);
  const git = inProcessGit();
  c.repository = (root) => git.repository(root);
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  await vi.waitFor(() => expect(c.snapshot()).not.toBeNull());
  return { c, repo: git.repository(dir) };
}

/** The files of commit `oid`, written into the empty folder `dir`, as a checkout of it would be. */
async function checkout(repo: GitRepository, oid: string, dir: string) {
  const walk = async (tree: string, base: string) => {
    for (const e of await repo.readTree(tree)) {
      const p = join(base, e.path);
      if (e.type === 'tree') {
        mkdirSync(p, { recursive: true });
        await walk(e.oid, p);
      } else writeFileSync(p, await repo.readBlob(e.oid));
    }
  };
  await walk((await repo.readCommit(oid)).tree, dir);
}

/** Every commit, path and blob reachable from a branch, through every parent. */
async function reachable(repo: GitRepository, ref: string) {
  const blobs = new Map<string, string>();
  const paths = new Set<string>();
  const commits: Array<{ oid: string; parents: string[]; message: string }> = [];
  const walk = async (tree: string, base: string) => {
    for (const e of await repo.readTree(tree)) {
      const p = base ? `${base}/${e.path}` : e.path;
      if (e.type === 'tree') await walk(e.oid, p);
      else {
        paths.add(p);
        if (!blobs.has(e.oid)) blobs.set(e.oid, Buffer.from(await repo.readBlob(e.oid)).toString('utf8'));
      }
    }
  };
  for (const c of await repo.listCommits(ref, 1000)) {
    commits.push({ oid: c.oid, parents: c.parents, message: c.message });
    await walk(c.tree, '');
  }
  return { blobs, paths, commits, text: [...blobs.values(), ...commits.map((c) => c.message), ...paths].join('\n') };
}

// Each preparation stages, projects and hashes the whole site: several in one test take a while on a busy machine.
describe('preparing a publication', { timeout: 30_000 }, () => {
  it('leaves a deleted draft page and its picture, saved in a version first, unreachable from the publication', async () => {
    const dir = await project();
    // A saved version of the project as it is, the draft and its picture included.
    const inv = await captureSnapshotInventory(dir, { settleMs: 0 });
    const files = await Promise.all(inv.tree.map(async (f) => ({ path: f.path, bytes: await f.read() })));
    const { c, repo } = await open(dir);
    await repo.init();
    const saved = await repo.writeFiles(files);
    const version = await repo.writeCommit({ tree: saved, parents: [], author: APP, committer: APP, message: 'Saved\n' });
    await repo.advanceRef(VERSIONS_BRANCH, version, null);
    const local = await reachable(repo, VERSIONS_BRANCH);
    expect(local.text).toContain(PHRASE);
    expect(local.paths.has('static/assets/launch-22222222.svg')).toBe(true);
    // Both deleted (the picture's file stays on disk, kept for undo).
    expect((await c.apply({ operations: [{ type: 'page.remove', pageId: 'pg_launch01' }, { type: 'asset.remove', assetId: 'launch' }] })).ok).toBe(true);
    expect(existsSync(join(dir, 'static/assets/launch-22222222.svg'))).toBe(true);

    const r = await c.preparePublication();
    expect(r).toMatchObject({ ok: true, changed: true });
    const published = await reachable(repo, PUBLISH_BRANCH);
    expect(published.commits).toHaveLength(1);
    expect(published.commits[0].parents, 'the first publication is a root commit').toEqual([]);
    expect(published.text).not.toContain(PHRASE);
    expect(published.text).not.toContain('Launch teaser');
    expect(published.text).not.toContain('launch-22222222');
    expect([...published.blobs.values()]).not.toContain(DRAFT_SVG);
    // The saved version still has them, and the picture both show is one blob in both histories.
    expect((await reachable(repo, VERSIONS_BRANCH)).text).toContain(PHRASE);
    const shelf = [...published.blobs].find(([, b]) => b === PUBLIC_SVG)?.[0];
    expect(shelf).toBeDefined();
    expect(local.blobs.has(shelf!)).toBe(true);
  });

  it('makes the repository when the project has none, and publishes the website without a current draft, the brief or editor state', async () => {
    const { defFile } = await import('@generator/index');
    // A component of the project's own, placed nowhere: the website never imports it.
    const unplaced = 'proj.launch-block-7q2x9';
    // And code of the project's own, placed nowhere, showing a library picture of its own.
    let coded = '';
    const dir = await project(
      (s) => {
        s.assets.assets.teaser = image('teaser', 'Teaser', 'static/assets/teaser-33333333.svg', DRAFT_SVG);
        const before = new Set(Object.keys(s.components));
        const next = applyOperations(s, [
          { type: 'component.create', definitionId: unplaced, name: `${PHRASE} block` },
          { type: 'component.createCode', name: 'Teaser', source: '<img src="/assets/teaser-33333333.svg" alt="" />' }
        ]).state;
        coded = Object.keys(next.components).find((id) => !before.has(id) && id !== unplaced)!;
        return next;
      },
      (d) => {
        writeFileSync(join(d, 'static/assets/teaser-33333333.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect id="teaser"/></svg>');
        // An exported project's sync script for its sources, and the command that runs it.
        mkdirSync(join(d, 'scripts'), { recursive: true });
        writeFileSync(join(d, 'scripts/sync-sources.mjs'), '// Generated by SiteOrigin Builder.\n');
        // A module of the site's own beside the components, which no component names.
        writeFileSync(join(d, 'src/lib/siteorigin/custom/format.svelte'), '<script module>export const shout = (s) => s.toUpperCase();</script>\n');
        const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'));
        writeFileSync(join(d, 'package.json'), JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, sync: 'node scripts/sync-sources.mjs' } }, null, '\t') + '\n');
      }
    );
    const unplacedFile = defFile({ id: unplaced, kind: 'managed' } as never);
    expect(existsSync(join(dir, unplacedFile)), 'the project has its file').toBe(true);
    const { c, repo } = await open(dir);
    expect(existsSync(join(dir, '.siteorigin/versions.git'))).toBe(false);
    expect(await c.publicationStatus()).toEqual({ ok: true, prepared: null, changed: true });
    expect(existsSync(join(dir, '.siteorigin/versions.git')), 'checking makes no repository').toBe(false);

    const r = await c.preparePublication();
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(await repo.resolveRef(VERSIONS_BRANCH), 'no saved version is made').toBeNull();
    const published = await reachable(repo, PUBLISH_BRANCH);
    expect(published.text).not.toContain(PHRASE);
    expect(published.text).not.toContain('launch-22222222');
    const paths = [...published.paths];
    // A standalone SvelteKit project: its tools' settings, the published pages' source, the published library file.
    expect(paths).toEqual(expect.arrayContaining(['package.json', 'package-lock.json', 'vite.config.js', 'src/routes/+page.svelte', 'src/routes/+layout.svelte', 'static/assets/shelf-11111111.svg', 'siteorigin.project.json', 'siteorigin/site.json', 'siteorigin/generated-manifest.json']));
    expect(paths.filter((p) => /launch|brief|^\.siteorigin|^node_modules|sources\//.test(p))).toEqual([]);
    // Its canonical documents are the published state's: no draft page, no picture only it showed.
    const assets = JSON.parse(Buffer.from(await repo.readBlob(r.ok ? r.commit : '', 'siteorigin/assets.json')).toString('utf8')) as { assets: Record<string, unknown> };
    expect(Object.keys(assets.assets)).toContain('shelf');
    expect(Object.keys(assets.assets)).not.toContain('launch');
    expect(paths).not.toContain('siteorigin/pages/pg_launch01.json');
    expect(paths.filter((p) => p === unplacedFile || p.startsWith(`siteorigin/components/${unplaced}/`) || p.startsWith(`siteorigin/components/${coded}/`))).toEqual([]);
    // Nor the picture only that code showed, nor its record.
    expect(published.text).not.toContain('teaser-33333333');
    expect(Object.keys(assets.assets)).not.toContain('teaser');
    // The site's own module is carried as it is.
    expect(paths).toContain('src/lib/siteorigin/custom/format.svelte');
    // No sync script, and no command to run one.
    expect(paths).not.toContain('scripts/sync-sources.mjs');
    expect(JSON.parse(Buffer.from(await repo.readBlob(r.ok ? r.commit : '', 'package.json')).toString('utf8')).scripts.sync).toBeUndefined();
    // What the website does place is there.
    expect(paths.some((p) => p.startsWith('src/lib/siteorigin/generated/'))).toBe(true);
    // What lists the generated files lists only what the publication has.
    const manifest = JSON.parse(Buffer.from(await repo.readBlob(r.ok ? r.commit : '', 'siteorigin/generated-manifest.json')).toString('utf8')) as { files: Record<string, string> };
    expect(Object.keys(manifest.files).filter((p) => !published.paths.has(p))).toEqual([]);
    // Checked out, it is a project whose generated files are the ones it lists, and whose documents read back whole.
    const out = temp('checkout');
    await checkout(repo, r.ok ? r.commit : '', out);
    expect(await editedGeneratedFile(out)).toBeNull();
    const read = (await readProject(out)).state;
    expect(validateState(read).filter((d) => d.severity === 'error')).toEqual([]);
    expect(Object.keys(read.pages)).not.toContain('pg_launch01');
    expect(read.brief).toBeUndefined();
    // The project itself is as it was: the draft is still there to edit.
    expect(c.snapshot()!.state.pages.pg_launch01.draft).toBe(true);
    expect(existsSync(join(dir, 'src/routes/launch/+page.svelte'))).toBe(true);
  });

  it('tells a website change from an edit to what the website does not carry, and follows the last publication', async () => {
    const dir = await project();
    const { c, repo } = await open(dir);
    const first = await c.preparePublication();
    if (!first.ok) throw new Error(first.message);
    expect(await c.publicationStatus()).toEqual({ ok: true, prepared: first.commit, changed: false });
    // The same website again makes no commit.
    expect(await c.preparePublication()).toEqual({ ok: true, commit: first.commit, tree: first.tree, changed: false });

    // The brief and the draft are not the website's.
    expect((await c.apply({ operations: [{ type: 'brief.update', notes: 'Call the printer on Monday.' }, { type: 'page.update', pageId: 'pg_launch01', title: `${PHRASE} (final)` }] })).ok).toBe(true);
    expect(await c.publicationStatus()).toMatchObject({ ok: true, changed: false });
    // A change to a published page is, and one put back is not, whatever the project's revision says.
    const home = c.snapshot()!.state.site.homePageId;
    const title = c.snapshot()!.state.pages[home].title;
    expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, title: 'Welcome to the shop' }] })).ok).toBe(true);
    expect(await c.publicationStatus()).toMatchObject({ ok: true, changed: true });
    expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, title }] })).ok).toBe(true);
    expect(await c.publicationStatus()).toMatchObject({ ok: true, changed: false });
    // A picture replaced on disk under the same name is a change.
    writeFileSync(join(dir, 'static/assets/shelf-11111111.svg'), PUBLIC_SVG.replace('shelf', 'shelf-2'));
    expect(await c.publicationStatus()).toMatchObject({ ok: true, prepared: first.commit, changed: true });

    const second = await c.preparePublication();
    if (!second.ok) throw new Error(second.message);
    expect(second.changed).toBe(true);
    expect((await repo.readCommit(second.commit)).parents).toEqual([first.commit]);
    expect(await repo.resolveRef(PUBLISH_BRANCH)).toBe(second.commit);
    expect(Buffer.from(await repo.readBlob(second.commit, 'static/assets/shelf-11111111.svg')).toString('utf8')).toBe(PUBLIC_SVG.replace('shelf', 'shelf-2'));
  });

  it('stops, moving nothing, for a secret in the website, a credential in the lockfile, or a picture it uses that is missing', async () => {
    const KEY = 'sk-live-4f3e2d1c0b9a8f7e6d5c';
    // The lockfile names a private registry with its password, as npm writes one installed from it.
    const lockDir = await project();
    const lock = JSON.parse(readFileSync(join(lockDir, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/private-thing'] = { version: '1.0.0', resolved: 'https://deploy:s3cr3t-pass@npm.example.com/private-thing/-/private-thing-1.0.0.tgz' };
    writeFileSync(join(lockDir, 'package-lock.json'), JSON.stringify(lock, null, 2));
    const locked = await open(lockDir);
    const lockStop = await locked.c.preparePublication();
    expect(lockStop).toEqual({ ok: false, message: 'package-lock.json holds a web address or setting with a password or access token in it. Take the credential out, then prepare the publication again.', warnings: [] });
    expect(existsSync(join(lockDir, '.siteorigin/versions.git')), 'nothing is written').toBe(false);

    // A library picture nothing uses whose file is gone is no reason to stop.
    const dir = await project((s) => ((s.assets.assets.spare = image('spare', 'Spare', 'static/assets/spare-44444444.svg', PUBLIC_SVG)), s));
    const { c, repo } = await open(dir);
    const first = await c.preparePublication();
    if (!first.ok) throw new Error(first.message);
    // A provider key pasted into a published page's title.
    await setKey('openai', KEY);
    const home = c.snapshot()!.state.site.homePageId;
    expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, title: `Shop ${KEY}` }] })).ok).toBe(true);
    const secret = await c.preparePublication();
    expect(secret.ok).toBe(false);
    expect(!secret.ok && secret.message).toMatch(/ holds one of your secrets\. Take it out, then prepare the publication again\.$/);
    expect(JSON.stringify(secret)).not.toContain(KEY);
    expect(await repo.resolveRef(PUBLISH_BRANCH)).toBe(first.commit);
    expect((await c.apply({ operations: [{ type: 'page.update', pageId: home, title: 'Shop' }] })).ok).toBe(true);

    // The picture Home shares, gone from the folder.
    unlinkSync(join(dir, 'static/assets/shelf-11111111.svg'));
    const missing = await c.preparePublication();
    expect(missing).toMatchObject({ ok: false, assetId: 'shelf' });
    expect(!missing.ok && missing.message).toMatch(/Shelf/);
    expect(await repo.resolveRef(PUBLISH_BRANCH)).toBe(first.commit);
  });
  it('stops for a route file still answering at a draft’s address, and for a build setting that loads a file it does not carry', async () => {
    // The author's own server module beside the draft's page.
    const routed = await project(undefined, (d) => writeFileSync(join(d, 'src/routes/launch/+page.server.js'), `export const load = () => ({ plan: '${PHRASE}' });\n`));
    const a = await open(routed);
    expect(await a.c.preparePublication()).toEqual({
      ok: false,
      message: `src/routes/launch/+page.server.js answers at /launch/, the address of the draft ${PHRASE}, so publishing the website would publish it there. Remove or move the file, then prepare the publication again.`,
      warnings: []
    });
    expect(existsSync(join(routed, '.siteorigin/versions.git')), 'nothing is written').toBe(false);
    // A page of the author's own in a route group answers at the same address from another folder.
    const grouped = await project(undefined, (d) => {
      mkdirSync(join(d, 'src/routes/(shop)/launch'), { recursive: true });
      writeFileSync(join(d, 'src/routes/(shop)/launch/+page.svelte'), `<h1>${PHRASE}</h1>\n`);
    });
    const g = await open(grouped);
    expect(await g.c.preparePublication()).toMatchObject({ ok: false, message: expect.stringMatching(/^src\/routes\/\(shop\)\/launch\/\+page\.svelte answers at \/launch\//) });
    // A Vite setting of the author's own that loads a helper beside it, which no saved version or publication holds.
    const helped = await project(undefined, (d) => {
      writeFileSync(join(d, 'build-options.js'), 'export default {};\n');
      // A type-only import loads nothing once compiled, so it is no reason to stop, though it comes first.
      writeFileSync(join(d, 'build-types.ts'), 'export interface Options {}\n');
      writeFileSync(join(d, 'vite.config.js'), `// To import type definitions:\n/* import type { Old } from './old-types'; */\nimport type { Options } from './build-types';\nimport options from './build-options.js';\n${readFileSync(join(d, 'vite.config.js'), 'utf8')}`);
    });
    const b = await open(helped);
    expect(await b.c.preparePublication()).toEqual({ ok: false, message: 'vite.config.js loads build-options.js, which a publication does not carry. Move it into src/, then prepare the publication again.', warnings: [] });
  });

  it('stops when the documents copied are not the ones the project holds, as when an edit outside the app is not read yet', async () => {
    const { projectPublication } = await import('../../src/main/publication');
    const { readState } = await import('../../src/main/project/documents');
    const { leaveOutDrafts: published } = await import('../../src/main/export');
    const dir = await project();
    const state = await readState(dir);
    // A copy of the project as the website build stages it (the published site's generated files): its own state reads it whole.
    const staged = async () => {
      const copy = temp('staged');
      cpSync(dir, copy, { recursive: true });
      await published(copy, state);
      return copy;
    };
    expect(await projectPublication(await staged(), state)).toMatchObject({ ok: true });
    // A page's document changed outside the app, on disk, while the state the app holds is as it was.
    const stale = await staged();
    const home = join(stale, 'siteorigin/pages', `${state.site.homePageId}.json`);
    writeFileSync(home, JSON.stringify({ ...JSON.parse(readFileSync(home, 'utf8')), title: 'Changed outside' }, null, 2));
    expect(await projectPublication(stale, state)).toEqual({ ok: false, message: 'The project changed on disk while the publication was being prepared. Prepare the publication again in a moment.', warnings: [] });
  });

  it('carries none of the developer’s own setup files or tests, which a saved version holds (#1484)', async () => {
    const { projectPublication } = await import('../../src/main/publication');
    const { readState } = await import('../../src/main/project/documents');
    const { leaveOutDrafts: published } = await import('../../src/main/export');
    const dir = await project();
    const state = await readState(dir);
    const developers = ['tsconfig.json', 'wrangler.toml', 'netlify.toml', 'searchsocket.config.ts', 'eslint.config.js', 'tests/api.test.js', 'tests/fixtures/page.json'];
    const staged = async (more?: (copy: string) => void) => {
      const copy = temp('staged');
      cpSync(dir, copy, { recursive: true });
      for (const rel of developers) {
        mkdirSync(dirname(join(copy, rel)), { recursive: true });
        writeFileSync(join(copy, rel), `// ${rel}\n`);
      }
      more?.(copy);
      await published(copy, state);
      return copy;
    };
    const copy = await staged();
    const projected = await projectPublication(copy, state);
    expect(projected.ok).toBe(true);
    const paths = projected.ok ? projected.files.map((f) => f.path) : [];
    expect(paths).toContain('package.json');
    expect(paths).toContain('vite.config.js');
    for (const rel of developers) {
      expect(paths, rel).not.toContain(rel);
      expect(existsSync(join(copy, rel)), rel).toBe(false);
    }
    // A build setting that loads one of them loads a file the publication does not carry.
    const helped = await staged((d) => writeFileSync(join(d, 'vite.config.js'), `import search from './searchsocket.config.ts';\n${readFileSync(join(d, 'vite.config.js'), 'utf8')}`));
    expect(await projectPublication(helped, state)).toEqual({ ok: false, message: 'vite.config.js loads searchsocket.config.ts, which a publication does not carry. Move it into src/, then prepare the publication again.', warnings: [] });
  });
});
