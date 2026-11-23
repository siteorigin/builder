import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, Check, ChevronDown, CircleAlert, CircleCheck, CircleDashed, CircleHelp, CircleStop, FileText, Globe, History, Info, KeyRound, MousePointerClick, Plus, RotateCcw, Settings2, Sparkles, Square, Trash2, TriangleAlert } from 'lucide-react';
import type { ChatActivity, ChatContext, ChatMessage } from '@shared/api';
import { refKey } from '@shared/types';
import { api, getState, setState, toast, useStore, confirmDialog } from '../store';
import { refLabel, resolveRef } from '../lib/model';
import { selectPage } from '../lib/actions';
import { Segmented, Spinner, useMenu } from '../components/ui';

/** Minimal, safe inline formatting for model text: **bold**, `code` and [links](…) shown as text. */
function Md({ text }: { text: string }) {
  const parts = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <span className="md">
      {parts.map((p, i) => (p.startsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p.startsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : p))}
    </span>
  );
}

const SUGGESTIONS = ['Rewrite the home page hero to sound warmer and more confident', 'Add a Services page with three service cards and link it from the header', 'Make the brand colour a deep navy blue', 'Add an FAQ section to the Contact page'];

/** What the run strip says for each phase of a run. */
const PHASE: Record<string, string> = {
  preparing: 'Working',
  running: 'Working',
  'awaiting-input': 'Needs your answer',
  validating: 'Checking the result',
  repairing: 'Fixing a problem',
  stopping: 'Stopping'
};

