/**
 * Site styles' AI agents and Visitor text sections: what their closed headings say, the language names, the warning
 * for a wording that leaves out a fill-in, and the marks a changed wording carries.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectState, SiteDoc } from '@shared/types';
import { VISITOR_TEXT_GROUPS, type VisitorTextField } from '@shared/visitor-text';

/** Renderer code, outside the Node type-check project: loaded by path at run time. */
const AGENTS_PATH = '../../src/renderer/src/panels/AgentDiscovery';
const VISITOR_PATH = '../../src/renderer/src/panels/VisitorText';
type VisitorProps = { state: Pick<ProjectState, 'site' | 'pages'>; onCommit: () => unknown };
let agentsScope: (site: SiteDoc) => string;
let changedVisitorText: (site: SiteDoc) => number;
let visitorTextScope: (site: SiteDoc) => string | undefined;
let languageName: (code: string) => string;
let missingFills: (f: VisitorTextField, text: string) => string[];
let VisitorTextFields: FunctionComponent<VisitorProps>;

beforeAll(async () => {
  ({ agentsScope } = (await import(/* @vite-ignore */ AGENTS_PATH)) as { agentsScope: typeof agentsScope });
  ({ changedVisitorText, visitorTextScope, languageName, missingFills, VisitorTextFields } = (await import(/* @vite-ignore */ VISITOR_PATH)) as {
    changedVisitorText: typeof changedVisitorText;
    visitorTextScope: typeof visitorTextScope;
    languageName: typeof languageName;
    missingFills: typeof missingFills;
    VisitorTextFields: typeof VisitorTextFields;
  });
});

const field = (key: string): VisitorTextField => VISITOR_TEXT_GROUPS.flatMap((g) => g.fields).find((f) => f.key === key)!;
const site = (extra: Partial<SiteDoc>) => ({ language: 'en', pageOrder: [], ...extra }) as unknown as SiteDoc;

describe('AI agents', () => {
  it('says in its closed heading how many of its features are on', () => {
    // A new project writes the page index and nothing else.
    expect(agentsScope(site({}))).toBe('1 on');
    expect(agentsScope(site({ llmsTxt: false }))).toBe('All off');
    expect(agentsScope(site({ llmsTxt: false, llmsFull: true, markdownMirrors: true, webmcp: true }))).toBe('3 on');
    expect(agentsScope(site({ llmsFull: true, markdownMirrors: true, webmcp: true }))).toBe('4 on');
  });
});

describe('Visitor text', () => {
  it('counts the wordings of the author’s own in every language, and says nothing while there are none', () => {
    expect(changedVisitorText(site({}))).toBe(0);
    expect(visitorTextScope(site({}))).toBeUndefined();
    const s = site({ visitorText: { en: { menu: 'Browse', skipLink: 'Jump to the content' }, fr: { menu: 'Parcourir' } } } as Partial<SiteDoc>);
    expect(changedVisitorText(s)).toBe(3);
    expect(visitorTextScope(s)).toBe('3 changed');
  });

  it('names languages in words, keeping a code the system has no name for', () => {
    expect(languageName('en')).toBe('English');
    expect(languageName('fr-CA')).toBe('French (Canada)');
    expect(languageName('qaa')).toBe('qaa');
  });

  it('warns of a fill-in a wording leaves out, but not of one the site adds itself', () => {
    expect(missingFills(field('searchMany'), 'Plenty of pages mention “{query}”')).toEqual(['count']);
    expect(missingFills(field('searchMany'), '{count} pages mention “{query}”')).toEqual([]);
    // An empty field uses the wording shown, which has every fill-in.
    expect(missingFills(field('searchMany'), '  ')).toEqual([]);
    // A post's link puts the title at the end when the wording leaves it out.
    expect(missingFills(field('entryPrevious'), 'Older post')).toEqual([]);
  });

  it('marks a changed wording with its reset and what the empty field would use, and flags a dropped fill-in', () => {
    const state = { site: site({ visitorText: { en: { menu: 'Browse', searchMany: 'Plenty of pages mention “{query}”' } } } as Partial<SiteDoc>), pages: {} } as unknown as Pick<ProjectState, 'site' | 'pages'>;
    const html = renderToStaticMarkup(createElement(VisitorTextFields, { state, onCommit: () => true }));
    expect(html).toContain('aria-label="Set Menu button back to Menu"');
    expect(html).toContain('When empty: <span class="vt-fallback-text">Menu</span>');
    expect(html).toContain('Leaves out {count}, so visitors won’t see it.');
    // Unchanged wordings carry no reset.
    expect(html).not.toContain('Set Skip link back');
    // One language: named in words, with no language choice.
    expect(html).toContain('in English');
    expect(html).not.toContain('<select');
  });
});
