import { isArticleDate, pageArticle } from '@shared/articles';
import { findEntry } from '@shared/collections';
import { collectionDiagnostics } from './collections';
import type { GraphNode, ImageValue, NodeTree, ProjectState, PropSchema, ResponsiveStyles } from '@shared/types';
import { STYLE_PROP_MAP } from '@shared/styles';
import { effectiveItem, followsPage } from '@shared/page-teasers';
import { ELEMENT_TAGS, LIST_FEEDS, TEXT_TAGS, conditionRef, isBinding, isBindingRef, isComparison, isStateRef } from '@shared/types';
import { validateRoute } from '@shared/routes';
import { isLanguageCode, pageLanguage, shownValue, translationClashMessage, translationClashes, translationMembers } from '@shared/languages';
import { variantIdsValid, variantOptions } from '@shared/variants';
import { EngineError, allTrees, childLists, displayName, instancesOf, subtreeIds } from './tree';
import { normalizeTable } from './table';
import { normalizeObject } from './values';
import { slotAccepts, slotDecl, slotDeclProblem, slotFill } from './slots';
import { MAX_UI_STATES, bindingProblem, bindingSlots, boundSchema, stateActionProblem, stateRefProblem, uiStateProblem } from './schema';
import { cardLinkProblems, isCarouselTrack } from '@generator/card-links';
import { declaredTokens, findTokenCycle, forEachTokenPropRef } from './tokens';
import { missingSectionLinks, netlifyFormClashes, pageHeadings, unlinkedButtons, type FormNameClash } from '@generator/checks';
import { choosesFontAtRunTime, declaresFonts, installedFonts, usedPackFonts } from '@catalogue/fonts';
import { codeNeeds } from './definitions';
import { showsPart } from '@shared/page-shell';
import { effectiveTokens, isDraftPage } from '@generator/index';
import { componentReusabilityDiagnostics } from './reusability';
import { formConnectionProblem, formFieldTitles, formFieldsAsSent, formKeyClashes, formRefusesClashes, formRefusesUnchoosable, formUnchoosable, namesFormFields, offersFormChoices } from '@catalogue/foundation/form';

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
const CONTENT_ERRORS = new Set(['LINK_SECTION_MISSING']);

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

/**
 * Schema and reference validation: IDs, references, nesting and routes, links to sections that do not exist, each
 * page's heading outline, and how reusable each project component is. Save gates pass `sectionLinks: false`: section
 * links, headings and reusability never block a save, so they need not be worked out.
 */
