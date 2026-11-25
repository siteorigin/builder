/**
 * Issue 589: the website's robots.txt from a crawler policy. Presets keep AI training crawlers, or every AI crawler,
 * out by name while every other crawler follows `User-agent: *`; Custom starts from a preset, names crawlers of its
 * own and closes paths to all of them; pages can ask AI services not to train on them; and the audit warns when a
 * search engine or an AI search engine is kept out of the whole site without its preset saying so.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import { applyOperations } from '@engine/apply';
import { runSeoAudit } from '@engine/seo-audit';
import { generateProject } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { checkCrawlerPath, checkCrawlerPathLines, checkCrawlerToken, checkCrawlerTokenLines, crawlerRules, NOAI_META, patchCrawlerPolicy, patchedCrawlerRules, robotsTxt, siteRobotsTxt, storedCrawlerPolicy } from '@shared/crawler-policy';
import { projectSummary } from '../../src/agent/context';
import { checkHeld, fieldKey, readField, readFields, shownField, typedText } from '../../src/renderer/src/lib/held';
import { destinationLabel } from '../../src/renderer/src/lib/destinations';
import { run, seoSite } from './fixtures/seo-site';

const policy = (s: ProjectState, crawlerPolicy: Record<string, unknown> | null) => run(s, { type: 'site.update', crawlerPolicy } as EditOperation);
const robots = (s: ProjectState) => generateProject(s).get('static/robots.txt');
const layout = (s: ProjectState) => generateProject(s).get('src/routes/+layout.svelte')!;
/** The SEO fixture at the root of its domain, with no public URL, so robots.txt is the policy's lines alone. */
const rootSite = () => {
  const { state } = seoSite();
  delete state.site.baseUrl;
  return state;
};
const refusal = (s: ProjectState, crawlerPolicy: Record<string, unknown> | null) => {
  try {
    policy(s, crawlerPolicy);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};
const invalid = (crawlerPolicy: unknown) => {
  const r = validateOperation({ type: 'site.update', crawlerPolicy });
  return r.ok ? null : r.message;
};

/**
 * Whether a crawler may fetch a path under a robots.txt, read the way RFC 9309 says, apart from the code that writes
 * it: the groups naming the crawler (whatever the case), else the `*` group; then the longest matching rule, an allow
 * winning a tie; `*` matches any characters and a final `$` the end.
 */
function mayFetch(file: string, agent: string, path: string, fallback?: string): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; pattern: string }> }> = [];
  let open = false;
  for (const raw of file.split('\n')) {
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(raw.replace(/#.*/, '').trim());
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'user-agent') {
      if (!open) groups.push({ agents: [], rules: [] });
      open = true;
      groups[groups.length - 1].agents.push(m[2].toLowerCase());
    } else {
      open = false;
      if ((key === 'allow' || key === 'disallow') && groups.length) groups[groups.length - 1].rules.push({ allow: key === 'allow', pattern: m[2] });
    }
  }
  let applies = groups.filter((g) => g.agents.includes(agent.toLowerCase()));
  // Some crawlers follow another's group when they have none of their own: Applebot follows Googlebot's.
  if (!applies.length && fallback) applies = groups.filter((g) => g.agents.includes(fallback.toLowerCase()));
  if (!applies.length) applies = groups.filter((g) => g.agents.includes('*'));
  const matches = (pattern: string) => {
    const end = pattern.endsWith('$');
    const body = end ? pattern.slice(0, -1) : pattern;
    return new RegExp(`^${body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${end ? '$' : ''}`).test(path);
  };
  let best: { allow: boolean; length: number } | null = null;
  for (const r of applies.flatMap((g) => g.rules))
    if (r.pattern && matches(r.pattern) && (!best || r.pattern.length > best.length || (r.pattern.length === best.length && r.allow))) best = { allow: r.allow, length: r.pattern.length };
  return best ? best.allow : true;
}

const TRAINING = ['Applebot-Extended', 'Bytespider', 'CCBot', 'ClaudeBot', 'Google-Extended', 'GPTBot', 'Meta-ExternalAgent'];

