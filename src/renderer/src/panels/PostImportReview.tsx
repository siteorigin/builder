import { useEffect, useRef, useState } from 'react';
import { FileDown, TriangleAlert } from 'lucide-react';
import type { PostImportExisting, PostImportKind, PostImportPreview, PostImportPreviewPost, PostImportResult } from '@shared/api';
import { formatArticleDate } from '@shared/articles';
import { POSTS_COLLECTION_ID } from '@shared/collections';
import { headerMenu } from '@engine/tree';
import { api, getState, setState, toast, undoAction, useStore } from '../store';
import { Modal } from '../components/ui';
import { flushOpenPost } from '../lib/post-draft';
import { enterToggles, ReviewDisclosure, ReviewHeading, ReviewSummary } from './ImportReview';
import './ImportReview.css';

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

/** The titles a reason names, in brackets after its count: "3 pages (“About”, “Contact” and “Team”): …". */
const NAMES = / \((?:“[^”]*”|\d+ untitled)(?:,? (?:and )?(?:“[^”]*”|\d+ untitled))*\)/;

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
/** What became of the header link an import asked for; nothing when it asked for none. */
const menuSaid = (added?: boolean) =>
  added === undefined
    ? ''
    : added
      ? 'Added the Blog link to the header menu.'
      : 'Its Blog link could not join the header menu, which is full or shows links from somewhere else: link one to the Posts index in the header’s menu.';
/** Routine posts past this many are folded behind a counted disclosure, so the posts to check stay in view. */
const ROUTINE_SHOWN = 8;

/** A post the author should read before importing: kept as a draft, given another address, or changed on the way. */
const needsCheck = (p: PostImportPreviewPost) => !!(p.draftReason || p.wantedSlug || p.notes.length);

function PostMeta({ p, language }: { p: PostImportPreviewPost; language?: string }) {
  return (
    <span className="import-review-meta">
      {[p.dateAssigned ? `Dated on import, ${formatArticleDate(p.date, language)}` : formatArticleDate(p.date, language), p.route, p.redirectFrom ? `was ${p.redirectFrom}` : '', p.pictures ? plural(p.pictures, 'picture', 'pictures') : ''].filter(Boolean).join(' · ')}
    </span>
  );
}

const terms = (p: PostImportPreviewPost) => [...p.categories, ...p.tags.map((t) => `#${t}`)];

/** A post with something to read: its title and state, then each change on the way in, at reading size. */
function PostRow({ p, language }: { p: PostImportPreviewPost; language?: string }) {
  const filed = terms(p);
  const changes = [p.draftReason ? `Kept as a draft: ${p.draftReason}.` : '', p.wantedSlug ? `Its address “${p.wantedSlug}” is taken, so it gets a numbered one.` : '', ...p.notes];
  return (
    <li className={`import-review-row post-import-row${p.draft ? ' draft' : ''}`} data-testid="post-import-row">
      <div className="import-review-name">
        <b>{p.title}</b>
        {p.draft && <span className="badge amber">Draft</span>}
      </div>
      <PostMeta p={p} language={language} />
      <ul className="post-import-notes">
        {changes.filter(Boolean).map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
      {filed.length > 0 && <p className="import-review-filed">Filed under {filed.join(', ')}</p>}
    </li>
  );
}

/**
 * A post that comes in as it is: one line, its title and state, then its date and new address. With `full`, the line
 * wraps to show everything a post to check shows: its whole address, its old one, its pictures and its terms.
 */
function PlainPostRow({ p, language, full }: { p: PostImportPreviewPost; language?: string; full: boolean }) {
  const filed = terms(p);
  return (
    <li className={`post-import-line${p.draft ? ' draft' : ''}${full ? ' full' : ''}`} data-testid="post-import-row">
      <span className="post-import-line-title">
        <b>{p.title}</b>
        {p.draft && <span className="badge amber">Draft</span>}
      </span>
      {full ? (
        <span className="post-import-line-more">
          <PostMeta p={p} language={language} />
          {filed.length > 0 && <span className="import-review-filed">Filed under {filed.join(', ')}</span>}
        </span>
      ) : (
        <span className="import-review-meta">
          {p.dateAssigned ? `Dated on import, ${formatArticleDate(p.date, language)}` : formatArticleDate(p.date, language)} · {p.route}
        </span>
      )}
    </li>
  );
}

/** Routine posts this few are shown with their details, with no switch for so short a list. */
const FULL_UNDER = 4;

/**
 * The posts that come in as they are, one line each, with one switch that shows every line's details: offered when a
 * line has more to show (an old address, pictures, terms) or an address too long to show whole on one line.
 */
function PlainPosts({ posts, language }: { posts: PostImportPreviewPost[]; language?: string }) {
  const [on, setOn] = useState(false);
  const short = posts.length < FULL_UNDER;
  const more = posts.some((p) => p.redirectFrom || p.pictures || p.categories.length || p.tags.length || p.route.length > 48);
  const full = short || on;
  return (
    <>
      {more && !short && (
        <label className="post-import-details">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} onKeyDown={(e) => enterToggles(e, () => setOn(!on))} /> Show old addresses, pictures and terms
        </label>
      )}
      <ul className={`post-import-lines${more ? '' : ' wrap'}`}>
        {posts.map((p, i) => (
          <PlainPostRow key={i} p={p} language={language} full={full} />
        ))}
      </ul>
    </>
  );
}

