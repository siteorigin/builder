import './PostsPanel.css';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Bold, Check, CircleAlert, Clock, Eye, FileX, Heading2, Heading3, Heading4, ImagePlus, Italic, Link, List, ListChecks, ListOrdered, Newspaper, Pilcrow, Quote, Redo2, Send, TriangleAlert, Unlink, Undo2 } from 'lucide-react';
import type { Collection, EntryDoc, ImageValue, LinkRel, LinkValue, ProjectState, RichText } from '@shared/types';
import type { ProjectSnapshot } from '@shared/api';
import type { SeoSubject } from '@shared/seo';
import { collectionHasBody, collectionKind, entryRoute, findEntry, hasDetailPages, orderedEntries } from '@shared/collections';
import { formatArticleDate, isArticleDate } from '@shared/articles';
import { COLLECTION_LINK_PREFIX, linkFromTarget, linkToTarget, sameRichText } from '@shared/richtext';
import { linkableIndexes } from '@shared/archives';
import { relsFromAttribute } from '@shared/link-rel';
import { newId } from '@shared/ids';
import { normalizeRichText } from '@engine/values';
import { EngineError } from '@engine/tree';
import { sortAssets } from '@shared/asset-order';
import { applyOps, applyWith, commitIfUnchanged, commitOps, confirmDialog, getState, markDraft, projectHistory, setState, toast, useStore, type CheckedOutcome, type PendingEdit, type PostRef } from '../store';
import { DraftInput, Field, Modal, Section } from '../components/ui';
import { RevisionDateField } from '../components/SeoFields';
import { LinkRelControls } from '../components/LinkRelControls';
import { seoSummary } from '../lib/sharing';
import { AssetImage } from '../components/AssetImage';
import { SiteImageField } from './PropEditors';
import { TEXT_LIMITS } from '@shared/text-limits';
import { isImeComposing } from '../lib/ime';
import { appliesLanded, registerFlush, trackApply } from '../lib/pending';
import { PostDraft, setOpenWriter, setWriterHistory, type DraftProblem, type DraftSaveOutcome } from '../lib/post-draft';
import { articleProblem, blockAtCaret, caretIn, figureElement, fillFigure, insertFigure, placeCaret, readArticle, renderArticle, setBlock, spaceShortcut, toggleList, type ArticleBlockTag, type ArticleCaret, type ArticleListKind } from '../lib/post-dom';
import { MAX_POST_TITLE, postAt } from '../lib/posts';
import { PostTermFields } from './PostTerms';
import { entryTermLabels } from '@shared/entry-fields';
import type { EditOperation } from '@shared/ops';
import { openSeoView, setMode } from '../lib/actions';
import { visitAddress } from './Canvas';
import { SeoInlineActions, subjectKey, useDocumentPreview, useTypedSeo } from './SeoPreview';
import { PostSearchFields } from './PostSearchFields';
import { EntryValueFields } from './EntryValueFields';
import { entryNoun, entryNounLower, isReadOnlyCollection } from '../lib/content';

const MAX_EXCERPT = 320;
/** How long before an action a field's refusal still stops it: the blur its button press caused. */
const REFUSAL_WINDOW_MS = 1500;
const MAX_AUTHOR = 80;
const MAX_CAPTION = 300;

/** A checked write's outcome, as the draft hears it. */
function draftOutcome(o: CheckedOutcome): DraftSaveOutcome {
  switch (o.kind) {
    case 'applied':
    case 'unchanged':
      return { kind: o.kind };
    case 'busy':
      return { kind: 'busy', message: o.message };
    case 'changed':
      return { kind: 'changed' };
    case 'gone':
      return { kind: 'gone' };
    case 'closed':
      return { kind: 'closed' };
    default:
      return { kind: 'failed', message: 'message' in o ? o.message : undefined };
  }
}

/** What the problem note says about text that is not saved, of the entry called `noun` ("post", "case study"). */
function problemText(p: DraftProblem, noun = 'post'): string {
  switch (p.kind) {
    case 'busy':
      return 'The AI is changing the site. Your text is saved as soon as it finishes.';
    case 'changed':
      return `This ${noun}’s text was changed somewhere else while you were writing. Keep yours, or review the saved text and choose it instead.`;
    case 'gone':
      return `This ${noun} is no longer in the project. Your text is still here: copy it to keep it, or let it go.`;
    default:
      return `Your text could not be saved${p.message ? `: ${p.message}` : '.'} Try again now, or keep writing: it is tried again after your next change.`;
  }
}

/** Whether the caret, or any of the selection, is in a link of the text. */
function linkAtCaret(root: HTMLElement): boolean {
  const sel = document.getSelection();
  if (!sel?.rangeCount) return false;
  const at = (n: Node | null) => (n instanceof Element ? n : n?.parentElement)?.closest('a[href]');
  const a = at(sel.anchorNode) ?? at(sel.focusNode);
  if (a && root.contains(a)) return true;
  const range = sel.getRangeAt(0);
  return !range.collapsed && [...root.querySelectorAll('a[href]')].some((x) => range.intersectsNode(x));
}

/**
 * The Posts workspace's main area: the post chosen in the Posts panel, written on a page of its own, centred and
 * comfortably wide. Stays mounted while hidden (another panel, the preview), so nothing typed, and no caret, is lost.
 */
export function PostWriter({ hidden }: { hidden: boolean }) {
  const post = useStore((s) => s.post);
  const exists = useStore((s) => !!(s.snapshot && postAt(s.snapshot.state, s.post)));
  // A writer already open stays while the post is gone from the project (the AI, an Undo): it may hold unsaved text,
  // which it offers to keep. It lets go of the post itself once nothing is left unsaved.
  const shown = useRef<string | null>(null);
  const key = post ? `${post.collectionId}/${post.entryId}` : null;
  const keep = key !== null && (exists || shown.current === key);
  shown.current = keep ? key : null;
  return (
    <div className="post-writer" hidden={hidden}>
      {post && keep ? (
        <PostEditor key={`${post.collectionId}/${post.entryId}`} post={post} hidden={hidden} />
      ) : (
        <div className="post-none">
          <Newspaper aria-hidden="true" />
          <p>Choose an entry in the list, or start a new one.</p>
        </div>
      )}
    </div>
  );
}

type Dialog = null | { kind: 'image'; fig: HTMLElement | null; value: ImageValue; caption: string; at: HTMLElement | null } | { kind: 'link'; range: Range | null; text: string; to: 'page' | 'post' | 'index' | 'url'; page: string; entry: string; index: string; url: string; rel: LinkRel[]; newTab: boolean; error?: string };

