/**
 * Allowlist SVG sanitizer. The input is tokenised as XML and rebuilt from known-safe elements and
 * attributes only; anything else (scripts, event handlers, foreign content, external references,
 * entities, processing instructions) is dropped. The rebuilt document, not the original bytes, is saved.
 */

const ELEMENTS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'defs', 'title', 'desc', 'style',
  'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'symbol', 'use', 'text', 'tspan'
]);
const ATTRIBUTES = new Set([
  'xmlns', 'viewbox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points',
  'fill', 'fill-rule', 'fill-opacity', 'clip-rule', 'clip-path', 'mask', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity',
  'transform', 'id', 'class', 'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform',
  'spreadmethod', 'fx', 'fy', 'preserveaspectratio', 'patternunits', 'patterncontentunits', 'patterntransform',
  'clippathunits', 'maskunits', 'maskcontentunits', 'font-family', 'font-size', 'font-weight', 'text-anchor',
  'dominant-baseline', 'letter-spacing', 'dx', 'dy', 'vector-effect', 'shape-rendering', 'version', 'href', 'xlink:href',
  'xmlns:xlink', 'visibility', 'display', 'color', 'style', 'font-style', 'mix-blend-mode', 'paint-order', 'data-name'
]);
const CANONICAL: Record<string, string> = {
  viewbox: 'viewBox', lineargradient: 'linearGradient', radialgradient: 'radialGradient', clippath: 'clipPath',
  gradientunits: 'gradientUnits', gradienttransform: 'gradientTransform', spreadmethod: 'spreadMethod',
  preserveaspectratio: 'preserveAspectRatio', patternunits: 'patternUnits', patterncontentunits: 'patternContentUnits',
  patterntransform: 'patternTransform', clippathunits: 'clipPathUnits', maskunits: 'maskUnits', maskcontentunits: 'maskContentUnits'
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Presentation properties a drawing may set through CSS (style="" or a <style> element), as Figma, Illustrator
 * and Inkscape export them. Anything else (behaviour, layout of the host page, imports) is dropped.
 */
const CSS_PROPERTIES = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity', 'stop-color', 'stop-opacity', 'clip-rule', 'clip-path',
  'mask', 'color', 'display', 'visibility', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor',
  'letter-spacing', 'dominant-baseline', 'mix-blend-mode', 'isolation', 'paint-order', 'vector-effect', 'shape-rendering',
  'transform', 'transform-origin', 'transform-box', 'enable-background'
]);

/** The only CSS functions a drawing's values may call: colors, math, transforms, shapes and local url(#id). */
const CSS_FUNCTIONS = new Set([
  'url', 'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'calc', 'min', 'max', 'clamp', 'var',
  'matrix', 'matrix3d', 'translate', 'translatex', 'translatey', 'translatez', 'translate3d', 'scale', 'scalex', 'scaley', 'scalez', 'scale3d',
  'rotate', 'rotatex', 'rotatey', 'rotatez', 'rotate3d', 'skew', 'skewx', 'skewy', 'perspective', 'inset', 'circle', 'ellipse', 'polygon'
]);

/**
 * Can this value call anything but an allowed function, or reach outside the document? A backslash is refused
 * outright: CSS escapes can spell any function name ("u\72l(").
 */
function safeFunctions(value: string): boolean {
  if (value.length >= MAX_VALUE || value.includes('\\')) return false;
  // One pass: from each "(", step back over the name in front of it.
  for (let open = value.indexOf('('), floor = 0; open >= 0; floor = open + 1, open = value.indexOf('(', floor)) {
    let end = open;
    while (end > floor && CSS_SPACE.test(value[end - 1])) end--;
    let start = end;
    while (start > floor && /[\w-]/.test(value[start - 1])) start--;
    const name = value.slice(start, end).toLowerCase();
    if (!CSS_FUNCTIONS.has(name)) return false;
    if (name === 'url' && !localFragment(value.slice(open + 1))) return false;
  }
  return true;
}

const MAX_VALUE = 20000;
/** CSS whitespace only: a non-breaking space is part of a URL, not padding around it. */
const CSS_SPACE = /[ \t\r\n\f]/;
const FRAGMENT = /^#[A-Za-z_][\w.:-]*$/;

/** Does the text after "url(" hold only a reference to an element in this document? */
function localFragment(rest: string): boolean {
  const m = rest.match(/^[ \t\r\n\f]*(?:"([^"]*)"|'([^']*)'|([^'")\s]*))[ \t\r\n\f]*\)/);
  return !!m && FRAGMENT.test(m[1] ?? m[2] ?? m[3] ?? '');
}

