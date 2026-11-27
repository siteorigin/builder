import { ProjectFeedReader, type ProjectChange } from '@shared/project-feed';

/**
 * What the editor makes of what the main process sends it: each `project:changed`, a change from the copy sent before
 * (shared/project-feed.ts), copied as IPC copies it and read into the snapshot the editor then holds. A change the
 * editor could not read fails the test where it was sent. `changes` keeps each message as it was sent.
 */
export function editorView(): ((channel: string, payload: unknown) => unknown) & { changes: ProjectChange[]; reader: ProjectFeedReader } {
  const reader = new ProjectFeedReader();
  const changes: ProjectChange[] = [];
  const view = (channel: string, payload: unknown) => {
    if (channel !== 'project:changed') return payload;
    const change = structuredClone(payload) as ProjectChange;
    changes.push(change);
    const snapshot = reader.read(change);
    if (!snapshot) throw new Error(`The editor could not read the project:changed sent at revision ${change.revision}: it does not fit the copy it holds.`);
    return snapshot;
  };
  return Object.assign(view, { changes, reader });
}
