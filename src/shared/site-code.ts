/**
 * The site's own code (#1485): markup for the <head> of every page, and a stylesheet loaded after every other. Both are
 * the author's, kept as typed in site.json, and checked here before they are kept, so neither can break the website
 * it goes into: the head markup holds only the elements a <head> can (the generator places it in the root layout's
 * <svelte:head>, for the published website alone), and the stylesheet parses as the website's build reads it (Vite's
 * build minifies CSS with lightningcss, which stops the build on a selector or block it cannot read).
 *
 * Neither check is a sandbox: a script in the head runs on every page of the published website, as its author means
 * it to. That is why both need Developer mode (engine/developer-mode.ts).
 */
import type { SiteDoc } from './types';

/** The most head markup a site keeps, in UTF-16 code units. */
export const HEAD_CODE_MAX = 32 * 1024;
/** The most CSS a site keeps, in UTF-16 code units. */
export const GLOBAL_CSS_MAX = 64 * 1024;

/** What is wrong with a piece of the site's code, and where: 1-based line and column. */
export interface CodeProblem {
  message: string;
  line: number;
  column: number;
}

/** A problem as a sentence that says where it is. */
export const codeProblemText = (what: string, p: CodeProblem): string => `${what}, line ${p.line}, column ${p.column}: ${p.message}`;

class Refusal {
  constructor(
    readonly message: string,
    readonly at: number
  ) {}
}

