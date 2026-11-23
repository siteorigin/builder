import { CircleCheck, CircleHelp, TriangleAlert } from 'lucide-react';
import { evaluatePairs, formatRatio, isFailing, pairsOf, suggestForeground, READABLE_TEXT_COLORS, type ContrastPair, type FailingPair, type ForegroundSuggestion, type PairResult } from '@shared/contrast';
import type { TokenDef } from '@shared/types';
import { resolveCssColor } from '../lib/color';

/** The colour pairs a theme declares, read against the project's current colours. */
export interface ContrastModel {
  tokens: TokenDef[];
  pairs: ContrastPair[];
  results: PairResult[];
}

export function buildContrastModel(tokens: TokenDef[], pairs: readonly ContrastPair[] = []): ContrastModel {
  return { tokens, pairs: [...pairs], results: evaluatePairs(tokens, pairs, resolveCssColor) };
}

/** Pairs the Basics preview shows, when the theme declares them: the button at rest and on hover, and brand-coloured text on the page. */
export const BASICS_PAIR_IDS = ['button', 'button-hover', 'brand-text-background'];

const CHOICE_NAMES: Record<string, string> = { [READABLE_TEXT_COLORS[0]]: 'white', [READABLE_TEXT_COLORS[1]]: 'dark ink', [READABLE_TEXT_COLORS[2]]: 'black' };

const refOf = (v: unknown) => (v && typeof v === 'object' && 'token' in (v as object) ? String((v as { token: string }).token) : null);
const labelOf = (model: ContrastModel, id: string) => model.tokens.find((t) => t.id === id)?.label ?? id;
const bgTokens = (p: ContrastPair) => (typeof p.bg === 'string' ? [p.bg] : [p.bg.mix[0], p.bg.mix[2]]);

/** Results that fail, for a token as either colour of the pair. */
export function failingFor(model: ContrastModel, tokenId: string): FailingPair[] {
  const ids = new Set(pairsOf(model.pairs, tokenId).map((p) => p.id));
  return model.results.filter(isFailing).filter((r) => ids.has(r.pair.id));
}

/** What a polite status region says when the set of unreadable pairs changes. */
export const failingKey = (model: ContrastModel) =>
  model.results
    .filter(isFailing)
    .map((r) => r.pair.use)
    .join('|');

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

/** What choosing the suggestion leaves unreadable (a hover colour), and which colour to change for it. */
function consequence(model: ContrastModel, s: ForegroundSuggestion): string | null {
  const left = s.after.filter(isFailing);
  if (s.everyState || !left.length) return null;
  const names = [...new Set(left.flatMap((r) => bgTokens(r.pair)).filter((id) => id !== s.token))].map((id) => labelOf(model, id));
  const reads = left.map((r) => `${r.pair.use.charAt(0).toLowerCase()}${r.pair.use.slice(1)} would read ${formatRatio(r.ratio)}:1`).join(' and ');
  return `${reads.charAt(0).toUpperCase()}${reads.slice(1)}. No single color reads everywhere, so change ${names.join(' or ')} to fix that too.`;
}

/** For a pair no text color fixes on its own (a hover state, once the resting state is readable): which color to change instead. */
function changeInstead(model: ContrastModel, r: FailingPair, offered: boolean): string | null {
  if (offered || r.pair.fixable === false) return null;
  const names = bgTokens(r.pair).filter((id) => id !== r.pair.fg).map((id) => labelOf(model, id));
  return `${r.pair.state === 'hover' ? 'The text color that reads on the button does not read on its hover color' : 'No text color reads here'}. Change ${names.join(' or ')} to fix ${r.pair.state === 'hover' ? 'it' : 'this'}.`;
}

