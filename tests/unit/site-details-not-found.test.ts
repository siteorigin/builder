/**
 * Site styles' Site details and Not-found page sections: what their closed headings say, a language typed by its name,
 * and which not-found wording counts as the author's own.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { SiteDoc } from '@shared/types';
import { showsNothing } from '@shared/not-found';

/** Renderer code, outside the Node type-check project: loaded by path at run time. */
const DETAILS_PATH = '../../src/renderer/src/panels/site-details';
let siteDetailsScope: (site: Partial<SiteDoc>) => string | undefined;
let notFoundScope: (site: Partial<SiteDoc>) => string | undefined;
let ownWording: (v: unknown) => string;
let languageCodeFor: (text: string) => string | null;
let namedLanguage: (code: string) => string | null;

beforeAll(async () => {
  ({ siteDetailsScope, notFoundScope, ownWording, languageCodeFor, namedLanguage } = (await import(/* @vite-ignore */ DETAILS_PATH)) as {
    siteDetailsScope: typeof siteDetailsScope;
    notFoundScope: typeof notFoundScope;
    ownWording: typeof ownWording;
    languageCodeFor: typeof languageCodeFor;
    namedLanguage: typeof namedLanguage;
  });
});

describe('Site details', () => {
  it('names where the site lives in its closed heading, else who publishes it, else nothing', () => {
    expect(siteDetailsScope({ baseUrl: 'https://www.harbourlane.studio/' })).toBe('harbourlane.studio');
    expect(siteDetailsScope({ baseUrl: 'https://studio.example:8443/en' })).toBe('studio.example:8443');
    // An address the site can't use says nothing about where it lives.
    expect(siteDetailsScope({ baseUrl: 'harbourlane.studio' })).toBeUndefined();
    expect(siteDetailsScope({ baseUrl: '', identity: { kind: 'LocalBusiness' } } as Partial<SiteDoc>)).toBe('Local business');
    expect(siteDetailsScope({ baseUrl: 'https://harbourlane.studio', identity: { kind: 'Person' } } as Partial<SiteDoc>)).toBe('harbourlane.studio');
    // A new site: a starter name and description are not settings of the owner's own.
    expect(siteDetailsScope({ name: 'Harbour Lane Studio', description: 'A studio.' })).toBeUndefined();
    expect(siteDetailsScope({ identity: { kind: 'Spaceship' } } as unknown as Partial<SiteDoc>)).toBeUndefined();
    // Pictures chosen for it, when nothing says more.
    expect(siteDetailsScope({ favicon: 'img_icon' })).toBe('Favicon');
    expect(siteDetailsScope({ socialImage: 'img_share' })).toBe('Sharing image');
    expect(siteDetailsScope({ favicon: 'img_icon', socialImage: 'img_share' })).toBe('2 images');
    expect(siteDetailsScope({ favicon: 'img_icon', identity: { kind: 'Organization' } } as Partial<SiteDoc>)).toBe('Organization');
    // Its language, when nothing says more and it is not the starters' English.
    expect(siteDetailsScope({ language: 'fr-CA' })).toBe('French (Canada)');
    expect(siteDetailsScope({ language: 'en' })).toBeUndefined();
    expect(siteDetailsScope({ language: 'fr-CA', favicon: 'img_icon' })).toBe('Favicon');
  });

  it('takes a language by its name as the code it saves, and leaves codes and unknown words alone', () => {
    expect(languageCodeFor('French')).toBe('fr');
    expect(languageCodeFor('  french (canada) ')).toBe('fr-CA');
    expect(languageCodeFor('German')).toBe('de');
    expect(languageCodeFor('fr-CA')).toBeNull();
    expect(languageCodeFor('Frensh')).toBeNull();
    expect(languageCodeFor('')).toBeNull();
    expect(namedLanguage('fr-CA')).toBe('French (Canada)');
    expect(namedLanguage('not a code')).toBeNull();
  });
});

describe('Not-found page', () => {
  it('counts the wordings of the author’s own in its closed heading, and nothing while every one is built in', () => {
    expect(notFoundScope({})).toBeUndefined();
    expect(notFoundScope({ notFoundHeading: 'Lost?', notFoundMessage: 'Try the menu.' })).toBe('2 changed');
    expect(notFoundScope({ notFoundLinkLabel: 'Home' })).toBe('1 changed');
  });

  it('treats wording that shows nothing as empty, as the built page does', () => {
    for (const blank of ['   ', '⠀', '​', 'ㅤ ']) {
      expect(showsNothing(blank)).toBe(true);
      expect(ownWording(blank)).toBe('');
      expect(notFoundScope({ notFoundHeading: blank })).toBeUndefined();
    }
    expect(ownWording('Lost?')).toBe('Lost?');
    expect(ownWording(42)).toBe('');
  });
});
