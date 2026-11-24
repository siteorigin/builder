/**
 * The desktop around the editor, for the test driver and the e2e harness (#494): the native application menu, the
 * answers for native choosers (src/main/headless-desktop.ts), and the session-owned files a chooser may name.
 *
 * The `*InMain` functions run inside the app's main process through Playwright's `app.evaluate`, which sends their
 * source: they use nothing but their arguments, so they must not call anything else in this module.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ElectronApplication } from 'playwright';
import { DriverError } from './protocol.ts';

// ---------------------------------------------------------------------------
// The application menu
// ---------------------------------------------------------------------------

export interface MenuNode {
  label: string;
  /** Labels from the menu bar down to this item. */
  path: string[];
  id: string | null;
  role: string | null;
  type: string;
  enabled: boolean;
  visible: boolean;
  checked: boolean;
  accelerator: string | null;
  /** Whether menu.invoke can choose it: one of the app's own commands. Stock roles act on the system (DevTools, the
   *  window, the text field with focus) and are listed for what they are, not chosen. */
  invokable: boolean;
  items?: MenuNode[];
}

/** The installed application menu, without separators. Runs in the main process. */
export function menuTreeInMain({ Menu }: { Menu: any }): MenuNode[] {
  const walk = (items: any[], parents: string[]): MenuNode[] =>
    items
      .filter((i) => i.type !== 'separator')
      .map((i) => {
        const label = String(i.label ?? '');
        const path = [...parents, label];
        const node: MenuNode = {
          label,
          path,
          id: i.id || null,
          role: i.role || null,
          type: String(i.type),
          enabled: !!i.enabled,
          visible: !!i.visible,
          checked: !!i.checked,
          accelerator: i.accelerator ? String(i.accelerator) : null,
          invokable: !i.role && !i.submenu && ['normal', 'checkbox', 'radio'].includes(i.type)
        };
        if (i.submenu) node.items = walk(i.submenu.items, path);
        return node;
      });
  const menu = Menu.getApplicationMenu();
  return menu ? walk(menu.items, []) : [];
}

export interface MenuInvocation {
  /** Items to choose, one after the other in the same turn of the main process. */
  paths: string[][];
  /** The editor window they are chosen for, by native id, or null when there is none. */
  window: number | null;
  request: string | null;
}

/**
 * Choose application menu items through their own click handlers, as the menu bar and their shortcuts do, with the
 * editor window as the window they are for (it is never focused: a headless window never is). Each item is found and
 * checked just before it is chosen; nothing is chosen once one fails. Runs in the main process. The thrown message
 * starts with a reason in brackets.
 */
