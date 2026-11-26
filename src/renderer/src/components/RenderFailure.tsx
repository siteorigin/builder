import { Component, createRef, type ErrorInfo, type ReactNode } from 'react';

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
}

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

  private heading = createRef<HTMLHeadingElement>();

  /** Whether this boundary is counted in `failures`. */
  private counted = false;

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('The editor failed while showing its screen.', error, info.componentStack);
    if (!this.counted) {
      failures++;
      this.counted = true;
      this.props.onFailure?.();
    }
    // Whatever had focus went with the screen: the way back takes it, for the keyboard and screen readers.
    this.heading.current?.focus();
  }

  componentWillUnmount() {
    if (this.counted) failures--;
    this.counted = false;
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { onCloseProject, reload = () => window.location.reload() } = this.props;
    return (
      <div className="fatal render-failure" role="alert">
        <h1 ref={this.heading} tabIndex={-1}>
          The editor stopped working
        </h1>
        <p>
          {onCloseProject
            ? 'Something went wrong while showing the editor. Reload the editor to go back to your project, or close the project if this keeps happening. Text you were still typing may be lost.'
            : 'Something went wrong while showing the editor. Reload the editor to carry on.'}
        </p>
        {error.message && <pre className="render-failure-detail">{error.message}</pre>}
        <div className="render-failure-actions">
          <button className="btn btn-primary" onClick={reload}>
            Reload editor
          </button>
          {onCloseProject && (
            <button className="btn" onClick={onCloseProject}>
              Close project
            </button>
          )}
        </div>
      </div>
    );
  }
}
