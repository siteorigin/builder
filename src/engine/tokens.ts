import { variantOptions } from '@shared/variants';
import type { NodeTree, OwnerRef, ProjectState, PropSchema, ResponsiveStyles, TokenDef } from '@shared/types';
import { isBinding } from '@shared/types';
import { getTheme } from '@catalogue/index';
import { colorAtStrength, linkOf } from '@shared/styles';
import { allTrees } from './tree';
import { itemStyleRecords } from '@shared/item-styles';
import { darkValue } from '@shared/color-scheme';

export interface TokenRefSite {
  /** Where the reference is, in words ("Home", "Feature card", "Site styles"). */
  label: string;
  /** A node's style, a token's own value, or a token property's value (which must stay a token: never detached). */
  kind: 'style' | 'token' | 'prop';
  /** Style property ID for style references. */
  property?: string;
  /** Token references: the style whose value holds it. */
  tokenId?: string;
  /** Token references: the palette the value is in. A colour's value in the dark palette is `dark`. */
  scheme?: 'light' | 'dark';
  /** Point the reference somewhere else, or replace it with a literal value. */
  replace: (next: unknown) => void;
}

const refOf = (v: unknown): string | null =>
  v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { token?: unknown }).token === 'string' ? (v as { token: string }).token : null;

/**
 * What replaces a style's link, at the strength the link painted: another token at the same strength, or the
 * literal colour mixed to it, so a see-through surface stays see-through when its token is replaced or kept as a value.
 */
function atStrengthOf(link: unknown, next: unknown): unknown {
  const alpha = (link as { alpha?: unknown }).alpha;
  if (typeof alpha !== 'number' || !(alpha < 1)) return next;
  const ref = refOf(next);
  if (ref) return { token: ref, alpha };
  return typeof next === 'string' ? colorAtStrength(next.trim(), alpha) : next;
}

/**
 * Visit every `{ token }` reference held in project-owned data: page and shell node styles, instance overrides
 * (shared and per item), project component trees and variant rules, token overrides and custom token values
 * (including text-style families), and the dark palette's colours. Theme-owned definitions and theme defaults are
 * fixed data, so they are not visited.
 */
export function forEachTokenRef(state: ProjectState, fn: (tokenId: string, site: TokenRefSite) => void) {
  const styles = (rs: ResponsiveStyles | undefined, label: string) => {
    for (const scope of Object.values(rs ?? {})) {
      if (!scope) continue;
      for (const [k, v] of Object.entries(scope)) {
        const ref = refOf(v);
        if (ref) fn(ref, { label, kind: 'style', property: k, replace: (next) => (scope[k] = atStrengthOf(v, next) as never) });
      }
    }
  };
  for (const t of allTrees(state)) {
    if (t.owner.kind === 'component') {
      const def = state.components[t.owner.id];
      if (!def || def.owner !== 'project') continue;
      for (const { option: v } of variantOptions(def)) for (const st of Object.values(v.styles ?? {})) styles(st, t.label);
    }
    for (const n of Object.values(t.tree.nodes)) {
      styles(n.styles, t.label);
      if (n.kind === 'instance') for (const o of [...Object.values(n.overrides ?? {}), ...itemStyleRecords(n)]) styles(o, t.label);
    }
  }
  const groups = new Map(declaredTokens(state).map((t) => [t.id, t.group]));
  const tokenValue = (holder: Record<string, unknown>, key: string, id: string) => {
    const v = holder[key];
    // A stray `token` beside a text style's metrics is not a link; the metrics are its value.
    const ref = linkOf(v, groups.get(id));
    if (ref) return fn(ref, { label: 'Site styles', kind: 'token', tokenId: id, scheme: 'light', replace: (next) => (holder[key] = next) });
    if (v && typeof v === 'object' && 'family' in (v as object)) {
      const fam = v as Record<string, unknown>;
      const fref = refOf(fam.family);
      if (fref) fn(fref, { label: 'Site styles', kind: 'token', tokenId: id, scheme: 'light', replace: (next) => (fam.family = next) });
    }
  };
  for (const id of Object.keys(state.tokens.overrides)) tokenValue(state.tokens.overrides as Record<string, unknown>, id, id);
  for (const t of state.tokens.custom) tokenValue(t as unknown as Record<string, unknown>, 'value', t.id);
  // The dark palette's links, kept while it is turned off too, so turning it back on finds them still pointing somewhere.
  const dark = state.tokens.darkOverrides;
  if (dark && typeof dark === 'object')
    for (const id of Object.keys(dark)) {
      const ref = refOf(dark[id]);
      if (ref) fn(ref, { label: 'Site styles (dark colors)', kind: 'token', tokenId: id, scheme: 'dark', replace: (next) => (dark[id] = next as never) });
    }
  forEachTokenPropRef(state, (id, site) => fn(id, { label: site.label, kind: 'prop', replace: site.replace }));
}

