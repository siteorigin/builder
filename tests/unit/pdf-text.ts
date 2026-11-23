/**
 * The text of each page of a PDF that Chromium printed (`page.pdf()`), in page order, one line per text run.
 *
 * Chromium writes PDFs with Skia: plain indirect objects (no object streams), FlateDecode content streams that
 * show text with `Tj` and `TJ`, and Type0 fonts whose /ToUnicode CMap maps each glyph code back to text. This
 * reads exactly that, so a test can check what a printout says without a PDF library. Anything it cannot read
 * (an object stream, an encrypted file, a font without a CMap) throws rather than returning less text.
 */
import { inflateSync } from 'node:zlib';

type Ref = { ref: number };
type Value = number | string | boolean | null | Ref | Value[] | { [key: string]: Value } | { name: string };
type Dict = { [key: string]: Value };

interface PdfObject {
  value: Value;
  stream?: Buffer;
}

const isRef = (v: Value | undefined): v is Ref => !!v && typeof v === 'object' && 'ref' in v;
const isName = (v: Value | undefined): v is { name: string } => !!v && typeof v === 'object' && 'name' in v;
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
  const range = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/.exec(cmap.slice(cmap.indexOf('begincodespacerange')));
  const bytes = range ? range[1].length / 2 : 2;
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

/** The text of every page, in page order. Each text run (one `BT` … `ET` block) is a line. */
export function pdfPages(pdf: Buffer): string[] {
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
    const resources = get(page.Resources);
    const fontDict = isDict(resources) ? get(resources.Font) : undefined;
    const contents = get(page.Contents);
    const streams = (Array.isArray(contents) ? contents : [page.Contents]).map((c) => (isRef(c) ? objects.get(c.ref)?.stream : undefined));
    const lines: string[] = [];
    for (const stream of streams) {
      if (!stream) continue;
      const src = stream.toString('latin1');
      let font: ReturnType<typeof fontFor> | undefined;
      let line = '';
      const show = (hex: string) => {
        if (!font) throw new Error('PDF text shown before a font was set');
        const step = font.bytes * 2;
        for (let i = 0; i + step <= hex.length; i += step) line += font.map.get(parseInt(hex.slice(i, i + step), 16)) ?? '';
      };
      // Operands and operators in order: names, hex strings, arrays of them, numbers, and operator words.
      const tokens = /\/([^\s/<>[\]()]+)|<([0-9a-fA-F\s]*)>|\[((?:[^\]\\]|\\.)*)\]|\((?:[^)\\]|\\.)*\)|(-?[\d.]+)|([A-Za-z'"*]+)/g;
      const operands: string[] = [];
      for (const [, name, hex, array, , op] of src.matchAll(tokens)) {
        if (name !== undefined) operands.push(name);
        else if (hex !== undefined) operands.push(hex.replace(/\s+/g, ''));
        else if (array !== undefined) operands.push(array);
        else if (op === undefined) continue;
        else {
          if (op === 'BT') line = '';
          else if (op === 'ET') {
            if (line) lines.push(line);
            line = '';
          } else if (op === 'Tf') {
            const ref = isDict(fontDict) ? fontDict[operands[0]] : undefined;
            font = fontFor(ref);
          } else if (op === 'Tj' || op === "'" || op === '"') show(operands[operands.length - 1] ?? '');
          else if (op === 'TJ') for (const [, part] of (operands[operands.length - 1] ?? '').matchAll(/<([0-9a-fA-F\s]*)>/g)) show(part.replace(/\s+/g, ''));
          operands.length = 0;
        }
      }
    }
    return lines.join('\n');
  });
}

/** Text with all whitespace removed, so wrapped lines and split runs still match a phrase. */
export const squash = (text: string) => text.replace(/\s+/g, '');
