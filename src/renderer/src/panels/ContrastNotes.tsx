import { useEffect, useId, useState } from 'react';
import { CircleCheck, CircleHelp, TriangleAlert } from 'lucide-react';
import { evaluatePairs, formatRatio, isFailing, pairsOf, relativeLuminance, suggestForeground, READABLE_TEXT_COLORS, type ContrastPair, type FailingPair, type ForegroundSuggestion, type PairResult } from '@shared/contrast';
import type { TokenDef } from '@shared/types';
import { resolveCssColor } from '../lib/color';
import { sayContrast, useTransitionAnnouncement } from '../lib/announce';

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
      <span className="ss-ratio">{formatRatio(r.ratio)}:1</span>
      <span>{pass ? 'Readable' : `Low contrast, needs ${r.min}:1`}</span>
    </span>
  );
}

/** "is" or "are" for a pair's use, by its subject: "Button text on hover is", "Brand-colored links on cards are". */
const verbFor = (use: string) => (/s$/i.test(use.split(/\s(?:on|in|over)\s/)[0].trim().split(/\s+/).pop() ?? '') ? 'are' : 'is');

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

/** Opens a colour's row in Colors, so a note that names a colour to change is also the way to it. */
export type JumpToColor = (tokenId: string) => void;

/** Colours named in a note, each a jump to its row when a jump is given; the text reads the same either way. */
function Names({ model, ids, onJump }: { model: ContrastModel; ids: string[]; onJump?: JumpToColor }) {
  return (
    <>
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 && (i === ids.length - 1 ? ' and ' : ', ')}
          {onJump ? (
            <button type="button" className="link-btn ss-jump" onClick={() => onJump(id)}>
              {labelOf(model, id)}
            </button>
          ) : (
            labelOf(model, id)
          )}
        </span>
      ))}
    </>
  );
}

/** What choosing the suggestion would leave hard to read (a hover colour, a light button on the same colour), and what to change for it. */
function Consequence({ model, s, onJump }: { model: ContrastModel; s: ForegroundSuggestion; onJump?: JumpToColor }) {
  const left = [...s.breaks, ...s.after.filter(isFailing)].filter((r, i, all) => all.findIndex((o) => o.pair.id === r.pair.id) === i);
  if (!left.length) return null;
  const ids = [...new Set(left.flatMap((r) => (r.pair.fixable === false ? [r.pair.fg] : bgTokens(r.pair))).filter((id) => id !== s.token))];
  const reads = list(left.map((r) => `${lowerFirst(r.pair.use)} (${formatRatio(r.ratio)}:1)`));
  return (
    <>
      Choosing it leaves {reads} hard to read.
      {ids.length > 0 && (
        <>
          {' '}
          Change <Names model={model} ids={ids} onJump={onJump} /> to fix {left.length > 1 ? 'those' : 'that'} too.
        </>
      )}
    </>
  );
}

const hasConsequence = (s: ForegroundSuggestion) => s.breaks.length > 0 || s.after.some(isFailing);

/** The trade in one line, read before the button: "Fixes button text, but breaks three that read today." */
function tradeOf(model: ContrastModel, s: ForegroundSuggestion): string {
  const fixes = fixedBy(model, s).trim();
  const costs = s.breaks.length;
  if (!costs) return fixes;
  const count = ['', 'one', 'two', 'three', 'four', 'five'][costs] ?? String(costs);
  const breaks = `breaks ${count} that ${costs === 1 ? 'reads' : 'read'} today.`;
  return fixes ? `${fixes.replace(/\.$/, '')}, but ${breaks}` : `It ${breaks}`;
}

/** What taking the offer makes readable, said first so its cost reads as a trade: "Fixes button text." */
function fixedBy(model: ContrastModel, s: ForegroundSuggestion): string {
  const was = new Map(model.results.map((r) => [r.pair.id, r.status]));
  const uses = s.after.filter((r) => r.status === 'pass' && was.get(r.pair.id) === 'fail').map((r) => lowerFirst(r.pair.use));
  return uses.length ? `Fixes ${list(uses)}. ` : '';
}

/** For a pair no text color fixes on its own (a hover state, text on several grounds): which color to change instead. */
function ChangeInstead({ model, r, onJump, self }: { model: ContrastModel; r: FailingPair; onJump?: JumpToColor; self?: string }) {
  if (r.pair.fixable === false || model.offers.get(r.pair.id)) return null;
  const ids = bgTokens(r.pair).filter((id) => id !== r.pair.fg);
  // On the row of the colour to change, the note says "this color" rather than linking the row to itself.
  const others = ids.filter((id) => id !== self);
  return (
    <p className="ss-contrast-note">
      {r.pair.state === 'hover' ? 'The text color that reads on the button does not read on its hover color.' : 'No single text color reads on every ground.'} Change{' '}
      {others.length ? <Names model={model} ids={others} onJump={onJump} /> : 'this color'} to fix {r.pair.state === 'hover' ? 'it' : 'this'}.
    </p>
  );
}

