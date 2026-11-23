/**
 * The text of each page of a PDF that Chromium printed (`page.pdf()`), in page order, and the colours it is printed in.
 *
 * Chromium writes PDFs with Skia: plain indirect objects (no object streams), FlateDecode content streams that
 * show text with `Tj` and `TJ`, and Type0 fonts whose /ToUnicode CMap maps each glyph code back to text. This
 * reads exactly that, so a test can check what a printout says, and in what ink, without a PDF library. Anything
 * it cannot read (an object stream, an encrypted file, a font without a CMap, right-to-left text) throws rather
 * than misreading it.
 */
import { inflateSync } from 'node:zlib';

// Interfaces, not type literals: a literal would count as a Dict, and `isDict` could not tell them apart.
interface Ref {
  ref: number;
}
interface Name {
  name: string;
}
interface Dict {
  [key: string]: Value;
}
type Value = number | string | boolean | null | Ref | Name | Value[] | Dict;

interface PdfObject {
  value: Value;
  stream?: Buffer;
}

const isRef = (v: Value | undefined): v is Ref => !!v && typeof v === 'object' && 'ref' in v;
const isName = (v: Value | undefined): v is Name => !!v && typeof v === 'object' && 'name' in v;
const isDict = (v: Value | undefined): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v) && !isRef(v) && !isName(v);

/** Parses one PDF value (dictionary, array, name, number, string or reference) from `src` at `pos`. */
function parseValue(src: string, start: number): { value: Value; end: number } {
  let pos = start;
  const skip = () => {
    for (;;) {
      while (pos < src.length && /\s/.test(src[pos])) pos++;
      if (src[pos] !== '%') return;
      while (pos < src.length && src[pos] !== '\n' && src[pos] !== '\r') pos++;
    }
  };
  const value = (): Value => {
    skip();
    const c = src[pos];
    if (c === '<' && src[pos + 1] === '<') {
      pos += 2;
      const dict: Dict = {};
      for (;;) {
        skip();
        if (src[pos] === '>' && src[pos + 1] === '>') {
          pos += 2;
          return dict;
        }
        const key = value();
        if (!isName(key)) throw new Error(`PDF dictionary key expected at ${pos}`);
        dict[key.name] = value();
      }
    }
    if (c === '[') {
      pos++;
      const list: Value[] = [];
      for (;;) {
        skip();
        if (src[pos] === ']') {
          pos++;
          return list;
        }
        list.push(value());
      }
    }
    if (c === '/') {
      const m = /^\/[^\s/<>[\]()%{}]*/.exec(src.slice(pos, pos + 256))!;
      pos += m[0].length;
      return { name: m[0].slice(1) };
    }
    if (c === '<') {
      const end = src.indexOf('>', pos);
      const hex = src.slice(pos + 1, end).replace(/\s+/g, '');
      pos = end + 1;
      return hex;
    }
    if (c === '(') {
      let depth = 0;
      let out = '';
      for (pos++; pos < src.length; pos++) {
        const ch = src[pos];
        if (ch === '\\') {
          out += src[++pos];
          continue;
        }
        if (ch === '(') depth++;
        if (ch === ')' && depth-- === 0) break;
        out += ch;
      }
      pos++;
      return out;
    }
    const m = /^(-?[\d.]+)(?:\s+(\d+)\s+R(?![A-Za-z]))?|^(true|false|null)/.exec(src.slice(pos, pos + 64));
    if (!m) throw new Error(`Unreadable PDF value at ${pos}: ${JSON.stringify(src.slice(pos, pos + 20))}`);
    pos += m[0].length;
    if (m[3]) return m[3] === 'null' ? null : m[3] === 'true';
    return m[2] !== undefined ? { ref: Number(m[1]) } : Number(m[1]);
  };
  const v = value();
  return { value: v, end: pos };
}

