import { useEffect, useRef, useState } from 'react';
import { wsUrl } from '../api.ts';
import { createTerminal } from '../terminal.ts';
import styles from './TerminalView.module.css';

const encoder = new TextEncoder();

export function TerminalView({ sessionId, disconnected = false }: { sessionId: string; disconnected?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (state !== 'closed' || disconnected) return;
    const retry = setTimeout(() => setAttempt((n) => n + 1), 1500);
    return () => clearTimeout(retry);
  }, [state, disconnected]);

  useEffect(() => {
    const controller = new AbortController();
    const cleanups: (() => void)[] = [];
    setState('connecting');

    (async () => {
      const term = await createTerminal(ref.current!);
      cleanups.push(() => term.dispose());
      if (controller.signal.aborted) return term.dispose();

      const ws = new WebSocketStream(wsUrl(`/ws/term/${sessionId}?cols=${term.cols}&rows=${term.rows}`), { signal: controller.signal });
      const { readable, writable } = await ws.opened;
      const writer = writable.getWriter();
      const send = (msg: object) => void writer.write(JSON.stringify(msg)).catch(() => {});
      cleanups.push(() => ws.close());

      const subscriptions = [term.onData((d) => send({ t: 'i', d })), term.onResize(({ cols, rows }) => send({ t: 'r', c: cols, r: rows }))];
      cleanups.push(() => subscriptions.forEach((s) => s.dispose()));
      const observer = new ResizeObserver(() => term.fit());
      observer.observe(ref.current!);
      cleanups.push(() => observer.disconnect());

      setState('open');
      term.focus();
      for await (const chunk of readable) {
        term.write(typeof chunk === 'string' ? encoder.encode(chunk) : new Uint8Array(chunk as ArrayBuffer));
      }
      setState('closed');
    })().catch(() => !controller.signal.aborted && setState('closed'));

    return () => {
      controller.abort();
      cleanups.reverse().forEach((fn) => fn());
      if (ref.current) ref.current.replaceChildren();
    };
  }, [sessionId, attempt]);

  return (
    <div className={styles.wrap}>
      <div ref={ref} className={styles.terminal} />
      {state === 'closed' && (
        <div className={styles.overlay}>
          <span>{disconnected ? 'Session has exited.' : 'Terminal disconnected.'}</span>
          <button onClick={() => setAttempt((n) => n + 1)}>Reconnect</button>
        </div>
      )}
    </div>
  );
}
