/**
 * #1076: the editor's markers in a code component's Svelte (shared/code-markers.ts) are taken out of both exports,
 * whoever owns the component: a theme's code, written to a generated file, as well as a project component's own
 * source, and the copy of a contact form that declares its WebMCP tool. The editable project keeps every one.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ userData: '', pick: null as null | (() => Promise<string>) }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: {
    showOpenDialog: async () => (env.pick ? { canceled: false, filePaths: [await env.pick()] } : { canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true })
  },
  utilityProcess: { fork: () => undefined }
}));
/** Every file under `dir`, as forward-slash paths relative to it. */
const filesIn = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/')) : [];
// The website build, without SvelteKit: Home rendered on the server from the staged copy's own files, the components
// it places with them, as the static site ships it.
vi.mock('../../src/main/runtime/manager', async (original) => ({
  ...(await original<typeof import('../../src/main/runtime/manager')>()),
  buildProject: async (dir: string) => {
    const { serverHtml } = await import('./generated-site');
    const files = new Map(filesIn(join(dir, 'src')).map((f) => [`src/${f}`, readFileSync(join(dir, 'src', f), 'utf8')]));
    mkdirSync(join(dir, 'build'), { recursive: true });
    const page = (body: string) => `<!doctype html><html lang="en" dir="ltr"><body>${body}</body></html>`;
    writeFileSync(join(dir, 'build/index.html'), page(await serverHtml(files, 'export-markers-')));
    writeFileSync(join(dir, 'build/404.html'), page(await serverHtml(files, 'export-markers-', 'src/routes/404.html/+page.svelte')));
    return { ok: true, logs: [] };
  }
}));
vi.mock('../../src/main/runtime/stage', async (original) => ({ ...(await original<typeof import('../../src/main/runtime/stage')>()), KeptTools: class { take = async () => ({ keep: async () => undefined }); } }));

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');
const { applyOperations } = await import('@engine/apply');
const { defFile, webMcpFormFile } = await import('@generator/index');
const { editedGeneratedFile } = await import('../../src/main/export');
const { componentDocPath } = await import('../../src/main/project/documents');
const { removeRendered } = await import('./generated-site');

const dirs: string[] = [];
const controllers: Array<InstanceType<typeof Controller>> = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-markers-${name}-`)));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  env.userData = temp('userdata');
  env.pick = null;
});
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
afterAll(() => removeRendered());

const MARKER = 'data-so-part="inner"';

/** A project whose Home places the theme's contact form, its code marking an element as the editor's preview does. */
async function projectWithThemeForm(webmcp: boolean) {
  let state = createStarterState('blank', 'Bookshop', false);
  state.site.baseUrl = 'https://books.example';
  state = applyOperations(state, [{ type: 'node.insert', owner: { kind: 'page', id: state.site.homePageId }, componentId: 'contact.form' }, ...(webmcp ? [{ type: 'site.update' as const, webmcp: true }] : [])]).state;
  const form = Object.values(state.components).find((d) => d.componentId === 'contact.form')!;
  expect(form).toMatchObject({ kind: 'code', owner: 'theme' });
  expect(form.source).toContain('<div class="so-form__inner">');
  form.source = form.source!.replace('<div class="so-form__inner">', `<div class="so-form__inner" ${MARKER}>`);
  const dir = temp('project');
  await (await ProjectSession.create(dir, state)).close();
  const c = new Controller(() => null);
  c.send = () => undefined;
  c.startRuntime = async () => undefined;
  controllers.push(c);
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  await vi.waitFor(() => expect(c.snapshot()).not.toBeNull());
  const def = c.snapshot()!.state.components[form.id];
  // The editable project's generated files carry the marker, so the editor finds it there.
  const files = [defFile(def), ...(webmcp ? [webMcpFormFile(def)] : [])];
  for (const f of files) expect(readFileSync(join(dir, f), 'utf8')).toContain(MARKER);
  return { c, dir, files, form: form.id };
}

describe('a theme code component’s editor markers', () => {
  for (const webmcp of [false, true]) {
    it(`never reach the built website${webmcp ? ', the form’s WebMCP copy included' : ''}, while the project keeps them`, async () => {
      const { c, dir, files } = await projectWithThemeForm(webmcp);
      const r = await c.buildStaticTo(join(temp('out'), 'site'));
      expect(r.message).not.toMatch(/Editor-only/);
      expect(r.ok).toBe(true);
      const html = readFileSync(join(r.path!, 'index.html'), 'utf8');
      expect(html).toContain('so-form__inner');
      expect(html).not.toContain('data-so-part');
      if (webmcp) expect(html).toContain('toolname=');
      for (const f of files) expect(readFileSync(join(dir, f), 'utf8')).toContain(MARKER);
    });

    it(`are left out of the source export${webmcp ? ', the form’s WebMCP copy included' : ''}, which still reopens without conflicts`, async () => {
      const { c, dir, files, form } = await projectWithThemeForm(webmcp);
      const out = join(temp('out'), 'handoff');
      const r = await c.exportSourceTo(out);
      expect(r.ok).toBe(true);
      for (const f of files) {
        const copied = readFileSync(join(out, f), 'utf8');
        expect(copied).toContain('class="so-form__inner"');
        expect(copied).not.toContain('data-so-part');
      }
      if (webmcp) expect(readFileSync(join(out, files[1]), 'utf8')).toContain('toolname=');
      // The manifest lists the cleaned files as they are, so the copy reads as SiteOrigin Builder left it.
      expect(await editedGeneratedFile(out)).toBeNull();
      // The theme's canonical code keeps the marker, for the copy to write back when it is opened.
      expect(readFileSync(join(out, componentDocPath(form)), 'utf8')).toContain('data-so-part=\\"inner\\"');
      for (const f of files) expect(readFileSync(join(dir, f), 'utf8')).toContain(MARKER);
    });
  }
});
