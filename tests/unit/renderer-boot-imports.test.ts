/**
 * What the editor's page evaluates before Welcome can show (#958): its script's static imports, followed through the
 * app's own modules. The editor itself (its screen, the canvas, the panels, the code editor) loads only when a project
 * opens (lib/editor-module.ts), so a launch to Welcome compiles and runs a fraction of the editor's code.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ALIASES: Record<string, string> = {
  '@shared': 'src/shared',
  '@engine': 'src/engine',
  '@generator': 'src/generator',
  '@catalogue': 'src/catalogue',
  '@agent': 'src/agent',
  '@runtime': 'src/runtime',
  '@renderer': 'src/renderer/src'
};

/** The app's own module a specifier names, null for a package, or 'asset' for a stylesheet, image or font. */
function ownModule(from: string, spec: string): string | null | 'asset' {
  const alias = Object.keys(ALIASES).find((a) => spec === a || spec.startsWith(`${a}/`));
  const base = alias ? resolve(ALIASES[alias] + spec.slice(alias.length)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  if (/\.(css|svg|png|jpe?g|webp|woff2?|json)(\?.*)?$/.test(base)) return 'asset';
  for (const file of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) if (/\.tsx?$/.test(file) && existsSync(file)) return file;
  throw new Error(`${spec} (imported by ${from}) is not in the source`);
}

interface Load {
  spec: string;
  /** The names it imports: `*` for a namespace, `default` for a default import. */
  names: string[];
}

/** What a module loads before its own first line runs: its value imports and re-exports, never `import()`. */
function staticImports(file: string): Load[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const loads: Load[] = [];
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : undefined;
      // Only types: erased when compiled, so nothing is loaded.
      const typesOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!named && named.length > 0 && named.every((e) => e.isTypeOnly)));
      const names = named ? named.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text) : [];
      if (clause?.name) names.push('default');
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.push('*');
      if (!typesOnly) loads.push({ spec: node.moduleSpecifier.text, names });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) loads.push({ spec: node.moduleSpecifier.text, names: node.exportClause ? [] : ['*'] });
  }
  return loads;
}

/** The app's modules and the packages the editor's page evaluates before its first line of main.tsx runs. */
function atLaunch(entry: string) {
  const files = new Set<string>();
  const packages = new Map<string, Set<string>>();
  const queue = [resolve(entry)];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const { spec, names } of staticImports(file)) {
      const own = ownModule(file, spec);
      if (own === 'asset') continue;
      if (own) queue.push(own);
      else {
        const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        const used = packages.get(pkg) ?? new Set<string>();
        for (const n of names) used.add(n);
        packages.set(pkg, used);
      }
    }
  }
  return { files: [...files].map((f) => relative(process.cwd(), f)), packages };
}

describe('what the editor’s page evaluates to show Welcome', () => {
  const { files, packages } = atLaunch('src/renderer/src/main.tsx');

  it('never the editor: its screen, the canvas, its panels, inspection or the clipboard', () => {
    for (const file of ['src/renderer/src/Editor.tsx', 'src/renderer/src/editor-entry.ts', 'src/renderer/src/panels/Canvas.tsx', 'src/renderer/src/panels/InsertPanel.tsx', 'src/renderer/src/panels/Inspector.tsx', 'src/renderer/src/panels/Chat.tsx', 'src/renderer/src/lib/inspect.ts', 'src/renderer/src/lib/clipboard.ts', 'src/renderer/src/lib/actions.ts']) expect(files).not.toContain(file);
    // Welcome's own dialogs are the only panels: Settings and the settings it shows.
    expect(files.filter((f) => f.startsWith('src/renderer/src/panels/')).sort()).toEqual(['src/renderer/src/panels/LocalModelSettings.tsx', 'src/renderer/src/panels/SettingsModal.tsx', 'src/renderer/src/panels/ShortcutSettings.tsx']);
  });

  it('never the code editor, nor the engine’s editing', () => {
    expect([...packages.keys()].filter((p) => /codemirror|@lezer|@uiw/.test(p))).toEqual([]);
    for (const file of ['src/engine/apply.ts', 'src/engine/validate.ts']) expect(files).not.toContain(file);
  });

  it('only the icons Welcome draws, never Lucide’s whole set', () => {
    const lucide = packages.get('lucide-react');
    expect(lucide?.size).toBeGreaterThan(0);
    for (const all of ['icons', '*', 'default']) expect(lucide?.has(all)).toBe(false);
  });

  it('loads the editor by import() alone, from one place', () => {
    const loader = readFileSync('src/renderer/src/lib/editor-module.ts', 'utf8');
    expect(loader).toMatch(/import\('\.\.\/editor-entry'\)/);
  });
});
