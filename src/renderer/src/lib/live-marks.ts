import type { LiveActivity, LivePresence, LiveSpotlight, RemotePresence } from '@shared/api';
import type { Presence } from '@shared/live/messages';
import { refKey, type ElementRef, type ProjectState } from '@shared/types';
import type { State } from '../store';
import { liveFor, liveRun, previewPathOf, sameRun } from './live-session';
import { refExists, refLabel } from './model';
import { admittedRemote, isRemoteShell } from './remote-session';

/**
 * What the others in a live session are doing on the canvas (#768): each participant's color, where a collaborator
 * is and what it has selected, an edit one has just made, and where a guest has just pointed. Pure, from the editor's
 * state, so it is tested on its own; the canvas outlines what this names, and the Share popover lists it.
 *
 * Nothing here is kept: it is all read from what the main process last said of the session shown (`livePresence` for
 * the host, `remotePresence` in a remote shell), which drops a guest the moment it leaves, is removed, stops being a
 * collaborator or loses its connection. While this app's own connection is down, nobody is shown at all.
 */

/** A participant's place in the palette: the slot the relay gave a guest, or the host's own color. */
export type PeerColor = number | 'host';

/** Someone else in the live session the canvas can show. */
export interface Peer {
  /** `host`, or the guest's ID. */
  key: string;
  who: string;
  color: PeerColor;
  /** Where a collaborator (or, in a remote shell, the host) is, as it last said; null for a viewer. */
  presence: Presence | null;
  /** Its latest edit while it is shown; collaborators only. */
  activity: LiveActivity | null;
  /** Where it last pointed while it is shown; only the host is shown guests' spotlights. */
  spotlight: LiveSpotlight | null;
}

const own = <T>(map: Record<string, T> | undefined, key: string): T | null => (map && Object.hasOwn(map, key) ? map[key] : null);

/** The host's session's presence, while it is the session the editor shows and its connection holds the room. */
function hostPresence(s: Pick<State, 'live' | 'livePresence' | 'snapshot'>): LivePresence | null {
  const live = liveFor(s.live, s.snapshot?.workspaceKey);
  if (live.phase !== 'active' || !s.livePresence || !sameRun(liveRun(live), s.livePresence)) return null;
  return s.livePresence;
}

/**
 * Everyone else in the live session the editor shows: as its host, each connected guest (collaborators with where
 * they are, viewers only for their spotlights); in a remote shell, the host while it is connected and each other
 * connected collaborator. Empty with no session, and while this app's own connection is down.
 */
export function livePeers(s: Pick<State, 'live' | 'livePresence' | 'remote' | 'remotePresence' | 'snapshot'>): Peer[] {
  if (isRemoteShell(s)) {
    const remote = admittedRemote(s);
    if (!remote || remote.reconnecting) return [];
    const at = s.remotePresence && s.remotePresence.joinId === remote.joinId ? s.remotePresence : null;
    const others = remote.participants.filter((p) => p.guestId !== remote.guestId && p.connected && p.role === 'collaborator');
    return [
      ...(remote.hostConnected ? [{ key: 'host', who: 'Host', color: 'host' as const, presence: at?.host ?? null, activity: null, spotlight: null }] : []),
      ...others.map((p): Peer => ({ key: p.guestId, who: p.displayName, color: p.colorSlot, presence: own(at?.guests, p.guestId), activity: own(at?.activity, p.guestId), spotlight: null }))
    ];
  }
  const at = hostPresence(s);
  const live = liveFor(s.live, s.snapshot?.workspaceKey);
  if (!at || live.phase !== 'active') return [];
  return live.participants.flatMap((p): Peer[] => {
    if (p.status !== 'admitted' || !p.connected) return [];
    const collaborator = p.role === 'collaborator';
    return [{ key: p.guestId, who: p.displayName, color: p.colorSlot, presence: collaborator ? own(at.guests, p.guestId) : null, activity: collaborator ? own(at.activity, p.guestId) : null, spotlight: own(at.spotlights, p.guestId) }];
  });
}

/** Where the canvas is: the page it shows (null for anything else), and that place's address in the preview. */
export interface Here {
  pageId: string | null;
  previewPath: string | null;
}

