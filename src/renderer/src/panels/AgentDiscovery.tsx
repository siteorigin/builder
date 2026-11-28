import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { ProjectState, SiteDoc } from '@shared/types';
import { agentDiscovery, LLMS_FULL_FILE, LLMS_TXT_FILE, MARKDOWN_MIRROR_FILE } from '@shared/llms';
import { publicUrl } from '@shared/public-url';
import { webMcpOn } from '@shared/webmcp';
import { TEXT_LIMITS } from '@shared/text-limits';
import { generateLlmsTxt } from '@generator/llms';
import { DisclosureMark, DraftInput, Field, SwitchRow } from '../components/ui';
import { CopyText } from '../components/CopyText';

/** How many of the section's four features are on, for its closed heading ("2 on", "All off"). */
export function agentsScope(site: SiteDoc): string {
  const s = agentDiscovery(site);
  const on = [s.llmsTxt, s.llmsFull, s.markdownMirrors, webMcpOn(site)].filter(Boolean).length;
  return on ? `${on} on` : 'All off';
}

/** A switch's label: what it does in plain words, then the file or standard it writes, as secondary text. */
function Named({ name, tech }: { name: string; tech: string }) {
  return (
    <>
      {name} <span className="agents-tech">{tech}</span>
    </>
  );
}

/**
 * Site styles' AI agents section: what the website offers AI agents beside its pages (see shared/llms.ts). The page
 * index's summary and its preview sit under the index's switch, the only setting they belong to; the other three
 * are written whether or not the index is.
 */
export function AgentDiscoveryFields({ state, onChange }: { state: ProjectState; onChange: (patch: Record<string, unknown>) => unknown }) {
  const site = state.site;
  const settings = agentDiscovery(site);
  // The summary as the field shows it while it holds unsaved text (typed, or refused and shown again), until it is
  // saved or put back.
  const [typed, setTyped] = useState<string | null>(null);
  // The file itself is looked at now and then, not each visit: shown on request, so the four switches stay together.
  const [showFile, setShowFile] = useState(false);
  const shown = useCallback((dirty: boolean, draft: string) => setTyped(dirty ? draft : null), []);
  // The documents it lists are worked out once per project state; typing changes only its opening.
  const preview = useMemo(() => (settings.llmsTxt ? generateLlmsTxt(state, typed === null ? undefined : { summary: typed }) : null), [state, typed, settings.llmsTxt]);
  const own = typeof site.llmsSummary === 'string' ? site.llmsSummary : '';
  const described = typeof site.description === 'string' && site.description.trim() !== '';
  const summaryHint: ReactNode = (typed ?? own).trim()
    ? described
      ? 'The index opens with it. Clear it to use the site’s description.'
      : 'The index opens with it. Clear it to leave the summary out.'
    : described
      ? 'Using the site’s description, shown in the field. Write your own to say something else.'
      : 'Optional: one or two sentences the index opens with.';
  return (
    <>
      <p className="agents-intro">Files and features the website offers AI tools. They cover only the pages and posts search engines may list.</p>
      <div className={`agents-feature${settings.llmsTxt ? ' on' : ''}`}>
        <SwitchRow
          id="site-llms-txt"
          checked={settings.llmsTxt}
          onChange={(v) => onChange({ llmsTxt: v })}
          label={<Named name="Page index for AI tools" tech={LLMS_TXT_FILE} />}
          hint={settings.llmsTxt ? 'Lists the pages and posts, each with its description.' : 'Lists the pages and posts. Turn it on to write its summary and see the file.'}
        />
        {preview !== null && (
          <div className="agents-sub">
            <Field label="Index summary" hint={summaryHint}>
              <DraftInput multiline rows={2} limit={TEXT_LIMITS.siteDescription} keep="site:llmsSummary" value={own} placeholder={typeof site.description === 'string' ? site.description : ''} onDirty={shown} onCommit={(v) => onChange({ llmsSummary: v })} />
            </Field>
            <div className="agents-file">
              <div className="agents-file-head">
                <button type="button" className="disclosure-trigger agents-file-toggle" aria-expanded={showFile} aria-controls="site-llms-preview" onClick={() => setShowFile(!showFile)}>
                  <DisclosureMark />
                  The file as written
                </button>
                <CopyText text={preview} what={LLMS_TXT_FILE} className="agents-copy" />
              </div>
              <div id="site-llms-preview" className="agents-file-body" hidden={!showFile}>
                {showFile && (
                  <>
                    <pre className="code-view agents-preview" tabIndex={0} aria-label={`${LLMS_TXT_FILE} as the website writes it`} data-testid="llms-txt-preview">
                      {preview}
                    </pre>
                    {!publicUrl(site) && <div className="field-hint">Its links are relative to the website’s folder until the site has a public URL (Site details).</div>}
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      <SwitchRow
        id="site-llms-full"
        checked={settings.llmsFull}
        onChange={(v) => onChange({ llmsFull: v })}
        label={<Named name="All page text in one file" tech={LLMS_FULL_FILE} />}
        hint="Every page and post as Markdown, for tools that read the whole site."
      />
      <SwitchRow
        id="site-markdown-mirrors"
        checked={settings.markdownMirrors}
        onChange={(v) => onChange({ markdownMirrors: v })}
        label={<Named name="Text copy of each page" tech={MARKDOWN_MIRROR_FILE} />}
        hint="Markdown beside each page, without the header and footer, linked from it."
      />
      <SwitchRow
        id="site-webmcp"
        checked={webMcpOn(site)}
        onChange={(v) => onChange({ webmcp: v })}
        label={<Named name="Forms and search for browser assistants" tech="WebMCP" />}
        hint="An assistant in the visitor’s browser can search the site and fill in a contact form for the visitor to check and send."
      />
    </>
  );
}
