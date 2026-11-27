/**
 * The editor's scripts are minified (#958), and a stack trace from a packaged build still names the functions it
 * passed through, so a bug report's Technical details can be read: built here with the renderer's own minify options
 * from electron.vite.config.ts.
 */
import { runInNewContext } from 'node:vm';
import { build, type Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';
import config from '../../electron.vite.config';

type RendererBuild = { minify?: unknown; cssMinify?: unknown; rollupOptions?: { output?: { keepNames?: boolean } } };
const renderer = (config as unknown as { renderer: { build: RendererBuild } }).renderer.build;

const ENTRY = [
  'function readProjectFile(path) { throw new Error(`Could not read ${path}`); }',
  'const openRecentProject = (dir) => readProjectFile(`${dir}/siteorigin/site.json`);',
  'class ProjectLoader { load(dir) { return openRecentProject(dir); } }',
  'try { new ProjectLoader().load("/projects/a"); } catch (e) { globalThis.stack = e.stack; }'
].join('\n');

describe('the editor’s minified scripts', () => {
  it('are minified, and keep the names a stack trace shows', async () => {
    expect(renderer.minify).toBeTruthy();
    const out = (await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [{ name: 'entry', enforce: 'pre', resolveId: (id) => (id === '\0entry' ? id : null), load: (id) => (id === '\0entry' ? ENTRY : null) }],
      build: { write: false, minify: renderer.minify as 'oxc', rolldownOptions: { input: '\0entry', output: { format: 'iife', keepNames: renderer.rollupOptions?.output?.keepNames } } }
    })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
    const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk') throw new Error('Nothing was built');
    // Minified: none of the source's own layout is left.
    expect(chunk.code).not.toContain('\n  ');
    const sandbox: { stack?: string } = {};
    runInNewContext(chunk.code, sandbox);
    expect(sandbox.stack).toContain('Could not read /projects/a/siteorigin/site.json');
    for (const frame of ['at readProjectFile ', 'at openRecentProject ', 'at ProjectLoader.load ']) expect(sandbox.stack).toContain(frame);
  });
});
