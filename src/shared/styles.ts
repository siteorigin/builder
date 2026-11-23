import type { StyleValue, TokenGroup } from './types';

/**
 * The finite set of visual style properties the editor and AI can set.
 * Anything outside this list belongs in a code component.
 */

export type StyleValueKind = 'length' | 'color' | 'enum' | 'number' | 'boolean' | 'ratio' | 'textStyle' | 'font' | 'shadow' | 'border' | 'css';

export interface StylePropDef {
  id: string;
  label: string;
  group: 'layout' | 'spacing' | 'size' | 'typography' | 'appearance' | 'position' | 'visibility' | 'custom';
  kind: StyleValueKind;
  /** Token group whose tokens can be linked. */
  tokenGroup?: TokenGroup | TokenGroup[];
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  description?: string;
  /** Whole numbers only. */
  integer?: boolean;
  /** Less common: kept behind "More style options" until it has a value. */
  advanced?: boolean;
}

const edge = (id: string, label: string, group: StylePropDef['group'], kind: 'length' | 'border', tokenGroup: TokenGroup | TokenGroup[], placeholder: string): StylePropDef => ({ id, label, group, kind, tokenGroup, placeholder, advanced: true });

export const STYLE_PROPS: StylePropDef[] = [
  { id: 'layout', label: 'Layout', group: 'layout', kind: 'enum', options: [
    { value: 'block', label: 'Flow' },
    { value: 'stack', label: 'Vertical stack' },
    { value: 'row', label: 'Horizontal stack' },
    { value: 'grid', label: 'Grid' }
  ] },
  { id: 'columns', label: 'Columns', group: 'layout', kind: 'number', min: 1, max: 12, step: 1 },
  { id: 'align', label: 'Align items', group: 'layout', kind: 'enum', options: [
    { value: 'start', label: 'Start' }, { value: 'center', label: 'Center' }, { value: 'end', label: 'End' },
    { value: 'stretch', label: 'Stretch' }, { value: 'baseline', label: 'Baseline' }
  ] },
  { id: 'justify', label: 'Distribute', group: 'layout', kind: 'enum', options: [
    { value: 'start', label: 'Start' }, { value: 'center', label: 'Center' }, { value: 'end', label: 'End' },
    { value: 'space-between', label: 'Space between' }
  ] },
  { id: 'order', label: 'Order', group: 'layout', kind: 'number', min: -10, max: 10, step: 1, description: 'Visual order within its parent.' },
  { id: 'wrap', label: 'Wrap', group: 'layout', kind: 'boolean' },
  { id: 'gridTemplate', label: 'Column sizes', group: 'layout', kind: 'enum', description: 'Uneven columns, or as many as fit. Overrides Columns.', options: [
    { value: '1fr 1fr', label: 'Equal halves' }, { value: '1fr 2fr', label: 'Narrow, wide' }, { value: '2fr 1fr', label: 'Wide, narrow' },
    { value: '1fr 1.5fr', label: 'Slightly wider second' }, { value: '1.5fr 1fr', label: 'Slightly wider first' },
    { value: 'auto-fit-sm', label: 'As many as fit (small)' }, { value: 'auto-fit-md', label: 'As many as fit (medium)' }
  ] },
  { id: 'gap', label: 'Gap', group: 'layout', kind: 'length', tokenGroup: 'space', placeholder: '24px' },
  { id: 'rowGap', label: 'Row gap', group: 'layout', kind: 'length', tokenGroup: 'space', placeholder: '24px', advanced: true },
  { id: 'columnGap', label: 'Column gap', group: 'layout', kind: 'length', tokenGroup: 'space', placeholder: '24px', advanced: true },
  { id: 'columnSpan', label: 'Column span', group: 'layout', kind: 'enum', advanced: true, description: 'Columns this takes up inside a grid. Applies from tablet up unless a phone value is set.', options: [
    ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })), { value: 'full', label: 'Full width' }
  ] },
  { id: 'alignSelf', label: 'Align self', group: 'layout', kind: 'enum', advanced: true, description: 'Overrides how its parent aligns this one item.', options: [
    { value: 'auto', label: 'Auto' }, { value: 'start', label: 'Start' }, { value: 'center', label: 'Center' }, { value: 'end', label: 'End' }, { value: 'stretch', label: 'Stretch' }
  ] },
  { id: 'flexGrow', label: 'Grow', group: 'layout', kind: 'number', min: 0, max: 12, step: 1, advanced: true, description: 'How much of the spare room in a stack this takes.' },
  { id: 'flexShrink', label: 'Shrink', group: 'layout', kind: 'number', min: 0, max: 12, step: 1, advanced: true, description: 'How much this gives up when a stack runs out of room.' },
  { id: 'paddingBlock', label: 'Vertical padding', description: 'Space inside, above and below the content.', group: 'spacing', kind: 'length', tokenGroup: 'space', placeholder: '64px' },
  { id: 'paddingInline', label: 'Side padding', description: 'Space inside, left and right of the content.', group: 'spacing', kind: 'length', tokenGroup: ['space', 'container'], placeholder: '24px' },
  edge('paddingBlockStart', 'Padding top', 'spacing', 'length', 'space', '64px'),
  edge('paddingBlockEnd', 'Padding bottom', 'spacing', 'length', 'space', '64px'),
  edge('paddingInlineStart', 'Padding left', 'spacing', 'length', ['space', 'container'], '24px'),
  edge('paddingInlineEnd', 'Padding right', 'spacing', 'length', ['space', 'container'], '24px'),
  { id: 'marginBlockStart', label: 'Space above', group: 'spacing', kind: 'length', tokenGroup: 'space', placeholder: '0' },
  { id: 'marginBlockEnd', label: 'Space below', group: 'spacing', kind: 'length', tokenGroup: 'space', placeholder: '0' },
  edge('marginInlineStart', 'Space left', 'spacing', 'length', 'space', '0'),
  edge('marginInlineEnd', 'Space right', 'spacing', 'length', 'space', '0'),
  { id: 'width', label: 'Width', group: 'size', kind: 'length', options: [
    { value: 'fill', label: 'Fill' }, { value: 'fit', label: 'Fit content' }, { value: 'auto', label: 'Auto' }
  ], placeholder: 'fill' },
  { id: 'maxWidth', label: 'Max width', group: 'size', kind: 'length', tokenGroup: ['container', 'space'], placeholder: '1200px' },
  { id: 'minWidth', label: 'Min width', group: 'size', kind: 'length', placeholder: '0', advanced: true },
  { id: 'height', label: 'Height', group: 'size', kind: 'length', placeholder: 'auto', advanced: true },
  { id: 'minHeight', label: 'Min height', group: 'size', kind: 'length', placeholder: '0' },
  { id: 'maxHeight', label: 'Max height', group: 'size', kind: 'length', placeholder: '480px', advanced: true },
  { id: 'marginInline', label: 'Placement', description: 'Where it sits horizontally when narrower than its container.', group: 'size', kind: 'enum', options: [
    { value: 'auto', label: 'Centered' }, { value: '0', label: 'Start' }
  ] },
  { id: 'aspectRatio', label: 'Aspect ratio', group: 'size', kind: 'ratio', options: [
    { value: 'auto', label: 'Original' }, { value: '1/1', label: 'Square' }, { value: '4/3', label: '4:3' },
    { value: '3/2', label: '3:2' }, { value: '16/9', label: '16:9' }, { value: '3/4', label: 'Portrait 3:4' }
  ] },
  { id: 'objectFit', label: 'Image fit', group: 'size', kind: 'enum', options: [
    { value: 'cover', label: 'Fill (crop)' }, { value: 'contain', label: 'Fit (no crop)' }
  ] },
  { id: 'objectPosition', label: 'Image focus', group: 'size', kind: 'enum', description: 'Which part stays in view when the image is cropped.', options: [
    { value: 'top', label: 'Top' }, { value: 'center', label: 'Center' }, { value: 'bottom', label: 'Bottom' }, { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }
  ] },
  { id: 'overflow', label: 'Overflow', group: 'size', kind: 'enum', advanced: true, description: 'Clip lets rounded corners cut off what sits inside them.', options: [
    { value: 'visible', label: 'Visible' }, { value: 'hidden', label: 'Hidden' }, { value: 'clip', label: 'Clip' }
  ] },
  { id: 'textStyle', label: 'Text style', group: 'typography', kind: 'textStyle', tokenGroup: 'text' },
  { id: 'fontFamily', label: 'Font', group: 'typography', kind: 'font', tokenGroup: 'font' },
  { id: 'fontSize', label: 'Size', group: 'typography', kind: 'length', placeholder: '1rem' },
  { id: 'fontWeight', label: 'Weight', group: 'typography', kind: 'enum', options: [
    { value: '300', label: 'Light' }, { value: '400', label: 'Regular' }, { value: '500', label: 'Medium' },
    { value: '600', label: 'Semibold' }, { value: '700', label: 'Bold' }, { value: '800', label: 'Extra bold' }
  ] },
  { id: 'fontStyle', label: 'Style', group: 'typography', kind: 'enum', advanced: true, options: [
    { value: 'normal', label: 'Normal' }, { value: 'italic', label: 'Italic' }
  ] },
  { id: 'textTransform', label: 'Capitals', group: 'typography', kind: 'enum', advanced: true, options: [
    { value: 'none', label: 'As typed' }, { value: 'uppercase', label: 'UPPERCASE' }, { value: 'lowercase', label: 'lowercase' }, { value: 'capitalize', label: 'Capitalize' }
  ] },
  { id: 'lineHeight', label: 'Line height', group: 'typography', kind: 'length', placeholder: '1.5' },
  { id: 'letterSpacing', label: 'Letter spacing', group: 'typography', kind: 'length', placeholder: '0em' },
  { id: 'textAlign', label: 'Alignment', group: 'typography', kind: 'enum', options: [
    { value: 'start', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'end', label: 'Right' }
  ] },
  { id: 'color', label: 'Text color', group: 'appearance', kind: 'color', tokenGroup: 'color' },
  { id: 'background', label: 'Background', description: 'A color, or a linear-, radial- or conic-gradient().', group: 'appearance', kind: 'color', tokenGroup: 'color' },
  { id: 'border', label: 'Border', group: 'appearance', kind: 'border', tokenGroup: 'border' },
  edge('borderBlockStart', 'Border top', 'appearance', 'border', 'border', '1px solid #ddd'),
  edge('borderBlockEnd', 'Border bottom', 'appearance', 'border', 'border', '1px solid #ddd'),
  edge('borderInlineStart', 'Border left', 'appearance', 'border', 'border', '1px solid #ddd'),
  edge('borderInlineEnd', 'Border right', 'appearance', 'border', 'border', '1px solid #ddd'),
  { id: 'radius', label: 'Corner radius', group: 'appearance', kind: 'length', tokenGroup: 'radius', placeholder: '8px' },
  { id: 'shadow', label: 'Shadow', group: 'appearance', kind: 'shadow', tokenGroup: 'shadow' },
  { id: 'opacity', label: 'Opacity', group: 'appearance', kind: 'number', min: 0, max: 1, step: 0.05 },
  { id: 'position', label: 'Position', group: 'position', kind: 'enum', description: 'Sticky keeps it in view while scrolling; absolute places it inside the nearest positioned parent.', options: [
    { value: 'static', label: 'Normal' }, { value: 'relative', label: 'Relative' }, { value: 'sticky', label: 'Sticky' }, { value: 'absolute', label: 'Absolute' }
  ] },
  { id: 'inset', label: 'Offset', group: 'position', kind: 'length', placeholder: '0', description: 'Distance from the edges: one value, or top, right, bottom and left.' },
  { id: 'zIndex', label: 'Layer', group: 'position', kind: 'number', min: -1, max: 100, step: 1, integer: true, description: 'Higher layers sit in front.' },
  { id: 'hidden', label: 'Hidden', group: 'visibility', kind: 'boolean' },
  { id: 'customCss', label: 'Custom CSS', group: 'custom', kind: 'css', advanced: true, placeholder: 'filter: saturate(1.2); transform: rotate(-2deg)', description: 'Extra property declarations for this element only. No selectors, at-rules, url() or comments.' }
];

