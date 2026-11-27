import type { LiveNotes } from '@shared/live/notes';
import { api, getState, setState, useStore } from '../store';

/**
 * The shown project's pinned notes (#770), kept read for the toolbar's Notes (lib/notes.ts has what it does with
 * them). Apart from it so the app's first screen loads without the editor's code.
 */

/**
 * Keep the shown project's notes read: whenever another project (or another opening of it) is shown, and whenever
 * its notes change. Returns the unsubscriber.
 */
export function followNotes(): () => void {
  let opening: string | null = null;
  let asked = 0;
  const load = (key: string) => {
    const ask = ++asked;
    void api.notes
      .list(key)
      .then((notes) => {
        if (ask === asked && opening === key && notes) setState({ notes: { ...notes, opening: key } });
      })
      .catch(() => undefined);
  };
  const follow = (key: string | null) => {
    if (key === opening) return;
    opening = key;
    asked++;
    setState({ notes: null, ...(key ? {} : { notesOpen: false }) });
    if (key) load(key);
  };
  const offChanged = api.on('notes:changed', (notes: LiveNotes) => {
    if (!opening) return;
    // Newer than any list still being read: that answer, when it comes, is not taken over this.
    asked++;
    setState({ notes: { ...notes, opening } });
  });
  const offStore = useStore.subscribe((s) => follow(s.snapshot?.workspaceKey ?? null));
  follow(getState().snapshot?.workspaceKey ?? null);
  return () => {
    offChanged();
    offStore();
    asked++;
  };
}

