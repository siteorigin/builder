import { z } from 'zod';
import type { OwnerRef, ProjectState } from '@shared/types';
import type { Diagnostic } from '@engine/validate';
import { isReusabilityWarning } from '@engine/reusability';
import { isSampleFinding } from '@engine/sample-content';
import { allTrees, instancesOf, subtreeIds } from '@engine/tree';
import { routeOwners, siteEntries, isDraftEntry } from '@shared/collections';
import { archivePages } from '@shared/archives';
import { componentWarnings, REUSABILITY_FEEDBACK_LIMIT } from './reusability';
import { pageIdFor } from './context';
import { showsPart } from '@shared/page-shell';
import type { InspectLayoutOptions } from '@shared/api';
import { toolError, type ToolOutcome } from './result';

const ids = (what?: string) => {
  const s = z.array(z.string()).max(20).optional();
  return what ? s.describe(what) : s;
};

export const VALIDATE_ARGS = z
  .object({
    profile: z.enum(['schema', 'component', 'preview', 'project']).optional(),
    pageIds: ids('IDs or routes.'),
    nodeIds: ids(),
    componentIds: ids(),
    list: z.enum(['errors', 'warnings', 'componentWarnings', 'routes', 'pages']).optional(),
    offset: z.number().int().min(0).optional()
  })
  .strict();

export type ValidateArgs = z.infer<typeof VALIDATE_ARGS>;

export const VALIDATE_DESCRIPTION =
  'Validate the current revision. Profiles: "schema" (default) checks types, IDs, references, nesting, token cycles and routes; "component" also compiles every Svelte component; "preview" measures pages in the live preview at phone width (390px): whether it shows the current revision, runtime errors and geometry (overflow, overlaps, cut-off text, small tap targets), for the pages named in pageIds (or showing nodeIds or componentIds), or else the pages that show this request’s changes, 3 a call; "project" does everything "component" does, plus image files missing from the project folder, site and page images the library does not have, and the route inventory. pageIds, nodeIds and componentIds (any mix) narrow the result to the problems owned by or located in them (compile results: only the named components); outsideNarrowing then counts the rest, so a narrowed clean result never means a clean project. A capped list says how many it left out and how to see them (more): call again with the list and offset nextOffset names, or narrow by ID.';

export const VALIDATE_BRIEF =
  '"schema" (default) structure and references; "component" compiles; "preview" phone check of named or changed pages; "project" adds missing images and routes. pageIds, nodeIds, componentIds narrow it; outsideNarrowing counts the rest. More: list and offset from nextOffset.';

/** What a small model reads of it, as description and brief: it is offered the schema and component profiles alone. */
export const VALIDATE_FOCUSED_BRIEF = '"schema" checks references, routes and structure; "component" also compiles every component.';

/** How many of each capped list one result shows; the rest are counted and reached with list and offset. */
export const LIST_LIMITS = { errors: 40, warnings: 20, componentWarnings: REUSABILITY_FEEDBACK_LIMIT, routes: 50, pages: 3 } as const;
type ListName = keyof typeof LIST_LIMITS;
/** How many geometry findings of one measured page are listed; narrowing by element reaches the rest. */
export const PAGE_FINDING_LIMIT = 20;
/** The width preview validation measures at: the phone preset, where layouts break first. */
export const PREVIEW_WIDTH = 390;
/** Room for one result, under what the run sends back whole (result.ts MAX_RESULT_CHARS). */
const RESULT_ROOM = 23500;
/** The findings of a measurement that are about geometry, which preview validation reports. */
const GEOMETRY_KINDS = new Set(['horizontal-overflow', 'element-overflow', 'text-overflow', 'overlap', 'clipped-text', 'small-tap-target']);

