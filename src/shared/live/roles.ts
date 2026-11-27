import type { GuestRole } from './limits';

/**
 * The editor methods each guest role may call, by their dotted `BuilderApi` names. It imports nothing of the app, so
 * the relay can turn a call away before it reaches the host; the host checks again, with the arguments, in
 * capabilities.ts (which also checks these names still exist in the app's API).
 */

/**
 * A viewer reads the project as it is now, and its pinned notes, and leaves notes of its own; the preview, the others' presence and the editor events come with admission.
 * The host answers `project.snapshot`, and sends `project:changed`, with a copy made safe to share (snapshot.ts),
 * never the editor's own snapshot, which names the project's folder and holds private state.
 */
export const VIEWER_METHODS = ['project.snapshot', 'notes.list', 'notes.add'] as const;
/**
 * A collaborator also makes visual edits, resolves and deletes the project's pinned notes (#770), and shares its own
 * presence (the relay passes on no viewer's). A viewer only reads and leaves notes. A collaborator may also ask the
 * host's AI to edit, and stop or answer its own request (#769): the relay passes those on for any collaborator, and the
 * host refuses each one unless it has allowed that collaborator AI editing, which it never does by itself.
 */
export const COLLABORATOR_METHODS = [...VIEWER_METHODS, 'project.apply', 'notes.resolve', 'notes.delete', 'ai.send', 'ai.stop', 'ai.answer'] as const;
/**
 * A copy editor edits through the same method: which edits it may make is the host's to check, with the arguments
 * (capabilities.ts) and against the project the edit would leave (engine/copy-editor.ts). It never asks the host's AI.
 * Like a viewer, it reads and leaves notes, but resolving and deleting them stays with the host and collaborators.
 */
export const COPY_EDITOR_METHODS = [...VIEWER_METHODS, 'project.apply'] as const;
/** Every method any guest may call: all a forwarded call or the host's answer can name. */
export const LIVE_METHODS = COLLABORATOR_METHODS;
export type LiveMethod = (typeof LIVE_METHODS)[number];

const METHODS: Record<GuestRole, readonly string[]> = { viewer: VIEWER_METHODS, 'copy-editor': COPY_EDITOR_METHODS, collaborator: COLLABORATOR_METHODS };

/** Whether a guest holding `role` may call the dotted `BuilderApi` method. Unknown roles and names are refused. */
export function canCall(role: GuestRole, method: string): method is LiveMethod {
  return Object.hasOwn(METHODS, role) && METHODS[role].includes(method);
}
