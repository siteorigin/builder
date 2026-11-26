/**
 * What is wrong with a link destination the author typed, in words for the field it was typed in, so the field
 * can say so and keep the text rather than the project refusing it afterwards.
 */
import type { LinkValue, ProjectState } from '@shared/types';
import { linkFromTarget, type RichIndexes, type RichPages } from '@shared/richtext';
import { normalizeLink } from '@engine/values';

const SECTION = /^[A-Za-z][\w-]*$/;
/** A bare domain ("example.com", "example.com/about"): the start of a web address without its https://. */
const BARE_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]\S*)?$/i;

/**
 * A destination typed in the link field on the canvas (⌘K while editing rich text), as the text's link will be
 * read when the edit is saved: a page address, a web address, mailto:, tel: or #section. Null when it goes
 * somewhere the site can link to.
 */
export function inlineLinkProblem(href: string, pages: RichPages, indexes: RichIndexes = {}): string | null {
  const t = href.trim();
  if (!t) return 'Type where the link goes.';
  const link = linkFromTarget(t, pages, false, undefined, indexes);
  // A collection by its ID is one the site has an index for.
  if (link && (link.type !== 'collection' || Object.hasOwn(indexes, link.target))) return null;
  if (link) return 'That collection has no index on the website to link to. Link to one of the site’s pages instead.';
  if (/^https?:/i.test(t)) return 'That web address is not complete. Use a full address, such as https://example.com.';
  if (/^mailto:/i.test(t)) return 'That is not a complete email address, such as hello@example.com.';
  if (/^tel:/i.test(t)) return 'A phone number has at least 3 digits and uses only digits, spaces and + ( ) . -';
  const hash = t.indexOf('#');
  if (hash >= 0 && !SECTION.test(t.slice(hash + 1))) return 'A section name starts with a letter and uses only letters, numbers, - and _.';
  const path = hash < 0 ? t : t.slice(0, hash);
  if (path.startsWith('/') && !path.startsWith('//')) return `No page or collection index has the address ${path.length > 60 ? `${path.slice(0, 59)}…` : path}. Check the spelling, or link to one of the site’s pages.`;
  return 'Use a page address such as /about/, a web address, an email address or a phone number.';
}

/**
 * A destination typed in the Inspector for a web address, email or phone link. Null when the project can store
 * it; an empty field is not a problem (it changes nothing).
 */
export function linkFieldProblem(type: LinkValue['type'], target: string, state: ProjectState): string | null {
  const t = target.trim();
  if (!t || (type !== 'url' && type !== 'email' && type !== 'tel')) return null;
  try {
    normalizeLink({ type, target: t }, state, 'Link');
    return null;
  } catch {
    if (type === 'url') return BARE_DOMAIN.test(t) ? `A web address starts with https://, such as https://${t.length > 60 ? 'example.com' : t}.` : 'Use a full web address, such as https://example.com.';
    if (type === 'email') return 'Use a complete email address, such as hello@example.com.';
    return 'A phone number uses only digits, spaces and + ( ) . -, from 3 to 30 characters with at least 3 digits.';
  }
}