describe('robots.txt for each preset', () => {
  it('stays the robots.txt every website had without a policy, and once the policy is put back', () => {
    const state = rootSite();
    expect(robots(state)).toBe('User-agent: *\nAllow: /\n');
    expect(robots(seoSite().state)).toBe('User-agent: *\nAllow: /\n\nSitemap: https://example.com/studio/sitemap.xml\n');
    expect(layout(state)).not.toContain('noai');
    for (const back of [policy(policy(state, { preset: 'block-ai-training' }), { preset: 'allow-all' }), policy(policy(state, { preset: 'custom', disallowPaths: ['/a/'] }), null)]) {
      expect(Object.hasOwn(back.site, 'crawlerPolicy')).toBe(false);
      expect(robots(back)).toBe(robots(state));
      expect(layout(back)).toBe(layout(state));
    }
  });

  it('keeps the AI training crawlers out by name, and lets search engines and AI search in', () => {
    const s = policy(rootSite(), { preset: 'block-ai-training' });
    expect(s.site.crawlerPolicy).toEqual({ preset: 'block-ai-training' });
    const file = robots(s)!;
    expect(file).toBe(['User-agent: *', 'Allow: /', '', ...TRAINING.map((t) => `User-agent: ${t}`), 'Disallow: /', ''].join('\n'));
    for (const t of TRAINING) expect(mayFetch(file, t, '/about/'), t).toBe(false);
    for (const t of ['Googlebot', 'Bingbot', 'OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot', 'Twitterbot', 'DuckDuckBot']) expect(mayFetch(file, t, '/about/'), t).toBe(true);
    // Its pages ask AI services not to train on them, once, in the shared head.
    expect(layout(s).split(NOAI_META)).toHaveLength(2);
  });

  it('keeps every listed AI crawler out for traditional search engines only, and lets every other crawler in', () => {
    const file = robots(policy(rootSite(), { preset: 'search-engines-only' }))!;
    expect(file).toBe(
      [
        'User-agent: *',
        'Allow: /',
        '',
        ...['Applebot-Extended', 'Bytespider', 'CCBot', 'ChatGPT-User', 'Claude-SearchBot', 'Claude-User', 'ClaudeBot', 'Google-Extended', 'GPTBot', 'Meta-ExternalAgent', 'OAI-SearchBot', 'Perplexity-User', 'PerplexityBot'].map((t) => `User-agent: ${t}`),
        'Disallow: /',
        ''
      ].join('\n')
    );
    for (const t of ['OAI-SearchBot', 'claude-searchbot', 'PERPLEXITYBOT', 'GPTBot']) expect(mayFetch(file, t, '/'), t).toBe(false);
    // Link previews and search engines no list names still read the site.
    for (const t of ['Googlebot', 'Bingbot', 'DuckDuckBot', 'YandexBot', 'Twitterbot', 'LinkedInBot']) expect(mayFetch(file, t, '/about/'), t).toBe(true);
  });

  it('writes the same file for the same policy however it was typed, with each rule once', () => {
    const a = policy(rootSite(), { preset: 'custom', base: 'block-ai-training', overrides: { gptbot: 'allow', ExampleBot: 'disallow' }, disallowPaths: ['/private/', '/downloads/*.zip$', '/private/'] });
    const b = policy(rootSite(), { preset: 'custom', base: 'block-ai-training', overrides: { ExampleBot: 'disallow', GPTBot: 'allow' }, disallowPaths: ['/downloads/*.zip$', '/private/'] });
    // Stored the same way, in the same order, so site.json and robots.txt are the same bytes.
    expect(JSON.stringify(a.site.crawlerPolicy)).toBe(JSON.stringify(b.site.crawlerPolicy));
    expect(JSON.stringify(a.site.crawlerPolicy)).toBe(JSON.stringify({ preset: 'custom', base: 'block-ai-training', overrides: { ExampleBot: 'disallow', GPTBot: 'allow' }, disallowPaths: ['/downloads/*.zip$', '/private/'] }));
    expect(robots(a)).toBe(robots(b));
  });
});

