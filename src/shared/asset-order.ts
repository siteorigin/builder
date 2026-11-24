import type { AssetRecord } from './types';

/**
 * How library images are listed. Assets, its replace picker, the Inspector's image picker and the image menus share
 * one order, and every order is total: the same images always come out the same way, whatever order they are stored in.
 */
export type AssetSort = 'newest' | 'oldest' | 'name';

export const ASSET_SORTS: ReadonlyArray<{ value: AssetSort; label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'name', label: 'Name (A–Z)' }
];

export const isAssetSort = (v: unknown): v is AssetSort => ASSET_SORTS.some((s) => s.value === v);

// One fixed locale, so two people sharing a project see the same order.
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const raw = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
const text = (v: unknown) => (typeof v === 'string' ? v : '');
/**
 * Names are compared on their first 240 characters (the editor allows 200): normalizing is slow on a name built of
 * thousands of accents, and a project file can hold one.
 */
const clip = (s: string) => (s.length > 240 ? s.slice(0, 240) : s);
const nameOf = (a: AssetRecord) => clip(text(a.name).trim()).normalize('NFC');

/**
 * Natural and case-insensitive: Swatch 2, Swatch 10, Swatch 100. An unnamed image comes after every named one.
 * Names the collator counts as equal ("001" and "1", "hero" and "Hero") are put in a fixed order by their characters.
 */
export function compareAssetNames(a: string, b: string): number {
  if (!a !== !b) return a ? -1 : 1;
  return collator.compare(a, b) || raw(a, b);
}

/**
 * A date, or a time with its zone ("…Z", "…+02:00"). A time without a zone would be read in the computer's own zone,
 * so the same project would sort differently in another one: it counts as no date.
 */
const DATED = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2}))?$/i;
/** When the image was added, as an instant: "…00Z" and "…00.000Z" are the same time. NaN when it is not a date. */
const timeOf = (a: AssetRecord) => {
  const t = text(a.createdAt);
  return DATED.test(t) ? Date.parse(t) : NaN;
};
const byName = (a: AssetRecord, b: AssetRecord) => compareAssetNames(nameOf(a), nameOf(b));
const byId = (a: AssetRecord, b: AssetRecord) => raw(text(a.id), text(b.id));
/** An image with no readable date comes last in either date order. */
const undatedLast = (a: AssetRecord, b: AssetRecord) => Number(Number.isNaN(timeOf(a))) - Number(Number.isNaN(timeOf(b)));
const byTime = (a: AssetRecord, b: AssetRecord) => {
  const x = timeOf(a);
  const y = timeOf(b);
  return Number.isNaN(x) || Number.isNaN(y) || x === y ? 0 : x - y;
};
const oldestFirst = (a: AssetRecord, b: AssetRecord) => byTime(a, b) || byName(a, b) || byId(a, b);

/**
 * Images added at the same moment (one import of many files) are in name order, oldest first, and "Newest first" is
 * "Oldest first" reversed. Images with the same name are told apart by date, then by ID.
 */
export function compareAssets(sort: AssetSort): (a: AssetRecord, b: AssetRecord) => number {
  if (sort === 'name') return (a, b) => byName(a, b) || undatedLast(a, b) || byTime(a, b) || byId(a, b);
  if (sort === 'oldest') return (a, b) => undatedLast(a, b) || oldestFirst(a, b);
  return (a, b) => undatedLast(a, b) || oldestFirst(b, a);
}

export const sortAssets = <T extends AssetRecord>(list: readonly T[], sort: AssetSort): T[] => [...list].sort(compareAssets(sort));

const DIGIT = /\p{Nd}/u;
const SEPARATOR = /[\s_-]/u;
const LETTER = /\p{L}/u;
/** A letter, or an accent on one. */
const LETTERLIKE = /[\p{L}\p{M}]/u;

/**
 * The series a numbered name belongs to (its key, the words before the number, the number), or null. The number
 * follows a letter ("Swatch120") or a space, hyphen or underscore ("Swatch 120", "IMG_2301", "Swatch 2026 001"), and
 * the words before it hold a letter, so a decimal ("Swatch 1.5"), a copy marker ("photo (2)") or a bare number names
 * no series. Read from the end, one character at a time, so a long name costs no more than its length.
 */
export function seriesOf(name: string): { key: string; stem: string; number: string } | null {
  const chars = [...clip(name.trim()).normalize('NFC')];
  let start = chars.length;
  while (start > 0 && DIGIT.test(chars[start - 1])) start--;
  let end = start;
  while (end > 0 && SEPARATOR.test(chars[end - 1])) end--;
  if (start === chars.length || end === 0) return null;
  const last = chars[end - 1];
  if (!(LETTERLIKE.test(last) || (end < start && DIGIT.test(last))) || !chars.slice(0, end).some((c) => LETTER.test(c))) return null;
  const stem = chars.slice(0, end).join('');
  // Full-width digits are the same numbers as ASCII ones. Digits of other scripts are left out, rather than counted
  // as numbers they may not be.
  const digits = chars.slice(start).join('').normalize('NFKC');
  if (!/^[0-9]+$/.test(digits)) return null;
  return { key: stem.replace(/[\s_-]+/gu, ' ').toLocaleLowerCase('en'), stem, number: digits.replace(/^0+(?=\d)/, '') };
}

export interface AssetSeries {
  key: string;
  /** How the series is shown: the words before the number, as the first image of it by name spells them. */
  label: string;
  count: number;
}

/**
 * Images that share a name apart from a number at the end ("Swatch 1" to "Swatch 120"), so related images can be
 * shown on their own without renaming them. A series needs at least two different numbers.
 */
export function numberedSeries(images: readonly AssetRecord[]): AssetSeries[] {
  const groups = new Map<string, { label: string; count: number; numbers: Set<string> }>();
  for (const a of sortAssets(images, 'name')) {
    const s = seriesOf(text(a.name));
    if (!s) continue;
    const g = groups.get(s.key) ?? { label: s.stem, count: 0, numbers: new Set<string>() };
    g.count++;
    g.numbers.add(s.number);
    groups.set(s.key, g);
  }
  return [...groups]
    .filter(([, g]) => g.numbers.size > 1)
    .map(([key, g]) => ({ key, label: g.label, count: g.count }))
    .sort((x, y) => compareAssetNames(x.label, y.label) || raw(x.key, y.key));
}

export const inSeries = (a: AssetRecord, key: string) => seriesOf(text(a.name))?.key === key;

/**
 * What to call each image in a picker or menu: its name, and as its label the name with its ID when another image has
 * the same name, as Assets and the AI chat tell them apart.
 */
export function assetLabels(images: readonly AssetRecord[]): Map<string, { name: string; label: string }> {
  const names = new Map(images.map((a) => [a.id, nameOf(a) || 'Untitled image']));
  const seen = new Map<string, number>();
  for (const n of names.values()) seen.set(n.toLowerCase(), (seen.get(n.toLowerCase()) ?? 0) + 1);
  return new Map([...names].map(([id, name]) => [id, { name, label: (seen.get(name.toLowerCase()) ?? 0) > 1 ? `${name} (${id})` : name }]));
}
