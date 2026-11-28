import type { ExportNote } from '@shared/api';
import { isArticleDate, pageArticle } from '@shared/articles';
import { storedCanonical } from '@shared/seo';
import { findEntry } from '@shared/collections';
import { collectionDiagnostics } from './collections';
import { sourceDiagnostics } from './sources';
import { isPictureAsset } from '@shared/background-image';
import { overPixelLimit } from '@shared/picture-formats';
import type { BackgroundImageValue, ComponentDefinition, GraphNode, ImageValue, NodeTree, OwnerRef, PageDoc, ProjectState, PropSchema, ResponsiveStyles, StyleTokenRef, StyleValue } from '@shared/types';
import { STYLE_PROP_MAP, containerStyleError, isStateStyleProp, linkShapeError, stateStyleError, validateStyleValue } from '@shared/styles';
import { groupLookup, hasGroupStyles, partInInteractionGroup } from '@shared/interaction-groups';
import { effectiveItem, followsPage } from '@shared/page-teasers';
import { ELEMENT_TAGS, LIST_FEEDS, TEXT_TAGS, isCollectionLoop, conditionRef, isBinding, isBindingRef, isComparison, isContainerScope, isEntryBinding, isStateRef, parseStyleScopeKey, type Collection } from '@shared/types';
import { ENTRY_CONTENT_FIELDS, entryChoiceProblem, entryComparisonProblem, entryFieldSchema, isEntryDateField } from '@shared/entry-fields';
import { validateRoute } from '@shared/routes';
import { loopText, redirectRecord, redirectSourceProblem, redirectTargetProblem, resolveRedirects, type RedirectProblem } from '@shared/redirects';
import { isLanguageCode, languageKey, pageLanguage, shownValue, translationClashMessage, translationClashes, translationMembers } from '@shared/languages';
import { codeAxisProblems, variantIdsValid, variantOptions } from '@shared/variants';
import { EngineError, allTrees, childLists, displayName, instancesOf, subtreeIds, templateTrees } from './tree';
import { normalizeTable } from './table';
import { normalizeObject } from './values';
import { slotAccepts, slotDecl, slotDeclProblem, slotFill } from './slots';
import { trackedNestingChecker, type NestingProblem } from './semantic-tags';
import { requiredDefaults, requiredPlacementProblems, type RequiredProblem } from './required';
import { MAX_UI_STATES, acceptedTypes, bindingProblem, bindingSlots, boundSchema, dividerProblem, overlayProblem, repeatFilterProblem, stateActionProblem, stateRefProblem, uiStateProblem } from './schema';
import { isCarouselTrack } from '@generator/card-links';
import { declaredTokens, findTokenCycle, forEachTokenPropRef } from './tokens';
import { darkValue } from '@shared/color-scheme';
import { blankPages, describeDraftLink, emptySectionMessage, emptySections, missingSectionLinks, netlifyFormClashes, pageHeadings, publicationPlan, shownArchiveLayouts, unfilledImages, unlinkedButtons, unlinkedMenuLinks, type CheckParts, type DraftLink, type FormNameClash } from '@generator/checks';
import { archivePages } from '@shared/archives';
import { choosesFontAtRunTime, declaresFonts, installedFonts, usedPackFonts } from '@catalogue/fonts';
import { codeNeeds } from './definitions';
import { collectionSourceProblems, loopMembers } from './collection-sources';
import { formDestinationLookup } from './form-destinations';
import { SHELL_PARTS, showsPart } from '@shared/page-shell';
import { effectiveTokens, isDraftEntry, isDraftPage, publishedState, siteEntries } from '@generator/index';
import { componentReusabilityDiagnostics } from './reusability';
import { layoutGuardrailDiagnostics } from './layout-guardrails';
import { elementContrastDiagnostics } from './element-contrast';
import { freshKeeper, type CheckedTree, type Keeper, type ValidationCache } from './validation-cache';
import { formConnectionProblem, formNoun, isFormDefinition, readsFormServices, formFieldTitles, formFieldsAsSent, formKeyClashes, formRefusesClashes, formRefusesUnchoosable, formUnchoosable, namesFormFields, offersFormChoices } from '@shared/form-contract';

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  owner?: { kind: string; id: string };
  nodeId?: string;
  /**
   * Where in its owner the problem is, for telling it apart from others of its kind (see `introducedDiagnostics` and
   * `diagnosticKey`): unlike the message, it stays the same when a page or component it names is renamed, or a repair
   * changes the wording. It identifies the problem where its message cannot: a compile error's file and construct (its
   * message names a line that moves), or which of several links in one placement it is.
   */
  site?: string;
  /**
   * For a finding in a collection's layout (a link to a draft): the published entry whose page shows it, so Project
   * health opens the layout on that entry. Where to look, not what the problem is: no part of telling it apart.
   */
  entryId?: string;
}

/**
 * What tells two diagnostics apart, as `introducedDiagnostics` with `byNode` does: one that names its place (`site`) by
 * its code, owner and place, any other by its code, owner, element and message. The same message in two places is two
 * problems.
 */
export const diagnosticKey = (d: Diagnostic): string => {
  const owner = `${d.code}|${d.owner?.kind ?? ''}:${d.owner?.id ?? ''}`;
  return d.site !== undefined ? `${owner}|@${d.site}` : `${owner}|${d.nodeId ?? ''}|${d.message}`;
};

/**
 * Errors in what the site shows that an edit may still introduce: the author fixes them later (a link to a section
 * that was just deleted, say), so they never stop a change from being saved or a file from being loaded.
 */
const CONTENT_ERRORS = new Set(['LINK_SECTION_MISSING', 'LINK_TO_DRAFT']);

/**
 * Whether a diagnostic is about the website export alone, with nothing wrong in the editable project: a link to a
 * draft (made on purpose, ahead of publishing it) stops the website export, which says so, and is never a reason to
 * refuse a change or for the AI to undo what it was asked to make.
 */
export const stopsExportOnly = (d: Diagnostic) => d.code === 'LINK_TO_DRAFT';

/** Whether a diagnostic leaves the project inconsistent enough that a change introducing it is refused. */
export const blocksSaving = (d: Diagnostic) => d.severity === 'error' && !CONTENT_ERRORS.has(d.code);

/**
 * The problems in `after` that `before` does not have: what a change brings in. One that names its place (`site`) is
 * told by its code, owner and place, and counted, so one more at the same place is new while a rename or a partial
 * repair is not. Any other is told by its message, and with `byNode` also by its code, owner and element, so the same
 * mistake made again on another element of a page counts as new (an external change, which is not an edit's step).
 */
export function introducedDiagnostics(before: readonly Diagnostic[], after: readonly Diagnostic[], { byNode = false } = {}): Diagnostic[] {
  const placed = (d: Diagnostic) => `${d.code}|${d.owner?.kind ?? ''}:${d.owner?.id ?? ''}|${d.site}`;
  const said = (d: Diagnostic) => (byNode ? `${d.code}|${d.owner?.kind ?? ''}:${d.owner?.id ?? ''}|${d.nodeId ?? ''}|${d.message}` : d.message);
  const messages = new Set(before.filter((d) => d.site === undefined).map(said));
  const left = new Map<string, number>();
  for (const d of before) if (d.site !== undefined) left.set(placed(d), (left.get(placed(d)) ?? 0) + 1);
  return after.filter((d) => {
    if (d.site === undefined) return !messages.has(said(d));
    const n = left.get(placed(d)) ?? 0;
    left.set(placed(d), n - 1);
    return n <= 0;
  });
}

/** "Home", "Home and About", "Home, About and Contact". */
const listed = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? ''));

/** JSON with object keys in order, so two values that differ only in key order compare equal. */
const sortedJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/** Where a finding about an old address is fixed: that address's row in Site settings, under Redirects. */
export const redirectPlace = (from: string) => `redirect:${from}`;

/** What keeps an old address from sending visitors straight on, said as Project health and the Redirects list say it. */
export function redirectDiagnostic(p: Exclude<RedirectProblem, { kind: 'invalid' }>): Diagnostic {
  const site = redirectPlace(p.from);
  switch (p.kind) {
    case 'self':
      return { severity: 'error', code: 'REDIRECT_SELF', message: `The old address ${p.from} sends visitors to itself, so the website leaves it out. Send it somewhere else, or remove it, in Site settings under Redirects.`, site };
    case 'loop': {
      const round = loopText(p.cycle, p.from);
      const inLoop = p.cycle.some((f) => f.toLowerCase() === p.from.toLowerCase());
      return {
        severity: 'error',
        code: 'REDIRECT_LOOP',
        message: `${inLoop ? `The old address ${p.from} is part of a loop` : `The old address ${p.from} leads into a loop`} (${round}) that never arrives anywhere, so the website leaves it out. Send one of them to a page in Site settings, under Redirects.`,
        site
      };
    }
    case 'missing':
      return { severity: 'warning', code: 'REDIRECT_PATH_MISSING', message: `The old address ${p.from} sends visitors to ${p.to}, which the site does not have, so the website leaves it out until something is there.`, site };
    case 'chain':
      return {
        severity: 'warning',
        code: 'REDIRECT_CHAIN',
        message: `The old address ${p.from} reaches ${p.to} through ${listed(p.hops > p.via.length ? [...p.via, `${p.hops - p.via.length} more`] : p.via)}. The website sends visitors straight to ${p.to}; send ${p.from} there in Site settings, under Redirects, so it keeps arriving if ${p.hops === 1 ? 'that address changes' : 'one of those addresses changes'}.`,
        site
      };
  }
}

/**
 * Schema and reference validation: IDs, references, nesting and routes, links to sections that do not exist, each
 * page's heading outline, layout styles that quietly undo each other (engine/layout-guardrails), and how reusable each
 * project component is. Save gates pass `sectionLinks: false`: section links, headings, layout guardrails and
 * reusability never block a save, so they need not be worked out. It is `coreValidation` and `adviceValidation`
 * joined, which the session works out apart, each once per state, so a save gate and Project health share the core.
 */
export function validateState(state: ProjectState, opts: { sectionLinks?: boolean } = {}): Diagnostic[] {
  const core = coreValidation(state);
  return opts.sectionLinks === false ? core.core : joinValidation(core, adviceValidation(state));
}

/** Adds what was found to the end of `out`, one by one: a list can be longer than a call's arguments may be. */
function append(out: Diagnostic[], found: readonly Diagnostic[]) {
  for (const d of found) out.push(d);
}

/** What a save gate checks, as `validateState(state, { sectionLinks: false })` reports it, and where the advice goes. */
export interface CoreValidation {
  core: Diagnostic[];
  /** The places in `core` the advice goes: the section links', then the rest's (see joinValidation). */
  at: readonly [number, number];
}

/** The advice only Project health shows: the links to missing sections, and the rest (see adviceValidation). */
export type AdviceValidation = readonly [links: Diagnostic[], rest: Diagnostic[]];

/**
 * Everything `validateState` checks but the advice (adviceValidation): what a save gate checks. Each finding is in the
 * order `validateState` reports it, and `at` records where the advice goes among them. With a session's `cache`, a part
 * of an earlier state's validation that reads the same in this state is used again (ValidationCache).
 */
export function coreValidation(state: ProjectState, cache?: ValidationCache): CoreValidation {
  const keep = cache ? cache.keeper(state) : freshKeeper(state);
  const out: Diagnostic[] = [...keep.shared('site', () => siteDiagnostics(state)), ...keep.shared('definitions', () => definitionDiagnostics(state))];
  for (const t of allTrees(state)) append(out, keep.tree(t, 'core', () => treeDiagnostics(state, t)));
  for (const p of keep.cards)
    out.push({
      severity: 'error',
      code: 'CARD_LINK_INTERACTIVE',
      message: `${p.label}: ${p.what} sits inside a card that links somewhere, and a link or control cannot sit inside another. Move it out of the card, or remove the card's link.`,
      owner: p.owner,
      nodeId: p.nodeId,
      // Each card (or placement whose slot content sits in cards) is its own problem, whatever the content inside it is
      // called and however many cards hold it: a second broken card is new, while a button losing its state action, or
      // one of several cards losing its link, is not.
      site: `card:${p.nodeId}`
    });
  // The links to sections that do not exist go here (adviceValidation).
  const linksAt = out.length;
  append(out, keep.shared('defaults', () => defaultDiagnostics(state)));
  // The page outlines, form names, run-time fonts, layout guardrails and reusability go here (adviceValidation).
  const adviceAt = out.length;
  append(out, structureDiagnostics(state, keep));
  // A required value left empty (a hand edit, or a swap, theme change or import that carried one over). A binding that
  // could pass an empty value is reported with the other binding problems.
  const required = (p: RequiredProblem): Diagnostic => ({ severity: 'error', code: 'PROP_REQUIRED_EMPTY', message: p.message, owner: p.owner, ...(p.nodeId ? { nodeId: p.nodeId } : {}), site: p.key });
  const defaults = keep.shared('requiredDefaults', () => requiredDefaults(state));
  append(out, defaults.problems.map(required));
  if (defaults.definitions.size) for (const t of allTrees(state)) append(out, keep.tree(t, 'required', () => requiredPlacementProblems(state, t, defaults.definitions, false).map(required)));
  append(out, keep.shared('assets', () => assetSizeDiagnostics(state)));
  return { core: out, at: [linksAt, adviceAt] };
}

