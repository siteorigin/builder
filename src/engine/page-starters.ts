import type { ComponentDefinition, InstanceNode, PageDoc, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { catalogueComponent } from '@catalogue/index';
import { installComponent, makeInstance } from './install';
import { fillBusinessDetails } from './business-details';
import { normalizeProp } from './values';

/** What a new page starts with (page.create's `starter`): "empty" is a blank page. */
export type PageStarter = NonNullable<Extract<EditOperation, { type: 'page.create' }>['starter']>;

/**
 * One section of a page starter: a theme component, the variant it takes when the theme has it, and the few texts
 * that make it fit the page. Everything else (its cards, questions, plans, contact rows) is the theme's own sample
 * content, the same the section has when it is placed from Insert.
 */
interface StarterSection {
  componentId: string;
  variant?: string;
  props?: (title: string) => Record<string, unknown>;
  /** Of those texts, the ones the section must take: a theme whose version cannot take one makes the page without it. */
  required?: string[];
  /** Runs on the placed section, to finish what the theme's sample content leaves unset. */
  settle?: (state: ProjectState, page: PageDoc, node: InstanceNode) => void;
}

/**
 * The theme's sample plans carry buttons with no destination, and a new page must add no health warnings: each
 * button goes to the Contact page when the project has one, and is left off the plan when it does not.
 */
function linkPlanActions(state: ProjectState, page: PageDoc, node: InstanceNode): void {
  const contact = Object.values(state.pages).find((p) => p.id !== page.id && p.route === '/contact/' && !p.draft);
  const plans = node.props.plans;
  if (!Array.isArray(plans)) return;
  for (const plan of plans as Array<Record<string, unknown>>) {
    if (!plan || typeof plan !== 'object' || !String(plan.actionLabel ?? '').trim()) continue;
    const link = plan.actionLink as { type?: string; target?: string } | undefined;
    if (link && link.type && link.type !== 'none') continue;
    if (contact) plan.actionLink = { type: 'page', target: contact.id };
    else plan.actionLabel = '';
  }
}

const intro: StarterSection = { componentId: 'intro.page', props: (title) => ({ eyebrow: '', heading: title, lead: '' }) };

/** The sections each starter places, top to bottom. A theme without one of them makes the page without it. */
export const PAGE_STARTER_SECTIONS: Record<PageStarter, StarterSection[]> = {
  empty: [],
  intro: [intro],
  services: [intro, { componentId: 'features.grid' }, { componentId: 'content.text', variant: 'muted' }],
  about: [intro, { componentId: 'content.media', variant: 'media-end', props: () => ({ eyebrow: 'Our story', actionLabel: '' }) }, { componentId: 'team.grid', variant: 'muted' }],
  // The form is not connected to any form service until the author connects it, whatever a theme's own default is.
  contact: [intro, { componentId: 'contact.details', props: () => ({ eyebrow: '' }) }, { componentId: 'contact.form', variant: 'muted', props: () => ({ eyebrow: '', endpoint: '', accessKey: '' }), required: ['endpoint', 'accessKey'] }],
  pricing: [intro, { componentId: 'pricing.plans', props: () => ({ eyebrow: '' }), settle: linkPlanActions }, { componentId: 'faq.list', variant: 'muted', props: () => ({ eyebrow: '', heading: 'Questions about pricing' }) }],
  faq: [intro, { componentId: 'faq.list', props: () => ({ eyebrow: '' }) }],
  // The header shows the page's own title, date, byline and excerpt; the text section below is the body.
  article: [{ componentId: 'content.article', props: () => ({ eyebrow: '' }) }, { componentId: 'content.text', props: () => ({ heading: '', body: 'Write the article here.' }) }]
};

/** The components a starter would place in this project, in order: those its theme lacks, or that cannot take a required text, are left out. */
export function pageStarterComponents(state: ProjectState, starter: PageStarter): string[] {
  return PAGE_STARTER_SECTIONS[starter].filter((s) => !!sectionProps(state, s, '')).map((s) => s.componentId);
}

/** The section's texts as the project's version of its component stores them (the installed one, else the theme's); null when it is not placed. */
function sectionProps(state: ProjectState, section: StarterSection, title: string): Record<string, unknown> | null {
  const theme = catalogueComponent(state.site.themeId, section.componentId);
  return theme ? fittedProps(state, state.components[theme.id] ?? theme, section, title) : null;
}

/**
 * Place a starter's sections on a new page, from the components the active theme has. A text the theme's version of
 * a component does not take, or takes in another form, is left at the theme's own, unless the section requires it.
 */
export function addPageStarter(state: ProjectState, page: PageDoc, starter: PageStarter): void {
  for (const section of PAGE_STARTER_SECTIONS[starter]) {
    // Checked before anything is installed, so a section left out installs nothing.
    const props = sectionProps(state, section, page.title);
    if (!props) continue;
    const def = state.components[installComponent(state, section.componentId)];
    const node = makeInstance(def, {}, section.variant);
    Object.assign(node.props, props);
    // The site's business details where the design shows the samples (#1368); the starter's own texts stay.
    fillBusinessDetails(state, { kind: 'page', id: page.id }, node, props);
    section.settle?.(state, page, node);
    page.nodes[node.id] = node;
    page.rootIds.push(node.id);
  }
}

/** The section's texts as this version of its component stores them; null when it cannot take a required one. */
function fittedProps(state: ProjectState, def: ComponentDefinition, section: StarterSection, title: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(section.props?.(title) ?? {})) {
    const schema = Object.hasOwn(def.properties, k) ? def.properties[k] : undefined;
    if (!schema || (schema.type === 'list' && schema.feed)) continue;
    try {
      out[k] = normalizeProp(schema, v, state, `${def.name} → ${schema.label}`);
    } catch {
      if (section.required?.includes(k)) return null;
    }
  }
  return out;
}
