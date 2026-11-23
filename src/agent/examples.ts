/** Keyword retrieval over the theme's worked examples (ai-profile), checked against the real catalogue. */
import type { ComponentDefinition, ProjectState } from '@shared/types';
import { catalogueComponent, getTheme } from '@catalogue/index';
import type { AiExample } from '@catalogue/foundation/ai-examples';
import { checkProps, type FieldIssue } from './macros';

/** Problems an example has against the theme's current component contract. */
export function checkExample(state: ProjectState, ex: AiExample): FieldIssue[] {
  const def: ComponentDefinition | undefined = catalogueComponent(state.site.themeId, ex.componentId);
  if (!def || def.category === 'shell') return [{ field: 'componentId', message: `unknown component "${ex.componentId}"` }];
  const issues: FieldIssue[] = [];
  if (ex.variant !== undefined && !Object.hasOwn(def.variants ?? {}, ex.variant)) issues.push({ field: 'variant', message: `no variant "${ex.variant}"` });
  checkProps(def, ex.props, state, 'props', issues);
  return issues;
}

const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/** The most relevant valid examples for a request, at most one per component. */
export function retrieveExamples(state: ProjectState, request: string, limit = 3): AiExample[] {
  const asked = words(request);
  return (getTheme(state.site.themeId).aiProfile.examples ?? [])
    .map((ex, order) => ({ ex, order, score: ex.keywords.reduce((n, k) => n + (asked.has(k) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .filter((x, i, all) => all.findIndex((y) => y.ex.componentId === x.ex.componentId) === i)
    .filter((x) => !checkExample(state, x.ex).length)
    .slice(0, limit)
    .map((x) => x.ex);
}

/** The examples of one component, for its read_component result. */
export function examplesFor(state: ProjectState, componentId: string | undefined): AiExample[] {
  if (!componentId) return [];
  return (getTheme(state.site.themeId).aiProfile.examples ?? []).filter((ex) => ex.componentId === componentId && !checkExample(state, ex).length);
}

/** The compact form shown to the model: a ready-to-send section. */
export const exampleSection = (ex: AiExample) => ({ for: ex.description, section: { componentId: ex.componentId, ...(ex.variant ? { variant: ex.variant } : {}), props: ex.props } });
