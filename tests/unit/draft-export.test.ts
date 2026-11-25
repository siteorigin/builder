/**
 * Draft pages through the export (issue 84): the editable project keeps a draft to edit but builds without it, reopens
 * with the draft back in place, and the website export refuses while published pages link to a draft.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      writeFileSync(html, readFileSync(join(dir, 'src/routes', f), 'utf8'));
    }
    return { ok: true, logs: [] };
  }
}));
vi.mock('../../src/main/runtime/stage', async (original) => ({ ...(await original<typeof import('../../src/main/runtime/stage')>()), copyProjectTools: async () => undefined }));

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');
const { editedGeneratedFile } = await import('../../src/main/export');
const { applyOperations } = await import('@engine/apply');

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
    session.unsettled = true;
    const message = 'A save did not finish, so the project’s files may be out of date. Close and reopen the project, then export again.';
    expect(await c.buildStaticTo(join(temp('out'), 'site'))).toMatchObject({ ok: false, message });
    expect(await c.exportSourceTo(join(temp('out'), 'handoff'))).toMatchObject({ ok: false, message });
    session.unsettled = false;
  });

  it('issue 66: publishes the generated not-found page, and refuses a 404.html of the author’s own in static/', async () => {
    const { c, dir } = await projectWithDraft();
    const ok = await c.buildStaticTo(join(temp('out'), 'site'));
    expect(ok.ok).toBe(true);
    expect(readFileSync(join(ok.path!, '404.html'), 'utf8')).toContain('so-not-found__heading');
    expect(ok.warnings.at(-1)).toMatch(/^Addresses your site does not have show its not-found page, 404\.html\..* set the 404 error document to \/404\.html /);
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
    const manifest = JSON.parse(readFileSync(join(out, 'siteorigin/generated-manifest.json'), 'utf8'));
    expect(Object.keys(manifest.files)).toContain('src/routes/winter-stock-preview/+page.svelte');
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