describe('Custom', () => {
  it('lets a crawler its base keeps out in by name, keeps another out, and closes paths to every crawler', () => {
    const s = policy(rootSite(), { preset: 'custom', base: 'block-ai-training', overrides: { GPTBot: 'allow', Googlebot: 'allow', ExampleBot: 'disallow' }, disallowPaths: ['/private/', '/downloads/*.zip$'] });
    const file = robots(s)!;
    const closed = ['Disallow: /downloads/*.zip$', 'Disallow: /private/'];
    expect(file).toBe(['User-agent: *', ...closed, '', 'User-agent: Googlebot', 'User-agent: GPTBot', ...closed, '', ...[...TRAINING.filter((t) => t !== 'GPTBot'), 'ExampleBot'].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).map((t) => `User-agent: ${t}`), 'Disallow: /', ''].join('\n'));
    expect(mayFetch(file, 'GPTBot', '/about/')).toBe(true);
    expect(mayFetch(file, 'GPTBot', '/private/notes')).toBe(false);
    expect(mayFetch(file, 'Googlebot', '/downloads/a.zip')).toBe(false);
    expect(mayFetch(file, 'Googlebot', '/downloads/a.zip?v=2')).toBe(true);
    expect(mayFetch(file, 'ClaudeBot', '/about/')).toBe(false);
    expect(mayFetch(file, 'examplebot', '/about/')).toBe(false);
    expect(mayFetch(file, 'Twitterbot', '/about/')).toBe(true);
  });

  it('gives a crawler let in by name a group of its own, so it never falls back on a blocked crawler’s', () => {
    const file = robots(policy(rootSite(), { preset: 'custom', overrides: { Googlebot: 'disallow', Applebot: 'allow', 'Googlebot-Image': 'allow' }, disallowPaths: ['/private/'] }))!;
    expect(file).toContain('User-agent: Applebot\nUser-agent: Googlebot-Image\nDisallow: /private/\n');
    expect(mayFetch(file, 'Applebot', '/about/', 'Googlebot')).toBe(true);
    expect(mayFetch(file, 'Applebot', '/private/a', 'Googlebot')).toBe(false);
    expect(mayFetch(file, 'Googlebot-Image', '/about/', 'Googlebot')).toBe(true);
    expect(mayFetch(file, 'Googlebot', '/about/')).toBe(false);
    // Without paths, the group lets it in everywhere.
    expect(robots(policy(rootSite(), { preset: 'custom', base: 'block-ai-training', overrides: { GPTBot: 'allow', 'Googlebot-Image': 'allow' } }))).toContain('\nUser-agent: Googlebot-Image\nUser-agent: GPTBot\nAllow: /\n');
  });

  it('lets a crawler named under a sub-path into that site alone, once merged into its domain’s robots.txt', () => {
    const host = 'User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /members/\n\n';
    const site = robots(policy(seoSite().state, { preset: 'custom', overrides: { Googlebot: 'allow' } }))!;
    expect(site).toContain('\nUser-agent: Googlebot\nAllow: /studio$\nAllow: /studio/\nAllow: /studio?\n');
    const merged = host + site;
    for (const p of ['/studio', '/studio?q=1', '/studio/', '/studio/about/']) expect(mayFetch(merged, 'Googlebot', p), p).toBe(true);
    expect(mayFetch(merged, 'Googlebot', '/members/')).toBe(false);
    expect(mayFetch(merged, 'Googlebot', '/studio-next/')).toBe(false);
    // Its paths still close, and a path closing the whole site keeps it out.
    const closed = robots(policy(seoSite().state, { preset: 'custom', overrides: { Googlebot: 'allow' }, disallowPaths: ['/private/', '/$'] }))!;
    expect(closed).toContain('\nUser-agent: Googlebot\nAllow: /studio/\nAllow: /studio?\nDisallow: /studio$\nDisallow: /studio/$\nDisallow: /studio/private/\n');
    expect(mayFetch(host + closed, 'Googlebot', '/studio/private/a')).toBe(false);
    for (const p of ['/studio', '/studio/']) expect(mayFetch(host + closed, 'Googlebot', p), p).toBe(false);
    for (const p of ['/studio?q=1', '/studio/about/']) expect(mayFetch(host + closed, 'Googlebot', p), p).toBe(true);
    const query = robots(policy(seoSite().state, { preset: 'custom', overrides: { Googlebot: 'allow' }, disallowPaths: ['/?'] }))!;
    expect(mayFetch(host + query, 'Googlebot', '/studio?q=1')).toBe(false);
    expect(mayFetch(host + query, 'Googlebot', '/studio')).toBe(true);
    const all = robots(policy(seoSite().state, { preset: 'custom', overrides: { Googlebot: 'allow' }, disallowPaths: ['/'] }))!;
    expect(all).toContain('\nUser-agent: Googlebot\nDisallow: /studio$\nDisallow: /studio/\nDisallow: /studio?\n');
  });

  it('starts from the preset it was chosen from, and drops its rules when another preset is chosen', () => {
    const custom = policy(policy(rootSite(), { preset: 'block-ai-training' }), { preset: 'custom' });
    expect(custom.site.crawlerPolicy).toEqual({ preset: 'custom', base: 'block-ai-training' });
    expect(robots(custom)).toBe(robots(policy(rootSite(), { preset: 'block-ai-training' })));
    // An empty Custom from the default stays chosen, and writes the default file.
    const empty = policy(rootSite(), { preset: 'custom' });
    expect(empty.site.crawlerPolicy).toEqual({ preset: 'custom' });
    expect(robots(empty)).toBe('User-agent: *\nAllow: /\n');
    const ruled = policy(custom, { overrides: { GPTBot: 'allow' }, disallowPaths: ['/a/'] });
    const fixed = policy(ruled, { preset: 'search-engines-only' });
    expect(fixed.site.crawlerPolicy).toEqual({ preset: 'search-engines-only' });
    expect(policy(fixed, { preset: 'custom' }).site.crawlerPolicy).toEqual({ preset: 'custom', base: 'search-engines-only' });
  });

  it('changes only the parts given: a crawler at a time, the paths whole', () => {
    let s = policy(rootSite(), { preset: 'custom', overrides: { GPTBot: 'disallow', ExampleBot: 'disallow' }, disallowPaths: ['/a/'] });
    s = policy(s, { overrides: { ClaudeBot: 'disallow', ExampleBot: null } });
    expect(s.site.crawlerPolicy).toEqual({ preset: 'custom', overrides: { ClaudeBot: 'disallow', GPTBot: 'disallow' }, disallowPaths: ['/a/'] });
    s = policy(s, { disallowPaths: [] });
    expect(s.site.crawlerPolicy).toEqual({ preset: 'custom', overrides: { ClaudeBot: 'disallow', GPTBot: 'disallow' } });
    // A crawler named in another case is the same crawler, kept in the list's spelling.
    s = policy(s, { overrides: { gptbot: 'allow' } });
    expect(s.site.crawlerPolicy?.overrides).toEqual({ ClaudeBot: 'disallow', GPTBot: 'allow' });
    // A listed crawler's explicit choice outlasts a change of base, where Default follows it.
    const moved = policy(s, { base: 'block-ai-training' });
    expect(crawlerRules(moved.site).overrides.get('gptbot')?.action).toBe('allow');
    expect(robots(moved)).toContain('User-agent: GPTBot\nAllow: /');
    expect(robots(moved)).toMatch(/User-agent: CCBot\n(User-agent: .*\n)*Disallow: \//);
  });

  it('replaces the crawlers “Also block” lists with each save, leaving listed crawlers’ rows and allows alone', () => {
    let s = policy(rootSite(), { preset: 'custom', overrides: { GPTBot: 'allow', 'Googlebot-Image': 'allow', OldBot: 'disallow' } });
    s = policy(s, { alsoBlock: ['NewBot'] });
    s = policy(s, { alsoBlock: ['FinalBot'], overrides: { ClaudeBot: 'disallow' } });
    expect(JSON.stringify(s.site.crawlerPolicy?.overrides)).toBe(JSON.stringify({ ClaudeBot: 'disallow', FinalBot: 'disallow', 'Googlebot-Image': 'allow', GPTBot: 'allow' }));
    expect(policy(s, { alsoBlock: [] }).site.crawlerPolicy?.overrides).toEqual({ ClaudeBot: 'disallow', 'Googlebot-Image': 'allow', GPTBot: 'allow' });
    // The crawlers named after it in the same change have the last word.
    expect(policy(s, { alsoBlock: ['LateBot'], overrides: { LateBot: 'allow' } }).site.crawlerPolicy?.overrides).toMatchObject({ LateBot: 'allow' });
    // A listed crawler has its own row.
    expect(refusal(s, { alsoBlock: ['claudebot'] })).toMatch(/ClaudeBot is listed with the crawlers above/);
    expect(refusal(policy(rootSite(), { preset: 'block-ai-training' }), { alsoBlock: ['X'] })).toMatch(/Only a Custom crawler policy/);
  });

  it('keeps a crawler let in by name out of a path closed to every crawler, and closing "/" closes the whole site', () => {
    const s = policy(rootSite(), { preset: 'custom', base: 'block-ai-training', overrides: { GPTBot: 'allow' }, disallowPaths: ['/'] });
    const file = robots(s)!;
    for (const t of ['GPTBot', 'Googlebot', 'ClaudeBot', 'Twitterbot']) expect(mayFetch(file, t, '/about/'), t).toBe(false);
    // "/$" is the home page alone.
    const home = robots(policy(s, { disallowPaths: ['/$'] }))!;
    expect(mayFetch(home, 'Googlebot', '/')).toBe(false);
    expect(mayFetch(home, 'Googlebot', '/about/')).toBe(true);
  });

  it('starts every pattern with the sub-path the site is published under, and never reaches its domain’s other sites', () => {
    const s = policy(seoSite().state, { preset: 'custom', base: 'block-ai-training', overrides: { GPTBot: 'allow' }, disallowPaths: ['/private/'] });
    const file = robots(s)!;
    expect(file).toBe(
      [
        'User-agent: *',
        'Disallow: /studio/private/',
        '',
        'User-agent: GPTBot',
        'Allow: /studio$',
        'Allow: /studio/',
        'Allow: /studio?',
        'Disallow: /studio/private/',
        '',
        ...TRAINING.filter((t) => t !== 'GPTBot').map((t) => `User-agent: ${t}`),
        'Disallow: /studio$',
        'Disallow: /studio/',
        'Disallow: /studio?',
        '',
        'Sitemap: https://example.com/studio/sitemap.xml',
        ''
      ].join('\n')
    );
    expect(mayFetch(file, 'GPTBot', '/studio/about/')).toBe(true);
    expect(mayFetch(file, 'GPTBot', '/studio/private/a')).toBe(false);
    for (const p of ['/studio', '/studio/', '/studio/about/', '/studio?q=1']) expect(mayFetch(file, 'ClaudeBot', p), p).toBe(false);
    expect(mayFetch(file, 'ClaudeBot', '/studio-next/')).toBe(true);
    expect(mayFetch(file, 'ClaudeBot', '/')).toBe(true);
    // A path closing the whole site closes the sub-path alone.
    for (const universal of ['/', '/*', '/*$']) {
      const all = robots(policy(s, { disallowPaths: [universal] }))!;
      expect(all, universal).toContain('User-agent: *\nDisallow: /studio$\nDisallow: /studio/\nDisallow: /studio?\n');
      expect(mayFetch(all, 'Googlebot', '/studio/about/'), universal).toBe(false);
      expect(mayFetch(all, 'Googlebot', '/studio-next/'), universal).toBe(true);
    }
    // The home page alone, and a query on it, at both of its addresses.
    const home = robots(policy(s, { disallowPaths: ['/$', '/?q='] }))!;
    expect(home).toContain('User-agent: *\nDisallow: /studio$\nDisallow: /studio/$\nDisallow: /studio?q=\nDisallow: /studio/?q=\n');
    expect(robots(policy(s, { disallowPaths: ['/?q=x$'] }))).toContain('User-agent: *\nDisallow: /studio?q=x$\nDisallow: /studio/?q=x$\n');
    for (const p of ['/studio', '/studio/', '/studio?q=pots', '/studio/?q=pots']) expect(mayFetch(home, 'Googlebot', p), p).toBe(false);
    for (const p of ['/studio/about/', '/studio-next/', '/studio?page=2']) expect(mayFetch(home, 'Googlebot', p), p).toBe(true);
    // Escaped characters stay escapes, never wildcards, ends or new lines.
    expect(robots(policy(s, { disallowPaths: ['/a%2A', '/b%24', '/c%0A'] }))).toContain('Disallow: /studio/a%2A\nDisallow: /studio/b%24\nDisallow: /studio/c%0A\n');
    // Reset, the sub-path site has the robots.txt it always had.
    expect(robots(policy(s, null))).toBe('User-agent: *\nAllow: /\n\nSitemap: https://example.com/studio/sitemap.xml\n');
  });
});

