import { useCallback, useId, useRef, useState } from 'react';
import { RotateCcw, Search } from 'lucide-react';
import type { ProjectState, SiteDoc } from '@shared/types';
import { isLanguageCode, pageLanguage, siteLanguage } from '@shared/languages';
import { clipText } from '@shared/not-found';
import { VISITOR_TEXT_GROUPS, VISITOR_TEXT_LIMIT, ownVisitorTextFor, visitorTextFor, visitorTextLanguage, type VisitorTextField, type VisitorTextKey } from '@shared/visitor-text';
import { DraftInput, Field, type DraftHandle } from '../components/ui';

/**
 * The languages the site's pages are in, the site's own first, then any other language the author has wording for
 * (such as "ar" beside pages in "ar-EG", whose wording they use), each once whatever its case.
 */
export function siteLanguages(state: Pick<ProjectState, 'site' | 'pages'>): string[] {
  const site = siteLanguage(state.site);
  const out = [site];
  const add = (language: string) => {
    if (!out.some((l) => visitorTextLanguage(l) === visitorTextLanguage(language))) out.push(language);
  };
  for (const id of state.site.pageOrder) {
    const page = Object.hasOwn(state.pages, id) ? state.pages[id] : undefined;
    add(page ? pageLanguage(state.site, page) : site);
  }
  const all = state.site.visitorText;
  if (all && typeof all === 'object' && !Array.isArray(all))
    for (const code of Object.keys(all).sort()) if (isLanguageCode(code) && Object.keys(ownVisitorTextFor(state.site, code)).length) add(code);
  return out;
}

/** How many wordings of the author's own the site has, in every language. */
export function changedVisitorText(site: SiteDoc): number {
  const all = site.visitorText;
  if (!all || typeof all !== 'object' || Array.isArray(all)) return 0;
  return Object.keys(all).reduce((n, code) => n + (isLanguageCode(code) ? Object.keys(ownVisitorTextFor(site, code)).length : 0), 0);
}

/** The closed heading's summary: how many wordings are the author's own, or nothing while every one is built in. */
export const visitorTextScope = (site: SiteDoc) => {
  const n = changedVisitorText(site);
  return n ? `${n} changed` : undefined;
};

/** A language code by name ("fr-CA" → "French (Canada)"), or the code itself when the system has no name for it. */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language', languageDisplay: 'standard' }).of(code);
    return name && name.toLowerCase() !== code.toLowerCase() ? name : code;
  } catch {
    return code;
  }
}

/** The fill-ins a wording leaves out that visitors would then miss. */
export const missingFills = (f: VisitorTextField, text: string) => (text.trim() ? (f.fills ?? []).filter((n) => !f.optionalFills?.includes(n) && !text.includes(`{${n}}`)) : []);

const fillList = (names: string[]) => names.map((n) => `{${n}}`).join(names.length > 2 ? ', ' : ' and ').replace(/, ([^,]*)$/, ' and $1');

