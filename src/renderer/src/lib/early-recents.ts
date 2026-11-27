import type { RecentProject } from '@shared/api';

/**
 * The recent projects, asked for at launch beside the project that is open (App), so Welcome's first list does not wait
 * for that answer and for Welcome to mount before it is even asked for (#958). It is Welcome's first reading, taken
 * once; a project opening first drops it unread, and every later list (Welcome shown again, a Pin, a Remove) is read
 * afresh.
 */
export interface EarlyRecents {
  list: Promise<RecentProject[]>;
  /** The list once it has come, so Welcome's first render can show it. */
  settled?: RecentProject[];
}

let early: EarlyRecents | null = null;

/** Ask for the list now, for the first Welcome to show. */
export function askRecentsEarly(ask: () => Promise<RecentProject[]>): void {
  const asked: EarlyRecents = { list: ask() };
  // Read or not, a failure here is Welcome's to show (it asks again), never an unhandled rejection.
  asked.list.then(
    (list) => (asked.settled = list),
    () => undefined
  );
  early = asked;
}

/** The list asked for at launch, if it is still to be taken, without taking it (a render may be thrown away). */
export const peekEarlyRecents = (): EarlyRecents | null => early;

/** The list asked for at launch, once: null when it was taken, dropped or never asked for. */
export function takeEarlyRecents(): EarlyRecents | null {
  const asked = early;
  early = null;
  return asked;
}
