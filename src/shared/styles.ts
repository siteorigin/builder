import type { StyleValue, TokenGroup } from './types';

/**
 * The finite set of visual style properties the editor and AI can set.
 * Anything outside this list belongs in a code component.
 */

export type StyleValueKind = 'length' | 'color' | 'enum' | 'number' | 'boolean' | 'ratio' | 'textStyle' | 'font' | 'shadow' | 'border';

export interface StylePropDef {
  id: string;
  label: string;
  group: 'layout' | 'spacing' | 'size' | 'typography' | 'appearance' | 'visibility';
  kind: StyleValueKind;
  /** Token group whose tokens can be linked. */
  tokenGroup?: TokenGroup | TokenGroup[];
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  description?: string;
}

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
  { id: 'gap', label: 'Gap', group: 'layout', kind: 'length', tokenGroup: 'space', placeholder: '24px' },
  { id: 'paddingBlock', label: 'Vertical padding', description: 'Space inside, above and below the content.', group: 'spacing', kind: 'length', tokenGroup: 'space', placeholder: '64px' },
  { id: 'paddingInline', label: 'Side padding', description: 'Space inside, left and right of the content.', group: 'spacing', kind: 'length', tokenGroup: ['space', 'container'], placeholder: '24px' },
  { id: 'marginBlockStart', label: 'Space above', group: 'spacing', kind: 'length', tokenGroup: 'space', placeholder: '0' },
  { id: 'marginBlockEnd', label: 'Space below', group: 'spacing', kind: 'length', tokenGroup: 'space', placeholder: '0' },
  { id: 'width', label: 'Width', group: 'size', kind: 'length', options: [
    { value: 'fill', label: 'Fill' }, { value: 'fit', label: 'Fit content' }, { value: 'auto', label: 'Auto' }
  ], placeholder: 'fill' },
  { id: 'maxWidth', label: 'Max width', group: 'size', kind: 'length', tokenGroup: ['container', 'space'], placeholder: '1200px' },
  { id: 'minHeight', label: 'Min height', group: 'size', kind: 'length', placeholder: '0' },
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
  { id: 'textStyle', label: 'Text style', group: 'typography', kind: 'textStyle', tokenGroup: 'text' },
  { id: 'fontFamily', label: 'Font', group: 'typography', kind: 'font', tokenGroup: 'font' },
  { id: 'fontSize', label: 'Size', group: 'typography', kind: 'length', placeholder: '1rem' },
  { id: 'fontWeight', label: 'Weight', group: 'typography', kind: 'enum', options: [
    { value: '300', label: 'Light' }, { value: '400', label: 'Regular' }, { value: '500', label: 'Medium' },
    { value: '600', label: 'Semibold' }, { value: '700', label: 'Bold' }, { value: '800', label: 'Extra bold' }
  ] },
  { id: 'lineHeight', label: 'Line height', group: 'typography', kind: 'length', placeholder: '1.5' },
  { id: 'letterSpacing', label: 'Letter spacing', group: 'typography', kind: 'length', placeholder: '0em' },
  { id: 'textAlign', label: 'Alignment', group: 'typography', kind: 'enum', options: [
    { value: 'start', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'end', label: 'Right' }
  ] },
  { id: 'color', label: 'Text color', group: 'appearance', kind: 'color', tokenGroup: 'color' },
  { id: 'background', label: 'Background', group: 'appearance', kind: 'color', tokenGroup: 'color' },
  { id: 'border', label: 'Border', group: 'appearance', kind: 'border', tokenGroup: 'border' },
  { id: 'radius', label: 'Corner radius', group: 'appearance', kind: 'length', tokenGroup: 'radius', placeholder: '8px' },
  { id: 'shadow', label: 'Shadow', group: 'appearance', kind: 'shadow', tokenGroup: 'shadow' },
  { id: 'opacity', label: 'Opacity', group: 'appearance', kind: 'number', min: 0, max: 1, step: 0.05 },
  { id: 'hidden', label: 'Hidden', group: 'visibility', kind: 'boolean' }
];

export const STYLE_PROP_MAP: Record<string, StylePropDef> = Object.fromEntries(STYLE_PROPS.map((p) => [p.id, p]));

