import { ClipboardCopy, ClipboardPaste } from 'lucide-react';
import type { MenuItem } from '../components/ui';
import { api, getState, useStore, type State } from '../store';
import { pasteFromMenu } from '../lib/clipboard';
import { shortcutLabel } from '../lib/shortcut-keys';

/** A shortcut as this computer writes it: ⌘C on a Mac, Ctrl+C elsewhere (see shortcutLabel). */
export const platformKeys = (k: string) => shortcutLabel(k, api.platform);

/** What a menu does for Copy and Paste: `copy` when the selection can be copied (content on a page), `paste` where a
 *  paste is offered. Either is left out of the menu when null. */
export interface CopyPasteActions {
  copy: (() => void) | null;
  paste: (() => void) | null;
}

function itemsFor(actions: CopyPasteActions, copied: State['copyNote'], opening: string | undefined, readOnly: boolean, editing: boolean): MenuItem[] {
  // A copy belongs to the opening of the project it was taken in: a menu opened in another one has nothing to paste.
  const available = !!copied && copied.opening === opening;
  return [
    ...(actions.copy ? [{ label: 'Copy', icon: <ClipboardCopy />, shortcut: platformKeys('⌘C'), onSelect: actions.copy }] : []),
    // Stays in the menu, unavailable, until something is copied (and while the page is only being previewed): the way to
    // paste is then there to be found.
    ...(actions.paste ? [{ label: 'Paste', icon: <ClipboardPaste />, shortcut: platformKeys('⌘V'), disabled: !available || readOnly || !editing, onSelect: actions.paste }] : [])
  ];
}

/** Copy and Paste for a menu opened now (Canvas, Layers). */
export function copyPasteItems(actions: CopyPasteActions): MenuItem[] {
  const s = getState();
  return itemsFor(actions, s.copyNote, s.snapshot?.workspaceKey, !!s.snapshot?.readOnly, s.mode === 'edit');
}

/** The same items for the Inspector's actions menu, kept current as a copy is taken. */
export function useCopyPasteItems(actions: CopyPasteActions): MenuItem[] {
  const copied = useStore((s) => s.copyNote);
  const opening = useStore((s) => s.snapshot?.workspaceKey);
  const readOnly = useStore((s) => !!s.snapshot?.readOnly);
  const editing = useStore((s) => s.mode === 'edit');
  return itemsFor(actions, copied, opening, readOnly, editing);
}

/**
 * A button that pastes what was copied onto the page being edited, for a page with no section to open a menu on.
 * Nothing is drawn until something is copied here.
 */
export function PasteHere({ className, follow = false }: { className?: string; follow?: boolean }) {
  const copied = useStore((s) => s.copyNote);
  const opening = useStore((s) => s.snapshot?.workspaceKey);
  const available = useStore((s) => s.mode === 'edit' && !s.snapshot?.readOnly);
  if (!copied || copied.opening !== opening || !available) return null;
  return (
    <button className={className} title={`Paste (${platformKeys('⌘V')})`} onClick={() => pasteFromMenu(follow)}>
      <ClipboardPaste /> Paste {copied.label}
    </button>
  );
}
