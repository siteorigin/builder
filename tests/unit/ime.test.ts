import { describe, expect, it } from 'vitest';
import { isImeComposing } from '../../src/renderer/src/lib/ime';

describe('isImeComposing', () => {
  it('treats the Enter that accepts a candidate as composing', () => {
    expect(isImeComposing({ nativeEvent: { isComposing: true, keyCode: 229 } })).toBe(true);
    expect(isImeComposing({ nativeEvent: { isComposing: true } })).toBe(true);
  });
  it('catches the 229 keyCode even when isComposing already cleared', () => {
    expect(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(true);
  });
  it('lets an ordinary Enter through', () => {
    expect(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 13 } })).toBe(false);
    expect(isImeComposing({ nativeEvent: {} })).toBe(false);
  });
});
