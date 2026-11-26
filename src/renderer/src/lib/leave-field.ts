/** Leaves the text field with focus inside `root`, if there is one (of those `fields` names): its control saves or keeps
 *  what it holds. */
export function leaveField(root: HTMLElement | null, fields = 'input, textarea') {
  if (typeof document === 'undefined') return;
  const el = document.activeElement;
  if (root && el instanceof HTMLElement && root.contains(el) && el.matches(fields)) el.blur();
}
