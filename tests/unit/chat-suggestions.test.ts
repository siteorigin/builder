/**
 * New-chat starters come from the project (issue #54): the page being edited, the selection, the pages that exist
 * (renamed or not) and the images available. A starter never names a page, an image or an element that is not there.
 */
import { describe, expect, it } from 'vitest';
import type { AssetRecord, ElementRef, GraphNode, InstanceNode, LinkNode, PageDoc, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { installComponent, makeInstance } from '@engine/install';
import { headerMenu } from '@engine/tree';
import { assetUsages } from '@engine/apply';
import { chatSuggestions, countChatStarters, type ChatSuggestion, type SuggestionInput } from '../../src/renderer/src/lib/chatSuggestions';
import type { SeoFinding } from '@shared/seo';
import { runSeoAudit } from '@engine/seo-audit';
import { sectionDesign } from './fixtures/unlinked-buttons-designs';
import { managedFoundation } from './fixtures/agent-designs';
import { withManaged } from './fixtures/component-contract-designs';
import { useManaged } from './fixtures/engine-designs';

const ALL = { page: true, selection: true };

/** A Blank site as the starter made it before #15: Home holds one section with a title and a line of text. */
function blankWithWelcome(name: string): ProjectState {
  const s = createStarterState('blank', name, false);
  const home = s.site.homePageId;
  const placed = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: home }, componentId: 'layout.section' }]);
  const page = placed.state.pages[home];
  page.nodes.n_welcome = { id: 'n_welcome', kind: 'text', tag: 'h1', text: `Welcome to ${name}` };
  page.nodes.n_line = { id: 'n_line', kind: 'text', tag: 'p', text: 'Select this text to edit it, or add sections from the Insert panel.' };
  (page.nodes[placed.results[0].nodeId as string] as InstanceNode).slots = { content: ['n_welcome', 'n_line'] };
  return placed.state;
}

