/**
 * Each Recent projects card names its project's own folder (#31), so two projects kept side by side never read
 * alike, whatever their names.
 */
import { describe, expect, it } from 'vitest';
import type { RecentProject } from '@shared/api';
import { recentGroups, whereLabels } from '../../src/renderer/src/lib/recent-places';

const recent = (dir: string, name: string, missing = false, pinned = false): RecentProject => ({ dir, name, openedAt: '2026-01-01T00:00:00.000Z', missing, ...(pinned ? { pinned } : {}) });

describe('where a recent project lives', () => {
  it('names each project’s own folder, so projects in the same folder are told apart', () => {
    const labels = whereLabels([recent('/Users/ana/Websites/kloof-light-studio', 'New Kloof Studio'), recent('/Users/ana/Websites/new-site', 'Orchid Garden'), recent('C:\\Users\\ana\\Sites\\cafe', 'Cafe', true)]);
    expect(labels.get('/Users/ana/Websites/kloof-light-studio')).toBe('~/Websites/kloof-light-studio');
    expect(labels.get('/Users/ana/Websites/new-site')).toBe('~/Websites/new-site');
    expect(labels.get('C:\\Users\\ana\\Sites\\cafe')).toBe('~\\Sites\\cafe');
  });

  it('shows the whole path when "~" would make two same-named projects look alike', () => {
    const labels = whereLabels([recent('/Users/ana/Websites/studio', 'Studio'), recent('/Users/ben/Websites/studio', 'Studio'), recent('/Users/ana/Sites/studio', 'Studio')]);
    expect(labels.get('/Users/ana/Websites/studio')).toBe('/Users/ana/Websites/studio');
    expect(labels.get('/Users/ben/Websites/studio')).toBe('/Users/ben/Websites/studio');
    expect(labels.get('/Users/ana/Sites/studio')).toBe('~/Sites/studio');
    // Names that differ tell the cards apart already.
    const named = whereLabels([recent('/Users/ana/Websites/studio', 'Studio'), recent('/Users/ben/Websites/studio', 'Cafe')]);
    expect([...named.values()]).toEqual(['~/Websites/studio', '~/Websites/studio']);
  });
});

describe('the pinned and recent groups on Welcome (#259)', () => {
  // Twenty-two projects, newest first: two sites called Mill Road for two clients, a pinned client whose folder is
  // not named after it, and a pinned Studio whose same-named, unpinned twin is listed in the same kind of folder.
  const all = [
    ...Array.from({ length: 17 }, (_, i) => recent(`/Users/ana/Websites/client-${i + 1}`, `Client ${i + 1}`)),
    recent('/Users/ana/Websites/studio', 'Studio', false, true),
    recent('/Users/ana/Websites/clients/harbour/mill-road', 'Mill Road'),
    recent('/Users/ben/Websites/studio', 'Studio'),
    recent('/Volumes/Work/delivered/mill-road', 'Mill Road', true),
    recent('/Users/ana/Websites/acme', 'Longstanding client', false, true)
  ];
  const dirs = (list: RecentProject[]) => list.map((r) => r.dir);

  it('shows each pinned project above the rest, once, both in the order listed', () => {
    const { pinned, recent: rest } = recentGroups(all, '');
    expect(dirs(pinned)).toEqual(['/Users/ana/Websites/studio', '/Users/ana/Websites/acme']);
    expect(rest).toHaveLength(20);
    expect(dirs(rest)).toEqual(dirs(all.filter((r) => !r.pinned)));
  });

  it('filters both groups by name or folder, and tells same-named projects apart by their own folders', () => {
    // By name alone: nothing in its folder says "longstanding".
    expect(recentGroups(all, 'longstanding')).toEqual({ pinned: [all[21]], recent: [] });
    expect(recentGroups(all, 'acme')).toEqual({ pinned: [all[21]], recent: [] });
    // A match in each group shows both.
    expect(dirs(recentGroups(all, 'studio').pinned)).toEqual(['/Users/ana/Websites/studio']);
    expect(dirs(recentGroups(all, 'studio').recent)).toEqual(['/Users/ben/Websites/studio']);
    // Both Mill Roads match their name; each one's folder finds it alone, missing or not.
    expect(dirs(recentGroups(all, 'mill road').recent)).toEqual(['/Users/ana/Websites/clients/harbour/mill-road', '/Volumes/Work/delivered/mill-road']);
    expect(dirs(recentGroups(all, 'harbour').recent)).toEqual(['/Users/ana/Websites/clients/harbour/mill-road']);
    expect(dirs(recentGroups(all, '/volumes/work').recent)).toEqual(['/Volumes/Work/delivered/mill-road']);
    // The whole path finds a project too, though its card shows "~" for the home folder.
    expect(recentGroups(all, '/users/ana/websites/acme')).toEqual({ pinned: [all[21]], recent: [] });
    // "~" is a way to find what lives in the home folder.
    expect(recentGroups(all, '~/websites/client-1').recent.map((r) => r.name)).toEqual(['Client 1', 'Client 10', 'Client 11', 'Client 12', 'Client 13', 'Client 14', 'Client 15', 'Client 16', 'Client 17']);
    const labels = whereLabels(all);
    expect(labels.get('/Users/ana/Websites/clients/harbour/mill-road')).toBe('~/Websites/clients/harbour/mill-road');
    expect(labels.get('/Volumes/Work/delivered/mill-road')).toBe('/Volumes/Work/delivered/mill-road');
    // Twins in different groups are told apart too: "~" would make the two Studios look alike.
    expect(labels.get('/Users/ana/Websites/studio')).toBe('/Users/ana/Websites/studio');
    expect(labels.get('/Users/ben/Websites/studio')).toBe('/Users/ben/Websites/studio');
  });
});