describe('checking what is typed', () => {
  it('takes product tokens alone, in a listed crawler’s own spelling', () => {
    expect(checkCrawlerToken(' gptbot ')).toEqual({ ok: true, value: 'GPTBot' });
    expect(checkCrawlerToken('Example_Bot')).toEqual({ ok: true, value: 'Example_Bot' });
    expect(checkCrawlerToken('x'.repeat(128)).ok).toBe(true);
    for (const bad of ['', '*', 'GPTBot/1.2', 'Bot 2', 'User-agent: GPTBot', 'Bot9', 'x'.repeat(129), 'Bot\nDisallow: /', '__proto__', 'constructor', 'Prototype']) expect(checkCrawlerToken(bad).ok, JSON.stringify(bad)).toBe(false);
    expect(checkCrawlerTokenLines('ExampleBot\n\nexamplebot\nAnotherBot')).toEqual({ ok: true, value: ['AnotherBot', 'ExampleBot'] });
  });

  it('takes paths from the site’s root in robots.txt’s syntax, written one way', () => {
    expect(checkCrawlerPath('/private/')).toEqual({ ok: true, value: '/private/' });
    expect(checkCrawlerPath('/*.pdf$')).toEqual({ ok: true, value: '/*.pdf$' });
    expect(checkCrawlerPath('/a%2fb%41%7e')).toEqual({ ok: true, value: '/a%2FbA~' });
    expect(checkCrawlerPath('/café/')).toEqual({ ok: true, value: '/caf%C3%A9/' });
    expect(checkCrawlerPath('/search?q=*')).toEqual({ ok: true, value: '/search?q=*' });
    // A space of another alphabet is part of the path, never trimmed away to widen it.
    expect(checkCrawlerPath(' /offers\u00a0 ')).toEqual({ ok: true, value: '/offers%C2%A0' });
    expect(checkCrawlerPath('\u00a0/offers').ok).toBe(false);
    for (const bad of ['private/', '//evil.example/', '/a b', '/a#b', '/a$b', '/a%zz', '/a/../b', '/a/%2E%2E/b', '/a\\b', '/a"b', '/' + 'a'.repeat(512), '/\ud800'])
      expect(checkCrawlerPath(bad).ok, JSON.stringify(bad)).toBe(false);
    expect(checkCrawlerPathLines('/b/\n\n/a/\n/b/')).toEqual({ ok: true, value: ['/a/', '/b/'] });
    expect(checkCrawlerPathLines('/a/\nb')).toMatchObject({ ok: false, message: expect.stringContaining('start it with “/”') });
  });

  it('refuses rules the website could not write before anything is saved', () => {
    expect(invalid({ preset: 'everyone' })).toMatch(/preset/);
    expect(invalid({ preset: 'custom', extra: true })).toMatch(/extra|Unrecognized/i);
    expect(invalid({ preset: 'custom', overrides: { 'GPTBot/1.2': 'disallow' } })).toMatch(/overrides\.GPTBot\/1\.2: .*not a crawler’s name/);
    expect(invalid({ preset: 'custom', overrides: { GPTBot: 'maybe' } })).toMatch(/overrides\.GPTBot/);
    expect(invalid({ preset: 'custom', disallowPaths: ['/ok/', 'nope'] })).toMatch(/disallowPaths\.1: .*start it with/);
    expect(invalid({ preset: 'custom', disallowPaths: ['/a/\nDisallow: /'] })).toMatch(/disallowPaths\.0/);
    expect(invalid({ preset: 'custom', base: 'custom' })).toMatch(/base/);
    expect(invalid({ preset: 'custom', alsoBlock: ['Good', 'Bad Bot'] })).toMatch(/alsoBlock\.1: /);
    expect(invalid({ preset: 'custom', alsoBlock: Array.from({ length: 65 }, (_, i) => `Bot${'x'.repeat(i)}`) })).toMatch(/alsoBlock/);
    expect(invalid({ preset: 'custom', overrides: { GPTBot: 'allow' }, disallowPaths: ['/a/'], base: 'search-engines-only', noAiMeta: null })).toBeNull();
    const state = rootSite();
    expect(refusal(state, { preset: 'block-ai-training', disallowPaths: ['/a/'] })).toMatch(/Only a Custom crawler policy/);
    expect(refusal(policy(state, { preset: 'block-ai-training' }), { overrides: { GPTBot: 'allow' } })).toMatch(/Only a Custom crawler policy/);
    expect(refusal(state, { preset: 'custom', overrides: { GPTBot: 'allow', gptbot: 'disallow' } })).toMatch(/named twice/);
    expect(refusal(state, { preset: 'custom', overrides: { GPTBot: 'disallow', gptbot: 'disallow' } })).toMatch(/named twice/);
    expect(refusal(policy(state, { preset: 'custom', overrides: { GPTBot: 'allow' } }), { alsoBlock: Array.from({ length: 64 }, (_, i) => `Bot${'x'.repeat(i)}`) })).toMatch(/at most 64/);
    expect(refusal(state, { preset: 'custom', overrides: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`Bot${'x'.repeat(i)}`, 'disallow'])) })).toMatch(/at most 64/);
    // A refused change leaves the batch, and the site, as they were.
    const before = structuredClone(state.site);
    expect(() => applyOperations(state, [{ type: 'site.update', name: 'Renamed' }, { type: 'site.update', crawlerPolicy: { preset: 'custom', disallowPaths: ['nope'] } } as EditOperation])).toThrow(/start it with/);
    expect(state.site).toEqual(before);
  });

  it('reads a hand-edited policy without crashing, keeping what it can use', () => {
    const state = rootSite();
    const damaged = (crawlerPolicy: unknown) => ({ ...state, site: { ...state.site, crawlerPolicy } }) as ProjectState;
    expect(robots(damaged('block'))).toBe('User-agent: *\nAllow: /\n');
    expect(robots(damaged({ preset: 'nobody' }))).toBe('User-agent: *\nAllow: /\n');
    const rules = crawlerRules({ crawlerPolicy: { preset: 'custom', base: 'nonsense', overrides: { gptbot: 'allow', GPTBot: 'disallow', ClaudeBot: 'disallow', 'Bad Bot': 'disallow', CCBot: 7 }, disallowPaths: ['/a/', 'b', 3, '/a/'], noAiMeta: 'yes' } as never });
    expect(rules.base).toBe('allow-all');
    // GPTBot is named both ways, so it is kept out; the rest that can be used stands.
    expect([...rules.overrides.values()]).toEqual([
      { token: 'ClaudeBot', action: 'disallow' },
      { token: 'GPTBot', action: 'disallow' }
    ]);
    // Whichever spelling comes first.
    expect(crawlerRules({ crawlerPolicy: { preset: 'custom', overrides: { GPTBot: 'disallow', gptbot: 'allow' } } as never }).overrides.get('gptbot')?.action).toBe('disallow');
    expect(rules.paths).toEqual(['/a/']);
    expect(rules.noAiMeta).toBe(false);
    // An unreadable preset with Custom's rules beside it keeps them, and its training base.
    const unnamed = robots(damaged({ preset: 7, base: 'block-ai-training', disallowPaths: ['/private/', 'nope'] }))!;
    expect(unnamed).toContain('User-agent: *\nDisallow: /private/\n');
    for (const t of TRAINING) expect(mayFetch(unnamed, t, '/about/'), t).toBe(false);
    // A hand edit past the limits is read whole, up to far more than an edit may save, keeping out first.
    const many = (n: number) => Array.from({ length: n }, (_, i) => `Bot${'x'.repeat(i % 100)}${'y'.repeat(Math.floor(i / 100))}`);
    expect(crawlerRules({ crawlerPolicy: { preset: 'custom', disallowPaths: ['/private/', ...Array.from({ length: 64 }, (_, i) => `/a${i}/`)] } as never }).paths).toContain('/private/');
    // A pattern closing the whole site is never the one left out.
    const wide = crawlerRules({ crawlerPolicy: { preset: 'custom', disallowPaths: [...Array.from({ length: 256 }, (_, i) => `/!${i}/`), '/*'] } as never });
    expect(wide.paths).toHaveLength(256);
    expect(wide.paths).toContain('/*');
    expect(runSeoAudit(damaged({ preset: 'custom', disallowPaths: [...Array.from({ length: 256 }, (_, i) => `/!${i}/`), '/*'] })).map((f) => f.code)).toContain('SEO_SEARCH_CRAWLERS_BLOCKED');
    const flooded = crawlerRules({ crawlerPolicy: { preset: 'custom', disallowPaths: Array.from({ length: 1100 }, (_, i) => `/p${i}/`), overrides: { ...Object.fromEntries(many(200).map((t) => [t, 'allow'])), ZedBot: 'disallow', ZooBot: 'disallow' } } as never });
    expect(flooded.paths).toHaveLength(256);
    expect(flooded.overrides.size).toBe(202);
    const capped = crawlerRules({ crawlerPolicy: { preset: 'custom', overrides: { ...Object.fromEntries(many(300).map((t) => [t, 'allow'])), ZedBot: 'disallow' } } as never });
    expect(capped.overrides.size).toBe(256);
    expect(capped.overrides.get('zedbot')?.action).toBe('disallow');
    expect(() => generateProject(damaged({ preset: 'custom', overrides: [1, 2], disallowPaths: 'all' }))).not.toThrow();
    expect(runSeoAudit(damaged({ preset: 'custom', overrides: null, disallowPaths: [null] })).filter((f) => f.site === 'crawlerPolicy')).toEqual([]);
    // One damaged path never opens the site to the crawlers the rest keeps out.
    const mixed = robots(damaged({ preset: 'custom', base: 'block-ai-training', disallowPaths: ['/private/', 'x y'] }))!;
    expect(mixed).toContain('Disallow: /private/');
    for (const t of TRAINING) expect(mayFetch(mixed, t, '/about/'), t).toBe(false);
    // The AI is told the policy as the website follows it, never the damaged entries.
    expect(projectSummary(damaged({ preset: 'custom', base: 'nonsense', overrides: { 'Bad Bot': 'disallow', ExampleBot: 'disallow' }, disallowPaths: [1] }), 1).site).toMatchObject({ crawlerPolicy: { preset: 'custom', overrides: { ExampleBot: 'disallow' } } });
  });
});

