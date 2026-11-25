import { afterEach, describe, expect, it } from 'vitest';
import type { ImageValue, InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateOperation } from '@shared/ops';
import { TEXT_LIMITS } from '@shared/text-limits';
import { generateProject } from '@generator/index';
import { IMAGE_SCHEMA } from '@agent/propschema';
import { clearKeptDrafts, dropKeptDraft, goneReport, keepDraft, keptDraft, keptDraftKey, keptField, keptOnLeave, keptRefusal, limitNote, pruneKeptDrafts, tooLongReport, unsavedReport } from '../../src/renderer/src/lib/kept-drafts';
import { draftCount, refusedDraftCount, reportRefused, resetPendingForTests, setDraft, settle } from '../../src/renderer/src/lib/pending';

/** Issue #226: text over a field's limit is refused whole, with its length and the limit, never cut short; the
 *  editor keeps it for the author to shorten. */

const fresh = () => createStarterState('business', 'Test Studio', false);
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });
const hero = (s: ProjectState) => {
  const p = s.pages[s.site.homePageId];
  return p.rootIds.map((id) => p.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === 'hero.split')!;
};
const heroImage = (s: ProjectState) => hero(s).props.image as ImageValue;
const pageNamed = (s: ProjectState, title: string) => Object.values(s.pages).find((p) => p.title === title)!;
/** Text of exactly `n` characters, ending a sentence, like copy pasted from elsewhere. */
const sentence = (n: number) => 'A bright living room with oak furniture. '.repeat(20).slice(0, n - 1) + '.';
const setAlt = (s: ProjectState, alt: string) => applyOperations(s, [{ type: 'instance.setProp', owner: owner(s), nodeId: hero(s).id, prop: 'image', value: { ...heroImage(s), alt } }]);
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('placed image descriptions', () => {
  it('refuses a description over the limit instead of keeping only its start', () => {
    const s = fresh();
    const before = heroImage(s).alt;
    expect(() => setAlt(s, sentence(328))).toThrow(/image description: 328 characters is longer than the 300 allowed/);
    expect(heroImage(s).alt).toBe(before);
  });

  it('keeps a description at the limit whole, and renders it as the image’s alt', () => {
    const s = fresh();
    s.assets.assets.img_hero = { id: 'img_hero', name: 'hero.jpg', file: 'static/assets/hero.jpg', mime: 'image/jpeg', bytes: 1, hash: 'h', kind: 'image', createdAt: '2026-01-01T00:00:00Z' };
    hero(s).props.image = { assetId: 'img_hero', alt: '' };
    const alt = sentence(TEXT_LIMITS.imageAlt);
    const next = setAlt(s, alt).state;
    expect(heroImage(next).alt).toBe(alt);
    expect(generateProject(next).get('src/routes/+page.svelte')).toContain(`"alt":${JSON.stringify(alt)}`);
  });

  it('refuses a standalone image’s description the same way', () => {
    const s = createStarterState('blank', 'Blank', false);
    const sec = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: null, index: 0, componentId: 'layout.section' }]);
    const r = applyOperations(sec.state, [{ type: 'node.insert', owner: owner(s), parentId: sec.results[0].nodeId as string, slot: 'content', primitive: 'image' }]);
    const id = r.results[0].nodeId as string;
    expect(() => applyOperations(r.state, [{ type: 'node.setContent', owner: owner(s), nodeId: id, field: 'image', value: { assetId: null, alt: sentence(301) } }])).toThrow(/301 characters is longer than the 300 allowed/);
    const ok = applyOperations(r.state, [{ type: 'node.setContent', owner: owner(s), nodeId: id, field: 'image', value: { assetId: null, alt: sentence(300) } }]).state;
    expect((ok.pages[ok.site.homePageId].nodes[id] as { image: ImageValue }).image.alt).toHaveLength(300);
  });

  it('places a library image by ID only while its suggested description fits', () => {
    const s = fresh();
    const id = heroImage(s).assetId ?? 'img_long';
    s.assets.assets[id] = { id, name: 'hero.jpg', file: 'static/assets/hero.jpg', mime: 'image/jpeg', bytes: 1, hash: 'h', kind: 'image', createdAt: '2026-01-01T00:00:00Z', altSuggestion: sentence(300) };
    expect(heroImage(applyOperations(s, [{ type: 'instance.setProp', owner: owner(s), nodeId: hero(s).id, prop: 'image', value: id }]).state).alt).toHaveLength(300);
    // A suggestion longer than the limit (saved before it had one) is not cut short either: it is shortened in Assets.
    s.assets.assets[id].altSuggestion = sentence(310);
    expect(() => applyOperations(s, [{ type: 'instance.setProp', owner: owner(s), nodeId: hero(s).id, prop: 'image', value: id }])).toThrow(/suggested alt text of "hero.jpg" \(shorten it in Assets\): 310 characters/);
  });

  it('keeps a longer description saved before the limit while it is not being changed', () => {
    const s = fresh();
    const legacy = sentence(310);
    hero(s).props.image = { ...heroImage(s), alt: legacy };
    const next = applyOperations(s, [
      { type: 'instance.setProp', owner: owner(s), nodeId: hero(s).id, prop: 'heading', value: 'New heading' },
      // Marked decorative, the same description goes along unchanged.
      { type: 'instance.setProp', owner: owner(s), nodeId: hero(s).id, prop: 'image', value: { ...heroImage(s), decorative: true } }
    ]).state;
    expect(hero(next).props.heading).toBe('New heading');
    expect(heroImage(next)).toEqual({ assetId: heroImage(s).assetId, alt: legacy, decorative: true });
    // A new description that long is still refused, even one the same length as the saved one.
    expect(() => setAlt(next, sentence(311))).toThrow(/311 characters is longer than the 300 allowed/);
    expect(() => setAlt(next, legacy.slice(0, -1) + '!')).toThrow(/310 characters is longer than the 300 allowed/);
  });

  it('keeps a standalone image’s longer saved description while its picture or Decorative changes', () => {
    const s = createStarterState('blank', 'Blank', false);
    s.assets.assets.img_a = { id: 'img_a', name: 'a.jpg', file: 'static/assets/a.jpg', mime: 'image/jpeg', bytes: 1, hash: 'h', kind: 'image', createdAt: '2026-01-01T00:00:00Z' };
    const sec = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: null, index: 0, componentId: 'layout.section' }]);
    const r = applyOperations(sec.state, [{ type: 'node.insert', owner: owner(s), parentId: sec.results[0].nodeId as string, slot: 'content', primitive: 'image' }]);
    const id = r.results[0].nodeId as string;
    const legacy = sentence(310);
    (r.state.pages[r.state.site.homePageId].nodes[id] as { image: ImageValue }).image = { assetId: null, alt: legacy };
    const set = (value: ImageValue) => applyOperations(r.state, [{ type: 'node.setContent', owner: owner(s), nodeId: id, field: 'image', value }]);
    const image = (st: ProjectState) => (st.pages[st.site.homePageId].nodes[id] as { image: ImageValue }).image;
    expect(image(set({ assetId: null, alt: legacy, decorative: true }).state)).toEqual({ assetId: null, alt: legacy, decorative: true });
    expect(image(set({ assetId: 'img_a', alt: legacy }).state)).toEqual({ assetId: 'img_a', alt: legacy });
    expect(() => set({ assetId: null, alt: legacy + ' More.' })).toThrow(/316 characters is longer than the 300 allowed/);
    expect(() => set({ assetId: null, alt: legacy.slice(0, -1) + '!' })).toThrow(/310 characters is longer than the 300 allowed/);
  });

  it('keeps a design’s longer saved default description while its image is marked decorative', () => {
    const s0 = fresh();
    const theme = Object.values(s0.components).find((d) => d.componentId === 'hero.split')!;
    const forked = applyOperations(s0, [{ type: 'component.fork', definitionId: theme.id }]);
    const defId = forked.results[0].definitionId as string;
    const s = forked.state;
    const legacy = sentence(310);
    const prop = s.components[defId].properties.image as { default: ImageValue };
    prop.default = { assetId: null, alt: legacy };
    const set = (value: ImageValue) => applyOperations(s, [{ type: 'node.setContent', owner: { kind: 'component', id: defId }, nodeId: 'media', field: 'image', value }]);
    const next = set({ assetId: null, alt: legacy, decorative: true }).state;
    expect(next.components[defId].properties.image.default).toEqual({ assetId: null, alt: legacy, decorative: true });
    expect(() => set({ assetId: null, alt: legacy.slice(0, -1) + '!' })).toThrow(/310 characters is longer than the 300 allowed/);
  });

  it('tells a model the same limit the engine keeps', () => {
    expect((IMAGE_SCHEMA.properties as { alt: { maxLength: number } }).alt.maxLength).toBe(TEXT_LIMITS.imageAlt);
  });
});

