import { SHARED_BASE_CSS } from '../foundation/base.css';

/** A class ending in `suffix` anywhere in an element's class list (a part's override class may follow it). */
const ends = (suffix: string) => `:is([class$='${suffix}'], [class*='${suffix} '])`;
/**
 * A Services grid in its default layout, laid out as a bento. Signal's grid node is called `bento`, a name no
 * Foundation design has, and a copy of the section (Make unique) keeps it, so the layout follows the copy. The grid
 * carries its layout option's class itself, so a grid with another layout, or a section placed inside this one, is
 * never matched.
 */
const BENTO = `${ends('__bento')}${ends('--layout-default')}`;
/** The featured first card of three or more. */
const FEATURED = `${BENTO} > li:first-child:nth-last-child(n + 3)`;
/**
 * A part of the featured card, weighed as two classes: more than the card's own node style (one class), so the tile's
 * larger type wins over it, and the same as a site's override of that part, which comes later and so still wins.
 */
const featuredPart = (suffix: string) => `:where(${FEATURED}) > ${ends(suffix)}${ends(suffix)}`;

/**
 * Signal's own rules, after the shared base. Buttons are set a little bolder and the filled ones rise on hover; the
 * arrow on a text button travels further; a chosen tab or billing period is marked in the brand colour; an outlined
 * button's edge is drawn firmly enough to find; eyebrows in the code sections (form, search, table, video) are the same
 * mono pills as everywhere else; a card that is one link lifts under the pointer (a card that only holds a link does
 * not: the link itself answers); and the Services grid is a bento whose cards fill their rows at any count. Movement only
 * plays where a pointer hovers and the visitor has not asked for less motion; layout rules apply on screen only, so a
 * printed page keeps the plain grid. Rules that only add something have no specificity, so any style the site sets wins.
 */
