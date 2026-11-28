import { z } from 'zod';
import type { AssetRecord, ComponentDefinition, ElementRef, OwnerRef, ProjectState } from '@shared/types';
import type { ChatImageRef, FieldLocation, InspectLayoutOptions } from '@shared/api';
import type { EditOperation, ToolError } from '@shared/ops';
import { EditOperationSchema, LAYOUT_BINDING, legacyShellError, MODEL_BINDING, OPERATION_SCHEMAS, propertiesHash, type OperationType } from '@shared/ops';
import { BLUR_LIMITS, MAX_GRID_TRACKS, STYLE_PROPS, TRANSLATE_LIMITS, type StylePropDef } from '@shared/styles';
import { addressSlug, normalizeRoute } from '@shared/routes';
import { FOCUSED_WINDOW_TOKENS } from '@shared/tokens';
import { catalogueComponent, searchCatalogue } from '@catalogue/index';
import { ICONS } from '@shared/icons';
import { sourceHash } from '@engine/apply';
import type { Diagnostic } from '@engine/validate';
import type { ModelCapabilities, ToolDefinition } from './types';
import { colorSchemeMode } from '@shared/color-scheme';
import { agentProps, catalogueIndex, compactNode, componentDetail, componentStructure, layoutDetail, layoutTree, pageDetail, pageIdFor, projectSummary, readField, selectionAbridged, tokensSummary } from './context';
import { AUDIT_SEO_ARGS, seoReport } from './seo-report';
import { getTree, findParent, displayName, instancesOf, subtreeIds } from '@engine/tree';
import { newMacroMemory, runUpsert, UPSERT_ARGS, UPSERT_BRIEF, UPSERT_DESCRIPTION, upsertToolSchema, type MacroMemory } from './macros';
import { BRAND_ARGS, BRAND_BRIEF, BRAND_DESCRIPTION, brandToolSchema, runBrand } from './brand';
import { PAGE_SEO_ARGS, PAGE_SEO_BRIEF, PAGE_SEO_DESCRIPTION, pageSeoToolSchema, runPageSeo, runSiteSeo, SITE_SEO_ARGS, SITE_SEO_BRIEF, SITE_SEO_DESCRIPTION, siteSeoToolSchema } from './seo-tools';
import { CONNECT_LIST_ARGS, CONNECT_LIST_BRIEF, CONNECT_LIST_DESCRIPTION, connectListSchema, runConnectList } from './collection-lists';
import { hasSources, INSPECT_SOURCE_ARGS, INSPECT_SOURCE_BRIEF, INSPECT_SOURCE_DESCRIPTION, runInspectSource, runWriteSource, WRITE_SOURCE_ARGS, WRITE_SOURCE_BRIEF, WRITE_SOURCE_DESCRIPTION, type SourceToolHost } from './source-tools';
import { collectionToolSchemas, DEFINE_COLLECTION_ARGS, DEFINE_COLLECTION_BRIEF, DEFINE_COLLECTION_DESCRIPTION, defineCollectionSchema, runDefineCollection, UPSERT_PINNED_ENTRY_BRIEF, UPSERT_PINNED_ENTRY_DESCRIPTION, LIST_ENTRIES_ARGS, LIST_ENTRIES_BRIEF, LIST_ENTRIES_DESCRIPTION, READ_ENTRY_ARGS, READ_ENTRY_BRIEF, READ_ENTRY_DESCRIPTION, runListEntries, runReadEntry, runUpsertEntry, UPSERT_ENTRY_ARGS, UPSERT_ENTRY_BRIEF, UPSERT_ENTRY_DESCRIPTION } from './collection-tools';
import { PROJECT_SECTIONS } from './budget';
import { hasCode } from '@shared/site-code';
import { hasCollections } from '@shared/entry-feed';
import { MANAGED_COMPONENT_ARGS, MANAGED_COMPONENT_BRIEF, MANAGED_COMPONENT_DESCRIPTION, managedComponentSchema, runManagedComponent } from './managed-component';
import { runSelectionTool, SELECTION_ARGS, SELECTION_BRIEFS, SELECTION_DESCRIPTIONS, selectionTakesBackground, selectionTools, type SelectionTarget } from './selection';
import { DEFINITION_ARGS, DEFINITION_BRIEFS, DEFINITION_DESCRIPTIONS, definitionAbridged, definitionTools, runDefinitionTool, type DefinitionTarget, type DefinitionToolName } from './definition';
import { examplesFor, exampleSection } from './examples';
import { locateField } from '@engine/locate';
import { CODE_OPERATIONS, developerModeReason } from '@engine/developer-mode';
import { changedComponents, componentWarnings, introducedReusability } from './reusability';
import { runValidateProject, VALIDATE_ARGS, VALIDATE_BRIEF, VALIDATE_DESCRIPTION, VALIDATE_FOCUSED_BRIEF } from './validation';
import { OP_REACH, type AuthorityGrants, type RequestedScope } from './scope';
import { digestComponentInspection, inspectionSteps, MAX_CASES, planComponentInspection, resolveInspectTarget } from './component-inspection';
import type { ComponentPreviewResult, ComponentPreviewStep } from '@shared/component-preview';
import type { PreviewControlResult, PreviewControlSettings } from '@shared/preview-control';
import type { LayoutOwner } from '@shared/collection-grant';
import { LAYOUT_TARGET, MAX_LAYOUT_TARGETS, resolveLayoutTargets, targetRef } from './layout-targets';
import { answered, applyFailure, MAX_RESULT_CHARS, stamp, toolError, type ResultOutcome, type ToolOutcome } from './result';
import { runUpdateThemeComponent, themeUpdateNote, UPDATE_THEME_COMPONENT_ARGS, UPDATE_THEME_COMPONENT_BRIEF, UPDATE_THEME_COMPONENT_DESCRIPTION, updateThemeComponentTool, wholeSelection, type UpdateReach } from './theme-update';

const owner = z.object({ kind: z.enum(['page', 'shell', 'component', 'template', 'archive']), id: z.string() });

/** What a mutating call asks to change (spec 13.3), checked against what the request may change. */
const REQUESTED_SCOPE = z.object({
  kind: z.enum(['selection', 'page', 'component', 'site']),
  targetIds: z.array(z.string()).optional().describe('One pageId, definitionId or node ID; none for site.')
});
const SCOPE_NOTE = 'What this call changes. Wider than the request may change is refused; narrower limits the call.';

/** The preview widths the toolbar takes (renderer lib/layout VIEWPORT_LIMITS). */
const VIEWPORT_WIDTHS = { min: 240, max: 2560 };
/** The most History steps one step_history call takes. */
const MAX_HISTORY_STEPS = 10;

/** The most operations one apply_operations call takes. */
export const MAX_BATCH_OPERATIONS = 30;