describe('page details, site description and library text', () => {
  const cases: Array<[string, number, (text: string) => unknown]> = [
    ['page description', TEXT_LIMITS.pageDescription, (t) => ({ type: 'page.update', pageId: 'pg_about', description: t })],
    ['browser title', TEXT_LIMITS.seoTitle, (t) => ({ type: 'page.update', pageId: 'pg_about', seoTitle: t })],
    ['page title', TEXT_LIMITS.pageTitle, (t) => ({ type: 'page.update', pageId: 'pg_about', title: t })],
    ['navigation label', TEXT_LIMITS.navLabel, (t) => ({ type: 'page.update', pageId: 'pg_about', navLabel: t })],
    ['byline', TEXT_LIMITS.byline, (t) => ({ type: 'page.update', pageId: 'pg_about', byline: t })],
    ['excerpt', TEXT_LIMITS.excerpt, (t) => ({ type: 'page.update', pageId: 'pg_about', excerpt: t })],
    ['new article’s excerpt', TEXT_LIMITS.excerpt, (t) => ({ type: 'page.create', title: 'News', starter: 'article', articleDate: '2026-11-24', excerpt: t })],
    ['new article’s byline', TEXT_LIMITS.byline, (t) => ({ type: 'page.create', title: 'News', starter: 'article', articleDate: '2026-11-24', byline: t })],
    ['site description', TEXT_LIMITS.siteDescription, (t) => ({ type: 'site.update', description: t })],
    ['library description', TEXT_LIMITS.assetDescription, (t) => ({ type: 'asset.update', assetId: 'a_hero', description: t })],
    ['library alt suggestion', TEXT_LIMITS.altSuggestion, (t) => ({ type: 'asset.update', assetId: 'a_hero', altSuggestion: t })]
  ];
  for (const [name, limit, op] of cases)
    it(`takes a ${name} of exactly ${limit} characters, and refuses one more with its length and the limit`, () => {
      expect(validateOperation(op(sentence(limit))).ok).toBe(true);
      const r = validateOperation(op(sentence(limit + 1)));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.message).toMatch(new RegExp(`${limit + 1} characters is longer than the ${limit} allowed`));
    });

  it('adds a library file with the text it comes with, as a web-sized copy of an older one does', () => {
    const asset = { id: 'img_x', name: 'x.jpg', file: 'static/assets/x.jpg', mime: 'image/jpeg', bytes: 1, hash: 'h', kind: 'image', createdAt: '2026-01-01T00:00:00Z' };
    expect(validateOperation({ type: 'asset.add', asset: { ...asset, altSuggestion: sentence(301), description: sentence(501) } }).ok).toBe(true);
  });

  it('says how long the reported 342-character description is, not “Too big”', () => {
    const r = validateOperation({ type: 'page.update', pageId: 'pg_about', description: sentence(342) });
    expect(!r.ok && r.message).toBe('description: 342 characters is longer than the 320 allowed.');
  });

  it('saves a description shortened to fit, and the page’s metadata shows it whole', () => {
    const s = fresh();
    const about = pageNamed(s, 'About');
    const text = sentence(320);
    expect(validateOperation({ type: 'page.update', pageId: about.id, description: text }).ok).toBe(true);
    const next = applyOperations(s, [{ type: 'page.update', pageId: about.id, description: text }]).state;
    expect(next.pages[about.id].seo.description).toBe(text);
    const page = [...generateProject(next).entries()].find(([path, content]) => path.includes('about') && content.includes(text));
    expect(page, 'the About page carries the whole description').toBeTruthy();
  });
});

