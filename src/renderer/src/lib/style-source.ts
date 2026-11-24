import type { ResponsiveScope, ResponsiveStyles, StyleValue } from '@shared/types';
import { cascadeStyles, cssRivals, wideOnlyStyle } from '@shared/styles';

export interface StyleSourceInput {
  prop: string;
  /** The size being edited. */
  scope: ResponsiveScope;
  /** The element's own values (a placement's overrides, or a node's own styles). */
  styles: ResponsiveStyles | undefined;
  /**
   * What the element gets from its design: each size's resolved value (see `cascadeStyles`), complete for that size,
   * or, with `designSizesWin`, the same element's original design scope by scope.
   */
  inherited: ResponsiveStyles | undefined;
  /** `inherited` is this element's own design, whose values for one size beat a change made for All sizes. */
  designSizesWin?: boolean;
  /** The own values are a variant or a placement's overrides: multi-column values for all sizes skip phones. */
  wideColumns?: boolean;
}

/** Whether the element's own value for All sizes reaches this size in the generated CSS. */
export function allSizesReach(prop: string, value: unknown, scope: ResponsiveScope, wideColumns?: boolean): boolean {
  return value !== undefined && !(scope === 'phone' && wideOnlyStyle(prop, value, wideColumns));
}

/**
 * What shows through at the edited size when nothing is set there, and where it comes from: the element's own
 * All sizes value where the stylesheet applies it at that size, otherwise its design.
 */
export function styleUnder({ prop, scope, styles, inherited, designSizesWin, wideColumns }: StyleSourceInput): { value: StyleValue | undefined; from: 'all-sizes' | 'design' | undefined } {
  // A placement's own values beat its design at every size. With the value at this size taken away, they are
  // cascaded the way the stylesheet writes them: one of them for All sizes may reach this size, or a property
  // writing the same CSS (a grid template, for columns) may win here, leaving nothing of this one to show.
  if (!designSizesWin && scope !== 'base') {
    const rest: ResponsiveStyles = { ...styles, [scope]: { ...styles?.[scope] } };
    delete rest[scope]![prop];
    const ownAt = cascadeStyles([{ styles: rest, strength: 1, wideColumns }])[scope] ?? {};
    if (ownAt[prop] !== undefined) return { value: ownAt[prop], from: 'all-sizes' };
    if (cssRivals(prop).some((r) => ownAt[r] !== undefined)) return { value: undefined, from: undefined };
    const design = inherited?.[scope]?.[prop];
    return { value: design, from: design !== undefined ? 'design' : undefined };
  }
  // Under All sizes, an own rival that reaches every size leaves nothing of the design's value to show.
  if (!designSizesWin && cssRivals(prop).some((r) => allSizesReach(r, styles?.base?.[r], 'phone', wideColumns))) return { value: undefined, from: undefined };
  const designHere = scope !== 'base' ? inherited?.[scope]?.[prop] : undefined;
  const own = styles?.base?.[prop];
  const allSizes = scope !== 'base' && !(designSizesWin && designHere !== undefined) && allSizesReach(prop, own, scope, wideColumns) ? own : undefined;
  if (allSizes !== undefined) return { value: allSizes, from: 'all-sizes' };
  // A resolved size is complete: a property it leaves out is one the design gives nothing there (another property
  // writing the same CSS won, or the design's All sizes value skips that size). Only raw design scopes fall back.
  const fromDesign = scope === 'base' || designSizesWin ? (designHere ?? inherited?.base?.[prop]) : designHere;
  return { value: fromDesign, from: fromDesign !== undefined ? 'design' : undefined };
}

/** The value the element ends up with at the edited size: its own value there, else whatever shows through. */
export function styleEffective(input: StyleSourceInput): StyleValue | undefined {
  return input.styles?.[input.scope]?.[input.prop] ?? styleUnder(input).value;
}