describe('the noai meta', () => {
  it('follows the preset until the author says otherwise, and the author’s choice stays through presets', () => {
    const state = rootSite();
    expect(layout(policy(state, { preset: 'search-engines-only' }))).toContain(NOAI_META);
    const off = policy(state, { preset: 'block-ai-training', noAiMeta: false });
    expect(off.site.crawlerPolicy).toEqual({ preset: 'block-ai-training', noAiMeta: false });
    expect(layout(off)).not.toContain('noai');
    expect(policy(off, { preset: 'search-engines-only' }).site.crawlerPolicy).toEqual({ preset: 'search-engines-only', noAiMeta: false });
    // Put back to the default, it follows the preset again.
    expect(layout(policy(off, { noAiMeta: null }))).toContain(NOAI_META);
    // An explicit choice outlasts a preset whose default agrees with it.
    const kept = policy(policy(policy(state, { noAiMeta: true }), { preset: 'block-ai-training' }), { preset: 'allow-all' });
    expect(kept.site.crawlerPolicy).toEqual({ preset: 'allow-all', noAiMeta: true });
    expect(layout(kept)).toContain(NOAI_META);
    // On while every crawler is let in, robots.txt is unchanged and only the pages ask.
    const on = policy(state, { noAiMeta: true });
    expect(on.site.crawlerPolicy).toEqual({ preset: 'allow-all', noAiMeta: true });
    expect(robots(on)).toBe('User-agent: *\nAllow: /\n');
    expect(layout(on)).toContain(`<meta property="og:site_name" content={"Riverside Studio"} />\n\t${NOAI_META}\n</svelte:head>`);
    expect(Object.hasOwn(policy(on, { noAiMeta: null }).site, 'crawlerPolicy')).toBe(false);
    // Custom follows its base, until the author says otherwise.
    expect(crawlerRules(policy(state, { preset: 'custom', base: 'block-ai-training' }).site).noAiMeta).toBe(true);
    expect(crawlerRules(policy(state, { preset: 'custom' }).site).noAiMeta).toBe(false);
    const customOff = policy(state, { preset: 'custom', base: 'block-ai-training', noAiMeta: false });
    expect(layout(customOff)).not.toContain('noai');
    expect(layout(policy(customOff, { base: 'search-engines-only' }))).not.toContain('noai');
    // An explicit choice that agrees with a blocking preset is kept too.
    expect(policy(state, { preset: 'block-ai-training', noAiMeta: true }).site.crawlerPolicy).toEqual({ preset: 'block-ai-training', noAiMeta: true });
  });
});

