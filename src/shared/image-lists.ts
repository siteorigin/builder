// The lists that take several library images at once: a Gallery's images and a Carousel's slides. The Inspector
// offers to choose them from Assets in one pass (renderer/lib/gallery-picks), and the editor's preview shows where they
// will go while the list is empty (generator/index.ts). Shared, so both agree on which lists those are.
import type { ComponentDefinition, PropSchema } from './types';

/** The lists that take several library images at once, by component: the list and the item field the image goes in.
 *  Only a Gallery's and a Carousel's: a team member, testimonial or logo needs more than a picture to be worth a row. */
const PICK_MANY: Record<string, { prop: string; field: string }> = { 'media.gallery': { prop: 'images', field: 'image' }, 'media.carousel': { prop: 'slides', field: 'image' } };

/** The item field chosen images go in, for a list that takes several at once; otherwise null. A component made
 *  unique from a Gallery keeps the action while its list still holds images. */
export function pickImagesField(def: Pick<ComponentDefinition, 'componentId' | 'provenance'> | null | undefined, prop: string, schema: PropSchema | undefined): string | null {
  const from = def ? [def.componentId, def.provenance?.componentId] : [];
  const at = from.map((id) => (id && Object.hasOwn(PICK_MANY, id) ? PICK_MANY[id] : undefined)).find(Boolean);
  if (!at || at.prop !== prop || schema?.type !== 'list') return null;
  return schema.fields[at.field]?.type === 'image' ? at.field : null;
}
