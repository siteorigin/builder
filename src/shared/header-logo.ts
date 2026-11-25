/**
 * The shared header's logo size (#576) only means something once the header shows a logo, so its Content leaves the
 * choice out until a logo is chosen. Clearing the logo keeps the size it was given, ready for the next one.
 */
import type { ComponentDefinition, ProjectState } from './types';

/** The header property that holds the logo's size. */
export const LOGO_SIZE_PROP = 'logoSize';

/** A header design with a logo and a size for it: the shared header, or a copy of it made unique. */
function sizesLogo(def: ComponentDefinition): boolean {
  if (def.componentId !== 'shell.header' && def.provenance?.componentId !== 'shell.header') return false;
  return def.properties.logo?.type === 'image' && def.properties[LOGO_SIZE_PROP]?.type === 'enum';
}

/** The properties a header placement leaves out of its Content: the logo's size while it shows no logo. */
export function headerHiddenProps(state: ProjectState, def: ComponentDefinition | undefined, props: Record<string, unknown>): string[] {
  if (!def || !sizesLogo(def)) return [];
  const logo = (Object.hasOwn(props, 'logo') ? props.logo : undefined) ?? def.properties.logo.default;
  const assetId = logo && typeof logo === 'object' ? (logo as { assetId?: unknown }).assetId : undefined;
  const shown = typeof assetId === 'string' && Object.hasOwn(state.assets.assets, assetId) && state.assets.assets[assetId].kind === 'image';
  return shown ? [] : [LOGO_SIZE_PROP];
}
