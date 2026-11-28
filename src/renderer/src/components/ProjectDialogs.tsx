import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Check, CircleAlert, CloudAlert, CloudDownload, Copy, CopyCheck, FileArchive, FolderOpen, Info, LayoutTemplate, ShieldAlert, TriangleAlert } from 'lucide-react';
import type { DuplicateProjectResult, ProgressEvent, TrustRequest, Unpacking, WebsiteTools } from '@shared/api';
import { MAX_COPY_NAME, projectDisplayName, projectFolderName } from '@shared/project-name';
import { defaultTheme, getTheme, listThemes } from '@catalogue/index';
import { STARTERS as CATALOGUE_STARTERS, starterProblem, starterTakesSamples, type StarterId } from '@catalogue/starters';
import { showcaseHome, showcasePages } from '@catalogue/showcase';
import { isImeComposing } from '../lib/ime';
import { endEditingHold, settleEdits } from '../lib/leave';
import { afterEditsSettle } from '../lib/pending';
import { api, errorText, toast, useStore } from '../store';
import { loadEditor } from '../lib/editor-module';
import { usePackPreview, usePreviewExtent } from './PackPreview';
import { Field, Modal, Spinner, SwitchRow } from './ui';
import { perfMark, perfMarkAtCommit } from '../lib/perf';
import './ProjectDialogs.css';

/*
 * New project, Duplicate project and Trust this project, shown over Welcome or over the open project. Either way the
 * project behind stays open (its page and selection as they were) until the new one has opened: cancelling, or a new
 * project that cannot be made or opened, leaves the author where they were (#80).
 */

/** npm's own output is for the log. Lines written for people start with a capital and don't name it. */
const isPlainDetail = (d?: string) => !!d && /^[A-Z]/.test(d) && !/\bnpm\b/i.test(d);

/** A control about to disable itself hands focus to its dialog, so Tab and Escape still belong to the dialog. */
const keepFocusInDialog = (from: Element | null) => from?.closest<HTMLElement>('.modal')?.focus();

