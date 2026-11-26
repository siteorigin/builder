// The sidebar lists' find (Pages, Posts): text folded once for finding and marking, and the letters a find marks.
import { describe, expect, it } from 'vitest';
import { fold, folded } from '../../src/renderer/src/lib/fold';
import { found } from '../../src/renderer/src/components/ListText';

const marked = (text: string, word: string) => {
  const chars = [...text];
  return found(text, [fold(word)])
    .map((on, i) => (on ? chars[i] : ''))
    .join('');
};

describe('finding in the sidebar lists', () => {
  it('folds case and accents, a character at a time', () => {
    expect(fold('Kōwhai Street')).toBe('kowhai street');
    expect(fold('ΦΩΣ')).toBe('φωσ');
  });

  it('marks the letters found, after an emoji too', () => {
    expect(marked('🌿 A garden', 'garden')).toBe('garden');
    expect(marked('Kōwhai Street', 'kowhai')).toBe('Kōwhai');
    expect(marked('ΦΩΣ', 'φως')).toBe('ΦΩΣ');
    // One index per UTF-16 unit of the folded text, each pointing at its character in the original.
    expect(folded('🌿a').at).toEqual([0, 0, 1]);
  });

  it('marks nothing for a word that folds to nothing, and returns', () => {
    expect(found('Winter hours', [fold('\u0301')])).toEqual(new Array([...'Winter hours'].length).fill(false));
  });
});