/** What validate_project needs from the run. */
export interface ValidationHost {
  state(): ProjectState;
  revision(): number;
  diagnostics(): Diagnostic[];
  compileAll(): Promise<Diagnostic[]>;
  /** `focus`: list only the findings on these elements. */
  inspectLayout(pageId: string, width: number, opts?: InspectLayoutOptions): Promise<unknown>;
  /** The pages that show this run's changes: those it changed, and for a change every page shows, a few of them. */
  changedPageIds?(): string[];
  /** Problems with the project's files on disk, such as image files missing from the project folder, looked for again. */
  fileDiagnostics?(): Promise<Diagnostic[]>;
  /** Aborted when the run is stopped: no further page is measured, and one being measured is not waited for. */
  signal?: AbortSignal;
}

const invalid = (message: string): ToolOutcome => toolError('INVALID_ARGUMENT', message);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A diagnostic as the model reads it: what, and where to act on it. */
const shown = (d: Diagnostic) => ({ code: d.code, message: d.message.length > 400 ? `${d.message.slice(0, 399)}…` : d.message, ...(d.owner ? { owner: { kind: d.owner.kind, id: d.owner.id } } : {}), ...(d.nodeId ? { nodeId: d.nodeId } : {}) });

/** The narrowing the arguments ask for, resolved against the project. */
interface Narrowing {
  pageIds: string[];
  nodeIds: string[];
  componentIds: string[];
  /** Each named node's subtree, by the owner whose tree it is in. */
  nodes: Array<{ owner: OwnerRef; ids: Set<string> }>;
}

function resolveNarrowing(state: ProjectState, a: ValidateArgs): Narrowing | { error: string } {
  const pageIds: string[] = [];
  for (const ref of a.pageIds ?? []) {
    const id = pageIdFor(state, ref);
    if (!id) return { error: `No page has the ID or route "${ref}".` };
    if (!pageIds.includes(id)) pageIds.push(id);
  }
  const nodes: Narrowing['nodes'] = [];
  const nodeIds = [...new Set(a.nodeIds ?? [])];
  if (nodeIds.length) {
    const trees = allTrees(state);
    for (const nodeId of nodeIds) {
      // A node ID can recur in separate trees (copies of one design): each of them is meant.
      const found = trees.filter((t) => Object.hasOwn(t.tree.nodes, nodeId));
      if (!found.length) return { error: `No page, header, footer, layout or component has an element "${nodeId}".` };
      for (const t of found) nodes.push({ owner: t.owner, ids: new Set(subtreeIds(t.tree, nodeId)) });
    }
  }
  const componentIds = [...new Set(a.componentIds ?? [])];
  for (const id of componentIds) if (!Object.hasOwn(state.components, id)) return { error: `No component in the project has the definitionId "${id}". Use the definitionIds read_project lists.` };
  return { pageIds, nodeIds, componentIds, nodes };
}

const isNarrowed = (n: Narrowing) => n.pageIds.length + n.nodeIds.length + n.componentIds.length > 0;

/**
 * Whether a diagnostic belongs to the narrowing: owned by a named page or component, or on a named element (or one
 * inside it). A diagnostic with no owner belongs to a named page when its element is in that page and no other tree.
 * Compile results belong only to the components named.
 */
function inNarrowing(state: ProjectState, n: Narrowing, d: Diagnostic): boolean {
  const o = d.owner;
  if (o?.kind === 'component' && n.componentIds.includes(o.id)) return true;
  if (d.code === 'COMPILE') return false;
  if (o?.kind === 'page' && n.pageIds.includes(o.id)) return true;
  if (!d.nodeId) return false;
  if (!o && n.pageIds.length) {
    const holders = allTrees(state).filter((t) => Object.hasOwn(t.tree.nodes, d.nodeId!));
    if (holders.length === 1 && holders[0].owner.kind === 'page' && n.pageIds.includes(holders[0].owner.id)) return true;
  }
  return n.nodes.some((x) => x.ids.has(d.nodeId!) && (!o || (o.kind === x.owner.kind && o.id === x.owner.id)));
}

