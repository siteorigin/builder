import './SharePopover.css';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Copy, FileText, Lock, Radio, RefreshCw, Users, X } from 'lucide-react';
import type { LiveHostState, LiveRun } from '@shared/api';
import type { GuestRole } from '@shared/live/limits';
import { SESSION_DURATIONS, type SessionDuration } from '@shared/live/expiry';
import { LIVE_AI_TURN_LIMITS } from '@shared/live/ai';
import { api, confirmDialog, getState, setState, useStore } from '../store';
import { openMenus, Segmented, Spinner, SwitchRow, useDialogOpen, useMenu } from '../components/ui';
import { cancelStart, copiedAtStart, copyInvite, liveCommand, onStartCopied, shownLive, startLive } from '../lib/live-host';
import { selectPage } from '../lib/actions';
import { livePeers, peerColor } from '../lib/live-marks';
import { presenceWhere } from '../lib/remote-view';
import { freshPress, JoinAnswers, namesOf, OUTCOME_WORDS, outcomeOf, sendAnswer, SETTLE_AFTER_MS, SETTLE_MS, unanswered, useAnswers, useBusy, useJoined, type Answer, type Outcome } from '../components/JoinRequests';
import {
  admittedGuests,
  clockDay,
  clockTime,
  DURATION_CHOICES,
  extendChoices,
  formatSpan,
  guestExpiryChoices,
  guestTimeLeft,
  hasRoom,
  livePill,
  liveRun,
  OFFERED_ROLES,
  relayNow,
  remainingMs,
  ROLE_LABELS,
  spanWords,
  tickMs,
  waitingGuests,
  type AdmittedGuest,
  type LiveRoomState,
  type WaitingGuest
} from '../lib/live-session';

/**
 * The relay's time now, redrawn as the time left changes: every minute, and every second in the session's last one.
 * Nothing ticks while there is no room.
 */
function useRelayNow(live: LiveHostState): number {
  const clock = useStore((s) => s.liveClock);
  const [, tick] = useState(0);
  const at = clock ? relayNow(clock) : Date.now();
  const room = hasRoom(live) ? live : null;
  useEffect(() => {
    if (!room || !clock) return;
    const timer = setTimeout(() => tick((n) => n + 1), tickMs(room, relayNow(clock)));
    return () => clearTimeout(timer);
  });
  return at;
}

