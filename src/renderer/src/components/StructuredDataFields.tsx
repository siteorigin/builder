import './StructuredDataFields.css';
import { useRef, useState, type ReactNode } from 'react';
import { CircleCheck, CircleDashed } from 'lucide-react';
import type { PageDoc, PageStructuredType, ProductAvailability } from '@shared/types';
import {
  checkFact,
  CURRENCY_CODES,
  inspectPageStructuredData,
  isPageStructuredType,
  PAGE_STRUCTURED_TYPE_LABELS,
  PAGE_STRUCTURED_TYPES,
  PRODUCT_AVAILABILITY,
  PRODUCT_AVAILABILITY_LABELS,
  STRUCTURED_FACT_LABELS,
  STRUCTURED_FACTS,
  typePhrase,
  type StructuredDataPatch,
  type StructuredFact,
  type StructuredInspection,
  type StructuredIssue
} from '@shared/page-structured-data';
import { commitOps, getState, toast, undoAction, useStore } from '../store';
import { publicUrl } from '@shared/public-url';
import { isDraftPage } from '@generator/index';
import { pageUpdate } from '../lib/page-settings';
import { DraftInput, Field, RequiredMark, type DraftHandle, type DraftProblem } from './ui';

type Upd = (patch: Record<string, unknown>, label?: string) => unknown;
type SetFact = (patch: StructuredDataPatch, label: string) => unknown;
type TextFact = Exclude<StructuredFact, 'availability' | 'startDate' | 'endDate'>;

/** How each text fact is labelled and explained. Examples live in the hint, never in the field, where they would read as saved. */
const FACT_FIELDS: Record<TextFact, { label: string; hint?: string; multiline?: boolean; wrap?: boolean }> = {
  serviceType: { label: 'Service type', hint: 'What kind of service it is, such as Pottery classes.' },
  areaServed: { label: 'Area served', hint: 'Where it is offered, such as Cape Town.' },
  price: { label: 'Amount' },
  currency: { label: 'Currency' },
  offerUrl: { label: 'Where to buy it', hint: 'The address of the page it is sold on, when it is not this one.' },
  venue: { label: 'Venue' },
  address: { label: 'Address', hint: 'Street, town and postcode, as one line.', wrap: true },
  steps: { label: 'Steps', multiline: true }
};

/** What each needed fact is called in the line saying what is still missing ("Not included yet · add the price"). */
const NEEDS: Partial<Record<StructuredFact | 'type', string>> = {
  serviceType: 'the service type',
  price: 'the price',
  currency: 'the currency',
  startDate: 'when it starts',
  venue: 'a venue or an address',
  steps: 'at least one step'
};

/** The currencies most prices on these sites are in, offered first; the rest follow in order. */
const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'NZD', 'ZAR', 'INR', 'JPY', 'CHF', 'SGD'];
const currencyNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'currency' });
  } catch {
    return null;
  }
})();
/** A currency's English name, in sentence case ("South African rand"), or its code when there is none. */
function currencyName(code: string): string {
  const name = currencyNames?.of(code);
  if (!name || name === code) return code;
  // The last word is the unit ("Rand", "Dollar"), lower-cased as it reads in a sentence; place names stay capitalised.
  return name.replace(/(\s)(\S+)$/, (_m, s: string, w: string) => `${s}${w === w.toUpperCase() ? w : w.toLowerCase()}`);
}

/** A currency as the list offers it: its code first, which the closed control shows, then its name. */
const currencyOption = (code: string) => {
  const name = currencyName(code);
  return name === code ? code : `${code} — ${name}`;
};

/** Whether a pointer button is down: a blur it causes waits for its release before anything below moves. */
let pointerHeld = false;
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => (pointerHeld = true), true);
  window.addEventListener('pointerup', () => (pointerHeld = false), true);
}

/** The offsets from UTC offered for an event's times, besides the venue's local time and UTC itself. */
const OFFSETS = [
  '-12:00',
  '-11:00',
  '-10:00',
  '-09:30',
  '-09:00',
  '-08:00',
  '-07:00',
  '-06:00',
  '-05:00',
  '-04:00',
  '-03:30',
  '-03:00',
  '-02:00',
  '-01:00',
  '+01:00',
  '+02:00',
  '+03:00',
  '+03:30',
  '+04:00',
  '+04:30',
  '+05:00',
  '+05:30',
  '+05:45',
  '+06:00',
  '+06:30',
  '+07:00',
  '+08:00',
  '+08:45',
  '+09:00',
  '+09:30',
  '+10:00',
  '+10:30',
  '+11:00',
  '+12:00',
  '+12:45',
  '+13:00',
  '+14:00'
];
const offsetLabel = (o = '') => (o === '' ? 'local time' : o === 'Z' ? 'UTC' : `UTC${o.replace('-', '−')}`);

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/**
 * A stored fact as its field shows it: text, or anything else written by hand as JSON to correct. The steps show one
 * per line as the website reads them, each on its line; only their text, when the list holds something else too.
 */
