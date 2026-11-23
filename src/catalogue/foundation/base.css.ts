/** Foundation base stylesheet: reset, document defaults and shared primitive styles. */
export const FOUNDATION_BASE_CSS = `/* Foundation theme base styles */
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; } }
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
address, cite { font-style: normal; }
/* Jump links land 1rem below the sticky site header instead of under it. The header publishes the height it
   occupies (0 when it does not stick); before it has, the default assumes one 72px row. */
[id] { scroll-margin-top: calc(var(--so-header-offset, 4.5rem) + 1rem); }
:focus-visible { outline: 2px solid var(--so-color-focus); outline-offset: 3px; border-radius: 4px; }
::selection { background: color-mix(in srgb, var(--so-color-brand) 22%, transparent); }

/* Moved up by its own height, so it stays out of sight at any text size until it is focused. */
.so-skip-link { position: absolute; left: 12px; top: 12px; transform: translateY(calc(-100% - 12px)); z-index: 100; padding: 10px 16px; border-radius: var(--so-radius-sm); background: var(--so-color-text); color: var(--so-color-background); text-decoration: none; }
.so-skip-link:focus { transform: none; }

.so-rich > * + * { margin-top: 1em; }
/* Inline links take the surrounding text colour, so they stay readable on every section tone. */
.so-rich a { color: inherit; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }
.so-rich h3 { font-family: var(--so-text-h3-family); font-size: var(--so-text-h3-size); line-height: var(--so-text-h3-line-height); font-weight: var(--so-text-h3-weight); letter-spacing: var(--so-text-h3-tracking); }
.so-rich h4 { font-size: 1.05em; font-weight: 600; }
.so-rich blockquote { padding-inline-start: 1em; border-inline-start: 3px solid color-mix(in srgb, currentColor 28%, transparent); }
.so-rich--number { padding-inline-start: 1.5em; list-style: decimal; display: grid; gap: 0.65em; }
.so-rich--number > * + * { margin-top: 0; }

.so-link { color: var(--so-color-brand); background: var(--so-btn-bg, none); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }

.so-plain-link { background: var(--so-btn-bg, none); text-decoration: none; }
.so-plain-link:hover { text-decoration: underline; text-underline-offset: 3px; }

.so-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.5em;
  min-height: 46px; padding: 0.7em 1.35em;
  border: 1px solid transparent; border-radius: var(--so-radius-pill);
  font-family: var(--so-font-body); font-size: 0.97rem; font-weight: 550; line-height: 1.2; letter-spacing: -0.005em;
  text-align: center; text-decoration: none; cursor: pointer;
  background: var(--so-btn-bg, transparent); color: var(--so-btn-fg, currentColor);
  transition: background-color 160ms ease, color 160ms ease, border-color 160ms ease, transform 160ms ease, box-shadow 160ms ease;
}
/* Colours come from --so-btn-bg / --so-btn-fg, which the generator sets wherever a button's colours are styled
   (resetting --so-btn-bg-hover), so the hover state follows the colour actually shown. */
:is(a, button).so-btn:active { transform: translateY(1px); }
.so-btn--primary { --so-btn-bg: var(--so-color-brand); --so-btn-fg: var(--so-color-on-brand); --so-btn-bg-hover: var(--so-color-brand-strong); box-shadow: var(--so-shadow-sm); }
:is(a, button).so-btn--primary:hover { background: var(--so-btn-bg-hover, color-mix(in srgb, var(--so-btn-bg) 84%, #000)); }
.so-btn--secondary { border-color: color-mix(in srgb, currentColor 28%, transparent); }
:is(a, button).so-btn--secondary:hover { border-color: currentColor; }
.so-btn--text { min-height: 0; padding: 0.2em 0; border-radius: 0; --so-btn-fg: var(--so-color-brand); background: none; }
.so-btn--text::after { content: '→'; transition: transform 160ms ease; }
:is(a, button).so-btn--text:hover::after { transform: translateX(3px); }
.so-btn--light { --so-btn-bg: var(--so-color-on-brand); --so-btn-fg: var(--so-color-brand-strong); --so-btn-bg-hover: color-mix(in srgb, var(--so-color-on-brand) 88%, var(--so-color-brand)); }
:is(a, button).so-btn--light:hover { background: var(--so-btn-bg-hover, color-mix(in srgb, var(--so-btn-bg) 88%, var(--so-btn-fg))); }
/* A button with no destination is shown as a label: no pointer, no hover or press feedback. */
.so-btn--static { cursor: default; box-shadow: none; }
.so-btn--static.so-btn--text::after { content: none; }

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
.so-rich--check li { position: relative; padding-left: 1.75em; }
.so-rich--check li::before {
  content: ''; position: absolute; left: 0; top: 0.32em; width: 1.05em; height: 1.05em; border-radius: 50%;
  background: color-mix(in srgb, var(--so-color-brand) 14%, transparent);
  -webkit-mask: none;
}
.so-rich--check li::after {
  content: ''; position: absolute; left: 0.33em; top: 0.52em; width: 0.38em; height: 0.6em;
  border: solid var(--so-color-brand); border-width: 0 2px 2px 0; transform: rotate(45deg);
}
.so-rich--bullet li { position: relative; padding-left: 1.25em; }
.so-rich--bullet li::before { content: ''; position: absolute; left: 0.2em; top: 0.7em; width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: 0.6; }

details > summary { list-style: none; cursor: pointer; }
details > summary::-webkit-details-marker { display: none; }
details > summary .so-icon { transition: transform 200ms ease; }
details[open] > summary .so-icon { transform: rotate(45deg); }

.so-visually-hidden { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

.so-container { width: 100%; max-width: calc(var(--so-container-content) + 2 * var(--so-container-gutter)); margin-inline: auto; padding-inline: var(--so-container-gutter); }
`;