export function invokeMenuInMain({ Menu, BrowserWindow }: { Menu: any; BrowserWindow: any }, inv: MenuInvocation): { seq: number | null; path: string[]; window: number | null }[] {
  const fail = (reason: string, message: string): never => {
    throw new Error(`[${reason}] ${message}`);
  };
  const fixtures = (globalThis as any)[Symbol.for('siteorigin.desktopFixtures')];
  const isEditor = (w: any) => {
    try {
      const u = new URL(w.webContents.getURL());
      return u.protocol === 'app:' && u.host === 'editor';
    } catch {
      return false;
    }
  };
  const target = inv.window === null ? null : BrowserWindow.fromId(inv.window);
  if (inv.window !== null && (!target || target.isDestroyed())) fail('window-closed', `Editor window ${inv.window} is gone.`);
  if (inv.window === null && BrowserWindow.getAllWindows().some((w: any) => !w.isDestroyed() && isEditor(w))) fail('window-open', 'An editor window is open: choose the item for it.');
  const done: { seq: number | null; path: string[]; window: number | null }[] = [];
  for (const path of inv.paths) {
    const menu = Menu.getApplicationMenu();
    if (!menu) fail('no-menu', 'The app has no application menu.');
    let items: any[] = menu.items;
    let item: any = null;
    for (let depth = 0; depth < path.length; depth++) {
      const at = path.slice(0, depth + 1).join(' > ');
      const found = items.filter((i) => i.type !== 'separator' && i.label === path[depth]);
      if (!found.length) fail('not-found', `There is no menu item ${at}.`);
      if (found.length > 1) fail('ambiguous', `More than one menu item is ${at}.`);
      item = found[0];
      if (!item.visible) fail('hidden', `${at} is hidden.`);
      if (!item.enabled) fail('disabled', `${at} is disabled.`);
      if (depth < path.length - 1) {
        if (!item.submenu) fail('not-found', `${at} has no submenu.`);
        items = item.submenu.items;
      }
    }
    const label = path.join(' > ');
    if (item.submenu) fail('not-invokable', `${label} opens a submenu; choose an item in it.`);
    if (item.role) fail('not-invokable', `${label} is the system's ${item.role} command, which the driver does not choose.`);
    const seq = fixtures ? fixtures.noteMenu(path, inv.window, inv.request) : null;
    // A plain choice from the menu, not a shortcut: no keys held.
    const event = { triggeredByAccelerator: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
    item.click(event, target ?? undefined, target?.webContents ?? undefined);
    done.push({ seq, path: [...path], window: inv.window });
  }
  return done;
}

/** Find a node by its path in a menu tree. */
export function findMenuNode(tree: MenuNode[], path: string[]): MenuNode | null {
  let items: MenuNode[] | undefined = tree;
  let node: MenuNode | null = null;
  for (const label of path) {
    node = items?.find((i) => i.label === label) ?? null;
    if (!node) return null;
    items = node.items;
  }
  return node;
}

// ---------------------------------------------------------------------------
// Chooser answers and the desktop record
// ---------------------------------------------------------------------------

export type DesktopCall = { op: 'setAnswers'; answers: unknown[]; request: string | null } | { op: 'events'; after?: number; limit?: number } | { op: 'installed' };

/** Talk to the app's chooser fixtures. Runs in the main process. */
export function desktopInMain(_electron: unknown, call: DesktopCall): any {
  const fixtures = (globalThis as any)[Symbol.for('siteorigin.desktopFixtures')];
  if (call.op === 'installed') return !!fixtures;
  if (!fixtures) throw new Error('[not-installed] This build answers no choosers: it predates desktop fixtures, or was not launched by a test. Rebuild it (npm run build).');
  if (call.op === 'setAnswers') return fixtures.setAnswers(call.answers, { request: call.request });
  return fixtures.events(call.after ?? 0, call.limit ?? 200);
}

/** Run an `*InMain` function, turning its bracketed reason into a driver error. */
export async function inMain<A, R>(app: ElectronApplication, fn: (electron: any, arg: A) => R, arg: A): Promise<Awaited<R>> {
  try {
    return (await app.evaluate(fn as any, arg)) as Awaited<R>;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const m = /\[([a-z-]+)\] ([^\n]*)/.exec(message);
    if (!m) throw e;
    if (m[1] === 'window-closed') throw new DriverError('WINDOW_CLOSED', m[2], { retryable: true });
    // An editor window that has just opened is bound by the session a moment later: asking again then works.
    throw new DriverError('OP_FAILED', m[2], { retryable: m[1] === 'window-open', details: { reason: m[1] } });
  }
}

// ---------------------------------------------------------------------------
// Session-owned files
// ---------------------------------------------------------------------------

/** The folders of a session a chooser answer may name, by the name a logical path starts with. */
export type Area = 'imports' | 'exports' | 'workspace';
export const AREAS: Area[] = ['imports', 'exports', 'workspace'];

/** What a chooser of each kind may be answered with: open reads, save writes. */
export const ANSWER_AREAS: Record<'open' | 'save', Area[]> = { open: ['imports', 'exports', 'workspace'], save: ['exports', 'workspace'] };

const inside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
};

/** The real path of `p`, resolving links in the part of it that exists. */
async function realish(p: string): Promise<string> {
  const rest: string[] = [];
  let at = p;
  for (;;) {
    try {
      return join(await realpath(at), ...rest.reverse());
    } catch {
      const parent = resolve(at, '..');
      if (parent === at) return p;
      rest.push(basename(at));
      at = parent;
    }
  }
}

/**
 * Resolve a path a client names for the session's files: `imports/logo.jpg`, `exports/site.zip`,
 * `workspace/SiteOrigin/bakery`, or an absolute path inside one of those folders. Only the `allowed` folders are
 * accepted, and a path that leads out of them (`..`, or a link) is refused, so a session never reads or writes
 * anything of the caller's, its profile or its own marks.
 */
