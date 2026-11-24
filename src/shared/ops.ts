import { z } from 'zod';
import { FONT_FAMILY_RE, FONT_WEIGHT_RE } from './fonts';
import { DOCUMENT_EXTENSIONS, DOCUMENT_FORMATS } from './document-files';
import { sha256Hex } from './sha256';
import { COMPONENT_CATEGORIES, SLOT_PRIMITIVES } from './types';

/**
 * The single, versioned operation union used by manual editing and by the AI agent.
 * Tool schemas and runtime validators are both derived from these definitions.
 */
/** What rich text accepts, for models writing a value. */
const RICH_TEXT_VALUE = 'For richtext: a string or string[] with **bold**, *italic*, [label](/route/ or URL), and line prefixes "- ", "1. ", "- [x] ", "### ", "#### ", "> ". Each line is a block; a line ending in \\ continues the same block after a line break (an address).';
/** What a table property accepts, for models writing a whole table. */
const TABLE_VALUE = 'For table: { "columns": ["Day", "Workshop"], "rows": [["Monday", "Clay basics"]] }; to change one cell, row or column use instance.editTable.';

export const OPS_VERSION = 1;

/** The identity of a definition's property schema, which a whole-schema save names to prove it saw the latest one. */
export function propertiesHash(properties: Record<string, unknown> | undefined): string {
  return `sha256:${sha256Hex(JSON.stringify(properties ?? {}))}`;
}

const owner = z
  .object({
    kind: z.enum(['page', 'shell', 'component']).describe('Document that owns the node: a page, the shared shell (header/footer) or a component definition.'),
    id: z.string().describe('Page ID, "header" or "footer" for the shell, or a component definition ID.')
  })
  .describe('Owner document of the node.');

/** One use of a library image (ImageUseTarget): list items are reached by their ID, never by position. */
const USE_PATH = z.array(z.string().min(1)).min(1).max(64);
const IMAGE_USE = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('node'), owner, nodeId: z.string(), path: USE_PATH }),
  z.object({ kind: z.literal('default'), definitionId: z.string(), path: USE_PATH }),
  z.object({ kind: z.literal('pageSharing'), pageId: z.string() }),
  z.object({ kind: z.literal('site'), field: z.enum(['favicon', 'socialImage']) })
]);

const scope = z.enum(['base', 'phone', 'tablet', 'desktop']).describe('Responsive scope. "base" applies at all sizes.');
/** A web font's face. The family becomes a CSS font-family name, so only plain characters are allowed. */
const FONT_FACE = z.object({
  family: z.string().regex(FONT_FAMILY_RE),
  weight: z.string().regex(FONT_WEIGHT_RE),
  style: z.enum(['normal', 'italic'])
});
const styleValue = z.union([z.string(), z.number(), z.boolean(), z.object({ token: z.string() })]);
const binding = z.union([z.object({ $prop: z.string(), field: z.string().optional() }), z.object({ $item: z.string() })]);
const conditionValue = z.union([z.string(), z.number(), z.boolean()]);
const link = z.object({
  type: z.enum(['none', 'page', 'url', 'email', 'tel', 'anchor', 'document']),
  target: z.string().describe('Page ID for page links, https URL, email address, phone number, anchor ID or a document asset ID.'),
  anchor: z.string().optional(),
  newTab: z.boolean().optional()
});

/** Only files written by the importer, inside static/assets/. */
const ASSET_FILE = z.string().regex(new RegExp(`^static/assets/[a-z0-9][a-z0-9-]*\\.(jpg|png|webp|gif|avif|svg|woff2?|${DOCUMENT_EXTENSIONS.join('|')})$`));
/** A library file's new type: a picture, or one of the document formats. */
const RELINK_MIME = z.string().regex(new RegExp(`^(image/[a-z0-9.+-]+|${Object.values(DOCUMENT_FORMATS).map((f) => f.mime.replace(/[.+]/g, '\\$&')).join('|')})$`));
const ASSET_VARIANTS = z.array(z.object({ width: z.number(), file: z.string().regex(/^static\/assets\/[a-z0-9][a-z0-9-]*\.(jpg|png)$/) }));

