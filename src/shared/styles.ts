import { isFocusValue } from './focus';
import { backgroundImageError, canonicalBackgroundImage, isBackgroundImageValue } from './background-image';
import type { ComponentDefinition, ContainerScope, ResponsiveScope, ResponsiveStyles, StyleScope, StyleProps, StyleState, StyleTokenRef, StyleValue, TextStyleValue, TokenDef, TokenGroup, TokenValue } from './types';
import { isContainerScope, parseStyleScopeKey, STYLE_STATES, styleScopeKey } from './types';

/**
 * The finite set of visual style properties the editor and AI can set.
 * Anything outside this list belongs in a code component.
 */

export type StyleValueKind = 'length' | 'color' | 'enum' | 'number' | 'boolean' | 'ratio' | 'focus' | 'textStyle' | 'font' | 'shadow' | 'border' | 'css' | 'tracks' | 'media';

export interface StylePropDef {
  id: string;
  label: string;
  group: 'layout' | 'spacing' | 'size' | 'typography' | 'appearance' | 'position' | 'motion' | 'visibility' | 'custom';
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
  /** The unit a number is written in (deg, ms), shown beside its range. */
  unit?: string;
  /** Less common: kept behind "More style options" until it has a value. */
  advanced?: boolean;
}

/** How far a shift can move an element, by unit. */
export const TRANSLATE_LIMITS = { px: 500, rem: 32, em: 32, '%': 100 } as const;
/** How strong a backdrop blur can be, by unit: a wider blur costs every frame that scrolls beneath it. */
export const BLUR_LIMITS = { px: 64, rem: 4, em: 4 } as const;
/** Browsers only transform boxes: an inline run of text has none of its own. */
const INLINE_NOTE = ' Plain inline text, such as a link inside a sentence, does not move.';
const TRANSFORM_ORIGINS = ['center', 'top', 'bottom', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right'];

/** The most tracks a column-size list can make, and the most rows an item can span. */
export const MAX_GRID_TRACKS = 12;
export const MAX_ROW_SPAN = 6;

/**
 * Pinned in view while the content beside it scrolls past, clear of the site's sticky header: the header publishes the
 * height it takes up as --so-header-offset (0 when it does not stick), and 1.5rem more keeps the two apart. Released
 * at the end of its parent. Print shows it in its place (base.css).
 */
export const STICKY_BELOW_HEADER = { position: 'sticky', inset: 'calc(var(--so-header-offset, 4.5rem) + 1.5rem) auto auto auto', alignSelf: 'start' } as const;
const GRID_TEMPLATE_HELP =
  'Overrides Columns. A preset, or your own list of up to 12 column widths: fr shares, lengths, auto, minmax(min, max) and repeat(count, …), ' +
  'such as "16rem 1fr 14rem" or "2fr repeat(2, 1fr)". For as many columns as fit, give the narrowest a column may get: ' +
  '"repeat(auto-fit, minmax(18rem, 1fr))", or auto-fill to keep empty columns. Applies from tablet up unless a phone value is set.';

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
  { id: 'gridTemplate', label: 'Column sizes', group: 'layout', kind: 'tracks', placeholder: '16rem 1fr 14rem', description: GRID_TEMPLATE_HELP, options: [
    { value: '1fr 1fr', label: 'Equal halves' }, { value: '1fr 2fr', label: 'Narrow, wide' }, { value: '2fr 1fr', label: 'Wide, narrow' },
    { value: '1fr 1.5fr', label: 'Slightly wider second' }, { value: '1.5fr 1fr', label: 'Slightly wider first' },
    { value: 'auto-fit-sm', label: 'As many as fit (small)' }, { value: 'auto-fit-md', label: 'As many as fit (medium)' }
  ] },
  { id: 'containerType', label: 'Query container', group: 'layout', kind: 'enum', advanced: true, description: 'Makes this box the width its contents\' container rules (narrow, medium, wide) read, so a card in a narrow column can stack while the same card in a wide one stays side by side. Use it on a box its parent sizes, such as a grid column or a stretched stack: inside one sized to its content (a horizontal stack without grow, Fit content) it shrinks to nothing.', options: [
    { value: 'inline-size', label: 'Its width' }, { value: 'normal', label: 'None' }
  ] },
  { id: 'gap', label: 'Gap', group: 'layout', kind: 'length', tokenGroup: 'space', placeholder: '24px' },
  { id: 'rowGap', label: 'Row gap', group: 'layout', kind: 'length', tokenGroup: 'space', placeholder: '24px', advanced: true },
  { id: 'columnGap', label: 'Column gap', group: 'layout', kind: 'length', tokenGroup: 'space', placeholder: '24px', advanced: true },
  { id: 'columnSpan', label: 'Column span', group: 'layout', kind: 'enum', advanced: true, description: 'Columns this takes up inside a grid. Applies from tablet up unless a phone value is set.', options: [
    ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })), { value: 'full', label: 'Full width' }
  ] },
  { id: 'rowSpan', label: 'Row span', group: 'layout', kind: 'enum', advanced: true, description: 'Rows this takes up inside a grid, for a tall featured card. Applies from tablet up unless a phone value is set.', options:
    Array.from({ length: MAX_ROW_SPAN }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))
  },
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
  { id: 'objectPosition', label: 'Image focus', group: 'size', kind: 'focus', description: 'Which part stays in view when the image is cropped: a keyword, or "X% Y%" across and down the picture.', options: [
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
  { id: 'background', label: 'Background', description: 'A color, or a linear-, radial- or conic-gradient(). A Site styles color can be made see-through.', group: 'appearance', kind: 'color', tokenGroup: 'color' },
  { id: 'backgroundImage', label: 'Background image', group: 'appearance', kind: 'media', description: 'A picture from the library behind the content: filling the box, cropped around its focus, or shown whole. A scrim (a color or gradient over the picture) keeps text on top readable. The background color shows wherever the picture does not reach.' },
  { id: 'border', label: 'Border', group: 'appearance', kind: 'border', tokenGroup: 'border' },
  edge('borderBlockStart', 'Border top', 'appearance', 'border', 'border', '1px solid #ddd'),
  edge('borderBlockEnd', 'Border bottom', 'appearance', 'border', 'border', '1px solid #ddd'),
  edge('borderInlineStart', 'Border left', 'appearance', 'border', 'border', '1px solid #ddd'),
  edge('borderInlineEnd', 'Border right', 'appearance', 'border', 'border', '1px solid #ddd'),
  { id: 'radius', label: 'Corner radius', group: 'appearance', kind: 'length', tokenGroup: 'radius', placeholder: '8px' },
  { id: 'shadow', label: 'Shadow', group: 'appearance', kind: 'shadow', tokenGroup: 'shadow' },
  { id: 'opacity', label: 'Opacity', group: 'appearance', kind: 'number', min: 0, max: 1, step: 0.05 },
  { id: 'backdropBlur', label: 'Backdrop blur', group: 'appearance', kind: 'length', advanced: true, placeholder: '12px', description: `Blurs what shows through a see-through background, for frosted glass: pair it with a background at less than full strength. 0 or one length in px, rem or em, at most ${BLUR_LIMITS.px}px.`, options: [
    { value: '0', label: 'None' }, { value: '4px', label: 'Light' }, { value: '12px', label: 'Frosted' }, { value: '24px', label: 'Heavy' }
  ] },
  { id: 'position', label: 'Position', group: 'position', kind: 'enum', description: 'Sticky keeps it in view while scrolling; absolute places it inside the nearest positioned parent.', options: [
    { value: 'static', label: 'Normal' }, { value: 'relative', label: 'Relative' }, { value: 'sticky', label: 'Sticky' }, { value: 'absolute', label: 'Absolute' }
  ] },
  { id: 'inset', label: 'Offset', group: 'position', kind: 'length', placeholder: '0', description: 'Distance from the edges: one value, or top, right, bottom and left.' },
  { id: 'zIndex', label: 'Layer', group: 'position', kind: 'number', min: -1, max: 100, step: 1, integer: true, description: 'Higher layers sit in front.' },
  { id: 'translateX', label: 'Shift sideways', group: 'motion', kind: 'length', advanced: true, placeholder: '8px', description: `Moves it without moving anything around it: a length in px, rem or em, or a % of its own width. Negative moves it left. At most ${TRANSLATE_LIMITS.px}px.${INLINE_NOTE}` },
  { id: 'translateY', label: 'Shift up or down', group: 'motion', kind: 'length', advanced: true, placeholder: '-4px', description: `Moves it without moving anything around it: a length in px, rem or em, or a % of its own height. Negative lifts it up. At most ${TRANSLATE_LIMITS.px}px.${INLINE_NOTE}` },
  { id: 'scale', label: 'Scale', group: 'motion', kind: 'number', min: 0, max: 3, step: 0.01, advanced: true, description: `Its size as drawn, without moving anything around it: 1 is its own size, 1.05 is 5% larger.${INLINE_NOTE}` },
  { id: 'rotate', label: 'Rotate', group: 'motion', kind: 'number', min: -360, max: 360, step: 1, unit: 'deg', advanced: true, description: `Degrees clockwise; negative turns it the other way.${INLINE_NOTE}` },
  { id: 'transformOrigin', label: 'Turn and scale from', group: 'motion', kind: 'enum', advanced: true, description: 'The point it rotates and scales around.', options: TRANSFORM_ORIGINS.map((value) => ({ value, label: value.replace(/^./, (c) => c.toUpperCase()) })) },
  { id: 'transition', label: 'Animate changes', group: 'motion', kind: 'enum', advanced: true, description: 'Which changes (on hover, say) ease in over the duration instead of jumping. Visitors who ask for reduced motion see them jump.', options: [
    { value: 'none', label: 'None' }, { value: 'colors', label: 'Colors' }, { value: 'shadow', label: 'Shadow' }, { value: 'transform', label: 'Shift, scale and rotate' },
    { value: 'opacity', label: 'Opacity' }, { value: 'common', label: 'Colors, shadow, movement and opacity' }
  ] },
  { id: 'transitionDuration', label: 'Duration', group: 'motion', kind: 'number', min: 0, max: 3000, step: 50, integer: true, unit: 'ms', advanced: true, description: 'How long a change takes, in milliseconds.' },
  { id: 'transitionEasing', label: 'Easing', group: 'motion', kind: 'enum', advanced: true, description: 'How a change speeds up and slows down.', options: [
    { value: 'ease', label: 'Ease' }, { value: 'ease-out', label: 'Ease out' }, { value: 'ease-in', label: 'Ease in' }, { value: 'ease-in-out', label: 'Ease in and out' },
    { value: 'linear', label: 'Linear' }, { value: 'smooth', label: 'Smooth' }, { value: 'overshoot', label: 'Overshoot' }
  ] },
  { id: 'hidden', label: 'Hidden', group: 'visibility', kind: 'boolean' },
  { id: 'customCss', label: 'Custom CSS', group: 'custom', kind: 'css', advanced: true, placeholder: 'filter: saturate(1.2); mix-blend-mode: multiply', description: 'Extra property declarations for this element only. No selectors, at-rules, url() or comments.' }
];

export const STYLE_PROP_MAP: Record<string, StylePropDef> = Object.fromEntries(STYLE_PROPS.map((p) => [p.id, p]));

/**
 * The style properties a rule for an interactive state (hover, focus, pressed) may set: how the element looks (its
 * colors, background, borders, corners, shadow, opacity and backdrop blur), never its layout, size, visibility or motion, which
 * would move what is around it, or the transition that animates the change (that belongs on its resting style).
 */
export const STATE_STYLE_PROPS: readonly string[] = STYLE_PROPS.filter((p) => p.group === 'appearance').map((p) => p.id);
/**
 * What a group state (the group around it hovered or focused) may set besides: a shift, scale or turn, which moves the
 * element as drawn and nothing around it (a card's arrow nudged along). Where it turns and scales from, and how the
 * change is animated, stay on the resting style.
 */
export const GROUP_STATE_EXTRA_PROPS: readonly string[] = ['translateX', 'translateY', 'scale', 'rotate'];
export const GROUP_STATE_STYLE_PROPS: readonly string[] = [...STATE_STYLE_PROPS, ...GROUP_STATE_EXTRA_PROPS];
const STATE_STYLE_PROP_SET = new Set(STATE_STYLE_PROPS);
const GROUP_STATE_STYLE_PROP_SET = new Set(GROUP_STATE_STYLE_PROPS);
/** The properties a rule for `state` may set; with no state, those any state may (a group state's). */
export const stateStyleProps = (state?: StyleState | null): readonly string[] => (state === 'hover' || state === 'focus' || state === 'active' ? STATE_STYLE_PROPS : GROUP_STATE_STYLE_PROPS);
/** Whether a rule for `state` may set `prop`. With no state: whether the element's own hover, focus or press may. */
export const isStateStyleProp = (prop: string, state?: StyleState | null): boolean => (state === 'groupHover' || state === 'groupFocus' ? GROUP_STATE_STYLE_PROP_SET : STATE_STYLE_PROP_SET).has(prop);
/** Why a rule for `state` cannot set `prop`, or null when it can. */
export function stateStyleError(prop: string, state?: StyleState | null): string | null {
  if (isStateStyleProp(prop, state)) return null;
  const label = Object.hasOwn(STYLE_PROP_MAP, prop) ? STYLE_PROP_MAP[prop].label : prop;
  const names = (ids: readonly string[]) => ids.map((p) => STYLE_PROP_MAP[p].label.toLowerCase()).join(', ');
  if (state === 'groupHover' || state === 'groupFocus')
    return `${label} cannot change ${STATE_WORDS[state]}: a group state changes only ${names(GROUP_STATE_STYLE_PROPS)}. Set it on the resting style.`;
  // A shift, scale or turn is refused on the element's own state, but its group's can take it.
  const group = GROUP_STATE_STYLE_PROP_SET.has(prop) ? ' A group state (its card hovered or focused) can change it.' : '';
  return `${label} cannot change on hover, focus or press: a state changes only ${names(STATE_STYLE_PROPS)}. Set it on the resting style.${group}`;
}
/** Words for an interactive state, after a size ("on hover", "with keyboard focus", "while pressed"). */
export const STATE_WORDS: Record<StyleState, string> = {
  groupHover: 'while its group is hovered',
  groupFocus: 'while its group has focus',
  hover: 'on hover',
  focus: 'with keyboard focus',
  active: 'while pressed'
};
/** Whether a set of styles holds any rule for an interactive state. */
export const hasStateStyles = (styles: ResponsiveStyles | undefined): boolean => Object.keys(styles ?? {}).some((k) => !!parseStyleScopeKey(k)?.state);

/** The style properties that do something on a node of this kind; undefined offers all of them. */
export function styleSetFor(node: { kind: string }): string[] | undefined {
  const margins = ['marginBlockStart', 'marginBlockEnd', 'marginInlineStart', 'marginInlineEnd'];
  const spacing = [...margins, 'paddingBlock', 'paddingInline', 'paddingBlockStart', 'paddingBlockEnd', 'paddingInlineStart', 'paddingInlineEnd'];
  const borders = ['border', 'borderBlockStart', 'borderBlockEnd', 'borderInlineStart', 'borderInlineEnd'];
  const appearance = ['color', 'background', ...borders, 'radius', 'shadow', 'opacity', 'backdropBlur'];
  // A box that holds content can show a picture behind it.
  const boxAppearance = ['color', 'background', 'backgroundImage', ...borders, 'radius', 'shadow', 'opacity', 'backdropBlur'];
  // How an item sits inside a grid or stack parent.
  const child = ['columnSpan', 'rowSpan', 'alignSelf', 'flexGrow', 'flexShrink', 'order'];
  const placed = ['position', 'inset', 'zIndex'];
  const motion = ['translateX', 'translateY', 'scale', 'rotate', 'transformOrigin', 'transition', 'transitionDuration', 'transitionEasing'];
  const end = [...motion, 'hidden', 'customCss'];
  switch (node.kind) {
    case 'text':
      return ['textStyle', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'textTransform', 'lineHeight', 'letterSpacing', 'textAlign', 'maxWidth', ...spacing, ...appearance, ...child, ...placed, ...end];
    case 'image':
      return ['width', 'maxWidth', 'minWidth', 'height', 'maxHeight', 'aspectRatio', 'objectFit', 'objectPosition', 'radius', 'shadow', ...borders, ...margins, 'opacity', ...child, ...placed, ...end];
    case 'link':
      return ['width', 'minWidth', ...margins, 'color', 'background', 'radius', 'backdropBlur', ...child, ...placed, ...end];
    case 'icon':
      return ['color', 'fontSize', 'background', 'radius', ...margins, ...child, ...placed, ...end];
    case 'element':
      return ['layout', 'columns', 'gridTemplate', 'containerType', 'align', 'justify', 'wrap', 'gap', 'rowGap', 'columnGap', ...child, ...spacing, 'width', 'minWidth', 'maxWidth', 'height', 'minHeight', 'maxHeight', 'marginInline', 'overflow', 'textAlign', ...boxAppearance, ...placed, ...end];
    default:
      return undefined;
  }
}

/**
 * The style controls a component part offers: the part's own list, plus Image focus on an image it lets authors
 * crop to an aspect ratio, and Background image on a box whose background it lets authors change. Derived rather
 * than stored, so components already in a project offer them too.
 */
export function partStyleControls(def: Pick<ComponentDefinition, 'parts' | 'tree'>, partId: string): string[] | undefined {
  const part = Object.hasOwn(def.parts, partId) ? def.parts[partId] : undefined;
  const list = part?.styleControls;
  if (!part || !list?.length) return list;
  const node = def.tree && Object.hasOwn(def.tree.nodes, part.nodeId) ? def.tree.nodes[part.nodeId] : undefined;
  const after = (list: string[], prop: string, add: string) => {
    const at = list.indexOf(prop);
    return at < 0 || list.includes(add) ? list : [...list.slice(0, at + 1), add, ...list.slice(at + 1)];
  };
  if (node?.kind === 'image') return after(list, 'aspectRatio', 'objectPosition');
  if (node?.kind === 'element') return after(list, 'background', 'backgroundImage');
  return list;
}

/** What a code component's part offers when it names no controls of its own. */
const CODE_PART_CONTROLS = ['paddingBlock', 'background', 'color', 'border', 'radius', 'shadow', 'opacity', 'backdropBlur', 'hidden'];

/**
 * The style controls the inspector offers on one part of a placement: undefined offers every property, null means
 * the part takes no style changes there. A managed section's root always offers Hidden, so a section can be hidden
 * at some sizes whatever else its design lets change; so does each part of a code component that places the
 * override classes it is given (`codeStyled`). A managed section's other parts offer their own list.
 */
export function placementStyleControls(def: Pick<ComponentDefinition, 'kind' | 'parts' | 'tree'>, partId: string, codeStyled: boolean): string[] | undefined | null {
  if (partId !== 'root' && !Object.hasOwn(def.parts, partId)) return null;
  if (def.kind === 'code' && !codeStyled) return null;
  const list = partStyleControls(def, partId);
  if (def.kind === 'managed' && partId !== 'root') return list;
  return list ? [...new Set([...list, 'hidden'])] : def.kind === 'code' ? CODE_PART_CONTROLS : undefined;
}

/** The controls that arrange content in columns, in the order Column layout shows them. */
const COLUMN_CONTROLS = ['layout', 'columns', 'gridTemplate', 'gap', 'rowGap', 'columnGap', 'align', 'justify'];

/**
 * A Section's Container, with the column controls it offers, so a placement's inspector can arrange the Section's
 * columns directly rather than through Parts. A Section is the theme's `layout.section`, or a copy made from one
 * (Make unique keeps the pack's component ID in its provenance), whose Container still holds its Content slot and lets
 * its layout change. Read from the installed definition, so a Section installed before Column sizes and the separate
 * gaps were offered offers what it has. Null for anything else: a slot another design holds is not its columns.
 */
export function columnLayoutPart(def: Pick<ComponentDefinition, 'kind' | 'componentId' | 'provenance' | 'parts' | 'tree'>): { partId: string; controls: string[] } | null {
  const tree = def.kind === 'managed' ? def.tree : undefined;
  if (!tree || (def.componentId !== 'layout.section' && def.provenance?.componentId !== 'layout.section')) return null;
  const part = Object.hasOwn(def.parts, 'container') ? def.parts.container : undefined;
  const nodeOf = (id: string) => (Object.hasOwn(tree.nodes, id) ? tree.nodes[id] : undefined);
  const content = (id: string) => {
    const n = nodeOf(id);
    return n?.kind === 'slot' && n.slot === 'content';
  };
  const node = part ? nodeOf(part.nodeId) : undefined;
  if (node?.kind !== 'element' || !node.children.some(content)) return null;
  const offered = offeredStyleProps(partStyleControls(def, 'container'));
  const controls = COLUMN_CONTROLS.filter((c) => offered.includes(c));
  return controls.includes('layout') ? { partId: 'container', controls } : null;
}

/** The property IDs a control list offers: an empty or missing list offers every one. */
export function offeredStyleProps(list: string[] | undefined): string[] {
  return list?.length ? list : STYLE_PROPS.map((p) => p.id);
}

export const STYLE_GROUP_LABELS: Record<StylePropDef['group'], string> = {
  layout: 'Layout',
  spacing: 'Spacing',
  size: 'Size',
  typography: 'Typography',
  appearance: 'Appearance',
  position: 'Position',
  motion: 'Transform and motion',
  visibility: 'Visibility',
  custom: 'Custom CSS'
};

const TEXT_METRIC_KEYS = ['family', 'size', 'lineHeight', 'weight', 'tracking'];

/**
 * The site style a stored value refers to as a whole, as tokens.css writes it: `{ token }`, or null for a value
 * of its own. For a text style (`group` 'text'), metrics with a stray `token` beside them (left by an older
 * version) are its own value, not a link. Edits only ever store exactly `{ token }`; this also reads what
 * older documents hold.
 */
export function linkOf(v: unknown, group?: TokenGroup): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (group === 'text' && TEXT_METRIC_KEYS.some((k) => k in v)) return null;
  const token = (v as { token?: unknown }).token;
  return typeof token === 'string' ? token : null;
}

