import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { useStore } from '../store';

export function Modal({ title, icon, onClose, children, footer, wide }: { title: ReactNode; icon?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="modal-head">
          {icon}
          <h2 className="grow">{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export interface MenuItem {
  label?: string;
  icon?: ReactNode;
  shortcut?: string;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  heading?: string;
}

export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
  }, [x, y]);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => window.addEventListener('mousedown', close), 0);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  return (
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : it.heading ? (
          <div key={i} className="menu-label">
            {it.heading}
          </div>
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item${it.danger ? ' danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect?.();
            }}
          >
            {it.icon}
            <span className="grow">{it.label}</span>
            {it.shortcut && <span className="kbd">{it.shortcut}</span>}
          </button>
        )
      )}
    </div>
  );
}

/** Hook that shows a menu at a position. */
export function useMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const node = menu ? <Menu {...menu} onClose={() => setMenu(null)} /> : null;
  return {
    node,
    open: (x: number, y: number, items: MenuItem[]) => setMenu({ x, y, items }),
    openAt: (el: HTMLElement, items: MenuItem[]) => {
      const r = el.getBoundingClientRect();
      setMenu({ x: r.left, y: r.bottom + 4, items });
    }
  };
}

export function Section({ title, children, defaultOpen = true, actions, id }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; actions?: ReactNode; id?: string }) {
  const key = id ? `section:${id}` : null;
  const [open, setOpen] = useState(() => (key && localStorage.getItem(key) !== null ? localStorage.getItem(key) === '1' : defaultOpen));
  return (
    <div className="section">
      <div className="row" style={{ paddingRight: 8 }}>
        <button
          className="section-head grow"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            if (key) localStorage.setItem(key, open ? '0' : '1');
          }}
        >
          <ChevronDown className="chev" />
          {title}
        </button>
        {actions}
      </div>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

export function Field({ label, children, hint, error, extra }: { label?: ReactNode; children: ReactNode; hint?: ReactNode; error?: string | null; extra?: ReactNode }) {
  return (
    <div className="field">
      {label && (
        <label>
          <span className="grow">{label}</span>
          {extra}
        </label>
      )}
      {children}
      {error ? <div className="field-error">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, full, label }: { value: T; options: Array<{ value: T; label?: ReactNode; icon?: ReactNode; title?: string }>; onChange: (v: T) => void; full?: boolean; label?: string }) {
  return (
    <div className={`segmented${full ? ' full' : ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} aria-pressed={value === o.value} onClick={() => onChange(o.value)} title={o.title} aria-label={o.title}>
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button className="switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />;
}

/** Text input that commits on blur/Enter and keeps a local draft while focused. */
export function DraftInput({
  value,
  onCommit,
  onLive,
  multiline,
  className = 'input',
  placeholder,
  rows,
  ariaLabel,
  autoFocus
}: {
  value: string;
  onCommit: (v: string) => void;
  onLive?: (v: string) => void;
  multiline?: boolean;
  className?: string;
  placeholder?: string;
  rows?: number;
  ariaLabel?: string;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  const common = {
    value: draft,
    placeholder,
    'aria-label': ariaLabel,
    autoFocus,
    onFocus: () => (focused.current = true),
    onBlur: () => {
      focused.current = false;
      commit();
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraft(e.target.value);
      onLive?.(e.target.value);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDraft(value);
        (e.target as HTMLElement).blur();
      }
      if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commit();
        (e.target as HTMLElement).blur();
      }
    }
  };
  return multiline ? <textarea className={className === 'input' ? 'textarea' : className} rows={rows ?? 3} {...common} /> : <input className={className} {...common} />;
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="grow">{t.text}</span>
          {t.action && (
            <button className="btn btn-sm btn-ghost" onClick={t.action.run}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function Spinner({ large }: { large?: boolean }) {
  return <span className={`spinner${large ? ' lg' : ''}`} role="progressbar" aria-label="Loading" />;
}
