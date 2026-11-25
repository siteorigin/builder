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

/** A guest's display name, after trimming: what the host reads in the waiting room. */
export const DISPLAY_NAME_MAX = 40;
/** How many guests a room holds at once, admitted or waiting. */
export const MAX_GUESTS = 8;

/**
 * The largest text frame anyone sends or accepts, in UTF-8 bytes: well under Cloudflare's 1 MiB WebSocket message
 * limit, so the relay never has to split or drop one.
 */
export const MAX_FRAME_BYTES = 768 * KiB;
/** Preview response bodies travel in chunks of at most this many bytes, base64 encoded in their frame. */
export const PREVIEW_CHUNK_BYTES = 256 * KiB;
/** The most a single tunnelled preview response may carry in all; the host stops a larger one and aborts it. */
export const MAX_PREVIEW_RESPONSE_BYTES = 32 * MiB;
/** The most a tunnelled preview request may carry as its body. The preview is read-only, so this stays small. */
export const MAX_PREVIEW_REQUEST_BODY_BYTES = 64 * KiB;
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
/** A presence selection: the element ref a participant has selected, kept short. */
export const MAX_SELECTION_REF_LENGTH = 256;
/** A page ID in presence or preview reloads. */
export const MAX_PAGE_ID_LENGTH = 128;
/** The viewport widths a presence update may report, in CSS pixels. */
export const MIN_VIEWPORT_WIDTH = 200;
export const MAX_VIEWPORT_WIDTH = 8192;
/** A human-readable message carried by an error or a status, shown to a person. */
export const MAX_MESSAGE_LENGTH = 500;
