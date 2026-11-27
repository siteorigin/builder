/**
 * Review editions (#1133): the selected pages of a review build (#1132), served as the website is, pictured at each
 * requested width and kept as a dated edition in the project's private reviews folder, with a manifest naming the
 * edition, when it was made, the pages and their titles in the build, the widths and a digest of what it holds. A
 * picture that could not be taken is recorded as unavailable at its width; nothing is kept when the capture is called
 * off. The pictures here are made up by a stand-in for the hidden window, which reads the page it is sent to.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ userData: '', documents: '', builds: 0, duringBuild: null as null | (() => Promise<void>), saveAs: null as null | string, saveDialogs: [] as Array<{ defaultPath?: string; filters?: unknown }>, revealed: [] as string[], dialogHold: null as null | Promise<void> }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (name: string) => (name === 'documents' ? env.documents || env.userData : env.userData), getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: (p: string) => void env.revealed.push(p) },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async (_win: unknown, opts: { defaultPath?: string }) => {
      env.saveDialogs.push(opts);
      await env.dialogHold;
      return env.saveAs ? { canceled: false, filePath: env.saveAs } : { canceled: true };
    }
  },
  utilityProcess: { fork: () => undefined }
}));

/** Every file under `dir`, as forward-slash paths relative to it. */
const filesIn = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/')).sort() : [];

// The website build without SvelteKit, as in review-build.test.ts: each page module becomes the HTML file a static
// host serves at its address.
vi.mock('../../src/main/runtime/manager', async (original) => ({
  ...(await original<typeof import('../../src/main/runtime/manager')>()),
  buildProject: async (dir: string) => {
    env.builds++;
    await env.duringBuild?.();
    const out = join(dir, 'build');
    if (existsSync(join(dir, 'static'))) cpSync(join(dir, 'static'), out, { recursive: true });
    for (const f of filesIn(join(dir, 'src/routes')).filter((f) => f.endsWith('+page.svelte'))) {
      const html = dirname(f).endsWith('.html') ? join(out, dirname(f)) : join(out, dirname(f), 'index.html');
      mkdirSync(dirname(html), { recursive: true });
      writeFileSync(html, readFileSync(join(dir, 'src/routes', f), 'utf8'));
    }
    return { ok: true, logs: [] };
  }
}));
vi.mock('../../src/main/runtime/stage', async (original) => ({ ...(await original<typeof import('../../src/main/runtime/stage')>()), KeptTools: class { take = async () => ({ keep: async () => undefined }); } }));

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');
const { applyOperations } = await import('@engine/apply');
const { withPublished } = await import('@shared/published');
const { REVIEWS_DIR, reviewDigestInput, isReviewEditionId } = await import('@shared/review-edition');
const { listReviewEditions, reviewSiteDigest, writeReviewEdition } = await import('../../src/main/review-edition');
const { writeReviewSheet } = await import('../../src/main/review-sheet');
const { StaticPreviews } = await import('../../src/main/static-preview');
type ReviewShot = import('../../src/main/review-shot').ReviewShot;
type Manifest = import('@shared/review-edition').ReviewEditionManifest;

