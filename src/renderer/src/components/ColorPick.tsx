import { useEffect, useRef, useState } from 'react';
import { colorFromPicker, toHex6 } from '@shared/color';
import { resolveCssColor } from '../lib/color';

/**
 * A colour swatch that shows the saved CSS colour as it renders (opacity over a checkerboard, wide-gamut
 * colours as the browser paints them) and, given `onPick`, opens the native picker over it. The picker
 * starts from the colour in effect, never from black, and a pick keeps the opacity of the colour it
 * replaces. A value with nothing to start from (empty, `currentcolor`, a gradient, one that depends on a
 * project variable) opens on black, and choosing a colour replaces it.
 *
 * The native picker reports every step of a drag, and a save takes a moment to come back. So the input
 * shows what was last picked until the saved value changes, and each step is worked out from the last one
 * sent: dragging from red to blue and back to red before the first save lands ends on red.
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
  /** Receives the CSS to save. Without it the swatch is a read-only chip. */
  onPick?: (next: string) => void;
  /** Linked to another colour: shown at full strength with a dashed edge, not editable. */
  disabled?: boolean;
  label?: string;
  title?: string;
  className?: string;
}) {
  const rgba = resolveCssColor(value);
  const empty = !value.trim();
  const unreadable = !rgba && !empty;
  // `currentcolor` would paint the panel's own text colour; every other value paints as the browser reads it.
  const paints = !empty && !/currentcolor/i.test(value);
  const [draft, setDraft] = useState<string | null>(null);
  const sent = useRef<string | null>(null);
  useEffect(() => {
    setDraft(null);
    sent.current = null;
  }, [value]);
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
            const base = sent.current ?? value;
            const next = colorFromPicker(base, picked, sent.current === null ? rgba : undefined);
            if (next === base) return;
            sent.current = next;
            onPick(next);
          }}
        />
      )}
    </span>
  );
}