export function tokenVar(tokenId: string): string {
  return `--so-${tokenId.replace(/[^a-zA-Z0-9]+/g, '-')}`;
}

/** Whether a link paints its token at part strength: an alpha below 1. */
export const partStrength = (ref: StyleTokenRef): boolean => typeof ref.alpha === 'number' && ref.alpha < 1;

/**
 * A colour at part strength, as CSS: mixed with transparent, so 0.7 paints it at 70% (a colour already see-through
 * is made more so: half-transparent at 0.7 paints at 35%).
 */
export function colorAtStrength(color: string, alpha: number): string {
  return `color-mix(in srgb, ${color} ${Math.round(Math.min(1, Math.max(0, alpha)) * 10000) / 100}%, transparent)`;
}

/** A style's token link as CSS: the token's variable, mixed to its strength when below full. */
export function tokenRefCss(ref: StyleTokenRef): string {
  const css = `var(${tokenVar(ref.token)})`;
  return partStrength(ref) ? colorAtStrength(css, ref.alpha!) : css;
}

/**
 * A token link as stored: exactly `{ token }`, or `{ token, alpha }` when below full strength, token first, so equal
 * links compare equal. Anything else is returned as it is.
 */
export function canonicalStyleValue(v: StyleValue): StyleValue {
  if (isBackgroundImageValue(v)) return backgroundImageError(v, isScrim) ? v : canonicalBackgroundImage(v);
  if (typeof v !== 'object' || v === null || typeof v.token !== 'string') return v;
  // A malformed link (another key, a strength out of range) is left as it is, so it never compares equal to a good one.
  if (Object.keys(v).some((k) => k !== 'token' && k !== 'alpha') || (v.alpha !== undefined && !(typeof v.alpha === 'number' && v.alpha >= 0 && v.alpha <= 1))) return v;
  return partStrength(v) ? { token: v.token, alpha: v.alpha } : { token: v.token };
}

