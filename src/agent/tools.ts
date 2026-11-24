import { z } from 'zod';
import type { AssetRecord, ProjectState } from '@shared/types';
import type { ChatImageRef, FieldLocation } from '@shared/api';
import type { EditOperation } from '@shared/ops';
import { EditOperationSchema, legacyShellError, OPERATION_SCHEMAS, PROP_OR_ITEM_BINDING, type OperationType } from '@shared/ops';
import { MAX_GRID_TRACKS, STYLE_PROPS, TRANSLATE_LIMITS, type StylePropDef } from '@shared/styles';
import { addressSlug, normalizeRoute } from '@shared/routes';
import { catalogueComponent, searchCatalogue } from '@catalogue/index';
import { ICONS } from '@catalogue/foundation/icons';
import { sourceHash } from '@engine/apply';
import type { Diagnostic } from '@engine/validate';
import type { ModelCapabilities, ToolDefinition } from './types';
import { agentProps, catalogueIndex, compactNode, componentDetail, componentStructure, pageDetail, pageIdFor, projectSummary, readField, selectionAbridged, tokensSummary } from './context';
import { AUDIT_SEO_ARGS, seoReport } from './seo-report';
import { getTree, findParent, displayName } from '@engine/tree';
import { newMacroMemory, runUpsert, UPSERT_ARGS, UPSERT_BRIEF, UPSERT_DESCRIPTION, upsertToolSchema, type MacroMemory } from './macros';
import { BRAND_ARGS, BRAND_BRIEF, BRAND_DESCRIPTION, brandToolSchema, runBrand } from './brand';
import { MANAGED_COMPONENT_ARGS, MANAGED_COMPONENT_BRIEF, MANAGED_COMPONENT_DESCRIPTION, managedComponentSchema, runManagedComponent } from './managed-component';
import { runSelectionTool, SELECTION_ARGS, SELECTION_BRIEFS, SELECTION_DESCRIPTIONS, selectionTools, type SelectionTarget } from './selection';
import { DEFINITION_ARGS, DEFINITION_BRIEFS, DEFINITION_DESCRIPTIONS, definitionAbridged, definitionTools, runDefinitionTool, type DefinitionTarget, type DefinitionToolName } from './definition';
import { examplesFor, exampleSection } from './examples';
import { locateField } from '@engine/locate';
import { CODE_OPERATIONS, developerModeReason } from '@engine/developer-mode';
import { changedComponents, componentWarnings, introducedReusability } from './reusability';
import { isReusabilityWarning } from '@engine/reusability';
import { OP_REACH, type AuthorityGrants } from './scope';
import { digestComponentInspection, inspectionSteps, MAX_CASES, planComponentInspection, resolveInspectTarget } from './component-inspection';
import type { ComponentPreviewResult, ComponentPreviewStep } from '@shared/component-preview';

const owner = z.object({ kind: z.enum(['page', 'shell', 'component', 'template']), id: z.string() });

export const TOOL_ARGS = {
  read_project: z.object({ sections: z.array(z.enum(['pages', 'tokens', 'catalogue', 'components', 'shell'])).optional() }),
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
    scope: z
      .object({ kind: z.enum(['selection', 'page', 'component', 'site']), targetIds: z.array(z.string()).optional() })
      .optional()
      .describe('Optional note of what this batch is meant to change. The app decides what may change.'),
    operations: z.array(EditOperationSchema).min(1).max(30)
  }),
  read_source: z.object({ definitionId: z.string(), startLine: z.number().int().min(1).optional(), endLine: z.number().int().optional() }),
  apply_source_patch: z.object({
    definitionId: z.string(),
    expectedHash: z.string().describe('Hash returned by read_source.'),
    edits: z.array(z.object({ find: z.string(), replace: z.string() })).optional().describe('Exact text replacements applied in order. Each find must match exactly once.'),
    source: z.string().optional().describe('Full replacement source, instead of edits.')
  }),
  inspect_layout: z.object({ pageId: z.string(), viewport: z.enum(['phone', 'tablet', 'desktop']) }),
  inspect_component: z.object({
    definitionId: z.string().optional().describe('A component of the project.'),
    componentId: z.string().optional().describe('Or a theme catalogue component, whether or not the project has it yet.'),
    owner: owner.optional().describe('Or, with nodeId, a placement: its own content and variant choices are the starting point.'),
    nodeId: z.string().optional(),
    offset: z.number().int().min(0).optional().describe('Continue a sweep: the offset a previous call returned in next.')
  }),
  validate_project: z.object({ profile: z.enum(['schema', 'component']).optional() }),
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
  upsert_managed_component: MANAGED_COMPONENT_ARGS,
  ...SELECTION_ARGS,
  ...DEFINITION_ARGS
} as const;

export type ToolName = keyof typeof TOOL_ARGS;

const CONTRACT_READ = 'Read a component contract: property schema, parts, variants, slots and examples. Use before inserting or editing an unfamiliar component.';