export const TOOL_ARGS = {
  read_project: z.object({ sections: z.array(z.enum(PROJECT_SECTIONS)).optional() }),
  read_page: z.object({ pageId: z.string(), nodeId: z.string().optional().describe('Optional subtree to read.') }),
  inspect_element: z.object({
    owner,
    nodeId: z.string(),
    prop: z.string().optional().describe('Read one content field whole instead of the node: a property of a placed component, or "text" for a text element.'),
    itemId: z.string().optional().describe('With prop, for a list: the item whose field to read.'),
    field: z.string().optional().describe('With prop and itemId: the field of that item.'),
    offset: z.number().int().min(0).optional().describe('With prop: where to go on reading a long value, from the next a previous read returned.')
  }),
  search_components: z.object({ query: z.string().describe('Words such as "pricing", "team", "image text".'), limit: z.number().int().min(1).max(20).optional() }),
  read_component: z.object({
    componentId: z.string().optional(),
    definitionId: z.string().optional(),
    structure: z.boolean().optional().describe('Its design too.'),
    offset: z.number().int().min(0).optional().describe('With structure: next, from the last read.')
  }),
  search_assets: z.object({ query: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
  apply_operations: z.object({
    expectedRevision: z.number().int().describe('The revision you last read. Mismatches are rejected; read again and retry.'),
    scope: REQUESTED_SCOPE.optional().describe(SCOPE_NOTE),
    operations: z.array(EditOperationSchema).min(1).max(MAX_BATCH_OPERATIONS)
  }),
  read_source: z.object({ definitionId: z.string(), startLine: z.number().int().min(1).optional(), endLine: z.number().int().optional() }),
  apply_source_patch: z.object({
    definitionId: z.string(),
    expectedRevision: z.number().int().describe('The revision read_source returned. On a mismatch, read it again.'),
    expectedHash: z.string().describe('Hash returned by read_source.'),
    scope: REQUESTED_SCOPE.describe(`${SCOPE_NOTE} From a selection, only code placed nowhere else: component.convertToCode the selected placement, then patch the copy.`),
    edits: z.array(z.object({ find: z.string(), replace: z.string() })).optional().describe('Exact text replacements applied in order. Each find must match exactly once.'),
    source: z.string().optional().describe('Full replacement source, instead of edits.'),
    properties: z.record(z.string(), z.unknown()).optional().describe('The whole new property schema, when the code takes other properties.'),
    expectedPropertiesHash: z.string().optional().describe('With properties: the propertiesHash read_source returned.'),
    renames: z
      .array(z.object({ from: z.string(), to: z.string() }))
      .max(60)
      .optional()
      .describe('With properties: renamed ones; placements keep their values.')
  }),
  inspect_layout: z.object({
    pageId: z.string(),
    viewport: z.enum(['phone', 'tablet', 'desktop']),
    refs: z
      .array(LAYOUT_TARGET)
      .min(1)
      .max(MAX_LAYOUT_TARGETS)
      .optional()
      .describe("Findings' refs: measure only those elements. Omit for the whole page.")
  }),
  inspect_component: z.object({
    definitionId: z.string().optional().describe('A component of the project.'),
    componentId: z.string().optional().describe('Or a theme catalog component, whether or not the project has it yet.'),
    owner: owner.optional().describe('Or, with nodeId, a placement: its own content and variant choices are the starting point.'),
    nodeId: z.string().optional(),
    offset: z.number().int().min(0).optional().describe('Continue a sweep: the offset a previous call returned in next.')
  }),
  validate_project: VALIDATE_ARGS,
  audit_seo: AUDIT_SEO_ARGS,
  request_clarification: z.object({
    question: z.string().min(1).max(300),
    choices: z.array(z.string().max(80)).max(4).optional(),
    assetIds: z
      .array(z.string())
      .max(4)
      .optional()
      .describe('Library images to offer as choices, by the assetId search_assets returns. The user sees each picture and its name; the answer names the chosen assetId.'),
    widenScope: z.boolean().optional().describe('Set true to ask permission to change more than the selected element. The app shows yes/no choices; on yes, the run may change anything.')
  }),
  locate_field: z.object({
    owner,
    nodeId: z.string().describe('The placed component (an instance node ID from read_page).'),
    prop: z.string().describe('Its property, as read_page shows it, for example "items".'),
    itemId: z.string().optional().describe('For a list property: the id of one item.'),
    field: z.string().optional().describe('For a list property: the field of that item, for example "value".')
  }),
  upsert_page_with_sections: UPSERT_ARGS,
  update_site_brand: BRAND_ARGS,
  update_page_seo: PAGE_SEO_ARGS,
  update_site_seo: SITE_SEO_ARGS,
  upsert_managed_component: MANAGED_COMPONENT_ARGS,
  list_collection_entries: LIST_ENTRIES_ARGS,
  read_collection_entry: READ_ENTRY_ARGS,
  upsert_collection_entry: UPSERT_ENTRY_ARGS,
  define_collection: DEFINE_COLLECTION_ARGS,
  connect_collection_list: CONNECT_LIST_ARGS,
  inspect_source_sample: INSPECT_SOURCE_ARGS,
  write_source_converter: WRITE_SOURCE_ARGS,
  read_layout: z.object({ nodeId: z.string().optional().describe('Optional subtree to read.') }),
  update_theme_component: UPDATE_THEME_COMPONENT_ARGS,
  set_preview: z.object({
    viewport: z.enum(['desktop', 'tablet', 'phone']).optional().describe('A width preset: desktop 1280px, tablet 834px, phone 390px.'),
    width: z.number().int().min(VIEWPORT_WIDTHS.min).max(VIEWPORT_WIDTHS.max).optional().describe('Or a width in CSS px.'),
    scheme: z.enum(['light', 'dark', 'system']).optional().describe("Preview colors: the site's light or dark palette, or this computer's setting."),
    mode: z.enum(['edit', 'preview']).optional().describe('edit: click to select and change; preview: use the site as a visitor would.')
  }),
  step_history: z.object({
    direction: z.enum(['undo', 'redo']),
    steps: z.number().int().min(1).max(MAX_HISTORY_STEPS).optional().describe('How many History steps, 1 unless the user asks for more.')
  }),
  ...SELECTION_ARGS,
  ...DEFINITION_ARGS
} as const;

export type ToolName = keyof typeof TOOL_ARGS;

const CONTRACT_READ = 'Read a component contract: property schema, parts, variants, slots and examples. Use before inserting or editing an unfamiliar component.';

const DESCRIPTIONS: Record<ToolName, string> = {
  read_project: 'Project summary: revision, pages (IDs and routes), shared header/footer, project components. Optional sections add site tokens, the theme catalog (every component with its compact property signature, style parts and variants, plus the valid icon names), the installed components, or the site\'s own head code and custom CSS in full (siteCode, read alone: read it before replacing either with site.update).',
  read_page: 'Read a page: its sections and their component instances, props (with list item IDs), variants, style overrides and nested content.',
  inspect_element:
    'Inspect one node: full props, the component property schema, public parts with allowed style controls, variants, slots and its position in the tree. With prop, read one content field whole instead (long rich text as Markdown), a part at a time: call again with the offset each part returns until next is null.',
  search_components: 'Search the theme catalog and project components by keywords. Returns componentIds or definitionIds you can insert with node.insert.',
  read_component: `${CONTRACT_READ} structure adds how its design is built.`,
  search_assets: 'List imported images by name and description, with the assetId that identifies each one (two images can share a name). You cannot see image contents.',
  apply_operations:
    'Apply a batch of typed edit operations atomically. Every operation is validated; on error nothing in the batch is applied and you get the exact problem. Operations refer to pages by ID: to fill a page you create, use the pageId this call returns in your next step. Call it at most once per step (one response of yours); the request carries on in your next step without the user replying.',
  read_source: "Read a component's Svelte source, with the properties of one that can be patched. Generated managed sources are read-only; a theme's code is patched on a project copy (component.fork); project code components can be patched.",
  apply_source_patch: 'Change the source of a project code component (never generated files, config or dependencies), and its properties with it. Requires the revision and hash read_source returned with it.',
  inspect_layout:
    'Measure a page in the live preview at a viewport width: overflow, images (report.images; unverified ones were still loading, not a site problem), alt text, headings, runtime errors, and readability (counts in report.checks): text contrast against its painted background, overlapping boxes, cut-off text, tap targets under 44px below 768px. Each finding\'s ref is the owner, nodeId, partId and itemId node.setStyle takes; Pass refs to re-measure those elements: report.targets has each one\'s box, scroll size and visibility, beside the findings inside them (targets: which, by index). contrast-unverified is text only pixels could judge (over an image). On a page of two or more sections, report.rhythm is advice on composition (never an error): three or more sections in a row with one layout on one background (at phone width, only sections that keep columns side by side) or each with a filled button, and an inner heading as large as the h1, each with the refs of the sections or headings to vary. No screenshots.',
  inspect_component:
    'Check one component on its own, off-screen, without changing anything: it is measured at phone (390px) and desktop (1280px) width with every link set and empty text filled, in each option of every variant axis, and with stress content: long text with an unbroken long word, links and optional text left empty, one and five list items. Returns each overflow, cut-off text, low contrast, overlap, small tap target, runtime error and spacing collapse once, with the cases and widths it showed in and where it is in the design: at.nodeId is the node of its design (node.setStyle { owner: { kind: "component", id: definitionId }, nodeId } changes it on every placement) and at.partId the part it belongs to. The design of a theme component changes on a project copy: component.fork it first (one the project does not have yet is added by placing it) and use the definitionId that returns. A clean component gets a one-line summary. Use after building or changing a reusable component, then fix what it finds and check again.',
  validate_project: VALIDATE_DESCRIPTION,
  audit_seo:
    'Audit how well the website can be found, shared and understood by search engines, link previews and AI agents, from the saved project (it changes and measures nothing): its public URL, search settings, browser titles and descriptions (missing, repeated, too short or long), sharing image and icon, link wording, pages no other page links to, and the pictures and headings in collection entries. Returns findings most serious first, each with its code, pillar, whether an edit of yours can fix it (aiFixable) and where it is fixed (fix), why it matters (reason, an index into reasons), counts by severity and pillar, and the internal links: how many links lead into and out of each published page, with orphans that nothing else links to. pageId (an ID or route) narrows it to one page: its own findings, and which pages, shared header or footer, or entries link to it. pillar keeps one kind of finding. A long report comes in parts: call again with offset set to nextOffset, or linkOffset set to links.nextLinkOffset, and after a change to the site start again from the first part.',
  request_clarification:
    'Ask the user one question and wait for the answer. Use it when the user asks you to interview them, ask them something or let them choose; whenever you would offer them a few options to pick from (instead of listing the options in your reply); and when a request is ambiguous enough that a wrong guess would change shared content. Put up to four concrete answers in choices, never “Other”; the user can type their own. To let the user choose between library images, pass their assetIds instead of naming them in choices: the user sees the pictures, which you cannot. One question per call: ask the next one after the answer comes back.',
  locate_field:
    'Find where the author changes one content field in the editor. Returns its current value and the exact labels the Inspector shows on the way to it (page, component, Content, then the field or the list, its item and the field), and gives the author an "Open in inspector" button for it.',
  upsert_page_with_sections: UPSERT_DESCRIPTION,
  update_site_brand: BRAND_DESCRIPTION,
  update_page_seo: PAGE_SEO_DESCRIPTION,
  update_site_seo: SITE_SEO_DESCRIPTION,
  upsert_managed_component: MANAGED_COMPONENT_DESCRIPTION,
  list_collection_entries: LIST_ENTRIES_DESCRIPTION,
  read_collection_entry: READ_ENTRY_DESCRIPTION,
  upsert_collection_entry: UPSERT_ENTRY_DESCRIPTION,
  define_collection: DEFINE_COLLECTION_DESCRIPTION,
  connect_collection_list: CONNECT_LIST_DESCRIPTION,
  inspect_source_sample: INSPECT_SOURCE_DESCRIPTION,
  write_source_converter: WRITE_SOURCE_DESCRIPTION,
  read_layout: "Read the collection layout this request may change, as it is now: its sections with their props, styles, bindings and nested content, or one node's subtree. Its owner is the layout's, for every operation.",
  update_theme_component: UPDATE_THEME_COMPONENT_DESCRIPTION,
  set_preview:
    "Change the editor's own preview controls, as the toolbar does: the canvas width (viewport preset or width), the preview colors (scheme; dark needs a site with a dark palette) and Edit or Preview mode (mode). Name only the settings the user asks for. It changes nothing on the site and records nothing in History. Returns what the controls now show (now) and any setting the editor could not change, with why (refused). It is not a measurement: inspect_layout checks a page at a width.",
  step_history:
    "Undo or redo the author's recent changes in the editor's History, exactly as the toolbar's Undo and Redo do: undo takes back the latest change (the author's own or an AI request's), redo puts back the latest undone one; steps takes several at once. <editor_context> history says which change each would step now: when the user names a different change, do not call it, and say which change Undo would take back. Call it only when the user asks to undo, redo, revert or put back a change, and before changing anything else: it is the request's one change, and nothing more can be changed after it. Returns the step's label. To take back an older change with later ones left in place, do not use it: make that change again with the editing tools.",
  ...SELECTION_DESCRIPTIONS,
  ...DEFINITION_DESCRIPTIONS
};

/**
 * The descriptions' rules in fewer words, for a grammar-constrained local model (see `ToolDefinition.brief`). Empty:
 * the name and signature say it all. A tool missing here keeps its description.
 */
const BRIEFS: Partial<Record<ToolName, string>> = {
  read_project: 'Revision, pages (IDs and routes), header/footer and project components. sections adds tokens, the catalog (components with properties, parts, variants; icon names), installed components, or siteCode alone (the site\'s head code and custom CSS in full).',
  read_page: 'Its sections with props (and list item IDs), variants, styles and nested content.',
  inspect_element: 'One node: props, property schema, parts with their style controls, variants, slots and place in the tree. With prop, one content field whole (rich text as Markdown), a part at a time: call again with each offset returned until next is null.',
  search_components: 'Theme and project components by keywords, with their IDs.',
  read_component: "A component's property schema, parts, variants, slots and examples. Read it before using an unfamiliar component.",
  search_assets: 'Images by name and description, each with its assetId (names can repeat). You cannot see images.',
  read_source: "A component's Svelte source. Only project code components can be patched: a theme's code on a project copy (component.fork).",
  apply_source_patch: 'Change a project code component (never generated files, config or dependencies) and its properties, with the revision and hash from read_source.',
  inspect_layout: 'Measure a page in the live preview at a width: overflow, off-screen elements, whether each image loaded (unverified ones were still loading, which is fine), missing alt text, headings and runtime errors. Structure only, no screenshots. refs (findings\' refs): just those elements, each\'s box in report.targets.',
  inspect_component: 'Measure a component on its own at phone and desktop width, in every variant option and with long, empty and repeated content: overflow, cut-off text, contrast, overlaps and collapsed spacing, each with where it is in the design. Changes nothing.',
  validate_project: VALIDATE_BRIEF,
  audit_seo: 'SEO and AI-readiness findings, worst first, and each page’s links in and out. pageId (ID or route) or pillar narrows it. More: offset=nextOffset, linkOffset=nextLinkOffset.',
  request_clarification:
    'Ask the user one question and wait for the answer: when they ask you to interview them, ask them something or let them choose, when you would offer options (never list them in your reply instead), or when a wrong guess would change shared content. Up to four short, concrete choices; they can also type an answer. To choose between images, pass assetIds: they see the pictures. One question per call; then act on the answer.',
  locate_field: 'Where the author changes one content field: its value and the exact Inspector labels on the way to it, with an "Open in inspector" button.',
  upsert_page_with_sections: UPSERT_BRIEF,
  update_site_brand: BRAND_BRIEF,
  update_page_seo: PAGE_SEO_BRIEF,
  update_site_seo: SITE_SEO_BRIEF,
  upsert_managed_component: MANAGED_COMPONENT_BRIEF,
  list_collection_entries: LIST_ENTRIES_BRIEF,
  read_collection_entry: READ_ENTRY_BRIEF,
  upsert_collection_entry: UPSERT_ENTRY_BRIEF,
  define_collection: DEFINE_COLLECTION_BRIEF,
  connect_collection_list: CONNECT_LIST_BRIEF,
  inspect_source_sample: INSPECT_SOURCE_BRIEF,
  write_source_converter: WRITE_SOURCE_BRIEF,
  read_layout: 'The layout this request may change, as it is now, or one node of it.',
  update_theme_component: UPDATE_THEME_COMPONENT_BRIEF,
  set_preview: "The editor's preview controls: canvas width (viewport or width), preview colors (scheme) and Edit or Preview (mode). Changes nothing on the site.",
  step_history: "The toolbar's Undo or Redo, when the user asks to undo or redo: the request's only change.",
  ...SELECTION_BRIEFS,
  ...DEFINITION_BRIEFS
};

/** A tool's description, with its brief when it has one. */
const describe = (name: ToolName) => ({ description: DESCRIPTIONS[name], ...(BRIEFS[name] !== undefined ? { brief: BRIEFS[name] } : {}) });

/** Operations the assistant never sends: images and component packages are added only by the verified importer,
 *  a theme update one component at a time through update_theme_component, pastes come from the editor's own Copy, and a component's properties are reordered
 *  in Edit everywhere, where its placement role is chosen too. A collection is shaped with define_collection, its entries written with upsert_collection_entry and shown with connect_collection_list: a run reaches collections only through them. */
const NEVER_OFFERED = new Set<OperationType>([
  // A whole design in one call reaches the assistant through a tool of its own, never as a raw operation.
  'component.upsert',
  // So does a code component's source: apply_source_patch, bound to the revision and hash read_source returned.
  'component.updateSource',
  'asset.add',
  'asset.relink',
  'component.import',
  'theme.refresh',
  'node.paste',
  'component.orderProperties',
  'component.setInsertAs',
  'collection.create',
  'collection.update',
  'collection.remove',
  'collection.createTerm',
  'collection.renameTerm',
  'collection.removeTerm',
  'entry.create',
  'entry.update',
  'entry.reorder',
  'entry.remove',
  // A list or loop is connected to a collection with connect_collection_list, whose query a small model can send.
  'instance.setListSource',
  'node.setRepeatSource',
  // The project brief is the author's own (#518), and session.apply refuses it from a run.
  'brief.update',
  // So are external sources' settings (#676).
  'source.upsert',
  'source.remove'
]);
/** Operations that need Developer mode, shown only to runs that have it. */
export { CODE_OPERATIONS };

/** The most of each piece of the site's own code a run reads whole, and so may replace: both fit in one result. */
export const SITE_CODE_READ_MAX = 10000;
const SITE_CODE_FIELDS = [
  ['headCode', 'head code'],
  ['globalCss', 'custom CSS']
] as const;

/**
 * The site's own code as read_project's siteCode section gives it: each piece whole, as stored (site.update replaces
 * it whole, so an edit starts from this), or, past what a run may replace, its length and start alone.
 */
function siteCodeRead(state: ProjectState): Record<string, unknown> {
  return Object.fromEntries(
    SITE_CODE_FIELDS.map(([key]) => {
      const v = hasCode(state.site[key]) ? state.site[key] : '';
      return [key, v.length <= SITE_CODE_READ_MAX ? v : { characters: v.length, start: v.slice(0, 2000), note: 'Too long to replace here: the author changes it in Site settings > Custom code.' }];
    })
  );
}

/** Why a batch may not replace the site's code: code too long for a run to have read whole. Null when it may. */
function siteCodeUnread(state: ProjectState, ops: EditOperation[]): string | null {
  for (const op of ops) {
    if (op.type !== 'site.update') continue;
    for (const [key, what] of SITE_CODE_FIELDS) {
      const saved = state.site[key];
      if (op[key] !== undefined && hasCode(saved) && saved.length > SITE_CODE_READ_MAX) return `The site's ${what} is ${saved.length} characters, more than a run reads whole, so it is not replaced here. Ask the author to change it in Site settings > Custom code.`;
    }
  }
  return null;
}

/** Whether an operation creates or copies code: a code operation, or a copy of a code component (as the editor checks). */
export const copiesCode = (state: ProjectState, op: EditOperation): boolean => developerModeReason(state, op) !== null;
const CODE_TOOLS = new Set<ToolName>(['read_source', 'apply_source_patch']);
/** Editing a component's own contract. Rarely needed, so left out of the schema unless the run can use it. */
const DEFINITION_OPERATIONS = new Set<OperationType>([
  'node.setBinding',
  'component.setPropSchema',
  'component.removePropSchema',
  'component.setPropDefault',
  'component.setPart',
  'component.removePart',
  'component.setVariant',
  'component.removeVariant',
  'component.setSlot',
  'component.removeSlot',
  'component.containerToSlot',
  'component.setState',
  'component.removeState',
  'node.setStateAction'
]);

/**
 * What a run limited to one page can do with operations: change its sections and their content (a copy may come from
 * anywhere), its own settings, and detach a placement on it. scope.ts decides what each one may reach.
 */
export const PAGE_OPERATIONS = new Set<OperationType>([
  ...(Object.keys(OP_REACH) as OperationType[]).filter((t) => ['node', 'insert', 'copy'].includes(OP_REACH[t]) && t !== 'component.makeUnique' && t !== 'component.convertToCode'),
  'page.update'
]);
/**
 * A small model's page run: the page tool builds sections, and these remove one by its ID (whole, or keeping what it
 * holds) or reorder it, and set the page's own settings.
 */
export const FOCUSED_PAGE_OPERATIONS = new Set<OperationType>(['node.remove', 'node.removeKeepContent', 'node.move', 'page.update']);

/**
 * What a run limited to a collection's layout can do with operations (#679): its sections and elements, their content,
 * styles and bindings to the entry, and the placements in it. Nothing reaches a page, the shared header and footer, a
 * component's design or the collection's entries. A copy and a detached placement are left out: the engine does those
 * only on a page.
 */
export const LAYOUT_OPERATIONS = new Set<OperationType>([...[...PAGE_OPERATIONS].filter((t) => t !== 'page.update' && t !== 'node.copy' && t !== 'component.detachInstance'), 'node.setBinding']);
/** A small model's layout run: the few that build and bind it one element at a time. */
export const FOCUSED_LAYOUT_OPERATIONS = new Set<OperationType>(['node.insert', 'node.remove', 'node.move', 'node.setContent', 'node.setBinding', 'node.setStyle', 'instance.setProp']);
/** What a layout run reads and asks with, beside its own operations and tools. */
const LAYOUT_READS = new Set<ToolName>(['read_project', 'inspect_element', 'search_components', 'read_component', 'search_assets', 'validate_project', 'apply_operations']);

/** What building a new component takes: making it, its design, its contract and its placement. */
const COMPONENT_BUILD_OPERATIONS = new Set<OperationType>([
  'component.create',
  'component.createCode',
  'component.rename',
  'component.setPropSchema',
  'component.removePropSchema',
  'component.setPropDefault',
  'component.setPart',
  'component.removePart',
  'component.setVariant',
  'component.removeVariant',
  'component.setSlot',
  'component.removeSlot',
  'component.setState',
  'component.removeState',
  'node.setStateAction',
  'node.insert',
  'node.remove',
  'node.removeKeepContent',
  'node.move',
  'node.wrap',
  'node.unwrap',
  'node.duplicate',
  'node.rename',
  'node.setStyle',
  'node.resetStyles',
  'node.setContent',
  'node.setBinding'
]);
/** The tools a small model gets for building a new component, beside those operations. */
const COMPONENT_BUILD_TOOLS = new Set<ToolName>(['read_project', 'read_page', 'search_components', 'read_component', 'search_assets', 'apply_operations', 'validate_project', 'inspect_component', 'request_clarification', 'read_source', 'apply_source_patch']);
/** Measures a component's own design: left out where the run cannot change one (a page) or has room only for the small set. */
const COMPONENT_CHECK: ToolName = 'inspect_component';

/**
 * The starters the model may create a page with. The brochure starters (Services, About and the rest) fill the page
 * with the theme's sample text, which reads as a finished page: the model builds those pages from the request instead.
 */
const MODEL_PAGE_STARTER = z
  .enum(['empty', 'intro', 'article'])
  .optional()
  .describe('"intro" adds a page introduction section. "article" makes one dated announcement page (a news item): it adds an Article header showing the title, date, byline and excerpt, and a text section for the body. Blog posts are entries of the "posts" collection, never article pages.');

/**
 * The operation union the model is shown for a run; the app still checks every operation it receives. `only` narrows it.
 * `layout`: a run limited to a collection's layout binds its elements there: to the entry its page is for (`entry`, the
 * entry layout) or to a loop's row alone (`row`, the index layout).
 */
function offeredOperations(codeEnabled: boolean, definitionOps: boolean, only?: ReadonlySet<OperationType>, layout?: 'entry' | 'row') {
  const schemas = (Object.keys(OPERATION_SCHEMAS) as OperationType[])
    .filter((t) => !NEVER_OFFERED.has(t) && (codeEnabled || !CODE_OPERATIONS.has(t)) && (definitionOps || !DEFINITION_OPERATIONS.has(t) || (layout && t === 'node.setBinding')) && (!only || only.has(t)))
    .map((t) =>
      t === 'page.create'
        ? OPERATION_SCHEMAS[t].omit({ pageId: true }).extend({ starter: MODEL_PAGE_STARTER })
        : t === 'node.insert'
          ? OPERATION_SCHEMAS[t].omit({ newNodeId: true })
          : t === 'node.duplicate'
            ? OPERATION_SCHEMAS[t].omit({ index: true })
            : t === 'component.create'
              ? OPERATION_SCHEMAS[t].omit({ definitionId: true })
              : t === 'asset.replace'
              ? OPERATION_SCHEMAS[t].omit({ keepAlt: true, uses: true })
              : t === 'instance.swapComponent'
              ? // Content a new design has no place for is let go only by the author, from the preview in the Inspector.
                OPERATION_SCHEMAS[t].omit({ allowDrops: true })
              : t === 'page.update' && only
                ? // A run limited to a page changes its own settings: a new route or translation reaches other pages.
                  OPERATION_SCHEMAS[t].omit({ route: true, linkTranslationTo: true, structuredData: true })
              : t === 'page.update'
                ? // What a page is for search engines states facts only the author has (a price, an event's date).
                  OPERATION_SCHEMAS[t].omit({ structuredData: true })
              : t === 'node.setBinding'
                ? OPERATION_SCHEMAS[t].extend({ binding: layout === 'entry' ? LAYOUT_BINDING : MODEL_BINDING })
                : OPERATION_SCHEMAS[t]
    );
  return z.discriminatedUnion('type', schemas as unknown as [z.ZodObject<{ type: z.ZodLiteral<string> }>, ...z.ZodObject<{ type: z.ZodLiteral<string> }>[]]);
}

/**
 * Tool definitions for one run. Without Developer mode, code tools and code operations are left out. Component
 * contract operations are offered when `definitionOps` says the run may change a component's design.
 */
export function toolDefinitions(opts: { codeEnabled?: boolean; definitionOps?: boolean; operations?: ReadonlySet<OperationType>; layout?: 'entry' | 'row' } = {}): ToolDefinition[] {
  const codeEnabled = opts.codeEnabled ?? true;
  const definitionOps = opts.definitionOps ?? codeEnabled;
  return (Object.keys(TOOL_ARGS) as ToolName[])
    .filter((name) => !TASK_TOOLS.has(name) && (codeEnabled || !CODE_TOOLS.has(name)))
    .map((name) => {
      const args = name === 'apply_operations' ? TOOL_ARGS.apply_operations.extend({ operations: z.array(offeredOperations(codeEnabled, definitionOps, opts.operations, opts.layout)).min(1).max(MAX_BATCH_OPERATIONS) }) : TOOL_ARGS[name];
      const schema = z.toJSONSchema(args, { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
      delete schema.$schema;
      return { name, ...describe(name), parameters: schema };
    });
}

/** Tools that take a revision or hash the model read earlier: only one of these can run per turn. */
export const REVISION_BOUND_TOOLS = new Set<ToolName>(['apply_operations', 'apply_source_patch']);
const MACRO_TOOLS: ToolName[] = ['upsert_page_with_sections', 'update_site_brand', 'update_page_seo', 'update_site_seo', 'upsert_managed_component', 'upsert_collection_entry', 'define_collection', 'connect_collection_list'];
/** Reads of a collection's entries, offered with the tools of a run that has collections to read. */
const ENTRY_READS: ToolName[] = ['list_collection_entries', 'read_collection_entry'];
const SELECTION_TOOLS = Object.keys(SELECTION_ARGS) as ToolName[];
const DEFINITION_TOOLS = Object.keys(DEFINITION_ARGS) as DefinitionToolName[];
/** Reads and writes of the project's external sources (#680), offered while it has one and the run may change the site. */
const SOURCE_TOOLS: ToolName[] = ['inspect_source_sample', 'write_source_converter'];
/** Offered by task mode (see toolsForRun), never as part of the general set. */
/** The editor's own controls (#1405): offered by toolsForRun when the app can run them, never as part of the general set. */
const EDITOR_TOOLS: ToolName[] = ['set_preview', 'step_history'];
const TASK_TOOLS = new Set<ToolName>([...MACRO_TOOLS, ...ENTRY_READS, ...SOURCE_TOOLS, ...SELECTION_TOOLS, ...DEFINITION_TOOLS, ...EDITOR_TOOLS, 'locate_field', 'update_theme_component', 'read_layout']);
/**
 * Everything a read-only question may use: reads of the project, the catalogue and images, its SEO audit, its Project
 * health diagnostics and a build of its components in memory (validate_project), measurements of its pages in the
 * preview the editor already runs (inspect_layout), finding a field, and a plain question to the author. Nothing that
 * changes the site.
 */
export const ASK_TOOLS: readonly ToolName[] = ['read_project', 'read_page', 'inspect_element', 'read_component', 'search_components', 'search_assets', 'audit_seo', 'validate_project', 'inspect_layout', 'locate_field', 'request_clarification'];
/** inspect_layout as a small model's question has it: the whole page at a width, never chosen elements. */
const ASK_FOCUSED_INSPECT_BRIEF = 'Measure a page in the live preview at a width: overflow, off-screen elements, whether each image loaded (unverified ones were still loading, which is fine), missing alt text, headings and runtime errors. Structure only, no screenshots.';
export const MUTATING_TOOLS = new Set<ToolName>([...REVISION_BOUND_TOOLS, ...MACRO_TOOLS, 'step_history', 'write_source_converter', 'update_theme_component', 'update_selected_props', 'edit_selected_list', 'edit_selected_table', 'style_selected_element', ...DEFINITION_TOOLS]);

/** Below this window a model only gets the focused tools: the general operation schema alone would crowd it out. */
export { FOCUSED_WINDOW_TOKENS };

export type ToolMode = 'selection' | 'page' | 'site' | 'definition' | 'source' | 'general' | 'ask' | 'entry' | 'layout';

export interface RunTools {
  tools: ToolDefinition[];
  /** selection: the selected element's tools. page: the page tool for one page. site: page and brand tools. definition: a component's own design, on a small model. source: a code component's own source, on any model. general: a selection they cannot cover, or a design on a larger model. ask: reading only. entry: one post, open in the Posts workspace. layout: one collection layout, open on the canvas. */
  mode: ToolMode;
  /** Only the small tool set is offered. */
  focused: boolean;
  /** The run builds a new component, asked for from the Create component dialog. */
  task?: 'component';
  /** A page run: Developer mode is on, so a new component it asks to widen for may be written in code. A source run:
   *  Developer mode is on, so the code component's source may change. */
  code?: boolean;
}

const usesImage = (tools: ToolDefinition[]) => JSON.stringify(tools[0].parameters).includes('"assetId"');

/** The tools of a read-only question: the same small set for every model, with or without a selection. A project with
 *  collections can also have its posts read. */
function askTools(state: ProjectState, codeEnabled: boolean, entry?: { collectionId: string; entryId: string } | null, layout?: { owner: LayoutOwner } | null, sources = true, focused = false): ToolDefinition[] {
  const names: ToolName[] = [...ASK_TOOLS, ...(codeEnabled ? (['read_source'] as const) : [])];
  const tools = names.map((name): ToolDefinition => {
    // A question can never widen what may change: nothing may. A small model's question measures whole pages: the
    // elements a check narrows to are what an edit fixes.
    const args = name === 'request_clarification' ? TOOL_ARGS.request_clarification.omit({ widenScope: true }) : name === 'inspect_layout' && focused ? TOOL_ARGS.inspect_layout.omit({ refs: true }) : TOOL_ARGS[name];
    const schema = z.toJSONSchema(args, { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
    delete schema.$schema;
    // A question asks back only when it is ambiguous, which the question's own instructions say.
    const brief = name === 'request_clarification' ? 'Ask the author one short question and wait for the answer, with up to four short, concrete choices; to choose between images, pass assetIds: they see the pictures.' : name === 'inspect_layout' && focused ? ASK_FOCUSED_INSPECT_BRIEF : undefined;
    // A small native model reads the description rather than the brief: it says the same.
    return { name, ...describe(name), ...(brief ? { brief } : {}), ...(name === 'inspect_layout' && focused ? { description: ASK_FOCUSED_INSPECT_BRIEF } : {}), parameters: schema };
  });
  // A question reads component contracts alone: a design is read to build a component, which a question never does.
  // A question about the post open in the Posts workspace reads that post, never another with a title like it.
  const posts = entry ? [{ name: 'read_collection_entry', ...describe('read_collection_entry'), parameters: collectionToolSchemas(state, entry).read }] : entryReads(state);
  // A question asked with a collection's layout open reads that layout as it is. One about the site may read what an
  // external source the author connected has, and change nothing.
  return [...tools.map(contractRead), ...posts, ...(layout ? [plainTool('read_layout')] : []), ...(sources && !entry && !layout && hasSources(state) ? [plainTool('inspect_source_sample')] : [])];
}

/** The reads of a collection's entries, while the project has a collection to read. */
function entryReads(state: ProjectState): ToolDefinition[] {
  if (!hasCollections(state)) return [];
  const schemas = collectionToolSchemas(state);
  return [
    { name: 'list_collection_entries', ...describe('list_collection_entries'), parameters: schemas.list },
    { name: 'read_collection_entry', ...describe('read_collection_entry'), parameters: schemas.read }
  ];
}

/**
 * Whether a request typed into the chat asks about an external source (#680): how its records are read or mapped, in
 * so many words, or by naming one of the project's sources.
 */
export function asksForSource(text: string, state?: ProjectState): boolean {
  if (/\b(?:sources?|converters?|mapping|map|api|cms|feed|json|payload|contentful|sanity|strapi|wordpress|graphql|rest|sync)\b/i.test(text)) return true;
  const words = text.normalize('NFKC').toLowerCase();
  return Object.entries(state?.sources ?? {}).some(([id, s]) => [id, s?.name].some((n) => typeof n === 'string' && n.trim().length > 1 && words.includes(n.normalize('NFKC').toLowerCase().trim())));
}

/**
 * Whether a request typed into the chat asks for a collection or its entries, which a small site or page run is then
 * offered the tools for: in so many words, by asking for a blog or to write its posts (the ready-made "posts" collection,
 * #1423; a post office or fence posts are no blog), or by naming one of the project's collections (its ID, its name or
 * what one entry is called, "Add a Role field to Team").
 */
export function asksForCollection(text: string, state?: ProjectState): boolean {
  if (/\b(?:collections?|entries|entry|team members?|staff|directory|records?|loop|blogs?|blogging)\b/i.test(text)) return true;
  if (/\b(?:write|draft|publish)\s+(?:\S+\s+){0,3}?posts?\b/i.test(text)) return true;
  const fold = (s: string) => s.normalize('NFKC').toLowerCase();
  const words = fold(text);
  const named = (n: unknown) => {
    const w = typeof n === 'string' ? fold(n.trim()) : '';
    if (!w) return false;
    // A name in a script written without spaces (チーム, 团队) is found anywhere in the request; a Latin one as a word, or its plural.
    if (!/^[\p{Script=Latin}\p{N}\s\p{P}]+$/u.test(w)) return words.includes(w);
    return w.length > 1 && new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(s)?($|[^\\p{L}\\p{N}])`, 'u').test(words);
  };
  return Object.entries(state?.collections ?? {}).some(([id, c]) => named(id) || named(id.replace(/-/g, ' ')) || named(c?.settings?.name) || named(c?.settings?.singularName));
}

/**
 * The collection's shape, and connecting lists to its entries (#679). `owner`: the one owner a run limited to a page or
 * a layout connects lists in. Connecting needs a collection to connect to.
 */
const defineCollectionTool = (): ToolDefinition => ({ name: 'define_collection', ...describe('define_collection'), parameters: defineCollectionSchema() });
const connectListTools = (state: ProjectState, owner?: OwnerRef): ToolDefinition[] =>
  hasCollections(state) ? [{ name: 'connect_collection_list', ...describe('connect_collection_list'), parameters: connectListSchema(state, owner) }] : [];

/**
 * The tools of a run limited to one collection layout (#679): the layout read as it is now, its nodes one at a time,
 * operations on it alone (an element bound to the entry its page is for, on the entry layout), lists connected to
 * collections there, and the catalogue, images and the author to ask. Nothing reaches a page or widens the run.
 */
function layoutTools(state: ProjectState, owner: LayoutOwner, focused: boolean): ToolDefinition[] {
  const general = toolDefinitions({ codeEnabled: false, definitionOps: false, operations: focused ? FOCUSED_LAYOUT_OPERATIONS : LAYOUT_OPERATIONS, layout: owner.kind === 'archive' ? 'row' : 'entry' }).filter((t) => LAYOUT_READS.has(t.name as ToolName) && (!focused || t.name !== 'validate_project'));
  const ask = z.toJSONSchema(TOOL_ARGS.request_clarification.omit({ widenScope: true }), { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
  delete ask.$schema;
  return [plainTool('read_layout'), ...general, ...connectListTools(state, owner), { name: 'request_clarification', ...describe('request_clarification'), parameters: ask }];
}

/** The tool that writes a post, while the project has a collection to write one in. */
function entryWrite(state: ProjectState): ToolDefinition[] {
  return hasCollections(state) ? [{ name: 'upsert_collection_entry', ...describe('upsert_collection_entry'), parameters: collectionToolSchemas(state).upsert }] : [];
}

/**
 * The tools for this step of a run, chosen by task. The small sets are the design target: every model gets
 * them. A cloud model with room to spare also keeps the general tools for anything they cannot express, and a
 * selection they cannot cover (a layout element, say) always uses the general tools. A component's own design gets
 * its definition tools on a small model, and the general tools on a larger one.
 */
/**
 * The tools a run is offered. A small model keeps validation's two document profiles: the preview and project profiles,
 * narrowing and paging through long lists would cost a window that small more than they give it (a 12,288-token one
 * has no room left for them).
 */
export function toolsForRun(opts: Parameters<typeof runTools>[0] & { editor?: EditorTools }): RunTools {
  const run = withEditorTools(runTools(opts), opts.editor, !!opts.ask);
  if (!run.focused || !run.tools.some((t) => t.name === 'validate_project')) return run;
  const schema = z.toJSONSchema(z.object({ profile: VALIDATE_ARGS.shape.profile.unwrap().extract(['schema', 'component']).optional() }), { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
  delete schema.$schema;
  return { ...run, tools: run.tools.map((t) => (t.name === 'validate_project' ? { ...t, description: VALIDATE_FOCUSED_BRIEF, brief: VALIDATE_FOCUSED_BRIEF, parameters: schema } : t)) };
}

/** Which of the editor's own controls a run may use (#1405): the app must be able to run them, for the author's own request. */
export interface EditorTools {
  /** The preview controls: every request, a question too, since they change nothing on the site. */
  preview?: boolean;
  /** Undo and Redo: a request that may change the site, never a question. */
  history?: boolean;
  /** What the request typed into the chat asks for (asksForPreview, asksForHistory): a small model is offered only that, keeping its window for the rest. */
  asked?: { preview: boolean; history: boolean };
}

/** Whether a request asks to see the preview another way: at a device's width or a number of pixels, in light or dark colors, or in Edit or Preview. */
export const asksForPreview = (text: string): boolean =>
  /\b(?:phones?|mobiles?|smartphones?|iphones?|android|tablets?|ipads?|desktops?|laptops?|viewport|widths?|\d{3,4}\s?px|pixels?|dark|light|colou?r scheme|night mode|preview|edit mode|screen sizes?|small screens?|wide screens?)\b/i.test(text);
/** Whether a request asks to undo or redo a change. */
export const asksForHistory = (text: string): boolean =>
  /\b(?:undo|undid|redo|redid|revert|roll\s?back|put (?:it |that |this )?back|take (?:it |that |this )?back|(?:go|step) back (?:a |one )?(?:step|change)|last (?:change|edit)s?|previous (?:change|edit|version))\b/i.test(text);

/** The run's tools with the editor's controls after them, whatever task chose the rest. */
function withEditorTools(run: RunTools, editor: EditorTools | undefined, ask: boolean): RunTools {
  const wanted = (k: 'preview' | 'history') => !!editor?.[k] && (!run.focused || !!editor.asked?.[k]);
  const extra = [...(wanted('preview') ? [plainTool('set_preview')] : []), ...(wanted('history') && !ask ? [plainTool('step_history')] : [])];
  return extra.length ? { ...run, tools: [...run.tools, ...extra] } : run;
}

function runTools(opts: {
  state: ProjectState;
  selection: SelectionTarget | null;
  capabilities: Pick<ModelCapabilities, 'toolCalling' | 'contextWindowTokens'>;
  codeEnabled: boolean;
  definitionOps: boolean;
  /** The run is about a component's own design (edited everywhere): the general tools for a larger model, and for any
   *  model once the user lets it change more. */
  definition?: boolean;
  /** The design a run is still limited to (the component, or a node selected in it): a small model gets its definition
   *  tools instead of the general ones. Null once the user lets the run change more. */
  definitionTarget?: DefinitionTarget | null;
  attachedImages?: boolean;
  ask?: boolean;
  /** The small set whatever the window: the request would not fit beside the general tools. */
  focused?: boolean;
  /** The selection a run started from, once the user has let it change more. */
  widened?: SelectionTarget | null;
  /** The run started limited to one page and the user has since let it change the whole site. */
  widenedFromPage?: boolean;
  /** The selection is a part of a placement, as the run's authority reads it (see scope.ts authorityFor). Unset, it is
   *  worked out from the selection, which cannot tell a bound element inside a placement from the whole of it. */
  selectionPart?: boolean;
  /** The page a run is limited to: its page tool builds only that page, and nothing site-wide is offered. */
  page?: { route: string } | null;
  /** The request asks for a new component (the Create component dialog). */
  task?: 'component';
  /** The request typed into the chat asks for a component (see asksForComponent): a small site run is offered the tool
   *  that builds one whole, which it otherwise leaves out to keep its window for pages. */
  componentRequest?: boolean;
  /** The request names Svelte, so it asks for code even when it never says "component". */
  svelteRequest?: boolean;
  /** The post a run is limited to (sent from the Posts workspace): it reads and writes only that entry. */
  entry?: { collectionId: string; entryId: string } | null;
  /** The collection layout a run is limited to (sent while it was open on the canvas): it reads and writes only that layout. */
  layout?: { owner: LayoutOwner } | null;
  /** The request typed into the chat asks for a collection (see asksForCollection): a small site run is offered the
   *  collection tools, which it otherwise leaves out to keep its window for pages. */
  collectionRequest?: boolean;
  /** The request asks about an external source (see asksForSource): a small site run is offered the source tools. */
  sourceRequest?: boolean;
}): RunTools {
  const { state, selection, capabilities, codeEnabled, definitionOps } = opts;
  const focused = !!opts.focused || capabilities.toolCalling === 'constrained-json' || capabilities.contextWindowTokens < FOCUSED_WINDOW_TOKENS;
  // A small model's question reads a source only when it asks about one.
  if (opts.ask) return { tools: askTools(state, codeEnabled, opts.entry, opts.layout, !focused || !!opts.sourceRequest, focused), mode: 'ask', focused };
  // One collection layout, for every model: nothing else is in reach, and nothing widens it.
  if (opts.layout) return { tools: layoutTools(state, opts.layout.owner, focused), mode: 'layout', focused };
  // One post, for every model: its text read a part at a time and written back, and the author to ask for more. Nothing
  // names another entry, nor creates one.
  if (opts.entry) {
    const pinned = collectionToolSchemas(state, opts.entry);
    return {
      tools: [
        { name: 'read_collection_entry', ...describe('read_collection_entry'), parameters: pinned.read },
        { name: 'upsert_collection_entry', description: UPSERT_PINNED_ENTRY_DESCRIPTION, brief: UPSERT_PINNED_ENTRY_BRIEF, parameters: pinned.upsert },
        plainTool('request_clarification')
      ],
      mode: 'entry',
      focused
    };
  }
  // A new component is built with the general tools, which the page and selection tools cannot replace; a small model
  // gets only what building one takes, so the request still fits beside them.
  if (opts.task === 'component') {
    const tools = focused ? toolDefinitions({ codeEnabled, definitionOps, operations: COMPONENT_BUILD_OPERATIONS }).filter((t) => COMPONENT_BUILD_TOOLS.has(t.name as ToolName)) : toolDefinitions({ codeEnabled, definitionOps });
    // The whole component in one call comes first: the operations stay for finer changes to what it built.
    return { tools: [managedComponentTool(), ...tools], mode: 'general', focused, task: 'component' };
  }
  // A code component's design is its source (#1410): every model reads and patches that one component, and asks the
  // author before anything else. Without Developer mode its source cannot change, so the run only asks.
  const designed = opts.definitionTarget && !opts.definitionTarget.nodeId && Object.hasOwn(state.components, opts.definitionTarget.definitionId) ? state.components[opts.definitionTarget.definitionId] : undefined;
  if (designed?.kind === 'code') return { tools: codeEnabled ? [...sourceTools(designed.id), plainTool('search_assets'), plainTool('request_clarification')] : [plainTool('request_clarification')], mode: 'source', focused, code: codeEnabled };
  // A component's own design on a small model: tools built from that design as it is now, beside its contract and
  // design to read and the author to ask, so the general operations never crowd out the request (#360).
  // A design or selected node that is gone (removed by the run itself, say) keeps the small set's reads and question: the
  // run may change nothing more, and the general tools would only crowd out its answer.
  if (focused && opts.definitionTarget) {
    const micro = definitionTools(state, opts.definitionTarget) ?? [];
    // Text too long to show whole can still be read whole, a part at a time, before it is rewritten. Images are always
    // looked up: any design can take an image property, whose default is an assetId.
    const reads = definitionAbridged(state, opts.definitionTarget) ? [plainTool('inspect_element')] : [];
    return { tools: [...micro, definitionRead(opts.definitionTarget.definitionId), ...reads, plainTool('search_assets'), plainTool('request_clarification')], mode: 'definition', focused };
  }
  const general = toolDefinitions({ codeEnabled, definitionOps });
  // An installed theme component the run needs a newer version of is updated first: offered while there is one this run
  // may update and then change with the tools it has.
  const update = (reach: UpdateReach) => themeUpdateTools(state, reach);
  if (selection) {
    const micro = selectionTools(state, selection);
    // A part of a placement never changes its component; a small model's selection tools change the selected placement alone.
    const whole = opts.selectionPart === undefined ? wholeSelection(state, selection) : !opts.selectionPart;
    const mine = (ownOnly: boolean) => (whole ? update({ kind: 'selection', owner: selection.owner, nodeId: selection.nodeId, ownOnly }) : []);
    // A whole placement's list, or a loop in it, is connected to a collection with its own tool (the raw operations are never offered).
    const lists = whole ? connectListTools(state, selection.owner) : [];
    if (!micro) return { tools: [...mine(false), ...general, ...lists], mode: 'general', focused: false };
    // An image can only be chosen by its asset ID, so a selection with one (a background image included), or a request that attached images, can
    // also look them up and ask the user to choose between them by sight.
    const assets = usesImage(micro) || selectionTakesBackground(state, selection) || opts.attachedImages ? general.filter((t) => t.name === 'search_assets' || t.name === 'request_clarification') : [];
    // Content too long to show whole in the selection can still be read whole, a part at a time, before it is changed.
    const reads = selectionAbridged(state, selection) ? general.filter((t) => t.name === 'inspect_element') : [];
    return { tools: focused ? [...micro, ...mine(true), ...reads, ...assets] : [...micro, ...mine(false), ...general, ...lists], mode: 'selection', focused };
  }
  // A component's own design changes no placement; once the user lets the run change more, it may update one.
  // So is a collection loop in a component's design, or a list of a component placed in it.
  if (opts.definition) {
    const lists = connectListTools(state, opts.definitionTarget ? { kind: 'component', id: opts.definitionTarget.definitionId } : undefined);
    return { tools: opts.definitionTarget ? [...general, ...lists] : [...update({ kind: 'site' }), ...general, ...lists], mode: 'general', focused: false };
  }
  if (opts.page) {
    // Operations only for the page's own sections and settings, and no code edits: a component's source shows on every
    // page. A small model gets the few that address one section by its ID, which the page tool cannot.
    const own = toolDefinitions({ codeEnabled, definitionOps: false, operations: focused ? FOCUSED_PAGE_OPERATIONS : PAGE_OPERATIONS }).filter((t) => t.name !== 'apply_source_patch' && t.name !== COMPONENT_CHECK);
    const upsert: ToolDefinition = { name: 'upsert_page_with_sections', ...describe('upsert_page_with_sections'), parameters: upsertToolSchema(state, opts.page.route, focused) };
    // Its own search settings, by its ID alone; the site's are the whole site's, so they wait for a wider scope.
    const pageId = pageIdFor(state, opts.page.route);
    const seo: ToolDefinition[] = pageId ? [{ name: 'update_page_seo', ...describe('update_page_seo'), parameters: pageSeoToolSchema(pageId) }] : [];
    // A feed of posts is placed with the page tool; the posts themselves can be read, and are changed once widened.
    const updates = pageId ? update({ kind: 'page', pageId, sectionsOnly: focused }) : [];
    // A list on the page shows a collection's entries through connect_collection_list, for this page's own sections.
    const lists = pageId && (!focused || opts.collectionRequest) ? connectListTools(state, { kind: 'page', id: pageId }) : [];
    return { tools: [upsert, ...seo, ...own, ...updates, ...lists, ...entryReads(state)], mode: 'page', focused, code: codeEnabled };
  }
  const macros: ToolDefinition[] = [
    { name: 'upsert_page_with_sections', ...describe('upsert_page_with_sections'), parameters: upsertToolSchema(state, undefined, focused) },
    { name: 'update_site_brand', ...describe('update_site_brand'), parameters: brandToolSchema(state) },
    { name: 'update_page_seo', ...describe('update_page_seo'), parameters: pageSeoToolSchema() },
    { name: 'update_site_seo', ...describe('update_site_seo'), parameters: siteSeoToolSchema() },
    ...(!focused || opts.componentRequest ? [managedComponentTool()] : []),
    // A new kind of content (a Team, Projects) is a collection, made and shown with these: a small model gets them when
    // the request asks for one or names one the project has, so its window stays for pages otherwise.
    ...(!focused || opts.collectionRequest ? [defineCollectionTool(), ...connectListTools(state)] : []),
    ...entryWrite(state),
    ...entryReads(state),
    // How a connected source's records become entries: a small model gets these when the request asks about a source.
    ...(hasSources(state) && (!focused || opts.sourceRequest) ? SOURCE_TOOLS.map(plainTool) : [])
  ];
  // A small model widened from a selection keeps its style tool for the selected element, which nothing else it has can
  // do (styling every card of a selected one, say).
  const kept = focused && opts.widened ? (selectionTools(state, opts.widened, { widened: true }) ?? []).filter((t) => t.name === 'style_selected_element') : [];
  // A small run asked for a component reads a design whole, which a rebuild has to describe again in full.
  const reads = (t: ToolDefinition) => (opts.componentRequest && t.name === 'read_component' ? t : contractRead(t));
  // A small model's page tool changes top-level sections alone: it may update only what it can then change.
  // A page run asks to widen before it makes a component, so once allowed a small model asked for one can also write it
  // in code: that one operation, and the page tool places what it made.
  const code = focused && codeEnabled && opts.widenedFromPage && (opts.componentRequest || opts.svelteRequest) ? toolDefinitions({ codeEnabled, definitionOps: false, operations: new Set<OperationType>(['component.createCode']) }).filter((t) => t.name === 'apply_operations') : [];
  return { tools: [...macros, ...kept, ...code, ...update(focused ? { kind: 'sections' } : { kind: 'site' }), ...(focused ? general.filter((t) => t.name !== 'apply_operations' && t.name !== COMPONENT_CHECK).map(reads) : general)], mode: 'site', focused };
}

/**
 * A whole managed component in one call (#359). It needs a run that may change the whole site (a rebuild moves every
 * placement), and no Developer mode: a managed design is not code.
 */
/** Whether a request typed into the chat asks for a component, which a small site run then builds whole. */
export const asksForComponent = (text: string): boolean => /\b(?:components?|reusable|re-usable)\b/i.test(text);

const managedComponentTool = (): ToolDefinition => ({ name: 'upsert_managed_component', ...describe('upsert_managed_component'), parameters: managedComponentSchema() });

/** The theme update tool, while the project has an installed theme component this run can update. */
const themeUpdateTools = (state: ProjectState, reach: UpdateReach): ToolDefinition[] => {
  const t = updateThemeComponentTool(state, describe('update_theme_component'), reach);
  return t ? [t] : [];
};

/** How well a component matches a search: 3 for each word in its name, 1 for each found only in the rest. */
function searchScore(query: string, name: string, rest: string): number {
  const n = name.toLowerCase();
  const hay = `${n} ${rest}`.toLowerCase();
  return query
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .reduce((s, w) => s + (n.includes(w) ? 3 : hay.includes(w) ? 1 : 0), 0);
}

/**
 * The project's own components matching a search, best first, scored as the catalogue search scores its own: a word
 * in the name counts most, one in the description or tags less. The shared header and footer are never offered.
 */
export function searchProjectComponents(state: ProjectState, query: string, limit: number) {
  const mine = Object.values(state.components).filter((d) => d.owner === 'project' && d.category !== 'shell');
  if (!query.trim()) return mine.slice(0, limit);
  return mine
    .map((d) => ({ d, score: searchScore(query, d.name, `${d.description ?? ''} ${(d.tags ?? []).join(' ')}`) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.d);
}

/**
 * read_component with the contract alone, for a question and for a small model building pages. A design is read to
 * build a component, which neither does (a small model builds one only when asked to, with task "component"), so
 * their windows keep the room.
 */
function contractRead(t: ToolDefinition): ToolDefinition {
  if (t.name !== 'read_component') return t;
  const schema = z.toJSONSchema(TOOL_ARGS.read_component.omit({ structure: true, offset: true }), { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
  delete schema.$schema;
  return { ...t, description: CONTRACT_READ, parameters: schema };
}

/** A tool as its arguments describe it, for a small set that offers it unchanged. */
function plainTool(name: ToolName): ToolDefinition {
  const schema = z.toJSONSchema(TOOL_ARGS[name], { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
  delete schema.$schema;
  return { name, ...describe(name), parameters: schema };
}

/** read_component for the one design a run edits, with its structure read a part at a time. */
function definitionRead(definitionId: string): ToolDefinition {
  const schema = z.toJSONSchema(TOOL_ARGS.read_component.omit({ componentId: true }), { unrepresentable: 'any', io: 'input' }) as { properties: Record<string, unknown> };
  return {
    name: 'read_component',
    ...describe('read_component'),
    parameters: { type: 'object', properties: { ...schema.properties, definitionId: { type: 'string', enum: [definitionId] } }, required: ['definitionId'], additionalProperties: false }
  };
}

/** read_source and apply_source_patch for the one code component a run edits: no other definition can be named, and a
 *  patch's scope is that component. */
function sourceTools(definitionId: string): ToolDefinition[] {
  const scope = { type: 'object', properties: { kind: { type: 'string', enum: ['component'] }, targetIds: { type: 'array', items: { type: 'string', enum: [definitionId] }, minItems: 1, maxItems: 1 } }, required: ['kind', 'targetIds'], additionalProperties: false };
  return (['read_source', 'apply_source_patch'] as const).map((name) => {
    const t = plainTool(name);
    const schema = t.parameters as { properties: Record<string, unknown> };
    return { ...t, parameters: { ...schema, properties: { ...schema.properties, definitionId: { type: 'string', enum: [definitionId] }, ...(name === 'apply_source_patch' ? { scope } : {}) } } };
  });
}

/** An image in the project's library, or null for an unknown ID or a font. */
export function libraryImage(state: ProjectState, assetId: unknown): AssetRecord | null {
  if (typeof assetId !== 'string' || !Object.hasOwn(state.assets.assets, assetId)) return null;
  const a = state.assets.assets[assetId];
  // A record filed under another ID (a hand-edited library) is not that image.
  return a?.kind === 'image' && a.id === assetId ? a : null;
}

/** What the AI is told about a library image: its identity and text, never its pixels, file or location data. */
export function assetSummary(a: AssetRecord) {
  return { assetId: a.id, name: a.name, width: a.width, height: a.height, description: a.description, altSuggestion: a.altSuggestion };
}

/** How a conversation names an image: an empty name still reads as something. */
export const imageRef = (a: AssetRecord): ChatImageRef => ({ assetId: a.id, name: (typeof a.name === 'string' && a.name.trim()) || 'Untitled image' });

/** What the AI hears when the user picks an offered image, live and when the conversation is replayed. */
export const imageAnswer = (img: ChatImageRef) => `I chose the image "${img.name}" (assetId: ${img.assetId}).`;

/** A library image as it is listed for the AI among choices or attachments. */
export const imageLabel = (img: ChatImageRef) => `image "${img.name}" (assetId: ${img.assetId})`;

export interface ToolHost {
  state(): ProjectState;
  revision(): number;
  diagnostics(): Diagnostic[];
  /**
   * `grants`: what the calling tool may also change for a run limited to one page (see scope.ts), never set by the model.
   * `requested`: the scope the model asked for; one wider than the run's is refused, and a narrower one limits the call.
   */
  apply(operations: EditOperation[], expectedRevision: number, label: string, idempotencyKey: string, grants?: AuthorityGrants, requested?: RequestedScope): Promise<{ ok: boolean; revision: number; results?: unknown[]; error?: ToolError }>;
  compileAll(): Promise<Diagnostic[]>;
  /**
   * `targets`: measure only these elements and what is inside them (see layout-targets.ts); omitted, the whole page.
   * `focus`: list only the findings on these elements (validate_project narrowed to them).
   */
  inspectLayout(pageId: string, width: number, opts?: InspectLayoutOptions): Promise<unknown>;
  /** Show and measure a component in isolated previews, step by step (see inspect_component). */
  inspectComponent?(steps: ComponentPreviewStep[]): Promise<ComponentPreviewResult[]>;
  /** `images`: library images offered as choices, already checked to be in the project. */
  ask(question: string, choices: string[], widenScope?: boolean, images?: ChatImageRef[]): Promise<string>;
  /**
   * What the author saved of their own while the question just answered waited (#1281), in their words, each once:
   * taken by the answer that tells the model.
   */
  authorEdits?(): string[];
  /** What the macro tools remember during a run. */
  macros?: MacroMemory;
  /** The element a selection-scoped run is working on. */
  selection?(): SelectionTarget | null;
  /** The component design a run started limited to (see definition.ts), for its definition tools. */
  definitionTarget?(): DefinitionTarget | null;
  /** Whether the run is still limited to its selection: the user has not let it change more. */
  selectionLimited?(): boolean;
  /** Whether that selection is a part of a placement, or inside a component's design: neither may add a component. */
  selectionNarrow?(): boolean;
  /** Whether the run is still limited to one component's design. */
  componentLimited?(): boolean;
  /** The page the run is still limited to, and how it is named, or null once it may change more. */
  pageLimit?(): { pageId: string; label: string } | null;
  /** The post the run is limited to (sent from the Posts workspace), and how it is named, or null once it may change
   *  more: it then reads and writes that post alone. */
  entryLimit?(): { collectionId: string; entryId: string; label: string } | null;
  /** The collection layout the run is limited to (sent while it was open), and how it is named: it reads and writes
   *  only that layout. */
  layoutLimit?(): { owner: LayoutOwner; label: string } | null;
  /** The pages that show this run's changes, as the preview check before it finishes would measure them (validate_project's preview). */
  changedPageIds?(): string[];
  /** Problems with the project's files on disk, such as image files missing from the project folder, looked for again. */
  fileDiagnostics?(): Promise<Diagnostic[]>;
  /** Aborted when the run is stopped. */
  signal?: AbortSignal;
  /** The project's external sources as the source tools read and test them (#680), ended with the run. */
  sources?: SourceToolHost;
  /** Change the editor's preview controls (set_preview); without it the tool says it cannot run. */
  controlPreview?(settings: PreviewControlSettings): Promise<PreviewControlResult>;
  /** Step the project's History for this run (step_history); without it the tool says it cannot run. */
  stepHistory?(direction: 'undo' | 'redo', steps: number): Promise<{ ok: boolean; revision: number; label?: string; error?: ToolError }>;
}

const WIDTHS = { phone: 390, tablet: 834, desktop: 1280 };

/** set_preview: what the editor shows after, and what it could not change. A call that changes nothing it asked fails. */
async function runSetPreview(a: z.infer<(typeof TOOL_ARGS)['set_preview']>, host: ToolHost): Promise<ToolOutcome> {
  if (!host.controlPreview) return toolError('SCOPE_MISMATCH', "The editor's preview controls cannot be changed from this request. The author can change them in the toolbar.", { recoverable: false });
  if (a.viewport === undefined && a.width === undefined && a.scheme === undefined && a.mode === undefined) return toolError('INVALID_ARGUMENT', 'Name at least one of viewport, width, scheme or mode.');
  if (a.viewport !== undefined && a.width !== undefined) return toolError('INVALID_ARGUMENT', 'Give viewport or width, not both.');
  const r = await host.controlPreview({ ...(a.viewport ? { viewport: a.viewport } : {}), ...(a.width !== undefined ? { width: a.width } : {}), ...(a.scheme ? { scheme: a.scheme } : {}), ...(a.mode ? { mode: a.mode } : {}) });
  if ('error' in r) return toolError('CONFLICT', `The preview controls could not be changed: ${r.error}`, { recoverable: false });
  if (!r.now || typeof r.now.width !== 'number' || !Array.isArray(r.changed) || !Array.isArray(r.refused) || !r.refused.every((x) => typeof x?.reason === 'string')) return toolError('CONFLICT', 'The preview controls could not be changed: the editor gave no answer.', { recoverable: false });
  const asked = (['viewport', 'width', 'scheme', 'mode'] as const).filter((k) => a[k] !== undefined);
  // Every setting asked for refused: nothing the user wanted happened, which the reply must say.
  if (r.refused.length && r.refused.length >= asked.length) return toolError('CONFLICT', r.refused.map((x) => x.reason).join(' '), { recoverable: false, details: { now: r.now } });
  return { ok: true, content: { revision: host.revision(), now: r.now, changed: r.changed, ...(r.refused.length ? { refused: r.refused } : {}) } };
}

/**
 * Measure a page in the live preview at a width, for the model's inspect_layout and the application's own check
 * alike. A preview that is not running, did not load or did not answer is a check that could not run, never a clean
 * result; it names the page and width it was for in its details. `pageId` is an existing page's ID.
 */
export async function measurePage(inspect: (pageId: string, width: number) => Promise<unknown>, pageId: string, viewport: keyof typeof WIDTHS, revision: number): Promise<ToolOutcome> {
  try {
    const report = (await inspect(pageId, WIDTHS[viewport])) as { error?: unknown } | null;
    if (!report || typeof report !== 'object' || report.error) return toolError('VALIDATION_FAILED', `Layout could not be inspected: ${String(report?.error ?? 'no report')}`, { details: { pageId, viewport } });
    const envelope = { revision, pageId, viewport, width: WIDTHS[viewport] };
    return { ok: true, content: { ...envelope, report: fitInspection(envelope, report) }, report };
  } catch (e) {
    return toolError('VALIDATION_FAILED', `Layout could not be inspected: ${(e as Error).message}`, { details: { pageId, viewport } });
  }
}

/** What a transform, transition or grid property takes, for the read_project list: its range, unit or grammar. */
function valueHint(p: StylePropDef): string {
  if (p.id === 'gridTemplate')
    return ` or up to ${MAX_GRID_TRACKS} column sizes (repeats counted in full): fr shares, lengths, auto, minmax(min, max) with a min that is not fr, and repeat(count, sizes), such as "16rem 1fr 14rem" or "2fr repeat(2, 1fr)"; "repeat(auto-fit, minmax(18rem, 1fr))" (or auto-fill) for as many columns as fit, each at least that plain length (or the whole grid when narrower). Set for all sizes it applies from tablet up; set it at scope phone to use it on phones`;
  if (p.id === 'gridAutoFlow') return ' (on a grid: "dense" packs gaps tightly, letting a later item show above an earlier one in a hole it left; keyboard and screen reader order stay as written)';
  if (p.id === 'gridAutoRows') return ' or one row size: a length, auto, min-content, max-content, 1fr or minmax(min, max) with a min that is not fr, such as "minmax(12rem, auto)" (on a grid: the height of each row it makes; a fixed length lets taller content spill out)';
  if (p.id === 'columnStart') return ' (a grid child: the column line it starts on, or "auto"; a line set for all sizes applies from tablet up, set it at scope phone to place it there; Full width always starts on line 1)';
  if (p.id === 'columnSpan' || p.id === 'rowSpan') return ' (a grid child; above 1 for all sizes it applies from tablet up, set it at scope phone to span there)';
  if (p.id === 'backdropBlur') return ` or one length in px, rem or em up to ${BLUR_LIMITS.px}px or ${BLUR_LIMITS.rem}rem, 0 for none: blurs what shows through a background at less than full strength, for frosted glass`;
  if (p.kind === 'color') return ' (a color token at part strength is {"token": "color.surface", "alpha": 0.7} for 70%, a see-through surface)';
  if (p.kind === 'media') return ': {"assetId": a library image\'s ID, "size": "cover" (default), "contain" or "tile" (repeat it, for a pattern or grain), "tileSize": one tile\'s width in whole CSS pixels (tile only; default the picture\'s own size), "position": "X% Y%" focus (default center), "scrim": a color or one gradient over the picture}; give it a scrim whenever text sits on top, so the text stays readable';
  if (p.group !== 'motion') return '';
  if (p.id === 'translateX' || p.id === 'translateY') return ` (0 or one length such as "-4px": at most ${TRANSLATE_LIMITS.px}px, ${TRANSLATE_LIMITS.rem}rem or em, or ${TRANSLATE_LIMITS['%']}% either way)`;
  if (p.kind === 'number') return ` (${p.integer ? 'whole number ' : ''}${p.min} to ${p.max}${p.unit ? ` ${p.unit}` : ''})`;
  return '';
}

/**
 * A layout report cut, when it must be, to fit a tool result with the rest of `envelope`: first the text previews
 * and runtime error details, then findings from the longest lists, one at a time. One finding of every kind stays,
 * and the counts (report.checks, report.images) are never cut, so a short list never reads as a clean page.
 */
export function fitInspection<R>(envelope: Record<string, unknown>, report: R): R {
  const room = MAX_RESULT_CHARS - 200;
  const size = (r: unknown) => JSON.stringify({ ...envelope, report: r }).length;
  if (!report || typeof report !== 'object' || size(report) <= room) return report;
  const r = { ...(report as Record<string, unknown>) };
  const issues: Array<Record<string, unknown>> = Array.isArray(r.issues) ? (r.issues as Array<Record<string, unknown>>).map((i) => ({ ...i })) : [];
  for (const i of issues) {
    delete i.text;
    delete i.cutText;
    if (i.with && typeof i.with === 'object') {
      const { text: _text, ...rest } = i.with as Record<string, unknown>;
      i.with = rest;
    }
  }
  if (Array.isArray(r.runtimeErrors)) r.runtimeErrors = (r.runtimeErrors as unknown[]).slice(-5).map((e) => String(e).slice(0, 300));
  // The notes on the page's rhythm are few (one of each kind) and kept whole but for the text they quote.
  const notes = Array.isArray(r.rhythm) ? (r.rhythm as unknown[]).filter((n): n is Record<string, unknown> => !!n && typeof n === 'object') : null;
  if (notes)
    r.rhythm = notes.map(({ text: _text, ...n }) => {
      if (!n.with || typeof n.with !== 'object') return n;
      const { text: _with, ...rest } = n.with as Record<string, unknown>;
      return { ...n, with: rest };
    });
  r.issues = issues;
  // Advice gives way before findings do: the notes keep only what they say before any finding goes.
  if (notes && size(r) > room) r.rhythm = notes.map((n) => ({ kind: n.kind, message: n.message }));
  let omitted = 0;
  while (size(r) > room) {
    const byKind = new Map<string, number>();
    for (const i of issues) byKind.set(String(i.kind), (byKind.get(String(i.kind)) ?? 0) + 1);
    const [kind, n] = [...byKind].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    if (n < 2) break;
    issues.splice(issues.map((i) => String(i.kind)).lastIndexOf(kind), 1);
    omitted++;
  }
  if (omitted) r.omittedIssues = omitted;
  // Still too long with one finding of each kind: the notes go, before the whole result would be cut short, saying
  // so when that fits.
  if (notes && size(r) > room) {
    delete r.rhythm;
    r.omittedRhythm = notes.length;
    if (size(r) > room) delete r.omittedRhythm;
  }
  return r as R;
}

/**
 * Images found by search_assets, cut when they must be to fit one result, so every one keeps what tells it apart (its
 * ID, name and size): descriptions and alt suggestions are shortened first, then left out.
 */
function fitAssets(list: Array<ReturnType<typeof assetSummary>>): Array<Partial<ReturnType<typeof assetSummary>>> {
  const room = MAX_RESULT_CHARS - 400;
  const fits = (l: unknown[]) => JSON.stringify(l).length <= room;
  if (fits(list)) return list;
  const cut = (t: string | undefined) => (t && t.length > 80 ? `${t.slice(0, 80)}…` : t);
  const short = list.map((x) => ({ ...x, description: cut(x.description), altSuggestion: cut(x.altSuggestion) }));
  if (fits(short)) return short;
  return list.map(({ assetId, name, width, height }) => ({ assetId, name, width, height }));
}

/** What search_assets says beside images whose descriptions it had to shorten or leave out. */
const SHORTENED_ASSETS = ' Descriptions and alt suggestions were shortened or left out to fit every image: search with narrower words, or a lower limit, to see them whole.';

/**
 * A component check cut, when it must be, to fit a tool result whole, so it keeps the fields that say what it is
 * (and the budget reads): first the texts of its findings, then findings from the end, keeping one of every kind.
 */
function fitComponentCheck(content: Record<string, unknown>): Record<string, unknown> {
  const room = MAX_RESULT_CHARS - 200;
  if (JSON.stringify(content).length <= room || !Array.isArray(content.findings)) return content;
  const findings = (content.findings as Array<Record<string, unknown>>).map(({ text: _t, ...f }) => (f.with && typeof f.with === 'object' ? { ...f, with: { ...(f.with as Record<string, unknown>), text: undefined } } : f));
  const out = { ...content, findings };
  let omitted = Number(content.omittedFindings ?? 0);
  while (JSON.stringify(out).length > room) {
    const last = findings.findLastIndex((f, i) => findings.findIndex((g) => g.kind === f.kind) !== i);
    if (last < 0) break;
    findings.splice(last, 1);
    omitted++;
  }
  return omitted ? { ...out, omittedFindings: omitted } : out;
}

export { MAX_RESULT_CHARS, serializeResult } from './result';
export type { ToolOutcome } from './result';

/**
 * Run one tool call. Its result always has the one shape every tool's has (see result.ts), with the revision the call
 * read wherever the tool does not name the one it reflects (a change names the revision it made).
 */
/**
 * How a theme's code is changed: on a project copy for the placements the request covers, which then reads and
 * patches like any project code, while the theme's own stays for every other placement, for inserting and for theme
 * switches. Says which copy this run may make, and lists the placements it may move to one.
 */
function themeCodeCopy(state: ProjectState, def: ComponentDefinition, host: ToolHost): { note: string; placements?: Array<{ owner: OwnerRef; nodeId: string; where: string }>; morePlacements?: number } {
  const shared = `“${def.name}” is the theme's code, shared by every placement of it: it is never patched.`;
  const then = 'Then read_source the definitionId it returns, and patch that.';
  // A copy adds a component to the site: more than a page, a selected part or a selection inside a design can change.
  const widen = (label: string) => ({ note: `${shared} Changing it needs a project copy, which adds a component to the site: more than ${label}. Ask the user to allow a wider change first.` });
  const page = host.pageLimit?.();
  if (page) return widen(page.label);
  if (host.componentLimited?.()) return widen('this component’s design');
  const selected = host.selectionLimited?.() ? host.selection?.() : null;
  if (selected && host.selectionNarrow?.()) return widen('the selection');
  let inside: Set<string> | null = null;
  if (selected) {
    try {
      inside = new Set(subtreeIds(getTree(state, selected.owner), selected.nodeId));
    } catch {
      inside = new Set();
    }
  }
  // Only placements a fork can move: never a collection layout's (the editor's) or one inside a theme's own design.
  const movable = (o: OwnerRef) => o.kind !== 'template' && o.kind !== 'archive' && (o.kind !== 'component' || state.components[o.id]?.owner === 'project');
  const all = instancesOf(state, def.id)
    .filter((p) => movable(p.owner) && (!selected || (p.owner.kind === selected.owner.kind && p.owner.id === selected.owner.id && inside!.has(p.node.id))))
    .map((p) => ({ owner: p.owner, nodeId: p.node.id, where: p.label }));
  const placements = all.slice(0, 40);
  const listed = { placements, ...(all.length > placements.length ? { morePlacements: all.length - placements.length } : {}) };
  if (selected)
    return { note: `${shared} Patch a project copy instead: component.makeUnique { owner, nodeId } copies it for the selected placement, or component.fork { definitionId, placements: [{ owner, nodeId }] } for several of the placements inside the selection (listed here), which share the copy. ${then}`, ...listed };
  return {
    note: `${shared} Patch a project copy instead: component.fork { definitionId, placements: [{ owner, nodeId }] } copies it for the placements the request covers (listed here), which share the copy while every other keeps the theme's; without placements, every placement the project can change moves to it. ${then}`,
    ...listed
  };
}

export async function executeTool(name: string, rawArgs: string, host: ToolHost, callId: string): Promise<ResultOutcome> {
  const revision = host.revision();
  return stamp(await runTool(name, rawArgs, host, callId, revision), revision);
}

async function runTool(name: string, rawArgs: string, host: ToolHost, callId: string, revision: number): Promise<ToolOutcome | ResultOutcome> {
  // An own key only: "constructor" is no tool either.
  if (!Object.hasOwn(TOOL_ARGS, name)) return toolError('INVALID_ARGUMENT', `Unknown tool "${name}".`);
  let parsed: unknown;
  try {
    parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return toolError('INVALID_ARGUMENT', 'Arguments were not valid JSON.');
  }
  // Its own checks name each problem by its path, and keep the call for a repair that sends only what was wrong.
  if (name === 'upsert_managed_component') return runManagedComponent(parsed, host, callId, (host.macros ??= newMacroMemory()));
  const schema = TOOL_ARGS[name as ToolName];
  // Checked before parsing, which drops fields the schema does not name.
  const raw = name === 'apply_operations' && parsed && typeof parsed === 'object' ? (parsed as { operations?: unknown }).operations : undefined;
  const legacy = Array.isArray(raw) ? raw.map(legacyShellError).find(Boolean) : null;
  if (legacy) return toolError('INVALID_ARGUMENT', legacy);
  const r = schema.safeParse(parsed);
  if (!r.success) return toolError('INVALID_ARGUMENT', r.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '));
  const args = r.data as never;
  const state = host.state();
  switch (name as ToolName) {
    case 'read_project': {
      const a = args as z.infer<(typeof TOOL_ARGS)['read_project']>;
      // The site's own code is read alone, so no summary beside it can push it past what one result holds.
      if (a.sections?.includes('siteCode')) return { ok: true, content: { revision: host.revision(), siteCode: siteCodeRead(state) } };
      const out: Record<string, unknown> = projectSummary(state, host.revision());
      if (a.sections?.includes('tokens')) {
        out.tokens = tokensSummary(state);
        // Which palettes visitors get: "single", or a dark palette beside the light one ("system", "toggle").
        out.colorSchemeMode = colorSchemeMode(state.tokens);
      }
      if (a.sections?.includes('catalogue')) {
        out.catalogue = catalogueIndex(state.site.themeId);
        out.icons = Object.keys(ICONS);
      }
      if (a.sections?.includes('components'))
        out.installedComponents = Object.values(state.components).map((d) => ({ definitionId: d.id, componentId: d.componentId, name: d.name, owner: d.owner, kind: d.kind }));
      out.styleProperties = STYLE_PROPS.map((p) => `${p.id}${p.tokenGroup ? ` (token: ${p.tokenGroup}${p.containerTokens ? `, of container only ${p.containerTokens.join(' or ')}` : ''})` : ''}${p.options ? ` [${p.options.map((o) => o.value).join('|')}]` : ''}${p.kind === 'focus' ? ' or "X% Y%": the focal point across and down a cropped image, each 0 to 100 with at most one decimal, such as "50% 20%"' : ''}${valueHint(p)}`);
      return { ok: true, content: out };
    }
    case 'read_page': {
      const a = args as z.infer<(typeof TOOL_ARGS)['read_page']>;
      const resolved = pageIdFor(state, a.pageId);
      if (resolved) a.pageId = resolved;
      const detail = resolved ? pageDetail(state, resolved) : null;
      if (!detail) return toolError('INVALID_ARGUMENT', `No page "${a.pageId}". Pages: ${state.site.pageOrder.join(', ')}`);
      if (a.nodeId) {
        const page = state.pages[a.pageId];
        if (!page.nodes[a.nodeId]) return toolError('INVALID_ARGUMENT', `No node "${a.nodeId}" on this page.`);
        return { ok: true, content: { revision: host.revision(), owner: detail.owner, node: compactNode(state, page, a.nodeId) } };
      }
      return { ok: true, content: { revision: host.revision(), ...detail } };
    }
    case 'inspect_element': {
      const a = args as z.infer<(typeof TOOL_ARGS)['inspect_element']>;
      // A run limited to a collection's layout reads that layout alone, never the page behind it.
      const layout = host.layoutLimit?.() ?? null;
      if (layout && (a.owner.kind !== layout.owner.kind || a.owner.id !== layout.owner.id)) return toolError('SCOPE_MISMATCH', `This request is about ${layout.label}: read its nodes with owner { "kind": "${layout.owner.kind}", "id": "${layout.owner.id}" }.`);
      if (a.prop !== undefined) {
        const read = readField(state, { owner: a.owner, nodeId: a.nodeId, prop: a.prop, itemId: a.itemId, field: a.field, offset: a.offset });
        if (!read.ok) return toolError('INVALID_ARGUMENT', read.message);
        return { ok: true, content: { revision: host.revision(), ...read.content } };
      }
      if (a.itemId !== undefined || a.field !== undefined || a.offset !== undefined) return toolError('INVALID_ARGUMENT', 'itemId, field and offset read one field: name its prop too.');
      try {
        const tree = getTree(state, a.owner);
        const n = tree.nodes[a.nodeId];
        if (!n) return toolError('INVALID_ARGUMENT', `No node "${a.nodeId}".`);
        const parent = findParent(tree, a.nodeId);
        const out: Record<string, unknown> = {
          revision: host.revision(),
          owner: a.owner,
          // Full props, with a table too large to show whole given every row ID and its cells shortened.
          node: n.kind === 'instance' ? { ...n, props: agentProps(state.components[n.definitionId], n.props, state.pages, true) } : { ...n },
          displayName: displayName(state, n),
          parent: parent ? { parentId: parent.parentId, slot: parent.slot, index: parent.index, siblings: parent.list.length } : null
        };
        if (n.kind === 'instance' && state.components[n.definitionId]) {
          out.component = componentDetail(state.components[n.definitionId]);
          // What a newer theme version adds, and whether this project can take it.
          const update = themeUpdateNote(state, state.components[n.definitionId]);
          if (update) out.themeUpdate = update;
        }
        return { ok: true, content: out };
      } catch (e) {
        return toolError('INVALID_ARGUMENT', (e as Error).message);
      }
    }
    case 'search_components': {
      const a = args as z.infer<(typeof TOOL_ARGS)['search_components']>;
      const limit = a.limit ?? 8;
      const themed = searchCatalogue(state.site.themeId, a.query, limit).map((e) => ({ score: searchScore(a.query, e.name, `${e.description} ${e.tags.join(' ')} ${e.category} ${e.componentId}`), hit: { componentId: e.componentId, name: e.name, description: e.description, variants: e.axes, ...(e.block ? { block: true } : {}) } }));
      const project = searchProjectComponents(state, a.query, limit).map((d) => ({ score: searchScore(a.query, d.name, `${d.description ?? ''} ${(d.tags ?? []).join(' ')}`), hit: { definitionId: d.id, name: d.name, description: d.description, kind: d.kind, projectComponent: true } }));
      // One list, best first within the limit; a theme component comes first where they match as well.
      const results = [...themed, ...project]
        .map((r, i) => ({ ...r, i }))
        .sort((x, y) => y.score - x.score || x.i - y.i)
        .slice(0, limit)
        .map((r) => r.hit);
      return { ok: true, content: { results } };
    }
    case 'read_component': {
      const a = args as z.infer<(typeof TOOL_ARGS)['read_component']>;
      // A theme component already in the project is described as installed: a newer theme's properties (a heading
      // level, say) are not there until it is updated, and placing it uses the installed one. What the newer version
      // adds is said beside it (themeUpdate), with whether this project can take it.
      const themed = a.componentId ? catalogueComponent(state.site.themeId, a.componentId) : undefined;
      const installed = themed && Object.hasOwn(state.components, themed.id) ? state.components[themed.id] : undefined;
      // An own key only: "constructor" is no component either.
      const def = a.definitionId ? (Object.hasOwn(state.components, a.definitionId) ? state.components[a.definitionId] : undefined) : (installed ?? themed);
      if (!def) return toolError('INVALID_ARGUMENT', 'Component not found. Use search_components.');
      // A design read part by part: the contract came with the first part.
      if (a.structure && a.offset) return { ok: true, content: { definitionId: def.id, structure: componentStructure(state, def, a.offset) } };
      const update = themeUpdateNote(state, Object.hasOwn(state.components, def.id) && state.components[def.id] === def ? def : undefined);
      const updateNote = update ? { themeUpdate: update } : {};
      if (a.structure) {
        // The first part shares one result with the contract. When the two would not fit one result whole (and so
        // lose the next part's offset), the design is read alone and the contract is left to a read without structure.
        const contract = { ...componentDetail(def), ...updateNote };
        const both = { ...contract, structure: componentStructure(state, def, 0, MAX_RESULT_CHARS - 1000 - JSON.stringify(contract).length) };
        if (JSON.stringify(both).length <= MAX_RESULT_CHARS - 200) return { ok: true, content: both };
        return { ok: true, content: { definitionId: def.id, note: 'Its contract is long: read_component without structure shows it.', structure: componentStructure(state, def, 0, MAX_RESULT_CHARS - 1000) } };
      }
      const examples = examplesFor(state, def.componentId).map(exampleSection);
      return { ok: true, content: { ...componentDetail(def), ...updateNote, ...(examples.length ? { workedExamples: examples } : {}) } };
    }
    case 'search_assets': {
      const a = args as z.infer<(typeof TOOL_ARGS)['search_assets']>;
      const q = (a.query ?? '').toLowerCase();
      // Fonts are assets too, but never images: they are left out before the limit.
      const list = Object.values(state.assets.assets)
        .filter((x) => !!x && libraryImage(state, x.id) === x && (!q || `${x.name} ${x.description ?? ''} ${x.altSuggestion ?? ''}`.toLowerCase().includes(q)))
        .slice(0, a.limit ?? 20)
        .map(assetSummary);
      const assets = fitAssets(list);
      return { ok: true, content: { assets, note: `Image contents are not available; rely on names and descriptions. A description is a private note: never use it as alt text.${assets !== list ? SHORTENED_ASSETS : ''}` } };
    }
    case 'apply_operations': {
      const a = args as z.infer<(typeof TOOL_ARGS)['apply_operations']>;
      const ops = a.operations as unknown as EditOperation[];
      // Page IDs are allocated by the app; only its own page tool may pass one through.
      if (ops.some((o) => o.type === 'page.create' && o.pageId !== undefined)) return toolError('INVALID_ARGUMENT', 'page.create does not take a pageId.');
      // Node IDs too: the result of each node.insert names the node it made.
      if (ops.some((o) => o.type === 'node.insert' && o.newNodeId !== undefined)) return toolError('INVALID_ARGUMENT', 'node.insert does not take a newNodeId.');
      // So are new components' IDs: the result of each component.create names the component it made.
      if (ops.some((o) => o.type === 'component.create' && o.definitionId !== undefined)) return toolError('INVALID_ARGUMENT', 'component.create does not take a definitionId.');
      // A whole design is built through a tool of its own; the raw operation is never offered.
      if (ops.some((o) => o.type === 'component.upsert'))
        return toolError('INVALID_ARGUMENT', 'component.upsert is not available here. Build or rebuild a whole component with upsert_managed_component where it is offered, or with component.create and the node and component operations.');
      // Source is patched through its own tool, against the revision and hash it was read at.
      if (ops.some((o) => o.type === 'component.updateSource'))
        return toolError('INVALID_ARGUMENT', "component.updateSource is not available here. Change a code component's source with apply_source_patch, with the revision and hash read_source returns.");
      // A list or loop is connected through its own tool, whose query is checked closed.
      if (ops.some((o) => o.type === 'instance.setListSource' || o.type === 'node.setRepeatSource'))
        return toolError('INVALID_ARGUMENT', 'instance.setListSource and node.setRepeatSource are not available here. Connect a list, or change a collection loop\'s entries, with connect_collection_list.');
      // A theme update is one component the request needs, through its own tool: never every outdated one at once.
      if (ops.some((o) => o.type === 'theme.refresh'))
        return toolError('INVALID_ARGUMENT', 'theme.refresh is not available here. Update one installed theme component the request needs with update_theme_component, then make the change.');
      // The copy goes right after the original; placing it elsewhere is a node.move of the copy it returns.
      if (ops.some((o) => o.type === 'node.duplicate' && o.index !== undefined)) return toolError('INVALID_ARGUMENT', 'node.duplicate does not take an index.');
      // Keeping every use's alt text is for the app's own web-sized copies, which are the same picture.
      if (ops.some((o) => o.type === 'asset.replace' && o.keepAlt !== undefined)) return toolError('INVALID_ARGUMENT', 'asset.replace does not take keepAlt: uses with the old image’s suggested alt text take the new one’s, and its result lists the uses whose alt text to check.');
      // Choosing some uses is the author's, from the places Assets lists; the AI replaces an image everywhere.
      if (ops.some((o) => o.type === 'asset.replace' && o.uses !== undefined)) return toolError('INVALID_ARGUMENT', 'asset.replace does not take uses: it replaces the image wherever it is used. To change one place, set that image value instead.');
      // A swap keeps every piece of content or is refused, naming what has no place: content goes only by an edit that says so.
      if (ops.some((o) => o.type === 'instance.swapComponent' && o.allowDrops !== undefined))
        return toolError('INVALID_ARGUMENT', 'instance.swapComponent does not take allowDrops. Pick a design with a place for the content, or, if the user asked for that content to go, clear it with instance.setProp first and then swap.');
      // site.update replaces the site's code whole: a run replaces only code it can read whole (read_project siteCode).
      const unread = siteCodeUnread(state, ops);
      if (unread) return toolError('INVALID_ARGUMENT', unread);
      const before = host.diagnostics();
      const res = await host.apply(ops, a.expectedRevision, labelForOps(ops, state), callId, undefined, a.scope);
      if (!res.ok) {
        // A batch that creates a page and refers to it in the same call cannot work: the page has no ID yet.
        const dependent = refersToNewPage(ops, res.error?.message ?? '');
        const hint = dependent
          ? 'Nothing in this batch was applied, including its page.create. A new page cannot be referred to in the batch that creates it: create the page alone, then fill it in your next step with the pageId and revision that call returns.'
          : undefined;
        return applyFailure(res, hint);
      }
      // A component this batch made or changed that every placement would show the same way is said now, while the
      // model still has its node IDs to hand.
      const reuse = componentWarnings(introducedReusability(before, host.diagnostics(), () => changedComponents(state, host.state())));
      return { ok: true, mutated: true, ops, results: res.results, content: { ok: true, revision: res.revision, results: res.results, ...reuse } };
    }
    case 'read_source': {
      const a = args as z.infer<(typeof TOOL_ARGS)['read_source']>;
      const def = Object.hasOwn(state.components, a.definitionId) ? state.components[a.definitionId] : undefined;
      if (!def) return toolError('INVALID_ARGUMENT', 'Unknown component.');
      if (def.kind !== 'code') return { ok: true, content: { definitionId: def.id, revision: host.revision(), editable: false, note: 'This is a managed component. Its source is generated: read_component with structure shows its design, and operations edit it. A copy can be converted to code with component.convertToCode.' } };
      const lines = (def.source ?? '').split('\n');
      const start = (a.startLine ?? 1) - 1;
      const end = Math.min(lines.length, a.endLine ?? start + 400);
      const editable = def.owner === 'project';
      // A patch replaces the whole property schema with the code, so the code that can be patched is read with it; a
      // theme's code says how to get a copy that can.
      const manifest = editable ? (start === 0 ? { properties: def.properties, propertiesHash: propertiesHash(def.properties) } : {}) : themeCodeCopy(state, def, host);
      return { ok: true, content: { definitionId: def.id, revision: host.revision(), editable, hash: sourceHash(def.source ?? ''), totalLines: lines.length, startLine: start + 1, endLine: end, source: lines.slice(start, end).join('\n'), ...manifest } };
    }
    case 'apply_source_patch': {
      const a = args as z.infer<(typeof TOOL_ARGS)['apply_source_patch']>;
      const def = Object.hasOwn(state.components, a.definitionId) ? state.components[a.definitionId] : undefined;
      if (def?.kind === 'code' && def.owner !== 'project') return toolError('PATH_DENIED', themeCodeCopy(state, def, host).note);
      if (!def || def.kind !== 'code') return toolError('PATH_DENIED', 'Only project code components can be patched.');
      let src = def.source ?? '';
      // Bound to the project as it was read, like any other change: an edit in between (to this component's contract,
      // say) can make a patch written against the old one wrong even when the source itself did not change.
      if (a.expectedRevision !== host.revision())
        return toolError('STALE_REVISION', `This patch was written against revision ${a.expectedRevision}, but the project is at ${host.revision()}. Call read_source again and write the patch against what it returns.`, { revision: host.revision() });
      if (sourceHash(src) !== a.expectedHash) return toolError('STALE_REVISION', 'The source changed. Call read_source again.', { revision: host.revision() });
      // New properties replace the whole schema, so they are bound to the one they were written from, as the code is.
      if (a.properties && a.expectedPropertiesHash === undefined) return toolError('INVALID_ARGUMENT', 'properties needs expectedPropertiesHash: the propertiesHash read_source returned.');
      if (a.properties && a.expectedPropertiesHash !== propertiesHash(def.properties)) return toolError('STALE_REVISION', 'The properties changed. Call read_source again.', { revision: host.revision() });
      if (a.source !== undefined) src = a.source;
      else for (const e of a.edits ?? []) {
        const count = src.split(e.find).length - 1;
        if (count !== 1) return toolError('INVALID_ARGUMENT', `"${e.find.slice(0, 60)}" matched ${count} times; it must match exactly once.`);
        // Inserted as written: a replacement holding $& or $1 is code, never a pattern.
        src = src.replace(e.find, () => e.replace);
      }
      // The properties travel in the same operation, so the code is checked against the contract it lands with.
      const ops: EditOperation[] = [{ type: 'component.updateSource', definitionId: def.id, source: src, expectedHash: a.expectedHash, ...(a.properties ? { properties: a.properties, expectedPropertiesHash: a.expectedPropertiesHash } : {}), ...(a.renames?.length ? { renames: a.renames } : {}) }];
      const res = await host.apply(ops, a.expectedRevision, `Edit ${def.name} source`, callId, undefined, a.scope);
      if (!res.ok) return applyFailure(res);
      const compile = (await host.compileAll()).filter((d) => d.severity === 'error');
      return { ok: true, mutated: true, ops, content: { ok: true, revision: res.revision, hash: sourceHash(src), compileErrors: compile.map((d) => d.message) } };
    }
    case 'inspect_layout': {
      const a = args as z.infer<(typeof TOOL_ARGS)['inspect_layout']>;
      const resolved = pageIdFor(state, a.pageId);
      if (!resolved) return toolError('INVALID_ARGUMENT', 'Unknown page.', { details: { viewport: a.viewport } });
      a.pageId = resolved;
      // A narrowed check names the elements it measured, so it is never read as a check of the whole page.
      let targets: ElementRef[] | undefined;
      if (a.refs) {
        const found = resolveLayoutTargets(state, resolved, a.refs);
        if (!found.ok) return toolError('INVALID_ARGUMENT', found.message, { details: { pageId: resolved, viewport: a.viewport } });
        targets = found.targets;
      }
      // Measured from the project as the call read it.
      if (!targets) return measurePage((pageId, width) => host.inspectLayout(pageId, width), resolved, a.viewport, revision);
      try {
        const report = (await host.inspectLayout(a.pageId, WIDTHS[a.viewport], { targets })) as { error?: unknown; targets?: unknown } | null;
        // One measurement per element asked for, each saying whether it shows and where it rendered.
        // An element the preview could not measure is no answer, never one that does not show.
        const answered = (t: unknown) => {
          const m = t as { visible?: unknown; elements?: unknown } | null;
          return !!m && typeof m === 'object' && typeof m.visible === 'boolean' && Array.isArray(m.elements) && !m.elements.some((e) => !e || typeof e !== 'object' || (e as { measured?: unknown }).measured === false);
        };
        const measured = Array.isArray(report?.targets) && report.targets.length === targets.length && report.targets.every(answered) ? (report.targets as Array<Record<string, unknown>>) : null;
        // A preview that is not running or did not load is a failed check, never a clean result; nor is a narrowed
        // check that did not say what it found for each element.
        if (!report || typeof report !== 'object' || report.error || !measured)
          return toolError('VALIDATION_FAILED', `Layout could not be inspected: ${String(report?.error ?? (report ? 'the elements were not measured' : 'no report'))}`, { details: { pageId: resolved, viewport: a.viewport } });
        const envelope = { revision, pageId: resolved, viewport: a.viewport, width: WIDTHS[a.viewport], scope: 'elements' as const };
        const shaped = { ...report, targets: measured.map((t, i) => ({ ref: targetRef(a.refs![i]), ...t })) };
        return { ok: true, content: { ...envelope, report: fitInspection(envelope, shaped) } };
      } catch (e) {
        return toolError('VALIDATION_FAILED', `Layout could not be inspected: ${(e as Error).message}`, { details: { pageId: resolved, viewport: a.viewport } });
      }
    }
    case 'inspect_component': {
      const a = args as z.infer<(typeof TOOL_ARGS)['inspect_component']>;
      const target = resolveInspectTarget(state, a);
      if ('error' in target) return toolError('INVALID_ARGUMENT', target.error);
      const cases = planComponentInspection(target);
      const offset = a.offset ?? 0;
      // Which check could not run, as a result that did would name it.
      const which = { definitionId: target.def.id, ...(target.placement ? { placement: target.placement } : {}), ...(offset ? { offset } : {}) };
      // Never one of the sweep's windows: a call past its end leaves a check that measured every case a clean one.
      if (offset >= cases.length) return toolError('INVALID_ARGUMENT', `There are ${cases.length} cases to measure; offset ${offset} is past the last.`);
      const failed = (message: string, recoverable?: boolean) => toolError('VALIDATION_FAILED', `The component could not be inspected: ${message}`, { details: which, recoverable });
      // No call in this run can measure it.
      if (!host.inspectComponent) return failed('measuring a component is not available here.', false);
      const window = cases.slice(offset, offset + MAX_CASES);
      const revision = host.revision();
      let results: ComponentPreviewResult[];
      try {
        results = await host.inspectComponent(inspectionSteps(target, window));
      } catch (e) {
        return failed((e as Error).message);
      }
      // Measured against a project that changed meanwhile: it says nothing certain about either.
      if (host.revision() !== revision) return toolError('STALE_REVISION', 'The project changed while the component was measured. Inspect it again.', { details: which, revision: host.revision() });
      const digest = digestComponentInspection(target, window, Array.isArray(results) ? results : [], { offset, total: cases.length, all: cases });
      // Nothing measured is a check that could not run, never a clean component.
      if (!digest.measured) return failed(String((digest.content.failed as Array<{ error: string }> | undefined)?.[0]?.error ?? 'the preview gave no measurements.'));
      return { ok: true, content: fitComponentCheck({ revision, ...digest.content }) };
    }
    case 'validate_project':
      return runValidateProject(args as z.infer<typeof VALIDATE_ARGS>, host);
    case 'audit_seo': {
      const report = seoReport(state, host.revision(), args as z.infer<typeof AUDIT_SEO_ARGS>, MAX_RESULT_CHARS - 200);
      return report.ok ? { ok: true, content: report.content } : toolError('INVALID_ARGUMENT', report.message);
    }
    case 'locate_field': {
      const a = args as z.infer<(typeof TOOL_ARGS)['locate_field']>;
      const target = { owner: a.owner, nodeId: a.nodeId, prop: a.prop, ...(a.itemId !== undefined ? { itemId: a.itemId } : {}), ...(a.field !== undefined ? { field: a.field } : {}) };
      const found = locateField(state, target);
      if (!found.ok) return toolError('INVALID_ARGUMENT', [found.message, found.hint].filter(Boolean).join(' '));
      const path = found.path.join(' → ');
      return {
        ok: true,
        location: { ...target, owner: found.owner, path: found.path },
        content: {
          revision: host.revision(),
          path,
          value: found.value,
          // A choice is stored by its value; the Inspector shows its label.
          ...(found.shown !== undefined ? { shownAs: found.shown } : {}),
          note: `Give the author this path exactly as written. The chat shows an "Open in inspector" button for it.`
        }
      };
    }
    case 'set_preview':
      return runSetPreview(args as z.infer<(typeof TOOL_ARGS)['set_preview']>, host);
    case 'step_history': {
      const a = args as z.infer<(typeof TOOL_ARGS)['step_history']>;
      if (!host.stepHistory) return toolError('SCOPE_MISMATCH', 'Undo and Redo cannot be run from this request. The author can use Undo and Redo in the toolbar.', { recoverable: false });
      const steps = a.steps ?? 1;
      const r = await host.stepHistory(a.direction, steps);
      if (!r.ok) return applyFailure({ revision: r.revision, error: r.error ?? { code: 'CONFLICT', message: `Could not ${a.direction}.`, recoverable: false } });
      const did = a.direction === 'undo' ? 'Undid' : 'Redid';
      // It changed the project, as the toolbar's step does, but no operation of the run's: History holds the step.
      return {
        ok: true,
        mutated: true,
        ops: [],
        content: {
          revision: r.revision,
          direction: a.direction,
          steps,
          ...(r.label ? { label: r.label } : {}),
          note: `${did} ${r.label ? `"${r.label}"` : `${steps} changes`}. This request can change nothing more: tell the user what was ${a.direction === 'undo' ? 'undone' : 'redone'}, and that ${a.direction === 'undo' ? 'Redo puts it back' : 'Undo takes it back again'}.`
        }
      };
    }
    case 'request_clarification': {
      const a = args as z.infer<(typeof TOOL_ARGS)['request_clarification']>;
      // The whole offer is checked before the user is asked: a question never shows a picture that is not there.
      const ids = [...new Set(a.assetIds ?? [])];
      if (ids.length && a.widenScope) return toolError('INVALID_ARGUMENT', 'A widenScope question takes no assetIds: ask about the images in a separate question.');
      const missing = ids.filter((id) => libraryImage(state, id) === null);
      if (missing.length) return toolError('INVALID_ARGUMENT', `No library image has the assetId ${missing.map((id) => `"${id}"`).join(', ')}. Use the assetIds search_assets returns.`);
      const images = ids.map((id) => imageRef(libraryImage(state, id)!));
      const answer = await host.ask(a.question, a.choices ?? [], a.widenScope, images.length ? images : undefined);
      return { ok: true, content: answered(answer, host) };
    }
    case 'upsert_page_with_sections':
      return runUpsert(args as z.infer<typeof UPSERT_ARGS>, host, callId, (host.macros ??= newMacroMemory()));
    case 'upsert_managed_component':
      return runManagedComponent(args, host, callId, (host.macros ??= newMacroMemory()));
    case 'update_site_brand':
      return runBrand(args as z.infer<typeof BRAND_ARGS>, host, callId);
    case 'update_page_seo':
      return runPageSeo(args as z.infer<typeof PAGE_SEO_ARGS>, host, callId);
    case 'update_site_seo':
      return runSiteSeo(args as z.infer<typeof SITE_SEO_ARGS>, host, callId);
    case 'list_collection_entries':
      return runListEntries(args as z.infer<typeof LIST_ENTRIES_ARGS>, host);
    case 'read_collection_entry':
      return runReadEntry(args as z.infer<typeof READ_ENTRY_ARGS>, host);
    case 'upsert_collection_entry':
      return runUpsertEntry(args as z.infer<typeof UPSERT_ENTRY_ARGS>, host, callId);
    case 'define_collection':
      return runDefineCollection(args as z.infer<typeof DEFINE_COLLECTION_ARGS>, host, callId);
    case 'connect_collection_list': {
      const a = args as z.infer<typeof CONNECT_LIST_ARGS>;
      const layout = host.layoutLimit?.() ?? null;
      if (layout && (a.owner.kind !== layout.owner.kind || a.owner.id !== layout.owner.id)) return toolError('SCOPE_MISMATCH', `This request may change only ${layout.label}. Nothing was applied.`);
      return runConnectList(a, host, callId);
    }
    case 'read_layout':
      return readLayout(args as z.infer<(typeof TOOL_ARGS)['read_layout']>, host);
    case 'inspect_source_sample':
      return runInspectSource(args as z.infer<typeof INSPECT_SOURCE_ARGS>, host);
    case 'write_source_converter':
      return runWriteSource(args as z.infer<typeof WRITE_SOURCE_ARGS>, host, callId);
    case 'update_theme_component':
      return runUpdateThemeComponent(args as z.infer<typeof UPDATE_THEME_COMPONENT_ARGS>, host, callId);
    case 'update_selected_props':
    case 'edit_selected_list':
    case 'edit_selected_table':
    case 'style_selected_element':
    case 'request_wider_scope':
      return runSelectionTool(name as keyof typeof SELECTION_ARGS, args, host, callId);
    case 'edit_definition_node':
    case 'bind_definition_field':
    case 'manage_component_prop':
    case 'manage_component_state':
    case 'style_definition_element':
    case 'add_definition_variant':
    case 'insert_definition_node':
    case 'remove_definition_node':
      return runDefinitionTool(name as DefinitionToolName, args, host, callId);
  }
}

/** read_layout: the collection layout a run limited to one reads, as it is now (#679). */
function readLayout(args: { nodeId?: string }, host: ToolHost): ToolOutcome {
  const layout = host.layoutLimit?.() ?? null;
  if (!layout) return toolError('INVALID_ARGUMENT', 'read_layout reads the collection layout a request was sent from while it was open; this request was not.');
  const detail = layoutDetail(host.state(), layout.owner, args.nodeId);
  if (!detail) return toolError('INVALID_ARGUMENT', args.nodeId !== undefined && layoutTree(host.state(), layout.owner) ? `No node "${args.nodeId}" in ${layout.label}.` : `${layout.label[0].toUpperCase()}${layout.label.slice(1)} is no longer in the site.`);
  return { ok: true, content: { revision: host.revision(), ...detail } };
}

/** Whether a rejected batch failed on a page it was creating itself, named by its route or title. */
function refersToNewPage(ops: EditOperation[], message: string): boolean {
  const ref = message.match(/\bpage "([^"]*)" does not exist/i)?.[1]?.trim();
  if (!ref) return false;
  const asRoute = normalizeRoute(ref);
  return ops.some((o) => o.type === 'page.create' && (normalizeRoute(o.route ?? addressSlug(o.title)) === asRoute || o.title.trim().toLowerCase() === ref.toLowerCase()));
}

export function labelForOps(ops: EditOperation[], state: ProjectState): string {
  const first = ops[0];
  if (!first) return 'Edit';
  const page = (id: string) => state.pages[id]?.title ?? 'page';
  switch (first.type) {
    case 'page.create':
      return `Add page ${first.title}`;
    case 'node.insert':
      return `Insert ${first.componentId ?? first.primitive ?? 'component'}`;
    case 'instance.setProp':
      return `Edit ${first.prop}`;
    case 'token.set':
      return `Change ${first.tokenId}`;
    case 'page.update':
      return `Update ${page(first.pageId)}`;
    default:
      return first.type.replace('.', ' ');
  }
}

