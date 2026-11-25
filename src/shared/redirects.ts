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
import { isDraftEntry, siteEntries, type SiteEntry } from './collections';
import { validateRoute, validateSegment } from './routes';
import type { PageDoc, ProjectState, SiteRedirect } from './types';

/** The most old addresses a chain names on the way (`via`); `hops` counts them all. */
export const VIA_SHOWN = 10;

/**
 * An old address kept working, with the address visitors end up at and what is there: a page, a collection entry the
 * site has a page for, or (neither) a page of a collection's archive. `rule` is the redirect as the documents keep it,
 * `via` the first old addresses a chain passes through on the way, in order (at most VIA_SHOWN), and `hops` how many it
 * passes through in all.
 */
export type LiveRedirect = { from: string; to: string; title: string; rule: SiteRedirect; via: string[]; hops: number } & (
  | { page: PageDoc; entry?: undefined }
  | { entry: SiteEntry; page?: undefined }
  | { page?: undefined; entry?: undefined }
);

/**
 * Why an old address sends visitors nowhere, or not straight there: it leads to itself (`self`), into a loop of old
 * addresses (`loop`, with the addresses that go round), to an address the site does not have (`missing`, with that
 * address), to one that is not an address of the site at all (`invalid`, which Project health names with the
 * redirect), or through other old addresses (`chain`, which still works: the website goes straight to the end).
 */
export type RedirectProblem =
  | { kind: 'self'; from: string }
  | { kind: 'loop'; from: string; cycle: string[] }
  | { kind: 'missing'; from: string; to: string }
  | { kind: 'invalid'; from: string }
  | { kind: 'chain'; from: string; via: string[]; hops: number; to: string };

/**
 * A loop of old addresses as it reads from `from`, back round to where it started ("/a/ → /b/ → /a/"): starting at
 * `from` when it is one of them.
 */
export function loopText(cycle: string[], from: string): string {
  const i = cycle.findIndex((f) => f.toLowerCase() === from.toLowerCase());
  const round = i > 0 ? [...cycle.slice(i), ...cycle.slice(0, i)] : cycle;
  return [...round, round[0]].join(' → ');
}

/**
 * Why `to` cannot be where a redirect sends visitors, or null: Home ("/"), or an address spelled as routes are. It
 * may be deeper than a page can be, since a category archive's later pages are (/blog/category/news/page/2/).
 */
export function redirectTargetProblem(to: string): string | null {
  if (to === '/') return null;
  if (!to.startsWith('/') || !to.endsWith('/')) return validateRoute(to);
  const segments = to.slice(1, -1).split('/');
  return segments.length <= 4 ? validateRoute(to) : (validateRoute(`/${segments.slice(0, 4).join('/')}/`) ?? segments.slice(4).map(validateSegment).find((e) => e !== null) ?? null);
}

/** Where a redirect leads, followed to the end. */
type Outcome =
  | { ok: true; to: string; title: string; via: string[]; hops: number; page?: PageDoc; entry?: SiteEntry }
  | { ok: false; kind: 'self' | 'invalid' }
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
 * and the first redirect kept at an address wins it. One leading to another address is left out at the address of a
 * collection's archive page, which is what the website has there. Drafts are places like any other here: the website
 * leaves out the redirects that end at one (see publishedState).
 */
