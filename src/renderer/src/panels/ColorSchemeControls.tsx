import { useId, useRef } from 'react';
import { CircleCheck, CircleHelp, Moon, RefreshCw, Sun, TriangleAlert } from 'lucide-react';
import type { ColorSchemeMode, ProjectState } from '@shared/types';
import { colorSchemeMode, type PaletteScheme } from '@shared/color-scheme';
import { isFailing } from '@shared/contrast';
import { commitOps, toast, undoAction } from '../store';
import { ChoiceField } from '../components/ui';
import type { ContrastModel } from './ContrastNotes';

type DualMode = Exclude<ColorSchemeMode, 'single'>;

const MODE_HINTS: Record<ColorSchemeMode, string> = {
  single: 'Every visitor sees these colors.',
  system: 'Visitors whose device is set to dark see the dark colors. Printing uses the light ones.',
  toggle: 'Visitors start with their device’s choice and can change it with the Light/Dark switch in the header. Printing uses the light ones.'
};

/** How a palette's contrast reads in a line: what is hard to read, and what cannot be checked. */
function verdict(model: ContrastModel): { icon: 'pass' | 'fail' | 'unknown'; text: string } {
  const failing = model.results.filter(isFailing).length;
  const unknown = model.results.filter((r) => r.status === 'unknown').length;
  // Both counts when both apply, so a pair that can't be checked is not found only after the others are fixed.
  if (failing) return { icon: 'fail', text: `${failing} ${failing === 1 ? 'pair is' : 'pairs are'} hard to read${unknown ? `, ${unknown} can’t be checked` : ''}` };
  if (unknown) return { icon: 'unknown', text: `${unknown} ${unknown === 1 ? 'pair' : 'pairs'} can’t be checked` };
  return model.results.length ? { icon: 'pass', text: 'Readable' } : { icon: 'unknown', text: 'Nothing to check' };
}

/**
 * One palette's verdict. A problem in the palette not shown offers to show it; a pair hard to read in the palette
 * shown offers to go to its row, so either is one click away.
 */
function Verdict({ model, name, onShow, onJump }: { model: ContrastModel; name: string; onShow?: () => void; onJump?: (tokenId: string) => void }) {
  const v = verdict(model);
  const first = model.results.find(isFailing);
  const Icon = v.icon === 'pass' ? CircleCheck : v.icon === 'fail' ? TriangleAlert : CircleHelp;
  return (
    <li className={`ss-verdict ${v.icon}`}>
      <Icon aria-hidden="true" />
      <span>
        <strong>{name}:</strong> {v.text}
      </span>
      {onShow && v.icon !== 'pass' ? (
        <button type="button" className="link-btn" onClick={onShow}>
          Show {name.toLowerCase()} colors
        </button>
      ) : (
        onJump &&
        first && (
          <button type="button" className="link-btn" onClick={() => onJump(first.pair.fg)}>
            Show the first<span className="sr-only"> pair that is hard to read</span>
          </button>
        )
      )}
    </li>
  );
}

/**
 * Which palettes visitors get, and which one Colors shows and edits. Turning a dark palette on makes one from the
 * light colors (the engine does, so the assistant's and the author's are the same); both palettes' contrast stays in
 * view, so a change that spoils the other one is never missed. Each change is said in a toast with its Undo.
 */
