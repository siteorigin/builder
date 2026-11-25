import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Bold, Eye, Heading2, Heading3, Heading4, ImagePlus, Italic, Link, List, ListChecks, ListOrdered, Newspaper, Pilcrow, Quote, Send, Unlink, Undo2 } from 'lucide-react';
import type { AssetRecord, EntryDoc, EntrySeo, ImageValue, LinkValue, ProjectState, RichText } from '@shared/types';
import type { ProjectSnapshot } from '@shared/api';
import type { SeoSubject } from '@shared/seo';
import { entryRoute, findEntry, orderedEntries } from '@shared/collections';
import { formatArticleDate, isArticleDate } from '@shared/articles';
import { linkFromTarget, linkToTarget, sameRichText } from '@shared/richtext';
import { newId } from '@shared/ids';
import { normalizeRichText } from '@engine/values';
import { EngineError } from '@engine/tree';
import { assetLabels, sortAssets } from '@shared/asset-order';
import { applyOps, commitIfUnchanged, commitOps, getState, markDraft, projectHistory, setState, toast, useStore, type CheckedOutcome, type PostRef } from '../store';
import { DraftInput, Field, Modal, SwitchRow } from '../components/ui';
import { CanonicalUrlField, RevisionDateField } from '../components/SeoFields';
import { seoSummary } from '../lib/sharing';
import { publicUrl } from '@shared/public-url';
import { routeUrl } from '@shared/routes';
import { AssetImage } from '../components/AssetImage';
import { SiteImageField } from './PropEditors';
import { TEXT_LIMITS } from '@shared/text-limits';
import { isImeComposing } from '../lib/ime';
import { appliesLanded, registerFlush, trackApply } from '../lib/pending';
import { PostDraft, setOpenWriter, setWriterHistory, type DraftProblem, type DraftSaveOutcome } from '../lib/post-draft';
import { articleProblem, blockAtCaret, caretIn, figureElement, fillFigure, insertFigure, placeCaret, readArticle, renderArticle, setBlock, toggleList, type ArticleBlockTag, type ArticleCaret, type ArticleListKind } from '../lib/post-dom';
import { MAX_POST_TITLE, postAt } from '../lib/posts';
import { setMode } from '../lib/actions';
import { visitAddress } from './Canvas';
import { LengthMeter, SeoPreview, subjectKey, useDocumentPreview, useTypedSeo } from './SeoPreview';

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

/** What the problem bar says about text that is not saved. */
function problemText(p: DraftProblem): string {
  switch (p.kind) {
    case 'busy':
      return 'The AI is changing the site. Your text is saved as soon as it finishes.';
    case 'changed':
      return 'This post’s text was changed somewhere else while you were writing. Keep yours, or show the saved text instead.';
    case 'gone':
      return 'This post is no longer in the project. Your text is still here: copy it to keep it, or let it go.';
    default:
      return `Your text could not be saved${p.message ? `: ${p.message}` : '.'} Change it and it is tried again.`;
  }
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
          <p>Choose a post in the list, or start a new one.</p>
        </div>
      )}
    </div>
  );
}

