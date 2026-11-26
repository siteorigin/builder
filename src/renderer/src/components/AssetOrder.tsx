import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ASSET_SORTS, isAssetSort, numberedSeries, type AssetSeries } from '@shared/asset-order';
import type { AssetRecord } from '@shared/types';
import { setAssetSort, useStore } from '../store';

/**
 * A name shortened to at most `room` characters for a thumbnail caption. Versions, sizes and numbers live at the end
 * ("team offsite … 1100", "brand … selects 03"), so the last word is kept whole first and the first word gets what is
 * left; then whole words are added to the ending, then to the start, while they fit. A word is cut only when it can't
 * fit whole: the first word to make room for the last, or a last word too long to keep beside anything.
 * Assets and the gallery picker caption their tiles the same way.
 */
export function shortName(name: string, room = 30): string {
  if (name.length <= room) return name;
  const fit = room - 3; // what the head and the tail share, around " … "
  const words = name.split(' ').filter(Boolean);
  if (words.length < 2) {
    const headRoom = Math.ceil(fit / 2);
    return `${name.slice(0, headRoom)} … ${name.slice(-(fit - headRoom))}`;
  }
  const lastWord = words[words.length - 1];
  if (lastWord.length > fit - 4) {
    // The last word alone nearly fills the room: a short start, then as much of its ending as fits.
    const head = words[0].slice(0, Math.min(words[0].length, Math.ceil(fit / 2)));
    return `${head} … ${lastWord.slice(-(fit - head.length))}`;
  }
  let tail = lastWord;
  let head = words[0].slice(0, fit - tail.length);
  const headWhole = head === words[0];
  let first = 1;
  let last = words.length - 1;
  // Whole words onto the ending, then onto the start (only after a whole first word).
  while (last > first && head.length + words[last - 1].length + 1 + tail.length <= fit) tail = `${words[--last]} ${tail}`;
  while (headWhole && first < last && head.length + 1 + words[first].length + tail.length <= fit) head += ` ${words[first++]}`;
  return `${head} … ${tail}`;
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