/** The report's site: a Blank site named 灯台 whose second page, お問い合わせ, was just added. */
function lighthouse() {
  const s = blankWithWelcome('灯台');
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
  chatSuggestions({ state, pageId, selection: null, context: ALL, ...over, assetUsage: over.assetUsage ?? assetUsages(state) });
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
    expect(list).toEqual([
      // The open page is "お問い合わせ", whose intro holds only its title.
      { kind: 'page', text: 'Build out the mostly empty “お問い合わせ” page with the copy I paste below' },
      // Home is another page, and says so.
      { kind: 'cross-page', text: 'On another page, “Home”: build out its content, it is mostly empty' },
      // お問い合わせ is the contact page, so Contact is not offered again; the next missing page is.
      { kind: 'create-page', text: 'Create a new About page with who is behind the site, what it stands for and a call to action, and link it from the header menu' }
    ]);
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
    expect(starters(state, second)[0].text).toBe('Improve the placement and alt text of the “Harbor light” image on the “お問い合わせ” page');
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
    expect(starters(state, second)[0].text).toMatch(/^Build out the mostly empty “お問い合わせ” page/);
    // A page with nothing on it is started.
    state.pages[second].rootIds = [];
    expect(starters(state, second)[0].text).toBe('Start the “お問い合わせ” page with the copy I paste below');
    // A page with real content is improved rather than built out, with its own copy counted from component properties.
    const rich = createStarterState('business', 'Studio', false);
    const home = rich.site.homePageId;
    expect(texts(starters(rich, home))).toContain('Make the opening of the “Home” page warmer and more confident');
    // Its hero has an empty image, which no library image fills.
    expect(starters(rich, home)[0].text).toBe('Suggest what kind of photo suits the empty image on the “Home” page');
    // A Home with a title and one line is still mostly empty; Blank's Home starts with nothing on it.
    const welcome = blankWithWelcome('Test');
    expect(starters(welcome, welcome.site.homePageId)[0].text).toMatch(/^Build out the mostly empty “Home” page/);
    const blank = createStarterState('blank', 'Test', false);
    expect(starters(blank, blank.site.homePageId)[0].text).toMatch(/^Start the “Home” page/);
    // A long piece of copy in one text node is content, however few nodes it is in.
    const long = lighthouse();
    const text: GraphNode = { id: 'n_long', kind: 'text', tag: 'p', text: 'Lighthouse keepers wrote their days down in logbooks. '.repeat(8) };
    long.state.pages[long.second].nodes.n_long = text;
    long.state.pages[long.second].rootIds.push('n_long');
    expect(starters(long.state, long.second)[0].text).toMatch(/^Make the opening of the “お問い合わせ” page/);
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
    expect(first).toMatch(/^Build out the mostly empty “The 'Big' 'Day' out and then a very long title that goes on…” page with /);
    state.pages[second].title = 'Home ';
    expect(texts(starters(state, second))[0]).toContain(`“Home” (${state.pages[second].route})`);
  });

  it('follows the page the message goes to: Home when the page is left out, and Home when the viewed page is gone', () => {
    const { state, home, second } = lighthouse();
    const off = starters(state, second, { context: { page: false, selection: true } });
    expect(texts(off)[0]).toMatch(/^Build out the mostly empty “Home” page/);
    // With the page left out, nothing says which page "another" is, so no other page is offered.
    expect(off.map((s) => s.kind)).not.toContain('cross-page');
    const gone = starters(state, 'pg_deleted');
    expect(texts(gone)[0]).toMatch(/^Build out the mostly empty “Home” page/);
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
    // The page's Japanese title gives it a Japanese contact address: give it a neutral one, so only the field each case sets names it.
    const base = () => {
      const made = lighthouse();
      made.state.pages[made.second].route = '/page/';
      return made;
    };
    type Rename = (p: PageDoc) => void;
    const renames: Array<[string, Rename]> = [
      ['Get in touch', (p) => (p.title = 'Get in touch')],
      ['Contact us', (p) => (p.title = 'Contact us')],
      ['menu label', (p) => ((p.title = 'Say hello'), (p.navLabel = 'Contact'))],
      ['address', (p) => ((p.title = 'Say hello'), (p.route = '/contact-us/'))],
      ['Japanese', (p) => (p.title = 'お問合せ')],
      ['a phrase', (p) => (p.title = 'Get in touch today')],
      ['a longer Japanese name', (p) => (p.title = 'お問い合わせ窓口')],
      ['a plural', (p) => ((p.title = 'Say hello'), (p.route = '/contacts-and-maps/'))],
      ['an encoded address', (p) => ((p.title = 'Say hello'), (p.route = '/%63ontact/'))]
    ];
    for (const [title, set] of renames) {
      const { state, second } = base();
      // The header's label for the page would name it too: leave it out, so only the renamed field is tested.
      (headerMenu(state)!.node.props.links as Array<{ label: string }>).forEach((l) => (l.label = 'Link'));
      set(state.pages[second]);
      expect(create(state), title).not.toMatch(/Contact/);
    }
    // An old address that now leads to the page counts too.
    const { state, second } = base();
    state.pages[second].title = 'Say hello';
    state.site.redirects = [{ from: '/contact/', pageId: second }];
    expect(create(state)).not.toMatch(/Contact/);
    // A stale redirect to a page that is gone says nothing about the pages that exist.
    const stale = base();
    stale.state.pages[stale.second].title = 'Say hello';
    stale.state.site.redirects = [{ from: '/contact/', pageId: 'pg_gone' }];
    (headerMenu(stale.state)!.node.props.links as Array<{ label: string }>).forEach((l) => (l.label = 'Say hello'));
    expect(create(stale.state)).toMatch(/^Create a new Contact page/);
    // A page renamed later is still known by the label the header gives its link.
    const labelled = base();
    labelled.state.pages[labelled.second].title = 'Say hello';
    expect(create(labelled.state)).not.toMatch(/Contact/);
    // A page that is not about contact leaves Contact to be offered, as an explicit create.
    const other = base();
    other.state.pages[other.second].title = 'Say hello';
    const menu = headerMenu(other.state)!;
    (menu.node.props.links as Array<{ label: string }>).forEach((l) => (l.label = 'Say hello'));
    expect(create(other.state)).toMatch(/^Create a new Contact page/);
  });

  it('does not take Home for the page a deleted page was replaced by', () => {
    const s = createStarterState('business', 'Studio', false);
    const contact = s.site.pageOrder.find((id) => s.pages[id].title === 'Contact')!;
    const removed = applyOperations(s, [{ type: 'page.remove', pageId: contact, replacementPageId: s.site.homePageId }]).state;
    // The header and footer still say Contact, now leading Home; the Contact page is gone and is offered again.
    expect(create(removed)).toMatch(/^Create a new Contact page/);
  });

  it('moves on through About, Services and FAQ, and stops when the site has them all', () => {
    const s = createStarterState('business', 'Studio', false);
    // The business starter has About and Contact.
    expect(create(s)).toMatch(/^Create a new Services page/);
    const services = applyOperations(s, [{ type: 'page.create', title: 'What we do', starter: 'intro' }]).state;
    expect(create(services)).toMatch(/^Create a new FAQ page with the questions people ask most/);
    const more = applyOperations(services, [{ type: 'page.create', title: 'FAQ', starter: 'intro' }]).state;
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

  it('shows the page starters when the message is not scoped to the selection or the selection is gone', () => {
    const { state, home } = lighthouse();
    const heading = Object.values(state.pages[home].nodes).find((n) => n.kind === 'text')!;
    const ref = onPage(home, heading.id);
    expect(picked(state, ref).every((s) => s.kind === 'selection')).toBe(true);
    expect(picked(state, ref).length).toBeGreaterThan(0);
    // Scoped to nothing, the starters are the page's own.
    expect(picked(state, ref, { page: true, selection: false })).toEqual(starters(state, home));
    // A selection that is gone (after an undo, say) leaves the page's starters rather than none.
    expect(picked(state, onPage(home, 'n_removed'))).toEqual(starters(state, home));
    expect(picked(state, { owner: { kind: 'page', id: 'pg_removed' }, instancePath: [], nodeId: heading.id })).toEqual(starters(state, home));
  });

  it('writes for text that is empty and rewrites text that is not', () => {
    const { state, home } = lighthouse();
    const heading = Object.values(state.pages[home].nodes).find((n) => n.kind === 'text' && n.tag === 'h1')!;
    expect(texts(picked(state, onPage(home, heading.id)))[0]).toBe('Make the Heading 1 warmer and more confident');
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
    expect(texts(picked(state, link({ type: 'url', target: 'https://example.com' })))[0]).toBe('Make the Button warmer and more confident');
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
    // An element of a design the project made, edited everywhere: Foundation's Section is code, with no element to pick.
    const def = sectionDesign(state);
    const inComponent: ElementRef = { owner: { kind: 'component', id: def.id }, instancePath: [], nodeId: def.tree!.rootIds[0] };
    expect(texts(picked(state, inComponent))[0]).toMatch(/ wherever it is used$/);
  });
});

