import { parseColor, type Rgba } from '@shared/color';
import { normalizeColorText } from '@shared/color-names';
import { validateStyleValue } from '@shared/styles';

let probe: HTMLElement | null = null;
const SRGB = /^color\(srgb ([-+\d.e]+) ([-+\d.e]+) ([-+\d.e]+)(?: \/ ([-+\d.e]+%?))?\)$/i;

/** What the browser makes of a colour the parser leaves alone (a `color-mix()` of literals), as sRGB; null when it cannot say. */
function browserColor(value: string): Rgba | null {
  // `currentcolor` and `var()` depend on where the colour is used: there is nothing to start a picker from.
  if (typeof document === 'undefined' || /currentcolor|var\(/i.test(value)) return null;
  if (!probe) {
    probe = document.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.display = 'none';
    document.body.appendChild(probe);
  }
  probe.style.color = '';
  // Relative colour syntax makes the browser hand back sRGB channels for any colour it can read.
  probe.style.color = `color(from ${value} srgb r g b / alpha)`;
  if (!probe.style.color) return null;
  const out = getComputedStyle(probe).color;
  const m = SRGB.exec(out);
  if (!m) return parseColor(out);
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : Number(m[4]);
  const c = { r: Number(m[1]) * 255, g: Number(m[2]) * 255, b: Number(m[3]) * 255, a };
  return [c.r, c.g, c.b, c.a].every(Number.isFinite) ? { ...c, a: Math.min(1, Math.max(0, c.a)) } : null;
}

/** A saved CSS colour as sRGB: the pure parser first, then the browser; null when neither can resolve it. */
export function resolveCssColor(value: string): Rgba | null {
  return parseColor(value) ?? browserColor(value);
}

/**
 * Why text typed in a colour field can't be saved as `propId` (a site colour is checked as 'color'), or null when it
 * can, written as `normalizeColorText` saves it. Empty text is the field's own to handle (it puts the value back).
 * Refused text is never sent, so it stays in the field with this reason beside it, and nothing is left over the canvas.
 */
export function colorFieldProblem(text: string, propId = 'color'): { message: string } | null {
  if (!text.trim()) return null;
  const err = validateStyleValue(propId, normalizeColorText(text));
  return err ? { message: err } : null;
}
