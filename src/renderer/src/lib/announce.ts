import { useEffect, useRef, useState } from 'react';

/**
 * Text for a polite live region that changes only when `state` moves to a different value, so screen
 * readers hear transitions (a conflict appears, a save completes, a mode starts) and never the state a
 * surface opened in. `say(prev, next)` returns what to announce, null to stay quiet (the last message
 * stays), or '' to clear the region quietly, so it never keeps claiming something that is no longer true.
 * A repeated message ("All changes saved" twice) is still announced: it alternates a trailing no-break space.
 */
export function useTransitionAnnouncement<T>(state: T, say: (prev: T, next: T) => string | null): string {
  const prev = useRef(state);
  const count = useRef(0);
  const [text, setText] = useState('');
  useEffect(() => {
    if (Object.is(prev.current, state)) return;
    const msg = say(prev.current, state);
    prev.current = state;
    const next = announcementText(msg, count.current);
    if (next === null) return;
    count.current = next.count;
    setText(next.text);
    // `say` only describes the transition; `state` alone drives it.
  }, [state]);
  return text;
}

/** What the region says after `say` returned `msg` (null: unchanged). A message alternates a trailing no-break
 *  space, so the same words twice in a row still count as a change and are heard again. */
export function announcementText(msg: string | null, count: number): { text: string; count: number } | null {
  if (msg === null) return null;
  if (msg === '') return { text: '', count };
  const n = count + 1;
  return { text: msg + (n % 2 ? '' : ' '), count: n };
}

/** The toolbar's save status, as screen readers hear it settle. */
export type SaveStatus = 'conflict' | 'ai' | 'busy' | 'saved';

/** Screen readers hear settled changes only: a save completing, an AI check starting or finishing, a conflict
 *  appearing or clearing. Typing and the Unsaved/Saving flicker in between stay quiet, and clear the region,
 *  so it never still says "All changes saved" while the toolbar shows a change that is not saved. */
export function saveStatusAnnouncement(prev: SaveStatus, next: SaveStatus): string {
  if (next === 'conflict') return 'File conflict. A project file was changed outside SiteOrigin Builder.';
  if (next === 'ai') return 'AI is checking its changes';
  if (next === 'busy') return '';
  return prev === 'conflict' ? 'File conflict resolved. All changes saved' : prev === 'ai' ? 'AI changes saved' : 'All changes saved';
}