/** Every indirect object, by number, with its decoded stream when it has one. */
function readObjects(pdf: Buffer): Map<number, PdfObject> {
  const src = pdf.toString('latin1');
  if (src.includes('/ObjStm') || src.includes('/Encrypt')) throw new Error('This PDF uses object streams or encryption, which pdf-text does not read');
  const objects = new Map<number, PdfObject>();
  const header = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = header.exec(src))) {
    const { value, end } = parseValue(src, m.index + m[0].length);
    const object: PdfObject = { value };
    const after = /^\s*stream\r?\n/.exec(src.slice(end, end + 16));
    if (after && isDict(value)) {
      const start = end + after[0].length;
      const length = value.Length;
      const size = typeof length === 'number' ? length : isRef(length) ? (readLength(src, length.ref) ?? -1) : -1;
      const stop = size >= 0 ? start + size : src.indexOf('endstream', start);
      const raw = pdf.subarray(start, stop);
      const filter = value.Filter;
      const filters = Array.isArray(filter) ? filter : filter === undefined ? [] : [filter];
      // Text and its CMaps are Flate-compressed; other filters (a photo's DCTDecode) hold nothing this reads.
      if (filters.every((f) => isName(f) && f.name === 'FlateDecode')) object.stream = filters.reduce<Buffer>((data) => inflateSync(data), raw);
      header.lastIndex = stop;
    } else header.lastIndex = end;
    objects.set(Number(m[1]), object);
  }
  return objects;
}

/** A stream /Length given as a reference to another object. */
function readLength(src: string, num: number): number | undefined {
  const m = new RegExp(`(?:^|\\s)${num}\\s+0\\s+obj\\s+(\\d+)`).exec(src);
  return m ? Number(m[1]) : undefined;
}

/** Decodes UTF-16BE hex (a CMap destination) to text. */
function utf16(hex: string): string {
  const units: number[] = [];
  for (let i = 0; i + 4 <= hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
  return String.fromCharCode(...units);
}

/** A font's glyph codes mapped to text, from its /ToUnicode CMap (bfchar and bfrange sections). */
function toUnicode(cmap: string): { map: Map<number, string>; bytes: number } {
  const map = new Map<number, string>();
  const spaces = [...cmap.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)].flatMap((m) => [...m[1].matchAll(/<([0-9a-fA-F]+)>/g)].map((r) => r[1].length / 2));
  // Codes are read at one fixed width; a map that mixes widths would be misread.
  if (new Set(spaces).size > 1) throw new Error('This PDF has a font whose codes vary in length, which pdf-text does not read');
  const bytes = spaces[0] ?? 2;
  for (const section of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, code, dest] of section[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(code, 16), utf16(dest));
  }
  for (const section of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, dest, list] of section[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const from = parseInt(lo, 16);
      const to = parseInt(hi, 16);
      if (list !== undefined) {
        [...list.matchAll(/<([0-9a-fA-F]+)>/g)].forEach(([, d], i) => map.set(from + i, utf16(d)));
        continue;
      }
      // The last UTF-16 unit counts up through the range.
      const prefix = dest.slice(0, -4);
      const last = parseInt(dest.slice(-4), 16);
      for (let code = from; code <= to; code++) map.set(code, utf16(prefix + (last + code - from).toString(16).padStart(4, '0')));
    }
  }
  return { map, bytes };
}

/** One run of text as printed: what it says and the colour it is filled with. */
export interface PdfRun {
  text: string;
  /** The fill colour as `#rrggbb`; `pattern` for a gradient or pattern, `cmyk(…)` for a CMYK colour. */
  fill: string;
}

/** What one sheet shows: its runs of text in order, and every colour an area (a background, a rule) is filled with. */
export interface PdfSheet {
  runs: PdfRun[];
  fills: Set<string>;
}

const hex = (parts: number[]) => '#' + parts.map((p) => Math.round(Math.min(1, Math.max(0, p)) * 255).toString(16).padStart(2, '0')).join('');
/** A fill colour from its components: grey, RGB or CMYK. */
const colour = (parts: number[]) => (parts.length === 1 ? hex([parts[0], parts[0], parts[0]]) : parts.length === 3 ? hex(parts) : `cmyk(${parts.join(',')})`);

