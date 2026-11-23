import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, Check, ChevronDown, CircleAlert, CircleCheck, CircleDashed, CircleHelp, CircleStop, FileText, Globe, History, Info, KeyRound, MousePointerClick, Play, Plus, RotateCcw, Settings2, Sparkles, Square, Trash2, TriangleAlert } from 'lucide-react';
import type { ChatActivity, ChatChange, ChatContext, ChatImageRef, ChatMessage } from '@shared/api';
import { refKey } from '@shared/types';
import { api, getState, setState, toast, useStore, confirmDialog, selectChatDraft, selectChatImages, setChatDraft } from '../store';
import { afterSendMessage, draftFor, imagesFor, moveDraft, moveImages, unsentDrafts, withDraft, withImages } from '../lib/chatDrafts';
import { refLabel, resolveRef } from '../lib/model';
import { chatSuggestions } from '../lib/chatSuggestions';
import { selectPage } from '../lib/actions';
import { canOpen, changeTarget, changeText, checksOf, continueContext, resumableId } from '../lib/result';
import { composerAction, isPaused, isStarting, offeredImages, questionHint, shownQuestions, waitingQuestion, type WaitingQuestion } from '../lib/chatQuestions';
import { isImeComposing } from '../lib/ime';
import { Segmented, Spinner, useMenu } from '../components/ui';
import { ImageChips, ImageChoices } from '../components/ChatImages';

/** Minimal, safe inline formatting for model text: **bold**, `code` and [links](…) shown as text. */
function Md({ text }: { text: string }) {
  const parts = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <span className="md">
      {parts.map((p, i) => (p.startsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p.startsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : p))}
    </span>
  );
}

/** What the run strip says for each phase of a run. */
const PHASE: Record<string, string> = {
  preparing: 'Working',
  running: 'Working',
  'awaiting-input': 'Needs your answer',
  validating: 'Checking the result',
  repairing: 'Fixing a problem',
  stopping: 'Stopping'
};

/** How a finished turn is headed: one icon and one word per outcome, never color alone. */
function outcome(r: NonNullable<ChatMessage['result']>) {
  if (r.status === 'completed' && r.incomplete) return { icon: <CircleDashed />, label: 'Partly done' };
  if (r.status === 'no-changes' && r.incomplete) return { icon: <CircleDashed />, label: 'Not finished' };
  switch (r.status) {
    case 'completed':
      return { icon: <CircleCheck />, label: 'Completed' };
    case 'no-changes':
      return { icon: <Info />, label: 'No changes made' };
    case 'cancelled':
      return { icon: <CircleStop />, label: 'Stopped' };
    case 'failed':
      return { icon: <CircleAlert />, label: 'Failed' };
    case 'conflicted':
      return { icon: <TriangleAlert />, label: 'Needs your review' };
    default:
      return { icon: <CircleAlert />, label: String(r.status) };
  }
}

/** A summary that only repeats its outcome ("Stopped.") says what happened to the site instead. */
function summaryOf(r: NonNullable<ChatMessage['result']>) {
  if (r.status === 'cancelled' && /^stopped\.?$/i.test(r.summary.trim())) return r.changes.length ? 'You stopped this request. Its changes were undone.' : 'You stopped this request before it changed anything.';
  return r.summary;
}

const targetOf = (ctx?: ChatContext | null) => (ctx ? (ctx.selectionLabel ? `${ctx.pageTitle} → ${ctx.selectionLabel}` : ctx.pageTitle) : '');

