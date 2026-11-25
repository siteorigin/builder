import { useCallback, useId, useState } from 'react';
import type { ProjectState } from '@shared/types';
import {
  checkCrawlerPathLines,
  checkCrawlerTokenLines,
  crawlerRules,
  CRAWLER_PRESET_LABELS,
  CRAWLER_PRESETS,
  FIXED_CRAWLER_PRESETS,
  foldToken,
  KNOWN_CRAWLERS,
  knownCrawler,
  NOAI_META,
  patchedCrawlerRules,
  presetAction,
  presetNoAiMeta,
  siteMount,
  siteRobotsTxt,
  type CrawlerAction,
  type CrawlerKind,
  type CrawlerPolicyPatch,
  type CrawlerPreset,
  type CrawlerRules,
  type FixedCrawlerPreset
} from '@shared/crawler-policy';
import { publicUrl } from '@shared/public-url';
import { DraftInput, Field, SwitchRow, openSection, type DraftProblem } from '../components/ui';
import { openSiteStyles } from '../lib/actions';

const PRESET_HINTS: Record<CrawlerPreset, string> = {
  'allow-all': 'Every crawler may read every page: search engines, AI search engines and AI training crawlers alike.',
  'block-ai-training': 'Search engines and AI search engines may read and cite the site. The AI training crawlers listed below are asked to stay away.',
  'search-engines-only': 'Asks the listed AI crawlers and assistants to stay off this site, for search and training alike. Search engines and other crawlers can still visit.',
  custom: 'Start from a preset, then let crawlers in or keep them out by name, and close paths to every crawler.'
};

const KIND_LABELS: Record<CrawlerKind, string> = { search: 'Search engines', 'ai-search': 'AI search and assistants', 'ai-training': 'AI training' };
const ACTION_LABELS: Record<CrawlerAction, string> = { allow: 'Allowed', disallow: 'Blocked' };

const isPreset = (v: string): v is CrawlerPreset => (CRAWLER_PRESETS as readonly string[]).includes(v);
const isFixed = (v: string): v is FixedCrawlerPreset => (FIXED_CRAWLER_PRESETS as readonly string[]).includes(v);

/** Shows the section, which may be closed, before leaving the project's Keep editing returns to a field in it. */
const revealCrawlers = () => {
  openSiteStyles();
  openSection('site-crawlers', { scroll: false });
};

/** The crawlers Custom keeps out that no list above names, one per line, as the field shows them. */
const extraTokens = (rules: CrawlerRules) =>
  [...rules.overrides.values()]
    .filter((o) => o.action === 'disallow' && !knownCrawler(o.token))
    .map((o) => o.token)
    .join('\n');

/** A field of lines checked as they are typed: text it can't take stays in it with the reason, unsaved. */
function CheckedLines({ id, label, hint, value, placeholder, check, onLive, onCommit }: { id: string; label: string; hint: string; value: string; placeholder: string; check: (v: string) => { ok: true } | { ok: false; message: string }; onLive: (v: string | null) => void; onCommit: (v: string) => unknown }) {
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const settled = useCallback((dirty: boolean) => void (dirty || onLive(null)), [onLive]);
  const error = problem && (
    <span role="alert">
      {problem.message} <span className="field-saved">Not saved.</span>
    </span>
  );
  return (
    <Field label={label} hint={hint} error={error}>
      <DraftInput
        id={id}
        multiline
        rows={3}
        value={value}
        placeholder={placeholder}
        check={(v) => {
          const c = check(v);
          return c.ok ? null : { message: c.message };
        }}
        onProblem={setProblem}
        onLive={onLive}
        onDirty={settled}
        reveal={revealCrawlers}
        onCommit={onCommit}
      />
    </Field>
  );
}

/**
 * Site styles' Crawlers section: which crawlers the website's robots.txt keeps out (see shared/crawler-policy.ts),
 * whether its pages ask AI services not to train on them, and the robots.txt it writes, shown as it will be while
 * Custom's lines are typed. Each control saves on its own, changing only its part of the policy.
 */
