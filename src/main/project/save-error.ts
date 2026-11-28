import { statSync } from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import type { SaveFailure } from '@shared/api';
import type { ApplyResult } from '@shared/ops';

/**
 * What became of a save that could not be written to the project's folder. `failed`: nothing of it was written, and it
 * can be made again. `unfinished`: its journal is on disk, and reopening the project finishes it. `landed`: its documents
 * are in place, and only the rest of the save (the site's files made from them, History) is left for reopening to
 * finish. `blocked`: nothing of it was written, and nothing more is saved until the project is reopened, which finishes
 * an earlier save at most, never this one.
 */
export type WriteFailure = SaveFailure['kind'] | 'landed' | 'blocked';

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
 * and what to do (see WriteFailure). Never the system's error code, the temporary file's name or the whole path.
 */
export function saveFailureMessage(e: unknown, projectDir: string, kind: WriteFailure): string {
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
          : systemError(e)
            ? { what: `${folder} could not be written to`, fix: 'Check that you can save files there' }
            : // Not a file system error: the reason is already in words of its own.
              { what: e instanceof Error && e.message ? e.message.replace(/\.$/, '') : 'something went wrong' };
  const then = (rest: string) => (why.fix ? `${why.fix}, then ${rest}` : rest.charAt(0).toUpperCase() + rest.slice(1));
  if (kind === 'unfinished') return `That change is not saved yet: ${why.what}. ${then('close and reopen the project to finish saving it.')}`;
  if (kind === 'landed') return `That change is saved, but saving did not finish: ${why.what}. ${then('close and reopen the project to finish.')}`;
  if (kind === 'blocked') return `That change could not be saved: ${why.what}. ${then('close and reopen the project, and make the change again.')}`;
  return `That change could not be saved: ${why.what}.${why.fix ? ` ${why.fix}, then try again.` : ''}`;
}

/** Whether `e` is the system's account of a file operation that failed (it carries an error code such as EACCES). */
const systemError = (e: unknown) => /^E[A-Z0-9]+$/.test(String((e as { code?: unknown } | null)?.code ?? ''));

/**
 * The editor's change as it lands (Controller.apply), or, when it could not be written to the project's folder, a
 * refusal that says so in plain words (which folder, and what reopening the project does for it), for the editor to
 * keep what was typed. A file system error that never reached the save (the project's lock could not be checked, say)
 * wrote nothing of it. Any other error is thrown as it is. An AI run's save is never answered this way: its failure
 * ends the run, which rolls back.
 */
export async function written(session: { readonly dir: string; readonly revision: number; writeFailure(e: unknown): WriteFailure | null }, applying: Promise<ApplyResult>): Promise<ApplyResult> {
  try {
    return await applying;
  } catch (e) {
    const kind = session.writeFailure(e) ?? (systemError(e) ? 'failed' : null);
    if (!kind) throw e;
    return { ok: false, revision: session.revision, error: { code: 'SAVE_FAILED', message: saveFailureMessage(e, session.dir, kind), recoverable: kind === 'failed', details: { save: kind } } };
  }
}
