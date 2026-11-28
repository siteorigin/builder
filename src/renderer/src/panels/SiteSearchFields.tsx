import { useState } from 'react';
import type { ProjectState, SiteDoc } from '@shared/types';
import { checkSearchEndpoint, checkSearchPathPrefix, searchProvider, searchSocketSettings, SEARCH_ENDPOINT_MAX, SEARCH_PATH_PREFIX_MAX, SEARCH_PROVIDERS, type SearchSettingCheck } from '@shared/site-search';
import { openSiteStyles } from '../lib/actions';
import { ChoiceField, DraftInput, Field, SwitchRow, openSection, type DraftProblem } from '../components/ui';

/** The section's closed heading: which search the website runs. */
export function siteSearchScope(site: SiteDoc): string {
  return searchProvider(site) === 'searchsocket' ? 'SearchSocket' : 'Own index';
}

const refusal = (c: SearchSettingCheck): DraftProblem | null => (c.ok ? null : { message: c.message });
/** Saves a field's checked value, or refuses the text (false) without saving anything. */
const commitChecked = (c: SearchSettingCheck, save: (value: string) => unknown): unknown => (c.ok ? save(c.value) : false);
const stored = (site: SiteDoc, key: 'endpoint' | 'pathPrefix'): string => {
  const v = site.search && typeof site.search === 'object' ? site.search[key] : undefined;
  return typeof v === 'string' ? v : '';
};
const revealSearch = () => {
  openSiteStyles();
  openSection('site-search', { scroll: false });
};

/**
 * Site settings' Site search section (shared/site-search.ts): whether the Site search sections of the website search
 * the index written with it or ask a SearchSocket service the author hosts, and what they ask that service.
 */
export function SiteSearchFields({ state, onChange }: { state: ProjectState; onChange: (patch: Record<string, unknown>) => unknown }) {
  const site = state.site;
  const provider = searchProvider(site);
  const settings = searchSocketSettings(site);
  const [endpointProblem, setEndpointProblem] = useState<DraftProblem | null>(null);
  const [prefixProblem, setPrefixProblem] = useState<DraftProblem | null>(null);
  const endpoint = stored(site, 'endpoint');
  const prefix = stored(site, 'pathPrefix');
  // What is wrong with a saved value (a hand edit) shows while the field shows it, as what a draft was refused for does.
  // What the author just typed and was refused is announced; what is wrong with the saved value is read with the field.
  const refused = (message: string) => <span role="alert">{message} Not saved.</span>;
  const endpointError = endpointProblem ? refused(endpointProblem.message) : endpoint && !settings.endpoint ? `${refusal(checkSearchEndpoint(endpoint))?.message ?? ''} Searches fail until it is corrected.` : undefined;
  const prefixError = prefixProblem ? refused(prefixProblem.message) : prefix ? refusal(checkSearchPathPrefix(prefix))?.message : undefined;
  const set = (patch: Record<string, unknown>) => onChange({ search: patch });
  return (
    <>
      <ChoiceField
        label="Search with"
        full
        value={provider}
        options={SEARCH_PROVIDERS.map(([value, label]) => ({ value, label }))}
        info="What the Site search sections of the website search. This site’s own index is written with the website and needs nothing else. SearchSocket is a service you host that indexes the built website and finds pages by what they mean, not only by their words."
        onChange={(p) => set({ provider: p })}
      />
      {provider === 'searchsocket' && (
        <div className="agents-sub">
          <Field label="Search address" hint={endpointError ? undefined : settings.endpoint ? undefined : 'Searches fail until it is set'} error={endpointError} info="The public search address of your SearchSocket deployment. It needs no key, and must let this website’s address ask it (its CORS origins).">
            <DraftInput
              id="site-search-endpoint"
              keep="site:search.endpoint"
              value={endpoint}
              placeholder="https://search.example.com/api/search"
              limit={SEARCH_ENDPOINT_MAX}
              check={(v) => refusal(checkSearchEndpoint(v))}
              onProblem={setEndpointProblem}
              reveal={revealSearch}
              onCommit={(v) => commitChecked(checkSearchEndpoint(v), (value) => set({ endpoint: value }))}
            />
          </Field>
          <Field label="Only pages under" hint={prefixError ? undefined : 'Empty: the whole site'} error={prefixError} info="Results come only from pages whose address starts with this, such as /docs/.">
            <DraftInput
              id="site-search-path-prefix"
              keep="site:search.pathPrefix"
              value={prefix}
              placeholder="/"
              limit={SEARCH_PATH_PREFIX_MAX}
              check={(v) => refusal(checkSearchPathPrefix(v))}
              onProblem={setPrefixProblem}
              reveal={revealSearch}
              onCommit={(v) => commitChecked(checkSearchPathPrefix(v), (value) => set({ pathPrefix: value }))}
            />
          </Field>
          <SwitchRow
            id="site-search-scroll"
            checked={settings.scrollToText}
            onChange={(v) => set({ scrollToText: v })}
            label="Open results at the words found"
            info="A result opens its page scrolled to the part that matched, in browsers that can. Off: where the result’s address leads, usually the top of the page."
          />
          <div className="field-hint">The editor’s preview searches this site’s own index. The exported website asks SearchSocket, and a Source export adds searchsocket.config.ts to index it.</div>
        </div>
      )}
    </>
  );
}
