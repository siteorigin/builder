import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Lock, Sparkles } from 'lucide-react';
import { projectBlock, type Blocked } from '../lib/blocked';
import { useStore } from '../store';
import './BlockedNote.css';

export { aiAwaiting, aiChanging, aiRunning, aiWorking, projectBlock, readOnlyBlock, type Blocked } from '../lib/blocked';

/**
 * Why a dialog or panel can't change the project now (lib/blocked words it): the grey info face, Lock for read-only and
 * Sparkles for the AI, never the red of a failure. A note that comes and goes while the surface is open is spoken by a
 * BlockedStatus mounted beside it (or the surface's own announcer), so it is drawn with `live` off; `live` is for a
 * note that is there from the start.
 */
export function BlockedNote({ block, id, live = true, className, children }: { block: Blocked; id?: string; live?: boolean; className?: string; children?: ReactNode }) {
  return (
    <div id={id} className={`scope-note info blocked-note${className ? ` ${className}` : ''}`} role={live ? 'status' : undefined}>
      {block.kind === 'read-only' ? <Lock aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
      <span>
        {block.text}
        {children}
      </span>
    </div>
  );
}

/**
 * Says a hold aloud as it comes and goes: mounted before it, so a screen reader hears it arrive with focus left where it
 * is, and `lifted` (what can be done again) once it clears. Silent while nothing has been held.
 */
export function BlockedStatus({ block, lifted }: { block: Blocked | null; lifted: string }) {
  const text = block?.text ?? null;
  const [said, setSaid] = useState('');
  const was = useRef<string | null>(text);
  useEffect(() => {
    if (was.current === text) return;
    const held = was.current !== null;
    was.current = text;
    setSaid(text ?? (held ? lifted : ''));
  }, [text, lifted]);
  return (
    <span className="sr-only" role="status">
      {said}
    </span>
  );
}

/** `projectBlock` for the project open now, with the chat's run status, so a component re-renders as either changes. */
export function useProjectBlock(action: string): Blocked | null {
  const readOnly = useStore((s) => s.snapshot?.readOnly?.reason ?? null);
  const aiBusy = useStore((s) => !!s.snapshot?.aiBusy);
  const runStatus = useStore((s) => s.runStatus);
  return projectBlock({ readOnly: readOnly === null ? null : { reason: readOnly }, aiBusy }, action, runStatus);
}
