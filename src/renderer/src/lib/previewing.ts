/**
 * What the editor says on the body for its stylesheets, rather than have them find it with `:has()`: a `:has()` on the
 * body or the editor that styles something inside them makes Chromium restyle all of either on every change of the
 * page under them (a selection drawing its outline, a Layers row changing class), which on a long page is most of the
 * time a change takes. tests/unit/css-has-anchors.test.ts keeps them out.
 */

/**
 * The Previewing bar, while it is in the page: notices sit above it (styles/primitives.css) whenever it is not inert
 * (behind a dialog, under the post writer or the SEO view, or in a project being left). Kept on the body from the
 * commit that shows the bar, and again whenever an element turns inert or live, to the commit that takes it away.
 */
export function previewPill(el: HTMLDivElement | null) {
  if (!el) return;
  const update = () => document.body.classList.toggle('previewing', el.isConnected && !el.closest('[inert]'));
  update();
  const watch = new MutationObserver(update);
  watch.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['inert'] });
  return () => {
    watch.disconnect();
    document.body.classList.remove('previewing');
  };
}
