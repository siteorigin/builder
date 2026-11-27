import { useId, useMemo, useRef, useState } from 'react';
import { CircleCheck, CircleHelp, Info, TriangleAlert } from 'lucide-react';
import type { TokenDef, TokensDoc } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import type { PaletteScheme } from '@shared/color-scheme';
import { relativeLuminance, type ContrastPair } from '@shared/contrast';
import { parseColor } from '@shared/color';
import { PALETTE_MOODS, PALETTE_MOOD_INFO, darkPins, harmonizePalette, paletteChanges, paletteSeed, type PaletteMood, type PaletteRole } from '@shared/palette';
import { commitOps, toast, undoAction } from '../store';
import { ChoiceField } from '../components/ui';

/** The colours the preview names, in the order an owner reads a page: grounds, text, the brand, dark sections. */
const SHOWN: Array<[PaletteRole, string]> = [
  ['color.background', 'Background'],
  ['color.surface', 'Cards'],
  ['color.surface-alt', 'Alternate'],
  ['color.border', 'Border'],
  ['color.text', 'Text'],
  ['color.muted', 'Muted text'],
  ['color.brand', 'Brand'],
  ['color.brand-strong', 'Brand (strong)'],
  ['color.on-brand', 'Text on brand'],
  ['color.accent', 'Accent'],
  ['color.inverse', 'Dark sections'],
  ['color.on-inverse', 'Text on dark'],
  ['color.focus', 'Focus outline']
];

const luminance = (hex: string) => relativeLuminance(parseColor(hex)!);

/**
 * A whole palette made from the brand colour, the same one the AI makes with a palette mood (src/shared/palette.ts):
 * grounds, text, lines, hover, dark sections and accent, every pair the theme sets readable. Choosing a mood only
 * previews it here; one button uses it as one step, so one Undo puts every colour back as it was. A palette is made
 * for the light colours: while the dark ones are shown, the group says so and stays mounted, keeping its mood.
 */
