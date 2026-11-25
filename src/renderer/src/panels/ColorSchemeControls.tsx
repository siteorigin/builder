import { CircleCheck, CircleHelp, Moon, Sun, TriangleAlert } from 'lucide-react';
import type { ColorSchemeMode, ProjectState } from '@shared/types';
import { colorSchemeMode, type PaletteScheme } from '@shared/color-scheme';
import { isFailing } from '@shared/contrast';
import { applyOps } from '../store';
import { Field } from '../components/ui';
import type { ContrastModel } from './ContrastNotes';

const MODES: Array<[ColorSchemeMode, string]> = [
  ['single', 'One palette'],
  ['system', 'Light and dark, from the visitor’s device'],
  ['toggle', 'Light and dark, with a switch in the header']
];

const MODE_HINTS: Record<ColorSchemeMode, string> = {
  single: 'Every visitor sees these colors.',
  system: 'Visitors whose device is set to dark see the dark colors. Printing always uses the light ones.',
  toggle: 'Visitors see the colors their device asks for, and the header’s Light/Dark switch changes them. The browser remembers the choice. Printing always uses the light ones.'
};

/** How a palette's contrast reads in a line: what is hard to read, and what cannot be checked. */
function verdict(model: ContrastModel): { icon: 'pass' | 'fail' | 'unknown'; text: string } {
  const failing = model.results.filter(isFailing).length;
  const unknown = model.results.filter((r) => r.status === 'unknown').length;
  if (failing) return { icon: 'fail', text: `${failing} ${failing === 1 ? 'pair is' : 'pairs are'} hard to read` };
  if (unknown) return { icon: 'unknown', text: `${unknown} ${unknown === 1 ? 'pair' : 'pairs'} can’t be checked` };
  return { icon: 'pass', text: model.results.length ? 'Readable' : 'Nothing to check' };
}

function Verdict({ model, name }: { model: ContrastModel; name: string }) {
  const v = verdict(model);
  const Icon = v.icon === 'pass' ? CircleCheck : v.icon === 'fail' ? TriangleAlert : CircleHelp;
  return (
    <li className={`ss-verdict ${v.icon}`}>
      <Icon aria-hidden="true" />
      <span>
        <strong>{name}:</strong> {v.text}
      </span>
    </li>
  );
}

/**
 * Which palettes visitors get, and which one Colors shows and edits. Turning a dark palette on makes one from the
 * light colors (the engine does, so the assistant's and the author's are the same); both palettes' contrast stays in
 * view, so a change that spoils the other one is never missed.
 */
export function ColorSchemeControls({
  state,
  palette,
  onPalette,
  contrast,
  otherContrast,
  say
}: {
  state: ProjectState;
  palette: PaletteScheme;
  onPalette: (p: PaletteScheme) => void;
  contrast: ContrastModel;
  otherContrast: ContrastModel | null;
  say: (text: string) => void;
}) {
  const mode = colorSchemeMode(state.tokens);
  const choose = (next: ColorSchemeMode) => {
    if (next === mode) return;
    const first = next !== 'single' && !state.tokens.darkOverrides;
    void applyOps([{ type: 'token.setColorScheme', mode: next }], next === 'single' ? 'Use one palette' : 'Add dark colors').then((ok) => {
      if (!ok) return;
      if (next === 'single') return void (onPalette('light'), say('The site has one palette again. Its dark colors are kept for when you turn them back on.'));
      if (first) say('Dark colors were made from your light colors. Choose Dark to see and change them.');
    });
  };
  const remake = () =>
    void applyOps([{ type: 'token.setColorScheme', mode, regenerate: true }], 'Make dark colors again').then((ok) => ok && say('The dark colors were made again from the light ones. You can undo this.'));
  const light = palette === 'light' ? contrast : otherContrast;
  const dark = palette === 'dark' ? contrast : otherContrast;
  return (
    <div className="ss-group ss-schemes">
      <Field label="Visitors see" hint={MODE_HINTS[mode]}>
        <select className="select sm" value={mode} onChange={(e) => choose(e.target.value as ColorSchemeMode)}>
          {MODES.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      {mode !== 'single' && (
        <>
          <div className="segmented full ss-palette-switch" role="group" aria-label="Colors shown">
            <button aria-pressed={palette === 'light'} onClick={() => onPalette('light')}>
              <Sun aria-hidden="true" />
              Light
            </button>
            <button aria-pressed={palette === 'dark'} onClick={() => onPalette('dark')}>
              <Moon aria-hidden="true" />
              Dark
            </button>
          </div>
          <ul className="ss-palette-contrast" aria-label="Contrast in each palette">
            {light && <Verdict model={light} name="Light" />}
            {dark && <Verdict model={dark} name="Dark" />}
          </ul>
          {palette === 'dark' && (
            <p className="ss-palette-note">
              A color without a dark color of its own shows its light one.{' '}
              <button type="button" className="link-btn" onClick={remake}>
                Make the dark colors again from the light ones
              </button>
            </p>
          )}
        </>
      )}
    </div>
  );
}
