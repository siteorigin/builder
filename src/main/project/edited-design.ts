/**
 * A design's generated file edited outside the app, made a project code component (#737): which files can be, and the
 * file's code as it reads from the custom folder.
 */
import { posix } from 'node:path';
import type { ComponentDefinition, ProjectState } from '@shared/types';
import { defFile } from '@generator/index';

type Node = { type: string; start?: number; end?: number; [k: string]: unknown };

/** The design whose generated file `path` is, or undefined: only a design's own file, never a copy or any other file. */
export function designAt(state: ProjectState, path: string): ComponentDefinition | undefined {
  for (const def of Object.values(state.components)) if (def.kind === 'managed' && def.tree && defFile(def) === path) return def;
  return undefined;
}

/** The file's bytes as text, or null when they are not text that reads back byte for byte (a binary file, say). */
export function textOfBytes(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

/**
 * The file's code as it reads from `to`, having been written for `from`: every module-relative reference that would
 * lead elsewhere from the new folder (an import or export, a dynamic import, a `new URL(…, import.meta.url)`, a
 * relative `url()` or `@import` in its styles) is rewritten to lead where it did. Only the path inside the quotes
 * changes; every other byte, the header note included, stays as the developer left it. Code that does not parse is
 * returned as it is, for the code check to name what is wrong with it.
 */
export async function relocateSource(source: string, from: string, to: string): Promise<string> {
  const fromDir = posix.dirname(from);
  const toDir = posix.dirname(to);
  if (fromDir === toDir) return source;
  const moved = (spec: string): string | null => {
    if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
    const target = posix.join(fromDir, spec);
    // Written as it was wherever it still leads to the same file (the runtime helpers, another custom component).
    if (posix.join(toDir, spec) === target) return null;
    const rel = posix.relative(toDir, target);
    const next = rel.startsWith('.') ? rel : `./${rel}`;
    // A trailing slash (a folder's index) is kept as it was written.
    const out = spec.endsWith('/') && !next.endsWith('/') ? `${next}/` : next;
    return out === spec ? null : out;
  };
  const edits: Array<{ start: number; end: number; text: string }> = [];
  /** A string literal written as plain quotes around exactly its value: anything with escapes in it is left alone. */
  const literal = (n: Node | undefined) => {
    if (!n || typeof n.start !== 'number' || typeof n.end !== 'number') return;
    const start = n.start + 1;
    const end = n.end - 1;
    let value: unknown;
    if (n.type === 'Literal') value = n.value;
    else if (n.type === 'TemplateLiteral' && !(n.expressions as unknown[]).length) {
      const q = (n.quasis as Node[])[0];
      value = (q?.value as { cooked?: string } | undefined)?.cooked;
    } else return;
    if (typeof value !== 'string' || source.slice(start, end) !== value) return;
    const next = moved(value);
    if (next !== null) edits.push({ start, end, text: next });
  };
  let ast: Node;
  try {
    const { parse } = await import('svelte/compiler');
    ast = parse(source, { modern: true }) as unknown as Node;
  } catch {
    return source;
  }
  const seen = new Set<object>();
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) return v.forEach(walk);
    const n = v as Node;
    if ((n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'ImportExpression') && n.source) literal(n.source as Node);
    if (n.type === 'NewExpression' && (n.callee as Node | undefined)?.type === 'Identifier' && (n.callee as Node).name === 'URL') {
      const [spec, base] = (n.arguments as Node[]) ?? [];
      const meta = base?.type === 'MemberExpression' && (base.object as Node)?.type === 'MetaProperty' && (base.property as Node)?.name === 'url';
      if (meta) literal(spec);
    }
    for (const [k, child] of Object.entries(n)) if (k !== 'parent' && k !== 'metadata') walk(child);
  };
  walk(ast.instance);
  walk(ast.module);
  walk(ast.fragment);
  // Styles: a relative stylesheet or picture is found from the file's folder too.
  const css = ast.css as { content?: { start?: number; styles?: string } } | null;
  const styles = css?.content?.styles;
  const at = css?.content?.start;
  if (typeof styles === 'string' && typeof at === 'number' && source.slice(at, at + styles.length) === styles) {
    for (const re of [/url\(\s*(['"]?)(\.{1,2}\/[^'")\s]*)\1\s*\)/g, /@import\s+(['"])(\.{1,2}\/[^'"]*)\1/g]) {
      for (const m of styles.matchAll(re)) {
        const next = moved(m[2]);
        if (next === null) continue;
        // The path is the match's last part: only a quote or the bracket follows it.
        const start = at + m.index! + m[0].lastIndexOf(m[2]);
        edits.push({ start, end: start + m[2].length, text: next });
      }
    }
  }
  if (!edits.length) return source;
  // Applied from the end, so each one's offsets still hold.
  edits.sort((a, b) => b.start - a.start);
  let out = source;
  let last = Infinity;
  for (const e of edits) {
    if (e.end > last) continue;
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    last = e.start;
  }
  return out;
}
