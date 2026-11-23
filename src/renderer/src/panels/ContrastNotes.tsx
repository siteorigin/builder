import { useEffect, useId, useState } from 'react';
import { CircleCheck, CircleHelp, TriangleAlert } from 'lucide-react';
import { evaluatePairs, formatRatio, isFailing, pairsOf, suggestForeground, READABLE_TEXT_COLORS, type ContrastPair, type FailingPair, type ForegroundSuggestion, type PairResult } from '@shared/contrast';
import type { TokenDef } from '@shared/types';
import { resolveCssColor } from '../lib/color';
import { useTransitionAnnouncement } from '../lib/announce';

/** The colour pairs a theme declares, read against the project's current colours, with what to offer for each that fails. */
export interface ContrastModel {
  tokens: TokenDef[];
  pairs: ContrastPair[];
  results: PairResult[];
  offers: Map<string, ForegroundSuggestion | null>;
}

export function buildContrastModel(tokens: TokenDef[], pairs: readonly ContrastPair[] = []): ContrastModel {
  const results = evaluatePairs(tokens, pairs, resolveCssColor);
  const offers = new Map(results.filter(isFailing).map((r) => [r.pair.id, suggestForeground(tokens, pairs, r, resolveCssColor)] as const));
  return { tokens, pairs: [...pairs], results, offers };
}

/** Takes a suggested colour; the button it came from is passed so focus can be put back when it goes. */
export type UseSuggestionHandler = (s: ForegroundSuggestion, trigger: HTMLElement) => void;

/** Pairs the Basics preview shows, when the theme declares them: the button at rest and on hover, and brand-coloured text on the page. */
export const BASICS_PAIR_IDS = ['button', 'button-hover', 'brand-text-background'];

const CHOICE_NAMES: Record<string, string> = { [READABLE_TEXT_COLORS[0]]: 'white', [READABLE_TEXT_COLORS[1]]: 'dark ink', [READABLE_TEXT_COLORS[2]]: 'black' };

const refOf = (v: unknown) => (v && typeof v === 'object' && 'token' in (v as object) ? String((v as { token: string }).token) : null);
const labelOf = (model: ContrastModel, id: string) => model.tokens.find((t) => t.id === id)?.label ?? id;
const bgTokens = (p: ContrastPair) => (typeof p.bg === 'string' ? [p.bg] : [p.bg.mix[0], p.bg.mix[2]]);
const lowerFirst = (s: string) => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;
const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** Results that fail, for a token as either colour of a pair, or because a colour that follows it does. */
export function failingFor(model: ContrastModel, tokenId: string): FailingPair[] {
  const ids = new Set(pairsOf(model.pairs, tokenId, model.tokens).map((p) => p.id));
  return model.results.filter(isFailing).filter((r) => ids.has(r.pair.id));
}

/** The unreadable pairs by name, then whether any pair could not be checked: what the status region follows. */
export const contrastKey = (model: ContrastModel) => `${model.results.filter(isFailing).map((r) => r.pair.use).join('|')}\n${model.results.some((r) => r.status === 'unknown') ? 'unknown' : ''}`;

/** What a polite status region says when the unreadable pairs change; nothing is claimed readable while some cannot be checked. */
export function sayContrast(_prev: string, next: string): string | null {
  const [failing, unknown] = next.split('\n');
  if (failing) return `Low contrast: ${failing.split('|').join(', ')}`;
  return unknown ? '' : 'Colors are readable again';
}

/** The status text, announced once the colours have stopped changing, so a picker drag across a threshold does not chatter. */
export function useContrastStatus(model: ContrastModel): string {
  const key = contrastKey(model);
  const [settled, setSettled] = useState(key);
  useEffect(() => {
    const t = setTimeout(() => setSettled(key), 700);
    return () => clearTimeout(t);
  }, [key]);
  return useTransitionAnnouncement(settled, sayContrast);
}

