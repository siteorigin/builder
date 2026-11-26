import './SharePopover.css';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Lock, Radio, Users, X } from 'lucide-react';
import type { LiveHostState, LiveRun } from '@shared/api';
import { GUEST_ROLES, type GuestRole } from '@shared/live/limits';
import type { SessionDuration } from '@shared/live/expiry';
import { api, getState, setState, useStore } from '../store';
import { openMenus, Segmented, Spinner, SwitchRow, useMenu } from '../components/ui';
import { cancelStart, copyInvite, liveCommand, shownLive, startLive } from '../lib/live-host';
import { JoinAnswers, useBusy } from '../components/JoinRequests';
import {
  admittedGuests,
  clockTime,
  DURATION_CHOICES,
  extendChoices,
  formatSpan,
  guestExpiryChoices,
  guestTimeLeft,
  hasRoom,
  livePill,
  liveRun,
  relayNow,
  remainingMs,
  ROLE_LABELS,
  spanWords,
  tickMs,
  waitingGuests,
  type AdmittedGuest,
  type LiveRoomState
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
  const notice = useStore((s) => s.liveNotice);
  const at = useRelayNow(live);
  const pill = livePill(live, at);
  const waiting = waitingGuests(live).length;
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
        {pill.kind === 'busy' ? <Spinner decorative /> : pill.kind === 'idle' ? <Users aria-hidden="true" /> : <Radio aria-hidden="true" className="live-dot" />}
        {(!compact || pill.kind !== 'idle') && <span className="share-text">{pill.text}</span>}
        {pill.kind === 'live' && people > 0 && (
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
      {/* Mounted for as long as the toolbar is, so each new request is heard; never the ticking time. */}
      <span className="sr-only" role="status" aria-live="polite">
        <span key={notice.id}>{notice.text}</span>
      </span>
      {open && <SharePopover id={id} live={live} at={at} trigger={trigger} />}
    </>
  );
}

type Box = { left: number; top: number };

function SharePopover({ id, live, at, trigger }: { id: string; live: LiveHostState; at: number; trigger: React.RefObject<HTMLButtonElement | null> }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Box | null>(null);
  const close = (back: boolean) => {
    setState({ shareOpen: false });
    if (back) requestAnimationFrame(() => trigger.current?.focus());
  };
  // The editor's own shortcuts stay out of the way while it is open, as for a menu; focus starts on its first control.
  useEffect(() => {
    openMenus.count++;
    const first = box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? box.current?.querySelector<HTMLElement>('button, input, select');
    first?.focus({ preventScroll: true });
    return () => {
      openMenus.count--;
    };
  }, []);
  // A press anywhere else puts it away and goes where it was meant to; the Share button toggles it itself.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target instanceof Node ? e.target : null;
      if (!t || box.current?.contains(t) || trigger.current?.contains(t)) return;
      // A menu it opened (Extend) is part of it.
      if (t instanceof Element && t.closest('[role="menu"]')) return;
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
    const next = ['.live-waiting button:not(:disabled)', '.live-roster select:not(:disabled)', '[data-autofocus]'].map((q) => el.querySelector<HTMLElement>(q)).find(Boolean) ?? el;
    next.focus({ preventScroll: true });
    next.scrollIntoView?.({ block: 'nearest' });
  });
  return createPortal(
    <div
      ref={box}
      id={id}
      className="share-popover"
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
        if (!trigger.current?.contains(to) && !(to instanceof Element && to.closest('[role="menu"]'))) setState({ shareOpen: false });
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

function StartView() {
  const [duration, setDuration] = useState<SessionDuration>('2h');
  const [starting, setStarting] = useState(false);
  const labelId = useId();
  return (
    <div className="share-body">
      <p className="share-lead">Invite people to watch this project live in their browser, or to help edit it. They join from a link, and you let each one in.</p>
      <div className="share-field">
        <span className="share-label" id={labelId}>
          Session length
        </span>
        <Segmented radio full labelledBy={labelId} value={duration} options={DURATION_CHOICES.map((d) => ({ value: d.id, label: d.label }))} onChange={setDuration} />
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
        <button type="button" className="btn btn-sm" data-autofocus onClick={() => void cancelStart(run)}>
          Cancel
        </button>
      )}
    </div>
  );
}

