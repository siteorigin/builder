/**
 * A theme's error roles as Builder's copy of Foundation declared them (#1016), for the tests of Builder's own handling of
 * error colours: the shipped release declares none of them yet, so these tests add them to a loaded theme's tokens and
 * contrast pairs. Taken from the deleted `src/catalogue/foundation/tokens.ts` and `contrast.ts`.
 */
import type { ContrastPair } from '@shared/contrast';
import type { TokenDef } from '@shared/types';

/** The error colour for the light grounds, and the one for dark sections. */
export const ERROR_TOKENS: TokenDef[] = [
  { id: 'color.error', label: 'Errors', group: 'color', value: '#b3261e' },
  { id: 'color.error-on-inverse', label: 'Errors on dark sections', group: 'color', value: '#ff8a80' }
];

const grounds: Array<[token: string, label: string]> = [
  ['color.background', 'the page'],
  ['color.surface', 'cards and panels'],
  ['color.surface-alt', 'alternate sections']
];

/**
 * A form's error messages and the edges of the fields to put right, in the error colour on the three light grounds and
 * in the error colour for dark sections there: 4.5:1 as text, 3:1 as an edge. The author's to choose, so never fixable.
 */
export const ERROR_CONTRAST_PAIRS: ContrastPair[] = [
  ...grounds.map(([bg, label]): ContrastPair => ({ id: `error-${bg.slice(6)}`, use: `Error messages on ${label}`, fg: 'color.error', bg, state: 'rest', group: 'error', fixable: false })),
  ...grounds.map(([bg, label]): ContrastPair => ({ id: `error-edge-${bg.slice(6)}`, use: `Edges of fields to put right on ${label}`, fg: 'color.error', bg, state: 'rest', group: 'error-edge', fixable: false, min: 3 })),
  { id: 'dark-error', use: 'Error messages in dark sections', fg: 'color.error-on-inverse', bg: 'color.inverse', state: 'rest', group: 'dark-error', fixable: false },
  { id: 'dark-error-edge', use: 'Edges of fields to put right in dark sections', fg: 'color.error-on-inverse', bg: 'color.inverse', state: 'rest', group: 'dark-error-edge', fixable: false, min: 3 }
];

const ERROR_TOKEN_IDS = new Set(ERROR_TOKENS.map((t) => t.id));
const ERROR_PAIR_IDS = new Set(ERROR_CONTRAST_PAIRS.map((p) => p.id));

/** A theme's tokens and pairs with the error roles declared: any it already declares are replaced by these. */
export function withErrorRoles(theme: { tokens: readonly TokenDef[]; pairs: readonly ContrastPair[] }): { tokens: TokenDef[]; pairs: ContrastPair[] } {
  return {
    tokens: [...theme.tokens.filter((t) => !ERROR_TOKEN_IDS.has(t.id)), ...ERROR_TOKENS],
    pairs: [...theme.pairs.filter((p) => !ERROR_PAIR_IDS.has(p.id)), ...ERROR_CONTRAST_PAIRS]
  };
}
