import '../panels/SharePopover.css';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { UserPlus, X } from 'lucide-react';
import type { LiveHostState, LiveRun } from '@shared/api';
import type { GuestRole } from '@shared/live/limits';
import { api, getState, setState, toast, useStore } from '../store';
import { liveCommand, shownLive } from '../lib/live-host';
import { admittedGuests, liveRun, waitingGuests, type WaitingGuest } from '../lib/live-session';

/** Commands in flight, by what they are for, so a second press of the same button does nothing until the first is back. */
export function useBusy() {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const run = async (key: string, fn: () => Promise<unknown>) => {
    if (busy.has(key)) return;
    setBusy((b) => new Set(b).add(key));
    try {
      await fn();
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(key);
        return next;
      });
    }
  };
  return { busy, run };
}

/** Let a waiting guest in with a role. */
export const admitGuest = (run: LiveRun, guest: WaitingGuest, role: GuestRole) => liveCommand(run, (r) => api.live.admit(r, guest.guestId, role, null));

/** How long an answer sent waits for the roster to show it before it is offered again. */
const ANSWER_GIVE_UP_MS = 10_000;
/**
 * How long an answered request keeps its place from the press, and at least how long after the roster lets it go, so
 * the next one never slides under the pointer that answered it (Share's queue, and the notice's answers).
 */
export const SETTLE_MS = 1500;
export const SETTLE_AFTER_MS = 800;

/**
 * Answers sent and not yet shown by the roster, by guest, shared by the popover and the notice so a guest is never
 * answered twice. One the roster has not shown after a while is `unconfirmed`: its answers are offered again.
 */
export type Answer = { answer: 'admitted' | 'declined'; name: string; at: number; unconfirmed?: boolean };

/** What became of an answered request, as the roster showed it once the guest left the queue. */
export type Outcome = 'admitted' | 'declined' | 'left';
export const OUTCOME_WORDS: Readonly<Record<Outcome, string>> = { admitted: 'Admitted as viewer', declined: 'Declined', left: 'Left before joining' };
export const outcomeOf = (sent: Answer, admittedNow: boolean): Outcome => (admittedNow ? 'admitted' : sent.answer === 'declined' ? 'declined' : 'left');
/**
 * The guests still to be answered: one whose answer is on its way is off the count (the Share badge, the queue's
 * heading, Admit all) until the roster lets them go, or until the answer is offered again.
 */
export const unanswered = (waiting: WaitingGuest[], sent: ReadonlyMap<string, Answer>): WaitingGuest[] => waiting.filter((g) => !sent.get(g.guestId) || !!sent.get(g.guestId)!.unconfirmed);

/**
 * A button that acts on a fresh press: Enter acts as it is let go (as Space does), so a held key's repeats never answer
 * the next request focus moves to.
 */
export function freshPress() {
  let armed: EventTarget | null = null;
  return {
    onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (!e.repeat) armed = e.currentTarget;
    },
    onKeyUp: (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== 'Enter' || armed !== e.currentTarget) return;
      armed = null;
      e.currentTarget.click();
    }
  };
}
let answers: ReadonlyMap<string, Answer> = new Map();
const answerListeners = new Set<() => void>();
function setAnswer(guestId: string, a: Answer | null) {
  const next = new Map(answers);
  if (a) next.set(guestId, a);
  else if (!next.delete(guestId)) return;
  answers = next;
  answerListeners.forEach((fn) => fn());
}
export const useAnswers = () =>
  useSyncExternalStore(
    (fn) => (answerListeners.add(fn), () => void answerListeners.delete(fn)),
    () => answers,
    () => answers
  );

/** How long a guest just let in is marked so on their row in Share. */
export const JOINED_MS = 8000;
/**
 * Guests let in a moment ago (#1321), by when the roster showed them in, whichever surface answered and whether or not
 * Share was open then: Share marks their rows for the rest of that moment.
 */