type Dialog = null | { kind: 'image'; fig: HTMLElement | null; value: ImageValue; caption: string; at: HTMLElement | null } | { kind: 'link'; range: Range | null; text: string; to: 'page' | 'post' | 'url'; page: string; entry: string; url: string; error?: string };

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
  /** The editable element, kept after React lets go of it: a writer going away still saves what it held. */
  const rootEl = useRef<HTMLDivElement | null>(null);
  /** The project this writer was opened in. */
  const opening = useRef(snap.workspaceKey);
  /** This writer, among every one opened for the post: its undo steps never join another's. */
  const instance = useRef(newId('w'));
  /** The changes to the post's fields (title, date, address…) on their way, and when one was last refused. */
  const fieldCommits = useRef(new Set<Promise<unknown>>());
  const fieldRefusedAt = useRef(-Infinity);
  /** The latest saveAll, for the toolbar's Preview (see setOpenWriter). */
  const saveAllRef = useRef<() => Promise<boolean>>(() => Promise.resolve(true));
  /** Why the stored text cannot be edited here, if it cannot. */
  const unreadable = articleProblem(entry.body);
  /** The text the writer and the project last agreed on: what it showed from the project, or what it saved. */
  const agreed = useRef<RichText>(Array.isArray(entry.body) ? entry.body : []);
  /** Where the caret was when Undo or Redo was asked for, to put it back once the text is shown again. */
  const caretAfterHistory = useRef<ArticleCaret | null>(null);
  const [status, setStatus] = useState<{ dirty: boolean; saving: boolean; problem: DraftProblem | null }>({ dirty: false, saving: false, problem: null });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [pressed, setPressed] = useState<{ bold: boolean; italic: boolean; block: string }>({ bold: false, italic: false, block: 'p' });
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
          const outcome = commitIfUnchanged(from, () => (committed = commitOps([{ type: 'entry.update', collectionId: post.collectionId, entryId: post.entryId, body }], 'Edit post text', `post-text:${post.entryId}:${instance.current}:${step}`)));
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

  // Show the post's text once, then only when it changes in the project while nothing here is unsaved (an Undo).
  useEffect(() => {
    const el = root.current;
    rootEl.current = el;
    if (!el || unreadable) return;
    // Enter starts a paragraph, as the site's text has them.
    document.execCommand('defaultParagraphSeparator', false, 'p');
    renderArticle(el, entry.body, state, devUrl);
    agreed.current = entry.body;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
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
  useEffect(() => markDraft(draftKey, status.dirty, status.problem ? problemText(status.problem) : undefined), [draftKey, status.dirty, status.problem]);
  useEffect(() => {
    const offFlush = registerFlush(() => draft.flush());
    const offOpen = setOpenWriter(
      () => draft.flush(),
      () => saveAllRef.current()
    );
    const offHistory = setWriterHistory((action) => void history(action));
    // Edit → Undo and Redo reach the text as the browser's own history: they are the project's here too.
    const el = root.current;
    const onBeforeInput = (e: InputEvent) => {
      if (e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo') return;
      e.preventDefault();
      void history(e.inputType === 'historyRedo' ? 'redo' : 'undo');
    };
    el?.addEventListener('beforeinput', onBeforeInput);
    return () => {
      offFlush();
      offOpen();
      offHistory();
      el?.removeEventListener('beforeinput', onBeforeInput);
      // Gone without being saved first (the project closed): what it held is read now, from the element kept for it.
      if (draft.dirty) void draft.flush().finally(() => draft.close());
      else draft.close();
      markDraft(draftKey, false);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Hidden (another panel, the preview): saved now.
  useEffect(() => {
    if (hidden) void draft.flush();
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
      setPressed({ bold: document.queryCommandState('bold'), italic: document.queryCommandState('italic'), block: tag === 'ul' && block?.classList.contains('so-rich--check') ? 'check' : tag });
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  /** Change fields of the post, followed so Publish and Save draft know whether it was saved. */
  const update = (fields: Record<string, unknown>, label: string) => {
    const p = applyOps([{ type: 'entry.update', collectionId: post.collectionId, entryId: post.entryId, ...fields } as never], label).then((r) => {
      if (!r) fieldRefusedAt.current = performance.now();
      return r;
    });
    fieldCommits.current.add(p);
    void p.finally(() => fieldCommits.current.delete(p));
    return p;
  };
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
    if (!el || draft.isComposing || unreadable) return;
    if (!el.contains(document.getSelection()?.anchorNode ?? null)) el.focus();
    draft.checkpoint(false);
    run();
    draft.checkpoint(true);
  };
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
    const sel = document.getSelection();
    const range = sel?.rangeCount && root.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    const a = (sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement)?.closest('a');
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
    const firstPage = state.site.pageOrder[0] ?? Object.keys(state.pages)[0] ?? '';
    const posts = allPosts(state).filter((p) => p.id !== post.entryId);
    setDialog({
      kind: 'link',
      range,
      text: range?.toString() ?? '',
      to: entryLink ? 'post' : pageLink?.type === 'page' ? 'page' : href ? 'url' : 'page',
      page: pageLink?.type === 'page' ? pageLink.target : firstPage,
      entry: entryLink || posts[0]?.id || '',
      url: pageLink || entryLink ? '' : kept ? linkToTarget(kept, state.pages) : href
    });
  };
  const applyLink = (d: Extract<Dialog, { kind: 'link' }>) => {
    let href = '';
    if (d.to === 'page') href = Object.hasOwn(state.pages, d.page) ? state.pages[d.page].route : '';
    else if (d.to === 'post') href = findEntry(state, d.entry) ? `entry:${d.entry}` : '';
    else {
      const t = d.url.trim();
      const link: LinkValue | null = linkFromTarget(/^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]\S*)?$/i.test(t) ? `https://${t}` : t, state.pages);
      if (!link || link.type === 'page' || link.type === 'anchor') return setDialog({ ...d, error: 'Use a full web address, such as https://example.com, or mailto: or tel:.' });
      href = /^https?:/i.test(t) || t.startsWith('mailto:') || t.startsWith('tel:') ? t : `https://${t}`;
    }
    if (!href) return setDialog({ ...d, error: 'Choose where the link goes.' });
    const words = d.range && !d.range.collapsed ? '' : d.text.trim();
    if (d.range?.collapsed !== false && !words) return setDialog({ ...d, error: 'Type the words the link is on.' });
    afterDialog(d.range, () => {
      if (words) {
        const a = document.createElement('a');
        a.setAttribute('href', href);
        a.textContent = words;
        document.execCommand('insertHTML', false, a.outerHTML);
      } else document.execCommand('createLink', false, href);
    });
  };

  const openImage = (fig: HTMLElement | null) => {
    const el = root.current;
    if (!el) return;
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
    // The button pressed takes focus from the field being typed in, which commits it just before this runs: a refusal
    // from that moment on (an address another page has, an empty title) stops what the button does.
    const since = performance.now() - REFUSAL_WINDOW_MS;
    const at = document.activeElement;
    if (at instanceof HTMLElement && at.closest('.post-page') && !at.closest('.post-body')) at.blur();
    const saved = await draft.flush();
    await Promise.allSettled([...fieldCommits.current]);
    await appliesLanded();
    // Or text kept for being too long.
    return saved && fieldRefusedAt.current < since && !document.querySelector('.post-page [aria-invalid="true"]');
  };
  saveAllRef.current = saveAll;
  const publish = async (draftOn: boolean) => {
    if (!(await saveAll())) return toast(draftOn ? 'Part of the post is not saved yet, so it stays as it is. See the note beside it.' : 'Part of the post is not saved yet, so it was not published. See the note beside it.', 'error');
    const r = await update({ draft: draftOn }, draftOn ? 'Move post to drafts' : 'Publish post');
    if (r) toast(draftOn ? 'Moved to drafts: it is no longer on the website.' : 'Published: it is on the website from the next export.', 'success');
  };
  const saveDraft = async () => {
    if (await saveAll()) toast(entry.draft === false ? 'Saved.' : 'Saved as a draft.', 'success');
    else toast('Part of the post is not saved yet. See the note beside it.', 'error');
  };
  const preview = async () => {
    const key = getState().snapshot?.workspaceKey;
    // The preview shows what is saved: text that could not be saved stays in view with its note.
    if (!(await saveAll())) return toast('Part of the post is not saved yet, so the preview would not show it. See the note beside it.', 'error');
    // Another post (or project) opened while this one saved: the preview was this post's, so it does not start (#578).
    const now = getState();
    if (now.snapshot?.workspaceKey !== key || now.post?.collectionId !== post.collectionId || now.post?.entryId !== post.entryId) return;
    setState({ postView: 'preview' });
    setMode('preview');
    // Once the canvas shows again; a preview still starting opens the post once it is ready.
    requestAnimationFrame(() => {
      // The preview ended before it began (a page chosen): the canvas stays on the page the editor names (#578).
      if (getState().postView !== 'preview' || getState().post?.entryId !== post.entryId) return;
      const c = getState().snapshot?.state.collections[post.collectionId];
      const e = c && Object.hasOwn(c.entries, post.entryId) ? c.entries[post.entryId] : undefined;
      if (c && e && !visitAddress(entryRoute(c, e))) toast('The preview is starting: the post opens in it once it is ready.', 'info');
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
  /** The post is gone and the author lets its unsaved text go too. */
  const discard = () => draft.reset();

  const route = entryRoute(collection, entry);
  const published = entry.draft === false;
  const images = useMemo(() => sortAssets(Object.values(state.assets.assets).filter((a) => a.kind === 'image'), 'name'), [state.assets]);
  const labels = useMemo(() => assetLabels(images), [images]);
  const blockLabel = { p: 'Paragraph', h2: 'Heading 2', h3: 'Heading 3', h4: 'Heading 4', blockquote: 'Quote' } as Record<string, string>;
  const tools: Array<{ id: string; label: string; icon: React.ReactNode; on?: boolean; run: () => void; gap?: boolean }> = [
    { id: 'p', label: 'Paragraph', icon: <Pilcrow />, on: pressed.block === 'p' || pressed.block === 'div', run: () => block('p') },
    { id: 'h2', label: 'Heading 2', icon: <Heading2 />, on: pressed.block === 'h2', run: () => block('h2') },
    { id: 'h3', label: 'Heading 3', icon: <Heading3 />, on: pressed.block === 'h3', run: () => block('h3') },
    { id: 'h4', label: 'Heading 4', icon: <Heading4 />, on: pressed.block === 'h4', run: () => block('h4') },
    { id: 'blockquote', label: 'Quote', icon: <Quote />, on: pressed.block === 'blockquote', run: () => block('blockquote') },
    { id: 'bold', label: 'Bold', icon: <Bold />, on: pressed.bold, run: () => command(() => document.execCommand('bold')), gap: true },
    { id: 'italic', label: 'Italic', icon: <Italic />, on: pressed.italic, run: () => command(() => document.execCommand('italic')) },
    { id: 'ul', label: 'Bulleted list', icon: <List />, on: pressed.block === 'ul', run: () => list('ul'), gap: true },
    { id: 'ol', label: 'Numbered list', icon: <ListOrdered />, on: pressed.block === 'ol', run: () => list('ol') },
    { id: 'check', label: 'Check list', icon: <ListChecks />, on: pressed.block === 'check', run: () => list('check') },
    { id: 'link', label: 'Link', icon: <Link />, run: openLink, gap: true },
    { id: 'unlink', label: 'Remove link', icon: <Unlink />, run: () => command(() => document.execCommand('unlink')) },
    { id: 'image', label: 'Picture', icon: <ImagePlus />, run: () => openImage(null), gap: true },
    { id: 'undo', label: 'Undo', icon: <Undo2 />, run: () => void history('undo'), gap: true }
  ];

  return (
    <>
      <div className="post-bar" role="toolbar" aria-label="Post">
        <span className={`badge ${published ? 'green' : 'amber'}`}>{published ? 'Published' : 'Draft'}</span>
        <span className="post-save-state" role="status">
          {status.problem ? 'Not saved' : status.saving ? 'Saving…' : status.dirty ? 'Editing…' : 'Saved'}
        </span>
        <span className="grow" />
        <button className="btn btn-sm" onClick={() => void preview()} title="See the post on the canvas as visitors will, in the site’s header and footer">
          <Eye aria-hidden="true" /> Preview in site
        </button>
        {published ? (
          <button className="btn btn-sm" onClick={() => void publish(true)} title="Take the post off the website and keep it as a draft">
            Move to drafts
          </button>
        ) : (
          <>
            <button className="btn btn-sm" onClick={() => void saveDraft()}>
              Save draft
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => void publish(false)}>
              <Send aria-hidden="true" /> Publish
            </button>
          </>
        )}
      </div>
      <div className="post-scroll">
        <article className="post-page">
          {/* A title is one line that wraps: all of it stays readable, and Enter saves it instead of adding a line. */}
          <DraftInput wrap className="input post-title-input" ariaLabel="Post title" value={entry.title} limit={MAX_POST_TITLE} placeholder="Title" onCommit={(v) => (v.trim() ? (v.trim() !== entry.title ? update({ title: v.trim() }, 'Rename post') : undefined) : refuse())} />
          <details className="post-details">
            <summary>
              {formatArticleDate(entry.publishedAt, state.site.language)}
              {entry.author ? ` · ${entry.author}` : ''} · {route}
            </summary>
            <div className="post-fields">
              <Field label="Publication date" hint="A date in the past backdates the post.">
                <DraftInput type="date" value={entry.publishedAt} onCommit={(v) => (isArticleDate(v) ? (v !== entry.publishedAt ? update({ publishedAt: v }, 'Change post date') : undefined) : refuse())} />
              </Field>
              <div data-entry-field="updatedAt" style={{ display: 'contents' }}>
                <RevisionDateField
                  label="Last updated"
                  hint="When the post was last revised, for search engines. Leave empty when it hasn’t been."
                  value={entry.updatedAt}
                  onSet={(v) => update({ updatedAt: v }, 'Change post revision date')}
                  onClear={() => update({ updatedAt: null }, 'Clear post revision date')}
                  refuse={refuse}
                />
              </div>
              <Field label="Address" hint={`The last part of ${route}`}>
                <DraftInput value={entry.slug} onCommit={(v) => (v.trim() ? (v.trim() !== entry.slug ? update({ slug: v.trim() }, 'Change post address') : undefined) : refuse())} />
              </Field>
              {/* data-entry-field: where Go to form lands, for a layout's form that reads this field (see open-destination). */}
              <div data-entry-field="author" style={{ display: 'contents' }}>
                <Field label="Author">
                  <DraftInput value={entry.author ?? ''} limit={MAX_AUTHOR} placeholder="Who wrote it" onCommit={(v) => (v.trim() !== (entry.author ?? '') ? update({ author: v.trim() || null }, 'Change post author') : undefined)} />
                </Field>
              </div>
              <div data-entry-field="excerpt" style={{ display: 'contents' }}>
                <Field label="Excerpt" hint="A sentence or two for lists of posts and for search engines.">
                  <DraftInput multiline rows={3} value={entry.excerpt ?? ''} limit={MAX_EXCERPT} onCommit={(v) => (v.trim() !== (entry.excerpt ?? '') ? update({ excerpt: v.trim() || null }, 'Change post excerpt') : undefined)} />
                </Field>
              </div>
              {/* The image editor's picker: a thumbnail of the one chosen, the library to browse, import or drop, and Remove. */}
              <SiteImageField title="Featured image" plain="featured" state={state} value={entry.featuredImage} onChange={(id) => void update({ featuredImage: id }, 'Change featured image')} />
            </div>
          </details>
          <PostSearchSettings state={state} post={post} entry={entry} route={route} published={published} hidden={hidden} images={images} labels={labels} update={update} />
          <div className="post-tools" role="toolbar" aria-label="Formatting">
            {tools.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`icon-btn sm${t.gap ? ' gap' : ''}`}
                aria-label={t.label}
                title={t.label}
                aria-pressed={t.on === undefined ? undefined : t.on}
                // Keeps the caret and the selection in the text.
                onMouseDown={(e) => e.preventDefault()}
                onClick={t.run}
              >
                {t.icon}
              </button>
            ))}
            <span className="post-block-name" aria-hidden="true">
              {blockLabel[pressed.block] ?? ''}
            </span>
          </div>
          {status.problem && (
            <div className={`post-problem ${status.problem.kind}`} role="alert">
              <p>{problemText(status.problem)}</p>
              {status.problem.kind === 'changed' && (
                <div className="post-problem-actions">
                  <button className="btn btn-sm btn-primary" onClick={keepMine}>
                    Keep my text
                  </button>
                  <button className="btn btn-sm" onClick={showSaved}>
                    Show the saved text
                  </button>
                </div>
              )}
              {status.problem.kind === 'gone' && (
                <div className="post-problem-actions">
                  <button className="btn btn-sm btn-primary" onClick={() => void navigator.clipboard?.writeText(root.current?.innerText ?? '').catch(() => undefined)}>
                    Copy text
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={discard}>
                    Discard it
                  </button>
                </div>
              )}
            </div>
          )}
          {unreadable && (
            <div className="post-problem" role="alert">
              <p>{unreadable}</p>
            </div>
          )}
          <div
            ref={root}
            className="post-body"
            contentEditable={!unreadable}
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label="Post text"
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
        </article>
      </div>
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
      <div className="post-picker-grid" role="listbox" aria-label="Library pictures">
        {shown.map((a) => (
          <button key={a.id} type="button" role="option" aria-selected={a.id === value.assetId} className="post-picker-tile" title={a.name} onClick={() => pick(a.id)}>
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

function LinkDialog({ dialog, state, self, onChange, onApply }: { dialog: Extract<Dialog, { kind: 'link' }>; state: ProjectState; self: string; onChange: (d: Dialog) => void; onApply: (d: Extract<Dialog, { kind: 'link' }>) => void }) {
  const uid = useId();
  const posts = allPosts(state).filter((p) => p.id !== self);
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
          {(['page', 'post', 'url'] as const).map((k) => (
            <label key={k} className="post-link-kind">
              <input type="radio" name={`${uid}-to`} checked={dialog.to === k} onChange={() => set({ to: k })} /> {k === 'page' ? 'A page' : k === 'post' ? 'A post' : 'A web address'}
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
            <Field label="Post" controlId={`${uid}-post`}>
              <select id={`${uid}-post`} className="select" value={dialog.entry} onChange={(e) => set({ entry: e.target.value })}>
                {posts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <p className="posts-note">There is no other post to link to yet.</p>
          ))}
        {dialog.to === 'url' && (
          <Field label="Web address" controlId={`${uid}-url`}>
            <input id={`${uid}-url`} className="input" placeholder="https://example.com" value={dialog.url} onChange={(e) => set({ url: e.target.value })} />
          </Field>
        )}
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
 * A post's Search & sharing settings, with previews of its search result, link card and structured data that follow
 * its title, description and canonical URL as they are typed. Its own component, so typing re-renders only this, not
 * the writer.
 */
function PostSearchSettings({
  state,
  post,
  entry,
  route,
  published,
  hidden,
  images,
  labels,
  update
}: {
  state: ProjectState;
  post: PostRef;
  entry: EntryDoc;
  route: string;
  published: boolean;
  hidden: boolean;
  images: AssetRecord[];
  labels: ReturnType<typeof assetLabels>;
  update: (fields: Record<string, unknown>, label: string) => unknown;
}) {
  const uid = useId();
  // The post's search and sharing settings, and what it falls back to without each.
  const seo: EntrySeo = entry.seo && typeof entry.seo === 'object' ? entry.seo : {};
  const defaultTitle = `${entry.title} · ${state.site.name}`;
  const base = publicUrl(state.site);
  const ownUrl = base ? base + routeUrl(route) : null;
  const featured = entry.featuredImage && state.assets.assets[entry.featuredImage]?.kind === 'image';
  const inheritedImage = featured ? 'The featured image' : state.site.socialImage ? 'The site’s sharing image' : 'None';
  const seoScope = seoSummary(seo);
  const seoSubject = useMemo<SeoSubject>(() => ({ kind: 'entry', collectionId: post.collectionId, entryId: post.entryId }), [post.collectionId, post.entryId]);
  const { typed: seoTyped, on: seoOn } = useTypedSeo(subjectKey(seoSubject));
  const { overlay: seoOverlay, doc: seoDoc } = useDocumentPreview(state, seoSubject, seoTyped);
  // Its structured data reads the whole website: it is worked out only while the settings are open on screen.
  const [seoOpen, setSeoOpen] = useState(false);
  return (
    <details className="post-details post-seo" onToggle={(e) => setSeoOpen(e.currentTarget.open)}>
      <summary>Search & sharing{seoScope ? ` · ${seoScope}` : ''}</summary>
      <div className="post-fields">
        <SeoPreview state={state} subject={seoSubject} overlay={seoOverlay} doc={seoDoc} shown={seoOpen && !hidden} />
        <div data-entry-field="seoTitle" style={{ display: 'contents' }}>
          <Field
            label="Browser title"
            hint={
              <>
                Leave empty to use “{defaultTitle}”.
                <LengthMeter kind="title" doc={seoDoc} />
              </>
            }
          >
            <DraftInput value={seo.title ?? ''} limit={TEXT_LIMITS.seoTitle} placeholder={defaultTitle} onDirty={seoOn.title} onCommit={(v) => (v.trim() !== (seo.title ?? '') ? update({ seoTitle: v.trim() }, 'Change post browser title') : undefined)} />
          </Field>
        </div>
        <div data-entry-field="seoDescription" style={{ display: 'contents' }}>
          <Field
            label="Description"
            hint={
              <>
                Shown by search engines and link previews. Leave empty to use the excerpt.
                <LengthMeter kind="description" doc={seoDoc} />
              </>
            }
          >
            <DraftInput multiline rows={3} value={seo.description ?? ''} limit={TEXT_LIMITS.pageDescription} placeholder={entry.excerpt || state.site.description || 'Describe this post'} onDirty={seoOn.description} onCommit={(v) => (v.trim() !== (seo.description ?? '') ? update({ description: v.trim() }, 'Change post description') : undefined)} />
          </Field>
        </div>
        <Field label="Sharing image" controlId={`${uid}-sharing`} hint="The picture link previews show.">
          <select id={`${uid}-sharing`} className="select" value={seo.socialImage ?? ''} onChange={(e) => void update({ socialImage: e.target.value || null }, e.target.value ? 'Change post sharing image' : 'Use the default sharing image')}>
            <option value="">{inheritedImage}</option>
            {seo.socialImage && !images.some((a) => a.id === seo.socialImage) && <option value={seo.socialImage}>Missing image</option>}
            {images.map((a) => (
              <option key={a.id} value={a.id}>
                {labels.get(a.id)?.label ?? a.name}
              </option>
            ))}
          </select>
        </Field>
        <CanonicalUrlField value={seo.canonical} ownUrl={ownUrl} what="post" onTyped={seoOn.canonical} onCommit={(url) => update({ canonical: url }, url ? 'Change post canonical URL' : 'Clear post canonical URL')} />
        <SwitchRow
          checked={!!seo.noindex}
          onChange={(v) => void update({ noindex: v }, v ? 'Hide post from search engines' : 'Show post to search engines')}
          label="Hide from search engines"
          hint={published ? 'Search engines are asked not to list it, and the sitemap leaves it out. Anyone with the address can still open it.' : 'Once published, search engines are asked not to list it, and the sitemap leaves it out.'}
        />
        <SwitchRow checked={!!seo.searchHidden} onChange={(v) => void update({ searchHidden: v }, v ? 'Hide post from site search' : 'Show post in site search')} label="Hide from site search" hint="Keeps this post out of the site’s own search results once Site search lists posts." />
      </div>
    </details>
  );
}