describe('the audit', () => {
  const blocked = (s: ProjectState) => runSeoAudit(s).filter((f) => f.site === 'crawlerPolicy');

  it('says nothing of the presets, or of a path that leaves pages open', () => {
    const state = seoSite().state;
    expect(blocked(state)).toEqual([]);
    for (const preset of ['block-ai-training', 'search-engines-only']) expect(blocked(policy(state, { preset })), preset).toEqual([]);
    expect(blocked(policy(state, { preset: 'custom', base: 'search-engines-only', disallowPaths: ['/private/', '/$'] }))).toEqual([]);
    // A crawler the preset already keeps out, kept out again by name, is the author's choice too.
    expect(blocked(policy(state, { preset: 'custom', base: 'search-engines-only', overrides: { 'OAI-SearchBot': 'disallow' } }))).toEqual([]);
  });

  it('warns when Custom keeps a search engine out of the whole site by name', () => {
    const [f, ...rest] = blocked(policy(seoSite().state, { preset: 'custom', overrides: { Googlebot: 'disallow', Bingbot: 'disallow' } }));
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ code: 'SEO_SEARCH_CRAWLERS_BLOCKED', pillar: 'technical', severity: 'warning', aiFixable: true, destination: { kind: 'site', field: 'crawlerPolicy' } });
    expect(f.message).toBe('robots.txt keeps search engines out of the whole website (Googlebot, Bingbot): Custom keeps them out by name.');
    expect(destinationLabel(f.destination!)).toBe('Go to Crawlers');
  });

  it('warns when Custom keeps an AI search engine out by name, but not an assistant’s fetcher', () => {
    const [f, ...rest] = blocked(policy(seoSite().state, { preset: 'custom', overrides: { PerplexityBot: 'disallow', 'ChatGPT-User': 'disallow' } }));
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ code: 'SEO_AI_SEARCH_CRAWLERS_BLOCKED', pillar: 'agentic', severity: 'warning', aiFixable: true, destination: { kind: 'site', field: 'crawlerPolicy' } });
    expect(f.message).toBe('robots.txt keeps AI search engines out of the whole website (PerplexityBot): Custom keeps them out by name.');
    expect(blocked(policy(seoSite().state, { preset: 'custom', overrides: { 'ChatGPT-User': 'disallow', 'Claude-User': 'disallow', 'Perplexity-User': 'disallow' } }))).toEqual([]);
  });

  it('warns about search engines and AI search engines alike when a path closes the whole site, even to one let in by name', () => {
    const s = policy(seoSite().state, { preset: 'custom', base: 'search-engines-only', overrides: { 'OAI-SearchBot': 'allow' }, disallowPaths: ['/*'] });
    const found = blocked(s);
    expect(found.map((f) => [f.code, f.pillar])).toEqual([
      ['SEO_SEARCH_CRAWLERS_BLOCKED', 'technical'],
      ['SEO_AI_SEARCH_CRAWLERS_BLOCKED', 'agentic']
    ]);
    expect(found[0].message).toContain('(Googlebot, Bingbot, DuckDuckBot, Applebot): a path closes every page to all crawlers.');
    // The AI search engines the preset keeps out are not reported; the one let in by name is.
    expect(found[1].message).toContain('(OAI-SearchBot)');
    expect(blocked(policy(s, { disallowPaths: ['/$'] }))).toEqual([]);
  });
});

