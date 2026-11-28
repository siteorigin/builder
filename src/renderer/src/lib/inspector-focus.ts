/** What the Inspector's own header carries (its name and shortcuts): not where "Edit" should land. */
const HEADER = '.insp-head';
const CONTROL = 'input:not([type="hidden"]), textarea, select, button, [role="switch"], [contenteditable="true"]';

const usable = (el: HTMLElement) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true' && el.tabIndex >= 0 && !el.closest('[hidden], [inert]');

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

/** The recoveries installed now, each told to stand down by `forgetInspectorFocus`. */
const recoveries = new Set<(before?: number) => void>();
const NAME = '.insp-name h3';

/**
 * When the control that had focus is taken out of the Inspector (a selection change, an undo, a row removed) and
 * nothing else took focus, it goes to the selection's name rather than back to the start of the window. Focus that
 * moved to the canvas, Layers or a dialog is left where it is, and so is focus a selection the pointer made on the
 * page set aside (`forgetInspectorFocus`): the page is where the author is working then. Returns the cleanup.
 */
export function recoverInspectorFocus(panel: HTMLElement): () => void {
  // The Inspector control focus was last on, and only while focus stays in the Inspector: focus that has moved to
  // Layers, the canvas or a menu clears it, so their own handoffs are never overruled.
  let last: Element | null = null;
  let lastAt = 0;
  let frame = 0;
  const onIn = (e: FocusEvent) => {
    last = e.target instanceof Element && panel.contains(e.target) ? e.target : null;
    lastAt = performance.now();
  };
  const idle = () => !document.activeElement || document.activeElement === document.body;
  const mo = new MutationObserver(() => {
    if (!last || last.isConnected || !idle()) return;
    last = null;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (idle()) panel.querySelector<HTMLElement>(NAME)?.focus();
    });
  });
  const forget = (before?: number) => {
    if (before !== undefined && lastAt > before) return;
    last = null;
    cancelAnimationFrame(frame);
  };
  document.addEventListener('focusin', onIn);
  mo.observe(panel, { childList: true, subtree: true });
  recoveries.add(forget);
  return () => {
    recoveries.delete(forget);
    forget();
    document.removeEventListener('focusin', onIn);
    mo.disconnect();
  };
}

/**
 * A press of the pointer on the page changed the selection (#1476): the Inspector control focus was on is not brought
 * back to the new selection's name. The click reached only the page's frame, so the editor's window would count that
 * focus as the keyboard's and ring the name; and with focus left on the body, Delete and the other selection keys go
 * on reaching the selection (#1361). `before`, for a click taken after a wait, is when it was made: focus that came to
 * the Inspector since is still recovered.
 */
export function forgetInspectorFocus(before?: number): void {
  for (const forget of recoveries) forget(before);
}

/**
 * The selection's name in the Inspector gives up focus to a press of the pointer on the page (#1476), even one that
 * leaves the selection as it was: it is only where focus lands, and ringed, it would say the keyboard was there.
 */
export function releaseInspectorName(): void {
  const a = document.activeElement;
  if (a instanceof HTMLElement && a.matches(`#dock-panel-inspect ${NAME}`)) a.blur();
}
