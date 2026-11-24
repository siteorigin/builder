import { SHARED_BASE_CSS } from '../foundation/base.css';

/** The classes the generator gives Signal's Services grid (`so-{definition}__{node}`, `so-{definition}--{axis}-{option}`). */
const FEATURES = 'so-signal-features-grid';
/**
 * The first card of three or more, directly in a Services grid in its default layout. The grid carries its layout
 * option's class itself, so a grid with another layout, or a copy of the section inside this one, is never matched.
 */
const FEATURED = `.${FEATURES}__grid.${FEATURES}--layout-default > li.${FEATURES}__card:first-child:nth-last-child(n + 3)`;

/**
 * Signal's own rules, after the shared base. Buttons are set a little bolder and the filled ones rise on hover; the
 * arrow on a text button travels further; eyebrows in the code sections (form, search, table, video) are the same
 * mono pills as everywhere else; and the Services grid is a bento: its first card spans two columns and two rows on
 * desktop (with its words at the foot of the tall tile) and the full row on tablet. Movement only plays where a
 * pointer hovers and the visitor has not asked for less motion; layout rules apply on screen only, so a printed page
 * keeps the plain grid. Rules that only add something have no specificity, so any style the site sets wins.
 */
const SIGNAL_RULES = `
/* Signal: buttons, eyebrows and the bento Services grid */
.so-btn {
  font-weight: 600; letter-spacing: -0.01em;
  transition: background-color 180ms ease, color 180ms ease, border-color 180ms ease, transform 160ms ease, translate 220ms cubic-bezier(0.2, 0.7, 0.2, 1), box-shadow 220ms ease;
}
@media (hover: hover) and (prefers-reduced-motion: no-preference) {
  :where(:is(a, button):is(.so-btn--primary, .so-btn--light):hover) { translate: 0 -2px; }
}
@media (hover: hover) {
  :is(a, button).so-btn--primary:hover { box-shadow: var(--so-shadow-md); }
}
:is(a, button).so-btn--text:hover::after { transform: translateX(5px); }
:is(a, button).so-btn--text:dir(rtl):hover::after { transform: translateX(-5px); }

:where(.so-form__eyebrow, .so-search__eyebrow, .so-table__eyebrow, .so-video-section__eyebrow) {
  width: fit-content; padding: 5px 12px; border-radius: var(--so-radius-pill);
  background: color-mix(in srgb, currentColor 8%, transparent); border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
}

@media screen and (min-width: 768px) and (max-width: 1023.98px) {
  :where(${FEATURED}) { grid-column: 1 / -1; }
}
@media screen and (min-width: 1024px) {
  :where(${FEATURED}) { grid-column: 1 / -2; grid-row: span 2; }
  /* The tall tile keeps its icon at the top and sets its words at the bottom. The title's own class outweighs the
     reset of heading margins, and any margin the site gives the title (a later rule of the same weight) still wins. */
  :where(${FEATURED}) > .${FEATURES}__card-title { margin-block-start: auto; }
}
`;

/** Signal base stylesheet: the shared reset, defaults and primitives, then Signal's own rules. */
export const SIGNAL_BASE_CSS = `/* Signal theme base styles */
${SHARED_BASE_CSS}${SIGNAL_RULES}`;
