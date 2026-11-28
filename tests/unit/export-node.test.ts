/**
 * A website built as a Node.js server (#1481, shared/deploy-target.ts): its export checks adapter-node's layout (pages
 * in prerendered/, files in client/, each under the site's base path), opens its pages on the server the build wrote,
 * its API endpoints answering, and delivers the server ready to start. A static website whose build stops at an
 * endpoint says why and how to go on. The build is a stand-in, as in export-page-check.test.ts; the server is the
 * stand-in's handler.js, served by the app's own runtime/serve-built.ts in this process instead of a worker.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { geotaggedJpeg } from './fixtures/photos';

const env = vi.hoisted(() => ({ userData: '', served: [] as string[], unstartable: false }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
  utilityProcess: { fork: () => undefined }
}));

const filesIn = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/')).sort() : [];

/** The stand-in server: the prerendered pages, then the files, then the one endpoint, under the base path. */
const handlerJs = (base: string) => `import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = dirname(fileURLToPath(import.meta.url));
export const handler = (req, res, next) => {
	const url = new URL(req.url, 'http://x');
	if (url.pathname === ${JSON.stringify(`${base}/api/hello`)}) {
		res.setHeader('content-type', 'application/json');
		return res.end(JSON.stringify({ hello: url.searchParams.get('name') ?? 'world', origin: process.env.ORIGIN }));
	}
	for (const root of ['prerendered', 'client']) {
		let p = join(dir, root, decodeURIComponent(url.pathname));
		if (url.pathname.endsWith('/')) p = join(p, 'index.html');
		if (existsSync(p) && statSync(p).isFile()) {
			res.setHeader('content-type', p.endsWith('.html') ? 'text/html' : 'application/octet-stream');
			return res.end(readFileSync(p));
		}
	}
	next();
};
`;

// The website build without SvelteKit: each page module becomes its HTML file, where adapter-static or adapter-node
// writes it as the project's paths.json says. A static build of a project with an endpoint stops as adapter-static does.
vi.mock('../../src/main/runtime/manager', async (original) => ({
  ...(await original<typeof import('../../src/main/runtime/manager')>()),
  dependenciesReady: async () => true,
  buildProject: async (dir: string) => {
    const paths = JSON.parse(readFileSync(join(dir, 'src/lib/siteorigin/paths.json'), 'utf8')) as { base: string; deployTarget?: string };
    const node = paths.deployTarget === 'node';
    const endpoints = filesIn(join(dir, 'src/routes')).filter((f) => /\+server\.(js|ts)$/.test(f));
    if (!node && endpoints.length)
      return {
        ok: false,
        error: 'Encountered dynamic routes',
        logs: ['@sveltejs/adapter-static: all routes must be fully prerenderable, but found the following routes that are dynamic:', ...endpoints.map((f) => `  - src/routes/${dirname(f)}`), 'You have the following options:']
      };
    const out = join(dir, 'build');
    const mount = paths.base.split('/').filter(Boolean);
    const pages = node ? join(out, 'prerendered', ...mount) : out;
    const assets = node ? join(out, 'client', ...mount) : out;
    if (existsSync(join(dir, 'static'))) cpSync(join(dir, 'static'), assets, { recursive: true });
    for (const f of filesIn(join(dir, 'src/routes')).filter((f) => f.endsWith('+page.svelte'))) {
      const html = dirname(f).endsWith('.html') ? join(pages, dirname(f)) : join(pages, dirname(f), 'index.html');
      mkdirSync(dirname(html), { recursive: true });
      writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"></head><body><main id="main"><p>Built ${f}</p></main></body></html>`);
    }
    if (node) {
      mkdirSync(join(out, 'server'), { recursive: true });
      writeFileSync(join(out, 'server', 'index.js'), 'export const server = {};\n');
      writeFileSync(join(out, 'index.js'), `export * from './handler.js';\n`);
      writeFileSync(join(out, 'handler.js'), handlerJs(paths.base));
      if (existsSync(join(dir, 'pkg-photo.jpg'))) cpSync(join(dir, 'pkg-photo.jpg'), join(assets, '_app', 'immutable', 'assets', 'pkg.abc.jpg'));
    }
    return { ok: true, logs: [] };
  },
  serveBuiltServer: async (dir: string) => {
    if (env.unstartable) throw new Error('The website’s Node.js server could not start: Error: missing module');
    const { serveBuilt } = await import('../../src/runtime/serve-built');
    const { url, server } = await serveBuilt(dir);
    env.served.push(url);
    return {
      url,
      stop: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    };
  }
}));
vi.mock('../../src/main/runtime/stage', async (original) => ({ ...(await original<typeof import('../../src/main/runtime/stage')>()), KeptTools: class { take = async () => ({ keep: async () => undefined }); } }));

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');
const { applyOperations } = await import('@engine/apply');
type PageCheck = import('../../src/main/page-check').PageCheck;

