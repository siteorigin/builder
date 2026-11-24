/**
 * Library images come out in one defined order (issue #61): 120 numbered swatches imported at once read in
 * sequence whatever order they are stored in and however their import times tie, names sort naturally, and images
 * with the same name keep a fixed place.
 */
import { describe, expect, it } from 'vitest';
import type { AssetRecord } from '@shared/types';
import { assetLabels, compareAssetNames, inSeries, numberedSeries, seriesOf, sortAssets } from '@shared/asset-order';

const asset = (id: string, name: string, createdAt: string): AssetRecord => ({
  id,
  name,
  file: `static/assets/${id}.png`,
  mime: 'image/png',
  bytes: 1000,
  hash: id,
  kind: 'image',
  createdAt
});

const at = (ms: number) => new Date(Date.UTC(2026, 10, 20, 9, 0, 0, ms)).toISOString();
const names = (list: AssetRecord[]) => list.map((a) => a.name);
const swatches = (n: number) => Array.from({ length: n }, (_, i) => `Swatch ${i + 1}`);

/**
 * Swatches 1–120 imported in order, mostly two to a millisecond: the report's library, stored in insertion order.
 * IDs are random, so they say nothing about the order.
 */
function reported(): AssetRecord[] {
  return swatches(120).map((name, i) => asset(`a_${String((i * 919) % 1000).padStart(3, '0')}`, name, at(Math.floor((i + 1) / 2))));
}

describe('asset order', () => {
  it('the reported batch reads 120, 119, 118… newest first, not 120, 118, 119, 116, 117', () => {
    const list = reported();
    // What the Assets panel did before: createdAt only, so ties kept the stored order.
    const before = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    expect(names(before).slice(0, 7)).toEqual(['Swatch 120', 'Swatch 118', 'Swatch 119', 'Swatch 116', 'Swatch 117', 'Swatch 114', 'Swatch 115']);
    expect(names(sortAssets(list, 'newest'))).toEqual(swatches(120).reverse());
    expect(names(sortAssets(list, 'oldest'))).toEqual(swatches(120));
  });

  it('a batch that shares one import time is in name order, whatever order it is stored in', () => {
    const one = at(0);
    // Stored backwards, with IDs that run against the names.
    const stored = swatches(120)
      .map((name, i) => asset(`a_${String(119 - i).padStart(3, '0')}`, name, one))
      .reverse();
    expect(names(sortAssets(stored, 'oldest'))).toEqual(swatches(120));
    expect(names(sortAssets(stored, 'newest'))).toEqual(swatches(120).reverse());
    expect(names(sortAssets(stored, 'name'))).toEqual(swatches(120));
  });

  it('sorts a three-digit sequence by number, not by character, with or without leading zeros', () => {
    const list = ['Swatch 100', 'Swatch 9', 'Swatch 10', 'Swatch 099', 'Swatch 1', 'Swatch 001'].map((n, i) => asset(`a_${i}`, n, at(i)));
    expect(names(sortAssets(list, 'name'))).toEqual(['Swatch 001', 'Swatch 1', 'Swatch 9', 'Swatch 10', 'Swatch 099', 'Swatch 100']);
  });

  it('name order is the same whichever order the images are stored in', () => {
    const list = reported();
    const shuffled = [...list].sort((a, b) => a.id.localeCompare(b.id));
    expect(sortAssets(shuffled, 'name')).toEqual(sortAssets(list, 'name'));
    expect(sortAssets(shuffled, 'newest')).toEqual(sortAssets(list, 'newest'));
    expect(names(sortAssets(list, 'name'))).toEqual(swatches(120));
  });

  it('images with exactly the same name are in date order, whatever order they are stored in', () => {
    const list = [asset('a_1', 'hero', at(9)), asset('a_2', 'hero', at(1)), asset('a_3', 'hero', at(5))];
    expect(sortAssets(list, 'name').map((a) => a.id)).toEqual(['a_2', 'a_3', 'a_1']);
    expect(sortAssets([...list].reverse(), 'name').map((a) => a.id)).toEqual(['a_2', 'a_3', 'a_1']);
  });

  it('images with the same name keep a fixed order: by date, then by ID', () => {
    const list = [asset('a_c', 'hero', at(5)), asset('a_b', 'Hero', at(1)), asset('a_a', 'hero', at(5)), asset('a_d', 'about', at(9))];
    const ids = (sort: 'name' | 'newest' | 'oldest') => sortAssets(list, sort).map((a) => a.id);
    expect(ids('name')).toEqual(['a_d', 'a_b', 'a_a', 'a_c']);
    expect(ids('oldest')).toEqual(['a_b', 'a_a', 'a_c', 'a_d']);
    expect(ids('newest')).toEqual(['a_d', 'a_c', 'a_a', 'a_b']);
    expect(ids('name')).toEqual(sortAssets([...list].reverse(), 'name').map((a) => a.id));
  });

  it('120 swatches imported one by one in a shuffled order: name order reads 1–120, date order follows the times', () => {
    // Swatch k was added at minute (k * 37) % 120: every time different, unrelated to the number.
    const list = swatches(120).map((name, i) => asset(`a_${String(i).padStart(3, '0')}`, name, at((((i + 1) * 37) % 120) * 60_000)));
    const input = names(list);
    expect(names(sortAssets(list, 'name'))).toEqual(swatches(120));
    const byTime = [...list].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    expect(sortAssets(list, 'oldest')).toEqual(byTime);
    expect(sortAssets(list, 'newest')).toEqual([...byTime].reverse());
    expect(names(list)).toEqual(input);
  });

  it('compares times as instants, and puts an image with no readable date last', () => {
    const list = [
      asset('a_1', 'B', '2026-11-20T09:00:00Z'),
      asset('a_2', 'A', '2026-11-20T09:00:00.000Z'),
      asset('a_3', 'C', '2026-11-20T09:00:00.100Z'),
      asset('a_4', 'D', '2026-11-20T10:00:00.000+02:00'),
      asset('a_5', 'E', 'not a date'),
      { ...asset('a_6', 'F', ''), createdAt: undefined as unknown as string },
      // Read in the computer's own zone, so it would sort differently elsewhere: no date.
      asset('a_7', '0', '2026-11-20T09:30:00'),
      // A date alone, and a time set apart by a space, with its zone.
      asset('a_8', 'G', '2026-11-19'),
      asset('a_9', 'H', '2026-11-20 07:00:00Z')
    ];
    expect(names(sortAssets(list, 'oldest'))).toEqual(['G', 'H', 'D', 'A', 'B', 'C', '0', 'E', 'F']);
    expect(names(sortAssets(list, 'newest'))).toEqual(['C', 'B', 'A', 'D', 'H', 'G', 'F', 'E', '0']);
  });

  it('in name order, an image with the same name and a date comes before one without', () => {
    const list = [asset('a_1', 'hero', 'later'), asset('a_2', 'hero', at(5)), asset('a_3', 'hero', at(1))];
    expect(sortAssets(list, 'name').map((a) => a.id)).toEqual(['a_3', 'a_2', 'a_1']);
  });

  it('folds case and accents for order, and spells out the rest by character', () => {
    const list = [asset('a_1', 'Éclair', at(0)), asset('a_2', 'eclair', at(0)), asset('a_3', 'Eclair', at(0)), asset('a_4', 'Dune', at(0)), asset('a_5', 'Fern', at(0))];
    expect(names(sortAssets(list, 'name'))).toEqual(['Dune', 'Eclair', 'eclair', 'Éclair', 'Fern']);
    // The composed and decomposed spellings of é are the same name, so the date decides between them.
    const cafes = [asset('a_1', 'Cafe\u0301', at(9)), asset('a_2', 'Caf\u00e9', at(1)), asset('a_3', 'Cafe\u0301', at(5))];
    expect(sortAssets(cafes, 'name').map((a) => a.id)).toEqual(['a_2', 'a_3', 'a_1']);
  });

  it('an unnamed image comes after the named ones', () => {
    const list = [asset('a_1', '  ', at(0)), asset('a_2', 'Zebra', at(0)), asset('a_3', 'apple', at(0))];
    expect(sortAssets(list, 'name').map((a) => a.id)).toEqual(['a_3', 'a_2', 'a_1']);
    expect(compareAssetNames('', '')).toBe(0);
  });
});

