import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * A quiet Copy button for a block of text shown beside it (a file's preview, a page's JSON-LD): it says so in place and
 * to screen readers, and goes back to "Copy" after a moment. `what` names the text, as in "Copy llms.txt".
 */
export function CopyText({ text, what, className = '' }: { text: string; what: string; className?: string }) {
  const [copied, setCopied] = useState<boolean | 'failed'>(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  // A new text is not the copied one.
  useEffect(() => setCopied(false), [text]);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2400);
      },
      () => {
        setCopied('failed');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 4000);
      }
    );
  };
  return (
    <>
      <button type="button" className={`btn btn-sm btn-ghost copy-text${className ? ` ${className}` : ''}`} onClick={copy} aria-label={`Copy ${what}`}>
        {copied === true ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied === true ? 'Copied' : copied ? 'Couldn’t copy' : 'Copy'}
      </button>
      <span className="sr-only" role="status">
        {copied === true ? `${what} copied.` : copied ? `${what} couldn’t be copied.` : ''}
      </span>
    </>
  );
}
