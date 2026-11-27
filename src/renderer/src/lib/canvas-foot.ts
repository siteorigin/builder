/**
 * What the editor says on the body for its stylesheets, rather than have them find it with `:has()`: a `:has()` on the
 * body or the editor that styles something inside them makes Chromium restyle all of either on every change of the
 * page under them (a selection drawing its outline, a Layers row changing class), which on a long page is most of the
 * time a change takes. tests/unit/css-has-anchors.test.ts keeps them out.
 */

/** How far above the top of the canvas's foot the window's notices stand, in pixels. */
export const NOTICES_CLEAR = 12;
/** Where the notices stand with nothing under them: clear of the window's foot (the status bar). */
export const NOTICES_FLOOR = 40;

/**
 * The canvas's foot (the Previewing bar, the AI's notice, a page problem, Form practice), while it holds anything:
 * the window's notices stand above its top (`--notices-over-foot`, read by styles/primitives.css), so a notice never
 * covers Stop, Try again or Back to editing. Said as a resolved length, measured from the window's foot, whenever the foot is not
 * inert (behind a dialog, under the post writer or the SEO view, in a project being left); otherwise the notices take
 * their own place. Kept from the commit that mounts the foot to the one that takes it away, following its height (a
 * bar arriving, leaving or wrapping), the window's size, and every element that turns inert or live. Returns the
 * cleanup.
 */
export function canvasFoot(el: HTMLElement | null) {
  if (!el) return;
  const body = document.body.style;
  const update = () => {
    const live = el.isConnected && el.offsetHeight > 0 && !el.closest('[inert]');
    if (live) body.setProperty('--notices-over-foot', `${Math.max(NOTICES_FLOOR, Math.ceil(innerHeight - el.getBoundingClientRect().top + NOTICES_CLEAR))}px`);
    else body.removeProperty('--notices-over-foot');
  };
  update();
  const inert = new MutationObserver(update);
  inert.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['inert'] });
  const size = new ResizeObserver(update);
  size.observe(el);
  addEventListener('resize', update);
  return () => {
    inert.disconnect();
    size.disconnect();
    removeEventListener('resize', update);
    body.removeProperty('--notices-over-foot');
  };
}