/** The ratio and verdict in words and an icon, so it never rests on colour alone. */
function Verdict({ r }: { r: PairResult }) {
  if (r.status === 'unknown')
    return (
      <span className="ss-verdict unknown">
        <CircleHelp aria-hidden="true" />
        Can’t be checked
      </span>
    );
  const pass = r.status === 'pass';
  return (
    <span className={`ss-verdict ${r.status}`}>
      {pass ? <CircleCheck aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
      <span className="mono">{formatRatio(r.ratio)}:1</span>
      <span>{pass ? 'Readable' : `Low contrast, needs ${r.min}:1`}</span>
    </span>
  );
}

/** The two colours of a pair as the site shows them. Not shown when one of them cannot be known. */
function Sample({ r, label }: { r: PairResult; label: string }) {
  if (r.status === 'unknown') return <span className="ss-sample none" aria-hidden="true" />;
  return (
    <span className="ss-sample" style={{ background: r.bg, color: r.fg }} aria-hidden="true">
      {label}
    </span>
  );
}

const sampleLabel = (p: ContrastPair) => (p.fg === 'color.brand' || /link/i.test(p.use) ? 'Link text' : /button/i.test(p.use) ? 'Button' : 'Sample text');

/** One pair as a row: what it colours, a sample in its colours, and how readable it is. */
function PairRow({ r }: { r: PairResult }) {
  return (
    <li className={`ss-pair ${r.status}`}>
      <span className="ss-pair-use">{r.pair.use}</span>
      <Sample r={r} label={sampleLabel(r.pair)} />
      <Verdict r={r} />
    </li>
  );
}

/** What choosing the suggestion would leave hard to read (a hover colour, a light button on the same colour), and what to change for it. */
function consequence(model: ContrastModel, s: ForegroundSuggestion): string | null {
  const left = [...s.breaks, ...s.after.filter(isFailing)].filter((r, i, all) => all.findIndex((o) => o.pair.id === r.pair.id) === i);
  if (!left.length) return null;
  const names = [...new Set(left.flatMap((r) => (r.pair.fixable === false ? [r.pair.fg] : bgTokens(r.pair))).filter((id) => id !== s.token))].map((id) => labelOf(model, id));
  const reads = list(left.map((r) => `${lowerFirst(r.pair.use)} (${formatRatio(r.ratio)}:1)`));
  return `Choosing it leaves ${reads} hard to read.${names.length ? ` Change ${list(names)} to fix ${left.length > 1 ? 'those' : 'that'} too.` : ''}`;
}

/** For a pair no text color fixes on its own (a hover state, text on several grounds): which color to change instead. */
function changeInstead(model: ContrastModel, r: FailingPair): string | null {
  if (r.pair.fixable === false || model.offers.get(r.pair.id)) return null;
  const names = bgTokens(r.pair).filter((id) => id !== r.pair.fg).map((id) => labelOf(model, id));
  return `${r.pair.state === 'hover' ? 'The text color that reads on the button does not read on its hover color.' : 'No single text color reads on every ground.'} Change ${list(names)} to fix ${r.pair.state === 'hover' ? 'it' : 'this'}.`;
}

/** The offer to use a readable foreground: names the token and the color, and what it would leave. */
function UseSuggestion({ model, s, onUse }: { model: ContrastModel; s: ForegroundSuggestion; onUse: UseSuggestionHandler }) {
  const id = useId();
  const target = model.tokens.find((t) => t.id === s.token);
  const follows = target ? refOf(target.value) : null;
  const note = consequence(model, s);
  return (
    <div className="ss-contrast-fix">
      <button className="btn btn-sm" aria-describedby={follows || note ? `${id}-note` : undefined} onClick={(e) => onUse(s, e.currentTarget)} title={s.value}>
        <span className="ss-chip" style={{ background: s.value }} aria-hidden="true" />
        Use {CHOICE_NAMES[s.value] ?? s.value} for {target?.label ?? s.token}
      </button>
      {(follows || note) && (
        <span className="ss-contrast-note" id={`${id}-note`}>
          {follows && `${target?.label} gets its own color; it stops following ${labelOf(model, follows)}. `}
          {note}
        </span>
      )}
    </div>
  );
}

/** One offer per distinct suggestion among these results. */
function offersFor(model: ContrastModel, results: PairResult[]): ForegroundSuggestion[] {
  const out = new Map<string, ForegroundSuggestion>();
  for (const r of results) {
    const s = model.offers.get(r.pair.id);
    if (s && !out.has(`${s.token}:${s.value}`)) out.set(`${s.token}:${s.value}`, s);
  }
  return [...out.values()];
}

/** Unreadable pairs a token belongs to, under its row in Colors, with an offer for each foreground that can be fixed. */
export function ContrastFlags({ model, tokenId, onUse }: { model: ContrastModel; tokenId: string; onUse: UseSuggestionHandler }) {
  const failing = failingFor(model, tokenId);
  if (!failing.length) return null;
  // One line per thing that is unreadable (a button, text on three grounds): its worst case, and how many others are low too.
  const worst = new Map<string, { r: FailingPair; others: number }>();
  for (const r of failing) {
    const seen = worst.get(r.pair.group);
    worst.set(r.pair.group, { r: !seen || r.ratio < seen.r.ratio ? r : seen.r, others: seen ? seen.others + 1 : 0 });
  }
  return (
    <div className="ss-contrast-flags">
      <ul className="ss-pairs">
        {[...worst.values()].map(({ r, others }) => (
          <li key={r.pair.group} className="ss-flag">
            <TriangleAlert aria-hidden="true" />
            <span>
              {r.pair.use} is hard to read: <span className="mono">{formatRatio(r.ratio)}:1</span>, needs {r.min}:1.
              {others > 0 && ` Also low in ${others} other ${others === 1 ? 'place' : 'places'}.`}
            </span>
          </li>
        ))}
      </ul>
      {offersFor(model, failing).map((s) => (
        <UseSuggestion key={`${s.token}:${s.value}`} model={model} s={s} onUse={onUse} />
      ))}
      {failing.map((r) => {
        const note = changeInstead(model, r);
        return note && <p key={r.pair.id} className="ss-contrast-note">{note}</p>;
      })}
    </div>
  );
}

/** Every pair a token belongs to, with its sample and ratio, for the row's details. */
export function ContrastDetail({ model, tokenId }: { model: ContrastModel; tokenId: string }) {
  const ids = new Set(pairsOf(model.pairs, tokenId, model.tokens).map((p) => p.id));
  const rows = model.results.filter((r) => ids.has(r.pair.id));
  if (!rows.length) return null;
  return (
    <div className="ss-contrast-block">
      <div className="ss-detail-label">Contrast where it is used</div>
      <ul className="ss-pairs">
        {rows.map((r) => (
          <PairRow key={r.pair.id} r={r} />
        ))}
      </ul>
    </div>
  );
}

/**
 * Under the Brand shortcut in Basics: the button in its colours at rest and on hover, and brand-coloured text on the
 * page, each with its ratio, so an unreadable choice shows where it is made, with an offer for a readable text colour.
 */
export function BrandContrast({ model, onUse }: { model: ContrastModel; onUse: UseSuggestionHandler }) {
  const rows = BASICS_PAIR_IDS.map((id) => model.results.find((r) => r.pair.id === id)).filter((r): r is PairResult => !!r);
  if (!rows.length) return null;
  const brandText = rows.find((r) => r.pair.fg === 'color.brand');
  return (
    <div className="ss-contrast" role="group" aria-label="Brand color contrast">
      <ul className="ss-pairs">
        {rows.map((r) => (
          <PairRow key={r.pair.id} r={r} />
        ))}
      </ul>
      {offersFor(model, rows).map((s) => (
        <UseSuggestion key={`${s.token}:${s.value}`} model={model} s={s} onUse={onUse} />
      ))}
      {rows.filter(isFailing).map((r) => {
        const note = changeInstead(model, r);
        return note && <p key={r.pair.id} className="ss-contrast-note">{note}</p>;
      })}
      {brandText?.status === 'fail' && <p className="ss-contrast-note">Links and text buttons in the brand color are hard to read on the page. A brand color further from the page background keeps them readable.</p>}
    </div>
  );
}
