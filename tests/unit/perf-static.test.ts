import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeBuild, resolveExports, specifiers, staticTables, type StaticReport } from '../../scripts/perf/static';

let root: string;
const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

/** A built app in miniature: an editor page with an eager and a lazy chunk, a main entry sharing a chunk with a worker. */
function build() {
  put('out/renderer/index.html', '<script type="module" crossorigin src="./assets/index-a1.js"></script><link rel="stylesheet" crossorigin href="./assets/index-c3.css">');
  put('out/renderer/assets/index-a1.js', 'import{b as x}from"./chunk-b2.js";const later=()=>import("./lazy-d4.js");x(later);');
  put('out/renderer/assets/chunk-b2.js', 'export const b=(f)=>f;');
  put('out/renderer/assets/lazy-d4.js', 'export default 1;');
  put('out/renderer/assets/index-c3.css', 'body{color:red}');
  put('out/main/index.js', 'import { shared } from "./chunks/shared-e5.js";\nimport big from "bigpkg";\nimport { readFile } from "node:fs";\nimport electron from "electron";\nconst ai = () => import("lazypkg");\nshared(big, ai, readFile, electron);\n');
  put('out/main/chunks/shared-e5.js', 'export const shared = () => {};\n');
  put('out/main/media-worker.js', 'import { shared } from "./chunks/shared-e5.js";\nimport only from "workeronly";\nshared(only);\n');
  put('out/preload/index.cjs', 'const { contextBridge } = require("electron");\n');
  // bigpkg loads its ESM build when imported, which pulls in depdep through CommonJS.
  put('node_modules/bigpkg/package.json', JSON.stringify({ name: 'bigpkg', version: '2.0.0', exports: { '.': { import: './esm/index.js', require: './cjs/index.js' } } }));
  put('node_modules/bigpkg/esm/index.js', 'import "./util.js";\nimport dep from "depdep";\nexport default dep;\n');
  put('node_modules/bigpkg/esm/util.js', 'export const u = 1;\n');
  put('node_modules/bigpkg/cjs/index.js', 'module.exports = require("never-loaded");\n');
  put('node_modules/depdep/package.json', JSON.stringify({ name: 'depdep', version: '1.0.0', main: 'lib.js' }));
  put('node_modules/depdep/lib.js', 'module.exports = require("./x");\n');
  put('node_modules/depdep/x.js', 'module.exports = 1;\n');
  put('node_modules/lazypkg/package.json', JSON.stringify({ name: 'lazypkg', version: '1.0.0', main: 'index.js' }));
  put('node_modules/lazypkg/index.js', 'export default 1;\n');
  put('node_modules/workeronly/package.json', JSON.stringify({ name: 'workeronly', version: '1.0.0', main: 'index.js' }));
  put('node_modules/workeronly/index.js', 'export default 1;\n');
}

describe('the static report', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'perf-static-'));
    build();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads static imports only, minified or not', () => {
    expect(specifiers('import{a}from"x";import "y";export*from"z";const q=import("lazy");import.meta.url;')).toEqual({ imports: ['x', 'y', 'z'], requires: [] });
    expect(specifiers('const a = require("a"); x.require("not");').requires).toEqual(['a']);
  });

  it('resolves exports as Node does, by condition and pattern', () => {
    const exp = { '.': { node: { import: './n.mjs', require: './n.cjs' }, default: './d.js' }, './features/*': { import: './f/*.mjs' }, './skip': null };
    expect(resolveExports(exp, '.', ['node', 'import', 'default'])).toBe('./n.mjs');
    expect(resolveExports(exp, '.', ['node', 'require', 'default'])).toBe('./n.cjs');
    expect(resolveExports(exp, './features/a', ['node', 'import', 'default'])).toBe('./f/a.mjs');
    expect(resolveExports(exp, './skip', ['node', 'import', 'default'])).toBeNull();
    expect(resolveExports('./main.js', '.', ['import'])).toBe('./main.js');
  });

  it('counts the editor page’s script as it loads, and the main entry’s packages from its static imports', () => {
    const r = analyzeBuild(join(root, 'out'));
    expect(r.rows['renderer.script'].files).toEqual(['renderer/assets/chunk-b2.js', 'renderer/assets/index-a1.js']);
    expect(r.rows['renderer.style'].files).toEqual(['renderer/assets/index-c3.css']);
    expect(r.rows['renderer.later'].files).toEqual(['renderer/assets/lazy-d4.js']);
    expect(r.rows.main.files).toEqual(['main/chunks/shared-e5.js', 'main/index.js']);
    expect(r.rows['worker.media-worker'].files).toEqual(['main/chunks/shared-e5.js', 'main/media-worker.js']);
    expect(r.rows.preload.files).toEqual(['preload/index.cjs']);
    expect(r.rows.main.gzip).toBeGreaterThan(0);
    // A dynamic import, a worker's own package and the require build an import never loads are not part of startup.
    expect(Object.keys(r.packages)).toEqual(['bigpkg', 'depdep']);
    expect(r.packages.bigpkg).toMatchObject({ version: '2.0.0', files: 2 });
    expect(r.packages.depdep).toMatchObject({ version: '1.0.0', files: 2 });
  });

  it('shows a difference when the editor’s script grows or a package joins the main entry’s static imports', () => {
    const baseline: StaticReport = analyzeBuild(join(root, 'out'));
    expect(staticTables(baseline, analyzeBuild(join(root, 'out')))).toContain('No package differs from the baseline.');
    appendFileSync(join(root, 'out/renderer/assets/chunk-b2.js'), `/*${'x'.repeat(20_000)}*/`);
    put('node_modules/hugepkg/package.json', JSON.stringify({ name: 'hugepkg', version: '9.0.0', main: 'index.js' }));
    put('node_modules/hugepkg/index.js', `export default "${'y'.repeat(50_000)}";\n`);
    appendFileSync(join(root, 'out/main/index.js'), 'import huge from "hugepkg";\n');
    const now = analyzeBuild(join(root, 'out'));
    expect(now.rows['renderer.script'].raw - baseline.rows['renderer.script'].raw).toBe(20_004);
    expect(now.packages.hugepkg).toMatchObject({ version: '9.0.0', files: 1 });
    const out = staticTables(baseline, now);
    expect(out).toMatch(/renderer\.script .*\+19\.5 KiB/);
    expect(out).toMatch(/hugepkg +9\.0\.0 .* added/);
  });
});
