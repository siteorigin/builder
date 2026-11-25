/** A class ending in `suffix` anywhere in an element's class list (a component's scoped class may follow it). */
const ends = (suffix: string) => `:is([class$='${suffix}'], [class*='${suffix} '])`;

/** The brand panel of a Call to action, in the panel's own tone. */
const ctaPanel = (tone: string) => `${ends(`-cta-banner--tone-${tone}`)} ${ends('-cta-banner__panel')}`;

/**
 * Where a section paints a dark or brand ground, the colours drawn straight on it (focus rings, links, text buttons,
 * check marks and the primary button's fill) switch to the ground's own text colour, which the theme keeps readable
 * there. Sections and the light cards inside them start afresh, so a white card in a dark section keeps the theme's
 * colours. The cards are known by their list-item part names (features and testimonials cards, pricing plans,
 * contact methods), which a copy of the section keeps, in the part class the generator writes first; the sections'
 * transparent listing cards are not list items, and a code component's own list items keep the ground's colours.
 * A part a tone styles carries the tone's class as well as the section root, so the parts inside a Call to action's
 * panel (its button, its supporting text) are not started afresh: they keep the panel's colours.
 * All three lists match with no specificity, in this order: light, dark, brand.
 */
const SURFACES = `:where(
  [class*='--tone-']:not(${ends('-cta-banner__panel')} *), li[class^='so-']:is(${ends('__card')}, ${ends('__plan')}, ${ends('__method')}),
  .so-header, .so-form, .so-search, .so-table, .so-video-section, .so-overlay
) { --so-surface-ink: initial; --so-surface-ink-text: initial; --so-surface-ink-hover: initial; }
:where(
  ${ends('--tone-inverse')}:not(${ends('-cta-banner__root')}), ${ctaPanel('inverse')}, ${ends('-shell-footer--tone-default')},
  .so-header--inverse, .so-form--inverse, .so-search--inverse, .so-table--inverse, .so-video-section--inverse
) {
  --so-surface-ink: var(--so-color-on-inverse);
  --so-surface-ink-text: var(--so-color-inverse);
  --so-surface-ink-hover: color-mix(in srgb, var(--so-color-on-inverse) 88%, var(--so-color-inverse));
}
:where(${ends('--tone-brand')}, ${ctaPanel('default')}) {
  --so-surface-ink: var(--so-color-on-brand);
  --so-surface-ink-text: var(--so-color-brand-strong);
  --so-surface-ink-hover: color-mix(in srgb, var(--so-color-on-brand) 88%, var(--so-color-brand));
}`;

/**
 * The Services grid's pinned heading beside its cards (its "sticky-split" layout, whose class the styled elements carry
 * too), and Steps with pictures' two columns, known by its own layout element and the columns directly inside it (no
 * :has(), so every browser that prints a site applies them).
 */
const PINNED = ends('--layout-sticky-split');
const PINNED_SPLIT = `${PINNED}${ends('__inner')}`;
const PINNED_HEADING = `${PINNED}${ends('__intro')}`;
const STEPS_LAYOUT = ends('__steps-layout');

/**
 * The reset, document defaults and primitive styles every built-in theme shares: the buttons, links and check lists,
 * the colours drawn on dark and brand grounds, the image viewer, the carousel controls, reduced motion and print.
 * A theme's stylesheet starts with its own title line, then this, then any rules of its own.
 */
