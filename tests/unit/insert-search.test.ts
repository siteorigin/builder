import { describe, expect, it } from 'vitest';
import { catalogueEntries, CATEGORY_LABELS } from '@catalogue/index';
import { BASICS, basicHay, basicSpec, searchItems } from '../../src/renderer/src/lib/insert-search';

/** What the Insert panel searches: every section of the starter theme (as it reads them), then the basic elements. */
const offered = () => [
  ...catalogueEntries('foundation').map((e) => ({ name: e.name, hay: `${e.name} ${e.description} ${e.tags.join(' ')} ${CATEGORY_LABELS[e.category] ?? e.category} section`.toLowerCase(), spec: { componentId: e.componentId } })),
  ...BASICS.map((b) => ({ name: b.name, hay: basicHay(b), spec: basicSpec(b) }))
];

describe('finding lists in Insert', () => {
  it('finds both kinds of list for "list", and the one named first for its own name', () => {
    const names = (q: string) => searchItems(offered(), q).map((it) => it.name);
    expect(names('list')).toEqual(expect.arrayContaining(['Bulleted list', 'Numbered list']));
    expect(names('bulleted list')[0]).toBe('Bulleted list');
    expect(names('numbered list')[0]).toBe('Numbered list');
    expect(names('Bulleted List')[0]).toBe('Bulleted list');
    expect(names('ordered')).toContain('Numbered list');
    expect(names('bullet points')).toContain('Bulleted list');
    expect(searchItems(offered(), '  ')).toEqual([]);
  });

  it('adds rich text that starts as a list of each kind', () => {
    const spec = (name: string) => basicSpec(BASICS.find((b) => b.name === name)!);
    expect(spec('Bulleted list')).toEqual({ primitive: 'richtext', text: '- First item\n- Second item\n- Third item' });
    expect(spec('Numbered list')).toEqual({ primitive: 'richtext', text: '1. First step\n2. Second step\n3. Third step' });
    expect(spec('Heading')).toEqual({ primitive: 'heading' });
  });
});
