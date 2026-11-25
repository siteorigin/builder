import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const RENDERER_ROOT = 'src/renderer/src';
const LAYER_NAMES = new Set(['tokens', 'reset', 'base', 'primitives', 'layout', 'components']);

function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/** Return top-level tokens outside `{ ... }` blocks so we can assert no unlayered rules exist. */
function topLevelHeaders(css: string): string[] {
  const clean = stripCssComments(css);
  const headers: string[] = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '{') {
      if (depth === 0) {
        headers.push(buf.trim());
        buf = '';
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      expect(depth, 'unbalanced closing brace').toBeGreaterThanOrEqual(0);
    } else if (depth === 0) {
      buf += ch;
    }
  }
  expect(depth, 'unbalanced opening brace').toBe(0);
  if (buf.trim()) headers.push(buf.trim());
  return headers;
}

describe('renderer stylesheet architecture', () => {
  const cssFiles = walk(RENDERER_ROOT, '.css').sort();

  it('has no monolithic src/renderer/src/styles.css', () => {
    expect(existsSync(join(RENDERER_ROOT, 'styles.css'))).toBe(false);
  });

  it('declares only the canonical @layer order and @imports in styles/index.css', () => {
    const indexCss = stripCssComments(readFileSync(join(RENDERER_ROOT, 'styles/index.css'), 'utf8'));
    const statements = indexCss
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    expect(statements[0]).toBe('@layer tokens, reset, base, primitives, layout, components;');
    for (const stmt of statements.slice(1)) {
      expect(stmt).toMatch(/^@import '\.\/[a-z-]+\.css';$/);
    }
  });

  it('places every rule in every other stylesheet inside an explicit known @layer', () => {
    for (const file of cssFiles) {
      if (file === join(RENDERER_ROOT, 'styles/index.css')) continue;
      const headers = topLevelHeaders(readFileSync(file, 'utf8'));
      expect(headers.length, `${file} should declare at least one @layer block`).toBeGreaterThan(0);
      for (const header of headers) {
        const m = header.match(/^@layer\s+([a-z-]+)$/);
        expect(m, `${file} has unlayered top-level CSS: "${header.slice(0, 80)}"`).not.toBeNull();
        expect(LAYER_NAMES.has(m![1]), `${file} uses unknown layer "${m![1]}"`).toBe(true);
      }
    }
  });

  it('imports every renderer stylesheet from at least one live renderer source file', () => {
    const tsFiles = [...walk(RENDERER_ROOT, '.tsx'), ...walk(RENDERER_ROOT, '.ts')];
    const imported = new Set<string>();
    for (const file of tsFiles) {
      const src = stripTsComments(readFileSync(file, 'utf8'));
      for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+\.css)['"]\s*;?/gm)) {
        imported.add(resolve(dirname(file), m[1]));
      }
    }
    for (const file of cssFiles) {
      const src = stripCssComments(readFileSync(file, 'utf8'));
      for (const m of src.matchAll(/^\s*@import\s+['"]([^'"]+\.css)['"]\s*;/gm)) {
        imported.add(resolve(dirname(file), m[1]));
      }
    }
    for (const file of cssFiles) {
      expect(imported.has(resolve(file)), `${file} is not imported anywhere in ${RENDERER_ROOT}`).toBe(true);
    }
  });
});
