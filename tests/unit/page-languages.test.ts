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
import { HOOKS_SERVER_FILE, generateAppHtml, generateProject, pageAlternates, pageFile, publishedState } from '@generator/index';
import { declaredLanguage, linkClash, pageLanguage, translationPeers } from '@shared/languages';
import { pageLanguageWarning, rivalHookStop } from '../../src/main/export';
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

/** Load the generated server hook as the site would, from where the project keeps it, unchanged. */
async function loadHook(files: Map<string, string>) {
  const dir = tempDir();
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, HOOKS_SERVER_FILE), files.get(HOOKS_SERVER_FILE)!);
  const hook = (await import(/* @vite-ignore */ pathToFileURL(join(dir, HOOKS_SERVER_FILE)).href)) as { handle: (input: unknown) => unknown };
  /** What the hook makes of each chunk of HTML SvelteKit renders for a route. */
  return (routeId: string | null, chunks: string[]) =>
    hook.handle({
      event: { route: { id: routeId } },
      resolve: (_e: unknown, opts?: { transformPageChunk: (c: { html: string; done: boolean }) => string }) => chunks.map((html, i) => (opts ? opts.transformPageChunk({ html, done: i === chunks.length - 1 }) : html))
    }) as string[];
}

/** The page's alternate links: the language and the address, a site path given as `resolve(...)` written as it. */
const alternatesIn = (file: string) => [...file.matchAll(/<link rel="alternate" hreflang="([^"]+)" href=\{(?:"([^"]+)"|resolve\("([^"]+)"\))\} \/>/g)].map((m) => [m[1], m[2] ?? `resolve:${m[3]}`]);
/** The structured data a page file renders. */
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

describe('page languages in the website', () => {
  it('generates a site in one language exactly as before', () => {
    const s = apply(fresh(), { type: 'site.update', baseUrl: 'https://example.com/' });
    const files = generateProject(s);
    expect(files.has(HOOKS_SERVER_FILE)).toBe(false);
    expect([...files.keys()].filter((p) => /language/.test(p))).toEqual([]);
    expect(files.get('src/app.html')).toBe(
      '<!doctype html>\n<html lang="en">\n\t<head>\n\t\t<meta charset="utf-8" />\n\t\t<meta name="viewport" content="width=device-width, initial-scale=1" />\n\t\t%sveltekit.head%\n\t</head>\n\t<body data-sveltekit-preload-data="hover">\n\t\t<div style="display: contents">%sveltekit.body%</div>\n\t</body>\n</html>\n'
    );
    expect(files.get('src/routes/+layout.svelte')).not.toMatch(/pageLanguages|documentElement/);
    for (const [path, content] of files) {
      if (!path.endsWith('+page.svelte')) continue;
      expect(content).not.toMatch(/hreflang|\$app\/paths/);
      expect(ld(content).map((d) => d['@type'])).toEqual(path === 'src/routes/+page.svelte' ? ['WebSite'] : []);
    }
    expect(ld(files.get('src/routes/+page.svelte')!)[0]).toMatchObject({ '@type': 'WebSite', url: 'https://example.com/', inLanguage: 'en' });
    // A page that names the site's own language changes nothing either.
    const pinned = apply(s, { type: 'page.update', pageId: byTitle(s, 'About').id, language: 'EN' });
    expect([...generateProject(pinned)]).toEqual([...files]);
    expect([...generateProject(pinned, { instrument: true })]).toEqual([...generateProject(s, { instrument: true })]);
  });

  it('declares each page’s language on first load and as visitors move between pages', async () => {
    const { s } = trilingual();
    for (const instrument of [false, true]) {
      const files = generateProject(s, { instrument });
      // The hook stands alone: it imports nothing, so a hook kept after the site is in one language again still runs.
      const hook = files.get(HOOKS_SERVER_FILE)!;
      expect(hook).not.toMatch(/^import /m);
      expect([...files.values()].some((f) => f.includes('$lib'))).toBe(false);
      // app.html keeps naming the site's language: every page in it needs nothing more.
      expect(files.get('src/app.html')).toBe(generateAppHtml(fresh()));
      const render = await loadHook(files);
      const html = files.get('src/app.html')!.replace('%sveltekit.head%', '<title>x</title>').replace('%sveltekit.body%', '<p>&lt;html lang="en"&gt;</p>');
      expect(render('/fr/a-propos', [html])[0]).toBe(html.replace('<html lang="en">', '<html lang="fr">'));
      expect(render('/de/ueber-uns', [html])[0]).toBe(html.replace('<html lang="en">', '<html lang="de">'));
      for (const id of ['/about', '/', null]) expect(render(id, [html])[0]).toBe(html);
      // Only the document's own opening tag changes: a later chunk is left as it is.
      const [first, later] = render('/fr/a-propos', [html.slice(0, 40), '<html lang="en"> as text']);
      expect(first).toContain('<html lang="fr">');
      expect(later).toBe('<html lang="en"> as text');
      // A template of the project's own: other attributes, single quotes, no lang at all, or a comment first.
      expect(render('/fr/a-propos', ["<!doctype html>\n<html class='site' lang='en' data-x>"])[0]).toBe("<!doctype html>\n<html class='site' lang=\"fr\" data-x>");
      expect(render('/fr/a-propos', ['<!-- mine -->\n<!DOCTYPE html><HTML class="site">'])[0]).toBe('<!-- mine -->\n<!DOCTYPE html><HTML class="site" lang="fr">');
      expect(render('/fr/a-propos', ['<html xml:lang="en" lang="fr">'])[0]).toBe('<html xml:lang="en" lang="fr">');
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
      expect(layout).toContain('document.documentElement.lang = id && Object.hasOwn(pageLanguages, id) ? pageLanguages[id] : "en";');
      expect(() => compile(layout, { generate: 'server', filename: 'src/routes/+layout.svelte', runes: true })).not.toThrow();
      expect(() => compile(layout, { generate: 'client', filename: 'src/routes/+layout.svelte', runes: true })).not.toThrow();
    }
  });

  it('lists the same languages whatever order the pages are in', () => {
    const { s, fr, de } = trilingual();
    const reordered = apply(s, { type: 'page.reorder', pageIds: [...s.site.pageOrder].reverse() });
    expect(s.site.pageOrder.indexOf(fr)).toBeLessThan(s.site.pageOrder.indexOf(de));
    expect(generateProject(reordered).get(HOOKS_SERVER_FILE)).toBe(generateProject(s).get(HOOKS_SERVER_FILE));
    expect(layoutTable(generateProject(reordered).get('src/routes/+layout.svelte')!)).toEqual({ '/de/ueber-uns': 'de', '/fr/a-propos': 'fr' });
    expect(generateProject(reordered).get('src/routes/+layout.svelte')).toBe(generateProject(s).get('src/routes/+layout.svelte'));
  });

  it('lists every version, itself included, on each version, with or without a public address', () => {
    const { s, en, fr, de } = trilingual();
    const files = generateProject(s);
    const local = [
      ['en', 'resolve:/about/'],
      ['fr', 'resolve:/fr/a-propos/'],
      ['de', 'resolve:/de/ueber-uns/']
    ];
    for (const id of [en, fr, de]) {
      expect(alternatesIn(files.get(pageFile(s.pages[id]))!)).toEqual(local);
      // Site paths are resolved as authored links are, so they hold wherever the site is put.
      expect(files.get(pageFile(s.pages[id]))).toContain("\timport { resolve } from '$app/paths';");
      expect(() => compile(files.get(pageFile(s.pages[id]))!, { generate: 'server', filename: pageFile(s.pages[id]), runes: true })).not.toThrow();
    }
    // Pages without translations list none.
    expect(files.get(pageFile(byTitle(s, 'Contact')))).not.toContain('hreflang');
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
    }
    // Each page also says which language it is in, for search engines; the site's own description stays as it was.
    expect(ld(pub.get(pageFile(s.pages[fr]))!)).toEqual([{ '@context': 'https://schema.org', '@type': 'WebPage', name: 'À propos du studio', url: 'https://example.com/studio/fr/a-propos/', inLanguage: 'fr' }]);
    expect(ld(pub.get(pageFile(s.pages[s.site.homePageId]))!).map((d) => [d['@type'], d.inLanguage])).toEqual([
      ['WebSite', 'en'],
      ['WebPage', 'en']
    ]);
    // A page hidden from search engines is still a published version, with no structured data of its own.
    const hidden = generateProject(apply(published, { type: 'page.update', pageId: fr, noindex: true }));
    expect(alternatesIn(hidden.get(pageFile(s.pages[en]))!)).toEqual(full);
    expect(alternatesIn(hidden.get(pageFile(s.pages[fr]))!)).toEqual(full);
    expect(ld(hidden.get(pageFile(s.pages[fr]))!)).toEqual([]);
  });

  it('follows a version to its new address and to the Home page', () => {
    const { s, en, fr } = bilingual();
    const moved = apply(s, { type: 'page.update', pageId: fr, route: '/fr/studio/' });
    expect(alternatesIn(generateProject(moved).get(pageFile(moved.pages[en]))!)).toEqual([
      ['en', 'resolve:/about/'],
      ['fr', 'resolve:/fr/studio/']
    ]);
    const home = apply(s, { type: 'page.setHome', pageId: fr });
    const files = generateProject(home);
    const both = [
      ['en', 'resolve:/about/'],
      ['fr', 'resolve:/']
    ];
    expect(alternatesIn(files.get(pageFile(home.pages[en]))!)).toEqual(both);
    expect(alternatesIn(files.get(pageFile(home.pages[fr]))!)).toEqual(both);
    expect(layoutTable(files.get('src/routes/+layout.svelte')!)).toEqual({ '/': 'fr' });
  });

  it('leaves a draft version out of the website, and previews it in its own language', async () => {
    const { s, en, fr, de } = trilingual();
    const drafted = apply(s, { type: 'page.update', pageId: de, draft: true });
    // The preview shows the draft in German; the published versions list each other and not the draft, which lists none.
    const preview = generateProject(drafted, { instrument: true });
    expect((await loadHook(preview))('/de/ueber-uns', ['<!doctype html><html lang="en">'])[0]).toBe('<!doctype html><html lang="de">');
    const pair = [
      ['en', 'resolve:/about/'],
      ['fr', 'resolve:/fr/a-propos/']
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
    expect(live.has(HOOKS_SERVER_FILE)).toBe(false);
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
    expect(pageLanguageWarning(s, s.pages[fr], '<!doctype html><html lang="FR">')).toBeNull();
    expect(pageLanguageWarning(s, s.pages[fr], '<!doctype html><html lang="en">')).toMatch(/“À propos” \(\/fr\/a-propos\/\) was built as “en”, not “fr”/);
    expect(pageLanguageWarning(s, s.pages[fr], '<!doctype html><html>')).toMatch(/built without a language, not “fr”/);
    // A page in the site language is checked too.
    expect(pageLanguageWarning(s, byTitle(s, 'About'), '<!doctype html><html lang="fr">')).toMatch(/“About” \(\/about\/\) was built as “fr”, not “en”/);
    expect(pageLanguageWarning(s, byTitle(s, 'About'), '<!doctype html><html lang="en">')).toBeNull();
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
    // A hook at the generated path is the project's own unless SiteOrigin Builder wrote it there.
    writeFileSync(join(dir, HOOKS_SERVER_FILE), 'export const handle = ({ event, resolve }) => resolve(event);\n');
    expect(await rivalHookStop(dir, s)).toMatch(/\(src\/hooks\.server\.js\)/);
    mkdirSync(join(dir, 'siteorigin'));
    writeFileSync(join(dir, 'siteorigin', 'generated-manifest.json'), JSON.stringify({ files: { [HOOKS_SERVER_FILE]: 'x' } }));
    expect(await rivalHookStop(dir, s)).toBeNull();
    // A site in one language needs no hook of ours, and neither does one whose only other language is a draft's.
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
      expect(existsSync(join(dir, HOOKS_SERVER_FILE))).toBe(false);
      expect(existsSync(join(dir, '.siteorigin', 'cache', 'dev', HOOKS_SERVER_FILE))).toBe(false);
      expect(session.conflicts).toEqual([]);
      // Without theirs, ours is written at the next change; when theirs comes back, ours goes at the next change.
      rmSync(join(dir, 'src', 'hooks.server.ts'));
      await session.apply({ operations: [{ type: 'page.update', pageId: about, language: 'de' }] }, { label: 'German' });
      expect(readFileSync(join(dir, HOOKS_SERVER_FILE), 'utf8')).toContain('"/about": "de"');
      writeFileSync(join(dir, 'src', 'hooks.server.ts'), theirs);
      await session.apply({ operations: [{ type: 'page.update', pageId: about, language: 'nl' }] }, { label: 'Dutch' });
      expect(existsSync(join(dir, HOOKS_SERVER_FILE))).toBe(false);
      expect(session.conflicts).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
