import { describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { normalizeLink } from '@engine/values';
import { linkFromTarget } from '@shared/richtext';
import { resolveLink } from '@generator/index';

const fresh = () => createStarterState('business', 'Test Studio', false);
const aboutOf = (s: ProjectState) => Object.values(s.pages).find((p) => p.title === 'About')!;
const headerOf = (s: ProjectState) => s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;

describe('page links written as text', () => {
  it('takes a page route or page ID with a section anchor, as rich text links do', () => {
    const s = fresh();
    const about = aboutOf(s);
    const team = { type: 'page', target: about.id, anchor: 'team' };
    expect(about.route).toBe('/about/');
    for (const v of ['/about/#team', '/about#team', 'about#team', `${about.id}#team`]) {
      expect(normalizeLink(v, s, 'Link'), v).toEqual(team);
      if (v !== 'about#team') expect(linkFromTarget(v, s.pages), v).toEqual(team);
    }
    // Without an anchor, as before.
    expect(normalizeLink('/about/', s, 'Link')).toEqual({ type: 'page', target: about.id });
    expect(normalizeLink('about', s, 'Link')).toEqual({ type: 'page', target: about.id });
    expect(normalizeLink(about.id, s, 'Link')).toEqual({ type: 'page', target: about.id });
    // The home page's route takes an anchor too.
    expect(normalizeLink('/#contact', s, 'Link')).toEqual({ type: 'page', target: s.site.homePageId, anchor: 'contact' });
    // A web address keeps its own fragment, and a section on this page stays one.
    expect(normalizeLink('https://example.com/about/#team', s, 'Link')).toEqual({ type: 'url', target: 'https://example.com/about/#team' });
    expect(normalizeLink('#team', s, 'Link')).toEqual({ type: 'anchor', target: 'team' });
  });

  it('refuses an anchor that is empty or not a valid id, and a page that does not exist', () => {
    const s = fresh();
    for (const v of ['/about/#', '/about/##team', '/about/#9team', '/about/#te am', '/missing/#team']) {
      expect(() => normalizeLink(v, s, 'Link'), v).toThrow(/Link: /);
      expect(linkFromTarget(v, s.pages), v).toBeNull();
    }
  });

  it('stores an anchored route sent to a link property as the page and its section', () => {
    const s = fresh();
    const about = aboutOf(s);
    const header = headerOf(s);
    const r = applyOperations(s, [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header.id, prop: 'ctaLink', value: '/about/#team' }]);
    expect(headerOf(r.state).props.ctaLink).toEqual({ type: 'page', target: about.id, anchor: 'team' });
  });
});

describe('telephone links', () => {
  it('refuses a number with fewer than three digits, which would dial nothing', () => {
    const s = fresh();
    for (const target of ['---', '( )', '...', '+1', '1 2', '(1)-2']) {
      expect(() => normalizeLink({ type: 'tel', target }, s, 'Link'), target).toThrow(/is not a valid telephone number/);
      expect(() => normalizeLink(`tel:${target}`, s, 'Link'), target).toThrow(/is not a valid telephone number/);
      expect(linkFromTarget(`tel:${target}`, s.pages), target).toBeNull();
    }
  });

  it('leaves a number saved before the rule unlinked, and still lets the item around it be edited', () => {
    const s = fresh();
    const header = headerOf(s);
    header.props.links = [{ id: 'i_call', label: 'Call', link: { type: 'tel', target: '---' } }];
    // It goes nowhere on the site, where it used to be an empty tel: link.
    expect(resolveLink({ type: 'tel', target: '---' }, { state: s })).toBeNull();
    expect(resolveLink({ type: 'tel', target: '(1)-2' }, { state: s })).toBeNull();
    const at = { owner: { kind: 'shell' as const, id: 'header' }, nodeId: header.id, prop: 'links', itemId: 'i_call' };
    const r = applyOperations(s, [{ type: 'instance.setProp', ...at, field: 'label', value: 'Call us' }]);
    expect(headerOf(r.state).props.links).toMatchObject([{ id: 'i_call', label: 'Call us', link: { type: 'tel', target: '---' } }]);
    // A number typed now must dial.
    expect(() => applyOperations(r.state, [{ type: 'instance.setProp', ...at, field: 'link', value: { type: 'tel', target: '( )' } }])).toThrow(/is not a valid telephone number/);
  });

  it('keeps numbers that dial', () => {
    const s = fresh();
    for (const target of ['123', '+1 (555) 010', '555-0100', '+44 20 7946 0958']) {
      expect(normalizeLink({ type: 'tel', target }, s, 'Link')).toEqual({ type: 'tel', target });
      expect(linkFromTarget(`tel:${target}`, s.pages)).toEqual({ type: 'tel', target });
      expect(resolveLink({ type: 'tel', target }, { state: s })?.href).toMatch(/^tel:\+?\d{3,}$/);
    }
  });
});
