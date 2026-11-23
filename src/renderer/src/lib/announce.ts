import { useEffect, useRef, useState } from 'react';
import type { RunStatus } from '@shared/api';

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

/** The toolbar's save status, as screen readers hear it settle. `held`: an edit typed while the AI worked waits. */
export type SaveStatus = 'conflict' | 'ai' | 'held' | 'busy' | 'saved';

/** How the last AI request ended (`run`), and what became of an edit held while it worked (`edit`). */
export interface AiEnding {
  run: RunStatus | null;
  edit?: 'saved' | 'held';
}

const RUN_ENDED: Partial<Record<RunStatus, string>> = {
  completed: 'AI changes saved',
  'no-changes': 'AI finished without changing anything',
  cancelled: 'AI stopped',
  failed: 'AI request failed',
  conflicted: 'AI stopped. A file changed outside SiteOrigin Builder, so its changes were kept for review'
};

/**
 * Screen readers hear settled changes only: a save completing, an AI check starting or finishing, a conflict
 * appearing or clearing. Typing and the Unsaved/Saving flicker in between stay quiet, and clear the region,
 * so it never still says "All changes saved" while the toolbar shows a change that is not saved. Given how
 * the last AI request ended (`ending`), the AI finishing is announced as it really ended (a stopped request
 * is not "AI changes saved"), and a held edit as saved only once it was.
 */
export function saveStatusAnnouncement(prev: SaveStatus, next: SaveStatus, ending?: AiEnding | null): string {
  if (next === 'conflict') return 'File conflict. A project file was changed outside SiteOrigin Builder.';
  if (next === 'ai') return 'AI is checking its changes';
  if (next === 'busy') return '';
  const ran = prev !== 'ai' ? undefined : ending === undefined ? 'AI changes saved' : ending?.run ? RUN_ENDED[ending.run] : undefined;
  if (next === 'held') {
    const edit = ending?.edit === 'held' ? 'Your edit was not applied. Review it below' : ending?.edit === 'saved' ? 'Your edit was saved. Another edit is not saved yet' : 'Your edit is not saved yet';
    return [ran, edit].filter(Boolean).join('. ');
  }
  if (prev === 'conflict') return 'File conflict resolved. All changes saved';
  if (prev === 'held' && ending?.edit === 'saved') return 'Your edit was saved';
  if (prev === 'ai' && ending?.edit === 'saved') return [ran, 'Your edit was saved'].filter(Boolean).join('. ');
  if (prev === 'ai') return ran ?? 'All changes saved';
  return 'All changes saved';
}
