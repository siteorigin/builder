import { useEffect, useRef, useState } from 'react';
import { Lock, Send, Sparkles, Square } from 'lucide-react';
import { LIVE_AI_TEXT_MAX, LIVE_AI_TERMINAL, NO_AI_ACCESS, type LiveAiContext, type LiveAiTurn } from '@shared/live/ai';
import { api, getState, toast, useStore } from '../store';
import { sharedSelection } from '../lib/live-session';
import { admittedRemote, isRemoteShell } from '../lib/remote-session';
import { refLabel } from '../lib/model';
import { isImeComposing } from '../lib/ime';
import { refKey } from '@shared/types';
import './RemoteChat.css';

/**
 * The AI panel in the remote shell (#769): a collaborator's own requests to the host's AI. Off until the host allows
 * it, which the panel says; once allowed, every request runs on the host's computer with the host's AI provider, which
 * the panel says too, and none of this computer's AI settings are used or needed. A request is about the page shown,
 * or the element selected on it, and the collaborator can stop it or answer its questions; the host can do both, and
 * undo it, from its own window.
 */
export function RemoteChat() {
  const remote = useStore(admittedRemote);
  const shown = useStore(isRemoteShell);
  const ai = useStore((s) => s.remoteAi);
  const pageId = useStore((s) => s.pageId);
  const selection = useStore((s) => s.selection);
  const viewport = useStore((s) => s.viewport);
  const snapshot = useStore((s) => s.snapshot);
  const [text, setText] = useState('');
  /**
   * What the request being written is about, fixed when the guest chooses or starts writing: the kind, and the page
   * and selection it was then. Until then, the selection when there is one, else the page. A fresh draft starts again.
   */
  const [pinned, setPinned] = useState<{ scope: 'page' | 'selection'; pageId: string | null; selection: string | null } | null>(null);
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLOListElement>(null);
  const mine = ai && remote && ai.joinId === remote.joinId ? ai : null;
  const turns = mine?.turns ?? [];
  const last = turns[turns.length - 1];
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [turns.length, last?.reply, last?.status, last?.question?.id]);
  if (!remote || remote.role !== 'collaborator' || !shown) return null;
  const access = mine?.access ?? NO_AI_ACCESS;
  const running = mine?.activeRunId ? (turns.find((t) => t.runId === mine.activeRunId) ?? null) : null;
  const shared = sharedSelection(selection, pageId);
  // The whole reference, part and all: another part of the same placement is another target.
  const selectionKey = shared ? `${refKey(shared)}|${shared.partId ?? ''}` : null;
  const target: 'page' | 'selection' = pinned?.scope ?? (shared ? 'selection' : 'page');
  const pin = (scope: 'page' | 'selection') => setPinned({ scope, pageId, selection: scope === 'selection' ? selectionKey : null });
  // A selection chosen for the request that has gone (the host removed it, say) is never quietly taken for the page,
  // nor is a request written about one page or element sent about another the guest has moved to since.
  const lostSelection = target === 'selection' && !shared;
  const moved = !lostSelection && !!pinned && (pinned.pageId !== pageId || (pinned.scope === 'selection' && pinned.selection !== selectionKey));
  const blocked = lostSelection || moved;
  const page = pageId && snapshot?.state.pages[pageId] ? snapshot.state.pages[pageId] : null;
  const label = shared && snapshot ? refLabel(snapshot.state, shared) : null;

  if (!access.allowed)
    return (
      <div className="remote-chat">
        <div className="remote-chat-off">
          <Lock aria-hidden="true" />
          <h3>AI editing is off</h3>
          <p>The host hasn’t allowed you to use AI in this session. They can turn on Allow AI editing for you in their Share menu.</p>
        </div>
        {turns.length > 0 && <TurnLog turns={turns} logRef={logRef} joinId={remote.joinId} activeRunId={null} />}
      </div>
    );

  const send = async () => {
    const request = text.trim();
    if (!request || !page || sending || running || blocked) return;
    const context: LiveAiContext = { scope: target, pageId: pageId!, selection: target === 'selection' ? shared : null, viewport: Math.round(viewport), ...(target === 'selection' && label ? { selectionLabel: label.slice(0, 120) } : {}) };
    setSending(true);
    try {
      const sent = await api.remote.aiSend(remote.joinId, request, context);
      if (sent.ok) {
        setText('');
        setPinned(null);
      }
      else toast(sent.message, 'error');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSending(false);
    }
  };
  const left = access.turnsLeft;
  const spent = left === 0;
  return (
    <div className="remote-chat">
      <p className="remote-chat-host" role="note">
        <Sparkles aria-hidden="true" />
        <span>
          <strong>Running on the host’s AI.</strong> Your requests run on the host’s computer, using their AI provider and its quota.
          {left !== null && <span className="remote-chat-left">{left === 1 ? ' 1 request left.' : ` ${left} requests left.`}</span>}
        </span>
      </p>
      <TurnLog turns={turns} logRef={logRef} joinId={remote.joinId} activeRunId={mine?.activeRunId ?? null} />
      <form
        className="remote-chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="remote-chat-scope" role="radiogroup" aria-label="What the request may change">
          <label>
            <input type="radio" name="remote-ai-scope" checked={target === 'selection'} disabled={!shared && target !== 'selection'} onChange={() => pin('selection')} onClick={() => pin('selection')} />
            {label ? `Selection · ${label}` : 'Selection'}
          </label>
          <label>
            <input type="radio" name="remote-ai-scope" checked={target === 'page'} onChange={() => pin('page')} onClick={() => pin('page')} />
            {page ? `This page · ${page.title}` : 'This page'}
          </label>
        </div>
        {blocked && (
          <p className="remote-chat-note" role="status">
            {lostSelection ? 'Select an element on the page, or choose This page.' : 'You’ve moved since you started writing. Choose what this request is about again.'}
          </p>
        )}
        <textarea
          className="input"
          aria-label="Ask the host’s AI"
          placeholder={spent ? 'You have made all the AI requests the host allowed.' : 'Describe the change you want…'}
          value={text}
          maxLength={LIVE_AI_TEXT_MAX}
          rows={3}
          disabled={spent || !!running}
          onChange={(e) => {
            // What the request is about is the one shown as it was written, whatever is selected by the time it is sent.
            if (!pinned) pin(target);
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !isImeComposing(e)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="remote-chat-actions">
          {running ? (
            <button type="button" className="btn btn-sm run-stop" onClick={() => void api.remote.aiStop(remote.joinId, running.runId)}>
              <Square aria-hidden="true" /> Stop
            </button>
          ) : (
            <button type="submit" className="btn btn-sm btn-primary" disabled={!text.trim() || !page || sending || spent || blocked}>
              <Send aria-hidden="true" /> {sending ? 'Sending…' : 'Send'}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/** Words for how a request stands, while it runs or once it has ended. */
function statusText(turn: LiveAiTurn): string {
  const status = turn.result?.status ?? turn.status;
  switch (status) {
    case 'completed':
      return 'Done';
    case 'partial':
      return 'Partly done';
    case 'no-changes':
      return 'No changes';
    case 'cancelled':
      return 'Stopped';
    case 'failed':
      return 'Failed';
    case 'conflicted':
      return 'Stopped: the project changed outside the app';
    case 'awaiting-input':
      return 'Waiting for your answer';
    case 'validating':
      return 'Checking';
    case 'stopping':
      return 'Stopping';
    default:
      return 'Working';
  }
}

function TurnLog({ turns, logRef, joinId, activeRunId }: { turns: LiveAiTurn[]; logRef: React.RefObject<HTMLOListElement | null>; joinId: string; activeRunId: string | null }) {
  if (!turns.length) return <ol className="remote-chat-log empty" ref={logRef} aria-label="Your AI requests" />;
  return (
    <ol className="remote-chat-log" ref={logRef} aria-label="Your AI requests">
      {turns.map((turn) => (
        <Turn key={turn.runId} turn={turn} joinId={joinId} live={turn.runId === activeRunId} />
      ))}
    </ol>
  );
}

function Turn({ turn, joinId, live }: { turn: LiveAiTurn; joinId: string; live: boolean }) {
  const [answer, setAnswer] = useState('');
  const ended = !!turn.result || (turn.status !== null && LIVE_AI_TERMINAL.includes(turn.status));
  const working = turn.activities.filter((a) => a.status === 'running').slice(-1)[0];
  const reply = (body: string) => {
    if (!turn.question || !body.trim()) return;
    const q = turn.question;
    void api.remote.aiAnswer(joinId, turn.runId, q.id, body.trim()).then((ok) => {
      if (ok) setAnswer('');
      else if (getState().remoteAi?.turns.find((t) => t.runId === turn.runId)?.question?.id === q.id) toast('That question is no longer waiting for an answer.', 'info');
    });
  };
  return (
    <li className="remote-chat-turn">
      <p className="remote-chat-request">{turn.request}</p>
      <div className="remote-chat-reply" aria-live={live ? 'polite' : undefined}>
        <p className={`remote-chat-status${ended ? '' : ' working'}`}>
          {statusText(turn)}
          {!ended && working ? ` · ${working.label}` : ''}
        </p>
        {turn.reply && <p className="remote-chat-text">{turn.reply}</p>}
        {turn.result && turn.result.summary && turn.result.summary !== turn.reply && <p className="remote-chat-text">{turn.result.summary}</p>}
        {turn.result?.error && <p className="remote-chat-error">{turn.result.error}</p>}
        {turn.result && turn.result.changes.length > 0 && (
          <ul className="remote-chat-changes" aria-label="What changed">
            {turn.result.changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        )}
        {!ended && turn.question && (
          <div className="remote-chat-question">
            <p>{turn.question.text}</p>
            {turn.question.choices.length > 0 && (
              <div className="remote-chat-choices">
                {turn.question.choices.map((c) => (
                  <button key={c} type="button" className="btn btn-sm" onClick={() => reply(c)}>
                    {c}
                  </button>
                ))}
              </div>
            )}
            <form
              className="remote-chat-answer"
              onSubmit={(e) => {
                e.preventDefault();
                reply(answer);
              }}
            >
              <input className="input" aria-label="Your answer" value={answer} maxLength={LIVE_AI_TEXT_MAX} onChange={(e) => setAnswer(e.target.value)} />
              <button type="submit" className="btn btn-sm btn-primary" disabled={!answer.trim()}>
                Answer
              </button>
            </form>
          </div>
        )}
      </div>
    </li>
  );
}