function RoomView({ live, at }: { live: LiveRoomState; at: number }) {
  const run = liveRun(live)!;
  const { busy, run: go } = useBusy();
  const menu = useMenu();
  const reconnecting = live.phase === 'reconnecting';
  const waiting = waitingGuests(live);
  const admitted = admittedGuests(live);
  const timed = live.duration !== 'project';
  const left = remainingMs(live, at);
  const extend = extendChoices(live);
  const linkId = useId();
  return (
    <div className="share-body">
      <p className={`share-status ${live.phase}`}>
        <Radio aria-hidden="true" className="live-dot" />
        {reconnecting ? 'Reconnecting to the relay…' : 'Live'}
        {live.locked && (
          <span className="share-locked">
            <Lock aria-hidden="true" /> Locked
          </span>
        )}
      </p>
      <div className="share-field">
        <label className="share-label" htmlFor={linkId}>
          Invite link
        </label>
        <div className="share-link">
          <input id={linkId} className="input" readOnly value={live.inviteUrl} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="btn btn-sm" data-autofocus onClick={() => void copyInvite(live.inviteUrl)}>
            <Copy aria-hidden="true" /> Copy
          </button>
        </div>
      </div>
      <div className="share-time">
        <span>
          {timed ? (
            <>
              Ends in <strong title={spanWords(left)}>{formatSpan(left)}</strong> <span className="share-quiet">at {clockTime(live, live.expiresAt)}</span>
            </>
          ) : (
            <>
              Until you close the project <span className="share-quiet">(at most 24 hours, until {clockTime(live, live.expiresAt)})</span>
            </>
          )}
        </span>
        {extend.length > 0 && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-haspopup="menu"
            aria-expanded={false}
            disabled={reconnecting || busy.has('extend')}
            onClick={(e) =>
              menu.openAt(
                e.currentTarget,
                extend.map((c) => ({ label: c.label, hint: `Until ${clockTime(live, c.expiresAt!)}`, onSelect: () => void go('extend', () => liveCommand(run, (r) => api.live.extend(r, c.expiresAt!))) })),
                'Extend the session'
              )
            }
          >
            Extend
          </button>
        )}
      </div>
      {live.lastError && (
        <p className="share-error" role="alert">
          {live.lastError}
        </p>
      )}
      {waiting.length > 0 && (
        <Group title={`Waiting to join (${waiting.length})`} className="live-waiting">
          {waiting.map((g) => (
            <li key={g.guestId} className="live-row">
              <span className="live-name">
                <strong>{g.displayName}</strong> wants to join
              </span>
              <JoinAnswers run={run} guest={g} disabled={reconnecting} />
            </li>
          ))}
        </Group>
      )}
      <Group title={`In the session (${admitted.length})`} className="live-roster">
        {admitted.length === 0 ? <li className="share-quiet">No one has joined yet. Send the invite link to someone.</li> : admitted.map((g) => <GuestRow key={g.guestId} run={run} live={live} guest={g} at={at} disabled={reconnecting} />)}
      </Group>
      <SwitchRow
        label="Lock room"
        hint="Turns away new join requests. Everyone already here stays."
        checked={live.locked}
        disabled={reconnecting || busy.has('lock')}
        onChange={(locked) => void go('lock', () => liveCommand(run, (r) => api.live.setLocked(r, locked)))}
      />
      <div className="share-foot">
        <button type="button" className="btn btn-sm btn-danger" disabled={busy.has('end')} onClick={() => void go('end', () => liveCommand(run, (r) => api.live.stop(r)))}>
          End session
        </button>
      </div>
      {menu.node}
    </div>
  );
}

function Group({ title, className, children }: { title: string; className: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className={`share-group ${className}`} aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      <ul>{children}</ul>
    </section>
  );
}

function GuestRow({ run, live, guest, at, disabled }: { run: LiveRun; live: LiveRoomState; guest: AdmittedGuest; at: number; disabled: boolean }) {
  const { busy, run: go } = useBusy();
  const off = disabled || busy.size > 0;
  const choices = guestExpiryChoices(live, at);
  // Any end of its own shows as one, so Whole session can always be chosen to clear it.
  const own = guest.guestExpiresAt !== null;
  // A role asked for shows until the roster confirms it (or the command fails), so it is never offered back as a no-op.
  const [asked, setAsked] = useState<GuestRole | null>(null);
  useEffect(() => {
    if (!asked) return;
    if (guest.role === asked) return setAsked(null);
    // One the relay refused never arrives: the roster's role shows again after a while.
    const timer = setTimeout(() => setAsked(null), 10_000);
    return () => clearTimeout(timer);
  }, [asked, guest.role]);
  const timeLeft = guestTimeLeft(live, guest, at);
  return (
    <li className="live-row">
      <span className="live-name">
        <strong>{guest.displayName}</strong>
        {timeLeft && <span className="share-quiet"> · {timeLeft}</span>}
      </span>
      <span className="live-controls">
        <select
          className="select select-sm"
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
          {GUEST_ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>
        <select
          className="select select-sm"
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
        <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove ${guest.displayName}`} disabled={off} onClick={() => void go('kick', () => liveCommand(run, (r) => api.live.kick(r, guest.guestId)))}>
          Remove
        </button>
      </span>
    </li>
  );
}
