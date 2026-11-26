import { useState } from 'react';
import type { PackRefusal } from '@shared/api';
import { FailureScreen } from './FailureScreen';

/** A refused theme by the name a person knows it by: its id, else its folder's name. */
function themeName(r: PackRefusal, builtIn: boolean): string {
  if (builtIn) return 'Built-in theme';
  return r.packId ?? (r.dir.split(/[\\/]/).filter(Boolean).pop() || r.dir);
}

/** Whether a refused theme is one the person installed (in the themes folder), rather than the app's own. */
function inFolder(r: PackRefusal, userDir: string): boolean {
  if (!userDir) return false;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  return norm(r.dir) === norm(userDir) || norm(r.dir).startsWith(norm(userDir) + '/');
}

/**
 * Shown instead of the editor when no theme loaded: there is nothing to make or open a project with. Themes load once,
 * when the app starts, so reloading the window would change nothing: the way back is to reinstall (for the built-in
 * theme) or to fix a theme of the person's own in the themes folder, then open the app again. Each theme that could
 * not be loaded is named with why; where it is goes in the technical details, and all of it into Copy details.
 */
export function NoThemes({ refused, userDir }: { refused: PackRefusal[]; userDir: string }) {
  const [folderProblem, setFolderProblem] = useState(false);
  const rows = refused.map((r) => ({ r, name: themeName(r, !inFolder(r, userDir)), own: inFolder(r, userDir) }));
  const own = rows.some((t) => t.own);
  const builtInMissing = rows.some((t) => !t.own);
  const openFolder = async () => {
    try {
      setFolderProblem(!!(await window.builder.app.showThemesFolder()));
    } catch {
      setFolderProblem(true);
    }
  };
  return (
    <FailureScreen
      title="No themes could be loaded"
      detail={rows.map((t) => `${t.name}: ${t.r.dir}`).join('\n') || undefined}
      report={rows.map((t) => `${t.name}: ${t.r.reason}`).join('\n') || undefined}
      actions={
        <>
          <button className={own ? 'btn' : 'btn btn-primary'} onClick={() => void window.builder.app.quit()}>
            Quit
          </button>
          {own && (
            <button className="btn btn-primary" onClick={() => void openFolder()}>
              Open themes folder
            </button>
          )}
        </>
      }
    >
      <p className="failure-safe">Your projects are safe.</p>
      <p>
        {builtInMissing && own
          ? 'SiteOrigin Builder needs a theme to open or create a project. Reinstall SiteOrigin Builder to put the built-in theme back, or fix one of your own themes in the themes folder. Then quit and open SiteOrigin Builder again.'
          : builtInMissing
            ? 'SiteOrigin Builder needs a theme to open or create a project. Quit and reinstall SiteOrigin Builder to put the built-in theme back.'
            : 'SiteOrigin Builder needs a theme to open or create a project. Fix or remove these themes in the themes folder, then quit and open SiteOrigin Builder again.'}
      </p>
      {rows.length > 0 && (
        <ul className="failure-themes" aria-label="Themes that could not be loaded">
          {rows.map(({ r, name }) => (
            <li key={r.dir}>
              <span className="failure-theme-name">{name}</span>
              <span className="failure-theme-reason">{r.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {/* Always there, so a screen reader hears it when it fills. */}
      <p className="failure-note" role="status">
        {folderProblem && (
          <>
            The themes folder could not be opened. It is at <span className="failure-path">{userDir}</span>
          </>
        )}
      </p>
    </FailureScreen>
  );
}

/** Shown instead of the editor when the list of themes could not be read at all: reloading reads it again. */
export function CatalogueFailed({ message }: { message: string }) {
  return (
    <FailureScreen
      title="The themes could not be read"
      detail={message || undefined}
      actions={
        <>
          <button className="btn" onClick={() => void window.builder.app.quit()}>
            Quit
          </button>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </>
      }
    >
      <p className="failure-safe">Your projects are safe.</p>
      <p>SiteOrigin Builder could not read its list of themes, so it cannot show the editor. Reload to try reading the list again. If that does not work, quit and open SiteOrigin Builder again.</p>
    </FailureScreen>
  );
}
