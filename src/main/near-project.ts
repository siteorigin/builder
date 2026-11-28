import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { NearbyProject } from '@shared/api';
import { DOC_DIR, MANIFEST_FILE } from './project/documents';

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

/** A JSON document's string field, trimmed; null when it is missing, empty or unreadable. */
const field = (text: string | null, key: string): string | null => {
  try {
    const v = text === null ? undefined : (JSON.parse(text) as Record<string, unknown> | null)?.[key];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
};

/**
 * A project folder's name as Recent projects shows it (projectDisplayName: a working copy's own name, else the site's
 * name), else its manifest's, else the folder's own. `null` when the folder is no project, `undefined` when that cannot
 * be told (its manifest is there but could not be read). A damaged manifest is still that project's: opening it
 * explains the damage.
 */
async function projectName(dir: string): Promise<string | null | undefined> {
  let text: string | null;
  try {
    text = await readRegular(join(dir, MANIFEST_FILE));
  } catch (e) {
    const code = errorCode(e);
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : undefined;
  }
  if (text === null) return null;
  const own = field(text, 'workingCopyName');
  if (own !== null) return own;
  const site = await readRegular(join(dir, DOC_DIR, 'site.json')).catch(() => null);
  return field(site, 'name') ?? field(text, 'name') ?? basename(dir);
}

/** A regular file's text; null for anything else there (a folder, or a pipe whose read would never end). */
async function readRegular(path: string): Promise<string | null> {
  if (!(await fs.stat(path)).isFile()) return null;
  return fs.readFile(path, 'utf8');
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
    let path = join(dir, e.name);
    if (e.name.startsWith('.') || !(e.isDirectory() || e.isSymbolicLink())) continue;
    // A linked folder is offered where it leads, so the offer opens what it names and a link beside its own folder is
    // one project, not two.
    if (e.isSymbolicLink()) {
      const real = await fs.realpath(path).catch(() => null);
      if (real === null || !(await isDirectory(real))) continue;
      path = real;
    }
    const name = await projectName(path);
    if (name === undefined) complete = false;
    else if (name !== null && !found.some((p) => p.dir === path)) found.push({ dir: path, name });
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
  // By its real path, as the project would be opened: a link to a project beside it, or the home folder reached by
  // another name, is then the same folder.
  const dir = await fs.realpath(file ? dirname(chosen) : chosen).catch(() => (file ? dirname(chosen) : chosen));
  // A website says which project it was exported from nowhere, wherever it is kept: none is guessed for it.
  if ((await isFile(join(dir, 'index.html'))) && (await isDirectory(join(dir, '_app')))) return { message: WEBSITE_FOLDER };
  // The project above: the nearest folder up that is one, however deep the chosen folder is inside it, up to (and not
  // including) the home folder or the top of the disk, where a stray manifest is no project anyone keeps work in.
  const home = await fs.realpath(homedir()).catch(() => homedir());
  for (let up = file ? dir : dirname(dir), from = file ? '' : dir; up !== from && up !== home && dirname(up) !== up; from = up, up = dirname(up)) {
    const name = await projectName(up);
    // A manifest there that cannot be read: whether this is that project cannot be told, so none further up is offered.
    if (name === undefined) break;
    if (name === null) continue;
    const nearby = { dir: up, name };
    if (up === dir) return { message: `That file is part of the project “${name}”, in ${up}.`, nearby };
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
  if (found.length === 1) return { message: `That folder holds the project “${found[0].name}”, but not all of the folder could be looked through for others. Choose the folder of the project to open.` };
  if (found.length > 0) return { message: `That folder holds projects, among them ${listed(found.map((p) => p.name), found.length > 3)}. Choose the folder of the one to open.` };
  return { message: NOT_A_PROJECT };
}
