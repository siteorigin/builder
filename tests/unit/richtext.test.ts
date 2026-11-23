import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { ComponentDefinition, InstanceNode, ProjectState, RichText } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import { definitionHash as migrateHash, migrateProject } from '@shared/migrations';
import { cleanBlocks, richTextToMarkdown, richTextToParagraphs, richTextToPlain, toRichText } from '@shared/richtext';
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
    const page = generateProject(r.state).get('src/routes/+page.svelte')!;
    expect(page).toContain('<SoRichText value={');
    expect(page).toContain('"href":"/about/"');
    expect(page).not.toContain(about.id);
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
    const code = (s: ProjectState, source: string) => {
      const r = applyOperations(s, [{ type: 'component.createCode', name: 'Note', source, properties: { body: { type: 'richtext', label: 'Body', default: 'Default **text**' } } }]);
      const defId = r.results[0].definitionId as string;
      const node = makeInstance(r.state.components[defId], { body: normalizeRichText('A **b** [c](https://example.com/)', r.state, 'Body') });
      const page = r.state.pages[r.state.site.homePageId];
      page.nodes[node.id] = node;
      page.rootIds.push(node.id);
      return r.state;
    };

    it('passes paragraph strings to a component written for them', () => {
      const out = generateProject(code(fresh(), `<script>let { body = [] } = $props();</script>{#each body as line}<p>{line}</p>{/each}`)).get('src/routes/+page.svelte')!;
      expect(out).toContain('body={["A **b** c"]}');
    });

    it('passes blocks to a component that renders through the helper', () => {
      const source = `<script>import SoRichText from '$lib/siteorigin/runtime/RichText.svelte'; let { body = [] } = $props();</script><SoRichText value={body} />`;
      const out = generateProject(code(fresh(), source)).get('src/routes/+page.svelte')!;
      expect(out).toContain('"href":"https://example.com/"');
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
    current.nodes[node.id] = node;
    current.rootIds.push(node.id);
    const out = migrateProject(s)!.state;
    expect((out.pages[current.id].nodes[node.id] as InstanceNode).props.body).toEqual(value);
    expect((out.pages[page.id].nodes[textId] as InstanceNode).props.body).toEqual(expect.arrayContaining([p('Plain')]));
  });

  it('keeps bound values and a definition already in the new format', () => {
    const { s } = oldProject();
    const def = s.components['foundation.content.text'];
    def.schemaVersion = SCHEMA_VERSION;
    const blocks = [p('New default')];
    (def.properties.body as { default: unknown }).default = blocks;
    const bound = makeInstance(def, { body: { $prop: 'text' } });
    const wrapper = structuredClone(s.components['foundation.pricing.plans']);
    wrapper.id = 'project.wrap';
    wrapper.tree = { rootIds: [bound.id], nodes: { [bound.id]: bound } };
    s.components[wrapper.id] = wrapper;
    const out = migrateProject(s)!.state;
    expect((out.components['foundation.content.text'].properties.body as { default: unknown }).default).toEqual(blocks);
    expect((out.components['project.wrap'].tree!.nodes[bound.id] as InstanceNode).props.body).toEqual({ $prop: 'text' });
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
        .replace(/'\$app\/paths'|"\$app\/paths"/g, "'./paths.js'");
    writeFileSync(join(dir, 'paths.js'), 'export const resolve = (p) => p; export const asset = (p) => p;\n');
    writeFileSync(join(dir, 'Link.js'), build(LINK_SVELTE, 'Link'));
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

  it('renders the older form code components may still pass', () => {
    const out = render(RichTextView, { props: { paragraphs: ['With **bold**', 'Second'], list: 'check' } }).body.replace(/<!--[\s\S]*?-->/g, '');
    expect(out).toContain('<ul class="so-rich--check">');
    expect(out).toContain('<strong>bold</strong>');
  });

  it('keeps the helpers free of editor code', () => {
    for (const text of [RICHTEXT_SVELTE, LINK_SVELTE, IMAGE_SVELTE, UTIL_JS]) expect(text).not.toMatch(/data-so-|bridge|builderTest/);
  });
});