/** The site's addresses, each once: pages, old addresses kept working, collections, entries and archive pages. */
function routeInventory(state: ProjectState) {
  const draftPage = (id: string) => state.pages[id]?.draft === true && id !== state.site.homePageId;
  const entries = new Map(siteEntries(state).map((e) => [e.entry.id, e.entry]));
  const out: Array<Record<string, unknown> & { route: string; pageId?: string }> = [];
  for (const r of routeOwners(state)) {
    if (r.kind === 'page') out.push({ route: r.route, kind: 'page', pageId: r.pageId, ...(draftPage(r.pageId) ? { draft: true } : {}) });
    else if (r.kind === 'redirect') {
      // A redirect to an address names the page there, when one has it.
      const to = r.pageId === undefined && r.entryId === undefined ? pageIdFor(state, r.to) : null;
      out.push({ route: r.route, kind: 'redirect', ...(r.pageId !== undefined ? { pageId: r.pageId } : r.entryId !== undefined ? { entryId: r.entryId } : { to: r.to, ...(to ? { pageId: to } : {}) }) });
    } else if (r.kind === 'collection') out.push({ route: r.route, kind: 'collection', collectionId: r.collectionId });
    else {
      const e = entries.get(r.entryId);
      out.push({ route: r.route, kind: 'entry', collectionId: r.collectionId, entryId: r.entryId, ...(!e || isDraftEntry(e) ? { draft: true } : {}) });
    }
  }
  // A collection's own address is already listed: its archive adds the later pages of its index and its categories.
  for (const p of archivePages(state)) if (p.category !== undefined || p.page > 1) out.push({ route: p.route, kind: 'archive', collectionId: p.collectionId, ...(p.category !== undefined ? { category: p.category } : {}), page: p.page });
  return out;
}

/** The pages a preview validation measures: those named or showing named elements or components, else those that show the run's changes. */
function previewPages(state: ProjectState, n: Narrowing, host: ValidationHost): string[] | { error: string } {
  if (isNarrowed(n)) {
    const pages = new Set(n.pageIds);
    const designs = new Set(n.componentIds);
    for (const x of n.nodes) {
      if (x.owner.kind === 'page') pages.add(x.owner.id);
      else if (x.owner.kind === 'component') designs.add(x.owner.id);
      // The header and footer show on every page that keeps them: the first such page stands for them.
      else if (x.owner.kind === 'shell') {
        const part = x.owner.id === 'footer' ? 'footer' : 'header';
        const shows = state.site.pageOrder.find((id) => Object.hasOwn(state.pages, id) && showsPart(state.pages[id], part));
        if (shows) pages.add(shows);
      }
    }
    for (const id of pagesShowingDesigns(state, designs)) pages.add(id);
    if (!pages.size) return { error: 'None of the named elements or components shows on a page, so there is no page to measure. Name the pages with pageIds.' };
    return [...state.site.pageOrder.filter((id) => pages.has(id)), ...[...pages].filter((id) => !state.site.pageOrder.includes(id))];
  }
  const pages = (host.changedPageIds?.() ?? []).filter((id) => Object.hasOwn(state.pages, id));
  if (!pages.length) return { error: 'This request has not changed any page yet, so there is nothing to measure by default. Name the pages to measure with pageIds.' };
  return pages;
}

/** These components and every design that places one of them, however deep. */
function holdingDesigns(state: ProjectState, designs: Iterable<string>): Set<string> {
  const wanted = new Set(designs);
  for (let grew = true; grew; ) {
    grew = false;
    for (const def of Object.values(state.components)) {
      if (wanted.has(def.id) || !def.tree) continue;
      if (Object.values(def.tree.nodes).some((x) => x.kind === 'instance' && wanted.has(x.definitionId))) {
        wanted.add(def.id);
        grew = true;
      }
    }
  }
  return wanted;
}

/**
 * The pages, in site order, that show any of these components: placed on them, or inside another component that is.
 * One in the header or footer shows on the first page that keeps that part, never on a page that hides it.
 */
