/**
 * Project health's accessibility advice (#1634): the theme's colour pairs in the light and dark palettes, HTML ids a
 * page renders twice, headings with no words, links, buttons and cards with no accessible name, and videos with no
 * title or no address their player can play. All of it is advice: none of it stops a save.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentDefinition, ElementNode, GraphNode, InstanceNode, LinkNode, PageDoc, ProjectState, RepeatNode, TextNode } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { makeInstance } from '@engine/install';
import { adviceValidation, coreValidation, diagnosticKey, joinValidation, validateState, type Diagnostic } from '@engine/validate';
import { ValidationCache } from '@engine/validation-cache';
import { destinationForDiagnostic, destinationLabel } from '../../src/renderer/src/lib/destinations';

const fresh = () => createStarterState('business', 'Harbour', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const CODES = new Set(['COLOR_CONTRAST_LOW', 'HTML_ID_DUPLICATE', 'EMPTY_HEADING', 'LINK_NAME_MISSING', 'BUTTON_NAME_MISSING', 'VIDEO_TITLE_MISSING', 'VIDEO_URL_UNSUPPORTED']);
const advice = (s: ProjectState, code?: string) => validateState(s).filter((d) => (code ? d.code === code : CODES.has(d.code)));

/** Adds `nodes` to the end of the Home page, the first of them as a top-level element. */
function addToHome(s: ProjectState, ...nodes: GraphNode[]): PageDoc {
  const page = home(s);
  for (const n of nodes) page.nodes[n.id] = n;
  page.rootIds.push(nodes[0].id);
  return page;
}

const text = (id: string, tag: TextNode['tag'], words: string, extra: Partial<TextNode> = {}): TextNode => ({ id, kind: 'text', tag, text: words, ...extra });
const link = (id: string, extra: Partial<LinkNode> = {}): LinkNode => ({ id, kind: 'link', link: { type: 'url', target: 'https://example.com/' }, label: '', appearance: 'link', ...extra });
const box = (id: string, children: string[], extra: Partial<ElementNode> = {}): ElementNode => ({ id, kind: 'element', tag: 'div', children, ...extra });

describe('the site palette', () => {
  it('reports a theme pair below WCAG 2.2 AA in the site colors, leading to Colors at the text color', () => {
    const s = fresh();
    expect(advice(s, 'COLOR_CONTRAST_LOW')).toEqual([]);
    s.tokens.overrides['color.brand'] = '#ffffff';
    const found = advice(s, 'COLOR_CONTRAST_LOW');
    const button = found.find((d) => d.site === 'contrast:light:button')!;
    expect(button).toMatchObject({ severity: 'warning', message: expect.stringMatching(/^Site colors: Button text has a contrast of 1\.00:1, below the 4\.5:1/) });
    expect(button.owner).toBeUndefined();
    expect(destinationForDiagnostic(s, button)).toEqual({ kind: 'colors', scheme: 'light', token: 'color.on-brand' });
    expect(destinationLabel({ kind: 'colors', scheme: 'light' })).toBe('Go to Colors');
  });

  it('names the light and dark palettes once visitors can see a dark one, and drops the dark one when it is turned off', () => {
    const s = fresh();
    s.tokens.colorSchemeMode = 'system';
    s.tokens.darkOverrides = { 'color.brand': '#ffffff', 'color.on-brand': '#ffffff' } as never;
    const dark = advice(s, 'COLOR_CONTRAST_LOW').filter((d) => d.site?.startsWith('contrast:dark:'));
    expect(dark.length).toBeGreaterThan(0);
    expect(dark[0].message).toMatch(/^Dark palette: /);
    expect(destinationForDiagnostic(s, dark[0])).toMatchObject({ kind: 'colors', scheme: 'dark' });
    expect(advice(s, 'COLOR_CONTRAST_LOW').some((d) => d.site?.startsWith('contrast:light:'))).toBe(false);
    // The dark colours stay stored, but no visitor sees them.
    s.tokens.colorSchemeMode = 'single';
    expect(advice(s, 'COLOR_CONTRAST_LOW')).toEqual([]);
  });

  it('says nothing of a pair whose colors cannot be known here', () => {
    const s = fresh();
    s.tokens.overrides['color.brand'] = 'var(--somewhere-else)';
    expect(advice(s, 'COLOR_CONTRAST_LOW').filter((d) => d.site === 'contrast:light:button')).toEqual([]);
  });
});

