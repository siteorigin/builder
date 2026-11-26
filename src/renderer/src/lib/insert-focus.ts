import { setState } from '../store';

/** Opens Insert ready to search. The panel focuses its own search field as it opens, but not when it was open
 *  already, and a button in another panel must not keep focus once Insert has taken its place. */
export function openInsertSearch() {
  setState({ leftTab: 'insert' });
  requestAnimationFrame(() => document.querySelector<HTMLElement>('.side-panel-view:not([hidden]) .insert-search input')?.focus({ preventScroll: true }));
}
