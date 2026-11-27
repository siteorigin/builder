/**
 * Compile worker (Electron utility process): compiles the generated Svelte files a build check hands it
 * (compile-client.ts), so a check of a large site never holds up the editor's main process. It loads the compiler
 * once, on its first batch, and keeps it.
 */
import { compileFile, type CompileReply, type CompileRequest } from './compile-file';

const port = (process as unknown as { parentPort: { on: (e: 'message', cb: (ev: { data: CompileRequest }) => void) => void; postMessage: (m: CompileReply) => void } }).parentPort;

let compiler: Promise<typeof import('svelte/compiler')> | null = null;

port.on('message', async ({ data: m }) => {
  try {
    const { compile } = await (compiler ??= import('svelte/compiler'));
    let runs = 0;
    const outcomes = m.files.map(([path, source]) => compileFile(compile, path, source, () => runs++));
    port.postMessage({ id: m.id, ok: true, outcomes, runs });
  } catch (e) {
    port.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