describe('HTML ids rendered twice on a page', () => {
  it('reports two elements with the same id, at the second', () => {
    const s = fresh();
    const page = addToHome(s, box('a1', [], { anchor: 'team' }));
    page.nodes.a2 = box('a2', [], { anchor: 'team' });
    page.rootIds.push('a2');
    const [d] = advice(s, 'HTML_ID_DUPLICATE');
    expect(d).toMatchObject({ severity: 'warning', owner: { kind: 'page', id: page.id }, nodeId: 'a2', site: 'id:team' });
    expect(d.message).toMatch(/2 elements on the page have the ID “team”/);
    page.nodes.a2 = box('a2', [], { anchor: 'team-2' });
    expect(advice(s, 'HTML_ID_DUPLICATE')).toEqual([]);
  });

  it('counts the shared header the page shows, and not one it hides', () => {
    const s = fresh();
    const header = s.site.shell.header;
    header.nodes.h1 = box('h1', [], { anchor: 'top-bar' });
    header.rootIds.push('h1');
    const page = addToHome(s, box('a1', [], { anchor: 'top-bar' }));
    const [d] = advice(s, 'HTML_ID_DUPLICATE');
    expect(d).toMatchObject({ owner: { kind: 'page', id: page.id }, nodeId: 'a1' });
    expect(d.message).toMatch(/2 elements on the page and in the shared header have the ID “top-bar”/);
    page.showHeader = false;
    expect(advice(s, 'HTML_ID_DUPLICATE')).toEqual([]);
  });

  it('says a clash inside the shared header once, however many pages show it', () => {
    const s = fresh();
    const header = s.site.shell.header;
    header.nodes.h1 = box('h1', [], { anchor: 'dup' });
    header.nodes.h2 = box('h2', [], { anchor: 'dup' });
    header.rootIds.push('h1', 'h2');
    expect(s.site.pageOrder.length).toBeGreaterThan(1);
    const found = advice(s, 'HTML_ID_DUPLICATE');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ owner: { kind: 'shell', id: 'header' }, nodeId: 'h2', message: expect.stringMatching(/^Header: 2 elements in the shared header/) });
  });

  it('counts an id inside a collection loop once per entry it shows', () => {
    const s = applyOperations(fresh(), [
      { type: 'collection.create', collectionId: 'team', kind: 'structured', singularName: 'Team member', hasBody: false, pages: { detail: false, archive: false }, fields: { role: { type: 'string', label: 'Role' } } },
      { type: 'entry.create', collectionId: 'team', entryId: 'en_ruiz', title: 'Ana Ruiz', draft: false, values: { role: 'Architect' } }
    ]).state;
    const loop: RepeatNode = { id: 'loop', kind: 'repeat', list: { $query: { collectionId: 'team' } }, children: ['row'] };
    addToHome(s, box('wrap', ['loop']), loop, box('row', [], { anchor: 'member' }));
    // One entry renders the id once.
    expect(advice(s, 'HTML_ID_DUPLICATE')).toEqual([]);
    const two = applyOperations(s, [{ type: 'entry.create', collectionId: 'team', entryId: 'en_okafor', title: 'Ben Okafor', draft: false, values: { role: 'Engineer' } }]).state;
    expect(advice(two, 'HTML_ID_DUPLICATE')).toEqual([expect.objectContaining({ nodeId: 'row', site: 'id:member' })]);
  });

  it('counts slot content a design shows twice through two slots of one name', () => {
    const s = fresh();
    const def: ComponentDefinition = {
      schemaVersion: 1,
      id: 'p_twice',
      componentId: 'p_twice',
      contractVersion: 1,
      kind: 'managed',
      owner: 'project',
      name: 'Twice',
      description: '',
      category: 'content',
      tags: [],
      properties: {},
      parts: {},
      slots: { content: { label: 'Content' } },
      tree: { rootIds: ['root'], nodes: { root: box('root', ['a', 'b']), a: { id: 'a', kind: 'slot', slot: 'content' }, b: { id: 'b', kind: 'slot', slot: 'content' } } }
    } as ComponentDefinition;
    s.components[def.id] = def;
    const inst: InstanceNode = { ...makeInstance(def, {}), slots: { content: ['inner'] } };
    addToHome(s, inst, box('inner', [], { anchor: 'shown-twice' }));
    expect(advice(s, 'HTML_ID_DUPLICATE')).toEqual([expect.objectContaining({ site: 'id:shown-twice' })]);
  });

  it('counts an id code writes out literally in its markup, but not one in its script', () => {
    const s = fresh();
    const header = s.site.shell.header;
    const placed = Object.values(header.nodes).find((n): n is InstanceNode => n.kind === 'instance' && s.components[n.definitionId]?.kind === 'code' && /id="so-site-nav"/.test(s.components[n.definitionId].source ?? ''));
    expect(placed).toBeDefined();
    // The page carries an id the header's menu already has.
    addToHome(s, box('a1', [], { anchor: 'so-site-nav' }));
    expect(advice(s, 'HTML_ID_DUPLICATE').map((d) => d.site)).toEqual(['id:so-site-nav']);
    const def = s.components[placed!.definitionId];
    s.components[def.id] = { ...def, source: `<script>\n\tlet id = 'scripted';\n</script>\n<div id="written"></div><p id="written"></p>` };
    expect(advice(s, 'HTML_ID_DUPLICATE').map((d) => d.site)).toEqual(['id:written']);
  });
});

