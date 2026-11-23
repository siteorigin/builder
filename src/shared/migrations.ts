/**
 * Ordered, pure migrations of the canonical project documents.
 *
 * To change the document format, APPEND one entry to `MIGRATIONS`. Its position decides its version (entry 0
 * upgrades format 1 to 2, entry 1 upgrades 2 to 3, ...), and `SCHEMA_VERSION` follows from the length, so a new
 * entry is the whole version bump. Once released an entry is never edited, reordered or removed.
 *
 * Each migration:
 * - only rearranges the documents it is given: no clock, randomness, I/O, or imports of the catalogue, generator
 *   or engine, whose current behaviour would silently change what an old migration does;
 * - changes only documents `due` says are at its source version. A project can hold documents of different
 *   versions (one file restored from backup): each document then passes through exactly the steps it has not had,
 *   while the documents around it, which a step may read, can already be newer.
 *
 * The pipeline advances each document's `schemaVersion` after every step and keeps the theme lock truthful, so a
 * migration deals with neither.
 */
import type { ComponentDefinition, ProjectState } from './types';
import { stableHash } from './ids';

export interface Migration {
  /** Stable name, recorded in test expectations and notes. */
  id: string;
  description: string;
  /** Update the draft in place, changing only the documents that are `due`. */
  migrate(project: ProjectState, due: (doc: { schemaVersion: number }) => boolean): void;
}

// ---------------------------------------------------------------------------
// structured-rich-text. Self-contained on purpose: it reads the old format as the old renderer did, whatever the
// current rich text code later becomes.
// ---------------------------------------------------------------------------

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface V3Span {
  text: string;
  strong?: boolean;
  em?: boolean;
}
const V2_LIST: Record<string, string> = { check: 'check', bullet: 'ul' };

/** One old paragraph's marks, by the old renderer's own pattern, with spaces moved outside them. */
function v3Spans(paragraph: string): V3Span[] {
  const raw: V3Span[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  for (let m = re.exec(paragraph); m; m = re.exec(paragraph)) {
    if (m.index > last) raw.push({ text: paragraph.slice(last, m.index) });
    raw.push(m[0].startsWith('**') ? { text: m[0].slice(2, -2), strong: true } : { text: m[0].slice(1, -1), em: true });
    last = m.index + m[0].length;
  }
  if (last < paragraph.length) raw.push({ text: paragraph.slice(last) });
  const parts: V3Span[] = [];
  for (const r of raw) {
    const text = r.text.replace(/[\s\u00a0]+/g, ' ');
    const core = text.trim();
    if (!r.strong && !r.em) parts.push({ text });
    else if (!core) parts.push({ text: ' ' });
    else {
      if (text.startsWith(' ')) parts.push({ text: ' ' });
      parts.push({ ...r, text: core });
      if (text.endsWith(' ')) parts.push({ text: ' ' });
    }
  }
  const out: V3Span[] = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    if (prev && !!prev.strong === !!part.strong && !!prev.em === !!part.em) prev.text += part.text;
    else out.push({ ...part });
  }
  out.forEach((x, i) => {
    x.text = x.text.replace(/ {2,}/g, ' ');
    if (i > 0 && out[i - 1].text.endsWith(' ')) x.text = x.text.replace(/^ /, '');
  });
  if (out.length) out[0].text = out[0].text.replace(/^ /, '');
  if (out.length) out[out.length - 1].text = out[out.length - 1].text.replace(/ $/, '');
  return out.filter((x) => x.text);
}

/** An old rich text value as blocks. A value already in blocks (a document restored at a newer version) stays. */
function v3Blocks(value: unknown, list?: string): unknown {
  if (Array.isArray(value) && value.length && value.every((b) => b && typeof b === 'object' && typeof b.type === 'string')) return value;
  const paragraphs = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(/\n{2,}/) : [];
  const lines = paragraphs.map(v3Spans).filter((spans) => spans.length);
  if (list) return lines.length ? [{ type: list, items: lines }] : [];
  return lines.map((spans) => ({ type: 'p', spans }));
}

