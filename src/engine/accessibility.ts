/**
 * Project health's accessibility advice: the theme's colour pairs in each palette visitors can see, and what the
 * site's pages render that a screen reader cannot use (an HTML id given to two elements of one page, a heading with
 * no words, a link or button with no name, a video with no title or none its player can play). Warnings only: they
 * never stop a save or an export.
 */
import { getTheme } from '@catalogue/index';
import { evaluatePairs, formatRatio, isFailing } from '@shared/contrast';
import { hasDarkPalette, type PaletteScheme } from '@shared/color-scheme';
import { effectiveTokens } from '@generator/index';
import type { NodeTree, OwnerRef, PageDoc, ProjectState } from '@shared/types';
import { accessibilityProblems, pageTrees, partHeadings, treeIdUses, type IdUse, type OutlineHeading, type UnnamedControl, type VideoProblem } from '@generator/checks';
import { loopEntries } from '@generator/collection-loops';
import { SHELL_PARTS, pagesShowing } from '@shared/page-shell';
import { loopMembers } from './collection-sources';
import { displayName } from './tree';
import type { Keeper } from './validation-cache';
import { diagnosticKey, type Diagnostic } from './validate';

/** The code of a theme colour pair too faint to read in one of the site's palettes. */
export const CONTRAST_CODE = 'COLOR_CONTRAST_LOW';

/** Where a colour pair's finding is: its palette and the theme's pair, as `contrastPlace` writes it. */
export const contrastPlace = (scheme: PaletteScheme, pairId: string) => `contrast:${scheme}:${pairId}`;

/** The palette and pair a contrast finding names (see contrastPlace); null for any other place. */
export function contrastPlaceOf(site: string | undefined): { scheme: PaletteScheme; pairId: string } | null {
  const m = site ? /^contrast:(light|dark):(.+)$/.exec(site) : null;
  return m ? { scheme: m[1] as PaletteScheme, pairId: m[2] } : null;
}

/**
 * The colour pairs the theme sets against each other (its button text on the button, text on a dark section) that do
 * not reach WCAG 2.2 AA in the site's palette, and in its dark palette while visitors can see one. A pair whose colours
 * cannot be known here (a colour mixed at run time) is not reported.
 */
export function paletteContrastDiagnostics(state: ProjectState): Diagnostic[] {
  const pairs = getTheme(state.site.themeId).contrastPairs ?? [];
  if (!pairs.length) return [];
  const dual = hasDarkPalette(state.tokens);
  const schemes: PaletteScheme[] = dual ? ['light', 'dark'] : ['light'];
  return schemes.flatMap((scheme) =>
    evaluatePairs(effectiveTokens(state, scheme), pairs)
      .filter(isFailing)
      .map((r): Diagnostic => {
        const where = dual ? (scheme === 'dark' ? 'Dark palette' : 'Light palette') : 'Site colors';
        return {
          severity: 'warning',
          code: CONTRAST_CODE,
          message: `${where}: ${r.pair.use} has a contrast of ${formatRatio(r.ratio)}:1, below the ${r.min}:1 that keeps it readable (WCAG 2.2 AA). Choose readable colors in Site styles, under Colors${dual ? `, with the ${scheme} palette shown` : ''}.`,
          site: contrastPlace(scheme, r.pair.id)
        };
      })
  );
}

/** The code of an HTML id given to more than one element of a page. */
export const DUPLICATE_ID_CODE = 'HTML_ID_DUPLICATE';
/** The code of a heading the page renders with no words. */
export const EMPTY_HEADING_CODE = 'EMPTY_HEADING';

const listed = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? ''));
const partLabel = (part: string) => (part === 'header' ? 'Header' : 'Footer');
const PLACE_NAMES: Record<string, string> = { header: 'the shared header', footer: 'the shared footer' };

/** What a tree's element is called in a finding: its placement's name, or the element's own. */
const nodeName = (state: ProjectState, tree: NodeTree, nodeId: string) => (Object.hasOwn(tree.nodes, nodeId) ? displayName(state, tree.nodes[nodeId]) : 'element');

/**
 * Every HTML id a page renders, once per element rendering it (treeIdUses), with what its own collection loops repeat:
 * an element with an id inside a loop renders it once per entry the loop shows.
 */
function pageIdUses(state: ProjectState, page: PageDoc): IdUse[] {
  const out: IdUse[] = [];
  for (const { owner, tree } of pageTrees(state, page)) {
    out.push(...treeIdUses(state, owner, tree));
    for (const [nodeId, loop] of loopMembers(tree)) {
      const anchor = tree.nodes[nodeId]?.anchor;
      if (!anchor) continue;
      const rows = loopEntries(state, loop, {}).entries.length;
      for (let i = 0; i < rows; i++) out.push({ id: anchor, owner, nodeId });
    }
  }
  return out;
}

/**
 * The HTML ids a page renders more than once, across its own content, the shared header and footer it shows, panels
 * kept in it hidden, and what code writes out literally: a link to `#id` and anything that refers to an id reach only
 * the first. Each is reported at a later element with the id in the page's own content, when one is there, else in
 * the shared part, which is then the same finding on every page showing it.
 */
export function duplicateIdDiagnostics(state: ProjectState, page: PageDoc): Diagnostic[] {
  const byId = new Map<string, IdUse[]>();
  for (const use of pageIdUses(state, page)) byId.set(use.id, [...(byId.get(use.id) ?? []), use]);
  const out: Diagnostic[] = [];
  for (const [id, uses] of byId) {
    if (uses.length < 2) continue;
    const own = uses.filter((u) => u.owner.kind === 'page');
    const at = own[1] ?? own[0] ?? uses[1];
    const places = [...new Set(uses.map((u) => (u.owner.kind === 'shell' ? `in ${PLACE_NAMES[u.owner.id]}` : 'on the page')))];
    const where = at.owner.kind === 'page' ? page.title : partLabel(at.owner.id);
    out.push({
      severity: 'warning',
      code: DUPLICATE_ID_CODE,
      message: `${where}: ${uses.length} elements ${listed(places)} have the ID “${id}”, so a link to #${id}, and anything else that refers to the ID, reaches only the first. Give each its own ID.`,
      owner: at.owner,
      nodeId: at.nodeId,
      site: `id:${id}`
    });
  }
  return out;
}