/** A CSS value is kept only when it cannot load, run or escape anything. */
function safeCssValue(value: string): boolean {
  if (value.length > 2000 || /[<>{}@;]|expression\s*\(|javascript:|vbscript:|-moz-binding|behavior/i.test(value)) return false;
  return safeFunctions(value);
}

/** Keep the allowed declarations of a declaration list ("fill:#fff;stroke:none"), rebuilt in a canonical form. */
function sanitizeDeclarations(text: string): string {
  const out: string[] = [];
  for (const decl of text.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim().replace(/\s*!important$/i, '');
    if (!CSS_PROPERTIES.has(prop) || !value || !safeCssValue(value)) continue;
    out.push(`${prop}:${value}`);
  }
  return out.join(';');
}

/** Rebuild a stylesheet from plain rules (class, id, element and simple combinators) with allowed declarations. */
export function sanitizeStylesheet(css: string): string {
  if (css.length > MAX_STYLESHEET) return '';
  const text = stripCssComments(css);
  const out: string[] = [];
  // One pass over the text: at-rules (@import, @font-face, @media…) and anything nested are dropped whole.
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    const prelude = text.slice(i, open < 0 ? undefined : open);
    const atRule = prelude.trimStart().startsWith('@');
    // Looked for only inside this rule's own prelude, so the whole pass stays linear.
    const semi = atRule ? prelude.indexOf(';') : -1;
    if (semi >= 0) {
      i += semi + 1;
      continue;
    }
    if (open < 0) break;
    let depth = 1;
    let end = open + 1;
    for (; end < text.length && depth; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}') depth--;
    }
    if (depth) break;
    const body = text.slice(open + 1, end - 1);
    if (!atRule && !body.includes('{')) {
      const selector = safeSelector(text.slice(i, open));
      const decls = selector ? sanitizeDeclarations(body) : '';
      if (decls) out.push(`${selector}{${decls}}`);
    }
    i = end;
  }
  return out.join('');
}

const MAX_STYLESHEET = 256 * 1024;

function stripCssComments(css: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < css.length) {
    const start = css.indexOf('/*', i);
    if (start < 0) {
      parts.push(css.slice(i));
      break;
    }
    parts.push(css.slice(i, start), ' ');
    const end = css.indexOf('*/', start + 2);
    if (end < 0) break;
    i = end + 2;
  }
  return parts.join('');
}

/**
 * Selectors are limited to classes and IDs (optionally on a drawing element), which is what design tools export.
 * Bare `body`, `*` or `svg` rules could restyle a page the drawing is placed in, so a rule using one is dropped.
 */
