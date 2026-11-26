import type { RuntimeState } from '../api';
import type { Collection, ComponentDefinition, EntryDoc, ProjectManifest, ProjectState } from '../types';
import type { RpcError } from './messages';

/**
 * The project as a live session's guests are given it (#765): `project.snapshot` answers with it and `project:changed`
 * carries it. It is the host's project documents and what a guest needs to know about editing them now, and nothing
 * of the host's computer or editor: no folder, no opening, no exports, versions, history, conflicts, chat drafts,
 * diagnostics or error text. The host's own snapshot (ProjectSnapshot) never leaves the main process.
 */
export interface LiveProjectSnapshot {
  revision: number;
  state: LiveProjectState;
  /** The host's project is open read-only: guests' edits are refused until it is not. */
  readOnly: boolean;
  /** The host's AI is making changes: guests' edits are refused until it finishes. */
  aiBusy: boolean;
  runtime: LiveRuntimeStatus;
}

/**
 * The project's documents, less what stays the author's: the private brief and external sources' settings (which
 * name the secrets they sign in with). The manifest leaves out the author's own name for this working copy,
 * components the path of their code and the code the author wrote (a theme's own code ships with the app and stays),
 * and a synced entry where it was synced from, which can name a file anywhere on the host's computer.
 */
export type LiveProjectState = Omit<ProjectState, 'brief' | 'sources' | 'manifest' | 'components' | 'collections'> & {
  manifest: Omit<ProjectManifest, 'workingCopyName'>;
  components: Record<string, Omit<ComponentDefinition, 'sourcePath'>>;
  collections: Record<string, Omit<Collection, 'entries'> & { entries: Record<string, Omit<EntryDoc, 'source'>> }>;
};

/** What the preview is doing, without its address (a port on the host's computer) or its messages. */
export interface LiveRuntimeStatus {
  state: RuntimeState['state'];
}

/**
 * The `project:changed` event. A snapshot that does not fit in one frame is announced by its revision alone: asking
 * for it then fails the same way until a later, smaller one.
 */
export type LiveProjectChanged = { kind: 'snapshot'; snapshot: LiveProjectSnapshot } | { kind: 'too-large'; revision: number };

/**
 * The host's answer to a collaborator's `project.apply`: the revision the edit made and, operation by operation, the
 * IDs of what it made (a new node or page), so the guest can go on editing it; or why nothing was changed.
 */
export type LiveApplyResult = { ok: true; revision: number; results: Array<Record<string, string | string[]>> } | { ok: false; error: RpcError };

/** What the host's snapshot is built from. */
export interface LiveSnapshotSource {
  state: ProjectState;
  revision: number;
  readOnly: boolean;
  aiBusy: boolean;
  runtime: RuntimeState['state'];
}

/** Stands in for a host path wherever one turns up in text. */
export const HOST_PATH_PLACEHOLDER = '…';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A pattern for the host's own paths (the project folder, the home folder) as text may hold them: either slash, and a
 * path is only a path up to a separator or the end, so `/home/ann` never matches inside `/home/anna`. Paths too short
 * to tell apart from ordinary text (the root) are left out. Null when nothing is left to look for.
 */
function hostPathPattern(paths: readonly string[]): RegExp | null {
  const forms = new Set<string>();
  for (const raw of paths) {
    const path = raw.replace(/[\\/]+$/, '');
    if (path.replace(/[\\/:]/g, '').length < 3) continue;
    forms.add(path);
    forms.add(path.replace(/\\/g, '/'));
    forms.add(path.replace(/\//g, '\\'));
  }
  if (!forms.size) return null;
  // The longest first, so the project folder inside the home folder is matched whole.
  const alternatives = [...forms].sort((a, b) => b.length - a.length).map(escape);
  return new RegExp(`(?:${alternatives.join('|')})(?=$|[\\\\/\\s"'<>()\`,;:?#])`, 'g');
}

/** A deep copy of a JSON value with every host path in its text (keys too) replaced. */
function scrub(value: unknown, pattern: RegExp): unknown {
  if (typeof value === 'string') return value.replace(pattern, HOST_PATH_PLACEHOLDER);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, pattern));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    // Defined, never assigned: a key such as __proto__ is kept as data.
    Object.defineProperty(out, key.replace(pattern, HOST_PATH_PLACEHOLDER), { value: scrub(v, pattern), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function shareComponent(def: ComponentDefinition): Omit<ComponentDefinition, 'sourcePath'> {
  const { sourcePath: _path, source, ...rest } = def;
  return def.owner === 'theme' && source !== undefined ? { ...rest, source } : rest;
}

const shareCollection = (c: Collection): LiveProjectState['collections'][string] => ({
  ...c,
  entries: Object.fromEntries(Object.entries(c.entries).map(([id, { source: _from, ...entry }]) => [id, entry]))
});

/**
 * The snapshot guests are given, made from the host's: only the fields named here, and every host path in their text
 * (`hostPaths`: the project folder and the home folder) replaced, so a page that quotes one, or a document that holds
 * one where it should not, never sends it over the relay.
 */
export function liveSnapshot(source: LiveSnapshotSource, hostPaths: readonly string[]): LiveProjectSnapshot {
  const { brief: _brief, sources: _sources, manifest, components, collections, ...documents } = source.state;
  const { workingCopyName: _name, ...sharedManifest } = manifest;
  const state: LiveProjectState = {
    ...documents,
    manifest: sharedManifest,
    components: Object.fromEntries(Object.entries(components).map(([id, def]) => [id, shareComponent(def)])),
    collections: Object.fromEntries(Object.entries(collections).map(([id, c]) => [id, shareCollection(c)]))
  };
  const pattern = hostPathPattern(hostPaths);
  return {
    revision: source.revision,
    state: pattern ? (scrub(state, pattern) as LiveProjectState) : state,
    readOnly: source.readOnly,
    aiBusy: source.aiBusy,
    runtime: { state: source.runtime }
  };
}