let joined: ReadonlyMap<string, number> = new Map();
const joinedListeners = new Set<() => void>();
function setJoined(next: ReadonlyMap<string, number>) {
  joined = next;
  joinedListeners.forEach((fn) => fn());
}
function markJoined(ids: string[]) {
  const at = Date.now();
  setJoined(new Map([...joined, ...ids.map((id) => [id, at] as const)]));
  setTimeout(() => setJoined(new Map([...joined].filter(([id, when]) => !(ids.includes(id) && when === at)))), JOINED_MS);
}
export const useJoined = () =>
  useSyncExternalStore(
    (fn) => (joinedListeners.add(fn), () => void joinedListeners.delete(fn)),
    () => joined,
    () => joined
  );

/** Send an answer to a waiting guest; false when it could not be sent (the guest's answers come back at once). */
export async function sendAnswer(run: LiveRun, guest: WaitingGuest, answer: Answer['answer']): Promise<boolean> {
  // Checked as it is sent: one already answered (from the notice, or one at a time while Admit all runs) is not sent twice.
  const before = answers.get(guest.guestId);
  if (before && !before.unconfirmed) return true;
  const at = Date.now();
  setAnswer(guest.guestId, { answer, name: guest.displayName, at });
  const ok = answer === 'admitted' ? await admitGuest(run, guest, 'viewer') : await liveCommand(run, (r) => api.live.decline(r, guest.guestId));
  if (!ok) setAnswer(guest.guestId, null);
  else
    setTimeout(() => {
      const now = answers.get(guest.guestId);
      if (now?.at === at) setAnswer(guest.guestId, { ...now, unconfirmed: true });
    }, ANSWER_GIVE_UP_MS);
  return ok;
}

/**
 * The answers to a guest waiting to join, the same in the Share popover and in the notice that announces it: Admit,
 * the one obvious answer, lets them in as a viewer (the safe role; editing is given in the roster), and Decline is
 * the quiet other. `autoFocus` marks Admit as where the popover starts.
 */
export function JoinAnswers({ run, guest, disabled, autoFocus }: { run: LiveRun; guest: WaitingGuest; disabled?: boolean; autoFocus?: boolean }) {
  const sent = useAnswers().get(guest.guestId);
  const pending = !!disabled || (!!sent && !sent.unconfirmed);
  const [press] = useState(freshPress);
  return (
    <span className="live-answers" role="group" aria-label={`Answer ${guest.displayName}`}>
      <button type="button" className="btn btn-sm btn-primary" data-autofocus={autoFocus || undefined} disabled={pending} onClick={() => void sendAnswer(run, guest, 'admitted')} {...press}>
        Admit as viewer
      </button>
      <button type="button" className="btn btn-sm btn-ghost" disabled={pending} onClick={() => void sendAnswer(run, guest, 'declined')} {...press}>
        Decline
      </button>
    </span>
  );
}

