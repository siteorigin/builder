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

const CHOICE_NAMES: Record<string, string> = { [READABLE_TEXT_COLORS[0]]: 'white', [READABLE_TEXT_COLORS[1]]: 'dark', [READABLE_TEXT_COLORS[2]]: 'black' };

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

/**
 * The ratio and verdict in words and an icon, so it never rests on colour alone. Only a failing icon takes a hue:
 * the words stay in the panel's own text colours, so a pass is quiet and a fail is found by its icon.
 */
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
      <span>{pass ? 'Readable' : `Needs ${r.min}:1`}</span>
    </span>
  );
}

/** "is" or "are" for a pair's use, by its subject: "Button text on hover is", "Brand-colored links on cards are". */
const verbFor = (use: string) => (/s$/i.test(use.split(/\s(?:on|in|over)\s/)[0].trim().split(/\s+/).pop() ?? '') ? 'are' : 'is');

const isLinkPair = (p: ContrastPair) => p.fg === 'color.brand' || /link/i.test(p.use);
const sampleLabel = (p: ContrastPair) => (isLinkPair(p) ? 'Link' : /button/i.test(p.use) ? 'Button' : 'Text');

/** The two colours of a pair as the site shows them, the word in the shape it takes there. Hatched when one of them cannot be known. */
function Sample({ r }: { r: PairResult }) {
  if (r.status === 'unknown') return <span className="ss-sample none" aria-hidden="true" />;
  return (
    <span className={`ss-sample${isLinkPair(r.pair) ? ' link' : ''}`} style={{ background: r.bg, color: r.fg }} aria-hidden="true">
      {sampleLabel(r.pair)}
    </span>
  );
}

/** One pair as a row: a sample in its colours, what it colours, and how readable it is. */
function PairRow({ r }: { r: PairResult }) {
  return (
    <li className={`ss-pair ${r.status}`}>
      <Sample r={r} />
      <span className="ss-pair-use">{r.pair.use}</span>
      <Verdict r={r} />
    </li>
  );
}

/** Opens a colour's row in Colors, so a note that names a colour to change is also the way to it. */
export type JumpToColor = (tokenId: string) => void;

