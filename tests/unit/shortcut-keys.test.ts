import { describe, expect, it } from 'vitest';
import { shortcutLabel } from '../../src/renderer/src/lib/shortcut-keys';

describe('shortcut hints for each platform', () => {
  it('keeps the Mac glyphs on a Mac', () => {
    for (const k of ['⌘J', '⇧⌘↑', '⌫', '⇧⌘\\', '⌘↩', 'F2']) expect(shortcutLabel(k, 'darwin')).toBe(k);
  });

  it('names Command as Ctrl and Shift by name on Windows and Linux, in their order', () => {
    expect(shortcutLabel('⌘J', 'win32')).toBe('Ctrl+J');
    expect(shortcutLabel('⌘D', 'win32')).toBe('Ctrl+D');
    expect(shortcutLabel('⇧⌘F', 'win32')).toBe('Ctrl+Shift+F');
    expect(shortcutLabel('⇧⌘↑', 'win32')).toBe('Ctrl+Shift+↑');
    expect(shortcutLabel('⇧⌘\\', 'win32')).toBe('Ctrl+Shift+\\');
    expect(shortcutLabel('⌥⌘I', 'win32')).toBe('Ctrl+Alt+I');
    expect(shortcutLabel('⌃⇧Tab', 'win32')).toBe('Ctrl+Shift+Tab');
    expect(shortcutLabel('⌥⇧K', 'win32')).toBe('Alt+Shift+K');
  });

  it('reads the same on Linux as on Windows', () => {
    expect(shortcutLabel('⇧⌘↑', 'linux')).toBe('Ctrl+Shift+↑');
    expect(shortcutLabel('⌫', 'linux')).toBe('Del');
    expect(shortcutLabel('⌥⌘I', 'linux')).toBe('Ctrl+Alt+I');
    for (const k of ['⌘J', '⇧⌘↑', '⌫', '⌘↩', 'F2']) expect(shortcutLabel(k, 'linux')).toBe(shortcutLabel(k, 'win32'));
  });

  it('names the keys the Mac draws as glyphs', () => {
    expect(shortcutLabel('⌫', 'win32')).toBe('Del');
    expect(shortcutLabel('⌘↩', 'win32')).toBe('Ctrl+Enter');
    expect(shortcutLabel('↵', 'win32')).toBe('Enter');
    expect(shortcutLabel('⌦', 'win32')).toBe('Del');
    expect(shortcutLabel('⎋', 'win32')).toBe('Esc');
    expect(shortcutLabel('⇧⇥', 'win32')).toBe('Shift+Tab');
    expect(shortcutLabel('⇥', 'win32')).toBe('Tab');
  });

  it('leaves a hint already written for the platform as it is, so formatting twice changes nothing', () => {
    for (const k of ['Ctrl+C', 'Ctrl+Shift+Z', 'F2', 'Shift+F10', 'Del', 'Esc']) expect(shortcutLabel(k, 'win32')).toBe(k);
    for (const k of ['⌘J', '⇧⌘↑', '⌫', '⌘↩']) expect(shortcutLabel(shortcutLabel(k, 'win32'), 'win32')).toBe(shortcutLabel(k, 'win32'));
  });

  it('never leaves a Mac glyph in a hint for Windows or Linux', () => {
    const hints = ['⌘J', '⇧⌘F', '⌘C', '⌘V', '⌘Z', '⇧⌘Z', '⇧⌘N', '⌘O', '⌘E', '⇧⌘\\', '⇧⌘W', '⇧⌘↑', '⇧⌘↓', '⌘D', '⌫'];
    for (const k of hints) expect(shortcutLabel(k, 'win32')).not.toMatch(/[⌘⇧⌥⌃⌫]/);
  });
});
