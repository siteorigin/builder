/** Keyword retrieval over the theme's worked examples (ai-profile), checked against the real catalogue. */
import type { ComponentDefinition, ProjectState } from '@shared/types';
import { catalogueComponent, getTheme } from '@catalogue/index';
import type { AiExample } from '@catalogue/foundation/ai-examples';
import { declaredTokens } from '@engine/tokens';
import { checkProps, chooseVariants, focusedListing, type FieldIssue } from './macros';
import type { ManagedComponentArgs } from './managed-component';
import { hasCollections, listsEntries } from '@shared/entry-feed';

/**
 * Problems an example has against the component contract a section would be checked against: the project's installed
 * copy when it has one (it may predate the theme's current version), otherwise the theme's.
 */
export function checkExample(state: ProjectState, ex: AiExample, focused = false): FieldIssue[] {
  const themed: ComponentDefinition | undefined = catalogueComponent(state.site.themeId, ex.componentId);
  const installed = themed && Object.hasOwn(state.components, themed.id) ? state.components[themed.id] : themed;
  // A small model's page tool may leave the section, or the option the example picks, out (focusedListing).
  const def = installed && focused ? focusedListing(state, installed) : installed;
  if (!def || def.category === 'shell') return [{ field: 'componentId', message: `unknown component "${ex.componentId}"` }];
  // An example is a ready-to-send page section; a block goes inside one.
  if (themed?.insertAs === 'element') return [{ field: 'componentId', message: `"${ex.componentId}" is a block, not a section` }];
  const issues: FieldIssue[] = [];
  chooseVariants(def, ex.variant, ex.variants, '', issues);
  checkProps(def, ex.props, state, 'props', issues);
  return issues;
}

