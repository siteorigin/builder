/**
 * How a page and the whole site are found, shared and read by search engines and AI agents, each in one call: a
 * page's search settings, and the site's public address, language, sharing image, publisher identity, crawler policy
 * and llms.txt settings. Each call compiles to one validated `page.update` or `site.update`, so it goes through the
 * same scope check, validation and undo group as any other edit, and its schema has nothing a grammar-constrained
 * local model cannot express: no open record (crawlers are rows), every object closed.
 */
import { z } from 'zod';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { TEXT_LIMITS } from '@shared/text-limits';
import { CANONICAL_URL_MAX } from '@shared/seo';
import { CRAWLER_LIMITS, CRAWLER_PRESETS, FIXED_CRAWLER_PRESETS, foldToken } from '@shared/crawler-policy';
import { IDENTITY_LIMITS } from '@shared/site-identity';
import { pageIdFor } from './context';
import { fieldError, type FieldIssue } from './macros';
import { applySelected } from './selection';
import type { JsonSchema } from './propschema';
import type { ToolHost, ToolOutcome } from './tools';

/** A library image by its assetId. "" removes it, as the operation's null does, which keeps a union out of the grammar. */
const image = (description = 'assetId') => z.string().max(200).optional().describe(description);
const text = (limit: number) => z.string().max(limit).optional();
const list = (limit: number, items: number) => z.array(z.string().max(limit)).max(items).optional();
const LOCAL = 'LocalBusiness only.';
const CUSTOM = 'Custom only.';

/** A page's own search settings, as page.update takes them, with "" for every clear. Shared rules are in the description. */
export const PAGE_SEO_ARGS = z
  .object({
    pageId: z.string().min(1).describe('ID or route.'),
    seoTitle: text(TEXT_LIMITS.seoTitle),
    description: text(TEXT_LIMITS.pageDescription),
    noindex: z.boolean().optional(),
    searchHidden: z.boolean().optional().describe("Out of the site's own search."),
    socialImage: image(),
    canonical: text(CANONICAL_URL_MAX),
    language: text(20)
  })
  .strict();
export type PageSeoArgs = z.infer<typeof PAGE_SEO_ARGS>;

/** Who publishes the site. Text clears with "" and a list with [], as the operation takes them, so only geo is nullable. */
const IDENTITY_ARG = z
  .object({
    kind: z.enum(['Organization', 'LocalBusiness', 'Person', '']).optional().describe('"" unsets it.'),
    name: text(IDENTITY_LIMITS.name),
    url: text(IDENTITY_LIMITS.url),
    logo: image(),
    sameAs: list(IDENTITY_LIMITS.url, IDENTITY_LIMITS.profiles).describe('Profile URLs (Wikidata, LinkedIn, X…).'),
    twitterSite: text(IDENTITY_LIMITS.twitterSite),
    address: text(IDENTITY_LIMITS.address),
    telephone: text(IDENTITY_LIMITS.telephone),
    email: text(IDENTITY_LIMITS.email),
    openingHours: list(IDENTITY_LIMITS.hoursLine, IDENTITY_LIMITS.hours).describe(`${LOCAL} "Mo-Fr 09:00-17:00"`),
    priceRange: text(IDENTITY_LIMITS.priceRange).describe(LOCAL),
    geo: z
      .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
      .strict()
      .nullable()
      .optional()
      .describe(LOCAL)
  })
  .strict();

/** Crawlers named in a custom policy, as rows: a grammar cannot describe a record keyed by product token. */
const CRAWLER_ROW = z.object({ token: z.string().min(1).max(CRAWLER_LIMITS.token), access: z.enum(['allow', 'disallow', 'default']) }).strict();

const CRAWLER_POLICY_ARG = z
  .object({
    preset: z.enum(CRAWLER_PRESETS).optional(),
    base: z.enum(FIXED_CRAWLER_PRESETS).optional().describe(CUSTOM),
    overrides: z.array(CRAWLER_ROW).max(CRAWLER_LIMITS.overrides).optional().describe(`${CUSTOM} By robots.txt token ("GPTBot"); "default" leaves it to the base.`),
    alsoBlock: list(CRAWLER_LIMITS.token, CRAWLER_LIMITS.overrides).describe(`${CUSTOM} Unlisted crawlers to keep out.`),
    disallowPaths: list(CRAWLER_LIMITS.path, CRAWLER_LIMITS.paths).describe(`${CUSTOM} Paths no crawler may fetch ("/private/").`),
    noAiMeta: z.boolean().nullable().optional().describe('noai robots meta; null follows the preset.')
  })
  .strict();

/** The site's search, sharing and AI-agent settings, as site.update takes them, with "" for a clear. */
export const SITE_SEO_ARGS = z
  .object({
    description: text(TEXT_LIMITS.siteDescription),
    baseUrl: text(200).describe('Public https:// address.'),
    language: z.string().min(1).max(20).optional(),
    socialImage: image(),
    llmsTxt: z.boolean().optional(),
    llmsFull: z.boolean().optional(),
    markdownMirrors: z.boolean().optional(),
    llmsSummary: text(TEXT_LIMITS.siteDescription),
    identity: IDENTITY_ARG.nullable().optional().describe('The publisher, for search and AI answer engines.'),
    crawlerPolicy: CRAWLER_POLICY_ARG.nullable().optional().describe('robots.txt.')
  })
  .strict();
export type SiteSeoArgs = z.infer<typeof SITE_SEO_ARGS>;

export const PAGE_SEO_DESCRIPTION =
  'Set one page\'s search title and description, noindex (out of search engines and AI answers), link preview image (a library assetId), canonical address and language. Send only what changes; "" restores a default.';
