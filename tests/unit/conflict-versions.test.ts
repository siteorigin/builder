/**
 * Comparing the versions of a file in conflict in Project health (#739): a conflict an AI request's rollback left
 * shows what the request tried to save beside the other two, and the check before a choice covers all three.
 */
import { describe, expect, it } from 'vitest';
import { conflictPanes, sameVersions, savedCopyLabel } from '../../src/renderer/src/lib/conflict-versions';

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
  });

  it('labels a saved copy of the attempted version as the AI’s', () => {
    expect(savedCopyLabel('attempted')).toBe('The AI request’s attempted version');
    expect(savedCopyLabel('external')).toBe('The file as edited outside SiteOrigin Builder');
    expect(savedCopyLabel('builder')).toBe('SiteOrigin Builder’s version');
  });
});
