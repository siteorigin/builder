/**
 * Loading theme packs from disk: the releases shipped in the app's resources and those a person put in
 * `userData/packs`. Each folder holds one release (`pack.json` and the files it lists). A pack is only data, so
 * loading one reads and checks files and never runs anything in it. A pack that fails any check is refused
 * whole, with a reason a person can act on, and the rest still load.
 */
import { promises as fs, type Stats } from 'node:fs';
import { join, relative, sep, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { ComponentDefinition, GraphNode } from '@shared/types';
import { SCHEMA_VERSION, isBinding } from '@shared/types';
import { PACK_FILE_RE, PACK_FORMAT, PACK_ID_RE, PACK_MANIFEST, PACK_VERSION_RE, type PackManifest, type ThemePack } from '@catalogue/pack';
import { FONT_FAMILY_RE } from '@shared/fonts';
import { sha } from '../project/fsutil';
import { checkSvelteSource } from '../codecheck';
import type { PackFileSource } from './files';
import type { PackRefusal } from '@shared/api';

export interface PackRoot {
  dir: string;
  source: 'bundled' | 'user';
}

export type { PackRefusal };

export interface LoadedPack {
  pack: ThemePack;
  files: Map<string, PackFileSource>;
}

export const LIMITS = {
  manifestBytes: 8 * 1024 * 1024,
  files: 1024,
  fontBytes: 4 * 1024 * 1024,
  previewBytes: 512 * 1024,
  packBytes: 64 * 1024 * 1024
};

/** Licences that allow the components and fonts to be copied into, and published with, a person's website. */
const COMPONENT_LICENSES = new Set(['GPL-3.0-or-later', 'GPL-3.0-only', 'GPL-2.0-or-later', 'LGPL-3.0-or-later', 'MPL-2.0', 'Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'CC0-1.0', 'Unlicense']);
const FONT_LICENSES = new Set(['OFL-1.1', 'Apache-2.0', 'MIT', 'CC0-1.0', 'Unlicense', 'UFL-1.0']);

class Refused extends Error {}
const refuse = (reason: string): never => {
  throw new Refused(reason);
};

const ID = z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/).max(80);
const text = (max: number) => z.string().max(max);
const file = z.string().regex(PACK_FILE_RE);

const fontFace = z.strictObject({
  file,
  weight: z.string().regex(/^([1-9]\d{0,2}|1000)( ([1-9]\d{0,2}|1000))?$/),
  style: z.enum(['normal', 'italic']),
  unicodeRange: z.string().regex(/^U\+[0-9A-Fa-f?]{1,6}(-[0-9A-Fa-f]{1,6})?(,\s*U\+[0-9A-Fa-f?]{1,6}(-[0-9A-Fa-f]{1,6})?)*$/).max(4000).optional(),
  format: z.enum(['woff2', 'woff2-variations'])
});

const font = z.strictObject({
  family: z.string().regex(FONT_FAMILY_RE),
  name: text(60).min(1),
  category: z.enum(['sans-serif', 'serif', 'monospace', 'display', 'handwriting']),
  stack: text(300).regex(/^[^;{}<>\\]*$/),
  license: z.string(),
  notice: text(64 * 1024).min(1),
  faces: z.array(fontFace).min(1).max(64)
});

const tokenValue = z.union([z.string().max(500), z.object({ token: z.string() }), z.record(z.string(), z.unknown())]);

/** The parts of a definition the loader relies on; the rest is checked by what reads it (the engine and generator). */
const component = z
  .object({
    schemaVersion: z.number(),
    id: z.string(),
    componentId: ID,
    contractVersion: z.number().int().positive(),
    kind: z.enum(['managed', 'code']),
    owner: z.literal('theme'),
    name: text(80).min(1),
    description: text(1000),
    category: z.string().max(40),
    tags: z.array(text(60)).max(40),
    icon: text(60).optional(),
    properties: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,59}$/), z.object({ type: z.string(), label: z.string() }).loose()),
    parts: z.record(ID, z.object({ nodeId: z.string(), label: z.string() }).loose()),
    slots: z.record(z.string(), z.object({ label: z.string() })).optional(),
    variantAxes: z.record(z.string(), z.object({ label: z.string(), default: z.string(), options: z.record(z.string(), z.object({ label: z.string() }).loose()) }).loose()).optional(),
    tree: z.object({ rootIds: z.array(z.string()).min(1), nodes: z.record(z.string(), z.object({ id: z.string(), kind: z.string() }).loose()) }).optional(),
    source: z.string().max(256 * 1024).optional(),
    provenance: z.object({ pack: z.string(), packVersion: z.string(), componentId: z.string() }).loose(),
    license: z.string(),
    examples: z.array(z.unknown()).optional()
  })
  .loose();

