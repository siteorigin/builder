import { useCallback, useMemo, useState } from 'react';
import type { ProjectState } from '@shared/types';
import { agentDiscovery, LLMS_FULL_FILE, LLMS_TXT_FILE, MARKDOWN_MIRROR_FILE } from '@shared/llms';
import { publicUrl } from '@shared/public-url';
import { webMcpOn } from '@shared/webmcp';
import { TEXT_LIMITS } from '@shared/text-limits';
import { generateLlmsTxt } from '@generator/llms';
import { DraftInput, Field, SwitchRow } from '../components/ui';

/**
 * Site styles' AI agents section: what the website offers AI agents beside its pages (see shared/llms.ts), and the
 * llms.txt it writes, shown as it will be while the summary is typed.
 */
export function AgentDiscoveryFields({ state, onChange }: { state: ProjectState; onChange: (patch: Record<string, unknown>) => unknown }) {
  const site = state.site;
  const settings = agentDiscovery(site);
  // The summary as the field shows it while it holds unsaved text (typed, or refused and shown again), until it is
  // saved or put back.
  const [typed, setTyped] = useState<string | null>(null);
  const shown = useCallback((dirty: boolean, draft: string) => setTyped(dirty ? draft : null), []);
  // The documents it lists are worked out once per project state; typing changes only its opening.
  const preview = useMemo(() => (settings.llmsTxt ? generateLlmsTxt(state, typed === null ? undefined : { summary: typed }) : null), [state, typed, settings.llmsTxt]);
  return (
    <>
      <SwitchRow
        id="site-llms-txt"
        checked={settings.llmsTxt}
        onChange={(v) => onChange({ llmsTxt: v })}
        label={`Write ${LLMS_TXT_FILE}`}
        hint="An index AI assistants read to learn what the site covers: its pages and posts that search engines may list, with their descriptions. Drafts and pages hidden from search engines are never in it."
      />
      <SwitchRow
        id="site-llms-full"
        checked={settings.llmsFull}
        onChange={(v) => onChange({ llmsFull: v })}
        label={`Write ${LLMS_FULL_FILE}`}
        hint="The words of every page and post in that index, as Markdown in one file."
      />
      <SwitchRow
        id="site-markdown-mirrors"
        checked={settings.markdownMirrors}
        onChange={(v) => onChange({ markdownMirrors: v })}
        label="Write a Markdown copy of each page"
        hint={`Beside each page and post in the index, at its address with ${MARKDOWN_MIRROR_FILE} added, without the header, footer or layout. Each page links to its copy.`}
      />
      <SwitchRow
        id="site-webmcp"
        checked={webMcpOn(site)}
        onChange={(v) => onChange({ webmcp: v })}
        label="Declare WebMCP tools"
        hint="AI assistants in a visitor’s browser learn what each contact form is for and what its fields ask, and can search the site. The assistant only fills a form in: the visitor checks it and sends it. Browsers without WebMCP ignore it."
      />
      <Field label="Summary" hint="One or two sentences llms.txt opens with. Leave it empty to use the site’s default description.">
        <DraftInput multiline limit={TEXT_LIMITS.siteDescription} keep="site:llmsSummary" value={typeof site.llmsSummary === 'string' ? site.llmsSummary : ''} placeholder={typeof site.description === 'string' ? site.description : ''} onDirty={shown} onCommit={(v) => onChange({ llmsSummary: v })} />
      </Field>
      {preview !== null ? (
        <Field label={`${LLMS_TXT_FILE} preview`} hint={publicUrl(site) ? undefined : 'Without a public URL its links are relative to the website’s folder. Add one in Site details for full addresses.'}>
          <pre className="code-view" tabIndex={0} aria-label={`${LLMS_TXT_FILE} as the website writes it`} data-testid="llms-txt-preview">
            {preview}
          </pre>
        </Field>
      ) : (
        <p className="field-hint">The website has no {LLMS_TXT_FILE}, so AI agents get no index of its pages.</p>
      )}
    </>
  );
}