/** A length literal: a number with a unit, or a unitless zero (CSS drops any other unitless number). */
const LENGTH_RE = /^(-?\d*\.?\d+(px|rem|em|%|vw|vh|svh|dvh|ch|ex)|-?0*\.?0+)$/;
/** Lengths CSS lets the browser work out (`auto`): sizes, margins and offsets, not padding, gaps or corners. */
const AUTO_LENGTHS = new Set(['width', 'height', 'minWidth', 'minHeight', 'marginBlockStart', 'marginBlockEnd', 'marginInlineStart', 'marginInlineEnd', 'inset']);
/** Lengths CSS gives no negative value: a negative padding, gap, size, corner radius or font size is dropped. */
const NON_NEGATIVE_LENGTHS = new Set([
  'paddingBlock', 'paddingInline', 'paddingBlockStart', 'paddingBlockEnd', 'paddingInlineStart', 'paddingInlineEnd',
  'gap', 'rowGap', 'columnGap', 'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'radius', 'fontSize', 'lineHeight'
]);
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

const LENGTH_UNITS = 'px|rem|em|%|vw|vh|vi|vb|vmin|vmax|svw|svh|svi|svb|svmin|svmax|lvw|lvh|lvi|lvb|lvmin|lvmax|dvw|dvh|dvi|dvb|dvmin|dvmax|ch|ex|cap|ic|lh|rlh|cqw|cqh|cqi|cqb|cqmin|cqmax|cm|mm|q|in|pt|pc';
const CSS_NUMBER = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const TOKEN_LENGTH_RE = new RegExp(`^([+-]?)${CSS_NUMBER}(?:${LENGTH_UNITS})$`, 'i');
const TOKEN_ZERO_RE = /^[+-]?(?:0+(?:\.0+)?|\.0+)$/;
/**
 * One piece of a math function: CSS whitespace, a function opening, a number or length, or punctuation. Lower
 * case, as the theme writes them. No variables: a style that should follow another links to it instead.
 */
const MATH_TOKEN_RE = new RegExp(`[ \\t\\n]+|(?:calc|min|max|clamp)\\(|[+-]?${CSS_NUMBER}(?:${LENGTH_UNITS})?|[()+\\-*/,]`, 'y');
/** How many arguments each math function takes, at least and at most. */
const MATH_ARITY: Record<string, [number, number]> = { calc: [1, 1], clamp: [3, 3], min: [1, Infinity], max: [1, Infinity] };

type MathType = 'number' | 'length';

/**
 * One calc(), min(), max() or clamp() call that works out to a length: numbers, lengths, nested calls and
 * brackets joined by operators, each function given its number of arguments. As in CSS, * and / bind before
 * + and -, + and - join two of a kind and need a space on each side, * needs a number on one side, / a number
 * on the right, and a function's arguments are all of one kind.
 */
function isMathLength(value: string): boolean {
  const toks: Array<{ t: string; spaced: boolean }> = [];
  let spaced = false;
  for (let at = 0; at < value.length; ) {
    MATH_TOKEN_RE.lastIndex = at;
    const m = MATH_TOKEN_RE.exec(value);
    if (!m) return false;
    at = MATH_TOKEN_RE.lastIndex;
    if (/^[ \t\n]+$/.test(m[0])) spaced = true;
    else (toks.push({ t: m[0], spaced }), (spaced = false));
  }
  let i = 0;
  const call = (): MathType | null => {
    const fn = toks[i]?.t.match(/^(calc|min|max|clamp)\($/)?.[1];
    if (!fn) return null;
    i++;
    const kinds: MathType[] = [];
    for (;;) {
      const k = expr();
      if (!k) return null;
      kinds.push(k);
      if (toks[i]?.t !== ',') break;
      i++;
    }
    if (toks[i]?.t !== ')') return null;
    i++;
    if (kinds.length < MATH_ARITY[fn][0] || kinds.length > MATH_ARITY[fn][1] || kinds.some((k) => k !== kinds[0])) return null;
    return kinds[0];
  };
  const operand = (): MathType | null => {
    const t = toks[i]?.t;
    if (t === undefined) return null;
    if (t.endsWith('(') && t !== '(') return call();
    if (t === '(') {
      i++;
      const k = expr();
      if (!k || toks[i]?.t !== ')') return null;
      i++;
      return k;
    }
    if (/^[+-]?[\d.]/.test(t)) return (i++, /[a-z%]$/.test(t) ? 'length' : 'number');
    return null;
  };
  const term = (): MathType | null => {
    let left = operand();
    while (left && (toks[i]?.t === '*' || toks[i]?.t === '/')) {
      const op = toks[i++].t;
      const right = operand();
      if (!right) return null;
      left = op === '*' ? (left === 'number' ? right : right === 'number' ? left : null) : right === 'number' ? left : null;
    }
    return left;
  };
  const expr = (): MathType | null => {
    let left = term();
    while (left && (toks[i]?.t === '+' || toks[i]?.t === '-')) {
      // CSS reads a + or - without a space on both sides as a sign.
      if (!toks[i].spaced || !toks[i + 1]?.spaced) return null;
      i++;
      const right = term();
      if (!right || right !== left) return null;
    }
    return left;
  };
  return call() === 'length' && i === toks.length;
}

/**
 * A length a spacing, page-width or corner site style can hold: a number with a unit, 0, or one calc(), min(),
 * max() or clamp() of lengths. A bare number other than 0, a keyword such as `auto` and a list of lengths are
 * not one length. Widths and corners cannot be negative; spacing can, for pulling things closer.
 */
export function isTokenLength(value: string, { negative = true }: { negative?: boolean } = {}): boolean {
  const s = value.trim();
  if (TOKEN_ZERO_RE.test(s)) return true;
  const m = TOKEN_LENGTH_RE.exec(s);
  if (m) return negative || m[1] !== '-';
  return /^(calc|min|max|clamp)\(/i.test(s) && balanced(s) && isMathLength(s);
}

// ---------------------------------------------------------------------------
// Column sizes: grid track lists
// ---------------------------------------------------------------------------

const FR_RE = new RegExp(`^${CSS_NUMBER}fr$`, 'i');
const TRACK_KEYWORDS = new Set(['auto', 'min-content', 'max-content']);
const MAX_TRACKS_TEXT = 300;
/** How deep brackets nest in a column-size value: browsers drop a declaration whose math nests too deep. */
const MAX_TRACKS_DEPTH = 8;
/** The column-size presets that are not a track list of their own. */
const AUTO_FIT_PRESETS: Record<string, string> = {
  'auto-fit-sm': 'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))',
  'auto-fit-md': 'repeat(auto-fit, minmax(min(100%, 20rem), 1fr))'
};
const isSpace = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n';

/** The arguments of one whole `name(...)` call, split at its top-level commas; null when the value is not one. */
function callArgs(value: string, name: string): string[] | null {
  if (value.slice(0, name.length + 1).toLowerCase() !== `${name}(` || !wholeCall(value)) return null;
  const args: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value.slice(name.length + 1, -1)) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && ch === ',') (args.push(cur.trim()), (cur = ''));
    else cur += ch;
  }
  args.push(cur.trim());
  return args.every(Boolean) ? args : null;
}

type Breadth = { css: string; kind: 'fr' | 'length' | 'keyword'; fr?: number };

/** One size a track can take: a positive fr share, a length that is not negative, or auto / min-content / max-content. */
function trackBreadth(raw: string): Breadth | null {
  const t = raw.trim();
  if (FR_RE.test(t)) {
    const fr = parseFloat(t);
    return fr > 0 ? { css: t.toLowerCase(), kind: 'fr', fr } : null;
  }
  if (TRACK_KEYWORDS.has(t.toLowerCase())) return { css: t.toLowerCase(), kind: 'keyword' };
  if (!isTokenLength(t, { negative: false })) return null;
  // Math can work out below zero, which CSS clamps but a minifier may fold into a negative size the browser drops.
  return { css: /^[a-z]+\(/i.test(t) ? `max(0px, ${t})` : t, kind: 'length' };
}

/**
 * One column: a size, or minmax(least, most) whose least is not an fr share. A bare fr share is written as
 * minmax(0, share) so the column can shrink below its content, as Columns does. `fr` is its share when the column
 * is only that, for sizing images.
 */
function gridTrack(raw: string): { css: string; fr: number | null } | null {
  const size = trackBreadth(raw);
  if (size) return size.kind === 'fr' ? { css: `minmax(0, ${size.css})`, fr: size.fr! } : { css: size.css, fr: null };
  const args = callArgs(raw.trim(), 'minmax');
  if (args?.length !== 2) return null;
  const [least, most] = args.map(trackBreadth);
  if (!least || !most || least.kind === 'fr') return null;
  return { css: `minmax(${least.css}, ${most.css})`, fr: most.kind === 'fr' && TOKEN_ZERO_RE.test(least.css) ? most.fr! : null };
}

/** A column-size value as the stylesheet writes it, with each column's fr share (null for any other size). */
type GridTemplate = { css: string; fr: Array<number | null> };

/**
 * Parse a column-size value: a preset, a list of up to MAX_GRID_TRACKS columns (each a size or minmax(), with
 * repeat(count, columns) counted as every column it makes), or, for as many columns as fit,
 * repeat(auto-fit | auto-fill, minimum) with minimum a plain length above zero or minmax(that length, size). That
 * length is capped at the grid's own width, so a card never overflows a narrow screen. A message for anything else.
 */
export function parseGridTemplate(raw: string): GridTemplate | string {
  const value = raw.trim();
  const preset = Object.hasOwn(AUTO_FIT_PRESETS, value) ? AUTO_FIT_PRESETS[value] : undefined;
  if (preset) return { css: preset, fr: [] };
  const bad = `"${value.slice(0, 60)}" is not a list of column sizes. Use up to ${MAX_GRID_TRACKS} of: 1fr, a length such as 16rem, auto, minmax(12rem, 1fr) or repeat(3, 1fr); or repeat(auto-fit, minmax(18rem, 1fr)) for as many as fit.`;
  if (!value || value.length > MAX_TRACKS_TEXT || !isSafeCssValue(value)) return bad;
  let depth = 0;
  for (const ch of value) if ((depth += ch === '(' ? 1 : ch === ')' ? -1 : 0) > MAX_TRACKS_DEPTH) return bad;
  const auto = callArgs(value, 'repeat');
  if (auto && /^auto-(fit|fill)$/i.test(auto[0])) {
    if (auto.length !== 2) return bad;
    const fill = auto[0].toLowerCase();
    // A plain length above zero: a zero minimum (or math that works out to one) makes zero-width columns.
    const least = (len: string) => {
      const m = TOKEN_LENGTH_RE.exec(len.trim());
      return m && m[1] !== '-' && parseFloat(len.trim().slice(m[1].length)) > 0 ? `min(100%, ${len.trim()})` : null;
    };
    const single = least(auto[1]);
    if (single) return { css: `repeat(${fill}, ${single})`, fr: [] };
    const args = callArgs(auto[1], 'minmax');
    const min = args?.length === 2 ? least(args[0]) : null;
    const most = args?.length === 2 ? trackBreadth(args[1]) : null;
    return min && most ? { css: `repeat(${fill}, minmax(${min}, ${most.css}))`, fr: [] } : `${bad} As many as fit takes one minimum column width greater than 0.`;
  }
  const css: string[] = [];
  const fr: Array<number | null> = [];
  for (const part of splitTop(value, isSpace)) {
    const rep = callArgs(part, 'repeat');
    if (rep) {
      const count = Number(rep[0]);
      const inner = rep.length === 2 && /^\d+$/.test(rep[0]) && count >= 1 ? splitTop(rep[1], isSpace).map(gridTrack) : [];
      if (!inner.length || inner.some((t) => !t) || count * inner.length > MAX_GRID_TRACKS) return bad;
      css.push(`repeat(${count}, ${inner.map((t) => t!.css).join(' ')})`);
      for (let i = 0; i < count; i++) fr.push(...inner.map((t) => t!.fr));
    } else {
      const track = gridTrack(part);
      if (!track) return bad;
      css.push(track.css);
      fr.push(track.fr);
    }
    if (fr.length > MAX_GRID_TRACKS) return `"${value.slice(0, 60)}" makes more than ${MAX_GRID_TRACKS} columns.`;
  }
  return css.length ? { css: css.join(' '), fr } : bad;
}

/**
 * Each column's fr share when a column-size value is only fr shares, for sizing images; null for anything else (as
 * many as fit, a fixed or content-sized column, a value the stylesheet does not write), where an item's column can
 * take up to the grid's whole width.
 */
export function gridTemplateShares(value: unknown): number[] | null {
  const parsed = typeof value === 'string' ? parseGridTemplate(value) : null;
  if (!parsed || typeof parsed === 'string' || !parsed.fr.length || parsed.fr.some((f) => f === null)) return null;
  return parsed.fr as number[];
}

/**
 * A style's value with its links to other styles followed to the end, for showing it or copying it out.
 * Undefined when a link names a style that does not exist, or the links loop.
 */
export function followToken(tokens: TokenDef[], id: string): TokenValue | undefined {
  const byId = new Map(tokens.map((t) => [t.id, t]));
  const seen = new Set<string>();
  for (let cur: string | null = id; cur && !seen.has(cur); ) {
    seen.add(cur);
    const v = byId.get(cur)?.value;
    const next = linkOf(v, byId.get(cur)?.group);
    if (!next) return v;
    cur = next;
  }
  return undefined;
}

/** A style's value as CSS text, a style it follows already followed; empty when it cannot be followed or is not text. */
export function followedText(tokens: TokenDef[], id: string): string {
  const v = followToken(tokens, id);
  return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

/**
 * Whether a text style linked to another can be written out metric by metric: each style along the links is
 * a text style, and the last holds metrics of its own (written out as they are, whatever they hold).
 */
export function textLinkLeadsToText(tokens: TokenDef[], id: string): boolean {
  const byId = new Map(tokens.map((t) => [t.id, t]));
  const seen = new Set([id]);
  for (let cur = linkOf(byId.get(id)?.value, 'text'); cur; ) {
    const t = byId.get(cur);
    if (!t || t.group !== 'text' || seen.has(cur)) return false;
    seen.add(cur);
    const next = linkOf(t.value, 'text');
    if (!next) return !!t.value && typeof t.value === 'object';
    cur = next;
  }
  return false;
}

/** A metric written as a number in a hand-edited document reads as the same CSS text. */
const metricText = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);

/**
 * The metrics a text style is written out with, as tokens.css writes them: its own; those of the text style it
 * links to (by hand, or from an older version) when every style along the links is a text style; otherwise the
 * `fallback` (the theme's own value for that style), or null. The editor, an edit and the export all read this.
 */
export function textStyleValue(tokens: TokenDef[], id: string, fallback?: unknown): Record<string, unknown> | null {
  const v = tokens.find((t) => t.id === id)?.value;
  const isMetrics = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x) && !linkOf(x, 'text');
  if (!linkOf(v, 'text')) return isMetrics(v) ? v : null;
  if (textLinkLeadsToText(tokens, id)) return followToken(tokens, id) as unknown as Record<string, unknown>;
  return isMetrics(fallback) ? fallback : null;
}

