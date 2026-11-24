import { ClipboardCopy, ClipboardPaste } from 'lucide-react';
import type { MenuItem } from '../components/ui';
import { api, getState, useStore, type State } from '../store';

/** A shortcut as this computer writes it: ⌘C on a Mac, Ctrl+C elsewhere. */
export const platformKeys = (k: string) => (api.platform === 'darwin' ? k : k.replace('⇧⌘', 'Ctrl+Shift+').replace('⌘', 'Ctrl+'));

/** What a menu does for Copy and Paste: `copy` when the selection can be copied (content on a page), `paste` where a
 *  paste is offered. Either is left out of the menu when null. */
export interface CopyPasteActions {
  copy: (() => void) | null;
  paste: (() => void) | null;
}

function itemsFor(actions: CopyPasteActions, copied: State['copyNote'], opening: string | undefined, readOnly: boolean): MenuItem[] {
  // A copy belongs to the opening of the project it was taken in: a menu opened in another one has nothing to paste.
  const available = !!copied && copied.opening === opening;
  return [
    ...(actions.copy ? [{ label: 'Copy', icon: <ClipboardCopy />, shortcut: platformKeys('⌘C'), onSelect: actions.copy }] : []),
    // Stays in the menu, unavailable, until something is copied: the way to paste is then there to be found.
    ...(actions.paste ? [{ label: 'Paste', icon: <ClipboardPaste />, shortcut: platformKeys('⌘V'), disabled: !available || readOnly, onSelect: actions.paste }] : [])
  ];
}

/** Copy and Paste for a menu opened now (Canvas, Layers). */
export function copyPasteItems(actions: CopyPasteActions): MenuItem[] {
  const s = getState();
  return itemsFor(actions, s.copyNote, s.snapshot?.workspaceKey, !!s.snapshot?.readOnly);
}

/** The same items for the Inspector's actions menu, kept current as a copy is taken. */
export function useCopyPasteItems(actions: CopyPasteActions): MenuItem[] {
  const copied = useStore((s) => s.copyNote);
  const opening = useStore((s) => s.snapshot?.workspaceKey);
  const readOnly = useStore((s) => !!s.snapshot?.readOnly);
  return itemsFor(actions, copied, opening, readOnly);
}
