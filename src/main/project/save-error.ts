import { statSync } from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import type { SaveFailure } from '@shared/api';
import type { ApplyResult } from '@shared/ops';

/**
 * The folder a failed file operation could not write in, relative to the project folder and written with `/` ('' for
 * the project folder itself), or null when the error names no path or one outside the project. Only the folder is
 * named, never the file: a save writes a hidden temporary file first, whose name means nothing to the author.
 */
export function failedFolder(e: unknown, projectDir: string): string | null {
  const err = e as { path?: unknown; dest?: unknown } | null;
  // A rename names the file it was moving onto last.
  const target = typeof err?.dest === 'string' ? err.dest : typeof err?.path === 'string' ? err.path : null;
  if (!target) return null;
  // A folder opened to flush it is the folder itself; anything else is written in the folder that holds it.
  let folder = dirname(target);
  try {
    if (statSync(target).isDirectory()) folder = target;
  } catch {
    /* Not there: a file that was being made. */
  }
  const rel = relative(projectDir, folder);
  if (rel === '') return '';
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return rel.split(sep).join('/');
}

/**
 * What the editor says about a change that could not be written to the project's folder: which folder, in plain words,
 * and what to do. Never the system's error code, the temporary file's name or the whole path. `unfinished`: its journal
 * is on disk, so closing and reopening the project finishes it once the folder can be written to.
 */
export function saveFailureMessage(e: unknown, projectDir: string, kind: SaveFailure['kind']): string {
  const code = (e as { code?: unknown } | null)?.code;
  const rel = failedFolder(e, projectDir);
  const folder = rel === null ? 'a folder it is saved in' : rel === '' ? 'the project folder' : `the folder “${rel}”`;
  const why: { what: string; fix?: string } =
    code === 'ENOSPC' || code === 'EDQUOT'
      ? { what: 'there is not enough space on the disk', fix: 'Free up some space' }
      : code === 'EROFS'
        ? { what: `${folder} is on a drive that cannot be written to`, fix: 'Move the project to a drive you can save to' }
        : code === 'EACCES' || code === 'EPERM'
          ? { what: `${folder} cannot be written to`, fix: 'Check that you can save files there' }
          : typeof code === 'string'
            ? { what: `${folder} could not be written to`, fix: 'Check that you can save files there' }
            : // Not a file system error: the reason is already in words of its own.
              { what: e instanceof Error && e.message ? e.message.replace(/\.$/, '') : 'something went wrong' };
  if (kind === 'unfinished') return `That change is not saved yet: ${why.what}. ${why.fix ? `${why.fix}, then close` : 'Close'} and reopen the project to finish saving it.`;
  return `That change could not be saved: ${why.what}.${why.fix ? ` ${why.fix}, then try again.` : ''}`;
}

/**
 * The editor's change as it lands (Controller.apply), or, when it could not be written to the project's folder, a
 * refusal that says so in plain words (which folder, and whether reopening the project finishes it), for the editor to
 * keep what was typed. Any other error is thrown as it is. An AI run's save is never answered this way: its failure
 * ends the run, which rolls back.
 */
export async function written(session: { readonly dir: string; readonly revision: number; writeFailure(e: unknown): SaveFailure['kind'] | null }, applying: Promise<ApplyResult>): Promise<ApplyResult> {
  try {
    return await applying;
  } catch (e) {
    const kind = session.writeFailure(e);
    if (!kind) throw e;
    return { ok: false, revision: session.revision, error: { code: 'SAVE_FAILED', message: saveFailureMessage(e, session.dir, kind), recoverable: kind === 'failed', details: { save: kind } } };
  }
}
