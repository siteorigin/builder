/**
 * Opening a file or the project's folder in the developer's own code editor (#1483). The editor is the system's
 * default app for each file (Electron's shell.openPath), or an application the developer chose once in Settings:
 * started with the file or folder as its one argument, never through a shell, so nothing in a path is read as a
 * command. On macOS an application is a bundle, which `open -a` starts; elsewhere it is the editor's own executable.
 *
 * In an automated run nothing is started: the hand-off is recorded (see headless-desktop.ts), as every other
 * hand-off to the desktop is.
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { basename, isAbsolute, posix, win32 } from 'node:path';
import type { EditorOpenResult, ExternalEditor } from '@shared/code-workspace';

/** How an application the developer chose is started with `target`: a command and its arguments, run without a shell. */
export function editorLaunch(editor: { path: string }, target: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  // `--` ends open's own options, so a target that starts with a dash is still a file.
  if (platform === 'darwin') return { command: '/usr/bin/open', args: ['-a', editor.path, '--', target] };
  return { command: editor.path, args: [target] };
}

/**
 * Whether `path` is an application this platform can start as a code editor, and its name as Settings shows it, or why
 * not: on macOS an application bundle (`.app`), on Windows a program (`.exe`; a `.cmd` or `.bat` shim runs through a
 * shell, so the program itself is chosen), elsewhere an executable file.
 */
export function checkEditorApp(path: unknown, platform: NodeJS.Platform = process.platform, stat: (p: string) => { isDirectory(): boolean; isFile(): boolean; mode: number } | null = statOrNull): { ok: true; editor: Extract<ExternalEditor, { kind: 'app' }> } | { ok: false; message: string } {
  // Read with the platform's own path rules, so a Windows path is read as Windows reads it wherever this runs.
  const paths = platform === 'win32' ? win32 : posix;
  if (typeof path !== 'string' || !paths.isAbsolute(path)) return { ok: false, message: 'Choose your code editor’s application.' };
  const st = stat(path);
  const ext = paths.extname(path).toLowerCase();
  const name = paths.basename(path, paths.extname(path)) || paths.basename(path);
  if (platform === 'darwin') {
    if (ext !== '.app' || !st?.isDirectory()) return { ok: false, message: 'Choose an application, such as Visual Studio Code or Cursor in your Applications folder.' };
  } else if (platform === 'win32') {
    if (ext !== '.exe' || !st?.isFile()) return { ok: false, message: ext === '.cmd' || ext === '.bat' ? `${paths.basename(path)} starts the editor through a command prompt. Choose the editor’s own program (.exe) instead, such as Code.exe in its install folder.` : 'Choose your code editor’s program (.exe).' };
  } else if (!st?.isFile() || (st.mode & 0o111) === 0) return { ok: false, message: 'Choose your code editor’s program: a file that can be run, such as /usr/bin/code.' };
  return { ok: true, editor: { kind: 'app', path, name } };
}

function statOrNull(p: string) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

export interface EditorHandOff {
  /** The system's default app for a file, or the file manager for a folder: '' when it opened, else what went wrong. */
  openPath(path: string): Promise<string>;
  /** Show a file in the system's file manager. */
  reveal(path: string): void;
  /** Start the chosen application with `target`, and settle once it has started; rejects when it could not be. */
  launch(editor: { path: string; name: string }, target: string): Promise<void>;
}

/** The hand-off a normal launch makes: Electron's openPath, and the application started detached from the app. */
export function desktopHandOff(openPath: (path: string) => Promise<string>, reveal: (path: string) => void): EditorHandOff {
  return {
    openPath,
    reveal,
    launch: (editor, target) => {
      const { command, args } = editorLaunch(editor, target);
      return startDetached(command, args);
    }
  };
}

/** Files Windows runs, rather than opens for editing, when its default action is asked for. */
const RUN_ON_WINDOWS = /\.(c|m)?js$|\.(jse|vbs|vbe|wsf|wsh|cmd|bat|ps1)$/i;

/** The hand-off an automated run makes instead (headless-desktop.ts records it), set before anything can be opened. */
let replaced: EditorHandOff | null = null;

/** Who carries out each hand-off from now on, in place of the one the caller passes; null for that one again. */
export function setEditorHandOff(h: EditorHandOff | null): void {
  replaced = h;
}

/** How long `open -a` gets to say whether it started the application. */
const OPEN_WAIT_MS = 10_000;

/** Starts a program detached from the app and settles once it has started, or once `open` has finished. */
export function startDetached(command: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false });
    const waitsForExit = command === '/usr/bin/open';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (e?: Error) => {
      if (timer) clearTimeout(timer);
      child.removeAllListeners();
      child.unref();
      if (e) reject(e);
      else resolve();
    };
    child.once('error', (e) => done(e));
    if (waitsForExit) {
      timer = setTimeout(() => done(), OPEN_WAIT_MS);
      child.once('exit', (code) => done(code === 0 ? undefined : new Error(`open finished with code ${code}`)));
    } else child.once('spawn', () => done());
  });
}

/**
 * Open `target` (an absolute path, checked by the caller to be inside the open project) in `editor`, through `real`
 * (desktopHandOff) unless an automated run replaced it.
 */
export async function openInEditor(editor: ExternalEditor, target: string, real: EditorHandOff, platform: NodeJS.Platform = process.platform): Promise<EditorOpenResult> {
  const via = replaced ?? real;
  // Windows runs a script it is asked to open (Windows Script Host takes .js): it is shown in File Explorer instead.
  if (editor.kind === 'system' && platform === 'win32' && RUN_ON_WINDOWS.test(target)) {
    via.reveal(target);
    return { ok: false, message: `${win32.basename(target)} is shown in File Explorer: Windows would run it rather than open it for editing. Choose your code editor in Settings to open files in it directly.`, chooseAgain: true };
  }
  if (editor.kind === 'system') {
    const failed = await via.openPath(target).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    return failed ? { ok: false, message: `Your computer could not open ${basename(target)}: ${failed}` } : { ok: true };
  }
  try {
    await via.launch(editor, target);
    return { ok: true };
  } catch {
    return { ok: false, message: `${editor.name} could not be started. It may have been moved or removed: choose your code editor again in Settings.`, chooseAgain: true };
  }
}

/** An editor setting as read from a hand-edited settings file: anything that is not a usable choice is the system's default. */
export function storedEditor(v: unknown): ExternalEditor {
  const e = v as { kind?: unknown; path?: unknown; name?: unknown } | null;
  if (e && e.kind === 'app' && typeof e.path === 'string' && isAbsolute(e.path) && typeof e.name === 'string' && e.name) return { kind: 'app', path: e.path, name: e.name };
  return { kind: 'system' };
}
