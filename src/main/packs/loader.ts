/**
 * Loading theme packs from disk: the releases shipped in the app's resources and those a person put in
 * `userData/packs`. Each folder holds one release (`pack.json` and the files it lists). A pack is only data, so
 * loading one reads and checks files and never runs anything in it. A pack that fails any check is refused
 * whole, with a reason a person can act on, and the rest still load.
 */
import { promises as fs, type Stats } from 'node:fs';
import { join, relative, sep, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { ComponentDefinition, GraphNode, ProjectState } from '@shared/types';
import { COMPONENT_CATEGORIES, SCHEMA_VERSION, SLOT_PRIMITIVES, conditionRef, isBinding, slotChildren } from '@shared/types';
import { slotDecl, slotFill } from '@engine/slots';
import { BUNDLED_PACK_IDS, PACK_FILE_RE, PACK_FORMAT, PACK_ID_RE, PACK_MANIFEST, PACK_VERSION_RE, type PackManifest, type ThemePack } from '@catalogue/pack';
import { FONT_FAMILY_RE } from '@shared/fonts';
import { variantIdsValid } from '@shared/variants';
import { propBindingSchema } from '@shared/bindings';
import { boundSchema } from '@engine/schema';
import { defKey, slotIdent } from '@generator/index';
import { sha } from '../project/fsutil';
import { readRegularFile, type PackFileSource } from './files';
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

const tokenRef = z.strictObject({ token: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/) });
const cssText = z.string().max(500).regex(/^[^;{}<>\\]*$/);
const tokenValue = z.union([
  cssText,
  tokenRef,
  z.strictObject({ family: z.union([cssText, tokenRef]), size: cssText, lineHeight: cssText, weight: z.union([cssText, z.number()]), tracking: cssText, transform: cssText.optional() })
]);
const contrastPair = z.strictObject({
  id: z.string().max(80),
  use: text(200),
  fg: z.string().max(80),
  bg: z.union([z.string().max(80), z.strictObject({ mix: z.tuple([z.string().max(80), z.number(), z.string().max(80)]) })]),
  state: z.enum(['rest', 'hover']),
  varyingGround: z.boolean().optional(),
  group: z.string().max(80),
  fixable: z.boolean().optional(),
  min: z.number().positive().max(21).optional()
});

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
    parts: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,59}$/), z.object({ nodeId: z.string(), label: z.string() }).loose()),
    slots: z
      .record(
        z.string(),
        z.strictObject({
          label: z.string(),
          description: text(300).optional(),
          categories: z.array(z.enum(COMPONENT_CATEGORIES as unknown as [string, ...string[]])).max(20).optional(),
          primitives: z.array(z.enum(SLOT_PRIMITIVES as unknown as [string, ...string[]])).max(6).optional(),
          max: z.number().int().min(0).max(1000).optional()
        })
      )
      .optional(),
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
  contrastPairs: z.array(contrastPair).max(200).optional(),
  baseCss: text(512 * 1024),
  fonts: z.array(font).max(32),
  components: z.array(component).min(1).max(400),
  aiProfile: z.object({ guidance: z.array(text(600)).max(40), examples: z.array(z.object({ id: z.string(), componentId: z.string(), keywords: z.array(z.string()), description: z.string(), props: z.record(z.string(), z.unknown()) }).loose()).max(200).optional() }).loose(),
  devOnly: z.boolean().optional(),
  previews: z.record(ID, previews).optional(),
  files: z.record(file, z.strictObject({ size: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
});

/**
 * CSS a pack writes into every site unchanged: no other stylesheets, no remote or local resources, no markup. An
 * image written inline (`url("data:image/…")`, a small icon, say) loads nothing, so it is allowed.
 */
function checkCss(css: string, where: string) {
  if (/<\/?\s*(style|script)/i.test(css)) refuse(`${where} contains markup.`);
  // Read as a browser would. Strings and comments are found together, left to right: "/*" inside a string starts no
  // comment, and text inside either (even the word url()) loads nothing. An escaped letter ("\\75 rl(") is the letter.
  // An inline image is found the same way, as one url() holding one plain string, so it can never start inside a
  // string or comment, or reach past its own closing bracket; one written any other way is still refused.
  const plain = css
    .replace(
      /(url\(\s*(?:"data:image\/[^"\\\n\r\f]*"|'data:image\/[^'\\\n\r\f]*')\s*\))|(\\[\s\S])|("(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?)|\/\*[\s\S]*?(?:\*\/|$)/g,
      (_, inline: string | undefined, esc: string | undefined, str: string | undefined) => (inline ? ' ' : (esc ?? (str ? '""' : ' ')))
    )
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/g, (_, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd))
    .replace(/\\(.)/gs, '$1');
  if (/@import/i.test(plain)) refuse(`${where} imports another stylesheet (@import), which packs may not do.`);
  if (/url\s*\(|image-set\s*\(|expression\s*\(|javascript:|(?<![\w-])behavior\s*:|-moz-binding/i.test(plain)) refuse(`${where} loads a resource (url() or similar), which packs may not do.`);
}

/** Every reference inside a managed definition's tree points at something the definition has. */
/** Node, part and slot IDs become class names and attributes in generated source, so only plain ones are allowed. */
const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

function checkTree(def: ComponentDefinition) {
  const where = `Component ${def.componentId}`;
  const nodes = def.tree!.nodes;
  for (const [id, n] of Object.entries(nodes)) {
    if (!SAFE_ID.test(id)) refuse(`${where}: the element ID "${id.slice(0, 40)}" may only use letters, digits, "-" and "_".`);
    if (n.id !== id) refuse(`${where}: node "${id}" is stored under another ID.`);
    const slot = (n as { slot?: unknown }).slot;
    if (slot !== undefined && (typeof slot !== 'string' || !SAFE_ID.test(slot))) refuse(`${where}: node "${id}" has an unusable slot name.`);
    for (const child of (n as GraphNode & { children?: string[] }).children ?? []) if (!nodes[child]) refuse(`${where}: node "${id}" lists a child "${child}" that does not exist.`);
    // Bindings sit in a node's own fields, in its conditions, and in the properties it gives a nested component.
    const inst = (n as GraphNode).kind === 'instance' ? (n as GraphNode & { props?: Record<string, unknown>; variants?: Record<string, unknown>; slots?: Record<string, unknown> }) : undefined;
    const values = [...Object.values(n), conditionRef((n as GraphNode).when), conditionRef((n as GraphNode).unless), ...Object.values(inst?.props ?? {}), ...Object.values(inst?.variants ?? {})];
    for (const v of values) {
      if (isBinding(v) && '$prop' in v && !(v.$prop in def.properties)) refuse(`${where}: node "${id}" uses the property "${v.$prop}", which the component does not have.`);
      if (isBinding(v) && '$prop' in v && v.field !== undefined && !propBindingSchema(def.properties, v)) refuse(`${where}: node "${id}" uses the field "${String(v.field).slice(0, 40)}" of "${v.$prop}", which is not a field of that property.`);
      if (isBinding(v) && '$item' in v && !boundSchema(def, id, v)) refuse(`${where}: node "${id}" uses the item field "${String(v.$item).slice(0, 40)}", which the list it repeats over does not have.`);
    }
    // A slot's content is elements of the same design.
    if (inst) for (const ids of Object.values(inst.slots ?? {})) for (const c of Array.isArray(ids) ? ids : []) if (!nodes[c]) refuse(`${where}: node "${id}" puts "${String(c).slice(0, 40)}" in a slot, which does not exist.`);
  }
  for (const id of def.tree!.rootIds) if (!nodes[id]) refuse(`${where}: its root "${id}" does not exist.`);
  // Every element is reached once from the roots: no element inside itself, and none in two places.
  const seen = new Set<string>();
  const walk = (id: string, path: Set<string>) => {
    if (path.has(id)) refuse(`${where}: element "${id}" contains itself.`);
    if (seen.has(id)) refuse(`${where}: element "${id}" is placed twice.`);
    seen.add(id);
    const inner = new Set(path).add(id);
    for (const child of (nodes[id] as GraphNode & { children?: string[] }).children ?? []) walk(child, inner);
  };
  for (const id of def.tree!.rootIds) walk(id, new Set());
  for (const [pid, part] of Object.entries(def.parts)) if (!nodes[part.nodeId]) refuse(`${where}: part "${pid}" refers to an element that does not exist.`);
}

async function checkComponents(m: PackManifest, source: PackRoot['source'], reviewed: ReadonlySet<string>) {
  const ids = new Set<string>();
  const files = new Map<string, string>();
  for (const def of m.components) {
    const where = `Component ${def.componentId}`;
    if (def.schemaVersion !== SCHEMA_VERSION) refuse(`${where} is written for document schema ${def.schemaVersion}; this app reads ${SCHEMA_VERSION}.`);
    if (def.id !== `${m.id}.${def.componentId}`) refuse(`${where} has the ID "${def.id}"; a component of the ${m.id} pack must be "${m.id}.${def.componentId}".`);
    if (ids.has(def.componentId!)) refuse(`${where} is listed twice.`);
    ids.add(def.componentId!);
    // Two IDs that generate the same file name ("hero.split", "hero-split") would overwrite each other.
    const key = defKey(def.id);
    if (files.has(key)) refuse(`${where} would generate the same files as ${files.get(key)}.`);
    files.set(key, def.componentId!);
    if (!variantIdsValid(def)) refuse(`${where} has a variant or option ID that is not allowed (letters and digits, starting with a letter).`);
    for (const [name, p] of Object.entries(def.properties)) {
      const prop = p as { type: string; fields?: unknown; default?: unknown; options?: unknown; tokenGroup?: unknown };
      if (prop.type === 'list' && (!prop.fields || typeof prop.fields !== 'object' || !Array.isArray(prop.default))) refuse(`${where}: the list property "${name}" has no fields or no default items.`);
      const isRecord = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
      // A token names its group and starts on a token; every field of a list or object is a typed value with a default.
      const tokenOk = (t: { tokenGroup?: unknown; default?: unknown }) => typeof t.tokenGroup === 'string' && isRecord(t.default) && typeof (t.default as { token?: unknown }).token === 'string';
      if (prop.type === 'object' && (!isRecord(prop.fields) || !Object.keys(prop.fields as object).length || !isRecord(prop.default))) refuse(`${where}: the object property "${name}" has no fields or no default.`);
      if (prop.type === 'token' && !tokenOk(prop)) refuse(`${where}: the token property "${name}" has no token group or no default token.`);
      if ((prop.type === 'object' || prop.type === 'list') && isRecord(prop.fields))
        for (const [f, field] of Object.entries(prop.fields as Record<string, unknown>)) {
          const r = field as { type?: unknown; default?: unknown; tokenGroup?: unknown };
          if (!isRecord(field) || typeof r.type !== 'string' || r.default === undefined || (r.type === 'token' && !tokenOk(r))) refuse(`${where}: the field "${f}" of "${name}" has no type or no default.`);
          if (r.type === 'enum' && !Array.isArray((field as { options?: unknown }).options)) refuse(`${where}: the choice field "${f}" of "${name}" has no options.`);
        }
      if (prop.type === 'enum' && !Array.isArray(prop.options)) refuse(`${where}: the choice property "${name}" has no options.`);
    }
    const idents = new Map<string, string>();
    for (const slot of Object.keys(def.slots ?? {})) {
      if (!SAFE_ID.test(slot)) refuse(`${where}: the slot name "${slot.slice(0, 40)}" is not allowed.`);
      // Each slot becomes a generated identifier; two that become the same one would not compile.
      const ident = slotIdent(slot);
      if (idents.has(ident)) refuse(`${where}: the slots "${idents.get(ident)}" and "${slot}" would generate the same name.`);
      idents.set(ident, slot);
    }
    if (def.provenance?.pack !== m.id || def.provenance?.packVersion !== m.version || def.provenance?.componentId !== def.componentId) refuse(`${where} says it comes from another pack or version.`);
    if (!COMPONENT_LICENSES.has(def.license ?? '')) refuse(`${where} has the licence "${def.license}", which does not allow it to be published in websites.`);
    if ('sourcePath' in def) refuse(`${where} names a source file; a pack's code is stored in the pack itself.`);
    if (def.kind === 'managed') {
      if (!def.tree) refuse(`${where} has no elements.`);
      checkTree(def);
    } else {
      if (typeof def.source !== 'string' || !def.source.trim()) refuse(`${where} is a code component without code.`);
      // Code runs in the preview's Node process, which no policy check can sandbox. An installed pack may reuse code
      // the app itself ships, exactly as it ships it, and otherwise brings data only: its components are managed.
      if (source === 'user' && !reviewed.has(def.source!)) refuse(`${where} has code of its own, which an installed pack may not bring. Make it a managed component, or reuse a code component SiteOrigin Builder ships, unchanged.`);
    }
  }
  // A component that places another of the pack's components keeps to the slot contracts of the one it places.
  const pack = { components: Object.fromEntries(m.components.map((c) => [c.id, c])) } as unknown as ProjectState;
  for (const def of m.components) {
    if (def.kind !== 'managed' || !def.tree) continue;
    for (const [id, n] of Object.entries(def.tree.nodes)) {
      if (n.kind !== 'instance') continue;
      for (const slot of Object.keys(n.slots ?? {})) {
        const decl = slotDecl(pack, n, slot);
        const target = pack.components[n.definitionId];
        // Content for a slot the placed component lacks, or not written as a list, would never show.
        if ((target && !decl) || !Array.isArray(n.slots![slot])) refuse(`Component ${def.componentId}: node "${id}" puts content in "${slot}", which its component does not have as a slot.`);
        if (!decl) continue;
        const fill = slotFill(pack, def.tree, slotChildren(n, slot), decl, def);
        if (fill.refused || (decl.max !== undefined && fill.count > decl.max)) refuse(`Component ${def.componentId}: node "${id}" puts content in the "${slot}" slot that its component does not take.`);
      }
    }
  }
}

/** Is this a WOFF2 font or a WebP image, by its first bytes? */
/** Is this a whole WOFF2 font or WebP image: its signature, and the length its header gives as the file's own? */
const isWoff2 = (b: Buffer) => b.length >= 48 && b.subarray(0, 4).toString('latin1') === 'wOF2' && b.readUInt32BE(8) === b.length;
const isWebp = (b: Buffer) => b.length >= 20 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' && b.readUInt32LE(4) + 8 === b.length;

/** A path that is a real folder or file, never a link to somewhere else. */
async function plain(abs: string, kind: 'dir' | 'file'): Promise<Stats> {
  const st = await fs.lstat(abs).catch(() => refuse(`${abs} is missing.`));
  if (st.isSymbolicLink()) refuse(`${abs} is a link, which packs may not contain.`);
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) refuse(`${abs} is not a ${kind === 'dir' ? 'folder' : 'file'}.`);
  return st;
}

/**
 * Read and check one pack folder. `reviewed` holds the code the app's own packs ship, which an installed pack may
 * reuse as it is. Throws a refusal on the first problem.
 */
export async function loadPackDir(dir: string, root: PackRoot, reviewed: ReadonlySet<string> = new Set()): Promise<LoadedPack> {
  await plain(dir, 'dir');
  const manifestPath = join(dir, PACK_MANIFEST);
  const st = await plain(manifestPath, 'file');
  if (st.size > LIMITS.manifestBytes) refuse(`${PACK_MANIFEST} is larger than ${LIMITS.manifestBytes / 1024 / 1024} MB.`);
  const raw = await readRegularFile(manifestPath, LIMITS.manifestBytes).catch((e: Error) => refuse(`${PACK_MANIFEST} could not be read: ${e.message}`));
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
  await checkComponents(m, root.source, reviewed);
  if (m.devOnly && root.source === 'user') refuse('Development fixtures cannot be installed.');

  // Every file the pack uses is listed, and every listed file is used.
  const used = new Set<string>();
  for (const f of m.fonts) {
    if (!FONT_LICENSES.has(f.license)) refuse(`The font ${f.name} has the licence "${f.license}", which does not allow it to be published in websites.`);
    for (const face of f.faces) {
      if (!face.file.startsWith('fonts/') || !face.file.endsWith('.woff2')) refuse(`The font ${f.name} names ${face.file}, which is not a .woff2 file in the fonts folder.`);
      used.add(face.file);
    }
  }
  const componentIds = new Set(m.components.map((c) => c.componentId));
  for (const [componentId, p] of Object.entries(m.previews ?? {})) {
    if (!componentIds.has(componentId)) refuse(`There is a preview for ${componentId}, which the pack does not have.`);
    for (const f of [p.default, ...Object.values(p.variants ?? {}).flatMap((o) => Object.values(o))]) {
      if (!f.startsWith('previews/') || !f.endsWith('.webp')) refuse(`The preview of ${componentId} names ${f}, which is not a .webp image in the previews folder.`);
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
    const bytes = await readRegularFile(abs, want.size).catch((e: Error) => refuse(`${rel} could not be read: ${e.message}`));
    if (bytes.length !== want.size) refuse(`${rel} is ${bytes.length} bytes, but the pack lists ${want.size}. The pack is damaged or was changed after it was built.`);
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
  // The app's own packs load first: their code is what an installed pack may reuse unchanged.
  const reviewed = new Set<string>();
  for (const root of [...roots.filter((r) => r.source === 'bundled'), ...roots.filter((r) => r.source !== 'bundled')]) {
    const names = await fs.readdir(root.dir).catch(() => [] as string[]);
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      const dir = join(root.dir, name);
      try {
        const loaded = await loadPackDir(dir, root, reviewed);
        if (root.source === 'bundled') for (const c of loaded.pack.components) if (c.kind === 'code' && c.source) reviewed.add(c.source);
        found.push({ dir, root, loaded });
      } catch (e) {
        found.push({ dir, root, refusal: e instanceof Refused ? e.message : `It could not be read: ${(e as Error).message}` });
      }
    }
  }
  const refused: PackRefusal[] = [];
  const packs: LoadedPack[] = [];
  // A bundled pack's folder is named for it, so its ID stays the app's even when that release fails to load.
  const bundled = new Set([...BUNDLED_PACK_IDS, ...found.filter((f) => f.root.source === 'bundled').map((f) => f.loaded?.pack.id ?? f.dir.split(sep).pop()!)]);
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