/** Colours named in a note, each a jump to its row when a jump is given; the text reads the same either way. */
function Names({ model, ids, onJump, or }: { model: ContrastModel; ids: string[]; onJump?: JumpToColor; or?: boolean }) {
  return (
    <>
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 && (i === ids.length - 1 ? (or ? ' or ' : ' and ') : ', ')}
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

/** What taking the offer makes readable that is not today, by what it colours. */
function fixedUses(model: ContrastModel, s: ForegroundSuggestion): string[] {
  const was = new Map(model.results.map((r) => [r.pair.id, r.status]));
  return s.after.filter((r) => r.status === 'pass' && was.get(r.pair.id) === 'fail').map((r) => r.pair.use);
}

/** Uses in a sentence: "text on all 3 backgrounds" when they are one thing on several grounds, else each by name. */
function usesPhrase(uses: string[]): string {
  const parts = uses.map((u) => /^(.*?)\s(on|in)\s(.*)$/.exec(u));
  if (uses.length > 2 && parts.every((m) => m && m[1] === parts[0]![1])) return `${lowerFirst(parts[0]![1])} on all ${uses.length} backgrounds`;
  return list(uses.map(lowerFirst));
}

/** What a group's pairs colour, without the ground: "Brand-colored links", "Keyboard focus outline". */
const subjectOf = (use: string) => use.replace(/\s(?:on|in|over)\s.*$/, '');

/** What the offer is called in a sentence: "Dark text", or the value itself. */
const choiceSubject = (s: ForegroundSuggestion) => (CHOICE_NAMES[s.value] ? `${CHOICE_NAMES[s.value].charAt(0).toUpperCase()}${CHOICE_NAMES[s.value].slice(1)} text` : s.value);

/**
 * The trade in one line, read before the button, with the offer as its subject so it is not read as the advice above
 * it: "Dark text fixes button text, but makes button text on hover and 2 others hard to read." The break named is one
 * in the same group as the fix where there is one (shown beside it), the rest counted.
 */
function tradeOf(model: ContrastModel, s: ForegroundSuggestion): string {
  const fixes = fixedUses(model, s);
  const subject = choiceSubject(s);
  const head = fixes.length ? `${subject} fixes ${usesPhrase(fixes)}` : '';
  if (!s.breaks.length) return head && `${head}.`;
  // Each thing named once, its states folded in: "light button text (at rest and on hover)". The fix's own group first.
  const groups = [...new Set([...s.breaks].sort((a, b) => Number(!s.after.some((x) => x.pair.id === a.pair.id)) - Number(!s.after.some((x) => x.pair.id === b.pair.id))).map((r) => r.pair.group))];
  const names = groups.map((g) => {
    const inGroup = s.breaks.filter((r) => r.pair.group === g);
    const states = new Set(inGroup.map((r) => r.pair.state));
    if (inGroup.length > 1 && states.size > 1) return `${lowerFirst(subjectOf(inGroup.find((r) => r.pair.state === 'rest')!.pair.use))} (at rest and on hover)`;
    return list(inGroup.map((r) => lowerFirst(r.pair.use)));
  });
  const breaks = `${list(names)} hard to read`;
  return head ? `${head}, but makes ${breaks}.` : `${subject} makes ${breaks}.`;
}

/** After the button: what stays hard to read with the suggestion, and which colour to change for what it leaves. */
function Consequence({ model, s, onJump, named }: { model: ContrastModel; s: ForegroundSuggestion; onJump?: JumpToColor; named?: boolean }) {
  const left = [...s.breaks, ...s.after.filter(isFailing)].filter((r, i, all) => all.findIndex((o) => o.pair.id === r.pair.id) === i);
  if (!left.length) return null;
  const broken = new Set(s.breaks.map((r) => r.pair.id));
  const still = left.filter((r) => !broken.has(r.pair.id));
  const ids = [...new Set(left.flatMap((r) => (r.pair.fixable === false ? [r.pair.fg] : bgTokens(r.pair))).filter((id) => id !== s.token))];
  return (
    <>
      {still.length > 0 && `${list(still.map((r) => r.pair.use).map((u, i) => (i ? lowerFirst(u) : u)))} would still be hard to read. `}
      {ids.length > 0 && (
        <>
          {/* After a sentence that ends on something else ("Links stay hard to read."), "those" would point at the wrong thing. */}
          Change <Names model={model} ids={ids} onJump={onJump} /> to fix {named ? `what ${choiceSubject(s).toLowerCase()} breaks` : `${left.length > 1 ? 'those' : 'that'}${s.breaks.length ? ' too' : ''}`}.
        </>
      )}
    </>
  );
}

/** The offer's label: short on the row of the colour it sets, and naming that colour anywhere else. */
function offerLabel(s: ForegroundSuggestion, target: string, own: boolean, fixes: string[]): { shown: string; hidden: string } {
  const choice = CHOICE_NAMES[s.value];
  if (own) return choice ? { shown: `Use ${choice} text`, hidden: ` for ${target}` } : { shown: `Use ${s.value}`, hidden: ` for ${target}` };
  // Away from its own row the offer takes the name of what it fixes, as the rows above call it: "Use dark button text".
  if (choice && fixes.length === 1 && /\btext$/i.test(fixes[0])) return { shown: `Use ${choice} ${lowerFirst(fixes[0])}`, hidden: ` (sets ${target})` };
  if (choice && /\btext\b/i.test(target)) return { shown: `Use ${choice} ${lowerFirst(target)}`, hidden: '' };
  return { shown: `Set ${target} to ${choice ?? s.value}`, hidden: '' };
}

/** The offer to use a readable text colour: what it fixes and costs, then the button, then what it leaves. */
function UseSuggestion({ model, s, onUse, onJump, own, instead, stays }: { model: ContrastModel; s: ForegroundSuggestion; onUse: UseSuggestionHandler; onJump?: JumpToColor; own: boolean; instead?: string; stays?: string }) {
  const id = useId();
  const target = model.tokens.find((t) => t.id === s.token);
  const name = target?.label ?? s.token;
  const follows = target ? refOf(target.value) : null;
  const note = hasConsequence(s);
  // After advice to change another colour, the offer is introduced as the other route, not the next step.
  const plain = tradeOf(model, s);
  const trade = plain && instead ? `${instead} ${lowerFirst(plain)}${stays ? ` ${stays}` : ''}` : plain;
  const label = offerLabel(s, name, own, fixedUses(model, s));
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
      <button type="button" className="btn btn-sm" aria-describedby={described || undefined} onClick={(e) => onUse(s, e.currentTarget)}>
        {fixed && fixed.status === 'pass' ? (
          <span className="ss-ink" style={{ background: fixed.bg, color: fixed.fg }} aria-hidden="true">
            Aa
          </span>
        ) : (
          <span className="ss-chip" style={{ background: s.value }} aria-hidden="true" />
        )}
        <span>
          {label.shown}
          {label.hidden && <span className="sr-only">{label.hidden}</span>}
        </span>
        <span className="ss-offer-value">{s.value}</span>
      </button>
      {(follows || note) && (
        <p className="ss-contrast-note" id={`${id}-note`}>
          {follows && `${name} gets its own color; it stops following ${labelOf(model, follows)}. `}
          {note && <Consequence model={model} s={s} onJump={onJump} named={!!stays} />}
        </p>
      )}
    </div>
  );
}

