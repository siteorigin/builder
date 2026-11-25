import type { HistoryInfo } from '@shared/api';
import type { ComponentDefinition } from '@shared/types';
import { defFile } from '@generator/index';

type Entry = HistoryInfo['entries'][number];

/**
 * The component a preview error came from (#738): the first definition whose file the error's stack, source file or
 * message names, in the order they name files, so the frame nearest the throw wins. A file is named by its
 * project-relative path anywhere in a URL or path (`/src/lib/siteorigin/generated/hero.svelte?t=1:12:3`), whole up
 * to a query, a line number or the end of the frame; never as part of a longer name. Null when none is named.
 */
export function errorComponent(texts: readonly (string | undefined)[], components: Readonly<Record<string, ComponentDefinition>>): string | null {
  const byFile = new Map<string, string>();
  for (const def of Object.values(components)) {
    // A theme's code component carried in the project has no file of its own until it is generated, as any other.
    const file = defFile(def).replace(/^\.?\/+/, '');
    if (file && !byFile.has(file)) byFile.set(file, def.id);
  }
  if (!byFile.size) return null;
  // Every path-like run in the text, in order: a URL's or a path's slashes, up to what ends a frame's file.
  const PATH = /[^\s()'"`<>@?#]*\/[^\s()'"`<>?#:]+/g;
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.replace(/\\/g, '/').matchAll(PATH)) {
      const path = m[0];
      // A package's file of the same name is the package's, never the project's.
      if (path.includes('/node_modules/')) continue;
      for (const [file, id] of byFile) if (path === file || path.endsWith(`/${file}`)) return id;
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