function sizeToFit(ta: HTMLTextAreaElement | null) {
  // A hidden panel measures nothing; it is sized again when it is shown.
  if (!ta || !ta.offsetParent) return;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(200, ta.scrollHeight)}px`;
}

export function Chat() {
  const conversation = useStore((s) => s.conversation);
  const runStatus = useStore((s) => s.runStatus);
  const activeRunId = useStore((s) => s.activeRunId);
  // Each conversation keeps its own unsent message.
  const draft = useStore(selectChatDraft);
  // ...and the library images attached to it, by asset ID.
  const images = useStore(selectChatImages);
  const selection = useStore((s) => s.selection);
  const pageId = useStore((s) => s.pageId);
  const snap = useStore((s) => s.snapshot);
  const viewport = useStore((s) => s.viewport);
  const ctxOn = useStore((s) => s.chatContextEnabled);
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const logRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const menu = useMenu();
  const [sending, setSending] = useState(false);
  const [announce, setAnnounce] = useState('');
  const announcedRun = useRef<string | null>(null);
  const trackedRun = useRef<string | null>(null);
  const shownConversation = useRef<string | null>(null);
  const history = useStore((s) => s.snapshot?.history);
  const rightTab = useStore((s) => s.rightTab);
  // Choosing a different element scopes the next message to it again; otherwise the choice made with the
  // scope toggle stays, message after message.
  const selectionKey = selection ? refKey(selection) : null;
  const lastSelection = useRef(selectionKey);
  useEffect(() => {
    if (selectionKey === lastSelection.current) return;
    lastSelection.current = selectionKey;
    if (selectionKey && !getState().chatContextEnabled.selection) setState({ chatContextEnabled: { ...getState().chatContextEnabled, selection: true } });
  }, [selectionKey]);

  const provider = providers.find((p) => p.id === settings?.ai.provider);
  const configured = !!provider?.configured;
  const msgs = conversation?.messages ?? [];
  const running = !!runStatus;
  const waiting = runStatus === 'awaiting-input';
  // While the AI waits on a question, the composer answers it from its own box; the unsent message stays put.
  const asking = waitingQuestion(conversation, activeRunId, runStatus);
  const askingKey = asking ? `${asking.runId}:${asking.question.id}` : null;
  const [answerBox, setAnswerBox] = useState({ key: '', text: '' });
  const answerText = askingKey && answerBox.key === askingKey ? answerBox.text : '';
  const composerText = asking ? answerText : draft;
  const answering = useRef<string | null>(null);
  /** When the last typed answer went in: an Enter right after it never sends the message that comes back. */
  const answeredAt = useRef(0);
  const working = msgs.find((m) => m.runId === activeRunId && m.role === 'assistant');
  const workingUser = working ? msgs[msgs.indexOf(working) - 1] : null;
  // Undo turn is offered only while that turn is the newest step in the project's undo history: history
  // undoes in order, so any later edit (manual or AI) makes an older turn's Undo fail.
  const topRun = history?.canUndo ? [...history.entries].reverse().find((e) => e.applied)?.runId : undefined;
  const undoableId = topRun ? msgs.find((m) => m.role === 'assistant' && m.runId === topRun && m.result?.canUndo)?.id : undefined;
  const resumable = running ? undefined : resumableId(msgs);
  const firstAsk = msgs.find((m) => m.role === 'user')?.text;
  const title = msgs.length ? (conversation?.title && conversation.title !== 'New conversation' ? conversation.title : firstAsk ?? 'New conversation') : 'New conversation';

  useLayoutEffect(() => {
    const el = logRef.current;
    // Opening another conversation lands on its latest turn; within one, follow only if already near the end.
    if (conversation?.id !== shownConversation.current) {
      shownConversation.current = conversation?.id ?? null;
      nearBottom.current = true;
    }
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [conversation]);

  // A restored draft (after a restart, a retry, or returning to its conversation, or once a question is answered)
  // gets its full height back.
  useLayoutEffect(() => sizeToFit(taRef.current), [configured, rightTab, conversation?.id, askingKey]);

  // One polite status message per phase change, kept outside the (sometimes hidden) dock panel so it is
  // announced wherever focus is. Streamed text is never read out piece by piece. The outcome is announced
  // once per run, from that run's own result, whichever of the status and the message arrives first.
  useEffect(() => {
    if (runStatus && activeRunId) {
      trackedRun.current = activeRunId;
      const target = targetOf(workingUser?.context);
      if (runStatus === 'awaiting-input') {
        // Announced once per question, when it arrives; the composer is already where it is answered.
        if (asking && announcedRun.current !== askingKey) {
          announcedRun.current = askingKey;
          setAnnounce(`The AI needs your answer to continue: ${asking.question.text}`);
        }
      } else if (runStatus === 'preparing' && announcedRun.current !== `${activeRunId}:start`) {
        announcedRun.current = `${activeRunId}:start`;
        setAnnounce(`AI started working${target ? ` on ${target}` : ''}.`);
      } else if (runStatus === 'stopping') setAnnounce('Stopping the AI. Its changes are being undone.');
      else if (runStatus === 'running') setAnnounce('');
    }
    const run = trackedRun.current;
    const done = run && announcedRun.current !== `${run}:done` ? msgs.find((m) => m.role === 'assistant' && m.runId === run && m.result) : undefined;
    if (done?.result) {
      announcedRun.current = `${run}:done`;
      setAnnounce(`${outcome(done.result).label}. ${summaryOf(done.result)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runStatus, activeRunId, conversation]);

  if (!snap) return null;
  const st = snap.state;
  const page = pageId ? st.pages[pageId] : null;
  const selLabel = selection ? refLabel(st, selection) : null;
  const model = provider ? settings?.ai.models[provider.id] : undefined;
  const modelLabel = provider?.models.find((m) => m.id === model)?.label ?? model;
  const sel = selLabel?.toLowerCase();
  // Starters come from what this project holds: the page, the selection, the pages and the images that exist.
  const suggestions = msgs.length === 0 && configured && conversation && !draft.trim() ? chatSuggestions({ state: st, assetUsage: snap.assetUsage, pageId, selection, context: ctxOn }) : [];
  const openSettings = () => setState({ modal: { kind: 'settings', tab: 'ai' } });
  const focusComposer = () => requestAnimationFrame(() => taRef.current?.focus());

  /** Answer the waiting question, with a choice, an offered picture or the composer's text. Each question takes one answer. */
  const answer = async (q: WaitingQuestion, value: string | ChatImageRef, typed: boolean) => {
    const key = `${q.runId}:${q.question.id}`;
    if ((typeof value === 'string' && !value.trim()) || answering.current === key) return;
    answering.current = key;
    if (typed) answeredAt.current = Date.now();
    const ok = await api.ai.answer(q.runId, q.question.id, typeof value === 'string' ? value.trim() : { assetId: value.assetId }).catch(() => false);
    if (!ok) {
      if (answering.current === key) {
        answering.current = null;
        answeredAt.current = 0;
      }
      // Refused while the same question still waits (the app could not deliver it): say so, and keep the text.
      const s = getState();
      if (waitingQuestion(s.conversation, s.activeRunId, s.runStatus)?.question.id === q.question.id) toast('Your answer could not be sent. Try again.', 'error');
      return;
    }
    // The typed answer is sent: clear it, unless more was typed meanwhile (that question is answered either way).
    if (typed) setAnswerBox((b) => (b.key === key ? { key, text: '' } : b));
  };

  /** `context` replaces the editor's own (and its images), for a message that continues an earlier request. */
  const send = async (text = draft, context?: ChatContext) => {
    if (!text.trim() || running || sending || !conversation) return;
    if (!configured) return openSettings();
    // The message belongs to the conversation (and project) it was written in.
    const conversationId = conversation.id;
    const opening = snap.workspaceKey;
    // Freeze the exact context at send time.
    const ctx: ChatContext = context ?? {
      pageId: ctxOn.page && page ? page.id : st.site.homePageId,
      pageTitle: ctxOn.page && page ? page.title : st.pages[st.site.homePageId]?.title ?? '',
      selection: ctxOn.selection && selection ? structuredClone(selection) : null,
      selectionLabel: ctxOn.selection && selLabel ? selLabel : null,
      viewport,
      // The images go by asset ID only; the app checks they are still in Assets before anything is sent.
      ...(images.length ? { assetIds: [...images] } : {})
    };
    // Keep focus in the composer: the Send button is about to be disabled.
    taRef.current?.focus();
    setSending(true);
    nearBottom.current = true;
    const r = await api.ai.send(text.trim(), ctx, conversationId);
    setSending(false);
    if (!r.ok) return toast(r.message ?? 'Could not start the request.', 'error');
    // A continuation was never typed, so whatever is in the composer is the user's own next message.
    if (context) return;
    // Clear what was sent, but never text typed (or images attached) while the request was starting.
    const s = getState();
    if (s.snapshot?.workspaceKey !== opening) return;
    const after = afterSendMessage(s.chatDrafts, s.chatImages, conversationId, text, ctx.assetIds ?? []);
    if (after.drafts === s.chatDrafts && after.images === s.chatImages) return;
    setState({ chatDrafts: after.drafts, chatImages: after.images });
    if (after.drafts !== s.chatDrafts && taRef.current && s.conversation?.id === conversationId) taRef.current.style.height = '';
  };

  /** Carry on with an unfinished request, with that request's own page and selection, leaving the draft alone. */
  const continueRequest = (user: ChatMessage | undefined) => {
    const c = continueContext(user, st, viewport);
    if ('error' in c) {
      // The user picks the target in the editor and sends "Continue" from the composer, never over a draft.
      toast(c.error, 'info');
      const s = getState();
      if (conversation && !draftFor(s.chatDrafts, conversation.id).trim()) setState({ chatDrafts: withDraft(s.chatDrafts, conversation.id, 'Continue') });
      focusComposer();
      return;
    }
    void send('Continue', c.ctx);
  };

  // Switching conversations shows that conversation's own draft; a failed switch stays where it was. A reply that
  // arrives after the project changed is not this project's.
  const opening = snap.workspaceKey;
  const stillOpen = () => getState().snapshot?.workspaceKey === opening;
  const show = (pending: Promise<NonNullable<typeof conversation>>, unsent?: (c: NonNullable<typeof conversation>) => Pick<ReturnType<typeof getState>, 'chatDrafts' | 'chatImages'>) =>
    void pending.then(
      (c) => {
        if (!stillOpen()) return;
        setState({ conversation: c, ...(unsent ? unsent(c) : {}) });
        focusComposer();
      },
      (e: Error) => stillOpen() && toast(e.message || 'Could not open that conversation.', 'error')
    );

  const openHistory = async (el: HTMLElement) => {
    const listed = await api.ai.conversations().catch((e: Error) => {
      if (stillOpen()) toast(e.message || 'Could not list the earlier conversations.', 'error');
      return null;
    });
    if (!listed || !stillOpen()) return;
    const { list } = listed;
    // A new conversation left before anything was sent is not saved, so its draft is offered here instead.
    const unsent = unsentDrafts(getState().chatDrafts, list.map((c) => c.id), getState().conversation?.id, getState().chatImages);
    if (!list.length && !unsent.length) return toast('No earlier conversations yet.', 'info');
    const day = (iso: string) => {
      const d = new Date(iso);
      const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
      return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    };
    menu.openAt(
      el,
      [
        ...(unsent.length
          ? [
              { heading: 'Not sent yet' },
              ...unsent.map((d) => ({ label: d.text.trim().split('\n')[0].slice(0, 60) || `Message with ${d.images === 1 ? '1 image' : `${d.images} images`}`, hint: d.images ? `Draft · ${d.images === 1 ? '1 image' : `${d.images} images`}` : 'Draft', onSelect: () => show(api.ai.newConversation(), (c) => ({ chatDrafts: moveDraft(getState().chatDrafts, d.id, c.id), chatImages: moveImages(getState().chatImages, d.id, c.id) })) }))
            ]
          : []),
        ...(list.length ? [{ heading: 'Recent conversations' }, ...list.map((c) => ({ label: c.title, hint: day(c.createdAt), checked: c.id === conversation?.id, onSelect: () => show(api.ai.openConversation(c.id)) }))] : []),
        { separator: true },
        // Unsent drafts belong to the conversations being removed, so they go with them.
        { label: 'Clear history…', icon: <Trash2 />, danger: true, onSelect: () => void confirmDialog({ title: 'Clear AI conversation history?', body: 'All AI conversations in this project, including this one, will be removed. Changes the AI made to your site stay, and can still be undone.', confirmLabel: 'Clear history', danger: true }).then((ok) => ok === true && stillOpen() && show(api.ai.clearHistory(opening), () => ({ chatDrafts: {}, chatImages: {} }))) }
      ],
      'Conversations'
    );
  };


  return (
    <div className="chat">
      {(configured || msgs.length > 0) && (
        <div className="chat-head">
          <span className="chat-title" title={title}>
            {title}
          </span>
          {/* Switching waits for the project's own conversation to load, and for a message being sent. */}
          <button className="icon-btn sm" title="Earlier conversations" aria-label="Earlier conversations" aria-haspopup="menu" aria-expanded={menu.isOpen} onClick={(e) => void openHistory(e.currentTarget)} disabled={running || sending || !conversation}>
            <History />
          </button>
          <button className="icon-btn sm" title="New conversation" aria-label="New conversation" disabled={running || sending || !conversation || msgs.length === 0 || !configured} onClick={() => show(api.ai.newConversation())}>
            <Plus />
          </button>
        </div>
      )}
      <div
        className="chat-log"
        ref={logRef}
        role="log"
        aria-label="AI conversation"
        aria-busy={(running && !waiting) || undefined}
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {msgs.length === 0 && (
          <div className="chat-empty">
            <div className="spark">
              <Sparkles size={20} />
            </div>
            <div className="col" style={{ gap: 4 }}>
              <h3>Ask AI to edit your site</h3>
              <p>It uses the same editing tools you do and checks its work. You can undo its changes like your own.</p>
            </div>
            {!configured ? (
              <button className="btn btn-primary" onClick={openSettings}>
                <KeyRound /> Connect an AI provider
              </button>
            ) : (
              // Starters prefill an empty composer; once you have written something they step aside rather than replace it.
              conversation &&
              suggestions.length > 0 && (
                <div className="suggestions" role="group" aria-label="Suggestions">
                  {suggestions.map((s) => (
                    <button
                      key={s.text}
                      className="suggestion"
                      data-kind={s.kind}
                      onClick={() => {
                        setChatDraft(conversation.id, s.text);
                        requestAnimationFrame(() => {
                          sizeToFit(taRef.current);
                          taRef.current?.focus();
                        });
                      }}
                    >
                      {s.text}
                    </button>
                  ))}
                </div>
              )
            )}
            <p className="chat-privacy">
              {provider?.id === 'local' && configured
                ? (provider.warning ?? 'Page text and structure stay on this computer.')
                : `Page text and structure are sent to ${configured && provider ? provider.label : 'the provider you choose'}. Images are never sent.`}
            </p>
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === 'user' ? (
            <UserMessage key={m.id} m={m} />
          ) : (
            <AssistantMessage key={m.id} m={m} live={m.runId === activeRunId && running} awaiting={waiting} undoable={m.id === undoableId} asking={asking} onContinue={m.id === resumable && !sending ? () => continueRequest(msgs[i - 1]) : undefined} />
          )
        )}
      </div>
      {running && (
        <div className={`run-strip${waiting ? ' waiting' : ''}`}>
          <span className="run-icon" aria-hidden="true">
            {waiting ? <CircleHelp /> : <Sparkles />}
          </span>
          <span className="run-text">
            <span className="run-phase">{PHASE[runStatus!] ?? 'Working'}</span>
            {workingUser?.context && <span className="run-target">{targetOf(workingUser.context)}</span>}
          </span>
          <span className="run-actions">
            <button
              className="btn btn-sm run-stop"
              disabled={runStatus === 'stopping'}
              onClick={() => {
                void api.ai.stop();
                focusComposer();
              }}
            >
              <Square size={10} fill="currentColor" /> Stop
            </button>
          </span>
        </div>
      )}
      {configured && provider?.warning && (
        <div className="scope-note danger" role="status">
          <TriangleAlert />
          <span>{provider.warning}</span>
        </div>
      )}
      {/* Shown whenever a question waits, even if the provider was changed meanwhile: the run still needs it. */}
      {asking && (
        // The question waiting for an answer sits by the composer, which answers it; a choice answers it in one click.
        <div className="question-card" role="group" aria-labelledby="ai-question-text">
          <div className="question-text" id="ai-question-text">
            {asking.question.text}
          </div>
          {offeredImages(asking.question).length > 0 && (
            <ImageChoices
              key={askingKey}
              images={offeredImages(asking.question)}
              onChoose={(img) => {
                void answer(asking, img, false);
                focusComposer();
              }}
            />
          )}
          {asking.question.choices.length > 0 && (
            <div className="choices">
              {asking.question.choices.map((c, i) => (
                <button
                  key={`${i}:${c}`}
                  className="btn btn-sm choice"
                  onClick={() => {
                    void answer(asking, c, false);
                    focusComposer();
                  }}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
          <p className="question-hint" id="ai-question-hint">
            {questionHint(asking.question)}
            {draft.trim() || images.length ? ' Your unsent message is kept for afterwards.' : ''}
          </p>
        </div>
      )}
      {configured || asking ? (
        <div className="composer">
          {(page || selLabel) && (
            <div className="chips" role="group" aria-label="Your next message applies to">
              {page && (
                <span className="chip" title="The AI starts from the page you are viewing. Without a selection, it can also change other pages.">
                  <FileText /> <span className="ellipsis">{page.title}</span>
                </span>
              )}
              {selLabel && (
                // What the next message may change: the selected element only, or anything on the site.
                <Segmented<'selection' | 'site'>
                  label="What the AI may change"
                  value={ctxOn.selection ? 'selection' : 'site'}
                  onChange={(v) => setState({ chatContextEnabled: { ...ctxOn, selection: v === 'selection' } })}
                  options={[
                    {
                      value: 'selection',
                      // A part of a component is scoped to the whole component placement (see agent/scope.ts).
                      title: selection?.instancePath.length ? `Only the component containing ${selLabel}` : `Only ${selLabel}`,
                      label: (
                        <>
                          <MousePointerClick /> <span className="ellipsis">{selLabel}</span>
                        </>
                      )
                    },
                    {
                      value: 'site',
                      title: 'Whole site',
                      label: (
                        <>
                          <Globe /> Whole site
                        </>
                      )
                    }
                  ]}
                />
              )}
            </div>
          )}
          {/* The message's images wait with it while a question is answered. */}
          {!asking && (
            <ImageChips
              images={images.map((id) => ({ assetId: id, name: (st.assets.assets[id]?.kind === 'image' && st.assets.assets[id].name.trim()) || id }))}
              label="Images in your next message"
              onRemove={(id) => {
                if (!conversation) return;
                setState({ chatImages: withImages(getState().chatImages, conversation.id, imagesFor(getState().chatImages, conversation.id).filter((x) => x !== id)) });
                focusComposer();
              }}
            />
          )}
          <textarea
            ref={taRef}
            value={composerText}
            placeholder={asking ? 'Type your answer…' : waiting ? 'Waiting for the question…' : running ? 'Draft your next message…' : selLabel && ctxOn.selection ? `Ask about the ${sel}…` : 'Describe a change…'}
            aria-label={asking ? 'Your answer' : 'Message'}
            aria-describedby={asking ? 'ai-question-text ai-question-hint' : undefined}
            rows={1}
            // Until the project's conversation has loaded, there is no thread to write in.
            readOnly={!conversation}
            onChange={(e) => {
              if (asking && askingKey) setAnswerBox({ key: askingKey, text: e.target.value });
              else {
                // Editing the message that came back makes its next Enter a deliberate send.
                answeredAt.current = 0;
                setChatDraft(conversation?.id, e.target.value);
              }
              sizeToFit(e.target);
            }}
            onKeyDown={(e) => {
              const sendOnEnter = getState().settings?.ai.sendOnEnter ?? true;
              if (e.key === 'Enter' && !isImeComposing(e) && (sendOnEnter ? !e.shiftKey : e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                // A held-down Enter submits once; and the message that comes back after an answer is never sent
                // by an Enter meant for the answer.
                if (e.repeat) return;
                // An empty box sends nothing; a waiting question takes the text as its answer.
                const action = composerAction({ text: composerText, waiting: !!asking, running, sinceAnswerMs: Date.now() - answeredAt.current });
                if (action === 'answer') void answer(asking!, composerText, true);
                else if (action === 'hold') toast('Your message is kept here. You can send it when the current request finishes.', 'info');
                else if (action === 'send') void send();
              }
            }}
          />
          <div className="composer-foot">
            {provider && (
              <button className="btn btn-sm btn-ghost composer-model" title="Change AI provider or model" aria-haspopup="dialog" onClick={openSettings}>
                <span className="label">
                  {provider.label}
                  {modelLabel ? ` · ${modelLabel}` : ''}
                </span>
                <Settings2 size={12} />
              </button>
            )}
            <span className="grow" />
            {asking ? (
              <button
                className="send-btn"
                disabled={!answerText.trim()}
                title="Send answer"
                aria-label="Send answer"
                onClick={(e) => {
                  // The second click of a double click would land on Send once the question is answered.
                  if (e.detail > 1) return;
                  void answer(asking, answerText, true);
                  focusComposer();
                }}
              >
                <ArrowUp />
              </button>
            ) : (
              <button className="send-btn" disabled={running || !draft.trim() || sending} title={running ? 'You can send once this request finishes' : 'Send'} aria-label={running ? 'Send (available when the current request finishes)' : 'Send'} onClick={(e) => e.detail <= 1 && void send()}>
                <ArrowUp />
              </button>
            )}
          </div>
        </div>
      ) : (
        msgs.length > 0 && (
          <div className="chat-connect">
            <span>Connect an AI provider to continue this conversation.</span>
            <button className="btn btn-sm btn-primary" onClick={openSettings}>
              <KeyRound /> Connect
            </button>
          </div>
        )
      )}
      {menu.node}
      {createPortal(
        <div className="sr-only" role="status" aria-live="polite">
          {announce}
        </div>,
        document.body
      )}
    </div>
  );
}

function UserMessage({ m }: { m: ChatMessage }) {
  const target = targetOf(m.context);
  const images = Array.isArray(m.images) ? m.images.filter((i) => typeof i?.assetId === 'string' && typeof i.name === 'string') : [];
  return (
    <div className="msg-user">
      {typeof m.text === 'string' ? m.text : ''}
      {images.length > 0 && <ImageChips images={images} label="Attached images" />}
      {target && <span className="ctx">{target}</span>}
    </div>
  );
}

function Steps({ items, waiting, stopped, recent }: { items: ChatActivity[]; waiting?: boolean; stopped?: boolean; recent?: number }) {
  const [all, setAll] = useState(false);
  const extra = recent ? Math.max(0, items.length - recent) : 0;
  const hidden = all ? 0 : extra;
  return (
    <ul className="activity-list" aria-label="Steps">
      {extra > 0 && (
        <li className="activity earlier">
          <button className="steps-earlier" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? 'Hide earlier steps' : `${extra} earlier ${extra === 1 ? 'step' : 'steps'}`}
          </button>
        </li>
      )}
      {items.slice(hidden).map((a) => {
        // A step cut short by Stop is not an error, and a pause for your answer is not work in progress.
        const wasStopped = stopped && a.status === 'error' && !a.detail;
        const icon = a.status === 'running' ? waiting ? <CircleHelp className="ask" /> : <Spinner decorative /> : a.status === 'done' ? <Check /> : wasStopped ? <CircleStop /> : <CircleAlert className="bad" />;
        return (
          <li key={a.id} className={`activity ${wasStopped ? 'stopped' : a.status}`}>
            <span className="activity-icon" aria-hidden="true">
              {icon}
            </span>
            <span className="activity-text">
              {a.label}
              {wasStopped && <span className="sr-only"> (stopped)</span>}
              {a.status === 'error' && !wasStopped && <span className="sr-only"> (failed)</span>}
              {a.detail && <span className="detail">{a.detail}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function AssistantMessage({ m, live, awaiting, undoable, asking, onContinue }: { m: ChatMessage; live: boolean; awaiting: boolean; undoable: boolean; asking: WaitingQuestion | null; onContinue?: () => void }) {
  const r = m.result;
  const activities = m.activities ?? [];
  // A live turn of a run that waits for the author is paused: nothing in it spins, whichever message holds the
  // question, because the status and the question message arrive separately.
  const waitingHere = isPaused(asking, m.id, live, awaiting);
  // Every question of the turn stays with it, in order, with its answer.
  const questions = shownQuestions(m, asking);
  return (
    <div className="msg-ai" aria-busy={(live && !waitingHere) || undefined}>
      {!r && activities.length > 0 && <Steps items={activities} waiting={waitingHere} recent={4} />}
      {!r && m.text && (
        <div className="text">
          <Md text={m.text} />
        </div>
      )}
      {isStarting(m, live, waitingHere) && (
        <div className="activity-list chat-starting">
          <span className="activity running">
            <span className="activity-icon">
              <Spinner decorative />
            </span>
            Getting started…
          </span>
        </div>
      )}
      {questions.map((q) => {
        // A picture chosen from the offer is shown with its name, told apart from any other offered with the same one.
        const offered = offeredImages(q);
        const picked = q.answeredAssetId ? offered.find((i) => i.assetId === q.answeredAssetId) : undefined;
        return (
          <div key={q.key} className={`answered${q.answered === undefined ? ' unanswered' : ''}`}>
            <span className="answered-q">{q.text}</span>
            {picked ? (
              <span className="answered-image">
                You chose: <ImageChips images={[picked]} label="The image you chose" />
              </span>
            ) : q.answered !== undefined ? (
              <span>
                You answered: <strong>{q.answered}</strong>
              </span>
            ) : (
              <span>Not answered</span>
            )}
          </div>
        );
      })}
      {r && <ResultCard m={m} undoable={undoable} onContinue={onContinue} />}
    </div>
  );
}

/** Show a change: its page, then the element if it is still there. */
function openChange(c: ChatChange) {
  const st = getState().snapshot?.state;
  if (!st) return;
  const target = changeTarget(st, getState().pageId, c);
  if (!target) return;
  if ('error' in target) return toast(target.error, 'info');
  selectPage(target.pageId);
  if (target.selection) setState({ selection: target.selection });
  if (target.note) toast(target.note, 'info');
}

function ResultCard({ m, undoable, onContinue }: { m: ChatMessage; undoable: boolean; onContinue?: () => void }) {
  const r = m.result!;
  const devMode = useStore((s) => !!s.settings?.developerMode);
  const [open, setOpen] = useState(false);
  const stepsId = useId();
  const head = outcome(r);
  const steps = m.activities ?? [];
  const stopped = r.status === 'cancelled';
  const problems = steps.filter((a) => a.status === 'error' && !(stopped && !a.detail)).length;
  const undone = r.status === 'failed' || r.status === 'cancelled';
  const authProblem = !!r.error && /API key/i.test(r.summary);
  const { issues, unverified, passes } = checksOf(r);
  const [showPasses, setShowPasses] = useState(false);
  const retry = async () => {
    const conv = getState().conversation;
    if (!conv) return;
    const typed = draftFor(getState().chatDrafts, conv.id).trim();
    const request = conv.messages[conv.messages.findIndex((x) => x.id === m.id) - 1];
    const original = request?.text;
    // The request's images come back with it, whether or not they are still in Assets: a missing one is shown so.
    const originalImages = Array.isArray(request?.context?.assetIds) ? request.context.assetIds.filter((id): id is string => typeof id === 'string') : [];
    const attached = imagesFor(getState().chatImages, conv.id);
    const otherImages = attached.length > 0 && attached.join('\n') !== originalImages.join('\n');
    // Never discard something the user is writing without asking.
    if ((typed && typed !== original?.trim()) || otherImages) {
      const ok = await confirmDialog({ title: 'Replace your draft?', body: 'The message you are writing will be replaced by the original request, so you can edit it and try again.', confirmLabel: 'Replace draft' });
      // The request goes back into the conversation it came from, and only while that one is still open.
      if (ok !== true || getState().conversation?.id !== conv.id) return;
    }
    const i = conv.messages.findIndex((x) => x.id === m.id);
    const user = conv.messages[i - 1];
    if (user) {
      // Retry with the original target: same page and same selection, not whatever is selected now.
      // Both are checked against the project as it is now; a target that has since been deleted is
      // dropped rather than restored, and the note below asks for a new one.
      const ctx = user.context;
      const st = getState().snapshot?.state;
      const pageOk = !!ctx?.pageId && !!st?.pages[ctx.pageId];
      const selOk = (() => {
        try {
          return pageOk && !!ctx?.selection && !!st && !!resolveRef(st, ctx.selection).node;
        } catch {
          return false;
        }
      })();
      setState({
        chatDrafts: withDraft(getState().chatDrafts, conv.id, user.text),
        chatImages: withImages(getState().chatImages, conv.id, originalImages),
        ...(pageOk ? { pageId: ctx!.pageId } : {}),
        selection: selOk ? ctx!.selection : null,
        chatContextEnabled: { page: true, selection: selOk }
      });
      if ((ctx?.selection && !selOk) || (ctx?.pageId && !pageOk)) toast(`${ctx?.selectionLabel ?? ctx?.pageTitle ?? 'What this was about'} is no longer in the site. Choose what to change, then send again.`, 'info');
    }
    requestAnimationFrame(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.composer textarea');
      sizeToFit(ta);
      ta?.focus();
    });
  };
  return (
    <div className={`result-card ${r.status}`}>
      <div className="result-head">
        <span className="result-icon" aria-hidden="true">
          {head.icon}
        </span>
        <span className="result-title">{head.label}</span>
        <span className="spacer" />
        {r.usage && devMode && <span className="result-usage">{(r.usage.inputTokens + r.usage.outputTokens).toLocaleString()} tokens</span>}
        {steps.length > 0 && (
          <button className="steps-toggle" aria-expanded={open} aria-controls={stepsId} onClick={() => setOpen(!open)}>
            {steps.length} {steps.length === 1 ? 'step' : 'steps'}
            {problems > 0 && <span className="steps-problems"> · {problems} {problems === 1 ? 'problem' : 'problems'}</span>}
            <ChevronDown />
          </button>
        )}
      </div>
      {open && (
        <div id={stepsId} className="result-steps">
          <Steps items={steps} stopped={stopped} />
        </div>
      )}
      <div className="result-body">
        <div className="result-summary">
          <Md text={summaryOf(r)} />
        </div>
        {r.changes.length > 0 &&
          (undone ? (
            <div className="result-section">
              <span className="result-label">Undone</span>
              <ul aria-label="Changes that were undone">
                {r.changes.map((c, i) => (
                  <li key={i} className="faint">
                    {changeText(c).label}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ul className="changes" aria-label="Changes">
              {r.changes.map((c, i) => {
                const { label, operations } = changeText(c);
                return (
                  <li key={i}>
                    {canOpen(c) ? (
                      <button className="change-link" onClick={() => openChange(c)}>
                        {label}
                      </button>
                    ) : (
                      <span>{label}</span>
                    )}
                    {/* Technical detail: the operations behind the change, for people working on the site's code. */}
                    {devMode && operations.length > 0 && (
                      <code className="change-ops">
                        <span className="sr-only">Operations: </span>
                        {operations.join(', ')}
                      </code>
                    )}
                  </li>
                );
              })}
            </ul>
          ))}
        {r.validation.length > 0 && (
          <ul className="checks" aria-label="Checks">
            {/* Anything that needs attention comes first; routine passes fold into one line. */}
            {issues.map((v, i) => (
              <li key={`i${i}`} className="issue">
                <TriangleAlert aria-hidden="true" />
                <span>
                  <span className="sr-only">Issue: </span>
                  {v}
                </span>
              </li>
            ))}
            {/* A check that could not run says nothing about the site, so it is not counted as a problem or a pass. */}
            {unverified.map((v, i) => (
              <li key={`u${i}`} className="unverified">
                <CircleHelp aria-hidden="true" />
                <span>
                  <span className="sr-only">Not checked: </span>
                  {v}
                </span>
              </li>
            ))}
            {passes.length > 1 && (
              <li>
                <button className="checks-toggle" aria-expanded={showPasses} onClick={() => setShowPasses(!showPasses)}>
                  <Check aria-hidden="true" />
                  {passes.length} checks passed
                  <ChevronDown aria-hidden="true" />
                </button>
              </li>
            )}
            {(passes.length === 1 || showPasses) &&
              passes.map((v, i) => (
                <li key={`p${i}`} className={passes.length > 1 ? 'pass-detail' : undefined}>
                  <Check aria-hidden="true" />
                  <span>{v}</span>
                </li>
              ))}
          </ul>
        )}
      </div>
      {((r.canUndo && undoable) || undone || authProblem || onContinue) && (
        <div className="result-foot">
          {onContinue && (
            <button className="btn btn-sm btn-primary" onClick={onContinue}>
              <Play /> Continue
            </button>
          )}
          {authProblem && (
            <button className="btn btn-sm btn-primary" onClick={() => setState({ modal: { kind: 'settings', tab: 'ai' } })}>
              <KeyRound /> Update API key
            </button>
          )}
          {r.canUndo && undoable && (
            <button
              className="btn btn-sm"
              onClick={async () => {
                const res = await api.ai.undoTurn(m.runId!);
                if (!res.ok) toast(res.message ?? 'This turn cannot be undone.', 'error');
              }}
            >
              <RotateCcw /> Undo turn
            </button>
          )}
          {undone && (
            <button className="btn btn-sm" onClick={() => void retry()}>
              Edit and try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}

