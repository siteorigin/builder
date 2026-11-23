import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from 'vite';
import { atomicWrite } from '../../src/main/project/fsutil';
import { frameAncestorsCsp, framePolicyPlugin, previewFsPolicy } from '../../src/runtime/policy';

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

  it('only lets the editor frame the preview', () => {
    expect(frameAncestorsCsp(true)).toBe('frame-ancestors app://editor');
    expect(frameAncestorsCsp(false).split(' ').slice(1)).toEqual(['app://editor', 'http://127.0.0.1:*', 'http://localhost:*']);
  });

  it('sends the frame policy on every response, before SvelteKit handles it', () => {
    let mw: ((req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => void) | null = null;
    framePolicyPlugin('frame-ancestors app://editor').configureServer({ middlewares: { use: (fn) => (mw = fn) } });
    const headers: Record<string, string> = {};
    let nexted = false;
    mw!({}, { setHeader: (k, v) => (headers[k] = v) }, () => (nexted = true));
    expect(headers['Content-Security-Policy']).toBe('frame-ancestors app://editor');
    expect(nexted).toBe(true);
  });
});
