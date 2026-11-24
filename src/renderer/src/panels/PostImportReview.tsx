import { useEffect, useState } from 'react';
import { FileDown, TriangleAlert } from 'lucide-react';
import type { PostImportKind, PostImportPreview, PostImportPreviewPost } from '@shared/api';
import { formatArticleDate } from '@shared/articles';
import { POSTS_COLLECTION_ID } from '@shared/collections';
import { api, getState, setState, toast, undoAction, useStore } from '../store';
import { Modal } from '../components/ui';

/**
 * Choose a WordPress export or a folder of Markdown posts and show what importing it would do. Nothing changes until
 * the author imports from the review (PostImportReviewModal).
 */
export async function reviewPostImport(kind: PostImportKind): Promise<void> {
  const opening = getState().snapshot?.workspaceKey;
  if (!opening || getState().leaving) return;
  const r = await api.project.reviewPostImport(kind, opening);
  const current = getState().snapshot?.workspaceKey === opening && !getState().leaving;
  if (!r.ok) {
    if (r.message && current) toast(r.message, 'error');
    return;
  }
  if (!current) return void api.project.cancelPostImport(r.preview.id);
  // Another dialog opened while the posts were being read keeps what the author was doing in it.
  if (getState().modal) {
    void api.project.cancelPostImport(r.preview.id);
    toast('The posts were read, but another dialog is open. Choose Import posts again once it is closed.', 'info');
    return;
  }
  setState({ modal: { kind: 'post-import', opening, preview: r.preview } });
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function PostRow({ p, language }: { p: PostImportPreviewPost; language?: string }) {
  const terms = [...p.categories, ...p.tags.map((t) => `#${t}`)];
  return (
    <li className="import-review-row post-import-row" data-testid="post-import-row">
      <div className="import-review-name">
        <b>{p.title}</b>
        <span className="muted">
          {formatArticleDate(p.date, language)} · {p.draft ? 'Draft' : 'Published'} · {p.route}
        </span>
      </div>
      {(p.draftReason || p.wantedSlug || p.redirectFrom || terms.length > 0 || p.pictures > 0) && (
        <p className="import-review-what">
          <span>
            {[
              p.draftReason ? `Kept as a draft: ${p.draftReason}.` : '',
              p.wantedSlug ? `Its address “${p.wantedSlug}” is taken, so it gets a numbered one.` : '',
              p.redirectFrom ? `Its old address ${p.redirectFrom} keeps working.` : '',
              p.pictures ? plural(p.pictures, 'picture.', 'pictures.') : '',
              terms.length ? `Filed under ${terms.join(', ')}.` : ''
            ]
              .filter(Boolean)
              .join(' ')}
          </span>
        </p>
      )}
      {p.notes.length > 0 && (
        <ul className="post-import-notes">
          {p.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * What importing the chosen posts would do, before anything changes: where they go, which are drafts, the pictures
 * found and not found, old addresses kept working, and everything left out or changed on the way in. Importing makes
 * one change the author can undo; any other way out imports nothing.
 */
export function PostImportReviewModal({ preview, opening }: { preview: PostImportPreview; opening: string }) {
  const [busy, setBusy] = useState(false);
  const [own] = useState(() => getState().modal);
  const workspaceKey = useStore((s) => s.snapshot?.workspaceKey);
  const language = useStore((s) => s.snapshot?.state.site.language);
  const close = () => {
    if (getState().modal === own) setState({ modal: null });
  };
  const cancel = () => {
    if (busy) return;
    void api.project.cancelPostImport(preview.id);
    close();
  };
  // The project it was made for has closed: the review goes with it.
  useEffect(() => {
    if (workspaceKey !== opening && !busy) {
      void api.project.cancelPostImport(preview.id);
      close();
    }
  });
  const n = preview.posts.length;
  const drafts = preview.posts.filter((p) => p.draft).length;
  const blocked = preview.problems.length > 0;
  const run = async () => {
    setBusy(true);
    const r = await api.project.commitPostImport(preview.id, opening);
    setBusy(false);
    close();
    if (getState().snapshot?.workspaceKey !== opening) return;
    if (!r.ok) return toast(r.message ?? 'The posts were not imported.', 'error');
    if (r.firstEntryId) setState({ post: { collectionId: POSTS_COLLECTION_ID, entryId: r.firstEntryId }, postView: 'write', postReveal: null });
    const notes = r.notes?.length ? ` ${plural(r.notes.length, 'picture was', 'pictures were')} not added: ${r.notes[0]}` : '';
    toast(`Imported ${plural(r.imported ?? n, 'post', 'posts')}.${notes}`, notes ? 'error' : 'info', r.entryId && r.revision !== undefined ? undoAction({ entryId: r.entryId, revision: r.revision, workspaceKey: opening }) : undefined);
  };
  const where = `${preview.collection.name} at ${preview.collection.route}`;
  const summary = [
    plural(n - drafts, 'published post', 'published posts'),
    drafts ? plural(drafts, 'draft', 'drafts') : '',
    preview.pictures ? plural(preview.pictures, 'picture', 'pictures') : '',
    preview.redirects ? `${plural(preview.redirects, 'old address', 'old addresses')} kept working` : ''
  ].filter(Boolean);
  const newTerms = [preview.newTerms.categories.length ? `new categories: ${preview.newTerms.categories.join(', ')}` : '', preview.newTerms.tags.length ? `new tags: ${preview.newTerms.tags.join(', ')}` : ''].filter(Boolean);
  return (
    <Modal
      title={blocked ? 'These posts can’t be imported' : `Import ${plural(n, 'post', 'posts')}`}
      icon={<FileDown />}
      onClose={cancel}
      busy={busy}
      wide
      footer={
        <>
          <button className="btn" onClick={cancel} disabled={busy}>
            Cancel
          </button>
          {!blocked && (
            <button className="btn btn-primary" data-testid="post-import-confirm" onClick={() => void run()} disabled={busy}>
              {busy ? 'Importing…' : `Import ${plural(n, 'post', 'posts')}`}
            </button>
          )}
        </>
      }
    >
      <p className="muted import-review-lead">
        From {preview.source}
        {preview.site ? ` (${preview.site})` : ''} into {preview.collection.create ? `a new ${where}` : where}: {summary.join(', ')}.{newTerms.length ? ` With ${newTerms.join('; ')}.` : ''} Nothing changes until you import, and you can undo the import in one step.
      </p>
      {blocked && (
        <section className="import-review-group" aria-labelledby="post-import-problems">
          <h3 id="post-import-problems">What stops the import</h3>
          <ul className="import-review">
            {preview.problems.map((p, i) => (
              <li key={i} className="import-review-row refuse">
                <p className="import-review-what import-review-refused">
                  <TriangleAlert aria-hidden="true" /> <span>{p}</span>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {preview.missing.length > 0 && (
        <details className="import-review-all post-import-missing">
          <summary>{plural(preview.missing.length, 'picture is', 'pictures are')} not in the chosen folder and will be left out</summary>
          <ul>
            {preview.missing.map((m, i) => (
              <li key={i}>
                {m.ref} ({m.post}): {m.problem}.
              </li>
            ))}
          </ul>
        </details>
      )}
      {preview.skipped.length > 0 && (
        <p className="muted import-review-rest">Not imported: {preview.skipped.join(' ')}</p>
      )}
      <section className="import-review-group" aria-labelledby="post-import-posts">
        <h3 id="post-import-posts">{plural(n, 'post', 'posts')}</h3>
        <ul className="import-review">
          {preview.posts.map((p, i) => (
            <PostRow key={i} p={p} language={language} />
          ))}
        </ul>
      </section>
    </Modal>
  );
}
