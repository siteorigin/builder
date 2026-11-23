/**
 * New-chat starters come from the project (issue #54): the page being edited, the selection, the pages that exist
 * (renamed or not) and the images available. A starter never names a page, an image or an element that is not there.
 */
import { describe, expect, it } from 'vitest';
import type { AssetRecord, ElementRef, GraphNode, InstanceNode, LinkNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { installComponent, makeInstance } from '@engine/install';
import { headerMenu } from '@engine/tree';
import { assetUsages } from '@engine/apply';
import { chatSuggestions, type ChatSuggestion, type SuggestionInput } from '../../src/renderer/src/lib/chatSuggestions';

const ALL = { page: true, selection: true };

/** The report's site: a Blank site named 灯台 whose second page, お問い合わせ, was just added. */
function lighthouse() {
  const s = createStarterState('blank', '灯台', false);
  const r = applyOperations(s, [{ type: 'page.create', title: 'お問い合わせ', starter: 'intro', addToNavigation: true }]);
  return { state: r.state, home: r.state.site.homePageId, second: r.results[0].pageId as string };
}

const asset = (id: string, name: string, extra: Partial<AssetRecord> = {}): AssetRecord => ({
  id,
  name,
  file: `static/assets/${id}.jpg`,
  mime: 'image/jpeg',
  bytes: 1000,
  width: 1600,
  height: 900,
  hash: id,
  kind: 'image',
  createdAt: '2026-11-20T09:00:00.000Z',
  ...extra
});

/** The inputs a starter list is made from, as the chat panel reads them. */
const starters = (state: ProjectState, pageId: string | null, over: Partial<SuggestionInput> = {}): ChatSuggestion[] =>
  chatSuggestions({ state, assetUsage: assetUsages(state), pageId, selection: null, context: ALL, ...over });
const texts = (list: ChatSuggestion[]) => list.map((s) => s.text);

/** A split hero, with this image, as the last section of a page. */
function addHero(state: ProjectState, pageId: string, image: { assetId: string | null; alt: string; decorative?: boolean }) {
  const defId = installComponent(state, 'hero.split');
  const hero = makeInstance(state.components[defId], { heading: 'A calm place to start', lead: 'Welcome in.', image });
  state.pages[pageId].nodes[hero.id] = hero;
  state.pages[pageId].rootIds.push(hero.id);
  return hero;
}

describe('starters for the page being edited', () => {
  it('the reported site offers real targets: the page, a labelled other page, and a missing page, with no Contact or FAQ', () => {
    const { state, second } = lighthouse();
    const list = starters(state, second);
    expect(list.map((s) => s.kind)).toEqual(['page', 'cross-page', 'create-page']);
    // The open page is "お問い合わせ", whose intro holds only its title.
    expect(list[0].text).toBe('Build out the “お問い合わせ” page: it is mostly empty, so add the sections and content it needs');
    // Home is another page, and says so.
    expect(list[1].text).toMatch(/^On another page, “Home”: /);
    // お問い合わせ is the contact page, so Contact is not offered again; the next missing page is.
    expect(list[2].text).toBe('Create a new About page with who is behind the site, what it stands for and a call to action, and link it from the header menu');
    for (const t of texts(list)) expect(t).not.toMatch(/Contact|FAQ/);
    // Every page it names is a page this site has.
    for (const m of texts(list).flatMap((t) => [...t.matchAll(/“([^”]+)”/g)].map((x) => x[1]))) expect(['お問い合わせ', 'Home']).toContain(m);
  });

  it('puts the new image on the open page first, whether it is in the library, placed without alt text, or fills an empty image', () => {
    const { state, second } = lighthouse();
    state.assets.assets.a_harbor = asset('a_harbor', 'Harbor light', { createdAt: '2026-11-23T08:00:00.000Z' });
    state.assets.assets.a_old = asset('a_old', 'Old pier');
    // In the library only: place it.
    expect(starters(state, second)[0].text).toBe('Place the “Harbor light” image on the “お問い合わせ” page, where it fits best');
    // Placed with no description: describe it, by name, on that page.
    const hero = addHero(state, second, { assetId: 'a_harbor', alt: '' });
    expect(starters(state, second)[0].text).toBe('Write alt text for the “Harbor light” image on the “お問い合わせ” page');
    // Described: the library's other unused image is still waiting to be placed.
    (hero.props.image as { alt: string }).alt = 'The harbor light at dusk';
    expect(starters(state, second)[0].text).toBe('Place the “Old pier” image on the “お問い合わせ” page, where it fits best');
    // Everything is in use and described: the placed image can be improved.
    delete state.assets.assets.a_old;
    expect(starters(state, second)[0].text).toBe('Improve how the “Harbor light” image looks and reads on the “お問い合わせ” page');
    // An image field with nothing in it takes the newest unused image from the library.
    state.assets.assets.a_new = asset('a_new', 'Sea wall', { createdAt: '2026-11-23T10:00:00.000Z' });
    hero.props.image = { assetId: null, alt: '' };
    expect(starters(state, second)[0].text).toBe('Place the “Sea wall” image in the empty image on the “お問い合わせ” page');
  });

  it('leaves out an image starter when nothing on the page or in the library is an image to work with', () => {
    const { state, second } = lighthouse();
    // A font in the library is not an image to place; one used on another page is not new.
    state.assets.assets.f_serif = asset('f_serif', 'Serif', { kind: 'font', mime: 'font/woff2' });
    expect(starters(state, second).map((s) => s.kind)).toEqual(['page', 'cross-page', 'create-page']);
    state.assets.assets.a_used = asset('a_used', 'Used elsewhere');
    addHero(state, state.site.homePageId, { assetId: 'a_used', alt: 'Somewhere else' });
    expect(texts(starters(state, second)).join('\n')).not.toMatch(/Used elsewhere/);
    // A decorative image needs no description.
    state.assets.assets.a_deco = asset('a_deco', 'Pattern');
    addHero(state, second, { assetId: 'a_deco', alt: '', decorative: true });
    expect(texts(starters(state, second)).join('\n')).not.toMatch(/alt text/);
    // With no image at all, an empty image field asks for a suggestion rather than a library image.
    const bare = lighthouse();
    addHero(bare.state, bare.second, { assetId: null, alt: '' });
    expect(starters(bare.state, bare.second)[0].text).toBe('Suggest what kind of photo suits the empty image on the “お問い合わせ” page');
  });

  it('tells a mostly empty page from one with content, and an empty page from both', () => {
    const { state, second } = lighthouse();
    expect(starters(state, second)[0].text).toMatch(/^Build out the “お問い合わせ” page/);
    // A page with nothing on it is started.
    state.pages[second].rootIds = [];
    expect(starters(state, second)[0].text).toBe('Start the “お問い合わせ” page: add an introduction and the sections it needs');
    // A page with real content is improved rather than built out, with its own copy counted from component properties.
    const rich = createStarterState('business', 'Studio', false);
    const home = rich.site.homePageId;
    expect(texts(starters(rich, home))).toContain('Rewrite the opening of the “Home” page to sound warmer and more confident');
    // Its hero has an empty image, which no library image fills.
    expect(starters(rich, home)[0].text).toBe('Suggest what kind of photo suits the empty image on the “Home” page');
    // Blank's Home has a title and one line: still mostly empty.
    const blank = createStarterState('blank', 'Test', false);
    expect(starters(blank, blank.site.homePageId)[0].text).toMatch(/^Build out the “Home” page/);
    // A long piece of copy in one text node is content, however few nodes it is in.
    const long = lighthouse();
    const text: GraphNode = { id: 'n_long', kind: 'text', tag: 'p', text: 'Lighthouse keepers wrote their days down in logbooks. '.repeat(8) };
    long.state.pages[long.second].nodes.n_long = text;
    long.state.pages[long.second].rootIds.push('n_long');
    expect(starters(long.state, long.second)[0].text).toMatch(/^Rewrite the opening of the “お問い合わせ” page/);
  });

  it('offers another page only when it exists, by its current title, and marks it as another page', () => {
    const one = createStarterState('blank', 'Test', false);
    expect(starters(one, one.site.homePageId).map((s) => s.kind)).not.toContain('cross-page');
    const { state, home, second } = lighthouse();
    // Viewing Home, the other page is the second one, built out because it is mostly empty.
    expect(texts(starters(state, home))).toContain('On another page, “お問い合わせ”: build out its content, it is mostly empty');
    // Renaming it renames the starter.
    const renamed = applyOperations(state, [{ type: 'page.update', pageId: second, title: 'Say hello' }]).state;
    expect(texts(starters(renamed, home)).join('\n')).toMatch(/“Say hello”/);
    expect(texts(starters(renamed, home)).join('\n')).not.toMatch(/お問い合わせ/);
    // A page with a bare title and nothing on it is started.
    state.pages[second].rootIds = [];
    expect(texts(starters(state, home))).toContain('On another page, “お問い合わせ”: add an introduction and the sections it needs');
  });

  it('keeps titles safe: one line, no stray quotes, clipped, and the address when two pages share a title', () => {
    const { state, second } = lighthouse();
    state.pages[second].title = 'The “Big”\n"Day"  out and then a very long title that goes on past any sensible length for a button';
    const [first] = texts(starters(state, second));
    expect(first).not.toMatch(/\n/);
    expect(first).toMatch(/^Build out the “The 'Big' 'Day' out and then a very long title that goes on…” page: /);
    state.pages[second].title = 'Home ';
    expect(texts(starters(state, second))[0]).toContain(`“Home” (${state.pages[second].route})`);
  });

  it('follows the page the message goes to: Home when the page is left out, and Home when the viewed page is gone', () => {
    const { state, home, second } = lighthouse();
    const off = starters(state, second, { context: { page: false, selection: true } });
    expect(texts(off)[0]).toMatch(/^Build out the “Home” page/);
    // With the page left out, nothing says which page "another" is, so no other page is offered.
    expect(off.map((s) => s.kind)).not.toContain('cross-page');
    const gone = starters(state, 'pg_deleted');
    expect(texts(gone)[0]).toMatch(/^Build out the “Home” page/);
    expect(texts(starters(state, null))[0]).toMatch(/“Home”/);
    expect(texts(gone).join('\n')).toContain('On another page, “お問い合わせ”');
    expect(home).toBeTruthy();
  });
});

describe('a missing page is offered explicitly, and a page that goes by another name is not asked for again', () => {
  const create = (state: ProjectState) => texts(starters(state, state.site.homePageId)).find((t) => t.startsWith('Create a new '));

  it('offers Contact first on a one-page site, linked from the header', () => {
    const s = createStarterState('blank', 'Test', false);
    expect(create(s)).toBe('Create a new Contact page with a short note, how to get in touch and a simple way to send a message, and link it from the header menu');
  });

  it('does not duplicate a destination renamed to another title, menu label or address, or in another language', () => {
    const base = () => lighthouse();
    for (const [title, set] of [
      ['Get in touch', (p: ProjectState['pages'][string]) => (p.title = 'Get in touch')],
      ['Contact us', (p) => (p.title = 'Contact us')],
      ['menu label', (p) => ((p.title = 'Say hello'), (p.navLabel = 'Contact'))],
      ['address', (p) => ((p.title = 'Say hello'), (p.route = '/contact-us/'))],
      ['Japanese', (p) => (p.title = 'お問合せ')]
    ] as const) {
      const { state, second } = base();
      set(state.pages[second]);
      expect(create(state), title).not.toMatch(/Contact/);
    }
    // An old address that now leads to the page counts too.
    const { state, second } = base();
    state.pages[second].title = 'Say hello';
    state.site.redirects = [{ from: '/contact/', pageId: second }];
    expect(create(state)).not.toMatch(/Contact/);
    // A page that is not about contact leaves Contact to be offered, as an explicit create.
    const other = base();
    other.state.pages[other.second].title = 'Say hello';
    expect(create(other.state)).toMatch(/^Create a new Contact page/);
  });

  it('moves on through About, Services and FAQ, and stops when the site has them all', () => {
    const s = createStarterState('business', 'Studio', false);
    // The business starter has About and Contact.
    expect(create(s)).toMatch(/^Create a new Services page/);
    const more = applyOperations(s, [
      { type: 'page.create', title: 'What we do', starter: 'intro' },
      { type: 'page.create', title: 'Questions', starter: 'intro' }
    ]).state;
    expect(create(more)).toBeUndefined();
    // Every starter is still unique and the list never grows past four.
    const all = texts(starters(more, more.site.homePageId));
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeLessThanOrEqual(4);
  });

  it('promises a link from the header only when the menu is there and has room', () => {
    const { state } = lighthouse();
    const menu = headerMenu(state)!;
    expect(create(state)).toMatch(/link it from the header menu$/);
    menu.schema.max = (menu.node.props.links as unknown[]).length;
    expect(create(state)).toBe('Create a new About page with who is behind the site, what it stands for and a call to action');
    state.site.shell.header = { rootIds: [], nodes: {} };
    expect(create(state)).not.toMatch(/header/);
  });

  it('always gives a small site something to try', () => {
    const s = createStarterState('blank', 'Test', false);
    s.pages = {};
    s.site.pageOrder = [];
    expect(starters(s, null).map((x) => x.kind)).toEqual(['create-page', 'site']);
  });
});

describe('starters for a selection', () => {
  const onPage = (pageId: string, nodeId: string, extra: Partial<ElementRef> = {}): ElementRef => ({ owner: { kind: 'page', id: pageId }, instancePath: [], nodeId, ...extra });
  const picked = (state: ProjectState, selection: ElementRef | null, context = ALL) => starters(state, state.site.homePageId, { selection, context });

  it('shows the page starters when the message is not scoped to the selection, and none for a selection that is gone', () => {
    const { state, home } = lighthouse();
    const heading = Object.values(state.pages[home].nodes).find((n) => n.kind === 'text')!;
    const ref = onPage(home, heading.id);
    expect(picked(state, ref).every((s) => s.kind === 'selection')).toBe(true);
    expect(picked(state, ref, { page: true, selection: false }).map((s) => s.kind)).not.toContain('selection');
    expect(picked(state, onPage(home, 'n_removed'))).toEqual([]);
    expect(picked(state, { owner: { kind: 'page', id: 'pg_removed' }, instancePath: [], nodeId: heading.id })).toEqual([]);
  });

  it('writes for text that is empty and rewrites text that is not', () => {
    const { state, home } = lighthouse();
    const heading = Object.values(state.pages[home].nodes).find((n) => n.kind === 'text' && n.tag === 'h1')!;
    expect(texts(picked(state, onPage(home, heading.id)))[0]).toBe('Rewrite the Heading 1 to sound warmer and more confident');
    (heading as { text: string }).text = '  ';
    expect(texts(picked(state, onPage(home, heading.id)))[0]).toBe('Write the text for the Heading 1');
  });

  it('offers image work only that the image can take', () => {
    const { state, second } = lighthouse();
    const imageNode = (image: { assetId: string | null; alt: string; decorative?: boolean }): ElementRef => {
      state.pages[second].nodes.n_img = { id: 'n_img', kind: 'image', image };
      if (!state.pages[second].rootIds.includes('n_img')) state.pages[second].rootIds.push('n_img');
      return onPage(second, 'n_img');
    };
    const ask = (ref: ElementRef) => texts(starters(state, second, { selection: ref }));
    // No image in the field: choose one, or ask what would suit when the library has none.
    expect(ask(imageNode({ assetId: null, alt: '' }))).toEqual(['Suggest what kind of photo suits the Image']);
    state.assets.assets.a_one = asset('a_one', 'One');
    expect(ask(imageNode({ assetId: null, alt: '' }))).toEqual(['Choose an image for the Image from my images']);
    // The only image in the library is the one placed: there is no other to swap in.
    expect(ask(imageNode({ assetId: 'a_one', alt: 'One' }))).toEqual(['Write better alt text for the Image']);
    state.assets.assets.a_two = asset('a_two', 'Two');
    expect(ask(imageNode({ assetId: 'a_one', alt: 'One' }))).toEqual(['Write better alt text for the Image', 'Find a better image for the Image from my images']);
    // A decorative image has no alt text to improve.
    expect(ask(imageNode({ assetId: 'a_one', alt: '', decorative: true }))).toEqual(['Find a better image for the Image from my images']);
    // A font is no image.
    delete state.assets.assets.a_two;
    state.assets.assets.f_one = asset('f_one', 'Serif', { kind: 'font' });
    expect(ask(imageNode({ assetId: 'a_one', alt: '', decorative: true }))).toEqual(['Suggest a better layout for the Image']);
  });

  it('points a link at the page it leads to, or at a page it could lead to', () => {
    const { state, home, second } = lighthouse();
    const link = (target: LinkNode['link']): ElementRef => {
      state.pages[home].nodes.n_link = { id: 'n_link', kind: 'link', label: 'Write to us', link: target, appearance: 'primary' };
      if (!state.pages[home].rootIds.includes('n_link')) state.pages[home].rootIds.push('n_link');
      return onPage(home, 'n_link');
    };
    expect(texts(picked(state, link({ type: 'page', target: second })))[0]).toBe('Reword the Button so it clearly leads to the “お問い合わせ” page');
    expect(texts(picked(state, link({ type: 'none', target: '' })))[0]).toBe('Link the Button to the “お問い合わせ” page and word it to match');
    // A link to an address outside the site has no page to name.
    expect(texts(picked(state, link({ type: 'url', target: 'https://example.com' })))[0]).toBe('Rewrite the Button to sound warmer and more confident');
  });

  it('names where a shared or component element lives, and only suggests copy for a section that has some', () => {
    const { state, home } = lighthouse();
    const header = state.site.shell.header.rootIds[0];
    const inShell: ElementRef = { owner: { kind: 'shell', id: 'header' }, instancePath: [], nodeId: header };
    expect(texts(picked(state, inShell))[0]).toMatch(/ in the site header /);
    const section = Object.values(state.pages[home].nodes).find((n): n is InstanceNode => n.kind === 'instance')!;
    expect(texts(picked(state, onPage(home, section.id)))[0]).toBe('Make the Section more polished and easier to scan');
    // An empty section is filled before it is polished.
    section.slots = { content: [] };
    expect(texts(picked(state, onPage(home, section.id)))).toEqual(['Add a heading, some text and a button to the Section', 'Suggest a better layout for the Section']);
    const def = state.components[section.definitionId];
    const inComponent: ElementRef = { owner: { kind: 'component', id: def.id }, instancePath: [], nodeId: def.tree!.rootIds[0] };
    expect(texts(picked(state, inComponent))[0]).toMatch(/ wherever it is used$/);
  });
});
