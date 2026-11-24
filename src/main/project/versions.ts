/**
 * Saved versions (issue 260): named copies of the whole site that outlive the rolling undo history. Each one holds
 * every canonical document and the media files they name, by content, in a store of its own under
 * .siteorigin/versions/. Nothing in it is shared with the history blobs or with static/assets/, so neither the history
 * sweep nor the asset sweep (of this release or an older one) can take anything a version needs, and a file changed in
 * place since is still held as it was.
 */
import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, ensureDir, removeDurable, sha, syncDir, toJson } from './fsutil';
import { isCanonicalPath } from './documents';

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
 * Public files a version never holds: those the generator writes from the documents (robots.txt, the sitemap), whose
 * owner would change if a restore put a copy back, and private files no export carries (as src/main/export.ts).
 */
const GENERATED_STATIC = new Set(['static/robots.txt', 'static/sitemap.xml']);
const PRIVATE_NAME = /^(\.env(\..*)?|\.npmrc|\.netrc|\.git-credentials|id_rsa.*|id_ed25519.*|id_ecdsa.*|id_dsa.*|.*\.(pem|key|p12|pfx|ppk|keystore|jks|asc|gpg))$/i;
export function heldAsMedia(path: string): boolean {
  return isVersionMedia(path) && !GENERATED_STATIC.has(path) && !PRIVATE_NAME.test(path.slice(path.lastIndexOf('/') + 1));
}
const OBJECT_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^v[a-z0-9]{6,40}$/;
/** A copy left by a save that stopped part way is removed once it is this old. */
const LEFTOVER_MS = 10 * 60_000;

export const VERSIONS_UNREADABLE = 'The list of saved versions could not be read, so versions can’t be saved or deleted. It was left as it is.';
export const VERSIONS_NEWER = 'The saved versions were made by a newer version of SiteOrigin Builder. Update the app to use them.';
export const VERSION_DAMAGED = 'Part of this saved version is missing or damaged, so it can’t be restored.';

export interface SavedVersion {
  id: string;
  name: string;
  /** When it was saved (ISO time). */
  time: string;
  /** The project revision it was saved at. */
  revision: number;
  /** The document format the project was in when it was saved. */
  schemaVersion: number;
  /** Made by the app before a restore, as the way back to the work that restore replaced. */
  auto?: boolean;
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
}

interface VersionsFile {
  format: number;
  versions: SavedVersion[];
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
  if (!record(v.docs) || !record(v.media)) return false;
  if (!Object.entries(v.docs).every(([p, h]) => isCanonicalPath(p) && typeof h === 'string' && OBJECT_RE.test(h))) return false;
  if (v.filled !== undefined && (!record(v.filled) || !Object.entries(v.filled).every(([p, h]) => isVersionMedia(p) && typeof h === 'string' && OBJECT_RE.test(h)))) return false;
  return Object.entries(v.media).every(([p, h]) => isVersionMedia(p) && (h === null || (typeof h === 'string' && OBJECT_RE.test(h))));
}

