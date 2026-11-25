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
/** The response headers passed back to the guest. Cookies, hop-by-hop headers and anything naming the host's machine never are. */
export const PREVIEW_RESPONSE_HEADERS = [
  'accept-ranges',
  'cache-control',
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

/** Why a preview stream was stopped, by either end. */
export const PREVIEW_ABORT_CODES = ['CANCELLED', 'TIMEOUT', 'TOO_LARGE', 'UNAVAILABLE', 'INVALID_RESPONSE'] as const;
export type PreviewAbortCode = (typeof PREVIEW_ABORT_CODES)[number];

const HEADER_NAME_RE = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
// A header value holds no line breaks or NUL: nothing can start another header or end the head early.
const HEADER_VALUE_RE = /^[^\r\n\0]*$/;

/** Whether `name` is a lowercase HTTP header name that may travel in the given direction. */
export function isPreviewHeaderName(name: string, direction: 'request' | 'response'): boolean {
  if (name.length > MAX_HEADER_NAME_LENGTH || !HEADER_NAME_RE.test(name)) return false;
  return (direction === 'request' ? (PREVIEW_REQUEST_HEADERS as readonly string[]) : (PREVIEW_RESPONSE_HEADERS as readonly string[])).includes(name);
}

export function isPreviewHeaderValue(value: string): boolean {
  return value.length <= MAX_HEADER_VALUE_LENGTH && HEADER_VALUE_RE.test(value);
}

/**
 * Whether `target` is a path within the preview, with an optional query, as a request (or a redirect's `location`)
 * names it: one leading slash and no authority, no fragment, no spaces or controls, no backslash, and no segment
 * that is, or decodes to, `.` or `..` or holds an encoded slash. Checked as written, so nothing a URL parser would
 * normalize away is accepted for what it becomes.
 */
export function isPreviewTarget(target: unknown): target is string {
  if (typeof target !== 'string' || target.length === 0 || target.length > MAX_PREVIEW_PATH_LENGTH) return false;
  if (!target.startsWith('/') || target.startsWith('//')) return false;
  if (/[\s\u0000-\u001f\u007f\\#]/.test(target)) return false;
  const path = target.split('?', 1)[0];
  for (const segment of path.split('/').slice(1)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (decoded === '.' || decoded === '..' || /[/\\\u0000]/.test(decoded)) return false;
  }
  return true;
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
      const length = frame.headers.find(([name]) => name === 'content-length')?.[1];
      if (length !== undefined) {
        if (!/^\d{1,10}$/.test(length)) return this.fail('INVALID_RESPONSE', 'The response’s length is not a number.');
        this.declared = Number(length);
        if (this.declared > MAX_PREVIEW_RESPONSE_BYTES && this.method !== 'HEAD') return this.fail('TOO_LARGE', 'The response is too large to show.');
      }
      this.bodyless = this.method === 'HEAD' || BODYLESS.has(frame.status);
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
    if (this.declared !== null && !this.bodyless && this.declared !== this.bytes) return this.fail('INVALID_RESPONSE', 'The response is shorter than its head said.');
    this.state = 'done';
    return { ok: true, done: true };
  }

  private fail(code: 'INVALID_RESPONSE' | 'TOO_LARGE', message: string): PreviewStreamStep {
    this.state = 'done';
    return { ok: false, code, message };
  }
}
