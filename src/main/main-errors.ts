/**
 * An error nothing in the main process caught (#886), reported in the app's own words instead of Electron's raw stack
 * dialog. Once the app is running, the person is told what went wrong and may quit (the normal quit, which still saves
 * what is being typed and closes the project) or keep working; one question shows at a time, and further errors while
 * it is open are only logged. Before the app is ready nothing is open yet, so it says it could not start, and exits.
 *
 * No electron import: the caller passes the dialog and app calls, so this is tested with stand-ins.
 */

export interface MainErrorOptions {
  /** Whether the app has finished starting (Electron's app.isReady). */
  ready: () => boolean;
  log: (...args: unknown[]) => void;
  /** Ask whether to quit. Resolves with the button chosen. */
  ask: (report: { message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number }) => Promise<number>;
  /** A synchronous error box, which works before the app is ready. */
  errorBox: (title: string, content: string) => void;
  quit: () => void;
  exit: (code: number) => void;
}

/** What went wrong, in one line. */
export function errorText(error: unknown): string {
  try {
    return describe(error);
  } catch {
    return 'An unknown error.';
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  const text = typeof error === 'string' ? error : (() => {
    try {
      return JSON.stringify(error) ?? String(error);
    } catch {
      return String(error);
    }
  })();
  return text || 'An unknown error.';
}

export const MAIN_ERROR_BUTTONS = ['Quit', 'Keep Working'];

/** Where a report goes, as a person would type it from a dialog that has no link. */
const REPORT_ADDRESS = 'github.com/siteorigin/builder/issues';

/** What to do after an error nothing caught, in general. */
const RUNNING = 'Your saved work is safe. Quit and open SiteOrigin Builder again to carry on. Choose Keep Working only to copy text you were still typing.';
/** A full disk is the one cause a restart alone does not fix: it says what does. */
const DISK_FULL = 'Your saved work is safe, but the disk is full, so new changes cannot be saved. If you were still typing, choose Keep Working to copy that text. Then quit, free up disk space, and open SiteOrigin Builder again.';

function diskFull(error: unknown): boolean {
  try {
    return (error as { code?: unknown } | null)?.code === 'ENOSPC';
  } catch {
    return false;
  }
}

export function mainErrorReport(error: unknown) {
  return {
    message: 'SiteOrigin Builder ran into a problem',
    // Plain words first, the technical message last. Quitting closes the project the normal way, but a save is never
    // promised: the error may be the reason one cannot happen (a full disk).
    detail: `${diskFull(error) ? DISK_FULL : RUNNING}\n\nIf this keeps happening, choose Help > Report a Problem.\n\nDetails: ${errorText(error)}`,
    buttons: [...MAIN_ERROR_BUTTONS],
    defaultId: 0,
    // Closing the question keeps the app running, as Keep Working does.
    cancelId: 1
  };
}

export function startupErrorReport(error: unknown) {
  // OK quits, so the app's Help menu is out of reach: the report address is given in words.
  return {
    title: 'SiteOrigin Builder could not start',
    content: `Your projects are safe. Try opening SiteOrigin Builder again. If it still does not start, reinstall it, and report the problem at ${REPORT_ADDRESS}.\n\nDetails: ${errorText(error)}`
  };
}

/** The handler for process 'uncaughtException'. It never throws, and nothing it calls can make it throw. */
export function createMainErrorReporter(opts: MainErrorOptions) {
  let asking = false;
  const log = (...args: unknown[]) => {
    try {
      opts.log(...args);
    } catch {
      // Nowhere left to say it.
    }
  };
  const attempt = (what: () => void) => {
    try {
      what();
    } catch (e) {
      log('The error could not be reported:', e);
    }
  };
  const ready = () => {
    try {
      return opts.ready();
    } catch {
      return false;
    }
  };
  return (error: unknown) => {
    log('An error in the main process was not handled:', error);
    if (!ready()) {
      attempt(() => {
        const { title, content } = startupErrorReport(error);
        opts.errorBox(title, content);
      });
      attempt(() => opts.exit(1));
      return;
    }
    if (asking) return;
    asking = true;
    let asked: Promise<number>;
    try {
      asked = Promise.resolve(opts.ask(mainErrorReport(error)));
    } catch (e) {
      asking = false;
      log('The error could not be reported:', e);
      return;
    }
    asked.then(
      (button) => {
        asking = false;
        if (button === 0) attempt(() => opts.quit());
      },
      (e: unknown) => {
        asking = false;
        log('The error could not be reported:', e);
      }
    );
  };
}