function factText(fact: StructuredFact, v: unknown): string {
  if (fact === 'steps' && (Array.isArray(v) || typeof v === 'string')) {
    const lines = typeof v === 'string' ? v.split(/\r?\n/) : v.filter((x): x is string => typeof x === 'string');
    return lines
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  }
  return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
}

/** The currencies a sign or a marker beside an amount can stand for. A three-letter code stands for itself. */
const SIGNS: Record<string, string[]> = {
  R: ['ZAR'],
  $: ['USD', 'AUD', 'CAD', 'NZD', 'SGD', 'HKD', 'MXN'],
  US$: ['USD'],
  A$: ['AUD'],
  C$: ['CAD'],
  NZ$: ['NZD'],
  '€': ['EUR'],
  '£': ['GBP'],
  '¥': ['JPY', 'CNY'],
  '₹': ['INR']
};
const MARK = String.raw`US\$|A\$|C\$|NZ\$|[A-Za-z]{3}|[$€£¥₹]|R`;
const PRICED = new RegExp(String.raw`^(?:(${MARK})\s*)?([\d.,]+)(?:\s*(${MARK}))?$`);

/**
 * The price most likely meant by text that isn't one, offered for the author to choose, never saved unasked: one
 * currency sign or code before or after the amount ("R 349", "349 ZAR") left out when it agrees with the currency
 * chosen, a single decimal comma read as a point ("349,50"), and a bare decimal given its zero (".50"). Undefined when
 * it stays ambiguous ("1.234,50", "1,234", "-10"), names another currency than the one chosen, or still isn't a price.
 */
function suggestPrice(text: string, unit: string): string | undefined {
  const m = PRICED.exec(text.trim());
  if (!m || (m[1] && m[3])) return undefined;
  const mark = m[1] ?? m[3];
  if (mark) {
    const means = SIGNS[mark] ?? (CURRENCY_CODES.includes(mark.toUpperCase()) ? [mark.toUpperCase()] : []);
    if (!unit || !means.includes(unit)) return undefined;
  }
  let amount = m[2];
  if (/^\d*,\d{1,2}$/.test(amount)) amount = amount.replace(',', '.');
  if (/^\.\d+$/.test(amount)) amount = `0${amount}`;
  return amount !== text.trim() && checkFact('price', amount).ok ? amount : undefined;
}

/** A list in a sentence: "a, b and c". */

/** Whether a fact (for the location, the venue or the address) has something saved, usable or not. */
function written(stored: Record<string, unknown>, fact: StructuredFact | 'type'): boolean {
  const said = (v: unknown) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);
  return (fact === 'venue' ? ['venue', 'address'] : [fact]).some((k) => said(stored[k]));
}

/**
 * What still keeps the entity out of the page's structured data: facts to add (nothing saved), and facts to correct
 * (saved in a shape it can't use, or contradicting each other).
 */
function needs(stored: Record<string, unknown>, issues: StructuredIssue[]) {
  const blocking = issues.filter((i) => i.blocking && i.field !== 'type');
  const add = blocking.filter((i) => i.field !== 'endDate' && !written(stored, i.field));
  return { add, fix: blocking.filter((i) => !add.includes(i)) };
}

/** What the Structured data section's closed heading says: the page's type, and whether its facts are complete. */
export function structuredSummary(page: PageDoc): string {
  const raw: unknown = page.seo && typeof page.seo === 'object' ? page.seo.structuredData : undefined;
  const { type, issues, ready } = inspectPageStructuredData(raw);
  if (!ready && type === 'WebPage') return 'Needs a type';
  if (!ready && needs(isRecord(raw) ? raw : {}, issues).add.length) return `${PAGE_STRUCTURED_TYPE_LABELS[type]} · incomplete`;
  return `${PAGE_STRUCTURED_TYPE_LABELS[type]}${issues.length ? ' · check details' : ''}`;
}

/** Whether a page is still in the project as the type a fact belongs to: text kept for the fact goes with either. */
const factAlive = (pageId: string, type: PageStructuredType) => () => {
  const pages = getState().snapshot?.state.pages ?? {};
  if (!Object.hasOwn(pages, pageId)) return false;
  const seo = pages[pageId].seo;
  return inspectPageStructuredData(seo && typeof seo === 'object' ? seo.structuredData : undefined).type === type;
};