function PostEditor({ post, hidden }: { post: PostRef; hidden: boolean }) {
  const snap = useStore((s) => s.snapshot)!;
  const runtime = useStore((s) => s.runtime);
  const aiBusy = useStore((s) => !!s.snapshot?.aiBusy);
  const reveal = useStore((s) => s.postReveal);
  const state = snap.state;
  const live = postAt(state, post);
  /** The post as last seen in the project, shown while it is gone and the writer still holds its unsaved text. */
  const last = useRef({ entry: live!, collection: state.collections[post.collectionId], snap });
  if (live) last.current = { entry: live, collection: state.collections[post.collectionId], snap };
  const { entry, collection } = last.current;
  const devUrl = runtime.state === 'ready' ? runtime.url : null;
  const root = useRef<HTMLDivElement>(null);
  /** The page: the title, the fields and the text. */
  const pageRef = useRef<HTMLElement>(null);
  /** The editable element, kept after React lets go of it: a writer going away still saves what it held. */
  const rootEl = useRef<HTMLDivElement | null>(null);
  /** The project this writer was opened in. */
  const opening = useRef(snap.workspaceKey);
  /** This writer, among every one opened for the post: its undo steps never join another's. */
  const instance = useRef(newId('w'));
  /** The changes to the post's fields (title, date, address…) on their way, and when one was last refused. */
  const fieldCommits = useRef(new Set<Promise<unknown>>());
  const fieldRefusedAt = useRef(-Infinity);
  /** This post in the SEO view, where its search settings can be typed in too. */
  const inView = `.seo-view [data-seo-doc="${CSS.escape(subjectKey({ kind: 'entry', collectionId: post.collectionId, entryId: post.entryId }))}"]`;
  /** The latest saveAll, for the toolbar's Preview (see setOpenWriter). */
  const saveAllRef = useRef<() => Promise<boolean>>(() => Promise.resolve(true));
  /** The latest `command`, for the editor's own input listener. */
  const commandRef = useRef<(run: () => void) => void>(() => {});
  /** Why the stored text cannot be edited here, if it cannot. */
  const unreadable = articleProblem(entry.body);
  /** The text the writer and the project last agreed on: what it showed from the project, or what it saved. */
  const agreed = useRef<RichText>(Array.isArray(entry.body) ? entry.body : []);
  /** Where the caret was when Undo or Redo was asked for, to put it back once the text is shown again. */
  const caretAfterHistory = useRef<ArticleCaret | null>(null);
  const [status, setStatus] = useState<{ dirty: boolean; saving: boolean; problem: DraftProblem | null }>({ dirty: false, saving: false, problem: null });
  const [dialog, setDialog] = useState<Dialog>(null);
  /** The text saved elsewhere, shown to read before the author chooses it over theirs. */
  const [reviewing, setReviewing] = useState(false);
  /**
   * Whether the text editor shows: while the collection's entries have text (#675), and while it holds text not saved
   * yet, so entry text turned off meanwhile never takes away what was typed. Turned on again, it shows the saved text.
   */
  const bodyOn = collectionHasBody(collection.settings) || status.dirty || !!status.problem;
  const [pressed, setPressed] = useState<{ bold: boolean; italic: boolean; block: string; link: boolean }>({ bold: false, italic: false, block: 'p', link: false });
  /** Changes to the post's fields (title, date…) on their way, for the bar's save state. */
  const [fieldsSaving, setFieldsSaving] = useState(0);
  /** Whether a field of the post holds text it could not save (marked invalid beside it), for the bar and the note. */
  const [fieldHeld, setFieldHeld] = useState(false);
  /** Whether a field of the post (not the text) holds typing it has not committed yet: it commits as it loses focus. */
  const [fieldEditing, setFieldEditing] = useState(false);
  /** The formatting button that takes Tab into the toolbar: one stop, the arrow keys move between them (roving). */
  const [toolAt, setToolAt] = useState('p');
  const draftKey = `post-text:${post.entryId}`;

  const draft = useMemo(
    () =>
      new PostDraft({
        read: () => {
          const el = root.current ?? rootEl.current;
          return el ? readArticle(el, getState().snapshot?.state ?? state) : agreed.current;
        },
        save: async (read, step) => {
          const from = checkedBase();
          if (!from) return { kind: 'closed' };
          // Sent as the project stores it (a link's address trimmed, say), so the writer's own save never later looks
          // like a change made somewhere else; text the project would refuse is said here, and kept.
          let body: RichText;
          try {
            body = normalizeRichText(read, from.state, 'The post’s text', undefined, { entries: true });
          } catch (e) {
            return { kind: 'failed', message: e instanceof EngineError ? e.message.replace(/^The post’s text: /, '') : undefined };
          }
          let committed: Promise<unknown> = Promise.resolve();
          // One writer's steps are its own: a post opened again starts steps no earlier writer's typing joins.
          const outcome = commitIfUnchanged(from, () => (committed = commitOps([{ type: 'entry.update', collectionId: post.collectionId, entryId: post.entryId, body }], `Edit ${entryNounLower(from.state.collections[post.collectionId])} text`, `post-text:${post.entryId}:${instance.current}:${step}`)));
          // Followed as a save in flight: Save and leaving the project wait for it.
          trackApply(outcome.then((o) => (o.kind === 'applied' || o.kind === 'unchanged' ? { ok: true } : { ok: false, message: o.kind === 'failed' ? o.message : undefined })));
          const o = await outcome;
          await committed.catch(() => undefined);
          if (o.kind === 'applied') agreed.current = body;
          return draftOutcome(o);
        },
        onChange: (s) => setStatus(s)
      }),
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  /**
   * What a save is checked against: the project as it is now, with the post's text as the writer and the project last
   * agreed on. A change to the text made anywhere else since then makes the save stop and ask (it would be replaced);
   * the writer's own earlier saves never do. A post no longer in the project is checked against the last project that
   * had it, so the save says it has gone. Null once the project has closed.
   */
  const checkedBase = (): ProjectSnapshot | null => {
    const now = getState().snapshot;
    if (!now || now.workspaceKey !== opening.current) return null;
    const agreedIn = (s: ProjectSnapshot): ProjectSnapshot | null => {
      const c = s.state.collections[post.collectionId];
      const e = c && Object.hasOwn(c.entries, post.entryId) ? c.entries[post.entryId] : undefined;
      return c && e ? { ...s, state: { ...s.state, collections: { ...s.state.collections, [c.settings.id]: { ...c, entries: { ...c.entries, [e.id]: { ...e, body: agreed.current } } } } } } : null;
    };
    return agreedIn(now) ?? agreedIn(last.current.snap);
  };

  // Show the post's text once the editor shows, then only when it changes in the project while nothing here is unsaved
  // (an Undo). Edit → Undo and Redo reach the text as the browser's own history: they are the project's here too.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    rootEl.current = el;
    const onBeforeInput = (e: InputEvent) => {
      // A space typed after `##`, `-` and the like at the start of a paragraph makes it a heading or a list.
      const shortcut = draft.isComposing ? null : spaceShortcut(el, e);
      if (shortcut) {
        e.preventDefault();
        commandRef.current(() => void shortcut());
        return;
      }
      if (e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo') return;
      e.preventDefault();
      void history(e.inputType === 'historyRedo' ? 'redo' : 'undo');
    };
    el.addEventListener('beforeinput', onBeforeInput);
    if (!unreadable) {
      // Enter starts a paragraph, as the site's text has them.
      document.execCommand('defaultParagraphSeparator', false, 'p');
      renderArticle(el, entry.body, state, devUrl);
      agreed.current = entry.body;
    }
    return () => el.removeEventListener('beforeinput', onBeforeInput);
  }, [bodyOn]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = root.current;
    if (!el || !live || unreadable || sameRichText(entry.body, agreed.current)) return;
    if (draft.dirty || draft.isComposing) return;
    const focused = el.contains(document.activeElement) || document.activeElement === el;
    const caret = caretAfterHistory.current ?? (focused ? caretIn(el) : null);
    caretAfterHistory.current = null;
    renderArticle(el, entry.body, state, devUrl);
    agreed.current = entry.body;
    if (focused) placeCaret(el, caret);
  }, [entry.body]); // eslint-disable-line react-hooks/exhaustive-deps
  // Gone from the project: unsaved text stays, with a way to copy it or let it go; with nothing unsaved, the writer lets
  // go of the post. Back again (an Undo of its removal): its text is saved as usual.
  // A save that answered 'gone' for a post that is here (it came back meanwhile) is saved again too.
  useEffect(() => {
    if (live) {
      if (draft.problem?.kind === 'gone') void draft.back();
      return;
    }
    if (draft.dirty) {
      if (draft.problem?.kind !== 'gone') draft.markGone();
    } else setState({ post: null, postView: 'write' });
  }, [!!live, status.dirty, status.problem?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pictures follow the library and the preview server (a file replaced, the preview started).
  useEffect(() => {
    root.current?.querySelectorAll<HTMLElement>('figure.post-figure').forEach((f) => fillFigure(f, state, devUrl));
  }, [devUrl, state.assets]); // eslint-disable-line react-hooks/exhaustive-deps

  // Unsaved text is a draft the whole editor knows of: Save and leaving the project wait for it, and say so if it is left.
  useEffect(() => markDraft(draftKey, status.dirty, status.problem ? problemText(status.problem, entryNounLower(collection)) : undefined), [draftKey, status.dirty, status.problem]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const offFlush = registerFlush(() => draft.flush());
    const offOpen = setOpenWriter(
      () => draft.flush(),
      () => saveAllRef.current(),
      { collectionId: post.collectionId, entryId: post.entryId },
      // A change to the post's fields made in the SEO view is followed as one of the writer's own.
      (change) => void follow(change)
    );
    const offHistory = setWriterHistory((action) => void history(action));
    return () => {
      offFlush();
      offOpen();
      offHistory();
      // Gone without being saved first (the project closed): what it held is read now, from the element kept for it.
      if (draft.dirty) void draft.flush().finally(() => draft.close());
      else draft.close();
      markDraft(draftKey, false);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Hidden (another panel, the preview): saved now. Each time is counted, so a preview asked for before the writer was put
  // away (and perhaps shown again) never starts after it (#700).
  const putAway = useRef(0);
  useEffect(() => {
    if (!hidden) return;
    putAway.current++;
    void draft.flush();
  }, [hidden]); // eslint-disable-line react-hooks/exhaustive-deps
  // Text held back while the AI worked is saved once it stops.
  useEffect(() => {
    if (!aiBusy && draft.problem?.kind === 'busy') void draft.retry();
  }, [aiBusy]); // eslint-disable-line react-hooks/exhaustive-deps
  // Show in Assets: the picture asked for, in view.
  useEffect(() => {
    if (!reveal || reveal.entryId !== post.entryId || hidden) return;
    const fig = root.current?.querySelectorAll<HTMLElement>('figure.post-figure')[reveal.picture - 1];
    if (!fig) return;
    fig.scrollIntoView({ block: 'center' });
    fig.classList.add('flash');
    const t = setTimeout(() => fig.classList.remove('flash'), 1600);
    return () => clearTimeout(t);
  }, [reveal?.seq, hidden]); // eslint-disable-line react-hooks/exhaustive-deps
  // The toolbar follows the caret.
  useEffect(() => {
    const onSel = () => {
      const el = root.current;
      const sel = document.getSelection();
      if (!el || !sel?.anchorNode || !el.contains(sel.anchorNode)) return;
      const block = blockAtCaret(el);
      const tag = block?.tagName.toLowerCase() ?? 'p';
      setPressed({ bold: document.queryCommandState('bold'), italic: document.queryCommandState('italic'), block: tag === 'ul' && block?.classList.contains('so-rich--check') ? 'check' : tag, link: linkAtCaret(el) });
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);
  // A field holding text it could not save (too long, an address another page has) marks itself invalid beside it:
  // the bar says so too, wherever the author has scrolled. A link's section picker marking a section gone is not counted.
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const check = () => setFieldHeld([...page.querySelectorAll('[aria-invalid="true"]')].some((el) => !el.closest('.insp-link-row')));
    check();
    const watch = new MutationObserver(check);
    watch.observe(page, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-invalid'] });
    return () => watch.disconnect();
  }, []);

  /** Follow a change to the post on its way, so Publish and Save draft wait for it. */
  const track = <T,>(p: Promise<T>): Promise<T> => {
    fieldCommits.current.add(p);
    setFieldsSaving((n) => n + 1);
    void p.finally(() => {
      fieldCommits.current.delete(p);
      setFieldsSaving((n) => Math.max(0, n - 1));
    });
    return p;
  };
  /**
   * Follow a change to the post's fields on its way (the writer's own, or one made in the SEO view), so Publish and Save
   * draft know whether it was saved: one the project refuses stops them. `held`: see update.
   */
  const follow = <T,>(change: Promise<T>, held = false): Promise<T> =>
    track(
      change.then((r) => {
        if (!r && !held) fieldRefusedAt.current = performance.now();
        return r;
      })
    );
  /**
   * Change fields of the post, followed so Publish and Save draft know whether it was saved. `held`: the change asks
   * for what the post had when it began (only an image imported again, which is checked and never written), so
   * having nothing to write is no refusal. The check writes nothing either way: when it fails (the field edited
   * meanwhile, the post or project gone, the AI busy) the post keeps what it has, and the import says itself why.
   */
  const update = (fields: Record<string, unknown>, label: string, held = false) =>
    follow(applyOps([{ type: 'entry.update', collectionId: post.collectionId, entryId: post.entryId, ...fields } as never], label), held);
  /**
   * Change what the post is filed under, worked out from the project at `revision`: an answer that the project has
   * moved on since comes back (not ok) to be worked out again, so no other change to the post is written over.
   */
  const sendAt = (ops: EditOperation[], label: string, revision: number) =>
    commitOps(ops, label, undefined, revision, { replanStale: true }).then((r) => {
      if (!r) fieldRefusedAt.current = performance.now();
      return r;
    });
  const refused = () => void (fieldRefusedAt.current = performance.now());
  /** A field's text the writer refuses itself (an empty title, a date that is not one): said, and counted. */
  const refuse = () => {
    fieldRefusedAt.current = performance.now();
    return false;
  };

  /** Undo or Redo the project, with what was typed saved first as its own step. */
  async function history(action: 'undo' | 'redo') {
    if (draft.isComposing) return;
    const el = root.current;
    caretAfterHistory.current = el ? caretIn(el) : null;
    const saved = await draft.flush();
    if (!saved && draft.dirty) return;
    draft.newStep();
    projectHistory(action);
  }

  /**
   * Run a formatting command where the caret is: one undo step of its own, between the typing before it and the typing
   * after it.
   */
  const command = (run: () => void) => {
    const el = root.current;
    // A deleted entry's text is only kept to copy: nothing changes it.
    if (!el || draft.isComposing || unreadable || draft.problem?.kind === 'gone' || isReadOnlyCollection(getState().snapshot?.state.collections[post.collectionId] ?? collection)) return;
    if (!el.contains(document.getSelection()?.anchorNode ?? null)) el.focus();
    draft.checkpoint(false);
    run();
    draft.checkpoint(true);
  };
  commandRef.current = command;
  // Blocks and lists change in the DOM directly: the browser's own commands can nest a list in a paragraph.
  const block = (tag: ArticleBlockTag) => command(() => void setBlock(root.current!, tag));
  const list = (kind: ArticleListKind) => command(() => void toggleList(root.current!, kind));
  /**
   * Run what a dialog chose once it has gone: while it is open the editor cannot take focus. The caret goes back to
   * where it was (`range`), or stays wherever `run` puts it.
   */
  const afterDialog = (range: Range | null, run: () => void) => {
    setDialog(null);
    requestAnimationFrame(() => {
      const el = root.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      const sel = document.getSelection();
      if (range && sel && el.contains(range.startContainer)) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      command(run);
    });
  };

  const openLink = () => {
    if (draft.problem?.kind === 'gone' || isReadOnlyCollection(getState().snapshot?.state.collections[post.collectionId] ?? collection)) return;
    const sel = document.getSelection();
    let range = sel?.rangeCount && root.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    const a = (sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement)?.closest('a');
    // The caret in a link edits that link: its words are chosen, so applying changes it in place, formatting kept.
    if (range?.collapsed && a && root.current?.contains(a)) {
      range = document.createRange();
      range.selectNodeContents(a);
      sel!.removeAllRanges();
      sel!.addRange(range.cloneRange());
    }
    const href = a && root.current?.contains(a) ? (a.getAttribute('href') ?? '') : '';
    // The destination the link keeps, while its address is the one shown with it (see post-dom).
    let kept: LinkValue | null = null;
    try {
      kept = a?.dataset.link && a.dataset.href === href ? (JSON.parse(a.dataset.link) as LinkValue) : null;
    } catch {
      kept = null;
    }
    const pageLink = kept?.type === 'page' && Object.hasOwn(state.pages, kept.target) ? kept : href && !kept ? linkFromTarget(href, state.pages) : null;
    const entryLink = kept?.type === 'entry' ? kept.target : href.startsWith('entry:') ? href.slice(6) : '';
    const indexes = linkableIndexes(state);
    const indexLink = kept?.type === 'collection' ? kept.target : href.startsWith(COLLECTION_LINK_PREFIX) ? href.slice(COLLECTION_LINK_PREFIX.length) : '';
    const firstPage = state.site.pageOrder[0] ?? Object.keys(state.pages)[0] ?? '';
    const posts = allPosts(state).filter((p) => p.id !== post.entryId);
    setDialog({
      kind: 'link',
      range,
      text: range?.toString() ?? '',
      to: entryLink ? 'post' : indexLink ? 'index' : pageLink?.type === 'page' ? 'page' : pageLink?.type === 'collection' ? 'index' : href ? 'url' : 'page',
      page: pageLink?.type === 'page' ? pageLink.target : firstPage,
      entry: entryLink || posts[0]?.id || '',
      index: indexLink || (pageLink?.type === 'collection' ? pageLink.target : '') || indexes[0]?.id || '',
      // A web, email or phone link keeps its address in the field; only a page, an entry or an index is chosen from a list.
      url: (pageLink && (pageLink.type === 'page' || pageLink.type === 'collection')) || entryLink || indexLink ? '' : kept ? linkToTarget(kept, state.pages) : href,
      // The anchor's own rel, which is what the post keeps (see post-dom), and whether it opens a new tab, which the
      // browser's new link for the words would otherwise lose.
      rel: a && root.current?.contains(a) ? relsFromAttribute(a.getAttribute('rel')) : [],
      newTab: range && root.current ? opensNewTab(root.current, range) : false
    });
  };
  const applyLink = (d: Extract<Dialog, { kind: 'link' }>) => {
    let href = '';
    let rels: LinkRel[] = [];
    if (d.to === 'page') href = Object.hasOwn(state.pages, d.page) ? state.pages[d.page].route : '';
    else if (d.to === 'post') href = findEntry(state, d.entry) ? `entry:${d.entry}` : '';
    else if (d.to === 'index') href = linkableIndexes(state).some((x) => x.id === d.index) ? `${COLLECTION_LINK_PREFIX}${d.index}` : '';
    else {
      const t = d.url.trim();
      const link: LinkValue | null = linkFromTarget(/^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]\S*)?$/i.test(t) ? `https://${t}` : t, state.pages);
      if (!link || link.type === 'page' || link.type === 'collection' || link.type === 'anchor') return setDialog({ ...d, error: 'Use a full web address, such as https://example.com, or mailto: or tel:.' });
      href = /^https?:/i.test(t) || t.startsWith('mailto:') || t.startsWith('tel:') ? t : `https://${t}`;
      if (link.type === 'url') rels = d.rel;
    }
    if (!href) return setDialog({ ...d, error: 'Choose where the link goes.' });
    // A link that opened a new tab still does, to a page, a post or a web address: an email or a call opens its app.
    const newTab = d.newTab && !/^(mailto|tel):/i.test(href);
    const words = d.range && !d.range.collapsed ? '' : d.text.trim();
    if (d.range?.collapsed !== false && !words) return setDialog({ ...d, error: 'Type the words the link is on.' });
    afterDialog(d.range, () => {
      if (words) {
        const a = document.createElement('a');
        a.setAttribute('href', href);
        if (rels.length) a.setAttribute('rel', rels.join(' '));
        if (newTab) a.setAttribute('target', '_blank');
        a.textContent = words;
        document.execCommand('insertHTML', false, a.outerHTML);
        return;
      }
      document.execCommand('createLink', false, href);
      // The browser makes new links for the words, with nothing but the address: the ticked relationships and the new
      // tab go on each of them.
      const sel = document.getSelection();
      const now = (rels.length || newTab) && sel?.rangeCount ? sel.getRangeAt(0) : null;
      root.current?.querySelectorAll('a[href]').forEach((a) => {
        if (!now || a.getAttribute('href') !== href || !now.intersectsNode(a)) return;
        if (rels.length) a.setAttribute('rel', rels.join(' '));
        // A new link the browser joined to a neighbour going to the same place holds that neighbour's words too: they
        // keep the tab they opened in.
        if (newTab && coversAll(now, a)) a.setAttribute('target', '_blank');
      });
    });
  };

  const openImage = (fig: HTMLElement | null) => {
    const el = root.current;
    if (!el || draft.problem?.kind === 'gone' || isReadOnlyCollection(getState().snapshot?.state.collections[post.collectionId] ?? collection)) return;
    const at = fig ? null : blockAtCaret(el);
    const d = fig?.dataset;
    setDialog({ kind: 'image', fig, at, value: { assetId: d?.assetId ?? null, alt: d?.alt ?? '', ...(d?.decorative ? { decorative: true } : {}) }, caption: d?.caption ?? '' });
  };
  const applyImage = (d: Extract<Dialog, { kind: 'image' }>) => {
    const el = root.current;
    if (!el || !d.value.assetId) return;
    afterDialog(null, () => {
      const data = { type: 'image' as const, assetId: d.value.assetId!, alt: d.value.alt ?? '', ...(d.caption.trim() ? { caption: d.caption.trim() } : {}), ...(d.value.decorative ? { decorative: true as const } : {}) };
      if (d.fig && el.contains(d.fig)) {
        d.fig.dataset.assetId = data.assetId;
        d.fig.dataset.alt = data.alt;
        if (data.caption) d.fig.dataset.caption = data.caption;
        else delete d.fig.dataset.caption;
        if (data.decorative) d.fig.dataset.decorative = 'true';
        else delete d.fig.dataset.decorative;
        fillFigure(d.fig, getState().snapshot?.state ?? state, devUrl);
      } else {
        const fig = insertFigure(el, d.at && el.contains(d.at) ? d.at : null, figureElement(data, getState().snapshot?.state ?? state, devUrl));
        // On to the line after it.
        const next = fig.nextElementSibling as HTMLElement | null;
        if (next) placeCaret(el, { block: Array.prototype.indexOf.call(el.childNodes, next), offset: 0 });
      }
    });
  };
  const removeImage = (d: Extract<Dialog, { kind: 'image' }>) => afterDialog(null, () => void (d.fig && root.current?.contains(d.fig) && d.fig.remove()));

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    // Undo and Redo are the project's: each saved change of the text is a step, kept with the project.
    if (mod && !e.altKey && (k === 'z' || k === 'y')) {
      e.preventDefault();
      e.stopPropagation();
      void history(k === 'y' || e.shiftKey ? 'redo' : 'undo');
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && k === 'b') return void (e.preventDefault(), command(() => document.execCommand('bold')));
    if (mod && !e.shiftKey && !e.altKey && k === 'i') return void (e.preventDefault(), command(() => document.execCommand('italic')));
    if (mod && !e.shiftKey && !e.altKey && k === 'k') return void (e.preventDefault(), e.stopPropagation(), openLink());
  };

  /**
   * Everything typed in the post saved: its text, and the field being typed in (its title, excerpt…), which commits as
   * it loses focus. False, said beside the field or above the text, when any of it could not be.
   */
  const saveAll = async (): Promise<boolean> => {
    // A synced entry holds nothing typed here: a saved value its controls mark (a link to a section gone) is not unsaved.
    if (isReadOnlyCollection(getState().snapshot?.state.collections[post.collectionId] ?? collection)) return draft.flush();
    // The button pressed takes focus from the field being typed in, which commits it just before this runs: a refusal
    // from that moment on (an address another page has, an empty title) stops what the button does.
    const since = performance.now() - REFUSAL_WINDOW_MS;
    const at = document.activeElement;
    if (at instanceof HTMLElement && at.closest('.post-page') && !at.closest('.post-body')) at.blur();
    // Or this post's search settings being typed in the SEO view, should anything save it from there.
    else if (at instanceof HTMLElement && at.closest(inView)) at.blur();
    const saved = await draft.flush();
    await Promise.allSettled([...fieldCommits.current]);
    await appliesLanded();
    // Or text kept for being too long, here or in the SEO view.
    return saved && fieldRefusedAt.current < since && !unsavedMark() && !heldInView();
  };
  saveAllRef.current = saveAll;
  /**
   * Whether the SEO view holds text typed for this post that it could not save (too long, an address that is not one):
   * still the post's, so Publish and Save draft wait for it as for the writer's own.
   */
  /**
   * Whether a field of the post marks text it holds and could not save. A link's section picker marks the saved
   * destination instead (a section gone), which nothing typed here would change, so it is not counted.
   */
  const unsavedMark = () => [...document.querySelectorAll('.post-page [aria-invalid="true"]')].some((el) => !el.closest('.insp-link-row'));
  const heldInView = () => !!document.querySelector(`${inView} [aria-invalid="true"]`);
  /** Say that part of the post is not saved, and where to see why: beside it here, or in the SEO view. */
  const notSaved = (what: string) => {
    const inView = heldInView() && !unsavedMark();
    toast(`${what} ${inView ? 'See its search settings in the SEO view.' : 'See the note beside it.'}`, 'error', inView ? { label: 'Open SEO view', opening: getState().snapshot?.workspaceKey, run: () => void openSeoView({ kind: 'entry', collectionId: post.collectionId, entryId: post.entryId }) } : undefined);
  };
  const publish = async (draftOn: boolean) => {
    const noun = entryNounLower(collection);
    if (!(await saveAll())) return notSaved(draftOn ? `Part of the ${noun} is not saved yet, so it stays as it is.` : `Part of the ${noun} is not saved yet, so it was not published.`);
    const r = await update({ draft: draftOn }, draftOn ? `Move ${noun} to drafts` : `Publish ${noun}`);
    // A record without a page of its own is on the website wherever a list of its collection shows it.
    const where = hasDetailPages(collection.settings) ? 'it is on the website from the next export.' : `lists of ${collection.settings.name} show it from the next export.`;
    if (r) toast(draftOn ? 'Moved to drafts: it comes off the website at the next export.' : `Published: ${where}`, 'success');
  };
  const saveDraft = async () => {
    if (await saveAll()) toast(entry.draft === false ? 'Saved.' : 'Saved as a draft.', 'success');
    else notSaved(`Part of the ${entryNounLower(collection)} is not saved yet.`);
  };
  const preview = async () => {
    const key = getState().snapshot?.workspaceKey;
    const away = putAway.current;
    // The preview shows what is saved: text that could not be saved stays in view with its note.
    if (!(await saveAll())) return notSaved(`Part of the ${entryNounLower(collection)} is not saved yet, so the preview would not show it.`);
    // Another post (or project) opened while this one saved: the preview was this post's, so it does not start (#578).
    // Nor once the writer was put away meanwhile (another panel, the SEO view), even if it is back: the author went
    // elsewhere (#700).
    const now = getState();
    if (now.snapshot?.workspaceKey !== key || now.post?.collectionId !== post.collectionId || now.post?.entryId !== post.entryId || putAway.current !== away || now.leftTab !== 'posts' || now.postView !== 'write') return;
    setState({ postView: 'preview' });
    setMode('preview');
    // Once the canvas shows again; a preview still starting opens the post once it is ready.
    requestAnimationFrame(() => {
      // The preview ended before it began (a page chosen): the canvas stays on the page the editor names (#578).
      if (getState().postView !== 'preview' || getState().post?.entryId !== post.entryId) return;
      const c = getState().snapshot?.state.collections[post.collectionId];
      const e = c && Object.hasOwn(c.entries, post.entryId) ? c.entries[post.entryId] : undefined;
      const route = c && e ? entryRoute(c, e) : undefined;
      if (route !== undefined && !visitAddress(route)) toast(`The preview is starting: the ${entryNounLower(c)} opens in it once it is ready.`, 'info');
    });
  };

  /** The author keeps their text over the one saved elsewhere: the next save replaces it, checked from here on. */
  const keepMine = () => {
    const e = getState().snapshot && postAt(getState().snapshot!.state, post);
    if (e) agreed.current = e.body;
    void draft.retry();
  };
  /** The author takes the text saved elsewhere: the writer shows it, and what they typed goes. */
  const showSaved = () => {
    const el = root.current;
    const now = getState().snapshot;
    const e = now && postAt(now.state, post);
    if (!el || !e || !now) return;
    // Text the writer cannot show is never put in its place: the author keeps theirs.
    const problem = articleProblem(e.body);
    if (problem) return toast(problem, 'error');
    renderArticle(el, e.body, now.state, devUrl);
    agreed.current = e.body;
    draft.reset();
  };
  /** The post is gone and the author lets its unsaved text go too: asked first, since nothing could bring it back. */
  const discard = async () => {
    const ok = await confirmDialog({
      title: 'Discard your text?',
      body: `This ${entryNounLower(collection)} is no longer in the project, so what you typed is the only copy. Copy it first if you want to keep it.`,
      confirmLabel: 'Discard text',
      stayLabel: 'Keep my text',
      danger: true,
      icon: 'discard'
    });
    if (ok) draft.reset();
  };
  /** The post is gone: its unsaved text copied, said either way, so a copy that failed is never taken for one made. */
  const copyText = () =>
    void (navigator.clipboard?.writeText(`${pageRef.current?.querySelector<HTMLTextAreaElement>('.post-title-input')?.value ?? entry.title}\n\n${root.current?.innerText ?? ''}`) ?? Promise.reject(new Error('no clipboard'))).then(
      () => toast('Copied your text. Paste it somewhere to keep it.', 'success'),
      () => toast('Your text could not be copied. Select it and copy it yourself.', 'error')
    );
  /** The field holding text it could not save, in view and focused, its section opened first. */
  const showHeld = () => {
    const el = [...(pageRef.current?.querySelectorAll<HTMLElement>('[aria-invalid="true"]') ?? [])].find((x) => !x.closest('.insp-link-row'));
    if (!el) return;
    const body = el.closest<HTMLElement>('.section-body[hidden]');
    if (body?.id) document.querySelector<HTMLButtonElement>(`.section-head[aria-controls="${CSS.escape(body.id)}"]`)?.click();
    requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'center' });
      el.focus({ preventScroll: true });
    });
  };

  const route = entryRoute(collection, entry) ?? '';
  const filedUnder = collection ? entryTermLabels(collection, entry, 'categories') : [];
  const published = entry.draft === false;
  // What the collection is (#675): records get a form of their fields, articles the writer with their fields beside it;
  // a collection without entry pages has no address, preview or search settings; a synced one is only read here.
  const structured = collectionKind(collection.settings) === 'structured';
  const paged = hasDetailPages(collection.settings);
  const readOnly = isReadOnlyCollection(collection);
  const noun = entryNoun(collection);
  const nounLower = entryNounLower(collection);
  // The collection's own name in a sentence ("lists of case studies"), an acronym ("FAQs") kept as it is.
  const pluralLower = /^[A-Z][a-z]/.test(collection.settings.name) ? collection.settings.name[0].toLowerCase() + collection.settings.name.slice(1) : collection.settings.name;
  // One field's value; a link to a section without an anchor comes with the change that gives it one, sent together.
  // An "On this page" link is the entry's own page, which the picker does not know: a section it gives an anchor is the
  // canvas's page, so only the link is kept.
  const setValue = (name: string, value: unknown, label: string, edit?: PendingEdit) =>
    edit && (value as { type?: unknown } | null)?.type !== 'anchor' ? follow(applyWith(edit, [{ type: 'entry.update', collectionId: post.collectionId, entryId: post.entryId, values: { [name]: value } } as never], label)) : update({ values: { [name]: value } }, label);
  const details = (
    <div className="post-fields">
      <Field label="Publication date" hint={`A date in the past backdates the ${nounLower}.`}>
        <DraftInput type="date" value={entry.publishedAt} onCommit={(v) => (isArticleDate(v) ? (v !== entry.publishedAt ? update({ publishedAt: v }, `Change ${nounLower} date`) : undefined) : refuse())} />
      </Field>
      <div data-entry-field="updatedAt" style={{ display: 'contents' }}>
        <RevisionDateField
          label="Last updated"
          hint={`When the ${nounLower} was last revised, for search engines. Leave empty when it hasn’t been.`}
          value={entry.updatedAt}
          onSet={(v) => update({ updatedAt: v }, `Change ${nounLower} revision date`)}
          onClear={() => update({ updatedAt: null }, `Clear ${nounLower} revision date`)}
          refuse={refuse}
        />
      </div>
      {paged && (
        <div className="post-field-wide">
          <Field label="Address" hint={`The last part of ${route}`}>
            <DraftInput value={entry.slug} onCommit={(v) => (v.trim() ? (v.trim() !== entry.slug ? update({ slug: v.trim() }, `Change ${nounLower} address`) : undefined) : refuse())} />
          </Field>
        </div>
      )}
      {/* data-entry-field: where Go to form lands, for a layout's form that reads this field (see open-destination). */}
      <div data-entry-field="author" style={{ display: 'contents' }}>
        <Field label="Author">
          <DraftInput value={entry.author ?? ''} limit={MAX_AUTHOR} placeholder="Who wrote it" onCommit={(v) => (v.trim() !== (entry.author ?? '') ? update({ author: v.trim() || null }, `Change ${nounLower} author`) : undefined)} />
        </Field>
      </div>
      <div data-entry-field="excerpt" className="post-field-wide">
        <Field label="Excerpt" hint={`A sentence or two for lists of ${pluralLower} and for search engines.`}>
          <DraftInput multiline rows={3} value={entry.excerpt ?? ''} limit={MAX_EXCERPT} onCommit={(v) => (v.trim() !== (entry.excerpt ?? '') ? update({ excerpt: v.trim() || null }, `Change ${nounLower} excerpt`) : undefined)} />
        </Field>
      </div>
      {/* The image editor's picker: a thumbnail of the one chosen, the library to browse, import or drop, and Remove. */}
      <SiteImageField title="Featured image" plain="featured" state={state} value={entry.featuredImage} onChange={(id) => void update({ featuredImage: id }, 'Change featured image', id === (entry.featuredImage ?? null))} />
      {!structured && <PostTermFields post={post} collection={collection} entry={entry} sendAt={sendAt} track={track} refused={refused} />}
    </div>
  );
  const values = <EntryValueFields state={state} collection={collection} entry={entry} readOnly={readOnly} set={setValue} refuse={refuse} />;
  const blockLabel = { p: 'Paragraph', h2: 'Heading 2', h3: 'Heading 3', h4: 'Heading 4', blockquote: 'Quote', ul: 'Bulleted list', ol: 'Numbered list', check: 'Check list' } as Record<string, string>;
  // Undo reaches what is typed and not saved yet (it is saved first, as its own step); Redo waits for it.
  const canUndo = snap.history.canUndo || status.dirty;
  const canRedo = snap.history.canRedo && !status.dirty;
  const tools: Array<{ id: string; label: string; keys?: string; icon: React.ReactNode; on?: boolean; off?: boolean; run: () => void; gap?: boolean }> = [
    { id: 'p', label: 'Paragraph', icon: <Pilcrow />, on: pressed.block === 'p' || pressed.block === 'div', run: () => block('p') },
    { id: 'h2', label: 'Heading 2', icon: <Heading2 />, on: pressed.block === 'h2', run: () => block('h2') },
    { id: 'h3', label: 'Heading 3', icon: <Heading3 />, on: pressed.block === 'h3', run: () => block('h3') },
    { id: 'h4', label: 'Heading 4', icon: <Heading4 />, on: pressed.block === 'h4', run: () => block('h4') },
    { id: 'blockquote', label: 'Quote', icon: <Quote />, on: pressed.block === 'blockquote', run: () => block('blockquote') },
    { id: 'bold', label: 'Bold', keys: '⌘B', icon: <Bold />, on: pressed.bold, run: () => command(() => document.execCommand('bold')), gap: true },
    { id: 'italic', label: 'Italic', keys: '⌘I', icon: <Italic />, on: pressed.italic, run: () => command(() => document.execCommand('italic')) },
    { id: 'ul', label: 'Bulleted list', icon: <List />, on: pressed.block === 'ul', run: () => list('ul'), gap: true },
    { id: 'ol', label: 'Numbered list', icon: <ListOrdered />, on: pressed.block === 'ol', run: () => list('ol') },
    { id: 'check', label: 'Check list', icon: <ListChecks />, on: pressed.block === 'check', run: () => list('check') },
    { id: 'link', label: pressed.link ? 'Edit link' : 'Link', keys: '⌘K', icon: <Link />, on: pressed.link, run: openLink, gap: true },
    { id: 'unlink', label: 'Remove link', icon: <Unlink />, off: !pressed.link, run: () => command(() => document.execCommand('unlink')) },
    { id: 'image', label: 'Picture', icon: <ImagePlus />, run: () => openImage(null), gap: true },
    { id: 'undo', label: 'Undo', keys: '⌘Z', icon: <Undo2 />, off: !canUndo, run: () => void history('undo'), gap: true },
    { id: 'redo', label: 'Redo', keys: '⇧⌘Z', icon: <Redo2 />, off: !canRedo, run: () => void history('redo') }
  ];
  // Groups break together when the toolbar wraps, so Link never sits a row away from Remove link.
  const groups = tools.reduce<Array<typeof tools>>((all, t) => (t.gap || !all.length ? [...all, [t]] : (all[all.length - 1].push(t), all)), []);
  // The toolbar is one stop for Tab: the button last moved to, or the first, takes it (WAI-ARIA APG toolbar).
  const rovingAt = tools.some((t) => t.id === toolAt) ? toolAt : tools[0].id;
  const onToolsKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-tool]')];
    const from = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (from < 0) return;
    const to = e.key === 'ArrowRight' ? (from + 1) % buttons.length : e.key === 'ArrowLeft' ? (from - 1 + buttons.length) % buttons.length : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setToolAt(buttons[to].dataset.tool!);
    buttons[to].focus();
  };

  // The bar's save state: the text and the fields together. A problem is said in words and with an icon, never by grey
  // text alone; a wait that resolves itself (the AI working) is not a failure.
  const problem = status.problem;
  const blocked = !!problem && problem.kind !== 'busy';
  const saveState: { text: string; tone: 'quiet' | 'busy' | 'problem'; icon?: React.ReactNode } = readOnly
    ? { text: 'Synced', tone: 'quiet' }
    : blocked || fieldHeld
      ? { text: 'Not saved', tone: 'problem', icon: <CircleAlert aria-hidden="true" /> }
      : problem?.kind === 'busy'
        ? { text: 'Waiting to save', tone: 'busy', icon: <Clock aria-hidden="true" /> }
        : status.saving || fieldsSaving > 0
          ? { text: 'Saving…', tone: 'quiet' }
          : status.dirty || fieldEditing
            ? { text: 'Editing…', tone: 'quiet' }
            : { text: published ? (paged ? 'Saved · changes go live at the next export' : 'Saved · changes show from the next export') : 'Saved', tone: 'quiet', icon: <Check aria-hidden="true" /> };
  const gone = problem?.kind === 'gone';
  // What needs everything saved first (Publish, Save draft, Move to drafts, Preview) is off while something cannot be.
  const held = blocked || fieldHeld;
  /** Typing in a field of the post (not the text, nor a box that only finds something): the bar says Editing… until it commits. */
  const typedInField = (e: React.SyntheticEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('.post-body, .post-terms-add, .post-picker') || !t.matches('input, textarea')) return;
    if ((t as HTMLInputElement).type === 'checkbox' || (t as HTMLInputElement).type === 'radio') return;
    setFieldEditing(true);
  };
  // A short scope for the closed details: when, by whom, and what it is filed under. The address is inside.
  const detailsScope = [formatArticleDate(entry.publishedAt, state.site.language), entry.author || '', filedUnder.join(', ')].filter(Boolean).join(' · ');
  const hasFields = Object.keys(collection.settings.fields ?? {}).length > 0;

  return (
    <>
      <div className="post-bar" role="group" aria-label={`${noun} status and actions`}>
        {/* A deleted entry is neither: the band says what it is. */}
        {!gone && (
          <span className={`badge ${published ? 'green' : ''}`}>
            {published && <Check aria-hidden="true" />}
            {published ? 'Published' : 'Draft'}
          </span>
        )}
        {readOnly && (
          <span className="badge" data-testid="entry-read-only" title="Synced from an external source: change it there, or detach the collection to edit it here.">
            Read-only
          </span>
        )}
        <span className={`post-save-state ${saveState.tone}`} role="status">
          {saveState.icon}
          {saveState.text}
        </span>
        <span className="grow" />
        {!gone && (
          <div className="post-bar-actions">
            {!readOnly && published && (
              <button className="btn btn-sm btn-ghost" disabled={held} onClick={() => void publish(true)} title={`Take the ${nounLower} off the website at the next export and keep it as a draft`}>
                Move to drafts
              </button>
            )}
            {paged && (
              <button className="btn btn-sm" disabled={held} onClick={() => void preview()} title={`See the ${nounLower} on the canvas as visitors will, in the site’s header and footer`}>
                <Eye aria-hidden="true" /> Preview in site
              </button>
            )}
            {!readOnly && !published && (
              <>
                <button className="btn btn-sm" disabled={held} onClick={() => void saveDraft()}>
                  Save draft
                </button>
                <button className="btn btn-sm btn-primary" disabled={held} onClick={() => void publish(false)}>
                  <Send aria-hidden="true" /> Publish
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {/* What is not saved stays in view above the page, wherever the author has scrolled, with what to do about it. */}
      {problem && (
        <div className={`post-problem scope-note ${problem.kind === 'busy' ? 'info' : 'danger'}`} role={problem.kind === 'busy' ? 'status' : 'alert'} data-problem={problem.kind}>
          {problem.kind === 'busy' ? <Clock aria-hidden="true" /> : problem.kind === 'gone' ? <FileX aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
          <p>{problemText(problem, nounLower)}</p>
          {problem.kind === 'changed' && (
            <div className="post-problem-actions">
              <button className="btn btn-sm btn-primary" onClick={keepMine}>
                Keep my text
              </button>
              <button className="btn btn-sm" onClick={() => setReviewing(true)}>
                Review the saved text
              </button>
            </div>
          )}
          {problem.kind === 'failed' && (
            <div className="post-problem-actions">
              <button className="btn btn-sm" onClick={() => void draft.retry()}>
                Try again
              </button>
            </div>
          )}
          {problem.kind === 'gone' && (
            <div className="post-problem-actions">
              <button className="btn btn-sm btn-primary" onClick={copyText}>
                Copy text
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => void discard()}>
                Discard my text
              </button>
            </div>
          )}
        </div>
      )}
      {fieldHeld && (!problem || problem.kind === 'busy') && (
        <div className="post-problem scope-note danger" role="alert" data-problem="field">
          <TriangleAlert aria-hidden="true" />
          <p>Part of this {nounLower} could not be saved. The note beside it says why.</p>
          <div className="post-problem-actions">
            <button className="btn btn-sm" onClick={showHeld}>
              Show the field
            </button>
          </div>
        </div>
      )}
      {unreadable && (
        <div className="post-problem scope-note danger" role="alert" data-problem="unreadable">
          <TriangleAlert aria-hidden="true" />
          <p>{unreadable}</p>
        </div>
      )}
      <div className="post-scroll">
        <article
          className="post-page"
          ref={pageRef}
          onInput={typedInField}
          // A field commits as it loses focus (or Escape puts its saved text back): from then on the save state is its commit's.
          onBlur={(e) => {
            const t = e.target as HTMLElement;
            if (!t.closest('.post-body') && t.matches('input, textarea')) setFieldEditing(false);
          }}
          // Escape puts a field's saved text back: nothing is being edited any more.
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !(e.target as HTMLElement).closest('.post-body')) setFieldEditing(false);
          }}
          // Nothing dropped on a synced entry is imported either: it would be refused once it was.
          onDropCapture={readOnly ? (e) => (e.preventDefault(), e.stopPropagation()) : undefined}
          onDragOverCapture={readOnly ? (e) => e.stopPropagation() : undefined}
        >
          {/* A synced entry is read here and changed in its source, and a deleted one has nothing to save its fields to:
              every field is off. The sections still open, so what they hold can be read. */}
          <fieldset className="post-fieldset" disabled={readOnly || gone}>
          {readOnly && (
            <p className="post-readonly" role="note">
              Read-only: this {nounLower} is synced from an external source. Change it there, or detach the collection to edit it here.
            </p>
          )}
          {/* A title is one line that wraps: all of it stays readable, and Enter saves it instead of adding a line. */}
          <DraftInput wrap className="input post-title-input" ariaLabel={`${noun} title`} value={entry.title} limit={MAX_POST_TITLE} placeholder={structured ? 'Name or title' : 'Title'} onCommit={(v) => (v.trim() ? (v.trim() !== entry.title ? update({ title: v.trim() }, `Rename ${nounLower}`) : undefined) : refuse())} />
          {structured ? (
            <div className="post-record">
              {values}
              <PostTermFields post={post} collection={collection} entry={entry} sendAt={sendAt} track={track} refused={refused} />
            </div>
          ) : null}
          </fieldset>
          {/* Settings stay closed under the title, each heading saying what it holds, so the text starts high on the page. */}
          <div className="post-sections">
            <div className="post-details">
              <Section id={structured ? 'post-record-publishing' : 'post-details'} title={structured ? 'Publishing' : `${noun} details`} scope={structured ? [formatArticleDate(entry.publishedAt, state.site.language), paged ? route : ''].filter(Boolean).join(' · ') : detailsScope} defaultOpen={false} keepMounted>
                <fieldset className="post-fieldset" disabled={readOnly || gone}>
                  {!structured && hasFields && <div className="post-custom">{values}</div>}
                  {details}
                </fieldset>
              </Section>
            </div>
            {paged && <PostSearchSettings state={state} post={post} collection={collection} entry={entry} update={update} off={readOnly || gone} />}
          </div>
          <fieldset className="post-fieldset" disabled={readOnly || gone}>
          {bodyOn && structured && <div className="post-record-section field-label">Text</div>}
          {bodyOn && (
          <>
          <div className="post-tools" role="toolbar" aria-label="Formatting" onKeyDown={onToolsKey}>
            {groups.map((g, i) => (
              <span key={i} className="post-tools-group">
            {g.map((t) => (
              <button
                key={t.id}
                type="button"
                data-tool={t.id}
                className={`icon-btn${t.gap ? ' gap' : ''}`}
                aria-label={t.label}
                title={t.keys ? `${t.label} (${t.keys})` : t.label}
                aria-pressed={t.on === undefined ? undefined : t.on}
                // Off, but still reachable with the arrow keys, so the toolbar never loses its one stop.
                aria-disabled={t.off || undefined}
                tabIndex={t.id === rovingAt ? 0 : -1}
                // Keeps the caret and the selection in the text.
                onMouseDown={(e) => e.preventDefault()}
                onFocus={() => setToolAt(t.id)}
                onClick={() => !t.off && t.run()}
              >
                {t.icon}
              </button>
            ))}
              </span>
            ))}
            <span className="post-block-name" aria-hidden="true">
              {blockLabel[pressed.block] ?? ''}
            </span>
          </div>
          <div
            ref={root}
            className="post-body"
            contentEditable={!unreadable && !readOnly && !gone}
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            // Read only (a deleted entry's text, kept to copy): still reached with Tab and selectable.
            aria-readonly={readOnly || gone || undefined}
            tabIndex={gone ? 0 : undefined}
            aria-label={`${noun} text`}
            spellCheck
            onInput={() => draft.input()}
            onCompositionStart={() => draft.compositionStart()}
            onCompositionEnd={() => draft.compositionEnd()}
            // Coming back to the text starts an undo step of its own; leaving it saves.
            onFocus={() => draft.newStep()}
            onBlur={() => void draft.flush()}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              // Words only: formatting comes from the toolbar, pictures from the library.
              e.preventDefault();
              const text = e.clipboardData.getData('text/plain');
              if (text) document.execCommand('insertText', false, text);
            }}
            onDrop={(e) => {
              if (e.dataTransfer.types.includes('Files')) e.preventDefault();
            }}
            onClick={(e) => {
              const fig = (e.target as HTMLElement).closest<HTMLElement>('figure.post-figure');
              if (fig && root.current?.contains(fig)) openImage(fig);
            }}
          />
          </>
          )}
          </fieldset>
        </article>
      </div>
      {reviewing && problem?.kind === 'changed' && (
        <SavedTextDialog
          noun={nounLower}
          body={postAt(state, post)?.body}
          state={state}
          devUrl={devUrl}
          onClose={() => setReviewing(false)}
          onKeepMine={() => (setReviewing(false), keepMine())}
          onUseSaved={() => (setReviewing(false), showSaved())}
        />
      )}
      {dialog?.kind === 'image' && (
        <Modal
          title={dialog.fig ? 'Picture' : 'Add a picture'}
          onClose={() => setDialog(null)}
          footer={
            <>
              {dialog.fig && (
                <button className="btn btn-danger" onClick={() => removeImage(dialog)}>
                  Remove picture
                </button>
              )}
              <span className="grow" />
              <button className="btn" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={!dialog.value.assetId} onClick={() => applyImage(dialog)}>
                {dialog.fig ? 'Update' : 'Add picture'}
              </button>
            </>
          }
        >
          <PicturePicker state={state} devUrl={devUrl} value={dialog.value} onChange={(value) => setDialog({ ...dialog, value })} />
          <Field label="Caption" hint="Shown under the picture.">
            <input className="input" value={dialog.caption} maxLength={MAX_CAPTION} aria-label="Caption" onChange={(e) => setDialog({ ...dialog, caption: e.target.value })} />
          </Field>
        </Modal>
      )}
      {dialog?.kind === 'link' && <LinkDialog dialog={dialog} state={state} self={post.entryId} onChange={setDialog} onApply={applyLink} />}
    </>
  );
}