export function CrawlerPolicyFields({ state, onChange }: { state: ProjectState; onChange: (patch: Record<string, unknown>) => unknown }) {
  const uid = useId();
  const site = state.site;
  const rules = crawlerRules(site);
  const custom = rules.preset === 'custom';
  const save = (patch: CrawlerPolicyPatch) => onChange({ crawlerPolicy: patch });
  // Custom's lines as they are typed, until they are saved or put back.
  const [typedPaths, setTypedPaths] = useState<string | null>(null);
  const [typedTokens, setTypedTokens] = useState<string | null>(null);
  const tokensPatch = (text: string): CrawlerPolicyPatch | null => {
    const c = checkCrawlerTokenLines(text);
    if (!c.ok) return null;
    const keep = new Set(c.value.map(foldToken));
    const overrides: Record<string, CrawlerAction | null> = {};
    // Those taken off the list go; those on it are kept out (a listed crawler typed here is set as its row would be).
    for (const o of rules.overrides.values()) if (o.action === 'disallow' && !knownCrawler(o.token) && !keep.has(foldToken(o.token))) overrides[o.token] = null;
    for (const t of c.value) overrides[t] = 'disallow';
    return { overrides };
  };
  // The preview shows the lines being typed once they can be saved.
  const typed: CrawlerPolicyPatch = {};
  if (custom && typedPaths !== null) {
    const c = checkCrawlerPathLines(typedPaths);
    if (c.ok) typed.disallowPaths = c.value;
  }
  if (custom && typedTokens !== null) {
    const patch = tokensPatch(typedTokens);
    if (patch) typed.overrides = patch.overrides;
  }
  const preview = siteRobotsTxt(site, (Object.keys(typed).length ? patchedCrawlerRules(site, typed) : null) ?? rules);
  const mount = siteMount(site);
  return (
    <>
      <Field label="Crawler policy" hint={PRESET_HINTS[rules.preset]}>
        <select id="site-crawler-preset" className="select" value={rules.preset} onChange={(e) => isPreset(e.target.value) && save({ preset: e.target.value })}>
          {CRAWLER_PRESETS.map((p) => (
            <option key={p} value={p}>
              {CRAWLER_PRESET_LABELS[p]}
            </option>
          ))}
        </select>
      </Field>
      {custom && (
        <>
          <Field label="Starts from" hint="The preset Custom changes. Crawlers left on Default do what it does.">
            <select id="site-crawler-base" className="select" value={rules.base} onChange={(e) => isFixed(e.target.value) && save({ base: e.target.value })}>
              {FIXED_CRAWLER_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {CRAWLER_PRESET_LABELS[p]}
                </option>
              ))}
            </select>
          </Field>
          {(['search', 'ai-search', 'ai-training'] as const).map((kind) => (
            <div key={kind} className="ss-group" role="group" aria-labelledby={`${uid}-${kind}`}>
              <div className="ss-group-label" id={`${uid}-${kind}`}>
                {KIND_LABELS[kind]}
              </div>
              {KNOWN_CRAWLERS.filter((c) => c.kind === kind).map((c) => {
                const own = rules.overrides.get(foldToken(c.token));
                const fallback = presetAction(rules.base, c.token);
                const id = `site-crawler-${c.token}`;
                return (
                  <div key={c.token} className="crawler-row">
                    <div>
                      <label className="ss-name" htmlFor={id}>
                        {c.token}
                      </label>
                      <div className="field-hint" id={`${id}-h`}>
                        {c.operator}: {c.purpose}
                      </div>
                    </div>
                    <select id={id} className="select" aria-describedby={`${id}-h`} value={own?.action ?? ''} onChange={(e) => save({ overrides: { [c.token]: e.target.value === 'allow' || e.target.value === 'disallow' ? e.target.value : null } })}>
                      <option value="">Default ({ACTION_LABELS[fallback]})</option>
                      <option value="allow">Allow</option>
                      <option value="disallow">Block</option>
                    </select>
                  </div>
                );
              })}
            </div>
          ))}
          <CheckedLines
            id="site-crawler-extra"
            label="Also block"
            hint="Other crawlers to keep out of the whole site, by the name robots.txt gives them, one per line."
            value={extraTokens(rules)}
            placeholder="ExampleBot"
            check={checkCrawlerTokenLines}
            onLive={setTypedTokens}
            onCommit={(v) => {
              const patch = tokensPatch(v);
              return patch ? save(patch) : false;
            }}
          />
          <CheckedLines
            id="site-crawler-paths"
            label="Closed paths"
            hint="Paths of the site no crawler may fetch, one per line, from the site’s root: /private/ closes everything under it, /*.pdf$ every PDF. Pages hidden from search engines need none: they already say so."
            value={rules.paths.join('\n')}
            placeholder="/private/"
            check={checkCrawlerPathLines}
            onLive={setTypedPaths}
            onCommit={(v) => {
              const c = checkCrawlerPathLines(v);
              return c.ok ? save({ disallowPaths: c.value }) : false;
            }}
          />
        </>
      )}
      <SwitchRow
        id="site-crawler-noai"
        checked={rules.noAiMeta}
        onChange={(v) => save({ noAiMeta: v === presetNoAiMeta(rules.base) ? null : v })}
        label="Ask AI services not to train on pages"
        hint={`Adds ${NOAI_META} to every page. Some AI services honour it; it keeps no crawler out.`}
      />
      <Field label="robots.txt preview" hint={mount ? `Crawlers read robots.txt only at the root of the domain (${new URL(publicUrl(site)!).origin}/robots.txt). Put these lines in that file for them to apply.` : undefined}>
        <pre className="code-view crawler-preview" tabIndex={0} aria-label="robots.txt as the website writes it" data-testid="robots-txt-preview">
          {preview}
        </pre>
      </Field>
    </>
  );
}