const dirs: string[] = [];
const controllers: Array<InstanceType<typeof Controller>> = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-export-node-${name}-`)));
  dirs.push(d);
  return d;
};
const origin = process.env.ORIGIN;
beforeEach(() => {
  env.userData = temp('userdata');
  env.served = [];
  env.unstartable = false;
});
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  if (origin === undefined) delete process.env.ORIGIN;
  else process.env.ORIGIN = origin;
});

/** A business site, built as `target`, open in a controller whose page checks fetch each page and the endpoint. */
async function site(target: 'static' | 'node', opts: { base?: string; endpoint?: boolean; vercel?: boolean; draft?: boolean; lock?: string } = {}) {
  const dir = temp('project');
  let state = createStarterState('business', 'Harbour Lane', false);
  if (opts.base) state.site.baseUrl = `https://harbour.example${opts.base}`;
  state = applyOperations(state, [{ type: 'site.update', deployTarget: target, ...(opts.vercel ? { redirectHost: 'vercel' as const } : {}) }, ...(opts.vercel ? [{ type: 'redirect.add' as const, from: '/old/', to: '/contact/' }] : [])]).state;
  if (opts.draft) state = applyOperations(state, [{ type: 'page.create', pageId: 'pg_staff001', title: 'Staff', route: '/staff/' }, { type: 'page.update', pageId: 'pg_staff001', draft: true }]).state;
  await (await ProjectSession.create(dir, state)).close();
  if (opts.lock) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'harbour', type: 'module', dependencies: { secretpkg: '1.0.0' } }));
    writeFileSync(join(dir, 'package-lock.json'), opts.lock);
  }
  if (opts.endpoint) {
    mkdirSync(join(dir, 'src/routes/api/hello'), { recursive: true });
    writeFileSync(join(dir, 'src/routes/api/hello/+server.js'), `import { json } from '@sveltejs/kit';\nexport const GET = () => json({ hello: 'world' });\n`);
  }
  const c = new Controller(() => null);
  c.send = () => undefined;
  c.startRuntime = async () => undefined;
  controllers.push(c);
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  await vi.waitFor(() => expect(c.snapshot()).not.toBeNull());
  const asked: string[] = [];
  const answers: unknown[] = [];
  c.pageCheck = async (url): Promise<PageCheck> => {
    asked.push(url);
    const at = new URL(url);
    answers.push(await (await fetch(`${at.origin}${opts.base ?? ''}/api/hello?name=check`)).json().catch(() => null));
    return (await fetch(url)).ok ? { status: 'working' } : { status: 'error-page', heading: 'Error 404', cause: 'Not found', logged: [] };
  };
  return { c, dir, asked, answers };
}