describe('what the page holds, counted the way the page shows it', () => {
  const pageOf = () => lighthouse();

  it('counts copy written into a component itself, but not copy that shows only on a condition or once per list item', () => {
    const { state, second } = pageOf();
    state.pages[second].rootIds = [];
    state.pages[second].nodes = {};
    const copy = 'Lighthouse keepers wrote their days down in logbooks and left them for the next watch. '.repeat(3);
    // A section the project designed, whose own tree can hold copy.
    const def = sectionDesign(state);
    const inner = def.tree!.nodes.inner as { children: string[] };
    const place = () => {
      const inst = makeInstance(def, {});
      state.pages[second].nodes[inst.id] = inst;
      state.pages[second].rootIds = [inst.id];
    };
    // The component has no copy of its own, and none is placed in it: the page is mostly empty.
    place();
    expect(starters(state, second)[0].text).toMatch(/^Build out the mostly empty “お問い合わせ” page/);
    // Copy written into the component is on every page it is placed on.
    def.tree!.nodes.n_lit = { id: 'n_lit', kind: 'text', tag: 'p', text: copy };
    inner.children.push('n_lit');
    expect(starters(state, second)[0].text).toMatch(/^Make the opening of the “お問い合わせ” page/);
    // Copy that shows only when a condition holds, or once per item of a list, is not known to be on the page.
    def.tree!.nodes.n_lit = { id: 'n_lit', kind: 'text', tag: 'p', text: copy, when: { $prop: 'shown' } };
    expect(starters(state, second)[0].text).toMatch(/^Build out the mostly empty “お問い合わせ” page/);
    def.tree!.nodes.n_lit = { id: 'n_lit', kind: 'text', tag: 'p', text: copy };
    def.tree!.nodes.n_rep = { id: 'n_rep', kind: 'repeat', list: { $prop: 'items' }, children: ['n_lit'] };
    inner.children = inner.children.filter((c) => c !== 'n_lit').concat('n_rep');
    expect(starters(state, second)[0].text).toMatch(/^Build out the mostly empty “お問い合わせ” page/);
  });

  /** A page holding only the logo strip, with these props: on Foundation's managed design of it when `managed`. */
  const logoStrip = (state: ProjectState, pageId: string, props: Record<string, unknown>, managed: boolean) => {
    if (managed) useManaged(state, 'logos.strip');
    state.pages[pageId].rootIds = [];
    state.pages[pageId].nodes = {};
    const strip = makeInstance(state.components[installComponent(state, 'logos.strip')], props);
    expect(state.components[strip.definitionId].kind).toBe(managed ? 'managed' : 'code');
    state.pages[pageId].nodes[strip.id] = strip;
    state.pages[pageId].rootIds.push(strip.id);
    return strip;
  };
  /** The one starter about the page's own copy: the opening to make better, or a mostly empty page to build out. */
  const copyStarter = (state: ProjectState, pageId: string) => texts(starters(state, pageId)).find((t) => /^(Make the opening|Build out the)/.test(t));

  it('counts a list item as the list shows it: a field the item leaves out is the list default, and four short pieces are not a mostly empty page', () => {
    for (const managed of [true, false]) {
      const { state, second } = pageOf();
      const strip = logoStrip(state, second, { heading: 'Trusted by', logos: [{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }] }, managed);
      // Heading plus three names the list inherits: four pieces of copy, so the page is not mostly empty.
      expect(copyStarter(state, second), String(managed)).toMatch(/^Make the opening/);
      // On the managed design the logos it leaves out are optional, so nothing comes before it.
      if (managed) expect(starters(state, second)[0].text).toMatch(/^Make the opening/);
      delete state.pages[second].nodes[strip.id];
      state.pages[second].rootIds = [];
      const feature = makeInstance(state.components[installComponent(state, 'features.grid')], { eyebrow: '', heading: 'Ways', lead: '', items: [] });
      state.pages[second].nodes[feature.id] = feature;
      state.pages[second].rootIds.push(feature.id);
      expect(copyStarter(state, second), String(managed)).toMatch(/^Build out the/);
      if (managed) expect(starters(state, second)[0].text).toMatch(/^Build out the/);
    }
  });

  it('does not take an optional logo or portrait left empty for an image to fill, nor ask to describe a logo that is named by itself', () => {
    const { state, second } = pageOf();
    const logos = logoStrip(state, second, { heading: 'Trusted by', logos: [{ id: 'l1', name: 'Fernhill', logo: { assetId: null, alt: '' } }] }, true);
    expect(texts(starters(state, second)).join('\n')).not.toMatch(/empty image/);
    // A placed logo has no alt text of its own, and needs none: the component says the company's name.
    state.assets.assets.a_logo = asset('a_logo', 'Fernhill logo');
    (logos.props.logos as Array<{ logo: unknown }>)[0].logo = { assetId: 'a_logo', alt: '' };
    expect(texts(starters(state, second)).join('\n')).not.toMatch(/Write alt text/);
    // Another image without a description is still asked about.
    state.assets.assets.a_photo = asset('a_photo', 'Quayside');
    addHero(state, second, { assetId: 'a_photo', alt: '' });
    expect(starters(state, second)[0].text).toBe('Write alt text for the “Quayside” image on the “お問い合わせ” page');
  });

  // Release gap: chat starters read images from managed trees only (imageTraits), so the release's logo, shown only when set, is taken for one to fill.
  it.fails("does not take the release's optional logo left empty for an image to fill", () => {
    const { state, second } = pageOf();
    logoStrip(state, second, { heading: 'Trusted by', logos: [{ id: 'l1', name: 'Fernhill', logo: { assetId: null, alt: '' } }] }, false);
    expect(texts(starters(state, second)).join('\n')).not.toMatch(/empty image/);
  });

  // Release gap: chat starters read images from managed trees only (imageTraits), so the release's logo, named by its company, is asked to be described.
  it.fails("does not ask to describe the release's logo that is named by itself", () => {
    const { state, second } = pageOf();
    state.assets.assets.a_logo = asset('a_logo', 'Fernhill logo');
    logoStrip(state, second, { heading: 'Trusted by', logos: [{ id: 'l1', name: 'Fernhill', logo: { assetId: 'a_logo', alt: '' } }] }, false);
    expect(texts(starters(state, second)).join('\n')).not.toMatch(/Write alt text/);
  });

  it('survives a document with something unexpected in it, and offers none rather than failing', () => {
    const { state, second } = pageOf();
    state.pages[second].nodes.n_bad = { id: 'n_bad', kind: 'text', tag: 'p', text: [{ type: 'p', spans: [null] }] } as unknown as GraphNode;
    state.pages[second].rootIds.push('n_bad');
    expect(() => starters(state, second)).not.toThrow();
    expect(starters(state, second)[0].text).toMatch(/^Build out the mostly empty “お問い合わせ” page/);
    // Whatever else is wrong, the chat still opens.
    (state.site as { pageOrder: unknown }).pageOrder = null;
    expect(starters(state, second, { assetUsage: {} })).toEqual([]);
  });
});

