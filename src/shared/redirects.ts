/**
 * Old addresses kept working (SiteDoc.redirects), worked out as the website has them: where each one finally sends
 * visitors, and what keeps one from sending them anywhere.
 *
 * A redirect names a page or a collection entry by ID, so it follows that one's later moves, or another address of the
 * site (`to`). Such an address can be another old address, so one redirect can lead through others (a chain), back to
 * itself (a loop), or to an address nothing has. A chain is followed to its end, so every old address sends visitors
 * straight to where they will land; a loop, and an address that leads nowhere, sends them nowhere and is left out.
 */
import { archivePages } from './archives';
import { siteEntries, type SiteEntry } from './collections';
import { validateRoute } from './routes';
import type { PageDoc, ProjectState, SiteRedirect } from './types';

/**
 * An old address kept working, with the address visitors end up at and what is there: a page, a collection entry the
 * site has a page for, or (neither) a page of a collection's archive. `rule` is the redirect as the documents keep it,
 * and `via` the other old addresses a chain passes through on the way, in order.
 */
export type LiveRedirect = { from: string; to: string; title: string; rule: SiteRedirect; via: string[] } & (
  | { page: PageDoc; entry?: undefined }
  | { entry: SiteEntry; page?: undefined }
  | { page?: undefined; entry?: undefined }
);

/**
 * Why an old address sends visitors nowhere, or not straight there: it leads to itself (`self`), into a loop of old
 * addresses (`loop`, with the addresses that go round), to an address the site does not have (`missing`, with that
 * address), or through other old addresses (`chain`, which still works: the website goes straight to the end).
 */
export type RedirectProblem =
  | { kind: 'self'; from: string }
  | { kind: 'loop'; from: string; cycle: string[] }
  | { kind: 'missing'; from: string; to: string }
  | { kind: 'chain'; from: string; via: string[]; to: string };

/** Where a redirect leads, followed to the end. */
type Outcome =
  | { ok: true; to: string; title: string; via: string[]; page?: PageDoc; entry?: SiteEntry }
  | { ok: false; kind: 'self' }
  | { ok: false; kind: 'loop'; cycle: string[] }
  | { ok: false; kind: 'missing'; to: string };

/** A redirect as the documents keep it, if it names an old address and exactly one place it leads to. */
export function redirectRecord(item: unknown): SiteRedirect | null {
  if (!item || typeof item !== 'object') return null;
  const r = item as { from?: unknown; pageId?: unknown; entryId?: unknown; to?: unknown };
  if (typeof r.from !== 'string') return null;
  const targets = [r.pageId, r.entryId, r.to].filter((t) => t !== undefined);
  return targets.length === 1 && typeof targets[0] === 'string' ? (item as SiteRedirect) : null;
}

/** The redirects as the documents keep them, damaged ones left out, in their order. */
export function redirectRecords(state: Pick<ProjectState, 'site'>): SiteRedirect[] {
  const list: unknown = state.site?.redirects;
  return Array.isArray(list) ? list.flatMap((r) => redirectRecord(r) ?? []) : [];
}

/**
 * Every old address the website keeps working, followed to where it sends visitors, with what keeps the others from
 * working. One that a page or an entry uses now, that is not a valid route, or that leads to a page or entry that is
 * gone, is left out without a problem (Project health names those already): a page or entry always wins its route,
 * and the first redirect kept at an address wins it. Drafts are places like any other here: the website leaves out
 * the redirects that end at one (see publishedState).
 */
export function resolveRedirects(state: ProjectState): { live: LiveRedirect[]; problems: RedirectProblem[] } {
  const list = redirectRecords(state);
  if (!list.length) return { live: [], problems: [] };
  const entries = siteEntries(state);
  const entryById = new Map(entries.map((e) => [e.entry.id, e]));
  const pageAt = new Map(Object.values(state.pages).map((p) => [p.route.toLowerCase(), p]));
  const entryAt = new Map(entries.map((e) => [e.route.toLowerCase(), e]));
  // The redirects kept, by their old address in lowercase, as case-insensitive file systems compare them.
  const rules = new Map<string, SiteRedirect>();
  for (const r of list) {
    const key = r.from.toLowerCase();
    if (r.from === '/' || validateRoute(r.from) || pageAt.has(key) || entryAt.has(key) || rules.has(key)) continue;
    // One that leads to a page or an entry that is gone holds nothing, as it always has.
    if (r.pageId !== undefined && !Object.hasOwn(state.pages, r.pageId)) continue;
    if (r.entryId !== undefined && !entryById.has(r.entryId)) continue;
    rules.set(key, r);
  }
  // A collection's archive pages are places an address can lead to; worked out only when one might.
  let archives: Map<string, string> | undefined;
  const archiveAt = (key: string) => {
    archives ??= new Map(archivePages(state).map((p) => [p.route.toLowerCase(), state.collections[p.collectionId]?.settings?.name ?? p.route]));
    return archives.get(key);
  };
  const outcomes = new Map<string, Outcome>();
  const follow = (key: string, path: string[]): Outcome => {
    const known = outcomes.get(key);
    if (known) return known;
    const r = rules.get(key)!;
    let out: Outcome;
    if (r.pageId !== undefined) out = { ok: true, to: state.pages[r.pageId].route, title: state.pages[r.pageId].title, via: [], page: state.pages[r.pageId] };
    else if (r.entryId !== undefined) {
      const entry = entryById.get(r.entryId)!;
      out = { ok: true, to: entry.route, title: entry.entry.title, via: [], entry };
    } else {
      const to = r.to!;
      const at = to.toLowerCase();
      const page = pageAt.get(at);
      const entry = entryAt.get(at);
      const archive = page || entry ? undefined : archiveAt(at);
      if (at === key) out = { ok: false, kind: 'self' };
      else if (page) out = { ok: true, to: page.route, title: page.title, via: [], page };
      else if (entry) out = { ok: true, to: entry.route, title: entry.entry.title, via: [], entry };
      else if (archive !== undefined) out = { ok: true, to, title: archive, via: [] };
      else if (!rules.has(at)) out = { ok: false, kind: 'missing', to };
      else if (path.includes(at)) out = { ok: false, kind: 'loop', cycle: [...path.slice(path.indexOf(at)), key].map((k) => rules.get(k)!.from) };
      else {
        const next = follow(at, [...path, key]);
        // Through a loop, or to itself, is as much a loop: visitors never arrive.
        out = next.ok ? { ...next, via: [rules.get(at)!.from, ...next.via] } : next.kind === 'missing' ? next : { ok: false, kind: 'loop', cycle: next.kind === 'loop' ? next.cycle : [rules.get(at)!.from] };
      }
    }
    outcomes.set(key, out);
    return out;
  };
  const live: LiveRedirect[] = [];
  const problems: RedirectProblem[] = [];
  for (const [key, rule] of rules) {
    const o = follow(key, []);
    const from = rule.from;
    if (!o.ok) {
      problems.push(o.kind === 'self' ? { kind: 'self', from } : o.kind === 'loop' ? { kind: 'loop', from, cycle: o.cycle } : { kind: 'missing', from, to: o.to });
      continue;
    }
    if (o.via.length) problems.push({ kind: 'chain', from, via: o.via, to: o.to });
    const base = { from, to: o.to, title: o.title, rule, via: o.via };
    live.push(o.page ? { ...base, page: o.page } : o.entry ? { ...base, entry: o.entry } : base);
  }
  return { live, problems };
}