describe('text a field refused, handed between the places that show the same field (#702)', () => {
  afterEach(() => clearKeptDrafts());
  const leaving = { open: true, gone: false, over: false, tooLong: false, checked: false, mine: true };

  it('is shown again as what it was refused for: too long, or by the field’s check', () => {
    const canonical = keptField('ws-1', 'page:pg_about:canonical');
    expect(keptRefusal(keptDraft(canonical))).toBeNull();
    keepDraft(canonical, { text: 'journal.example/about', start: null, refused: 'check' });
    expect(keptRefusal(keptDraft(canonical))).toBe('check');
    // Text kept before checks were kept (an inline rename's, a description's) is too long, as it always was.
    const description = keptField('ws-1', 'page:pg_about:description');
    keepDraft(description, { text: sentence(342), start: null });
    expect(keptRefusal(keptDraft(description))).toBe('long');
  });

  it('stays for its place when the control showing it goes with it unsaved, and goes once settled', () => {
    // Refused by the check and still in the field: the next control of the place (the Inspector, the SEO view) takes it up.
    expect(keptOnLeave({ ...leaving, checked: true })).toBe('check');
    // Too long wins: text over the limit, or once refused as such, is kept as too long.
    expect(keptOnLeave({ ...leaving, checked: true, over: true })).toBe('long');
    expect(keptOnLeave({ ...leaving, tooLong: true })).toBe('long');
    // Put back (Escape), saved, or typed in another opening: nothing is open, so what was kept goes.
    expect(keptOnLeave({ ...leaving, open: false, checked: true })).toBe('drop');
    expect(keptOnLeave({ ...leaving, open: false, tooLong: true })).toBe('drop');
    // The page it belongs to has gone: nothing is kept for a place no field can show again.
    expect(keptOnLeave({ ...leaving, gone: true, checked: true })).toBe('drop');
    expect(keptOnLeave({ ...leaving, gone: true, tooLong: true, over: true })).toBe('drop');
    // A field that refused nothing keeps nothing.
    expect(keptOnLeave(leaving)).toBeNull();
  });

  it('is never kept or dropped by a control another control of its place has taken it from', () => {
    for (const f of [{ checked: true }, { tooLong: true }, { over: true }, { checked: true, over: true }, { checked: true, open: false }, { tooLong: true, gone: true }]) expect(keptOnLeave({ ...leaving, ...f, mine: false })).toBeNull();
  });

  it('passes from the SEO view to the Inspector and back as the same text, never to another page', () => {
    const about = keptField('ws-1', 'page:pg_about:canonical');
    const view = {};
    const inspector = {};
    // Refused in the view: kept for the place at once, so the Inspector's field, rendered in the same update, finds it.
    keepDraft(about, { text: 'journal.example/about', start: { value: 'https://old.example/about' }, refused: 'check', owner: view });
    const found = keptDraft<{ value: string }>(about);
    expect(keptRefusal(found)).toBe('check');
    expect(found?.text).toBe('journal.example/about');
    // The Inspector takes it up; the view's control, going after, leaves it alone.
    keepDraft(about, { ...found!, owner: inspector });
    expect(keptOnLeave({ ...leaving, checked: true, mine: keptDraft(about)?.owner === view })).toBeNull();
    expect(keptDraft(about)?.text).toBe('journal.example/about');
    // Another page, or the same page in another opening, has nothing kept.
    expect(keptDraft(keptField('ws-1', 'page:pg_contact:canonical'))).toBeUndefined();
    expect(keptDraft(keptField('ws-2', 'page:pg_about:canonical'))).toBeUndefined();
    // Corrected and saved in the Inspector: settled, so nothing comes back in the view.
    expect(keptOnLeave({ ...leaving, open: false, checked: true, mine: keptDraft(about)?.owner === inspector })).toBe('drop');
  });
});

