import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { validateState } from '@engine/validate';
import { commandText, matchesWords, pageChoices } from '../../src/renderer/src/lib/page-switch';

/** The issue's studio site: two pages titled Portfolio, at /lookbook/ and /portfolio-archive/. */
function twoPortfolios() {
  const s = structuredClone(createStarterState('business', 'Test Studio', false)) as ProjectState;
  const [, a, b] = s.site.pageOrder;
  s.pages[a].title = 'Portfolio';
  s.pages[a].route = '/lookbook/';
  s.pages[b].title = 'Portfolio';
  s.pages[b].route = '/portfolio-archive/';
  return { s, a, b };
}

describe('page switchers', () => {
  it('lists every page in site order with its published address, and `/` for the home page', () => {
    const { s, a, b } = twoPortfolios();
    const choices = pageChoices(s);
    expect(choices.map((c) => c.id)).toEqual(s.site.pageOrder);
    expect(choices.find((c) => c.id === a)).toMatchObject({ title: 'Portfolio', address: '/lookbook/', home: false });
    expect(choices.find((c) => c.id === b)).toMatchObject({ title: 'Portfolio', address: '/portfolio-archive/', home: false });
    const home = choices.find((c) => c.id === s.site.homePageId)!;
    expect(home).toMatchObject({ address: '/', home: true });
    expect(choices.filter((c) => c.home)).toHaveLength(1);
  });

  it('keeps same-title pages valid and gives each a distinct choice', () => {
    const { s } = twoPortfolios();
    const before = validateState(createStarterState('business', 'Test Studio', false)).length;
    expect(validateState(s).length).toBeLessThanOrEqual(before);
    const same = pageChoices(s).filter((c) => c.title === 'Portfolio');
    expect(same).toHaveLength(2);
    expect(new Set(same.map((c) => c.address)).size).toBe(2);
  });

  it('follows a renamed title or address', () => {
    const { s, a, b } = twoPortfolios();
    s.pages[a].title = 'Lookbook';
    s.pages[b].route = '/archive/';
    const choices = pageChoices(s);
    expect(choices.find((c) => c.id === a)).toMatchObject({ title: 'Lookbook', address: '/lookbook/' });
    expect(choices.find((c) => c.id === b)).toMatchObject({ title: 'Portfolio', address: '/archive/' });
  });

  it('skips a page id that has no page', () => {
    const { s } = twoPortfolios();
    s.site.pageOrder.push('missing');
    expect(pageChoices(s).map((c) => c.id)).not.toContain('missing');
  });

  it('matches a command by its address as well as its title', () => {
    const { s, a, b } = twoPortfolios();
    const entries = pageChoices(s).map((c) => ({ id: c.id, text: commandText(`Go to ${c.title}`, c.address) }));
    const find = (q: string) => entries.filter((e) => matchesWords(q, e.text)).map((e) => e.id);
    expect(find('/lookbook/')).toEqual([a]);
    expect(find('lookbook')).toEqual([a]);
    expect(find('portfolio-archive')).toEqual([b]);
    expect(find('go portfolio').sort()).toEqual([a, b].sort());
    expect(find('portfolio /lookbook/')).toEqual([a]);
    expect(find('/nothing-here/')).toEqual([]);
  });

  it('matches words in any order and case, and everything for an empty query', () => {
    expect(matchesWords('', 'Undo')).toBe(true);
    expect(matchesWords('   ', 'Undo')).toBe(true);
    expect(matchesWords('PAGE go', 'Go to page')).toBe(true);
    expect(matchesWords('go nowhere', 'Go to page')).toBe(false);
  });
});
