/** A link the editor may hand to the operating system: a web page, an email address or a phone number. */
export interface ExternalLink {
  href: string;
  kind: 'web' | 'email' | 'phone';
  /** What the link points at, for a person to read before it opens (the address, the number, the URL). */
  target: string;
}

// Electron's shell.openExternal limit on Windows.
const MAX_URL = 2081;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const PHONE = /^\+?[0-9(][0-9 ().-]{1,30}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Mail fields a link may fill in. Recipients come only from the address the confirmation shows. */
const MAIL_FIELDS = new Set(['subject', 'body']);

const decoded = (v: string): string | null => {
  try {
    return decodeURIComponent(v);
  } catch {
    return null;
  }
};

/**
 * Check a link from the previewed site (or anywhere else outside the editor's control) before it is opened
 * outside the app. Only http(s) pages without credentials, mailto: with plain addresses (and at most a subject
 * and body) and tel: with a plain number are allowed; everything else (file:, javascript:, custom app schemes,
 * hidden cc/bcc recipients) is refused with null.
 */
export function externalLink(raw: unknown): ExternalLink | null {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL || CONTROL.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    if (u.username || u.password || !u.hostname) return null;
    return { href: u.href, kind: 'web', target: u.href };
  }
  if (u.protocol === 'mailto:') {
    const to = decoded(u.pathname);
    if (to === null || CONTROL.test(to)) return null;
    const list = to.split(',').map((a) => a.trim());
    if (!list.every((a) => EMAIL.test(a))) return null;
    for (const [key, value] of u.searchParams) if (!MAIL_FIELDS.has(key.toLowerCase()) || (key.toLowerCase() === 'subject' && CONTROL.test(value))) return null;
    if (u.hash) return null;
    return { href: u.href, kind: 'email', target: list.join(', ') };
  }
  if (u.protocol === 'tel:') {
    const number = decoded(u.pathname)?.trim() ?? '';
    if (!PHONE.test(number) || (number.match(/[0-9]/g) ?? []).length < 3 || u.search || u.hash) return null;
    return { href: u.href, kind: 'phone', target: number };
  }
  return null;
}
