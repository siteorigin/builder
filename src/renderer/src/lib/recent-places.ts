/**
 * Where each Recent projects card says its project lives (#31). Each card names the project's own folder, so two
 * projects kept side by side (~/Websites/kloof-light-studio and ~/Websites/new-site) never read alike, whatever
 * their names.
 */
import type { RecentProject } from '@shared/api';

/** A path with the home folder as "~". */
export function shortPath(dir: string) {
  return dir.replace(/^\/Users\/[^/]+/, '~').replace(/^[A-Z]:\\Users\\[^\\]+/i, '~');
}

/**
 * Each project's folder, with home folders as "~", unless that would make two same-named projects look alike (two
 * people's ~/Websites/studio), when the real path is shown instead.
 */
export function whereLabels(all: RecentProject[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of all) {
    const short = shortPath(r.dir);
    const alike = all.some((x) => x !== r && x.name === r.name && x.dir !== r.dir && shortPath(x.dir) === short);
    out.set(r.dir, alike ? r.dir : short);
  }
  return out;
}
