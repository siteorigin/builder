import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { NOT_FOUND_DIR, SERVER_HOOK_FILE, generateAppHtml, generateProject, generateServerHook, pageAlternates, pageFile, publishedState, routeLanguages } from '@generator/index';
import { NOT_FOUND_JS } from '@generator/runtime-files';
import { NOT_FOUND_ROUTE } from '@shared/not-found';
import { GenerationCache } from '@generator/cache';
import { declaredLanguage, languageKey, linkClash, pageLanguage, translationPeers } from '@shared/languages';
import { pageLanguageWarning, rivalHookStop, settleServerHook } from '../../src/main/export';
import { ProjectSession } from '../../src/main/project/session';

const fresh = () => createStarterState('business', 'Test Studio', false);
const byTitle = (s: ProjectState, title: string) => Object.values(s.pages).find((p) => p.title === title)!;
const apply = (s: ProjectState, ...ops: Parameters<typeof applyOperations>[1]) => applyOperations(s, ops).state;
/** A new page, and its ID. */
const create = (s: ProjectState, title: string) => {
  const res = applyOperations(s, [{ type: 'page.create', title }]);
  return { s: res.state, id: (res.results[0] as { pageId: string }).pageId };
};

/** The starter with About duplicated as "À propos", in French and linked to About as its translation. */
function bilingual(): { s: ProjectState; en: string; fr: string } {
  const s = fresh();
  const en = byTitle(s, 'About').id;
  const res = applyOperations(s, [{ type: 'page.duplicate', pageId: en, title: 'À propos' }]);
  const fr = (res.results[0] as { pageId: string }).pageId;
  return { s: apply(res.state, { type: 'page.update', pageId: fr, route: '/fr/a-propos/', seoTitle: 'À propos du studio', language: 'fr', linkTranslationTo: en }), en, fr };
}

/** bilingual() with a German version, Über uns, linked as a third. */
function trilingual() {
  const { s, en, fr } = bilingual();
  const de = create(s, 'Über uns');
  return { s: apply(de.s, { type: 'page.update', pageId: de.id, route: '/de/ueber-uns/', language: 'de', linkTranslationTo: fr }), en, fr, de: de.id };
}

const peerIds = (s: ProjectState, id: string) => translationPeers(s, s.pages[id]).map((p) => p.id);

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'so-lang-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Load the generated server hook as the site would, from where the project keeps it, with what it imports from
 * SvelteKit (whether the site is being built) and from the generated not-found runtime.
 */
async function loadHook(files: Map<string, string>, { building = true } = {}) {
  const dir = tempDir();
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'env.mjs'), `export const building = ${building};\n`);
  writeFileSync(join(dir, 'not-found.mjs'), NOT_FOUND_JS);
  const source = files.get(SERVER_HOOK_FILE)!.replace("'$app/env'", JSON.stringify(join(dir, 'env.mjs'))).replace("'./lib/siteorigin/runtime/not-found.js'", JSON.stringify(join(dir, 'not-found.mjs')));
  writeFileSync(join(dir, SERVER_HOOK_FILE), source);
  const hook = (await import(/* @vite-ignore */ pathToFileURL(join(dir, SERVER_HOOK_FILE)).href)) as { handle: (input: unknown) => unknown };
  /** What the hook makes of each chunk of HTML SvelteKit renders for a route, at that route under the sub-path `base`. */
  return (routeId: string | null, chunks: string[], base = '') =>
    hook.handle({
      event: { route: { id: routeId }, url: new URL(`http://sveltekit-prerender${base}${routeId ?? '/missing/'}`) },
      resolve: (_e: unknown, opts?: { transformPageChunk: (c: { html: string; done: boolean }) => string }) => chunks.map((html, i) => (opts ? opts.transformPageChunk({ html, done: i === chunks.length - 1 }) : html))
    }) as string[];
}