/** Names in a sentence, at most `max` of them: "Ann, Mo and 3 more". */
export function namesOf(names: string[], max = 2): string {
  if (names.length <= max) return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

/**
 * The guests waiting to join, with the notices (src/renderer/src/components/ui.tsx Toasts), so they are seen whichever
 * panel is open: one notice whoever is waiting, which never takes focus and stays until it is answered or put aside.
 * Putting it aside declines no one: they keep waiting in Share, its badge still counts them, and the next guest to
 * ask brings a notice back. While the Share popover is open it lists them itself, so they are not shown twice.
 *
 * Arrivals are announced here too, outside the app's root, so they are still heard while a dialog makes the root inert.
 */
export function JoinRequests() {
  const live = useStore(shownLive);
  const shareOpen = useStore((s) => s.shareOpen);
  const notice = useStore((s) => s.liveNotice);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  // An answer whose guest has left the queue (let in, turned away, or gone) is done with, and what became of them is
  // said, from here whichever surface answered (this is always mounted). While Share is open its rows show it, so it is
  // only heard; otherwise the request's notice has gone, and a notice in its place says it, seen and heard alike.
  const sentAnswers = useAnswers();
  // For a moment after an answer is settled, the notice keeps a request still waiting behind Review in Share rather than
  // putting its answers where the last press landed (as Share holds a slot).
  const [settling, setSettling] = useState(0);
  useEffect(() => {
    const still = new Set(waitingGuests(live).map((g) => g.guestId));
    const inRoom = new Set(admittedGuests(live).map((g) => g.guestId));
    const said: string[] = [];
    const letIn: string[] = [];
    for (const [id, a] of sentAnswers) {
      if (still.has(id)) continue;
      const outcome = outcomeOf(a, inRoom.has(id));
      if (outcome === 'admitted') letIn.push(id);
      said.push(`${a.name}: ${OUTCOME_WORDS[outcome].toLowerCase()}`);
      setAnswer(id, null);
    }
    if (!said.length) return;
    if (letIn.length) markJoined(letIn);
    setSettling(Date.now());
    if (getState().shareOpen) setState({ liveNotice: { id: Date.now(), text: said.join('. ') } });
    else toast(`${said.join('. ')}.`, letIn.length === said.length ? 'success' : 'info');
  }, [live, sentAnswers]);
  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => setSettling(0), Math.max(0, settling + SETTLE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [settling]);
  // Focus in the notice when it goes (hidden, or answered from the keyboard) goes back where it came from, else to
  // Share, where the requests still are, else into the dialog that is open.
  const region = useRef<HTMLDivElement>(null);
  const cameFrom = useRef<HTMLElement | null>(null);
  const hadFocus = useRef(false);
  useLayoutEffect(() => {
    if (!hadFocus.current || region.current?.contains(document.activeElement)) return;
    hadFocus.current = false;
    if (document.activeElement && document.activeElement !== document.body) return;
    const reachable = (el: HTMLElement | null | undefined): el is HTMLElement => !!el && el.isConnected && el.offsetParent !== null && !el.closest('[inert]') && !el.matches(':disabled');
    const dialog = [...document.querySelectorAll<HTMLElement>('.modal')].at(-1);
    // The first of them that really takes focus.
    for (const el of [cameFrom.current, document.querySelector<HTMLElement>('.toolbar .share-btn'), dialog?.querySelector<HTMLElement>('[data-autofocus]:not(:disabled), button:not(:disabled)'), dialog]) {
      if (!reachable(el)) continue;
      el.focus();
      if (document.activeElement === el) return;
    }
  });
  return (
    <>
      {/* Mounted for as long as the editor is, so each new request is heard; never the ticking time. */}
      <span className="sr-only live-announce" role="status" aria-live="polite">
        <span key={notice.id}>{notice.text}</span>
      </span>
      <div
        ref={region}
        className="live-requests"
        onFocus={(e) => {
          hadFocus.current = true;
          const from = e.relatedTarget as HTMLElement | null;
          if (from && !e.currentTarget.contains(from)) cameFrom.current = from;
        }}
        onBlur={(e) => {
          if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) hadFocus.current = false;
        }}
      >
        {!shareOpen && <JoinRequestList live={live} hidden={hidden} settling={!!settling} onHide={(ids) => setHidden((h) => new Set([...h, ...ids]))} />}
      </div>
    </>
  );
}

/**
 * The waiting room's notice for a session as the editor shows it. One guest is answered right there; several are
 * reviewed in Share, where each is named and answered. While the session reconnects it stays, so a request never
 * vanishes from under the host's hand: an answer would not reach the relay, so its buttons give way to a line that
 * says when they come back, as they do under a dialog.
 */
