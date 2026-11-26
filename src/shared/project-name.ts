/**
 * What the author calls a project (#176), as Recent projects and the toolbar show it: a working copy's own name when
 * it has one (given when it was duplicated), otherwise the site's visitor-facing name, which it follows through every
 * rename (#31).
 */
import type { ProjectManifest, SiteDoc } from './types';
import { addressSlug } from './routes';

export function projectDisplayName(state: { manifest: Pick<ProjectManifest, 'workingCopyName'>; site: Pick<SiteDoc, 'name'> }): string {
  const own = state.manifest.workingCopyName;
  return (typeof own === 'string' && own.trim()) || state.site.name;
}

/** The longest name a working copy takes. */
export const MAX_COPY_NAME = 80;

/** Folder names Windows keeps for devices. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/** The folder a project gets when its name has nothing a folder name can keep ("🌸🌸", "..."). */
export const FALLBACK_FOLDER = 'website';

/**
 * The folder a project named `name` is made in, inside the folder chosen for it, as New project and Duplicate both show
 * and make it: the name as a page address spells it, so "日本語サイト" keeps its own words, cut to 60 characters at the
 * end of a word, and "Con" gets a suffix.
 */
export function projectFolderName(name: string): string {
  return projectFolder(name).folder;
}

/** The folder for `name` (see projectFolderName), and whether it is FALLBACK_FOLDER because nothing in the name could be kept. */
export function projectFolder(name: string): { folder: string; fallback: boolean } {
  const slug = addressSlug(name, { wholeWords: true });
  if (!slug) return { folder: FALLBACK_FOLDER, fallback: true };
  return { folder: WINDOWS_RESERVED.test(slug) ? `${slug}-site` : slug, fallback: false };
}