describe('a website built as a Node.js server', () => {
  it('checks its pages on the server it built, with its endpoints answering, and delivers it ready to start', async () => {
    const { c, asked, answers } = await site('node', { base: '/harbour', endpoint: true, vercel: true });
    const dest = join(temp('out'), 'server');
    const r = await c.buildStaticTo(dest);
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining('as a Node.js server') });
    // Every page was opened under the base path, on the built server, which answered the endpoint as itself.
    expect(asked.length).toBeGreaterThan(1);
    expect(asked.every((u) => new URL(u).pathname.startsWith('/harbour/'))).toBe(true);
    expect(env.served).toHaveLength(1);
    expect(answers[0]).toEqual({ hello: 'check', origin: env.served[0] });
    // The check's server is gone once the export is done.
    await expect(fetch(env.served[0])).rejects.toThrow();
    // adapter-node's layout, with what starts it.
    expect(existsSync(join(dest, 'prerendered/harbour/index.html'))).toBe(true);
    expect(existsSync(join(dest, 'prerendered/harbour/contact/index.html'))).toBe(true);
    expect(existsSync(join(dest, 'prerendered/harbour/404.html'))).toBe(true);
    expect(existsSync(join(dest, 'client/harbour/robots.txt'))).toBe(true);
    expect(existsSync(join(dest, 'handler.js'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'));
    expect(pkg).toMatchObject({ private: true, type: 'module', scripts: { start: 'node index.js' }, engines: { node: expect.any(String) } });
    expect(pkg.dependencies).toBeUndefined();
    expect(readFileSync(join(dest, 'README.md'), 'utf8')).toContain('node index.js');
    // No host's redirect rules: the old address is a page of its own.
    expect(existsSync(join(dest, 'vercel.json'))).toBe(false);
    expect(filesIn(dest).some((f) => f.endsWith('_redirects'))).toBe(false);
    expect(existsSync(join(dest, 'prerendered/harbour/old/index.html'))).toBe(true);
    // Started where it is published: guidance, and no preview of its own.
    expect(r.hosting).toContain('node index.js');
    expect(r.previewUrl).toBeUndefined();
    expect(c.snapshot()!.recentExports[0]).toMatchObject({ kind: 'site', path: dest });
    expect(c.snapshot()!.recentExports[0].previewUrl).toBeUndefined();
  });

  it('stops, delivering nothing, when its server cannot be started to check its pages', async () => {
    const { c } = await site('node');
    env.unstartable = true;
    const dest = join(temp('out'), 'server');
    const r = await c.buildStaticTo(dest);
    expect(r).toMatchObject({ ok: false, message: 'The website’s Node.js server could not be started to check its pages.' });
    expect(r.warnings.join('\n')).toContain('missing module');
    expect(existsSync(dest)).toBe(false);
  });

  it('stops for an image its build brought in with photo details, which it cannot rewrite in a server that has measured its files', async () => {
    const { c, dir } = await site('node');
    writeFileSync(join(dir, 'pkg-photo.jpg'), geotaggedJpeg());
    const dest = join(temp('out'), 'server');
    const r = await c.buildStaticTo(dest);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('_app/immutable/assets/pkg.abc.jpg');
    expect(r.message).toContain('Node.js server');
    expect(existsSync(dest)).toBe(false);
  });
});

describe('what a Node.js server goes out with', () => {
  it('its lockfile, when its server code imports packages, but never one naming an address with a token in it', async () => {
    const clean = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/secretpkg': { resolved: 'https://registry.npmjs.org/secretpkg/-/secretpkg-1.0.0.tgz' } } });
    const ok = await site('node', { lock: clean });
    const dest = join(temp('out'), 'server');
    expect(await ok.c.buildStaticTo(dest)).toMatchObject({ ok: true });
    expect(readFileSync(join(dest, 'package-lock.json'), 'utf8')).toBe(clean);
    expect(readFileSync(join(dest, 'README.md'), 'utf8')).toContain('npm ci --omit=dev');
    for (const ctl of controllers.splice(0)) await ctl.close();
    const leaky = await site('node', { lock: JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/secretpkg': { resolved: 'https://ci:npm_abcdefghijklmnop@registry.example.com/secretpkg-1.0.0.tgz' } } }) });
    const stopped = join(temp('out'), 'server');
    const r = await leaky.c.buildStaticTo(stopped);
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('password or token') });
    expect(existsSync(stopped)).toBe(false);
  });
});

describe('what a Node.js server must not answer', () => {
  it('stops for an endpoint of the developer’s own that can answer at a draft’s address, before anything is built', async () => {
    const { c, dir } = await site('node', { draft: true });
    mkdirSync(join(dir, 'src/routes/[section]'), { recursive: true });
    writeFileSync(join(dir, 'src/routes/[section]/+server.js'), 'export const GET = () => new Response("internal");\n');
    const dest = join(temp('out'), 'server');
    const r = await c.buildStaticTo(dest);
    expect(r).toMatchObject({ ok: false, message: 'The API endpoint src/routes/[section]/+server.js can answer at /staff/, the address of the draft Staff, so the Node.js server would publish it. Move the endpoint, or publish the draft, then export again.' });
    expect(env.served).toEqual([]);
    expect(existsSync(dest)).toBe(false);
  });

  it('stops for a file of the site’s own the server would send at a page’s or an old address’s place', async () => {
    for (const shadow of ['old.html', 'contact/index.html']) {
      const { c, dir } = await site('node', { vercel: true });
      mkdirSync(join(dir, 'static', shadow, '..'), { recursive: true });
      writeFileSync(join(dir, 'static', shadow), '<p>stale</p>');
      const dest = join(temp('out'), 'server');
      const r = await c.buildStaticTo(dest);
      expect(r.ok, shadow).toBe(false);
      expect(r.message).toContain(`file ${shadow} in static/`);
      expect(existsSync(dest)).toBe(false);
      for (const ctl of controllers.splice(0)) await ctl.close();
    }
  });
});

describe('a static website with an API endpoint', () => {
  it('says the build needs a server for the endpoint, naming it, and how to go on', async () => {
    const { c } = await site('static', { endpoint: true });
    const r = await c.buildStaticTo(join(temp('out'), 'site'));
    expect(r.ok).toBe(false);
    expect(r.message).toBe('The website is built as a static website, which cannot answer an API endpoint that needs a server: src/routes/api/hello. Choose Node.js server under Deployment in Site settings (with Developer mode on) to export it, then export again.');
    expect(r.warnings[0]).toContain('export const prerender = true');
  });

  it('exports as before once the target is static and there is no endpoint, opening its pages from its folder', async () => {
    const { c, asked } = await site('static');
    const dest = join(temp('out'), 'site');
    const r = await c.buildStaticTo(dest);
    expect(r.ok).toBe(true);
    expect(env.served).toEqual([]);
    expect(asked.length).toBeGreaterThan(1);
    expect(existsSync(join(dest, 'index.html'))).toBe(true);
    expect(existsSync(join(dest, 'package.json'))).toBe(false);
    expect(r.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });
});
