import { useId, useState } from 'react';
import type { ProjectState, RedirectHost, SiteRedirect } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { isDraftEntry, siteEntries } from '@shared/collections';
import { redirectRecords } from '@shared/redirects';
import { isDraftPage } from '@generator/index';
import { redirectHost } from '@generator/host-redirects';
import { Field } from '../components/ui';
import { applyOps } from '../store';

/** What each host choice writes beside the website, as the select's hint says it. */
const HOST_HINTS: Record<RedirectHost, string> = {
  cloudflare: 'Writes _redirects as Cloudflare Pages reads it. Other hosts still send visitors on from each old address’s own page.',
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
}

/** Where a redirect sends visitors, in words, with whether that is a draft the website leaves out. */
function destination(state: ProjectState, r: SiteRedirect): { text: string; draft: boolean } {
  if (r.pageId !== undefined) {
    const page = Object.hasOwn(state.pages, r.pageId) ? state.pages[r.pageId] : undefined;
    return page ? { text: `${page.title} (${page.route})`, draft: isDraftPage(state, page) } : { text: 'A page that no longer exists', draft: false };
  }
  if (r.entryId !== undefined) {
    const entry = siteEntries(state).find((e) => e.entry.id === r.entryId);
    return entry ? { text: `${entry.entry.title} (${entry.route})`, draft: isDraftEntry(entry.entry) } : { text: 'A post that no longer exists', draft: false };
  }
  return { text: r.to ?? '', draft: false };
}

/**
 * Site settings, under Redirects: the old addresses the site keeps working, recorded when pages and posts move or added
 * by the author, each with where it sends visitors and what Project health finds wrong with it, and the host the
 * website's 301 rules are written for. Each change is one step of the history, so Undo takes it back.
 */