/** Minutes and seconds since `since`, once a wait is long enough to be worth counting; null before that. */
function useElapsed(since: number | null, after = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [since]);
  if (since === null || now - since < after) return null;
  const s = Math.floor((now - since) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A path's style is read from its root, so a POSIX folder name that happens to hold a backslash stays POSIX. */
const isWindowsPath = (p: string) => /^([A-Za-z]:\\|\\\\)/.test(p);

/**
 * A folder path as one selectable readout: the folders it sits in are quiet, the folder it names in full ink. The
 * whole path is always shown (a shortened one hides whose home folder it is), and it may break after any separator.
 * `pending` stands in for the folder's own name until there is one.
 */
function PathReadout({ path, pending, id, className = '' }: { path: string; pending?: string; id?: string; className?: string }) {
  const sep = isWindowsPath(path) ? '\\' : '/';
  const parts = path.split(sep);
  if (pending && parts[parts.length - 1] !== '') parts.push('');
  const leaf = parts.pop() ?? '';
  return (
    <div id={id} className={`path-readout ${className}`.trim()}>
      <FolderOpen aria-hidden="true" />
      <span className="path-text">
        {parts.map((p, i) => (
          <Fragment key={i}>
            <span className="path-parent">
              {p}
              {sep}
            </span>
            <wbr />
          </Fragment>
        ))}
        {leaf ? <span className="path-leaf">{leaf}</span> : pending ? (
          <span className="path-pending" aria-hidden="true">
            {pending}
          </span>
        ) : null}
      </span>
    </div>
  );
}

// ---------- Starting points ----------

type PageSketch = { name: string; sections: Array<{ id: string; variant?: string; whole?: boolean }> };

/**
 * Each starter's pages and their sections, in the order and variants it builds them (`src/catalogue/starters.ts`).
 * Contact leaves out its page intro: the theme's thumbnail of it is About's, and two sheets opening on the same
 * banner read as one page twice.
 */
const STARTER_PAGES: Record<Exclude<StarterId, 'showcase'>, PageSketch[]> = {
  business: [
    { name: 'Home', sections: [{ id: 'hero.split' }, { id: 'logos.strip' }, { id: 'features.grid' }, { id: 'content.media', variant: 'media-end' }, { id: 'stats.row', variant: 'inverse' }] },
    { name: 'About', sections: [{ id: 'intro.page' }, { id: 'content.media' }, { id: 'team.grid', variant: 'muted' }] },
    { name: 'Contact', sections: [{ id: 'contact.details', whole: true }, { id: 'faq.list', variant: 'muted' }] }
  ],
  blank: [{ name: 'Home', sections: [] }]
};

/** A starter's pages on this theme: the showcase's are the theme's own kinds of component (catalogue/showcase.ts). */
function starterPages(starter: StarterId, themeId: string): PageSketch[] {
  if (starter !== 'showcase') return STARTER_PAGES[starter];
  const kinds = showcasePages(themeId);
  return [
    { name: 'Home', sections: showcaseHome(themeId).map((id) => ({ id })) },
    ...kinds.map((k) => ({ name: k.title, sections: k.components.filter((c) => c.insertAs !== 'element').map((c) => ({ id: c.componentId })) }))
  ];
}

const STARTER_BLURBS: Record<StarterId, string> = {
  business: 'Sample text, services, a gallery and testimonials, ready to make your own.',
  blank: 'One empty page with a header and footer.',
  showcase: 'Every component the theme ships, a page for each kind.'
};
const STARTERS = CATALOGUE_STARTERS.map((s) => ({ id: s.id, name: s.id === 'business' ? 'Business' : s.name, blurb: STARTER_BLURBS[s.id] }));

/**
 * The site's own colours and type, from the theme it starts with, so the sketch around the thumbnails matches them.
 * The fonts are the theme's stacks: the editor does not load a pack's font files, so each falls back to a face of
 * its own kind (a serif display stays a serif), which keeps a theme's character even on a blank page.
 */
function siteLook(themeId: string): CSSProperties {
  const tokens = getTheme(themeId).tokens;
  const read = (id: string) => {
    const v = tokens.find((t) => t.id === id)?.value;
    return typeof v === 'string' ? v : undefined;
  };
  const vars: Record<string, string | undefined> = {
    '--site-display': read('font.display'),
    '--site-body': read('font.body'),
    '--site-bg': read('color.background'),
    '--site-text': read('color.text'),
    '--site-muted': read('color.muted'),
    '--site-border': read('color.border'),
    '--site-inverse': read('color.inverse'),
    '--site-on-inverse': read('color.on-inverse')
  };
  return Object.fromEntries(Object.entries(vars).filter(([, v]) => v)) as CSSProperties;
}

/** One section's thumbnail, cropped to where its content ends, as the Insert panel shows it. */
function SectionShot({ themeId, id, variant, whole, onReady }: { themeId: string; id: string; variant?: string; whole?: boolean; onReady: (ready: boolean) => void }) {
  const shots = getTheme(themeId).previews?.[id];
  // A variant is an option on one of the section's axes (a tone, a layout); its own thumbnail when the pack drew one.
  const file = (variant && Object.values(shots?.variants ?? {}).find((axis) => axis[variant])?.[variant]) || shots?.default;
  const url = usePackPreview(file ? themeId : undefined, file);
  // Cropped where its content ends, unless that content is drawn too close to the page colour to be told from it.
  const measured = usePreviewExtent(file && !whole ? themeId : undefined, file, url);
  const extent = whole ? 1 : measured;
  const ready = !file || !!url;
  useEffect(() => onReady(ready), [ready, onReady]);
  if (!url || extent <= 0) return null;
  return (
    <div className="sheet-shot" style={{ aspectRatio: `320 / ${Math.max(24, Math.round(200 * extent))}` }}>
      <img src={url} alt="" draggable={false} />
    </div>
  );
}

/** A page of the site: its header (with the name being typed, as the site's own header has it) and its sections. */
function PageSheet({ themeId, page, nav, siteName, className, onReady }: { themeId: string; page: PageSketch; nav: string[]; siteName: string; className: string; onReady: (key: string, ready: boolean) => void }) {
  return (
    <div className={`sheet ${className}`}>
      <div className="sheet-head">
        <b className="ellipsis">{siteName}</b>
        <span className="sheet-nav">
          {nav.map((p) => (
            <span key={p} className={p === page.name ? 'here' : undefined}>
              {p}
            </span>
          ))}
        </span>
      </div>
      {page.sections.length ? (
        <div className="sheet-page">
          {page.sections.map((s) => (
            <SectionShot key={s.id} themeId={themeId} id={s.id} variant={s.variant} whole={s.whole} onReady={(r) => onReady(`${page.name}:${s.id}`, r)} />
          ))}
        </div>
      ) : (
        <>
          <div className="sheet-empty">
            <span>Your first section</span>
          </div>
          <div className="sheet-foot">
            <span className="ellipsis">
              © {new Date().getFullYear()} {siteName}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * What a starter makes, drawn as its pages in the site's own colours: Home as a tall sheet built from the theme's
 * real section thumbnails in the order the starter builds it, and each other page beside it, showing its top. A
 * blank site is its one empty page, at the same scale.
 */
function StarterArt({ starter, siteName, themeId }: { starter: StarterId; siteName: string; themeId: string }) {
  // The showcase draws Home and the first two of its kind pages, each showing its top; the rest would be slivers.
  const pages = starter === 'showcase' ? starterPages(starter, themeId).slice(0, 3) : starterPages(starter, themeId);
  const keys = () => pages.flatMap((p) => p.sections.map((s) => `${p.name}:${s.id}`));
  const [waiting, setWaiting] = useState<Set<string>>(() => new Set(keys()));
  const onReady = useRef((key: string, ready: boolean) =>
    setWaiting((w) => {
      if (ready === !w.has(key)) return w;
      const next = new Set(w);
      if (ready) next.delete(key);
      else next.add(key);
      return next;
    })
  ).current;
  const [home, ...rest] = pages;
  const name = siteName.trim() || 'Your site';
  const nav = pages.map((p) => p.name);
  return (
    <div className={`starter-art ${starter}`} aria-hidden="true" data-loading={waiting.size ? '' : undefined} data-theme={themeId} style={siteLook(themeId)}>
      <PageSheet key={themeId} themeId={themeId} page={home} nav={nav} siteName={name} className="home" onReady={onReady} />
      {rest.length > 0 && (
        <div className="sheet-side">
          {rest.map((p) => (
            <PageSheet key={`${themeId}:${p.name}`} themeId={themeId} page={p} nav={[p.name]} siteName={name} className="side" onReady={onReady} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Trust ----------

/**
 * Why the project is asked about, which is what differs from one prompt to the next, so it is worth reading. A change
 * to a project trusted here before is the reason to pause, so the warning itself says it, and nothing is repeated here.
 */
const TRUST_REASON: Record<TrustRequest['reason'], string> = {
  new: 'Builder hasn’t opened this project from this folder before. It may have come from another computer, or been moved or copied here.',
  changed: '',
  unpacked: 'It was just unpacked from a ZIP file into a new folder, so Builder asks before running anything in it.'
};

/**
 * Ask before running a project's own website tools; Trust and open records the trust, then opens it. What trusting
 * allows comes first, with the safe choice beside it, then exactly which project, then why it is asked now.
 * `project.replaces`: the missing recent entry the project was chosen for, which it takes over once open (#217).
 */
export function TrustProjectModal({ project, onClose }: { project: TrustRequest & { replaces?: string }; onClose: () => void }) {
  const [since, setSince] = useState<number | null>(null);
  const trusting = since !== null;
  const elapsed = useElapsed(since);
  return (
    <Modal
      title="Trust this project?"
      describedBy="trust-body"
      icon={<ShieldAlert />}
      onClose={onClose}
      busy={trusting}
      footer={
        <>
          {/* In the footer, so the dialog and its buttons hold still at the moment of commitment. */}
          <span className="foot-note" role="status">
            {trusting ? (
              <>
                <Spinner decorative />
                <span className="ellipsis">Opening {project.name}…</span>
                {elapsed && (
                  <span className="elapsed" aria-hidden="true">
                    {elapsed}
                  </span>
                )}
              </>
            ) : null}
          </span>
          <button className="btn" data-autofocus disabled={trusting} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={trusting}
            onClick={async (e) => {
              keepFocusInDialog(e.currentTarget);
              setSince(Date.now());
              try {
                const r = await api.projects.trustAndOpen(project.dir, project.replaces ? { replaces: project.replaces } : undefined);
                if (!r.ok) {
                  // The project behind the dialog, if any, is still open and takes input again.
                  endEditingHold();
                  if (r.message) toast(r.message, 'error');
                }
              } catch (e) {
                endEditingHold();
                toast(`Could not open the project: ${errorText(e)}`, 'error');
              } finally {
                setSince(null);
                onClose();
              }
            }}
          >
            Trust and open
          </button>
        </>
      }
    >
      <div id="trust-body" className="trust-body">
        <div className="trust-risk">
          <TriangleAlert aria-hidden="true" />
          <p>
            <strong>Trust and open lets this project run code on your computer</strong> to build its preview.{' '}
            {project.reason === 'changed'
              ? 'The files that build its preview have changed since you last trusted this folder. If you weren’t expecting that, choose Cancel: nothing is opened or changed.'
              : project.reason === 'unpacked'
                ? 'If you’re not sure where it came from, choose Cancel: nothing runs, and the unpacked folder stays where it is.'
                : 'If you’re not sure where it came from, choose Cancel: nothing is opened or changed.'}
          </p>
        </div>
        <div className="trust-project">
          <div className="trust-name">{project.name}</div>
          {/* The exact path: shortened, folders in two people's home folders would look the same. */}
          <span className="sr-only">Project folder:</span>
          <PathReadout path={project.dir} className="trust-path" />
        </div>
        <p className="trust-why">
          {TRUST_REASON[project.reason] && `${TRUST_REASON[project.reason]} `}If you trust it, Builder won’t ask again for this folder unless its setup files change.
        </p>
      </div>
    </Modal>
  );
}

// ---------- Duplicate ----------

/** The folder a path sits in, in the path's own style ("/Users/ana/Sites" for "/Users/ana/Sites/storefront"). */
function parentFolder(path: string): string {
  const sep = isWindowsPath(path) ? '\\' : '/';
  const trimmed = path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
  const at = trimmed.lastIndexOf(sep);
  if (at < 0) return trimmed;
  // The root keeps its separator ("/", "C:\\").
  return at === 0 || (sep === '\\' && at === 2 && trimmed[1] === ':') ? trimmed.slice(0, at + 1) : trimmed.slice(0, at);
}

/**
 * The suggested name for a copy: "Storefront copy", unless the length limit would cut " copy" off or its folder would be
 * the original's own, when the words that tell it apart go first ("Copy of Storefront…").
 */
function copyName(name: string, dir: string): string {
  const suffixed = `${name} copy`;
  // Folder names are compared as most disks do, ignoring case.
  const own = dir.split(isWindowsPath(dir) ? '\\' : '/').filter(Boolean).pop()?.toLowerCase();
  if (suffixed.length <= MAX_COPY_NAME && projectFolderName(suffixed).toLowerCase() !== own) return suffixed;
  return `Copy of ${name}`.slice(0, MAX_COPY_NAME).trim();
}

/** What could not be saved, when it stops a copy before it starts (#1373), said as Export says it. */
const notCopied = (problems: string[]) => `The project wasn’t copied, because a change isn’t saved yet. ${problems.join(' ')} Cancel, save or discard it, then duplicate the project again.`;

/**
 * Duplicate project (#176), over the open project: the copy's own name, which Recent projects and the toolbar show in
 * place of the site's (the site's visitor-facing name is copied as it is), and the folder it is made in. A problem is
 * explained beneath the two, with the form kept to correct it and focus on what fixes it: the name when a folder by
 * that name is already there, Choose… when the folder cannot be used, Duplicate when the copy itself failed. What is
 * still being typed is saved first, so the copy holds what is on screen; an edit that can't be saved (text a field
 * refused, an edit kept on hold) stops it before any folder is made, and is said the same way (#1373). Once made, the
 * copy is offered to open; until then, and unless it is opened, every change stays in the project open now.
 */
export function DuplicateProjectModal({ onClose, onOpen }: { onClose: () => void; onOpen: (dir: string) => void }) {
  const snap = useStore((s) => s.snapshot);
  // The project as it was when Duplicate was chosen: the copy is of that opening, and of no other.
  const [source] = useState(() => (snap ? { opening: snap.workspaceKey, name: projectDisplayName(snap.state), site: snap.state.site.name, dir: snap.dir } : null));
  const [name, setName] = useState(() => (source ? copyName(source.name, source.dir) : ''));
  const [parent, setParent] = useState(() => (source ? parentFolder(source.dir) : ''));
  const [problem, setProblem] = useState<{ field: 'name' | 'location' | 'form'; text: string; target: string; parent: string } | null>(null);
  const [since, setSince] = useState<number | null>(null);
  const busy = since !== null;
  const elapsed = useElapsed(since);
  // Saving what is still being typed, before the copy is asked for.
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ dir: string; name: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const duplicateRef = useRef<HTMLButtonElement>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    // The suggested name is there to be typed over.
    nameRef.current?.select();
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (done) openRef.current?.focus();
  }, [done]);
  // Back on the form with a problem: focus goes to what fixes it, which reads the problem out.
  useEffect(() => {
    if (problem?.field === 'location') chooseRef.current?.focus();
    else if (problem?.field === 'form') duplicateRef.current?.focus();
    else if (problem) nameRef.current?.focus();
  }, [problem]);

  const trimmed = name.replace(/\s+/g, ' ').trim();
  const sep = isWindowsPath(parent) ? '\\' : '/';
  const target = parent && trimmed ? `${parent.endsWith(sep) ? parent : parent + sep}${projectFolderName(trimmed)}` : parent;
  // A folder by the copy's name stays the problem while the name and folder still lead to it; a folder that cannot be
  // used, while it is the one chosen (another name does not answer it); a problem with the copy itself, until the next
  // try. Neither of the first two is offered again.
  const shown = !problem ? null : problem.field === 'name' ? (problem.target === target ? problem : null) : problem.field === 'location' ? (problem.parent === parent ? problem : null) : problem;
  const canDuplicate = !!source && !!trimmed && !!parent && !busy && (!shown || shown.field === 'form');

  const duplicate = async () => {
    if (!source || !canDuplicate) return;
    keepFocusInDialog(nameRef.current);
    setSince(Date.now());
    setSaving(true);
    setProblem(null);
    let r: DuplicateProjectResult | null;
    try {
      const started = await afterEditsSettle(
        () => settleEdits(),
        async () => {
          // The dialog went with the project it was over while its edits were being saved: nothing is copied. Another
          // opening in its place is refused by the copy itself, which says so.
          if (!live.current) return null;
          setSaving(false);
          return api.projects.duplicate({ name: trimmed, parentDir: parent, opening: source.opening });
        }
      );
      r = started.ok ? started.value : live.current ? { ok: false, field: 'form', message: notCopied(started.problems) } : null;
    } catch (e) {
      r = { ok: false, field: 'form', message: `The project could not be copied: ${errorText(e)}` };
    }
    if (!r) return;
    // The dialog went with the project it was over: what happened is told as a notice.
    if (!live.current) {
      if (r.ok) toast(`${r.name} was copied to ${r.dir}. Open it from Recent projects.`, 'success');
      else toast(r.message, 'error');
      return;
    }
    setSince(null);
    setSaving(false);
    if (r.ok) setDone({ dir: r.dir, name: r.name });
    else setProblem({ field: r.field, text: r.message, target, parent });
  };

  if (done && source)
    return (
      <Modal
        title="Copy created"
        icon={<CopyCheck />}
        onClose={onClose}
        describedBy="duplicate-done"
        footer={
          <>
            <button className="btn" onClick={onClose}>
              Keep editing here
            </button>
            {/* Focus lands here as the form gives way, so it reads out what was made. */}
            <button ref={openRef} className="btn btn-primary" aria-describedby="duplicate-done" onClick={() => onOpen(done.dir)}>
              Open copy
            </button>
          </>
        }
      >
        <div className="duplicate-form">
          <p id="duplicate-done" className="duplicate-note">
            <strong>{done.name}</strong> is ready in its own folder, with every change made so far. You’re still editing <strong>{source.name}</strong>, and from here on each project keeps its own changes.
          </p>
          <div className="path-group">
            <div className="field-label">Copy’s folder</div>
            <PathReadout path={done.dir} />
          </div>
        </div>
      </Modal>
    );

  const invalid = shown?.field === 'name' || shown?.field === 'location';
  return (
    <Modal
      title="Duplicate project"
      icon={<Copy />}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <span className="foot-note" role="status">
            {busy ? (
              <>
                <Spinner decorative />
                <span className="ellipsis">{saving ? 'Saving your changes first…' : 'Copying the project… The original is not changed.'}</span>
                {elapsed && (
                  <span className="elapsed" aria-hidden="true">
                    {elapsed}
                  </span>
                )}
              </>
            ) : null}
          </span>
          <button className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button ref={duplicateRef} className="btn btn-primary" disabled={!canDuplicate} aria-describedby={shown?.field === 'form' ? 'duplicate-error' : undefined} onClick={() => void duplicate()}>
            Duplicate
          </button>
        </>
      }
    >
      <div className="duplicate-form">
        <Field
          label="Copy name"
          controlId="duplicate-name"
          hint={
            <>
              Shown in Recent projects and the toolbar, so you can tell the copy from {source?.name ?? 'the original'}. Visitors still see the site name{source ? <> “{source.site}”</> : null}.
            </>
          }
        >
          <input
            ref={nameRef}
            id="duplicate-name"
            className="input"
            autoFocus
            maxLength={MAX_COPY_NAME}
            value={name}
            disabled={busy}
            aria-invalid={shown?.field === 'name' ? true : undefined}
            aria-describedby={shown?.field === 'name' ? 'duplicate-error' : undefined}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !isImeComposing(e) && void duplicate()}
          />
        </Field>
        <div className="field">
          <div className="field-label" id="duplicate-path-label">
            Copy’s folder
          </div>
          <div className="np-path-row">
            <PathReadout id="duplicate-path" path={target} pending={trimmed ? undefined : 'copy-name'} className={invalid ? 'invalid' : ''} />
            <button
              ref={chooseRef}
              className="btn"
              disabled={busy}
              aria-describedby={invalid ? 'duplicate-path-label duplicate-path duplicate-error' : 'duplicate-path-label duplicate-path'}
              onClick={async () => {
                const d = await api.dialogs.chooseFolder('Choose where to put the copy', parent || undefined);
                if (d && live.current) {
                  setParent(d);
                  // Choosing a folder again asks afresh, in case it was emptied or its permissions changed meanwhile.
                  if (problem?.field === 'location' || problem?.field === 'name') setProblem(null);
                }
              }}
            >
              Choose…
            </button>
          </div>
        </div>
        {shown && (
          <div id="duplicate-error" className="scope-note danger" role="alert">
            <CircleAlert aria-hidden="true" />
            <span>{shown.text}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------- Unpacking ----------

/**
 * A project ZIP file being unpacked into a new folder (#263), over Welcome or the open project, from the moment its
 * folder is chosen until the copy is ready (then Trust this project follows) or has gone. It counts the files written
 * against the ZIP file's total, so a long unpacking reads as one rather than as a hang. Cancel, or Esc, calls it off:
 * nothing it wrote is left, and the ZIP file was only read. A failure closes it and is told as a notice.
 */
export function UnpackingModal() {
  const [unpacking, setUnpacking] = useState<Unpacking | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [since, setSince] = useState<number | null>(null);
  // The unpacking the dialog is showing: progress on it keeps the dialog as it is, a new one starts it afresh.
  const current = useRef<string | null>(null);
  useEffect(
    () =>
      api.on('projects:unpacking', (u) => {
        const key = u ? `${u.dir}\n${u.folder}` : null;
        if (key !== current.current) {
          current.current = key;
          setCancelling(false);
          setSince(u ? Date.now() : null);
        }
        setUnpacking(u);
      }),
    []
  );
  const elapsed = useElapsed(since);
  const done = unpacking?.done ?? 0;
  const total = unpacking?.total ?? 0;
  const count = total > 0 ? `${done.toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? 'file' : 'files'}` : null;
  // A long wait is told as it starts to show (the count so far), then once per quarter of the way, so it is heard to be
  // moving without a running commentary; a short one stays quiet.
  const quarter = total > 0 ? Math.floor((done / total) * 4) : 0;
  const told = useRef<{ quarter: number; text: string } | null>(null);
  if (!elapsed || !count || cancelling) told.current = null;
  else if (!told.current || told.current.quarter !== quarter) told.current = { quarter, text: `${count} unpacked.` };
  if (!unpacking) return null;
  const cancel = () => {
    keepFocusInDialog(document.activeElement);
    setCancelling(true);
    void api.projects.cancelOpen().catch(() => setCancelling(false));
  };
  return (
    <Modal
      title={`Unpacking ${unpacking.name}`}
      describedBy="unpack-status"
      icon={<FileArchive />}
      onClose={cancel}
      busy={cancelling}
      dismissOnBackdrop={false}
      footer={
        <button className="btn busy-cancel" data-autofocus disabled={cancelling} onClick={cancel}>
          {cancelling ? 'Canceling…' : 'Cancel'}
        </button>
      }
    >
      <div className="unpack-body">
        <p id="unpack-status" className="unpack-status" role="status">
          {cancelling ? 'Nothing unpacked is kept, and the ZIP file is unchanged.' : 'Making a working copy of the project. The ZIP file is only read, and Cancel removes the unfinished copy.'}
        </p>
        <div className="sr-only" role="status">
          {told.current?.text ?? ''}
        </div>
        <div className="unpack-progress">
          {/* Its place is kept while the unfinished copy is removed, so nothing moves, but it no longer measures anything. */}
          {cancelling ? (
            <div className="unpack-bar retired" aria-hidden="true" />
          ) : count ? (
            <div className="unpack-bar" role="progressbar" aria-label="Files unpacked" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-valuetext={count}>
              <span style={{ width: `${Math.min(100, (done / total) * 100)}%` }} />
            </div>
          ) : (
            <div className="unpack-bar" aria-hidden="true" />
          )}
          <div className="unpack-count" aria-hidden="true">
            <Spinner decorative />
            <span>{cancelling ? 'Removing the unfinished copy…' : (count ?? 'Starting…')}</span>
            {elapsed && !cancelling && <span className="elapsed">{elapsed}</span>}
          </div>
        </div>
        <div className="path-group">
          <div className="field-label">New folder</div>
          {/* The folder it goes in and its own name, which gains a number only if that name is taken by then. */}
          <PathReadout path={`${unpacking.dir.replace(/[\\/]$/, '')}${isWindowsPath(unpacking.dir) ? '\\' : '/'}${unpacking.folder}`} />
        </div>
      </div>
    </Modal>
  );
}

// ---------- New project ----------

/** What to do when the website tools could not be downloaded, said the same way on the step and to a screen reader. */
const OFFLINE_STEP = 'Not downloaded. Choose Try again in the preview once you’re connected.';

const STEPS: Array<{ id: ProgressEvent['step']; label: string }> = [
  { id: 'files', label: 'Preparing files' },
  { id: 'dependencies', label: 'Setting up website tools' },
  { id: 'preview', label: 'Starting preview' }
];

/**
 * What a failed attempt is about, so the message lands beside what it concerns: the name (a folder by that name is
 * already there), the chosen location, or neither. Cancel is not a failure and is told as such.
 */
type Problem = { text: string; about: 'name' | 'location' | 'other' | 'canceled'; target?: string };
function problemOf(message: string): Problem {
  if (/^Cancell?ed\b/i.test(message)) {
    const rest = message.replace(/^Cancell?ed\.?\s*/i, '');
    return { about: 'canceled', text: rest ? `Setup was canceled. ${rest}` : 'Setup was canceled. Nothing it made was kept.' };
  }
  // A folder the preview cannot run under (#1366), told first: the folder's own name, quoted in it, may read like any other.
  if (/^The preview can’t run from a folder/.test(message)) return { about: 'location', text: message };
  // A folder by this name is already there: a new name or another folder answers it.
  if (/already exists and is not empty|^Enter a project name/i.test(message)) return { about: 'name', text: message };
  // The chosen folder cannot be written to, or is inside the open project: only another folder answers it.
  if (/does not have permission to write|outside the open project/i.test(message)) return { about: 'location', text: message };
  return { about: 'other', text: message };
}

/** New project, once the themes it offers have arrived: Welcome shows, and takes New project, before they have. */
export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const ready = useStore((s) => s.packs.ready);
  // The editor's code loads while the form is filled in, so the new project shows as soon as it is made.
  useEffect(() => void loadEditor().catch(() => undefined), []);
  if (ready) return <NewProjectForm onClose={onClose} />;
  return (
    <Modal title="New project" icon={<LayoutTemplate />} onClose={onClose}>
      <p className="muted" role="status">
        <Spinner decorative /> Loading themes…
      </p>
    </Modal>
  );
}

function NewProjectForm({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [starter, setStarter] = useState<StarterId>('business');
  // The themes each starter can start with, the default first: development fixtures are only for switching, and an
  // installed pack must have every section the starter places. A starter the chosen theme cannot make shows the first
  // that can.
  const eligible = useMemo(() => new Map(STARTERS.map((s) => [s.id, listThemes().filter((t) => !t.devOnly && !starterProblem(s.id, t.id))])), []);
  const themes = eligible.get(starter) ?? [];
  const [themeId, setThemeId] = useState(() => defaultTheme().id);
  const theme = themes.find((t) => t.id === themeId) ?? themes[0] ?? getTheme(themeId);
  const [images, setImages] = useState(true);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  // Whether setup will download anything, known before Create is pressed (null while it is being checked).
  const [tools, setTools] = useState<WebsiteTools | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // The website tools could not be downloaded: the project still opens, and its preview waits for a connection.
  const [toolsMissing, setToolsMissing] = useState(false);
  const [stepSince, setStepSince] = useState<number | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Progress belongs to this dialog's own attempt, named in its create call: another attempt still running (from a
  // window closed meanwhile, or one that replaced the open project and is starting its preview) reports nothing
  // here. Once this dialog has gone, its attempt's answer is only told as a notice.
  const attempt = useRef<string | null>(null);
  // Set once the author picks a folder: the suggested one arriving later must not replace it.
  const chosenParent = useRef(false);
  const live = useRef(true);
  const stepRef = useRef<ProgressEvent['step'] | null>(null);
  // A long destination wraps; the previews give back the height of its extra lines (--np-path), so the form still
  // fits the window rather than scrolling.
  const pathWatch = useRef<ResizeObserver | null>(null);
  const watchPath = useCallback((form: HTMLDivElement | null) => {
    pathWatch.current?.disconnect();
    pathWatch.current = null;
    const path = form?.querySelector<HTMLElement>('#new-project-path');
    if (!form || !path) return;
    const one = parseFloat(getComputedStyle(path).minHeight) || 0;
    pathWatch.current = new ResizeObserver(() => form.style.setProperty('--np-path', `${Math.max(0, path.offsetHeight - one)}px`));
    pathWatch.current.observe(path);
  }, []);
  // The form on screen, and the check of the website tools settled, which Create waits for (src/shared/perf.ts).
  useLayoutEffect(() => perfMarkAtCommit('newProject.formShown'), []);
  useLayoutEffect(() => {
    if (tools !== null) perfMarkAtCommit('newProject.toolsKnown', { tools });
  }, [tools]);
  useEffect(() => {
    live.current = true;
    void api.dialogs.defaultProjectsFolder().then((d) => !chosenParent.current && setParent(d), () => undefined);
    void api.projects.websiteTools().then(
      (t) => live.current && setTools(t),
      () => live.current && setTools('unknown')
    );
    const off = api.on('create:progress', (p) => {
      if (!attempt.current || p.attempt !== attempt.current) return;
      // Main opens the project without its preview when the tools could not be downloaded, and says so here.
      if (p.step === 'preview' && /^Opening/.test(p.message)) setToolsMissing(true);
      // Each step is timed from when it began, so a long one shows it is still going.
      if (stepRef.current !== p.step) {
        stepRef.current = p.step;
        setStepSince(Date.now());
      }
      // The last line written for people stays up while the install runs.
      setProgress((prev) => ({ ...p, detail: isPlainDetail(p.detail) ? p.detail : prev?.step === p.step ? prev.detail : undefined }));
    });
    return () => {
      live.current = false;
      off();
    };
  }, []);
  const running = !!progress && progress.step !== 'error' && progress.step !== 'done';
  const inProgress = !!progress && progress.step !== 'error';
  const lastStep = progress?.step === 'preview' || progress?.step === 'done';
  // Setup can be called off (by Cancel, the close button or Esc) until the new project is starting its preview.
  const canCancel = running && !lastStep && !cancelling;
  const elapsed = useElapsed(running && !cancelling ? stepSince : null, 8000);
  // The form's controls went with it: focus moves to Cancel, then to the dialog once nothing is left to cancel.
  useEffect(() => {
    if (inProgress) cancelRef.current?.focus();
  }, [inProgress]);
  useEffect(() => {
    if (lastStep) keepFocusInDialog(cancelRef.current);
  }, [lastStep]);
  // Back on the form with a problem: the fields it talks about are in view, and focus is on the first of them.
  useEffect(() => {
    if (!problem) return;
    nameRef.current?.closest('.modal-body')?.scrollTo({ top: 0 });
    nameRef.current?.focus();
  }, [problem]);
  // The folder main makes, worked out the same way, so the one shown is the one created.
  const slug = projectFolderName(name.trim());

  const separator = isWindowsPath(parent) ? '\\' : '/';
  const target = parent && name.trim() ? `${parent.endsWith(separator) ? parent : parent + separator}${slug}` : parent;
  // A folder that is already there stays the problem while the name still leads to it, and goes when it doesn't; it
  // comes back if the name returns to it. Choosing a folder again asks afresh, in case it was emptied meanwhile.
  const shown = problem?.about === 'name' && problem.target && problem.target !== target ? null : problem;
  // The author learns whether anything is downloaded before committing to it, by the button or by Enter, and is not
  // offered the same folder again once it was found taken.
  const canCreate = !!name.trim() && !!parent && tools !== null && !(shown?.about === 'name' && shown.target === target);
  const idx = progress ? STEPS.findIndex((s) => s.id === progress.step) : -1;
  // One line per step for a screen reader, in a region that is already there when the form gives way to progress.
  const announce = !progress || !inProgress
    ? problem?.about === 'canceled'
      ? problem.text
      : ''
    : cancelling && !lastStep
      ? 'Stopping setup, and removing what it made so far.'
      : idx < 0
        ? progress.message
        : toolsMissing && idx === 2
          ? `Step 3 of ${STEPS.length}. Opening your project without its preview. ${OFFLINE_STEP} Setup can no longer be canceled.`
          : `Step ${idx + 1} of ${STEPS.length}. ${STEPS[idx].label}.${progress.detail ? ` ${progress.detail}` : ''}${lastStep ? ' Setup can no longer be canceled.' : ''}`;
  const status = (
    <div className="sr-only" role="status">
      {announce}
    </div>
  );

  const create = async () => {
    if (attempt.current || !canCreate) return;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    attempt.current = id;
    setProblem(null);
    setCancelling(false);
    setToolsMissing(false);
    stepRef.current = 'files';
    setStepSince(Date.now());
    setProgress({ step: 'files', message: 'Preparing project files…' });
    perfMark('create.requested', { starter, sampleImages: images });
    let r: { ok: boolean; message?: string };
    try {
      r = await api.projects.create({ name: name.trim(), parentDir: parent, starter, sampleImages: images, themeId: theme.id, attempt: id });
    } catch (e) {
      r = { ok: false, message: `The project could not be created: ${errorText(e)}` };
    } finally {
      attempt.current = null;
    }
    // The dialog went with the project it was over (the switch happened), so a failure after that is told here.
    if (!live.current) {
      if (!r.ok && r.message) toast(r.message, 'error');
      return;
    }
    // Shown: the dialog has done its job (over the editor it would otherwise stay over the new project).
    if (r.ok) return onClose();
    // The project behind the dialog, if any, is still open and takes input again.
    endEditingHold();
    // The author chose to keep editing it: the dialog makes way.
    if (!r.message) return onClose();
    // Anything else is explained here, with the form as it was, to fix and try again.
    setProblem({ ...problemOf(r.message), target });
    setProgress(null);
  };

  if (progress && progress.step !== 'error') {
    const cancel = () => {
      if (!canCancel) return;
      keepFocusInDialog(cancelRef.current);
      setCancelling(true);
      void api.projects.cancelCreate().catch(() => setCancelling(false));
    };
    const downloading = tools !== 'local' || /\bdownload/i.test(progress.detail ?? '');
    const waitHint = cancelling ? null : idx === 1 && downloading ? 'Downloads can take a few minutes on a slow connection.' : null;
    return (
      <Modal
        title={`Creating ${name.trim()}`}
        icon={<LayoutTemplate />}
        onClose={cancel}
        busy={!canCancel}
        dismissOnBackdrop={false}
        describedBy="setup-steps"
        footer={
          <>
            <span className="foot-note">
              {lastStep ? (
                'Opening your project now'
              ) : cancelling ? (
                <>
                  <Spinner decorative /> Stopping setup…
                </>
              ) : null}
            </span>
            {/* Once the new project is starting its preview it has replaced the open one: nothing is left to cancel. */}
            <button ref={cancelRef} className="btn busy-cancel" onClick={cancel} disabled={!canCancel}>
              {cancelling && !lastStep ? 'Canceling…' : 'Cancel'}
            </button>
          </>
        }
      >
        {status}
        <div className={`setup${cancelling && !lastStep ? ' stopping' : ''}`}>
          <StarterArt starter={starter} siteName={name} themeId={theme.id} />
          <div className="setup-main">
            <ol id="setup-steps" className="progress-steps">
              {STEPS.map((s, i) => {
                const done = i < idx || progress.step === 'done';
                const warn = toolsMissing && i === 1;
                const active = i === idx;
                const label = toolsMissing && i === 2 ? 'Opening your project' : s.label;
                return (
                  <li key={s.id} className={`progress-step${warn ? ' warn' : done ? ' done' : active ? ' active' : ''}`} aria-current={active ? 'step' : undefined}>
                    <span className="dot">{warn ? <CloudAlert aria-hidden="true" /> : done ? <Check aria-hidden="true" /> : active && !(cancelling && !lastStep) ? <Spinner decorative /> : active ? <span className="stop" /> : null}</span>
                    <span className="step-label">
                      {done && !warn ? <span className="sr-only">Done: </span> : null}
                      {label}
                    </span>
                    {active && elapsed && (
                      <span className="elapsed" aria-hidden="true">
                        {elapsed}
                      </span>
                    )}
                    {warn && <span className="progress-detail">{OFFLINE_STEP}</span>}
                    {active && cancelling && !lastStep ? (
                      <span className="progress-detail">Stopping, and removing what setup made so far…</span>
                    ) : active && progress.detail && !(toolsMissing && i === 2) ? (
                      <span className="progress-detail">{progress.detail}</span>
                    ) : null}
                    {active && waitHint && <span className="progress-hint">{waitHint}</span>}
                  </li>
                );
              })}
            </ol>
            <div className="path-group">
              <div className="field-label">Project folder</div>
              <PathReadout path={target} />
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  const onName = shown?.about === 'name';
  const onLocation = shown?.about === 'name' || shown?.about === 'location';
  // What happens offline is in view from the moment the check says setup downloads, before anything is typed, so
  // the dialog never grows under the pointer while a name is entered (#905).
  const showToolsNote = tools === 'download' || tools === 'unknown';
  return (
    <Modal
      title="New project"
      icon={<LayoutTemplate />}
      onClose={onClose}
      footer={
        <>
          {/* Read out as it settles, and describes Create, so nobody creates a project without hearing it. */}
          <span id="new-project-tools" className="foot-note tools-note" data-tools={tools ?? 'checking'} role="status">
            {tools === null ? (
              <>
                <Spinner decorative /> Checking website tools…
              </>
            ) : tools === 'local' ? (
              <>
                <Check aria-hidden="true" /> Website tools are on this computer
              </>
            ) : (
              <>
                <CloudDownload aria-hidden="true" /> {tools === 'download' ? 'Setup downloads website tools' : 'Setup may download website tools'}
              </>
            )}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!canCreate} aria-describedby={showToolsNote ? 'new-project-tools new-project-tools-note' : 'new-project-tools'} onClick={() => void create()}>
            Create project
          </button>
        </>
      }
    >
      {status}
      <div className="new-project-form" ref={watchPath}>
        <div className="np-identity">
          <Field label="Project name" controlId="new-project-name">
            <input
              ref={nameRef}
              id="new-project-name"
              className="input"
              autoFocus
              placeholder="For example, Harbor Lane Studio"
              value={name}
              aria-invalid={onName ? true : undefined}
              aria-describedby={shown && (shown.about === 'name' || shown.about === 'other') ? 'new-project-error' : undefined}
              onChange={(e) => {
                setName(e.target.value);
                // A clash with a folder of that name follows the destination; a problem with the chosen folder stays.
                if (problem?.about === 'canceled') setProblem(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && !isImeComposing(e) && void create()}
            />
          </Field>
          <div className="field">
            <div className="field-label" id="new-project-path-label">
              Project folder
            </div>
            <div className="np-path-row">
              <PathReadout id="new-project-path" path={target} pending={name.trim() ? undefined : 'your-site'} className={onLocation ? 'invalid' : ''} />
              <button
                className="btn"
                aria-describedby={onLocation ? 'new-project-path-label new-project-path new-project-error' : 'new-project-path-label new-project-path'}
                onClick={async () => {
                  const d = await api.dialogs.chooseFolder('Choose where to create the project', parent);
                  if (d) {
                    chosenParent.current = true;
                    setParent(d);
                    if (problem && problem.about !== 'other') setProblem(null);
                  }
                }}
              >
                Choose…
              </button>
            </div>
          </div>
          {shown && (
            <div id="new-project-error" className={`scope-note ${shown.about === 'canceled' ? 'info' : 'danger'}`} role={shown.about === 'canceled' ? undefined : 'alert'}>
              {shown.about === 'canceled' ? <Info aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
              <span>{shown.text}</span>
            </div>
          )}
        </div>
        <div className="np-start">
          {/* The theme heads the choice it changes: what it is for beside it, and the previews below drawn in it. */}
          <div className="np-theme">
            {themes.length > 1 ? (
              <>
                <label className="field-label" htmlFor="new-project-theme">
                  Theme
                </label>
                <select id="new-project-theme" className="select" value={theme.id} aria-describedby="new-project-theme-about" onChange={(e) => setThemeId(e.target.value)}>
                  {themes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <>
                <span className="field-label">Theme</span>
                <strong className="np-theme-name">{theme.name}</strong>
              </>
            )}
            <p className="np-theme-about" id="new-project-theme-about">
              {theme.description} {themes.length > 1 && <span className="np-theme-later">You can change it any time in Site styles.</span>}
            </p>
          </div>
          <div className="field-label" id="new-project-starter-label">
            Start from
          </div>
          <div
            className="starter-grid"
            role="radiogroup"
            aria-labelledby="new-project-starter-label"
            onKeyDown={(e) => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
              e.preventDefault();
              const group = e.currentTarget;
              const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
              const at = STARTERS.findIndex((s) => s.id === starter);
              setStarter(STARTERS[(at + step + STARTERS.length) % STARTERS.length].id);
              requestAnimationFrame(() => group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
            }}
          >
            {STARTERS.map((s) => {
              const on = starter === s.id;
              const names = starterPages(s.id, theme.id).map((p) => p.name);
              // A long list of pages is counted rather than named, so the card's title keeps its room.
              const chips = names.length > 3 ? [`${names.length} pages`] : names;
              return (
                <button
                  key={s.id}
                  className="starter-card"
                  role="radio"
                  aria-checked={on}
                  aria-labelledby={`starter-${s.id}-name`}
                  aria-describedby={`starter-${s.id}-pages starter-${s.id}-blurb`}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setStarter(s.id)}
                >
                  <StarterArt starter={s.id} siteName={name} themeId={theme.id} />
                  <span className="copy">
                    <span className="title-row">
                      <span className="mark" aria-hidden="true">
                        {on && <Check />}
                      </span>
                      <strong id={`starter-${s.id}-name`}>{s.name}</strong>
                      <span className="pages" aria-hidden="true">
                        {chips.map((p) => (
                          <span key={p}>{p}</span>
                        ))}
                      </span>
                      <span className="sr-only" id={`starter-${s.id}-pages`}>
                        {names.length === 1 ? 'One page: Home.' : `${names.length} pages: ${names.join(', ')}.`}
                      </span>
                    </span>
                    <span className="blurb" id={`starter-${s.id}-blurb`}>
                      {s.blurb}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {/* The same height for either starter, so choosing one never moves the buttons under the pointer. */}
          <div className="np-option">
            {starterTakesSamples(starter) ? (
              <SwitchRow checked={images} onChange={setImages} label="Include sample images" hint="Interior photos fill the image spaces, shown empty in the previews. Replace them any time." />
            ) : (
              <p className="np-option-note">Starts with nothing to replace: no sample text or images.</p>
            )}
          </div>
        </div>
        {showToolsNote && (
          <div id="new-project-tools-note" className="scope-note info">
            <Info aria-hidden="true" />
            <span>Offline? Your project still opens. Choose Try again in its preview later.</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
