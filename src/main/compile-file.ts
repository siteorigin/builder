/**
 * Compiling one generated Svelte file as the website's build does: shared by the build checks in the main process
 * (compile.ts) and the compile worker they hand large checks to (compile-worker.ts). Nothing here may import more than
 * the compiler: the worker loads only this.
 */

/** Why a Svelte file did not compile, as the compiler said it: what a build check reports. */
export interface CompileFailure {
  message: string;
  code?: string;
  start?: { line: number };
  end?: { line?: number };
  /**
   * The compiler itself failed (it ran out of stack on a deeply nested file, say) rather than finding a fault in the
   * source: reported like any failure, but never kept as the file's outcome, since compiling it again may succeed.
   */
  unexpected?: true;
}

export type Compile = (typeof import('svelte/compiler'))['compile'];

/**
 * Compile one Svelte file both ways, as the website is built: pages are prerendered (server) and hydrated (client), so
 * a file must compile for each. The first failure, or null when it compiles. `ran` is told of each compiler run.
 */
export function compileFile(compile: Compile, path: string, source: string, ran: () => void = () => {}): CompileFailure | null {
  for (const generate of ['client', 'server'] as const) {
    try {
      ran();
      compile(source, { filename: path, generate, runes: true });
    } catch (e) {
      // Only what a build check reads: the compiler's error holds the parsed source as well.
      const err = e as CompileFailure & { name?: unknown };
      return {
        message: err.message,
        ...(err.code !== undefined ? { code: err.code } : {}),
        ...(err.start ? { start: { line: err.start.line } } : {}),
        ...(err.end ? { end: { line: err.end.line } } : {}),
        // Svelte names every fault it finds in a source a CompileError (svelte/src/compiler/errors.js).
        ...(err.name === 'CompileError' ? {} : { unexpected: true as const })
      };
    }
  }
  return null;
}

/** A batch of files for a compile worker, each as `[path, source]`, and what it says back. */
export interface CompileRequest {
  id: number;
  files: Array<[string, string]>;
}
export type CompileReply = { id: number; ok: true; outcomes: Array<CompileFailure | null>; runs: number } | { id: number; ok: false; error: string };
