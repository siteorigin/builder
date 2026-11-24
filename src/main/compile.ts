import type { ProjectState } from '@shared/types';
import type { Diagnostic } from '@engine/validate';
import { generateProject } from '@generator/index';

/** Component validation profile: every Svelte file must parse and compile with the pinned compiler. */
export async function compileProject(state: ProjectState): Promise<Diagnostic[]> {
  const { compile } = await import('svelte/compiler');
  const out: Diagnostic[] = [];
  const files = generateProject(state, { instrument: false });
  for (const [path, source] of files) {
    if (!path.endsWith('.svelte')) continue;
    // Pages are prerendered (server) and hydrated (client); a file must compile both ways.
    for (const generate of ['client', 'server'] as const) {
      try {
        compile(source, { filename: path, generate, runes: true });
      } catch (e) {
        const err = e as { message: string; start?: { line: number; column?: number } };
        const def = Object.values(state.components).find((d) => d.sourcePath === path || path.includes(d.id.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()));
        // The message names the line; `site` also gives the column, so an error that moves along a line is a new one.
        const site = err.start ? `${path}:${err.start.line}:${err.start.column ?? 0}` : path;
        out.push({ severity: 'error', code: 'COMPILE', message: `${def ? def.name : path}${err.start ? ` (line ${err.start.line})` : ''}: ${err.message.split('\n')[0]}`, site });
        break;
      }
    }
  }
  return out;
}
