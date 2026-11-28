import { renameSync } from 'node:fs';
import { createMainLog, type MainLog } from './main-log';

/**
 * The app's trace (logs/trace.log beside main.log): what it does step by step, kept on this computer so a problem that
 * shows no error (an open that never finishes, a preview that never shows) can be read back afterwards. Nothing is sent
 * anywhere. It is on by default and clears itself: each launch starts the file afresh, keeping the launch before as
 * trace.log.1, and past its size cap it moves aside the same way, so it never holds more than two files' worth.
 *
 * Each line is one synchronous append (main-log.ts), so the last steps before a hang or a crash are in it, timed from
 * the launch: `2026-11-28T15:44:08.135Z [trace] +1203ms open: …`. Traces carry folders, names, states and timings, never
 * what a project's pages or an AI chat say. Until startTrace runs (a unit test, a worker), trace does nothing.
 */

let log: MainLog | null = null;
let began = Date.now();

export interface TraceOptions {
  /** Past this size the file moves aside (default 4 MiB). */
  maxBytes?: number;
  now?: () => Date;
}

/** Start this launch's trace in `file`, moving the last launch's aside. */
export function startTrace(file: string, { maxBytes = 4 * 1024 * 1024, now = () => new Date() }: TraceOptions = {}): void {
  try {
    renameSync(file, `${file}.1`);
  } catch {
    // No trace yet, or it could not move: this launch's lines follow the last one's.
  }
  began = now().getTime();
  log = createMainLog({ file, maxBytes, maxEntry: 2000, now });
  log.write('trace', '+0ms trace: started');
}

/** One step, under `area` (open, ipc, preview, editor…). Formatted as console.log formats its arguments. */
export function trace(area: string, ...args: unknown[]): void {
  if (!log) return;
  log.write('trace', `+${Date.now() - began}ms ${area}:`, ...args);
}

/** Stop tracing (tests). */
export function stopTrace(): void {
  log = null;
}

/** An error's message, for a trace line. */
export const traced = (e: unknown): string => (e instanceof Error ? e.message : String(e));