export const STYLE_PROP_MAP: Record<string, StylePropDef> = Object.fromEntries(STYLE_PROPS.map((p) => [p.id, p]));

/** The style properties that do something on a node of this kind; undefined offers all of them. */
export function styleSetFor(node: { kind: string }): string[] | undefined {
  const margins = ['marginBlockStart', 'marginBlockEnd', 'marginInlineStart', 'marginInlineEnd'];
  const spacing = [...margins, 'paddingBlock', 'paddingInline', 'paddingBlockStart', 'paddingBlockEnd', 'paddingInlineStart', 'paddingInlineEnd'];
  const borders = ['border', 'borderBlockStart', 'borderBlockEnd', 'borderInlineStart', 'borderInlineEnd'];
  const appearance = ['color', 'background', ...borders, 'radius', 'shadow', 'opacity'];
  // How an item sits inside a grid or stack parent.
  const child = ['columnSpan', 'alignSelf', 'flexGrow', 'flexShrink', 'order'];
  const placed = ['position', 'inset', 'zIndex'];
  const end = ['hidden', 'customCss'];
  switch (node.kind) {
    case 'text':
      return ['textStyle', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'textTransform', 'lineHeight', 'letterSpacing', 'textAlign', 'maxWidth', ...spacing, ...appearance, ...child, ...placed, ...end];
    case 'image':
      return ['width', 'maxWidth', 'minWidth', 'height', 'maxHeight', 'aspectRatio', 'objectFit', 'objectPosition', 'radius', 'shadow', ...borders, ...margins, 'opacity', ...child, ...placed, ...end];
    case 'link':
      return ['width', 'minWidth', ...margins, 'color', 'background', 'radius', ...child, ...placed, ...end];
    case 'icon':
      return ['color', 'fontSize', 'background', 'radius', ...margins, ...child, ...placed, ...end];
    case 'element':
      return ['layout', 'columns', 'gridTemplate', 'align', 'justify', 'wrap', 'gap', 'rowGap', 'columnGap', ...child, ...spacing, 'width', 'minWidth', 'maxWidth', 'height', 'minHeight', 'maxHeight', 'marginInline', 'overflow', 'textAlign', ...appearance, ...placed, ...end];
    default:
      return undefined;
  }
}

