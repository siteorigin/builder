import { StringDecoder } from 'node:string_decoder';
import { maskSecrets } from '../../runtime/build-diagnostics';

type Entry = { n: number; text: string };

/**
 * The lines a process wrote to one stream, kept while it runs: the last `maxLines`, plus the lines `important` picks
 * out (each with the few lines after it, a stack) from the first `maxGroups` of them and from the most recent half
 * as many, so progress output that comes after an error cannot bury the first cause or the last one. Chunks may
 * split a line, or a multi-byte character, anywhere; a line that never ends keeps its first `maxLine` characters.
 * Credentials are masked as lines are taken, before any line is cut short. Where lines are missing the tail says so.
 */
export class LineTail {
  private decoder = new StringDecoder('utf8');
  private tail: Entry[] = [];
  /** An important line and the lines that followed it. */
  private head: Entry[][] = [];
  private recent: Entry[][] = [];
  private current: Entry[] | null = null;
  private partial = '';
  private clipped = false;
  /** Lines taken so far (blank ones are not lines). */
  private count = 0;
  private context = 0;

  constructor(
    private maxLines = 200,
    private maxLine = 2000,
    private important?: (line: string) => boolean,
    private maxGroups = 30,
    private contextLines = 10
  ) {}

  write(chunk: string | Uint8Array): void {
    this.partial += typeof chunk === 'string' ? chunk : this.decoder.write(Buffer.from(chunk));
    const parts = this.partial.split(/\r\n|\n|\r/);
    this.partial = parts.pop() ?? '';
    for (const line of parts) {
      this.push(this.clipped ? `${line.slice(0, this.maxLine)}…` : line);
      this.clipped = false;
    }
    // A line that goes on past the limit keeps its start, and says so when it ends (unless all that goes on is blank).
    if (this.partial.length > this.maxLine) {
      this.partial = maskSecrets(this.partial);
      if (this.partial.slice(this.maxLine).trim()) this.clipped = true;
      // What was cut may have held the end of a URL's password: the part that is left is not shown.
      this.partial = this.partial.slice(0, this.maxLine).replace(/(:\/\/)[^\s/:@?#]+:[^\s/@?#]*$/, '$1…');
    }
  }

  private push(line: string): void {
    const masked = maskSecrets(line).trimEnd();
    if (!masked.trim()) return;
    const entry = { n: this.count++, text: masked.length > this.maxLine ? `${masked.slice(0, this.maxLine)}…` : masked };
    this.tail.push(entry);
    if (this.tail.length > this.maxLines) this.tail.shift();
    if (this.important?.(entry.text)) {
      this.current = [entry];
      this.context = this.contextLines;
      if (this.head.length < this.maxGroups) this.head.push(this.current);
      else {
        this.recent.push(this.current);
        if (this.recent.length > this.maxGroups / 2) this.recent.shift();
      }
    } else if (this.context > 0 && this.current) {
      this.context--;
      this.current.push(entry);
    }
  }

  /** The lines so far, in the order they were written, including a last line that has not ended yet. */
  read(): string[] {
    const last = maskSecrets(this.partial).trimEnd();
    const unfinished = last.trim() || this.clipped ? [{ n: this.count, text: this.clipped ? `${last}…` : last }] : [];
    const tail = [...this.tail, ...unfinished].slice(-this.maxLines);
    const seen = new Set(tail.map((e) => e.n));
    const kept = [...this.head, ...this.recent].flat().filter((e) => !seen.has(e.n));
    const all = [...new Map(kept.map((e) => [e.n, e])).values(), ...tail].sort((a, b) => a.n - b.n);
    const out: string[] = [];
    let next = 0;
    for (const e of all) {
      if (e.n > next) out.push(next === 0 ? `… ${e.n} earlier line${e.n === 1 ? '' : 's'} omitted` : `… ${e.n - next} line${e.n - next === 1 ? '' : 's'} omitted`);
      out.push(e.text);
      next = e.n + 1;
    }
    return out;
  }
}