export const SHARED_BASE_CSS = `*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; scroll-behavior: smooth; }
/* A placement's styles for a code component are important; ":not(#so-motion)" (an id no element has) gives the
   reduced-motion rule an id's weight, so it still wins over them. */
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } :not(#so-motion), :not(#so-motion)::before, :not(#so-motion)::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; } }
body {
  margin: 0;
  background: var(--so-color-background);
  color: var(--so-color-text);
  font-family: var(--so-font-body);
  font-size: var(--so-text-body-size);
  line-height: var(--so-text-body-line-height);
  /* A word wider than its box (a display heading or an email address at a visitor's enlarged text size) breaks
     instead of pushing the page sideways. Unlike break-word, anywhere also lets flex and fit-content boxes
     shrink below that word. Text that fits wraps exactly as before. */
  overflow-wrap: anywhere;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}
h1, h2, h3, h4, h5, h6, p, figure, blockquote, dl, dd { margin: 0; }
h1, h2, h3, h4, h5, h6 { font-weight: inherit; font-size: inherit; text-wrap: balance; }
p { text-wrap: pretty; }
ul, ol { margin: 0; padding: 0; list-style: none; }
img, svg { display: block; max-width: 100%; }
a { color: inherit; }
/* A phone number or email address keeps its own order inside right-to-left text: what the link says decides which
   way it runs, so "+1 555 0134" reads left to right while an Arabic "Call us" still reads right to left. */
a:is([href^='tel:' i], [href^='mailto:' i]) { unicode-bidi: plaintext; }
address, cite { font-style: normal; }
/* Jump links land 1rem below the sticky site header instead of under it. The header publishes the height it
   occupies (0 when it does not stick); before it has, the default assumes one 72px row. */
[id] { scroll-margin-top: calc(var(--so-header-offset, 4.5rem) + 1rem); }
/* Dark and brand sections set the colours drawn on them (--so-surface-ink and its pair); elsewhere the theme's own apply. */
${SURFACES}
:focus-visible { outline: 2px solid var(--so-surface-ink, var(--so-color-focus)); outline-offset: 3px; border-radius: 4px; }
::selection { background: color-mix(in srgb, var(--so-color-brand) 22%, transparent); }

/* Moved up by its own height, so it stays out of sight at any text size until it is focused. */
.so-skip-link { position: absolute; inset-inline-start: 12px; top: 12px; transform: translateY(calc(-100% - 12px)); z-index: 100; padding: 10px 16px; border-radius: var(--so-radius-sm); background: var(--so-color-text); color: var(--so-color-background); text-decoration: none; }
.so-skip-link:focus { transform: none; }

.so-rich > * + * { margin-top: 1em; }
/* Inline links take the surrounding text colour, so they stay readable on every section tone. */
.so-rich a { color: inherit; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }
.so-rich h3 { font-family: var(--so-text-h3-family); font-size: var(--so-text-h3-size); line-height: var(--so-text-h3-line-height); font-weight: var(--so-text-h3-weight); letter-spacing: var(--so-text-h3-tracking); }
.so-rich h4 { font-size: 1.05em; font-weight: 600; }
.so-rich blockquote { padding-inline-start: 1em; border-inline-start: 3px solid color-mix(in srgb, currentColor 28%, transparent); }
.so-rich--number { padding-inline-start: 1.5em; list-style: decimal; display: grid; gap: 0.65em; }
.so-rich--number > * + * { margin-top: 0; }

.so-link { color: var(--so-surface-ink, var(--so-color-brand)); background: var(--so-btn-bg, none); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }

.so-plain-link { background: var(--so-btn-bg, none); text-decoration: none; }
.so-plain-link:hover { text-decoration: underline; text-underline-offset: 3px; }
/* A button that changes what a component shows (a tab, a disclosure) while looking like a link. */
:where(button:is(.so-link, .so-plain-link)) { padding: 0; border: 0; font: inherit; text-align: inherit; cursor: pointer; }
:where(button.so-plain-link) { color: inherit; }
/* A link's icon beside its label. Buttons space it with their own gap; text links (and a link left without a
   destination, shown as plain text) sit it on the line with a margin. */
:not(.so-btn) > .so-link__icon { display: inline-block; vertical-align: -0.18em; }
:not(.so-btn) > .so-link__icon--start { margin-inline-end: 0.35em; }
:not(.so-btn) > .so-link__icon--end { margin-inline-start: 0.35em; }
/* A whole card as one link: it keeps the card's own layout and colours (any rule on the card wins). */
:where(.so-card-link) { display: block; color: inherit; text-decoration: none; }
/* A thumbnail that opens full size (a gallery photo): a badge in its corner says so, on touch screens too. */
.so-action--image { position: relative; cursor: zoom-in; }
.so-action--image::after {
  content: ''; position: absolute; inset-block-start: 0.6rem; inset-inline-end: 0.6rem; width: 2.25rem; height: 2.25rem; border-radius: 50%;
  background: rgb(15 15 18 / 0.6) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7'/%3E%3C/svg%3E") center / 1.05rem no-repeat;
  pointer-events: none; transition: background-color 160ms ease;
}
.so-action--image:hover::after { background-color: rgb(15 15 18 / 0.82); }

/* A component's dialog or drawer (where each one sits is the generated components stylesheet's): the page's own
   colours and type on a raised surface over a dimmed page, whatever section it sits in (see SURFACES). A drawer runs to
   the screen's edge, so only a dialog is rounded. A component's own styles for it win. */
.so-overlay {
  padding: var(--so-space-lg); border: 0; border-radius: var(--so-radius-md);
  background: var(--so-color-background); color: var(--so-color-text); box-shadow: var(--so-shadow-lg);
}
.so-overlay:where(.so-overlay--drawer-start, .so-overlay--drawer-end, .so-overlay--drawer-bottom) { border-radius: 0; }
.so-overlay::backdrop { background: rgb(12 12 14 / 0.55); }

/* The full-size image viewer: the whole screen, the image as large as it fits, and Close and the arrows in easy reach.
   The page behind it does not scroll while it is open. */
html:has(.so-viewer[open]) { overflow: hidden; }
.so-viewer {
  width: 100%; max-width: none; height: 100%; height: 100dvh; max-height: none; margin: 0; padding: 0.75rem;
  border: 0; background: rgb(12 12 14 / 0.94); color: #f4f4f5; font-family: var(--so-font-body);
}
.so-viewer[open] { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; gap: 0.5rem; }
.so-viewer::backdrop { background: rgb(0 0 0 / 0.5); }
.so-viewer__close, .so-viewer__step {
  display: grid; place-items: center; width: 2.75rem; height: 2.75rem; padding: 0; border: 0; border-radius: 50%;
  background: rgb(255 255 255 / 0.12); color: inherit; cursor: pointer;
}
.so-viewer__close { justify-self: end; }
.so-viewer__close:hover, .so-viewer__step:hover { background: rgb(255 255 255 / 0.24); }
.so-viewer svg { width: 1.4rem; height: 1.4rem; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.so-viewer :focus-visible { outline-color: #fff; }
.so-viewer__figure { display: grid; grid-template-rows: minmax(0, 1fr) auto; place-items: center; gap: 0.75rem; min-height: 0; }
.so-viewer__img { width: auto; height: auto; max-width: 100%; max-height: 100%; object-fit: contain; }
.so-viewer__caption { max-width: 60ch; max-height: 25vh; overflow-y: auto; text-align: center; font-size: 0.95rem; line-height: 1.5; color: rgb(244 244 245 / 0.86); }
.so-viewer__nav { display: flex; align-items: center; justify-content: center; gap: 1.25rem; }
/* Previous sits at the start of the row: right to left, its arrow and Next's point the other way. */
.so-viewer__step:dir(rtl) svg { transform: scaleX(-1); }
.so-viewer__count { min-width: 4.5em; text-align: center; font-size: 0.9rem; font-variant-numeric: tabular-nums; }
@media (min-width: 768px) { .so-viewer { padding: 1.5rem; } }

/* A carousel's count of the slides showing, and its Previous and Next buttons, in the colours of the ground they sit on. */
.so-carousel__status { font-size: var(--so-text-small-size); line-height: var(--so-text-small-line-height); }
.so-carousel__step {
  display: grid; place-items: center; width: 2.75rem; height: 2.75rem; padding: 0; border-radius: 50%;
  border: 1px solid color-mix(in srgb, currentColor 28%, transparent); background: none; color: var(--so-surface-ink, currentColor);
  transition: border-color 160ms ease, background-color 160ms ease;
}
.so-carousel__step:not([aria-disabled='true']):hover { border-color: currentColor; background: color-mix(in srgb, currentColor 8%, transparent); }

/* A list's category filter: a row of pills above its items, the one chosen filled in. Disabled until the page's script
   runs, they look the same, so nothing moves when they start working. */
.so-filter { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-block-end: var(--so-space-lg); }
.so-filter__pill {
  display: inline-flex; align-items: center; min-height: 2.5rem; padding: 0.35em 1.1em; border-radius: var(--so-radius-pill);
  border: 1px solid color-mix(in srgb, currentColor 28%, transparent); background: none; color: inherit; font: inherit;
  font-size: var(--so-text-small-size); line-height: var(--so-text-small-line-height); cursor: pointer;
  transition: border-color 160ms ease, background-color 160ms ease, color 160ms ease;
}
.so-filter__pill:disabled { cursor: default; }
.so-filter__pill:not([aria-pressed='true']):not(:disabled):hover { border-color: currentColor; }
.so-filter__pill[aria-pressed='true'] {
  border-color: var(--so-surface-ink, var(--so-color-brand)); background: var(--so-surface-ink, var(--so-color-brand)); color: var(--so-surface-ink-text, var(--so-color-on-brand));
}

.so-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.5em;
  min-height: 46px; padding: 0.7em 1.35em;
  border: 1px solid transparent; border-radius: var(--so-radius-pill);
  font-family: var(--so-font-body); font-size: 0.97rem; font-weight: 550; line-height: 1.2; letter-spacing: -0.005em;
  text-align: center; text-decoration: none; cursor: pointer;
  background: var(--so-btn-bg, transparent); color: var(--so-btn-fg, currentColor);
  transition: background-color 160ms ease, color 160ms ease, border-color 160ms ease, transform 160ms ease, box-shadow 160ms ease;
}
/* A button is as wide as its label and padding. Left to stretch, a button placed straight into a stack, a section or a
   grid fills the whole row. Only the width is set, so a parent's centring or end alignment still places it. Zero
   specificity: any Width the page sets, at any size, wins wherever it sits in the cascade. The header's call to
   action is left to its own menu layout, which stretches it across the phone menu. */
:where(.so-btn:not(.so-header__cta)) { width: fit-content; }
/* Colours come from --so-btn-bg / --so-btn-fg, which the generator sets wherever a button's colours are styled
   (resetting --so-btn-bg-hover), so the hover state follows the colour actually shown. */
:is(a, button).so-btn:active { transform: translateY(1px); }
.so-btn--primary {
  --so-btn-bg: var(--so-surface-ink, var(--so-color-brand)); --so-btn-fg: var(--so-surface-ink-text, var(--so-color-on-brand));
  --so-btn-bg-hover: var(--so-surface-ink-hover, var(--so-color-brand-strong)); box-shadow: var(--so-shadow-sm);
}
:is(a, button).so-btn--primary:hover { background: var(--so-btn-bg-hover, color-mix(in srgb, var(--so-btn-bg) 84%, #000)); }
.so-btn--secondary { border-color: color-mix(in srgb, currentColor 28%, transparent); }
:is(a, button).so-btn--secondary:hover { border-color: currentColor; }
.so-btn--text { min-height: 0; padding: 0.2em 0; border-radius: 0; --so-btn-fg: var(--so-surface-ink, var(--so-color-brand)); background: none; }
.so-btn--text::after { content: '→'; transition: transform 160ms ease; }
:is(a, button).so-btn--text:hover::after { transform: translateX(3px); }
/* Right to left, the arrow points the way the text runs and moves that way. */
.so-btn--text:dir(rtl)::after { content: '←'; }
:is(a, button).so-btn--text:dir(rtl):hover::after { transform: translateX(-3px); }
.so-btn--light { --so-btn-bg: var(--so-color-on-brand); --so-btn-fg: var(--so-color-brand-strong); --so-btn-bg-hover: color-mix(in srgb, var(--so-color-on-brand) 88%, var(--so-color-brand)); }
:is(a, button).so-btn--light:hover { background: var(--so-btn-bg-hover, color-mix(in srgb, var(--so-btn-bg) 88%, var(--so-btn-fg))); }
/* The tab chosen, or a choice that is on, is marked by more than its state: its border, an inner ring on a filled
   button, a heavier underline on a text button or link. After the buttons' own rules, which they
   would otherwise lose to; a component's own styles for it still win. */
.so-btn--secondary:where([aria-selected='true'], [aria-pressed='true']) { border-color: currentColor; background: color-mix(in srgb, currentColor 10%, var(--so-btn-bg, transparent)); }
:is(.so-btn--primary, .so-btn--light):where([aria-selected='true'], [aria-pressed='true']) { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--so-btn-fg, currentColor) 72%, transparent); }
:is(.so-btn--text, .so-link, .so-plain-link):where([aria-selected='true'], [aria-pressed='true']) { text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 5px; }

.so-img { width: 100%; height: auto; object-fit: cover; }
.so-img--placeholder {
  display: grid; place-items: center; width: 100%; min-height: 160px; aspect-ratio: 4 / 3;
  background:
    radial-gradient(120% 80% at 20% 10%, color-mix(in srgb, var(--so-color-brand) 18%, transparent), transparent 60%),
    radial-gradient(90% 70% at 90% 100%, color-mix(in srgb, var(--so-color-accent) 22%, transparent), transparent 60%),
    var(--so-color-surface-alt);
  color: color-mix(in srgb, var(--so-color-text) 40%, transparent);
}
.so-img--placeholder svg { width: 36px; height: 36px; opacity: 0.55; }

.so-icon { width: 1.25em; height: 1.25em; flex: none; }
.so-divider { border: 0; border-top: 1px solid var(--so-color-border); margin: 0; width: 100%; }

.so-rich--check, .so-rich--bullet { display: grid; gap: 0.65em; }
.so-rich--check > * + *, .so-rich--bullet > * + * { margin-top: 0; }
.so-rich--check li { position: relative; padding-inline-start: 1.75em; }
.so-rich--check li::before {
  content: ''; position: absolute; inset-inline-start: 0; top: 0.32em; width: 1.05em; height: 1.05em; border-radius: 50%;
  background: color-mix(in srgb, var(--so-surface-ink, var(--so-color-brand)) 14%, transparent);
  -webkit-mask: none;
}
.so-rich--check li::after {
  content: ''; position: absolute; inset-inline-start: 0.33em; top: 0.52em; width: 0.38em; height: 0.6em;
  border: solid var(--so-surface-ink, var(--so-color-brand)); border-width: 0 2px 2px 0; transform: rotate(45deg);
}
.so-rich--bullet li { position: relative; padding-inline-start: 1.25em; }
.so-rich--bullet li::before { content: ''; position: absolute; inset-inline-start: 0.2em; top: 0.7em; width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: 0.6; }

details > summary { list-style: none; cursor: pointer; }
details > summary::-webkit-details-marker { display: none; }
details > summary .so-icon { transition: transform 200ms ease; }
details[open] > summary .so-icon { transform: rotate(45deg); }

.so-visually-hidden { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

.so-container { width: 100%; max-width: calc(var(--so-container-content) + 2 * var(--so-container-gutter)); margin-inline: auto; padding-inline: var(--so-container-gutter); }

/* A Services grid with its heading pinned beside the cards, whose heading was cleared, gives the cards the whole row. */
${PINNED_SPLIT}:has(> ${ends('__grid')}):not(:has(> ${ends('__intro')})) { grid-template-columns: minmax(0, 1fr); }

/* Printed, a page is a handout. */
@media print {
  /* Colours print as designed. Without their backgrounds, light text on a dark band (the footer, a dark section,
     a button) would print pale grey on white. */
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  /* Every disclosure prints its content without being opened, so the questions a visitor opened are still the
     ones open after printing, or after cancelling the print dialog. */
  details::details-content { content-visibility: visible; display: block; }
  /* The FAQ's open/close icon, in any copy of it (whose classes start differently). An icon of an author's own
     that tells something stays. */
  details > summary :is([class$='__toggle-icon'], [class*='__toggle-icon ']) { display: none; }
  /* Controls that only work on screen: submit and reset buttons (a button whose label is content, such as an
     address it copies, stays), the skip link, the menu button and phone menu, and the contact form's actions and
     service messages. Components' own (scoped) styles show some of them, hence !important, and a placement's styles
     for a code component are important too, hence the weight of an id no element has (":not(#so-print)"). */
  :is(:is(button, input):is([type='submit'], [type='reset']), form button:not([type]),
  .so-skip-link, .so-header__menu, .so-header__toggle, .so-header__nav, .so-form__actions, .so-form__messages, .so-form__trap, .so-viewer):not(#so-print) { display: none !important; }
  .so-action--image::after { display: none; }
  .so-header:not(#so-print) { position: static !important; }
  /* A component's tabs print every panel (the generated rule hiding the others applies on screen only), each under
     its tab's label, so the row of tabs is left out. */
  .so-tablist:not(#so-print) { display: none !important; }
  [role='tabpanel'][data-tab-label]:not([data-tab-label=''])::before {
    content: attr(data-tab-label); display: block; grid-column: 1 / -1; flex-basis: 100%;
    margin-block-end: 0.5em; font-weight: 600;
  }
  [role='tabpanel'] + [role='tabpanel'] { margin-block-start: 1.5em; }
  /* What stays in view on screen while content beside it scrolls (a section's heading beside its cards, steps beside
     their picture) prints in its place, the columns one after the other, however wide the sheet: in any copy of the
     section, by the option's and the elements' class endings. */
  ${PINNED_SPLIT}:not(#so-print), ${STEPS_LAYOUT}:not(#so-print) { grid-template-columns: minmax(0, 1fr) !important; }
  ${PINNED_HEADING}:not(#so-print) { position: static !important; inset: auto !important; }
  ${STEPS_LAYOUT} > ${ends('__media-stage')}:not(#so-print) { position: static !important; inset: auto !important; }
  ${STEPS_LAYOUT} > ${ends('__steps-stage')}:not(#so-print) { order: 0 !important; }
  /* Where the sheet has room: a heading, or a section's heading group (eyebrow, heading and lead, in any copy of
     the section), stays with what follows it, and short units (a plan, a contact method, a question and its
     answer, a gallery image and its caption, the contact form) stay whole. */
  h1, h2, h3, h4, h5, h6, summary, :is([class$='__intro'], [class*='__intro ']) { break-after: avoid; break-inside: avoid; }
  li, details, figure, .so-form__inner, .so-form__form, .so-form__field { break-inside: avoid; }
}
`;

/** Foundation base stylesheet: reset, document defaults and shared primitive styles. */
export const FOUNDATION_BASE_CSS = `/* Foundation theme base styles */
${SHARED_BASE_CSS}`;
