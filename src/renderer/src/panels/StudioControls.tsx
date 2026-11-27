/**
 * Component Studio's preview choices, the second row of the component band: which option the preview shows on each
 * variant axis, the value each UI state variable is previewed at (a hidden tab, an open drawer, to select and style on
 * the canvas), and the sample content it is filled with (offered only when a sample changes some field). A variant's
 * own option is marked "(default)"; a UI state's is marked "(at start)", where a visitor's first view leaves it. Only
 * the view changes; the component's design and where visitors start do not, which the row says in words ("Preview
 * only") rather than in a tooltip. Each kind is its own group; a choice away from the design's own is drawn (its name
 * in full ink) and carries the editor's reset dot.
 * The preview's width is the editor's own (Desktop, Tablet and Phone in the toolbar).
 */
import { useId, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import type { ComponentDefinition } from '@shared/types';
import { axesOf } from '@shared/variants';
import { getState, setState, useStore } from '../store';
import { setStudioView } from '../lib/actions';
import { studioStates, studioVariants } from '../lib/studio';
import { itemStatePositions } from '../lib/ui-state';
import { declaredState } from '@engine/schema';
import { isStudioSample, STUDIO_SAMPLES, studioSampleProps, type StudioSample } from '../lib/studio-samples';

/** Whether a sample fills at least one of the component's fields with something other than its starting value. */
function sampleChanges(def: ComponentDefinition, sample: StudioSample): boolean {
  const props = studioSampleProps(def, sample);
  if (!props) return false;
  return Object.entries(props).some(([name, v]) => JSON.stringify(v) !== JSON.stringify((def.properties as Record<string, { default?: unknown }>)[name]?.default));
}

export function StudioControls({ def }: { def: ComponentDefinition }) {
  const uid = useId();
  const view = useStore((s) => (s.definitionMode?.definitionId === def.id ? s.definitionMode.studio : undefined));
  const styled = useStore((s) => s.variantStyle);
  if (!view) return null;
  const shown = studioVariants(def, view, styled);
  const states = studioStates(def, view);
  const sample = STUDIO_SAMPLES.find((o) => o.value === view.sample);
  // An item state is previewed at a position among the items the sample shows (Long copy has more than the design).
  const sampleProps = studioSampleProps(def, view.sample);
  const sampleItems = (list: string) => (Array.isArray(sampleProps?.[list]) ? (sampleProps[list] as unknown[]) : undefined);
  // A sample is offered only when it fills some field differently from the starting content; with none, no Sample select.
  const samples = STUDIO_SAMPLES.filter((o) => o.value === 'defaults' || o.value === view.sample || sampleChanges(def, o.value));
  const axes = axesOf(def);
  const stateRows = Object.entries(states).map(([name, value]) => {
    const declared = declaredState(def, name)!;
    const options =
      declared.type === 'boolean'
        ? [{ value: 'true', label: 'On', initial: declared.initial }, { value: 'false', label: 'Off', initial: !declared.initial }]
        : declared.type === 'item'
          ? itemStatePositions(def, declared, sampleItems(declared.list), Number(value)).map((o) => ({ value: String(o.value), label: o.label, initial: o.value === declared.initial }))
          : declared.options.map((o) => ({ ...o, initial: o.value === declared.initial }));
    return { name, value, declared, options };
  });
  if (!axes.length && !stateRows.length && samples.length < 2) return null;

  // Showing another option of the axis whose look is being styled: the Style section goes back to the base design, so
  // a style is never set on a look that is not on screen.
  const showOption = (axis: string, option: string) => {
    const look = getState().variantStyle;
    if (look?.definitionId === def.id && look.axis === axis && look.variant !== option) setState({ variantStyle: null });
    setStudioView({ variants: { ...view.variants, [axis]: option } });
  };
  const showState = (name: string, value: boolean | string | number) => setStudioView({ states: { ...view.states, [name]: value } });

  /**
   * One preview choice: its name, its select, then a slot for the reset dot every changed value in the editor carries.
   * The slot is always there (empty while the choice is the design's own), so a select never moves when it changes.
   * Reset leaves focus on the select or, when the reset took the select away (the last sample that differed), on the
   * next preview choice or Done editing.
   */
  const control = (key: string, name: string, changed: string | null, reset: () => void, select: (id: string) => ReactNode, hint?: string) => {
    const id = `${uid}-${key}`;
    return (
      <div key={key} className={`studio-control${changed ? ' changed' : ''}`} title={hint}>
        <label htmlFor={id} data-label={name}>
          {name}
        </label>
        {select(id)}
        {hint && (
          <span id={`${id}-hint`} className="sr-only">
            {hint}
          </span>
        )}
        <span className="studio-reset-slot">
          {changed && (
            <button
              type="button"
              className="reset-dot"
              title={changed}
              aria-label={changed}
              onClick={(e) => {
                const band = e.currentTarget.closest('.mode-band');
                reset();
                requestAnimationFrame(() => (document.getElementById(id) ?? band?.querySelector<HTMLElement>('.studio-controls select') ?? band?.querySelector<HTMLElement>('.mode-band-done'))?.focus());
              }}
            >
              <RotateCcw aria-hidden="true" />
            </button>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="studio-controls" role="group" aria-label="Preview only. The design and where visitors start stay as they are.">
      <span className="studio-caption" aria-hidden="true">
        Preview only
      </span>
      {samples.length > 1 && (
        <div className="studio-group" role="group" aria-label="Sample content">
          {control(
            'sample',
            'Sample',
            view.sample !== 'defaults' ? 'Show the starting content again' : null,
            () => setStudioView({ sample: 'defaults' }),
            (id) => (
              <select id={id} className="select sm" data-studio-sample aria-describedby={sample?.hint ? `${id}-hint` : undefined} value={view.sample} onChange={(e) => isStudioSample(e.target.value) && setStudioView({ sample: e.target.value })}>
                {samples.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ),
            sample?.hint
          )}
        </div>
      )}
      {axes.length > 0 && (
        <div className="studio-group" role="group" aria-label="Variants">
          {axes.map(([axis, a]) => {
            const name = a.label || axis;
            return control(
              `axis-${axis}`,
              name,
              shown[axis] !== a.default ? `Show ${name} at its default, ${a.options[a.default]?.label || a.default}` : null,
              () => showOption(axis, a.default),
              (id) => (
                <select id={id} className="select sm" data-studio-axis={axis} value={shown[axis]} onChange={(e) => showOption(axis, e.target.value)}>
                  {Object.entries(a.options).map(([oid, o]) => (
                    <option key={oid} value={oid}>
                      {o.label || oid}
                      {oid === a.default ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              )
            );
          })}
        </div>
      )}
      {stateRows.length > 0 && (
        <div className="studio-group" role="group" aria-label="UI states, as a visitor’s click would leave them">
          {stateRows.map(({ name, value, declared, options }) => {
            const label = declared.label || name;
            const start = options.find((o) => o.initial);
            const parse = (v: string) => (declared.type === 'boolean' ? v === 'true' : declared.type === 'item' ? Number(v) : v);
            return control(
              `state-${name}`,
              label,
              value !== declared.initial ? `Show ${label} where visitors start${start ? `, ${start.label || start.value}` : ''}` : null,
              () => showState(name, declared.initial),
              (id) => (
                <select id={id} className="select sm" data-studio-state={name} value={String(value)} onChange={(e) => showState(name, parse(e.target.value))}>
                  {options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label || o.value}
                      {o.initial ? ' (at start)' : ''}
                    </option>
                  ))}
                </select>
              )
            );
          })}
        </div>
      )}
    </div>
  );
}