function pagesShowingDesigns(state: ProjectState, designs: Set<string>): string[] {
  if (!designs.size) return [];
  const wanted = holdingDesigns(state, designs);
  const places = (tree: { nodes: Record<string, { kind: string; definitionId?: string }> }) => Object.values(tree.nodes).some((x) => x.kind === 'instance' && wanted.has(x.definitionId!));
  const out = new Set(state.site.pageOrder.filter((id) => Object.hasOwn(state.pages, id) && places(state.pages[id])));
  for (const part of ['header', 'footer'] as const) {
    if (!places(state.site.shell[part])) continue;
    const shows = state.site.pageOrder.find((id) => Object.hasOwn(state.pages, id) && showsPart(state.pages[id], part));
    if (shows) out.add(shows);
  }
  return state.site.pageOrder.filter((id) => out.has(id));
}

/** The elements a focused measurement keeps findings on: a superset the preview can filter by before it caps its list. */
function focusIds(state: ProjectState, n: Narrowing): string[] {
  const out = new Set<string>();
  // A page's or the shell's own elements by their IDs. A design's are left to its placements: the preview names every
  // element inside one by the placement's ID too, and other designs use the same node IDs ("root", "body").
  for (const x of n.nodes) if (x.owner.kind !== 'component') for (const id of x.ids) out.add(id);
  const designs = new Set([...n.componentIds, ...n.nodes.filter((x) => x.owner.kind === 'component').map((x) => x.owner.id)]);
  for (const id of designs) for (const p of instancesOf(state, id)) out.add(p.node.id);
  return [...out];
}

const holding = new WeakMap<Narrowing, Set<string>>();
/** The designs a finding on whose placement may be about the narrowing: named components, designs of named elements, and those holding them. */
function holders(state: ProjectState, n: Narrowing): Set<string> {
  let out = holding.get(n);
  if (!out) holding.set(n, (out = holdingDesigns(state, [...n.componentIds, ...n.nodes.filter((x) => x.owner.kind === 'component').map((x) => x.owner.id)])));
  return out;
}

type Ref = { owner?: { kind?: unknown; id?: unknown }; nodeId?: unknown; definition?: unknown } | undefined;

/** Whether a preview finding's element (or the design element behind it) is a named element or in a named component. */
function refInNarrowing(state: ProjectState, n: Narrowing, ref: Ref): boolean {
  for (let r = ref; r && typeof r === 'object'; r = r.definition as Ref) {
    const kind = r.owner?.kind;
    const id = r.owner?.id;
    if (kind === 'component' && typeof id === 'string' && n.componentIds.includes(id)) return true;
    if (typeof r.nodeId !== 'string') continue;
    const nodeId = r.nodeId;
    if (n.nodes.some((x) => x.owner.kind === kind && x.owner.id === id && x.ids.has(nodeId))) return true;
    // A placement of a named component, as the page addresses it.
    const tree = allTrees(state).find((t) => t.owner.kind === kind && t.owner.id === id)?.tree;
    const node = tree && Object.hasOwn(tree.nodes, nodeId) ? tree.nodes[nodeId] : undefined;
    // A placement of a named component, or of a design holding one or a named element of one: as near as the preview
    // can place a finding inside it.
    if (node?.kind === 'instance' && holders(state, n).has(node.definitionId)) return true;
  }
  return false;
}

const findingInNarrowing = (state: ProjectState, n: Narrowing, i: Record<string, unknown>) => refInNarrowing(state, n, i.ref as Ref) || refInNarrowing(state, n, (i.with as { ref?: Ref } | undefined)?.ref);

/** `work`, or a rejection as soon as the run is stopped: Stop never waits for a slow check. */
export async function untilStopped<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('Canceled'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    signal.removeEventListener('abort', onAbort!);
  }
}

