import type { RemotePresence } from '@shared/api';
import type { Presence } from '@shared/live/messages';
import type { ProjectState } from '@shared/types';
import { ROLE_LABELS, formatSpan, spanWords } from './live-session';
import { refLabel } from './model';
import type { AdmittedRemote } from './remote-snapshot';

/**
 * What the remote shell's toolbar says about the live session this app is a guest in (#766): its pill, the time
 * left, and where the host and the other collaborators are. Pure, so it is tested on its own.
 */

/** When this guest's access ends, on the relay's clock: its own deadline or the session's, whichever is first. */
export const remoteEndsAt = (remote: AdmittedRemote) => (remote.guestExpiresAt === null ? remote.sessionExpiresAt : Math.min(remote.guestExpiresAt, remote.sessionExpiresAt));

/** The relay's time now, from what the main process last measured of its clock. */
export const remoteNow = (remote: AdmittedRemote, now = Date.now()) => now + remote.relayClockOffsetMs;

/** How long this guest has left, never below zero. */
export const remoteLeftMs = (remote: AdmittedRemote, now = Date.now()) => Math.max(0, remoteEndsAt(remote) - remoteNow(remote, now));

export interface RemotePill {
  kind: 'live' | 'reconnecting' | 'away';
  /** The pill's words. */
  text: string;
  /** Its fuller words, for its name and title. */
  label: string;
  /** The line under the project's name in the pill's menu: the role and the time left in words, or what is wrong. */
  detail: string;
  /** What changed about the connection, for a screen reader: the role or the trouble, never the minutes left. */
  announce: string;
}

/** The pill: how this guest is connected, and how long it has left. */
export function remotePill(remote: AdmittedRemote, now = Date.now()): RemotePill {
  const role = ROLE_LABELS[remote.role];
  const left = remoteLeftMs(remote, now);
  if (remote.reconnecting) return { kind: 'reconnecting', text: 'Reconnecting…', label: `Live session: reconnecting to ${remote.projectName}`, detail: 'Your connection dropped. Reconnecting…', announce: `Reconnecting to the live session of ${remote.projectName}.` };
  if (!remote.hostConnected) return { kind: 'away', text: 'Host away', label: `Live session: the host of ${remote.projectName} is reconnecting`, detail: remote.role === 'collaborator' ? 'The host is reconnecting. Your editing waits for them.' : 'The host is reconnecting.', announce: `The host of ${remote.projectName} is reconnecting.` };
  return { kind: 'live', text: `${role} · ${formatSpan(left)} left`, label: `Connected to ${remote.projectName} as ${role}, ${spanWords(left)} left`, detail: `${role} · ${spanWords(left)} left`, announce: `Connected to ${remote.projectName} as ${role}.` };
}

/** What a participant is on, in the host's project as this guest holds it: the page, and what is selected there. */
export function presenceWhere(state: ProjectState, presence: Presence): string {
  const page = presence.pageId && Object.hasOwn(state.pages, presence.pageId) ? state.pages[presence.pageId].title : null;
  let selected: string | null = null;
  if (presence.selection) {
    try {
      selected = refLabel(state, presence.selection);
    } catch {
      // What they selected has gone from the project as this guest holds it.
      selected = null;
    }
  }
  if (page && selected) return `${selected} on ${page}`;
  if (page) return page;
  if (selected) return selected;
  return 'Elsewhere in the project';
}

export interface PresenceLine {
  /** Stable for the list: `host`, or the guest's ID. */
  key: string;
  who: string;
  where: string;
  /** The page they are on, for a Go to page, when this guest's project has it. */
  pageId: string | null;
}

/**
 * Who is where: the host first, then each other collaborator the relay lists, by name. This guest is never listed,
 * and nor is anyone the relay no longer lists as a collaborator.
 */
export function presenceLines(state: ProjectState, remote: AdmittedRemote, presence: RemotePresence | null): PresenceLine[] {
  if (!presence || presence.joinId !== remote.joinId) return [];
  const lines: PresenceLine[] = [];
  const page = (p: Presence) => (p.pageId && Object.hasOwn(state.pages, p.pageId) ? p.pageId : null);
  if (presence.host) lines.push({ key: 'host', who: 'Host', where: presenceWhere(state, presence.host), pageId: page(presence.host) });
  for (const participant of remote.participants) {
    if (participant.guestId === remote.guestId || participant.role !== 'collaborator') continue;
    const at = presence.guests[participant.guestId];
    if (at) lines.push({ key: participant.guestId, who: participant.displayName, where: presenceWhere(state, at), pageId: page(at) });
  }
  return lines;
}

export interface RosterLine extends PresenceLine {
  /** A viewer: in the session, following the host's work, with no place of their own in it. */
  watching: boolean;
}

/**
 * Everyone else in the live session, as the pill's menu lists them and its count counts them: the host while it is
 * connected, each other collaborator the relay lists, then the viewers. Where each collaborator is comes from their
 * presence when it has arrived, so someone who has yet to say where they are is listed all the same.
 */
export function remoteRoster(state: ProjectState, remote: AdmittedRemote, presence: RemotePresence | null): RosterLine[] {
  const at = presence && presence.joinId === remote.joinId ? presence : null;
  const page = (p: Presence) => (p.pageId && Object.hasOwn(state.pages, p.pageId) ? p.pageId : null);
  const line = (key: string, who: string, p: Presence | null | undefined): RosterLine => ({ key, who, where: p ? presenceWhere(state, p) : 'Location not known yet', pageId: p ? page(p) : null, watching: false });
  const others = remote.participants.filter((p) => p.guestId !== remote.guestId);
  return [
    ...(remote.hostConnected ? [line('host', 'Host', at?.host)] : []),
    ...others.filter((p) => p.role === 'collaborator').map((p) => line(p.guestId, p.displayName, at?.guests[p.guestId])),
    ...others.filter((p) => p.role !== 'collaborator').map((p): RosterLine => ({ key: p.guestId, who: p.displayName, where: p.role === 'copy-editor' ? 'Editing copy' : 'Watching', pageId: null, watching: true }))
  ];
}
