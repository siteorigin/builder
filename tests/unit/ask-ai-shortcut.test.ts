import { describe, expect, it } from 'vitest';
import { DEFAULT_SHORTCUTS, matchesShortcut, normalShortcut, recordShortcut, shortcutAria, shortcutConflict, shortcutHint, type ShortcutChord } from '../../src/shared/shortcuts';
import { recordedPress, shortcutLabel } from '../../src/renderer/src/lib/shortcut-keys';
import { forwardsKey } from '../../src/main/history-keys';

const press = (key: string, held: Partial<ShortcutChord> = {}): ShortcutChord => ({ key, meta: false, ctrl: false, shift: false, alt: false, ...held });
const PLATFORMS = [
  { platform: 'darwin', mac: true, mod: { meta: true } },
  { platform: 'win32', mac: false, mod: { ctrl: true } },
  { platform: 'linux', mac: false, mod: { ctrl: true } }
] as const;

describe('Ask AI shortcut binding (#750)', () => {
  it('defaults to Command+J on a Mac and Ctrl+J elsewhere', () => {
    expect(DEFAULT_SHORTCUTS.askAi).toBe('Mod+J');
    expect(matchesShortcut(press('j', { meta: true }), 'Mod+J', true)).toBe(true);
    expect(matchesShortcut(press('j', { ctrl: true }), 'Mod+J', false)).toBe(true);
  });

  it('takes only the platform’s own modifier, alone: never Ctrl on a Mac, the Windows key elsewhere, or both', () => {
    expect(matchesShortcut(press('l', { ctrl: true }), 'Mod+L', true)).toBe(false);
    expect(matchesShortcut(press('l', { ctrl: true, shift: false }), 'Mod+Shift+L', true)).toBe(false);
    expect(matchesShortcut(press('l', { meta: true, ctrl: true }), 'Mod+L', true)).toBe(false);
    expect(matchesShortcut(press('l', { meta: true }), 'Mod+L', false)).toBe(false);
    expect(matchesShortcut(press('l', { meta: true, ctrl: true }), 'Mod+L', false)).toBe(false);
  });

  it('matches the binding exactly: Shift as given, never Alt', () => {
    expect(matchesShortcut(press('L', { meta: true, shift: true }), 'Mod+Shift+L', true)).toBe(true);
    expect(matchesShortcut(press('l', { meta: true }), 'Mod+Shift+L', true)).toBe(false);
    expect(matchesShortcut(press('J', { meta: true, shift: true }), 'Mod+J', true)).toBe(false);
    expect(matchesShortcut(press('j', { ctrl: true, alt: true }), 'Mod+J', false)).toBe(false);
    expect(matchesShortcut(press('j', { meta: true, alt: true }), 'Mod+J', true)).toBe(false);
    // A binding that cannot be used matches nothing, not the default.
    expect(matchesShortcut(press('j', { meta: true }), 'Mod+Banana', true)).toBe(false);
    expect(matchesShortcut(press('j'), 'Mod+J', true)).toBe(false);
    // A rebound shortcut leaves the default free.
    expect(matchesShortcut(press('j', { meta: true }), 'Mod+L', true)).toBe(false);
  });

  it('knows a key by what it types first, a number-row key by its place, and a non-Latin letter by its place', () => {
    // Dvorak's J sits where QWERTY has C: what it types wins.
    expect(matchesShortcut(press('j', { meta: true, code: 'KeyC' }), 'Mod+J', true)).toBe(true);
    expect(matchesShortcut(press('c', { meta: true, code: 'KeyJ' }), 'Mod+J', true)).toBe(false);
    // Shift turns a digit into a symbol; the main process and the editor both see the key's place.
    expect(matchesShortcut(press('&', { ctrl: true, shift: true, code: 'Digit7' }), 'Mod+Shift+7', false)).toBe(true);
    expect(matchesShortcut(press('@', { meta: true, shift: true, code: 'Digit2' }), 'Mod+Shift+2', true)).toBe(true);
    expect(matchesShortcut(press('@', { meta: true, shift: true, code: 'Digit2' }), 'Mod+Shift+7', true)).toBe(false);
    // Punctuation a layout puts on the number row unshifted (Programmer Dvorak's [ on 2) is not that digit: Cmd+[ is
    // Back in Preview.
    expect(matchesShortcut(press('[', { meta: true, code: 'Digit2' }), 'Mod+2', true)).toBe(false);
    expect(recordShortcut(press('[', { meta: true, code: 'Digit2' }), true)).toEqual({ problem: expect.stringContaining('Back in Preview') });
    // AZERTY types é on the 2 key without Shift: a letter, so the key's place names it.
    expect(recordShortcut(press('é', { ctrl: true, code: 'Digit2' }), false)).toEqual({ binding: 'Mod+2' });
    expect(matchesShortcut(press('é', { ctrl: true, code: 'Digit2' }), 'Mod+2', false)).toBe(true);
    expect(matchesShortcut(press('λ', { ctrl: true, code: 'KeyL' }), 'Mod+L', false)).toBe(true);
    expect(matchesShortcut(press('о', { ctrl: true, code: 'KeyJ' }), 'Mod+J', false)).toBe(true);
    // A dead key, an unknown one, or punctuation on a letter's place is never that letter.
    expect(matchesShortcut(press('Dead', { meta: true, code: 'KeyL' }), 'Mod+L', true)).toBe(false);
    expect(matchesShortcut(press('Unidentified', { meta: true, code: 'KeyL' }), 'Mod+L', true)).toBe(false);
    expect(matchesShortcut(press(';', { meta: true, code: 'KeyL' }), 'Mod+L', true)).toBe(false);
  });

  it('records what it then matches, on every platform', () => {
    for (const { mac, mod } of PLATFORMS) {
      for (const k of [press('l', mod), press('L', { ...mod, shift: true }), press('7', mod), press('&', { ...mod, shift: true, code: 'Digit7' })]) {
        const r = recordShortcut(k, mac);
        expect(r && 'binding' in r).toBe(true);
        expect(matchesShortcut(k, (r as { binding: string }).binding, mac)).toBe(true);
      }
    }
    expect(recordShortcut(press('L', { ctrl: true, shift: true }), false)).toEqual({ binding: 'Mod+Shift+L' });
  });

  it('waits through a modifier pressed alone, and explains a press it cannot use', () => {
    expect(recordShortcut(press('Meta', { meta: true }), true)).toBeNull();
    expect(recordShortcut(press('Shift', { shift: true }), false)).toBeNull();
    expect(recordShortcut(press('Control', { ctrl: true }), false)).toBeNull();
    for (const k of [press('l'), press('l', { ctrl: true }), press('l', { meta: true, ctrl: true }), press('l', { meta: true, alt: true }), press('F5', { meta: true })]) {
      expect(recordShortcut(k, true)).toEqual({ problem: expect.stringContaining('Command') });
    }
    expect(recordShortcut(press('l', { meta: true }), false)).toEqual({ problem: expect.stringContaining('Ctrl') });
    // Another editor shortcut on a key that is not a letter is named.
    expect(recordShortcut(press('\\', { meta: true }), true)).toEqual({ problem: expect.stringContaining('sidebar') });
    expect(recordShortcut(press('ArrowUp', { ctrl: true, shift: true }), false)).toEqual({ problem: expect.stringContaining('Move up') });
    // Without Shift it is not Move up: only the usual advice.
    expect(recordShortcut(press('ArrowUp', { ctrl: true }), false)).toEqual({ problem: expect.not.stringContaining('Move up') });
    expect(recordShortcut(press('|', { meta: true, shift: true }), true)).toEqual({ problem: expect.stringContaining('right panel') });
    expect(recordShortcut(press('-', { meta: true }), true)).toEqual({ problem: expect.stringContaining('Zoom Out') });
    expect(recordShortcut(press('Enter', { ctrl: true, shift: true }), false)).toEqual({ problem: expect.stringContaining('Done') });
  });

  it('refuses a binding another editor shortcut has, and says which', () => {
    expect(shortcutConflict('Mod+K', 'darwin')).toMatch(/command menu/);
    expect(shortcutConflict('Mod+Z', 'win32')).toMatch(/Undo/);
    expect(shortcutConflict('Mod+Shift+Z', 'linux')).toMatch(/Redo/);
    expect(shortcutConflict('Mod+S', 'darwin')).toMatch(/Save/);
    // Duplicate, Export and the command menu take their key with Shift held too.
    expect(shortcutConflict('Mod+Shift+D', 'darwin')).toMatch(/Duplicate/);
    expect(shortcutConflict('Mod+Shift+K', 'darwin')).toMatch(/command menu/);
    expect(shortcutConflict('Mod+Shift+G', 'darwin')).toMatch(/Ungroup/);
    expect(shortcutConflict('Mod+Shift+F', 'darwin')).toMatch(/Find and replace/);
    expect(shortcutConflict('Mod+B', 'darwin')).toMatch(/Bold/);
    expect(shortcutConflict('Mod+A', 'darwin')).toMatch(/Select all/);
    expect(shortcutConflict('Mod+Shift+E', 'win32')).toMatch(/Export/);
    expect(shortcutConflict('Mod+Shift+U', 'darwin')).toMatch(/Redo Selection/);
    expect(shortcutConflict('Mod+Shift+U', 'linux')).toMatch(/Unicode/);
    expect(shortcutConflict('Mod+Shift+U', 'win32')).toBeNull();
    expect(shortcutConflict('Mod+Shift+Y', 'darwin')).toMatch(/Redo/);
    // Chromium pastes plain text on Ctrl+Shift+V into any field, the preview's too, off macOS.
    expect(shortcutConflict('Mod+Shift+V', 'win32')).toMatch(/Paste as Plain Text/);
    expect(shortcutConflict('Mod+Shift+V', 'linux')).toMatch(/Paste as Plain Text/);
  });

  it('refuses what the platform or the app menu keeps, and says which, only where it does', () => {
    expect(shortcutConflict('Mod+Q', 'darwin')).toMatch(/Quit/);
    expect(shortcutConflict('Mod+Q', 'linux')).toMatch(/Quit/);
    expect(shortcutConflict('Mod+Q', 'win32')).toBeNull();
    expect(shortcutConflict('Mod+W', 'win32')).toMatch(/Close Window/);
    expect(shortcutConflict('Mod+R', 'darwin')).toMatch(/Reload/);
    expect(shortcutConflict('Mod+H', 'darwin')).toMatch(/Hide/);
    expect(shortcutConflict('Mod+H', 'win32')).toBeNull();
    for (const d of ['3', '4', '5', '6']) expect(shortcutConflict(`Mod+Shift+${d}`, 'darwin')).toMatch(/macOS.*screenshots/);
    expect(shortcutConflict('Mod+Shift+4', 'win32')).toBeNull();
    expect(shortcutConflict('Mod+Shift+I', 'linux')).toMatch(/Developer Tools/);
    // Paste and Match Style is Option+Shift+Command+V, which no binding can be.
    expect(shortcutConflict('Mod+Shift+V', 'darwin')).toBeNull();
  });

  it('leaves a free binding free, including the default', () => {
    for (const platform of ['darwin', 'win32', 'linux']) for (const b of ['Mod+J', 'Mod+L', 'Mod+Shift+J', 'Mod+1', 'Mod+2', 'Mod+Shift+A']) expect(shortcutConflict(b, platform)).toBeNull();
    expect(shortcutConflict('Alt+J', 'darwin')).toMatch(/not a shortcut/);
  });

  it('keeps only bindings it can use, written one way', () => {
    expect(normalShortcut('Mod+Shift+L')).toBe('Mod+Shift+L');
    for (const bad of ['Mod+Ctrl+L', 'Mod+Alt+L', 'Shift+L', 'Mod+l', 'Mod+Shift+Shift+L', 'Mod+F1', '', 42, null]) expect(normalShortcut(bad)).toBeNull();
  });

  it('shows the binding in every hint, as each platform writes it', () => {
    expect(shortcutHint('Mod+J')).toBe('⌘J');
    expect(shortcutHint('Mod+Shift+L')).toBe('⇧⌘L');
    expect(shortcutLabel(shortcutHint('Mod+Shift+L'), 'win32')).toBe('Ctrl+Shift+L');
    expect(shortcutAria('Mod+Shift+L', true)).toBe('Meta+Shift+L');
    expect(shortcutAria('Mod+L', false)).toBe('Control+L');
    expect(shortcutAria('Mod+Shift+L', false)).toBe('Control+Shift+L');
  });
});

