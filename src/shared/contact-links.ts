import type { LinkValue } from './types';

/**
 * Visible contact text (an email address or a phone number) and the link that opens it. When the two agree, an
 * edit to the text carries the link along. Text that is not an address or a number ("Call reception") is a
 * deliberate label: it never moves the link and never counts as a mismatch.
 */

/** An email address, or a phone number as the digits a tel: link dials (with its leading + kept, and `alt`, the
 *  other reading of a bracketed "(0)"). */
export type Contact = { kind: 'email'; address: string } | { kind: 'tel'; digits: string; alt?: string };

const EMAIL = /^[^\s@<>()[\]\\,;:"?]+@[^\s@<>()[\]\\,;:"?]+\.[^\s@<>()[\]\\,;:"?]+$/;
/**
 * A number as people write it on one line: an optional +, then digits with spaces (non-breaking ones too),
 * brackets, dots, hyphens or slashes.
 */
const PHONE = /^\+?[0-9(][0-9 \u00a0\u2007\u2009\u202f().\-/\u2010\u2011]*$/;
/** Fewer digits is a short code or not a number at all ("9 – 5"), which stays a label. */
const MIN_DIGITS = 7;
const MAX_DIGITS = 15;

/** Countries whose numbers keep their leading 0 when dialled from abroad: "+39 (0)6 …" dials the zero. */
const KEEPS_ZERO = /^\+(39|378|225)/;

/** A number's digits and its leading +, as written. */
const dial = (t: string) => t.replace(/[^+0-9]/g, '');
const digitCount = (t: string) => (t.match(/[0-9]/g) ?? []).length;
const TRUNK_ZERO = /\(\s*0\s*\)/g;

/**
 * The dial string the generator writes into a tel: link: the digits and a leading +, without the bracketed trunk
 * zero an international number leaves out from abroad ("+27 (0)21 555-0100" dials +27215550100), except where
 * numbers keep it ("+39 (0)6 …").
 */
export function dialString(target: string): string {
  const kept = dial(target);
  return target.trim().startsWith('+') && !KEEPS_ZERO.test(kept) ? dial(target.replace(TRUNK_ZERO, '')) : kept;
}

/** A number in visible text, or as a link's target dials it (`asDialled`: exactly as the generator writes it). */
function phone(text: string, asDialled = false): Contact | null {
  const t = text.trim();
  if (!PHONE.test(t)) return null;
  // "021 555 0142 / 082 555 0199" is two numbers, which no one link dials; "030/1234567" is one.
  const parts = t.split(/\s\/\s/);
  if (parts.length > 1 && parts.filter((p) => digitCount(p) >= MIN_DIGITS).length > 1) return null;
  const kept = dial(t);
  const count = kept.length - (kept.startsWith('+') ? 1 : 0);
  if (count < MIN_DIGITS || count > MAX_DIGITS) return null;
  if (asDialled) return { kind: 'tel', digits: dialString(t) };
  const dropped = dial(t.replace(TRUNK_ZERO, ''));
  if (!t.startsWith('+') || dropped === kept) return { kind: 'tel', digits: kept };
  // The bracketed trunk zero in "+44 (0)20 …" is left out from abroad, except where numbers keep it.
  return KEEPS_ZERO.test(kept) ? { kind: 'tel', digits: kept, alt: dropped } : { kind: 'tel', digits: dropped, alt: kept };
}

/** The address or number visible text shows, or null when the text is a label rather than an address or number. */
export function contactInText(text: unknown): Contact | null {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (EMAIL.test(t)) return { kind: 'email', address: t };
  return phone(t);
}

/** The address or number an email or phone link opens. An email link's ?subject= is not part of the address. */
export function contactInLink(link: unknown): Contact | null {
  const l = link as Partial<LinkValue> | null | undefined;
  if (!l || typeof l !== 'object' || typeof l.target !== 'string') return null;
  if (l.type === 'email') {
    const address = l.target.split('?')[0].trim();
    return EMAIL.test(address) ? { kind: 'email', address } : null;
  }
  return l.type === 'tel' ? phone(l.target, true) : null;
}

/** A number written for home, without the trunk zeros an international number drops. */
const national = (digits: string) => digits.replace(/^0+/, '');

/**
 * The codes that turn a number written for home into the same number written internationally: "+1" for
 * "(202) 555-0142" and "+12025550142", "+44" for "020 7946 0018" and "+442079460018", "+1202" for a local
 * "555-0142", and just "+" for a number that already carries its country code ("1 (202) 555-0142",
 * "0044 20 7946 0018"). Null when the two are not one number written two ways: the number at home must be at
 * least seven digits, so a different number that merely ends the same way is too unlikely to matter.
 */
function countryCode(international: string, local: string): string | null {
  if (!international.startsWith('+') || local.startsWith('+')) return null;
  const home = national(local);
  const full = international.slice(1);
  if (home.length < MIN_DIGITS || !full.endsWith(home)) return null;
  return `+${full.slice(0, full.length - home.length)}`;
}

/** Whether two contacts are the same address or number, however each is written. */
export function sameContact(a: Contact, b: Contact): boolean {
  if (a.kind === 'email' && b.kind === 'email') return a.address.toLowerCase() === b.address.toLowerCase();
  if (a.kind !== 'tel' || b.kind !== 'tel') return false;
  const same = (x: string, y: string) => x === y || countryCode(x, y) !== null || countryCode(y, x) !== null;
  return [a.digits, a.alt].some((x) => x && [b.digits, b.alt].some((y) => y && same(x, y)));
}

/** Text that starts with the linked number and goes on (an extension, a second number) still shows that number. */
function extendsLink(shown: Contact, opens: Contact): boolean {
  if (shown.kind !== 'tel' || opens.kind !== 'tel') return false;
  for (let k = shown.digits.length - 1; k >= MIN_DIGITS; k--) if (sameContact({ kind: 'tel', digits: shown.digits.slice(0, k) }, opens)) return true;
  return false;
}

/** An email link's ?subject=…, kept as a valid target: what an older document stored raw (a space, an @) is escaped. */
const queryOf = (target: string) => {
  const q = target.indexOf('?');
  return q < 0 ? '' : target.slice(q).replace(/[\s@<>"]/g, (c) => encodeURIComponent(c));
};

/**
 * The link that opens `shown`, keeping what the current link adds: its options (a new tab), an email link's
 * subject, and the codes a phone link added to the number written for home the text showed before (`was`, when
 * it matched the link).
 */
function linkTo(shown: Contact, link: LinkValue, was?: Contact): LinkValue {
  const { anchor: _anchor, ...rest } = link;
  void _anchor;
  if (shown.kind === 'email') return { ...rest, type: 'email', target: shown.address + (link.type === 'email' ? queryOf(link.target) : '') };
  const opens = contactInLink(link);
  const tel = (target: string): LinkValue => ({ ...rest, type: 'tel', target });
  if (was?.kind !== 'tel' || opens?.kind !== 'tel') return tel(shown.digits);
  if (shown.alt && was.alt && opens.digits === was.alt) return tel(shown.alt);
  // A number with its own + or 00 says how to dial it; one written for home takes the codes the link added, when
  // it is the same shape of number (a shorter one may have lost its area code).
  if (/^(\+|00)/.test(shown.digits)) return tel(shown.digits);
  const code = countryCode(opens.digits, was.digits);
  return tel(code && national(shown.digits).length === national(was.digits).length ? code + national(shown.digits) : shown.digits);
}

/**
 * Text as a one-line field stores it: its lines joined with spaces (see normalizeScalar). Lines that are each an
 * address or number are a list of them, not one split across lines, and no link opens a list: null.
 */
export function joinedLines(text: unknown): unknown {
  if (typeof text !== 'string' || !text.includes('\n')) return text;
  return text.split('\n').filter((line) => contactInText(line)).length > 1 ? null : text.replace(/\s*\n\s*/g, ' ');
}

/**
 * The link to keep with visible text an edit changed from `before` to `after`, or null to leave the link as it
 * is. The link follows only when `before` showed what it opens and `after` shows an address or number it does
 * not already open; a change of kind (an email edited to a phone number) changes the kind of link too.
 */
export function followText(before: unknown, after: unknown, link: unknown): LinkValue | null {
  const opens = contactInLink(link);
  const was = contactInText(before);
  if (!opens || !was || !sameContact(was, opens)) return null;
  const now = contactInText(after);
  if (!now || sameContact(now, opens) || extendsLink(now, opens)) return null;
  return linkTo(now, link as LinkValue, was);
}

/**
 * Visible text and a link that disagree: both are real addresses or numbers, and not the same one. `opens` is
 * what the link opens as a visitor's browser shows it, and `repair` is the link that would open what the text shows.
 */
export function contactMismatch(text: unknown, link: unknown): { kind: Contact['kind']; shown: string; opens: string; repair: LinkValue } | null {
  const shown = contactInText(text);
  const opens = contactInLink(link);
  if (!shown || !opens || sameContact(shown, opens) || extendsLink(shown, opens)) return null;
  const repair = linkTo(shown, link as LinkValue);
  return { kind: shown.kind, shown: String(text).trim(), opens: opens.kind === 'email' ? `mailto:${opens.address}` : `tel:${opens.digits}`, repair };
}