/** The failing pairs whose "change instead" advice differs: a button's rest and light-button hover both say "change Brand (strong)". */
const distinctAdvice = (results: FailingPair[]) => results.filter((r, i) => results.findIndex((o) => o.pair.state === r.pair.state && bgTokens(o.pair).join() === bgTokens(r.pair).join()) === i);

/** The offer to use a readable foreground: names the token and the color, and what it would leave. */
function UseSuggestion({ model, s, onUse, onJump }: { model: ContrastModel; s: ForegroundSuggestion; onUse: UseSuggestionHandler; onJump?: JumpToColor }) {
  const id = useId();
  const target = model.tokens.find((t) => t.id === s.token);
  const follows = target ? refOf(target.value) : null;
  const note = hasConsequence(s);
  const trade = tradeOf(model, s);
  // The button previews its own result: the suggested text colour on the ground it was failing on.
  const fixed = s.after.find((r) => r.pair.fg === s.token && r.status === 'pass');
  const described = [trade && `${id}-trade`, (follows || note) && `${id}-note`].filter(Boolean).join(' ');
  return (
    <div className="ss-contrast-fix">
      {/* The trade comes before the button, so its cost is read before it is pressed. */}
      {trade && (
        <p className="ss-contrast-trade" id={`${id}-trade`}>
          {trade}
        </p>
      )}
      <button className="btn btn-sm" aria-describedby={described || undefined} onClick={(e) => onUse(s, e.currentTarget)} title={s.value}>
        {fixed && fixed.status === 'pass' ? (
          <span className="ss-ink" style={{ background: fixed.bg, color: fixed.fg }} aria-hidden="true">
            Aa
          </span>
        ) : (
          <span className="ss-chip" style={{ background: s.value }} aria-hidden="true" />
        )}
        Use {CHOICE_NAMES[s.value] ?? s.value} for {target?.label ?? s.token}
      </button>
      {(follows || note) && (
        <span className="ss-contrast-note" id={`${id}-note`}>
          {follows && `${target?.label} gets its own color; it stops following ${labelOf(model, follows)}. `}
          {note && <Consequence model={model} s={s} onJump={onJump} />}
        </span>
      )}
    </div>
  );
}

/**
 * Which way a colour that is unreadable as text must move, and the ground that decides it. Darker text has to reach
 * the target against the darkest ground it sits on, lighter text against the lightest; a direction is offered only
 * when some colour can reach it there, and the nearer one when both can. When neither can, no single colour reads
 * on every ground, and the grounds that pull apart are named instead.
 */