/** The text saved elsewhere, read only, to compare with the author's before choosing one (a conflict's note). */
function SavedTextDialog({ noun, body, state, devUrl, onClose, onKeepMine, onUseSaved }: { noun: string; body: RichText | undefined; state: ProjectState; devUrl: string | null; onClose: () => void; onKeepMine: () => void; onUseSaved: () => void }) {
  const uid = useId();
  const shown = useRef<HTMLDivElement>(null);
  const problem = articleProblem(body);
  useEffect(() => {
    if (shown.current && !problem && Array.isArray(body)) renderArticle(shown.current, body, state, devUrl);
  }, [body]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal
      title="The saved text"
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button className="btn" onClick={onUseSaved} disabled={!!problem}>
            Use the saved text
          </button>
          <button className="btn btn-primary" onClick={onKeepMine}>
            Keep my text
          </button>
        </>
      }
    >
      <p className="post-review-note" id={`${uid}-note`}>
        This is the {noun}’s text as it was saved somewhere else. Using it replaces what you typed here.
      </p>
      {/* Focus opens on the text, to read, never on the button that replaces the author's: choosing is a deliberate Tab away. */}
      {problem ? (
        <p className="field-error" tabIndex={-1} data-autofocus>
          {problem}
        </p>
      ) : (
        <div ref={shown} className="post-body post-review" aria-label="The saved text" aria-describedby={`${uid}-note`} role="document" tabIndex={-1} data-autofocus />
      )}
    </Modal>
  );
}