/**
 * The headings of an outline (headingOutline, partHeadings) that render with no words: a screen reader's list of
 * headings shows an empty one, and a visitor finds nothing under it. `label` names the page or shared part.
 */
export function emptyHeadingDiagnostics(state: ProjectState, outline: readonly OutlineHeading[], label: string, tree: NodeTree): Diagnostic[] {
  const seen = new Map<string, number>();
  return outline.flatMap((h): Diagnostic[] => {
    if (h.text) return [];
    const place = [h.nodeId, h.defNodeId ?? null, ...(h.itemPath ?? [])];
    const key = JSON.stringify(place);
    // Two empty subheadings in one text are told apart by their order in it.
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    const name = nodeName(state, tree, h.nodeId);
    const inside = Object.hasOwn(tree.nodes, h.nodeId) && tree.nodes[h.nodeId].kind !== 'text' ? ` in the ${name}` : '';
    return [
      {
        severity: 'warning',
        code: EMPTY_HEADING_CODE,
        message: `${label}: a Heading ${h.level}${inside} has no words, so screen readers announce an empty heading. Give it its words, or remove it.`,
        owner: h.owner,
        nodeId: h.nodeId,
        site: JSON.stringify(['heading', ...place, nth])
      }
    ];
  });
}

/** The codes of a control with no accessible name and of a video visitors cannot use, by what they are. */
const CONTROL_CODES: Record<UnnamedControl['what'], string> = { link: 'LINK_NAME_MISSING', card: 'LINK_NAME_MISSING', button: 'BUTTON_NAME_MISSING' };
const VIDEO_CODES: Record<VideoProblem['problem'], string> = { title: 'VIDEO_TITLE_MISSING', url: 'VIDEO_URL_UNSUPPORTED' };

/** What a tree renders that screen readers cannot use (accessibilityProblems), as Project health reports it. `label` names the page or shared part. */
export function treeAccessibilityDiagnostics(state: ProjectState, owner: OwnerRef, tree: NodeTree, label: string): Diagnostic[] {
  const { controls, videos } = accessibilityProblems(state, tree);
  const out: Diagnostic[] = [];
  for (const c of controls) {
    const node = Object.hasOwn(tree.nodes, c.nodeId) ? tree.nodes[c.nodeId] : undefined;
    const self = node?.kind === (c.what === 'card' ? 'element' : 'link');
    const name = nodeName(state, tree, c.nodeId);
    const subject = self ? `the ${name}` : `a ${c.what === 'card' ? 'card' : c.what} in the ${name}`;
    const message =
      c.what === 'card'
        ? `${label}: ${subject} links the whole card, but nothing in it names where it goes: no words, no described picture and no accessible name. Add words or a picture description to the card, or give it an accessible name.`
        : c.what === 'button'
          ? `${label}: ${subject} is a button with no words and no accessible name, so screen readers cannot say what it does. Give it a label, or an accessible name.`
          : `${label}: ${subject} is a link with no words and no accessible name, so screen readers cannot say where it goes. Give it a label, or an accessible name that says where it goes.`;
    out.push({ severity: 'warning', code: CONTROL_CODES[c.what], message, owner, nodeId: c.nodeId, site: `control:${c.key}` });
  }
  for (const v of videos) {
    const lead = v.problem === 'title' ? `the ${v.name} has no title.` : `the ${v.name} has no video its player can play.`;
    out.push({ severity: 'warning', code: VIDEO_CODES[v.problem], message: `${label}: ${lead} ${v.message}`, owner, nodeId: v.nodeId, site: `video:${v.placementId}` });
  }
  return out;
}

/**
 * Project health's accessibility advice on what the site's pages render, in site order, then the shared header and
 * footer each once while a page shows it: unnamed links, buttons and cards, unusable videos, and the HTML ids a page
 * renders twice. A shared part's id clash is said once, however many pages show it. The pages' empty headings are
 * reported with their heading outlines (headingDiagnostics), the shared parts' here.
 */
export function pageAccessibilityDiagnostics(state: ProjectState, keep: Keeper): Diagnostic[] {
  const out: Diagnostic[] = [];
  const said = new Set<string>();
  for (const id of state.site.pageOrder) {
    const page = Object.hasOwn(state.pages, id) ? state.pages[id] : undefined;
    if (!page) continue;
    const owner: OwnerRef = { kind: 'page', id };
    const found = keep.tree({ owner, tree: page, label: page.title }, 'accessibility', () => [...treeAccessibilityDiagnostics(state, owner, page, page.title), ...duplicateIdDiagnostics(state, page)]);
    for (const d of found) {
      const key = diagnosticKey(d);
      if (d.owner?.kind === 'shell' && said.has(key)) continue;
      said.add(key);
      out.push(d);
    }
  }
  for (const part of SHELL_PARTS) {
    if (!pagesShowing(state, part).length) continue;
    const owner: OwnerRef = { kind: 'shell', id: part };
    const tree = state.site.shell[part];
    const label = partLabel(part);
    out.push(...keep.tree({ owner, tree, label }, 'accessibility', () => [...emptyHeadingDiagnostics(state, partHeadings(state, part), label, tree), ...treeAccessibilityDiagnostics(state, owner, tree, label)]));
  }
  return out;
}
