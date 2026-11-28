/**
 * Saved versions (issue 260): named copies of the whole site that outlive the rolling undo history. Each one holds
 * every canonical document and the media files they name, by content, in a store of its own under
 * .siteorigin/versions/. Nothing in it is shared with the history blobs or with static/assets/, so neither the history
 * sweep nor the asset sweep (of this release or an older one) can take anything a version needs, and a file changed in
 * place since is still held as it was.
 */
import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { atomicWrite, ensureDir, removeDurable, renameReplacing, sha, syncDir, toJson } from './fsutil';
import { countMediaRead } from '../perf';
import { isCanonicalPath } from './documents';
import { SITE_ICON_FILES } from '@shared/site-icons';
import { isPrivateFileName } from './private-files';
import { GitError, OID_RE, VERSIONS_BRANCH } from '../git/protocol';
import { advanceVersions, gitSaveProblem, keptOutOfGit, repositoryBytes, versionsGit } from './versions-git';
import { GENERATED_MANIFEST } from './snapshot-inventory';

/** The format of versions.json. A newer one is left alone: nothing is saved, deleted or collected. */
export const VERSIONS_FORMAT = 1;
/** The longest name a version can have. */
export const VERSION_NAME_MAX = 80;
/** A media file a version can hold: a public file of the site, anywhere under static/, by a plain relative path. */
export function isVersionMedia(path: string): boolean {
  const parts = path.split('/');
  return parts.length >= 2 && parts[0] === 'static' && parts.slice(1).every((p) => p !== '' && p !== '.' && p !== '..' && !/[\\\0]/.test(p));
}
/**
 * Public files a version never holds: those the generator writes from the documents (robots.txt, the sitemap, the
 * llms.txt files, the RSS feed, the web app manifest and the home-screen icons made from the favicon), whose owner
 * would change if a restore put a copy back, and private files no export carries (as src/main/export.ts). The Markdown
 * copies of pages are at addresses of their own; the session leaves them out as it does every file its generated
 * manifest claims.
 */
const GENERATED_STATIC = new Set(['static/robots.txt', 'static/sitemap.xml', 'static/llms.txt', 'static/llms-full.txt', 'static/rss.xml', 'static/_redirects', ...SITE_ICON_FILES.map((f) => `static/${f}`)]);
export function heldAsMedia(path: string): boolean {
  return isVersionMedia(path) && !GENERATED_STATIC.has(path) && !isPrivateFileName(path.slice(path.lastIndexOf('/') + 1));
}
/** The files a generator's record (siteorigin/generated-manifest.json) claims as its output, written or being written. */
export function claimedFiles(text: string | null | undefined): string[] {
  if (!text) return [];
  try {
    const record = JSON.parse(text) as { files?: unknown; pending?: unknown } | null;
    const paths = (r: unknown) => (r && typeof r === 'object' && !Array.isArray(r) ? Object.keys(r) : []);
    return [...paths(record?.files), ...paths(record?.pending)];
  } catch {
    return [];
  }
}
const OBJECT_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^v[a-z0-9]{6,40}$/;
/** A record of a version that could not be recorded, set aside (VersionStore.recordPending). */
const UNRECORDED_RE = /^unrecorded-v[a-z0-9]{6,40}\.json$/;
/** A record that could not be read, set aside: what it names is unknown. */
const UNREADABLE_RECORDING_RE = /^unreadable-recording-\d+\.json$/;
/** A copy left by a save that stopped part way is removed once it is this old. */
const LEFTOVER_MS = 10 * 60_000;

export const VERSIONS_UNREADABLE = 'The list of saved versions could not be read, so versions can’t be saved or deleted. It was left as it is.';
export const VERSIONS_NEWER = 'The saved versions were made by a newer version of SiteOrigin Builder. Update the app to use them.';
export const VERSION_DAMAGED = 'Part of this saved version is missing or damaged, so it can’t be restored.';
export const VERSIONS_LINKED = 'The saved versions folder in .siteorigin is a link rather than a folder of its own, so versions can’t be saved there.';

