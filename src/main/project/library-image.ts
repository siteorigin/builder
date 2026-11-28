/**
 * Reading a library image for what Assets asks about the picture it shows: what private metadata it carries, and what
 * a web-sized copy of it would be (#1046). Both are asked together, so both share one read and one pass over its
 * metadata; a large JPEG or PNG, the pictures a copy is weighed for, is read in the media worker instead, so the
 * editor's main process never holds it, and what it says is answered as soon as the worker has read it, before its copy
 * is made. The small answers are remembered under the file's stat once it has settled (statTrusted), so showing the
 * picture again reads nothing; any write to the file, or another file in its place, changes the stat.
 */
import { constants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { WebCopyPlan } from '@shared/api';
import type { AssetRecord } from '@shared/types';
import { sha } from './fsutil';
import { cleanPhoto, type PhotoCredits, type PhotoMetadata } from './photo-metadata';
import { stampOf, statTrusted } from './stable-read';
import { countMediaRead } from '../perf';

/** The largest library file read for its metadata: well past the importer's 25 MB limit. */
export const MAX_LIBRARY_FILE = 64 * 1024 * 1024;
const LIBRARY_FILE = /^static\/assets\/[^/\\]+$/;
/** How many pictures' answers are remembered: a library's worth of browsing, each under a hundred bytes. */
const KEEP = 256;
/** How many times a file that changes while it is read is read again before it is given up on. */
const TRIES = 3;

/** What a library image's bytes say, without the bytes. */
export interface LibraryImageFacts {
  /** Their SHA-256. */
  hash: string;
  /** What private metadata they carry; null when they cannot be read as a picture (cleanPhoto). */
  metadata: PhotoMetadata | null;
  /** Their credits, as a web-sized copy of them carries them (undefined when cleanPhoto could not read them). */
  credits: PhotoCredits | undefined;
}

/** What is remembered of a picture: what Assets asks, never its credits, which only weighing a copy needs. */
export type RememberedFacts = Pick<LibraryImageFacts, 'hash' | 'metadata'>;

/**
 * Whether a handle's stat and a path's name the same file. Only compared where the two are taken the same way (everywhere
 * but Windows, where they can differ in form): there the handle opened without following a link stands for the path.
 */
export const sameFile = (handle: { dev: bigint; ino: bigint }, path: { dev: bigint; ino: bigint }) => process.platform === 'win32' || (handle.dev === path.dev && handle.ino === path.ino);

/** Whether the record names a file a library image can be read from: an image directly in static/assets/. */
export const isLibraryImageFile = (a: AssetRecord) => a.kind === 'image' && LIBRARY_FILE.test(a.file) && !a.file.includes('..');

/** Opened without waiting and without following a link, so a pipe or a link put there is never read. */
export const LIBRARY_OPEN = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * A library image's bytes, read at the path looked at as `looked`: exactly the size its handle says, and only while the
 * path and the file stay as they were. 'changed' when either changed meanwhile (the file grew, was written, or another
 * was put in its place); null when it is no regular file at most MAX_LIBRARY_FILE long, or cannot be read. `counted` is
 * told how many bytes were read.
 */
export async function readLibraryFile(path: string, looked: BigIntStats, counted: (bytes: number) => void = () => undefined): Promise<Buffer | 'changed' | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(path, LIBRARY_OPEN);
  } catch {
    return null;
  }
  try {
    const st = await handle.stat({ bigint: true });
    if (!st.isFile() || st.size > BigInt(MAX_LIBRARY_FILE)) return null;
    if (!sameFile(st, looked)) return 'changed';
    // Never more than the size it had: one byte past it says it grew.
    const size = Number(st.size);
    const bytes = Buffer.allocUnsafe(size + 1);
    let got = 0;
    try {
      for (;;) {
        const { bytesRead } = await handle.read(bytes, got, bytes.length - got, got);
        if (!bytesRead) break;
        got += bytesRead;
        if (got > size) return 'changed';
      }
    } finally {
      // Every byte read counts, a read that is thrown away included.
      counted(got);
    }
    if (got !== size || stampOf(await handle.stat({ bigint: true })) !== stampOf(st)) return 'changed';
    const there = await fs.lstat(path, { bigint: true }).catch(() => null);
    if (!there || stampOf(there) !== stampOf(looked)) return 'changed';
    return bytes.subarray(0, size);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * A library image's file looked at in the media worker (assets.ts inspectLibraryImage): what it says, the stat of its path
 * as the worker looked at it, and what a web-sized copy of it would be. `early` is told what it says as soon as that is
 * known, before the copy is made.
 */
export type RemoteLook = (path: string, a: AssetRecord, early: (facts: LibraryImageFacts, stamp: string) => void) => Promise<{ facts: LibraryImageFacts; stamp: string; plan: WebCopyPlan } | null>;

/** The pictures read in the media worker: those Assets weighs a web-sized copy of (larger than this, as JPEG or PNG). */
const WORKER_BYTES = 1_500_000;

/** A look in the media worker: what the file says as soon as that is known, and once the copy is weighed, its plan. */
interface Look {
  facts: Promise<LibraryImageFacts | null>;
  done: Promise<{ facts: LibraryImageFacts; plan: WebCopyPlan } | null>;
}

export class LibraryImageReader {
  /** Reads under way, by path: a second question while one is read takes the same bytes. */
  private reading = new Map<string, Promise<{ facts: LibraryImageFacts; bytes: Buffer } | null>>();
  /** Looks under way in the media worker, by path and the record's picture: the two questions share one. */
  private looking = new Map<string, Look>();
  /** Answers by path, with the stat the file had when it was read, kept only for a read made once it had settled. */
  private known = new Map<string, RememberedFacts & { stamp: string }>();

  /**
   * `settleMs`: how long a file must have been left alone before its stat can stand for its bytes (the session's).
   * `remote`: how a large JPEG or PNG is looked at in the media worker; without it every picture is read here.
   */
  constructor(
    private readonly settleMs: () => number,
    private readonly remote?: RemoteLook
  ) {}

  /** Whether the picture is read in the media worker rather than here: a large JPEG or PNG, as its record says. */
  viaWorker(a: AssetRecord): boolean {
    return !!this.remote && isLibraryImageFile(a) && a.bytes > WORKER_BYTES && (a.mime === 'image/jpeg' || a.mime === 'image/png');
  }

  /**
   * What the library image's file says now: remembered while the file shows the stat it was read under, otherwise read.
   * Null when it is not a regular file directly in static/assets/, is implausibly large, or cannot be read.
   */
  async facts(root: string, a: AssetRecord): Promise<RememberedFacts | null> {
    const known = await this.remembered(root, a);
    if (known) return known;
    // A worker that failed is no reason to leave the question unanswered: the file is read here then.
    if (this.viaWorker(a)) {
      const looked = await (await this.look(root, a)).facts;
      if (looked) return looked;
    }
    return (await this.read(root, a))?.facts ?? null;
  }

  /** What was remembered of the file, while its path shows the very stat it was read under; null otherwise. Reads nothing. */
  async remembered(root: string, a: AssetRecord): Promise<RememberedFacts | null> {
    if (!isLibraryImageFile(a)) return null;
    const path = join(root, a.file);
    const was = this.known.get(path);
    if (!was) return null;
    const st = await fs.lstat(path, { bigint: true }).catch(() => null);
    if (st?.isFile() && stampOf(st) === was.stamp && this.known.get(path) === was) return { hash: was.hash, metadata: was.metadata };
    if (this.known.get(path) === was) this.known.delete(path);
    return null;
  }

  /** The library image's bytes and what they say, read now (or by a read already under way); null as for `facts`. */
  read(root: string, a: AssetRecord): Promise<{ facts: LibraryImageFacts; bytes: Buffer } | null> {
    if (!isLibraryImageFile(a)) return Promise.resolve(null);
    const path = join(root, a.file);
    let r = this.reading.get(path);
    if (!r) {
      r = this.readNow(path).finally(() => this.reading.delete(path));
      this.reading.set(path, r);
    }
    return r;
  }

  /**
   * The picture looked at in the media worker (viaWorker), or a look at it under way: what its file says, and what a
   * web-sized copy of it would be, as libraryWebCopyPlan answers for its bytes. Each null when it is not a regular file
   * directly in static/assets/, the file read there is not the one looked at here, or the worker failed.
   */
  async look(root: string, a: AssetRecord): Promise<Look> {
    const none: Look = { facts: Promise.resolve(null), done: Promise.resolve(null) };
    if (!this.remote || !isLibraryImageFile(a)) return none;
    const path = join(root, a.file);
    const started = Date.now();
    const looked = await fs.lstat(path, { bigint: true }).catch(() => null);
    if (!looked?.isFile() || looked.size > BigInt(MAX_LIBRARY_FILE)) return none;
    // Joined only while the path shows the stat it had when that look began: a file replaced since is looked at anew.
    const key = `${path}\0${a.mime}\0${a.hash}\0${stampOf(looked)}`;
    let r = this.looking.get(key);
    if (!r) {
      r = this.lookNow(path, a, this.remote, looked, started);
      const mine = r;
      void r.done.finally(() => this.looking.get(key) === mine && this.looking.delete(key));
      this.looking.set(key, r);
    }
    return r;
  }

  private lookNow(path: string, a: AssetRecord, remote: RemoteLook, looked: BigIntStats, started: number): Look {
    let tell!: (f: LibraryImageFacts | null) => void;
    const facts = new Promise<LibraryImageFacts | null>((resolve) => (tell = resolve));
    const done = (async () => {
      try {
        // The worker read the very file looked at here, not one put in its place meanwhile: its look at the path (taken
        // as this one is) names the same file. Remembered only when the file had settled and stayed as it was looked at.
        const accept = async (f: LibraryImageFacts, stamp: string) => {
          const [dev, ino] = stamp.split(':');
          if (dev !== String(looked.dev) || ino !== String(looked.ino)) return false;
          const there = await fs.lstat(path, { bigint: true }).catch(() => null);
          this.remember(path, f, statTrusted(looked, started, this.settleMs()) && stamp === stampOf(looked) && !!there && stampOf(there) === stampOf(looked) ? stampOf(looked) : null);
          return true;
        };
        const r = await remote(path, a, (f, stamp) => void accept(f, stamp).then((ok) => ok && tell(f), () => undefined));
        if (!r || !(await accept(r.facts, r.stamp))) return null;
        return { facts: r.facts, plan: r.plan };
      } catch {
        return null;
      }
    })();
    // A worker that answered all at once, or not at all: what the file says comes with the rest.
    void done.then((d) => tell(d?.facts ?? null));
    return { facts, done };
  }

  private async readNow(path: string): Promise<{ facts: LibraryImageFacts; bytes: Buffer } | null> {
    for (let attempt = 0; attempt < TRIES; attempt++) {
      try {
        const started = Date.now();
        const looked = await fs.lstat(path, { bigint: true });
        if (!looked.isFile() || looked.size > BigInt(MAX_LIBRARY_FILE)) return null;
        const bytes = await readLibraryFile(path, looked, countMediaRead);
        if (bytes === 'changed') continue;
        if (!bytes) return null;
        const cleaned = cleanPhoto(bytes);
        const facts: LibraryImageFacts = { hash: sha(bytes), metadata: cleaned && { location: cleaned.location, device: cleaned.device }, credits: cleaned?.credits };
        this.remember(path, facts, statTrusted(looked, started, this.settleMs()) ? stampOf(looked) : null);
        return { facts, bytes };
      } catch {
        return null;
      }
    }
    // Changing under every read: someone else is writing it.
    return null;
  }

  /** Keep what a read found under the file's stat, or (with no stat to trust) forget what was kept. */
  private remember(path: string, facts: RememberedFacts, stamp: string | null) {
    this.known.delete(path);
    if (stamp === null) return;
    this.known.set(path, { hash: facts.hash, metadata: facts.metadata, stamp });
    for (const k of this.known.keys()) if (this.known.size > KEEP) this.known.delete(k);
  }
}
