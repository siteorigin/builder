import type { HistoryInfo } from '@shared/api';
import type { ComponentDefinition } from '@shared/types';
import { defFile } from '@generator/index';

type Entry = HistoryInfo['entries'][number];

/** Where the editor's preview keeps the project as it serves it, and a component preview's own copy inside that. */
const SERVED_COPY = /^\.siteorigin\/cache\/dev\/(?:isolated\/[^/]+\/)?/;

/**
 * A file named in a preview error, as a path from the project folder `dir`: a preview address
 * (`http://127.0.0.1:5173/src/x.svelte`, `/@fs/{dir}/src/x.svelte`), an absolute path (a build error's file), or the
 * editor's served copy of the project (`.siteorigin/cache/dev/...`). Null for a file outside the project.
 */
export function projectPath(raw: string, dir: string): string | null {
  let p = raw.replace(/\\/g, '/');
  // A frame written `name@url` (Firefox, Safari), then the address's origin: what is left is from the server's root.
  const url = /[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(p);
  if (url) p = p.slice(url.index + url[0].length);
  // Vite's address for a file by its absolute path.
  const viaFs = p.startsWith('/@fs/');
  if (viaFs) p = p.slice(4);
  // An absolute path counts inside the project folder, or inside the editor's served copy wherever the project
  // folder was reached from (a linked path); anywhere else is not the project's. An address's path is from the root.
  if (viaFs || /^\/?[a-z]:\//i.test(p) || (!url && p.startsWith('/'))) {
    const root = dir.replace(/\\/g, '/').replace(/\/+$/, '');
    const at = root && p.startsWith(`${root}/`) ? root.length + 1 : root && p.startsWith(`/${root}/`) ? root.length + 2 : -1;
    const copy = p.indexOf('/.siteorigin/cache/dev/');
    if (at >= 0) p = p.slice(at);
    else if (copy >= 0) p = p.slice(copy + 1);
    else return null;
  }
  p = p.replace(/^\/+/, '').replace(SERVED_COPY, '');
  return p && !p.split('/').includes('node_modules') ? p : null;
}

/**
 * The component a preview error came from (#738): the first definition whose file the error's file, stack or
 * message names, in the order they name files, so the frame nearest the throw wins. A file counts only as the whole
 * of its path from the project folder (see projectPath), never as the end of a longer one. Null when none is named.
 */
export function errorComponent(texts: readonly (string | undefined)[], components: Readonly<Record<string, ComponentDefinition>>, dir: string): string | null {
  const byFile = new Map<string, string>();
  for (const def of Object.values(components)) {
    const file = defFile(def).replace(/^\.?\/+/, '');
    if (file && !byFile.has(file)) byFile.set(file, def.id);
  }
  if (!byFile.size) return null;
  // Every path-like run in the text, in order: a URL's or a path's slashes, up to what ends a frame's file (a query,
  // a fragment, a line number).
  const PATH = /[^\s()'"`<>?#]*\/[^\s()'"`<>?#:]+/g;
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.replace(/\\/g, '/').matchAll(PATH)) {
      const file = projectPath(m[0], dir);
      const id = file === null ? undefined : byFile.get(file);
      if (id) return id;
    }
  }
  return null;
}

/**
 * What the page shows, as History has it: each applied step, oldest first, with the revision it last changed the
 * project at, so a step that later edits joined (typing that goes on) reads as a new change.
 */
export function appliedSteps(history: HistoryInfo | undefined): string[] {
  return (history?.entries ?? []).filter((e) => e.applied).map(stepKey);
}

const stepKey = (e: Entry) => `${e.id}@${e.revision}`;

/**
 * The history step a preview error can be put down to (#738): the newest change applied, when the page was last
 * seen working without it (`healthy`, from appliedSteps). Null with no such sighting (the error was there when the
 * page opened), when the newest change was already in place then (the error came from something the visitor did), or
 * when what changed since was an Undo (undoing it again is a Redo, not a revert).
 */
export function revertStep(history: HistoryInfo | undefined, healthy: readonly string[] | null): { id: string; label: string; key: string } | null {
  if (!history || !healthy) return null;
  const applied = history.entries.filter((e) => e.applied);
  const newest = applied[applied.length - 1];
  if (!newest || healthy.includes(stepKey(newest))) return null;
  return { id: newest.id, label: newest.label, key: stepKey(newest) };
}

/** Whether History's newest applied step is still `key` (see revertStep): nothing was undone or added since. */
export function stillNewest(history: HistoryInfo | undefined, key: string): boolean {
  const applied = (history?.entries ?? []).filter((e) => e.applied);
  const newest = applied[applied.length - 1];
  return !!newest && stepKey(newest) === key;
}
