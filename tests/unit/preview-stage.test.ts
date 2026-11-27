/**
 * A read-only preview runs from a private copy of the project (spec 16.6, 18.1): whatever the project's tools write
 * there must never reach the project, and the copy must follow the project as another app edits it.
 */
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { denyAccess } from './deny-access';
import { createPreviewStage, removePreviewStage, sweepPreviewStages, syncPreviewStage } from '../../src/main/runtime/stage';

const dirs: string[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-stage-${name}-`)));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const write = (root: string, rel: string, text: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf8');

function project(): string {
  const dir = temp('project');
  write(dir, 'package.json', '{"name":"site"}');
  write(dir, 'vite.config.js', 'export default {};');
  write(dir, 'src/routes/+page.svelte', '<h1>Home</h1>');
  write(dir, 'siteorigin/site.json', '{}');
  write(dir, '.env', 'SECRET=1');
  write(dir, '.dev.vars', 'SENTINEL_1126');
  write(dir, '.dev.vars.production', 'SENTINEL_1126');
  write(dir, '.wrangler/state/v3/kv.bin', 'SENTINEL_1126');
  write(dir, 'functions/api/hello.ts', 'export const onRequest = () => new Response("hi");');
  write(dir, 'wrangler.toml', 'name = "site"');
  write(dir, '.siteorigin/cache/dev/src/routes/+page.svelte', '<h1 data-so-node="n1">Home</h1>');
  write(dir, '.siteorigin/cache/dev/.clean-hashes.json', '{}');
  write(dir, '.siteorigin/lock.json', '{}');
  write(dir, '.svelte-kit/generated/root.js', 'owner');
  write(dir, 'node_modules/vite/package.json', '{"name":"vite"}');
  write(dir, 'node_modules/vite/bin/vite.js', 'vite');
  mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
  symlinkSync('../vite/bin/vite.js', join(dir, 'node_modules/.bin/vite'));
  write(dir, 'node_modules/.vite/deps/_metadata.json', 'owner cache');
  mkdirSync(join(dir, 'node_modules/.vite-temp'));
  return dir;
}

describe('a preview copy', () => {
  it('carries the source, the dev variants and its own tools, and nothing private', async () => {
    const dir = project();
    const stage = await createPreviewStage(dir, temp('root'));
    expect(read(stage, 'src/routes/+page.svelte')).toBe('<h1>Home</h1>');
    expect(read(stage, '.siteorigin/cache/dev/src/routes/+page.svelte')).toContain('data-so-node');
    expect(read(stage, 'node_modules/.bin/vite')).toBe('vite');
    expect(read(stage, 'functions/api/hello.ts')).toContain('onRequest');
    expect(read(stage, 'wrangler.toml')).toContain('site');
    for (const gone of ['.env', '.dev.vars', '.dev.vars.production', '.wrangler', '.siteorigin/lock.json', '.svelte-kit', 'node_modules/.vite', 'node_modules/.vite-temp']) expect(existsSync(join(stage, gone)), gone).toBe(false);
  });

  it('copies tools reached through a linked node_modules as a real folder of their own', async () => {
    const dir = project();
    const elsewhere = temp('tools');
    renameSync(join(dir, 'node_modules'), join(elsewhere, 'node_modules'));
    symlinkSync(join(elsewhere, 'node_modules'), join(dir, 'node_modules'));
    const stage = await createPreviewStage(dir, temp('root'));
    expect(lstatSync(join(stage, 'node_modules')).isSymbolicLink()).toBe(false);
    writeFileSync(join(stage, 'node_modules/vite/bin/vite.js'), 'changed in the copy');
    expect(read(elsewhere, 'node_modules/vite/bin/vite.js')).toBe('vite');
  });

  it('leaves out links in the tools that lead outside them', async () => {
    const dir = project();
    const outside = temp('outside');
    write(outside, 'pkg/index.js', 'outside');
    symlinkSync(join(outside, 'pkg'), join(dir, 'node_modules/absolute'));
    symlinkSync('../../escape-target', join(dir, 'node_modules/.bin/escape'));
    write(dir, 'escape-target', 'project file');
    // Inside by its written path, outside once the link it passes through is followed.
    write(dir, 'node_modules/deep/a/b/index.js', 'deep');
    symlinkSync('deep/a/b', join(dir, 'node_modules/shortcut'));
    symlinkSync('shortcut/../../../../escape-target', join(dir, 'node_modules/through'));
    const stage = await createPreviewStage(dir, temp('root'));
    expect(existsSync(join(stage, 'node_modules/absolute'))).toBe(false);
    expect(existsSync(join(stage, 'node_modules/.bin/escape'))).toBe(false);
    expect(lstatSync(join(stage, 'node_modules/shortcut')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(stage, 'node_modules/through'))).toBe(false);
    // Out of node_modules and back in by the project's own name, or past the top of the disk and down again: in the
    // copy, the same words would lead elsewhere, the project included.
    symlinkSync(join('..', '..', basename(dir), 'node_modules', 'vite'), join(dir, 'node_modules/byname'));
    symlinkSync(join(...Array(40).fill('..'), dir, 'node_modules', 'vite'), join(dir, 'node_modules/fromtop'));
    const again = await createPreviewStage(dir, temp('root'));
    expect(existsSync(join(again, 'node_modules/byname'))).toBe(false);
    expect(existsSync(join(again, 'node_modules/fromtop'))).toBe(false);
    expect(read(stage, 'node_modules/.bin/vite')).toBe('vite');
  });

  it('skips links inside the dev cache', async () => {
    const dir = project();
    const elsewhere = temp('elsewhere');
    write(elsewhere, 'secret.svelte', 'not the project');
    symlinkSync(join(elsewhere, 'secret.svelte'), join(dir, '.siteorigin/cache/dev/src/routes/linked.svelte'));
    const stage = await createPreviewStage(dir, temp('root'));
    expect(existsSync(join(stage, '.siteorigin/cache/dev/src/routes/+page.svelte'))).toBe(true);
    expect(existsSync(join(stage, '.siteorigin/cache/dev/src/routes/linked.svelte'))).toBe(false);
  });

  it('keeps what the tools write inside the copy', async () => {
    const dir = project();
    const stage = await createPreviewStage(dir, temp('root'));
    // What Vite does when it loads a config: a temporary folder in the nearest node_modules.
    mkdirSync(join(stage, 'node_modules/.vite-temp'));
    writeFileSync(join(stage, 'node_modules/.vite-temp/vite.config.js.timestamp.mjs'), 'bundled config');
    writeFileSync(join(stage, 'node_modules/vite/bin/vite.js'), 'changed in the copy');
    expect(readdirSync(join(dir, 'node_modules/.vite-temp'))).toEqual([]);
    expect(read(dir, 'node_modules/vite/bin/vite.js')).toBe('vite');
    // The link npm made resolves within the copy, not back into the project.
    expect(realpathSync(join(stage, 'node_modules/.bin/vite'))).toBe(join(realpathSync(stage), 'node_modules/vite/bin/vite.js'));
  });

  it('does not follow a dev cache that leads out of the project', async () => {
    const dir = project();
    const elsewhere = temp('elsewhere');
    write(elsewhere, 'src/routes/+page.svelte', 'not the project');
    rmSync(join(dir, '.siteorigin/cache/dev'), { recursive: true });
    symlinkSync(elsewhere, join(dir, '.siteorigin/cache/dev'));
    const stage = await createPreviewStage(dir, temp('root'));
    expect(existsSync(join(stage, '.siteorigin/cache/dev'))).toBe(false);
  });

  it('removes a copy it could not finish', async () => {
    const dir = project();
    rmSync(join(dir, 'node_modules'), { recursive: true });
    const root = temp('root');
    await expect(createPreviewStage(dir, root)).rejects.toThrow();
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('keeping a preview copy up to date', () => {
  it('copies changed files, removes deleted ones and leaves the rest untouched', async () => {
    const dir = project();
    write(dir, 'src/routes/about/+page.svelte', '<h1>About</h1>');
    write(dir, 'static/logo.svg', '<svg/>');
    const stage = await createPreviewStage(dir, temp('root'));
    const logo = statSync(join(stage, 'static/logo.svg')).mtimeMs;
    write(stage, 'node_modules/.vite/deps/_metadata.json', 'the copy’s own cache');
    write(dir, 'src/routes/+page.svelte', '<h1>Home, edited</h1>');
    // The same size as before: only the bytes differ.
    write(dir, 'siteorigin/site.json', '[]');
    write(dir, 'src/routes/contact/+page.svelte', '<h1>Contact</h1>');
    rmSync(join(dir, 'src/routes/about'), { recursive: true });
    // Wrangler's local secrets and state, made once the preview is running, stay out of the copy too (#1126).
    write(dir, 'worker/.dev.vars.staging', 'SENTINEL_1126');
    write(dir, 'worker/.wrangler/state/v3/kv.bin', 'SENTINEL_1126');
    write(dir, 'worker/wrangler.jsonc', '{}');
    await new Promise((r) => setTimeout(r, 20));
    await syncPreviewStage(dir, stage);
    for (const gone of ['worker/.dev.vars.staging', 'worker/.wrangler']) expect(existsSync(join(stage, gone)), gone).toBe(false);
    expect(read(stage, 'worker/wrangler.jsonc')).toBe('{}');
    expect(read(stage, 'src/routes/+page.svelte')).toBe('<h1>Home, edited</h1>');
    expect(read(stage, 'siteorigin/site.json')).toBe('[]');
    expect(read(stage, 'src/routes/contact/+page.svelte')).toBe('<h1>Contact</h1>');
    expect(existsSync(join(stage, 'src/routes/about'))).toBe(false);
    expect(statSync(join(stage, 'static/logo.svg')).mtimeMs).toBe(logo);
    // The copy's own tools and caches are not the project's to remove.
    expect(read(stage, 'node_modules/.vite/deps/_metadata.json')).toBe('the copy’s own cache');
    expect(existsSync(join(stage, 'node_modules/vite/package.json'))).toBe(true);
  });

  it('keeps isolated component previews to the preview server each was made for', async () => {
    const dir = project();
    write(dir, '.siteorigin/cache/dev/isolated/aaaaaaaaaaaaaaaa/src/lib/siteorigin/preview/Preview.svelte', 'the project’s preview');
    const stage = await createPreviewStage(dir, temp('root'));
    // The project's previews are its own preview server's: the copy starts without them.
    expect(existsSync(join(stage, '.siteorigin/cache/dev/isolated'))).toBe(false);
    write(stage, '.siteorigin/cache/dev/isolated/bbbbbbbbbbbbbbbb/src/lib/siteorigin/preview/Preview.svelte', 'the copy’s preview');
    write(dir, 'src/routes/+page.svelte', '<h1>Changed</h1>');
    write(dir, '.siteorigin/cache/dev/src/routes/+page.svelte', '<h1 data-so-node="n1">Changed</h1>');
    await syncPreviewStage(dir, stage);
    expect(read(stage, 'src/routes/+page.svelte')).toBe('<h1>Changed</h1>');
    // The rest of the dev cache still follows the project.
    expect(read(stage, '.siteorigin/cache/dev/src/routes/+page.svelte')).toBe('<h1 data-so-node="n1">Changed</h1>');
    // The copy's own preview is not in the project, and is still there after the copy follows the project.
    expect(read(stage, '.siteorigin/cache/dev/isolated/bbbbbbbbbbbbbbbb/src/lib/siteorigin/preview/Preview.svelte')).toBe('the copy’s preview');
    expect(existsSync(join(stage, '.siteorigin/cache/dev/isolated/aaaaaaaaaaaaaaaa'))).toBe(false);
  });

  it('touches a source file whose dev variant alone changed, so the preview reloads it', async () => {
    const dir = project();
    const stage = await createPreviewStage(dir, temp('root'));
    const before = statSync(join(stage, 'src/routes/+page.svelte')).mtimeMs;
    write(dir, '.siteorigin/cache/dev/src/routes/+page.svelte', '<h1 data-so-node="n2">Home</h1>');
    await new Promise((r) => setTimeout(r, 20));
    await syncPreviewStage(dir, stage);
    expect(read(stage, '.siteorigin/cache/dev/src/routes/+page.svelte')).toContain('n2');
    expect(statSync(join(stage, 'src/routes/+page.svelte')).mtimeMs).toBeGreaterThan(before);
  });

  it('touches a source file whose dev variant went, and clears the variants when the cache goes', async () => {
    const dir = project();
    write(dir, 'src/routes/about/+page.svelte', '<h1>About</h1>');
    write(dir, '.siteorigin/cache/dev/src/routes/about/+page.svelte', '<h1 data-so-node="n3">About</h1>');
    const stage = await createPreviewStage(dir, temp('root'));
    const before = statSync(join(stage, 'src/routes/about/+page.svelte')).mtimeMs;
    rmSync(join(dir, '.siteorigin/cache/dev/src/routes/about'), { recursive: true });
    await new Promise((r) => setTimeout(r, 20));
    await syncPreviewStage(dir, stage);
    expect(existsSync(join(stage, '.siteorigin/cache/dev/src/routes/about'))).toBe(false);
    expect(statSync(join(stage, 'src/routes/about/+page.svelte')).mtimeMs).toBeGreaterThan(before);
    rmSync(join(dir, '.siteorigin/cache/dev'), { recursive: true });
    await syncPreviewStage(dir, stage);
    expect(readdirSync(join(stage, '.siteorigin/cache/dev'))).toEqual([]);
  });

  it('keeps a file whose name changed only in case', async () => {
    const dir = project();
    write(dir, 'static/logo.svg', '<svg/>');
    const stage = await createPreviewStage(dir, temp('root'));
    renameSync(join(dir, 'static/logo.svg'), join(dir, 'static/tmp.svg'));
    renameSync(join(dir, 'static/tmp.svg'), join(dir, 'static/Logo.svg'));
    await syncPreviewStage(dir, stage);
    expect(readdirSync(join(stage, 'static'))).toEqual(['Logo.svg']);
    expect(read(stage, 'static/Logo.svg')).toBe('<svg/>');
  });

  it('keeps the build settings the copy was made with', async () => {
    const dir = project();
    const stage = await createPreviewStage(dir, temp('root'));
    write(dir, 'vite.config.js', 'export default { plugins: [somethingNew()] };');
    write(dir, 'package.json', '{"name":"site","scripts":{"x":"y"}}');
    await syncPreviewStage(dir, stage);
    expect(read(stage, 'vite.config.js')).toBe('export default {};');
    expect(read(stage, 'package.json')).toBe('{"name":"site"}');
    // Another spelling of the same name (the same file on a case-insensitive disk) is not a way in either.
    rmSync(join(dir, 'vite.config.js'));
    write(dir, 'Vite.config.js', 'export default { plugins: [somethingNew()] };');
    await syncPreviewStage(dir, stage);
    expect(read(stage, 'vite.config.js')).toBe('export default {};');
    expect(readdirSync(stage)).not.toContain('Vite.config.js');
  });

  it('fails, emptying nothing, when a folder cannot be read', async () => {
    const dir = project();
    const stage = await createPreviewStage(dir, temp('root'));
    const restore = denyAccess(join(dir, 'src/routes'), 'read');
    try {
      await expect(syncPreviewStage(dir, stage)).rejects.toThrow();
    } finally {
      restore();
    }
    expect(read(stage, 'src/routes/+page.svelte')).toBe('<h1>Home</h1>');
  });
});

describe('clearing copies', () => {
  it('removes copies left by apps that stopped running, and keeps those of running ones', async () => {
    const root = temp('root');
    const exited = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => exited.on('exit', r));
    const running = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    try {
      const copy = (name: string) => write(root, `${name}/.siteorigin/preview-copy.json`, '{}');
      for (const pid of [exited.pid, running.pid, process.pid]) copy(`preview-${pid}-abc`);
      mkdirSync(join(root, 'unrelated'));
      // Named like a copy, but not made as one; and a copy someone has since opened as a project.
      write(root, `preview-${exited.pid}-saved/siteorigin.project.json`, '{}');
      copy(`preview-${exited.pid}-opened`);
      write(root, `preview-${exited.pid}-opened/.siteorigin/lock.json`, '{}');
      await sweepPreviewStages(root);
      expect(readdirSync(root).sort()).toEqual([`preview-${running.pid}-abc`, `preview-${exited.pid}-saved`, `preview-${exited.pid}-opened`, 'unrelated'].sort());
    } finally {
      running.kill();
    }
  });

  it('removes a copy completely', async () => {
    const stage = await createPreviewStage(project(), temp('root'));
    await removePreviewStage(stage);
    expect(existsSync(stage)).toBe(false);
  });
});