const previews = z.strictObject({ default: file, variants: z.record(z.string(), z.record(z.string(), file)).optional() });

const manifestSchema = z.strictObject({
  format: z.literal(PACK_FORMAT),
  schemaVersion: z.number().int(),
  id: z.string().regex(PACK_ID_RE),
  name: text(80).min(1),
  version: z.string().regex(PACK_VERSION_RE),
  license: z.string(),
  description: text(400),
  tokens: z.array(z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/), label: text(80), group: z.enum(['color', 'font', 'text', 'space', 'container', 'radius', 'shadow', 'border']), value: tokenValue, description: text(400).optional() })).max(400),
  contrastPairs: z.array(z.object({}).loose()).max(200).optional(),
  baseCss: text(512 * 1024),
  fonts: z.array(font).max(32),
  components: z.array(component).min(1).max(400),
  aiProfile: z.object({ guidance: z.array(text(600)).max(40), examples: z.array(z.object({ id: z.string(), componentId: z.string(), keywords: z.array(z.string()), description: z.string(), props: z.record(z.string(), z.unknown()) }).loose()).max(200).optional() }).loose(),
  devOnly: z.boolean().optional(),
  previews: z.record(ID, previews).optional(),
  files: z.record(file, z.strictObject({ size: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
});

/** CSS a pack writes into every site unchanged: no other stylesheets, no remote or local resources, no markup. */
function checkCss(css: string, where: string) {
  if (/@import/i.test(css)) refuse(`${where} imports another stylesheet (@import), which packs may not do.`);
  if (/url\s*\(|image-set\s*\(|expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(css)) refuse(`${where} loads a resource (url() or similar), which packs may not do.`);
  if (/<\/?\s*(style|script)/i.test(css)) refuse(`${where} contains markup.`);
}

/** Every reference inside a managed definition's tree points at something the definition has. */
function checkTree(def: ComponentDefinition) {
  const where = `Component ${def.componentId}`;
  const nodes = def.tree!.nodes;
  for (const [id, n] of Object.entries(nodes)) {
    if (n.id !== id) refuse(`${where}: node "${id}" is stored under another ID.`);
    for (const child of (n as GraphNode & { children?: string[] }).children ?? []) if (!nodes[child]) refuse(`${where}: node "${id}" lists a child "${child}" that does not exist.`);
    for (const v of Object.values(n)) if (isBinding(v) && '$prop' in v && !(v.$prop in def.properties)) refuse(`${where}: node "${id}" uses the property "${v.$prop}", which the component does not have.`);
  }
  for (const id of def.tree!.rootIds) if (!nodes[id]) refuse(`${where}: its root "${id}" does not exist.`);
  for (const [pid, part] of Object.entries(def.parts)) if (!nodes[part.nodeId]) refuse(`${where}: part "${pid}" refers to an element that does not exist.`);
}

async function checkComponents(m: PackManifest, source: PackRoot['source']) {
  const ids = new Set<string>();
  for (const def of m.components) {
    const where = `Component ${def.componentId}`;
    if (def.schemaVersion !== SCHEMA_VERSION) refuse(`${where} is written for document schema ${def.schemaVersion}; this app reads ${SCHEMA_VERSION}.`);
    if (def.id !== `${m.id}.${def.componentId}`) refuse(`${where} has the ID "${def.id}"; a component of the ${m.id} pack must be "${m.id}.${def.componentId}".`);
    if (ids.has(def.componentId!)) refuse(`${where} is listed twice.`);
    ids.add(def.componentId!);
    if (def.provenance?.pack !== m.id || def.provenance?.packVersion !== m.version || def.provenance?.componentId !== def.componentId) refuse(`${where} says it comes from another pack or version.`);
    if (!COMPONENT_LICENSES.has(def.license ?? '')) refuse(`${where} has the licence "${def.license}", which does not allow it to be published in websites.`);
    if ('sourcePath' in def) refuse(`${where} names a source file; a pack's code is stored in the pack itself.`);
    if (def.kind === 'managed') {
      if (!def.tree) refuse(`${where} has no elements.`);
      checkTree(def);
    } else {
      if (typeof def.source !== 'string' || !def.source.trim()) refuse(`${where} is a code component without code.`);
      // A pack the person installed is held to the policy for code a person writes in a project.
      if (source === 'user') {
        const errors = (await checkSvelteSource(def.source!, { filename: `src/lib/siteorigin/components/${def.componentId}.svelte`, resolve: () => null })).filter((p) => p.severity === 'error');
        if (errors.length) refuse(`${where} has code that is not allowed: ${errors[0].message}`);
      }
    }
  }
}

/** Is this a WOFF2 font or a WebP image, by its first bytes? */
const isWoff2 = (b: Buffer) => b.subarray(0, 4).toString('latin1') === 'wOF2';
const isWebp = (b: Buffer) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';

/** A path that is a real folder or file, never a link to somewhere else. */
async function plain(abs: string, kind: 'dir' | 'file'): Promise<Stats> {
  const st = await fs.lstat(abs).catch(() => refuse(`${abs} is missing.`));
  if (st.isSymbolicLink()) refuse(`${abs} is a link, which packs may not contain.`);
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) refuse(`${abs} is not a ${kind === 'dir' ? 'folder' : 'file'}.`);
  return st;
}

/** Read and check one pack folder. Throws a refusal on the first problem. */
export async function loadPackDir(dir: string, root: PackRoot): Promise<LoadedPack> {
  await plain(dir, 'dir');
  const manifestPath = join(dir, PACK_MANIFEST);
  const st = await plain(manifestPath, 'file');
  if (st.size > LIMITS.manifestBytes) refuse(`${PACK_MANIFEST} is larger than ${LIMITS.manifestBytes / 1024 / 1024} MB.`);
  const raw = await fs.readFile(manifestPath);
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    refuse(`${PACK_MANIFEST} is not valid JSON: ${(e as Error).message}`);
  }
  if (json && typeof json === 'object' && 'format' in json && (json as { format: unknown }).format !== PACK_FORMAT) refuse(`The pack is in release format ${String((json as { format: unknown }).format)}; this app reads format ${PACK_FORMAT}.`);
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    refuse(`${PACK_MANIFEST} is malformed at ${issue.path.join('.') || 'the top level'}: ${issue.message}`);
  }
  // The checked shape is the manifest as written: its definitions are kept as stored, byte for byte.
  const m = json as PackManifest;
  if (m.schemaVersion !== SCHEMA_VERSION) refuse(`The pack is written for document schema ${m.schemaVersion}; this app reads ${SCHEMA_VERSION}.`);
  const folder = dir.split(sep).pop();
  if (folder !== m.id) refuse(`The folder is named "${folder}" but holds the pack "${m.id}". Name the folder after the pack.`);
  if (!COMPONENT_LICENSES.has(m.license)) refuse(`The pack's licence "${m.license}" does not allow its components to be published in websites.`);
  checkCss(m.baseCss, 'Its base CSS');
  await checkComponents(m, root.source);
  if (m.devOnly && root.source === 'user') refuse('Development fixtures cannot be installed.');

  // Every file the pack uses is listed, and every listed file is used.
  const used = new Set<string>();
  for (const f of m.fonts) {
    if (!FONT_LICENSES.has(f.license)) refuse(`The font ${f.name} has the licence "${f.license}", which does not allow it to be published in websites.`);
    for (const face of f.faces) {
      if (!face.file.startsWith('fonts/')) refuse(`The font ${f.name} names ${face.file}, which is not in the fonts folder.`);
      used.add(face.file);
    }
  }
  const componentIds = new Set(m.components.map((c) => c.componentId));
  for (const [componentId, p] of Object.entries(m.previews ?? {})) {
    if (!componentIds.has(componentId)) refuse(`There is a preview for ${componentId}, which the pack does not have.`);
    for (const f of [p.default, ...Object.values(p.variants ?? {}).flatMap((o) => Object.values(o))]) {
      if (!f.startsWith('previews/')) refuse(`The preview of ${componentId} names ${f}, which is not in the previews folder.`);
      used.add(f);
    }
  }
  const listed = Object.keys(m.files);
  if (listed.length > LIMITS.files) refuse(`The pack lists ${listed.length} files; at most ${LIMITS.files} are allowed.`);
  for (const f of used) if (!m.files[f]) refuse(`${f} is used but not listed in the pack's files.`);
  for (const f of listed) if (!used.has(f)) refuse(`${f} is listed but nothing in the pack uses it.`);
  const lower = new Set<string>();
  for (const f of listed) {
    if (lower.has(f.toLowerCase())) refuse(`Two files differ only in letter case (${f}).`);
    lower.add(f.toLowerCase());
  }

  // Each file is the one listed: same size and hash, a real file inside the pack, of the expected type.
  const files = new Map<string, PackFileSource>();
  let total = raw.length;
  for (const [rel, want] of Object.entries(m.files)) {
    const limit = rel.startsWith('fonts/') ? LIMITS.fontBytes : LIMITS.previewBytes;
    if (want.size > limit) refuse(`${rel} is larger than ${limit / 1024} KB.`);
    total += want.size;
    if (total > LIMITS.packBytes) refuse(`The pack is larger than ${LIMITS.packBytes / 1024 / 1024} MB.`);
    const [sub] = rel.split('/');
    await plain(join(dir, sub), 'dir');
    const abs = join(dir, ...rel.split('/'));
    const inside = relative(dir, abs);
    if (inside.startsWith('..') || isAbsolute(inside)) refuse(`${rel} is outside the pack.`);
    const fst = await plain(abs, 'file');
    if (fst.size !== want.size) refuse(`${rel} is ${fst.size} bytes, but the pack lists ${want.size}. The pack is damaged or was changed after it was built.`);
    const bytes = await fs.readFile(abs);
    if (sha(bytes) !== want.sha256) refuse(`${rel} does not match the hash the pack lists. The pack is damaged or was changed after it was built.`);
    if (rel.endsWith('.woff2') && !isWoff2(bytes)) refuse(`${rel} is not a WOFF2 font.`);
    if (rel.endsWith('.webp') && !isWebp(bytes)) refuse(`${rel} is not a WebP image.`);
    files.set(rel, { abs, size: want.size, sha256: want.sha256 });
  }
  const { format: _f, schemaVersion: _s, files: _files, ...data } = m;
  void _f;
  void _s;
  void _files;
  return { pack: { ...data, digest: sha(raw), source: root.source }, files };
}