interface FactProps {
  pageId: string;
  type: PageStructuredType;
  fact: TextFact;
  stored: Record<string, unknown>;
  /** Why the saved value can't be used, when it can't. */
  saved?: string;
  set: SetFact;
}

/**
 * One text fact, checked as it is typed: text it can't take stays in the field as an unsaved draft, with the reason,
 * until it is corrected or discarded (Escape), kept for the page while its settings show elsewhere (#702). A saved value
 * that can't be used (written by hand) is pointed out the same way, with a one-step repair when there is one. It sends
 * only its own fact, so an edit landing after the page became another type is refused, never turning it back.
 * Returns the field's control and what to say under it, for a Field or a group to place.
 */
function useFact({ pageId, type, fact, stored, saved, set }: FactProps, ariaLabel?: string, opts: { unit?: string; describe?: boolean } = {}) {
  const { label, multiline, wrap } = FACT_FIELDS[fact];
  const value = factText(fact, stored[fact]);
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const handle = useRef<DraftHandle | null>(null);
  const check = (v: string): DraftProblem | null => {
    const c = checkFact(fact, v);
    if (c.ok) return null;
    const suggestion = fact === 'price' ? suggestPrice(v, opts.unit ?? '') : undefined;
    return suggestion
      ? {
          message: c.message,
          suggestion,
          fix: `Use ${suggestion}${opts.unit ? ` ${opts.unit}` : ''}`
        }
      : { message: c.message };
  };
  // What is wrong with the saved value (its check, or how the website reads it) describes the field only while it shows that value.
  const dirty = draft !== null;
  const shown = problem ?? (!dirty ? ((value ? check(value) : null) ?? (saved ? { message: saved } : null)) : null);
  // A saved value the website can't use, shown as text it can (a list holding something else beside its steps, a
  // number where text belongs): saving it as shown repairs it, which leaving the field unchanged would not.
  // A saved value that isn't text at all (a record written by hand): showing it as text and saving that would publish
  // its punctuation, so the repair clears it to be typed again, whatever its text would make of it.
  const raw = stored[fact];
  const shapeless = isRecord(raw) || (Array.isArray(raw) && fact !== 'steps');
  const repair = !problem && !dirty && !!saved && (shapeless || !(value && check(value)));
  /** A repair of the saved value, then the cursor back in the field, where the author carries on. */
  const repairWith = (text: string) => {
    void commit(text);
    requestAnimationFrame(() => document.getElementById(`page-structured-${fact}`)?.focus());
  };
  // The repair a price takes depends on the currency chosen now, which may have changed since the text was refused.
  const suggestion = fact === 'price' && shown ? suggestPrice(problem ? (draft ?? '') : value, opts.unit ?? '') : shown?.suggestion;
  const commit = (v: string) => {
    const c = checkFact(fact, v);
    if (!c.ok) return false;
    // Nothing to send when it would store what is stored; anything else (a value saved in another shape) is written.
    if (JSON.stringify(c.value) === JSON.stringify(Object.hasOwn(stored, fact) ? stored[fact] : fact === 'steps' ? [] : '')) return;
    return set({ [fact]: c.value } as StructuredDataPatch, `Change ${(fact === 'price' ? 'price' : label).toLowerCase()}`);
  };
  const fix = suggestion ? (
    <button type="button" className="link-btn field-fix" onClick={() => (problem ? handle.current?.commit(suggestion) : repairWith(suggestion))}>
      Use {suggestion}
      {opts.unit ? ` ${opts.unit}` : ''}
    </button>
  ) : repair && shapeless ? (
    <button type="button" className="link-btn field-fix" onClick={() => repairWith('')}>
      Clear it
    </button>
  ) : repair ? (
    <button type="button" className="link-btn field-fix" onClick={() => repairWith(value)}>
      {value ? 'Save as shown' : 'Clear it'}
    </button>
  ) : null;
  const error = shown && (
    <span role={problem ? 'alert' : undefined} id={opts.describe ? `page-structured-${fact}-error` : undefined}>
      {shapeless && !problem ? `The saved ${label.toLowerCase()} isn’t written as text. Clear it, then type it again.` : shown.message}{' '}
      {problem ? (
        <span className="field-saved">
          {value ? (
            <>
              Not saved: <bdi>{value}</bdi> is still saved. Esc puts it back.
            </>
          ) : (
            'Not saved. Esc clears it.'
          )}
        </span>
      ) : (
        'The website leaves it out until it is corrected.'
      )}
      {fix}
    </span>
  );
  const control = (
    <DraftInput
      id={`page-structured-${fact}`}
      value={value}
      multiline={multiline}
      wrap={wrap}
      className={wrap ? 'input sd-oneline' : undefined}
      rows={multiline ? 4 : undefined}
      ariaLabel={ariaLabel}
      // Marked here as well as by a Field around it, since a group's Field can't mark the controls inside it.
      aria-invalid={shown ? true : undefined}
      // Inside a group, whose Field describes the group: the control is described by its own problem too.
      aria-describedby={opts.describe && shown ? `page-structured-${fact}-error` : undefined}
      check={check}
      handle={handle}
      onProblem={setProblem}
      onDirty={(d, text) => setDraft(d ? text : null)}
      onCommit={commit}
      keep={`page:${pageId}:structured:${type}:${fact}`}
      keepWhile={factAlive(pageId, type)}
    />
  );
  return { control, error, text: draft ?? value };
}

