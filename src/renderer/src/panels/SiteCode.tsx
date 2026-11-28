import { useState, type FormEvent, type ReactNode } from 'react';
import type { SiteDoc } from '@shared/types';
import { GLOBAL_CSS_MAX, globalCssProblem, hasCode, HEAD_CODE_MAX, headCodeProblem, type CodeProblem } from '@shared/site-code';
import { addedIntegrations, FATHOM_ID_MAX, fathomIdText, fathomSiteId, fathomSiteIdProblem, INTEGRATIONS } from '@shared/integrations';
import { DraftInput, Field, openSection, type DraftProblem } from '../components/ui';
import { openSiteStyles } from '../lib/actions';

/** What the Integrations section's closed heading says: how many are added, or nothing while none is. */
export function integrationsScope(site: SiteDoc): string | undefined {
  const n = addedIntegrations(site).length;
  return n ? `${n} added` : undefined;
}

/** What the Custom code section's closed heading says: which of the two the site has, or nothing while neither. */
export function siteCodeScope(site: SiteDoc): string | undefined {
  const head = hasCode(site.headCode);
  const css = hasCode(site.globalCss);
  return head && css ? 'Head code and CSS' : head ? 'Head code' : css ? 'CSS' : undefined;
}

/** A problem a code check found, as a field shows it: where first, then what. */
const asDraftProblem = (p: CodeProblem | null): DraftProblem | null => (p ? { message: `Line ${p.line}, column ${p.column}: ${p.message}` } : null);

const revealSection = (id: string) => () => {
  openSiteStyles();
  openSection(id, { scroll: false });
};

/**
 * A field of code, checked as it is typed. Code it refuses stays in the field as an unsaved draft with the reason,
 * the saved code still in use, until it is corrected or put back (Escape). Saved code a hand edit left unusable is
 * pointed out the same way, as what the website is built without.
 */
function CodeField({ id, label, info, value: saved, check, limit, rows, placeholder, keep, section, readOnly, onCommit }: { id: string; label: string; info: ReactNode; value: unknown; check: (v: string) => CodeProblem | null; limit: number; rows: number; placeholder: string; keep: string; section: string; readOnly?: boolean; onCommit: (v: string) => unknown }) {
  const value = typeof saved === 'string' ? saved : '';
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const [dirty, setDirty] = useState(false);
  // What is wrong with the saved code describes the field only while it shows that code.
  const savedProblem = !dirty && (typeof saved === 'string' ? (hasCode(saved) ? asDraftProblem(check(saved)) : null) : saved !== undefined ? { message: 'What is saved here is not text.' } : null);
  const shown = problem ?? savedProblem;
  const error = shown && (
    <span role={problem ? 'alert' : undefined}>
      {shown.message} <span className="field-saved">{problem ? (hasCode(value) ? 'Not saved: the website keeps the code saved before.' : 'Not saved.') : 'The website is built without it until it is corrected.'}</span>
    </span>
  );
  return (
    <Field label={label} info={info} error={error}>
      <DraftInput
        id={id}
        className="input site-code-input"
        multiline
        rows={rows}
        limit={limit}
        keep={keep}
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        check={(v) => asDraftProblem(check(v))}
        onProblem={setProblem}
        onDirty={setDirty}
        reveal={revealSection(section)}
        onCommit={onCommit}
      />
    </Field>
  );
}

/**
 * Site settings' Custom code section: the site's own markup for every page's <head>, and its own stylesheet
 * (shared/site-code.ts). Both are code the author writes by hand, so they change in Developer mode alone; without
 * it, what the site has is shown to read.
 */
export function SiteCodeFields({ site, developer, onChange }: { site: SiteDoc; developer: boolean; onChange: (patch: Record<string, unknown>) => unknown }) {
  const has = hasCode(site.headCode) || hasCode(site.globalCss);
  if (!developer && !has) return <p className="site-code-note">Turn on Developer mode in Settings to add your own head code and CSS to the website.</p>;
  return (
    <>
      {!developer && <p className="site-code-note">Turn on Developer mode in Settings to change this code.</p>}
      <CodeField
        id="site-head-code"
        label="Head code"
        info="Added to the <head> of every page of the published website: verification <meta> tags, <link> hints and stylesheets, and <script>s such as analytics. It never runs in the editor, so your own visits are never counted. For styles of your own, use Custom CSS, which loads after the site’s."
        value={site.headCode}
        check={headCodeProblem}
        limit={HEAD_CODE_MAX}
        rows={7}
        placeholder={'<meta name="google-site-verification" content="…">'}
        keep="site:headCode"
        section="site-code"
        readOnly={!developer}
        onCommit={(v) => onChange({ headCode: v })}
      />
      <CodeField
        id="site-global-css"
        label="Custom CSS"
        info="Loaded after every other stylesheet on every page, in the editor too, so it wins over the site’s own styles. An address in url() needs https:// or a path from the site’s root (/…). For a stylesheet from elsewhere, add a <link> to the head code."
        value={site.globalCss}
        check={globalCssProblem}
        limit={GLOBAL_CSS_MAX}
        rows={9}
        placeholder={'.so-btn {\n  border-radius: 0;\n}'}
        keep="site:globalCss"
        section="site-code"
        readOnly={!developer}
        onCommit={(v) => onChange({ globalCss: v })}
      />
    </>
  );
}

