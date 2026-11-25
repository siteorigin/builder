/**
 * A design's generated file edited outside the app, made a project code component (#737): which files can be, and the
 * file's code as it reads from the custom folder.
 */
import { posix } from 'node:path';
import type { ComponentDefinition, ProjectState } from '@shared/types';
import { defFile } from '@generator/index';

type Node = { type: string; start?: number; end?: number; [k: string]: unknown };

/**
 * The design whose generated file `path` is, or undefined: only a design's own file, never a copy or any other file,
 * and only one no other definition's file shares (two IDs can make one file name).
 */
export function designAt(state: ProjectState, path: string): ComponentDefinition | undefined {
  const made = Object.values(state.components).filter((def) => defFile(def) === path);
  return made.length === 1 && made[0].kind === 'managed' && made[0].tree ? made[0] : undefined;
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
export async function relocateSource(source: string, from: string, to: string, redirect?: (target: string) => string | undefined): Promise<string> {
  const fromDir = posix.dirname(from);
  const toDir = posix.dirname(to);
  /** The reference as it reads from the new folder, or null when it reads the same there (or is not module-relative). */
  const moved = (spec: string): string | null => {
    if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
    // A query or fragment (`?url`, `#icon`) stays as it was written after the path.
    const cut = spec.search(/[?#]/);
    const path = cut < 0 ? spec : spec.slice(0, cut);
    const suffix = cut < 0 ? '' : spec.slice(cut);
    const was = posix.join(fromDir, path);
    // A file the generator writes only now and then (a contact form's copy for AI agents) is read as the file it copies.
    const target = redirect?.(was) ?? was;
    // Written as it was wherever it still leads to the same file (the runtime helpers, another custom component).
    if (target === was && posix.join(toDir, path) === target) return null;
    const rel = posix.relative(toDir, target);
    const next = rel.startsWith('.') ? rel : `./${rel}`;
    // A trailing slash (a folder's index) is kept as it was written.
    const out = (path.endsWith('/') && !next.endsWith('/') ? `${next}/` : next) + suffix;
    return out === spec ? null : out;
  };
  /** A URL in styles or `new URL()`, which is relative to the file even when it does not start with a dot. */
  const movedUrl = (url: string): string | null => {
    if (!url || /^(?:[a-z][a-z0-9+.-]*:|\/|#|\$|~|%)/i.test(url)) return null;
    return moved(url.startsWith('.') ? url : `./${url}`);
  };
  if (fromDir === toDir && !redirect) return source;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  /**
   * A string literal: only the path inside its quotes changes when it is written plainly; one written with escapes is
   * written again whole, plainly, in the same quotes.
   */
  const literal = (n: Node | undefined, move: (spec: string) => string | null = moved) => {
    if (!n || typeof n.start !== 'number' || typeof n.end !== 'number') return;
    const start = n.start + 1;
    const end = n.end - 1;
    let value: unknown;
    if (n.type === 'Literal') value = n.value;
    else if (n.type === 'TemplateLiteral' && !(n.expressions as unknown[]).length) {
      const q = (n.quasis as Node[])[0];
      value = (q?.value as { cooked?: string } | undefined)?.cooked;
    } else return;
    if (typeof value !== 'string') return;
    const next = move(value);
    if (next === null) return;
    if (source.slice(start, end) === value) return void edits.push({ start, end, text: next });
    const quote = source[n.start];
    const escaped = next.replace(/\\/g, '\\\\').replaceAll(quote, `\\${quote}`).replace(/\$\{/g, '\\${');
    edits.push({ start: n.start, end: n.end, text: `${quote}${escaped}${quote}` });
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
      if (meta) literal(spec, movedUrl);
    }
    for (const [k, child] of Object.entries(n)) if (k !== 'parent' && k !== 'metadata') walk(child);
  };
  walk(ast.instance);
  walk(ast.module);
  walk(ast.fragment);
  // Styles: a relative stylesheet or picture is found from the file's folder too. Only real declarations and imports
  // are read (never a comment, nor the words a `content` shows), each URL quoted or not.
  const urls = (from: number, to: number, imports: boolean) => {
    const text = source.slice(from, to);
    const found = [...text.matchAll(/url\(\s*(?:(["'])((?:(?!\1)[^\\\n])*)\1|([^"'()\s\\]+))\s*\)/gi)].map((m) => ({ m, url: m[2] ?? m[3] }));
    if (imports) for (const m of text.matchAll(/@import\s+(["'])((?:(?!\1)[^\\\n])*)\1/gi)) found.push({ m, url: m[2] });
    for (const { m, url } of found) {
      const next = movedUrl(url);
      if (next === null) continue;
      // The URL is the match's last part: only a quote or the bracket follows it.
      const start = from + m.index! + m[0].lastIndexOf(url);
      edits.push({ start, end: start + url.length, text: next });
    }
  };
  const styles = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(styles);
    const n = v as Node;
    if (typeof n.start === 'number' && typeof n.end === 'number') {
      if (n.type === 'Declaration' && String(n.property).toLowerCase() !== 'content') return urls(n.start, n.end, false);
      if (n.type === 'Atrule' && String(n.name).toLowerCase() === 'import') return urls(n.start, n.end, true);
    }
    if (n.type === 'StyleSheet' || n.type === 'Rule' || n.type === 'Atrule' || n.type === 'Block') {
      styles(n.children);
      styles(n.block);
    }
  };
  styles(ast.css);
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