/** The offer to use a readable foreground: names the token and the color, and what it would leave. */
function UseSuggestion({ model, s, onUse }: { model: ContrastModel; s: ForegroundSuggestion; onUse: (s: ForegroundSuggestion) => void }) {
  const target = model.tokens.find((t) => t.id === s.token);
  const follows = target ? refOf(target.value) : null;
  const note = consequence(model, s);
  return (
    <div className="ss-contrast-fix">
      <button className="btn btn-sm" onClick={() => onUse(s)} title={`${s.value}${follows ? `. ${target?.label} stops following ${labelOf(model, follows)}.` : ''}`}>
        <span className="ss-chip" style={{ background: s.value }} aria-hidden="true" />
        Use {CHOICE_NAMES[s.value] ?? s.value} for {target?.label ?? s.token}
      </button>
      {follows && <span className="ss-contrast-note">{target?.label} gets its own color; it stops following {labelOf(model, follows)}.</span>}
      {note && <span className="ss-contrast-note">{note}</span>}
    </div>
  );
}

/** Unreadable pairs a token belongs to, under its row in Colors, with an offer for each foreground that can be fixed. */
export function ContrastFlags({ model, tokenId, onUse }: { model: ContrastModel; tokenId: string; onUse: (s: ForegroundSuggestion) => void }) {
  const failing = failingFor(model, tokenId);
  if (!failing.length) return null;
  const offers = new Map<string, ForegroundSuggestion>();
  // One line per thing that is unreadable (a button, text on three grounds): its worst case, and how many others are low too.
  const worst = new Map<string, { r: FailingPair; others: number }>();
  for (const r of failing) {
    const s = suggestForeground(model.tokens, model.pairs, r, resolveCssColor);
    if (s && !offers.has(`${s.token}:${s.value}`)) offers.set(`${s.token}:${s.value}`, s);
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
      {[...offers.values()].map((s) => (
        <UseSuggestion key={`${s.token}:${s.value}`} model={model} s={s} onUse={onUse} />
      ))}
      {failing.map((r) => {
        const note = changeInstead(model, r, !!suggestForeground(model.tokens, model.pairs, r, resolveCssColor));
        return note && <p key={r.pair.id} className="ss-contrast-note">{note}</p>;
      })}
    </div>
  );
}

/** Every pair a token belongs to, with its sample and ratio, for the row's details. */
export function ContrastDetail({ model, tokenId }: { model: ContrastModel; tokenId: string }) {
  const ids = new Set(pairsOf(model.pairs, tokenId).map((p) => p.id));
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
export function BrandContrast({ model, onUse }: { model: ContrastModel; onUse: (s: ForegroundSuggestion) => void }) {
  const rows = BASICS_PAIR_IDS.map((id) => model.results.find((r) => r.pair.id === id)).filter((r): r is PairResult => !!r);
  if (!rows.length) return null;
  const offers = new Map<string, ForegroundSuggestion>();
  for (const r of rows) {
    const s = isFailing(r) ? suggestForeground(model.tokens, model.pairs, r, resolveCssColor) : null;
    if (s && !offers.has(`${s.token}:${s.value}`)) offers.set(`${s.token}:${s.value}`, s);
  }
  const brandText = rows.find((r) => r.pair.fg === 'color.brand');
  return (
    <div className="ss-contrast" role="group" aria-label="Brand color contrast">
      <ul className="ss-pairs">
        {rows.map((r) => (
          <PairRow key={r.pair.id} r={r} />
        ))}
      </ul>
      {[...offers.values()].map((s) => (
        <UseSuggestion key={`${s.token}:${s.value}`} model={model} s={s} onUse={onUse} />
      ))}
      {rows.filter(isFailing).map((r) => {
        const note = changeInstead(model, r, !!suggestForeground(model.tokens, model.pairs, r, resolveCssColor));
        return note && <p key={r.pair.id} className="ss-contrast-note">{note}</p>;
      })}
      {brandText?.status === 'fail' && <p className="ss-contrast-note">Links and text buttons in the brand color are hard to read on the page. A darker brand color keeps them readable.</p>}
    </div>
  );
}