/** Font weights written as words in a hand-edited document, as the numbers they stand for. */
const WEIGHT_WORDS: Record<string, number> = { normal: 400, bold: 700 };

/** A text style's weight as a number: a number, a numeric string, or normal / bold; NaN for anything else. */
export function textWeight(w: unknown): number {
  return typeof w === 'number' ? w : typeof w === 'string' && w.trim() ? (WEIGHT_WORDS[w.trim().toLowerCase()] ?? Number(w)) : NaN;
}

/**
 * A text style's metrics as the editor shows them (see textStyleValue). Null when they cannot be read: a size,
 * line height, letter spacing, weight or font that is missing.
 */
export function textMetrics(tokens: TokenDef[], id: string, fallback?: unknown): TextStyleValue | null {
  const v = textStyleValue(tokens, id, fallback);
  if (!v) return null;
  const size = metricText(v.size);
  const lineHeight = metricText(v.lineHeight);
  const tracking = metricText(v.tracking);
  const w = v.weight;
  const weight = textWeight(w);
  const family = v.family;
  const familyOk = (typeof family === 'string' && family.trim()) || linkOf(family);
  if (size === null || lineHeight === null || tracking === null || !(weight >= 100 && weight <= 900) || !familyOk) return null;
  const out: TextStyleValue = { family: family as TextStyleValue['family'], size, lineHeight, tracking, weight };
  if (typeof v.transform === 'string') out.transform = v.transform as TextStyleValue['transform'];
  return out;
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

const TRANSLATE_RE = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(px|rem|em|%)?$/;

/** A shift: 0, or one length in px, rem or em or a percentage of the element's own size, within TRANSLATE_LIMITS. */
export function isTranslate(value: string): boolean {
  const m = TRANSLATE_RE.exec(value.trim());
  if (!m) return false;
  const n = Math.abs(Number(m[1]));
  if (!m[2]) return n === 0;
  return n <= TRANSLATE_LIMITS[m[2] as keyof typeof TRANSLATE_LIMITS];
}

const BLUR_RE = /^(\d+(?:\.\d+)?|\.\d+)(px|rem|em)?$/;

/** A backdrop blur: 0, or one length in px, rem or em within BLUR_LIMITS. blur() takes no percentage. */
export function isBackdropBlur(value: string): boolean {
  const m = BLUR_RE.exec(value.trim());
  if (!m) return false;
  const n = Number(m[1]);
  if (!m[2]) return n === 0;
  return n <= BLUR_LIMITS[m[2] as keyof typeof BLUR_LIMITS];
}

/** What each transition preset animates. Each lists properties these style controls can change. */
const TRANSITION_PROPERTIES: Record<string, string> = {
  none: 'none',
  colors: 'color, background-color, border-color, text-decoration-color, fill, stroke',
  shadow: 'box-shadow',
  transform: 'translate, scale, rotate, transform',
  opacity: 'opacity',
  common: 'color, background-color, border-color, text-decoration-color, fill, stroke, box-shadow, opacity, translate, scale, rotate, transform'
};
/** How long a transition preset takes when no rule for the element sets a duration (CSS's own default is 0s). */
const TRANSITION_DEFAULT_DURATION = '200ms';
/**
 * The variables the two shift axes write. A distinct prefix, so no site style's variable (always `--so-`) can be
 * one of them.
 */
const TRANSLATE_VARS = { translateX: '--_so-translate-x', translateY: '--_so-translate-y' } as const;
export const TRANSLATE_DECL = `translate: var(${TRANSLATE_VARS.translateX}, 0px) var(${TRANSLATE_VARS.translateY}, 0px)`;
/** Named easing curves beyond the CSS keywords. */
const EASING_CURVES: Record<string, string> = { smooth: 'cubic-bezier(0.2, 0, 0, 1)', overshoot: 'cubic-bezier(0.34, 1.56, 0.64, 1)' };

/**
 * Why a token link cannot be written for a property as it is shaped: a key other than `token` and `alpha`, a
 * strength on anything but a colour, or a strength outside 0 to 1. Null for a link that fits (which token it names
 * is checked elsewhere).
 */
export function linkShapeError(propId: string, value: StyleTokenRef): string | null {
  const def = Object.hasOwn(STYLE_PROP_MAP, propId) ? STYLE_PROP_MAP[propId] : undefined;
  if (!def) return `Unknown style property "${propId}".`;
  const extra = Object.keys(value).find((k) => k !== 'token' && k !== 'alpha');
  if (extra !== undefined) return `A token reference holds "token"${def.kind === 'color' ? ' and "alpha"' : ''} only, not "${extra.slice(0, 40)}".`;
  if (value.alpha === undefined) return null;
  if (def.kind !== 'color') return `${def.label} takes its token at full strength: only a color can be see-through.`;
  if (typeof value.alpha !== 'number' || !Number.isFinite(value.alpha) || value.alpha < 0 || value.alpha > 1)
    return `${def.label} strength ("alpha") must be a number from 0 to 1, such as 0.7 for 70%.`;
  return null;
}

/**
 * A background image's scrim: a colour, or one gradient (a background colour already shows beneath the picture, and
 * several layers would paint over each other).
 */
export function isScrim(raw: string): boolean {
  const s = raw.trim();
  if (s.length > 400 || !isSafeCssValue(s)) return false;
  const m = /^(linear|radial)-gradient\((.*)\)$/is.exec(s);
  if (!m) return isScrimColor(s);
  // An empty argument (two commas together, or one at either end) is no gradient a browser draws.
  if (/(^|,)\s*(,|$)/.test(m[2])) return false;
  const parts = splitTop(m[2], (ch) => ch === ',');
  // A direction or shape first, when there is one; then two colour stops or more, each at up to two places.
  const words = (p: string) => splitTop(p, (ch) => /\s/.test(ch));
  const lead = parts.length && !isScrimColor(words(parts[0])[0] ?? '') ? parts.shift()! : null;
  if (lead !== null && !(m[1].toLowerCase() === 'linear' ? SCRIM_DIRECTION_RE.test(words(lead).join(' ')) : SCRIM_SHAPE_RE.test(words(lead).join(' ')) && scrimPosition(words(lead).join(' ')))) return false;
  return parts.length >= 2 && parts.every((p) => {
    const [color, ...at] = words(p);
    return isScrimColor(color) && at.length <= 2 && at.every((x) => SCRIM_STOP_RE.test(x));
  });
}

/**
 * A scrim's colours, fully spelled out: hex of 3, 4, 6 or 8 digits, rgb() or hsl() of plain numbers, or a few
 * keywords. No variable, which could name nothing (or the picture itself) and make the browser drop the picture, and
 * nothing a colour function would only read at run time.
 */
/** A plain number, a percentage, or an angle in degrees, as one colour channel. */
const SCRIM_NUMBER = '-?(?:\\d{1,4}(?:\\.\\d{1,6})?|\\.\\d{1,6})';
const SCRIM_CHANNEL = { number: new RegExp(`^${SCRIM_NUMBER}%?$`), percent: new RegExp(`^${SCRIM_NUMBER}%$`), hue: new RegExp(`^${SCRIM_NUMBER}(?:deg)?$`) };
function isScrimColor(raw: string): boolean {
  const c = raw.trim();
  if (/^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|transparent|black|white)$/i.test(c)) return true;
  const m = /^(rgba?|hsla?)\(([^()]*)\)$/i.exec(c);
  if (!m) return false;
  // Each channel by its place: red, green and blue are numbers or percentages; a hue a number or degrees, then
  // saturation and lightness percentages; the alpha a number or a percentage.
  const hsl = m[1].toLowerCase().startsWith('hsl');
  // Written with spaces, saturation and lightness may also be plain numbers.
  const kinds = (spaced: boolean) => (hsl ? [SCRIM_CHANNEL.hue, spaced ? SCRIM_CHANNEL.number : SCRIM_CHANNEL.percent, spaced ? SCRIM_CHANNEL.number : SCRIM_CHANNEL.percent] : [SCRIM_CHANNEL.number, SCRIM_CHANNEL.number, SCRIM_CHANNEL.number]);
  const fits = (channels: string[], alpha: string | undefined, spaced: boolean) => channels.length === 3 && channels.every((x, i) => kinds(spaced)[i].test(x)) && (alpha === undefined || SCRIM_CHANNEL.number.test(alpha));
  // Commas between every channel, or spaces with the alpha after a slash: never the two mixed.
  if (m[2].includes(',')) {
    const parts = m[2].split(',').map((x) => x.trim());
    return !m[2].includes('/') && (parts.length === 3 || parts.length === 4) && fits(parts.slice(0, 3), parts[3], false);
  }
  const [rgb, alpha, ...more] = m[2].split('/');
  return !more.length && fits(rgb.trim().split(/\s+/), alpha?.trim(), true);
}
const SCRIM_DIRECTION_RE = /^(to (top|bottom)( (left|right))?|to (left|right)( (top|bottom))?|-?(\d+(\.\d+)?|\.\d+)(deg|turn|rad|grad))$/i;
/** A radial gradient's shape and extent, each at most once and in either order, then where it is centred. */
const SCRIM_SHAPE_RE = /^(((circle|ellipse)( (closest-side|closest-corner|farthest-side|farthest-corner))?|(closest-side|closest-corner|farthest-side|farthest-corner)( (circle|ellipse))?)( at( [^ ]+){1,2})?|at( [^ ]+){1,2})$/i;
/** Where a radial gradient is centred: one keyword or percentage, across then down, or a down keyword then an across one. */
function scrimPosition(lead: string): boolean {
  const at = lead.toLowerCase().split(' at ').length > 1 ? lead.toLowerCase().split(' at ')[1] : lead.toLowerCase().startsWith('at ') ? lead.slice(3).toLowerCase() : null;
  if (at === null) return true;
  const pct = (x: string) => /^-?\d+(\.\d+)?%$/.test(x);
  const [a, b, ...more] = at.trim().split(' ');
  if (more.length) return false;
  if (b === undefined) return pct(a) || ['center', 'top', 'bottom', 'left', 'right'].includes(a);
  return ((pct(a) || ['left', 'center', 'right'].includes(a)) && (pct(b) || ['top', 'center', 'bottom'].includes(b))) || (['top', 'center', 'bottom'].includes(a) && ['left', 'center', 'right'].includes(b));
}
const SCRIM_STOP_RE = /^(0|-?(\d+(\.\d+)?|\.\d+)(%|px))$/;