export const PAGE_SEO_BRIEF = 'Send only what changes; "" restores a default.';

export const SITE_SEO_DESCRIPTION =
  'Set how search engines and AI agents find and read the whole site: description, public address, language, link preview image (a library assetId), llms.txt (llmsFull: every page in one file; markdownMirrors: a Markdown copy of each page), publisher identity and robots.txt crawler policy. Send only what changes; "" or [] clears a field, null resets identity or crawlerPolicy, and inside them only the fields given change. Identity only from facts the user gave.';
export const SITE_SEO_BRIEF = '"" or [] clears; null resets identity or crawlerPolicy. Identity only from facts the user gave.';

/** The page tool's schema; `onlyPageId` is the one page a run limited to it may change. */
export function pageSeoToolSchema(onlyPageId?: string): JsonSchema {
  const schema = z.toJSONSchema(PAGE_SEO_ARGS, { unrepresentable: 'any', io: 'input' }) as JsonSchema & { properties: Record<string, unknown> };
  delete schema.$schema;
  if (!onlyPageId) return schema;
  return { ...schema, properties: { ...schema.properties, pageId: { type: 'string', enum: [onlyPageId], description: 'This request may change only this page.' } } };
}

export function siteSeoToolSchema(): JsonSchema {
  const schema = z.toJSONSchema(SITE_SEO_ARGS, { unrepresentable: 'any', io: 'input' }) as JsonSchema;
  delete schema.$schema;
  return schema;
}

/** The fields a call gave, leaving out the ones it did not. */
const given = <T extends object>(v: T): Partial<T> => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as Partial<T>;

/** An image in the project's library. */
const isImage = (state: ProjectState, id: string) => Object.hasOwn(state.assets.assets, id) && state.assets.assets[id].kind === 'image';

/** An image field as the operation takes it: "" removes it, as null does there. */
function imageField(state: ProjectState, field: string, value: string, issues: FieldIssue[]): string | null {
  if (value.trim() === '') return null;
  if (!isImage(state, value.trim())) issues.push({ field, message: `no library image has the assetId "${value}". Use an assetId search_assets returns` });
  return value.trim();
}

const NOTHING = 'send at least one setting to change';

export async function runPageSeo(args: PageSeoArgs, host: ToolHost, callId: string): Promise<ToolOutcome> {
  const state = host.state();
  const { pageId: ref, ...rest } = args;
  const pageId = pageIdFor(state, ref);
  if (!pageId) return fieldError([{ field: 'pageId', message: `there is no page "${ref}". Pages: ${state.site.pageOrder.map((id) => `${id} (${state.pages[id]?.route})`).join(', ')}` }], 'Nothing was applied.');
  const settings: Record<string, unknown> = given(rest);
  if (!Object.keys(settings).length) return fieldError([{ field: 'arguments', message: NOTHING }], 'Nothing was applied.');
  const issues: FieldIssue[] = [];
  if (settings.socialImage !== undefined) settings.socialImage = imageField(state, 'socialImage', settings.socialImage as string, issues);
  if (issues.length) return fieldError(issues, 'Nothing was applied.');
  const op = { type: 'page.update', pageId, ...settings } as EditOperation;
  return applySelected([op], host, `Update ${state.pages[pageId].title} search settings`, callId);
}

export async function runSiteSeo(args: SiteSeoArgs, host: ToolHost, callId: string): Promise<ToolOutcome> {
  const state = host.state();
  const { identity, crawlerPolicy, ...rest } = args;
  const update: Record<string, unknown> = given(rest);
  const issues: FieldIssue[] = [];
  if (update.socialImage !== undefined) update.socialImage = imageField(state, 'socialImage', update.socialImage as string, issues);

  if (identity === null) update.identity = null;
  else if (identity) {
    const patch: Record<string, unknown> = given(identity);
    // An unset kind is the operation's null: back to an organization named after the site.
    if (patch.kind === '') patch.kind = null;
    if (patch.logo !== undefined) patch.logo = imageField(state, 'identity.logo', patch.logo as string, issues);
    if (Object.keys(patch).length) update.identity = patch;
  }

  if (crawlerPolicy === null) update.crawlerPolicy = null;
  else if (crawlerPolicy) {
    const { overrides, ...policy } = crawlerPolicy;
    const patch: Record<string, unknown> = given(policy);
    // The list changes only the crawlers it names, so an empty one would change nothing while the call reported success.
    if (overrides && !overrides.length) issues.push({ field: 'crawlerPolicy.overrides', message: 'name each crawler to change; "default" leaves one to the base preset' });
    if (overrides?.length) {
      // One entry per crawler: robots.txt compares their names whatever the case, so two rows for one would leave
      // only the last, and the other would be lost without a word.
      const seen = new Map<string, number>();
      overrides.forEach((row, i) => {
        const key = foldToken(row.token.trim());
        if (seen.has(key)) issues.push({ field: `crawlerPolicy.overrides[${i}].token`, message: `"${row.token}" is already in overrides[${seen.get(key)}]: send each crawler once` });
        else seen.set(key, i);
      });
      // "default" takes a crawler off the list, as the operation's null does.
      patch.overrides = Object.fromEntries(overrides.map((row) => [row.token.trim(), row.access === 'default' ? null : row.access]));
    }
    if (Object.keys(patch).length) update.crawlerPolicy = patch;
  }

  if (issues.length) return fieldError(issues, 'Nothing was applied.');
  if (!Object.keys(update).length) return fieldError([{ field: 'arguments', message: NOTHING }], 'Nothing was applied.');
  return applySelected([{ type: 'site.update', ...update } as EditOperation], host, 'Update site search settings', callId);
}