describe('headings with no words', () => {
  it('reports an empty heading on a page, leading to the element itself', () => {
    const s = fresh();
    const page = addToHome(s, text('t1', 'h2', ''));
    const [d] = advice(s, 'EMPTY_HEADING');
    expect(d).toMatchObject({ severity: 'warning', owner: { kind: 'page', id: page.id }, nodeId: 't1', message: `${page.title}: a Heading 2 has no words, so screen readers announce an empty heading. Give it its words, or remove it.` });
    // Not a heading outline finding: its row selects the element rather than opening the outline.
    expect(d.code.startsWith('HEADING_')).toBe(false);
    (page.nodes.t1 as TextNode).text = 'Our team';
    expect(advice(s, 'EMPTY_HEADING')).toEqual([]);
  });

  it('reports one the shared header shows once, and leaves plain empty text alone', () => {
    const s = fresh();
    const header = s.site.shell.header;
    header.nodes.t1 = text('t1', 'h3', '   ');
    header.rootIds.push('t1');
    addToHome(s, text('p1', 'p', ''));
    expect(advice(s, 'EMPTY_HEADING')).toEqual([expect.objectContaining({ owner: { kind: 'shell', id: 'header' }, nodeId: 't1', message: expect.stringMatching(/^Header: a Heading 3 has no words/) })]);
  });
});

describe('links, buttons and cards with no accessible name', () => {
  it('reports an icon-only link with no accessible name, and not once it has one', () => {
    const s = fresh();
    const page = addToHome(s, link('l1', { icon: 'instagram' }));
    const [d] = advice(s, 'LINK_NAME_MISSING');
    expect(d).toMatchObject({ severity: 'warning', owner: { kind: 'page', id: page.id }, nodeId: 'l1', message: expect.stringMatching(/is a link with no words and no accessible name/) });
    (page.nodes.l1 as LinkNode).ariaLabel = 'Harbour on Instagram';
    expect(advice(s, 'LINK_NAME_MISSING')).toEqual([]);
  });

  it('leaves a link with words, and one that goes nowhere, alone', () => {
    const s = fresh();
    addToHome(s, link('l1', { label: 'Read more' }));
    const page = home(s);
    page.nodes.l2 = link('l2', { link: { type: 'none', target: '' } });
    page.rootIds.push('l2');
    expect(advice(s, 'LINK_NAME_MISSING')).toEqual([]);
  });

  it('reports a card link with nothing inside that names it, and not one with words or a described picture', () => {
    const s = fresh();
    const card = box('c1', ['c1-img'], { link: { type: 'url', target: 'https://example.com/' } });
    const page = addToHome(s, card, { id: 'c1-img', kind: 'image', image: { assetId: null, alt: '' } });
    const [d] = advice(s, 'LINK_NAME_MISSING');
    expect(d).toMatchObject({ nodeId: 'c1', message: expect.stringMatching(/links the whole card, but nothing in it names where it goes/) });
    page.nodes['c1-img'] = { id: 'c1-img', kind: 'image', image: { assetId: null, alt: 'The harbour at dawn' } };
    expect(advice(s, 'LINK_NAME_MISSING')).toEqual([]);
    // A decorative picture's description is never said.
    page.nodes['c1-img'] = { id: 'c1-img', kind: 'image', image: { assetId: null, alt: 'The harbour at dawn', decorative: true } };
    expect(advice(s, 'LINK_NAME_MISSING')).toHaveLength(1);
    page.nodes.c1 = { ...card, children: ['c1-img', 'c1-t'] };
    page.nodes['c1-t'] = text('c1-t', 'p', 'Visit the harbour');
    expect(advice(s, 'LINK_NAME_MISSING')).toEqual([]);
  });

  it('leaves out what is hidden at every size', () => {
    const s = fresh();
    addToHome(s, link('l1', { icon: 'instagram', styles: { base: { hidden: true } } as never }));
    expect(advice(s, 'LINK_NAME_MISSING')).toEqual([]);
  });
});

