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

/** The recoveries installed now, each told of a pointer pick on the page by `pointerPickOnPage`. */
const recoveries = new Set<(pick: PagePick) => void>();
const NAME = '.insp-name h3';

/**
 * A press of the pointer on the page that the canvas took: `changed` when it changed the selection (as the Inspector
 * keys its content: the whole reference), `madeAt` (performance.now) for a click taken after a wait.
 */
export type PagePick = { changed: boolean; madeAt?: number };

/**
 * When the control that had focus is taken out of the Inspector (a selection change, an undo, a row removed) and
 * nothing else took focus, it goes to the selection's name rather than back to the start of the window. Focus that
 * moved to the canvas, Layers or a dialog is left where it is, and so is focus a pointer pick on the page set aside
 * (`pointerPickOnPage`): the page is where the author is working then. Returns the cleanup.
 */
export function recoverInspectorFocus(panel: HTMLElement): () => void {
  // The Inspector control focus was last on, and only while focus stays in the Inspector: focus that has moved to
  // Layers, the canvas or a menu clears it, so their own handoffs are never overruled.
  let last: Element | null = null;
  let lastAt = 0;
  let frame = 0;
  // While this recovery puts focus on the name itself: that is no newer focus of the author's (see `picked`).
  let recovering = false;
  const onIn = (e: FocusEvent) => {
    const inside = e.target instanceof Element && panel.contains(e.target);
    last = inside ? (e.target as Element) : null;
    // When focus last came to the Inspector by the author's hand: focus elsewhere sets nothing here aside.
    if (inside && !recovering) lastAt = performance.now();
  };
  const idle = () => !document.activeElement || document.activeElement === document.body;
  const mo = new MutationObserver(() => {
    if (!last || last.isConnected || !idle()) return;
    last = null;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!idle()) return;
      recovering = true;
      try {
        panel.querySelector<HTMLElement>(NAME)?.focus();
      } finally {
        recovering = false;
      }
    });
  });
  const forget = () => {
    last = null;
    cancelAnimationFrame(frame);
  };
  const picked = ({ changed, madeAt }: PagePick) => {
    // Focus the author moved into the Inspector while the click waited is the keyboard's, and stays as it is.
    if (madeAt !== undefined && lastAt > madeAt) return;
    if (changed) forget();
    // The name is only where focus lands: ringed, it would say the keyboard was there.
    const a = document.activeElement;
    if (a instanceof HTMLElement && panel.contains(a) && a.matches(NAME)) a.blur();
  };
  document.addEventListener('focusin', onIn);
  mo.observe(panel, { childList: true, subtree: true });
  recoveries.add(picked);
  return () => {
    recoveries.delete(picked);
    forget();
    document.removeEventListener('focusin', onIn);
    mo.disconnect();
  };
}

/**
 * The pointer made a pick on the page (#1476). The click reached only the page's frame, so the editor's window would
 * count focus moved in the Inspector as the keyboard's and ring the selection's name. When the pick changed the
 * selection, the control focus was on before it is not brought back to the new selection's name; either way a name
 * holding focus lets it go. Focus then rests on the body, where Delete and the other selection keys reach the
 * selection (#1361).
 */
export function pointerPickOnPage(pick: PagePick): void {
  for (const picked of recoveries) picked(pick);
}
