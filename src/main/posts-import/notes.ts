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
  if (r.code) out.push(`${cap(count(r.code, 'block of code or preformatted text', 'blocks of code or preformatted text'))} became ordinary text.`);
  if (r.raised) out.push(`${cap(count(r.raised, 'superscript or subscript', 'superscripts and subscripts'))} became ordinary text on the line.`);
  if (r.struck) out.push(`Kept ${count(r.struck, 'struck-through passage', 'struck-through passages')} as ordinary text, no longer struck through.`);
  if (r.droppedLinks) out.push(`Kept the words of ${count(r.droppedLinks, 'link', 'links')} whose address could not be kept.`);
  return out;
}
