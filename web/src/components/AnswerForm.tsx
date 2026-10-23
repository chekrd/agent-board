import { useActionState, useEffect, useRef, useState } from 'react';
import { sessionAction } from '../api.ts';
import type { Advice, Session } from '../types.ts';
import styles from './AnswerForm.module.css';

export function AnswerForm({ session, compact = false }: { session: Session; compact?: boolean }) {
  const q = session.question;
  const [error, submit, pending] = useActionState(async (_prev: string | null, form: FormData) => {
    try {
      const intent = form.get('intent');
      if (intent === 'dismiss') await sessionAction(session.id, 'dismiss');
      else if (intent === 'accept') await sessionAction(session.id, 'accept-advice');
      else if (intent === 'retry') await sessionAction(session.id, 'retry-advice');
      else if (intent === 'stop') await sessionAction(session.id, 'stop-advice');
      else await sessionAction(session.id, 'answer', { choice: form.get('choice') || undefined, text: form.get('text') || undefined });
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }, null);
  const reply = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  const edit = (a: Advice) => {
    if (!reply.current) return;
    reply.current.value = [a.choice && `${a.choice}.`, a.answer].filter(Boolean).join(' ');
    reply.current.focus();
  };

  return (
    <form className={styles.form} action={submit} data-compact={compact || undefined}>
      {q && session.advice && <SecondOpinion advice={session.advice} compact={compact} pending={pending} onEdit={edit} />}
      {q && q.options.length > 0 && (
        <div className={styles.options}>
          {q.options.map((o) => (
            <button
              key={o.label}
              type="submit"
              name="choice"
              value={o.label}
              disabled={pending}
              data-variant={o.recommended ? 'primary' : undefined}
              title={o.description}
            >
              {o.label}
              {!compact && o.description && <small>{o.description}</small>}
            </button>
          ))}
        </div>
      )}
      <div className={styles.reply}>
        {compact ? (
          <input ref={reply} name="text" placeholder="Reply…" autoComplete="off" disabled={pending} />
        ) : (
          <textarea ref={reply} name="text" placeholder="Reply…" rows={3} disabled={pending} />
        )}
        <button type="submit" disabled={pending}>Send</button>
        {q && (
          <button type="submit" name="intent" value="dismiss" data-variant="ghost" disabled={pending} title="Clear without answering">
            Dismiss
          </button>
        )}
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </form>
  );
}

const level = (confidence: number) => (confidence >= 75 ? 'high' : confidence >= 50 ? 'medium' : 'low');

function SecondOpinion({ advice: a, compact, pending, onEdit }: { advice: Advice; compact: boolean; pending: boolean; onEdit: (a: Advice) => void }) {
  if (a.state === 'thinking') {
    return (
      <div className={styles.advice} data-state="running">
        <div className={styles.adviceHead}>
          <span className={styles.spinner} aria-hidden />
          <span>Second opinion in progress · <Elapsed since={a.startedAt} /></span>
          <button type="submit" name="intent" value="stop" data-variant="ghost" disabled={pending} title="Stop the advisor">Stop</button>
        </div>
        <p className={styles.activity}>{a.activity ?? 'Working'}</p>
      </div>
    );
  }
  if (a.state === 'failed') {
    return (
      <div className={styles.advice} data-state="failed" title={a.error}>
        <span>{a.error === 'stopped' ? 'Second opinion stopped' : `Second opinion failed: ${a.error}`}</span>
        <button type="submit" name="intent" value="retry" data-variant="ghost" disabled={pending}>Retry</button>
      </div>
    );
  }
  return (
    <div className={styles.advice}>
      <div className={styles.adviceHead}>
        <span>Second opinion</span>
        <span className={styles.confidence} data-level={level(a.confidence)} title="How sure the advisor is that you would decide the same">
          {a.confidence}%
        </span>
      </div>
      {a.choice && <strong className={styles.adviceChoice}>{a.choice}</strong>}
      {a.answer && <p className={styles.adviceAnswer} data-compact={compact || undefined}>{a.answer}</p>}
      {a.reasoning && <p className={styles.adviceReason} data-compact={compact || undefined} title={compact ? a.reasoning : undefined}>{a.reasoning}</p>}
      <div className={styles.adviceActions}>
        <button type="submit" name="intent" value="accept" data-variant="primary" disabled={pending}>Accept &amp; send</button>
        <button type="button" data-variant="ghost" disabled={pending} onClick={() => onEdit(a)}>Edit</button>
      </div>
    </div>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return <>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</>;
}
