/**
 * Visitor browsing of a collection, as the editor sets it (see shared/collection-browse.ts): what visitors can search,
 * filter and sort by on its index and in each list of it that browses. Shown in the Index settings, and beside a list
 * whose browsing is on.
 */
import './PagesPanel.css';
import { useState } from 'react';
import type { CollectionBrowse, CollectionDoc } from '@shared/types';
import { MAX_BROWSE_KEYS, browseChoices, storedBrowse, type BrowseFilterKind } from '@shared/collection-browse';
import { commitOps, useStore } from '../store';
import { SwitchRow } from '../components/ui';

/** What each kind of filter lets visitors do, as the editor says it. */
const FILTER_KIND_HINT: Record<BrowseFilterKind, string> = { choice: 'Pick any', yesno: 'Yes or no', range: 'From and to' };

/**
 * What visitors can do with a collection's entries, in their own browser: search their titles and excerpts, filter by
 * its groupings and its choice, yes/no and number fields, and sort by its title, date and text, number and date
 * fields. `note` says where they can (the first page of its index, a list), and `legend` names it.
 */
export function CollectionBrowsing(props: { collectionId: string; name: string; settings: CollectionDoc; note: string; legend?: string }) {
  const { collectionId, name, settings, note, legend = 'Visitor browsing' } = props;
  const now = storedBrowse(settings) ?? {};
  const { filters, sorts } = browseChoices(settings);
  // Each change replaces the whole setting, so it is made from the setting the project shows, one at a time: while a
  // change is on its way, until the project shows the revision it made (or it is refused), a click changes nothing.
  const revision = useStore((st) => st.snapshot?.revision ?? 0);
  const [sending, setSending] = useState<{ revision?: number } | null>(null);
  const busy = !!sending && (sending.revision === undefined || revision < sending.revision);
  const commit = (change: (was: CollectionBrowse) => CollectionBrowse, label: string) => {
    if (busy) return;
    const stored = storedBrowse({ ...settings, browse: change(now) });
    if (JSON.stringify(stored ?? {}) === JSON.stringify(now)) return;
    setSending({});
    void commitOps([{ type: 'collection.update', collectionId, browse: stored ?? null }], label).then((r) => setSending(r?.ok ? { revision: r.revision } : null));
  };
  // Each list keeps the order the fields are offered in.
  const toggle = (list: 'filters' | 'sort', offered: Array<{ key: string }>, key: string, on: boolean, label: string) =>
    commit((was) => ({ ...was, [list]: offered.map((c) => c.key).filter((k) => (k === key ? on : (was[list] ?? []).includes(k))) }), label);
  // At the most a list takes, the fields not chosen wait until one is unticked.
  const full = (list: 'filters' | 'sort', key: string) => (now[list] ?? []).length >= MAX_BROWSE_KEYS && !(now[list] ?? []).includes(key);
  return (
    <fieldset className="pages-collection-browse" aria-busy={busy || undefined}>
      <legend>{legend}</legend>
      <p className="pages-collection-note">{note}</p>
      <SwitchRow
        checked={!!now.search}
        label="Search"
        hint="Visitors search the entries’ titles, excerpts and categories, and the options they can filter by."
        onChange={(on) => commit((was) => ({ ...was, search: on }), on ? `Let visitors search the ${name} index` : `Stop letting visitors search the ${name} index`)}
      />
      <fieldset className="pages-collection-checks">
        <legend>Filters</legend>
        {filters.length ? (
          <ul>
            {filters.map((f) => (
              <li key={f.key}>
                <label>
                  <input
                    type="checkbox"
                    checked={(now.filters ?? []).includes(f.key)}
                    disabled={full('filters', f.key)}
                    onChange={(e) => toggle('filters', filters, f.key, e.target.checked, e.target.checked ? `Let visitors filter ${name} by ${f.label}` : `Stop letting visitors filter ${name} by ${f.label}`)}
                  />
                  <span className="grow">{f.label}</span>
                  <span className="pages-collection-kind">{FILTER_KIND_HINT[f.kind]}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="pages-collection-note">Add a grouping, or a choice, yes/no or number field, to filter by.</p>
        )}
      </fieldset>
      <fieldset className="pages-collection-checks">
        <legend>Sorting</legend>
        <ul>
          {sorts.map((f) => (
            <li key={f.key}>
              <label>
                <input
                  type="checkbox"
                  checked={(now.sort ?? []).includes(f.key)}
                  disabled={full('sort', f.key)}
                  onChange={(e) => toggle('sort', sorts, f.key, e.target.checked, e.target.checked ? `Let visitors sort ${name} by ${f.label}` : `Stop letting visitors sort ${name} by ${f.label}`)}
                />
                <span className="grow">{f.label}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
    </fieldset>
  );
}
