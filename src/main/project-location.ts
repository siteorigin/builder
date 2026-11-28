/**
 * Folders a project's preview cannot run from (#1366). Vite's development server reads a `#` or `?` in a module's path
 * as the start of its fragment or query, so a project under `Client #47` opens but never shows a page. New projects,
 * opened ZIP files and copies are not made there, and a project found there has its preview called unavailable, with
 * the folder to rename or move it out of, instead of a startup failure that suggests reinstalling the website tools.
 */
import { existsSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { canonicalDir } from '../runtime/policy';

/** The characters Vite's development server cannot serve a project under. */
export const UNSERVABLE_CHARS = ['#', '?'] as const;

/**
 * Where `path` really is: its nearest existing folder with links resolved, and the rest of it, not made yet, after. A
 * folder reached through a link is judged by the folder it leads to, which is where the preview would run.
 */
function realLocation(path: string): string {
  let probe = path;
  let rest = '';
  while (!existsSync(probe) && dirname(probe) !== probe) {
    rest = rest ? join(basename(probe), rest) : basename(probe);
    probe = dirname(probe);
  }
  const real = canonicalDir(probe);
  return rest ? join(real, rest) : real;
}

/** The first folder in `path` (its real location) whose name the preview cannot run under, and the characters at fault. */
export function unservableFolder(path: string): { folder: string; chars: string[] } | null {
  // A Windows long path's own prefix (\\?\C:\…) is not a folder.
  for (const part of realLocation(path).replace(/^\\\\\?\\/, '').split(sep)) {
    const chars = UNSERVABLE_CHARS.filter((c) => part.includes(c));
    if (chars.length) return { folder: part, chars };
  }
  return null;
}

function quoted(chars: readonly string[]): string {
  return chars.map((c) => `“${c}”`).join(' or ');
}

const ALL = quoted(UNSERVABLE_CHARS);

/**
 * Why a new project, opened ZIP file or copy cannot go inside `parent`, or null when it can. Says which folder is at
 * fault and how to choose one that works, before anything is made.
 */
export function unservableLocation(parent: string): string | null {
  const bad = unservableFolder(parent);
  if (!bad) return null;
  return `The preview can’t run from a folder whose path contains ${quoted(bad.chars)}, and “${bad.folder}” does. Choose a folder with no ${ALL} anywhere in its path, or rename that folder.`;
}

/** Why the preview of the project in `dir` cannot run there, or null when it can: the way back is another location. */
export function unservableProject(dir: string): string | null {
  const bad = unservableFolder(dir);
  if (!bad) return null;
  return `The preview can’t run from this project’s location, because the folder “${bad.folder}” has ${quoted(bad.chars)} in its name. Close the project, rename that folder or move the project to a folder with no ${ALL} in its path, then open it again.`;
}
