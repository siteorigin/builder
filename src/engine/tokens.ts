import { variantOptions } from '@shared/variants';
import type { ProjectState, ResponsiveStyles, TokenDef } from '@shared/types';
import { getTheme } from '@catalogue/index';
import { cssVarNames, linkOf, tokenVar } from '@shared/styles';
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
    // Only a value that is exactly { token } is a link; a stray `token` beside text metrics is not one.
    const ref = linkOf(v);
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

/**
 * The tokens that refer back to themselves through other tokens, or lead into such a loop. A token refers to
 * another by linking to it, by its text style's font, or by naming its variable in CSS text (a border's
 * `var(--so-color-border)`, a text size's `var(--so-space-md)`, a spacing's `var(--so-text-h1-size)`): a loop
 * through any of them leaves every variable in it without a value. Font stacks hold names only, never variables.
 */
export function loopingTokens(state: ProjectState): Set<string> {
  const declared = declaredTokens(state);
  const byId = new Map(declared.map((t) => [t.id, t]));
  const byVar = new Map<string, string>();
  for (const t of declared) {
    byVar.set(tokenVar(t.id), t.id);
    if (t.group === 'text') for (const k of ['family', 'size', 'line-height', 'weight', 'tracking', 'transform']) byVar.set(`${tokenVar(t.id)}-${k}`, t.id);
  }
  const value = (id: string) => (Object.hasOwn(state.tokens.overrides, id) ? state.tokens.overrides[id] : byId.get(id)?.value);
  const next = (id: string): string[] => {
    const v = value(id);
    const link = linkOf(v);
    if (link) return [link];
    if (byId.get(id)?.group === 'font') return [];
    const texts = typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).filter((x): x is string => typeof x === 'string') : [];
    const out = texts.flatMap(cssVarNames).flatMap((n) => byVar.get(n) ?? []);
    const family = v && typeof v === 'object' ? linkOf((v as { family?: unknown }).family) : null;
    return family ? [...out, family] : out;
  };
  const reaches = new Map<string, boolean>();
  const open = new Set<string>();
  const loops = (id: string): boolean => {
    const known = reaches.get(id);
    if (known !== undefined) return known;
    if (open.has(id)) return true;
    open.add(id);
    const r = next(id).some(loops);
    open.delete(id);
    reaches.set(id, r);
    return r;
  };
  return new Set(declared.filter((t) => loops(t.id)).map((t) => t.id));
}

/** The first token that refers back to itself through other tokens (or leads into such a loop), or null. */
export function findTokenCycle(state: ProjectState): string | null {
  return loopingTokens(state).values().next().value ?? null;
}
