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
}

/** The pill: how this guest is connected, and how long it has left. */
export function remotePill(remote: AdmittedRemote, now = Date.now()): RemotePill {
  const role = ROLE_LABELS[remote.role];
  const left = remoteLeftMs(remote, now);
  if (remote.reconnecting) return { kind: 'reconnecting', text: 'Reconnecting…', label: `Live session: reconnecting to ${remote.projectName}` };
  if (!remote.hostConnected) return { kind: 'away', text: 'Host away', label: `Live session: the host of ${remote.projectName} is reconnecting` };
  return { kind: 'live', text: `${role} · ${formatSpan(left)}`, label: `Connected to ${remote.projectName} as ${role}, ${spanWords(left)} left` };
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
