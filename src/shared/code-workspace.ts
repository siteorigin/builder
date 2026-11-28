/**
 * The code workspace (#1483): the project's own code files, read and saved from the app as an outside code editor
 * would, the checks and tests a developer runs on the project, and the hand-off to their own code editor. Shared by
 * the main process, which owns every file and process, and the editor, which only asks.
 *
 * A project's own code is every hand-written file under `src/` the app neither writes nor will write: helpers under
 * `src/lib/` (outside `src/lib/siteorigin/`, which is the app's), endpoints, loaders, hooks and pages of the project's
 * own under `src/routes/`, and param matchers. Code components keep their own editor and save through the project's
 * documents; generated files are read from their own views.
 */

/** The kinds of code file the workspace opens, by extension. */
export const CODE_FILE_LANGUAGES = {
  '.svelte': 'svelte',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.css': 'css',
  '.json': 'json'
} as const;

export type CodeLanguage = (typeof CODE_FILE_LANGUAGES)[keyof typeof CODE_FILE_LANGUAGES];

/** The largest file the workspace opens, in bytes as stored: a larger one is listed, to open in the developer's own editor. */
export const MAX_CODE_FILE_BYTES = 512 * 1024;

/** The most files one listing holds: a project with more is listed in part, and says so. */
export const MAX_CODE_FILES = 2000;

/** The folder the app keeps for itself: generated components, the runtime, styles, fonts and code components. */
export const APP_CODE_DIR = 'src/lib/siteorigin';

/** The language of a code file the workspace opens, or null for any other file. */
export function codeLanguage(path: string): CodeLanguage | null {
  const dot = path.lastIndexOf('.');
  if (dot <= path.lastIndexOf('/')) return null;
  const ext = path.slice(dot).toLowerCase() as keyof typeof CODE_FILE_LANGUAGES;
  return Object.hasOwn(CODE_FILE_LANGUAGES, ext) ? CODE_FILE_LANGUAGES[ext] : null;
}

/** A part Windows reads as a device, whatever follows its first dot. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Why `path` can never name one of the project's own code files, or null when it may: a project-relative path with
 * forward slashes under `src/`, every part a plain name (no `.` or `..`, no backslash, colon or other character a disk
 * reads as something else, no Windows device, no trailing dot or space, nothing hidden, no `node_modules`), outside the
 * folder the app keeps, ending in a code file's extension. Whether a file is there, and whether the app writes it, is for the main process to say.
 */
export function codePathProblem(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return 'That is not a file of the project.';
  if (path.length > 1024 || /[\0-\x1f\\:*?"<>|]/.test(path)) return 'That is not a file name the workspace can open.';
  const parts = path.split('/');
  if (parts[0] !== 'src' || parts.length < 2) return 'The workspace opens the project’s own code under src/.';
  for (const part of parts) if (!part || part === '.' || part === '..' || WINDOWS_DEVICE.test(part) || /[. ]$/.test(part)) return 'That is not a file name the workspace can open.';
  // What a listing passes by is never reached by name either: hidden files and folders, and installed packages.
  if (parts.some((part) => part.startsWith('.') || part === 'node_modules')) return 'The workspace does not open hidden files or installed packages.';
  if (isAppCodePath(path)) return 'SiteOrigin Builder makes the files in src/lib/siteorigin/: edit a code component from its own entry instead.';
  if (!codeLanguage(path)) return 'The workspace opens Svelte, JavaScript, TypeScript, CSS and JSON files.';
  return null;
}

/** Whether `path` is in the folder the app keeps, compared as a case-insensitive disk would. */
export function isAppCodePath(path: string): boolean {
  const folded = path.toLowerCase();
  return folded === APP_CODE_DIR || folded.startsWith(`${APP_CODE_DIR}/`);
}

/** One of the project's own code files, as a listing gives it. */
export interface CodeFileEntry {
  /** Project-relative, with forward slashes, spelled as the disk has it. */
  path: string;
  /** Its size in bytes. */
  size: number;
}

export type CodeFileList =
  | {
      ok: true;
      files: CodeFileEntry[];
      /** More files than a listing holds (MAX_CODE_FILES): the rest are left out. */
      truncated: boolean;
      /** Why nothing listed can be saved from the workspace (a read-only project), or null when it can. */
      readOnly: string | null;
    }
  | { ok: false; message: string };

/** Why a file could not be read or saved, for the editor to say and act on. */
export type CodeFileRefusal =
  /** Not there any more. */
  | 'gone'
  /** The app writes it (or will): it is no longer the project's own. */
  | 'claimed'
  /** Larger than the workspace opens. */
  | 'too-large'
  /** Not UTF-8 text. */
  | 'binary'
  /** Changed on disk since it was read: saving would replace that. */
  | 'changed'
  /** The project cannot be written from here (read-only, Developer mode off). */
  | 'read-only'
  /** The project was closed, or another opening replaced it. */
  | 'closed'
  /** Anything else: a path that is no code file of the project's, a link, a write that failed. */
  | 'refused';

export type CodeFileRead =
  | {
      ok: true;
      path: string;
      /** The text with its line breaks as `\n` and without a byte order mark: the editor's form of it. */
      text: string;
      /** The SHA-256 of the file's bytes as they are on disk: what a save says it was made from. */
      hash: string;
      /** Why the file cannot be saved from the workspace, or null when it can. */
      readOnly: string | null;
    }
  | { ok: false; reason: CodeFileRefusal; message: string };

export type CodeFileSave = { ok: true; hash: string } | { ok: false; reason: CodeFileRefusal; message: string };

/** What the developer's own code editor opens: a project code file, a code component's file, or the project's folder. */
export type EditorTarget = { kind: 'file'; path: string } | { kind: 'component'; definitionId: string } | { kind: 'project' };

/** The code editor the app hands files to: the system's default app for each file, or one the developer chose. */
export type ExternalEditor = { kind: 'system' } | { kind: 'app'; path: string; name: string };

/** What a hand-off to the developer's code editor came to: done, or why not. */
export type EditorOpenResult = { ok: true } | { ok: false; message: string; /** The chosen editor could not be started: choose another. */ chooseAgain?: boolean };

/** The checks the workspace runs on a project. svelte: compile every Svelte file; test: the project's own `npm test`. */
export type ProjectCheckTask = 'svelte' | 'test';

/** A problem a check found in one place. */
export interface ProjectCheckProblem {
  /** The project file it is in, when it names one. */
  file?: string;
  line?: number;
  message: string;
}

export type ProjectCheckStatus = 'running' | 'passed' | 'failed' | 'cancelled' | 'timed-out' | 'not-started';

/** A check's run as it stands: sent as it goes (`project-check:update`), and once more when it ends. */
export interface ProjectCheckRun {
  runId: string;
  task: ProjectCheckTask;
  /** The project opening it runs in: an update for any other is not this project's. */
  opening: string;
  status: ProjectCheckStatus;
  /** What the run said, oldest first, with secrets masked; long output keeps its first errors and its end. */
  lines: string[];
  problems: ProjectCheckProblem[];
  /** One line on how it ended, or why it could not start. */
  summary?: string;
  /** How many Svelte files were compiled. */
  files?: number;
  exitCode?: number | null;
  startedAt: number;
  endedAt?: number;
}

/** How long a project's tests may run before they are stopped. */
export const PROJECT_TEST_TIMEOUT_MS = 5 * 60_000;

/** A line the preview server logged, for the workspace's Preview log. */
export interface PreviewLogLine {
  /** Increases with each line the server logs, so a later ask gets only what is new. */
  seq: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  time: number;
}
