/**
 * The project's own code files, for the code workspace (#1483): listed, read and saved as an outside code editor
 * would, never through the project's documents. Only a plain file the project holds as its own is reached (see
 * @shared/code-workspace): every folder on the way is looked at without following links and must be spelled as the
 * disk spells it, so neither a link nor another spelling of a name (on a disk that ignores case) leads anywhere else,
 * the app's own files included. A save replaces the file only while it still holds what the editor read, checked again
 * just before the new file takes its place.
 */
import { constants as fsConstants, promises as fs, type BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { MAX_CODE_FILE_BYTES, MAX_CODE_FILES, codePathProblem, isAppCodePath, type CodeFileEntry, type CodeFileRefusal } from '@shared/code-workspace';
import { atomicWrite, sha } from './fsutil';
import { isPrivateFileName } from './private-files';

/** Opens a file to read, never through a link at its own name, and never waiting on a pipe. */
const OPEN_FILE = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
/** Folders the listing never goes into, at any depth. */
const SKIPPED_DIRS = new Set(['node_modules']);
/** How deep the listing goes below src/. */
const MAX_DEPTH = 24;

type Refused = { ok: false; reason: CodeFileRefusal; message: string };
const refuse = (reason: CodeFileRefusal, message: string): Refused => ({ ok: false, reason, message });

/** Whether the app writes a project-relative path, or holds it as its own (see ProjectSession.appWrites). */
export type AppWrites = (path: string) => boolean;

/** A name a listing leaves out: hidden ones, and anything named like a credential or key. */
const hidden = (name: string) => name.startsWith('.') || isPrivateFileName(name);

/**
 * The project's own code files under src/, sorted by path: every plain file with a code file's extension, outside the
 * app's folder, that the app does not write. Links, hidden names, credentials and `node_modules` are passed by. A
 * project with more than MAX_CODE_FILES of them is listed in part (`truncated`).
 */
export async function listCodeFiles(dir: string, appWrites: AppWrites): Promise<{ files: CodeFileEntry[]; truncated: boolean }> {
  const files: CodeFileEntry[] = [];
  let truncated = false;
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (truncated || depth > MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(join(dir, ...rel.split('/')), { withFileTypes: true });
    } catch {
      // A folder that cannot be read lists nothing.
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (truncated) return;
      const path = `${rel}/${e.name}`;
      if (hidden(e.name)) continue;
      // A link reports itself as one here, whatever it points at: it is never followed.
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name) && !isAppCodePath(path)) await walk(path, depth + 1);
        continue;
      }
      if (!e.isFile() || codePathProblem(path) || appWrites(path)) continue;
      let size: number;
      try {
        size = (await fs.lstat(join(dir, ...path.split('/')))).size;
      } catch {
        continue;
      }
      if (files.length >= MAX_CODE_FILES) {
        truncated = true;
        return;
      }
      files.push({ path, size });
    }
  };
  // src/ itself is the project's own folder, never a link to another.
  const root = await fs.lstat(join(dir, 'src')).catch(() => null);
  if (root?.isDirectory()) await walk('src', 0);
  return { files, truncated };
}

/**
 * The project file at `path` (checked by codePathProblem), reached part by part without following links: each folder
 * one of its own and the file a plain file, each spelled exactly as its folder lists it. Its own stat, or why not.
 */
async function checkedFile(dir: string, path: string): Promise<{ ok: true; abs: string; st: BigIntStats } | Refused> {
  const parts = path.split('/');
  let at = dir;
  for (let i = 0; i < parts.length; i++) {
    let names: string[];
    try {
      names = await fs.readdir(at);
    } catch {
      return refuse('gone', `${path} is no longer in the project.`);
    }
    // Another spelling of a name the disk would take for it (a folder named in other capitals) leads nowhere.
    if (!names.includes(parts[i])) return refuse('gone', `${path} is no longer in the project.`);
    at = join(at, parts[i]);
    let st: BigIntStats;
    try {
      st = await fs.lstat(at, { bigint: true });
    } catch {
      return refuse('gone', `${path} is no longer in the project.`);
    }
    const last = i === parts.length - 1;
    if (st.isSymbolicLink()) return refuse('refused', `${path} is reached through a link, so the workspace does not open it. Open it in your own code editor.`);
    if (!last && !st.isDirectory()) return refuse('gone', `${path} is no longer in the project.`);
    if (last) return st.isFile() ? { ok: true, abs: at, st } : refuse('refused', `${path} is not a file the workspace can open.`);
  }
  return refuse('gone', `${path} is no longer in the project.`);
}

