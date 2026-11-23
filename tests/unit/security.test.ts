import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer, resolveConfig } from 'vite';
import { atomicWrite } from '../../src/main/project/fsutil';
import { canonicalDir, frameAncestorsCsp, framePolicyPlugin, previewFsPolicy, realFileInside } from '../../src/runtime/policy';
import { projectSrcPath } from '../../src/runtime/paths';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'so-sec-'));
  dirs.push(d);
  return d;
};

describe('atomicWrite', () => {
  it.skipIf(process.platform === 'win32')('creates a private file with its final mode before the rename', async () => {
    const dir = tmp();
    const file = join(dir, 'api-keys.json');
    // An older, world-readable file is replaced, not chmodded in place.
    writeFileSync(file, '{}', { mode: 0o644 });
    await atomicWrite(file, '{"openai":"sk-test"}', { mode: 0o600 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['api-keys.json']);
  });

  it('leaves no temporary file behind when the write fails', async () => {
    const dir = tmp();
    // Renaming a file over a directory fails.
    const target = join(dir, 'taken');
    await atomicWrite(join(target, 'inner'), 'x');
    await expect(atomicWrite(target, 'y')).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(['taken']);
  });
});

describe('preview server policy', () => {
  // Ask Vite itself, so this checks the patterns the way the preview server reads them.
  const denier = async (dir: string) => {
    const config = await resolveConfig({ configFile: false, root: dir, logLevel: 'silent', server: { fs: previewFsPolicy(dir) } }, 'serve');
    return (config as unknown as { fsDenyGlob: (p: string) => boolean }).fsDenyGlob;
  };

  it('never serves editor data, secrets or credentials', async () => {
    const dir = tmp();
    const denied = (_d: string, abs: string) => deny(abs);
    const deny = await denier(dir);
    for (const f of ['.siteorigin/history/blobs/abc.json', '.siteorigin/lock.json', '.env', '.env.local', 'server.key', 'cert.pem', 'id.p12', '.git/config', '.npmrc', '.yarnrc.yml'])
      expect(denied(dir, `${dir}/${f}`), f).toBe(true);
    for (const f of ['src/routes/+page.svelte', 'static/assets/logo.png', 'siteorigin/site.json']) expect(denied(dir, `${dir}/${f}`), f).toBe(false);
    expect(previewFsPolicy(dir)).toMatchObject({ strict: true, allow: [dir] });
  });

  it.skipIf(process.platform === 'win32')('refuses a cache entry that links outside the cache', () => {
    const root = tmp();
    const cache = join(root, 'cache');
    mkdirSync(join(cache, 'src'), { recursive: true });
    writeFileSync(join(cache, 'src', 'real.svelte'), 'ok');
    const secret = join(tmp(), 'secret.txt');
    writeFileSync(secret, 'secret');
    symlinkSync(secret, join(cache, 'src', 'link.svelte'));
    symlinkSync(dirname(secret), join(cache, 'linked-dir'));
    expect(realFileInside(cache, join(cache, 'src', 'real.svelte'))).toBe(true);
    expect(realFileInside(cache, join(cache, 'src', 'link.svelte'))).toBe(false);
    expect(realFileInside(cache, join(cache, 'linked-dir', 'secret.txt'))).toBe(false);
    expect(realFileInside(cache, join(cache, 'src', 'missing.svelte'))).toBe(false);
    expect(realFileInside(cache, cache)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('works for a project behind a linked parent, and still refuses links out of its cache', () => {
    const realParent = tmp();
    const linkParent = join(tmp(), 'linked');
    symlinkSync(realParent, linkParent);
    const real = realpathSync(join(realParent));
    mkdirSync(join(realParent, 'site', '.siteorigin', 'cache', 'dev', 'src'), { recursive: true });
    const viaLink = join(linkParent, 'site');
    const root = canonicalDir(viaLink);
    expect(root).toBe(join(real, 'site'));
    expect(canonicalDir(join(linkParent, 'not-there'))).toBe(join(linkParent, 'not-there'));
    // Modules are named by the real path, which the dev-cache lookup now shares.
    expect(projectSrcPath(root, `${root}/src/routes/+page.svelte?v=1`)).toBe('src/routes/+page.svelte');
    const cache = join(viaLink, '.siteorigin', 'cache', 'dev');
    writeFileSync(join(cache, 'src', 'page.svelte'), 'ok');
    expect(realFileInside(cache, join(cache, 'src', 'page.svelte'))).toBe(true);
    expect(realFileInside(viaLink, join(cache, 'src', 'page.svelte'))).toBe(true);
    const secret = join(tmp(), 'secret.txt');
    writeFileSync(secret, 'secret');
    symlinkSync(secret, join(cache, 'src', 'planted.svelte'));
    expect(realFileInside(cache, join(cache, 'src', 'planted.svelte'))).toBe(false);
    expect(realFileInside(viaLink, join(cache, 'src', 'planted.svelte'))).toBe(false);
  });

  it('only lets the editor frame the preview', () => {
    expect(frameAncestorsCsp(true)).toBe('frame-ancestors app://editor');
    expect(frameAncestorsCsp(false).split(' ').slice(1)).toEqual(['app://editor', 'http://127.0.0.1:*', 'http://localhost:*']);
  });

  it('sends the frame policy on every response, including those answered before any other middleware', async () => {
    const root = tmp();
    mkdirSync(join(root, 'public'));
    writeFileSync(join(root, 'public', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>x</title>');
    // Like SvelteKit's asset server: registered first, answers static files itself and never calls next().
    const earlyAssets = {
      name: 'early-assets',
      configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: { end(b: string): void }, next: () => void) => void) => void } }) {
        server.middlewares.use((req, res, next) => (req.url === '/early.txt' ? res.end('early') : next()));
      }
    };
    const server = await createServer({ root, configFile: false, logLevel: 'silent', publicDir: 'public', plugins: [earlyAssets, framePolicyPlugin('frame-ancestors app://editor')], server: { host: '127.0.0.1', port: 0, ws: false } });
    try {
      await server.listen();
      const { port } = server.httpServer!.address() as { port: number };
      for (const path of ['/early.txt', '/logo.svg', '/index.html', '/missing']) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`);
        await res.arrayBuffer();
        expect(res.headers.get('content-security-policy'), path).toBe('frame-ancestors app://editor');
      }
    } finally {
      await server.close();
    }
  });
});
