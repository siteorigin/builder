/**
 * The files of an isolated component preview (see @shared/component-preview): one component definition, from the
 * project or the theme catalogue, rendered on its own with chosen variants and sample property values. Editor-only:
 * the files are written to the dev cache and generateProject never makes any of them.
 */
import type { ComponentDefinition, InstanceNode, ProjectState } from '@shared/types';
import { isBinding } from '@shared/types';
import { PREVIEW_COMPONENT_STYLES, PREVIEW_MODULE, type ComponentPreviewSpec } from '@shared/component-preview';
import { axesOf } from '@shared/variants';
import { catalogueComponent } from '@catalogue/index';
import { installComponent } from '@engine/install';
import { normalizeProp } from '@engine/values';
import { RUNTIME_DIR, STYLES_DIR, FONTS_DIR, generateIsolatedInstance, generateLibrary, type FileMap } from './index';
import { iconsJs } from './runtime-files';

/** The ID of the one instance a preview shows. */
export const PREVIEW_NODE_ID = 'preview';

/** The identity context of a preview's markup (`data-so-ctx`), told apart from a page's ("page:…") and the shell's. */
export const previewCtx = (definitionId: string) => `preview:${definitionId}`;

export type ComponentPreview = { files: FileMap; definitionId: string; name: string } | { error: string };

/**
 * Every file a preview of `spec` needs, by its path inside the preview's folder (which mirrors the project's): the
 * preview module, which places one instance of the component, and a copy of the generated library it imports
 * (runtime helpers, component files, component styles). The library is the preview's own because the instance can
 * need what the project's lacks: a catalogue component the project does not have, the helpers it brings, an icon
 * only its sample values name. The site's tokens and base styles come from the project itself (see
 * PREVIEW_PROJECT_STYLES), with the fonts they load. `state` is never changed.
 */
export function generateComponentPreview(state: ProjectState, spec: ComponentPreviewSpec): ComponentPreview {
  const named = [spec.definitionId, spec.componentId].filter((v) => v !== undefined);
  if (named.length !== 1 || typeof named[0] !== 'string') return { error: 'Name one component to preview: a component definition ID, or a catalogue component ID.' };
  let shown = state;
  let def: ComponentDefinition | undefined;
  if (spec.definitionId !== undefined) {
    def = Object.hasOwn(state.components, spec.definitionId) ? state.components[spec.definitionId] : undefined;
    if (!def) return { error: `The project has no component "${spec.definitionId}".` };
  } else {
    const source = catalogueComponent(state.site.themeId, spec.componentId!);
    if (!source) return { error: `The theme has no component "${spec.componentId}".` };
    // A catalogue component the project does not have yet is shown as adding it would make it: copied, with what it
    // depends on, into a copy of the documents that holds only the new components beside the project's own.
    if (!Object.hasOwn(state.components, source.id)) {
      shown = { ...state, components: { ...state.components }, themeLock: { ...state.themeLock, components: { ...state.themeLock.components } } };
      installComponent(shown, spec.componentId!);
    }
    def = shown.components[source.id];
  }
  if (def.kind === 'managed' ? !def.tree : !def.source) return { error: `"${def.name}" has nothing to show yet.` };

  const variants: Record<string, string> = {};
  const axes = new Map(axesOf(def));
  for (const [axis, option] of Object.entries(spec.variants ?? {})) {
    const a = axes.get(axis);
    if (!a) return { error: `"${def.name}" has no variant axis "${axis}".` };
    if (typeof option !== 'string' || !Object.hasOwn(a.options, option)) return { error: `"${def.name}" has no option "${String(option)}" on its ${a.label} variant.` };
    variants[axis] = option;
  }

  // Sample values are checked and stored as an edit to a placement would store them; the rest keep their defaults.
  const props: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(spec.props ?? {})) {
    const schema = Object.hasOwn(def.properties, name) ? def.properties[name] : undefined;
    if (!schema) return { error: `"${def.name}" has no property "${name}".` };
    if (isBinding(value)) return { error: `${def.name} → ${schema.label}: a sample value cannot be bound to a property.` };
    try {
      props[name] = normalizeProp(schema, value, shown, `${def.name} → ${schema.label}`);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  const node: InstanceNode = { id: PREVIEW_NODE_ID, kind: 'instance', definitionId: def.id, props, ...(Object.keys(variants).length ? { variants } : {}) };
  const files: FileMap = new Map();
  for (const [path, content] of generateLibrary(shown, { instrument: true })) {
    // Tokens, base styles and fonts are the project's own; page styles belong to pages.
    if (path.startsWith(`${FONTS_DIR}/`) || (path.startsWith(`${STYLES_DIR}/`) && path !== PREVIEW_COMPONENT_STYLES)) continue;
    files.set(path, content);
  }
  files.set(`${RUNTIME_DIR}/icons.js`, iconsJs(shown, node.props));
  files.set(PREVIEW_MODULE, generateIsolatedInstance(shown, PREVIEW_MODULE, node, previewCtx(def.id)));
  return { files, definitionId: def.id, name: def.name };
}
