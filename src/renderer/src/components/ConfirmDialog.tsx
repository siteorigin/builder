import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Ban, Bookmark, CircleMinus, Code, Globe, Info, KeyRound, LockOpen, LogOut, Mail, Phone, RotateCcw, ShieldCheck, SquarePen, TextCursorInput, Trash2, TriangleAlert, Undo2 } from 'lucide-react';
import { getConfirm, onConfirmChange, type ConfirmDetail, type ConfirmIcon, type ConfirmRequest } from '../store';
import { Modal, openDialogs, openMenus } from './ui';

const ICONS: Record<ConfirmIcon, ReactNode> = {
  delete: <Trash2 />,
  discard: <Trash2 />,
  revert: <RotateCcw />,
  replace: <SquarePen />,
  unlock: <LockOpen />,
  leave: <LogOut />,
  key: <KeyRound />,
  web: <Globe />,
  email: <Mail />,
  phone: <Phone />,
  warning: <TriangleAlert />
};

const DETAIL_ICONS: Record<ConfirmDetail['kind'], ReactNode> = {
  lose: <CircleMinus />,
  risk: <TriangleAlert />,
  keep: <ShieldCheck />,
  undo: <Undo2 />,
  final: <Ban />,
  note: <Info />
};

const SUBJECT_ICONS: Record<NonNullable<ConfirmRequest['subjectKind']>, ReactNode> = {
  version: <Bookmark />,
  component: <Code />,
  field: <TextCursorInput />,
  web: <Globe />,
  email: <Mail />,
  phone: <Phone />
};

const isAddress = (kind: NonNullable<ConfirmRequest['subjectKind']>) => kind === 'web' || kind === 'email' || kind === 'phone';

/** How much is at stake: an explicit tone, else the old `danger` flag. */
const toneOf = (req: ConfirmRequest) => req.tone ?? (req.danger ? 'danger' : 'neutral');

/** A web address with its site set apart, so the place it opens is the first thing read. */
function Address({ href }: { href: string }) {
  let host = '';
  try {
    host = new URL(href).host;
  } catch {
    return <>{href}</>;
  }
  const at = host ? href.indexOf(host) : -1;
  if (at < 0) return <>{href}</>;
  return (
    <>
      <span className="confirm-subject-quiet">{href.slice(0, at)}</span>
      <strong>{host}</strong>
      <span className="confirm-subject-quiet">{href.slice(at + host.length)}</span>
    </>
  );
}

/**
 * The one question in front of the app (confirmDialog in store.ts), in the shared Modal. It answers four things
 * in order: what happens (the title and the lead), the item it happens to (set apart), what is lost and what stays
 * safe, and whether it can be taken back. The icon and the confirm button carry the stakes: a red fill for
 * permanent or saved loss, an outlined red action for unsaved or recoverable loss, the accent for the rest.
 */
function ConfirmDialog({ req }: { req: ConfirmRequest }) {
  const tone = toneOf(req);
  const safe = useRef<HTMLButtonElement>(null);
  // Every question starts on its safe choice, including one that replaces another in the same dialog (where focus
  // could still be on the confirm button of the question before). Asked from a menu item, the question opens while
  // the menu is still closing; the menu then hands focus to its trigger in the (now inert) app and it falls to the
  // page, so the safe choice takes it back until it holds.
  const first = useRef(req.id);
  const [announce, setAnnounce] = useState('');
  useLayoutEffect(() => {
    safe.current?.focus();
    // A question replacing another keeps the same dialog and often the same focused button, so nothing would be
    // announced: say the new question once.
    // Everything the visible question says, cleared first so an identical question is still announced afresh.
    let said = 0;
    if (req.id !== first.current) {
      setAnnounce('');
      said = requestAnimationFrame(() => setAnnounce([req.title, req.body, req.subject, req.subjectNote, ...(req.details ?? []).map((d) => d.text)].filter(Boolean).join(' ')));
    }
    const outside = () => !!safe.current && !safe.current.closest('.modal')?.contains(document.activeElement);
    // Held while any menu is still closing, and for a few frames after the last one has gone.
    let settled = 0;
    let raf = 0;
    const hold = () => {
      if (!safe.current) return;
      if (outside()) safe.current.focus();
      settled = openMenus.count ? 0 : settled + 1;
      if (settled < 6) raf = requestAnimationFrame(hold);
    };
    raf = requestAnimationFrame(hold);
    // A key pressed while focus is still outside goes to the safe choice first, so Enter or Space can never act
    // on anything else and Tab starts from it. Escape keeps its meaning (stay) through the dialog's own handler.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || !outside() || openDialogs[openDialogs.length - 1] !== safe.current?.closest('.modal')) return;
      e.preventDefault();
      e.stopPropagation();
      safe.current?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(said);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [req.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const confirmClass = tone === 'danger' ? 'btn btn-danger-fill' : tone === 'caution' ? 'btn btn-danger' : 'btn btn-primary';
  return (
    <Modal
      title={req.title}
      icon={
        <span className="confirm-icon" data-tone={tone} aria-hidden="true">
          {req.icon ? ICONS[req.icon] : tone === 'neutral' ? <Info /> : <TriangleAlert />}
        </span>
      }
      onClose={() => req.resolve(null)}
      describedBy="confirm-body"
      footer={
        <>
          {req.stayLabel && (
            <button ref={safe} className="btn" data-autofocus onClick={() => req.resolve(null)} style={{ marginRight: 'auto' }}>
              {req.stayLabel}
            </button>
          )}
          {/* With a stay choice beside it, cancel is the choice that throws the work away, so it reads as one. */}
          <button ref={req.stayLabel ? undefined : safe} className={req.stayLabel ? 'btn btn-danger' : 'btn'} data-autofocus={req.stayLabel ? undefined : true} onClick={() => req.resolve(false)}>
            {req.cancelLabel ?? 'Cancel'}
          </button>
          <button className={confirmClass} onClick={() => req.resolve(true)}>
            {req.confirmLabel}
          </button>
        </>
      }
    >
      <div id="confirm-body" className="confirm">
        <p className="confirm-lead">{req.body}</p>
        {req.subject && (
          <div className="confirm-subject" data-kind={req.subjectKind}>
            {/* An address already has its kind in the title's badge; it takes the whole width instead. */}
            {req.subjectKind && !isAddress(req.subjectKind) && SUBJECT_ICONS[req.subjectKind]}
            <span className="confirm-subject-text">
              <span className={req.subjectKind && isAddress(req.subjectKind) ? 'confirm-subject-address' : 'confirm-subject-name'}>
                {req.subjectKind === 'web' ? <Address href={req.subject} /> : req.subject}
              </span>
              {req.subjectNote && <span className="confirm-subject-note">{req.subjectNote}</span>}
            </span>
          </div>
        )}
        {req.details && req.details.length > 0 && (
          <ul className="confirm-details">
            {req.details.map((d, i) => (
              <li key={i} data-kind={d.kind}>
                {DETAIL_ICONS[d.kind]}
                <span>{d.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <span className="sr-only" role="status" aria-live="assertive">
        {announce}
      </span>
    </Modal>
  );
}

/** Hosts confirmDialog(): one question at a time. A question that replaces another keeps the same dialog, so focus
 *  still returns to whatever opened the first one; the new question takes its own safe focus (above). */
export function ConfirmHost() {
  const [req, setReq] = useState(getConfirm());
  useEffect(() => {
    const off = onConfirmChange(() => setReq(getConfirm()));
    return () => void off();
  }, []);
  if (!req) return null;
  return <ConfirmDialog req={req} />;
}
