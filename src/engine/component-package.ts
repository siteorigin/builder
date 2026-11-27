/**
 * Component packages (#371): what a project component takes with it to another project, and how it lands there.
 *
 * Export gathers the component and every component it places or imports, the site styles they use (with the values
 * they have here, so a project without them can make look-alikes) and the library images they show. Import gives
 * every definition a new identity in the destination, points the theme's own styles at the destination's, makes or
 * reuses the site's own styles, and points every image at the library record its bytes became, all in one edit.
 *
 * Nothing here reads or writes files: the main process reads the images for an export, and checks and stores them
 * for an import before the edit that lands the definitions runs.
 */
import type { AssetRecord, ComponentDefinition, GraphNode, OwnerRef, ProjectState, TextStyleValue, TokenDef, TokenGroup, TokenValue } from '@shared/types';
import { COMPONENT_CATEGORIES, SCHEMA_VERSION } from '@shared/types';
import { COMPONENT_PACKAGE_FORMAT, COMPONENT_PACKAGE_VERSION, MAX_PACKAGE_DEFINITIONS, PACKAGE_IMAGE_MIMES, PackageError, type ComponentPackage, type PackageToken } from '@shared/component-package';
import { LATEST_SCHEMA_VERSION, definitionHash, migrateProject, newestDocumentVersion } from '@shared/migrations';
import { linkOf, tokenVar } from '@shared/styles';
import { slugify } from '@shared/routes';
import { newId } from '@shared/ids';
import { codeAxisProblems } from '@shared/variants';
import { CUSTOM_DIR, defFile, defKey, effectiveTokens } from '@generator/index';
import { getTheme } from '@catalogue/index';
import { codeImports, directDependencies } from './definitions';
import { childLists, fail } from './tree';
import { FORM_DESTINATIONS, readsFormServices } from '@catalogue/foundation/form';
import { clone, installComponent } from './install';
import { definitionRequiredProblems } from './required';

type OpResult = Record<string, unknown>;

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const quoted = (name: string) => `“${name}”`;

// ---------------------------------------------------------------------------
// References inside definitions
// ---------------------------------------------------------------------------

const TEXT_TOKEN = /^text\.[a-z0-9-]+$/;
/** What the generator writes after a text style's variable for each of its metrics. */
const VAR_SUFFIXES = ['', '-family', '-size', '-line-height', '-weight', '-tracking', '-transform'];
const VAR_NAME = /--so-[A-Za-z0-9-]+/g;

/** Site styles by the CSS variable the generator names them with. */
type VarIndex = ReadonlyMap<string, { id: string; group: TokenGroup }>;
const varIndex = (tokens: ReadonlyArray<{ id: string; group: TokenGroup }>): VarIndex => new Map(tokens.map((t) => [tokenVar(t.id), { id: t.id, group: t.group }]));

/**
 * The site style a CSS variable is for, and the metric suffix after its name. The generator writes a text style as
 * one variable per metric and never bare, and every other style bare, so `--so-text-title-size` is Title's size even
 * where a style "Title size" exists.
 */
function varToken(name: string, byVar: VarIndex): { id: string; suffix: string } | null {
  for (const suffix of VAR_SUFFIXES) {
    if (suffix && !name.endsWith(suffix)) continue;
    const t = byVar.get(suffix ? name.slice(0, -suffix.length) : name);
    if (t && (t.group === 'text') === !!suffix) return { id: t.id, suffix };
  }
  return null;
}

/** CSS text with each site style variable it names pointed at the style `visit` returns (unchanged when undefined). */
function mapVars(css: string, byVar: VarIndex, visit: (id: string) => string | undefined): string {
  return css.replace(VAR_NAME, (m) => {
    const hit = varToken(m, byVar);
    const to = hit ? visit(hit.id) : undefined;
    return hit && to !== undefined ? `${tokenVar(to)}${hit.suffix}` : m;
  });
}

/**
 * Visit every site style a definition names, wherever it is: `{ token }` values (styles, placement overrides, variant
 * rules, token properties and their defaults, a text style's font), a text style named as a bare string, and the CSS
 * variable of a style written into a value or a code component's source. `visit` returns the style to name instead,
 * or undefined to leave the reference as it is. The definition is changed in place.
 */
function mapTokenRefs(def: ComponentDefinition, byVar: VarIndex, visit: (id: string) => string | undefined) {
  const text = (s: string) => mapVars(s, byVar, visit);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) v[i] = walk(v[i]);
      return v;
    }
    if (!isRecord(v)) return v;
    const keys = Object.keys(v);
    // A link, or a style's colour link at part strength ({ token, alpha }), which keeps its strength.
    if (typeof v.token === 'string' && (keys.length === 1 || (keys.length === 2 && typeof v.alpha === 'number'))) {
      const to = visit(v.token);
      if (to !== undefined) v.token = to;
      return v;
    }
    for (const k of keys) {
      const x = v[k];
      if (k === 'textStyle' && typeof x === 'string' && TEXT_TOKEN.test(x.trim())) {
        const to = visit(x.trim());
        if (to !== undefined) v[k] = to;
      } else v[k] = walk(x);
    }
    return v;
  };
  walk(def);
}

/** Point every library image a definition shows (`{ assetId }` values) at another, in place. */
function mapAssetRefs(def: ComponentDefinition, visit: (assetId: string) => string) {
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!isRecord(v)) return;
    if (typeof v.assetId === 'string' && v.assetId) v.assetId = visit(v.assetId);
    Object.values(v).forEach(walk);
  };
  walk(def);
}

