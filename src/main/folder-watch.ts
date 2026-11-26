import { EventEmitter } from 'node:events';
import fs, { type FSWatcher } from 'node:fs';
import { join, relative, sep } from 'node:path';

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

/**
 * One non-recursive watch per folder of the tree. A folder that appears is watched and read, and what is already in it
 * reported, since it may have filled before its watch began; one that goes is forgotten with everything below it.
 * Anything else that goes wrong (no inotify watches left, a folder that cannot be read) closes the whole watch and is
 * reported once as its `error`: what it would miss from then on is not known.
 */
class TreeWatch extends EventEmitter implements FolderWatch {
  /** Every watched folder, by absolute path, with the identity of the folder it watches. */
  private readonly folders = new Map<string, { watcher: FSWatcher; ino: number }>();
  private closed = false;

  constructor(
    private readonly root: string,
    private readonly listener: FolderListener
  ) {
    super();
    // The folder itself must be watchable: its failure is thrown to the caller, as fs.watch throws it.
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) throw Object.assign(new Error(`ENOTDIR: not a directory, watch '${root}'`), { code: 'ENOTDIR', path: root });
    this.folders.set(root, { watcher: this.watchOne(root), ino: stat.ino });
    this.guard(() => this.scan(root, false));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
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
    this.close();
    // Told later, so a failure in the first scan reaches the error handler the caller adds after this returns.
    process.nextTick(() => {
      if (this.listenerCount('error')) this.emit('error', e);
    });
  }

  private watchOne(dir: string): FSWatcher {
    const watcher = fs.watch(dir, (event, name) => this.guard(() => this.onEvent(dir, event, name === null ? null : String(name))));
    // A folder's own watch failing is its going, when it has gone, and otherwise the end of the watch.
    watcher.on('error', (e) => this.guard(() => (this.stillThere(dir) ? this.fail(e) : this.forget(dir))));
    return watcher;
  }

  private onEvent(dir: string, event: string, name: string | null) {
    if (this.closed || !this.folders.has(dir)) return;
    if (name === null) {
      // Something in this folder changed, but not what: read it again.
      this.report(event, dir === this.root ? null : dir);
      this.recheck(dir);
      return;
    }
    const path = join(dir, name);
    this.report(event, path);
    this.recheck(path);
    // The folder's own going is told under its own name, not as the folder: so it is looked for itself.
    if (dir === this.root && this.folders.has(this.root) && !this.stillThere(this.root)) this.recheck(this.root);
  }

  /** Bring the watches for `path` up to date with what it is now: a new folder is watched, a gone one forgotten. */
  private recheck(path: string) {
    let stat: fs.Stats | null;
    try {
      stat = fs.lstatSync(path);
    } catch (e) {
      if (!isGone(e)) throw e;
      stat = null;
    }
    if (!stat?.isDirectory()) {
      this.forget(path);
      // As Node reports a watched folder going: under the folder's own (empty) relative name.
      if (path === this.root) this.report('rename', path);
      return;
    }
    const known = this.folders.get(path);
    // The same folder, or one put in its place under the same name.
    if (known && known.ino === stat.ino) {
      this.scan(path, true);
      return;
    }
    if (known) this.forget(path);
    this.add(path, stat.ino, true);
  }

  /** Watch a folder, and everything already in it, reporting what it holds when `report` is set. */
  private add(dir: string, ino: number, report: boolean) {
    let watcher: FSWatcher;
    try {
      watcher = this.watchOne(dir);
    } catch (e) {
      // Gone again already: its parent's watch tells of that.
      if (isGone(e)) return;
      throw e;
    }
    this.folders.set(dir, { watcher, ino });
    this.scan(dir, report);
    if (report) this.reportFiles(dir);
  }

  /** Watch the subfolders of `dir` not watched yet, reporting what is in each one found when `report` is set. */
  private scan(dir: string, report: boolean) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (!isGone(e)) throw e;
      this.forget(dir);
      return;
    }
    for (const entry of entries) {
      if (this.closed || !this.folders.has(dir)) return;
      const path = join(dir, entry.name);
      if (!entry.isDirectory() || this.folders.has(path)) continue;
      let ino: number;
      try {
        ino = fs.lstatSync(path).ino;
      } catch (e) {
        if (!isGone(e)) throw e;
        continue;
      }
      if (report) this.report('rename', path);
      this.add(path, ino, report);
    }
  }

  /** Report the files of a folder that filled before its watch began (its subfolders report their own as they are added). */
  private reportFiles(dir: string) {
    if (!this.folders.has(dir)) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (isGone(e)) return;
      throw e;
    }
    for (const entry of entries) if (!entry.isDirectory()) this.report('rename', join(dir, entry.name));
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

  private stillThere(dir: string) {
    try {
      return fs.lstatSync(dir).isDirectory();
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
