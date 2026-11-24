/**
 * Each Recent projects card names its project's own folder (#31), so two projects kept side by side never read
 * alike, whatever their names.
 */
import { describe, expect, it } from 'vitest';
import type { RecentProject } from '@shared/api';
import { whereLabels } from '../../src/renderer/src/lib/recent-places';

const recent = (dir: string, name: string, missing = false): RecentProject => ({ dir, name, openedAt: '2026-01-01T00:00:00.000Z', missing });

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