export function validateState(state: ProjectState, opts: { sectionLinks?: boolean } = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  const routes = new Map<string, string>();
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
    routes.set(key, p.title);
    if (p.language !== undefined && !isLanguageCode(p.language))
      out.push({ severity: 'warning', code: 'LANGUAGE_INVALID', message: `${p.title}: “${shownValue(p.language)}” is not a language code, so the page uses the site language.`, owner: { kind: 'page', id } });
    // A hand-edited article with no readable date would otherwise vanish from the news lists without a word.
    if (p.article !== undefined && !pageArticle(p))
      out.push({ severity: 'warning', code: 'ARTICLE_DATE_INVALID', message: `${p.title}: its publication date is not a calendar date written YYYY-MM-DD, so news lists leave it out.`, owner: { kind: 'page', id } });
  }
  // Translations in the same language cannot tell visitors apart. Published ones then list none of their versions;
  // a draft only matters once it is published.
  for (const clash of translationClashes(state)) {
    const published = translationMembers(state, clash.group)
      .filter((p) => !isDraftPage(state, p))
      .map((p) => pageLanguage(state.site, p).toLowerCase());
    const live = new Set(published).size < published.length;
    const effect = live ? 'Until then, the website lists none of their translations.' : 'Publishing the draft as it is would stop the website listing their translations.';
    out.push({ severity: 'warning', code: 'TRANSLATION_LANGUAGE', message: `${translationClashMessage(clash)} ${effect}`, owner: { kind: 'page', id: clash.b.id } });
  }
  // Old addresses kept working: each is a route of its own, so no page may use it, and it names a page.
  const redirects: unknown = state.site.redirects;
  if (redirects !== undefined && !Array.isArray(redirects)) out.push({ severity: 'error', code: 'REDIRECT_INVALID', message: 'The list of old page addresses is damaged.' });
  for (const r of Array.isArray(redirects) ? (redirects as unknown[]) : []) {
    const { from, pageId } = (r && typeof r === 'object' ? r : {}) as { from?: unknown; pageId?: unknown };
    if (typeof from !== 'string' || typeof pageId !== 'string') {
      out.push({ severity: 'error', code: 'REDIRECT_INVALID', message: 'An old page address is damaged.' });
      continue;
    }
    const err = from === '/' ? 'The Home page address cannot send visitors elsewhere.' : validateRoute(from);
    if (err) out.push({ severity: 'error', code: 'ROUTE_INVALID', message: `Old address ${from}: ${err}` });
    if (!Object.hasOwn(state.pages, pageId)) out.push({ severity: 'error', code: 'REDIRECT_TARGET', message: `The old address ${from} goes to a page that no longer exists.` });
    const key = from.toLowerCase();
    if (routes.has(key)) out.push({ severity: 'error', code: 'ROUTE_DUPLICATE', message: `${routes.get(key)} and the old address ${from} share ${from}.` });
    routes.set(key, `The old address ${from}`);
  }
  // Collections and their entries hold addresses of their own, in the same namespace.
  out.push(...collectionDiagnostics(state, routes));
  for (const id of Object.keys(state.pages)) if (!state.site.pageOrder.includes(id)) out.push({ severity: 'error', code: 'PAGE_ORPHAN', message: `Page ${state.pages[id].title} is not in the page order.` });
  if (new Set(state.site.pageOrder).size !== state.site.pageOrder.length) out.push({ severity: 'error', code: 'PAGE_MISSING', message: 'The page order lists a page twice.' });
  for (const p of Object.values(state.pages)) {
    if ((p.route === '/') !== (p.id === state.site.homePageId))
      out.push({ severity: 'error', code: 'HOME_ROUTE', message: p.route === '/' ? `${p.title} uses "/" but is not the Home page.` : `The Home page (${p.title}) must use "/".`, owner: { kind: 'page', id: p.id } });
  }
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
    const check = (id: string, inRepeat: boolean) => {
      const n = tree.nodes[id];
      if (!n || visited.has(id)) return;
      visited.add(id);
      for (const slot of bindingSlots(n)) {
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
        const problem = n.kind !== 'link' ? 'changes UI state, which only a button can.' : stateActionProblem(def, action);
        if (problem) out.push({ severity: 'error', code: 'STATE_ACTION_INVALID', message: `${def.name}: ${nodeLabel(n)} ${problem}`, owner, nodeId: id, site: `${id}|stateAction` });
      }
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
      const broken = new Set<'page' | 'document' | 'entry'>();
      for (const l of links) {
        if (l.type === 'entry') broken.add('entry');
        if (l.type === 'page' && !Object.hasOwn(state.pages, l.target)) broken.add('page');
        if (l.type === 'document' && (Object.hasOwn(state.assets.assets, l.target) ? state.assets.assets[l.target] : undefined)?.kind !== 'document') broken.add('document');
      }
      const what = `${def.name}: the default “${label}” links to`;
      if (broken.has('page')) out.push({ severity: 'error', code: 'LINK_BROKEN', message: `${what} a page that no longer exists.`, owner });
      if (broken.has('document')) out.push({ severity: 'error', code: 'LINK_BROKEN', message: `${what} a document that is no longer in Assets. Choose another destination for it.`, owner });
      if (broken.has('entry')) out.push({ severity: 'error', code: 'LINK_BROKEN', message: `${what} a collection entry, which only another entry can link to for now. Choose another destination for it.`, owner });
    }
  }

  for (const { owner, tree, label } of allTrees(state)) {
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
      if ('assetId' in o && o.assetId && !o.decorative && !String(o.alt ?? '').trim() && owner.kind !== 'component')
        out.push({ severity: 'warning', code: 'ALT_MISSING', message: `${label}: an image has no alternative text.`, owner, nodeId });
      Object.values(o).forEach((x) => walk(x, nodeId, shown));
    };
    for (const n of Object.values(tree.nodes)) {
      const props = n.kind === 'instance' ? state.components[n.definitionId]?.properties : undefined;
      ignored = new Set(Object.entries(props ?? {}).flatMap(([k, sch]) => (sch.type === 'list' && sch.feed && n.kind === 'instance' && Array.isArray(n.props[k]) ? [n.props[k]] : [])));
      walk(n, n.id);
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
    if (owner.kind !== 'component')
      for (const b of unlinkedButtons(state, tree))
        out.push({ severity: 'warning', code: 'BUTTON_UNLINKED', message: `${label}: the “${b.label}” button has no link, so visitors won’t see it. Choose where it goes, or hide the button.`, owner, nodeId: b.nodeId });
    // Theme definitions are fixed theme data; a project component's own forms are checked like a page's.
    const inTheme = owner.kind === 'component' && state.components[owner.id]?.owner === 'theme';
    for (const n of Object.values(tree.nodes)) {
      const def = n.kind === 'instance' ? state.components[n.definitionId] : undefined;
      if (inTheme || n.kind !== 'instance' || def?.componentId !== 'contact.form' || def.kind !== 'code') continue;
      const props = Object.fromEntries(Object.entries(def.properties).map(([k, sch]) => [k, k in n.props ? n.props[k] : sch.default]));
      // A binding outside a component has nothing to bind to and is exported empty, so the default decides.
      const problem = owner.kind !== 'component' ? formConnectionProblem(def, Object.fromEntries(Object.entries(n.props).filter(([, v]) => !isBinding(v)))) : undefined;
      if (problem) out.push({ severity: 'warning', code: 'FORM_UNCONNECTED', message: `${label}: the contact form is not connected to a form service, so visitors cannot send it. ${problem}`, owner, nodeId: n.id });
      // A list bound from outside is only known where it is placed.
      if (namesFormFields(def) && !isBinding(props.fields)) {
        const fields = formFieldsAsSent(def, props.fields);
        for (const clash of formKeyClashes(fields)) {
          const what = formFieldTitles(fields, clash.indexes, fields.map((_, i) => i));
          const outcome = formRefusesClashes(def) ? 'so visitors cannot send the form' : 'so the form service cannot tell those answers apart';
          const all = clash.indexes.length === 2 ? 'both' : 'all';
          out.push({ severity: 'warning', code: 'FORM_FIELD_KEYS', message: `${label}: the contact form's ${what} fields are ${all} sent as “${clash.key}”, ${outcome}. Give each field its own field name.`, owner, nodeId: n.id });
        }
        for (const i of offersFormChoices(def) ? formUnchoosable(fields) : []) {
          const what = formFieldTitles(fields, [i], fields.map((_, j) => j));
          const outcome = formRefusesUnchoosable(def) ? 'so visitors cannot send the form' : 'so visitors cannot answer it';
          out.push({ severity: 'warning', code: 'FORM_NO_CHOICES', message: `${label}: the contact form's ${what} field has no choices to pick from, ${outcome}. Add its choices, or change its type.`, owner, nodeId: n.id });
        }
      }
    }
  }
  for (const p of cardLinkProblems(state))
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
  for (const i of opts.sectionLinks === false ? [] : missingSectionLinks(state)) {
    const where = i.owner.kind === 'shell' ? (i.owner.id === 'header' ? 'Header' : 'Footer') : (state.pages[i.owner.id]?.title ?? 'A page');
    const what = i.label ? `the “${i.label}” link${i.inText ? ' in the text' : ''}` : `a link${i.inText ? ' in the text' : ''}`;
    const fix = i.inText ? 'Change the link in the text to a section the page has.' : 'Choose one of the page’s sections in the link’s Section list.';
    const message = i.pageId
      ? `${where}: ${what} goes to #${i.fragment} on ${state.pages[i.pageId].title}, but that page has no section with that ID. ${fix}`
      : `${where}: ${what} goes to #${i.fragment}, but ${listed((i.pages ?? []).map((id) => state.pages[id].title))} ${(i.pages ?? []).length > 1 ? 'have' : 'has'} no section with that ID. ${fix}`;
    // Which link it is, where one placement shows several with the same text (one per card, say).
    // Which link it is, and where it goes: a link in text by its text, since another link added before it renumbers it. The
    // pages missing the section are left out, so fixing one of them never makes the link look newly broken.
    const which = i.inText ? [i.key.replace(/:\d+$/, ''), i.label] : [i.key];
    out.push({ severity: 'error', code: 'LINK_SECTION_MISSING', message, owner: i.owner, nodeId: i.nodeId, site: JSON.stringify([i.nodeId ?? null, ...which, i.pageId ?? null, i.fragment]) });
  }
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
  for (const p of Object.values(state.pages)) picture(p.seo?.socialImage, `${p.title}: the page’s sharing image`, 'socialImage', { kind: 'page', id: p.id });
  if (opts.sectionLinks !== false) {
    out.push(...headingDiagnostics(state), ...formNameDiagnostics(state), ...runtimeFontDiagnostics(state));
    // Theme components are fixed theme data; only a project's own components are its author's to make reusable.
    const tokens = effectiveTokens(state);
    for (const def of Object.values(state.components)) {
      if (def.kind !== 'managed' || def.owner !== 'project') continue;
      // Advice on a definition edited by hand into a shape it cannot have is skipped, never a reason it cannot open.
      try {
        out.push(...componentReusabilityDiagnostics(def, tokens));
      } catch {
        /* the structural checks above say what is wrong with it */
      }
    }
  }
  out.push(...structureDiagnostics(state));
  for (const a of Object.values(state.assets.assets)) {
    // A download is the size it is; only what pages load and show is worth making smaller.
    if (a.kind !== 'document' && a.bytes > 1_500_000) out.push({ severity: 'warning', code: 'ASSET_LARGE', message: `${a.name} is ${(a.bytes / 1e6).toFixed(1)} MB. Consider a smaller image for faster pages.` });
  }
  return out;
}

