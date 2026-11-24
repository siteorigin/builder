/**
 * The project's imported fonts, loaded into the editor's own document so its samples (Site styles, Assets) are drawn
 * in the files themselves, not in whatever the system has. The generated site declares the fonts for the canvas;
 * the editor never did, so a sample that named an imported family painted in the system font.
 *
 * Each family is registered under a private name, so a font named like the editor's own (or like a system font)
 * never restyles the editor, and each file once more under a name of its own, so a file's sample shows that file and
 * no other of its family. The bytes come over IPC rather than from the preview server, which serves no CORS headers
 * for the editor (fonts need them) and may not be running.
 */
import { useMemo, useSyncExternalStore } from 'react';
import type { FontCoverage } from '@shared/font-scripts';
import { FAMILY_KEYWORDS, isValidFontAsset } from '@shared/fonts';
import type { AssetRecord } from '@shared/types';
import { api, useStore } from '../store';

export interface EditorFontFile {
  status: 'loading' | 'ready' | 'failed';
  /** The name a sample uses to draw in this file alone. */
  alias: string;
  coverage: FontCoverage | null;
}

interface Entry extends EditorFontFile {
  /** What the faces were made from: a change to any of it loads the file again. */
  key: string;
  family: string;
  file: string;
  id: string;
  faces: FontFace[];
}

const entries = new Map<string, Entry>();
let opening: string | null = null;
let fileAliases = 0;
const listeners = new Set<() => void>();
/** A new object on every change, for useSyncExternalStore. */
let version = { n: 0 };
const changed = () => {
  version = { n: version.n + 1 };
  listeners.forEach((l) => l());
};

/** A family as CSS matches it: case folded, a run of spaces as one. */
const familyKey = (family: string) => family.trim().replace(/\s+/g, ' ').toLowerCase();
/**
 * The private name a family is drawn under in the editor: a plain CSS identifier, so FontFace and a style read it
 * alike whatever the family is called ("1984 Display" is not an identifier).
 */
const familyAliases = new Map<string, string>();
function familyAlias(family: string): string {
  const key = familyKey(family);
  let alias = familyAliases.get(key);
  if (!alias) familyAliases.set(key, (alias = `__so-family-${familyAliases.size + 1}`));
  return alias;
}
const keyOf = (a: AssetRecord) => [a.file, a.hash, familyKey(a.font!.family), a.font!.weight, a.font!.style].join('\n');
/** The generated site's order (`fontFaceCss`): where two files overlap, the later one is checked first. */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function drop(e: Entry) {
  for (const f of e.faces) document.fonts.delete(f);
  e.faces = [];
}

/** Family faces go in the generated site's order, whichever file arrived first. */
function reorderFamilies() {
  const ready = [...entries.values()].filter((e) => e.status === 'ready' && e.faces.length === 2);
  for (const e of ready) document.fonts.delete(e.faces[0]);
  for (const e of ready.sort((a, b) => byText(familyKey(a.family), familyKey(b.family)) || byText(a.file, b.file) || byText(a.id, b.id))) document.fonts.add(e.faces[0]);
}

async function load(e: Entry, a: AssetRecord, at: string) {
  const data = await api.project.fontFile(a.id, at).catch(() => null);
  // A reply for a file since changed or removed, or for a project since closed, is dropped.
  if (entries.get(a.id) !== e || opening !== at) return;
  if (!data) {
    e.status = 'failed';
    return changed();
  }
  try {
    const descriptors = { weight: a.font!.weight, style: a.font!.style };
    // Copied out of the IPC reply into a buffer of its own, which FontFace takes.
    const bytes = new Uint8Array(data.bytes);
    const family = new FontFace(familyAlias(a.font!.family), bytes, descriptors);
    const file = new FontFace(e.alias, bytes, descriptors);
    await Promise.all([family.load(), file.load()]);
    if (entries.get(a.id) !== e || opening !== at) return;
    e.faces = [family, file];
    document.fonts.add(file);
    e.coverage = data.coverage;
    e.status = 'ready';
    reorderFamilies();
  } catch {
    if (entries.get(a.id) !== e) return;
    e.status = 'failed';
  }
  changed();
}

