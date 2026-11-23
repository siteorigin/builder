import { colorFromPicker, toHex6 } from '@shared/color';
import { resolveCssColor } from '../lib/color';

/**
 * A colour swatch that shows the saved CSS colour as it renders (opacity over a checkerboard, wide-gamut
 * colours as the browser paints them) and, given `onPick`, opens the native picker over it. The picker
 * starts from the colour in effect, never from black, and a pick keeps the opacity of the colour it
 * replaces. An empty value has nothing to start from, so the picker opens on black. Colours it cannot
 * start from (`currentcolor`, one that depends on a project variable) show unpicked and the picker stays
 * shut, because a pick would silently replace them: the text value is the way to edit them.
 */
export function ColorPick({
  value,
  onPick,
  disabled,
  replaceUnreadable,
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
  /** For a value still being typed: a pick may replace text that is not a colour (yet). */
  replaceUnreadable?: boolean;
  label?: string;
  title?: string;
  className?: string;
}) {
  const rgba = resolveCssColor(value);
  const unreadable = !rgba && !!value.trim() && !replaceUnreadable;
  const open = !!onPick && !disabled && !unreadable;
  const state = disabled ? ' linked' : onPick && unreadable ? ' unavailable' : '';
  const why = title ?? (state === ' unavailable' ? 'The picker cannot read this color. Edit its value as text.' : undefined);
  return (
    <span className={`color-pick${state}${className ? ` ${className}` : ''}`} title={why} data-color-pick>
      <span className="color-pick-fill" style={rgba ? { background: value } : undefined} aria-hidden="true" />
      {onPick && (
        <input
          type="color"
          disabled={!open}
          value={rgba ? toHex6(rgba) : '#000000'}
          aria-label={label}
          onChange={(e) => {
            const next = colorFromPicker(value, e.target.value, rgba);
            if (next !== value) onPick(next);
          }}
        />
      )}
    </span>
  );
}
