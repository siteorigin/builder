/** What reading a post left out or changed, as the import's report says it. */
import type { HtmlReport } from './html';

const count = (n: number, one: string, many: string) => (n === 1 ? `${/^[aeiou]/i.test(one) ? 'an' : 'a'} ${one}` : `${n} ${many}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function reportNotes(r: HtmlReport): string[] {
  const out: string[] = [];
  if (r.scripts) out.push(`Removed ${count(r.scripts, 'script', 'scripts')}.`);
  if (r.embeds.length) {
    const where = [...new Set(r.embeds.filter(Boolean))];
    out.push(`Left out ${count(r.embeds.length, 'embedded frame or player', 'embedded frames and players')}${where.length ? ` (${where.slice(0, 3).join(', ')}${where.length > 3 ? '…' : ''})` : ''}.`);
  }
  if (r.embedLinks) out.push(`Kept ${count(r.embedLinks, 'embedded video or post', 'embedded videos and posts')} as a link to ${r.embedLinks === 1 ? 'it' : 'them'}.`);
  if (r.forms) out.push(`Removed ${count(r.forms, 'form', 'forms')}.`);
  if (r.tables) out.push(`${cap(count(r.tables, 'table', 'tables'))} became plain lines of text.`);
  if (r.shortcodes.length) out.push(`Removed the shortcode${r.shortcodes.length === 1 ? '' : 's'} ${r.shortcodes.map((s) => `[${s}]`).join(', ')}.`);
  if (r.footnotes) out.push(r.footnotes === 1 ? 'Its footnote is under a Footnotes heading, and its number no longer links to it.' : `Its ${r.footnotes} footnotes are a numbered list under a Footnotes heading, and their numbers no longer link to them.`);
  if (r.lostFootnotes) out.push(r.lostFootnotes === 1 ? 'The text of its footnote was not in the export: its number is left without a note.' : `The text of ${r.lostFootnotes} of its footnotes was not in the export: their numbers are left without notes.`);
  if (r.inPostLinks) out.push(`${r.inPostLinks === 1 ? 'A link to a place in the post itself (a note number, say) is plain words now' : `${r.inPostLinks} links to places in the post itself (its note numbers, say) are plain words now`}: an imported post can’t link within itself.`);
  if (r.droppedLinks) out.push(`Kept the words of ${count(r.droppedLinks, 'link', 'links')} whose address could not be kept.`);
  return out;
}
