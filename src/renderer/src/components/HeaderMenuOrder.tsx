import { useId, useState } from 'react';
import type { ProjectState } from '@shared/types';
import { followsPageOrder } from '@engine/header-order';
import { HEADER_MENU_ORDERS, setHeaderMenuOrder, type HeaderMenuOrder } from '../lib/header-menu-order';

/**
 * The header menu's order, chosen over its links in the Inspector: Own order, or Follow page order. Choosing Follow
 * on a menu in another order first shows it as it is and as it will be (setHeaderMenuOrder).
 */
export function HeaderMenuOrderSelect({ state }: { state: ProjectState }) {
  const id = useId();
  const hintId = useId();
  const [busy, setBusy] = useState(false);
  const value: HeaderMenuOrder = followsPageOrder(state) ? 'follow' : 'own';
  // While it follows, the list says why its links have no moves of their own; that says it.
  const hint = value === 'own' ? HEADER_MENU_ORDERS[0].hint : null;
  return (
    <>
      <div className="insp-link-row header-menu-order">
        <label className="insp-link-sub" htmlFor={id}>
          Order
        </label>
        <select
          id={id}
          className="select sm grow"
          value={value}
          aria-busy={busy || undefined}
          aria-describedby={hint ? hintId : undefined}
          onChange={(e) => {
            if (busy) return;
            setBusy(true);
            void setHeaderMenuOrder(e.target.value as HeaderMenuOrder).finally(() => setBusy(false));
          }}
        >
          {HEADER_MENU_ORDERS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {hint && (
        <p className="insp-note muted" id={hintId}>
          {hint}
        </p>
      )}
    </>
  );
}
