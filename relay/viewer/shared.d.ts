/** Types for shared.js, the viewer's copy of the live session contract (tests/unit/relay-viewer.test.ts compares them). */
export function normalizeDisplayName(raw: unknown, max: number): string | null;
export const VIEWPORTS: Readonly<{ desktop: number; tablet: number; mobile: number }>;
export const CLOSE_CODES: Readonly<Record<'ENDED' | 'POLICY' | 'TOO_LARGE' | 'SESSION_EXPIRED' | 'HOST_GONE' | 'REPLACED' | 'REMOVED' | 'REFUSED' | 'HANDSHAKE_TIMEOUT', number>>;
export const PREVIEW_ADMISSION_PATH: string;
export const BRIDGE_MESSAGES: Readonly<{ ready: string; reload: string; reloading: string; refused: string; point: string; pointed: string; pointCancelled: string }>;
export const MAX_ID_LENGTH: number;
export const MAX_SELECTION_DEPTH: number;
export function isSpotlightPath(path: unknown): path is string;
export function isFramePath(path: unknown): path is string;