/** The policy every read and save starts with: a code path of the project's own, not one the app writes. */
function policy(path: unknown, appWrites: AppWrites): Refused | null {
  const problem = codePathProblem(path);
  if (problem) return refuse('refused', problem);
  if ((path as string).split('/').some(isPrivateFileName)) return refuse('refused', 'That file is named like a credential or key, so the workspace does not open it.');
  if (appWrites(path as string)) return refuse('claimed', `SiteOrigin Builder writes ${path as string} from your pages, so it can’t be edited here.`);
  return null;
}

/** The file's bytes, read through one checked handle: the same file `st` describes, at most MAX_CODE_FILE_BYTES of it. */
async function readChecked(path: string, abs: string, st: BigIntStats): Promise<{ ok: true; bytes: Buffer } | Refused> {
  if (st.size > BigInt(MAX_CODE_FILE_BYTES)) return tooLarge(path);
  let handle: import('node:fs/promises').FileHandle;
  try {
    handle = await fs.open(abs, OPEN_FILE);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return refuse('gone', `${path} is no longer in the project.`);
    return refuse('refused', `${path} could not be read: ${(e as Error).message}`);
  }
  try {
    const now = await handle.stat({ bigint: true });
    if (!now.isFile() || now.dev !== st.dev || now.ino !== st.ino) return refuse('changed', `${path} changed while it was being read. Try again.`);
    // One byte more than a file may hold tells a file that grew past it since it was looked at.
    const buf = Buffer.alloc(MAX_CODE_FILE_BYTES + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, total, buf.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total === buf.length) break;
    }
    if (total > MAX_CODE_FILE_BYTES) return tooLarge(path);
    return { ok: true, bytes: buf.subarray(0, total) };
  } catch (e) {
    return refuse('refused', `${path} could not be read: ${(e as Error).message}`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const tooLarge = (path: string) => refuse('too-large', `${path} is larger than the workspace opens (${MAX_CODE_FILE_BYTES / 1024} KB). Open it in your own code editor.`);

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The file's text as the editor holds it (line breaks as `\n`, no byte order mark), or null when it is not UTF-8 text. */
export function editorText(bytes: Buffer): string | null {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return null;
  }
  if (text.includes('\0')) return null;
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/**
 * `text` from the editor as the file's bytes, written the way the file was: with its line breaks (`\r\n` when its first
 * line ended so) and its byte order mark, if it had one.
 */
export function fileBytes(text: string, was: Buffer): Buffer {
  const nl = was.indexOf(0x0a);
  const crlf = nl > 0 && was[nl - 1] === 0x0d;
  const body = text.replace(/\r\n?/g, '\n');
  const out = Buffer.from(crlf ? body.replace(/\n/g, '\r\n') : body, 'utf8');
  return was.subarray(0, 3).equals(BOM) ? Buffer.concat([BOM, out]) : out;
}

/** The absolute path of the project file at `rel`, reached without a link and spelled as the disk spells it, or why not. */
export async function projectFile(dir: string, rel: string): Promise<{ ok: true; abs: string } | Refused> {
  const found = await checkedFile(dir, rel);
  return found.ok ? { ok: true, abs: found.abs } : found;
}

/** The absolute path of one of the project's own code files, checked as a read is, for a hand-off to the developer's editor. */
export async function codeFilePath(dir: string, path: unknown, appWrites: AppWrites): Promise<{ ok: true; abs: string } | Refused> {
  return policy(path, appWrites) ?? (await projectFile(dir, path as string));
}

/** Read one of the project's own code files for the editor. */
export async function readCodeFile(dir: string, path: unknown, appWrites: AppWrites): Promise<{ ok: true; path: string; text: string; hash: string } | Refused> {
  const refused = policy(path, appWrites);
  if (refused) return refused;
  const rel = path as string;
  const found = await checkedFile(dir, rel);
  if (!found.ok) return found;
  const read = await readChecked(rel, found.abs, found.st);
  if (!read.ok) return read;
  const text = editorText(read.bytes);
  if (text === null) return refuse('binary', `${rel} is not text the workspace can show. Open it in your own code editor.`);
  return { ok: true, path: rel, text, hash: sha(read.bytes) };
}

export interface SaveCodeFileOptions {
  appWrites: AppWrites;
  /**
   * Runs the write while the project is still this opening's and its lock still this app's (Controller.writeFence):
   * false when it is not, and nothing was written.
   */
  fence: (write: () => Promise<void>) => Promise<boolean>;
  /** Whether the opening the save was asked in is still open: asked again just before the new file takes its place. */
  open: () => boolean;
}

/**
 * Save `text` over one of the project's own code files, only while it still holds the bytes whose hash is
 * `expectedHash` (what the editor read). The file keeps its line breaks, byte order mark and mode. Everything is
 * checked again just before the new file takes its place, and again before each retry of that on Windows: the
 * opening, that the app does not write the path, that the same file is there, and that it holds what was read. An
 * outside editor saving at that very moment can still be overtaken: the check and the replacement are two steps.
 */
export async function saveCodeFile(dir: string, path: unknown, text: unknown, expectedHash: unknown, opts: SaveCodeFileOptions): Promise<{ ok: true; hash: string } | Refused> {
  if (typeof text !== 'string' || typeof expectedHash !== 'string') return refuse('refused', 'That is not a save the workspace can make.');
  // Saves of one file take turns, so two made from the same read can never both find it as read before either lands.
  const key = join(dir, typeof path === 'string' ? path : '');
  const before = saving.get(key) ?? Promise.resolve();
  const mine = before.then(() => saveNow(dir, path, text, expectedHash, opts));
  const settled = mine.then(
    () => undefined,
    () => undefined
  );
  saving.set(key, settled);
  try {
    return await mine;
  } finally {
    if (saving.get(key) === settled) saving.delete(key);
  }
}

/** The save of each file under way, by its path, which the next save of it waits for. */
const saving = new Map<string, Promise<void>>();

async function saveNow(dir: string, path: unknown, text: string, expectedHash: string, opts: SaveCodeFileOptions): Promise<{ ok: true; hash: string } | Refused> {
  const refused = policy(path, opts.appWrites);
  if (refused) return refused;
  const rel = path as string;
  const found = await checkedFile(dir, rel);
  if (!found.ok) return found;
  const read = await readChecked(rel, found.abs, found.st);
  if (!read.ok) return read;
  if (sha(read.bytes) !== expectedHash) return changedOnDisk(rel);
  const data = fileBytes(text, read.bytes);
  if (data.length > MAX_CODE_FILE_BYTES) return tooLarge(rel);
  const mode = Number(found.st.mode & 0o7777n);
  let late: Refused | null = null;
  const stop = (why: Refused) => ((late = why), false);
  /** Still the same file, still holding what was read, still the project's own, in an opening still open. */
  const still = async (): Promise<boolean> => {
    if (!opts.open()) return stop(refuse('closed', 'The project was closed before this file could be saved.'));
    const again = policy(rel, opts.appWrites);
    if (again) return stop(again);
    const now = await checkedFile(dir, rel);
    if (!now.ok) return stop(now);
    if (now.st.dev !== found.st.dev || now.st.ino !== found.st.ino) return stop(changedOnDisk(rel));
    const bytes = await readChecked(rel, now.abs, now.st);
    if (!bytes.ok) return stop(bytes);
    if (sha(bytes.bytes) !== expectedHash) return stop(changedOnDisk(rel));
    // Asked once more after those reads: the opening may have closed (or Developer mode gone) while they ran.
    return opts.open() || stop(refuse('closed', 'The project was closed before this file could be saved.'));
  };
  let replaced = false;
  let failed: Error | null = null;
  const fenced = await opts.fence(async () => {
    try {
      replaced = await atomicWrite(found.abs, data, { mode, beforeReplace: still, retryCheck: still });
    } catch (e) {
      failed = e as Error;
    }
  });
  if (!fenced) return refuse('closed', 'The project was closed before this file could be saved.');
  if (failed) return refuse('refused', `${rel} could not be saved: ${(failed as Error).message}`);
  if (!replaced) return late ?? changedOnDisk(rel);
  return { ok: true, hash: sha(data) };
}

const changedOnDisk = (path: string) => refuse('changed', `${path} changed on disk since it was opened, so it was not saved.`);