describe('the image starter picks a real target', () => {
  it('picks the newest unused image for an empty image, an older one when the newest is in use, and the library when all are in use', () => {
    const { state, home, second } = lighthouse();
    state.assets.assets.a_znew = asset('a_znew', 'Newest', { createdAt: '2026-11-23T10:00:00.000Z' });
    state.assets.assets.a_aold = asset('a_aold', 'Older', { createdAt: '2026-11-21T10:00:00.000Z' });
    addHero(state, second, { assetId: null, alt: '' });
    expect(starters(state, second)[0].text).toBe('Place the “Newest” image in the empty image on the “お問い合わせ” page');
    // The newest is in use on Home: the older one is the unused image.
    addHero(state, home, { assetId: 'a_znew', alt: 'Used on Home' });
    expect(starters(state, second)[0].text).toBe('Place the “Older” image in the empty image on the “お問い合わせ” page');
    // Everything is in use: the AI is told to choose, and no used image is named.
    addHero(state, home, { assetId: 'a_aold', alt: 'Used on Home too' });
    expect(starters(state, second)[0].text).toBe('Choose an image from my images for the empty image on the “お問い合わせ” page');
  });

  it('breaks a tie between equally new images by ID, whatever order they were added in', () => {
    const { state, second } = lighthouse();
    state.assets.assets.a_zeta = asset('a_zeta', 'Zeta');
    state.assets.assets.a_alpha = asset('a_alpha', 'Alpha');
    expect(starters(state, second)[0].text).toContain('“Alpha”');
    const flipped = lighthouse();
    flipped.state.assets.assets.a_alpha = asset('a_alpha', 'Alpha');
    flipped.state.assets.assets.a_zeta = asset('a_zeta', 'Zeta');
    expect(starters(flipped.state, flipped.second)[0].text).toContain('“Alpha”');
  });

  it('describes a placed image before filling an empty one, and leaves a page with only a decorative image to its copy', () => {
    const { state, second } = lighthouse();
    state.assets.assets.a_photo = asset('a_photo', 'Quayside');
    addHero(state, second, { assetId: null, alt: '' });
    addHero(state, second, { assetId: 'a_photo', alt: '' });
    expect(starters(state, second)[0].text).toBe('Write alt text for the “Quayside” image on the “お問い合わせ” page');
    const deco = lighthouse();
    deco.state.assets.assets.a_photo = asset('a_photo', 'Quayside');
    addHero(deco.state, deco.second, { assetId: 'a_photo', alt: '', decorative: true });
    expect(starters(deco.state, deco.second).map((s) => s.kind)).toEqual(['page', 'cross-page', 'create-page']);
    // The hero's copy fills the page, and its decorative image needs no description: the copy is what is left to work on.
    expect(starters(deco.state, deco.second)[0].text).toBe('Make the opening of the “お問い合わせ” page warmer and more confident');
  });
});

