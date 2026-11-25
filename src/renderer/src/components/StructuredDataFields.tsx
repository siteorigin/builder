import { useState } from 'react';
import type { PageDoc } from '@shared/types';
import {
  checkFact,
  inspectPageStructuredData,
  isPageStructuredType,
  PAGE_STRUCTURED_TYPE_LABELS,
  PAGE_STRUCTURED_TYPES,
  PRODUCT_AVAILABILITY,
  PRODUCT_AVAILABILITY_LABELS,
  STRUCTURED_FACTS,
  typePhrase,
  type StructuredDataPatch,
  type StructuredFact
} from '@shared/page-structured-data';
import { DraftInput, Field, type DraftProblem } from './ui';

type Upd = (patch: Record<string, unknown>, label?: string) => unknown;

/** How each fact's field is labelled, explained and filled in by example. */
const FACT_FIELDS: Record<Exclude<StructuredFact, 'availability'>, { label: string; hint: string; placeholder?: string; multiline?: boolean }> = {
  serviceType: { label: 'Service type', hint: 'What kind of service it is.', placeholder: 'Pottery classes' },
  areaServed: { label: 'Area served', hint: 'Optional. Where it is offered.', placeholder: 'Cape Town' },
  price: { label: 'Price', hint: 'A number without the currency, such as 129 or 129.50. 0 when it is free.', placeholder: '129.50' },
  currency: { label: 'Currency', hint: 'Its three-letter code, such as USD, EUR or ZAR.', placeholder: 'ZAR' },
  offerUrl: { label: 'Where to buy it', hint: 'Optional. The address of the page it is sold on, when it is not this one.', placeholder: 'https://' },
  startDate: { label: 'Starts', hint: 'A date, or a date and a time on a 24-hour clock. Add the time zone as +02:00, or leave it out for the venue’s local time.', placeholder: '2027-05-14T19:30' },
  endDate: { label: 'Ends', hint: 'Optional. Written the same way.', placeholder: '2027-05-14T22:00' },
  venue: { label: 'Venue', hint: 'Where it takes place. A venue or an address is needed.', placeholder: 'Riverside Studio' },
  address: { label: 'Address', hint: 'The venue’s address on one line.' },
  steps: { label: 'Steps', hint: 'One step per line, in the order they are done.', multiline: true }
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** A stored fact as its field shows it: text, the steps one per line, or anything else written by hand as JSON to correct. */
const factText = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join('\n') : v == null ? '' : JSON.stringify(v));

/** What the Structured data section's closed heading says: the page's type, and whether its facts are complete. */
export function structuredSummary(page: PageDoc): string {
  const { type, issues, ready } = inspectPageStructuredData(page.seo && typeof page.seo === 'object' ? page.seo.structuredData : undefined);
  if (!ready) return type === 'WebPage' ? 'Needs a type' : `${PAGE_STRUCTURED_TYPE_LABELS[type]} · incomplete`;
  return `${PAGE_STRUCTURED_TYPE_LABELS[type]}${issues.length ? ' · check details' : ''}`;
}

/**
 * One fact, checked as it is typed: text it can't take stays in the field as an unsaved draft, with the reason, until
 * it is corrected or discarded (Escape). A saved value that can't be used (written by hand) is pointed out the same way.
 * It sends only its own fact, so an edit landing after the page became another type is refused, never turning it back.
 */
