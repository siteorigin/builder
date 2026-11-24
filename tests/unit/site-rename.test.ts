/**
 * Renaming the site carries the new name into the shared header and footer that still show the old one (#31): the
 * brand in each, and the footer's standard copyright line. A label or line the author made their own is kept.
 */
import { describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { makeInstance } from '@engine/install';
import { followsSiteName } from '@shared/site-name';

const apply = (s: ProjectState, ...ops: Parameters<typeof applyOperations>[1]) => applyOperations(s, ops).state;
const shell = (s: ProjectState, part: 'header' | 'footer') => s.site.shell[part].nodes[s.site.shell[part].rootIds[0]] as InstanceNode;
const year = new Date().getFullYear();

describe('renaming the site', () => {
  for (const starter of ['business', 'blank'] as const) {
    it(`carries the new name into the ${starter} starter's header brand, footer brand and copyright`, () => {
      const s = apply(createStarterState(starter, 'Morning Press', false), { type: 'site.update', name: 'Morning Paper' });
      expect(s.site.name).toBe('Morning Paper');
      expect(shell(s, 'header').props.siteName).toBe('Morning Paper');
      expect(shell(s, 'footer').props.siteName).toBe('Morning Paper');
      expect(shell(s, 'footer').props.copyright).toBe(starter === 'business' ? `© ${year} Morning Paper. All rights reserved.` : `© ${year} Morning Paper.`);
    });
  }

  it('keeps a brand label and a copyright line the author made their own', () => {
    const s0 = createStarterState('business', 'Morning Press', false);
    shell(s0, 'footer').props.siteName = 'Morning Press Co.';
    shell(s0, 'footer').props.copyright = 'All words by the Morning Press team.';
    const s = apply(s0, { type: 'site.update', name: 'Morning Paper' });
    expect(shell(s, 'header').props.siteName).toBe('Morning Paper');
    expect(shell(s, 'footer').props.siteName).toBe('Morning Press Co.');
    expect(shell(s, 'footer').props.copyright).toBe('All words by the Morning Press team.');
  });
});

describe('what follows a rename and what the author keeps', () => {
  const business = () => createStarterState('business', 'Morning Press', false);

  it('keeps an author’s label that a rename makes equal to the site’s name, until the author edits it', () => {
    const s0 = business();
    shell(s0, 'header').props.siteName = 'Field Notes';
    // The site takes the masthead's name: nothing changes on the page, and nothing yet follows the site either.
    let s = apply(s0, { type: 'site.update', name: 'Field Notes' });
    expect(shell(s, 'header').props.siteName).toBe('Field Notes');
    expect(followsSiteName(s, shell(s, 'header'), 'siteName')).toBe(false);
    expect(followsSiteName(s, shell(s, 'footer'), 'siteName')).toBe(true);
    s = apply(s, { type: 'site.update', name: 'Field Notes Archive' });
    expect(shell(s, 'header').props.siteName).toBe('Field Notes');
    expect(shell(s, 'header').keepsText).toBeUndefined();
    expect(shell(s, 'footer').props.siteName).toBe('Field Notes Archive');
    // Choosing the site's name again makes the label follow it.
    s = apply(s, { type: 'site.update', name: 'Field Notes' });
    const header = { kind: 'shell' as const, id: 'header' };
    s = apply(s, { type: 'instance.setProp', owner: header, nodeId: shell(s, 'header').id, prop: 'siteName', value: 'Field Notes' });
    expect(shell(s, 'header').keepsText).toBeUndefined();
    expect(followsSiteName(s, shell(s, 'header'), 'siteName')).toBe(true);
    s = apply(s, { type: 'site.update', name: 'Trail Journal' });
    expect(shell(s, 'header').props.siteName).toBe('Trail Journal');
  });

  it('follows the holder of a copyright line through a range of years and words after it, but not a longer name', () => {
    const line = (copyright: string, from = 'Acme', to = 'Northstar') => {
      const s0 = createStarterState('business', from, false);
      shell(s0, 'footer').props.copyright = copyright;
      return shell(apply(s0, { type: 'site.update', name: to }), 'footer').props.copyright;
    };
    expect(line('© 2019–2026 Acme. All rights reserved.')).toBe('© 2019–2026 Northstar. All rights reserved.');
    expect(line('© 2026 Acme. Photos by Ana.')).toBe('© 2026 Northstar. Photos by Ana.');
    expect(line('© 2026 Acme')).toBe('© 2026 Northstar');
    for (const own of ['© 2019–2026 Acme, Inc. Photos by Ana.', '© 2026 Acme Photography.', '© 2026 Acme.com', 'Acme, 2026', 'All of Acme, always.']) expect(line(own)).toBe(own);
    // A name with characters that mean something in a pattern is matched as it is written.
    expect(line('© 2026 A+B (Studio). All rights reserved.', 'A+B (Studio)', 'AB')).toBe('© 2026 AB. All rights reserved.');
  });

  it('leaves the site’s other words, and a component inside the footer that shows a name, as they were', () => {
    const s0 = business();
    const credit = makeInstance(s0.components[shell(s0, 'footer').definitionId], { siteName: 'Morning Press' });
    s0.site.shell.footer.nodes[credit.id] = credit;
    const s = apply(s0, { type: 'site.update', name: 'Morning Paper' });
    expect((s.site.shell.footer.nodes[credit.id] as InstanceNode).props.siteName).toBe('Morning Press');
    expect(s.site.description).toBe(s0.site.description);
    expect(JSON.stringify(s.pages)).toBe(JSON.stringify(s0.pages));
  });

  it('refuses a name with no words, and changes nothing for the name the site already has', () => {
    const s0 = business();
    expect(() => apply(s0, { type: 'site.update', name: '   ' })).toThrow(/needs a name/);
    expect(apply(s0, { type: 'site.update', name: ' Morning Press ' }).site.shell).toEqual(s0.site.shell);
  });
});
