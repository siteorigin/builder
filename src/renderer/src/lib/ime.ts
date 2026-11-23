/**
 * True while an input method is mid-composition. Chromium reports the Enter that accepts a candidate
 * (and the Escape that cancels one) with `isComposing` set and `keyCode` 229, so key handlers that submit,
 * commit or cancel must ignore those events and let the next ordinary key press do the action.
 */
export function isImeComposing(e: { nativeEvent: { isComposing?: boolean; keyCode?: number } }): boolean {
  return e.nativeEvent.isComposing === true || e.nativeEvent.keyCode === 229;
}
