import { describe, expect, it } from 'vitest';
import type { ComponentDefinition } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { catalogueComponent, catalogueEntries } from '@catalogue/index';
import { generateComponentPreview } from '@generator/preview';
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
