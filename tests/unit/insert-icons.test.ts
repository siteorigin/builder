/**
 * Insert, Quick insert, the command menu and the change-design dialog show an icon beside what can be inserted, named
 * by a component's definition or by the app's own entries. Only those icons are in the app, not Lucide's whole set of
 * some two thousand (#958): every name the shipped theme packs and the app use shows its own icon, and any other name a
 * box, as a name Lucide has no icon for always did.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import * as lucide from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { getTheme, listThemes } from '@catalogue/index';
import { BASICS } from '../../src/renderer/src/lib/insert-search';

// Renderer code, outside this test project's types: loaded by a path the type checker does not follow.
const ICONS = '../../src/renderer/src/components/InsertIcon';
const { insertIcon } = (await import(/* @vite-ignore */ ICONS)) as { insertIcon(name: string | undefined): unknown };

const pascal = (name: string) =>
  name
    .split('-')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
const own = (name: string) => (lucide as unknown as Record<string, unknown>)[pascal(name)];

/** The names the app gives its own entries: a collection's list, a slot, and Quick insert's fallbacks. */
const APP_NAMES = ['list', 'square-dashed', 'component', 'layout-template'];

describe('the icons beside what can be inserted', () => {
  it('shows every icon a shipped theme pack, a basic element or the app names', () => {
    const named = new Set<string>(APP_NAMES);
    for (const theme of listThemes()) for (const c of getTheme(theme.id).components) if (c.icon) named.add(c.icon);
    for (const b of BASICS) named.add(b.icon);
    expect(named.size).toBeGreaterThan(APP_NAMES.length);
    const missing = [...named].filter((name) => !own(name) || insertIcon(name) !== own(name));
    expect(missing).toEqual([]);
  });

  it('shows a box for a name it does not have, and for none', () => {
    expect(insertIcon('not-an-icon')).toBe(lucide.Box);
    // A real Lucide icon no definition the app ships names.
    expect(insertIcon('ferris-wheel')).toBe(lucide.Box);
    expect(insertIcon(undefined)).toBe(lucide.Box);
    expect(insertIcon('constructor')).toBe(lucide.Box);
    // Written as Lucide exports it, too.
    expect(insertIcon('LayoutGrid')).toBe(lucide.LayoutGrid);
  });

  it('never imports Lucide’s whole set anywhere in the editor', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk('src/renderer/src');
    const whole: string[] = [];
    for (const file of files) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      for (const node of source.statements) {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || !node.moduleSpecifier.text.startsWith('lucide-react')) continue;
        const bindings = node.importClause?.namedBindings;
        const names = bindings && ts.isNamedImports(bindings) ? bindings.elements.map((e) => (e.propertyName ?? e.name).text) : [];
        if (node.moduleSpecifier.text !== 'lucide-react' || node.importClause?.name || (bindings && ts.isNamespaceImport(bindings)) || names.some((n) => n === 'icons' || n === 'DynamicIcon')) whole.push(file);
      }
    }
    expect(whole).toEqual([]);
  });
});
