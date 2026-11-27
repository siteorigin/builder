/**
 * Building a pack: an authored pack (TypeScript) becomes the data and files of a release. The fonts' faces are
 * read from the stylesheets the pack names; the files themselves are copied as they are. Used by
 * `npm run build:packs` (through siteorigin/builder-components, which authors the themes) and by tests that author a
 * pack of their own.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { SCHEMA_VERSION } from '@shared/types';
import { PACK_FILE_RE, PACK_FORMAT, PACK_MANIFEST, type AuthoredPack, type ComponentPreviews, type PackFont, type PackFontFace, type PackFontSource, type PackManifest, type ThemePack } from '@catalogue/pack';
import { sha } from '../project/fsutil';
import { themeTokenVars, unknownTokenProblems } from '../codecheck';
import type { PackFileSource } from './files';

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

/**
 * A font's faces and files, from the stylesheets the pack author named: its main one, then the stylesheet of its italic
 * faces when the family has one, which may declare only italic faces. A font with an italic sheet must end up with an
 * italic face in the chosen subsets, so it never silently ships upright only.
 */
export function buildFont(font: PackFontSource, root: string): { font: PackFont; files: Map<string, string> } {
  const faces: PackFontFace[] = [];
  const files = new Map<string, string>();
  const sheets = [{ css: font.css, italic: false }, ...(font.italicCss ? [{ css: font.italicCss, italic: true }] : [])];
  for (const { css, italic } of sheets) {
    const cssFile = moduleFile(root, css);
    for (const f of parseFontFaces(readFileSync(cssFile, 'utf8'))) {
      if (f.family !== font.family) throw new Error(`${css} declares "${f.family}", not "${font.family}".`);
      if (f.format !== 'woff2' && f.format !== 'woff2-variations') throw new Error(`${css}: only woff2 fonts can be bundled, not ${f.format}.`);
      if (f.style !== 'normal' && f.style !== 'italic') throw new Error(`${css}: unsupported font-style ${f.style}.`);
      if (italic && f.style !== 'italic') throw new Error(`${css} declares a font-style: ${f.style} face, but it is the font's italic stylesheet.`);
      const file = `fonts/${basename(f.url)}`;
      if (font.subsets && !font.subsets.some((s) => basename(f.url).includes(`-${s}-wght-`))) continue;
      if (!PACK_FILE_RE.test(file)) throw new Error(`${css}: ${f.url} is not a usable font file name.`);
      const src = join(dirname(cssFile), f.url);
      if (files.has(file) && files.get(file) !== src) throw new Error(`${css}: ${font.name} has two different files named ${basename(f.url)}.`);
      files.set(file, src);
      faces.push({ file, weight: f.weight, style: f.style, ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}), format: f.format });
    }
  }
  const inSubsets = font.subsets ? ` in the subsets ${font.subsets.join(', ')}` : '';
  if (!faces.length) throw new Error(`${font.css} declares no fonts${inSubsets}.`);
  if (font.italicCss && !faces.some((f) => f.style === 'italic')) throw new Error(`${font.italicCss} declares no italic fonts${inSubsets}.`);
  const { css: _css, italicCss: _italicCss, noticeFile, subsets: _subsets, ...rest } = font;
  void _css;
  void _italicCss;
  void _subsets;
  return { font: { ...rest, notice: readFileSync(moduleFile(root, noticeFile), 'utf8'), faces }, files };
}

/** An authored pack as the app uses it, with the source of each file it ships. */
export function buildPack(authored: AuthoredPack, root = process.cwd(), previews?: Record<string, ComponentPreviews>): { pack: ThemePack; files: Map<string, string> } {
  const files = new Map<string, string>();
  const owners = new Map<string, string>();
  const fonts = authored.fonts.map((f) => {
    const built = buildFont(f, root);
    for (const [k, v] of built.files) {
      const other = owners.get(k);
      if (other && files.get(k) !== v) throw new Error(`${f.name} and ${other} both ship a different ${k}.`);
      owners.set(k, f.name);
      files.set(k, v);
    }
    return built.font;
  });
  const pack: ThemePack = { ...authored, fonts, ...(previews ? { previews } : {}), source: 'bundled' };
  return { pack, files };
}

/**
 * The `var(--so-…)` names a pack's code components use that its own tokens and base stylesheet do not define, as
 * messages naming the component. A bundled theme must have none (`npm run build:packs` fails on one).
 */
export function packTokenProblems(pack: Pick<ThemePack, 'tokens' | 'baseCss' | 'components'>): string[] {
  const tokens = themeTokenVars(pack.tokens, pack.baseCss);
  const out: string[] = [];
  for (const c of pack.components) {
    if (c.kind !== 'code' || c.source === undefined) continue;
    for (const p of unknownTokenProblems(c.source, tokens, 'error')) out.push(`${c.name} (${c.id}) line ${p.line}: ${p.message}`);
  }
  return out;
}

/** The inventory entry of a file on disk. */
export function fileSource(abs: string): PackFileSource {
  const bytes = readFileSync(abs);
  return { abs, size: bytes.length, sha256: sha(bytes) };
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
