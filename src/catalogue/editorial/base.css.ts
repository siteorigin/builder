import { FOUNDATION_BASE_CSS, ends } from '../foundation/base.css';

/** Foundation's base stylesheet (reset, document defaults, surfaces and primitives), with Editorial's own after it. */
const SHARED = FOUNDATION_BASE_CSS.replace('/* Foundation theme base styles */', '/* Editorial theme base styles */');

const featureGrid = ends('-features-grid__grid');
const featureCard = `li${ends('-features-grid__card')}`;

/**
 * Square corners, hairline rules, set-in-capitals buttons and underline hover states. Each rule follows the
 * Foundation rule it changes, at the same weight, so a component's or a placement's own styles still win.
 */
export const EDITORIAL_BASE_CSS = `${SHARED}
/* Editorial: square corners, hairline rules and typographic hover states. */
:focus-visible { border-radius: 0; }
::selection { background: color-mix(in srgb, var(--so-color-brand) 18%, transparent); }

.so-btn:not(.so-btn--text) { padding: 0.85em 1.5em; font-size: 0.8rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; }
.so-btn { border-radius: var(--so-radius-sm); }
.so-btn--primary { box-shadow: none; }
.so-btn--secondary { border-color: currentColor; }
:is(a, button).so-btn--secondary:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.so-btn--text { padding-block: 0.3em; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 0.45em; }
:is(a, button).so-btn--text:hover { text-decoration-thickness: 2px; }

.so-link { text-underline-offset: 0.2em; }
.so-link:hover, .so-rich a:hover { text-decoration-thickness: 2px; }
.so-plain-link:hover { text-decoration-thickness: 1px; text-underline-offset: 0.2em; }
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
:is(${ends('-faq-list__list')}, ${ends('-content-text__heading')}, ${ends('-content-text__body')}):only-child { grid-column: 1 / -1; }
`;
