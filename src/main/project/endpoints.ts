/**
 * The project's own API endpoints on disk (#1481, shared/endpoints.ts): the `+server.js` and `+server.ts` files under
 * `src/routes/`, listed, read and written for the Endpoints panel. They are the developer's files: the generator never
 * writes one, so a file generated-manifest.json lists is never offered. Nothing is followed through a link, and a write
 * replaces the file only while it still holds what the editor read (its hash), so an edit made meanwhile in another
 * editor is never overwritten. Nothing here depends on Electron, so it is unit tested directly.
 */
import { createHash } from 'node:crypto';
import { lstatSync, promises as fs, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { endpointFileFor, endpointLanguage, endpointMethods, endpointRoute, endpointStarter, isEndpointFile, MAX_ENDPOINT_BYTES, newEndpointProblem, type EndpointFile, type EndpointLanguage, type EndpointWrite } from '@shared/endpoints';
import { atomicWrite, safeJoin } from './fsutil';

export type { EndpointWrite };

const MANIFEST_PATH = 'siteorigin/generated-manifest.json';
/** How deep below src/routes the list looks, and how many endpoints it lists at most. */
const MAX_DEPTH = 12;
const MAX_LISTED = 500;

/** The hash an endpoint's text is known by, so a save can tell it was not changed meanwhile. */
export const endpointHash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The files generated-manifest.json lists as SiteOrigin Builder's. */
async function generatedFiles(dir: string): Promise<Set<string>> {
  try {
    const manifest = JSON.parse(await fs.readFile(join(dir, MANIFEST_PATH), 'utf8')) as { files?: Record<string, unknown> };
    return new Set(Object.keys(manifest?.files ?? {}));
  } catch {
    return new Set();
  }
}

/**
 * Every endpoint file of the project's, by route then file: walked from src/routes without following links, folders
 * whose names start with a dot left out, at most MAX_LISTED of them.
 */
export async function listEndpoints(dir: string): Promise<EndpointFile[]> {
  const generated = await generatedFiles(dir);
  const found: EndpointFile[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || found.length >= MAX_LISTED) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = `${rel}/${e.name}`;
      if (e.isDirectory() && !e.name.startsWith('.')) await walk(path, depth + 1);
      else if (e.isFile() && isEndpointFile(path) && !generated.has(path)) {
        const text = await readEndpointText(dir, path).catch(() => null);
        found.push({ file: path, route: endpointRoute(path), language: endpointLanguage(path), methods: text === null ? [] : endpointMethods(text) });
      }
      if (found.length >= MAX_LISTED) return;
    }
  };
  await walk('src/routes', 0);
  return found.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : a.file < b.file ? -1 : 1));
}

/** Why `file` cannot be read or written as an endpoint of the project's, or null. */
async function refusal(dir: string, file: string): Promise<string | null> {
  if (!isEndpointFile(file)) return 'That is not an endpoint file: endpoints are +server.js or +server.ts files in src/routes.';
  if ((await generatedFiles(dir)).has(file)) return 'That file is SiteOrigin Builder’s own, not an endpoint of yours.';
  return null;
}

/**
 * What is at `rel` below the project folder `root`, looked at part by part without following any link: a plain file
 * reached through plain folders, nothing (`missing`: a part is not there), or anything else (`other`: a link on the
 * way or at the end, a file where a folder should be, a folder where the file should be).
 */
export function lookPlain(root: string, rel: string): { abs: string; kind: 'file' | 'missing' | 'other' } {
  const abs = safeJoin(root, rel);
  const parts = rel.split('/');
  let at = root;
  for (let i = 0; i < parts.length; i++) {
    at = join(at, parts[i]);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(at);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { abs, kind: 'missing' };
      if (code === 'ENOTDIR') return { abs, kind: 'other' };
      throw e;
    }
    if (st.isSymbolicLink() || (i < parts.length - 1 ? !st.isDirectory() : !st.isFile())) return { abs, kind: 'other' };
  }
  return { abs, kind: 'file' };
}

/** The plain file at `file` below `dir`, reached through no link, or none there. Throws for anything else. */
function plainFile(dir: string, file: string): { abs: string; exists: boolean } {
  const { abs, kind } = lookPlain(dir, file);
  if (kind === 'other') throw new Error(`${file} is not a plain file in the project (it is a folder, or reached through a link), so it is not opened.`);
  return { abs, exists: kind === 'file' };
}

