import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ASSET_SORTS, isAssetSort, numberedSeries, type AssetSeries } from '@shared/asset-order';
import type { AssetRecord } from '@shared/types';
import { setAssetSort, useStore } from '../store';

/**
 * A name shortened to about `room` characters for a thumbnail caption. It keeps its first and last words, since
 * versions, sizes and numbers live at the end ("team offsite … 1100"), cut at word boundaries where there are any.
 * Assets and the gallery picker caption their tiles the same way.
 */
export function shortName(name: string, room = 30): string {
  if (name.length <= room) return name;
  const headRoom = Math.round(room * 0.47);
  let head = name.slice(0, headRoom);
  if (head.lastIndexOf(' ') > headRoom / 2) head = head.slice(0, head.lastIndexOf(' '));
  // Room the head gave back by stopping at a word goes to the ending.
  const tailRoom = room - head.trimEnd().length - 3;
  const space = name.lastIndexOf(' ', name.length - 6);
  const tail = space > head.length && name.length - space - 1 <= tailRoom ? name.slice(space + 1) : name.slice(-Math.max(4, tailRoom - 2));
  return `${head.trimEnd()} … ${tail.trimStart()}`;
}

/**
 * A name split so its last word can be kept whole while the rest is cut to fit a single line:
 * ["team offsite 2026", "1100"]. A name with no short last word comes back whole.
 */
export function splitEnding(name: string): [string, string] {
  const space = name.lastIndexOf(' ');
  if (space <= 0 || name.length - space - 1 > 12) return [name, ''];
  return [name.slice(0, space), name.slice(space + 1)];
}

/**
 * The numbered series among these images, and the one chosen to show. A choice the images no longer have (renamed,
 * removed, undone) is dropped rather than left hiding everything; a new `opening` starts with every series.
 */
export function useAssetSeries(images: readonly AssetRecord[], opening: unknown) {
  const list = useMemo(() => numberedSeries(images), [images]);
  const [chosen, setChosen] = useState('');
  useEffect(() => setChosen(''), [opening]);
  const key = chosen && list.some((s) => s.key === chosen) ? chosen : '';
  useEffect(() => {
    if (chosen && !key) setChosen('');
  }, [chosen, key]);
  return { list, key, choose: setChosen, label: list.find((s) => s.key === key)?.label ?? '' };
}

/**
 * How images are ordered, and which numbered series to show when the library has any. Assets and the Inspector's
 * picker show the same controls, and changing the order in one changes it in both.
 */
export function AssetOrderControls({ series, value, onSeries }: { series: AssetSeries[]; value: string; onSeries: (key: string) => void }) {
  const sort = useStore((s) => s.assetSort);
  const chosen = series.find((s) => s.key === value);
  const seriesRef = useRef<HTMLSelectElement>(null);
  return (
    <div className="asset-order">
      <select className="select sm" aria-label="Sort images" title="Sort images" value={sort} onChange={(e) => isAssetSort(e.target.value) && setAssetSort(e.target.value)}>
        {ASSET_SORTS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {series.length > 0 && (
        // A chosen series is marked as a filter in force, with its full name in the tooltip and a way to clear it.
        <span className={`asset-series${chosen ? ' active' : ''}`}>
          <select ref={seriesRef} className="select sm" aria-label="Numbered series" title={chosen ? `Showing only ${chosen.label} (${chosen.count})` : 'Show only images named alike apart from a number at the end, such as Swatch 1 to Swatch 120'} value={value} onChange={(e) => onSeries(e.target.value)}>
            {/* No series chosen shows every image, series or not. */}
            <option value="">All images</option>
            {series.map((s) => {
              // Shortened in the middle, count included, so "selects 01" and "selects 03" still differ and fit.
              const count = ` (${s.count})`;
              return (
                <option key={s.key} value={s.key} title={s.label}>
                  {shortName(s.label, Math.max(12, 24 - count.length))}
                  {count}
                </option>
              );
            })}
          </select>
          {chosen && (
            <button
              className="icon-btn sm asset-series-clear"
              aria-label={`Show all images, not only ${chosen.label}`}
              title="Show all images"
              onClick={() => {
                onSeries('');
                seriesRef.current?.focus();
              }}
            >
              <X />
            </button>
          )}
        </span>
      )}
    </div>
  );
}