const DESCRIPTIONS: Record<ToolName, string> = {
  read_project: 'Project summary: revision, pages (IDs and routes), shared header/footer, project components. Optional sections add site tokens, or the theme catalogue: every component with its compact property signature, style parts and variants, plus the valid icon names.',
  read_page: 'Read a page: its sections and their component instances, props (with list item IDs), variants, style overrides and nested content.',
  inspect_element:
    'Inspect one node: full props, the component property schema, public parts with allowed style controls, variants, slots and its position in the tree. With prop, read one content field whole instead (long rich text as Markdown), a part at a time: call again with the offset each part returns until next is null.',
  search_components: 'Search the theme catalogue and project components by keywords. Returns componentIds or definitionIds you can insert with node.insert.',
  read_component: `${CONTRACT_READ} structure adds how its design is built.`,
  search_assets: 'List imported images by name and description, with the assetId that identifies each one (two images can share a name). You cannot see image contents.',
  apply_operations:
    'Apply a batch of typed edit operations atomically. This is the only way to change the website. Every operation is validated; on error nothing in the batch is applied and you get the exact problem. Operations refer to pages by ID: to fill a page you create, use the pageId this call returns in your next step. Call it at most once per step (one response of yours); the request carries on in your next step without the user replying.',
  read_source: 'Read the Svelte source of a component. Generated managed sources are read-only; project code components can be patched.',
  apply_source_patch: 'Change the source of a project code component (never generated files, config or dependencies). Requires the hash from read_source.',
  inspect_layout:
    'Measure a page in the live preview at a viewport width: overflow, images (report.images; unverified ones were still loading, not a site problem), alt text, headings, runtime errors, and readability (counts in report.checks): text contrast against its painted background, overlapping boxes, cut-off text, tap targets under 44px below 768px. Each finding\'s ref is the owner, nodeId, partId and itemId node.setStyle takes; contrast-unverified is text only pixels could judge (over an image). No screenshots.',
  inspect_component:
    'Check one component on its own, off-screen, without changing anything: it is measured at phone (390px) and desktop (1280px) width with every link set and empty text filled, in each option of every variant axis, and with stress content: long text with an unbroken long word, links and optional text left empty, one and five list items. Returns each overflow, cut-off text, low contrast, overlap, small tap target, runtime error and spacing collapse once, with the cases and widths it showed in and where it is in the design: at.nodeId is the node of its design (node.setStyle { owner: { kind: "component", id: definitionId }, nodeId } changes it on every placement) and at.partId the part it belongs to. The design of a theme component changes on a project copy: component.fork it first (one the project does not have yet is added by placing it) and use the definitionId that returns. A clean component gets a one-line summary. Use after building or changing a reusable component, then fix what it finds and check again.',
  validate_project: 'Run validation: "schema" checks references, routes and structure; "component" also compiles every Svelte component.',
  audit_seo:
    'Audit how well the website can be found, shared and understood by search engines, link previews and AI agents, from the saved project (it changes and measures nothing): its public URL, search settings, browser titles and descriptions (missing, repeated, too short or long), sharing image and icon, link wording, pages no other page links to, and the pictures and headings in collection entries. Returns findings most serious first, each with its code, pillar, whether an edit of yours can fix it (aiFixable) and where it is fixed (fix), why it matters (reason, an index into reasons), counts by severity and pillar, and the internal links: how many links lead into and out of each published page, with orphans that nothing else links to. pageId (an ID or route) narrows it to one page: its own findings, and which pages, shared header or footer, or entries link to it. pillar keeps one kind of finding. A long report comes in parts: call again with offset set to nextOffset, or linkOffset set to links.nextLinkOffset, and after a change to the site start again from the first part.',
  request_clarification:
    'Ask the user one question and wait for the answer. Use it when the user asks you to interview them, ask them something or let them choose; whenever you would offer them a few options to pick from (instead of listing the options in your reply); and when a request is ambiguous enough that a wrong guess would change shared content. Put up to four short, concrete options in choices; the user can also type their own answer. To let the user choose between library images, pass their assetIds instead of naming them in choices: the user sees the pictures, which you cannot. One question per call: ask the next one after the answer comes back.',
  locate_field:
    'Find where the author changes one content field in the editor. Returns its current value and the exact labels the Inspector shows on the way to it (page, component, Content, then the field or the list, its item and the field), and gives the author an "Open in inspector" button for it.',
  upsert_page_with_sections: UPSERT_DESCRIPTION,
  update_site_brand: BRAND_DESCRIPTION,
  upsert_managed_component: MANAGED_COMPONENT_DESCRIPTION,
  ...SELECTION_DESCRIPTIONS,
  ...DEFINITION_DESCRIPTIONS
};

/**
 * The descriptions' rules in fewer words, for a grammar-constrained local model (see `ToolDefinition.brief`). Empty:
 * the name and signature say it all. A tool missing here keeps its description.
 */
const BRIEFS: Partial<Record<ToolName, string>> = {
  read_project: 'Revision, pages (IDs and routes), header/footer and project components. sections adds site tokens, or the catalogue: every component with its properties, parts and variants, and the icon names.',
  read_page: 'Its sections with props (and list item IDs), variants, styles and nested content.',
  inspect_element: 'One node: props, property schema, parts with their style controls, variants, slots and place in the tree. With prop, one content field whole (rich text as Markdown), a part at a time: call again with each offset returned until next is null.',
  search_components: 'Theme and project components by keywords, with their IDs.',
  read_component: "A component's property schema, parts, variants, slots and examples. Read it before using an unfamiliar component.",
  search_assets: 'Images by name and description, each with its assetId (names can repeat). You cannot see images.',
  read_source: "A component's Svelte source. Only project code components can be patched.",
  apply_source_patch: 'Change a project code component (never generated files, config or dependencies), with the hash from read_source.',
  inspect_layout: 'Measure a page in the live preview at a width: overflow, off-screen elements, whether each image loaded (unverified ones were still loading, which is fine), missing alt text, headings and runtime errors. Structure only, no screenshots.',
  inspect_component: 'Measure a component on its own at phone and desktop width, in every variant option and with long, empty and repeated content: overflow, cut-off text, contrast, overlaps and collapsed spacing, each with where it is in the design. Changes nothing.',
  validate_project: '"schema" checks references, routes and structure; "component" also compiles every component.',
  audit_seo: 'SEO and AI-readiness findings, worst first, and each page’s links in and out. pageId (ID or route) or pillar narrows it. More: offset=nextOffset, linkOffset=nextLinkOffset.',
  request_clarification:
    'Ask the user one question and wait for the answer: when they ask you to interview them, ask them something or let them choose, when you would offer options (never list them in your reply instead), or when a wrong guess would change shared content. Up to four short, concrete choices; they can also type an answer. To choose between images, pass assetIds: they see the pictures. One question per call; then act on the answer.',
  locate_field: 'Where the author changes one content field: its value and the exact Inspector labels on the way to it, with an "Open in inspector" button.',
  upsert_page_with_sections: UPSERT_BRIEF,
  update_site_brand: BRAND_BRIEF,
  upsert_managed_component: MANAGED_COMPONENT_BRIEF,
  ...SELECTION_BRIEFS,
  ...DEFINITION_BRIEFS
};