const dirs: string[] = [];
const controllers: Array<InstanceType<typeof Controller>> = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-edition-${name}-`)));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  env.userData = temp('userdata');
  env.builds = 0;
  env.duringBuild = null;
  env.documents = '';
  env.saveAs = null;
  env.saveDialogs = [];
  env.revealed = [];
  env.dialogHold = null;
});
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** A PNG header for a picture `width` × `height`, followed by what was pictured, so each picture's bytes differ. */
function fakePng(width: number, height: number, what: string): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.from(what)]);
}

/**
 * The hidden window's stand-in: reads the page it is sent to over HTTP and pictures what it served (a picture of the
 * page's own HTML), or reports the page unavailable at the widths `unavailable` names for its address.
 */
function fakeShooter(opts: { unavailable?: Record<string, number[]>; throws?: Record<string, number[]>; hold?: Promise<void>; holdAt?: number; mark?: string } = {}) {
  const seen: Array<{ url: string; width: number; status: number; body: string }> = [];
  /** Every picture asked for, whether or not its page could be read. */
  const asked: string[] = [];
  const shoot = async (url: string, width: number): Promise<ReviewShot> => {
    asked.push(`${url} ${width}`);
    const res = await fetch(url, { redirect: 'manual' });
    const body = await res.text();
    seen.push({ url, width, status: res.status, body });
    if (opts.hold && seen.length === opts.holdAt) await opts.hold;
    const path = new URL(url).pathname;
    if (opts.unavailable?.[path]?.includes(width)) return { ok: false, reason: 'fonts', detail: 'Some fonts failed to load: Brand Sans.' };
    if (opts.throws?.[path]?.includes(width)) throw new Error('the window went away');
    return { ok: true, png: fakePng(width, 1000, `${width}:${body}${opts.mark ?? ''}`), height: 1000 };
  };
  return { shoot, seen, asked };
}

async function open(dir: string) {
  const c = new Controller(() => null);
  c.send = () => undefined;
  c.startRuntime = async () => undefined;
  controllers.push(c);
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  await vi.waitFor(() => expect(c.snapshot()).not.toBeNull());
  return c;
}

/** A bookshop exported once, published under /client on its public address, with a draft page kept back. */
async function bookshop(opts: { base?: string } = {}) {
  const dir = temp('project');
  let state = createStarterState('business', 'Bookshop', false);
  state.site.baseUrl = `https://books.example${opts.base ?? ''}`;
  state = applyOperations(state, [{ type: 'page.create', pageId: 'pg_draft', title: 'Secret plans' }]).state;
  state.pages.pg_draft.draft = true;
  state.published = withPublished(undefined, state);
  const s = await ProjectSession.create(dir, state);
  await s.close();
  return { c: await open(dir), dir };
}

const hash = (file: string) => sha(readFileSync(file));
/** The project's canonical documents and private records (revision, versions, History), by their bytes' hash. */
const recordFiles = (dir: string): Record<string, string> => ({
  '.siteorigin/state.json': hash(join(dir, '.siteorigin/state.json')),
  ...Object.fromEntries(['siteorigin', '.siteorigin/versions', '.siteorigin/history'].flatMap((root) => filesIn(join(dir, root)).map((f) => [`${root}/${f}`, hash(join(dir, root, f))])))
});

const stagingLeft = () => (existsSync(join(env.userData, 'build-staging')) ? readdirSync(join(env.userData, 'build-staging')).filter((n) => n.startsWith('export-')) : []);