/** Bring the editor's fonts in line with the project: load new or changed files, drop the ones that went. */
function sync(workspaceKey: string | null, assets: Record<string, AssetRecord> | undefined) {
  if (typeof document === 'undefined' || !document.fonts) return;
  let dirty = false;
  if (workspaceKey !== opening) {
    for (const e of entries.values()) drop(e);
    dirty = entries.size > 0;
    entries.clear();
    opening = workspaceKey;
  }
  const want = new Map<string, AssetRecord>();
  if (workspaceKey) for (const [k, a] of Object.entries(assets ?? {})) if (a && a.id === k && isValidFontAsset(a)) want.set(k, a);
  for (const [id, e] of [...entries]) {
    const a = want.get(id);
    if (a && keyOf(a) === e.key) continue;
    drop(e);
    entries.delete(id);
    dirty = true;
  }
  for (const [id, a] of want) {
    if (entries.has(id)) continue;
    const e: Entry = { key: keyOf(a), family: a.font!.family, file: a.file, id, alias: `__so-file-${++fileAliases}`, status: 'loading', coverage: null, faces: [] };
    entries.set(id, e);
    dirty = true;
    void load(e, a, workspaceKey!);
  }
  if (dirty) changed();
}

/** Keep the editor's fonts in step with the open project, until the returned function stops it. */
export function startEditorFonts(): () => void {
  const read = () => {
    const s = useStore.getState().snapshot;
    sync(s?.workspaceKey ?? null, s?.state.assets.assets);
  };
  read();
  let last = useStore.getState().snapshot;
  const off = useStore.subscribe((s) => {
    // Only a new snapshot can change the project's fonts.
    if (s.snapshot === last) return;
    last = s.snapshot;
    read();
  });
  return () => {
    off();
    sync(null, undefined);
  };
}

/** A file as the editor has it: loading, ready to draw (its alias and coverage), or failed. */
export function useEditorFontFile(assetId: string): EditorFontFile | null {
  useSyncExternalStore(subscribe, () => version);
  const e = entries.get(assetId);
  return e ? { status: e.status, alias: e.alias, coverage: e.coverage } : null;
}
/** Several files at once, by asset ID, through one subscription. */
export function useEditorFontFiles(assetIds: string[]): Map<string, EditorFontFile | null> {
  useSyncExternalStore(subscribe, () => version);
  return new Map(
    assetIds.map((id) => {
      const e = entries.get(id);
      return [id, e ? { status: e.status, alias: e.alias, coverage: e.coverage } : null];
    })
  );
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/**
 * A font stack as the editor draws it: every family the project imports is swapped for its private name, so the
 * sample shows the imported files. Everything else (installed and system fonts, generic keywords) stays as it is.
 * `imported` holds the imported families as `familyKey` gives them.
 */
export function previewStack(stack: string, imported: ReadonlySet<string>): string {
  if (!imported.size) return stack;
  return stack
    .split(',')
    .map((part) => {
      const bare = !/^\s*['"]/.test(part);
      const name = familyKey(part.trim().replace(/^['"]|['"]$/g, ''));
      if ((bare && FAMILY_KEYWORDS.has(name)) || !imported.has(name)) return part;
      return `${part.startsWith(' ') ? ' ' : ''}${familyAlias(name)}`;
    })
    .join(',');
}

/** previewStack for the open project's imported families. */
export function usePreviewStack(): (stack: string) => string {
  const assets = useStore((s) => s.snapshot?.state.assets.assets);
  return useMemo(() => {
    const imported = new Set(Object.values(assets ?? {}).flatMap((a) => (isValidFontAsset(a) ? [familyKey(a.font!.family)] : [])));
    return (stack: string) => previewStack(stack, imported);
  }, [assets]);
}