/**
 * A picture from the library for the text, with what it shows for people who cannot see it. Nothing reaches the project
 * until the dialog's Add or Update: new pictures are added in Assets.
 */
function PicturePicker({ state, devUrl, value, onChange }: { state: ProjectState; devUrl: string | null; value: ImageValue; onChange: (v: ImageValue) => void }) {
  const uid = useId();
  const [q, setQ] = useState('');
  const images = useMemo(() => sortAssets(Object.values(state.assets.assets).filter((a) => a.kind === 'image'), 'name'), [state.assets]);
  const needle = q.trim().toLowerCase();
  const shown = needle ? images.filter((a) => `${a.name} ${a.description ?? ''} ${a.altSuggestion ?? ''}`.toLowerCase().includes(needle)) : images;
  if (!images.length) return <p className="posts-note">The library has no pictures yet. Add them in Assets, then choose one here.</p>;
  const pick = (id: string) => {
    if (id === value.assetId) return;
    const a = state.assets.assets[id];
    // A description written for another picture is not this one's: the new picture's suggestion, else none.
    onChange({ assetId: id, alt: a.altSuggestion ?? '', ...(value.decorative ? { decorative: true } : {}) });
  };
  return (
    <div className="post-picker">
      {images.length > 8 && <input type="search" className="input sm" placeholder="Search pictures" aria-label="Search pictures" value={q} onChange={(e) => setQ(e.target.value)} />}
      <div
        className="post-picker-grid"
        role="listbox"
        aria-label="Library pictures"
        // One stop for Tab; the arrow keys move and choose, Up and Down by a row of the grid.
        onKeyDown={(e) => {
          const tiles = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
          const from = tiles.indexOf(document.activeElement as HTMLButtonElement);
          if (from < 0) return;
          const across = getComputedStyle(e.currentTarget).gridTemplateColumns.split(' ').length || 1;
          const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: across, ArrowUp: -across }[e.key];
          const to = e.key === 'Home' ? 0 : e.key === 'End' ? tiles.length - 1 : step === undefined ? -1 : Math.min(tiles.length - 1, Math.max(0, from + step));
          if (to < 0) return;
          e.preventDefault();
          tiles[to].focus();
          pick(shown[to].id);
        }}
      >
        {shown.map((a, i) => (
          <button key={a.id} type="button" role="option" aria-selected={a.id === value.assetId} tabIndex={a.id === value.assetId || (i === 0 && !shown.some((x) => x.id === value.assetId)) ? 0 : -1} className="post-picker-tile" title={a.name} onClick={() => pick(a.id)}>
            {devUrl ? <AssetImage asset={a} devUrl={devUrl} cover /> : <span className="post-picker-name">{a.name}</span>}
          </button>
        ))}
      </div>
      <Field label="Description" controlId={`${uid}-alt`} hint="What the picture shows, for people who cannot see it.">
        <textarea id={`${uid}-alt`} className="input" rows={2} maxLength={TEXT_LIMITS.imageAlt} disabled={!!value.decorative} placeholder="What the picture shows" value={value.alt} onChange={(e) => onChange({ ...value, alt: e.target.value })} />
      </Field>
      <label className="post-picker-decorative">
        <input type="checkbox" checked={!!value.decorative} onChange={(e) => onChange({ ...value, ...(e.target.checked ? { decorative: true } : { decorative: undefined }) })} /> Decorative: it adds nothing the text does not say
      </label>
    </div>
  );
}

