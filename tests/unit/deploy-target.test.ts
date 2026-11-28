/**
 * How the website is built and deployed (#1481, shared/deploy-target.ts): a static website unless the author chooses a
 * Node.js server, which the generated paths.json tells the template's vite.config.js, with no host redirect rules,
 * a README that says how it starts, and a server package ready to run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { generatePathsJson, generateProject } from '@generator/index';
import { generateHostRedirects, generateVercelConfig, HOST_HEADERS_FILE, HOST_REDIRECTS_FILE, VERCEL_CONFIG_FILE } from '@generator/host-redirects';
import { deployTarget, runsOnNode } from '@shared/deploy-target';
import { validateOperation } from '@shared/ops';
import type { EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';
import { cleanBuiltSite, explainBuildFailure, isGeneratedReadme, nodeServerReadme, nodeUncleanedMessage, projectReadme, writeNodeServerFiles } from '../../src/main/export';
import { geotaggedJpeg } from './fixtures/photos';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const starter = () => createStarterState('business', 'Harbour Lane', false);
const dirs: string[] = [];
const temp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'so-deploy-')));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('the deployment target', () => {
  it('is a static website until a Node.js server is chosen, and is stored only then', () => {
    const s = starter();
    expect(deployTarget(s.site)).toBe('static');
    const node = run(s, { type: 'site.update', deployTarget: 'node' });
    expect(node.site.deployTarget).toBe('node');
    expect(runsOnNode(node.site)).toBe(true);
    const back = run(node, { type: 'site.update', deployTarget: 'static' });
    expect(back.site.deployTarget).toBeUndefined();
    expect(Object.hasOwn(back.site, 'deployTarget')).toBe(false);
    expect(validateOperation({ type: 'site.update', deployTarget: 'vercel' }).ok).toBe(false);
    for (const deployTarget of ['static', 'node'] as const) expect(validateOperation({ type: 'site.update', deployTarget })).toMatchObject({ ok: true, op: { deployTarget } });
    // Any other change to the site's settings leaves it as it is.
    expect(run(node, { type: 'site.update', name: 'Harbour' }).site.deployTarget).toBe('node');
  });

  it('reaches vite.config.js through paths.json, named only for a Node.js server', () => {
    const s = run(starter(), { type: 'site.update', baseUrl: 'https://harbour.example/studio' });
    expect(generatePathsJson(s)).toBe('{\n\t"base": "/studio"\n}\n');
    expect(JSON.parse(generatePathsJson(run(s, { type: 'site.update', deployTarget: 'node' })))).toEqual({ base: '/studio', deployTarget: 'node' });
    // The generated project carries it, and a later change makes the file again.
    const files = generateProject(run(s, { type: 'site.update', deployTarget: 'node' }));
    expect(JSON.parse(files.get('src/lib/siteorigin/paths.json')!)).toEqual({ base: '/studio', deployTarget: 'node' });
  });

  it('gives a Node.js server no host’s redirect rules, keeping each old address’s page', () => {
    const moved = run(starter(), { type: 'site.update', redirectHost: 'vercel' }, { type: 'redirect.add', from: '/old/', to: '/contact/' });
    expect(generateHostRedirects(moved)).not.toBeNull();
    expect(generateVercelConfig(moved)).not.toBeNull();
    const node = run(moved, { type: 'site.update', deployTarget: 'node' });
    expect(generateHostRedirects(node)).toBeNull();
    expect(generateVercelConfig(node)).toBeNull();
    const files = generateProject(node);
    expect(files.has(HOST_REDIRECTS_FILE)).toBe(false);
    expect(files.has(VERCEL_CONFIG_FILE)).toBe(false);
    // Nor the hosts' caching rules: adapter-node caches its hashed files itself.
    expect(generateProject(moved).has(HOST_HEADERS_FILE)).toBe(true);
    expect(files.has(HOST_HEADERS_FILE)).toBe(false);
    expect([...files.keys()].some((f) => f.startsWith('src/routes/old'))).toBe(true);
  });

  it('builds with adapter-node from the starter’s own locked tools', () => {
    const dir = join(process.cwd(), 'templates/sveltekit-brochure/files');
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
    expect(pkg.devDependencies['@sveltejs/adapter-node']).toBe('6.0.6');
    expect(lock.packages[''].devDependencies['@sveltejs/adapter-node']).toBe('6.0.6');
    expect(lock.packages['node_modules/@sveltejs/adapter-node']).toMatchObject({ version: '6.0.6', dependencies: { '@sveltejs/adapter-server': '^0.2.0' } });
    expect(lock.packages['node_modules/@sveltejs/adapter-server']).toMatchObject({ version: '0.2.0' });
    const config = readFileSync(join(dir, 'vite.config.js'), 'utf8');
    expect(config).toContain("import nodeAdapter from '@sveltejs/adapter-node';");
    expect(config).toContain("settings.deployTarget === 'node'");
  });
});

describe('a build that stops at an endpoint', () => {
  const failed = { ok: false, error: 'Encountered dynamic routes', logs: ['@sveltejs/adapter-static: all routes must be fully prerenderable, but found the following routes that are dynamic:', '  - src/routes/api/search', '  - src/routes/api/posts/[id]', 'You have the following options:'] };

  it('names the endpoints and the two ways on, on a static website', () => {
    const r = explainBuildFailure(starter(), failed);
    expect(r.message).toBe('The website is built as a static website, which cannot answer API endpoints that need a server: src/routes/api/search and src/routes/api/posts/[id]. Choose Node.js server under Deployment in Site settings (with Developer mode on) to export them, then export again.');
    // Another failure of a static build is said as before.
    expect(explainBuildFailure(starter(), { error: 'Something else broke', logs: ['  - src/routes/api/search'] }).message).not.toContain('Node.js server');
    expect(r.warnings[0]).toContain('export const prerender = true');
    expect(r.details).toContain(r.message);
  });

  it('is any other failure on a Node.js server, which builds them', () => {
    expect(explainBuildFailure(run(starter(), { type: 'site.update', deployTarget: 'node' }), failed).message).not.toContain('Choose Node.js server');
  });
});

describe('what a Node.js server goes out with', () => {
  it('a package that starts it as ES modules, with the packages its server code imports, and a README that says how', async () => {
    const project = temp();
    const out = join(project, 'build');
    mkdirSync(out);
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'harbour', version: '1.2.0', type: 'module', engines: { node: '>=22.17.0' }, devDependencies: { vite: '8.3.8' }, dependencies: { nanoid: '^5.0.0' } }));
    await writeNodeServerFiles(out, starter(), project);
    expect(JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))).toEqual({ name: 'harbour', version: '1.2.0', private: true, type: 'module', scripts: { start: 'node index.js' }, engines: { node: '>=22.17.0' }, dependencies: { nanoid: '^5.0.0' } });
    const readme = readFileSync(join(out, 'README.md'), 'utf8');
    // No lockfile to install from exactly.
    expect(readme).toContain('npm install --omit=dev');
    expect(readme).toContain('node index.js');
    expect(readme).toContain('ORIGIN');
    expect(nodeServerReadme('Harbour Lane')).not.toContain('npm ci');
  });

  it('with the project’s lockfile, and a manifest that lists what it does, when its server code imports packages', async () => {
    const project = temp();
    const out = join(project, 'build');
    mkdirSync(out);
    const lock = JSON.stringify({ name: 'harbour', lockfileVersion: 3, packages: { '': { dependencies: { nanoid: '5.0.1' }, devDependencies: { vite: '8.3.8' } } } });
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'harbour', type: 'module', engines: { node: '>=24' }, devDependencies: { vite: '8.3.8' }, dependencies: { nanoid: '5.0.1' }, overrides: { foo: '1.0.0' } }));
    writeFileSync(join(project, 'package-lock.json'), lock);
    await writeNodeServerFiles(out, starter(), project);
    expect(JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))).toMatchObject({ type: 'module', engines: { node: '>=24' }, dependencies: { nanoid: '5.0.1' }, devDependencies: { vite: '8.3.8' }, overrides: { foo: '1.0.0' } });
    expect(readFileSync(join(out, 'package-lock.json'), 'utf8')).toBe(lock);
    expect(readFileSync(join(out, 'README.md'), 'utf8')).toContain('npm ci --omit=dev');
    // None at all: no lockfile goes with it.
    const bare = temp();
    mkdirSync(join(bare, 'build'));
    writeFileSync(join(bare, 'package.json'), JSON.stringify({ name: 'x', devDependencies: { vite: '8.3.8' } }));
    writeFileSync(join(bare, 'package-lock.json'), lock);
    await writeNodeServerFiles(join(bare, 'build'), starter(), bare);
    expect(existsSync(join(bare, 'build', 'package-lock.json'))).toBe(false);
    // Packages but no lockfile to install them from: npm ci cannot, npm install can.
    const unlocked = temp();
    mkdirSync(join(unlocked, 'build'));
    writeFileSync(join(unlocked, 'package.json'), JSON.stringify({ name: 'x', dependencies: { nanoid: '^5.0.0' } }));
    await writeNodeServerFiles(join(unlocked, 'build'), starter(), unlocked);
    expect(readFileSync(join(unlocked, 'build', 'README.md'), 'utf8')).toContain('npm install --omit=dev');
    expect(readFileSync(join(unlocked, 'build', 'README.md'), 'utf8')).not.toContain('npm ci');
    // Nor the build's own tools, which npm install would fetch for nothing (or fail to, from a path it does not have).
    const both = temp();
    mkdirSync(join(both, 'build'));
    writeFileSync(join(both, 'package.json'), JSON.stringify({ name: 'x', dependencies: { nanoid: '^5.0.0' }, devDependencies: { tools: 'file:../tools.tgz' } }));
    await writeNodeServerFiles(join(both, 'build'), starter(), both);
    expect(JSON.parse(readFileSync(join(both, 'build', 'package.json'), 'utf8')).devDependencies).toBeUndefined();
  });

  it('nothing rewritten in its build, whose files the server has measured: what would be is listed instead', async () => {
    const dir = temp();
    mkdirSync(join(dir, 'client/_app'), { recursive: true });
    writeFileSync(join(dir, 'client/_app/pkg.jpg'), geotaggedJpeg());
    writeFileSync(join(dir, 'client/index.html'), `<img src="data:image/jpeg;base64,${geotaggedJpeg().toString('base64')}">`);
    const unrewritten: string[] = [];
    expect(await cleanBuiltSite(dir, undefined, { unrewritten })).toEqual([]);
    expect(unrewritten.sort()).toEqual(['client/_app/pkg.jpg', 'client/index.html']);
    expect(readFileSync(join(dir, 'client/_app/pkg.jpg')).equals(geotaggedJpeg())).toBe(true);
    expect(nodeUncleanedMessage(unrewritten)).toContain('_app/pkg.jpg');
    expect(existsSync(join(dir, 'client/_app/pkg.jpg.br'))).toBe(false);
  });

  it('a project README that says it is a Node.js server, which the app still knows as its own', () => {
    const node = projectReadme('Harbour Lane', false, undefined, false, 'cloudflare', false, null, true);
    expect(node).toContain('node build/index.js');
    expect(node).toContain('src/env.js');
    expect(node).not.toContain('### Not-found page');
    expect(isGeneratedReadme(node)).toBe(true);
    const plain = projectReadme('Harbour Lane');
    expect(plain).toContain('### Not-found page');
    expect(plain).toContain('build the static website into build/');
    expect(isGeneratedReadme(plain)).toBe(true);
  });
});
