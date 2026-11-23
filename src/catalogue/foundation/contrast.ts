import type { ContrastPair } from '@shared/contrast';

/**
 * The colours Foundation's stylesheet and components set against each other, checked against base.css.ts:
 * a primary button is Text on brand on Brand (Brand (strong) on hover); a light button, used on brand
 * panels, reverses them and hovers to a mix of the two; brand-coloured links and text buttons sit straight
 * on the page, cards and alternate sections; text sits on the same three; dark sections set Text on dark
 * sections and the accent on Dark sections.
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
  { id: 'dark-text', use: 'Text in dark sections', fg: 'color.on-inverse', bg: 'color.inverse', state: 'rest', group: 'dark-text' },
  { id: 'dark-accent', use: 'Accent labels in dark sections', fg: 'color.accent', bg: 'color.inverse', state: 'rest', group: 'dark-accent', fixable: false }
];
