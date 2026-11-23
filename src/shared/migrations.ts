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
    const docs = documents(state).filter((d) => d.schemaVersion === source);
    const due = new Set<unknown>(docs);
    m.migrate(state, (doc) => due.has(doc));
    for (const doc of docs) doc.schemaVersion = source + 1;
  });
  for (const id of pristine) if (state.components[id] && state.themeLock.components[id]) state.themeLock.components[id].hash = definitionHash(state.components[id]);
  return { state, from, to, applied: pending.map((m) => m.id) };
}
