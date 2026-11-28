/**
 * Shortcuts the author can reassign: for now only Ask AI. A binding is kept as text such as `Mod+J` or
 * `Mod+Shift+L`, where Mod is Command on macOS and Ctrl elsewhere. It always holds Mod, may hold Shift, and ends in a
 * letter or a digit. Alt is never part of one: Option changes the letter a Mac reports, and Ctrl+Alt is AltGr, which
 * types characters, on many Windows layouts.
 */

export interface ShortcutSettings {
  askAi: string;
}

export const DEFAULT_SHORTCUTS: ShortcutSettings = { askAi: 'Mod+J' };

/** A key press, as the editor's keydown handler and the main process's input events both report it. */
export interface ShortcutChord {
  key: string;
  /** The physical key (`KeyJ`, `Digit5`), when known: it names the key on layouts whose letters are not Latin. */
  code?: string;
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

interface Binding {
  shift: boolean;
  /** An upper-case letter or a digit. */
  key: string;
}

const KEY = /^[A-Z0-9]$/;

function parse(binding: string): Binding | null {
  const parts = binding.split('+');
  const key = parts.pop() ?? '';
  if (!KEY.test(key) || parts[0] !== 'Mod') return null;
  const rest = parts.slice(1);
  if (rest.length > 1 || (rest.length === 1 && rest[0] !== 'Shift')) return null;
  return { shift: rest.length === 1, key };
}

/** The binding as stored: `Mod+J`, `Mod+Shift+L`. */
const write = (b: Binding) => `Mod+${b.shift ? 'Shift+' : ''}${b.key}`;

/** A stored binding that can be used, written the one way; anything else is null. */
export function normalShortcut(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const b = parse(value);
  return b && write(b);
}

/**
 * The letter or digit a key press is on: by what it types; a number-row key with Shift held by its place, since Shift
 * types a symbol there; and a letter outside ASCII (Cyrillic, Greek, AZERTY's é on the 2 key) by its key's place. A
 * dead key or an unknown one is none, and so is punctuation a layout puts on the number row unshifted (Programmer
 * Dvorak's `[`, which is Back in Preview).
 */
function chordKey(k: Pick<ShortcutChord, 'key' | 'code' | 'shift'>): string | null {
  if (k.key.length !== 1) return null;
  const typed = k.key.toUpperCase();
  if (KEY.test(typed)) return typed;
  const place = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(k.code ?? '');
  if (!place) return null;
  if (place[2] && k.shift) return place[2];
  return /\p{L}/u.test(k.key) && !/[\x00-\x7f]/.test(k.key) ? (place[1] ?? place[2]) : null;
}

/** Whether exactly the platform's primary modifier is held: Command on a Mac, Ctrl elsewhere, never both. */
const primaryOnly = (k: Pick<ShortcutChord, 'meta' | 'ctrl'>, mac: boolean) => (mac ? k.meta && !k.ctrl : k.ctrl && !k.meta);

/**
 * Whether a key press is the binding on this platform (`mac`): Command there and Ctrl elsewhere, alone; Shift held
 * exactly as the binding says; Alt never. Recording and every key handler use this one test, so what Settings
 * shows is what works.
 */
export function matchesShortcut(k: ShortcutChord, binding: string, mac: boolean): boolean {
  const b = parse(binding);
  if (!b || !primaryOnly(k, mac) || k.alt || k.shift !== b.shift) return false;
  return chordKey(k) === b.key;
}

/** Shortcuts on keys that are not a letter or a number, named when one is pressed while recording (`⇧` for Shift). */
const OTHER_KEYS: Record<string, string> = {
  '\\': 'It’s already the shortcut for showing or hiding the sidebar.',
  '⇧\\': 'It’s already the shortcut for showing or hiding the right panel.',
  '⇧ArrowUp': 'It’s already the shortcut for Move up.',
  '⇧ArrowDown': 'It’s already the shortcut for Move down.',
  Enter: 'It’s already the shortcut for Done.',
  '⇧Enter': 'It’s already the shortcut for Done.',
  '-': 'The app menu uses it for Zoom Out.',
  '=': 'The app menu uses it for Zoom In.',
  '⇧+': 'The app menu uses it for Zoom In.',
  ',': 'The app menu uses it for Settings.'
};

/**
 * The binding a key press records in Settings, or why it cannot be one. `mac`: Command is Mod there, Ctrl elsewhere.
 * A press of a modifier alone is `null`: the author is still choosing.
 */
export function recordShortcut(k: ShortcutChord, mac: boolean): { binding: string } | { problem: string } | null {
  if (['Meta', 'Control', 'Shift', 'Alt', 'AltGraph', 'OS', 'CapsLock', 'Fn'].includes(k.key)) return null;
  const usage = `Use ${mac ? 'Command (⌘)' : 'Ctrl'} with a letter or a number, with or without Shift.`;
  if (!primaryOnly(k, mac) || k.alt) return { problem: usage };
  const key = chordKey(k);
  if (key) return { binding: write({ shift: k.shift, key }) };
  // With Shift held, macOS reports the backslash key as "|".
  const named = OTHER_KEYS[`${k.shift ? '⇧' : ''}${k.key === '|' ? '\\' : k.key}`] ?? (mac && !k.shift && (k.key === '[' || k.key === ']') ? `It’s already the shortcut for ${k.key === '[' ? 'Back' : 'Forward'} in Preview.` : undefined);
  return { problem: named ? `${named} ${usage}` : usage };
}

/** The binding as a Mac writes it (`⇧⌘L`), for `shortcutLabel` to put in each platform's words. */
export function shortcutHint(binding: string): string {
  const b = parse(binding) ?? parse(DEFAULT_SHORTCUTS.askAi)!;
  return `${b.shift ? '⇧' : ''}⌘${b.key}`;
}

/** The binding for `aria-keyshortcuts`: `Meta+Shift+L` on a Mac, `Control+Shift+L` elsewhere. */
export function shortcutAria(binding: string, mac: boolean): string {
  const b = parse(binding) ?? parse(DEFAULT_SHORTCUTS.askAi)!;
  return `${mac ? 'Meta' : 'Control'}+${b.shift ? 'Shift+' : ''}${b.key}`;
}

/** Every other editor shortcut that is Mod with a letter or a number, with what it does. */
const EDITOR: Record<string, string> = {
  'Mod+Z': 'Undo',
  'Mod+Shift+Z': 'Redo',
  'Mod+Y': 'Redo',
  'Mod+Shift+Y': 'Redo',
  'Mod+K': 'the command menu',
  'Mod+Shift+K': 'the command menu',
  'Mod+Shift+F': 'Find and replace',
  'Mod+S': 'Save',
  'Mod+Shift+S': 'Save',
  'Mod+D': 'Duplicate',
  'Mod+Shift+D': 'Duplicate',
  'Mod+G': 'Wrap in Stack',
  'Mod+Shift+G': 'Ungroup',
  'Mod+C': 'Copy',
  'Mod+V': 'Paste',
  'Mod+X': 'Cut',
  'Mod+A': 'Select all',
  'Mod+E': 'Export',
  'Mod+Shift+E': 'Export',
  'Mod+B': 'Bold',
  'Mod+I': 'Italic',
  'Mod+U': 'Underline',
  'Mod+O': 'Open Project',
  'Mod+Shift+N': 'New Project',
  'Mod+Shift+W': 'Close Project'
};

/** What the app's own menus (Electron's standard roles) keep, by platform as Node names it. */
function menuKeys(platform: string): Record<string, string> {
  const everywhere: Record<string, string> = { 'Mod+W': 'Close Window', 'Mod+M': 'Minimize', 'Mod+R': 'Reload', 'Mod+Shift+R': 'Force Reload', 'Mod+0': 'Actual Size' };
  if (platform === 'darwin') return { ...everywhere, 'Mod+Q': 'Quit', 'Mod+H': 'Hide SiteOrigin Builder' };
  // Windows has no key for Quit; Linux keeps Ctrl+Q for it.
  return { ...everywhere, 'Mod+Shift+I': 'Developer Tools', ...(platform === 'win32' ? {} : { 'Mod+Q': 'Quit' }) };
}

/** What macOS itself takes before an app sees the keys. */
const MAC_SYSTEM: Record<string, string> = { 'Mod+Shift+Q': 'Log Out', 'Mod+Shift+3': 'screenshots', 'Mod+Shift+4': 'screenshots', 'Mod+Shift+5': 'screenshots', 'Mod+Shift+6': 'screenshots' };

/** What Chromium's text editing takes for itself off macOS: Ctrl+Shift+V pastes plain text into any field. */
const TEXT_KEYS: Record<string, string> = { 'Mod+Shift+V': 'Paste as Plain Text' };

/** What typing in a field takes on one platform: the code editor's Redo Selection on a Mac, IBus's Unicode entry on Linux. */
const PLATFORM_TEXT_KEYS: Record<string, Record<string, string>> = {
  darwin: { 'Mod+Shift+U': 'Redo Selection in the code editor' },
  linux: { 'Mod+Shift+U': 'typing a Unicode character' }
};

/** The shortcuts macOS keeps that never reach the app, to show beside the recorder (they cannot be refused on press). */
export const MAC_SYSTEM_HINT = 'macOS keeps ⇧⌘3 to ⇧⌘6 and ⇧⌘Q for itself.';

/**
 * Why a binding cannot be Ask AI's, naming what already has it, or null when it is free. `platform` as Node names it
 * (darwin, win32, linux).
 */
export function shortcutConflict(binding: string, platform: string): string | null {
  const b = normalShortcut(binding);
  if (!b) return 'That is not a shortcut SiteOrigin Builder can use.';
  const editor = EDITOR[b] ?? (platform === 'darwin' ? undefined : TEXT_KEYS[b]) ?? PLATFORM_TEXT_KEYS[platform]?.[b];
  if (editor) return `It’s already the shortcut for ${editor}.`;
  const menu = menuKeys(platform)[b];
  if (menu) return `The app menu uses it for ${menu}.`;
  const system = platform === 'darwin' ? MAC_SYSTEM[b] : undefined;
  if (system) return `macOS keeps it for ${system}.`;
  return null;
}
