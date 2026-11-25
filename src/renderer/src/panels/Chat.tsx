import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, BookOpen, Check, ChevronDown, CircleAlert, CircleCheck, CircleDashed, CircleHelp, CircleStop, Component, Cpu, FileText, Globe, History, ImagePlus, Info, KeyRound, MessageCircleQuestionMark, MousePointerClick, Pencil, Play, Plus, RefreshCw, RotateCcw, Search, Settings2, SlidersHorizontal, Sparkles, Square, Trash2, TriangleAlert } from 'lucide-react';
import { turnQuestions, type ChatActivity, type ChatChange, type ChatContext, type ChatEditScope, type ChatImageRef, type ChatMessage, type ConversationSummary, type FieldLocation } from '@shared/api';
import { NEW_CONVERSATION, storedTitle } from '@shared/conversations';
import type { ElementRef, ProjectState } from '@shared/types';
import { refLabel } from '../lib/model';
import { api, getState, saveLocal, setState, toast, useStore, confirmDialog, selectChatDraft, selectChatImages, setChatDraft, inspectorFocusRequest } from '../store';
import { afterSendMessage, draftFor, imagesFor, moveDraft, moveImages, unsentDrafts, withDraft, withImages } from '../lib/chatDrafts';
import { modelLines, nextRecipient, recipientText, sameRecipient, switchNotice, switchNoticeText, turnRecipient } from '../lib/chatRecipient';
import { PROVIDER_LABELS, turnModelText, type TurnModel } from '@shared/turn-model';
import { chatContextFor, composerScope, editScope, requestTarget, retryView, targetOf, uneditableDesign } from '../lib/chatTarget';
import { CHAT_FOCUS_WAIT_MS, chatFocusStep } from '../lib/page-start';
import { chatSuggestions } from '../lib/chatSuggestions';
import { auditOnce } from '../lib/seo-health';
import { headroomWarning, replayedWords, smallToolsCover } from '../lib/chatHeadroom';
import { openPost, selectPage } from '../lib/actions';
import { postShown, postWorkspace } from '../lib/posts';
import { activeWorkspace, changeWithoutDocument } from '../lib/workspace';
import { seoDocument } from '../lib/seo-view';
import { saveOpenPost } from '../lib/post-draft';
import { answerOnly, canOpen, changeTarget, changeText, checksOf, continueContext, locationTarget, resumableId, retryableId, reviewEntryId, reviewNote, standingNote, undoableId as undoableTurn } from '../lib/result';
import { summaryNow, turnState } from '@shared/turns';
import { chatBusy, composerAction, imageLabels, isPaused, offeredImages, questionHint, shownQuestions, waitingQuestion, type WaitingQuestion } from '../lib/chatQuestions';
import { isImeComposing } from '../lib/ime';
import { textBlocks } from '../lib/model-text';
import { Spinner, useMenu } from '../components/ui';
import { ImageChips, ImageChoices } from '../components/ChatImages';
import { ConversationsModal } from './Conversations';
import { activityHint } from '../lib/conversations';
import './Chat.css';

/** Minimal, safe inline formatting for model text: **bold**, `code` and [links](…) shown as text. */
function Inline({ text }: { text: string }) {
  const parts = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return <>{parts.map((p, i) => (p.startsWith('**') && p.length > 4 ? <strong key={i}>{p.slice(2, -2)}</strong> : p.startsWith('`') && p.length > 2 ? <code key={i}>{p.slice(1, -1)}</code> : p))}</>;
}

/**
 * Model text as the reader expects it (textBlocks): paragraphs, lists and a bold lead line. One paragraph stays inline,
 * so a short reply is a plain line of text.
 */
function Md({ text }: { text: string }) {
  const shown = textBlocks(text);
  if (shown.length <= 1 && (!shown[0] || shown[0].kind === 'p'))
    return (
      <span className="md">
        <Inline text={shown[0]?.lines.join('\n') ?? ''} />
      </span>
    );
  return (
    <div className="md">
      {shown.map((b, i) => {
        if (b.kind === 'ul' || b.kind === 'ol') {
          const List = b.kind;
          return (
            <List key={i}>
              {b.lines.map((l, j) => (
                <li key={j}>
                  <Inline text={l} />
                </li>
              ))}
            </List>
          );
        }
        return (
          <p key={i} className={b.kind === 'lead' ? 'md-lead' : undefined}>
            <Inline text={b.lines.join('\n')} />
          </p>
        );
      })}
    </div>
  );
}

/** The SEO audit's findings for the starters (#599): none when the audit could not read the project, which Project health reports. */
const seoFindingsOf = (state: ProjectState) => {
  const audit = auditOnce(state);
  return audit.ok ? audit.findings : [];
};

/** Said when a starter widens what the AI may change, so the change of scope is heard as well as seen. */
const WIDENED_SAY = 'What the AI may change is now the whole site, for this message.';

/** What the run strip says for each phase of a run. */
const PHASE: Record<string, string> = {
  preparing: 'Getting started',
  running: 'Working',
  'awaiting-input': 'Needs your answer',
  validating: 'Checking the result',
  repairing: 'Fixing a problem',
  stopping: 'Stopping'
};

/** How a finished turn is headed: one icon and one word per outcome, never color alone. */
function outcome(r: NonNullable<ChatMessage['result']>) {
  // A question read the site and could not change it, which is what its heading says.
  if (r.ask && r.status === 'no-changes') return { icon: <BookOpen />, label: 'Answered · site unchanged' };
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
  if (r.ask && r.status === 'cancelled' && /^stopped\.?$/i.test(r.summary.trim())) return 'You stopped this question. It could not change anything.';
  if (r.status === 'cancelled' && /^stopped\.?$/i.test(r.summary.trim())) return r.changes.length ? 'You stopped this request. Its changes were undone.' : 'You stopped this request before it changed anything.';
  // A failed edit that changed nothing says so, unless its own words already do.
  if (r.status === 'failed' && !r.ask && !r.changes.length && !/restored|unchanged|not changed|no changes|nothing (was|has been) changed/i.test(r.summary)) return `${r.summary.trim()} Nothing on your site was changed.`;
  return r.summary;
}

/**
 * What a sent request was allowed to change, as its caption and the run strip name it. An edit with no element
 * chosen reaches its page, or the whole site (as every one sent before the page could be chosen could), and says which
 * rather than naming only the page it started on.
 */
function scopeOf(ctx?: ChatContext | null, state?: ProjectState): string {
  if (!ctx) return '';
  // A post's request reaches that post alone, which its target names.
  if (ctx.post && typeof ctx.post === 'object') return targetOf(ctx);
  const inComponent = typeof ctx.component?.name === 'string';
  if (ctx.mode !== 'ask' && !ctx.selectionLabel && !inComponent && ctx.pageTitle) return ctx.scope === 'page' ? `This page · ${ctx.pageTitle}` : `Whole site · from ${ctx.pageTitle}`;
  // A part of a placed component can change the whole placement (agent/scope.ts), which is the real boundary.
  if (ctx.mode !== 'ask' && ctx.selection && !inComponent) {
    const boundary = boundaryOf(state, ctx.selection);
    if (boundary) return `${ctx.pageTitle} → ${boundary}`;
    if (ctx.selection.instancePath?.length) return `${targetOf(ctx)}’s component`;
  }
  return targetOf(ctx);
}

/**
 * The placed component an element inside it is limited to, by name: the outermost placement on the page, as the agent
 * scopes it. Null for an element that is not inside a placement, or one that can no longer be found.
 */
function boundaryOf(state: ProjectState | undefined, selection: ElementRef | null | undefined): string | null {
  if (!state || !selection || !Array.isArray(selection.instancePath) || !selection.instancePath.length) return null;
  try {
    return refLabel(state, { owner: selection.owner, instancePath: [], nodeId: selection.instancePath[0] });
  } catch {
    return null;
  }
}

/** What a finished turn's final checks found, as its header and its announcement both say it. */
function checkCounts(r: NonNullable<ChatMessage['result']>): string[] {
  const { issues, unverified } = checksOf(r);
  return [issues.length ? `${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}` : '', unverified.length ? `${unverified.length} not checked` : ''].filter(Boolean);
}

/** Plain affirmative answers that grant a scope-widening question when typed, as the agent reads them (orchestrator.ts). */
const TYPED_YES = /^\s*(y|yes|yeah|yep|ok|okay|sure|allow( it)?|go ahead|please do)[\s.!]*$/i;

/** The step a live run is on, which the run strip names; the transcript keeps the steps already taken. */
function currentStep(activities: ChatActivity[] | undefined): string | undefined {
  return [...(activities ?? [])].reverse().find((a) => a.status === 'running')?.label;
}