function safeSelector(raw: string): string | null {
  const selector = raw.trim().replace(/\s+/g, ' ');
  if (!selector || selector.length > 500) return null;
  for (const group of selector.split(',')) {
    const compounds = group.trim().split(/\s*[>+~]\s*|\s+/);
    for (const c of compounds) {
      const m = c.match(/^([A-Za-z][A-Za-z0-9]*)?((?:[.#][A-Za-z_-][\w-]*)+)$/);
      if (!m || (m[1] && !ELEMENTS.has(m[1].toLowerCase()))) return null;
    }
  }
  return selector;
}

/** Attributes holding free text or identifiers, where parentheses are not CSS. */
const PLAIN_ATTRIBUTES = new Set(['id', 'class', 'data-name', 'xmlns', 'xmlns:xlink', 'version']);

function safeValue(name: string, value: string): boolean {
  if (/javascript:|data:(?!image\/(png|jpe?g|gif|webp);)|vbscript:|expression\s*\(/i.test(value)) return false;
  if (name === 'href' || name === 'xlink:href') return FRAGMENT.test(value.replace(/^[ \t\r\n\f]+|[ \t\r\n\f]+$/g, ''));
  // Presentation attributes are CSS values too: url(...) must stay inside the document, and nothing else may load.
  if (!PLAIN_ATTRIBUTES.has(name) && !safeFunctions(value)) return false;
  return value.length < MAX_VALUE;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
  });
}

/** Real drawings nest a few dozen levels; this keeps the parser's work linear in the file size. */
const MAX_DEPTH = 256;

const INCOMPLETE = 'it is incomplete: the end of the file is missing, so the copy or download was probably cut short. Copy or download it again, then import the new copy';

/** Returns the sanitized SVG, or throws with a user-facing reason. */
export function sanitizeSvg(bytes: Buffer): string {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)))
    throw new Error('it is saved as UTF-16; save it as UTF-8');
  const text = bytes.toString('utf8').replace(/^﻿/, '');
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(text)) throw new Error('it declares XML entities');
  // A comment, instruction or CDATA section left open is a file cut short, and each opener left open would otherwise
  // be searched to the end of the file. Each is skipped whole, so what one holds (CSS, text) is never taken for markup.
  for (let i = text.indexOf('<'); i >= 0; i = text.indexOf('<', i + 1)) {
    const close = text.startsWith('<!--', i) ? '-->' : text.startsWith('<![CDATA[', i) ? ']]>' : text.startsWith('<?', i) ? '?>' : '';
    if (!close) continue;
    const end = text.indexOf(close, i + 2);
    if (end < 0) throw new Error(INCOMPLETE);
    i = end;
  }
  const out: string[] = [];
  const stack: Array<{ name: string; kept: boolean }> = [];
  let skipDepth = 0;
  let sawSvg = false;
  // A file cut short leaves its root open; what is still open at the end would otherwise be closed for it.
  let rootClosed = false;
  let styleText = '';
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<\/\s*([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>|([^<]+)|</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [token, closeName, openName, attrText, selfClose, chars] = m;
    // Stylesheets are often wrapped in CDATA by Illustrator; their text is sanitized like any other.
    if (token.startsWith('<![CDATA[') && !skipDepth && stack[stack.length - 1]?.name === 'style' && stack[stack.length - 1].kept) {
      styleText += token.slice(9, -3);
      continue;
    }
    if (token.startsWith('<!--') || token.startsWith('<?') || token.startsWith('<!')) continue;
    if (closeName) {
      // A closing tag closes its own element (and any left open inside it); a stray one closes nothing.
      const name = closeName.toLowerCase();
      const at = stack.map((e) => e.name).lastIndexOf(name);
      if (at < 0) continue;
      if (at === 0 && stack[0].kept) rootClosed = true;
      while (stack.length > at) {
        const top = stack.pop()!;
        if (!top.kept) {
          skipDepth--;
          continue;
        }
        if (top.name === 'style') {
          const css = sanitizeStylesheet(styleText);
          styleText = '';
          if (css) out.push(esc(css));
        }
        out.push(`</${CANONICAL[top.name] ?? top.name}>`);
      }
      continue;
    }
    if (openName) {
      const name = openName.toLowerCase();
      if (stack.length >= MAX_DEPTH) throw new Error('it is nested too deeply');
      // One <svg> root holds everything, and a stylesheet holds only text.
      const parentName = stack[stack.length - 1]?.name;
      const placeable = stack.length ? parentName !== 'style' : name === 'svg' && !sawSvg;
      const allowed = !skipDepth && ELEMENTS.has(name) && placeable;
      if (!allowed) {
        if (!selfClose) {
          stack.push({ name, kept: false });
          skipDepth++;
        }
        continue;
      }
      if (name === 'svg') {
        sawSvg = true;
        // Only the root closing itself finishes the file; a self-closing <svg/> inside it does not.
        if (selfClose && !stack.length) rootClosed = true;
      }
      const attrs: string[] = [];
      for (const a of (attrText ?? '').matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) {
        const an = a[1].toLowerCase();
        if (an.startsWith('on') || !ATTRIBUTES.has(an)) continue;
        const value = decodeEntities(a[2] ?? a[3] ?? '');
        if (an === 'style') {
          const css = sanitizeDeclarations(value);
          if (css) attrs.push(`style="${esc(css)}"`);
          continue;
        }
        if (!safeValue(an, value)) continue;
        attrs.push(`${CANONICAL[an] ?? an}="${esc(value)}"`);
      }
      const tag = CANONICAL[name] ?? name;
      out.push(`<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}${selfClose ? ' />' : '>'}`);
      if (!selfClose) stack.push({ name, kept: true });
      continue;
    }
    if (chars !== undefined && !skipDepth) {
      const parent = stack[stack.length - 1]?.name;
      if (parent === 'style') styleText += decodeEntities(chars);
      else if (parent === 'text' || parent === 'tspan' || parent === 'title' || parent === 'desc') out.push(esc(decodeEntities(chars)));
      else if (chars.trim()) continue;
    }
  }
  while (stack.length) {
    const top = stack.pop()!;
    if (!top.kept) {
      skipDepth--;
      continue;
    }
    if (top.name === 'style') {
      const css = sanitizeStylesheet(styleText);
      styleText = '';
      if (css) out.push(esc(css));
    }
    out.push(`</${CANONICAL[top.name] ?? top.name}>`);
  }
  if (!sawSvg) throw new Error('it does not contain an <svg> element');
  if (!rootClosed) throw new Error(INCOMPLETE);
  let result = out.join('');
  if (!/^<svg[^>]*\sxmlns=/.test(result)) result = result.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  return result + '\n';
}
