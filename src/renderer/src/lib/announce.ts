import { useEffect, useRef, useState } from 'react';

/**
 * Text for a polite live region that changes only when `state` moves to a different value, so screen
 * readers hear transitions (a conflict appears, a save completes, a mode starts) and never the state a
 * surface opened in. `say(prev, next)` returns what to announce, or null to stay quiet. A repeated
 * message ("All changes saved" twice) is still announced: it alternates a trailing no-break space.
 */
export function useTransitionAnnouncement<T>(state: T, say: (prev: T, next: T) => string | null): string {
  const prev = useRef(state);
  const count = useRef(0);
  const [text, setText] = useState('');
  useEffect(() => {
    if (Object.is(prev.current, state)) return;
    const msg = say(prev.current, state);
    prev.current = state;
    if (msg) setText(msg + (++count.current % 2 ? '' : ' '));
    // `say` only describes the transition; `state` alone drives it.
  }, [state]);
  return text;
}