/** The page's alternate links: the language and the address, a site path given as `resolve(...)` written as it. */
const alternatesIn = (file: string) => [...file.matchAll(/<link rel="alternate" hreflang="([^"]+)" href=\{"([^"]+)"\} \/>/g)].map((m) => [m[1], m[2]]);
/** The structured data a page file renders. */
/** The nodes of the one structured data graph a page carries, none when it carries none. */
const graphNodes = (file: string) => {
  const scripts = ld(file);
  expect(scripts.length).toBeLessThanOrEqual(1);
  return (scripts[0]?.['@graph'] ?? []) as unknown as Array<Record<string, unknown>>;
};
/** The graph's website and page, with the language each is said to be in. */
const languagesOf = (file: string) => graphNodes(file).filter((n) => n['@type'] === 'WebSite' || [n['@type']].flat().includes('WebPage')).map((n) => [[n['@type']].flat()[0], n.inLanguage]);
const ld = (file: string) => [...file.matchAll(/\{@html ("(?:[^"\\]|\\.)*")\}/g)].map((m) => JSON.parse((JSON.parse(m[1]) as string).replace(/^<script type="application\/ld\+json">|<\/script>$/g, '')) as Record<string, string>);
/** The route-to-language table the layout carries, evaluated. */
const layoutTable = (layout: string) => JSON.parse(layout.match(/const pageLanguages = (\{[^]*?\});/)![1]) as Record<string, string>;

describe('page languages in the project', () => {
  it('lets a page use the site language until it names its own', () => {
    const s = fresh();
    const about = byTitle(s, 'About');
    expect(about.language).toBeUndefined();
    expect(pageLanguage(s.site, about)).toBe('en');
    // An inheriting page follows the site's language; one that names its own keeps it.
    const german = apply(s, { type: 'site.update', language: 'de' }, { type: 'page.update', pageId: byTitle(s, 'Contact').id, language: 'en' });
    expect(pageLanguage(german.site, german.pages[about.id])).toBe('de');
    expect(pageLanguage(german.site, byTitle(german, 'Contact'))).toBe('en');
    let t = apply(s, { type: 'page.update', pageId: about.id, language: ' fr-CA ' });
    expect(t.pages[about.id].language).toBe('fr-CA');
    t = apply(t, { type: 'page.update', pageId: about.id, language: '' });
    expect('language' in t.pages[about.id]).toBe(false);
    expect(() => apply(s, { type: 'page.update', pageId: about.id, language: 'French' })).toThrow(/Language must be a code/);
    // Another setting leaves the language alone.
    t = apply(s, { type: 'page.update', pageId: about.id, language: 'fr' }, { type: 'page.update', pageId: about.id, title: 'À propos' });
    expect(t.pages[about.id].language).toBe('fr');
  });

  it('links translations both ways, as one set however many languages it has', () => {
    const { s, en, fr } = bilingual();
    expect(s.pages[en].translationGroup).toBeTruthy();
    expect(s.pages[fr].translationGroup).toBe(s.pages[en].translationGroup);
    expect(peerIds(s, en)).toEqual([fr]);
    expect(peerIds(s, fr)).toEqual([en]);
    // A third version joins from its own side, or is linked from a page of the set.
    const three = trilingual();
    const t = three.s;
    const de = three.de;
    expect(peerIds(t, three.en).sort()).toEqual([three.fr, de].sort());
    const italian = create(s, 'Chi siamo');
    const fromSet = apply(italian.s, { type: 'page.update', pageId: italian.id, language: 'it' }, { type: 'page.update', pageId: en, linkTranslationTo: italian.id });
    expect(peerIds(fromSet, fr).sort()).toEqual([en, italian.id].sort());
    expect(fromSet.pages[italian.id].translationGroup).toBe(s.pages[en].translationGroup);
    // Linking two pages already in the set changes nothing.
    expect(apply(t, { type: 'page.update', pageId: three.en, linkTranslationTo: de })).toEqual(t);
    expect(() => apply(t, { type: 'page.update', pageId: three.en, linkTranslationTo: three.en })).toThrow(/another page/);
    expect(() => apply(t, { type: 'page.update', pageId: three.en, linkTranslationTo: 'pg_missing' })).toThrow(/does not exist/);
  });

  it('never merges two sets of translations', () => {
    const { s, en, fr } = bilingual();
    const contact = byTitle(s, 'Contact').id;
    const contactFr = create(s, 'Contactez-nous');
    const t = apply(contactFr.s, { type: 'page.update', pageId: contactFr.id, language: 'fr', linkTranslationTo: contact });
    expect(() => apply(t, { type: 'page.update', pageId: en, linkTranslationTo: contact })).toThrow(/each already have other translations/);
    expect(t.pages[fr].translationGroup).not.toBe(t.pages[contact].translationGroup);
  });

  it('treats a group key no other page shares as no set at all', () => {
    const { s, en, fr } = bilingual();
    const hand = structuredClone(s);
    const de = create(hand, 'Über uns');
    // Written by hand: a key whose other page is gone.
    de.s.pages[de.id].translationGroup = 'tr_orphaned';
    de.s.pages[de.id].language = 'de';
    expect(linkClash(de.s, de.s.pages[de.id], de.s.pages[en])).toBeNull();
    const joined = apply(de.s, { type: 'page.update', pageId: de.id, linkTranslationTo: en });
    expect(peerIds(joined, de.id).sort()).toEqual([en, fr].sort());
  });

  it('never lets two versions of a page share a language', () => {
    const s = fresh();
    const en = byTitle(s, 'About').id;
    const contact = byTitle(s, 'Contact').id;
    // Both use the site language: linking them would make two English versions.
    expect(linkClash(s, s.pages[contact], s.pages[en])?.language).toBe('en');
    expect(() => apply(s, { type: 'page.update', pageId: contact, linkTranslationTo: en })).toThrow(/would both be in “en”/);
    // Codes that differ only in case name the same language; regional variants are different languages.
    expect(() => apply(s, { type: 'page.update', pageId: contact, language: 'EN', linkTranslationTo: en })).toThrow(/would both be in “EN”/);
    expect(apply(s, { type: 'page.update', pageId: contact, language: 'en-GB', linkTranslationTo: en }).pages[contact].translationGroup).toBeTruthy();
    // In a set of three, a newcomer clashing with the third member is refused too.
    const { s: t, en: en3, de } = trilingual();
    const extra = create(t, 'Über das Studio');
    expect(linkClash(extra.s, apply(extra.s, { type: 'page.update', pageId: extra.id, language: 'DE' }).pages[extra.id], extra.s.pages[en3])).not.toBeNull();
    expect(() => apply(extra.s, { type: 'page.update', pageId: extra.id, language: 'DE', linkTranslationTo: en3 })).toThrow(/“Über uns” and “Über das Studio” .* both be in “DE”/);
    expect(t.pages[de].language).toBe('de');
    // The page asking to link brings its own versions along: a newcomer in French clashes with About's French version.
    const newcomer = create(t, 'Le studio');
    const french = apply(newcomer.s, { type: 'page.update', pageId: newcomer.id, language: 'fr' });
    expect(linkClash(french, french.pages[en3], french.pages[newcomer.id])?.language).toBe('fr');
  });

  it.each([
    ['he', 'iw'],
    ['id', 'in']
  ])('reads “%s” and its deprecated code “%s” as one language (#1532)', (preferred, deprecated) => {
    const s = fresh();
    const en = byTitle(s, 'About').id;
    const first = create(s, 'First');
    const linked = apply(first.s, { type: 'page.update', pageId: first.id, route: '/first/', language: preferred, linkTranslationTo: en });
    const second = create(linked, 'Second');
    const tagged = apply(second.s, { type: 'page.update', pageId: second.id, route: '/second/', language: deprecated });
    expect(linkClash(tagged, tagged.pages[second.id], tagged.pages[en])).not.toBeNull();
    expect(() => apply(tagged, { type: 'page.update', pageId: second.id, linkTranslationTo: en })).toThrow(/would both be in/);
    // A regional variant is a language of its own.
    expect(apply(tagged, { type: 'page.update', pageId: second.id, language: `${deprecated}-${preferred.toUpperCase()}`, linkTranslationTo: en }).pages[second.id].translationGroup).toBeTruthy();
    // Written by hand, the pair clashes as two copies of one code do: it is reported, and no alternates are listed.
    const hand = structuredClone(tagged);
    hand.pages[second.id].translationGroup = hand.pages[en].translationGroup;
    expect(validateState(hand).find((d) => d.code === 'TRANSLATION_LANGUAGE')?.message).toMatch(/the website lists none of their translations/);
    for (const id of [en, first.id, second.id]) expect(pageAlternates(hand, hand.pages[id])).toEqual([]);
    const published = apply(hand, { type: 'site.update', baseUrl: 'https://example.com' });
    const sitemap = generateProject(published).get('static/sitemap.xml') as string;
    expect(sitemap).toContain('<loc>');
    expect(sitemap).not.toContain('hreflang');
  });

  it('refuses a deprecated code however the clash comes about, and keeps it as written where there is none (#1532)', () => {
    const s = fresh();
    const en = byTitle(s, 'About').id;
    const other = create(s, 'Other');
    const hebrew = apply(other.s, { type: 'page.update', pageId: other.id, route: '/other/', language: 'iw', linkTranslationTo: en });
    // Retagging a linked page, or changing the site language under a page that follows it.
    expect(() => apply(hebrew, { type: 'page.update', pageId: en, language: 'he' })).toThrow(/both be in/);
    expect(() => apply(hebrew, { type: 'site.update', language: 'he' })).toThrow(/both be in “he”.*use the site language/);
    // A regional variant stays apart, and its deprecated spelling is still that variant.
    const regional = apply(hebrew, { type: 'page.update', pageId: en, language: 'he-IL' });
    expect(() => apply(regional, { type: 'page.update', pageId: other.id, language: 'iw-IL' })).toThrow(/both be in “iw-IL”/);
    // The site's own language is found for x-default under either code, and the alternates name the code as written.
    const published = apply(hebrew, { type: 'page.update', pageId: en, language: 'en' }, { type: 'site.update', language: 'he', baseUrl: 'https://example.com' });
    const sitemap = generateProject(published).get('static/sitemap.xml') as string;
    expect(sitemap).toContain('hreflang="iw" href="https://example.com/other/"');
    expect(sitemap).toContain('hreflang="x-default" href="https://example.com/other/"');
    expect(pageAlternates(published, published.pages[other.id]).map((a) => a.language)).toEqual(expect.arrayContaining(['en', 'iw']));
    // Outside translation sets the page's own code still counts as another than the site's.
    expect(routeLanguages(published).map(([, language]) => language)).toContain('iw');
  });

  it.each([
    ['no-bok', 'nb'],
    ['no-nyn', 'nn'],
    ['zh-yue', 'yue'],
    ['zh-cmn-Hans', 'zh-Hans'],
    ['zh-min-nan', 'nan'],
    ['zh-hakka', 'hak'],
    ['zh-xiang', 'hsn'],
    ['in-ID', 'id-ID']
  ])('reads the registered spelling “%s” as “%s” (#1532)', (legacy, preferred) => {
    expect(languageKey(legacy)).toBe(languageKey(preferred));
  });

  it('keeps languages that only look alike apart (#1532)', () => {
    expect(languageKey('zh-min')).not.toBe(languageKey('min'));
    expect(languageKey('zh-yue')).not.toBe(languageKey('zh'));
    expect(languageKey('he-IL')).not.toBe(languageKey('he'));
  });

  it('lets the site language be respelled over a set that already clashed by hand (#1532)', () => {
    const { s, fr } = bilingual();
    const hand = structuredClone(s);
    hand.site.language = 'iw';
    hand.pages[fr].language = 'he';
    expect(apply(hand, { type: 'site.update', language: 'he' }).site.language).toBe('he');
  });

  it('compares a code the platform cannot canonicalize as written, ignoring case', () => {
    expect(languageKey('en-abcd-abcd')).toBe(languageKey('EN-abcd-ABCD'));
    expect(languageKey('en-abcd-abcd')).not.toBe(languageKey('en'));
    expect(languageKey('en-abcd-abcd')).not.toBe(languageKey('en-abcd-efgh'));
  });

  it('refuses a language change that would make two versions the same, wherever it comes from', () => {
    const { s, en, fr } = bilingual();
    // Clearing the French page's language would make it English, like About.
    expect(() => apply(s, { type: 'page.update', pageId: fr, language: '' })).toThrow(/“About” and “À propos” .* both be in “en”/);
    expect(() => apply(s, { type: 'page.update', pageId: en, language: 'FR' })).toThrow(/both be in “fr”/i);
    // About uses the site language: making the site French would make it French too. Drafts count as well.
    const drafted = apply(s, { type: 'page.update', pageId: fr, draft: true });
    expect(() => apply(drafted, { type: 'site.update', language: 'fr' })).toThrow(/both be in “fr”.*use the site language/);
    // A second set is checked as well as the first.
    const contact = byTitle(s, 'Contact').id;
    const nl = create(s, 'Contact NL');
    const two = apply(nl.s, { type: 'page.update', pageId: en, language: 'en' }, { type: 'page.update', pageId: nl.id, language: 'nl', linkTranslationTo: contact });
    expect(() => apply(two, { type: 'site.update', language: 'nl' })).toThrow(/“Contact NL” and “Contact” .* both be in “nl”/);
    // Pinning About to English first makes the change possible.
    const pinned = apply(s, { type: 'page.update', pageId: en, language: 'en' }, { type: 'site.update', language: 'fr' });
    expect(pageLanguage(pinned.site, pinned.pages[en])).toBe('en');
  });

  it('lets the site language change when a set already clashed by hand, and no new clash comes of it', () => {
    const { s, fr } = bilingual();
    const hand = structuredClone(s);
    hand.pages[byTitle(hand, 'About').id].language = 'fr';
    expect(hand.pages[fr].language).toBe('fr');
    expect(apply(hand, { type: 'site.update', language: 'de' }).site.language).toBe('de');
    // A set that already clashed through a draft still refuses a new clash between published versions.
    const three = trilingual();
    const masked = structuredClone(three.s);
    const draft = create(masked, 'À propos (brouillon)');
    draft.s.pages[draft.id].language = 'fr';
    draft.s.pages[draft.id].draft = true;
    draft.s.pages[draft.id].translationGroup = draft.s.pages[three.en].translationGroup;
    expect(() => apply(draft.s, { type: 'site.update', language: 'de' })).toThrow(/“Über uns” and “About” .* both be in “de”/);
  });

  it('unlinks a page, and a version left on its own is no longer a translation', () => {
    const { s, en, fr } = bilingual();
    const t = apply(s, { type: 'page.update', pageId: fr, linkTranslationTo: null });
    expect(t.pages[fr].translationGroup).toBeUndefined();
    expect(t.pages[en].translationGroup).toBeUndefined();
    expect(t.pages[fr].language).toBe('fr');
    // In a set of three, the other two stay linked, and the page that left keeps its language.
    const three = trilingual();
    const two = apply(three.s, { type: 'page.update', pageId: three.de, linkTranslationTo: null });
    expect(peerIds(two, three.en)).toEqual([three.fr]);
    expect(two.pages[three.de].translationGroup).toBeUndefined();
    expect(two.pages[three.de].language).toBe('de');
  });

  it('removes a page from its translations, never handing them to the replacement', () => {
    const { s, en, fr } = bilingual();
    const contact = byTitle(s, 'Contact').id;
    const gone = apply(s, { type: 'page.remove', pageId: fr, replacementPageId: contact });
    expect(gone.pages[en].translationGroup).toBeUndefined();
    expect(gone.pages[contact].translationGroup).toBeUndefined();
    // From a set of three, the other two stay linked.
    const three = trilingual();
    expect(peerIds(apply(three.s, { type: 'page.remove', pageId: three.de }), three.en)).toEqual([three.fr]);
  });

  it('copies a translated page as a page of its own in the same language', () => {
    const { s, en, fr } = bilingual();
    const res = applyOperations(s, [{ type: 'page.duplicate', pageId: fr }]);
    const copy = res.state.pages[(res.results[0] as { pageId: string }).pageId];
    expect(copy.language).toBe('fr');
    expect(copy.translationGroup).toBeUndefined();
    expect(peerIds(res.state, en)).toEqual([fr]);
    // A copy of a page in the site language keeps following the site.
    const inherit = applyOperations(s, [{ type: 'page.duplicate', pageId: en }]);
    const plain = inherit.state.pages[(inherit.results[0] as { pageId: string }).pageId];
    expect('language' in plain).toBe(false);
  });

  it('reports languages written by hand that the editor would refuse, one set at a time', () => {
    const { s, en, fr } = trilingual();
    const hand = structuredClone(s);
    hand.pages[en].language = 'English';
    hand.pages[fr].language = 'en';
    // A second set, clashing only through a draft.
    const contact = byTitle(hand, 'Contact').id;
    const copy = create(hand, 'Contact copy');
    copy.s.pages[copy.id].draft = true;
    copy.s.pages[copy.id].translationGroup = copy.s.pages[contact].translationGroup = 'tr_second';
    // Anything at all may be written by hand.
    (copy.s.pages[byTitle(copy.s, 'Home').id] as { language?: unknown }).language = { toString: 'fr' };
    const warnings = validateState(copy.s).filter((d) => d.code === 'LANGUAGE_INVALID' || d.code === 'TRANSLATION_LANGUAGE');
    expect(warnings.map((d) => [d.code, d.owner && 'id' in d.owner ? d.owner.id : null]).sort()).toEqual(
      [
        ['LANGUAGE_INVALID', en],
        ['LANGUAGE_INVALID', byTitle(copy.s, 'Home').id],
        ['TRANSLATION_LANGUAGE', fr],
        ['TRANSLATION_LANGUAGE', copy.id]
      ].sort()
    );
    expect(warnings.every((d) => d.severity === 'warning')).toBe(true);
    expect(warnings.find((d) => d.owner && 'id' in d.owner && d.owner.id === en)!.message).toMatch(/“English” is not a language code, so the page uses the site language/);
    expect(warnings.find((d) => d.owner && 'id' in d.owner && d.owner.id === fr)!.message).toMatch(/the website lists none of their translations/);
    expect(warnings.find((d) => d.owner && 'id' in d.owner && d.owner.id === copy.id)!.message).toMatch(/Publishing the draft/);
    expect(validateState(s).some((d) => d.code === 'LANGUAGE_INVALID' || d.code === 'TRANSLATION_LANGUAGE')).toBe(false);
    // A draft clashing first does not hide that two published versions clash too.
    const both = structuredClone(s);
    const draft = create(both, 'À propos (brouillon)');
    draft.s.pages[draft.id].language = 'fr';
    draft.s.pages[draft.id].draft = true;
    draft.s.pages[draft.id].translationGroup = draft.s.pages[en].translationGroup;
    draft.s.site.pageOrder = [fr, draft.id, ...draft.s.site.pageOrder.filter((id) => id !== fr && id !== draft.id)];
    draft.s.pages[en].language = 'DE';
    const mixed = validateState(draft.s).filter((d) => d.code === 'TRANSLATION_LANGUAGE');
    expect(mixed).toHaveLength(1);
    expect(mixed[0].message).toMatch(/the website lists none of their translations/);
  });
});

describe('the editor’s preview of a site in one language (#1335)', () => {
  it('takes a new language or direction in place, while the website keeps them in app.html alone', () => {
    const rtl = apply(fresh(), { type: 'site.update', direction: 'rtl' });
    const preview = generateProject(rtl, { instrument: true }).get('src/routes/+layout.svelte')!;
    expect(preview).toContain('document.documentElement.lang = "en";');
    expect(preview).toContain('document.documentElement.dir = "rtl";');
    const arabic = generateProject(apply(fresh(), { type: 'site.update', language: 'ar' }), { instrument: true }).get('src/routes/+layout.svelte')!;
    expect(arabic).toContain('document.documentElement.lang = "ar";');
    expect(arabic).toContain('document.documentElement.dir = "rtl";');
    // Not a site in more than one language: nothing follows the page's own.
    expect(preview).not.toMatch(/pageLanguages|speak\(/);
    const site = generateProject(rtl);
    expect(site.get('src/routes/+layout.svelte')).not.toContain('documentElement');
    expect(site.get('src/app.html')).toContain('<html lang="en" dir="rtl">');
  });
});

describe('page languages in the website', () => {
  it('generates a site in one language exactly as before', () => {
    const s = apply(fresh(), { type: 'site.update', baseUrl: 'https://example.com/' });
    const files = generateProject(s);
    // The server hook is the not-found page's alone: it carries no languages.
    expect(files.get(SERVER_HOOK_FILE)).toBe(generateServerHook(fresh()));
    expect(files.get(SERVER_HOOK_FILE)).not.toMatch(/LANGUAGES|lang/);
    expect([...files.keys()].filter((p) => /language/.test(p))).toEqual([]);
    expect(files.get('src/app.html')).toBe(
      '<!doctype html>\n<html lang="en" dir="ltr">\n\t<head>\n\t\t<meta charset="utf-8" />\n\t\t<meta name="viewport" content="width=device-width, initial-scale=1" />\n\t\t<script>document.documentElement.classList.add("so-js");</script>\n\t\t%sveltekit.head%\n\t</head>\n\t<body data-sveltekit-preload-data="hover">\n\t\t<div style="display: contents">%sveltekit.body%</div>\n\t</body>\n</html>\n'
    );
    expect(files.get('src/routes/+layout.svelte')).not.toMatch(/pageLanguages|documentElement/);
    const pageFiles = new Set(Object.values(s.pages).map((p) => pageFile(p)));
    for (const [path, content] of files) {
      if (!path.endsWith('+page.svelte')) continue;
      expect(content).not.toMatch(/hreflang/);
      // Only the not-found page links through resolve(), to the home page; no page of the site needs it.
      if (!path.startsWith(`${NOT_FOUND_DIR}/`)) expect(content).not.toMatch(/\$app\/paths/);
      // Every page and the website are in the site's language, and nothing else says otherwise; the other routes (the
      // not-found page) carry no structured data at all.
      if (pageFiles.has(path)) expect(languagesOf(content).map(([, language]) => language), path).toEqual(['en', 'en']);
      else expect(ld(content), path).toEqual([]);
      expect(content.match(/"inLanguage\\":\\"(?!en\\")/g), path).toBeNull();
    }
    expect(graphNodes(files.get('src/routes/+page.svelte')!)[1]).toMatchObject({ '@type': 'WebSite', url: 'https://example.com/', inLanguage: 'en' });
    // A page that names the site's own language changes nothing either.
    const pinned = apply(s, { type: 'page.update', pageId: byTitle(s, 'About').id, language: 'EN' });
    expect([...generateProject(pinned)]).toEqual([...files]);
    expect([...generateProject(pinned, { instrument: true })]).toEqual([...generateProject(s, { instrument: true })]);
  });

  it('declares each page’s language on first load and as visitors move between pages', async () => {
    const { s } = trilingual();
    for (const instrument of [false, true]) {
      const files = generateProject(s, { instrument });
      // One hook does both jobs: it imports only what the not-found page needs, the build flag and the generated runtime.
      const hook = files.get(SERVER_HOOK_FILE)!;
      expect([...hook.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1])).toEqual(['$app/env', './lib/siteorigin/runtime/not-found.js']);
      expect([...files.values()].some((f) => f.includes('$lib'))).toBe(false);
      // app.html keeps naming the site's language: every page in it needs nothing more.
      expect(files.get('src/app.html')).toBe(generateAppHtml(fresh()));
      const render = await loadHook(files);
      const html = files.get('src/app.html')!.replace('%sveltekit.head%', '<title>x</title>').replace('%sveltekit.body%', '<p>&lt;html lang="en"&gt;</p>');
      // French and German run left to right, as the site does: only lang changes.
      expect(render('/fr/a-propos', [html])[0]).toBe(html.replace('<html lang="en" dir="ltr">', '<html lang="fr" dir="ltr">'));
      expect(render('/de/ueber-uns', [html])[0]).toBe(html.replace('<html lang="en" dir="ltr">', '<html lang="de" dir="ltr">'));
      for (const id of ['/about', '/', null]) expect(render(id, [html])[0]).toBe(html);
      // Only the document's own opening tag changes: a later chunk is left as it is.
      const [first, later] = render('/fr/a-propos', [html.slice(0, 60), '<html lang="en"> as text']);
      expect(first).toContain('<html lang="fr" dir="ltr">');
      expect(later).toBe('<html lang="en"> as text');
      // A template of the project's own: other attributes, single quotes, no lang at all, or a comment first.
      expect(render('/fr/a-propos', ["<!doctype html>\n<html class='site' lang='en' data-x>"])[0]).toBe("<!doctype html>\n<html class='site' lang=\"fr\" data-x>");
      expect(render('/fr/a-propos', ['<!-- mine -->\n<!DOCTYPE html><HTML class="site">'])[0]).toBe('<!-- mine -->\n<!DOCTYPE html><HTML class="site" lang="fr">');
      expect(render('/fr/a-propos', ['<html xml:lang="en" lang="fr">'])[0]).toBe('<html xml:lang="en" lang="fr">');
      // A page far longer than the part read keeps everything after it as it was.
      const long = '<!doctype html><html lang="en"><body>' + 'x'.repeat(200000) + '<html lang="en"></body></html>';
      expect(render('/fr/a-propos', [long])[0]).toBe(long.replace('<html lang="en"><body>', '<html lang="fr"><body>'));
      // A comment of megabytes before the tag is passed over, never read to its end.
      const huge = '<!--' + 'x'.repeat(8 * 1024 * 1024) + '--><!doctype html><html lang="en">';
      expect(render('/fr/a-propos', [huge])[0]).toBe(huge);
      // Only the attribute itself: not text inside another attribute's value, nor a tag inside a comment before it.
      for (const [template, rewritten] of [
        [`<!doctype html><html data-label='a lang="en" b' lang="en">`, `<!doctype html><html data-label='a lang="en" b' lang="fr">`],
        ['<!-- <html lang="en"> -->\n<!doctype html><html lang="en">', '<!-- <html lang="en"> -->\n<!doctype html><html lang="fr">'],
        ['<!doctype html><html data-x="a>b" lang=en>', '<!doctype html><html data-x="a>b" lang="fr">'],
        ['<p>Not a document</p><html lang="en">', '<p>Not a document</p><html lang="en">']
      ]) {
        expect(render('/fr/a-propos', [template])[0]).toBe(rewritten);
        // The export's check reads the tag the same way.
        expect(declaredLanguage(rewritten)).toBe(rewritten.startsWith('<p>') ? null : 'fr');
        expect(declaredLanguage(template)).toBe(template.startsWith('<p>') ? null : 'en');
      }
      // The layout keeps <html lang> in step on client-side navigation, for every page in another language.
      const layout = files.get('src/routes/+layout.svelte')!;
      expect(layoutTable(layout)).toEqual({ '/de/ueber-uns': 'de', '/fr/a-propos': 'fr' });
      expect(layout).toContain('const language = $derived(page.route.id && Object.hasOwn(pageLanguages, page.route.id) ? pageLanguages[page.route.id] : "en");');
      expect(layout).toContain('document.documentElement.lang = language;');
      // No page runs the other way, and every one runs the site's way.
      expect(layout).toContain('const pageDirections = {};');
      expect(layout).toContain('document.documentElement.dir = id && Object.hasOwn(pageDirections, id) ? pageDirections[id] : "ltr";');
      expect(() => compile(layout, { generate: 'server', filename: 'src/routes/+layout.svelte', runes: true })).not.toThrow();
      expect(() => compile(layout, { generate: 'client', filename: 'src/routes/+layout.svelte', runes: true })).not.toThrow();
    }
  });

  it('gives a page in a language written the other way its own dir, on first load and as visitors move between pages (issue #71)', async () => {
    const { s } = bilingual();
    const he = create(s, 'אודות');
    let t = apply(he.s, { type: 'page.update', pageId: he.id, route: '/he/odot/', language: 'he' });
    const html = '<!doctype html>\n<html lang="en" dir="ltr"><head></head>';
    for (const instrument of [false, true]) {
      const files = generateProject(t, { instrument });
      expect(files.get('src/app.html')).toContain('<html lang="en" dir="ltr">');
      expect(files.get(SERVER_HOOK_FILE)).toMatch(/const DIRECTIONS = \{\n\t"\/he\/odot": "rtl"\n\};/);
      const render = await loadHook(files);
      expect(render('/he/odot', [html])[0]).toBe('<!doctype html>\n<html lang="he" dir="rtl"><head></head>');
      expect(render('/fr/a-propos', [html])[0]).toBe('<!doctype html>\n<html lang="fr" dir="ltr"><head></head>');
      for (const id of ['/about', '/', null]) expect(render(id, [html])[0]).toBe(html);
      // A template of the project's own: dir is added where it has none, and replaced however it is written.
      expect(render('/he/odot', ['<html class="x" lang="en">'])[0]).toBe('<html class="x" lang="he" dir="rtl">');
      expect(render('/he/odot', ["<html DIR='ltr' lang=en>"])[0]).toBe('<html dir="rtl" lang="he">');
      const layout = files.get('src/routes/+layout.svelte')!;
      expect(layout).toContain('const pageDirections = {\n\t\t"/he/odot": "rtl"\n\t};');
      expect(layout).toContain('document.documentElement.dir = id && Object.hasOwn(pageDirections, id) ? pageDirections[id] : "ltr";');
      expect(() => compile(layout, { generate: 'client', filename: 'src/routes/+layout.svelte', runes: true })).not.toThrow();
    }
    // An Arabic site runs right to left: its French page is the one that runs the other way.
    t = apply(t, { type: 'site.update', language: 'ar' });
    let files = generateProject(t);
    expect(files.get('src/app.html')).toContain('<html lang="ar" dir="rtl">');
    expect(files.get(SERVER_HOOK_FILE)).toMatch(/const DIRECTIONS = \{\n\t"\/fr\/a-propos": "ltr"\n\};/);
    expect((await loadHook(files))('/he/odot', ['<html lang="ar" dir="rtl">'])[0]).toBe('<html lang="he" dir="rtl">');
    // Its author's choice of left to right holds for the pages in Arabic; the Hebrew page still runs right to left.
    t = apply(t, { type: 'site.update', direction: 'ltr' });
    files = generateProject(t);
    expect(files.get('src/app.html')).toContain('<html lang="ar" dir="ltr">');
    expect(files.get(SERVER_HOOK_FILE)).toMatch(/const DIRECTIONS = \{\n\t"\/he\/odot": "rtl"\n\};/);
    expect(pageLanguageWarning(t, byTitle(t, 'About'), '<html lang="ar" dir="ltr">')).toBeNull();
    expect(pageLanguageWarning(t, t.pages[he.id], '<html lang="he" dir="rtl">')).toBeNull();
    expect(pageLanguageWarning(t, t.pages[he.id], '<html lang="he">')).toMatch(/built without a direction, not right to left/);
    // Automatic again: the direction follows the language once more, and the document keeps no choice.
    t = apply(t, { type: 'site.update', direction: 'auto' });
    expect('direction' in t.site).toBe(false);
    expect(generateProject(t).get('src/app.html')).toContain('<html lang="ar" dir="rtl">');
    // A site in English set to run right to left does, and so do its pages in English; its French page runs its own way.
    const rtl = apply(bilingual().s, { type: 'site.update', direction: 'rtl' });
    expect(rtl.site.direction).toBe('rtl');
    files = generateProject(rtl);
    expect(files.get('src/app.html')).toContain('<html lang="en" dir="rtl">');
    expect(files.get(SERVER_HOOK_FILE)).toMatch(/const DIRECTIONS = \{\n\t"\/fr\/a-propos": "ltr"\n\};/);
    expect((await loadHook(files))('/fr/a-propos', ['<html lang="en" dir="rtl">'])[0]).toBe('<html lang="fr" dir="ltr">');
    // The export's check reads dir in any case.
    expect(pageLanguageWarning(rtl, byTitle(rtl, 'About'), '<html lang="en" DIR="RTL">')).toBeNull();
  });

  it('gives the not-found page and each page in another language one server hook that does both', async () => {
    const { s } = trilingual();
    for (const instrument of [false, true]) {
      const files = generateProject(s, { instrument });
      // One hook, at the one path SvelteKit runs, made by the one generator; no other file is a server hook.
      expect([...files.keys()].filter((p) => /hooks\.server/.test(p))).toEqual([SERVER_HOOK_FILE]);
      expect(files.get(SERVER_HOOK_FILE)).toBe(generateServerHook(s));
      expect(files.get(SERVER_HOOK_FILE)).toContain('const SECTIONS = {};');
      expect(files.get(SERVER_HOOK_FILE)).toMatch(/const LANGUAGES = \{\n\t"\/de\/ueber-uns": "de",\n\t"\/fr\/a-propos": "fr"\n\};/);
    }
    const page = '<!doctype html><html lang="en"><head><link href="./_app/a.css" rel="stylesheet"></head><body><a href="./">Home</a></body></html>';
    const rooted = page.replace('href="./_app/a.css"', 'href="/studio/_app/a.css"').replace('href="./"', 'href="/studio/"');
    // While the site is built, the not-found page's addresses start from the root, under the sub-path it is built at,
    // in every chunk; it stays in the site's language.
    const build = await loadHook(generateProject(s));
    expect(build(NOT_FOUND_ROUTE, [page], '/studio')).toEqual([rooted]);
    expect(build(NOT_FOUND_ROUTE, [page.slice(0, 80), page.slice(80)], '/studio').join('')).toBe(rooted);
    // A page in another language gets its own lang and keeps its addresses: it is served where it was built.
    expect(build('/fr/a-propos', [page], '/studio')).toEqual([page.replace('<html lang="en">', '<html lang="fr">')]);
    expect(build('/de/ueber-uns', [page.slice(0, 40), page.slice(40)]).join('')).toBe(page.replace('<html lang="en">', '<html lang="de">'));
    // A page in the site's language, and an address no route has, are left alone.
    for (const id of ['/about', '/', null]) expect(build(id, [page])).toEqual([page]);
    // In the preview only the languages apply: the dev server serves the not-found page where it was built.
    const preview = await loadHook(generateProject(s, { instrument: true }), { building: false });
    expect(preview(NOT_FOUND_ROUTE, [page], '/studio')).toEqual([page]);
    expect(preview('/fr/a-propos', [page])).toEqual([page.replace('<html lang="en">', '<html lang="fr">')]);
  });

  it('keeps a server hook of the project’s own at the generated path, and stops the export of a site that needs ours', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'src'), { recursive: true });
    const theirs = 'export const handle = ({ event, resolve }) => resolve(event);\n';
    writeFileSync(join(dir, SERVER_HOOK_FILE), theirs);
    const session = await ProjectSession.create(dir, fresh());
    try {
      expect(readFileSync(join(dir, SERVER_HOOK_FILE), 'utf8')).toBe(theirs);
      const about = byTitle(session.state, 'About').id;
      expect((await session.apply({ operations: [{ type: 'page.update', pageId: about, language: 'fr' }] }, { label: 'French' })).ok).toBe(true);
      // Theirs is kept, in the project and in what the preview runs; nothing blocks editing.
      expect(readFileSync(join(dir, SERVER_HOOK_FILE), 'utf8')).toBe(theirs);
      expect(existsSync(join(dir, '.siteorigin', 'cache', 'dev', SERVER_HOOK_FILE))).toBe(false);
      expect(session.conflicts).toEqual([]);
      // The export says why it cannot go ahead, and a staged copy of the project keeps theirs too.
      const live = publishedState(session.state);
      expect(await rivalHookStop(dir, live)).toMatch(/server hook of its own \(src\/hooks\.server\.js\): SvelteKit runs only one/);
      await settleServerHook(dir, live);
      expect(readFileSync(join(dir, SERVER_HOOK_FILE), 'utf8')).toBe(theirs);
    } finally {
      await session.close();
    }
  });

  it('generates the same as a full run when only part is made again', () => {
    const cache = new GenerationCache();
    /** Both kinds of output through the cache, each the same as a full run; what the clean one had to make. */
    const made = (state: ProjectState) => {
      let clean: string[] = [];
      for (const opts of [{}, { instrument: true }]) {
        expect([...generateProject(state, opts, cache)]).toEqual([...generateProject(state, opts)]);
        if (!('instrument' in opts)) clean = cache.made.slice();
      }
      return clean;
    };
    let s = apply(fresh(), { type: 'site.update', baseUrl: 'https://example.com/' });
    const en = byTitle(s, 'About').id;
    const contact = byTitle(s, 'Contact').id;
    made(s);
    // A page in another language: the hook appears, the layout follows, and that page says so; the others are kept.
    s = apply(s, { type: 'page.update', pageId: en, language: 'fr' });
    expect(made(s)).toEqual(expect.arrayContaining(['hooks.server.js', 'layout#clean', `page:${en}#clean`]));
    // Linking a translation remakes both versions, and a language change on one of them remakes the hook and layout.
    s = apply(s, { type: 'page.update', pageId: contact, language: 'de', linkTranslationTo: en });
    expect(made(s)).toEqual(expect.arrayContaining([`page:${en}#clean`, `page:${contact}#clean`, 'hooks.server.js', 'layout#clean']));
    s = apply(s, { type: 'page.update', pageId: contact, route: '/kontakt/' });
    expect(made(s)).toEqual(expect.arrayContaining([`page:${en}#clean`, 'hooks.server.js']));
    // Back in one language: the hook is the not-found page's alone again and every file is as a full run makes it.
    s = apply(s, { type: 'page.update', pageId: contact, linkTranslationTo: null }, { type: 'page.update', pageId: contact, language: '' }, { type: 'page.update', pageId: en, language: '' });
    expect(made(s)).toEqual(expect.arrayContaining(['hooks.server.js']));
    expect(generateProject(s, {}, cache).get(SERVER_HOOK_FILE)).toBe(generateServerHook(s));
    expect(generateProject(s, {}, cache).get(SERVER_HOOK_FILE)).not.toContain('LANGUAGES');
  });

  it('lists the same languages whatever order the pages are in', () => {
    const { s, fr, de } = trilingual();
    const reordered = apply(s, { type: 'page.reorder', pageIds: [...s.site.pageOrder].reverse() });
    expect(s.site.pageOrder.indexOf(fr)).toBeLessThan(s.site.pageOrder.indexOf(de));
    expect(generateProject(reordered).get(SERVER_HOOK_FILE)).toBe(generateProject(s).get(SERVER_HOOK_FILE));
    expect(layoutTable(generateProject(reordered).get('src/routes/+layout.svelte')!)).toEqual({ '/de/ueber-uns': 'de', '/fr/a-propos': 'fr' });
    expect(generateProject(reordered).get('src/routes/+layout.svelte')).toBe(generateProject(s).get('src/routes/+layout.svelte'));
  });

  it('lists every version, itself included, on each version, only at full addresses', () => {
    const { s, en, fr, de } = trilingual();
    // Without a public address there are no full addresses, and search engines take no others, so the versions list
    // none, preview and website alike; each page still says its own language.
    for (const files of [generateProject(s), generateProject(s, { instrument: true })])
      for (const id of [en, fr, de]) {
        expect(files.get(pageFile(s.pages[id]))).not.toContain('hreflang');
        expect(files.get(pageFile(s.pages[id]))).not.toContain('$app/paths');
        expect(() => compile(files.get(pageFile(s.pages[id]))!, { generate: 'server', filename: pageFile(s.pages[id]), runes: true })).not.toThrow();
      }
    expect(pageAlternates(s, s.pages[fr]).map((a) => a.language)).toEqual(['en', 'fr', 'de']);
    // With a public address (under a sub-path here), the addresses are complete.
    const published = apply(s, { type: 'site.update', baseUrl: 'https://example.com/studio/' });
    const pub = generateProject(published);
    const full = [
      ['en', 'https://example.com/studio/about/'],
      ['fr', 'https://example.com/studio/fr/a-propos/'],
      ['de', 'https://example.com/studio/de/ueber-uns/']
    ];
    for (const id of [en, fr, de]) {
      expect(alternatesIn(pub.get(pageFile(s.pages[id]))!)).toEqual(full);
      expect(pub.get(pageFile(s.pages[id]))).not.toContain('$app/paths');
      expect(() => compile(pub.get(pageFile(s.pages[id]))!, { generate: 'server', filename: pageFile(s.pages[id]), runes: true })).not.toThrow();
    }
    // Pages without translations list none.
    expect(pub.get(pageFile(byTitle(s, 'Contact')))).not.toContain('hreflang');
    // Each page also says which language it is in, for search engines; the website stays in the site's own.
    for (const [id, language] of [[en, 'en'], [fr, 'fr'], [de, 'de']])
      expect(languagesOf(pub.get(pageFile(s.pages[id]))!)).toEqual([
        ['WebSite', 'en'],
        ['WebPage', language]
      ]);
    expect(ld(pub.get(pageFile(s.pages[fr]))!)[0]['@context']).toBe('https://schema.org');
    expect(graphNodes(pub.get(pageFile(s.pages[fr]))!)[2]).toMatchObject({ '@id': 'https://example.com/studio/fr/a-propos/#webpage', name: 'À propos du studio', url: 'https://example.com/studio/fr/a-propos/', isPartOf: { '@id': 'https://example.com/studio/#website' } });
    expect(languagesOf(pub.get(pageFile(s.pages[s.site.homePageId]))!)).toEqual([
      ['WebSite', 'en'],
      ['WebPage', 'en']
    ]);
    // A page hidden from search engines is still a published version, with no structured data of its own.
    const hidden = generateProject(apply(published, { type: 'page.update', pageId: fr, noindex: true }));
    expect(alternatesIn(hidden.get(pageFile(s.pages[en]))!)).toEqual(full);
    expect(alternatesIn(hidden.get(pageFile(s.pages[fr]))!)).toEqual(full);
    expect(ld(hidden.get(pageFile(s.pages[fr]))!)).toEqual([]);
  });

  it('lists the versions at full addresses once a public address is set, with no relinking', () => {
    const { s, en, fr } = bilingual();
    const cache = new GenerationCache();
    for (const opts of [{}, { instrument: true }]) expect(generateProject(s, opts, cache).get(pageFile(s.pages[fr]))).not.toContain('hreflang');
    const published = apply(s, { type: 'site.update', baseUrl: 'https://example.com/' });
    expect(published.pages[fr].translationGroup).toBe(s.pages[fr].translationGroup);
    for (const opts of [{}, { instrument: true }]) {
      const files = generateProject(published, opts, cache);
      expect([...files]).toEqual([...generateProject(published, opts)]);
      for (const id of [en, fr])
        expect(alternatesIn(files.get(pageFile(published.pages[id]))!)).toEqual([
          ['en', 'https://example.com/about/'],
          ['fr', 'https://example.com/fr/a-propos/']
        ]);
    }
    // Cleared again, the cached pages drop them.
    const cleared = apply(published, { type: 'site.update', baseUrl: '' });
    for (const opts of [{}, { instrument: true }]) for (const id of [en, fr]) expect(generateProject(cleared, opts, cache).get(pageFile(cleared.pages[id]))).not.toContain('hreflang');
  });

  it('follows a version to its new address and to the Home page', () => {
    const two = bilingual();
    const { en, fr } = two;
    const s = apply(two.s, { type: 'site.update', baseUrl: 'https://example.com/' });
    const moved = apply(s, { type: 'page.update', pageId: fr, route: '/fr/studio/' });
    expect(alternatesIn(generateProject(moved).get(pageFile(moved.pages[en]))!)).toEqual([
      ['en', 'https://example.com/about/'],
      ['fr', 'https://example.com/fr/studio/']
    ]);
    const home = apply(s, { type: 'page.setHome', pageId: fr });
    const files = generateProject(home);
    const both = [
      ['en', 'https://example.com/about/'],
      ['fr', 'https://example.com/']
    ];
    expect(alternatesIn(files.get(pageFile(home.pages[en]))!)).toEqual(both);
    expect(alternatesIn(files.get(pageFile(home.pages[fr]))!)).toEqual(both);
    expect(layoutTable(files.get('src/routes/+layout.svelte')!)).toEqual({ '/': 'fr' });
  });

  it('leaves a draft version out of the website, and previews it in its own language', async () => {
    const { s, en, fr, de } = trilingual();
    const drafted = apply(s, { type: 'site.update', baseUrl: 'https://example.com/' }, { type: 'page.update', pageId: de, draft: true });
    // The preview shows the draft in German; the published versions list each other and not the draft, which lists none.
    const preview = generateProject(drafted, { instrument: true });
    expect((await loadHook(preview))('/de/ueber-uns', ['<!doctype html><html lang="en">'])[0]).toBe('<!doctype html><html lang="de">');
    const pair = [
      ['en', 'https://example.com/about/'],
      ['fr', 'https://example.com/fr/a-propos/']
    ];
    expect(alternatesIn(preview.get(pageFile(drafted.pages[en]))!)).toEqual(pair);
    expect(alternatesIn(preview.get(pageFile(drafted.pages[fr]))!)).toEqual(pair);
    expect(pageAlternates(drafted, drafted.pages[de])).toEqual([]);
    expect(preview.get(pageFile(drafted.pages[de]))).not.toContain('hreflang');
    // The website has no page file for the draft; with only the draft in another language, no language files at all.
    const site = generateProject(publishedState(drafted));
    expect(site.has(pageFile(drafted.pages[de]))).toBe(false);
    const two = bilingual();
    const onlyDraft = apply(two.s, { type: 'page.update', pageId: two.fr, draft: true });
    const live = generateProject(publishedState(onlyDraft));
    expect(live.get(SERVER_HOOK_FILE)).toBe(generateServerHook(publishedState(onlyDraft)));
    expect(live.get(SERVER_HOOK_FILE)).not.toContain('LANGUAGES');
    expect(live.get('src/routes/+layout.svelte')).not.toContain('pageLanguages');
  });

  it('lists no versions for a set written by hand with two pages in one language', () => {
    const { s, en, fr, de } = trilingual();
    const hand = structuredClone(s);
    hand.pages[fr].language = 'EN';
    for (const id of [en, fr, de]) expect(pageAlternates(hand, hand.pages[id])).toEqual([]);
    expect(generateProject(hand).get(pageFile(hand.pages[de]))).not.toContain('hreflang');
  });

  it('warns when a built page declares another language than its own', () => {
    const { s, fr } = bilingual();
    expect(declaredLanguage('<!doctype html><html class="x" lang=\'fr-CA\'>')).toBe('fr-CA');
    expect(declaredLanguage('<html xml:lang="fr">')).toBeNull();
    expect(pageLanguageWarning(s, s.pages[fr], '<!doctype html><html lang="FR" dir="ltr">')).toBeNull();
    expect(pageLanguageWarning(s, s.pages[fr], '<!doctype html><html lang="en">')).toMatch(/“À propos” \(\/fr\/a-propos\/\) was built as “en”, not “fr”/);
    expect(pageLanguageWarning(s, s.pages[fr], '<!doctype html><html>')).toMatch(/built without a language, not “fr”/);
    // A page in the site language is checked too.
    expect(pageLanguageWarning(s, byTitle(s, 'About'), '<!doctype html><html lang="fr">')).toMatch(/“About” \(\/about\/\) was built as “fr”, not “en”/);
    expect(pageLanguageWarning(s, byTitle(s, 'About'), '<!doctype html><html lang="en" dir="ltr">')).toBeNull();
    // The way it runs as well: a page in its language but without dir runs left to right whatever its language.
    expect(pageLanguageWarning(s, s.pages[fr], '<!doctype html><html lang="fr">')).toMatch(/“À propos” \(\/fr\/a-propos\/\) was built without a direction, not left to right/);
    expect(pageLanguageWarning(s, s.pages[fr], '<!doctype html><html lang="fr" dir="rtl">')).toMatch(/was built to run right to left, not left to right/);
    // A document without the tag, after many comments, is turned down at once rather than retried every way.
    const comments = '<!-- a -->'.repeat(2000) + '<body>';
    const started = performance.now();
    expect(declaredLanguage(comments)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('stops the export when the website needs the generated server hook and the project has one of its own', async () => {
    const { s, fr } = bilingual();
    const dir = tempDir();
    mkdirSync(join(dir, 'src', 'hooks.server'), { recursive: true });
    // A folder without an index is no hook: SvelteKit passes it by.
    expect(await rivalHookStop(dir, s)).toBeNull();
    writeFileSync(join(dir, 'src', 'hooks.server', 'index.ts'), 'export const handle = ({ event, resolve }) => resolve(event);\n');
    expect(await rivalHookStop(dir, s)).toMatch(/server hook of its own \(src\/hooks\.server\/index\.ts\): SvelteKit runs only one/);
    rmSync(join(dir, 'src', 'hooks.server'), { recursive: true });
    writeFileSync(join(dir, 'src', 'hooks.server.ts'), 'export const handle = ({ event, resolve }) => resolve(event);\n');
    expect(await rivalHookStop(dir, s)).toMatch(/\(src\/hooks\.server\.ts\)/);
    rmSync(join(dir, 'src', 'hooks.server.ts'));
    // SvelteKit also takes a file of that name without an extension.
    writeFileSync(join(dir, 'src', 'hooks.server'), 'export const handle = ({ event, resolve }) => resolve(event);\n');
    expect(await rivalHookStop(dir, s)).toMatch(/\(src\/hooks\.server\)/);
    rmSync(join(dir, 'src', 'hooks.server'));
    // Without any hook at all nothing stops the export: the staged copy is given the generated hook, languages and all.
    expect(await rivalHookStop(dir, s)).toBeNull();
    mkdirSync(join(dir, 'siteorigin'));
    await settleServerHook(dir, s);
    expect(readFileSync(join(dir, SERVER_HOOK_FILE), 'utf8')).toBe(generateServerHook(s));
    expect(readFileSync(join(dir, SERVER_HOOK_FILE), 'utf8')).toContain('"/fr/a-propos": "fr"');
    rmSync(join(dir, 'siteorigin'), { recursive: true });
    // A hook at the generated path is the project's own unless SiteOrigin Builder wrote it there.
    writeFileSync(join(dir, SERVER_HOOK_FILE), 'export const handle = ({ event, resolve }) => resolve(event);\n');
    expect(await rivalHookStop(dir, s)).toMatch(/\(src\/hooks\.server\.js\)/);
    mkdirSync(join(dir, 'siteorigin'));
    writeFileSync(join(dir, 'siteorigin', 'generated-manifest.json'), JSON.stringify({ files: { [SERVER_HOOK_FILE]: 'x' } }));
    expect(await rivalHookStop(dir, s)).toBeNull();
    // A site in one language is never stopped (its not-found page keeps the addresses it was built with, and the export
    // says so), and neither is one whose only other language is a draft's.
    rmSync(join(dir, 'siteorigin'), { recursive: true });
    expect(await rivalHookStop(dir, fresh())).toBeNull();
    expect(await rivalHookStop(dir, publishedState(apply(s, { type: 'page.update', pageId: fr, draft: true })))).toBeNull();
  });

  it('never writes the generated server hook beside one of the project’s own', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'src'), { recursive: true });
    const theirs = 'export const handle = ({ event, resolve }) => resolve(event);\n';
    writeFileSync(join(dir, 'src', 'hooks.server.ts'), theirs);
    const session = await ProjectSession.create(dir, fresh());
    try {
      const about = byTitle(session.state, 'About').id;
      expect((await session.apply({ operations: [{ type: 'page.update', pageId: about, language: 'fr' }] }, { label: 'French' })).ok).toBe(true);
      // Theirs is kept; ours is not written, in the project or the preview's copies; nothing blocks editing.
      expect(readFileSync(join(dir, 'src', 'hooks.server.ts'), 'utf8')).toBe(theirs);
      expect(existsSync(join(dir, SERVER_HOOK_FILE))).toBe(false);
      expect(existsSync(join(dir, '.siteorigin', 'cache', 'dev', SERVER_HOOK_FILE))).toBe(false);
      expect(session.conflicts).toEqual([]);
      // Without theirs, ours is written at the next change; when theirs comes back, ours goes at the next change.
      rmSync(join(dir, 'src', 'hooks.server.ts'));
      await session.apply({ operations: [{ type: 'page.update', pageId: about, language: 'de' }] }, { label: 'German' });
      expect(readFileSync(join(dir, SERVER_HOOK_FILE), 'utf8')).toContain('"/about": "de"');
      writeFileSync(join(dir, 'src', 'hooks.server.ts'), theirs);
      await session.apply({ operations: [{ type: 'page.update', pageId: about, language: 'nl' }] }, { label: 'Dutch' });
      expect(existsSync(join(dir, SERVER_HOOK_FILE))).toBe(false);
      expect(session.conflicts).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
