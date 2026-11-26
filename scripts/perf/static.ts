/**
 * The static report of the built app (scripts/perf/README.md): `npm run perf:static [-- --app <checkout>]
 * [--update-baseline] [--json <file>]`. Reads `out/` only; nothing is launched.
 *
 * Rows: the editor's script and stylesheet as its page loads them (the entry and every file it imports statically),
 * the rest of its files (loaded later), the main bundle, the preload and each worker, each as raw and gzip bytes
 * (gzip at level 9, file by file). Packages: the main entry's static dependency closure, the installed packages its
 * static imports reach and the files and bytes of each reached through their own static imports and literal
 * `require()` calls. That is what the main process evaluates before its first line runs, so before the window can be
 * created; an `await import()` made before the window is not in it, and a `require()` inside a function body that never
 * runs is counted anyway.
 *
 * The report is printed beside the checked-in baseline (scripts/perf/baseline/static.json) with the difference per row
 * and per package. Nothing fails on a difference: it is evidence for a pull request, never a budget.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { formatValue, table } from './results';

export interface StaticRow {
  raw: number;
  gzip: number;
  /** The files counted, relative to out/. */
  files: string[];
}

export interface StaticPackage {
  version: string;
  files: number;
  bytes: number;
}

export interface StaticReport {
  schemaVersion: 1;
  rows: Record<string, StaticRow>;
  packages: Record<string, StaticPackage>;
}

const BUILTINS = new Set([...builtinModules, 'electron']);
const isBuiltin = (spec: string) => spec.startsWith('node:') || BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0]);
const isRelative = (spec: string) => spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/');

// Static imports and re-exports, minified or not; `import(` (a dynamic import) and `import.meta` never match.
const IMPORT_RE = /(?:^|[^.\w$])(?:import|export)\s*(?:[\w$*{}\s,]*?\bfrom\s*)?["']([^"'\n]+)["']/g;
const REQUIRE_RE = /(?:^|[^.\w$])require\s*\(\s*["']([^"'\n]+)["']\s*\)/g;

/** The specifiers a file loads statically, by how it loads them. */
export function specifiers(source: string): { imports: string[]; requires: string[] } {
  const all = (re: RegExp) => [...source.matchAll(re)].map((m) => m[1]);
  return { imports: all(IMPORT_RE), requires: all(REQUIRE_RE) };
}

const EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.json'];

function asFile(path: string): string | null {
  for (const ext of EXTENSIONS) {
    const p = path + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  if (existsSync(path) && statSync(path).isDirectory()) {
    const pkg = join(path, 'package.json');
    const main = existsSync(pkg) ? (JSON.parse(readFileSync(pkg, 'utf8')) as { main?: string }).main : undefined;
    return (main && asFile(join(path, main))) || asFile(join(path, 'index'));
  }
  return null;
}

function exportTarget(target: unknown, conditions: string[], star: string): string | null {
  if (typeof target === 'string') return target.replace(/\*/g, star);
  if (Array.isArray(target)) {
    for (const t of target) {
      const r = exportTarget(t, conditions, star);
      if (r) return r;
    }
    return null;
  }
  if (target && typeof target === 'object') {
    for (const [k, v] of Object.entries(target)) {
      if (!conditions.includes(k)) continue;
      const r = exportTarget(v, conditions, star);
      if (r) return r;
    }
  }
  return null;
}

/** A package's `exports` for `subpath` ("." or "./x") under `conditions`, as Node reads it; null when it exports none. */
export function resolveExports(exports: unknown, subpath: string, conditions: string[]): string | null {
  if (typeof exports === 'string' || Array.isArray(exports)) return subpath === '.' ? exportTarget(exports, conditions, '') : null;
  if (!exports || typeof exports !== 'object') return null;
  const map = exports as Record<string, unknown>;
  if (!Object.keys(map).some((k) => k.startsWith('.'))) return subpath === '.' ? exportTarget(map, conditions, '') : null;
  if (Object.hasOwn(map, subpath)) return exportTarget(map[subpath], conditions, '');
  for (const key of Object.keys(map)) {
    const at = key.indexOf('*');
    if (at < 0) continue;
    const pre = key.slice(0, at);
    const post = key.slice(at + 1);
    if (subpath.startsWith(pre) && subpath.endsWith(post) && subpath.length >= pre.length + post.length) return exportTarget(map[key], conditions, subpath.slice(pre.length, subpath.length - post.length));
  }
  return null;
}

const CONDITIONS = { import: ['node', 'import', 'default'], require: ['node', 'require', 'default'] };

/** Where `spec` leads from the file `from`, loaded by `how`, as Node would find it; null when it cannot be found. */
export function resolveSpecifier(from: string, spec: string, how: 'import' | 'require'): string | null {
  if (isRelative(spec)) return asFile(resolve(dirname(from), spec.split('?')[0]));
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const subpath = `.${spec.slice(name.length)}` || '.';
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const root = join(dir, 'node_modules', name);
    const pkgFile = join(root, 'package.json');
    if (existsSync(pkgFile)) {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { exports?: unknown; main?: string };
      if (pkg.exports !== undefined) {
        const target = resolveExports(pkg.exports, subpath === '.' ? '.' : subpath, CONDITIONS[how]);
        return target ? asFile(join(root, target)) : null;
      }
      return subpath === '.' ? asFile(pkg.main ? join(root, pkg.main) : join(root, 'index')) : asFile(join(root, subpath));
    }
    if (dirname(dir) === dir) return null;
  }
}

