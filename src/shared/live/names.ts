/**
 * The names a live session shows (a guest's, the project's, a batch's label), checked the same way on every side. Apart
 * from the frames' schemas (messages.ts), so a form can check a name without loading them.
 */
import { DISPLAY_NAME_MAX } from './limits';

/**
 * Characters a name may never hold: controls, the marks that reorder text, and invisible spaces and blank fillers, any
 * of which could make one name look like another, or like none, in the waiting room. Joiners stay: emoji and some
 * scripts need them.
 */
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Bidi_Control}\u115f\u1160\u200b\u2060\u2800\u3164\ufeff\uffa0]/u;
/** A name must show something: a letter, number, symbol or punctuation mark, not joiners or marks alone. */
const VISIBLE_NAME_CHAR = /[\p{L}\p{N}\p{S}\p{P}]/u;

/**
 * A display name as it travels: in Unicode normal form C, every run of spaces or line breaks made one space, trimmed,
 * 1 to `max` characters long, showing something, and holding none of the characters above. Null when nothing usable
 * is left.
 */
export function normalizeDisplayName(raw: unknown, max = DISPLAY_NAME_MAX): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!name || UNSAFE_NAME_CHARS.test(name) || !VISIBLE_NAME_CHAR.test(name) || [...name].length > max) return null;
  return name;
}
