import { describe, expect, it } from 'vitest';
import type { ComponentDefinition } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { catalogueComponent, catalogueEntries } from '@catalogue/index';
import { generateComponentPreview } from '@generator/preview';
import { PREVIEW_MODULE } from '@shared/component-preview';
import { studioSampleProps } from '../../src/renderer/src/lib/studio-samples';

const starter = () => createStarterState('blank', 'Studio Samples', false);

describe('Component Studio sample content', () => {
  it('previews with the starting content when asked for it', () => {
    const def = catalogueComponent(starter().site.themeId, 'content.media')!;
    expect(studioSampleProps(def, 'defaults')).toBeUndefined();
  });

  it('makes text longer and lists fuller within their limits, and never changes the definition', () => {
    const def: ComponentDefinition = {
      ...catalogueComponent(starter().site.themeId, 'content.media')!,
      properties: {
        title: { type: 'string', label: 'Title', default: 'Short', maxLength: 60 },
        body: { type: 'richtext', label: 'Body', default: [{ type: 'p', spans: [{ text: 'One line.' }] }] },
        count: { type: 'number', label: 'Count', default: 3 },
        items: { type: 'list', label: 'Items', itemLabel: 'Item', max: 4, fields: { label: { type: 'string', label: 'Label', default: '' } }, default: [{ id: 'a', label: 'A' }] }
      }
    };
    const before = JSON.stringify(def);
    const long = studioSampleProps(def, 'long')!;
    expect(JSON.stringify(def)).toBe(before);
    expect(typeof long.title).toBe('string');
    expect((long.title as string).length).toBeLessThanOrEqual(60);
    expect((long.title as string).startsWith('Short ')).toBe(true);
    expect(JSON.stringify(long.body).length).toBeGreaterThan(JSON.stringify(def.properties.body.default).length);
    // Numbers have no "long" form and keep their starting value.
    expect(long).not.toHaveProperty('count');
    const items = long.items as Array<{ id: string; label: string }>;
    expect(items.length).toBeGreaterThan(1);
    expect(items.length).toBeLessThanOrEqual(4);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(items[0].id).toBe('a');
    expect(items[0].label.startsWith('A ')).toBe(true);
  });

  it('empties text, rich text and images and keeps a list to its fewest items', () => {
    const def: ComponentDefinition = {
      ...catalogueComponent(starter().site.themeId, 'content.media')!,
      properties: {
        title: { type: 'string', label: 'Title', default: 'Short' },
        body: { type: 'richtext', label: 'Body', default: [{ type: 'p', spans: [{ text: 'One line.' }] }] },
        photo: { type: 'image', label: 'Photo', default: { assetId: 'img_1', alt: 'A photo' } },
        items: { type: 'list', label: 'Items', itemLabel: 'Item', min: 1, fields: { label: { type: 'string', label: 'Label', default: '' } }, default: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }
      }
    };
    expect(studioSampleProps(def, 'empty')).toEqual({ title: '', body: [], photo: { assetId: null, alt: '' }, items: [{ id: 'a', label: '' }] });
  });

  it('makes rich text a hand-edited document stores as plain strings longer, without failing on it', () => {
    const def: ComponentDefinition = {
      ...catalogueComponent(starter().site.themeId, 'content.media')!,
      properties: { body: { type: 'richtext', label: 'Body', default: ['Intro'] as unknown as [] } }
    };
    const long = studioSampleProps(def, 'long')!;
    const text = JSON.stringify(long.body);
    expect(text).toContain('Intro');
    expect(text).toContain('longer sample line');
  });

  it('clears a link, so what shows only with one is seen without it', () => {
    const def: ComponentDefinition = {
      ...catalogueComponent(starter().site.themeId, 'content.media')!,
      properties: { booking: { type: 'link', label: 'Booking', default: { type: 'url', target: 'https://example.com' } } }
    };
    expect(studioSampleProps(def, 'empty')).toEqual({ booking: { type: 'none', target: '' } });
    expect(studioSampleProps(def, 'long')).toBeUndefined();
  });

  it('keeps rich text at its starting value when a longer one would pass the limit', () => {
    const long = 'x'.repeat(19990);
    const def: ComponentDefinition = {
      ...catalogueComponent(starter().site.themeId, 'content.media')!,
      properties: { body: { type: 'richtext', label: 'Body', default: [{ type: 'p', spans: [{ text: long }] }] }, title: { type: 'string', label: 'Title', default: 'T' } }
    };
    const props = studioSampleProps(def, 'long')!;
    expect(props).not.toHaveProperty('body');
    expect(props.title).toMatch(/^T /);
    // At the most blocks rich text takes, one more paragraph would pass it too.
    const blocks = Array.from({ length: 500 }, () => ({ type: 'p' as const, spans: [{ text: 'a' }] }));
    expect(studioSampleProps({ ...def, properties: { body: { type: 'richtext', label: 'Body', default: blocks } } }, 'long')).toBeUndefined();
    // Inside a list's items or an object, the whole property keeps its starting value: the preview checks a sample afresh.
    const over = [{ type: 'p' as const, spans: [{ text: 'y'.repeat(20001) }] }];
    const nested: ComponentDefinition = {
      ...def,
      properties: {
        rows: { type: 'list', label: 'Rows', itemLabel: 'Row', fields: { text: { type: 'richtext', label: 'Text', default: [] } }, default: [{ id: 'r1', text: over }] },
        card: { type: 'object', label: 'Card', fields: { text: { type: 'richtext', label: 'Text', default: [] } }, default: { text: over } },
        title: { type: 'string', label: 'Title', default: 'T' }
      }
    };
    expect(Object.keys(studioSampleProps(nested, 'long')!)).toEqual(['title']);
  });

  it('keeps a form’s field names, and leaves the fields it adds without, so no two share one', () => {
    const state = starter();
    const def = catalogueComponent(state.site.themeId, 'contact.form')!;
    const starting = def.properties.fields.default as Array<{ id: string; name: string }>;
    const fields = studioSampleProps(def, 'long')!.fields as Array<{ id: string; name: string; label: string }>;
    expect(fields.length).toBeGreaterThan(starting.length);
    expect(fields.slice(0, starting.length).map((f) => f.name)).toEqual(starting.map((f) => f.name));
    expect(fields.slice(starting.length).every((f) => f.name === '')).toBe(true);
    // The preview names the added fields after their labels, each its own.
    const out = generateComponentPreview(state, { componentId: 'contact.form', props: { fields } });
    if ('error' in out) throw new Error(out.error);
    const module = out.files.get(PREVIEW_MODULE)!;
    const names = [...module.matchAll(/"name":"([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
    expect(names.length).toBeGreaterThanOrEqual(fields.length);
    expect(new Set(names.slice(0, fields.length)).size).toBe(fields.length);
    const empty = studioSampleProps(def, 'empty')!.fields as Array<{ name: string }> | undefined;
    for (const f of empty ?? []) expect(starting.map((s) => s.name)).toContain(f.name);
  });

  // Every component the theme offers can be studied with each sample: the preview accepts what the studio sends.
  for (const sample of ['long', 'empty'] as const) {
    it(`previews every theme component with ${sample} samples`, () => {
      const state = starter();
      for (const entry of catalogueEntries(state.site.themeId)) {
        const def = catalogueComponent(state.site.themeId, entry.componentId)!;
        const props = studioSampleProps(def, sample);
        const out = generateComponentPreview(state, { componentId: entry.componentId, ...(props ? { props } : {}) });
        expect('error' in out ? `${entry.componentId}: ${out.error}` : null).toBeNull();
      }
    });
  }
});