export function ColorSchemeControls({
  state,
  palette,
  onPalette,
  contrast,
  otherContrast,
  onJump
}: {
  state: ProjectState;
  palette: PaletteScheme;
  onPalette: (p: PaletteScheme) => void;
  contrast: ContrastModel;
  otherContrast: ContrastModel | null;
  /** Open a colour's row in Colors at its contrast details, and put focus there. */
  onJump: (tokenId: string) => void;
}) {
  const uid = useId();
  const mode = colorSchemeMode(state.tokens);
  // Which of the two ways to choose dark comes back when a site with one palette turns light and dark on again.
  const lastDual = useRef<DualMode>('system');
  if (mode !== 'single') lastDual.current = mode;
  const choose = (next: ColorSchemeMode) => {
    if (next === mode) return;
    const first = next !== 'single' && !state.tokens.darkOverrides;
    const label = next === 'single' ? 'Use one palette' : mode === 'single' ? 'Add dark colors' : next === 'toggle' ? 'Add a Light/Dark switch' : 'Follow the visitor’s device';
    void commitOps([{ type: 'token.setColorScheme', mode: next }], label).then((r) => {
      if (!r?.ok) return;
      if (next === 'single') onPalette('light');
      const text =
        next === 'single'
          ? 'The site has one palette again. Its dark colors are kept for when you turn them back on.'
          : first
            ? 'Dark colors made from your light colors. Choose Dark colors to see and change them.'
            : mode === 'single'
              ? 'Dark colors are back on.'
              : next === 'toggle'
                ? 'The header has a Light/Dark switch.'
                : 'Dark follows the visitor’s device.';
      toast(text, 'info', undoAction(r));
    });
  };
  const remake = () =>
    void commitOps([{ type: 'token.setColorScheme', mode, regenerate: true }], 'Remake dark colors').then((r) => r?.ok && toast('Dark colors remade from the light ones.', 'info', undoAction(r)));
  // Showing the other palette from its verdict removes the button that did it: focus goes to the switch, on the choice made.
  const editing = useRef<HTMLDivElement>(null);
  const show = (p: PaletteScheme) => {
    onPalette(p);
    requestAnimationFrame(() => editing.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus());
  };
  const light = palette === 'light' ? contrast : otherContrast;
  const dark = palette === 'dark' ? contrast : otherContrast;
  return (
    <div className="ss-group ss-schemes">
      <ChoiceField
        label="Visitors see"
        full
        value={mode === 'single' ? 'single' : 'dual'}
        options={[
          { value: 'single', label: 'One palette' },
          { value: 'dual', label: 'Light and dark' }
        ]}
        onChange={(v) => choose(v === 'single' ? 'single' : lastDual.current)}
        hint={mode === 'single' ? MODE_HINTS.single : undefined}
      />
      {/* The site's own colors, as they stand: a proposal below is judged on its own, under its preview. */}
      {mode === 'single' && (
        <ul className="ss-palette-contrast" aria-label="Contrast in the site's colors">
          <Verdict model={contrast} name="Your colors" onJump={onJump} />
        </ul>
      )}
      {mode !== 'single' && (
        <>
          <ChoiceField
            label="Dark is chosen by"
            full
            value={mode}
            options={[
              { value: 'system', label: 'Their device' },
              { value: 'toggle', label: 'A header switch' }
            ]}
            onChange={choose}
            hint={MODE_HINTS[mode]}
          />
          <div className="ss-palette-editing" ref={editing}>
            <ChoiceField
              label="Showing and editing"
              full
              value={palette}
              options={[
                { value: 'light', label: 'Light colors', icon: <Sun aria-hidden="true" /> },
                { value: 'dark', label: 'Dark colors', icon: <Moon aria-hidden="true" /> }
              ]}
              onChange={onPalette}
              hint={palette === 'dark' ? 'The color rows and the canvas show this palette. A color without a dark color of its own shows its light one.' : 'The color rows and the canvas show this palette.'}
            />
            <ul className="ss-palette-contrast" aria-label="Contrast in each palette">
              {light && <Verdict model={light} name="Light" onShow={palette === 'light' ? undefined : () => show('light')} onJump={palette === 'light' ? onJump : undefined} />}
              {dark && <Verdict model={dark} name="Dark" onShow={palette === 'dark' ? undefined : () => show('dark')} onJump={palette === 'dark' ? onJump : undefined} />}
            </ul>
          </div>
          {palette === 'dark' && (
            <div className="ss-palette-remake">
              <p className="ss-palette-note" id={`${uid}-remake`}>
                Remaking replaces every dark color, including ones you changed, with one made from the light colors. You can undo this.
              </p>
              <button type="button" className="btn btn-sm" aria-describedby={`${uid}-remake`} onClick={remake}>
                <RefreshCw aria-hidden="true" />
                Remake dark colors
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
