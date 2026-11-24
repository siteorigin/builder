import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Bold, Eye, Heading2, Heading3, Heading4, ImagePlus, Italic, Link, List, ListChecks, ListOrdered, Newspaper, Pilcrow, Quote, Send, Unlink, Undo2 } from 'lucide-react';
import type { ImageValue, LinkValue, ProjectState, RichText } from '@shared/types';
import { entryRoute, findEntry, orderedEntries } from '@shared/collections';
import { formatArticleDate, isArticleDate } from '@shared/articles';
import { linkFromTarget, sameRichText } from '@shared/richtext';
import { assetLabels, sortAssets } from '@shared/asset-order';
import { api, applyOps, commitIfUnchanged, commitOps, getState, markDraft, projectHistory, setState, toast, useStore, type CheckedOutcome, type PostRef } from '../store';
import { DraftInput, Field, Modal } from '../components/ui';
import { ImageEditor } from './PropEditors';
import { isImeComposing } from '../lib/ime';
import { registerFlush, trackApply } from '../lib/pending';
import { PostDraft, setOpenWriter, type DraftProblem, type DraftSaveOutcome } from '../lib/post-draft';
import { blockAtCaret, caretIn, figureElement, fillFigure, insertFigure, placeCaret, readArticle, renderArticle, type ArticleCaret } from '../lib/post-dom';
import { MAX_POST_TITLE, postAt } from '../lib/posts';
import { setMode } from '../lib/actions';
import { visitAddress } from './Canvas';