const hasConsequence = (s: ForegroundSuggestion) => s.breaks.length > 0 || s.after.some(isFailing);

/** Whether a token comes to a colour that can be measured, following the colours it links to. */
function measurable(model: ContrastModel, id: string, seen = new Set<string>()): boolean {
  const t = model.tokens.find((x) => x.id === id);
  if (!t || seen.has(id)) return false;
  seen.add(id);
  const ref = refOf(t.value);
  if (ref) return measurable(model, ref, seen);
  return typeof t.value === 'string' && !!resolveCssColor(t.value);
}

/**
 * For pairs no offered text colour fixes: which colour to change instead, said once for the row. A group with a
 * pair that cannot be measured gets no verdict on which colour would read; it names the colour to check instead.
 */
function ChangeInstead({ model, results, onJump, self }: { model: ContrastModel; results: FailingPair[]; onJump?: JumpToColor; self?: string }) {
  const rs = results.filter((r) => r.pair.fixable !== false && !model.offers.get(r.pair.id));
  if (!rs.length) return null;
  const groups = new Set(rs.map((r) => r.pair.group));
  const unchecked = model.results.filter((r) => r.status === 'unknown' && groups.has(r.pair.group));
  const blind = [...new Set(unchecked.flatMap((r) => [r.pair.fg, ...bgTokens(r.pair)]).filter((id) => !measurable(model, id)))];
  const name = (ids: string[]) => {
    const others = ids.filter((id) => id !== self);
    if (!others.length) return 'this color';
    return ids.includes(self ?? '') ? (
      <>
        this color or <Names model={model} ids={others} onJump={onJump} or />
      </>
    ) : (
      <Names model={model} ids={others} onJump={onJump} or />
    );
  };
  if (unchecked.length)
    return (
      <p className="ss-contrast-note">
        No readable text color can be worked out while {blind.length ? name(blind) : 'one of its backgrounds'} can’t be checked. Give {blind.length > 1 ? 'them plain colors' : 'it a plain color'} first.
      </p>
    );
  const sentences: Array<{ key: string; lead: string; ids: string[]; it: string }> = [];
  const hover = rs.filter((r) => r.pair.state === 'hover');
  const rest = rs.filter((r) => r.pair.state !== 'hover');
  const ids = (list: FailingPair[]) => [...new Set(list.flatMap((r) => bgTokens(r.pair).filter((id) => id !== r.pair.fg)))];
  if (rest.length) sentences.push({ key: 'rest', lead: 'No suggested text color reads on all of these backgrounds.', ids: ids(rest), it: 'this' });
  if (hover.length) sentences.push({ key: 'hover', lead: 'Text that reads on the button does not read on its hover color.', ids: ids(hover), it: 'it' });
  return (
    <>
      {sentences.map((s) => (
        <p key={s.key} className="ss-contrast-note">
          {s.lead} Change {name(s.ids)} to fix {s.it}.
        </p>
      ))}
    </>
  );
}

/**
 * Which way a colour that is unreadable as text must move, and the ground that decides it. Darker text has to reach
 * the target against the darkest ground it sits on, lighter text against the lightest; a direction is offered only
 * when some colour can reach it there, and the nearer one when both can. When neither can, no single colour reads
 * on every ground, and the grounds that pull apart are named instead.
 */