const SITE_LINKS = new Set(['page', 'entry', 'document', 'collection']);
const LINK_KEYS = new Set(['type', 'target', 'anchor', 'newTab', 'rel']);
// A link's rel is a list: an object whose rel is anything else is no link (a property of the author's own).
const isSiteLink = (v: unknown): boolean => isRecord(v) && SITE_LINKS.has(v.type as string) && typeof v.target === 'string' && (v.rel === undefined || Array.isArray(v.rel)) && Object.keys(v).every((k) => LINK_KEYS.has(k));

/**
 * Links to this site's own pages, collection entries and documents, which another project does not have. `drop` takes
 * each out and says how many there were: a link in rich text becomes plain text, and any other link is kept as one
 * that goes nowhere, so a list item or placement never falls back to a default link instead.
 */
function siteLinks(def: ComponentDefinition, drop: boolean): number {
  let n = 0;
  const walk = (v: unknown, inSpans: boolean) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, inSpans));
    if (!isRecord(v)) return;
    for (const [k, x] of Object.entries(v)) {
      if (!isSiteLink(x)) {
        walk(x, k === 'spans');
        continue;
      }
      n++;
      if (!drop) continue;
      if (k === 'link' && inSpans) delete v[k];
      else v[k] = { type: 'none', target: '' };
    }
  };
  walk(def, false);
  return n;
}

