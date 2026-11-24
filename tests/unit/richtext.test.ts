import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { ComponentDefinition, InstanceNode, ProjectState, RichText } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import { MIGRATIONS, definitionHash as migrateHash, migrateProject } from '@shared/migrations';
import { cleanBlocks, parseRichText, richTextToMarkdown, richTextToParagraphs, richTextToPlain, toRichText } from '@shared/richtext';
import { createStarterState } from '@catalogue/starters';
import { catalogueComponent } from '@catalogue/index';
import { applyOperations, pageLinkReferences } from '@engine/apply';
import { installComponent, makeInstance } from '@engine/install';
import { validateState } from '@engine/validate';
import { normalizeRichText } from '@engine/values';
import { RUNTIME_DIR, generateManagedComponent, generateProject, resolveRichText } from '@generator/index';
import { IMAGE_SVELTE, LINK_SVELTE, RICHTEXT_SVELTE, UTIL_JS } from '@generator/runtime-files';
import { blocksFromDom, type RichDomNode } from '../../src/renderer/src/lib/richtext';

const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const pageNamed = (s: ProjectState, title: string) => Object.values(s.pages).find((p) => p.title === title)!;
const place = (s: ProjectState, componentId: string, props: Record<string, unknown> = {}) => {
  const node = makeInstance(s.components[installComponent(s, componentId)], props);
  home(s).nodes[node.id] = node;
  home(s).rootIds.push(node.id);
  return node;
};
const p = (...spans: Array<string | Record<string, unknown>>) => ({ type: 'p', spans: spans.map((x) => (typeof x === 'string' ? { text: x } : x)) });