/** A text fact as a field of its own, its requiredness in its label. */
function FactField(props: FactProps & { required?: boolean; hint?: ReactNode }) {
  const { label, hint } = FACT_FIELDS[props.fact];
  const { control, error, text } = useFact(props);
  // The steps say how many there are, so where a wrapped line ends and a new step starts can be checked.
  const count = props.fact === 'steps' ? text.split(/\r?\n/).filter((l) => l.trim()).length : 0;
  const shownHint = props.hint ?? (props.fact === 'steps' ? `One step per line, in the order they are done.${count ? ` ${count === 1 ? '1 step' : `${count} steps`}.` : ''}` : hint);
  return (
    <Field
      label={
        <>
          {label}
          {props.required && <RequiredMark />}
        </>
      }
      hint={shownHint}
      error={error}
    >
      {control}
    </Field>
  );
}

/** A product's price: its amount and its currency, one group, the currency chosen from the codes the website accepts. */
function PriceGroup(
  props: Omit<FactProps, 'fact' | 'saved'> & {
    currency?: string;
    savedPrice?: string;
    savedCurrency?: string;
  }
) {
  const { stored, set } = props;
  const amount = useFact({ ...props, fact: 'price', saved: props.savedPrice }, 'Amount', { unit: props.currency, describe: true });
  // As the website reads it ("zar" is ZAR); one saved that can't be used is shown as itself.
  const code = props.currency ?? '';
  const unusable = !!props.savedCurrency;
  const others = CURRENCY_CODES.filter((c) => !COMMON_CURRENCIES.includes(c));
  return (
    <div className="sd-price-field">
      <Field
        label={
          <>
            Price
            <RequiredMark />
          </>
        }
        hint={`${code ? `${currencyName(code)}. ` : ''}The amount on its own, such as 129.50, or 0 when it is free.`}
        error={amount.error || undefined}
      >
        <div className="sd-row sd-price">
          {amount.control}
          <select
            id="page-structured-currency"
            className="select"
            aria-label="Currency"
            aria-invalid={unusable ? true : undefined}
            aria-describedby={unusable ? 'page-structured-currency-error' : undefined}
            value={unusable ? ':saved' : code}
            onChange={(e) => e.target.value && !e.target.value.startsWith(':') && set({ currency: e.target.value }, 'Change currency')}
          >
            {unusable && (
              <option value=":saved" disabled>
                {factText('currency', stored.currency)}
              </option>
            )}
            {!unusable && !code && (
              <option value="" disabled>
                Currency
              </option>
            )}
            <optgroup label="Common">
              {COMMON_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {currencyOption(c)}
                </option>
              ))}
            </optgroup>
            <optgroup label="All currencies">
              {others.map((c) => (
                <option key={c} value={c}>
                  {currencyOption(c)}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
      </Field>
      {/* The currency's own problem, under the amount's: each starts with its glyph and describes its own control. */}
      {unusable && (
        <div className="field-error" id="page-structured-currency-error">
          The saved currency <bdi>“{factText('currency', stored.currency)}”</bdi> isn’t a currency code. Choose one from the list.
        </div>
      )}
    </div>
  );
}

/** A date or time as an event stores it, taken apart for its controls: empty when unsaid, null when they can't show it. */
function eventParts(v: unknown): { day: string; time: string; zone: string } | null {
  if (v === undefined || v === '') return { day: '', time: '', zone: '' };
  const m = typeof v === 'string' ? /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}:\d{2})?)?$/.exec(v) : null;
  return m ? { day: m[1], time: m[2] ?? '', zone: m[3] ?? '' } : null;
}
const joinEvent = (day: string, time: string, zone: string) => (day ? (time ? `${day}T${time}${zone}` : day) : '');
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An event's start or end as a date and an optional time, each in the app's own date and time controls. A time keeps
 * the time zone it was saved in; a new one takes the zone of the other end (see EventFields). An empty time leaves the
 * day alone: an all-day event, with no midnight made up. The time can be typed as soon as a date is, before it is saved.
 */
