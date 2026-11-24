import type { PageDoc, ProjectState } from '@shared/types';

/**
 * A page that has only its introduction, as the Page introduction starter made it: the page's title and nothing else.
 * The canvas offers it the same first steps as an empty page.
 */
export function titleOnlyPage(state: ProjectState, page: PageDoc): boolean {
  if (page.rootIds.length !== 1) return false;
  const n = page.nodes[page.rootIds[0]];
  if (n?.kind !== 'instance' || state.components[n.definitionId]?.componentId !== 'intro.page') return false;
  return n.props.heading === page.title && !n.props.eyebrow && !n.props.lead;
}

/**
 * Write with AI's request for the message box (see the store's `chatFocus`), made in one opening of the project for
 * one page, at `at` (ms).
 */
export interface ChatFocusRequest {
  workspaceKey: string;
  pageId: string;
  at: number;
}

/** How long the request waits for the box to show: past this the author has moved on, and focus stays theirs. */
export const CHAT_FOCUS_WAIT_MS = 3000;

/**
 * What Chat does with the request now: let it go (the author moved on: too late, another page or project, or the
 * chat no longer shown), show the box first (no AI provider is connected yet), wait (no box yet), or focus the box.
 * The box takes focus as soon as it shows, also while its conversation is still loading (it says so, and takes text
 * once loaded): focus is never moved there later, away from wherever the author went meanwhile.
 */
export function chatFocusStep(
  req: ChatFocusRequest,
  view: { now: number; workspaceKey: string | undefined; pageId: string | null; chatShown: boolean; box: boolean; boxForced: boolean; configured: boolean; asking: boolean }
): 'drop' | 'show-box' | 'wait' | 'focus' {
  if (view.now - req.at > CHAT_FOCUS_WAIT_MS || req.workspaceKey !== view.workspaceKey || req.pageId !== view.pageId || !view.chatShown) return 'drop';
  if (!view.configured && !view.asking && !view.boxForced) return 'show-box';
  return view.box ? 'focus' : 'wait';
}
