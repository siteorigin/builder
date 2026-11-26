import '../panels/RemoteSession.css';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Users } from 'lucide-react';
import { DISPLAY_NAME_MAX } from '@shared/live/limits';
import { normalizeDisplayName } from '@shared/live/messages';
import { parseInviteLink } from '@shared/live/relay-url';
import { projectDisplayName } from '@shared/project-name';
import { getState, setState, useStore } from '../store';
import { isRemoteShell, joinLive, leaveLive } from '../lib/remote-session';
import { Field, Modal, Spinner } from './ui';

/**
 * Join live session (#766): paste the invite link a host shared, give the name the host will see, and wait in the
 * room until the host lets this app in. Opened from the Welcome screen and the File menu. A project of this
 * computer's that is open is closed first, as Close Project closes it. Once the host lets the guest in, the editor
 * opens the host's project and the dialog closes; a refusal or an ending while waiting is said here.
 */

/** The name last given, so the next join offers it again on this computer. */
const NAME_KEY = 'siteorigin-live-name';
const rememberedName = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
};
const rememberName = (name: string) => {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Kept for this time only.
  }
};

/** What is wrong with the form as typed, field by field. */
export function joinProblems(inviteLink: string, displayName: string): { link?: string; name?: string } {
  const problems: { link?: string; name?: string } = {};
  if (!parseInviteLink(inviteLink)) problems.link = inviteLink.trim() ? 'That is not a live session invite link. Paste the whole link the host shared, such as https://live.siteorigin.com/s/….' : 'Paste the invite link the host shared.';
  if (!normalizeDisplayName(displayName)) problems.name = displayName.trim() ? `Use up to ${DISPLAY_NAME_MAX} letters, numbers or symbols.` : 'Enter the name the host will see.';
  return problems;
}

export function JoinLiveDialog() {
  const asked = useStore((s) => s.joinOpen);
  const shell = useStore(isRemoteShell);
  // A join under way always shows its dialog, also over an editor that was loaded again meanwhile, so the waiting
  // room is never left without a way to stop asking.
  const joining = useStore((s) => s.remote.phase !== 'idle' && !isRemoteShell(s));
  const open = asked || joining;
  // Once the host's project is shown, the dialog has done its work.
  useEffect(() => {
    if (asked && shell) setState({ joinOpen: false });
  }, [asked, shell]);
  if (!open || shell) return null;
  return <JoinLiveForm />;
}

function JoinLiveForm() {
  const remote = useStore((s) => s.remote);
  const localProject = useStore((s) => (s.snapshot && !isRemoteShell(s) ? projectDisplayName(s.snapshot.state) : null));
  const [inviteLink, setInviteLink] = useState('');
  const [displayName, setDisplayName] = useState(rememberedName);
  const [shown, setShown] = useState<{ link?: string; name?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Whether this dialog asked to join, so an ending it sees is its own join's.
  const asked = useRef(false);
  const linkRef = useRef<HTMLInputElement>(null);
  const statusId = useId();
  const inRoom = remote.phase === 'joining' || remote.phase === 'waiting' || remote.phase === 'admitted';

  useEffect(() => linkRef.current?.focus(), []);
  // A join that ended while this dialog waited says why here, and the form is offered again.
  useEffect(() => {
    if (remote.phase === 'idle' && asked.current && remote.ended && remote.ended.reason !== 'left') setFailure(remote.ended.message);
  }, [remote]);

  const close = () => {
    if (inRoom) void leaveLive();
    setState({ joinOpen: false });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting || inRoom) return;
    const problems = joinProblems(inviteLink, displayName);
    setShown(problems);
    if (problems.link || problems.name) return;
    setFailure(null);
    setSubmitting(true);
    asked.current = true;
    const name = normalizeDisplayName(displayName)!;
    rememberName(name);
    // Cancel while a project of this computer's closes calls the join off.
    const result = await joinLive(inviteLink.trim(), name, () => getState().joinOpen);
    setSubmitting(false);
    // The dialog was closed meanwhile: whatever came of it is the session's to show.
    if (!getState().joinOpen) return;
    if (!result.ok) setFailure(result.message);
  };

  // A project too large to send over the relay cannot be opened here, however long the guest waits.
  const tooLarge = remote.phase === 'admitted' && remote.tooLarge;
  const status = tooLarge
    ? ''
    : remote.phase === 'joining'
      ? 'Connecting to the live session…'
      : remote.phase === 'waiting'
        ? remote.hostConnected
          ? 'Waiting for the host to let you in…'
          : 'Waiting for the host to let you in. The host is reconnecting…'
        : remote.phase === 'admitted'
          ? `Opening ${remote.projectName}…`
          : submitting
            ? localProject
              ? `Closing ${localProject}…`
              : 'Connecting to the live session…'
            : '';

  return (
    <Modal
      title="Join live session"
      icon={<Users />}
      onClose={close}
      describedBy={statusId}
      footer={
        <>
          <span className="foot-note" role="status" id={statusId}>
            {status && (
              <>
                <Spinner decorative />
                <span className="ellipsis">{status}</span>
              </>
            )}
          </span>
          <button type="button" className="btn" onClick={close}>
            {inRoom ? 'Stop asking' : 'Cancel'}
          </button>
          <button type="submit" form="join-live-form" className="btn btn-primary" disabled={submitting || inRoom}>
            Ask to join
          </button>
        </>
      }
    >
      <form id="join-live-form" className="join-live" noValidate onSubmit={(e) => void submit(e)}>
        <p className="muted">
          Edit a website with its host, live, from this computer. The project stays on the host’s computer: you see it here while the session lasts, and the host decides whether you can edit or only watch.
        </p>
        <Field label="Invite link" error={shown.link}>
          <input
            ref={linkRef}
            type="url"
            value={inviteLink}
            disabled={inRoom || submitting}
            spellCheck={false}
            autoComplete="off"
            placeholder="https://live.siteorigin.com/s/…"
            onChange={(e) => {
              setInviteLink(e.target.value);
              if (shown.link) setShown({ ...shown, link: undefined });
            }}
          />
        </Field>
        <Field label="Your name" hint="The host sees this when you ask to join." error={shown.name}>
          <input
            type="text"
            value={displayName}
            disabled={inRoom || submitting}
            autoComplete="name"
            maxLength={DISPLAY_NAME_MAX * 2}
            onChange={(e) => {
              setDisplayName(e.target.value);
              if (shown.name) setShown({ ...shown, name: undefined });
            }}
          />
        </Field>
        {localProject && !inRoom && <p className="muted">Joining closes {localProject} first. What you are typing in it is saved.</p>}
        {tooLarge && (
          <p className="error" role="alert">
            The host’s project is too large to share in a live session, so it cannot be opened here. Ask the host to share it again once it is smaller, or to send you its preview link to watch it.
          </p>
        )}
        {failure && !inRoom && (
          <p className="error" role="alert">
            {failure}
          </p>
        )}
      </form>
    </Modal>
  );
}