/**
 * The definitions the published site renders: those placed on a published page or in a shared header or footer a
 * published page shows, those their designs place, and the code components their code imports.
 */
function renderedDefinitions(state: ProjectState): Set<string> {
  const pages = state.site.pageOrder.flatMap((id) => (Object.hasOwn(state.pages, id) && !isDraftPage(state, state.pages[id]) ? [state.pages[id]] : []));
  const trees = [...pages, ...(['header', 'footer'] as const).filter((part) => pages.some((p) => showsPart(p, part))).map((part) => state.site.shell[part])];
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

/** Where a form is, for a message: its page's title, or the shared header or footer. */
const formPlace = (state: ProjectState, f: FormNameClash['forms'][number]) =>
  f.owner.kind === 'shell' ? (f.owner.id === 'header' ? 'the shared header' : 'the shared footer') : (state.pages[f.owner.id]?.title ?? 'a page');

/** What is wrong with contact forms that send to Netlify under one form name, said once for all of them. */
export function formNameClashMessage(state: ProjectState, clash: FormNameClash): string {
  const counts = new Map<string, number>();
  for (const f of clash.forms) counts.set(formPlace(state, f), (counts.get(formPlace(state, f)) ?? 0) + 1);
  const places = listed([...counts].map(([place, n]) => (n > 1 ? `${n} on ${place}` : place)));
  return `${clash.forms.length} contact forms send to the Netlify form “${clash.name}” (${places}), so Netlify files their messages together. Give each form its own Netlify form name.`;
}

/**
 * Contact forms that send to Netlify under one form name, each flagged where it is: Netlify would file their messages
 * together. A warning, so the site still saves and exports, but it is listed before an export.
 */
export function formNameDiagnostics(state: ProjectState): Diagnostic[] {
  return netlifyFormClashes(state).flatMap((clash) => {
    const message = formNameClashMessage(state, clash);
    const label = (f: FormNameClash['forms'][number]) => (f.owner.kind === 'shell' ? (f.owner.id === 'header' ? 'Header' : 'Footer') : formPlace(state, f));
    // A form shown more than once (through a slot inside a list) is flagged once where it is.
    const forms = clash.forms.filter((f, i) => clash.forms.findIndex((g) => g.owner.kind === f.owner.kind && g.owner.id === f.owner.id && g.nodeId === f.nodeId) === i);
    return forms.map((f) => ({ severity: 'warning' as const, code: 'FORM_NAME_DUPLICATE', message: `${label(f)}: ${message}`, owner: f.owner, nodeId: f.nodeId }));
  });
}

/** A heading's words, quoted, for a message. */
const quoted = (text: string) => (text ? `“${text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text}”` : 'an empty heading');

/**
 * Each page's heading outline, as warnings to review: they never block a save or an export, since a second Heading 1
 * can be deliberate. Each names the heading to change, and the page it is on.
 */
export function headingDiagnostics(state: ProjectState): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const id of state.site.pageOrder) {
    const page = Object.hasOwn(state.pages, id) ? state.pages[id] : undefined;
    if (!page) continue;
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
 * Checks that catch documents edited outside the editor: unknown HTML tags, slots that do not match their
 * definition, definitions that contain themselves, and site styles that loop or point at nothing.
 */
function structureDiagnostics(state: ProjectState): Diagnostic[] {
  const out: Diagnostic[] = [];
  const tokenIds = new Set(declaredTokens(state).map((t) => t.id));
  const groupOf = new Map(declaredTokens(state).map((t) => [t.id, t.group]));
  const checkStyles = (rs: ResponsiveStyles | undefined, label: string, owner: Diagnostic['owner'], nodeId?: string, layer = 'own') => {
    for (const [scopeId, scope] of Object.entries(rs ?? {})) {
      for (const [prop, v] of Object.entries(scope ?? {})) {
        const token = v && typeof v === 'object' && typeof (v as { token?: unknown }).token === 'string' ? (v as { token: string }).token : undefined;
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
        if (group !== undefined && !groups.includes(group))
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
  for (const { owner, tree, label } of allTrees(state)) {
    const def = owner.kind === 'component' ? state.components[owner.id] : undefined;
    // Theme definitions are fixed theme data, checked when the theme is built.
    if (def?.owner === 'theme') continue;
    for (const n of Object.values(tree.nodes)) {
      if (n.kind === 'element' && !isBinding(n.tag) && !ELEMENT_TAG_SET.has(n.tag)) out.push({ severity: 'error', code: 'TAG_INVALID', message: `${label}: "${String(n.tag)}" is not a supported element tag.`, owner, nodeId: n.id });
      if (n.kind === 'text' && !isBinding(n.tag) && !TEXT_TAG_SET.has(n.tag)) out.push({ severity: 'error', code: 'TAG_INVALID', message: `${label}: "${String(n.tag)}" is not a supported text tag.`, owner, nodeId: n.id });
      // A carousel's buttons go beside its list, which only a plain list can have.
      if (n.kind === 'element' && n.carousel !== undefined && !isCarouselTrack(n))
        out.push({ severity: 'error', code: 'CAROUSEL_INVALID', message: `${label}: ${nodeLabel(n)} is marked as a carousel, which only a bulleted list (ul) that is not itself a link can be.`, owner, nodeId: n.id });
      if (n.kind === 'text' && n.datetime !== undefined && (n.rich || (!isBinding(n.datetime) && (typeof n.datetime !== 'string' || (n.datetime.trim() !== '' && !isArticleDate(n.datetime.trim()))))))
        out.push({ severity: 'error', code: 'DATETIME_INVALID', message: `${label}: ${nodeLabel(n)} ${n.rich ? 'is rich text, which cannot state a date' : 'states a date that is not written YYYY-MM-DD'}.`, owner, nodeId: n.id });
      if (n.kind === 'slot' && !def) out.push({ severity: 'error', code: 'SLOT_INVALID', message: `${label}: slots can only be placed inside a component definition.`, owner, nodeId: n.id });
      // Properties and list items belong to a component: a page or the shared header and footer has none to show.
      else if (n.kind === 'repeat' && !def) out.push({ severity: 'error', code: 'BINDING_SCOPE', message: `${label}: a repeat shows a component's list, so it can only be placed inside a component definition.`, owner, nodeId: n.id, site: n.id });
      else if (!def && bindingSlots(n).some((sl) => (sl.field === 'when' || sl.field === 'unless' ? conditionRef(sl.value) : isBindingRef(sl.value))))
        out.push({ severity: 'error', code: 'BINDING_SCOPE', message: `${label}: ${nodeLabel(n)} shows a component property, list item field or UI state, which only an element inside a component definition can.`, owner, nodeId: n.id, site: n.id });
      else if (n.kind === 'slot' && def && !Object.hasOwn(def.slots ?? {}, n.slot))
        out.push({ severity: 'error', code: 'SLOT_INVALID', message: `${label}: the slot "${n.slot}" is not declared by the component.`, owner, nodeId: n.id });
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
          for (const r of fill.refusedAll) out.push({ severity: 'error', code: 'SLOT_REFUSED', message: `${where} takes ${slotAccepts(decl)}, but holds ${r.what}.`, owner, nodeId: r.nodeId });
          // The message leaves the count out, so taking content out of a slot that is still over its limit is no new problem.
          if (decl.max !== undefined && fill.count > decl.max) out.push({ severity: 'error', code: 'SLOT_FULL', message: `${where} holds at most ${decl.max}, but shows more.`, owner, nodeId: n.id });
        }
        for (const [axis, v] of Object.entries(n.variants ?? {})) {
          if (!target || isBindingRef(v)) continue;
          const a = target.variantAxes && Object.hasOwn(target.variantAxes, axis) ? target.variantAxes[axis] : undefined;
          if (!a || !Object.hasOwn(a.options, v)) out.push({ severity: 'warning', code: 'VARIANT_UNKNOWN', message: `${label}: ${target.name} has no ${axis} "${String(v)}", so it shows its default.`, owner, nodeId: n.id });
        }
        for (const [partId, o] of Object.entries(n.overrides ?? {})) checkStyles(o, label, owner, n.id, `part:${partId}`);
        for (const [partId, entry] of Object.entries(n.itemOverrides ?? {})) {
          const valid = !!entry && typeof entry === 'object' && typeof entry.list === 'string' && !!entry.items && typeof entry.items === 'object' && !Array.isArray(entry.items);
          if (!valid) out.push({ severity: 'error', code: 'ITEM_STYLES_INVALID', message: `${label}: the styles set on single items of "${partId}" are not in the expected form.`, owner, nodeId: n.id });
          else if (Object.values(entry.items).some((rs) => !rs || typeof rs !== 'object' || Array.isArray(rs)))
            out.push({ severity: 'error', code: 'ITEM_STYLES_INVALID', message: `${label}: the styles set on a single item of "${partId}" are not in the expected form.`, owner, nodeId: n.id });
          else for (const [itemId, rs] of Object.entries(entry.items)) checkStyles(rs, label, owner, n.id, `item:${partId}:${itemId}`);
        }
      }
      checkStyles(n.styles, label, owner, n.id);
    }
    if (def) {
      for (const { axis, id, option: v } of variantOptions(def)) for (const [nid, st] of Object.entries(v.styles ?? {})) checkStyles(st, label, owner, nid, `variant:${axis}:${id}`);
      if (!variantIdsValid(def)) out.push({ severity: 'warning', code: 'VARIANT_ID_INVALID', message: `${label}: a variant name uses characters that cannot be generated, so that variant is ignored.`, owner });
      for (const [axis, a] of Object.entries(def.variantAxes ?? {}))
        if (!Object.hasOwn(a.options ?? {}, a.default)) out.push({ severity: 'error', code: 'VARIANT_INVALID', message: `${label}: the default of the "${a.label ?? axis}" variant axis ("${a.default}") is not one of its options.`, owner });
      const reachable = new Set(tree.rootIds.flatMap((r) => subtreeIds(tree, r)));
      if (def.kind === 'managed')
        for (const s of Object.keys(def.slots ?? {}))
          if (!Object.values(tree.nodes).some((n) => n.kind === 'slot' && n.slot === s && reachable.has(n.id)))
            out.push({ severity: 'warning', code: 'SLOT_UNPLACED', message: `${label}: the "${def.slots![s].label}" slot is declared but not placed, so content put there will not show.`, owner });
    }
  }
  // Slot declarations of the project's own components, code components included (theme ones are checked by the loader).
  for (const def of Object.values(state.components)) {
    if (def.owner === 'theme') continue;
    for (const [k, d] of Object.entries(def.slots ?? {})) {
      const problem = slotDeclProblem(d);
      if (problem) out.push({ severity: 'error', code: 'SLOT_INVALID', message: `${def.name}: the slot "${k}" ${problem}.`, owner: { kind: 'component', id: def.id } });
    }
  }
  // A token property names a token of its own group. One that is gone (a hand edit, a theme without it) shows nothing.
  forEachTokenPropRef(state, (id, site) => {
    const where = { owner: site.owner, ...(site.nodeId ? { nodeId: site.nodeId } : {}) };
    if (!tokenIds.has(id)) out.push({ severity: 'error', code: 'TOKEN_MISSING', message: `${site.label}: a component property uses the site style "${id}", which does not exist.`, ...where });
    else if (groupOf.get(id) !== site.tokenGroup) out.push({ severity: 'error', code: 'TOKEN_MISSING', message: `${site.label}: a component property uses the site style "${id}", which is not a ${site.tokenGroup} style.`, ...where });
  }, { themeDesigns: true });
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