/** Something of someone else's the canvas outlines: an element, or (a spotlight on nothing named) a point. */
export interface CanvasMark {
  /** Stable while it names the same thing, and new for each spotlight and edit, so each is drawn from its start. */
  key: string;
  peer: string;
  who: string;
  color: PeerColor;
  kind: 'selection' | 'edit' | 'spotlight';
  ref: ElementRef | null;
  /** Where a spotlight landed, as shares of the page's whole width and height. */
  point: { x: number; y: number } | null;
  /** A selection whose collaborator has just edited what it selected. */
  editing: boolean;
  /** What is outlined, in words: for a screen reader, and the outline's title. */
  label: string;
}

/** A guest pointed at another place than the canvas shows: the host is offered the page, when it is one. */
export interface SpotlightAway {
  key: string;
  peer: string;
  who: string;
  color: PeerColor;
  /** The page it is on, to go to; null when the address is no page of the project. */
  pageId: string | null;
  /** The place, in words: the page's title, or its address. */
  place: string;
}

/** A reference of someone else's the canvas can outline: one still in the project, on the page shown or its shell. */
function outlinable(state: ProjectState, ref: ElementRef | null | undefined, pageId: string | null): ref is ElementRef {
  if (!ref || !pageId) return false;
  if (!(ref.owner.kind === 'page' && ref.owner.id === pageId) && ref.owner.kind !== 'shell') return false;
  try {
    return refExists(state, ref);
  } catch {
    return false;
  }
}

const labelOf = (state: ProjectState, ref: ElementRef) => {
  try {
    return refLabel(state, ref);
  } catch {
    return 'an element';
  }
};

/** The page whose address in the preview is `path`, if any: by own pages only. */
export function pageAtPath(state: ProjectState, path: string): string | null {
  for (const [id, page] of Object.entries(state.pages)) if (typeof page.route === 'string' && previewPathOf(page.route) === path) return id;
  return null;
}

/**
 * What the canvas shows of the others, where it is: each collaborator's selection on this page (or its header or
 * footer, while they are on this page too), the element each just edited here, and each spotlight on this place; and,
 * apart, each spotlight on another place, for a prompt to go there. A selection just edited says so on its own
 * outline; an edit of something else shows as its own brief outline.
 */
export function canvasMarks(state: ProjectState, here: Here, peers: Peer[]): { marks: CanvasMark[]; away: SpotlightAway[] } {
  const marks: CanvasMark[] = [];
  const away: SpotlightAway[] = [];
  for (const peer of peers) {
    const base = { peer: peer.key, who: peer.who, color: peer.color };
    const selection = peer.presence?.pageId && peer.presence.pageId === here.pageId && outlinable(state, peer.presence.selection, here.pageId) ? peer.presence.selection : null;
    const edited = peer.activity && outlinable(state, peer.activity.target, here.pageId) ? peer.activity.target : null;
    if (selection) {
      const editing = !!edited && refKey(edited) === refKey(selection);
      marks.push({ ...base, key: `sel:${peer.key}:${refKey(selection)}`, kind: 'selection', ref: selection, point: null, editing, label: `${peer.who}: ${labelOf(state, selection)}${editing ? ', editing' : ''}` });
    }
    if (edited && (!selection || refKey(edited) !== refKey(selection))) marks.push({ ...base, key: `edit:${peer.key}:${peer.activity!.seq}`, kind: 'edit', ref: edited, point: null, editing: true, label: `${peer.who} edited ${labelOf(state, edited)}` });
    const spot = peer.spotlight;
    if (!spot) continue;
    const { previewPath, target, x, y } = spot.spotlight;
    if (here.previewPath !== null && previewPath === here.previewPath) {
      const ref = outlinable(state, target, here.pageId) ? target : null;
      marks.push({ ...base, key: `spot:${peer.key}:${spot.seq}`, kind: 'spotlight', ref, point: { x, y }, editing: false, label: `${peer.who} pointed at ${ref ? labelOf(state, ref) : 'this spot'}` });
    } else {
      const pageId = pageAtPath(state, previewPath);
      away.push({ ...base, key: `away:${peer.key}:${spot.seq}`, pageId, place: pageId ? state.pages[pageId].title : previewPath });
    }
  }
  return { marks, away };
}

/** The CSS color a participant is shown in. */
export const peerColor = (color: PeerColor) => (color === 'host' ? 'var(--peer-host)' : `var(--peer-${color % 8})`);

/** Whether two lists of marks would be drawn the same: the canvas keeps the one it has otherwise. */
export const sameMarks = (a: CanvasMark[], b: CanvasMark[]) => a.length === b.length && a.every((m, i) => m.key === b[i].key && m.editing === b[i].editing && m.label === b[i].label);
