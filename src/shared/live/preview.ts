import { MAX_HEADER_NAME_LENGTH, MAX_HEADER_VALUE_LENGTH, MAX_PREVIEW_PATH_LENGTH, MAX_PREVIEW_RESPONSE_BYTES } from './limits';

/**
 * The rules for the preview tunnel: which requests a guest's browser may send through the relay to the host's
 * preview, which response headers come back, and how a streamed response is accounted for. The host still owns
 * containment (only its own loopback preview server is ever asked); these keep every frame well-formed on the wire.
 */

/** The preview is read-only: nothing else reaches it. */
export const PREVIEW_METHODS = ['GET', 'HEAD'] as const;
export type PreviewMethod = (typeof PREVIEW_METHODS)[number];

/** The request headers passed on to the host's preview. Cookies, credentials and the relay's own headers never are. */
export const PREVIEW_REQUEST_HEADERS = ['accept', 'accept-language', 'cache-control', 'if-modified-since', 'if-none-match', 'if-range', 'range'] as const;
/**
 * The response headers passed back to the guest. Cookies, hop-by-hop headers and anything naming the host's machine
 * never are, and neither is the preview's own caching policy: the relay answers every preview request with
 * PREVIEW_CACHE_CONTROL, so no shared cache keeps a page that only admitted guests may see.
 */
export const PREVIEW_RESPONSE_HEADERS = [
  'accept-ranges',
  'content-disposition',
  'content-language',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
  'location',
  'vary',
  'x-content-type-options'
] as const;

/** The Cache-Control the relay gives every preview response: kept by the guest's own browser only, and checked each time. */
export const PREVIEW_CACHE_CONTROL = 'private, no-cache';

/** Why a preview stream was stopped, by either end. */
export const PREVIEW_ABORT_CODES = ['CANCELLED', 'TIMEOUT', 'TOO_LARGE', 'UNAVAILABLE', 'INVALID_RESPONSE'] as const;
export type PreviewAbortCode = (typeof PREVIEW_ABORT_CODES)[number];

const HEADER_NAME_RE = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
// An HTTP field value: tabs, visible ASCII, spaces and Latin-1 bytes only. No line break, NUL or other control can
// start another header or end the head early, and nothing is sent that Fetch or Node would refuse to send.
const HEADER_VALUE_RE = /^[\t\x20-\x7e\x80-\xff]*$/;

/** Whether `name` is a lowercase HTTP header name that may travel in the given direction. */
export function isPreviewHeaderName(name: string, direction: 'request' | 'response'): boolean {
  if (name.length > MAX_HEADER_NAME_LENGTH || !HEADER_NAME_RE.test(name)) return false;
  return (direction === 'request' ? (PREVIEW_REQUEST_HEADERS as readonly string[]) : (PREVIEW_RESPONSE_HEADERS as readonly string[])).includes(name);
}

export function isPreviewHeaderValue(value: string): boolean {
  return value.length <= MAX_HEADER_VALUE_LENGTH && HEADER_VALUE_RE.test(value);
}

/**
 * The development server's own routes, which the preview never needs and a guest must never reach: they act on the
 * host's computer (`__open-in-editor` opens a file in the host's editor). Any first path segment starting with `__`
 * is taken for one, except the files SvelteKit fetches a page's data and route from. The routes that act on the host
 * are refused at any depth too, since a project's own Vite config may serve everything under another base, and in
 * any spelling the server matches them by: in any case, and with anything after a `.`.
 */
const HOST_ACTION_ROUTES = ['__open-in-editor', '__inspect'];
const SVELTEKIT_FILES = new Set(['__data.json', '__route.js']);
function isDevServerRoute(segment: string, first: boolean): boolean {
  const lower = segment.toLowerCase();
  if (HOST_ACTION_ROUTES.some((route) => lower === route || lower.startsWith(`${route}.`))) return true;
  return first && segment.startsWith('__') && !SVELTEKIT_FILES.has(segment);
}

/**
 * Whether `target` is a path within the preview, with an optional query, as a request names it: one leading slash
 * and no authority, no fragment, no spaces or controls, no backslash, no segment that is or decodes to `.` or `..`
 * or holds an encoded slash, and none of the development server's own routes. Checked as written, so nothing a URL
 * parser or the preview server would normalize away is accepted for what it becomes. An empty segment inside the
 * path stays (Vite names some modules `/@fs//…`); only a leading `//`, which would name another host, is refused.
 */