/** A tool's description, with its brief when it has one. */
const describe = (name: ToolName) => ({ description: DESCRIPTIONS[name], ...(BRIEFS[name] !== undefined ? { brief: BRIEFS[name] } : {}) });

/** Operations the assistant never sends: images and component packages are added only by the verified importer,
 *  theme updates by the user, pastes come from the editor's own Copy, and a component's properties are reordered
 *  in Edit everywhere. Collections get tools of their own later. */
const NEVER_OFFERED = new Set<OperationType>([
  // A whole design in one call reaches the assistant through a tool of its own, never as a raw operation.
  'component.upsert',
  'asset.add',
  'asset.relink',
  'component.import',
  'theme.refresh',
  'node.paste',
  'component.orderProperties',
  'collection.create',
  'collection.update',
  'collection.remove',
  'entry.create',
  'entry.update',
  'entry.reorder',
  'entry.remove'
]);
/**
 * Operations the assistant is not offered yet: UI state shows only its initial value in the generated site until its
 * buttons work there, so a toggle or tabs built through these would be reported as working when they are not.
 */
const NOT_YET_OFFERED = new Set<OperationType>(['component.setState', 'component.removeState', 'node.setStateAction']);
/** Whether an operation authors UI state: one of those, or a binding that reads state. */
const authorsState = (op: EditOperation) => NOT_YET_OFFERED.has(op.type) || (op.type === 'node.setBinding' && !!op.binding && '$state' in op.binding);
/** Operations that need Developer mode, shown only to runs that have it. */
export { CODE_OPERATIONS };

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
  'component.removeSlot'
]);

/**
 * What a run limited to one page can do with operations: change its sections and their content (a copy may come from
 * anywhere), its own settings, and detach a placement on it. scope.ts decides what each one may reach.
 */
export const PAGE_OPERATIONS = new Set<OperationType>([
  ...(Object.keys(OP_REACH) as OperationType[]).filter((t) => ['node', 'insert', 'copy'].includes(OP_REACH[t]) && t !== 'component.makeUnique' && t !== 'component.convertToCode'),
  'page.update'
]);
/** A small model's page run: the page tool builds sections, and these remove or reorder one by its ID and set the page's own settings. */
export const FOCUSED_PAGE_OPERATIONS = new Set<OperationType>(['node.remove', 'node.move', 'page.update']);

