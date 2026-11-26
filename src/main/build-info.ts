/**
 * Which build is running (#887): the package version alone names every build of a release the same, so each build
 * also records the commit it was made from and when it was made (electron.vite.config.ts stamps them into the main
 * bundle). No Electron import, so the wording can be tested.
 */

/** What a build records about itself. Null where the build could not tell (no git checkout, say). */
export interface BuildStamp {
  commit: string | null;
  /** When it was built, as an ISO 8601 UTC time. */
  builtAt: string | null;
}

/** The stamp for a build made now, from the checkout's git: `git` runs a git command and returns its output, throwing when it cannot. */
export function readBuildStamp(git: (args: string[]) => string, now: Date = new Date()): BuildStamp {
  let commit: string | null = null;
  try {
    commit = git(['rev-parse', '--short=10', 'HEAD']).trim() || null;
  } catch {
    commit = null;
  }
  return { commit, builtAt: now.toISOString() };
}

/** A build time for people: the UTC date and minute, `2026-11-26 14:03 UTC`. */
export function buildTime(builtAt: string | null): string | null {
  if (!builtAt) return null;
  const t = new Date(builtAt);
  if (Number.isNaN(t.getTime())) return null;
  return `${t.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The build on its own: `a1b2c3d4e5, built 2026-11-26 14:03 UTC`. */
export function buildLabel(stamp: BuildStamp): string {
  const time = buildTime(stamp.builtAt);
  return [stamp.commit ?? 'commit unknown', ...(time ? [`built ${time}`] : [])].join(', ');
}

/** The version with the build beside it, as About shows it: `0.1.0 (a1b2c3d4e5, built 2026-11-26 14:03 UTC)`. */
export function buildVersion(version: string, stamp: BuildStamp): string {
  return `${version} (${buildLabel(stamp)})`;
}

export interface BuildDetails extends BuildStamp {
  name: string;
  version: string;
  electron: string;
  platform: NodeJS.Platform;
  arch: string;
  /** The operating system's own version (os.release()). */
  osRelease: string;
}

/** Everything a bug report needs to say which build it was, as plain lines to copy and paste. */
export function buildDetailsText(d: BuildDetails): string {
  return [`${d.name} ${buildVersion(d.version, d)}`, `Electron ${d.electron}`, `${d.platform} ${d.arch} ${d.osRelease}`].join('\n');
}