/**
 * The image layers a `background` value paints (a gradient, or several), without the colour a value may end with:
 * what the picture's longhands fall back on where there is no picture. 'none' for anything else or anything unsafe.
 */
export function backgroundImageLayers(v: StyleValue): string {
  if (typeof v !== 'string' || !isSafeCssValue(v.trim()) || !isValidGradient(v)) return 'none';
  const layers = splitTop(v.trim(), (ch) => ch === ',');
  return (COLOR_RE.test(layers[layers.length - 1]) ? layers.slice(0, -1) : layers).join(', ') || 'none';
}

/** Validate a literal style value. Returns an error message or null. */
export function validateStyleValue(propId: string, value: StyleValue): string | null {
  const def = Object.hasOwn(STYLE_PROP_MAP, propId) ? STYLE_PROP_MAP[propId] : undefined;
  if (!def) return `Unknown style property "${propId}".`;
  // A picture is named by its library asset, never by a token or an address.
  if (def.kind === 'media') return backgroundImageError(value, isScrim);
  if (typeof value === 'object' && value !== null) {
    if (typeof value.token !== 'string') return 'Token reference must have a token ID.';
    if (!def.tokenGroup) return `${def.label} cannot use a token.`;
    const groups = Array.isArray(def.tokenGroup) ? def.tokenGroup : [def.tokenGroup];
    if (!groups.some((g) => value.token.startsWith(g + '.'))) return `${def.label} needs a ${groups.join(' or ')} token, not "${value.token}".`;
    return linkShapeError(propId, value);
  }
  const s = String(value).trim();
  if (def.kind === 'css') return typeof value === 'string' ? parseCustomCss(s).error : `${def.label} must be text.`;
  if (!isSafeCssValue(s)) return `Invalid characters in ${def.label}.`;
  switch (def.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : `${def.label} must be true or false.`;
    case 'number': {
      const n = Number(value);
      // Transforms and timings take a number, or plain decimals as text: Number() also reads null as 0 and "0x10" or
      // "1e3" as numbers, which no one writes as a style. Older properties keep reading what documents already hold.
      const plain = def.group !== 'motion' || typeof value === 'number' || (typeof value === 'string' && /^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(s));
      if (typeof value === 'boolean' || s === '' || !Number.isFinite(n) || !plain) return `${def.label} must be a number.`;
      if (def.min !== undefined && n < def.min) return `${def.label} must be at least ${def.min}.`;
      if (def.max !== undefined && n > def.max) return `${def.label} must be at most ${def.max}.`;
      if (def.integer && !Number.isInteger(n)) return `${def.label} must be a whole number.`;
      return null;
    }
    case 'enum':
      return def.options!.some((o) => o.value === s) ? null : `${def.label} must be one of: ${def.options!.map((o) => o.value).join(', ')}.`;
    case 'ratio':
      return /^(auto|\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?)$/.test(s) ? null : `${def.label} must look like 16/9.`;
    case 'focus':
      return typeof value === 'string' && isFocusValue(s) ? null : `${def.label} must be one of ${def.options!.map((o) => o.value).join(', ')}, or two percentages across and down such as "50% 20%".`;
    case 'color':
      if (propId === 'background' && isGradient(s)) return isValidGradient(s) ? null : `"${s.slice(0, 60)}" is not a supported gradient. Use colors, angles and percentages inside linear-gradient(), radial-gradient() or conic-gradient().`;
      return COLOR_RE.test(s) ? null : `"${s}" is not a supported color. Use a hex value, rgb(), hsl() or oklch().`;
    case 'length':
      if (def.options?.some((o) => o.value === s)) return null;
      if (propId === 'lineHeight' && /^\d*\.?\d+$/.test(s)) return null;
      if (propId === 'translateX' || propId === 'translateY')
        return isTranslate(s) ? null : `"${s.slice(0, 40)}" is not a valid shift. Use 0 or one length such as -4px, 0.5rem or 10%, at most ${TRANSLATE_LIMITS.px}px, ${TRANSLATE_LIMITS.rem}rem or ${TRANSLATE_LIMITS['%']}% either way.`;
      if (propId === 'backdropBlur')
        return isBackdropBlur(s) ? null : `"${s.slice(0, 40)}" is not a valid blur. Use 0 or one length such as 12px or 0.75rem, at most ${BLUR_LIMITS.px}px or ${BLUR_LIMITS.rem}rem.`;
      if (propId === 'inset') {
        // One to four offsets; spaces inside calc() and friends do not separate values.
        const parts = splitTop(s, (ch) => /\s/.test(ch));
        return parts.length <= 4 && parts.every((x) => x === 'auto' || LENGTH_RE.test(x) || FN_RE.test(x)) ? null : `"${s}" is not a valid offset. Use one to four lengths such as 0 or 12px 24px.`;
      }
      if (FN_RE.test(s)) return null;
      if (s === 'auto') return AUTO_LENGTHS.has(propId) ? null : `${def.label} cannot be auto. Use a length such as 24px.`;
      const length = LENGTH_RE.test(s);
      const number = /^-?\d*\.?\d+$/.test(s);
      if (!length && !number) return `"${s}" is not a valid length. Use values such as 24px, 1.5rem or 50%.`;
      if (NON_NEGATIVE_LENGTHS.has(propId) && s.startsWith('-') && /[1-9]/.test(s)) return `${def.label} cannot be negative.`;
      return length ? null : `"${s}" needs a unit, such as ${s}px or ${s}rem.`;
    case 'tracks': {
      if (typeof value !== 'string') return `${def.label} must be text, such as "1fr 2fr".`;
      const parsed = parseGridTemplate(s);
      return typeof parsed === 'string' ? parsed : null;
    }
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
  if (typeof v === 'object' && v !== null) return typeof v.token === 'string' ? tokenRefCss(v as StyleTokenRef) : '';
  return String(v);
}

/** Fixed-grammar properties: a hand-edited document that breaks the grammar writes nothing. */
const CHECKED_AT_OUTPUT = new Set([
  'containerType', 'gridTemplate', 'columnSpan', 'rowSpan', 'alignSelf', 'flexGrow', 'flexShrink', 'objectPosition', 'overflow', 'position', 'inset', 'zIndex', 'fontStyle', 'textTransform',
  'translateX', 'translateY', 'scale', 'rotate', 'transformOrigin', 'transition', 'transitionDuration', 'transitionEasing', 'backdropBlur'
]);

/**
 * Convert one style property into CSS declarations. A background image writes nothing here: only the generator
 * writes one, from the library's record of the picture (generator/background.ts).
 */
export function styleToCss(propId: string, raw: StyleValue): string[] {
  if (typeof raw === 'object' && raw !== null && typeof raw.token !== 'string') return [];
  // A link holding more than its token (a strength) is read again: a hand-edited one on a property that cannot
  // take it, or with a strength out of range, writes nothing. Which token it names is not: a theme's may have any ID.
  if (typeof raw === 'object' && raw !== null && Object.keys(raw).length > 1 && linkShapeError(propId, raw)) return [];
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
    case 'containerType':
      return [`container-type: ${v}`];
    case 'align':
      return [`align-items: ${v}`];
    case 'justify':
      return [`justify-content: ${v}`];
    case 'order':
      return [`order: ${Number(value)}`];
    case 'wrap':
      return [`flex-wrap: ${value ? 'wrap' : 'nowrap'}`];
    case 'gridTemplate': {
      const parsed = parseGridTemplate(v);
      return typeof parsed === 'string' ? [] : [`grid-template-columns: ${parsed.css}`];
    }
    case 'columnSpan':
      return [value === 'full' ? 'grid-column: 1 / -1' : `grid-column: span ${Number(value)} / span ${Number(value)}`];
    case 'rowSpan':
      return [`grid-row: span ${Number(value)} / span ${Number(value)}`];
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
    case 'backdropBlur': {
      // Safari before 18 reads only the prefixed property. A zero blur is none, which (unlike blur(0)) leaves the
      // element without a stacking context of its own.
      const filter = Number.parseFloat(String(value)) === 0 ? 'none' : `blur(${v})`;
      return [`-webkit-backdrop-filter: ${filter}`, `backdrop-filter: ${filter}`];
    }
    case 'position':
      return [`position: ${v}`];
    case 'inset':
      return [`inset: ${v}`];
    case 'zIndex':
      return [`z-index: ${Number(value)}`];
    case 'translateX':
    case 'translateY':
      // CSS has one translate property, so each axis sets its own variable and both write the pair: an axis set
      // by another rule (another size, a stronger layer) keeps its value.
      return [`${TRANSLATE_VARS[propId]}: ${v}`, TRANSLATE_DECL];
    case 'scale':
      return [`scale: ${Number(value)}`];
    case 'rotate':
      return [`rotate: ${Number(value)}deg`];
    case 'transformOrigin':
      return [`transform-origin: ${v}`];
    case 'transition':
      // Its default duration is in styleFallbackCss, so a duration any rule sets for the element wins.
      return [`transition-property: ${TRANSITION_PROPERTIES[String(value)]}`];
    case 'transitionDuration':
      return [`transition-duration: ${Number(value)}ms`];
    case 'transitionEasing':
      return [`transition-timing-function: ${EASING_CURVES[String(value)] ?? v}`];
    case 'hidden':
      return value ? ['display: none'] : [];
    case 'customCss':
      // Read again here: a hand-edited document never reached validateStyleValue.
      return typeof value === 'string' ? parseCustomCss(value).decls : [];
  }
  return [];
}

/**
 * Declarations one style property needs beneath its own, at zero specificity on the same element (in a `:where()`
 * rule beside the property's rule): starting values any rule that names the element overrides. Each shift axis
 * starts both axes at 0, so the element never takes an axis from its parent (custom properties inherit); a
 * transition preset starts with a working duration. Nothing for a value styleToCss would not write.
 */
export function styleFallbackCss(propId: string, raw: StyleValue): string[] {
  if (!styleToCss(propId, raw).length) return [];
  if (propId === 'translateX' || propId === 'translateY') return [`${TRANSLATE_VARS.translateX}: 0px`, `${TRANSLATE_VARS.translateY}: 0px`];
  if (propId === 'transition' && String(raw).trim() !== 'none') return [`transition-duration: ${TRANSITION_DEFAULT_DURATION}`];
  return [];
}

/** Where the generated CSS turns its own transitions off, whatever the theme does. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Declarations one style property needs for visitors who ask for reduced motion, at zero specificity: a transition
 * set here (a preset, or a duration that animates every property) finishes at once, as the Foundation theme's
 * own rule does for everything, and starts at once despite any delay custom CSS adds. The generator writes them
 * itself, so a theme without that rule still honours it.
 */
export function styleReducedMotionCss(propId: string, raw: StyleValue): string[] {
  if ((propId !== 'transition' && propId !== 'transitionDuration') || !styleToCss(propId, raw).length) return [];
  return propId === 'transition' && String(raw).trim() === 'none' ? [] : ['transition-duration: 0.01ms !important', 'transition-delay: 0s !important'];
}

export const MEDIA_QUERIES: Record<'phone' | 'tablet' | 'desktop', string> = {
  phone: '(max-width: 767.98px)',
  tablet: '(min-width: 768px) and (max-width: 1023.98px)',
  desktop: '(min-width: 1024px)'
};

