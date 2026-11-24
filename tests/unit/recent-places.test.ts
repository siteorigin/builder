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
  // Twenty-one projects, newest first: two sites called Mill Road for two clients, and a pinned client opened long ago.
  const all = [
    ...Array.from({ length: 18 }, (_, i) => recent(`/Users/ana/Websites/client-${i + 1}`, `Client ${i + 1}`)),
    recent('/Users/ana/Websites/clients/harbour/mill-road', 'Mill Road'),
    recent('/Volumes/Work/delivered/mill-road', 'Mill Road', true),
    recent('/Users/ana/Websites/longstanding-client', 'Longstanding client', false, true)
  ];
  const dirs = (list: RecentProject[]) => list.map((r) => r.dir);

  it('shows each pinned project above the rest, once, in the order listed', () => {
    const { pinned, recent: rest } = recentGroups(all, '');
    expect(dirs(pinned)).toEqual(['/Users/ana/Websites/longstanding-client']);
    expect(rest).toHaveLength(20);
    expect(dirs(rest)).toEqual(dirs(all.slice(0, 20)));
  });

  it('filters both groups by name or folder, and tells same-named projects apart by their own folders', () => {
    expect(dirs(recentGroups(all, 'longstanding').pinned)).toEqual(['/Users/ana/Websites/longstanding-client']);
    expect(recentGroups(all, 'longstanding').recent).toEqual([]);
    // Both Mill Roads match their name; each one's folder finds it alone, missing or not.
    expect(dirs(recentGroups(all, 'mill road').recent)).toEqual(['/Users/ana/Websites/clients/harbour/mill-road', '/Volumes/Work/delivered/mill-road']);
    expect(dirs(recentGroups(all, 'harbour').recent)).toEqual(['/Users/ana/Websites/clients/harbour/mill-road']);
    expect(dirs(recentGroups(all, '/volumes/work').recent)).toEqual(['/Volumes/Work/delivered/mill-road']);
    // "~" is a way to find what lives in the home folder.
    expect(recentGroups(all, '~/websites/client-1').recent.map((r) => r.name)).toEqual(['Client 1', 'Client 10', 'Client 11', 'Client 12', 'Client 13', 'Client 14', 'Client 15', 'Client 16', 'Client 17', 'Client 18']);
    const labels = whereLabels(all);
    expect(labels.get('/Users/ana/Websites/clients/harbour/mill-road')).toBe('~/Websites/clients/harbour/mill-road');
    expect(labels.get('/Volumes/Work/delivered/mill-road')).toBe('/Volumes/Work/delivered/mill-road');
  });
});
