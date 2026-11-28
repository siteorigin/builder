import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ProjectState, RedirectHost, SiteRedirect } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { isDraftEntry, siteEntries } from '@shared/collections';
import { redirectRecords, resolveRedirects, type LiveRedirect } from '@shared/redirects';
import { isDraftPage } from '@generator/index';
import { redirectHost } from '@generator/host-redirects';
import { runsOnNode } from '@shared/deploy-target';
import { TriangleAlert } from 'lucide-react';
import { Field, Segmented } from '../components/ui';
import { applyOps } from '../store';

/** What each host choice writes beside the website, as the select's hint says it. */
const HOST_HINTS: Record<RedirectHost, string> = {
  cloudflare: 'Sends old addresses on with a permanent (301) redirect, written to _redirects as Cloudflare Pages reads it. Other hosts still send visitors on from each old address’s own page.',
  netlify: 'Writes _redirects as Netlify reads it, with each rule forced past the old address’s page.',
  vercel: 'Writes vercel.json beside the website, and _redirects for Cloudflare Pages.'
};
const HOST_LABELS: Record<RedirectHost, string> = { cloudflare: 'Cloudflare Pages or another host', netlify: 'Netlify', vercel: 'Vercel' };

type Kind = 'page' | 'post' | 'path';
/** The form adding a redirect (`from` null) or changing where one goes. */
interface Draft {
  from: string | null;
  typed: string;
  kind: Kind;
  pageId: string;
  entryId: string;
  to: string;
  revision?: number;
  /** The redirect as it was when the form opened: one changed or removed since is never written over. */
  was?: string;
  /** Which opening of the form this is: a save that ends after another form opened leaves that one alone. */
  opened: number;
}

/**
 * Where a redirect sends visitors, in words, with whether it ends at a draft the website leaves out: followed to its
 * end (`live`), so an address, or a chain, that reaches a draft says so too.
 */
function destination(state: ProjectState, r: SiteRedirect, live: LiveRedirect | undefined): { text: string; draft: boolean } {
  const draft = !!live && (live.page ? isDraftPage(state, live.page) : live.entry ? isDraftEntry(live.entry.entry) : false);
  if (r.pageId !== undefined) {
    const page = Object.hasOwn(state.pages, r.pageId) ? state.pages[r.pageId] : undefined;
    return page ? { text: `${page.title} (${page.route})`, draft } : { text: 'A page that no longer exists', draft: false };
  }
  if (r.entryId !== undefined) {
    const entry = siteEntries(state).find((e) => e.entry.id === r.entryId);
    return entry ? { text: `${entry.entry.title} (${entry.route})`, draft } : { text: 'A post that no longer exists', draft: false };
  }
  return { text: r.to ?? '', draft };
}

/**
 * Site settings, under Redirects: the old addresses the site keeps working, recorded when pages and posts move from an
 * address the website was exported with (or a published post's), or added
 * by the author, each with where it sends visitors and what Project health finds wrong with it, and the host the
 * website's 301 rules are written for. Each change is one step of the history, so Undo takes it back.
 */