export interface SavedVersion {
  id: string;
  name: string;
  /** When it was saved (ISO time). */
  time: string;
  /** The project revision it was saved at. */
  revision: number;
  /** The document format the project was in when it was saved. */
  schemaVersion: number;
  /**
   * Made by the app, not the author: before a restore, as the way back to the work that restore replaced, or with
   * `restored`, after one.
   */
  auto?: boolean;
  /** With `auto`: the site as a restore left it, saved after it with Git snapshots on (#1155). */
  restored?: boolean;
  /** Each canonical document, by project-relative path: the object holding it. */
  docs: Record<string, string>;
  /** Each media file, by project-relative path: the object holding it, or null when the documents name a file that
   *  was missing when the version was saved. */
  media: Record<string, string | null>;
  /**
   * For a version saved before a restore: the files that restore put where none were, by what it put there. Restoring
   * this version leaves them (Undo of that restore still needs them), and says so while they still hold exactly that.
   */
  filled?: Record<string, string>;
  /**
   * A version saved with Git snapshots on (#1153): the commit on the project's versions branch, and the tree of the
   * whole site it holds. Its documents and media are read from that tree by path and checked against the hashes above,
   * but for what is kept out of Git as objects of this store: external sources' settings and converters (keptOutOfGit),
   * and `outside`, the media the site names that a snapshot leaves out by their name or place (a private name, a file
   * of a nested repository). Absent: every file is an object of this store.
   */
  git?: { commit: string; tree: string; outside?: string[] };
}

interface VersionsFile {
  format: number;
  versions: SavedVersion[];
}

/**
 * The version of a restore being recorded (#1155): with Git snapshots on, the site as a restore left it is committed
 * on the versions branch's tip, this written, and only then the branch moved and the row listed. Whatever stops part
 * way, the next attempt (reopening, or the next version saved) finds where it got to and finishes it: it never commits
 * again, so nothing is recorded twice.
 */
export interface PendingVersion {
  /** The restore's own ID: its row's. */
  op: string;
  /** The version that was restored, and the one holding the work it replaced, by name: what the author is told. */
  version: string;
  backup: string;
  /** The tip the row's commit was written on (its parent), which the branch moves from; null when there was none. */
  expected: string | null;
  /** The row to list once the branch is at its commit. */
  row: SavedVersion;
}

/**
 * Where recording a pending version got to. `recorded`: listed (or nothing was pending). `pending`: the branch or the
 * list could not be written just now (`reason`), and it is tried again. `moved`: the branch is at neither the commit
 * it was written on nor its own, so it was left as it is, and the record set aside. `unreadable`: the record itself.
 */
export type PendingOutcome =
  | { state: 'recorded'; op?: string }
  | { state: 'pending'; op: string; version: string; backup: string; reason: string }
  | { state: 'moved'; op: string; version: string; backup: string }
  | { state: 'unreadable'; retry?: boolean };

function validPending(p: unknown): p is PendingVersion {
  if (!record(p) || typeof p.op !== 'string' || !ID_RE.test(p.op)) return false;
  if (typeof p.version !== 'string' || typeof p.backup !== 'string') return false;
  if (p.expected !== null && (typeof p.expected !== 'string' || !OID_RE.test(p.expected))) return false;
  return validVersion(p.row) && p.row.id === p.op && p.row.restored === true && !!p.row.git;
}