/** The Share button in the toolbar, its pill while a session runs, and the popover it opens. */
export function ShareControl({ compact }: { compact?: boolean }) {
  const live = useStore(shownLive);
  const open = useStore((s) => s.shareOpen);
  const at = useRelayNow(live);
  // Those still to be answered: a request answered (here or from the notice) is off the count until it is offered again.
  const answers = useAnswers();
  const waiting = unanswered(waitingGuests(live), answers).length;
  const pill = livePill(live, at, waiting);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const people = hasRoom(live) ? admittedGuests(live).length : 0;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`btn btn-sm share-btn ${pill.kind}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={pill.label}
        title={pill.label.replace(/^Share: /, '')}
        onClick={() => setState({ shareOpen: !open })}
      >
        {pill.kind === 'busy' ? (
          <Spinner decorative />
        ) : pill.kind === 'idle' ? (
          <Users aria-hidden="true" />
        ) : pill.kind === 'reconnecting' ? (
          <RefreshCw aria-hidden="true" className="live-glyph" />
        ) : (
          <Radio aria-hidden="true" className="live-glyph" />
        )}
        {(!compact || pill.kind !== 'idle') && <span className="share-text">{pill.text}</span>}
        {hasRoom(live) && live.locked && <Lock aria-hidden="true" className="share-lock" />}
        {(pill.kind === 'live' || pill.kind === 'reconnecting') && people > 0 && (
          <span className="share-count" aria-hidden="true">
            <Users />
            {people}
          </span>
        )}
        {waiting > 0 && (
          <span className="share-badge" aria-hidden="true">
            {waiting}
          </span>
        )}
      </button>
      {open && <SharePopover id={id} live={live} at={at} trigger={trigger} />}
    </>
  );
}

type Box = { left: number; top: number };

/**
 * Whether the host's last press was a key rather than the pointer, read while the popover is open. Focus handed on as
 * a row goes is brought into view for the keyboard only: scrolling the lists under a pointer would put another row
 * beneath it. (`:focus-visible` cannot tell after a chain of focus moves made by script.)
 */
const lastPress = { key: false };
const intoView = (el: HTMLElement) => lastPress.key && el.scrollIntoView?.({ block: 'nearest' });

function SharePopover({ id, live, at, trigger }: { id: string; live: LiveHostState; at: number; trigger: React.RefObject<HTMLButtonElement | null> }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Box | null>(null);
  // A question it asks (End session, Remove) opens the app's dialog over it: it waits under the scrim, inert, and stops
  // holding the editor's keys as a menu would, so the dialog has them all; `askFrom` puts focus back on the button.
  const asking = useDialogOpen();
  useEffect(() => {
    if (!asking) return;
    openMenus.count--;
    return () => void openMenus.count++;
  }, [asking]);
  const close = (back: boolean) => {
    setState({ shareOpen: false });
    if (back) requestAnimationFrame(() => trigger.current?.focus());
  };
  // The editor's own shortcuts stay out of the way while it is open, as for a menu; focus starts on its first control.
  useEffect(() => {
    openMenus.count++;
    const first = box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? box.current?.querySelector<HTMLElement>('button, input, select');
    first?.focus({ preventScroll: true });
    lastPress.key = false;
    const key = () => (lastPress.key = true);
    const pointer = () => (lastPress.key = false);
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', pointer, true);
    return () => {
      openMenus.count--;
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', pointer, true);
    };
  }, []);
  // A press anywhere else puts it away and goes where it was meant to; the Share button toggles it itself.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target instanceof Node ? e.target : null;
      if (!t || box.current?.contains(t) || trigger.current?.contains(t)) return;
      // A menu it opened (Extend) is part of it, and so is a question it asked.
      if (t instanceof Element && t.closest('[role="menu"], .overlay-backdrop')) return;
      setState({ shareOpen: false });
    };
    // A press in the preview frame never reaches this document: focus going into it puts the popover away too.
    const intoFrame = () => setTimeout(() => document.activeElement instanceof HTMLIFrameElement && setState({ shareOpen: false }));
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('blur', intoFrame);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('blur', intoFrame);
    };
  }, [trigger]);
  // Below the Share button, its right edge with the button's, kept 8px inside the window.
  useLayoutEffect(() => {
    const place = () => {
      const el = box.current;
      const a = trigger.current?.getBoundingClientRect();
      if (!el || !a) return;
      const w = el.offsetWidth;
      const left = Math.max(8, Math.min(a.right - w, window.innerWidth - w - 8));
      const top = a.bottom + 6;
      setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  });
  // A row that goes while focus is in it (a guest let in, declined, or gone) hands focus to the next thing in the popover.
  const hadFocus = useRef(false);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!hadFocus.current || (active && active !== document.body)) return;
    const el = box.current;
    if (!el) return;
    // The next guest waiting, else the roster, else the popover's first control: in that order, brought into view.
    const next = ['.live-waiting .live-answers button:not(:disabled)', '.live-roster select:not(:disabled)', '[data-autofocus]'].map((q) => el.querySelector<HTMLElement>(q)).find(Boolean) ?? el;
    next.focus({ preventScroll: true });
    intoView(next);
  });
  return createPortal(
    <div
      ref={box}
      id={id}
      className={`share-popover${asking ? ' behind' : ''}`}
      inert={asking}
      role="dialog"
      aria-labelledby={`${id}-title`}
      tabIndex={-1}
      style={pos ?? { right: 8, top: 52, opacity: 0 }}
      onFocus={() => (hadFocus.current = true)}
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null;
        // Focus that went nowhere (a row removed under it) stays the popover's to place.
        if (!to || e.currentTarget.contains(to)) return;
        hadFocus.current = false;
        // Tabbing or clicking away into the editor puts it away, so the editor's shortcuts work again; the Share button
        // and the Extend menu it opened are part of it.
        if (!trigger.current?.contains(to) && !(to instanceof Element && to.closest('[role="menu"], .overlay-backdrop'))) setState({ shareOpen: false });
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }}
    >
      <div className="share-head">
        <h2 id={`${id}-title`}>{hasRoom(live) || live.phase === 'stopping' ? 'Live session' : 'Share a live session'}</h2>
        <button type="button" className="icon-btn" aria-label="Close" title="Close" onClick={() => close(true)}>
          <X />
        </button>
      </div>
      {live.phase === 'idle' ? <StartView /> : hasRoom(live) ? <RoomView live={live} at={at} /> : <BusyView live={live} />}
    </div>,
    document.body
  );
}

/**
 * Ask a question in the app's dialog from a button in the popover, and put focus back on that button when it is
 * answered with No (the popover is inert under the dialog, so the dialog's own return cannot reach it).
 */
async function askFrom(button: HTMLElement | null, ask: () => Promise<boolean | null>): Promise<boolean> {
  const ok = (await ask()) === true;
  if (!ok && button)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (button.isConnected && !button.closest('[inert]') && !button.closest('.share-popover')?.contains(document.activeElement)) button.focus();
      })
    );
  return ok;
}

function StartView() {
  const [duration, setDuration] = useState<SessionDuration>('2h');
  const [starting, setStarting] = useState(false);
  const labelId = useId();
  const hintId = useId();
  // Read as it renders: a session started now ends then.
  const ends = new Date(Date.now() + SESSION_DURATIONS[duration]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <div className="share-body">
      <p className="share-lead">Invite people to watch this project live in their browser, or to help edit it. They join from a link, and you admit each one.</p>
      <div className="share-field">
        <span className="share-label" id={labelId}>
          Session length
        </span>
        <Segmented radio full labelledBy={labelId} describedBy={hintId} value={duration} options={DURATION_CHOICES.map((d) => ({ value: d.id, label: d.label }))} onChange={setDuration} />
        <span className="share-hint" id={hintId}>
          {duration === 'project' ? 'Runs until you close the project, for 24 hours at most.' : `Ends at ${ends}. You can extend it while it runs.`}
        </span>
      </div>
      <button
        type="button"
        className="btn btn-primary share-start"
        data-autofocus
        disabled={starting}
        onClick={() => {
          setStarting(true);
          void startLive(duration).finally(() => setStarting(false));
        }}
      >
        <Radio aria-hidden="true" /> Start live session
      </button>
    </div>
  );
}

function BusyView({ live }: { live: Extract<LiveHostState, { phase: 'starting' | 'stopping' }> }) {
  const run = liveRun(live)!;
  return (
    <div className="share-body">
      <p className="share-lead share-busy" role="status">
        <Spinner decorative /> {live.phase === 'starting' ? 'Starting the live session…' : 'Ending the live session…'}
      </p>
      {live.phase === 'starting' && (
        <button type="button" className="btn btn-sm share-cancel" data-autofocus onClick={() => void cancelStart(run)}>
          Cancel
        </button>
      )}
    </div>
  );
}

/** How long a copied link's proof stays on the Copy button. */
const COPIED_MS = 2000;
/** A request that has left the queue (answered, or withdrawn), kept in its place in the queue for a moment. */
type Held = { guest: WaitingGuest; outcome: Outcome; at: number; goneAt: number };
type QueueRow = { guest: WaitingGuest; sent?: Answer; held?: Held };

/** Whether a scrolling list has more above or below what shows, for the fades that say so. */
function useScrollEdges(ref: React.RefObject<HTMLElement | null>) {
  const [edges, setEdges] = useState({ above: false, below: false });
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const above = el.scrollTop > 1;
    const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setEdges((e) => (e.above === above && e.below === below ? e : { above, below }));
  };
  useLayoutEffect(measure);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { edges, measure };
}

function RoomView({ live, at }: { live: LiveRoomState; at: number }) {
  const run = liveRun(live)!;
  const { busy, run: go } = useBusy();
  const menu = useMenu();
  const reconnecting = live.phase === 'reconnecting';
  // An Extend menu open as the connection drops goes: its choices would be refused until it is back.
  useEffect(() => {
    if (reconnecting) menu.close();
  }, [reconnecting]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = waitingGuests(live);
  const admitted = admittedGuests(live);
  const timed = live.duration !== 'project';
  const left = remainingMs(live, at);
  const extend = extendChoices(live);
  const linkId = useId();
  // A start that just copied this link shows that proof here too, whether the room opened before or after the copy.
  const [copied, setCopied] = useState(() => copiedAtStart(live.inviteUrl, COPIED_MS));
  useEffect(() => onStartCopied((url, when) => url === live.inviteUrl && setCopied(when)), [live.inviteUrl]);
  // Requests answered (here or from the notice) keep their slot from the press: "Admitting…" while the roster still
  // shows them waiting, then, for a moment after it lets them go, what became of them. One turned away (or gone) says
  // so in its slot. One let in is in the session now, and its row there says so (#1321): it is never listed twice, so
  // its slot here is kept empty, and only while a row below it would otherwise move up under the pointer. The queue keeps
  // the order it was drawn in through every hold (a request arriving meanwhile takes its place after the one before it
  // in the relay's order), and the slots close together once the last answer among them has settled, so a burst of
  // answers moves the queue once.
  const answers = useAnswers();
  // Those still to be answered: what the heading counts, and what Admit all and focus look for.
  const open = unanswered(waiting, answers);
  // Admit all acts as Enter is let go, as each Admit does, so a held key's repeats never press what takes its place.
  const [admitAllPress] = useState(freshPress);
  const [held, setHeld] = useState<Held[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  // The queue as last drawn, to see who has just left it, and whether focus was in the popover.
  const drawn = useRef<QueueRow[]>([]);
  const focusWasIn = useRef(false);
  // The guest whose row last had focus: their result line is where focus goes after answering them.
  const focusedGuest = useRef<string | null>(null);
  // Whether Show (in the status line or the roster's heading) had focus when it moved.
  const showHadFocus = useRef(false);
  // Each request's height as last drawn with its answers, so its slot keeps that height through "Admitting…" and its
  // hold even when its name wrapped beside "wants to join".
  const heights = useRef(new Map<string, number>());
  // Requests the roster has let go of since the queue was last drawn, held from this very draw, so a row never blinks
  // out (and focus never drops) before the hold takes it. One withdrawn before anyone answered holds its place too, and
  // says so, so a guest giving up never moves the request below it under the pointer.
  const gone = drawn.current.flatMap((r): Held[] => {
    if (r.held || waiting.some((g) => g.guestId === r.guest.guestId) || held.some((h) => h.guest.guestId === r.guest.guestId)) return [];
    const inNow = admitted.some((g) => g.guestId === r.guest.guestId);
    return [{ guest: r.guest, at: r.sent && !r.sent.unconfirmed ? r.sent.at : 0, goneAt: 0, outcome: r.sent ? outcomeOf(r.sent, inNow) : inNow ? 'admitted' : 'left' }];
  });
  const holding = new Map([...held, ...gone].map((h) => [h.guest.guestId, h]));
  const queue: QueueRow[] = drawn.current.flatMap((r): QueueRow[] => {
    const still = waiting.find((g) => g.guestId === r.guest.guestId);
    const h = holding.get(r.guest.guestId);
    return still ? [{ guest: still, sent: answers.get(still.guestId) }] : h ? [{ guest: h.guest, held: h }] : [];
  });
  // A request that arrived since goes before the next one already shown in the relay's order, else at the foot: never
  // into a held slot, so nothing new appears under the pointer that answered.
  waiting.forEach((g, i) => {
    if (queue.some((r) => r.guest.guestId === g.guestId)) return;
    const after = waiting.slice(i + 1).map((w) => queue.findIndex((r) => r.guest.guestId === w.guestId)).find((at) => at >= 0);
    queue.splice(after ?? queue.length, 0, { guest: g, sent: answers.get(g.guestId) });
  });
  const rows = queue.filter((r, i) => r.held?.outcome !== 'admitted' || queue.slice(i + 1).some((x) => x.held?.outcome !== 'admitted'));
  // Guests let in a moment ago, from here or the notice: their rows in the session say so (from this very draw for
  // those leaving the queue now).
  const joined = useJoined();
  const justIn = [...new Set([...joined.keys(), ...gone.filter((h) => h.outcome === 'admitted').map((h) => h.guest.guestId)])].filter((id) => admitted.some((g) => g.guestId === id));
  useLayoutEffect(() => {
    const now = Date.now();
    // Shown here; JoinRequests says it (and marks those let in), whichever surface answered.
    if (gone.length) setHeld((all) => [...all, ...gone.map((h) => ({ ...h, goneAt: now }))]);
    // An answer pressed replaces its buttons with a line saying so, and focus goes to that line rather than on to the
    // next request's Admit at once; once that line goes, on to the next request. A guest let in has no line here (it is
    // on their row in the session), so focus goes on to the next request, or, with nobody left to answer, to the role
    // of the guest just let in, where editing is given.
    const box = scroller.current?.closest<HTMLElement>('.share-popover');
    if (box && focusWasIn.current && (!document.activeElement || document.activeElement === document.body)) {
      const mine = focusedGuest.current && CSS.escape(focusedGuest.current);
      // Show, moving between the status line and the roster's heading as the list scrolls, keeps focus with it.
      const show = showHadFocus.current && '.live-show-new, .share-show-new';
      showHadFocus.current = false;
      // The next request to answer is the first below the one just answered, and only failing that the first above it.
      const drawnAt = (id: string) => drawn.current.findIndex((r) => r.guest.guestId === id);
      const from = focusedGuest.current ? drawnAt(focusedGuest.current) : -1;
      const toAnswer = queue.filter((r) => !r.held && !(r.sent && !r.sent.unconfirmed)).map((r) => r.guest.guestId);
      const nextUp = toAnswer.find((id) => drawnAt(id) > from) ?? toAnswer[0];
      const next =
        [show, mine && `.live-waiting .live-row.settled[data-guest="${mine}"]`, nextUp && `.live-waiting .live-row[data-guest="${CSS.escape(nextUp)}"] .live-answers button:not(:disabled)`, mine && `.live-roster .live-row[data-guest="${mine}"] select:not(:disabled)`, '.live-roster select:not(:disabled)', '[data-autofocus]']
          .map((q) => (q ? box.querySelector<HTMLElement>(q) : null))
          .find(Boolean) ?? box;
      next.focus({ preventScroll: true });
      intoView(next);
    }
    focusWasIn.current = !!box?.contains(document.activeElement);
    drawn.current = queue;
    for (const li of scroller.current?.querySelectorAll<HTMLElement>('.live-waiting .live-row.waits[data-guest]') ?? []) heights.current.set(li.dataset.guest!, li.offsetHeight);
  });
  useEffect(() => {
    if (!held.length) return;
    const now = Date.now();
    const due = (h: Held) => Math.max(h.at + SETTLE_MS, h.goneAt + SETTLE_AFTER_MS);
    // From the foot of the queue up: a slot closes no sooner than any held below it, and not while an answer below it
    // is still on its way.
    const closes = new Map<Held, number>();
    let below = 0;
    for (const r of [...queue].reverse()) {
      if (r.sent && !r.sent.unconfirmed) below = Infinity;
      const h = r.held && held.find((x) => x.guest.guestId === r.guest.guestId);
      if (h) closes.set(h, (below = Math.max(below, due(h))));
    }
    const timers = [...closes].filter(([, at]) => at !== Infinity).map(([h, at]) => setTimeout(() => setHeld((all) => all.filter((x) => x !== h)), Math.max(0, at - now)));
    return () => timers.forEach(clearTimeout);
  }, [held, answers, live]); // eslint-disable-line react-hooks/exhaustive-deps
  // A guest just let in whose row is out of sight in the list is offered in the roster's heading, so the host can see
  // them without hunting; the list itself never scrolls under the pointer on its own.
  const [unseen, setUnseen] = useState<string[]>([]);
  // Whether the roster's heading (and its Show) is out of sight below a long queue: Show is offered in the session's
  // status line instead.
  const [rosterBelow, setRosterBelow] = useState(false);
  const findUnseen = () => {
    const el = scroller.current;
    if (!el) return;
    const view = el.getBoundingClientRect();
    const head = el.querySelector('.live-roster .share-group-head')?.getBoundingClientRect();
    // In sight means clear of the sticky heading too: their name and the line that says they were just let in.
    const top = Math.max(view.top, head && head.top <= view.top + 4 ? head.bottom : view.top);
    const ids = justIn.filter((id) => {
      const row = el.querySelector(`.live-roster .live-row[data-guest="${CSS.escape(id)}"]`);
      const name = row?.querySelector('.live-name-line')?.getBoundingClientRect();
      const line = row?.querySelector('.live-where')?.getBoundingClientRect();
      return !!name && !!line && (name.top < top - 1 || line.bottom > view.bottom + 1);
    });
    setUnseen((u) => (u.join() === ids.join() ? u : ids));
    // Offered in the fixed line until the whole heading, Show and all, is in sight.
    const below = !!head && head.bottom > view.bottom + 1;
    setRosterBelow((b) => (b === below ? b : below));
  };
  useLayoutEffect(findUnseen);
  // The roster's place changes as the popover is resized, too.
  useEffect(() => {
    window.addEventListener('resize', findUnseen);
    return () => window.removeEventListener('resize', findUnseen);
  });
  const showUnseen = () => {
    const row = scroller.current?.querySelector<HTMLElement>(`.live-roster .live-row[data-guest="${CSS.escape(unseen[0])}"]`);
    if (!row) return;
    // Clear of the sticky heading (the list's scroll padding allows for it).
    row.scrollIntoView({ block: 'nearest' });
    // The button goes once they are in sight: focus goes to their role, where editing is given.
    row.querySelector<HTMLElement>('select:not(:disabled)')?.focus({ preventScroll: true });
  };
  const { edges, measure } = useScrollEdges(scroller);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(0), Math.max(0, copied + COPIED_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [copied]);
  const end = async (button: HTMLElement) => {
    // Asked even with nobody in yet: the link may already be in someone's inbox, and ending retires it for good.
    const ok = await askFrom(button, () => confirmDialog({
      title: 'End the live session?',
      body: admitted.length + waiting.length ? 'Everyone in it is disconnected, and the invite link stops working.' : 'The invite link stops working.',
      details: [
        ...(admitted.length ? [{ kind: 'lose' as const, text: `${admitted.length === 1 ? `${admitted[0].displayName} is` : `${admitted.length} guests are`} disconnected now.` }] : []),
        ...(waiting.length ? [{ kind: 'lose' as const, text: `${waiting.length === 1 ? `${waiting[0].displayName}, who is waiting, is` : `${waiting.length} people waiting are`} turned away.` }] : []),
        ...(admitted.length + waiting.length ? [] : [{ kind: 'lose' as const, text: 'Anyone you’ve sent the link to will need a new one.' }]),
        { kind: 'keep', text: 'Your project stays as it is. You can start a new session with a new link.' }
      ],
      confirmLabel: 'End session',
      cancelLabel: 'Keep it running',
      tone: 'danger',
      icon: 'leave'
    }));
    if (!ok) return;
    // Busy only once it is sent: the button stays enabled while it asks, so the question hands focus back to it.
    await go('end', () => liveCommand(run, (r) => api.live.stop(r)));
  };
  return (
    <div className={`share-body${edges.above ? ' more-above' : ''}${edges.below ? ' more-below' : ''}`}>
      <div className="share-fixed">
        <p className={`share-status ${live.phase}`}>
          {reconnecting ? <RefreshCw aria-hidden="true" className="live-glyph" /> : <Radio aria-hidden="true" className="live-glyph" />}
          {reconnecting ? 'Reconnecting…' : 'Live'}
          {/* A long queue holds the roster out of sight: the guest just let in is offered here, in a line that never moves. */}
          {unseen.length > 0 && rosterBelow && <ShowNew className="link-btn share-show-new" ids={unseen} guests={admitted} onShow={showUnseen} focused={showHadFocus} />}
          {live.locked && (
            <span className="share-locked">
              <Lock aria-hidden="true" /> Locked
            </span>
          )}
        </p>
        {reconnecting && (
          <p className="share-note" role="status">
            Your guests keep their places. You can change the session again once it reconnects.
          </p>
        )}
        <div className="share-field">
          <label className="share-label" htmlFor={linkId}>
            Invite link
          </label>
          <div className="share-link">
            <input id={linkId} className="input" readOnly value={live.inviteUrl} onFocus={(e) => e.currentTarget.select()} />
            <button
              type="button"
              className={`btn btn-sm share-copy${copied ? ' copied' : ''}`}
              data-autofocus={open.length === 0 || reconnecting || undefined}
              onClick={() => void copyInvite(live.inviteUrl).then((ok) => ok && setCopied(Date.now()))}
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />} {copied ? 'Copied' : 'Copy'}
            </button>
            <span className="sr-only" role="status">
              {copied ? 'Invite link copied' : ''}
            </span>
          </div>
        </div>
        <div className="share-time">
          {timed ? (
            <span>
              Ends in <strong title={spanWords(left)}>{formatSpan(left)}</strong> <span className="share-quiet">· {clockTime(live, live.expiresAt)}</span>
            </span>
          ) : (
            <span className="share-time-open">
              Open until you close the project
              <span className="share-quiet">Ends {clockDay(live, live.expiresAt, at)} at the latest</span>
            </span>
          )}
          {extend.length > 0 && (
            <button
              type="button"
              className="btn btn-sm btn-ghost share-extend"
              {...menu.triggerProps()}
              disabled={reconnecting || busy.has('extend')}
              onClick={(e) =>
                menu.openAt(
                  e.currentTarget,
                  extend.map((c) => ({ label: c.label, hint: `Until ${clockTime(live, c.expiresAt!)}`, onSelect: () => void go('extend', () => liveCommand(run, (r) => api.live.extend(r, c.expiresAt!))) })),
                  'Extend the session'
                )
              }
            >
              Extend <ChevronDown aria-hidden="true" />
            </button>
          )}
        </div>
        {live.lastError && (
          <p className="share-error" role="alert">
            {live.lastError}
          </p>
        )}
      </div>
      <div
        ref={scroller}
        className="share-scroll"
        onScroll={() => {
          measure();
          findUnseen();
        }}
      >
        {rows.length > 0 && (
          <Group
            title="Waiting to join"
            count={open.length}
            zero
            className="live-waiting"
            action={
              open.length > 1 && (
                <button type="button" className="btn btn-sm btn-ghost" disabled={reconnecting || busy.has('admit-all')} {...admitAllPress} onClick={() => void go('admit-all', async () => {
                  // Not those already being answered.
                  for (const g of unanswered(waiting, answers)) await sendAnswer(run, g, 'admitted');
                })}>
                  Admit all as viewers
                </button>
              )
            }
          >
            {rows.map(({ guest: g, sent, held: h }) =>
              h?.outcome === 'admitted' ? (
                // Let in: they are in the session now, and never shown here again. Their slot stays a moment, empty (the
                // answered row's own content, never painted, keeps its height), so the row below keeps its place. A new
                // element, not the answered row restyled, so focus in that row is handed on rather than left in it.
                <li key={`gap-${g.guestId}`} className="live-row live-gap" aria-hidden="true" style={{ minHeight: heights.current.get(g.guestId) }}>
                  <span className="live-name">
                    <strong>{g.displayName}</strong>
                  </span>
                  <span className="live-settled done">
                    <Check aria-hidden="true" /> {OUTCOME_WORDS.admitted}
                  </span>
                </li>
              ) : h || (sent && !sent.unconfirmed) ? (
                <li key={g.guestId} data-guest={g.guestId} className="live-row settled" style={{ minHeight: heights.current.get(g.guestId) }} tabIndex={-1} aria-label={`${g.displayName}: ${h ? OUTCOME_WORDS[h.outcome] : sent!.answer === 'admitted' ? 'admitting' : 'declining'}`}>
                  <span className="live-name">
                    <strong>{g.displayName}</strong>
                  </span>
                  {h ? (
                    // Turned away, or gone before an answer reached them: a closed request, never a check.
                    <span className={`live-settled done ${h.outcome}`}>
                      <X aria-hidden="true" /> {OUTCOME_WORDS[h.outcome]}
                    </span>
                  ) : (
                    <span className="live-settled">
                      <Spinner decorative /> {sent!.answer === 'admitted' ? 'Admitting…' : 'Declining…'}
                    </span>
                  )}
                </li>
              ) : (
                <li key={g.guestId} data-guest={g.guestId} className="live-row waits" onFocus={() => (focusedGuest.current = g.guestId)}>
                  <span className="live-name">
                    <strong>{g.displayName}</strong> wants to join
                    {sent?.unconfirmed && <span className="share-quiet"> · Not confirmed yet. Try again.</span>}
                  </span>
                  <JoinAnswers run={run} guest={g} disabled={reconnecting || busy.has('admit-all')} autoFocus={g.guestId === open[0]?.guestId && !reconnecting} />
                </li>
              )
            )}
          </Group>
        )}
        <Group
          title="In the session"
          count={admitted.length}
          className="live-roster"
          action={
            unseen.length > 0 && !rosterBelow && <ShowNew className="btn btn-sm btn-ghost live-show-new" ids={unseen} guests={admitted} onShow={showUnseen} focused={showHadFocus} />
          }
        >
          {admitted.length === 0 ? (
            <li className="share-quiet share-empty">No one has joined yet. Send the invite link to someone.</li>
          ) : (
            admitted.map((g) => <GuestRow key={g.guestId} run={run} live={live} guest={g} at={at} disabled={reconnecting} joined={justIn.includes(g.guestId)} />)
          )}
        </Group>
      </div>
      <div className="share-fixed share-end">
        <SwitchRow
          label="Lock session"
          hint="No one new can ask to join. Everyone already here stays."
          checked={live.locked}
          disabled={reconnecting || busy.has('lock')}
          onChange={(locked) => void go('lock', () => liveCommand(run, (r) => api.live.setLocked(r, locked)))}
        />
        <SwitchRow
          label="Allow guest notes"
          hint="Guests can pin short notes to pages for you. Notes already left stay."
          checked={live.guestNotes}
          disabled={busy.has('notes')}
          onChange={(allowed) => void go('notes', () => liveCommand(run, (r) => api.live.setGuestNotes(r, allowed)))}
        />
        <div className="share-foot">
          <button type="button" className="btn btn-sm btn-danger" disabled={busy.has('end')} onClick={(e) => void end(e.currentTarget)}>
            End session
          </button>
        </div>
      </div>
      {menu.node}
    </div>
  );
}

/** A group of people; `zero` counts it even when none are left (a queue still showing what became of its last answers). */
function Group({ title, count, zero, className, action, children }: { title: string; count: number; zero?: boolean; className: string; action?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className={`share-group ${className}`} aria-labelledby={id}>
      <div className="share-group-head">
        <h3 id={id}>{count > 0 || zero ? `${title} (${count})` : title}</h3>
        {action}
      </div>
      <ul>{children}</ul>
    </section>
  );
}

/**
 * Show the guests just let in whose rows are out of sight (#1321): one by name, several by count, each press the next.
 * Its accessible name starts with what it says, then names them all.
 */
function ShowNew({ className, ids, guests, onShow, focused }: { className: string; ids: string[]; guests: AdmittedGuest[]; onShow: () => void; focused: React.MutableRefObject<boolean> }) {
  const names = ids.map((id) => guests.find((g) => g.guestId === id)?.displayName ?? '');
  const text = names.length === 1 ? `Show ${names[0]}` : `Show ${names.length} new guests`;
  return (
    <button
      type="button"
      className={className}
      aria-label={names.length === 1 ? `${text}, just admitted` : `${text}: ${namesOf(names, names.length)}`}
      onClick={onShow}
      onFocus={() => (focused.current = true)}
      onBlur={(e) => e.relatedTarget && (focused.current = false)}
    >
      <span>{text}</span>
    </button>
  );
}

function GuestRow({ run, live, guest, at, disabled, joined }: { run: LiveRun; live: LiveRoomState; guest: AdmittedGuest; at: number; disabled: boolean; joined: boolean }) {
  const { busy, run: go } = useBusy();
  const off = disabled || busy.size > 0;
  const choices = guestExpiryChoices(live, at);
  // Any end of its own shows as one, so Whole session can always be chosen to clear it.
  const own = guest.guestExpiresAt !== null;
  // A role asked for shows until the roster confirms it (or the command fails), so it is never offered back as a no-op;
  // until then the row says it is still being changed.
  const [asked, setAsked] = useState<GuestRole | null>(null);
  useEffect(() => {
    if (!asked) return;
    // Confirmed, or the connection dropped before it may have arrived: the roster's role is what holds.
    if (guest.role === asked || disabled) return setAsked(null);
    // One the relay refused never arrives: the roster's role shows again after a while.
    const timer = setTimeout(() => setAsked(null), 10_000);
    return () => clearTimeout(timer);
  }, [asked, guest.role, disabled]);
  const timeLeft = guestTimeLeft(live, guest, at);
  const remove = async (button: HTMLElement) => {
    const ok = await askFrom(button, () => confirmDialog({
      title: `Remove ${guest.displayName}?`,
      body: live.locked ? 'They leave the session now. While the session is locked, they can’t ask to join again.' : 'They leave the session now. While the invite link works, they can ask to join again.',
      subject: guest.displayName,
      subjectNote: ROLE_LABELS[guest.role],
      confirmLabel: 'Remove',
      tone: 'caution',
      icon: 'leave'
    }));
    if (!ok) return;
    // Yes: this row is going, so focus (which the inert popover could not get back from the dialog) goes to the next
    // guest's controls, else to where the popover starts.
    const row = button.closest('li');
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const box = button.closest<HTMLElement>('.share-popover');
        if (!box || box.contains(document.activeElement)) return;
        const next = [...box.querySelectorAll<HTMLElement>('.live-roster select:not(:disabled)')].find((el) => !row?.contains(el)) ?? box.querySelector<HTMLElement>('[data-autofocus]') ?? box;
        next.focus({ preventScroll: true });
      })
    );
    await go('kick', () => liveCommand(run, (r) => api.live.kick(r, guest.guestId)));
  };
  return (
    <li className={`live-row${joined ? ' joined' : ''}`} data-guest={guest.guestId}>
      <span className="live-name-line">
        <span className="live-name">
          <span className="peer-dot" style={{ '--peer': peerColor(guest.colorSlot) } as CSSProperties} aria-hidden="true" />
          <strong>{guest.displayName}</strong>
          {asked && asked !== guest.role ? <span className="share-quiet"> · Updating…</span> : timeLeft && <span className="share-quiet"> · {timeLeft}</span>}
        </span>
        <button type="button" className="btn btn-sm btn-ghost btn-danger live-remove" aria-label={`Remove ${guest.displayName}`} disabled={off} onClick={(e) => void remove(e.currentTarget)}>
          Remove
        </button>
      </span>
      <GuestWhere guest={guest} joined={joined} />
      <span className="live-controls">
        <select
          className="select sm"
          aria-label={`Role for ${guest.displayName}`}
          value={asked ?? guest.role}
          disabled={off}
          onChange={(e) => {
            const role = e.target.value as GuestRole;
            setAsked(role);
            void go('role', async () => {
              if (!(await liveCommand(run, (r) => api.live.setRole(r, guest.guestId, role)))) setAsked(null);
            });
          }}
        >
          {/* A role the host cannot pick shows while the guest holds it, and is never offered back. */}
          {(OFFERED_ROLES.includes(guest.role) ? OFFERED_ROLES : [...OFFERED_ROLES, guest.role]).map((role) => (
            <option key={role} value={role} disabled={!OFFERED_ROLES.includes(role)}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>
        <select
          className="select sm"
          aria-label={`Access for ${guest.displayName}`}
          value={own ? 'own' : 'session'}
          disabled={off}
          onChange={(e) => {
            // Read again as it is picked, so "for 15 minutes" is from now.
            const clock = getState().liveClock;
            const picked = guestExpiryChoices(live, clock ? relayNow(clock) : at).find((c) => c.id === e.target.value);
            if (picked) void go('expiry', () => liveCommand(run, (r) => api.live.setGuestExpiry(r, guest.guestId, picked.expiresAt)));
          }}
        >
          {own && <option value="own">Until {clockTime(live, guest.guestExpiresAt!)}</option>}
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </span>
      {guest.role === 'collaborator' && <GuestAi run={run} live={live} guest={guest} disabled={off} go={go} />}
    </li>
  );
}

/**
 * Where a guest is now (#768): a connection that dropped, a viewer watching, or the page and element a collaborator is
 * on (and that it is editing), with a way to that page when it is another one. What is said follows the guest as it
 * moves; Go to page reads where they are when it is pressed.
 */
function GuestWhere({ guest, joined }: { guest: AdmittedGuest; joined: boolean }) {
  // Read whole, so the row follows the session without a new object on every look.
  const live = useStore((s) => s.live);
  const livePresence = useStore((s) => s.livePresence);
  const snapshot = useStore((s) => s.snapshot);
  const pageId = useStore((s) => s.pageId);
  const state = snapshot?.state ?? null;
  const peer = livePeers({ live, livePresence, snapshot, remote: getState().remote, remotePresence: null }).find((p) => p.key === guest.guestId) ?? null;
  if (!guest.connected) return <span className="live-where share-quiet">Connection dropped. Waiting for them to reconnect…</span>;
  // Let in a moment ago (#1321): said here, where they now are, with a check and words, until it is old news.
  if (joined)
    return (
      <span className="live-where live-joined">
        <Check aria-hidden="true" /> Just admitted
      </span>
    );
  if (guest.role !== 'collaborator') return <span className="live-where share-quiet">Watching</span>;
  const presence = peer?.presence ?? null;
  if (!state || !presence) return <span className="live-where share-quiet">Location not known yet</span>;
  const there = presence.pageId && Object.hasOwn(state.pages, presence.pageId) ? presence.pageId : null;
  const goTo = () => {
    const now = livePeers(getState()).find((p) => p.key === guest.guestId)?.presence?.pageId;
    if (now && Object.hasOwn(getState().snapshot?.state.pages ?? {}, now)) selectPage(now);
  };
  return (
    <span className="live-where">
      <span className="share-quiet">
        {presenceWhere(state, presence)}
        {peer?.activity ? ' · editing' : ''}
      </span>
      {there && there !== pageId ? (
        <button type="button" className="link-btn" onClick={goTo} aria-label={`Go to ${guest.displayName}’s page`}>
          <FileText aria-hidden="true" /> Go to page
        </button>
      ) : (
        there && <span className="share-quiet"> · Same page as you</span>
      )}
    </span>
  );
}

/**
 * Whether a collaborator may ask this computer's AI to edit (#769): off when it is let in, until the host turns it on,
 * with how many requests it may make. Its requests run here, with the host's provider and quota, which the row says.
 */
function GuestAi({ run, live, guest, disabled, go }: { run: LiveRun; live: LiveRoomState; guest: AdmittedGuest; disabled: boolean; go: (key: string, fn: () => Promise<unknown>) => Promise<unknown> }) {
  const grant = live.ai[guest.guestId] ?? { allowed: false, turnLimit: null, turnsUsed: 0 };
  const set = (allowed: boolean, turnLimit: number | null) => void go('ai', () => liveCommand(run, (r) => api.live.setAi(r, guest.guestId, { allowed, turnLimit })));
  const limits: Array<number | null> = [null, ...LIVE_AI_TURN_LIMITS];
  if (grant.turnLimit !== null && !limits.includes(grant.turnLimit)) limits.push(grant.turnLimit);
  return (
    <div className="live-ai">
      <SwitchRow
        checked={grant.allowed}
        disabled={disabled}
        onChange={(on) => set(on, grant.turnLimit)}
        label="Allow AI editing"
        hint="Their AI requests run on this computer, using your AI provider and its quota."
      />
      {/* The limit can be chosen before AI is turned on, so a guest never has more requests than the host meant. */}
      <span className="live-controls">
        <select className="select sm" aria-label={`AI requests for ${guest.displayName}`} value={grant.turnLimit === null ? 'none' : String(grant.turnLimit)} disabled={disabled} onChange={(e) => set(grant.allowed, e.target.value === 'none' ? null : Number(e.target.value))}>
          {limits.map((n) => (
            <option key={n ?? 'none'} value={n === null ? 'none' : String(n)}>
              {n === null ? 'No limit on requests' : n === 1 ? 'Up to 1 request' : `Up to ${n} requests`}
            </option>
          ))}
        </select>
        <span className="share-quiet live-ai-used">{grant.turnsUsed === 1 ? '1 used' : `${grant.turnsUsed} used`}</span>
      </span>
    </div>
  );
}
