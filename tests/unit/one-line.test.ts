import { describe, expect, it } from 'vitest';
import { oneLine } from '../../src/renderer/src/lib/one-line';

describe('text as one line', () => {
  it('turns a line break, and the spaces around it, into one space', () => {
    expect(oneLine('Spring glaze tests\nand what we learned')).toBe('Spring glaze tests and what we learned');
    expect(oneLine('Spring glaze tests  \n  and what we learned')).toBe('Spring glaze tests and what we learned');
    expect(oneLine('Spring glaze tests\t\n\tand what we learned')).toBe('Spring glaze tests and what we learned');
  });

  it('treats every kind of line break the same, and a run of them as one', () => {
    expect(oneLine('one\r\ntwo')).toBe('one two');
    expect(oneLine('one\rtwo')).toBe('one two');
    expect(oneLine('one\u2028two\u2029three')).toBe('one two three');
    expect(oneLine('one\n\n\r\n two')).toBe('one two');
    expect(oneLine('one\n  \n two')).toBe('one two');
  });

  it('drops a break at either end of the text, so a copied line does not gain a space', () => {
    expect(oneLine('Spring glaze tests\n')).toBe('Spring glaze tests');
    expect(oneLine('\r\nSpring glaze tests \r\n')).toBe('Spring glaze tests');
    expect(oneLine('\n\n')).toBe('');
  });

  it('leaves text without a break exactly as it is', () => {
    expect(oneLine('Designing for Winter Light in the Pacific Northwest')).toBe('Designing for Winter Light in the Pacific Northwest');
    expect(oneLine('  two  spaces  ')).toBe('  two  spaces  ');
    expect(oneLine('')).toBe('');
  });

  it('counts a title by the characters it saves: more than the limit with breaks, the limit without', () => {
    const raw = `${'a'.repeat(100)}\r\n${'b'.repeat(99)}`;
    expect(raw.length).toBe(201);
    expect(oneLine(raw).length).toBe(200);
  });

  it('is linear in the text: a huge run of spaces is not a stall', () => {
    const spaces = ' '.repeat(300_000);
    const started = Date.now();
    expect(oneLine(`${spaces}x${spaces}`)).toBe(`${spaces}x${spaces}`);
    expect(oneLine(`${spaces}x${spaces}\nend`)).toBe(`${spaces}x end`);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