export const newVersionId = () => `v${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function validVersion(v: unknown): v is SavedVersion {
  if (!record(v)) return false;
  if (typeof v.id !== 'string' || !ID_RE.test(v.id)) return false;
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 200) return false;
  if (typeof v.time !== 'string' || Number.isNaN(Date.parse(v.time))) return false;
  if (!Number.isInteger(v.revision) || !Number.isInteger(v.schemaVersion)) return false;
  if (v.auto !== undefined && typeof v.auto !== 'boolean') return false;
  if (v.restored !== undefined && (v.restored !== true || v.auto !== true || !record(v.git))) return false;
  if (!record(v.docs) || !record(v.media)) return false;
  if (!Object.entries(v.docs).every(([p, h]) => isCanonicalPath(p) && typeof h === 'string' && OBJECT_RE.test(h))) return false;
  if (v.filled !== undefined && (!record(v.filled) || !Object.entries(v.filled).every(([p, h]) => isVersionMedia(p) && typeof h === 'string' && OBJECT_RE.test(h)))) return false;
  if (v.git !== undefined && (!record(v.git) || typeof v.git.commit !== 'string' || !OID_RE.test(v.git.commit) || typeof v.git.tree !== 'string' || !OID_RE.test(v.git.tree))) return false;
  if (v.git?.outside !== undefined && (!Array.isArray(v.git.outside) || !v.git.outside.every((p) => typeof p === 'string' && isVersionMedia(p)))) return false;
  return Object.entries(v.media).every(([p, h]) => isVersionMedia(p) && (h === null || (typeof h === 'string' && OBJECT_RE.test(h))));
}

/** Every object a version needs. */
export function objectsOf(v: SavedVersion): Set<string> {
  return new Set([...Object.values(v.docs), ...Object.values(v.media).filter((h): h is string => !!h)]);
}

/** Whether the file at `path` of `v` is an object of this store, rather than in its commit. */
export const heldHere = (v: SavedVersion, path: string): boolean => !v.git || keptOutOfGit(path) || !!v.git.outside?.includes(path);

/** The objects of this store a version needs: all of them, or for one in Git only what is kept out of it. */
export function localObjectsOf(v: SavedVersion): Set<string> {
  if (!v.git) return objectsOf(v);
  const files = [...Object.entries(v.docs), ...Object.entries(v.media)];
  return new Set(files.filter((e): e is [string, string] => !!e[1] && heldHere(v, e[0])).map(([, h]) => h));
}

/** Whether two versions hold exactly the same documents and media, and record the same files filled. */
export function sameContents(a: Pick<SavedVersion, 'docs' | 'media' | 'filled'>, b: Pick<SavedVersion, 'docs' | 'media' | 'filled'>): boolean {
  const key = (m: Record<string, string | null> = {}) => JSON.stringify(Object.entries(m).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  return key(a.docs) === key(b.docs) && key(a.media) === key(b.media) && key(a.filled) === key(b.filled);
}

/**
 * The saved versions of one project: an index (versions.json) and content-addressed objects. Objects are written and
 * flushed before the index that names them, so a save that stops part way leaves only objects nothing names, which
 * the next collection removes.
 */
export class VersionStore {
  /** The list, newest last. Always replaced whole (publish, load), never changed in place: what is worked out from it is kept by its identity. */
  versions: readonly SavedVersion[] = [];
  /** Why the list can't be changed: it is unreadable, or from a newer app. Nothing is saved, deleted or collected. */
  problem: string | null = null;
  /**
   * Whether the project has a list of its own: one was read, or written since. A project without one has never had a
   * version saved (the starting version is saved then, #1156); one whose versions were all deleted still has its list.
   */
  listed = false;
  /** Versions captured and not yet listed (an export's, until it is delivered): collection keeps what they hold. */
  private held = new Set<SavedVersion>();
  /** The size of every stored object, by hash. */
  private sizes = new Map<string, number>();
  /** Counts the changes to `sizes`, so what is worked out from them is known to be current. */
  private sized = 0;
  /** The bytes of `usage`, for the list and sizes they were worked out from. */
  private used: { versions: readonly SavedVersion[]; sized: number; total: number; exclusive: Map<SavedVersion, number> | null } | null = null;
  /** Changes whenever an object's size does: with the list and its problem, all the sizes shown depend on. */
  get sizesChanged(): number {
    return this.sized;
  }
  /** Objects whose bytes were checked against their hash (or written) since the store was loaded: reused as they are. */
  private verified = new Set<string>();

  /** What the project's versions repository takes on disk, as last measured (load, and each version saved to it). */
  private gitBytes = 0;

  /** `root` is `.siteorigin/versions` of the project in `project`. */
  constructor(
    readonly root: string,
    readonly project: string
  ) {}

  private get indexPath() {
    return join(this.root, 'versions.json');
  }
  /** Written while a restore puts files back and saves its documents, so a restore that stopped part way is told. */
  private get restoringPath() {
    return join(this.root, 'restoring.json');
  }
  /** Written while the version a restore left is recorded in Git (PendingVersion). */
  private get pendingPath() {
    return join(this.root, 'recording.json');
  }
  private get objectDir() {
    return join(this.root, 'objects');
  }
  private objectPath(h: string) {
    if (!OBJECT_RE.test(h)) throw new Error(VERSION_DAMAGED);
    return join(this.objectDir, h);
  }

  /** Read the index. Only a missing one means no versions; anything unreadable is left alone and reported. */
  async load(): Promise<void> {
    this.versions = [];
    this.problem = null;
    this.listed = false;
    let text: string | null = null;
    try {
      text = await fs.readFile(this.indexPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.problem = VERSIONS_UNREADABLE;
    }
    if (text !== null) {
      try {
        const file = JSON.parse(text) as Partial<VersionsFile>;
        const ids = new Set(Array.isArray(file?.versions) ? file.versions.map((v) => (record(v) ? v.id : null)) : []);
        if (Number.isInteger(file?.format) && file.format! > VERSIONS_FORMAT) this.problem = VERSIONS_NEWER;
        else if (file?.format !== VERSIONS_FORMAT || !Array.isArray(file.versions) || !file.versions.every(validVersion) || ids.size !== file.versions.length) this.problem = VERSIONS_UNREADABLE;
        else {
          this.versions = file.versions;
          this.listed = true;
        }
      } catch {
        this.problem = VERSIONS_UNREADABLE;
      }
    }
    this.sizes.clear();
    this.sized++;
    this.verified.clear();
    for (const name of await fs.readdir(this.objectDir).catch(() => [] as string[])) {
      if (!OBJECT_RE.test(name)) continue;
      const st = await fs.stat(join(this.objectDir, name)).catch(() => null);
      if (st?.isFile()) {
        this.sizes.set(name, st.size);
        this.sized++;
      }
    }
    await this.measureGit();
  }

  /** Measure the versions repository again (once a capture has written to it): only looked at, never made. */
  async measureGit(): Promise<void> {
    const bytes = await repositoryBytes(this.project).catch(() => this.gitBytes);
    if (bytes !== this.gitBytes) {
      this.gitBytes = bytes;
      this.sized++;
    }
  }

  /** The versions repository, for a version in Git. */
  private repository() {
    const git = versionsGit();
    if (!git) throw new Error(VERSION_DAMAGED);
    return git.repository(this.project);
  }

  /**
   * The bytes `v` holds for the file at `path`, whose hash it records as `h`: from its commit when it is in Git (but for
   * what is kept out of it), otherwise this store's object. Checked against the hash either way, so a damaged or missing
   * object, or a repository that is not there, is never taken for the file.
   */
  async readFile(v: SavedVersion, path: string, h: string): Promise<Buffer> {
    if (!v.git || heldHere(v, path)) return this.read(h);
    let buf: Buffer;
    try {
      const repo = this.repository();
      // Nothing is made to read a version: a repository that is not there is a version that can't be restored.
      if (!(await repo.exists())) throw new Error(VERSION_DAMAGED);
      buf = Buffer.from(await repo.readBlob(v.git.commit, path));
    } catch {
      throw new Error(VERSION_DAMAGED);
    }
    if (sha(buf) !== h) throw new Error(VERSION_DAMAGED);
    return buf;
  }

  /** Whether `v`, a version in Git, reads back as holding `tree`: its commit there, whole, and naming that tree. */
  async holdsTree(v: SavedVersion, tree: string): Promise<boolean> {
    if (!v.git) return false;
    try {
      return (await this.repository().readCommit(v.git.commit)).tree === tree;
    } catch {
      return false;
    }
  }

  /**
   * What `v`, a version in Git, holds outside siteorigin/ (the documents' folder): each file of its tree by its project
   * path, with Git's name for its bytes and its mode, and the files its generator's record (siteorigin/
   * generated-manifest.json, the one file read) claims as generated output. Nothing else is read (#1396). A tree that
   * can't be read whole, or a repository that is not there, is a damaged version.
   */
  async gitFiles(v: SavedVersion): Promise<{ files: Map<string, { oid: string; mode: string }>; generated: string[] }> {
    if (!v.git) throw new Error(VERSION_DAMAGED);
    const files = new Map<string, { oid: string; mode: string }>();
    let manifest: Uint8Array | null = null;
    try {
      const repo = this.repository();
      if (!(await repo.exists())) throw new Error(VERSION_DAMAGED);
      const walk = async (tree: string, prefix: string): Promise<void> => {
        for (const e of await repo.readTree(tree)) {
          const path = `${prefix}${e.path}`;
          if (e.type === 'blob') files.set(path, { oid: e.oid, mode: e.mode });
          else if (e.type !== 'tree') continue;
          else if (path !== 'siteorigin') await walk(e.oid, `${path}/`);
          else {
            const record = (await repo.readTree(e.oid)).find((x) => `siteorigin/${x.path}` === GENERATED_MANIFEST && x.type === 'blob');
            if (record) manifest = await repo.readBlob(record.oid);
          }
        }
      };
      await walk(v.git.tree, '');
    } catch {
      throw new Error(VERSION_DAMAGED);
    }
    return { files, generated: claimedFiles(manifest && Buffer.from(manifest).toString('utf8')) };
  }

  /**
   * Add `v` to the list. A version in Git is put at the tip of the versions branch first (its commit is written by the
   * capture, the branch moved only now), so the list never names a commit that history does not hold. A move refused or
   * failing adds nothing. Gives back the row as listed (its commit made again if another save moved the branch). The
   * repository is measured again only once the list is written, so nothing slow comes between the move and the list.
   */
  async add(v: SavedVersion): Promise<SavedVersion> {
    if (this.problem) throw new Error(this.problem);
    let row = v;
    try {
      if (v.git) {
        try {
          const commit = await advanceVersions(this.repository(), v.git.commit);
          if (commit !== v.git.commit) row = { ...v, git: { ...v.git, commit } };
        } catch (e) {
          throw new Error(e instanceof GitError ? gitSaveProblem(e) : (e as Error).message);
        }
      }
      await this.publish([...this.versions, row]);
    } finally {
      // After the list, whatever happened: a commit made again on another save's may be there, listed or not.
      if (v.git) await this.measureGit();
    }
    return row;
  }

  /**
   * Whether the object is stored whole and unchanged: a copy cut short or damaged is written again rather than reused,
   * so a new version never leans on bytes that would fail its restore. Each object is read once per opening.
   */
  private async has(h: string, bytes: number): Promise<boolean> {
    if (!this.sizes.has(h)) return false;
    const st = await fs.stat(this.objectPath(h)).catch(() => null);
    if (!st?.isFile() || st.size !== bytes) return false;
    if (this.verified.has(h)) return true;
    const ok = await fs.readFile(this.objectPath(h)).then((b) => (countMediaRead(b.length), sha(b) === h), () => false);
    if (ok) this.verified.add(h);
    return ok;
  }

  /**
   * Refuse to write when a folder of this store is not one of its own: a link there could lead anywhere, the project's
   * own `.git` included. Looked at before a version is captured and before the list is written.
   */
  async checkFolders(objects = true): Promise<void> {
    for (const dir of [join(this.root, '..'), this.root, ...(objects ? [this.objectDir] : [])]) {
      const st = await fs.lstat(dir).catch(() => null);
      if (st && !st.isDirectory()) throw new Error(VERSIONS_LINKED);
    }
  }

  /** Store `buf` (if not already stored) and return its hash. */
  async putBuffer(buf: Buffer): Promise<string> {
    const h = sha(buf);
    if (await this.has(h, buf.length)) return h;
    await atomicWrite(this.objectPath(h), buf);
    this.sizes.set(h, buf.length);
    this.sized++;
    this.verified.add(h);
    return h;
  }

  putText(content: string): Promise<string> {
    return this.putBuffer(Buffer.from(content, 'utf8'));
  }

  /**
   * Store the file at `abs` and return its hash. Where the disk supports it the object is a copy-on-write clone of the
   * file, which takes no space until one of them changes; it is kept only when it holds exactly the bytes that were
   * read and hashed, and otherwise those bytes are written instead.
   */
  async putFile(abs: string): Promise<string> {
    const buf = await fs.readFile(abs);
    countMediaRead(buf.length);
    const h = sha(buf);
    if (await this.has(h, buf.length)) return h;
    await ensureDir(this.objectDir);
    const tmp = join(this.objectDir, `.${randomBytes(6).toString('hex')}.tmp`);
    try {
      let cloned = false;
      try {
        await fs.copyFile(abs, tmp, constants.COPYFILE_FICLONE_FORCE);
        const copy = await fs.readFile(tmp);
        countMediaRead(copy.length);
        cloned = sha(copy) === h;
      } catch {
        cloned = false;
      }
      if (!cloned) {
        await fs.rm(tmp, { force: true });
        await fs.writeFile(tmp, buf, { flag: 'wx' });
      }
      const handle = await fs.open(tmp, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameReplacing(tmp, this.objectPath(h));
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
    await syncDir(this.objectDir);
    this.sizes.set(h, buf.length);
    this.sized++;
    this.verified.add(h);
    return h;
  }

  /** An object's bytes, checked against its hash. */
  async read(h: string): Promise<Buffer> {
    let buf: Buffer;
    try {
      buf = await fs.readFile(this.objectPath(h));
      countMediaRead(buf.length);
    } catch {
      throw new Error(VERSION_DAMAGED);
    }
    if (sha(buf) !== h) throw new Error(VERSION_DAMAGED);
    return buf;
  }

  /** Replace the index with `next`, durably, then use it. */
  async publish(next: SavedVersion[]): Promise<void> {
    if (this.problem) throw new Error(this.problem);
    // The list's own folders: renaming or deleting writes no object.
    await this.checkFolders(false);
    try {
      await atomicWrite(this.indexPath, toJson({ format: VERSIONS_FORMAT, versions: next } satisfies VersionsFile));
    } catch (e) {
      // The new list may be on disk even so (only flushing its folder failed): whatever is there is what counts, so a
      // collection never takes what it names.
      await this.load().catch(() => {
        this.problem = VERSIONS_UNREADABLE;
      });
      throw e;
    }
    this.versions = next;
    this.listed = true;
  }

  /** Keep what `v`, captured and not yet listed, holds through any collection until the function given back is called. */
  hold(v: SavedVersion): () => void {
    this.held.add(v);
    return () => void this.held.delete(v);
  }

  /**
   * A listed version that holds exactly what `v` does, newest first (or with `oldest`, oldest first: a restore's way
   * back), if there is one (and, with `name`, only one the app saved by that name, never the author's namesake): in the
   * store `v` was saved to, and with Git snapshots on, of the whole site, its tree the same and its commit still there to
   * read. Then it stands for `v`, which need not be listed beside it.
   */
  async sameAs(v: SavedVersion, name?: string, oldest = false): Promise<SavedVersion | undefined> {
    for (const x of oldest ? this.versions : [...this.versions].reverse()) {
      if ((name !== undefined && (x.name !== name || !x.auto)) || !sameContents(x, v) || (v.git ? x.git?.tree !== v.git.tree : !!x.git)) continue;
      if (v.git && !(await this.holdsTree(x, v.git.tree))) continue;
      return x;
    }
    return undefined;
  }

  /**
   * Note that a restore of `version` is under way, with the version holding the work it replaces, and `op`, the ID of
   * the version recording what it leaves when there is to be one (#1155). A note left by an earlier restore that could
   * not be fully undone is kept as it is (and true returned), so reopening still tells of it.
   */
  async markRestoring(version: string, backup: string, op?: string): Promise<boolean> {
    if (await fs.lstat(this.restoringPath).then(() => true, () => false)) return true;
    await atomicWrite(this.restoringPath, toJson({ version, backup, time: new Date().toISOString(), ...(op ? { op } : {}) }));
    return false;
  }

  /**
   * Note that the restore of `version` put everything back, and only the version recording what it left is still to
   * be made: a stop now is told as that, not as a restore that may have left something out.
   */
  async settleRestoring(version: string, backup: string, op: string): Promise<void> {
    await atomicWrite(this.restoringPath, toJson({ version, backup, time: new Date().toISOString(), op, settled: true }));
  }

  async clearRestoring(): Promise<void> {
    await removeDurable(this.restoringPath);
  }

  /**
   * A restore that stopped part way, if one did: its names, once, and with `settled` one that had put everything back
   * and stopped before the version recording it (`op`) was noted.
   */
  async takeRestoring(): Promise<{ version: string; backup: string; op?: string; settled?: boolean } | null> {
    let text: string;
    try {
      text = await fs.readFile(this.restoringPath, 'utf8');
    } catch {
      return null;
    }
    await removeDurable(this.restoringPath);
    try {
      const r = JSON.parse(text) as { version?: unknown; backup?: unknown; op?: unknown; settled?: unknown };
      return {
        version: typeof r.version === 'string' ? r.version : 'a saved version',
        backup: typeof r.backup === 'string' ? r.backup : 'Before restoring',
        ...(typeof r.op === 'string' ? { op: r.op } : {}),
        ...(r.settled === true ? { settled: true } : {})
      };
    } catch {
      return { version: 'a saved version', backup: 'Before restoring' };
    }
  }

  /**
   * The version being recorded, as written; null when there is none, 'unreadable' when what is there is not one,
   * 'failed' when it could not be read just now.
   */
  async readPending(): Promise<PendingVersion | 'unreadable' | 'failed' | null> {
    let text: string;
    try {
      text = await fs.readFile(this.pendingPath, 'utf8');
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'failed';
    }
    try {
      const p = JSON.parse(text) as unknown;
      return validPending(p) ? p : 'unreadable';
    } catch {
      return 'unreadable';
    }
  }

  /** Note the version a restore left before the branch is moved to it: from here a stop is finished, not repeated. */
  async writePending(p: PendingVersion): Promise<void> {
    if (this.problem) throw new Error(this.problem);
    await this.checkFolders(false);
    await atomicWrite(this.pendingPath, toJson(p));
  }

  /** Forget the version being recorded: listed, or never to be. */
  async clearPending(): Promise<void> {
    await removeDurable(this.pendingPath);
  }

  /**
   * Finish recording the version a restore left, wherever that stopped: with the branch already at its commit, only
   * the row is listed; at the commit it was written on, the branch is moved first, from there only. A branch anywhere
   * else was moved by something else meanwhile: neither it nor the commit is touched, and the record is set aside
   * (`unrecorded-<op>.json`) with what it holds. Never commits, so a version is never recorded twice.
   */
  async recordPending(): Promise<PendingOutcome> {
    const p = await this.readPending();
    if (p === null) return { state: 'recorded' };
    // Left where it is, to be read again: collect() keeps everything meanwhile, and nothing goes past it.
    if (p === 'failed') return { state: 'unreadable', retry: true };
    // A folder of the store swapped for a link may lead to another project's record: nothing there is touched.
    try {
      await this.checkFolders(false);
    } catch (e) {
      return p === 'unreadable' ? { state: 'unreadable' } : { state: 'pending', op: p.op, version: p.version, backup: p.backup, reason: (e as Error).message };
    }
    if (p === 'unreadable') {
      // Kept, out of the way, so it is told of once and never stands in the way of the versions saved after it.
      await renameReplacing(this.pendingPath, join(this.root, `unreadable-recording-${Date.now()}.json`)).catch(() => undefined);
      return { state: 'unreadable' };
    }
    const { version, backup, row } = p;
    const pending = (reason: string): PendingOutcome => ({ state: 'pending', op: p.op, version, backup, reason });
    if (this.problem) return pending(this.problem);
    const target = row.git!.commit;
    // Listed already: only the record was left behind.
    if (!this.versions.some((v) => v.id === row.id)) {
      try {
        const repo = this.repository();
        let tip = await repo.resolveRef(VERSIONS_BRANCH);
        if (tip !== target) {
          if (tip !== p.expected) return await this.setPendingAside(p);
          // Only the commit the record names, whole and on the commit the branch is at, is put there. One that can't be
          // read just now (the worker busy or gone) is tried again; only one not there, or damaged, is set aside.
          const c = await repo.readCommit(target).catch((e: unknown) => (e instanceof GitError && ['not-found', 'corrupt', 'invalid'].includes(e.code) ? null : Promise.reject(e)));
          if (!c || c.tree !== row.git!.tree || c.parents.length !== (p.expected ? 1 : 0) || (p.expected && c.parents[0] !== p.expected)) return await this.setPendingAside(p);
          try {
            await repo.advanceRef(VERSIONS_BRANCH, target, p.expected);
          } catch (e) {
            if (!(e instanceof GitError) || !['outcome-unknown', 'conflict'].includes(e.code)) throw e;
            // Where it is now decides, as it would have on reopening.
            tip = await repo.resolveRef(VERSIONS_BRANCH);
            if (tip !== target) return tip === p.expected ? pending(gitSaveProblem(e)) : await this.setPendingAside(p);
          }
        }
        // In the order versions were saved, ahead of any saved meanwhile (to the plain store, with Git snapshots off).
        const at = this.versions.findIndex((v) => v.time > row.time);
        await this.publish(at < 0 ? [...this.versions, row] : [...this.versions.slice(0, at), row, ...this.versions.slice(at)]);
      } catch (e) {
        return pending(e instanceof GitError ? gitSaveProblem(e) : (e as Error).message);
      } finally {
        await this.measureGit();
      }
    }
    // Listed: whatever happens to the record now, the next attempt finds the row and only removes it.
    await this.clearPending().catch(() => undefined);
    return { state: 'recorded', op: p.op };
  }

  /**
   * Before version `id` is deleted from the list: a record of it left behind once it was listed (its removal failed)
   * is removed first, so it can never list the version again.
   */
  async forgetPending(id: string): Promise<void> {
    await this.checkFolders(false);
    const p = await this.readPending();
    if (p === 'failed') throw new Error('The version still being saved after a restore could not be read just now. Try again in a moment.');
    if (p !== null && p !== 'unreadable' && p.op === id) await this.clearPending();
  }

  /** Flush the folder of the version being recorded again, once writing it reported that flushing failed. */
  async flushPending(): Promise<void> {
    await syncDir(this.root);
  }

  /** Keep a record that can't be finished beside the list, out of the way, and say so. */
  private async setPendingAside(p: PendingVersion): Promise<PendingOutcome> {
    await renameReplacing(this.pendingPath, join(this.root, `unrecorded-${p.op}.json`));
    await syncDir(this.root).catch(() => undefined);
    return { state: 'moved', op: p.op, version: p.version, backup: p.backup };
  }

  /**
   * Delete objects no version names, and copies left by a save that stopped part way. Returns the bytes freed. Never
   * runs while the index is unreadable: what it names is unknown then.
   */
  async collect(): Promise<number> {
    if (this.problem) return 0;
    // Only this project's own folders: one swapped for a link may hold another project's versions.
    for (const dir of [this.root, this.objectDir]) if (!(await fs.lstat(dir).catch(() => null))?.isDirectory()) return 0;
    const keep = new Set([...this.versions, ...this.held].flatMap((v) => [...localObjectsOf(v)]));
    // A version still being recorded, or one set aside, holds what it holds until it is listed: a record that can't be
    // read might name anything, so nothing is collected while there is one.
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch {
      return 0;
    }
    if (names.some((n) => UNREADABLE_RECORDING_RE.test(n))) return 0;
    for (const name of [basename(this.pendingPath), ...names.filter((n) => UNRECORDED_RE.test(n))]) {
      let text: string;
      try {
        text = await fs.readFile(join(this.root, name), 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        return 0;
      }
      let p: unknown;
      try {
        p = JSON.parse(text);
      } catch {
        return 0;
      }
      if (!validPending(p)) return 0;
      for (const h of localObjectsOf(p.row)) keep.add(h);
    }
    let freed = 0;
    for (const name of await fs.readdir(this.objectDir).catch(() => [] as string[])) {
      const path = join(this.objectDir, name);
      if (OBJECT_RE.test(name)) {
        if (keep.has(name)) continue;
        const bytes = (await fs.stat(path).catch(() => null))?.size ?? 0;
        try {
          await fs.rm(path);
          freed += bytes;
        } catch {
          continue;
        }
        this.sizes.delete(name);
        this.sized++;
        this.verified.delete(name);
      } else if (name.endsWith('.tmp')) {
        const st = await fs.stat(path).catch(() => null);
        if (st && Date.now() - st.mtimeMs >= LEFTOVER_MS) await fs.rm(path, { force: true }).catch(() => undefined);
      }
    }
    return freed;
  }

  /** The bytes every version together holds, each object counted once, and the versions repository as a whole. */
  totalBytes(): number {
    return this.usage().total + this.gitBytes;
  }

  /**
   * Of totalBytes, what the versions repository takes: kept for good, since a version deleted from the list stays in
   * the history it is part of. 0 when the project has no repository.
   */
  historyBytes(): number {
    return this.gitBytes;
  }

  /**
   * The bytes deleting `v` would free: the objects no other version holds. Null for a version in Git, whose snapshot
   * stays in the history when it is deleted from the list, so deleting it frees nothing that could be told.
   */
  exclusiveBytes(v: SavedVersion): number | null {
    if (v.git) return null;
    const kept = this.usage().exclusive?.get(v);
    if (kept !== undefined) return kept;
    const others = new Set(this.versions.filter((x) => x.id !== v.id).flatMap((x) => [...localObjectsOf(x)]));
    let n = 0;
    for (const h of objectsOf(v)) if (!others.has(h)) n += this.sizes.get(h) ?? 0;
    return n;
  }

  /**
   * What every version together holds and what each alone holds, in one pass over the versions (an object only one
   * version holds is that version's alone), worked out again only once the list or an object's size changed. With two
   * versions of one ID (an index never holds them) each version's own bytes are left to `exclusiveBytes`.
   */
  private usage() {
    if (this.used?.versions === this.versions && this.used.sized === this.sized) return this.used;
    const holders = new Map<string, number>();
    for (const v of this.versions) for (const h of localObjectsOf(v)) holders.set(h, (holders.get(h) ?? 0) + 1);
    let total = 0;
    for (const h of holders.keys()) total += this.sizes.get(h) ?? 0;
    // By the version itself, so one not in the list (or a copy of one) is worked out on its own.
    let exclusive: Map<SavedVersion, number> | null = new Map();
    const ids = new Set<string>();
    for (const v of this.versions) {
      if (ids.has(v.id)) {
        exclusive = null;
        break;
      }
      ids.add(v.id);
      let n = 0;
      for (const h of localObjectsOf(v)) if (holders.get(h) === 1) n += this.sizes.get(h) ?? 0;
      exclusive.set(v, n);
    }
    return (this.used = { versions: this.versions, sized: this.sized, total, exclusive });
  }
}
