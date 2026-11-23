import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Check, CircleAlert, CircleCheck, CircleSlash, FileText, History, KeyRound, MousePointerClick, Plus, RotateCcw, Sparkles, Square, Trash2, X } from 'lucide-react';
import type { ChatContext, ChatMessage } from '@shared/api';
import { api, getState, setState, toast, useStore } from '../store';
import { refLabel } from '../lib/model';
import { selectPage } from '../lib/actions';
import { Spinner, useMenu } from '../components/ui';

/** Minimal, safe inline formatting for model text: **bold**, `code` and [links](…) shown as text. */
function Md({ text }: { text: string }) {
  const parts = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <span className="md">
      {parts.map((p, i) => (p.startsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p.startsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : p))}
    </span>
  );
}

const SUGGESTIONS = ['Rewrite the home page hero to sound warmer and more confident', 'Add a Services page with three service cards and link it from the header', 'Make the brand color a deep navy blue', 'Add an FAQ section to the Contact page'];

const STATUS_LABEL: Record<string, string> = {
  preparing: 'Preparing',
  running: 'Working',
  'awaiting-input': 'Waiting for your answer',
  validating: 'Checking the result',
  repairing: 'Fixing a problem',
  stopping: 'Stopping'
};

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
  const nearBottom = useRef(true);
  const menu = useMenu();
  const [sending, setSending] = useState(false);

  const provider = providers.find((p) => p.id === settings?.ai.provider);
  const configured = !!provider?.configured;
  const msgs = conversation?.messages ?? [];
  const running = !!runStatus;
  const working = msgs.find((m) => m.runId === activeRunId && m.role === 'assistant');
  const workingUser = working ? msgs[msgs.indexOf(working) - 1] : null;

  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [conversation]);

  useEffect(() => {
    const t = setTimeout(() => void api.project.saveLocalState({ chatDraft: draft }), 400);
    return () => clearTimeout(t);
  }, [draft]);

  if (!snap) return null;
  const st = snap.state;
  const page = pageId ? st.pages[pageId] : null;
  const selLabel = selection ? refLabel(st, selection) : null;

  const send = async (text = draft) => {
    if (!text.trim() || running || sending) return;
    if (!configured) return setState({ modal: { kind: 'settings', tab: 'ai' } });
    // Freeze the exact context at send time.
    const ctx: ChatContext = {
      pageId: ctxOn.page && page ? page.id : st.site.homePageId,
      pageTitle: ctxOn.page && page ? page.title : st.pages[st.site.homePageId]?.title ?? '',
      selection: ctxOn.selection && selection ? structuredClone(selection) : null,
      selectionLabel: ctxOn.selection && selLabel ? selLabel : null,
      viewport
    };
    setSending(true);
    nearBottom.current = true;
    const r = await api.ai.send(text.trim(), ctx);
    setSending(false);
    if (!r.ok) toast(r.message ?? 'Could not start the request.', 'error');
    else {
      setState({ chatDraft: '', chatContextEnabled: { page: true, selection: true } });
      const ta = document.querySelector<HTMLTextAreaElement>('.composer textarea');
      if (ta) ta.style.height = '';
    }
  };

  return (
    <div className="chat">
      <div className="row" style={{ padding: '6px 8px 0 14px' }}>
        <span className="faint ellipsis grow" style={{ fontSize: 11.5 }}>
          {conversation?.title && conversation.messages.length ? conversation.title : 'New conversation'}
        </span>
        <button className="icon-btn sm" title="Conversations" aria-label="Conversations" onClick={async (e) => {
          const el = e.currentTarget;
          const { list } = await api.ai.conversations();
          menu.openAt(el, [
            ...list.slice(0, 12).map((c) => ({ label: c.title, onSelect: () => void api.ai.openConversation(c.id).then((conv) => setState({ conversation: conv })) })),
            ...(list.length ? [{ separator: true }] : []),
            { label: 'Clear conversation history', icon: <Trash2 />, danger: true, onSelect: () => void api.ai.clearHistory().then((conv) => setState({ conversation: conv })) }
          ]);
        }} disabled={running}>
          <History />
        </button>
        <button className="icon-btn sm" title="New conversation" aria-label="New conversation" disabled={running} onClick={() => void api.ai.newConversation().then((c) => setState({ conversation: c }))}>
          <Plus />
        </button>
      </div>
      <div className="chat-log" ref={logRef} aria-live="off" onScroll={(e) => {
        const el = e.currentTarget;
        nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}>
        {msgs.length === 0 && (
          <div className="chat-empty">
            <div className="spark">
              <Sparkles size={20} />
            </div>
            <div>
              <strong>Ask AI to edit your site</strong>
              <p className="muted" style={{ margin: '4px 0 0' }}>
                It uses the same editing tools you do, checks its work and every turn can be undone.
              </p>
            </div>
            {configured ? (
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="suggestion" onClick={() => setState({ chatDraft: s })}>
                    {s}
                  </button>
                ))}
              </div>
            ) : (
              <button className="btn btn-primary" onClick={() => setState({ modal: { kind: 'settings', tab: 'ai' } })}>
                <KeyRound /> Connect an AI provider
              </button>
            )}
            <p className="faint" style={{ fontSize: 11.5, margin: 0 }}>
              Page text and structure are sent to your chosen provider. Images are never sent.
            </p>
          </div>
        )}
        {msgs.map((m) => (m.role === 'user' ? <UserMessage key={m.id} m={m} /> : <AssistantMessage key={m.id} m={m} />))}
      </div>
      {running && workingUser?.context && (
        <div className="working" role="status">
          <Spinner />
          <span className="ellipsis">
            {STATUS_LABEL[runStatus!] ?? 'Working'} on {workingUser.context.pageTitle}
            {workingUser.context.selectionLabel ? ` → ${workingUser.context.selectionLabel}` : ''}
          </span>
        </div>
      )}
      <div className="composer">
        {(page || selLabel) && (
          <div className="chips">
            {page && ctxOn.page && (
              <span className="chip">
                <FileText /> {page.title}
                <button aria-label="Remove page context" onClick={() => setState({ chatContextEnabled: { ...ctxOn, page: false } })}>
                  <X />
                </button>
              </span>
            )}
            {selLabel && ctxOn.selection && (
              <span className="chip sel">
                <MousePointerClick /> <span className="ellipsis">{selLabel}</span>
                <button aria-label="Remove selection context" onClick={() => setState({ chatContextEnabled: { ...ctxOn, selection: false } })}>
                  <X />
                </button>
              </span>
            )}
          </div>
        )}
        <textarea
          value={draft}
          placeholder={selLabel && ctxOn.selection ? `Ask about ${selLabel}…` : 'Describe a change…'}
          aria-label="Message"
          rows={1}
          onChange={(e) => {
            setState({ chatDraft: e.target.value });
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(200, e.target.scrollHeight)}px`;
          }}
          onKeyDown={(e) => {
            const sendOnEnter = getState().settings?.ai.sendOnEnter ?? true;
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && (sendOnEnter ? !e.shiftKey : e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-foot">
          <span className="faint ellipsis grow" style={{ fontSize: 11 }}>
            {provider ? `${provider.label} · ${settings?.ai.models[provider.id]}` : 'No provider'}
          </span>
          {running ? (
            <button className="send-btn stop-btn" title="Stop" aria-label="Stop" onClick={() => void api.ai.stop()}>
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button className="send-btn" disabled={!draft.trim() || sending} title="Send" aria-label="Send" onClick={() => void send()}>
              <ArrowUp />
            </button>
          )}
        </div>
      </div>
      {menu.node}
    </div>
  );
}

function UserMessage({ m }: { m: ChatMessage }) {
  return (
    <div className="msg-user">
      {m.text}
      {m.context?.selectionLabel && <span className="ctx">{m.context.pageTitle} → {m.context.selectionLabel}</span>}
    </div>
  );
}

function AssistantMessage({ m }: { m: ChatMessage }) {
  const [answer, setAnswer] = useState('');
  const r = m.result;
  const activities = m.activities ?? [];
  const running = !r;
  return (
    <div className="msg-ai">
      {activities.length > 0 && (
        <div className="activity-list" aria-label="Activity">
          {activities.map((a) => (
            <div key={a.id} className={`activity ${a.status}`}>
              {a.status === 'running' ? <Spinner /> : a.status === 'done' ? <Check /> : <CircleAlert />}
              <span className="grow">
                {a.label}
                {a.detail && <div className="detail">{a.detail}</div>}
              </span>
            </div>
          ))}
        </div>
      )}
      {running && m.text && <div className="text"><Md text={m.text} /></div>}
      {running && !m.text && !activities.length && (
        <div className="row faint">
          <Spinner /> Thinking…
        </div>
      )}
      {m.question && (
        <div className="question-card">
          <strong>{m.question.text}</strong>
          {m.question.answered ? (
            <span className="muted">You answered: {m.question.answered}</span>
          ) : (
            <>
              <div className="choices">
                {m.question.choices.map((c) => (
                  <button key={c} className="btn btn-sm" onClick={() => void api.ai.answer(m.runId!, c)}>
                    {c}
                  </button>
                ))}
              </div>
              <div className="row">
                <input className="input sm grow" placeholder="Or type an answer" value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && answer.trim() && void api.ai.answer(m.runId!, answer.trim())} />
              </div>
            </>
          )}
        </div>
      )}
      {r && <ResultCard m={m} />}
    </div>
  );
}

function ResultCard({ m }: { m: ChatMessage }) {
  const r = m.result!;
  const head = {
    completed: { icon: <CircleCheck />, label: 'Completed' },
    'no-changes': { icon: <CircleSlash />, label: 'No changes needed' },
    cancelled: { icon: <CircleSlash />, label: 'Cancelled' },
    failed: { icon: <CircleAlert />, label: r.changes.length ? 'Failed and reverted' : 'Failed' },
    conflicted: { icon: <CircleAlert />, label: 'Conflict needs attention' }
  }[r.status as 'completed'] ?? { icon: <CircleAlert />, label: r.status };
  return (
    <div className="result-card">
      <div className={`result-head ${r.status}`}>
        {head.icon}
        {head.label}
        <span className="spacer" />
        {r.usage && <span className="faint" style={{ fontWeight: 400, fontSize: 11 }}>{(r.usage.inputTokens + r.usage.outputTokens).toLocaleString()} tokens</span>}
      </div>
      <div className="result-body">
        <div style={{ whiteSpace: 'pre-wrap' }}><Md text={r.summary} /></div>
        {r.changes.length > 0 && (
          <ul aria-label="Changes">
            {r.changes.map((c, i) => (
              <li key={i}>
                {c.pageId ? (
                  <button className="change-link" onClick={() => {
                    selectPage(c.pageId!);
                    if (c.nodeId) setState({ selection: { owner: { kind: 'page', id: c.pageId! }, instancePath: [], nodeId: c.nodeId } });
                  }}>
                    {c.label}
                  </button>
                ) : (
                  <span>{c.label}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {r.validation.length > 0 && (
          <ul className="checks" aria-label="Checks">
            {r.validation.map((v, i) => (
              <li key={i} className="faint">
                {v}
              </li>
            ))}
          </ul>
        )}
      </div>
      {(r.canUndo || r.status === 'failed' || r.status === 'cancelled') && (
        <div className="result-foot">
          {r.canUndo && (
            <button className="btn btn-sm" onClick={async () => {
              const res = await api.ai.undoTurn(m.runId!);
              if (!res.ok) toast(res.message ?? 'This turn cannot be undone.', 'error');
            }}>
              <RotateCcw /> Undo turn
            </button>
          )}
          {(r.status === 'failed' || r.status === 'cancelled') && (
            <button className="btn btn-sm" onClick={() => {
              const conv = getState().conversation;
              const i = conv?.messages.findIndex((x) => x.id === m.id) ?? -1;
              const user = conv?.messages[i - 1];
              if (user) setState({ chatDraft: user.text });
            }}>
              Try again
            </button>
          )}
          {r.error && /API key|Settings/.test(r.summary) && (
            <button className="btn btn-sm" onClick={() => setState({ modal: { kind: 'settings', tab: 'ai' } })}>
              Open settings
            </button>
          )}
        </div>
      )}
    </div>
  );
}