const v3IsBinding = (v: unknown) => !!v && typeof v === 'object' && ('$prop' in v || '$item' in v);

/** How each rich property of a definition is listed, from the old `list` on the node showing it, or its schema. */
function v3ListKinds(def: Loose): Map<string, string> {
  const kinds = new Map<string, string>();
  for (const [name, schema] of Object.entries<Loose>(def.properties ?? {})) {
    if (schema?.plainAs) kinds.set(name, schema.plainAs);
    if (schema?.type === 'list') for (const [f, field] of Object.entries<Loose>(schema.fields ?? {})) if (field?.plainAs) kinds.set(`${name}.${f}`, field.plainAs);
  }
  const nodes: Record<string, Loose> = def.tree?.nodes ?? {};
  const parents = new Map<string, string>();
  for (const n of Object.values(nodes)) for (const c of (Array.isArray(n.children) ? n.children : []) as string[]) parents.set(c, n.id);
  for (const n of Object.values(nodes)) {
    const kind = n.kind === 'text' && n.rich ? V2_LIST[n.list] : undefined;
    if (!kind || !v3IsBinding(n.text)) continue;
    const bound = n.text as { $prop?: string; $item?: string };
    if (bound.$prop !== undefined) kinds.set(bound.$prop, kind);
    else {
      const seen = new Set<string>();
      let at = parents.get(n.id);
      while (at && !seen.has(at) && nodes[at]?.kind !== 'repeat') {
        seen.add(at);
        at = parents.get(at);
      }
      const listProp = at ? nodes[at]?.list?.$prop : undefined;
      if (listProp) kinds.set(`${listProp}.${bound.$item}`, kind);
    }
  }
  return kinds;
}

function structureRichText(project: ProjectState, due: (doc: { schemaVersion: number }) => boolean) {
  const components = project.components as Record<string, Loose>;
  // Read from every definition first: a document that is not due can still describe the values of one that is.
  const kinds = new Map(Object.values(components).map((d) => [d.id as string, v3ListKinds(d)]));
  const items = (list: unknown, schema: Loose, name: string, of: Map<string, string> | undefined) => {
    if (!Array.isArray(list)) return list;
    return list.map((it: Loose) => {
      if (!it || typeof it !== 'object') return it;
      const out = { ...it };
      for (const [f, field] of Object.entries<Loose>(schema.fields ?? {})) {
        if (field?.type === 'richtext' && Object.hasOwn(out, f) && !v3IsBinding(out[f])) out[f] = v3Blocks(out[f], of?.get(`${name}.${f}`));
      }
      return out;
    });
  };
  const convertTree = (tree: Loose | undefined) => {
    for (const n of Object.values<Loose>(tree?.nodes ?? {})) {
      if (n.kind === 'text' && n.rich) {
        if (!v3IsBinding(n.text)) n.text = v3Blocks(n.text, V2_LIST[n.list]);
        delete n.list;
      } else if (n.kind === 'instance') {
        const def = components[n.definitionId];
        const of = kinds.get(n.definitionId);
        for (const [name, schema] of Object.entries<Loose>(def?.properties ?? {})) {
          if (!n.props || !Object.hasOwn(n.props, name) || v3IsBinding(n.props[name])) continue;
          if (schema?.type === 'richtext') n.props[name] = v3Blocks(n.props[name], of?.get(name));
          else if (schema?.type === 'list') n.props[name] = items(n.props[name], schema, name, of);
        }
      }
    }
  };
  for (const def of Object.values(components)) {
    if (!due(def as ComponentDefinition)) continue;
    const of = kinds.get(def.id);
    for (const [name, schema] of Object.entries<Loose>(def.properties ?? {})) {
      if (schema?.type === 'richtext') {
        schema.default = v3Blocks(schema.default, of?.get(name));
        if (of?.has(name)) schema.plainAs = of.get(name);
      } else if (schema?.type === 'list') {
        for (const [f, field] of Object.entries<Loose>(schema.fields ?? {})) {
          if (field?.type !== 'richtext') continue;
          field.default = v3Blocks(field.default, of?.get(`${name}.${f}`));
          if (of?.has(`${name}.${f}`)) field.plainAs = of.get(`${name}.${f}`);
        }
        schema.default = items(schema.default, schema, name, of);
      }
    }
    convertTree(def.tree);
  }
  for (const page of Object.values(project.pages)) if (due(page)) convertTree(page);
  if (due(project.site)) {
    convertTree(project.site.shell?.header);
    convertTree(project.site.shell?.footer);
  }
}

