import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appearanceFromArgv, appearanceSwitch, editorBackground, editorScheme } from '@shared/appearance';

// The editor's Appearance styles the editor and never the website it previews (#202).
describe('editor appearance', () => {
  it('draws the editor in the chosen scheme, or this computer’s on System', () => {
    expect(editorScheme('light', true)).toBe('light');
    expect(editorScheme('dark', false)).toBe('dark');
    expect(editorScheme('system', true)).toBe('dark');
    expect(editorScheme('system', false)).toBe('light');
    expect(editorScheme(undefined, true)).toBe('dark');
    expect(editorBackground('dark')).toBe('#11151c');
    expect(editorBackground('light')).toBe('#f2f4f7');
  });

  it('hands a new window its Appearance, and anything else is System', () => {
    expect(appearanceFromArgv(['electron', '--flag', appearanceSwitch('dark')])).toBe('dark');
    expect(appearanceFromArgv([appearanceSwitch('light')])).toBe('light');
    expect(appearanceFromArgv([appearanceSwitch('system')])).toBe('system');
    expect(appearanceFromArgv(['--so-appearance=purple'])).toBe('system');
    expect(appearanceFromArgv([])).toBe('system');
  });

  it('leaves Electron following this computer, so the preview’s color scheme is a visitor’s', () => {
    // Setting Electron's theme forces prefers-color-scheme on every page, the website preview included.
    const main = readFileSync('src/main/index.ts', 'utf8');
    expect(main).not.toMatch(/themeSource\s*=/);
    const css = readFileSync('src/renderer/src/styles.css', 'utf8');
    // The editor themes itself from its own attribute, not the media query the website also sees.
    expect(css).not.toContain('prefers-color-scheme');
    expect(css).toMatch(/:root:where\(\[data-appearance='dark'\]\) \{\n  color-scheme: dark;/);
    // A frame's page takes its color scheme from the <iframe> element, which would inherit the editor's.
    expect(css).toMatch(/^iframe \{ color-scheme: light dark; \}$/m);
  });
});
