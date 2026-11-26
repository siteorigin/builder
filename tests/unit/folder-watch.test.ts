/**
 * Watching a project folder and everything in it (issue 859). On Linux Node builds a recursive watch in JavaScript and
 * throws some failures from inside its own callbacks, crashing the main process; the app's own tree of watches must
 * turn every failure into something it handles. The tree is used by default on Linux and asked for elsewhere, so these
 * run on every platform, and on Linux against the default.
 */
import fs, { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchTree, type FolderWatch } from '../../src/main/folder-watch';

const TREE = process.platform === 'linux' ? {} : { tree: true };
/**
 * Windows will not rename a folder while anything inside it is held open, as the tree's watch of each folder below it
 * is (the watch of the folder itself does not stop it, nor does the native watch, which holds only the watched folder).
 * So there a folder a test moves holds no folder of its own: what is moved is watched, but nothing within it.
 */
const DEEP = process.platform === 'win32' ? '' : 'deep';
const dirs: string[] = [];
const watches: FolderWatch[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const w of watches.splice(0)) w.close();
  for (const d of dirs.splice(0)) {
    // A test may leave a folder that cannot be read: it is made removable again first.
    for (const locked of [d, join(d, 'locked')]) {
      try {
        fs.chmodSync(locked, 0o700);
      } catch {
        /* not made by this test */
      }
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function temp() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'so-watch-')));
  dirs.push(d);
  return d;
}

/** A watch of `dir` that records what it reports and the errors it ends with. */
function start(dir: string, options: { tree?: boolean } = TREE) {
  const events: Array<string | null> = [];
  const errors: NodeJS.ErrnoException[] = [];
  const w = watchTree(dir, (_event, file) => void events.push(file), options);
  w.on('error', (e: NodeJS.ErrnoException) => void errors.push(e));
  watches.push(w);
  return { w, events, errors };
}

/**
 * A watch just started may not report yet (macOS starts its events a moment later), and what happens before then is
 * never told. So a file is touched until the watch reports it.
 */
async function untilWatching(dir: string, events: Array<string | null>) {
  let touched = 0;
  await vi.waitFor(
    () => {
      if (!events.includes('probe.txt')) {
        if (Date.now() - touched > 500) (touched = Date.now()), writeFileSync(join(dir, 'probe.txt'), String(touched));
        throw new Error('The watch has not reported yet.');
      }
    },
    { timeout: 15_000, interval: 50 }
  );
}

/** `file` (relative to the watched folder) is reported, written again until it is. */
async function reported(events: Array<string | null>, dir: string, file: string) {
  let wrote = 0;
  await vi.waitFor(
    () => {
      if (!events.includes(file)) {
        if (Date.now() - wrote > 500) (wrote = Date.now()), writeFileSync(join(dir, file), String(wrote));
        throw new Error(`${file} was not reported.`);
      }
    },
    { timeout: 15_000, interval: 50 }
  );
}

const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

