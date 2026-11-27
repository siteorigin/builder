import './RemoteSession.css';
import { useEffect, useRef, useState } from 'react';
import { Hourglass, LogOut, Radio, RefreshCw, Users } from 'lucide-react';
import { getState, useStore } from '../store';
import { useMenu, type MenuItem } from '../components/ui';
import { selectPage } from '../lib/actions';
import { admittedRemote, confirmLeaveLive } from '../lib/remote-session';
import { remoteLeftMs, remotePill, remoteRoster } from '../lib/remote-view';

/**
 * The remote shell's place in the toolbar (#766), where a host has Share and Export: how this app is connected to the
 * host's live session (as a collaborator or a viewer, and for how long), who else is where in it, and Leave session.
 * Like the host's Share pill, its state reads in words and a glyph of its own at every width, never by hue alone; in
 * the narrower tiers Leave session gives up its words first.
 */
export function RemoteSessionControl({ compact }: { compact?: boolean }) {
  const remote = useStore(admittedRemote);
  const presence = useStore((s) => s.remotePresence);
  const state = useStore((s) => s.snapshot?.state ?? null);
  const pageId = useStore((s) => s.pageId);
  const menu = useMenu();
  const pillRef = useRef<HTMLButtonElement>(null);
  // The menu says how this guest is connected and who is here as it opened: when that changes (the connection drops,
  // the host goes, the role changes), an open one closes, so the next look at it is the current one.
  const standing = remote ? `${remote.role} ${remote.reconnecting} ${remote.hostConnected}` : '';
  const lastStanding = useRef(standing);
  useEffect(() => {
    if (lastStanding.current === standing) return;
    lastStanding.current = standing;
    if (menu.isOpen) {
      menu.close();
      pillRef.current?.focus();
    }
  }, [standing, menu]);
  const [, tick] = useState(0);
  // The time left is redrawn as it changes: each minute, and each second in the last one.
  const left = remote ? remoteLeftMs(remote) : 0;
  useEffect(() => {
    if (!remote) return;
    const timer = setTimeout(() => tick((n) => n + 1), left <= 60_000 ? 1000 : Math.min(60_000, (left % 60_000 || 60_000) + 50));
    return () => clearTimeout(timer);
  });
  if (!remote || !state) return null;
  const pill = remotePill(remote);
  // While this guest's own connection is down it cannot know who is there, so it claims nobody.
  const roster = pill.kind === 'reconnecting' ? [] : remoteRoster(state, remote, presence);
  const others = roster.length;
  // Go to page follows the person, not the page they were on when the menu opened: they may have moved since.
  const goTo = (key: string) => {
    const s = getState();
    const now = admittedRemote(s);
    const line = now && s.snapshot ? remoteRoster(s.snapshot.state, now, s.remotePresence).find((l) => l.key === key) : null;
    if (line?.pageId) selectPage(line.pageId);
  };
  const items: MenuItem[] = [
    { heading: remote.projectName },
    { heading: pill.detail },
    ...(roster.length
      ? [
          { separator: true },
          { heading: 'Where everyone is' },
          ...roster.map((l): MenuItem =>
            l.watching
              ? { label: l.who, hint: 'Watching', disabled: true }
              : l.pageId && l.pageId === pageId
                ? { label: `${l.who}: ${l.where}`, hint: 'Same page as you', disabled: true }
                : { label: `${l.who}: ${l.where}`, disabled: !l.pageId, ...(l.pageId ? { hint: 'Go to page', onSelect: () => goTo(l.key) } : {}) }
          )
        ]
      : []),
    { separator: true },
    { label: 'Leave session…', icon: <LogOut />, onSelect: () => void confirmLeaveLive() }
  ];
  const Glyph = pill.kind === 'reconnecting' ? RefreshCw : pill.kind === 'away' ? Hourglass : Radio;
  return (
    <div className="remote-session">
      <button
        ref={pillRef}
        type="button"
        className={`btn btn-sm remote-pill ${pill.kind}`}
        aria-haspopup="menu"
        // useMenu sets aria-expanded on the trigger itself while its menu is open.
        aria-expanded={false}
        aria-label={`${pill.label}${others ? `, ${others === 1 ? 'one other' : `${others} others`} here` : ''}. Show who is where`}
        title={pill.label}
        onClick={(e) => menu.openAt(e.currentTarget, items, 'Live session')}
      >
        <Glyph aria-hidden="true" className="remote-glyph" />
        <span className="ellipsis">{pill.text}</span>
        {others > 0 && (
          <span className="remote-count" aria-hidden="true">
            <Users />
            {others}
          </span>
        )}
      </button>
      {/* What the connection is now, said once as it changes: never the minutes ticking down. */}
      <span className="sr-only" role="status">
        {pill.announce}
      </span>
      <button
        type="button"
        className={`btn btn-sm remote-leave${compact ? ' icon-only' : ''}`}
        title={`Leave the live session of ${remote.projectName}`}
        aria-label={compact ? 'Leave session' : undefined}
        onClick={() => void confirmLeaveLive()}
      >
        <LogOut aria-hidden="true" />
        {!compact && 'Leave session'}
      </button>
      {menu.node}
    </div>
  );
}
