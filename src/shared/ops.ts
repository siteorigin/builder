import { z } from 'zod';
import { FONT_FAMILY_RE, FONT_WEIGHT_RE } from './fonts';
import { DOCUMENT_EXTENSIONS, DOCUMENT_FORMATS } from './document-files';
import { sha256Hex } from './sha256';
import { COMPONENT_CATEGORIES, DIVIDER_SHAPES, LINK_RELS, OVERLAY_MODES, SLOT_PRIMITIVES, STYLE_SCOPES, STYLE_STATES } from './types';
import { CONTAINER_SCOPE_HELP } from './styles';
import { TEXT_LIMITS, tooLongMessage } from './text-limits';
import { CANONICAL_URL_MAX } from './seo';
import { VISITOR_TEXT_KEYS, VISITOR_TEXT_LIMIT } from './visitor-text';
import { IDENTITY_LIMITS } from './site-identity';
import { PAGE_STRUCTURED_TYPES, PRODUCT_AVAILABILITY, STRUCTURED_LIMITS } from './page-structured-data';
import { checkCrawlerPath, checkCrawlerToken, CRAWLER_LIMITS, CRAWLER_PRESETS, FIXED_CRAWLER_PRESETS } from './crawler-policy';

/**
 * The single, versioned operation union used by manual editing and by the AI agent.
 * Tool schemas and runtime validators are both derived from these definitions.
 */
/** What rich text accepts, for models writing a value. */
const RICH_TEXT_VALUE = 'For richtext: a string or string[] with **bold**, *italic*, [label](/route/ or URL) (a URL may end with "new tab", "rel=nofollow,sponsored,ugc" or both: [label](https://… "new tab rel=sponsored")), and line prefixes "- ", "1. ", "- [x] ", "### ", "#### ", "> ". Each line is a block; a line ending in \\ continues the same block after a line break (an address).';
/** What a table property accepts, for models writing a whole table. */
const TABLE_VALUE = 'For table: { "columns": ["Day", "Workshop"], "rows": [["Monday", "Clay basics"]] }; to change one cell, row or column use instance.editTable.';

export const OPS_VERSION = 1;

/** Text up to one of TEXT_LIMITS, refused over it with its length and the limit (issue #226). */
const limited = (limit: number) => z.string().max(limit, { error: (iss) => tooLongMessage(typeof iss.input === 'string' ? iss.input.length : limit + 1, limit) });

/** The identity of a definition's property schema, which a whole-schema save names to prove it saw the latest one. */
export function propertiesHash(properties: Record<string, unknown> | undefined): string {
  return `sha256:${sha256Hex(JSON.stringify(properties ?? {}))}`;
}

const owner = z
  .object({
    kind: z.enum(['page', 'shell', 'component', 'template', 'archive']).describe("A page, the shared shell (header/footer), a component definition, a collection's layout template or its archive layout."),
    id: z.string().describe('Page ID, "header" or "footer" for the shell, a component definition ID, or (for a template or archive) the collection ID.')
  })
  .describe('Owner document of the node.');

/** One use of a library image (ImageUseTarget): list items are reached by their ID, never by position. */
const USE_PATH = z.array(z.string().min(1)).min(1).max(64);
const IMAGE_USE = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('node'), owner, nodeId: z.string(), path: USE_PATH }),
  z.object({ kind: z.literal('default'), definitionId: z.string(), path: USE_PATH }),
  z.object({ kind: z.literal('pageSharing'), pageId: z.string() }),
  z.object({ kind: z.literal('site'), field: z.enum(['favicon', 'socialImage', 'logo']) })
]);

const scope = z.enum(STYLE_SCOPES).describe(`Responsive scope. "base" applies at all sizes; "phone", "tablet" and "desktop" at one screen size. ${CONTAINER_SCOPE_HELP}`);
const styleState = z
  .enum(STYLE_STATES)
  .describe(
    '"hover", "focus" (keyboard) or "active" (pressed); omit for the resting style. A state sets only color, background, border, radius, shadow and opacity. "groupHover" and "groupFocus" follow the nearest interaction group around the element (a card marked with interactionGroup): hovered, or holding focus anywhere inside; they can also shift, scale and rotate it.'
  );
/** A web font's face. The family becomes a CSS font-family name, so only plain characters are allowed. */
const FONT_FACE = z.object({
  family: z.string().regex(FONT_FAMILY_RE),
  weight: z.string().regex(FONT_WEIGHT_RE),
  style: z.enum(['normal', 'italic'])
});
/** A style's token link: `{ token }`, or a colour token at part strength, `{ token, alpha }` (checked by validateStyleValue). */
export const STYLE_TOKEN_REF = z.object({ token: z.string(), alpha: z.number().optional() }).strict();
/** backgroundImage's value: a library image by asset ID, how it fills the box, its focus and a scrim (checked by validateStyleValue). */
export const BACKGROUND_IMAGE = z.object({ assetId: z.string(), size: z.enum(['cover', 'contain', 'tile']).optional(), tileSize: z.number().optional(), position: z.string().optional(), scrim: z.string().optional() }).strict();
/** Any style property's value: a literal, a token link, or (backgroundImage only) a library image. */
export const STYLE_VALUE = z.union([z.string(), z.number(), z.boolean(), STYLE_TOKEN_REF, BACKGROUND_IMAGE]);
const styleValue = STYLE_VALUE;
// Strict, so a value naming two sources ({ $prop, $state }) is refused rather than read as whichever comes first.
const contentBinding = [z.object({ $prop: z.string(), field: z.string().optional() }).strict(), z.object({ $item: z.string() }).strict()] as const;
const binding = z.union([...contentBinding, z.object({ $state: z.string() }).strict(), z.object({ $entry: z.string().max(80) }).strict()]);
/** node.setBinding's binding as the assistant is offered it: a property, an item field or UI state, never a collection entry's field. */
export const MODEL_BINDING = z
  .union([...contentBinding, z.object({ $state: z.string() }).strict()])
  .nullable()
  .describe('{"$prop": name}, {"$prop": name, "field": objectField} for one field of an object property, or {"$item": field}; {"$state": name} (when, unless and variant only) reads the component\'s UI state. null unbinds, keeping the current default.');
/**
 * node.setBinding's binding as a run limited to a collection's entry layout is offered it (#679): an element there may
 * also show the entry its page is for, by field.
 */
export const LAYOUT_BINDING = z
  .union([...contentBinding, z.object({ $state: z.string() }).strict(), z.object({ $entry: z.string().max(80) }).strict()])
  .nullable()
  .describe('{"$entry": field} shows the entry the page is for: "title", "slug", "excerpt", "publishedAt", "featuredImage", "categories", "terms.<grouping>" or "field.<name>" (a custom field, from read_project collections fields). {"$item": field} inside a collection loop shows its row\'s entry; {"$prop": name} a placement\'s property; {"$state": name} (when, unless and variant only) UI state. null unbinds, keeping the current default.');
/** What a button does to its component's UI state (see `StateAction` in shared/types). */
const stateAction = z.discriminatedUnion('op', [
  z.object({ state: z.string(), op: z.literal('set'), value: z.union([z.boolean(), z.string()]).describe('true or false for a yes/no state; one of the options of a choice.') }).strict(),
  z.object({ state: z.string(), op: z.literal('toggle') }).strict(),
  z.object({ state: z.string(), op: z.literal('next'), wrap: z.boolean().optional().describe('After the last option, go back to the first.') }).strict(),
  z.object({ state: z.string(), op: z.literal('prev'), wrap: z.boolean().optional().describe('Before the first option, go round to the last.') }).strict(),
  z.object({ state: z.string(), op: z.literal('select') }).strict().describe("An item state only, on a button inside a repeat of its list: makes the button's own item the active one.")
]);
const conditionValue = z.union([z.string(), z.number(), z.boolean()]);
/** A UI state variable as a person or the AI declares it (component.setState, component.upsert); see normalizeUiState. */
const uiStateDecl = z.object({
  type: z.enum(['boolean', 'enum', 'item']),
  label: z.string().max(80).optional(),
  options: z
    .array(z.union([z.string(), z.object({ value: z.string(), label: z.string().optional() })]))
    .optional()
    .describe('enum only: 2 to 50 options, in the order next and prev step through.'),
  list: z.string().optional().describe('item only: the list property whose active item it holds.'),
  initial: z
    .union([z.boolean(), z.string(), z.number()])
    .optional()
    .describe('What every placement starts with: true or false, one of the options, or (item) the position of the item, counting from 0. Defaults to false, the first option or the first item.')
});
/** How a divider's shape is offered: the same words wherever one can be set. */
export const DIVIDER_SHAPE_TEXT =
  'How the divider is drawn: "line" (default) is a plain rule; "angle" and "wave" are decorative section-edge bands and "icon" a hairline either side of an icon, drawn in the divider\'s text color (its "color" style) and hidden from screen readers.';