/** The package a file under node_modules belongs to: its name and the folder it is installed in. */
function packageOf(file: string): { name: string; root: string } | null {
  const parts = file.split(sep);
  const at = parts.lastIndexOf('node_modules');
  if (at < 0 || at + 1 >= parts.length) return null;
  const name = parts[at + 1].startsWith('@') ? `${parts[at + 1]}/${parts[at + 2]}` : parts[at + 1];
  return { name, root: parts.slice(0, at + 1).join(sep) + sep + name };
}

/** Every local file `entries` load statically (relative specifiers only), entries included. */
export function localClosure(entries: string[]): string[] {
  const seen = new Set<string>();
  const todo = [...entries];
  while (todo.length) {
    const file = todo.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    if (!/\.(m|c)?js$/.test(file)) continue;
    const { imports, requires } = specifiers(readFileSync(file, 'utf8'));
    for (const spec of [...imports, ...requires]) if (isRelative(spec)) todo.push(resolve(dirname(file), spec));
  }
  return [...seen].sort();
}

/** The installed packages `files` load statically, followed through their own static loads. */
export function packageClosure(files: string[]): Record<string, StaticPackage> {
  const seen = new Set<string>();
  const todo: Array<{ from: string; spec: string; how: 'import' | 'require' }> = [];
  const queue = (file: string) => {
    const { imports, requires } = specifiers(readFileSync(file, 'utf8'));
    for (const spec of imports) if (!isBuiltin(spec)) todo.push({ from: file, spec, how: 'import' });
    for (const spec of requires) if (!isBuiltin(spec)) todo.push({ from: file, spec, how: 'require' });
  };
  for (const f of files) if (/\.(m|c)?js$/.test(f)) {
    const { imports, requires } = specifiers(readFileSync(f, 'utf8'));
    for (const spec of imports) if (!isBuiltin(spec) && !isRelative(spec)) todo.push({ from: f, spec, how: 'import' });
    for (const spec of requires) if (!isBuiltin(spec) && !isRelative(spec)) todo.push({ from: f, spec, how: 'require' });
  }
  const out: Record<string, StaticPackage> = {};
  while (todo.length && seen.size < 50_000) {
    const { from, spec, how } = todo.pop()!;
    const file = resolveSpecifier(from, spec, how);
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const pkg = packageOf(file);
    if (!pkg) continue;
    const version = (JSON.parse(readFileSync(join(pkg.root, 'package.json'), 'utf8')) as { version?: string }).version ?? '?';
    const entry = (out[pkg.name] ??= { version, files: 0, bytes: 0 });
    if (!entry.version.split(', ').includes(version)) entry.version += `, ${version}`;
    entry.files++;
    entry.bytes += statSync(file).size;
    if (/\.(m|c)?js$/.test(file)) queue(file);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function row(outDir: string, files: string[]): StaticRow {
  let raw = 0;
  let gzip = 0;
  for (const f of files) {
    const bytes = readFileSync(f);
    raw += bytes.length;
    gzip += gzipSync(bytes, { level: 9 }).length;
  }
  return { raw, gzip, files: files.map((f) => relative(outDir, f).split(sep).join('/')).sort() };
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

/** The report of the build in `outDir`. */
export function analyzeBuild(outDir: string): StaticReport {
  const rendererDir = join(outDir, 'renderer');
  const html = readFileSync(join(rendererDir, 'index.html'), 'utf8');
  const refs = (re: RegExp) => [...html.matchAll(re)].map((m) => join(rendererDir, m[1].replace(/^\.?\//, '')));
  const scripts = localClosure([...refs(/<script[^>]+src="([^"]+)"/g), ...refs(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)]);
  const styles = refs(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g);
  const eager = new Set([...scripts, ...styles]);
  const later = listFiles(join(rendererDir, 'assets')).filter((f) => /\.(js|css)$/.test(f) && !eager.has(f));
  const mainDir = join(outDir, 'main');
  const mainEntry = localClosure([join(mainDir, 'index.js')]);
  const rows: Record<string, StaticRow> = {
    'renderer.script': row(outDir, scripts),
    'renderer.style': row(outDir, styles),
    'renderer.later': row(outDir, later),
    main: row(outDir, mainEntry),
    preload: row(outDir, localClosure(readdirSync(join(outDir, 'preload')).filter((f) => /\.(m|c)?js$/.test(f)).map((f) => join(outDir, 'preload', f))))
  };
  for (const f of readdirSync(mainDir).sort()) if (f !== 'index.js' && f.endsWith('.js')) rows[`worker.${basename(f, extname(f))}`] = row(outDir, localClosure([join(mainDir, f)]));
  return { schemaVersion: 1, rows, packages: packageClosure(mainEntry) };
}

/** The report beside its baseline: one table of rows, one of the packages that differ. */
export function staticTables(base: StaticReport | null, now: StaticReport): string {
  const d = (a: number | undefined, b: number) => (a === undefined ? 'new' : b === a ? '0' : `${b > a ? '+' : '−'}${formatValue(Math.abs(b - a), 'bytes')}`);
  const rows = Object.entries(now.rows).map(([name, r]) => {
    const b = base?.rows[name];
    return [name, formatValue(r.raw, 'bytes'), b ? formatValue(b.raw, 'bytes') : '–', d(b?.raw, r.raw), formatValue(r.gzip, 'bytes'), b ? formatValue(b.gzip, 'bytes') : '–', d(b?.gzip, r.gzip)];
  });
  for (const name of Object.keys(base?.rows ?? {})) if (!now.rows[name]) rows.push([name, '–', formatValue(base!.rows[name].raw, 'bytes'), 'gone', '–', formatValue(base!.rows[name].gzip, 'bytes'), 'gone']);
  const packages = [...new Set([...Object.keys(base?.packages ?? {}), ...Object.keys(now.packages)])].sort();
  const changed = packages.flatMap((name) => {
    const a = base?.packages[name];
    const b = now.packages[name];
    if (a && b && a.bytes === b.bytes && a.version === b.version) return [];
    return [[name, b?.version ?? a!.version, b ? formatValue(b.bytes, 'bytes') : '–', a ? formatValue(a.bytes, 'bytes') : '–', !a ? 'added' : !b ? 'removed' : a.version !== b.version ? `${a.version} → ${b.version}` : d(a.bytes, b.bytes)]];
  });
  const total = (r: StaticReport | null) => Object.values(r?.packages ?? {}).reduce((n, p) => n + p.bytes, 0);
  const summary = `Main entry's static dependency closure: ${Object.keys(now.packages).length} packages, ${formatValue(total(now), 'bytes')}${base ? ` (baseline ${Object.keys(base.packages).length}, ${formatValue(total(base), 'bytes')})` : ''}`;
  return [
    table(['output', 'raw', 'baseline', 'Δ raw', 'gzip', 'baseline', 'Δ gzip'], rows),
    summary,
    changed.length ? table(['package', 'version', 'bytes', 'baseline', 'change'], changed) : base ? 'No package differs from the baseline.' : 'No baseline yet: run with --update-baseline to record one.',
    'Every package: run with --json <file>.'
  ].join('\n\n');
}

export const BASELINE = resolve(import.meta.dirname, 'baseline', 'static.json');

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { parseArgs } = await import('node:util');
  const { values } = parseArgs({ options: { app: { type: 'string', default: resolve(import.meta.dirname, '../..') }, 'update-baseline': { type: 'boolean', default: false }, json: { type: 'string' } } });
  const outDir = join(resolve(values.app), 'out');
  if (!existsSync(join(outDir, 'main', 'index.js'))) throw new Error(`There is no built app at ${outDir}: run \`npm run build\` first.`);
  const report = analyzeBuild(outDir);
  const base = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, 'utf8')) as StaticReport) : null;
  console.log(staticTables(base, report));
  if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 2) + '\n');
  if (values['update-baseline']) {
    // The baseline keeps sizes, not the hashed file names, which change with every build.
    const kept: StaticReport = { ...report, rows: Object.fromEntries(Object.entries(report.rows).map(([k, r]) => [k, { ...r, files: [] }])) };
    writeFileSync(BASELINE, JSON.stringify(kept, null, 2) + '\n');
    console.log(`\nBaseline written to ${relative(process.cwd(), BASELINE)}.`);
  }
}
