/**
 * What the guest's viewer shares with the live session's own contract in src/shared/live, kept here because the
 * viewer is plain JavaScript served as it is, with no build. tests/unit/relay-viewer.test.ts checks each against the
 * original, so the two cannot drift apart unnoticed. The relay still refuses any frame the contract does not allow.
 */

/** As in src/shared/live/messages.ts: characters a name may never hold, and what it must show. */
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Bidi_Control}ᅟᅠ​⁠⠀ㅤ﻿ﾠ]/u;
const VISIBLE_NAME_CHAR = /[\p{L}\p{N}\p{S}\p{P}]/u;

/**
 * A display name as it travels (normalizeDisplayName in src/shared/live/messages.ts): in Unicode normal form C, every
 * run of spaces made one space, trimmed, 1 to `max` characters (code points) long, showing something, and holding
 * none of the characters above. Null when nothing usable is left.
 * @param {unknown} raw
 * @param {number} max
 * @returns {string | null}
 */
export function normalizeDisplayName(raw, max) {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!name || UNSAFE_NAME_CHARS.test(name) || !VISIBLE_NAME_CHAR.test(name) || [...name].length > max) return null;
  return name;
}

/** The editor's preview widths, in CSS pixels (VIEWPORT_PRESETS in src/shared/styles.ts). */
export const VIEWPORTS = Object.freeze({ desktop: 1280, tablet: 834, mobile: 390 });

/** The codes the relay closes a guest's socket with (LIVE_CLOSE_CODES in src/shared/live/close-codes.ts). */
export const CLOSE_CODES = Object.freeze({
  ENDED: 1000,
  POLICY: 1008,
  TOO_LARGE: 1009,
  SESSION_EXPIRED: 4001,
  HOST_GONE: 4002,
  REPLACED: 4003,
  REMOVED: 4004,
  REFUSED: 4005,
  HANDSHAKE_TIMEOUT: 4006
});

/** Where, on the room's preview origin, a preview ticket is redeemed (PREVIEW_ADMISSION_PATH in src/shared/live/relay-url.ts). */
export const PREVIEW_ADMISSION_PATH = '/__siteorigin/admission';

/** The messages between the viewer and the reload bridge in its preview frame (preview-bridge.js). */
export const BRIDGE_MESSAGES = Object.freeze({
  ready: 'siteorigin-live:ready',
  reload: 'siteorigin-live:reload',
  reloading: 'siteorigin-live:reloading',
  refused: 'siteorigin-live:refused',
  point: 'siteorigin-live:point',
  pointed: 'siteorigin-live:pointed',
  pointCancelled: 'siteorigin-live:point-cancelled',
  leaving: 'siteorigin-live:leaving',
  where: 'siteorigin-live:where'
});

/** As in src/shared/live/limits.ts: the longest ID a spotlight's element names, and how deep its path may reach. */
export const MAX_ID_LENGTH = 128;
export const MAX_SELECTION_DEPTH = 16;

/** As in src/shared/live/preview.ts: the development server's own routes, which are never a place in the preview. */
const HOST_ACTION_ROUTES = ['__open-in-editor', '__inspect'];
const SVELTEKIT_FILES = ['__data.json', '__route.js'];

/**
 * Whether `path` may be sent as a spotlight's address (the presence path rule in src/shared/live/messages.ts, with
 * isPreviewTarget in src/shared/live/preview.ts): printable ASCII with nothing a URL serializer would percent-encode,
 * within the preview, each segment decoding to something other than `.`, `..`, a slash or a server route of its own.
 * @param {unknown} path
 * @returns {path is string}
 */
export function isSpotlightPath(path) {
  if (!isFramePath(path) || !/^[\x21-\x7e]+$/.test(path) || /["<>`{}]/.test(path)) return false;
  return path
    .split('?', 1)[0]
    .split('/')
    .slice(1)
    .every((segment, i) => {
      let decoded;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return false;
      }
      if (decoded === '.' || decoded === '..' || /[/\\\u0000]/.test(decoded)) return false;
      const lower = decoded.toLowerCase();
      if (HOST_ACTION_ROUTES.some((route) => lower === route || lower.startsWith(`${route}.`))) return false;
      return !(i === 0 && decoded.startsWith('__') && !SVELTEKIT_FILES.includes(decoded));
    });
}

/**
 * Whether `path` is a path (and query) on the preview origin the viewer may point its frame at: one leading slash,
 * never `//` (another host), and no spaces, controls, backslashes or fragment. The relay checks every request fully.
 * @param {unknown} path
 * @returns {path is string}
 */
export function isFramePath(path) {
  return typeof path === 'string' && path.length <= 2048 && path.startsWith('/') && !path.startsWith('//') && !/[\s\u0000-\u001f\u007f\\#]/.test(path);
}