function EventDate(props: {
  pageId: string;
  fact: 'startDate' | 'endDate';
  raw: unknown;
  value?: string;
  problem?: string;
  zone: string;
  set: SetFact;
  required?: boolean;
  conflict?: { message: string; on: 'date' | 'time' };
  hint?: ReactNode;
}) {
  const { fact, raw, set, conflict } = props;
  const label = fact === 'startDate' ? 'Starts' : 'Ends';
  const noun = fact === 'startDate' ? 'start' : 'end';
  // Read as the website reads it ("2027-05-14 19:30" is 19:30 that day); one it can't use is said, not shown as empty.
  const parts = props.problem ? null : eventParts(props.value ?? '');
  const { day, time, zone: own } = parts ?? { day: '', time: '', zone: '' };
  const zone = time ? own : props.zone;
  const [dayDraft, setDayDraft] = useState<string | null>(null);
  // A time typed before there is a date to go with it: held as the field's unsaved draft, kept for the page while the
  // field is off screen and discarded by Escape like any other, and saved with the date once one is chosen.
  const [timeHeld, setTimeHeld] = useState(false);
  const [timeDraft, setTimeDraft] = useState<string | null>(null);
  const pendingTime = timeHeld && timeDraft ? timeDraft : null;
  const dateRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const timeRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const errorId = `page-structured-${fact}-error`;
  const currentDay = dayDraft !== null && DAY.test(dayDraft) ? dayDraft : day;
  const save = (nextDay: string, nextTime: string) => {
    const next = joinEvent(nextDay, nextTime, nextTime ? zone : '');
    if (next === (props.value ?? '')) return;
    return set({ [fact]: next } as StructuredDataPatch, `Change event ${noun}`);
  };
  // A saved value these controls can't show is said, and can be cleared, rather than shown as an empty date.
  const unreadable = !parts && (
    <span>
      The saved {noun} <bdi>“{factText(fact, raw)}”</bdi> isn’t a date. Choose the date again.
      <button type="button" className="link-btn field-fix" onClick={() => void set({ [fact]: '' } as StructuredDataPatch, `Clear event ${noun}`)}>
        Clear it
      </button>
    </span>
  );
  const waiting = pendingTime !== null && !currentDay;
  // Waiting for a date is not a mistake: it is said as guidance in place of the hint, never drawn as an error.
  const said = unreadable || conflict?.message;
  const error = said && <span id={errorId}>{said}</span>;
  const hint = waiting ? <span id={errorId}>Choose the date to go with {pendingTime}. The time is kept until then.</span> : props.hint;
  return (
    <Field
      label={
        <>
          {label}
          {props.required && <RequiredMark />}
        </>
      }
      hint={hint}
      error={error || undefined}
    >
      <div className="sd-row sd-when">
        <DraftInput
          id={`page-structured-${fact}`}
          type="date"
          inputRef={dateRef}
          ariaLabel={`${label}: date`}
          aria-invalid={unreadable || conflict?.on === 'date' ? true : undefined}
          aria-describedby={waiting || (said && (unreadable || conflict?.on === 'date')) ? errorId : undefined}
          value={day}
          onDirty={(d, text) => setDayDraft(d ? text : null)}
          onCommit={(v) => {
            setDayDraft(null);
            // A date part-way typed or part-way erased reads as empty: it changes nothing, rather than clearing the date.
            if ((dateRef.current as HTMLInputElement | null)?.validity.badInput) return;
            // The time typed and not saved yet (held while there was no date, or released once one was typed) goes with it:
            // saving the pair puts it in the project, which settles its draft.
            const withTime = timeDraft !== null && !(timeRef.current as HTMLInputElement | null)?.validity.badInput ? timeDraft : time;
            if (v === day && withTime === time) return;
            return v ? save(v, withTime) : save('', '');
          }}
        />
        <DraftInput
          id={`page-structured-${fact}-time`}
          type="time"
          ariaLabel={`${label}: time`}
          inputRef={timeRef}
          aria-invalid={conflict?.on === 'time' ? true : undefined}
          aria-describedby={waiting || (said && conflict?.on === 'time') ? errorId : undefined}
          value={time}
          check={(v) => (v && !currentDay ? { message: 'Choose the date first.' } : null)}
          onProblem={(p) => setTimeHeld(!!p)}
          onDirty={(d, text) => setTimeDraft(d ? text : null)}
          keep={`page:${props.pageId}:structured:Event:${fact}:time`}
          keepWhile={factAlive(props.pageId, 'Event')}
          onCommit={(v) => {
            // A time part-way typed or part-way erased reads as empty: it changes nothing, rather than clearing the time.
            if ((timeRef.current as HTMLInputElement | null)?.validity.badInput) return;
            if (!currentDay) return v ? false : undefined;
            if (v === time) return;
            return save(currentDay, v);
          }}
        />
      </div>
    </Field>
  );
}