/** A dated article's details, as page.create and page.update take them (see shared/articles.ts). */
const ARTICLE_FIELDS = {
  articleDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Publication date, YYYY-MM-DD (a past date backdates the piece). Makes the page a dated article: News lists show articles newest first.'),
  byline: z.string().max(80).optional().describe('Articles only: who wrote it, shown as written ("By Ana Ruiz"). Empty removes it.'),
  excerpt: z.string().max(320).optional().describe('Articles only: a short summary shown in News lists and under the article\'s title. Empty removes it.')
};

export const OPERATION_SCHEMAS = {
  'page.create': z.object({
    type: z.literal('page.create'),
    pageId: z.string().regex(/^pg_[a-z0-9]{4,32}$/).optional().describe('Internal: lets one batch create a page and fill it. Not offered to the model.'),
    title: z.string().min(1).max(80),
    route: z.string().optional().describe('Static route such as "/services/". Defaults to a slug of the title.'),
    afterPageId: z.string().optional(),
    starter: z.enum(['empty', 'intro', 'article']).optional().describe('"intro" adds a page introduction section. "article" makes a dated article (news, an announcement): it adds an Article header showing the title, date, byline and excerpt, and a text section for the body.'),
    addToNavigation: z.boolean().optional().describe('Also add a link to the new page at the end of the shared header navigation.'),
    ...ARTICLE_FIELDS,
    newsHidden: z.boolean().optional().describe('Articles only. true keeps the new article out of every News list while the page is published.')
  }),
  'page.update': z.object({
    type: z.literal('page.update'),
    pageId: z.string(),
    title: z.string().min(1).max(80).optional(),
    route: z.string().optional(),
    navLabel: z.string().max(40).optional(),
    seoTitle: z.string().max(120).optional(),
    description: z.string().max(320).optional(),
    noindex: z.boolean().optional(),
    searchHidden: z.boolean().optional().describe("Leave the page out of the site's own Site search results. Independent of noindex."),
    draft: z.boolean().optional().describe('true keeps the page as a draft: still editable and previewed, but left out of the exported website. false publishes it. The Home page cannot be a draft.'),
    showHeader: z.boolean().optional().describe('Whether this page shows the site\'s shared header. Only this page changes; the footer setting is separate.'),
    showFooter: z.boolean().optional().describe('Whether this page shows the site\'s shared footer. Only this page changes; the header setting is separate.'),
    socialImage: z.string().nullable().optional().describe('Asset ID of the social sharing image; null uses the site image.'),
    language: z.string().max(20).optional().describe('Language code such as "fr", when not the site language. "" uses the site language.'),
    linkTranslationTo: z.string().nullable().optional().describe('Page ID of this page in another language: links them, joining any versions the other has. Each version needs its own language. null unlinks.'),
    ...ARTICLE_FIELDS,
    article: z.literal(false).optional().describe('false makes a dated article an ordinary page again: its date, byline and excerpt are removed and News lists no longer show it.'),
    newsHidden: z.boolean().optional().describe('Articles only. true leaves this article out of every News list while the page stays published; false lists it again.')
  }),
  'page.duplicate': z.object({ type: z.literal('page.duplicate'), pageId: z.string(), title: z.string().optional() }),
  'page.reorder': z.object({ type: z.literal('page.reorder'), pageIds: z.array(z.string()) }),
  'page.remove': z.object({
    type: z.literal('page.remove'),
    pageId: z.string(),
    replacementPageId: z.string().optional().describe('Links to the removed page are pointed here. Required when other content links to it. Cards for the page in page lists are removed with it, not pointed here.'),
    sectionReplacements: z
      .array(z.object({ from: z.string().describe('A section ID on the removed page that links jump to.'), to: z.string().describe('The section ID on the replacement page they jump to instead, or "" for the top of the page.') }))
      .optional()
      .describe('Where links to sections of the removed page go when the replacement page has no section with that ID. A section the replacement page also has is always kept; any other goes to the top of the replacement page unless chosen here.')
  }),
  'page.setHome': z.object({
    type: z.literal('page.setHome'),
    pageId: z.string(),
    keepOldAddress: z
      .boolean()
      .optional()
      .describe("The page moves to \"/\". Unless false, its old address keeps working and sends visitors there, so old links and bookmarks still reach it. The previous Home page moves to a new address of its own.")
  }),

  'node.insert': z.object({
    type: z.literal('node.insert'),
    newNodeId: z.string().regex(/^n_[a-z0-9]{4,32}$/).optional().describe('Internal: lets one batch insert a node and fill it. Not offered to the model.'),
    owner,
    parentId: z.string().nullable().optional().describe('Parent element or instance node. Omit or null to insert a top-level section on a page; a component definition has one top-level element, so insert inside it.'),
    slot: z.string().optional().describe('Slot name when inserting into a component instance slot (e.g. "content").'),
    index: z.number().int().min(0).optional().describe('Position among siblings. Defaults to the end.'),
    componentId: z.string().optional().describe('Catalogue component ID such as "features.grid".'),
    definitionId: z.string().optional().describe('An installed project component definition ID.'),
    primitive: z.enum(['container', 'stack', 'row', 'grid', 'heading', 'paragraph', 'richtext', 'image', 'button', 'icon', 'divider', 'slot', 'repeat']).optional(),
    bind: z.string().optional().describe('Component definitions only: the list property a "repeat" repeats, or the declared slot a "slot" renders.'),
    props: z.record(z.string(), z.unknown()).optional().describe('Initial property values for a component.'),
    variant: z.string().optional().describe('One variant option, found on whichever axis has it.'),
    variants: z.record(z.string(), z.string()).optional().describe('Options by axis, e.g. { "tone": "inverse", "layout": "two-columns" }.'),
    text: z.string().optional().describe('Initial text for heading, paragraph or button primitives.')
  }),
  'node.remove': z.object({ type: z.literal('node.remove'), owner, nodeId: z.string() }),
  'node.move': z.object({
    type: z.literal('node.move'),
    owner,
    nodeId: z.string(),
    parentId: z.string().nullable().optional(),
    slot: z.string().optional(),
    index: z.number().int().min(0)
  }),
  'node.duplicate': z.object({
    type: z.literal('node.duplicate'),
    owner,
    nodeId: z.string(),
    index: z.number().int().min(0).optional().describe('Internal: where in the same list the copy goes (by default right after the original), so the editor can duplicate several layers as one group. Not offered to the model.')
  }),
  'node.copy': z
    .object({
      type: z.literal('node.copy'),
      owner,
      nodeId: z.string().describe('The node to copy, in `owner`.'),
      toOwner: owner.describe('Document the copy goes into: another page, or the same one.'),
      parentId: z.string().nullable().optional().describe('Parent element or instance in `toOwner`. Omit or null for a top-level section of a page.'),
      slot: z.string().optional(),
      index: z.number().int().min(0).optional().describe('Position among siblings. Defaults to the end.')
    })
    .describe('Copy a section or element (with everything inside it) to a position in any page. The copy gets new IDs.'),
  // The editor's Paste: places what Copy captured in the open session, even if the original has since changed.
  'node.paste': z.object({
    type: z.literal('node.paste'),
    clipboardId: z.string(),
    toOwner: owner,
    parentId: z.string().nullable().optional(),
    slot: z.string().optional(),
    index: z.number().int().min(0).optional()
  }),
  'node.rename': z.object({ type: z.literal('node.rename'), owner, nodeId: z.string(), name: z.string().max(60) }),
  'node.setStyle': z.object({
    type: z.literal('node.setStyle'),
    owner,
    nodeId: z.string(),
    partId: z.string().optional().describe('For component instances: the public part to style. Defaults to "root".'),
    itemId: z
      .string()
      .optional()
      .describe('For a repeated part (one card of a grid, one plan, one testimonial): style only the list item with this stable ID, leaving its siblings on the shared style. Needs partId. Omit to style every item.'),
    variant: z.string().optional().describe('Component definitions only: set the rule for this variant option.'),
    axis: z.string().optional().describe('The variant axis, when the option ID is on several.'),
    scope,
    property: z.string().describe('Style property ID, e.g. paddingBlock, background, textStyle, gap, columns.'),
    value: styleValue.nullable().describe('Literal value or {"token": "space.lg"}. objectPosition also takes a focal point "X% Y%" (each 0 to 100). null removes the override.')
  }),
  'node.resetStyles': z.object({
    type: z.literal('node.resetStyles'),
    owner,
    nodeId: z.string(),
    partId: z.string().optional(),
    itemId: z.string().optional().describe('Reset only this repeated item\'s own styles for the part, so it shows the shared style again. Needs partId. Without it the shared part styles are reset and item styles stay.'),
    variant: z.string().optional(),
    axis: z.string().optional(),
    scope: scope.optional()
  }),
  'node.setContent': z.object({
    type: z.literal('node.setContent'),
    owner,
    nodeId: z.string(),
    field: z
      .enum(['text', 'image', 'link', 'label', 'appearance', 'icon', 'iconPosition', 'ariaLabel', 'tag', 'action', 'anchor', 'collapseEmpty'])
      .describe('"collapseEmpty" (definition containers): true hides it when all children are hidden.'),
    value: z.unknown().describe(RICH_TEXT_VALUE)
  }),
  'node.setBinding': z.object({
    type: z.literal('node.setBinding'),
    owner,
    nodeId: z.string(),
    field: z
      .enum(['text', 'image', 'fallbackAlt', 'link', 'label', 'appearance', 'icon', 'iconPosition', 'ariaLabel', 'datetime', 'tag', 'action', 'when', 'unless', 'list', 'prop', 'variant'])
      .describe('"datetime" (plain text only): a YYYY-MM-DD date text property the text states, rendered as a <time> element.'),
    prop: z.string().optional().describe('For field "prop": the nested instance property to bind.'),
    axis: z.string().optional().describe('For field "variant": the nested instance variant axis to bind to an enum property.'),
    binding: binding.nullable().describe('{"$prop": name}, {"$prop": name, "field": objectField} for one field of an object property, or {"$item": field}; null unbinds, keeping the current default.'),
    eq: conditionValue.optional().describe('For "when"/"unless": render when the bound value equals this (or, for unless, when it does not).'),
    ne: conditionValue.optional().describe('For "when"/"unless": render when the bound value differs from this (or, for unless, when it does not).')
  }),
  'instance.setProp': z.object({
    type: z.literal('instance.setProp'),
    owner,
    nodeId: z.string().describe('Instance node ID.'),
    prop: z.string(),
    itemId: z.string().optional().describe('For list properties: the stable item ID to edit.'),
    field: z.string().optional().describe('For list properties: the item field to set. For object properties: the one field to set, keeping the others.'),
    value: z.unknown().describe(`${RICH_TEXT_VALUE} For choices: the whole set in order, { label } for a new choice and the saved { id, label, value } for one kept or renamed. ${TABLE_VALUE}`)
  }),
  'instance.listInsert': z.object({
    type: z.literal('instance.listInsert'),
    owner,
    nodeId: z.string(),
    prop: z.string(),
    index: z.number().int().min(0).optional(),
    item: z.record(z.string(), z.unknown()).optional()
  }),
  'instance.listRemove': z.object({ type: z.literal('instance.listRemove'), owner, nodeId: z.string(), prop: z.string(), itemId: z.string() }),
  'instance.listMove': z.object({ type: z.literal('instance.listMove'), owner, nodeId: z.string(), prop: z.string(), itemId: z.string(), index: z.number().int().min(0) }),
  'instance.editTable': z
    .object({
      type: z.literal('instance.editTable'),
      owner,
      nodeId: z.string().describe('Instance node ID.'),
      prop: z.string().describe('The table property.'),
      action: z.enum(['setCell', 'renameColumn', 'insertRow', 'removeRow', 'moveRow', 'insertColumn', 'removeColumn', 'moveColumn']),
      rowId: z.string().optional().describe('The row to change (setCell, removeRow, moveRow).'),
      columnId: z.string().optional().describe('The column to change (setCell, renameColumn, removeColumn, moveColumn).'),
      index: z.number().int().min(0).optional().describe('Position for insert or move. Inserts default to the end.'),
      value: z.string().optional().describe("setCell: the cell's text. renameColumn and insertColumn: the column's name."),
      cells: z.array(z.string()).optional().describe("insertRow: the new row's cells in column order.")
    })
    .describe('Change one cell, row or column of a table property by its ID. Other cells stay where they are. Replace a whole table with instance.setProp.'),
  'instance.setVariant': z.object({
    type: z.literal('instance.setVariant'),
    owner,
    nodeId: z.string(),
    variant: z.string().describe('The option to show. Other axes keep their current choice.'),
    axis: z.string().optional().describe('The variant axis (e.g. "tone", "layout"), when the option ID is on several.')
  }),

  'token.set': z.object({
    type: z.literal('token.set'),
    tokenId: z.string(),
    value: z
      .unknown()
      .nullable()
      .describe('New value; { "token": "group.name" } to follow another style of the same kind (not for text styles); or null to go back to the theme default (theme styles only).')
  }),
  'token.create': z.object({
    type: z.literal('token.create'),
    group: z.enum(['color', 'font', 'text', 'space', 'container', 'radius', 'shadow', 'border']),
    label: z.string().min(1).max(60),
    value: z.unknown(),
    description: z.string().max(200).optional()
  }),
  'token.rename': z.object({ type: z.literal('token.rename'), tokenId: z.string(), label: z.string().min(1).max(60), description: z.string().max(200).optional() }),
  'token.remove': z.object({
    type: z.literal('token.remove'),
    tokenId: z.string(),
    replacementTokenId: z.string().optional().describe('Uses are pointed here.'),
    detach: z.boolean().optional().describe('Uses keep the current value as a literal.')
  }),
  'token.replace': z.object({ type: z.literal('token.replace'), tokenId: z.string(), withTokenId: z.string() }),
  'site.update': z.object({
    type: z.literal('site.update'),
    name: z.string().min(1).max(80).optional(),
    language: z.string().max(20).optional(),
    description: z.string().max(320).optional(),
    baseUrl: z.string().max(200).optional(),
    favicon: z.string().nullable().optional(),
    socialImage: z.string().nullable().optional(),
    notFoundHeading: z.string().max(120).optional().describe('Heading of the page shown at an address the site does not have. "" restores the default.'),
    notFoundMessage: z.string().max(400).optional().describe('Message on that page, shown above its link to the Home page. "" restores the default.'),
    notFoundLinkLabel: z.string().max(60).optional().describe('Text of that page\'s link to the Home page. "" restores the default.')
  }),

  'component.createFromNode': z.object({ type: z.literal('component.createFromNode'), owner, nodeId: z.string(), name: z.string().min(1).max(60) }),
  'component.makeUnique': z.object({ type: z.literal('component.makeUnique'), owner, nodeId: z.string(), name: z.string().max(60).optional() }),
  'component.duplicate': z.object({ type: z.literal('component.duplicate'), definitionId: z.string(), name: z.string().min(1).max(60) }),
  'component.rename': z.object({ type: z.literal('component.rename'), definitionId: z.string(), name: z.string().min(1).max(60), description: z.string().max(300).optional() }),
  'component.fork': z.object({ type: z.literal('component.fork'), definitionId: z.string() }),
  'component.convertToCode': z.object({ type: z.literal('component.convertToCode'), owner, nodeId: z.string(), name: z.string().max(60).optional() }),
  'component.createCode': z.object({
    type: z.literal('component.createCode'),
    name: z.string().min(1).max(60),
    description: z.string().max(300).optional(),
    source: z.string().max(60000),
    properties: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Property schema: { propName: { type, label, default } }. Types: string, richtext, number, boolean, enum (options), link, image, icon, choices, list (itemLabel, fields), table (default { columns, rows }). A richtext property or list field reaches the code as one string per paragraph or list item with **bold** and *italic*, unless it declares codeForm: "blocks", which passes structured blocks to render with <RichText value={...} /> imported from "../runtime/RichText.svelte" (links, lists and headings included).'
      )
  }),
  'component.updateSource': z.object({
    type: z.literal('component.updateSource'),
    definitionId: z.string(),
    source: z.string().max(60000),
    expectedHash: z.string().optional(),
    properties: z.record(z.string(), z.unknown()).optional().describe('Replaces the whole property schema.'),
    renames: z
      .array(z.object({ from: z.string(), to: z.string() }))
      .max(60)
      .optional()
      .describe('With properties: stored properties that properties keeps under a new name (from the stored name, to its name in properties). Every placement keeps its value for them. All pairs apply at once, so two names can swap.'),
    expectedPropertiesHash: z.string().optional().describe('propertiesHash() of the schema `properties` was edited from. Refused when the stored schema has changed since.')
  }),
  'component.remove': z.object({ type: z.literal('component.remove'), definitionId: z.string() }),
  'component.setPropSchema': z.object({
    type: z.literal('component.setPropSchema'),
    definitionId: z.string(),
    prop: z.string(),
    schema: z.record(z.string(), z.unknown()).describe('{ type, label, default, ... } as in component.createCode.')
  }),
  'component.removePropSchema': z.object({ type: z.literal('component.removePropSchema'), definitionId: z.string(), prop: z.string() }),
  'component.setPropDefault': z.object({
    type: z.literal('component.setPropDefault'),
    definitionId: z.string(),
    prop: z.string(),
    value: z.unknown().describe('The new default: what placements without a value of their own show, and what new placements start with.')
  }),
  'component.setPart': z.object({
    type: z.literal('component.setPart'),
    definitionId: z.string(),
    partId: z.string(),
    nodeId: z.string(),
    label: z.string().min(1).max(60),
    styleControls: z.array(z.string()).optional()
  }),
  'component.removePart': z.object({ type: z.literal('component.removePart'), definitionId: z.string(), partId: z.string() }),
  'component.setVariant': z.object({
    type: z.literal('component.setVariant'),
    definitionId: z.string(),
    axis: z.string().optional().describe('The variant axis to add to. A new name creates the axis. Defaults to the only axis, or "style".'),
    axisLabel: z.string().min(1).max(40).optional(),
    variant: z.string(),
    label: z.string().min(1).max(60),
    makeDefault: z.boolean().optional()
  }),
  'component.removeVariant': z.object({ type: z.literal('component.removeVariant'), definitionId: z.string(), variant: z.string(), axis: z.string().optional() }),
  'component.setSlot': z.object({
    type: z.literal('component.setSlot'),
    definitionId: z.string(),
    slot: z.string(),
    label: z.string().min(1).max(60),
    description: z.string().max(300).nullable().optional().describe('What belongs in the slot. Left out keeps it; null removes it.'),
    categories: z
      .array(z.enum(COMPONENT_CATEGORIES as unknown as [string, ...string[]]))
      .max(20)
      .nullable()
      .optional()
      .describe('Component categories the slot takes. With primitives, the slot takes only what either lists; with neither, anything. Left out keeps it; null removes the restriction.'),
    primitives: z
      .array(z.enum(SLOT_PRIMITIVES as unknown as [string, ...string[]]))
      .max(6)
      .nullable()
      .optional()
      .describe('Element kinds the slot takes: element (containers), text, image, link (buttons), icon, divider. Left out keeps it; null removes the restriction.'),
    max: z.number().int().min(0).max(1000).nullable().optional().describe('The most children the slot holds; 0 closes it. Left out keeps it; null removes the limit.')
  }),
  'component.removeSlot': z.object({ type: z.literal('component.removeSlot'), definitionId: z.string(), slot: z.string() }),

  'theme.apply': z.object({ type: z.literal('theme.apply'), themeId: z.string() }),
  'theme.refresh': z
    .object({ type: z.literal('theme.refresh'), definitionIds: z.array(z.string()).optional().describe('Only these definitions. Defaults to every one that can be updated.') })
    .describe('Update installed theme components to the current theme version. Forked, project and hand-edited components are never changed.'),

  'asset.add': z.object({
    type: z.literal('asset.add'),
    asset: z.object({
      id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/), name: z.string().max(200),
      file: ASSET_FILE, mime: z.string(), bytes: z.number(), width: z.number().optional(), height: z.number().optional(),
      hash: z.string(), kind: z.enum(['image', 'font', 'document']), createdAt: z.string(), variants: ASSET_VARIANTS.optional(), description: z.string().optional(), altSuggestion: z.string().optional(),
      font: FONT_FACE.optional(), originalName: z.string().max(255).optional()
    })
  }),
  'asset.update': z.object({ type: z.literal('asset.update'), assetId: z.string(), name: z.string().max(120).optional(), description: z.string().max(500).optional(), altSuggestion: z.string().max(300).optional(), font: FONT_FACE.optional() }),
  'asset.remove': z.object({ type: z.literal('asset.remove'), assetId: z.string() }),
  'asset.replace': z.object({
    type: z.literal('asset.replace'),
    assetId: z.string(),
    withAssetId: z.string(),
    keepAlt: z.boolean().optional().describe('Keep every use’s alt text as it is, for a copy of the same picture. Otherwise a use with the old image’s suggested alt text takes the new image’s.'),
    // Editor only: the uses the author chose. Every one must still show the image, or nothing is replaced.
    uses: z.array(IMAGE_USE).min(1).optional().describe('Replace only these uses of the image. Without it, every use is replaced.')
  }),
  // Editor only: the file an existing library image or document has, after the author located or chose it. Its uses,
  // name and descriptions stay; the file details are replaced as a whole.
  'asset.relink': z.object({
    type: z.literal('asset.relink'), assetId: z.string(), file: ASSET_FILE, mime: RELINK_MIME, bytes: z.number(), hash: z.string(),
    width: z.number().optional(), height: z.number().optional(), variants: ASSET_VARIANTS.optional(), originalName: z.string().max(255).optional()
  })
} as const;