describe('videos visitors cannot use', () => {
  const placeVideo = (s: ProjectState, props: Record<string, unknown>) => {
    const r = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: s.site.homePageId }, componentId: 'block.video', props }]);
    const page = home(r.state);
    return { s: r.state, nodeId: page.rootIds[page.rootIds.length - 1] };
  };

  it('reports a playable video with no title', () => {
    const { s, nodeId } = placeVideo(fresh(), { url: 'https://vimeo.com/76979871', title: '' });
    const [d] = advice(s, 'VIDEO_TITLE_MISSING');
    expect(d).toMatchObject({ severity: 'warning', nodeId, message: expect.stringMatching(/has no title\. Add a title that says what the video is\. Without one, screen readers announce only “Video from Vimeo”\./) });
    expect(advice(s, 'VIDEO_URL_UNSUPPORTED')).toEqual([]);
  });

  it('reports an address the player cannot play, though the video has a caption', () => {
    const { s, nodeId } = placeVideo(fresh(), { url: 'https://example.com/clip.mp4', title: 'Our studio', caption: 'A tour of the studio' });
    expect(advice(s, 'VIDEO_URL_UNSUPPORTED')).toEqual([expect.objectContaining({ nodeId, message: expect.stringMatching(/has no video its player can play/) })]);
  });

  it('says nothing of a titled video, or of one with no address yet', () => {
    expect(advice(placeVideo(fresh(), { url: 'https://vimeo.com/76979871', title: 'Our studio' }).s)).toEqual([]);
    expect(advice(placeVideo(fresh(), { url: '', title: '' }).s, 'VIDEO_URL_UNSUPPORTED')).toEqual([]);
  });
});

describe('the advice as a whole', () => {
  it('finds nothing in a fresh starter, and never stops a save', () => {
    const s = fresh();
    expect(advice(s)).toEqual([]);
    addToHome(s, text('t1', 'h2', ''), link('l1', { icon: 'instagram' }));
    home(s).rootIds.push('l1');
    expect(advice(s).length).toBe(2);
    expect(validateState(s, { sectionLinks: false }).filter((d) => CODES.has(d.code))).toEqual([]);
  });

  it('reads the same from a session cache as afresh, after an edit to the shared header', () => {
    const cache = new ValidationCache();
    const run = (s: ProjectState) => joinValidation(coreValidation(s, cache), adviceValidation(s, cache)).filter((d: Diagnostic) => CODES.has(d.code)).map(diagnosticKey);
    const s0 = fresh();
    addToHome(s0, box('a1', [], { anchor: 'top-bar' }));
    expect(run(s0)).toEqual([]);
    const header = { ...s0.site.shell.header, nodes: { ...s0.site.shell.header.nodes, h1: box('h1', [], { anchor: 'top-bar' }) }, rootIds: [...s0.site.shell.header.rootIds, 'h1'] };
    const s1 = { ...s0, site: { ...s0.site, shell: { ...s0.site.shell, header } } };
    expect(run(s1)).toEqual(advice(s1).map(diagnosticKey));
    expect(run(s1)).toHaveLength(1);
  });
});