/** Every post of every collection, newest first within each: what a link can go to. */
function allPosts(state: ProjectState) {
  return Object.keys(state.collections ?? {})
    .sort()
    .flatMap((id) => orderedEntries(state.collections[id]).map((e) => ({ id: e.id, title: e.title, collection: state.collections[id].settings.name })));
}

/** The part of a text node's words a range covers: a range that only reaches an element's edge covers none of it. */
function coveredText(range: Range, t: Node): string {
  if (!range.intersectsNode(t)) return '';
  const text = t.nodeValue ?? '';
  return text.slice(t === range.startContainer ? range.startOffset : 0, t === range.endContainer ? range.endOffset : text.length);
}

/** Whether a range covers every word inside an element (spacing at a word's ends, which a page may collapse, aside). */
function coversAll(range: Range, el: Element): boolean {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) if (t.nodeValue?.trim() && coveredText(range, t).trim() !== t.nodeValue.trim()) return false;
  return true;
}

/**
 * Whether the words chosen for a link are all in links that open a new tab (the one at the caret, with none chosen):
 * words beside such a link, or in one that does not, keep a new link to the tab it opens in.
 */
function opensNewTab(root: HTMLElement, range: Range): boolean {
  if (range.collapsed) {
    const at = range.startContainer;
    const a = (at instanceof Element ? at : at.parentElement)?.closest('a[href]');
    return !!a && root.contains(a) && a.getAttribute('target') === '_blank';
  }
  let linked = false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!coveredText(range, t).trim()) continue;
    const a = t.parentElement?.closest('a[href]');
    if (!a || !root.contains(a) || a.getAttribute('target') !== '_blank') return false;
    linked = true;
  }
  return linked;
}

