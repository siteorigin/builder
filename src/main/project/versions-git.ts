/**
 * Saved versions in Git (#1153): with Git snapshots on in Settings, a saved version is a commit of the whole site
 * (snapshot-inventory.ts) on the versions branch of the project's own bare repository, `.siteorigin/versions.git/`,
 * written by the bundled Git in its worker (src/main/git). The list of versions stays in `.siteorigin/versions/`
 * (versions.ts), each row naming its commit, so names, deletions and the restore marker never touch the history.
 *
 * Nothing personal reaches a commit: it is made by the app under a fixed name, at the save's time in UTC, and says only
 * what kind of version it is and the row's opaque ID. The author's name for a version lives in the list alone.
 *
 * With the setting off nothing here runs: no worker starts and no repository is made. A version already in Git stays
 * readable either way, through the same repository.
 */
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { GitError, VERSIONS_BRANCH, VERSIONS_GITDIR, type CommitInput, type FileInput, type GitRepository, type Identity, type Oid } from '../git/protocol';
import { snapshotPlace } from './snapshot-inventory';

/** How the app reaches Git for saved versions. The app gives the worker's client; tests give one in their own process. */
export interface VersionsGit {
  /** Whether a version saved now goes to Git: the Git snapshots setting, asked at every save. */
  enabled(): boolean | Promise<boolean>;
  /** The versions repository of the project in `root`. Getting it starts and writes nothing. */
  repository(root: string): GitRepository;
}

let provider: VersionsGit | null = null;
/** Set how saved versions reach Git (the app does at start); null: versions are never saved to Git, nor read from it. */
export function useVersionsGit(p: VersionsGit | null): void {
  provider = p;
}
export const versionsGit = (): VersionsGit | null => provider;

/** Who makes every commit: the app, never the person or the computer. */
export const APP_AUTHOR = { name: 'SiteOrigin Builder', email: 'versions@siteorigin.invalid' } as const;

/**
 * Whether a project file of a version is kept out of Git, as a private object of the list's store: an external source's
 * settings or converter, which a restore needs but no history that could one day be pushed should hold.
 */
export const keptOutOfGit = (path: string): boolean => snapshotPlace(path).kind === 'attachment';

/** A commit's message: what kind of version it is, and the ID that ties it to its row. Never the author's own words. */
export function commitMessage(id: string, auto: boolean): string {
  return `${auto ? 'Before restoring' : 'Saved version'}\n\nSiteOrigin-Version: ${id}\n`;
}

/** The app's identity at `time` (an ISO time), in UTC so the computer's time zone is never recorded. */
export function appIdentity(time: string): Identity {
  return { ...APP_AUTHOR, timestamp: Math.max(0, Math.floor(Date.parse(time) / 1000)), timezoneOffset: 0 };
}

/** Why a version could not be saved to Git, in the app's words: never a branch, a ref or an object. */
export function gitSaveProblem(e: unknown): string {
  if (!(e instanceof GitError)) return (e as Error)?.message ?? String(e);
  switch (e.code) {
    // These name the file and say what to do, unless they are the repository's own words.
    case 'changed':
    case 'too-large':
    case 'invalid':
      return /versions repository/i.test(e.message) ? (e.code === 'too-large' ? 'The site’s files are too large together for one version.' : 'The version could not be saved to the project’s version history.') : e.message;
    case 'locked':
    case 'conflict':
      return 'Another copy of SiteOrigin Builder is saving a version of this project. Try again in a moment.';
    case 'corrupt':
      return 'The project’s version history is damaged, so the version could not be saved.';
    case 'timeout':
    case 'busy':
      return 'Saving the version took too long. Try again in a moment.';
    default:
      return 'The version could not be saved to the project’s version history.';
  }
}

/** Make the repository if need be, and write the tree of `files` and a commit of it on the branch's tip, moving nothing. */
export async function writeVersionCommit(repo: GitRepository, files: FileInput[], id: string, time: string, auto: boolean): Promise<{ commit: Oid; tree: Oid }> {
  await repo.init();
  const tip = await repo.resolveRef(VERSIONS_BRANCH);
  const tree = await repo.writeFiles(files);
  const who = appIdentity(time);
  const commit = await repo.writeCommit({ tree, parents: tip ? [tip] : [], author: who, committer: who, message: commitMessage(id, auto) });
  return { commit, tree };
}

/**
 * Put `commit` at the tip of the versions branch, from the tip it was written on. When another save moved the branch
 * meanwhile, the same tree is committed again on top of that one, a few times at most; a move whose outcome is unknown
 * (the worker went down) is looked at again. Gives back the commit now at the tip, which holds that tree.
 */
export async function advanceVersions(repo: GitRepository, commit: Oid): Promise<Oid> {
  const { tree, parents, author, committer, message } = await repo.readCommit(commit);
  let info: CommitInput = { tree, parents, author, committer, message };
  let next = commit;
  for (let tries = 0; ; tries++) {
    const expected = info.parents[0] ?? null;
    try {
      await repo.advanceRef(VERSIONS_BRANCH, next, expected);
      return next;
    } catch (e) {
      if (e instanceof GitError && e.code === 'outcome-unknown' && (await repo.resolveRef(VERSIONS_BRANCH).catch(() => null)) === next) return next;
      if (!(e instanceof GitError) || e.code !== 'conflict' || tries >= 2) throw e;
      info = { ...info, parents: e.actual ? [e.actual] : [] };
      next = await repo.writeCommit(info);
    }
  }
}

/** The bytes the repository takes on disk, every file under it counted (links are not followed); 0 when there is none. */
export async function repositoryBytes(project: string): Promise<number> {
  // Each folder on the way looked at itself: a `.siteorigin` that is a link may lead to another project's history.
  const parts = VERSIONS_GITDIR.split('/');
  for (let i = 1; i <= parts.length; i++) if (!(await lstat(join(project, ...parts.slice(0, i))).catch(() => null))?.isDirectory()) return 0;
  const top = join(project, ...parts);
  let total = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const s = await lstat(join(dir, name)).catch(() => null);
      if (s?.isDirectory()) {
        if (depth < 8) await walk(join(dir, name), depth + 1);
      } else if (s?.isFile()) total += s.size;
    }
  };
  await walk(top, 0);
  return total;
}