const MAX_EXCERPT = 320;
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
      return 'This post is no longer in the project. Your text is still here: save it as a new post, or copy it.';
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
  return (
    <div className="post-writer" hidden={hidden}>
      {post && exists ? (
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
  const collection = state.collections[post.collectionId];
  const entry = collection.entries[post.entryId];
  const devUrl = runtime.state === 'ready' ? runtime.url : null;
  const uid = useId();
  const root = useRef<HTMLDivElement>(null);
  /** The text the writer and the project last agreed on: what it showed from the project, or what it saved. */
  const agreed = useRef<RichText>(entry.body);
  /** The project as the writer last had the post's text from it: a save is checked against it. */
  const base = useRef(snap);
  /** A save that landed at this revision: the next one is checked against the project from then on. */
  const landedAt = useRef(0);
  /** Each formatting command starts a new undo step: typing after it is not joined to the typing before. */
  const group = useRef(0);
  /** Where the caret was when Undo or Redo was asked for, to put it back once the text is shown again. */
  const caretAfterHistory = useRef<ArticleCaret | null>(null);
  const [status, setStatus] = useState<{ dirty: boolean; saving: boolean; problem: DraftProblem | null }>({ dirty: false, saving: false, problem: null });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [pressed, setPressed] = useState<{ bold: boolean; italic: boolean; block: string }>({ bold: false, italic: false, block: 'p' });
  const draftKey = `post-text:${post.entryId}`;

  const draft = useMemo(
    () =>
      new PostDraft({
        read: () => (root.current ? readArticle(root.current, getState().snapshot?.state ?? state) : agreed.current),
        save: async (body) => {
          let from: typeof base.current | null = base.current;
          // After a save of its own, the writer's starting point is the project from that save on.
          if (landedAt.current) {
            const now = getState().snapshot;
            from = now && now.revision >= landedAt.current ? now : await api.project.snapshot().catch(() => now ?? from);
          }
          if (!from || from.workspaceKey !== getState().snapshot?.workspaceKey) return { kind: 'closed' };
          const key = `post-text:${post.entryId}:${group.current}`;
          let revision = 0;
          const outcome = commitIfUnchanged(from, () => commitOps([{ type: 'entry.update', collectionId: post.collectionId, entryId: post.entryId, body }], 'Edit post text', key).then((r) => (revision = r?.revision ?? 0)));
          // Followed as a save in flight: Save and leaving the project wait for it.
          trackApply(outcome.then((o) => (o.kind === 'applied' || o.kind === 'unchanged' ? { ok: true } : { ok: false, message: o.kind === 'failed' ? o.message : undefined })));
          const o = await outcome;
          if (o.kind === 'applied') {
            agreed.current = body;
            if (revision) landedAt.current = revision;
          }
          return draftOutcome(o);
        },
        onChange: (s) => setStatus(s)
      }),
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Show the post's text once, then only when it changes in the project while nothing here is unsaved (an Undo).
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    renderArticle(el, entry.body, state, devUrl);
    agreed.current = entry.body;
    base.current = snap;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (sameRichText(entry.body, agreed.current)) {
      if (!landedAt.current && !draft.dirty) base.current = snap;
      return;
    }
    if (draft.dirty || draft.isComposing) return;
    const focused = el.contains(document.activeElement) || document.activeElement === el;
    const caret = caretAfterHistory.current ?? (focused ? caretIn(el) : null);
    caretAfterHistory.current = null;
    renderArticle(el, entry.body, state, devUrl);
    agreed.current = entry.body;
    base.current = snap;
    landedAt.current = 0;
    if (focused) placeCaret(el, caret);
  }, [entry.body]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pictures follow the library and the preview server (a file replaced, the preview started).
  useEffect(() => {
    root.current?.querySelectorAll<HTMLElement>('figure.post-figure').forEach((f) => fillFigure(f, state, devUrl));
  }, [devUrl, state.assets]); // eslint-disable-line react-hooks/exhaustive-deps

  // Unsaved text is a draft the whole editor knows of: Save and leaving the project wait for it, and say so if it is left.
  useEffect(() => markDraft(draftKey, status.dirty, status.problem ? problemText(status.problem) : undefined), [draftKey, status.dirty, status.problem]);
  useEffect(() => {
    const offFlush = registerFlush(() => draft.flush());
    const offOpen = setOpenWriter(() => draft.flush());
    const el = root.current;
    return () => {
      offFlush();
      offOpen();
      // Gone without being saved first (the project closed): what it held is read now, while it still can be.
      if (el && draft.dirty) void draft.flush().finally(() => draft.close());
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

  const update = (fields: Record<string, unknown>, label: string) => applyOps([{ type: 'entry.update', collectionId: post.collectionId, entryId: post.entryId, ...fields } as never], label);

  /** Undo or Redo the project, with what was typed saved first as its own step. */
  const history = async (action: 'undo' | 'redo') => {
    if (draft.isComposing) return;
    const el = root.current;
    caretAfterHistory.current = el ? caretIn(el) : null;
    const saved = await draft.flush();
    if (!saved && draft.dirty) return;
    group.current++;
    projectHistory(action);
  };

  /** Run a formatting command where the caret is: one undo step of its own. */
  const command = (run: () => void) => {
    const el = root.current;
    if (!el || draft.isComposing) return;
    // What was typed before it is saved as it was, and the command starts a step of its own.
    void draft.flush();
    group.current++;
    if (!el.contains(document.getSelection()?.anchorNode ?? null)) el.focus();
    run();
    draft.input();
  };
  const block = (tag: string) =>
    command(() => {
      const current = blockAtCaret(root.current!);
      const listed = current && (current.tagName === 'UL' || current.tagName === 'OL');
      // Out of a list first, then into the block chosen.
      if (listed) document.execCommand(current.tagName === 'OL' ? 'insertOrderedList' : 'insertUnorderedList');
      document.execCommand('formatBlock', false, tag);
    });
  const list = (kind: 'ul' | 'ol' | 'check') =>
    command(() => {
      const current = blockAtCaret(root.current!);
      const isCheck = current?.tagName === 'UL' && current.classList.contains('so-rich--check');
      if (kind === 'check' && current?.tagName === 'UL') {
        current.classList.toggle('so-rich--check', !isCheck);
        return;
      }
      if (kind === 'ul' && isCheck) {
        current!.classList.remove('so-rich--check');
        return;
      }
      document.execCommand(kind === 'ol' ? 'insertOrderedList' : 'insertUnorderedList');
      if (kind === 'check') blockAtCaret(root.current!)?.closest('ul')?.classList.add('so-rich--check');
    });

  const openLink = () => {
    const sel = document.getSelection();
    const range = sel?.rangeCount && root.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    const a = (sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement)?.closest('a');
    const href = a && root.current?.contains(a) ? (a.getAttribute('href') ?? '') : '';
    const pageLink = href ? linkFromTarget(href, state.pages) : null;
    const entryLink = href.startsWith('entry:') ? href.slice(6) : '';
    const firstPage = state.site.pageOrder[0] ?? Object.keys(state.pages)[0] ?? '';
    const posts = allPosts(state).filter((p) => p.id !== post.entryId);
    setDialog({
      kind: 'link',
      range,
      text: range?.toString() ?? '',
      to: entryLink ? 'post' : pageLink?.type === 'page' ? 'page' : href ? 'url' : 'page',
      page: pageLink?.type === 'page' ? pageLink.target : firstPage,
      entry: entryLink || posts[0]?.id || '',
      url: pageLink || entryLink ? '' : href
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
    setDialog(null);
    command(() => {
      const sel = document.getSelection();
      if (d.range && sel) {
        sel.removeAllRanges();
        sel.addRange(d.range);
      }
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
    setDialog(null);
    command(() => {
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
  const removeImage = (d: Extract<Dialog, { kind: 'image' }>) => {
    setDialog(null);
    if (d.fig && root.current?.contains(d.fig)) command(() => d.fig!.remove());
  };

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

  const publish = async (draftOn: boolean) => {
    const saved = await draft.flush();
    if (!saved) return toast(draftOn ? 'The post’s text is not saved yet, so it stays as it is.' : 'The post’s text is not saved yet, so it was not published. See the note above the text.', 'error');
    const r = await update({ draft: draftOn }, draftOn ? 'Move post to drafts' : 'Publish post');
    if (r) toast(draftOn ? 'Moved to drafts: it is no longer on the website.' : 'Published: it is on the website from the next export.', 'success');
  };
  const saveDraft = async () => {
    const saved = await draft.flush();
    if (saved) toast(entry.draft === false ? 'Saved.' : 'Saved as a draft.', 'success');
  };
  const preview = async () => {
    await draft.flush();
    if (getState().runtime.state !== 'ready') return toast('The preview is still starting. Try again in a moment.', 'info');
    setMode('preview');
    setState({ postView: 'preview' });
    // Once the canvas shows again.
    requestAnimationFrame(() => {
      const c = getState().snapshot?.state.collections[post.collectionId];
      const e = c?.entries[post.entryId];
      if (!c || !e || !visitAddress(entryRoute(c, e))) {
        setState({ postView: 'write' });
        toast('The preview is still starting. Try again in a moment.', 'info');
      }
    });
  };

  const keepMine = () => {
    base.current = getState().snapshot ?? base.current;
    landedAt.current = 0;
    void draft.retry();
  };
  const showSaved = () => {
    const el = root.current;
    const now = getState().snapshot;
    const e = now && postAt(now.state, post);
    if (!el || !e || !now) return;
    renderArticle(el, e.body, now.state, devUrl);
    agreed.current = e.body;
    base.current = now;
    landedAt.current = 0;
    draft.reset();
  };
  const saveAsNew = async () => {
    const el = root.current;
    const now = getState().snapshot;
    if (!el || !now) return;
    const body = readArticle(el, now.state);
    const c = now.state.collections[post.collectionId];
    if (!c) return;
    const r = await commitOps([{ type: 'entry.create', collectionId: post.collectionId, title: `${entry.title} (recovered)`.slice(0, MAX_POST_TITLE), body }], 'Recover post');
    const id = r?.results?.[0]?.entryId;
    if (typeof id !== 'string') return;
    draft.reset();
    setState({ post: { collectionId: post.collectionId, entryId: id }, postView: 'write' });
  };

  const route = entryRoute(collection, entry);
  const published = entry.draft === false;
  const images = useMemo(() => sortAssets(Object.values(state.assets.assets).filter((a) => a.kind === 'image'), 'name'), [state.assets]);
  const labels = useMemo(() => assetLabels(images), [images]);
  const blockLabel = { p: 'Paragraph', h2: 'Heading 2', h3: 'Heading 3', h4: 'Heading 4', blockquote: 'Quote' } as Record<string, string>;
  const tools: Array<{ id: string; label: string; icon: React.ReactNode; on?: boolean; run: () => void; gap?: boolean }> = [
    { id: 'p', label: 'Paragraph', icon: <Pilcrow />, on: pressed.block === 'p', run: () => block('p') },
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
          <DraftInput className="input post-title-input" ariaLabel="Post title" value={entry.title} limit={MAX_POST_TITLE} placeholder="Title" onCommit={(v) => (v.trim() ? (v.trim() !== entry.title ? void update({ title: v.trim() }, 'Rename post') : undefined) : false)} />
          <details className="post-details">
            <summary>
              {formatArticleDate(entry.publishedAt, state.site.language)}
              {entry.author ? ` · ${entry.author}` : ''} · {route}
            </summary>
            <div className="post-fields">
              <Field label="Publication date" hint="A date in the past backdates the post.">
                <DraftInput type="date" value={entry.publishedAt} onCommit={(v) => (isArticleDate(v) ? (v !== entry.publishedAt ? void update({ publishedAt: v }, 'Change post date') : undefined) : false)} />
              </Field>
              <Field label="Address" hint={`The last part of ${route}`}>
                <DraftInput value={entry.slug} onCommit={(v) => (v.trim() ? (v.trim() !== entry.slug ? void update({ slug: v.trim() }, 'Change post address') : undefined) : false)} />
              </Field>
              <Field label="Author">
                <DraftInput value={entry.author ?? ''} limit={MAX_AUTHOR} placeholder="Who wrote it" onCommit={(v) => (v.trim() !== (entry.author ?? '') ? void update({ author: v.trim() || null }, 'Change post author') : undefined)} />
              </Field>
              <Field label="Excerpt" hint="A sentence or two for lists of posts and for search engines.">
                <DraftInput multiline rows={3} value={entry.excerpt ?? ''} limit={MAX_EXCERPT} onCommit={(v) => (v.trim() !== (entry.excerpt ?? '') ? void update({ excerpt: v.trim() || null }, 'Change post excerpt') : undefined)} />
              </Field>
              <Field label="Featured image" controlId={`${uid}-featured`}>
                <select id={`${uid}-featured`} className="select" value={entry.featuredImage ?? ''} onChange={(e) => void update({ featuredImage: e.target.value || null }, 'Change featured image')}>
                  <option value="">None</option>
                  {images.map((a) => (
                    <option key={a.id} value={a.id}>
                      {labels.get(a.id)?.label ?? a.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </details>
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
                  <button className="btn btn-sm btn-primary" onClick={() => void saveAsNew()}>
                    Save as a new post
                  </button>
                  <button className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(root.current?.innerText ?? '').catch(() => undefined)}>
                    Copy text
                  </button>
                </div>
              )}
            </div>
          )}
          <div
            ref={root}
            className="post-body"
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label="Post text"
            spellCheck
            onInput={() => draft.input()}
            onCompositionStart={() => draft.compositionStart()}
            onCompositionEnd={() => draft.compositionEnd()}
            onBlur={() => void draft.flush()}
            onKeyDown={onKeyDown}
            onBeforeInput={(e) => {
              const type = (e.nativeEvent as InputEvent).inputType;
              // Edit → Undo and Redo reach the text as the browser's own: they are the project's here too.
              if (type === 'historyUndo' || type === 'historyRedo') {
                e.preventDefault();
                void history(type === 'historyRedo' ? 'redo' : 'undo');
              }
            }}
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
          <ImageEditor value={dialog.value} state={state} onChange={(v) => setDialog({ ...dialog, value: v })} />
          <Field label="Caption" hint="Shown under the picture.">
            <input className="input" value={dialog.caption} maxLength={MAX_CAPTION} aria-label="Caption" onChange={(e) => setDialog({ ...dialog, caption: e.target.value })} />
          </Field>
        </Modal>
      )}
      {dialog?.kind === 'link' && <LinkDialog dialog={dialog} state={state} self={post.entryId} onChange={setDialog} onApply={applyLink} />}
    </>
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