/** Every sheet of the PDF, in page order. Each text run (one `BT` … `ET` block) is one run. */
export function pdfSheets(pdf: Buffer): PdfSheet[] {
  const objects = readObjects(pdf);
  const get = (v: Value | undefined): Value | undefined => (isRef(v) ? objects.get(v.ref)?.value : v);
  const trailer = pdf.toString('latin1').lastIndexOf('trailer');
  const root = trailer >= 0 ? (parseValue(pdf.toString('latin1'), trailer + 'trailer'.length).value as Dict).Root : undefined;
  const catalog = get(root) ?? [...objects.values()].map((o) => o.value).find((v) => isDict(v) && isName(v.Type) && v.Type.name === 'Catalog');
  if (!isDict(catalog)) throw new Error('PDF catalog not found');

  const pages: Dict[] = [];
  const walk = (node: Value | undefined) => {
    const dict = get(node);
    if (!isDict(dict)) return;
    if (isName(dict.Type) && dict.Type.name === 'Page') pages.push(dict);
    else for (const kid of (get(dict.Kids) as Value[] | undefined) ?? []) walk(kid);
  };
  walk(catalog.Pages);

  const fonts = new Map<number, { map: Map<number, string>; bytes: number }>();
  const fontFor = (ref: Value | undefined) => {
    if (!isRef(ref)) throw new Error('Inline PDF fonts are not supported');
    let font = fonts.get(ref.ref);
    if (!font) {
      const dict = get(ref);
      const cmap = isDict(dict) && isRef(dict.ToUnicode) ? objects.get(dict.ToUnicode.ref)?.stream : undefined;
      if (!cmap) throw new Error(`PDF font ${ref.ref} has no /ToUnicode map`);
      font = toUnicode(cmap.toString('latin1'));
      fonts.set(ref.ref, font);
    }
    return font;
  };

  return pages.map((page) => {
    const contents = get(page.Contents);
    const streams = (Array.isArray(contents) ? contents : [page.Contents]).map((c) => (isRef(c) ? objects.get(c.ref)?.stream : undefined));
    const sheet: PdfSheet = { runs: [], fills: new Set() };
    // The fill colour and its colour space are part of the graphics state, which q and Q save and restore.
    let fill = '#000000';
    let space = 'DeviceGray';
    const saved: Array<[string, string]> = [];
    /** Runs a content stream. A form it draws (`Do`: text with opacity is drawn in one) runs with its own resources. */
    const paint = (src: string, resourcesValue: Value | undefined, depth: number) => {
      if (depth > 16) throw new Error('PDF forms nest too deeply');
      const resources = get(resourcesValue);
      const fontDict = isDict(resources) ? get(resources.Font) : undefined;
      const xobjects = isDict(resources) ? get(resources.XObject) : undefined;
      let font: ReturnType<typeof fontFor> | undefined;
      let line = '';
      let inText = false;
      // Marked content: a span with /ActualText says what its glyphs read as (a ligature, a cluster).
      const marked: Array<string | undefined> = [];
      const show = (code: string) => {
        if (!font) throw new Error('PDF text shown before a font was set');
        if (marked.some((actual) => actual !== undefined)) return;
        const step = font.bytes * 2;
        if (code.length % step) throw new Error(`PDF text <${code}> is not whole ${font.bytes}-byte codes`);
        for (let i = 0; i < code.length; i += step) {
          const text = font.map.get(parseInt(code.slice(i, i + step), 16));
          if (text === undefined) throw new Error(`PDF glyph <${code.slice(i, i + step)}> has no text in its font's /ToUnicode map`);
          line += text;
        }
      };
      const LITERAL = '\0literal';
      // Operands and operators in order: names, hex strings, arrays, literal strings, numbers, and operator words.
      const tokens = /\/([^\s/<>[\]()]+)|<([0-9a-fA-F\s]*)>|\[((?:[^\]\\]|\\.)*)\]|(\((?:[^)\\]|\\.)*\))|(-?[\d.]+)|([A-Za-z'"*]+)/g;
      const operands: string[] = [];
      const numbers: number[] = [];
      for (const [, name, code, array, literal, number, op] of src.matchAll(tokens)) {
        if (name !== undefined) operands.push(name);
        else if (code !== undefined) operands.push(code.replace(/\s+/g, ''));
        else if (array !== undefined) operands.push(array.includes('(') ? LITERAL : array);
        else if (literal !== undefined) operands.push(LITERAL);
        else if (number !== undefined) numbers.push(Number(number));
        else if (op !== undefined) {
          const textOperand = () => {
            const last = operands[operands.length - 1] ?? '';
            if (last === LITERAL) throw new Error(`PDF text shown as a literal string (${op}), which pdf-text does not read`);
            return last;
          };
          if (op === 'q') saved.push([fill, space]);
          else if (op === 'Q') [fill, space] = saved.pop() ?? [fill, space];
          else if (op === 'cs') space = operands[0] ?? space;
          else if (op === 'rg') [fill, space] = [colour(numbers.slice(-3)), 'DeviceRGB'];
          else if (op === 'g') [fill, space] = [colour(numbers.slice(-1)), 'DeviceGray'];
          else if (op === 'k') [fill, space] = [colour(numbers.slice(-4)), 'DeviceCMYK'];
          else if (op === 'sc' || op === 'scn') fill = space === 'Pattern' || operands.length ? 'pattern' : colour(numbers.slice());
          else if (['f', 'F', 'f*', 'B', 'B*', 'b', 'b*'].includes(op)) sheet.fills.add(fill);
          else if (op === 'BI') throw new Error('This PDF has an inline image, which pdf-text does not read');
          else if (op === 'BMC' || op === 'BDC') {
            // Right-to-left text marked this way is stored in visual order, which this reader would return reversed.
            if (operands[0] === 'ReversedChars') throw new Error('This PDF has right-to-left text, which pdf-text does not read');
            const at = operands.indexOf('ActualText');
            if (at >= 0 && (operands[at + 1] === undefined || operands[at + 1] === LITERAL)) throw new Error('This PDF has /ActualText that pdf-text does not read');
            marked.push(at >= 0 ? utf16(operands[at + 1].replace(/^feff/i, '')) : undefined);
          } else if (op === 'EMC') {
            const actual = marked.pop();
            if (actual !== undefined && inText) line += actual;
            else if (actual) sheet.runs.push({ text: actual, fill });
          } else if (op === 'BT') [line, inText] = ['', true];
          else if (op === 'ET') {
            if (line) sheet.runs.push({ text: line, fill });
            [line, inText] = ['', false];
          } else if (op === 'Tf') font = fontFor(isDict(fontDict) ? fontDict[operands[0]] : undefined);
          else if (op === 'Tj' || op === "'" || op === '"') show(textOperand());
          else if (op === 'TJ') for (const [, part] of textOperand().matchAll(/<([0-9a-fA-F\s]*)>/g)) show(part.replace(/\s+/g, ''));
          else if (op === 'Do') {
            const ref = isDict(xobjects) ? xobjects[operands[0]] : undefined;
            const object = isRef(ref) ? objects.get(ref.ref) : undefined;
            if (!object) throw new Error(`PDF object /${operands[0]} drawn but not found`);
            if (isDict(object.value) && isName(object.value.Subtype) && object.value.Subtype.name === 'Form') {
              if (!object.stream) throw new Error(`PDF form /${operands[0]} could not be decoded`);
              // A form runs in a saved graphics state; a form without resources of its own uses the page's.
              saved.push([fill, space]);
              const depthBefore = saved.length;
              paint(object.stream.toString('latin1'), object.value.Resources ?? resourcesValue, depth + 1);
              if (saved.length !== depthBefore) throw new Error(`PDF form /${operands[0]} does not restore its graphics state`);
              [fill, space] = saved.pop()!;
            }
          }
          operands.length = 0;
          numbers.length = 0;
        }
      }
    };
    for (const stream of streams) {
      if (!stream) throw new Error('A PDF page content stream could not be decoded');
      paint(stream.toString('latin1'), page.Resources, 0);
    }
    return sheet;
  });
}

/** The text of every sheet, in page order, one line per text run. */
export const pdfPages = (pdf: Buffer): string[] => pdfSheets(pdf).map((sheet) => sheet.runs.map((run) => run.text).join('\n'));

/** Text with all whitespace removed, so wrapped lines and split runs still match a phrase. */
export const squash = (text: string) => text.replace(/\s+/g, '');