/** The site's pages, old addresses, collections and sources: what coreValidation reports first. */
function siteDiagnostics(state: ProjectState): Diagnostic[] {
  const out: Diagnostic[] = [];
  const routes = new Map<string, string>();
  // The addresses only a draft page holds: the first old address kept at one shares it, sending visitors on until the
  // draft is published and takes it over (#1363).
  const draftOnly = new Set<string>();
  if (!Object.hasOwn(state.pages, state.site.homePageId)) out.push({ severity: 'error', code: 'HOME_MISSING', message: 'The site has no Home page.' });
  for (const id of state.site.pageOrder) {
    const p = state.pages[id];
    if (!p) {
      out.push({ severity: 'error', code: 'PAGE_MISSING', message: `Page order references missing page ${id}.` });
      continue;
    }
    const err = validateRoute(p.route);
    if (err) out.push({ severity: 'error', code: 'ROUTE_INVALID', message: `${p.title}: ${err}`, owner: { kind: 'page', id } });
    const key = p.route.toLowerCase();
    if (routes.has(key)) out.push({ severity: 'error', code: 'ROUTE_DUPLICATE', message: `${p.title} and ${routes.get(key)} share ${p.route}.`, owner: { kind: 'page', id } });
    if (!routes.has(key) && isDraftPage(state, p)) draftOnly.add(key);
    else draftOnly.delete(key);
    routes.set(key, p.title);
    if (p.language !== undefined && !isLanguageCode(p.language))
      out.push({ severity: 'warning', code: 'LANGUAGE_INVALID', message: `${p.title}: “${shownValue(p.language)}” is not a language code, so the page uses the site language.`, owner: { kind: 'page', id } });
    // A hand-edited article with no readable date would otherwise vanish from the news lists without a word.
    if (p.article !== undefined && !pageArticle(p))
      out.push({ severity: 'warning', code: 'ARTICLE_DATE_INVALID', message: `${p.title}: its publication date is not a calendar date written YYYY-MM-DD, so news lists leave it out.`, owner: { kind: 'page', id } });
    if (p.updatedAt !== undefined && !isArticleDate(p.updatedAt))
      out.push({ severity: 'warning', code: 'PAGE_DATE_INVALID', message: `${p.title}: its revision date is not a calendar date written YYYY-MM-DD, so the sitemap gives none (an article gives its publication date instead).`, owner: { kind: 'page', id }, site: 'updatedAt' });
    const canonical = p.seo && typeof p.seo === 'object' ? p.seo.canonical : undefined;
    if (canonical !== undefined && !storedCanonical(canonical))
      out.push({ severity: 'warning', code: 'CANONICAL_INVALID', message: `${p.title}: its canonical URL is not a full http(s) address, so its own public URL is used.`, owner: { kind: 'page', id }, site: 'canonical' });
  }
  // Translations in the same language cannot tell visitors apart. Published ones then list none of their versions;
  // a draft only matters once it is published.
  for (const clash of translationClashes(state)) {
    const published = translationMembers(state, clash.group)
      .filter((p) => !isDraftPage(state, p))
      .map((p) => languageKey(pageLanguage(state.site, p)));
    const live = new Set(published).size < published.length;
    const effect = live ? 'Until then, the website lists none of their translations.' : 'Publishing the draft as it is would stop the website listing their translations.';
    out.push({ severity: 'warning', code: 'TRANSLATION_LANGUAGE', message: `${translationClashMessage(clash)} ${effect}`, owner: { kind: 'page', id: clash.b.id } });
  }
  // Old addresses kept working: each is a route of its own, so nothing else may use it, and it names exactly one page,
  // collection entry or other address of the site.
  const redirects: unknown = state.site.redirects;
  if (redirects !== undefined && !Array.isArray(redirects)) out.push({ severity: 'error', code: 'REDIRECT_INVALID', message: 'The list of old page addresses is damaged.' });
  for (const r of Array.isArray(redirects) ? (redirects as unknown[]) : []) {
    const record = redirectRecord(r);
    if (!record) {
      out.push({ severity: 'error', code: 'REDIRECT_INVALID', message: 'An old page address is damaged.' });
      continue;
    }
    const { from, pageId, entryId, to } = record;
    const err = redirectSourceProblem(from);
    if (err) out.push({ severity: 'error', code: 'ROUTE_INVALID', message: `Old address ${from}: ${err}` });
    if (typeof pageId === 'string' && !Object.hasOwn(state.pages, pageId)) out.push({ severity: 'error', code: 'REDIRECT_TARGET', message: `The old address ${from} goes to a page that no longer exists.` });
    if (typeof entryId === 'string' && !findEntry(state, entryId)) out.push({ severity: 'error', code: 'REDIRECT_TARGET', message: `The old address ${from} goes to a collection entry that no longer exists.` });
    const toErr = to === undefined ? null : redirectTargetProblem(to);
    if (toErr) out.push({ severity: 'error', code: 'REDIRECT_PATH_INVALID', message: `The old address ${from} sends visitors to ${to}, which is not an address of the site: ${toErr} The website leaves it out until it is corrected in Site settings, under Redirects.`, site: redirectPlace(from) });
    const key = from.toLowerCase();
    if (routes.has(key) && !draftOnly.delete(key)) out.push({ severity: 'error', code: 'ROUTE_DUPLICATE', message: `${routes.get(key)} and the old address ${from} share ${from}.` });
    routes.set(key, `The old address ${from}`);
  }
  // Where each leads as the website has it, followed through other old addresses (one kept at a draft's address too):
  // one that never arrives is left out of the website. One that is not an address of the site is named above.
  for (const p of resolveRedirects(state, 'website').problems) if (p.kind !== 'invalid') out.push(redirectDiagnostic(p));
  // Collections and their entries hold addresses of their own, in the same namespace.
  out.push(...collectionDiagnostics(state, routes));
  out.push(...sourceDiagnostics(state));
  for (const id of Object.keys(state.pages)) if (!state.site.pageOrder.includes(id)) out.push({ severity: 'error', code: 'PAGE_ORPHAN', message: `Page ${state.pages[id].title} is not in the page order.` });
  if (new Set(state.site.pageOrder).size !== state.site.pageOrder.length) out.push({ severity: 'error', code: 'PAGE_MISSING', message: 'The page order lists a page twice.' });
  for (const p of Object.values(state.pages)) {
    if ((p.route === '/') !== (p.id === state.site.homePageId))
      out.push({ severity: 'error', code: 'HOME_ROUTE', message: p.route === '/' ? `${p.title} uses "/" but is not the Home page.` : `The Home page (${p.title}) must use "/".`, owner: { kind: 'page', id: p.id } });
  }
  return out;
}

/** Component definitions (computed lists, UI state, designs and their bindings) and the links their defaults hold. */
function definitionDiagnostics(state: ProjectState): Diagnostic[] {
  const out: Diagnostic[] = [];
  // Computed lists (a hand-edited definition): a feed this version knows, and a whole-number limit.
  for (const def of Object.values(state.components)) {
    for (const [k, p] of Object.entries(def.properties ?? {})) {
      if (p?.type !== 'list' || p.feed === undefined) continue;
      if (!(LIST_FEEDS as readonly unknown[]).includes(p.feed) || (p.max !== undefined && !(Number.isInteger(p.max) && p.max >= 0)))
        out.push({ severity: 'error', code: 'FEED_INVALID', message: `${def.name}: "${p.label ?? k}" is filled from the site's pages in a way this version cannot read. Check its feed and its limit.`, owner: { kind: 'component', id: def.id } });
    }
  }
  // Component definitions: one root to carry the component, bindings that resolve in scope, and declared parts.
  for (const def of Object.values(state.components)) {
    const owner = { kind: 'component', id: def.id };
    const declared: unknown = def.state;
    if (declared !== undefined) {
      // UI state is read and changed by a managed design; a code component keeps its own in its source.
      if (def.kind !== 'managed' || !declared || typeof declared !== 'object' || Array.isArray(declared))
        out.push({ severity: 'error', code: 'STATE_INVALID', message: `${def.name}: ${def.kind !== 'managed' ? 'a code component declares UI state, which only a managed design can read and change' : 'its UI state is not in the expected form'}.`, owner, site: 'state' });
      else {
        const names = Object.keys(declared);
        if (names.length > MAX_UI_STATES) out.push({ severity: 'error', code: 'STATE_INVALID', message: `${def.name}: it declares ${names.length} UI state variables; a component can have at most ${MAX_UI_STATES}.`, owner, site: 'state-limit' });
        for (const name of names) {
          const problem = uiStateProblem(def, name, (declared as Record<string, unknown>)[name]);
          if (problem) out.push({ severity: 'error', code: 'STATE_INVALID', message: `${def.name}: ${problem}`, owner, site: `state:${name}` });
        }
      }
    }
    // A part rendered once per list item names a list of the code component's own (see PartDef.list).
    for (const [pid, part] of Object.entries(def.parts ?? {})) {
      const list = part && typeof part === 'object' ? (part as { list?: unknown }).list : undefined;
      if (list === undefined) continue;
      const schema = typeof list === 'string' && Object.hasOwn(def.properties ?? {}, list) ? def.properties[list] : undefined;
      const problem =
        def.kind !== 'code'
          ? 'only a code component declares the list a part repeats over; a design shows it with a repeat'
          : pid === 'root'
            ? 'the root part is the whole component, so it repeats over no list'
            : typeof list !== 'string'
              ? 'the list it repeats over is not named by a property name'
              : !schema
              ? `it repeats over "${list}", which is not one of its properties`
              : schema.type !== 'list' || schema.feed
                ? `it repeats over "${list}", which is not a list that keeps its own items`
                : null;
      // Harmless while it stands (the part is styled for every item together), so it never blocks an edit.
      if (problem) out.push({ severity: 'warning', code: 'PART_LIST', message: `${def.name}: part "${pid}": ${problem}.`, owner, site: `part-list:${pid}` });
    }
    if (def.kind !== 'managed') continue;
    if (!def.tree) {
      out.push({ severity: 'error', code: 'COMPONENT_ROOT', message: `${def.name}: the component has no design to show.`, owner, site: 'root:unrendered' });
      continue;
    }
    const tree = def.tree;
    const rootProblem = componentRootProblem(tree);
    // Extra top-level elements beside one that renders are one problem however many there are, so putting them right
    // step by step is never a new one; a design left with nothing to carry the component (no root, or a repeat or slot
    // first) is another.
    if (rootProblem) out.push({ severity: 'error', code: 'COMPONENT_ROOT', message: `${def.name}: ${rootProblem.message}`, owner, nodeId: tree.rootIds[1] ?? tree.rootIds[0], site: rootProblem.renders ? 'root' : 'root:unrendered' });
    for (const [pid, part] of Object.entries(def.parts)) {
      if (!tree.nodes[part.nodeId]) out.push({ severity: 'error', code: 'PART_MISSING', message: `${def.name}: part "${pid}" refers to an element that no longer exists.`, owner });
    }
    const visited = new Set<string>();
    // What the elements of a collection loop read of its entries is checked with the loop (see ./collection-sources).
    const inLoop = loopMembers(tree);
    const check = (id: string, inRepeat: boolean) => {
      const n = tree.nodes[id];
      if (!n || visited.has(id)) return;
      visited.add(id);
      for (const slot of bindingSlots(n)) {
        // The property turning a category filter on is checked with the rest of the filter, below.
        if (slot.field === 'filter') continue;
        if (inLoop.has(id) && readsRowField(slot)) continue;
        const condition = slot.field === 'when' || slot.field === 'unless';
        if (condition && slot.value !== undefined && !conditionShapeValid(slot.value)) {
          out.push({ severity: 'error', code: 'BINDING_INVALID', message: `${def.name}: ${nodeLabel(n)} has a ${slot.field} condition that is neither a property, a list item field, UI state, nor a comparison of one with a value.`, owner, nodeId: id });
          continue;
        }
        // A read of state that also names a property or an item field would be read as one by some and the other by others.
        if (!condition && slot.value && typeof slot.value === 'object' && Object.hasOwn(slot.value, '$state') && !plainBinding(slot.value)) {
          out.push({ severity: 'error', code: 'BINDING_INVALID', message: `${def.name}: ${nodeLabel(n)} reads UI state and something else at once as its ${slot.field}; read one of them.`, owner, nodeId: id, site: `${id}|${slot.field}|${slot.prop ?? ''}` });
          continue;
        }
        const b = condition ? conditionRef(slot.value) : isBindingRef(slot.value) ? slot.value : undefined;
        if (!b) continue;
        if (isEntryBinding(b)) {
          out.push({ severity: 'error', code: 'BINDING_INVALID', message: `${def.name}: ${nodeLabel(n)} shows the entry field "${b.$entry}", which only a collection's layout can.`, owner, nodeId: id, site: `${id}|${slot.field}|${slot.prop ?? ''}` });
          continue;
        }
        if (isStateRef(b)) {
          const comparison = condition && isComparison(slot.value) ? slot.value : undefined;
          const problem = typeof b.$state === 'string' ? stateRefProblem(state, def, { node: n, field: slot.field, prop: slot.prop, comparison }, b) : 'reads UI state without naming it.';
          if (problem) out.push({ severity: 'error', code: 'BINDING_INVALID', message: `${def.name}: ${nodeLabel(n)} ${problem}`, owner, nodeId: id, site: `${id}|${slot.field}|${slot.prop ?? ''}` });
          continue;
        }
        if ('$prop' in b && !(b.$prop in def.properties))
          out.push({ severity: 'error', code: 'BINDING_INVALID', message: `${def.name}: an element uses the property "${b.$prop}", which the component does not have.`, owner, nodeId: id });
        else if ('$prop' in b && b.field !== undefined && !boundSchema(def, id, b))
          out.push({ severity: 'error', code: 'BINDING_INVALID', message: `${def.name}: an element uses the field "${b.field}" of "${b.$prop}", which is not a field of that property.`, owner, nodeId: id });
        if ('$item' in b && !inRepeat)
          out.push({ severity: 'error', code: 'BINDING_INVALID', message: `${def.name}: an element shows a list item field outside its list.`, owner, nodeId: id });
        else if ('$item' in b && !boundSchema(def, id, b))
          out.push({ severity: 'error', code: 'BINDING_INVALID', message: `${def.name}: an element shows the item field "${b.$item}", which its list does not have.`, owner, nodeId: id });
        const schema = ('$prop' in b || inRepeat) && boundSchema(def, id, b);
        const comparison = condition && isComparison(slot.value) ? slot.value : undefined;
        const problem = schema ? bindingProblem(state, { node: n, field: slot.field, prop: slot.prop, comparison }, schema) : null;
        if (problem) out.push({ severity: 'error', code: 'BINDING_INVALID', message: `${def.name}: ${nodeLabel(n)} ${problem}`, owner, nodeId: id });
      }
      if (Object.hasOwn(n, 'stateAction')) {
        const action = (n as { stateAction?: unknown }).stateAction;
        const problem = n.kind !== 'link' ? 'changes UI state, which only a button can.' : stateActionProblem(def, action, id);
        if (problem) out.push({ severity: 'error', code: 'STATE_ACTION_INVALID', message: `${def.name}: ${nodeLabel(n)} ${problem}`, owner, nodeId: id, site: `${id}|stateAction` });
      }
      // A dialog or drawer that cannot work would show as an ordinary container in its place, so it is refused.
      const overlay = overlayProblem(def, n);
      if (overlay) out.push({ severity: 'error', code: 'OVERLAY_INVALID', message: `${def.name}: ${nodeLabel(n)} ${overlay}`, owner, nodeId: id, site: `${id}|overlay` });
      // A filter that does not work leaves the items as a plain list, every one showing. Reported, never blocking: a
      // design keeps its filter while it is off, and an edit to it (a card made a component of its own) still saves.
      const filter = Object.hasOwn(n, 'filter') && n.kind !== 'repeat' ? 'has a category filter, which only a repeat can.' : repeatFilterProblem(def, n);
      if (filter) out.push({ severity: 'warning', code: 'FILTER_INVALID', message: `${def.name}: ${nodeLabel(n)} ${filter} Its items all show, without category buttons.`, owner, nodeId: id, site: `${id}|filter` });
      for (const cl of childLists(n)) cl.ids.forEach((c) => check(c, inRepeat || n.kind === 'repeat'));
    };
    tree.rootIds.forEach((r) => check(r, false));
  }
  // A default shows in every placement that keeps it, and its page links are counted and moved like any other link,
  // so one whose page or document is gone is broken there too.
  for (const def of Object.values(state.components)) {
    const owner = { kind: 'component', id: def.id };
    // A list's own default items, and the default each new item's fields start with, read by their schema: only
    // what a link property or rich text holds is a link.
    const defaults = Object.entries(def.properties ?? {}).flatMap(([name, schema]) => [
      { label: schema?.label || name, links: linksOf(schema, schema?.default) },
      ...(schema?.type === 'list' ? Object.entries(schema.fields ?? {}).map(([f, field]) => ({ label: `${schema.label || name} › ${field?.label || f}`, links: linksOf(field, field?.default) })) : [])
    ]);
    for (const { label, links } of defaults) {
      const broken = new Set<'page' | 'document' | 'entry' | 'collection'>();
      for (const l of links) {
        if (l.type === 'entry') broken.add('entry');
        if (l.type === 'collection' && !Object.hasOwn(state.collections ?? {}, l.target)) broken.add('collection');
        if (l.type === 'page' && !Object.hasOwn(state.pages, l.target)) broken.add('page');
        if (l.type === 'document' && (Object.hasOwn(state.assets.assets, l.target) ? state.assets.assets[l.target] : undefined)?.kind !== 'document') broken.add('document');
      }
      const what = `${def.name}: the default “${label}” links to`;
      if (broken.has('page')) out.push({ severity: 'error', code: 'LINK_BROKEN', message: `${what} a page that no longer exists.`, owner });
      if (broken.has('document')) out.push({ severity: 'error', code: 'LINK_BROKEN', message: `${what} a document that is no longer in Assets. Choose another destination for it.`, owner });
      if (broken.has('entry')) out.push({ severity: 'error', code: 'LINK_BROKEN', message: `${what} a collection entry, which only another entry can link to for now. Choose another destination for it.`, owner });
      if (broken.has('collection')) out.push({ severity: 'error', code: 'LINK_BROKEN', message: `${what} a collection that no longer exists. Choose another destination for it.`, owner });
    }
  }
  return out;
}

