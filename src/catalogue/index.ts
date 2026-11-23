import type { ComponentDefinition } from '@shared/types';
import type { ThemePack } from './pack';

export type { ThemePack } from './pack';

/**
 * The packs this app has loaded. Main loads and validates the installed releases once at startup, the editor
 * receives the same list before it first renders, and tests register the authored packs directly; every lookup
 * below then stays synchronous.
 */
let registry: ThemePack[] = [];
let byId = new Map<string, ThemePack>();

/** Replace the loaded packs. The first pack that is not a development fixture is the default theme. */
export function registerPacks(packs: ThemePack[]): void {
  const ids = new Set<string>();
  for (const p of packs) {
    if (ids.has(p.id)) throw new Error(`Two packs have the ID "${p.id}".`);
    ids.add(p.id);
  }
  registry = [...packs];
  byId = new Map(registry.map((p) => [p.id, p]));
}

/** The pack with this ID, if it is loaded. */
export function findTheme(id: string): ThemePack | undefined {
  return byId.get(id);
}

/** The default theme: the first loaded pack that is not a development fixture. */
export function defaultTheme(): ThemePack {
  const theme = registry.find((p) => !p.devOnly) ?? registry[0];
  if (!theme) throw new Error('No theme packs are loaded.');
  return theme;
}

/** The pack with this ID, or the default theme when it is not installed here. */
export function getTheme(id: string): ThemePack {
  return byId.get(id) ?? defaultTheme();
}

export function listThemes(): ThemePack[] {
  return registry;
}

/** What a project's theme lock records for this pack: an installed pack is pinned to its exact release. */
export function themeLockEntry(theme: ThemePack): { id: string; version: string; digest?: string } {
  return { id: theme.id, version: theme.version, ...(theme.source === 'user' && theme.digest ? { digest: theme.digest } : {}) };
}

/**
 * Why a project cannot be edited with the packs loaded here: its installed (pinned) pack is missing, or another
 * copy has the same version with different contents. Editing would regenerate its styles from the wrong pack.
 */
export function themePinProblem(state: { site: { themeId: string }; themeLock?: { theme?: { id: string; version: string; digest?: string } } }): string | null {
  const lock = state.themeLock?.theme;
  if (!lock?.digest) return null;
  const pack = findTheme(state.site.themeId);
  if (!pack) return `This project uses the theme "${lock.id}" ${lock.version}, which is not installed. Put that pack in the packs folder and restart SiteOrigin Builder to edit it.`;
  if (pack.version === lock.version && pack.digest !== lock.digest)
    return `This project uses the theme "${lock.id}" ${lock.version}, but the installed pack with that version is a different copy. Reinstall the copy the site was made with, or a newer version, and restart SiteOrigin Builder to edit it.`;
  return null;
}

export function catalogueComponent(themeId: string, componentId: string): ComponentDefinition | undefined {
  return getTheme(themeId).components.find((c) => c.componentId === componentId);
}

export interface CatalogueEntry {
  componentId: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  icon?: string;
  /** Option IDs on each variant axis. */
  axes: Record<string, string[]>;
}

export function catalogueEntries(themeId: string): CatalogueEntry[] {
  return getTheme(themeId)
    .components.filter((c) => c.category !== 'shell')
    .map((c) => ({
      componentId: c.componentId,
      name: c.name,
      description: c.description,
      category: c.category,
      tags: c.tags,
      icon: c.icon,
      axes: Object.fromEntries(Object.entries(c.variantAxes ?? {}).map(([axis, a]) => [axis, Object.keys(a.options)]))
    }));
}

export function searchCatalogue(themeId: string, query: string, limit = 10): CatalogueEntry[] {
  const q = query.toLowerCase().trim();
  const entries = catalogueEntries(themeId);
  if (!q) return entries.slice(0, limit);
  const words = q.split(/\s+/);
  return entries
    .map((e) => {
      const hay = `${e.name} ${e.description} ${e.tags.join(' ')} ${e.category} ${e.componentId}`.toLowerCase();
      const score = words.reduce((s, w) => s + (hay.includes(w) ? (e.name.toLowerCase().includes(w) ? 3 : 1) : 0), 0);
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.e);
}

export const CATEGORY_LABELS: Record<string, string> = {
  hero: 'Heroes & intros',
  content: 'Content',
  'social-proof': 'Social proof',
  conversion: 'Conversion',
  media: 'Media',
  layout: 'Layout',
  custom: 'Project components',
  primitive: 'Basics'
};