/** Every object a version needs. */
export function objectsOf(v: SavedVersion): Set<string> {
  return new Set([...Object.values(v.docs), ...Object.values(v.media).filter((h): h is string => !!h)]);
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
  versions: SavedVersion[] = [];
  /** Why the list can't be changed: it is unreadable, or from a newer app. Nothing is saved, deleted or collected. */
  problem: string | null = null;
  /** The size of every stored object, by hash. */
  private sizes = new Map<string, number>();
  /** Objects whose bytes were checked against their hash (or written) since the store was loaded: reused as they are. */
  private verified = new Set<string>();

  constructor(readonly root: string) {}

  private get indexPath() {
    return join(this.root, 'versions.json');
  }
  /** Written while a restore puts files back and saves its documents, so a restore that stopped part way is told. */
  private get restoringPath() {
    return join(this.root, 'restoring.json');
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
        else this.versions = file.versions;
      } catch {
        this.problem = VERSIONS_UNREADABLE;
      }
    }
    this.sizes.clear();
    this.verified.clear();
    for (const name of await fs.readdir(this.objectDir).catch(() => [] as string[])) {
      if (!OBJECT_RE.test(name)) continue;
      const st = await fs.stat(join(this.objectDir, name)).catch(() => null);
      if (st?.isFile()) this.sizes.set(name, st.size);
    }
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
    const ok = await fs.readFile(this.objectPath(h)).then((b) => sha(b) === h, () => false);
    if (ok) this.verified.add(h);
    return ok;
  }

  /** Store `buf` (if not already stored) and return its hash. */
  async putBuffer(buf: Buffer): Promise<string> {
    const h = sha(buf);
    if (await this.has(h, buf.length)) return h;
    await atomicWrite(this.objectPath(h), buf);
    this.sizes.set(h, buf.length);
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
    const h = sha(buf);
    if (await this.has(h, buf.length)) return h;
    await ensureDir(this.objectDir);
    const tmp = join(this.objectDir, `.${randomBytes(6).toString('hex')}.tmp`);
    try {
      let cloned = false;
      try {
        await fs.copyFile(abs, tmp, constants.COPYFILE_FICLONE_FORCE);
        cloned = sha(await fs.readFile(tmp)) === h;
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
      await fs.rename(tmp, this.objectPath(h));
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
    await syncDir(this.objectDir);
    this.sizes.set(h, buf.length);
    this.verified.add(h);
    return h;
  }

  /** An object's bytes, checked against its hash. */
  async read(h: string): Promise<Buffer> {
    let buf: Buffer;
    try {
      buf = await fs.readFile(this.objectPath(h));
    } catch {
      throw new Error(VERSION_DAMAGED);
    }
    if (sha(buf) !== h) throw new Error(VERSION_DAMAGED);
    return buf;
  }

  /** Replace the index with `next`, durably, then use it. */
  async publish(next: SavedVersion[]): Promise<void> {
    if (this.problem) throw new Error(this.problem);
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
  }

  /** Note that a restore of `version` is under way, with the version holding the work it replaces. */
  async markRestoring(version: string, backup: string): Promise<void> {
    await atomicWrite(this.restoringPath, toJson({ version, backup, time: new Date().toISOString() }));
  }

  async clearRestoring(): Promise<void> {
    await removeDurable(this.restoringPath);
  }

  /** A restore that stopped part way, if one did: its names, once. */
  async takeRestoring(): Promise<{ version: string; backup: string } | null> {
    let text: string;
    try {
      text = await fs.readFile(this.restoringPath, 'utf8');
    } catch {
      return null;
    }
    await removeDurable(this.restoringPath);
    try {
      const r = JSON.parse(text) as { version?: unknown; backup?: unknown };
      return { version: typeof r.version === 'string' ? r.version : 'a saved version', backup: typeof r.backup === 'string' ? r.backup : 'Before restoring' };
    } catch {
      return { version: 'a saved version', backup: 'Before restoring' };
    }
  }

  /**
   * Delete objects no version names, and copies left by a save that stopped part way. Returns the bytes freed. Never
   * runs while the index is unreadable: what it names is unknown then.
   */
  async collect(): Promise<number> {
    if (this.problem) return 0;
    const keep = new Set(this.versions.flatMap((v) => [...objectsOf(v)]));
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
        this.verified.delete(name);
      } else if (name.endsWith('.tmp')) {
        const st = await fs.stat(path).catch(() => null);
        if (st && Date.now() - st.mtimeMs >= LEFTOVER_MS) await fs.rm(path, { force: true }).catch(() => undefined);
      }
    }
    return freed;
  }

  /** The bytes every version together holds, each object counted once. */
  totalBytes(): number {
    const all = new Set(this.versions.flatMap((v) => [...objectsOf(v)]));
    let n = 0;
    for (const h of all) n += this.sizes.get(h) ?? 0;
    return n;
  }

  /** The bytes deleting `v` would free: the objects no other version holds. */
  exclusiveBytes(v: SavedVersion): number {
    const others = new Set(this.versions.filter((x) => x.id !== v.id).flatMap((x) => [...objectsOf(x)]));
    let n = 0;
    for (const h of objectsOf(v)) if (!others.has(h)) n += this.sizes.get(h) ?? 0;
    return n;
  }
}