/**
 * One document's problems, as coreValidation reports them for each tree in turn: its nodes and how they hold each other,
 * the links, pictures and alternative text in its values, its buttons, menu links and empty sections, and its forms.
 * It reads its own tree, the components, the library, collections and the pages' other fields, never another page's tree.
 */
function treeDiagnostics(state: ProjectState, { owner, tree, label }: CheckedTree): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Map<string, number>();
  const visit = (ids: string[]) => {
    for (const id of ids) {
      seen.set(id, (seen.get(id) ?? 0) + 1);
      const n = tree.nodes[id];
      if (!n) {
        out.push({ severity: 'error', code: 'NODE_MISSING', message: `${label}: missing node ${id}.`, owner });
        continue;
      }
      if ((seen.get(id) ?? 0) > 1) {
        out.push({ severity: 'error', code: 'NODE_SHARED', message: `${label}: node ${id} appears twice.`, owner, nodeId: id });
        continue;
      }
      for (const cl of childLists(n)) visit(cl.ids);
    }
  };
  visit(tree.rootIds);
  for (const n of Object.values(tree.nodes)) {
    // Every tree, a theme's copy too: the site shows a plain line, or the default icon, for what cannot be drawn.
    const divider = dividerProblem(n);
    if (divider) out.push({ severity: 'error', code: 'DIVIDER_INVALID', message: `${label}: ${nodeLabel(n)} ${divider}`, owner, nodeId: n.id, site: `${n.id}|shape` });
    if (n.kind === 'instance') {
      const def = state.components[n.definitionId];
      if (!def) out.push({ severity: 'error', code: 'DEF_MISSING', message: `${label}: ${n.definitionId} is not installed.`, owner, nodeId: n.id });
      // A table changed by hand into a shape it cannot have shows only the rows it can, so it is reported.
      else
        for (const [k, schema] of Object.entries(def.properties)) {
          // A computed list shows what the site's pages give it, whatever is stored.
          if (schema.type === 'list' && !schema.feed && Object.hasOwn(n.props, k))
            for (const id of duplicateItemIds(n.props[k]))
              out.push({ severity: 'error', code: 'LIST_ITEM_DUPLICATE', message: `${label}: ${duplicateItemMessage(displayName(state, n), schema, id)}`, owner, nodeId: n.id, site: `${n.id}|${k}|${id}` });
          if (schema.type === 'object' && Object.hasOwn(n.props, k) && !isBinding(n.props[k])) {
            // An object edited by hand: a field it does not have, or one missing, is reported; the site shows the rest.
            let problem: string | null = null;
            try {
              if (sortedJson(normalizeObject(schema, n.props[k], state, schema.label, n.props[k])) !== sortedJson(n.props[k])) problem = 'it is not saved in the form the editor shows';
            } catch (e) {
              problem = e instanceof EngineError ? e.message : 'it is not an object of its fields';
            }
            if (problem) out.push({ severity: 'warning', code: 'OBJECT_DAMAGED', message: `${label}: “${schema.label}” in ${displayName(state, n)} cannot be read as saved (${problem}). Set it again in the Inspector.`, owner, nodeId: n.id });
            continue;
          }
          if (schema.type !== 'table' || !Object.hasOwn(n.props, k) || isBinding(n.props[k])) continue;
          // A pure check of a saved value: whatever it throws, the project still opens and says what is wrong.
          let problem: string | null = null;
          try {
            if (sortedJson(normalizeTable(n.props[k], schema.label)) !== sortedJson(n.props[k])) problem = 'it is not saved in the form the editor shows';
          } catch (e) {
            problem = e instanceof EngineError ? e.message : 'it has a value that is not a table';
          }
          if (problem) out.push({ severity: 'warning', code: 'TABLE_DAMAGED', message: `${label}: part of a table in ${displayName(state, n)} cannot be read (${problem}). Editing the table keeps the rows and columns that can.`, owner, nodeId: n.id });
        }
    }
    if (!seen.has(n.id)) out.push({ severity: 'warning', code: 'NODE_DETACHED', message: `${label}: ${displayName(state, n)} is not attached to the tree.`, owner, nodeId: n.id });
  }
  // References inside literal values
  // A computed list's stored items are never shown (the site's pages fill it), so what they hold is not a picture.
  let ignored = new Set<unknown>();
  const walk = (v: unknown, nodeId: string, shown = true) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, nodeId, shown && !ignored.has(v)));
    if (!v || typeof v !== 'object' || isBinding(v)) return;
    const o = v as Record<string, unknown>;
    if (o.type === 'page' && typeof o.target === 'string' && !state.pages[o.target])
      out.push({ severity: 'error', code: 'LINK_BROKEN', message: `${label}: a link points to a page that no longer exists.`, owner, nodeId });
    if (o.type === 'collection' && typeof o.target === 'string' && !Object.hasOwn(state.collections ?? {}, o.target))
      out.push({ severity: 'error', code: 'LINK_BROKEN', message: `${label}: a link goes to the list of a collection that no longer exists. Choose another destination for it.`, owner, nodeId });
    // Only an entry's own text can hold a link to an entry for now: anywhere else the website could not show it, and
    // editing its text on the page would drop it.
    if (o.type === 'entry' && typeof o.target === 'string')
      out.push({ severity: 'error', code: 'LINK_BROKEN', message: `${label}: a link goes to ${findEntry(state, o.target) ? 'a collection entry, which only another entry can link to for now' : 'a collection entry that no longer exists'}. Choose another destination for it.`, owner, nodeId });
    const asset = typeof o.assetId === 'string' && Object.hasOwn(state.assets.assets, o.assetId) ? state.assets.assets[o.assetId] : undefined;
    if (typeof o.assetId === 'string' && !asset) out.push({ severity: 'error', code: 'ASSET_MISSING', message: `${label}: an image references a missing asset.`, owner, nodeId });
    else if (asset && asset.kind !== 'image' && shown)
      out.push({ severity: 'error', code: 'ASSET_NOT_IMAGE', message: `${label}: an image shows “${asset.name}”, which is a ${asset.kind}, not a picture. Choose an image instead.`, owner, nodeId, site: `${nodeId}|${asset.id}` });
    if (o.type === 'document' && typeof o.target === 'string' && (Object.hasOwn(state.assets.assets, o.target) ? state.assets.assets[o.target] : undefined)?.kind !== 'document')
      out.push({ severity: 'error', code: 'LINK_BROKEN', message: `${label}: a link goes to a document that is no longer in Assets. Choose another destination for it.`, owner, nodeId });
    // A section heading or a picture between paragraphs belongs to a post's text (an import or a hand edit can put one
    // in a page's): it shows, but the text's own editors cannot keep it.
    if ((o.type === 'h2' && Array.isArray(o.spans)) || (o.type === 'image' && typeof o.assetId === 'string' && !('label' in o)))
      out.push({ severity: 'warning', code: 'ARTICLE_BLOCK', message: `${label}: text holds a ${o.type === 'h2' ? 'section heading' : 'picture'} that only a post's text can hold. Editing that text drops it; change it in the inspector.`, owner, nodeId, site: `${nodeId}|article` });
    if ('assetId' in o && o.assetId && !o.decorative && typeof o.alt !== 'object' && !String(o.alt ?? '').trim() && owner.kind !== 'component')
      out.push({ severity: 'warning', code: 'ALT_MISSING', message: `${label}: an image has no alternative text.`, owner, nodeId });
    Object.values(o).forEach((x) => walk(x, nodeId, shown));
  };
  for (const n of Object.values(tree.nodes)) {
    const props = n.kind === 'instance' ? state.components[n.definitionId]?.properties : undefined;
    ignored = new Set(Object.entries(props ?? {}).flatMap(([k, sch]) => (sch.type === 'list' && sch.feed && n.kind === 'instance' && Array.isArray(n.props[k]) ? [n.props[k]] : [])));
    // Style rules hold no content: a background image in one is checked with the other styles, and describes nothing.
    const { styles: _styles, overrides: _overrides, itemOverrides: _items, ...content } = n as GraphNode & { overrides?: unknown; itemOverrides?: unknown };
    walk(content, n.id);
  }
  // A page list's card with no image of its own shows its page's sharing image, which needs a description too.
  if (owner.kind !== 'component')
    for (const n of Object.values(tree.nodes)) {
      if (n.kind !== 'instance') continue;
      for (const [prop, schema] of Object.entries(state.components[n.definitionId]?.properties ?? {})) {
        const field = schema.type === 'list' ? schema.pageTeaser?.image : undefined;
        const items = Object.hasOwn(n.props, prop) ? n.props[prop] : schema.default;
        if (!field || schema.type !== 'list' || !Array.isArray(items)) continue;
        for (const item of items as Array<Record<string, unknown>>) {
          // Only an image the card takes from its page: one of its own is checked with the other literal images.
          if (!item || typeof item !== 'object' || !followsPage(item[field])) continue;
          const shown = effectiveItem(state, schema, item);
          const image = shown === item ? undefined : (shown[field] as ImageValue | undefined);
          if (!image?.assetId || String(image.alt ?? '').trim()) continue;
          const title = String(shown[schema.pageTeaser!.title] ?? '').trim() || schema.itemLabel;
          out.push({ severity: 'warning', code: 'ALT_MISSING', message: `${label}: the “${title}” card shows its page’s sharing image, which has no description. Add one to the image in the library, or choose an image for the card.`, owner, nodeId: n.id });
        }
      }
    }
  if (owner.kind !== 'component') {
    for (const b of unlinkedButtons(state, tree))
      out.push({ severity: 'warning', code: 'BUTTON_UNLINKED', message: `${label}: the “${b.label}” button has no link, so visitors won’t see it. Choose where it goes, or hide the button.`, owner, nodeId: b.nodeId });
    for (const m of unlinkedMenuLinks(state, tree))
      out.push({ severity: 'warning', code: 'MENU_LINK_UNLINKED', message: `${label}: the “${m.label}” menu link has no destination, so it goes nowhere. Choose where it goes, or remove it from the menu.`, owner, nodeId: m.nodeId });
    // Pages and the shared header and footer, as the export notes name them: a collection's layout is read without the
    // values of the entries it shows.
    for (const e of owner.kind === 'page' || owner.kind === 'shell' ? emptySections(state, tree) : [])
      out.push({ severity: 'warning', code: 'SECTION_EMPTY', message: `${label}: ${emptySectionMessage(e)}`, owner, nodeId: e.nodeId, ...(e.placementId !== e.nodeId ? { site: `${e.nodeId}|${e.placementId}` } : {}) });
  }
  // Theme definitions are fixed theme data; a project component's own forms are checked like a page's.
  const inTheme = owner.kind === 'component' && state.components[owner.id]?.owner === 'theme';
  for (const n of Object.values(tree.nodes)) {
    const def = n.kind === 'instance' ? state.components[n.definitionId] : undefined;
    if (inTheme || n.kind !== 'instance' || !def || !isFormDefinition(def) || def.kind !== 'code') continue;
    const props = Object.fromEntries(Object.entries(def.properties).map(([k, sch]) => [k, k in n.props ? n.props[k] : sch.default]));
    const unconnected = formConnectionDiagnostic(state, owner, label, n);
    if (unconnected) out.push(unconnected);
    // A list bound from outside is only known where it is placed.
    if (namesFormFields(def) && !isBinding(props.fields)) {
      const fields = formFieldsAsSent(def, props.fields);
      // Which field a finding is about, by its row (the one to change), so each finding leads to its own row.
      const row = (i: number | undefined) => (i !== undefined && typeof fields[i]?.id === 'string' ? { site: `${n.id}|fields|${fields[i].id}` } : {});
      for (const clash of formKeyClashes(fields)) {
        const what = formFieldTitles(fields, clash.indexes, fields.map((_, i) => i));
        const outcome = formRefusesClashes(def) ? 'so visitors cannot send the form' : 'so the form service cannot tell those answers apart';
        const all = clash.indexes.length === 2 ? 'both' : 'all';
        out.push({ severity: 'warning', code: 'FORM_FIELD_KEYS', message: `${label}: the ${formNoun(def)}'s ${what} fields are ${all} sent as “${clash.key}”, ${outcome}. Give each field its own field name.`, owner, nodeId: n.id, ...row(clash.indexes[1]) });
      }
      for (const i of offersFormChoices(def) ? formUnchoosable(fields) : []) {
        const what = formFieldTitles(fields, [i], fields.map((_, j) => j));
        const outcome = formRefusesUnchoosable(def) ? 'so visitors cannot send the form' : 'so visitors cannot answer it';
        out.push({ severity: 'warning', code: 'FORM_NO_CHOICES', message: `${label}: the ${formNoun(def)}'s ${what} field has no choices to pick from, ${outcome}. Add its choices, or change its type.`, owner, nodeId: n.id, ...row(i) });
      }
    }
  }
  return out;
}