export function JoinRequestList({ live, hidden, settling, onHide }: { live: LiveHostState; hidden?: ReadonlySet<string>; settling?: boolean; onHide?: (guestIds: string[]) => void }) {
  const pressedHide = useRef<EventTarget | null>(null);
  const pressedReview = useRef<EventTarget | null>(null);
  const sentAnswers = useAnswers();
  const run = liveRun(live);
  const waiting = waitingGuests(live);
  // Shown while anyone waiting has not been put aside; a new arrival brings it back for everyone still waiting, so its
  // count is always the whole queue.
  if (!run || (live.phase !== 'active' && live.phase !== 'reconnecting') || !waiting.some((g) => !hidden?.has(g.guestId))) return null;
  const paused = live.phase === 'reconnecting';
  // Its buttons wait while a dialog is open (they act on the page behind): this line says when they come back. A guest
  // whose answer is on its way, or who waits on the session reconnecting, has its own line instead; a group's Review
  // in Share is still held back by the dialog then.
  const later = <span className="notice-later">Answer once this dialog is closed.</span>;
  // One waiting is answered right here, except for the moment just after another's answer settled.
  const one = waiting.length === 1 && !settling ? waiting[0] : null;
  const sent = one ? sentAnswers.get(one.guestId) : undefined;
  const sending = !!sent && !sent.unconfirmed;
  const titleId = `live-request-${waiting[0].guestId}`;
  // Several: those still to be answered are who it counts and names; one whose answer is on its way is said in a line
  // of its own (as it is in Share's badge), and the notice keeps Review in Share, so no answer appears under the
  // pointer that answered.
  const open = unanswered(waiting, sentAnswers);
  const answering = (['admitted', 'declined'] as const)
    .map((answer) => ({ answer, names: waiting.filter((g) => !open.includes(g) && sentAnswers.get(g.guestId)?.answer === answer).map((g) => g.displayName) }))
    .filter((a) => a.names.length)
    .map((a) => `${a.answer === 'admitted' ? 'Admitting' : 'Declining'} ${namesOf(a.names)}…`)
    .join(' ');
  return (
    <div className="toast-group" role="region" aria-label="Join requests">
      <div className="toast live-request" role="group" aria-labelledby={titleId}>
        <UserPlus />
        <div className="grow live-request-body">
          <span className="live-request-title" id={titleId}>
            {one ? (
              <>
                <strong>{one.displayName}</strong> wants to join
              </>
            ) : open.length === 1 ? (
              <>
                <strong>{open[0].displayName}</strong> wants to join
              </>
            ) : open.length ? (
              <>
                <strong>{open.length} people</strong> want to join
              </>
            ) : (
              answering
            )}
          </span>
          {!one && open.length > 1 && <span className="live-request-names">{namesOf(open.map((g) => g.displayName))}</span>}
          {!one && open.length > 0 && answering && <span className="live-request-sending">{answering}</span>}
          {one && sending ? (
            // Answered: it says so until the roster lets the guest go (and the outcome is announced then).
            <span className="live-request-sending">{sent!.answer === 'admitted' ? 'Admitting…' : 'Declining…'}</span>
          ) : one && paused ? (
            <span className="live-request-paused">Answer once the session reconnects.</span>
          ) : one ? (
            <>
              {/* Try again names the buttons, so it goes while a dialog holds them back. */}
              {sent?.unconfirmed && (
                <span className="live-request-note">
                  Not confirmed yet.<span className="live-request-retry"> Try again.</span>
                </span>
              )}
              {later}
              <JoinAnswers run={run} guest={one} />
            </>
          ) : (
            <>
              {later}
              <span className="live-answers">
                {/* As the key is let go, as Hide does: Share opens with focus on the first Admit, which a held Enter's repeats
                    would otherwise press. */}
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => setState({ shareOpen: true })}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    if (!e.repeat) pressedReview.current = e.currentTarget;
                  }}
                  onKeyUp={(e) => {
                    if (e.key !== 'Enter' || pressedReview.current !== e.currentTarget) return;
                    pressedReview.current = null;
                    e.currentTarget.click();
                  }}
                >
                  Review in Share
                </button>
              </span>
            </>
          )}
        </div>
        {onHide && (
          <button
            type="button"
            className="toast-dismiss"
            aria-label={waiting.length === 1 ? `Hide ${waiting[0].displayName}’s request` : 'Hide these requests'}
            title="Hide. They keep waiting in Share."
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onHide(waiting.map((g) => g.guestId))}
            // Enter hides it as the key is let go, as Space does (and as the other notices do): hiding moves focus, and
            // a held key's repeats would otherwise press whatever took it.
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (!e.repeat) pressedHide.current = e.currentTarget;
            }}
            onKeyUp={(e) => {
              if (e.key !== 'Enter' || pressedHide.current !== e.currentTarget) return;
              pressedHide.current = null;
              e.currentTarget.click();
            }}
          >
            <X />
          </button>
        )}
      </div>
    </div>
  );
}
