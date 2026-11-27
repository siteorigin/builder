/**
 * The editor's stylesheets never use `:has()` on the document, the app's root or the editor to style something inside
 * them (#971). Chromium cannot tell which elements under such a `:has()` it affects, so it restyles all of them on every
 * change of the page that might bear on it: with a long page open, a click in Layers restyled some 19,000 elements and
 * spent most of its time doing it. Such state is said on the body instead (src/renderer/src/lib/previewing.ts, the
 * seams in Editor.tsx). A `:has()` on a small part of the page (a toolbar group, a row), or one that styles the element
 * it is on (`#root:has(> .fatal)`), costs only that part.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The elements that hold the whole window, or the whole editor, as a compound names them (in an `:is()` too). */
const WHOLE = /(?:^|[(,\s])(?:html|body)(?![\w-])|:root(?![\w-])|#root(?![\w-])|\.(?:editor|workspace)(?![\w-])/;

/** `text` split at each of `at` outside parentheses, brackets and quotes. */
function splitTop(text: string, at: (c: string) => boolean): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && at(c)) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * Each selector of a stylesheet's rules as it applies, without comments: a rule nested in another (CSS nesting) is
 * resolved against its parent's selectors (`&` replaced by each, or the parent before it), and an at-rule's prelude
 * is not a selector (what it holds keeps the selectors around it).
 */
function selectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  const stack: Array<string[] | null> = [];
  const around = () => [...stack].reverse().find((x) => x !== null) ?? null;
  let start = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    if (c !== '{' && c !== '}' && c !== ';') continue;
    const prelude = text.slice(start, i).trim();
    start = i + 1;
    if (c === '}') {
      stack.pop();
      continue;
    }
    if (c !== '{') continue;
    if (prelude.startsWith('@')) {
      stack.push(null);
      continue;
    }
    const parents = around();
    const own = splitTop(prelude, (x) => x === ',');
    const resolved = parents ? own.flatMap((sel) => parents.map((p) => (sel.includes('&') ? sel.replaceAll('&', p) : `${p} ${sel}`))) : own;
    stack.push(resolved);
    out.push(...resolved);
  }
  return out;
}

/** Whether a selector puts `:has()` on the window or the editor and styles something inside it, not that element. */
function anchoredOnWhole(selector: string): boolean {
  const compounds = splitTop(selector, (c) => /[\s>+~]/.test(c));
  // A compound's own selectors: what its `:has()` looks for inside it is not where it sits.
  const own = (compound: string) => {
    let out = '';
    for (let i = 0; i < compound.length; i++) {
      if (!compound.startsWith(':has(', i)) {
        out += compound[i];
        continue;
      }
      let depth = 0;
      for (i += 4; i < compound.length; i++) {
        if (compound[i] === '(') depth++;
        else if (compound[i] === ')' && --depth === 0) break;
      }
    }
    return out;
  };
  return compounds.some((c, i) => i < compounds.length - 1 && c.includes(':has(') && WHOLE.test(own(c)));
}

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? stylesheets(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []));
}

describe('the editor’s stylesheets', () => {
  it('tell a :has() that restyles the whole window from one that costs only its own part', () => {
    for (const whole of ['body:has(.preview-pill:not([inert] *)) .toasts', '.editor:has(.resizer.dragging) .frame-box iframe', ':root:has(.modal) > .editor', '.editor.defining:has(.x) .y', '.ready.editor:has(.x) .y', ':is(body, .editor):has(.x) .toasts', 'html:has([data-a="1, 2"]) .b'])
      expect(anchoredOnWhole(whole), whole).toBe(true);
    // On the element it styles, on a small part of the page, or with the window's elements only inside what it looks for.
    for (const part of ['#root:has(> .fatal)', '.toolbar-group:has(.save-state:is(.ask, .wait)) .project-title .site', '.editor-panel:has(.x) .y', 'body.previewing .toasts', '.row:has(.editor) .name', 'body .row:has(.x) .y'])
      expect(anchoredOnWhole(part), part).toBe(false);
  });

  it('read every rule as it applies, nested or not, with commas inside its parentheses and quotes kept', () => {
    const css = [
      '/* a, b */',
      '@layer x {',
      '  .a:has(.b, .c), [title="x, y"] { color: red; }',
      '  @media (width < 9px) { .e { color: blue } }',
      '  body { color: red; &:has(.pill) .toasts { bottom: 1px } .row:has(.x) .y { top: 0 } }',
      '  :where(:root[data-dark]) { .toasts { color: white } }',
      '}'
    ].join('\n');
    const found = selectors(css);
    expect(found).toEqual(['.a:has(.b, .c)', '[title="x, y"]', '.e', 'body', 'body:has(.pill) .toasts', 'body .row:has(.x) .y', ':where(:root[data-dark])', ':where(:root[data-dark]) .toasts']);
    expect(found.filter(anchoredOnWhole)).toEqual(['body:has(.pill) .toasts']);
  });

  it('never put a :has() on the window or the editor to style something inside it', () => {
    const root = join(import.meta.dirname, '../../src/renderer');
    const found = stylesheets(root).flatMap((file) => selectors(readFileSync(file, 'utf8')).filter(anchoredOnWhole).map((s) => `${relative(root, file)}: ${s}`));
    expect(found).toEqual([]);
  });
});