const link = z.object({
  type: z.enum(['none', 'page', 'url', 'email', 'tel', 'anchor', 'document', 'collection']),
  target: z.string().describe('Page ID for page links, https URL, email address, phone number, anchor ID, a document asset ID, or a collection ID for a link to that collection\'s index (such as the blog\'s list of posts).'),
  anchor: z.string().optional(),
  newTab: z.boolean().optional(),
  rel: z.array(z.enum(LINK_RELS)).optional().describe('url only: what the link says about the site it goes to (a paid link is sponsored).')
});

/**
 * The nodes of a design built in one go (component.upsert): each has an ID of its own, which the design keeps, so
 * nodes can name each other (children, parts, variant rules) before any of them exists. A flat list, never nested:
 * a design of any depth fits the same shape.
 */
const DESIGN_NODE_ID = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
/** A literal value of a design node's field, or the property or list item field it shows. */
const bindable = <T extends z.ZodType>(literal: T) => z.union([...contentBinding, literal]);
/** What a design's condition reads: a property, a list item field, or the component's own UI state. */
const conditionRefs = [...contentBinding, z.object({ $state: z.string() }).strict()] as const;
const designCondition = z
  .union([...conditionRefs, z.object({ ref: z.union(conditionRefs), eq: conditionValue }).strict(), z.object({ ref: z.union(conditionRefs), ne: conditionValue }).strict()])
  .describe('Shown only while the property, item field or UI state ({"$state": name}) is set (a yes/no state on), or compared with "eq" / "ne".');
const designStyles = z
  .record(z.string(), z.unknown())
  .describe('Style rules: { "paddingBlock": { "token": "space.lg" } } for every size, or by size and state: { "base": {...}, "desktop": {...}, "base:hover": {...} }.');
const DESIGN_NODE_BASE = {
  id: DESIGN_NODE_ID.describe('The node\'s ID in the design, such as "title" or "card". Kept as it is, so a rebuild that names a node again keeps it.'),
  name: z.string().max(60).optional().describe('Layer name.'),
  styles: designStyles.optional(),
  when: designCondition.optional(),
  unless: designCondition.optional().describe('Hidden while the property or item field is set, or while the comparison holds.'),
  anchor: z.string().max(62).optional()
};
const DESIGN_CHILDREN = z.array(DESIGN_NODE_ID).max(200).optional().describe('IDs of the nodes inside it, in order.');
const DESIGN_NODE = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('element'),
      ...DESIGN_NODE_BASE,
      tag: bindable(z.string()).optional().describe('Element tag such as "section", "article", "ul" or "li", or a choice of them. Defaults to "div".'),
      children: DESIGN_CHILDREN,
      link: bindable(link).optional().describe('Makes the whole container one link (a card): nothing inside may be interactive.'),
      action: bindable(z.string()).optional(),
      ariaLabel: bindable(z.string()).optional(),
      collapseEmpty: z.boolean().optional().describe('Hidden when everything inside it is hidden.'),
      carousel: z.literal(true).optional(),
      interactionGroup: z
        .literal(true)
        .optional()
        .describe('An interaction group (a card): hovering it, or focus inside it, shows the groupHover and groupFocus styles of the elements inside whose nearest group it is.'),
      appear: z.string().optional(),
      overlay: z
        .enum(OVERLAY_MODES as unknown as [string, ...string[]])
        .optional()
        .describe('A plain div whose one condition reads a yes/no UI state: shown over the page as a dialog or drawer while it holds, opened and closed by the state\'s buttons.')
    })
    .strict(),
  z
    .object({
      kind: z.literal('text'),
      ...DESIGN_NODE_BASE,
      tag: bindable(z.string()).optional().describe('Text tag such as "h2" or "p", or a choice of them. Defaults to "p"; rich text is always "div".'),
      text: bindable(z.union([z.string(), z.array(z.unknown())])),
      rich: z.boolean().optional().describe(`Rich text: paragraphs, lists and links. ${RICH_TEXT_VALUE}`),
      datetime: bindable(z.string()).optional()
    })
    .strict(),
  z.object({ kind: z.literal('image'), ...DESIGN_NODE_BASE, image: bindable(z.record(z.string(), z.unknown())), fallbackAlt: bindable(z.string()).optional() }).strict(),
  z
    .object({
      kind: z.literal('link'),
      ...DESIGN_NODE_BASE,
      link: bindable(link),
      label: bindable(z.string()),
      appearance: bindable(z.string()).optional().describe('primary, secondary, text, light, link or plain. Defaults to primary.'),
      icon: bindable(z.string()).optional(),
      iconPosition: bindable(z.string()).optional(),
      ariaLabel: bindable(z.string()).optional(),
      stateAction: stateAction.optional().describe("What clicking it does to the component's UI state; with no link it is a button that only does that.")
    })
    .strict(),
  z.object({ kind: z.literal('icon'), ...DESIGN_NODE_BASE, icon: bindable(z.string()), ariaLabel: bindable(z.string()).optional() }).strict(),
  z
    .object({
      kind: z.literal('divider'),
      ...DESIGN_NODE_BASE,
      shape: z.enum(DIVIDER_SHAPES).optional().describe(DIVIDER_SHAPE_TEXT),
      icon: z.string().optional().describe('Shape "icon" only: the icon between the hairlines.')
    })
    .strict(),
  z
    .object({
      kind: z.literal('repeat'),
      ...DESIGN_NODE_BASE,
      list: z.string().describe('The list property shown once per item; nodes inside show item fields with {"$item": field}.'),
      children: DESIGN_CHILDREN,
      appearStagger: z.boolean().optional(),
      filter: z
        .object({ field: z.string(), when: z.string().optional() })
        .strict()
        .optional()
        .describe('Category pills above the items: field, a text or choice item field; when, the yes/no property turning them on.')
    })
    .strict(),
  z
    .object({
      kind: z.literal('slot'),
      ...DESIGN_NODE_BASE,
      slot: z.string().describe('The declared slot whose content shows here.'),
      children: DESIGN_CHILDREN.describe('IDs of the nodes shown here instead while a placement leaves the slot empty, in order.')
    })
    .strict(),
  z
    .object({
      kind: z.literal('instance'),
      ...DESIGN_NODE_BASE,
      definitionId: z.string().min(1).max(120).describe('An installed component to place in the design, such as a project component of the site.'),
      props: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Its property values by name, each a literal or the property ({"$prop"}) or list item field ({"$item"}) of this design it shows. Left out, a property starts at its default (or, on a rebuild, keeps what the placement holds).'),
      variants: z.record(z.string(), z.string()).optional().describe('The option it shows on each of its variant axes, by axis. An axis left out uses its default (or, on a rebuild, keeps the option the placement shows).')
    })
    .strict()
]);

/** Only files written by the importer, inside static/assets/. */
const ASSET_FILE = z.string().regex(new RegExp(`^static/assets/[a-z0-9][a-z0-9-]*\\.(jpg|png|webp|gif|avif|svg|woff2?|${DOCUMENT_EXTENSIONS.join('|')})$`));
/** A library file's new type: a picture, or one of the document formats. */
const RELINK_MIME = z.string().regex(new RegExp(`^(image/[a-z0-9.+-]+|${Object.values(DOCUMENT_FORMATS).map((f) => f.mime.replace(/[.+]/g, '\\$&')).join('|')})$`));
/** A picture's responsive copies: each a width and an importer-named file, whose extension says its format. */
const ASSET_VARIANTS = z.array(z.object({ width: z.number().int().positive(), file: z.string().regex(/^static\/assets\/[a-z0-9][a-z0-9-]*\.(jpg|png|webp|avif)$/) }));

/** A dated article's details, as page.create and page.update take them (see shared/articles.ts). */
const ARTICLE_FIELDS = {
  articleDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Publication date, YYYY-MM-DD (a past date backdates the piece). Makes the page a dated article: News lists show articles newest first.'),
  byline: limited(TEXT_LIMITS.byline).optional().describe('Articles only: who wrote it, shown as written ("By Ana Ruiz"). Empty removes it.'),
  excerpt: limited(TEXT_LIMITS.excerpt).optional().describe('Articles only: a short summary shown in News lists and under the article\'s title. Empty removes it.')
};

/** A collection's settings, as collection.create and collection.update take them (see shared/collections.ts). */
/** How a collection query is described to callers (see shared/collection-query.ts). */
const COLLECTION_QUERY_TEXT =
  '{ collectionId, where?, sort?, limit?, offset?, excludeCurrent? }: collectionId names the collection ("$current" in a collection\'s layout or archive layout is its own); where is a list of { field, op, value } clauses all entries must pass (op eq, ne, in, contains, gt, gte, lt, lte or exists; fields as bindings name them: title, publishedAt, terms.<grouping>, field.<name>...); sort a list of { field, direction? } ("entryOrder" is the editorial order); drafts are always left out.';

