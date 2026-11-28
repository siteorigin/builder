/** What reading a post left out or changed, as the import's report says it. */
import { MAX_POST_GALLERY_PICTURES, type HtmlReport } from './html';

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
  const empty = r.galleries.filter((g) => !g.pictures).length;
  if (empty) out.push(`Left out ${empty === 1 ? 'a gallery' : `${empty} galleries`}: the export lists no pictures for ${empty === 1 ? 'it' : 'them'}.`);
  const short = r.galleries.filter((g) => g.missing);
  if (short.length) {
    const missing = short.reduce((n, g) => n + g.missing, 0);
    const { pictures, missing: one } = short[0];
    const what =
      short.length > 1
        ? `${missing} pictures of ${short.length} galleries (${short.map((g) => `${g.missing} of ${g.pictures}`).join(', ')})`
        : one === pictures
          ? pictures === 1
            ? 'a gallery’s picture'
            : `a gallery’s ${pictures} pictures`
          : `${one} of a gallery’s ${pictures} pictures`;
    out.push(`Left out ${what}: the export does not include ${missing === 1 ? 'it' : 'them'}. Export All content to bring pictures’ details along.`);
  }
  if (r.galleryOverflow) out.push(`Left out ${count(r.galleryOverflow, 'gallery picture', 'gallery pictures')} past the first ${MAX_POST_GALLERY_PICTURES}: a post brings at most ${MAX_POST_GALLERY_PICTURES} from its galleries.`);
  if (r.droppedLinks) out.push(`Kept the words of ${count(r.droppedLinks, 'link', 'links')} whose address could not be kept.`);
  return out;
}