export const STYLE_GROUP_LABELS: Record<StylePropDef['group'], string> = {
  layout: 'Layout',
  spacing: 'Spacing',
  size: 'Size',
  typography: 'Typography',
  appearance: 'Appearance',
  position: 'Position',
  visibility: 'Visibility',
  custom: 'Custom CSS'
};

export function tokenVar(tokenId: string): string {
  return `--so-${tokenId.replace(/[^a-zA-Z0-9]+/g, '-')}`;
}

const LENGTH_RE = /^(-?\d*\.?\d+(px|rem|em|%|vw|vh|svh|dvh|ch|ex)?|auto|0)$/;
const FN_RE = /^(clamp|min|max|calc)\([0-9a-z.,%+\-*/ ()]+\)$/i;
const COLOR_RE = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color-mix)\([0-9a-z.,%+\-/ ()#]+\)|transparent|currentcolor|white|black)$/i;
const SAFE_RE = /^[^;{}<>\\]*$/;
const TEXT_TOKEN_RE = /^text\.[a-z0-9-]+$/;
/** CSS comments can swallow the rest of a stylesheet, and these functions load remote content: none is a style value. */
const INJECTION_RE = /\/\*|\*\/|url\(|src\(|image-set\(|image\(|element\(|paint\(|cross-fade\(|expression\(|@import/i;

/** Brackets and quotes must close, or the rest of the stylesheet is read as part of this value. */
function balanced(value: string): boolean {
  const open: string[] = [];
  let quote = '';
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') open.push(ch);
    else if ((ch === ')' && open.pop() !== '(') || (ch === ']' && open.pop() !== '[')) return false;
  }
  return !open.length && !quote;
}

/** Split at separators outside any brackets. */
function splitTop(value: string, isSeparator: (ch: string) => boolean): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && isSeparator(ch)) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** One function call and nothing after it, with something between its brackets. */
function wholeCall(value: string): boolean {
  const start = value.indexOf('(');
  if (start < 0 || !value.endsWith(')') || !value.slice(start + 1, -1).trim()) return false;
  let depth = 0;
  for (let i = start; i < value.length; i++) {
    if (value[i] === '(') depth++;
    else if (value[i] === ')' && --depth === 0) return i === value.length - 1;
  }
  return false;
}

/** Whether a literal CSS value is free of characters and constructs that could escape its declaration. */
export function isSafeCssValue(value: string): boolean {
  return SAFE_RE.test(value) && !INJECTION_RE.test(value) && balanced(value);
}

const COLOR_FUNCTIONS = ['rgb', 'rgba', 'hsl', 'hsla', 'oklch', 'oklab', 'lab', 'lch', 'color-mix'];
const MATH_FUNCTIONS = ['calc', 'clamp', 'min', 'max', 'var'];
const GRADIENTS = ['linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient'];
const GRADIENT_FUNCTIONS = new Set([...GRADIENTS, ...COLOR_FUNCTIONS, ...MATH_FUNCTIONS]);
const GRADIENT_RE = new RegExp(`^(${GRADIENTS.join('|')})\\(`, 'i');
const CUSTOM_CSS_FUNCTIONS = new Set([
  ...GRADIENT_FUNCTIONS, 'repeat', 'minmax', 'fit-content',
  'translate', 'translatex', 'translatey', 'rotate', 'scale', 'scalex', 'scaley', 'skew', 'skewx', 'skewy', 'perspective',
  'blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'hue-rotate', 'invert', 'opacity', 'saturate', 'sepia',
  'cubic-bezier', 'steps', 'polygon', 'circle', 'ellipse', 'inset'
]);
/**
 * What customCss may set. An allowlist, so properties that execute or load content (behavior, -moz-binding), that
 * escape the element (position, z-index and offsets have their own validated controls) or need strings stay out.
 */
const CUSTOM_CSS_PROPS = new Set(
  (
    'accent-color align-content align-items align-self aspect-ratio backdrop-filter background-blend-mode background-color ' +
    'background-image background-position background-repeat background-size border-color border-radius border-style border-width ' +
    'box-shadow caret-color clip-path color column-count column-gap columns display filter flex flex-basis flex-direction flex-flow ' +
    'flex-grow flex-shrink flex-wrap font-size font-stretch font-style font-variant font-variant-numeric font-weight gap ' +
    'grid-auto-columns grid-auto-flow grid-auto-rows grid-column grid-row grid-template-columns grid-template-rows height hyphens ' +
    'isolation justify-content justify-items justify-self letter-spacing line-height list-style-type margin margin-block ' +
    'margin-block-end margin-block-start margin-inline margin-inline-end margin-inline-start max-height max-width min-height ' +
    'min-width mix-blend-mode object-fit object-position opacity order outline outline-color outline-offset outline-style ' +
    'outline-width overflow overflow-wrap overflow-x overflow-y padding padding-block padding-block-end padding-block-start ' +
    'padding-inline padding-inline-end padding-inline-start place-content place-items place-self rotate row-gap scale ' +
    'text-align text-decoration text-decoration-color text-decoration-line text-decoration-style text-decoration-thickness ' +
    'text-indent text-overflow text-shadow text-transform text-underline-offset text-wrap transform transform-origin transition ' +
    'transition-delay transition-duration transition-property transition-timing-function translate vertical-align ' +
    'white-space width word-break word-spacing writing-mode'
  ).split(' ')
);
const CUSTOM_CSS_VALUE_RE = /^[0-9a-z.,%+\-*/_ ()#]+$/i;
const NO_VARIABLE_PROPS = new Set(['filter', 'backdrop-filter', 'clip-path']);
const MAX_CUSTOM_CSS = 2000;
const MAX_CUSTOM_DECLS = 24;

/** Whether every function in a value is allowed, and every var() names a site token. */
function functionsAllowed(value: string, allowed: Set<string>): boolean {
  // The whole name, so "--x1blur(" is not read as blur().
  for (const m of value.matchAll(/([a-z0-9_-]*)\(/gi)) if (m[1] && !allowed.has(m[1].toLowerCase())) return false;
  for (const m of value.matchAll(/var\(([^)]*)\)/gi)) if (!/^\s*--so-[a-z0-9-]+\s*$/i.test(m[1])) return false;
  return true;
}

export function isGradient(value: string): boolean {
  return GRADIENT_RE.test(value.trim());
}

/** Complete gradients, layered with commas; the bottom layer may be a plain color. */
export function isValidGradient(raw: string): boolean {
  const value = raw.trim();
  if (value.length > 400 || !/^[0-9a-z.,%+\-*/ ()#]+$/i.test(value) || !balanced(value) || !functionsAllowed(value, GRADIENT_FUNCTIONS)) return false;
  const layers = splitTop(value, (ch) => ch === ',');
  return layers.length > 0 && isGradient(layers[0]) && layers.every((l, i) => (isGradient(l) && wholeCall(l)) || (i > 0 && i === layers.length - 1 && COLOR_RE.test(l)));
}

/**
 * Parse scoped custom CSS: property declarations only, each checked against the property and function allowlists.
 * Selectors, at-rules, braces, quotes, escapes, comments, !important and url() have no way through.
 */
export function parseCustomCss(text: string): { decls: string[]; error: string | null } {
  const bad = (error: string) => ({ decls: [], error });
  const source = text.trim();
  if (source.length > MAX_CUSTOM_CSS) return bad('Custom CSS is too long.');
  if (!isSafeCssValue(source.replace(/;/g, ' '))) return bad('Custom CSS can only hold property declarations: no braces, comments, escapes, at-rules or url().');
  const parts = source.split(';').map((d) => d.trim()).filter(Boolean);
  if (parts.length > MAX_CUSTOM_DECLS) return bad(`Custom CSS can hold at most ${MAX_CUSTOM_DECLS} declarations.`);
  const decls: string[] = [];
  for (const part of parts) {
    const i = part.indexOf(':');
    if (i <= 0) return bad(`"${part.slice(0, 40)}" is not a property declaration.`);
    const prop = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim().replace(/\s+/g, ' ');
    if (!CUSTOM_CSS_PROPS.has(prop)) return bad(`"${prop.slice(0, 40)}" cannot be set in custom CSS.`);
    if (!value || !CUSTOM_CSS_VALUE_RE.test(value) || !balanced(value) || !isSafeCssValue(value) || !functionsAllowed(value, CUSTOM_CSS_FUNCTIONS)) return bad(`The value of ${prop} is not allowed in custom CSS.`);
    // These can load a resource, so a variable (whose value is set elsewhere) cannot stand in for their value.
    if (prop === 'background-image' && !isValidGradient(value)) return bad('background-image in custom CSS must be a gradient.');
    if (NO_VARIABLE_PROPS.has(prop) && /var\(/i.test(value)) return bad(`The value of ${prop} cannot use var() in custom CSS.`);
    decls.push(`${prop}: ${value}`);
  }
  return { decls, error: null };
}

/** Validate a literal style value. Returns an error message or null. */
export function validateStyleValue(propId: string, value: StyleValue): string | null {
  const def = STYLE_PROP_MAP[propId];
  if (!def) return `Unknown style property "${propId}".`;
  if (typeof value === 'object' && value !== null) {
    if (typeof value.token !== 'string') return 'Token reference must have a token ID.';
    if (!def.tokenGroup) return `${def.label} cannot use a token.`;
    const groups = Array.isArray(def.tokenGroup) ? def.tokenGroup : [def.tokenGroup];
    if (!groups.some((g) => value.token.startsWith(g + '.'))) return `${def.label} needs a ${groups.join(' or ')} token, not "${value.token}".`;
    return null;
  }
  const s = String(value).trim();
  if (def.kind === 'css') return typeof value === 'string' ? parseCustomCss(s).error : `${def.label} must be text.`;
  if (!isSafeCssValue(s)) return `Invalid characters in ${def.label}.`;
  switch (def.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : `${def.label} must be true or false.`;
    case 'number': {
      const n = Number(value);
      if (typeof value === 'boolean' || s === '' || !Number.isFinite(n)) return `${def.label} must be a number.`;
      if (def.min !== undefined && n < def.min) return `${def.label} must be at least ${def.min}.`;
      if (def.max !== undefined && n > def.max) return `${def.label} must be at most ${def.max}.`;
      if (def.integer && !Number.isInteger(n)) return `${def.label} must be a whole number.`;
      return null;
    }
    case 'enum':
      return def.options!.some((o) => o.value === s) ? null : `${def.label} must be one of: ${def.options!.map((o) => o.value).join(', ')}.`;
    case 'ratio':
      return /^(auto|\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?)$/.test(s) ? null : `${def.label} must look like 16/9.`;
    case 'color':
      if (propId === 'background' && isGradient(s)) return isValidGradient(s) ? null : `"${s.slice(0, 60)}" is not a supported gradient. Use colors, angles and percentages inside linear-gradient(), radial-gradient() or conic-gradient().`;
      return COLOR_RE.test(s) ? null : `"${s}" is not a supported color. Use a hex value, rgb(), hsl() or oklch().`;
    case 'length':
      if (def.options?.some((o) => o.value === s)) return null;
      if (propId === 'lineHeight' && /^\d*\.?\d+$/.test(s)) return null;
      if (propId === 'inset') {
        // One to four offsets; spaces inside calc() and friends do not separate values.
        const parts = splitTop(s, (ch) => /\s/.test(ch));
        return parts.length <= 4 && parts.every((x) => LENGTH_RE.test(x) || FN_RE.test(x)) ? null : `"${s}" is not a valid offset. Use one to four lengths such as 0 or 12px 24px.`;
      }
      return LENGTH_RE.test(s) || FN_RE.test(s) ? null : `"${s}" is not a valid length. Use values such as 24px, 1.5rem or 50%.`;
    case 'textStyle':
      // Text styles are token references. A bare token ID ("text.h2") is read as one; anything else is refused.
      return TEXT_TOKEN_RE.test(s) ? null : `${def.label} must be a text token reference such as { "token": "text.h2" }, not "${s.slice(0, 40)}".`;
    case 'shadow':
    case 'border':
    case 'font':
      return s.length < 200 ? null : `${def.label} value is too long.`;
  }
  return null;
}

function cssValue(v: StyleValue): string {
  if (typeof v === 'object' && v !== null) return `var(${tokenVar(v.token)})`;
  return String(v);
}

/** Fixed-grammar properties: a hand-edited document that breaks the grammar writes nothing. */
const CHECKED_AT_OUTPUT = new Set(['gridTemplate', 'columnSpan', 'alignSelf', 'flexGrow', 'flexShrink', 'objectPosition', 'overflow', 'position', 'inset', 'zIndex', 'fontStyle', 'textTransform']);

/** Convert one style property into CSS declarations. */
export function styleToCss(propId: string, raw: StyleValue): string[] {
  if (typeof raw === 'object' && raw !== null && typeof raw.token !== 'string') return [];
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (CHECKED_AT_OUTPUT.has(propId) && validateStyleValue(propId, value)) return [];
  const v = cssValue(value);
  switch (propId) {
    case 'layout':
      if (value === 'stack') return ['display: flex', 'flex-direction: column'];
      if (value === 'row') return ['display: flex', 'flex-direction: row'];
      if (value === 'grid') return ['display: grid'];
      return ['display: block'];
    case 'columns':
      return [`grid-template-columns: repeat(${Number(value)}, minmax(0, 1fr))`];
    case 'align':
      return [`align-items: ${v}`];
    case 'justify':
      return [`justify-content: ${v}`];
    case 'order':
      return [`order: ${Number(value)}`];
    case 'wrap':
      return [`flex-wrap: ${value ? 'wrap' : 'nowrap'}`];
    case 'gridTemplate':
      if (value === 'auto-fit-sm') return ['grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr))'];
      if (value === 'auto-fit-md') return ['grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr))'];
      // minmax(0, ...) lets a track shrink below its content, as `columns` does.
      return [`grid-template-columns: ${v.replace(/[\d.]+fr/g, (t) => `minmax(0, ${t})`)}`];
    case 'columnSpan':
      return [value === 'full' ? 'grid-column: 1 / -1' : `grid-column: span ${Number(value)} / span ${Number(value)}`];
    case 'alignSelf':
      return [`align-self: ${v}`];
    case 'flexGrow':
      return [`flex-grow: ${Number(value)}`];
    case 'flexShrink':
      return [`flex-shrink: ${Number(value)}`];
    case 'gap':
      return [`gap: ${v}`];
    case 'rowGap':
      return [`row-gap: ${v}`];
    case 'columnGap':
      return [`column-gap: ${v}`];
    case 'paddingBlock':
      return [`padding-block: ${v}`];
    case 'paddingInline':
      return [`padding-inline: ${v}`];
    case 'paddingBlockStart':
      return [`padding-block-start: ${v}`];
    case 'paddingBlockEnd':
      return [`padding-block-end: ${v}`];
    case 'paddingInlineStart':
      return [`padding-inline-start: ${v}`];
    case 'paddingInlineEnd':
      return [`padding-inline-end: ${v}`];
    case 'marginBlockStart':
      return [`margin-block-start: ${v}`];
    case 'marginBlockEnd':
      return [`margin-block-end: ${v}`];
    case 'marginInlineStart':
      return [`margin-inline-start: ${v}`];
    case 'marginInlineEnd':
      return [`margin-inline-end: ${v}`];
    case 'width':
      if (value === 'fill') return ['width: 100%'];
      if (value === 'fit') return ['width: fit-content'];
      return [`width: ${v}`];
    case 'maxWidth':
      return [`max-width: ${v}`];
    case 'minWidth':
      return [`min-width: ${v}`];
    case 'height':
      return [`height: ${v}`];
    case 'minHeight':
      return [`min-height: ${v}`];
    case 'maxHeight':
      return [`max-height: ${v}`];
    case 'overflow':
      return [`overflow: ${v}`];
    case 'marginInline':
      return [`margin-inline: ${v}`];
    case 'aspectRatio':
      return [`aspect-ratio: ${v}`];
    case 'objectFit':
      return [`object-fit: ${v}`];
    case 'objectPosition':
      return [`object-position: ${v}`];
    case 'textStyle': {
      const token = typeof value === 'object' && value !== null ? value.token : typeof value === 'string' && TEXT_TOKEN_RE.test(value.trim()) ? value.trim() : null;
      if (token) {
        const base = tokenVar(token);
        return [
          `font-family: var(${base}-family)`,
          `font-size: var(${base}-size)`,
          `line-height: var(${base}-line-height)`,
          `font-weight: var(${base}-weight)`,
          `letter-spacing: var(${base}-tracking)`,
          `text-transform: var(${base}-transform, none)`
        ];
      }
      return [];
    }
    case 'fontFamily':
      return [`font-family: ${v}`];
    case 'fontSize':
      return [`font-size: ${v}`];
    case 'fontWeight':
      return [`font-weight: ${v}`];
    case 'fontStyle':
      return [`font-style: ${v}`];
    case 'textTransform':
      return [`text-transform: ${v}`];
    case 'lineHeight':
      return [`line-height: ${v}`];
    case 'letterSpacing':
      return [`letter-spacing: ${v}`];
    case 'textAlign':
      return [`text-align: ${v}`];
    case 'color':
      return [`color: ${v}`];
    case 'background':
      return [`background: ${v}`];
    case 'border':
      return [`border: ${v}`];
    case 'borderBlockStart':
      return [`border-block-start: ${v}`];
    case 'borderBlockEnd':
      return [`border-block-end: ${v}`];
    case 'borderInlineStart':
      return [`border-inline-start: ${v}`];
    case 'borderInlineEnd':
      return [`border-inline-end: ${v}`];
    case 'radius':
      return [`border-radius: ${v}`];
    case 'shadow':
      return [`box-shadow: ${v}`];
    case 'opacity':
      return [`opacity: ${v}`];
    case 'position':
      return [`position: ${v}`];
    case 'inset':
      return [`inset: ${v}`];
    case 'zIndex':
      return [`z-index: ${Number(value)}`];
    case 'hidden':
      return value ? ['display: none'] : [];
    case 'customCss':
      // Read again here: a hand-edited document never reached validateStyleValue.
      return typeof value === 'string' ? parseCustomCss(value).decls : [];
  }
  return [];
}

export const MEDIA_QUERIES: Record<'phone' | 'tablet' | 'desktop', string> = {
  phone: '(max-width: 767.98px)',
  tablet: '(min-width: 768px) and (max-width: 1023.98px)',
  desktop: '(min-width: 1024px)'
};

export const VIEWPORT_PRESETS = {
  desktop: 1280,
  tablet: 834,
  phone: 390
} as const;

export function scopeForWidth(width: number): 'phone' | 'tablet' | 'desktop' {
  if (width < 768) return 'phone';
  if (width < 1024) return 'tablet';
  return 'desktop';
}