describe('capturing a review edition', () => {
  it('pictures each page at the desktop and phone widths and keeps them with a manifest in the project’s reviews folder', async () => {
    const { c, dir } = await bookshop({ base: '/client' });
    const { shoot, seen } = fakeShooter();
    c.reviewShoot = shoot;
    const records = recordFiles(dir);
    const before = Date.now();
    const r = await c.captureReviewEdition({ routes: ['/', '/about/'] });
    expect(r).toMatchObject({ ok: true, message: 'Captured 4 pictures.' });
    if (!r.ok) return;
    const m = r.edition;
    // A dated edition of its own, in the project's private folder.
    expect(isReviewEditionId(m.editionId)).toBe(true);
    expect(r.path).toBe(join(dir, REVIEWS_DIR, m.editionId));
    expect(Date.parse(m.createdAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(m.editionId.slice(0, 19)).toBe(m.createdAt.slice(0, 19).replace(/:/g, '-'));
    // Named as the site was called when it was captured, for the offline sheet's title (#1134).
    expect(m.siteName).toBe('Bookshop');
    expect(m.routes).toEqual([
      { route: '/', title: 'Home' },
      { route: '/about/', title: 'About' }
    ]);
    expect(m.widths).toEqual([
      { label: 'Desktop', width: 1440 },
      { label: 'Phone', width: 390 }
    ]);
    expect(m.basePath).toBe('/client');
    expect(m.revision).toBe(c.snapshot()!.revision);
    // Each page was opened where the website serves it, under its base path, and answered with that page.
    expect(seen.map((s) => [new URL(s.url).pathname, s.width, s.status])).toEqual([
      ['/client/', 1440, 200],
      ['/client/', 390, 200],
      ['/client/about/', 1440, 200],
      ['/client/about/', 390, 200]
    ]);
    expect(seen[0].body).not.toBe(seen[2].body);
    // Every picture is in the folder, as the manifest names it and with the digest it gives.
    expect(m.captures.map((x) => [x.route, x.width, x.status])).toEqual([
      ['/', 1440, 'captured'],
      ['/', 390, 'captured'],
      ['/about/', 1440, 'captured'],
      ['/about/', 390, 'captured']
    ]);
    for (const x of m.captures) {
      if (x.status !== 'captured') continue;
      const bytes = readFileSync(join(r.path, x.file));
      expect(x.sha256).toBe(sha(bytes));
      expect(bytes.subarray(24).toString()).toBe(`${x.width}:${seen.find((s) => new URL(s.url).pathname === `/client${x.route}` && s.width === x.width)!.body}`);
    }
    expect(filesIn(r.path)).toEqual(['images/001-1440.png', 'images/001-390.png', 'images/002-1440.png', 'images/002-390.png', 'manifest.json']);
    expect(JSON.parse(readFileSync(join(r.path, 'manifest.json'), 'utf8'))).toEqual(m);
    expect(m.contentDigest).toBe(sha(reviewDigestInput(m)));
    expect(m.siteDigest).toMatch(/^[0-9a-f]{64}$/);
    // Capturing is not publishing: the project's records are as they were, and the build is gone.
    expect(recordFiles(dir)).toEqual(records);
    expect(stagingLeft()).toEqual([]);
    expect(await c.reviewEditions()).toEqual([m]);
    // The edition is the project's private record: a later review build does not carry it.
    const next = join(temp('out'), 'review');
    expect((await c.stageReviewBuild(next)).ok).toBe(true);
    expect(filesIn(next).filter((f) => f.includes('reviews') || f.endsWith('.png'))).toEqual([]);
  });

  it('records a page that could not be pictured at a width as unavailable there and keeps the rest', async () => {
    const { c, dir } = await bookshop();
    c.reviewShoot = fakeShooter({ unavailable: { '/about/': [390] }, throws: { '/': [390] } }).shoot;
    const r = await c.captureReviewEdition({ routes: ['/', '/about/'] });
    expect(r).toMatchObject({ ok: true, message: 'Captured 2 of 4 pictures; 2 could not be taken.' });
    if (!r.ok) return;
    expect(r.edition.captures[1]).toEqual({ route: '/', width: 390, status: 'unavailable', reason: 'failed', detail: 'The page could not be captured: the window went away' });
    expect(r.edition.captures[3]).toEqual({ route: '/about/', width: 390, status: 'unavailable', reason: 'fonts', detail: 'Some fonts failed to load: Brand Sans.' });
    expect(filesIn(r.path)).toEqual(['images/001-1440.png', 'images/002-1440.png', 'manifest.json']);
    expect(r.edition.basePath).toBe('');
    expect(r.path.startsWith(join(dir, REVIEWS_DIR))).toBe(true);
  });

  it('captures the widths asked for, in their order, under their names', async () => {
    const { c } = await bookshop();
    const { shoot, seen } = fakeShooter();
    c.reviewShoot = shoot;
    const r = await c.captureReviewEdition({ routes: ['/about/'], widths: [{ label: 'Wide', width: 1920 }, { label: ' Tablet ', width: 768 }] });
    expect(r.ok && r.edition.widths).toEqual([
      { label: 'Wide', width: 1920 },
      { label: 'Tablet', width: 768 }
    ]);
    expect(seen.map((s) => s.width)).toEqual([1920, 768]);
  });

  it('names each page by its title in the build, whatever it was renamed to meanwhile', async () => {
    const { c } = await bookshop();
    c.reviewShoot = fakeShooter().shoot;
    const about = Object.values(c.snapshot()!.state.pages).find((p) => p.route === '/about/')!.id;
    env.duringBuild = async () => {
      env.duringBuild = null;
      expect((await c.apply({ operations: [{ type: 'page.update', pageId: about, title: 'About us' }] })).ok).toBe(true);
    };
    const r = await c.captureReviewEdition({ routes: ['/about/'] });
    expect(c.snapshot()!.state.pages[about].title).toBe('About us');
    expect(r.ok && r.edition.routes).toEqual([{ route: '/about/', title: 'About' }]);
  });

  it('refuses pages the website does not have and widths it cannot capture, before building anything', async () => {
    const { c } = await bookshop();
    c.reviewShoot = fakeShooter().shoot;
    expect(await c.captureReviewEdition({ routes: ['/secret-plans/'] })).toEqual({ ok: false, message: 'The website has no page at /secret-plans/ to capture.' });
    expect(await c.captureReviewEdition({ routes: ['/nowhere/'] })).toEqual({ ok: false, message: 'The website has no page at /nowhere/ to capture.' });
    expect(await c.captureReviewEdition({ routes: [] })).toEqual({ ok: false, message: 'Choose at least one page to capture.' });
    expect(await c.captureReviewEdition({ routes: ['/', '/'] })).toEqual({ ok: false, message: '/ is asked for twice.' });
    expect(await c.captureReviewEdition({ routes: ['/'], widths: [{ label: 'Tiny', width: 100 }] })).toEqual({ ok: false, message: 'Each width must be a whole number of pixels from 320 to 2560.' });
    expect(await c.captureReviewEdition({ routes: ['/'], widths: [{ label: 'Huge', width: 2561 }] })).toEqual({ ok: false, message: 'Each width must be a whole number of pixels from 320 to 2560.' });
    expect(await c.captureReviewEdition({ routes: ['/'], widths: [{ label: 'Half', width: 800.5 }] })).toEqual({ ok: false, message: 'Each width must be a whole number of pixels from 320 to 2560.' });
    expect(await c.captureReviewEdition({ routes: ['/'], widths: Array.from({ length: 9 }, (_, i) => ({ label: `W${i}`, width: 400 + i })) })).toEqual({ ok: false, message: 'Choose at most 8 widths to capture.' });
    expect(await c.captureReviewEdition({ routes: ['/'], widths: [{ label: 'A', width: 800 }, { label: 'B', width: 800 }] })).toEqual({ ok: false, message: '800 px is asked for twice.' });
    expect(await c.captureReviewEdition({ routes: ['/'], widths: [{ label: '  ', width: 800 }] })).toEqual({ ok: false, message: 'Each width needs a name of up to 64 characters.' });
    expect(env.builds).toBe(0);
    expect(await c.reviewEditions()).toEqual([]);
  });

  it('keeps nothing when the project closes while the pages are being pictured', async () => {
    const { c, dir } = await bookshop();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { shoot, seen, asked } = fakeShooter({ hold: held, holdAt: 2 });
    c.reviewShoot = shoot;
    const capturing = c.captureReviewEdition({ routes: ['/', '/about/'] });
    await vi.waitFor(() => expect(seen.length).toBe(2), { timeout: 10000 });
    const server = new URL(seen[0].url).origin;
    await c.closeProject();
    // The same folder opened again meanwhile is another opening: the first capture keeps nothing in it either.
    const again = await open(dir);
    release();
    expect(await capturing).toEqual({ ok: false, message: 'The project was closed before the review edition was captured.' });
    expect(await again.reviewEditions()).toEqual([]);
    // Nothing more was pictured, nothing kept, the review server stopped and the build removed.
    expect(asked.length).toBe(2);
    expect(await listReviewEditions(dir)).toEqual([]);
    expect(filesIn(join(dir, REVIEWS_DIR))).toEqual([]);
    await expect(fetch(server)).rejects.toThrow();
    expect(stagingLeft()).toEqual([]);
  });

  it('keeps nothing when the capture is called off because the editor closed', async () => {
    const { c, dir } = await bookshop();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { shoot, asked } = fakeShooter({ hold: held, holdAt: 1 });
    c.reviewShoot = shoot;
    const capturing = c.captureReviewEdition({ routes: ['/', '/about/'] });
    await vi.waitFor(() => expect(asked.length).toBe(1), { timeout: 10000 });
    c.cancelReviewCapture();
    release();
    expect((await capturing).ok).toBe(false);
    expect(asked.length).toBe(1);
    expect(await listReviewEditions(dir)).toEqual([]);
    expect(stagingLeft()).toEqual([]);
  });

  it('says why when the build cannot be staged, rather than failing', async () => {
    const { c } = await bookshop();
    c.reviewShoot = fakeShooter().shoot;
    // The app's own folder cannot hold the staging folder (a file is in its place).
    writeFileSync(join(env.userData, 'build-staging'), 'not a folder');
    const r = await c.captureReviewEdition({ routes: ['/'] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/^The review edition could not be saved: /);
    // Nothing is held up by it.
    rmSync(join(env.userData, 'build-staging'));
    expect((await c.captureReviewEdition({ routes: ['/'] })).ok).toBe(true);
  });

  it('captures one edition at a time', async () => {
    const { c } = await bookshop();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { shoot, seen } = fakeShooter({ hold: held, holdAt: 1 });
    c.reviewShoot = shoot;
    const first = c.captureReviewEdition({ routes: ['/'] });
    await vi.waitFor(() => expect(seen.length).toBe(1), { timeout: 10000 });
    expect(await c.captureReviewEdition({ routes: ['/'] })).toEqual({ ok: false, message: 'A review edition is already being captured. Wait for it to finish.' });
    release();
    expect((await first).ok).toBe(true);
    expect((await c.captureReviewEdition({ routes: ['/'] })).ok).toBe(true);
    expect((await c.reviewEditions()).length).toBe(2);
  });
});

describe('writing a review edition', () => {
  /** A tiny website folder, served as the review server serves it. */
  async function site(pages: Record<string, string>) {
    const root = temp('site');
    for (const [rel, html] of Object.entries(pages)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), html);
    }
    const previews = new StaticPreviews();
    const server = await previews.serve(root, '');
    return { root, server, stop: () => previews.stopAll() };
  }

  const write = async (s: { root: string; server: string }, project: string, at: Date, extra: Partial<Parameters<typeof writeReviewEdition>[0]> = {}) =>
    writeReviewEdition({
      projectDir: project,
      site: s.root,
      server: s.server,
      siteName: 'Bookshop',
      basePath: '',
      revision: 3,
      pages: [
        { route: '/', title: 'Home' },
        { route: '/über/', title: 'Über uns' }
      ],
      widths: [{ label: 'Desktop', width: 1440 }],
      shoot: fakeShooter().shoot,
      work: temp('work'),
      now: () => at,
      ...extra
    });

  it('gives the same content digest to the same pictures of the same build, and another to any change', async () => {
    const s = await site({ 'index.html': '<h1>Home</h1>', 'über/index.html': '<h1>Über</h1>' });
    try {
      const project = temp('project');
      const a = await write(s, project, new Date('2026-11-27T10:00:00.000Z'));
      const b = await write(s, project, new Date('2026-11-27T11:00:00.000Z'));
      // Two editions, each of its own, saying the same: the address the server had is not part of what they hold.
      expect(a.manifest.editionId).not.toBe(b.manifest.editionId);
      expect(a.manifest.contentDigest).toBe(b.manifest.contentDigest);
      expect(a.manifest.siteDigest).toBe(await reviewSiteDigest(s.root));
      // A route of any characters is pictured under a plain file name, and was opened at its escaped address.
      expect(a.manifest.captures.map((c) => c.status === 'captured' && c.file)).toEqual(['images/001-1440.png', 'images/002-1440.png']);
      expect(readFileSync(join(a.dir, 'images/002-1440.png')).subarray(24).toString()).toBe('1440:<h1>Über</h1>');
      // Newest first.
      expect((await listReviewEditions(project)).map((m) => m.editionId)).toEqual([b.manifest.editionId, a.manifest.editionId]);
      // One byte of the website changed: another site, and another edition.
      writeFileSync(join(s.root, 'index.html'), '<h1>Home!</h1>');
      const c = await write(s, project, new Date('2026-11-27T12:00:00.000Z'));
      expect(c.manifest.siteDigest).not.toBe(a.manifest.siteDigest);
      expect(c.manifest.contentDigest).not.toBe(a.manifest.contentDigest);
      // The same build pictured differently: another edition of the same site.
      const e = await write(s, project, new Date('2026-11-27T12:30:00.000Z'), { shoot: fakeShooter({ mark: '!' }).shoot });
      expect(e.manifest.siteDigest).toBe(c.manifest.siteDigest);
      expect(e.manifest.contentDigest).not.toBe(c.manifest.contentDigest);
      // A title changed, with the same pictures: another edition.
      const d = await write(s, project, new Date('2026-11-27T13:00:00.000Z'), { pages: [{ route: '/', title: 'Start' }, { route: '/über/', title: 'Über uns' }] });
      expect(d.manifest.contentDigest).not.toBe(c.manifest.contentDigest);
    } finally {
      s.stop();
    }
  });

  it('puts nothing in place when it is called off at the last moment, and lists only whole editions', async () => {
    const s = await site({ 'index.html': '<h1>Home</h1>', 'über/index.html': '<h1>Über</h1>' });
    try {
      const project = temp('project');
      await expect(write(s, project, new Date(), {
          beforeCommit: () => {
            throw new Error('closed');
          }
        })).rejects.toThrow('closed');
      expect(readdirSync(join(project, REVIEWS_DIR))).toEqual([]);
      // Folders that are not editions, and an edition folder without a manifest, are not listed.
      const kept = await write(s, project, new Date());
      const whole = readFileSync(join(kept.dir, 'manifest.json'), 'utf8');
      // A folder not named as an edition is not one, whatever it holds.
      mkdirSync(join(project, REVIEWS_DIR, 'notes'));
      writeFileSync(join(project, REVIEWS_DIR, 'notes', 'manifest.json'), whole.replace(kept.manifest.editionId, 'notes'));
      // Nor is a manifest that names its edition and says nothing else.
      const bare = '2026-11-27T10-00-00Z-0badc0de';
      mkdirSync(join(project, REVIEWS_DIR, bare));
      writeFileSync(join(project, REVIEWS_DIR, bare, 'manifest.json'), JSON.stringify({ editionId: bare }));
      // Nor a link to an edition kept elsewhere.
      const elsewhere = temp('elsewhere');
      const linked = '2026-11-27T09-00-00Z-1badc0de';
      writeFileSync(join(elsewhere, 'manifest.json'), whole.split(kept.manifest.editionId).join(linked));
      symlinkSync(elsewhere, join(project, REVIEWS_DIR, linked));
      // Nor a manifest missing one of its pages' pictures.
      const short = '2026-11-27T08-00-00Z-2badc0de';
      const m = JSON.parse(whole) as Manifest;
      mkdirSync(join(project, REVIEWS_DIR, short));
      writeFileSync(join(project, REVIEWS_DIR, short, 'manifest.json'), JSON.stringify({ ...m, editionId: short, captures: m.captures.slice(1) }));
      // An edition of a thousand pages and more names its later pictures with more digits, and is listed all the same.
      const many = '2026-11-27T07-00-00Z-3badc0de';
      mkdirSync(join(project, REVIEWS_DIR, many));
      writeFileSync(join(project, REVIEWS_DIR, many, 'manifest.json'), JSON.stringify({ ...m, editionId: many, captures: m.captures.map((c, i) => (i === 1 && c.status === 'captured' ? { ...c, file: 'images/1000-1440.png' } : c)) }));
      expect((await listReviewEditions(project)).map((e: Manifest) => e.editionId)).toEqual([kept.manifest.editionId, many]);
    } finally {
      s.stop();
    }
  });
});

describe('saving a review edition as its offline sheet (#1134)', () => {
  /** The bookshop with one edition of its home and about pages, the about page unavailable on a phone. */
  async function captured() {
    const b = await bookshop();
    b.c.reviewShoot = fakeShooter({ unavailable: { '/about/': [390] } }).shoot;
    const r = await b.c.captureReviewEdition({ routes: ['/', '/about/'] });
    if (!r.ok) throw new Error(r.message);
    return { ...b, edition: r.edition, path: r.path };
  }

  it('writes one HTML file with every picture, title, width and the edition ID, where the chooser says, and can show it', async () => {
    const { c, dir, edition, path } = await captured();
    const out = temp('out');
    env.documents = out;
    env.saveAs = join(out, 'for the client.html');
    const records = recordFiles(dir);
    const r = await c.exportReviewSheet(edition.editionId);
    expect(r).toEqual({ ok: true, path: env.saveAs, message: 'Saved the review pages as one file.' });
    // Offered in Documents under the site's and the edition's names.
    expect(env.saveDialogs).toEqual([expect.objectContaining({ defaultPath: join(out, `bookshop-review-${edition.editionId}.html`), filters: [{ name: 'Web page', extensions: ['html'] }] })]);
    expect(readdirSync(out)).toEqual(['for the client.html']);
    const html = readFileSync(env.saveAs, 'utf8');
    expect(html).toContain(`<meta name="siteorigin-review-edition" content="${edition.editionId}">`);
    expect(html).toContain('<h1>Bookshop</h1>');
    for (const title of ['Home', 'About']) expect(html).toContain(`<h2>${title}</h2>`);
    expect(html).toContain('Desktop <span>· 1440 px</span>');
    expect(html).toContain('Phone <span>· 390 px</span>');
    // Each captured picture's own bytes, and the one that could not be taken said as such.
    for (const cap of edition.captures.filter((x) => x.status === 'captured')) expect(html).toContain(`data:image/png;base64,${readFileSync(join(path, cap.file)).toString('base64')}`);
    expect(html.match(/data:image\/png;base64,/g)).toHaveLength(3);
    expect(html).toContain('Not pictured. A font did not load.');
    expect(html).toContain('Links, menus, forms and anything else that moves or responds only work in a live preview');
    // The project is only read.
    expect(recordFiles(dir)).toEqual(records);
    // The saved file can be shown in its folder, as an export's can.
    c.revealInFinder(env.saveAs);
    await vi.waitFor(() => expect(env.revealed).toEqual([realpathSync(env.saveAs!)]));
  });

  it('adds .html to a name typed without it, never replacing a file of that name the chooser did not ask about', async () => {
    const { c, edition } = await captured();
    const out = temp('out');
    writeFileSync(join(out, 'client.html'), 'kept');
    writeFileSync(join(out, 'client-2.html'), 'kept too');
    // A link to nothing is a name taken all the same.
    symlinkSync(join(out, 'nowhere'), join(out, 'client-3.html'));
    env.saveAs = join(out, 'client');
    const r = await c.exportReviewSheet(edition.editionId);
    expect(r).toMatchObject({ ok: true, path: join(out, 'client-4.html') });
    expect(readFileSync(join(out, 'client.html'), 'utf8')).toBe('kept');
    expect(readFileSync(join(out, 'client-2.html'), 'utf8')).toBe('kept too');
    expect(existsSync(join(out, 'nowhere'))).toBe(false);
    expect(readFileSync(join(out, 'client-4.html'), 'utf8')).toContain(edition.editionId);
    // The name ".html" was added to: typed with it, the chooser's own answer (it asked before replacing) is used as is.
    env.saveAs = join(out, 'client.html');
    expect(await c.exportReviewSheet(edition.editionId)).toMatchObject({ ok: true, path: join(out, 'client.html') });
    expect(readFileSync(join(out, 'client.html'), 'utf8')).toContain(edition.editionId);
  });

  it('never puts a sheet over a file that appeared under the name it chose, and puts nothing in place once the project is gone', async () => {
    const out = temp('out');
    const sheet = async function* () {
      yield '<!doctype html>';
    };
    writeFileSync(join(out, 'taken.html'), 'arrived meanwhile');
    expect(await writeReviewSheet(join(out, 'taken.html'), sheet(), { fresh: true, stillOpen: () => true })).toBe('taken');
    expect(readFileSync(join(out, 'taken.html'), 'utf8')).toBe('arrived meanwhile');
    writeFileSync(join(out, 'confirmed.html'), 'the earlier sheet');
    expect(await writeReviewSheet(join(out, 'confirmed.html'), sheet(), { fresh: false, stillOpen: () => false })).toBe('closed');
    expect(await writeReviewSheet(join(out, 'new.html'), sheet(), { fresh: true, stillOpen: () => false })).toBe('closed');
    expect(readFileSync(join(out, 'confirmed.html'), 'utf8')).toBe('the earlier sheet');
    expect(await writeReviewSheet(join(out, 'confirmed.html'), sheet(), { fresh: false, stillOpen: () => true })).toBe('written');
    expect(readFileSync(join(out, 'confirmed.html'), 'utf8')).toBe('<!doctype html>');
    // No temporary file is left behind.
    expect(readdirSync(out).sort()).toEqual(['confirmed.html', 'taken.html']);
    // A drive that gives no file a second name: the name, still free, is taken by moving the finished file there.
    const link = vi.spyOn(fsp, 'link').mockRejectedValueOnce(Object.assign(new Error('not permitted'), { code: 'EPERM' }));
    try {
      expect(await writeReviewSheet(join(out, 'usb.html'), sheet(), { fresh: true, stillOpen: () => true })).toBe('written');
      expect(link).toHaveBeenCalledTimes(1);
    } finally {
      link.mockRestore();
    }
    expect(readFileSync(join(out, 'usb.html'), 'utf8')).toBe('<!doctype html>');
    expect(readdirSync(out).sort()).toEqual(['confirmed.html', 'taken.html', 'usb.html']);
  });

  it('writes nothing when the chooser is closed, for an edition that is not there, or into the project', async () => {
    const { c, dir, edition } = await captured();
    expect(await c.exportReviewSheet(edition.editionId)).toEqual({ ok: false });
    expect(env.saveDialogs).toHaveLength(1);
    // Asked about before any chooser opens.
    for (const id of ['2026-11-27T10-00-00Z-0badc0de', '../reviews', 42]) expect(await c.exportReviewSheet(id)).toEqual({ ok: false, message: 'That review edition is no longer in this project.' });
    expect(env.saveDialogs).toHaveLength(1);
    expect(await c.exportReviewSheet(edition.editionId, join(dir, 'sheet.html'))).toEqual({ ok: false, message: 'Choose a location outside the project folder.' });
    expect(existsSync(join(dir, 'sheet.html'))).toBe(false);
  });

  it('refuses an edition whose picture changed, went missing or is a link, or whose manifest no longer adds up, and keeps the file it would have replaced', async () => {
    const { c, edition, path } = await captured();
    const out = temp('out');
    const dest = join(out, 'sheet.html');
    writeFileSync(dest, 'the earlier sheet');
    const changed = { ok: false, message: 'That review edition has changed or lost pictures since it was captured. Capture the pages again.' };
    const first = join(path, (edition.captures[0] as { file: string }).file);
    const png = readFileSync(first);
    // A picture with other bytes.
    writeFileSync(first, Buffer.concat([png, Buffer.from('x')]));
    expect(await c.exportReviewSheet(edition.editionId, dest)).toEqual(changed);
    // A picture that is gone.
    rmSync(first);
    expect(await c.exportReviewSheet(edition.editionId, dest)).toEqual(changed);
    // A link to the right bytes, kept somewhere else.
    const elsewhere = join(temp('elsewhere'), 'picture.png');
    writeFileSync(elsewhere, png);
    symlinkSync(elsewhere, first);
    expect(await c.exportReviewSheet(edition.editionId, dest)).toEqual(changed);
    rmSync(first);
    writeFileSync(first, png);
    // The images folder a link to a copy of itself.
    const copy = temp('images');
    cpSync(join(path, 'images'), copy, { recursive: true });
    rmSync(join(path, 'images'), { recursive: true });
    symlinkSync(copy, join(path, 'images'));
    expect(await c.exportReviewSheet(edition.editionId, dest)).toEqual(changed);
    rmSync(join(path, 'images'));
    cpSync(copy, join(path, 'images'), { recursive: true });
    // The last picture, with other bytes: every picture is checked, not only the first.
    const last = join(path, (edition.captures.filter((x) => x.status === 'captured').at(-1) as { file: string }).file);
    const lastPng = readFileSync(last);
    writeFileSync(last, Buffer.concat([lastPng, Buffer.from('x')]));
    expect(await c.exportReviewSheet(edition.editionId, dest)).toEqual(changed);
    writeFileSync(last, lastPng);
    // A manifest whose pages, or only the site's name, were changed without its digest.
    const manifest = join(path, 'manifest.json');
    const whole = readFileSync(manifest, 'utf8');
    writeFileSync(manifest, whole.replace('"title": "About"', '"title": "Abort"'));
    expect(await c.exportReviewSheet(edition.editionId, dest)).toEqual(changed);
    writeFileSync(manifest, whole.replace('"siteName": "Bookshop"', '"siteName": "Bookshop Ltd"'));
    expect(await c.exportReviewSheet(edition.editionId, dest)).toEqual(changed);
    // Two pictures given one file, with a digest made to match: not an edition at all.
    const m = JSON.parse(whole) as Manifest;
    const twice = { ...m, captures: m.captures.map((x) => (x.status === 'captured' ? { ...x, file: (m.captures[0] as { file: string }).file, sha256: (m.captures[0] as { sha256: string }).sha256 } : x)) };
    writeFileSync(manifest, JSON.stringify({ ...twice, contentDigest: sha(reviewDigestInput(twice)) }));
    expect(await c.exportReviewSheet(edition.editionId, dest)).toEqual({ ok: false, message: 'That review edition is no longer in this project.' });
    writeFileSync(manifest, whole);
    expect(readFileSync(dest, 'utf8')).toBe('the earlier sheet');
    // Put back as it was, it saves.
    expect(await c.exportReviewSheet(edition.editionId, dest)).toMatchObject({ ok: true, path: dest });
  });

  it('writes nothing once the project closes while the chooser is open', async () => {
    const { c, edition } = await captured();
    const out = temp('out');
    env.saveAs = join(out, 'sheet.html');
    let answer!: () => void;
    env.dialogHold = new Promise<void>((r) => (answer = r));
    const closing = c.exportReviewSheet(edition.editionId);
    await vi.waitFor(() => expect(env.saveDialogs).toHaveLength(1));
    await c.close();
    answer();
    expect(await closing).toEqual({ ok: false, message: 'The project was closed before the review pages were saved.' });
    expect(readdirSync(out)).toEqual([]);
  });
});