/**
 * The width ranges container rules apply in, of the nearest query container around the element (see
 * `CONTAINER_SCOPES`). Exclusive, with no gap at fractional widths (a column's width rarely is a whole number, so
 * each upper bound is strict rather than .98px short): a sidebar column of a 1280px desktop page is narrow, its main
 * column wide.
 */
export const CONTAINER_QUERIES: Record<ContainerScope, string> = {
  'cq-narrow': '(width < 480px)',
  'cq-medium': '(min-width: 480px) and (width < 720px)',
  'cq-wide': '(min-width: 720px)'
};
/** The container width ranges as the editor and the assistant name them. */
export const CONTAINER_SCOPE_LABEL: Record<ContainerScope, string> = { 'cq-narrow': 'Narrow container', 'cq-medium': 'Medium container', 'cq-wide': 'Wide container' };
export const CONTAINER_SCOPE_RANGE: Record<ContainerScope, string> = { 'cq-narrow': 'under 480px wide', 'cq-medium': '480px to 720px wide', 'cq-wide': '720px wide and over' };
/** How the container width ranges work, for the assistant's tools and the operation schema. */
export const CONTAINER_SCOPE_HELP =
  'Scope "cq-narrow" (under 480px), "cq-medium" (480px to 720px) or "cq-wide" (720px and over) styles by the width of the nearest query container around it instead of the screen: set containerType "inline-size" (base) on a box its parent sizes, such as a column, and one card inside can stack in a narrow column and sit side by side in a wide one at the same screen size. They beat the screen sizes, apply nowhere without a query container around it, and cannot set hidden.';

/**
 * Why a container width range cannot hold `prop`, or null when it can. Visibility stays with the screen sizes: folding
 * a hide that holds in some containers into the sizes' own shows and hides would show or hide the wrong thing where a
 * screen size and a container range both apply.
 */
export function containerStyleError(prop: string): string | null {
  return prop === 'hidden' ? 'Hidden cannot change with the width of the container around it: show or hide it for screen sizes instead.' : null;
}

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

// ---------------------------------------------------------------------------
// The cascade the generated CSS gives one element
// ---------------------------------------------------------------------------

/**
 * A base-scope value that would break a narrower layout if it also applied on phones, so the generated CSS sets it
 * from tablet up only. A span wider than a phone's single column, or taller than one row, always is; `wideColumns` layers (variants and
 * placement overrides) also keep a multi-column grid off phones, so the component's own phone layout still applies.
 */
export function wideOnlyStyle(prop: string, value: unknown, wideColumns = false): boolean {
  // Only text and numbers read as a count: a hand-edited object is no span (and Number() can throw on one).
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (prop === 'columnSpan') return n > 1;
  // A phone's single column has no room to lay a tall card beside others: it keeps one row.
  if (prop === 'rowSpan') return n > 1;
  // Column sizes for all sizes are uneven or as-many-as-fit tracks: a phone keeps its own column count.
  if (prop === 'gridTemplate') return true;
  if (!wideColumns) return false;
  return prop === 'columns' && n > 1;
}

/** Whether a source of styles sets column sizes for All sizes that the stylesheet writes (see `withColumnSizes`). */
export function columnSizesForAllSizes(styles: ResponsiveStyles | undefined): boolean {
  const template = styles?.base?.gridTemplate;
  return template !== undefined && template !== null && !validateStyleValue('gridTemplate', typeof template === 'string' ? template.trim() : template);
}

/**
 * One source of styles (a node's own, a variant's, a placement's) as the generated CSS writes it. Column sizes
 * override Columns: set for all sizes, they apply from tablet up (see `wideOnlyStyle`), and a column count the same
 * source sets for tablet or desktop is left out so it cannot win back those sizes. The All sizes count stays as the
 * phone layout. A template the stylesheet would not write overrides nothing.
 */
export function withColumnSizes(styles: ResponsiveStyles): ResponsiveStyles {
  if (!columnSizesForAllSizes(styles)) return styles;
  if (styles.tablet?.columns === undefined && styles.desktop?.columns === undefined) return styles;
  const out: ResponsiveStyles = { ...styles };
  for (const size of ['tablet', 'desktop'] as const) {
    if (out[size]?.columns === undefined) continue;
    const { columns: _overridden, ...rest } = out[size]!;
    out[size] = rest;
  }
  return out;
}

/**
 * "Hidden at all sizes" plus "visible on phone" is expressed by hiding only in the other ranges,
 * so the element keeps whatever display mode its own styles give it.
 */
export function resolveVisibility(styles: ResponsiveStyles): ResponsiveStyles {
  const ranges = ['phone', 'tablet', 'desktop'] as const;
  if (!ranges.some((r) => styles[r]?.hidden === false)) return styles;
  const out: ResponsiveStyles = structuredClone(styles);
  const hiddenBase = out.base?.hidden === true;
  if (out.base) delete out.base.hidden;
  for (const r of ranges) {
    const visible = out[r]?.hidden === false;
    const hidden = out[r]?.hidden === true;
    if (out[r]) delete out[r]!.hidden;
    if (hidden || (hiddenBase && !visible)) out[r] = { ...(out[r] ?? {}), hidden: true };
  }
  return out;
}

/** One layer of style rules on an element. Layers are given weakest first, in the order the stylesheet writes them. */
export interface StyleLayer {
  styles: ResponsiveStyles | undefined;
  /** How many classes its selectors carry: a stronger layer wins at every size, whatever its media query. */
  strength: number;
  /** Variants and placement overrides: multi-column values set for all sizes apply from tablet up. */
  wideColumns?: boolean;
  /**
   * Variants and placement overrides: the weaker rules a `hidden: false` here undoes. The stylesheet writes a restoring
   * display only at the sizes where one of these hides the element (see the generator's `unhider`).
   */
  unhides?: Array<ResponsiveStyles | undefined>;
  /** A design's own change to a placed code component, which reads each `hidden: false` of it as the marker that shows its root. */
  marks?: boolean;
}

const CASCADE_SIZES = ['phone', 'tablet', 'desktop'] as const;
type Size = (typeof CASCADE_SIZES)[number];
/** Where a rule sits in the stylesheet: unconditional rules, then tablet-and-up rules, then each size's own block. */
const BUCKET_ORDER = { base: 0, wide: 1, phone: 2, tablet: 3, desktop: 4 } as const;
type Bucket = keyof typeof BUCKET_ORDER;
/** Style properties that write the same CSS property, so only one of them takes effect at a size. */
const CSS_CHANNEL: Record<string, string> = { columns: 'grid-template-columns', gridTemplate: 'grid-template-columns' };

/** The other style properties that write the same CSS property as `prop` (a grid template for columns). */
export function cssRivals(prop: string): string[] {
  const channel = CSS_CHANNEL[prop];
  return channel ? Object.keys(CSS_CHANNEL).filter((k) => k !== prop && CSS_CHANNEL[k] === channel) : [];
}

/**
 * Where a property's declarations sit inside one rule: composite text styles and gaps first so the specific ones
 * win, custom CSS after the named properties, and visibility last so it can override the display a layout sets.
 */
export function styleDeclOrder(prop: string): number {
  return prop === 'textStyle' || prop === 'gap' ? 0 : prop === 'customCss' ? 2 : prop === 'hidden' ? 3 : 1;
}

type CascadeDecl = { prop: string; value: StyleValue; bucket: Bucket; strength: number; index: number; seq: number };

/** Every declaration layers of rules write for one element, and how they rank, as the generated CSS cascades them. */
function cascadeOf(layers: StyleLayer[], { inertShows = true } = {}) {
  const decls: CascadeDecl[] = [];
  layers.forEach((layer, index) => {
    const raw = layer.styles;
    if (!raw) return;
    const push = (prop: string, value: StyleValue, bucket: Bucket) => decls.push({ prop, value, bucket, strength: layer.strength, index, seq: decls.length });
    // Where a weaker rule hides the element, so a `hidden: false` here writes a display that shows it again.
    const weakerHides = (size: Size) => !!layer.unhides?.some((l) => l?.base?.hidden === true || l?.[size]?.hidden === true);
    // Visibility is folded the way the stylesheet writes it: a hide with sizes shown again hides in the others.
    const folded = resolveVisibility(withColumnSizes(raw));
    for (const scope of ['base', 'phone', 'tablet', 'desktop'] as const) {
      for (const [prop, value] of Object.entries(folded[scope] ?? {})) {
        if (value === undefined) continue;
        // A `hidden: false` that undoes no weaker hide writes nothing: it decides nothing in the stylesheet.
        if (!inertShows && prop === 'hidden' && value === false && !layer.marks) continue;
        push(prop, value, scope === 'base' && wideOnlyStyle(prop, value, layer.wideColumns) ? 'wide' : scope);
      }
      // A size shown again (the folding removed the value): a display that undoes a weaker hide there.
      if (scope !== 'base' && raw[scope]?.hidden === false && (weakerHides(scope) || layer.marks)) push('hidden', false, scope);
    }
    // Shown at every size: in each size it does not set itself, a display that undoes a weaker hide there.
    if (raw.base?.hidden === false) for (const size of CASCADE_SIZES) if (raw[size]?.hidden === undefined && (weakerHides(size) || layer.marks)) push('hidden', false, size);
  });
  // Within one rule, declarations are written in the generator's order, so the later one wins a shared CSS property.
  const inRule = (a: CascadeDecl, b: CascadeDecl) => styleDeclOrder(a.prop) - styleDeclOrder(b.prop) || a.prop.localeCompare(b.prop);
  const beats = (a: CascadeDecl, b: CascadeDecl | undefined) =>
    !b ||
    a.strength > b.strength ||
    (a.strength === b.strength &&
      (BUCKET_ORDER[a.bucket] > BUCKET_ORDER[b.bucket] || (BUCKET_ORDER[a.bucket] === BUCKET_ORDER[b.bucket] && (a.index > b.index || (a.index === b.index && inRule(a, b) >= 0)))));
  // One shown-again result per hide a layout overrides, so a value for every size is recognised at each size too.
  const unhidden = new Map<CascadeDecl, CascadeDecl>();
  const winners = (applies: (bucket: Bucket) => boolean) => {
    const best = new Map<string, CascadeDecl>();
    for (const d of decls) {
      const channel = CSS_CHANNEL[d.prop] ?? d.prop;
      if (applies(d.bucket) && beats(d, best.get(channel))) best.set(channel, d);
    }
    // A hide is a `display: none`, and every layout writes a display too: a layout that wins over the hide shows it.
    const hide = best.get('hidden');
    if (hide?.value === true && decls.some((d) => d.prop === 'layout' && applies(d.bucket) && beats(d, hide))) {
      if (!unhidden.has(hide)) unhidden.set(hide, { ...hide, value: false });
      best.set('hidden', unhidden.get(hide)!);
    }
    return [...best.values()];
  };
  return { decls, beats, winners };
}

/** The buckets whose rules apply at one size. */
const appliesAt = (size: Size) => (b: Bucket) => b === 'base' || b === size || (b === 'wide' && size !== 'phone');

/**
 * The value each style property gets from layers of rules, as the generated CSS cascades them. Each size holds the
 * winner at that size: the strongest layer that sets the property there, then the rule written last (base, then
 * tablet-and-up, then the size's own block), then the later layer. Properties that write the same CSS property
 * (columns and a grid template) compete as one. `base` holds the winner among values that apply at every size, when
 * it is what some size shows, so a size never needs to fall back to it: a value kept off phones is in tablet and
 * desktop only.
 */
export function cascadeStyles(layers: StyleLayer[]): ResponsiveStyles {
  const { winners } = cascadeOf(layers);
  const values = (list: CascadeDecl[]) => Object.fromEntries(list.map((d) => [d.prop, d.value]));
  const out: ResponsiveStyles = {};
  const shown = new Set<CascadeDecl>();
  for (const size of CASCADE_SIZES) {
    const at = winners(appliesAt(size));
    at.forEach((d) => shown.add(d));
    if (at.length) out[size] = values(at);
  }
  // A value for every size that no size shows (each overrides it) is not what the design gives any size.
  const base = winners((b) => b === 'base').filter((d) => shown.has(d));
  if (base.length) out.base = values(base);
  return out;
}

/**
 * Shorthands and the properties they also set. One rule writes a shorthand before them (see `styleDeclOrder` and the
 * alphabetical order after it), so inside one rule each of them beats its shorthand.
 */
