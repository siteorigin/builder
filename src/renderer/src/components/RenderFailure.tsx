import { Component, type ErrorInfo, type ReactNode } from 'react';
import { FailureScreen } from './FailureScreen';

interface Props {
  children: ReactNode;
  /** Offered while a project is open: a project whose own content makes the editor fail again can still be left. */
  onCloseProject?: () => void;
  /** Loads the editor again. The page reloads by default; the main process still has the project open, so it returns. */
  reload?: () => void;
  /** Called once when this boundary catches a failure. */
  onFailure?: () => void;
}

interface State {
  error: Error | null;
  /** Where in the editor it failed (React's component stack), for the report. */
  where?: string;
}

/**
 * What the Technical details show and Copy details copies: the error with its stack, then where in the editor it
 * failed. Nothing when what was thrown had no words at all: a stack made up here would only point at this boundary.
 */
export function failureDetail(error: Error, where?: string): string | undefined {
  if (!error.message) return undefined;
  const stack = error.stack && error.stack.includes(error.message) ? error.stack : `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`;
  return where?.trim() ? `${stack}\n\nIn the editor:${where.replace(/\n\s*$/, '')}` : stack;
}

/** The one name for the editor failing, here and in the native crash question (src/main/editor-recovery.ts). */
export const EDITOR_STOPPED = 'The editor stopped working';

/** How many boundaries show a failure right now. */
let failures = 0;

/**
 * Whether a screen has failed and shows its way back instead. A File menu command is then left unconfirmed: the main
 * process keeps it and offers it again to the screen that says it is ready next, once the editor is reloaded or the
 * project closed.
 */
export const renderFailed = () => failures > 0;

/**
 * What the person sees when the editor fails while showing a screen (#886): what happened, and a way back. Without it
 * React unmounts everything and leaves a blank window. The project is saved as it is edited and stays open in the main
 * process, so the reloaded editor returns to it.
 */
export class RenderFailure extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    if (error instanceof Error) return { error };
    let text = '';
    try {
      text = String(error);
    } catch {
      // Something that cannot even be put into words (an object with no prototype): the way back still shows.
    }
    return { error: new Error(text) };
  }

  /** Whether this boundary is counted in `failures`. */
  private counted = false;

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('The editor failed while showing its screen.', error, info.componentStack);
    if (info.componentStack) this.setState({ where: info.componentStack });
    if (!this.counted) {
      failures++;
      this.counted = true;
      this.props.onFailure?.();
    }
  }

  componentWillUnmount() {
    if (this.counted) failures--;
    this.counted = false;
  }

  render() {
    const { error, where } = this.state;
    if (!error) return this.props.children;
    const { onCloseProject, reload = () => window.location.reload() } = this.props;
    // Whatever had focus went with the screen: the way back takes it (FailureScreen focuses its heading).
    return (
      <FailureScreen
        title={EDITOR_STOPPED}
        detail={failureDetail(error, where)}
        actions={
          <>
            {onCloseProject && (
              <button className="btn" onClick={onCloseProject}>
                Close project
              </button>
            )}
            <button className="btn btn-primary" onClick={reload}>
              Reload editor
            </button>
          </>
        }
      >
        {onCloseProject ? (
          <>
            <p className="failure-safe">Your work is safe. Only text you were still typing may need to be entered again.</p>
            <p>Reload the editor to go back to your project. If it stops again, copy the details and report the problem before you close the project.</p>
          </>
        ) : (
          <>
            <p className="failure-safe">Your projects are safe.</p>
            <p>Reload the editor to carry on.</p>
          </>
        )}
      </FailureScreen>
    );
  }
}
