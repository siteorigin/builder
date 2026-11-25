/**
 * Which crawlers the website asks to stay away, as its robots.txt says it (RFC 9309, https://www.rfc-editor.org/rfc/rfc9309.html),
 * and whether its pages also ask AI services not to train on them (`<meta name="robots" content="noai, noimageai">`).
 *
 * The author picks a preset: everyone in (the default, the robots.txt the website always had), AI training crawlers
 * out, or every AI crawler out. Or Custom, which starts from one of those and changes it: a crawler let in or kept out
 * by name, and paths no crawler may fetch. Every crawler not named follows the `User-agent: *` group, which lets it in,
 * so search engines, link previews and crawlers no list has heard of keep working whatever is chosen, unless a path
 * closes the whole site to all of them.
 *
 * The site keeps only what differs from the default (`SiteDoc.crawlerPolicy`, see `storedCrawlerPolicy`), and reads a
 * hand-edited value it can't use as no choice (`crawlerRules`), so a damaged entry never crashes the website.
 */
import type { SiteDoc } from './types';
import type { Checked } from './site-identity';
import { publicUrl } from './public-url';

export type CrawlerKind = 'search' | 'ai-search' | 'ai-training';
export type CrawlerAction = 'allow' | 'disallow';

export interface KnownCrawler {
  /** Its product token, as robots.txt names it. Crawlers match it whatever its case. */
  token: string;
  /** Who runs it. */
  operator: string;
  kind: CrawlerKind;
  /** What it fetches pages for, in a few words. */
  purpose: string;
}

/**
 * The crawlers the presets name, and Site settings lists. Search engines first, then the crawlers AI answer engines
 * cite pages from (and the fetchers AI assistants visit a page with when a person asks), then those that gather pages
 * to train AI models.
 */
export const KNOWN_CRAWLERS: readonly KnownCrawler[] = [
  { token: 'Googlebot', operator: 'Google', kind: 'search', purpose: 'Google Search' },
  { token: 'Bingbot', operator: 'Microsoft', kind: 'search', purpose: 'Bing, and the search results of assistants built on it' },
  { token: 'DuckDuckBot', operator: 'DuckDuckGo', kind: 'search', purpose: 'DuckDuckGo' },
  { token: 'Applebot', operator: 'Apple', kind: 'search', purpose: 'Spotlight, Siri and Safari suggestions' },
  { token: 'OAI-SearchBot', operator: 'OpenAI', kind: 'ai-search', purpose: 'ChatGPT search results' },
  { token: 'ChatGPT-User', operator: 'OpenAI', kind: 'ai-search', purpose: 'Pages ChatGPT opens when a person asks it to' },
  { token: 'Claude-SearchBot', operator: 'Anthropic', kind: 'ai-search', purpose: 'Claude search results' },
  { token: 'Claude-User', operator: 'Anthropic', kind: 'ai-search', purpose: 'Pages Claude opens when a person asks it to' },
  { token: 'PerplexityBot', operator: 'Perplexity', kind: 'ai-search', purpose: 'Perplexity search results' },
  { token: 'Perplexity-User', operator: 'Perplexity', kind: 'ai-search', purpose: 'Pages Perplexity opens when a person asks it to' },
  { token: 'GPTBot', operator: 'OpenAI', kind: 'ai-training', purpose: 'Training OpenAI’s models' },
  { token: 'ClaudeBot', operator: 'Anthropic', kind: 'ai-training', purpose: 'Training Anthropic’s models' },
  { token: 'Google-Extended', operator: 'Google', kind: 'ai-training', purpose: 'Training Gemini models, and grounding their answers' },
  { token: 'Applebot-Extended', operator: 'Apple', kind: 'ai-training', purpose: 'Training Apple’s models on pages Applebot fetched' },
  { token: 'CCBot', operator: 'Common Crawl', kind: 'ai-training', purpose: 'The Common Crawl archive many models are trained on' },
  { token: 'Bytespider', operator: 'ByteDance', kind: 'ai-training', purpose: 'Training ByteDance’s models' },
  { token: 'Meta-ExternalAgent', operator: 'Meta', kind: 'ai-training', purpose: 'Training Meta’s models, and indexing for its AI' }
];