describe('rich text input', () => {
  const s = fresh();
  const about = pageNamed(s, 'About');
  const norm = (v: unknown, plainAs?: 'ul' | 'ol' | 'check') => normalizeRichText(v, s, 'Body', plainAs);

  it('reads a plain string as one paragraph per line', () => {
    expect(norm('One\n\nTwo\nThree')).toEqual([p('One'), p('Two'), p('Three')]);
    expect(norm('')).toEqual([]);
    expect(norm(['One', '  ', 'Two'])).toEqual([p('One'), p('Two')]);
  });

  it('keeps accepting the old ** and * markers', () => {
    expect(norm('A **bold** and *italic* word')).toEqual([p('A ', { text: 'bold', strong: true }, ' and ', { text: 'italic', em: true }, ' word')]);
    expect(norm(['**One**', '*Two*'])).toEqual([p({ text: 'One', strong: true }), p({ text: 'Two', em: true })]);
    expect(norm('***both***')).toEqual([p({ text: 'both', strong: true, em: true })]);
    expect(norm('**bold *both* bold**')).toEqual([p({ text: 'bold', strong: true }, ' ', { text: 'both', strong: true, em: true }, ' ', { text: 'bold', strong: true })]);
  });

  it('leaves asterisks that are not marks alone', () => {
    expect(norm('2 * 3 * 4')).toEqual([p('2 * 3 * 4')]);
    expect(norm('5* hotel')).toEqual([p('5* hotel')]);
    expect(norm('an \\*escaped\\* word')).toEqual([p('an *escaped* word')]);
  });

  it('reads block markers', () => {
    expect(norm('### Title\n#### Sub\n> Quote\n- A\n- B\n1. One\n- [x] Done')).toEqual([
      { type: 'h3', spans: [{ text: 'Title' }] },
      { type: 'h4', spans: [{ text: 'Sub' }] },
      { type: 'blockquote', spans: [{ text: 'Quote' }] },
      { type: 'ul', items: [[{ text: 'A' }], [{ text: 'B' }]] },
      { type: 'ol', items: [[{ text: 'One' }]] },
      { type: 'check', items: [[{ text: 'Done' }]] }
    ]);
  });

  it('stores a page ID for a link written as a route', () => {
    expect(norm(`See [our story](${about.route}) and [the team](${about.route}#team).`)).toEqual([
      p('See ', { text: 'our story', link: { type: 'page', target: about.id } }, ' and ', { text: 'the team', link: { type: 'page', target: about.id, anchor: 'team' } }, '.')
    ]);
    expect(norm(`[x](${about.id})`)).toEqual([p({ text: 'x', link: { type: 'page', target: about.id } })]);
    expect(norm('[web](https://example.com/a "new tab")')).toEqual([p({ text: 'web', link: { type: 'url', target: 'https://example.com/a', newTab: true } })]);
    expect(norm('[mail](mailto:hi@example.com)')).toEqual([p({ text: 'mail', link: { type: 'email', target: 'hi@example.com' } })]);
  });

  it('refuses a route with no page, and leaves anything else in brackets as text', () => {
    expect(() => norm('[x](/no-such-page/)')).toThrow(/no page has the route/);
    expect(norm('[x](javascript:alert(1))')[0]).toEqual(p('[x](javascript:alert(1))'));
    expect(norm('[1](see note)')).toEqual([p('[1](see note)')]);
  });

  it('validates structured blocks and every link in them', () => {
    expect(norm([{ type: 'p', spans: [{ text: 'a', strong: true, junk: 1 }] }])).toEqual([p({ text: 'a', strong: true })]);
    expect(norm([{ type: 'ul', items: [[{ text: 'a' }], [{ text: 'b', link: { type: 'page', target: about.id } }]] }])).toEqual([{ type: 'ul', items: [[{ text: 'a' }], [{ text: 'b', link: { type: 'page', target: about.id } }]] }]);
    expect(() => norm([{ type: 'p', spans: [{ text: 'a', link: { type: 'page', target: 'pg_nope' } }] }])).toThrow(/does not exist/);
    expect(() => norm([{ type: 'p', spans: [{ text: 'a', link: { type: 'url', target: 'javascript:alert(1)' } }] }])).toThrow(/http/);
    expect(() => norm([{ type: 'marquee', spans: [] }])).toThrow(/expected text or blocks/);
    expect(() => norm([{ type: 'p', spans: [{ nope: 1 }] }])).toThrow(/span/);
    expect(() => norm({ type: 'p' })).toThrow(/expected text/);
  });

  it('drops a link of type none, and limits size', () => {
    expect(norm([{ type: 'p', spans: [{ text: 'a', link: { type: 'none', target: '' } }] }])).toEqual([p('a')]);
    expect(() => norm('x'.repeat(20001))).toThrow(/too long/);
    expect(() => norm(Array.from({ length: 501 }, (_, i) => `p${i}`))).toThrow(/too long/);
  });

  it('makes plain lines items of a property that shows a list', () => {
    expect(norm(['One', 'Two'], 'check')).toEqual([{ type: 'check', items: [[{ text: 'One' }], [{ text: 'Two' }]] }]);
    expect(norm('One\nTwo', 'ul')).toEqual([{ type: 'ul', items: [[{ text: 'One' }], [{ text: 'Two' }]] }]);
  });

  it('is unchanged by a second pass', () => {
    const once = norm(`### T\nA **b** *c* [d](${about.route})\n- e\n- [x] f`);
    expect(norm(once)).toEqual(once);
  });

  it('reads back its own text form exactly', () => {
    const value = norm([
      { type: 'h3', spans: [{ text: 'Title * with star' }] },
      { type: 'p', spans: [{ text: '- not a list, 2 * 3 [x] ' }, { text: 'bold', strong: true }, { text: ' ' }, { text: 'both', strong: true, em: true }, { text: ' ' }, { text: 'link', link: { type: 'page', target: about.id, anchor: 'team' } }] },
      { type: 'p', spans: [{ text: '1. not a list either' }] },
      { type: 'p', spans: [{ text: '### not a heading' }] },
      { type: 'p', spans: [{ text: '> not a quote' }] },
      { type: 'blockquote', spans: [{ text: 'Quote' }] },
      { type: 'ul', items: [[{ text: 'A' }], [{ text: 'web', link: { type: 'url', target: 'https://example.com/', newTab: true } }]] },
      { type: 'ol', items: [[{ text: 'One' }], [{ text: 'Two' }]] },
      { type: 'check', items: [[{ text: 'Done' }]] }
    ]);
    expect(norm(richTextToMarkdown(value, s.pages))).toEqual(value);
  });

  describe('reads back its own text form for each case that needs care', () => {
    const team = { type: 'page', target: about.id, anchor: 'team' };
    const cases: Array<[string, RichText, ('ul' | 'ol' | 'check')?]> = [
      ['marks that touch', [p({ text: 'a', strong: true }, { text: 'b', em: true }, { text: 'c', strong: true, em: true }, { text: 'd', strong: true }, 'e', { text: 'f', em: true })] as unknown as RichText],
      ['a mark touching a link', [p({ text: 'a', strong: true }, { text: 'b', link: team }, { text: 'c', em: true })] as unknown as RichText],
      ['lines that start like numbered items', [p('1) not a list'), p('2. nor this'), p('3)also not')] as unknown as RichText],
      ['URLs with parentheses', [p({ text: 'wiki', link: { type: 'url', target: 'https://en.wikipedia.org/wiki/Foo_(bar)' } }, ' ', { text: 'odd', link: { type: 'url', target: 'https://example.com/a)b(' } })] as unknown as RichText],
      ['paragraphs in a field whose plain lines are items', [p('Intro'), { type: 'check', items: [[{ text: 'One' }], [{ text: '- two' }]] }, p('- dash'), p('Outro')] as unknown as RichText, 'check'],
      ['a page link with an anchor', [p({ text: 'the team', link: team })] as unknown as RichText]
    ];
    for (const [name, value, plainAs] of cases)
      it(name, () => {
        // Each fixture is already canonical, so the round trip is compared with exactly what was written.
        expect(norm(value, plainAs)).toEqual(value);
        expect(norm(richTextToMarkdown(value, s.pages, plainAs), plainAs)).toEqual(value);
      });

    it('reads each case as written by hand, too', () => {
      expect(norm('1) One\n2) Two')).toEqual([{ type: 'ol', items: [[{ text: 'One' }], [{ text: 'Two' }]] }]);
      expect(norm('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([p({ text: 'wiki', link: { type: 'url', target: 'https://en.wikipedia.org/wiki/Foo_(bar)' } })]);
      expect(norm('[**a** b](https://example.com/)')).toEqual([p({ text: 'a', strong: true, link: { type: 'url', target: 'https://example.com/' } }, ' ', { text: 'b', link: { type: 'url', target: 'https://example.com/' } })]);
      expect(norm('One\n\\|Two', 'check')).toEqual([{ type: 'check', items: [[{ text: 'One' }]] }, p('Two')]);
    });

    it('reads a page ID with an anchor as that page', () => {
      expect(norm(`[the team](${about.id}#team)`)).toEqual([p({ text: 'the team', link: team })]);
      expect(norm(`[x](${about.id}#not an anchor)`)).toEqual([p(`[x](${about.id}#not an anchor)`)]);
    });
  });

  it('parses hostile input in linear time', () => {
    const link = (target: string) => ({ type: 'url' as const, target });
    // About 120 000 characters each: linear parsing takes milliseconds, a quadratic scan many seconds.
    const inputs: Array<[string, string]> = [
      ...['*a ', '[', '**a ', '[a]('].map((unit): [string, string] => [unit, unit.repeat(Math.ceil(120_000 / unit.length))]),
      ['a link whose words are many marked runs', `[${'*a* '.repeat(30_000)}](https://example.com/${'x'.repeat(1900)})`],
      ['many lines that go on after a break', 'a\\\n'.repeat(200_000)]
    ];
    for (const [name, input] of inputs) {
      const started = performance.now();
      const out = parseRichText(input, { markdown: true, link });
      expect(performance.now() - started, name).toBeLessThan(1500);
      expect(richTextToPlain(out).length, name).toBeGreaterThan(0);
    }
  });

  it('cleans a marked run of many line breaks in linear time', () => {
    const text = 'A' + '\n'.repeat(400_000) + 'B';
    const started = performance.now();
    const out = cleanBlocks([{ type: 'p', spans: [{ text, strong: true }] }]);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(out).toEqual([p({ text, strong: true })]);
  });

  it('reads a line ending in a backslash as a line break inside the block', () => {
    expect(norm('Harbour Lane Studio\\\n12 Quay Street\\\nPort Town\n\nNext')).toEqual([p('Harbour Lane Studio\n12 Quay Street\nPort Town'), p('Next')]);
    expect(norm('- One\\\n  more\n- Two')).toEqual([{ type: 'ul', items: [[{ text: 'One\nmore' }], [{ text: 'Two' }]] }]);
    // Only an odd run of backslashes breaks the line: an even run is escaped backslashes.
    expect(norm('C:\\\\\nNext')).toEqual([p('C:\\'), p('Next')]);
    expect(norm('A' + '\\'.repeat(5) + '\nB')).toEqual([p('A' + '\\'.repeat(2) + '\nB')]);
    // A marker is followed by any space but a line break.
    expect(norm('1.\u00a0Buy')).toEqual([{ type: 'ol', items: [[{ text: 'Buy' }]] }]);
    expect(norm('###\u00a0Title\n-\u00a0Item')).toEqual([{ type: 'h3', spans: [{ text: 'Title' }] }, { type: 'ul', items: [[{ text: 'Item' }]] }]);
    // A string never goes on into the next one, and old strings are read for their marks only.
    expect(norm(['A\\', 'B'])).toEqual([p('A\n'), p('B')]);
    expect(toRichText(['A\\', 'B'])).toEqual([p('A\\'), p('B')]);
  });

  it('keeps line breaks in structured blocks, without the spaces around them', () => {
    expect(norm([{ type: 'p', spans: [{ text: 'a \r\n b' }, { text: ' bold \n', strong: true }, { text: 'c' }] }])).toEqual([p('a\nb ', { text: 'bold', strong: true }, '\nc')]);
    // A carriage return alone is spacing, as it always was.
    expect(norm([{ type: 'p', spans: [{ text: 'a\rb' }] }, { type: 'p', spans: [{ text: 'c\rd', strong: true }] }])).toEqual([p('a b'), p({ text: 'c d', strong: true })]);
    expect(toRichText(['A\rB'])).toEqual([p('A B')]);
    expect(norm([{ type: 'p', spans: [{ text: '\nlead and trail\n\n' }] }])).toEqual([p('\nlead and trail\n\n')]);
    // A block of breaks alone has nothing to show.
    expect(norm([{ type: 'p', spans: [{ text: ' \n \n' }] }, { type: 'p', spans: [{ text: 'x' }] }])).toEqual([p('x')]);
    // Every break counts toward the size limit.
    expect(() => norm([{ type: 'p', spans: [{ text: 'a' + '\n'.repeat(20000) }] }])).toThrow(/too long/);
  });

  it('reads back line breaks from its own text form exactly', () => {
    const value = norm([
      { type: 'p', spans: [{ text: 'Harbour Lane Studio\n12 Quay Street' }] },
      { type: 'p', spans: [{ text: 'ends with a backslash \\\nthen more' }] },
      { type: 'p', spans: [{ text: 'Before ' }, { text: 'bold\nlink', strong: true, link: { type: 'page', target: about.id } }, { text: '\n- not a list' }] },
      { type: 'p', spans: [{ text: '\nstarts and ends with a break\n\n' }] },
      { type: 'h3', spans: [{ text: 'Two\nlines' }] },
      { type: 'h3', spans: [{ text: '\nAfter a break' }] },
      { type: 'p', spans: [{ text: 'A\n\u00a0spaced on purpose' }] },
      { type: 'blockquote', spans: [{ text: 'Quote ending in a break\n' }] },
      { type: 'ul', items: [[{ text: 'Item\n### not a heading' }], [{ text: 'Last\n' }]] }
    ]);
    const text = richTextToMarkdown(value, s.pages);
    expect(text).toContain('Harbour Lane Studio\\\n12 Quay Street');
    expect(norm(text)).toEqual(value);
    expect(norm(richTextToMarkdown(value, s.pages, 'ul'), 'ul')).toEqual(value);
  });

  it('gives plain words and old-style paragraphs when that is all a place can hold', () => {
    const value = norm('A **b**\n- c\n- *d*');
    expect(richTextToPlain(value)).toBe('A b\n\nc\nd');
    expect(richTextToParagraphs(value)).toEqual(['A **b**', 'c', '*d*']);
  });

  it('reads an unmigrated value without failing', () => {
    expect(toRichText(['With **bold**'])).toEqual([p('With ', { text: 'bold', strong: true })]);
    expect(toRichText('One\n\nTwo')).toEqual([p('One'), p('Two')]);
    expect(toRichText(null)).toEqual([]);
    expect(toRichText(['A', 'B'], 'check')).toEqual([{ type: 'check', items: [[{ text: 'A' }], [{ text: 'B' }]] }]);
    // Old strings were only ever read for their marks: nothing else in them becomes structure.
    expect(toRichText(['- not a list [x](/y/)'])).toEqual([p('- not a list [x](/y/)')]);
  });
});

describe('links inside rich text are real links', () => {
  const withLink = () => {
    const s = fresh();
    const about = pageNamed(s, 'About');
    const before = pageLinkReferences(s, about.id);
    const node = place(s, 'content.text', { body: normalizeRichText(`Read [about us](${about.route}).`, s, 'Body') });
    return { s, about, node, before };
  };

  it('counts toward the page’s usage', () => {
    const { s, about, before } = withLink();
    expect(pageLinkReferences(s, about.id)).toBe(before + 1);
  });

  it('follows a route change without being rewritten', () => {
    const { s, about, node } = withLink();
    const next = applyOperations(s, [{ type: 'page.update', pageId: about.id, route: '/our-story/' }]).state;
    const body = (next.pages[next.site.homePageId].nodes[node.id] as InstanceNode).props.body as RichText;
    expect(JSON.stringify(body)).toContain(about.id);
    const page = generateProject(next).get('src/routes/+page.svelte')!;
    expect(page).toContain('"href":"/our-story/"');
    expect(page).not.toContain('"href":"/about/"');
  });

  it('blocks deleting the page, and moves to the replacement', () => {
    const { s, about, node } = withLink();
    expect(() => applyOperations(s, [{ type: 'page.remove', pageId: about.id }])).toThrow(/point to/);
    const contact = pageNamed(s, 'Contact');
    const next = applyOperations(s, [{ type: 'page.remove', pageId: about.id, replacementPageId: contact.id }]).state;
    const body = (next.pages[next.site.homePageId].nodes[node.id] as InstanceNode).props.body as RichText;
    expect(JSON.stringify(body)).toContain(contact.id);
    expect(JSON.stringify(body)).not.toContain(about.id);
  });

  it('is reported when its page is gone', () => {
    const { s, about, node } = withLink();
    const body = (home(s).nodes[node.id] as InstanceNode).props.body as Array<{ spans: Array<{ link?: { target: string } }> }>;
    body[0].spans[1].link!.target = 'pg_gone';
    expect(validateState(s).some((d) => d.code === 'LINK_BROKEN')).toBe(true);
    expect(about.id).not.toBe('pg_gone');
  });

  it('is reported when its page is gone from a rich or list default', () => {
    const s = fresh();
    place(s, 'content.text');
    place(s, 'pricing.plans');
    const gone = { type: 'page', target: 'pg_gone' };
    const broken = () => validateState(s).filter((d) => d.code === 'LINK_BROKEN');
    expect(broken()).toEqual([]);
    const text = s.components['foundation.content.text'];
    (text.properties.body as { default: unknown }).default = [p('Read ', { text: 'this', link: gone })];
    expect(broken()).toEqual([expect.objectContaining({ owner: { kind: 'component', id: text.id }, message: expect.stringContaining('default “Text” links to a page') })]);
    (text.properties.body as { default: unknown }).default = [];
    const plans = s.components['foundation.pricing.plans'];
    const list = plans.properties.plans as unknown as { label: string; default: Array<{ features: unknown }> };
    list.default[0].features = [{ type: 'check', items: [[{ text: 'See more', link: gone }]] }];
    expect(broken()).toEqual([expect.objectContaining({ owner: { kind: 'component', id: plans.id }, message: expect.stringContaining(`default “${list.label}” links to a page`) })]);
    // A link to a page that exists is not reported, and neither is list data that only looks like a link.
    list.default[0].features = [{ type: 'check', items: [[{ text: 'About', link: { type: 'page', target: pageNamed(s, 'About').id } }]] }];
    expect(broken()).toEqual([]);
    const cta = s.components[installComponent(s, 'cta.banner')];
    const [, linkSchema] = Object.entries(cta.properties).find(([, sch]) => sch.type === 'link')!;
    const ctaDefault = linkSchema.default;
    (linkSchema as { default: unknown }).default = gone;
    expect(broken()).toEqual([expect.objectContaining({ owner: { kind: 'component', id: cta.id } })]);
    (linkSchema as { default: unknown }).default = ctaDefault;
    (text.properties.body as { default: unknown }).default = [p({ text: 'file', link: { type: 'document', target: 'asset_gone' } })];
    expect(broken()).toEqual([expect.objectContaining({ message: expect.stringContaining('default “Text” links to a document that is no longer in Assets') })]);
    (text.properties.body as { default: unknown }).default = [];
    list.default[0].features = [];
    const data = applyOperations(s, [{ type: 'component.createCode', name: 'Data', source: '<p>x</p>\n', properties: { rows: { type: 'list', label: 'Rows', itemLabel: 'Row', fields: { type: { type: 'string', label: 'Type' }, target: { type: 'string', label: 'Target' } } } } }]);
    const rows = data.state.components[data.results[0].definitionId as string].properties.rows as unknown as { default: unknown[] };
    rows.default = [{ id: 'r1', type: 'page', target: 'landing' }];
    expect(validateState(data.state).filter((d) => d.code === 'LINK_BROKEN')).toEqual([]);
    // An unplaced code component whose list starts empty, with the link only in the default of a new item's field.
    const r = applyOperations(s, [{ type: 'component.createCode', name: 'Notes', source: '<p>x</p>\n', properties: { notes: { type: 'list', label: 'Notes', itemLabel: 'Note', fields: { body: { type: 'richtext', label: 'Body' } } } } }]);
    const code = r.state.components[r.results[0].definitionId as string];
    (code.properties.notes as unknown as { fields: { body: { default: unknown } } }).fields.body.default = [p({ text: 'gone', link: gone })];
    const found = validateState(r.state).filter((d) => d.code === 'LINK_BROKEN');
    expect(found).toEqual([expect.objectContaining({ owner: { kind: 'component', id: code.id }, message: 'Notes: the default “Notes › Body” links to a page that no longer exists.' })]);
    expect(found[0]).not.toHaveProperty('nodeId');
  });

  it('flags rich text shown from a property that is not rich text when a project opens', () => {
    const s = fresh();
    place(s, 'content.text');
    const def = s.components['foundation.content.text'];
    const invalid = () => validateState(s).filter((d) => d.code === 'BINDING_INVALID');
    expect(invalid()).toEqual([]);
    const [nodeId] = Object.entries(def.tree!.nodes).find(([, n]) => n.kind === 'text' && n.rich && JSON.stringify(n.text) === '{"$prop":"body"}')!;
    def.properties.body = { type: 'string', label: 'Body', default: 'Plain' };
    expect(invalid()).toEqual([expect.objectContaining({ owner: { kind: 'component', id: def.id }, nodeId, message: expect.stringMatching(/string property as its text, which needs a richtext property/) })]);
    // A list item field, too.
    const plans = s.components[installComponent(s, 'pricing.plans')];
    const [featuresId] = Object.entries(plans.tree!.nodes).find(([, n]) => n.kind === 'text' && n.rich && JSON.stringify(n.text) === '{"$item":"features"}')!;
    (plans.properties.plans as unknown as { fields: Record<string, unknown> }).fields.features = { type: 'string', label: 'Features', default: '' };
    expect(invalid()).toEqual(expect.arrayContaining([expect.objectContaining({ owner: { kind: 'component', id: plans.id }, nodeId: featuresId })]));
  });

  it('goes through instance and node content operations', () => {
    const { s, about, node } = withLink();
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    const set = applyOperations(s, [{ type: 'instance.setProp', owner, nodeId: node.id, prop: 'body', value: `**New** [link](${about.route})` }]).state;
    expect((set.pages[s.site.homePageId].nodes[node.id] as InstanceNode).props.body).toEqual([p({ text: 'New', strong: true }, ' ', { text: 'link', link: { type: 'page', target: about.id } })]);
    expect(() => applyOperations(s, [{ type: 'instance.setProp', owner, nodeId: node.id, prop: 'body', value: '[x](/missing/)' }])).toThrow(/no page has/);
    const inserted = applyOperations(s, [{ type: 'node.insert', owner, primitive: 'richtext', text: 'One **two**' }]);
    const id = inserted.results[0].nodeId as string;
    expect(inserted.state.pages[s.site.homePageId].nodes[id]).toMatchObject({ rich: true, text: [p('One ', { text: 'two', strong: true })] });
    const edited = applyOperations(inserted.state, [{ type: 'node.setContent', owner, nodeId: id, field: 'text', value: '- a\n- b' }]).state;
    expect(edited.pages[s.site.homePageId].nodes[id]).toMatchObject({ text: [{ type: 'ul', items: [[{ text: 'a' }], [{ text: 'b' }]] }] });
  });
});

describe('generated rich text', () => {
  it('resolves links and refuses unsafe ones from a hand-edited document', () => {
    const s = fresh();
    const about = pageNamed(s, 'About');
    const value = [
      p(
        { text: 'page', link: { type: 'page', target: about.id, anchor: 'team' } },
        { text: 'gone', link: { type: 'page', target: 'pg_gone' } },
        { text: 'script', link: { type: 'url', target: 'javascript:alert(1)' } },
        { text: 'data', link: { type: 'url', target: 'data:text/html,x' } },
        { text: 'mail', link: { type: 'email', target: 'a b@example.com' } },
        { text: 'phone', link: { type: 'tel', target: '+1 (555) 010' } }
      )
    ];
    const out = resolveRichText(value, { state: s })[0] as { spans: Array<{ text: string; link?: { href: string } }> };
    const by = Object.fromEntries(out.spans.map((x) => [x.text, x.link?.href]));
    expect(by.page).toBe('/about/#team');
    expect(by.gone).toBeUndefined();
    expect(by.script).toBeUndefined();
    expect(by.data).toBeUndefined();
    expect(by.mail).toBe('mailto:a%20b@example.com');
    expect(by.phone).toBe('tel:+1555010');
  });

  it('writes literal rich text through the same resolution', () => {
    const s = fresh();
    const about = pageNamed(s, 'About');
    const r = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: s.site.homePageId }, primitive: 'richtext', text: `[go](${about.route})` }]);
    // The home page links to About elsewhere too, so only the element written for this text is read.
    const literal = (state: ProjectState) => {
      const page = generateProject(state).get('src/routes/+page.svelte')!;
      const lines = page.split('\n').filter((l) => l.includes('<SoRichText value={') && l.includes('"text":"go"'));
      expect(lines).toHaveLength(1);
      return lines[0];
    };
    expect(literal(r.state)).toContain('[{"type":"p","spans":[{"text":"go","link":{"href":"/about/"}}]}]');
    expect(literal(r.state)).not.toContain(about.id);
    const moved = applyOperations(r.state, [{ type: 'page.update', pageId: about.id, route: '/our-story/' }]).state;
    expect(literal(moved)).toContain('"link":{"href":"/our-story/"}');
  });

  it('carries no editor runtime in exports', () => {
    const s = fresh();
    place(s, 'content.text', { body: normalizeRichText('A **b** [c](https://example.com/)\n- d', s, 'Body') });
    const files = generateProject(s);
    expect(files.get(`${RUNTIME_DIR}/RichText.svelte`)).not.toMatch(/data-so-|__so|siteorigin-bridge/);
    for (const [path, text] of files) if (path.endsWith('.svelte')) expect(text, path).not.toMatch(/data-so-(node|ctx|items)/);
  });

  it('shows the pricing features as a check list from the schema alone', () => {
    const def = catalogueComponent('foundation', 'pricing.plans')!;
    expect((def.tree!.nodes.features as { list?: string }).list).toBeUndefined();
    const plans = def.properties.plans as unknown as { fields: Record<string, { plainAs?: string }>; default: Array<{ features: RichText }> };
    expect(plans.fields.features.plainAs).toBe('check');
    expect(plans.default[0].features[0].type).toBe('check');
  });

  describe('code components', () => {
    const code = (s: ProjectState, source: string, form: Record<string, unknown> = {}) => {
      const r = applyOperations(s, [{ type: 'component.createCode', name: 'Note', source, properties: { body: { type: 'richtext', label: 'Body', default: 'Default **text**', ...form } } }]);
      const defId = r.results[0].definitionId as string;
      const node = makeInstance(r.state.components[defId], { body: normalizeRichText('A **b** [c](https://example.com/)', r.state, 'Body') });
      const page = r.state.pages[r.state.site.homePageId];
      page.nodes[node.id] = node;
      page.rootIds.push(node.id);
      return r.state;
    };

    const helper = `<script>import SoRichText from '$lib/siteorigin/runtime/RichText.svelte'; let { body = [] } = $props();</script><SoRichText value={body} />`;

    it('passes paragraph strings to a property that declares no form, as code components always had', () => {
      const out = generateProject(code(fresh(), `<script>let { body = [] } = $props();</script>{#each body as line}<p>{line}</p>{/each}`)).get('src/routes/+page.svelte')!;
      expect(out).toContain('body={["A **b** c"]}');
      // Importing the helper decides nothing: only the declaration does.
      expect(generateProject(code(fresh(), helper)).get('src/routes/+page.svelte')).toContain('body={["A **b** c"]}');
      expect(generateProject(code(fresh(), helper, { codeForm: 'paragraphs' })).get('src/routes/+page.svelte')).toContain('body={["A **b** c"]}');
    });

    it('keeps a declared form as declared', () => {
      const s = code(fresh(), helper, { codeForm: 'paragraphs' });
      expect(Object.values(s.components).find((d) => d.name === 'Note')!.properties.body).toMatchObject({ codeForm: 'paragraphs' });
    });

    it('passes blocks to a property declared to take them', () => {
      const out = generateProject(code(fresh(), helper, { codeForm: 'blocks' })).get('src/routes/+page.svelte')!;
      expect(out).toContain('"href":"https://example.com/"');
      expect(() => code(fresh(), helper, { codeForm: 'html' })).toThrow(/codeForm must be blocks or paragraphs/);
    });

    it('converts a bound value for a nested component written for strings', () => {
      const s = code(fresh(), `<script>let { body = [] } = $props();</script>{#each body as line}<p>{line}</p>{/each}`);
      const inner = Object.values(s.components).find((d) => d.name === 'Note')!;
      const nested = makeInstance(inner, { body: { $prop: 'text' } });
      const outer: ComponentDefinition = {
        ...structuredClone(inner),
        id: 'project.outer',
        componentId: 'project.outer',
        kind: 'managed',
        source: undefined,
        sourcePath: undefined,
        properties: { text: { type: 'richtext', label: 'Text', default: [] } },
        parts: { root: { nodeId: nested.id, label: 'Root' } },
        tree: { rootIds: [nested.id], nodes: { [nested.id]: nested } }
      };
      const out = generateManagedComponent(s, outer, {});
      expect(out).toContain('body={richParagraphs(text)}');
      expect(out).toMatch(/import \{ richParagraphs \} from ".*util\.js"/);
    });
  });
});