export async function resolveSessionPath(areas: Record<Area, string>, input: unknown, allowed: Area[]): Promise<string> {
  if (typeof input !== 'string' || !input) throw new DriverError('BAD_REQUEST', 'A path is a non-empty string.');
  let abs: string;
  if (isAbsolute(input)) abs = resolve(input);
  else {
    const [first, ...rest] = input.split(/[\\/]/);
    if (!AREAS.includes(first as Area)) throw new DriverError('BAD_REQUEST', `"${input}" starts with one of the session's folders: ${allowed.map((a) => `${a}/`).join(', ')}.`);
    abs = resolve(areas[first as Area], ...rest);
  }
  // Named inside an allowed folder, and really there once links are followed (a link between two of them is fine).
  const real = await realish(abs);
  const roots = await Promise.all(allowed.map((a) => realish(areas[a])));
  if (allowed.some((a) => inside(areas[a], abs)) && roots.some((root) => inside(root, real))) return real;
  throw new DriverError('BAD_REQUEST', `"${input}" is not inside the session's ${allowed.map((a) => `${a}/`).join(', ')}.`);
}

/** Resolve every path an answer names, for the chooser it answers. */
export async function resolveAnswer(areas: Record<Area, string>, answer: unknown): Promise<unknown> {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return answer;
  const a = { ...(answer as Record<string, unknown>) };
  if (a.dialog === 'open' && Array.isArray(a.paths)) a.paths = await Promise.all(a.paths.map((p) => resolveSessionPath(areas, p, ANSWER_AREAS.open)));
  if (a.dialog === 'save' && a.path !== undefined) a.path = await resolveSessionPath(areas, a.path, ANSWER_AREAS.save);
  return a;
}

const IMAGE = /\.(jpe?g|png|webp|gif)$/i;

/** The sample images a session can put in its imports folder: the starter's own photos. */
export async function sampleImages(appRoot: string): Promise<string[]> {
  return (await readdir(join(appRoot, 'resources', 'starter-assets')).catch(() => [] as string[])).filter((n) => IMAGE.test(n)).sort();
}

/** Copy a sample image into the session's imports folder under a new name. Never replaces a file. */
export async function stageImport(appRoot: string, imports: string, args: Record<string, unknown> | undefined): Promise<{ path: string; logical: string; bytes: number; sha256: string }> {
  const a = args ?? {};
  for (const k of Object.keys(a)) if (k !== 'name' && k !== 'sample') throw new DriverError('BAD_REQUEST', `files.stageImport does not take "${k}".`);
  const samples = await sampleImages(appRoot);
  if (typeof a.sample !== 'string' || !samples.includes(a.sample)) throw new DriverError('BAD_REQUEST', `"sample" is one of ${samples.join(', ')}.`);
  const name = a.name ?? a.sample;
  if (typeof name !== 'string' || !name || name !== basename(name) || name.startsWith('.') || name.includes(sep)) throw new DriverError('BAD_REQUEST', '"name" is a file name, with no folder.');
  if (extname(name).toLowerCase() !== extname(a.sample).toLowerCase()) throw new DriverError('BAD_REQUEST', `"name" keeps the sample's type (${extname(a.sample)}).`);
  const dest = join(imports, name);
  try {
    await copyFile(join(appRoot, 'resources', 'starter-assets', a.sample), dest, constants.COPYFILE_EXCL);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new DriverError('OP_FAILED', `imports/${name} already exists.`, { details: { reason: 'exists' } });
    throw e;
  }
  const bytes = await readFile(dest);
  return { path: dest, logical: `imports/${name}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'folder' | 'link' | 'other';
  bytes?: number;
}

/** One level of a session folder, by name. */
export async function listSessionFolder(areas: Record<Area, string>, input: unknown): Promise<{ path: string; entries: FileEntry[] }> {
  const dir = await resolveSessionPath(areas, input ?? 'exports', AREAS);
  const s = await stat(dir).catch(() => null);
  if (!s?.isDirectory()) throw new DriverError('OP_FAILED', `${String(input ?? 'exports')} is not a folder.`, { details: { reason: s ? 'not-a-folder' : 'missing' } });
  const entries: FileEntry[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const p = join(dir, name);
    const l = await lstat(p);
    entries.push({ name, path: p, type: l.isSymbolicLink() ? 'link' : l.isDirectory() ? 'folder' : l.isFile() ? 'file' : 'other', ...(l.isFile() ? { bytes: l.size } : {}) });
  }
  return { path: dir, entries };
}