/** What importing does, in a few words: "Import 3 posts", "Update 2 posts", "Import 3 posts and update 2". */
function importLabel(made: number, updated: number): string {
  const make = made ? `Import ${plural(made, 'post', 'posts')}` : '';
  if (!updated) return make;
  return make ? `${make} and update ${updated.toLocaleString()}` : `Update ${plural(updated, 'post', 'posts')}`;
}

/** What an import did, for its notice: "Imported 3 posts.", "Updated 2 posts.", "Imported 3 posts and updated 2." */
function importedLabel(made: number, updated: number): string {
  const make = made || !updated ? `Imported ${plural(made, 'post', 'posts')}` : '';
  if (!updated) return `${make}.`;
  return make ? `${make} and updated ${updated.toLocaleString()}.` : `Updated ${plural(updated, 'post', 'posts')}.`;
}

/** "From export.xml (https://riverside.example)" names a file; a folder is named as one. */
const sourceOf = (p: PostImportPreview) => `${p.kind === 'markdown' ? `The folder “${p.source}”` : p.source}${p.site ? ` (${p.site})` : ''}`;

/**
 * What importing the chosen posts would do, before anything changes: the facts first (where they go, how many are
 * published and drafts, pictures found and missing, old addresses kept), then what stops it when anything does, then
 * every post, those with something to check before those that come in as they are. Importing makes one change the
 * author can undo; any other way out imports nothing. When some pictures could not be added, the dialog stays to list
 * each one, over the first imported post.
 */
