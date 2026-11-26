/**
 * The editor's code (editor-entry.ts), loaded the first time it is wanted: when an open is asked for on Welcome, or
 * when a project's snapshot arrives. Welcome shows without it, so a launch evaluates only what Welcome needs.
 */
type EditorModule = typeof import('../editor-entry');

let loaded: EditorModule | null = null;
let loading: Promise<EditorModule> | null = null;

/** The editor's code, loading it if it has not been. A load that failed is tried again the next time it is asked for. */
export function loadEditor(): Promise<EditorModule> {
  if (!loading) {
    const attempt = import('../editor-entry').then((m) => (loaded = m));
    attempt.catch(() => {
      if (loading === attempt) loading = null;
    });
    loading = attempt;
  }
  return loading;
}

/** The editor's code once it has loaded, else null. */
export const editorModule = (): EditorModule | null => loaded;
