import { useId, useState, type CSSProperties } from 'react';
import type { BackgroundImageValue, ResponsiveScope, StyleValue } from '@shared/types';
import { canonicalBackgroundImage, isBackgroundImageValue } from '@shared/background-image';
import { isScrim } from '@shared/styles';
import { ColorTextInput } from '../components/ColorTextInput';
import { normalizeColorText } from '@shared/color-names';
import { assetUrl } from '../lib/model';
import { useStore } from '../store';
import { FocusEditor } from './FocusEditor';
import { ImageEditor } from './PropEditors';

type Size = Exclude<ResponsiveScope, 'base'>;

/** Why an overlay typed can't be used: it is drawn over the picture, so only colours and gradients spelled out in full. */
const OVERLAY_REFUSED = 'An overlay is a color, such as #00000080, black or rgba(0, 0, 0, 0.5), or a linear-gradient() or radial-gradient() of such colors.';

/** Overlays to start from: a colour or gradient over the picture, so text on top stays readable. Stored as its `scrim`. */
export const SCRIM_PRESETS: Array<{ value: string; label: string }> = [
  { value: 'rgba(0, 0, 0, 0.45)', label: 'Darken' },
  { value: 'rgba(0, 0, 0, 0.65)', label: 'Darken strongly' },
  { value: 'rgba(255, 255, 255, 0.75)', label: 'Lighten' },
  { value: 'linear-gradient(to bottom, rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.7))', label: 'Darken toward the bottom' },
  { value: 'linear-gradient(to right, rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0))', label: 'Darken from the left' }
];

/** How a background image reads in the panel: what it fills and whether it has an overlay. */
export function describeBackgroundImage(v: StyleValue | undefined): string {
  if (!isBackgroundImageValue(v)) return '';
  const preset = SCRIM_PRESETS.find((p) => p.value === v.scrim);
  return ['Picture', v.size === 'contain' ? 'whole' : 'filling', v.scrim ? (preset ? preset.label.toLowerCase() : 'with an overlay') : 'no overlay'].join(' · ');
}