export function PaletteHarmony({
  tokens,
  pairs,
  dark,
  revision,
  shown,
  onShowLight
}: {
  tokens: TokenDef[];
  pairs: readonly ContrastPair[];
  /** The site's dark colours when visitors can see a dark palette: it keeps showing what it does. */
  dark: TokensDoc['darkOverrides'] | null;
  revision: number;
  /** The palette Colors shows; a palette from the brand is made only while it is the light one. */
  shown: PaletteScheme;
  onShowLight: () => void;
}) {
  const uid = useId();
  const seed = useMemo(() => paletteSeed(tokens), [tokens]);
  // Opens on the mood the site already uses, if it uses one, so the panel does not offer to replace it with Neutral.
  const [mood, setMood] = useState<PaletteMood>(() => (seed && PALETTE_MOODS.find((m) => !paletteChanges(tokens, harmonizePalette({ brand: seed, mood: m, tokens, pairs }).values).length)) || 'neutral');
  const group = useRef<HTMLDivElement>(null);
  // "Show light colors" goes with the click: focus lands on the mood chosen, where the palette is made.
  const showLight = () => {
    onShowLight();
    // Without a brand there is no mood to land on: then the switch's Light colors, which did it.
    requestAnimationFrame(() => (group.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? group.current?.parentElement?.querySelector<HTMLElement>('.ss-palette-editing [role="radio"][aria-checked="true"]'))?.focus());
  };
  // Measured with the plain parser, as the AI's palette is: the browser would read a colour in the editor's own scheme
  // (a light-dark() one), not the site's, so a colour only it can read stays unknown and holds the palette back.
  const palette = useMemo(() => (seed && shown === 'light' ? harmonizePalette({ brand: seed, mood, tokens, pairs }) : null), [seed, shown, mood, tokens, pairs]);
  const label = (
    <div className="ss-group-label" id={`${uid}-label`}>
      Palette from brand
    </div>
  );
  if (shown === 'dark' || !palette) {
    return (
      <div className="ss-group ss-harmony" role="group" aria-labelledby={`${uid}-label`} ref={group}>
        {label}
        {shown === 'dark' ? (
          <p className="ss-palette-note">
            A palette is made for the light colors.{' '}
            <button type="button" className="link-btn" onClick={showLight}>
              Show light colors
            </button>
          </p>
        ) : (
          <p className="ss-palette-note">Give Brand a color of its own to make a palette from it.</p>
        )}
      </div>
    );
  }
  const v = palette.values;
  // Failing pairs, and pairs a palette colour is part of that cannot be measured: either keeps the palette from use.
  const unreadable = palette.unreadable;
  // Pairs on other colours that cannot be measured are said, never counted as readable.
  const unknown = palette.results.filter((r) => r.status === 'unknown').length - unreadable.filter((r) => r.status === 'unknown').length;
  // Only what the site does not show already, so a colour that follows another and lands on the same one keeps following it.
  const changes = paletteChanges(tokens, v);
  const ops: EditOperation[] = changes.map(([tokenId, value]) => ({ type: 'token.set', tokenId, value }));
  // A dark palette visitors see keeps the colours it took from the light ones, so no pair there changes under them.
  if (dark !== null) ops.push(...darkPins(tokens, dark, changes.map(([id]) => id)).map(([tokenId, value]): EditOperation => ({ type: 'token.set', tokenId, value, scheme: 'dark' })));
  const name = PALETTE_MOOD_INFO[mood].label;
  const held = unreadable.length > 0;
  const inUse = !changes.length;
  const apply = () => {
    if (held || inUse) return;
    void commitOps(ops, `Use the ${name.toLowerCase()} palette from the brand`, undefined, revision).then((r) => r?.ok && toast(dark !== null ? `Your light colors now use the ${name.toLowerCase()} palette.` : `Your site now uses the ${name.toLowerCase()} palette.`, 'info', undoAction(r)));
  };
  const chips = SHOWN.filter(([id]) => v[id]);
  const lighter = palette.adjusted && luminance(palette.brand) > luminance(palette.requested);
  const measured = palette.results.some((r) => r.status !== 'unknown');
  return (
    <div className="ss-group ss-harmony" role="group" aria-labelledby={`${uid}-label`} ref={group}>
      {label}
      {/* A dark result is said in place of the mood's own description, which describes the light one it could not make. */}
      <ChoiceField
        label="Mood"
        full
        value={mood}
        options={PALETTE_MOODS.map((m) => ({ value: m, label: PALETTE_MOOD_INFO[m].label }))}
        onChange={setMood}
        hint={palette.page === 'dark' ? `${name} on dark backgrounds: with this brand, the theme’s colors are readable only on dark ones.` : PALETTE_MOOD_INFO[mood].description}
      />
      <div className="ss-harmony-sample">
        <div className="ss-harmony-caption" aria-hidden="true">
          Preview
        </div>
        <div className="ss-harmony-preview" aria-hidden="true" style={{ background: v['color.background'], color: v['color.text'] }}>
          <div className="ss-harmony-card" style={{ background: v['color.surface'], boxShadow: `0 0 0 1px ${v['color.border']}` }}>
            <span className="ss-harmony-heading">Heading</span>
            <span style={{ color: v['color.muted'] }}>Supporting text</span>
            <span className="ss-harmony-actions">
              <span className="ss-harmony-btn" style={{ background: v['color.brand'], color: v['color.on-brand'] }}>
                Button
              </span>
              <span style={{ color: v['color.brand'] }}>Link</span>
            </span>
          </div>
          <div className="ss-harmony-band" style={{ background: v['color.surface-alt'], color: v['color.brand'] }}>
            Alternate section
          </div>
          <div className="ss-harmony-band" style={{ background: v['color.inverse'], color: v['color.on-inverse'] }}>
            Dark section <span style={{ color: v['color.accent'] }}>Accent</span>
          </div>
        </div>
        <ul className="ss-harmony-chips" aria-label="Proposed colors">
          {chips.map(([id, chip]) => (
            <li key={id} data-role={id} data-value={v[id]} title={`${chip}: ${v[id]}`}>
              <span className="ss-chip" style={{ background: v[id] }} aria-hidden="true" />
              {chip}
              <span className="sr-only"> {v[id]}</span>
            </li>
          ))}
        </ul>
      </div>
      <ul className="ss-harmony-facts" aria-label="About this palette">
        {held ? (
          <li className="fail" id={`${uid}-held`}>
            <TriangleAlert aria-hidden="true" />
            <span>
              {unreadable.every((r) => r.status === 'unknown')
                ? `Can’t be used: ${unreadable.length === 1 ? 'this pair can’t' : 'these pairs can’t'} be checked, so the palette might make ${unreadable.length === 1 ? 'it' : 'them'} hard to read.`
                : `Can’t be used: no palette from this brand keeps ${unreadable.length === 1 ? 'this' : 'these'} readable in this theme.`}
              <span className="ss-harmony-pairs">
                {unreadable.map((r) => (
                  <span key={r.pair.id}>
                    {r.pair.use}
                    {r.status === 'unknown' ? ' (can’t be checked)' : ''}
                  </span>
                ))}
              </span>
            </span>
          </li>
        ) : measured ? (
          <li className="pass">
            <CircleCheck aria-hidden="true" />
            <span>{unknown ? `Every color pair in this preview that can be checked is readable; ${unknown === 1 ? 'one can’t' : `${unknown} can’t`} be checked.` : 'Every color pair in this preview is readable.'}</span>
          </li>
        ) : (
          <li>
            <CircleHelp aria-hidden="true" />
            <span>{palette.results.length ? 'No color pair in this preview can be checked.' : 'This theme sets no color pairs to check.'}</span>
          </li>
        )}
        {dark !== null && !inUse && !held && (
          <li>
            <Info aria-hidden="true" />
            <span>Dark colors stay as they are; to match, remake them under Dark colors.</span>
          </li>
        )}
        {palette.adjusted && (
          <li>
            <Info aria-hidden="true" />
            <span>
              Brand becomes {lighter ? 'lighter' : 'darker'}, <span className="ss-harmony-hex">{palette.brand}</span>, so links stay readable.
            </span>
          </li>
        )}
      </ul>
      <div className="ss-harmony-apply">
        {/* Held or in use, it stays focusable (aria-disabled), so focus is not lost on use and its reason is read with it. */}
        <button className="btn btn-sm btn-primary" aria-disabled={held || inUse || undefined} aria-describedby={held ? `${uid}-held` : `${uid}-apply-note`} onClick={apply}>
          Use the {name.toLowerCase()} palette
        </button>
        {/* Held, the reason above describes the button; a promise to replace colors would contradict it. */}
        {!held && (
          <span className="ss-palette-note" id={`${uid}-apply-note`}>
            {inUse ? (dark !== null ? 'Your light colors use this palette.' : 'Your site uses this palette.') : `Replaces your ${dark !== null ? 'light ' : ''}colors with these. You can undo this.`}
          </span>
        )}
      </div>
    </div>
  );
}