export function PostImportReviewModal({ preview, opening }: { preview: PostImportPreview; opening: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<PostImportResult | null>(null);
  const [own] = useState(() => getState().modal);
  const resultRef = useRef<HTMLParagraphElement>(null);
  // Posts imported before are skipped unless the author chooses to update them from the source (#1519).
  const [existing, setExisting] = useState<PostImportExisting>('skip');
  // The Import button that had focus is gone once the result shows: focus goes to what the result says.
  useEffect(() => {
    if (done) resultRef.current?.focus();
  }, [done]);
  const workspaceKey = useStore((s) => s.snapshot?.workspaceKey);
  const language = useStore((s) => s.snapshot?.state.site.language);
  // A blog the import makes is offered its link in the header menu, as the blog's starter card is: ticked, while the
  // header has a menu to take it.
  const hasMenu = useStore((s) => !!s.snapshot && !!headerMenu(s.snapshot.state));
  const [toMenu, setToMenu] = useState(true);
  const offersMenu = preview.collection.create && hasMenu;
  const close = () => {
    if (getState().modal === own) setState({ modal: null });
  };
  const cancel = () => {
    if (busy) return;
    if (!done) void api.project.cancelPostImport(preview.id);
    close();
  };
  // The project it was made for has closed: the review goes with it.
  useEffect(() => {
    if (workspaceKey !== opening && !busy) {
      if (!done) void api.project.cancelPostImport(preview.id);
      close();
    }
  });
  const fresh = preview.posts.filter((p) => !p.existing);
  const already = preview.posts.filter((p) => p.existing);
  const updating = existing === 'update' && preview.update ? preview.update : null;
  // What the chosen way of importing brings: the new posts, and the posts already here when they are updated.
  const chosen = updating ?? preview;
  const n = fresh.length;
  const updates = updating?.posts ?? 0;
  const drafts = fresh.filter((p) => p.draft).length;
  const problems = chosen.problems;
  const blocked = problems.length > 0;
  // Every post is already here, and they are skipped: importing would do nothing.
  const nothing = !blocked && !n && !updates;
  // A few missing pictures are listed open, since each is a loss to check; many fold behind their count.
  const missing = chosen.missing;
  const missingList = (
    <ul className="import-names single">
      {missing.map((m, i) => (
        <li key={i}>
          <b>{m.post}</b> · {m.ref.split('/').pop() || m.ref}: {m.problem}.<span className="import-review-ref">{m.ref}</span>
        </li>
      ))}
    </ul>
  );
  const run = async () => {
    setBusy(true);
    let r: PostImportResult;
    try {
      r = await api.project.commitPostImport(preview.id, opening, offersMenu && toMenu, existing);
    } catch {
      r = { ok: false, message: 'The posts could not be imported: the project could not be saved. Check that there is space on the disk, then try again.' };
    } finally {
      setBusy(false);
    }
    if (getState().snapshot?.workspaceKey !== opening) return close();
    if (!r.ok) {
      close();
      return toast(r.message ?? 'The posts were not imported.', 'error');
    }
    // Pictures that could not be added are each listed in the dialog, which stays over the first post; otherwise the
    // dialog goes and a notice says the import is done, with its Undo.
    if (r.notes?.length) setDone(r);
    else close();
    // The first imported post opens in the writer, but never over a post whose text could not be saved: that one stays,
    // with what to do about it above its text.
    if (r.firstEntryId && (await flushOpenPost()) && getState().snapshot?.workspaceKey === opening)
      setState({ post: { collectionId: POSTS_COLLECTION_ID, entryId: r.firstEntryId }, postView: 'write', postReveal: null });
    if (!r.notes?.length) toast([importedLabel(r.imported ?? n, r.updated ?? 0), menuSaid(r.addedToNavigation)].filter(Boolean).join(' '), 'info', r.entryId && r.revision !== undefined ? undoAction({ entryId: r.entryId, revision: r.revision, workspaceKey: opening }) : undefined);
  };

  if (done) {
    const undo = done.entryId && done.revision !== undefined ? undoAction({ entryId: done.entryId, revision: done.revision, workspaceKey: opening }) : undefined;
    const notes = done.notes ?? [];
    return (
      <Modal
        title={importedLabel(done.imported ?? n, done.updated ?? 0).slice(0, -1)}
        icon={<TriangleAlert className="import-review-warn" />}
        onClose={close}
        wide
        footer={
          <>
            {undo && (
              <button
                className="btn"
                onClick={() => {
                  undo.run();
                  close();
                }}
              >
                Undo import
              </button>
            )}
            <span className="spacer" />
            <button className="btn" onClick={close}>
              Close
            </button>
          </>
        }
      >
        <p className="import-result-lead" ref={resultRef} tabIndex={-1}>
          The posts are in, but {plural(notes.length, 'picture', 'pictures')} could not be added
          {missing.length > 0 ? `, and ${missing.length.toLocaleString()} more ${missing.length === 1 ? 'was' : 'were'} already missing from the chosen folder` : ''}, so{' '}
          {notes.length + missing.length === 1 ? 'its post shows without it' : 'their posts show without them'}.
        </p>
        {done.addedToNavigation !== undefined && <p className="import-result-steps">{menuSaid(done.addedToNavigation)}</p>}
        <p className="import-result-steps">
          {notes.length === 1
            ? `To put it back, fix the file as described below, add it to Assets, then place it in ${notes[0].posts.length > 1 ? 'each listed post' : 'its post'}. Or undo the import, fix the file, and import again.`
            : 'To put them back, fix each file as described below, add it to Assets, then place it in each listed post. Or undo the import, fix the files, and import again.'}
        </p>
        <section className="import-review-group" aria-labelledby="post-import-not-added">
          <ReviewHeading id="post-import-not-added">{plural(notes.length, 'picture', 'pictures')} not added</ReviewHeading>
          <ul className="import-review">
            {notes.map((note, i) => (
              <li key={i} className="import-review-row refuse">
                <div className="import-review-name">
                  <b>{note.file}</b>
                  {note.posts.length > 0 && <span className="muted">In {note.posts.map((t) => `“${t}”`).join(', ')}</span>}
                </div>
                <p className="import-review-what">
                  <TriangleAlert className="import-review-warn" aria-hidden="true" /> <span>{note.reason.charAt(0).toUpperCase() + note.reason.slice(1)}</span>
                </p>
              </li>
            ))}
          </ul>
        </section>
        {missing.length > 0 && (
          // What the review already said would be left out stays on the list of what to put back.
          <section className="import-review-group" aria-labelledby="post-import-left-out">
            <ReviewHeading id="post-import-left-out">{plural(missing.length, 'picture', 'pictures')} left out, as the review said</ReviewHeading>
            {missingList}
          </section>
        )}
      </Modal>
    );
  }

  const where = preview.collection.create ? `${preview.collection.name}, a new collection at ${preview.collection.route}` : `${preview.collection.name} at ${preview.collection.route}`;
  const toCheck = fresh.filter(needsCheck);
  const routine = fresh.filter((p) => !needsCheck(p));
  const newTerms = [chosen.newTerms.categories.length ? `${chosen.newTerms.categories.length === 1 ? 'Category' : 'Categories'}: ${chosen.newTerms.categories.join(', ')}` : '', chosen.newTerms.tags.length ? `${chosen.newTerms.tags.length === 1 ? 'Tag' : 'Tags'}: ${chosen.newTerms.tags.join(', ')}` : ''].filter(Boolean);
  // Reasons naming many items keep the summary to their counts; every name is in the list under it.
  const skippedLong = preview.skipped.join(' ').length > 240;
  const missingLabel = `${plural(missing.length, 'picture', 'pictures')} ${blocked ? 'would be' : 'will be'} left out`;
  const unread = already.filter((p) => p.unread).length;
  const alreadyLabel = `${plural(already.length, 'post is', 'posts are')} already in the project, so ${already.length === 1 ? 'it' : 'they'} ${updating ? 'will be updated from the export' : `will be left as ${already.length === 1 ? 'it is' : 'they are'}`}`;
  const posts = (
    <>
      {toCheck.length > 0 && (
        <section className="import-review-group" aria-labelledby="post-import-check">
          <ReviewHeading id="post-import-check">{toCheck.length === 1 ? 'Check this post' : `Check these ${plural(toCheck.length, 'post', 'posts')}`}</ReviewHeading>
          <ul className="import-review">
            {toCheck.map((p, i) => (
              <PostRow key={i} p={p} language={language} />
            ))}
          </ul>
        </section>
      )}
      {routine.length > 0 &&
        (() => {
          const label = `${plural(routine.length, toCheck.length ? 'other new post comes' : already.length ? 'new post comes' : 'post comes', toCheck.length ? 'other new posts come' : already.length ? 'new posts come' : 'posts come')} in as ${routine.length === 1 ? 'it is' : 'they are'}`;
          const list = <PlainPosts posts={routine} language={language} />;
          return routine.length > ROUTINE_SHOWN ? (
            <ReviewDisclosure className="import-review-group" summary={label} testId="post-import-routine">
              {list}
            </ReviewDisclosure>
          ) : (
            <section className="import-review-group" aria-labelledby="post-import-routine">
              <ReviewHeading id="post-import-routine">{label}</ReviewHeading>
              {list}
            </section>
          );
        })()}
      {already.length > 0 && (
        <ReviewDisclosure className="import-review-group" summary={alreadyLabel.replace(/, so .*$/, '')} testId="post-import-existing">
          {updating && unread > 0 && <p className="import-summary-note">{plural(unread, 'post’s', 'posts’')} text could not be read this time, so {unread === 1 ? 'it is' : 'they are'} left as {unread === 1 ? 'it is' : 'they are'}.</p>}
          <PlainPosts posts={already} language={language} />
        </ReviewDisclosure>
      )}
    </>
  );
  return (
    <Modal
      title={blocked ? 'These posts can’t be imported' : nothing ? (already.length === 1 ? 'This post is already in the project' : 'These posts are already in the project') : importLabel(n, updates)}
      icon={blocked ? <TriangleAlert className="import-review-icon-blocked" /> : <FileDown />}
      onClose={cancel}
      busy={busy}
      wide
      footer={
        blocked || nothing ? (
          <button className="btn" onClick={cancel}>
            Close
          </button>
        ) : (
          <>
            <button className="btn" onClick={cancel} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" data-testid="post-import-confirm" onClick={() => void run()} disabled={busy}>
              {busy ? 'Importing…' : importLabel(n, updates)}
            </button>
          </>
        )
      }
    >
      {blocked && (
        <div className="post-import-problems" data-testid="post-import-problems" tabIndex={-1} data-autofocus>
          {problems.map((p, i) => (
            <p key={i} className="scope-note danger">
              <TriangleAlert aria-hidden="true" />
              <span>{p}</span>
            </p>
          ))}
        </div>
      )}
      <ReviewSummary
        focusFirst={!blocked}
        rows={[
          [already.length ? 'New posts' : 'Posts', !n ? 'None' : [plural(n - drafts, 'published', 'published'), drafts ? plural(drafts, 'draft', 'drafts') : ''].filter(Boolean).join(' · ')],
          already.length > 0 && [
            'Already here',
            <>
              <span data-testid="post-import-existing-count">{alreadyLabel}.</span>
              <span className="post-import-existing" role="radiogroup" aria-label="What to do with the posts already in the project">
                <label>
                  <input type="radio" name={`post-import-existing-${preview.id}`} checked={existing === 'skip'} disabled={busy} onChange={() => setExisting('skip')} /> Skip them
                </label>
                <label>
                  <input type="radio" name={`post-import-existing-${preview.id}`} checked={existing === 'update'} disabled={busy} onChange={() => setExisting('update')} data-testid="post-import-update" /> Update them from the export
                </label>
              </span>
            </>
          ],
          (chosen.pictures > 0 || missing.length > 0) && [
            'Pictures',
            <>
              {chosen.pictures ? `${chosen.pictures.toLocaleString()} found` : 'None found'}
              {missing.length > 0 && (
                <>
                  {' · '}
                  <span className="import-summary-loss">{missing.length.toLocaleString()} missing</span>
                </>
              )}
            </>
          ],
          // Each reason as the reader gave it: one may cover several items, so they are listed rather than counted.
          preview.skipped.length > 0 && [
            'Not imported',
            <ul className="import-summary-list">
              {(skippedLong ? preview.skipped.map((s) => s.replace(NAMES, '')) : preview.skipped).map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          ],
          ['Into', where],
          ['From', sourceOf(preview)],
          (preview.redirects > 0 || !!preview.redirectsLost) && [
            'Old addresses',
            <>
              {preview.redirects ? `${plural(preview.redirects, 'keeps', 'keep')} working` : 'None keep working'}
              {!!preview.redirectsLost && (
                <>
                  {' · '}
                  <span className="import-summary-loss">{preview.redirectsLost.toLocaleString()} can’t</span>
                </>
              )}
            </>
          ],
          newTerms.length > 0 && ['New categories and tags', newTerms.join(' · ')]
        ]}
      >
        {blocked || nothing ? 'Nothing has been imported.' : 'Nothing changes until you import, and you can undo the import in one step.'}
      </ReviewSummary>
      {!blocked && offersMenu && (
        <label className="post-import-menu">
          <input type="checkbox" checked={toMenu} disabled={busy} onChange={(e) => setToMenu(e.target.checked)} onKeyDown={(e) => enterToggles(e, () => setToMenu(!toMenu))} /> Add a Blog link to the header menu
        </label>
      )}
      {missing.length > 0 &&
        (missing.length <= 3 ? (
          <section className="import-review-group post-import-missing" aria-labelledby="post-import-missing">
            <ReviewHeading id="post-import-missing">
              <TriangleAlert className="import-review-warn" aria-hidden="true" /> {missingLabel}
            </ReviewHeading>
            {missingList}
          </section>
        ) : (
          <ReviewDisclosure className="import-review-group post-import-missing" icon={<TriangleAlert className="import-review-warn" aria-hidden="true" />} summary={missingLabel}>
            {missingList}
          </ReviewDisclosure>
        ))}
      {skippedLong && (
        <ReviewDisclosure className="import-review-group" summary="What is not imported, item by item">
          <ul className="import-names single">
            {preview.skipped.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </ReviewDisclosure>
      )}
      {blocked ? (
        <ReviewDisclosure className="import-review-group" summary={`The ${plural(preview.posts.length, 'post', 'posts')} it would import`}>
          {posts}
        </ReviewDisclosure>
      ) : (
        posts
      )}
    </Modal>
  );
}
