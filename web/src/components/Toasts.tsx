import { useEffect, useRef, useState } from 'react';
import styles from './Toasts.module.css';

interface Toast {
  id: number;
  message: string;
}

let nextId = 0;

// Actions report failures with reportError(); this surfaces them instead of leaving them in the console.
export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const push = (error: unknown) => {
      const toast = { id: nextId++, message: error instanceof Error ? error.message : String(error) };
      setToasts((all) => [...all, toast]);
      setTimeout(() => setToasts((all) => all.filter((t) => t !== toast)), 8000);
    };
    const onError = (e: ErrorEvent) => push(e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) => push(e.reason);
    addEventListener('error', onError);
    addEventListener('unhandledrejection', onRejection);
    return () => {
      removeEventListener('error', onError);
      removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (toasts.length && !el.matches(':popover-open')) el.showPopover();
    if (!toasts.length && el.matches(':popover-open')) el.hidePopover();
  }, [toasts]);

  return (
    <div ref={ref} popover="manual" className={styles.toasts}>
      {toasts.map((t) => (
        <p key={t.id} className={styles.toast} role="alert">
          {t.message}
          <button data-variant="ghost" aria-label="Dismiss" onClick={() => setToasts((all) => all.filter((x) => x !== t))}>×</button>
        </p>
      ))}
    </div>
  );
}
