/**
 * Component Studio's toolbar, in the Edit everywhere band: which option the preview shows on each variant axis, the
 * value each UI state variable is previewed at (a hidden tab, an open drawer, to select and style on the canvas), and
 * the sample content it is filled with. Only the view changes; the component's design and starting content do not.
 * The preview's width is the editor's own (Desktop, Tablet and Phone in the toolbar).
 */
import type { ComponentDefinition } from '@shared/types';
import { axesOf } from '@shared/variants';
import { getState, setState, useStore } from '../store';
import { setStudioView } from '../lib/actions';
import { studioStates, studioVariants } from '../lib/studio';
import { declaredState } from '@engine/schema';
import { isStudioSample, STUDIO_SAMPLES } from '../lib/studio-samples';

export function StudioControls({ def }: { def: ComponentDefinition }) {
  const view = useStore((s) => (s.definitionMode?.definitionId === def.id ? s.definitionMode.studio : undefined));
  const styled = useStore((s) => s.variantStyle);
  if (!view) return null;
  const shown = studioVariants(def, view, styled);
  const states = studioStates(def, view);
  const sample = STUDIO_SAMPLES.find((o) => o.value === view.sample);
  return (
    <div className="studio-controls" role="group" aria-label="What Component Studio shows">
      {axesOf(def).map(([axis, a]) => (
        <label key={axis} className="studio-control">
          <span>{a.label || axis}</span>
          <select
            className="select sm"
            data-studio-axis={axis}
            value={shown[axis]}
            onChange={(e) => {
              const option = e.target.value;
              // Showing another option of the axis whose look is being styled: the Style section goes back to the base
              // design, so a style is never set on a look that is not on screen.
              const look = getState().variantStyle;
              if (look?.definitionId === def.id && look.axis === axis && look.variant !== option) setState({ variantStyle: null });
              setStudioView({ variants: { ...view.variants, [axis]: option } });
            }}
          >
            {Object.entries(a.options).map(([id, o]) => (
              <option key={id} value={id}>
                {o.label || id}
                {id === a.default ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </label>
      ))}
      {Object.entries(states).map(([name, value]) => {
        const declared = declaredState(def, name)!;
        const options = declared.type === 'boolean' ? [{ value: 'true', label: 'On', initial: declared.initial }, { value: 'false', label: 'Off', initial: !declared.initial }] : declared.options.map((o) => ({ ...o, initial: o.value === declared.initial }));
        return (
          <label key={`state:${name}`} className="studio-control" title="Previews the component with this UI state, as a visitor’s click would leave it. Visitors still start where the design says.">
            <span>{declared.label || name}</span>
            <select
              className="select sm"
              data-studio-state={name}
              value={String(value)}
              onChange={(e) => setStudioView({ states: { ...view.states, [name]: declared.type === 'boolean' ? e.target.value === 'true' : e.target.value } })}
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label || o.value}
                  {o.initial ? ' (start)' : ''}
                </option>
              ))}
            </select>
          </label>
        );
      })}
      <label className="studio-control" title={sample?.hint}>
        <span>Content</span>
        <select className="select sm" data-studio-sample value={view.sample} onChange={(e) => isStudioSample(e.target.value) && setStudioView({ sample: e.target.value })}>
          {STUDIO_SAMPLES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