function FactField({ fact, stored, set }: { fact: Exclude<StructuredFact, 'availability'>; stored: Record<string, unknown>; set: (patch: StructuredDataPatch, label: string) => unknown }) {
  const { label, hint, placeholder, multiline } = FACT_FIELDS[fact];
  const value = factText(stored[fact]);
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const [dirty, setDirty] = useState(false);
  const check = (v: string): DraftProblem | null => {
    const c = checkFact(fact, v);
    return c.ok ? null : { message: c.message };
  };
  const shown = problem ?? (value && !dirty ? check(value) : null);
  const error = shown && (
    <span role={problem ? 'alert' : undefined}>
      {shown.message}{' '}
      {problem ? (
        <span className="field-saved">Not saved. {value ? <>The saved value is still <bdi>{value}</bdi>.</> : 'Nothing is saved here yet.'}</span>
      ) : (
        'The website leaves it out until it is corrected.'
      )}
    </span>
  );
  return (
    <Field label={label} hint={hint} error={error}>
      <DraftInput
        id={`page-structured-${fact}`}
        value={value}
        placeholder={placeholder}
        multiline={multiline}
        rows={multiline ? 4 : undefined}
        check={check}
        onProblem={setProblem}
        onDirty={setDirty}
        onCommit={(v) => {
          const c = checkFact(fact, v);
          if (!c.ok) return false;
          if (JSON.stringify(c.value) === JSON.stringify(fact === 'steps' ? (Array.isArray(stored.steps) ? stored.steps : []) : value)) return;
          return set({ [fact]: c.value } as StructuredDataPatch, `Change ${label.toLowerCase()}`);
        }}
      />
    </Field>
  );
}

/**
 * What the page is for search engines and AI answer engines (shared/page-structured-data.ts): a type, and the facts
 * that type states, shown only for it. The facts it still needs are said below them; until they are there, the
 * page's structured data says nothing of the entity, and the rest of it is written as before.
 */
export function StructuredDataFields({ page, upd }: { page: PageDoc; upd: Upd }) {
  const raw: unknown = page.seo && typeof page.seo === 'object' ? page.seo.structuredData : undefined;
  const found = inspectPageStructuredData(raw);
  const stored = isRecord(raw) ? raw : {};
  const { type } = found;
  // A type written by hand that can't be used is shown as such, so choosing Web page clears it.
  const unusable = found.issues.some((i) => i.field === 'type');
  const set = (patch: StructuredDataPatch, label: string) => upd({ structuredData: patch }, label);
  const facts = type === 'WebPage' ? [] : STRUCTURED_FACTS[type];
  const hasFacts = facts.some((k) => stored[k] !== undefined);
  const missing = found.issues.filter((i) => i.blocking && i.field !== 'type');
  const availability = typeof stored.availability === 'string' && (PRODUCT_AVAILABILITY as readonly string[]).includes(stored.availability) ? stored.availability : '';
  return (
    <>
      <Field
        label="Page type"
        error={unusable ? found.issues.find((i) => i.field === 'type')?.message : undefined}
        hint={
          type === 'WebPage'
            ? 'What search engines and AI answer engines are told the page is. Choose a service, product, event or how-to guide of your own to state its facts.'
            : `Search engines are told the page is ${typePhrase(type)}${facts.length ? ', named by the page title and described by its description' : ''}.${hasFacts ? ' Another type removes these details; Undo brings them back.' : ''}`
        }
      >
        <select
          id="page-structured-type"
          className="select"
          value={unusable ? '' : type}
          onChange={(e) => {
            const next = e.target.value;
            if (isPageStructuredType(next)) set({ type: next }, next === 'WebPage' ? 'Make page a plain web page' : `Mark page as ${typePhrase(next)}`);
          }}
        >
          {unusable && (
            <option value="" disabled>
              Can’t be used
            </option>
          )}
          {PAGE_STRUCTURED_TYPES.map((t) => (
            <option key={t} value={t}>
              {PAGE_STRUCTURED_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </Field>
      {facts.map((fact) =>
        fact === 'availability' ? (
          <Field key={fact} label="Availability" hint="Optional. Whether it can be had now.">
            <select id="page-structured-availability" className="select" value={availability} onChange={(e) => set({ availability: e.target.value }, 'Change availability')}>
              <option value="">Not said</option>
              {PRODUCT_AVAILABILITY.map((a) => (
                <option key={a} value={a}>
                  {PRODUCT_AVAILABILITY_LABELS[a]}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <FactField key={`${type}:${fact}`} fact={fact} stored={stored} set={set} />
        )
      )}
      {missing.length > 0 && (
        <p className="insp-note field-hint" role="status" data-structured-missing>
          Not in the page’s structured data yet. {missing.map((i) => i.message).join(' ')}
        </p>
      )}
    </>
  );
}