type Measured =
  | { pageId: string; ok: false; error: string }
  | {
      pageId: string;
      ok: true;
      previewRevision: number;
      documentWidth: unknown;
      /** Geometry findings on what the call is about, in the order measured. */
      issues: Array<Record<string, unknown>>;
      /** The page's runtime errors the preview sent (its latest), and how many it had in all. */
      errors: string[];
      errorCount: number;
      checks: Record<string, unknown> | null;
      /** How many findings the measurement had, and how many of them it listed. */
      found: number;
      listed: number;
      /** For a focused measurement, the geometry findings it listed that are on something else. */
      outside: number | null;
    };

/**
 * Measure one page in the live preview. A preview that is not running, behind, or answering for another revision is a
 * failed check. `focus`: only findings on the named elements and components count; the page's runtime errors are always
 * the page's own.
 */
async function measurePage(state: ProjectState, host: ValidationHost, pageId: string, focus: Narrowing | null): Promise<Measured> {
  const failed = (message: string): Measured => ({ pageId, ok: false, error: message });
  const expected = host.revision();
  let report: Record<string, unknown> | null;
  try {
    const measuring = focus ? host.inspectLayout(pageId, PREVIEW_WIDTH, { focus: focusIds(state, focus) }) : host.inspectLayout(pageId, PREVIEW_WIDTH);
    report = (await untilStopped(measuring, host.signal)) as Record<string, unknown> | null;
  } catch (e) {
    if (host.signal?.aborted) throw e;
    return failed(`The preview could not be measured: ${(e as Error).message}`);
  }
  if (!report || typeof report !== 'object') return failed('The preview gave no report.');
  if (report.error) return failed(`The preview could not be measured: ${String(report.error)}`);
  if (host.revision() !== expected) return failed('The project changed while the page was measured. Validate it again.');
  const shows = report.previewRevision;
  if (typeof shows !== 'number') return failed('The preview did not say which revision it serves, so the measurement cannot be trusted.');
  if (shows !== expected) return failed(`The preview serves revision ${shows}, not the current ${expected}. Validate again once it has caught up.`);
  const listed = Array.isArray(report.issues) ? (report.issues as Array<Record<string, unknown>>) : [];
  const geometry = listed.filter((i) => GEOMETRY_KINDS.has(String(i?.kind)));
  const kept = focus ? geometry.filter((i) => findingInNarrowing(state, focus, i)) : geometry;
  const errors = Array.isArray(report.runtimeErrors) ? (report.runtimeErrors as unknown[]).map((e) => String(e)) : [];
  return {
    pageId,
    ok: true,
    previewRevision: shows,
    documentWidth: report.documentWidth,
    issues: kept,
    errors,
    errorCount: typeof report.runtimeErrorCount === 'number' ? Math.max(report.runtimeErrorCount, errors.length) : errors.length,
    checks: report.checks && typeof report.checks === 'object' ? (report.checks as Record<string, unknown>) : null,
    found: typeof report.issueCount === 'number' ? Math.max(report.issueCount, listed.length) : listed.length,
    listed: listed.length,
    outside: focus ? geometry.length - kept.length : null
  };
}

/** Up to `max` findings, a share of each kind in turn, so a cap never hides a kind (as the preview picks them). */
function acrossKinds(issues: Array<Record<string, unknown>>, max: number): Array<Record<string, unknown>> {
  if (issues.length <= max) return issues;
  const byKind = new Map<string, Array<Record<string, unknown>>>();
  for (const i of issues) byKind.set(String(i.kind), [...(byKind.get(String(i.kind)) ?? []), i]);
  const lists = [...byKind.values()];
  const taken = lists.map(() => 0);
  for (let left = max, more = true; left > 0 && more; ) {
    more = false;
    for (let k = 0; k < lists.length && left > 0; k++) {
      if (taken[k] >= lists[k].length) continue;
      taken[k]++;
      left--;
      more = true;
    }
  }
  const keep = new Set(lists.flatMap((l, k) => l.slice(0, taken[k])));
  return issues.filter((i) => keep.has(i));
}

