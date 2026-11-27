/**
 * The theme folders under src/catalogue/ hold themes only, so one can move to its own repository without taking the
 * app's code with it (#995): what the app itself reads lives in src/shared/ or in the pack format.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const ROOT = resolve(__dirname, '../..');
const CORE = ['src/agent', 'src/engine', 'src/generator', 'src/main', 'src/preload', 'src/renderer/src', 'src/runtime', 'src/shared', 'scripts'];
const THEME = /^src\/catalogue\/(?:foundation|editorial|signal)(?:\/|$)/;

const sources = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(f))
    .map((f) => join(dir, f));

/** The repository path an import names, or undefined for a package. */
function target(from: string, specifier: string): string | undefined {
  if (specifier.startsWith('@catalogue/')) return `src/catalogue/${specifier.slice('@catalogue/'.length)}`;
  return specifier.startsWith('.') ? relative(ROOT, resolve(ROOT, dirname(from), specifier)) : undefined;
}

/** Every module a file names: static, type-only and dynamic imports, and re-exports. */
const imported = (file: string) => ts.preProcessFile(readFileSync(join(ROOT, file), 'utf8'), true, true).importedFiles.map((i) => i.fileName);

describe('theme folders', () => {
  it('are imported by no app or script module', () => {
    const files = CORE.flatMap(sources);
    // A scan that found nothing to read would pass whatever the imports are.
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap((file) =>
      imported(file)
        .filter((specifier) => THEME.test(target(file, specifier) ?? ''))
        .map((specifier) => `${file.replace(/\\/g, '/')} imports ${specifier}`)
    );
    expect(found).toEqual([]);
  });
});