type Way = { direction: 'darker' | 'lighter'; ground: string; partial: boolean } | { apart: [string, string] } | null;
function directionFor(model: ContrastModel, group: string): Way {
  const inGroup = model.results.filter((r) => r.pair.group === group);
  const measured = inGroup.filter((r): r is Exclude<PairResult, { status: 'unknown' }> => r.status !== 'unknown');
  const lum = (css: string) => {
    const c = resolveCssColor(css);
    return c ? relativeLuminance(c) : null;
  };
  const grounds = measured.flatMap((r) => {
    const l = lum(r.bg);
    return l === null ? [] : [{ r, l, use: r.pair.use.replace(/^.*?\s(?:on|in)\s/, '') }];
  });
  if (!grounds.length) return null;
  const min = Math.max(...grounds.map((g) => g.r.min));
  const darkest = grounds.reduce((a, b) => (b.l < a.l ? b : a));
  const lightest = grounds.reduce((a, b) => (b.l > a.l ? b : a));
  // Darkest text colour allowed against the darkest ground, lightest allowed against the lightest.
  const darkerCeiling = (darkest.l + 0.05) / min - 0.05;
  const lighterFloor = min * (lightest.l + 0.05) - 0.05;
  const canDarker = darkerCeiling >= 0;
  const canLighter = lighterFloor <= 1;
  if (!canDarker && !canLighter) return { apart: [lightest.use, darkest.use] };
  const now = lum(measured[0]?.fg ?? '') ?? 0.5;
  const darker = canDarker && (!canLighter || Math.max(0, now - darkerCeiling) <= Math.max(0, lighterFloor - now));
  return { direction: darker ? 'darker' : 'lighter', ground: darker ? darkest.use : lightest.use, partial: measured.length < inGroup.length };
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
export function ContrastFlags({ model, tokenId, onUse, onJump, onShowAll, showAllControls }: { model: ContrastModel; tokenId: string; onUse: UseSuggestionHandler; onJump?: JumpToColor; onShowAll?: () => void; showAllControls?: string }) {
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
              {r.pair.use} {verbFor(r.pair.use)} hard to read: <span className="ss-ratio">{formatRatio(r.ratio)}:1</span>, needs {r.min}:1.
              {others > 0 && ` Also low in ${others} other ${others === 1 ? 'place' : 'places'}.`}
              {others > 0 && onShowAll && (
                <>
                  {' '}
                  <button type="button" className="link-btn ss-jump" aria-expanded={false} aria-controls={showAllControls} onClick={onShowAll}>
                    Show all
                    <span className="sr-only"> contrast for this color</span>
                  </button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      {/* An offer lives on the row of the colour it sets; another colour's row points there rather than repeating it. */}
      {offersFor(model, failing).map((s) =>
        s.token === tokenId || !onJump ? (
          <UseSuggestion key={`${s.token}:${s.value}`} model={model} s={s} onUse={onUse} onJump={onJump} />
        ) : (
          <p key={`${s.token}:${s.value}`} className="ss-contrast-note">
            {fixedBy(model, s) ? `A fix for ${fixedBy(model, s).replace(/^Fixes |\. $/g, '')} is offered on ` : 'A readable text color is offered on '}
            <Names model={model} ids={[s.token]} onJump={onJump} />.
          </p>
        )
      )}
      {distinctAdvice(failing).map((r) => (
        <ChangeInstead key={r.pair.id} model={model} r={r} onJump={onJump} self={tokenId} />
      ))}
      {/* Text no other colour can fix (brand-coloured links): which way to move it, or which colour to change. */}
      {[...new Set(failing.filter((r) => r.pair.fixable === false).map((r) => r.pair.group))].map((group) => {
        const r = failing.find((x) => x.pair.group === group)!;
        const way = directionFor(model, group);
        return (
          <p key={`dir-${group}`} className="ss-contrast-note">
            {way && 'apart' in way ? (
              `No single ${labelOf(model, r.pair.fg)} reads on both ${way.apart[0]} and ${way.apart[1]}. Bring those grounds closer together to fix this.`
            ) : r.pair.fg === tokenId ? (
              way ? `A ${way.direction} ${labelOf(model, tokenId)}, at ${r.min}:1 or more against ${way.ground}, keeps it readable ${way.partial ? 'everywhere it can be checked' : 'everywhere'}.` : null
            ) : (
              <>
                Change <Names model={model} ids={[r.pair.fg]} onJump={onJump} /> to fix this{way ? `: a ${way.direction} one, at ${r.min}:1 or more against ${way.ground}` : ''}.
              </>
            )}
          </p>
        );
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
    <div className="ss-contrast-block" tabIndex={-1}>
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
export function BrandContrast({ model, onUse, onJump }: { model: ContrastModel; onUse: UseSuggestionHandler; onJump?: JumpToColor }) {
  const rows = BASICS_PAIR_IDS.map((id) => model.results.find((r) => r.pair.id === id)).filter((r): r is PairResult => !!r);
  if (!rows.length) return null;
  const brandText = rows.find((r) => r.pair.fg === 'color.brand');
  // Brand-coloured text on the theme's other grounds (cards, alternate sections) is only in Colors; its worst cases are named here too.
  // Which way to move, and against which ground: meeting the target on the hardest ground keeps every other one readable.
  const way = brandText ? directionFor(model, brandText.pair.group) : null;
  const elsewhere = brandText ? model.results.filter(isFailing).filter((r) => r.pair.group === brandText.pair.group && r.pair.id !== brandText.pair.id).sort((a, b) => a.ratio - b.ratio) : [];
  return (
    <div className="ss-contrast" role="group" aria-label="Brand color contrast">
      <ul className="ss-pairs">
        {rows.map((r) => (
          <PairRow key={r.pair.id} r={r} />
        ))}
      </ul>
      {offersFor(model, rows).map((s) => (
        <UseSuggestion key={`${s.token}:${s.value}`} model={model} s={s} onUse={onUse} onJump={onJump} />
      ))}
      {distinctAdvice(rows.filter(isFailing)).map((r) => (
        <ChangeInstead key={r.pair.id} model={model} r={r} onJump={onJump} />
      ))}
      {(brandText?.status === 'fail' || elsewhere.length > 0) && (
        <p className="ss-contrast-note">
          {brandText?.status === 'fail' ? 'Links and text buttons in the brand color are hard to read on the page' : 'Links and text buttons in the brand color are hard to read'}
          {elsewhere.length > 0 && `${brandText?.status === 'fail' ? ', and on ' : ' on '}${list(elsewhere.map((r) => `${r.pair.use.replace(/^.*?\son\s/, '')} (${formatRatio(r.ratio)}:1)`))}`}. {way && 'apart' in way
            ? `No single brand color reads on both ${way.apart[0]} and ${way.apart[1]}. Bring those grounds closer together to keep links readable.`
            : way
              ? `A ${way.direction} brand color, at 4.5:1 or more against ${way.ground}, keeps them readable ${way.partial ? 'everywhere it can be checked' : 'everywhere'}.`
              : 'A brand color further from the page background keeps them readable.'}
        </p>
      )}
    </div>
  );
}
