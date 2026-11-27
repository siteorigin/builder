import type { ContrastPair } from '@shared/contrast';

/**
 * The colours Foundation's stylesheet and components set against each other, checked against base.css.ts:
 * a primary button is Text on brand on Brand (Brand (strong) on hover); a light button, used on brand
 * panels, reverses them and hovers to a mix of the two; brand-coloured links and text buttons sit straight
 * on the page, cards and alternate sections; text sits on the same three; dark sections set Text on dark
 * sections and the accent on Dark sections. The keyboard focus outline is drawn in the focus colour on the three
 * light grounds; on dark and brand ones it takes their text colour instead, as do links, text buttons and check
 * marks there, and a primary button there reverses: Dark sections on Text on dark sections, hovering to a mix of
 * the two. Its fill lands on the section, not the page, hence the varying ground. A form's error messages and the
 * edges of the fields to put right are drawn in the error colour on the three light grounds (the inner edge of a field
 * on its own card-coloured fill), and in the error colour for dark sections there: 4.5:1 as text, 3:1 as an edge.
 */
const grounds: Array<[token: string, label: string]> = [
  ['color.background', 'the page'],
  ['color.surface', 'cards and panels'],
  ['color.surface-alt', 'alternate sections']
];

export const FOUNDATION_CONTRAST_PAIRS: ContrastPair[] = [
  { id: 'button', use: 'Button text', fg: 'color.on-brand', bg: 'color.brand', state: 'rest', group: 'button' },
  { id: 'button-hover', use: 'Button text on hover', fg: 'color.on-brand', bg: 'color.brand-strong', state: 'hover', group: 'button' },
  { id: 'light-button', use: 'Light button text', fg: 'color.brand-strong', bg: 'color.on-brand', state: 'rest', group: 'light-button', fixable: false, varyingGround: true },
  { id: 'light-button-hover', use: 'Light button text on hover', fg: 'color.brand-strong', bg: { mix: ['color.on-brand', 88, 'color.brand'] }, state: 'hover', group: 'light-button', fixable: false, varyingGround: true },
  ...grounds.map(([bg, label]): ContrastPair => ({ id: `brand-text-${bg.slice(6)}`, use: `Brand-colored links on ${label}`, fg: 'color.brand', bg, state: 'rest', group: 'brand-text', fixable: false })),
  ...grounds.map(([bg, label]): ContrastPair => ({ id: `text-${bg.slice(6)}`, use: `Text on ${label}`, fg: 'color.text', bg, state: 'rest', group: 'text' })),
  ...grounds.map(([bg, label]): ContrastPair => ({ id: `muted-${bg.slice(6)}`, use: `Muted text on ${label}`, fg: 'color.muted', bg, state: 'rest', group: 'muted' })),
  ...grounds.map(([bg, label]): ContrastPair => ({ id: `focus-${bg.slice(6)}`, use: `Keyboard focus outline on ${label}`, fg: 'color.focus', bg, state: 'rest', group: 'focus', fixable: false, min: 3 })),
  ...grounds.map(([bg, label]): ContrastPair => ({ id: `error-${bg.slice(6)}`, use: `Error messages on ${label}`, fg: 'color.error', bg, state: 'rest', group: 'error', fixable: false })),
  ...grounds.map(([bg, label]): ContrastPair => ({ id: `error-edge-${bg.slice(6)}`, use: `Edges of fields to put right on ${label}`, fg: 'color.error', bg, state: 'rest', group: 'error-edge', fixable: false, min: 3 })),
  { id: 'dark-error', use: 'Error messages in dark sections', fg: 'color.error-on-inverse', bg: 'color.inverse', state: 'rest', group: 'dark-error', fixable: false },
  { id: 'dark-error-edge', use: 'Edges of fields to put right in dark sections', fg: 'color.error-on-inverse', bg: 'color.inverse', state: 'rest', group: 'dark-error-edge', fixable: false, min: 3 },
  { id: 'dark-text', use: 'Text in dark sections', fg: 'color.on-inverse', bg: 'color.inverse', state: 'rest', group: 'dark-text' },
  { id: 'dark-button', use: 'Button text in dark sections', fg: 'color.inverse', bg: 'color.on-inverse', state: 'rest', group: 'dark-button', fixable: false, varyingGround: true },
  { id: 'dark-button-hover', use: 'Button text in dark sections on hover', fg: 'color.inverse', bg: { mix: ['color.on-inverse', 88, 'color.inverse'] }, state: 'hover', group: 'dark-button', fixable: false, varyingGround: true },
  { id: 'dark-accent', use: 'Accent labels in dark sections', fg: 'color.accent', bg: 'color.inverse', state: 'rest', group: 'dark-accent', fixable: false }
];