describe('other pages and missing pages, more closely', () => {
  it('offers a rich page its own rewrite, picks the first page that is not Home, and falls back to Home only when it is the one other page', () => {
    const { state, home, second } = lighthouse();
    const copy = 'Lighthouse keepers wrote their days down in logbooks and left them for the next watch. ';
    const third = applyOperations(state, [{ type: 'page.create', title: 'Keepers', starter: 'intro' }]).state;
    const thirdId = third.site.pageOrder[2];
    third.pages[thirdId].nodes.n_long = { id: 'n_long', kind: 'text', tag: 'p', text: copy.repeat(4) };
    third.pages[thirdId].rootIds.push('n_long');
    // Home is first in the order, but is not what is offered while a different page can be.
    expect(texts(starters(third, second))).toContain('On another page, “Keepers”: make the opening shorter and easier to scan');
    expect(texts(starters(third, home))).toContain('On another page, “お問い合わせ”: build out its content, it is mostly empty');
    // With only Home besides the open page, Home is offered.
    expect(starters(state, second)[1].text).toMatch(/^On another page, “Home”/);
  });

  it('keeps a one-page site to its own starters plus one that needs no page, and names the pages it could not tell apart', () => {
    const s = createStarterState('blank', 'Test', false);
    expect(starters(s, s.site.homePageId).map((x) => x.kind)).toEqual(['page', 'create-page', 'site']);
    expect(starters(s, s.site.homePageId)[1].text).toMatch(/^Create a new Contact page/);
    expect(starters(s, s.site.homePageId)[2].text).toBe('Make the brand color a deep navy blue across the whole site');
  });

  it('does not let an unrelated title or a page below another stand for the page it is missing', () => {
    const { state } = lighthouse();
    // Contact exists; "Sobre el envío" (about shipping) and "製品概要" (product overview) are not an About page.
    for (const title of ['Sobre el envío', '製品概要']) {
      const r = applyOperations(state, [{ type: 'page.create', title }]);
      expect(texts(starters(r.state, r.state.site.homePageId)).join('\n')).toContain('Create a new About page');
    }
    // The last part of the address is the page's own name: /info/about/ is About, /about/team/ is Team.
    const about = applyOperations(state, [{ type: 'page.create', title: 'Say hello', route: '/info/about/' }]).state;
    expect(texts(starters(about, about.site.homePageId)).join('\n')).not.toContain('Create a new About');
    const team = applyOperations(state, [{ type: 'page.create', title: 'Say hello', route: '/about/team/' }]).state;
    expect(texts(starters(team, team.site.homePageId)).join('\n')).toContain('Create a new About');
    const biz = createStarterState('business', 'Studio', false);
    const repairs = applyOperations(biz, [{ type: 'page.create', title: 'Repairs', route: '/services/repairs/' }]).state;
    expect(texts(starters(repairs, repairs.site.homePageId)).join('\n')).toContain('Create a new Services page');
  });

  it('names pages by address when two share a title, however it is cased or spaced, and clips at the length it says', () => {
    const { state, second } = lighthouse();
    state.pages[second].title = '  HOME  ';
    expect(starters(state, second)[0].text).toContain(`“HOME” (${state.pages[second].route})`);
    state.pages[second].title = 'Quayside  Keepers';
    expect(starters(state, second)[0].text).toContain('“Quayside Keepers” page');
    const sixty = 'a'.repeat(59) + ' b';
    state.pages[second].title = sixty + 'c';
    expect(starters(state, second)[0].text).toContain(`“${'a'.repeat(59)}…”`);
  });

  it('promises a menu link by the room the menu really has: none stored uses the list default, and no maximum means room', () => {
    const { state } = lighthouse();
    const menu = headerMenu(state)!;
    const created = (st: ProjectState) => texts(starters(st, st.site.homePageId)).find((t) => t.startsWith('Create a new '))!;
    delete menu.node.props.links;
    (menu.schema as { default: unknown[] }).default = [{ id: 'a' }, { id: 'b' }];
    menu.schema.max = 2;
    expect(created(state)).not.toMatch(/header menu/);
    menu.schema.max = undefined;
    expect(created(state)).toMatch(/header menu$/);
  });
});

