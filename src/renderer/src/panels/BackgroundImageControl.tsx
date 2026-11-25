import { useId } from 'react';
import type { BackgroundImageValue, StyleValue } from '@shared/types';
import { canonicalBackgroundImage, isBackgroundImageValue } from '@shared/background-image';
import { parseFocus, formatFocus } from '@shared/focus';
import { isScrim } from '@shared/styles';
import { DraftInput } from '../components/ui';
import { useStore } from '../store';
import { SiteImageField } from './PropEditors';

/** Scrims to start from: a colour or gradient over the picture, so text on top stays readable. */
export const SCRIM_PRESETS: Array<{ value: string; label: string }> = [
  { value: 'rgba(0, 0, 0, 0.45)', label: 'Darken' },
  { value: 'rgba(0, 0, 0, 0.65)', label: 'Darken strongly' },
  { value: 'rgba(255, 255, 255, 0.75)', label: 'Lighten' },
  { value: 'linear-gradient(to bottom, rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.7))', label: 'Darken toward the bottom' },
  { value: 'linear-gradient(to right, rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0))', label: 'Darken from the left' }
];

/** How a background image reads in the panel: what it fills and whether it has a scrim. */
export function describeBackgroundImage(v: StyleValue | undefined): string {
  if (!isBackgroundImageValue(v)) return '';
  const preset = SCRIM_PRESETS.find((p) => p.value === v.scrim);
  return ['Picture', v.size === 'contain' ? 'whole' : 'filling', v.scrim ? (preset ? preset.label.toLowerCase() : 'with a scrim') : 'no scrim'].join(' · ');
}

/**
 * The Background image control: the picture, chosen from the library as a site image is (no description: it is
 * decoration), and once there is one, how it fills the box, the point kept in view and a scrim. Each change is one
 * edit of the whole value; None removes it here, so what the design or All sizes sets shows through.
 */
export function BackgroundImageControl({ label, value: raw, underText, describedBy, onSet }: { label: string; value: StyleValue | undefined; underText: string; describedBy?: string; onSet: (v: StyleValue | null) => void }) {
  const state = useStore((s) => s.snapshot?.state);
  const ids = { fit: useId(), focus: useId(), scrim: useId(), scrimText: useId() };
  const value = isBackgroundImageValue(raw) ? raw : undefined;
  if (!state) return null;
  const write = (next: BackgroundImageValue) => onSet(canonicalBackgroundImage(next));
  const focus = value ? formatFocus(parseFocus(value.position ?? 'center') ?? { x: 50, y: 50 }) : '';
  const scrim = value?.scrim ?? '';
  const preset = SCRIM_PRESETS.some((p) => p.value === scrim) ? scrim : scrim ? 'custom' : '';
  return (
    <div className="style-media" aria-describedby={describedBy}>
      <SiteImageField title={value ? label : underText ? `${label}: ${underText}` : label} plain="featured" state={state} value={value?.assetId ?? null} onChange={(id) => (id ? write({ ...(value ?? {}), assetId: id }) : onSet(null))} />
      {value && (
        <div className="style-media-options">
          <label htmlFor={ids.fit}>Fill</label>
          <select id={ids.fit} className="select sm grow style-select is-set" value={value.size ?? 'cover'} onChange={(e) => write({ ...value, size: e.target.value === 'contain' ? 'contain' : 'cover' })}>
            <option value="cover">Fill the box (crop)</option>
            <option value="contain">Show the whole picture</option>
          </select>
          <label htmlFor={ids.focus}>Focus</label>
          <DraftInput
            id={ids.focus}
            className="input sm grow style-input mono is-set"
            value={focus}
            placeholder="50% 50%"
            ariaLabel={`${label}: focus, across and down`}
            onCommit={(text) => {
              const p = parseFocus(text.trim() || 'center');
              if (!p) return false;
              write({ ...value, position: formatFocus(p) });
            }}
          />
          <label htmlFor={ids.scrim}>Scrim</label>
          <select id={ids.scrim} className={`select sm grow style-select${scrim ? ' is-set' : ''}`} value={preset} onChange={(e) => (e.target.value === 'custom' ? undefined : write({ ...value, scrim: e.target.value || undefined }))}>
            <option value="">None</option>
            {SCRIM_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
            {preset === 'custom' && <option value="custom">Custom</option>}
          </select>
          <DraftInput
            id={ids.scrimText}
            className={`input sm grow style-input mono${scrim ? ' is-set' : ''}`}
            value={scrim}
            placeholder="rgba(0, 0, 0, 0.5) or a gradient"
            ariaLabel={`${label}: scrim color or gradient`}
            onCommit={(text) => {
              const s = text.trim();
              if (s && !isScrim(s)) return false;
              write({ ...value, scrim: s || undefined });
            }}
          />
        </div>
      )}
    </div>
  );
}
