/** What the Inspector's own header carries (its name and shortcuts): not where "Edit" should land. */
const HEADER = '.insp-head';
const CONTROL = 'input:not([type="hidden"]), textarea, select, button, [role="switch"], [contenteditable="true"]';

const usable = (el: HTMLElement) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true' && !el.closest('[hidden], [inert]');

/**
 * The first control the author can work in inside the Inspector: a field of the open sections, buttons and
 * switches included (a picker or a toggle is a field too). A selection with every section closed lands on
 * the first section heading, and one with nothing to show on its name.
 */
export function firstInspectorControl(panel: ParentNode | null = document.getElementById('dock-panel-inspect')): HTMLElement | null {
  if (!panel) return null;
  const inBody = [...panel.querySelectorAll<HTMLElement>(`.section-body ${CONTROL.split(', ').join(', .section-body ')}`)];
  return (
    inBody.find((el) => usable(el) && !el.closest(HEADER)) ??
    [...panel.querySelectorAll<HTMLElement>('.section-head')].find(usable) ??
    panel.querySelector<HTMLElement>('.insp-name h3') ??
    null
  );
}

/**
 * Move focus into the Inspector once it has drawn the selection (it may have only just opened). Tries each
 * frame for up to `ms`; returns a cancel function.
 */
export function focusInspector(ms = 1000): () => void {
  const until = Date.now() + ms;
  let frame = 0;
  const step = () => {
    const panel = document.getElementById('dock-panel-inspect');
    // The panel's own content is drawn a frame after it opens: wait for a heading before settling for less.
    const el = firstInspectorControl(panel);
    if (el && (el.closest('.section') || Date.now() >= until)) return void el.focus();
    if (Date.now() < until) frame = requestAnimationFrame(step);
    else el?.focus();
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}