/** What the components give placements that set nothing of their own, and the site's pictures. */
function defaultDiagnostics(state: ProjectState): Diagnostic[] {
  const out: Diagnostic[] = [];
  // What a component gives placements that set nothing of their own: a list's items (a theme update can bring new
  // ones), and the pictures of a project component, which can only show images.
  for (const def of Object.values(state.components)) {
    const owner = { kind: 'component', id: def.id };
    for (const [k, schema] of Object.entries(def.properties)) {
      if (schema.type === 'list' && !schema.feed)
        for (const id of duplicateItemIds(schema.default))
          out.push({ severity: 'error', code: 'LIST_ITEM_DUPLICATE', message: `${def.name}: ${duplicateItemMessage('its default content', schema, id)}`, owner, site: `default|${k}|${id}` });
      if (def.owner === 'theme') continue;
      for (const a of nonImageAssets(state, schema.type === 'image' || (schema.type === 'list' && !schema.feed) ? schema.default : undefined))
        out.push({ severity: 'error', code: 'ASSET_NOT_IMAGE', message: `${def.name}: the default of “${schema.label}” shows “${a.name}”, which is a ${a.kind}, not a picture. Choose an image instead.`, owner, site: `default|${k}|${a.id}` });
    }
  }
  // The site's icon and sharing images are pictures too.
  const picture = (id: unknown, what: string, site: string, owner?: Diagnostic['owner']) => {
    const a = typeof id === 'string' && Object.hasOwn(state.assets.assets, id) ? state.assets.assets[id] : undefined;
    if (a && a.kind !== 'image') out.push({ severity: 'error', code: 'ASSET_NOT_IMAGE', message: `${what} is “${a.name}”, which is a ${a.kind}, not a picture. Choose an image instead.`, owner, site });
  };
  picture(state.site.favicon, 'The site icon', 'favicon');
  picture(state.site.socialImage, 'The site’s sharing image', 'socialImage');
  picture(state.site.identity?.logo, 'The site’s logo', 'logo');
  for (const p of Object.values(state.pages)) picture(p.seo?.socialImage, `${p.title}: the page’s sharing image`, 'socialImage', { kind: 'page', id: p.id });
  return out;
}

/** What Project health and a website export say of a library image too large to make copies of (overPixelLimit). */
export const pixelLimitMessage = (a: { name: string; width?: number; height?: number }) =>
  `${a.name} is ${(a.width ?? 0).toLocaleString('en-US')} × ${(a.height ?? 0).toLocaleString('en-US')} pixels, too large to make smaller web copies of, so a page showing it sends all of it. Replace it everywhere in Assets with a copy under 100 megapixels, then remove it.`;

/** Library images too large for fast pages: what coreValidation reports last. */
function assetSizeDiagnostics(state: ProjectState): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const a of Object.values(state.assets.assets)) {
    // A picture too large to make copies of is sent whole to every visitor, however small its file (#1444).
    if (a.kind === 'image' && overPixelLimit(a.mime, a.width, a.height)) out.push({ severity: 'warning', code: 'ASSET_PIXEL_LIMIT', message: pixelLimitMessage(a), owner: { kind: 'asset', id: a.id } });
    // A download is the size it is; only what pages load and show is worth making smaller.
    else if (a.kind !== 'document' && a.bytes > 1_500_000) out.push({ severity: 'warning', code: 'ASSET_LARGE', message: `${a.name} is ${(a.bytes / 1e6).toFixed(1)} MB. Consider a smaller image for faster pages.` });
  }
  return out;
}

/**
 * The advice only Project health shows, never a reason to refuse a save: links to sections that do not exist, then the
 * pages' heading outlines, form names, fonts code may choose at run time, layout guardrails, text the elements' own colours
 * make hard to read and how reusable each project component is. `joinValidation` puts each in its place among the core's findings.
 */
export function adviceValidation(state: ProjectState, cache?: ValidationCache): AdviceValidation {
  const keep = cache ? cache.keeper(state) : freshKeeper(state);
  const links: Diagnostic[] = [];
  for (const i of missingSectionLinks(state, keep)) {
    const entry = i.owner.kind === 'entry' ? findEntry(state, i.owner.id) : undefined;
    const where =
      i.owner.kind === 'shell'
        ? i.owner.id === 'header'
          ? 'Header'
          : 'Footer'
        : i.owner.kind === 'template'
          ? `${state.collections[i.owner.id]?.settings.name ?? 'Collection'} layout`
          : entry
            ? `${entry.entry.title} (${entry.collection.settings.name})`
            : (state.pages[i.owner.id]?.title ?? 'A page');
    const what = i.label ? `the “${i.label}” link${i.inText ? ' in the text' : ''}` : `a link${i.inText ? ' in the text' : ''}`;
    const fix = i.inText ? 'Change the link in the text to a section the page has.' : 'Choose one of the page’s sections in the link’s Section list.';
    // Collection entries are named by how many there are: a blog can have hundreds. Their pages have no sections, so
    // the link has to name the page that has the section.
    const entries = i.entries ?? [];
    // An entry's own link is about its own page.
    const archives = i.archives ?? [];
    const lacking =
      entry && entries.length
        ? ['its page']
        : [
            ...(i.pages ?? []).map((id) => state.pages[id].title),
            ...(entries.length === 1 ? [`the entry “${findEntry(state, entries[0])?.entry.title ?? entries[0]}”`] : entries.length ? [`${entries.length} collection entries`] : []),
            ...(archives.length === 1 ? [`the collection index at ${archives[0]}`] : archives.length ? [`${archives.length} collection index and archive pages`] : [])
          ];
    const onEntries = entries.length || archives.length ? ` ${entries.length ? 'Entries' : 'Collection index pages'} have none of a page’s sections: point the link at the page that has the section.` : '';
    const message = i.pageId
      ? `${where}: ${what} goes to #${i.fragment} on ${state.pages[i.pageId].title}, but that page has no section with that ID. ${fix}`
      : `${where}: ${what} goes to #${i.fragment}, but ${listed(lacking)} ${lacking.length > 1 || entries.length > 1 || archives.length > 1 ? 'have' : 'has'} no section with that ID. ${fix}${onEntries}`;
    // Which link it is, where one placement shows several with the same text (one per card, say).
    // Which link it is, and where it goes: a link in text by its text, since another link added before it renumbers it. The
    // pages missing the section are left out, so fixing one of them never makes the link look newly broken.
    const which = i.inText ? [i.key.replace(/:\d+$/, ''), i.label] : [i.key];
    links.push({ severity: 'error', code: 'LINK_SECTION_MISSING', message, owner: i.owner, nodeId: i.nodeId || undefined, site: JSON.stringify([i.nodeId ?? null, ...which, i.pageId ?? null, i.fragment]) });
  }
  append(links, draftLinkDiagnostics(state, keep));
  const rest: Diagnostic[] = [...blankPageDiagnostics(state), ...unfilledImageDiagnostics(state, keep), ...headingDiagnostics(state, keep), ...formNameDiagnostics(state, keep), ...runtimeFontDiagnostics(state)];
  for (const d of layoutGuardrailDiagnostics(state, undefined, keep)) rest.push(d);
  for (const d of elementContrastDiagnostics(state, keep)) rest.push(d);
  append(rest, keep.shared('reusability', () => reusabilityDiagnostics(state)));
  return [links, rest];
}

/**
 * Where a link to a draft is, told apart from the others as long as it stays where it is: the node holding it, which of
 * its links it is (one in text by its words, since a link added before it renumbers it) and where it goes.
 */
export const draftLinkSite = (l: DraftLink) => JSON.stringify([l.nodeId || null, ...(l.inText ? [l.key.replace(/:\d+$/, ''), l.label] : [l.key]), l.pageId ?? null, l.entryId ?? null, l.anchor ?? null]);

/**
 * Links the published website shows that go to a draft page or entry (publicationPlan), which the website leaves out:
 * the website export stops on them, so Project health says so first. They never stop a save (CONTENT_ERRORS), nor
 * the AI or an undo (stopsExportOnly). With `parts`, what each page renders is kept as missingSectionLinks keeps it.
 */
export function draftLinkDiagnostics(state: ProjectState, parts?: CheckParts): Diagnostic[] {
  return publicationPlan(state, parts).draftLinks.map((l) => ({
    severity: 'error',
    code: 'LINK_TO_DRAFT',
    message: `${describeDraftLink(state, l)}, a draft the website leaves out. The website export stops until the link is changed or the ${l.entryId !== undefined ? 'entry' : 'page'} is published.`,
    owner: l.owner,
    ...(l.nodeId ? { nodeId: l.nodeId } : {}),
    site: draftLinkSite(l),
    ...(l.owner.kind === 'template' && l.shownOn ? { entryId: l.shownOn } : {})
  }));
}

/**
 * Images the published website shows as an empty placeholder box (unfilledImages): on its pages, the shared header
 * and footer while anything published shows them, and the collection layouts it uses. Drafts are left out, as the
 * website leaves them out. Each page's and shared part's are kept while its tree is the same (ValidationCache).
 */