const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/** The most relevant valid examples for a request, at most one per component; `focused` keeps those a small model's page tool can send. */
export function retrieveExamples(state: ProjectState, request: string, limit = 3, focused = false): AiExample[] {
  const asked = words(request);
  return (getTheme(state.site.themeId).aiProfile.examples ?? [])
    .map((ex, order) => ({ ex, order, score: ex.keywords.reduce((n, k) => n + (asked.has(k) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .filter((x, i, all) => all.findIndex((y) => y.ex.componentId === x.ex.componentId) === i)
    .filter((x) => !checkExample(state, x.ex, focused).length)
    // A section that lists posts is suggested once the project has a collection, as the page tool offers it.
    .filter((x) => hasCollections(state) || !listsEntries(catalogueComponent(state.site.themeId, x.ex.componentId) ?? { properties: {} }))
    .slice(0, limit)
    .map((x) => x.ex);
}

/** The examples of one component, for its read_component result. */
export function examplesFor(state: ProjectState, componentId: string | undefined): AiExample[] {
  if (!componentId) return [];
  return (getTheme(state.site.themeId).aiProfile.examples ?? []).filter((ex) => ex.componentId === componentId && !checkExample(state, ex).length);
}

/** The compact form shown to the model: a ready-to-send section. */
export function exampleSection(ex: AiExample) {
  // One choice is a variant, which every component's tool schema takes; variants is offered where there are several axes.
  // "default" is on most axes and means the first, so it keeps its axis.
  const picks = Object.entries(ex.variants ?? {});
  const one = picks.length === 1 && picks[0][1] !== 'default' && ex.variant === undefined;
  const variant = ex.variant ?? (one ? picks[0][1] : undefined);
  return { for: ex.description, section: { componentId: ex.componentId, ...(variant ? { variant } : {}), ...(picks.length && !one ? { variants: ex.variants } : {}), props: ex.props } };
}

// ---------------------------------------------------------------------------
// Component blueprints (#359)
// ---------------------------------------------------------------------------

/**
 * A worked upsert_managed_component call: arguments that build a good managed component as they are, showing the
 * conventions a small model gets wrong on its own (a section shell and a content-width container, site tokens, a list
 * property shown by a repeat with `$item` bindings, parts, phone/tablet/desktop rules and a variant that restyles
 * nodes).
 */
export interface ComponentBlueprint {
  id: string;
  /** Words in a request that make this blueprint relevant. */
  keywords: string[];
  description: string;
  args: Omit<ManagedComponentArgs, 'definitionId' | 'placeOnPage' | 'repair'>;
}

const t = (token: string) => ({ token });
/** A variant option's style rule for one node. */
type OptionStyle = { nodeId: string; property: string; value: string | number | boolean | { token: string } };
/** The section shell every theme section has: page padding, its background, and a centred content-width container. */
const shellRoot = [
  { property: 'paddingBlock', value: t('space.section') },
  { property: 'paddingInline', value: t('container.gutter') },
  { property: 'background', value: t('color.background') },
  { property: 'color', value: t('color.text') }
];
const shellInner = [
  { property: 'layout', value: 'stack' },
  { property: 'gap', value: t('space.2xl') },
  { property: 'width', value: 'fill' },
  { property: 'maxWidth', value: t('container.content') },
  { property: 'marginInline', value: 'auto' }
];
/** A tone axis whose options restyle the root: an option without rules would change nothing. */
const toneAxis = (dark: OptionStyle[]) => ({
  name: 'tone',
  label: 'Tone',
  options: [
    { id: 'default', label: 'Default' },
    { id: 'muted', label: 'Soft background', styles: [{ nodeId: 'root', property: 'background', value: t('color.surface-alt') }] },
    { id: 'inverse', label: 'Dark', styles: [{ nodeId: 'root', property: 'background', value: t('color.inverse') }, { nodeId: 'root', property: 'color', value: t('color.on-inverse') }, ...dark] }
  ]
});

export const COMPONENT_BLUEPRINTS: ComponentBlueprint[] = [
  {
    id: 'card-grid',
    keywords: ['card', 'cards', 'grid', 'list', 'items', 'services', 'features', 'benefits', 'team', 'steps', 'repeated', 'tiles', 'plans', 'pricing'],
    description: 'A heading over a responsive grid of repeated cards (a list property shown by a repeat), with a card part and a tone variant',
    args: {
      name: 'Feature cards',
      description: 'A heading over a grid of cards, each with an icon, a title and a short text.',
      category: 'content',
      properties: [
        { type: 'string', name: 'heading', label: 'Heading', default: 'What we offer' },
        // The heading's place in the page outline, chosen per placement, as the theme's sections do.
        { type: 'enum', name: 'headingLevel', label: 'Heading level', options: [{ value: 'h2', label: 'Heading 2' }, { value: 'h3', label: 'Heading 3' }], default: 'h2' },
        {
          type: 'list',
          name: 'cards',
          label: 'Cards',
          itemLabel: 'Card',
          titleField: 'title',
          fields: [
            { type: 'icon', name: 'icon', label: 'Icon', default: 'sparkles' },
            { type: 'string', name: 'title', label: 'Title', default: 'Card title' },
            { type: 'string', name: 'text', label: 'Text', default: '', multiline: true }
          ],
          default: [
            { values: [{ field: 'icon', value: 'leaf' }, { field: 'title', value: 'Garden care' }, { field: 'text', value: 'Weekly visits for beds, lawns and hedges.' }] },
            { values: [{ field: 'icon', value: 'compass' }, { field: 'title', value: 'Design' }, { field: 'text', value: 'A planting plan drawn for your site.' }] }
          ]
        }
      ],
      nodes: [
        { kind: 'element', id: 'root', tag: 'section', children: ['inner'], styles: shellRoot },
        { kind: 'element', id: 'inner', children: ['heading', 'grid'], styles: shellInner },
        { kind: 'text', id: 'heading', tag: { $prop: 'headingLevel' }, text: { $prop: 'heading' }, when: { $prop: 'heading' }, styles: [{ property: 'textStyle', value: t('text.h2') }] },
        {
          kind: 'element',
          id: 'grid',
          tag: 'ul',
          children: ['cards'],
          styles: [
            { property: 'layout', value: 'grid' },
            { property: 'columns', value: 1 },
            { property: 'gap', value: t('space.lg') },
            { property: 'columns', value: 2, scope: 'tablet' },
            { property: 'columns', value: 3, scope: 'desktop' }
          ]
        },
        { kind: 'repeat', id: 'cards', list: 'cards', children: ['card'] },
        {
          kind: 'element',
          id: 'card',
          tag: 'li',
          children: ['icon', 'title', 'text'],
          styles: [
            { property: 'layout', value: 'stack' },
            { property: 'gap', value: t('space.sm') },
            { property: 'paddingBlock', value: t('space.xl') },
            { property: 'paddingInline', value: t('space.xl') },
            { property: 'background', value: t('color.surface') },
            { property: 'color', value: t('color.text') },
            { property: 'border', value: t('border.default') },
            { property: 'radius', value: t('radius.lg') }
          ]
        },
        { kind: 'icon', id: 'icon', icon: { $item: 'icon' }, styles: [{ property: 'color', value: t('color.brand') }] },
        { kind: 'text', id: 'title', tag: 'h3', text: { $item: 'title' }, styles: [{ property: 'textStyle', value: t('text.h3') }] },
        { kind: 'text', id: 'text', tag: 'p', text: { $item: 'text' }, when: { $item: 'text' }, styles: [{ property: 'color', value: t('color.muted') }] }
      ],
      parts: [
        { id: 'heading', nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
        { id: 'card', nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius', 'shadow'] }
      ],
      variantAxes: [toneAxis([])]
    }
  },
  {
    id: 'callout',
    keywords: ['callout', 'banner', 'cta', 'call', 'action', 'notice', 'announcement', 'promo', 'promotion', 'offer', 'signup', 'newsletter', 'booking', 'contact'],
    description: 'A call to action: a heading, rich text and a button shown only when it has both a label and a link, side by side from tablet up, with a dark tone',
    args: {
      name: 'Call to action',
      description: 'A short message with one button.',
      category: 'conversion',
      properties: [
        { type: 'string', name: 'heading', label: 'Heading', default: 'Ready when you are' },
        { type: 'richtext', name: 'text', label: 'Text', default: 'Tell us what you need and we will reply within a day.' },
        { type: 'string', name: 'buttonLabel', label: 'Button text', default: 'Get in touch' },
        { type: 'link', name: 'buttonLink', label: 'Button link', description: 'The button shows once it has both a link and a label.', default: '' }
      ],
      nodes: [
        { kind: 'element', id: 'root', tag: 'section', children: ['inner'], styles: shellRoot },
        {
          kind: 'element',
          id: 'inner',
          children: ['copy', 'button'],
          styles: [...shellInner.filter((s) => s.property !== 'layout' && s.property !== 'gap'), { property: 'layout', value: 'stack' }, { property: 'gap', value: t('space.lg') }, { property: 'layout', value: 'row', scope: 'tablet' }, { property: 'justify', value: 'space-between', scope: 'tablet' }, { property: 'align', value: 'center', scope: 'tablet' }]
        },
        { kind: 'element', id: 'copy', children: ['heading', 'text'], styles: [{ property: 'layout', value: 'stack' }, { property: 'gap', value: t('space.sm') }] },
        { kind: 'text', id: 'heading', tag: 'h2', text: { $prop: 'heading' }, styles: [{ property: 'textStyle', value: t('text.h2') }] },
        { kind: 'text', id: 'text', rich: true, text: { $prop: 'text' }, when: { $prop: 'text' } },
        // Shown only with both a link and a label: an unlinked button would be hidden from visitors anyway.
        { kind: 'link', id: 'button', link: { $prop: 'buttonLink' }, label: { $prop: 'buttonLabel' }, appearance: 'primary', when: { $prop: 'buttonLink' }, unless: { ref: { $prop: 'buttonLabel' }, eq: '' } }
      ],
      parts: [
        { id: 'heading', nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
        { id: 'button', nodeId: 'button', label: 'Button' }
      ],
      variantAxes: [toneAxis([{ nodeId: 'heading', property: 'color', value: t('color.on-inverse') }])]
    }
  }
];

/** Every token a blueprint styles with. */
const blueprintTokens = (b: ComponentBlueprint): string[] => [...JSON.stringify(b.args).matchAll(/\{"token":"([^"]+)"\}/g)].map((m) => m[1]);

/**
 * The blueprints worth showing for a component request: the one or two whose keywords it uses, best first, or the first
 * one when it uses none, so a model always has one worked call to follow. Only blueprints whose every token the site
 * has are offered.
 */
export function retrieveBlueprints(state: ProjectState, request: string, limit = 2): ComponentBlueprint[] {
  const asked = words(request);
  const tokens = new Set(declaredTokens(state).map((tk) => tk.id));
  const usable = COMPONENT_BLUEPRINTS.filter((b) => blueprintTokens(b).every((id) => tokens.has(id)));
  const scored = usable
    .map((b, order) => ({ b, order, score: b.keywords.reduce((n, k) => n + (asked.has(k) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((x) => x.b);
  return scored.length ? scored : usable.slice(0, 1);
}

/** The compact form shown to the model: what it builds, and the call that builds it. */
export const blueprintSection = (b: ComponentBlueprint) => ({ for: b.description, upsert_managed_component: b.args });