function LinkDialog({ dialog, state, self, onChange, onApply }: { dialog: Extract<Dialog, { kind: 'link' }>; state: ProjectState; self: string; onChange: (d: Dialog) => void; onApply: (d: Extract<Dialog, { kind: 'link' }>) => void }) {
  const uid = useId();
  const posts = allPosts(state).filter((p) => p.id !== self);
  const indexes = linkableIndexes(state);
  const set = (p: Partial<typeof dialog>) => onChange({ ...dialog, ...p, error: undefined });
  const needsWords = !dialog.range || dialog.range.collapsed;
  return (
    <Modal
      title="Link"
      onClose={() => onChange(null)}
      footer={
        <>
          <span className="grow" />
          <button className="btn" onClick={() => onChange(null)}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => onApply(dialog)}>
            Apply link
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onApply(dialog);
        }}
      >
        {needsWords && (
          <Field label="Text" controlId={`${uid}-text`}>
            <input id={`${uid}-text`} className="input" value={dialog.text} onChange={(e) => set({ text: e.target.value })} />
          </Field>
        )}
        <div className="post-link-kinds" role="radiogroup" aria-label="Link to">
          {(['page', 'post', ...(indexes.length || dialog.to === 'index' ? (['index'] as const) : []), 'url'] as const).map((k) => (
            <label key={k} className="post-link-kind">
              <input type="radio" name={`${uid}-to`} checked={dialog.to === k} onChange={() => set({ to: k })} /> {k === 'page' ? 'A page' : k === 'post' ? 'An entry' : k === 'index' ? 'A collection index' : 'A web address'}
            </label>
          ))}
        </div>
        {dialog.to === 'page' && (
          <Field label="Page" controlId={`${uid}-page`}>
            <select id={`${uid}-page`} className="select" value={dialog.page} onChange={(e) => set({ page: e.target.value })}>
              {state.site.pageOrder
                .filter((id) => Object.hasOwn(state.pages, id))
                .map((id) => (
                  <option key={id} value={id}>
                    {state.pages[id].title} ({state.pages[id].route})
                  </option>
                ))}
            </select>
          </Field>
        )}
        {dialog.to === 'post' &&
          (posts.length ? (
            <Field label="Entry" controlId={`${uid}-post`}>
              <select id={`${uid}-post`} className="select" value={dialog.entry} onChange={(e) => set({ entry: e.target.value })}>
                {posts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <p className="posts-note">There is no other entry to link to yet.</p>
          ))}
        {dialog.to === 'index' &&
          (indexes.length ? (
            <Field label="Collection" controlId={`${uid}-index`}>
              <select id={`${uid}-index`} className="select" value={indexes.some((x) => x.id === dialog.index) ? dialog.index : ''} onChange={(e) => set({ index: e.target.value })}>
                {!indexes.some((x) => x.id === dialog.index) && (
                  <option value="" disabled>
                    Choose a collection…
                  </option>
                )}
                {indexes.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} ({x.route})
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <p className="posts-note">No collection has an index on the website to link to.</p>
          ))}
        {dialog.to === 'url' && (
          <Field label="Web address" controlId={`${uid}-url`}>
            <input id={`${uid}-url`} className="input" placeholder="https://example.com" value={dialog.url} onChange={(e) => set({ url: e.target.value })} />
          </Field>
        )}
        {/* An email or phone link goes to no site to say anything about. */}
        {dialog.to === 'url' && !/^(mailto|tel):/i.test(dialog.url.trim()) && <LinkRelControls value={dialog.rel} onChange={(rel) => set({ rel })} />}
        {dialog.error && (
          <p className="field-error" role="alert">
            {dialog.error}
          </p>
        )}
      </form>
    </Modal>
  );
}

