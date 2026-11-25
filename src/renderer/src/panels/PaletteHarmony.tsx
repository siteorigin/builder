import { useId, useMemo, useState } from 'react';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import type { TokenDef, TokensDoc } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { relativeLuminance, type ContrastPair } from '@shared/contrast';
import { parseColor } from '@shared/color';
import { PALETTE_MOODS, PALETTE_MOOD_INFO, darkPins, harmonizePalette, paletteChanges, paletteSeed, type PaletteMood, type PaletteRole } from '@shared/palette';
import { applyOps } from '../store';

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
 * previews it here; one button applies it as one step, so one Undo puts every colour back as it was.
 */
export function PaletteHarmony({
  tokens,
  pairs,
  dark,
  revision,
  say
}: {
  tokens: TokenDef[];
  pairs: readonly ContrastPair[];
  /** The site's dark colours when visitors can see a dark palette: it keeps showing what it does. */
  dark: TokensDoc['darkOverrides'] | null;
  revision: number;
  say: (text: string) => void;
}) {
  const uid = useId();
  const [mood, setMood] = useState<PaletteMood>('neutral');
  const seed = useMemo(() => paletteSeed(tokens), [tokens]);
  // Measured with the plain parser, as the AI's palette is: the browser would read a colour in the editor's own scheme
  // (a light-dark() one), not the site's, so a colour only it can read stays unknown and holds the palette back.
  const palette = useMemo(() => (seed ? harmonizePalette({ brand: seed, mood, tokens, pairs }) : null), [seed, mood, tokens, pairs]);
  const label = (
    <div className="ss-group-label" id={`${uid}-label`}>
      Palette from brand
    </div>
  );
  if (!palette) {
    return (
      <div className="ss-group ss-harmony" role="group" aria-labelledby={`${uid}-label`}>
        {label}
        <p className="ss-palette-note">Give Brand a color of its own to make a palette from it.</p>
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
  const apply = () =>
    void applyOps(ops, `Use the ${name.toLowerCase()} palette from the brand`, undefined, revision).then((ok) => ok && say(`${name} palette made from your brand color. You can undo this.`));
  const shown = SHOWN.filter(([id]) => v[id]);
  return (
    <div className="ss-group ss-harmony" role="group" aria-labelledby={`${uid}-label`}>
      {label}
      <div className="segmented full ss-scale-choices" role="group" aria-label="Palette mood">
        {PALETTE_MOODS.map((m) => (
          <button key={m} aria-pressed={mood === m} title={PALETTE_MOOD_INFO[m].description} onClick={() => setMood(m)}>
            {PALETTE_MOOD_INFO[m].label}
          </button>
        ))}
      </div>
      <p className="ss-scale-note">{PALETTE_MOOD_INFO[mood].description} A preview: nothing changes until you use it.</p>
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
        {shown.map(([id, chip]) => (
          <li key={id} data-role={id} data-value={v[id]} title={`${chip}: ${v[id]}`}>
            <span className="ss-chip" style={{ background: v[id] }} aria-hidden="true" />
            {chip}
            <span className="sr-only"> {v[id]}</span>
          </li>
        ))}
      </ul>
      {unreadable.length ? (
        <p className="ss-harmony-verdict fail">
          <TriangleAlert aria-hidden="true" />
          <span>
            No palette from this brand keeps these readable in this theme: {unreadable.map((r) => `${r.pair.use}${r.status === 'unknown' ? ' (can’t be checked)' : ''}`).join(', ')}.
          </span>
        </p>
      ) : (
        <p className="ss-harmony-verdict pass">
          <CircleCheck aria-hidden="true" />
          <span>
            {unknown ? `Every color pair that can be checked is readable; ${unknown === 1 ? 'one can’t' : `${unknown} can’t`} be checked.` : 'Every color pair is readable.'}
            {palette.page === 'dark' && ' With this brand the theme’s colors read only on dark backgrounds, so this palette is dark.'}
            {palette.adjusted && ` Brand is made ${luminance(palette.brand) > luminance(palette.requested) ? 'lighter' : 'darker'}, ${palette.brand}, so links stay readable; no background can carry ${palette.requested}.`}
          </span>
        </p>
      )}
      <div className="ss-harmony-apply">
        <button className="btn btn-sm" disabled={!changes.length || unreadable.length > 0} onClick={apply}>
          Generate harmonious palette from brand
        </button>
        {!changes.length && <span className="ss-palette-note">This palette is in use.</span>}
        {dark !== null && changes.length > 0 && <span className="ss-palette-note">Your dark colors stay as they are; make them again from these under Dark.</span>}
      </div>
    </div>
  );
}