/** How a finished turn is headed: one icon and one word per outcome, never colour alone. */
function outcome(r: NonNullable<ChatMessage['result']>) {
  if (r.status === 'completed' && r.incomplete) return { icon: <CircleDashed />, label: 'Partly done' };
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

/** The scope-widening choices the agent offers; answering them by typing would not grant anything. */
const WIDEN_CHOICE = 'Yes, allow changes beyond the selection';

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
  const draft = useStore((s) => s.chatDraft);
  const selection = useStore((s) => s.selection);
  const pageId = useStore((s) => s.pageId);
  const snap = useStore((s) => s.snapshot);
  const viewport = useStore((s) => s.viewport);
  const ctxOn = useStore((s) => s.chatContextEnabled);
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const logRef = useRef<HTMLDivElement>(null);
  function showQuestion() {
    const q = logRef.current?.querySelector<HTMLElement>('.question-card .question-text');
    q?.scrollIntoView({ block: 'nearest' });
    q?.focus();
  }
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
  const working = msgs.find((m) => m.runId === activeRunId && m.role === 'assistant');
  const workingUser = working ? msgs[msgs.indexOf(working) - 1] : null;
  // Undo turn is offered only while that turn is the newest step in the project's undo history: history
  // undoes in order, so any later edit (manual or AI) makes an older turn's Undo fail.
  const topRun = history?.canUndo ? [...history.entries].reverse().find((e) => e.applied)?.runId : undefined;
  const undoableId = topRun ? msgs.find((m) => m.role === 'assistant' && m.runId === topRun && m.result?.canUndo)?.id : undefined;
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

  // A restored draft (after a restart or a retry) gets its full height back.
  useLayoutEffect(() => sizeToFit(taRef.current), [configured, rightTab]);

  useEffect(() => {
    const t = setTimeout(() => void api.project.saveLocalState({ chatDraft: draft }), 400);
    return () => clearTimeout(t);
  }, [draft]);

  // One polite status message per phase change, kept outside the (sometimes hidden) dock panel so it is
  // announced wherever focus is. Streamed text is never read out piece by piece. The outcome is announced
  // once per run, from that run's own result, whichever of the status and the message arrives first.
  useEffect(() => {
    if (runStatus && activeRunId) {
      trackedRun.current = activeRunId;
      const target = targetOf(workingUser?.context);
      if (runStatus === 'awaiting-input') {
        const key = `${activeRunId}:${working?.question?.text ?? ''}`;
        if (announcedRun.current !== key) {
          announcedRun.current = key;
          setAnnounce(`The AI needs your answer to continue: ${working?.question?.text ?? ''}`);
          // If you were waiting in an empty composer, go straight to the question; never take focus from elsewhere.
          if (document.activeElement === taRef.current && !getState().chatDraft.trim()) requestAnimationFrame(showQuestion);
        }
      } else if (runStatus === 'preparing' && announcedRun.current !== `${activeRunId}:start`) {
        announcedRun.current = `${activeRunId}:start`;
        setAnnounce(`AI started working${target ? ` on ${target}` : ''}.`);
      } else if (runStatus === 'running') setAnnounce('');
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
  const selKind = (() => {
    try {
      return selection ? resolveRef(st, selection).node?.kind : undefined;
    } catch {
      return undefined;
    }
  })();
  // Starters fit what is selected: words for text, the picture for an image, layout and content for the rest.
  const suggestions = !(selLabel && ctxOn.selection)
    ? SUGGESTIONS
    : selKind === 'text' || selKind === 'link'
      ? [`Rewrite the ${sel} to sound warmer and more confident`, `Make the ${sel} shorter and easier to scan`, `Suggest three other ways to write the ${sel}`]
      : selKind === 'image'
        ? [`Write better alt text for the ${sel}`, `Find a better image for the ${sel} from my images`]
        : [`Make the ${sel} more polished and easier to scan`, `Rewrite the text in the ${sel} to sound warmer`, `Suggest a better layout for the ${sel}`];
  const openSettings = () => setState({ modal: { kind: 'settings', tab: 'ai' } });
  const focusComposer = () => requestAnimationFrame(() => taRef.current?.focus());

  const send = async (text = draft) => {
    if (!text.trim() || running || sending) return;
    if (!configured) return openSettings();
    // Freeze the exact context at send time.
    const ctx: ChatContext = {
      pageId: ctxOn.page && page ? page.id : st.site.homePageId,
      pageTitle: ctxOn.page && page ? page.title : st.pages[st.site.homePageId]?.title ?? '',
      selection: ctxOn.selection && selection ? structuredClone(selection) : null,
      selectionLabel: ctxOn.selection && selLabel ? selLabel : null,
      viewport
    };
    // Keep focus in the composer: the Send button is about to be disabled.
    taRef.current?.focus();
    setSending(true);
    nearBottom.current = true;
    const r = await api.ai.send(text.trim(), ctx);
    setSending(false);
    if (!r.ok) toast(r.message ?? 'Could not start the request.', 'error');
    // Clear what was sent, but never text typed while the request was starting.
    else if (getState().chatDraft === text) {
      setState({ chatDraft: '' });
      if (taRef.current) taRef.current.style.height = '';
    }
  };

  const openHistory = async (el: HTMLElement) => {
    const { list } = await api.ai.conversations();
    if (!list.length) return toast('No earlier conversations yet.', 'info');
    const day = (iso: string) => {
      const d = new Date(iso);
      const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
      return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    };
    menu.openAt(
      el,
      [
        { heading: 'Recent conversations' },
        ...list.map((c) => ({ label: c.title, hint: day(c.createdAt), checked: c.id === conversation?.id, onSelect: () => void api.ai.openConversation(c.id).then((conv) => setState({ conversation: conv })) })),
        { separator: true },
        { label: 'Clear history…', icon: <Trash2 />, danger: true, onSelect: () => void confirmDialog({ title: 'Clear AI conversation history?', body: 'All AI conversations in this project, including this one, will be removed. Changes the AI made to your site stay, and can still be undone.', confirmLabel: 'Clear history', danger: true }).then((ok) => ok === true && void api.ai.clearHistory().then((conv) => setState({ conversation: conv }))) }
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
          <button className="icon-btn sm" title="Earlier conversations" aria-label="Earlier conversations" aria-haspopup="menu" aria-expanded={menu.isOpen} onClick={(e) => void openHistory(e.currentTarget)} disabled={running}>
            <History />
          </button>
          <button className="icon-btn sm" title="New conversation" aria-label="New conversation" disabled={running || msgs.length === 0 || !configured} onClick={() => void api.ai.newConversation().then((c) => (setState({ conversation: c }), focusComposer()))}>
            <Plus />
          </button>
        </div>
      )}
      <div
        className="chat-log"
        ref={logRef}
        role="log"
        aria-label="AI conversation"
        aria-busy={running}
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
              !draft.trim() && (
                <div className="suggestions" role="group" aria-label="Suggestions">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      className="suggestion"
                      onClick={() => {
                        setState({ chatDraft: s });
                        requestAnimationFrame(() => {
                          sizeToFit(taRef.current);
                          taRef.current?.focus();
                        });
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )
            )}
            <p className="chat-privacy">Page text and structure are sent to {configured && provider ? provider.label : 'the provider you choose'}. Images are never sent.</p>
          </div>
        )}
        {msgs.map((m) => (m.role === 'user' ? <UserMessage key={m.id} m={m} /> : <AssistantMessage key={m.id} m={m} live={m.runId === activeRunId && running} undoable={m.id === undoableId} onAnswered={focusComposer} />))}
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
            {waiting && (
              <button className="btn btn-sm" onClick={showQuestion}>
                Go to question
              </button>
            )}
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
      {configured ? (
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
                      title: `Only ${selLabel}`,
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
          <textarea
            ref={taRef}
            value={draft}
            placeholder={waiting ? 'Answer the question above to continue…' : running ? 'Draft your next message…' : selLabel && ctxOn.selection ? `Ask about the ${sel}…` : 'Describe a change…'}
            aria-label="Message"
            rows={1}
            onChange={(e) => {
              setState({ chatDraft: e.target.value });
              sizeToFit(e.target);
            }}
            onKeyDown={(e) => {
              const sendOnEnter = getState().settings?.ai.sendOnEnter ?? true;
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && (sendOnEnter ? !e.shiftKey : e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                // Enter during a run says why nothing was sent, and takes you to a waiting question.
                if (waiting) showQuestion();
                else if (running && draft.trim()) toast('Your message is kept here. You can send it when the current request finishes.', 'info');
                else void send();
              }
            }}
          />
          <div className="composer-foot">
            {provider && (
              <button className="btn btn-sm btn-ghost composer-model" title="Change AI provider or model" aria-haspopup="dialog" onClick={openSettings}>
                <span className="label">
                  {provider.label} · {modelLabel}
                </span>
                <Settings2 size={12} />
              </button>
            )}
            <span className="grow" />
            <button className="send-btn" disabled={running || !draft.trim() || sending} title={waiting ? 'Answer the question above first' : running ? 'You can send once this request finishes' : 'Send'} aria-label={waiting ? 'Send (answer the question above first)' : running ? 'Send (available when the current request finishes)' : 'Send'} onClick={() => void send()}>
              <ArrowUp />
            </button>
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
  return (
    <div className="msg-user">
      {m.text}
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

function AssistantMessage({ m, live, undoable, onAnswered }: { m: ChatMessage; live: boolean; undoable: boolean; onAnswered: () => void }) {
  const [answer, setAnswer] = useState('');
  const r = m.result;
  const activities = m.activities ?? [];
  const asking = !!m.question && !m.question.answered && !r;
  // Each new question starts with an empty typed answer.
  useEffect(() => setAnswer(''), [m.question?.text]);
  const reply = (a: string) => {
    void api.ai.answer(m.runId!, a);
    onAnswered();
  };
  return (
    <div className="msg-ai" aria-busy={live || undefined}>
      {!r && activities.length > 0 && <Steps items={activities} waiting={asking} recent={4} />}
      {!r && m.text && (
        <div className="text">
          <Md text={m.text} />
        </div>
      )}
      {live && !r && !m.text && !activities.length && (
        <div className="activity-list chat-starting">
          <span className="activity running">
            <span className="activity-icon">
              <Spinner decorative />
            </span>
            Getting started…
          </span>
        </div>
      )}
      {m.question &&
        (m.question.answered ? (
          <div className="answered">
            <span className="answered-q">{m.question.text}</span>
            <span>
              You answered: <strong>{m.question.answered}</strong>
            </span>
          </div>
        ) : (
          asking && (
            <div className="question-card" role="group" aria-labelledby={`${m.id}-q`}>
              <div className="question-text" id={`${m.id}-q`} tabIndex={-1}>
                {m.question.text}
              </div>
              <div className="choices">
                {m.question.choices.map((c) => (
                  <button key={c} className="btn btn-sm choice" onClick={() => reply(c)}>
                    {c}
                  </button>
                ))}
              </div>
              {/* Permission to widen the scope is granted only by its exact choice, so it offers no typed answer. */}
              {!m.question.choices.includes(WIDEN_CHOICE) && <div className="question-own">
                <input className="input sm" placeholder="Or type your own answer" aria-label="Your answer" value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && answer.trim() && reply(answer.trim())} />
                <button className={`btn btn-sm${answer.trim() ? ' btn-primary' : ''}`} disabled={!answer.trim()} onClick={() => reply(answer.trim())}>
                  Answer
                </button>
              </div>}
            </div>
          )
        ))}
      {r && <ResultCard m={m} undoable={undoable} />}
    </div>
  );
}

/** Checks that need attention, from the agent's plain-language check lines (and older stored wording). */
const ISSUE = /wider than the screen|overflows its box|(?<!no )horizontal overflow detected|issues? remains?|could(?: not|n['’]t) (?:run|check)|^stopped at /i;

function ResultCard({ m, undoable }: { m: ChatMessage; undoable: boolean }) {
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
  const issues = r.validation.filter((v) => ISSUE.test(v));
  const passes = r.validation.filter((v) => !ISSUE.test(v));
  const [showPasses, setShowPasses] = useState(false);
  const retry = async () => {
    const conv = getState().conversation;
    const typed = getState().chatDraft.trim();
    const original = conv?.messages[(conv?.messages.findIndex((x) => x.id === m.id) ?? 0) - 1]?.text;
    // Never discard something the user is writing without asking.
    if (typed && typed !== original?.trim()) {
      const ok = await confirmDialog({ title: 'Replace your draft?', body: 'The message you are writing will be replaced by the original request, so you can edit it and try again.', confirmLabel: 'Replace draft' });
      if (ok !== true) return;
    }
    const i = conv?.messages.findIndex((x) => x.id === m.id) ?? -1;
    const user = conv?.messages[i - 1];
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
        chatDraft: user.text,
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
                    {c.label}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ul className="changes" aria-label="Changes">
              {r.changes.map((c, i) => (
                <li key={i}>
                  {c.pageId ? (
                    <button
                      className="change-link"
                      onClick={() => {
                        const st = getState().snapshot?.state;
                        if (!st?.pages[c.pageId!]) return toast('That page is no longer in the site.', 'info');
                        selectPage(c.pageId!);
                        if (!c.nodeId) return;
                        const ref = { owner: { kind: 'page' as const, id: c.pageId! }, instancePath: [], nodeId: c.nodeId };
                        let exists = false;
                        try {
                          exists = !!resolveRef(st, ref).node;
                        } catch {
                          exists = false;
                        }
                        if (exists) setState({ selection: ref });
                        else toast(`That element is no longer on ${st.pages[c.pageId!].title}. Showing the page instead.`, 'info');
                      }}
                    >
                      {c.label}
                    </button>
                  ) : (
                    <span>{c.label}</span>
                  )}
                </li>
              ))}
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
      {((r.canUndo && undoable) || undone || authProblem) && (
        <div className="result-foot">
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

