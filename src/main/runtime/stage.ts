/**
 * Private copies of a project for a preview this app may not write to (spec 16.6, 18.1). A project's own build tools
 * write where they run (node_modules/.vite-temp, node_modules/.vite, .svelte-kit), so a project open read-only is
 * previewed from a copy this app owns: its source, the editor's dev variants and its own copy of the installed tools.
 * Nothing here depends on Electron, so it is unit tested directly.
 */
import { type BigIntStats, existsSync, lstatSync, mkdtempSync, readlinkSync, realpathSync, promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { copyFresh, copyProjectSource, copyTree, type EntryType, inBatches, inProjectSource, isProjectBrief, isSourcesFolder } from '../export';
import { perf } from '../perf';
import { stampOf, statTrusted } from '../project/stable-read';
import { realFileInside } from '../../runtime/policy';
import { ISOLATED_DIR } from '@shared/component-preview';

const DEV_CACHE = ['.siteorigin', 'cache', 'dev'];
/** Caches the copy builds for itself instead of carrying them over. */
const OWN_CACHES = new Set(['.vite', '.vite-temp']);
/**
 * Build configuration runs as code. The copy keeps the version that was checked against what the user trusted when it
 * was made; a later change reaches the preview only through a new copy, which is checked again.
 */
const BUILD_CONFIG = new Set(['package.json', 'package-lock.json', 'vite.config.js', 'vite.config.ts', 'svelte.config.js']);
/** Copies are named after the app process that made them, so one left by a crash can be told apart. */
const STAGE_RE = /^preview-(\d+)-/;
/** Every copy carries this mark: only a folder with it is ever cleared as a copy. */
const STAGE_MARK = ['.siteorigin', 'preview-copy.json'];

/** Make a private copy of `project` inside `root` to run its preview from. Nothing is left behind on failure. */
export async function createPreviewStage(project: string, root: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  const stage = mkdtempSync(join(root, `preview-${process.pid}-`));
  try {
    await fs.mkdir(join(stage, '.siteorigin'));
    await fs.writeFile(join(stage, ...STAGE_MARK), JSON.stringify({ pid: process.pid }));
    await copyProjectSource(project, stage);
    await copyDevCache(project, stage);
    await copyProjectTools(project, stage);
    return stage;
  } catch (e) {
    await removePreviewStage(stage);
    throw e;
  }
}

/**
 * Copy the project's installed tools into `dest`, so whatever they write stays in the copy. Files are cloned where the
 * disk supports it. The links npm makes inside node_modules are relative and stay within it, so they resolve within
 * the copy; a link that leads anywhere else is left out rather than followed back.
 */
export async function copyProjectTools(project: string, dest: string): Promise<void> {
  const from = await fs.realpath(join(project, 'node_modules'));
  await copyTree(from, join(dest, 'node_modules'), toolsKept(from));
}

/** The entries of the tools in `from` (a real path) that a copy of them carries. */
function toolsKept(from: string): (p: string, e: EntryType) => boolean {
  // An entry's own type says whether it is a link: only those are looked at again.
  return (p, e) => !OWN_CACHES.has(relative(from, p).split(sep)[0]) && (!e.isSymbolicLink() || linkStaysWithin(from, p));
}

/** The build's copy of the website tools, in its staging folder. */
export interface BuildTools {
  /** Put the copy where the next export takes it from (only once nothing the build ran can still be writing in it). */
  keep(): Promise<void>;
}

/** A real folder's identity (never a link's, nor what it leads to), or null when there is none at `p`. */
async function folderId(p: string): Promise<string | null> {
  const st = await fs.lstat(p, { bigint: true }).catch(() => null);
  return st?.isDirectory() ? `${st.dev}:${st.ino}` : null;
}

/**
 * The website tools a production build runs from, kept between exports in `slot` (#978). A fresh copy of the project's
 * tools is slow to build with: macOS checks the signature of a native module the first time any copy of it is loaded
 * (Rolldown's, 18 MB, about 350 ms), and every file is read cold. So the build's copy waits in the slot: the next export
 * takes it (a rename, so its files stay the ones the system has already checked), brings it up to date with the
 * project's tools, and puts it back after its build.
 *
 * A file of the kept copy is used again only while the project's file still has the stamp it had when it was copied (one
 * that had settled by then, statTrusted) and the copy still has the stamp, mode and single link it had when it was made;
 * every other file is copied again, and whatever the copy holds that the project's tools do not (what a build wrote) is
 * removed. What the copy was made from is known only to this process, and only for the folders it put in the slot
 * itself: a copy left by an earlier run of the app, or put there by anything else, is never used. One export holds the
 * copy at a time; another finds the slot empty and copies the tools afresh.
 */
export class KeptTools {
  /** The copy in the slot, by its folders' identities, and the stamps of its files that can be kept. */
  private kept: { slot: string; tools: string; stamps: Map<string, string> } | null = null;

  constructor(private readonly slot: string) {}

  /** The project's installed tools in `dest` (a staging copy of the project), as copyProjectTools copies them. */
  async take(project: string, dest: string, settleMs: number): Promise<BuildTools> {
    const from = await fs.realpath(join(project, 'node_modules'));
    const to = join(dest, 'node_modules');
    const kept = this.kept;
    this.kept = null;
    let reused: Map<string, string> | null = null;
    // Whatever is in the slot goes with this export's staging folder unless it is the copy this process kept.
    const held = join(dirname(dest), 'tools');
    if (await fs.rename(this.slot, held).then(() => true, () => false))
      if (kept && (await folderId(held)) === kept.slot && (await folderId(join(held, 'node_modules'))) === kept.tools)
        // On Windows a file of it may still be in use: the tools are then copied afresh.
        if (await fs.rename(join(held, 'node_modules'), to).then(() => true, () => false)) reused = kept.stamps;
    let made: Map<string, string>;
    try {
      made = await syncTools(from, to, reused ?? new Map(), Date.now(), settleMs);
    } catch (e) {
      if (!reused) throw e;
      // A kept copy that cannot be brought up to date is set aside, to go with the staging folder, and copied afresh.
      await fs.rename(to, join(dirname(dest), 'tools-aside')).catch(() => fs.rm(to, { recursive: true, force: true }));
      made = await syncTools(from, to, new Map(), Date.now(), settleMs);
    }
    const ids = { dest: await folderId(dest), tools: await folderId(to) };
    return { keep: () => this.keep(dest, to, ids, made) };
  }

  /** Put the copy in `to` in the slot in one rename. One that cannot go back stays, to be removed with its staging. */
  private async keep(dest: string, to: string, ids: { dest: string | null; tools: string | null }, stamps: Map<string, string>): Promise<void> {
    try {
      if (!ids.dest || !ids.tools) return;
      const box = await fs.mkdtemp(join(dirname(dest), 'tools-'));
      // Only the very folders the build was given: never one a build put in their place, which could lead anywhere.
      if ((await folderId(dest)) !== ids.dest || (await folderId(to)) !== ids.tools) return;
      await fs.rename(to, join(box, 'node_modules'));
      // What was moved must be that same folder: anything else (the staging copy swapped for a link in the meantime) is
      // put back where it came from, and nothing is kept.
      if ((await folderId(join(box, 'node_modules'))) !== ids.tools) return void (await fs.rename(join(box, 'node_modules'), to));
      const slot = await folderId(box);
      // Fails when another export has put its copy back meanwhile (or, on Windows, while a file is still in use).
      await fs.rename(box, this.slot);
      if (slot) this.kept = { slot, tools: ids.tools, stamps };
    } catch {
      /* left in the staging folder and removed with it: the next export copies the tools afresh */
    }
  }
}

/** A change time finer than a whole second: a later change within the same tick shows. */
const fineChangeTime = (st: BigIntStats) => st.ctimeNs % 1_000_000_000n !== 0n;

/**
 * Make `to` hold what copyTree would copy of the tools in `from`, keeping the files `was` vouches for (KeptTools). Each
 * folder is cleared of what the tools there do not have, by exact name and kind, before anything is copied into it.
 * Returns the stamps of the files that can be kept next time.
 */
async function syncTools(from: string, to: string, was: Map<string, string>, now: number, settleMs: number): Promise<Map<string, string>> {
  const kept = toolsKept(from);
  const listing = new Map<string, Map<string, boolean>>();
  const dirs: string[] = [];
  const files: string[] = [];
  // Each folder's stamp before anything is copied, and the stamp of the folder that holds the tools: one changed
  // meanwhile (a package, or the project, swapped in and back) means no file's stamp can stand for what was copied.
  const folders = new Map<string, string>();
  const holder = async () => stampOf(await fs.lstat(dirname(from), { bigint: true }));
  const held = await holder();
  const walk = async (rel: string) => {
    const here = new Map<string, boolean>();
    listing.set(rel, here);
    folders.set(rel, stampOf(await fs.lstat(join(from, rel), { bigint: true })));
    for (const e of await fs.readdir(join(from, rel), { withFileTypes: true })) {
      const r = rel ? join(rel, e.name) : e.name;
      if (!kept(join(from, r), e)) continue;
      here.set(e.name, e.isDirectory());
      if (e.isDirectory()) {
        dirs.push(r);
        await walk(r);
      } else files.push(r);
    }
  };
  await walk('');
  // A folder is walked only as a folder (never through a link), and made writable so its entries can be replaced (its
  // mode is put back below).
  const clear = async (rel: string) => {
    const at = join(to, rel);
    const st = await fs.lstat(at);
    if ((st.mode & 0o700) !== 0o700) await fs.chmod(at, st.mode | 0o700);
    const wanted = listing.get(rel)!;
    for (const e of await fs.readdir(at, { withFileTypes: true })) {
      const r = rel ? join(rel, e.name) : e.name;
      const dir = wanted.get(e.name);
      if (dir === true && e.isDirectory()) await clear(r);
      else if (dir === undefined || dir || e.isDirectory()) await fs.rm(join(to, r), { recursive: true, force: true });
    }
  };
  const made = new Set<string>();
  // A folder already there must be a real one (a name that differs only in case can be anything on some disks).
  const mkdir = async (r: string) => {
    if (await fs.mkdir(join(to, r)).then(() => true, (e: NodeJS.ErrnoException) => (e.code === 'EEXIST' ? false : Promise.reject(e)))) made.add(r);
    else if (!(await fs.lstat(join(to, r))).isDirectory()) throw Object.assign(new Error(`${join(to, r)} is not a folder.`), { code: 'EEXIST' });
  };
  if ((await fs.lstat(to).catch(() => null))?.isDirectory()) await clear('');
  else await mkdir('');
  for (const r of dirs) await mkdir(r);
  const stamps = new Map<string, string>();
  await inBatches(files, async (r) => {
    const [src, dst] = [join(from, r), join(to, r)];
    const st = await fs.lstat(src, { bigint: true }).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
    const there = await fs.lstat(dst, { bigint: true }).catch(() => null);
    // Every folder in the way is a real one by now, and none where a file goes: one there is another spelling of a
    // folder's name (on a disk that ignores case), which a copy cannot hold beside it. A file gone meanwhile is left out.
    if (there?.isDirectory()) {
      if (!st) return;
      throw Object.assign(new Error(`${dst} is a folder.`), { code: 'EISDIR' });
    }
    if (st?.isFile()) {
      const stamp = stampOf(st);
      if (there?.isFile() && there.nlink === 1n && there.mode === st.mode && was.get(r) === `${stamp} ${stampOf(there)}`) return void stamps.set(r, was.get(r)!);
      if (there) await fs.rm(dst, { recursive: true, force: true });
      await copyFresh(src, dst);
      perf.count('export.filesCopied');
      // A file changed just now may change again within its timestamps' tick: it is copied again next time. So is one
      // that changed while it was copied, and a copy whose own times could not show a later change.
      if (!statTrusted(st, now, settleMs)) return;
      const [copy, again] = await Promise.all([fs.lstat(dst, { bigint: true }), fs.lstat(src, { bigint: true }).catch(() => null)]);
      if (again && stampOf(again) === stamp && copy.size === st.size && copy.nlink === 1n && copy.mode === st.mode && fineChangeTime(copy)) stamps.set(r, `${stamp} ${stampOf(copy)}`);
      return;
    }
    // A link the copy already has as the project has it stays; anything else is copied as copyTree copies it.
    if (st?.isSymbolicLink() && there?.isSymbolicLink() && kept(src, st) && (await fs.readlink(dst)) === (await fs.readlink(src))) return;
    if (there) await fs.rm(dst, { recursive: true, force: true });
    // Gone since it was listed, or no longer an entry a copy carries: left out, as copyTree leaves it out.
    if (!st || !kept(src, st)) return;
    if (st.isDirectory()) return copyTree(src, dst, kept);
    await fs.cp(src, dst, { recursive: true, verbatimSymlinks: true });
    perf.count('export.filesCopied');
  });
  // Folders take their originals' modes once their files are in, as copyTree's do.
  let unchanged = (await holder()) === held;
  for (const r of [...dirs.reverse(), '']) {
    const st = await fs.lstat(join(from, r), { bigint: true });
    if (stampOf(st) !== folders.get(r)) unchanged = false;
    const mode = Number(st.mode);
    if (made.has(r) || (await fs.lstat(join(to, r))).mode !== mode) await fs.chmod(join(to, r), mode);
  }
  return unchanged ? stamps : new Map();
}

/**
 * A file or folder, or a relative link that stays inside `root` (a real path) both as written and once every link on
 * the way is followed. The written path matters because the copy keeps it: one that climbs out of node_modules and
 * back in from elsewhere would lead somewhere else in the copy, possibly the project itself.
 */
function linkStaysWithin(root: string, p: string): boolean {
  const within = (q: string) => {
    const rel = relative(root, q);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  try {
    if (!lstatSync(p).isSymbolicLink()) return true;
    const target = readlinkSync(p);
    // Never above `root` as written, at any step: a path that climbs out and back in names something else in the copy.
    const written = join(relative(root, dirname(p)), target);
    if (isAbsolute(target) || written === '..' || written.startsWith(`..${sep}`) || isAbsolute(written)) return false;
    return within(realpathSync.native(p));
  } catch {
    return false;
  }
}

/**
 * Isolated component previews belong to the preview server they were made for: the project's are never copied, and
 * the copy's own are never removed for not being in the project.
 */
const isolatedIn = (dev: string, p: string) => relative(dev, p).split(sep)[0] === ISOLATED_DIR;

/** The editor's instrumented variants, only when the cache really is inside the project; links in it are skipped. */
async function copyDevCache(project: string, stage: string): Promise<void> {
  const dev = join(project, ...DEV_CACHE);
  if (!existsSync(dev) || !realFileInside(project, dev)) return;
  const from = await fs.realpath(dev);
  await fs.cp(from, join(stage, ...DEV_CACHE), { recursive: true, filter: (p) => notLink(p) && !isolatedIn(from, p) });
}

/**
 * Bring the copy up to date after the project changed on disk: new and changed files are copied, files the project
 * no longer has are removed, and unchanged files are left alone so the preview reloads only what changed. A source
 * file whose dev variant alone changed (or went) is touched, because the preview does not watch the editor's cache.
 */
export async function syncPreviewStage(project: string, stage: string): Promise<string[]> {
  const dev = join(project, ...DEV_CACHE);
  // A cache that went, or now leads out of the project, takes its variants out of the copy too.
  const devFrom = existsSync(dev) && realFileInside(project, dev) ? await fs.realpath(dev) : null;
  const variants = await mirror(devFrom, join(stage, ...DEV_CACHE), (root, p) => notLink(p) && !isolatedIn(root, p));
  // Compared without case: on a case-insensitive disk, another spelling is the same file.
  // The project brief stays out of the copy, as it does from the first one (copyProjectSource).
  // So do external sources' settings (#676), which the site never reads (see copyProjectSource).
  const sources = await mirror(project, stage, (root, p) => inProjectSource(root, p) && !isProjectBrief(root, p) && !isSourcesFolder(root, p) && !(dirname(p) === root && BUILD_CONFIG.has(relative(root, p).toLowerCase())));
  const now = new Date();
  const touched: string[] = [];
  for (const rel of variants) {
    if (sources.has(rel)) continue;
    const file = join(stage, ...rel.split('/'));
    // Only a real source file of the copy is touched; nothing the copy links to.
    if (!inProjectSource(stage, file) || !(await fs.lstat(file).catch(() => null))?.isFile()) continue;
    if (await fs.utimes(file, now, now).then(() => true, () => false)) touched.push(rel);
  }
  // The copy's files this changed (project-relative), so its preview takes them as one update.
  return [...sources, ...touched];
}

/**
 * Make `dest` hold what `src` holds (nothing, when `src` is null), for the entries `keep` accepts. Each folder is
 * cleared of what the source no longer has, by exact name, before anything is copied into it, so a name that changed
 * only in case on a case-insensitive disk is replaced rather than lost. Returns the files written or removed.
 */
async function mirror(src: string | null, dest: string, keep: (root: string, path: string) => boolean): Promise<Set<string>> {
  const changed = new Set<string>();
  const note = (rel: string) => changed.add(rel.split(sep).join('/'));
  const removed = async (rel: string) => {
    const at = join(dest, rel);
    const st = await fs.lstat(at).catch(() => null);
    if (st?.isDirectory()) for (const name of await fs.readdir(at).catch(() => [] as string[])) await removed(join(rel, name));
    else if (st) note(rel);
  };
  const walk = async (rel: string) => {
    // A folder that is gone is empty; one that cannot be read fails the mirror rather than emptying the copy.
    const names = src
      ? await fs.readdir(join(src, rel)).catch((e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return [] as string[];
          throw e;
        })
      : [];
    const wanted = new Set(names.filter((name) => keep(src!, join(src!, rel, name))));
    for (const name of await fs.readdir(join(dest, rel)).catch(() => [] as string[])) {
      const r = join(rel, name);
      if (wanted.has(name) || !keep(dest, join(dest, r))) continue;
      await removed(r);
      await fs.rm(join(dest, r), { recursive: true, force: true });
    }
    for (const name of wanted) {
      const r = join(rel, name);
      const from = join(src!, r);
      const to = join(dest, r);
      const st = await fs.lstat(from).catch(() => null);
      const there = await fs.lstat(to).catch(() => null);
      if (st?.isDirectory()) {
        if (there && !there.isDirectory()) {
          note(r);
          await fs.rm(to, { force: true });
        }
        await fs.mkdir(to, { recursive: true });
        await walk(r);
      } else if (st?.isFile()) {
        if (there?.isFile() && there.size === st.size) {
          const [a, b] = await Promise.all([fs.readFile(from).catch(() => null), fs.readFile(to).catch(() => null)]);
          if (a && b && a.equals(b)) continue;
        }
        if (there && !there.isFile()) {
          await removed(r);
          await fs.rm(to, { recursive: true, force: true });
        }
        await fs.mkdir(dirname(to), { recursive: true });
        // A file replaced as it was being copied (an atomic save) is picked up by the next pass.
        const copied = await fs.copyFile(from, to).then(
          () => true,
          (e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') return false;
            throw e;
          }
        );
        if (copied) note(r);
      }
    }
  };
  await walk('');
  return changed;
}

export async function removePreviewStage(stage: string): Promise<void> {
  await fs.rm(stage, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Remove copies left behind by an app that is no longer running, and by this one (it holds none while starting). Only
 * a folder this module made, by its mark, counts; one that is now open as a project (it holds a lock) is left alone.
 */
export async function sweepPreviewStages(root: string): Promise<void> {
  for (const name of await fs.readdir(root).catch(() => [] as string[])) {
    const pid = Number(STAGE_RE.exec(name)?.[1]);
    if (!pid || (pid !== process.pid && running(pid))) continue;
    const dir = join(root, name);
    if (!(await fs.lstat(join(dir, ...STAGE_MARK)).catch(() => null))?.isFile() || existsSync(join(dir, '.siteorigin', 'lock.json'))) continue;
    await removePreviewStage(dir).catch(() => undefined);
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function notLink(p: string): boolean {
  try {
    return !lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
