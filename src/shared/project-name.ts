/**
 * What the author calls a project (#176), as Recent projects and the toolbar show it: a working copy's own name when
 * it has one (given when it was duplicated), otherwise the site's visitor-facing name, which it follows through every
 * rename (#31).
 */
import type { ProjectManifest, SiteDoc } from './types';
import { slugify } from './routes';

export function projectDisplayName(state: { manifest: Pick<ProjectManifest, 'workingCopyName'>; site: Pick<SiteDoc, 'name'> }): string {
  const own = state.manifest.workingCopyName;
  return (typeof own === 'string' && own.trim()) || state.site.name;
}

/** The longest name a working copy takes. */
export const MAX_COPY_NAME = 80;

/** Folder names Windows keeps for devices. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/** The folder a project named `name` is made in, inside the folder chosen for it ("Con" gets a suffix). */
export function projectFolderName(name: string): string {
  const slug = slugify(name) || 'website';
  return WINDOWS_RESERVED.test(slug) ? `${slug}-site` : slug;
}