async function readEndpointText(dir: string, file: string): Promise<string> {
  const { abs, exists } = plainFile(dir, file);
  if (!exists) throw Object.assign(new Error(`${file} is not there any more.`), { code: 'ENOENT' });
  const st = await fs.stat(abs);
  if (st.size > MAX_ENDPOINT_BYTES) throw new Error(`${file} is too large to open here (over ${MAX_ENDPOINT_BYTES / 1024} KB).`);
  return fs.readFile(abs, 'utf8');
}

/** An endpoint's text and the hash a save of it names, or why it cannot be opened. */
export async function readEndpoint(dir: string, file: string): Promise<{ ok: true; text: string; hash: string } | { ok: false; message: string }> {
  const no = await refusal(dir, file);
  if (no) return { ok: false, message: no };
  try {
    const text = await readEndpointText(dir, file);
    return { ok: true, text, hash: endpointHash(text) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}


/**
 * Replace an endpoint's text with `text`, only while it still holds the text whose hash is `expected`: one changed
 * meanwhile is a conflict, and nothing is written. `fence` runs the write (the controller's writeFence), saying false
 * when the project is no longer this app's to write.
 */
export async function saveEndpoint(dir: string, file: string, text: string, expected: string, fence: (write: () => Promise<void>) => Promise<boolean>): Promise<EndpointWrite> {
  const no = await refusal(dir, file);
  if (no) return { ok: false, message: no };
  if (Buffer.byteLength(text) > MAX_ENDPOINT_BYTES) return { ok: false, message: `An endpoint can be at most ${MAX_ENDPOINT_BYTES / 1024} KB.` };
  let outcome = null as EndpointWrite | null;
  try {
    const wrote = await fence(async () => {
      const { abs } = plainFile(dir, file);
      const now = await readEndpointText(dir, file).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
      if (now === null) {
        outcome = { ok: false, message: `${file} was removed outside SiteOrigin Builder.`, conflict: true };
        return;
      }
      if (endpointHash(now) !== expected) {
        outcome = { ok: false, message: `${file} changed outside SiteOrigin Builder since it was opened. Open it again to see the change.`, conflict: true };
        return;
      }
      await atomicWrite(abs, text, { beforeReplace: async () => endpointHash(await fs.readFile(abs, 'utf8').catch(() => '')) === expected });
      outcome = { ok: true, hash: endpointHash(text), endpoint: { file, route: endpointRoute(file), language: endpointLanguage(file), methods: endpointMethods(text) } };
    });
    if (!wrote) return { ok: false, message: 'The project can’t be changed here now.' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  return outcome ?? { ok: false, message: `${file} changed while it was being saved. Open it again.`, conflict: true };
}

/**
 * Make a new endpoint at `route` (under /api/), in `language`, with a starter handler: refused where the route already
 * has an endpoint in either language, or anything else is at the file's path.
 */
export async function createEndpoint(dir: string, route: string, language: EndpointLanguage, fence: (write: () => Promise<void>) => Promise<boolean>): Promise<EndpointWrite> {
  const problem = newEndpointProblem(route);
  if (problem) return { ok: false, message: problem };
  const file = endpointFileFor(route, language);
  const other = endpointFileFor(route, language === 'ts' ? 'js' : 'ts');
  const text = endpointStarter(route, language);
  let outcome = null as EndpointWrite | null;
  try {
    const wrote = await fence(async () => {
      for (const f of [file, other]) {
        if (plainFile(dir, f).exists) {
          outcome = { ok: false, message: `${route} already has an endpoint: ${f}.` };
          return;
        }
      }
      const { abs } = plainFile(dir, file);
      // Made only where nothing is: a file that turned up meanwhile is kept.
      await fs.mkdir(join(abs, '..'), { recursive: true });
      const handle = await fs.open(abs, 'wx');
      try {
        await handle.writeFile(text);
      } finally {
        await handle.close();
      }
      outcome = { ok: true, hash: endpointHash(text), text, endpoint: { file, route, language, methods: endpointMethods(text) } };
    });
    if (!wrote) return { ok: false, message: 'The project can’t be changed here now.' };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, message: `${route} already has an endpoint: ${file}.` };
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  return outcome ?? { ok: false, message: 'The endpoint could not be made.' };
}
