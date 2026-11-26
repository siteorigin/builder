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

/**
 * The toolbar's save status, as screen readers hear it settle. `working`, `asking`, `checking` and `stopping` are the AI's
 * phases (see `runPhase`). `held`: an edit typed while the AI worked waits. `failed`: a save failed, and none has succeeded since.
 */
export type SaveStatus = 'failed' | 'conflict' | 'working' | 'asking' | 'checking' | 'stopping' | 'held' | 'busy' | 'saved';

/** How the last AI request ended (`run`), and what became of an edit held while it worked (`edit`). */
export interface AiEnding {
  run: RunStatus | null;
  edit?: 'saved' | 'held';
}

const RUN_ENDED: Partial<Record<RunStatus, string>> = {
  completed: 'AI changes saved',
  partial: 'AI stopped before finishing. Its changes so far were saved',
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
  if (next === 'failed') return 'Save failed. Your last change is not saved. Project health says what to do.';
  if (next === 'conflict') return 'File conflict. A project file was changed outside SiteOrigin Builder.';
  if (next === 'asking') return 'AI is waiting for your answer';
  if (next === 'checking') return 'AI is checking its changes';
  if (next === 'working') return 'AI is working';
  if (next === 'stopping') return 'AI is stopping. Its changes are being undone';
  if (next === 'busy') return '';
  const fromAi = prev === 'working' || prev === 'asking' || prev === 'checking' || prev === 'stopping';
  const ran = !fromAi ? undefined : ending === undefined ? 'AI changes saved' : ending?.run ? RUN_ENDED[ending.run] : undefined;
  if (next === 'held') {
    const edit = ending?.edit === 'held' ? 'Your edit was not applied. Review it below' : ending?.edit === 'saved' ? 'Your edit was saved. Another edit is not saved yet' : 'Your edit is not saved yet';
    return [ran, edit].filter(Boolean).join('. ');
  }
  if (prev === 'conflict') return 'File conflict resolved. All changes saved';
  if (prev === 'failed') return 'Saved again. All changes saved';
  if (prev === 'held' && ending?.edit === 'saved') return 'Your edit was saved';
  if (fromAi && ending?.edit === 'saved') return [ran, 'Your edit was saved'].filter(Boolean).join('. ');
  if (fromAi) return ran ?? 'All changes saved';
  return 'All changes saved';
}

/**
 * What the toolbar says when an AI request ended without its save state ever moving: it failed (or was stopped)
 * before it started working, say because its model could not be reached. Without this the region would go on
 * saying how the request before it ended ("AI changes saved"). Null when there is nothing new to say.
 */
export function unseenRunAnnouncement(ending: AiEnding | null | undefined): string | null {
  return ending?.run ? (RUN_ENDED[ending.run] ?? null) : null;
}

const aiPhase = (s: SaveStatus) => s === 'working' || s === 'asking' || s === 'checking' || s === 'stopping';

/**
 * The toolbar's announcement as its save state moves from `prev` to `next`, or as an AI request ends (`runEnded`).
 * `before` is where a save in flight (`busy`) started, which is what it settles from; the result carries the new one.
 * A request the toolbar showed at work is announced as that settles. One it never showed (it failed before it
 * started) is announced on its own, unless the toolbar still shows the AI (a held edit stopping it), which says it
 * once it settles.
 */
export function toolbarAnnouncement(prev: SaveStatus, next: SaveStatus, before: SaveStatus, runEnded: boolean, ending: AiEnding | null | undefined): { say: string | null; before: SaveStatus } {
  const unseen = (from: SaveStatus) => (runEnded && !aiPhase(from) && !aiPhase(next) ? unseenRunAnnouncement(ending) : null);
  if (prev === next) return { say: unseen(next), before };
  const from = prev === 'busy' ? before : prev;
  const said = saveStatusAnnouncement(from, next, ending ?? null);
  const ended = unseen(from);
  return { say: ended ? [ended, said].filter(Boolean).join('. ') : said, before: next === 'busy' ? from : next };
}

/**
 * What the Site styles status region says as the unreadable colour pairs change. `key` is the names of the unreadable
 * pairs joined by `|`, a newline, then `unknown` when some pair cannot be checked. Silent when only that last flag moved;
 * "readable again" only after there were problems, and never while some pair cannot be checked (the region clears instead).
 */
export function sayContrast(prev: string, next: string): string | null {
  const [failing, unknown] = next.split('\n');
  // Only the "could not be checked" flag moved: nothing new to say, unless an all-clear said earlier would now be stale.
  if (failing === prev.split('\n')[0]) return !failing && unknown ? '' : null;
  if (failing) return `Low contrast: ${failing.split('|').join(', ')}`;
  return unknown ? '' : 'Colors are readable again';
}
