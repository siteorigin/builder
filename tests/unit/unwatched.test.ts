import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { unwatched } from '../../src/runtime/policy';

describe('what the preview server does not watch', () => {
  it('leaves the editor’s data, the build output, node_modules and the build configuration alone, and watches the source', () => {
    const ignored = unwatched('/work/site', 'linux');
    for (const p of ['/work/site/.siteorigin', '/work/site/.siteorigin/cache/dev/isolated/.draft-x/a.js', '/work/site/siteorigin/site.json', '/work/site/build/index.html', '/work/site/node_modules/vite/package.json', '/work/site/.svelte-kit/output/x.js', '/work/site/vite.config.js', '/work/site/svelte.config.js', '/work/site/package.json', '/work/site/package-lock.json'])
      expect(ignored(p), p).toBe(true);
    for (const p of ['/work/site', '/work/site/src/lib/siteorigin/generated/Hero.svelte', '/work/site/src/routes/+page.svelte', '/work/site/static/llms.txt', '/work/site/.svelte-kit/generated/x.js', '/work/site/siteorigin-notes.txt', '/work/site/src/package.json', '/work/sitemap/.siteorigin/x'])
      expect(ignored(p), p).toBe(false);
  });

  it('reads a Windows path in either separator and any case, as Vite’s watcher (C:/…) and the publication gate (C:\\…) ask', () => {
    const ignored = unwatched('C:\\Users\\Ana\\OneDrive\\Documents\\SiteOrigin\\my-site', 'win32');
    for (const p of [
      'C:/Users/Ana/OneDrive/Documents/SiteOrigin/my-site/.siteorigin/cache/dev/isolated/.draft-ab12/src/x.svelte',
      'C:\\Users\\Ana\\OneDrive\\Documents\\SiteOrigin\\my-site\\.siteorigin',
      'c:/users/ana/onedrive/documents/siteorigin/my-site/siteorigin/pages/home.json',
      'C:/Users/Ana/OneDrive/Documents/SiteOrigin/my-site/vite.config.js',
      'C:/Users/Ana/OneDrive/Documents/SiteOrigin/my-site/node_modules/svelte/package.json'
    ])
      expect(ignored(p), p).toBe(true);
    for (const p of ['C:/Users/Ana/OneDrive/Documents/SiteOrigin/my-site/src/routes/+page.svelte', 'C:\\Users\\Ana\\OneDrive\\Documents\\SiteOrigin\\my-site\\src\\lib\\siteorigin\\generated\\Hero.svelte', 'C:/Users/Ana/OneDrive/Documents/SiteOrigin/my-site'])
      expect(ignored(p), p).toBe(false);
  });

  it('keeps case and backslashes meaningful where the platform does', () => {
    const ignored = unwatched('/work/site', 'darwin');
    expect(ignored('/work/site/.SiteOrigin/x')).toBe(false);
    expect(ignored('/work/site\\.siteorigin\\x')).toBe(false);
  });

  describe('in a real preview server on this computer', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'so-unwatched-')));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('never opens a watch on the editor’s data, so a component preview’s folder can be moved into place', async () => {
      for (const d of ['.siteorigin/cache/dev/isolated', 'siteorigin', 'src/routes']) mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, 'siteorigin', 'site.json'), '{}');
      writeFileSync(join(root, 'src', 'routes', '+page.svelte'), '<h1>Hi</h1>');
      writeFileSync(join(root, 'vite.config.js'), 'export default {};');
      const server = await createServer({ root, configFile: false, logLevel: 'silent', server: { port: 0, watch: { ignored: unwatched(root) } } });
      try {
        const list = () => Object.entries(server.watcher.getWatched()).flatMap(([folder, names]) => [folder, ...names.map((n) => join(folder, n))]);
        // The watcher scans the project once it starts: wait until it holds the source.
        for (let i = 0; i < 100 && !list().some((p) => p.endsWith(join('src', 'routes'))); i++) await new Promise((r) => setTimeout(r, 50));
        await new Promise((r) => setTimeout(r, 300));
        const watched = list();
        const ignored = unwatched(root);
        expect(watched.some((p) => p.endsWith(join('src', 'routes'))), 'the source is watched').toBe(true);
        expect(watched.filter((p) => p.startsWith(join(root, '.siteorigin')) || p.startsWith(join(root, 'siteorigin')) || p === join(root, 'vite.config.js'))).toEqual([]);
        // What the watcher holds is what the predicate allows, whichever way the platform spells it.
        expect(watched.filter((p) => ignored(p))).toEqual([]);
      } finally {
        await server.close();
      }
    });
  });
});
