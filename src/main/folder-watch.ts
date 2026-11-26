import { EventEmitter } from 'node:events';
import fs, { type FSWatcher } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

/** A watch of a folder and everything in it. It reports a failure it cannot carry on from as one `error` event. */
export interface FolderWatch extends EventEmitter {
  close(): void;
}

/** Told the event and the changed path relative to the folder; a null path may be about anything in it. */
export type FolderListener = (event: string, file: string | null) => void;

/**
 * Watch a folder and its subfolders. macOS and Windows watch a whole tree natively. Elsewhere (Linux) Node builds the
 * tree in JavaScript and throws some of its failures from inside its own event callbacks, where nothing can catch them
 * (issue 859), so the tree is built here instead, one plain watch per folder, with every failure handled.
 *
 * Throws, like fs.watch, when the folder itself cannot be watched.
 */
export function watchTree(dir: string, listener: FolderListener, options: { tree?: boolean } = {}): FolderWatch {
  const tree = options.tree ?? !(process.platform === 'darwin' || process.platform === 'win32');
  if (!tree) return fs.watch(dir, { recursive: true }, (event, file) => listener(event, file === null ? null : String(file)));
  return new TreeWatch(dir, listener);
}

/** The path, or something on the way to it, is not there (any more): forgotten, not a failure. */
const isGone = (e: unknown) => {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** Failures about a path rather than the system: below a folder that has since been replaced, they are about it. */
const PATH_CODES = new Set(['EACCES', 'EPERM', 'ELOOP']);

/** What a folder is, so one put in place of another under the same name is told apart from it. */
const identity = (stat: fs.Stats) => `${stat.dev}:${stat.ino}`;

/** What a read of a folder reports: nothing (the first look), the subfolders new to the watch, or all it holds. */
type Report = 'quiet' | 'new' | 'all';

/**
 * One non-recursive watch per folder of the tree. A folder that appears is watched and read, and what is already in it
 * reported, since it may have filled before its watch began; one that goes is forgotten with everything below it. The
 * watched folder itself going is reported under an empty name, as Node reports it, and ends the watch. Symbolic links
 * are not followed, as the native watches of macOS and Windows do not follow them.
 * Anything else that goes wrong (no inotify watches left, a folder that cannot be read) closes the whole watch and is
 * reported once as its `error`: what it would miss from then on is not known.
 */
class TreeWatch extends EventEmitter implements FolderWatch {
  /** Every watched folder, by absolute path, with what the folder its watch was made for is. */
  private readonly folders = new Map<string, { watcher: FSWatcher; id: string }>();
  private readonly root: string;
  /** Folders whose own watch said they were moved or removed: watched afresh once the events read with that are handled. */
  private readonly rearm = new Set<string>();
  private closed = false;

  constructor(
    dir: string,
    private readonly listener: FolderListener
  ) {
    super();
    // The folder itself must be watchable: its failure is thrown to the caller, as fs.watch throws it. A link to a
    // folder is watched as the folder it leads to.
    this.root = fs.realpathSync(dir);
    const stat = fs.lstatSync(this.root);
    if (!stat.isDirectory()) throw Object.assign(new Error(`ENOTDIR: not a directory, watch '${dir}'`), { code: 'ENOTDIR', path: dir });
    this.folders.set(this.root, { watcher: this.watchOne(this.root), id: identity(stat) });
    this.guard(() => this.scan(this.root, 'quiet'));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.rearm.clear();
    for (const { watcher } of this.folders.values()) watcher.close();
    this.folders.clear();
    this.emit('close');
  }

  /** Run a step of the watch: whatever it throws ends the watch as its error, never reaching the event loop. */
  private guard(step: () => void) {
    try {
      step();
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown) {
    if (this.closed) return;
    // Told later, so a failure in the first scan reaches the error handler the caller adds once this returns.
    process.nextTick(() => {
      if (this.listenerCount('error')) this.emit('error', e);
    });
    this.close();
  }

  private watchOne(dir: string): FSWatcher {
    // Only the watch now registered for the folder is listened to: one replaced or forgotten may still have events queued.
    const current = () => !this.closed && this.folders.get(dir)?.watcher === watcher;
    const watcher = fs.watch(dir, (event, name) => {
      if (current()) this.guard(() => this.onEvent(dir, event, name === null ? null : String(name)));
    });
    // A folder's own watch failing is its going, when it has gone, and otherwise the end of the watch.
    watcher.on('error', (e) => {
      if (current()) this.guard(() => (this.stillSame(dir) ? this.fail(e) : this.gone(dir)));
    });
    return watcher;
  }

  private onEvent(dir: string, event: string, name: string | null) {
    try {
      if (name === null) {
        // Something in this folder changed, but not what: it is read again.
        this.report(event, dir === this.root ? null : dir);
        this.recheck(dir, false);
        return;
      }
      const path = join(dir, name);
      this.report(event, path);
      this.recheck(path, false);
      // A watched folder's own change is told under its own name, as if about something in it: it is looked at too.
      if (name === basename(dir)) {
        this.recheck(dir, false);
        // Moved or removed, it may be back already, even as a new folder given the old one's number: so its watch, which
        // may now be watching nothing, is made again.
        if (event === 'rename' && dir !== this.root) this.rearmSoon(dir);
      } else if (dir === this.root && !this.stillSame(dir)) this.gone(dir);
    } catch (e) {
      // A failure below a folder that is no longer the one watched (moved, replaced) is its going, not the watch's end.
      if (this.closed || !PATH_CODES.has((e as NodeJS.ErrnoException | null)?.code ?? '') || this.stillSame(dir)) throw e;
      this.gone(dir);
    }
  }

  /** Watch a folder afresh once the events read with this one are handled, once however many asked for it. */
  private rearmSoon(dir: string) {
    if (this.rearm.size === 0) {
      setImmediate(() =>
        this.guard(() => {
          const dirs = [...this.rearm].sort((a, b) => a.length - b.length);
          this.rearm.clear();
          for (const d of dirs) if (this.folders.has(d)) this.recheck(d, true);
        })
      );
    }
    this.rearm.add(dir);
  }

  /** Bring the watches for `path` up to date with what is there now: a new folder is watched, a gone one forgotten. */
  private recheck(path: string, rearm: boolean) {
    if (this.closed) return;
    let stat: fs.Stats | null;
    try {
      stat = fs.lstatSync(path);
    } catch (e) {
      if (!isGone(e)) throw e;
      stat = null;
    }
    const known = this.folders.get(path);
    if (!stat?.isDirectory()) {
      if (known) this.gone(path);
      return;
    }
    if (known?.id === identity(stat) && !rearm) {
      // Read again: it may hold folders whose making was not told, or have become unreadable.
      this.scan(path, 'new');
      return;
    }
    // A different folder in its place (or the root replaced): what was watched there is no longer it.
    if (known && path === this.root) return this.gone(path);
    if (known) this.forget(path);
    this.add(path, identity(stat), 'all');
  }

  /** Watch a folder below the root, and the folders in it. */
  private add(dir: string, id: string, report: Report) {
    // A listener may have closed the watch while it was told of this folder.
    if (this.closed) return;
    let watcher: FSWatcher;
    try {
      watcher = this.watchOne(dir);
    } catch (e) {
      // Gone again already: its parent's watch tells of that.
      if (isGone(e)) return;
      throw e;
    }
    this.folders.set(dir, { watcher, id });
    this.scan(dir, report);
  }

  /** Watch the folders in `dir` not watched yet, reporting what is found as `report` says. */
  private scan(dir: string, report: Report) {
    const entries = this.list(dir);
    if (!entries) return this.gone(dir);
    for (const entry of entries) {
      if (this.closed || !this.folders.has(dir)) return;
      const path = join(dir, entry.name);
      if (!entry.isDirectory()) {
        if (report === 'all') this.report('rename', path);
        continue;
      }
      if (this.folders.has(path)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(path);
      } catch (e) {
        if (!isGone(e)) throw e;
        continue;
      }
      if (!stat.isDirectory()) continue;
      if (report !== 'quiet') this.report('rename', path);
      this.add(path, identity(stat), report === 'quiet' ? 'quiet' : 'all');
    }
  }

  /** What a watched folder holds, or null once it is no longer the folder watched. */
  private list(dir: string): fs.Dirent[] | null {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (!isGone(e)) throw e;
    }
    // Where the file system does not say what each entry is, Node looks, and fails when one just went: so the folder
    // itself is looked at, and read again if it is still there.
    if (!this.stillSame(dir)) return null;
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      // Still there, yet it cannot be read through: what it holds would go unwatched.
      if (!isGone(e) || this.stillSame(dir)) throw e;
      return null;
    }
  }

  /** A watched folder is gone: everything below it is forgotten, and the root going ends the watch. */
  private gone(dir: string) {
    if (dir !== this.root) return this.forget(dir);
    this.report('rename', this.root);
    this.close();
  }

  /** Stop watching a folder and everything below it. */
  private forget(path: string) {
    const below = path + sep;
    for (const [dir, { watcher }] of this.folders) {
      if (dir !== path && !dir.startsWith(below)) continue;
      watcher.close();
      this.folders.delete(dir);
    }
  }

  /** The folder watched at `dir` is still the one there. */
  private stillSame(dir: string) {
    try {
      const stat = fs.lstatSync(dir);
      return stat.isDirectory() && identity(stat) === this.folders.get(dir)?.id;
    } catch (e) {
      if (isGone(e)) return false;
      throw e;
    }
  }

  private report(event: string, path: string | null) {
    if (this.closed) return;
    this.listener(event, path === null ? null : relative(this.root, path));
  }
}
