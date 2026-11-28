import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { DEFAULT_SHORTCUTS, MAC_SYSTEM_HINT, shortcutConflict, shortcutHint } from '@shared/shortcuts';
import { recordedPress, shortcutLabel } from '../lib/shortcut-keys';
import { api, setState } from '../store';
import { InlineRow } from './LocalModelSettings';

/** Bindings to suggest after a refusal, in order: the first that is free here and not the one in use is named. */
const SUGGESTIONS = [DEFAULT_SHORTCUTS.askAi, 'Mod+Shift+L', 'Mod+L', 'Mod+Shift+J'];

const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Something went wrong.');

/**
 * Settings → General → Keyboard shortcuts (#750): Edit with AI's key, recorded from the next key press, or put back to
 * Cmd/Ctrl+J. A press another shortcut has, or the platform keeps, is refused with what has it.
 *
 * The key is a value beside its action, never inside it: the well shows the binding, and while recording it shows
 * the prompt in a dashed well (the focus outline stays the only ring). Change turns into Cancel, which plain Enter
 * or Space presses as any button would. The note keeps the way out in view through a refusal, and what happens is
 * announced, since a changed description is not read again.
 */
export function AskAiShortcut({ binding, save }: { binding: string; save: (askAi: string) => Promise<void> }) {
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const changeRef = useRef<HTMLButtonElement>(null);
  // A new node for every message, so the same refusal twice is announced twice.
  const [announced, setAnnounced] = useState({ text: '', n: 0 });
  const setAnnouncement = (text: string) => setAnnounced((a) => ({ text, n: a.n + 1 }));
  const mac = api.platform === 'darwin';
  // While recording, the app's menus take no keys (Cmd/Ctrl+W would close the window rather than be refused here).
  // Handed back when the recording ends, however it ends: a press, Escape, Tab, a click elsewhere, Settings closing.
  useEffect(() => {
    if (!recording) return;
    void api.app.recordShortcut(true);
    return () => void api.app.recordShortcut(false);
  }, [recording]);
  const label = (b: string) => shortcutLabel(shortcutHint(b), api.platform);
  // Every way out of a recording drops the refusal it may be showing: it was about a press that was never kept.
  const stop = (announce = false) => {
    setRecording(false);
    setProblem(null);
    if (announce) setAnnouncement(`Kept ${label(binding)}.`);
  };
  const suggestion = SUGGESTIONS.find((b) => b !== binding && !shortcutConflict(b, api.platform));
  const commit = async (next: string) => {
    setBusy(true);
    try {
      await save(next);
      setProblem(null);
      setAnnouncement(`Edit with AI is now ${label(next)}.`);
    } catch (e) {
      setProblem(errorText(e));
      setAnnouncement(errorText(e));
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
    // Plain Enter or Space presses the focused Cancel, as on any button.
    if ((e.key === 'Enter' || e.key === ' ') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return;
    const press = recordedPress({ key: e.key, code: e.code, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey }, api.platform);
    // Tab moves on as ever, ending the recording on the way out.
    if (press.kind === 'cancel' && e.key === 'Tab') return stop(true);
    // Every other press is the recording's: none reaches the dialog (Escape would close it), the editor or a menu.
    e.preventDefault();
    e.stopPropagation();
    if (press.kind === 'wait' || e.repeat) return;
    if (press.kind === 'refuse') {
      setProblem(press.problem);
      setAnnouncement(`${press.problem}${suggestion ? ` Try ${label(suggestion)}.` : ''}`);
      return;
    }
    stop();
    if (press.kind === 'cancel') return setAnnouncement(`Kept ${label(binding)}.`);
    if (press.binding === binding) return setAnnouncement(`Kept ${label(binding)}.`);
    void commit(press.binding);
  };
  const current = label(binding);
  const isDefault = binding === DEFAULT_SHORTCUTS.askAi;
  // The rule first, so a first press can be a good one; then the way out, then what macOS keeps before the app sees it.
  const instruction = `Press ${mac ? '⌘' : 'Ctrl'} and a letter or number, with or without ${mac ? '⇧' : 'Shift'}. Esc cancels.${mac ? ` ${MAC_SYSTEM_HINT}` : ''}`;
  return (
    <>
      <InlineRow
        id="settings-ask-ai-key"
        label="Edit with AI"
        hint={recording ? instruction : 'Opens the AI chat from anywhere in the editor. With an element selected, it’s set to edit that element.'}
        // A refusal while recording keeps the way on and the way out in the same line.
        error={problem && (recording ? `${problem} ${suggestion ? `Try ${label(suggestion)}, or` : 'Press another, or'} Esc to cancel.` : problem)}
      >
        <div className="settings-shortcut">
          <kbd id="settings-ask-ai-key-value" className={`settings-shortcut-value${recording ? ' recording' : ''}`}>
            {recording ? 'Press keys…' : current}
          </kbd>
          <button
            ref={changeRef}
            type="button"
            className="btn btn-sm"
            aria-label={recording ? 'Cancel recording the Edit with AI shortcut' : 'Change the Edit with AI shortcut'}
            aria-describedby="settings-ask-ai-key-value settings-ask-ai-key-note"
            // Kept focusable while a press is saved, so the keyboard stays where it was.
            aria-disabled={busy || undefined}
            onClick={() => {
              if (busy) return;
              if (recording) {
                stop();
                setAnnouncement(`Kept ${current}.`);
              } else {
                setProblem(null);
                setRecording(true);
                setAnnouncement(`Recording. ${instruction}`);
              }
            }}
            onKeyDown={onKeyDown}
            onBlur={() => recording && stop(true)}
          >
            {recording ? 'Cancel' : 'Change'}
          </button>
          {!isDefault && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={recording}
              aria-disabled={busy || undefined}
              onClick={async (e) => {
                if (busy) return;
                const hadFocus = document.activeElement === e.currentTarget;
                await commit(DEFAULT_SHORTCUTS.askAi);
                // Reset goes once the default is back: its focus moves to Change rather than falling to the page.
                if (hadFocus) requestAnimationFrame(() => (document.activeElement === document.body || !document.activeElement) && changeRef.current?.focus());
              }}
            >
              Reset to {label(DEFAULT_SHORTCUTS.askAi)}
            </button>
          )}
        </div>
      </InlineRow>
      <span className="sr-only" role="status">
        <span key={announced.n}>{announced.text}</span>
      </span>
    </>
  );
}
