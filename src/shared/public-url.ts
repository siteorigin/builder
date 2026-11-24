import type { SiteDoc } from './types';

/** The most characters a public URL keeps, as typed and once normalized. */
export const PUBLIC_URL_MAX = 200;

/** Why a public URL can't be used, and the address most likely meant when there is one ("kloof.example" ->
 *  "https://kloof.example"). */
export interface PublicUrlProblem {
  message: string;
  suggestion?: string;
}

/** A public URL as checked: the address to store ("" when none is set), or why it can't be used. */
export type PublicUrlCheck = { ok: true; url: string } | ({ ok: false } & PublicUrlProblem);

/** One path segment SvelteKit takes in its base path, and that every generated link carries unchanged. */
const SEGMENT = /^[\w.-]+$/;
/** One label of a host name: letters, digits and inner hyphens ("xn--bcher-kva" once an accented name is encoded). */
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const NEEDS_HOST = 'The public URL needs a host name after https://, such as https://example.com.';

const refuse = (message: string, suggestion?: string): PublicUrlCheck => (suggestion ? { ok: false, message, suggestion } : { ok: false, message });

/**
 * Check a public URL with the parser browsers and the site build use (WHATWG URL), and give back the form the site
 * is built from: https, the host as browsers write it, no default port, and the sub-path with no trailing slash
 * ("https://Example.com:443/studio/" -> "https://example.com/studio"). The typed text is checked before the parser
 * repairs it ("https:///about", "/a/../b"), and a refusal names the part that is wrong.
 */
export function checkPublicUrl(input: string): PublicUrlCheck {
  const text = input.trim();
  if (!text) return { ok: true, url: '' };
  if (text.length > PUBLIC_URL_MAX) return refuse(`The public URL can be at most ${PUBLIC_URL_MAX} characters.`);
  if (/\s/.test(text)) return refuse('The public URL can’t contain spaces.');
  if (text.includes('\\')) return refuse('Use “/” rather than “\\” in the public URL.');
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(text)?.[1];
  // "kloof.example", or "kloof.example:8443/studio", whose host reads like a scheme: a host typed without https://.
  if (!scheme || (!text.includes('://') && /^[^/?#@]+:\d+(?:[/?#]|$)/.test(text))) return withoutScheme(text);
  if (scheme.toLowerCase() === 'http') {
    const meant = checkPublicUrl(text.replace(/^http:/i, 'https:'));
    return refuse('Change http:// to https://, which browsers expect of a published site.', meant.ok ? meant.url : undefined);
  }
  if (scheme.toLowerCase() !== 'https') return refuse(`The public URL must start with https://, not ${scheme}:.`);
  const parts = /^https:\/\/([^/?#]*)([^?#]*)/i.exec(text);
  if (!parts || !parts[1]) return refuse(NEEDS_HOST);
  const [, authority, rawPath] = parts;
  if (authority.includes('@')) return refuse('Leave the user name and password out of the public URL.');
  if (text.includes('?')) return refuse('Leave the query (the part from “?”) out of the public URL.');
  if (text.includes('#')) return refuse('Leave the “#” part out of the public URL.');
  // A port follows the last colon outside an IPv6 address ("[::1]:8080").
  const hostPort = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/.exec(authority);
  if (!hostPort) return refuse(`“${authority}” is not a host name browsers can open.`);
  const [, host, port] = hostPort;
  if (port !== undefined) {
    if (port === '') return refuse('Add the port number after “:”, or remove the “:”.');
    if (!/^\d+$/.test(port)) return refuse(`The port “${port}” is not a number.`);
    if (Number(port) < 1 || Number(port) > 65535) return refuse(`The port ${port} is not valid. Use a port from 1 to 65535.`);
  }
  const path = rawPath.replace(/\/+$/, '');
  const segments = path ? path.split('/').slice(1) : [];
  if (segments.includes('')) return refuse('The path of the public URL has an empty part (“//”).');
  const bad = segments.find((s) => !SEGMENT.test(s) || s === '.' || s === '..');
  if (bad !== undefined) return refuse(`“${bad}” can’t be part of the public URL’s path. Use letters, numbers, “-”, “_” and “.”.`);
  let url: URL;
  try {
    url = new URL(`https://${authority}${path}`);
  } catch {
    return refuse(host ? `“${host}” is not a host name browsers can open.` : NEEDS_HOST);
  }
  // The parser takes some names DNS can't have ("exa_mple.com"); an IP address is already checked by it.
  const name = url.hostname.replace(/\.$/, '');
  if (!name.startsWith('[') && !name.split('.').every((l) => LABEL.test(l))) return refuse(`“${host}” is not a host name browsers can open.`);
  const normalized = url.origin + path;
  if (normalized.length > PUBLIC_URL_MAX) return refuse(`The public URL can be at most ${PUBLIC_URL_MAX} characters.`);
  return { ok: true, url: normalized };
}

/** Text with no https:// in front: an ordinary host name ("kloof.example") is offered with it added. */
function withoutScheme(text: string): PublicUrlCheck {
  const host = /^[^/:?#]*/.exec(text)![0];
  const meant = host.includes('.') && !text.startsWith('/') ? checkPublicUrl(`https://${text}`) : null;
  return meant?.ok ? refuse(`Start the public URL with https://, as in ${meant.url}.`, meant.url) : refuse('Enter the full address, starting with https://, such as https://example.com.');
}

/**
 * The public URL the site is built from: the stored one in its normalized form, or nothing when none is set or the
 * stored one can't be used (written by hand or by an earlier version), so no page links to an address browsers
 * reject.
 */
export function publicUrl(site: Pick<SiteDoc, 'baseUrl'>): string | undefined {
  if (typeof site.baseUrl !== 'string') return undefined;
  const check = checkPublicUrl(site.baseUrl);
  return check.ok && check.url ? check.url : undefined;
}
