import { useState } from 'react';
import type { ProjectState } from '@shared/types';
import { pageLanguage, siteLanguage } from '@shared/languages';
import { clipText } from '@shared/not-found';
import { VISITOR_TEXT_GROUPS, VISITOR_TEXT_LIMIT, visitorTextFor, visitorTextLanguage, type VisitorTextKey } from '@shared/visitor-text';
import { DraftInput, Field } from '../components/ui';

/** The languages the site's pages are in, the site's own first, each once whatever its case. */
export function siteLanguages(state: Pick<ProjectState, 'site' | 'pages'>): string[] {
  const site = siteLanguage(state.site);
  const out = [site];
  for (const id of state.site.pageOrder) {
    const page = Object.hasOwn(state.pages, id) ? state.pages[id] : undefined;
    const language = page ? pageLanguage(state.site, page) : site;
    if (!out.some((l) => visitorTextLanguage(l) === visitorTextLanguage(language))) out.push(language);
  }
  return out;
}

/**
 * What the site says on its own around the author's content, in each language its pages are in: the author's own
 * wording, with the wording used without it shown in each empty field.
 */
export function VisitorTextFields({ state, onCommit }: { state: Pick<ProjectState, 'site' | 'pages'>; onCommit: (language: string, key: VisitorTextKey, value: string) => unknown }) {
  const languages = siteLanguages(state);
  const [chosen, setChosen] = useState(languages[0]);
  const language = languages.find((l) => visitorTextLanguage(l) === visitorTextLanguage(chosen)) ?? languages[0];
  const code = visitorTextLanguage(language);
  const all = state.site.visitorText && typeof state.site.visitorText === 'object' ? state.site.visitorText : {};
  const own = Object.hasOwn(all, code) && all[code] && typeof all[code] === 'object' ? all[code] : {};
  // What each field says while it is empty: the wording for the language without the author's own for it.
  const others = Object.fromEntries(Object.entries(all).filter(([k]) => k !== code));
  const fallback = visitorTextFor({ visitorText: others }, language);
  return (
    <>
      <p className="muted">
        Words your site says on its own: the menu button, the skip link, a form’s progress and the like. Each page uses the wording for its language. Leave a field empty to use the wording shown.
      </p>
      {languages.length > 1 && (
        <Field label="Language" hint="Pages in this language use this wording.">
          <select className="select" value={language} onChange={(e) => setChosen(e.target.value)}>
            {languages.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      )}
      {VISITOR_TEXT_GROUPS.map((group) => (
        <div className="ss-group" key={group.label} role="group" aria-label={group.label}>
          <div className="ss-group-label">{group.label}</div>
          {group.fields.map((f) => (
            <Field key={`${code}:${f.key}`} label={f.label} hint={f.fills ? `${f.hint} ${f.fills.map((n) => `{${n}}`).join(', ')} ${f.fills.length > 1 ? 'are' : 'is'} filled in.` : f.hint}>
              <DraftInput
                value={typeof own[f.key] === 'string' ? own[f.key] : ''}
                placeholder={fallback[f.key]}
                limit={VISITOR_TEXT_LIMIT}
                onCommit={(v) => onCommit(language, f.key, clipText(v.trim(), VISITOR_TEXT_LIMIT))}
              />
            </Field>
          ))}
        </div>
      ))}
    </>
  );
}
