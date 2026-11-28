/**
 * The application menu opened from the editor's menu button or F10 (#1355): one popup of the installed menu at a time.
 * A second request while one is open shares it rather than stacking another. Each popup settles once, when the menu
 * closes or its window goes, and stops watching the window then, so nothing is left listening.
 *
 * No Electron import: the caller passes how to show the menu and how to hear its window go, so this is tested with
 * stand-ins.
 */

export interface MenuPopups {
  /**
   * Show the menu, unless one is open already. `show` is handed the function to call when the menu closes; `watchGone`
   * calls the function it is handed if the window goes first, and returns how to stop watching. Resolves when the menu
   * has closed; rejects, closed, when `show` throws.
   */
  open(show: (closed: () => void) => void, watchGone: (gone: () => void) => () => void): Promise<void>;
  /** Whether a popup is open now. */
  readonly showing: boolean;
}

export function createMenuPopups(): MenuPopups {
  let current: { done: Promise<void> } | null = null;
  return {
    open(show, watchGone) {
      if (current) return current.done;
      const entry: { done: Promise<void> } = { done: Promise.resolve() };
      current = entry;
      let settled = false;
      let unwatch: (() => void) | null = null;
      let resolve!: () => void;
      entry.done = new Promise<void>((r) => (resolve = r));
      const settle = () => {
        if (settled) return;
        settled = true;
        unwatch?.();
        unwatch = null;
        if (current === entry) current = null;
        resolve();
      };
      unwatch = watchGone(settle);
      // The window went while it was being watched: no menu is shown over it.
      if (settled) {
        unwatch?.();
        return entry.done;
      }
      try {
        show(settle);
      } catch (e) {
        settle();
        return Promise.reject(e);
      }
      return entry.done;
    },
    get showing() {
      return current !== null;
    }
  };
}