export const FIXED_CRAWLER_PRESETS = ['allow-all', 'block-ai-training', 'search-engines-only'] as const;
export type FixedCrawlerPreset = (typeof FIXED_CRAWLER_PRESETS)[number];
export const CRAWLER_PRESETS = [...FIXED_CRAWLER_PRESETS, 'custom'] as const;
export type CrawlerPreset = (typeof CRAWLER_PRESETS)[number];

export const CRAWLER_PRESET_LABELS: Record<CrawlerPreset, string> = {
  'allow-all': 'Allow search and AI',
  'block-ai-training': 'Allow AI search and citations, block AI training',
  'search-engines-only': 'Traditional search engines only',
  custom: 'Custom'
};

/** The kinds of crawler each fixed preset keeps out by name. */
const PRESET_BLOCKS: Record<FixedCrawlerPreset, readonly CrawlerKind[]> = {
  'allow-all': [],
  'block-ai-training': ['ai-training'],
  'search-engines-only': ['ai-search', 'ai-training']
};

/** The most named crawlers and paths a policy keeps, and the longest of each: far inside what crawlers read of a robots.txt. */
export const CRAWLER_LIMITS = { overrides: 64, paths: 64, token: 128, path: 512 } as const;

/** The policy as the site keeps it: only what differs from the default, the rules of its own only for Custom. */
export interface CrawlerPolicy {
  preset: CrawlerPreset;
  /** Custom: the preset its rules start from. Absent: Allow search and AI. */
  base?: FixedCrawlerPreset;
  /** Custom: crawlers let in or kept out by name, whatever the base does with them, by their product token. */
  overrides?: Record<string, CrawlerAction>;
  /** Custom: paths of the website no crawler may fetch, from its root ("/private/"), in robots.txt's pattern syntax. */
  disallowPaths?: string[];
  /** Whether pages carry the noai meta, when it differs from the default: on while the base keeps AI training out. */
  noAiMeta?: boolean;
}

/** A change to the policy, as `site.update` makes it: only the parts given change. */
export interface CrawlerPolicyPatch {
  preset?: CrawlerPreset;
  /** null: back to Allow search and AI. */
  base?: FixedCrawlerPreset | null;
  /** Each crawler named, let in or kept out; null takes it off the list. */
  overrides?: Record<string, CrawlerAction | null>;
  /** Replaces the list. */
  disallowPaths?: string[];
  /** null: back to the default. */
  noAiMeta?: boolean | null;
}

/** The policy as the website follows it. */
export interface CrawlerRules {
  preset: CrawlerPreset;
  /** The fixed preset whose rules apply: the preset itself, or Custom's starting point. */
  base: FixedCrawlerPreset;
  /** Crawlers named by Custom, by their token folded to lower case, with the spelling kept. */
  overrides: ReadonlyMap<string, { token: string; action: CrawlerAction }>;
  /** Custom's paths, checked and in order. */
  paths: readonly string[];
  noAiMeta: boolean;
}

const ok = <T>(value: T): Checked<T> => ({ ok: true, value });
const no = <T>(message: string): Checked<T> => ({ ok: false, message });

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** A product token as crawlers compare it (RFC 9309 matches them whatever their case). */
export const foldToken = (token: string) => token.toLowerCase();
const KNOWN_BY_TOKEN = new Map(KNOWN_CRAWLERS.map((c) => [foldToken(c.token), c]));
/** The listed crawler a token names, whatever its case. */
export const knownCrawler = (token: string): KnownCrawler | undefined => KNOWN_BY_TOKEN.get(foldToken(token));
const isFixed = (v: unknown): v is FixedCrawlerPreset => (FIXED_CRAWLER_PRESETS as readonly unknown[]).includes(v);
const isPreset = (v: unknown): v is CrawlerPreset => (CRAWLER_PRESETS as readonly unknown[]).includes(v);
const isAction = (v: unknown): v is CrawlerAction => v === 'allow' || v === 'disallow';
/** Tokens in the order robots.txt lists them: by their letters, whatever the case. */
const byToken = (a: string, b: string) => (foldToken(a) < foldToken(b) ? -1 : foldToken(a) > foldToken(b) ? 1 : a < b ? -1 : a > b ? 1 : 0);