export function resolveRedirects(state: ProjectState): { live: LiveRedirect[]; problems: RedirectProblem[] } {
  const list = redirectRecords(state);
  if (!list.length) return { live: [], problems: [] };
  const entries = siteEntries(state);
  const entryById = new Map(entries.map((e) => [e.entry.id, e]));
  const pageAt = new Map(Object.values(state.pages).map((p) => [p.route.toLowerCase(), p]));
  const entryAt = new Map(entries.map((e) => [e.route.toLowerCase(), e]));
  // A collection's archive pages, by address: places an address can lead to, worked out only when one might. Archive
  // pages never depend on redirects to other addresses, so working them out here never comes back round.
  let archives: Map<string, { route: string; title: string }> | undefined;
  const archiveAt = (key: string) => {
    archives ??= new Map(archivePages(state).map((p) => [p.route.toLowerCase(), { route: p.route, title: state.collections[p.collectionId]?.settings?.name ?? p.route }]));
    return archives.get(key);
  };
  const draftPage = (p: PageDoc) => p.draft === true && p.id !== state.site.homePageId;
  // The redirects kept, by their old address in lowercase, as case-insensitive file systems compare them.
  const rules = new Map<string, SiteRedirect>();
  for (const r of list) {
    const key = r.from.toLowerCase();
    if (r.from === '/' || validateRoute(r.from) || pageAt.has(key) || entryAt.has(key) || rules.has(key)) continue;
    // One that leads to a page or an entry that is gone holds nothing, as it always has.
    if (r.pageId !== undefined && !Object.hasOwn(state.pages, r.pageId)) continue;
    if (r.entryId !== undefined && !entryById.has(r.entryId)) continue;
    if (r.to !== undefined && archiveAt(key)) continue;
    rules.set(key, r);
  }
  /** Where one redirect leads by itself: somewhere, nowhere, or on to another old address (`next`). */
  const step = (key: string): Outcome | { next: string } => {
    const r = rules.get(key)!;
    if (r.pageId !== undefined) return { ok: true, to: state.pages[r.pageId].route, title: state.pages[r.pageId].title, via: [], hops: 0, page: state.pages[r.pageId] };
    if (r.entryId !== undefined) {
      const entry = entryById.get(r.entryId)!;
      return { ok: true, to: entry.route, title: entry.entry.title, via: [], hops: 0, entry };
    }
    const to = r.to!;
    if (redirectTargetProblem(to)) return { ok: false, kind: 'invalid' };
    const at = to.toLowerCase();
    if (at === key) return { ok: false, kind: 'self' };
    const page = pageAt.get(at);
    const entry = entryAt.get(at);
    const archive = archiveAt(at);
    // A draft at an archive page's address is kept back, and the archive page is what the website has there.
    if (page && !(archive && draftPage(page))) return { ok: true, to: page.route, title: page.title, via: [], hops: 0, page };
    if (entry && !(archive && isDraftEntry(entry.entry))) return { ok: true, to: entry.route, title: entry.entry.title, via: [], hops: 0, entry };
    if (archive) return { ok: true, to: archive.route, title: archive.title, via: [], hops: 0 };
    return rules.has(at) ? { next: at } : { ok: false, kind: 'missing', to };
  };
  const outcomes = new Map<string, Outcome>();
  const from = (key: string) => rules.get(key)!.from;
  /** Follows `start` to its end without recursing, so however long a chain is, it is walked once. */
  const follow = (start: string): Outcome => {
    const walk: string[] = [];
    const onWalk = new Map<string, number>();
    let key = start;
    let end: Outcome;
    for (;;) {
      const known = outcomes.get(key);
      if (known) {
        end = known;
        break;
      }
      const at = onWalk.get(key);
      if (at !== undefined) {
        // Round in a loop: every address in it goes nowhere, and so does every one leading into it.
        const cycle = walk.slice(at).map(from);
        for (const k of walk.slice(at)) outcomes.set(k, { ok: false, kind: 'loop', cycle });
        walk.length = at;
        end = { ok: false, kind: 'loop', cycle };
        break;
      }
      const s = step(key);
      if (!('next' in s)) {
        outcomes.set(key, s);
        end = s;
        break;
      }
      onWalk.set(key, walk.length);
      walk.push(key);
      key = s.next;
    }
    // Back along the walk: each one goes where the next one does, through it.
    for (let i = walk.length - 1; i >= 0; i--) {
      const hop = from(key);
      // Only the first few are named, so a chain however long takes as little room per address.
      end = end.ok ? { ...end, via: [hop, ...end.via.slice(0, VIA_SHOWN - 1)], hops: end.hops + 1 } : end.kind === 'loop' || end.kind === 'missing' ? end : end.kind === 'self' ? { ok: false, kind: 'loop', cycle: [hop] } : { ok: false, kind: 'missing', to: rules.get(key)!.to! };
      key = walk[i];
      outcomes.set(key, end);
    }
    return end;
  };
  const live: LiveRedirect[] = [];
  const problems: RedirectProblem[] = [];
  for (const [key, rule] of rules) {
    const o = follow(key);
    const source = rule.from;
    if (!o.ok) {
      problems.push(o.kind === 'loop' ? { kind: 'loop', from: source, cycle: o.cycle } : o.kind === 'missing' ? { kind: 'missing', from: source, to: o.to } : { kind: o.kind, from: source });
      continue;
    }
    if (o.hops) problems.push({ kind: 'chain', from: source, via: o.via, hops: o.hops, to: o.to });
    const base = { from: source, to: o.to, title: o.title, rule, via: o.via, hops: o.hops };
    live.push(o.page ? { ...base, page: o.page } : o.entry ? { ...base, entry: o.entry } : base);
  }
  return { live, problems };
}