function unfilledImageDiagnostics(state: ProjectState, keep: Keeper): Diagnostic[] {
  const live = publishedState(state);
  return websiteTrees(live).flatMap((t) =>
    keep.tree(t, 'unfilledImages', () =>
      unfilledImages(live, t.tree).map((img): Diagnostic => {
        const node = t.tree.nodes[img.nodeId];
        const what = node?.kind === 'instance' ? `${displayName(live, node)} shows ${img.name === 'Image' ? 'an image' : `“${img.name}”`}${img.item ? ` for “${img.item}”` : ''}` : img.name === 'Image' ? 'an image' : `the image “${img.name}”`;
        return { severity: 'warning', code: 'IMAGE_UNFILLED', message: `${t.label}: ${what} with no picture chosen, so visitors see an empty placeholder box. Choose a picture for it, or remove it.`, owner: t.owner, nodeId: img.nodeId, site: img.site };
      })
    )
  );
}

/** Published pages with nothing on them (see blankPages). */
function blankPageDiagnostics(state: ProjectState): Diagnostic[] {
  return blankPages(state).map((p) => ({
    severity: 'warning',
    code: 'PAGE_EMPTY',
    message: `${p.title}: this page has nothing on it, so visitors find it blank. ${p.id === state.site.homePageId ? 'Add content to it.' : 'Add content to it, keep it as a draft, or remove it.'}`,
    owner: { kind: 'page', id: p.id }
  }));
}

/** How reusable each of the project's own components is, as adviceValidation reports it last. */
function reusabilityDiagnostics(state: ProjectState): Diagnostic[] {
  const out: Diagnostic[] = [];
  // Theme components are fixed theme data; only a project's own components are its author's to make reusable.
  const tokens = effectiveTokens(state);
  for (const def of Object.values(state.components)) {
    if (def.kind !== 'managed' || def.owner !== 'project') continue;
    // Advice on a definition edited by hand into a shape it cannot have is skipped, never a reason it cannot open.
    try {
      out.push(...componentReusabilityDiagnostics(def, tokens));
    } catch {
      /* the structural checks say what is wrong with it */
    }
  }
  return out;
}

/** Every finding of `validateState`, in its order: the core's, with the advice in its two places among them. */
export function joinValidation(core: CoreValidation, advice: AdviceValidation): Diagnostic[] {
  const [links, rest] = core.at;
  return [...core.core.slice(0, links), ...advice[0], ...core.core.slice(links, rest), ...advice[1], ...core.core.slice(rest)];
}

/**
 * The definitions the published site renders: those placed on a published page or in a shared header or footer a
 * published page shows, those their designs place, and the code components their code imports.
 */
function renderedDefinitions(state: ProjectState): Set<string> {
  const pages = state.site.pageOrder.flatMap((id) => (Object.hasOwn(state.pages, id) && !isDraftPage(state, state.pages[id]) ? [state.pages[id]] : []));
  return definitionsRenderedBy(state, [...pages, ...(['header', 'footer'] as const).filter((part) => pages.some((p) => showsPart(p, part))).map((part) => state.site.shell[part])]);
}

/** The definitions `trees` render: those placed in them, those their designs place, and the code components their code imports. */
export function definitionsRenderedBy(state: ProjectState, trees: readonly NodeTree[]): Set<string> {
  const out = new Set<string>();
  const queue = trees.flatMap((t) => Object.values(t.nodes).flatMap((n) => (n.kind === 'instance' ? [n.definitionId] : [])));
  while (queue.length) {
    const id = queue.pop()!;
    const def = Object.hasOwn(state.components, id) ? state.components[id] : undefined;
    if (!def || out.has(id)) continue;
    out.add(id);
    if (def.tree) for (const n of Object.values(def.tree.nodes)) if (n.kind === 'instance') queue.push(n.definitionId);
    if (def.kind === 'code') for (const other of Object.values(state.components)) if (codeNeeds(state, def, other.id)) queue.push(other.id);
  }
  return out;
}

/**
 * Project code components that may choose a theme font while they run. The site ships only the theme fonts whose
 * family name its documents spell out, so a family made up in code can be left out: each one the site renders is
 * flagged while a theme font is left out, until its source says which theme fonts it uses in a `Fonts:` comment. A
 * theme's own components are known to name theirs.
 */
export function runtimeFontDiagnostics(state: ProjectState): Diagnostic[] {
  const families = installedFonts(state).map((f) => f.family);
  const candidates = Object.values(state.components).filter((d) => d.kind === 'code' && d.owner === 'project' && choosesFontAtRunTime(d.source ?? '') && !declaresFonts(d.source ?? '', families));
  if (!candidates.length) return [];
  const rendered = renderedDefinitions(state);
  const code = candidates.filter((d) => rendered.has(d.id));
  if (!code.length) return [];
  const used = new Set(usedPackFonts(state, effectiveTokens(state).map((t) => t.value)).map((f) => f.family));
  const left = installedFonts(state).filter((f) => !used.has(f.family));
  if (!left.length) return [];
  return code
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((def) => ({
      severity: 'warning' as const,
      code: 'FONT_USAGE_UNVERIFIED',
      message: `${def.name} sets a font in its code, where the export cannot tell which family it is, so a theme font it shows (${listed(left.map((f) => f.name))}) may be left out of the site. Name the theme fonts it uses in a comment in its source, such as <!-- Fonts: ${left[0].family} -->, so the export includes them, or use a font site style.`,
      owner: { kind: 'component', id: def.id }
    }));
}

/** A collection's layout as Project health names it (templateTrees): "Posts layout", "Posts archive layout". */
const layoutName = (state: ProjectState, owner: OwnerRef) => `${state.collections[owner.id]?.settings.name ?? owner.id} ${owner.kind === 'archive' ? 'archive layout' : 'layout'}`;

/** Where a form is, for a message: its page's title, the shared header or footer, or a collection's layout. */
const formPlace = (state: ProjectState, f: FormNameClash['forms'][number]) =>
  f.owner.kind === 'shell'
    ? f.owner.id === 'header'
      ? 'the shared header'
      : 'the shared footer'
    : f.owner.kind === 'template' || f.owner.kind === 'archive'
      ? `the ${layoutName(state, f.owner)}`
      : (state.pages[f.owner.id]?.title ?? 'a page');

/** What is wrong with forms that send to Netlify under one form name, said once for all of them. */
export function formNameClashMessage(state: ProjectState, clash: FormNameClash): string {
  const counts = new Map<string, number>();
  for (const f of clash.forms) counts.set(formPlace(state, f), (counts.get(formPlace(state, f)) ?? 0) + 1);
  const places = listed([...counts].map(([place, n]) => (n > 1 ? `${n} on ${place}` : place)));
  // Contact forms, signup forms, or forms of both kinds.
  const nouns = new Set(clash.forms.map((f) => {
    const n = allTrees(state).find((t) => t.owner.kind === f.owner.kind && t.owner.id === f.owner.id)?.tree.nodes[f.nodeId];
    return formNoun(n?.kind === 'instance' ? state.components[n.definitionId] : undefined);
  }));
  const kind = nouns.size === 1 ? `${[...nouns][0]}s` : 'forms';
  return `${clash.forms.length} ${kind} send to the Netlify form “${clash.name}” (${places}), so Netlify files their messages together. Give each form its own Netlify form name.`;
}

/**
 * Contact forms that send to Netlify under one form name, each flagged where it is: Netlify would file their messages
 * together. A warning, so the site still saves and exports, but it is listed before an export.
 */
export function formNameDiagnostics(state: ProjectState, parts?: CheckParts): Diagnostic[] {
  return netlifyFormClashes(state, parts).flatMap((clash) => {
    const message = formNameClashMessage(state, clash);
    const label = (f: FormNameClash['forms'][number]) =>
      f.owner.kind === 'shell' ? (f.owner.id === 'header' ? 'Header' : 'Footer') : f.owner.kind === 'template' || f.owner.kind === 'archive' ? layoutName(state, f.owner) : formPlace(state, f);
    // A form shown more than once (through a slot inside a list) is flagged once where it is.
    const forms = clash.forms.filter((f, i) => clash.forms.findIndex((g) => g.owner.kind === f.owner.kind && g.owner.id === f.owner.id && g.nodeId === f.nodeId) === i);
    return forms.map((f) => ({ severity: 'warning' as const, code: 'FORM_NAME_DUPLICATE', message: `${label(f)}: ${message}`, owner: f.owner, nodeId: f.nodeId }));
  });
}

/**
 * Project health's finding for a placed contact form that visitors cannot send (no form service, or not the setting it
 * needs), or undefined when it can send or is not a contact form. A form in a component's own design is judged where
 * the component is placed, so a component owner has none. Its service and setting are never an entry's (#1127,
 * engine/collection-sources.ts), so a layout's form is judged once, by its own settings.
 */
export function formConnectionDiagnostic(state: ProjectState, owner: OwnerRef, label: string, node: GraphNode): Diagnostic | undefined {
  if (owner.kind === 'component' || node.kind !== 'instance') return undefined;
  const def = state.components[node.definitionId];
  if (!def || !readsFormServices(def)) return undefined;
  const what = formNoun(def);
  const found = (problem: string | undefined): Diagnostic | undefined =>
    problem ? { severity: 'warning', code: 'FORM_UNCONNECTED', message: `${label}: the ${what} is not connected to a form service, so visitors cannot send it. ${problem}`, owner, nodeId: node.id } : undefined;
  // A setting written by hand that cannot be read as text is not this check's to report, and must not stop the others.
  const problemOf = (props: () => Record<string, unknown>) => {
    try {
      return formConnectionProblem(def, props());
    } catch {
      return undefined;
    }
  };
  // A binding outside a component has nothing to bind to and is exported empty, so the default decides. One to an entry
  // is refused (COLLECTION_SOURCE) and keeps the site from being exported, so the form is judged without it.
  return found(problemOf(() => Object.fromEntries(Object.entries(node.props).filter(([, v]) => !isBinding(v)))));
}

/**
 * The trees the website shows, of a published state (publishedState), named as Project health names them: the pages
 * in site order, then the shared header and footer when a page, an entry or an archive page shows them, then the
 * layout of each collection with an entry and each archive layout an archive page shows (shownArchiveLayouts), which
 * a collection's index shows before any entry is published.
 */
export function websiteTrees(live: ProjectState): Array<{ owner: OwnerRef; tree: NodeTree; label: string }> {
  const entries = siteEntries(live).filter((e) => !isDraftEntry(e.entry));
  const collections = new Set(entries.map((e) => e.collection.settings.id));
  const archives = new Set(shownArchiveLayouts(live).map((a) => a.collectionId));
  const archived = archivePages(live).length > 0;
  const pages = live.site.pageOrder.filter((id) => Object.hasOwn(live.pages, id)).map((id) => live.pages[id]);
  return [
    ...pages.map((p) => ({ owner: { kind: 'page' as const, id: p.id }, tree: p, label: p.title })),
    ...SHELL_PARTS.filter((part) => entries.length > 0 || archived || pages.some((p) => showsPart(p, part))).map((part) => ({ owner: { kind: 'shell' as const, id: part }, tree: live.site.shell[part], label: part === 'header' ? 'Header' : 'Footer' })),
    ...templateTrees(live).filter((t) => (t.owner.kind === 'archive' ? archives : collections).has(t.owner.id))
  ];
}

/**
 * The contact forms the website publishes that visitors cannot send, each as Project health reports it, in the order
 * of websiteTrees. Drafts are left out, as the website leaves them out.
 */
export function websiteFormProblems(state: ProjectState): Diagnostic[] {
  const live = publishedState(state);
  return websiteTrees(live).flatMap(({ owner, tree, label }) => Object.values(tree?.nodes ?? {}).flatMap((n) => formConnectionDiagnostic(live, owner, label, n) ?? []));
}

/** The website's forms visitors cannot send (websiteFormProblems) as export notes, each leading to its form's settings. */
export function websiteFormNotes(state: ProjectState): ExportNote[] {
  return websiteFormProblems(state).flatMap((d): ExportNote[] => (d.owner && d.nodeId ? [{ message: d.message, destination: { kind: 'form', owner: d.owner as OwnerRef, nodeId: d.nodeId, setting: 'connection' } }] : []));
}

/** A heading's words, quoted, for a message. */
const quoted = (text: string) => (text ? `“${text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text}”` : 'an empty heading');

/**
 * Each page's heading outline, as warnings to review: they never block a save or an export, since a second Heading 1
 * can be deliberate. Each names the heading to change, and the page it is on.
 */
export function headingDiagnostics(state: ProjectState, keep: Keeper = freshKeeper(state)): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const id of state.site.pageOrder) {
    const page = Object.hasOwn(state.pages, id) ? state.pages[id] : undefined;
    if (page) append(out, keep.tree({ owner: { kind: 'page', id }, tree: page, label: page.title }, 'headings', () => pageHeadingDiagnostics(state, id, page)));
  }
  return out;
}