describe('recording Ask AI’s key in Settings (#750)', () => {
  it('records a free key press, and refuses a taken one naming what has it', () => {
    expect(recordedPress(press('l', { meta: true }), 'darwin')).toEqual({ kind: 'record', binding: 'Mod+L' });
    expect(recordedPress(press('k', { meta: true }), 'darwin')).toEqual({ kind: 'refuse', problem: '⌘K can’t be used. It’s already the shortcut for the command menu.' });
    expect(recordedPress(press('w', { ctrl: true }), 'win32')).toEqual({ kind: 'refuse', problem: expect.stringContaining('Close Window') });
    expect(recordedPress(press('V', { ctrl: true, shift: true }), 'win32')).toEqual({ kind: 'refuse', problem: 'Ctrl+Shift+V can’t be used. It’s already the shortcut for Paste as Plain Text.' });
    // A press that is no shortcut at all is refused with how to make one, not waited through.
    expect(recordedPress(press('l'), 'darwin')).toEqual({ kind: 'refuse', problem: expect.stringContaining('Command') });
  });

  it('cancels on Escape or Tab, and waits through a modifier on its own', () => {
    expect(recordedPress(press('Escape'), 'darwin')).toEqual({ kind: 'cancel' });
    expect(recordedPress(press('Tab'), 'win32')).toEqual({ kind: 'cancel' });
    expect(recordedPress(press('Shift', { shift: true }), 'darwin')).toEqual({ kind: 'wait' });
    // Shift+Tab moves back out too.
    expect(recordedPress(press('Tab', { shift: true }), 'darwin')).toEqual({ kind: 'cancel' });
    // With Command or Ctrl held they are presses like any other, refused.
    expect(recordedPress(press('Escape', { meta: true }), 'darwin')).toMatchObject({ kind: 'refuse' });
    expect(recordedPress(press('Tab', { ctrl: true }), 'win32')).toMatchObject({ kind: 'refuse' });
  });
});

describe('the main process passing Ask AI on from the preview (#750)', () => {
  it('forwards the binding in use, on its platform, and no longer the old Cmd/Ctrl+J once moved', () => {
    expect(forwardsKey(press('j', { meta: true }), 'Mod+J', true)).toBe(true);
    expect(forwardsKey(press('L', { meta: true, shift: true }), 'Mod+Shift+L', true)).toBe(true);
    expect(forwardsKey(press('L', { ctrl: true, shift: true }), 'Mod+Shift+L', false)).toBe(true);
    expect(forwardsKey(press('j', { meta: true }), 'Mod+Shift+L', true)).toBe(false);
    expect(forwardsKey(press('l', { meta: true }), 'Mod+Shift+L', true)).toBe(false);
    // The other editor shortcuts still go through as before.
    for (const k of ['k', 's', 'z', '\\']) expect(forwardsKey(press(k, { meta: true }), 'Mod+Shift+L', true)).toBe(true);
    expect(forwardsKey(press('Escape'), 'Mod+L', true)).toBe(true);
    expect(forwardsKey(press('a'), 'Mod+L', true)).toBe(false);
    expect(forwardsKey(press('[', { meta: true }), 'Mod+L', true)).toBe(true);
  });
});
