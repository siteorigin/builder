import '../panels/SharePopover.css';
import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import type { LiveHostState, LiveRun } from '@shared/api';
import type { GuestRole } from '@shared/live/limits';
import { api, useStore } from '../store';
import { liveCommand, shownLive } from '../lib/live-host';
import { liveRun, waitingGuests, type WaitingGuest } from '../lib/live-session';

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

/** The three answers to a guest waiting to join, the same in the Share popover and in the notice that announces it. */
export function JoinAnswers({ run, guest, disabled }: { run: LiveRun; guest: WaitingGuest; disabled?: boolean }) {
  const { busy, run: go } = useBusy();
  const pending = busy.size > 0 || !!disabled;
  const admit = (role: GuestRole) => go(`admit-${role}`, () => liveCommand(run, (r) => api.live.admit(r, guest.guestId, role, null)));
  return (
    <span className="live-answers" role="group" aria-label={`Answer ${guest.displayName}`}>
      <button type="button" className="btn btn-sm" disabled={pending} onClick={() => void admit('viewer')}>
        Admit as Viewer
      </button>
      <button type="button" className="btn btn-sm" disabled={pending} onClick={() => void admit('collaborator')}>
        Admit as Collaborator
      </button>
      <button type="button" className="btn btn-sm btn-ghost" disabled={pending} onClick={() => void go('decline', () => liveCommand(run, (r) => api.live.decline(r, guest.guestId)))}>
        Decline
      </button>
    </span>
  );
}

/**
 * The guests waiting to join, with the notices (src/renderer/src/components/ui.tsx Toasts), so they are seen whichever
 * panel is open. Each stays until it is answered or the guest goes; none takes focus. While the Share popover is open it
 * lists them itself, so they are not shown twice.
 */
export function JoinRequests() {
  const live = useStore(shownLive);
  const shareOpen = useStore((s) => s.shareOpen);
  return shareOpen ? null : <JoinRequestList live={live} />;
}

/** The waiting room's notices for a session as the editor shows it (none while it is reconnecting: nothing would reach the relay). */
export function JoinRequestList({ live }: { live: LiveHostState }) {
  const run = liveRun(live);
  const waiting = waitingGuests(live);
  if (!run || live.phase !== 'active' || waiting.length === 0) return null;
  return (
    <div className="toast-group" role="region" aria-label="Join requests">
      {waiting.map((g) => (
        <div key={g.guestId} className="toast live-request" role="group" aria-labelledby={`live-request-${g.guestId}`}>
          <UserPlus />
          <div className="grow live-request-body">
            <span className="live-request-title" id={`live-request-${g.guestId}`}>
              <strong>{g.displayName}</strong> wants to join
            </span>
            <JoinAnswers run={run} guest={g} />
          </div>
        </div>
      ))}
    </div>
  );
}