export function RedirectsFields({ state, problems, revision }: { state: ProjectState; problems: ReadonlyArray<{ site?: string; message: string; severity: string }>; revision?: number }) {
  const uid = useId();
  const root = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<{ field: 'from' | 'to' | 'target'; message: string } | null>(null);
  const kindsRef = useRef<HTMLDivElement>(null);
  // A form opened on an existing redirect starts on where it sends visitors (a new one starts on its old address).
  const editing = draft && draft.from !== null ? draft.from : null;
  useEffect(() => {
    if (editing !== null) kindsRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }, [editing]);
  const list = redirectRecords(state);
  // Worked out once per project state, never per keystroke in the form, as the website has them: one kept at a draft's
  // address still sends visitors on.
  const live = useMemo(() => new Map(resolveRedirects(state, 'website').live.map((r) => [r.from, r])), [state]);
  // The drafts by address: one at an old address takes it over once it is published (#1363).
  const draftAt = useMemo(() => new Map(Object.values(state.pages).flatMap((p) => (isDraftPage(state, p) ? [[p.route.toLowerCase(), p] as const] : []))), [state]);
  // What the project is now, for a save that comes back refused after it has moved on.
  const now = useRef({ state, revision });
  now.current = { state, revision };
  // The form open now, and how many times one has been opened.
  const shown = useRef(draft);
  shown.current = draft;
  const openings = useRef(0);
  const pages = state.site.pageOrder.filter((id) => Object.hasOwn(state.pages, id)).map((id) => state.pages[id]);
  const posts = siteEntries(state);
  const host = redirectHost(state.site);
  const findings = (from: string) => problems.filter((d) => d.site === `redirect:${from}`);

  /** Focus where the author was once the form goes: the row's Edit button, or Add redirect. */
  const refocus = (from: string | null) =>
    requestAnimationFrame(() => (root.current?.querySelector<HTMLElement>(from === null ? '#site-redirects-add' : `[data-from="${CSS.escape(from)}"] .so-redirect-edit`) ?? root.current?.querySelector<HTMLElement>('#site-redirects-add'))?.focus());
  const close = () => {
    const from = draft?.from ?? null;
    setDraft(null);
    refocus(from);
  };
  const open = (r: SiteRedirect | null) => {
    setError(null);
    const kind: Kind = !r ? 'page' : r.pageId !== undefined ? 'page' : r.entryId !== undefined ? 'post' : 'path';
    setDraft({ from: r?.from ?? null, typed: '', kind, pageId: r?.pageId ?? pages[0]?.id ?? '', entryId: r?.entryId ?? posts[0]?.entry.id ?? '', to: r?.to ?? '', revision, was: r ? JSON.stringify(r) : undefined, opened: ++openings.current });
  };
  const save = async () => {
    if (!draft) return;
    const typed = draft.typed.trim();
    const to = draft.to.trim();
    if (draft.from === null && !typed) return setError({ field: 'from', message: 'Type the old address, such as /old-services/.' });
    // An empty address is never taken for Home.
    if (draft.kind === 'path' && !to) return setError({ field: 'to', message: 'Type the address it sends visitors to, such as /blog/, or / for Home.' });
    // A page or post that has gone is never saved again as the destination: the form asks for its replacement.
    if (draft.kind === 'page' && !pages.some((p) => p.id === draft.pageId)) return setError({ field: 'target', message: 'Choose the page it sends visitors to now.' });
    if (draft.kind === 'post' && !posts.some((p) => p.entry.id === draft.entryId)) return setError({ field: 'target', message: 'Choose the post it sends visitors to now.' });
    const target = draft.kind === 'page' ? { pageId: draft.pageId } : draft.kind === 'post' ? { entryId: draft.entryId } : { to: to.startsWith('/') ? to : `/${to}` };
    const op: EditOperation = draft.from === null ? { type: 'redirect.add', from: typed.startsWith('/') ? typed : `/${typed}`, ...target } : { type: 'redirect.update', from: draft.from, ...target };
    // Against the project as it was when the form opened: a redirect removed and made again meanwhile is not changed.
    const done = await applyOps([op], draft.from === null ? 'Add redirect' : 'Change redirect', undefined, draft.revision);
    // The list shows the change before the save is answered (on a slow disk, long before), so the author may already
    // have opened another redirect's form: that one stays open.
    if (shown.current?.opened !== draft.opened) return;
    if (done) close();
    // Refused, the form stays as typed, and saving again checks it against the project as it is now, which the list
    // shows; unless the redirect it changes was itself changed or removed meanwhile: then the form closes on it.
    else if (draft.from !== null && JSON.stringify(redirectRecords(now.current.state).find((r) => r.from === draft.from)) !== draft.was) close();
    else setDraft((d) => d && { ...d, revision: now.current.revision });
  };
  const remove = async (from: string) => {
    if (await applyOps([{ type: 'redirect.remove', from }], 'Remove redirect', undefined, revision)) refocus(null);
  };

  const form = draft && (
    <form
      className="so-redirect-form"
      aria-label={draft.from === null ? 'New redirect' : `Where ${draft.from} sends visitors`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {draft.from === null && (
        <Field label="Old address" error={error?.field === 'from' ? error.message : undefined}>
          <input id={`${uid}-from`} className="input" value={draft.typed} placeholder="/old-services/" autoFocus onChange={(e) => (setError(null), setDraft({ ...draft, typed: e.target.value }))} />
        </Field>
      )}
      <div className="so-redirect-kinds">
        <span className="field-label" id={`${uid}-to`}>
          Sends visitors to
        </span>
        {/* Focus starts here when the form opens on a redirect that already has an old address. */}
        <div ref={kindsRef}>
          <Segmented<Kind>
            radio
            full
            labelledBy={`${uid}-to`}
            value={draft.kind}
            onChange={(k) => (setError(null), setDraft({ ...draft, kind: k }))}
            options={[
              { value: 'page', label: 'A page' },
              { value: 'post', label: 'A post', disabled: !posts.length },
              { value: 'path', label: 'An address' }
            ]}
          />
        </div>
      </div>
      {draft.kind === 'page' && (
        <Field label="Page" info="It follows the page wherever it moves." error={error?.field === 'target' ? error.message : undefined}>
          <select id={`${uid}-page`} className="select" value={draft.pageId} onChange={(e) => (setError(null), setDraft({ ...draft, pageId: e.target.value }))}>
            {!pages.some((p) => p.id === draft.pageId) && (
              <option value={draft.pageId} disabled>
                {draft.pageId ? 'The page it sent visitors to is gone: choose another' : 'Choose a page'}
              </option>
            )}
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} ({p.route})
              </option>
            ))}
          </select>
        </Field>
      )}
      {draft.kind === 'post' && (
        <Field label="Post" info="It follows the post wherever it moves." error={error?.field === 'target' ? error.message : undefined}>
          <select id={`${uid}-post`} className="select" value={draft.entryId} onChange={(e) => (setError(null), setDraft({ ...draft, entryId: e.target.value }))}>
            {!posts.some((p) => p.entry.id === draft.entryId) && (
              <option value={draft.entryId} disabled>
                {draft.entryId ? 'The post it sent visitors to is gone: choose another' : 'Choose a post'}
              </option>
            )}
            {posts.map((p) => (
              <option key={p.entry.id} value={p.entry.id}>
                {p.entry.title} ({p.route})
              </option>
            ))}
          </select>
        </Field>
      )}
      {draft.kind === 'path' && (
        <Field label="Address" error={error?.field === 'to' ? error.message : undefined}>
          <input id={`${uid}-path`} className="input" value={draft.to} placeholder="/blog/" onChange={(e) => (setError(null), setDraft({ ...draft, to: e.target.value }))} />
        </Field>
      )}
      <div className="so-redirect-actions">
        <button type="button" className="btn btn-sm" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="btn btn-sm btn-primary">
          {draft.from === null ? 'Add redirect' : 'Save'}
        </button>
      </div>
    </form>
  );

  return (
    <div ref={root} className="so-redirects-fields">
      {/* A Node.js server reads no host's redirect rules: its old addresses are their pages (shared/deploy-target.ts). */}
      {runsOnNode(state.site) ? (
        <p className="faint so-redirects-node">The site is built as a Node.js server, so each old address is a page that sends visitors on (HTTP 200). No host rules are written.</p>
      ) : (
        <Field label="Published on" info={HOST_HINTS[host]}>
          <select id="site-redirect-host" className="select" value={host} onChange={(e) => void applyOps([{ type: 'site.update', redirectHost: e.target.value as RedirectHost }], 'Update site settings')}>
            {(['cloudflare', 'netlify', 'vercel'] as const).map((h) => (
              <option key={h} value={h}>
                {HOST_LABELS[h]}
              </option>
            ))}
          </select>
        </Field>
      )}
      {list.length ? (
        <ul className="so-redirects" aria-label="Redirects">
          {list.map((r) => {
            const where = destination(state, r, live.get(r.from));
            const held = draftAt.get(r.from.toLowerCase());
            const found = findings(r.from);
            const tone = found.some((d) => d.severity === 'error') ? ' has-error' : found.length ? ' has-warning' : '';
            return (
              <li key={r.from} data-from={r.from} className={`so-redirect${tone}`}>
                <div className="so-redirect-main">
                  <div className="so-redirect-route">
                    <code>{r.from}</code> <span aria-hidden="true">→</span>
                    <span className="sr-only">sends visitors to</span> <span>{where.text}</span>
                  </div>
                  <div className="so-redirect-meta faint">
                    {r.custom ? 'Added by you' : 'Recorded when it moved'}
                    {where.draft ? ' · to a draft, not exported yet' : ''}
                  </div>
                  {held && <div className="so-redirect-meta faint">Draft “{held.title}” takes it over once published</div>}
                  {/* A problem leads with its glyph, in its tone: never the card's colour alone. */}
                  {found.map((d, i) =>
                    d.severity === 'error' ? (
                      <div key={i} className="field-error">
                        {d.message}
                      </div>
                    ) : (
                      <div key={i} className="so-redirect-warning">
                        <TriangleAlert aria-hidden="true" />
                        <span>{d.message}</span>
                      </div>
                    )
                  )}
                </div>
                {draft?.from !== r.from && (
                  <div className="so-redirect-buttons">
                    <button type="button" className="btn btn-sm so-redirect-edit" aria-label={`Edit the redirect from ${r.from}`} onClick={() => open(r)}>
                      Edit
                    </button>
                    <button type="button" className="btn btn-sm" aria-label={`Remove the redirect from ${r.from}`} onClick={() => void remove(r.from)}>
                      Remove
                    </button>
                  </div>
                )}
                {draft?.from === r.from && form}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="field-hint">No redirects yet · moving a page adds one</p>
      )}
      {draft?.from === null ? (
        form
      ) : (
        <button type="button" id="site-redirects-add" className="btn btn-sm" onClick={() => open(null)}>
          Add redirect
        </button>
      )}
    </div>
  );
}