type Way = { direction: 'darker' | 'lighter'; ground: string; now: number; target: number; partial: boolean } | { apart: [string, string] } | null;
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
  const decides = darker ? darkest : lightest;
  return { direction: darker ? 'darker' : 'lighter', ground: decides.use, now: decides.r.ratio, target: darker ? darkerCeiling : lighterFloor, partial: measured.length < inGroup.length };
}

/**
 * The fix for text that only its own colour can fix, as an edit with its stopping point: "Darken Brand until
 * brand-colored links reach 4.5:1 on alternate sections, the hardest background (now 1.27:1)." When no colour
 * darker or lighter than every ground reads on all of them, only a mid-tone can, so that is what it says.
 */
function wayText(way: Way, color: string, things: string, min: number, short = false): string {
  const reach = verbFor(things) === 'are' ? 'reach' : 'reaches';
  if (!way) return `A ${color} further from its backgrounds keeps ${lowerFirst(things)} readable.`;
  if ('apart' in way) return `No ${color} darker or lighter than both ${way.apart[0]} and ${way.apart[1]} reads on both. Try a mid-tone, or make those backgrounds more alike.`;
  const verb = way.direction === 'darker' ? 'Darken' : 'Lighten';
  // Under a flag that already names the hardest background and its ratio, the edit and its target are enough.
  if (short) return `${verb} ${color} until ${lowerFirst(things)} ${reach} ${min}:1.`;
  return `${verb} ${color} until ${lowerFirst(things)} ${reach} ${min}:1 on ${way.ground}, the hardest background${way.partial ? ' that can be checked' : ''} (now ${formatRatio(way.now)}:1).`;
}

/**
 * Failing pairs drawn on the colour that is being moved (a button on the brand colour) that the move fixes too, read
 * at its stopping point: the lightness the advice asks for, against their text colour as it is.
 */
