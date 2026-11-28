import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { NearbyProject } from '@shared/api';
import { MANIFEST_FILE } from './project/documents';

/** A folder that is no project, when the author knows nothing about how a project is laid out on disk. */
export const NOT_A_PROJECT = 'That folder is not a SiteOrigin Builder project. Choose the folder the project was saved in, the one named after it when it was created.';

/** A finished website (exported, or downloaded from its host): what visitors see, not something to edit. */
export const WEBSITE_FOLDER = 'That folder holds an exported website: the finished pages for visitors, which SiteOrigin Builder cannot edit. Open the project it was exported from instead.';

/** How many of a folder's entries are looked through for projects one level down: a chosen home folder is never walked whole. */
const MAX_CHILDREN = 500;

const isDirectory = async (p: string) => (await fs.stat(p).catch(() => null))?.isDirectory() === true;
const isFile = async (p: string) => (await fs.stat(p).catch(() => null))?.isFile() === true;

/** A project folder's name as Welcome shows it: its manifest's name, else the folder's own; null when it is no project. */
async function projectName(dir: string): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readFile(join(dir, MANIFEST_FILE), 'utf8');
  } catch {
    return null;
  }
  let name: unknown;
  try {
    name = (JSON.parse(text) as { name?: unknown } | null)?.name;
  } catch {
    // A damaged manifest is still that project's: opening it explains the damage.
  }
  return typeof name === 'string' && name.trim() ? name.trim() : basename(dir);
}

/** "A", "B" and "C"; past four, the first three and how many more. */
function listed(names: string[]): string {
  const q = names.map((n) => `“${n}”`);
  const shown = q.length > 4 ? [...q.slice(0, 3), `${q.length - 3} more`] : q;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/**
 * Why a chosen folder (or a file in one) is not a project, and the project it was most likely meant to be (#1433): the
 * project it is inside (its `siteorigin/` or `src/` folder, say), else the one project it holds (the folder projects are
 * kept in). An exported website is said to be one. Nothing is changed, and an unreadable folder is just not a project.
 */
export async function notAProject(chosen: string): Promise<{ message: string; nearby?: NearbyProject }> {
  // A file chosen in the macOS picker (a page's index.html, a document) speaks for the folder it is in.
  const dir = (await isFile(chosen)) ? dirname(chosen) : chosen;
  // The project above: the nearest folder up that is one, however deep the chosen folder is inside it.
  for (let up = dirname(dir), from = dir; up !== from; from = up, up = dirname(up)) {
    const name = await projectName(up);
    if (name !== null) return { message: `That folder is inside the project “${name}”, whose folder is ${up}.`, nearby: { dir: up, name } };
  }
  // The projects one level down, by name, in the order the folder lists them.
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: NearbyProject[] = [];
  for (const e of entries.slice(0, MAX_CHILDREN)) {
    if (e.name.startsWith('.') || !(e.isDirectory() || (e.isSymbolicLink() && (await isDirectory(join(dir, e.name)))))) continue;
    const name = await projectName(join(dir, e.name));
    if (name !== null) found.push({ dir: join(dir, e.name), name });
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  if (found.length === 1) return { message: `That folder holds the project “${found[0].name}”, in ${found[0].dir}.`, nearby: found[0] };
  if (found.length > 1) return { message: `That folder holds ${found.length} projects: ${listed(found.map((p) => p.name))}. Choose the folder of the one to open.` };
  if ((await isFile(join(dir, 'index.html'))) && (await isDirectory(join(dir, '_app')))) return { message: WEBSITE_FOLDER };
  return { message: NOT_A_PROJECT };
}
