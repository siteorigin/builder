import { describe, expect, it } from 'vitest';
import type { SavedVersionInfo } from '../../src/shared/api';
import { twinsOf } from '../../src/renderer/src/lib/versions';

const v = (id: string, name: string, time: string): SavedVersionInfo => ({ id, name, time, auto: false, pages: 1, bytes: 1, missing: [] });

describe('twinsOf (#1457)', () => {
  it('tells versions of one name and minute apart by second and place, newest-first list', () => {
    const list = [v('b', 'Approved draft', '2026-11-28T10:00:40Z'), v('a', 'Approved draft', '2026-11-28T10:00:05Z'), v('c', 'Other', '2026-11-28T10:00:10Z')];
    const t = twinsOf(list, 'en-US');
    expect(t.get('a')?.place).toBe('1 of 2 with this name, oldest first');
    expect(t.get('b')?.place).toBe('2 of 2 with this name, oldest first');
    expect(t.get('a')?.precise).not.toBe(t.get('b')?.precise);
    expect(t.get('a')?.precise).toMatch(/:05/);
    expect(t.has('c')).toBe(false);
  });

  it('treats names that differ only in case or spacing as the same', () => {
    const t = twinsOf([v('b', 'approved  draft', '2026-11-28T10:00:40Z'), v('a', 'Approved draft', '2026-11-28T10:00:05Z')]);
    expect(t.size).toBe(2);
  });
});

describe('twinsOf names', () => {
  it('groups names that differ only in Unicode composition', () => {
    const t = twinsOf([v('b', 'Café', '2026-11-28T10:00:40Z'), v('a', 'Café', '2026-11-28T10:00:05Z')]);
    expect(t.size).toBe(2);
  });
});
