import { variantOptions } from '@shared/variants';
import type { ProjectState, ResponsiveStyles, TokenDef, TokenValue } from '@shared/types';
import { getTheme } from '@catalogue/index';
import { linkOf } from '@shared/styles';
import { allTrees } from './tree';

export interface TokenRefSite {
  /** Where the reference is, in words ("Home", "Feature card", "Site styles"). */
  label: string;
  kind: 'style' | 'token';
  /** Style property ID for style references. */
  property?: string;
  /** Point the reference somewhere else, or replace it with a literal value. */
  replace: (next: unknown) => void;
}

const refOf = (v: unknown): string | null =>
  v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { token?: unknown }).token === 'string' ? (v as { token: string }).token : null;

/**
 * Visit every `{ token }` reference held in project-owned data: page and shell node styles, instance overrides,
 * project component trees and variant rules, token overrides and custom token values (including text-style
 * families). Theme-owned definitions and theme defaults are fixed data, so they are not visited.
 */
export function forEachTokenRef(state: ProjectState, fn: (tokenId: string, site: TokenRefSite) => void) {
  const styles = (rs: ResponsiveStyles | undefined, label: string) => {
    for (const scope of Object.values(rs ?? {})) {
      if (!scope) continue;
      for (const [k, v] of Object.entries(scope)) {
        const ref = refOf(v);
        if (ref) fn(ref, { label, kind: 'style', property: k, replace: (next) => (scope[k] = next as never) });
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
      if (n.kind === 'instance') for (const o of Object.values(n.overrides ?? {})) styles(o, t.label);
    }
  }
  const tokenValue = (holder: Record<string, unknown>, key: string) => {
    const v = holder[key];
    const ref = refOf(v);
    if (ref) return fn(ref, { label: 'Site styles', kind: 'token', replace: (next) => (holder[key] = next) });
    if (v && typeof v === 'object' && 'family' in (v as object)) {
      const fam = v as Record<string, unknown>;
      const fref = refOf(fam.family);
      if (fref) fn(fref, { label: 'Site styles', kind: 'token', replace: (next) => (fam.family = next) });
    }
  };
  for (const id of Object.keys(state.tokens.overrides)) tokenValue(state.tokens.overrides as Record<string, unknown>, id);
  for (const t of state.tokens.custom) tokenValue(t as unknown as Record<string, unknown>, 'value');
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

/** The first token that refers back to itself through other tokens, or null. */
export function findTokenCycle(state: ProjectState): string | null {
  const declared = declaredTokens(state);
  const byId = new Map(declared.map((t) => [t.id, t]));
  const value = (id: string) => (Object.hasOwn(state.tokens.overrides, id) ? state.tokens.overrides[id] : byId.get(id)?.value);
  for (const t of declared) {
    const seen = new Set<string>();
    let cur: string | null = t.id;
    while (cur) {
      if (seen.has(cur)) return t.id;
      seen.add(cur);
      cur = refOf(value(cur));
    }
  }
  return null;
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
    const next = linkOf(v);
    if (!next) return v;
    cur = next;
  }
  return undefined;
}
