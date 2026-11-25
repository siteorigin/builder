import { useEffect, useId, useRef, useState } from 'react';
import type { ResponsiveStyles, StyleState } from '@shared/types';
import { STYLE_STATES, parseStyleScopeKey } from '@shared/types';
import { STATE_STYLE_PROPS, STYLE_PROP_MAP } from '@shared/styles';
import { setState } from '../store';

export const STATE_LABEL: Record<StyleState, string> = { hover: 'Hover', focus: 'Focus', active: 'Active' };
/** When a state's changes show, for the note under the picker. */
const STATE_WHEN: Record<StyleState, string> = {
  hover: 'while the pointer is over it, on devices with a pointer',
  focus: 'while it has keyboard focus',
  active: 'while it is pressed'
};
/** What the canvas shows while a state is chosen. */
const STATE_SHOWN: Record<StyleState, string> = { hover: 'hovered', focus: 'focused', active: 'pressed' };

/** How many changes a set of styles holds in one state, at every size. */
export const stateChangeCount = (styles: ResponsiveStyles | undefined, state: StyleState) =>
  Object.entries(styles ?? {}).reduce((n, [k, v]) => n + (parseStyleScopeKey(k)?.state === state ? Object.keys(v ?? {}).length : 0), 0);
/** The states a set of styles holds changes for, in the order the stylesheet writes them. */
export const statesWithChanges = (styles: ResponsiveStyles | undefined): StyleState[] => STYLE_STATES.filter((st) => stateChangeCount(styles, st) > 0);

/** The properties a state can change, as the note names them. */
const stateProps = () => {
  const names = STATE_STYLE_PROPS.map((p) => STYLE_PROP_MAP[p]?.label.toLowerCase()).filter((n): n is string => !!n && !/^border (top|bottom|left|right|start|end)/.test(n));
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

/**
 * The state control, under the size picker: whether the next change applies at rest (Default) or on hover, with
 * keyboard focus or while pressed, and which states already hold changes. While a state is chosen, the canvas shows
 * the selected element in it.
 */
export function StatePicker({ styles, state, part }: { styles: ResponsiveStyles | undefined; state: StyleState | null; part?: string }) {
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

  const order: Array<StyleState | null> = [null, ...STYLE_STATES];
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
            <button key={name} type="button" role="radio" data-state={v ?? 'default'} aria-checked={state === v} tabIndex={state === v ? 0 : -1} onClick={() => choose(v)} title={dot ? `${name} has its own changes` : v ? `Style it ${STATE_WHEN[v]}` : 'Style it at rest'}>
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
      {state && (
        <p className="style-scope-note" id={noteId}>
          <strong>{STATE_LABEL[state]} only</strong>, {STATE_WHEN[state]}. The canvas shows it {STATE_SHOWN[state]}. A state changes only {stateProps()}.
        </p>
      )}
    </div>
  );
}
