import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ALIASES: Record<string, string> = {
  '@shared': 'src/shared',
  '@engine': 'src/engine',
  '@generator': 'src/generator',
  '@catalogue': 'src/catalogue',
  '@agent': 'src/agent',
  '@runtime': 'src/runtime'
};

/** The module a specifier names in the app's own source, or null for a package (or a Node or Electron built-in). */
function ownModule(from: string, spec: string): string | null {
  const alias = Object.keys(ALIASES).find((a) => spec === a || spec.startsWith(`${a}/`));
  const base = alias ? resolve(ALIASES[alias] + spec.slice(alias.length)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
  // An alias of the build's this walk does not know would pass as a package, and its modules would go unread.
  if (!base && spec.startsWith('@') && existsSync(resolve('src', spec.slice(1).split('/')[0]))) throw new Error(`${spec} (imported by ${from}) uses an alias this test does not list`);
  if (!base) return null;
  for (const file of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) if (/\.tsx?$/.test(file) && existsSync(file)) return file;
  throw new Error(`${spec} (imported by ${from}) is not in the source`);
}

/** The specifiers a module loads before its own first line runs: its value imports and re-exports, never `import()`. */
function staticImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const specs: string[] = [];
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      // Only types: erased when compiled, so nothing is loaded.
      const typesOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly)));
      if (!typesOnly) specs.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) specs.push(node.moduleSpecifier.text);
  }
  return specs;
}

/** Every package the main entry evaluates before its first line runs, following the app's own modules. */
function packagesAtLaunch(entry: string): Set<string> {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [resolve(entry)];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of staticImports(file)) {
      const own = ownModule(file, spec);
      if (own) queue.push(own);
      else if (!spec.startsWith('node:') && spec !== 'electron') packages.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
    }
  }
  return packages;
}

describe('what the main process loads at launch', () => {
  it('never evaluates an AI provider’s SDK: each is loaded the first time it is used', () => {
    const packages = packagesAtLaunch('src/main/index.ts');
    // The walk reaches the packages it should, so an empty answer is never a false pass.
    expect(packages.has('zod')).toBe(true);
    expect(packages.has('openai')).toBe(false);
    expect(packages.has('@anthropic-ai/sdk')).toBe(false);
  });

  it('still finds an SDK the entry imports statically', () => {
    // The provider adapters themselves import their SDKs: the walk sees through the app's own modules to them.
    expect(packagesAtLaunch('src/agent/openai.ts').has('openai')).toBe(true);
    expect(packagesAtLaunch('src/agent/anthropic.ts').has('@anthropic-ai/sdk')).toBe(true);
  });
});
