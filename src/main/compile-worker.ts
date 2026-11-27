/**
 * Compile worker (Electron utility process): compiles the generated Svelte files a build check hands it
 * (compile-client.ts), so a check of a large site never holds up the editor's main process. It loads the compiler
 * once, on its first batch, and keeps it.
 */
import type { Session } from 'node:inspector';
import { compileFile, type CompileReply, type CompileRequest } from './compile-file';

const port = (process as unknown as { parentPort: { on: (e: 'message', cb: (ev: { data: CompileRequest }) => void) => void; postMessage: (m: CompileReply) => void } }).parentPort;

let compiler: Promise<typeof import('svelte/compiler')> | null = null;

/**
 * Once a batch is answered, what compiling it allocated is collected, so the worker waits for the next check holding
 * its compiler and little else. Through the process's own inspector (connected in-process: no port is opened), since
 * Electron does not pass `--expose-gc` on to a utility process. Best effort: the inspector is loaded only here, so a
 * runtime without one, or a collection that cannot be made, changes nothing a check is told.
 */
let inspector: Session | null = null;
function collect() {
  try {
    if (!inspector) {
      const { Session } = process.getBuiltinModule('node:inspector');
      inspector = new Session();
      inspector.connect();
    }
    inspector.post('HeapProfiler.collectGarbage', () => {});
  } catch {
    inspector = null;
  }
}

port.on('message', async ({ data: m }) => {
  try {
    const { compile } = await (compiler ??= import('svelte/compiler'));
    let runs = 0;
    const outcomes = m.files.map(([path, source]) => compileFile(compile, path, source, () => runs++));
    port.postMessage({ id: m.id, ok: true, outcomes, runs });
  } catch (e) {
    port.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
  setImmediate(collect);
});
