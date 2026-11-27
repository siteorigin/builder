/**
 * The themes in tests, and the designs tests write for themselves.
 *
 * Every test file starts with the theme releases committed in `resources/` registered as the app registers them at
 * startup (tests/unit/setup.ts): Foundation and its development fixture, whose components are Svelte code components.
 * A test of what the editor does with a managed design (a tree of elements with parts, slots, repeats and variants)
 * writes the design it needs with the authoring DSL, here, on the loaded Foundation's tokens:
 *
 * - `projectDesign` adds one to a project as the project's own design, beside Foundation's sections;
 * - `FOUNDATION_AUTHOR` stamps one as Foundation's (`foundation.<componentId>`), for a test of a theme-owned design;
 * - `testPack` and `registerBeside` make a small pack of the test's own designs and register it beside the releases,
 *   for a test that needs one in the catalogue (Insert, installing by component ID, a theme switch).
 */
import { resolve } from 'node:path';
import type { ComponentDefinition, ProjectState } from '@shared/types';
import { createPack, type ComponentSpec, type PackAuthor } from '@catalogue/dsl';
import { getTheme, listThemes, registerPacks } from '@catalogue/index';
import type { AuthoredPack, PackMeta, ThemePack } from '@catalogue/pack';
import { buildPack, fileSource } from '../../../src/main/packs/build';
import { registerPackFiles } from '../../../src/main/packs/files';
import { loadBundledPacks } from '../../../src/main/packs/installed';

/** The repository root, which holds the committed releases under `resources/`. */
export const ROOT = resolve(import.meta.dirname, '..', '..', '..');

/** Register the committed releases again, alone, as setup registered them: for a test that registered packs of its own. */
export function restorePacks(): Promise<ThemePack[]> {
  return loadBundledPacks(ROOT);
}

/** A loaded pack's identity and design data (tokens, contrast pairs, base CSS, profile), as an author's, with no fonts. */
export function metaOf(pack: ThemePack, over: Partial<PackMeta> = {}): PackMeta {
  const { components: _c, previews: _p, digest: _d, source: _s, fonts: _f, ...meta } = pack;
  void _c;
  void _p;
  void _d;
  void _s;
  void _f;
  return { ...meta, fonts: [], ...over };
}

/** Writes managed designs as Foundation's own, on the loaded release's tokens. */
export const FOUNDATION_AUTHOR: PackAuthor = createPack(metaOf(getTheme('foundation')));

/** The spec of a design, with what a test rarely cares about filled in. */
export type DesignSpec = Omit<ComponentSpec, 'category' | 'tags' | 'icon' | 'description'> & Partial<Pick<ComponentSpec, 'category' | 'tags' | 'icon' | 'description'>>;

const filled = (spec: DesignSpec): ComponentSpec => ({ category: 'content', tags: [], icon: 'square', description: '', ...spec });

/** A managed design stamped as Foundation's, not added anywhere. */
export function foundationDesign(spec: DesignSpec): ComponentDefinition {
  return FOUNDATION_AUTHOR.managed(filled(spec));
}

/** Add a managed design to the project as its own (`owner: 'project'`), and return it. */
export function projectDesign(state: ProjectState, spec: DesignSpec): ComponentDefinition {
  const def: ComponentDefinition = { ...FOUNDATION_AUTHOR.managed(filled(spec)), owner: 'project' };
  state.components[def.id] = def;
  return def;
}

/** An author for a small pack of a test's own, on Foundation's tokens under its own identity. */
export function testPack(id: string, over: Partial<PackMeta> = {}): PackAuthor {
  return createPack(metaOf(getTheme('foundation'), { id, name: id, description: `The ${id} test pack.`, version: '1.0.0', devOnly: undefined, ...over }));
}

/** Register these authored packs after the ones already loaded, with their files; returns them as registered. */
export function registerBeside(...authored: AuthoredPack[]): ThemePack[] {
  const built = authored.map((a) => buildPack(a, ROOT));
  registerPacks([...listThemes(), ...built.map((b) => b.pack)]);
  for (const { pack, files } of built) registerPackFiles(pack.id, new Map([...files].map(([k, abs]) => [k, fileSource(abs)])));
  return built.map((b) => b.pack);
}
