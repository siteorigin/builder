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
    // A query or fragment (`?url`, `#icon`) stays as it was written after the path.
    const cut = spec.search(/[?#]/);
    const path = cut < 0 ? spec : spec.slice(0, cut);
    const suffix = cut < 0 ? '' : spec.slice(cut);
    // Named from the library: it reads the same from anywhere, but a file written only now and then is still the one it copies.
    if (spec.startsWith('$lib/')) {
      const to = redirect?.(posix.normalize(`src/lib/${path.slice(5)}`));
      return to?.startsWith('src/lib/') ? `$lib/${to.slice(8)}${suffix}` : null;
    }
    if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
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
    return moved(url.startsWith('./') || url.startsWith('../') ? url : `./${url}`);
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
    const escaped = next
      .replace(/\\/g, '\\\\')
      .replaceAll(quote, `\\${quote}`)
      .replace(/\$\{/g, '\\${')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
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
  // are read, each URL quoted or not, and never one that is only words in a string or a comment.
  const urls = (from: number, to: number, imports: boolean) => {
    for (const { at, url } of cssUrls(source.slice(from, to), imports)) {
      const next = movedUrl(url);
      if (next !== null) edits.push({ start: from + at, end: from + at + url.length, text: next });
    }
  };
  const styles = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(styles);
    const n = v as Node;
    if (typeof n.start === 'number' && typeof n.end === 'number') {
      if (n.type === 'Declaration') return urls(n.start, n.end, false);
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

/**
 * The URLs a piece of CSS loads, with where each starts: every `url(…)` outside strings and comments, and with
 * `imports`, the string an `@import` names. Escapes are not unpicked: a URL written with one is left as it is.
 */
function cssUrls(css: string, imports: boolean): Array<{ at: number; url: string }> {
  const out: Array<{ at: number; url: string }> = [];
  let i = 0;
  const string = (from: number) => {
    const quote = css[from];
    let j = from + 1;
    while (j < css.length && css[j] !== quote && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
    return j;
  };
  while (i < css.length) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close < 0 ? css.length : close + 2;
    } else if (ch === '"' || ch === "'") {
      const end = string(i);
      const raw = css.slice(i + 1, end);
      if (imports && /@import(?:\s|\/\*(?:(?!\*\/)[\s\S])*\*\/)*$/i.test(css.slice(0, i)) && !raw.includes('\\')) out.push({ at: i + 1, url: raw });
      i = end + 1;
    } else if ((ch === 'u' || ch === 'U') && /^url\(/i.test(css.slice(i, i + 4)) && !/[\w-]$/.test(css.slice(0, i))) {
      let j = i + 4;
      while (/\s/.test(css[j] ?? '')) j++;
      if (css[j] === '"' || css[j] === "'") {
        const end = string(j);
        const raw = css.slice(j + 1, end);
        if (!raw.includes('\\')) out.push({ at: j + 1, url: raw });
        i = end + 1;
      } else {
        const m = /^[^"'()\s\\]+/.exec(css.slice(j));
        if (m && /^\s*\)/.test(css.slice(j + m[0].length))) out.push({ at: j, url: m[0] });
        i = j + (m?.[0].length ?? 0);
      }
    } else i++;
  }
  return out;
}