export function isPreviewTarget(target: unknown): target is string {
  if (typeof target !== 'string' || target.length === 0 || target.length > MAX_PREVIEW_PATH_LENGTH) return false;
  if (!target.startsWith('/') || target.startsWith('//') || /[\s\u0000-\u001f\u007f\\#]/.test(target)) return false;
  const segments = target.split('?', 1)[0].split('/').slice(1);
  for (const [i, segment] of segments.entries()) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (decoded === '.' || decoded === '..' || /[/\\\u0000]/.test(decoded)) return false;
    if (isDevServerRoute(decoded, i === 0)) return false;
  }
  return true;
}

/** Whether a redirect's `location` stays within the preview: a target as above, which may also name a fragment. */
export function isPreviewLocation(location: unknown): location is string {
  if (typeof location !== 'string') return false;
  const at = location.indexOf('#');
  if (at < 0) return isPreviewTarget(location);
  return isPreviewTarget(location.slice(0, at)) && !/[\s\u0000-\u001f\u007f\\#]/.test(location.slice(at + 1));
}

/**
 * The address a guest's browser is sent to for a redirect within the preview: the same place under the room's
 * preview path. The host's preview answers as if it were the whole site, so its `/about/` is the room's
 * `<previewPath>/about/`, never the relay's own `/about/`. Null when the location leaves the preview.
 */
export function previewBrowserLocation(previewPath: string, location: string): string | null {
  return isPreviewLocation(location) ? `${previewPath.replace(/\/+$/, '')}${location}` : null;
}

/** The number of bytes unpadded base64url text of this length holds. */
export function base64UrlByteLength(text: string): number {
  return Math.floor((text.length * 3) / 4);
}

export type PreviewStreamFrame =
  | { type: 'preview:response-head'; status: number; headers: Array<[string, string]> }
  | { type: 'preview:response-chunk'; seq: number; data: string }
  | { type: 'preview:response-end'; totalBytes: number }
  | { type: 'preview:abort'; code: PreviewAbortCode };

export type PreviewStreamStep = { ok: true; done: boolean } | { ok: false; code: 'INVALID_RESPONSE' | 'TOO_LARGE'; message: string };

/** Statuses that never carry a body. */
const BODYLESS = new Set([204, 205, 304]);

/**
 * Follows one preview response's frames, at whichever end reads them (the relay as it streams to the guest, a client
 * as it rebuilds the body), so every reader holds it to the same order and size: one head, chunks numbered from zero
 * with no gaps, then one end whose byte count is what arrived; or an abort at any point before the end. The bytes are
 * counted as they arrive, so chunks that are each small enough can never add up to more than the most a response may
 * carry, whatever its head said. Single-frame shape and size are checked by the frame parser, not here.
 */
export class PreviewStream {
  private state: 'head' | 'body' | 'done' = 'head';
  private next = 0;
  private bytes = 0;
  private declared: number | null = null;
  private bodyless = false;

  constructor(readonly method: PreviewMethod) {}

  /** The body bytes received so far. */
  get received(): number {
    return this.bytes;
  }

  accept(frame: PreviewStreamFrame): PreviewStreamStep {
    if (this.state === 'done') return this.fail('INVALID_RESPONSE', 'The response has already ended.');
    if (frame.type === 'preview:abort') {
      this.state = 'done';
      return { ok: true, done: true };
    }
    if (frame.type === 'preview:response-head') {
      if (this.state !== 'head') return this.fail('INVALID_RESPONSE', 'A response has one head.');
      const lengths = frame.headers.filter(([name]) => name === 'content-length').map(([, value]) => value);
      if (lengths.length > 1) return this.fail('INVALID_RESPONSE', 'The response gives its length more than once.');
      if (lengths.length && !/^\d{1,15}$/.test(lengths[0])) return this.fail('INVALID_RESPONSE', 'The response’s length is not a number.');
      // A HEAD answer, a 204 or 205, and a 304 carry no body, whatever length they describe.
      this.bodyless = this.method === 'HEAD' || BODYLESS.has(frame.status);
      if (lengths.length && !this.bodyless) {
        this.declared = Number(lengths[0]);
        if (this.declared > MAX_PREVIEW_RESPONSE_BYTES) return this.fail('TOO_LARGE', 'The response is too large to show.');
      }
      this.state = 'body';
      return { ok: true, done: false };
    }
    if (this.state !== 'body') return this.fail('INVALID_RESPONSE', 'A response starts with its head.');
    if (frame.type === 'preview:response-chunk') {
      if (this.bodyless) return this.fail('INVALID_RESPONSE', 'This response has no body.');
      if (frame.seq !== this.next) return this.fail('INVALID_RESPONSE', `Expected chunk ${this.next}, not ${frame.seq}.`);
      this.next++;
      this.bytes += base64UrlByteLength(frame.data);
      if (this.bytes > MAX_PREVIEW_RESPONSE_BYTES) return this.fail('TOO_LARGE', 'The response is too large to show.');
      if (this.declared !== null && this.bytes > this.declared) return this.fail('INVALID_RESPONSE', 'The response is longer than its head said.');
      return { ok: true, done: false };
    }
    if (frame.totalBytes !== this.bytes) return this.fail('INVALID_RESPONSE', `The response ended after ${this.bytes} bytes, not ${frame.totalBytes}.`);
    if (this.declared !== null && this.declared !== this.bytes) return this.fail('INVALID_RESPONSE', 'The response is shorter than its head said.');
    this.state = 'done';
    return { ok: true, done: true };
  }

  private fail(code: 'INVALID_RESPONSE' | 'TOO_LARGE', message: string): PreviewStreamStep {
    this.state = 'done';
    return { ok: false, code, message };
  }
}