describe('the editor and the AI', () => {
  it('tells the AI the policy once it differs from the default', () => {
    const state = rootSite();
    expect(projectSummary(state, 1).site).not.toHaveProperty('crawlerPolicy');
    const s = policy(state, { preset: 'custom', base: 'block-ai-training', disallowPaths: ['/a/'] });
    expect(projectSummary(s, 1).site).toMatchObject({ crawlerPolicy: { preset: 'custom', base: 'block-ai-training', disallowPaths: ['/a/'] } });
  });

  it('holds paths and crawlers typed during an AI turn as separate fields, so neither replaces the other', () => {
    const s = policy(rootSite(), { preset: 'custom', disallowPaths: ['/a/'] });
    const paths: EditOperation = { type: 'site.update', crawlerPolicy: { disallowPaths: ['/private/'] } };
    const tokens: EditOperation = { type: 'site.update', crawlerPolicy: { overrides: { ExampleBot: 'disallow' } } };
    expect(fieldKey([paths])).not.toBe(fieldKey([tokens]));
    const also: EditOperation = { type: 'site.update', crawlerPolicy: { alsoBlock: ['ExampleBot'] } };
    expect(fieldKey([also])).not.toBe(fieldKey([paths]));
    expect(fieldKey([also])).not.toBe(fieldKey([tokens]));
    expect(fieldKey([also])).toBe(fieldKey([{ type: 'site.update', crawlerPolicy: { alsoBlock: ['OtherBot', 'ThirdBot'] } }]));
    expect(fieldKey([paths])).toBe(fieldKey([{ type: 'site.update', crawlerPolicy: { disallowPaths: ['/b/'] } }]));
    expect(readField(s, paths)).toEqual({ found: true, value: { crawlerPolicy: { preset: 'custom', disallowPaths: ['/a/'] } } });
    expect(typedText(paths)).toBe('/private/');
    expect(typedText(also)).toBe('ExampleBot');
    const read = readField(s, paths)!;
    expect(read.found && shownField(paths, read.value)).toBe('/a/');
    // A held path list still applies once the crawlers are changed; not once the preset leaves Custom.
    const base = readFields(s, [paths])!.map((r) => (r.found ? r.value : undefined));
    expect(checkHeld(policy(s, { overrides: { ExampleBot: 'disallow' } }), [paths], base).kind).toBe('apply');
    expect(checkHeld(policy(s, { preset: 'block-ai-training' }), [paths], base).kind).toBe('changed');
    expect(checkHeld(policy(s, { disallowPaths: ['/c/'] }), [paths], base).kind).toBe('changed');
    // “Also block” reads only the crawlers it lists: a listed crawler's row or the paths changed meanwhile is no conflict.
    const blocking = policy(s, { alsoBlock: ['OldBot'] });
    const alsoBase = readFields(blocking, [also])!.map((r) => (r.found ? r.value : undefined));
    expect(alsoBase).toEqual([{ crawlerPolicy: { preset: 'custom', alsoBlock: { OldBot: 'disallow' } } }]);
    const alsoRead = readField(blocking, also)!;
    expect(alsoRead.found && shownField(also, alsoRead.value)).toBe('OldBot');
    expect(checkHeld(policy(blocking, { overrides: { GPTBot: 'disallow' }, disallowPaths: ['/z/'] }), [also], alsoBase).kind).toBe('apply');
    expect(checkHeld(policy(blocking, { alsoBlock: ['NewBot'] }), [also], alsoBase).kind).toBe('changed');
    // A crawler no list names let in meanwhile would be kept out by the held list: a conflict, never overwritten.
    expect(checkHeld(policy(blocking, { overrides: { ExampleBot: 'allow' } }), [also], alsoBase).kind).toBe('changed');
  });

  it('previews exactly the file the website writes, and a change before it is saved', () => {
    const s = policy(seoSite().state, { preset: 'custom', base: 'search-engines-only', disallowPaths: ['/x/'] });
    expect(siteRobotsTxt(s.site)).toBe(robots(s));
    expect(robotsTxt(crawlerRules(s.site), { mount: '/studio', sitemap: 'https://example.com/studio/sitemap.xml' })).toBe(robots(s));
    const change = { disallowPaths: ['/y/'], alsoBlock: ['ExampleBot'], overrides: { GPTBot: 'allow' as const } };
    const preview = siteRobotsTxt(s.site, patchedCrawlerRules(s.site, change)!);
    expect(preview).toMatch(/^User-agent: \*\nDisallow: \/studio\/y\/\n\nUser-agent: GPTBot\nAllow: \/studio\$\nAllow: \/studio\/\nAllow: \/studio\?\nDisallow: \/studio\/y\/\n\n/);
    expect(preview).toContain('User-agent: ExampleBot\n');
    expect(preview).toBe(robots(policy(s, change)));
    expect(patchedCrawlerRules(s.site, { disallowPaths: ['nope'] })).toBeNull();
  });

  it('gives a cached run the same robots.txt and layout as a fresh one as the policy changes', () => {
    const cache = new GenerationCache();
    let s = seoSite().state;
    // Warmed on the site as it was, before it had any policy.
    generateProject(s, {}, cache);
    const steps: Array<Record<string, unknown> | null> = [{ preset: 'block-ai-training' }, { preset: 'custom' }, { overrides: { GPTBot: 'allow' }, disallowPaths: ['/a/'] }, { noAiMeta: false }, { preset: 'search-engines-only' }, null];
    for (const step of steps) {
      s = policy(s, step);
      const cached = generateProject(s, {}, cache);
      const fresh = generateProject(s);
      expect(cached.get('static/robots.txt')).toBe(fresh.get('static/robots.txt'));
      expect(cached.get('src/routes/+layout.svelte')).toBe(fresh.get('src/routes/+layout.svelte'));
      expect(cached.get('static/robots.txt')).toBe(siteRobotsTxt(s.site));
      expect(cached.get('src/routes/+layout.svelte')!.includes(NOAI_META)).toBe(crawlerRules(s.site).noAiMeta);
    }
  });

  it('keeps only what differs from the default', () => {
    expect(storedCrawlerPolicy(crawlerRules({}))).toBeUndefined();
    expect(patchCrawlerPolicy(undefined, { preset: 'allow-all', noAiMeta: null })).toEqual({ ok: true, value: undefined });
    // An explicit choice is kept even where it agrees with the default.
    expect(patchCrawlerPolicy(undefined, { preset: 'allow-all', noAiMeta: false })).toEqual({ ok: true, value: { preset: 'allow-all', noAiMeta: false } });
    expect(patchCrawlerPolicy({ preset: 'custom', base: 'allow-all', overrides: {}, disallowPaths: [] }, {})).toEqual({ ok: true, value: { preset: 'custom' } });
  });
});