/** What a fixed preset does with a crawler: a listed one of a kind it keeps out is kept out; everyone else is let in. */
export function presetAction(preset: FixedCrawlerPreset, token: string): CrawlerAction {
  const known = knownCrawler(token);
  return known && PRESET_BLOCKS[preset].includes(known.kind) ? 'disallow' : 'allow';
}

/** Whether a preset's pages carry the noai meta unless the author says otherwise: while it keeps AI training out. */
export const presetNoAiMeta = (preset: FixedCrawlerPreset) => PRESET_BLOCKS[preset].includes('ai-training');

/**
 * Check a crawler's name as robots.txt names it: a product token, letters, hyphens and underscores only ("GPTBot",
 * "Meta-ExternalAgent"). Gives back a listed crawler's own spelling, else the token as typed.
 */
export function checkCrawlerToken(input: string): Checked<string> {
  const token = input.trim();
  if (!token) return no('Give the crawler’s name, as robots.txt names it.');
  if (token === '*') return no('“*” is every crawler: to keep all of them off a path, add the path instead.');
  if (/^user-agent\s*:/i.test(token)) return no('Give the crawler’s name alone, without “User-agent:”.');
  if (token.length > CRAWLER_LIMITS.token) return no(`A crawler’s name is at most ${CRAWLER_LIMITS.token} characters.`);
  if (!/^[A-Za-z_-]+$/.test(token)) return no(`“${token}” is not a crawler’s name as robots.txt takes it: letters, hyphens and underscores only, with no version or spaces (GPTBot, not GPTBot/1.2).`);
  return ok(knownCrawler(token)?.token ?? token);
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;
/** Every character a path pattern may hold once its other characters are percent-encoded. */
const PATH_CHARS = /^[A-Za-z0-9\-._~!&'()+,;=:@/?*$%]*$/;

/**
 * Check a path no crawler may fetch, from the root of the website: it starts with "/", ends with "$" to match only
 * that address, and "*" stands for any characters. Letters of other alphabets are percent-encoded as browsers send
 * them, escapes are written the one way ("%2f" is "%2F", "%41" is "A"), and the rest of the characters an address
 * can't hold are refused.
 */
export function checkCrawlerPath(input: string): Checked<string> {
  const raw = input.trim();
  if (!raw) return no('Give the path, starting with “/”.');
  if (/\s/.test(raw)) return no(`“${raw}” has a space in it: write a space in an address as %20.`);
  if (!raw.startsWith('/')) return no(`“${raw}” is not a path of the website: start it with “/”, as in /private/.`);
  if (raw.startsWith('//')) return no(`“${raw}” starts with “//”, which names another site: give the path from this site’s root.`);
  if (raw.includes('#')) return no(`“${raw}” has a “#” in it: crawlers never send the part of an address after “#”.`);
  // Letters outside ASCII, as UTF-8 escapes, the way crawlers send them.
  let path = '';
  try {
    for (const ch of raw) path += ch.charCodeAt(0) > 0x7e ? encodeURIComponent(ch) : ch;
  } catch {
    return no(`“${raw}” has a character no address can hold.`);
  }
  if (!PATH_CHARS.test(path)) {
    const bad = [...path].find((ch) => !/[A-Za-z0-9\-._~!&'()+,;=:@/?*$%]/.test(ch));
    return no(`“${raw}” has a “${bad}” in it, which an address can’t hold: percent-encode it.`);
  }
  // Escapes written one way: hex in capitals, and a letter, digit or -._~ as itself.
  let bad = false;
  path = path.replace(/%(.{0,2})/g, (whole, hex: string) => {
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bad = true;
      return whole;
    }
    const ch = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
  if (bad) return no(`“${raw}” has a “%” that is not followed by two hexadecimal digits: write a “%” itself as %25.`);
  const dollar = path.indexOf('$');
  if (dollar !== -1 && dollar !== path.length - 1) return no(`“${raw}” has a “$” before its end: “$” only marks where the address ends. Write a “$” itself as %24.`);
  const segments = path.split('?')[0].split('/');
  if (segments.some((s) => s === '.' || s === '..' || s === '.$' || s === '..$')) return no(`“${raw}” has a “.” or “..” part, which browsers resolve away: give the path it leads to.`);
  if (path.length > CRAWLER_LIMITS.path) return no(`A path is at most ${CRAWLER_LIMITS.path} characters.`);
  return ok(path);
}

/** A path pattern that matches every address of the website: "/", "/*" or "/*$". "/$" is the home page alone. */
export const isWholeSitePattern = (path: string) => /^\/(\*+\$?)?$/.test(path);

/** Paths checked, without repeats, in the order robots.txt lists them (by their characters). */
function checkPathList(list: readonly string[]): Checked<string[]> {
  const out = new Set<string>();
  for (const line of list) {
    const c = checkCrawlerPath(line);
    if (!c.ok) return c;
    out.add(c.value);
  }
  if (out.size > CRAWLER_LIMITS.paths) return no(`A policy keeps at most ${CRAWLER_LIMITS.paths} paths.`);
  return ok([...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Text with one path per line, as Site settings takes it: blank lines are left out. */
export function checkCrawlerPathLines(text: string): Checked<string[]> {
  return checkPathList(text.split(/\r?\n/).filter((l) => l.trim()));
}

/** Text with one crawler's name per line, as Site settings takes it: blank lines are left out, and a repeat is one. */
export function checkCrawlerTokenLines(text: string): Checked<string[]> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = checkCrawlerToken(line);
    if (!c.ok) return c;
    if (!out.has(foldToken(c.value))) out.set(foldToken(c.value), c.value);
  }
  return ok([...out.values()].sort(byToken));
}

/** The default policy, as the website follows it: every crawler let in, no paths closed, no noai meta. */
const DEFAULT_RULES: CrawlerRules = { preset: 'allow-all', base: 'allow-all', overrides: new Map(), paths: [], noAiMeta: false };

/**
 * The policy as the website follows it. A value of another kind (written by hand) is no choice: an unknown preset is
 * the default, an unknown base is Allow search and AI, and a path or a crawler's entry that can't be used is left
 * out on its own, so one damaged line never opens the site to every crawler the rest keeps out. A crawler named twice
 * (in two spellings) with different actions is left to its base.
 */
export function crawlerRules(site: Pick<SiteDoc, 'crawlerPolicy'>): CrawlerRules {
  const raw: unknown = site.crawlerPolicy;
  if (!isRecord(raw) || !isPreset(raw.preset)) return isRecord(raw) && typeof raw.noAiMeta === 'boolean' ? { ...DEFAULT_RULES, noAiMeta: raw.noAiMeta } : DEFAULT_RULES;
  const preset = raw.preset;
  const custom = preset === 'custom';
  const base: FixedCrawlerPreset = custom ? (isFixed(raw.base) ? raw.base : 'allow-all') : preset;
  const overrides = new Map<string, { token: string; action: CrawlerAction }>();
  const conflicting = new Set<string>();
  if (custom && isRecord(raw.overrides))
    for (const [name, action] of Object.entries(raw.overrides)) {
      const token = checkCrawlerToken(name);
      if (!token.ok || !isAction(action)) continue;
      const key = foldToken(token.value);
      const had = overrides.get(key);
      if (had && had.action !== action) conflicting.add(key);
      else if (!had) overrides.set(key, { token: token.value, action });
    }
  for (const key of conflicting) overrides.delete(key);
  const paths: string[] = [];
  if (custom && Array.isArray(raw.disallowPaths))
    for (const p of raw.disallowPaths) {
      const c = typeof p === 'string' ? checkCrawlerPath(p) : null;
      if (c?.ok && !paths.includes(c.value)) paths.push(c.value);
    }
  paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { preset, base, overrides, paths, noAiMeta: typeof raw.noAiMeta === 'boolean' ? raw.noAiMeta : presetNoAiMeta(base) };
}

/** What the policy does with a crawler, and whether that is its base's doing or Custom names it. */
export function crawlerAction(rules: CrawlerRules, token: string): { action: CrawlerAction; named: boolean } {
  const own = rules.overrides.get(foldToken(token));
  return own ? { action: own.action, named: true } : { action: presetAction(rules.base, token), named: false };
}

/** The crawlers kept out of the whole site by name: the base's, less those Custom lets in, with those it keeps out. */
export function blockedCrawlers(rules: CrawlerRules): string[] {
  const out = new Map<string, string>();
  for (const c of KNOWN_CRAWLERS) if (crawlerAction(rules, c.token).action === 'disallow') out.set(foldToken(c.token), c.token);
  for (const [key, o] of rules.overrides) if (o.action === 'disallow') out.set(key, o.token);
  return [...out.values()].sort(byToken);
}

/**
 * The policy as the site keeps it (see CrawlerPolicy): nothing for the default, and for Custom only the base, the
 * crawlers it names and its paths, each in the order robots.txt lists them. A crawler Custom lets in that only Custom
 * could keep out (one no preset names) is no rule, and is left out.
 */
export function storedCrawlerPolicy(rules: CrawlerRules): CrawlerPolicy | undefined {
  const policy: CrawlerPolicy = { preset: rules.preset };
  if (rules.preset === 'custom') {
    if (rules.base !== 'allow-all') policy.base = rules.base;
    const named = [...rules.overrides.values()].filter((o) => o.action === 'disallow' || knownCrawler(o.token)).sort((a, b) => byToken(a.token, b.token));
    if (named.length) policy.overrides = Object.fromEntries(named.map((o) => [o.token, o.action]));
    if (rules.paths.length) policy.disallowPaths = [...rules.paths];
  }
  if (rules.noAiMeta !== presetNoAiMeta(rules.base)) policy.noAiMeta = rules.noAiMeta;
  return policy.preset === 'allow-all' && policy.noAiMeta === undefined ? undefined : policy;
}

/**
 * The policy a `site.update` leaves: `patch` over the stored one, or the default for null. Choosing a fixed preset
 * drops Custom's own rules; choosing Custom from a fixed preset starts from that preset. Base, crawlers and paths
 * belong to Custom alone, and are refused for any other preset. A crawler's name or a path that can't be used is
 * refused with the reason, as is a crawler named twice. Gives back the policy to keep, or nothing for the default.
 */
export function patchCrawlerPolicy(stored: unknown, patch: CrawlerPolicyPatch | null): Checked<CrawlerPolicy | undefined> {
  if (patch === null) return ok(undefined);
  const current = crawlerRules({ crawlerPolicy: stored as SiteDoc['crawlerPolicy'] });
  const preset = patch.preset ?? current.preset;
  const custom = preset === 'custom';
  if (!custom && (patch.base !== undefined || patch.overrides !== undefined || patch.disallowPaths !== undefined))
    return no('Only a Custom crawler policy has a base, crawlers named on their own and paths: set preset to "custom" with them.');
  // Leaving Custom drops its rules; coming to it starts from the preset left.
  const was = current.preset === 'custom';
  let base: FixedCrawlerPreset = custom ? (was ? current.base : (current.preset as FixedCrawlerPreset)) : (preset as FixedCrawlerPreset);
  if (patch.base !== undefined) base = patch.base ?? 'allow-all';
  const overrides = new Map(custom && was ? current.overrides : []);
  if (patch.overrides) {
    const seen = new Set<string>();
    const entries = Object.entries(patch.overrides);
    for (const [name, action] of entries) {
      const token = checkCrawlerToken(name);
      if (!token.ok) return token;
      const key = foldToken(token.value);
      if (seen.has(key)) return no(`${token.value} is named twice: name each crawler once.`);
      seen.add(key);
      if (action === null) overrides.delete(key);
      else if (!isAction(action)) return no(`${token.value}: say "allow" or "disallow", or null to take it off the list.`);
      else overrides.set(key, { token: token.value, action });
    }
  }
  if (overrides.size > CRAWLER_LIMITS.overrides) return no(`A policy names at most ${CRAWLER_LIMITS.overrides} crawlers on their own.`);
  let paths = custom && was ? [...current.paths] : [];
  if (patch.disallowPaths) {
    const checked = checkPathList(patch.disallowPaths);
    if (!checked.ok) return checked;
    paths = checked.value;
  }
  // The noai meta follows the base until the author says otherwise, and the author's choice stays through presets.
  const explicit = isRecord(stored) && typeof stored.noAiMeta === 'boolean' ? stored.noAiMeta : undefined;
  const meta = patch.noAiMeta === null ? undefined : (patch.noAiMeta ?? explicit);
  return ok(storedCrawlerPolicy({ preset, base, overrides, paths, noAiMeta: meta ?? presetNoAiMeta(base) }));
}

/** The policy a patch leaves, as the website would follow it: for a preview of a change before it is saved. */
export function patchedCrawlerRules(site: Pick<SiteDoc, 'crawlerPolicy'>, patch: CrawlerPolicyPatch): CrawlerRules | null {
  const next = patchCrawlerPolicy(site.crawlerPolicy, patch);
  return next.ok ? crawlerRules({ crawlerPolicy: next.value }) : null;
}

/**
 * The patterns that close the whole website to a crawler. At the root of its domain that is "/". Under a sub-path
 * ("/studio") it is that address, everything under it and a query on it, never the domain's other sites
 * ("/studio-next/"), so the lines hold when they are copied into the domain's own robots.txt.
 */
function wholeSite(mount: string): string[] {
  return mount ? [`${mount}$`, `${mount}/`, `${mount}?`] : ['/'];
}

/** A path of the website as robots.txt names it: from the domain's root, under the site's sub-path. */
function sitePattern(path: string, mount: string): string[] {
  if (!mount) return [path];
  return isWholeSitePattern(path) ? wholeSite(mount) : [mount + path];
}

/**
 * The website's robots.txt (RFC 9309). Every crawler not named follows `User-agent: *`, which lets it in, or keeps it
 * off Custom's paths. Those kept out of the whole site share one group after it, by name. Under a sub-path every
 * pattern starts with it. The sitemap's address ends it when the site has a public URL. Without a policy it is the
 * robots.txt the website always had: `User-agent: *` and `Allow: /`.
 */
export function robotsTxt(rules: CrawlerRules, opts: { mount?: string; sitemap?: string } = {}): string {
  const mount = opts.mount ?? '';
  const unique = (lines: string[]) => [...new Set(lines)];
  const lines = ['User-agent: *'];
  if (rules.paths.length) for (const p of unique(rules.paths.flatMap((p) => sitePattern(p, mount)))) lines.push(`Disallow: ${p}`);
  else lines.push('Allow: /');
  const blocked = blockedCrawlers(rules);
  if (blocked.length) {
    lines.push('');
    for (const token of blocked) lines.push(`User-agent: ${token}`);
    for (const p of wholeSite(mount)) lines.push(`Disallow: ${p}`);
  }
  if (opts.sitemap) lines.push('', `Sitemap: ${opts.sitemap}`);
  return lines.join('\n') + '\n';
}

/** The sub-path the site is published under, from its public URL ("https://me.github.io/studio" gives "/studio"). */
export function siteMount(site: Pick<SiteDoc, 'baseUrl'>): string {
  const url = publicUrl(site);
  return url ? new URL(url).pathname.replace(/\/+$/, '') : '';
}

/** The site's robots.txt: its policy (or `rules`, for a preview), its sub-path and its sitemap. */
export function siteRobotsTxt(site: Pick<SiteDoc, 'crawlerPolicy' | 'baseUrl'>, rules: CrawlerRules = crawlerRules(site)): string {
  const base = publicUrl(site);
  return robotsTxt(rules, { mount: siteMount(site), sitemap: base ? `${base}/sitemap.xml` : undefined });
}

/** The meta tag that asks AI services not to train on a page's words or images. */
export const NOAI_META = '<meta name="robots" content="noai, noimageai" />';
