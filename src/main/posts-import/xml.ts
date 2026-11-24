/**
 * A small XML reader for WordPress export files, written to be safe on files from anywhere. A document type
 * declaration is refused outright, so no entity can be declared, expanded or fetched (XXE, "billion laughs"): only
 * the five predefined entities and numeric character references are read. The size, the nesting and the number of
 * nodes are capped, and every scan moves forward, so a damaged file fails quickly with a plain reason.
 */

export interface XmlElement {
  /** The name as written, with its prefix: `wp:post_name`, `content:encoded`. */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
export type XmlNode = XmlElement | string;

export class XmlError extends Error {}

export interface XmlLimits {
  /** The longest text read, in characters. */
  maxChars: number;
  maxDepth: number;
  /** Elements and runs of text together. */
  maxNodes: number;
}

export const XML_LIMITS: XmlLimits = { maxChars: 100_000_000, maxDepth: 64, maxNodes: 2_000_000 };

const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const NAME_RE = /^[A-Za-z_][\w.:-]*$/;

/** A character reference's character, or null for a number no character has. */
function codePoint(n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
  return String.fromCodePoint(n);
}

/**
 * Text with its references read: the five XML entities and numeric references. Any other name is kept as written:
 * nothing declared it, so nothing is expanded.
 */
export function decodeXmlText(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,8}|#[0-9]{1,10}|[A-Za-z][A-Za-z0-9]{0,31});/g, (whole, ref: string) => {
    if (ref[0] !== '#') return Object.hasOwn(PREDEFINED, ref) ? PREDEFINED[ref] : whole;
    const n = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return codePoint(n) ?? '�';
  });
}

/** The document's root element. Throws XmlError, saying what is wrong, for anything that is not well-formed XML. */
export function parseXml(input: string, limits: XmlLimits = XML_LIMITS): XmlElement {
  if (input.length > limits.maxChars) throw new XmlError(`it is larger than ${Math.round(limits.maxChars / 1_000_000)} MB.`);
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let nodes = 0;
  let pending = '';
  let i = 0;
  const line = (at: number) => text.slice(0, at).split('\n').length;
  const fail = (why: string, at = i): never => {
    throw new XmlError(`${why} (line ${line(at)}).`);
  };
  const count = () => {
    if (++nodes > limits.maxNodes) throw new XmlError('it holds more than the reader takes in one file.');
  };
  const flushText = () => {
    if (!pending) return;
    const top = stack[stack.length - 1];
    if (top) {
      count();
      const last = top.children[top.children.length - 1];
      if (typeof last === 'string') top.children[top.children.length - 1] = last + pending;
      else top.children.push(pending);
    } else if (pending.trim()) fail('there is text outside the document');
    pending = '';
  };
  const until = (marker: string, from: number, what: string): number => {
    const end = text.indexOf(marker, from);
    if (end < 0) fail(`${what} is never closed`, from);
    return end;
  };

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      pending += decodeXmlText(text.slice(i));
      i = text.length;
      break;
    }
    if (lt > i) pending += decodeXmlText(text.slice(i, lt));
    i = lt;
    if (text.startsWith('<!--', i)) {
      i = until('-->', i + 4, 'a comment') + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      if (!stack.length) fail('there is text outside the document');
      const end = until(']]>', i + 9, 'a CDATA section');
      pending += text.slice(i + 9, end);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', i)) {
      // A document type declaration is where entities are declared: one is never read.
      if (/^<!DOCTYPE/i.test(text.slice(i, i + 9))) fail('it declares a document type, which is not read because it could define entities');
      fail('it holds a declaration that XML does not allow here');
    }
    if (text.startsWith('<?', i)) {
      i = until('?>', i + 2, 'a processing instruction') + 2;
      continue;
    }
    flushText();
    if (text[i + 1] === '/') {
      const end = until('>', i + 2, 'a closing tag');
      const name = text.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open) fail(`</${name.slice(0, 40)}> closes nothing`);
      if (open!.name !== name) fail(`<${open!.name.slice(0, 40)}> is closed by </${name.slice(0, 40)}>`);
      i = end + 1;
      continue;
    }
    // An opening tag: its name, then attributes until > or />.
    let j = i + 1;
    while (j < text.length && !/[\s/>]/.test(text[j])) j++;
    const name = text.slice(i + 1, j);
    if (!NAME_RE.test(name)) fail(`“<${name.slice(0, 40)}” is not a tag`);
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    for (;;) {
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j >= text.length) fail(`<${name.slice(0, 40)}> is never finished`, i);
      if (text[j] === '>') {
        j++;
        break;
      }
      if (text.startsWith('/>', j)) {
        selfClosing = true;
        j += 2;
        break;
      }
      const eq = text.indexOf('=', j);
      if (eq < 0) fail(`an attribute of <${name.slice(0, 40)}> has no value`, j);
      const attr = text.slice(j, eq).trim();
      if (!NAME_RE.test(attr)) fail(`<${name.slice(0, 40)}> has an attribute that is not well formed`, j);
      let q = eq + 1;
      while (q < text.length && /\s/.test(text[q])) q++;
      const quote = text[q];
      if (quote !== '"' && quote !== "'") fail(`the attribute ${attr.slice(0, 40)} has no quotes`, q);
      const close = until(quote, q + 1, `the attribute ${attr.slice(0, 40)}`);
      const raw = text.slice(q + 1, close);
      if (raw.includes('<')) fail(`the attribute ${attr.slice(0, 40)} holds a “<”`, q);
      if (Object.hasOwn(attrs, attr)) fail(`<${name.slice(0, 40)}> has the attribute ${attr.slice(0, 40)} twice`, j);
      attrs[attr] = decodeXmlText(raw);
      j = close + 1;
    }
    count();
    const el: XmlElement = { name, attrs, children: [] };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else if (root) fail('there is a second document after the first');
    else root = el;
    if (!selfClosing) {
      if (stack.length >= limits.maxDepth) fail('its elements are nested too deeply');
      stack.push(el);
    }
    i = j;
  }
  flushText();
  if (stack.length) throw new XmlError(`<${stack[stack.length - 1].name.slice(0, 40)}> is never closed.`);
  if (!root) throw new XmlError('it holds no XML document.');
  return root;
}

// ---------------------------------------------------------------------------
// Reading a parsed document
// ---------------------------------------------------------------------------

const isElement = (n: XmlNode): n is XmlElement => typeof n !== 'string';

/** The element's child elements called `name` (or every child element). */
export function childElements(el: XmlElement, name?: string): XmlElement[] {
  return el.children.filter((c): c is XmlElement => isElement(c) && (name === undefined || c.name === name));
}

/** The element's first child element called `name`. */
export function childElement(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((c): c is XmlElement => isElement(c) && c.name === name);
}

/** All the text inside an element, its children's included. */
export function textOf(el: XmlElement | undefined): string {
  if (!el) return '';
  let out = '';
  for (const c of el.children) out += typeof c === 'string' ? c : textOf(c);
  return out;
}

/** The text of the element's first child called `name`, or ''. */
export const childText = (el: XmlElement, name: string): string => textOf(childElement(el, name));
