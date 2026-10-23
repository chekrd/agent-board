import { useActionState } from 'react';
import { sessionAction } from '../api.ts';
import type { Session } from '../types.ts';
import styles from './AnswerForm.module.css';

export function AnswerForm({ session, compact = false }: { session: Session; compact?: boolean }) {
  const q = session.question;
  const [error, submit, pending] = useActionState(async (_prev: string | null, form: FormData) => {
    try {
      if (form.get('intent') === 'dismiss') await sessionAction(session.id, 'dismiss');
      else await sessionAction(session.id, 'answer', { choice: form.get('choice') || undefined, text: form.get('text') || undefined });
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }, null);

  return (
    <form className={styles.form} action={submit} data-compact={compact || undefined}>
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
          <input name="text" placeholder="Reply…" autoComplete="off" disabled={pending} />
        ) : (
          <textarea name="text" placeholder="Reply…" rows={3} disabled={pending} />
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