const SHORTHANDS: Record<string, string[]> = {
  gap: ['rowGap', 'columnGap'],
  textStyle: ['fontFamily', 'fontSize', 'lineHeight', 'fontWeight', 'letterSpacing', 'textTransform'],
  paddingBlock: ['paddingBlockStart', 'paddingBlockEnd'],
  paddingInline: ['paddingInlineStart', 'paddingInlineEnd'],
  marginInline: ['marginInlineStart', 'marginInlineEnd'],
  border: ['borderBlockStart', 'borderBlockEnd', 'borderInlineStart', 'borderInlineEnd']
};

/** The CSS properties one style property's declarations set (custom properties left out). */
function cssNames(prop: string, value: StyleValue): string[] {
  // A background image paints through these, written by the generator alone.
  if (prop === 'backgroundImage') return isBackgroundImageValue(value) ? ['background-image', 'background-size', 'background-position', 'background-repeat'] : [];
  const decls = prop === 'customCss' ? (typeof value === 'string' ? parseCustomCss(value).decls : []) : prop === 'hidden' ? ['display: none'] : styleToCss(prop, value);
  return decls.map((d) => d.slice(0, d.indexOf(':')).trim().toLowerCase()).filter((p) => p && !p.startsWith('--'));
}

/** Display values a browser takes. */
const DISPLAY_VALUE = /^(none|contents|inline-block|inline-flex|inline-grid|inline-table|table-[a-z-]+|ruby-[a-z]+|revert|revert-layer|initial|inherit|unset|(block|inline|run-in|flow|flow-root|flex|grid|table|ruby|list-item)(\s+(block|inline|run-in|flow|flow-root|flex|grid|table|ruby|list-item))*)$/i;

