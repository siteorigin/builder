import { DEFAULT_SHORTCUTS, matchesShortcut, shortcutAria, shortcutHint, type ShortcutChord } from '@shared/shortcuts';
import { api, getState, useStore } from '../store';

/** The Edit with AI binding in use: the author's, from Settings, until they load the default. */
export const askAiBinding = (): string => getState().settings?.shortcuts?.askAi ?? DEFAULT_SHORTCUTS.askAi;

/** Edit with AI's key the Mac way (`⇧⌘L`), as it is now: for a menu built when it opens. */
export const askAiHint = (): string => shortcutHint(askAiBinding());

/** Whether a key press is Edit with AI's, wherever the author has put it (#750). */
export const isAskAiKey = (k: ShortcutChord): boolean => matchesShortcut(k, askAiBinding(), api.platform === 'darwin');

/**
 * Edit with AI's key for menus, tooltips and hints: `hint` the Mac way (`⇧⌘L`, for `shortcutLabel` or a menu's
 * `shortcut`), `aria` for `aria-keyshortcuts`. Follows a change in Settings at once.
 */
export function useAskAiKeys(): { hint: string; aria: string } {
  const binding = useStore((s) => s.settings?.shortcuts?.askAi) ?? DEFAULT_SHORTCUTS.askAi;
  return { hint: shortcutHint(binding), aria: shortcutAria(binding, api.platform === 'darwin') };
}
