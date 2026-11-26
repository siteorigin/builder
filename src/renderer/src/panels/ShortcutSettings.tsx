import { useEffect, useState, type KeyboardEvent } from 'react';
import { DEFAULT_SHORTCUTS, MAC_SYSTEM_HINT, shortcutHint } from '@shared/shortcuts';
import { recordedPress, shortcutLabel } from '../lib/shortcut-keys';
import { api, setState } from '../store';
import { InlineRow } from './LocalModelSettings';

const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Something went wrong.');

/**
 * Settings → General → Keyboard shortcuts (#750): Ask AI's key, recorded from the next key press, or put back to
 * Cmd/Ctrl+J. A press another shortcut has, or the platform keeps, is refused with what has it.
 */
export function AskAiShortcut({ binding, save }: { binding: string; save: (askAi: string) => Promise<void> }) {
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // While recording, the app's menus take no keys (Cmd/Ctrl+W would close the window rather than be refused here).
  // Handed back when the recording ends, however it ends: a press, Escape, Tab, a click elsewhere, Settings closing.
  useEffect(() => {
    if (!recording) return;
    void api.app.recordShortcut(true);
    return () => void api.app.recordShortcut(false);
  }, [recording]);
  const commit = async (next: string) => {
    setBusy(true);
    try {
      await save(next);
      setProblem(null);
    } catch (e) {
      setProblem(errorText(e));
      // Another setting saved meanwhile may have shown the binding that has now failed: show the one in use again.
      void api.app.getSettings().then((settings) => setState({ settings }), () => undefined);
    } finally {
      setBusy(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    // Escape held down after it ended a recording repeats here: it must not go on to close Settings.
    if (!recording && e.key === 'Escape' && e.repeat) return e.preventDefault();
    if (!recording || e.nativeEvent.isComposing || e.key === 'Dead' || e.key === 'Process') return;
    const press = recordedPress({ key: e.key, code: e.code, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey }, api.platform);
    // Tab moves on as ever, ending the recording on the way out.
    if (press.kind === 'cancel' && e.key === 'Tab') return setRecording(false);
    // Every other press is the recording's: none reaches the dialog (Escape would close it), the editor or a menu.
    e.preventDefault();
    e.stopPropagation();
    if (press.kind === 'wait' || e.repeat) return;
    if (press.kind === 'refuse') return setProblem(press.problem);
    setRecording(false);
    if (press.kind === 'cancel') return setProblem(null);
    if (press.binding === binding) return setProblem(null);
    void commit(press.binding);
  };
  const current = shortcutLabel(shortcutHint(binding), api.platform);
  const isDefault = binding === DEFAULT_SHORTCUTS.askAi;
  return (
    <InlineRow id="settings-ask-ai-key" label="Ask AI" hint={recording ? `Press the new shortcut, or Esc to cancel.${api.platform === 'darwin' ? ` ${MAC_SYSTEM_HINT}` : ''}` : 'Opens the AI chat about what’s selected, from anywhere in the editor.'} error={problem}>
      <div className="settings-shortcut">
        <button
          type="button"
          className={`btn btn-sm settings-shortcut-key${recording ? ' recording' : ''}`}
          aria-describedby="settings-ask-ai-key-note"
          aria-labelledby="settings-ask-ai-key-label settings-ask-ai-key-value"
          aria-pressed={recording}
          disabled={busy}
          onClick={() => {
            setProblem(null);
            setRecording((r) => !r);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setRecording(false)}
        >
          <span id="settings-ask-ai-key-value" className="kbd">
            {recording ? 'Recording…' : current}
          </span>
          <span>{recording ? 'Cancel' : 'Change'}</span>
        </button>
        {!isDefault && (
          <button type="button" className="btn btn-sm" disabled={busy || recording} onClick={() => void commit(DEFAULT_SHORTCUTS.askAi)}>
            Reset to {shortcutLabel(shortcutHint(DEFAULT_SHORTCUTS.askAi), api.platform)}
          </button>
        )}
      </div>
    </InlineRow>
  );
}