/** Shorthands whose longhands are not named after them. */
const SHORTHAND_SETS: Record<string, string[]> = {
  gap: ['row-gap', 'column-gap'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'],
  'place-self': ['align-self', 'justify-self'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  columns: ['column-count', 'column-width']
};

/** Whether CSS shorthand `short` also sets `long` (`padding` sets `padding-inline-start`; `gap` sets `row-gap`). */
function covers(short: string, long: string): boolean {
  if (Object.hasOwn(SHORTHAND_SETS, short)) return SHORTHAND_SETS[short].includes(long);
  if (short === 'border-radius') return /^border-[a-z-]+-radius$/.test(long);
  // `border` resets each side's width, style and colour, never the corners or an image; `background` never its blend mode.
  if (short === 'border' && /radius|image/.test(long)) return false;
  if (short === 'background' && long === 'background-blend-mode') return false;
  return long.startsWith(`${short}-`);
}

/**
 * A background colour and a background image never undo each other: wherever an element can carry a picture, its
 * background shorthand paints the picture's longhands again from the picture's variables (generator/background.ts).
 */
const paintedApart = (a: string, b: string) => (a === 'background' && b === 'backgroundImage') || (a === 'backgroundImage' && b === 'background');

/** Whether two sets of CSS properties set any property in common. */
const overlap = (a: string[], b: string[]) => a.some((x) => b.some((y) => x === y || covers(x, y) || covers(y, x)));

export interface FlattenOptions {
  /** The single rule the result is written as: a placement's override (`true`) keeps multi-column values off phones. */
  wideColumns?: boolean;
  /** The result styles a link, whose background goes through the button's own variable, not `background`. */
  link?: boolean;
  /**
   * The first layers stay in force beneath the result (a placed component's own design): what they win is left to
   * them, except where the result would now override them.
   */
  beneath?: number;
  /**
   * The display the stylesheet gives an element shown again over a weaker hide, where no layout sets one (see the
   * generator's `unhider`).
   */
  shownDisplay?: (size: Size) => string | null;
  /** Called when the custom CSS of every layer together is more than one element's custom CSS can hold. */
  tooMuch?: () => never;
}

/**
 * Layers of rules on one element folded into the one set of styles that renders the same as a single rule: what an
 * element detached from its component keeps. At each size the cascade's winner stays, except a property its
 * shorthand beats (the shorthand alone sets it then), and every layer's custom CSS applies in cascade order minus what
 * a stronger property sets. Display is decided once: the declaration that sets it last, across every layer (a hide, a
 * layout, custom CSS, or the display a show writes), is the only one written.
 */
export function flattenStyles(layers: StyleLayer[], opts: FlattenOptions = {}): ResponsiveStyles {
  // A `hidden: false` that undoes nothing writes nothing, unless a code component reads it (as a marker).
  const { decls, beats, winners } = cascadeOf(layers, { inertShows: false });
  const beneath = opts.beneath ?? 0;
  const own = (d: CascadeDecl) => d.index >= beneath;
  // What a declaration sets besides display, which is decided on its own below.
  const names = (d: CascadeDecl) => (opts.link && d.prop === 'background' ? [] : cssNames(d.prop, d.value)).filter((n) => n !== 'display');
  const bySize = {} as Record<Size, StyleProps>;
  for (const size of CASCADE_SIZES) {
    const applies = appliesAt(size);
    const best = new Map(winners(applies).map((d) => [d.prop, d]));
    for (const [short, longs] of Object.entries(SHORTHANDS)) {
      const s = best.get(short);
      if (s) for (const l of longs) if (best.has(l) && beats(s, best.get(l))) best.delete(l);
    }
    best.delete('customCss');
    best.delete('hidden');
    const named = [...best.values()];
    // A layer with a value kept off phones writes its custom CSS again in that tablet-and-up rule, after it.
    const wideAgain = (d: CascadeDecl): CascadeDecl =>
      size !== 'phone' && d.bucket === 'base' && decls.some((x) => x.index === d.index && x.bucket === 'wide' && styleToCss(x.prop, x.value).length) ? { ...d, bucket: 'wide' } : d;
    const custom = decls
      .filter((d) => d.prop === 'customCss' && applies(d.bucket) && typeof d.value === 'string')
      .map(wideAgain)
      .sort((a, b) => (a === b ? 0 : beats(a, b) ? 1 : -1));
    // Custom CSS from every layer applies, the stronger written later. A declaration a stronger property also sets
    // goes; one that sets more than a stronger property (a shorthand) stays, with that property's own after it.
    const written: string[] = [];
    for (const c of custom) {
      if (!own(c)) continue;
      const stronger = named.filter((n) => beats(n, c));
      for (const decl of parseCustomCss(String(c.value)).decls) {
        const p = decl.slice(0, decl.indexOf(':'));
        if (p === 'display' || stronger.some((n) => names(n).some((q) => q === p || covers(q, p)))) continue;
        // Written again in the order one rule writes them, so a shorthand among them comes before its own longhands.
        const under = stronger.filter((n) => names(n).some((q) => covers(p, q))).sort((a, b) => styleDeclOrder(a.prop) - styleDeclOrder(b.prop) || a.prop.localeCompare(b.prop));
        // A background image cannot be written in custom CSS: it keeps its picture, and the shorthand over it goes.
        if (under.some((n) => n.prop === 'backgroundImage')) continue;
        const again = under.flatMap((n) => styleToCss(n.prop, n.value)).filter((d) => !d.startsWith('--') && !d.startsWith('display') && !parseCustomCss(d).error);
        // What the stronger property writes cannot go in custom CSS: it keeps its value, and the shorthand goes.
        if (again.length < under.flatMap((n) => styleToCss(n.prop, n.value)).filter((d) => !d.startsWith('--') && !d.startsWith('display')).length) continue;
        written.push(decl, ...again);
      }
    }
    // Beneath stays in force, and the result is written over it: where a weaker property of the result would now beat
    // a stronger one beneath on a CSS property they share, the one beneath is written too, after it in the rule, unless
    // something of the result's own beats it there (custom CSS included).
    const ownWins = named.filter(own);
    const ownCustom = custom.filter(own);
    for (const q of named.filter((d) => !own(d))) {
      if (!ownWins.some((p) => p !== q && !paintedApart(p.prop, q.prop) && overlap(names(p), names(q)) && beats(q, p))) continue;
      if ([...ownWins, ...ownCustom].some((r) => !paintedApart(r.prop, q.prop) && overlap(names(r), names(q)) && beats(r, q))) continue;
      best.set(q.prop, { ...q, index: beneath });
    }
    // Display: every declaration that sets it at this size, ranked as the stylesheets rank them. A show writes its
    // display first in its rule, before the rule's own declarations.
    type Display = { d: CascadeDecl; order: number; value: string };
    // The last display a list of declarations sets that a browser takes (it skips a value it does not know).
    const displayOf = (decl: string[]) => decl.filter((x) => x.startsWith('display:')).map((x) => x.slice(8).trim()).filter((v) => DISPLAY_VALUE.test(v)).at(-1);
    const candidates: Display[] = [];
    for (const d of decls) {
      if (!applies(d.bucket)) continue;
      if (d.prop === 'hidden' && d.value === true) candidates.push({ d, order: styleDeclOrder('hidden'), value: 'none' });
      else if (d.prop === 'layout') {
        const v = displayOf(styleToCss('layout', d.value));
        if (v) candidates.push({ d, order: styleDeclOrder('layout'), value: v });
      } else if (d.prop === 'customCss' && typeof d.value === 'string') {
        const v = displayOf(parseCustomCss(d.value).decls);
        if (v) candidates.push({ d: wideAgain(d), order: styleDeclOrder('customCss'), value: v });
      } else if (d.prop === 'hidden' && d.value === false) {
        // The display a show writes: the layout the layers give it, or what the theme gives its kind of element.
        const layout = decls.filter((x) => x.prop === 'layout' && (x.bucket === 'base' || x.bucket === size)).at(-1);
        const v = (layout && displayOf(styleToCss('layout', layout.value))) || opts.shownDisplay?.(size) || '';
        candidates.push({ d, order: -1, value: layers[d.index]?.marks ? 'shown' : v });
      }
    }
    const rank = (c: Display) => [c.d.strength, BUCKET_ORDER[c.d.bucket], c.d.index, c.order];
    const later = (a: Display, b: Display) => {
      const [x, y] = [rank(a), rank(b)];
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i];
      return true;
    };
    const shown = candidates.reduce<Display | undefined>((w, c) => (!w || later(c, w) ? c : w), undefined);
    const props: StyleProps = {};
    for (const d of best.values()) if (own(d)) props[d.prop] = d.value;
    const ownLayout = best.has('layout') && own(best.get('layout')!);
    // Written only where the result's own rule decides it: the winner is its own, or its own layout would override one beneath.
    if (shown && (own(shown.d) || ownLayout)) {
      if (shown.value === 'none') props.hidden = true;
      else if (shown.value === 'shown') props.hidden = false;
      else if (!(shown.d.prop === 'layout' && own(shown.d) && ownLayout)) {
        if (shown.value) written.push(`display: ${shown.value}`);
      }
    }
    if (written.length) {
      const text = written.join('; ');
      if (parseCustomCss(text).error) {
        opts.tooMuch?.();
        // Without a refusal, the declarations written last win, so the earliest go first.
        while (written.length > 1 && parseCustomCss(written.join('; ')).error) written.shift();
      }
      const kept = written.join('; ');
      if (!parseCustomCss(kept).error) props.customCss = kept;
    }
    bySize[size] = props;
  }
  return packSizes(bySize, !!opts.wideColumns);
}

/**
 * The interactive state rules of layers of rules on one element, folded into the state rules of the one set of styles
 * `flattenStyles` makes of their resting rules, or null when one element's rules cannot show exactly what the layers
 * show. The stylesheet writes every resting rule, then each state's rules in turn (hover, focus, active), so within
 * one layer, and among layers as strong as each other, a state beats every resting value at every size; a stronger
 * layer still beats a weaker one's state with its resting value. At each size and in each state, a property keeps the
 * value of the state rule that wins there; layers beneath (`beneath`) stay in force under the result as they are.
 *
 * Folded, every state rule becomes as strong as every other and as the result's resting rule, so the fold is refused
 * where that would change what shows: two states that write a CSS property in common, while both hold, where the
 * winner is no longer the one their layers chose (layers beneath that both stay as they are aside); a state value a
 * stronger layer's resting rule overrides through another property (custom CSS, a border over one side); a state of a
 * layer beneath that the result's resting rule, now over it, would hide; and, for a link (`link`), a state background
 * a stronger resting one beats, whose state rule still paints the background the resting one leaves to the theme.
 */
export function flattenStates(layers: StyleLayer[], opts: Pick<FlattenOptions, 'beneath' | 'link'> = {}): ResponsiveStyles | null {
  const beneath = opts.beneath ?? 0;
  type Decl = { prop: string; value: StyleValue; index: number; strength: number; scope: ResponsiveScope; state?: StyleState; names: string[] };
  const decls: Decl[] = [];
  layers.forEach((layer, index) => {
    for (const [key, props] of Object.entries(layer.styles ?? {})) {
      const at = parseStyleScopeKey(key);
      // Container width ranges are folded on their own (see flattenContainers).
      if (!at || isContainerScope(at.scope) || !props || typeof props !== 'object') continue;
      for (const [prop, value] of Object.entries(props)) {
        // A state value no state can hold reaches no stylesheet.
        if (value === undefined || (at.state && !isStateStyleProp(prop, at.state))) continue;
        decls.push({ prop, value, index, strength: layer.strength, scope: at.scope as ResponsiveScope, state: at.state, names: cssNames(prop, value) });
      }
    }
  });
  const states = decls.filter((d) => d.state);
  if (!states.length) return {};
  // Two rules that can apply at the same size.
  const meet = (a: Decl, b: Decl) => a.scope === 'base' || b.scope === 'base' || a.scope === b.scope;
  // Whether two rules can set something in common. Borders and corners are compared as families, so a side, a
  // colour or a physical edge never slips past its shorthand.
  const family = (n: string) => (n.includes('radius') ? 'radius' : n.startsWith('border') ? 'border' : n);
  // The two shift axes write one translate through a variable each, so one never overrides the other.
  const axes = (a: Decl, b: Decl) => (a.prop === 'translateX' && b.prop === 'translateY') || (a.prop === 'translateY' && b.prop === 'translateX');
  const touch = (a: Decl, b: Decl) => !axes(a, b) && !paintedApart(a.prop, b.prop) && (overlap(a.names, b.names) || a.names.some((x) => b.names.some((y) => family(x) === family(y))));
  const order = (d: Decl) => STYLE_STATES.indexOf(d.state!);
  const own = (d: Decl) => d.index >= beneath;
  for (const a of states) {
    for (const b of states) {
      if (a === b || !meet(a, b) || !touch(a, b) || (!own(a) && !own(b))) continue;
      // One state's values: the size-by-size winners settle one property, and one rule's order a border and its sides.
      if (a.state === b.state && (a.prop === b.prop || (own(a) && own(b)))) continue;
      // Each pair once, `b` the later: the later state, or in one state the later layer.
      if (a.state !== b.state ? order(a) > order(b) : a.index > b.index) continue;
      // Where both apply, before: the stronger layer's, or as strong, the later. After: the later of two folded
      // together; the folded one over a layer beneath.
      const before = a.strength > b.strength ? a : b;
      const after = own(a) && own(b) ? b : own(a) ? a : b;
      if (before !== after) return null;
    }
    for (const r of decls) {
      if (r.state || r.index === a.index || !meet(a, r) || !touch(a, r)) continue;
      if (r.strength > a.strength && r.prop !== a.prop) return null;
      if (!own(a) && own(r) && r.strength <= a.strength) return null;
      if (opts.link && own(a) && a.prop === 'background' && r.prop === 'background' && r.strength > a.strength) return null;
    }
  }
  const out: ResponsiveStyles = {};
  for (const state of STYLE_STATES) {
    const bySize = {} as Record<Size, StyleProps>;
    let any = false;
    for (const size of CASCADE_SIZES) {
      // Stronger first; as strong (one stylesheet block), a state rule after every resting one; then the size's own
      // rule after the rule for all sizes; then the later layer.
      const rank = (d: Decl) => [d.strength, d.state ? 1 : 0, d.scope === 'base' ? 0 : 1, d.index];
      const best = new Map<string, Decl>();
      for (const d of decls) {
        if ((d.scope !== 'base' && d.scope !== size) || (d.state !== undefined && d.state !== state)) continue;
        const held = best.get(d.prop);
        if (!held || later(rank(d), rank(held))) best.set(d.prop, d);
      }
      const props: StyleProps = {};
      for (const [prop, d] of best) if (d.state && d.index >= beneath) props[prop] = d.value;
      // One rule writes a border before its sides, so a side a later border overrode here goes.
      const border = best.get('border');
      if (border) for (const edge of SHORTHANDS.border) if (best.has(edge) && later(rank(border), rank(best.get(edge)!))) delete props[edge];
      bySize[size] = props;
      if (Object.keys(props).length) any = true;
    }
    if (!any) continue;
    const packed = packSizes(bySize, false);
    for (const scope of ['base', ...CASCADE_SIZES] as const) if (packed[scope]) out[styleScopeKey(scope, state)] = packed[scope];
  }
  return out;
}

/**
 * The rules for container width ranges (resting and in each state) that the layers above `beneath` give one element,
 * folded into one set of styles beside what `flattenStyles` and `flattenStates` make of the rest: or null when one
 * element's rules cannot show exactly what the layers do. Folded, a container range's rule sits in the result's own
 * container block, after every screen size and as strong as every other rule of the result, so the fold is refused
 * where a rule of another layer that beat it would then lose to it, or would beat it where it lost: a stronger (or
 * as strong and later) rule for a screen size or the same range, a state that a different strength ranked otherwise,
 * or two properties sharing a CSS property in one range. A stronger rule for every size that sets the same property,
 * and is not kept off phones, decides it everywhere, so that container rule never showed and is left out. Ranges
 * never overlap, so rules for different ranges never meet. A layer beneath stays where it is: a container rule of its
 * own that beat one of the result's is refused, since the result is written over it.
 */
export function flattenContainers(layers: StyleLayer[], opts: Pick<FlattenOptions, 'beneath'> = {}): ResponsiveStyles | null {
  const beneath = opts.beneath ?? 0;
  type Decl = { prop: string; value: StyleValue; index: number; strength: number; scope: StyleScope; state?: StyleState; names: string[]; everywhere: boolean };
  const decls: Decl[] = [];
  layers.forEach((layer, index) => {
    for (const [key, props] of Object.entries(layer.styles ?? {})) {
      const at = parseStyleScopeKey(key);
      if (!at || !props || typeof props !== 'object') continue;
      for (const [prop, value] of Object.entries(props)) {
        if (value === undefined || (at.state && !isStateStyleProp(prop, at.state))) continue;
        if (isContainerScope(at.scope) && containerStyleError(prop)) continue;
        const everywhere = at.scope === 'base' && !at.state && !wideOnlyStyle(prop, value, layer.wideColumns);
        decls.push({ prop, value, index, strength: layer.strength, scope: at.scope, state: at.state, names: cssNames(prop, value), everywhere });
      }
    }
  });
  const ranged = decls.filter((d) => isContainerScope(d.scope));
  if (!ranged.length) return {};
  const family = (n: string) => (n.includes('radius') ? 'radius' : n.startsWith('border') ? 'border' : n);
  const axes = (a: Decl, b: Decl) => (a.prop === 'translateX' && b.prop === 'translateY') || (a.prop === 'translateY' && b.prop === 'translateX');
  const touch = (a: Decl, b: Decl) => a.prop === b.prop || (!axes(a, b) && !paintedApart(a.prop, b.prop) && (overlap(a.names, b.names) || a.names.some((x) => b.names.some((y) => family(x) === family(y)))));
  // Where both apply, before the fold: the stronger layer's, or as strong, the later one's.
  const beats = (a: Decl, b: Decl) => a.strength > b.strength || (a.strength === b.strength && a.index > b.index);
  const own = (d: Decl) => d.index >= beneath;
  const left = new Set<Decl>();
  for (const c of ranged) {
    for (const r of decls) {
      if (r.index === c.index || !touch(c, r)) continue;
      if (isContainerScope(r.scope) && r.scope !== c.scope) continue;
      if (!own(c)) {
        // A layer beneath keeps its own rule, now under the result: it may not have beaten one of the result's.
        if (own(r) && beats(c, r)) return null;
        continue;
      }
      // A display shown over another layer's hide: folded, the result's own hide follows it (see the generator's
      // addContainerRules), so the container range would no longer show it.
      if (r.prop === 'hidden' && r.value === true && !beats(r, c)) return null;
      if ((r.state ?? null) !== (c.state ?? null)) {
        // Between a state and another state or the resting style, the state written later wins in one stylesheet, as
        // it did in two of the same strength; across strengths the stronger won, which the fold would change.
        if (r.strength !== c.strength) return null;
        continue;
      }
      if (!beats(r, c)) continue;
      if (r.scope === c.scope) {
        // The same range in the same state: the stronger value is the one folded, for the same property.
        if (r.prop !== c.prop) return null;
        left.add(c);
        continue;
      }
      if (r.everywhere && r.prop === c.prop) {
        left.add(c);
        continue;
      }
      return null;
    }
  }
  const out: ResponsiveStyles = {};
  // Weaker first, so the stronger value of a property in one range is the one kept.
  for (const c of ranged.filter((d) => own(d) && !left.has(d)).sort((a, b) => a.strength - b.strength || a.index - b.index)) {
    const key = styleScopeKey(c.scope, c.state);
    (out[key] ??= {})[c.prop] = c.value;
  }
  return out;
}

/** Whether rank `a` comes after rank `b` in the cascade, so `a` wins. */
function later(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * Per-size values as one set of styles, as an author would set them, written so one rule renders each size exactly as
 * given. Properties that set a CSS property in common (a layout and a hide, a gap and a row gap, custom CSS and what
 * it sets) are packed together: for all sizes only when every one of them is the same at every size, otherwise per
 * size. A property on its own every size has takes its most common value for all sizes (the widest size's on a tie)
 * and the others as exceptions; one some sizes leave alone, or a value the rule would keep off phones, is set per size.
 */
function packSizes(bySize: Record<Size, StyleProps>, wideColumns: boolean): ResponsiveStyles {
  const out: ResponsiveStyles = {};
  const props = [...new Set(CASCADE_SIZES.flatMap((s) => Object.keys(bySize[s])))].sort();
  const key = (v: StyleValue | undefined) => JSON.stringify(v);
  const values = (prop: string) => CASCADE_SIZES.map((s) => bySize[s][prop]);
  const css = new Map(props.map((p) => [p, [...new Set(values(p).flatMap((v) => (v === undefined ? [] : cssNames(p, v))))]]));
  // Groups of properties that share a CSS property, directly or through another.
  const group = new Map(props.map((p) => [p, p]));
  const find = (p: string): string => (group.get(p) === p ? p : find(group.get(p)!));
  for (const a of props) for (const b of props) if (a < b && overlap(css.get(a)!, css.get(b)!)) group.set(find(a), find(b));
  const set = (s: ResponsiveScope, prop: string, v: StyleValue) => ((out[s] ??= {})[prop] = v);
  const perSize = (prop: string) => CASCADE_SIZES.forEach((s, i) => values(prop)[i] !== undefined && set(s, prop, values(prop)[i]!));
  const groups = new Map<string, string[]>();
  for (const p of props) groups.set(find(p), [...(groups.get(find(p)) ?? []), p]);
  for (const members of groups.values()) {
    const constant = (p: string) => values(p).every((v) => v !== undefined && key(v) === key(values(p)[0])) && !wideOnlyStyle(p, values(p)[0], wideColumns);
    if (members.length > 1) {
      const together = members.every(constant);
      for (const p of members) {
        if (together) set('base', p, values(p)[0]!);
        else perSize(p);
      }
      continue;
    }
    const prop = members[0];
    const vals = values(prop);
    const count = (v: StyleValue | undefined) => vals.filter((x) => key(x) === key(v)).length;
    const common = vals.every((v) => v !== undefined) ? [...vals].reverse().reduce((a, b) => (count(b) > count(a) ? b : a)) : undefined;
    if (common === undefined || wideOnlyStyle(prop, common, wideColumns)) {
      perSize(prop);
      continue;
    }
    set('base', prop, common);
    CASCADE_SIZES.forEach((s, i) => key(vals[i]) !== key(common) && set(s, prop, vals[i]!));
  }
  return out;
}
