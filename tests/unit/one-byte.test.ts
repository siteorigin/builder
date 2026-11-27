// The app's scripts are kept to characters V8 holds one byte each (#1043): the build writes the wide characters of
// String.raw templates as substitutions of themselves, and fails a build whose scripts still hold one.
import { describe, expect, it } from 'vitest';
import * as oneByte from '../../build/one-byte.cjs';

/** The plugin's last generateBundle on `bundle`, with the error it raised, if any. */
function check(bundle: Parameters<oneByte.OneByteScriptsPlugin['generateBundle']['handler']>[1]): string | null {
  const plugin = oneByte.oneByteScriptsPlugin('renderer');
  expect(plugin.generateBundle.order).toBe('post');
  try {
    plugin.generateBundle.handler.call(
      {
        error(message: string): never {
          throw new Error(message);
        }
      },
      {},
      bundle
    );
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** What a module's exports are, run as a script (`export const` read back as an object). */
function exportsOf(code: string): Record<string, unknown> {
  const body = code.replace(/export const (\w+) =/g, 'out.$1 =');
  return new Function('tag', `const out = {}; ${body}; return out;`)((strings: TemplateStringsArray) => strings.raw.join('|')) as Record<string, unknown>;
}

describe('one-byte scripts', () => {
  it('find each character above U+00FF with its line, column and code point, and none at or below it', () => {
    expect(oneByte.wideCharacters('const a = "café £5";\n// fine: ÿ')).toEqual([]);
    const found = oneByte.wideCharacters('let a = 1;\nconst b = "It’s";\nconst c = `€ and 😀`;');
    expect(found.map((w) => [w.codePoint, w.line, w.column])).toEqual([
      ['U+2019', 2, 14],
      ['U+20AC', 3, 12],
      ['U+1F600', 3, 18]
    ]);
    expect(found[0].context).toContain('It’s');
    expect(oneByte.wideCharacters('’’’’’’’’', 3)).toHaveLength(3);
  });

  it('write a String.raw template’s wide characters as substitutions of themselves: the same string, one byte each', () => {
    const code = [
      'export const page = String.raw`/** "./_app/…": links */ const re = /\\d+\\s*–/; ${"kept"} 😀 end`;',
      'export const price = new RegExp(String.raw`^[$€£¥₹]\\s*(\\d+)$`);',
      'export const nested = String.raw`a${String.raw`b…`}c`;'
    ].join('\n');
    const out = oneByte.escapeRawTemplates(code);
    expect(oneByte.wideCharacters(out)).toEqual([]);
    expect(out).toContain('"./_app/${"\\u2026"}"');
    expect(out).toContain('${"\\u{1f600}"}');
    const before = exportsOf(code);
    const after = exportsOf(out);
    expect(after.page).toBe(before.page);
    expect(after.page).toContain('"./_app/…": links */ const re = /\\d+\\s*–/; kept 😀 end');
    expect(after.nested).toBe('ab…c');
    // The pattern is the very same one: its source, and what it matches.
    expect((after.price as RegExp).source).toBe((before.price as RegExp).source);
    expect(['€ 349', '₹349', '£5'].map((t) => (after.price as RegExp).exec(t)?.[1])).toEqual(['349', '349', '5']);
  });

  it('leave other templates, strings, comments and an escaped character as they are, for the check to name', () => {
    const code = 'export const t = tag`q…`;\nexport const s = "s…"; // note…\nexport const e = String.raw`\\…`;';
    expect(oneByte.escapeRawTemplates(code)).toBe(code);
    expect(exportsOf(code).t).toBe('q…');
    const plain = 'export const a = 1;';
    expect(oneByte.escapeRawTemplates(plain)).toBe(plain);
    // The plugin rewrites a chunk only when there is something to rewrite.
    const plugin = oneByte.oneByteScriptsPlugin('main');
    expect(plugin.renderChunk(plain)).toBeNull();
    expect(plugin.renderChunk('export const a = String.raw`…`;')).toEqual({ code: 'export const a = String.raw`${"\\u2026"}`;', map: null });
  });

  it('fail a build whose script chunk holds one, naming the chunk and where, and pass Latin-1 and assets', () => {
    expect(check({ 'index.js': { type: 'chunk', code: 'const a = "café £5 \\u2019";' }, 'sync-sources.mjs': { type: 'asset', source: 'It’s an asset' } })).toBeNull();
    const message = check({ 'index.js': { type: 'chunk', code: 'ok' }, 'assets/editor-entry.js': { type: 'chunk', code: 'x = tag`a…b`' } });
    expect(message).toContain('two bytes per character');
    expect(message).toContain('assets/editor-entry.js: U+2026 at 1:10');
    expect(message).not.toContain('index.js:');
  });
});
