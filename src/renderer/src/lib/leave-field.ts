/** Leaves the text field with focus inside `root`, if there is one: its control saves or keeps what it holds. */
export function leaveField(root: HTMLElement | null) {
  if (typeof document === 'undefined') return;
  const el = document.activeElement;
  if (root && el instanceof HTMLElement && root.contains(el) && el.matches('input, textarea')) el.blur();
}