export function RedirectsFields({ state, problems, revision }: { state: ProjectState; problems: ReadonlyArray<{ site?: string; message: string; severity: string }>; revision?: number }) {
  const uid = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = redirectRecords(state);
  const pages = state.site.pageOrder.filter((id) => Object.hasOwn(state.pages, id)).map((id) => state.pages[id]);
  const posts = siteEntries(state);
  const host = redirectHost(state.site);
  const findings = (from: string) => problems.filter((d) => d.site === `redirect:${from}`);

  const open = (r: SiteRedirect | null) => {
    setError(null);
    const kind: Kind = !r ? 'page' : r.pageId !== undefined ? 'page' : r.entryId !== undefined ? 'post' : 'path';
    setDraft({ from: r?.from ?? null, typed: '', kind, pageId: r?.pageId ?? pages[0]?.id ?? '', entryId: r?.entryId ?? posts[0]?.entry.id ?? '', to: r?.to ?? '', revision });
  };
  const save = async () => {
    if (!draft) return;
    const target = draft.kind === 'page' ? { pageId: draft.pageId } : draft.kind === 'post' ? { entryId: draft.entryId } : { to: draft.to.trim().startsWith('/') ? draft.to.trim() : `/${draft.to.trim()}` };
    const typed = draft.typed.trim();
    if (draft.from === null && !typed) return setError('Type the old address, such as /old-services/.');
    const op: EditOperation = draft.from === null ? { type: 'redirect.add', from: typed.startsWith('/') ? typed : `/${typed}`, ...target } : { type: 'redirect.update', from: draft.from, ...target };
    // Against the project as it was when the form opened: a redirect removed and made again meanwhile is not changed.
    const done = await applyOps([op], draft.from === null ? 'Add redirect' : 'Change redirect', undefined, draft.revision);
    if (done) setDraft(null);
  };
  const remove = (from: string) => void applyOps([{ type: 'redirect.remove', from }], 'Remove redirect', undefined, revision);

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
        <Field label="Old address" controlId={`${uid}-from`} error={error ?? undefined} hint="An address of this site that visitors and search engines still arrive at.">
          <input id={`${uid}-from`} className="input" value={draft.typed} placeholder="/old-services/" autoFocus onChange={(e) => (setError(null), setDraft({ ...draft, typed: e.target.value }))} />
        </Field>
      )}
      <div className="so-redirect-kinds" role="radiogroup" aria-label="Sends visitors to">
        {(['page', 'post', 'path'] as const).map((k) => (
          <label key={k} className="so-redirect-kind">
            <input type="radio" name={`${uid}-to`} checked={draft.kind === k} disabled={k === 'post' && !posts.length} onChange={() => setDraft({ ...draft, kind: k })} /> {k === 'page' ? 'A page' : k === 'post' ? 'A post' : 'An address'}
          </label>
        ))}
      </div>
      {draft.kind === 'page' && (
        <Field label="Page" controlId={`${uid}-page`} hint="It follows the page wherever it moves.">
          <select id={`${uid}-page`} className="select" value={draft.pageId} onChange={(e) => setDraft({ ...draft, pageId: e.target.value })}>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} ({p.route})
              </option>
            ))}
          </select>
        </Field>
      )}
      {draft.kind === 'post' && (
        <Field label="Post" controlId={`${uid}-post`} hint="It follows the post wherever it moves.">
          <select id={`${uid}-post`} className="select" value={draft.entryId} onChange={(e) => setDraft({ ...draft, entryId: e.target.value })}>
            {posts.map((p) => (
              <option key={p.entry.id} value={p.entry.id}>
                {p.entry.title} ({p.route})
              </option>
            ))}
          </select>
        </Field>
      )}
      {draft.kind === 'path' && (
        <Field label="Address" controlId={`${uid}-path`} hint="Another address of this site, such as /blog/: whatever is there.">
          <input id={`${uid}-path`} className="input" value={draft.to} placeholder="/blog/" onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </Field>
      )}
      <div className="so-redirect-actions">
        <button type="button" className="btn btn-sm" onClick={() => setDraft(null)}>
          Cancel
        </button>
        <button type="submit" className="btn btn-sm btn-primary">
          {draft.from === null ? 'Add redirect' : 'Save'}
        </button>
      </div>
    </form>
  );

  return (
    <>
      <p className="field-hint">Old addresses that send visitors and search engines on with a permanent redirect (HTTP 301). Moving a page or a post keeps its old address here; add your own for addresses from an earlier website.</p>
      <Field label="Published on" hint={HOST_HINTS[host]}>
        <select id="site-redirect-host" className="select" value={host} onChange={(e) => void applyOps([{ type: 'site.update', redirectHost: e.target.value as RedirectHost }], 'Update site settings')}>
          {(['cloudflare', 'netlify', 'vercel'] as const).map((h) => (
            <option key={h} value={h}>
              {HOST_LABELS[h]}
            </option>
          ))}
        </select>
      </Field>
      {list.length ? (
        <ul className="so-redirects" aria-label="Redirects">
          {list.map((r) => {
            const where = destination(state, r);
            const found = findings(r.from);
            return (
              <li key={r.from} className={`so-redirect${found.length ? ' has-problem' : ''}`}>
                <div className="so-redirect-main">
                  <div className="so-redirect-route">
                    <code>{r.from}</code> <span aria-hidden="true">→</span>
                    <span className="sr-only">sends visitors to</span> <span>{where.text}</span>
                  </div>
                  <div className="so-redirect-meta faint">
                    {r.custom ? 'Added by you' : 'Recorded when it moved'}
                    {where.draft ? ' · Draft: left out of the website until it is published' : ''}
                  </div>
                  {found.map((d, i) => (
                    <div key={i} className={d.severity === 'error' ? 'field-error' : 'field-hint'}>
                      {d.message}
                    </div>
                  ))}
                </div>
                {draft?.from !== r.from && (
                  <div className="so-redirect-buttons">
                    <button type="button" className="btn btn-sm so-redirect-edit" aria-label={`Change where ${r.from} goes`} onClick={() => open(r)}>
                      Edit
                    </button>
                    <button type="button" className="btn btn-sm" aria-label={`Remove the redirect from ${r.from}`} onClick={() => remove(r.from)}>
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
        <p className="field-hint">No redirects yet.</p>
      )}
      {draft?.from === null ? (
        form
      ) : (
        <button type="button" id="site-redirects-add" className="btn btn-sm" onClick={() => open(null)}>
          Add redirect
        </button>
      )}
    </>
  );
}
