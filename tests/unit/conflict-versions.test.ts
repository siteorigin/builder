/**
 * Comparing the versions of a file in conflict in Project health (#739): a conflict an AI request's rollback left
 * shows what the request tried to save beside the other two, and the check before a choice covers all three.
 */
import { describe, expect, it } from 'vitest';
import { conflictPanes, diffCaption, lineDiff, sameVersions, savedCopyDay, savedCopyLabel, shownVersions } from '../../src/renderer/src/lib/conflict-versions';

const before = { state: 'text' as const, text: '{ "name": "Persist" }' };
const disk = { state: 'text' as const, text: '{ "name": "Persist", "description": "Edited by hand" }' };
const attempted = { state: 'text' as const, text: '{ "name": "AI name" }' };

describe('comparing the versions of a file in conflict', () => {
  it('shows three labelled panes for a conflict an AI rollback left', () => {
    expect(conflictPanes('canonical', { builder: before, disk, attempted })).toEqual([
      { key: 'builder', label: 'SiteOrigin Builder’s version, from before the AI request', version: before },
      { key: 'disk', label: 'The file on disk now, edited outside SiteOrigin Builder', version: disk },
      { key: 'attempted', label: 'The version the AI request tried to save (shown only, not a choice)', version: attempted }
    ]);
  });

  it('shows a file the run created or deleted as missing in the version that has none', () => {
    const created = conflictPanes('canonical', { builder: { state: 'missing' }, disk, attempted });
    expect(created.map((p) => p.version)).toEqual([{ state: 'missing' }, disk, attempted]);
    const deleted = conflictPanes('canonical', { builder: before, disk, attempted: { state: 'missing' } });
    expect(deleted.map((p) => [p.key, p.version])).toEqual([
      ['builder', before],
      ['disk', disk],
      ['attempted', { state: 'missing' }]
    ]);
  });

  it('shows the two versions it always has, with the same labels, for every other conflict', () => {
    expect(conflictPanes('canonical', { builder: before, disk })).toEqual([
      { key: 'builder', label: 'SiteOrigin Builder’s version', version: before },
      { key: 'disk', label: 'The file on disk, edited outside SiteOrigin Builder', version: disk }
    ]);
    expect(conflictPanes('generated', { builder: before, disk }).map((p) => p.label)).toEqual(['SiteOrigin Builder’s version, made from your pages', 'The file on disk, edited outside SiteOrigin Builder']);
  });

  it('chooses nothing when any version shown changed, the attempted one included', () => {
    const shown = { builder: before, disk, attempted };
    expect(sameVersions(shown, { builder: before, disk, attempted: { ...attempted } })).toBe(true);
    expect(sameVersions(shown, { builder: before, disk, attempted: { state: 'unreadable' } })).toBe(false);
    expect(sameVersions(shown, { builder: before, disk })).toBe(false);
    expect(sameVersions(shown, { builder: before, disk: { state: 'missing' }, attempted })).toBe(false);
    expect(sameVersions({ builder: before, disk }, { builder: before, disk })).toBe(true);
    expect(sameVersions({ builder: before, disk }, { builder: before, disk, attempted })).toBe(false);
    // Text that changed while the state did not, in any version.
    expect(sameVersions(shown, { builder: { ...before, text: 'other' }, disk, attempted })).toBe(false);
    expect(sameVersions(shown, { builder: before, disk, attempted: { ...attempted, text: 'other' } })).toBe(false);
  });

  it('keeps the attempted version of a compare answer only when the answer has one', () => {
    expect(shownVersions({ builder: before, disk, attempted })).toEqual({ builder: before, disk, attempted });
    expect(shownVersions({ builder: before, disk })).toEqual({ builder: before, disk });
    expect('attempted' in shownVersions({ builder: before, disk, attempted: undefined })).toBe(false);
  });

  it('labels a saved copy of the attempted version as the AI’s', () => {
    expect(savedCopyLabel({ side: 'attempted' })).toBe('The AI request’s attempted version');
    expect(savedCopyLabel({ side: 'attempted', removed: true })).toBe('The AI request’s attempted version, which removed the file');
    expect(savedCopyLabel({ side: 'external' })).toBe('The file as edited outside SiteOrigin Builder');
    expect(savedCopyLabel({ side: 'builder' })).toBe('SiteOrigin Builder’s version');
  });
});

