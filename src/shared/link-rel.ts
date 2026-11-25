import { LINK_RELS, type LinkRel, type LinkValue } from './types';

/**
 * A link's authored relationships (`nofollow`, `sponsored`, `ugc`): how they are read from anything a document, a
 * page's HTML or the text form holds, and how they are written back out. Anything else is ignored, so a hand-edited
 * value never fails a build or an edit that does not touch it, and one written as an attribute's words
 * (`"sponsored nofollow"`) still says what it meant.
 */

const KNOWN: ReadonlySet<string> = new Set(LINK_RELS);

/** The known tokens of a list or of words (spaces or commas between them), each once, in LINK_RELS order. */
export function canonicalRels(v: unknown): LinkRel[] {
  const words = typeof v === 'string' ? v.split(/[ \t\n\f\r,]+/) : Array.isArray(v) ? v : [];
  const has = new Set(words.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase()));
  return LINK_RELS.filter((t) => KNOWN.has(t) && has.has(t));
}

/** The authored tokens of an HTML rel attribute (`noopener`, `noreferrer` and the rest left out). */
export const relsFromAttribute = (attr: string | null | undefined): LinkRel[] => canonicalRels(attr ?? '');

/** The relationships a link carries: only a web address has any. */
export const linkRels = (link: unknown): LinkRel[] => (link && typeof link === 'object' && (link as LinkValue).type === 'url' ? canonicalRels((link as LinkValue).rel) : []);

/** The link with these relationships, or none: `rel` is kept only on a web address, and only when it holds a token. */
export function withRels<T extends LinkValue>(link: T, rels: readonly string[] | undefined): T {
  const { rel: _rel, ...rest } = link;
  const tokens = link.type === 'url' ? canonicalRels(rels) : [];
  return (tokens.length ? { ...rest, rel: tokens } : rest) as T;
}

/**
 * The rel attribute a site's link renders: the security tokens a new tab needs first, then the authored ones.
 * Undefined when there is nothing to say.
 */
export function relAttribute(newTab: boolean | undefined, rels: readonly LinkRel[]): string | undefined {
  const tokens = [...(newTab ? ['noopener', 'noreferrer'] : []), ...rels];
  return tokens.length ? tokens.join(' ') : undefined;
}

/** A link's options as the text form writes them after its destination: ` "new tab"`, ` "rel=nofollow,ugc"`, both, or nothing. */
export function linkTitle(newTab: boolean | undefined, rels: readonly LinkRel[]): string {
  const parts = [newTab ? 'new tab' : '', rels.length ? `rel=${rels.join(',')}` : ''].filter(Boolean);
  return parts.length ? ` "${parts.join(' ')}"` : '';
}