export type OperationType = keyof typeof OPERATION_SCHEMAS;
export const EditOperationSchema = z.discriminatedUnion(
  'type',
  Object.values(OPERATION_SCHEMAS) as unknown as [z.ZodObject<{ type: z.ZodLiteral<string> }>, ...z.ZodObject<{ type: z.ZodLiteral<string> }>[]]
);

export type Op<T extends OperationType> = z.infer<(typeof OPERATION_SCHEMAS)[T]>;
export type EditOperation = { [K in OperationType]: Op<K> }[OperationType];

export interface EditScope {
  kind: 'selection' | 'page' | 'component' | 'site';
  targetIds: string[];
}

export interface EditBatch {
  expectedRevision?: number;
  scope?: EditScope;
  operations: EditOperation[];
  /** Human readable label for history. */
  label?: string;
}

export type ToolErrorCode = 'INVALID_ARGUMENT' | 'STALE_REVISION' | 'SCOPE_MISMATCH' | 'PATH_DENIED' | 'VALIDATION_FAILED' | 'CONFLICT' | 'CANCELLED' | 'BUSY';

export interface ApplyResult {
  ok: boolean;
  revision: number;
  /** Per-operation results such as new node or page IDs. */
  results?: Array<Record<string, unknown>>;
  changed?: string[];
  /** The history entry the change was recorded in, so an Undo offered for it reverses that entry and no other. */
  entryId?: string;
  error?: { code: ToolErrorCode; message: string; recoverable: boolean; details?: unknown };
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Fields whose string values are used as lookup keys. Content (text, labels) may contain any words. */
const KEY_FIELDS = /(^id$|Id$|^prop$|^field$|^property$|^variant$|^axis$|^slot$|^parentId$|^bind$|^\$prop$|^\$item$)/;
function hasForbidden(v: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(v)) return v.some((x) => hasForbidden(x, depth + 1));
  if (v && typeof v === 'object')
    return Object.entries(v).some(([k, x]) => FORBIDDEN_KEYS.has(k) || (KEY_FIELDS.test(k) && typeof x === 'string' && FORBIDDEN_KEYS.has(x)) || hasForbidden(x, depth + 1));
  return false;
}

