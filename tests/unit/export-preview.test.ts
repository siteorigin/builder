/**
 * Exported-site previews and recent exports (issue 212): each export keeps serving its own files while later exports
 * finish, so an author can compare successive proofs side by side, and the export dialog can list what the open
 * project exported until it closes.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { Server, get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: {},
  utilityProcess: { fork: () => undefined }
}));

const { StaticPreviews } = await import('../../src/main/static-preview');
const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');

const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-preview-${name}-`)));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  env.userData = temp('userdata');
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function previews() {
  const p = new StaticPreviews();
  cleanups.push(() => p.stopAll());
  return p;
}

/** A built site: a home page linking to a nested page, both titled `title`. */
function site(title: string, at = temp('site')): string {
  mkdirSync(join(at, 'about'), { recursive: true });
  writeFileSync(join(at, 'index.html'), `<title>${title}</title><a href="about/">About</a>`);
  writeFileSync(join(at, 'about', 'index.html'), `<title>${title} · About</title>`);
  return at;
}

const get = async (url: string) => {
  const r = await fetch(url, { redirect: 'manual' });
  return { status: r.status, location: r.headers.get('location'), body: await r.text() };
};
/** What a new connection to a stopped proof's address gets (not a pooled one, which a browser refresh need not use). */
const refused = (url: string) =>
  new Promise<string | undefined>((resolve) => {
    httpGet(url, { agent: false }, (res) => {
      res.resume();
      resolve('served');
    }).on('error', (e: NodeJS.ErrnoException) => resolve(e.code));
  });

/** The home page, the redirect a static host gives a page link without its slash, and the nested page. */
async function expectProof(url: string, title: string, base = '') {
  expect((await get(url)).body).toContain(`<title>${title}</title>`);
  expect(await get(`${url}about`)).toMatchObject({ status: 301, location: `${base}/about/` });
  expect((await get(`${url}about/`)).body).toContain(`<title>${title} · About</title>`);
}

describe('exported-site previews', () => {
  it('keeps an earlier proof serving its own files after a later export starts its preview', async () => {
    const p = previews();
    const first = await p.serve(site('Client proof 1'));
    const second = await p.serve(site('Client proof 2'));
    expect(second).not.toBe(first);
    // Refreshing each tab, then following the nested link in each.
    await expectProof(first, 'Client proof 1');
    await expectProof(second, 'Client proof 2');
  });

  it('serves each proof under the base path it was exported with', async () => {
    const p = previews();
    const plain = await p.serve(site('At the root'));
    const nested = await p.serve(site('In a sub-folder'), '/docs');
    expect(nested).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/docs\/$/);
    await expectProof(plain, 'At the root');
    await expectProof(nested, 'In a sub-folder', '/docs');
    expect(await get(nested.replace(/docs\/$/, ''))).toMatchObject({ status: 301, location: '/docs/' });
    // A file that exists, asked for outside the base path, is not served.
    expect((await get(nested.replace(/docs\/$/, 'about/'))).status).toBe(404);
  });

  it('stops one preview on its own, and every preview, including one still starting, when the project closes', async () => {
    // Every server that starts listening in this test, so none can be left behind unseen.
    const listen = vi.spyOn(Server.prototype, 'listen');
    cleanups.push(() => listen.mockRestore());
    const p = previews();
    const [a, b] = [await p.serve(site('A')), await p.serve(site('B'))];
    p.stop(a);
    expect(await refused(a)).toBe('ECONNREFUSED');
    await expectProof(b, 'B');
    // Closed while the next one is still binding its port: it must not outlive the project.
    const late = p.serve(site('C'));
    p.stopAll();
    await expect(late).rejects.toThrow(/closed/);
    expect(await refused(b)).toBe('ECONNREFUSED');
    expect(p.size).toBe(0);
    // The one that was still binding stopped too: no listener is left behind, listed or not.
    const servers = listen.mock.contexts as Server[];
    expect(servers).toHaveLength(3);
    expect(servers.filter((server) => server.listening)).toEqual([]);
  });

  it('stops serving a proof whose folder was moved away, rather than serve whatever is at its path now', async () => {
    const parent = temp('out');
    const path = site('Proof 1', join(parent, 'site'));
    writeFileSync(join(path, '404.html'), 'Proof 1 has no such page');
    const url = await previews().serve(path);
    await expectProof(url, 'Proof 1');
    renameSync(path, join(parent, 'moved'));
    expect((await get(url)).status).toBe(410);
    // Another export (or anything else) now at the same path is not this proof, not even its 404 page.
    site('Someone else', path);
    writeFileSync(join(path, '404.html'), 'Someone else has no such page');
    for (const page of ['', 'about/', 'missing/']) {
      const r = await get(`${url}${page}`);
      expect(r.status).toBe(410);
      expect(r.body).toMatch(/no longer in the folder it was saved to/);
    }
  });

  it('serves web fonts and the favicon with their own content types', async () => {
    const root = site('Proof');
    mkdirSync(join(root, 'assets'));
    const files = { 'brand.woff2': 'font/woff2', 'brand.woff': 'font/woff', 'favicon.ico': 'image/x-icon', 'Touch.ICO': 'image/x-icon', 'photo.jpeg': 'image/jpeg', 'data.bin': 'application/octet-stream' };
    for (const name of Object.keys(files)) writeFileSync(join(root, 'assets', name), `bytes of ${name}`);
    const url = await previews().serve(root);
    for (const [name, type] of Object.entries(files)) {
      const r = await fetch(`${url}assets/${name}`);
      expect([name, r.status, r.headers.get('content-type'), await r.text()]).toEqual([name, 200, type, `bytes of ${name}`]);
    }
  });

  it('never serves files outside the exported folder', async () => {
    const root = site('Proof');
    const secret = temp('secret');
    writeFileSync(join(secret, 'key.txt'), 'private');
    symlinkSync(secret, join(root, 'linked'));
    const url = await previews().serve(root);
    expect((await get(`${url}linked/key.txt`)).status).toBe(404);
    // An existing file beside the exported folder, reached by climbing out of it.
    expect(await get(`${url}..%2f${basename(secret)}%2fkey.txt`)).toMatchObject({ status: 404, body: expect.not.stringContaining('private') });
  });
});

