/**
 * Building a pack: an authored pack (TypeScript) becomes the data and files of a release. The fonts' faces are
 * read from the stylesheets the pack names; the files themselves are copied as they are. Used by
 * `npm run build:packs` and, without previews, by tests and scripts that need the packs in memory.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { SCHEMA_VERSION } from '@shared/types';
import { registerPacks } from '@catalogue/index';
import { BUILTIN_PACKS } from '@catalogue/builtin';
import { PACK_FILE_RE, PACK_FORMAT, PACK_MANIFEST, type AuthoredPack, type ComponentPreviews, type PackFont, type PackFontFace, type PackFontSource, type PackManifest, type ThemePack } from '@catalogue/pack';
import { sha } from '../project/fsutil';
import { registerPackFiles, type PackFileSource } from './files';

/** One @font-face rule of a font stylesheet, as written. */
interface CssFace {
  family: string;
  style: string;
  weight: string;
  url: string;
  format: string;
  unicodeRange?: string;
}

const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, '');

/** The @font-face rules of a stylesheet such as a Fontsource package's index.css. */
export function parseFontFaces(css: string): CssFace[] {
  const out: CssFace[] = [];
  for (const [, body] of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const decl = (name: string) => body.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`))?.[1]?.trim();
    const src = decl('src')?.match(/url\(\s*(['"]?)([^'")]+)\1\s*\)\s*format\(\s*['"]([^'"]+)['"]\s*\)/);
    const family = decl('font-family');
    if (!src || !family) throw new Error(`A @font-face rule has no family or no url() with a format(): ${body.trim().slice(0, 120)}`);
    out.push({ family: unquote(family), style: decl('font-style') ?? 'normal', weight: decl('font-weight') ?? '400', url: src[2], format: src[3], unicodeRange: decl('unicode-range') });
  }
  return out;
}

/** A file named by module path (`@fontsource-variable/inter/index.css`), from the packages installed under `root`. */
function moduleFile(root: string, spec: string): string {
  const file = join(root, 'node_modules', ...spec.split('/'));
  if (!existsSync(file)) throw new Error(`${spec} is not installed. Run npm install.`);
  return file;
}

/** A font's faces and files, from the stylesheet the pack author named. */
export function buildFont(font: PackFontSource, root: string): { font: PackFont; files: Map<string, string> } {
  const cssFile = moduleFile(root, font.css);
  const faces: PackFontFace[] = [];
  const files = new Map<string, string>();
  for (const f of parseFontFaces(readFileSync(cssFile, 'utf8'))) {
    if (f.family !== font.family) throw new Error(`${font.css} declares "${f.family}", not "${font.family}".`);
    if (f.format !== 'woff2' && f.format !== 'woff2-variations') throw new Error(`${font.css}: only woff2 fonts can be bundled, not ${f.format}.`);
    if (f.style !== 'normal' && f.style !== 'italic') throw new Error(`${font.css}: unsupported font-style ${f.style}.`);
    const file = `fonts/${basename(f.url)}`;
    if (font.subsets && !font.subsets.some((s) => basename(f.url).startsWith(`${font.css.split('/')[1]}-${s}-`))) continue;
    if (!PACK_FILE_RE.test(file)) throw new Error(`${font.css}: ${f.url} is not a usable font file name.`);
    files.set(file, join(dirname(cssFile), f.url));
    faces.push({ file, weight: f.weight, style: f.style, ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}), format: f.format });
  }
  if (!faces.length) throw new Error(`${font.css} declares no fonts.`);
  const { css: _css, noticeFile, subsets: _subsets, ...rest } = font;
  void _css;
  void _subsets;
  return { font: { ...rest, notice: readFileSync(moduleFile(root, noticeFile), 'utf8'), faces }, files };
}

/** An authored pack as the app uses it, with the source of each file it ships. */
export function buildPack(authored: AuthoredPack, root = process.cwd(), previews?: Record<string, ComponentPreviews>): { pack: ThemePack; files: Map<string, string> } {
  const files = new Map<string, string>();
  const fonts = authored.fonts.map((f) => {
    const built = buildFont(f, root);
    for (const [k, v] of built.files) files.set(k, v);
    return built.font;
  });
  const pack: ThemePack = { ...authored, fonts, ...(previews ? { previews } : {}), source: 'bundled' };
  return { pack, files };
}

/** The inventory entry of a file on disk. */
export function fileSource(abs: string): PackFileSource {
  const bytes = readFileSync(abs);
  return { abs, size: bytes.length, sha256: sha(bytes) };
}

/**
 * Register the packs authored in this repository straight from their sources, as tests and scripts use them
 * (the app itself loads their built releases).
 */
export function registerBuiltinPacks(root = process.cwd()): ThemePack[] {
  const built = BUILTIN_PACKS.map((a) => buildPack(a, root));
  registerPacks(built.map((b) => b.pack));
  for (const { pack, files } of built) registerPackFiles(pack.id, new Map([...files].map(([k, abs]) => [k, fileSource(abs)])));
  return built.map((b) => b.pack);
}

/** The manifest of a release, serialized; its SHA-256 is the release's digest. */
export function manifestJson(pack: ThemePack, inventory: PackManifest['files']): string {
  const { digest: _d, source: _s, ...data } = pack;
  void _d;
  void _s;
  const sorted = Object.fromEntries(Object.entries(inventory).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const manifest: PackManifest = { format: PACK_FORMAT, schemaVersion: SCHEMA_VERSION, ...data, files: sorted };
  return JSON.stringify(manifest, null, '\t') + '\n';
}

/**
 * Write a release folder: the manifest and every file it lists, copied from `files` (path → source file) or
 * written from `bytes`. Anything left over from an earlier build is removed first. Returns the digest.
 */
export function writeRelease(outDir: string, pack: ThemePack, files: Map<string, string>, bytes: Map<string, Buffer> = new Map()): string {
  rmSync(outDir, { recursive: true, force: true });
  const inventory: PackManifest['files'] = {};
  const put = (rel: string, data: Buffer) => {
    if (!PACK_FILE_RE.test(rel)) throw new Error(`${rel} is not a valid pack file path.`);
    mkdirSync(dirname(join(outDir, rel)), { recursive: true });
    writeFileSync(join(outDir, rel), data);
    inventory[rel] = { size: data.length, sha256: sha(data) };
  };
  for (const [rel, abs] of files) put(rel, readFileSync(abs));
  for (const [rel, data] of bytes) put(rel, data);
  const json = manifestJson(pack, inventory);
  writeFileSync(join(outDir, PACK_MANIFEST), json);
  return sha(json);
}
