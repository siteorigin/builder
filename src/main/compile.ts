import type { ProjectState } from '@shared/types';
import type { Diagnostic } from '@engine/validate';
import { defFile, generateProject, pageFile, webMcpFormFile } from '@generator/index';
import { perf } from './perf';
import { compileFile, type CompileFailure } from './compile-file';
import type { CompiledBatch } from './compile-client';

export { compileFile, type CompileFailure } from './compile-file';

/**
 * What each Svelte file of one project came to when it was last compiled, kept between the project's build checks.
 * An outcome is given back only for the same file with exactly the same source: the compiler is the one pinned with
 * the app, and it reads nothing but the source and the options, which are the same for a file every time. A failure
 * of the compiler itself (`CompileFailure.unexpected`) is never kept.
 */
export class CompileCache {
  private outcomes = new Map<string, { source: string; failure: CompileFailure | null }>();

  /** The outcome of compiling `source` as `path`, when it is known; undefined when it must be compiled. */
  get(path: string, source: string): CompileFailure | null | undefined {
    const hit = this.outcomes.get(path);
    return hit && hit.source === source ? hit.failure : undefined;
  }

  set(path: string, source: string, failure: CompileFailure | null) {
    if (failure?.unexpected) this.outcomes.delete(path);
    else this.outcomes.set(path, { source, failure });
  }

  /** Forget the files the website no longer has. */
  keepOnly(paths: Set<string>) {
    for (const path of this.outcomes.keys()) if (!paths.has(path)) this.outcomes.delete(path);
  }

  get size() {
    return this.outcomes.size;
  }
}

export interface CompileOptions {
  /** The project's earlier checks: a file whose source has not changed since is not compiled again. */
  cache?: CompileCache;
  /** Compiles a batch of files elsewhere (the compile workers); the files it gives no outcome for are compiled here. */
  offload?: (files: Array<[string, string]>) => Promise<CompiledBatch | null>;
}

/**
 * Component validation profile: every Svelte file must parse and compile with the pinned compiler. `files` are the
 * website's files for `state` (an open project's session has them cached: `ProjectSession.websiteFiles`). Files that
 * must be compiled go to `offload`, and are compiled here when it cannot take them.
 */
export async function compileProject(state: ProjectState, files: Map<string, string> = generateProject(state, { instrument: false }), opts: CompileOptions = {}): Promise<Diagnostic[]> {
  const { cache, offload } = opts;
  const out: Diagnostic[] = [];
  // Which page or component each file is, so a result can be narrowed to them (validate_project).
  const owners = new Map<string, { kind: string; id: string }>();
  for (const page of Object.values(state.pages)) owners.set(pageFile(page), { kind: 'page', id: page.id });
  for (const def of Object.values(state.components)) {
    owners.set(webMcpFormFile(def), { kind: 'component', id: def.id });
    owners.set(defFile(def), { kind: 'component', id: def.id });
  }
  const checked: Array<[string, string]> = [];
  /** Each file's outcome, known from the cache or to be compiled (undefined). */
  const outcomes: Array<CompileFailure | null | undefined> = [];
  const misses: Array<[string, string]> = [];
  for (const [path, source] of files) {
    if (!path.endsWith('.svelte')) continue;
    perf.count('compile.files');
    checked.push([path, source]);
    const known = cache?.get(path, source);
    outcomes.push(known);
    if (known === undefined) misses.push([path, source]);
  }
  if (misses.length) {
    const batch = offload ? await offload(misses) : null;
    if (batch) perf.count('compile.svelte', batch.runs);
    const compiled: Array<CompileFailure | null | undefined> = batch?.outcomes.length === misses.length ? batch.outcomes : misses.map(() => undefined);
    // What no worker answered for is compiled here.
    if (compiled.includes(undefined)) {
      const { compile } = await import('svelte/compiler');
      compiled.forEach((o, i) => {
        if (o === undefined) compiled[i] = compileFile(compile, misses[i][0], misses[i][1], () => perf.count('compile.svelte'));
      });
    }
    let next = 0;
    for (let i = 0; i < outcomes.length; i++) {
      if (outcomes[i] !== undefined) continue;
      const [path, source] = checked[i];
      outcomes[i] = compiled[next++];
      cache?.set(path, source, outcomes[i]!);
    }
  }
  for (let i = 0; i < checked.length; i++) {
    const [path, source] = checked[i];
    const err = outcomes[i];
    if (!err) continue;
    // Named from the project as it is now: a component renamed since its file last compiled is named as it is now.
    const def = Object.values(state.components).find((d) => d.sourcePath === path || path.includes(d.id.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()));
    const reason = err.message.split('\n')[0];
    const owner = owners.get(path);
    out.push({ severity: 'error', code: 'COMPILE', message: `${def ? def.name : path}${err.start ? ` (line ${err.start.line})` : ''}: ${reason}`, ...(owner ? { owner } : {}), site: compileSite(path, source, err, reason) });
  }
  cache?.keepOnly(new Set(checked.map(([path]) => path)));
  return out;
}

/**
 * What identifies a compile error across edits: its file, the compiler's reason and the source it is on with a line of
 * context either side (spacing evened out), never its line or column number, which move when anything above it changes,
 * nor the component's name, which a rename changes. The same reason on another construct is a different error, even
 * where the construct's own line reads the same (a closing tag in another row).
 */
function compileSite(path: string, source: string, err: CompileFailure, reason: string): string {
  const lines = err.start ? source.split('\n').slice(Math.max(0, err.start.line - 2), Math.max(err.start.line, err.end?.line ?? err.start.line) + 1) : [];
  return JSON.stringify([path, err.code ?? reason, lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300)]);
}
