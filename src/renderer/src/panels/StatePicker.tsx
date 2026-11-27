import { useEffect, useId, useRef, useState } from 'react';
import type { ResponsiveStyles, StyleState } from '@shared/types';
import { isGroupStyleState } from '@shared/types';
import { setState } from '../store';
import { statesWithChanges } from '../lib/style-source';

export const STATE_LABEL: Record<StyleState, string> = { groupHover: 'Group hover', groupFocus: 'Group focus', hover: 'Hover', focus: 'Focus', active: 'Active' };
/** When a state's changes show, for the note under the picker and each option's tooltip. */
const STATE_WHEN: Record<StyleState, string> = {
  groupHover: 'while the pointer is anywhere over its card',
  groupFocus: 'while anything in its card has focus',
  hover: 'while the pointer is over it',
  focus: 'while it has keyboard focus',
  active: 'while it is pressed'
};
/** The order the picker lists states in: the element's own, then its group's. */
const PICKER_STATES: StyleState[] = ['hover', 'focus', 'active', 'groupHover', 'groupFocus'];

/** "Hover", "Hover and Focus", "Hover, Focus and Active". */
const listNames = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * The state control, under the size picker: whether the next change applies at rest (Default) or on hover, with
 * keyboard focus or while pressed, and which states already hold changes. The element's own states share the first
 * row; its card's two states, when offered, take the second, so the rows never break by accident. While a state is
 * chosen, the canvas shows the selected element in it.
 */
export function StatePicker({ styles, state, part, grouped = false }: { styles: ResponsiveStyles | undefined; state: StyleState | null; part?: string; grouped?: boolean }) {
  const group = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const noteId = useId();
  const [focusAfter, setFocusAfter] = useState(false);

  // After a key changes the state, keyboard focus lands on the newly chosen one.
  useEffect(() => {
    if (!focusAfter) return;
    group.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    setFocusAfter(false);
  }, [focusAfter, state]);

  // Group states only where a group encloses the element, or where it already holds such changes.
  const order: Array<StyleState | null> = [null, ...PICKER_STATES.filter((st) => grouped || !isGroupStyleState(st))];
  const choose = (v: StyleState | null, focus = false) => {
    setState({ styleState: v, styleStatePart: v ? (part ?? null) : null });
    if (focus) setFocusAfter(true);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    const jump = e.key === 'Home' ? 0 : e.key === 'End' ? order.length - 1 : -1;
    if (!step && jump < 0) return;
    e.preventDefault();
    choose(jump >= 0 ? order[jump] : order[(order.indexOf(state) + step + order.length) % order.length], true);
  };
  const marked = new Set(statesWithChanges(styles));
  const markedNames = order.filter((v): v is StyleState => v !== null && marked.has(v)).map((v) => STATE_LABEL[v]);
  return (
    <div className="style-state">
      <div className="style-scope-label" id={labelId}>
        State
      </div>
      <div ref={group} className={`style-scope-picker style-state-picker${state ? ' in-state' : ''}`} role="radiogroup" aria-labelledby={labelId} aria-describedby={state ? noteId : undefined} onKeyDown={onKeyDown}>
        {order.map((v) => {
          const name = v ? STATE_LABEL[v] : 'Default';
          const dot = v !== null && marked.has(v);
          return (
            <button
              key={name}
              type="button"
              role="radio"
              className={v && isGroupStyleState(v) ? 'style-state-group' : undefined}
              data-state={v ?? 'default'}
              aria-checked={state === v}
              tabIndex={state === v ? 0 : -1}
              onClick={() => choose(v)}
              title={`${v ? `Style it ${STATE_WHEN[v]}` : 'Style it at rest'}${dot ? '. Has its own changes' : ''}`}
            >
              {name}
              {dot && (
                <>
                  <span className="style-scope-dot" aria-hidden="true" />
                  <span className="sr-only">, has its own changes</span>
                </>
              )}
            </button>
          );
        })}
      </div>
      {state ? (
        <p className="style-scope-note" id={noteId}>
          <strong>{STATE_LABEL[state]} only</strong>, {STATE_WHEN[state]}, as the canvas shows. Only the styles a state can change are listed.
        </p>
      ) : (
        markedNames.length > 0 && (
          // The dot's meaning in words, while it marks a state that isn't chosen. Each marked option already says so to
          // a screen reader, so this line is for sight only.
          <p className="style-scope-key" aria-hidden="true">
            <span className="style-scope-dot" aria-hidden="true" />
            {listNames(markedNames)} {markedNames.length === 1 ? 'has its' : 'have their'} own changes.
          </p>
        )
      )}
    </div>
  );
}