/** The heading outline of the page listed as `id`, as headingDiagnostics reports it. */
function pageHeadingDiagnostics(state: ProjectState, id: string, page: PageDoc): Diagnostic[] {
  const out: Diagnostic[] = [];
  const owner = { kind: 'page', id };
  // The shared header and footer never count toward a page's review: they are left out of the walk.
  const { outline, review } = pageHeadings(state, id, { shell: false });
  if (review.missingTitle)
    out.push({ severity: 'warning', code: 'HEADING_MISSING_H1', message: `${page.title}: no heading is a Heading 1, so the page has no title for screen readers to announce. Make the page’s main heading Heading 1.`, owner });
  if (review.extraTitles) {
    const titles = review.titles.map((i) => outline[i]);
    const names = listed([...new Set(titles.map((h) => quoted(h.text)))]);
    const lead = titles.length === 1 ? `the Heading 1 ${names} is shown more than once` : `${titles.length} headings are Heading 1s (${names})`;
    const second = titles[1] ?? titles[0];
    out.push({
      severity: 'warning',
      code: 'HEADING_MULTIPLE_H1',
      message: `${page.title}: ${lead}, so screen readers announce more than one page title. Keep the page’s title as Heading 1 and make the others Heading 2, unless they are meant to be titles.`,
      owner,
      nodeId: second.nodeId
    });
  }
  for (const skip of review.skips) {
    const h = outline[skip.index];
    out.push({
      severity: 'warning',
      code: 'HEADING_LEVEL_SKIP',
      message: `${page.title}: ${quoted(h.text)} is a Heading ${h.level} right after a Heading ${skip.after}, so the outline skips a level. Make it Heading ${skip.suggest}.`,
      owner,
      nodeId: h.nodeId
    });
  }
  return out;
}

const ELEMENT_TAG_SET = new Set<string>(ELEMENT_TAGS);
const TEXT_TAG_SET = new Set<string>(TEXT_TAGS);

/** A plain binding names exactly one property, item field or UI state variable; anything else in it would be silently ignored. */
const plainBinding = (v: unknown) => {
  if (!isBindingRef(v)) return false;
  const r = v as Record<string, unknown>;
  const keys = Object.keys(v);
  // `{ $item }`, `{ $prop }`, or `{ $prop, field }` for one field of an object property.
  if (keys.length === 2 && typeof r.$prop === 'string' && typeof r.field === 'string') return true;
  return keys.length === 1 && typeof r[keys[0]] === 'string';
};

/** Whether a binding place reads a field of a collection loop's row (`{ $item }`), as an element inside one may. */
const readsRowField = (slot: { field: string; value: unknown }) => {
  const b = slot.field === 'when' || slot.field === 'unless' ? conditionRef(slot.value) : slot.value;
  return isBinding(b) && '$item' in b;
};

/** Whether a binding place of a node in a tree owned by `kind` reads a collection entry, as only a layout's may. */
const readsEntry = (kind: string, slot: { field: string; value: unknown }) => kind === 'template' && isEntryBinding(conditionRef(slot.value) ?? slot.value);

/**
 * What is wrong with the entry fields one element of a collection's layout reads: each a message that follows the
 * element's name. A field the collection does not have, of a type the place cannot show, or compared with a value of
 * another type.
 */
function entryBindingProblems(state: ProjectState, collection: Collection, n: GraphNode): string[] {
  const out: string[] = [];
  for (const slot of bindingSlots(n)) {
    const condition = slot.field === 'when' || slot.field === 'unless';
    const b = condition ? conditionRef(slot.value) : isBindingRef(slot.value) ? slot.value : undefined;
    if (!b || !isEntryBinding(b)) continue;
    if (condition ? !conditionShapeValid(slot.value) : !plainBinding(b)) {
      out.push(`reads the entry field "${String(b.$entry).slice(0, 60)}" together with something else as its ${slot.field}; read one of them.`);
      continue;
    }
    const schema = entryFieldSchema(collection, b.$entry);
    if (!schema) {
      out.push(`shows "${String(b.$entry).slice(0, 60)}", which entries of ${collection.settings.name} do not have.`);
      continue;
    }
    // A choice field without its options is reported with the collection's settings; nothing more is read from it.
    if (schema.type === 'enum' && !Array.isArray((schema as { options?: unknown }).options)) continue;
    if (!ENTRY_CONTENT_FIELDS.has(slot.field)) {
      out.push(`takes its ${slot.field === 'variant' ? 'variant' : slot.field} from "${schema.label}"; that is the layout's own, the same for every entry. Only content can show an entry's field.`);
      continue;
    }
    if (slot.field === 'datetime' && !isEntryDateField(collection, b.$entry)) {
      out.push(`states "${schema.label}" as its date, which is not a date.`);
      continue;
    }
    const nested = slot.field === 'prop' && n.kind === 'instance' ? state.components[n.definitionId]?.properties : undefined;
    if (slot.field === 'prop' && !(nested && slot.prop !== undefined && Object.hasOwn(nested, slot.prop))) {
      out.push(`shows "${schema.label}" in "${slot.prop}", which the placed component does not have.`);
      continue;
    }
    const ok = acceptedTypes(n, slot.field, nested?.[slot.prop!]);
    if (ok && !ok.includes(schema.type)) {
      out.push(`shows "${schema.label}" (${schema.type === 'string' ? 'text' : schema.type}) as its ${slot.field === 'prop' ? `"${slot.prop}"` : slot.field}, which needs ${ok.map((t) => (t === 'string' ? 'text' : t)).join(' or ')}.`);
      continue;
    }
    const choice = slot.field === 'prop' ? entryChoiceProblem(schema, nested?.[slot.prop!]) : null;
    if (choice) {
      out.push(`shows "${schema.label}" in "${slot.prop}", but it ${choice}`);
      continue;
    }
    const comparison = condition && isComparison(slot.value) ? slot.value : undefined;
    const compared = comparison ? entryComparisonProblem(collection, b.$entry) : null;
    if (compared) {
      out.push(`compares ${compared}`);
      continue;
    }
    const problem = bindingProblem(state, { node: n, field: slot.field, prop: slot.prop, comparison }, schema);
    if (problem) out.push(problem);
  }
  return out;
}

/** A condition is a plain binding (or UI state), or one (`ref`) compared with one string, number or yes/no value. */
function conditionShapeValid(v: unknown): boolean {
  if (plainBinding(v)) return true;
  if (!isComparison(v) || !plainBinding(v.ref)) return false;
  const keys = Object.keys(v);
  const value = 'eq' in v ? v.eq : v.ne;
  return keys.length === 2 && (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)));
}

/**
 * What is wrong with a managed definition's roots, or null. The generator gives `rootIds[0]` the component's classes,
 * anchor and variant rules, so a design has exactly one root, and it renders an element of its own.
 */
function componentRootProblem(tree: NodeTree): { message: string; renders: boolean } | null {
  if (!tree.rootIds.length) return { message: 'its design has no top-level element, so nothing of it shows.', renders: false };
  const root = Object.hasOwn(tree.nodes, tree.rootIds[0]) ? tree.nodes[tree.rootIds[0]] : undefined;
  const renders = !!root && root.kind !== 'repeat' && root.kind !== 'slot';
  if (tree.rootIds.length > 1)
    return { message: `its design has ${tree.rootIds.length} top-level elements, but only the first carries the component's styles, variants and anchor. Move the others inside it, or remove them.`, renders };
  if (!renders && root) return { message: `its top-level element is a ${root.kind}, which shows no element of its own to carry the component's styles. Put it inside a container.`, renders };
  return null;
}

/** Library records other than images that a value shows as pictures (`{ assetId }`, at any depth). */
function nonImageAssets(state: ProjectState, v: unknown, out: ProjectState['assets']['assets'][string][] = []) {
  if (Array.isArray(v)) v.forEach((x) => nonImageAssets(state, x, out));
  else if (v && typeof v === 'object' && !isBinding(v)) {
    const id = (v as { assetId?: unknown }).assetId;
    const a = typeof id === 'string' && Object.hasOwn(state.assets.assets, id) ? state.assets.assets[id] : undefined;
    if (a && a.kind !== 'image') out.push(a);
    Object.values(v).forEach((x) => nonImageAssets(state, x, out));
  }
  return out;
}

/** The item IDs a list holds more than once: a keyed list cannot show two items with one ID. */
function duplicateItemIds(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const item of list) {
    const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
    if (typeof id !== 'string') continue;
    if (seen.has(id)) twice.add(id);
    seen.add(id);
  }
  return [...twice];
}

const duplicateItemMessage = (where: string, schema: { label: string; itemLabel?: string }, id: string) =>
  `in ${where}, more than one ${(schema.itemLabel ?? 'item').toLowerCase()} in “${schema.label}” has the ID "${id}", so the list cannot be shown. Give each one an ID of its own.`;

const nodeLabel = (n: GraphNode) => (n.name ? `“${n.name}”` : n.kind === 'link' ? 'a button' : n.kind === 'instance' ? 'a nested component' : `a ${n.kind} element`);

/**
 * Why an element that is a query container (`containerType: inline-size`) at some size may get no width, or null. A
 * query container's content never widens it, so it is as narrow as its padding wherever its width comes from its
 * content: its own width fits its content; it sits in a horizontal stack with no grow or width of its own, or in a
 * vertical stack that aligns its items rather than stretching them, with no width of its own; or in a grid with a
 * column sized by its content (auto, min-content, max-content, fit-content). A repeat lays out no box of its own, so
 * the parent is the one around it. Read across every size the rules name: a warning, not a proof.
 */