const SIGNAL_RULES = `
/* Signal: buttons, eyebrows and the bento Services grid */
/* Signal's light tiles carry their section's tone class (a soft section turns them white), so a dark or brand tone
   would otherwise set the ground's light ink on them: they start afresh after the tone rules, as Foundation's do. */
:where(li[class^='so-']:is(${ends('__card')}, ${ends('__plan')}, ${ends('__method')}, ${ends('__step')})) { --so-surface-ink: initial; --so-surface-ink-text: initial; --so-surface-ink-hover: initial; }
.so-btn {
  font-weight: 600; letter-spacing: -0.01em;
  transition: background-color 180ms ease, color 180ms ease, border-color 180ms ease, transform 160ms ease, translate 220ms cubic-bezier(0.2, 0.7, 0.2, 1), box-shadow 220ms ease;
}
/* An outlined button's edge is the only outline of what it does: half its own ink, firm enough to find on every light
   ground, and its whole ink on a brand section, where the button text's own pair on the brand keeps it readable for any
   brand. (Two classes heavy there, as a site's own border for the button is, which comes later and so still wins.) */
.so-btn--secondary { border-color: color-mix(in srgb, currentColor 50%, transparent); }
.so-btn--secondary:is([class*='--tone-brand'], [class*='--tone-brand'] *) { border-color: currentColor; }
/* The tab chosen, or the billing period that is on, in the brand colour (its section's ink on a dark or brand ground),
   on the eyebrow pill's 8% tint (so the pill's contrast pairs answer for it too), and ringed twice as heavily as its
   neighbours, so it is told apart without its colour. */
.so-btn--secondary:where([aria-selected='true'], [aria-pressed='true']) {
  --so-btn-fg: var(--so-surface-ink, var(--so-color-brand)); color: var(--so-btn-fg);
  border-color: currentColor; background: color-mix(in srgb, currentColor 8%, transparent); box-shadow: inset 0 0 0 1px currentColor;
}
/* Only a button that acts rises: a link with somewhere to go, or a button that is not disabled. */
@media (hover: hover) and (prefers-reduced-motion: no-preference) {
  :where(:is(a[href], button:not(:disabled)):not([aria-disabled='true']):is(.so-btn--primary, .so-btn--light):hover) { translate: 0 -2px; }
}
/* One class of weight, like the resting shadow it replaces, so a shadow the site sets on the button wins; a chosen tab
   or a choice that is on keeps the inner ring that marks it. */
@media (hover: hover) {
  .so-btn--primary:where(:is(a[href], button:not(:disabled)):not([aria-disabled='true']):hover:not([aria-selected='true'], [aria-pressed='true'])) { box-shadow: var(--so-shadow-md); }
  /* A card that is one link rises under the pointer; its shadow, never its place, unless motion is welcome. */
  :where(.so-card-link) { transition: box-shadow 220ms ease, translate 220ms cubic-bezier(0.2, 0.7, 0.2, 1); }
  :where(.so-card-link:hover) { box-shadow: var(--so-shadow-md); }
}
@media (hover: hover) and (prefers-reduced-motion: no-preference) {
  :is(a, button).so-btn--text:hover::after { transform: translateX(5px); }
  :is(a, button).so-btn--text:dir(rtl):hover::after { transform: translateX(-5px); }
  :where(.so-card-link:hover) { translate: 0 -2px; }
}
/* Without a pointer that hovers, or for a visitor who asked for less motion, a text button's arrow (either way it
   points) and a pressed button stay where they are. */
@media (hover: none), (prefers-reduced-motion: reduce) {
  :is(a, button).so-btn--text:hover::after, :is(a, button).so-btn--text:dir(rtl):hover::after { transform: none; }
  :is(a, button).so-btn:active { transform: none; }
}
/* A button that cannot act keeps its colours under the pointer. */
:is(button:disabled, [aria-disabled='true'], a:not([href])):is(.so-btn--primary, .so-btn--light):hover { background: var(--so-btn-bg); }

/* A step's title is a button that opens it: a plus at its end says so before any hover, and a minus marks the step
   that is open, as the FAQ's questions do. Drawn in the brand colour on the step's white ground. */
:where([class*='__step-trigger'][aria-expanded]) { position: relative; padding-inline-end: 2em; }
:where([class*='__step-trigger'][aria-expanded])::after { content: '+'; content: '+' / ''; position: absolute; inset-inline-end: 0; inset-block-start: 50%; translate: 0 -50%; color: var(--so-color-brand); font-size: 1.25em; line-height: 1; }
:where([class*='__step-trigger'][aria-expanded='true'])::after { content: '−'; content: '−' / ''; }

/* A table's column headings are labels, set like every other label in Signal: mono capitals. */
:where(.so-table__table thead th) {
  font-family: var(--so-text-eyebrow-family); font-size: var(--so-text-eyebrow-size); font-weight: var(--so-text-eyebrow-weight);
  letter-spacing: var(--so-text-eyebrow-tracking); text-transform: uppercase;
}
:where(.so-form__eyebrow, .so-search__eyebrow, .so-table__eyebrow, .so-video-section__eyebrow) {
  width: fit-content; padding: 5px 12px; border-radius: var(--so-radius-pill);
  background: color-mix(in srgb, currentColor 8%, transparent); border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
}

/* A Services grid with its heading pinned beside the cards, whose heading was cleared, gives the cards the whole row
   (Foundation's rule, for Signal's grid, which is called the bento). */
${ends('--layout-sticky-split')}${ends('__inner')}:has(> ${ends('__bento')}):not(:has(> ${ends('__intro')})) { grid-template-columns: minmax(0, 1fr); }

/* The bento. Tablet (two columns): the featured card takes the whole first row, and a card left alone on the last row
   takes that row too. */
@media screen and (min-width: 768px) and (max-width: 1023.98px) {
  :where(${BENTO} > li:only-child) { grid-column: 1 / -1; }
  :where(${FEATURED}) { grid-column: 1 / -1; }
  :where(${BENTO} > li:nth-child(even):nth-child(n + 4):last-child) { grid-column: 1 / -1; }
}
/* Desktop (three columns): the featured card spans two columns and two rows beside the next two cards, and the cards
   after them run in rows of three. Whatever count is given, no row is left with a hole: one card takes the row, two
   share it two to one, and a last row of one or two widens the same way. Spans run between the grid's own lines, so a
   grid a site sets to fewer columns gains no extra track. */
@media screen and (min-width: 1024px) {
  :where(${BENTO} > li:only-child) { grid-column: 1 / -1; }
  :where(${BENTO} > li:first-child:nth-last-child(2)) { grid-column: 1 / -2; }
  :where(${FEATURED}) { grid-column: 1 / -2; grid-row: span 2; }
  :where(${BENTO} > li:nth-child(3n + 4):last-child) { grid-column: 1 / -1; }
  :where(${BENTO} > li:nth-child(3n + 4):nth-last-child(2)) { grid-column: 1 / -2; }

  /* The featured card is a poster for the first offer: its larger badge, then the title and description set large just
     beneath it, its link straight after them, and in the corner they leave a brand disc with a ring around it, one
     geometric figure scaled to the card. */
  :where(${FEATURED}) { position: relative; overflow: clip; justify-content: flex-start; }
  :where(${FEATURED})::before {
    content: ''; position: absolute; inset-block-end: -28%; inset-inline-end: -8%; width: 46%; aspect-ratio: 1;
    border-radius: 50%; pointer-events: none;
    background: radial-gradient(closest-side, color-mix(in srgb, var(--so-color-brand) 13%, transparent) 0 70%, transparent 70.5% 81%, color-mix(in srgb, var(--so-color-brand) 22%, transparent) 81.5% 82.5%, transparent 83%);
  }
  :where(${FEATURED}) > * { position: relative; }
  ${featuredPart('__card-icon-wrap')} { width: 64px; min-height: 64px; font-size: 1.7rem; }
  ${featuredPart('__card-title')} { font-size: clamp(1.5rem, 1.05rem + 0.9vw, 2rem); line-height: 1.15; letter-spacing: -0.025em; margin-block-start: var(--so-space-xl); }
  ${featuredPart('__card-text')} { max-width: min(36ch, 54%); font-size: var(--so-text-lead-size); line-height: var(--so-text-lead-line-height); }
  ${featuredPart('__card-link')} { margin-block-start: var(--so-space-xs); }
}
`;

/** Signal base stylesheet: the shared reset, defaults and primitives, then Signal's own rules. */
export const SIGNAL_BASE_CSS = `/* Signal theme base styles */
${SHARED_BASE_CSS}${SIGNAL_RULES}`;
