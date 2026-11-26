/**
 * Renaming the site carries the new name into the shared header and footer that still show the old one (#31): the
 * brand in each, and the footer's standard copyright line. A label or line the author made their own is kept.
 */
import { describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { makeInstance } from '@engine/install';
import { followNote, followsSiteName, keptCopyrightYear, shownCopyright, siteNameNote } from '@shared/site-name';

const apply = (s: ProjectState, ...ops: Parameters<typeof applyOperations>[1]) => applyOperations(s, ops).state;
const shell = (s: ProjectState, part: 'header' | 'footer') => s.site.shell[part].nodes[s.site.shell[part].rootIds[0]] as InstanceNode;

describe('renaming the site', () => {
  for (const starter of ['business', 'blank'] as const) {
    it(`carries the new name into the ${starter} starter's header brand, footer brand and copyright`, () => {
      const s = apply(createStarterState(starter, 'Morning Press', false), { type: 'site.update', name: 'Morning Paper' });
      expect(s.site.name).toBe('Morning Paper');
      expect(shell(s, 'header').props.siteName).toBe('Morning Paper');
      expect(shell(s, 'footer').props.siteName).toBe('Morning Paper');
      expect(shell(s, 'footer').props.copyright).toBe(starter === 'business' ? '© {year} Morning Paper. All rights reserved.' : '© {year} Morning Paper.');
    });
  }

  it('keeps a brand label and a copyright line the author made their own', () => {
    const s0 = createStarterState('business', 'Morning Press', false);
    // Spaces around a label make no difference: it still says the site's name.
    shell(s0, 'header').props.siteName = ' Morning Press ';
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
    // A line showing the year it is built in (#828) follows the same way, and keeps its {year}.
    expect(line('© {year} Acme. All rights reserved.')).toBe('© {year} Northstar. All rights reserved.');
    expect(line('© 2019–{year} Acme.')).toBe('© 2019–{year} Northstar.');
    for (const own of ['© {year} Acme Photography.', '© {year} Acme, Inc.']) expect(line(own)).toBe(own);
    for (const own of ['© 2019–2026 Acme, Inc. Photos by Ana.', '© 2026 Acme Photography.', '© 2026 Acme.com', 'Acme, 2026', 'All of Acme, always.']) expect(line(own)).toBe(own);
    // A name with characters that mean something in a pattern is matched as it is written.
    expect(line('© 2026 A+B (Studio). All rights reserved.', 'A+B (Studio)', 'AB')).toBe('© 2026 AB. All rights reserved.');
  });

  it('follows a label the site build shows from the design’s default, and refuses a name a following label cannot hold', () => {
    const s0 = createStarterState('business', 'Studio', false);
    // Null shows the design's default ("Studio"), as an absent value does.
    shell(s0, 'header').props.siteName = null;
    delete shell(s0, 'footer').props.siteName;
    let s = apply(s0, { type: 'site.update', name: 'Harbour' });
    expect([shell(s, 'header').props.siteName, shell(s, 'footer').props.siteName]).toEqual(['Harbour', 'Harbour']);
    const def = s.components[shell(s, 'header').definitionId];
    def.properties.siteName = { ...def.properties.siteName, maxLength: 8 } as typeof def.properties.siteName;
    expect(() => apply(s, { type: 'site.update', name: 'Harbour Lane' })).toThrow("The header's site name follows the site name and holds at most 8 characters. Use a shorter name, or give the header its own text first.");
    // Nothing was changed, so the header still follows the next name that fits.
    expect(followsSiteName(s, shell(s, 'header'), 'siteName')).toBe(true);
    s = apply(s, { type: 'site.update', name: 'Pine' });
    expect([s.site.name, shell(s, 'header').props.siteName, shell(s, 'footer').props.siteName]).toEqual(['Pine', 'Pine', 'Pine']);
  });

  it('keeps a site name on one line', () => {
    const s = apply(business(), { type: 'site.update', name: 'Morning\n  Paper\r\n' });
    expect([s.site.name, shell(s, 'header').props.siteName, shell(s, 'footer').props.copyright]).toEqual(['Morning Paper', 'Morning Paper', '© {year} Morning Paper. All rights reserved.']);
  });

  it('leaves the site’s other words, and any placement in the footer’s tree other than the footer itself, as they were', () => {
    const s0 = business();
    // Only the top-level placement is the footer: another in its tree (held here without a parent) is not.
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
    const same = apply(s0, { type: 'site.update', name: ' Morning Press ' });
    expect(same.site.name).toBe('Morning Press');
    expect(same.site.shell).toEqual(s0.site.shell);
    const padded = apply(s0, { type: 'site.update', name: '  Morning Paper  ' });
    expect([padded.site.name, shell(padded, 'header').props.siteName]).toEqual(['Morning Paper', 'Morning Paper']);
  });
});

describe('what the editor says about the site’s name', () => {
  it('says under the site’s name where else it shows, and which shared part keeps a name of its own', () => {
    const s = createStarterState('business', 'Morning Press', false);
    expect(siteNameNote(s)).toBe('The header and footer show it too.');
    shell(s, 'footer').props.siteName = 'Morning Press Co.';
    expect(siteNameNote(s)).toBe('The header shows it too. The footer keeps its own name: “Morning Press Co.”');
    shell(s, 'footer').props.siteName = 'Morning Press';
    shell(s, 'header').props.siteName = 'MP';
    expect(siteNameNote(s)).toBe('The footer shows it too. The header keeps its own name: “MP”');
    // A header that shows its logo alone shows no name at all.
    Object.assign(shell(s, 'header').props, { showSiteName: false, logo: { assetId: 'a_logo', alt: 'Morning Press' } });
    expect(siteNameNote(s)).toBe('The footer shows it too.');
    shell(s, 'footer').props.siteName = 'Morning Press Co.';
    s.site.shell.header = { rootIds: [], nodes: {} };
    expect(siteNameNote(s)).toBe('The footer keeps its own name: “Morning Press Co.”');
    s.site.shell.footer = { rootIds: [], nodes: {} };
    expect(siteNameNote(s)).toBeUndefined();
  });

  it('says beside each brand field whether it follows the site’s name, and nothing beside other fields', () => {
    const s = createStarterState('business', 'Morning Press', false);
    shell(s, 'footer').props.copyright = 'Words by the team.';
    expect(followNote(s, shell(s, 'header'), 'siteName')).toEqual({ follows: true, text: expect.stringContaining('Follows the site name') });
    expect(followNote(s, shell(s, 'footer'), 'copyright')).toEqual({ follows: false, text: expect.stringContaining('Its own wording') });
    shell(s, 'footer').props.copyright = '© 2026 Morning Press.';
    expect(followNote(s, shell(s, 'footer'), 'copyright')).toEqual({ follows: true, text: expect.stringContaining('Names the site') });
    shell(s, 'header').props.siteName = 'MP';
    expect(followNote(s, shell(s, 'header'), 'siteName')).toEqual({ follows: false, text: expect.stringContaining('Its own name') });
    expect(followNote(s, shell(s, 'footer'), 'tagline')).toBeUndefined();
    const home = s.pages[s.site.homePageId];
    expect(followNote(s, home.nodes[home.rootIds[0]] as InstanceNode, 'siteName')).toBeUndefined();
  });
});

describe('a copyright line that shows the year it is built in (#828)', () => {
  it('shows the year in place of {year} only in its year position', () => {
    expect(shownCopyright('© {year} Acme. All rights reserved.', 2031)).toBe('© 2031 Acme. All rights reserved.');
    expect(shownCopyright('©{year} Acme', 2031)).toBe('©2031 Acme');
    expect(shownCopyright('© 2019 – {year} Acme', 2031)).toBe('© 2019 – 2031 Acme');
    for (const line of ['© 2026 Acme.', 'Acme {year}', '© Acme {year}', '{year} Acme']) expect(shownCopyright(line, 2031)).toBe(line);
  });

  it('keeps {year} through an edit typed over the shown line, unless the edit changes the year', () => {
    const current = '© {year} Acme. All rights reserved.';
    expect(keptCopyrightYear(current, '© 2031 Acme. Photos by Ana.', 2031)).toBe('© {year} Acme. Photos by Ana.');
    // The page's text, read back from the canvas, may collapse its spaces.
    expect(keptCopyrightYear('©  {year} Acme.', '© 2031 Acme Studio.', 2031)).toBe('© {year} Acme Studio.');
    expect(keptCopyrightYear('© 2019–{year} Acme.', '© 2019–2031 Acme Co.', 2031)).toBe('© 2019–{year} Acme Co.');
    // Another year typed in its place is the author's fixed year, and a line that never said {year} is stored as typed.
    expect(keptCopyrightYear(current, '© 2030 Acme.', 2031)).toBe('© 2030 Acme.');
    expect(keptCopyrightYear(current, '© 20310 Acme.', 2031)).toBe('© 20310 Acme.');
    expect(keptCopyrightYear('© 2031 Acme.', '© 2031 Acme Co.', 2031)).toBe('© 2031 Acme Co.');
    expect(keptCopyrightYear(current, 'Words by Acme.', 2031)).toBe('Words by Acme.');
    const rich = [{ type: 'p' as const, spans: [{ text: '© 2031 Acme' }] }];
    expect(keptCopyrightYear(current, rich, 2031)).toBe(rich);
  });
});
