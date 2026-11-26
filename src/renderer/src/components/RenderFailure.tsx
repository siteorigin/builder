import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Offered while a project is open: a project whose own content makes the editor fail again can still be left. */
  onCloseProject?: () => void;
  /** Loads the editor again. The page reloads by default; the main process still has the project open, so it returns. */
  reload?: () => void;
}

interface State {
  error: Error | null;
}

/**
 * What the person sees when the editor fails while showing a screen (#886): what happened, and a way back. Without it
 * React unmounts everything and leaves a blank window. The project is saved as it is edited, so reloading the editor
 * brings it back as it was left.
 */
export class RenderFailure extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('The editor failed while showing its screen.', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { onCloseProject, reload = () => window.location.reload() } = this.props;
    return (
      <div className="fatal render-failure" role="alert">
        <h1>The editor stopped working</h1>
        <p>Something went wrong while showing the editor. Your project is saved as you edit, so reloading the editor brings it back as you left it.</p>
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