/**
 * Site settings' Integrations section: services the website works with, each added from what it needs (its site ID)
 * and removed with one button (shared/integrations.ts). A new one's ID stays in its form until Add saves it, so
 * putting it back (Cancel, or Escape) adds nothing; an added one's ID saves as it is changed, as other settings do.
 * `onChange` gives null when the change is refused.
 */
export function IntegrationFields({ site, onChange }: { site: SiteDoc; onChange: (patch: Record<string, unknown>) => unknown }) {
  const added = addedIntegrations(site);
  // The integration being added, and what is typed for it.
  const [adding, setAdding] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [addProblem, setAddProblem] = useState<string | null>(null);
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const stopAdding = () => (setAdding(null), setTyped(''), setAddProblem(null));
  return (
    <>
      {INTEGRATIONS.map(({ id, name, summary }) => {
        const on = added.includes(id);
        const saved = on ? fathomIdText(site.integrations?.fathom?.siteId) : '';
        // Added, but with an ID a hand edit left unusable: the website is built without it until it is corrected.
        const working = on && !!fathomSiteId(site);
        const savedProblem = on && !problem ? fathomSiteIdProblem(saved) : null;
        const shown = problem?.message ?? savedProblem;
        const add = async (e: FormEvent) => {
          e.preventDefault();
          const p = fathomSiteIdProblem(typed);
          if (p) return setAddProblem(p);
          // The form keeps the ID until the change is taken: refused (the AI is changing the site), it is still there.
          if ((await onChange({ integrations: { [id]: { siteId: fathomIdText(typed) } } })) !== null) stopAdding();
        };
        return (
          <div className={`site-integration${on ? ' on' : ''}`} key={id} role="group" aria-labelledby={`integration-${id}`}>
            <div className="site-integration-head">
              <div className="site-integration-name">
                <span id={`integration-${id}`}>{name}</span>
                <span className="site-integration-summary">{working ? 'Added. Counts visits to the published website, never the editor’s preview.' : on ? 'Added, but not counting visits until its site ID is corrected.' : summary}</span>
              </div>
              {on ? (
                <button type="button" className="btn btn-sm" onClick={() => (setProblem(null), onChange({ integrations: { [id]: null } }))}>
                  Remove<span className="sr-only"> {name}</span>
                </button>
              ) : (
                adding !== id && (
                  <button type="button" className="btn btn-sm" onClick={() => (setAdding(id), setTyped(''), setAddProblem(null))}>
                    Add<span className="sr-only"> {name}</span>
                  </button>
                )
              )}
            </div>
            {on && (
              <Field label="Site ID" info={SITE_ID_INFO} error={shown && <span role={problem ? 'alert' : undefined}>{shown}{problem && <span className="field-saved"> Not saved.</span>}</span>}>
                <DraftInput
                  id={`integration-${id}-site-id`}
                  className="input site-code-id"
                  limit={FATHOM_ID_MAX}
                  quietCount
                  spellCheck={false}
                  value={saved}
                  placeholder="ABCDEFGH"
                  check={(v) => {
                    const p = fathomSiteIdProblem(v);
                    return p ? { message: p } : null;
                  }}
                  onProblem={setProblem}
                  onCommit={(v) => (fathomIdText(v) === saved ? undefined : onChange({ integrations: { [id]: { siteId: fathomIdText(v) } } }))}
                />
              </Field>
            )}
            {!on && adding === id && (
              <form className="site-integration-add" onSubmit={add} onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), stopAdding())}>
                <Field label="Site ID" info={SITE_ID_INFO} error={addProblem && <span role="alert">{addProblem}</span>}>
                  <input id={`integration-${id}-new-id`} className="input site-code-id" value={typed} maxLength={FATHOM_ID_MAX} placeholder="ABCDEFGH" spellCheck={false} autoComplete="off" autoFocus onChange={(e) => (setTyped(e.target.value), setAddProblem(null))} />
                </Field>
                <div className="site-integration-actions">
                  <button type="button" className="btn btn-sm" onClick={stopAdding}>
                    Cancel<span className="sr-only"> adding {name}</span>
                  </button>
                  <button type="submit" className="btn btn-sm btn-primary">
                    Add<span className="sr-only"> {name}</span>
                  </button>
                </div>
              </form>
            )}
          </div>
        );
      })}
    </>
  );
}

/** Where a Fathom site ID is found, behind the field's info button. */
const SITE_ID_INFO = 'The code in your Fathom site’s settings, also in its embed code as data-site.';
