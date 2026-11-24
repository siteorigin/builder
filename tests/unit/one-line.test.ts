import { describe, expect, it } from 'vitest';
import { oneLine } from '../../src/renderer/src/lib/one-line';

describe('text as one line', () => {
  it('turns a line break, and the spaces around it, into one space', () => {
    expect(oneLine('Spring glaze tests\nand what we learned')).toBe('Spring glaze tests and what we learned');
    expect(oneLine('Spring glaze tests  \n  and what we learned')).toBe('Spring glaze tests and what we learned');
  });

  it('treats every kind of line break the same, and a run of them as one', () => {
    expect(oneLine('one\r\ntwo')).toBe('one two');
    expect(oneLine('one\rtwo')).toBe('one two');
    expect(oneLine('one\u2028two\u2029three')).toBe('one two three');
    expect(oneLine('one\n\n\r\n two')).toBe('one two');
  });

  it('leaves a trailing break as a space for the field to trim, and plain text as it is', () => {
    expect(oneLine('Spring glaze tests\n')).toBe('Spring glaze tests ');
    expect(oneLine('Designing for Winter Light in the Pacific Northwest')).toBe('Designing for Winter Light in the Pacific Northwest');
    expect(oneLine('  two  spaces  ')).toBe('  two  spaces  ');
    expect(oneLine('')).toBe('');
  });

  it('is what keeps a title under its limit by the characters it saves', () => {
    const raw = `${'a'.repeat(100)}\n\n${'b'.repeat(98)}`;
    expect(raw.length).toBe(200);
    expect(oneLine(raw).length).toBe(199);
  });
});
