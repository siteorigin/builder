import '../panels/RemoteSession.css';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { CircleAlert, Hourglass, Info, Users } from 'lucide-react';
import { DISPLAY_NAME_MAX } from '@shared/live/limits';
import { normalizeDisplayName } from '@shared/live/messages';
import { formatInviteLink, parseInviteLink } from '@shared/live/relay-url';
import { projectDisplayName } from '@shared/project-name';
import { getState, setState, useStore, whenThemesReady } from '../store';
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

/** The invite link a join was made from, for the form to show it again. */
const safeInviteLink = (relayUrl: string, roomId: string) => {
  try {
    return formatInviteLink(relayUrl, roomId);
  } catch {
    return '';
  }
};

/** What is wrong with the form as typed, field by field. */
export function joinProblems(inviteLink: string, displayName: string): { link?: string; name?: string } {
  const problems: { link?: string; name?: string } = {};
  if (!parseInviteLink(inviteLink)) problems.link = inviteLink.trim() ? 'That is not a live session invite link. Paste the whole link the host shared, such as https://live.siteorigin.com/s/…' : 'Paste the invite link the host shared.';
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
  const joinId = useStore((s) => (s.remote.phase !== 'idle' ? s.remote.joinId : null));
  // A request found under way when the editor loads again (no dialog asked for it) becomes this dialog's own, so its
  // answer (a refusal, an ending) is said here rather than lost with it. One the guest closed stays closed.
  const adopted = useRef<string | null>(null);
  useEffect(() => {
    if (!joinId || shell) return;
    if (asked) adopted.current = joinId;
    else if (adopted.current !== joinId) {
      adopted.current = joinId;
      setState({ joinOpen: true });
    }
  }, [joinId, asked, shell]);
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
  // A join found under way (the editor loaded again meanwhile) fills the form with its own link and name, so a refusal
  // leaves them there to ask again.
  const [inviteLink, setInviteLink] = useState(() => (remote.phase !== 'idle' ? safeInviteLink(remote.relayUrl, remote.roomId) : ''));
  const [displayName, setDisplayName] = useState(() => (remote.phase !== 'idle' ? remote.displayName : rememberedName()));
  // What the last Ask to join found to fix, said once as it is pressed (not again as each field is corrected).
  const [problemSaid, setProblemSaid] = useState('');
  const [shown, setShown] = useState<{ link?: string; name?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const declined = !!failure && remote.phase === 'idle' && remote.ended?.reason === 'declined';
  const [submitting, setSubmitting] = useState(false);
  // Each Ask to join that finds something to fix: the first such field then takes focus, once it is marked invalid.
  const [fixes, setFixes] = useState(0);
  // Whether this dialog asked to join, so an ending it sees is its own join's: also one it found under way as it opened.
  const asked = useRef(remote.phase !== 'idle');
  // Each Ask to join is an attempt of its own; Cancel calls off the one under way, whatever dialog opens next.
  const attempt = useRef(0);
  const linkRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const askRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const statusId = useId();
  const inRoom = remote.phase === 'joining' || remote.phase === 'waiting' || remote.phase === 'admitted';

  useEffect(() => linkRef.current?.focus(), []);
  useEffect(() => {
    if (!fixes) return;
    if (shown.link) linkRef.current?.focus();
    else if (shown.name) nameRef.current?.focus();
  }, [fixes]); // eslint-disable-line react-hooks/exhaustive-deps
  // A join that ended while this dialog waited says why here, and the form is offered again.
  useEffect(() => {
    if (remote.phase === 'idle' && asked.current && remote.ended && remote.ended.reason !== 'left') setFailure(remote.ended.message);
  }, [remote]);

  const close = () => {
    attempt.current++;
    // A request already on its way is given up too, so the host never sees one the guest cancelled.
    if (inRoom || submitting) void leaveLive();
    setState({ joinOpen: false });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting || inRoom) return;
    const problems = joinProblems(inviteLink, displayName);
    setShown(problems);
    setProblemSaid(problems.link ?? problems.name ?? '');
    if (problems.link || problems.name) {
      setFixes((n) => n + 1);
      return;
    }
    setFailure(null);
    setSubmitting(true);
    asked.current = true;
    const name = normalizeDisplayName(displayName)!;
    rememberName(name);
    // Cancel while a project of this computer's closes, or while the request goes out, calls the join off.
    const mine = ++attempt.current;
    // A guest's editor shows the host's project with this computer's themes: none is joined before they are in.
    await whenThemesReady();
    const result = await joinLive(inviteLink.trim(), name, () => attempt.current === mine);
    setSubmitting(false);
    // The dialog was closed meanwhile: whatever came of it is the session's to show.
    if (!getState().joinOpen) return;
    if (!result.ok) setFailure(result.message);
  };

  // A project too large to send over the relay cannot be opened here, however long the guest waits.
  const tooLarge = remote.phase === 'admitted' && remote.tooLarge;
  // From Ask to join until the host's answer, the dialog is the waiting room: the form gives way to what is happening.
  const waiting = !tooLarge && (inRoom || submitting);
  const asker = remote.phase !== 'idle' ? remote.displayName : normalizeDisplayName(displayName) ?? displayName.trim();
  const status = tooLarge
    ? ''
    : remote.phase === 'joining'
      ? 'Connecting to the live session…'
      : remote.phase === 'waiting'
        ? 'Waiting for the host to let you in…'
        : remote.phase === 'admitted'
          ? `Opening ${remote.projectName}…`
          : submitting
            ? localProject
              ? `Closing ${localProject}…`
              : 'Connecting to the live session…'
            : '';
  const hostAway = remote.phase === 'waiting' && !remote.hostConnected;
  // In the form, what Ask to join found to fix is said too, for a press made from the field that is already focused.
  const said = !tooLarge && !(inRoom || submitting) ? problemSaid : hostAway ? `${status} The host is reconnecting.` : status;

  // Focus follows the dialog's state: Stop asking while in the room, Ask to join once the form is offered again (after a
  // refusal), so the one thing to do next is always where the keyboard is.
  const mode = tooLarge ? 'too-large' : waiting ? 'waiting' : 'form';
  const lastMode = useRef(mode);
  useEffect(() => {
    if (lastMode.current === mode) return;
    lastMode.current = mode;
    if (mode === 'waiting' || mode === 'too-large') stopRef.current?.focus();
    else askRef.current?.focus();
  }, [mode]);

  return (
    <Modal
      title="Join live session"
      icon={<Users />}
      onClose={close}
      describedBy={statusId}
      // A click beside the dialog never gives up a request under way: only Stop asking, Esc or Close does.
      dismissOnBackdrop={mode === 'form'}
      footer={
        <>
          {/* Said as it changes; the room below shows the same words. */}
          <span className="sr-only" role="status" id={statusId}>
            {said}
          </span>
          {mode === 'form' ? (
            <>
              <button type="button" className="btn" onClick={close}>
                Cancel
              </button>
              <button ref={askRef} type="submit" form="join-live-form" className="btn btn-primary">
                Ask to join
              </button>
            </>
          ) : (
            <button ref={stopRef} type="button" className="btn" onClick={close}>
              {tooLarge ? 'Close' : remote.phase === 'waiting' ? 'Stop asking' : 'Cancel'}
            </button>
          )}
        </>
      }
    >
      {mode === 'waiting' ? (
        <div className="join-wait">
          <Spinner large decorative />
          <h3>{status}</h3>
          {asker &&
            (remote.phase === 'waiting' && !hostAway ? (
              <p>
                Asking as <span className="join-asker">{asker}</span>. The host sees your request and decides whether you can edit or only watch.
              </p>
            ) : (
              <p>
                {remote.phase === 'waiting' ? 'Asking' : 'Joining'} as <span className="join-asker">{asker}</span>.
              </p>
            ))}
          {hostAway && (
            <div className="scope-note site">
              <Hourglass aria-hidden="true" />
              <span>The host is reconnecting. Your request waits for them, and you can stop asking at any time.</span>
            </div>
          )}
        </div>
      ) : mode === 'too-large' ? (
        <div className="join-live">
          <div className="scope-note danger" role="alert">
            <CircleAlert aria-hidden="true" />
            <span>The host’s project is too large to share in a live session, so it cannot be opened here. Ask the host to share it again once it is smaller, or to send you its preview link to watch it.</span>
          </div>
        </div>
      ) : (
        <form id="join-live-form" className="join-live" noValidate onSubmit={(e) => void submit(e)}>
          <p className="muted">
            Edit a website with its host, live, from this computer. The project stays on the host’s computer: you see it here while the session lasts, and the host decides whether you can edit or only watch.
          </p>
          {failure && (
            <div className="scope-note danger" role="alert">
              <CircleAlert aria-hidden="true" />
              <span>{failure}{declined && ' You can ask again, or check with the host first.'}</span>
            </div>
          )}
          <Field label="Invite link" error={shown.link}>
            <input
              ref={linkRef}
              className="input"
              type="url"
              value={inviteLink}
              spellCheck={false}
              autoComplete="off"
              placeholder="https://live.siteorigin.com/s/…"
              onChange={(e) => {
                setInviteLink(e.target.value);
                setProblemSaid('');
                // Once Ask to join has found it wrong, it is checked again as it is corrected: the error goes when it is right.
                if (shown.link) setShown({ ...shown, link: joinProblems(e.target.value, displayName).link });
              }}
            />
          </Field>
          <Field label="Your name" hint="The host sees this when you ask to join." error={shown.name}>
            <input
              ref={nameRef}
              className="input"
              type="text"
              value={displayName}
              autoComplete="name"
              maxLength={DISPLAY_NAME_MAX * 2}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setProblemSaid('');
                if (shown.name) setShown({ ...shown, name: joinProblems(inviteLink, e.target.value).name });
              }}
            />
          </Field>
          {localProject && (
            <div className="scope-note info">
              <Info aria-hidden="true" />
              <span>
                Joining closes <strong>{localProject}</strong> before your request is sent. Its changes are saved first, or you are asked what to do with them.
              </span>
            </div>
          )}
        </form>
      )}
    </Modal>
  );
}
