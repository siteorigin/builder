// The text of the sidebar lists (Pages, Posts): words found by a find field marked where they are, and the short
// dates a row has room for.

import { fold, folded } from '../lib/fold';

export { fold, folded };

/** Which characters of `text` the found words cover. */
export function found(text: string, words: string[]): boolean[] {
  const chars = [...text];
  const hit = new Array<boolean>(chars.length).fill(false);
  if (!words.length) return hit;
  const f = folded(text);
  // An empty word (a query of accents alone folds to nothing) matches nowhere, rather than everywhere forever.
  for (const w of words.filter(Boolean))
    for (let i = f.text.indexOf(w); i >= 0; i = f.text.indexOf(w, i + 1)) for (let k = i; k < i + w.length; k++) hit[f.at[k]] = true;
  // A combining mark goes with the letter before it.
  chars.forEach((c, i) => i > 0 && /^\p{M}+$/u.test(c) && (hit[i] = hit[i - 1]));
  return hit;
}

/** Characters `from` to `to` of a text, with the found ones marked. */
export function Runs({ chars, hit, from = 0, to = chars.length }: { chars: string[]; hit: boolean[]; from?: number; to?: number }) {
  const out: React.ReactNode[] = [];
  let run = '';
  let on = false;
  const flush = () => run && out.push(on ? <mark key={out.length}>{run}</mark> : run);
  for (let i = from; i < to; i++) {
    if (hit[i] !== on) (flush(), (run = ''), (on = hit[i]));
    run += chars[i];
  }
  flush();
  return <>{out}</>;
}

/** The text with each of the found words marked. */
export function Marked({ text, words }: { text: string; words: string[] }) {
  return words.length ? <Runs chars={[...text]} hit={found(text, words)} /> : <>{text}</>;
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
/** An article's date, short enough for a sidebar row: "Oct 2, 2026" in English (a calendar day, so in UTC). */
export function shortDate(date: string, language: string | undefined): string {
  const tag = language?.trim() || 'en';
  let f = dateFormats.get(tag);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' };
    try {
      f = new Intl.DateTimeFormat([tag, 'en'], opts);
    } catch {
      f = new Intl.DateTimeFormat('en', opts);
    }
    dateFormats.set(tag, f);
  }
  return f.format(new Date(`${date}T00:00:00Z`));
}