/** An overlay as a background layer: a gradient as it is, a colour as a flat gradient, so it can sit over another layer. */
const overlayLayer = (scrim: string) => (/gradient\(/i.test(scrim) ? scrim : `linear-gradient(${scrim}, ${scrim})`);

/**
 * The Background image control, across the whole row: the picture, chosen from the library as a site image is (no
 * description: it is decoration), with its overlay drawn over the thumbnail; then how it fills the box, the overlay,
 * and, while it fills the box, the point kept in view, chosen on the picture as an image's focus is. A picture showing
 * through from elsewhere shows here with its settings, and changing any of them makes this value its own copy. Each
 * change is one edit of the whole value; None removes it here, so what the design or All sizes sets shows through.
 */
export function BackgroundImageControl({
  label,
  value: raw,
  underText,
  under,
  underFrom,
  describedBy,
  scope,
  size,
  previewed,
  onSet
}: {
  label: string;
  value: StyleValue | undefined;
  underText: string;
  /** What shows when nothing is set here (from All sizes, Default or the design), and where it comes from. */
  under?: StyleValue;
  underFrom?: string;
  describedBy?: string;
  scope: ResponsiveScope;
  /** The size whose crop the focus shows: the one being edited, or the previewed one under All sizes. */
  size: Size;
  /** Whether the canvas shows this value at that size, so the box's shape can be measured there. */
  previewed: boolean;
  /** May return the change's promise, settling to the result (with the revision it made), or null when refused. */
  onSet: (v: StyleValue | null, expectedRevision?: number) => unknown;
}) {
  const state = useStore((s) => s.snapshot?.state);
  const runtime = useStore((s) => s.runtime);
  const box = useStore((s) => s.rects.selected[0]);
  const ids = { fit: useId(), scrim: useId(), scrimText: useId(), focus: useId() };
  // Custom just chosen: the field shows, seeded with the overlay there is, until a colour is saved or another is picked.
  const [drafting, setDrafting] = useState(false);
  const value = isBackgroundImageValue(raw) ? raw : undefined;
  if (!state) return null;
  const write = (next: BackgroundImageValue, expectedRevision?: number) => onSet(canonicalBackgroundImage(next), expectedRevision);
  // A picture showing through (from All sizes, Default or the design) is shown with its settings, quietly, as any style
  // row shows what comes through; the first change here starts from it, so only the setting changed differs.
  const inherited = !value && isBackgroundImageValue(under) ? under : undefined;
  const shown = value ?? inherited;
  const scrim = shown?.scrim ?? '';
  // Custom chosen over a preset keeps the field open, seeded with that preset, until something is saved.
  const preset = drafting ? 'custom' : SCRIM_PRESETS.some((p) => p.value === scrim) ? scrim : scrim ? 'custom' : '';
  const asset = shown && Object.hasOwn(state.assets.assets, shown.assetId) ? state.assets.assets[shown.assetId] : undefined;
  const devUrl = runtime.state === 'ready' ? runtime.url : null;
  const contain = shown?.size === 'contain';
  // The box the picture fills, measured on the canvas where it shows this size.
  const ratio = previewed && box && box.width > 0 && box.height > 0 ? box.width / box.height : null;
  const swatch = scrim && isScrim(scrim) ? ({ '--overlay': overlayLayer(scrim) } as CSSProperties) : undefined;
  // Removing this picture brings back the one under it, when there is one: the action says which.
  const backLabel = !isBackgroundImageValue(under) ? 'Remove' : underFrom === 'From All sizes' ? 'Use All sizes' : underFrom === 'From Default' ? 'Use Default' : 'Use the design';
  // What a setting changed here reads as: tinted when this value holds it, quiet when it shows through.
  const mark = (set: boolean) => (set ? ' is-set' : ' is-inherited');
  return (
    <div className="style-media" aria-describedby={describedBy} style={swatch}>
      {/* A picture showing through from All sizes or the design shows in the card, with where it comes from. */}
      <ImageEditor
        title={value ? label : underText ? `${label}: ${underText}` : label}
        plain="featured"
        picture={{ inherited: inherited?.assetId ?? null, from: underFrom ?? '', none: 'None', back: backLabel }}
        state={state}
        value={{ assetId: value?.assetId ?? null, alt: '' }}
        onChange={(v) => (v.assetId ? write({ ...(shown ?? {}), assetId: v.assetId }) : onSet(null))}
      />
      {shown && (
        <div className="style-media-options">
          <label htmlFor={ids.fit}>Fill</label>
          <select id={ids.fit} className={`select sm grow style-select${mark(!!value?.size)}`} value={shown.size ?? 'cover'} onChange={(e) => write({ ...shown, size: e.target.value === 'contain' ? 'contain' : undefined })}>
            <option value="cover">Fill the box (crop)</option>
            <option value="contain">Show the whole picture</option>
          </select>
          <label htmlFor={ids.scrim}>Overlay</label>
          <span className={`style-field${swatch && !drafting ? ' has-lead' : ''}`}>
            {swatch && !drafting && <span className="color-chip style-lead style-overlay-swatch" aria-hidden="true" />}
            <select
              id={ids.scrim}
              className={`select sm grow style-select${drafting ? ' is-drafting' : mark(!!value?.scrim)}`}
              value={preset}
              onChange={(e) => {
                const next = e.target.value;
                setDrafting(next === 'custom');
                if (next === 'custom') return;
                write({ ...shown, scrim: next || undefined });
              }}
            >
              <option value="">None</option>
              {SCRIM_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
              {/* An action while nothing custom is set; the name of what is set once there is. */}
              <option value="custom">{scrim && !drafting && preset === 'custom' ? 'Custom' : 'Custom…'}</option>
            </select>
          </span>
          {preset === 'custom' && (
            <div className="style-media-custom">
              <label htmlFor={ids.scrimText}>Color or gradient</label>
              <ColorTextInput
                id={ids.scrimText}
                className={`input sm style-input mono${mark(!!value?.scrim)}`}
                errorClassName="style-media-error"
                value={scrim}
                autoFocus={drafting}
                placeholder="rgba(0, 0, 0, 0.5)"
                ariaLabel={`${label}: overlay color or gradient`}
                problemOf={(text) => (isScrim(normalizeColorText(text)) ? null : { message: OVERLAY_REFUSED })}
                onSave={(s) => {
                  setDrafting(false);
                  return write({ ...shown, scrim: s });
                }}
                onClear={() => {
                  setDrafting(false);
                  return write({ ...shown, scrim: undefined });
                }}
              />
            </div>
          )}
          {/* Nothing is cropped while the whole picture shows: the point is kept for when it fills the box again. */}
          {!contain && (
            <div className="style-media-focus" role="group" aria-labelledby={ids.focus}>
              <span className="style-media-label" id={ids.focus}>
                Focus
              </span>
              <FocusEditor
                label={`${label} focus`}
                value={value?.position}
                under={inherited?.position}
                scope={scope}
                size={size}
                previewed={previewed}
                ratio={ratio}
                fit={shown.size ?? 'cover'}
                backdrop
                image={asset ? { src: assetUrl(devUrl, asset.file), width: asset.width, height: asset.height, below: [] } : { src: null, below: [], missing: 'This picture is no longer in the library.' }}
                onSet={(v, rev) => write({ ...shown, position: v === null ? undefined : String(v) }, rev)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