/** How far a zone is from UTC, said in words: "2 hours ahead of UTC", "5 hours 30 minutes behind UTC". */
function offsetWords(o: string): string {
  if (o === 'Z' || o === '+00:00' || o === '-00:00') return 'Times are in UTC.';
  const [h, m] = o.slice(1).split(':').map(Number);
  const amount = `${h} hour${h === 1 ? '' : 's'}${m ? ` ${m} minutes` : ''}`;
  return `Times are ${amount} ${o[0] === '+' ? 'ahead of' : 'behind'} UTC.`;
}

/** An event's when and where: its start and end, the time zone their times are in, and its location. */
function EventFields(props: Omit<FactProps, 'fact' | 'saved'> & { found: StructuredInspection }) {
  const { stored, set, found } = props;
  const problem = (fact: StructuredFact) => found.issues.find((i) => i.field === fact && !i.blocking)?.message;
  const start = problem('startDate') ? null : eventParts(found.facts.startDate ?? '');
  const end = problem('endDate') ? null : eventParts(found.facts.endDate ?? '');
  const startZone = start?.time ? start.zone : undefined;
  const endZone = end?.time ? end.zone : undefined;
  const mixed = startZone !== undefined && endZone !== undefined && startZone !== endZone;
  const zone = mixed ? ':mixed' : (startZone ?? endZone ?? '');
  const conflict = found.issues.find((i) => i.field === 'endDate' && i.blocking);
  const changeZone = (next: string) => {
    const patch: StructuredDataPatch = {};
    if (start?.time) patch.startDate = joinEvent(start.day, start.time, next);
    if (end?.time) patch.endDate = joinEvent(end.day, end.time, next);
    if (Object.keys(patch).length) void set(patch, 'Change event time zone');
  };
  const venue = useFact({ ...props, fact: 'venue', saved: problem('venue') }, 'Venue');
  const address = useFact({ ...props, fact: 'address', saved: problem('address') }, 'Address');
  const saved = [startZone, endZone].filter((z): z is string => !!z && z !== 'Z' && !OFFSETS.includes(z));
  const zones = [...new Set([...saved, ...OFFSETS])];
  const zoneHint = mixed
    ? 'The start and the end have different UTC offsets. Choosing one applies it to both.'
    : zone
      ? `${offsetWords(zone)} Choose the venue’s local time to let search engines read it from the location.`
      : 'Search engines read the local time from the location. Choose a UTC offset if you know it.';
  return (
    <div className="sd-event">
      <div className="sd-group" role="group" aria-labelledby="page-structured-when">
        <div className="sd-group-head" id="page-structured-when">
          When
        </div>
        <EventDate pageId={props.pageId} fact="startDate" raw={stored.startDate} value={found.facts.startDate} problem={problem('startDate')} zone={endZone ?? ''} set={set} required hint="Leave the time empty for an all-day event." />
        <EventDate
          pageId={props.pageId}
          fact="endDate"
          raw={stored.endDate}
          value={found.facts.endDate}
          problem={problem('endDate')}
          zone={startZone ?? ''}
          set={set}
          conflict={
            conflict && {
              message: 'It ends before it starts. Change the end or the start.',
              on: start && end && start.day === end.day ? 'time' : 'date'
            }
          }
        />
        {(startZone !== undefined || endZone !== undefined) && (
          <Field label="Time zone" hint={zoneHint}>
            <select id="page-structured-zone" className="select" value={zone} onChange={(e) => !e.target.value.startsWith(':') && changeZone(e.target.value)}>
              {mixed && (
                <option value=":mixed" disabled>
                  {`Start ${offsetLabel(startZone)}, end ${offsetLabel(endZone)}`}
                </option>
              )}
              <option value="">The venue’s local time</option>
              <option value="Z">UTC</option>
              {zones.map((o) => (
                <option key={o} value={o}>
                  {offsetLabel(o)}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <div className="sd-group" role="group" aria-labelledby="page-structured-where">
        <div className="sd-group-head" id="page-structured-where">
          Where
          <RequiredMark />
        </div>
        <p className="field-hint sd-group-hint">A venue, an address, or both.</p>
        <Field label="Venue" error={venue.error}>
          {venue.control}
        </Field>
        <Field label="Address" hint="Street, town and postcode, as one line." error={address.error}>
          {address.control}
        </Field>
      </div>
    </div>
  );
}

/** What each fact is called when it is saved but needs correcting ("…correct the price"). */
const FIXES: Partial<Record<StructuredFact | 'type', string>> = {
  serviceType: 'the service type',
  price: 'the price',
  currency: 'the currency',
  startDate: 'the start',
  endDate: 'the end',
  venue: 'the venue or address',
  steps: 'the steps',
  areaServed: 'the area served',
  availability: 'the availability',
  offerUrl: 'where to buy it',
  address: 'the address'
};

/**
 * What the page is for search engines and AI answer engines (shared/page-structured-data.ts): a type, and the facts
 * that type states, shown only for it. Whether the page's structured data includes them yet, and what they still need,
 * is said under the type, where an author sent here from an SEO finding lands; until then the page's structured data
 * says nothing of the entity, and the rest of it is written as before.
 */
export function StructuredDataFields({ page, upd }: { page: PageDoc; upd: Upd }) {
  // What keeps complete details off the exported page, so "ready" never reads as "done": the page names nothing
  // without the site's public URL, and a page hidden from search engines carries no structured data.
  const noAddress = useStore((s) => !!s.snapshot && !publicUrl(s.snapshot.state.site));
  // A draft is left out of the export altogether, so nothing it says reaches search engines yet either.
  const draft = useStore((s) => !!s.snapshot && isDraftPage(s.snapshot.state, page));
  const held = draft ? 'Draft · left out of the export' : noAddress ? 'Needs the site’s public URL' : page.seo?.noindex ? 'Hidden from search engines' : null;
  const raw: unknown = page.seo && typeof page.seo === 'object' ? page.seo.structuredData : undefined;
  const found = inspectPageStructuredData(raw);
  const stored = isRecord(raw) ? raw : {};
  const { type } = found;
  // A type written by hand that can't be used is shown as itself, unavailable, so choosing any type replaces it.
  const unusable = found.issues.some((i) => i.field === 'type');
  const savedType = isRecord(raw) && typeof raw.type === 'string' ? raw.type : '';
  const set: SetFact = (patch, label) => upd({ structuredData: patch }, label);
  const facts = type === 'WebPage' ? [] : STRUCTURED_FACTS[type];
  // What another type would remove: this type's saved facts, or whatever was saved beside a type the editor doesn't know.
  const removes = unusable ? Object.keys(stored).some((k) => k !== 'type' && written(stored, k as StructuredFact)) : facts.some((k) => written(stored, k));
  const savedProblem = (fact: StructuredFact) => found.issues.find((i) => i.field === fact && !i.blocking)?.message;
  // As the website reads it; one saved that can't be used is shown as itself, so choosing Not stated clears it.
  const badAvailability = found.issues.find((i) => i.field === 'availability');
  const availability = badAvailability ? ':saved' : (found.facts.availability ?? '');
  // While the type is being chosen, what choosing another costs is said beside it; the change itself has Undo.
  const [choosing, setChoosing] = useState(false);
  const details = unusable ? `details saved with “${savedType}”` : `${PAGE_STRUCTURED_TYPE_LABELS[type].toLowerCase()} details`;

  /** Another type starts afresh: the details saved for this one go, said in a notice with Undo beside it. */
  const changeType = async (next: PageStructuredType) => {
    const label = next === 'WebPage' ? 'Make page a plain web page' : `Mark page as ${typePhrase(next)}`;
    if (!removes || (next === type && !unusable)) return void set({ type: next }, label);
    const u = pageUpdate(page, { structuredData: { type: next } }, label);
    const r = await commitOps(u.operations, u.label);
    if (r?.ok) toast(`Changed to ${PAGE_STRUCTURED_TYPE_LABELS[next]}. Removed the ${details}.`, 'info', undoAction(r));
  };

  const { add, fix } = needs(stored, found.issues);
  // Saved details the website leaves out while the rest are included.
  const left = [...new Set(found.issues.filter((i) => !i.blocking && i.field !== 'type').map((i) => FIXES[i.field] ?? STRUCTURED_FACT_LABELS[i.field as StructuredFact].toLowerCase()))];
  // How many details stand between the page and its structured data: each is marked at its own field below.
  const need = add.length + new Set(fix.map((i) => i.field)).size;
  const status: ReactNode =
    type === 'WebPage' ? null : !facts.length ? (
      (held ?? `Marked as the site’s ${type === 'AboutPage' ? 'about' : 'contact'} page`)
    ) : found.ready && held ? (
      // Complete, but the export can't carry them yet: what holds them back leads, then any saved detail it would leave out.
      <span className="sd-status" data-structured-ready data-structured-held>
        <CircleDashed aria-hidden="true" />
        <span>
          {held} · {details} ready
        </span>
      </span>
    ) : found.ready && left.length ? (
      // Included, but a detail saved beside them is left out: said with them, so the check never vouches for a red field.
      <span className="sd-status" data-structured-ready data-structured-partial>
        <CircleDashed aria-hidden="true" />
        <span>
          {details.charAt(0).toUpperCase() + details.slice(1)} included · {left.length} to correct below
        </span>
      </span>
    ) : found.ready ? (
      <span className="sd-status" data-structured-ready>
        <CircleCheck aria-hidden="true" />
        <span>{details.charAt(0).toUpperCase() + details.slice(1)} included</span>
      </span>
    ) : (
      <span className="sd-status" data-structured-missing>
        <CircleDashed aria-hidden="true" />
        <span>Not included yet · {add.length === 1 && !fix.length ? `add ${NEEDS[add[0].field] ?? add[0].message}` : need ? `${need} ${need === 1 ? 'detail' : 'details'} to add or correct below` : 'correct the details below'}</span>
      </span>
    );

  const common = { pageId: page.id, type, stored, set };
  return (
    <div className="sd-fields">
      <Field
        label="Page type"
        info="Tells search engines what the page is. Service, Product, Event and How-to guide add details such as a price or a date."
        hint={
          unusable ? undefined : choosing && removes ? (
            <>
              {status}
              <span className="sd-consequence">Another type removes the {details}. Undo brings them back.</span>
            </>
          ) : (
            status
          )
        }
        error={
          unusable ? (
            <>
              The saved type <bdi>“{savedType || '…'}”</bdi> isn’t one the editor supports. Choose a page type to replace it
              {removes ? '; that also removes the details saved with it, and Undo brings them back.' : '.'}
            </>
          ) : undefined
        }
      >
        <select
          id="page-structured-type"
          className="select"
          value={unusable ? ':saved' : type}
          // Shown when the author reaches for it (not when an SEO finding's link puts the cursor here), and taken away only
          // once a click that moved focus has finished, so the fields below never move under the pointer.
          onPointerDown={() => setChoosing(true)}
          onKeyDown={() => setChoosing(true)}
          onKeyUp={(e) => e.key === 'Tab' && setChoosing(true)}
          onBlur={() => (pointerHeld ? window.addEventListener('pointerup', () => setChoosing(false), { once: true }) : setChoosing(false))}
          onChange={(e) => {
            const next = e.target.value;
            if (isPageStructuredType(next)) void changeType(next);
          }}
        >
          {unusable && (
            <option value=":saved" disabled>
              {savedType || 'Unknown type'}
            </option>
          )}
          {PAGE_STRUCTURED_TYPES.map((t) => (
            <option key={t} value={t}>
              {PAGE_STRUCTURED_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </Field>
      {type === 'Service' && (
        <>
          <FactField key="Service:serviceType" {...common} fact="serviceType" saved={savedProblem('serviceType')} required />
          <FactField key="Service:areaServed" {...common} fact="areaServed" saved={savedProblem('areaServed')} />
        </>
      )}
      {type === 'Product' && (
        <>
          <PriceGroup key="Product:price" {...common} currency={found.facts.currency} savedPrice={savedProblem('price')} savedCurrency={savedProblem('currency')} />
          <Field
            label="Availability"
            hint="Whether people can buy it now."
            error={
              badAvailability && (
                <>
                  <bdi>“{factText('availability', stored.availability)}”</bdi> isn’t an availability. Choose one, or Not stated.
                </>
              )
            }
          >
            <select id="page-structured-availability" className="select" value={availability} onChange={(e) => !e.target.value.startsWith(':') && set({ availability: e.target.value as ProductAvailability | '' }, 'Change availability')}>
              {badAvailability && (
                <option value=":saved" disabled>
                  {factText('availability', stored.availability)}
                </option>
              )}
              <option value="">Not stated</option>
              {PRODUCT_AVAILABILITY.map((a) => (
                <option key={a} value={a}>
                  {PRODUCT_AVAILABILITY_LABELS[a]}
                </option>
              ))}
            </select>
          </Field>
          <FactField key="Product:offerUrl" {...common} fact="offerUrl" saved={savedProblem('offerUrl')} />
        </>
      )}
      {type === 'Event' && <EventFields key="Event" {...common} found={found} />}
      {type === 'HowTo' && <FactField key="HowTo:steps" {...common} fact="steps" saved={savedProblem('steps')} required />}
    </div>
  );
}