const COLLECTION_SETTINGS = {
  name: z.string().min(1).max(80).optional(),
  kind: z.enum(['editorial', 'structured']).optional().describe('What it holds: "editorial", dated articles such as blog posts (the default), or "structured", records such as team members, projects or events.'),
  singularName: z.string().max(80).nullable().optional().describe('What one entry is called ("Team member" of "Team"). "" or null removes it.'),
  hasBody: z.boolean().optional().describe('Whether entries have text of their own. Default true. Turning it off needs every entry\'s text, and the layout\'s showing it, cleared first.'),
  pages: z
    .object({ detail: z.boolean(), archive: z.boolean() })
    .strict()
    .optional()
    .describe('The pages the website has for it: one per entry (detail) and an index with category archives at its address (archive, which needs detail). Default both. Neither makes it data only: records other pages show, with no address of their own.'),
  route: z.string().max(1100).optional().describe('Address prefix every entry\'s address starts with, such as "/blog/" or "/お知らせ/". At most three levels deep. With an archive, the collection owns this address too. A data-only collection needs none.'),
  taxonomies: z
    .record(
      z.string(),
      z.object({
        label: z.string().min(1).max(60),
        terms: z.record(z.string(), z.object({ label: z.string().min(1).max(80), description: limited(TEXT_LIMITS.pageDescription).optional() })).optional()
      })
    )
    .optional()
    .describe(
      'Every grouping, by stable ID ("categories", "tags"), each with its terms by stable ID. Replaces the whole set: a grouping or term left out is removed from every entry. A category\'s description is what its archive page tells search engines and link previews; a term given without one keeps the one it has.'
    ),
  fields: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional()
    .describe('Every custom field, by camelCase name: { type, label, default?, ... } with type string, number, boolean, enum (options), image, link, richtext, date (YYYY-MM-DD) or reference (collection: the ID of the collection whose entries it names; multiple: true for a list of them). Replaces the whole set: a field left out is removed from every entry.'),
  pageSize: z.number().int().min(1).max(100).optional().describe('How many entries each page of the collection\'s index and category archives lists, newest first (later pages at page/2/, page/3/...). Default 10.'),
  rss: z
    .boolean()
    .nullable()
    .optional()
    .describe('Whether its published entries are listed in the website\'s RSS feed (rss.xml). Default: as its kind says, editorial yes and structured no. null goes back to that default.'),
  categoryArchives: z.boolean().optional().describe('Whether each category with a published entry gets an archive page at category/<term ID>/ under the collection\'s address. Default true.'),
  archiveTemplate: z
    .union([z.object({ rootIds: z.array(z.string()), nodes: z.record(z.string(), z.unknown()) }), z.literal('start'), z.null()])
    .optional()
    .describe('The layout of its archive pages, in place of the ready-made cards: a tree of sections and elements whose collection loop over { "$archive": true } shows the page\'s entries. "start" begins one (a list of linked titles and excerpts); null goes back to the ready-made cards.'),
  description: limited(TEXT_LIMITS.pageDescription)
    .optional()
    .describe('What the collection\'s index tells search engines and link previews. "" removes it: the index then uses the site\'s description, else a sentence naming the collection.')
};

/**
 * A change to what a page is for search engines (shared/page-structured-data.ts), as page.update takes it. The bounds
 * here only keep the text sane: each fact's own check (its length counted in characters, after spaces are closed up)
 * decides what is saved, so nothing it takes is refused first.
 */
const loose = (limit: number) => z.string().max(limit * 2 + 40);
const STRUCTURED_DATA_PATCH = z
  .object({
    type: z.enum(PAGE_STRUCTURED_TYPES).optional().describe('What the page is. "WebPage" removes the type and its facts; another type drops the facts of the one before.'),
    serviceType: loose(STRUCTURED_LIMITS.text).optional().describe('Service: what kind of service, e.g. "Pottery classes".'),
    areaServed: loose(STRUCTURED_LIMITS.text).optional().describe('Service: where it is offered, e.g. "Cape Town".'),
    price: loose(STRUCTURED_LIMITS.price).optional().describe('Product: a number, e.g. "129.50".'),
    currency: loose(3).optional().describe('Product: ISO 4217 code, e.g. "ZAR".'),
    availability: z.enum(['', ...PRODUCT_AVAILABILITY] as const).optional().describe('Product.'),
    offerUrl: loose(STRUCTURED_LIMITS.url).optional().describe('Product: where to buy it (https://…).'),
    startDate: loose(25).optional().describe('Event: YYYY-MM-DD, or YYYY-MM-DDThh:mm with an optional +hh:mm offset.'),
    endDate: loose(25).optional().describe('Event: as startDate.'),
    venue: loose(STRUCTURED_LIMITS.text).optional().describe('Event: the venue\'s name.'),
    address: loose(STRUCTURED_LIMITS.address).optional().describe('Event: the venue\'s address on one line.'),
    steps: z.array(loose(STRUCTURED_LIMITS.step)).max(STRUCTURED_LIMITS.steps * 4).optional().describe('HowTo: every step in order. Replaces the list.')
  })
  .strict();

const CANONICAL_DESCRIPTION = 'The full address (https://…) search engines are told is the original, when it is published elsewhere first. "" uses its own public URL.';

/** An entry's details, as entry.create and entry.update take them. */
const ENTRY_FIELDS = {
  slug: z.string().max(400).optional().describe('The last part of its address: lowercase letters, numbers and hyphens, in any script ("spring-sale", "春のセール"). Defaults to a slug of the title, numbered when taken.'),
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Publication date, YYYY-MM-DD; a past date backdates it. Defaults to today.'),
  updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe('When it was last revised, YYYY-MM-DD. null removes it.'),
  draft: z.boolean().optional().describe('true keeps it out of the website while it stays in the project; false publishes it. New entries are drafts.'),
  author: z.string().max(80).nullable().optional(),
  excerpt: z.string().max(320).nullable().optional(),
  featuredImage: z.string().nullable().optional().describe('A library image\'s asset ID; null removes it.'),
  featuredImageAlt: limited(TEXT_LIMITS.imageAlt).nullable().optional().describe('What the featured image shows, for people who cannot see it, on one line. null or "" goes back to the library\'s suggested alt text for the picture. A different featured image given without it starts with none.'),
  terms: z.record(z.string(), z.array(z.string()).max(50)).optional().describe('Term IDs by taxonomy ID. Each taxonomy given replaces that taxonomy\'s terms; others stay.'),
  values: z.record(z.string(), z.unknown()).optional().describe('Custom field values by field name. Each field given is set; null goes back to the field\'s default; others stay. A date is "YYYY-MM-DD" or ""; a reference is an entry ID ("" for none), or a list of them.'),
  body: z.unknown().optional().describe(`The entry's text. ${RICH_TEXT_VALUE} Links may also go to another entry: [label](entry:en_…) or its address.`),
  seoTitle: limited(TEXT_LIMITS.seoTitle).optional().describe('The browser title and link-preview title, used as written. "" goes back to the entry\'s title and the site name.'),
  description: limited(TEXT_LIMITS.pageDescription).optional().describe('What search engines and link previews show. "" goes back to the excerpt, else the site description.'),
  socialImage: z.string().nullable().optional().describe('A library image\'s asset ID to share it with; null goes back to the featured image, else the site\'s sharing image.'),
  canonical: z.string().max(CANONICAL_URL_MAX).optional().describe(CANONICAL_DESCRIPTION),
  noindex: z.boolean().optional().describe('true asks search engines not to list it and leaves it out of the sitemap; it stays published.'),
  searchHidden: z.boolean().optional().describe("Leave it out of the site's own Site search results. Independent of noindex.")
};

/** The longest address a redirect takes: a route four levels deep, every byte of it percent-encoded as a browser copies it. */
const REDIRECT_PATH_MAX = 2000;

/** Where a redirect sends visitors: exactly one of these. */
const REDIRECT_TARGET = {
  pageId: z.string().optional().describe('A page, by ID: the redirect follows it to wherever it moves.'),
  entryId: z.string().optional().describe('A collection entry (a post), by ID: the redirect follows it to wherever it moves.'),
  to: z.string().max(REDIRECT_PATH_MAX).optional().describe('Another address of the site, as a route ("/services/", or "/" for Home): whatever has it then.')
};

