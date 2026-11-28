/**
 * A review build (#1132): the clean website a client review is captured from, built from the same isolated snapshot
 * as the website export, leaves the project's publication record, redirects, revision, saved versions and History
 * exactly as they were, where the export records the addresses it delivered.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ userData: '', builds: 0, fail: false }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
  utilityProcess: { fork: () => undefined }
}));

/** Every file under `dir`, as forward-slash paths relative to it. */
const filesIn = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/')).sort() : [];

// The website build without SvelteKit, as in draft-export.test.ts: each page module becomes the HTML file a static
// host serves at its address, and static/ is copied as it is.
vi.mock('../../src/main/runtime/manager', async (original) => ({
  ...(await original<typeof import('../../src/main/runtime/manager')>()),
  // The project's website tools are set up, so the website is built (#1395).
  dependenciesReady: async () => true,
  buildProject: async (dir: string) => {
    env.builds++;
    if (env.fail) return { ok: false, logs: ['Error: the build failed'] };
    const out = join(dir, 'build');
    if (existsSync(join(dir, 'static'))) cpSync(join(dir, 'static'), out, { recursive: true });
    for (const f of filesIn(join(dir, 'src/routes')).filter((f) => f.endsWith('+page.svelte'))) {
      const html = dirname(f).endsWith('.html') ? join(out, dirname(f)) : join(out, dirname(f), 'index.html');
      mkdirSync(dirname(html), { recursive: true });
      const source = readFileSync(join(dir, 'src/routes', f), 'utf8');
      const shown = [...source.matchAll(/^\s*import NotFound from '(\.[^']+\/NotFound\.svelte)';$/gm)].map((m) => readFileSync(join(dir, 'src/routes', dirname(f), m[1]), 'utf8'));
      writeFileSync(html, [source, ...shown].join('\n'));
    }
    return { ok: true, logs: [] };
  }
}));
vi.mock('../../src/main/runtime/stage', async (original) => ({ ...(await original<typeof import('../../src/main/runtime/stage')>()), KeptTools: class { take = async () => ({ keep: async () => undefined }); } }));

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');
const { applyOperations } = await import('@engine/apply');
const { withPublished, PUBLISHED_FILE } = await import('@shared/published');

const dirs: string[] = [];
const controllers: Array<InstanceType<typeof Controller>> = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-review-${name}-`)));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  env.userData = temp('userdata');
  env.builds = 0;
  env.fail = false;
});
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function open(dir: string) {
  const c = new Controller(() => null);
  c.send = () => undefined;
  c.startRuntime = async () => undefined;
  controllers.push(c);
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  await vi.waitFor(() => expect(c.snapshot()).not.toBeNull());
  return c;
}

const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
/** Each file of the project's canonical documents and private records (revision, versions, History), by its bytes' hash. */
const recordFiles = (dir: string): Record<string, string> => ({
  '.siteorigin/state.json': hash(join(dir, '.siteorigin/state.json')),
  ...Object.fromEntries(['siteorigin', '.siteorigin/versions', '.siteorigin/history'].flatMap((root) => filesIn(join(dir, root)).map((f) => [`${root}/${f}`, hash(join(dir, root, f))])))
});

/** What the project knows of its publication: the record, the redirects, its revision, its versions and History. */
const publication = (c: InstanceType<typeof Controller>) => {
  const snap = c.snapshot()!;
  return JSON.stringify({ published: snap.state.published ?? null, redirects: snap.state.site.redirects ?? [], revision: snap.revision, versions: snap.versions, history: snap.history, exports: snap.recentExports });
};

/**
 * A bookshop whose record holds the addresses of its first three pages, with an old address kept working (a redirect),
 * a saved version, and Services added since as an edit in History: a website export now would record /services/.
 */
async function exportedBookshop() {
  const dir = temp('project');
  let state = createStarterState('business', 'Bookshop', false);
  state.site.baseUrl = 'https://books.example';
  const about = Object.values(state.pages).find((p) => p.route === '/about/')!.id;
  state = applyOperations(state, [{ type: 'redirect.add', from: '/team/', pageId: about }]).state;
  state.published = withPublished(undefined, state);
  const s = await ProjectSession.create(dir, state);
  expect((await s.saveVersion('Before review')).ok).toBe(true);
  await s.close();
  const c = await open(dir);
  expect((await c.apply({ operations: [{ type: 'page.create', pageId: 'pg_services', title: 'Services' }] })).ok).toBe(true);
  return { c, dir };
}

describe('staging a review build', () => {
  it('builds the clean website into a folder and leaves the publication record, redirects, revision, versions and History byte-for-byte as they were', async () => {
    const { c, dir } = await exportedBookshop();
    const files = recordFiles(dir);
    expect(Object.keys(files)).toEqual(expect.arrayContaining([PUBLISHED_FILE]));
    expect(Object.keys(files).some((f) => f.startsWith('.siteorigin/versions/'))).toBe(true);
    const before = publication(c);
    const noted = vi.spyOn(c as unknown as { notePublished: () => Promise<void> }, 'notePublished');
    const dest = join(temp('out'), 'review');
    const r = await c.stageReviewBuild(dest);
    expect(r).toMatchObject({ ok: true, path: dest, message: 'Built 4 pages for review.', revision: c.snapshot()!.revision, basePath: '' });
    expect(noted).not.toHaveBeenCalled();
    expect(env.builds).toBe(1);
    const site = filesIn(dest);
    expect(site).toEqual(expect.arrayContaining(['index.html', 'about/index.html', 'services/index.html', 'team/index.html', '404.html']));
    expect(recordFiles(dir)).toEqual(files);
    expect(publication(c)).toBe(before);
    // Nothing of it is listed among the exports, and no preview serves it.
    expect(c.snapshot()!.recentExports).toEqual([]);
  });

  it('is the website export’s build: the export of the same project records the address the review did not', async () => {
    const { c, dir } = await exportedBookshop();
    expect((await c.stageReviewBuild(join(temp('out'), 'review'))).ok).toBe(true);
    expect(c.snapshot()!.state.published?.pages['/services/']).toBeUndefined();
    const files = recordFiles(dir);
    expect((await c.buildStaticTo(join(temp('out'), 'site'))).ok).toBe(true);
    expect(c.snapshot()!.state.published?.pages['/services/']).toBe('pg_services');
    expect(recordFiles(dir)[PUBLISHED_FILE]).not.toBe(files[PUBLISHED_FILE]);
  });

  it('leaves the records as they were when the build fails, and puts nothing in place', async () => {
    const { c, dir } = await exportedBookshop();
    const files = recordFiles(dir);
    const before = publication(c);
    env.fail = true;
    const dest = join(temp('out'), 'review');
    expect((await c.stageReviewBuild(dest)).ok).toBe(false);
    expect(env.builds).toBe(1);
    expect(existsSync(dest)).toBe(false);
    expect(recordFiles(dir)).toEqual(files);
    expect(publication(c)).toBe(before);
  });

  it('refuses a folder that exists or one inside the project, as the export does', async () => {
    const { c, dir } = await exportedBookshop();
    const files = recordFiles(dir);
    expect(await c.stageReviewBuild(temp('taken'))).toMatchObject({ ok: false, message: 'Choose a new folder; the export never overwrites an existing location.' });
    expect(await c.stageReviewBuild(join(dir, 'review'))).toMatchObject({ ok: false, message: 'Choose a location outside the project folder.' });
    expect(env.builds).toBe(0);
    expect(recordFiles(dir)).toEqual(files);
  });
});
