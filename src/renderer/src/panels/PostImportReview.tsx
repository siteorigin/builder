import { useEffect, useRef, useState } from 'react';
import { FileDown, TriangleAlert } from 'lucide-react';
import type { PostImportKind, PostImportPreview, PostImportPreviewPost, PostImportResult } from '@shared/api';
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

/** Old-site addresses this few are listed open; more fold behind their count. */
const OLD_LINKS_SHOWN = 5;

/**
 * The old site's addresses the posts still link to, each once with how many posts link to it: they keep going to the
 * old site, which the new site may replace at the same address. One kept working says where it now sends visitors.
 */
function OldSiteLinks({ links, site }: { links: PostImportPreview['oldSiteLinks']; site?: string }) {
  const label = `${plural(links.length, 'link goes', 'links go')} to ${links.length === 1 ? 'an address' : 'addresses'} of the old site`;
  const list = (
    <>
      <p className="import-review-what">
        The posts keep {links.length === 1 ? 'this link' : 'these links'} as {links.length === 1 ? 'it is' : 'they are'}. Once this site is published at {site ?? 'the old site’s address'}, a link to an address it has no page at leads to Page not found, and Project health lists {links.length === 1 ? 'it' : 'each one'}.
      </p>
      <ul className="import-names single" data-testid="post-import-old-links">
        {links.map((l) => (
          <li key={l.url}>
            <b>{l.url}</b> · {plural(l.posts, 'post', 'posts')}
            {l.to ? ` · kept working: it sends visitors to ${l.to}` : ''}
          </li>
        ))}
      </ul>
    </>
  );
  return links.length <= OLD_LINKS_SHOWN ? (
    <section className="import-review-group" aria-labelledby="post-import-old-links">
      <ReviewHeading id="post-import-old-links">{label}</ReviewHeading>
      {list}
    </section>
  ) : (
    <ReviewDisclosure className="import-review-group" summary={label}>
      {list}
    </ReviewDisclosure>
  );
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
  const n = preview.posts.length;
  const drafts = preview.posts.filter((p) => p.draft).length;
  const blocked = preview.problems.length > 0;
  // A few missing pictures are listed open, since each is a loss to check; many fold behind their count.
  const missingList = (
    <ul className="import-names single">
      {preview.missing.map((m, i) => (
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
      r = await api.project.commitPostImport(preview.id, opening, offersMenu && toMenu);
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
    if (!r.notes?.length) toast([`Imported ${plural(r.imported ?? n, 'post', 'posts')}.`, menuSaid(r.addedToNavigation)].filter(Boolean).join(' '), 'info', r.entryId && r.revision !== undefined ? undoAction({ entryId: r.entryId, revision: r.revision, workspaceKey: opening }) : undefined);
  };

  if (done) {
    const undo = done.entryId && done.revision !== undefined ? undoAction({ entryId: done.entryId, revision: done.revision, workspaceKey: opening }) : undefined;
    const notes = done.notes ?? [];
    return (
      <Modal
        title={`Imported ${plural(done.imported ?? n, 'post', 'posts')}`}
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
          {preview.missing.length > 0 ? `, and ${preview.missing.length.toLocaleString()} more ${preview.missing.length === 1 ? 'was' : 'were'} already missing from the chosen folder` : ''}, so{' '}
          {notes.length + preview.missing.length === 1 ? 'its post shows without it' : 'their posts show without them'}.
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
        {preview.missing.length > 0 && (
          // What the review already said would be left out stays on the list of what to put back.
          <section className="import-review-group" aria-labelledby="post-import-left-out">
            <ReviewHeading id="post-import-left-out">{plural(preview.missing.length, 'picture', 'pictures')} left out, as the review said</ReviewHeading>
            {missingList}
          </section>
        )}
      </Modal>
    );
  }

  const where = preview.collection.create ? `${preview.collection.name}, a new collection at ${preview.collection.route}` : `${preview.collection.name} at ${preview.collection.route}`;
  const toCheck = preview.posts.filter(needsCheck);
  const routine = preview.posts.filter((p) => !needsCheck(p));
  const newTerms = [preview.newTerms.categories.length ? `${preview.newTerms.categories.length === 1 ? 'Category' : 'Categories'}: ${preview.newTerms.categories.join(', ')}` : '', preview.newTerms.tags.length ? `${preview.newTerms.tags.length === 1 ? 'Tag' : 'Tags'}: ${preview.newTerms.tags.join(', ')}` : ''].filter(Boolean);
  // Reasons naming many items keep the summary to their counts; every name is in the list under it.
  const skippedLong = preview.skipped.join(' ').length > 240;
  const missingLabel = `${plural(preview.missing.length, 'picture', 'pictures')} ${blocked ? 'would be' : 'will be'} left out`;
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
          const label = `${plural(routine.length, toCheck.length ? 'other post comes' : 'post comes', toCheck.length ? 'other posts come' : 'posts come')} in as ${routine.length === 1 ? 'it is' : 'they are'}`;
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
    </>
  );
  return (
    <Modal
      title={blocked ? 'These posts can’t be imported' : `Import ${plural(n, 'post', 'posts')}`}
      icon={blocked ? <TriangleAlert className="import-review-icon-blocked" /> : <FileDown />}
      onClose={cancel}
      busy={busy}
      wide
      footer={
        blocked ? (
          <button className="btn" onClick={cancel}>
            Close
          </button>
        ) : (
          <>
            <button className="btn" onClick={cancel} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" data-testid="post-import-confirm" onClick={() => void run()} disabled={busy}>
              {busy ? 'Importing…' : `Import ${plural(n, 'post', 'posts')}`}
            </button>
          </>
        )
      }
    >
      {blocked && (
        <div className="post-import-problems" data-testid="post-import-problems" tabIndex={-1} data-autofocus>
          {preview.problems.map((p, i) => (
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
          ['Posts', [plural(n - drafts, 'published', 'published'), drafts ? plural(drafts, 'draft', 'drafts') : ''].filter(Boolean).join(' · ')],
          (preview.pictures > 0 || preview.missing.length > 0) && [
            'Pictures',
            <>
              {preview.pictures ? `${preview.pictures.toLocaleString()} found` : 'None found'}
              {preview.missing.length > 0 && (
                <>
                  {' · '}
                  <span className="import-summary-loss">{preview.missing.length.toLocaleString()} missing</span>
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
        {blocked ? 'Nothing has been imported.' : 'Nothing changes until you import, and you can undo the import in one step.'}
      </ReviewSummary>
      {!blocked && offersMenu && (
        <label className="post-import-menu">
          <input type="checkbox" checked={toMenu} disabled={busy} onChange={(e) => setToMenu(e.target.checked)} onKeyDown={(e) => enterToggles(e, () => setToMenu(!toMenu))} /> Add a Blog link to the header menu
        </label>
      )}
      {preview.missing.length > 0 &&
        (preview.missing.length <= 3 ? (
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
      {preview.oldSiteLinks.length > 0 && <OldSiteLinks links={preview.oldSiteLinks} site={preview.site} />}
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
        <ReviewDisclosure className="import-review-group" summary={`The ${plural(n, 'post', 'posts')} it would import`}>
          {posts}
        </ReviewDisclosure>
      ) : (
        posts
      )}
    </Modal>
  );
}
