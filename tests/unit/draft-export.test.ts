/**
 * Draft pages through the export (issue 84): the editable project keeps a draft to edit but builds without it, reopens
 * with the draft back in place, and the website export refuses while published pages link to a draft.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { icoImages } from './ico';
import { editorView } from './editor-feed';

const env = vi.hoisted(() => ({ userData: '', dialogs: 0, pick: null as null | (() => Promise<string>), builds: 0 }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: {
    // A test that sets `pick` chooses a folder: whatever it does meanwhile happens while the picker is open.
    showOpenDialog: async () => (env.dialogs++, env.pick ? { canceled: false, filePaths: [await env.pick()] } : { canceled: true, filePaths: [] }),
    showSaveDialog: async () => (env.dialogs++, { canceled: true })
  },
  utilityProcess: { fork: () => undefined }
}));

/** Every file under `dir`, as forward-slash paths relative to it. */
const filesIn = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/')) : [];

// The website build, without SvelteKit: each page module becomes the HTML file a static host serves at its address
// (its source stands in for the rendered page; a route named like a file, 404.html, is written as that file), and
// static/ is copied as it is. The tools are not copied.
vi.mock('../../src/main/runtime/manager', async (original) => ({
  ...(await original<typeof import('../../src/main/runtime/manager')>()),
  buildProject: async (dir: string) => {
    env.builds++;
    const out = join(dir, 'build');
    if (existsSync(join(dir, 'static'))) cpSync(join(dir, 'static'), out, { recursive: true });
    for (const f of filesIn(join(dir, 'src/routes')).filter((f) => f.endsWith('+page.svelte'))) {
      const html = dirname(f).endsWith('.html') ? join(out, dirname(f)) : join(out, dirname(f), 'index.html');
      mkdirSync(dirname(html), { recursive: true });
      // The not-found page's own source follows the route that shows it.
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
const { editedGeneratedFile } = await import('../../src/main/export');
const { applyOperations } = await import('@engine/apply');
const { setSiteIconRenderer, siteIconTiming, SITE_ICON_PATHS } = await import('../../src/main/project/site-icons');
const { renderSiteIcons } = await import('../../src/main/project/image-variants');
const { sha } = await import('../../src/main/project/fsutil');
const sharp = (await import('sharp')).default;

const dirs: string[] = [];
const controllers: Array<InstanceType<typeof Controller>> = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-draft-${name}-`)));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  env.userData = temp('userdata');
  env.dialogs = 0;
  env.pick = null;
  env.builds = 0;
});
afterEach(async () => {
  setSiteIconRenderer(null);
  siteIconTiming.budgetMs = 2_000;
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function open(dir: string) {
  const c = new Controller(() => null);
  c.send = () => undefined;
  // The preview runtime is not under test here.
  c.startRuntime = async () => undefined;
  controllers.push(c);
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  await vi.waitFor(() => expect(c.snapshot()).not.toBeNull());
  return c;
}

/** A business site with an unlinked draft, Winter stock preview, at /winter-stock-preview/. */
async function projectWithDraft() {
  const dir = temp('project');
  const created = await ProjectSession.create(dir, createStarterState('business', 'Bookshop', false));
  await created.close();
  const c = await open(dir);
  const r = await c.apply({ operations: [{ type: 'page.create', pageId: 'pg_winter01', title: 'Winter stock preview' }, { type: 'page.update', pageId: 'pg_winter01', draft: true }] });
  expect(r.ok).toBe(true);
  expect(existsSync(join(dir, 'src/routes/winter-stock-preview/+page.svelte'))).toBe(true);
  return { c, dir };
}

describe('exporting a project with a draft', () => {
  it('publishes the website without the draft or its old address, and says how many pages it published', async () => {
    // The draft moved from /winter-stock-preview/ to /winter/, and its old address was kept working.
    const dir = temp('project');
    let state = createStarterState('business', 'Bookshop', false);
    state = applyOperations(state, [{ type: 'page.create', pageId: 'pg_winter01', title: 'Winter stock preview', route: '/winter/' }, { type: 'page.update', pageId: 'pg_winter01', draft: true }]).state;
    state.site.redirects = [{ from: '/winter-stock-preview/', pageId: 'pg_winter01' }];
    state.site.baseUrl = 'https://books.example';
    await (await ProjectSession.create(dir, state)).close();
    const c = await open(dir);
    expect(existsSync(join(dir, 'src/routes/winter-stock-preview/+page.svelte'))).toBe(true);
    const shown = Object.keys(c.snapshot()!.state.pages).filter((id) => id !== 'pg_winter01');
    const out = temp('out');
    env.pick = async () => out;
    const r = await c.exportStatic('folder', shown);
    expect(r).toMatchObject({ ok: true, message: 'Exported 3 pages.' });
    const site = filesIn(r.path!);
    expect(site).toEqual(expect.arrayContaining(['index.html', 'about/index.html', 'contact/index.html', 'sitemap.xml', 'robots.txt']));
    expect(site.filter((f) => /winter/.test(f))).toEqual([]);
    expect(readFileSync(join(r.path!, 'sitemap.xml'), 'utf8')).not.toContain('winter');
    // The project still has the draft to edit and preview.
    expect(existsSync(join(dir, 'src/routes/winter/+page.svelte'))).toBe(true);
    expect(existsSync(join(dir, 'src/routes/winter-stock-preview/+page.svelte'))).toBe(true);
    expect(c.snapshot()!.state.pages.pg_winter01.draft).toBe(true);
  });

  it('#817: a clean site with a public URL exports with nothing to fix, and its hosting guidance beside the warnings', async () => {
    const dir = temp('project');
    const state = createStarterState('blank', 'Bookshop', false);
    state.site.baseUrl = 'https://books.example';
    await (await ProjectSession.create(dir, state)).close();
    const c = await open(dir);
    const r = await c.buildStaticTo(join(temp('out'), 'site'));
    expect(r.ok).toBe(true);
    // This file's stand-in build writes each page's Svelte source, which has no <html lang>: the one note that gives
    // rise to is the stand-in's. tests/e2e/export.mjs runs the real build and expects no notes at all.
    const stand = /^“Home” \(\/\) was built without a language/;
    expect(r.warnings.filter((w) => !stand.test(w))).toEqual([]);
    expect((r.notes ?? []).filter((n) => !stand.test(n.message))).toEqual([]);
    expect(r.hosting).toMatch(/^Addresses your site does not have show its not-found page, 404\.html\. Cloudflare Pages, Netlify and Vercel .* set the 404 error document to \/404\.html /);
    expect((c.snapshot()!.recentExports[0].notes ?? []).filter((n) => /404\.html/.test(n.message))).toEqual([]);
  });

  it('#884: the editable project’s export says private files were left out without counting it as a note', async () => {
    const dir = temp('project');
    const state = createStarterState('blank', 'Bookshop', false);
    state.site.baseUrl = 'https://books.example';
    await (await ProjectSession.create(dir, state)).close();
    const c = await open(dir);
    const r = await c.exportSourceTo(join(temp('out'), 'handoff'));
    expect(r).toMatchObject({ ok: true, message: 'Source project exported. Private files such as .env, keys and credentials were left out.' });
    expect(r.warnings).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(c.snapshot()!.recentExports[0].notes).toEqual([]);
    const zip = await c.exportSourceTo(join(temp('out'), 'handoff.zip'), 'zip');
    expect(zip).toMatchObject({ ok: true, message: 'Source project exported as a ZIP file. Private files such as .env, keys and credentials were left out.', warnings: [], notes: [] });
  });

  it('#884: counts the published entries by their collection, as the Export dialog does', async () => {
    const dir = temp('project');
    let state = createStarterState('business', 'Bookshop', false);
    state = applyOperations(state, [
      { type: 'collection.create', collectionId: 'posts' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_aaaa1', title: 'Opening day', publishedAt: '2026-01-12', draft: false },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_aaaa2', title: 'Winter hours', publishedAt: '2026-01-13', draft: false },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_aaaa3', title: 'Coming soon', publishedAt: '2026-01-14', draft: true }
    ]).state;
    await (await ProjectSession.create(dir, state)).close();
    const c = await open(dir);
    const r = await c.buildStaticTo(join(temp('out'), 'site'));
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^Exported \d+ pages and 2 entries from Posts\.$/);
  });

  it('#881: both exports name a section that has nothing to show, and a draft’s is left out', async () => {
    const dir = temp('project');
    let state = createStarterState('blank', 'Bookshop', false);
    state.site.baseUrl = 'https://books.example';
    state = applyOperations(state, [{ type: 'page.create', pageId: 'pg_winter01', title: 'Winter stock preview' }, { type: 'page.update', pageId: 'pg_winter01', draft: true }]).state;
    const { installComponent, makeInstance } = await import('@engine/install');
    for (const pageId of [state.site.homePageId, 'pg_winter01']) {
      const gallery = makeInstance(state.components[installComponent(state, 'media.gallery')], {});
      state.pages[pageId].nodes[gallery.id] = gallery;
      state.pages[pageId].rootIds.push(gallery.id);
    }
    await (await ProjectSession.create(dir, state)).close();
    const c = await open(dir);
    const lines = ['A section has nothing to show visitors. Give it content, or remove it (Project health leads to it):', 'Home · Gallery: “Recent projects” has no images'];
    const site = await c.buildStaticTo(join(temp('out'), 'site'));
    expect(site.ok).toBe(true);
    expect(site.warnings.filter((w) => /section|Gallery/.test(w))).toEqual(lines);
    const source = await c.exportSourceTo(join(temp('out'), 'handoff'));
    expect(source.ok).toBe(true);
    expect(source.warnings.filter((w) => /section|Gallery/.test(w))).toEqual(lines);
  });

  it('publishes the hosts’ 301 rules for the published redirects only, with vercel.json at the website’s root (#581)', async () => {
    const dir = temp('project');
    let state = createStarterState('business', 'Bookshop', false);
    const about = Object.values(state.pages).find((p) => p.route === '/about/')!.id;
    state = applyOperations(state, [
      { type: 'page.create', pageId: 'pg_winter01', title: 'Winter stock preview', route: '/winter/' },
      { type: 'page.update', pageId: 'pg_winter01', draft: true },
      { type: 'redirect.add', from: '/winter-stock-preview/', pageId: 'pg_winter01' },
      { type: 'redirect.add', from: '/teaser/', to: '/winter-stock-preview/' },
      { type: 'redirect.add', from: '/team/', pageId: about },
      { type: 'site.update', redirectHost: 'vercel' }
    ]).state;
    await (await ProjectSession.create(dir, state)).close();
    const c = await open(dir);
    // The editable project keeps every rule, for the preview.
    expect(readFileSync(join(dir, 'static/_redirects'), 'utf8')).toContain('/teaser/ /winter/ 301');
    const shown = Object.keys(c.snapshot()!.state.pages).filter((id) => id !== 'pg_winter01');
    const out = temp('out');
    env.pick = async () => out;
    const r = await c.exportStatic('folder', shown);
    expect(r).toMatchObject({ ok: true });
    // #817: the hosting guidance is for the host the Redirects setting names, and is not a warning.
    expect(r.hosting).toBe('Addresses your site does not have show its not-found page, 404.html. Vercel uses it automatically when it publishes the exported website as it is.');
    expect([...r.warnings, ...(r.notes ?? []).map((n) => n.message)].filter((w) => /404\.html/.test(w))).toEqual([]);
    expect(readFileSync(join(r.path!, '_redirects'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))).toEqual(['/team/ /about/ 301', '/team /about/ 301']);
    expect(JSON.parse(readFileSync(join(r.path!, 'vercel.json'), 'utf8'))).toEqual({
      redirects: [
        { source: '/team/', destination: '/about/', statusCode: 301 },
        { source: '/team', destination: '/about/', statusCode: 301 }
      ]
    });
    expect(existsSync(join(r.path!, 'team/index.html'))).toBe(true);
    expect(filesIn(r.path!).filter((f) => /winter|teaser/.test(f))).toEqual([]);
    // The editable project's export keeps the drafts' rules out of its own build too.
    const source = await c.exportSourceTo(join(temp('out'), 'handoff'));
    expect(source.ok).toBe(true);
    expect(readFileSync(join(source.path!, 'static/_redirects'), 'utf8')).not.toMatch(/winter|teaser/);
    expect(JSON.parse(readFileSync(join(source.path!, 'vercel.json'), 'utf8')).redirects).toHaveLength(2);
    // Its README says how those rules reach Vercel from a build of its own.
    expect(readFileSync(join(source.path!, 'README.md'), 'utf8')).toContain('copy `vercel.json` into `build/` after each build');
  });

  it('refuses to publish anything at a draft’s address, even a file of the author’s own', async () => {
    const { c, dir } = await projectWithDraft();
    mkdirSync(join(dir, 'static/winter-stock-preview'), { recursive: true });
    writeFileSync(join(dir, 'static/winter-stock-preview/index.html'), '<p>An older copy</p>');
    const dest = join(temp('out'), 'site');
    const r = await c.buildStaticTo(dest);
    expect(r).toMatchObject({ ok: false, message: 'The website has a page at /winter-stock-preview/, which leads to the draft Winter stock preview. Remove the file that puts it there, then export again.' });
    expect(env.builds).toBe(1);
    expect(existsSync(dest)).toBe(false);
    // The editable project keeps the author's file, and says a build of it would publish the file there.
    const source = await c.exportSourceTo(join(temp('out'), 'handoff'));
    expect(source.ok).toBe(true);
    expect(source.warnings).toContain('static/winter-stock-preview/index.html is served at /winter-stock-preview/, the address of the draft Winter stock preview, so a build of the exported project publishes it there. Remove or move the file before building.');
  });

  it('issue 588: publishes llms.txt and the Markdown copies without the draft, and refuses a Markdown copy at a draft’s address', async () => {
    const { c, dir } = await projectWithDraft();
    expect((await c.apply({ operations: [{ type: 'site.update', llmsFull: true, markdownMirrors: true }] })).ok).toBe(true);
    // The editor's own files never list the draft either.
    expect(readFileSync(join(dir, 'static/llms.txt'), 'utf8')).not.toContain('Winter');
    expect(existsSync(join(dir, 'static/winter-stock-preview/index.html.md'))).toBe(false);
    const ok = await c.buildStaticTo(join(temp('out'), 'site'));
    expect(ok.ok).toBe(true);
    const site = filesIn(ok.path!);
    expect(site).toEqual(expect.arrayContaining(['llms.txt', 'llms-full.txt', 'index.html.md', 'about/index.html.md', 'contact/index.html.md']));
    expect(site.filter((f) => /winter/.test(f))).toEqual([]);
    for (const f of ['llms.txt', 'llms-full.txt']) expect(readFileSync(join(ok.path!, f), 'utf8')).not.toMatch(/winter/i);
    // Each published page links to its copy.
    expect(readFileSync(join(ok.path!, 'about/index.html'), 'utf8')).toContain('<link rel="alternate" type="text/markdown" href="./index.html.md" />');
    // A copy left at the draft's address (from before it was a draft, say) would publish its words.
    mkdirSync(join(dir, 'static/winter-stock-preview'), { recursive: true });
    writeFileSync(join(dir, 'static/winter-stock-preview/index.html.md'), '# Winter stock preview');
    const dest = join(temp('out'), 'site');
    const r = await c.buildStaticTo(dest);
    expect(r).toMatchObject({ ok: false, message: 'The website has a Markdown copy of the draft Winter stock preview at /winter-stock-preview/index.html.md. Remove the file that puts it there, then export again.' });
    expect(existsSync(dest)).toBe(false);
    const source = await c.exportSourceTo(join(temp('out'), 'handoff'));
    expect(source.ok).toBe(true);
    expect(source.warnings).toContain(
      'static/winter-stock-preview/index.html.md is served at /winter-stock-preview/index.html.md as the Markdown copy of the draft Winter stock preview, so a build of the exported project publishes it there. Remove or move the file before building.'
    );
  });

  it('issue 588: refuses to export while a save is unfinished, when the generated files may still hold a draft’s words', async () => {
    const { c } = await projectWithDraft();
    const session = (c as unknown as { session: { unsettled: boolean } }).session;
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const view = editorView();
    c.send = (channel: string, payload: unknown) => void sent.push({ channel, payload: view(channel, payload) });
    // Watched from here: an editor page that loads now is given the project whole, and changes after it.
    const before = view('project:changed', c.editorFeed()) as { saveFailure?: unknown };
    expect(before.saveFailure).toBeFalsy();
    session.unsettled = true;
    // #753: the editor hears of it at once, and its save indicator says so until the project is reopened.
    expect(sent.find((m) => m.channel === 'project:changed')?.payload).toMatchObject({ saveFailure: { kind: 'unfinished', message: expect.stringMatching(/reopen/) } });
    // As a change of the copy it had, which is left as it was.
    expect(view.changes[1]).toMatchObject({ base: view.changes[0].seq, fields: { saveFailure: { kind: 'unfinished' } } });
    expect(before.saveFailure).toBeFalsy();
    expect(c.snapshot()?.saveFailure?.kind).toBe('unfinished');
    const message = 'A save did not finish, so the project’s files may be out of date. Close and reopen the project, then export again.';
    expect(await c.buildStaticTo(join(temp('out'), 'site'))).toMatchObject({ ok: false, message });
    expect(await c.exportSourceTo(join(temp('out'), 'handoff'))).toMatchObject({ ok: false, message });
    session.unsettled = false;
  });

  it('#753: refuses to export while a change that failed to save stands, and exports once a later save succeeds', async () => {
    const { c } = await projectWithDraft();
    const session = (c as unknown as { session: { placeJournal: (...a: unknown[]) => Promise<void> } }).session;
    const placeJournal = session.placeJournal.bind(session);
    session.placeJournal = async () => {
      session.placeJournal = placeJournal;
      throw new Error('ENOSPC: no space left on device');
    };
    await expect(c.apply({ operations: [{ type: 'site.update', name: 'Lost name' }] })).rejects.toThrow(/ENOSPC/);
    const refused = await c.exportSourceTo(join(temp('out'), 'handoff'));
    expect(refused).toMatchObject({ ok: false, message: expect.stringMatching(/could not be saved, so the export would leave it out/) });
    expect((await c.apply({ operations: [{ type: 'site.update', name: 'Saved name' }] })).ok).toBe(true);
    expect((await c.exportSourceTo(join(temp('out'), 'handoff-2'))).ok).toBe(true);
  });

  it('issue 66: publishes the generated not-found page, and refuses a 404.html of the author’s own in static/', async () => {
    const { c, dir } = await projectWithDraft();
    const ok = await c.buildStaticTo(join(temp('out'), 'site'));
    expect(ok.ok).toBe(true);
    expect(readFileSync(join(ok.path!, '404.html'), 'utf8')).toContain('so-not-found__heading');
    // #817: how the host shows the page is guidance beside the notes, never one of them.
    expect(ok.hosting).toMatch(/^Addresses your site does not have show its not-found page, 404\.html\. Cloudflare Pages, Netlify and Vercel .* set the 404 error document to \/404\.html /);
    expect([...ok.warnings, ...(ok.notes ?? []).map((n) => n.message)].filter((w) => /not-found page, 404\.html\.|error document/.test(w))).toEqual([]);
    mkdirSync(join(dir, 'static'), { recursive: true });
    writeFileSync(join(dir, 'static/404.html'), '<p>Our old page</p>');
    const dest = join(temp('out'), 'site');
    const r = await c.buildStaticTo(dest);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/^static\/404\.html takes the place of the not-found page SiteOrigin Builder generates/) });
    expect(env.builds).toBe(1);
    expect(existsSync(dest)).toBe(false);
    const source = await c.exportSourceTo(join(temp('out'), 'handoff'));
    expect(source.ok).toBe(true);
    expect(source.warnings).toContain('static/404.html takes the place of the not-found page SiteOrigin Builder generates, so a build of the exported project fails until it is deleted or renamed.');
  });

  it('refuses the website export when the draft is published while the folder picker is open', async () => {
    const { c } = await projectWithDraft();
    const shown = Object.keys(c.snapshot()!.state.pages).filter((id) => id !== 'pg_winter01');
    const out = temp('out');
    env.pick = async () => {
      expect((await c.apply({ operations: [{ type: 'page.update', pageId: 'pg_winter01', draft: false }] })).ok).toBe(true);
      return out;
    };
    const r = await c.exportStatic('folder', shown);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/changed while the export was starting/) });
    expect(env.dialogs).toBe(1);
    expect(env.builds).toBe(0);
    expect(filesIn(out)).toEqual([]);
  });

  it('refuses the website export when the dialog showed a different list of published pages', async () => {
    const { c } = await projectWithDraft();
    const shown = Object.keys(c.snapshot()!.state.pages).filter((id) => id !== 'pg_winter01');
    // The draft was published while the export was starting.
    expect((await c.apply({ operations: [{ type: 'page.update', pageId: 'pg_winter01', draft: false }] })).ok).toBe(true);
    const r = await c.exportStatic('folder', shown);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/changed while the export was starting/) });
    expect(env.dialogs).toBe(0);
    const dest = join(temp('out'), 'site');
    expect((await c.buildStaticTo(dest, 'folder', shown)).message).toBe(r.message);
    expect(existsSync(dest)).toBe(false);
  });

  it('hands over the draft to edit, builds without it, and puts it back when the project is opened', async () => {
    const { c } = await projectWithDraft();
    const out = join(temp('out'), 'handoff');
    const r = await c.exportSourceTo(out);
    expect(r.ok).toBe(true);
    expect(r.warnings).toContain('The draft Winter stock preview is kept in the project to edit in SiteOrigin Builder, and left out of its website build.');
    expect(existsSync(join(out, 'siteorigin/pages/pg_winter01.json'))).toBe(true);
    // A developer's ordinary build of the handoff has no page for the draft.
    expect(existsSync(join(out, 'src/routes/winter-stock-preview/+page.svelte'))).toBe(false);
    expect(existsSync(join(out, 'src/routes/about/+page.svelte'))).toBe(true);
    expect(await editedGeneratedFile(out)).toBeNull();
    // Opened in SiteOrigin Builder, the draft is back to edit and preview, with nothing taken for an outside edit.
    await c.close();
    const reopened = await open(out);
    const snap = reopened.snapshot()!;
    expect(snap.state.pages.pg_winter01.draft).toBe(true);
    expect(snap.conflicts).toEqual([]);
    await vi.waitFor(() => expect(existsSync(join(out, 'src/routes/winter-stock-preview/+page.svelte'))).toBe(true));
    // The opening's publication claims it once done, which comes after the editor has the project (#959).
    await vi.waitFor(() => expect(Object.keys(JSON.parse(readFileSync(join(out, 'siteorigin/generated-manifest.json'), 'utf8')).files)).toContain('src/routes/winter-stock-preview/+page.svelte'));
    expect(reopened.snapshot()!.conflicts).toEqual([]);
  });

  it('names a header menu link with nowhere to go in the website and in the editable project (#208)', async () => {
    const { c } = await projectWithDraft();
    const header = c.snapshot()!.state.site.shell.header;
    const set = await c.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header.rootIds[0], prop: 'links', value: [{ label: 'Soon', link: { type: 'none', target: '' } }] }] });
    expect(set.ok).toBe(true);
    const named = ['A menu link has no destination, so it goes nowhere. Choose where it goes in the editor, or remove it from the menu:', 'Header: “Soon”'];
    const built = await c.buildStaticTo(join(temp('out'), 'site'));
    expect(built.ok).toBe(true);
    expect(built.warnings).toEqual(expect.arrayContaining(named));
    const source = await c.exportSourceTo(join(temp('out'), 'handoff'));
    expect(source.ok).toBe(true);
    expect(source.warnings).toEqual(expect.arrayContaining(named));
  });

  it('refuses the website export before asking where to save it while a published page links to a draft', async () => {
    const { c } = await projectWithDraft();
    const about = Object.values(c.snapshot()!.state.pages).find((p) => p.title === 'About')!.id;
    expect((await c.apply({ operations: [{ type: 'page.update', pageId: about, draft: true }] })).ok).toBe(true);
    const r = await c.exportStatic();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/links on published pages go to About, a draft the website leaves out/);
    expect(r.warnings.some((w) => w.startsWith('Header · '))).toBe(true);
    expect(env.dialogs).toBe(0);
    // Asked for directly, the build refuses too, and leaves nothing at the destination.
    const dest = join(temp('out'), 'site');
    const built = await c.buildStaticTo(dest);
    expect(built.ok).toBe(false);
    expect(built.message).toBe(r.message);
    expect(existsSync(dest)).toBe(false);
    // The editable project still exports, without the draft's page and without links to it, and says so.
    const handoff = join(temp('out'), 'handoff');
    const source = await c.exportSourceTo(handoff);
    expect(source.ok).toBe(true);
    expect(source.warnings).toContain("These links on published pages go to drafts, which the exported project's own build leaves out. Change them or publish the drafts before building it:");
    expect(existsSync(join(handoff, 'src/routes/about/+page.svelte'))).toBe(false);
    expect(readFileSync(join(handoff, 'src/routes/+layout.svelte'), 'utf8')).not.toContain('"/about/"');
    expect(readFileSync(join(handoff, 'src/routes/+page.svelte'), 'utf8')).not.toContain('"/about/"');
    expect(readFileSync(join(handoff, 'README.md'), 'utf8')).toContain('## Draft pages\n\nThis project has draft pages.');
    expect(await editedGeneratedFile(handoff)).toBeNull();
    expect(env.builds).toBe(0);
  });
});

describe('exporting a project with a crawler policy', () => {
  it('publishes the robots.txt the policy writes, and hands over the policy, the file and the noai meta', async () => {
    const dir = temp('project');
    const state = createStarterState('business', 'Bookshop', false);
    state.site.baseUrl = 'https://books.example';
    await (await ProjectSession.create(dir, state)).close();
    const c = await open(dir);
    const set = await c.apply({ operations: [{ type: 'site.update', crawlerPolicy: { preset: 'custom', base: 'block-ai-training', overrides: { GPTBot: 'allow' }, disallowPaths: ['/private/'] } }] });
    expect(set.ok).toBe(true);
    const expected = [
      'User-agent: *',
      'Disallow: /private/',
      '',
      'User-agent: GPTBot',
      'Disallow: /private/',
      '',
      ...['Applebot-Extended', 'Bytespider', 'CCBot', 'ClaudeBot', 'Google-Extended', 'Meta-ExternalAgent'].map((t) => `User-agent: ${t}`),
      'Disallow: /',
      '',
      'Sitemap: https://books.example/sitemap.xml',
      ''
    ].join('\n');
    const out = temp('out');
    env.pick = async () => out;
    const shown = Object.keys(c.snapshot()!.state.pages);
    const r = await c.exportStatic('folder', shown);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(r.path!, 'robots.txt'), 'utf8')).toBe(expected);
    const handoff = join(temp('out'), 'handoff');
    expect((await c.exportSourceTo(handoff)).ok).toBe(true);
    expect(readFileSync(join(handoff, 'static/robots.txt'), 'utf8')).toBe(expected);
    expect(readFileSync(join(handoff, 'src/routes/+layout.svelte'), 'utf8')).toContain('<meta name="robots" content="noai, noimageai" />');
    expect(JSON.parse(readFileSync(join(handoff, 'siteorigin/site.json'), 'utf8')).crawlerPolicy).toEqual({ preset: 'custom', base: 'block-ai-training', overrides: { GPTBot: 'allow' }, disallowPaths: ['/private/'] });
    expect(await editedGeneratedFile(handoff)).toBeNull();
    // Put back, the next export has the robots.txt every website had, and no noai meta.
    expect((await c.apply({ operations: [{ type: 'site.update', crawlerPolicy: null }] })).ok).toBe(true);
    const plain = join(temp('out'), 'handoff');
    expect((await c.exportSourceTo(plain)).ok).toBe(true);
    expect(readFileSync(join(plain, 'static/robots.txt'), 'utf8')).toBe('User-agent: *\nAllow: /\n\nSitemap: https://books.example/sitemap.xml\n');
    expect(readFileSync(join(plain, 'src/routes/+layout.svelte'), 'utf8')).not.toContain('noai');
    expect(JSON.parse(readFileSync(join(plain, 'siteorigin/site.json'), 'utf8'))).not.toHaveProperty('crawlerPolicy');
  });
});

describe('issue 584: the web app manifest and home-screen icons through the export', () => {
  /** The icons drawn in this process, as the app's media worker draws them, and waited for however busy the machine is. */
  const drawHere = () => {
    siteIconTiming.budgetMs = 60_000;
    setSiteIconRenderer(async (data, mime, icons, opts) => ({ ok: true, icons: await renderSiteIcons(data, mime, icons, opts) }));
  };
  const centre = async (png: Buffer) => {
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const i = ((info.height >> 1) * info.width + (info.width >> 1)) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };

  it('builds the website and hands over the project with a valid manifest, its icons and their claims', async () => {
    drawHere();
    const { c, dir } = await projectWithDraft();
    const dest = join(temp('out'), 'site');
    expect((await c.buildStaticTo(dest)).ok).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dest, 'manifest.webmanifest'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'Bookshop', lang: 'en', dir: 'ltr', start_url: './', scope: './', theme_color: '#1f5a4c' });
    // Every icon the manifest names is at the address it gives, relative to the manifest, at the size it says.
    expect(manifest.icons).toHaveLength(2);
    for (const icon of manifest.icons as Array<{ src: string; sizes: string; type: string }>) {
      const size = Number(icon.sizes.split('x')[0]);
      expect(icon.type).toBe('image/png');
      expect(await sharp(readFileSync(join(dest, icon.src))).metadata()).toMatchObject({ format: 'png', width: size, height: size });
    }
    expect(await sharp(readFileSync(join(dest, 'apple-touch-icon.png'))).metadata()).toMatchObject({ format: 'png', width: 180, height: 180, hasAlpha: false });
    // What a client asks for unprompted is there too, though no page links it.
    expect(icoImages(readFileSync(join(dest, 'favicon.ico'))).map((i) => i.width)).toEqual([16, 32, 48]);
    // The editable project carries the same files, still claimed as generated, so it reopens without conflicts.
    const out = join(temp('out'), 'handoff');
    expect((await c.exportSourceTo(out)).ok).toBe(true);
    expect(await editedGeneratedFile(out)).toBeNull();
    const claims = JSON.parse(readFileSync(join(out, 'siteorigin/generated-manifest.json'), 'utf8')).files as Record<string, string>;
    for (const p of ['static/manifest.webmanifest', ...SITE_ICON_PATHS]) {
      const bytes = readFileSync(join(out, p));
      expect(bytes.equals(readFileSync(join(dir, p)))).toBe(true);
      expect(claims[p]).toBe(sha(bytes));
    }
  }, 30_000);

  it('makes the icons from the favicon picture, and again from its file replaced in the folder, before it exports', async () => {
    drawHere();
    const dir = temp('project');
    const square = (background: string) => sharp({ create: { width: 64, height: 64, channels: 3, background } }).png().toBuffer();
    const blue = await square('#0000ff');
    mkdirSync(join(dir, 'static/assets'), { recursive: true });
    writeFileSync(join(dir, 'static/assets/logo-1a2b3c4d.png'), blue);
    const state = createStarterState('business', 'Bookshop', false);
    state.assets.assets.as_logo = { id: 'as_logo', name: 'Logo', file: 'static/assets/logo-1a2b3c4d.png', mime: 'image/png', bytes: blue.length, width: 64, height: 64, hash: sha(blue), kind: 'image', createdAt: '' };
    state.site.favicon = 'as_logo';
    await (await ProjectSession.create(dir, state)).close();
    const c = await open(dir);
    expect(await centre(readFileSync(join(dir, 'static/icon-512.png')))).toEqual([0, 0, 255]);
    // Replaced in place with no document changing, and exported straight away.
    writeFileSync(join(dir, 'static/assets/logo-1a2b3c4d.png'), await square('#ff0000'));
    const dest = join(temp('out'), 'site');
    expect((await c.buildStaticTo(dest)).ok).toBe(true);
    for (const f of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) expect(await centre(readFileSync(join(dest, f)))).toEqual([255, 0, 0]);
    expect(await Promise.all(icoImages(readFileSync(join(dest, 'favicon.ico'))).map((i) => centre(i.png)))).toEqual(Array(3).fill([255, 0, 0]));
    // The tab's own favicon is the picture itself, which the website keeps.
    expect(readFileSync(join(dest, 'assets/logo-1a2b3c4d.png')).equals(readFileSync(join(dir, 'static/assets/logo-1a2b3c4d.png')))).toBe(true);
  }, 30_000);
});

describe('exporting a project whose entries would decide where a contact form sends', () => {
  it('refuses the website and the editable project, naming the form, and exports once it is undone (#1127)', async () => {
    // Written by hand (edits refuse it): the posts layout's form sends wherever each entry's excerpt says.
    const dir = temp('project');
    let state = createStarterState('business', 'Bookshop', false);
    state = applyOperations(state, [
      { type: 'collection.create', collectionId: 'posts' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_open', title: 'Open studio', draft: false, excerpt: 'https://evil.example/f' },
      { type: 'node.insert', owner: { kind: 'template', id: 'posts' }, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: 'https://formspree.io/f/abcd1234' } }
    ]).state;
    state = structuredClone(state);
    const layout = state.collections.posts.settings.template!;
    const formId = layout.rootIds.find((id) => layout.nodes[id].kind === 'instance')!;
    (layout.nodes[formId] as { props: Record<string, unknown> }).props.endpoint = { $entry: 'excerpt' };
    await (await ProjectSession.create(dir, state)).close();
    const c = await open(dir);
    const site = join(temp('out'), 'site');
    const handoff = join(temp('out'), 'handoff');
    const refused = [await c.buildStaticTo(site), await c.exportSourceTo(handoff)];
    for (const r of refused) {
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/^Posts layout: .* takes where it sends what visitors write from the entry's “Excerpt”; a form's destination is set on the form, never read from an entry\. Change that before exporting/);
    }
    expect(existsSync(site)).toBe(false);
    expect(existsSync(handoff)).toBe(false);
    expect(env.builds).toBe(0);
    // Undone, the export goes ahead.
    const undo = await c.apply({ operations: [{ type: 'node.setBinding', owner: { kind: 'template', id: 'posts' }, nodeId: formId, field: 'prop', prop: 'endpoint', binding: null }] });
    expect(undo.ok).toBe(true);
    expect((await c.exportSourceTo(handoff)).ok).toBe(true);
  }, 30_000);
});