describe('marking what differs between two versions', () => {
  it('marks the changed line on each side, and nothing else', () => {
    const a = '{\n  "title": "About",\n  "route": "/about/"\n}';
    const b = '{\n  "title": "About the studio",\n  "route": "/about/"\n}';
    expect([...lineDiff(a, b).changed]).toEqual([1]);
    expect([...lineDiff(b, a).changed]).toEqual([1]);
    // A line replaced is a change on both sides, not also a gap.
    expect(lineDiff(a, b)).toEqual({ changed: new Set([1]), gaps: new Set(), missing: 0, approximate: false });
    expect(lineDiff(a, a)).toEqual({ changed: new Set(), gaps: new Set(), missing: 0, approximate: false });
  });

  it('says where the other version has lines this one lacks, rather than that nothing differs', () => {
    const short = 'one\nthree';
    const long = 'one\ntwo\nthree';
    expect(lineDiff(long, short)).toMatchObject({ changed: new Set([1]), missing: 0 });
    expect(lineDiff(short, long)).toEqual({ changed: new Set(), gaps: new Set([1]), missing: 1, approximate: false });
    // Lines only at the end of the other version: the gap is after the last line.
    expect(lineDiff('one', 'one\ntwo')).toMatchObject({ gaps: new Set([1]), missing: 1 });
  });

  it('marks the whole middle, and says so, when the versions are too long to match line by line', () => {
    const many = (tag: string) => ['same', ...Array.from({ length: 2100 }, (_, i) => `${tag}${i}`), 'end'].join('\n');
    const d = lineDiff(many('a'), many('b'));
    expect(d.approximate).toBe(true);
    expect(d.changed.size).toBe(2100);
    expect(d.changed.has(0)).toBe(false);
    // Said as where it starts, never as an exact count, and without spreading the marked lines.
    expect(diffCaption(d)).toBe('Differs from line 2');
    const huge = (tag: string) => Array.from({ length: 200_000 }, (_, i) => `${tag}${i}`).join('\n');
    expect(diffCaption(lineDiff(huge('a'), huge('b')))).toBe('Differs from line 1');
  });

  it('captions both what differs here and what is only in the other version', () => {
    expect(diffCaption(lineDiff('a\nx\nc', 'a\ny\nc'))).toBe('1 line differs');
    expect(diffCaption(lineDiff('a\nx\nc', 'a\ny\nc\nd\ne'))).toBe('1 line differs, and 2 lines only in the other version');
    expect(diffCaption(lineDiff('a\nc', 'a\nb\nc'), 'SiteOrigin Builder’s version')).toBe('A line only in SiteOrigin Builder’s version');
    expect(diffCaption(lineDiff('a', 'a'))).toBe('Same as the other version');
  });
});

describe('the day a saved copy is listed under', () => {
  const now = new Date(2026, 10, 27, 9, 30).getTime();
  it('says Today and Yesterday by the calendar day, not the last 24 hours', () => {
    expect(savedCopyDay(new Date(2026, 10, 27, 0, 5).getTime(), now)).toBe('Today');
    expect(savedCopyDay(new Date(2026, 10, 26, 23, 55).getTime(), now)).toBe('Yesterday');
    expect(savedCopyDay(new Date(2026, 10, 26, 0, 1).getTime(), now)).toBe('Yesterday');
  });
  it('names an earlier day by its date, with the year only when it is not this one', () => {
    expect(savedCopyDay(new Date(2026, 9, 24, 12).getTime(), now)).not.toMatch(/2026/);
    expect(savedCopyDay(new Date(2025, 9, 24, 12).getTime(), now)).toMatch(/2025/);
  });
});