describe('selection starters follow the component the element belongs to', () => {
  /** A selected part of a placed component, as the canvas makes it. */
  function part(state: ProjectState, pageId: string, componentId: string, props: Record<string, unknown>, partId: string, extra: Partial<ElementRef> = {}) {
    const def = state.components[installComponent(state, componentId)];
    const inst = makeInstance(def, props);
    state.pages[pageId].nodes[inst.id] = inst;
    state.pages[pageId].rootIds.push(inst.id);
    const ref: ElementRef = { owner: { kind: 'page', id: pageId }, instancePath: [inst.id], nodeId: def.parts[partId].nodeId, partId, ...extra };
    return { ref, inst, def };
  }
  const ask = (state: ProjectState, pageId: string, ref: ElementRef) => texts(starters(state, pageId, { selection: ref }));

  it('reads a bound text from the placement, else the component default, and a repeated item from its own field', () => {
    const { state, second } = lighthouse();
    // Foundation's managed designs of the hero and the feature grid, whose parts are elements to select.
    managedFoundation(state, ['hero.split', 'features.grid']);
    const hero = part(state, second, 'hero.split', { heading: 'Hello' }, 'heading');
    expect(hero.def.kind).toBe('managed');
    expect(ask(state, second, hero.ref)[0]).toBe('Make the Heading warmer and more confident');
    hero.inst.props.heading = '';
    expect(ask(state, second, hero.ref)).toEqual(['Write the text for the Heading', 'Suggest three ways to write the Heading']);
    delete hero.inst.props.heading;
    // Unset, the page shows the component's own sample heading.
    expect(ask(state, second, hero.ref)[0]).toBe('Make the Heading warmer and more confident');
    // A repeated card: its own title decides, not the list's first item.
    const blank = { link: { type: 'none', target: '' }, linkLabel: '', description: '', icon: 'compass' };
    const grid = part(state, second, 'features.grid', { items: [{ ...blank, title: 'Planning' }, { ...blank, title: '' }] }, 'cardTitle');
    expect(grid.def.kind).toBe('managed');
    const [a, b] = (grid.inst.props.items as Array<{ id: string }>).map((i) => i.id);
    expect(ask(state, second, { ...grid.ref, itemPath: [b] })[0]).toBe('Write the text for the Card title');
    expect(ask(state, second, { ...grid.ref, itemPath: [a] })[0]).toBe('Make the Card title warmer and more confident');
    // An item that is not in the list leaves the value unknown, which is not taken for empty.
    expect(ask(state, second, { ...grid.ref, itemPath: ['i_gone'] })[0]).toBe('Make the Card title warmer and more confident');
  });

  // Release gap: chat starters read parts from managed trees only (resolveRef), so a part of a release code component offers the page's starters instead.
  it.fails("reads a bound text of the release hero's heading", () => {
    const { state, second } = lighthouse();
    const hero = part(state, second, 'hero.split', { heading: 'Hello' }, 'heading');
    expect(ask(state, second, hero.ref)[0]).toBe('Make the Heading warmer and more confident');
  });

  it('reads a repeated image from its own item: decorative or empty, with and without other images to offer', () => {
    const { state, second } = lighthouse();
    // Foundation's managed design of the gallery, whose image is an element to select.
    withManaged(state, 'media.gallery');
    state.assets.assets.a_one = asset('a_one', 'One');
    const gallery = part(state, second, 'media.gallery', { images: [{ image: { assetId: 'a_one', alt: '', decorative: true }, caption: '' }, { image: { assetId: null, alt: '' }, caption: '' }] }, 'image');
    expect(gallery.def.kind).toBe('managed');
    const [g1, g2] = (gallery.inst.props.images as Array<{ id: string }>).map((i) => i.id);
    // The only image in the library is the placed one, and it is decorative: nothing to describe, nothing to swap in.
    expect(ask(state, second, { ...gallery.ref, itemPath: [g1] })).toEqual(['Suggest a better layout for the Image']);
    expect(ask(state, second, { ...gallery.ref, itemPath: [g2] })).toEqual(['Choose an image for the Image from my images']);
    // An item that is not in the list is not known to be anything: both are offered.
    expect(ask(state, second, { ...gallery.ref, itemPath: ['i_gone'] })).toEqual(['Write better alt text for the Image', 'Find a better image for the Image from my images']);
  });

  // Release gap: chat starters read parts from managed trees only (resolveRef), so a part of a release code component offers the page's starters instead.
  it.fails("reads a repeated image of the release gallery from its own item", () => {
    const { state, second } = lighthouse();
    state.assets.assets.a_one = asset('a_one', 'One');
    const gallery = part(state, second, 'media.gallery', { images: [{ image: { assetId: 'a_one', alt: '', decorative: true }, caption: '' }] }, 'image');
    const [g1] = (gallery.inst.props.images as Array<{ id: string }>).map((i) => i.id);
    expect(ask(state, second, { ...gallery.ref, itemPath: [g1] })).toEqual(['Suggest a better layout for the Image']);
  });

  it('points a link at the page it really leads to, and not at a deleted page or an address outside the site', () => {
    const { state, home, second } = lighthouse();
    const third = applyOperations(state, [{ type: 'page.create', title: 'Keepers', starter: 'intro' }]);
    const keepers = third.results[0].pageId as string;
    const link = (target: LinkNode['link']): ElementRef => {
      third.state.pages[home].nodes.n_link = { id: 'n_link', kind: 'link', label: 'Go', link: target, appearance: 'primary' };
      if (!third.state.pages[home].rootIds.includes('n_link')) third.state.pages[home].rootIds.push('n_link');
      return { owner: { kind: 'page', id: home }, instancePath: [], nodeId: 'n_link' };
    };
    const asks = (target: LinkNode['link']) => texts(starters(third.state, home, { selection: link(target) }));
    expect(asks({ type: 'page', target: keepers })[0]).toBe('Reword the Button so it clearly leads to the “Keepers” page');
    expect(asks({ type: 'page', target: 'pg_deleted' })).toEqual(['Make the Button warmer and more confident', 'Make the Button shorter and easier to scan']);
    expect(asks({ type: 'url', target: 'https://example.com' })).toEqual(['Make the Button warmer and more confident', 'Make the Button shorter and easier to scan']);
    // An unlinked button is offered the first other page; with no other page there is nothing to link it to.
    expect(asks({ type: 'none', target: '' })[0]).toBe('Link the Button to the “お問い合わせ” page and word it to match');
    const only = createStarterState('blank', 'Test', false);
    only.pages[only.site.homePageId].nodes.n_link = { id: 'n_link', kind: 'link', label: 'Go', link: { type: 'none', target: '' }, appearance: 'primary' };
    only.pages[only.site.homePageId].rootIds.push('n_link');
    expect(texts(starters(only, only.site.homePageId, { selection: { owner: { kind: 'page', id: only.site.homePageId }, instancePath: [], nodeId: 'n_link' } }))).toEqual(['Make the Button warmer and more confident', 'Make the Button shorter and easier to scan']);
    void second;
  });

  it('treats an image whose asset is gone, or is a font, as empty, and offers nothing about copy for an icon, an image-only section, or a full text', () => {
    const { state, second } = lighthouse();
    state.assets.assets.f_one = asset('f_one', 'Serif', { kind: 'font' });
    state.pages[second].nodes.n_img = { id: 'n_img', kind: 'image', image: { assetId: 'a_deleted', alt: 'x' } };
    state.pages[second].nodes.n_font = { id: 'n_font', kind: 'image', image: { assetId: 'f_one', alt: 'x' } };
    state.pages[second].nodes.n_icon = { id: 'n_icon', kind: 'icon', icon: 'star' };
    state.pages[second].nodes.n_div = { id: 'n_div', kind: 'divider' };
    state.pages[second].nodes.n_box = { id: 'n_box', kind: 'element', tag: 'section', children: ['n_img'] };
    state.pages[second].rootIds.push('n_img', 'n_font', 'n_icon', 'n_div', 'n_box');
    const on = (nodeId: string): ElementRef => ({ owner: { kind: 'page', id: second }, instancePath: [], nodeId });
    expect(ask(state, second, on('n_img'))).toEqual(['Suggest what kind of photo suits the Image']);
    expect(ask(state, second, on('n_font'))).toEqual(['Suggest what kind of photo suits the Image']);
    expect(ask(state, second, on('n_icon'))).toEqual(['Choose a better icon for the Icon']);
    expect(ask(state, second, on('n_div'))).toEqual(['Suggest a better layout for the Divider']);
    expect(ask(state, second, on('n_box'))).toEqual(['Add a heading, some text and a button to the Section', 'Suggest a better layout for the Section']);
    state.pages[second].nodes.n_text = { id: 'n_text', kind: 'text', tag: 'p', text: 'Words' };
    state.pages[second].rootIds.push('n_text');
    expect(ask(state, second, on('n_text'))).toEqual(['Make the Text warmer and more confident', 'Make the Text shorter and easier to scan', 'Suggest three other ways to write the Text']);
  });
});

