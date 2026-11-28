import type { ComponentDefinition, NodeTree } from '@shared/types';
import { comparePackVersions, PACK_VERSION_RE, type ThemePack } from './pack';

export type { ThemePack } from './pack';

/**
 * The packs this app has loaded. Main loads and validates the installed releases once at startup, the editor
 * receives the same list before it first renders, and tests load the same committed releases; every lookup
 * below then stays synchronous.
 */
let registry: ThemePack[] = [];
let byId = new Map<string, ThemePack>();
let generation = 0;

/** How many times the packs have been replaced: what anything worked out from them was worked out under. */
export function packsGeneration(): number {
  return generation;
}

/** Replace the loaded packs. The first pack that is not a development fixture is the default theme. */
export function registerPacks(packs: ThemePack[]): void {
  const ids = new Set<string>();
  for (const p of packs) {
    if (ids.has(p.id)) throw new Error(`Two packs have the ID "${p.id}".`);
    ids.add(p.id);
  }
  registry = [...packs];
  byId = new Map(registry.map((p) => [p.id, p]));
  generation++;
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

/**
 * The layout a new collection's entries start with under this theme: the pack's own, or (for a pack without one)
 * the first loaded pack's that has one. Undefined only when no loaded pack has any.
 */
export function articleTemplateFor(themeId: string): NodeTree | undefined {
  return findTheme(themeId)?.articleTemplate ?? registry.find((p) => p.articleTemplate)?.articleTemplate;
}

/** What a project's theme lock records for this pack: an installed pack is pinned to its exact release. */
export function themeLockEntry(theme: ThemePack): { id: string; version: string; digest?: string } {
  return { id: theme.id, version: theme.version, ...(theme.source === 'user' && theme.digest ? { digest: theme.digest } : {}) };
}

/**
 * Why a project cannot be edited with the packs loaded here: its theme is not installed, or (for an installed
 * pack, which the lock pins) the installed copy is an older release, or another copy with the same version.
 * Generating it would restyle the site from the wrong pack before anyone edited anything.
 */
export function themePinProblem(state: { site: { themeId: string }; themeLock?: { theme?: { id: string; version: string; digest?: string } } }): string | null {
  const id = state.site.themeId;
  const lock = state.themeLock?.theme?.id === id ? state.themeLock.theme : undefined;
  const pack = findTheme(id);
  if (!pack) return `This project uses the theme "${id}"${lock ? ` ${lock.version}` : ''}, which is not installed. Install it (a built-in theme comes back by reinstalling SiteOrigin Builder) and restart SiteOrigin Builder to edit the project.`;
  // An installed pack is only used with the exact release the project recorded (theme.apply records it).
  if (pack.source === 'user' && !lock?.digest)
    return `This project uses the installed theme "${id}", but its theme lock does not record which copy. Switch to the theme again in a version of the project that records it, or restore siteorigin/theme-lock.json.`;
  // A project made with an installed pack whose ID a theme that ships with the app now has: the built-in theme is
  // another design under the same name, so it never stands in for the installed one.
  if (lock?.digest && pack.source !== 'user')
    return `This project uses an installed theme "${id}" ${lock.version}, but SiteOrigin Builder now has a built-in theme with that ID, which is a different design. Open the project in the version of SiteOrigin Builder it was made with and switch it to another theme to edit it here.`;
  if (!lock?.digest) return null;
  if (typeof lock.version !== 'string' || !PACK_VERSION_RE.test(lock.version))
    return `This project uses the theme "${id}", but its theme lock records "${lock.version}", which is not a release version. Restore siteorigin/theme-lock.json from the copy the site was made with to edit it here.`;
  const order = comparePackVersions(pack.version, lock.version);
  if (order === 0 && pack.digest !== lock.digest)
    return `This project uses the theme "${id}" ${lock.version}, but the installed pack with that version is a different copy. Reinstall the copy the site was made with, or a newer version, and restart SiteOrigin Builder to edit it.`;
  // An earlier release would restyle the site with an older design than the one it was made with (#1493).
  if (order < 0)
    return `This project needs "${id}" ${lock.version} or newer, but the installed copy is ${pack.version}, an older release. Install ${lock.version} or a newer release and restart SiteOrigin Builder to edit it.`;
  return null;
}

/**
 * The installed theme someone needs before they can edit this project in SiteOrigin Builder (#1477): its name, ID
 * and the release the project's theme lock records. Null for a theme that ships with the app, which every copy of
 * SiteOrigin Builder has.
 */
export function installedThemeRequirement(state: { site: { themeId: string }; themeLock?: { theme?: { id: string; version: string } } }): { id: string; name: string; version: string } | null {
  const pack = findTheme(state.site.themeId);
  if (pack?.source !== 'user') return null;
  const lock = state.themeLock?.theme?.id === pack.id ? state.themeLock.theme : undefined;
  return { id: pack.id, name: pack.name, version: lock?.version ?? pack.version };
}

/** What the author is told about the installed theme an editable export needs, once it is exported. */
export function installedThemeNote(theme: { id: string; name: string; version: string }): string {
  return `This project uses the installed theme ${theme.name} (${theme.id}) ${theme.version}. Anyone who opens it in SiteOrigin Builder needs that theme installed first, the same copy of ${theme.version} or a newer release, and restart SiteOrigin Builder, or the project opens read-only: send them a copy of the theme pack with it.`;
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
  /** A block (a feature card, a stat card): it goes inside a layout, not among a page's sections. */
  block?: true;
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
      axes: Object.fromEntries(Object.entries(c.variantAxes ?? {}).map(([axis, a]) => [axis, Object.keys(a.options)])),
      ...(c.insertAs === 'element' ? { block: true as const } : {})
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
