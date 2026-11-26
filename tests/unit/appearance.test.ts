import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { editorBackground, editorScheme, knownAppearance } from '@shared/appearance';

function rendererCssFiles(dir = 'src/renderer/src'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...rendererCssFiles(full));
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}

// The editor's Appearance styles the editor and never the website it previews (#202).
describe('editor appearance', () => {
  it('draws the editor in the chosen scheme, or this computer’s on System', () => {
    expect(editorScheme('light', true)).toBe('light');
    expect(editorScheme('dark', false)).toBe('dark');
    expect(editorScheme('system', true)).toBe('dark');
    expect(editorScheme('system', false)).toBe('light');
    expect(editorScheme(undefined, true)).toBe('dark');
    expect(editorBackground('dark')).toBe('#11151c');
    expect(editorBackground('light')).toBe('#ebeff4');
  });

  it('takes a saved Appearance it does not know as System, so the editor still follows this computer', () => {
    expect(knownAppearance('light')).toBe('light');
    expect(knownAppearance('dark')).toBe('dark');
    for (const unknown of ['system', null, undefined, 'purple', 1]) expect(knownAppearance(unknown)).toBe('system');
    expect(editorScheme(null, false)).toBe('light');
    expect(editorScheme(null, true)).toBe('dark');
    expect(editorScheme('purple', true)).toBe('dark');
  });

  it('leaves Electron following this computer, so the preview’s color scheme is a visitor’s', () => {
    // Setting Electron's theme forces prefers-color-scheme on every page, the website preview included.
    const main = readFileSync('src/main/index.ts', 'utf8');
    expect(main).not.toMatch(/themeSource\s*=/);
    const allCss = rendererCssFiles().map((f) => readFileSync(f, 'utf8')).join('\n');
    const entry = readFileSync('src/renderer/src/main.tsx', 'utf8');
    const indexCss = readFileSync('src/renderer/src/styles/index.css', 'utf8');
    const tokens = readFileSync('src/renderer/src/styles/tokens.css', 'utf8');
    const reset = readFileSync('src/renderer/src/styles/reset.css', 'utf8');
    // The entry point loads the layered stylesheet foundation.
    expect(entry).toMatch(/import ['"]\.\/styles\/index\.css['"]/);
    expect(indexCss).toContain("@import './tokens.css';");
    expect(indexCss).toContain("@import './reset.css';");
    expect(indexCss).toContain("@import './primitives.css';");
    // The editor themes itself from its own attribute, not the media query the website also sees.
    expect(allCss).not.toContain('prefers-color-scheme');
    expect(tokens).toMatch(/:root:where\(\[data-appearance='dark'\]\) \{\n\s*color-scheme: dark;/);
    // A frame's page takes its color scheme from the <iframe> element, which would inherit the editor's.
    expect(reset).toMatch(/^\s*iframe \{ color-scheme: light dark; \}$/m);
  });
});