/** A static import's specifier, with comments allowed between the keyword and the quoted path. */
const IMPORT_SPEC = /(?<![.$\w])(from|import)((?:\s|\(|\/\*(?:[^*]|\*(?!\/))*\*\/|\/\/[^\n]*\n)*)(['"])([^'"\n]*)\3/g;

/** The project file an import specifier in the file `fromFile` names, or null for a package import. */
function resolveImport(spec: string, fromFile: string): string | null {
  const fromDir = fromFile.split('/').slice(0, -1).join('/');
  return spec.startsWith('$lib/') ? normalizePath(`src/lib/${spec.slice(5)}`) : spec.startsWith('./') || spec.startsWith('../') ? normalizePath(`${fromDir}/${spec}`) : null;
}

/** The project files a code component's source imports. */
function importedFiles(source: string, fromFile: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(IMPORT_SPEC)) {
    const at = resolveImport(m[4], fromFile);
    if (at) out.push(at);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** The CSS text a site style's value holds: the value itself, or a text style's metrics. */
const cssStrings = (v: unknown): string[] => (typeof v === 'string' ? [v] : isRecord(v) ? Object.values(v).filter((x): x is string => typeof x === 'string') : []);

/** A definition in the project, or one of its theme's that a theme component it has would install. */
function findDefinition(state: ProjectState, id: string): ComponentDefinition | undefined {
  return own(state.components, id) ?? getTheme(state.site.themeId).components.find((d) => d.id === id);
}

/**
 * The component and every component it needs, each once, the component first: the components a design places, the
 * ones a code component declares or imports, and theirs in turn.
 */
export function packageClosure(state: ProjectState, rootId: string): ComponentDefinition[] {
  const out = new Map<string, ComponentDefinition>();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    if (out.has(id)) continue;
    const def = findDefinition(state, id) ?? fail(`The component "${id}" is no longer in this project.`);
    out.set(id, def);
    if (out.size > MAX_PACKAGE_DEFINITIONS) fail(`It uses more than ${MAX_PACKAGE_DEFINITIONS} components, more than one package carries.`);
    const needs = new Set([...(def.kind === 'managed' ? directDependencies(def) : []), ...(def.dependencies ?? [])]);
    // A component a slot names by its own ID goes with it, so the slot takes something where it lands.
    for (const decl of Object.values(def.slots ?? {})) for (const named of Array.isArray(decl?.componentIds) ? decl.componentIds : []) if (Object.hasOwn(state.components, named)) needs.add(named);
    if (def.kind === 'code') {
      const files = new Set(importedFiles(def.source ?? '', defFile(def)));
      for (const other of Object.values(state.components)) if (other.id !== def.id && (codeImports(state, def, other.id) || files.has(defFile(other)))) needs.add(other.id);
    }
    for (const dep of needs) {
      if (!findDefinition(state, dep)) fail(`${quoted(def.name)} uses a component that is no longer in this project ("${dep}").`);
      queue.push(dep);
    }
  }
  return [...out.values()];
}

/** A site style's value with every link followed, a text style's font included. */
function resolvedValue(tokens: readonly TokenDef[], t: TokenDef): string | TextStyleValue {
  const follow = (start: TokenDef): TokenValue => {
    let cur: TokenDef | undefined = start;
    const seen = new Set<string>();
    while (cur) {
      const link = linkOf(cur.value, cur.group);
      if (!link) return cur.value;
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
      cur = tokens.find((x) => x.id === link);
    }
    fail(`The site style ${quoted(start.label)} follows a style that does not exist, or follows itself in a loop. Give it a value of its own first.`);
  };
  const v = follow(t);
  if (isRecord(v) && 'family' in v) {
    const text = clone(v) as unknown as TextStyleValue;
    const fam = linkOf(text.family);
    if (fam) {
      const font = tokens.find((x) => x.id === fam);
      const family = font ? follow(font) : undefined;
      if (typeof family !== 'string') fail(`The text style ${quoted(t.label)} uses a font style that no longer has a font.`);
      text.family = family;
    }
    return text;
  }
  return typeof v === 'string' ? v : String(v);
}

export interface PackagePlan {
  /** The package, without its images' bytes: `images` lists the library records to read them from. */
  pkg: ComponentPackage;
  images: AssetRecord[];
  /** What the package leaves out, for the author ("2 links to this site's pages"). */
  notes: string[];
}

/**
 * Plan the package for one project component: its definitions as they are now, the site styles they use and the
 * library images they show. Fails, saying why, when the component can't travel. The caller reads the images' bytes
 * into `pkg.images`.
 */
export function planComponentPackage(state: ProjectState, rootId: string, app?: string): PackagePlan {
  const root = own(state.components, rootId) ?? fail('That component is no longer in this project.');
  if (root.owner !== 'project') fail(`${quoted(root.name)} comes with the theme. Export your own components, or a copy of this one.`);
  const defs = packageClosure(state, rootId).map(clone);
  for (const def of defs) {
    if (def.category === 'shell') fail(`${quoted(def.name)} is part of the shared header or footer, which stays with its site.`);
    // A design's own file converted to code names the classes the design's ID makes, which take new names where the
    // package lands: its styles would not follow it.
    if (def.kind === 'code' && def.generatedFrom)
      fail(`${quoted(def.name)} is a design's file edited outside SiteOrigin Builder, which still relies on that design's styles. Convert the design to code from the Inspector, then export that.`);
    // Code converted by an early version still leans on the original design's stylesheet, which a package can't carry.
    const from = def.provenance?.forkedFrom;
    if (def.kind === 'code' && from && def.source?.includes(`so-${defKey(from)}__`))
      fail(`${quoted(def.name)} was converted to code by an earlier version and still relies on the original design's styles. Convert the design to code again, then export that.`);
  }
  // Code that writes a library file's address shows a file the other site won't have, wherever it lands.
  const files = Object.values(state.assets.assets).flatMap((a) =>
    [a?.file, ...(Array.isArray(a?.variants) ? a.variants.map((v) => v?.file) : [])].flatMap((f) => (typeof f === 'string' && f.startsWith('static/') ? [{ name: a.name, url: f.slice('static'.length) }] : []))
  );
  for (const def of defs) {
    const hit = def.kind === 'code' && files.find((f) => def.source?.includes(f.url));
    if (hit) fail(`The code of ${quoted(def.name)} shows ${quoted(hit.name)} from this site's library by its address, which a package can't carry. Give the component an image property for it instead.`);
  }
  const notes: string[] = [];
  // A required link left with nowhere to go would make a package that no site can take; a problem the definitions
  // already had is not the package's.
  const had = new Set(definitionRequiredProblems(state, defs).map((p) => p.key));
  const links = defs.reduce((n, d) => n + siteLinks(d, true), 0);
  const emptied = links ? definitionRequiredProblems(state, defs).find((p) => !had.has(p.key)) : undefined;
  if (emptied) fail(`${emptied.message} It goes to this site's own page or document, which a package can't carry. Give it a web address first, or make it optional.`);
  if (links) notes.push(`${links === 1 ? 'A link' : `${links} links`} to this site's pages or documents ${links === 1 ? 'was' : 'were'} left out, as another site doesn't have them.`);
  // Images: every one shown must be a picture still in the library.
  const images = new Map<string, AssetRecord>();
  for (const def of defs)
    mapAssetRefs(def, (id) => {
      const a = own(state.assets.assets, id);
      if (!a) fail(`${quoted(def.name)} shows an image that is no longer in the library. Choose another image for it first.`);
      if (a.kind !== 'image' || !(PACKAGE_IMAGE_MIMES as readonly string[]).includes(a.mime)) fail(`${quoted(def.name)} uses ${quoted(a.name)}, which is not a picture a package can carry.`);
      images.set(id, a);
      return id;
    });
  // Site styles: every one named, and every one those follow.
  const tokens = effectiveTokens(state);
  const byVar = varIndex(tokens);
  const wanted: Array<{ id: string; by: string }> = [];
  for (const def of defs)
    mapTokenRefs(def, byVar, (id) => {
      wanted.push({ id, by: def.name });
      return undefined;
    });
  const carried = new Map<string, PackageToken>();
  while (wanted.length) {
    const { id, by } = wanted.shift()!;
    if (carried.has(id)) continue;
    const t = tokens.find((x) => x.id === id) ?? fail(`${quoted(by)} uses the site style "${id}", which this project no longer has. Choose another style for it first.`);
    carried.set(id, {
      id,
      group: t.group,
      label: t.label,
      ...(t.description ? { description: t.description } : {}),
      custom: state.tokens.custom.some((c) => c.id === id),
      value: clone(t.value),
      resolved: resolvedValue(tokens, t)
    });
    const link = linkOf(t.value, t.group);
    if (link) wanted.push({ id: link, by: t.label });
    if (t.group === 'text' && isRecord(t.value)) {
      const fam = linkOf((t.value as Record<string, unknown>).family);
      if (fam) wanted.push({ id: fam, by: t.label });
    }
    // A value can name another style by its variable too (a shadow in the site's own colour).
    for (const css of cssStrings(t.value)) mapVars(css, byVar, (ref) => void wanted.push({ id: ref, by: t.label }));
  }
  const pkg: ComponentPackage = {
    format: COMPONENT_PACKAGE_FORMAT,
    version: COMPONENT_PACKAGE_VERSION,
    ...(app ? { app } : {}),
    exportedAt: new Date().toISOString(),
    rootId,
    definitions: defs,
    tokens: [...carried.values()],
    images: []
  };
  return { pkg, images: [...images.values()], notes };
}

// ---------------------------------------------------------------------------
// Reading a package
// ---------------------------------------------------------------------------

/**
 * A package's definitions in the current document format, migrated together (a migration of one may read another).
 * Throws a PackageError for one saved by a newer version, or one that can't be brought up to date.
 */
export function migratePackage(pkg: ComponentPackage): ComponentPackage {
  const v = LATEST_SCHEMA_VERSION;
  // Only the definitions are older documents: everything around them is current, so no migration touches it.
  const work = {
    manifest: { schemaVersion: v },
    site: { schemaVersion: v },
    pages: {},
    components: Object.fromEntries(pkg.definitions.map((d) => [d.id, clone(d)])),
    tokens: { schemaVersion: v, overrides: {}, custom: [] },
    assets: { schemaVersion: v, assets: {} },
    themeLock: { schemaVersion: v, theme: { id: '', version: '' }, components: {} },
    collections: {}
  } as unknown as ProjectState;
  if (newestDocumentVersion(work) > v) throw new PackageError('This component package can’t be imported: it was made by a newer version of SiteOrigin Builder. Update the app to import it.');
  let migrated: ProjectState;
  try {
    migrated = migrateProject(work)?.state ?? work;
  } catch (e) {
    throw new PackageError(`This component package can’t be imported: its components could not be brought up to date (${(e as Error).message}).`);
  }
  return { ...pkg, definitions: pkg.definitions.map((d) => migrated.components[d.id]) };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** One import, as the operation that lands it reads it. Only the editor's import makes one; nothing saves it. */
export interface ComponentImport {
  /** Names this import in its `component.import` operation. */
  id: string;
  /** The package, in the current document format (see migratePackage). */
  pkg: ComponentPackage;
  /** The library asset each of the package's images is now, by the package's image ID. */
  images: Record<string, string>;
  /**
   * Where the imported component is also placed, in the same change (a saved component inserted from the personal
   * library, #372): the place Insert worked out, the role it goes in as, and the ID its placement gets.
   */
  place?: ImportPlacement;
}

/** Where an import places its component (see ComponentImport.place). */
export interface ImportPlacement {
  owner: OwnerRef;
  parentId: string | null;
  slot?: string;
  index?: number;
  /** An element going straight onto a page goes in a new section of its own, as Insert puts one. */
  role: 'section' | 'element';
  /** The placement's ID. */
  nodeId: string;
}

export interface ImportHelpers {
  /** Give a site style a value, as token.set checks and stores it. */
  setToken(state: ProjectState, tokenId: string, value: unknown): void;
}

const MAX_CUSTOM_TOKENS = 200;
const TEXT_KEYS = ['family', 'size', 'lineHeight', 'weight', 'tracking', 'transform'] as const;
const SAFE_NODE_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

function pascal(name: string): string {
  const words = name.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const out = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z]/.test(out) ? out : `Component${out}`;
}

/** A path inside the project, with `.` and `..` steps worked out. */
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** The relative import from a file in `fromDir` to `to`. */
function relativeSpec(fromDir: string, to: string): string {
  const a = fromDir.split('/');
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  return `${up ? '../'.repeat(up) : './'}${b.slice(i).join('/')}`;
}

/**
 * A code component's source as it lands: its imports of the package's other components pointed at their files here
 * (`moved` maps each file as the package named it to its file here), and the class names the generator derives from a
 * definition's ID (`so-{key}__part`, `so-{key}--variant`, `so-shown--{key}`) renamed with it (`keys`, old to new), so
 * variants, part styles and shown parts keep reaching converted code. Every other import is left as it is: the save
 * checks refuse one that names a component the package didn't bring.
 */
function relinkSource(source: string, fromFile: string, toFile: string, moved: ReadonlyMap<string, string>, keys: ReadonlyMap<string, string>): string {
  const toDir = toFile.split('/').slice(0, -1).join('/');
  let out = source.replace(IMPORT_SPEC, (m, lead: string, gap: string, q: string, spec: string) => {
    const at = resolveImport(spec, fromFile);
    const target = at === null ? undefined : moved.get(at);
    if (!target) return m;
    return `${lead}${gap}${q}${spec.startsWith('$lib/') ? `$lib/${target.replace(/^src\/lib\//, '')}` : relativeSpec(toDir, target)}${q}`;
  });
  for (const [from, to] of keys) {
    const k = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\bso-${k}(__|--)`, 'g'), `so-${to}$1`).replace(new RegExp(`\\bso-shown--${k}(?![a-z0-9]|-(?!phone\\b|tablet\\b|desktop\\b))`, 'g'), `so-shown--${to}`);
  }
  return out;
}

/** JSON text with keys in order, so two values that hold the same are told apart from two that don't. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isRecord(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

const NODE_KINDS = new Set(['element', 'text', 'image', 'link', 'icon', 'divider', 'instance', 'slot', 'repeat']);
const isIdList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * The shape problems that would stop a definition from being read at all, named for the author: what the engine, the
 * checks and the editor walk must be there, in the form they walk it. What the values mean is checked as they land.
 */
function checkShape(def: ComponentDefinition, inPackage: ReadonlySet<string>) {
  const name = quoted(def.name);
  const damaged = (what: string): never => fail(`${name} is damaged: ${what}.`);
  if (def.category === 'shell') fail(`${name} is part of a shared header or footer, which can't be imported.`);
  if (!isRecord(def.parts) || !Object.values(def.parts).every((p) => isRecord(p) && typeof p.nodeId === 'string')) damaged('its parts are not in the expected form');
  if (!isRecord(def.properties)) damaged('its properties are not in the expected form');
  for (const [k, prop] of Object.entries(def.properties)) {
    const fields = (prop as { fields?: unknown }).fields;
    if ((prop.type === 'list' || prop.type === 'object') && (!isRecord(fields) || !Object.values(fields).every((f) => isRecord(f) && typeof f.type === 'string'))) damaged(`its property "${k}" has no fields`);
    for (const f of [prop, ...(isRecord(fields) ? Object.values(fields) : [])] as Array<{ type?: unknown; options?: unknown }>)
      if (f.type === 'enum' && !(Array.isArray(f.options) && f.options.every((o) => isRecord(o) && typeof o.value === 'string' && typeof o.label === 'string'))) damaged(`its property "${k}" has no options`);
  }
  for (const [axis, a] of Object.entries(def.variantAxes ?? {}))
    if (!isRecord(a) || typeof a.label !== 'string' || !isRecord(a.options) || !Object.values(a.options).every((o) => isRecord(o) && typeof o.label === 'string')) damaged(`its variant "${axis}" has no options`);
  const axisProblem = codeAxisProblems(def)[0];
  if (axisProblem) damaged(axisProblem.message.replace(/\.$/, ''));
  if (def.kind === 'code') {
    if (typeof def.source !== 'string' || !def.source.trim()) fail(`${name} is a code component without its code.`);
    if (def.tree) fail(`${name} is a code component with a design as well, which no component has.`);
    if (def.dependencies !== undefined && !isIdList(def.dependencies)) damaged('its list of components it needs is not in the expected form');
    for (const dep of def.dependencies ?? []) if (!inPackage.has(dep)) fail(`${name} needs a component the package doesn't include ("${dep}").`);
    return;
  }
  const tree = def.tree;
  if (!tree || !isRecord(tree.nodes) || !isIdList(tree.rootIds)) fail(`${name} has no design to show.`);
  if (def.source !== undefined) fail(`${name} is a design with code as well, which no component has.`);
  // Each element sits in one place: one shared or nested in itself would be generated over and over.
  const parents = new Map<string, number>(tree.rootIds.map((r) => [r, 1]));
  for (const [id, n] of Object.entries(tree.nodes)) {
    if (!SAFE_NODE_ID.test(id) || !isRecord(n) || n.id !== id || !NODE_KINDS.has(n.kind as string)) damaged(`the element "${id.slice(0, 40)}" is not one the design can hold`);
    if ((n.kind === 'element' || n.kind === 'repeat') && !isIdList(n.children)) damaged(`the element "${id}" has no list of children`);
    if (n.kind === 'slot' && n.children !== undefined && !isIdList(n.children)) damaged(`the slot "${id}" has damaged fallback content`);
    if (n.kind === 'instance') {
      if (!inPackage.has(String(n.definitionId))) fail(`${name} places a component the package doesn't include.`);
      if (n.props !== undefined && !isRecord(n.props)) damaged(`the component placed as "${id}" has no settings`);
      if (n.slots !== undefined && (!isRecord(n.slots) || !Object.values(n.slots).every(isIdList))) damaged(`the component placed as "${id}" has damaged slots`);
    }
    for (const list of childLists(n as GraphNode))
      for (const c of list.ids) {
        if (!Object.hasOwn(tree.nodes, c)) damaged(`the element "${id}" lists a missing child`);
        parents.set(c, (parents.get(c) ?? 0) + 1);
        if (parents.get(c)! > 1) damaged(`the element "${c}" is placed in more than one place`);
      }
  }
  for (const r of tree.rootIds) if (!Object.hasOwn(tree.nodes, r)) fail(`${name} has a damaged design.`);
  // Nor inside itself, even out of sight: an element that is its own ancestor is never one an edit can walk out of.
  const parentOf = new Map<string, string>();
  for (const [id, n] of Object.entries(tree.nodes)) for (const list of childLists(n as GraphNode)) for (const c of list.ids) parentOf.set(c, id);
  const clear = new Set<string>();
  for (const id of Object.keys(tree.nodes)) {
    const seen = new Set<string>();
    for (let at: string | undefined = id; at !== undefined && !clear.has(at); at = parentOf.get(at)) {
      if (seen.has(at)) damaged(`the element "${id}" is placed inside itself`);
      seen.add(at);
    }
    seen.forEach((x) => clear.add(x));
  }
}

/**
 * Whether a definition is the theme's contact form, or a copy of it, going by the code it runs rather than the name it
 * gives itself: whatever a package calls it, form code that reads the service settings sends visitors' messages.
 */
export const sendsFormMessages = (def: ComponentDefinition | undefined): boolean => !!def && def.kind === 'code' && readsFormServices({ ...def, componentId: 'contact.form' });

/** The packaged components a packaged definition renders: placed by its design, declared, or imported by its code. */
function needsOf(def: ComponentDefinition, byFile: ReadonlyMap<string, string>): string[] {
  const out = [...(def.kind === 'managed' && def.tree ? directDependencies(def) : []), ...(def.dependencies ?? [])];
  if (def.kind === 'code') for (const f of importedFiles(def.source ?? '', defFile(def))) if (byFile.has(f)) out.push(byFile.get(f)!);
  return out.filter((d) => d !== def.id);
}

/**
 * What deciding a packaged component's identity in a project needs, without the component itself: a saved component's
 * card keeps these (#372), so the library can say whether it would bring code into the project open now without
 * reading its package.
 */
export interface PackagedDefinition {
  id: string;
  owner: 'theme' | 'project';
  kind: 'managed' | 'code';
  name: string;
  /** definitionHash of it as packaged: a theme component the theme here has unchanged has the same. */
  hash: string;
  /** The packaged components it renders (see needsOf). */
  needs: string[];
}

/** The identity facts of a package's components (see PackagedDefinition). */
export function packagedDefinitions(defs: readonly ComponentDefinition[]): PackagedDefinition[] {
  const byFile = new Map(defs.map((d) => [normalizePath(defFile(d)), d.id]));
  const packaged = new Set(defs.map((d) => d.id));
  // A component a slot names by its own ID is needed too: kept as the project's while that one lands as a copy, the
  // slot would name the project's version and refuse the copy.
  const named = (d: ComponentDefinition) => Object.values(d.slots ?? {}).flatMap((decl) => (Array.isArray(decl?.componentIds) ? decl.componentIds : [])).filter((id) => id !== d.id && packaged.has(id));
  // A component its design places and its declared dependencies name too is one need, listed once.
  return defs.map((d) => ({ id: d.id, owner: d.owner, kind: d.kind, name: d.name, hash: definitionHash(d), needs: [...new Set([...needsOf(d, byFile), ...named(d)])] }));
}

/**
 * The packaged theme components the project's theme has exactly as packaged (installed here or to install), and
 * whose every component they render is one of those too: one rendering a component that would land as a copy of its
 * own must land as a copy as well, or it would show this theme's version instead of the one it was packaged with.
 */
function reusedFromTheme(state: ProjectState, defs: readonly PackagedDefinition[]): Set<string> {
  const theme = getTheme(state.site.themeId);
  const reused = new Set(
    defs
      .filter((def) => {
        if (def.owner !== 'theme') return false;
        const local = own(state.components, def.id) ?? theme.components.find((c) => c.id === def.id);
        return local?.owner === 'theme' && definitionHash(local) === def.hash;
      })
      .map((d) => d.id)
  );
  for (let changed = true; changed; ) {
    changed = false;
    for (const def of defs) if (reused.has(def.id) && def.needs.some((d) => !reused.has(d))) changed = reused.delete(def.id);
  }
  return reused;
}

/** The packaged code components that would land in the project as its own: code the project does not already have. */
export function codeBrought(state: ProjectState, defs: readonly PackagedDefinition[]): PackagedDefinition[] {
  const reused = reusedFromTheme(state, defs);
  return defs.filter((d) => d.kind === 'code' && !reused.has(d.id));
}

/** The code components an import would add to the project as its own: code the project does not already have. */
export function importedCode(state: ProjectState, input: ComponentImport): ComponentDefinition[] {
  const brought = new Set(codeBrought(state, packagedDefinitions(input.pkg.definitions)).map((d) => d.id));
  return input.pkg.definitions.filter((d) => brought.has(d.id));
}

/** A package style's value and stand-in in the form its kind takes: text for most kinds, metrics for a text style. */
function tokenShapeOk(t: PackageToken): boolean {
  const literal = (v: unknown) => (t.group === 'text' ? isRecord(v) && 'family' in v && TEXT_KEYS.every((k) => v[k] === undefined || typeof v[k] === 'string' || typeof v[k] === 'number' || (k === 'family' && isRecord(v[k]))) : typeof v === 'string');
  // A text style may still follow another as a whole, as older sites stored it; it lands with the metrics it resolves to.
  const link = (v: unknown) => isRecord(v) && Object.keys(v).length === 1 && typeof v.token === 'string';
  return t.id.startsWith(`${t.group}.`) && (literal(t.value) || link(t.value)) && literal(t.resolved);
}

/**
 * Land a package's components in the project: each gets an identity of its own here (importing a package twice makes
 * two independent copies), except a theme component the project's theme has exactly as packaged, which is installed
 * from the theme. Styles the theme here also has are used as they are here; the site's own styles are reused when this
 * project has the same one, and made otherwise (under a new name when the name is taken by a different style); a theme
 * style this project's theme lacks becomes a style of the site's own with the value it had. Every image points at the
 * library record the main process stored its bytes as, which must still be in the library. Returns the imported
 * component's new ID and every packaged definition's ID here.
 */
export function importComponentPackage(state: ProjectState, input: ComponentImport, helpers: ImportHelpers): OpResult {
  const { pkg } = input;
  const defs = pkg.definitions.map(clone);
  const inPackage = new Set(defs.map((d) => d.id));
  for (const def of defs) checkShape(def, inPackage);
  // Identities: a theme component the theme here has unchanged is the theme's; every other one is a new component.
  const reused = reusedFromTheme(state, packagedDefinitions(defs));
  const ids = new Map<string, string>();
  const keys = new Map<string, string>();
  const moved = new Map<string, string>();
  const fileOf = new Map<string, string>();
  const takenIds = new Set(Object.keys(state.components));
  const takenFiles = new Set(Object.values(state.components).map((d) => defFile(d).toLowerCase()));
  const packagedFiles = new Set<string>();
  const imported: ComponentDefinition[] = [];
  for (const def of defs) {
    // Two components naming one file would land as one: the package can't say which an import of it means.
    const was = normalizePath(defFile(def));
    if (packagedFiles.has(was)) fail(`The package has two components saved as the same file ("${was.split('/').pop()}"), so it can't be imported.`);
    packagedFiles.add(was);
    if (reused.has(def.id)) {
      ids.set(def.id, def.id);
      // Kept where it is, but an importer that moves imports it from its own new place.
      moved.set(was, was);
      continue;
    }
    let id: string;
    let file: string;
    do {
      id = `${def.kind === 'code' ? 'code' : 'proj'}.${slugify(def.name) || 'component'}-${newId('x', 5).slice(2)}`;
      file = def.kind === 'code' ? `${CUSTOM_DIR}/${pascal(def.name)}-${id.slice(-5).replace(/[^A-Za-z0-9]/g, '')}.svelte` : defFile({ ...def, id, sourcePath: undefined });
    } while (takenIds.has(id) || takenFiles.has(file.toLowerCase()));
    takenIds.add(id);
    takenFiles.add(file.toLowerCase());
    ids.set(def.id, id);
    keys.set(defKey(def.id), defKey(id));
    moved.set(was, file);
    fileOf.set(def.id, file);
    imported.push(def);
  }
  const installs = defs.filter((d) => reused.has(d.id) && !Object.hasOwn(state.components, d.id));
  // Images: each is the library record the main process stored it as, still here as the picture packaged.
  for (const img of pkg.images) {
    const asset = own(input.images, img.id);
    const rec = asset ? own(state.assets.assets, asset) : undefined;
    if (!rec || rec.kind !== 'image' || rec.hash !== img.hash) fail(`The image ${quoted(img.name)} is no longer in this project's library as it was packaged. Import the component again.`);
  }
  // Site styles, decided as they are first needed, so a style only another (already here) would have followed is not made.
  const tokens = new Map(pkg.tokens.map((t) => [t.id, t]));
  const here = new Map(effectiveTokens(state).map((t) => [t.id, t]));
  const reserved = new Set([...here.keys(), ...pkg.tokens.filter((t) => t.custom && !here.has(t.id)).map((t) => t.id)]);
  const tokenIds = new Map<string, string>();
  const created: string[] = [];
  const visiting = new Set<string>();
  const byVar = varIndex(pkg.tokens);
  // A name taken here, or kept for one of the package's own styles that is free here, is never given to another.
  const freeId = (base: string) => {
    let id = base;
    for (let i = 2; reserved.has(id); i++) id = `${base}-${i}`;
    reserved.add(id);
    return id;
  };
  const same = (existing: TokenDef | undefined, group: TokenGroup, value: unknown) => !!existing && existing.group === group && canonical(existing.value) === canonical(value);
  const make = (t: PackageToken, id: string, value: unknown) => {
    if (state.tokens.custom.length >= MAX_CUSTOM_TOKENS) fail(`Importing it would give the site more than ${MAX_CUSTOM_TOKENS} styles of its own. Remove some in Site styles first.`);
    const v = t.group === 'text' && isRecord(value) ? Object.fromEntries(TEXT_KEYS.filter((k) => value[k] !== undefined).map((k) => [k, value[k]])) : value;
    const def: TokenDef = { id, label: t.label, group: t.group, value: v as TokenValue, ...(t.description ? { description: t.description } : {}) };
    state.tokens.custom.push(def);
    helpers.setToken(state, id, v);
    here.set(id, state.tokens.custom.find((c) => c.id === id)!);
    created.push(id);
  };
  /** A value with its links to other styles, and the style variables in its CSS, pointed at what they became here. */
  const relinked = (value: unknown, group: TokenGroup, by: string): unknown => {
    const v = clone(value);
    const link = linkOf(v, group);
    if (link) return { token: tokenFor(link, by) };
    const vars = (css: string) => mapVars(css, byVar, (ref) => tokenFor(ref, by));
    if (typeof v === 'string') return vars(v);
    if (isRecord(v)) {
      for (const [k, x] of Object.entries(v)) if (typeof x === 'string') v[k] = vars(x);
      if (isRecord(v.family) && typeof v.family.token === 'string') v.family = { token: tokenFor(v.family.token, by) };
    }
    return v;
  };
  const tokenFor = (id: string, by: string): string => {
    const known = tokenIds.get(id);
    if (known) return known;
    const t = tokens.get(id);
    if (!t) {
      // A style the package doesn't describe can only be one this project has too.
      if (here.has(id)) return id;
      fail(`${quoted(by)} uses the site style "${id}", which neither the package nor this project has.`);
    }
    if (!tokenShapeOk(t!)) fail(`The site style ${quoted(t!.label)} in the package is damaged.`);
    if (visiting.has(id)) fail(`The site style ${quoted(t!.label)} follows itself in a loop.`);
    visiting.add(id);
    const existing = here.get(id);
    let to: string;
    if (!t!.custom) {
      // The theme's own style: this site's version of it, or a look-alike of the site's own when its theme lacks it
      // (the same look-alike an earlier import made, under whichever name it took, when it still looks the same).
      if (existing && existing.group === t!.group) to = id;
      else {
        const base = `${t!.group}.custom-${slugify(t!.label) || 'style'}`;
        const value = relinked(t!.resolved, t!.group, t!.label);
        let match: string | undefined;
        for (let i = 1, at = base; here.has(at); at = `${base}-${++i}`) if (same(here.get(at), t!.group, value)) match = at;
        if (match) to = match;
        else {
          to = freeId(base);
          make(t!, to, value);
        }
      }
    } else {
      const value = relinked(t!.group === 'text' && linkOf(t!.value) ? t!.resolved : t!.value, t!.group, t!.label);
      if (same(existing, t!.group, value)) to = id;
      else {
        // Free here: it keeps its name, which was kept for it. Taken by a different style: the next free name.
        to = existing ? freeId(id) : id;
        make(t!, to, value);
      }
    }
    visiting.delete(id);
    tokenIds.set(id, to);
    return to;
  };
  // Each definition as it lands: its identity, the components it uses, its styles and its images.
  const landed: ComponentDefinition[] = [];
  for (const def of imported) {
    const id = ids.get(def.id)!;
    if (siteLinks(def, false)) fail(`${quoted(def.name)} links to pages or documents of the site it came from, which this project doesn't have.`);
    mapTokenRefs(def, byVar, (ref) => tokenFor(ref, def.name));
    mapAssetRefs(def, (asset) => own(input.images, asset) ?? fail(`${quoted(def.name)} shows an image the package doesn't include.`));
    for (const n of Object.values(def.tree?.nodes ?? {})) if (n.kind === 'instance') n.definitionId = ids.get(n.definitionId)!;
    // A slot naming a component the package brings names it by the ID it lands under; contract IDs stay as they are.
    for (const decl of Object.values(def.slots ?? {})) if (Array.isArray(decl.componentIds)) decl.componentIds = [...new Set(decl.componentIds.map((c) => ids.get(c) ?? c))];
    if (def.kind === 'code') {
      const file = fileOf.get(def.id)!;
      def.source = relinkSource(def.source ?? '', defFile(def), file, moved, keys);
      def.sourcePath = file;
      if (def.dependencies?.length) def.dependencies = [...new Set(def.dependencies.map((d) => ids.get(d)!))].sort();
      // The design a converted file was made by lands beside it under its new ID; one the package lacks names nothing.
      const design = typeof def.generatedFrom === 'string' ? ids.get(def.generatedFrom) : undefined;
      if (design) def.generatedFrom = design;
      else delete def.generatedFrom;
    } else {
      delete def.sourcePath;
      delete def.generatedFrom;
    }
    // Where it was copied from is another project's history: it names nothing here.
    const prov = def.provenance ?? {};
    def.provenance = {
      ...(prov.pack ? { pack: prov.pack } : {}),
      ...(prov.packVersion ? { packVersion: prov.packVersion } : {}),
      ...(prov.componentId ? { componentId: prov.componentId } : {}),
      createdBy: prov.createdBy === 'ai' ? 'ai' : 'user'
    };
    def.id = id;
    def.owner = 'project';
    def.schemaVersion = SCHEMA_VERSION;
    if (!(COMPONENT_CATEGORIES as readonly string[]).includes(def.category)) def.category = 'custom';
    landed.push(def);
  }
  // A form a package brings never sends visitors' messages to the package author's account. Every setting that decides
  // where (the form's own, and any property of a component around it that passes one on, however deep) is emptied, so
  // whoever imports it sets the service up here.
  const all = [...landed, ...defs.filter((d) => reused.has(d.id))];
  const destinations = new Map<string, Set<string>>();
  for (const d of all) if (sendsFormMessages(d)) destinations.set(d.id, new Set(FORM_DESTINATIONS));
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of all)
      for (const n of Object.values(d.tree?.nodes ?? {})) {
        if (n.kind !== 'instance') continue;
        for (const k of destinations.get(n.definitionId) ?? []) {
          const v = n.props?.[k];
          if (isRecord(v) && v.field !== undefined) fail(`${quoted(d.name)} passes a contact form's destination on from part of a property, which a package can't bring.`);
          if (!isRecord(v) || typeof v.$prop !== 'string' || !Object.hasOwn(d.properties, v.$prop)) continue;
          const mine = destinations.get(d.id) ?? new Set<string>();
          if (mine.has(v.$prop)) continue;
          destinations.set(d.id, mine.add(v.$prop));
          changed = true;
        }
      }
  }
  // Code decides in its source what it passes on: a package's code never places a form, or what passes one on.
  const guarded = new Set([...destinations.keys()].map((id) => defFile(all.find((d) => d.id === id)!)));
  for (const def of landed) if (def.kind === 'code' && !sendsFormMessages(def) && importedFiles(def.source ?? '', defFile(def)).some((f) => guarded.has(f))) fail(`The code of ${quoted(def.name)} places a contact form, which a package can't bring in code. Place the form in a design instead.`);
  for (const def of landed) {
    for (const k of destinations.get(def.id) ?? []) if (Object.hasOwn(def.properties, k) && 'default' in def.properties[k]) (def.properties[k] as { default: unknown }).default = '';
    for (const n of Object.values(def.tree?.nodes ?? {})) {
      if (n.kind !== 'instance') continue;
      for (const k of destinations.get(n.definitionId) ?? []) {
        const v = n.props?.[k];
        if (n.props && Object.hasOwn(n.props, k) && !(isRecord(v) && typeof v.$prop === 'string')) delete n.props[k];
      }
    }
  }
  for (const def of installs) {
    const installed = installComponent(state, def.componentId);
    if (installed !== def.id) fail(`${quoted(def.name)} could not be installed from the theme.`);
  }
  for (const def of landed) state.components[def.id] = def;
  return { definitionId: ids.get(pkg.rootId), definitionIds: pkg.definitions.map((d) => ids.get(d.id)), tokenIds: created, guarded: [...destinations.keys()] };
}