describe('recent exports', () => {
  async function openProject() {
    const dir = temp('project');
    const created = await ProjectSession.create(dir, createStarterState('blank', 'Recent Exports Site', false));
    await created.close();
    const c = new Controller(() => null);
    const sent: Array<[string, unknown]> = [];
    c.send = (channel: string, payload?: unknown) => void sent.push([channel, payload]);
    // The preview runtime is not under test here.
    c.startRuntime = async () => undefined;
    cleanups.push(() => c.close());
    expect((await c.trustAndOpen(dir)).ok).toBe(true);
    await vi.waitFor(() => expect(c.snapshot()).not.toBeNull());
    return { c, dir, sent };
  }
  type Internals = {
    previews: InstanceType<typeof StaticPreviews>;
    recordExport(s: unknown, r: object): boolean;
    previewAndRecord(s: unknown, r: object, base: string): Promise<string | undefined>;
  };

  it('warns that an exported source project leaves out buttons without a link', async () => {
    const { c } = await openProject();
    const home = { kind: 'page' as const, id: c.snapshot()!.state.site.homePageId };
    expect((await c.apply({ operations: [{ type: 'node.insert', owner: home, parentId: null, index: 0, componentId: 'pricing.plans' }] })).ok).toBe(true);
    const r = await c.exportSourceTo(join(temp('out'), 'with-pricing'));
    expect(r.ok).toBe(true);
    const at = r.warnings.findIndex((w) => w.startsWith('3 buttons have no link'));
    expect(at).toBeGreaterThan(-1);
    expect(r.warnings.filter((w) => w.includes('have no link'))).toHaveLength(1);
    expect(r.warnings.slice(at + 1, at + 4)).toEqual(['Home · Pricing: “Book a session”', 'Home · Pricing: “Start a project”', 'Home · Pricing: “Talk to us”']);
  });

  it('lists what this opening exported, newest first, and keeps the overwrite protection', async () => {
    const { c, sent } = await openProject();
    expect(c.snapshot()!.recentExports).toEqual([]);
    const out = temp('out');
    const first = await c.exportSourceTo(join(out, 'proof-1'));
    expect(first.ok).toBe(true);
    const at = Date.now();
    const zip = await c.exportSourceTo(join(out, 'proof.zip'), 'zip');
    expect(zip.ok).toBe(true);
    const list = c.snapshot()!.recentExports;
    expect(list.map((e) => [e.kind, e.format, e.path])).toEqual([
      ['source', 'zip', join(out, 'proof.zip')],
      ['source', 'folder', join(out, 'proof-1')]
    ]);
    expect(list[0].revision).toBe(c.snapshot()!.revision);
    expect(Math.abs(Date.parse(list[0].exportedAt) - at)).toBeLessThan(60_000);
    // The editor hears about each one without asking.
    const changed = sent.filter(([ch]) => ch === 'project:changed').map(([, snap]) => (snap as { recentExports: unknown[] }).recentExports.length);
    expect(changed.slice(-2)).toEqual([1, 2]);
    // An existing folder is still never written into, and a refused export is not listed.
    const again = await c.exportSourceTo(join(out, 'proof-1'));
    expect(again).toMatchObject({ ok: false, message: expect.stringMatching(/never overwrites/) });
    expect(c.snapshot()!.recentExports).toHaveLength(2);
    // A ZIP file replaced (after the save dialog asked) is listed once, as the newer export of a later revision.
    expect((await c.apply({ operations: [{ type: 'site.update', description: 'Revised for the second proof.' }] })).ok).toBe(true);
    const revised = c.snapshot()!.revision;
    expect(revised).toBeGreaterThan(list[0].revision);
    expect((await c.exportSourceTo(join(out, 'proof.zip'), 'zip')).ok).toBe(true);
    expect(c.snapshot()!.recentExports.map((e) => [e.path, e.revision])).toEqual([
      [join(out, 'proof.zip'), revised],
      [join(out, 'proof-1'), list[1].revision]
    ]);
  });

  it('starts and lists a website folder preview only for the project that is still open', async () => {
    const { c } = await openProject();
    const internals = c as unknown as Internals;
    const record = (path: string) => ({ kind: 'site', format: 'folder', path, revision: 1, exportedAt: new Date().toISOString() });
    const live = await internals.previewAndRecord(c.session, record(site('Open')), '');
    expect(live).toBeTruthy();
    await expectProof(live!, 'Open');
    expect(c.snapshot()!.recentExports.map((e) => e.previewUrl)).toEqual([live]);
    // The project closed while its export was being put in place: no preview, nothing listed, nothing left serving.
    const stale = c.session;
    await c.close();
    const size = internals.previews.size;
    expect(await internals.previewAndRecord(stale, record(site('Closed')), '')).toBeUndefined();
    expect(internals.previews.size).toBe(size);
    expect(await refused(live!)).toBe('ECONNREFUSED');
  });

  it('stops a superseded proof whose folder a newer export now occupies, and keeps the others serving', async () => {
    const { c } = await openProject();
    const internals = c as unknown as Internals;
    const s = c.session;
    const out = temp('out');
    const record = async (path: string, title: string) => {
      const previewUrl = await internals.previews.serve(site(title, path));
      internals.recordExport(s, { kind: 'site', format: 'folder', path, revision: 1, exportedAt: new Date().toISOString(), previewUrl });
      return previewUrl;
    };
    const one = await record(join(out, 'site'), 'Proof 1');
    const two = await record(join(out, 'site-2'), 'Proof 2');
    // The first folder was deleted and the next export took its name.
    rmSync(join(out, 'site'), { recursive: true });
    const three = await record(join(out, 'site'), 'Proof 3');
    expect(await refused(one)).toBe('ECONNREFUSED');
    await expectProof(two, 'Proof 2');
    await expectProof(three, 'Proof 3');
    expect(c.snapshot()!.recentExports.map((e) => e.previewUrl)).toEqual([three, two]);
  });

  it('stops every proof and forgets the exports when the project closes; the next opening starts empty', async () => {
    const { c, dir } = await openProject();
    const internals = c as unknown as Internals;
    const url = await internals.previews.serve(site('Proof'));
    internals.recordExport(c.session, { kind: 'site', format: 'folder', path: temp('out'), revision: 1, exportedAt: new Date().toISOString(), previewUrl: url });
    expect(c.snapshot()!.recentExports).toHaveLength(1);
    const stale = c.session;
    await c.close();
    expect(await refused(url)).toBe('ECONNREFUSED');
    expect((await c.trustAndOpen(dir)).ok).toBe(true);
    await vi.waitFor(() => expect(c.snapshot()).not.toBeNull());
    expect(c.snapshot()!.recentExports).toEqual([]);
    // An export of the closed opening that finishes late is neither listed nor left serving.
    const late = await internals.previews.serve(site('Late'));
    internals.recordExport(stale, { kind: 'site', format: 'folder', path: temp('late'), revision: 1, exportedAt: new Date().toISOString(), previewUrl: late });
    expect(c.snapshot()!.recentExports).toEqual([]);
    expect(await refused(late)).toBe('ECONNREFUSED');
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps the proofs serving and listed when a close fails before it goes ahead', async () => {
    const { c } = await openProject();
    const internals = c as unknown as Internals;
    const url = await internals.previews.serve(site('Proof'));
    internals.recordExport(c.session, { kind: 'site', format: 'folder', path: temp('out'), revision: 1, exportedAt: new Date().toISOString(), previewUrl: url });
    c.onSessionClosing = async () => {
      throw new Error('The workspace could not be saved.');
    };
    await expect(c.close()).rejects.toThrow(/could not be saved/);
    expect(c.session).not.toBeNull();
    expect(c.snapshot()!.recentExports.map((e) => e.previewUrl)).toEqual([url]);
    await expectProof(url, 'Proof');
    c.onSessionClosing = null;
  });
});