export const OPERATION_SCHEMAS = {
  'page.create': z.object({
    type: z.literal('page.create'),
    pageId: z.string().regex(/^pg_[a-z0-9]{4,32}$/).optional().describe('Internal: lets one batch create a page and fill it. Not offered to the model.'),
    title: z.string().min(1).max(80),
    route: z.string().optional().describe('Static route such as "/services/" or "/お問い合わせ/": lowercase letters, numbers and hyphens, in any script. Defaults to a slug of the title. "/services/design/" is a child page of "/services/".'),
    afterPageId: z.string().optional(),
    starter: z
      .enum(['empty', 'intro', 'services', 'about', 'contact', 'pricing', 'faq', 'article'])
      .optional()
      .describe(
        'What the page starts with, from the sections the theme has. Omitted or "empty": no sections. "intro": a page introduction showing the title. "services": the introduction, service cards and a text section. "about": the introduction, a story beside an image and the team. "contact": the introduction, contact details and a contact form. "pricing": the introduction, pricing plans and questions about pricing. "faq": the introduction and expandable questions and answers. Each fills in the theme\'s sample text, to be replaced. "article" makes a dated article (news, an announcement): it adds an Article header showing the title, date, byline and excerpt, and a text section for the body.'
      ),
    addToNavigation: z.boolean().optional().describe('Also add a link to the new page to the shared header navigation (a child page\'s link goes under its parent\'s).'),
    draft: z.boolean().optional().describe('true makes the new page a draft: editable and previewed, but left out of the exported website. An old address kept working at its route keeps sending visitors on until it is published.'),
    ...ARTICLE_FIELDS,
    newsHidden: z.boolean().optional().describe('Articles only. true keeps the new article out of every News list while the page is published.')
  }),
  'page.update': z.object({
    type: z.literal('page.update'),
    pageId: z.string(),
    title: limited(TEXT_LIMITS.pageTitle).min(1).optional(),
    route: z.string().optional().describe('Child pages move with it. Old addresses the website was exported with keep working; others are not kept.'),
    navLabel: limited(TEXT_LIMITS.navLabel).optional(),
    seoTitle: limited(TEXT_LIMITS.seoTitle).optional(),
    description: limited(TEXT_LIMITS.pageDescription).optional(),
    noindex: z.boolean().optional(),
    searchHidden: z.boolean().optional().describe("Leave the page out of the site's own Site search results. Independent of noindex."),
    draft: z.boolean().optional().describe('true keeps the page as a draft: still editable and previewed, but left out of the exported website. false publishes it. The Home page cannot be a draft.'),
    showHeader: z.boolean().optional().describe('Whether this page shows the site\'s shared header. Only this page changes; the footer setting is separate.'),
    showFooter: z.boolean().optional().describe('Whether this page shows the site\'s shared footer. Only this page changes; the header setting is separate.'),
    socialImage: z.string().nullable().optional().describe('Asset ID of the social sharing image; null uses the site image.'),
    canonical: z.string().max(CANONICAL_URL_MAX).optional().describe(CANONICAL_DESCRIPTION),
    updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe('When its content was last revised, YYYY-MM-DD, for the sitemap. null removes it.'),
    language: z.string().max(20).optional().describe('Language code such as "fr", when not the site language. "" uses the site language.'),
    linkTranslationTo: z.string().nullable().optional().describe('Page ID of this page in another language: links them, joining any versions the other has. Each version needs its own language. null unlinks.'),
    ...ARTICLE_FIELDS,
    article: z.literal(false).optional().describe('false makes a dated article an ordinary page again: its date, byline and excerpt are removed and News lists no longer show it.'),
    newsHidden: z.boolean().optional().describe('Articles only. true leaves this article out of every News list while the page stays published; false lists it again.'),
    structuredData: STRUCTURED_DATA_PATCH.optional().describe('What the page is for search engines: one of the publisher\'s own services, products, events or guides, with its facts. Only the fields given change; "" (or [] for steps) clears one.')
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
      .describe('Where links to sections of the removed page go when the replacement page has no section with that ID. A section the replacement page also has is always kept; any other goes to the top of the replacement page unless chosen here.'),
    newHome: z
      .literal(true)
      .optional()
      .describe('Home page only, instead of replacementPageId: leaves a new, empty, published Home page at "/" in its place. Every link and kept old address of the removed page opens the top of the new Home; no other page moves.')
  }),
  'page.setHome': z.object({
    type: z.literal('page.setHome'),
    pageId: z.string(),
    keepOldAddress: z
      .boolean()
      .optional()
      .describe("The page moves to \"/\". Unless false, its old address keeps working (once the website was exported with it) and sends visitors there, so old links and bookmarks still reach it. The previous Home page moves to a new address of its own.")
  }),

  'node.insert': z.object({
    type: z.literal('node.insert'),
    newNodeId: z.string().regex(/^n_[a-z0-9]{4,32}$/).optional().describe('Internal: lets one batch insert a node and fill it. Not offered to the model.'),
    owner,
    parentId: z.string().nullable().optional().describe('Parent element or instance node. Omit or null to insert a top-level section on a page; a component definition has one top-level element, so insert inside it.'),
    slot: z.string().optional().describe('Slot name when inserting into a component instance slot (e.g. "content").'),
    index: z.number().int().min(0).optional().describe('Position among siblings. Defaults to the end.'),
    componentId: z.string().optional().describe('Catalog component ID such as "features.grid".'),
    definitionId: z.string().optional().describe('An installed project component definition ID.'),
    primitive: z
      .enum(['container', 'stack', 'row', 'grid', 'heading', 'paragraph', 'richtext', 'image', 'button', 'icon', 'divider', 'badge', 'figure', 'slot', 'repeat'])
      .optional()
      .describe('"badge" is a compact pill label (an eyebrow) with an optional leading icon; "figure" is an image with a caption beneath it.'),
    bind: z.string().optional().describe('Component definitions only: the list property a "repeat" repeats, or the declared slot a "slot" renders.'),
    query: z.record(z.string(), z.unknown()).optional().describe(`A "repeat" anywhere: the collection loop's query, which it repeats once for each entry it finds. ${COLLECTION_QUERY_TEXT}`),
    archive: z.literal(true).optional().describe("A \"repeat\" in a collection's archive layout: repeat once for each entry the archive page shown lists."),
    props: z.record(z.string(), z.unknown()).optional().describe('Initial property values for a component.'),
    variant: z.string().optional().describe('One variant option, found on whichever axis has it.'),
    variants: z.record(z.string(), z.string()).optional().describe('Options by axis, e.g. { "tone": "inverse", "layout": "two-columns" }.'),
    text: z.string().optional().describe('Initial text for heading, paragraph, button or badge primitives, or a figure\'s caption ("" leaves the caption out).'),
    shape: z.enum(DIVIDER_SHAPES).optional().describe(`Divider only. ${DIVIDER_SHAPE_TEXT}`),
    icon: z.string().optional().describe('A badge\'s leading icon, or the icon of a divider of shape "icon", by name.')
  }),
  'node.remove': z.object({ type: z.literal('node.remove'), owner, nodeId: z.string() }),
  'node.removeKeepContent': z
    .object({
      type: z.literal('node.removeKeepContent'),
      owner,
      nodeId: z.string().describe('A container, or a placed component with slots, that holds content.')
    })
    .describe(
      'Delete a container or a placed component (a two-column layout, say) but keep what it holds: its children, or the content of its slots in the order its component declares them, take its place with their IDs, styles and anchors. The node goes with its own styles, properties, anchor and link. A slot that held it must take that content. On a page\'s top level, sections stay sections and each run of other content goes into a new Section. Not for a component\'s own root, a list repeat, or the shared header or footer.'
    ),
  'node.move': z.object({
    type: z.literal('node.move'),
    owner,
    nodeId: z.string(),
    parentId: z.string().nullable().optional(),
    slot: z.string().optional(),
    index: z.number().int().min(0)
  }),
  'node.wrap': z
    .object({
      type: z.literal('node.wrap'),
      owner,
      nodeIds: z.array(z.string()).min(1).max(200).describe('The elements to wrap: side by side in one list (the same parent, or the same slot of a component), with nothing between them.'),
      primitive: z.enum(['stack', 'row', 'grid']).describe('The new container: "stack" (one above another), "row" (side by side) or "grid".')
    })
    .describe('Wrap elements where they are in a new Stack, Row or Grid: it takes their place and holds them, in their order. Not for sections at the top of a page, or a component\'s own root.'),
  'node.unwrap': z
    .object({
      type: z.literal('node.unwrap'),
      owner,
      nodeIds: z.array(z.string()).min(1).max(200).describe('Plain containers (a Stack, Row, Grid or Container) side by side in one list.')
    })
    .describe('Ungroup containers: what each one holds takes its place, in order, and the container goes with its own layout and styles. Not for a container that links, shows under a condition, carries an anchor or accessible name, or has a tag other than div.'),
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
    state: styleState.optional(),
    property: z.string().describe('Style property ID, e.g. paddingBlock, background, textStyle, gap, columns.'),
    value: styleValue.nullable().describe('Literal value or {"token": "space.lg"}. color and background also take a color token at part strength, {"token": "color.surface", "alpha": 0.7} for 70%, for a see-through surface (with backdropBlur, frosted glass); a plain {"token"} sets it back to full strength. objectPosition also takes a focal point "X% Y%" (each 0 to 100). backgroundImage (containers and sections) takes a library image: {"assetId": "...", "size": "cover", "contain" or "tile" (repeat it, for a pattern or grain), "tileSize": 24, "position": "50% 30%", "scrim": "rgba(0, 0, 0, 0.55)" or one linear-gradient()}; size, tileSize (one tile\'s width in whole CSS pixels, only used by "tile"; without it the picture keeps its own size), position and scrim are optional, and a scrim keeps text over the picture readable. gridTemplate takes a preset or column sizes such as "16rem 1fr 14rem" or "repeat(auto-fit, minmax(18rem, 1fr))"; rowSpan 1 to 6. On a grid, gridAutoFlow "dense" fills holes with later items, and gridAutoRows takes one row size such as "minmax(12rem, auto)" or "1fr". null removes the override.')
  }),
  'node.resetStyles': z.object({
    type: z.literal('node.resetStyles'),
    owner,
    nodeId: z.string(),
    partId: z.string().optional(),
    itemId: z.string().optional().describe('Reset only this repeated item\'s own styles for the part, so it shows the shared style again. Needs partId. Without it the shared part styles are reset and item styles stay.'),
    variant: z.string().optional(),
    axis: z.string().optional(),
    scope: scope.optional().describe('Reset only this size, its states included.'),
    state: styleState.optional().describe('Reset only this state, at scope or every size.')
  }),
  'node.setContent': z.object({
    type: z.literal('node.setContent'),
    owner,
    nodeId: z.string(),
    field: z
      .enum(['text', 'image', 'link', 'label', 'appearance', 'icon', 'iconPosition', 'ariaLabel', 'tag', 'action', 'anchor', 'collapseEmpty', 'appear', 'appearStagger', 'overlay', 'webmcpToolName', 'webmcpToolDescription', 'shape', 'interactionGroup'])
      .describe('"shape" (dividers): "line", "angle", "wave" or "icon"; "icon" on a divider of shape "icon" picks its icon. "webmcpToolName" / "webmcpToolDescription" (contact form placements): the name and description AI agents in visitors\' browsers know the form by while the site has WebMCP on; "" or null goes back to the default. "interactionGroup" (containers): true makes it an interaction group (a card), whose hover or inner focus shows the groupHover and groupFocus styles of the elements inside it; false turns it off. "collapseEmpty" (definition containers): true hides it when all children are hidden. "overlay" (a plain div in a definition whose one condition reads a yes/no UI state): "dialog", "drawer-start", "drawer-end" or "drawer-bottom" shows it over the page while that condition holds, opened and closed by the state\'s buttons; null shows it in its place again. "tag" must fit where the node sits: li in ul/ol, dt/dd in dl, figcaption in figure, summary in details, only inline content in a p or span. "appear": a section or container enters as "fade", "lift" or "scale-subtle"; null clears, "none" turns a design\'s off. "appearStagger" (repeats): true staggers item entrances.'),
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
    binding: binding
      .nullable()
      .describe('{"$prop": name}, {"$prop": name, "field": objectField} for one field of an object property, or {"$item": field}; {"$state": name} (when, unless and variant only) reads the component\'s UI state; {"$entry": field} (a collection\'s layout template only) reads the entry it is shown for. null unbinds, keeping the current default.'),
    eq: conditionValue.optional().describe('For "when"/"unless": render when the bound value equals this (or, for unless, when it does not).'),
    ne: conditionValue.optional().describe('For "when"/"unless": render when the bound value differs from this (or, for unless, when it does not).')
  }),
  'node.setRepeatSource': z
    .object({
      type: z.literal('node.setRepeatSource'),
      owner,
      nodeId: z.string().describe('A collection loop: a repeat over a query or over an archive page\'s entries.'),
      source: z
        .union([z.object({ $query: z.record(z.string(), z.unknown()).describe(COLLECTION_QUERY_TEXT) }).strict(), z.object({ $archive: z.literal(true) }).strict()])
        .describe("What it repeats: a query's entries, or (in a collection's archive layout) the entries of the archive page shown.")
    })
    .describe('Change which entries a collection loop repeats, keeping what each row shows.'),
  'node.setStateAction': z
    .object({
      type: z.literal('node.setStateAction'),
      owner,
      nodeId: z.string().describe('A button in a component definition.'),
      action: stateAction.nullable().describe('What clicking the button does to the UI state; null removes it. The button keeps its link.')
    })
    .describe("Make a button in a component's design change the component's UI state: set it, toggle it, or step to the next or previous option."),
  'instance.setProp': z.object({
    type: z.literal('instance.setProp'),
    owner,
    nodeId: z.string().describe('Instance node ID.'),
    prop: z.string(),
    itemId: z.string().optional().describe('For list properties: the stable item ID to edit.'),
    field: z.string().optional().describe('For list properties: the item field to set. For object properties: the one field to set, keeping the others.'),
    value: z.unknown().describe(`${RICH_TEXT_VALUE} For choices: the whole set in order, { label } for a new choice and the saved { id, label, value } for one kept or renamed. ${TABLE_VALUE}`)
  }),
  'instance.setListSource': z
    .object({
      type: z.literal('instance.setListSource'),
      owner,
      nodeId: z.string().describe('Instance node ID.'),
      prop: z.string().describe('The list property to connect.'),
      source: z
        .object({
          query: z.record(z.string(), z.unknown()).describe(COLLECTION_QUERY_TEXT),
          fields: z.record(z.string(), z.string()).describe('Which entry field fills each item field, by item field name: "title", "excerpt", "publishedAt", "featuredImage", "categories", "terms.<grouping>", "field.<name>", "id", "slug" or "entryLink" (a link to the entry\'s page). Every field an item needs must be filled; others left out show their default.')
        })
        .strict()
        .nullable()
        .describe('null disconnects it: the placement shows its own items again, as it kept them.')
    })
    .describe("Show a collection's entries in a placed section's list (a Team grid's people from a Team collection), each entry one item, instead of the items it holds itself."),
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
  'instance.swapComponent': z
    .object({
      type: z.literal('instance.swapComponent'),
      owner,
      nodeId: z.string().describe('The placed component to change.'),
      componentId: z.string().optional().describe('The catalog component to change it to, such as "hero.split".'),
      definitionId: z.string().optional().describe('Or the project component definition ID to change it to.'),
      allowDrops: z
        .boolean()
        .optional()
        .describe('Let go of content the new design has no place for, as the Inspector does once the author confirms its preview. Without it, such a change is refused and the refusal names that content.')
    })
    .describe(
      'Change a placed component to another design where it is, keeping its content: text, links, images and list items carry over to properties of the same name or meaning (heading/title, lead/body, items/cards/plans), and its anchor, styles and options the new design also has (such as tone) stay.'
    ),

  'token.set': z.object({
    type: z.literal('token.set'),
    tokenId: z.string(),
    value: z
      .unknown()
      .nullable()
      .describe('New value; { "token": "group.name" } to follow another style of the same kind (not for text styles); or null to go back to the theme default (theme styles only).'),
    scheme: z
      .literal('dark')
      .optional()
      .describe('Colors only, on a site with a dark palette (token.setColorScheme): sets the color in the dark palette instead of the light one. null there makes it show its light color again.')
  }),
  'token.setColorScheme': z
    .object({
      type: z.literal('token.setColorScheme'),
      mode: z.enum(['single', 'system', 'toggle']).describe('"single": one palette. "system": a dark palette beside it, shown when the visitor\'s device asks for dark. "toggle": that, plus a Light/Dark switch in the shared header that the browser remembers.'),
      regenerate: z.boolean().optional().describe('Make the dark palette afresh from the light one, replacing its colors. It is made automatically the first time it is turned on.')
    })
    .describe('Choose whether the website has a dark palette for visitors. Edit its colors with token.set and scheme "dark".'),
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
    direction: z.enum(['auto', 'ltr', 'rtl']).optional().describe('Which way the site\'s text runs. "auto" (the default) follows the language: right to left for Arabic, Hebrew, Persian or Urdu, left to right otherwise.'),
    description: limited(TEXT_LIMITS.siteDescription).optional(),
    baseUrl: z.string().max(200).optional(),
    favicon: z.string().nullable().optional(),
    socialImage: z.string().nullable().optional(),
    notFoundHeading: z.string().max(120).optional().describe('Heading of the page shown at an address the site does not have. "" restores the default.'),
    notFoundMessage: z.string().max(400).optional().describe('Message on that page, shown above its link to the Home page. "" restores the default.'),
    notFoundLinkLabel: z.string().max(60).optional().describe('Text of that page\'s link to the Home page. "" restores the default.'),
    llmsTxt: z.boolean().optional().describe('llms.txt, the index of listed pages for AI agents. Default true.'),
    llmsFull: z.boolean().optional().describe('llms-full.txt, every listed page in one file. Default false.'),
    markdownMirrors: z.boolean().optional().describe('A Markdown copy beside each listed page. Default false.'),
    llmsSummary: limited(TEXT_LIMITS.siteDescription).optional().describe('llms.txt summary; "" uses the description.'),
    headerMenuOrder: z
      .enum(['own', 'follow'])
      .optional()
      .describe('The header menu\'s order. "own" (default): its links keep the order the author gave them, whatever the page order. "follow": its links to pages stay in the page order through every edit (a page.reorder, a page added to the menu), a deleted page\'s menu links are removed rather than pointed at its replacement, and its links cannot be moved by hand. Other links and submenus keep their places.'),
    webmcp: z.boolean().optional().describe('WebMCP: declare each contact form, and site search, as tools AI agents in visitors\' browsers can use. Default false.'),
    redirectHost: z
      .enum(['cloudflare', 'netlify', 'vercel'])
      .optional()
      .describe('The host the website is published on, for its HTTP 301 redirect rules: "cloudflare" (default) writes _redirects for Cloudflare Pages, "netlify" for Netlify, "vercel" also writes vercel.json.'),
    crawlerPolicy: z
      .object({
        preset: z
          .enum(CRAWLER_PRESETS)
          .optional()
          .describe('"allow-all" (default): every crawler. "block-ai-training": AI training crawlers kept out. "search-engines-only": AI search, assistant and training crawlers kept out. "custom": a base preset changed by the fields below. Leaving custom drops its rules.'),
        base: z.enum(FIXED_CRAWLER_PRESETS).nullable().optional().describe('Custom only: the preset it starts from. Defaults to the preset it was switched from; null is allow-all.'),
        overrides: z
          .record(z.string().max(CRAWLER_LIMITS.token), z.enum(['allow', 'disallow']).nullable())
          .optional()
          .describe('Custom only: crawlers by robots.txt product token (e.g. "GPTBot"), let in or kept out of the whole site whatever the base does; null drops one. Only the tokens given change.'),
        alsoBlock: z.array(z.string().max(CRAWLER_LIMITS.token)).max(CRAWLER_LIMITS.overrides).optional().describe('Custom only: every crawler not listed in a preset to keep out (replaces those); applied before overrides.'),
        disallowPaths: z.array(z.string().max(CRAWLER_LIMITS.path)).max(CRAWLER_LIMITS.paths).optional().describe('Custom only: paths no crawler may fetch, from the site root ("/private/", "/*.pdf$"). Replaces the list.'),
        noAiMeta: z.boolean().nullable().optional().describe('Pages carry <meta name="robots" content="noai, noimageai">. Kept through presets; null: on while the (base) preset blocks AI training.')
      })
      .strict()
      .superRefine((policy, ctx) => {
        for (const token of Object.keys(policy.overrides ?? {})) {
          const c = checkCrawlerToken(token);
          if (!c.ok) ctx.addIssue({ code: 'custom', path: ['overrides', token], message: c.message });
        }
        (policy.alsoBlock ?? []).forEach((token, i) => {
          const c = checkCrawlerToken(token);
          if (!c.ok) ctx.addIssue({ code: 'custom', path: ['alsoBlock', i], message: c.message });
        });
        (policy.disallowPaths ?? []).forEach((path, i) => {
          const c = checkCrawlerPath(path);
          if (!c.ok) ctx.addIssue({ code: 'custom', path: ['disallowPaths', i], message: c.message });
        });
      })
      .nullable()
      .optional()
      .describe('robots.txt crawler policy (projectSummary.site.crawlerPolicy shows it once set). Only the fields given change; null restores the default.'),
    visitorText: z
      .object({
        language: z.string().max(20).describe('Language code, e.g. "ar": pages in it use this wording.'),
        text: z.record(z.string(), z.string().max(VISITOR_TEXT_LIMIT)).describe(`Wording by key (${VISITOR_TEXT_KEYS.join(', ')}). "" goes back to the wording used without it. {braced} names are filled in.`)
      })
      .optional()
      .describe('What the site says on its own (skip link, menu button, form progress, search, image viewer) in one language. Built in for en, ar, he.'),
    identity: z
      .object({
        kind: z.enum(['Organization', 'LocalBusiness', 'Person']).nullable().optional().describe('Who publishes the site. Unset: described as an organization named after the site.'),
        name: z.string().max(IDENTITY_LIMITS.name).nullable().optional().describe('Legal or brand name, when it is not the site name.'),
        url: z.string().max(IDENTITY_LIMITS.url).nullable().optional().describe('The publisher\'s own home page, when it is not this site (https://…).'),
        logo: z.string().nullable().optional().describe('Asset ID of an image: the logo, or a person\'s photo.'),
        sameAs: z.array(z.string().max(IDENTITY_LIMITS.url)).max(IDENTITY_LIMITS.profiles).nullable().optional().describe('Every https:// address of a profile that says who the publisher is (Wikidata, LinkedIn, GitHub, X, YouTube). Replaces the list.'),
        twitterSite: z.string().max(IDENTITY_LIMITS.twitterSite).nullable().optional().describe('X (Twitter) handle, e.g. "@riverside".'),
        address: z.string().max(IDENTITY_LIMITS.address).nullable().optional().describe('Postal address on one line.'),
        telephone: z.string().max(IDENTITY_LIMITS.telephone).nullable().optional(),
        email: z.string().max(IDENTITY_LIMITS.email).nullable().optional(),
        openingHours: z.array(z.string().max(IDENTITY_LIMITS.hoursLine)).max(IDENTITY_LIMITS.hours).nullable().optional().describe('Local business only: periods such as "Mo-Fr 09:00-17:00". Replaces the list.'),
        priceRange: z.string().max(IDENTITY_LIMITS.priceRange).nullable().optional().describe('Local business only, e.g. "$$".'),
        geo: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).nullable().optional().describe('Local business only: its map position.')
      })
      .nullable()
      .optional()
      .describe('Who publishes the site, for search engines and AI answer engines. Only the fields given change; null clears one (so does "" for text, or [] for a list), and identity: null clears all of it. Opening hours, price range and geo belong to a LocalBusiness: another kind clears them.')
  }),
  'redirect.add': z
    .object({
      type: z.literal('redirect.add'),
      from: z.string().max(REDIRECT_PATH_MAX).describe('The old address, as a route such as "/old-services/".'),
      ...REDIRECT_TARGET
    })
    .describe('Keep an old address working: visitors and search engines are sent on with a permanent redirect (HTTP 301). Give exactly one of pageId, entryId or to.'),
  'redirect.update': z
    .object({
      type: z.literal('redirect.update'),
      from: z.string().max(REDIRECT_PATH_MAX).describe('The old address of a redirect the site keeps.'),
      ...REDIRECT_TARGET
    })
    .describe('Send an old address somewhere else. Give exactly one of pageId, entryId or to; it replaces where it went.'),
  'redirect.remove': z.object({ type: z.literal('redirect.remove'), from: z.string().max(REDIRECT_PATH_MAX).describe('The old address of a redirect the site keeps.') }).describe('Stop keeping an old address working: it then shows the not-found page.'),
  // Editor only: the project's private brief (#518), which never reaches the website. Only the fields given change;
  // "" clears one.
  'brief.update': z.object({
    type: z.literal('brief.update'),
    description: limited(TEXT_LIMITS.projectDescription).optional(),
    notes: limited(TEXT_LIMITS.projectNotes).optional()
  }),

  'component.create': z
    .object({
      type: z.literal('component.create'),
      definitionId: z.string().optional().describe('Internal: lets one batch create a component and place it. Not offered to the model.'),
      name: z.string().min(1).max(60),
      description: z.string().max(300).optional().describe('What the component is for, as the Insert panel shows it.')
    })
    .describe(
      'Create a new, empty managed project component: one container element, its root, which the result names (rootNodeId) beside its definitionId. Build its design with node.insert and the other node operations under owner { kind: "component", id: definitionId }, give it properties with component.setPropSchema and node.setBinding, and place it on a page with node.insert { definitionId }.'
    ),
  'component.upsert': z
    .object({
      type: z.literal('component.upsert'),
      definitionId: z.string().optional().describe('A managed project component to rebuild. Omit to create a new one.'),
      newDefinitionId: z.string().optional().describe('Internal: lets one batch create a component and place it. Not offered to the model.'),
      name: z.string().min(1).max(60),
      description: z.string().max(300).optional(),
      category: z.enum(COMPONENT_CATEGORIES.filter((c) => c !== 'shell') as unknown as [string, ...string[]]).optional(),
      tags: z.array(z.string().min(1).max(40)).max(12).optional(),
      icon: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
      insertAs: z.enum(['section', 'element']).nullable().optional().describe('Where Insert puts a new placement; null lets the editor tell from the design.'),
      properties: z.record(z.string(), z.unknown()).describe('The whole property schema, in order: { propName: { type, label, default, ... } } as in component.createCode.'),
      nodes: z.array(DESIGN_NODE).min(1).max(300).describe('Every node of the design. Exactly one is inside no other: the root, an element that carries the component.'),
      parts: z
        .record(z.string(), z.object({ nodeId: DESIGN_NODE_ID, label: z.string().min(1).max(60), styleControls: z.array(z.string()).max(80).optional() }).strict())
        .optional()
        .describe('Parts placements can style, by ID. "root" is always the root node.'),
      slots: z
        .record(
          z.string(),
          z
            .object({
              label: z.string().min(1).max(60),
              description: z.string().max(300).optional(),
              categories: z.array(z.enum(COMPONENT_CATEGORIES as unknown as [string, ...string[]])).max(20).optional(),
              componentIds: z.array(z.string().min(1).max(120)).max(50).optional(),
              primitives: z.array(z.enum(SLOT_PRIMITIVES as unknown as [string, ...string[]])).max(6).optional(),
              max: z.number().int().min(0).max(1000).optional()
            })
            .strict()
        )
        .optional()
        .describe('Slots each placement fills with content of its own; each is shown by one slot node.'),
      variantAxes: z
        .record(
          z.string(),
          z
            .object({
              label: z.string().min(1).max(40),
              default: z.string().optional().describe('The option placements show until they choose. Defaults to the first.'),
              options: z
                .record(z.string(), z.object({ label: z.string().min(1).max(60), styles: z.record(DESIGN_NODE_ID, designStyles).optional().describe('Style rules by node ID.') }).strict())
                .refine((o) => Object.keys(o).length > 0, 'An axis needs at least one option.')
            })
            .strict()
        )
        .optional()
        .describe('Independent design choices (tone, layout), each with its options.'),
      state: z
        .record(z.string(), uiStateDecl)
        .optional()
        .describe('UI state the design reads in conditions ({"$state": name}) and its buttons change (stateAction), by camelCase name: { "open": { "type": "boolean" } }, { "plan": { "type": "enum", "options": ["monthly", "annual"] } }. Placements never set it.')
    })
    .describe(
      'Create a managed project component, or rebuild one, from one description of its properties, design, parts, slots, variants and UI state. A rebuild replaces the whole design and its UI state; placements keep the values, list items, style changes and slot content the new contract still takes, or nothing changes.'
    ),
  'component.createFromNode': z.object({ type: z.literal('component.createFromNode'), owner, nodeId: z.string(), name: z.string().min(1).max(60) }),
  'component.makeUnique': z.object({ type: z.literal('component.makeUnique'), owner, nodeId: z.string(), name: z.string().max(60).optional() }),
  'component.detachInstance': z
    .object({ type: z.literal('component.detachInstance'), owner, nodeId: z.string().describe('A managed component placement on a page.') })
    .describe(
      "Replace one placement with ordinary page elements that look the same: its properties' current values, one copy per list item, the branches its settings show, its variant and style changes, and its slot content in place. The component and its other placements stay as they are."
    ),
  'component.duplicate': z.object({ type: z.literal('component.duplicate'), definitionId: z.string(), name: z.string().min(1).max(60) }),
  'component.rename': z.object({ type: z.literal('component.rename'), definitionId: z.string(), name: z.string().min(1).max(60), description: z.string().max(300).optional() }),
  // Editor only: where Insert and quick-add put a new placement of a project component (#661).
  'component.setInsertAs': z
    .object({ type: z.literal('component.setInsertAs'), definitionId: z.string(), insertAs: z.enum(['section', 'element']).nullable() })
    .describe('Where Insert puts a new placement: one of a page\'s sections, or an element inside a layout; null lets the editor tell from the design.'),
  // A project copy of a component that can be changed on its own (§8.4): for every placement, or only some.
  'component.fork': z.object({
    type: z.literal('component.fork'),
    definitionId: z.string(),
    placements: z
      .array(z.object({ owner, nodeId: z.string() }))
      .min(1)
      .max(60)
      .optional()
      .describe('Only these move to the copy, sharing it; the rest keep the original. Without it, every placement moves.')
  }),
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
        'Property schema: { propName: { type, label, default } }. Types: string, richtext, number, boolean, enum (options), link, image, icon, choices, list (itemLabel, fields), table (default { columns, rows }). required: true marks a value the component cannot render without: neither its default nor any placement may leave it empty. A richtext property or list field reaches the code as one string per paragraph or list item with **bold** and *italic*, unless it declares codeForm: "blocks", which passes structured blocks to render with <RichText value={...} /> imported from "../runtime/RichText.svelte" (links, lists and headings included).'
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
  // Editor only: lands a component package the editor read and checked. The package travels beside the batch, never
  // in it, so an operation alone can import nothing.
  'component.import': z.object({ type: z.literal('component.import'), importId: z.string().regex(/^imp_[A-Za-z0-9]{8}$/) }),
  'component.setPropSchema': z.object({
    type: z.literal('component.setPropSchema'),
    definitionId: z.string(),
    prop: z.string(),
    schema: z.record(z.string(), z.unknown()).describe('{ type, label, default, ... } as in component.createCode.')
  }),
  'component.removePropSchema': z.object({ type: z.literal('component.removePropSchema'), definitionId: z.string(), prop: z.string() }),
  // The editor's property list in Edit everywhere. Not offered to the model.
  'component.orderProperties': z.object({
    type: z.literal('component.orderProperties'),
    definitionId: z.string(),
    order: z.array(z.string()).describe('Every property name of the component, each once, in the order placements list them.')
  }),
  'component.setPropDefault': z.object({
    type: z.literal('component.setPropDefault'),
    definitionId: z.string(),
    prop: z.string(),
    value: z.unknown().describe('The new default: what placements without a value of their own show, and what new placements start with.')
  }),
  'component.setState': z
    .object({
      type: z.literal('component.setState'),
      definitionId: z.string(),
      state: z.string().describe('The UI state variable to add or change: a camelCase name such as "open" or "billing", not one of the properties.'),
      schema: uiStateDecl
    })
    .describe("Declare UI state a managed component's design reads in conditions and variants and its buttons change. Placements never set it."),
  'component.removeState': z.object({ type: z.literal('component.removeState'), definitionId: z.string(), state: z.string() }),
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
    axis: z.string().optional().describe('The variant axis to add to. A new name creates the axis, with a plain "default" option that placements keep unless makeDefault is set. Defaults to the only axis, or "style".'),
    axisLabel: z.string().min(1).max(40).optional(),
    prop: z
      .string()
      .max(60)
      .optional()
      .describe('Code components only: the property the code takes this axis’s option through, from $props(). Left out, a new axis arrives in a property named as the axis, and an existing one keeps its own.'),
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
      .describe('Component categories the slot takes. With componentIds or primitives, the slot takes only what one of them lists; with none, anything. Left out keeps it; null removes the restriction.'),
    componentIds: z
      .array(z.string().min(1).max(120))
      .max(50)
      .nullable()
      .optional()
      .describe('Components the slot takes by ID, whatever their category: a catalog contract ID (such as "features.grid") or a project component definition ID. Left out keeps it; null removes the restriction.'),
    primitives: z
      .array(z.enum(SLOT_PRIMITIVES as unknown as [string, ...string[]]))
      .max(6)
      .nullable()
      .optional()
      .describe('Element kinds the slot takes: element (containers), text, image, link (buttons), icon, divider. Left out keeps it; null removes the restriction.'),
    max: z.number().int().min(0).max(1000).nullable().optional().describe('The most children the slot holds; 0 closes it. Left out keeps it; null removes the limit.')
  }),
  'component.removeSlot': z.object({ type: z.literal('component.removeSlot'), definitionId: z.string(), slot: z.string() }),
  'component.containerToSlot': z
    .object({
      type: z.literal('component.containerToSlot'),
      definitionId: z.string(),
      nodeId: z.string().describe('A container (element) of the design. It stays, with its tag and styles; its children give way to the new slot.'),
      slot: z.string().describe('The new slot\'s name: a camelCase identifier no slot, property or placement of the component uses yet.'),
      label: z.string().min(1).max(60),
      keep: z
        .enum(['placements', 'none'])
        .describe('placements: each placement gets its own copy of the children, as it shows them now, in its new slot. none: the children are removed, and the slot starts empty everywhere.')
    })
    .describe('Turn a container of a project component into a slot that takes anything, in one change: its children become each placement\'s content there, or go.'),

  'theme.apply': z.object({ type: z.literal('theme.apply'), themeId: z.string() }),
  'theme.refresh': z
    .object({ type: z.literal('theme.refresh'), definitionIds: z.array(z.string()).optional().describe('Only these definitions. Defaults to every one that can be updated.') })
    .describe('Update installed theme components to the current theme version. Forked, project and hand-edited components are never changed.'),

  'collection.create': z
    .object({
      type: z.literal('collection.create'),
      collectionId: z.string().max(60).describe('Stable lowercase ID and folder name, such as "posts" or "case-studies". "posts" is the ready-made blog: Posts at /blog/, with categories and tags.'),
      ...COLLECTION_SETTINGS,
      addToNavigation: z.boolean().optional().describe('Also add a link to the collection\'s index (its list of entries) to the shared header navigation, while the menu has room.')
    })
    .describe('Add a collection of entries kept apart from the pages, such as blog posts or projects.'),
  'collection.update': z.object({
    type: z.literal('collection.update'),
    collectionId: z.string(),
    ...COLLECTION_SETTINGS,
    categoryDescription: z
      .object({ termId: z.string().max(60), description: limited(TEXT_LIMITS.pageDescription) })
      .strict()
      .optional()
      .describe('What one category\'s archive page tells search engines and link previews, by the category\'s term ID. "" removes it: the archive then uses a sentence naming the category.'),
    sourceId: z.null().optional().describe('null detaches it from the external source its entries are synced from, so they can be edited here. Attaching is done by a sync.')
  }),
  'collection.remove': z.object({ type: z.literal('collection.remove'), collectionId: z.string() }).describe('Delete a collection and every entry in it. Refused while anything outside it links to one of its entries.'),
  'collection.createTerm': z
    .object({
      type: z.literal('collection.createTerm'),
      collectionId: z.string(),
      taxonomyId: z.string().max(60).describe('The grouping: "categories" or "tags" (added to a collection that has none), or another grouping the collection has.'),
      label: z.string().min(1).max(80).describe('The term\'s name as readers see it; no other term of the grouping may have it, ignoring case.'),
      termId: z.string().max(60).optional().describe('Its stable ID, also its archive address (category/<ID>/): lowercase letters, numbers and hyphens. Defaults to a slug of the name, numbered when taken.')
    })
    .describe('Add a category, a tag or another term to one of a collection\'s groupings.'),
  'collection.renameTerm': z
    .object({
      type: z.literal('collection.renameTerm'),
      collectionId: z.string(),
      taxonomyId: z.string().max(60),
      termId: z.string().max(60),
      label: z.string().min(1).max(80).describe('Its new name.'),
      newTermId: z.string().max(60).optional().describe('Its new ID and archive address. Defaults to a slug of the new name (the ID it has, when that slug is the same).')
    })
    .describe('Rename a term. Its name and ID change together: every entry filed under it stays filed under it, and every list of entries that chooses it, by name or ID, goes on listing the same entries.'),
  'collection.removeTerm': z
    .object({ type: z.literal('collection.removeTerm'), collectionId: z.string(), taxonomyId: z.string().max(60), termId: z.string().max(60) })
    .describe('Delete a term from its grouping and from every entry filed under it. Refused while a list of entries chooses entries by it.'),
  'entry.create': z.object({
    type: z.literal('entry.create'),
    collectionId: z.string(),
    entryId: z.string().regex(/^en_[a-z0-9]{4,32}$/).optional().describe('Internal: lets one batch create an entry and link to it.'),
    title: z.string().min(1).max(200),
    ...ENTRY_FIELDS,
    redirectFrom: z.string().max(1100).optional().describe('An address the post had on an earlier site, such as "/2019/03/winter-workshop/", kept working by sending visitors to the new entry. Nothing else may use it.')
  }),
  'entry.update': z.object({ type: z.literal('entry.update'), collectionId: z.string(), entryId: z.string(), title: z.string().min(1).max(200).optional(), ...ENTRY_FIELDS }),
  'entry.reorder': z.object({
    type: z.literal('entry.reorder'),
    collectionId: z.string(),
    entryIds: z.array(z.string()).nullable().describe('Every entry of the collection exactly once, in the order chosen; null goes back to newest first.')
  }),
  'entry.remove': z.object({
    type: z.literal('entry.remove'),
    collectionId: z.string(),
    entryId: z.string(),
    replacementEntryId: z.string().optional().describe('Links to the removed entry are pointed to this entry. One of the replacements is required while anything links to it.'),
    replacementPageId: z.string().optional().describe('Links to the removed entry are pointed to this page instead.')
  }),

  // Editor only: an external source's settings (#676). A credential is only ever named, by the secret the user keeps
  // outside the project.
  'source.upsert': z
    .object({
      type: z.literal('source.upsert'),
      sourceId: z.string().max(60).describe('Stable lowercase ID and folder name, such as "team-cms".'),
      name: z.string().min(1).max(120),
      adapter: z.string().max(40).describe('The kind of source it is, which says how its records are read.'),
      collectionId: z.string().max(60).describe('The collection its records are synced into.'),
      config: z
        .record(z.string().max(40), z.unknown())
        .describe('Its kind of source’s settings (an address, headers, a query…). Credentials only as { "credentials": { "<slot>": { "$secret": "<name>" } } } or ${secret:NAME} in a header or query value, never the value.'),
      mapping: z.record(z.string().max(40), z.unknown()).optional().describe('Where each detail of an entry is read from in a record, by path ("fields.title"). Left out: the kind of source’s own reading.'),
      converter: z.string().max(60_000).optional().describe('The text of its converter.mjs, which puts its records in shape instead of a mapping. Left out: none.'),
      removal: z.enum(['unpublish', 'remove', 'keep']).optional().describe('What a sync does with an entry the source no longer has. Defaults to unpublish, which drafts it so links keep working.')
    })
    .describe('Add an external source, or replace its settings whole.'),
  'source.remove': z.object({ type: z.literal('source.remove'), sourceId: z.string() }).describe('Delete an external source. Refused while a collection is synced from it.'),

  'asset.add': z.object({
    type: z.literal('asset.add'),
    asset: z.object({
      id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/), name: z.string().max(200),
      file: ASSET_FILE, mime: z.string(), bytes: z.number(), width: z.number().optional(), height: z.number().optional(),
      hash: z.string(), kind: z.enum(['image', 'font', 'document']), createdAt: z.string(), variants: ASSET_VARIANTS.optional(), copiesPending: z.literal(true).optional(), description: z.string().optional(), altSuggestion: z.string().optional(),
      font: FONT_FACE.optional(), originalName: z.string().max(255).optional()
    })
  }),
  'asset.update': z.object({ type: z.literal('asset.update'), assetId: z.string(), name: z.string().max(120).optional(), description: limited(TEXT_LIMITS.assetDescription).optional(), altSuggestion: limited(TEXT_LIMITS.altSuggestion).optional(), font: FONT_FACE.optional() }),
  'asset.remove': z.object({
    type: z.literal('asset.remove'),
    assetId: z.string(),
    fontUses: z
      .union([z.literal('keep'), z.literal('fallback'), z.object({ replaceWith: z.string().min(1).max(200) })])
      .optional()
      .describe(
        'Editor only, for a font file whose family the site uses, after the author has seen what changes: keep the family on its other files; fall back, taking the family out of every style (each falls back to its next font); or put another font stack in place of the family.'
      )
  }),
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

