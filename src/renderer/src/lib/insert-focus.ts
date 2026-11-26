import { setState } from '../store';

/** Opens Insert ready to search. The panel focuses its own search field as it opens, but not when it was open
 *  already, and a button in another panel must not keep focus once Insert has taken its place. */
export function openInsertSearch() {
  openInsert(null);
}

/** Opens Insert searching for `query` (as if typed, so the panel's own search takes it); an empty one clears what it
 *  was searching for before. */
export function openInsertSearchFor(query: string) {
  openInsert(query);
}

function openInsert(query: string | null) {
  setState({ leftTab: 'insert' });
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>('.side-panel-view:not([hidden]) .insert-search input');
    if (!input) return;
    if (query !== null && input.value !== query) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, query);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    input.focus({ preventScroll: true });
  });
}
