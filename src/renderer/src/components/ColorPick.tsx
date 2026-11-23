import { useEffect, useRef, useState } from 'react';
import { colorFromPicker, paintableColor, retirePicks, toHex6, type SentPick } from '@shared/color';
import { resolveCssColor } from '../lib/color';

const LANDED_MS = 500; // how long a pick stays in flight after its save succeeds: the saved value arrives meanwhile (a save that changes nothing never sends one)
/** A backstop for a pick whose save never reports back (the owner's `onPick` returns nothing to wait on): the swatch then goes back to the saved color. */
const SAVE_WAIT_MS = 30000;

/**
 * A colour swatch that shows the saved CSS colour as it renders (opacity over a checkerboard, wide-gamut
 * colours as the browser paints them) and, given `onPick`, opens the native picker over it. The picker
 * starts from the colour in effect, never from black, and a pick keeps the opacity of the colour it
 * replaces. A value with nothing to start from (empty, `currentcolor`, a gradient, one that depends on a
 * project variable) opens on black, and choosing a colour replaces it.
 *
 * The native picker reports every step of a drag, and a save takes a moment to come back. So the input
 * shows what was last picked while saves are in flight, and each step is worked out from the last one
 * sent: dragging from red to blue and back to red before the first save lands ends on red. A save that
 * lands mid-drag only retires the picks up to it. A pick the owner reports as not saved (its `onPick`
 * returns a promise that resolves to null or false, or rejects) is dropped, and with nothing left in
 * flight the swatch goes back to the saved color.
 */
export function ColorPick({
  value,
  onPick,
  disabled,
  label,
  title,
  className = ''
}: {
  /** The colour in effect, as CSS: a token reference already followed. */
  value: string;
  /** Receives the CSS to save. May return a promise that resolves to null or false (or rejects) when the save did not happen. Without it the swatch is a read-only chip. */
  onPick?: (next: string) => unknown;
  /** Linked to another colour: shown at full strength with a dashed edge, not editable. */
  disabled?: boolean;
  label?: string;
  title?: string;
  className?: string;
}) {
  const rgba = resolveCssColor(value);
  const empty = !value.trim();
  const unreadable = !rgba && !empty;
  const paints = paintableColor(value);
  const [draft, setDraft] = useState<string | null>(null);
  /** What this swatch has sent that has not come back as the saved value yet, oldest first. */
  const inflight = useRef<SentPick[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settle = () => {
    clearTimeout(timer.current);
    inflight.current = [];
    setDraft(null);
  };
  useEffect(() => {
    inflight.current = retirePicks(inflight.current, value);
    if (!inflight.current.length) settle();
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const hint = unreadable && onPick && !disabled ? 'The picker cannot show this color. Choosing a color replaces it.' : undefined;
  const state = `${disabled ? ' linked' : ''}${!paints && !empty ? ' unpainted' : ''}`;
  return (
    <span className={`color-pick${state}${className ? ` ${className}` : ''}`} title={title ?? hint} data-color-pick>
      {/* One element per value: a value the browser rejects must not leave the last colour painted. */}
      <span key={value} className="color-pick-fill" style={paints ? { background: value } : undefined} aria-hidden="true" />
      {onPick && (
        <input
          type="color"
          disabled={!!disabled}
          value={draft ?? (rgba ? toHex6(rgba) : '#000000')}
          aria-label={label && hint ? `${label}. ${hint}` : label}
          onChange={(e) => {
            const picked = e.target.value;
            setDraft(picked);
            const last = inflight.current[inflight.current.length - 1]?.text;
            const base = last ?? value;
            const next = colorFromPicker(base, picked, last === undefined ? rgba : undefined);
            if (next === base) return;
            const mine = { text: next };
            inflight.current.push(mine);
            clearTimeout(timer.current);
            timer.current = setTimeout(settle, SAVE_WAIT_MS);
            const retire = () => {
              inflight.current = inflight.current.filter((p) => p !== mine);
              if (!inflight.current.length) settle();
            };
            Promise.resolve(onPick(next)).then((saved) => (saved === null || saved === false ? retire() : void setTimeout(retire, LANDED_MS)), retire);
          }}
        />
      )}
    </span>
  );
}
