import { describe, expect, it } from 'vitest';
import { readNumberDraft } from '../../src/renderer/src/lib/number-draft';

describe('text typed in a number property', () => {
  it('saves nothing when emptied, so the saved value comes back instead of 0', () => {
    expect(readNumberDraft('')).toEqual({ empty: true });
    expect(readNumberDraft('   ')).toEqual({ empty: true });
    expect(readNumberDraft('', { min: 1, max: 10 })).toEqual({ empty: true });
  });

  it('saves a number written in full, with spaces around it ignored', () => {
    expect(readNumberDraft(' 12 ')).toEqual({ value: 12 });
    expect(readNumberDraft('-0.5')).toEqual({ value: -0.5 });
    expect(readNumberDraft('.5')).toEqual({ value: 0.5 });
    expect(readNumberDraft('3.')).toEqual({ value: 3 });
    expect(readNumberDraft('+4')).toEqual({ value: 4 });
    expect(readNumberDraft('1e3')).toEqual({ value: 1000 });
    expect(readNumberDraft('0')).toEqual({ value: 0 });
  });

  it('refuses a number with a unit, naming the unit, rather than saving NaN', () => {
    expect(readNumberDraft('12px')).toEqual({ problem: 'Type the number alone, without “px”.' });
    expect(readNumberDraft('1.5 rem')).toEqual({ problem: 'Type the number alone, without “rem”.' });
    expect(readNumberDraft('50%')).toEqual({ problem: 'Type the number alone, without “%”.' });
  });

  it('refuses text that is not a number written in full', () => {
    for (const t of ['abc', '1,200', '0x10', '1e', '--1', '1 2', 'Infinity', 'NaN', '.']) {
      expect(readNumberDraft(t), t).toEqual({ problem: 'Type a number, such as 12.' });
    }
    expect(readNumberDraft('abc', { min: 1, max: 6 })).toEqual({ problem: 'Type a number from 1 to 6.' });
    expect(readNumberDraft('1e309')).toEqual({ problem: 'That number is too large to save.' });
  });

  it('keeps to the property’s bounds, either end included', () => {
    const bounds = { min: 0, max: 6 };
    expect(readNumberDraft('0', bounds)).toEqual({ value: 0 });
    expect(readNumberDraft('6', bounds)).toEqual({ value: 6 });
    expect(readNumberDraft('-1', bounds)).toEqual({ problem: 'Use a number from 0 to 6.' });
    expect(readNumberDraft('7', bounds)).toEqual({ problem: 'Use a number from 0 to 6.' });
    expect(readNumberDraft('-1', { min: 0 })).toEqual({ problem: 'Use a number of at least 0.' });
    expect(readNumberDraft('11', { max: 10 })).toEqual({ problem: 'Use a number of at most 10.' });
    // A step is guidance, as the engine treats it: a value between steps still saves.
    expect(readNumberDraft('2.5', bounds)).toEqual({ value: 2.5 });
  });
});