/** A measured page as a result shows it, with at most `findings` findings and `errors` runtime errors of `chars` each. */
function shownPage(p: Measured, findings: number, errors: number, chars: number, focused: boolean) {
  if (!p.ok) return p;
  const cut = (v: string) => (v.length > chars ? `${v.slice(0, chars - 1)}…` : v);
  const issues = acrossKinds(p.issues, findings).map((i) => {
    const withRef = i.with && typeof i.with === 'object' ? (i.with as { ref?: unknown }).ref : undefined;
    return { kind: i.kind, ...(i.message ? { message: cut(String(i.message)) } : {}), ...(i.ref ? { ref: i.ref } : {}), ...(typeof i.count === 'number' ? { count: i.count } : {}), ...(withRef ? { with: { ref: withRef } } : {}) };
  });
  const runtimeErrors = p.errors.slice(-errors).map(cut);
  const unlisted = p.found - p.listed;
  const more: string[] = [];
  if (p.issues.length > issues.length) more.push(`${plural(p.issues.length - issues.length, 'more finding')} on this page are not listed: ${focused ? 'narrow to fewer elements, or ' : 'narrow with nodeIds, or '}fix these and validate again.`);
  if (unlisted) more.push(`The measurement found ${p.found} findings${focused ? ' on the named elements and components' : ''} and lists ${p.listed}; ${unlisted} were left out: ${focused ? 'narrow to fewer elements' : 'narrow with nodeIds'}, or fix these and validate again.`);
  if (p.errorCount > runtimeErrors.length) more.push(`${plural(p.errorCount - runtimeErrors.length, 'earlier runtime error')} not listed: the latest are; fix them and validate again.`);
  return {
    pageId: p.pageId,
    ok: true as const,
    previewRevision: p.previewRevision,
    documentWidth: p.documentWidth,
    runtimeErrors,
    ...(p.errorCount > runtimeErrors.length ? { omittedRuntimeErrors: p.errorCount - runtimeErrors.length } : {}),
    issues,
    ...(p.issues.length > issues.length ? { omittedIssues: p.issues.length - issues.length } : {}),
    ...(p.outside !== null ? { issuesOutsideNarrowing: p.outside } : {}),
    ...(p.checks ? { checks: { overlaps: p.checks.overlaps, clippedText: p.checks.clippedText, tapTargets: p.checks.tapTargets } } : {}),
    ...(unlisted ? { unlistedFindings: unlisted } : {}),
    ...(more.length ? { more: more.join(' ') } : {})
  };
}

/** One window of a capped list, `limit` long: what it shows, and how many it leaves out. */
function windowOf<T>(items: readonly T[], list: ListName, a: ValidateArgs, limit: number) {
  const offset = a.list === list || (a.list === undefined && list === 'warnings') ? (a.offset ?? 0) : 0;
  const shownItems = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? offset + limit : undefined;
  return { offset, shown: shownItems, omitted: items.length - shownItems.length, total: items.length, next };
}
type Window = ReturnType<typeof windowOf<unknown>>;

