/**
 * The files of an isolated component preview (see @shared/component-preview): one component definition, from the
 * project or the theme catalogue, rendered on its own with chosen variants and sample property values. Editor-only:
 * the files are written to the dev cache and generateProject never makes any of them.
 */
import type { ComponentDefinition, InstanceNode, ListItem, ProjectState, UiStateSchema } from '@shared/types';
import { isBinding } from '@shared/types';
import { PREVIEW_COMPONENT_STYLES, PREVIEW_META, PREVIEW_MODULE, PREVIEW_NODE_ID, previewCtx, type ComponentPreviewSpec } from '@shared/component-preview';
import { axesOf } from '@shared/variants';
import { siteDirection, siteLanguage } from '@shared/languages';
import { catalogueComponent } from '@catalogue/index';
import { namesFormFields } from '@shared/form-contract';
import { defaultProps, installComponent } from '@engine/install';
import { declaredState, stateValueFits } from '@engine/schema';
import { normalizeProp } from '@engine/values';
import { placementContent } from '@engine/tree';
import { formDefaults, settleFormKeys } from '@engine/form-keys';
import { RUNTIME_DIR, STYLES_DIR, FONTS_DIR, generateIsolatedInstance, generateLibrary, type FileMap } from './index';
import { iconsJs } from './runtime-files';

export { PREVIEW_NODE_ID, previewCtx };

/**
 * The design's starting values, its lists' items under their own IDs (see generateComponentPreview). An item a
 * hand-edited document left without an ID, or with one another item has, gets one of the preview's own, the same in
 * every preview of it, so each still renders as its own item.
 */
function startingProps(def: ComponentDefinition): Record<string, unknown> {
  return settleRows(def, defaultProps(def));
}

/** `props` with each list's rows given IDs of their own where they lack one (or share one), as startingProps says. */
function settleRows(def: ComponentDefinition, props: Record<string, unknown>): Record<string, unknown> {
  for (const [name, schema] of Object.entries(def.properties)) {
    if (schema.type !== 'list' || !Array.isArray(props[name])) continue;
    const rows = (props[name] as unknown[]).map((it) => (it && typeof it === 'object' ? it : {}) as ListItem);
    // Every ID a row really has is its own (the first of two that share one); the rest take ones nobody has.
    const own = new Set<string>();
    const keeps = rows.map((r) => typeof r.id === 'string' && !!r.id && !own.has(r.id) && !!own.add(r.id));
    const taken = new Set(own);
    props[name] = rows.map((item, i) => {
      if (keeps[i]) return item;
      let n = i;
      while (taken.has(`preview-item-${n}`)) n++;
      const id = `preview-item-${n}`;
      taken.add(id);
      return { ...item, id };
    });
  }
  return props;
}

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
  if (named.length !== 1 || typeof named[0] !== 'string') return { error: 'Name one component to preview: a component definition ID, or a catalog component ID.' };
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

  // UI state previewed at another value (a hidden tab chosen, a drawer open): the preview's own copy of the design
  // starts there, so the component file it generates shows it. The project's design is never changed.
  const started: Record<string, boolean | string | number> = {};
  for (const [name, value] of Object.entries(spec.states ?? {})) {
    const declared = def.kind === 'managed' ? declaredState(def, name) : undefined;
    if (!declared) return { error: `"${def.name}" has no UI state "${name}".` };
    const fits = stateValueFits(declared, value);
    if (!fits) return { error: `"${def.name}" → ${declared.label || name}: ${JSON.stringify(value)?.slice(0, 80)} is not one of its values.` };
    if (value !== declared.initial) started[name] = value;
  }
  if (Object.keys(started).length) {
    const state = { ...def.state } as Record<string, UiStateSchema>;
    for (const [name, value] of Object.entries(started)) state[name] = { ...state[name], initial: value } as UiStateSchema;
    def = { ...def, state };
    shown = { ...shown, components: { ...shown.components, [def.id]: def } };
  }

  // Made as inserting it on a page makes a placement, but with the design's own list items, under their own IDs: the
  // same in every preview of it, so an item picked in Component Studio is still there after the next edit. Then the
  // sample values checked and stored as an edit stores them, and the fields of a new form given keys of their own.
  let pageId: string | undefined;
  const node: InstanceNode = { id: PREVIEW_NODE_ID, kind: 'instance', definitionId: def.id, props: startingProps(def), ...(Object.keys(variants).length ? { variants } : {}) };
  if (spec.placement) {
    if (spec.props) return { error: 'Show either a placement’s content or sample values, not both.' };
    if (spec.definitionId === undefined) return { error: 'Only a component of the project’s own has placements to show the content of.' };
    // Its content as it is saved, as its page shows it (a picture whose file is gone included), over the starting
    // values; a placement gone since shows the starting content.
    const own = placementContent(state, def.id, spec.placement);
    if (own) {
      // A hand-edited list (rows without IDs) is settled as the starting content's is, so each row is its own.
      node.props = settleRows(def, { ...node.props, ...structuredClone(own.props) });
      // A list connected to a collection shows the entries it finds, and computed lists are worked out for its page.
      if (own.listSources) node.listSources = structuredClone(own.listSources);
      pageId = own.pageId;
    }
  }
  for (const [name, value] of Object.entries(spec.props ?? {})) {
    const schema = Object.hasOwn(def.properties, name) ? def.properties[name] : undefined;
    if (!schema) return { error: `"${def.name}" has no property "${name}".` };
    if (isBinding(value)) return { error: `${def.name} → ${schema.label}: a sample value cannot be bound to a property.` };
    try {
      node.props[name] = normalizeProp(schema, value, shown, `${def.name} → ${schema.label}`);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
  if (Array.isArray(node.props.fields) && spec.props && 'fields' in spec.props && namesFormFields(def)) node.props.fields = settleFormKeys([], node.props.fields as ListItem[], new Set(), formDefaults(def));

  const files: FileMap = new Map();
  for (const [path, content] of generateLibrary(shown, { instrument: true, previewOpen: def.id })) {
    // Tokens, base styles and fonts are the project's own; page styles belong to pages.
    if (path.startsWith(`${FONTS_DIR}/`) || (path.startsWith(`${STYLES_DIR}/`) && path !== PREVIEW_COMPONENT_STYLES)) continue;
    files.set(path, content);
  }
  files.set(`${RUNTIME_DIR}/icons.js`, iconsJs(shown, node.props));
  files.set(PREVIEW_MODULE, generateIsolatedInstance(shown, PREVIEW_MODULE, node, previewCtx(def.id), pageId));
  // What the preview's page needs to know of the site: the language its text is in, and the way that text runs.
  files.set(PREVIEW_META, JSON.stringify({ lang: siteLanguage(shown.site), dir: siteDirection(shown.site) }));
  return { files, definitionId: def.id, name: def.name };
}
