import type { SiteDoc } from './types';
import { isLoopbackHost } from './local';

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
/** One label of a host name, as DNS can hold it: up to 63 letters, digits and inner hyphens ("xn--bcher-kva" once an
 *  accented name is encoded). */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
/** Ports browsers refuse to open whatever the URL parser says (the Fetch Standard's "bad ports"). */
const BLOCKED_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427,
  465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666,
  6667, 6668, 6669, 6679, 6697, 10080
]);
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
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return refuse('The public URL can’t contain spaces or control characters.');
  if (text.includes('\\')) return refuse('Use “/” rather than “\\” in the public URL.');
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(text)?.[1];
  // "kloof.example", or "kloof.example:8443/studio", whose host reads like a scheme: a host typed without https://.
  if (!scheme || (!text.includes('://') && /^[^/?#@]+:\d+(?:[/?#]|$)/.test(text))) return withoutScheme(text);
  if (scheme.toLowerCase() === 'http') {
    // A port named for plain http ("http://host:8080") is no port to offer https on.
    const meant = /^http:\/\/[^/?#]*:\d*(?:[/?#]|$)/i.test(text) ? null : checkPublicUrl(text.replace(/^http:/i, 'https:'));
    return refuse('Change http:// to https://, which browsers expect of a published site.', meant?.ok ? meant.url : undefined);
  }
  if (scheme.toLowerCase() !== 'https') return refuse(`The public URL must start with https://, not ${scheme}:.`);
  if (!/^https:\/\//i.test(text)) return refuse('Write https:// with two slashes before the host name.');
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
    if (BLOCKED_PORTS.has(Number(port))) return refuse(`Browsers refuse to open web pages on port ${Number(port)}. Use another port, or leave it out for the usual 443.`);
  }
  const path = rawPath.replace(/\/+$/, '');
  const segments = path ? path.split('/').slice(1) : [];
  if (segments.includes('')) return refuse('The path of the public URL has an empty part (“//”).');
  const dots = segments.find((s) => s === '.' || s === '..');
  if (dots) return refuse(`The path of the public URL can’t have a “${dots}” part. Write the folder the site is published in.`);
  const bad = segments.find((s) => !SEGMENT.test(s));
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

/** The reserved example domains (RFC 2606, RFC 6761), each with every name under it. */
const EXAMPLE_DOMAINS = ['example.com', 'example.org', 'example.net'];
/** Top-level names reserved for examples, tests and addresses that never resolve, and the local machine's own. */
const RESERVED_TLDS = ['example', 'test', 'invalid'];

/**
 * What kind of stand-in a web address's host is, when it is one: a reserved example or test domain that is nobody's
 * website (`example.com`, `studio.test`), or this computer (`localhost`, `127.0.0.1`, `[::1]`), which every visitor's
 * own computer answers instead. Null for any other host, and for text that is no http(s) address.
 */
export function placeholderHost(address: string): { host: string; kind: 'placeholder' | 'local' } | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  const tld = host.slice(host.lastIndexOf('.') + 1);
  if (tld === 'localhost' || isLoopbackHost(host)) return { host, kind: 'local' };
  if (RESERVED_TLDS.includes(tld) || EXAMPLE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return { host, kind: 'placeholder' };
  return null;
}
