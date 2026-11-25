/**
 * How a page and the whole site are found, shared and read by search engines and AI agents, each in one call: a
 * page's search settings, and the site's public address, language, sharing image, publisher identity, crawler policy
 * and llms.txt settings. Each call compiles to one validated `page.update` or `site.update`, so it goes through the
 * same scope check, validation and undo group as any other edit, and its schema has nothing a grammar-constrained
 * local model cannot express: no open record (crawlers are rows), every object closed.
 */
import { z } from 'zod';
import type { ProjectState } from '@shared/types';
import { OPERATION_SCHEMAS, type EditOperation } from '@shared/ops';
import { CRAWLER_LIMITS, foldToken } from '@shared/crawler-policy';
import { pageIdFor } from './context';
import { fieldError, type FieldIssue } from './macros';
import { applySelected } from './selection';
import type { JsonSchema } from './propschema';
import type { ToolHost, ToolOutcome } from './tools';

const PAGE = OPERATION_SCHEMAS['page.update'].shape;
const SITE = OPERATION_SCHEMAS['site.update'].shape;
const IDENTITY = SITE.identity.unwrap().unwrap();
const POLICY = SITE.crawlerPolicy.unwrap().unwrap().shape;

const IMAGE_ID = 'assetId of a library image (search_assets)';

export const PAGE_SEO_ARGS = z
  .object({
    pageId: z.string().min(1).describe('The page: its ID (pg_…) or its route, such as "/about/".'),
    seoTitle: PAGE.seoTitle.describe('Browser tab and search result title, used as written: specific, about 50 to 60 characters. "" goes back to the page title and the site name.'),
    description: PAGE.description.describe('Search result and link preview summary: one or two sentences that answer what the page offers. "" removes it.'),
    noindex: PAGE.noindex.describe('true asks search engines and AI answer engines to leave the page out of their results; false lets them list it.'),
    searchHidden: PAGE.searchHidden,
    socialImage: PAGE.socialImage.describe(`Link preview image: the ${IMAGE_ID}. null or "" uses the site's image.`),
    canonical: PAGE.canonical,
    language: PAGE.language,
    updatedAt: PAGE.updatedAt
  })
  .strict();
export type PageSeoArgs = z.infer<typeof PAGE_SEO_ARGS>;

/** Crawlers named in a custom policy, as rows: a grammar cannot describe a record keyed by product token. */
const CRAWLER_ROW = z
  .object({
    token: z.string().min(1).max(CRAWLER_LIMITS.token).describe('The crawler\'s robots.txt product token, such as "GPTBot".'),
    access: z.enum(['allow', 'disallow']).nullable().describe('"allow" lets it in, "disallow" keeps it out of the whole site; null takes it off the list.')
  })
  .strict();

const CRAWLER_POLICY = z
  .object({
    preset: POLICY.preset,
    base: POLICY.base,
    overrides: z.array(CRAWLER_ROW).max(CRAWLER_LIMITS.overrides).optional().describe('Custom only: crawlers let in or kept out by name, whatever the base does. Only the crawlers given change.'),
    alsoBlock: POLICY.alsoBlock,
    disallowPaths: POLICY.disallowPaths,
    noAiMeta: POLICY.noAiMeta
  })
  .strict();

const GEO = IDENTITY.shape.geo.unwrap().unwrap().strict();

export const SITE_SEO_ARGS = z
  .object({
    description: SITE.description.describe('The site\'s summary for search results, link previews and AI agents: who it is for and what it offers.'),
    baseUrl: SITE.baseUrl.describe('The public address the site is published at (https://…), for canonical links, the sitemap and link previews. "" clears it.'),
    language: SITE.language.describe('The site\'s language code, such as "en" or "fr-CA".'),
    socialImage: SITE.socialImage.describe(`Default link preview image: the ${IMAGE_ID}. null or "" removes it.`),
    favicon: SITE.favicon.describe(`Browser tab and search result icon: the ${IMAGE_ID}. null or "" removes it.`),
    llmsTxt: SITE.llmsTxt,
    llmsFull: SITE.llmsFull,
    markdownMirrors: SITE.markdownMirrors,
    llmsSummary: SITE.llmsSummary,
    identity: IDENTITY.extend({ geo: GEO.nullable().optional().describe(IDENTITY.shape.geo.description ?? '') })
      .strict()
      .nullable()
      .optional()
      .describe(SITE.identity.description ?? ''),
    crawlerPolicy: CRAWLER_POLICY.nullable()
      .optional()
      .describe('robots.txt crawler policy. Only the fields given change; null restores the default (every crawler let in).')
  })
  .strict();
