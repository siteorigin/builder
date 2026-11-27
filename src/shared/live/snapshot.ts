import type { RuntimeState } from '../api';
import type { AssetRecord, AssetsDoc, Collection, ComponentDefinition, EntryDoc, ProjectManifest, ProjectState } from '../types';
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
 * components their code and where it is (guests never edit code, and a project's copy of a theme's code may hold
 * the author's own changes), library files the name they had on the author's computer, and a synced entry where it
 * was synced from, which can name a file anywhere on the host's computer.
 */
export type LiveProjectState = Omit<ProjectState, 'brief' | 'sources' | 'manifest' | 'components' | 'collections' | 'assets'> & {
  manifest: Omit<ProjectManifest, 'workingCopyName'>;
  components: Record<string, Omit<ComponentDefinition, 'sourcePath' | 'source'>>;
  collections: Record<string, Omit<Collection, 'entries'> & { entries: Record<string, Omit<EntryDoc, 'source'>> }>;
  assets: Omit<AssetsDoc, 'assets'> & { assets: Record<string, Omit<AssetRecord, 'originalName'>> };
};

/** What the preview is doing, without its address (a port on the host's computer) or its messages. */
export interface LiveRuntimeStatus {
  state: RuntimeState['state'];
}

/**
 * The `project:changed` event. A snapshot that does not fit in one frame is announced by its revision alone: asking
 * for it then fails the same way until a later, smaller one. `missed` comes from the relay, in place of a snapshot a
 * guest's connection was too far behind to take: the guest asks for the project once it has caught up.
 */
export type LiveProjectChanged = { kind: 'snapshot'; snapshot: LiveProjectSnapshot } | { kind: 'too-large'; revision: number } | { kind: 'missed' };

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
 * A pattern for the host's own paths (the project folder, the home folder) as text may hold them: either slash, any
 * case (the host's disk may not tell them apart), and only as a path of its own. It ends at a separator, a sentence's
 * end or the end of the text, so `/home/ann` never matches inside `/home/anna`; and it starts a path rather than
 * continuing a word or an address, so a web address that happens to contain it (`https://example.org/home/ann/`) is
 * left as it is, where a `file://` address is not. Paths too short to tell apart from ordinary text (the root) are
 * left out. Null when nothing is left to look for.
 */
function hostPathPattern(paths: readonly string[]): RegExp | null {
  const forms = hostPathForms(paths);
  if (!forms.size) return null;
  // The longest first, so the project folder inside the home folder is matched whole.
  const alternatives = [...forms].sort((a, b) => b.length - a.length).map(escape);
  return new RegExp(`(?<![\\w.~%-])(?:${alternatives.join('|')})(?=$|[\\\\/\\s"'”’<>()\`,;:?#!]|\\.(?:$|\\s|[\\\\/"'”’<>)]))`, 'gi');
}

/** The host's paths as text may write them: either slash, without a trailing one. Too short to tell apart: left out. */
function hostPathForms(paths: readonly string[]): Set<string> {
  const forms = new Set<string>();
  for (const raw of paths) {
    const path = raw.replace(/[\\/]+$/, '');
    if (path.replace(/[\\/:]/g, '').length < 3) continue;
    forms.add(path);
    forms.add(path.replace(/\\/g, '/'));
    forms.add(path.replace(/\//g, '\\'));
  }
  return forms;
}

/**
 * How many characters at the end of `text` could be the start of one of the host's paths, still being written (at
 * least `min` of them): text that streams is sent only up to there, so no part of a path goes out before it can be
 * taken out whole (#769). Any case, as hostPathPattern matches.
 */
export function hostPathTail(text: string, hostPaths: readonly string[], min = 1): number {
  const lower = text.toLowerCase();
  let longest = 0;
  for (const form of hostPathForms(hostPaths)) {
    const f = form.toLowerCase();
    for (let n = Math.min(f.length, lower.length); n > longest; n--) {
      if (n >= min && lower.endsWith(f.slice(0, n))) {
        longest = n;
        break;
      }
    }
  }
  return longest;
}

/** `text` with every host path in it (see liveSnapshot) replaced: for anything else a guest is sent, such as an error. */
export function scrubHostPaths(text: string, hostPaths: readonly string[]): string {
  const pattern = hostPathPattern(hostPaths);
  return pattern ? text.replace(pattern, HOST_PATH_PLACEHOLDER) : text;
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

function shareComponent(def: ComponentDefinition): LiveProjectState['components'][string] {
  const { sourcePath: _path, source: _source, ...rest } = def;
  return rest;
}

const shareAssets = (doc: AssetsDoc): LiveProjectState['assets'] => ({
  ...doc,
  assets: Object.fromEntries(Object.entries(doc.assets).map(([id, { originalName: _name, ...asset }]) => [id, asset]))
});

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
  const { brief: _brief, sources: _sources, manifest, components, collections, assets, ...documents } = source.state;
  const { workingCopyName: _name, ...sharedManifest } = manifest;
  const state: LiveProjectState = {
    ...documents,
    manifest: sharedManifest,
    components: Object.fromEntries(Object.entries(components).map(([id, def]) => [id, shareComponent(def)])),
    collections: Object.fromEntries(Object.entries(collections).map(([id, c]) => [id, shareCollection(c)])),
    assets: shareAssets(assets)
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
