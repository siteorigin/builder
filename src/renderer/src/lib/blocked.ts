/**
 * Why a surface can't change the project right now: it is open read-only, or the AI is at work. A state, not a fault,
 * so every surface says it the same way (components/BlockedNote draws it).
 *
 * - Read-only says the session's own reason (`snap.readOnly.reason`), as the status bar and History do. It already says
 *   why and what lets the project be edited again (close and reopen, unlock, update the app), so nothing is added.
 * - The AI says what it is doing, then what waits for it: "The AI is making changes. You can paste once it finishes."
 *   "Making changes" is a run that holds manual edits (`snap.aiBusy`); "working" is any request in the chat, an Ask
 *   included (`runStatus`), for what only waits on the chat.
 */
export type Blocked = { kind: 'read-only' | 'ai'; text: string };

type Held = { readOnly?: { reason: string } | null; aiBusy?: boolean } | null | undefined;

/** The AI holds the project's edits: "The AI is making changes. You can {action} once it finishes." */
export const aiChanging = (action: string) => `The AI is making changes. You can ${action} once it finishes.`;
/** The AI is answering a request (an Ask included): "The AI is working. You can {action} once it finishes." */
export const aiWorking = (action: string) => `The AI is working. You can ${action} once it finishes.`;

/** The project is open read-only: the session's own reason, or null. */
export const readOnlyBlock = (snap: Held): Blocked | null => (snap?.readOnly ? { kind: 'read-only', text: snap.readOnly.reason } : null);

/** The AI's request is waiting on the author: it only finishes once they answer it. */
export const aiAwaiting = (action: string) => `The AI is waiting for your answer in the AI panel. You can ${action} once you answer and it finishes.`;

/**
 * What holds an edit to the project now, worded for `action` ("paste", "remove it"); null when nothing does. Pass the
 * chat's `runStatus` where the surface has it, so a run waiting on the author's answer says so rather than "making changes".
 */
export const projectBlock = (snap: Held, action: string, runStatus?: string | null): Blocked | null =>
  readOnlyBlock(snap) ?? (snap?.aiBusy ? { kind: 'ai', text: runStatus === 'awaiting-input' ? aiAwaiting(action) : aiChanging(action) } : null);

/** A request in the chat holds `action`: worded for its status, since one waiting on the author never finishes alone. */
export const aiRunning = (status: string | null | undefined, action: string) => (status === 'awaiting-input' ? aiAwaiting(action) : aiWorking(action));