function queryContainerCollapse(n: GraphNode & { kind: 'element' }, parentOf: Map<string, GraphNode>): string | null {
  const resting = (styles: ResponsiveStyles | undefined) => Object.entries(styles ?? {}).flatMap(([k, v]) => (parseStyleScopeKey(k)?.state || !v || typeof v !== 'object' ? [] : [v]));
  const own = resting(n.styles);
  if (!own.some((r) => r.containerType === 'inline-size')) return null;
  if (own.some((r) => r.width === 'fit')) return 'that fits its content';
  let parent = parentOf.get(n.id);
  for (let hops = 0; parent?.kind === 'repeat' && hops < 50; hops++) parent = parentOf.get(parent.id);
  if (parent?.kind !== 'element') return null;
  const around = resting(parent.styles);
  const width = own.some((r) => (r.width !== undefined && r.width !== 'auto' && r.width !== 'fit') || (r.minWidth !== undefined && r.minWidth !== 'auto' && String(r.minWidth).trim() !== '0' && String(r.minWidth).trim() !== '0px'));
  if (around.some((r) => r.layout === 'row') && !width && !own.some((r) => Number(r.flexGrow) > 0)) return 'in a horizontal stack that sizes it to its content';
  if (around.some((r) => r.layout === 'stack') && around.some((r) => typeof r.align === 'string' && r.align !== 'stretch') && !width && !own.some((r) => r.alignSelf === 'stretch'))
    return 'in a vertical stack that aligns its items instead of stretching them';
  // A column sized by its content, not an as-many-as-fit preset (auto-fit, auto-fill), whose columns share the room.
  if (around.some((r) => r.layout === 'grid') && around.some((r) => typeof r.gridTemplate === 'string' && /(^|[\s(,])(auto|min-content|max-content|fit-content)(?![\w-])/.test(r.gridTemplate)) && !width)
    return 'in a grid with a column sized by its content, where it may sit';
  return null;
}

/**
 * Checks that catch documents edited outside the editor: unknown HTML tags, slots that do not match their
 * definition, definitions that contain themselves, and site styles that loop or point at nothing.
 */
function structureDiagnostics(state: ProjectState, keep: Keeper): Diagnostic[] {
  const out: Diagnostic[] = [];
  const styles: StyleContext = { state, tokenIds: new Set(declaredTokens(state).map((t) => t.id)), groupOf: new Map(declaredTokens(state).map((t) => [t.id, t.group])) };
  const { tokenIds, groupOf } = styles;
  const lookups = new Map<string, (nodeId: string) => string | null>();
  // Theme definitions are fixed theme data, checked when the theme is built.
  const trees = allTrees(state).filter((t) => t.owner.kind !== 'component' || state.components[t.owner.id]?.owner !== 'theme');
  const nesting = treeNesting(state, keep, trees);
  for (const [i, t] of trees.entries()) {
    const def = t.owner.kind === 'component' ? state.components[t.owner.id] : undefined;
    let groups: ((nodeId: string) => string | null) | undefined;
    const group = (nodeId: string) => (groups ??= groupLookup(t.tree))(nodeId);
    append(out, keep.tree(t, 'structure', () => nodeStructure(styles, lookups, t, def, group)));
    // HTML the browser would rebuild (a block in a paragraph), or a list item, term or caption outside its list or figure.
    // A container directly in a list is a warning: lists are built that way, one edit at a time.
    for (const p of nesting[i]) out.push({ severity: p.severity, code: 'TAG_NESTING', message: `${t.label}: ${p.message}`, owner: t.owner, nodeId: p.nodeId, site: p.site });
    if (def) append(out, keep.tree(t, 'design', () => designStructure(styles, t, def, group)));
  }
  // Lists connected to a collection, collection loops and what their elements read of each entry.
  const destination = formDestinationLookup(state);
  for (const t of allTrees(state))
    append(out, keep.tree(t, 'collectionSources', () => collectionSourceProblems(state, [t], destination).map((p): Diagnostic => ({ severity: 'error', code: 'COLLECTION_SOURCE', message: `${p.label}: ${nodeLabel(p.node)} ${p.message}`, owner: p.owner, nodeId: p.nodeId, site: p.key }))));
  // Slot declarations of the project's own components, code components included (theme ones are checked by the loader).
  append(out, keep.shared('slots', () => slotDeclarationDiagnostics(state)));
  // A token property names a token of its own group. One that is gone (a hand edit, a theme without it) shows nothing.
  // Each tree's placements in turn, then the project's own definitions' defaults.
  const tokenProps = (opts: { trees: CheckedTree[]; defaults: boolean }) => {
    const found: Diagnostic[] = [];
    forEachTokenPropRef(state, (id, site) => {
      const where = { owner: site.owner, ...(site.nodeId ? { nodeId: site.nodeId } : {}) };
      if (!tokenIds.has(id)) found.push({ severity: 'error', code: 'TOKEN_MISSING', message: `${site.label}: a component property uses the site style "${id}", which does not exist.`, ...where });
      else if (groupOf.get(id) !== site.tokenGroup) found.push({ severity: 'error', code: 'TOKEN_MISSING', message: `${site.label}: a component property uses the site style "${id}", which is not a ${site.tokenGroup} style.`, ...where });
    }, { themeDesigns: true, ...opts });
    return found;
  };
  for (const t of allTrees(state)) append(out, keep.tree(t, 'tokenProps', () => tokenProps({ trees: [t], defaults: false })));
  append(out, keep.shared('tokenPropDefaults', () => tokenProps({ trees: [], defaults: true })));
  // The site styles themselves, and definitions that place themselves.
  append(out, keep.shared('tokens', () => tokenDiagnostics(state, styles)));
  return out;
}

/**
 * Each tree's nesting problems, checked in turn with one reading of the project. A tree's are kept unless its check read
 * where a design is placed (another document's placements can change it) or a check so far met a document holding
 * itself: from then on each check depends on the ones before it, so every tree is checked again, in turn, as a
 * validation of the state alone checks them.
 */
function treeNesting(state: ProjectState, keep: Keeper, trees: CheckedTree[]): NestingProblem[][] {
  const nesting = trackedNestingChecker(state);
  const found = trees.map((t) => keep.tree(t, 'nesting', () => nesting.check(t.owner, t.tree), (r) => !r.readPlacements && !nesting.cycles()).problems);
  if (!nesting.cycles()) return found;
  const again = trackedNestingChecker(state);
  return trees.map((t) => again.check(t.owner, t.tree).problems);
}

/** What structureDiagnostics reads to check style rules, the same for every tree. */
interface StyleContext {
  state: ProjectState;
  tokenIds: ReadonlySet<string>;
  groupOf: ReadonlyMap<string, string>;
}

/** A check of style rules, adding what it finds to `out`. */
function styleChecker({ state, tokenIds, groupOf }: StyleContext, out: Diagnostic[]) {
  return (rs: ResponsiveStyles | undefined, label: string, owner: Diagnostic['owner'], nodeId?: string, layer = 'own', grouped = true, what = 'it') => {
    // Group states with no group around the element: kept, so turning a group back on restores them, but never shown.
    if (!grouped && hasGroupStyles(rs))
      out.push({
        severity: 'warning',
        code: 'STYLE_GROUP_MISSING',
        message: `${label}: ${what} has styles for while its group is hovered or has focus, but no interaction group encloses it, so they never show. Mark a container around it as an interaction group, or reset those styles.`,
        owner,
        nodeId,
        site: `${nodeId ?? ''}|${layer}|group`
      });
    for (const [scopeId, scope] of Object.entries(rs ?? {})) {
      const at = parseStyleScopeKey(scopeId);
      // Rules under a key that names no size or state reach no stylesheet; the site styles they name are still checked.
      if (!at) out.push({ severity: 'error', code: 'STYLE_SCOPE_INVALID', message: `${label}: some styles are kept under "${scopeId}", which is neither a screen size, a container width nor a hover, focus or pressed state.`, owner, nodeId, site: `${nodeId ?? ''}|${layer}|${scopeId}` });
      for (const [prop, v] of Object.entries(scope ?? {})) {
        if (at?.state && !isStateStyleProp(prop, at.state))
          out.push({ severity: 'error', code: 'STYLE_STATE_PROPERTY', message: `${label}: ${stateStyleError(prop, at.state)}`, owner, nodeId, site: `${nodeId ?? ''}|${layer}|${scopeId}|${prop}` });
        // Written nowhere: the stylesheet folds visibility for screen sizes only.
        const inContainer = at && isContainerScope(at.scope) ? containerStyleError(prop) : null;
        if (inContainer) out.push({ severity: 'error', code: 'STYLE_CONTAINER_PROPERTY', message: `${label}: ${inContainer}`, owner, nodeId, site: `${nodeId ?? ''}|${layer}|${scopeId}|${prop}` });
        // A background image names a library image, and is written only while it does.
        if (Object.hasOwn(STYLE_PROP_MAP, prop) && STYLE_PROP_MAP[prop].kind === 'media') {
          const site = `${nodeId ?? ''}|${layer}|${scopeId}|${prop}`;
          const shape = validateStyleValue(prop, v as StyleValue);
          const asset = shape ? undefined : Object.hasOwn(state.assets.assets, (v as BackgroundImageValue).assetId) ? state.assets.assets[(v as BackgroundImageValue).assetId] : undefined;
          if (shape) out.push({ severity: 'error', code: 'STYLE_VALUE_INVALID', message: `${label}: ${shape} Nothing is written for it until it is fixed.`, owner, nodeId, site });
          else if (!asset) out.push({ severity: 'error', code: 'ASSET_MISSING', message: `${label}: a background image references a missing asset. Nothing is written for it until another picture is chosen.`, owner, nodeId, site });
          else if (!isPictureAsset(asset)) out.push({ severity: 'error', code: 'ASSET_NOT_IMAGE', message: `${label}: a background image shows “${asset.name}”, which is ${asset.kind === 'image' ? 'not a picture file' : `a ${asset.kind}, not a picture`}. Choose an image instead.`, owner, nodeId, site });
          continue;
        }
        const token = v && typeof v === 'object' && typeof (v as { token?: unknown }).token === 'string' ? (v as { token: string }).token : undefined;
        // What the stylesheet writes nothing for, from a document edited or imported outside the editor: a link holding
        // more than its token that the property cannot take, or a backdrop blur or grid packing or row size outside its grammar.
        const unwritten =
          v && typeof v === 'object' && token === undefined
            ? 'A token reference must name its site style in "token".'
            : token !== undefined && Object.keys(v as object).length > 1 && Object.hasOwn(STYLE_PROP_MAP, prop)
            ? linkShapeError(prop, v as StyleTokenRef)
            : (prop === 'backdropBlur' || prop === 'gridAutoFlow' || prop === 'gridAutoRows') && token === undefined
              ? validateStyleValue(prop, v as StyleValue)
              : null;
        if (unwritten) out.push({ severity: 'error', code: 'STYLE_VALUE_INVALID', message: `${label}: ${unwritten} Nothing is written for it until it is fixed.`, owner, nodeId, site: `${nodeId ?? ''}|${layer}|${scopeId}|${prop}` });
        if (token === undefined) continue;
        if (!tokenIds.has(token)) {
          out.push({ severity: 'error', code: 'TOKEN_MISSING', message: `${label}: a style uses the site style "${token}", which does not exist.`, owner, nodeId });
          continue;
        }
        // A site style of another kind writes a value the property cannot take (a color as a text style).
        const style = Object.hasOwn(STYLE_PROP_MAP, prop) ? STYLE_PROP_MAP[prop] : undefined;
        if (!style) continue;
        const groups: readonly string[] = style.tokenGroup === undefined ? [] : Array.isArray(style.tokenGroup) ? style.tokenGroup : [style.tokenGroup];
        const group = groupOf.get(token);
        if (group === 'container' && style.containerTokens && !style.containerTokens.includes(token))
          out.push({ severity: 'error', code: 'TOKEN_GROUP', message: `${label}: ${style.label} uses the page width "${token}", which would push the page sideways; use the page gutter, or Max width for a page width.`, owner, nodeId });
        else if (group !== undefined && !groups.includes(group))
          out.push({
            severity: 'error',
            code: 'TOKEN_GROUP',
            message: groups.length
              ? `${label}: ${style.label} uses the site style "${token}", which is a ${group} style; it needs a ${groups.join(' or ')} style.`
              : `${label}: ${style.label} uses the site style "${token}", but it cannot use a site style.`,
            owner,
            nodeId,
            site: `${nodeId ?? ''}|${layer}|${scopeId}|${prop}`
          });
      }
    }
  };
}

/** One tree's nodes as structureDiagnostics checks them: tags, scope, slots, placed variants and styles. */
function nodeStructure(styles: StyleContext, lookups: Map<string, (nodeId: string) => string | null>, { owner, tree, label }: CheckedTree, def: ComponentDefinition | undefined, group: (nodeId: string) => string | null): Diagnostic[] {
  const { state } = styles;
  const out: Diagnostic[] = [];
  const checkStyles = styleChecker(styles, out);
  const parentOf = new Map(Object.values(tree.nodes).flatMap((p) => childLists(p).flatMap((l) => l.ids.map((c) => [c, p] as const))));
  const inLoop = loopMembers(tree);
  for (const n of Object.values(tree.nodes)) {
    const collapse = n.kind === 'element' ? queryContainerCollapse(n, parentOf) : null;
    if (collapse) out.push({ severity: 'warning', code: 'CONTAINER_COLLAPSE', message: `${label}: ${nodeLabel(n)} is a query container ${collapse}, so it can shrink to nothing: a query container's width never comes from what is inside it. Give it a width (or Grow in a horizontal stack), or set Query container to None.`, owner, nodeId: n.id, site: `${n.id}|containerType` });
    // Only a container can be an interaction group, and it is one by `true`.
    if (Object.hasOwn(n, 'interactionGroup') && (n.kind !== 'element' || (n as { interactionGroup?: unknown }).interactionGroup !== true))
      out.push({ severity: 'error', code: 'GROUP_INVALID', message: `${label}: ${nodeLabel(n)} is marked as an interaction group, which only a container can be, by true.`, owner, nodeId: n.id, site: `${n.id}|interactionGroup` });
    if (n.kind === 'element' && !isBinding(n.tag) && !ELEMENT_TAG_SET.has(n.tag)) out.push({ severity: 'error', code: 'TAG_INVALID', message: `${label}: "${String(n.tag)}" is not a supported element tag.`, owner, nodeId: n.id });
    if (n.kind === 'text' && !isBinding(n.tag) && !TEXT_TAG_SET.has(n.tag)) out.push({ severity: 'error', code: 'TAG_INVALID', message: `${label}: "${String(n.tag)}" is not a supported text tag.`, owner, nodeId: n.id });
    // A carousel's buttons go beside its list, which only a plain list can have.
    if ((n as { carousel?: unknown }).carousel !== undefined && !isCarouselTrack(n))
      out.push({ severity: 'error', code: 'CAROUSEL_INVALID', message: `${label}: ${nodeLabel(n)} is marked as a carousel, which only a bulleted list (ul) that is not itself a link can be.`, owner, nodeId: n.id });
    if (n.kind === 'text' && n.datetime !== undefined && (n.rich || (!isBinding(n.datetime) && (typeof n.datetime !== 'string' || (n.datetime.trim() !== '' && !isArticleDate(n.datetime.trim()))))))
      out.push({ severity: 'error', code: 'DATETIME_INVALID', message: `${label}: ${nodeLabel(n)} ${n.rich ? 'is rich text, which cannot state a date' : 'states a date that is not written YYYY-MM-DD'}.`, owner, nodeId: n.id });
    // A page or the shared header and footer has no UI state to open a dialog with (a design's are checked with its state).
    if (!def && (n as { overlay?: unknown }).overlay !== undefined)
      out.push({ severity: 'error', code: 'OVERLAY_INVALID', message: `${label}: ${nodeLabel(n)} shows over the page as a dialog or drawer, which only a container in a component’s design can.`, owner, nodeId: n.id, site: `${n.id}|overlay` });
    if (n.kind === 'slot' && !def) out.push({ severity: 'error', code: 'SLOT_INVALID', message: `${label}: slots can only be placed inside a component definition.`, owner, nodeId: n.id });
    // Properties and list items belong to a component: a page or the shared header and footer has none to show. A
    // collection loop shows entries anywhere, and what its elements read of them is checked with it (below).
    else if (n.kind === 'repeat' && !def && !isCollectionLoop(n)) out.push({ severity: 'error', code: 'BINDING_SCOPE', message: `${label}: a repeat shows a component's list, so it can only be placed inside a component definition.`, owner, nodeId: n.id, site: n.id });
    else if (!def && bindingSlots(n).some((sl) => !readsEntry(owner.kind, sl) && !(inLoop.has(n.id) && readsRowField(sl)) && (sl.field === 'when' || sl.field === 'unless' ? conditionRef(sl.value) : isBindingRef(sl.value))))
      out.push({
        severity: 'error',
        code: 'BINDING_SCOPE',
        message: bindingSlots(n).some((sl) => isEntryBinding(conditionRef(sl.value) ?? sl.value))
          ? `${label}: ${nodeLabel(n)} shows a field of a collection entry, which only an element of a collection's layout can.`
          : `${label}: ${nodeLabel(n)} shows a component property, list item field or UI state, which only an element inside a component definition can.`,
        owner,
        nodeId: n.id,
        site: n.id
      });
    else if (owner.kind === 'template' && Object.hasOwn(state.collections, owner.id))
      for (const problem of entryBindingProblems(state, state.collections[owner.id], n)) out.push({ severity: 'error', code: 'BINDING_INVALID', message: `${label}: ${nodeLabel(n)} ${problem}`, owner, nodeId: n.id, site: n.id });
    else if (n.kind === 'slot' && def && !Object.hasOwn(def.slots ?? {}, n.slot))
      out.push({ severity: 'error', code: 'SLOT_INVALID', message: `${label}: the slot "${n.slot}" is not declared by the component.`, owner, nodeId: n.id });
    // A fallback damaged by hand shows nothing until it is fixed.
    if (n.kind === 'slot' && n.children !== undefined && (!Array.isArray(n.children) || n.children.some((c) => typeof c !== 'string')))
      out.push({ severity: 'error', code: 'SLOT_INVALID', message: `${label}: the fallback content of the slot "${n.slot}" is not a list of elements.`, owner, nodeId: n.id, site: `${n.id}|fallback` });
    // Checked on its own, so a read reported on the same button never hides an action added to it.
    if (!def && Object.hasOwn(n, 'stateAction'))
      out.push({ severity: 'error', code: 'BINDING_SCOPE', message: `${label}: ${nodeLabel(n)} changes UI state, which only a button inside a component definition can.`, owner, nodeId: n.id, site: `${n.id}|stateAction` });
    if (n.kind === 'instance') {
      const target = state.components[n.definitionId];
      for (const s of Object.keys(n.slots ?? {})) {
        const placed = n.slots![s];
        if (!Array.isArray(placed)) {
          out.push({ severity: 'error', code: 'SLOT_INVALID', message: `${label}: the content placed in "${s}" of ${displayName(state, n)} is damaged and cannot be shown.`, owner, nodeId: n.id });
          continue;
        }
        if (target && !Object.hasOwn(target.slots ?? {}, s)) {
          out.push({ severity: 'error', code: 'SLOT_INVALID', message: `${label}: content is placed in "${s}", which ${target.name} does not have.`, owner, nodeId: n.id });
          continue;
        }
        // What the slot holds must be what it takes, and no more than it holds (a hand edit, or a contract tightened since).
        const decl = target ? slotDecl(state, n, s) : undefined;
        if (!decl || slotDeclProblem(decl)) continue;
        const fill = slotFill(state, tree, placed, decl, def);
        const where = `${label}: the “${decl.label}” slot of ${displayName(state, n)}`;
        for (const r of fill.refusedAll) out.push({ severity: 'error', code: 'SLOT_REFUSED', message: `${where} takes ${slotAccepts(decl, state)}, but holds ${r.what}.`, owner, nodeId: r.nodeId });
        // The message leaves the count out, so taking content out of a slot that is still over its limit is no new problem.
        if (decl.max !== undefined && fill.count > decl.max) out.push({ severity: 'error', code: 'SLOT_FULL', message: `${where} holds at most ${decl.max}, but shows more.`, owner, nodeId: n.id });
      }
      for (const [axis, v] of Object.entries(n.variants ?? {})) {
        if (!target || isBindingRef(v)) continue;
        const a = target.variantAxes && Object.hasOwn(target.variantAxes, axis) ? target.variantAxes[axis] : undefined;
        if (!a || !Object.hasOwn(a.options, v)) out.push({ severity: 'warning', code: 'VARIANT_UNKNOWN', message: `${label}: ${target.name} has no ${axis} "${String(v)}", so it shows its default.`, owner, nodeId: n.id });
      }
      const placed = group(n.id) !== null;
      const partWords = (partId: string) => (partId === 'root' ? displayName(state, n) : `the “${partId}” part of ${displayName(state, n)}`);
      for (const [partId, o] of Object.entries(n.overrides ?? {})) checkStyles(o, label, owner, n.id, `part:${partId}`, partInInteractionGroup(target, partId, placed, lookups), partWords(partId));
      for (const [partId, entry] of Object.entries(n.itemOverrides ?? {})) {
        const valid = !!entry && typeof entry === 'object' && typeof entry.list === 'string' && !!entry.items && typeof entry.items === 'object' && !Array.isArray(entry.items);
        if (!valid) out.push({ severity: 'error', code: 'ITEM_STYLES_INVALID', message: `${label}: the styles set on single items of "${partId}" are not in the expected form.`, owner, nodeId: n.id });
        else if (Object.values(entry.items).some((rs) => !rs || typeof rs !== 'object' || Array.isArray(rs)))
          out.push({ severity: 'error', code: 'ITEM_STYLES_INVALID', message: `${label}: the styles set on a single item of "${partId}" are not in the expected form.`, owner, nodeId: n.id });
        else for (const [itemId, rs] of Object.entries(entry.items)) checkStyles(rs, label, owner, n.id, `item:${partId}:${itemId}`, partInInteractionGroup(target, partId, placed, lookups), `one item of ${partWords(partId)}`);
      }
    }
    checkStyles(n.styles, label, owner, n.id, 'own', group(n.id) !== null, nodeLabel(n));
  }
  return out;
}

/** A design's own variants and slots, as structureDiagnostics checks them after its nodes. */
function designStructure(styles: StyleContext, { owner, tree, label }: CheckedTree, def: ComponentDefinition, group: (nodeId: string) => string | null): Diagnostic[] {
  const out: Diagnostic[] = [];
  const checkStyles = styleChecker(styles, out);
  for (const { axis, id, option: v } of variantOptions(def))
    for (const [nid, st] of Object.entries(v.styles ?? {})) {
      const styled = Object.hasOwn(tree.nodes, nid) ? tree.nodes[nid] : undefined;
      checkStyles(st, label, owner, nid, `variant:${axis}:${id}`, group(nid) !== null, styled ? `${nodeLabel(styled)} in its ${id} look` : 'a node');
    }
  if (!variantIdsValid(def)) out.push({ severity: 'warning', code: 'VARIANT_ID_INVALID', message: `${label}: a variant name uses characters that cannot be generated, so that variant is ignored.`, owner });
  for (const [axis, a] of Object.entries(def.variantAxes ?? {}))
    if (!Object.hasOwn(a.options ?? {}, a.default)) out.push({ severity: 'error', code: 'VARIANT_INVALID', message: `${label}: the default of the "${a.label ?? axis}" variant axis ("${a.default}") is not one of its options.`, owner });
  const reachable = new Set(tree.rootIds.flatMap((r) => subtreeIds(tree, r)));
  if (def.kind === 'managed')
    for (const s of Object.keys(def.slots ?? {}))
      if (!Object.values(tree.nodes).some((n) => n.kind === 'slot' && n.slot === s && reachable.has(n.id)))
        out.push({ severity: 'warning', code: 'SLOT_UNPLACED', message: `${label}: the "${def.slots![s].label}" slot is declared but not placed, so content put there will not show.`, owner });
  return out;
}

/** The slot declarations of the project's own components, code components included (theme ones are checked by the loader). */
function slotDeclarationDiagnostics(state: ProjectState): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const def of Object.values(state.components)) {
    if (def.owner === 'theme') continue;
    for (const [k, d] of Object.entries(def.slots ?? {})) {
      const problem = slotDeclProblem(d);
      if (problem) out.push({ severity: 'error', code: 'SLOT_INVALID', message: `${def.name}: the slot "${k}" ${problem}.`, owner: { kind: 'component', id: def.id } });
    }
    // Each axis of code arrives in the property its manifest names, which must be one the code can take.
    for (const p of codeAxisProblems(def)) out.push({ severity: 'error', code: 'VARIANT_INVALID', message: `${def.name}: ${p.message}`, owner: { kind: 'component', id: def.id } });
  }
  return out;
}