/**
 * Every code a change or an AI tool result can fail with (specification §13.3). BUSY: the project is held by another
 * writer for now. ONE_CHANGE_PER_TURN: a second change in one model step, skipped. UPDATE_HELD: a theme component update
 * this project cannot take yet. SAVE_FAILED: the editor's change could not be written to the project's folder (its
 * `details.save` says whether reopening the project finishes it); an AI run's save that fails ends the run instead.
 */
export const TOOL_ERROR_CODES = ['INVALID_ARGUMENT', 'STALE_REVISION', 'SCOPE_MISMATCH', 'PATH_DENIED', 'VALIDATION_FAILED', 'CONFLICT', 'CANCELLED', 'BUSY', 'ONE_CHANGE_PER_TURN', 'UPDATE_HELD', 'SAVE_FAILED'] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/** Why a change or a tool call failed. `recoverable`: a corrected or later call can still succeed in this run. */
export interface ToolError {
  code: ToolErrorCode;
  message: string;
  recoverable: boolean;
  details?: unknown;
}

export interface ApplyResult {
  ok: boolean;
  revision: number;
  /** Per-operation results such as new node or page IDs. */
  results?: Array<Record<string, unknown>>;
  changed?: string[];
  /** The history entry the change was recorded in, so an Undo offered for it reverses that entry and no other. */
  entryId?: string;
  /** An Undo or Redo of one History step: that step's label, as History names it. */
  label?: string;
  error?: ToolError;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Fields whose string values are used as lookup keys. Content (text, labels) may contain any words. */
const KEY_FIELDS = /(^id$|Id$|^prop$|^field$|^property$|^variant$|^axis$|^slot$|^parentId$|^bind$|^\$prop$|^\$item$|^\$state$)/;
/**
 * An operation's own lists of IDs (`pageIds`, `nodeIds`): lookup keys too. Only the operation's top-level fields,
 * never the content it carries, where a property may be named anything and hold any words.
 */
const KEY_LIST_FIELDS = /Ids$/;
const forbiddenList = (k: string, x: unknown) => KEY_LIST_FIELDS.test(k) && Array.isArray(x) && x.some((e) => typeof e === 'string' && FORBIDDEN_KEYS.has(e));
function hasForbidden(v: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(v)) return v.some((x) => hasForbidden(x, depth + 1));
  if (v && typeof v === 'object')
    return Object.entries(v).some(
      ([k, x]) => FORBIDDEN_KEYS.has(k) || (KEY_FIELDS.test(k) && typeof x === 'string' && FORBIDDEN_KEYS.has(x)) || (depth === 0 && forbiddenList(k, x)) || hasForbidden(x, depth + 1)
    );
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
