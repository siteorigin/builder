/**
 * The bounds every side of a live session holds to: the host's main process, the relay Worker and the guests. Each
 * is checked where a message is read (messages.ts), so a frame one side would refuse is never sent by the other.
 * Imports nothing, so the relay can take it as it is.
 */

/** Bumped on any change a peer built against the older contract would misread. A peer on another version is refused. */
export const LIVE_PROTOCOL_VERSION = 1;

const KiB = 1024;
const MiB = 1024 * KiB;

/**
 * A room's ID is its invite: unguessable, from 24 characters of a 32-letter alphabet (120 bits), with no letters
 * that are easily misread when it is read out on a call (no 0, 1, l, o).
 */
export const ROOM_ID_ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz';
export const ROOM_ID_LENGTH = 24;
export const ROOM_ID_RE = /^[23456789abcdefghijkmnpqrstuvwxyz]{24}$/;

/**
 * The two roles a guest can hold. A viewer watches the live preview, follows pages and shows presence; a collaborator
 * can also make visual edits. Nothing the host alone may do is ever granted to either.
 */
export const GUEST_ROLES = ['viewer', 'collaborator'] as const;
export type GuestRole = (typeof GUEST_ROLES)[number];

/** A guest's display name, in characters (code points) after trimming: what the host reads in the waiting room. */
export const DISPLAY_NAME_MAX = 40;
/** The project's name as guests are shown it, in characters. Never a path. */
export const PROJECT_NAME_MAX = 80;
/** How many guests a room holds at once, admitted or waiting. */
export const MAX_GUESTS = 8;

/**
 * The largest text frame anyone sends or accepts, in UTF-8 bytes. This is the protocol's own limit, kept well under
 * 1 MiB so it fits any WebSocket message limit Cloudflare applies, and the relay never has to split or drop a frame.
 */
export const MAX_FRAME_BYTES = 768 * KiB;
/** Preview response bodies travel in chunks of at most this many bytes, base64 encoded in their frame. */
export const PREVIEW_CHUNK_BYTES = 256 * KiB;
/** The most a single tunnelled preview response may carry in all; the host stops a larger one and aborts it. */
export const MAX_PREVIEW_RESPONSE_BYTES = 32 * MiB;
/** How many preview requests one guest may have in flight at once. */
export const MAX_PREVIEW_REQUESTS_IN_FLIGHT = 16;
/** Header lists on preview frames: how many, and how long each name and value may be. */
export const MAX_PREVIEW_HEADERS = 64;
export const MAX_HEADER_NAME_LENGTH = 128;
export const MAX_HEADER_VALUE_LENGTH = 4 * KiB;
/** The path and query of a tunnelled preview request. */
export const MAX_PREVIEW_PATH_LENGTH = 2 * KiB;

/** The ID a request carries so its answer, chunks or abort can be matched to it. */
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A guest's ID, given by the relay when it joins. */
export const GUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A page, node, part or other document ID named in presence. */
export const MAX_ID_LENGTH = 128;
/** How deep a presence selection may reach: instances entered, or repeated items. */
export const MAX_SELECTION_DEPTH = 16;
/** The viewport widths a presence update may report, in CSS pixels. */
export const MIN_VIEWPORT_WIDTH = 200;
export const MAX_VIEWPORT_WIDTH = 8192;
/** A human-readable message carried by an error or a status, shown to a person. */
export const MAX_MESSAGE_LENGTH = 500;
