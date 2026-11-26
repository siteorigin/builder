import type { GuestRole } from './limits';

/**
 * The editor methods each guest role may call, by their dotted `BuilderApi` names. It imports nothing of the app, so
 * the relay can turn a call away before it reaches the host; the host checks again, with the arguments, in
 * capabilities.ts (which also checks these names still exist in the app's API).
 */

/**
 * A viewer reads the project as it is now; the preview, the others' presence and the editor events come with admission.
 * The host answers `project.snapshot`, and sends `project:changed`, with a copy made safe to share (snapshot.ts),
 * never the editor's own snapshot, which names the project's folder and holds private state.
 */
export const VIEWER_METHODS = ['project.snapshot'] as const;
/** A collaborator also makes visual edits, and shares its own presence (the relay passes on no viewer's). */
export const COLLABORATOR_METHODS = [...VIEWER_METHODS, 'project.apply'] as const;
/** Every method any guest may call: all a forwarded call or the host's answer can name. */
export const LIVE_METHODS = COLLABORATOR_METHODS;
export type LiveMethod = (typeof LIVE_METHODS)[number];

const METHODS: Record<GuestRole, readonly string[]> = { viewer: VIEWER_METHODS, collaborator: COLLABORATOR_METHODS };

/** Whether a guest holding `role` may call the dotted `BuilderApi` method. Unknown roles and names are refused. */
export function canCall(role: GuestRole, method: string): method is LiveMethod {
  return Object.hasOwn(METHODS, role) && METHODS[role].includes(method);
}