/** How close to the end of the log counts as being at the end. */
const FOLLOW_PX = 48;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function sizeToFit(ta: HTMLTextAreaElement | null) {
  // A hidden panel measures nothing; it is sized again when it is shown.
  if (!ta || !ta.offsetParent) return;
  ta.style.height = 'auto';
  // The stylesheet's max-height is the cap, so the box and the text agree on where scrolling starts.
  const cap = parseFloat(getComputedStyle(ta).maxHeight) || 240;
  ta.style.height = `${Math.min(cap, ta.scrollHeight)}px`;
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
  const definitionMode = useStore((s) => s.definitionMode);
  // The post the Posts workspace shows, written or previewed: the next message is about it, not the page under it.
  const openPostRef = useStore((s) => s.post);
  const leftTab = useStore((s) => s.leftTab);
  const postView = useStore((s) => s.postView);
  const editorMode = useStore((s) => s.mode);
  const postPreviewAt = useStore((s) => s.postPreviewAt);
  // The document the SEO view has chosen: while the view covers the canvas, the next message is about it (#700).
  const seoSubject = useStore((s) => s.seoSubject);
  const snap = useStore((s) => s.snapshot);
  const viewport = useStore((s) => s.viewport);
  const ctxOn = useStore((s) => s.chatContextEnabled);
  const chatMode = useStore((s) => s.chatMode);
  const runMode = useStore((s) => s.runMode);
  const askMode = chatMode === 'ask';
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const chatFocus = useStore((s) => s.chatFocus);
  const dockOpen = useStore((s) => s.dockOpen);
  // Write with AI before an AI provider is connected: the box still takes the page's copy, which waits there as the
  // conversation's draft and is sent once a provider is connected.
  const [draftFirst, setDraftFirst] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  // Scrolled back far enough that the latest turn is out of sight: offer the way back.
  const [away, setAway] = useState(false);
  const jumping = useRef(false);
  const frozenScope = useRef<{ run: string | null; text: string }>({ run: null, text: '' });
  const menu = useMenu();
  const attachMenu = useMenu();
  const scopeMenu = useMenu();
  const modeMenu = useMenu();
  const [sending, setSending] = useState(false);
  const [announce, setAnnounce] = useState('');
  // Every announcement is keyed by its run (and question), so each is said once and none replaces a later one.
  const announced = useRef(new Set<string>());
  const sayOnce = (key: string, text: string) => {
    if (announced.current.has(key)) return;
    announced.current.add(key);
    setAnnounce(text);
  };
  const trackedRun = useRef<string | null>(null);
  const shownConversation = useRef<string | null>(null);
  const history = useStore((s) => s.snapshot?.history);
  const rightTab = useStore((s) => s.rightTab);

  const provider = providers.find((p) => p.id === settings?.ai.provider);
  const configured = !!provider?.configured;
  // The local server or model failed the last time anything asked it: Chat says so instead of offering starters.
  const notReady = configured && provider?.id === 'local' && provider.check && !provider.check.ok ? provider.check : null;
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
  // Two destinations, never confused: the model the running turn went to (fixed on the turn when it started), and
  // the one Settings choose for the next message.
  const inFlight = running ? turnRecipient(working) : null;
  /** A turn has started and not ended, even before its status arrives (a local server can take a while to answer). */
  const pending = running || !!(working && !working.result);
  // With no local model chosen, the server's first model takes the next message: asked whenever it may have changed
  // (another conversation, a finished run, coming back to the app), so a server that now runs another model is a switch.
  const autoLocal = configured && provider?.id === 'local' && !settings?.ai.models.local?.trim() ? (settings?.ai.local.baseURL ?? '') : null;
  const [serverModel, setServerModel] = useState<{ baseURL: string; id: string | null } | null>(null);
  const probeSeq = useRef(0);
  /** The model the local server offers first now; only the newest answer is kept, whatever order they arrive in. */
  const probeServer = (baseURL: string): Promise<string | null> => {
    const seq = ++probeSeq.current;
    return api.ai
      .localModels()
      .then(
        (r) => (r.ok && r.models[0]) || null,
        () => null
      )
      .then((id) => {
        if (seq === probeSeq.current) setServerModel({ baseURL, id });
        return id;
      });
  };
  useEffect(() => {
    if (autoLocal === null) return;
    const ask = () => void probeServer(autoLocal);
    ask();
    window.addEventListener('focus', ask);
    return () => {
      // Answers to questions asked before now are for another server or another moment.
      probeSeq.current++;
      window.removeEventListener('focus', ask);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLocal, conversation?.id, running]);
  const next = nextRecipient(provider, settings?.ai.models, autoLocal !== null && serverModel?.baseURL === autoLocal ? serverModel.id : null);
  // A message to a model that has not seen this conversation's recent messages says so before it is sent.
  // It is about the next message, so while a run is under way it waits until something is written for that message.
  const notice = asking || (pending && !draft.trim() && !images.length) ? null : switchNotice(msgs, next);
  const noticeId = useId();
  const headroomId = useId();
  const freshing = useRef(false);
  const answerElsewhere = !!(asking && inFlight && next && !sameRecipient(inFlight, next));
  // Undo turn is offered only while that turn is the newest step in the project's undo history: history
  // undoes in order, so any later edit (manual or AI) makes an older turn's Undo fail.
  const undoableId = undoableTurn(msgs, history);
  // Work that has been undone is not continued from (its card offers a fresh attempt instead): History says which.
  const resumable = running ? undefined : resumableId(msgs, history);
  const retryable = running ? undefined : retryableId(msgs);
  // The title Earlier conversations lists it by: the author's name for it, or its first request cut at a word.
  const title = conversation && (msgs.length || conversation.named) ? storedTitle(conversation) : NEW_CONVERSATION;

  useLayoutEffect(() => {
    const el = logRef.current;
    // Opening another conversation lands on its latest turn; within one, follow only if already near the end.
    if (conversation?.id !== shownConversation.current) {
      shownConversation.current = conversation?.id ?? null;
      nearBottom.current = true;
      setAway(false);
    }
    // An empty conversation reads from its top; one with turns opens on its latest.
    if (el && msgs.length === 0) el.scrollTop = 0;
    else if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
    // Output that arrives while the reader is scrolled back fires no scroll event, so the way back is checked here too.
    else if (el) setAway(el.scrollHeight - el.scrollTop - el.clientHeight >= FOLLOW_PX);
  }, [conversation]);

  // The log also changes size without scrolling: the composer grows, a question card arrives, a disclosure opens. A
  // reader at the end stays at the end; one scrolled back keeps their place and the way back stays accurate.
  useEffect(() => {
    const el = logRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const below = el.scrollHeight - el.scrollTop - el.clientHeight;
      // The log itself resizing (the composer grows, a question arrives) keeps a reader at the end there. A turn growing
      // because the reader opened its details is left where they put it.
      if (nearBottom.current && entries.some((e) => e.target === el)) {
        if (below > 1) el.scrollTop = el.scrollHeight;
      } else if (!jumping.current) setAway(below >= FOLLOW_PX);
    });
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!snap, conversation?.id, msgs.length]);

  const jumpToLatest = () => {
    const el = logRef.current;
    if (!el) return;
    nearBottom.current = true;
    jumping.current = !reducedMotion();
    setAway(false);
    el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
    // The button goes once used, so focus moves on to where the conversation continues: the composer, or the log
    // itself when there is no composer to write in.
    if (taRef.current) focusComposer();
    else el.focus({ preventScroll: true });
  };

  /** Open History at an earlier turn's step, with what it changed and what came after it (issue 164). */
  // Only in the opening it was asked in: a review left open across a reopen never acts on another opening.
  const reviewTurn = (entryId: string) => setState({ modal: { kind: 'history', entryId, review: true, opening: getState().snapshot?.workspaceKey } });

  /** Undo a turn, then say so: the card shows it as undone once project history reports it. */
  const undoTurn = async (runId: string) => {
    const res = await api.ai.undoTurn(runId);
    if (!res.ok) return toast(res.message ?? 'This turn cannot be undone.', 'error');
    setAnnounce('Turn undone. Its changes were reverted.');
    focusComposer();
  };

  // A restored draft (after a restart, a retry, or returning to its conversation, or once a question is answered)
  // gets its full height back.
  useLayoutEffect(() => sizeToFit(taRef.current), [configured, draftFirst, rightTab, conversation?.id, askingKey]);
  // A draft is measured again when the box changes width (the dock resized), so it neither scrolls early nor keeps
  // the height of a narrower box.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta || typeof ResizeObserver === 'undefined') return;
    let width = ta.clientWidth;
    const watch = new ResizeObserver(() => {
      if (ta.clientWidth === width) return;
      width = ta.clientWidth;
      sizeToFit(ta);
    });
    watch.observe(ta);
    return () => watch.disconnect();
  }, [configured, draftFirst, askingKey]);

  // One polite status message per phase change, kept outside the (sometimes hidden) dock panel so it is
  // announced wherever focus is. Streamed text is never read out piece by piece. The outcome is announced
  // once per run, from that run's own result, whichever of the status and the message arrives first.
  useEffect(() => {
    if (runStatus && activeRunId) {
      trackedRun.current = activeRunId;
      if (runStatus === 'awaiting-input') {
        // Announced once per question, when it arrives; the composer is already where it is answered.
        if (asking && askingKey) sayOnce(`${askingKey}:asked`, `The AI needs your answer to continue: ${asking.question.text}${asking.question.widen ? ' Allowing it lets this request change the whole site.' : ''}`);
      } else if (runStatus === 'stopping') sayOnce(`${activeRunId}:stopping`, runMode === 'ask' ? 'Stopping the question.' : 'Stopping the AI. Its changes are being undone.');
      else {
        // The step the strip names, if one is under way: said once each, in the strip's words.
        const step = [...(working?.activities ?? [])].reverse().find((a) => a.status === 'running');
        const stepKey = step ? `${activeRunId}:step:${step.id}` : '';
        if ((runStatus === 'preparing' || runStatus === 'running') && workingUser?.context && !announced.current.has(`${activeRunId}:start`)) {
          // Said once the request has arrived, so it names what the AI may change, in the words the strip uses, with the
          // step already under way. A question reads the site and cannot change it, so it is never said to be working on
          // anything.
          if (stepKey) announced.current.add(stepKey);
          sayOnce(`${activeRunId}:start`, `${runMode === 'ask' ? 'AI started reading the site.' : `AI started working on ${scopeOf(workingUser.context, getState().snapshot?.state)}.`}${step ? ` ${step.label}.` : ''}`);
        } else if (runStatus === 'validating' || runStatus === 'repairing') {
          // Checking and repairing are phases the author may be waiting on, so each is said when it first starts, with
          // its step unless the step only repeats the phase's words.
          const phaseKey = `${activeRunId}:${runStatus}`;
          const echoes = !!step && step.label.replace(/\.$/, '') === PHASE[runStatus];
          // A step said before (the one that was under way when the phase began) is not said again.
          const said = step && !echoes && !announced.current.has(stepKey) ? ` ${step.label}.` : '';
          if (!announced.current.has(phaseKey)) {
            if (stepKey) announced.current.add(stepKey);
            sayOnce(phaseKey, `${PHASE[runStatus]}.${said}`);
          } else if (stepKey && echoes) announced.current.add(stepKey);
          else if (stepKey) sayOnce(stepKey, `${step!.label}.`);
        } else if (stepKey && announced.current.has(`${activeRunId}:start`)) sayOnce(stepKey, `${step!.label}.`);
      }
      // Each announcement stays until the next one replaces it: clearing it on the next update could cut it off.
    }
    const run = trackedRun.current;
    const done = run && !announced.current.has(`${run}:done`) ? msgs.find((m) => m.role === 'assistant' && m.runId === run && m.result) : undefined;
    // The outcome, with the same check counts the card shows beside it.
    if (done?.result) sayOnce(`${run}:done`, `${[outcome(done.result).label, ...checkCounts(done.result)].join(', ')}. ${summaryOf(done.result)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runStatus, activeRunId, conversation]);

  // A starter that needs more than this page widens the scope for its own draft only, kept per conversation: the
  // scope is Whole site while that draft is in front of the author (again after coming back to it), and the earlier
  // choice returns once the draft is cleared or sent (a sent message keeps the scope it was sent with) or another
  // conversation is shown. Picking a scope by hand ends it, so a choice the author made is never undone, and so does a
  // scope set from elsewhere since (Fix with AI opening its own conversation as Whole site, say): `widenedTo` is the
  // scope setting the widening made, and only that one is put back.
  const starterWidened = useRef(new Map<string, ChatEditScope>());
  const widenedHere = useRef<string | null>(null);
  const widenedTo = useRef<object | null>(null);
  const setScope = (to: ChatEditScope) => setState({ chatContextEnabled: { ...getState().chatContextEnabled, scope: to } });
  const widen = () => {
    setScope('site');
    widenedTo.current = getState().chatContextEnabled;
  };
  /** Put the scope back from a widening, unless something else has set it since. */
  const unwiden = (to: ChatEditScope) => {
    if (getState().chatContextEnabled === widenedTo.current && getState().chatContextEnabled.scope === 'site') setScope(to);
    widenedTo.current = null;
  };
  /** A draft moved to another conversation takes its widened scope along. */
  const moveWidened = (from: string, to: string) => {
    const scope = starterWidened.current.get(from);
    if (scope === undefined) return;
    starterWidened.current.delete(from);
    starterWidened.current.set(to, scope);
  };
  useEffect(() => {
    const id = conversation?.id ?? null;
    const left = widenedHere.current;
    if (left && left !== id) {
      widenedHere.current = null;
      const from = starterWidened.current.get(left);
      if (from !== undefined) unwiden(from);
    }
    const from = id ? starterWidened.current.get(id) : undefined;
    if (!id || from === undefined) return;
    if (!draft.trim()) {
      starterWidened.current.delete(id);
      if (widenedHere.current === id) {
        widenedHere.current = null;
        unwiden(from);
      }
      // Cleared, so the next widening is announced again.
      setAnnounce((said) => (said === WIDENED_SAY ? '' : said));
      return;
    }
    if (widenedHere.current !== id) {
      const now = getState().chatContextEnabled.scope;
      if (now !== 'site') starterWidened.current.set(id, now);
      widenedHere.current = id;
      widen();
      // Coming back to the draft widens again, so it is said again.
      setAnnounce('');
      requestAnimationFrame(() => setAnnounce(WIDENED_SAY));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, conversation?.id]);

  if (!snap) return null;
  const st = snap.state;
  // What the next message is about: the page, or the component edited everywhere, and the element within it.
  // While the Posts workspace is in front, the element or design behind it is never the target: the post it shows, or
  // the page its preview went on to, is. While the SEO view is, the page or post it has chosen is (#700); with none
  // chosen, the page under it, as the writer with no post open leaves it.
  const workspace = activeWorkspace({ leftTab, postView, mode: editorMode, post: openPostRef });
  const shownPost = workspace === 'write' || workspace === 'preview' ? postShown(st, workspace, openPostRef, postPreviewAt) : null;
  const seoChosen = workspace === 'seo' ? seoDocument(st, seoSubject)?.subject : undefined;
  const seoPage = seoChosen?.kind === 'page' ? seoChosen.pageId : null;
  const scope = composerScope(st, {
    pageId: seoPage ?? (shownPost?.kind === 'page' ? shownPost.pageId : pageId),
    selection: workspace ? null : selection,
    definitionMode: workspace ? null : definitionMode,
    post: seoChosen?.kind === 'entry' ? { collectionId: seoChosen.collectionId, entryId: seoChosen.entryId } : shownPost?.kind === 'post' ? shownPost.ref : null
  });
  const { page, component } = scope;
  const selLabel = scope.selectionLabel;
  const sel = selLabel?.toLowerCase();
  /** How far the next message goes, as the composer sends it: the selection only while something is selected. */
  const chosen = editScope(scope, ctxOn.scope);
  const toSelection = chosen === 'selection';
  // A message too long for the local model's context (a whole page's copy, pasted) says so while it is written, so it
  // can be split, or the model loaded with more room, before it is sent.
  const localModel = configured && provider?.id === 'local';
  const headroom =
    localModel && !asking && settings
      ? headroomWarning({ draft, history: replayedWords(msgs), contextWindow: settings.ai.local.contextWindow, toolMode: settings.ai.local.toolMode, pageTools: !askMode && !component && !scope.post && !(toSelection && !!scope.selection && smallToolsCover(st, scope.selection)) })
      : null;
  // Starters come from what this project holds: the page, the selection, the pages and the images that exist.
  // The starters are changes to make, so a question starts from an empty box. They are about pages, so a component
  // edited everywhere offers none.
  // A local server or model that failed its last check is said instead, so no starters are offered.
  const fresh = !component && !scope.post && msgs.length === 0 && configured && !notReady && !!conversation && !draft.trim();
  const suggestions: Array<{ text: string; kind: string }> = !fresh
    ? []
    : askMode
      ? // A question's strongest use is finding where something is edited, so its starters ask that about what is here.
        page
        ? [
            selLabel && toSelection ? `Where do I change the ${sel} in the Inspector?` : `What can I change on the “${page.title}” page, and where?`,
            `Which parts of the “${page.title}” page are shared with other pages?`
          ].map((text) => ({ text, kind: 'ask' }))
        : []
      : chatSuggestions({ state: st, assetUsage: snap.assetUsage, pageId: seoPage ?? pageId, selection: workspace ? null : selection, context: { page: ctxOn.page, selection: toSelection }, seoFindings: dockOpen && rightTab === 'chat' ? seoFindingsOf(st) : undefined });
  const stepNow = currentStep(working?.activities);
  // The run strip is the one place that says what a run is doing now: an edit's current step, or its phase. A question
  // is always "Reading the site", as the dock tab and the canvas say it, followed by its current step.
  const askRun = runMode === 'ask';
  const phase =
    runStatus === 'stopping'
      ? askRun
        ? 'Stopping'
        : 'Stopping · undoing changes'
      : runStatus === 'awaiting-input'
        ? PHASE['awaiting-input']
        : askRun
          ? `Reading the site${stepNow ? ` · ${stepNow}` : ''}`
          : (stepNow ?? PHASE[runStatus ?? ''] ?? 'Working');
  // What the run may change, as it stands: once the author allows a wider change, that is the whole site.
  const widened = !!working && turnQuestions(working).some((q) => q?.widen && typeof q.answered === 'string' && (q.answered === q.choices?.[0] || TYPED_YES.test(q.answered)));
  // The run's scope is named as it stood when it was sent, so a rename or a removal meanwhile cannot rewrite it.
  if (activeRunId && workingUser?.context && frozenScope.current.run !== activeRunId) frozenScope.current = { run: activeRunId, text: scopeOf(workingUser.context, st) };
  const sentScope = activeRunId && frozenScope.current.run === activeRunId ? frozenScope.current.text : '';
  const sentPost = typeof workingUser?.context?.post?.title === 'string' ? workingUser.context.post.title : null;
  const stripDetail = workingUser?.context ? (widened && (sentPost !== null || workingUser.context.pageTitle) ? `Whole site · from ${sentPost !== null ? `the post “${sentPost || 'Untitled'}”` : workingUser.context.pageTitle}` : sentScope || scopeOf(workingUser.context, st)) : '';
  const hasLibraryImages = Object.values(st.assets.assets).some((a) => a?.kind === 'image');
  /** Add a library image to the message, or take it out again; the draft stays as it is. */
  const toggleImage = (id: string) => {
    if (!conversation) return;
    const now = imagesFor(getState().chatImages, conversation.id);
    setState({ chatImages: withImages(getState().chatImages, conversation.id, now.includes(id) ? now.filter((x) => x !== id) : [...now, id]) });
    focusComposer();
  };
  const addImages = (el: HTMLElement, focusLast = false) => {
    const library = Object.values(st.assets.assets)
      .flatMap((a) => (a?.kind === 'image' && typeof a.name === 'string' ? [{ assetId: a.id, name: a.name }] : []))
      .sort((a, b) => a.name.localeCompare(b.name));
    attachMenu.openAt(
      el,
      [
        { heading: 'Add to your message' },
        // Two images with the same name are told apart by their IDs, as the message names them.
        ...imageLabels(library).map((i) => ({ label: i.label, checked: images.includes(i.assetId), toggle: true, onSelect: () => toggleImage(i.assetId) })),
        { separator: true },
        { label: 'Browse in Assets…', onSelect: () => setState({ leftTab: 'assets' }) }
      ],
      'Images',
      { focusLast, above: true }
    );
  };
  // The element a message is limited to, named as the agent limits it: an element inside a placed component, by that component.
  const boundary = boundaryOf(st, scope.selection);
  /** What the next message may change (Edit) or is about (Ask), shown as one chip whose menu holds the other choices.
   *  An element inside a placed component is limited by that component (agent/scope.ts), so it is named by it. A
   *  question changes nothing, so it is about the selection or the page, never "the whole site". */
  type ScopeChoice = { value: ChatEditScope; label: string; description: string; icon: ReactNode; title: string; chip: string; where?: string };
  // An edit is limited by the containing placement; a question is about the element itself.
  const selName = askMode ? selLabel : (boundary ?? selLabel);
  const scopeOptions: ScopeChoice[] = scope.post
    ? // A post is the one thing the message is about: shown, not chosen. The AI asks before changing more.
      [{ value: 'page' as const, label: 'This post', description: askMode ? 'The post you have open' : 'Its words and details', icon: <Pencil />, title: askMode ? `The post “${scope.post.title}”` : `Only the post “${scope.post.title}”`, chip: scope.post.title, where: 'this post' }]
    : component
    ? [
        ...(selLabel ? [{ value: 'selection' as const, label: selLabel, description: 'Only this element', icon: <MousePointerClick />, title: askMode ? `${selLabel}, in ${component.name}` : `Only ${selLabel}, in ${component.name} everywhere it is used`, chip: selLabel, where: `${component.name} everywhere` }] : []),
        { value: 'site' as const, label: `All of ${component.name}`, description: 'Everywhere it is used', icon: <Component />, title: askMode ? `${component.name}, the component you are editing everywhere` : `All of ${component.name}, everywhere it is used`, chip: component.name, where: 'everywhere' }
      ]
    : page
      ? [
          ...(selLabel && selName
            ? [{ value: 'selection' as const, label: selName, description: askMode ? 'The selected element' : boundary ? `The component that holds ${selLabel}` : 'Only this element', icon: <MousePointerClick />, title: askMode ? `${selLabel} on ${page.title}` : scope.selection?.instancePath.length ? `Only ${boundary ?? 'the component'}, the component containing ${selLabel}` : `Only ${selLabel}`, chip: selName, where: page.title }]
            : []),
          { value: 'page' as const, label: 'This page', description: askMode ? `${page.title}, as a whole` : `${page.title}: its sections and settings`, icon: <FileText />, title: `This page · ${page.title}`, chip: page.title },
          ...(askMode ? [] : [{ value: 'site' as const, label: 'Whole site', description: 'Any page, the header and footer, and styles', icon: <Globe />, title: `Whole site · from ${page.title}`, chip: 'Whole site', where: `from ${page.title}` }])
        ]
      : [];
  const scopeValue: ChatEditScope = component ? (toSelection ? 'selection' : 'site') : askMode && chosen === 'site' ? 'page' : chosen;
  const found = scopeOptions.find((o) => o.value === scopeValue) ?? scopeOptions[0] ?? null;
  // A selection in the shared header or footer reaches every page, so the chip says so in words, not only in green.
  const shell = !component && found?.value === 'selection' && scope.selection?.owner.kind === 'shell' ? (scope.selection.owner.id === 'footer' ? 'shared footer' : 'shared header') : null;
  const scopeNow = found && shell ? { ...found, where: shell, title: askMode ? `${found.title}, in the ${shell}` : `${found.title}, in the ${shell} on every page` } : found;
  // A question changes nothing, so what it is about is shown, not chosen: the element or page the next edit would
  // start from (switch to Edit to change it). Ask never rewrites the Edit choice.
  const scopeChoices = askMode ? (scopeNow ? [scopeNow] : []) : scopeOptions;
  // The chip says how far an edit reaches in the house hues: plum for a component edited everywhere, amber for the
  // whole site, green for the shared header or footer. A question changes nothing, so it stays neutral.
  const scopeTone = component ? ' def' : askMode || !scopeNow ? '' : scopeNow.value === 'site' ? ' site' : shell ? ' shared' : '';
  /** The chip's name: its visible words first, then the full sentence of what it allows. */
  const scopeName = scopeNow ? `${askMode ? 'Your question is about' : 'What the AI may change'}: ${scopeNow.chip}${scopeNow.where ? ` · ${scopeNow.where}` : ''}` : '';
  const openScopeMenu = (el: HTMLElement, focusLast = false) =>
    scopeMenu.openAt(
      el,
      [
        { heading: askMode ? 'Your question is about' : 'What the AI may change' },
        ...scopeOptions.map((o) => ({ label: o.label, description: o.description, ariaLabel: o.title, icon: o.icon, checked: o.value === scopeNow?.value, onSelect: () => {
          if (conversation) starterWidened.current.delete(conversation.id);
          widenedHere.current = null;
          setAnnounce((said) => (said === WIDENED_SAY ? '' : said));
          setState({ chatContextEnabled: { ...ctxOn, scope: o.value } });
          focusComposer();
        } }))
      ],
      askMode ? 'Your question is about' : 'What the AI may change',
      { focusLast, above: true }
    );
  const openModeMenu = (el: HTMLElement, focusLast = false) => {
    const pick = (v: 'edit' | 'ask') => {
      setState({ chatMode: v });
      saveLocal({ chatMode: v });
      focusComposer();
    };
    modeMenu.openAt(
      el,
      [
        { label: 'Edit', description: 'Makes the changes you describe', icon: <Pencil />, checked: !askMode, onSelect: () => pick('edit') },
        { label: 'Ask', description: 'Answers without changing anything', icon: <MessageCircleQuestionMark />, checked: askMode, onSelect: () => pick('ask') }
      ],
      'What your next message does',
      { focusLast, above: true }
    );
  };
  const openSettings = () => setState({ modal: { kind: 'settings', tab: 'ai' } });
  const focusComposer = () => requestAnimationFrame(() => taRef.current?.focus());
  // Write with AI's request for the message box, once the box is ready (see writePageWithAi and chatFocusStep).
  useLayoutEffect(() => {
    if (!chatFocus) return;
    const ta = taRef.current;
    const step = chatFocusStep(chatFocus, { now: Date.now(), workspaceKey: snap?.workspaceKey, pageId, chatShown: dockOpen && rightTab === 'chat', box: !!ta, boxForced: draftFirst, configured, asking: !!asking });
    if (step === 'drop') return void setState({ chatFocus: null });
    if (step === 'show-box') return setDraftFirst(true);
    if (step === 'wait' || !ta) return;
    // A request put in the box from elsewhere (Fix with AI) may run to several lines.
    sizeToFit(ta);
    const take = () => {
      ta.focus();
      if (document.activeElement !== ta) return false;
      ta.setSelectionRange(ta.value.length, ta.value.length);
      return true;
    };
    if (take()) return void setState({ chatFocus: null });
    // A dialog closed by the same click (Fix with AI in Project health) keeps the rest of the window inert until it has
    // gone: the box takes focus once it lets go, unless the author has put focus somewhere meanwhile or the request has
    // waited too long, which lets it lapse.
    const req = chatFocus;
    const unclaimed = () => {
      const at = document.activeElement;
      return !at || at === document.body || !!at.closest('[inert]');
    };
    let frame = 0;
    const retry = () => {
      if (getState().chatFocus !== req) return;
      if (Date.now() - req.at > CHAT_FOCUS_WAIT_MS || !unclaimed() || take()) return void setState({ chatFocus: null });
      frame = requestAnimationFrame(retry);
    };
    frame = requestAnimationFrame(retry);
    return () => cancelAnimationFrame(frame);
  }, [chatFocus, snap?.workspaceKey, pageId, dockOpen, rightTab, configured, asking, draftFirst]);

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
    // Acknowledged only while the run is still going, so it never replaces the outcome if that arrived first.
    const after = getState();
    if (!after.conversation?.messages.some((x) => x.runId === q.runId && x.result) && !announced.current.has(`${q.runId}:done`)) sayOnce(`${key}:answered`, 'Answer sent. The AI is continuing.');
  };

  /** `context` replaces the editor's own (and its images), for a message that continues an earlier request. True once
   *  the request has started. */
  const send = async (text = draft, context?: ChatContext): Promise<boolean> => {
    if (!text.trim() || running || sending || !conversation) return false;
    if (!configured) return (openSettings(), false);
    // The assistant has no tools for collection layouts: an edit sent from one would land on the page behind it. A post
    // open in the Posts workspace, or the page its preview went on to, is a target of its own instead.
    const ownTarget = context ? !!context.post : !!scope.post || shownPost?.kind === 'page' || !!seoPage;
    if (getState().templateMode && !ownTarget && (context ? context.mode !== 'ask' : !askMode))
      return (toast('The assistant can’t change a collection’s layout yet. Click Done to go back to the page, or ask it a question.', 'info'), false);
    // A code component open in Component Studio is not one the AI edits: an edit sent now would reach the page behind
    // it. A question changes nothing, so it is still asked.
    const code = !context && !askMode && !ownTarget ? uneditableDesign(st, definitionMode) : null;
    if (code) return (toast(`From Component Studio, the AI can’t be asked to change a code component like ${code} yet. Edit its code, or click Done editing to ask for a change to a page.`, 'info'), false);
    // A change asked from the SEO view is about the page or post chosen there; with none (or the one chosen gone), it
    // would reach the page under the view, so it waits for one (#700). The draft stays.
    if (!context && changeWithoutDocument(workspace, !!seoChosen, askMode)) return (toast('Choose a page or post in the SEO list first: the change is made to the one chosen there.', 'info'), false);
    // The message belongs to the conversation (and project) it was written in.
    const conversationId = conversation.id;
    const opening = snap.workspaceKey;
    // Freeze the exact context at send time.
    const ctx: ChatContext = context ?? chatContextFor(st, scope, { enabled: ctxOn, viewport, assetIds: images, ask: askMode });
    // Keep focus in the composer: the Send button is about to be disabled.
    taRef.current?.focus();
    setSending(true);
    nearBottom.current = true;
    // What the writer holds is saved first, so the AI reads the post as the author sees it. Text that could not be
    // saved stays in the writer with its note, and the message stays here.
    // Only the writer of the post the message is about: Continue for another post never waits on this one.
    // The SEO view can choose the post the writer holds out of sight: its text is saved first too (#700).
    if (ctx.post && (workspace === 'write' || workspace === 'seo') && openPostRef?.collectionId === ctx.post.collectionId && openPostRef.entryId === ctx.post.entryId) {
      const saved = await saveOpenPost().catch(() => false);
      if (!saved) {
        setSending(false);
        return (toast('Part of the post is not saved yet, so the AI would not see it. See the note above its text.', 'error'), false);
      }
    }
    // Sent for the model the composer names now: if Settings or the local server would send it elsewhere by the time it
    // runs, nothing is sent and the turn says so.
    let r: Awaited<ReturnType<typeof api.ai.send>>;
    try {
      r = await api.ai.send(text.trim(), ctx, conversationId, next ? { provider: next.provider, model: next.id } : undefined);
    } catch (e) {
      // A send that never got an answer leaves the composer usable, as a refused one does.
      r = { ok: false, message: e instanceof Error && e.message ? e.message : 'Could not start the request.' };
    }
    setSending(false);
    if (!r.ok) return (toast(r.message ?? 'Could not start the request.', 'error'), false);
    // A continuation was never typed, so whatever is in the composer is the user's own next message.
    if (context) return true;
    // Clear what was sent, but never text typed (or images attached) while the request was starting.
    const s = getState();
    if (s.snapshot?.workspaceKey !== opening) return true;
    const after = afterSendMessage(s.chatDrafts, s.chatImages, conversationId, text, ctx.assetIds ?? []);
    if (after.drafts === s.chatDrafts && after.images === s.chatImages) return true;
    setState({ chatDrafts: after.drafts, chatImages: after.images });
    if (after.drafts !== s.chatDrafts && taRef.current && s.conversation?.id === conversationId) taRef.current.style.height = '';
    return true;
  };

  // A request handed over from elsewhere in the editor (Create component's Build with AI) is sent as it was asked, with
  // its own page and task, when the chat can send it straight away. When it cannot (the AI is not set up, the switch
  // note says earlier messages would go to another model, or the send is refused), it waits by the composer until
  // the author sends or discards it: never sent behind a note they have not seen, and never lost.
  const handed = useStore((s) => s.chatRequest);
  const sendHanded = (req: NonNullable<typeof handed>) => {
    // Only the request still waiting: one discarded since this render is never sent.
    if (getState().chatRequest?.id !== req.id) return;
    // Held from the moment it starts, so whatever renders meanwhile never sends it twice.
    setState({ chatRequest: { ...req, held: true } });
    void send(req.text, req.context).then(
      (sent) => {
        if (sent && getState().chatRequest?.id === req.id) setState({ chatRequest: null });
      },
      () => undefined
    );
  };
  useEffect(() => {
    if (!handed) return;
    if (handed.workspaceKey !== snap.workspaceKey) return void setState({ chatRequest: null });
    if (handed.held || !conversation || running || sending) return;
    // Earlier messages go with it, so it goes on its own only to a model known to have them: a server's model not known
    // yet could be another one than they went to.
    if (!configured || notice || (msgs.length > 0 && next?.id == null)) return void setState({ chatRequest: { ...handed, held: true } });
    sendHanded(handed);
    // `send` reads the state it needs when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handed, conversation, running, sending, configured, notice, msgs.length, next?.id, snap.workspaceKey]);

  /** Carry on with an unfinished request, with that request's own page and selection, leaving the draft alone. */
  const continueRequest = (user: ChatMessage | undefined) => {
    const c = continueContext(user, st, viewport);
    if ('error' in c) {
      // The user picks the target in the editor and sends "Continue" from the composer, never over a draft.
      toast(c.error, 'info');
      const s = getState();
      // "Continue" carries on with an edit, so the composer goes back to Edit for it.
      if (conversation && !draftFor(s.chatDrafts, conversation.id).trim()) {
        setState({ chatDrafts: withDraft(s.chatDrafts, conversation.id, 'Continue'), chatMode: 'edit' });
        saveLocal({ chatMode: 'edit' });
      }
      focusComposer();
      return;
    }
    void send('Continue', c.ctx);
  };

  /** Send a request that failed on the AI setup again, as it was: same words, page, selection and images. */
  const retryRequest = (user: ChatMessage | undefined) => {
    const c = continueContext(user, st, viewport, 'use Edit and try again');
    if ('error' in c) return toast(c.error, 'info');
    void send(user!.text, c.ctx);
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

  // Earlier conversations, managed: found, named and deleted one at a time (issue 235), in the opening of the project
  // the list was read from. Another project opening closes it.
  const [managing, setManaging] = useState<{ opening: string; list: ConversationSummary[] } | null>(null);
  useEffect(() => {
    if (managing && managing.opening !== snap.workspaceKey) setManaging(null);
  }, [managing, snap.workspaceKey]);
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
    const now = new Date();
    menu.openAt(
      el,
      [
        ...(unsent.length
          ? [
              { heading: 'Not sent yet' },
              ...unsent.map((d) => ({ label: d.text.trim().split('\n')[0].slice(0, 60) || `Message with ${d.images === 1 ? '1 image' : `${d.images} images`}`, hint: d.images ? `Draft · ${d.images === 1 ? '1 image' : `${d.images} images`}` : 'Draft', onSelect: () => show(api.ai.newConversation(), (c) => (moveWidened(d.id, c.id), { chatDrafts: moveDraft(getState().chatDrafts, d.id, c.id), chatImages: moveImages(getState().chatImages, d.id, c.id) })) }))
            ]
          : []),
        // Listed by their latest activity, so a conversation continued today is near the top.
        ...(list.length ? [{ heading: 'Recent conversations' }, ...list.map((c) => ({ label: c.title, hint: activityHint(c.updatedAt, now), checked: c.id === conversation?.id, onSelect: () => show(api.ai.openConversation(c.id)) }))] : []),
        { separator: true },
        ...(list.length ? [{ label: 'Find, rename or remove…', icon: <Search />, onSelect: () => stillOpen() && setManaging({ opening, list }) }] : []),
        // Unsent drafts belong to the conversations being removed, so they go with them.
        { label: 'Clear history…', icon: <Trash2 />, danger: true, onSelect: () => void confirmDialog({ title: 'Clear AI conversation history?', body: 'Every AI conversation in this project is deleted, including this one and any message you haven’t sent yet.', details: [{ kind: 'keep', text: 'Changes the AI made to your site stay, and you can still undo them.' }, { kind: 'final', text: 'Deleted conversations can’t be brought back.' }], confirmLabel: 'Clear history', tone: 'danger', icon: 'delete' }).then((ok) => ok === true && stillOpen() && show(api.ai.clearHistory(opening), () => ({ chatDrafts: {}, chatImages: {} }))) }
      ],
      'Conversations'
    );
  };

  /** A new conversation that takes the unsent message (and its images) along, so nothing earlier goes with it. */
  const startFresh = () => {
    // A second activation before the first opens would find the message already moved, and open another empty one.
    if (!conversation || freshing.current) return;
    freshing.current = true;
    const from = conversation.id;
    const opened = api.ai.newConversation().finally(() => (freshing.current = false));
    show(opened, (c) => (moveWidened(from, c.id), { chatDrafts: moveDraft(getState().chatDrafts, from, c.id), chatImages: moveImages(getState().chatImages, from, c.id) }));
  };


  // What leaves this computer with a message. A server that is not this computer already says where content goes,
  // in its own warning above the box, so the note does not say it twice.
  const attachedImages = 'Attached images go by name and ID only.';
  // A thread usually stays with one model and one target, so each is said where it starts or changes, not on every
  // turn: the model under the first turn it handled and any turn that went elsewhere (every turn keeps it in its
  // details), and a request's target on the first request that names it.
  const modelShown = modelLines(msgs, next);
  const previousRequest: (ChatMessage | undefined)[] = [];
  let lastRequest: ChatMessage | undefined;
  msgs.forEach((m, i) => {
    if (m.role !== 'user') return;
    previousRequest[i] = lastRequest;
    lastRequest = m;
  });

  const privacy =
    provider?.id === 'local' && configured
      ? provider.warning
        ? attachedImages
        : `Page text and structure go to your local model, on this computer. ${attachedImages}`
      : `Page text and structure go to ${configured && provider ? provider.label : 'the provider you choose'}. ${attachedImages}`;

  return (
    <div className="chat">
      {/* Shown with or without a provider, so earlier conversations stay reachable after one is removed. */}
      {conversation && (
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
      {managing && managing.opening === snap.workspaceKey && (
        <ConversationsModal
          list={managing.list}
          opening={managing.opening}
          onClose={() => setManaging(null)}
          onOpened={(c) => {
            setManaging(null);
            setState({ conversation: c });
            focusComposer();
          }}
        />
      )}
      <div className="chat-body">
      <div
        className="chat-log"
        ref={logRef}
        role="log"
        aria-label="AI conversation"
        // The thread, message and run each piece belongs to, for a test to tell them apart (tests/driver/assistant.ts).
        data-conversation-id={conversation?.id}
        tabIndex={-1}
        // Scrolling by hand during a jump ends it, so the way back can show again.
        onWheel={() => (jumping.current = false)}
        onPointerDown={() => (jumping.current = false)}
        // Busy while the AI works, so its updates are read once they settle rather than piece by piece. A pause for a
        // question is not busy: the author is the one to act, and the question and its answer box sit outside the log.
        aria-busy={chatBusy(running, waiting)}
        onScroll={(e) => {
          const el = e.currentTarget;
          const below = el.scrollHeight - el.scrollTop - el.clientHeight;
          // One line decides both: at the end, new output follows; scrolled back past it, the reader stays put and
          // Jump to latest appears.
          nearBottom.current = below < FOLLOW_PX;
          // A smooth jump passes through positions above the end; the button stays gone until it lands.
          if (jumping.current && below < FOLLOW_PX) jumping.current = false;
          if (!jumping.current) setAway(below >= FOLLOW_PX);
        }}
      >
        {msgs.length === 0 && (
          // Quiet on purpose: it sits beside the user's own site. A ready panel anchors it to the composer the starters
          // fill; setting up or recovering, nothing is below it, so it sits at the top.
          <div className={`chat-empty${!configured || notReady ? ' top' : ''}`}>
            {/* A local model that failed its check leads with the problem, not with what the panel could do. */}
            {!notReady && (
            <div className="chat-empty-head">
              <h3>
                <Sparkles aria-hidden="true" />
                {askMode && configured ? 'Ask how your site works' : 'Describe a change to your site'}
              </h3>
              <p>{askMode && configured ? 'It answers without changing anything.' : 'You can undo anything it changes, like your own edits.'}</p>
            </div>
            )}
            {!configured ? (
              <button className="btn btn-primary" onClick={openSettings}>
                <KeyRound /> Connect an AI provider
              </button>
            ) : notReady ? (
              <div className="chat-not-ready" role="status">
                <div className="scope-note danger">
                  <CircleAlert />
                  <span>
                    <strong>{notReady.stage === 'chat' ? 'Your local model did not answer.' : "Can't use your local model server."}</strong> {notReady.message}
                  </span>
                </div>
                <button className="btn btn-primary" onClick={openSettings}>
                  <Settings2 /> Open AI settings
                </button>
              </div>
            ) : (
              // Starters prefill an empty composer; once you have written something they step aside rather than replace it.
              conversation &&
              suggestions.length > 0 && (
                <div className="suggestions" role="group" aria-labelledby="chat-starters-label">
                  {/* Says what a starter does, since many chats send one at a click: here it only fills the box. */}
                  <p className="suggestions-label" id="chat-starters-label">
                    Pick one to fill the box
                  </p>
                  {suggestions.slice(0, 3).map((s) => (
                    <button
                      key={s.text}
                      className="suggestion"
                      data-kind={s.kind}
                      onClick={() => {
                        // A starter about another page, a new page or the whole site needs more than this page, so it
                        // widens the chip to Whole site, where the change shows before anything is sent.
                        if (!askMode && !component && s.kind !== 'page' && s.kind !== 'selection' && chosen !== 'site') {
                          starterWidened.current.set(conversation.id, ctxOn.scope);
                          widenedHere.current = conversation.id;
                          widen();
                          setAnnounce(WIDENED_SAY);
                        }
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
            {!configured && <p className="chat-privacy">{privacy}</p>}
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === 'user' ? (
            <UserMessage key={m.id} m={m} previous={previousRequest[i]} />
          ) : (
            <AssistantMessage
              key={m.id}
              m={m}
              modelChanged={modelShown.has(m.id)}
              live={m.runId === activeRunId && running}
              awaiting={waiting}
              undoable={m.id === undoableId}
              reviewEntry={reviewEntryId(m, history, m.id === undoableId)}
              latest={i === msgs.length - 1}
              // Edit and try again puts a request back in the box, which waits until the current run is over.
              canCompose={configured && !pending && !sending}
              asking={asking}
              onUndo={undoTurn}
              onReview={reviewTurn}
              continueNote={configured && notice ? noticeId : undefined}
              onContinue={m.id === resumable && !sending && configured ? () => continueRequest(msgs[i - 1]) : undefined}
              onRetry={m.id === retryable && !sending && configured ? () => retryRequest(msgs[i - 1]) : undefined}
            />
          )
        )}
      </div>
      {/* Its own row under the log rather than over it, so it never covers the turn being read. */}
      {away && msgs.length > 0 && (
        <div className="chat-jump-row">
          <button className="chat-jump" onClick={jumpToLatest}>
            <ArrowDown aria-hidden="true" /> Jump to latest
          </button>
        </div>
      )}
      </div>
      {running && (
        <div className={`run-strip${waiting ? ' waiting' : ''}`} data-run-id={activeRunId ?? undefined}>
          {/* The one live indicator: it turns while the AI works and stops when it waits on you. */}
          <span className="run-icon" aria-hidden="true">
            {waiting ? <CircleHelp /> : <Spinner decorative />}
          </span>
          <span className="run-text">
            <span className="run-phase" title={phase}>
              {phase}
            </span>
            {stripDetail && (
              <span className="run-target" title={stripDetail}>
                {stripDetail}
              </span>
            )}
            {inFlight && (
              <span className="run-model">
                <span className="sr-only">Sent to </span>
                {turnModelText(inFlight)}
              </span>
            )}
          </span>
          {/* Stopping an edit puts the site back as it was before the request, so the button says so. Once it is
              stopping there is nothing left to press. */}
          {runStatus !== 'stopping' && (
            <span className="run-actions">
              <button
                className="btn btn-sm run-stop"
                title={runMode === 'ask' ? 'Stop this question' : 'Stop this request and undo its changes'}
                onClick={() => {
                  void api.ai.stop();
                  focusComposer();
                }}
              >
                <Square size={10} fill="currentColor" /> {runMode === 'ask' ? 'Stop' : 'Stop and undo'}
              </button>
            </span>
          )}
        </div>
      )}
      {configured && provider?.warning && (
        <div className="scope-note danger" role="status">
          <TriangleAlert />
          <span>{provider.warning}</span>
        </div>
      )}
      {handed && (
        <div className="scope-note held-request" role="status">
          <Component />
          <span>
            <span>
              {handed.held ? 'Waiting to send' : 'About to send'}: {handed.text}
            </span>{' '}
            {handed.held && (
              <button className="link" disabled={running || sending || !conversation} title={running ? 'Available when the current request finishes' : undefined} onClick={() => sendHanded(handed)}>
                Send
              </button>
            )}{' '}
            <button className="link" disabled={sending} onClick={() => setState({ chatRequest: null })}>
              Discard
            </button>
          </span>
        </div>
      )}
      {configured && notice && (
        <div className={`scope-note switch-note${notice.leavesComputer ? ' danger' : ''}`} role="status">
          {/* The danger notes' own glyph when messages leave this computer; otherwise it is information. */}
          {notice.leavesComputer ? <TriangleAlert /> : <Info />}
          <span>
            <span id={noticeId}>{switchNoticeText(notice)}</span>{' '}
            <button className="link" disabled={pending || sending} title={pending ? 'Available when the current request finishes' : 'Start a new conversation with your unsent message, without the earlier ones'} onClick={startFresh}>
              Start fresh
            </button>
          </span>
        </div>
      )}
      {/* Kept in place while a local model takes the message, so the note is announced when it appears. */}
      {localModel && (
        <div className="headroom-live" role="status">
          {headroom && (
            <div className="scope-note headroom-note">
              <TriangleAlert />
              <span>
                <span id={headroomId}>{headroom.text}</span>
                {headroom.kind !== 'history' ? (
                  <>
                    {' '}
                    <button className="link" onClick={openSettings}>
                      Open AI settings
                    </button>
                  </>
                ) : (
                  // The note about switching models, when it shows, already offers Start fresh.
                  !notice && (
                    <>
                      {' '}
                      <button className="link" disabled={pending || sending} title={pending ? 'Available when the current request finishes' : 'Start a new conversation with your unsent message, without the earlier ones'} onClick={startFresh}>
                        Start fresh
                      </button>
                    </>
                  )
                )}
              </span>
            </div>
          )}
        </div>
      )}
      {/* Shown whenever a question waits, even if the provider was changed meanwhile: the run still needs it. */}
      {asking && (
        // The question waiting for an answer sits by the composer, which answers it; a choice answers it in one click.
        <div className="question-card" role="group" aria-labelledby="ai-question-text" data-run-id={asking.runId} data-message-id={asking.messageId} data-question-id={asking.question.id}>
          <div className="question-text" id="ai-question-text">
            {asking.question.text}
          </div>
          {/* What yes allows is said before it is given, not only once the run has widened. */}
          {asking.question.widen && (
            <p className="question-scope" id="ai-question-scope">
              <Globe aria-hidden="true" /> Allowing it lets this request change the whole site.
            </p>
          )}
          {/* How to answer sits with the question, ahead of the options, so it is never scrolled out of sight. */}
          <p className="question-hint" id="ai-question-hint">
            {/* A picture opens larger and a labelled Choose answers, which the hint says in the same words everywhere. */}
            {questionHint(asking.question)}
            {answerElsewhere && inFlight ? ` Your answer goes to ${turnModelText(inFlight)}, which asked.` : ''}
            {draft.trim() || images.length ? ' Your unsent message is kept for afterwards.' : ''}
          </p>
          {/* Only the options scroll, so a long list never scrolls the question and its instructions out of sight. */}
          {(offeredImages(asking.question).length > 0 || asking.question.choices.length > 0) && (
            <div className="question-options">
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
            </div>
          )}
        </div>
      )}
      {configured || asking || draftFirst ? (
        // One box, written in first: the text, then one row of what goes with it. Answering, it is one row: the reply
        // and its Send. Anywhere in the box that is not a control puts the caret in the text.
        <div
          className={`composer${asking ? ' answering' : ''}`}
          onMouseDown={(e) => {
            const t = e.target as HTMLElement;
            if (t === taRef.current || t.closest('button, a, input, textarea, [role="menu"]')) return;
            e.preventDefault();
            const ta = taRef.current;
            if (!ta) return;
            ta.focus();
            // A press beside or below the text lands at its end, where the next words go.
            if (document.activeElement === ta) ta.setSelectionRange(ta.value.length, ta.value.length);
          }}
        >
          <textarea
            ref={taRef}
            value={composerText}
            placeholder={
              asking
                ? 'Type your answer…'
                : waiting
                  ? 'Waiting for the question…'
                  : running
                    ? 'Draft your next message…'
                    : // What it applies to is named on the chip under the text, so the prompt can simply ask.
                      askMode
                      ? 'What would you like to know?'
                      : 'What would you like to change?'
            }
            aria-label={asking ? 'Your answer' : 'Message'}
            aria-describedby={asking ? `ai-question-text${asking.question.widen ? ' ai-question-scope' : ''} ai-question-hint` : headroom ? headroomId : undefined}
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
          {/* What goes with the message, under it: what it applies to, then its images. While a question waits, the
              composer only answers it, and both come back afterwards. */}
          {!asking && (scopeNow || images.length > 0) && (
            <div className="composer-context">
              {scopeNow && (
                <>
                {scopeChoices.length > 1 ? (
                  <button
                    type="button"
                    className={`chip scope-chip${scopeTone}`}
                    title={`${scopeNow.title}. Change what ${askMode ? 'your question is about' : 'the AI may change'}`}
                    aria-label={scopeName}
                    aria-haspopup="menu"
                    aria-expanded={scopeMenu.isOpen}
                    onClick={(e) => openScopeMenu(e.currentTarget)}
                    onKeyDown={(e) => {
                      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                      e.preventDefault();
                      openScopeMenu(e.currentTarget, e.key === 'ArrowUp');
                    }}
                  >
                    {scopeNow.icon}
                    <span className="ellipsis">{scopeNow.chip}</span>
                    {scopeNow.where && <span className="scope-where ellipsis">{scopeNow.where}</span>}
                    <ChevronDown className="caret" aria-hidden="true" />
                  </button>
                ) : (
                  <span className={`chip scope-chip${scopeTone}`} title={scopeNow.title}>
                    <span className="sr-only">{askMode ? 'Your question is about: ' : 'What the AI may change: '}</span>
                    {scopeNow.icon}
                    <span className="ellipsis">{scopeNow.chip}</span>
                    {scopeNow.where && <span className="scope-where ellipsis">{scopeNow.where}</span>}
                  </span>
                )}
                </>
              )}
              <ImageChips
                images={images.map((id) => {
                  const a = st.assets.assets[id];
                  return { assetId: id, name: (a?.kind === 'image' && typeof a.name === 'string' && a.name.trim()) || id };
                })}
                label="Images in your next message"
                onRemove={(id) => {
                  if (!conversation) return;
                  setState({ chatImages: withImages(getState().chatImages, conversation.id, imagesFor(getState().chatImages, conversation.id).filter((x) => x !== id)) });
                  focusComposer();
                }}
              />
            </div>
          )}
          <div className="composer-foot">
            {!asking && (
              // Edit or Ask, as one quiet menu button: the current mode is on it, the other one a click away.
              <button
                type="button"
                className={`btn btn-sm btn-ghost composer-mode${askMode ? ' ask' : ''}`}
                title={askMode ? 'Ask: a read-only question. The AI reads the site and changes nothing.' : 'Edit: the AI makes the changes you describe.'}
                aria-label={`What your next message does: ${askMode ? 'Ask, a read-only question' : 'Edit'}`}
                aria-haspopup="menu"
                aria-expanded={modeMenu.isOpen}
                onClick={(e) => openModeMenu(e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                  e.preventDefault();
                  openModeMenu(e.currentTarget, e.key === 'ArrowUp');
                }}
              >
                {askMode ? <MessageCircleQuestionMark /> : <Pencil />}
                {askMode ? 'Ask' : 'Edit'}
                <ChevronDown className="caret" aria-hidden="true" />
              </button>
            )}
            {next && !asking && (
              // The model for the next message, which may differ from the one a running turn went to. The model is the
              // part that changes between requests, so it gets the room; the provider is in its name and title.
              <button
                className="btn btn-sm btn-ghost composer-model"
                title={`Next message: ${recipientText(next)}. Change AI provider or model`}
                aria-label={`${pending ? 'Next: ' : 'Next message: '}${next.id ? `${next.label}, ${PROVIDER_LABELS[next.provider]}` : PROVIDER_LABELS[next.provider]}. Change AI provider or model`}
                aria-haspopup="dialog"
                onClick={openSettings}
              >
                <span className="label">
                  {/* Shown while a running turn has a model of its own; always said out loud. */}
                  {pending ? 'Next: ' : ''}
                  {next.id ? next.label : PROVIDER_LABELS[next.provider]}
                </span>
                <Settings2 size={12} />
              </button>
            )}
            <span className="grow" />
            {!asking && hasLibraryImages && (
              // Library images join the message in one click, by name and ID; Assets is a click further for browsing.
              <button type="button" className="icon-btn sm composer-attach" title="Add images from Assets" aria-label="Add images from Assets" aria-haspopup="menu" aria-expanded={attachMenu.isOpen}
                onClick={(e) => addImages(e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                  e.preventDefault();
                  addImages(e.currentTarget, e.key === 'ArrowUp');
                }}
              >
                <ImagePlus />
              </button>
            )}
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
      ) : null}
      {/* What leaves the computer, said once under the box before the first message. */}
      {configured && msgs.length === 0 && <p className="chat-privacy chat-footnote">{privacy}</p>}
      {!configured && !asking && (
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
      {attachMenu.node}
      {scopeMenu.node}
      {modeMenu.node}
      {createPortal(
        <div className="sr-only" role="status" aria-live="polite">
          {announce}
        </div>,
        document.body
      )}
    </div>
  );
}

/** What a request was about, as its caption says it: a question, and what the AI was allowed to change. */
function captionOf(m: ChatMessage | undefined, state: ProjectState | undefined): string {
  if (!m) return '';
  const ask = m.context?.mode === 'ask';
  return [ask ? 'Question · read only' : '', scopeOf(m.context, state)].filter(Boolean).join(' · ');
}

/**
 * A request, with what it was about under it. Follow-ups about the same thing do not repeat it: the caption shows on
 * the first request of a run about one target and wherever the target changes, and is always read out.
 */
function UserMessage({ m, previous }: { m: ChatMessage; previous?: ChatMessage }) {
  const state = useStore((s) => s.snapshot?.state);
  const caption = captionOf(m, state);
  // The same words can name two different elements ("Home → Heading"), so the target itself must match too.
  const repeated = !!caption && caption === captionOf(previous, state) && requestTarget(m) === requestTarget(previous);
  const images = Array.isArray(m.images) ? m.images.filter((i) => typeof i?.assetId === 'string' && typeof i.name === 'string') : [];
  return (
    <div className="msg-user" data-message-id={m.id}>
      {/* Who said it, for a reader who meets the log without its layout. */}
      <span className="sr-only">You: </span>
      {typeof m.text === 'string' ? m.text : ''}
      {images.length > 0 && <ImageChips images={images} label="Attached images" />}
      {caption && <span className={repeated ? 'sr-only' : 'ctx'}>{repeated ? ` (${caption})` : caption}</span>}
    </div>
  );
}

function Steps({ items, waiting, stopped, recent }: { items: ChatActivity[]; waiting?: boolean; stopped?: boolean; recent?: number }) {
  const [all, setAll] = useState(false);
  // Folding a single step saves nothing, so at least two fold or none do.
  const extra = recent && items.length > recent + 1 ? items.length - recent : 0;
  const hidden = all ? 0 : extra;
  return (
    <ul className="activity-list" aria-label="Steps">
      {extra > 0 && (
        <li className="activity earlier">
          <button className="steps-earlier" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? 'Hide earlier steps' : `Show ${extra} earlier ${extra === 1 ? 'step' : 'steps'}`}
            <ChevronDown aria-hidden="true" />
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

/** The model a finished turn went to, as its details say it. */
function HandledBy({ recipient }: { recipient: TurnModel }) {
  return (
    <p className="turn-handled">
      <Cpu aria-hidden="true" />
      <span>
        {recipient.unanswered ? 'Sent to ' : 'Handled by '}
        {turnModelText(recipient)}
      </span>
    </p>
  );
}

/**
 * A finished turn that changed nothing, left nothing unfinished and found nothing to act on: an answer, read as one.
 * Its words lead with no card around them; under them, one quiet line says the site is unchanged and opens what the
 * turn did on the way (its steps, any passed checks, the model).
 */
function Reply({ m, recipient, children }: { m: ChatMessage; recipient: TurnModel | null; children?: ReactNode }) {
  const history = useStore((s) => s.snapshot?.history);
  const turn = turnState(m, history)!;
  const r = turn.result;
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const steps = m.activities ?? [];
  const { passes } = checksOf(r);
  const locations = storedLocations(r.locations);
  const head = outcome(r);
  const hasDetails = steps.length > 0 || passes.length > 0 || !!recipient;
  const label = (
    <>
      <span className="reply-icon" aria-hidden="true">
        {head.icon}
      </span>
      <span className="reply-label">{head.label}</span>
    </>
  );
  return (
    <div className="reply" data-status={r.status}>
      {/* What was asked on the way comes first, so the answer it led to reads after it. */}
      {children && <div className="result-answers">{children}</div>}
      <div className="reply-text">
        <Md text={summaryOf({ ...r, summary: summaryNow(turn) })} />
      </div>
      {locations.length > 0 && <Locations list={locations} />}
      <div className="reply-foot">
        {hasDetails ? (
          <button className="reply-toggle" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}>
            {label}
            {steps.length > 0 && (
              <span className="reply-count">
                <span aria-hidden="true"> · </span>
                <span className="sr-only">, </span>
                {steps.length} {steps.length === 1 ? 'step' : 'steps'}
              </span>
            )}
            <ChevronDown className="caret" aria-hidden="true" />
          </button>
        ) : (
          <span className="reply-outcome">{label}</span>
        )}
      </div>
      {open && (
        <div id={detailsId} className="reply-details">
          {steps.length > 0 && <Steps items={steps} />}
          {passes.length > 0 && (
            <ul className="checks" aria-label="Checks passed">
              {passes.map((v, i) => (
                <li key={i}>
                  <Check aria-hidden="true" />
                  <span>{v}</span>
                </li>
              ))}
            </ul>
          )}
          {recipient && <HandledBy recipient={recipient} />}
        </div>
      )}
    </div>
  );
}

/** The fields an answer points to, each with the way to open it. */
function Locations({ list }: { list: FieldLocation[] }) {
  return (
    <ul className="locations" aria-label="Where to change it">
      {list.map((l, i) => (
        <li key={i}>
          <span className="location-path">{l.path.join(' → ')}</span>
          <button className="btn btn-sm" onClick={() => openLocation(l)} title={`Open ${l.path.at(-1)} in the Inspector`}>
            <SlidersHorizontal /> Open in inspector
          </button>
        </li>
      ))}
    </ul>
  );
}

function AssistantMessage({
  m,
  modelChanged,
  live,
  awaiting,
  undoable,
  reviewEntry,
  latest,
  canCompose,
  asking,
  onUndo,
  onReview,
  onContinue,
  onRetry,
  continueNote
}: {
  m: ChatMessage;
  /** The first turn of the thread to go to its model, or one that went to another model than the turn before. */
  modelChanged?: boolean;
  live: boolean;
  awaiting: boolean;
  undoable: boolean;
  /** The turn's History step, which the card offers to review there. */
  reviewEntry?: string;
  latest: boolean;
  canCompose: boolean;
  asking: WaitingQuestion | null;
  onUndo: (runId: string) => void;
  onReview: (entryId: string) => void;
  onContinue?: () => void;
  onRetry?: () => void;
  continueNote?: string;
}) {
  const r = m.result;
  const activities = m.activities ?? [];
  // A live turn of a run that waits for the author is paused: nothing in it spins, whichever message holds the
  // question, because the status and the question message arrive separately.
  const waitingHere = isPaused(asking, m.id, live, awaiting);
  // Every question of the turn stays with it, in order, with its answer.
  const questions = shownQuestions(m, asking);
  // A live turn lists the steps already taken; the step under way is named once, in the run strip.
  const taken = live ? activities.filter((a) => a.status !== 'running') : activities;
  const answers = questions.map((q) => {
    // A picture chosen from the offer is shown with its name, told apart from any other offered with the same one.
    const offered = offeredImages(q);
    const picked = q.answeredAssetId ? offered.find((i) => i.assetId === q.answeredAssetId) : undefined;
    return (
      <div key={q.key} className={`answered${q.answered === undefined ? ' unanswered' : ''}`}>
        <span className="answered-q">{q.text}</span>
        {picked ? (
          <span className="answered-image">
            You chose: <ImageChips images={[picked]} among={offered} label="The image you chose" />
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
  });
  // The model this turn went to, as fixed when it started; old transcripts and turns that never reached one show none.
  const recipient = turnRecipient(m);
  const reply = !!r && answerOnly(r, !!(onContinue || onRetry));
  // Said under the turn where the thread starts with a model or moves to another, and where the turn has no details to
  // hold it; otherwise it is in the turn's details. A running turn's model is in the run strip.
  const modelLine = !!r && !!recipient && (modelChanged || (!reply && !(m.activities ?? []).length));
  return (
    <div className="msg-ai" aria-busy={chatBusy(live, waitingHere)} data-message-id={m.id} data-run-id={m.runId}>
      <span className="sr-only">AI: </span>
      {!r && taken.length > 0 && <Steps items={taken} waiting={waitingHere} recent={4} />}
      {!r && m.text && (
        <div className="text">
          <Md text={m.text} />
        </div>
      )}
      {/* Getting started is said in the run strip, the one place a run's progress is shown. */}
      {!r && answers}
      {/* A finished turn that changed nothing is its answer; any other is one card that leads with its result. What was
          asked and answered on the way sits inside either. */}
      {r && reply && (
        <Reply m={m} recipient={modelLine ? null : recipient}>
          {answers.length > 0 ? answers : null}
        </Reply>
      )}
      {r && !reply && (
        <ResultCard m={m} recipient={modelLine ? null : recipient} undoable={undoable} reviewEntry={reviewEntry} latest={latest} canCompose={canCompose} onUndo={onUndo} onReview={onReview} onContinue={onContinue} onRetry={onRetry} continueNote={continueNote}>
          {answers.length > 0 ? answers : null}
        </ResultCard>
      )}
      {modelLine && recipient && (
        <div className="turn-model">
          <Cpu aria-hidden="true" />
          <span>
            <span className="sr-only">{r && !recipient.unanswered ? 'Handled by ' : 'Sent to '}</span>
            {turnModelText(recipient)}
          </span>
        </div>
      )}
    </div>
  );
}

/** The located fields of a result read back from disk: anything malformed is left out, never shown broken. */
function storedLocations(list: unknown): FieldLocation[] {
  if (!Array.isArray(list)) return [];
  const text = (v: unknown) => typeof v === 'string';
  return list.filter((l): l is FieldLocation => {
    if (!l || typeof l !== 'object') return false;
    const x = l as Partial<FieldLocation>;
    const owner = !!x.owner && text(x.owner.id) && (x.owner.kind === 'page' || (x.owner.kind === 'shell' && (x.owner.id === 'header' || x.owner.id === 'footer')));
    const item = x.itemId === undefined ? x.field === undefined : text(x.itemId) && text(x.field);
    return owner && item && text(x.nodeId) && text(x.prop) && Array.isArray(x.path) && x.path.length > 0 && x.path.every(text);
  });
}

/**
 * Open a located field where it is now: its page, its component selected in the Inspector, the list item open
 * and the field focused. Nothing in the site changes. A field that has gone is said so, and nothing moves.
 */
function openLocation(l: FieldLocation) {
  const s = getState();
  const st = s.snapshot?.state;
  if (!st || !s.snapshot) return;
  const target = locationTarget(st, s.pageId, l);
  if ('error' in target) return toast(target.error, 'info');
  selectPage(target.pageId);
  setState({
    selection: target.selection,
    mode: 'edit',
    rightTab: 'inspect',
    dockOpen: true,
    inspectorFocus: inspectorFocusRequest({ opening: s.snapshot.workspaceKey, owner: target.selection.owner, nodeId: l.nodeId, prop: l.prop, ...(l.itemId !== undefined ? { itemId: l.itemId, field: l.field } : l.field !== undefined ? { field: l.field } : {}), label: l.path.at(-1) ?? 'That field' })
  });
}

/** Show a change: its page, then the element if it is still there. */
function openChange(c: ChatChange) {
  const st = getState().snapshot?.state;
  if (!st) return;
  const target = changeTarget(st, getState().pageId, c);
  if (!target) return;
  if ('error' in target) return toast(target.error, 'info');
  // The element changed, or the page itself when the change was to the page or the element has gone.
  selectPage(target.pageId, target.selection);
  if (target.note) toast(target.note, 'info');
}

function ResultCard({
  m,
  recipient,
  undoable,
  reviewEntry,
  latest,
  canCompose,
  onUndo,
  onReview,
  onContinue,
  onRetry,
  continueNote,
  children
}: {
  m: ChatMessage;
  /** The model the turn went to, said in its steps when it is not said under the turn. */
  recipient?: TurnModel | null;
  undoable: boolean;
  reviewEntry?: string;
  latest: boolean;
  canCompose: boolean;
  onUndo: (runId: string) => void;
  onReview: (entryId: string) => void;
  onContinue?: () => void;
  onRetry?: () => void;
  /** The note Continue and Try again are read with: what goes with them, when that is news to the model. */
  continueNote?: string;
  children?: ReactNode;
}) {
  const history = useStore((s) => s.snapshot?.history);
  // The turn as it was said, and where its change stands now: History's to say, however it was undone or redone.
  const turn = turnState(m, history)!;
  const r = turn.result;
  const devMode = useStore((s) => !!s.settings?.developerMode);
  const [open, setOpen] = useState(false);
  const stepsId = useId();
  /** Project history holds the turn's change as undone now, from chat, the toolbar or History alike (issue 276). */
  const reverted = turn.standing === 'undone';
  // Only the conversation's latest turn is ever continued, so only it is told how. Its Undo turn going once later
  // changes came after it is said too, beside the way to review it (issue 164).
  const note = standingNote(m, history, latest) ?? reviewNote(m, history, latest, !!reviewEntry);
  const reviewId = useId();
  const head = turn.undoneEarlier ? { icon: <RotateCcw />, label: 'Undone earlier' } : outcome(r);
  const steps = m.activities ?? [];
  const stopped = r.status === 'cancelled';
  /** The run's own changes were rolled back as it ended. */
  const failedOrStopped = r.status === 'failed' || r.status === 'cancelled';
  // A turn undone from project history keeps its record, with its changes listed as undone.
  const undone = failedOrStopped || reverted;
  // Results saved before `repair` existed name a rejected key only in their wording.
  // Only the latest turn asks for a repair: once a later request has gone through, the setup it named works again.
  const repair = latest ? (r.repair ?? (r.error && /API key/i.test(r.summary) ? 'key' : undefined)) : undefined;
  const openAiSettings = () => setState({ modal: { kind: 'settings', tab: 'ai' } });
  const { issues, unverified, passes } = checksOf(r);
  const locations = storedLocations(r.locations);
  const [showPasses, setShowPasses] = useState(false);
  const [showReport, setShowReport] = useState(false);
  // What the final checks found, said beside the outcome so a finished turn never reads cleaner than it was.
  // Once project history holds a turn as undone, that is its outcome; what it reported stays below as its record. Its
  // check counts are left off the header, since they describe changes that are no longer there.
  const shown = reverted ? { icon: <RotateCcw />, label: 'Undone · its changes were reverted' } : head;
  const qualifiers = (
    reverted
      ? []
      : [
          issues.length ? { key: 'issue', text: `${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}` } : null,
          unverified.length ? { key: 'unverified', text: `${unverified.length} not checked` } : null
        ]
  ).filter((q): q is { key: string; text: string } => !!q);
  // An older turn that went cleanly and offers nothing to do steps back, so a long thread scans faster: its routine
  // passed checks move into its steps.
  const settled = !latest && !reverted && (r.status === 'completed' || r.status === 'no-changes') && !r.incomplete && !issues.length && !unverified.length && !undoable && !onContinue;
  // An older stopped or undone turn is history too: it keeps its retry, on the same quiet card.
  const quiet = settled || (!latest && ((failedOrStopped && !repair) || reverted));
  // Only the latest turn keeps its passed checks in view; on an older one they wait in its steps.
  const foldPasses = (settled || (!latest && !reverted)) && steps.length > 0;
  // A failed, stopped or undone turn can be tried again from its original request, while there is a composer to write in.
  const retryable = (failedOrStopped || reverted) && canCompose;
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
      const ok = await confirmDialog({
        title: 'Replace your draft?',
        body: 'The original request goes back into the message box, so you can edit it and try again.',
        details: [
          { kind: 'lose', text: typed && typed !== original?.trim() ? (otherImages ? 'The message you’re writing now, and its images, are replaced.' : 'The message you’re writing now is replaced.') : 'The images attached to your message now are replaced.' },
          { kind: 'final', text: 'What’s replaced can’t be brought back.' }
        ],
        confirmLabel: 'Replace draft',
        tone: 'caution',
        icon: 'replace'
      });
      // The request goes back into the conversation it came from, and only while that one is still open.
      if (ok !== true || getState().conversation?.id !== conv.id) return;
    }
    const i = conv.messages.findIndex((x) => x.id === m.id);
    const user = conv.messages[i - 1];
    if (user) {
      // Retry with the original target: same page, same component edited everywhere and same selection, not
      // whatever is selected now. Each is checked against the project as it is now; a target that has since been
      // deleted is dropped rather than restored, and the note below asks for a new one.
      const ctx = user.context;
      const s = getState();
      const st = s.snapshot?.state;
      const view = st ? retryView(st, ctx, { pageId: s.pageId, definitionMode: s.definitionMode }) : null;
      // A request about a post goes back to that post, in the writer, before the request goes back into the box: one the
      // writer cannot leave yet (text it could not save) stays open, and the box keeps what it holds.
      if (view?.post && !(await openPost(view.post.collectionId, view.post.entryId))) return;
      // Anything written into the box while the open post was saving is the author's own: it is never replaced unasked.
      if (view?.post && (draftFor(getState().chatDrafts, conv.id).trim() !== typed || imagesFor(getState().chatImages, conv.id).join('\n') !== attached.join('\n')))
        return void toast('The post is open. What you wrote meanwhile is kept, so the earlier request was not put back.', 'info');
      // A request about a page leaves the Posts workspace or the SEO view, and a collection's layout behind it, whose
      // post, view or layout would otherwise stay in front of the page it is about.
      const covering = activeWorkspace(getState());
      const previewing = postWorkspace(getState()) === 'preview';
      const leavePosts =
        ctx?.post === undefined && covering
          ? { ...(getState().leftTab === 'posts' || getState().leftTab === 'seo' ? { leftTab: 'pages' as const } : {}), ...(previewing ? { mode: 'edit' as const } : {}), ...(getState().templateMode && !view?.definitionMode ? { templateMode: null } : {}) }
          : {};
      setState({
        ...leavePosts,
        chatDrafts: withDraft(getState().chatDrafts, conv.id, user.text),
        chatImages: withImages(getState().chatImages, conv.id, originalImages),
        // Editing a component everywhere happens in Edit, never in Preview.
        ...(view ? { ...(view.pageId ? { pageId: view.pageId } : {}), definitionMode: view.definitionMode, ...(view.definitionMode ? { mode: 'edit' as const } : {}) } : {}),
        selection: view?.selection ?? null,
        // As far as it reached when it was sent: its element, its page, or the whole site.
        chatContextEnabled: { page: true, scope: view?.scope ?? 'selection' },
        // Tried again as it was sent: a question stays a question.
        chatMode: ctx?.mode === 'ask' ? 'ask' : 'edit'
      });
      // Kept with the draft it comes back with, so reopening the project cannot send it the other way.
      saveLocal({ chatMode: ctx?.mode === 'ask' ? 'ask' : 'edit' });
      if (view?.missing) toast(`${view.missing} is no longer in the site. Choose what to change, then send again.`, 'info');
    }
    requestAnimationFrame(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.composer textarea');
      sizeToFit(ta);
      ta?.focus();
    });
  };
  return (
    <div className={`result-card ${r.status}${quiet ? ' settled' : ''}${reverted ? ' reverted' : ''}`}>
      <div className="result-head">
        <span className="result-icon" aria-hidden="true">
          {shown.icon}
        </span>
        <span className="result-heading">
          <span className="result-title">{shown.label}</span>
          {qualifiers.length > 0 && (
            <span className="result-qualifiers">
              {qualifiers.map((q, i) => (
                <span key={q.key} className={`result-qualifier ${q.key}`}>
                  {i > 0 && <span aria-hidden="true"> · </span>}
                  <span className="sr-only">, </span>
                  {q.key === 'issue' && <TriangleAlert aria-hidden="true" />}
                  {q.text}
                </span>
              ))}
            </span>
          )}
        </span>
        {r.usage && devMode && <span className="result-usage">{(r.usage.inputTokens + r.usage.outputTokens).toLocaleString()} tokens</span>}
        {steps.length > 0 && (
          <button className="steps-toggle" aria-expanded={open} aria-controls={stepsId} onClick={() => setOpen(!open)}>
            {steps.length} {steps.length === 1 ? 'step' : 'steps'}
            <ChevronDown />
          </button>
        )}
      </div>
      {open && (
        <div id={stepsId} className="result-steps">
          <Steps items={steps} stopped={stopped} />
          {foldPasses && passes.length > 0 && (
            <ul className="checks" aria-label="Checks passed">
              {passes.map((v, i) => (
                <li key={i}>
                  <Check aria-hidden="true" />
                  <span>{v}</span>
                </li>
              ))}
            </ul>
          )}
          {recipient && <HandledBy recipient={recipient} />}
        </div>
      )}
      <div className="result-body">
        {/* Undone: what was reverted leads, and what the turn reported at the time is kept one click away, so an old
            success or warning is never read as describing the site now. */}
        {reverted && (
          <>
            {r.changes.length > 0 && (
              <div className="result-section">
                <span className="result-label">Reverted</span>
                <ul aria-label="Changes that were reverted">
                  {r.changes.map((c, i) => (
                    <li key={i} className="faint">
                      {changeText(c).label}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {/* Whether it can still be continued is about the site now, so it is not tucked away with the old report. */}
            {note && <p id={reviewId} className="result-standing">{note}</p>}
            <button className="checks-toggle report-toggle" aria-expanded={showReport} onClick={() => setShowReport(!showReport)}>
              Before the undo
              <ChevronDown aria-hidden="true" />
            </button>
          </>
        )}
        {(!reverted || showReport) && (
        <>
        <div className="result-summary">
          <Md text={summaryOf({ ...r, summary: summaryNow(turn) })} />
        </div>
        {!reverted && note && <p id={reviewId} className="result-standing">{note}</p>}
        {locations.length > 0 && <Locations list={locations} />}
        {issues.length + unverified.length > 0 && (
          <ul className="checks" aria-label="Checks that need attention">
            {/* Anything that needs attention comes before the list of changes. */}
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
          </ul>
        )}
        {r.changes.length > 0 &&
          !reverted &&
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
            <div className="result-section">
            {/* A conflicted turn kept its changes for the author: they are what to review, so they are labelled that way. */}
            {r.status === 'conflicted' && <span className="result-label">Kept for your review</span>}
            <ul className="changes" aria-label={r.status === 'conflicted' ? 'Changes kept for your review' : 'Changes'}>
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
            </div>
          ))}
        {passes.length > 0 && !foldPasses && (
          <ul className="checks" aria-label="Checks passed">
            {/* Routine passes fold into one line. */}
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
        </>
        )}
        {children && <div className="result-answers">{children}</div>}
      </div>
      {/* Retrying puts the request back in the composer, so it is offered only while there is one to write in. */}
      {((r.canUndo && undoable) || reviewEntry || retryable || repair || onContinue || onRetry) && (
        <div className="result-foot">
          {onContinue && (
            // Continue sends a new message at once: what goes with it, when that is news to the model, is read with it.
            <button className="btn btn-sm btn-primary" onClick={onContinue} aria-describedby={continueNote}>
              <Play /> Continue
            </button>
          )}
          {repair === 'key' && (
            <button className="btn btn-sm btn-primary" onClick={openAiSettings}>
              <KeyRound /> Update API key
            </button>
          )}
          {repair === 'settings' && (
            <button className="btn btn-sm btn-primary" onClick={openAiSettings}>
              <Settings2 /> Open AI settings
            </button>
          )}
          {/* The same request again, once the setup is fixed: nothing to retype. It too is sent at once, so it is read
              with the same note as Continue. */}
          {onRetry && (
            <button className="btn btn-sm" onClick={onRetry} aria-describedby={continueNote}>
              <RefreshCw /> Try again
            </button>
          )}
          {r.canUndo && undoable && (
            <button className="btn btn-sm" onClick={() => onUndo(m.runId!)}>
              <RotateCcw /> Undo turn
            </button>
          )}
          {/* An earlier turn is reviewed in History: what it changed, what came after it, and the safe way to undo it. */}
          {reviewEntry && (
            <button className="btn btn-sm" onClick={() => onReview(reviewEntry)} aria-describedby={note ? reviewId : undefined}>
              <History /> Review in history
            </button>
          )}
          {retryable && (
            <button className="btn btn-sm" onClick={() => void retry()}>
              <Pencil /> Edit and try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}