export const MIGRATIONS: Migration[] = [
  {
    id: 'document-baseline',
    description: 'Give every document the containers later versions rely on.',
    migrate(project, due) {
      if (due(project.tokens)) {
        project.tokens.overrides ??= {};
        project.tokens.custom ??= [];
      }
      if (due(project.assets)) project.assets.assets ??= {};
      if (due(project.themeLock)) project.themeLock.components ??= {};
      for (const page of Object.values(project.pages)) {
        if (!due(page)) continue;
        page.seo ??= {};
        page.shell ??= 'default';
      }
    }
  },
  {
    id: 'structured-rich-text',
    description: 'Store rich text as blocks of spans instead of strings with ** and * marks.',
    migrate: structureRichText
  }
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length + 1;

/** The identity of a definition's content, as recorded in the theme lock. */
export function definitionHash(def: ComponentDefinition): string {
  return stableHash(JSON.stringify(def));
}

/** Every document of a project, which each carry their own `schemaVersion`. */
function documents(project: ProjectState): Array<{ schemaVersion: number }> {
  return [project.manifest, project.site, project.tokens, project.assets, project.themeLock, ...Object.values(project.pages), ...Object.values(project.components)];
}

/** A missing or malformed version counts as the first format: migrations leave current documents unchanged. */
const versionOf = (doc: { schemaVersion?: unknown } | null): number => (Number.isInteger(doc?.schemaVersion) && (doc!.schemaVersion as number) > 0 ? (doc!.schemaVersion as number) : 1);

/** The newest format any document was written in. Above LATEST_SCHEMA_VERSION, this app cannot edit the project. */
export function newestDocumentVersion(project: ProjectState): number {
  return Math.max(...documents(project).map(versionOf));
}

export interface MigrationResult {
  /** The project in the current format. The input is not modified. */
  state: ProjectState;
  from: number;
  to: number;
  /** IDs of the migrations that ran, in order. */
  applied: string[];
}

/** Bring a project to the current format. Returns null when it already is, or holds a newer document. */
export function migrateProject(project: ProjectState, migrations: Migration[] = MIGRATIONS): MigrationResult | null {
  const to = migrations.length + 1;
  const versions = documents(project).map(versionOf);
  const from = Math.min(...versions);
  if (Math.max(...versions) > to) return null;
  // Equal versions everywhere is the only "nothing to do": a document with no version still needs stamping.
  if (from === to && documents(project).every((d) => d.schemaVersion === to)) return null;
  const state = structuredClone(project);
  // A theme definition still matching its lock is unmodified theme data. Migrating it must not make it look edited.
  const pristine = Object.values(state.components)
    .filter((d) => d.owner === 'theme' && state.themeLock.components?.[d.id]?.hash === definitionHash(d))
    .map((d) => d.id);
  for (const doc of documents(state)) doc.schemaVersion = versionOf(doc);
  const pending = migrations.slice(from - 1);
  pending.forEach((m, i) => {
    const source = from + i;
    const due = new Set<unknown>(documents(state).filter((d) => d.schemaVersion === source));
    m.migrate(state, (doc) => due.has(doc));
    // Read back from the project: a step may have replaced a document object rather than changed it.
    for (const doc of documents(state)) if (doc.schemaVersion === source || !Number.isInteger(doc.schemaVersion)) doc.schemaVersion = source + 1;
  });
  for (const id of pristine) if (state.components[id] && state.themeLock.components[id]) state.themeLock.components[id].hash = definitionHash(state.components[id]);
  return { state, from, to, applied: pending.map((m) => m.id) };
}
