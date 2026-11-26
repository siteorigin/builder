import './RemoteSession.css';
import { useEffect, useState } from 'react';
import { LogOut, Radio } from 'lucide-react';
import { useStore } from '../store';
import { useMenu, type MenuItem } from '../components/ui';
import { selectPage } from '../lib/actions';
import { admittedRemote, leaveLive } from '../lib/remote-session';
import { presenceLines, remoteLeftMs, remotePill } from '../lib/remote-view';

/**
 * The remote shell's place in the toolbar (#766), where a host has Share and Export: how this app is connected to the
 * host's live session (as a collaborator or a viewer, and for how long), who else is where in it, and Leave session.
 */
export function RemoteSessionControl({ compact }: { compact?: boolean }) {
  const remote = useStore(admittedRemote);
  const presence = useStore((s) => s.remotePresence);
  const state = useStore((s) => s.snapshot?.state ?? null);
  const menu = useMenu();
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
  const lines = presenceLines(state, remote, presence);
  const others = lines.length;
  const items: MenuItem[] = [
    { heading: remote.projectName },
    { label: pill.label, disabled: true },
    ...(lines.length ? [{ heading: 'Where everyone is' }, ...lines.map((l): MenuItem => ({ label: `${l.who}: ${l.where}`, disabled: !l.pageId, ...(l.pageId ? { hint: 'Go to page', onSelect: () => selectPage(l.pageId!) } : {}) }))] : []),
    { separator: true },
    { label: 'Leave session', icon: <LogOut />, onSelect: () => void leaveLive() }
  ];
  return (
    <div className="remote-session">
      <button
        className={`remote-pill ${pill.kind}`}
        aria-haspopup="menu"
        aria-expanded={false}
        aria-label={`${pill.label}${others ? `, ${others === 1 ? 'one other' : `${others} others`} here` : ''}. Show who is where`}
        title={pill.label}
        onClick={(e) => menu.openAt(e.currentTarget, items, 'Live session')}
      >
        <Radio aria-hidden="true" />
        {!compact && <span className="ellipsis">{pill.text}</span>}
        {others > 0 && <span className="remote-count">{others}</span>}
      </button>
      <button className="btn btn-sm remote-leave" title={`Leave the live session of ${remote.projectName}`} onClick={() => void leaveLive()}>
        <LogOut aria-hidden="true" /> Leave session
      </button>
      {menu.node}
    </div>
  );
}
