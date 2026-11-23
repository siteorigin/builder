import { describe, expect, it } from 'vitest';
import { statesFailure } from '../../src/runtime/build-diagnostics';
import { LineTail } from '../../src/main/runtime/line-tail';

describe('LineTail', () => {
  it('joins a line that arrives in pieces, and keeps the one that has not ended', () => {
    const t = new LineTail();
    t.write('Error: no element ');
    t.write('with id="gone"\nsecond');
    expect(t.read()).toEqual(['Error: no element with id="gone"', 'second']);
  });

  it('does not split a character that arrives in two chunks', () => {
    const t = new LineTail();
    const bytes = Buffer.from('café — né\n');
    t.write(bytes.subarray(0, 4));
    t.write(bytes.subarray(4));
    expect(t.read()).toEqual(['café — né']);
  });

  it('reads CRLF and bare CR as line ends and skips blank lines', () => {
    const t = new LineTail();
    t.write('a\r\n\r\nb\rc\n');
    expect(t.read()).toEqual(['a', 'b', 'c']);
  });

  it('keeps the last lines and counts the ones it dropped', () => {
    const t = new LineTail(3);
    t.write(Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n') + '\n');
    expect(t.read()).toEqual(['… 7 earlier lines omitted', 'line 7', 'line 8', 'line 9']);
  });

  it('keeps the start of a line that is far too long, and says so, wherever the line ends', () => {
    const t = new LineTail(5, 10);
    t.write('x'.repeat(100));
    t.write('y'.repeat(100));
    expect(t.read()).toEqual([`${'x'.repeat(10)}…`]);
    // The same line with its newline in the chunk, or in a chunk of its own.
    const a = new LineTail(5, 10);
    a.write(`${'z'.repeat(100)}\nnext\n`);
    const b = new LineTail(5, 10);
    b.write('z'.repeat(100));
    b.write('\nnext\n');
    expect(a.read()).toEqual([`${'z'.repeat(10)}…`, 'next']);
    expect(b.read()).toEqual(a.read());
  });

  it('counts a line that has not ended against the limit', () => {
    const t = new LineTail(3);
    t.write('a\nb\nc\nd');
    expect(t.read()).toEqual(['… 1 earlier line omitted', 'b', 'c', 'd']);
  });

  it('reads a CRLF split across chunks as one line break', () => {
    const t = new LineTail();
    t.write('one\r');
    t.write('\ntwo\r\n');
    expect(t.read()).toEqual(['one', 'two']);
  });

  it('can be read more than once without losing a character that arrives later', () => {
    const t = new LineTail();
    const bytes = Buffer.from('é');
    t.write(Buffer.concat([Buffer.from('a'), bytes.subarray(0, 1)]));
    expect(t.read()).toEqual(['a']);
    t.write(Buffer.concat([bytes.subarray(1), Buffer.from('\n')]));
    expect(t.read()).toEqual(['aé']);
  });

  it('keeps the lines that state an error, and the lines after them, when progress follows', () => {
    const t = new LineTail(5, 2000, (l) => /^Error/.test(l), 20, 2);
    t.write('Error: the cause\n    at one (src/a.svelte:3:1)\n    at two (src/b.svelte:4:1)\n    at three (src/c.svelte:5:1)\n');
    for (let i = 0; i < 50; i++) t.write(`progress ${i}\n`);
    expect(t.read()).toEqual(['Error: the cause', '    at one (src/a.svelte:3:1)', '    at two (src/b.svelte:4:1)', '… 46 lines omitted', 'progress 45', 'progress 46', 'progress 47', 'progress 48', 'progress 49']);
  });

  it('gives a line the same ending whether the blank after its limit arrives with it or later', () => {
    const together = new LineTail(5, 10);
    together.write(`short${' '.repeat(40)}\n`);
    const apart = new LineTail(5, 10);
    apart.write(`short${' '.repeat(40)}`);
    apart.write('\n');
    expect(apart.read()).toEqual(together.read());
    expect(together.read()).toEqual(['short']);
    const blank = new LineTail(5, 10);
    blank.write(' '.repeat(30));
    blank.write(' '.repeat(30));
    blank.write('\nnext\n');
    expect(blank.read()).toEqual(['next']);
  });

  it('keeps the latest errors as well as the first, once the room for the first is full', () => {
    const t = new LineTail(2, 2000, (l) => /^Error/.test(l), 4, 0);
    for (let i = 0; i < 10; i++) t.write(`Error ${i}\nok ${i}\n`);
    const errors = t.read().filter((l) => l.startsWith('Error'));
    expect(errors.slice(0, 4)).toEqual(['Error 0', 'Error 1', 'Error 2', 'Error 3']);
    expect(errors).toContain('Error 9');
    expect(errors).toContain('Error 8');
  });

  it('hides a credential as the line is taken, even one the line limit would cut in two', () => {
    const t = new LineTail(5, 30);
    t.write('const password = "supersecretvalue-0123456789";\n');
    t.write('const apiKey = "another-secret-value-99999999');
    const lines = t.read();
    expect(lines.join('\n')).not.toMatch(/supersecret|another-secret/);
    expect(lines).toEqual(['const password = "…";', 'const apiKey = "…']);
  });

  it('keeps each of the first errors with its own stack, however long the stacks are', () => {
    const t = new LineTail(2, 2000, (l) => /^Error/.test(l), 10, 10);
    for (let i = 0; i < 10; i++) t.write(`Error ${i}\n${Array.from({ length: 10 }, (_, k) => `    at frame ${i}.${k}`).join('\n')}\n`);
    for (let i = 10; i < 200; i++) t.write(`Error ${i}\nok ${i}\n`);
    const lines = t.read();
    for (let i = 0; i < 10; i++) expect(lines).toContain(`Error ${i}`);
    expect(lines).toContain('    at frame 9.9');
  });

  it('does not show the start of a URL’s password that the line limit cut off', () => {
    const t = new LineTail(5, 30);
    t.write('fetching https://ada:supersecretpass');
    t.write('word@example.com/x and more text after it');
    expect(t.read().join('\n')).not.toMatch(/supersecret/);
  });

  it('keeps an exception and its stack when many failed requests follow it', () => {
    const t = new LineTail(2, 2000, statesFailure, 2, 3);
    t.write('Error: the exception\n    at one (src/a.svelte:1:1)\n');
    for (let i = 0; i < 100; i++) t.write(`500 GET /page-${i}/\nok ${i}\n`);
    expect(t.read()).toContain('    at one (src/a.svelte:1:1)');
  });

  it('shows a clipped unfinished line even when what it kept is blank', () => {
    const t = new LineTail(5, 10);
    t.write(`${' '.repeat(12)}text`);
    expect(t.read()).toEqual(['…']);
  });

  it('stops keeping errors once it holds as many as it may', () => {
    const t = new LineTail(2, 2000, (l) => /^Error/.test(l), 2, 0);
    for (let i = 0; i < 100; i++) t.write(`Error ${i}\nok ${i}\n`);
    // The first two, and the most recent: the room for recent ones is half the room for the first (one here).
    expect(t.read().filter((l) => l.startsWith('Error'))).toEqual(['Error 0', 'Error 1', 'Error 99']);
  });
});