/** What is wrong with the site styles (their links, the dark palette, cycles), then the first definition that places itself. */
function tokenDiagnostics(state: ProjectState, { tokenIds, groupOf }: StyleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [id, v] of [...Object.entries(state.tokens.overrides), ...state.tokens.custom.map((t) => [t.id, t.value] as const)]) {
    // Editing refuses these; one written by hand or by an older version still exports, metric by metric.
    if (groupOf.get(id) === 'text' && v && typeof v === 'object' && 'token' in v)
      out.push({ severity: 'warning', code: 'TOKEN_TEXT_LINK', message: `The site style "${id}" follows another text style, which text styles cannot do. Give it its own font, size and spacing in Site styles.` });
    const isFamily = !!v && typeof v === 'object' && 'family' in v;
    const r = (isFamily ? (v as { family: unknown }).family : v) as unknown;
    if (!r || typeof r !== 'object' || !('token' in (r as object))) continue;
    const ref = (r as { token: unknown }).token;
    const want = isFamily ? 'font' : groupOf.get(id);
    if (typeof ref !== 'string') out.push({ severity: 'error', code: 'TOKEN_MISSING', message: `The site style "${id}" has a malformed reference.` });
    else if (!tokenIds.has(ref)) out.push({ severity: 'error', code: 'TOKEN_MISSING', message: `The site style "${id}" refers to "${ref}", which does not exist.` });
    else if (want && groupOf.get(ref) !== want) out.push({ severity: 'error', code: 'TOKEN_MISSING', message: `The site style "${id}" refers to "${ref}", which is not a ${want} style.` });
  }
  // The dark palette's colours: the generated stylesheet leaves out one it cannot use, so each is said here.
  const dark = state.tokens.darkOverrides;
  if (dark !== undefined && (!dark || typeof dark !== 'object' || Array.isArray(dark))) out.push({ severity: 'warning', code: 'TOKEN_MISSING', message: 'The dark palette in tokens.json is not a list of colors, so the site shows its light colors in the dark palette too.' });
  else if (dark)
    for (const [id, v] of Object.entries(dark)) {
      const ref = darkValue(v);
      if (groupOf.get(id) !== 'color') out.push({ severity: 'warning', code: 'TOKEN_MISSING', message: `The dark palette has a color for "${id}", which is not a color of this site, so it is left out.` });
      else if (ref === null || (typeof ref === 'string' && validateStyleValue('color', ref)))
        out.push({ severity: 'warning', code: 'TOKEN_MISSING', message: `The dark palette's color for "${id}" is not a color, so it shows its light color.` });
      // A link that leads nowhere is an error, as one in the light palette is: an edit (a theme without the color it
      // follows) cannot bring one in.
      else if (typeof ref === 'object' && !tokenIds.has(ref.token)) out.push({ severity: 'error', code: 'TOKEN_MISSING', message: `The dark palette's "${id}" follows "${ref.token}", which does not exist.` });
      else if (typeof ref === 'object' && groupOf.get(ref.token) !== 'color') out.push({ severity: 'error', code: 'TOKEN_MISSING', message: `The dark palette's "${id}" follows "${ref.token}", which is not a color style.` });
    }
  const cycle = findTokenCycle(state);
  if (cycle) out.push({ severity: 'error', code: 'TOKEN_CYCLE', message: `The site style "${cycle}" refers back to itself through other styles.` });
  // Definitions that place themselves, directly or through others, can never render.
  const deps = (id: string): string[] => {
    const d = state.components[id];
    if (!d) return [];
    // Managed definitions depend on what their tree places; code declares its dependencies.
    const ids = new Set(d.kind === 'code' ? (d.dependencies ?? []) : []);
    for (const n of Object.values(d.tree?.nodes ?? {})) if (n.kind === 'instance') ids.add(n.definitionId);
    return [...ids];
  };
  const state_ = new Map<string, 'open' | 'done'>();
  const visit = (id: string, path: string[]): string[] | null => {
    if (state_.get(id) === 'done') return null;
    if (state_.get(id) === 'open') return [...path.slice(path.indexOf(id)), id];
    state_.set(id, 'open');
    for (const dep of deps(id)) {
      const c = visit(dep, [...path, id]);
      if (c) return c;
    }
    state_.set(id, 'done');
    return null;
  };
  for (const id of Object.keys(state.components).sort()) {
    const c = visit(id, []);
    if (c) {
      out.push({ severity: 'error', code: 'DEF_CYCLE', message: `${c.map((x) => state.components[x]?.name ?? x).join(' → ')}: a component cannot contain itself.`, owner: { kind: 'component', id: c[0] } });
      break;
    }
  }
  return out;
}

/** The links a property value holds, read as its schema stores them: a link, rich text's spans, and list item fields. */
function linksOf(schema: PropSchema | undefined, v: unknown): Array<{ type: unknown; target: string }> {
  if (!schema || !v || typeof v !== 'object' || isBinding(v)) return [];
  const link = (l: unknown) => (l && typeof l === 'object' && typeof (l as { target?: unknown }).target === 'string' ? [l as { type: unknown; target: string }] : []);
  switch (schema.type) {
    case 'link':
      return link(v);
    case 'richtext':
      return (Array.isArray(v) ? v : []).flatMap((b) => {
        const block = (b && typeof b === 'object' ? b : {}) as { spans?: unknown; items?: unknown };
        const spans = [...(Array.isArray(block.spans) ? block.spans : []), ...(Array.isArray(block.items) ? block.items.flatMap((it) => (Array.isArray(it) ? it : [])) : [])];
        return spans.flatMap((sp) => link((sp as { link?: unknown } | null)?.link));
      });
    case 'list':
      return (Array.isArray(v) ? v : []).flatMap((it) => (it && typeof it === 'object' ? Object.entries(schema.fields ?? {}).flatMap(([f, fs]) => linksOf(fs, (it as Record<string, unknown>)[f])) : []));
    default:
      return [];
  }
}