/** One wording: its label (with a reset while it is the author's own), the field, and what it is and holds. */
function WordingField({ f, own, fallback, onCommit }: { f: VisitorTextField; own: string; fallback: string; onCommit: (v: string) => unknown }) {
  const id = useId();
  const input = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const handle = useRef<DraftHandle | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const onDirty = useCallback((dirty: boolean, text: string) => setDraft(dirty ? text : null), []);
  const changed = own !== '';
  const text = draft ?? own;
  const missing = missingFills(f, text);
  return (
    <div className={`field vt-field${changed ? ' set' : ''}`} data-vt-key={f.key}>
      <div className="vt-label">
        <label htmlFor={id} className="ss-name">
          {f.label}
        </label>
        {changed && (
          <button
            type="button"
            className="reset-dot"
            title={`Changed. Click to use “${fallback}” again.`}
            aria-label={`Set ${f.label} back to ${fallback}`}
            onClick={() => {
              // Through the field, so text it is holding (refused as too long, say) goes with the wording it replaces.
              if (handle.current) handle.current.commit('');
              else void onCommit('');
              input.current?.focus();
            }}
          >
            <RotateCcw />
          </button>
        )}
      </div>
      <DraftInput id={id} inputRef={input} handle={handle} wrap className="textarea vt-input" quietCount aria-describedby={`${id}-note`} value={own} placeholder={fallback} limit={VISITOR_TEXT_LIMIT} onDirty={onDirty} onCommit={onCommit} />
      <div className="field-hint" id={`${id}-note`}>
        {f.hint}
        {f.fills && (
          <span className="vt-fills">
            Fill-ins{f.optionalFills ? ' (optional)' : ''}: {f.fills.map((n) => <code key={n}>{`{${n}}`}</code>)}
            {f.optionalFills && <>; without it, the title goes at the end</>}
          </span>
        )}
        {/* What an empty field uses (the built-in wording, or the author's for the language it falls back to), kept in
            view once the field holds wording of its own, typed or saved. */}
        {text.trim() !== '' && (
          <span className="vt-fallback">
            When empty: <span className="vt-fallback-text">{fallback}</span>
          </span>
        )}
        {missing.length > 0 && (
          <span className="field-warning">
            Leaves out {fillList(missing)}, so visitors won’t see {missing.length > 1 ? 'them' : 'it'}.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * What the site says on its own around the author's content, in each language its pages are in: the author's own
 * wording, with the wording used without it shown in each empty field, found by words in any of it.
 */
export function VisitorTextFields({ state, onCommit }: { state: Pick<ProjectState, 'site' | 'pages'>; onCommit: (language: string, key: VisitorTextKey, value: string) => unknown }) {
  const [chosen, setChosen] = useState(() => siteLanguages(state)[0]);
  // A language listed only for wording of its own stays while it is being edited, even once its last wording is put back.
  const listed = siteLanguages(state);
  const languages = listed.some((l) => visitorTextLanguage(l) === visitorTextLanguage(chosen)) || !isLanguageCode(chosen) ? listed : [...listed, chosen];
  const [query, setQuery] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  // Rows put back while only the changed ones show stay in place (focus with them) until the view changes.
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const [said, setSaid] = useState('');
  const findRef = useRef<HTMLInputElement>(null);
  const findId = useId();
  // Which view a save was made in: what it says on landing is dropped once the view has changed under it.
  const viewSeq = useRef(0);
  const view = (only: boolean, q: string) => {
    setOnlyChanged(only);
    setQuery(q);
    setKept(new Set());
    setSaid('');
    viewSeq.current++;
  };
  const language = languages.find((l) => visitorTextLanguage(l) === visitorTextLanguage(chosen)) ?? languages[0];
  const code = visitorTextLanguage(language);
  // The author's wording as the site uses it, and what each field says while it is empty: the wording for the
  // language without the author's own for it (their wording for its primary language, or the built-in wording).
  const own = ownVisitorTextFor(state.site, code);
  const all = state.site.visitorText && typeof state.site.visitorText === 'object' && !Array.isArray(state.site.visitorText) ? state.site.visitorText : {};
  const others = Object.fromEntries(Object.entries(all).filter(([k]) => visitorTextLanguage(k) !== code));
  const fallback = visitorTextFor({ visitorText: others }, language);
  const changedHere = Object.keys(own).length;
  const showChanged = onlyChanged && (changedHere > 0 || kept.size > 0);
  const needle = query.trim().toLowerCase();
  const filtered = (f: VisitorTextField, group: string) =>
    (!showChanged || !!own[f.key]) && (!needle || [group, f.label, f.hint, fallback[f.key], own[f.key] ?? ''].some((t) => t.toLowerCase().includes(needle)));
  const matches = (f: VisitorTextField, group: string) => kept.has(f.key) || filtered(f, group);
  const groups = VISITOR_TEXT_GROUPS.map((g) => ({ ...g, shown: g.fields.filter((f) => matches(f, g.label)) })).filter((g) => g.shown.length);
  const count = groups.reduce((n, g) => n + g.shown.length, 0);
  const filtering = !!needle || showChanged;
  // Rows kept in view only because they were saved in while this filter showed them.
  const held = groups.some((g) => g.shown.some((f) => kept.has(f.key) && !filtered(f, g.label)));
  const changedIn = (l: string) => Object.keys(ownVisitorTextFor(state.site, visitorTextLanguage(l))).length;
  return (
    <>
      <p className="agents-intro">
        Words the site says on its own{languages.length === 1 ? ` in ${languageName(language)}` : ''}, such as the menu button and a form’s progress. Leave a field empty to use the wording shown.
      </p>
      {languages.length > 1 && (
        <Field label="Language" hint="Pages in this language use this wording.">
          <select
            className="select"
            value={language}
            onChange={(e) => {
              setChosen(e.target.value);
              setKept(new Set());
              setSaid('');
              viewSeq.current++;
            }}
          >
            {languages.map((l) => {
              const n = changedIn(l);
              return (
                <option key={l} value={l}>
                  {languageName(l)}
                  {languageName(l) !== l ? ` (${l})` : ''}
                  {n ? ` · ${n} changed` : ''}
                </option>
              );
            })}
          </select>
        </Field>
      )}
      <div className="vt-find">
        <label className="field-label" htmlFor={findId}>
          Find wording
        </label>
        <div className="vt-tools">
          <div className="search vt-search">
            <Search />
            <input id={findId} ref={findRef} className="input" type="search" placeholder="Name or words" aria-describedby={held ? `${findId}-held` : undefined} value={query} onChange={(e) => view(onlyChanged, e.target.value)} />
          </div>
        {/* Kept while the changed ones show, even once none is left, so there is always a way back to All. */}
        {(changedHere > 0 || showChanged) && (
          <div className="segmented" role="group" aria-label="Show">
            <button
              aria-pressed={!showChanged}
              onClick={() => {
                view(false, query);
                // With nothing changed, this control goes with the view: the find box takes focus instead.
                if (!changedHere) findRef.current?.focus();
              }}
            >
              All
            </button>
            <button aria-pressed={showChanged} onClick={() => view(true, query)}>
              Changed {changedHere}
            </button>
          </div>
        )}
        </div>
        {held && <div className="field-hint" id={`${findId}-held`}>Wording you just changed stays in view until you change the filter.</div>}
      </div>
      <span className="sr-only" role="status">
        {said || (filtering ? `${count} ${count === 1 ? 'wording' : 'wordings'} shown.` : '')}
      </span>
      <div className={`vt-results${filtering ? ' filtering' : ''}`}>
      {groups.length === 0 && (
        <div className="vt-empty">
          <span>No wording matches “{query.trim()}”{showChanged ? ' among your changes' : ''}.</span>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              view(false, '');
              findRef.current?.focus();
            }}
          >
            Show all
          </button>
        </div>
      )}
      {groups.map((group) => (
        <div className="ss-group vt-group" key={group.label} role="group" aria-label={group.label}>
          <div className="ss-group-label">{group.label}</div>
          {group.shown.map((f) => (
            <WordingField
              key={`${code}:${f.key}`}
              f={f}
              own={own[f.key] ?? ''}
              fallback={fallback[f.key]}
              onCommit={(v) => {
                const text = clipText(v.trim(), VISITOR_TEXT_LIMIT);
                // A row saved in while a filter shows it (put back, cleared or reworded) stays, with focus in it, until the
                // view changes, whether or not it still matches.
                if (filtering) setKept((prev) => new Set(prev).add(f.key));
                setSaid('');
                const saved = onCommit(language, f.key, text);
                // Putting a wording back is said once the save has landed in the view it was made in: a refused save, or
                // one that lands after the view changed, says nothing.
                if (!text && own[f.key]) {
                  const seq = viewSeq.current;
                  const back = fallback[f.key];
                  void Promise.resolve(saved).then((ok) => ok !== null && ok !== false && seq === viewSeq.current && setSaid(`${f.label} is back to “${back}”.`));
                }
                return saved;
              }}
            />
          ))}
        </div>
      ))}
      </div>
    </>
  );
}
