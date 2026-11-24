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
    // Its own "shown" undoes a hide the design gives this size, as the stylesheet writes it.
    const ownAt = cascadeStyles([{ styles: rest, strength: 1, wideColumns, unhides: [inherited] }])[scope] ?? {};
    if (ownAt[prop] !== undefined) return { value: ownAt[prop], from: 'all-sizes' };
    if (cssRivals(prop).some((r) => ownAt[r] !== undefined)) return { value: undefined, from: undefined };
    const design = inherited?.[scope]?.[prop];
    return { value: design, from: design !== undefined ? 'design' : undefined };
  }
  // Under All sizes, the design's value shows only where neither it is replaced at that size nor an own value writing
  // the same CSS wins there.
  if (!designSizesWin && cssRivals(prop).length && inherited?.base?.[prop] !== undefined) {
    const own = cascadeStyles([{ styles, strength: 1, wideColumns }]);
    const shows = (['phone', 'tablet', 'desktop'] as const).some((s) => JSON.stringify(inherited[s]?.[prop]) === JSON.stringify(inherited.base![prop]) && !cssRivals(prop).some((r) => own[s]?.[r] !== undefined));
    if (!shows) return { value: undefined, from: undefined };
  }
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

/** The values a property ends up with at each size an edit at this scope reaches: under All sizes, every size. */
export function styleReached(input: StyleSourceInput): StyleValue[] {
  const scopes: ResponsiveScope[] = input.scope === 'base' ? ['base', 'phone', 'tablet', 'desktop'] : [input.scope];
  return scopes.map((scope) => styleEffective({ ...input, scope })).filter((v): v is StyleValue => v !== undefined);
}

/**
 * Whether a row that refines another control has something to refine yet: an origin needs a scale or rotation, a
 * duration or easing a transition preset other than none, at some size the edit reaches (`valuesOf` gives a
 * property's value at each). A row with a value there, or whose control is not on offer here, always shows.
 * Undefined for every other property.
 */
export function refinementShown(prop: string, valuesOf: (prop: string) => StyleValue[], offered: (prop: string) => boolean): boolean | undefined {
  const any = (p: string) => valuesOf(p).length > 0;
  if (prop === 'transformOrigin') return any(prop) || any('scale') || any('rotate') || (!offered('scale') && !offered('rotate'));
  if (prop === 'transitionDuration' || prop === 'transitionEasing') return any(prop) || valuesOf('transition').some((v) => v !== 'none') || !offered('transition');
  return undefined;
}

/**
 * A number typed into a style field, or null when it is not one: a percentage on a 0 to 1 value (50% is 0.5), or
 * the number written with the property's own unit ("250ms", "-2deg"). Transforms and timings take plain decimals;
 * older fields read anything JavaScript reads as a finite number, as they always have.
 */
export function readStyleNumber(def: { max?: number; unit?: string; group?: string }, text: string): number | null {
  const t = text.trim();
  const percent = def.max === 1 && t.endsWith('%');
  const bare = (percent ? t.slice(0, -1) : def.unit && t.toLowerCase().endsWith(def.unit) ? t.slice(0, -def.unit.length) : t).trim();
  if (!bare || (def.group === 'motion' && !/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(bare))) return null;
  const n = Number(bare);
  if (!Number.isFinite(n)) return null;
  return percent ? n / 100 : n;
}