export type SiteSeoArgs = z.infer<typeof SITE_SEO_ARGS>;

export const PAGE_SEO_DESCRIPTION =
  "Change how one page is found and shared, in one call: its search result title and description, whether search engines list it (noindex) and the site's own search shows it, its link preview image, canonical address, language and last revision date. Send only what changes; nothing else on the page changes.";
export const PAGE_SEO_BRIEF = "Set one page's search title and description, noindex, site search, link preview image, canonical address, language or revision date. Send only what changes.";

export const SITE_SEO_DESCRIPTION =
  'Change how the whole site is found, shared and read by search engines and AI agents, in one call: its description, public address (baseUrl), language, default link preview image and icon, who publishes it (identity, for search engines and AI answer engines), which crawlers robots.txt lets in (crawlerPolicy), and llms.txt for AI agents. Send only what changes. Fill identity only from facts the user gave.';
export const SITE_SEO_BRIEF = 'Set the site description, public address, language, link preview image, icon, publisher identity, crawler policy and llms.txt settings. Send only what changes; identity only from facts the user gave.';

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

/** An asset field as the operation takes it: "" removes it, as null does. */
function imageField(state: ProjectState, field: string, value: string | null | undefined, issues: FieldIssue[]): string | null | undefined {
  if (value === undefined || value === null || value.trim() === '') return value === undefined ? undefined : null;
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
  if (settings.socialImage !== undefined) settings.socialImage = imageField(state, 'socialImage', settings.socialImage as string | null, issues);
  if (issues.length) return fieldError(issues, 'Nothing was applied.');
  const op = { type: 'page.update', pageId, ...settings } as EditOperation;
  return applySelected([op], host, `Update ${state.pages[pageId].title} search settings`, callId);
}

export async function runSiteSeo(args: SiteSeoArgs, host: ToolHost, callId: string): Promise<ToolOutcome> {
  const state = host.state();
  const { identity, crawlerPolicy, ...rest } = args;
  const update: Record<string, unknown> = given(rest);
  const issues: FieldIssue[] = [];
  for (const field of ['socialImage', 'favicon'] as const) if (update[field] !== undefined) update[field] = imageField(state, field, update[field] as string | null, issues);

  if (identity === null) update.identity = null;
  else if (identity) {
    const patch: Record<string, unknown> = given(identity);
    if (patch.logo !== undefined) patch.logo = imageField(state, 'identity.logo', patch.logo as string | null, issues);
    if (Object.keys(patch).length) update.identity = patch;
  }

  if (crawlerPolicy === null) update.crawlerPolicy = null;
  else if (crawlerPolicy) {
    const { overrides, ...policy } = crawlerPolicy;
    const patch: Record<string, unknown> = given(policy);
    if (overrides?.length) {
      // One entry per crawler: robots.txt compares their names whatever the case, so two rows for one would leave
      // only the last, and the other would be lost without a word.
      const seen = new Map<string, number>();
      overrides.forEach((row, i) => {
        const key = foldToken(row.token.trim());
        if (seen.has(key)) issues.push({ field: `crawlerPolicy.overrides[${i}].token`, message: `"${row.token}" is already in overrides[${seen.get(key)}]: send each crawler once` });
        else seen.set(key, i);
      });
      patch.overrides = Object.fromEntries(overrides.map((row) => [row.token.trim(), row.access]));
    }
    if (Object.keys(patch).length) update.crawlerPolicy = patch;
  }

  if (issues.length) return fieldError(issues, 'Nothing was applied.');
  if (!Object.keys(update).length) return fieldError([{ field: 'arguments', message: NOTHING }], 'Nothing was applied.');
  return applySelected([{ type: 'site.update', ...update } as EditOperation], host, 'Update site search settings', callId);
}
