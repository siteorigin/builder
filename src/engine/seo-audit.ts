/**
 * The SEO and agentic readiness audit: rules read a project and say what keeps its website from being found, shared
 * and understood (by search engines, link previews and AI answer engines). It only reads, takes no clock, file or
 * network, and lists its findings in a fixed order, so the same project always gives the same findings and each one
 * is told apart from the others, and from itself on a later run, as diagnostics are (`diagnosticKey`).
 *
 * The baseline rules are in seo-rules.ts. A feature with findings of its own passes its rules in beside them.
 */
import type { ProjectState } from '@shared/types';
import type { EffectiveSeo, SeoFinding } from '@shared/seo';
import { SEO_PILLARS } from '@shared/seo';
import { createSeoResolver, type SeoResolver } from '@generator/seo-metadata';
import { siteLinks, type SiteLink } from '@generator/checks';
import { diagnosticKey } from './validate';
import { BASELINE_SEO_RULES } from './seo-rules';

/** What every rule of one run reads, worked out once. */
export interface SeoAuditContext {
  state: ProjectState;
  resolver: SeoResolver;
  /** Every document on the website: the pages in site order, then the collection entries. */
  documents: readonly EffectiveSeo[];
  /** Every link the website shows, worked out the first time a rule asks for them. */
  links(): readonly SiteLink[];
}

export interface SeoAuditRule {
  /** Names the rule: no two rules of one run share it. */
  id: string;
  check(context: SeoAuditContext): SeoFinding[];
}

const SEVERITY = { error: 0, warning: 1, info: 2 } as const;

/**
 * The project without the records too damaged to read (a page with no address, an entry that is not one), which
 * Project health reports: one of them never stops the audit of the rest. The project itself when it has none.
 */
export function readableState(state: ProjectState): ProjectState {
  const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
  const pages = Object.entries(state.pages ?? {});
  const keptPages = pages.filter(([, p]) => isRecord(p) && typeof p.route === 'string');
  const collections = Object.entries(state.collections ?? {});
  const keptCollections = collections.filter(([, c]) => isRecord(c) && isRecord(c.settings) && isRecord(c.entries));
  const damagedEntries = keptCollections.some(([, c]) => Object.values(c.entries).some((e) => !isRecord(e)));
  if (keptPages.length === pages.length && keptCollections.length === collections.length && !damagedEntries && state.collections) return state;
  return {
    ...state,
    pages: Object.fromEntries(keptPages),
    collections: Object.fromEntries(keptCollections.map(([id, c]) => [id, { ...c, entries: Object.fromEntries(Object.entries(c.entries).filter(([, e]) => isRecord(e))) }]))
  };
}

/** One run of the audit: its findings, and what its rules read to make them, for a report on the same documents and links. */
export interface SeoAudit {
  context: SeoAuditContext;
  findings: SeoFinding[];
}

/**
 * Every finding of the baseline rules and of `rules` on `state`: by pillar in their order, then the most serious
 * first, then in the order the rules found them (the site's order). A finding two rules both make is listed once.
 */
export function runSeoAudit(project: ProjectState, rules: readonly SeoAuditRule[] = []): SeoFinding[] {
  return auditSeo(project, rules).findings;
}

/** runSeoAudit, with the context its rules read: the readable project, its published documents and its links. */
export function auditSeo(project: ProjectState, rules: readonly SeoAuditRule[] = []): SeoAudit {
  const state = readableState(project);
  const all = [...BASELINE_SEO_RULES, ...rules];
  const ids = new Set<string>();
  for (const rule of all) {
    if (ids.has(rule.id)) throw new Error(`Two SEO audit rules are both called ${rule.id}.`);
    ids.add(rule.id);
  }
  const resolver = createSeoResolver(state);
  let links: readonly SiteLink[] | undefined;
  const context: SeoAuditContext = { state, resolver, documents: resolver.published(), links: () => (links ??= siteLinks(state)) };
  const seen = new Set<string>();
  const found: SeoFinding[] = [];
  for (const rule of all)
    for (const f of rule.check(context)) {
      const key = diagnosticKey(f);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(f);
    }
  const rank = (f: SeoFinding) => SEO_PILLARS.indexOf(f.pillar) * 3 + SEVERITY[f.severity];
  return { context, findings: found.map((f, i) => ({ f, i, r: rank(f) })).sort((a, b) => a.r - b.r || a.i - b.i).map(({ f }) => f) };
}
