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
address { font-style: normal; }
:focus-visible { outline: 2px solid var(--so-color-focus); outline-offset: 3px; border-radius: 4px; }
::selection { background: color-mix(in srgb, var(--so-color-brand) 22%, transparent); }

.so-skip-link { position: absolute; left: 12px; top: -48px; z-index: 100; padding: 10px 16px; border-radius: var(--so-radius-sm); background: var(--so-color-text); color: var(--so-color-background); text-decoration: none; }
.so-skip-link:focus { top: 12px; }

.so-rich > * + * { margin-top: 1em; }
.so-rich a { color: var(--so-color-brand); text-underline-offset: 3px; }

.so-link { color: var(--so-color-brand); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }

.so-plain-link { text-decoration: none; }
.so-plain-link:hover { text-decoration: underline; text-underline-offset: 3px; }

.so-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.5em;
  min-height: 46px; padding: 0.7em 1.35em;
  border: 1px solid transparent; border-radius: var(--so-radius-pill);
  font-family: var(--so-font-body); font-size: 0.97rem; font-weight: 550; line-height: 1.2; letter-spacing: -0.005em;
  text-decoration: none; white-space: nowrap; cursor: pointer;
  transition: background-color 160ms ease, color 160ms ease, border-color 160ms ease, transform 160ms ease, box-shadow 160ms ease;
}
.so-btn:active { transform: translateY(1px); }
.so-btn--primary { background: var(--so-color-brand); color: var(--so-color-on-brand); box-shadow: var(--so-shadow-sm); }
.so-btn--primary:hover { background: var(--so-color-brand-strong); }
.so-btn--secondary { background: transparent; color: currentColor; border-color: color-mix(in srgb, currentColor 28%, transparent); }
.so-btn--secondary:hover { border-color: currentColor; }
.so-btn--text { min-height: 0; padding: 0.2em 0; border-radius: 0; color: var(--so-color-brand); background: none; }
.so-btn--text::after { content: '→'; transition: transform 160ms ease; }
.so-btn--text:hover::after { transform: translateX(3px); }
.so-btn--light { background: var(--so-color-on-brand); color: var(--so-color-brand-strong); }
.so-btn--light:hover { background: color-mix(in srgb, var(--so-color-on-brand) 88%, var(--so-color-brand)); }

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