/** What building a new component takes: making it, its design, its contract and its placement. */
const COMPONENT_BUILD_OPERATIONS = new Set<OperationType>([
  'component.create',
  'component.createCode',
  'component.updateSource',
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
  'node.insert',
  'node.remove',
  'node.move',
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
  .describe('"intro" adds a page introduction section. "article" makes a dated article (news, an announcement): it adds an Article header showing the title, date, byline and excerpt, and a text section for the body.');

/** The operation union the model is shown for a run; the app still checks every operation it receives. `only` narrows it. */
function offeredOperations(codeEnabled: boolean, definitionOps: boolean, only?: ReadonlySet<OperationType>) {
  const schemas = (Object.keys(OPERATION_SCHEMAS) as OperationType[])
    .filter((t) => !NEVER_OFFERED.has(t) && !NOT_YET_OFFERED.has(t) && (codeEnabled || !CODE_OPERATIONS.has(t)) && (definitionOps || !DEFINITION_OPERATIONS.has(t)) && (!only || only.has(t)))
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
              : t === 'page.update' && only
                ? // A run limited to a page changes its own settings: a new route or translation reaches other pages.
                  OPERATION_SCHEMAS[t].omit({ route: true, linkTranslationTo: true })
              : t === 'node.setBinding'
                ? OPERATION_SCHEMAS[t].extend({ binding: PROP_OR_ITEM_BINDING })
                : OPERATION_SCHEMAS[t]
    );
  return z.discriminatedUnion('type', schemas as unknown as [z.ZodObject<{ type: z.ZodLiteral<string> }>, ...z.ZodObject<{ type: z.ZodLiteral<string> }>[]]);
}

/**
 * Tool definitions for one run. Without Developer mode, code tools and code operations are left out. Component
 * contract operations are offered when `definitionOps` says the run may change a component's design.
 */
export function toolDefinitions(opts: { codeEnabled?: boolean; definitionOps?: boolean; operations?: ReadonlySet<OperationType> } = {}): ToolDefinition[] {
  const codeEnabled = opts.codeEnabled ?? true;
  const definitionOps = opts.definitionOps ?? codeEnabled;
  return (Object.keys(TOOL_ARGS) as ToolName[])
    .filter((name) => !TASK_TOOLS.has(name) && (codeEnabled || !CODE_TOOLS.has(name)))
    .map((name) => {
      const args = name === 'apply_operations' ? TOOL_ARGS.apply_operations.extend({ operations: z.array(offeredOperations(codeEnabled, definitionOps, opts.operations)).min(1).max(30) }) : TOOL_ARGS[name];
      const schema = z.toJSONSchema(args, { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
      delete schema.$schema;
      return { name, ...describe(name), parameters: schema };
    });
}

/** Tools that take a revision or hash the model read earlier: only one of these can run per turn. */
export const REVISION_BOUND_TOOLS = new Set<ToolName>(['apply_operations', 'apply_source_patch']);
const MACRO_TOOLS: ToolName[] = ['upsert_page_with_sections', 'update_site_brand', 'upsert_managed_component'];
const SELECTION_TOOLS = Object.keys(SELECTION_ARGS) as ToolName[];
const DEFINITION_TOOLS = Object.keys(DEFINITION_ARGS) as DefinitionToolName[];
/** Offered by task mode (see toolsForRun), never as part of the general set. */
const TASK_TOOLS = new Set<ToolName>([...MACRO_TOOLS, ...SELECTION_TOOLS, ...DEFINITION_TOOLS, 'locate_field']);
/**
 * Everything a read-only question may use: reads of the project, the catalogue and images, its SEO audit, finding a
 * field, and a plain question to the author. Nothing that changes the site, measures the live preview or builds the
 * project.
 */
export const ASK_TOOLS: readonly ToolName[] = ['read_project', 'read_page', 'inspect_element', 'read_component', 'search_components', 'search_assets', 'audit_seo', 'locate_field', 'request_clarification'];
export const MUTATING_TOOLS = new Set<ToolName>([...REVISION_BOUND_TOOLS, ...MACRO_TOOLS, 'update_selected_props', 'edit_selected_list', 'edit_selected_table', 'style_selected_element', ...DEFINITION_TOOLS]);

/** Below this window a model only gets the focused tools: the general operation schema alone would crowd it out. */
export const FOCUSED_WINDOW_TOKENS = 64_000;

export type ToolMode = 'selection' | 'page' | 'site' | 'definition' | 'general' | 'ask';

export interface RunTools {
  tools: ToolDefinition[];
  /** selection: the selected element's tools. page: the page tool for one page. site: page and brand tools. definition: a component's own design, on a small model. general: a selection they cannot cover, or a design on a larger model. ask: reading only. */
  mode: ToolMode;
  /** Only the small tool set is offered. */
  focused: boolean;
  /** The run builds a new component, asked for from the Create component dialog. */
  task?: 'component';
}

const usesImage = (tools: ToolDefinition[]) => JSON.stringify(tools[0].parameters).includes('"assetId"');

/** The tools of a read-only question: the same small set for every model, with or without a selection. */
function askTools(codeEnabled: boolean): ToolDefinition[] {
  const names: ToolName[] = [...ASK_TOOLS, ...(codeEnabled ? (['read_source'] as const) : [])];
  const tools = names.map((name): ToolDefinition => {
    // A question can never widen what may change: nothing may.
    const args = name === 'request_clarification' ? TOOL_ARGS.request_clarification.omit({ widenScope: true }) : TOOL_ARGS[name];
    const schema = z.toJSONSchema(args, { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
    delete schema.$schema;
    // A question asks back only when it is ambiguous, which the question's own instructions say.
    return { name, ...describe(name), ...(name === 'request_clarification' ? { brief: 'Ask the author one short question and wait for the answer, with up to four short, concrete choices; to choose between images, pass assetIds: they see the pictures.' } : {}), parameters: schema };
  });
  // A question reads component contracts alone: a design is read to build a component, which a question never does.
  return tools.map(contractRead);
}

/**
 * The tools for this step of a run, chosen by task. The small sets are the design target: every model gets
 * them. A cloud model with room to spare also keeps the general tools for anything they cannot express, and a
 * selection they cannot cover (a layout element, say) always uses the general tools. A component's own design gets
 * its definition tools on a small model, and the general tools on a larger one.
 */
export function toolsForRun(opts: {
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
  /** The page a run is limited to: its page tool builds only that page, and nothing site-wide is offered. */
  page?: { route: string } | null;
  /** The request asks for a new component (the Create component dialog). */
  task?: 'component';
  /** The request typed into the chat asks for a component (see asksForComponent): a small site run is offered the tool
   *  that builds one whole, which it otherwise leaves out to keep its window for pages. */
  componentRequest?: boolean;
}): RunTools {
  const { state, selection, capabilities, codeEnabled, definitionOps } = opts;
  const focused = !!opts.focused || capabilities.toolCalling === 'constrained-json' || capabilities.contextWindowTokens < FOCUSED_WINDOW_TOKENS;
  if (opts.ask) return { tools: askTools(codeEnabled), mode: 'ask', focused };
  // A new component is built with the general tools, which the page and selection tools cannot replace; a small model
  // gets only what building one takes, so the request still fits beside them.
  if (opts.task === 'component') {
    const tools = focused ? toolDefinitions({ codeEnabled, definitionOps, operations: COMPONENT_BUILD_OPERATIONS }).filter((t) => COMPONENT_BUILD_TOOLS.has(t.name as ToolName)) : toolDefinitions({ codeEnabled, definitionOps });
    // The whole component in one call comes first: the operations stay for finer changes to what it built.
    return { tools: [managedComponentTool(), ...tools], mode: 'general', focused, task: 'component' };
  }
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
  if (selection) {
    const micro = selectionTools(state, selection);
    if (!micro) return { tools: general, mode: 'general', focused: false };
    // An image can only be chosen by its asset ID, so a selection with one, or a request that attached images, can
    // also look them up and ask the user to choose between them by sight.
    const assets = usesImage(micro) || opts.attachedImages ? general.filter((t) => t.name === 'search_assets' || t.name === 'request_clarification') : [];
    // Content too long to show whole in the selection can still be read whole, a part at a time, before it is changed.
    const reads = selectionAbridged(state, selection) ? general.filter((t) => t.name === 'inspect_element') : [];
    return { tools: focused ? [...micro, ...reads, ...assets] : [...micro, ...general], mode: 'selection', focused };
  }
  if (opts.definition) return { tools: general, mode: 'general', focused: false };
  if (opts.page) {
    // Operations only for the page's own sections and settings, and no code edits: a component's source shows on every
    // page. A small model gets the few that address one section by its ID, which the page tool cannot.
    const own = toolDefinitions({ codeEnabled, definitionOps: false, operations: focused ? FOCUSED_PAGE_OPERATIONS : PAGE_OPERATIONS }).filter((t) => t.name !== 'apply_source_patch' && t.name !== COMPONENT_CHECK);
    const upsert: ToolDefinition = { name: 'upsert_page_with_sections', ...describe('upsert_page_with_sections'), parameters: upsertToolSchema(state, opts.page.route) };
    return { tools: [upsert, ...own], mode: 'page', focused };
  }
  const macros: ToolDefinition[] = [
    { name: 'upsert_page_with_sections', ...describe('upsert_page_with_sections'), parameters: upsertToolSchema(state) },
    { name: 'update_site_brand', ...describe('update_site_brand'), parameters: brandToolSchema(state) },
    ...(!focused || opts.componentRequest ? [managedComponentTool()] : [])
  ];
  // A small model widened from a selection keeps its style tool for the selected element, which nothing else it has can
  // do (styling every card of a selected one, say).
  const kept = focused && opts.widened ? (selectionTools(state, opts.widened, { widened: true }) ?? []).filter((t) => t.name === 'style_selected_element') : [];
  // A small run asked for a component reads a design whole, which a rebuild has to describe again in full.
  const reads = (t: ToolDefinition) => (opts.componentRequest && t.name === 'read_component' ? t : contractRead(t));
  return { tools: [...macros, ...kept, ...(focused ? general.filter((t) => t.name !== 'apply_operations' && t.name !== COMPONENT_CHECK).map(reads) : general)], mode: 'site', focused };
}

/**
 * A whole managed component in one call (#359). It needs a run that may change the whole site (a rebuild moves every
 * placement), and no Developer mode: a managed design is not code.
 */
/** Whether a request typed into the chat asks for a component, which a small site run then builds whole. */
export const asksForComponent = (text: string): boolean => /\b(?:components?|reusable|re-usable)\b/i.test(text);

const managedComponentTool = (): ToolDefinition => ({ name: 'upsert_managed_component', ...describe('upsert_managed_component'), parameters: managedComponentSchema() });

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
  /** `grants`: what the calling tool may also change for a run limited to one page (see scope.ts), never set by the model. */
  apply(operations: EditOperation[], expectedRevision: number, label: string, idempotencyKey: string, grants?: AuthorityGrants): Promise<{ ok: boolean; revision: number; results?: unknown[]; error?: { code: string; message: string } }>;
  compileAll(): Promise<Diagnostic[]>;
  inspectLayout(pageId: string, width: number): Promise<unknown>;
  /** Show and measure a component in isolated previews, step by step (see inspect_component). */
  inspectComponent?(steps: ComponentPreviewStep[]): Promise<ComponentPreviewResult[]>;
  /** `images`: library images offered as choices, already checked to be in the project. */
  ask(question: string, choices: string[], widenScope?: boolean, images?: ChatImageRef[]): Promise<string>;
  /** What the macro tools remember during a run. */
  macros?: MacroMemory;
  /** The element a selection-scoped run is working on. */
  selection?(): SelectionTarget | null;
  /** The component design a run started limited to (see definition.ts), for its definition tools. */
  definitionTarget?(): DefinitionTarget | null;
  /** Whether the run is still limited to its selection: the user has not let it change more. */
  selectionLimited?(): boolean;
  /** The page the run is still limited to, and how it is named, or null once it may change more. */
  pageLimit?(): { pageId: string; label: string } | null;
}

export interface ToolOutcome {
  ok: boolean;
  content: unknown;
  /** A field locate_field found, for the answer's "Open in inspector". */
  location?: FieldLocation;
  mutated?: boolean;
  ops?: EditOperation[];
  results?: unknown[];
}

const WIDTHS = { phone: 390, tablet: 834, desktop: 1280 };
const MAX_RESULT_CHARS = 24000;

/** What a transform, transition or grid property takes, for the read_project list: its range, unit or grammar. */
function valueHint(p: StylePropDef): string {
  if (p.id === 'gridTemplate')
    return ` or up to ${MAX_GRID_TRACKS} column sizes (repeats counted in full): fr shares, lengths, auto, minmax(min, max) with a min that is not fr, and repeat(count, sizes), such as "16rem 1fr 14rem" or "2fr repeat(2, 1fr)"; "repeat(auto-fit, minmax(18rem, 1fr))" (or auto-fill) for as many columns as fit, each at least that plain length (or the whole grid when narrower). Set for all sizes it applies from tablet up; set it at scope phone to use it on phones`;
  if (p.id === 'columnSpan' || p.id === 'rowSpan') return ' (a grid child; above 1 for all sizes it applies from tablet up, set it at scope phone to span there)';
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
  r.issues = issues;
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
  return r as R;
}

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

export function serializeResult(content: unknown): string {
  const s = JSON.stringify(content);
  if (s.length <= MAX_RESULT_CHARS) return s;
  return JSON.stringify({ truncated: true, note: `Result was ${s.length} characters; showing the first ${MAX_RESULT_CHARS}. Request a narrower range (for example read_page with nodeId).`, partial: s.slice(0, MAX_RESULT_CHARS) });
}

export async function executeTool(name: string, rawArgs: string, host: ToolHost, callId: string): Promise<ToolOutcome> {
  if (!(name in TOOL_ARGS)) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: `Unknown tool "${name}".` } };
  let parsed: unknown;
  try {
    parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'Arguments were not valid JSON.' } };
  }
  // Its own checks name each problem by its path, and keep the call for a repair that sends only what was wrong.
  if (name === 'upsert_managed_component') return runManagedComponent(parsed, host, callId, (host.macros ??= newMacroMemory()));
  const schema = TOOL_ARGS[name as ToolName];
  // Checked before parsing, which drops fields the schema does not name.
  const raw = name === 'apply_operations' && parsed && typeof parsed === 'object' ? (parsed as { operations?: unknown }).operations : undefined;
  const legacy = Array.isArray(raw) ? raw.map(legacyShellError).find(Boolean) : null;
  if (legacy) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: legacy } };
  const r = schema.safeParse(parsed);
  if (!r.success) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: r.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') } };
  const args = r.data as never;
  const state = host.state();
  switch (name as ToolName) {
    case 'read_project': {
      const a = args as z.infer<(typeof TOOL_ARGS)['read_project']>;
      const out: Record<string, unknown> = projectSummary(state, host.revision());
      if (a.sections?.includes('tokens')) out.tokens = tokensSummary(state);
      if (a.sections?.includes('catalogue')) {
        out.catalogue = catalogueIndex(state.site.themeId);
        out.icons = Object.keys(ICONS);
      }
      if (a.sections?.includes('components'))
        out.installedComponents = Object.values(state.components).map((d) => ({ definitionId: d.id, componentId: d.componentId, name: d.name, owner: d.owner, kind: d.kind }));
      out.styleProperties = STYLE_PROPS.map((p) => `${p.id}${p.tokenGroup ? ` (token: ${p.tokenGroup})` : ''}${p.options ? ` [${p.options.map((o) => o.value).join('|')}]` : ''}${p.kind === 'focus' ? ' or "X% Y%": the focal point across and down a cropped image, each 0 to 100 with at most one decimal, such as "50% 20%"' : ''}${valueHint(p)}`);
      return { ok: true, content: out };
    }
    case 'read_page': {
      const a = args as z.infer<(typeof TOOL_ARGS)['read_page']>;
      const resolved = pageIdFor(state, a.pageId);
      if (resolved) a.pageId = resolved;
      const detail = resolved ? pageDetail(state, resolved) : null;
      if (!detail) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: `No page "${a.pageId}". Pages: ${state.site.pageOrder.join(', ')}` } };
      if (a.nodeId) {
        const page = state.pages[a.pageId];
        if (!page.nodes[a.nodeId]) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: `No node "${a.nodeId}" on this page.` } };
        return { ok: true, content: { revision: host.revision(), owner: detail.owner, node: compactNode(state, page, a.nodeId) } };
      }
      return { ok: true, content: { revision: host.revision(), ...detail } };
    }
    case 'inspect_element': {
      const a = args as z.infer<(typeof TOOL_ARGS)['inspect_element']>;
      if (a.prop !== undefined) {
        const read = readField(state, { owner: a.owner, nodeId: a.nodeId, prop: a.prop, itemId: a.itemId, field: a.field, offset: a.offset });
        if (!read.ok) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: read.message } };
        return { ok: true, content: { revision: host.revision(), ...read.content } };
      }
      if (a.itemId !== undefined || a.field !== undefined || a.offset !== undefined) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'itemId, field and offset read one field: name its prop too.' } };
      try {
        const tree = getTree(state, a.owner);
        const n = tree.nodes[a.nodeId];
        if (!n) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: `No node "${a.nodeId}".` } };
        const parent = findParent(tree, a.nodeId);
        const out: Record<string, unknown> = {
          revision: host.revision(),
          owner: a.owner,
          // Full props, with a table too large to show whole given every row ID and its cells shortened.
          node: n.kind === 'instance' ? { ...n, props: agentProps(state.components[n.definitionId], n.props, state.pages, true) } : { ...n },
          displayName: displayName(state, n),
          parent: parent ? { parentId: parent.parentId, slot: parent.slot, index: parent.index, siblings: parent.list.length } : null
        };
        if (n.kind === 'instance' && state.components[n.definitionId]) out.component = componentDetail(state.components[n.definitionId]);
        return { ok: true, content: out };
      } catch (e) {
        return { ok: false, content: { error: 'INVALID_ARGUMENT', message: (e as Error).message } };
      }
    }
    case 'search_components': {
      const a = args as z.infer<(typeof TOOL_ARGS)['search_components']>;
      const limit = a.limit ?? 8;
      const themed = searchCatalogue(state.site.themeId, a.query, limit).map((e) => ({ score: searchScore(a.query, e.name, `${e.description} ${e.tags.join(' ')} ${e.category} ${e.componentId}`), hit: { componentId: e.componentId, name: e.name, description: e.description, variants: e.axes } }));
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
      // level, say) are not there until Project health updates it, and placing it uses the installed one.
      const themed = a.componentId ? catalogueComponent(state.site.themeId, a.componentId) : undefined;
      const installed = themed && Object.hasOwn(state.components, themed.id) ? state.components[themed.id] : undefined;
      const def = a.definitionId ? state.components[a.definitionId] : (installed ?? themed);
      if (!def) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'Component not found. Use search_components.' } };
      // A design read part by part: the contract came with the first part.
      if (a.structure && a.offset) return { ok: true, content: { definitionId: def.id, structure: componentStructure(state, def, a.offset) } };
      if (a.structure) {
        // The first part shares one result with the contract. When the two would not fit one result whole (and so
        // lose the next part's offset), the design is read alone and the contract is left to a read without structure.
        const contract = componentDetail(def);
        const both = { ...contract, structure: componentStructure(state, def, 0, MAX_RESULT_CHARS - 1000 - JSON.stringify(contract).length) };
        if (JSON.stringify(both).length <= MAX_RESULT_CHARS - 200) return { ok: true, content: both };
        return { ok: true, content: { definitionId: def.id, note: 'Its contract is long: read_component without structure shows it.', structure: componentStructure(state, def, 0, MAX_RESULT_CHARS - 1000) } };
      }
      const examples = examplesFor(state, def.componentId).map(exampleSection);
      return { ok: true, content: { ...componentDetail(def), ...(examples.length ? { workedExamples: examples } : {}) } };
    }
    case 'search_assets': {
      const a = args as z.infer<(typeof TOOL_ARGS)['search_assets']>;
      const q = (a.query ?? '').toLowerCase();
      // Fonts are assets too, but never images: they are left out before the limit.
      const list = Object.values(state.assets.assets)
        .filter((x) => !!x && libraryImage(state, x.id) === x && (!q || `${x.name} ${x.description ?? ''} ${x.altSuggestion ?? ''}`.toLowerCase().includes(q)))
        .slice(0, a.limit ?? 20)
        .map(assetSummary);
      return { ok: true, content: { assets: list, note: 'Image contents are not available; rely on names and descriptions.' } };
    }
    case 'apply_operations': {
      const a = args as z.infer<(typeof TOOL_ARGS)['apply_operations']>;
      const ops = a.operations as unknown as EditOperation[];
      // Page IDs are allocated by the app; only its own page tool may pass one through.
      if (ops.some((o) => o.type === 'page.create' && o.pageId !== undefined)) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'page.create does not take a pageId.' } };
      // Node IDs too: the result of each node.insert names the node it made.
      if (ops.some((o) => o.type === 'node.insert' && o.newNodeId !== undefined)) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'node.insert does not take a newNodeId.' } };
      // So are new components' IDs: the result of each component.create names the component it made.
      if (ops.some((o) => o.type === 'component.create' && o.definitionId !== undefined)) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'component.create does not take a definitionId.' } };
      // A whole design is built through a tool of its own; the raw operation is never offered.
      if (ops.some((o) => o.type === 'component.upsert'))
        return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'component.upsert is not available here. Build or rebuild a whole component with upsert_managed_component where it is offered, or with component.create and the node and component operations.' } };
      // The copy goes right after the original; placing it elsewhere is a node.move of the copy it returns.
      if (ops.some((o) => o.type === 'node.duplicate' && o.index !== undefined)) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'node.duplicate does not take an index.' } };
      // UI state is not offered yet (NOT_YET_OFFERED), and a call naming it anyway is refused the same way.
      if (ops.some(authorsState)) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'UI state cannot be changed by the assistant yet: no component.setState, component.removeState, node.setStateAction or {"$state"} binding. The generated site does not run state buttons yet.' } };
      // Keeping every use's alt text is for the app's own web-sized copies, which are the same picture.
      if (ops.some((o) => o.type === 'asset.replace' && o.keepAlt !== undefined)) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'asset.replace does not take keepAlt: uses with the old image’s suggested alt text take the new one’s, and its result lists the uses whose alt text to check.' } };
      // Choosing some uses is the author's, from the places Assets lists; the AI replaces an image everywhere.
      if (ops.some((o) => o.type === 'asset.replace' && o.uses !== undefined)) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'asset.replace does not take uses: it replaces the image wherever it is used. To change one place, set that image value instead.' } };
      const before = host.diagnostics();
      const res = await host.apply(ops, a.expectedRevision, labelForOps(ops, state), callId);
      if (!res.ok) {
        // A batch that creates a page and refers to it in the same call cannot work: the page has no ID yet.
        const dependent = refersToNewPage(ops, res.error?.message ?? '');
        const hint = dependent
          ? 'Nothing in this batch was applied, including its page.create. A new page cannot be referred to in the batch that creates it: create the page alone, then fill it in your next step with the pageId and revision that call returns.'
          : undefined;
        return { ok: false, content: { ok: false, revision: res.revision, error: res.error, ...(hint ? { hint } : {}) } };
      }
      // A component this batch made or changed that every placement would show the same way is said now, while the
      // model still has its node IDs to hand.
      const reuse = componentWarnings(introducedReusability(before, host.diagnostics(), () => changedComponents(state, host.state())));
      return { ok: true, mutated: true, ops, results: res.results, content: { ok: true, revision: res.revision, results: res.results, ...reuse } };
    }
    case 'read_source': {
      const a = args as z.infer<(typeof TOOL_ARGS)['read_source']>;
      const def = state.components[a.definitionId];
      if (!def) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'Unknown component.' } };
      if (def.kind !== 'code') return { ok: true, content: { definitionId: def.id, editable: false, note: 'This is a managed component. Its source is generated: read_component with structure shows its design, and operations edit it. A copy can be converted to code with component.convertToCode.' } };
      const lines = (def.source ?? '').split('\n');
      const start = (a.startLine ?? 1) - 1;
      const end = Math.min(lines.length, a.endLine ?? start + 400);
      return { ok: true, content: { definitionId: def.id, editable: def.owner === 'project', hash: sourceHash(def.source ?? ''), totalLines: lines.length, startLine: start + 1, endLine: end, source: lines.slice(start, end).join('\n') } };
    }
    case 'apply_source_patch': {
      const a = args as z.infer<(typeof TOOL_ARGS)['apply_source_patch']>;
      const def = state.components[a.definitionId];
      if (!def || def.kind !== 'code' || def.owner !== 'project') return { ok: false, content: { error: 'PATH_DENIED', message: 'Only project code components can be patched.' } };
      let src = def.source ?? '';
      if (sourceHash(src) !== a.expectedHash) return { ok: false, content: { error: 'STALE_REVISION', message: 'The source changed. Call read_source again.' } };
      if (a.source !== undefined) src = a.source;
      else for (const e of a.edits ?? []) {
        const count = src.split(e.find).length - 1;
        if (count !== 1) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: `"${e.find.slice(0, 60)}" matched ${count} times; it must match exactly once.` } };
        src = src.replace(e.find, e.replace);
      }
      const ops: EditOperation[] = [{ type: 'component.updateSource', definitionId: def.id, source: src, expectedHash: a.expectedHash }];
      const res = await host.apply(ops, host.revision(), `Edit ${def.name} source`, callId);
      if (!res.ok) return { ok: false, content: { ok: false, error: res.error } };
      const compile = (await host.compileAll()).filter((d) => d.severity === 'error');
      return { ok: true, mutated: true, ops, content: { ok: true, revision: res.revision, hash: sourceHash(src), compileErrors: compile.map((d) => d.message) } };
    }
    case 'inspect_layout': {
      const a = args as z.infer<(typeof TOOL_ARGS)['inspect_layout']>;
      const resolved = pageIdFor(state, a.pageId);
      if (!resolved) return { ok: false, content: { error: 'INVALID_ARGUMENT', viewport: a.viewport, message: 'Unknown page.' } };
      a.pageId = resolved;
      try {
        const report = (await host.inspectLayout(a.pageId, WIDTHS[a.viewport])) as { error?: unknown } | null;
        // A preview that is not running or did not load is a failed check, never a clean result.
        if (!report || typeof report !== 'object' || report.error)
          return { ok: false, content: { error: 'VALIDATION_FAILED', pageId: resolved, viewport: a.viewport, message: `Layout could not be inspected: ${String(report?.error ?? 'no report')}` } };
        const envelope = { revision: host.revision(), pageId: resolved, viewport: a.viewport, width: WIDTHS[a.viewport] };
        return { ok: true, content: { ...envelope, report: fitInspection(envelope, report) } };
      } catch (e) {
        return { ok: false, content: { error: 'VALIDATION_FAILED', pageId: resolved, viewport: a.viewport, message: `Layout could not be inspected: ${(e as Error).message}` } };
      }
    }
    case 'inspect_component': {
      const a = args as z.infer<(typeof TOOL_ARGS)['inspect_component']>;
      const target = resolveInspectTarget(state, a);
      if ('error' in target) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: target.error } };
      const cases = planComponentInspection(target);
      const offset = a.offset ?? 0;
      if (offset >= cases.length) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: `There are ${cases.length} cases to measure; offset ${offset} is past the last.` } };
      // Which check could not run, as a result that did would name it.
      const which = { definitionId: target.def.id, ...(target.placement ? { placement: target.placement } : {}), ...(offset ? { offset } : {}) };
      const failed = (message: string) => ({ ok: false, content: { error: 'VALIDATION_FAILED', ...which, message: `The component could not be inspected: ${message}` } });
      if (!host.inspectComponent) return failed('measuring a component is not available here.');
      const window = cases.slice(offset, offset + MAX_CASES);
      const revision = host.revision();
      let results: ComponentPreviewResult[];
      try {
        results = await host.inspectComponent(inspectionSteps(target, window));
      } catch (e) {
        return failed((e as Error).message);
      }
      // Measured against a project that changed meanwhile: it says nothing certain about either.
      if (host.revision() !== revision) return { ok: false, content: { error: 'STALE_REVISION', ...which, message: 'The project changed while the component was measured. Inspect it again.' } };
      const digest = digestComponentInspection(target, window, Array.isArray(results) ? results : [], { offset, total: cases.length, all: cases });
      // Nothing measured is a check that could not run, never a clean component.
      if (!digest.measured) return failed(String((digest.content.failed as Array<{ error: string }> | undefined)?.[0]?.error ?? 'the preview gave no measurements.'));
      return { ok: true, content: fitComponentCheck({ revision, ...digest.content }) };
    }
    case 'validate_project': {
      const a = args as z.infer<(typeof TOOL_ARGS)['validate_project']>;
      const diags = [...host.diagnostics(), ...(a.profile === 'component' ? await host.compileAll() : [])];
      // Component reusability findings are listed apart, with their nodes, so other warnings cannot crowd them out.
      return { ok: true, content: { revision: host.revision(), errors: diags.filter((d) => d.severity === 'error').map((d) => d.message), warnings: diags.filter((d) => d.severity === 'warning' && !isReusabilityWarning(d)).slice(0, 20).map((d) => d.message), ...componentWarnings(diags) } };
    }
    case 'audit_seo': {
      const report = seoReport(state, host.revision(), args as z.infer<typeof AUDIT_SEO_ARGS>, MAX_RESULT_CHARS - 200);
      return report.ok ? { ok: true, content: report.content } : { ok: false, content: { error: 'INVALID_ARGUMENT', message: report.message } };
    }
    case 'locate_field': {
      const a = args as z.infer<(typeof TOOL_ARGS)['locate_field']>;
      const target = { owner: a.owner, nodeId: a.nodeId, prop: a.prop, ...(a.itemId !== undefined ? { itemId: a.itemId } : {}), ...(a.field !== undefined ? { field: a.field } : {}) };
      const found = locateField(state, target);
      if (!found.ok) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: [found.message, found.hint].filter(Boolean).join(' ') } };
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
    case 'request_clarification': {
      const a = args as z.infer<(typeof TOOL_ARGS)['request_clarification']>;
      // The whole offer is checked before the user is asked: a question never shows a picture that is not there.
      const ids = [...new Set(a.assetIds ?? [])];
      if (ids.length && a.widenScope) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'A widenScope question takes no assetIds: ask about the images in a separate question.' } };
      const missing = ids.filter((id) => libraryImage(state, id) === null);
      if (missing.length) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: `No library image has the assetId ${missing.map((id) => `"${id}"`).join(', ')}. Use the assetIds search_assets returns.` } };
      const images = ids.map((id) => imageRef(libraryImage(state, id)!));
      const answer = await host.ask(a.question, a.choices ?? [], a.widenScope, images.length ? images : undefined);
      return { ok: true, content: { answer } };
    }
    case 'upsert_page_with_sections':
      return runUpsert(args as z.infer<typeof UPSERT_ARGS>, host, callId, (host.macros ??= newMacroMemory()));
    case 'upsert_managed_component':
      return runManagedComponent(args, host, callId, (host.macros ??= newMacroMemory()));
    case 'update_site_brand':
      return runBrand(args as z.infer<typeof BRAND_ARGS>, host, callId);
    case 'update_selected_props':
    case 'edit_selected_list':
    case 'edit_selected_table':
    case 'style_selected_element':
    case 'request_wider_scope':
      return runSelectionTool(name as keyof typeof SELECTION_ARGS, args, host, callId);
    case 'edit_definition_node':
    case 'bind_definition_field':
    case 'manage_component_prop':
    case 'style_definition_element':
    case 'add_definition_variant':
    case 'insert_definition_node':
    case 'remove_definition_node':
      return runDefinitionTool(name as DefinitionToolName, args, host, callId);
  }
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