describe('text kept for a field while it is too long to save', () => {
  afterEach(() => {
    clearKeptDrafts();
    resetPendingForTests();
  });

  it('belongs to its field in one opening of a project, and goes when dropped or the project closes', () => {
    const about = keptField('ws-1', 'page:pg_about:description');
    keepDraft(about, { text: sentence(342), start: { value: 'Old' } });
    expect(keptDraft(about)?.text).toHaveLength(342);
    // The same field in another opening (or another project) has nothing kept.
    expect(keptDraft(keptField('ws-2', 'page:pg_about:description'))).toBeUndefined();
    expect(keptDraft(keptField('ws-1', 'page:pg_contact:description'))).toBeUndefined();
    expect(dropKeptDraft(about)).toBe(true);
    expect(keptDraft(about)).toBeUndefined();
    keepDraft(about, { text: 'x', start: null });
    keepDraft(keptField('ws-1', 'asset:a_hero:altSuggestion'), { text: 'y', start: null });
    expect(clearKeptDrafts()).toEqual([about, keptField('ws-1', 'asset:a_hero:altSuggestion')]);
    expect(keptDraft(about)).toBeUndefined();
  });

  it('goes, to be offered to copy, once what it belongs to is removed, and stays while that is there', () => {
    let pageThere = true;
    const about = keptField('ws-1', 'page:pg_about:description');
    const site = keptField('ws-1', 'site:description');
    keepDraft(about, { text: sentence(342), start: null, name: 'Description', alive: () => pageThere });
    keepDraft(site, { text: sentence(330), start: null });
    expect(pruneKeptDrafts()).toEqual([]);
    pageThere = false;
    const gone = pruneKeptDrafts();
    expect(gone.map(([field, d]) => [field, d.text, d.name])).toEqual([[about, sentence(342), 'Description']]);
    expect(keptDraft(about)).toBeUndefined();
    // Text with no check of its own (the site's description) is never pruned.
    expect(keptDraft(site)?.text).toHaveLength(330);
    expect(goneReport('Description')).toBe('What you typed in Description was not saved, and what it belonged to has been removed.');
    expect(unsavedReport('Image description')).toBe('What you typed in Image description has not been saved.');
  });

  it('counts against the limit as the author types, and says by how much to shorten once refused', () => {
    expect(limitNote(0, 320, false)).toEqual({ text: '0 / 320', over: false });
    expect(limitNote(320, 320, false)).toEqual({ text: '320 / 320', over: false });
    expect(limitNote(342, 320, false)).toEqual({ text: '342 / 320. Shorten it by 22 characters to save it.', over: true });
    expect(limitNote(342, 320, true)).toEqual({ text: 'Not saved: 342 / 320 characters. Shorten it by 22 characters to save it.', over: true });
    expect(limitNote(301, 300, true).text).toBe('Not saved: 301 / 300 characters. Shorten it by 1 character to save it.');
  });

  it('names the field and the lengths when saving or leaving reports it', () => {
    expect(tooLongReport('Description', 342, 320)).toBe('What you typed in Description is 342 characters, longer than the 320 allowed, so it has not been saved.');
    expect(tooLongReport('', 328, 300)).toBe('Something you typed is 328 characters, longer than the 300 allowed, so it has not been saved.');
  });

  it('keeps the toolbar from saying saved, and is reported by a save or a leave while its field is off screen', async () => {
    const key = keptDraftKey(keptField('ws-1', 'page:pg_about:description'));
    const report = tooLongReport('Description', 342, 320);
    // Typed (or pasted) first, so already open, then refused as the field is left: that is a change too.
    expect(setDraft(key, true)).toBe(true);
    expect(refusedDraftCount()).toBe(0);
    expect(setDraft(key, true, report)).toBe(true);
    expect(setDraft(key, true, report)).toBe(false);
    expect(draftCount()).toBe(1);
    expect(refusedDraftCount()).toBe(1);
    // Coming back to the field (focus) marks it again without losing why it is open.
    setDraft(key, true);
    const { problems, finish } = await settle({ blur: () => undefined, wait });
    finish();
    expect(problems).toEqual([report]);
    // Shortened and saved: nothing is left open, and nothing is said about it any more.
    setDraft(key, false);
    expect(refusedDraftCount()).toBe(0);
    setDraft(key, true);
    const again = await settle({ blur: () => undefined, wait });
    again.finish();
    expect(again.problems).toEqual(['A change you were typing has not been saved.']);
  });

  it('is reported once when its field is on screen and refuses it again as the save blurs it', async () => {
    const key = keptDraftKey(keptField('ws-1', 'page:pg_about:description'));
    const report = tooLongReport('Description', 342, 320);
    setDraft(key, true, report);
    const { problems, finish } = await settle({ blur: () => reportRefused(report, key), wait });
    finish();
    expect(problems).toEqual([report]);
  });
});