function located(text: string, at: number, message: string): CodeProblem {
  const before = text.slice(0, Math.max(0, Math.min(at, text.length)));
  const lines = before.split('\n');
  return { message, line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/** Runs a check that refuses with a Refusal, as a problem or null. */
function checked(text: string, check: () => void): CodeProblem | null {
  try {
    check();
    return null;
  } catch (e) {
    if (e instanceof Refusal) return located(text, e.at, e.message);
    throw e;
  }
}

const WS = /[\t\n\f\r ]/;

// ---------------------------------------------------------------------------
// Head markup
// ---------------------------------------------------------------------------

/** The elements head markup may hold. Everything else a page needs in its <head>, the website writes itself. */
const HEAD_ELEMENTS = new Set(['meta', 'link', 'script', 'style']);
const VOID = new Set(['meta', 'link']);
const ONLY_HEAD = 'Head code holds only <meta>, <link>, <script> and <style> elements, and comments.';

/** Why an element other than the four cannot be in head markup. */
function elementRefusal(name: string): string {
  if (name === 'html' || name === 'head' || name === 'body') return `Head code holds what goes inside <head>, without the <${name}> tag itself.`;
  if (name === 'title') return 'Each page’s <title> comes from its title and SEO settings, not head code.';
  if (name === 'base') return 'A <base> element would change where every link on the site leads.';
  if (name === 'noscript') return '<noscript> is not supported in head code. Leave it out: the script beside it does the work.';
  return `<${name}> cannot go in the head. ${ONLY_HEAD}`;
}

/**
 * What is wrong with head markup, or null when it is fine: a strict reading of HTML, so a browser and Svelte's
 * hydration of the layout both read it as written. Every element is closed as HTML closes it (a <script> or <style> by
 * its own end tag), attributes are well formed, and nothing but those elements, comments and white space is there.
 */
export function headCodeProblem(text: string): CodeProblem | null {
  return checked(text, () => readHead(text));
}

function readHead(src: string): void {
  if (src.length > HEAD_CODE_MAX) throw new Refusal(`Head code can be at most ${HEAD_CODE_MAX.toLocaleString('en')} characters long.`, HEAD_CODE_MAX);
  const nul = src.indexOf('\u0000');
  if (nul >= 0) throw new Refusal('Head code cannot hold a NUL character.', nul);
  const placeholder = src.search(/%sveltekit\./i);
  if (placeholder >= 0) throw new Refusal('“%sveltekit.” is SvelteKit’s own placeholder and cannot be in head code.', placeholder);
  let i = 0;
  // The last raw-text element read, for the hint when text follows its end tag early.
  let lastRaw: string | null = null;
  while (i < src.length) {
    const c = src[i];
    if (WS.test(c)) {
      i++;
      continue;
    }
    if (src.startsWith('<!--', i)) {
      i = readComment(src, i);
      lastRaw = null;
      continue;
    }
    if (c === '<' && /[a-zA-Z]/.test(src[i + 1] ?? '')) {
      const read = readElement(src, i);
      i = read.end;
      lastRaw = read.raw ? read.name : null;
      continue;
    }
    if (c === '<' && src[i + 1] === '/') {
      const name = /^<\/([a-zA-Z][a-zA-Z0-9-]*)/.exec(src.slice(i))?.[1];
      throw new Refusal(name ? `</${name.toLowerCase()}> closes nothing.` : 'An end tag needs a name.', i);
    }
    if (c === '<' && (src[i + 1] === '!' || src[i + 1] === '?')) throw new Refusal(`Head code cannot hold a doctype or other declaration. ${ONLY_HEAD}`, i);
    // A script that writes "</script>" in a string ends there, and the rest of it reads as text.
    if (lastRaw) throw new Refusal(`Text follows </${lastRaw}>. A <${lastRaw}> ends at the first “</${lastRaw}” in it, even inside a string: write it as “<\\/${lastRaw}” there.`, i);
    throw new Refusal(`Text cannot go in the head. ${ONLY_HEAD}`, i);
  }
}

/** Reads a comment at `i`, giving the index after it. A comment HTML reads as empty would end Svelte's {@html} early. */
function readComment(src: string, i: number): number {
  const start = i + 4;
  if (src.startsWith('>', start) || src.startsWith('->', start)) throw new Refusal('This comment closes as soon as it opens: write it as <!-- text -->.', i);
  const end = src.indexOf('-->', start);
  if (end < 0) throw new Refusal('This comment is never closed with -->.', i);
  const body = src.slice(start, end);
  if (body === '') throw new Refusal('An empty comment (<!---->) cannot be in head code: put some text in it, or remove it.', i);
  const early = body.indexOf('--!>');
  if (early >= 0) throw new Refusal('“--!>” ends a comment early.', start + early);
  return end + 3;
}

/** Reads an element at `i`: its start tag, and for a script or style its text and end tag. */
function readElement(src: string, i: number): { end: number; name: string; raw: boolean } {
  const at = i;
  const name = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(src.slice(i))![1].toLowerCase();
  if (!HEAD_ELEMENTS.has(name)) throw new Refusal(elementRefusal(name), at);
  i += name.length + 1;
  const attrs = new Map<string, string>();
  let selfClosed = false;
  for (;;) {
    while (i < src.length && WS.test(src[i])) i++;
    if (i >= src.length) throw new Refusal(`This <${name}> tag is never closed with >.`, at);
    if (src[i] === '>') {
      i++;
      break;
    }
    if (src[i] === '/') {
      if (src[i + 1] !== '>') throw new Refusal(`A “/” in a tag can only come just before its >.`, i);
      selfClosed = true;
      i += 2;
      break;
    }
    const nameAt = i;
    while (i < src.length && !WS.test(src[i]) && !'/>='.includes(src[i])) i++;
    const attr = src.slice(nameAt, i).toLowerCase();
    if (!attr || /["'<\u0000-\u001f\u007f]/.test(attr)) throw new Refusal(`This <${name}> tag has an attribute name it cannot have.`, nameAt);
    if (attrs.has(attr)) throw new Refusal(`This <${name}> tag names its ${attr} attribute twice.`, nameAt);
    while (i < src.length && WS.test(src[i])) i++;
    let value = '';
    if (src[i] === '=') {
      i++;
      while (i < src.length && WS.test(src[i])) i++;
      const q = src[i];
      if (q === '"' || q === "'") {
        const close = src.indexOf(q, i + 1);
        if (close < 0) throw new Refusal(`The value of ${attr} is never closed with its ${q}.`, i);
        value = src.slice(i + 1, close);
        i = close + 1;
        if (i < src.length && !WS.test(src[i]) && src[i] !== '>' && src[i] !== '/') throw new Refusal(`Attributes need a space between them.`, i);
      } else {
        const valueAt = i;
        while (i < src.length && !WS.test(src[i]) && src[i] !== '>') i++;
        value = src.slice(valueAt, i);
        if (!value) throw new Refusal(`${attr}= needs a value.`, valueAt);
        if (/["'<=`]/.test(value)) throw new Refusal(`The value of ${attr} needs quotes around it.`, valueAt);
      }
    }
    attrs.set(attr, value);
  }
  if (name === 'meta') {
    if (attrs.has('charset')) throw new Refusal('The website already says its character set (UTF-8).', at);
    if (attrs.has('http-equiv')) throw new Refusal('A <meta http-equiv> stands in for a header the host sends: set it in the host’s settings instead.', at);
    if ((attrs.get('name') ?? '').trim().toLowerCase() === 'viewport') throw new Refusal('The website already sets the viewport, for its layouts at every size.', at);
  }
  if (VOID.has(name)) return { end: i, name, raw: false };
  if (selfClosed) throw new Refusal(`<${name}/> does not close in HTML: write <${name}></${name}>.`, at);
  // The text of a script or style ends at its first end tag, whatever it is inside.
  const close = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'i');
  const rest = src.slice(i);
  const m = close.exec(rest);
  if (!m) throw new Refusal(`This <${name}> is never closed with </${name}>.`, at);
  const body = rest.slice(0, m.index);
  // In a script, "<!--" turns on HTML's old escaping, where a "</script>" may not end it after all.
  const escaped = name === 'script' ? body.indexOf('<!--') : -1;
  if (escaped >= 0) throw new Refusal('A script cannot hold “<!--”: split it as “<!-” + “-” where a string needs it.', i + escaped);
  i += m.index + name.length + 2;
  while (i < src.length && WS.test(src[i])) i++;
  if (src[i] !== '>') throw new Refusal(`</${name}> holds nothing but its name.`, i);
  return { end: i + 1, name, raw: true };
}

// ---------------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------------

/** At-rules whose block holds declarations (and, in @page, its margin boxes), not rules. */
const DECLARATION_BLOCKS = new Set(['font-face', 'page', 'property', 'counter-style', 'font-palette-values', 'view-transition', 'position-try', 'top-left-corner', 'top-left', 'top-center', 'top-right', 'top-right-corner', 'bottom-left-corner', 'bottom-left', 'bottom-center', 'bottom-right', 'bottom-right-corner', 'left-top', 'left-middle', 'left-bottom', 'right-top', 'right-middle', 'right-bottom']);
const KEYFRAMES = new Set(['keyframes', '-webkit-keyframes', '-moz-keyframes', '-o-keyframes']);
/** Pseudo-classes whose argument is a selector list, checked as one (`has` takes relative selectors). */
const SELECTOR_ARGS = new Set(['is', 'where', 'not', 'has', 'matches', '-webkit-any', '-moz-any', 'host', 'host-context', 'slotted', 'cue']);

/** What a block holds: rules (a stylesheet's, or @media's at its top), a style rule's mix, declarations, or keyframes. */
type Block = 'rules' | 'mixed' | 'declarations' | 'keyframes';

/**
 * What is wrong with the site's stylesheet, or null when it is fine: rules, at-rules and declarations, each block closed,
 * each selector one a browser and the website's build both read, each `!` an `!important` at the end of its value, and
 * each `url()` an address that works from every page (https:, data:, or a path from the site's root). `@import` is not
 * kept: a stylesheet from elsewhere goes in the head code as a <link>.
 */
export function globalCssProblem(text: string): CodeProblem | null {
  return checked(text, () => {
    if (text.length > GLOBAL_CSS_MAX) throw new Refusal(`The site’s CSS can be at most ${GLOBAL_CSS_MAX.toLocaleString('en')} characters long.`, GLOBAL_CSS_MAX);
    new CssReader(text).stylesheet();
  });
}

class CssReader {
  i = 0;
  constructor(readonly src: string) {}

  fail(message: string, at = this.i): never {
    throw new Refusal(message, at);
  }

  /** Skips white space and comments. */
  space(): void {
    const s = this.src;
    for (;;) {
      if (this.i < s.length && WS.test(s[this.i])) this.i++;
      else if (s.startsWith('/*', this.i)) {
        const end = s.indexOf('*/', this.i + 2);
        if (end < 0) this.fail('This comment is never closed with */.');
        this.i = end + 2;
      } else return;
    }
  }

  /** Index after the string that opens at `at`. */
  stringEnd(at: number): number {
    const s = this.src;
    const q = s[at];
    let j = at + 1;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\') {
        if (j + 1 >= s.length) break;
        j += 2;
        continue;
      }
      if (c === q) return j + 1;
      if (c === '\n' || c === '\r' || c === '\f') this.fail('This string reaches the end of its line without its closing quote.', at);
      j++;
    }
    return this.fail('This string is never closed with its quote.', at);
  }

  /**
   * Reads from here to the first of `stops` outside strings, comments and brackets, giving where it stopped (the
   * stop's index, or the end of the text). Braces nest only while `braces` is true (a custom property's value).
   */
  scan(stops: string, braces = false): number {
    const s = this.src;
    const open: Array<[string, number]> = [];
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    let j = this.i;
    while (j < s.length) {
      const c = s[j];
      if (c === '"' || c === "'") {
        j = this.stringEnd(j);
        continue;
      }
      if (s.startsWith('/*', j)) {
        const end = s.indexOf('*/', j + 2);
        if (end < 0) this.fail('This comment is never closed with */.', j);
        j = end + 2;
        continue;
      }
      if (c === '\\') {
        j += 2;
        continue;
      }
      // An unquoted url() is one token to its ")": a quote, bracket or space inside it makes it a bad one.
      if ((c === 'u' || c === 'U') && /^url\(/i.test(s.slice(j, j + 4)) && !/[-a-zA-Z0-9_\\]/.test(s[j - 1] ?? '')) {
        let k = j + 4;
        while (k < s.length && WS.test(s[k])) k++;
        if (s[k] !== '"' && s[k] !== "'") {
          const close = s.indexOf(')', k);
          if (close < 0) this.fail('This url( is never closed with ).', j);
          if (/["'(\\]|[\t\n\f\r ]\S/.test(s.slice(k, close))) this.fail('This url() needs quotes around its address.', j);
          j = close + 1;
          continue;
        }
      }
      if (!open.length && stops.includes(c)) return j;
      if (c === '(' || c === '[' || (braces && c === '{')) open.push([pairs[c], j]);
      else if (c === ')' || c === ']' || (braces && c === '}')) {
        const top = open.pop();
        if (!top || top[0] !== c) this.fail(`This “${c}” closes nothing.`, j);
      } else if (c === '{' || c === '}') {
        // Inside brackets, a brace is never part of a selector or a value.
        if (open.length) this.fail(`This “${open[open.length - 1][0] === ')' ? '(' : '['}” is never closed.`, open[open.length - 1][1]);
      }
      j++;
    }
    if (open.length) this.fail(`This “${s[open[open.length - 1][1]]}” is never closed.`, open[open.length - 1][1]);
    return j;
  }

  stylesheet(): void {
    this.items('rules', -1);
  }

  /** Reads the items of a block until its `}` (or, for the stylesheet itself, the end). */
  items(kind: Block, openAt: number): void {
    const s = this.src;
    for (;;) {
      this.space();
      if (this.i >= s.length) {
        if (openAt >= 0) this.fail('This block is never closed with }.', openAt);
        return;
      }
      const c = s[this.i];
      if (c === '}') {
        if (openAt < 0) this.fail('This } closes nothing.');
        this.i++;
        return;
      }
      if (c === ';') {
        if (kind === 'rules' || kind === 'keyframes') this.fail('A “;” here ends nothing.');
        this.i++;
        continue;
      }
      if (c === '@') {
        this.atRule(kind);
        continue;
      }
      if (s.startsWith('<!--', this.i) || s.startsWith('-->', this.i)) this.fail('HTML comment marks cannot be in CSS: write comments as /* … */.');
      if (kind === 'keyframes') {
        this.rule('keyframes');
        continue;
      }
      if (kind === 'rules') {
        this.rule('top');
        continue;
      }
      // A declaration or (in a style rule) a nested rule: a custom property's value can hold braces of its own.
      if (/^--/.test(s.slice(this.i, this.i + 2))) {
        this.declaration(true);
        continue;
      }
      const stop = this.scan('{;}');
      if (s[stop] === '{') {
        if (kind === 'declarations') this.fail('Only declarations go in this block.');
        this.rule('nested');
      } else this.declaration(false);
    }
  }

  /** A rule: its selectors (or keyframe offsets), then its block of declarations and nested rules. */
  rule(where: 'top' | 'nested' | 'keyframes'): void {
    const s = this.src;
    const at = this.i;
    const stop = this.scan('{;}');
    const prelude = s.slice(at, stop);
    if (s[stop] !== '{') {
      const what = prelude.trim().slice(0, 40);
      if (where === 'top' && /^[-a-zA-Z]+\s*:/.test(what)) this.fail(`“${what}” is a declaration with no rule around it: write it inside selector { … }.`, at);
      this.fail(stop >= s.length ? `“${what}” needs a { block } after it.` : `“${what}” needs a { block } before this “${s[stop]}”.`, stop >= s.length ? at : stop);
    }
    if (where === 'keyframes') keyframeSelectors(this, prelude, at);
    else selectorList(this, prelude, at, where === 'nested');
    this.i = stop + 1;
    this.items(where === 'keyframes' ? 'declarations' : 'mixed', stop);
  }

  /** An at-rule, in a block of `kind`. */
  atRule(kind: Block): void {
    const s = this.src;
    const at = this.i;
    const name = /^@(-?[a-zA-Z_][-a-zA-Z0-9_]*)/.exec(s.slice(at))?.[1]?.toLowerCase();
    if (!name) this.fail('An at-rule needs a name after its @.');
    if (name === 'import') this.fail('@import is not supported here: add the stylesheet to the head code as <link rel="stylesheet" href="…">.');
    if (kind === 'keyframes') this.fail('Keyframes hold only from, to and percentages.');
    this.i = at + name.length + 1;
    const stop = this.scan('{;}');
    const prelude = s.slice(this.i, stop);
    urls(this, prelude, this.i);
    if (stop >= s.length) this.fail(`@${name} needs a “;” or a { block } after it.`, at);
    if (s[stop] === '}') {
      // A statement at-rule may end its block without a semicolon, as the last item of it; the block reads the brace.
      this.i = stop;
      return;
    }
    this.i = stop + 1;
    if (s[stop] === ';') return;
    const inner: Block = KEYFRAMES.has(name) ? 'keyframes' : DECLARATION_BLOCKS.has(name) || kind === 'declarations' ? 'declarations' : kind === 'rules' ? 'rules' : 'mixed';
    this.items(inner, stop);
  }

  /** A declaration: a property, a colon and its value, up to the `;` or `}` after it. */
  declaration(custom: boolean): void {
    const s = this.src;
    const at = this.i;
    const name = custom ? /^--[-a-zA-Z0-9_ -￿]*/.exec(s.slice(at))?.[0] : /^-?(?:[a-zA-Z_ -￿]|\\.)(?:[-a-zA-Z0-9_ -￿]|\\.)*/.exec(s.slice(at))?.[0];
    if (!name) {
      const shown = s.slice(at, this.scan(':;{}')).trim().slice(0, 40);
      this.fail(`“${shown}” is not a property name.`, at);
    }
    this.i = at + name.length;
    this.space();
    if (s[this.i] !== ':') this.fail(`“${name}” needs a colon and a value after it.`, at);
    this.i++;
    const valueAt = this.i;
    const stop = this.scan(custom ? ';}' : ';}{', custom);
    if (s[stop] === '{') this.fail(`A value cannot hold “{”: is a “;” or “}” missing before it?`, stop);
    const value = s.slice(valueAt, stop);
    // A colon in a value is where a semicolon went missing ("color: red background: blue"), which stops the build's
    // PostCSS. Brackets and strings may hold one (a data: URL); a custom property's value may hold anything.
    if (!custom) colonInValue(this, value, valueAt);
    important(this, value, valueAt);
    urls(this, value, valueAt);
    this.i = stop;
    if (s[stop] === ';') this.i++;
    // The block's closing brace (or the end of the text) is the block's to read.
  }
}

/** Ranges of `text` outside strings and comments, for looking for tokens that can only be outside them. */
function outsideStrings(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let from = 0;
  let j = 0;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      out.push([from, j]);
      let k = j + 1;
      while (k < text.length && text[k] !== c) k += text[k] === '\\' ? 2 : 1;
      j = from = k + 1;
      continue;
    }
    if (text.startsWith('/*', j)) {
      out.push([from, j]);
      const end = text.indexOf('*/', j + 2);
      j = from = end < 0 ? text.length : end + 2;
      continue;
    }
    j++;
  }
  out.push([from, text.length]);
  return out;
}

/** A colon outside brackets, strings and comments in a value. */
function colonInValue(r: CssReader, value: string, at: number): void {
  // The brackets open where each stretch outside strings starts, carried from one stretch to the next.
  let depth = 0;
  for (const [a, b] of outsideStrings(value)) {
    for (let j = a; j < b; j++) {
      const c = value[j];
      if (c === '\\') j++;
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === ':' && depth <= 0) r.fail('A value cannot hold “:” here: is a “;” missing before it?', at + j);
    }
  }
}

/** Each `!` in a value is the `!important` at its end: the website's build stops at any other. */
function important(r: CssReader, value: string, at: number): void {
  for (const [a, b] of outsideStrings(value)) {
    const k = value.slice(a, b).indexOf('!');
    if (k < 0) continue;
    const rest = value.slice(a + k + 1).replace(/\/\*[\s\S]*?\*\//g, ' ');
    if (!/^\s*important\s*$/i.test(rest)) r.fail('A “!” in a value can only be the !important at its end.', at + a + k);
    return;
  }
}

/** Each url() points somewhere every page can load it from. */
function urls(r: CssReader, value: string, at: number): void {
  const re = /(^|[^-a-zA-Z0-9_\\])url\(/gi;
  for (const [a, b] of outsideStrings(value)) {
    const part = value.slice(a, b);
    re.lastIndex = 0;
    for (let m = re.exec(part); m; m = re.exec(part)) {
      const open = a + m.index + m[1].length + 4;
      let j = open;
      while (j < value.length && WS.test(value[j])) j++;
      let target: string;
      if (value[j] === '"' || value[j] === "'") {
        const q = value[j];
        const close = value.indexOf(q, j + 1);
        target = value.slice(j + 1, close < 0 ? value.length : close);
      } else {
        const close = value.indexOf(')', j);
        target = value.slice(j, close < 0 ? value.length : close).trim();
      }
      if (!usableUrl(target)) r.fail(`url(${target.slice(0, 60)}) needs a full https:// address, a data: URL or a path from the site’s root (/…): a relative path would break from pages at other addresses.`, at + open - 4);
    }
  }
}

const usableUrl = (target: string) => /^(https:|data:|\/|#)/i.test(target.trim()) && !/[\\]/.test(target);

/** The offsets a @keyframes rule names: from, to, or percentages. */
function keyframeSelectors(r: CssReader, prelude: string, at: number): void {
  for (const part of splitList(r, prelude, at)) {
    if (!/^(from|to|[+]?(\d+(\.\d+)?|\.\d+)%)$/i.test(part.text.trim())) r.fail(`“${part.text.trim().slice(0, 40)}” is not a keyframe: use from, to or a percentage.`, part.at);
  }
}

/** The comma-separated parts of a list outside brackets and strings, each with where it starts. */
function splitList(r: CssReader, text: string, at: number): Array<{ text: string; at: number }> {
  const parts: Array<{ text: string; at: number }> = [];
  let depth = 0;
  let from = 0;
  for (let j = 0; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '"' || c === "'") {
      let k = j + 1;
      while (k < text.length && text[k] !== c) k += text[k] === '\\' ? 2 : 1;
      j = k;
      continue;
    }
    if (text.startsWith('/*', j)) {
      const end = text.indexOf('*/', j + 2);
      j = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push({ text: text.slice(from, j), at: at + from });
      from = j + 1;
    }
  }
  parts.push({ text: text.slice(from), at: at + from });
  for (const p of parts) if (!p.text.replace(/\/\*[\s\S]*?\*\//g, '').trim()) r.fail('A selector list has an empty selector in it.', p.at);
  return parts;
}

const IDENT_START = /[a-zA-Z_ -￿]/;
const IDENT_CHAR = /[-a-zA-Z0-9_ -￿]/;

/**
 * A selector list, as the website's build reads it: each selector a series of compound selectors (types, `*`, `&`,
 * classes, IDs, attributes and pseudo-classes) with combinators between them. Only a nested rule's selector (or one in
 * :has()) may start with a combinator; none may end with one or put two together.
 */
function selectorList(r: CssReader, text: string, at: number, relative: boolean): void {
  for (const part of splitList(r, text, at)) selector(r, part.text, part.at, relative);
}

function selector(r: CssReader, text: string, at: number, relative: boolean): void {
  let j = 0;
  // What came last: nothing yet, a compound selector, or a combinator.
  let last: 'start' | 'compound' | 'combinator' = 'start';
  const fail = (message: string, k = j): never => r.fail(message, at + k);
  const ident = (k: number): number => {
    let e = k;
    if (text[e] === '-') e++;
    if (text[e] === '-') e++;
    if (!(IDENT_START.test(text[e] ?? '') || text[e] === '\\' || (e > k + 1 && IDENT_CHAR.test(text[e] ?? '')))) return k;
    while (e < text.length && (IDENT_CHAR.test(text[e]) || text[e] === '\\')) e += text[e] === '\\' ? 2 : 1;
    return e;
  };
  /** Index after the bracket that opens at `k`, closing at its match. */
  const closing = (k: number): number => {
    const open = text[k];
    const shut = open === '(' ? ')' : ']';
    let depth = 0;
    for (let e = k; e < text.length; e++) {
      const c = text[e];
      if (c === '\\') {
        e++;
        continue;
      }
      if (c === '"' || c === "'") {
        let q = e + 1;
        while (q < text.length && text[q] !== c) q += text[q] === '\\' ? 2 : 1;
        e = q;
        continue;
      }
      if (c === open) depth++;
      else if (c === shut && --depth === 0) return e + 1;
    }
    return fail(`This “${open}” is never closed.`, k);
  };
  while (j < text.length) {
    const c = text[j];
    if (WS.test(c) || text.startsWith('/*', j)) {
      if (text.startsWith('/*', j)) {
        const end = text.indexOf('*/', j + 2);
        j = end < 0 ? text.length : end + 2;
      } else j++;
      // White space between compound selectors is the descendant combinator, read once the next one starts.
      continue;
    }
    if (c === '>' || c === '+' || c === '~') {
      if (last === 'combinator') fail(`“${c}” follows another combinator.`);
      if (last === 'start' && !relative) fail(`A selector cannot start with “${c}”.`);
      last = 'combinator';
      j++;
      continue;
    }
    // A compound selector: its parts follow one another with no space between them.
    let k = j;
    let parts = 0;
    for (;;) {
      const d = text[k];
      if (d === undefined || WS.test(d) || d === '>' || d === '+' || d === '~' || text.startsWith('/*', k)) break;
      if (d === '*' || d === '&') k++;
      else if (d === '.' || d === '#') {
        const e = d === '#' ? hashEnd(text, k + 1) : ident(k + 1);
        if (e === k + 1) fail(`“${d}” needs a name after it.`, k);
        k = e;
      } else if (d === '[') {
        attribute(r, text.slice(k + 1, closing(k) - 1), at + k + 1);
        k = closing(k);
      } else if (d === ':') {
        const colons = text[k + 1] === ':' ? 2 : 1;
        const e = ident(k + colons);
        if (e === k + colons) fail('A pseudo-class needs a name after its colon.', k);
        const name = text.slice(k + colons, e).toLowerCase();
        k = e;
        if (text[k] === '(') {
          const end = closing(k);
          const arg = text.slice(k + 1, end - 1);
          if (colons === 1 && SELECTOR_ARGS.has(name)) {
            if (!arg.trim()) fail(`:${name}() needs a selector in it.`, k);
            selectorList(r, arg, at + k + 1, name === 'has');
          }
          k = end;
        }
      } else if (IDENT_START.test(d) || d === '\\' || d === '-') {
        const e = ident(k);
        if (e === k) fail(`“${d}” cannot be in a selector.`, k);
        if (parts) fail('A type selector comes first in a compound selector.', k);
        k = e;
      } else fail(`“${d}” cannot be in a selector.`, k);
      parts++;
    }
    j = k;
    last = 'compound';
  }
  if (last === 'combinator') fail('A selector cannot end with a combinator.', text.trimEnd().length - 1);
  if (last === 'start') fail('A selector list has an empty selector in it.', 0);
}

/** Index after an ID selector's name, which may start with a digit as a hash token can. */
function hashEnd(text: string, k: number): number {
  let e = k;
  while (e < text.length && (IDENT_CHAR.test(text[e]) || text[e] === '\\')) e += text[e] === '\\' ? 2 : 1;
  return e;
}

/** An attribute selector's inside: a name, then optionally an operator and a value, then optionally i or s. */
function attribute(r: CssReader, inner: string, at: number): void {
  const m = /^\s*(?:[-a-zA-Z_ -￿*]*\|)?-?[a-zA-Z_ -￿][-a-zA-Z0-9_ -￿]*\s*(?:([~|^$*]?=)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?[a-zA-Z_ -￿][-a-zA-Z0-9_ -￿]*|-?\d[-a-zA-Z0-9_]*)\s*([iIsS])?\s*)?$/.exec(inner);
  if (!m) r.fail('This attribute selector is not one a browser reads: [name], [name="value"] or [name="value" i].', at);
}

// ---------------------------------------------------------------------------
// The stored values, as the website reads them
// ---------------------------------------------------------------------------

/** Whether a stored piece of code says anything: text with more than white space in it. */
export const hasCode = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The site's head markup as the website writes it: none when it is missing, not text, or no longer passes its check. */
export function siteHeadCode(site: Pick<SiteDoc, 'headCode'>): string {
  const v = site.headCode;
  return hasCode(v) && !headCodeProblem(v) ? v : '';
}

/** The site's stylesheet as the website writes it: none when it is missing, not text, or no longer passes its check. */
export function siteGlobalCss(site: Pick<SiteDoc, 'globalCss'>): string {
  const v = site.globalCss;
  return hasCode(v) && !globalCssProblem(v) ? v : '';
}
