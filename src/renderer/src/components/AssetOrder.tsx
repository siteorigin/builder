import { useEffect, useMemo, useState } from 'react';
import { ASSET_SORTS, isAssetSort, numberedSeries, type AssetSeries } from '@shared/asset-order';
import type { AssetRecord } from '@shared/types';
import { setAssetSort, useStore } from '../store';

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
        <select className="select sm" aria-label="Numbered series" title="Show only images named alike apart from a number at the end, such as Swatch 1 to Swatch 120" value={value} onChange={(e) => onSeries(e.target.value)}>
          <option value="">All series</option>
          {series.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label} ({s.count})
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