describe('migrating documents to structured rich text', () => {
  /** The starter as it was written in format 2: strings for rich text, and `list` on the pricing node. */
  const oldProject = () => {
    const s = fresh();
    const pricing = place(s, 'pricing.plans');
    const text = place(s, 'content.text');
    (text.props as Record<string, unknown>).body = ['Plain', 'With **bold** and *em*', '2 * 3 * 4 reads as it did'];
    const plans = pricing.props.plans as Array<Record<string, unknown>>;
    plans[0].features = ['First', 'Second **strong**'];
    const def = s.components['foundation.pricing.plans'];
    const schema = def.properties.plans as unknown as { fields: { features: Record<string, unknown> }; default: Array<Record<string, unknown>> };
    delete schema.fields.features.plainAs;
    schema.fields.features.default = ['A feature'];
    for (const it of schema.default) it.features = ['Old default'];
    (def.tree!.nodes.features as unknown as { list: string }).list = 'check';
    const body = s.components['foundation.content.text'].properties.body as unknown as { default: unknown };
    body.default = ['Default paragraph'];
    const lit = 'n_literal';
    home(s).nodes[lit] = { id: lit, kind: 'text', tag: 'div', rich: true, text: ['Literal **rich**'] as never };
    home(s).rootIds.push(lit);
    const docs = [s.manifest, s.site, s.tokens, s.assets, s.themeLock, ...Object.values(s.pages), ...Object.values(s.components)];
    for (const d of docs) d.schemaVersion = 2;
    return { s, pricingId: pricing.id, textId: text.id, lit };
  };

  it('converts values, defaults, literal text and the list marker', () => {
    const { s, pricingId, textId, lit } = oldProject();
    const out = migrateProject(s)!;
    expect(out.applied[0]).toBe('structured-rich-text');
    const page = out.state.pages[out.state.site.homePageId];
    expect((page.nodes[textId] as InstanceNode).props.body).toEqual([
      p('Plain'),
      p('With ', { text: 'bold', strong: true }, ' and ', { text: 'em', em: true }),
      // The old renderer read this pair of asterisks as emphasis, and the page keeps showing what it showed.
      p('2 ', { text: '3', em: true }, ' 4 reads as it did')
    ]);
    const plans = (page.nodes[pricingId] as InstanceNode).props.plans as Array<{ features: unknown }>;
    expect(plans[0].features).toEqual([{ type: 'check', items: [[{ text: 'First' }], [{ text: 'Second ' }, { text: 'strong', strong: true }]] }]);
    expect(page.nodes[lit]).toMatchObject({ text: [p('Literal ', { text: 'rich', strong: true })] });
    const def = out.state.components['foundation.pricing.plans'];
    const schema = def.properties.plans as unknown as { fields: { features: { plainAs: string; default: unknown } }; default: Array<{ features: unknown }> };
    expect(schema.fields.features.plainAs).toBe('check');
    expect(schema.fields.features.default).toEqual([{ type: 'check', items: [[{ text: 'A feature' }]] }]);
    expect(schema.default[0].features).toEqual([{ type: 'check', items: [[{ text: 'Old default' }]] }]);
    expect((def.tree!.nodes.features as { list?: string }).list).toBeUndefined();
    expect((out.state.components['foundation.content.text'].properties.body as { default: unknown }).default).toEqual([p('Default paragraph')]);
    expect(out.state.manifest.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('writes the canonical form, so an untouched edit changes nothing', () => {
    const { s, textId } = oldProject();
    const page = migrateProject(s)!.state;
    const body = (page.pages[page.site.homePageId].nodes[textId] as InstanceNode).props.body as RichText;
    expect(cleanBlocks(body)).toEqual(body);
    expect(normalizeRichText(body, page, 'Body')).toEqual(body);
  });

  it('leaves its input alone and has nothing to do the second time', () => {
    const { s, textId } = oldProject();
    const before = JSON.stringify(s);
    const out = migrateProject(s)!;
    expect(JSON.stringify(s)).toBe(before);
    expect((s.pages[s.site.homePageId].nodes[textId] as InstanceNode).props.body).toEqual(expect.arrayContaining(['Plain']));
    expect(migrateProject(out.state)).toBeNull();
  });

  it('converts only the documents still at the old version', () => {
    const { s, textId } = oldProject();
    const page = s.pages[s.site.homePageId];
    const current = Object.values(s.pages).find((x) => x.id !== page.id)!;
    current.schemaVersion = SCHEMA_VERSION;
    const value = [p('Already structured')];
    const node = makeInstance(s.components[installComponent(s, 'content.text')], { body: value });
    // Text the step would read as an old paragraph: in a current document, only the version check keeps it as it is.
    const loose = makeInstance(s.components['foundation.content.text'], { body: 'Left **as written**' as never });
    const lit = 'n_current_literal';
    current.nodes[lit] = { id: lit, kind: 'text', tag: 'div', rich: true, text: ['Also **as written**'] as never };
    for (const n of [node, loose]) current.nodes[n.id] = n;
    current.rootIds.push(node.id, loose.id, lit);
    const before = structuredClone(current);
    const out = migrateProject(s)!.state;
    expect(out.pages[current.id]).toEqual(before);
    expect((out.pages[current.id].nodes[node.id] as InstanceNode).props.body).toEqual(value);
    expect((out.pages[page.id].nodes[textId] as InstanceNode).props.body).toEqual(expect.arrayContaining([p('Plain')]));
  });

  it('keeps bound values and a definition already in the new format', () => {
    const { s } = oldProject();
    const def = s.components['foundation.content.text'];
    def.schemaVersion = SCHEMA_VERSION;
    const blocks = [p('New default')];
    (def.properties.body as { default: unknown }).default = blocks;
    // A default the step would read as old paragraphs: in a current definition, only the version check keeps it.
    def.properties.note = { type: 'richtext', label: 'Note', default: 'Left **as written**' as never };
    const kept = structuredClone(def);
    const bound = makeInstance(def, { body: { $prop: 'text' } });
    const wrapper = structuredClone(s.components['foundation.pricing.plans']);
    wrapper.id = 'project.wrap';
    wrapper.tree = { rootIds: [bound.id], nodes: { [bound.id]: bound } };
    s.components[wrapper.id] = wrapper;
    const out = migrateProject(s)!.state;
    expect(out.components['foundation.content.text']).toEqual(kept);
    expect((out.components['foundation.content.text'].properties.body as { default: unknown }).default).toEqual(blocks);
    expect((out.components['project.wrap'].tree!.nodes[bound.id] as InstanceNode).props.body).toEqual({ $prop: 'text' });
  });

  it('declares how each code component takes rich text, as it took it before', () => {
    const project = (version: number) => {
      const properties = { body: { type: 'richtext', label: 'Body' }, rows: { type: 'list', label: 'Rows', itemLabel: 'Row', fields: { text: { type: 'richtext', label: 'Text' } } } };
      const r = applyOperations(fresh(), [
        { type: 'component.createCode', name: 'Helper', source: `<script>import SoRichText from '../runtime/RichText.svelte'; let { body = [] } = $props();</script><SoRichText value={body} />\n`, properties },
        { type: 'component.createCode', name: 'Strings', source: `<script>let { body = [] } = $props();</script><p>{body.join(' ')}</p>\n`, properties },
        { type: 'component.createCode', name: 'Declared', source: `<script>import SoRichText from '../runtime/RichText.svelte'; let { body = [] } = $props();</script><SoRichText value={body} />\n`, properties: { body: { ...properties.body, codeForm: 'paragraphs' } } },
        // One property declared: the others were left to the default on purpose.
        { type: 'component.createCode', name: 'Partly', source: `<script>import SoRichText from '../runtime/RichText.svelte'; let { body = [], rows = [] } = $props();</script><SoRichText value={body} />\n`, properties: { ...properties, body: { ...properties.body, codeForm: 'blocks' } } },
        { type: 'component.createCode', name: 'Converted', source: `<!-- Code component converted from "Text". Edit freely; declared properties stay editable in SiteOrigin Builder. -->\n<p>x</p>\n`, properties }
      ]);
      const s = r.state;
      for (const d of [s.manifest, s.site, s.tokens, s.assets, s.themeLock, ...Object.values(s.pages), ...Object.values(s.components)]) d.schemaVersion = version;
      const out = migrateProject(s)!.state;
      const form = (name: string) => {
        const def = Object.values(out.components).find((d) => d.name === name)!;
        return [(def.properties.body as { codeForm?: string }).codeForm, (def.properties.rows as { fields?: { text: { codeForm?: string } } } | undefined)?.fields?.text.codeForm];
      };
      return { helper: form('Helper'), strings: form('Strings'), declared: form('Declared'), partly: form('Partly'), converted: form('Converted') };
    };
    // Format 2 gave every code component paragraph strings.
    expect(project(2)).toEqual({ helper: ['paragraphs', 'paragraphs'], strings: ['paragraphs', 'paragraphs'], declared: ['paragraphs', undefined], partly: ['blocks', 'paragraphs'], converted: ['paragraphs', 'paragraphs'] });
    // Since then, the source decided: rendering through the helper, or being converted, took blocks.
    const before = MIGRATIONS.findIndex((m) => m.id === 'rich-text-code-form') + 1;
    // Released as the sixth migration, upgrading format 6 to 7; later ones change nothing it decided.
    expect(before).toBe(6);
    expect(project(before)).toEqual({ helper: ['blocks', 'blocks'], strings: [undefined, undefined], declared: ['paragraphs', undefined], partly: ['blocks', undefined], converted: ['blocks', 'blocks'] });
  });

  it('keeps a pristine theme definition matching its lock', () => {
    const { s } = oldProject();
    const id = 'foundation.content.text';
    s.themeLock.components[id].hash = 'stale';
    const unmodified = 'foundation.pricing.plans';
    const original = s.themeLock.components[unmodified];
    // Hash the old-format document, as the lock would have recorded it.
    s.themeLock.components[unmodified] = { ...original, hash: migrateHash(s.components[unmodified]) };
    const out = migrateProject(s)!.state;
    expect(out.themeLock.components[unmodified].hash).toBe(migrateHash(out.components[unmodified]));
    expect(out.themeLock.components[id].hash).toBe('stale');
  });
});

/** Just enough HTML parsing to read server-rendered rich text the way the bridge copies the live DOM. */
function domFromHtml(html: string): RichDomNode[] {
  const decode = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const root: { children: RichDomNode[] } = { children: [] };
  const stack: Array<{ children: RichDomNode[] }> = [root];
  for (const m of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(\/?)([a-z0-9]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g)) {
    if (m[5] !== undefined) {
      stack[stack.length - 1].children.push(decode(m[5]));
      continue;
    }
    if (m[1]) {
      stack.pop();
      continue;
    }
    const attrs = Object.fromEntries([...m[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((a) => [a[1], decode(a[2] ?? '')]));
    const el: Exclude<RichDomNode, string> = { tag: m[2], children: [] };
    if (m[2] === 'ul' && (attrs.class ?? '').split(/\s+/).includes('so-rich--check')) el.check = true;
    if (m[2] === 'a' && attrs.href !== undefined) {
      el.href = attrs.href;
      if (attrs.target === '_blank') el.newTab = true;
    }
    stack[stack.length - 1].children.push(el);
    if (!m[4] && m[2] !== 'br') stack.push(el);
  }
  return root.children;
}

describe('rich text round trip: document, HTML, inline edit, document', () => {
  let dir: string;
  let RichTextView: Component<Record<string, unknown>>;

  beforeAll(async () => {
    mkdirSync(resolve('.tmp'), { recursive: true });
    dir = mkdtempSync(join(resolve('.tmp'), 'richtext-'));
    const build = (source: string, name: string) =>
      compile(source, { filename: `${name}.svelte`, generate: 'server', runes: true })
        .js.code.replace(/'\.\/Link\.svelte'|"\.\/Link\.svelte"/g, "'./Link.js'")
        .replace(/'\.\/Image\.svelte'|"\.\/Image\.svelte"/g, "'./Image.js'")
        .replace(/'\$app\/paths'|"\$app\/paths"/g, "'./paths.js'");
    writeFileSync(join(dir, 'paths.js'), 'export const resolve = (p) => p; export const asset = (p) => p;\n');
    writeFileSync(join(dir, 'Link.js'), build(LINK_SVELTE, 'Link'));
    writeFileSync(join(dir, 'Image.js'), build(IMAGE_SVELTE, 'Image'));
    writeFileSync(join(dir, 'RichText.js'), build(RICHTEXT_SVELTE, 'RichText'));
    RichTextView = (await import(/* @vite-ignore */ join(dir, 'RichText.js'))).default;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const s = fresh();
  const about = pageNamed(s, 'About');
  const html = (value: RichText) => render(RichTextView, { props: { value: resolveRichText(value, { state: s }), class: 'x' } }).body;
  /** The element's children, as the bridge's copy of the editable root would hold them. */
  const edited = (markup: string) => {
    const [rootEl] = domFromHtml(markup) as Array<Exclude<RichDomNode, string>>;
    return rootEl.children;
  };
  const roundTrip = (value: RichText) => {
    const out = blocksFromDom(edited(html(value)), s.pages);
    expect(out.droppedLinks).toBe(0);
    return out.blocks;
  };

  const everything = (): RichText =>
    normalizeRichText(
      [
        { type: 'h3', spans: [{ text: 'A heading with ' }, { text: 'emphasis', em: true }] },
        { type: 'h4', spans: [{ text: 'A smaller one' }] },
        { type: 'p', spans: [{ text: 'Plain, ' }, { text: 'bold', strong: true }, { text: ', ' }, { text: 'italic', em: true }, { text: ', ' }, { text: 'both', strong: true, em: true }, { text: ' & <tags> 2 * 3 **literal**.' }] },
        { type: 'p', spans: [{ text: 'Links: ' }, { text: 'page', link: { type: 'page', target: about.id } }, { text: ' ' }, { text: 'anchor', link: { type: 'page', target: about.id, anchor: 'team' } }, { text: ' ' }, { text: 'bold link', strong: true, link: { type: 'url', target: 'https://example.com/a?b=1&c=2', newTab: true } }, { text: ' ' }, { text: 'mail', link: { type: 'email', target: 'hi@example.com' } }, { text: ' ' }, { text: 'jump', link: { type: 'anchor', target: 'top' } }] },
        { type: 'blockquote', spans: [{ text: 'A quote' }] },
        { type: 'ul', items: [[{ text: 'Bullet' }], [{ text: 'With ' }, { text: 'bold', strong: true }]] },
        { type: 'p', spans: [{ text: 'Between lists' }] },
        { type: 'ol', items: [[{ text: 'First' }], [{ text: 'Second' }]] },
        { type: 'p', spans: [{ text: 'And then' }] },
        { type: 'check', items: [[{ text: 'Checked' }, { text: ' link', link: { type: 'page', target: about.id } }]] }
      ],
      s,
      'Body'
    );

  it('renders an article\'s section headings, and its pictures as figures with their captions (#395)', () => {
    const t = fresh();
    t.assets.assets.img_a = { id: 'img_a', name: 'Kiln', file: 'static/assets/img_a-1a2b3c4d.png', mime: 'image/png', bytes: 10, hash: 'h', kind: 'image', createdAt: '2026-01-01T00:00:00.000Z', width: 800, height: 600 };
    const value: RichText = [
      { type: 'h2', spans: [{ text: 'Firing' }] },
      { type: 'image', assetId: 'img_a', alt: 'The kiln at night', caption: 'Cone 6 & <hot>' },
      { type: 'image', assetId: 'img_a', alt: 'Unseen', decorative: true }
    ];
    const out = render(RichTextView, { props: { value: resolveRichText(value, { state: t }) } }).body.replace(/<!--[\s\S]*?-->/g, '');
    expect(out).toContain('<h2>Firing</h2>');
    expect(out).toMatch(/<figure class="so-rich__figure"><img[^>]*alt="The kiln at night"/);
    expect(out).toContain('<figcaption>Cone 6 &amp; &lt;hot></figcaption>');
    // A decorative picture is described as nothing, and has no caption to show.
    expect(out).toMatch(/<figure class="so-rich__figure"><img[^>]*alt=""[^>]*\/>\s*<\/figure>/);
  });

  it('renders clean semantic HTML', () => {
    const out = html(everything()).replace(/<!--[\s\S]*?-->/g, '');
    for (const tag of ['<h3>', '<h4>', '<p>', '<blockquote>', '<ol class="so-rich--number">', '<ul class="so-rich--bullet">', '<ul class="so-rich--check">', '<strong><em>both</em></strong>'])
      expect(out, tag).toContain(tag);
    expect(out).toContain('&lt;tags>');
    expect(out).toContain('href="/about/#team"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).not.toMatch(/data-so-/);
  });

  it('comes back unchanged, so opening and leaving an edit changes nothing', () => {
    const value = everything();
    expect(roundTrip(value)).toEqual(value);
  });

  it('keeps an edit to the words, with the marks and links around it', () => {
    const value = normalizeRichText(`Read **our** [story](${about.route}).`, s, 'Body');
    const dom = edited(html(value)) as Array<Exclude<RichDomNode, string>>;
    dom[0].children[0] = 'Now read ';
    const next = blocksFromDom(dom, s.pages).blocks;
    expect(next).toEqual([p('Now read ', { text: 'our', strong: true }, ' ', { text: 'story', link: { type: 'page', target: about.id } }, '.')]);
    expect(normalizeRichText(next, s, 'Body')).toEqual(next);
  });

  it('keeps a page link’s ID through a route change after an inline edit', () => {
    const state = structuredClone(s);
    const value = normalizeRichText(`[story](${about.route})`, state, 'Body');
    const back = blocksFromDom(edited(render(RichTextView, { props: { value: resolveRichText(value, { state }) } }).body), state.pages).blocks;
    const moved = applyOperations(state, [{ type: 'page.update', pageId: about.id, route: '/renamed/' }]).state;
    expect(resolveRichText(back, { state: moved })[0]).toEqual({ type: 'p', spans: [{ text: 'story', link: { href: '/renamed/' } }] });
  });

  it('renders a line break as <br> inside its block, and reads it back the same', () => {
    const value = normalizeRichText(
      [
        { type: 'p', spans: [{ text: 'Harbour Lane Studio\n12 Quay Street\nPort Town' }] },
        { type: 'p', spans: [{ text: 'A ' }, { text: 'bold\nbreak', strong: true, link: { type: 'url', target: 'https://example.com/' } }, { text: '\nB\n\n' }] },
        { type: 'p', spans: [{ text: 'a\nb', strong: true, em: true }, { text: '\nOne break at the end\n' }] },
        { type: 'ul', items: [[{ text: '\nOne' }], [{ text: 'Two\n' }]] }
      ],
      s,
      'Body'
    );
    const out = html(value).replace(/<!--[\s\S]*?-->/g, '');
    expect(out).toContain('<li>Two<br/><br/></li>');
    expect(out).toContain('<p>Harbour Lane Studio<br/>12 Quay Street<br/>Port Town</p>');
    expect(out).toContain('<strong>bold<br/>break</strong>');
    expect(out).toContain('<strong><em>a<br/>b</em></strong>');
    // A block that ends with a break shows the empty line after it: one more <br>, as a browser needs.
    expect(out).toContain('B<br/><br/><br/></p>');
    expect(out).toContain('end<br/><br/></p>');
    expect(out).toContain('<li><br/>One</li>');
    expect(out.match(/<p>/g)).toHaveLength(3);
    expect(roundTrip(value)).toEqual(value);
  });

  it('renders the older form code components may still pass, with the list as its root', () => {
    const markup = (props: Record<string, unknown>) => render(RichTextView, { props }).body.replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><').trim();
    // Selectors such as `.x > li` were written against this root.
    expect(markup({ paragraphs: ['With **bold**', 'Second'], list: 'check', class: 'x', id: 'f' })).toBe('<ul class="so-rich so-rich--check x" id="f"><li>With <strong>bold</strong></li><li>Second</li></ul>');
    expect(markup({ paragraphs: ['One'], list: 'bullet', class: 'x' })).toBe('<ul class="so-rich so-rich--bullet x"><li>One</li></ul>');
    // Paragraphs and items of the same kind of list keep that form; anything else shows as written.
    expect(markup({ value: [p('A'), { type: 'check', items: [[{ text: 'B' }]] }], list: 'check' })).toBe('<ul class="so-rich so-rich--check"><li>A</li><li>B</li></ul>');
    expect(markup({ value: [p('A'), { type: 'ul', items: [[{ text: 'B' }]] }], list: 'bullet' })).toBe('<ul class="so-rich so-rich--bullet"><li>A</li><li>B</li></ul>');
    expect(markup({ value: [{ type: 'h3', spans: [{ text: 'T' }] }, p('A')], list: 'check', class: 'x' })).toBe('<div class="so-rich x"><h3>T</h3><p>A</p></div>');
    expect(markup({ value: [{ type: 'ul', items: [[{ text: 'B' }]] }], list: 'check' })).toBe('<div class="so-rich"><ul class="so-rich--bullet"><li>B</li></ul></div>');
    expect(markup({ value: [], list: 'check', class: 'x' })).toBe('<ul class="so-rich so-rich--check x"></ul>');
    expect(markup({ paragraphs: ['One', '*Two*'], class: 'x' })).toBe('<div class="so-rich x"><p>One</p><p><em>Two</em></p></div>');
  });

  it('refuses an unsafe address that reaches the helper from a code component', () => {
    const spans = ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'vbscript:x', ' javascript:alert(1)'].map((href, i) => ({ text: `t${i} `, link: { href } }));
    const out = render(RichTextView, { props: { value: [{ type: 'p', spans: [...spans, { text: 'ok', link: { href: '/about/' } }] }] } }).body;
    expect(out).not.toMatch(/script:|data:|href=" /i);
    for (let i = 0; i < spans.length; i++) expect(out).toContain(`t${i} `);
    expect(out).toContain('href="/about/"');
  });

  it('keeps the helpers free of editor code', () => {
    for (const text of [RICHTEXT_SVELTE, LINK_SVELTE, IMAGE_SVELTE, UTIL_JS]) expect(text).not.toMatch(/data-so-|bridge|builderTest/);
  });
});
