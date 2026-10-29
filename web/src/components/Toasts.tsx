import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useNow } from '../now.ts';
import { redact, track } from '../ux.ts';
import { Icon } from './Icon.tsx';
import styles from './Toasts.module.css';

export type ToastKind = 'info' | 'error' | 'undo';

export interface ToastAction {
  label: string;
  // The key that does the same.
  kbd?: string;
  run: () => void;
}

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  session?: string;
  action?: ToastAction;
  // When what it announces happens, counted down in seconds from `at`, when the toast came.
  until?: number;
  at: number;
}

const LASTS_MS: Record<ToastKind, number> = { info: 4200, error: 8000, undo: 8000 };
const SHOWN = 3;

let toasts: readonly Toast[] = [];
let nextId = 0;
const subscribers = new Set<() => void>();

function change(next: readonly Toast[]) {
  toasts = next;
  for (const fn of subscribers) fn();
}

export function dismissToast(id: number) {
  if (toasts.some((t) => t.id === id)) change(toasts.filter((t) => t.id !== id));
}

export function toast(kind: ToastKind, message: string, o: { session?: string; action?: ToastAction; lasts?: number; until?: number } = {}) {
  const t: Toast = { id: ++nextId, kind, message, session: o.session, action: o.action, until: o.until, at: Date.now() };
  change([...toasts, t].slice(-SHOWN));
  if (kind === 'error') track('error', { error: redact(message).slice(0, 160), task: o.session });
  setTimeout(() => dismissToast(t.id), o.lasts ?? LASTS_MS[kind]);
  return t.id;
}

// The shared clock ticks once a second from its own start, so until its next tick it may lag the toast's arrival.
function Countdown({ until, from }: { until: number; from: number }) {
  const left = Math.max(0, Math.ceil((until - Math.max(useNow(), from)) / 1000));
  return <span className={styles.count}>· {left} s</span>;
}

const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => void subscribers.delete(fn);
};

// Outside the topmost modal dialog the toasts would be drawn above it but stay inert, so their buttons would not
// take a click; inside it they work.
function useTopDialog() {
  const [top, setTop] = useState<Element>(document.body);
  useEffect(() => {
    let opened: Element[] = [];
    const update = () => {
      const modal = [...document.querySelectorAll('dialog:modal')];
      opened = [...opened.filter((d) => modal.includes(d)), ...modal.filter((d) => !opened.includes(d))];
      setTop(opened.at(-1) ?? document.body);
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    update();
    return () => observer.disconnect();
  }, []);
  return top;
}

// Failures that actions report with reportError() show here too.
export function Toasts() {
  const list = useSyncExternalStore(subscribe, () => toasts);
  const host = useTopDialog();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const failed = (error: unknown) => toast('error', error instanceof Error ? error.message : String(error));
    const onError = (e: ErrorEvent) => failed(e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) => failed(e.reason);
    addEventListener('error', onError);
    addEventListener('unhandledrejection', onRejection);
    return () => {
      removeEventListener('error', onError);
      removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  // Shown again on every change, so the toasts stay above a dialog that opened since.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.matches(':popover-open')) el.hidePopover();
    if (list.length) el.showPopover();
  }, [list, host]);

  return createPortal(
    <div ref={ref} popover="manual" className={styles.toasts} aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={styles.toast} data-toast data-kind={t.kind} data-session={t.session} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span className={styles.mark} aria-hidden />
          <span className={styles.message}>
            {t.message}
            {t.until !== undefined && <> <Countdown until={t.until} from={t.at} /></>}
          </span>
          {t.action && (
            <button
              type="button"
              className={styles.action}
              onClick={() => {
                dismissToast(t.id);
                t.action!.run();
              }}
            >
              {t.action.label}
              {t.action.kbd && <kbd>{t.action.kbd}</kbd>}
            </button>
          )}
          <button type="button" className={styles.close} aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
    </div>,
    host,
  );
}
