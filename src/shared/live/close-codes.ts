/**
 * The codes the relay closes a live session's sockets with, so each side can tell why its socket closed. A guest is
 * sent its `guest:status` first; the host has no such frame, so for the host the code is the reason. Imports nothing,
 * so the relay can take it as it is.
 */
export const LIVE_CLOSE_CODES = {
  /** The host ended the session. */
  ENDED: 1000,
  /** The peer broke the protocol or failed to prove who it is. */
  POLICY: 1008,
  /** A frame was over the size limit. */
  TOO_LARGE: 1009,
  /** The session reached its end. */
  SESSION_EXPIRED: 4001,
  /** The host stayed away past the reconnect grace, so the room closed. */
  HOST_GONE: 4002,
  /** Another socket took this one's place: the host proved itself again, or the guest resumed on a new socket. */
  REPLACED: 4003,
  /** The host removed or declined this guest, or the guest's own access ended. */
  REMOVED: 4004,
  /** The room turned the socket away: it is full or locked. */
  REFUSED: 4005,
  /** The socket did not create, join or prove itself in time. */
  HANDSHAKE_TIMEOUT: 4006
} as const;

export type LiveCloseCode = (typeof LIVE_CLOSE_CODES)[keyof typeof LIVE_CLOSE_CODES];