export async function runValidateProject(a: ValidateArgs, host: ValidationHost): Promise<ToolOutcome> {
  const state = host.state();
  const profile = a.profile ?? 'schema';
  const n = resolveNarrowing(state, a);
  if ('error' in n) return invalid(n.error);
  if (a.list === 'routes' && profile !== 'project') return invalid('Only the project profile lists routes.');
  if (a.list === 'pages' && profile !== 'preview') return invalid('Only the preview profile measures pages.');

  // Preview validation measures pages, and reports the diagnostics of the pages it measured.
  let pages: string[] = [];
  let scope = n;
  if (profile === 'preview') {
    const found = previewPages(state, n, host);
    if ('error' in found) return invalid(found.error);
    pages = found;
    if (!isNarrowed(n)) scope = { ...n, pageIds: pages };
  }
  const pageWindow = windowOf(pages, 'pages', a, LIST_LIMITS.pages);
  if (profile === 'preview' && !pageWindow.shown.length) return invalid(`offset ${pageWindow.offset} is past the last of the ${plural(pages.length, 'page')} to measure: start again from offset 0.`);
  // A named page is measured whole; one measured for a named element or component reports only their findings.
  const focus = (id: string) => (n.pageIds.includes(id) || (!n.nodeIds.length && !n.componentIds.length) ? null : n);
  const measured: Measured[] = [];
  try {
    for (const id of pageWindow.shown) {
      if (host.signal?.aborted) break;
      measured.push(await measurePage(state, host, id, focus(id)));
    }
  } catch {
    // Stopped while a page was measured.
  }
  if (host.signal?.aborted) return toolError('CANCELLED', 'Stopped before the pages were measured.');
  const previewFailed = measured.some((p) => !p.ok);

  let compiled: Diagnostic[] = [];
  let files: Diagnostic[] = [];
  try {
    compiled = profile === 'component' || profile === 'project' ? await untilStopped(host.compileAll(), host.signal) : [];
    files = profile === 'project' && host.fileDiagnostics ? await untilStopped(host.fileDiagnostics(), host.signal) : [];
  } catch (e) {
    if (!host.signal?.aborted) throw e;
  }
  if (host.signal?.aborted) return toolError('CANCELLED', 'Stopped before validation finished.');
  const extra = profile === 'project' ? [...danglingAssetReferences(state), ...files] : [];
  const all = [...host.diagnostics(), ...compiled, ...extra].filter((d) => d.severity === 'error' || d.severity === 'warning');
  const narrowed = isNarrowed(scope);
  const kept = narrowed ? all.filter((d) => inNarrowing(state, scope, d)) : all;
  const errorList = kept.filter((d) => d.severity === 'error');
  // Sample content still to replace comes after every other warning, so it never crowds them out of the list.
  const warned = kept.filter((d) => d.severity === 'warning' && !isReusabilityWarning(d));
  const warningList = [...warned.filter((d) => !isSampleFinding(d)), ...warned.filter(isSampleFinding)];
  const reusableList = kept.filter((d) => isReusabilityWarning(d) && d.owner?.kind === 'component');
  const routesAll = profile === 'project' ? routeInventory(state) : null;
  const routesKept = routesAll && narrowed ? routesAll.filter((r) => r.pageId !== undefined && scope.pageIds.includes(r.pageId)) : routesAll;
  const outsideErrors = all.filter((d) => d.severity === 'error').length - errorList.length;
  const outsideWarnings = all.length - kept.length - outsideErrors;

  // Built at full size first, then with every list shorter until the whole result fits.
  const build = (scale: number) => {
    const limit = (list: ListName) => Math.max(1, Math.floor(LIST_LIMITS[list] * scale));
    const errors = windowOf(errorList, 'errors', a, limit('errors'));
    const warnings = windowOf(warningList, 'warnings', a, limit('warnings'));
    const reusable = windowOf(reusableList, 'componentWarnings', a, limit('componentWarnings'));
    const routes = routesKept ? windowOf(routesKept, 'routes', a, limit('routes')) : null;
    const pagesShown = measured.map((p) => shownPage(p, Math.max(1, Math.floor(PAGE_FINDING_LIMIT * scale)), Math.max(1, Math.floor(5 * scale)), Math.max(60, Math.floor(300 * scale)), !!focus(p.pageId)));
    // Each capped list says what it left out and how to see it.
    const nexts: Array<{ list: ListName; offset: number }> = [];
    const more: string[] = [];
    const note = (list: ListName, w: Window, word: string, narrow: string) => {
      if (!w.omitted) return;
      if (w.next !== undefined) nexts.push({ list, offset: w.next });
      const at = w.shown.length ? `these are ${w.offset + 1}–${w.offset + w.shown.length} of ${w.total}` : `offset ${w.offset} is past the last of ${w.total}`;
      more.push(`${plural(w.omitted, word)} not listed (${at}): ${w.next !== undefined ? `call again with list "${list}" and offset ${w.next}, or ` : ''}${narrow}.`);
    };
    note('errors', errors, 'error', 'narrow with pageIds, nodeIds or componentIds');
    note('warnings', warnings, 'warning', 'narrow with pageIds, nodeIds or componentIds');
    note('componentWarnings', reusable, 'component warning', 'narrow with componentIds');
    if (routes) note('routes', routes, 'route', 'narrow with pageIds');
    note('pages', pageWindow, 'page', 'name the pages to measure with pageIds');
    if (pagesShown.some((p) => 'more' in p && p.more)) more.push('A measured page left findings out: its more says how to see them.');
    return {
      revision: host.revision(),
      profile,
      ...(narrowed ? { narrowedTo: { ...(scope.pageIds.length ? { pageIds: scope.pageIds } : {}), ...(scope.nodeIds.length ? { nodeIds: scope.nodeIds } : {}), ...(scope.componentIds.length ? { componentIds: scope.componentIds } : {}) } } : {}),
      ...(narrowed ? { outsideNarrowing: { errors: outsideErrors, warnings: outsideWarnings, note: outsideErrors + outsideWarnings ? 'Problems elsewhere in the project, left out by the narrowing: the project as a whole is not clean.' : 'Nothing elsewhere in the project either.' } } : {}),
      errors: errors.shown.map(shown),
      ...(errors.omitted ? { omittedErrors: errors.omitted } : {}),
      warnings: warnings.shown.map(shown),
      ...(warnings.omitted ? { omittedWarnings: warnings.omitted } : {}),
      ...(reusable.shown.length ? componentWarnings(reusable.shown, reusable.shown.length) : {}),
      ...(reusable.omitted ? { omittedComponentWarnings: reusable.omitted } : {}),
      ...(routes ? { routes: routes.shown, ...(routes.omitted ? { omittedRoutes: routes.omitted } : {}), ...(narrowed ? { routesOutsideNarrowing: routesAll!.length - routesKept!.length } : {}) } : {}),
      ...(profile === 'preview' ? { preview: { viewport: 'phone', width: PREVIEW_WIDTH, pages: pagesShown, ...(pageWindow.omitted ? { unmeasuredPages: pageWindow.omitted } : {}) } } : {}),
      ...(nexts.length ? { nextOffset: nexts } : {}),
      ...(more.length ? { more: more.join(' ') } : {})
    };
  };
  let content = build(1);
  for (let scale = 0.5; JSON.stringify(content).length > RESULT_ROOM && scale >= 1 / 64; scale /= 2) content = build(scale);
  if (previewFailed) {
    // What was found is still given, as the failure's details: each page's own error says why it could not be measured.
    const { revision, ...found } = content;
    return toolError('VALIDATION_FAILED', 'The preview check could not run on every page: a preview that is not running or not up to date is a failed check, never a clean one.', { details: found, revision });
  }
  return { ok: true, content };
}

/**
 * Managed references to library images that the schema checks leave alone: the site's icon, logo and sharing image,
 * and each page's sharing image, naming an asset the library does not have.
 */
function danglingAssetReferences(state: ProjectState): Diagnostic[] {
  const out: Diagnostic[] = [];
  const check = (id: unknown, what: string, site: string, owner?: Diagnostic['owner']) => {
    if (typeof id === 'string' && id && !Object.hasOwn(state.assets.assets, id))
      out.push({ severity: 'error', code: 'ASSET_MISSING', message: `${what} names an image that is not in the library ("${id}"). Choose another image.`, ...(owner ? { owner } : {}), site });
  };
  check(state.site.favicon, 'The site icon', 'favicon');
  check(state.site.socialImage, 'The site’s sharing image', 'socialImage');
  check(state.site.identity?.logo, 'The site’s logo', 'logo');
  for (const p of Object.values(state.pages)) check(p.seo?.socialImage, `${p.title}: the page’s sharing image`, 'socialImage', { kind: 'page', id: p.id });
  return out;
}
