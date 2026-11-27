/**
 * The theme folders under src/catalogue/ hold themes only, so one can move to its own repository without taking the
 * app's code with it (#995): what the app itself reads lives in src/shared/ or in the pack format.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const ROOT = resolve(__dirname, '../..');
const CORE = ['src/agent', 'src/engine', 'src/generator', 'src/main', 'src/preload', 'src/renderer', 'src/runtime', 'src/shared', 'scripts'];
/** Every folder of the catalogue is a theme; the files beside them are the pack format and what assembles the packs. */
const THEMES = readdirSync(join(ROOT, 'src/catalogue'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `src/catalogue/${entry.name}`);

const sources = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(f))
    .map((f) => posix.join(dir, f.replace(/\\/g, '/')));

/** The repository path an import names, or undefined for a package. */
function target(from: string, specifier: string): string | undefined {
  // The aliases (tsconfig.base.json) are each named for their folder under src/.
  const alias = /^@(shared|engine|generator|catalogue|agent|runtime|renderer)\/(.*)$/.exec(specifier);
  if (alias) return posix.join('src', alias[1] === 'renderer' ? 'renderer/src' : alias[1], alias[2]);
  return specifier.startsWith('.') ? posix.join(posix.dirname(from), specifier) : undefined;
}

const inTheme = (path = '') => THEMES.some((theme) => path === theme || path.startsWith(`${theme}/`));

/** Every module a file names: imports and re-exports, `import()` as a call or in a type, and `require`. */
function imported(file: string, text: string): string[] {
  const found: string[] = [];
  const name = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node)) found.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) name(node.moduleSpecifier);
    else if (ts.isExternalModuleReference(node)) name(node.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) name(node.argument.literal);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')))
      name(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest));
  return found;
}

describe('theme folders', () => {
  it('are imported by no app or script module', () => {
    const files = CORE.flatMap(sources);
    // A scan that found nothing to read would pass whatever the imports are.
    expect(files.length).toBeGreaterThan(100);
    expect(THEMES).toContain('src/catalogue/foundation');
    const found = files.flatMap((file) =>
      imported(file, readFileSync(join(ROOT, file), 'utf8'))
        .filter((specifier) => inTheme(target(file, specifier)))
        .map((specifier) => `${file} imports ${specifier}`)
    );
    expect(found).toEqual([]);
  });

  it('are found however a module names them', () => {
    const text = `
      import type { A } from '@catalogue/foundation/a';
      export * as b from '../catalogue/foundation/b';
      type C = typeof import('@catalogue/./foundation/c');
      const d = require('@engine/../catalogue/foundation/d');
      export const View = () => <p>What's new? {String(import('@catalogue/foundation/e'))}</p>;
      import { pack } from '@catalogue/pack';`;
    const named = imported('src/engine/view.tsx', text).filter((specifier) => inTheme(target('src/engine/view.tsx', specifier)));
    expect(named.map((specifier) => specifier.slice(-1))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
