import { Sparkles } from 'lucide-react';
import { useStore } from '../store';
import { openSeoChat } from '../lib/actions';
import type { SeoHandoff } from '../lib/seoHandoff';

/**
 * Fix with AI and Optimize with AI (#599): opens the AI panel with a request in its message box, ready to send or
 * change (lib/seoHandoff, actions' openSeoChat). `request` is worked out when it is pressed, so what it asks about is
 * what the project holds then. A project open read-only takes no AI edits, so it offers none; while the AI works on
 * another request it waits, as Write with AI does.
 */
export function AiHandoffButton({ label, request, disabled, describedBy, className = 'btn btn-sm' }: { label: string; request: () => SeoHandoff | null; disabled?: boolean; describedBy?: string; className?: string }) {
  const working = useStore((s) => !!s.runStatus);
  const readOnly = useStore((s) => !!s.snapshot?.readOnly);
  if (readOnly) return null;
  return (
    <button
      type="button"
      className={className}
      disabled={disabled || working}
      aria-describedby={describedBy}
      title={working ? 'Available once the AI finishes' : 'Open the AI panel with this request in the message box, ready to send'}
      onClick={() => {
        const h = request();
        if (h) void openSeoChat(h);
      }}
    >
      <Sparkles aria-hidden /> {label}
    </button>
  );
}
