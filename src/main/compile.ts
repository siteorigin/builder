import type { ProjectState } from '@shared/types';
import type { Diagnostic } from '@engine/validate';
import { defFile, generateProject, pageFile, webMcpFormFile } from '@generator/index';
import { perf } from './perf';

/** Component validation profile: every Svelte file must parse and compile with the pinned compiler. */
export async function compileProject(state: ProjectState): Promise<Diagnostic[]> {
  const { compile } = await import('svelte/compiler');
  const out: Diagnostic[] = [];
  const files = generateProject(state, { instrument: false });
  // Which page or component each file is, so a result can be narrowed to them (validate_project).
  const owners = new Map<string, { kind: string; id: string }>();
  for (const page of Object.values(state.pages)) owners.set(pageFile(page), { kind: 'page', id: page.id });
  for (const def of Object.values(state.components)) {
    owners.set(webMcpFormFile(def), { kind: 'component', id: def.id });
    owners.set(defFile(def), { kind: 'component', id: def.id });
  }
  for (const [path, source] of files) {
    if (!path.endsWith('.svelte')) continue;
    perf.count('compile.files');
    // Pages are prerendered (server) and hydrated (client); a file must compile both ways.
    for (const generate of ['client', 'server'] as const) {
      try {
        perf.count('compile.svelte');
        compile(source, { filename: path, generate, runes: true });
      } catch (e) {
        const err = e as { message: string; code?: string; start?: { line: number }; end?: { line?: number } };
        const def = Object.values(state.components).find((d) => d.sourcePath === path || path.includes(d.id.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()));
        const reason = err.message.split('\n')[0];
        const owner = owners.get(path);
        out.push({ severity: 'error', code: 'COMPILE', message: `${def ? def.name : path}${err.start ? ` (line ${err.start.line})` : ''}: ${reason}`, ...(owner ? { owner } : {}), site: compileSite(path, source, err, reason) });
        break;
      }
    }
  }
  return out;
}

/**
 * What identifies a compile error across edits: its file, the compiler's reason and the source it is on with a line of
 * context either side (spacing evened out), never its line or column number, which move when anything above it changes,
 * nor the component's name, which a rename changes. The same reason on another construct is a different error, even
 * where the construct's own line reads the same (a closing tag in another row).
 */
function compileSite(path: string, source: string, err: { code?: string; start?: { line: number }; end?: { line?: number } }, reason: string): string {
  const lines = err.start ? source.split('\n').slice(Math.max(0, err.start.line - 2), Math.max(err.start.line, err.end?.line ?? err.start.line) + 1) : [];
  return JSON.stringify([path, err.code ?? reason, lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300)]);
}