/**
 * Load every pack under these folders, in order. IDs are unique: a pack the person installed cannot replace one
 * shipped with the app, and when two installed packs claim one ID, neither loads.
 */
export async function loadPacks(roots: PackRoot[]): Promise<{ packs: LoadedPack[]; refused: PackRefusal[] }> {
  const found: Array<{ dir: string; root: PackRoot; loaded?: LoadedPack; refusal?: string }> = [];
  for (const root of roots) {
    const names = await fs.readdir(root.dir).catch(() => [] as string[]);
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      const dir = join(root.dir, name);
      try {
        found.push({ dir, root, loaded: await loadPackDir(dir, root) });
      } catch (e) {
        found.push({ dir, root, refusal: e instanceof Refused ? e.message : `It could not be read: ${(e as Error).message}` });
      }
    }
  }
  const refused: PackRefusal[] = [];
  const packs: LoadedPack[] = [];
  const bundled = new Set(found.filter((f) => f.loaded && f.root.source === 'bundled').map((f) => f.loaded!.pack.id));
  const userCount = new Map<string, number>();
  for (const f of found) if (f.loaded && f.root.source === 'user') userCount.set(f.loaded.pack.id, (userCount.get(f.loaded.pack.id) ?? 0) + 1);
  for (const f of found) {
    if (f.refusal) {
      refused.push({ dir: f.dir, reason: f.refusal });
      continue;
    }
    const id = f.loaded!.pack.id;
    if (f.root.source === 'user' && bundled.has(id)) refused.push({ dir: f.dir, packId: id, reason: `A theme with the ID "${id}" ships with SiteOrigin Builder, so an installed pack cannot replace it.` });
    else if (f.root.source === 'user' && userCount.get(id)! > 1) refused.push({ dir: f.dir, packId: id, reason: `More than one installed pack has the ID "${id}". Remove all but one.` });
    else if (f.root.source === 'bundled' && packs.some((p) => p.pack.id === id)) refused.push({ dir: f.dir, packId: id, reason: `Another bundled pack already has the ID "${id}".` });
    else packs.push(f.loaded!);
  }
  return { packs, refused };
}