describe('watching a folder and everything in it', { timeout: 30_000 }, () => {
  it('watches natively where the platform watches a tree, and builds its own tree elsewhere', () => {
    const dir = temp();
    const w = watchTree(dir, () => undefined);
    watches.push(w);
    expect(w.constructor.name === 'TreeWatch').toBe(!(process.platform === 'darwin' || process.platform === 'win32'));
  });

  it('throws, as fs.watch does, when the folder itself cannot be watched', () => {
    const dir = temp();
    expect(() => watchTree(join(dir, 'missing'), () => undefined, TREE)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    writeFileSync(join(dir, 'file'), '');
    expect(() => watchTree(join(dir, 'file'), () => undefined, TREE)).toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
  });

  it('reports changes in nested folders by their path within the watched folder', async () => {
    const dir = temp();
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    const { events, errors } = start(dir);
    await untilWatching(dir, events);
    // What was there when it started is not reported as new (macOS also tells of changes made just before a watch began).
    if (process.platform === 'linux') expect(events.filter((e) => e !== 'probe.txt')).toEqual([]);
    await reported(events, dir, join('a', 'b', 'page.json'));
    expect(errors).toEqual([]);
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('reports changes in nested folders through the native watch', async () => {
    const dir = temp();
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    const { events, errors } = start(dir, {});
    await untilWatching(dir, events);
    await reported(events, dir, join('a', 'b', 'page.json'));
    expect(errors).toEqual([]);
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('leaves a folder with folders in it free to be moved under the native watch', async () => {
    // Windows will not rename a folder while anything inside it is held open: the native watch holds only the folder
    // watched, so the folders of an open project can still be moved there.
    const dir = temp();
    const outside = temp();
    mkdirSync(join(dir, 'sub', 'deep'), { recursive: true });
    mkdirSync(join(outside, 'other', 'deep'), { recursive: true });
    const { events, errors } = start(dir, {});
    await untilWatching(dir, events);
    await reported(events, dir, join('sub', 'deep', 'seen.txt'));
    renameSync(join(dir, 'sub'), join(outside, 'aside'));
    renameSync(join(outside, 'other'), join(dir, 'sub'));
    await reported(events, dir, join('sub', 'deep', 'later.txt'));
    expect(errors).toEqual([]);
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('tells of the folder itself removed through the native watch a few times, not without end', async () => {
    const dir = join(temp(), 'watched');
    mkdirSync(join(dir, 'a'), { recursive: true });
    const { w, events, errors } = start(dir, {});
    const closed = vi.fn();
    w.on('close', closed);
    await untilWatching(dir, events);
    const seen = events.length;
    rmSync(dir, { recursive: true });
    await settle(1000);
    // Windows tells of it by its full path, and again many thousands of times a second until the watch is closed.
    expect(events.length - seen).toBeLessThan(20);
    expect(events.filter((e) => e && isAbsolute(e))).toEqual([]);
    if (process.platform === 'win32') {
      // As the tree tells of it: once, under an empty name, ending the watch.
      expect(events.slice(seen).filter((e) => e === '')).toHaveLength(1);
      expect(closed).toHaveBeenCalledTimes(1);
    }
    expect(errors).toEqual([]);
  });

  it('watches a folder made after it started, and reports what the folder already held', async () => {
    const dir = temp();
    const { events, errors } = start(dir);
    await untilWatching(dir, events);
    // Filled before its watch can have begun.
    mkdirSync(join(dir, 'new', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'new', 'early.txt'), '');
    writeFileSync(join(dir, 'new', 'deep', 'early.txt'), '');
    await vi.waitFor(() => expect(events).toEqual(expect.arrayContaining([join('new', 'early.txt'), join('new', 'deep', 'early.txt')])), { timeout: 15_000 });
    await reported(events, dir, join('new', 'deep', 'later.txt'));
    expect(errors).toEqual([]);
  });

  it('forgets a folder that is removed, and watches one put back in its place', async () => {
    const dir = temp();
    mkdirSync(join(dir, 'a'));
    const { events, errors } = start(dir);
    await untilWatching(dir, events);
    rmSync(join(dir, 'a'), { recursive: true });
    await vi.waitFor(() => expect(events).toContain('a'), { timeout: 15_000 });
    mkdirSync(join(dir, 'a'));
    await reported(events, dir, join('a', 'back.txt'));
    renameSync(join(dir, 'a'), join(dir, 'b'));
    await reported(events, dir, join('b', 'moved.txt'));
    expect(errors).toEqual([]);
  });

  it('watches a filled folder moved in place of a watched one, not the one moved away', async () => {
    const dir = temp();
    const outside = temp();
    // Both hold a deep/, so a watch of the old one's left behind would pass for the new one's.
    mkdirSync(join(dir, 'sub', DEEP), { recursive: true });
    mkdirSync(join(outside, 'other', DEEP), { recursive: true });
    writeFileSync(join(outside, 'other', 'held.txt'), '');
    const { events, errors } = start(dir);
    await untilWatching(dir, events);
    await reported(events, dir, join('sub', 'seen.txt'));
    // Both before either move is told.
    renameSync(join(dir, 'sub'), join(outside, 'aside'));
    renameSync(join(outside, 'other'), join(dir, 'sub'));
    await vi.waitFor(() => expect(events).toContain(join('sub', 'held.txt')), { timeout: 15_000 });
    await reported(events, dir, join('sub', DEEP, 'later.txt'));
    // The folder moved away is no longer watched as sub/.
    const seen = events.length;
    writeFileSync(join(outside, 'aside', 'gone.txt'), '');
    writeFileSync(join(outside, 'aside', DEEP, 'gone.txt'), '');
    await settle();
    expect(events.slice(seen)).not.toContain(join('sub', 'gone.txt'));
    expect(events.slice(seen)).not.toContain(join('sub', DEEP, 'gone.txt'));
    expect(errors).toEqual([]);
  });

  it('still watches a folder moved away and back many times before any of it is told', async () => {
    const dir = temp();
    const outside = temp();
    mkdirSync(join(dir, 'sub', DEEP), { recursive: true });
    const { events, errors } = start(dir);
    await untilWatching(dir, events);
    await reported(events, dir, join('sub', DEEP, 'seen.txt'));
    for (let i = 0; i < 20; i++) {
      renameSync(join(dir, 'sub'), join(outside, 'aside'));
      renameSync(join(outside, 'aside'), join(dir, 'sub'));
    }
    await settle();
    await reported(events, dir, join('sub', DEEP, 'later.txt'));
    await reported(events, dir, join('sub', 'later.txt'));
    expect(errors).toEqual([]);
  });

  it.for([
    ['removed', (dir: string) => rmSync(dir, { recursive: true })],
    // The old one is kept, under another name, so the new one cannot be given its number.
    ['replaced by another folder', (dir: string) => (renameSync(dir, `${dir}-old`), mkdirSync(dir))]
  ] as const)('reports the folder itself %s under an empty name, and ends without an error', async ([name, change], { skip }) => {
    // Windows tells a folder's own watch nothing of the folder being renamed (the watch follows it to its new name), so
    // no tree of watches can see it replaced there; the app watches natively on Windows, not with the tree.
    if (process.platform === 'win32' && name !== 'removed') skip();
    const dir = join(temp(), 'watched');
    mkdirSync(join(dir, 'a'), { recursive: true });
    const { w, events, errors } = start(dir);
    const closed = vi.fn();
    w.on('close', closed);
    await untilWatching(dir, events);
    change(dir);
    await vi.waitFor(() => expect(events).toContain(''), { timeout: 15_000 });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  it('keeps running when a folder is replaced by a file while its events are still queued (ENOTDIR)', async () => {
    const dir = temp();
    mkdirSync(join(dir, 'sub'));
    const watch = fs.watch;
    const closes = new Map<string, ReturnType<typeof vi.spyOn>>();
    vi.spyOn(fs, 'watch').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      const w = (watch as (...args: unknown[]) => fs.FSWatcher)(path, ...rest);
      closes.set(String(path), vi.spyOn(w, 'close'));
      return w;
    }) as typeof fs.watch);
    const { events, errors } = start(dir);
    await untilWatching(dir, events);
    await reported(events, dir, join('sub', 'seen.txt'));
    // All at once, before any of the events they cause is handled: by then sub/fresh.txt is under a file.
    writeFileSync(join(dir, 'sub', 'fresh.txt'), '');
    mkdirSync(join(dir, 'sub', 'inner'));
    rmSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub'), 'now a file');
    await settle();
    // Still watching, nothing thrown, and no error: a folder that went is not a failure. Its watch is let go.
    await reported(events, dir, 'after.txt');
    await vi.waitFor(() => expect(closes.get(join(dir, 'sub'))).toHaveBeenCalled(), { timeout: 15_000 });
    expect(errors).toEqual([]);
  });

  it('reads a folder by name when its typed listing fails on an entry that just went', async () => {
    const dir = temp();
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'file.txt'), '');
    const readdir = fs.readdirSync;
    let failed = 0;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((path: fs.PathLike, options?: unknown) => {
      // As Node fails a typed listing where the file system does not say what an entry is and one just went.
      if (String(path) === dir && (options as { withFileTypes?: boolean } | undefined)?.withFileTypes && !failed++) throw Object.assign(new Error('ENOENT: no such file or directory, lstat'), { code: 'ENOENT' });
      return (readdir as (...args: unknown[]) => unknown)(path, options);
    }) as typeof fs.readdirSync);
    const { events, errors } = start(dir);
    expect(failed).toBe(1);
    await untilWatching(dir, events);
    await reported(events, dir, join('a', 'x.txt'));
    expect(errors).toEqual([]);
  });

  it('ends with one error and every watch closed when no watch is left for a new folder (ENOSPC)', async () => {
    const dir = temp();
    mkdirSync(join(dir, 'old'));
    const watch = fs.watch;
    const closes: Array<ReturnType<typeof vi.spyOn>> = [];
    vi.spyOn(fs, 'watch').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      if (String(path) === join(dir, 'full')) throw Object.assign(new Error(`ENOSPC: System limit for number of file watchers reached, watch '${String(path)}'`), { code: 'ENOSPC', syscall: 'watch' });
      const w = (watch as (...args: unknown[]) => fs.FSWatcher)(path, ...rest);
      closes.push(vi.spyOn(w, 'close'));
      return w;
    }) as typeof fs.watch);
    const { w, events, errors } = start(dir);
    const closed = vi.fn();
    w.on('close', closed);
    await untilWatching(dir, events);
    mkdirSync(join(dir, 'full'));
    await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 15_000 });
    expect(errors[0].code).toBe('ENOSPC');
    expect(closed).toHaveBeenCalledTimes(1);
    for (const close of closes) expect(close).toHaveBeenCalled();
    // Nothing is reported once it has ended, and it ends once.
    const seen = events.length;
    writeFileSync(join(dir, 'old', 'later.txt'), '');
    await settle();
    expect(events).toHaveLength(seen);
    expect(errors).toHaveLength(1);
  });

  it('ends with one error, after it is returned, when no watch is left for a folder it starts with (ENOSPC)', async () => {
    const dir = temp();
    mkdirSync(join(dir, 'old', 'full'), { recursive: true });
    const watch = fs.watch;
    vi.spyOn(fs, 'watch').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      if (String(path) === join(dir, 'old', 'full')) throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' });
      return (watch as (...args: unknown[]) => fs.FSWatcher)(path, ...rest);
    }) as typeof fs.watch);
    const { errors } = start(dir);
    expect(errors).toEqual([]);
    await vi.waitFor(() => expect(errors.map((e) => e.code)).toEqual(['ENOSPC']));
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('ends with an error when a folder in it cannot be read (EACCES)', async () => {
    const dir = temp();
    const { events, errors } = start(dir);
    await untilWatching(dir, events);
    mkdirSync(join(dir, 'locked'), { mode: 0 });
    await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 15_000 });
    expect(errors[0].code).toBe('EACCES');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('ends with an error when a watched folder becomes unreadable (EACCES)', async () => {
    const dir = temp();
    mkdirSync(join(dir, 'locked'));
    const { events, errors } = start(dir);
    await untilWatching(dir, events);
    fs.chmodSync(join(dir, 'locked'), 0);
    // A folder made beside it makes the tree be read again, wherever a permission change is not told.
    mkdirSync(join(dir, 'nudge'));
    await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 15_000 });
    expect(errors[0].code).toBe('EACCES');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('ends with an error when the watched folder itself becomes unreadable (EACCES)', async () => {
    const dir = temp();
    mkdirSync(join(dir, 'a'));
    const { events, errors } = start(dir);
    await untilWatching(dir, events);
    // Still searchable and writable, but its list of files cannot be read.
    fs.chmodSync(dir, 0o300);
    await vi.waitFor(() => expect(errors.map((e) => e.code)).toEqual(['EACCES']), { timeout: 15_000 });
  });

  it('opens no watch once a listener closed it while being told of a new folder', async () => {
    const dir = temp();
    const watch = fs.watch;
    const made: Array<ReturnType<typeof vi.spyOn>> = [];
    vi.spyOn(fs, 'watch').mockImplementation(((...args: unknown[]) => {
      const w = (watch as (...a: unknown[]) => fs.FSWatcher)(...args);
      made.push(vi.spyOn(w, 'close'));
      return w;
    }) as typeof fs.watch);
    const events: Array<string | null> = [];
    const w = watchTree(dir, (_e, file) => {
      events.push(file);
      if (file === 'new') w.close();
    }, TREE);
    watches.push(w);
    await untilWatching(dir, events);
    mkdirSync(join(dir, 'new', 'deep'), { recursive: true });
    await vi.waitFor(() => expect(events).toContain('new'), { timeout: 15_000 });
    await settle();
    for (const close of made) expect(close).toHaveBeenCalled();
  });

  it('reports nothing once closed, and can be closed again', async () => {
    const dir = temp();
    mkdirSync(join(dir, 'a'));
    const { w, events, errors } = start(dir);
    const closed = vi.fn();
    w.on('close', closed);
    await untilWatching(dir, events);
    w.close();
    w.close();
    expect(closed).toHaveBeenCalledTimes(1);
    const seen = events.length;
    writeFileSync(join(dir, 'a', 'x.txt'), '');
    mkdirSync(join(dir, 'b'));
    await settle();
    expect(events).toHaveLength(seen);
    expect(errors).toEqual([]);
  });
});
