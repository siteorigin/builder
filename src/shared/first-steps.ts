import type { ProjectState, TokensDoc } from './types';
import { richTextToPlain, type RichText } from './richtext';

/**
 * Get started (#951): the short list a new Business site opens with under its pages, of what a first-time author does
 * first. Each step is ticked by what the project actually has, measured against the site as the starter made it,
 * never by the author ticking it: a list that can be ticked without doing the thing says nothing.
 */
export type FirstStepId = 'style' | 'heading' | 'page' | 'preview' | 'export';

/** The order the list shows them in: a quick win on the page first, then the site, then seeing and shipping it. */
export const FIRST_STEPS: FirstStepId[] = ['heading', 'style', 'page', 'preview', 'export'];

/** The site as its starter made it: what each step is measured against. */
export interface FirstStepsStart {
  name: string;
  themeId: string;
  /** The theme's colour tokens, and their light and dark values and palette mode as JSON (see colorsOf). */
  colorIds: string[];
  colors: string;
  pages: string[];
  /** The home page's main heading: the first section on it with one. */
  heading?: { pageId: string; nodeId: string; prop: string; value: string };
  /** Every section heading the starter wrote, on any page, so one of them moving up is not a heading written. */
  headings: string[];
}

/** What a project keeps about its list, in its workspace state (never in the site). */
export interface FirstStepsRecord {
  start: FirstStepsStart;
  /** The author has seen the site in Preview, ready. */
  previewed?: boolean;
  /** A website export (not the editable project) finished. */
  exported?: boolean;
  /** Folded to its heading; the list comes back with its toggle. */
  folded?: boolean;
  /** Hidden for good: the list never shows in this project again. */
  hidden?: boolean;
}

type Heading = NonNullable<FirstStepsStart['heading']>;

/**
 * The home page's main heading: the first top-level section on it, in its current order, whose `heading` property has
 * words (an empty optional heading above it never leads). With `first`, the first section with a `heading` property
 * at all, emptied or not: where the step goes, so an emptied heading can be written again. Values are the text a
 * visitor reads (see headingText).
 */
export function homeHeading(state: ProjectState, first = false): Heading | undefined {
  const pageId = state.site.homePageId;
  const page = Object.hasOwn(state.pages, pageId) ? state.pages[pageId] : undefined;
  if (!page) return undefined;
  for (const id of page.rootIds) {
    const n = page.nodes[id];
    if (n?.kind !== 'instance' || !Object.hasOwn(n.props, 'heading')) continue;
    const value = headingText(n.props.heading);
    if (value || first) return { pageId, nodeId: id, prop: 'heading', value };
  }
  return undefined;
}

/**
 * A heading as a visitor reads it: its words with the spacing evened out, so a stray space is no change while case and
 * punctuation are. Rich text reads as its plain text.
 */
export function headingText(value: unknown): string {
  let text = '';
  if (typeof value === 'string') text = value;
  else if (Array.isArray(value)) {
    try {
      text = richTextToPlain(value as RichText);
    } catch {
      text = '';
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** What the colour of the site is made of: the colour tokens' own values, the dark palette and which palettes it has. */
function colorsOf(tokens: TokensDoc, ids: string[]): string {
  const own = Object.fromEntries(ids.filter((id) => Object.hasOwn(tokens.overrides, id)).map((id) => [id, tokens.overrides[id]]));
  return JSON.stringify({ own, dark: tokens.darkOverrides ?? {}, mode: tokens.colorSchemeMode ?? 'single' });
}

/** The site as it is now, to measure later changes against. `colorIds` are its theme's colour tokens. */
export function firstStepsStart(state: ProjectState, colorIds: string[]): FirstStepsStart {
  return {
    name: state.site.name,
    themeId: state.site.themeId,
    colorIds,
    colors: colorsOf(state.tokens, colorIds),
    pages: [...state.site.pageOrder],
    heading: homeHeading(state),
    headings: [...new Set(Object.values(state.pages).flatMap((p) => Object.values(p.nodes).flatMap((n) => (n.kind === 'instance' && Object.hasOwn(n.props, 'heading') ? [headingText(n.props.heading)] : []))))].filter(Boolean)
  };
}

/**
 * Where the heading step goes: the section that leads the home page now, in its current order (the author may have
 * added one above the starter's hero, replaced it, or chosen another home page), even with its heading emptied.
 */
export function headingTarget(state: ProjectState): Heading | undefined {
  return homeHeading(state, true);
}

/** Which steps the project has done. */
export function firstStepsDone(state: ProjectState, record: FirstStepsRecord): Record<FirstStepId, boolean> {
  const { start } = record;
  // Written: the home page's main heading has words, and they are none of the headings the starter wrote.
  const now = homeHeading(state);
  const heading = !!now && !!now.value && now.value !== start.heading?.value && !start.headings.includes(now.value);
  const known = new Set(start.pages);
  return {
    heading,
    style: state.site.name !== start.name || state.site.themeId !== start.themeId || colorsOf(state.tokens, start.colorIds) !== start.colors,
    page: Object.keys(state.pages).some((id) => !known.has(id)),
    preview: !!record.previewed,
    export: !!record.exported
  };
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : null);

/** A record read back from the workspace file, or null for anything that is not one. */
export function readFirstSteps(value: unknown): FirstStepsRecord | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const s = v.start as Record<string, unknown> | undefined;
  const pages = strings(s?.pages);
  const colorIds = strings(s?.colorIds);
  const headings = strings(s?.headings);
  if (!s || typeof s !== 'object' || typeof s.name !== 'string' || typeof s.themeId !== 'string' || typeof s.colors !== 'string' || !pages || !colorIds || !headings) return null;
  const h = s.heading as Record<string, unknown> | undefined;
  const heading = h && typeof h === 'object' && typeof h.pageId === 'string' && typeof h.nodeId === 'string' && typeof h.prop === 'string' && typeof h.value === 'string' ? { pageId: h.pageId, nodeId: h.nodeId, prop: h.prop, value: h.value } : undefined;
  return {
    start: { name: s.name, themeId: s.themeId, colorIds, colors: s.colors, pages, heading, headings },
    previewed: v.previewed === true,
    exported: v.exported === true,
    folded: v.folded === true,
    hidden: v.hidden === true
  };
}
