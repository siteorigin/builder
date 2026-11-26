/**
 * What the website says a collection entry is about, in one line, wherever it lists the entry for something other than
 * its pages (the RSS feed and `llms.txt`): its excerpt, else its SEO description, else the start of its text.
 */
import type { Collection, EntryDoc, ProjectState } from '@shared/types';
import { isListBlock, isImageBlock, richTextToPlain, toRichText } from '@shared/richtext';
import { oneLine } from '@shared/llms';
import { showsEntryText } from './checks';

/** The longest summary taken from an entry's text, its "…" included. An author's own is never cut. */
export const SUMMARY_LENGTH = 200;

const words = new Intl.Segmenter('en', { granularity: 'word' });
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * The start of a line of text, cut between words and ended with "…" when there is more. It ends at the last space,
 * unless that leaves less than half the room (text written without spaces, such as Japanese or Thai): then between
 * the words the language has there, and only a single word longer than the room is cut between its characters.
 */
export function startOfText(text: string, max = SUMMARY_LENGTH): string {
  if (text.length <= max) return text;
  const room = max - 1;
  // Far enough past the cut to read the word and the character that cross it.
  const head = text.slice(0, max * 2);
  let end = head.lastIndexOf(' ', room);
  if (end <= room / 2) end = words.segment(head).containing(room)?.index || graphemes.segment(head).containing(room)?.index || end;
  const kept = head.slice(0, Math.max(0, end)).replace(/[\s,.;:–—、。，；：-]+$/u, '');
  return kept ? `${kept}…` : '';
}

/** The words of an entry's paragraphs, quotes and lists: headings and pictures' words do not say what it is about. */
function proseOf(entry: EntryDoc): string {
  const prose = toRichText(entry.body).filter((b) => !isImageBlock(b) && (isListBlock(b) || b.type === 'p' || b.type === 'blockquote'));
  return oneLine(richTextToPlain(prose));
}

/**
 * An entry's summary, or '' for one with no words of its own to give: no excerpt, no SEO description, and no text its
 * page shows (a layout without the entry's text leaves it off the website, so none of it is quoted).
 */
export function entrySummary(state: ProjectState, collection: Collection, entry: EntryDoc): string {
  const own = oneLine(entry.excerpt) || oneLine(entry.seo?.description);
  if (own) return own;
  const prose = proseOf(entry);
  return prose && showsEntryText(state, collection, entry) ? startOfText(prose) : '';
}
