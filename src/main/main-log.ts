import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { format, inspect } from 'node:util';

/**
 * The main process's log (#887): the errors and warnings it meets, kept in a file on this computer that a person can
 * attach to a bug report (Help > Show Log File). Nothing is sent anywhere.
 *
 * Each launch writes one line naming the build, so an error later in the file can be read against the build that met
 * it. Writes are synchronous appends, so what was written survives a crash a moment later, and a launch never
 * truncates what an earlier one wrote: past the size cap the file moves aside to `.1` (replacing the one before) and a
 * new one starts. A write that fails is dropped: logging never throws, and never logs its own failure.
 */

export interface MainLogOptions {
  /** The log file. */
  file: string;
  /** Past this size the file moves aside (default 1 MiB). */
  maxBytes?: number;
  /** One entry's text is cut to this many characters (default 8000). */
  maxEntry?: number;
  now?: () => Date;
}

export type LogLevel = 'start' | 'error' | 'warn' | 'uncaught';

export interface MainLog {
  readonly file: string;
  /** Append one entry. Arguments are formatted as console.log formats them; errors keep their stack. */
  write(level: LogLevel, ...args: unknown[]): void;
  /** Make sure the file exists (empty if nothing was written yet), so it can be revealed. False when it cannot be made. */
  ensure(): boolean;
}

export function createMainLog({ file, maxBytes = 1024 * 1024, maxEntry = 8000, now = () => new Date() }: MainLogOptions): MainLog {
  const ensure = () => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, '');
      return true;
    } catch {
      return false;
    }
  };
  return {
    file,
    ensure,
    write(level, ...args) {
      try {
        let text = format(...args.map((a) => (a instanceof Error ? inspect(a) : a)));
        if (text.length > maxEntry) text = `${text.slice(0, maxEntry)}… (${text.length - maxEntry} more characters)`;
        const line = `${now().toISOString()} [${level}] ${text}\n`;
        mkdirSync(dirname(file), { recursive: true });
        let size = 0;
        try {
          size = statSync(file).size;
        } catch {
          size = 0;
        }
        if (size > 0 && size + Buffer.byteLength(line) > maxBytes) renameSync(file, `${file}.1`);
        appendFileSync(file, line);
      } catch {
        // Logging never throws.
      }
    }
  };
}

/** Where the log hears from: the console's error and warning output, and the process's uncaught exceptions and warnings. */
export interface LogSources {
  console: Pick<Console, 'error' | 'warn'>;
  process: Pick<NodeJS.Process, 'on' | 'off'>;
}

/**
 * Keep what the main process reports in the log as well: console.error and console.warn still print as before, an
 * uncaught exception is recorded without changing how the process handles it (uncaughtExceptionMonitor), and process
 * warnings (an unhandled rejection Node only warns about, a deprecation) are recorded too. Returns what undoes it.
 */
export function captureMainErrors(log: MainLog, { console: con, process: proc }: LogSources): () => void {
  const error = con.error;
  const warn = con.warn;
  con.error = (...args: unknown[]) => {
    error.apply(con, args);
    log.write('error', ...args);
  };
  con.warn = (...args: unknown[]) => {
    warn.apply(con, args);
    log.write('warn', ...args);
  };
  const uncaught = (e: unknown, origin: string) => log.write('uncaught', `${origin}:`, e);
  const warning = (w: Error) => log.write('warn', w);
  proc.on('uncaughtExceptionMonitor', uncaught);
  proc.on('warning', warning);
  return () => {
    con.error = error;
    con.warn = warn;
    proc.off('uncaughtExceptionMonitor', uncaught);
    proc.off('warning', warning);
  };
}
