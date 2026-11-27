/**
 * The header menu's order setting (engine/header-order.ts), as the Inspector's header menu and the Pages panel's
 * order note both offer it: Own order, where the menu keeps the order the author gave it, or Follow page order.
 */
import { followsPageOrder } from '@engine/header-order';
import { commitOps, confirmDialog, getState, toast, undoAction } from '../store';
import { headerOrderPreview } from './page-navigation';
import { aiChanging } from './blocked';

export type HeaderMenuOrder = 'own' | 'follow';

export const HEADER_MENU_ORDERS: ReadonlyArray<{ value: HeaderMenuOrder; label: string; hint: string }> = [
  { value: 'own', label: 'Own order', hint: 'The menu keeps the order you give it. Moving a page in Pages leaves it as it is.' },
  { value: 'follow', label: 'Follow page order', hint: 'Links to pages stay in the same order as Pages, and move with them. Other links and submenus keep their places.' }
];

/** Why a menu that follows the pages offers no move of its own. */
export const FOLLOWING_MOVE_NOTE = 'Links to pages follow the order in Pages, and other links and submenus keep their places. To move a link here, choose Own order.';

/**
 * Choose the header menu's order. Following the pages when the menu's page links are in another order first shows
 * the menu as it is and as it will be, as the one-off match does; confirmed, the setting and the new order are one
 * change with an Undo, made only to the project that was shown. Resolves to whether the setting changed.
 */
export async function setHeaderMenuOrder(mode: HeaderMenuOrder): Promise<boolean> {
  const now = getState().snapshot;
  if (!now || followsPageOrder(now.state) === (mode === 'follow')) return false;
  if (now.aiBusy) {
    toast(aiChanging('choose the header menu’s order'), 'info');
    return false;
  }
  const preview = mode === 'follow' ? headerOrderPreview(now.state) : null;
  if (preview?.changed) {
    const ok = await confirmDialog({
      title: 'Make the header menu follow the page order?',
      body: 'Its links to pages move into the same order as Pages now, and move with the pages from then on.',
      confirmLabel: 'Follow page order',
      cancelLabel: 'Keep own order',
      details: [
        { kind: 'note', text: `Now: ${preview.before.join(' · ')}` },
        { kind: 'note', text: `After: ${preview.after.join(' · ')}` },
        { kind: 'keep', text: 'Other links stay where they are, and each submenu stays whole.' },
        { kind: 'undo', text: 'You can undo this.' }
      ]
    });
    // Answered for this project: one opened meanwhile was never shown.
    if (!ok || getState().snapshot?.workspaceKey !== now.workspaceKey) return false;
  }
  const label = mode === 'follow' ? 'Header menu follows page order' : 'Header menu keeps its own order';
  // Following is decided on the menu as it was read (shown, or already in order): a project that has changed since is
  // chosen again, so a reorder still saving never moves the menu unseen.
  const r = await commitOps([{ type: 'site.update', headerMenuOrder: mode }], label, undefined, mode === 'follow' ? now.revision : undefined);
  if (!r || getState().snapshot?.workspaceKey !== r.workspaceKey) return false;
  toast(
    mode === 'follow'
      ? preview?.changed
        ? 'The header menu now follows the page order, and lists its pages in the same order as Pages.'
        : 'The header menu now follows the page order.'
      : 'The header menu now keeps its own order.',
    'info',
    undoAction(r)
  );
  return true;
}