describe('a starter about search and AI readiness, from the SEO audit (#599)', () => {
  const biz = () => createStarterState('business', 'Studio', false);
  const idOf = (state: ProjectState, title: string) => state.site.pageOrder.find((id) => state.pages[id].title === title)!;
  const meta = (code: string, pageId: string, field: 'title' | 'description' | 'noindex'): SeoFinding => ({ code, severity: 'warning', message: code, pillar: 'content', explanation: '', aiFixable: true, owner: { kind: 'page', id: pageId }, destination: { kind: 'pageSeo', pageId, field } });
  const siteFinding = (code: string, aiFixable = true): SeoFinding => ({ code, severity: 'info', message: code, pillar: 'agentic', explanation: '', aiFixable });

  it('comes second, beside the page’s own first starter, when the audit finds something the AI can fix on a page with copy', () => {
    const state = biz();
    const home = state.site.homePageId;
    const without = starters(state, home);
    const audited = runSeoAudit(state);
    // The Studio starter's Home is titled by the site's name alone, which is short for a search result.
    expect(audited).toContainEqual(expect.objectContaining({ code: 'SEO_TITLE_LENGTH', owner: { kind: 'page', id: home }, aiFixable: true }));
    const list = starters(state, home, { seoFindings: audited });
    expect(list).toEqual([without[0], { kind: 'page', text: 'Improve the search title of the “Home” page for search results and AI answers' }, ...without.slice(1)]);
    // Nothing to fix leaves the starters as they were.
    expect(starters(state, home, { seoFindings: [] })).toEqual(without);
  });

  it('writes the open page’s missing search title and meta description, as a change to that page', () => {
    const state = biz();
    const about = idOf(state, 'About');
    const at = (findings: SeoFinding[]) => starters(state, about, { seoFindings: findings })[1];
    expect(at([meta('SEO_DESCRIPTION_MISSING', about, 'description')])).toEqual({ kind: 'page', text: 'Write the missing meta description for the “About” page' });
    expect(at([meta('SEO_TITLE_MISSING', about, 'title'), meta('SEO_DESCRIPTION_MISSING', about, 'description')])).toEqual({ kind: 'page', text: 'Write the missing search title and meta description for the “About” page' });
    expect(at([meta('SEO_DESCRIPTION_MISSING', about, 'description'), meta('SEO_TITLE_DUPLICATE', about, 'title')])).toEqual({ kind: 'page', text: 'Improve the search title and meta description of the “About” page for search results and AI answers' });
    // Home asked not to be listed comes first.
    const home = state.site.homePageId;
    expect(starters(state, home, { seoFindings: [meta('SEO_DESCRIPTION_MISSING', home, 'description'), meta('SEO_HOME_NOINDEX', home, 'noindex')] })[1]).toEqual({ kind: 'page', text: 'Let search engines list the “Home” page again' });
    // Seen from another page, Home's listing is the whole site's to fix, not the open page's.
    expect(starters(state, about, { seoFindings: [meta('SEO_HOME_NOINDEX', home, 'noindex')] })[1]).toEqual({ kind: 'site', text: 'Audit the site’s SEO and AI readiness and fix what you can' });
  });

  it('asks for other pages’ search titles and meta descriptions as a change to the whole site', () => {
    const state = biz();
    const about = idOf(state, 'About');
    const contact = idOf(state, 'Contact');
    expect(starters(state, about, { seoFindings: [meta('SEO_DESCRIPTION_MISSING', contact, 'description')] })[1]).toEqual({ kind: 'site', text: 'Write the missing meta descriptions for the site’s pages' });
    expect(starters(state, about, { seoFindings: [meta('SEO_DESCRIPTION_MISSING', contact, 'description'), meta('SEO_TITLE_LENGTH', state.site.homePageId, 'title')] })[1]).toEqual({ kind: 'site', text: 'Improve the search titles and meta descriptions the audit flags on the site’s pages' });
    // A finding the AI can't fix, or about a page that has gone, asks for nothing.
    expect(starters(state, about, { seoFindings: [{ ...meta('SEO_DESCRIPTION_MISSING', contact, 'description'), aiFixable: false }] })).toEqual(starters(state, about));
    expect(starters(state, about, { seoFindings: [meta('SEO_DESCRIPTION_MISSING', 'pg_gone', 'description')] })).toEqual(starters(state, about));
  });

  it('sets up structured data and llms.txt for AI agents, asking for what only the author knows', () => {
    const state = biz();
    const home = state.site.homePageId;
    const at = (findings: SeoFinding[]) => starters(state, home, { seoFindings: findings })[1];
    expect(at([siteFinding('SEO_ENTITY_IDENTITY_MISSING', false), siteFinding('SEO_LLMS_TXT_OFF')])).toEqual({ kind: 'site', text: 'Set up the site’s structured data and llms.txt for search engines and AI agents, and ask me for any details you need' });
    expect(at([siteFinding('SEO_ENTITY_SAME_AS_MISSING', false)])).toEqual({ kind: 'site', text: 'Set up the site’s structured data for search engines and AI agents, and ask me for any details you need' });
    expect(at([siteFinding('SEO_LLMS_TXT_OFF')])).toEqual({ kind: 'site', text: 'Turn on llms.txt so AI agents get an index of the site’s pages' });
    // Anything else the AI can fix is for an audit to find.
    expect(at([siteFinding('SEO_SEARCH_CRAWLERS_BLOCKED')])).toEqual({ kind: 'site', text: 'Audit the site’s SEO and AI readiness and fix what you can' });
  });

  it('waits for copy: an empty or mostly empty page has nothing to describe, and a site without copy nothing to set up', () => {
    const { state, home, second } = lighthouse();
    const audited = runSeoAudit(state);
    // The Blank site's Home has no description, and no publisher is named; neither is offered while nothing is written.
    expect(audited.map((f) => f.code)).toEqual(expect.arrayContaining(['SEO_DESCRIPTION_MISSING', 'SEO_ENTITY_IDENTITY_MISSING']));
    for (const pageId of [home, second]) expect(starters(state, pageId, { seoFindings: audited })).toEqual(starters(state, pageId));
    expect(starters(state, second, { seoFindings: [siteFinding('SEO_LLMS_TXT_OFF'), meta('SEO_TITLE_MISSING', home, 'title')] })).toEqual(starters(state, second));
    // A new Blank site, its Home with nothing on it, as the chat first shows it.
    const blank = createStarterState('blank', 'Kloof', false);
    expect(blank.pages[blank.site.homePageId].rootIds).toEqual([]);
    expect(starters(blank, blank.site.homePageId, { seoFindings: runSeoAudit(blank) })).toEqual(starters(blank, blank.site.homePageId));
    // Home kept out of search engines needs no copy to fix.
    expect(starters(state, home, { seoFindings: [meta('SEO_HOME_NOINDEX', home, 'noindex')] })[1]).toEqual({ kind: 'page', text: 'Let search engines list the “Home” page again' });
  });

  it('steps aside for a scoped selection’s own starters', () => {
    const state = biz();
    const home = state.site.homePageId;
    const ref: ElementRef = { owner: { kind: 'page', id: home }, instancePath: [], nodeId: state.pages[home].rootIds[0] };
    const findings = [meta('SEO_DESCRIPTION_MISSING', home, 'description')];
    const picked = starters(state, home, { selection: ref, seoFindings: findings });
    expect(picked.length).toBeGreaterThan(0);
    expect(picked).toEqual(starters(state, home, { selection: ref }));
    expect(picked.every((s) => s.kind === 'selection')).toBe(true);
  });
});

describe('the timing marks', () => {
  it('are told of every time the starters are worked out', () => {
    const { state, home } = lighthouse();
    let worked = 0;
    countChatStarters(() => worked++);
    try {
      starters(state, home);
      starters(state, home);
      expect(worked).toBe(2);
    } finally {
      countChatStarters(null);
    }
  });
});
