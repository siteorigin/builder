/** What text typed in a number field saves: nothing (it was emptied), a number, or the reason it can't be saved. */
export type NumberDraft = { empty: true } | { value: number } | { problem: string };

/** A number written out in full: a sign, digits with an optional decimal point, and an optional exponent. */
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
/** A number followed by a unit ("12px", "1.5 rem", "50%"). */
const WITH_UNIT = /^[-+]?(?:\d+\.?\d*|\.\d+)\s*([a-z%]+)$/i;

/**
 * Text typed in a number property's field, read as it would be saved. A finite number written in full ("12", "-0.5",
 * ".5", "1e3", spaces around it ignored) saves when it is within the property's bounds, either end included. An
 * emptied field saves nothing, so the saved value comes back. Anything else ("12px", "1,200", "abc") is refused with
 * the reason, rather than saved as a number the author did not write.
 */
export function readNumberDraft(text: string, bounds: { min?: number; max?: number } = {}): NumberDraft {
  const t = text.trim();
  if (!t) return { empty: true };
  const { min, max } = bounds;
  const range = min !== undefined && max !== undefined ? `from ${min} to ${max}` : min !== undefined ? `of at least ${min}` : max !== undefined ? `of at most ${max}` : '';
  // A lone "e" is an exponent left unfinished ("1e"), not a unit.
  const unit = WITH_UNIT.exec(t)?.[1];
  if (unit && unit.toLowerCase() !== 'e') return { problem: `Type the number alone, without “${unit}”.` };
  const n = NUMBER.test(t) ? Number(t) : NaN;
  if (Number.isNaN(n)) return { problem: range ? `Type a number ${range}.` : 'Type a number, such as 12.' };
  if (!Number.isFinite(n)) return { problem: range ? `Type a number ${range}.` : 'That number is too large to save.' };
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) return { problem: `Use a number ${range}.` };
  return { value: n };
}
