import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { NearbyProject } from '@shared/api';
import { MANIFEST_FILE } from './project/documents';

/** A folder that is no project, when the author knows nothing about how a project is laid out on disk. */
export const NOT_A_PROJECT = 'That folder is not a SiteOrigin Builder project. Choose the folder the project was saved in, the one named after it when it was created.';

/** A finished website (exported, or downloaded from its host): what visitors see, not something to edit. */
export const WEBSITE_FOLDER = 'That folder holds an exported website: the finished pages for visitors, which SiteOrigin Builder cannot edit. Open the project it was exported from instead.';

/** A chosen folder that cannot be looked into. */
export const FOLDER_DENIED = 'SiteOrigin Builder does not have permission to look in that folder. Choose the project’s own folder, or give SiteOrigin Builder access to this one and try again.';

/** How many of a folder's entries are looked through for projects one level down: a chosen home folder is never walked whole. */
const MAX_CHILDREN = 500;

const isDirectory = async (p: string) => (await fs.stat(p).catch(() => null))?.isDirectory() === true;
const isFile = async (p: string) => (await fs.stat(p).catch(() => null))?.isFile() === true;
const errorCode = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code;

/**
 * A project folder's name as Welcome shows it: its manifest's name, else the folder's own. `null` when the folder is no
 * project, `undefined` when that cannot be told (its manifest is there but could not be read).
 */
async function projectName(dir: string): Promise<string | null | undefined> {
  let text: string;
  try {
    text = await fs.readFile(join(dir, MANIFEST_FILE), 'utf8');
  } catch (e) {
    const code = errorCode(e);
    return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR' ? null : undefined;
  }
  let name: unknown;
  try {
    name = (JSON.parse(text) as { name?: unknown } | null)?.name;
  } catch {
    // A damaged manifest is still that project's: opening it explains the damage.
  }
  return typeof name === 'string' && name.trim() ? name.trim() : basename(dir);
}

/** “A”, “B” and “C”; past four, the first three and how many more (`others`: how many is not known). */
function listed(names: string[], others = false): string {
  const q = names.map((n) => `“${n}”`);
  if (others) return `${q.slice(0, 3).join(', ')} and others`;
  const shown = q.length > 4 ? [...q.slice(0, 3), `${q.length - 3} more`] : q;
  return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** The projects one level down, by name, and whether every entry could be looked at. Hidden folders are passed over. */
async function childProjects(dir: string): Promise<{ found: NearbyProject[]; complete: boolean }> {
  const found: NearbyProject[] = [];
  let complete = true;
  let seen = 0;
  // Read as it goes, so a huge folder is never listed whole.
  for await (const e of await fs.opendir(dir)) {
    if (++seen > MAX_CHILDREN) {
      complete = false;
      break;
    }
    const path = join(dir, e.name);
    if (e.name.startsWith('.') || !(e.isDirectory() || (e.isSymbolicLink() && (await isDirectory(path))))) continue;
    const name = await projectName(path);
    if (name === undefined) complete = false;
    else if (name !== null) found.push({ dir: path, name });
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  return { found, complete };
}

/**
 * Why a chosen folder (or a file in one) is not a project, and the project it was most likely meant to be (#1433): the
 * project it is inside (its `siteorigin/` or `src/` folder, say), else the one project it holds (the folder projects are
 * kept in). An exported website is said to be one. Nothing is changed. A project is offered only when it is the one
 * there could be: never one of several, nor one found in a folder that could not be looked through whole.
 */
export async function notAProject(chosen: string): Promise<{ message: string; nearby?: NearbyProject }> {
  // A file chosen in the macOS picker (a page's index.html, the project's package.json) speaks for the folder it is in,
  // which may be the project itself.
  const file = await isFile(chosen);
  const dir = file ? dirname(chosen) : chosen;
  const website = (await isFile(join(dir, 'index.html'))) && (await isDirectory(join(dir, '_app')));
  // The project above: the nearest folder up that is one, however deep the chosen folder is inside it.
  for (let up = file ? dir : dirname(dir), from = file ? '' : dir; up !== from; from = up, up = dirname(up)) {
    const name = await projectName(up);
    if (!name) continue;
    const nearby = { dir: up, name };
    if (up === dir) return { message: `That file is part of the project “${name}”, in ${up}.`, nearby };
    if (website) return { message: `That folder holds a website exported from the project “${name}”, which is edited from its own folder, ${up}.`, nearby };
    return { message: `That folder is inside the project “${name}”, whose folder is ${up}.`, nearby };
  }
  let children: Awaited<ReturnType<typeof childProjects>>;
  try {
    children = await childProjects(dir);
  } catch (e) {
    const code = errorCode(e);
    return { message: code === 'EACCES' || code === 'EPERM' ? FOLDER_DENIED : NOT_A_PROJECT };
  }
  const { found, complete } = children;
  if (found.length === 1 && complete) return { message: `That folder holds the project “${found[0].name}”, in ${found[0].dir}.`, nearby: found[0] };
  if (found.length > 1 && complete) return { message: `That folder holds ${found.length} projects: ${listed(found.map((p) => p.name))}. Choose the folder of the one to open.` };
  if (found.length > 0) return { message: `That folder holds projects, among them ${listed(found.map((p) => p.name), found.length > 3)}. Choose the folder of the one to open.` };
  if (website) return { message: WEBSITE_FOLDER };
  return { message: NOT_A_PROJECT };
}
