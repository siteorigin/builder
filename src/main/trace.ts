import { rmSync } from 'node:fs';
import { createMainLog, type MainLog } from './main-log';

/**
 * A developer's trace of the app (logs/trace.log beside main.log, in the app's own data folder, never a project's or
 * the source's): what it does step by step, so a problem that shows no error (an open that never finishes, a preview
 * that never shows) can be read back afterwards. Nothing is sent anywhere. On in a build run from the source and with
 * Developer mode on (index.ts), and it holds one launch only: each launch removes the last one's trace, whether it
 * traces or not, and past its size cap a trace moves aside to trace.log.1 (replacing the one before), so the folder
 * never holds more than two files of one launch.
 *
 * Each line is one synchronous append (main-log.ts), so the last steps before a hang or a crash are in it, timed from
 * the start: `2026-11-28T15:44:08.135Z [trace] +1203ms open: …`. Lines carry folders, names, states and timings, never
 * what a project's pages or an AI chat say. Until startTrace runs (a unit test, a worker), trace does nothing.
 */

let log: MainLog | null = null;
let began = Date.now();

export interface TraceOptions {
  /** Past this size the file moves aside (default 4 MiB). */
  maxBytes?: number;
  now?: () => Date;
}

/** Remove the trace in `file` and the part of it moved aside. */
export function clearTrace(file: string): void {
  for (const f of [file, `${file}.1`]) {
    try {
      rmSync(f, { force: true });
    } catch {
      // A trace that cannot be removed is written after.
    }
  }
}

/**
 * Start a trace in `file`, in place of any there; or, `resumed`, after what this launch has written already (tracing
 * turned off and on again keeps it).
 */
export function startTrace(file: string, { maxBytes = 4 * 1024 * 1024, now = () => new Date(), resumed = false }: TraceOptions & { resumed?: boolean } = {}): void {
  const at = now().getTime();
  if (!resumed) {
    clearTrace(file);
    began = at;
  }
  log = createMainLog({ file, maxBytes, maxEntry: 2000, now });
  log.write('trace', `+${at - began}ms trace: ${resumed ? 'resumed' : 'started'}`);
}

/** Whether a trace is being written. */
export const tracing = (): boolean => log !== null;

/** One step, under `area` (open, ipc, preview, editor…). Formatted as console.log formats its arguments. */
export function trace(area: string, ...args: unknown[]): void {
  if (!log) return;
  log.write('trace', `+${Date.now() - began}ms ${area}:`, ...args);
}

/** Stop tracing: what was written stays until the next launch removes it. */
export function stopTrace(): void {
  log = null;
}

/** An error's message, for a trace line: never throws, whatever was thrown. */
export function traced(e: unknown): string {
  try {
    return e instanceof Error ? String(e.message) : String(e);
  } catch {
    return 'an error that cannot be shown';
  }
}