/** The style properties that do something on a node of this kind; undefined offers all of them. */
export function styleSetFor(node: { kind: string }): string[] | undefined {
  const spacing = ['marginBlockStart', 'marginBlockEnd', 'paddingBlock', 'paddingInline'];
  const appearance = ['color', 'background', 'border', 'radius', 'shadow', 'opacity', 'hidden'];
  switch (node.kind) {
    case 'text':
      return ['textStyle', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign', 'maxWidth', ...spacing, ...appearance];
    case 'image':
      return ['width', 'maxWidth', 'aspectRatio', 'objectFit', 'radius', 'shadow', 'marginBlockStart', 'marginBlockEnd', 'opacity', 'hidden'];
    case 'link':
      return ['width', 'marginBlockStart', 'marginBlockEnd', 'color', 'background', 'radius', 'hidden'];
    case 'icon':
      return ['color', 'fontSize', 'background', 'radius', 'hidden'];
    case 'element':
      return ['layout', 'columns', 'align', 'justify', 'wrap', 'gap', 'order', ...spacing, 'width', 'maxWidth', 'minHeight', 'marginInline', 'textAlign', 'color', 'background', 'border', 'radius', 'shadow', 'opacity', 'hidden'];
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
  visibility: 'Visibility'
};

export function tokenVar(tokenId: string): string {
  return `--so-${tokenId.replace(/[^a-zA-Z0-9]+/g, '-')}`;
}

const LENGTH_RE = /^(-?\d*\.?\d+(px|rem|em|%|vw|vh|svh|dvh|ch|ex)?|auto|0)$/;
const FN_RE = /^(clamp|min|max|calc)\([0-9a-z.,%+\-*/ ()]+\)$/i;
const COLOR_RE = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color-mix)\([0-9a-z.,%+\-/ ()#]+\)|transparent|currentcolor|white|black)$/i;
const SAFE_RE = /^[^;{}<>\\]*$/;
const TEXT_TOKEN_RE = /^text\.[a-z0-9-]+$/;

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
  if (!SAFE_RE.test(s)) return `Invalid characters in ${def.label}.`;
  switch (def.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : `${def.label} must be true or false.`;
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return `${def.label} must be a number.`;
      if (def.min !== undefined && n < def.min) return `${def.label} must be at least ${def.min}.`;
      if (def.max !== undefined && n > def.max) return `${def.label} must be at most ${def.max}.`;
      return null;
    }
    case 'enum':
      return def.options!.some((o) => o.value === s) ? null : `${def.label} must be one of: ${def.options!.map((o) => o.value).join(', ')}.`;
    case 'ratio':
      return /^(auto|\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?)$/.test(s) ? null : `${def.label} must look like 16/9.`;
    case 'color':
      return COLOR_RE.test(s) ? null : `"${s}" is not a supported color. Use a hex value, rgb(), hsl() or oklch().`;
    case 'length':
      if (def.options?.some((o) => o.value === s)) return null;
      if (propId === 'lineHeight' && /^\d*\.?\d+$/.test(s)) return null;
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

/** Convert one style property into CSS declarations. */
export function styleToCss(propId: string, value: StyleValue): string[] {
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
    case 'gap':
      return [`gap: ${v}`];
    case 'paddingBlock':
      return [`padding-block: ${v}`];
    case 'paddingInline':
      return [`padding-inline: ${v}`];
    case 'marginBlockStart':
      return [`margin-block-start: ${v}`];
    case 'marginBlockEnd':
      return [`margin-block-end: ${v}`];
    case 'width':
      if (value === 'fill') return ['width: 100%'];
      if (value === 'fit') return ['width: fit-content'];
      return [`width: ${v}`];
    case 'maxWidth':
      return [`max-width: ${v}`];
    case 'minHeight':
      return [`min-height: ${v}`];
    case 'marginInline':
      return [`margin-inline: ${v}`];
    case 'aspectRatio':
      return [`aspect-ratio: ${v}`];
    case 'objectFit':
      return [`object-fit: ${v}`];
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
    case 'radius':
      return [`border-radius: ${v}`];
    case 'shadow':
      return [`box-shadow: ${v}`];
    case 'opacity':
      return [`opacity: ${v}`];
    case 'hidden':
      return value ? ['display: none'] : [];
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
