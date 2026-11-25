import { FOUNDATION_BASE_CSS } from '../foundation/base.css';

/** Foundation's base stylesheet (reset, document defaults, surfaces and primitives), with Editorial's own after it. */
const SHARED = FOUNDATION_BASE_CSS.replace('/* Foundation theme base styles */', '/* Editorial theme base styles */');

/**
 * A node of one of Editorial's own components, placed or detached into elements (whose copy keeps the class as
 * `so--d-…`). Exact classes, not endings: another theme's section kept inside a project component (a Foundation
 * services grid with its white cards) must keep its own look.
 */
const own = (component: string, node: string) => `:is(.so-editorial-${component}__${node}, .so--d-editorial-${component}__${node})`;
const featureGrid = own('features-grid', 'grid');
const featureCard = `li${own('features-grid', 'card')}`;

/**
 * Square corners, hairline rules, set-in-capitals buttons and underline hover states. Each rule follows the
 * Foundation rule it changes, at the same weight, so a component's or a placement's own styles still win.
 */
export const EDITORIAL_BASE_CSS = `${SHARED}
/* Editorial: square corners, hairline rules and typographic hover states. */
:focus-visible { border-radius: 0; }
::selection { background: color-mix(in srgb, var(--so-color-brand) 18%, transparent); }

.so-btn:where(:not(.so-btn--text)) { padding: 0.85em 1.5em; font-size: 0.8rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; }
.so-btn { border-radius: var(--so-radius-sm); }
.so-btn--secondary { border-color: currentColor; }
/* The rule thickens on hover: the button's own fill, a gradient included, is left as it is, and with no weight of its
   own, any shadow a design or a page gives the button wins. */
:where(:is(a, button).so-btn--secondary:hover) { box-shadow: inset 0 0 0 1px currentColor; }
.so-btn--text { padding-block: 0.3em; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 0.45em; }
:is(a, button).so-btn--text:hover { text-decoration-thickness: 2px; }

.so-link { text-underline-offset: 0.2em; }
.so-link:hover, .so-rich a:hover { text-decoration-thickness: 2px; }
.so-plain-link:hover { text-decoration-thickness: 1px; text-underline-offset: 0.2em; }
/* The tab chosen, or a choice that is on, keeps the heavier underline that marks it, at rest and under the pointer
   (Foundation's rule, restated after Editorial's own underlines and their hover states, which would otherwise win). */
:is(a, button):is(.so-btn--text, .so-link, .so-plain-link):is([aria-selected='true'], [aria-pressed='true']) { text-decoration-thickness: 3px; }
/* A card that is one link: its title underlines while the pointer is over the card. */
.so-card-link:hover :is(h2, h3, h4) { text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 0.18em; }

.so-rich blockquote { padding-inline-start: 1.25em; border-inline-start: 2px solid currentColor; font-family: var(--so-font-display); font-size: 1.2em; line-height: 1.45; }
.so-rich--check li::before { border-radius: 0; }
.so-rich--bullet li::before { width: 5px; height: 5px; border-radius: 0; }

.so-carousel__step, .so-viewer__close, .so-viewer__step, .so-action--image::after { border-radius: var(--so-radius-sm); }

/* The services grid is a numbered index: each entry opens with its number. The entries sit straight on the section
   (no card), so the colours drawn on them are the section's own. */
:where(${featureCard}) { --so-surface-ink: inherit; --so-surface-ink-text: inherit; --so-surface-ink-hover: inherit; }
${featureGrid} { counter-reset: so-index; }
${featureCard} { counter-increment: so-index; }
${featureCard}::before {
  content: counter(so-index, decimal-leading-zero);
  content: counter(so-index, decimal-leading-zero) / '';
  font-family: var(--so-font-display); font-size: 1.75rem; line-height: 1; font-variant-numeric: lining-nums tabular-nums;
  color: var(--so-surface-ink, var(--so-color-brand));
}

/* An index section (a narrow heading column beside a wide one) gives the whole row to a column left on its own. */
:is(${own('faq-list', 'list')}, ${own('content-text', 'heading')}, ${own('content-text', 'body')}):only-child { grid-column: 1 / -1; }
`;
