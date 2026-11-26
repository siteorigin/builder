import type { ContrastPair } from '@shared/contrast';
import { FOUNDATION_CONTRAST_PAIRS } from '../foundation/contrast';

/**
 * The colours Signal sets against each other. Its buttons, links, check marks, focus outline and dark and brand
 * grounds are drawn by the same rules as Foundation's (Signal's stylesheet adds movement and elevation, not new
 * colour pairings), and its cards sit on the same three light grounds, so it has Foundation's pairs: Text on brand
 * on Brand, brand links and text on the page, cards and alternate sections, and the dark-section pairs, at rest and
 * on hover. Its own: the eyebrow pill (see ./components), whose ground is its own colour at 8% over the section, on
 * the page and on soft sections in the brand colour, and on dark sections in the accent; the brand eyebrow on a brand
 * section, outlined and at 80% opacity; the icon badge, brand on a 12% brand tint; the chosen tab or billing period,
 * brand on a 10% tint of itself, on the page and on alternate sections; the FAQ tile on a dark section, whose ground is
 * its text at 8%; the outlined button's edge, the text at 50% on the page and on alternate sections (a control's
 * outline, so 3:1), and at 60% on brand sections; form field outlines (the text at 55%, 3:1); the accent icon in a dark block's badge; and the footer's group labels, its text at 70%, on the
 * dark footer and on the light one.
 */
const pill = (fg: string, ground: string) => ({ mix: [fg, 8, ground] as [string, number, string] });

export const SIGNAL_CONTRAST_PAIRS: ContrastPair[] = [
  ...FOUNDATION_CONTRAST_PAIRS.map((p) => ({ ...p })),
  { id: 'eyebrow-background', use: 'Eyebrow labels on the page', fg: 'color.brand', bg: pill('color.brand', 'color.background'), state: 'rest', group: 'brand-text', fixable: false },
  { id: 'eyebrow-surface-alt', use: 'Eyebrow labels on alternate sections', fg: 'color.brand', bg: pill('color.brand', 'color.surface-alt'), state: 'rest', group: 'brand-text', fixable: false },
  { id: 'eyebrow-dark', use: 'Eyebrow labels in dark sections', fg: 'color.accent', bg: pill('color.accent', 'color.inverse'), state: 'rest', group: 'dark-accent', fixable: false },
  { id: 'eyebrow-brand', use: 'Eyebrow labels on brand sections', fg: 'color.on-brand', bg: 'color.brand', opacity: 0.8, state: 'rest', group: 'button' },
  { id: 'icon-badge', use: 'Icons in their badges', fg: 'color.brand', bg: { mix: ['color.brand', 12, 'color.surface'] }, state: 'rest', group: 'brand-text', fixable: false, min: 3 },
  { id: 'chosen-option', use: 'The chosen tab or billing period', fg: 'color.brand', bg: { mix: ['color.brand', 10, 'color.background'] }, state: 'rest', group: 'brand-text', fixable: false },
  { id: 'dark-faq', use: 'Questions on their tiles in dark sections', fg: 'color.on-inverse', bg: { mix: ['color.on-inverse', 8, 'color.inverse'] }, state: 'rest', group: 'dark-text' },
  { id: 'chosen-option-surface-alt', use: 'The chosen tab or billing period on alternate sections', fg: 'color.brand', bg: { mix: ['color.brand', 10, 'color.surface-alt'] }, state: 'rest', group: 'brand-text', fixable: false },
  { id: 'outline-edge', use: 'Outlined button edges', fg: 'color.text', bg: 'color.background', opacity: 0.5, state: 'rest', group: 'text', min: 3 },
  { id: 'dark-icon-badge', use: 'Icons in their badges in dark blocks', fg: 'color.accent', bg: { mix: ['color.on-inverse', 10, 'color.inverse'] }, state: 'rest', group: 'dark-accent', fixable: false, min: 3 },
  { id: 'outline-edge-surface-alt', use: 'Outlined button edges on alternate sections', fg: 'color.text', bg: 'color.surface-alt', opacity: 0.5, state: 'rest', group: 'text', min: 3 },
  { id: 'footer-labels', use: 'Footer group labels', fg: 'color.on-inverse', bg: 'color.inverse', opacity: 0.7, state: 'rest', group: 'dark-text' },
  { id: 'outline-edge-brand', use: 'Outlined button edges on brand sections', fg: 'color.on-brand', bg: 'color.brand', opacity: 0.6, state: 'rest', group: 'button', min: 3 },
  { id: 'field-edge', use: 'Form field outlines on the page', fg: 'color.text', bg: 'color.background', opacity: 0.55, state: 'rest', group: 'text', min: 3 },
  { id: 'field-edge-surface-alt', use: 'Form field outlines on alternate sections', fg: 'color.text', bg: 'color.surface-alt', opacity: 0.55, state: 'rest', group: 'text', min: 3 },
  { id: 'footer-labels-light', use: 'Footer group labels in a light footer', fg: 'color.text', bg: 'color.surface-alt', opacity: 0.7, state: 'rest', group: 'text' }
];