/**
 * A post's Search & sharing settings, under Open in SEO view, where its previews are (#708), and Optimize with AI.
 * The title and description meters follow what is typed before it is saved. Its own component, so typing re-renders
 * only this, not the writer.
 */
function PostSearchSettings({ state, post, collection, entry, update, off }: { state: ProjectState; post: PostRef; collection: Collection; entry: EntryDoc; update: (fields: Record<string, unknown>, label: string) => unknown; off?: boolean }) {
  const seoScope = seoSummary(entry.seo && typeof entry.seo === 'object' ? entry.seo : {});
  const seoSubject = useMemo<SeoSubject>(() => ({ kind: 'entry', collectionId: post.collectionId, entryId: post.entryId }), [post.collectionId, post.entryId]);
  const { typed: seoTyped, on: seoOn } = useTypedSeo(subjectKey(seoSubject));
  const { overlay: seoOverlay, doc: seoDoc } = useDocumentPreview(state, seoSubject, seoTyped);
  return (
    <div className="post-details post-seo">
      <Section id="post-seo" title="Search & sharing" scope={seoScope || undefined} defaultOpen={false} keepMounted>
        <fieldset className="post-fieldset" disabled={off}>
          <div className="post-fields">
            <SeoInlineActions subject={seoSubject} overlay={seoOverlay} typed={seoTyped} />
            <PostSearchFields state={state} collection={collection} entry={entry} doc={seoDoc} on={seoOn} save={(edit) => update(edit.fields, edit.label)} />
          </div>
        </fieldset>
      </Section>
    </div>
  );
}