/**
 * Pages once had one setting for both shared parts. The schema no longer names it, so parsing would drop it and an
 * edit that still sends it (a model repeating an earlier call) would quietly change nothing: it is refused instead.
 */
export function legacyShellError(op: unknown): string | null {
  if (!op || typeof op !== 'object' || (op as { type?: unknown }).type !== 'page.update' || !Object.hasOwn(op, 'shell')) return null;
  return 'shell: a page shows the shared header and footer separately. Use showHeader and showFooter.';
}

export function validateOperation(op: unknown): { ok: true; op: EditOperation } | { ok: false; message: string } {
  if (!op || typeof op !== 'object' || !('type' in op)) return { ok: false, message: 'Operation must be an object with a "type".' };
  // Object-prototype names are never valid IDs or keys; rejecting them keeps lookups safe.
  if (hasForbidden(op)) return { ok: false, message: 'Operation contains a reserved name.' };
  const type = String((op as { type: unknown }).type);
  const schema = Object.hasOwn(OPERATION_SCHEMAS, type) ? OPERATION_SCHEMAS[type as OperationType] : undefined;
  if (!schema) return { ok: false, message: `Unknown operation type "${(op as { type: string }).type}". Valid types: ${Object.keys(OPERATION_SCHEMAS).join(', ')}.` };
  const legacy = legacyShellError(op);
  if (legacy) return { ok: false, message: legacy };
  const r = schema.safeParse(op);
  if (!r.success) return { ok: false, message: r.error.issues.map((i) => `${i.path.join('.') || 'operation'}: ${i.message}`).join('; ') };
  return { ok: true, op: r.data as EditOperation };
}