/** Where a token property's value is stored, and the group of tokens it takes. */
export interface TokenPropSite {
  owner: OwnerRef;
  label: string;
  /** The placement holding it; none for a definition's default. */
  nodeId?: string;
  tokenGroup: string;
  replace: (next: unknown) => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Visit every token a token property holds, once per place it is stored: placements' values (a list item's or an
 * object's token field included) and the defaults of the project's own definitions. Theme-owned defaults are fixed
 * data. A value bound to an enclosing component's property holds no token of its own.
 */
export function forEachTokenPropRef(state: ProjectState, fn: (tokenId: string, site: TokenPropSite) => void, opts: { themeDesigns?: boolean; trees?: Array<{ owner: OwnerRef; tree: NodeTree; label: string }>; defaults?: boolean } = {}) {
  const visit = (schema: PropSchema, holder: Record<string, unknown>, key: string, owner: OwnerRef, label: string, nodeId?: string) => {
    const v = holder[key];
    if (v === undefined || isBinding(v)) return;
    if (schema.type === 'token') {
      const ref = refOf(v);
      if (ref) fn(ref, { owner, label, nodeId, tokenGroup: schema.tokenGroup, replace: (next) => (holder[key] = next) });
      return;
    }
    if (schema.type !== 'object' && schema.type !== 'list') return;
    const tokenFields = Object.entries(schema.fields).filter(([, f]) => f.type === 'token');
    if (!tokenFields.length) return;
    const records = schema.type === 'object' ? (isRecord(v) ? [v] : []) : Array.isArray(v) ? v.filter(isRecord) : [];
    for (const r of records) for (const [k, f] of tokenFields) if (Object.hasOwn(r, k)) visit(f, r, k, owner, label, nodeId);
  };
  for (const t of opts.trees ?? allTrees(state)) {
    // A theme-owned design is fixed theme data, locked to its pack: it is neither counted nor rewritten. Validation
    // still reads it (`themeDesigns`), as a design kept from an earlier theme can choose a token the new one lacks.
    if (!opts.themeDesigns && t.owner.kind === 'component' && state.components[t.owner.id]?.owner !== 'project') continue;
    for (const n of Object.values(t.tree.nodes)) {
      if (n.kind !== 'instance' || !Object.hasOwn(state.components, n.definitionId)) continue;
      for (const [k, schema] of Object.entries(state.components[n.definitionId].properties ?? {})) if (Object.hasOwn(n.props, k)) visit(schema, n.props, k, t.owner, t.label, n.id);
    }
  }
  if (opts.defaults === false) return;
  for (const def of Object.values(state.components)) {
    if (def.owner !== 'project') continue;
    const owner: OwnerRef = { kind: 'component', id: def.id };
    for (const schema of Object.values(def.properties ?? {})) {
      visit(schema, schema as unknown as Record<string, unknown>, 'default', owner, def.name);
      // A list's or object's token field has a default of its own, which new items start with.
      if (schema.type === 'list' || schema.type === 'object') for (const f of Object.values(schema.fields)) if (f.type === 'token') visit(f, f as unknown as Record<string, unknown>, 'default', owner, def.name);
    }
  }
}

/** How many times token properties hold each token: uses that can only move to another token, never to a value. */
export function tokenPropUsageCounts(state: ProjectState): Record<string, number> {
  const out: Record<string, number> = {};
  forEachTokenPropRef(state, (id) => (out[id] = (out[id] ?? 0) + 1));
  return out;
}

/** How many times project data refers to each token. */
export function tokenUsageCounts(state: ProjectState): Record<string, number> {
  const out: Record<string, number> = {};
  forEachTokenRef(state, (id) => (out[id] = (out[id] ?? 0) + 1));
  return out;
}

/** Theme tokens plus the project's custom tokens, without overrides applied. */
export function declaredTokens(state: ProjectState): TokenDef[] {
  return [...getTheme(state.site.themeId).tokens, ...state.tokens.custom];
}

/**
 * The first token that refers back to itself through the styles it links to, or null. The dark palette is checked
 * as well (whether or not it is turned on): there a colour's own dark value replaces its light one, so links that are
 * harmless in each map apart can loop once laid over each other.
 */
export function findTokenCycle(state: ProjectState): string | null {
  return findTokenCycleIn(state, 'light') ?? findTokenCycleIn(state, 'dark');
}

/** The first token that refers back to itself in one palette. */
export function findTokenCycleIn(state: ProjectState, scheme: 'light' | 'dark'): string | null {
  const declared = declaredTokens(state);
  const byId = new Map(declared.map((t) => [t.id, t]));
  const dark = scheme === 'dark' ? state.tokens.darkOverrides : undefined;
  if (scheme === 'dark' && (!dark || typeof dark !== 'object')) return null;
  const light = (id: string) => (Object.hasOwn(state.tokens.overrides, id) ? state.tokens.overrides[id] : byId.get(id)?.value);
  const value = (id: string) => {
    const own = dark && byId.get(id)?.group === 'color' && Object.hasOwn(dark, id) ? darkValue(dark[id]) : null;
    return own ?? light(id);
  };
  for (const t of declared) {
    const seen = new Set<string>();
    for (let cur: string | null = t.id; cur; cur = linkOf(value(cur), byId.get(cur)?.group)) {
      if (seen.has(cur)) return t.id;
      seen.add(cur);
    }
  }
  return null;
}
