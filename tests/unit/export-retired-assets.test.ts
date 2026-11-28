/**
 * #1391: an imported file no asset record lists any more (an edition replaced through Replace file…, a deleted image)
 * still goes out with both exports while the author's own source names it: a hand-written static page linking to the
 * old edition, a prerendered route of their own. One nothing names stays behind, as Duplicate project leaves it (#1378).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ userData: '', built: [] as string[] }));
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
  existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/')) : [];
// The website build, without SvelteKit: Home rendered on the server from the staged copy's own files, and static/
// copied beside it as the static adapter copies it. A prerendered route that links to a file the copy lacks fails the
// build, as SvelteKit's prerender does.
vi.mock('../../src/main/runtime/manager', async (original) => ({
  ...(await original<typeof import('../../src/main/runtime/manager')>()),
  buildProject: async (dir: string) => {
    const { serverHtml } = await import('./generated-site');
    const files = new Map(filesIn(join(dir, 'src')).map((f) => [`src/${f}`, readFileSync(join(dir, 'src', f), 'utf8')]));
    for (const [rel, text] of files)
      for (const m of rel.startsWith('src/routes/archive/') ? text.matchAll(/href="\/(assets\/[^"]+)"/g) : [])
        if (!existsSync(join(dir, 'static', m[1]))) return { ok: false, logs: [`Error: 404 /${m[1]} (linked from /archive)`] };
    const out = join(dir, 'build');
    mkdirSync(out, { recursive: true });
    cpSync(join(dir, 'static'), out, { recursive: true });
    const page = (body: string) => `<!doctype html><html lang="en" dir="ltr"><body>${body}</body></html>`;
    writeFileSync(join(out, 'index.html'), page(await serverHtml(files, 'export-retired-')));
    writeFileSync(join(out, '404.html'), page(await serverHtml(files, 'export-retired-', 'src/routes/404.html/+page.svelte')));
    env.built = filesIn(out);
    return { ok: true, logs: [] };
  }
}));
vi.mock('../../src/main/runtime/stage', async (original) => ({ ...(await original<typeof import('../../src/main/runtime/stage')>()), KeptTools: class { take = async () => ({ keep: async () => undefined }); } }));

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');
const { applyOperations } = await import('@engine/apply');
const { sha } = await import('../../src/main/project/fsutil');
const { removeRendered } = await import('./generated-site');

const dirs: string[] = [];
const controllers: Array<InstanceType<typeof Controller>> = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-retired-${name}-`)));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  env.userData = temp('userdata');
  env.built = [];
});
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
afterAll(() => removeRendered());

/** A document as the importer names it: a slug and the first eight characters of its bytes' hash. */
const doc = (slug: string, text: string) => ({ rel: `static/assets/${slug}-${sha(text).slice(0, 8)}.pdf`, text });

/**
 * A project holding three editions no record lists: one a hand-written static page links to, one a prerendered route
 * of the author's own links to, one nothing names (kept only for the project's undo and saved versions), and one only
 * a draft names, in its page and in its authoring document.
 */
async function projectWithOldEditions() {
  const archived = doc('guide', 'First edition.');
  const routed = doc('price-list', 'Old prices.');
  const retired = doc('guide', 'Draft edition.');
  const drafted = doc('winter-list', 'Winter list.');
  // A deleted picture, as the importer names one: by eight hash characters, whatever its bytes.
  const pictured = { rel: 'static/assets/old-shopfront-1a2b3c4d.svg', text: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><title>Old shopfront</title></svg>\n' };
  const blank = createStarterState('blank', 'Bookshop', false);
  const state = applyOperations(blank, [{ type: 'page.create', pageId: 'pg_winter01', title: `Winter ${drafted.rel.split('/').pop()}`, route: '/winter/' }, { type: 'page.update', pageId: 'pg_winter01', draft: true }]).state;
  state.site.baseUrl = 'https://books.example';
  const dir = temp('project');
  await (await ProjectSession.create(dir, state)).close();
  expect(readFileSync(join(dir, 'src/routes/winter/+page.svelte'), 'utf8')).toContain(drafted.rel.split('/').pop());
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  for (const d of [archived, routed, retired, drafted, pictured]) put(d.rel, d.text);
  put('static/archive-notes.html', `<!doctype html><p><a href="assets/${archived.rel.split('/').pop()}">First edition</a><img src="assets/${pictured.rel.split('/').pop()}" alt="" /></p>\n`);
  put('src/routes/archive/+page.svelte', `<a href="/${routed.rel.slice('static/'.length)}">Old prices</a>\n`);
  const c = new Controller(() => null);
  c.send = () => undefined;
  c.startRuntime = async () => undefined;
  controllers.push(c);
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  await vi.waitFor(() => expect(c.snapshot()).not.toBeNull());
  return { c, dir, archived, routed, retired, drafted, pictured };
}

describe('an imported file no asset record lists any more', () => {
  it('goes out with the editable project while the author’s own source names it, and stays behind otherwise', async () => {
    const { c, dir, archived, routed, retired, drafted, pictured } = await projectWithOldEditions();
    const out = join(temp('out'), 'handoff');
    const r = await c.exportSourceTo(out);
    expect(r.ok, r.message).toBe(true);
    expect(readFileSync(join(out, archived.rel), 'utf8')).toBe(archived.text);
    expect(readFileSync(join(out, routed.rel), 'utf8')).toBe(routed.text);
    expect(readFileSync(join(out, pictured.rel), 'utf8')).toBe(pictured.text);
    expect(existsSync(join(out, 'static/archive-notes.html'))).toBe(true);
    expect(existsSync(join(out, retired.rel))).toBe(false);
    // The draft's page is left out of the copy, and its authoring document keeps nothing a plain build would serve.
    expect(readFileSync(join(out, 'siteorigin/pages/pg_winter01.json'), 'utf8')).toContain(drafted.rel.split('/').pop());
    expect(existsSync(join(out, drafted.rel))).toBe(false);
    // The project keeps every edition for recovery.
    for (const d of [archived, routed, retired, drafted, pictured]) expect(existsSync(join(dir, d.rel)), d.rel).toBe(true);
  });

  it('goes out with the website while a hand-written page or route links to it, and stays behind otherwise', async () => {
    const { c, dir, archived, routed, retired, drafted, pictured } = await projectWithOldEditions();
    const r = await c.buildStaticTo(join(temp('out'), 'site'));
    expect(r.ok, r.message).toBe(true);
    const at = (rel: string) => rel.slice('static/'.length);
    expect(env.built).toEqual(expect.arrayContaining(['archive-notes.html', at(archived.rel), at(routed.rel), at(pictured.rel)]));
    expect(env.built).not.toContain(at(retired.rel));
    expect(env.built).not.toContain(at(drafted.rel));
    expect(readFileSync(join(r.path!, at(archived.rel)), 'utf8')).toBe(archived.text);
    for (const d of [archived, routed, retired, drafted, pictured]) expect(existsSync(join(dir, d.rel)), d.rel).toBe(true);
  });
});