function alsoFixed(way: Way, color: string, failing: FailingPair[]): string[] {
  if (!way || !('direction' in way)) return [];
  return failing
    .filter((r) => r.pair.bg === color)
    .filter((r) => {
      const c = resolveCssColor(r.fg);
      if (!c) return false;
      const fg = relativeLuminance(c);
      const t = Math.min(1, Math.max(0, way.target));
      return (Math.max(fg, t) + 0.05) / (Math.min(fg, t) + 0.05) >= r.min;
    })
    .map((r) => lowerFirst(r.pair.use));
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

/**
 * Unreadable pairs a token belongs to, under its row in Colors: one line per thing that is hard to read, then what to
 * do. The fix this colour owns comes first; a fix that lives on another colour's row is a one-line pointer there.
 */
export function ContrastFlags({ model, tokenId, onUse, onJump, onShowAll, expanded, controls }: { model: ContrastModel; tokenId: string; onUse: UseSuggestionHandler; onJump?: JumpToColor; onShowAll?: () => void; expanded?: boolean; controls?: string }) {
  const failing = failingFor(model, tokenId);
  // While the details are closed it opens them (a disclosure, so it says so); once open it only takes focus there.
  const showAll = onShowAll && (
    <>
      {' '}
      {expanded ? (
        <button type="button" className="link-btn ss-jump" onClick={onShowAll}>
          See the list below
        </button>
      ) : (
        <button type="button" className="link-btn ss-jump" aria-expanded={false} aria-controls={controls} onClick={onShowAll}>
          Show all
          <span className="sr-only"> contrast for this color</span>
        </button>
      )}
    </>
  );
  if (!failing.length) {
    // Nothing fails, but a pair could not be measured: one quiet line, so the row is not read as all clear.
    const ids = new Set(pairsOf(model.pairs, tokenId, model.tokens).map((p) => p.id));
    const unknown = model.results.filter((r) => r.status === 'unknown' && ids.has(r.pair.id));
    if (!unknown.length) return null;
    const blind = [...new Set(unknown.flatMap((r) => [r.pair.fg, ...bgTokens(r.pair)]).filter((id) => !measurable(model, id)))];
    return (
      <div className="ss-contrast-flags">
        <p className="ss-flag unknown">
          <CircleHelp aria-hidden="true" />
          <span>
            {unknown[0].pair.use}{unknown.length > 1 ? ` and ${unknown.length - 1} more` : ''} can’t be checked
            {blind.length ? (
              <>
                {' '}
                until {blind.includes(tokenId) ? 'this color has' : <><Names model={model} ids={blind} onJump={onJump} /> {blind.length > 1 ? 'have' : 'has'}</>} a plain color.
              </>
            ) : (
              '.'
            )}
            {unknown.length > 1 && showAll}
          </span>
        </p>
      </div>
    );
  }
  // One line per thing that is unreadable (a button, text on three grounds): its worst case, and how many others are low too.
  const worst = new Map<string, { r: FailingPair; others: number }>();
  for (const r of failing) {
    const seen = worst.get(r.pair.group);
    worst.set(r.pair.group, { r: !seen || r.ratio < seen.r.ratio ? r : seen.r, others: seen ? seen.others + 1 : 0 });
  }
  const offers = offersFor(model, failing);
  const own = offers.filter((s) => s.token === tokenId || !onJump);
  const elsewhere = offers.filter((s) => !own.includes(s));
  // Text no other colour can fix (brand-coloured links): which way to move it, or which colour to change.
  const fixedOnlyByFg = [...new Set(failing.filter((r) => r.pair.fixable === false).map((r) => r.pair.group))];
  return (
    <div className="ss-contrast-flags">
      <ul className="ss-pairs">
        {[...worst.values()].map(({ r, others }) => (
          <li key={r.pair.group} className="ss-flag">
            <TriangleAlert aria-hidden="true" />
            <span>
              {r.pair.use} {verbFor(r.pair.use)} hard to read: <span className="ss-ratio">{formatRatio(r.ratio)}:1</span>, needs {r.min}:1.
              {others > 0 && (
                <span className="ss-flag-more">
                  {' '}
                  Also low in {others} other {others === 1 ? 'place' : 'places'}.
                  {showAll}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {fixedOnlyByFg.map((group) => {
        const r = failing.find((x) => x.pair.group === group)!;
        const way = directionFor(model, group);
        if (r.pair.fg === tokenId) {
          const flagged = worst.get(group)?.r;
          const short = !!way && 'direction' in way && !!flagged && flagged.pair.use.endsWith(way.ground) && !way.partial;
          const too = alsoFixed(way, tokenId, failing);
          return (
            <p key={`dir-${group}`} className="ss-contrast-note ss-contrast-lead">
              {wayText(way, labelOf(model, tokenId), subjectOf(r.pair.use), r.min, short)}
              {too.length > 0 && ` That fixes ${list(too)} too.`}
            </p>
          );
        }
        return (
          <p key={`dir-${group}`} className="ss-contrast-note">
            {way && 'apart' in way ? (
              wayText(way, labelOf(model, r.pair.fg), subjectOf(r.pair.use), r.min)
            ) : (
              <>
                Change <Names model={model} ids={[r.pair.fg]} onJump={onJump} /> to fix {worst.size > 1 ? lowerFirst(r.pair.use) : 'this'}.
              </>
            )}
          </p>
        );
      })}
      {own.map((s) => (
        <UseSuggestion key={`${s.token}:${s.value}`} model={model} s={s} onUse={onUse} onJump={onJump} own={s.token === tokenId} />
      ))}
      {/* An offer lives on the row of the colour it sets; another colour's row points there rather than repeating it. */}
      {elsewhere.map((s) => {
        const fixesAll = [...worst.values()].every(({ r }) => s.after.some((a) => a.pair.group === r.pair.group));
        return (
          <p key={`${s.token}:${s.value}`} className="ss-contrast-note">
            {fixesAll ? 'A fix is offered on ' : `A fix for ${usesPhrase(fixedUses(model, s))} is offered on `}
            <Names model={model} ids={[s.token]} onJump={onJump} />.
          </p>
        );
      })}
      <ChangeInstead model={model} results={failing} onJump={onJump} self={tokenId} />
    </div>
  );
}

/** Every pair a token belongs to, with its sample and ratio, for the row's details. Focus lands here from "Show all". */
export function ContrastDetail({ model, tokenId }: { model: ContrastModel; tokenId: string }) {
  const id = useId();
  const ids = new Set(pairsOf(model.pairs, tokenId, model.tokens).map((p) => p.id));
  const rows = model.results.filter((r) => ids.has(r.pair.id));
  if (!rows.length) return null;
  return (
    <div className="ss-contrast-block" tabIndex={-1} role="group" aria-labelledby={`${id}-label`}>
      <div className="ss-detail-label" id={`${id}-label`}>
        Contrast where it is used
      </div>
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
 * page, each with its ratio, so an unreadable choice shows where it is made. Below them, what to do: the brand colour's
 * own fix first (only it fixes links), then the offer of a readable button text colour and what that costs.
 */
export function BrandContrast({ model, onUse, onJump }: { model: ContrastModel; onUse: UseSuggestionHandler; onJump?: JumpToColor }) {
  const rows = BASICS_PAIR_IDS.map((id) => model.results.find((r) => r.pair.id === id)).filter((r): r is PairResult => !!r);
  if (!rows.length) return null;
  const brandText = rows.find((r) => r.pair.fg === 'color.brand');
  // Brand-coloured text on the theme's other grounds (cards, alternate sections) is only in Colors; its worst cases are named here too.
  // Which way to move, and against which ground: meeting the target on the hardest ground keeps every other one readable.
  const way = brandText ? directionFor(model, brandText.pair.group) : null;
  const elsewhere = brandText ? model.results.filter(isFailing).filter((r) => r.pair.group === brandText.pair.group && r.pair.id !== brandText.pair.id).sort((a, b) => a.ratio - b.ratio) : [];
  const where = [...(brandText?.status === 'fail' ? ['the page'] : []), ...elsewhere.map((r) => `${r.pair.use.replace(/^.*?\son\s/, '')} (${formatRatio(r.ratio)}:1)`)];
  const offers = offersFor(model, rows);
  const advice = rows.filter(isFailing);
  const brandAlso = brandText ? alsoFixed(way, brandText.pair.fg, advice) : [];
  // Brand-coloured text on a ground that cannot be measured: said here too, so three passing previews are not read as all clear.
  const unchecked = brandText ? model.results.filter((r) => r.status === 'unknown' && r.pair.group === brandText.pair.group) : [];
  const blind = [...new Set(unchecked.flatMap((r) => [r.pair.fg, ...bgTokens(r.pair)]).filter((id) => !measurable(model, id)))];
  const min = brandText && brandText.status !== 'unknown' ? brandText.min : 4.5;
  const notes = where.length > 0 || unchecked.length > 0 || offers.length > 0 || advice.some((r) => r.pair.fixable !== false && !model.offers.get(r.pair.id));
  return (
    <div className="ss-contrast" role="group" aria-label="Brand color contrast">
      <ul className="ss-pairs">
        {rows.map((r) => (
          <PairRow key={r.pair.id} r={r} />
        ))}
      </ul>
      {notes && (
        <div className="ss-contrast-advice">
          {where.length > 0 && (
            <p className="ss-contrast-note ss-contrast-lead">
              {way && 'direction' in way ? `${wayText(way, 'the brand color', 'Links and text buttons', min)}${brandAlso.length ? ` That fixes ${list(brandAlso)} too.` : ''}` : `Links and text buttons in the brand color are hard to read on ${list(where)}. ${wayText(way, 'brand color', 'them', min)}`}
            </p>
          )}
          {offers.map((s) => (
            <UseSuggestion key={`${s.token}:${s.value}`} model={model} s={s} onUse={onUse} onJump={onJump} own={false} instead={where.length > 0 && way && 'direction' in way ? 'To keep the brand color as it is:' : undefined} stays={where.length > 0 ? 'Links stay hard to read.' : undefined} />
          ))}
          <ChangeInstead model={model} results={advice} onJump={onJump} />
          {unchecked.length > 0 && (
            <p className="ss-flag unknown">
              <CircleHelp aria-hidden="true" />
              <span>
                Links on {list(unchecked.map((r) => r.pair.use.replace(/^.*?\son\s/, '')))} can’t be checked
                {blind.length ? (
                  <>
                    {' '}
                    until <Names model={model} ids={blind} onJump={onJump} /> {blind.length > 1 ? 'have plain colors' : 'has a plain color'}.
                  </>
                ) : (
                  '.'
                )}
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
