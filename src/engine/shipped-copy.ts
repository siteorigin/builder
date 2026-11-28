/**
 * The copy and pictures of the sections Foundation ships (#1344), which a live session's Copy Editor may change. The
 * sections are code, so nothing in a design shows what their properties do; the release marks none `copyEditable`
 * either. Builder vouches for its own release instead: these are the top-level properties each section's markup shows
 * only as the words of a text element, or as an `SoImage` picture or `SoRichText` text, and otherwise only tests
 * whether they are set. Never a button or link label, a heading level, an accessible name, a list's rows, or a
 * setting. tests/unit/shipped-copy.test.ts reads each committed release's Svelte source to hold the list to that.
 *
 * It grants nothing to a definition that is not exactly the bundled one (shippedAsIs): a copy made unique, one from an
 * installed pack, or one changed from what the app ships, decides in its own code what it does with its properties.
 */
import type { ComponentDefinition } from '@shared/types';
import { findTheme } from '@catalogue/index';

/** The packs these grants are for: Foundation, and its development fixture, which ships the same sections. */
const PACKS = ['foundation', 'foundation-alt'];

const INTRO = ['eyebrow', 'heading', 'lead'] as const;

/** By component ID, the properties each section shows as copy. The shared header and footer are not a page's. */
export const SHIPPED_COPY: Readonly<Record<string, readonly string[]>> = {
  'hero.centered': [...INTRO, 'note'],
  'hero.split': [...INTRO, 'image'],
  'hero.screenshot': [...INTRO, 'frameTitle', 'caption', 'image'],
  'intro.page': INTRO,
  'content.article': ['eyebrow'],
  'logos.strip': ['heading'],
  'features.grid': INTRO,
  'features.bento': INTRO,
  'features.alternating': INTRO,
  'content.media': ['eyebrow', 'heading', 'body', 'image'],
  'content.text': ['eyebrow', 'heading', 'body'],
  // Their headings also name the tabs and the slides for screen readers.
  'tabs.showcase': ['eyebrow', 'lead'],
  'media.carousel': ['eyebrow', 'lead'],
  'content.steps-media': INTRO,
  'content.steps': INTRO,
  'stats.row': [...INTRO, 'note'],
  'testimonials.grid': INTRO,
  'team.grid': INTRO,
  'pricing.plans': INTRO,
  'pricing.toggle': INTRO,
  'pricing.compare': [...INTRO, 'note'],
  'faq.list': INTRO,
  'content.pages': INTRO,
  'content.news': INTRO,
  'blog.featured': INTRO,
  'blog.grid': INTRO,
  'blog.list': INTRO,
  'media.gallery': INTRO,
  'media.video': INTRO,
  'cta.banner': INTRO,
  'contact.details': INTRO,
  // Their headings name the form and the search for screen readers (`aria-labelledby`).
  'contact.form': ['eyebrow', 'lead'],
  'site.search': ['eyebrow', 'lead'],
  'block.feature': ['title', 'badge', 'description', 'image'],
  'block.stat': ['value', 'unit', 'label', 'footnote'],
  'block.testimonial': ['quote', 'name', 'role', 'initials', 'disclosure', 'portrait'],
  'block.callout': ['eyebrow', 'heading', 'text'],
  'block.video': ['caption'],
  'block.download': ['heading'],
  'block.facts': ['heading']
};

/** The bundled definition `def` claims to be, when it is one of these packs' code. */
function bundled(def: ComponentDefinition): ComponentDefinition | undefined {
  const pack = def.provenance?.pack;
  if (def.kind !== 'code' || def.owner !== 'theme' || !pack || !PACKS.includes(pack)) return undefined;
  const theme = findTheme(pack);
  if (theme?.source !== 'bundled') return undefined;
  return theme.components.find((c) => c.id === def.id && c.componentId === def.componentId);
}

const shippedJson = new WeakMap<ComponentDefinition, string>();

/**
 * Whether `def` is exactly a definition the app bundles in one of these packs, as installing it copies it into a
 * project: its code, properties and everything else. Its provenance alone is only what the project says of it.
 */
export function shippedAsIs(def: ComponentDefinition): boolean {
  const shipped = bundled(def);
  if (!shipped) return false;
  if (shipped === def) return true;
  let json = shippedJson.get(shipped);
  if (json === undefined) shippedJson.set(shipped, (json = JSON.stringify(shipped)));
  return JSON.stringify(def) === json;
}

/**
 * An editor marker attribute in a code component's markup (shared/code-markers.ts), with the space before it, as the
 * exports take it out (withoutCodeMarkers, src/main/codecheck.ts). Read only from a bundled definition's own code, whose
 * markers are all written this way: tests/unit/shipped-copy.test.ts holds every one to what the exports leave.
 */
export const MARKER_ATTRIBUTE = /\s*\bdata-so-(?:part|text)\s*=\s*(?:"[^"]*"|'[^']*'|\{[^{}]*\})/gi;
const shippedUnmarked = new WeakMap<ComponentDefinition, string>();

/**
 * Whether `def` renders exactly as a definition the app bundles: it is that definition (shippedAsIs), or that
 * definition with the editor's markers taken out of its code and nothing else changed, as a publication carries it
 * (src/main/publication.ts), which shows visitors the same. For reading what a section shows visitors; what the editor
 * may do with one still needs shippedAsIs.
 */
export function rendersAsShipped(def: ComponentDefinition): boolean {
  if (shippedAsIs(def)) return true;
  const shipped = bundled(def);
  if (!shipped || typeof shipped.source !== 'string') return false;
  let json = shippedUnmarked.get(shipped);
  if (json === undefined) shippedUnmarked.set(shipped, (json = JSON.stringify({ ...shipped, source: shipped.source.replace(MARKER_ATTRIBUTE, '') })));
  return JSON.stringify(def) === json;
}

/** Whether Builder vouches for `prop` of `def` as copy; the definition must still be checked to be as shipped. */
export function shippedCopyListed(def: ComponentDefinition, prop: string): boolean {
  const props = Object.hasOwn(SHIPPED_COPY, def.componentId) ? SHIPPED_COPY[def.componentId] : undefined;
  return !!props?.includes(prop);
}