describe('numbered series', () => {
  it('120 swatches form one series beside unrelated photos, whatever their times', () => {
    const list = [
      ...reported(),
      ...swatches(5).map((n, i) => asset(`b_${i}`, n.replace('Swatch', 'Swatch reference'), at(i * 1000))),
      asset('c_1', 'Team photo', at(0)),
      asset('c_2', 'IMG_2301', at(0)),
      asset('c_3', 'IMG 2302', at(0))
    ];
    expect(numberedSeries(list)).toEqual([
      { key: 'img', label: 'IMG', count: 2 },
      { key: 'swatch', label: 'Swatch', count: 120 },
      { key: 'swatch reference', label: 'Swatch reference', count: 5 }
    ]);
    const only = sortAssets(list, 'name').filter((a) => inSeries(a, 'swatch'));
    expect(names(only)).toEqual(swatches(120));
  });

  it('reads the number at the end, with or without a space, hyphen or underscore', () => {
    expect(seriesOf('Swatch 120')).toEqual({ key: 'swatch', stem: 'Swatch', number: '120' });
    expect(seriesOf('Swatch120')).toMatchObject({ key: 'swatch', number: '120' });
    expect(seriesOf('Swatch-007')).toMatchObject({ key: 'swatch', number: '7' });
    expect(seriesOf('light_blue_3')).toMatchObject({ key: 'light blue', stem: 'light_blue' });
    expect(seriesOf('写真 12')).toMatchObject({ key: '写真', number: '12' });
    // A number after another number, set apart by a separator: "Swatch_2026_001.png" imports as "Swatch 2026 001".
    expect(seriesOf('Swatch 2026 001')).toEqual({ key: 'swatch 2026', stem: 'Swatch 2026', number: '1' });
    // Full-width digits are numbers too, and the same numbers as ASCII ones.
    expect(seriesOf('写真 １２')).toMatchObject({ key: '写真', number: '12' });
    expect(seriesOf('Light__Blue -- 3')).toMatchObject({ key: 'light blue', stem: 'Light__Blue' });
    // Arabic-Indic digits are left out rather than read as numbers: "٠١" and "١" would otherwise be two numbers.
    // A stem of accents alone has no letter.
    for (const name of ['Swatch 1.5', 'photo (2)', '2024', '2024 05', '  ', 'Swatch', 'Swatch #4', '12abc', 'IMG ٠١', '\u0301 2026 001']) expect(seriesOf(name), name).toBeNull();
    expect(numberedSeries([asset('a_1', 'IMG ٠١', at(0)), asset('a_2', 'IMG ١', at(0))])).toEqual([]);
    // A letter with an accent still ends a stem.
    expect(seriesOf('Cafe\u0301 3')).toMatchObject({ key: 'café', number: '3' });
  });

  it('finds the number of a name that grows when normalized, near the length limit', () => {
    // 133 characters as stored; normalizing turns each U+0344 into two accents, past 240 characters.
    const stem = `a${'\u0344'.repeat(130)}`;
    const list = [asset('a_1', `${stem} 1`, at(0)), asset('a_2', `${stem} 2`, at(0))];
    expect(numberedSeries(list)).toHaveLength(1);
    expect(list.every((a) => inSeries(a, numberedSeries(list)[0].key))).toBe(true);
  });

  it('stays quick on very long names, even ones built of thousands of accents', () => {
    const digits = `a${'1'.repeat(20_000)}${'_'.repeat(20_000)}x`;
    const accents = `a${'\u0315'.repeat(32_000)}${'\u0300'.repeat(32_000)} 7`;
    const list = [asset('a_1', digits, at(0)), asset('a_2', accents, at(1)), asset('a_3', accents, at(2)), asset('a_4', 'Swatch 1', at(3))];
    const started = performance.now();
    // Only the first 240 characters are read: "a" and a run of ones.
    expect(seriesOf(digits)?.stem).toBe('a');
    expect(numberedSeries(list)).toEqual([]);
    expect(sortAssets(list, 'name').map((a) => a.id)).toEqual(['a_2', 'a_3', 'a_1', 'a_4']);
    assetLabels(list);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('a series needs two different numbers: one image, or one number twice, is not a series', () => {
    expect(numberedSeries([asset('a_1', 'hero 1', at(0)), asset('a_2', 'hero 1', at(1)), asset('a_3', 'Hero 01', at(2)), asset('a_4', 'logo 2', at(0))])).toEqual([]);
    expect(numberedSeries([asset('a_1', 'swatch 1', at(0)), asset('a_2', 'SWATCH 2', at(1)), asset('a_3', 'Swatch 001', at(2))])).toEqual([{ key: 'swatch', label: 'Swatch', count: 3 }]);
    expect(numberedSeries([asset('a_1', 'swatch 1', at(0)), asset('a_2', 'SWATCH 2', at(1)), asset('a_3', 'Swatch 001', at(2)), asset('a_4', 'Swatch 3', at(3))])).toEqual([{ key: 'swatch', label: 'Swatch', count: 4 }]);
  });

  it('a renamed image leaves its series, and a series of one is offered no more', () => {
    const list = [asset('a_1', 'Swatch 1', at(0)), asset('a_2', 'Swatch 2', at(0))];
    expect(numberedSeries(list)).toHaveLength(1);
    list[1] = { ...list[1], name: 'Brand colours' };
    expect(numberedSeries(list)).toEqual([]);
    expect(inSeries(list[1], 'swatch')).toBe(false);
    expect(inSeries(list[0], 'swatch')).toBe(true);
    expect(inSeries(list[0], 'brand colours')).toBe(false);
  });
});

describe('image labels', () => {
  it('adds the ID only where another image has the same name, ignoring case and spaces at the ends', () => {
    const labels = assetLabels([asset('a_1', 'Hero', at(0)), asset('a_2', ' hero ', at(1)), asset('a_3', 'Logo', at(0)), asset('a_4', '', at(0)), asset('a_5', 'HERO', at(2))]);
    expect([...labels]).toEqual([
      ['a_1', { name: 'Hero', label: 'Hero (a_1)' }],
      ['a_2', { name: 'hero', label: 'hero (a_2)' }],
      ['a_3', { name: 'Logo', label: 'Logo' }],
      ['a_4', { name: 'Untitled image', label: 'Untitled image' }],
      ['a_5', { name: 'HERO', label: 'HERO (a_5)' }]
    ]);
  });
});
