/**
 * Private copies of a project for a preview this app may not write to (spec 16.6, 18.1). A project's own build tools
 * write where they run (node_modules/.vite-temp, node_modules/.vite, .svelte-kit), so a project open read-only is
 * previewed from a copy this app owns: its source, the editor's dev variants and its own copy of the installed tools.
 * Nothing here depends on Electron, so it is unit tested directly.
 */
import { constants, existsSync, lstatSync, mkdtempSync, readlinkSync, realpathSync, promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { copyProjectSource, inProjectSource, isProjectBrief } from '../export';
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
  await fs.cp(from, join(dest, 'node_modules'), {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
    filter: (p) => !OWN_CACHES.has(relative(from, p).split(sep)[0]) && linkStaysWithin(from, p)
  });
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
  const sources = await mirror(project, stage, (root, p) => inProjectSource(root, p) && !isProjectBrief(root, p) && !(dirname(p) === root && BUILD_CONFIG.has(relative(root, p).toLowerCase())));
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
